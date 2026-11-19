/**
 * Loomy 供应商模块：**只声明能力 + 只实现协议**。
 *
 * 这个文件把 `src/` 根目录下原本散落的实现收进契约里。每一块通用能力都回流到
 * `src/core`，这里只留"只有 Loomy 才知道"的事实：
 *
 * | 关注点 | 在哪儿实现 |
 * |---|---|
 * | 账号存储、slot 路由推导、桌面身份 | `core/accounts.ts`（`routeMode:'slots'`） |
 * | 池挑选、冷却、失败分类 | `core/pool.ts` |
 * | 目录缓存、选择、能力覆盖 | `core/catalog.ts` |
 * | 积分缓存、逐账号合并 | `core/credits.ts` |
 * | 路由规划、CSRF、视图装配 | `core/routes.ts` + `core/surface.ts` |
 * | pi-ai 适配器、池记账、并发归属 | `core/provider.ts` |
 * | 候选文件遍历、插件优先、回退扫描 | `./auth.ts`（凭据来源比其他供应商多） |
 * | `/models`、`/points/*`、`/user/identity` 协议 | `./catalog.ts`、`./credits.ts`、`./auth.ts` |
 * | 线协议字段、请求头、档位映射 | `./provider.ts` |
 *
 * {@link createLoomyModule} 里唯一不能外包的语义是 `resolveCredential`：哪一个
 * 账号为这次调用付费，必须是全插件**唯一**一处决定。
 *
 * @module dsh-connect-desktop/vendors/loomy
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  AccountDriver,
  AccountInput,
  CatalogDriver,
  ChatDriver,
  CredentialDriver,
  CredentialState,
  LoginDriver,
  StoredAccount,
  VendorCapabilities,
  VendorDeps,
  VendorDescriptor,
  VendorModule,
  VendorRuntime,
} from '../../vendor-sdk/contracts.js'
import type { AuthLoginView, AuthLogoutView, AuthSendCodeView, AuthStateView, CreditsView, DiagnosticsProbe } from '../../shared/views.js'
import {
  createAccountsStore,
  DESKTOP_ACCOUNT_ID,
  emptyAccountsDocument,
  parseAccountsDocument,
  serializeAccountsDocument,
  type AccountsStore,
} from '../../core/accounts.js'
import { createCatalogStore } from '../../core/catalog.js'
import { createCreditsStore } from '../../core/credits.js'
import { createAccountPool, NO_POINTS_CODE, type AccountPool } from '../../core/pool.js'
import { createVendorPreferences } from '../../core/preferences.js'
import { vendorStateStore } from '../../core/state.js'
import { slotForRoute } from './accounts.js'

import { createAuthStore, createSessionPrecheck, type AuthSnapshot } from './auth.js'
import { fetchCatalogModels } from './catalog.js'
import {
  ACCENT,
  CREDIT_FIELDS,
  DISPLAY_NAME,
  LOOMY_CONFIG_DEFAULTS,
  LOOMY_CONFIG_GROUPS,
  LOOMY_CONFIG_SCHEMA,
  PROVIDER_ID,
} from './constants.js'
import { displayPhone, safeErrorMessage } from '../../shared/text.js'
import { fetchCredits, fetchIdentity } from './credits.js'
import { createLoginService } from './login.js'
import { authSessionCandidatesWithPlugin } from './plugin-auth.js'
import { createAuthDiscovery } from '../../shared/discover.js'
import { LOOMY_COMPAT, displayNameFor, prepareLoomyHeaders, toPiModel } from './provider.js'

/** Loomy 的能力声明：路由与设置卡片都从这里推导，不写死。 */
const capabilities: VendorCapabilities = {
  accounts: 'multi',
  pool: true,
  // 密码登录已在 6c84a41 revert，别再声明回来：声明了就必须有实现。
  login: ['sms-code'],
  // 3 个余额桶 + `/points/records` 流水，两者都要。
  credits: { kind: 'balance', fields: CREDIT_FIELDS, ledger: true },
  catalog: { selection: true, visionOverride: true, reasoningEffort: true },
  transfer: true,
  adopt: true,
  diagnostics: true,
}

/** 供应商身份。`id` 进入模型 identity，永不改。 */
export const LOOMY_DESCRIPTOR: VendorDescriptor = {
  id: PROVIDER_ID,
  displayName: DISPLAY_NAME,
  accent: ACCENT,
  // 主供应商：即使签出也在选择器里（首次调用会把原因说清楚）。
  providerVisibility: 'always',
  capabilities,
  config: {
    schema: LOOMY_CONFIG_SCHEMA,
    defaults: { ...LOOMY_CONFIG_DEFAULTS },
    groups: LOOMY_CONFIG_GROUPS,
  },
}

/** 嵌入方/测试的注入点。 */
export interface LoomyModuleOptions {
  /** 池挑选的随机源（测试用）。 */
  random?: () => number
  /** `/models` 的单次超时。 */
  catalogTimeoutMs?: number
}

export function createLoomyModule(options: LoomyModuleOptions = {}): VendorModule {
  return {
    descriptor: LOOMY_DESCRIPTOR,
    create(deps: VendorDeps): VendorRuntime {
      const setting = <T>(key: string): T => deps.setting<T>(key)
      const baseURL = (): string => setting<string>('baseURL')
      const loomyVersion = (): string => setting<string>('loomyVersion')

      const state = vendorStateStore(deps.document)
      const preferences = createVendorPreferences(state)

      // ── 凭据 ────────────────────────────────────────────────────────────
      //
      // Loomy 的候选遍历比其它供应商复杂（环境变量独占、插件优先、Windows 回退
      // 扫描），所以这里直接复用 `auth.ts` 的读取器，而不是再包一层
      // `core/credential.ts`：契约只要求 `read/invalidate/probePaths`，实现可以
      // 有更多证据来源。映射是纯函数，见下。
      const candidates = authSessionCandidatesWithPlugin(deps.storageDir)
      const pinned = candidates.length === 1 && candidates[0]?.origin === 'env'
      const auth = createAuthStore({
        candidates,
        ttlMs: () => setting<number>('sessionTtlMs'),
        // 只有非独占（未设 LOOMY_AUTH_SESSION_FILE）时才回退扫描，否则一次
        // 固定路径的运行可能读到真实桌面凭据 —— 那是安全契约，不是优化。
        ...(pinned ? {} : { discover: createAuthDiscovery() }),
      })

      const toCredentialState = (snapshot: AuthSnapshot): CredentialState => {
        const candidatesView = snapshot.candidates
        if (!snapshot.found || snapshot.session === undefined) {
          return {
            found: false,
            problem: snapshot.problem ?? `未找到 Loomy 登录态（${snapshot.sourcePath}）`,
            candidates: candidatesView,
          }
        }
        return {
          found: true,
          material: snapshot.session,
          sourcePath: snapshot.sourcePath,
          sourceOrigin: snapshot.sourceOrigin === 'plugin' || snapshot.sourceOrigin === 'env' ? snapshot.sourceOrigin : 'desktop',
          candidates: candidatesView,
          ...(snapshot.sourceAccountId === undefined ? {} : { accountId: snapshot.sourceAccountId }),
          identity: {
            ...(snapshot.phone === undefined ? {} : { phone: snapshot.phone }),
            ...(snapshot.userId === undefined ? {} : { userId: snapshot.userId }),
            ...(snapshot.loginAt === undefined ? {} : { loginAt: snapshot.loginAt }),
          },
        }
      }

      const credentials: CredentialDriver = {
        async read(readOptions = {}) {
          return toCredentialState(await auth.read(readOptions))
        },
        invalidate() {
          auth.invalidate()
        },
        probePaths() {
          return candidates.map((candidate) => candidate.path)
        },
      }

      // ── 账号 ────────────────────────────────────────────────────────────
      const store: AccountsStore = createAccountsStore({
        document: deps.document('accounts.json', {
          parse: parseAccountsDocument,
          serialize: serializeAccountsDocument,
          empty: emptyAccountsDocument,
        }),
        routeBase: PROVIDER_ID,
        /**
         * `single`：与 `raccoon` 同一条策略——多账号**不**改变路由集合。
         *
         * 旧形态是 `slots`（每个账号一条 `loomy-N` 路由），账号一多，模型选择器
         * 里就会出现十几个同名分组、同一个模型重复十几次；而"谁付费"本来就不该
         * 是会话绑定的属性。现在选择器只有一组 `loomy`，每次调用由轮换开关 /
         * 当前账号决定用哪个号（见 `resolveCredential`）。
         */
        routeMode: 'single',
        displayName: DISPLAY_NAME,
        // 桌面端的登录态是"第 0 个候选账号"：它可以在池里参与轮换，但不写进
        // accounts.json —— 插件只读它，永不写回客户端文件。
        desktop: async () => {
          const snapshot = await auth.read()
          if (!snapshot.found || snapshot.session === undefined) return undefined
          return {
            material: snapshot.session,
            ...(snapshot.phone === undefined ? {} : { phone: snapshot.phone }),
            ...(snapshot.userId === undefined ? {} : { userId: snapshot.userId }),
            ...(snapshot.loginAt === undefined ? {} : { loginAt: snapshot.loginAt }),
          }
        },
      })

      const pool: AccountPool = createAccountPool({
        accounts: store as AccountDriver,
        ...(options.random === undefined ? {} : { random: options.random }),
      })

      const accounts: AccountDriver = {
        list: (listOptions = {}) => store.list(listOptions),
        active: () => preferences.activeAccountId(),
        setActive: (id) => preferences.setActiveAccountId(id),
        add: (input) => store.add(input),
        remove: async (id) => {
          await store.remove(id)
          if ((await preferences.activeAccountId()) === id) {
            const rest = await store.list({ force: true })
            await preferences.setActiveAccountId(rest[0]?.id)
          }
        },
        rename: async (id, label) => {
          await store.rename?.(id, label)
        },
        markUnavailable: (id, code, message) => store.markUnavailable(id, code, message),
        // "最近调用"只在**成功**时更新：core 的 `markHealthy` 是"这次真的收到内容"
        // 的唯一信号。用"被选中"来标记会让失败的账号也顶着一个标签。
        markHealthy: async (id) => {
          await store.markHealthy(id)
          lastPick = { accountId: id, at: Date.now() }
        },
        routeOf: (account) => routeOfAccount(account),
        displayNameOf: (account) => (store.displayNameOf(account) ?? DISPLAY_NAME),
        exportBundle: async () => (await store.exportBundle?.()) ?? { bundle: { accounts: [] } },
        importBundle: async (document) => (await store.importBundle?.(document)) ?? { added: 0, refreshed: 0, skipped: 0 },
        /**
         * 把桌面端登录"收养"成一行账号。
         *
         * 仅当桌面端确实登录了才可用；收养后它就有了自己的 slot 与路由，
         * 会话从此绑定账号而不是"当前桌面状态"。
         */
        adopt: async () => {
          const added = await store.add({ kind: 'desktop' } satisfies AccountInput)
          return { id: added.id, replaced: added.replaced }
        },
      }

      /** 一个账号对应的 provider 路由。slot 由 core 的 store 维护。 */
      function routeOfAccount(account: StoredAccount): string {
        if (account.origin === 'desktop' && account.id === DESKTOP_ACCOUNT_ID) return PROVIDER_ID
        return store.routeOf(account)
      }

      // ── 目录 ────────────────────────────────────────────────────────────
      const catalog: CatalogDriver = createCatalogStore({
        fetchModels: async () => {
          const snapshot = await auth.read()
          if (!snapshot.found || snapshot.session === undefined) {
            throw new UpstreamMissingCredential(snapshot.problem ?? '没有可用的 Loomy 登录态')
          }
          return fetchCatalogModels({
            baseURL: baseURL(),
            session: snapshot.session,
            ...(options.catalogTimeoutMs === undefined ? {} : { timeoutMs: options.catalogTimeoutMs }),
          })
        },
        ttlMs: () => setting<number>('catalogTtlMs'),
        state,
        overrides: () => ({
          visionModelIds: setting<string[]>('visionModelIds') ?? [],
          textOnlyModelIds: setting<string[]>('textOnlyModelIds') ?? [],
        }),
        endpoints: () => [
          { label: 'models', url: `${baseURL()}/models` },
          { label: 'points', url: `${baseURL()}/points/records` },
          { label: 'identity', url: `${baseURL()}/user/identity` },
        ],
        onChanged: () => deps.modelsUpdated(),
        logger: deps.logger,
      })

      // ── 积分 ────────────────────────────────────────────────────────────
      const readCredits = async (session: { session: string; sourcePath: string }): Promise<CreditsView> => {
        const result = await fetchCredits({
          baseURL: baseURL(),
          session,
          pageSize: setting<number>('creditsPageSize'),
        })
        if (result.kind === 'failure') throw new UpstreamFailure(result.failure.code, result.failure.message)
        return result.credits
      }

      const credits = createCreditsStore({
        ttlMs: () => setting<number>('creditsTtlMs'),
        load: async () => {
          const snapshot = await auth.read()
          if (!snapshot.found || snapshot.session === undefined) {
            throw new UpstreamMissingCredential(snapshot.problem ?? '没有可用的 Loomy 登录态')
          }
          return readCredits({ session: snapshot.session, sourcePath: snapshot.sourcePath })
        },
        loadForAccount: async (account) => readCredits({ session: account.material, sourcePath: `accounts.json#${account.id}` }),
        // 可用余额为 0 的账号已经不可用了：读余额是唯一能知道这件事的时刻，
        // 就在这里 bench 它（零余额不是错误，是关于账号的事实）。
        onRead: (view, account) => {
          if (account === undefined) return
          const available = view.fields['available'] ?? 0
          if (available <= 0) {
            void store
              .markUnavailable(account.id, NO_POINTS_CODE, '积分不足（可用余额为 0），暂不参与轮换')
              .catch(() => undefined)
          }
        },
      })

      // ── 登录（插件自带短信登录） ────────────────────────────────────────
      const loginService = createLoginService({
        storageDir: () => deps.storageDir,
        invalidateAuth: () => {
          auth.invalidate()
          store.list({ force: true }).catch(() => undefined)
        },
        // 旧服务通过这个接口把新会话写进账号表；契约只要求 id/替换标志，
        // 路由（以及 slots 模式下的 slot 号）由 core 的 store 决定，所以这里补
        // 一次回读——`single` 模式下路由恒为 `loomy`，于是 slot 自然缺席。
        accounts: {
          add: async (input) => {
            try {
              const added = await store.add({
                kind: 'credentials',
                material: input.session,
                ...(input.phone === undefined ? {} : { phone: input.phone }),
                ...(input.userId === undefined ? {} : { userId: input.userId }),
              })
              const rows = await store.list({ force: true })
              const account = rows.find((row) => row.id === added.id)
              if (account === undefined) {
                return { kind: 'ok' as const, account: { id: added.id, route: PROVIDER_ID }, replaced: added.replaced }
              }
              const route = store.routeOf(account)
              const slot = slotForRoute(route)
              return {
                kind: 'ok' as const,
                account: { id: added.id, route, ...(slot === undefined || slot <= 1 ? {} : { slot }) },
                replaced: added.replaced,
              }
            } catch (error) {
              return { kind: 'failure' as const, code: 'persist_failed', message: safeErrorMessage(error) }
            }
          },
        },
        refreshRoutes: async () => {
          deps.modelsUpdated()
        },
        logger: deps.logger,
      })

      const login: LoginDriver = {
        async state(): Promise<AuthStateView> {
          const snapshot = await auth.read()
          const pluginLoggedIn = snapshot.found && snapshot.sourceOrigin === 'plugin'
          return {
            ok: true,
            pluginLoggedIn,
            effectiveSource: !snapshot.found
              ? 'none'
              : snapshot.sourceOrigin === 'plugin'
                ? 'plugin'
                : snapshot.sourceOrigin === 'env'
                  ? 'env'
                  : 'desktop',
            ...(snapshot.phone === undefined ? {} : { phone: snapshot.phone }),
            ...(snapshot.userId === undefined ? {} : { userId: snapshot.userId }),
            ...(snapshot.loginAt === undefined ? {} : { loginAt: snapshot.loginAt }),
          }
        },
        async sendCode(phone: string): Promise<AuthSendCodeView> {
          const result = await loginService.sendCode(phone)
          if (!result.ok) throw new Error(result.message)
          return {
            ok: true,
            phone: result.phone,
            resendAfterMs: result.resendAfterMs,
            expiresMs: result.expiresMs,
          }
        },
        async login(input): Promise<AuthLoginView> {
          const result = await loginService.login(input.phone, input.code)
          if (!result.ok) throw new Error(result.message)
          auth.invalidate()
          credits.invalidate()
          return {
            ok: true,
            ...(result.phone === undefined ? {} : { phone: result.phone }),
            ...(result.userId === undefined ? {} : { userId: result.userId }),
          }
        },
        async logout(): Promise<AuthLogoutView> {
          const result = await loginService.logout()
          auth.invalidate()
          credits.invalidate()
          return { ok: true, message: result.message }
        },
      }

      // ── 对话 ────────────────────────────────────────────────────────────
      const precheck = createSessionPrecheck({
        baseURL,
        ttlMs: () => setting<number>('precheckTtlMs'),
        logger: deps.logger,
      })

      const chat: ChatDriver = {
        api: 'openai-completions',
        compat: LOOMY_COMPAT,
        credentialName: 'Loomy desktop session',
        toModel: (model, context) => toPiModel(model, context.baseUrl, context.route),
        prepareHeaders: (request, headers) => prepareLoomyHeaders(request, headers, loomyVersion()),
        /**
         * 把"看起来像截断"的终止失败升级成可执行的"登录态失效"。
         *
         * 上游把失败报成 HTTP 200 + 业务码，pi-ai 只看得到"没有 finish_reason"，
         * 于是归类成可重试的 TRANSPORT —— 与真正的截断无法区分。只有在这种情况
         * （无任何输出、outputTokens=0）才值得花一次 `/user/identity` 探测。
         */
        async explainAmbiguousFailure() {
          try {
            const snapshot = await auth.read()
            if (!snapshot.found || snapshot.session === undefined) return undefined
            const verdict = await precheck(snapshot.session, { force: true })
            if (!verdict.definite) return undefined
            return new LlmError(
              verdict.message ?? `本机 Loomy 登录态已失效（${snapshot.sourcePath}），请在 Loomy 客户端重新登录后重试。`,
              'MISSING_CREDENTIAL',
            )
          } catch (error) {
            deps.logger.warn('dsh-connect-desktop: 强制登录态探测失败', error)
            return undefined
          }
        },
      }

      /**
       * 活体探针：三个端点各打一次，逐条回传上游原文。
       *
       * 永不抛错 —— 一个端点失败只影响它自己那一行。签出时不发任何请求，直接
       * 用同一句可执行原因填满三行。
       */
      const probeEndpoints = async (): Promise<DiagnosticsProbe[]> => {
        const snapshot = await auth.read()
        const urls = [
          { path: '/models', label: 'models' },
          { path: '/points/records', label: 'points' },
          { path: '/user/identity', label: 'identity' },
        ] as const
        if (!snapshot.found || snapshot.session === undefined) {
          const reason = snapshot.problem ?? `没有可用的 Loomy 登录态（${snapshot.sourcePath}）`
          return urls.map((entry) => ({ path: entry.path, ok: false, reason }))
        }
        const session = snapshot.session
        const [models, points, identity] = await Promise.all([
          (async (): Promise<DiagnosticsProbe> => {
            try {
              const list = await fetchCatalogModels({ baseURL: baseURL(), session })
              return { path: '/models', ok: true, reason: `ok（${list.length} 个聊天模型）` }
            } catch (error) {
              return { path: '/models', ok: false, reason: safeErrorMessage(error) }
            }
          })(),
          (async (): Promise<DiagnosticsProbe> => {
            const result = await fetchCredits({
              baseURL: baseURL(),
              session: { session, sourcePath: snapshot.sourcePath },
              pageSize: 1,
            }).catch((error: unknown) => ({ kind: 'failure' as const, failure: { code: 'probe_failed', message: safeErrorMessage(error) } }))
            return result.kind === 'ok'
              ? { path: '/points/records', ok: true, reason: `ok（可用 ${result.credits.fields['available'] ?? '—'}）` }
              : { path: '/points/records', ok: false, reason: result.failure.message }
          })(),
          (async (): Promise<DiagnosticsProbe> => {
            const result = await fetchIdentity({
              baseURL: baseURL(),
              session: { session, sourcePath: snapshot.sourcePath },
            }).catch((error: unknown) => ({ kind: 'failure' as const, failure: { code: 'probe_failed', message: safeErrorMessage(error) } }))
            return result.kind === 'ok'
              ? { path: '/user/identity', ok: true, reason: 'ok（登录态有效）' }
              : { path: '/user/identity', ok: false, reason: result.failure.message }
          })(),
        ])
        return [models, points, identity]
      }

      /** 最近一次推理调用实际使用的账号（轮换时用来回答"刚花了谁的钱"）。 */
      let lastPick: { accountId?: string; at: number } | undefined

      // ── 路由与付费身份 ─────────────────────────────────────────────────
      return {
        descriptor: LOOMY_DESCRIPTOR,
        credentials,
        preferences,
        accounts,
        catalog,
        credits,
        login,
        chat,

        probeEndpoints,
        lastPick: () => lastPick,

        async routes() {
          return store.routes({ poolEnabled: await preferences.poolEnabled() })
        },

        /**
         * 这次调用用哪个身份的会话。**全插件唯一**的优先级决策点。
         *
         * 路由集合只有一条（`single`），所以这里不看 `route`：选哪个账号是每次
         * 调用的决定，不是会话绑定的属性。
         *
         * 规则：
         * 1. 轮换开启且有多个候选 → 池里挑一个健康的；全都 bench 了就抛错并列出
         *    每个账号的原因，而不是静默用一个用户已被告知不可用的账号。
         * 2. 轮换关闭 → `activeAccountId` 选的账号；它被 bench 就退到第一个健康的。
         * 3. 池里没有任何账号 → 用桌面端登录态。
         */
        async resolveCredential(_route: string) {
          const candidatesForPool = await store.poolCandidates()
          if (candidatesForPool.length === 0) {
            const snapshot = await auth.read()
            if (!snapshot.found || snapshot.session === undefined) {
              throw new LlmError(snapshot.problem ?? '没有可用的 Loomy 登录态。', 'MISSING_CREDENTIAL')
            }
            return { material: snapshot.session }
          }

          const usable = await pool.usable()
          const benchedSummary = (): string =>
            candidatesForPool
              .map((account) => {
                const who = account.label ?? account.phone ?? account.id
                const why = account.unavailableMessage ?? account.unavailableCode ?? '不可用'
                return `${who}：${why}`
              })
              .join('；')

          const rotate = await preferences.poolEnabled()
          let chosen: StoredAccount | undefined
          if (rotate && candidatesForPool.length > 1) {
            const pick = await pool.pick()
            if (pick.kind === 'none-healthy') {
              throw new LlmError(
                `所有账号当前都不可用，已停止调用，避免用坏账号继续失败。原因——${benchedSummary()}。可在输入框旁的账号抽屉里点「刷新」重试，或重新登录相应账号。`,
                'MISSING_CREDENTIAL',
              )
            }
            chosen = pick.kind === 'ok' ? pick.account : undefined
          } else {
            const activeId = await preferences.activeAccountId()
            const selected = candidatesForPool.find((account) => account.id === activeId)
            chosen =
              selected !== undefined && usable.some((account) => account.id === selected.id)
                ? selected
                : (usable[0] ?? undefined)
          }

          if (chosen === undefined) {
            const snapshot = await auth.read()
            if (!snapshot.found || snapshot.session === undefined) {
              throw new LlmError(snapshot.problem ?? '没有可用的 Loomy 登录态。', 'MISSING_CREDENTIAL')
            }
            return { material: snapshot.session }
          }

          const verdict = await precheck(chosen.material)
          if (!verdict.ok && verdict.definite) {
            await store.markUnavailable(chosen.id === DESKTOP_ACCOUNT_ID ? chosen.id : chosen.id, 'MISSING_CREDENTIAL', verdict.message ?? '登录态已失效').catch(() => undefined)
            throw new LlmError(
              verdict.message ?? `Loomy 登录态已失效（${chosen.id}），请重新登录后重试。`,
              'MISSING_CREDENTIAL',
            )
          }
          return {
            material: chosen.material,
            ...(chosen.origin === 'desktop' ? {} : { accountId: chosen.id }),
          }
        },
      }
    },
  }
}

// ── 局部错误类型 ──────────────────────────────────────────────────────────

/** 没有登录态：让 `core/catalog.ts` / `core/credits.ts` 记成一次真实失败。 */
class UpstreamMissingCredential extends Error {
  readonly code = 'MISSING_CREDENTIAL'
}

/** 上游业务失败，保留上游码与原文。 */
class UpstreamFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'UpstreamFailure'
  }
}

// ── 测试/CLI 需要的再导出（barrel 从这里取） ──────────────────────────────
export {
  ACCENT,
  DEFAULT_BASE_URL,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_CREDITS_PAGE_SIZE,
  DEFAULT_CREDITS_TTL_MS,
  DEFAULT_LOOMY_VERSION,
  DEFAULT_PRECHECK_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  DISPLAY_NAME,
  LOOMY_API,
  LOOMY_CONFIG_DEFAULTS,
  LOOMY_CONFIG_SCHEMA,
  MAX_CREDITS_PAGE_SIZE,
  POOL_ROUTE,
  PROVIDER_ID,
  PROVIDER_DISPLAY_NAME,
  CREDIT_FIELDS,
} from './constants.js'
export { LOOMY_COMPAT, displayNameFor, prepareLoomyHeaders, thinkingLevelMapFor, toPiModel } from './provider.js'
export { fetchCatalogModels, UpstreamFailure as LoomyUpstreamFailure } from './catalog.js'
export { authSessionCandidatesWithPlugin } from './plugin-auth.js'
export { accountIdOf, isOurRoute, routeDisplayName, routeForSlot, slotForRoute } from './accounts.js'

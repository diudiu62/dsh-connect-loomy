/**
 * 小浣熊供应商模块：**只声明能力 + 只实现协议**。
 *
 * 这个文件取代了原来的自包含实现（`routes.ts` 605 行、`accounts.ts` 419 行、
 * `pool.ts` 243 行、`provider.ts` 里 200 行池记账适配器）。现在每一块重复的东西
 * 都回流到 `src/core`，这里只留下"只有小浣熊才知道"的协议事实：
 *
 * | 关注点 | 在哪儿实现 |
 * |---|---|
 * | 账号存储、桌面身份、路由推导 | `core/accounts.ts`（`routeMode:'single'`） |
 * | 池挑选、冷却、失败分类 | `core/pool.ts` |
 * | 目录缓存、选择、能力覆盖 | `core/catalog.ts` |
 * | 积分缓存、逐账号合并 | `core/credits.ts` |
 * | 凭据读取窗口、候选报告 | 本文件（决策）+ `auth.ts`（协议） |
 * | pi-ai 适配器、池记账、重试 | `core/provider.ts` |
 * | HTTP 路由、CSRF、视图装配 | `core/routes.ts` + `core/surface.ts` |
 *
 * **唯一留在本文件里的语义**是 {@link createRaccoonModule} 里的
 * `resolveCredential`：挑哪个账号为这次调用付费，是全插件**唯一**一处决定。
 *
 * @module dsh-connect-desktop/vendors/raccoon
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {
  AccountDriver,
  CredentialCandidate,
  CredentialDriver,
  CredentialIdentity,
  CredentialState,
  LoginDriver,
  StoredAccount,
  VendorCapabilities,
  VendorDeps,
  ConfigGroupDeclaration,
  VendorDescriptor,
  VendorModule,
  VendorRuntime,
} from '../../vendor-sdk/contracts.js'
import type { AuthLoginView, AuthLogoutView, AuthSendCodeView, AuthStateView } from '../../shared/views.js'
import {
  DEFAULT_POOL_COOLDOWN_MS,
  createAccountPool,
} from '../../core/pool.js'
import {
  DESKTOP_ACCOUNT_ID,
  createAccountsStore,
  emptyAccountsDocument,
  parseAccountsDocument,
  serializeAccountsDocument,
  type DesktopIdentity,
} from '../../core/accounts.js'
import { createCatalogStore } from '../../core/catalog.js'
import { createCreditsStore } from '../../core/credits.js'
import { createVendorPreferences } from '../../core/preferences.js'
import { vendorStateStore } from '../../core/state.js'
import {
  authCandidateStates,
  authCandidates,
  authIdentity,
  decodeJwtPayload,
  readAuth,
  type RaccoonAuthSnapshot,
} from './auth.js'
import { fetchCatalog } from './catalog.js'
import { RACCOON_CREDIT_FIELDS, fetchBalance, fetchBills, toCreditsView } from './credits.js'
import {
  DEFAULT_RACCOON_BASE_URL,
  DEFAULT_RACCOON_CATALOG_TTL_MS,
  DEFAULT_RACCOON_CLIENT_VERSION,
  DEFAULT_RACCOON_CREDITS_TTL_MS,
  DEFAULT_RACCOON_NATION_CODE,
  DEFAULT_RACCOON_POINTS_URL,
  RACCOON_DISPLAY_NAME,
  RACCOON_PROVIDER_ID,
  RACCOON_VENDOR_NAME,
} from './constants.js'
import { readDeviceId } from './device.js'
import { safeErrorMessage } from '../../shared/text.js'
import { createRaccoonChatDriver } from './provider.js'
import {
  encryptRaccoonPhone,
  fetchUserInfo,
  loginWithPassword,
  loginWithSms,
  logout as logoutRequest,
  sendSmsCode,
  type PhoneEncryptor,
} from './auth-flow.js'

/** 卡片的品牌色（小浣熊的橙）。 */
const RACCOON_ACCENT = '#FF6A1F'

/** 签出时的提示：可执行、说清插件不代刷。 */
const MISSING_CREDENTIAL_MESSAGE =
  '没有找到小浣熊客户端的登录态。请打开「商汤小浣熊」桌面端登录一次，然后点「重新检测」。'

/** 令牌过期时的提示：同样是可执行的一句话。 */
const EXPIRED_CREDENTIAL_MESSAGE =
  '小浣熊登录态已过期，请打开小浣熊桌面端重新登录（插件不会替你刷新令牌）。'

/** 桌面端身份在账号行里的显示名。 */
const DESKTOP_LABEL = '桌面端'

/** 凭据读的进程内窗口：一次卡片渲染会读两三次，没必要每次都碰磁盘。 */
const CREDENTIAL_READ_TTL_MS = 1_000

/**
 * 配置片的默认值。
 *
 * 与 `schema` 里的 `.default()` 同源：`deps.setting()` 读的是**用户写的原始
 * slice**（默认值不会在 registry 里被 schemastery 填进去），所以读取侧必须自己
 * 兜底，两边共用一个常量才不会漂。
 */
export const RACCOON_CONFIG_DEFAULTS = {
  enabled: true,
  baseURL: DEFAULT_RACCOON_BASE_URL,
  pointsURL: DEFAULT_RACCOON_POINTS_URL,
  clientVersion: DEFAULT_RACCOON_CLIENT_VERSION,
  orgCode: '',
  nationCode: DEFAULT_RACCOON_NATION_CODE,
  catalogTtlMs: DEFAULT_RACCOON_CATALOG_TTL_MS,
  creditsTtlMs: DEFAULT_RACCOON_CREDITS_TTL_MS,
  visionModelIds: [] as string[],
  textOnlyModelIds: [] as string[],
} as const

/**
 * 配置页的分组（由供应商声明，core 只按它归位）。
 */
export const RACCOON_CONFIG_GROUPS: ConfigGroupDeclaration[] = [
  { id: 'connection', labelKey: 'config.group.connection', keys: ['enabled', 'baseURL', 'pointsURL', 'clientVersion', 'orgCode', 'nationCode'] },
  { id: 'cache', labelKey: 'config.group.cache', keys: ['catalogTtlMs', 'creditsTtlMs'] },
  { id: 'models', labelKey: 'config.group.models', keys: ['visionModelIds', 'textOnlyModelIds'] },
]

/** 本供应商的配置片（`config.vendors.raccoon`）。 */
export const RACCOON_CONFIG_SCHEMA = z.object({
  enabled: z.boolean().default(RACCOON_CONFIG_DEFAULTS.enabled).description('启用「商汤小浣熊」供应商'),
  baseURL: z.string().default(RACCOON_CONFIG_DEFAULTS.baseURL).description('OpenAI 兼容 base URL'),
  pointsURL: z.string().default(RACCOON_CONFIG_DEFAULTS.pointsURL).description('只读积分余额接口'),
  clientVersion: z.string().default(RACCOON_CONFIG_DEFAULTS.clientVersion).description('上报的 X-Client-Version'),
  orgCode: z.string().default(RACCOON_CONFIG_DEFAULTS.orgCode).description('企业组织码（X-Org-Code）；个人版留空'),
  nationCode: z.string().default(RACCOON_CONFIG_DEFAULTS.nationCode).description('登录用的国家码'),
  catalogTtlMs: z.natural().default(RACCOON_CONFIG_DEFAULTS.catalogTtlMs).description('模型目录缓存毫秒'),
  creditsTtlMs: z.natural().default(RACCOON_CONFIG_DEFAULTS.creditsTtlMs).description('积分余额缓存毫秒'),
  visionModelIds: z.array(z.string()).default([...RACCOON_CONFIG_DEFAULTS.visionModelIds]).description('强制声明支持图片的模型 id'),
  textOnlyModelIds: z
    .array(z.string())
    .default([...RACCOON_CONFIG_DEFAULTS.textOnlyModelIds])
    .description('强制声明纯文本的模型 id（优先于 visionModelIds）'),
})

/**
 * 能力声明：**声明即路由**。
 *
 * `core/routes.ts` 按这份声明生成 HTTP 面，`conformance.ts` 在挂载时校验
 * "声明了的都必须实现"。所以这段不是文档，是开关。
 */
const capabilities: VendorCapabilities = {
  // 桌面账号 + 插件账号，本质上是多身份；只是它们共用一条路由。
  accounts: 'multi',
  pool: true,
  // auth-flow 支持的两种登录。
  login: ['sms-code', 'password'],
  credits: {
    kind: 'balance',
    fields: RACCOON_CREDIT_FIELDS,
    // `/points/v2/bills` 实测可用（游标分页），所以明细一起给。
    ledger: true,
  },
  catalog: {
    selection: true,
    visionOverride: true,
    // 网关不校验 reasoning_effort：不做假的等级选择器。
    reasoningEffort: false,
  },
  transfer: true,
  // 桌面账号本身就是池成员，不需要"收养"成一行。
  adopt: false,
  diagnostics: true,
}

/** 供应商身份。`id` 进入模型 identity，永不改。 */
export const RACCOON_DESCRIPTOR: VendorDescriptor = {
  id: RACCOON_PROVIDER_ID,
  displayName: RACCOON_VENDOR_NAME,
  accent: RACCOON_ACCENT,
  // 没装小浣熊客户端的机器不该看到这一组。
  providerVisibility: 'signed-in',
  capabilities,
  config: {
    schema: RACCOON_CONFIG_SCHEMA,
    defaults: { ...RACCOON_CONFIG_DEFAULTS },
    groups: RACCOON_CONFIG_GROUPS,
  },
}

/** 模块级注入点（测试/嵌入方）；配置片是 JSON，装不下函数。 */
export interface RaccoonModuleOptions {
  /**
   * 手机号/密码加密器。
   *
   * 默认是客户端自己用的那一套（AES-128-CFB，`auth-flow.ts` 的反混淆结果）。
   * 保留可注入是因为那套"密钥"只是混淆、会随客户端更新而变：换口令应该是配置
   * 或嵌入方的事，而不是发一个版本。未配置时**不会**静默退化成明文——见
   * `auth-flow.ts` 文件头（明文手机号会被网关拒成 `params_encryted_error`）。
   */
  phoneEncryptor?: PhoneEncryptor
  /** 池挑选的随机源（测试用）。 */
  random?: () => number
}

/** 一次凭据挑选的结果。 */
interface ResolvedPick {
  material: string
  accountId?: string
  origin: 'plugin' | 'desktop'
  sourcePath: string
  identity?: CredentialIdentity
  expiresAt?: number
}

/** {@link createRaccoonModule} 内部的决策结果。 */
type PickResult =
  | { kind: 'credential'; credential: ResolvedPick }
  | { kind: 'expired'; material: string; sourcePath: string; expiresAt?: number; identity?: CredentialIdentity }
  | { kind: 'missing'; problem: string; candidates: CredentialCandidate[] }

/**
 * 创建小浣熊供应商模块。
 *
 * 挂载过程**同步且不碰网络**：所有会失败的事情（读客户端令牌、抓目录、读余额）
 * 都推迟到路由、模型调用或 CLI 触发时。这也是 `core/registry.ts` 的挂载契约。
 */
export function createRaccoonModule(options: RaccoonModuleOptions = {}): VendorModule {
  return {
    descriptor: RACCOON_DESCRIPTOR,
    create(deps: VendorDeps): VendorRuntime {
      const now = deps.now

      // ── 配置（每次现读，设置一改就生效） ─────────────────────────────────
      const rawSetting = (key: string): unknown => deps.setting<unknown>(key)
      const stringSetting = (key: keyof typeof RACCOON_CONFIG_DEFAULTS): string => {
        const value = rawSetting(key)
        const fallback = RACCOON_CONFIG_DEFAULTS[key]
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : String(fallback)
      }
      const numberSetting = (key: 'catalogTtlMs' | 'creditsTtlMs'): number => {
        const value = rawSetting(key)
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : RACCOON_CONFIG_DEFAULTS[key]
      }
      const listSetting = (key: 'visionModelIds' | 'textOnlyModelIds'): string[] => {
        const value = rawSetting(key)
        return Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          : [...RACCOON_CONFIG_DEFAULTS[key]]
      }

      const baseURL = (): string => stringSetting('baseURL').replace(/\/+$/u, '')
      const pointsURL = (): string => stringSetting('pointsURL')
      const clientVersion = (): string => stringSetting('clientVersion')
      const orgCode = (): string | undefined => {
        const value = stringSetting('orgCode')
        return value.length === 0 ? undefined : value
      }
      const encryptor = (): PhoneEncryptor => options.phoneEncryptor ?? encryptRaccoonPhone
      const deviceId = (): string | undefined => readDeviceId()

      // ── 持久化：状态文档 + 账号表（都走 core 的原子写入） ────────────────
      const state = vendorStateStore(deps.document)
      const preferences = createVendorPreferences(state)

      /**
       * 桌面端登录态的进程内"冷却"。
       *
       * 桌面令牌存在客户端自己的文件里，本插件**永不写**，所以池的持久化禁用在
       * 这里没有落点（`core/accounts.ts` 明确忽略 `desktop` 的 mark*）。旧实现
       * 也用过同样的内存账：一个把点数花光的桌面令牌会被反复挑中、反复失败。
       * 存在内存里的代价是重启后忘掉，对一个由 JWT 重新推导的提示值来说是对的。
       */
      const desktopBench = new Map<string, number>()

      const desktopSnapshot = (): RaccoonAuthSnapshot => readAuth()

      /** 桌面端身份，作为池成员；过期/冷却中时**不出现**。 */
      const desktopAccount = async (): Promise<StoredAccount | undefined> => {
        const benchedAt = desktopBench.get(DESKTOP_ACCOUNT_ID)
        if (benchedAt !== undefined && now() - benchedAt < DEFAULT_POOL_COOLDOWN_MS) return undefined
        const snapshot = desktopSnapshot()
        if (!snapshot.found || snapshot.token === undefined) return undefined
        if (snapshot.expired === true) return undefined
        return { id: DESKTOP_ACCOUNT_ID, material: snapshot.token, origin: 'desktop', label: DESKTOP_LABEL }
      }

      const accountDocument = deps.document('accounts.json', {
        parse: parseAccountsDocument,
        serialize: serializeAccountsDocument,
        empty: emptyAccountsDocument,
      })

      const desktopIdentity = async (): Promise<DesktopIdentity | undefined> => {
        const account = await desktopAccount()
        if (account === undefined) return undefined
        return { material: account.material, label: DESKTOP_LABEL }
      }

      const store = createAccountsStore({
        document: accountDocument,
        // 一条路由给所有账号；谁付费由 `resolveCredential` 每次决定。
        routeMode: 'single',
        routeBase: RACCOON_PROVIDER_ID,
        displayName: RACCOON_DISPLAY_NAME,
        desktop: desktopIdentity,
        /**
         * 从 JWT 的 `sub` 补出稳定标识。
         *
         * 早先写入的账号没有 phone（上游没回号码），label 又被错写成身份类型，
         * 界面上只能显示「账号 3」。`sub`（`pu-01a1e893-…`）每个账号都不同，
         * 足够让用户认出是哪一条，而且不用重写任何用户数据。
         */
        describeMaterial: (material) => {
          const claims = decodeJwtPayload(material)
          const sub = claims?.['sub']
          return typeof sub === 'string' && sub.length > 0 ? { userId: sub } : undefined
        },
        now,
      })

      /**
       * 账号驱动。
       *
       * 与 core 的差别只有两处，都是小浣熊特有的形态：
       *
       * 1. `list()` **包含桌面端身份**——它是池成员、是卡片的行、也是可以显式
       *    选中的账号。少了它，池永远不会挑桌面端，而桌面端恰恰是绝大多数用户
       *    唯一的身份。
       * 2. `active()` 读**偏好**（状态文档）而不是"第一条"，因为有单路由形态：
       *    用户选的账号必须真的被用。
       */
      /** 已经查过 user_info 的账号 id：同一个账号不重复查。 */
      const profileProbed = new Set<string>()

      const accounts: AccountDriver = {
        list: async (listOptions = {}) => {
          const stored = await store.list(listOptions)
          const desktop = await desktopAccount()
          return desktop === undefined ? stored : [...stored, desktop]
        },

        active: async () => (await preferences.activeAccountId()) ?? (await store.active?.()),

        setActive: (id) => preferences.setActiveAccountId(id),

        add: (input) => store.add(input),

        /**
         * 回填没有手机号的老账号。
         *
         * 微信/短信登录响应里没有号码，JWT 里也只有 `sub`，唯一来源是
         * `user_info`。这里对每条缺号码的账号用它的 token 查一次，把手机号、
         * 昵称和数字 id 写回账号表——纯本地修复，不改上游任何东西。
         *
         * 失败（token 已失效）就跳过：那条本来就该被清理，不该让整批失败。
         */
        async enrich() {
          const rows = await store.list({ force: true })
          let filled = 0
          for (const row of rows) {
            if (row.origin === 'desktop') continue
            if (row.phone !== undefined && row.phone.length > 0) continue
            const info = await fetchUserInfo(row.material)
            if (!info.ok) continue
            if (info.phone === undefined && info.userId === undefined && info.name === undefined) continue
            await store.setIdentity(row.id, {
              ...(info.phone === undefined ? {} : { phone: info.phone }),
              ...(info.userId === undefined ? {} : { userId: info.userId }),
              ...(info.name === undefined ? {} : { label: info.name }),
            })
            filled += 1
          }
          if (filled > 0) {
            await store.list({ force: true })
            credentials.invalidate()
            credits.invalidate()
          }
          return filled
        },

        remove: async (id) => {
          if (id === DESKTOP_ACCOUNT_ID) {
            throw new Error('桌面端登录态由小浣熊客户端管理，插件不会删除它；请直接在客户端退出。')
          }
          await store.remove(id)
          if ((await preferences.activeAccountId()) === id) await preferences.setActiveAccountId(undefined)
        },

        rename: async (id, label) => {
          await store.rename?.(id, label)
        },

        // 必须转发：`enrichProfiles` 通过它把补全的手机号写回存储。漏了这里，
        // 补全查询会成功但**静默丢弃**结果（`store.update?.(...)` 是可选调用）。
        update: async (id, patch) => {
          await store.update?.(id, patch)
        },

        exportBundle: async () => {
          const exported = await store.exportBundle?.()
          return exported ?? { bundle: { kind: 'dsh-connect-desktop/accounts', version: 1, accounts: [] } }
        },

        importBundle: async (document) => {
          return (await store.importBundle?.(document)) ?? { added: 0, refreshed: 0, skipped: 0 }
        },

        /**
         * 补全导入账号的手机号。
         *
         * 导出包/粘贴内容里只有 token，所以 `phone` 是空的，账号行只能显示「账号 3」。
         * `user_info` 能用同一个 token 换回真实手机号（实测三个账号都成功），所以这里
         * 在**打开账号页时**顺手补一次并写回，用户下次看到的就是号码。
         */
        async enrichProfiles() {
          const rows = await store.list({ force: true })
          const pending = rows.filter((row) => row.phone === undefined && !profileProbed.has(row.id))
          if (pending.length === 0) return 0
          let filled = 0
          // 限并发 3：账号可能有十几条，串行太慢、全并发会被上游限流。
          const queue = [...pending]
          const worker = async (): Promise<void> => {
            for (;;) {
              const row = queue.shift()
              if (row === undefined) return
              profileProbed.add(row.id)
              try {
                const info = await fetchUserInfo(row.material)
                if (!info.ok) {
                  deps.logger.warn(`dsh-connect-desktop: raccoon 补全 ${row.id} 失败：${info.message}`)
                  continue
                }
                // 只写 phone/userId：label 留给用户自己起名。
                await store.update?.(row.id, {
                  ...(info.phone === undefined ? {} : { phone: info.phone }),
                  ...(info.userId === undefined ? {} : { userId: info.userId }),
                })
                filled += 1
              } catch (error) {
                // 单个账号失败不影响其它账号；下次打开页面会再试。
                deps.logger.warn(
                  `dsh-connect-desktop: raccoon 补全 ${row.id} 写入失败：${error instanceof Error ? error.message : String(error)}`,
                )
                profileProbed.delete(row.id)
              }
            }
          }
          await Promise.all([worker(), worker(), worker()])
          return filled
        },

        markUnavailable: async (id, code, message) => {
          if (id === DESKTOP_ACCOUNT_ID) {
            desktopBench.set(id, now())
            deps.logger.info(`dsh-connect-desktop: raccoon 桌面端登录态被暂停使用（${code}：${message}）`)
            return
          }
          await store.markUnavailable(id, code, message)
        },

        markHealthy: async (id) => {
          if (id === DESKTOP_ACCOUNT_ID) {
            desktopBench.delete(id)
            return
          }
          await store.markHealthy(id)
        },

        routeOf: (account) => store.routeOf(account),

        displayNameOf: (account) => store.displayNameOf(account),
      }

      const pool = createAccountPool({
        accounts,
        now,
        ...(options.random === undefined ? {} : { random: options.random }),
      })

      // ── 凭据：唯一的优先级决策点 ─────────────────────────────────────────
      const fromStored = (account: StoredAccount): PickResult => {
        if (account.origin === 'desktop') {
          const snapshot = desktopSnapshot()
          const identity = authIdentity(snapshot)
          return {
            kind: 'credential',
            credential: {
              material: account.material,
              accountId: DESKTOP_ACCOUNT_ID,
              origin: 'desktop',
              sourcePath: snapshot.sourcePath ?? '',
              ...(identity === undefined ? {} : { identity }),
              ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
            },
          }
        }
        const identity: CredentialIdentity = {
          ...(account.label === undefined ? {} : { label: account.label }),
          ...(account.phone === undefined ? {} : { phone: account.phone }),
          ...(account.userId === undefined ? {} : { userId: account.userId }),
        }
        return {
          kind: 'credential',
          credential: {
            material: account.material,
            accountId: account.id,
            origin: 'plugin',
            sourcePath: store.path,
            ...(Object.keys(identity).length === 0 ? {} : { identity }),
          },
        }
      }

      /**
       * 挑这次调用该用哪个身份——**唯一**一处优先级。
       *
       * 顺序（与旧 `resolveSnapshot` 逐条对齐）：
       *
       * 1. 轮换开着且有可挑账号 → 池挑（桌面身份也是候选）；
       * 2. 偏好里选中的账号（`preferences.activeAccountId()`）；
       * 3. 桌面 `auth.json`。
       *
       * 旧实现里 chat 走这条链、而目录与积分各走一条 `auth()`，结果"只有插件
       * 账号的机器能聊天，模型列表却报没有登录态"。现在三种读取共用这一个函数，
       * 所以一次调用、它的模型列表、它的积分永远来自同一个账号。
       *
       * 过期**不**参与挑选（桌面身份过期即从池里消失），但读凭据时仍会作为
       * `expired` 上报，让卡片说清原因。
       */
      /** 最近一次推理调用实际使用的账号（轮换时用来回答"刚花了谁的钱"）。 */
      let lastPick: { accountId?: string; at: number } | undefined

      const pickCredential = async (): Promise<PickResult> => {
        if (await preferences.poolEnabled()) {
          const pick = await pool.pick()
          if (pick.kind === 'ok') return fromStored(pick.account)
          if (pick.kind === 'none-healthy' && pick.accounts.length > 0) {
            // 全部被禁：重试最久没失败的那个，而不是直接失败。
            const oldest = [...pick.accounts].sort(
              (left, right) => (left.unavailableAt ?? 0) - (right.unavailableAt ?? 0),
            )[0]
            if (oldest !== undefined) return fromStored(oldest)
          }
        }

        const activeId = await preferences.activeAccountId()
        if (activeId !== undefined) {
          const account = activeId === DESKTOP_ACCOUNT_ID ? await desktopAccount() : await store.find(activeId)
          if (account !== undefined) return fromStored(account)
        }

        const snapshot = desktopSnapshot()
        if (!snapshot.found || snapshot.token === undefined) {
          return {
            kind: 'missing',
            problem: snapshot.problem ?? MISSING_CREDENTIAL_MESSAGE,
            candidates: authCandidateStates(),
          }
        }
        const identity = authIdentity(snapshot)
        if (snapshot.expired === true) {
          return {
            kind: 'expired',
            material: snapshot.token,
            sourcePath: snapshot.sourcePath ?? '',
            ...(identity === undefined ? {} : { identity }),
            ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
          }
        }
        return {
          kind: 'credential',
          credential: {
            material: snapshot.token,
            origin: 'desktop',
            sourcePath: snapshot.sourcePath ?? '',
            ...(identity === undefined ? {} : { identity }),
            ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
          },
        }
      }

      const requireCredential = async (): Promise<ResolvedPick> => {
        const picked = await pickCredential()
        if (picked.kind === 'credential') return picked.credential
        throw new LlmError(
          picked.kind === 'expired' ? EXPIRED_CREDENTIAL_MESSAGE : picked.problem,
          'MISSING_CREDENTIAL',
        )
      }

      let cachedState: CredentialState | undefined
      let cachedAt = 0
      const credentials: CredentialDriver = {
        read: async (readOptions = {}) => {
          if (readOptions.force !== true && cachedState !== undefined && now() - cachedAt < CREDENTIAL_READ_TTL_MS) {
            return cachedState
          }
          const picked = await pickCredential()
          const candidates = picked.kind === 'missing' ? picked.candidates : authCandidateStates()
          let next: CredentialState
          if (picked.kind === 'credential') {
            const credential = picked.credential
            next = {
              found: true,
              material: credential.material,
              sourcePath: credential.sourcePath,
              sourceOrigin: credential.origin,
              candidates,
              ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
              ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
              ...(credential.identity === undefined ? {} : { identity: credential.identity }),
            }
          } else if (picked.kind === 'expired') {
            next = {
              found: true,
              material: picked.material,
              sourcePath: picked.sourcePath,
              sourceOrigin: 'desktop',
              expired: true,
              candidates,
              ...(picked.expiresAt === undefined ? {} : { expiresAt: picked.expiresAt }),
              ...(picked.identity === undefined ? {} : { identity: picked.identity }),
            }
          } else {
            next = { found: false, problem: picked.problem, candidates }
          }
          cachedState = next
          cachedAt = now()
          return next
        },
        invalidate() {
          cachedState = undefined
          cachedAt = 0
        },
        probePaths: () => authCandidates().map((candidate) => candidate.path),
      }

      // ── 目录（缓存/选择/覆盖都在 core） ──────────────────────────────────
      const catalog = createCatalogStore({
        fetchModels: async () => {
          const credential = await requireCredential()
          const device = deviceId()
          return fetchCatalog({
            baseURL: baseURL(),
            token: credential.material,
            ...(orgCode() === undefined ? {} : { orgCode: orgCode() }),
            clientVersion: clientVersion(),
            ...(device === undefined ? {} : { deviceId: device }),
          })
        },
        ttlMs: () => numberSetting('catalogTtlMs'),
        state,
        // 能力覆盖由 core 在每个读路径上应用，这里只提供两个清单。
        overrides: () => ({
          visionModelIds: listSetting('visionModelIds'),
          textOnlyModelIds: listSetting('textOnlyModelIds'),
        }),
        endpoints: () => [
          { label: 'baseURL', url: baseURL() },
          { label: 'model_catalog', url: `${baseURL()}/model_catalog` },
          { label: 'points', url: pointsURL() },
        ],
        onChanged: () => deps.modelsUpdated(),
        logger: deps.logger,
        now,
      })

      // ── 积分（6 个桶 → fields；缺失的桶不填 0） ──────────────────────────
      const readBalance = async (token: string) => {
        const device = deviceId()
        return fetchBalance({
          token,
          pointsURL: pointsURL(),
          ...(orgCode() === undefined ? {} : { orgCode: orgCode() }),
          clientVersion: clientVersion(),
          ...(device === undefined ? {} : { deviceId: device }),
          now,
        })
      }

      /**
       * 余额 + 明细。
       *
       * 明细（`/points/v2/bills`）是**附加**信息：它失败不该让余额也消失，所以先拿
       * 余额（失败必须抛，否则会把"读不到"伪装成"零余额"），再尽力取第一页账单。
       * 只取一页：游标翻页会把一次只读查询变成 N 次上游请求，而卡片只需要"最近几笔"。
       */
      const readCreditsView = async (token: string, options: { withLedger?: boolean } = {}) => {
        /*
         * 余额与明细是**两个独立端点**，实测会各自失败：`balance` 被网关限流返回
         * 403 空 body 时，`bills` 仍然是 200。所以这里必须先各自尝试，再决定返回什么：
         *
         * - 都有 → 完整的桶 + 明细；
         * - 只有余额 → 桶（明细失败只记日志）；
         * - **只有明细 → 明细 + 空桶**，并标 `partial`，让 UI 说明"余额暂时读不到"，
         *   而不是整块报错把能拿到的明细也丢掉；
         * - 都没有 → 抛余额的错误（那才是用户需要修的问题）。
         */
        let view: import('../../shared/views.js').CreditsView | undefined
        let balanceError: unknown
        try {
          view = toCreditsView(await readBalance(token))
        } catch (error) {
          balanceError = error
        }

        // 逐账号读取**不**取明细：那是 N 倍的账单请求，而明细只需要在总额层面
        // 展示一次（同一批对话本来就分散在多个账号上，逐账号翻页没有意义，还会
        // 因为请求太密被上游限流）。
        if (options.withLedger !== true) {
          if (view !== undefined) return view
          throw balanceError
        }

        const device = deviceId()
        try {
          const page = await fetchBills({
            token,
            ...(orgCode() === undefined ? {} : { orgCode: orgCode() }),
            clientVersion: clientVersion(),
            ...(device === undefined ? {} : { deviceId: device }),
          })
          if (view === undefined) {
            // 余额读不到、明细能读到：把明细交出去，并如实标注缺了什么。
            if (page.records.length === 0) throw balanceError
            deps.logger.warn(
              `dsh-connect-desktop: raccoon 余额读取失败，仅显示明细：${safeErrorMessage(balanceError)}`,
            )
            return {
              fields: {},
              fetchedAt: now(),
              records: page.records,
              partial: 'balance_unavailable',
            } satisfies import('../../shared/views.js').CreditsView
          }
          return page.records.length === 0 ? view : { ...view, records: page.records }
        } catch (billsError) {
          if (view !== undefined) {
            deps.logger.warn(`dsh-connect-desktop: raccoon 账单读取失败（余额照常显示）：${safeErrorMessage(billsError)}`)
            return view
          }
          // 余额和明细都失败：报余额的错误（那才是用户要修的）。
          throw balanceError ?? billsError
        }
      }

      const credits = createCreditsStore({
        load: async () => readCreditsView((await requireCredential()).material, { withLedger: true }),
        loadForAccount: async (account) => {
          if (account.material.length === 0) throw new Error('该账号没有可用的登录态')
          return readCreditsView(account.material)
        },
        ttlMs: () => numberSetting('creditsTtlMs'),
        now,
      })

      // ── 登录（协议在 auth-flow.ts） ──────────────────────────────────────
      const login: LoginDriver = {
        async state(): Promise<AuthStateView> {
          const picked = await pickCredential()
          const stored = await store.list()
          const pluginLoggedIn = stored.length > 0
          if (picked.kind === 'missing') {
            return { ok: true, pluginLoggedIn, effectiveSource: 'none' }
          }
          const credential = picked.kind === 'credential' ? picked.credential : undefined
          const identity = credential?.identity
          const stored0 = credential?.accountId === undefined
            ? undefined
            : stored.find((account) => account.id === credential.accountId)
          return {
            ok: true,
            pluginLoggedIn,
            effectiveSource: picked.kind === 'expired' ? 'desktop' : (credential?.origin ?? 'none'),
            ...(identity?.phone === undefined ? {} : { phone: identity.phone }),
            ...(identity?.userId === undefined ? {} : { userId: identity.userId }),
            ...(stored0?.addedAt === undefined ? {} : { loginAt: stored0.addedAt }),
          }
        },

        async sendCode(phone: string): Promise<AuthSendCodeView> {
          const result = await sendSmsCode(
            desktopSnapshot().token,
            stringSetting('nationCode'),
            phone,
            encryptor(),
          )
          if (!result.ok) throw new Error(result.message)
          // 原样返回：账号展示不脱敏（脱敏只用于日志）。
          return { ok: true, phone }
        },

        async login(input): Promise<AuthLoginView> {
          const nationCode = stringSetting('nationCode')
          const result =
            input.method === 'password'
              ? await loginWithPassword(nationCode, input.phone, input.password ?? '', encryptor())
              : await loginWithSms(nationCode, input.phone, input.code, encryptor())
          if (!result.ok || result.accessToken === undefined) throw new Error(result.message)
          /*
           * 登录响应里**没有手机号**（只有 token 和 `office_identity`），JWT 里也只有
           * `sub`。真实号码只在 `user_info` 里——不查它，账号行就只能显示「账号 3」。
           * 查失败不算登录失败：号码退化成用户输入的那个。
           */
          const info = await fetchUserInfo(result.accessToken)
          const phone = info.ok && info.phone !== undefined ? info.phone : input.phone
          const added = await store.add({
            kind: 'credentials',
            material: result.accessToken,
            phone,
            ...(info.ok && info.userId !== undefined ? { userId: info.userId } : {}),
            // **不要把平台昵称写进 label**：label 是"用户自己起的名字"，一旦被
            // 自动昵称（RaccoonSofia）占用，账号行就永远显示昵称而不是手机号。
            // 同理 `result.identity` 是身份类型（personal/enterprise），更不能占名字位。
          })
          // 用户"在插件里登录"的意图就是"用这个身份"：单路由形态下不设选中，
          // 登录在界面上就没有任何可见效果（旧实现漏了这一步）。
          await preferences.setActiveAccountId(added.id)
          credentials.invalidate()
          credits.invalidate()
          catalog.kickRefresh()
          return { ok: true, phone: input.phone }
        },

        async logout(): Promise<AuthLogoutView> {
          const picked = await pickCredential()
          if (picked.kind === 'missing') {
            return { ok: true, message: '当前没有小浣熊登录态，无需登出' }
          }
          const material = picked.kind === 'credential' ? picked.credential.material : picked.material
          const result = await logoutRequest(material)
          if (!result.ok) throw new Error(result.message)
          // 插件自己存的账号：删掉这一行。桌面端文件不归插件写，保持原样。
          const accountId = picked.kind === 'credential' ? picked.credential.accountId : undefined
          if (picked.kind === 'credential' && picked.credential.origin === 'plugin' && accountId !== undefined) {
            await store.remove(accountId)
            if ((await preferences.activeAccountId()) === accountId) await preferences.setActiveAccountId(undefined)
          }
          credentials.invalidate()
          credits.invalidate()
          return { ok: true, message: result.message }
        },
      }

      const chat = createRaccoonChatDriver({ clientVersion, deviceId })

      return {
        descriptor: RACCOON_DESCRIPTOR,
        credentials,
        preferences,
        accounts,
        catalog,
        credits,
        login,
        chat,
        /**
         * 永远只有一条路由。
         *
         * 多账号不改变路由集合：`routeMode:'single'` 下"谁付费"是每次调用的
         * 决定，不是会话绑定的属性（那正是 Loomy 的 slots 形态）。冻结路由
         * 集合也让模型 identity 稳定——历史消息里的 `provider` 永远是 `raccoon`。
         */
        /**
         * 活体探针：目录与余额各打一次，逐条回传原文。永不抛错。
         */
        async probeEndpoints() {
          const picked = await pickCredential()
          if (picked.kind !== 'credential') {
            const reason =
              picked.kind === 'expired'
                ? `登录态已过期（${picked.sourcePath}），请在小浣熊客户端重新登录`
                : picked.problem
            return [
              { path: 'catalog', ok: false, reason },
              { path: 'balance', ok: false, reason },
            ]
          }
          const material = picked.credential.material
          const [catalog, balance] = await Promise.all([
            (async () => {
              try {
                const models = await fetchCatalog({
                  baseURL: baseURL(),
                  token: material,
                  ...(orgCode() === undefined ? {} : { orgCode: orgCode() as string }),
                  clientVersion: clientVersion(),
                  ...(deviceId() === undefined ? {} : { deviceId: deviceId() as string }),
                })
                return { path: 'catalog', ok: true, reason: `ok（${models.length} 个模型）` }
              } catch (error) {
                return { path: 'catalog', ok: false, reason: safeErrorMessage(error) }
              }
            })(),
            (async () => {
              try {
                const value = await fetchBalance({
                  token: material,
                  ...(pointsURL() === undefined ? {} : { pointsURL: pointsURL() as string }),
                  clientVersion: clientVersion(),
                  ...(deviceId() === undefined ? {} : { deviceId: deviceId() as string }),
                })
                return { path: 'balance', ok: true, reason: `ok（可用 ${value.available ?? '—'}）` }
              } catch (error) {
                return { path: 'balance', ok: false, reason: safeErrorMessage(error) }
              }
            })(),
          ])
          return [catalog, balance]
        },

        lastPick: () => lastPick,

        async routes() {
          return [{ route: RACCOON_PROVIDER_ID, displayName: RACCOON_DISPLAY_NAME, origin: 'desktop' as const }]
        },

        /**
         * 这次调用用哪个身份付费。**全插件唯一**的优先级决策点。
         *
         * 返回的 `accountId` 让 `core/provider.ts` 能把失败归因到具体账号并冷却它。
         */
        async resolveCredential(_route: string) {
          const credential = await requireCredential()
          return {
            material: credential.material,
            ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
          }
        },
      }
    },
  }
}

// ── 测试/CLI 需要的再导出（barrel 从这里取） ──────────────────────────────
export {
  DEFAULT_RACCOON_BASE_URL,
  DEFAULT_RACCOON_CATALOG_TTL_MS,
  DEFAULT_RACCOON_CLIENT_VERSION,
  DEFAULT_RACCOON_CREDITS_TTL_MS,
  DEFAULT_RACCOON_POINTS_URL,
  RACCOON_API,
  RACCOON_COMPAT,
  RACCOON_DISPLAY_NAME,
  RACCOON_PROVIDER_ID,
  RACCOON_VENDOR_NAME,
} from './constants.js'
export { createRaccoonChatDriver, prepareRaccoonHeaders, raccoonDisplayName, toPiModel } from './provider.js'
export { RACCOON_CREDIT_FIELDS, toCreditsView } from './credits.js'
export { readDeviceId, resetDeviceIdCache } from './device.js'
export { DESKTOP_ACCOUNT_ID } from '../../core/accounts.js'

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
  POOL_COOLING_CODE,
  classifyUnavailable,
  createAccountPool,
  createDesktopBench,
  isPermanentFailure,
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
import { applyZeroPoints, createCreditsStore } from '../../core/credits.js'
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
import {
  RACCOON_CREDIT_FIELDS,
  fetchBalance,
  fetchBills,
  fetchSettingPoints,
  settingInfoUrl,
  toCreditsView,
  wwwPointsUrl,
} from './credits.js'
import {
  DEFAULT_RACCOON_BASE_URL,
  DEFAULT_RACCOON_CATALOG_TTL_MS,
  DEFAULT_RACCOON_CLIENT_VERSION,
  DEFAULT_RACCOON_CREDITS_TTL_MS,
  DEFAULT_RACCOON_NATION_CODE,
  DEFAULT_RACCOON_POINTS_URL,
  RACCOON_CLIENT_NAME,
  RACCOON_DISPLAY_NAME,
  RACCOON_PROVIDER_ID,
  RACCOON_VENDOR_NAME,
} from './constants.js'
import { readDeviceId } from './device.js'
import { readRaccoonAppVersion } from './app-version.js'
import { safeErrorMessage, formatDateTime } from '../../shared/text.js'
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
  /**
   * 每个账号同时打到上游的请求数上限。官方桌面客户端自限 2 路
   * （asar `main.cjs` `upstreams.size >= 2 → 429`），照抄这个形态。
   */
  concurrency: 2,
} as const

/**
 * 配置页的分组（由供应商声明，core 只按它归位）。
 */
export const RACCOON_CONFIG_GROUPS: ConfigGroupDeclaration[] = [
  { id: 'connection', labelKey: 'config.group.connection', keys: ['enabled', 'baseURL', 'pointsURL', 'clientVersion', 'orgCode', 'nationCode'] },
  { id: 'cache', labelKey: 'config.group.cache', keys: ['catalogTtlMs', 'creditsTtlMs'] },
  { id: 'limits', labelKey: 'config.group.limits', keys: ['concurrency'] },
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
  concurrency: z.natural().default(RACCOON_CONFIG_DEFAULTS.concurrency).description('每个账号同时打到上游的请求数上限（官方客户端形态是 2；0 = 不限）'),
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
  /** 本次调用要带的设备标识（逐账号）；缺省就不带头。 */
  deviceId?: string
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
   * 有登录态，但**整个账号池都在限流/额度冷却里**。
   *
   * 与 `missing` 的分工：`missing` 说"这个账号坏了，去修"；`cooling` 说"账号是
   * 好的，但现在不能花"。`resolveCredential` 会把它变成可执行的调用失败；
   * `credentials.read()`（选择器/卡片可见性）会退回无池路径回答"有没有登录"，
   * 避免冷却期间把整组模型从选择器里摘掉。
   */
  | { kind: 'cooling'; problem: string; candidates: CredentialCandidate[] }

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
      const numberSetting = (key: 'catalogTtlMs' | 'creditsTtlMs' | 'concurrency'): number => {
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
      /**
       * `X-Client-Version`：用户配置优先；没配置就读本机安装的客户端真实版本
       * （app.asar → package.json），再读不到才落回常量兜底。版本号是风控给
       * 流量归档的特征之一——发一个全网没人发的 `2.0.0` 等于自报家门。
       */
      const clientVersion = (): string => {
        const raw = rawSetting('clientVersion')
        if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
        return readRaccoonAppVersion() ?? DEFAULT_RACCOON_CLIENT_VERSION
      }
      const orgCode = (): string | undefined => {
        const value = stringSetting('orgCode')
        return value.length === 0 ? undefined : value
      }
      const encryptor = (): PhoneEncryptor => options.phoneEncryptor ?? encryptRaccoonPhone
      /** 桌面端那份 device id（安装时生成一次）；仅作兜底。 */
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
      /** 桌面令牌的内存 bench（core 共享实现：不能持久化，但必须记着）。 */
      const desktopBench = createDesktopBench({ now })

      const desktopSnapshot = (): RaccoonAuthSnapshot => readAuth()

      /** 桌面端身份，作为池成员；过期/冷却中时**不出现**。 */
      const desktopAccount = async (): Promise<StoredAccount | undefined> => {
        /*
         * 桌面令牌被 401 之后不该"等十分钟再试"：它只会在客户端重新登录时才变。
         * 所以永久失效的标记同样适用冷却豁免（`permanent`）；限流走与存储账号
         * 相同的指数窗口，连续命中自动加长。窗口在失败那一刻定死，检查只做比较。
         */
        if (desktopBench.status(DESKTOP_ACCOUNT_ID).benched) return undefined
        const snapshot = desktopSnapshot()
        if (!snapshot.found || snapshot.token === undefined) return undefined
        if (snapshot.expired === true) return undefined
        return {
          id: DESKTOP_ACCOUNT_ID,
          material: snapshot.token,
          origin: 'desktop',
          label: DESKTOP_LABEL,
          ...(deviceId() === undefined ? {} : { deviceId: deviceId() as string }),
        }
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
            const verdict = desktopBench.markUnavailable(id, code, message)
            deps.logger.info(`dsh-connect-desktop: raccoon 桌面端登录态被暂停使用（${code}：${message}）`)
            return verdict
          }
          return await store.markUnavailable(id, code, message)
        },

        markHealthy: async (id) => {
          if (id === DESKTOP_ACCOUNT_ID) {
            desktopBench.markHealthy(id)
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
      /**
       * 这个账号该带哪个设备标识。
       *
       * 插件账号用自己的 uuid（`core/accounts.ts` 在落盘时生成）；桌面端身份用
       * 客户端安装时生成的那一份。读不到（没装客户端）就不带头——与官方客户端
       * 缺文件时的行为一致。
       */
      const deviceIdFor = (account: StoredAccount | undefined): string | undefined => {
        // 没有账号上下文（聚合读取）：用桌面端那份。
        if (account === undefined) return deviceId()
        // 桌面端身份：它本来就是客户端那份。
        if (account.origin === 'desktop') return deviceId()
        /*
         * 插件账号：只用自己的 uuid。还没补上（`list()` 迁移之前）就**不带头**，
         * 绝不回退桌面端那份——九个账号共用一个设备指纹正是 2026-11-23 `200108`
         * 的画像，回退等于把要拆的东西又黏回去。
         */
        return account.deviceId
      }

      const fromStored = (account: StoredAccount): PickResult => {
        const device = deviceIdFor(account)
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
              ...(device === undefined ? {} : { deviceId: device }),
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
            ...(device === undefined ? {} : { deviceId: device }),
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

      /**
       * 轮换关闭时，锁定的那个账号也照样尊重"暂停"。
       *
       * `pickWithoutPool` 不能改：它同时回答"现在有没有登录"（选择器分组、
       * 卡片上的已登录状态都靠它），把冷却塞进去会让整池冷却变成"签出"。
       * 所以暂停只拦**调用侧**——这条链是 `requireCredential`，那里要的是
       * 一句能执行的话，而不是又一次注定失败的上游往返。
       *
       * 额度不足与限流分开说：前者要用户充值/等每日额度，后者等窗口，登录失效
       * 才该去重新登录。三种状态在界面上共用一句话是旧毛病。
       */
      const pausedPick = async (picked: PickResult): Promise<PickResult> => {
        if (picked.kind !== 'credential') return picked
        const id = picked.credential.accountId
        if (id === undefined) return picked
        const account = id === DESKTOP_ACCOUNT_ID ? await desktopAccount() : await store.find(id)
        if (account === undefined || !pool.isBenched(account)) return picked
        const kind = classifyUnavailable(account.unavailableCode, account.unavailableMessage)
        if (kind === 'auth') {
          return {
            kind: 'missing',
            problem:
              `当前锁定的小浣熊账号登录态已失效（${account.label ?? account.phone ?? account.id}），` +
              `请重新登录后再试，或在账户页换一个账号。`,
            candidates: authCandidateStates(),
          }
        }
        const when =
          account.unavailableUntil === undefined ? '' : `（最早 ${formatDateTime(account.unavailableUntil)} 自动恢复）`
        return {
          kind: 'cooling',
          problem:
            kind === 'points'
              ? `当前锁定的小浣熊账号额度不足，已暂停使用${when}。充值或每日额度刷新后会自动回到轮换；也可以换一个账号。`
              : `当前锁定的小浣熊账号正在限流冷却中${when}。等待恢复，或在账户页减少并发后重试。`,
          candidates: authCandidateStates(),
        }
      }

      const pickCredential = async (): Promise<PickResult> => {
        if (await preferences.poolEnabled()) {
          const pick = await pool.pick()
          if (pick.kind === 'ok') return fromStored(pick.account)
          if (pick.kind === 'none-healthy' && pick.accounts.length > 0) {
            /*
             * 全部被禁时**停止调用**，不再把"最久没失败"的账号送上去。
             *
             * 旧实现：全池冷却也照样硬发一次——2026-11-23 的实况是 8 个账号
             * 连环吃 `200108`（账号级风控），每多打一次就把限制确认一遍、
             * 阶梯窗口再升一级。现在：有可恢复账号就说清"最早几点回来"，
             * 全是永久失效才给"去重新登录"的指引。
             */
            if (pick.recoverable.length > 0) {
              const when =
                pick.recoverAt !== null
                  ? `（最早 ${formatDateTime(pick.recoverAt)} 自动恢复）`
                  : ''
              const who = pick.recoverable
                .slice(0, 3)
                .map((account) => account.label ?? account.phone ?? account.id)
                .join('、')
              const more = pick.recoverable.length > 3 ? ` 等 ${pick.recoverable.length} 个账号` : ''
              return {
                kind: 'cooling',
                problem:
                  `小浣熊的 ${who}${more} 都被上游限流/额度限制，暂时全部冷却中${when}。` +
                  `已停止调用以避免加深风控限制；等待恢复、或在账户页减少并发/换模型后重试。`,
                candidates: authCandidateStates(),
              }
            }
            /*
             * 剩下的全是永久失效：不猜、不重试，直接把"该去哪儿修"说出来。
             * 这里报 `missing` 而不是静默失败，是因为调用方需要的是可执行的一句话。
             */
            return {
              kind: 'missing',
              problem:
                `账号池里的 ${pick.permanent.length} 个小浣熊账号登录态都已失效（401/密钥无效）。` +
                `请在「商汤小浣熊」客户端里重新登录，然后在账户页重新添加/导入这个账号。`,
              candidates: authCandidateStates(),
            }
          }
        }

        // 轮换关闭 / 池里没有候选：兜底身份也要过一遍暂停检查。
        return await pausedPick(await pickWithoutPool())
      }

      /**
       * 不看池（或池没有候选）时的兜底身份：偏好选中的账号 → 桌面 `auth.json`。
       *
       * `credentials.read()` 在"全池冷却"时用它回答"有没有登录"，让选择器里的
       * 分组保持可见（调用侧仍由 `resolveCredential` 说"现在不能花"）；
       * `login.state()`/`logout()` 用它回答"现在这个登录态是谁"。
       */
      const pickWithoutPool = async (): Promise<PickResult> => {
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
            ...(deviceId() === undefined ? {} : { deviceId: deviceId() as string }),
            ...(identity === undefined ? {} : { identity }),
            ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
          },
        }
      }

      const requireCredential = async (): Promise<ResolvedPick> => {
        const picked = await pickCredential()
        if (picked.kind === 'credential') return picked.credential
        if (picked.kind === 'cooling') {
          // 冷却 ≠ 凭据缺失：code 说"登录是好的，但现在整池不能花"。
          // POOL_COOLING 不在任何可重试清单里——重试只会重读同一个冷却状态。
          throw new LlmError(picked.problem, POOL_COOLING_CODE)
        }
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
          let picked = await pickCredential()
          /*
           * 全池冷却 ≠ 签出。可见性（选择器分组、卡片"已登录"）按
           * `pickWithoutPool` 回答——有登录态就报已登录；调用侧的真实约束由
           * `resolveCredential` 的冷却错误说明。没有可退的身份，冷却原因才
           * 作为"签出"的原因展示。
           */
          if (picked.kind === 'cooling') {
            const fallback = await pickWithoutPool()
            if (fallback.kind === 'credential' || fallback.kind === 'expired') picked = fallback
          }
          const candidates = picked.kind === 'missing' || picked.kind === 'cooling' ? picked.candidates : authCandidateStates()
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
          return fetchCatalog({
            baseURL: baseURL(),
            token: credential.material,
            ...(orgCode() === undefined ? {} : { orgCode: orgCode() }),
            clientVersion: clientVersion(),
            ...(credential.deviceId === undefined ? {} : { deviceId: credential.deviceId }),
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
      /**
       * 余额的候选地址，按尝试顺序。
       *
       * 默认配置（裸域）下**先 `www.` 再裸域**：裸域 `points/v1/balance` 已被
       * 网关整条拦死（403 + `X-TT-System-Error: 3`，拦在鉴权之前），`www.` 同一
       * 路径 200。用户自己改过 `pointsURL` 时，尊重他写的地址优先，`www.` 只作兜底。
       */
      const balanceUrls = (): string[] => {
        const configured = pointsURL()
        const www = wwwPointsUrl(configured)
        if (www === configured) return [configured]
        return configured === DEFAULT_RACCOON_POINTS_URL ? [www, configured] : [configured, www]
      }

      const readBalance = async (token: string, device?: string) => {
        const identity = device ?? deviceId()
        let lastError: unknown
        for (const url of balanceUrls()) {
          try {
            return await fetchBalance({
              token,
              pointsURL: url,
              ...(orgCode() === undefined ? {} : { orgCode: orgCode() }),
              clientVersion: clientVersion(),
              ...(identity === undefined ? {} : { deviceId: identity }),
              now,
            })
          } catch (error) {
            // 403（路由被关）与网络失败都换下一个 origin，别让一次封锁抹掉余额。
            lastError = error
          }
        }
        throw lastError ?? new Error('小浣熊积分接口没有可用的地址')
      }

      /**
       * 余额 + 明细。
       *
       * 明细（`/points/v2/bills`）是**附加**信息：它失败不该让余额也消失，所以先拿
       * 余额（失败必须抛，否则会把"读不到"伪装成"零余额"），再尽力取第一页账单。
       * 只取一页：游标翻页会把一次只读查询变成 N 次上游请求，而卡片只需要"最近几笔"。
       */
      const readCreditsView = async (
        token: string,
        options: { withLedger?: boolean; deviceId?: string } = {},
      ) => {
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
          view = toCreditsView(await readBalance(token, options.deviceId))
        } catch (error) {
          balanceError = error
        }

        /*
         * 余额桶读不到时，先试**设置摘要**里的可用积分。
         *
         * 实测（2026-11-23）：`points/v1/balance` 对被插件用过的账号返回 403
         * 空 body（nginx `X-TT-System-Error: 3`），而**同一个 token** 打
         * `office/v3/setting_info` 是 200 且带 `available_points`——官方客户端
         * 的缓存里正是这一条。拿到它，徽标与账号行就都还有数字，只是没有
         * daily/reward/topup 的拆分（标 `degraded`，由界面说明来源）。
         */
        if (view === undefined) {
          /*
           * 设置摘要同样按 `[www, 裸域]` 两条 origin 试——裸域 `points` 路由被封锁
           * 时，同一套网关策略可能波及别的路径；而 www 上这两条都是 200。
           */
          const settingUrls = [...new Set([settingInfoUrl(baseURL()), wwwPointsUrl(settingInfoUrl(baseURL()))])]
          for (const url of settingUrls) {
            try {
              const points = await fetchSettingPoints({
                token,
                url,
                ...(orgCode() === undefined ? {} : { orgCode: orgCode() }),
                clientVersion: clientVersion(),
                ...(deviceId() === undefined ? {} : { deviceId: deviceId() }),
                now,
              })
              view = {
                fields: { available: points.available },
                fetchedAt: points.at,
                degraded: 'setting_info',
              }
              break
            } catch {
              // 这个 origin 也不通：换下一个，最后由"仅明细"那条路决定报什么。
            }
          }
        }

        // 逐账号读取**不**取明细：那是 N 倍的账单请求，而明细只需要在总额层面
        // 展示一次（同一批对话本来就分散在多个账号上，逐账号翻页没有意义，还会
        // 因为请求太密被上游限流）。
        if (options.withLedger !== true) {
          if (view !== undefined) return view
          throw balanceError
        }

        const device = options.deviceId ?? deviceId()
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
              partialReason: safeErrorMessage(balanceError),
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
        load: async () => {
          const credential = await requireCredential()
          return readCreditsView(credential.material, {
            withLedger: true,
            ...(credential.deviceId === undefined ? {} : { deviceId: credential.deviceId }),
          })
        },
        loadForAccount: async (account) => {
          if (account.material.length === 0) throw new Error('该账号没有可用的登录态')
          try {
            const device = deviceIdFor(account)
            return await readCreditsView(account.material, device === undefined ? {} : { deviceId: device })
          } catch (error) {
            /*
             * 积分接口的 401 和聊天接口的 401 是同一件事：这把 token 已经无效。
             * 把它记进账号状态，池就不会再挑它去烧一次必然失败的调用，抽屉里也
             * 会从"轮换已跳过"变成"登录已失效"——那才是用户能执行的那句话。
             *
             * 只对 auth 类这么做：限流、网关 403 都不代表账号坏了，那些账号
             * 冷却之后还得回来。
             */
            const message = safeErrorMessage(error)
            if (isPermanentFailure(undefined, message)) {
              await accounts.markUnavailable(account.id, 'CREDENTIAL_INVALID', message).catch(() => undefined)
            }
            throw error
          }
        },
        ttlMs: () => numberSetting('creditsTtlMs'),
        now,
        /*
         * 零余额就暂停这个账号——与 Loomy 同一条规则（`core/credits.ts#applyZeroPoints`）。
         *
         * 这条钩子以前**没接**：小浣熊的零余额账号只能等真正打一次聊天、被上游
         * 回一句 `积分不足` 才进冷却，等于每次都先烧掉一次失败调用。余额桶读数
         * 就在手上（`available_points`），没有理由不用它。
         *
         * 余额桶被限流（`partial: 'balance_unavailable'`）时 `fields` 是空的，
         * helper 会原样跳过——"读不到"不是"没钱"。
         */
        onRead: (view, account) => applyZeroPoints(view, account, accounts),
      })

      // ── 登录（协议在 auth-flow.ts） ──────────────────────────────────────
      const login: LoginDriver = {
        async state(): Promise<AuthStateView> {
          // 登录状态页回答"现在这个登录态是谁"：不看池的冷却，看真实的身份来源。
          const picked = await pickWithoutPool()
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
          let picked = await pickCredential()
          if (picked.kind === 'cooling') {
            const fallback = await pickWithoutPool()
            if (fallback.kind === 'credential' || fallback.kind === 'expired') picked = fallback
          }
          if (picked.kind === 'missing' || picked.kind === 'cooling') {
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

      const chat = createRaccoonChatDriver({
        clientVersion,
        // 本次调用所选账号自己的设备标识优先；没有账号上下文才用桌面端那份。
        deviceId: (context) => context?.deviceId ?? deviceId(),
      })

      return {
        descriptor: RACCOON_DESCRIPTOR,
        /**
         * 每账号并发上限：官方桌面客户端自限 2 路，照抄。
         *
         * 0（或负）表示不限。改了设置下一次调用就生效——闸门每次取号都现读。
         */
        concurrency: () => numberSetting('concurrency'),
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
          const probeDevice = picked.credential.deviceId
          const [catalog, balance] = await Promise.all([
            (async () => {
              try {
                const models = await fetchCatalog({
                  baseURL: baseURL(),
                  token: material,
                  ...(orgCode() === undefined ? {} : { orgCode: orgCode() as string }),
                  clientVersion: clientVersion(),
                  ...(probeDevice === undefined ? {} : { deviceId: probeDevice }),
                })
                return { path: 'catalog', ok: true, reason: `ok（${models.length} 个模型）` }
              } catch (error) {
                return { path: 'catalog', ok: false, reason: safeErrorMessage(error) }
              }
            })(),
            (async () => {
              try {
                /*
                 * 走与真实读取**同一条**候选链（www → 裸域）。早先这里直接打配置里
                 * 的裸域，于是余额其实读得到的时候，诊断页照样报 403——探针必须复用
                 * 生产路径，否则它测的是另一个东西。
                 */
                const value = await readBalance(material, probeDevice)
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
            ...(credential.deviceId === undefined ? {} : { deviceId: credential.deviceId }),
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

/**
 * Cross-half, credential-free value types.
 *
 * Everything here is vendor-neutral and safe to serialise to the browser:
 * **no session token** ever crosses this boundary. Account facts (phone, user id)
 * are shown as-is — the product decision is that a local settings card must let
 * the user verify which account they are on; masking is kept for logs and
 * upstream error text (`shared/text.ts#maskPhone`). Vendor modules must map
 * their protocol into these shapes — never add a vendor-named field here,
 * because the client renders mechanically from this contract.
 *
 * If you are adding a vendor and feel the need to extend a view: extend the
 * capability declaration instead. See `vendor-sdk/contracts.ts`.
 *
 * @module dsh-connect-desktop/shared/views
 */

/** Route prefix every host route hangs off. One prefix for every vendor. */
export const ROUTE_PREFIX = '/plugins/dsh-connect-desktop'

/** Plugin-level route: every vendor's status, one request. */
export const STATUS_ROUTE = `${ROUTE_PREFIX}/status`

/** Per-vendor route builder: `/plugins/dsh-connect-desktop/<vendorId>/<suffix>`. */
export function vendorRoute(vendorId: string, suffix: string): string {
  return `${ROUTE_PREFIX}/${vendorId}/${suffix}`
}

// ── Capability declaration (the thing that drives routes AND the UI) ────────

/** How many identities a vendor can hold. */
export type AccountsMode = 'multi' | 'single' | 'none'

/** Login methods a vendor supports; `none` means "borrow the desktop session". */
export type LoginMethod = 'sms-code' | 'password' | 'none'

/** One numeric bucket of a vendor's balance, rendered by the generic grid. */
export interface CreditField {
  /** Stable key inside `CreditsView.fields`. */
  key: string
  /** Locale key for the bucket label. */
  labelKey: string
  /** Visual role; `available` is the headline figure. */
  role: 'available' | 'today' | 'total' | 'other'
}

/** The balance shape a vendor reports. */
export type CreditsCapability =
  | { kind: 'none' }
  /** 只有流水，没有余额桶。 */
  | { kind: 'ledger' }
  /**
   * 余额桶；`ledger: true` 表示这张表还附带流水明细。
   *
   * 两者可以同时存在：Loomy 有 3 个桶**和** `/points/records` 流水。把"有流水"
   * 单独做成一个 flag，是因为上一版把它当成 `kind` 的互斥取值，于是"有余额且有流水"
   * 的供应商只能二选一，流水就这样从卡片上消失了。
   */
  | { kind: 'balance'; fields: readonly CreditField[]; ledger?: boolean }

/** Everything the UI and the route planner need to know about a vendor. */
export interface VendorCapabilities {
  accounts: AccountsMode
  /** Automatic rotation over several accounts is offered. */
  pool: boolean
  login: readonly LoginMethod[]
  credits: CreditsCapability
  catalog: {
    /** `/refresh` + `/save` exist and the models tab lists the catalog. */
    selection: boolean
    /** Per-model vision override lists in config. */
    visionOverride: boolean
    /** Upstream reasoning-effort selection is meaningful. */
    reasoningEffort: boolean
  }
  /** `/accounts/export` + `/accounts/import` exist. */
  transfer: boolean
  /** The desktop identity can be adopted into a stored account. */
  adopt: boolean
  /** `/diagnostics` exists. */
  diagnostics: boolean
}

// ── Shared value shapes ────────────────────────────────────────────────────

/** One upstream failure, recorded verbatim apart from secret redaction. */
export interface UpstreamErrorView {
  at: number
  path: string
  code: string
  message: string
  traceId?: string
}

/** Unified error envelope used by every route and by the CLI's `--json` output. */
export interface FailureView {
  ok: false
  error: { code: string; message: string }
}

/** One normalised upstream chat model. */
export interface CatalogModel {
  id: string
  name: string
  multiplier: number
  contextWindow: number
  maxOutput: number
  vision: boolean
  efforts: string[]
  defaultEffort: string
}

/** A catalog entry with the saved selection merged in. */
export interface CatalogModelView extends CatalogModel {
  enabled: boolean
}

/** One points ledger row. */
export interface CreditRecordView {
  description: string
  direction: 'credit' | 'debit'
  pointsActual: number
  createdAt: number
  model?: string
  /** 这笔之后的余额。供应商不返回时省略（Raccoon 的账单接口就没有）。 */
  balanceAfter?: number
  source?: { route: string; account?: string; accountId?: string }
}

/** One account's own figures, as the card shows it per row. */
export interface CreditsAccountView {
  accountId?: string
  route: string
  account?: string
  fields: Record<string, number>
  /** Set when this account could not be read; the others still render. */
  error?: string
}

/** Read-only points overview, keyed by the capability's field list. */
export interface CreditsView {
  /** Numbers keyed by `CreditsCapability.fields[].key`. */
  fields: Record<string, number>
  fetchedAt: number
  records?: CreditRecordView[]
  perAccount?: CreditsAccountView[]
  /**
   * 部分数据缺失时的原因标签（例如余额接口被限流但明细可用）。
   *
   * 与其把整块报错、连能拿到的明细一起丢掉，不如如实说明缺了什么：
   * UI 会在明细上方显示一句"余额暂时读不到"。
   */
  partial?: 'balance_unavailable'
}

/** One account row in the settings card (never carries a session). */
export interface AccountRowView {
  id: string
  /** Provider route this account is reachable as; per-vendor naming. */
  route: string
  displayName: string
  label?: string
  phone?: string
  userId?: string
  origin: 'plugin' | 'desktop'
  addedAt?: number
  /** True while the pool skips it. */
  unavailable: boolean
  unavailableAt?: number
  unavailableCode?: string
  unavailableMessage?: string
}

/** `GET /<vendor>/accounts` */
export interface AccountsView {
  ok: true
  accounts: AccountRowView[]
  /** Which account a non-rotating route uses. */
  activeId?: string
  rotating: boolean
  /** 最近一次推理调用实际使用的账号（轮换时唯一可信的"刚花了谁的钱"）。 */
  lastUsedId?: string
  lastUsedAt?: number
}

/** `GET/POST /<vendor>/pool` */
export interface PoolStateView {
  ok: true
  enabled: boolean
  active: boolean
  total: number
  healthy: number
}

/** `GET /<vendor>/auth/state` */
export interface AuthStateView {
  ok: true
  /** The plugin holds its own login (not borrowed from the desktop client). */
  pluginLoggedIn: boolean
  effectiveSource: 'plugin' | 'desktop' | 'env' | 'none'
  phone?: string
  userId?: string
  loginAt?: number
}

/** `POST /<vendor>/auth/send-code` */
export interface AuthSendCodeView {
  ok: true
  phone?: string
  resendAfterMs?: number
  expiresMs?: number
}

/** `POST /<vendor>/auth/login` */
export interface AuthLoginView {
  ok: true
  phone?: string
  userId?: string
}

/** `POST /<vendor>/auth/logout` */
export interface AuthLogoutView {
  ok: true
  message: string
}

/** `POST /<vendor>/accounts/export` — a portable bundle. **Contains sessions.** */
export interface AccountExportView {
  ok: true
  bundle: unknown
  sessionTtlDays?: number
}

/** `POST /<vendor>/accounts/import` */
export interface AccountImportView {
  ok: true
  added: number
  refreshed: number
  skipped: number
}

/** One credential candidate as reported by diagnostics. */
export interface CredentialCandidateView {
  path: string
  exists: boolean
  /** `ok`, `missing`, `unreadable`, `invalid_json`, `invalid_shape` or `encrypted`. */
  state: string
  /** Executable conclusion; never contains the session. */
  reason: string
}

/** Credential conclusion reported to the card. */
export interface CredentialView {
  found: boolean
  /** The path that actually parsed, or the first candidate to produce. */
  sourcePath: string
  /** Where the effective credential came from. */
  sourceOrigin: 'plugin' | 'desktop' | 'env' | 'none'
  /** Actionable explanation while signed out. */
  problem?: string
  expiresAt?: number
  expired?: boolean
  candidates: CredentialCandidateView[]
}

/** 当前登录身份。手机号/用户 id 原样展示（本地数据，用户要能核对）。 */
export interface AccountView {
  route?: string
  label?: string
  phone?: string
  userId?: string
  orgName?: string
  loginAt?: number
}

/** One vendor's answer inside `GET /status`. */
export interface VendorStatusView {
  id: string
  displayName: string
  capabilities: VendorCapabilities
  /** Brand accent for the card's chrome. */
  accent: string
  /**
   * True when this vendor should be visible at all: enabled in config, a
   * credential was found and it is not expired. The card hides the tab when
   * false, which is what makes "no client installed → no group" true for the
   * settings card as well as the model selector.
   */
  available: boolean
  /** Why it is unavailable, when it is. */
  unavailableReason?: string
  credential: CredentialView
  account: AccountView | null
  catalog: { total: number; enabled: number; refreshedAt: number | null }
  enabledModelIds: string[]
  /**
   * provider 路由的注册状态。
   *
   * "已登录但模型选择器里没有这一组"是最难从外部判断的症状：凭据、目录、路由都正常，
   * 唯独 provider 没注册。把这个状态放进 `/status`，一次请求就能定位到底卡在哪。
   */
  provider?: {
    registered: boolean
    routes: string[]
    /** 上一次注册尝试的失败原因（如果是被拒绝的）。 */
    error?: string
  }
  nextSteps?: string[]
  lastError?: UpstreamErrorView
}

/** `GET /status` payload: every vendor, one request. */
export interface StatusView {
  ok: true
  csrfToken: string
  vendors: VendorStatusView[]
  /**
   * 诊断：本进程里本插件被挂载了几次，以及当前实例的 id。
   *
   * `applyCount > 1` 就是"同一个进程挂了两份"的确诊 —— 那时两份会争夺
   * `loomy`/`raccoon` 这两个 provider 名字，后到的那份永远注册不上。
   */
  instance?: { id: string; applyCount: number }
}

/** 一个可编辑的配置字段。 */
export interface ConfigFieldView {
  key: string
  /** `boolean` / `number` / `string` / `string[]` —— 决定控件形态。 */
  type: 'boolean' | 'number' | 'string' | 'string-list'
  /** 当前生效值（用户覆盖或默认）。 */
  value: unknown
  /** 声明的默认值，用于「恢复默认」。 */
  default: unknown
  /** 用户在 profile 里显式写过这一项。 */
  overridden: boolean
  /** 字段说明（来自 schema 的 description）。 */
  description?: string
  /** 分组 id（descriptor 声明的）；缺省表示不分组，排在最后。 */
  group?: string
}

/** `GET /<vendor>/config` —— 这家供应商的配置片。 */
export interface VendorConfigView {
  vendorId: string
  fields: ConfigFieldView[]
  /**
   * 这份配置读出来时的版本号。
   *
   * 保存时原样带回去：宿主用它做乐观锁。没有它，两个窗口同时改配置时后写的
   * 会静默覆盖先写的，而失败者完全不知道自己写的还在不在。
   */
  revision?: number
  /** 分组声明（顺序即展示顺序）；字段用 `group` 指向这里。 */
  groups?: Array<{ id: string; labelKey: string }>
}

/** `GET /<vendor>/diagnostics` probe row. */
export interface DiagnosticsProbe {
  path: string
  ok: boolean
  /** Upstream `desc`/`message` verbatim, or the local transport reason. */
  reason: string
}

/** `GET /<vendor>/diagnostics` payload. */
export interface VendorDiagnosticsView {
  ok: true
  id: string
  displayName: string
  baseUrl: string
  endpoints: Array<{ label: string; url: string }>
  credential: CredentialView
  /** 当前有效身份（已脱敏），排障时"是谁的会话"比路径更重要。 */
  account: AccountView | null
  /** 供应商会查阅的**全部**候选路径（含本次未走到的那几个）。 */
  inspected: string[]
  probes: DiagnosticsProbe[]
  catalog: { total: number; enabled: number; refreshedAt: number | null }
  accounts: { total: number; healthy: number } | null
  lastError?: UpstreamErrorView
}

/** `POST /<vendor>/refresh` */
export interface RefreshView {
  ok: true
  catalog: CatalogModelView[]
  refreshedAt: number
}

/** `POST /<vendor>/save` */
export interface SaveView {
  ok: true
  enabled: string[]
}

/** Default TTLs every vendor module may override. */
export const DEFAULT_SESSION_TTL_MS = 5_000
export const DEFAULT_CATALOG_TTL_MS = 600_000
export const DEFAULT_CREDITS_TTL_MS = 60_000

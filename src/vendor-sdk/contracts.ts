/**
 * The vendor contract.
 *
 * One vendor = one `VendorModule`: a descriptor (frozen identity + capability
 * declaration) and a `create()` that returns primitives. Everything else —
 * route planning, HTTP guards, caches, pool accounting, the pi-ai adapter, the
 * settings card — is implemented **once** in `src/core` and `src/client`, and
 * is driven by the capability declaration.
 *
 * Rules a vendor must never break:
 *
 * 1. No vendor-specific branch anywhere outside `src/vendors/<id>/`.
 * 2. Declare a capability only if the matching driver method exists — enforced
 *    at mount time by `assertRuntime()`.
 * 3. `descriptor.id` is frozen forever: it enters the pi-ai model identity
 *    (`provider` + `api` + model `id`) persisted on every assistant message.
 * 4. Never return a credential in a view. `read()` is the only place the
 *    material exists, and it never leaves the host.
 *
 * @module dsh-connect-desktop/vendor-sdk/contracts
 */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentAccess, LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiRequestHeaderContext, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import type {
  AccountImportView,
  AccountRowView,
  AccountsView,
  AccountView,
  AuthLoginView,
  AuthLogoutView,
  AuthSendCodeView,
  AuthStateView,
  CatalogModel,
  CreditsView,
  CredentialView,
  DiagnosticsProbe,
  PoolStateView,
  VendorCapabilities,
  VendorStatusView,
} from '../shared/views.js'

/**
 * The frozen identity of a vendor.
 *
 * `id` is part of the model identity persisted on every assistant message, so
 * it can never be renamed. Everything else may change.
 */
export interface VendorDescriptor {
  readonly id: string
  readonly displayName: string
  readonly capabilities: VendorCapabilities
  /** Brand accent used by the card's chrome. */
  readonly accent: string
  /**
   * When the provider routes exist.
   *
   * - `'always'` — as soon as the vendor is enabled (the picker always shows it,
   *   even signed out; failures are explained on the first call);
   * - `'signed-in'` — only while a usable credential exists, so a machine
   *   without that desktop client never sees the group at all.
   */
  readonly providerVisibility?: 'always' | 'signed-in'
  /** Vendor-owned config slice; the core only namespaces and migrates it. */
  readonly config: {
    /** Schemastery object schema for this vendor's slice (opaque to the core). */
    readonly schema: unknown
    readonly defaults: Record<string, unknown>
    /**
     * 配置页的分组。**由供应商声明**，core 只按它归位。
     *
     * 为什么不让 core 猜（例如按 `*TtlMs` 归到"缓存"）：那要写进 `creditsPageSize`
     * 这种供应商字面量，而 core 里出现供应商字段名，正是架构门禁要拦的东西。
     * 声明式还有一个好处：字段增删时分组跟着 schema 走，不会漂移。
     */
    readonly groups?: readonly ConfigGroupDeclaration[]
  }
}

// ── Credentials ────────────────────────────────────────────────────────────

/** Where the effective credential came from. */
export type CredentialOrigin = 'plugin' | 'desktop' | 'env'

/** 身份展示数据（本地数据，不脱敏）。 */
export interface CredentialIdentity {
  label?: string
  phone?: string
  userId?: string
  orgName?: string
  loginAt?: number
}

/**
 * One credential read.
 *
 * A union rather than an optional-field bag: "signed out" and "signed in" carry
 * different facts, and a vendor that forgets the `problem` string cannot compile
 * its way past a user staring at an empty tab.
 */
export type CredentialState =
  | {
      found: false
      /** Actionable explanation; rendered verbatim. */
      problem: string
      candidates: readonly CredentialCandidate[]
    }
  | {
      found: true
      /** The token/session. Never serialised, never returned to the browser. */
      material: string
      sourcePath: string
      sourceOrigin: CredentialOrigin
      /** Stored-account id this credential belongs to, when it came from one. */
      accountId?: string
      /** Upstream expiry, when the vendor can parse one. */
      expiresAt?: number
      expired?: boolean
      identity?: CredentialIdentity
      candidates: readonly CredentialCandidate[]
    }

/** One place the vendor looked, for diagnostics. */
export interface CredentialCandidate {
  path: string
  exists: boolean
  state: string
  reason: string
}

export interface CredentialDriver {
  /** Read the effective credential. Must never throw for "signed out". */
  read(options?: { force?: boolean }): Promise<CredentialState>
  /** Drop any memoised read (after a login, a settings save or 「重新检测」). */
  invalidate(): void
  /**
   * Every路径 the vendor consults, in precedence order.
   *
   * 与 `read()` 返回的 `candidates` 不同：后者只列出**这次真的被打开过**的条目
   * （前面的文件一旦解析成功，后面的就不再 stat），这里列出的是完整候选表。排障时
   * 用户问的往往是"你到底会不会看这个路径"，答案必须包含没被走到的那几个。
   */
  probePaths(): readonly string[]
}

// ── Accounts ───────────────────────────────────────────────────────────────

/** One persisted bench verdict: how long an account is out and when it returns. */
export interface AccountBenchVerdict {
  /** Cooldown window applied to this failure, in milliseconds. */
  cooldownMs: number
  /** Epoch ms when the account may be picked again. */
  recoverAt: number
}

/** What an account looks like to the generic surface. */
export interface StoredAccount {
  id: string
  /** Upstream/session material; only the chat driver and credits driver see it. */
  material: string
  label?: string
  phone?: string
  userId?: string
  origin: 'plugin' | 'desktop'
  addedAt?: number
  unavailableAt?: number
  /** Epoch ms when the bench ends; the window is pinned at failure time and persists. */
  unavailableUntil?: number
  unavailableCode?: string
  unavailableMessage?: string
  /**
   * 这台"客户端"为该账号生成的设备标识（uuid，与官方客户端
   * `desktop-device-identity.json` 的 `clientDeviceId` 同形）。
   *
   * 官方客户端一次安装生成一个；插件接管多个账号时，如果九个账号共用桌面端
   * 的那一个，风控看到的画像就是"同一台设备九个号并发调用"——2026-11-23 的
   * `200108` 连环限流正是这个形态。逐账号各给一个 uuid，把并发画像拆开。
   */
  deviceId?: string
}

export type AccountInput =
  | { kind: 'credentials'; material: string; label?: string; phone?: string; userId?: string }
  | { kind: 'desktop' }

export interface AccountDriver {
  list(options?: { force?: boolean }): Promise<StoredAccount[]>
  /** Which account a non-rotating vendor route must authenticate as. */
  active?(): Promise<string | undefined>
  setActive?(id: string | undefined): Promise<void>
  add(input: AccountInput): Promise<{ id: string; replaced: boolean }>
  remove(id: string): Promise<void>
  /**
   * Pool health writes; `core/pool.ts` calls these and nothing else does.
   *
   * May return the bench verdict the account actually received — the cooldown
   * window and when it ends — so callers can quote a recovery time. Rate-limit
   * benches grow the window exponentially and persist across restarts; vendors
   * that cannot persist return `undefined` and the pool falls back to its own
   * base window.
   */
  markUnavailable(id: string, code: string, message: string): Promise<AccountBenchVerdict | undefined>
  markHealthy(id: string): Promise<void>
  /** Provider route id for one account (`loomy-2`, `raccoon`, …). */
  routeOf(account: StoredAccount): string
  /** Display name shown by the model picker for that route. */
  displayNameOf(account: StoredAccount): string
  /** Only when `capabilities.accounts === 'multi'`. */
  rename?(id: string, label: string): Promise<void>
  /** 补全一个账号的身份字段（导入的账号只有 token）。 */
  update?(id: string, patch: { label?: string; phone?: string; userId?: string }): Promise<void>
  /**
   * 可选：把"只有 token、没有身份信息"的账号补全。
   *
   * 返回补全成功的条数。实现必须**永不抛错**（远端不可用不该让账号页打不开），
   * 并且要自己去重——同一个账号不该每次打开页面都重新查一遍。
   */
  enrichProfiles?(): Promise<number>
  /** Only when `capabilities.transfer`. */
  exportBundle?(): Promise<{ bundle: unknown; sessionTtlDays?: number }>
  importBundle?(document: unknown): Promise<{ added: number; refreshed: number; skipped: number }>
  /** Only when `capabilities.adopt`: turn the desktop sign-in into a row. */
  adopt?(): Promise<{ id: string; replaced: boolean }>
  /**
   * 回填缺失的账号身份，返回实际补上的条数。
   *
   * 为什么需要：手机号只存在于登录那一瞬间和上游的 `user_info` 里。早先的版本
   * 写入账号时没存它，那批账号就只能显示「账号 3」。供应商如果掌握查询途径就
   * 实现它，`POST /<vendor>/accounts/enrich` 会给用户一个一次性修复的按钮；
   * 不实现则路由返回 `unsupported`。
   */
  enrich?(): Promise<number>
}

// ── Catalog ────────────────────────────────────────────────────────────────

export interface CatalogSnapshot {
  models: CatalogModel[]
  refreshedAt: number | null
  source: 'memory' | 'cache' | 'upstream'
}

export interface CatalogDriver {
  /** Read the catalog, honouring the vendor's cache TTL unless `force`. */
  read(options?: { force?: boolean }): Promise<CatalogSnapshot>
  /** Last successful read, synchronously (the pi-ai `getModels` contract). */
  current(): CatalogModel[]
  /** Epoch ms of the last successful read, or `null`. */
  refreshedAt(): number | null
  /** Ids the user kept; `null` means "everything". */
  enabledIds(): string[]
  /** The models the picker should offer (selection + capability overrides). */
  enabledModels(): CatalogModel[]
  /** Persist a selection and re-filter the installed models. */
  saveSelection(ids: readonly string[]): Promise<string[]>
  /** Fire-and-forget refresh from the inference path. Never throws. */
  kickRefresh(): void
  /** Load any on-disk cache without touching the network. */
  hydrate(): Promise<void>
  lastError(): { at: number; path: string; code: string; message: string; traceId?: string } | undefined
  /** Endpoints for diagnostics. */
  endpoints(): ReadonlyArray<{ label: string; url: string }>
}

// ── Credits ────────────────────────────────────────────────────────────────

export type CreditsReadout =
  | { kind: 'ok'; credits: CreditsView }
  | { kind: 'failure'; failure: { at: number; path: string; code: string; message: string; traceId?: string } }

export interface CreditsDriver {
  read(options?: { force?: boolean }): Promise<CreditsReadout>
  /**
   * Per-account figures. The core merges them and tags every ledger row with
   * its source; a failing account must yield `error`, never throw.
   */
  readForAccount?(account: StoredAccount, options?: { force?: boolean }): Promise<CreditsReadout>
}

// ── Login (optional) ───────────────────────────────────────────────────────

/**
 * The plugin's own sign-in, offered only when `capabilities.login` is not
 * `['none']`. A vendor that borrows the desktop session omits this driver.
 */
export interface LoginDriver {
  state(): Promise<AuthStateView>
  sendCode(phone: string): Promise<AuthSendCodeView>
  login(input: { phone: string; code: string; password?: string; method: LoginMethodKind }): Promise<AuthLoginView>
  logout(): Promise<AuthLogoutView>
}

export type LoginMethodKind = 'sms-code' | 'password'

// ── Chat ───────────────────────────────────────────────────────────────────

/** Everything the generic pi-ai adapter needs from a vendor. */
/**
 * Add the vendor's identifying headers to one request.
 *
 * The third argument is the per-call account context the provider runtime
 * resolves just before headers are built (credential → headers in the same
 * async scope, so it is always populated for a call with an account). Vendors
 * use it to send a per-account device identity instead of one shared value.
 */
export interface VendorHeaderContext {
  accountId?: string
  deviceId?: string
}

export interface ChatDriver {
  /** Chat api id; must equal the value inside every model descriptor. */
  readonly api: 'openai-completions'
  readonly compat: OpenAICompletionsCompat
  /** Convert one catalog entry into a pi-ai model for `route`. */
  toModel(model: CatalogModel, context: { baseUrl: string; route: string }): Model<'openai-completions'>
  /** Add the vendor's identifying headers to one request. */
  prepareHeaders(request: PiAiRequestHeaderContext, headers: Headers, context?: VendorHeaderContext): Headers
  /** Credential display name, for the picker's "not configured" copy. */
  readonly credentialName?: string
  /**
   * Optional: re-classify a suspicious terminal failure. Loomy probes
   * `/user/identity` here to turn "stream ended without finish_reason" into an
   * executable "session expired"; vendors without that evidence omit it.
   */
  explainAmbiguousFailure?(): Promise<LlmError | undefined>
}

// ── Runtime ────────────────────────────────────────────────────────────────

/** One provider route a vendor offers. */
export interface RouteEntry {
  route: string
  displayName: string
}

/** The credential one call must authenticate as. */
export interface ResolvedCredential {
  material: string
  /** Stored-account id, for pool health attribution. */
  accountId?: string
  /** Executable message when signed out. */
  problem?: string
  /**
   * The device identity to send with this account (`X-Client-Device-ID`).
   *
   * Derived by the credential picker: stored accounts use their own uuid, the
   * desktop identity uses the client's `desktop-device-identity.json`. Absent
   * means "omit the header" — same as the official client when the file is
   * missing.
   */
  deviceId?: string
}


/** 配置页的一组字段。 */
export interface ConfigGroupDeclaration {
  /** 稳定 id；同时用作 `ConfigFieldView.group`。 */
  readonly id: string
  /** locale 键（供应商文案区）；缺省时直接用 id。 */
  readonly labelKey: string
  /** 属于这一组的字段名。不在任何组里的字段排到最后。 */
  readonly keys: readonly string[]
}

/** Preferences persisted in the vendor state document. */
export interface VendorPreferences {
  poolEnabled(): Promise<boolean>
  setPoolEnabled(enabled: boolean): Promise<void>
  activeAccountId(): Promise<string | undefined>
  setActiveAccountId(id: string | undefined): Promise<void>
}

/** Deps the core hands a vendor at construction time. */
export interface VendorDeps {
  readonly descriptor: VendorDescriptor
  /** This vendor's config slice, already unwrapped from `.volatile()`. */
  readonly config: Readonly<Record<string, unknown>>
  /** Read one config field live (a settings save must take effect at once). */
  readonly setting: <T>(key: string) => T
  /** `$DSH_HOME/storages/dsh-connect-desktop/<vendorId>/`. */
  readonly storageDir: string
  /** One JSON document in that directory, with atomic 0600 writes. */
  readonly document: <T>(name: string, options: DocumentOptions<T>) => DocumentStore<T>
  readonly logger: Logger
  readonly now: () => number
  /** Durable attachment service, resolved lazily (may mount later). */
  readonly attachments: () => AttachmentStore | undefined
  readonly imageAccess: (
    attachments: AttachmentStore,
    ref: ImageAttachmentRef,
  ) => ImageAttachmentAccess | undefined
  /** Tell the host to re-list this vendor's models. */
  readonly modelsUpdated: () => void
}

export interface Logger {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

export interface DocumentOptions<T> {
  /** Parse a document; anything unexpected must degrade, never throw. */
  parse(text: string): T
  /** Serialise deterministically for readable diffs. */
  serialize(value: T): string
  empty(): T
}

/** A small JSON document store (atomic write, 0600, serialised writes). */
export interface DocumentStore<T> {
  readonly path: string
  load(): Promise<T>
  save(value: T): Promise<void>
}

/** What a vendor module returns. */
export interface VendorRuntime {
  readonly descriptor: VendorDescriptor
  readonly credentials: CredentialDriver
  /** Pool/active-account preferences, backed by the vendor state document. */
  readonly preferences?: VendorPreferences
  readonly accounts?: AccountDriver
  readonly catalog?: CatalogDriver
  readonly credits?: CreditsDriver
  readonly login?: LoginDriver
  readonly chat: ChatDriver
  /** Provider routes this vendor offers right now, in picker order. */
  routes(): Promise<readonly RouteEntry[]>
  /**
   * The **single** place credential precedence is decided: which account pays
   * for `route`. Throws `LlmError` with `MISSING_CREDENTIAL` when signed out.
   */
  resolveCredential(route: string): Promise<ResolvedCredential>
  /**
   * 最近一次**成功**的推理调用用了哪个账号。
   *
   * 必须是"成功"，不能是"被选中"：一个账号被选中后调用失败会被 bench，若标签仍
   * 停在它上面，用户会以为轮换没有跳过它（现象："最近调用"和"轮询已跳过"同时出现）。
   * 准确信号是 core 的 `markHealthy`——它只在真的收到内容后才被调用。
   */
  lastPick?(): { accountId?: string; at: number } | undefined
  /**
   * 每账号并发上限（同时打上游的请求数）。
   *
   * 为什么供应商声明它：上游风控对"一个账号同时几路调用"的容忍度是**协议事实**
   * ——官方小浣熊桌面端的本地中继自限 2 路并发（`dist/electron/main.cjs`
   * `upstreams.size >= 2 → 429`）。闸门本体在 `core/gate.ts`，所有供应商共用；
   * 这里只声明数值，缺省 2。返回 ≤0 表示不设闸。
   */
  concurrency?(): number
  /**
   * 可选：对上游做一次**活体探针**（会真的发请求，`/models`、余额、身份）。
   *
   * 与 `credentials.read()` 的结构化报告互补：结构化报告回答"本地哪里有问题"，
   * 活体探针回答"上游现在怎么说"。实现必须**永不抛错**——每个端点自己捕获并把
   * 上游原文放进 `reason`，否则一次网络故障会让整份诊断报废。
   */
  probeEndpoints?(): Promise<readonly DiagnosticsProbe[]>
}

/** The module the registry mounts. */
export interface VendorModule {
  readonly descriptor: VendorDescriptor
  create(deps: VendorDeps): VendorRuntime | Promise<VendorRuntime>
}

// ── Surface (what the core builds from the primitives) ─────────────────────

/** Everything the generic route handlers need; built by `core/surface.ts`. */
/** provider 注册的实时状态（由 registry 维护，surface 只负责读出来）。 */
export interface ProviderState {
  registered: boolean
  routes: readonly string[]
  /**
   * 适配器的 `getModels()` **实际**返回多少条。
   *
   * 这是"模型选择器看不到这一组"的决定性信号：`registered: true` 但这里是 0，
   * 说明模型没进适配器（目录/选择为空）；`registered: false` 则是注册本身被拒。
   */
  models?: number
  error?: string
  /**
   * 「重新注册」按钮能不能帮上忙。
   *
   * 注册**被拒**（名字被占、瞬间失活、句柄失效）时为 true：再走一遍注册是有意义的。
   * 而"被配置禁用""没有登录态""没有路由""双挂载让位"是重试也改变不了的状态——
   * 修复动作在别处（启用配置、客户端登录、重新检测），按钮就是死控件。缺省按
   * "可重试"处理：只有 registry 明确说 false 才隐藏按钮。
   */
  retryable?: boolean
}

export interface VendorSurface {
  readonly descriptor: VendorDescriptor
  readonly runtime: VendorRuntime
  status(options?: { allowNetwork?: boolean }): Promise<VendorStatusView>
  diagnostics(): Promise<{
    view: Omit<import('../shared/views.js').VendorDiagnosticsView, 'ok'>
    probes: DiagnosticsProbe[]
  }>
  credits(options?: { force?: boolean; withAccounts?: boolean }): Promise<CreditsReadout>
  /**
   * 一个账号的额度读readout——懒加载用的单条入口。
   *
   * 批量读取要等所有账号读完（90 个账号约 5 秒），界面就只能空着；有了这条，
   * 前端先把账号行画出来，数字随到随填。缓存仍在 per-account memo 上。
   */
  accountCredits(accountId: string): Promise<CreditsReadout>
  catalogView(options?: { force?: boolean }): Promise<{ models: AccountlessCatalogRow[]; refreshedAt: number | null; selection: string[] | null }>
  saveSelection(ids: readonly string[]): Promise<string[]>
  accounts(): Promise<AccountsView>
  pool(): Promise<PoolStateView>
  accountView(account: StoredAccount): AccountRowView
  credentialView(): Promise<CredentialView>
  accountSummary(): Promise<AccountView | null>
  /** 读取 provider 注册状态；缺省表示"这套 surface 不追踪它"（CLI 场景）。 */
  providerState?(): ProviderState | undefined
}

export interface AccountlessCatalogRow extends CatalogModel {
  enabled: boolean
}

/** One pi-ai route the vendor installed. */
export interface VendorRoute {
  route: string
  displayName: string
  origin: 'plugin' | 'desktop'
}

export interface ProfiledRoute {
  readonly profile: ResolvedPiAiProviderProfile
  readonly route: VendorRoute
}

export { type VendorCapabilities }

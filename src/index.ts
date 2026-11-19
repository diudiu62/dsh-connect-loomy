/**
 * dsh-connect-desktop — host entry.
 *
 * This file is intentionally small: it wires the registry and nothing else. The
 * five host capabilities that used to be bootstrapped by hand here now live on
 * the vendor contract:
 *
 * 1. credential discovery → `CredentialDriver` (`src/core/credential.ts`);
 * 2. catalog → `CatalogDriver` (`src/core/catalog.ts`);
 * 3. provider routes → one adapter (`src/core/provider.ts`), N vendors;
 * 4. card routes → planned from capabilities (`src/core/routes.ts`);
 * 5. CLI → `src/bin.ts`.
 *
 * Adding a vendor is one line in `mountVendors()` plus a `src/vendors/<id>/`
 * module. Nothing in this file branches on a vendor id.
 *
 * @module dsh-connect-desktop
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-settings'
import { createVendorRegistry, type VendorRegistry } from './core/registry.js'
import { vendorStorageDir } from './core/store.js'
import { mountAt } from './core/http.js'
import {
  Config,
  live,
  settingsNamespaceOf,
  vendorConfigOf,
  vendorEnabled,
  VENDOR_CONFIG_DEFAULTS,
  type Config as PluginConfig,
} from './config.js'
import { STATUS_ROUTE, type StatusView } from './shared/views.js'
import { createLoomyModule } from './vendors/loomy/index.js'
import { createRaccoonModule } from './vendors/raccoon/index.js'
import { detectCoexistence, migrationCommands } from './shared/profiles.js'
// 只为 ambient 事件声明而导入（`loader/volatile-update`）。
import './shared/events.js'

/** This package's own name (`package.json#name`); the patch entry must match it. */
export const PACKAGE_NAME = 'dsh-connect-desktop'

/** Package names that must be removed before this one may register routes. */
const LEGACY_PACKAGE_NAMES = ['dsh-connect-loomy'] as const

/** Plugin name used by the cordis loader and diagnostics. */
export const name = 'connect-desktop'

/**
 * Hard service gate: without the LLM registry there is nothing to register a
 * provider into. `settings` and `webServer` are optional carriers, injected
 * lazily by the registry / route mounting.
 */
export const inject = ['llm']

// Re-exported for the loader (`Config` is read as `plugin.Config`).
export { Config }
export type { PluginConfig }

/**
 * 本进程里 `apply()` 被调用的次数。
 *
 * 正常情况下是 1。大于 1 意味着同一进程挂了两份本插件 —— 两份会争夺同一个
 * provider 名字（`loomy` / `raccoon`），后到的那份注册失败，模型选择器就会缺组。
 * 这个计数只用于诊断，放在模块作用域（进程级）。
 */
let applyCount = 0

/** 当前实例 id：用来区分"哪个实例抢到了 provider"。 */
const instanceId = randomUUID().slice(0, 8)

/**
 * 进程级 provider 所有权令牌。
 *
 * 同一进程里本插件被挂载两次时，两份会争夺 `loomy` / `raccoon` 两个 provider 名字。
 * 谁先挂载谁持有；后来者只注册自己的路由（让位重复的）并明确报告"我不管 provider"。
 * 持有者释放时把令牌清掉，下一次（真正的热重载）才能接管。
 */
const PROVIDER_OWNER_KEY = Symbol.for('dsh-connect-desktop.provider-owner')

function claimProviderOwnership(): { token: symbol; owns: boolean } {
  const holder = (globalThis as Record<symbol, unknown>)[PROVIDER_OWNER_KEY]
  if (holder !== undefined) return { token: Symbol('secondary'), owns: false }
  const token = Symbol('owner')
  ;(globalThis as Record<symbol, unknown>)[PROVIDER_OWNER_KEY] = token
  return { token, owns: true }
}

/**
 * 仅测试用：归还进程级 provider 所有权。
 *
 * 生产路径靠 `ctx.effect` 的释放回调归还；测试里的假 ctx 从不 dispose，所以需要
 * 一个显式复位，否则同一进程里后续用例会一直是"次要实例"而不注册 provider。
 */
export function resetProviderOwnershipForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[PROVIDER_OWNER_KEY]
}

function releaseProviderOwnership(token: symbol): void {
  if ((globalThis as Record<symbol, unknown>)[PROVIDER_OWNER_KEY] === token) {
    delete (globalThis as Record<symbol, unknown>)[PROVIDER_OWNER_KEY]
  }
}

/** 本进程的挂载次数（诊断用）。 */
export function applyCountOf(): number {
  return applyCount
}

/** The live registry, exposed for tests and the CLI's `--json` output. */
let activeRegistry: VendorRegistry | undefined

/** Every mounted registry, keyed by the context that owns it (tests mount many). */
const registries = new WeakMap<Context, VendorRegistry>()

/** The registry this process mounted, if any. */
export function vendorRegistry(): VendorRegistry | undefined {
  return activeRegistry
}

/** The registry mounted on one context (tests). */
export function registryOf(ctx: Context): VendorRegistry | undefined {
  return registries.get(ctx)
}

/**
 * Mount the plugin.
 *
 * `apply` stays synchronous: every network read happens lazily on a route, a
 * model call or a CLI invocation. The only immediate work is registry
 * construction; each vendor's own mount is a promise whose failure is contained.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  applyCount += 1
  const settingsNs = settingsNamespaceOf(ctx)
  const ownership = claimProviderOwnership()
  if (applyCount > 1) {
    ctx.logger.warn(
      `dsh-connect-desktop: 本进程第 ${applyCount} 次挂载本插件（实例 ${instanceId}）。` +
        '多份实例会争夺 loomy/raccoon 这两个 provider 名字，后到的那份注册不上。',
    )
  }

  // The settings page must not render a second, auto-generated form beside our
  // custom card (contract doc §1.3).
  ctx.inject(['settings'], (child) => {
    ctx.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-connect-desktop: settings section')
  })

  const csrfToken = randomBytes(24).toString('base64url')
  const logger = {
    info: (message: string): void => ctx.logger.info(message),
    warn: (message: string, error?: unknown): void => ctx.logger.warn(message, error),
    error: (message: string, error?: unknown): void => ctx.logger.error(message, error),
  }

  /**
   * 每家的配置片：用户覆盖合并声明默认值。
   *
   * 读的时候必须补默认值——否则"从没写过配置"的用户在卡片里会看到空白字段，
   * 而运行时实际用的是默认值，两边对不上。
   */
  const readVendorConfig = (vendorId: string): Record<string, unknown> => {
    const declared = VENDOR_CONFIG_DEFAULTS[vendorId] ?? {}
    return { ...declared, ...vendorConfigOf(config, vendorId) }
  }

  /**
   * 只看用户层。
   *
   * 配置页要标"这一项你改过"，而 `readVendorConfig` 一定包含全部默认字段——
   * 拿它判断会让每个字段都显示"已修改"。
   */
  const readVendorOverrides = (vendorId: string): Record<string, unknown> => vendorConfigOf(config, vendorId)

  /**
   * 把用户改过的字段写回 profile。
   *
   * 用 `mutate` 的路径操作而不是 `update(ns, {vendors: …})`：后者按顶层键浅合并，
   * 会把另一家的整片配置覆盖掉。路径写入只动 `vendors.<id>.<field>` 这一个叶子。
   */
  /** 宿主 settings 服务的形状（只声明用到的方法）。 */
  interface SettingsService {
    describe(): ReadonlyArray<{ ns: string; revision: number }>
    mutate(
      ns: string,
      ops: ReadonlyArray<Record<string, unknown>>,
      expectedRevision?: number,
    ): Promise<void>
  }

  const settingsService = (): SettingsService | undefined =>
    ctx.get?.('settings') as SettingsService | undefined

  /**
   * 这份配置当前的版本号。
   *
   * 宿主的 `describe()` 每项带 `revision`（单调递增），`mutate()` 接受它做乐观锁。
   * 拿不到（宿主没这个字段、或 settings 尚未注入）时返回 `undefined` —— 此时
   * 配置页退化成"最后写入者获胜"，与改造前一致，不会更差。
   */
  const configRevision = (): number | undefined => {
    const settings = settingsService()
    if (settings === undefined) return undefined
    try {
      const ns = settingsNamespaceOf(ctx)
      return settings.describe().find((entry) => entry.ns === ns)?.revision
    } catch {
      return undefined
    }
  }

  const writeVendorConfig = async (
    vendorId: string,
    patch: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<void> => {
    const settings = settingsService()
    if (settings === undefined) throw new Error('宿主没有提供 settings 服务，无法写入配置')
    const ns = settingsNamespaceOf(ctx)
    const ops = Object.entries(patch).map(([key, value]) => ({
      op: 'set' as const,
      path: ['vendors', vendorId, key],
      value,
    }))
    if (ops.length === 0) return
    // 带上 expectedRevision 后，宿主在版本不符时抛 SettingsConflictError；
    // 路由层把它翻成 `config_stale` 交给客户端，而不是静默覆盖别人的改动。
    await settings.mutate(ns, ops, expectedRevision)
  }

  const registry = createVendorRegistry({
    ctx,
    // 守卫要独占哪些 provider 名：由各 vendor 的 descriptor 推导，不手写清单。
    claimedProviders: [createLoomyModule().descriptor.id, createRaccoonModule().descriptor.id],
    csrfToken,
    logger,
    config: () => ({ vendors: live(config.vendors) as Record<string, unknown> }),
    enabled: (vendorId) => vendorEnabled(config, vendorId),
    ownsProviders: ownership.owns,
    readVendorConfig,
    readVendorOverrides,
    writeVendorConfig,
    configRevision,
    // Lazy on purpose: `dsh-attachment-local` may mount after this plugin, so a
    // missing service must report "no provider" rather than fail the mount.
    attachments: () => ctx.get?.('attachments') ?? undefined,
    imageAccess: (attachments, ref) => resolveImageAccess(ctx, attachments, ref),
    modelsUpdated: (providerId) => ctx.emit('llm/models-updated', providerId),
  })
  registries.set(ctx, registry)
  activeRegistry = registry

  // 持有者卸载时归还令牌，真正的热重载才能接管 provider。
  ctx.effect(() => () => releaseProviderOwnership(ownership.token), 'dsh-connect-desktop: provider ownership')

  mountAt(ctx, {
    path: STATUS_ROUTE,
    csrfToken,
    logger,
    spec: {
      suffix: 'status',
      methods: ['GET'],
      mutating: false,
      run: async (): Promise<StatusView> => ({
        ok: true,
        csrfToken,
        vendors: await registry.status(),
        instance: { id: instanceId, applyCount },
      }),
    },
  })

  void mountVendors(ctx, registry, logger)

  ctx.on('loader/volatile-update', () => {
    void registry.reconcileAll()
  })

  ctx.logger.info(
    `dsh-connect-desktop: mounted (settingsNs=${settingsNs}, enabled=${String(live(config.enabled))})`,
  )
}

/**
 * Mount every vendor, one guarded attempt each.
 *
 * Coexistence comes first: a profile that still lists the old package would
 * double-register `loomy` and the host answers with
 * `an adapter for provider "loomy" is already registered`, which reads like a
 * broken harness. Yielding costs the user nothing.
 */
async function mountVendors(
  ctx: Context,
  registry: VendorRegistry,
  logger: { info(message: string): void; warn(message: string, error?: unknown): void; error(message: string, error?: unknown): void },
): Promise<void> {
  const coexistence = detectCoexistence({ selfName: PACKAGE_NAME, legacyNames: LEGACY_PACKAGE_NAMES })
  if (coexistence.kind === 'blocked') {
    ctx.logger.error(
      `dsh-connect-desktop: 检测到旧版 ${coexistence.legacyName} 仍挂在 profile「${coexistence.profile}」里，` +
        `已跳过供应商注册以避免 provider 重复注册。请先执行：` +
        migrationCommands(coexistence.profile, coexistence.legacyName, PACKAGE_NAME).join(' && '),
    )
    return
  }

  // Sequential on purpose: two vendors racing for the same provider id is a bug
  // we would rather see surface in the log than in the picker.
  for (const create of [createLoomyModule, createRaccoonModule]) {
    const mounted = await registry.mount(create())
    if (mounted === undefined) continue
    logger.info(`dsh-connect-desktop: ${mounted.descriptor.id} 已挂载`)
  }
}

/** Bridge one durable image reference into the current tool execution world. */
function resolveImageAccess(
  ctx: Context,
  attachments: Parameters<typeof resolveImageAttachmentAccess>[0],
  ref: Parameters<typeof resolveImageAttachmentAccess>[2],
): ReturnType<typeof resolveImageAttachmentAccess> {
  return resolveImageAttachmentAccess(
    attachments,
    (hostPath) => ctx.get?.('fs')?.processPathFromHostPath(hostPath),
    ref,
  )
}

// ── Test-facing re-exports ─────────────────────────────────────────────────
//
// The built host is a single bundle (`lib/index.js`), so a test cannot import
// `lib/core/catalog.js` directly. Everything a test needs is surfaced here.
// Adding a name here is the only supported way to test an internal.

export * from './vendor-sdk/contracts.js'
export { assertRuntime, conformanceProblems } from './vendor-sdk/conformance.js'
export { ROUTE_PREFIX, STATUS_ROUTE, vendorRoute } from './shared/views.js'
export type * from './shared/views.js'

export { createVendorRegistry } from './core/registry.js'
export { createCredentialDriver } from './core/credential.js'
export { createVendorDeps } from './core/deps.js'
export { describeVendorConfig } from './core/config-fields.js'
export { createAccountsStore, DESKTOP_ACCOUNT_ID } from './core/accounts.js'
export { createCatalogStore, applyVisionOverrides } from './core/catalog.js'
export { createCreditsStore, mergeCredits } from './core/credits.js'
export { createAccountPool, disqualifiesAccount, DEFAULT_POOL_COOLDOWN_MS, NO_POINTS_CODE } from './core/pool.js'
export { createVendorPreferences } from './core/preferences.js'
export { createVendorSurface } from './core/surface.js'
export { planVendorRoutes } from './core/routes.js'
export { CSRF_HEADER, MAX_BODY_BYTES, csrfMatches, failure, json, mountAt, mountRoutes } from './core/http.js'
export { createDocument, storageRoot, vendorStorageDir, STORAGE_ROOT } from './core/store.js'
export { emptyVendorState, parseVendorState, serializeVendorState, STATE_VERSION } from './core/state.js'
export { createMemo } from './core/ttl.js'
export { chunkHasContent, createChatRuntime, MISSING_ATTACHMENT_SERVICE_MESSAGE } from './core/provider.js'

// Loomy (vendor #1)
export {
  LOOMY_API,
  LOOMY_COMPAT,
  displayNameFor,
  prepareLoomyHeaders,
  thinkingLevelMapFor,
  toPiModel,
  createLoomyModule,
} from './vendors/loomy/index.js'
export { createProviderRuntime } from './vendors/loomy/provider.js'
export { catalogUrls, extractModelList, mergeSelection, normalizeCatalog, normalizeCatalogModel, resolveEnabledIds } from './vendors/loomy/catalog.js'
export { clampPageSize, fetchCredits, fetchIdentity, normalizeLedgerRow, parseCreditsPayload } from './vendors/loomy/credits.js'
export {
  createAuthStore,
  accountViewOf,
  credentialViewOf,
  createSessionPrecheck,
  missingCredentialMessage,
  nextStepsFor,
  readAuthSession,
  sessionFingerprint,
} from './vendors/loomy/auth.js'
export { accountIdOf, isOurRoute, routeDisplayName, routeForSlot, slotForRoute } from './vendors/loomy/accounts.js'
export { POOL_ROUTE } from './vendors/loomy/constants.js'

/** 一个供应商的账号文档路径（诊断/测试用）。 */
export function accountsFilePath(vendorId: string): string {
  return `${vendorStorageDir(vendorId)}/accounts.json`
}
export { createLoginService, SEND_CODE_COOLDOWN_MS, SMS_EXPIRES_MS } from './vendors/loomy/login.js'
export {
  authSessionCandidatesWithPlugin,
  clearPluginAuthSession,
  defaultPluginStorageDir,
  pluginAuthPath,
  readPluginAuthSession,
  writePluginAuthSession,
} from './vendors/loomy/plugin-auth.js'
export {
  configFromEnv,
  decryptLoomyEnv,
  loomyAppEnvCandidates,
  PHONE_PATTERN,
  resetXfyunConfigCache,
  resolveXfyunConfig,
  sendSmsCode,
  verifySmsCode,
  xfyunHeaders,
  xfyunStringToSign,
} from './vendors/loomy/xfyun.js'

// Raccoon (vendor #2)
export {
  DEFAULT_RACCOON_BASE_URL,
  DEFAULT_RACCOON_CATALOG_TTL_MS,
  DEFAULT_RACCOON_CLIENT_VERSION,
  DEFAULT_RACCOON_CREDITS_TTL_MS,
  DEFAULT_RACCOON_POINTS_URL,
  RACCOON_COMPAT,
  RACCOON_DISPLAY_NAME,
  RACCOON_PROVIDER_ID,
  raccoonDisplayName,
  prepareRaccoonHeaders,
  createRaccoonModule,
} from './vendors/raccoon/index.js'
export { fetchCatalog, parseCatalog, parseModel, raccoonHeaders, RaccoonError } from './vendors/raccoon/catalog.js'
export { authCandidates, decodeJwtPayload, parseAuthDocument, readAuth, redactAuth } from './vendors/raccoon/auth.js'
export { RACCOON_BILLS_URL, fetchBalance, fetchBills, parseBalance, parseBills } from './vendors/raccoon/credits.js'
export { decryptRaccoonPhone, encryptRaccoonPhone, fetchUserInfo, loginWithPassword, loginWithSms, logout as raccoonLogout, refreshToken as raccoonRefreshToken, sendSmsCode as raccoonSendSmsCode } from './vendors/raccoon/auth-flow.js'

// Shared helpers tests lean on
export { buildTracingHeaders, isTraceparent } from './shared/trace.js'
export { checkLoopback, hostMatchesListener, originIsLocal } from './shared/loopback.js'
export {
  asNumber,
  asPositiveInt,
  asString,
  asStringArray,
  formatDateTime,
  isRecord,
  maskPhone,
  maskUserId,
  notSignedInMessage,
  parseMultiplier,
  redactSensitive,
  safeErrorMessage,
  toEpochMs,
} from './shared/text.js'
export { authSessionCandidates, discoveryRoots, resolveDshHome, stateFilePath, windowsAppData, windowsLocalAppData } from './shared/paths.js'
export { AUTH_FILE_NAME, createAuthDiscovery, DEFAULT_DISCOVERY_TTL_MS, discoverAuthSessionFiles } from './shared/discover.js'
export { COMMUNITY, communityChannels, communityHref, isPlaceholder, ISSUES_URL, REPOSITORY_URL } from './shared/community.js'
export { bundlesOf, readProfiles, detectCoexistence, migrationCommands } from './shared/profiles.js'
export { requestPlatform } from './vendors/loomy/upstream.js'

/**
 * dsh-connect-loomy — host entry.
 *
 * Wires the five host capabilities into one cordis plugin:
 *
 * 1. **credential discovery** (`src/auth.ts`) — read-only access to the Loomy
 *    desktop client's `auth-session.json`, never persisted;
 * 2. **catalog** (`src/catalog.ts`) — `/models` whitelist, normalised and
 *    cached under `$DSH_HOME`, plus the user's saved selection;
 * 3. **provider** (`src/provider.ts`) — one pi-ai route named `loomy`,
 *    registered through `ctx.llm.registerAdapter`, with per-request tracing
 *    headers and a session precheck before dispatch;
 * 4. **card routes** (`src/routes.ts`) — read-only status/diagnostics/credits
 *    plus the two CSRF-protected writes;
 * 5. **CLI** (`src/bin.ts`, separate entry) — `status`/`doctor`.
 *
 * The provider route is deliberately independent of the settings card: the
 * model selector works as soon as the plugin is mounted and signed in, even if
 * the browser half never loads.
 *
 * @module dsh-connect-loomy
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createAuthStore } from './auth.js'
import type { AuthSnapshot } from './auth.js'
import { createCatalogStore } from './catalog.js'
import { createCreditsCache, type CreditsCache } from './credits.js'
import { createProviderRuntime } from './provider.js'
import { registerLoomyRoutes } from './routes.js'
import { stateFilePath } from './shared/paths.js'
import { authSessionCandidatesWithPlugin, defaultPluginStorageDir } from './plugin-auth.js'
import { createLoginService } from './login.js'
import { createAccountPool, POOL_ROUTE } from './pool.js'
import { accountIdOf, createAccountsStore, type AccountRoute } from './accounts.js'
import { displayPhone, displayUserId } from './shared/text.js'
import { createSessionPrecheck } from './auth.js'
import { createStateStore } from './shared/state.js'
import { PROVIDER_ID } from './shared/types.js'
import { Config, live, settingsNamespaceOf, type Config as LoomyConfig } from './config.js'

/** Plugin name used by the cordis loader and diagnostics. */
export const name = 'connect-loomy'

/**
 * Hard service gate: without the LLM registry there is nothing to register a
 * provider into. `settings` and `webServer` are optional carriers and are
 * injected lazily by this module / the route module.
 */
export const inject = ['llm']

// Re-exported for the loader (`Config` is read as `plugin.Config`).
export { Config }
export type { LoomyConfig }

/** Test-facing re-exports: the host API is otherwise reachable only through a live DSH. */
export {
  accountViewOf,
  createAuthStore,
  credentialViewOf,
  nextStepsFor,
  readAuthSession,
  sessionFingerprint,
} from './auth.js'
export {
  KNOWN_EFFORTS,
  catalogUrls,
  createCatalogStore,
  extractModelList,
  mergeSelection,
  normalizeCatalog,
  normalizeCatalogModel,
  resolveEnabledIds,
} from './catalog.js'
export {
  clampPageSize,
  createCreditsCache,
  fetchCredits,
  fetchIdentity,
  normalizeLedgerRow,
  parseCreditsPayload,
} from './credits.js'
export {
  LOOMY_API,
  LOOMY_COMPAT,
  createProviderRuntime,
  displayNameFor,
  prepareLoomyHeaders,
  thinkingLevelMapFor,
  toPiModel,
} from './provider.js'
export { buildDiagnostics, buildStatus, registerLoomyRoutes } from './routes.js'
export {
  asNumber,
  asPositiveInt,
  asString,
  asStringArray,
  formatDateTime,
  isRecord,
  maskPhone,
  maskUserId,
  parseMultiplier,
  redactSensitive,
  safeErrorMessage,
  toEpochMs,
} from './shared/text.js'
export { buildTracingHeaders, isTraceparent } from './shared/trace.js'
export { checkLoopback, hostMatchesListener, originIsLocal } from './shared/loopback.js'
export { createStateStore, emptyState, parseState, serializeState, STATE_VERSION } from './shared/state.js'
export { authSessionCandidates, resolveDshHome, stateFilePath } from './shared/paths.js'
export { PROVIDER_ID, ROUTE_PREFIX, ROUTES } from './shared/types.js'
export { requestPlatform } from './shared/upstream.js'
export {
  configFromEnv,
  decryptLoomyEnv,
  loomyAppEnvCandidates,
  resolveXfyunConfig,
  resetXfyunConfigCache,
  sendSmsCode,
  verifySmsCode,
  xfyunHeaders,
  xfyunStringToSign,
  PHONE_PATTERN,
} from './shared/xfyun.js'
export {
  accountIdOf,
  accountsFilePath,
  accountsView,
  createAccountsStore,
  parseAccounts,
  parseBundle,
  routeDisplayName,
  routeForSlot,
  slotForRoute,
  isOurRoute,
} from './accounts.js'
export {
  authSessionCandidatesWithPlugin,
  clearPluginAuthSession,
  defaultPluginStorageDir,
  pluginAuthPath,
  readPluginAuthSession,
  writePluginAuthSession,
} from './plugin-auth.js'
export { createLoginService, SEND_CODE_COOLDOWN_MS, SMS_EXPIRES_MS } from './login.js'
export {
  createAccountPool,
  disqualifiesAccount,
  DEFAULT_POOL_COOLDOWN_MS,
  POOL_ROUTE,
  type AccountPool,
} from './pool.js'

/**
 * Mount the plugin.
 *
 * `apply` stays synchronous: every network read happens lazily on a route, a
 * model call or a CLI invocation. The only immediate work is wiring and one
 * disk read for the cached catalog.
 */
export function apply(ctx: Context, config: LoomyConfig): void {
  const settingsNs = settingsNamespaceOf(ctx)

  // The settings page must not render a second, auto-generated form beside our
  // custom card (contract doc §1.3).
  ctx.inject(['settings'], (child) => {
    ctx.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-connect-loomy: settings section')
  })

  const baseURL = (): string => live(config.baseURL)
  const loomyVersion = (): string => live(config.loomyVersion)
  const state = createStateStore(stateFilePath())
  // Credential precedence (decision: plugin-first): `LOOMY_AUTH_SESSION_FILE`
  // when pinned (exclusive, unchanged) → the plugin's own login written by the
  // settings card → the desktop client's file. `auth.invalidate()` after a
  // login/logout is what makes the switch immediate.
  const pluginStorageDir = defaultPluginStorageDir()
  const auth = createAuthStore({
    candidates: authSessionCandidatesWithPlugin(pluginStorageDir),
    ttlMs: () => live(config.sessionTtlMs),
  })
  const accounts = createAccountsStore({
    storageDir: () => pluginStorageDir,
    ttlMs: () => live(config.sessionTtlMs),
    readDesktop: async () => {
      const snapshot = await auth.read()
      return snapshot.found
        ? {
            found: true,
            ...(snapshot.session === undefined ? {} : { session: snapshot.session }),
            ...(snapshot.phone === undefined ? {} : { phone: snapshot.phone }),
            ...(snapshot.userId === undefined ? {} : { userId: snapshot.userId }),
          }
        : { found: false }
    },
  })
  /**
   * The session a given route must authenticate as.
   *
 */
  /**
   * The rotation pool. It shares the accounts store, so a failure mark written
   * by one call is what the next call's candidate filter reads.
   */
  const pool = createAccountPool({ accounts })

  /**
   * The session the single `loomy` route must authenticate as.
   *
   * Accounts are plugin state now, not provider routes: this picks the active
   * account, or a random healthy one when rotation is on, and falls back to the
   * desktop sign-in. `route` is kept in the signature because pi-ai hands it to
   * us and a future second route would need it.
   */
  const sessionForRoute = async (_route: string): Promise<AuthSnapshot> => {
    const stateNow = await state.load()
    const stored = await accounts.list({ force: false })
    if (stored.length === 0) return auth.read()

    const rotate = stateNow.poolEnabled !== false && stored.length > 1
    let chosen: (typeof stored)[number] | undefined
    if (rotate) {
      const pick = await pool.pick()
      chosen = pick.kind === 'empty' ? undefined : pick.account
    } else {
      chosen = stored.find((account) => account.id === stateNow.activeAccountId) ?? stored[0]
    }
    if (chosen === undefined) return auth.read()
    return {
      found: true,
      sourcePath: `accounts.json#slot-${chosen.slot}`,
      candidates: [],
      session: chosen.session,
      fingerprint: accountIdOf(chosen.session),
      ...(chosen.phone === undefined ? {} : { phone: chosen.phone }),
      ...(chosen.userId === undefined ? {} : { userId: chosen.userId }),
      loginAt: chosen.addedAt,
      sourceOrigin: 'plugin' as const,
    }
  }

  const catalog = createCatalogStore({
    baseURL,
    readSession: () => auth.read(),
    state,
    ttlMs: () => live(config.catalogTtlMs),
    timeoutMs: 20_000,
    logger: ctx.logger,
    onChanged: () => {
      // `getModels()` is read live on every request, so a catalog/selection
      // change only needs to tell selectors to re-list their models.
      ctx.emit('llm/models-updated', PROVIDER_ID)
    },
  })
  /**
   * Credits are per-account: each route gets its own cache so account 2's
   * balance never renders under account 1's name. Caches are created lazily
   * and dropped when a route disappears.
   */
  const creditsByRoute = new Map<string, CreditsCache>()
  const creditsFor = (route: string): CreditsCache => {
    let cache = creditsByRoute.get(route)
    if (cache === undefined) {
      cache = createCreditsCache({
        baseURL,
        readSession: () => sessionForRoute(route),
        pageSize: () => live(config.creditsPageSize),
        ttlMs: () => live(config.creditsTtlMs),
      })
      creditsByRoute.set(route, cache)
    }
    return cache
  }
  /** Slot-1 cache — what `/credits` reports when the card names no route. */
  const credits = createCreditsCache({
    baseURL,
    readSession: () => auth.read(),
    pageSize: () => live(config.creditsPageSize),
    ttlMs: () => live(config.creditsTtlMs),
  })
  const precheck = createSessionPrecheck({
    baseURL,
    ttlMs: () => live(config.precheckTtlMs),
    logger: ctx.logger,
  })
  const login = createLoginService({
    storageDir: () => pluginStorageDir,
    invalidateAuth: () => {
      auth.invalidate()
      accounts.invalidate()
    },
    accounts,
    refreshRoutes: async () => {
      await refreshRoutes()
    },
    logger: ctx.logger,
  })
  const runtime = createProviderRuntime({
    catalog,
    baseURL,
    loomyVersion,
    readSession: () => auth.read(),
    sessionForRoute,
    pool,
    precheck,
    logger: ctx.logger,
    // Image input is served through the host's durable attachment service.
    // `dsh-attachment-local` is mounted by every shipped profile, but the read
    // stays lazy and optional: a profile without it must still boot, and only
    // an actual image request reports the missing capability.
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
  })

  const isEnabled = (): boolean => live(config.enabled) === true
  let registration: AdapterRegistrationHandle | undefined
  /** Signature of the route set currently installed, to skip no-op refreshes. */
  let routeSignature = ''

  const routeSignatureOf = (routes: readonly { route: string; displayName: string }[]): string =>
    routes.map((entry) => `${entry.route}\u0000${entry.displayName}`).join('\u0001')

  /**
   * Re-read the accounts and reconcile the provider routes.
   *
   * Called on mount, after every login/logout/account edit, and whenever a
   * request discovers the set changed — never on the request path itself, so
   * an inference call never waits for a disk read just to learn its route list.
   */
  const refreshRoutes = async (): Promise<readonly AccountRoute[]> => {
    // Default on: the feature must be visible, not hidden behind a switch the
    // user has to discover. Turning it off is the deliberate act now.
    const poolEnabled = (await state.load()).poolEnabled !== false
    const candidates = await accounts.routes({ force: true })
    // The pool route is a preference, not a fact about the accounts: register
    // it only when the user asked for automatic rotation.
    const routes = candidates.filter((entry) => entry.route !== POOL_ROUTE || poolEnabled)
    const next = routeSignatureOf(routes)
    if (next === routeSignature) return runtime.routes()
    routeSignature = next
    try {
      const installed = runtime.setRoutes(routes)
      if (isEnabled()) {
        const ids = installed.map((entry) => entry.route)
        if (ids.length === 0) {
          if (registration !== undefined) {
            registration()
            registration = undefined
          }
        } else if (registration === undefined) {
          registration = ctx.llm.registerAdapter(ids, runtime.adapter)
        } else {
          registration.replace(ids)
        }
        // Selectors must re-list: both the provider set and each provider's
        // display name changed.
        ctx.emit('llm/models-updated', ids[0] ?? PROVIDER_ID)
      }
    } catch (error) {
      ctx.logger.error('dsh-connect-loomy: could not reconcile the Loomy provider routes')
      ctx.logger.error(error)
    }
    return runtime.routes()
  }

  /**
   * Synchronous initial install.
   *
   * The provider runtime already carries the single base route (`loomy`), so
   * mounting registers exactly what the pre-multi-account build registered —
   * the model picker works the instant the plugin loads, with no window where
   * the plugin owns no route. `refreshRoutes()` then reconciles the real
   * account list over the top.
   */
  ctx.effect(() => {
    try {
      if (isEnabled()) {
        registration = ctx.llm.registerAdapter(
          runtime.routes().map((entry) => entry.route),
          runtime.adapter,
        )
      }
    } catch (error) {
      ctx.logger.error('dsh-connect-loomy: could not register the Loomy provider route')
      ctx.logger.error(error)
    }
    return () => {
      registration?.()
      registration = undefined
    }
  }, 'dsh-connect-loomy: provider route')

  void refreshRoutes().catch((error: unknown) => {
    ctx.logger.warn('dsh-connect-loomy: initial route reconciliation failed', error)
  })
  let lastBaseURL = baseURL()
  ctx.on('loader/volatile-update', () => {
    auth.invalidate()
    accounts.invalidate()
    void refreshRoutes()
    const nextBaseURL = baseURL()
    if (nextBaseURL !== lastBaseURL) {
      lastBaseURL = nextBaseURL
      // A different gateway invalidates the cached catalog; re-read it rather
      // than serving another region's multipliers for up to the cache TTL.
      void catalog.refresh()
    }
  })

  // Warm the disk cache so the first `/status` can answer immediately. This is
  // a local read; it never contacts the upstream.
  void catalog.hydrate().catch((error: unknown) => {
    ctx.logger.warn('dsh-connect-loomy: could not hydrate the cached catalog', error)
  })

  // Cold start: a fresh DSH_HOME has no cached catalog, so the model selector
  // would stay empty until the settings card happened to be opened. Once the
  // desktop client is visibly signed in, warm the catalog in the background.
  // This is deliberately fire-and-forget: mounting must never wait for (or
  // fail because of) the network, and the `.catch` keeps a warm-up rejection
  // from surfacing as an unhandled rejection in the host process. A failure is
  // silent here; routes and inference retry through their normal paths.
  void auth
    .read()
    .then((snapshot) => (snapshot.found ? catalog.ensure({ allowNetwork: true }) : undefined))
    .catch((error: unknown) => {
      ctx.logger.warn('dsh-connect-loomy: cold-start catalog warm-up failed', error)
    })

  registerLoomyRoutes(ctx, {
    auth,
    catalog,
    credits,
    creditsFor,
    accounts,
    activeAccount: {
      read: async () => (await state.load()).activeAccountId,
      write: async (id: string) => {
        const current = await state.load()
        await state.save({ ...current, activeAccountId: id })
      },
    },
    poolPreference: {
      read: async () => (await state.load()).poolEnabled !== false,
      write: async (enabled: boolean) => {
        const current = await state.load()
        await state.save({ ...current, poolEnabled: enabled })
      },
    },
    routes: () => runtime.routes(),
    refreshRoutes: async () => {
      await refreshRoutes()
    },
    login,
    csrfToken: randomBytes(24).toString('base64url'),
    baseURL,
    logger: ctx.logger,
  })

  ctx.logger.info(
    `dsh-connect-loomy: mounted (enabled=${String(isEnabled())}, baseURL=${baseURL()}, settingsNs=${settingsNs}, state=${state.path})`,
  )
}

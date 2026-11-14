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
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createAuthStore } from './auth.js'
import { createCatalogStore } from './catalog.js'
import { createCreditsCache } from './credits.js'
import { createProviderRuntime } from './provider.js'
import { registerLoomyRoutes } from './routes.js'
import { authSessionCandidates, stateFilePath } from './shared/paths.js'
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
  const auth = createAuthStore({
    candidates: authSessionCandidates(),
    ttlMs: () => live(config.sessionTtlMs),
  })
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
  const runtime = createProviderRuntime({
    catalog,
    baseURL,
    loomyVersion,
    readSession: () => auth.read(),
    precheck,
    logger: ctx.logger,
  })

  const isEnabled = (): boolean => live(config.enabled) === true
  let registration: AdapterRegistrationHandle | undefined

  /**
   * Keep the single `loomy` route in sync with the master switch.
   *
   * `registerAdapter` rejects an empty route list, so a disabled plugin simply
   * owns no route and `replace([])` is never needed for mounting. When the
   * switch flips on later, registration happens here under the same fiber, so
   * unloading still disposes it.
   */
  const syncRegistration = (): void => {
    try {
      if (isEnabled()) {
        if (registration === undefined) {
          registration = ctx.llm.registerAdapter([PROVIDER_ID], runtime.adapter)
        } else {
          registration.replace([PROVIDER_ID])
        }
        return
      }
      if (registration !== undefined) {
        registration()
        registration = undefined
      }
    } catch (error) {
      ctx.logger.error('dsh-connect-loomy: could not register the Loomy provider route')
      ctx.logger.error(error)
    }
  }

  ctx.effect(() => {
    syncRegistration()
    return () => {
      registration?.()
      registration = undefined
    }
  }, 'dsh-connect-loomy: provider route')

  let lastBaseURL = baseURL()
  ctx.on('loader/volatile-update', () => {
    auth.invalidate()
    syncRegistration()
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
    csrfToken: randomBytes(24).toString('base64url'),
    baseURL,
    logger: ctx.logger,
  })

  ctx.logger.info(
    `dsh-connect-loomy: mounted (enabled=${String(isEnabled())}, baseURL=${baseURL()}, settingsNs=${settingsNs}, state=${state.path})`,
  )
}

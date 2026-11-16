/**
 * Typed, credential-free transport for the host half's read-only routes.
 *
 * Every fact this card renders comes from `/plugins/dsh-connect-loomy/*`; the
 * browser never reads `auth-session.json` and never receives the session token.
 * The contract frozen by the captain (v2) is:
 *
 * - `GET  /status`      → `LoomyStatus` (200 even when signed out)
 * - `GET  /diagnostics` → `LoomyDiagnostics`
 * - `GET  /credits`     → `LoomyCredits` (`ok:false` reports an upstream error
 *                          truthfully; it never fabricates zero balances)
 * - `POST /refresh`     → `LoomyCatalog` (catalog + rates, persisted host-side)
 * - `POST /save`        → `{ok:true, enabled:string[]}` (applies a draft)
 *
 * The two POSTs carry `x-loomy-csrf` with the token from `GET /status`; the
 * host owns the actual check. Transport results are split into four kinds so
 * the UI can honour the "404/503 means missing route, empty value means empty
 * state" rule instead of collapsing both into an error:
 *
 * - `ok`          — a successful JSON payload
 * - `unavailable` — 404/503, i.e. this host does not serve the route
 * - `failed`      — HTTP 200 + `{ok:false,error}` (a truthful upstream failure)
 * - `error`       — network/HTTP/protocol failure
 *
 * Nothing in this module logs. A hostile or buggy host that echoed credential
 * fields would still never reach the DOM: components only read the typed
 * fields below, and the diagnostics report is built from those same fields.
 *
 * @module dsh-connect-loomy/client/api
 */

/** Route prefix shared by every host route this card consumes. */
export const ROUTE_PREFIX = '/plugins/dsh-connect-loomy'

/** Header the host checks on mutating routes. */
export const CSRF_HEADER = 'x-loomy-csrf'

/** Canonical host routes, exported so tests and diagnostics agree. */
export const ROUTES = {
  status: `${ROUTE_PREFIX}/status`,
  diagnostics: `${ROUTE_PREFIX}/diagnostics`,
  credits: `${ROUTE_PREFIX}/credits`,
  refresh: `${ROUTE_PREFIX}/refresh`,
  save: `${ROUTE_PREFIX}/save`,
  authState: `${ROUTE_PREFIX}/auth/state`,
  authSendCode: `${ROUTE_PREFIX}/auth/send-code`,
  authLogin: `${ROUTE_PREFIX}/auth/login`,
  authLogout: `${ROUTE_PREFIX}/auth/logout`,
} as const

/** `GET /auth/state` response. */
export interface LoomyAuthState {
  ok: boolean
  pluginLoggedIn: boolean
  effectiveSource: 'plugin' | 'desktop' | 'env' | 'none'
  maskedPhone?: string
  maskedUserId?: string
  loginAt?: number
  error?: { code: string; message: string }
}

/** `POST /auth/send-code` response. */
export interface LoomyAuthSendCode {
  ok: boolean
  maskedPhone?: string
  resendAfterMs?: number
  expiresMs?: number
  error?: { code: string; message: string }
}

/** `POST /auth/login` response. */
export interface LoomyAuthLogin {
  ok: boolean
  maskedPhone?: string
  maskedUserId?: string
  error?: { code: string; message: string }
}

/** `POST /auth/logout` response. */
export interface LoomyAuthLogout {
  ok: boolean
  message: string
  error?: { code: string; message: string }
}

/** One upstream error, as recorded by the host (message is verbatim upstream text). */
export interface LoomyUpstreamError {
  /** Epoch milliseconds when the failure happened. */
  at: number
  /** Upstream path or logical operation. */
  path: string
  /** Upstream business/HTTP code. */
  code: string
  /** Upstream message, untranslated. */
  message: string
}

/** Signed-in account facts. The phone number is already masked host-side. */
export interface LoomyAccount {
  /** Masked phone number, e.g. `138****1234`. Never a full number. */
  maskedPhone: string
  /** Epoch milliseconds of the sign-in. */
  loginAt: number
  /** Host-side opaque user id (not rendered; kept for diagnostics completeness). */
  userId: string
}

/** `GET /status` payload (contract v2). */
export interface LoomyStatus {
  ok: true
  /** Process-level CSRF token required by `POST /refresh` and `POST /save`. */
  csrfToken: string
  /** Null when the machine is signed out. */
  account: LoomyAccount | null
  credential: {
    /** The primary credential path the host inspected. */
    sourcePath: string
    /** Whether that file exists and parsed. */
    found: boolean
  }
  catalog: {
    total: number
    enabled: number
    refreshedAt: number | null
  }
  /**
   * The host's saved selection (contract v2: always present, `[]` means the
   * user explicitly enabled nothing). Read defensively: a host that omits it is
   * treated as "not ready" — the card then renders an empty state instead of
   * guessing from `catalog.enabled`.
   */
  enabledModelIds?: string[]
  /** Executable next steps, supplied by the host when signed out. */
  nextSteps?: string[]
  lastError?: LoomyUpstreamError
}

/** One catalog entry returned by `POST /refresh`. */
export interface LoomyCatalogModel {
  id: string
  name: string
  /** Points multiplier, e.g. `2`, `0.8`, `0` (free). */
  multiplier: number
  contextWindow: number
  maxOutput: number
  vision: boolean
  efforts: string[]
  defaultEffort: string
  /** Saved selection state; not the user's draft. */
  enabled?: boolean
}

/** `POST /refresh` payload. */
export interface LoomyCatalog {
  ok: true
  catalog: LoomyCatalogModel[]
  refreshedAt: number
}

/** `GET /diagnostics` payload. */
export interface LoomyDiagnostics {
  ok: true
  probes: Array<{ path: string; ok: boolean; reason: string }>
  upstream: {
    baseUrl: string
    modelsUrl: string
    pointsUrl: string
  }
  account: { maskedPhone: string; userId: string } | null
  catalog: { total: number; enabled: number }
  lastError?: LoomyUpstreamError
}

/** One points ledger row. */
export interface LoomyCreditsRecord {
  description: string
  direction: 'credit' | 'debit'
  pointsActual: number
  createdAt: number
  balanceAfter: number
}

/** `GET /credits` success payload. */
export interface LoomyCredits {
  ok: true
  balance: number
  dailyBalance: number
  availableBalance: number
  fetchedAt: number
  records: LoomyCreditsRecord[]
}

/** Error body shared by every route. */
export interface LoomyFailure {
  code: string
  message: string
}

/** Transport result, preserving "missing route" vs "route said no". */
export type RouteResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unavailable' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'error'; code: string; message: string; status?: number }

/** Options accepted by a single route read. */
export interface RouteOptions {
  /** Abort signal owned by the calling component. */
  signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFailure(body: unknown): LoomyFailure | undefined {
  if (!isRecord(body) || body.ok !== false || !isRecord(body.error)) return undefined
  const { code, message } = body.error
  return {
    code: typeof code === 'string' && code.length > 0 ? code : 'unknown',
    message: typeof message === 'string' ? message : '',
  }
}

/**
 * Low-level JSON request. Deliberately does not inspect payload fields beyond
 * the shared `{ok:false,error}` envelope; per-route readers narrow below.
 */
async function requestRoute<T>(
  path: string,
  init: RequestInit,
  options: RouteOptions,
): Promise<RouteResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    })
  } catch (error) {
    // Abort is control flow, not a failure: let the component ignore it.
    if (isAbortError(error)) throw error
    return { kind: 'error', code: 'network', message: describeError(error) }
  }

  // The web server answers unknown `/plugins/...` URLs with 404 and a host
  // that is still starting can answer 503; both mean "this host has no such
  // route", which is a capability fact, not an error to render in red.
  if (response.status === 404 || response.status === 503) return { kind: 'unavailable' }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {
      kind: 'error',
      code: 'bad_response',
      message: `HTTP ${response.status}: response is not JSON`,
      status: response.status,
    }
  }

  const failure = readFailure(body)
  if (failure !== undefined) return { kind: 'failed', ...failure }

  if (!response.ok) {
    return {
      kind: 'error',
      code: `http_${response.status}`,
      message: `HTTP ${response.status}`,
      status: response.status,
    }
  }

  if (!isRecord(body) || body.ok !== true) {
    return { kind: 'error', code: 'bad_response', message: 'missing ok:true envelope', status: response.status }
  }

  return { kind: 'ok', value: body as unknown as T }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/** Exported so components can treat an aborted read as control flow, not failure. */
export { isAbortError }

/**
 * Structural error description. `instanceof Error` is not enough: the client
 * bundle can run in a different realm from the code that rejected the request
 * (the jsdom harness is exactly that case), and a cross-realm Error would
 * otherwise degrade to a useless "network error".
 */
export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof error === 'string' && error.length > 0) return error
  return 'network error'
}

function getJson<T>(path: string, options: RouteOptions): Promise<RouteResult<T>> {
  return requestRoute<T>(path, { method: 'GET', headers: { accept: 'application/json' } }, options)
}

function postJson<T>(path: string, csrfToken: string, body: unknown, options: RouteOptions): Promise<RouteResult<T>> {
  return requestRoute<T>(
    path,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify(body),
    },
    options,
  )
}

/** Read sign-in state, credential conclusion, catalog counters and the CSRF token. */
export function fetchStatus(options: RouteOptions = {}): Promise<RouteResult<LoomyStatus>> {
  return getJson<LoomyStatus>(ROUTES.status, options)
}

/** Read the read-only diagnostics facts (credential candidates, upstream error verbatim). */
export function fetchDiagnostics(options: RouteOptions = {}): Promise<RouteResult<LoomyDiagnostics>> {
  return getJson<LoomyDiagnostics>(ROUTES.diagnostics, options)
}

/** Read the read-only points overview. */
export function fetchCredits(options: RouteOptions = {}): Promise<RouteResult<LoomyCredits>> {
  return getJson<LoomyCredits>(ROUTES.credits, options)
}

/** Read the plugin's own sign-in state and which source is effective. */
export function fetchAuthState(options: RouteOptions = {}): Promise<RouteResult<LoomyAuthState>> {
  return getJson<LoomyAuthState>(ROUTES.authState, options)
}

/** Send one login SMS. The 60s cooldown is enforced by the host. */
export function authSendCode(
  csrfToken: string,
  phone: string,
  options: RouteOptions = {},
): Promise<RouteResult<LoomyAuthSendCode>> {
  return postJson<LoomyAuthSendCode>(ROUTES.authSendCode, csrfToken, { phone }, options)
}

/** Verify the code; on success the plugin stores its own session. */
export function authLogin(
  csrfToken: string,
  phone: string,
  code: string,
  options: RouteOptions = {},
): Promise<RouteResult<LoomyAuthLogin>> {
  return postJson<LoomyAuthLogin>(ROUTES.authLogin, csrfToken, { phone, code }, options)
}

/** Remove the plugin-side session (desktop client untouched). */
export function authLogout(csrfToken: string, options: RouteOptions = {}): Promise<RouteResult<LoomyAuthLogout>> {
  return postJson<LoomyAuthLogout>(ROUTES.authLogout, csrfToken, {}, options)
}

/** Refresh the catalog (persisted and effective immediately; draft is untouched). */
export function refreshCatalog(csrfToken: string, options: RouteOptions = {}): Promise<RouteResult<LoomyCatalog>> {
  return postJson<LoomyCatalog>(ROUTES.refresh, csrfToken, {}, options)
}

/** Apply a model-selection draft (the only mutating call the card makes). */
export function saveEnabledModels(
  csrfToken: string,
  enabledModelIds: readonly string[],
  options: RouteOptions = {},
): Promise<RouteResult<{ ok: true; enabled: string[] }>> {
  return postJson<{ ok: true; enabled: string[] }>(
    ROUTES.save,
    csrfToken,
    { enabledModelIds: [...enabledModelIds] },
    options,
  )
}

/**
 * Extract the host's saved selection. Returns `null` when the host has not
 * reported it (contract says it must), so the UI can say "not ready" instead
 * of inventing a selection from counters.
 */
export function readEnabledModelIds(status: LoomyStatus): string[] | null {
  if (!Array.isArray(status.enabledModelIds)) return null
  return status.enabledModelIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Normalize a list id set: de-duplicate while keeping first-seen order. */
export function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

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
  accounts: `${ROUTE_PREFIX}/accounts`,
  accountRemove: `${ROUTE_PREFIX}/accounts/remove`,
  accountRename: `${ROUTE_PREFIX}/accounts/rename`,
  accountExport: `${ROUTE_PREFIX}/accounts/export`,
  accountImport: `${ROUTE_PREFIX}/accounts/import`,
  pool: `${ROUTE_PREFIX}/pool`,
  accountAdopt: `${ROUTE_PREFIX}/accounts/adopt`,
  accountActive: `${ROUTE_PREFIX}/accounts/active`,
} as const

/** `GET`/`POST /accounts/active` */
export interface LoomyActiveAccount {
  ok: boolean
  activeId?: string
  rotating?: boolean
  error?: { code: string; message: string }
}

/** `POST /accounts/adopt` */
export interface LoomyAccountAdopt {
  ok: boolean
  slot?: number
  route?: string
  replaced?: boolean
  error?: { code: string; message: string }
}

/** `GET`/`POST /pool` */
export interface LoomyPoolState {
  ok: boolean
  enabled: boolean
  accountCount: number
  active: boolean
  message?: string
  error?: { code: string; message: string }
}

/** A portable account bundle. **Contains sessions — treat as a password.** */
export interface LoomyAccountsBundle {
  kind: 'dsh-connect-loomy/accounts'
  version: 1
  exportedAt: number
  accounts: Array<{
    slot: number
    session: string
    phone?: string
    userId?: string
    label?: string
    addedAt?: number
    origin?: 'plugin' | 'desktop'
  }>
}

/** `POST /accounts/export` */
export interface LoomyAccountExport {
  ok: boolean
  bundle?: LoomyAccountsBundle
  sessionTtlDays?: number
  error?: { code: string; message: string }
}

/** `POST /accounts/import` */
export interface LoomyAccountImport {
  ok: boolean
  added?: number
  refreshed?: number
  skipped?: number
  reassigned?: number
  error?: { code: string; message: string }
}

/** One account row (never carries a session). */
export interface LoomyAccountRow {
  id: string
  slot: number
  route: string
  displayName: string
  origin: 'plugin' | 'desktop'
  label?: string
  phone?: string
  userId?: string
  addedAt?: number
  /** True while the rotation pool is skipping this account. */
  unavailable?: boolean
  unavailableAt?: number
  unavailableCode?: string
  unavailableMessage?: string
}

/** `GET /accounts` */
export interface LoomyAccounts {
  ok: boolean
  accounts: LoomyAccountRow[]
  primaryRoute?: string
  /** Routes the host has actually registered — what the picker can offer. */
  routes?: Array<{ route: string; displayName: string; origin: 'plugin' | 'desktop'; slot: number }>
}

/** `GET /auth/state` response. */
export interface LoomyAuthState {
  ok: boolean
  pluginLoggedIn: boolean
  effectiveSource: 'plugin' | 'desktop' | 'env' | 'none'
  phone?: string
  userId?: string
  loginAt?: number
  error?: { code: string; message: string }
}

/** `POST /auth/send-code` response. */
export interface LoomyAuthSendCode {
  ok: boolean
  phone?: string
  resendAfterMs?: number
  expiresMs?: number
  error?: { code: string; message: string }
}

/** `POST /auth/login` response. */
export interface LoomyAuthLogin {
  ok: boolean
  phone?: string
  userId?: string
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
  /** The signed-in phone number (local data, shown in full). */
  phone: string
  /** Epoch milliseconds of the sign-in. */
  loginAt: number
  /** Host-side opaque user id. */
  userId: string
  /** Provider route this account is reachable as. */
  route?: string
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
  account: { phone: string; userId: string; route?: string } | null
  catalog: { total: number; enabled: number }
  lastError?: LoomyUpstreamError
}

/** One points ledger row. */
export interface LoomyCreditsRecord {
  /** Model that produced this deduction (upstream `modelName`). */
  model?: string
  /** Which account this row came from (multi-account ledger). */
  source?: { route: string; account?: string; accountId?: string }
  description: string
  direction: 'credit' | 'debit'
  pointsActual: number
  createdAt: number
  balanceAfter: number
}

/** `GET /credits` success payload. */
/** One account's own points. */
export interface LoomyCreditsAccount {
  /** Stored account id — the only stable key now that one route serves all. */
  accountId?: string
  route: string
  account?: string
  balance: number
  dailyBalance: number
  availableBalance: number
  error?: string
}

export interface LoomyCredits {
  /** Per-account breakdown; the totals below are their sum. */
  perAccount?: LoomyCreditsAccount[]
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
  /** The host has no such route at all (404/503). */
  | { kind: 'unavailable' }
  /**
   * The host answered `405 Method Not Allowed` with an empty body: the route
   * exists but not for this verb, which is what a **pre-upgrade host** looks
   * like once the client bundle ships new POST endpoints. Rendered as
   * "restart DSH", never as a bare HTTP code.
   */
  | { kind: 'stale'; message: string }
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
  // 405 means "this path is known, but not with this method". Against our own
  // routes that can only be a host whose route table predates this client
  // build, so it must be actionable rather than a raw status code.
  if (response.status === 405) {
    return {
      kind: 'stale',
      message:
        '该接口在当前运行的 DSH 进程里还不存在（宿主仍是旧版本）。请重启 DSH 后再试——客户端代码已更新，但宿主的路由表只在启动时读取。',
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status === 405) {
      return {
        kind: 'stale',
        message:
          '该接口在当前运行的 DSH 进程里还不存在（宿主仍是旧版本）。请重启 DSH 后再试——客户端代码已更新，但宿主的路由表只在启动时读取。',
      }
    }
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

/**
 * Read the points overview.
 *
 * `force` bypasses the host's 60s cache — used only by an explicit refresh, so
 * a button press is never answered with a number the user is trying to replace.
 */
export function fetchCredits(
  options: RouteOptions & { force?: boolean } = {},
): Promise<RouteResult<LoomyCredits>> {
  const { force, ...rest } = options
  return getJson<LoomyCredits>(force === true ? `${ROUTES.credits}?force=1` : ROUTES.credits, rest)
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

/** Read every account the plugin can route to. */
export function fetchAccounts(options: RouteOptions = {}): Promise<RouteResult<LoomyAccounts>> {
  return getJson<LoomyAccounts>(ROUTES.accounts, options)
}

/** Remove one stored account (its provider route disappears). */
export function removeAccount(
  csrfToken: string,
  id: string,
  options: RouteOptions = {},
): Promise<RouteResult<{ ok: boolean; removed: boolean }>> {
  return postJson<{ ok: boolean; removed: boolean }>(ROUTES.accountRemove, csrfToken, { id }, options)
}

/** Rename one stored account (changes its provider display name). */
export function renameAccount(
  csrfToken: string,
  id: string,
  label: string,
  options: RouteOptions = {},
): Promise<RouteResult<{ ok: boolean }>> {
  return postJson<{ ok: boolean }>(ROUTES.accountRename, csrfToken, { id, label }, options)
}

/** Read the rotation-pool preference. */
export function fetchPool(options: RouteOptions = {}): Promise<RouteResult<LoomyPoolState>> {
  return getJson<LoomyPoolState>(ROUTES.pool, options)
}

/** Which account the single Loomy route uses. */
export function fetchActiveAccount(options: RouteOptions = {}): Promise<RouteResult<LoomyActiveAccount>> {
  return getJson<LoomyActiveAccount>(ROUTES.accountActive, options)
}

/** Point the single route at one account (rotation must be off to stick). */
export function setActiveAccount(
  csrfToken: string,
  id: string,
  options: RouteOptions = {},
): Promise<RouteResult<LoomyActiveAccount>> {
  return postJson<LoomyActiveAccount>(ROUTES.accountActive, csrfToken, { id }, options)
}

/** Turn the rotation pool on or off (persisted by the host). */
export function savePool(
  csrfToken: string,
  enabled: boolean,
  options: RouteOptions = {},
): Promise<RouteResult<LoomyPoolState>> {
  return postJson<LoomyPoolState>(ROUTES.pool, csrfToken, { enabled }, options)
}

/** Export one account (`id`) or every account as a portable bundle. */
export function exportAccounts(
  csrfToken: string,
  options: RouteOptions & { id?: string } = {},
): Promise<RouteResult<LoomyAccountExport>> {
  const { id, ...rest } = options
  return postJson<LoomyAccountExport>(ROUTES.accountExport, csrfToken, id === undefined ? {} : { id }, rest)
}

/** Turn the desktop sign-in into a stored, routable account. */
export function adoptDesktopAccount(
  csrfToken: string,
  options: RouteOptions = {},
): Promise<RouteResult<LoomyAccountAdopt>> {
  return postJson<LoomyAccountAdopt>(ROUTES.accountAdopt, csrfToken, {}, options)
}

/** Merge a bundle produced on another machine. */
/**
 * Normalize whatever the user pasted into this plugin's bundle shape.
 *
 * Why client-side: the host route used to accept only `{bundle: <canonical
 * bundle>}` and a running host keeps the route table it booted with, so a
 * browser holding a newer client than the host would fail on a raw paste.
 * Normalizing here makes every accepted input work against both the old and the
 * new host, instead of requiring a restart before an import can be attempted.
 */
export function normalizeImportDocument(value: unknown): unknown {
  const isRecordValue = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)

  /** One entry: our camelCase plus the desktop file's lowercase spelling. */
  const toAccount = (item: unknown): Record<string, unknown> | undefined => {
    if (!isRecordValue(item)) return undefined
    const session = item['session']
    if (typeof session !== 'string' || session.length < 16 || /\s/u.test(session)) return undefined
    const rawPhone = typeof item['phone'] === 'string' && item['phone'].length > 0 ? item['phone'] : undefined
    // A masked phone is display copy, not an identifier; keep it as a label so
    // the stored record never carries `189****2700` where a number belongs.
    const masked = rawPhone !== undefined && rawPhone.includes('*')
    const userIdRaw = item['userId'] ?? item['userid']
    const userId = typeof userIdRaw === 'string' && userIdRaw.length > 0 ? userIdRaw : undefined
    const rawSlot = item['slot']
    return {
      ...(typeof rawSlot === 'number' && Number.isInteger(rawSlot) && rawSlot >= 1 ? { slot: rawSlot } : {}),
      session,
      ...(rawPhone === undefined || masked ? {} : { phone: rawPhone }),
      ...(userId === undefined ? {} : { userId }),
      ...(masked ? { label: rawPhone as string } : {}),
    }
  }

  const wrap = (accounts: Array<Record<string, unknown>>): unknown =>
    accounts.length === 0
      ? value
      : { kind: 'dsh-connect-loomy/accounts', version: 1, exportedAt: Date.now(), accounts }

  // Already canonical: leave it alone.
  if (isRecordValue(value) && value['kind'] === 'dsh-connect-loomy/accounts') return value

  if (Array.isArray(value)) {
    const accounts = value.map(toAccount).filter((entry): entry is Record<string, unknown> => entry !== undefined)
    return wrap(accounts)
  }

  if (isRecordValue(value)) {
    // A bare desktop `auth-session.json`.
    const single = toAccount(value)
    if (single !== undefined) return wrap([single])
    // An unmarked `{accounts: [...]}` wrapper.
    const raw = value['accounts']
    if (Array.isArray(raw)) {
      const accounts = raw.map(toAccount).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      return wrap(accounts)
    }
  }
  // Unknown shape: hand it to the host, which owns the rejection message.
  return value
}

/**
 * Import accounts. Sends `{bundle: …}` on purpose: the current host unwraps it
 * and an older host only understands that envelope, so one request shape works
 * against both.
 */
export function importAccounts(
  csrfToken: string,
  document: unknown,
  options: RouteOptions = {},
): Promise<RouteResult<LoomyAccountImport>> {
  return postJson<LoomyAccountImport>(
    ROUTES.accountImport,
    csrfToken,
    { bundle: normalizeImportDocument(document) },
    options,
  )
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

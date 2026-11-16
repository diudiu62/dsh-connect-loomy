/**
 * Cross-half, credential-free value types for the Loomy host.
 *
 * Everything in this module is safe to serialise to disk or to the browser:
 * no session token, no full phone number, no raw user id. The only place the
 * session token exists at runtime is `src/auth.ts`'s in-memory snapshot; see
 * that module's header for the rule.
 *
 * @module dsh-connect-loomy/shared/types
 */

/** Route prefix every host route hangs off (contract v2). */
export const ROUTE_PREFIX = '/plugins/dsh-connect-loomy'

/** Canonical host route paths; exported so routes, tests and diagnostics agree. */
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
} as const

/** `POST /accounts/export` — a portable bundle. **Contains sessions.** */
export interface AccountExportView {
  ok: boolean
  bundle?: {
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
  /** Upstream session lifetime, for the card's warning. */
  sessionTtlDays?: number
  error?: { code: string; message: string }
}

/** `POST /accounts/import` */
export interface AccountImportView {
  ok: boolean
  added?: number
  refreshed?: number
  skipped?: number
  reassigned?: number
  error?: { code: string; message: string }
}

/** One account row in the settings card (never carries a session). */
export interface AccountRowView {
  id: string
  slot: number
  /** Provider route this account is reachable as (`loomy`, `loomy-2`, …). */
  route: string
  displayName: string
  origin: 'plugin' | 'desktop'
  label?: string
  phone?: string
  userId?: string
  addedAt?: number
}

/** `GET /accounts` */
export interface AccountsView {
  ok: boolean
  accounts: AccountRowView[]
  /** Route currently bound to slot 1, for the card's "primary" hint. */
  primaryRoute?: string
  /** Every provider route the host has registered right now. */
  routes?: Array<{ route: string; displayName: string; origin: 'plugin' | 'desktop'; slot: number }>
}

/** `GET /auth/state` — whether the plugin holds its own login. */
export interface AuthStateView {
  ok: boolean
  /** The plugin's own store has a session (settings card logged in). */
  pluginLoggedIn: boolean
  /** Where the *effective* session came from, for the card's copy. */
  effectiveSource: 'plugin' | 'desktop' | 'env' | 'none'
  phone?: string
  userId?: string
  loginAt?: number
}

/** `POST /auth/send-code` — one SMS sent. */
export interface AuthSendCodeView {
  ok: boolean
  phone?: string
  /** Re-send cooldown and code lifetime, for the card's countdown. */
  resendAfterMs?: number
  expiresMs?: number
}

/** `POST /auth/login` — code verified, session stored. */
export interface AuthLoginView {
  ok: boolean
  phone?: string
  userId?: string
}

/** `POST /auth/logout` — plugin-side session removed. */
export interface AuthLogoutView {
  ok: boolean
  message: string
}

/** Harness provider route key. Also the pi-ai provider id (single-route design). */
export const PROVIDER_ID = 'loomy'

/** Display name shown by the model selector and the settings card. */
export const PROVIDER_DISPLAY_NAME = 'Loomy'

/** Upstream base URL used by the Loomy desktop client. */
export const DEFAULT_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'

/** `loomy-version` sent on chat requests; the server does not validate it. */
export const DEFAULT_LOOMY_VERSION = '0.9.39'

/** Chat client version the evidence was gathered from (docs/loomy-upstream.md §6.1). */
export const LOOMY_VERSION_FALLBACK = DEFAULT_LOOMY_VERSION

/** Re-read `auth-session.json` at most this often; a re-login rewrites the file. */
export const DEFAULT_SESSION_TTL_MS = 5_000

/** How long a session precheck verdict is reused (captain guidance: ~60s). */
export const DEFAULT_PRECHECK_TTL_MS = 60_000

/** Upstream `/models` answer is cached in memory/disk; it has no cache headers. */
export const DEFAULT_CATALOG_TTL_MS = 600_000

/** Points overview cache TTL, with single-flight, per contract v2. */
export const DEFAULT_CREDITS_TTL_MS = 60_000

/** Server clamps `pageSize` at 100 (docs/loomy-upstream.md §3.2). */
export const MAX_CREDITS_PAGE_SIZE = 100

/** Default ledger page the card shows. */
export const DEFAULT_CREDITS_PAGE_SIZE = 20

/** Platform access token header name (NOT `Authorization: Bearer`). */
export const PLATFORM_TOKEN_HEADER = 'token'

/** One upstream failure, recorded verbatim apart from secret redaction. */
export interface UpstreamErrorView {
  /** Epoch milliseconds when the failure happened. */
  at: number
  /** Upstream path or logical operation. */
  path: string
  /** Upstream business/HTTP code, or a local transport code. */
  code: string
  /** Upstream `desc`/`message` text; never translated or summarised. */
  message: string
  /** Upstream `trace_id`, when the answer carried one. */
  traceId?: string
}

/** Signed-in account facts. The phone number and user id are already masked. */
export interface AccountView {
  /** Provider route this account is reachable as (`loomy`, `loomy-2`, …). */
  route?: string;
  /** Masked phone number, e.g. `138****1234`. Never a full number. */
  phone: string
  /** Epoch milliseconds of the credential's last change. */
  loginAt: number
  /** Masked local user id. Never the raw value. */
  userId: string
}

/** Credential conclusion reported to the card. */
export interface CredentialView {
  /** Primary path inspected (or the path that actually parsed). */
  sourcePath: string
  /** Whether a usable session was found and parsed. */
  found: boolean
}

/** One normalised upstream chat model. */
export interface CatalogModel {
  /** Upstream model id. Never `auto` (excluded: it silently routes and bills). */
  id: string
  /** Upstream display name; it already carries the points multiplier. */
  name: string
  /** Points multiplier parsed from the name (`x2.0` → 2, `x0.0` → 0). */
  multiplier: number
  /** Context window in tokens, from `context_length`. */
  contextWindow: number
  /** Maximum output tokens, from `max_output_tokens`. */
  maxOutput: number
  /** Whether the upstream declares image input. */
  vision: boolean
  /** Accepted upstream reasoning efforts, e.g. `['none','low','high']`. */
  efforts: string[]
  /** Upstream default effort, or `''` when none is declared. */
  defaultEffort: string
}

/** A `/refresh` entry: the saved selection is merged in host-side. */
export interface CatalogModelView extends CatalogModel {
  /** Saved selection state, not the card's draft. */
  enabled: boolean
}

/** In-memory catalog snapshot plus provenance. */
export interface CatalogSnapshot {
  models: CatalogModel[]
  /** Epoch milliseconds of the last successful upstream refresh. */
  refreshedAt: number | null
  /** Where these facts came from. */
  source: 'memory' | 'cache' | 'upstream'
}

/** One points ledger row. */
export interface CreditRecordView {
  description: string
  direction: 'credit' | 'debit'
  pointsActual: number
  /** Epoch milliseconds (upstream uses seconds). */
  createdAt: number
  balanceAfter: number
}

/** Read-only points overview. */
export interface CreditsView {
  balance: number
  dailyBalance: number
  availableBalance: number
  /** Epoch milliseconds this snapshot was fetched. */
  fetchedAt: number
  records: CreditRecordView[]
}

/** `GET /status` payload (contract v2). */
export interface StatusView {
  ok: true
  csrfToken: string
  account: AccountView | null
  credential: CredentialView
  catalog: { total: number; enabled: number; refreshedAt: number | null }
  enabledModelIds: string[]
  nextSteps?: string[]
  lastError?: UpstreamErrorView
}

/** `GET /diagnostics` probe row. */
export interface DiagnosticsProbe {
  path: string
  ok: boolean
  /** Upstream `desc`/`message` verbatim, or the local transport reason. */
  reason: string
}

/** `GET /diagnostics` payload. */
export interface DiagnosticsView {
  ok: true
  probes: DiagnosticsProbe[]
  upstream: { baseUrl: string; modelsUrl: string; pointsUrl: string }
  account: { phone: string; userId: string; route?: string } | null
  catalog: { total: number; enabled: number }
  lastError?: UpstreamErrorView
}

/** Unified error envelope used by every route and by the CLI's `--json` output. */
export interface FailureView {
  ok: false
  error: { code: string; message: string }
}

/** A successful mutation body. */
export interface SaveView {
  ok: true
  enabled: string[]
}

/** A successful refresh body. */
export interface RefreshView {
  ok: true
  catalog: CatalogModelView[]
  refreshedAt: number
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

/**
 * The one HTTP door between the card and the host.
 *
 * Every vendor route is the same shape, so the client owns exactly one request
 * function instead of one per vendor: `requestVendor({ vendorId, suffix, … })`
 * builds the URL with the shared `vendorRoute()` and reports one of four
 * outcomes. That split is what lets the UI distinguish "this host build does not
 * serve the route" from "the upstream said no" — the diagnostics panel and the
 * account panel read differently for each, and collapsing them into a boolean
 * used to make a truthful upstream failure look like a missing feature.
 *
 * Outcomes:
 *
 * - `ok`          — a 2xx JSON payload with `ok: true`;
 * - `failed`      — the host answered `{ok:false, error:{code,message}}` (any
 *                   status code). The component renders `message` verbatim: the
 *                   upstream's own words are the only actionable text there is;
 * - `stale`       — HTTP 405: the path exists but not for this verb, which can
 *                   only be a host whose route table predates this bundle;
 * - `unavailable` — 404/503 (route not served) or a network failure. Both mean
 *                   "nothing to render here yet", never "retry harder".
 *
 * CSRF: one header for the whole plugin (`x-dsh-connect-csrf`), taken from the
 * token in `GET /status`. The old per-vendor header names are gone; a vendor
 * that still needs its own would be a contract break, not a client concern.
 *
 * @module dsh-connect-desktop/client/transport
 */

import { STATUS_ROUTE, vendorRoute, type StatusView } from '../shared/views.js'

/** Header the host checks on every mutating route. One name for all vendors. */
export const CSRF_HEADER = 'x-dsh-connect-csrf'

/** Bundle marker this client writes when it has to wrap a raw pasted credential. */
export const BUNDLE_KIND = 'dsh-connect-desktop/accounts'

/** A route read, rendered without losing the reason it has no data. */
export type TransportResult<T> =
  | { kind: 'ok'; value: T }
  /** The host answered with an error envelope; `message` is rendered verbatim. */
  | { kind: 'failed'; code: string; message: string }
  /** The running host predates this client build (405). */
  | { kind: 'stale'; message: string }
  /** No route to call: not registered (404/503), or the network died. */
  | { kind: 'unavailable'; reason: 'missing_route' | 'network'; message: string }

/** What a single request needs. */
export interface VendorRequestInit {
  /** Vendor id from `VendorStatusView.id`. */
  vendorId: string
  /** Route suffix, e.g. `accounts/remove` — never a leading slash. */
  suffix: string
  method?: 'GET' | 'POST'
  /** JSON body for a POST. Omitted bodies send `{}` so the host always sees JSON. */
  body?: unknown
  /**
   * Process-level CSRF token from `GET /status`. Required for POST; a POST
   * without it fails locally instead of costing a round trip the host can only
   * reject.
   */
  csrf?: string | null
  /** Query string appended verbatim, e.g. `force=1`. */
  query?: string
  signal?: AbortSignal
}

/** Human text for a 405: the condition is fixable, the status code is not. */
const STALE_MESSAGE =
  '该接口在当前运行的 DSH 进程里还不存在（宿主仍是旧版本）。请重启 DSH 后再试——客户端代码已更新，但宿主的路由表只在启动时读取。'

/** Structural abort detection: the bundle may run in another realm than the caller. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/** Structural error description; cross-realm safe. */
export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof error === 'string' && error.length > 0) return error
  return 'network error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFailure(body: unknown): { code: string; message: string } | undefined {
  if (!isRecord(body) || body['ok'] !== false || !isRecord(body['error'])) return undefined
  const { code, message } = body['error'] as { code?: unknown; message?: unknown }
  return {
    code: typeof code === 'string' && code.length > 0 ? code : 'unknown',
    message: typeof message === 'string' ? message : '',
  }
}

/**
 * Call one vendor route.
 *
 * Aborts are rethrown rather than reported: a component unmounting is control
 * flow, and rendering "the network died" for it would be a lie.
 */
export async function requestVendor<T>(init: VendorRequestInit): Promise<TransportResult<T>> {
  const method = init.method ?? 'GET'
  const csrf = typeof init.csrf === 'string' && init.csrf.length > 0 ? init.csrf : null
  if (method === 'POST' && csrf === null) {
    return { kind: 'failed', code: 'csrf_missing', message: '宿主尚未提供 CSRF 令牌，请先重新检测。' }
  }

  const path = vendorRoute(init.vendorId, init.suffix) + (init.query === undefined ? '' : `?${init.query}`)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (method === 'POST') {
    headers['content-type'] = 'application/json'
    headers[CSRF_HEADER] = csrf as string
  }

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    return { kind: 'unavailable', reason: 'network', message: describeError(error) }
  }

  // 404/503 is how the web server answers a path nobody registered; both mean
  // "this host has no such route", which is a capability fact.
  if (response.status === 404 || response.status === 503) {
    return { kind: 'unavailable', reason: 'missing_route', message: `HTTP ${response.status}` }
  }
  // 405 = the path exists, the verb does not. Against our own routes that is a
  // pre-upgrade host, and the fix is a restart, so say that.
  if (response.status === 405) return { kind: 'stale', message: STALE_MESSAGE }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {
      kind: 'failed',
      code: 'bad_response',
      message: `HTTP ${response.status}: 响应不是 JSON`,
    }
  }

  // The envelope wins over the status code on purpose: the host answers an
  // upstream failure with HTTP 200 + ok:false, and a proxy may answer 502 with
  // the same envelope. Either way the host's `message` is what a user can act on.
  const failure = readFailure(body)
  if (failure !== undefined) return { kind: 'failed', ...failure }

  if (!isRecord(body) || body['ok'] !== true) {
    return {
      kind: 'failed',
      code: `http_${response.status}`,
      message: `HTTP ${response.status}: 缺少 ok:true 信封`,
    }
  }

  return { kind: 'ok', value: body as unknown as T }
}

/** Read every vendor's capability declaration and status — plus the CSRF token. */
export function fetchStatus(options: { signal?: AbortSignal } = {}): Promise<TransportResult<StatusView>> {
  return requestRaw<StatusView>(STATUS_ROUTE, options.signal)
}

/**
 * The plugin-level request. `requestVendor` is per vendor; `/status` is not, so
 * it needs its own call — but it must not grow a second error vocabulary, hence
 * the shared body handling.
 */
async function requestRaw<T>(path: string, signal: AbortSignal | undefined): Promise<TransportResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    return { kind: 'unavailable', reason: 'network', message: describeError(error) }
  }
  if (response.status === 404 || response.status === 503) {
    return { kind: 'unavailable', reason: 'missing_route', message: `HTTP ${response.status}` }
  }
  if (response.status === 405) return { kind: 'stale', message: STALE_MESSAGE }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'failed', code: 'bad_response', message: `HTTP ${response.status}: 响应不是 JSON` }
  }
  const failure = readFailure(body)
  if (failure !== undefined) return { kind: 'failed', ...failure }
  if (!isRecord(body) || body['ok'] !== true) {
    return { kind: 'failed', code: `http_${response.status}`, message: `HTTP ${response.status}: 缺少 ok:true 信封` }
  }
  return { kind: 'ok', value: body as unknown as T }
}

// ── Import document normalisation ──────────────────────────────────────────

/**
 * Normalize whatever the user pasted into this plugin's bundle shape.
 *
 * The host accepts both `{bundle: <canonical bundle>}` and a raw document, so
 * this is not a compatibility shim: it is what keeps a **masked** phone number
 * from being stored as if it were a phone number. A pasted export that carries
 * `189****2700` is display copy, so it is demoted to a `label` and the record is
 * left without a `phone` — the upstream identifier is what a login needs.
 */
export function normalizeImportDocument(value: unknown): unknown {
  const asRecord = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)

  /** One entry: our camelCase plus the desktop file's lowercase spelling. */
  const toAccount = (item: unknown): Record<string, unknown> | undefined => {
    if (!asRecord(item)) return undefined
    const session = item['session']
    if (typeof session !== 'string' || session.length < 16 || /\s/u.test(session)) return undefined
    const rawPhone = typeof item['phone'] === 'string' && item['phone'].length > 0 ? item['phone'] : undefined
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
    accounts.length === 0 ? value : { kind: BUNDLE_KIND, version: 1, exportedAt: Date.now(), accounts }

  if (asRecord(value) && value['kind'] === BUNDLE_KIND) return value

  if (Array.isArray(value)) {
    const accounts = value.map(toAccount).filter((entry): entry is Record<string, unknown> => entry !== undefined)
    return wrap(accounts)
  }

  if (asRecord(value)) {
    const single = toAccount(value)
    if (single !== undefined) return wrap([single])
    const raw = value['accounts']
    if (Array.isArray(raw)) {
      const accounts = raw.map(toAccount).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      return wrap(accounts)
    }
  }
  // Unknown shape: hand it to the host, which owns the rejection message.
  return value
}

/** De-duplicate while keeping first-seen order. */
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

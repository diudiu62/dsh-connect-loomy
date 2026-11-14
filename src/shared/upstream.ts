/**
 * HTTP client for Loomy's **platform** endpoints (`/models`, `/points/*`,
 * `/user/identity`).
 *
 * These endpoints authenticate with a bare `token: <session>` header — the
 * conversation endpoint uses `Authorization: Bearer <session>` instead, and
 * the two are not interchangeable (a bare token on `/chat/completions` answers
 * HTTP 200 + `100002 缺少 token`). Keeping the platform client in its own
 * module makes that split impossible to blur.
 *
 * Two upstream quirks drive the whole shape of this file:
 *
 * 1. **Failures arrive as HTTP 200 + a business-code envelope.** The code is
 *    the authority, not the status line. `000000` is success; anything else is
 *    a failure whose `desc` is reported verbatim.
 * 2. **`/models` success carries no `code` field at all** (only errors do), so
 *    "has `code` and it isn't success" is the negative test, while a
 *    well-shaped body without a code is accepted.
 *
 * @module dsh-connect-loomy/shared/upstream
 */

import { asNumber, asString, isRecord, redactSensitive, safeErrorMessage } from './text.js'

/** Success codes the platform has been observed to use. */
const SUCCESS_CODES = new Set(['000000', '0', '200'])

/** One platform call's outcome. */
export type PlatformResult =
  | { kind: 'ok'; body: unknown; data: unknown }
  | {
      kind: 'failure'
      /** Upstream business code, HTTP status, or a local transport code. */
      code: string
      /** Upstream `desc`/`message` verbatim apart from secret redaction. */
      message: string
      status?: number
      traceId?: string
    }

/** Options accepted by {@link requestPlatform}. */
export interface PlatformRequestOptions {
  baseURL: string
  /** Upstream path beginning with `/`. */
  path: string
  /** Session token from the desktop client. Never logged. */
  session: string
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | boolean | undefined>
  /** JSON request body for POST calls. */
  body?: unknown
  timeoutMs?: number
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Extra request headers (tests / diagnostics). */
  headers?: Record<string, string>
}

/** Join a base URL and an absolute path without doubling slashes. */
export function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/** The upstream `/models` URL for a base URL. */
export function modelsUrl(baseURL: string): string {
  return joinUrl(baseURL, '/models')
}

/** The upstream points-ledger URL for a base URL. */
export function pointsUrl(baseURL: string): string {
  return joinUrl(baseURL, '/points/records')
}

/** The upstream identity URL for a base URL. */
export function identityUrl(baseURL: string): string {
  return joinUrl(baseURL, '/user/identity')
}

/** The upstream chat-completions URL (used by diagnostics text only). */
export function chatCompletionsUrl(baseURL: string): string {
  return joinUrl(baseURL, '/chat/completions')
}

function buildQuery(query: PlatformRequestOptions['query']): string {
  if (query === undefined) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text.length === 0 ? '' : `?${text}`
}

/** Platform headers: `token`, never `Authorization`. */
export function platformHeaders(
  session: string,
  hasBody = false,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    accept: 'application/json',
    'user-agent': 'dsh-connect-loomy/0.1.0',
    token: session,
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...extra,
  }
}

/** Pull a human message out of any of the three error dialects. */
function failureMessage(parsed: unknown, fallback: string): string {
  if (isRecord(parsed)) {
    const error = parsed['error']
    if (isRecord(error)) {
      const message = asString(error['message'])
      if (message !== undefined) return message
    }
    for (const key of ['desc', 'message', 'msg']) {
      const value = asString(parsed[key])
      if (value !== undefined) return value
    }
  }
  return fallback
}

/** Pull the upstream trace id, preserved for diagnostics (never a secret). */
function traceIdOf(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  return asString(parsed['trace_id']) ?? asString(parsed['traceId'])
}

/** Pull a business code out of the envelope or OpenAI-style error. */
function codeOf(parsed: unknown, fallback: string): string {
  if (!isRecord(parsed)) return fallback
  const envelope = parsed['code']
  if (typeof envelope === 'string' && envelope.length > 0) return envelope
  if (typeof envelope === 'number' && Number.isFinite(envelope)) return String(envelope)
  const error = parsed['error']
  if (isRecord(error)) {
    const inner = error['code']
    if (typeof inner === 'string' && inner.length > 0) return inner
    if (typeof inner === 'number' && Number.isFinite(inner)) return String(inner)
  }
  return fallback
}

function isSuccessEnvelope(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false
  const code = parsed['code']
  if (typeof code === 'string') return SUCCESS_CODES.has(code)
  if (typeof code === 'number') return SUCCESS_CODES.has(String(code))
  // No code field at all: `/models` success shape. Callers validate the shape.
  return false
}

/**
 * Perform one platform request and classify its answer.
 *
 * A transport failure is reported as `code: 'network'`/`'timeout'`; a non-JSON
 * answer keeps its HTTP status as the code and the body text as the message.
 */
export async function requestPlatform(options: PlatformRequestOptions): Promise<PlatformResult> {
  const { baseURL, path, session } = options
  const method = options.method ?? 'GET'
  const url = `${joinUrl(baseURL, path)}${buildQuery(options.query)}`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()

  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers: platformHeaders(session, options.body !== undefined, options.headers),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    const name = isRecord(error) ? error['name'] : undefined
    const message = safeErrorMessage(error)
    const code = name === 'AbortError' || /timed out|abort/iu.test(message) ? 'timeout' : 'network'
    return {
      kind: 'failure',
      code,
      message: code === 'timeout' ? `platform request to ${path} timed out after ${timeoutMs}ms` : message,
    }
  } finally {
    clearTimeout(timer)
  }

  const status = response.status
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return { kind: 'failure', code: 'network', message: safeErrorMessage(error), status }
  }

  let parsed: unknown
  let isJson = true
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    isJson = false
  }

  if (!isJson) {
    const fallback = redactSensitive(text.trim()).slice(0, 500)
    return {
      kind: 'failure',
      code: String(status),
      message: fallback.length > 0 ? fallback : `HTTP ${status} (non-JSON answer)`,
      status,
    }
  }

  // OpenAI-style error dialect (real HTTP status, `{error:{message,...}}`).
  if (isRecord(parsed) && isRecord(parsed['error'])) {
    return {
      kind: 'failure',
      code: codeOf(parsed, String(status)),
      message: redactSensitive(failureMessage(parsed, `HTTP ${status}`)),
      status,
      ...(traceIdOf(parsed) === undefined ? {} : { traceId: traceIdOf(parsed) }),
    }
  }

  // Platform envelope: `code` is authoritative even on HTTP 200.
  if (isRecord(parsed) && 'code' in parsed) {
    if (!isSuccessEnvelope(parsed)) {
      const code = codeOf(parsed, String(status))
      return {
        kind: 'failure',
        code,
        message: redactSensitive(failureMessage(parsed, `upstream code ${code}`)),
        status,
        ...(traceIdOf(parsed) === undefined ? {} : { traceId: traceIdOf(parsed) }),
      }
    }
    return { kind: 'ok', body: parsed, data: parsed['data'] ?? parsed }
  }

  if (!response.ok) {
    return {
      kind: 'failure',
      code: String(status),
      message: redactSensitive(failureMessage(parsed, `HTTP ${status}`)),
      status,
    }
  }

  // `/models` and other success bodies that carry no envelope.
  return { kind: 'ok', body: parsed, data: parsed }
}

/** Narrowing helper for numeric payload members. */
export { asNumber }

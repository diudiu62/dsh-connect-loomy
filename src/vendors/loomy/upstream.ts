/**
 * Loomy **平台**端点（`/models`、`/points/*`、`/user/identity`）的 HTTP 客户端。
 *
 * 这些端点用裸 `token: <session>` 头鉴权；对话端点用 `Authorization: Bearer`，
 * 两者**不可互换**（裸 token 打到 `/chat/completions` 只会得到 HTTP 200 +
 * `100002 缺少 token`）。协议细节从旧的 `src/shared/upstream.ts` 原样迁移，只换了
 * 归属；改动这里等于改动抓包证据。
 *
 * 两个上游怪癖决定了本文件的形状：
 *
 * 1. **失败是 HTTP 200 + 业务码信封**：判定依据是 `code`，不是状态行。`000000`
 *    是成功，其它都是失败且 `desc` 原样上报；
 * 2. **`/models` 的成功响应根本没有 `code` 字段**（只有错误才有），所以判据是
 *    "有 code 且不是成功码"，而没有 code 但形状正确的响应照样接受。
 *
 * @module dsh-connect-desktop/vendors/loomy/upstream
 */

import { asString, isRecord, redactSensitive, safeErrorMessage } from '../../shared/text.js'

/** 平台用过的成功码。 */
const SUCCESS_CODES = new Set(['000000', '0', '200'])

/** 一次平台调用的结果。 */
export type PlatformResult =
  | { kind: 'ok'; body: unknown; data: unknown }
  | {
      kind: 'failure'
      /** 上游业务码、HTTP 状态，或本地传输错误码。 */
      code: string
      /** 上游 `desc`/`message` 原文（仅做敏感信息脱敏）。 */
      message: string
      status?: number
      traceId?: string
    }

/** {@link requestPlatform} 的入参。 */
export interface PlatformRequestOptions {
  baseURL: string
  /** 以 `/` 开头的上游路径。 */
  path: string
  /** 会话令牌。永不写日志。 */
  session: string
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | boolean | undefined>
  /** POST 的 JSON 请求体。 */
  body?: unknown
  timeoutMs?: number
  /** 测试可注入；默认 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch
  /** 额外请求头（测试 / 诊断）。 */
  headers?: Record<string, string>
}

/** 拼接 base URL 与绝对路径，不产生重复斜杠。 */
export function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/** `/models` 的完整 URL。 */
export function modelsUrl(baseURL: string): string {
  return joinUrl(baseURL, '/models')
}

/** `/points/records` 的完整 URL。 */
export function pointsUrl(baseURL: string): string {
  return joinUrl(baseURL, '/points/records')
}

/** `/user/identity` 的完整 URL。 */
export function identityUrl(baseURL: string): string {
  return joinUrl(baseURL, '/user/identity')
}

/** `/chat/completions` 的完整 URL（仅用于诊断文案）。 */
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

/** 平台请求头：`token`，永不 `Authorization`。 */
export function platformHeaders(
  session: string,
  hasBody = false,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    accept: 'application/json',
    'user-agent': 'dsh-connect-desktop/0.2.0',
    token: session,
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...extra,
  }
}

/** 从三种错误方言里抽出人话（OpenAI 风格、平台信封、裸 msg）。 */
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

/** 上游 trace id，保留给诊断（不是秘密）。 */
function traceIdOf(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  return asString(parsed['trace_id']) ?? asString(parsed['traceId'])
}

/** 从信封或 OpenAI 风格错误里抽出业务码。 */
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
  // 没有 code 字段：`/models` 的成功形状，由调用方校验形状。
  return false
}

/**
 * 发一次平台请求并分类响应。
 *
 * 传输失败报 `code: 'network'`/`'timeout'`；非 JSON 响应保留 HTTP 状态作为 code、
 * 正文作为 message。
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

  // OpenAI 风格错误（真实 HTTP 状态 + `{error:{message,…}}`）。
  if (isRecord(parsed) && isRecord(parsed['error'])) {
    return {
      kind: 'failure',
      code: codeOf(parsed, String(status)),
      message: redactSensitive(failureMessage(parsed, `HTTP ${status}`)),
      status,
      ...(traceIdOf(parsed) === undefined ? {} : { traceId: traceIdOf(parsed) }),
    }
  }

  // 平台信封：即使 HTTP 200，`code` 也是权威。
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

  // `/models` 以及其它不带信封的成功响应。
  return { kind: 'ok', body: parsed, data: parsed }
}

/**
 * 把一次平台失败包成 `Error`，并把上游业务码挂在 `.code` 上。
 *
 * core 的目录/积分 store 用 `error.code` 记录 `lastError`，所以业务码必须随异常
 * 一起传下去，否则卡片只知道"失败了"，说不出上游到底回了什么。
 */
export function platformError(code: string, message: string, traceId?: string): Error {
  const error = new Error(message) as Error & { code: string; traceId?: string }
  error.code = code
  if (traceId !== undefined) error.traceId = traceId
  return error
}

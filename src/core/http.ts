/**
 * The HTTP guard pipeline, written once for every vendor.
 *
 * Before this module each vendor carried its own copy of: the method check, the
 * loopback check, the JSON content-type check, the constant-time CSRF compare,
 * the 64 KiB body cap, the `{ok:false,error}` envelope and the try/catch that
 * turns a thrown handler into a 500 instead of a dropped socket. Two copies had
 * already drifted (one had no body cap, one used a weaker loopback test).
 *
 * Guards, in order: method → loopback (Host + Origin) → content type + CSRF for
 * mutating verbs → 64 KiB body → JSON response with `cache-control: no-store`.
 *
 * @module dsh-connect-desktop/core/http
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { checkLoopback } from '../shared/loopback.js'
import { isRecord, safeErrorMessage } from '../shared/text.js'
import type { FailureView } from '../shared/views.js'
import type { Logger } from '../vendor-sdk/contracts.js'

/** Largest request body any write accepts. */
export const MAX_BODY_BYTES = 64 * 1024

/** Header carrying the process-level CSRF token. One name for all vendors. */
export const CSRF_HEADER = 'x-dsh-connect-csrf'

/** Write a JSON body with the anti-caching headers the card needs. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Write the unified failure envelope. */
export function failure(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, error: { code, message } } satisfies FailureView)
}

/** Constant-time CSRF comparison; a missing or empty supply never matches. */
export function csrfMatches(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined || supplied.length === 0) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(supplied, 'utf8')
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

function isJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers['content-type']
  if (typeof value !== 'string') return false
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/** Read the request body, refusing anything over {@link MAX_BODY_BYTES}. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Parse the body as a JSON object; `undefined` when it is not one. */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const text = await readBody(req)
  if (text === undefined || text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

/** One route invocation. */
export interface RouteCall {
  req: IncomingMessage
  res: ServerResponse
  query: URLSearchParams
  /** Parsed JSON body; `undefined` when the body is not a JSON object. */
  body(): Promise<Record<string, unknown> | undefined>
}

/**
 * One route a vendor offers.
 *
 * The handler **returns** its payload: the pipeline writes it. Returning
 * `undefined` means "I already answered" (a handler that needed a non-200
 * status), which is the only case that needs manual `failure()`.
 */
export interface RouteSpec {
  /** Path suffix under the vendor namespace, e.g. `accounts/rename`. */
  suffix: string
  methods: readonly ('GET' | 'POST')[]
  /** Guards: JSON content type + CSRF for anything but GET. */
  mutating: boolean
  run(call: RouteCall): Promise<unknown>
}

/** Wrap one spec's handler with the shared guard pipeline. */
function guarded(spec: RouteSpec, csrfToken: string, logger?: Logger) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!spec.methods.includes(req.method as 'GET' | 'POST')) {
      failure(res, 405, 'method_not_allowed', `只支持 ${spec.methods.join(' / ')}`)
      return
    }
    const verdict = checkLoopback(req)
    if (!verdict.ok) {
      failure(
        res,
        403,
        verdict.reason === 'host' ? 'host_not_allowed' : 'origin_not_allowed',
        verdict.reason === 'host'
          ? 'Host 头不指向本机监听地址（DNS rebinding 防护）'
          : 'Origin 不是本机来源（CSRF 防护）',
      )
      return
    }
    // CSRF guards state changes only: a route that accepts both verbs must
    // still answer a plain GET without a token.
    if (spec.mutating && req.method !== 'GET') {
      if (!isJsonContentType(req)) {
        failure(res, 415, 'unsupported_media_type', 'POST 请求必须使用 Content-Type: application/json')
        return
      }
      if (!csrfMatches(csrfToken, req.headers[CSRF_HEADER] as string | undefined)) {
        failure(
          res,
          403,
          'csrf_invalid',
          `缺少或无效的 ${CSRF_HEADER} 令牌：DSH 重启后令牌会轮换，客户端会自动重取一次；` +
            '仍失败请刷新页面。若刷新后持续出现，说明本插件在同一进程里被挂载了两次（日志里有「已被另一个插件实例注册」）。',
        )
        return
      }
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const payload = await spec.run({
        req,
        res,
        query: url.searchParams,
        body: () => readJsonObject(req),
      })
      if (payload !== undefined && !res.headersSent) json(res, 200, payload)
    } catch (error) {
      logger?.warn('dsh-connect-desktop: route failed', error)
      if (!res.headersSent) failure(res, 500, 'internal', safeErrorMessage(error))
    }
  }
}

export interface MountOptions {
  /** Vendor namespace segment (`loomy`, `raccoon`, …). */
  vendorId: string
  csrfToken: string
  specs: readonly RouteSpec[]
  logger?: Logger
  /** Full path for one suffix; the caller owns the prefix policy. */
  pathFor: (suffix: string) => string
}

/**
 * Register every spec on whatever context owns `webServer`.
 *
 * A disabled vendor passes `specs: []`, so it registers **nothing** — the old
 * wiring registered all handlers and only skipped the provider, which meant
 * "disabled" still exposed the credential export route.
 */
export function mountRoutes(ctx: Context, options: MountOptions): void {
  if (options.specs.length === 0) return
  // 宿主按 `(kind, path)` 唯一注册，第二次同路径会抛错并连带丢掉这家后续的路由。
  // 在 **挂载前** 就把它变成一条可读的错误：否则失败发生在 web.effect 里，表现为
  // "所有面板都说宿主未提供该路由"，排查成本极高。同一个 suffix 的多个动词必须
  // 合成一条 spec（`methods: ['GET','POST']`）。
  const seen = new Map<string, string>()
  for (const spec of options.specs) {
    const path = options.pathFor(spec.suffix)
    const previous = seen.get(path)
    if (previous !== undefined) {
      throw new Error(
        `dsh-connect-desktop: ${options.vendorId} 重复注册了 ${path}（${previous} 与 ${spec.methods.join('/')}）。` +
          '同一个 suffix 的多个动词必须合成一条 RouteSpec。',
      )
    }
    seen.set(path, spec.methods.join('/'))
  }
  ctx.inject(['webServer'], (web) => {
    web.effect(() => {
      const disposers: Array<() => void> = []
      for (const spec of options.specs) {
        const path = options.pathFor(spec.suffix)
        try {
          disposers.push(
            web.webServer.register({
              kind: 'exact',
              path,
              handler: guarded(spec, options.csrfToken, options.logger),
            }),
          )
        } catch (error) {
          // 同一进程里本插件被挂载了两次时，路径已被前一份占用。让位而不是抛错：
          // 抛出去会连带丢掉这一份**后续所有**路由，比缺一条更糟。
          const message = error instanceof Error ? error.message : String(error)
          if (!/duplicate/u.test(message)) throw error
          options.logger?.warn(
            `dsh-connect-desktop: ${options.vendorId} 的 ${path} 已被另一个插件实例注册，本实例让位`,
          )
        }
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, `dsh-connect-desktop: ${options.vendorId} routes`)
  })
}

/**
 * Register a single plugin-level route (not namespaced by vendor).
 *
 * Only `GET /status` needs this: it answers for every vendor at once, which is
 * what lets the card open with one request instead of one per vendor.
 */
export function mountAt(
  ctx: Context,
  options: { path: string; csrfToken: string; spec: RouteSpec; logger?: Logger },
): void {
  ctx.inject(['webServer'], (web) => {
    web.effect(() => {
      let dispose: (() => void) | undefined
      try {
        dispose = web.webServer.register({
          kind: 'exact',
          path: options.path,
          handler: guarded(options.spec, options.csrfToken, options.logger),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/duplicate/u.test(message)) throw error
        // 双挂载：状态路由已经有人服务，本实例让位（不抛错，免得影响后续挂载）。
        options.logger?.warn(`dsh-connect-desktop: ${options.path} 已被另一个插件实例注册，本实例让位`)
      }
      return () => {
        dispose?.()
      }
    }, `dsh-connect-desktop: ${options.path}`)
  })
}

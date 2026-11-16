/**
 * Host HTTP routes for the settings card (contract v2).
 *
 * Five exact routes under `/plugins/dsh-connect-loomy`:
 *
 * | route | method | purpose |
 * | --- | --- | --- |
 * | `/status` | GET | sign-in, credential, catalog counters, saved selection, CSRF token |
 * | `/diagnostics` | GET | upstream probes, credential candidates, last error verbatim |
 * | `/credits` | GET | read-only points overview (60s TTL, single-flight) |
 * | `/refresh` | POST | force a catalog refresh, persisted immediately |
 * | `/save` | POST | persist the selection and hot-update the model list |
 *
 * Guards, in order: method → loopback (Host + Origin) → JSON content type and
 * process-level CSRF token for the two POSTs → JSON response with
 * `cache-control: no-store` everywhere. The browser never receives the session
 * token: every value below is already host-computed and redacted.
 *
 * @module dsh-connect-loomy/routes
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AuthStore } from './auth.js'
import type { LoginService } from './login.js'
import { accountViewOf, credentialViewOf, nextStepsFor } from './auth.js'
import { catalogUrls, type CatalogStore } from './catalog.js'
import { fetchIdentity, type CreditsCache } from './credits.js'
import type {
  AuthLoginView,
  AuthLogoutView,
  AuthSendCodeView,
  AuthStateView,
  CredentialCandidateView,
  DiagnosticsProbe,
  DiagnosticsView,
  FailureView,
  RefreshView,
  SaveView,
  StatusView,
  UpstreamErrorView,
} from './shared/types.js'
import { ROUTES } from './shared/types.js'
import { checkLoopback } from './shared/loopback.js'
import { isRecord, safeErrorMessage } from './shared/text.js'

/** Largest request body the two POSTs accept. */
const MAX_BODY_BYTES = 64 * 1024

/** Dependencies the routes read; all state lives in the host process. */
export interface RouteDeps {
  auth: AuthStore
  catalog: CatalogStore
  credits: CreditsCache
  login: LoginService
  /** Process-level token minted once per plugin instance. */
  csrfToken: string
  baseURL: () => string
  fetchImpl?: typeof fetch
  now?: () => number
  logger?: { warn(message: string, error?: unknown): void }
}

function corsSafeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function failure(res: ServerResponse, status: number, code: string, message: string): void {
  corsSafeJson(res, status, { ok: false, error: { code, message } } satisfies FailureView)
}

function csrfMatches(expected: string, supplied: string | undefined): boolean {
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

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
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

function errorView(failureView: UpstreamErrorView): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: failureView.code, message: failureView.message } }
}

/** Build the `GET /status` payload. Never throws for a signed-out host. */
export async function buildStatus(deps: RouteDeps): Promise<StatusView> {
  const snapshot = await deps.auth.read()
  if (snapshot.found) {
    // First run / stale cache: fetch so `enabledModelIds` can list every chat
    // model instead of making the card guess. A failure is reported, not faked.
    await deps.catalog.ensure({ allowNetwork: true })
  } else {
    await deps.catalog.hydrate()
  }
  const models = deps.catalog.current()
  const enabledModelIds = deps.catalog.enabledIds()
  const refreshedAt = deps.catalog.refreshedAt()
  const lastError = deps.catalog.lastError()
  const nextSteps = !snapshot.found
    ? nextStepsFor(snapshot)
    : models.length === 0
      ? [
          '模型目录为空：请点「刷新」重新读取上游 /models；插件不会把目录外的模型发给上游（上游会静默回落并扣费）。',
          ...(lastError === undefined ? [] : [`最近一次上游错误：${lastError.code} ${lastError.message}`]),
        ]
      : undefined
  return {
    ok: true,
    csrfToken: deps.csrfToken,
    account: accountViewOf(snapshot),
    credential: credentialViewOf(snapshot),
    catalog: { total: models.length, enabled: enabledModelIds.length, refreshedAt },
    enabledModelIds,
    ...(nextSteps === undefined ? {} : { nextSteps }),
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/** Build the `GET /diagnostics` payload; every upstream message stays verbatim. */
export async function buildDiagnostics(deps: RouteDeps): Promise<DiagnosticsView> {
  // "Re-check" must observe a just-finished desktop login, so bypass the 5s
  // session cache here rather than only in the card's refresh path.
  const snapshot = await deps.auth.read({ force: true })
  const urls = catalogUrls(deps.baseURL())
  const probes: DiagnosticsProbe[] = []
  const account = accountViewOf(snapshot)

  if (!snapshot.found) {
    const reason = snapshot.problem ?? `未找到 Loomy 登录态（${snapshot.sourcePath}）`
    probes.push(
      { path: '/models', ok: false, reason },
      { path: '/points/records', ok: false, reason },
      { path: '/user/identity', ok: false, reason },
    )
    await deps.catalog.hydrate()
  } else {
    const [models, points, identity] = await Promise.all([
      deps.catalog.refresh(),
      deps.credits.read({ force: true }),
      fetchIdentity({
        baseURL: deps.baseURL(),
        session: { session: snapshot.session, sourcePath: snapshot.sourcePath },
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      }),
    ])
    probes.push(
      models.kind === 'ok'
        ? {
            path: '/models',
            ok: true,
            reason: `ok（${models.snapshot.models.length} 个聊天模型，已刷新目录缓存）`,
          }
        : { path: '/models', ok: false, reason: models.failure.message },
      points.kind === 'ok'
        ? {
            path: '/points/records',
            ok: true,
            reason: `ok（可用 ${points.credits.availableBalance}，今日额度剩余 ${points.credits.dailyBalance}）`,
          }
        : { path: '/points/records', ok: false, reason: points.failure.message },
      identity.kind === 'ok'
        ? { path: '/user/identity', ok: true, reason: 'ok（登录态有效）' }
        : { path: '/user/identity', ok: false, reason: identity.failure.message },
    )
  }

  const models = deps.catalog.current()
  const enabledIds = deps.catalog.enabledIds()
  const lastError = deps.catalog.lastError()
  return {
    ok: true,
    probes,
    upstream: urls,
    account: account === null ? null : { maskedPhone: account.maskedPhone, userId: account.userId },
    catalog: { total: models.length, enabled: enabledIds.length },
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/** Credential candidates as `GET /diagnostics` needs them (not currently in v2). */
export function credentialCandidatesOf(snapshot: {
  candidates: readonly CredentialCandidateView[]
}): CredentialCandidateView[] {
  return snapshot.candidates.map((candidate) => ({ ...candidate }))
}

/** One route spec before guards are applied. */
interface RouteSpec {
  path: string
  method: 'GET' | 'POST'
  mutating: boolean
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

function routeHandler(deps: RouteDeps, spec: RouteSpec) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== spec.method) {
      failure(res, 405, 'method_not_allowed', `只支持 ${spec.method}`)
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
    if (spec.mutating) {
      if (!isJsonContentType(req)) {
        failure(res, 415, 'unsupported_media_type', 'POST 请求必须使用 Content-Type: application/json')
        return
      }
      if (!csrfMatches(deps.csrfToken, req.headers['x-loomy-csrf'] as string | undefined)) {
        failure(res, 403, 'csrf_invalid', '缺少或无效的 x-loomy-csrf 令牌；请先 GET /status 获取 csrfToken')
        return
      }
    }
    try {
      await spec.run(req, res)
    } catch (error) {
      deps.logger?.warn('dsh-connect-loomy: route failed', error)
      if (!res.headersSent) failure(res, 500, 'internal', safeErrorMessage(error))
    }
  }
}

/** Register the five exact routes on whatever context owns `webServer`. */
export function registerLoomyRoutes(ctx: Context, deps: RouteDeps): void {
  const specs: RouteSpec[] = [
    {
      path: ROUTES.status,
      method: 'GET',
      mutating: false,
      run: async (_req, res) => {
        corsSafeJson(res, 200, await buildStatus(deps))
      },
    },
    {
      path: ROUTES.diagnostics,
      method: 'GET',
      mutating: false,
      run: async (_req, res) => {
        corsSafeJson(res, 200, await buildDiagnostics(deps))
      },
    },
    {
      path: ROUTES.credits,
      method: 'GET',
      mutating: false,
      run: async (_req, res) => {
        const result = await deps.credits.read()
        if (result.kind === 'failure') {
          // Contract v2: HTTP 200 + ok:false so the card renders a truthful
          // upstream failure instead of treating it as a missing route.
          corsSafeJson(res, 200, errorView(result.failure))
          return
        }
        corsSafeJson(res, 200, { ok: true, ...result.credits })
      },
    },
    {
      path: ROUTES.refresh,
      method: 'POST',
      mutating: true,
      run: async (req, res) => {
        const body = await readJsonObject(req)
        if (body === undefined) {
          failure(res, 400, 'bad_request', '请求体必须是 JSON 对象')
          return
        }
        const result = await deps.catalog.refresh()
        if (result.kind === 'failure') {
          corsSafeJson(res, 200, errorView(result.failure))
          return
        }
        const refreshedAt = result.snapshot.refreshedAt ?? (deps.now ?? (() => Date.now()))()
        const payload: RefreshView = {
          ok: true,
          catalog: deps.catalog.view(),
          refreshedAt,
        }
        corsSafeJson(res, 200, payload)
      },
    },
    {
      path: ROUTES.save,
      method: 'POST',
      mutating: true,
      run: async (req, res) => {
        const body = await readJsonObject(req)
        if (body === undefined) {
          failure(res, 400, 'bad_request', '请求体必须是 JSON 对象')
          return
        }
        const ids = body['enabledModelIds']
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          failure(res, 400, 'bad_request', 'enabledModelIds 必须是字符串数组')
          return
        }
        const result = await deps.catalog.saveSelection(ids as string[])
        if (result.kind === 'failure') {
          corsSafeJson(res, 200, errorView(result.failure))
          return
        }
        const payload: SaveView = { ok: true, enabled: result.enabled }
        corsSafeJson(res, 200, payload)
      },
    },
    {
      path: ROUTES.authState,
      method: 'GET',
      mutating: false,
      run: async (_req, res) => {
        const snapshot = await deps.auth.read()
        const payload: AuthStateView = {
          ok: true,
          pluginLoggedIn: snapshot.sourceOrigin === 'plugin',
          effectiveSource:
            snapshot.found === false
              ? 'none'
              : snapshot.sourceOrigin === 'plugin'
                ? 'plugin'
                : snapshot.sourceOrigin === 'env'
                  ? 'env'
                  : 'desktop',
          ...(snapshot.found ? { ...(snapshot.maskedPhone === undefined ? {} : { maskedPhone: snapshot.maskedPhone }) } : {}),
          ...(snapshot.found && snapshot.maskedUserId !== undefined ? { maskedUserId: snapshot.maskedUserId } : {}),
          ...(snapshot.found && snapshot.loginAt !== undefined ? { loginAt: snapshot.loginAt } : {}),
        }
        corsSafeJson(res, 200, payload)
      },
    },
    {
      path: ROUTES.authSendCode,
      method: 'POST',
      mutating: true,
      run: async (req, res) => {
        const body = await readJsonObject(req)
        if (body === undefined) {
          failure(res, 400, 'bad_request', '请求体必须是 JSON 对象')
          return
        }
        const phone = body['phone']
        if (typeof phone !== 'string') {
          failure(res, 400, 'bad_request', 'phone 必须是字符串')
          return
        }
        const result = await deps.login.sendCode(phone)
        const payload: AuthSendCodeView = result.ok
          ? { ok: true, maskedPhone: result.maskedPhone, resendAfterMs: result.resendAfterMs, expiresMs: result.expiresMs }
          : { ok: false }
        if (!result.ok) {
          corsSafeJson(res, 200, { ...payload, error: { code: result.code, message: result.message } })
          return
        }
        corsSafeJson(res, 200, payload)
      },
    },
    {
      path: ROUTES.authLogin,
      method: 'POST',
      mutating: true,
      run: async (req, res) => {
        const body = await readJsonObject(req)
        if (body === undefined) {
          failure(res, 400, 'bad_request', '请求体必须是 JSON 对象')
          return
        }
        const phone = body['phone']
        const code = body['code']
        if (typeof phone !== 'string' || typeof code !== 'string') {
          failure(res, 400, 'bad_request', 'phone 与 code 必须是字符串')
          return
        }
        const result = await deps.login.login(phone, code)
        if (!result.ok) {
          corsSafeJson(res, 200, { ok: false, error: { code: result.code, message: result.message } })
          return
        }
        const payload: AuthLoginView = {
          ok: true,
          ...(result.maskedPhone === undefined ? {} : { maskedPhone: result.maskedPhone }),
          ...(result.maskedUserId === undefined ? {} : { maskedUserId: result.maskedUserId }),
        }
        corsSafeJson(res, 200, payload)
      },
    },
    {
      path: ROUTES.authLogout,
      method: 'POST',
      mutating: true,
      run: async (_req, res) => {
        const result = await deps.login.logout()
        const payload: AuthLogoutView = result.ok
          ? { ok: true, message: result.message }
          : { ok: false, message: result.message }
        corsSafeJson(res, 200, payload)
      },
    },
  ]

  ctx.inject(['webServer'], (web) => {
    web.effect(() => {
      const disposers = specs.map((spec) =>
        web.webServer.register({
          kind: 'exact',
          path: spec.path,
          handler: routeHandler(deps, spec),
        }),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-connect-loomy: card routes')
  })
}

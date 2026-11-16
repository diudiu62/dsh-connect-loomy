/**
 * Discovery and parsing of the Loomy desktop client's sign-in file.
 *
 * The file (`auth-session.json`, verified path in docs/loomy-upstream.md §1.1)
 * is **read-only** to this plugin. It contains four fields:
 * `{session, userid, phone, updatedAt}`. The session is a bearer secret; the
 * phone and user id are PII. Therefore:
 *
 * - the raw session is never written to disk, a log, an HTTP response or the
 *   settings section;
 * - the public account view carries only `mask*` forms;
 * - the raw value lives in this module's in-memory snapshot, re-read at most
 *   every {@link DEFAULT_SESSION_TTL_MS} milliseconds so a desktop re-login is
 *   picked up without restarting DSH.
 *
 * A missing/corrupt file is a normal state ("signed out"), not a thrown error;
 * each failure reason maps to an executable `problem` string so the card can
 * tell the user what to do instead of showing "undefined".
 *
 * @module dsh-connect-loomy/auth
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { AccountView, CredentialCandidateView, CredentialView } from './shared/types.js'
import { DEFAULT_PRECHECK_TTL_MS, DEFAULT_SESSION_TTL_MS } from './shared/types.js'
import { asString, isRecord, maskPhone, maskUserId, safeErrorMessage, toEpochMs } from './shared/text.js'
import { authSessionCandidates, primaryAuthPath, type AuthCandidate } from './shared/paths.js'
import { identityUrl, requestPlatform } from './shared/upstream.js'

/** Why a credential candidate did not yield a session. */
export type AuthFailureReason = 'missing' | 'unreadable' | 'invalid_json' | 'invalid_shape' | 'encrypted'

/** One read of the desktop client's sign-in state. */
export interface AuthSnapshot {
  /** A usable session was found. */
  found: boolean
  /** The path that parsed, or the primary candidate when nothing did. */
  sourcePath: string
  /**
   * Where `sourcePath` came from: `plugin` (the settings card's own login),
   * `default` (the desktop client), or `env` (a pinned override). The card uses
   * it to say which sign-in is in effect.
   */
  sourceOrigin?: 'env' | 'default' | 'plugin'
  /** Every candidate inspected, in precedence order (doctor / diagnostics). */
  candidates: CredentialCandidateView[]
  /** Machine reason for a failed read. */
  reason?: AuthFailureReason
  /** Executable explanation; never contains the session. */
  problem?: string
  /** The raw session. In memory only — never serialise this object as-is. */
  session?: string
  /** Masked phone from the file (or `unknown`). */
  maskedPhone?: string
  /** Epoch ms of the credential's last change. */
  loginAt?: number
  /** Masked local user id. */
  maskedUserId?: string
  /** SHA-256 prefix of the session, used only to invalidate caches after re-login. */
  fingerprint?: string
}

/** Session fingerprint used to scope precheck caches; never reversible. */
export function sessionFingerprint(session: string): string {
  return createHash('sha256').update(session).digest('hex').slice(0, 16)
}

function candidateView(
  candidate: AuthCandidate,
  state: string,
  reason: string,
): CredentialCandidateView {
  return { path: candidate.path, exists: state !== 'missing', state, reason }
}

function failureProblem(path: string, reason: AuthFailureReason, detail?: string): string {
  switch (reason) {
    case 'missing':
      return `本机没有找到 Loomy 登录态文件（${path}）。请启动 Loomy 客户端并完成登录，然后点设置卡片的「重新检测」；无需重启 DSH。`
    case 'unreadable':
      return `Loomy 登录态文件存在但无法读取（${path}）${detail === undefined ? '' : `：${detail}`}。请检查文件权限（当前用户需要可读权限）。`
    case 'invalid_json':
      return `Loomy 登录态文件不是合法 JSON（${path}）${detail === undefined ? '' : `：${detail}`}。请在 Loomy 客户端重新登录后点「重新检测」。`
    case 'invalid_shape':
      return `Loomy 登录态文件缺少有效的 session 字段（${path}）${detail === undefined ? '' : `：${detail}`}。请在 Loomy 客户端重新登录后点「重新检测」。`
    case 'encrypted':
      return `该文件不是 Loomy 的明文登录态（${path}）。请确认登录的是 Loomy 客户端，而不是其它使用同名文件的产品。`
  }
}

function parseSessionDocument(text: string): { session: string; phone?: string; loginAt: number; userId?: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const session = asString(parsed['session'])
  if (session === undefined) return undefined
  if (session.length < 16 || /\s/u.test(session)) return undefined
  const phone = asString(parsed['phone'])
  const userId = asString(parsed['userid'])
  return {
    session,
    ...(phone === undefined ? {} : { phone }),
    loginAt: toEpochMs(parsed['updatedAt']),
    ...(userId === undefined ? {} : { userId }),
  }
}

/** Inspect every candidate path, first valid one wins. */
export async function readAuthSession(
  candidates: readonly AuthCandidate[] = authSessionCandidates(),
): Promise<AuthSnapshot> {
  const views: CredentialCandidateView[] = []
  let missingReason: { path: string; detail?: string } | undefined = undefined

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (candidate === undefined) continue
    let exists = true
    try {
      await stat(candidate.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        exists = false
        views.push(candidateView(candidate, 'missing', '文件不存在'))
        missingReason ??= { path: candidate.path }
        continue
      }
      views.push(candidateView(candidate, 'unreadable', safeErrorMessage(error)))
      missingReason ??= { path: candidate.path, detail: safeErrorMessage(error) }
      continue
    }
    if (!exists) continue

    let text: string
    try {
      text = await readFile(candidate.path, 'utf8')
    } catch (error) {
      views.push(candidateView(candidate, 'unreadable', safeErrorMessage(error)))
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'parse error'
      views.push(candidateView(candidate, 'invalid_json', detail))
      if (missingReason === undefined) missingReason = { path: candidate.path, detail }
      continue
    }
    if (isRecord(parsed) && (parsed['encrypted'] === true || (asString(parsed['session']) === undefined && asString(parsed['data']) !== undefined))) {
      views.push(candidateView(candidate, 'encrypted', 'encrypted payload (not this product)'))
      if (missingReason === undefined) missingReason = { path: candidate.path }
      continue
    }
    const document = parseSessionDocument(text)
    if (document === undefined) {
      views.push(candidateView(candidate, 'invalid_shape', 'missing or malformed session field'))
      if (missingReason === undefined) missingReason = { path: candidate.path, detail: '需要非空且不含空白的 session 字段' }
      continue
    }
    views.push(candidateView(candidate, 'ok', '已读取登录态'))
    return {
      found: true,
      sourcePath: candidate.path,
      sourceOrigin: candidate.origin,
      candidates: views,
      session: document.session,
      fingerprint: sessionFingerprint(document.session),
      maskedPhone: maskPhone(document.phone),
      maskedUserId: maskUserId(document.userId),
      loginAt: document.loginAt,
    }
  }

  const sourcePath = missingReason?.path ?? primaryAuthPath(candidates)
  const reason: AuthFailureReason =
    missingReason === undefined
      ? 'missing'
      : views.some((view) => view.state === 'invalid_json')
        ? 'invalid_json'
        : views.some((view) => view.state === 'invalid_shape')
          ? 'invalid_shape'
          : views.some((view) => view.state === 'encrypted')
            ? 'encrypted'
            : views.some((view) => view.state === 'unreadable')
              ? 'unreadable'
              : 'missing'
  return {
    found: false,
    sourcePath,
    candidates: views,
    reason,
    problem: failureProblem(sourcePath, reason, missingReason?.detail),
  }
}

/** Public account view, or `null` while signed out. */
export function accountViewOf(snapshot: AuthSnapshot): AccountView | null {
  if (!snapshot.found) return null
  return {
    maskedPhone: snapshot.maskedPhone ?? '未知',
    loginAt: snapshot.loginAt ?? 0,
    userId: snapshot.maskedUserId ?? '',
  }
}

/** Public credential view (path + conclusion, never the token). */
export function credentialViewOf(snapshot: AuthSnapshot): CredentialView {
  return { sourcePath: snapshot.sourcePath, found: snapshot.found }
}

/** Executable next steps shown while signed out. */
export function nextStepsFor(snapshot: AuthSnapshot): string[] {
  if (snapshot.found) return []
  const steps = [
    snapshot.problem ?? `请启动 Loomy 客户端并登录（本机路径：${snapshot.sourcePath}）。`,
    '登录完成后回到这里点「重新检测」；插件会在 5 秒内重新读取登录态，无需重启 DSH。',
  ]
  if (snapshot.reason === 'unreadable') {
    steps.push(`若登录态文件确实存在，请修复其读权限：${snapshot.sourcePath}`)
  }
  return steps
}

/** Error text used when a model request has no usable session. */
export function missingCredentialMessage(snapshot: AuthSnapshot): string {
  if (!snapshot.found) return snapshot.problem ?? `未找到 Loomy 登录态（${snapshot.sourcePath}）`
  return `Loomy 登录态不可用（${snapshot.sourcePath}）`
}

/** The auth service consumed by the provider, routes and CLI. */
export interface AuthStore {
  readonly candidates: readonly AuthCandidate[]
  /** Read the current snapshot, re-reading the file at most every TTL. */
  read(options?: { force?: boolean }): Promise<AuthSnapshot>
  /** Force the next read to hit the filesystem. */
  invalidate(): void
}

/** Create the in-memory auth cache. One per plugin; the CLI creates its own. */
export function createAuthStore(options: {
  candidates?: readonly AuthCandidate[]
  ttlMs?: () => number
  now?: () => number
} = {}): AuthStore {
  const candidates = options.candidates ?? authSessionCandidates()
  const now = options.now ?? (() => Date.now())
  const ttl = (): number => {
    const value = options.ttlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_SESSION_TTL_MS
  }
  let cached: AuthSnapshot | undefined
  let cachedAt = 0
  let pending: Promise<AuthSnapshot> | undefined
  return {
    candidates,
    read(readOptions = {}) {
      const fresh = cached !== undefined && now() - cachedAt < ttl()
      if (!readOptions.force && fresh) return Promise.resolve(cached as AuthSnapshot)
      pending ??= readAuthSession(candidates).then((snapshot) => {
        cached = snapshot
        cachedAt = now()
        return snapshot
      }).finally(() => {
        pending = undefined
      })
      return pending
    },
    invalidate() {
      cached = undefined
      cachedAt = 0
    },
  }
}

/** One precheck verdict. `definite` means the session is known to be invalid. */
export interface PrecheckVerdict {
  ok: boolean
  /** True only for an upstream answer that proves the session is dead. */
  definite: boolean
  code?: string
  /** Executable message that embeds the upstream `desc` verbatim. */
  message?: string
  /** Epoch ms the verdict was produced. */
  checkedAt: number
}

/**
 * Session precheck against `/user/identity`.
 *
 * Why it exists: chat authentication failures are HTTP 200 + a JSON envelope,
 * which pi-ai surfaces as a JSON/parse error. Without this probe the user sees
 * "pi-ai stream error" instead of "your Loomy sign-in expired, log in again".
 *
 * A **transport** failure does not block inference (a network blip must not
 * masquerade as a dead session); only `100002`/401/403 do. Verdicts — success
 * and definite failure alike — are cached for {@link DEFAULT_PRECHECK_TTL_MS}
 * and scoped to the session fingerprint, so a re-login invalidates them.
 *
 * `{ force: true }` bypasses the cached verdict for the rare end-of-stream
 * disambiguation (see `src/provider.ts`): a 200 + envelope answer reaches pi-ai
 * as a zero-token TRANSPORT truncation, so we re-probe the identity endpoint to
 * distinguish "retry the stream" from "the desktop session just died".
 */
export function createSessionPrecheck(options: {
  baseURL: () => string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  ttlMs?: () => number
  now?: () => number
  logger?: { warn(message: string): void }
}): (session: string, options?: { force?: boolean }) => Promise<PrecheckVerdict> {
  const now = options.now ?? (() => Date.now())
  const ttl = (): number => {
    const value = options.ttlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_PRECHECK_TTL_MS
  }
  let cached: { fingerprint: string; verdict: PrecheckVerdict } | undefined
  let pending: Promise<PrecheckVerdict> | undefined
  let pendingFingerprint = ''

  const run = async (session: string): Promise<PrecheckVerdict> => {
    const fingerprint = sessionFingerprint(session)
    const at = now()
    const answer = await requestPlatform({
      baseURL: options.baseURL(),
      path: '/user/identity',
      session,
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })
    if (answer.kind === 'ok') {
      const verdict: PrecheckVerdict = { ok: true, definite: false, checkedAt: at }
      cached = { fingerprint, verdict }
      return verdict
    }
    const definite =
      answer.code === '100002' ||
      answer.code === '401' ||
      answer.code === '403' ||
      answer.code === 'AUTH'
    if (definite) {
      const verdict: PrecheckVerdict = {
        ok: false,
        definite: true,
        code: answer.code,
        message: `本机 Loomy 登录态已失效（上游 ${answer.code}：${answer.message}）。请在 Loomy 客户端重新登录，然后点设置卡片的「重新检测」；无需重启 DSH。`,
        checkedAt: at,
      }
      cached = { fingerprint, verdict }
      return verdict
    }
    options.logger?.warn(
      `dsh-connect-loomy: identity precheck could not confirm the session (${answer.code}): ${answer.message}`,
    )
    return { ok: false, definite: false, code: answer.code, message: answer.message, checkedAt: at }
  }

  return async (session, options = {}) => {
    const fingerprint = sessionFingerprint(session)
    const snapshot = cached
    const fresh =
      snapshot !== undefined &&
      snapshot.fingerprint === fingerprint &&
      now() - snapshot.verdict.checkedAt < ttl()
    // `force` re-probes even inside the TTL, but still joins a probe that is
    // already in flight for the same session rather than starting a second one.
    if (!options.force && snapshot !== undefined && fresh) {
      return snapshot.verdict
    }
    if (pending !== undefined && pendingFingerprint === fingerprint) return pending
    pendingFingerprint = fingerprint
    pending = run(session).finally(() => {
      pending = undefined
    })
    return pending
  }
}

/** The identity URL is exported for diagnostics (shared with credits). */
export { identityUrl }

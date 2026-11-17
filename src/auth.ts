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
import type { AuthDiscovery } from './shared/discover.js'
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
  /**
   * Which stored account this session came from, when it came from the accounts
   * store. The provider needs it to attribute a failed call back to that
   * account; without it nothing can be marked unusable and the rotation filter
   * has nothing to filter on.
   */
  sourceAccountId?: string
  /** Every candidate inspected, in precedence order (doctor / diagnostics). */
  candidates: CredentialCandidateView[]
  /** Machine reason for a failed read. */
  reason?: AuthFailureReason
  /** Executable explanation; never contains the session. */
  problem?: string
  /** The raw session. In memory only — never serialise this object as-is. */
  session?: string
  /** Masked phone from the file (or `unknown`). */
  phone?: string
  /** Epoch ms of the credential's last change. */
  loginAt?: number
  /** Masked local user id. */
  userId?: string
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

/** One inspected candidate plus enough metadata to explain it to the user. */
interface InspectedCandidate {
  path: string
  origin: AuthCandidate['origin']
  state: string
}

function originLabel(origin: AuthCandidate['origin']): string {
  switch (origin) {
    case 'plugin':
      return '本插件登录'
    case 'env':
      return 'LOOMY_AUTH_SESSION_FILE'
    default:
      return 'Loomy 桌面端'
  }
}

/** Render "where we looked" without repeating the headline path. */
function describeInspected(inspected: readonly InspectedCandidate[]): string {
  const shown = inspected.slice(0, 10).map((entry) => `${entry.path}（${originLabel(entry.origin)}）`)
  const rest = inspected.length - shown.length
  return `${shown.join('、')}${rest > 0 ? `；另有 ${rest} 处候选` : ''}`
}

function failureProblem(
  path: string,
  reason: AuthFailureReason,
  detail?: string,
  inspected: readonly InspectedCandidate[] = [],
): string {
  switch (reason) {
    case 'missing':
      // Every candidate missed. Naming only one path used to read as "the
      // plugin looked at its own storage and gave up" — on Windows that path is
      // the plugin store, which the desktop client never writes, so the user
      // was told to log in to a file that only this plugin can create. List
      // every location actually inspected instead, and name the escape hatch.
      return `本机没有找到 Loomy 登录态文件。已查找：${describeInspected(inspected.length > 0 ? inspected : [{ path, origin: 'default', state: 'missing' }])}。请启动 Loomy 客户端并完成登录，然后点设置卡片的「重新检测」；无需重启 DSH。若 Loomy 装在其它位置，把它的 auth-session.json 路径写进环境变量 LOOMY_AUTH_SESSION_FILE 即可。`
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

function reasonOfState(state: string): AuthFailureReason {
  switch (state) {
    case 'unreadable':
      return 'unreadable'
    case 'invalid_json':
      return 'invalid_json'
    case 'invalid_shape':
      return 'invalid_shape'
    case 'encrypted':
      return 'encrypted'
    default:
      return 'missing'
  }
}

/** The four fields the desktop client writes; the raw session never leaves memory. */
interface SessionDocument {
  session: string
  phone?: string
  loginAt: number
  userId?: string
}

function parseSessionDocument(text: string): SessionDocument | undefined {
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

type ProbeOutcome =
  | { view: CredentialCandidateView; document: SessionDocument }
  | { view: CredentialCandidateView }

/**
 * Read and classify one candidate file.
 *
 * A missing or malformed file is a normal "signed out" state: the outcome
 * carries an executable `state`/`reason` pair instead of throwing, so the card
 * can explain what to do and the CLI can report it.
 */
async function probeAuthFile(candidate: AuthCandidate): Promise<ProbeOutcome> {
  try {
    await stat(candidate.path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { view: candidateView(candidate, 'missing', '文件不存在') }
    }
    return { view: candidateView(candidate, 'unreadable', safeErrorMessage(error)) }
  }

  let text: string
  try {
    text = await readFile(candidate.path, 'utf8')
  } catch (error) {
    return { view: candidateView(candidate, 'unreadable', safeErrorMessage(error)) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'parse error'
    return { view: candidateView(candidate, 'invalid_json', detail) }
  }
  if (isRecord(parsed) && (parsed['encrypted'] === true || (asString(parsed['session']) === undefined && asString(parsed['data']) !== undefined))) {
    return { view: candidateView(candidate, 'encrypted', 'encrypted payload (not this product)') }
  }
  const document = parseSessionDocument(text)
  if (document === undefined) {
    return { view: candidateView(candidate, 'invalid_shape', 'missing or malformed session field') }
  }
  return { view: candidateView(candidate, 'ok', '已读取登录态'), document }
}

/** Extra places to try when every fixed candidate missed. */
export interface ReadAuthOptions {
  /**
   * Bounded fallback search, called **only** when no candidate parsed.
   *
   * Left optional so a caller with an explicit candidate list (tests, `--json`
   * CLI runs pinned by `LOOMY_AUTH_SESSION_FILE`) can never be surprised by a
   * filesystem sweep of the real home directory.
   */
  discover?: () => Promise<string[]>
}

/**
 * Inspect every candidate path, first valid one wins.
 *
 * Order of inspection is the caller's precedence: the plugin's own login first
 * (when spliced in by `authSessionCandidatesWithPlugin`), then the desktop
 * client's paths. When none of them parses and `options.discover` is supplied,
 * a bounded search of the platform's app-data roots gets one last attempt — that
 * is what makes a Windows install in a non-standard `userData` directory work
 * instead of reporting "you never logged in".
 */
export async function readAuthSession(
  candidates: readonly AuthCandidate[] = authSessionCandidates(),
  options: ReadAuthOptions = {},
): Promise<AuthSnapshot> {
  const views: CredentialCandidateView[] = []
  const inspected: InspectedCandidate[] = []
  // Pushed from the async probe below; an array keeps the collected failures
  // visible to the post-loop report without relying on closure-write narrowing.
  const failures: Array<{ path: string; reason: AuthFailureReason; detail?: string }> = []

  const inspect = async (candidate: AuthCandidate, secondary = false): Promise<AuthSnapshot | undefined> => {
    const outcome = await probeAuthFile(candidate)
    views.push(outcome.view)
    inspected.push({ path: candidate.path, origin: candidate.origin, state: outcome.view.state })
    if ('document' in outcome) {
      const document = outcome.document
      return {
        found: true,
        sourcePath: candidate.path,
        sourceOrigin: candidate.origin,
        candidates: views,
        session: document.session,
        fingerprint: sessionFingerprint(document.session),
        phone: maskPhone(document.phone),
        userId: maskUserId(document.userId),
        loginAt: document.loginAt,
      }
    }
    // A file that exists but does not parse is a much better explanation than
    // "nothing here", so it outranks the missing candidates for the report —
    // but only for the caller's own candidates. A file the fallback scan
    // happened to find may belong to another product (an encrypted
    // `Vibe助手/auth-session.json` is a real example), and letting that rename
    // the whole failure to "encrypted" would be worse than "not found".
    if (!secondary && failures.length === 0 && outcome.view.state !== 'missing') {
      failures.push({ path: candidate.path, reason: reasonOfState(outcome.view.state), detail: outcome.view.reason })
    }
    return undefined
  }

  for (const candidate of candidates) {
    const found = await inspect(candidate)
    if (found !== undefined) return found
  }

  // Defence in depth for the env pin: `authSessionCandidates` already returns
  // the override alone, and the scan is skipped here too so no caller can pair
  // `LOOMY_AUTH_SESSION_FILE` with a sweep of the real home directory.
  const pinned = candidates.length === 1 && candidates[0]?.origin === 'env'
  if (options.discover !== undefined && !pinned) {
    let extra: readonly string[] = []
    try {
      extra = await options.discover()
    } catch {
      extra = []
    }
    const known = new Set(inspected.map((entry) => entry.path.toLowerCase()))
    for (const path of extra) {
      const key = path.toLowerCase()
      if (known.has(key)) continue
      known.add(key)
      const found = await inspect({ path, origin: 'default' }, true)
      if (found !== undefined) return found
    }
  }

  // Report the file the user is expected to produce (the desktop client's),
  // not this plugin's own store: the card renders this path as "未找到：<path>".
  const desktop = candidates.filter((candidate) => candidate.origin !== 'plugin')
  const failure = failures[0]
  const sourcePath = failure?.path ?? desktop[0]?.path ?? primaryAuthPath(candidates)
  const reason = failure?.reason ?? 'missing'
  return {
    found: false,
    sourcePath,
    candidates: views,
    reason,
    problem: failureProblem(sourcePath, reason, failure?.detail, inspected),
  }
}

/** Public account view, or `null` while signed out. */
export function accountViewOf(snapshot: AuthSnapshot): AccountView | null {
  if (!snapshot.found) return null
  return {
    phone: snapshot.phone ?? '未知',
    loginAt: snapshot.loginAt ?? 0,
    userId: snapshot.userId ?? '',
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
  /**
   * Bounded fallback search for the desktop sign-in file, used when no fixed
   * candidate parses (see `readAuthSession`). The host passes
   * `createAuthDiscovery()`; tests and pinned CLI runs leave it out.
   */
  discover?: AuthDiscovery
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
      const discoverer = options.discover
      pending ??= readAuthSession(
        candidates,
        discoverer === undefined ? {} : { discover: (): Promise<string[]> => discoverer() },
      ).then((snapshot) => {
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
      // A re-login may also have moved the file (a first-run Windows install
      // creates its userData directory only now), so drop the scan cache too.
      options.discover?.invalidate()
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

/**
 * Read-only points overview and identity probe.
 *
 * Contract v2 pins three things this module enforces:
 * - **v1** `/points/records` (v2 has no `availableBalance`, and its
 *   `granularity=turn&direction=debit` combination currently answers `100001`);
 * - a host-side 60s TTL plus single-flight, because the card re-renders often;
 * - a failure is reported as a failure — balances are never fabricated as `0`
 *   and a failed read is never stored as a successful snapshot.
 *
 * `availableBalance` is the redundant third bucket the upstream returns; it is
 * `balance + dailyBalance` (daily quota is spent first). We report the three
 * values as received rather than recomputing, so a future upstream change is
 * visible instead of hidden behind arithmetic.
 *
 * @module dsh-connect-loomy/credits
 */

import type { CreditRecordView, CreditsView, UpstreamErrorView } from './shared/types.js'
import {
  DEFAULT_CREDITS_PAGE_SIZE,
  DEFAULT_CREDITS_TTL_MS,
  MAX_CREDITS_PAGE_SIZE,
} from './shared/types.js'
import { asNumber, asString, isRecord, redactSensitive, safeErrorMessage, toEpochMs } from './shared/text.js'
import { requestPlatform } from './shared/upstream.js'

/** Session facts the reader needs; shared shape with `src/auth.ts`. */
export interface CreditsSession {
  session?: string
  sourcePath: string
  problem?: string
}

/** A points snapshot, or a truthful failure. */
export type CreditsResult =
  | { kind: 'ok'; credits: CreditsView }
  | { kind: 'failure'; failure: UpstreamErrorView }

/** One identity answer. */
export type IdentityResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'failure'; failure: UpstreamErrorView }

function failureOf(at: number, path: string, code: string, message: string, traceId?: string): UpstreamErrorView {
  return { at, path, code, message: redactSensitive(message), ...(traceId === undefined ? {} : { traceId }) }
}

/** Clamp the page size exactly like the upstream does (1–100, default 20). */
export function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_CREDITS_PAGE_SIZE
  return Math.min(MAX_CREDITS_PAGE_SIZE, Math.max(1, Math.trunc(value)))
}

/** Map one upstream ledger row; rows without numeric amounts are dropped. */
export function normalizeLedgerRow(raw: unknown): CreditRecordView | undefined {
  if (!isRecord(raw)) return undefined
  const pointsActual = asNumber(raw['pointsActual'])
  const balanceAfter = asNumber(raw['balanceAfter'])
  if (pointsActual === undefined || balanceAfter === undefined) return undefined
  const direction = raw['direction'] === 'credit' ? 'credit' : 'debit'
  return {
    description: asString(raw['description']) ?? '',
    direction,
    pointsActual,
    createdAt: toEpochMs(raw['createdAt']),
    balanceAfter,
  }
}

/** Parse a v1 points body into a view; missing buckets are a failure. */
export function parseCreditsPayload(
  body: unknown,
  fetchedAt: number,
): { kind: 'ok'; credits: CreditsView } | { kind: 'failure'; message: string } {
  const data = isRecord(body) && isRecord(body['data']) ? body['data'] : body
  if (!isRecord(data)) return { kind: 'failure', message: '积分响应不是 JSON 对象' }
  const balance = asNumber(data['balance'])
  const dailyBalance = asNumber(data['dailyBalance'])
  const availableBalance = asNumber(data['availableBalance'])
  if (balance === undefined || dailyBalance === undefined || availableBalance === undefined) {
    return {
      kind: 'failure',
      message: '积分响应缺少 balance / dailyBalance / availableBalance（不伪造 0，按上游失败上报）',
    }
  }
  const list = Array.isArray(data['list']) ? data['list'] : []
  const records: CreditRecordView[] = []
  for (const raw of list) {
    const row = normalizeLedgerRow(raw)
    if (row !== undefined) records.push(row)
  }
  return { kind: 'ok', credits: { balance, dailyBalance, availableBalance, fetchedAt, records } }
}

/** Fetch one points overview (no cache). */
export async function fetchCredits(options: {
  baseURL: string
  session: CreditsSession
  pageSize?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<CreditsResult> {
  const at = (options.now ?? (() => Date.now()))()
  if (options.session.session === undefined) {
    return {
      kind: 'failure',
      failure: failureOf(
        at,
        '/points/records',
        'not_signed_in',
        `未找到可用的 Loomy 登录态（${options.session.sourcePath}）${options.session.problem === undefined ? '' : `：${options.session.problem}`}`,
      ),
    }
  }
  const answer = await requestPlatform({
    baseURL: options.baseURL,
    path: '/points/records',
    session: options.session.session,
    query: { pageNo: 1, pageSize: clampPageSize(options.pageSize), recordType: 'all' },
    timeoutMs: options.timeoutMs ?? 15_000,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (answer.kind === 'failure') {
    return { kind: 'failure', failure: failureOf(at, '/points/records', answer.code, answer.message, answer.traceId) }
  }
  const parsed = parseCreditsPayload(answer.data, at)
  if (parsed.kind === 'failure') {
    return { kind: 'failure', failure: failureOf(at, '/points/records', 'bad_response', parsed.message) }
  }
  return { kind: 'ok', credits: parsed.credits }
}

/** Fetch `/user/identity` (used by diagnostics and the session precheck). */
export async function fetchIdentity(options: {
  baseURL: string
  session: CreditsSession
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<IdentityResult> {
  const at = (options.now ?? (() => Date.now()))()
  if (options.session.session === undefined) {
    return {
      kind: 'failure',
      failure: failureOf(
        at,
        '/user/identity',
        'not_signed_in',
        `未找到可用的 Loomy 登录态（${options.session.sourcePath}）${options.session.problem === undefined ? '' : `：${options.session.problem}`}`,
      ),
    }
  }
  const answer = await requestPlatform({
    baseURL: options.baseURL,
    path: '/user/identity',
    session: options.session.session,
    timeoutMs: options.timeoutMs ?? 10_000,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (answer.kind === 'failure') {
    return { kind: 'failure', failure: failureOf(at, '/user/identity', answer.code, answer.message, answer.traceId) }
  }
  return { kind: 'ok', data: isRecord(answer.data) ? answer.data : {} }
}

/** The cache handle the routes use. */
export interface CreditsCache {
  /** Cached read (60s TTL, single-flight) or a truthful failure. */
  read(options?: { force?: boolean }): Promise<CreditsResult>
}

/** Create the process-wide points cache. One per plugin. */
export function createCreditsCache(options: {
  baseURL: () => string
  readSession: () => Promise<CreditsSession>
  pageSize?: () => number
  ttlMs?: () => number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}): CreditsCache {
  const now = options.now ?? (() => Date.now())
  let cached: { credits: CreditsView; at: number } | undefined
  let pending: Promise<CreditsResult> | undefined
  const ttl = (): number => {
    const value = options.ttlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CREDITS_TTL_MS
  }
  const run = async (): Promise<CreditsResult> => {
    const session = await options.readSession()
    return fetchCredits({
      baseURL: options.baseURL(),
      session,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize() }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      now,
    })
  }
  return {
    async read(readOptions = {}) {
      const snapshot = cached
      const fresh = snapshot !== undefined && now() - snapshot.at < ttl()
      if (!readOptions.force && fresh && snapshot !== undefined) return { kind: 'ok', credits: snapshot.credits }
      if (pending !== undefined) return pending
      pending = run()
        .then((result) => {
          if (result.kind === 'ok') cached = { credits: result.credits, at: now() }
          // A failure deliberately leaves the previous snapshot untouched but
          // is never served as success: the caller sees the error.
          return result
        })
        .catch((error: unknown) => ({
          kind: 'failure' as const,
          failure: failureOf(now(), '/points/records', 'network', safeErrorMessage(error)),
        }))
        .finally(() => {
          pending = undefined
        })
      return pending
    },
  }
}

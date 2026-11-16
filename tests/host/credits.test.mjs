/**
 * Read-only points overview: envelope parsing, bucket arithmetic, the platform
 * `token:` header, truthful failures and the 60s single-flight cache.
 *
 * Contract v2 forbids fabricating balances: a failure must be a failure with
 * the upstream code/desc, never `0`, and a failed read must not be stored as a
 * successful snapshot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RAW_PHONE,
  SESSION,
  jsonResponse,
  platformFailure,
  pointsBody,
} from './helpers.mjs'
import {
  clampPageSize,
  createCreditsCache,
  fetchCredits,
  fetchIdentity,
  normalizeLedgerRow,
  parseCreditsPayload,
} from '../../lib/index.js'

const BASE = 'https://gateway.test/api/v1'
const SESSION_FACTS = { session: SESSION, sourcePath: '/tmp/auth-session.json' }
const NOW = 1_794_574_693_000

test('clampPageSize mirrors the upstream 1..100 clamp', () => {
  assert.equal(clampPageSize(undefined), 20)
  assert.equal(clampPageSize(0), 20)
  assert.equal(clampPageSize(-5), 20)
  assert.equal(clampPageSize(Number.NaN), 20)
  assert.equal(clampPageSize(1), 1)
  assert.equal(clampPageSize(100), 100)
  assert.equal(clampPageSize(101), 100)
  assert.equal(clampPageSize(3.9), 3)
})

test('parseCreditsPayload reports all three buckets and normalises ledger rows', () => {
  const parsed = parseCreditsPayload(pointsBody(), NOW)
  assert.equal(parsed.kind, 'ok')
  const credits = parsed.credits
  assert.equal(credits.balance, 35_500)
  assert.equal(credits.dailyBalance, 5_000)
  assert.equal(credits.availableBalance, 40_500)
  assert.equal(credits.availableBalance, credits.balance + credits.dailyBalance)
  assert.equal(credits.fetchedAt, NOW)
  assert.deepEqual(credits.records[0], {
    description: '邀请好友奖励',
    direction: 'credit',
    pointsActual: 5_000,
    createdAt: 1_794_574_693_000,
    balanceAfter: 40_500,
  })
  assert.equal(credits.records[1].direction, 'debit')
  assert.equal(credits.records[1].pointsActual, 120)
})

test('parseCreditsPayload never fabricates a missing bucket', () => {
  for (const missing of ['balance', 'dailyBalance', 'availableBalance']) {
    const body = pointsBody()
    delete body.data[missing]
    const parsed = parseCreditsPayload(body, NOW)
    assert.equal(parsed.kind, 'failure', `missing ${missing} must be a failure`)
    assert.match(parsed.message, /不伪造 0/u)
  }
  assert.equal(parseCreditsPayload('nope', NOW).kind, 'failure')
  assert.equal(parseCreditsPayload(null, NOW).kind, 'failure')
})

test('normalizeLedgerRow drops rows without a numeric amount', () => {
  assert.equal(normalizeLedgerRow({ description: 'x', direction: 'credit' }), undefined)
  assert.equal(normalizeLedgerRow({ pointsActual: 1 }), undefined)
  assert.equal(normalizeLedgerRow('nope'), undefined)
  assert.deepEqual(normalizeLedgerRow({ pointsActual: 1, balanceAfter: 2 }), {
    description: '',
    direction: 'debit',
    pointsActual: 1,
    createdAt: 0,
    balanceAfter: 2,
  })
})

test('fetchCredits uses the v1 query and the platform token header (never Bearer)', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return jsonResponse(pointsBody())
  }
  const result = await fetchCredits({ baseURL: BASE, session: SESSION_FACTS, fetchImpl, now: () => NOW })

  assert.equal(result.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/points/records?pageNo=1&pageSize=20&recordType=all`)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.token, SESSION, 'platform endpoints authenticate with token:')
  assert.equal(calls[0].init.headers.authorization, undefined, 'platform endpoints never use Authorization')
})

test('a 200 + business-code envelope is a failure with the desc verbatim', async () => {
  const fetchImpl = async () =>
    jsonResponse(platformFailure('100002', '登录已失效，请重新登录'), 200)
  const result = await fetchCredits({ baseURL: BASE, session: SESSION_FACTS, fetchImpl, now: () => NOW })

  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, '100002')
  assert.equal(result.failure.message, '登录已失效，请重新登录')
  assert.equal(result.failure.path, '/points/records')
  assert.equal(result.failure.at, NOW)
})

test('fetchCredits redacts an echoed session/phone but keeps the wording', async () => {
  const fetchImpl = async () =>
    jsonResponse(platformFailure('100002', `token: ${SESSION} phone ${RAW_PHONE} 已失效`))
  const result = await fetchCredits({ baseURL: BASE, session: SESSION_FACTS, fetchImpl, now: () => NOW })

  assert.equal(result.kind, 'failure')
  assert.ok(!result.failure.message.includes(SESSION))
  assert.ok(!result.failure.message.includes(RAW_PHONE))
  assert.match(result.failure.message, /已失效/u)
})

test('a signed-out session fails locally without a request', async () => {
  let calls = 0
  const result = await fetchCredits({
    baseURL: BASE,
    session: { sourcePath: '/tmp/missing.json', problem: '请启动 Loomy 客户端并登录' },
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(pointsBody())
    },
    now: () => NOW,
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, 'not_signed_in')
  assert.match(result.failure.message, /missing\.json/u)
  assert.equal(calls, 0)
})

test('fetchIdentity uses /user/identity and the platform token header', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ code: '000000', desc: '成功', data: { isInternal: false, teams: [] } })
  }
  const result = await fetchIdentity({ baseURL: BASE, session: SESSION_FACTS, fetchImpl, now: () => NOW })
  assert.equal(result.kind, 'ok')
  assert.equal(calls[0].url, `${BASE}/user/identity`)
  assert.equal(calls[0].init.headers.token, SESSION)
})

test('createCreditsCache: 60s TTL, single-flight, and a failure is never cached as success', async () => {
  let clock = NOW
  let mode = 'failure'
  let calls = 0
  let release = () => {}
  let gate = Promise.resolve()
  const fetchImpl = async () => {
    calls += 1
    await gate
    if (mode === 'failure') return jsonResponse(platformFailure('100002', '登录已失效'))
    return jsonResponse(pointsBody())
  }
  const cache = createCreditsCache({
    baseURL: () => BASE,
    readSession: async () => SESSION_FACTS,
    ttlMs: () => 60_000,
    fetchImpl,
    now: () => clock,
  })

  // A failure reaches the caller and is *not* stored: the next read retries.
  const failed = await cache.read()
  assert.equal(failed.kind, 'failure')
  assert.equal(calls, 1)
  await cache.read()
  assert.equal(calls, 2, 'a failed read is not served from cache')

  // Two overlapping reads share one upstream call (single-flight).
  mode = 'success'
  gate = new Promise((resolve) => {
    release = resolve
  })
  const first = cache.read()
  const second = cache.read()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 3)
  assert.equal(a.kind, 'ok')
  assert.equal(b.kind, 'ok')
  assert.equal(a.credits.availableBalance, 40_500)

  // Inside the TTL the cached snapshot is served without another call.
  clock += 59_000
  const cached = await cache.read()
  assert.equal(cached.kind, 'ok')
  assert.equal(calls, 3)

  // After the TTL the next read goes upstream again.
  clock += 2_000
  await cache.read()
  assert.equal(calls, 4)
})

test('a ledger row keeps its time and the model that caused the deduction', () => {
  // Shape verified against the live upstream: createdAt is epoch *seconds* and
  // the model arrives as `modelName`.
  const row = normalizeLedgerRow({
    description: '模型调用扣分',
    direction: 'debit',
    pointsActual: 6,
    createdAt: 1794810151,
    balanceAfter: 35500,
    modelName: 'deepseek-v4-flash-1017',
  })
  assert.ok(row)
  assert.equal(row.model, 'deepseek-v4-flash-1017')
  assert.equal(row.createdAt, 1_794_810_151_000, 'seconds are widened to milliseconds')
  assert.equal(new Date(row.createdAt).getUTCFullYear(), new Date(1_794_810_151_000).getUTCFullYear())

  // A credit (no model) must not invent one.
  const credit = normalizeLedgerRow({
    description: '邀请好友奖励',
    direction: 'credit',
    pointsActual: 5000,
    createdAt: 1794574692,
    balanceAfter: 40500,
  })
  assert.equal(credit.model, undefined)
})

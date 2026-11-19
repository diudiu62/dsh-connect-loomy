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
  // 三个桶映射到能力声明里的 key：`available` 是主数字，`daily` 是当日额度，
  // `total` 是账本余额。请求方读的是 `fields`，不是三个扁平字段。
  assert.deepEqual(credits.fields, { available: 40_500, daily: 5_000, total: 35_500 })
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

// ── Raccoon 账单（积分明细） ────────────────────────────────────────────────

/**
 * 实测样本（2026-11-19 `GET /api/web/points/v2/bills`）。
 *
 * 三个必须钉住的形状：`points` 带符号、`created_at` 是带时区的 ISO、
 * 分页是游标（`next_cursor`）而不是页码。
 */
const BILLS_BODY = {
  code: 0,
  message: 'success',
  data: {
    items: [
      {
        group_id: 'task_E9D4',
        bill_count: 1,
        bill_id: 'bill_337b',
        client_type: 'desktop',
        event_name: '桌面端 LLM 对话消耗',
        biz_type: 'desktop',
        biz_id: 'e15e',
        points: -1,
        created_at: '2026-11-19T16:04:34+08:00',
      },
      {
        group_id: 'task_C459',
        bill_count: 1,
        bill_id: 'bill_e600',
        client_type: 'desktop',
        event_name: '邀请奖励',
        biz_type: 'reward',
        points: 500,
        created_at: '2026-11-19T15:11:10+08:00',
      },
    ],
    has_more: true,
    next_cursor: 'cursor-token',
  },
}

test('parseBills maps signed points onto direction and keeps the timestamp', async () => {
  const { parseBills } = await import('../../lib/index.js')
  const page = parseBills(BILLS_BODY)
  assert.ok(page !== undefined)
  assert.equal(page.records.length, 2)

  const [debit, credit] = page.records
  // 负数 = 扣减；展示的是绝对额，方向单独表达（UI 用它加 +/-）。
  assert.equal(debit.direction, 'debit')
  assert.equal(debit.pointsActual, 1)
  assert.equal(debit.description, '桌面端 LLM 对话消耗')
  assert.equal(debit.createdAt, Date.parse('2026-11-19T16:04:34+08:00'))

  assert.equal(credit.direction, 'credit')
  assert.equal(credit.pointsActual, 500)
  assert.equal(credit.description, '邀请奖励')

  // 游标分页：卡片只取一页，但要把"还有更多"如实带出去。
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, 'cursor-token')
  // 上游没给余后余额与模型名：不编造。
  assert.equal(debit.balanceAfter, undefined)
  assert.equal(debit.model, undefined)
})

test('parseBills skips one bad row instead of failing the page', async () => {
  const { parseBills } = await import('../../lib/index.js')
  const page = parseBills({
    code: 0,
    data: {
      items: [
        { points: 'not-a-number', created_at: '2026-11-19T16:04:34+08:00' },
        { points: -2, created_at: 'not-a-date' },
        { points: -3, created_at: '2026-11-19T16:04:34+08:00', event_name: 'ok' },
      ],
      has_more: false,
    },
  })
  assert.ok(page !== undefined)
  assert.equal(page.records.length, 1, '坏记录跳过，好记录保留')
  assert.equal(page.records[0].pointsActual, 3)
  assert.equal(page.hasMore, false)
})

test('parseBills rejects a non-zero envelope instead of showing an empty ledger', async () => {
  const { parseBills } = await import('../../lib/index.js')
  assert.equal(parseBills({ code: 200003, message: 'authoriza…' }), undefined)
  assert.equal(parseBills('nope'), undefined)
  assert.equal(parseBills({ code: 0, data: {} }), undefined)
})

test('fetchBills sends the bearer token and the cursor, and never pads the query', async () => {
  const { fetchBills } = await import('../../lib/index.js')
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers })
    return new Response(JSON.stringify(BILLS_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  await fetchBills({ token: 'tok', fetchImpl })
  // 没有 cursor 时不拼空参数：`?cursor=` 在有的网关上会被当成"游标为空"。
  assert.equal(seen[0].url, 'https://xiaohuanxiong.com/api/web/points/v2/bills')
  assert.match(seen[0].headers.Authorization, /^Bearer tok$/u)

  await fetchBills({ token: 'tok', cursor: 'abc', fetchImpl })
  assert.match(seen[1].url, /\?cursor=abc$/u)
})

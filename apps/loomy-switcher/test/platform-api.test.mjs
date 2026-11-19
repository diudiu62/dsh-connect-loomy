/**
 * 平台 API 测试（全部用注入的 fetch，不打真实网络）。
 *
 * 重点覆盖反编译 `electron/points-service.js` 得到的三个协议事实：
 * 1. 认证头是裸 `token`，不是 `Authorization: Bearer`；
 * 2. 失败可能是 **HTTP 200 + 业务码**，`code` 才是权威；
 * 3. 缺字段的积分响应必须按失败上报，不能伪造成 0。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchCredits, fetchInvite, redeemInvite, refreshMany } from '../src/main/platform-api.js'

const SESSION = 'a'.repeat(32)

/** 造一个假的 fetch，返回固定 JSON 并记录请求。 */
function fakeFetch(body, { status = 200, capture } = {}) {
  return async (url, init) => {
    capture?.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }
}

const creditsBody = {
  code: '000000',
  desc: '成功',
  data: {
    balance: 12000,
    dailyBalance: 2124,
    availableBalance: 14124,
    list: [
      { modelName: 'spark-x2.6', direction: 'debit', description: '模型调用扣分', createdAt: 1794963700, pointsActual: 1800, balanceAfter: 14124 },
    ],
  },
}

test('认证用裸 token 头，不是 Authorization', async () => {
  const captured = []
  await fetchCredits({ session: SESSION, fetchImpl: fakeFetch(creditsBody, { capture: captured }) })
  const { init } = captured[0]
  assert.equal(init.headers.token, SESSION)
  assert.equal(init.headers.Authorization, undefined, '不能用 Authorization: Bearer')
})

test('积分解析：三个桶 + 流水', async () => {
  const result = await fetchCredits({ session: SESSION, fetchImpl: fakeFetch(creditsBody) })
  assert.equal(result.kind, 'ok')
  assert.equal(result.credits.balance, 12000)
  assert.equal(result.credits.dailyBalance, 2124)
  assert.equal(result.credits.availableBalance, 14124)
  assert.equal(result.credits.records.length, 1)
  assert.equal(result.credits.records[0].model, 'spark-x2.6')
  // 秒级时间戳要乘 1000
  assert.equal(result.credits.records[0].createdAt, 1794963700 * 1000)
})

test('HTTP 200 + 业务码失败，必须按失败上报', async () => {
  const body = { code: '100002', desc: '登录已失效，请重新登录', data: {} }
  const result = await fetchCredits({ session: SESSION, fetchImpl: fakeFetch(body) })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, '100002')
  assert.match(result.message, /登录已失效/u)
})

test('缺字段的响应不能被当成 0 积分', async () => {
  const body = { code: '000000', data: { balance: 100 } }
  const result = await fetchCredits({ session: SESSION, fetchImpl: fakeFetch(body) })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, 'bad_response')
})

test('没有 session 时不发请求', async () => {
  let called = false
  const result = await fetchCredits({
    session: '',
    fetchImpl: async () => {
      called = true
      throw new Error('不该被调用')
    },
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, 'no_session')
  assert.equal(called, false)
})

test('邀请码：解析码列表与绑定状态', async () => {
  const responses = [
    { code: '000000', data: { list: [{ inviteCode: 'C8DB2C', usedCount: 0, maxUses: 1, status: 'active' }] } },
    { code: '000000', data: { activated: true, appliedInvitationCode: 'F5ZAND' } },
  ]
  let index = 0
  const result = await fetchInvite({
    session: SESSION,
    fetchImpl: async () => {
      const body = responses[index++]
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    },
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.invite.codes.length, 1)
  assert.equal(result.invite.codes[0].inviteCode, 'C8DB2C')
  assert.equal(result.invite.codes[0].remaining, 1)
  assert.equal(result.invite.activeCount, 1)
  assert.deepEqual(result.invite.activation, { activated: true, appliedInvitationCode: 'F5ZAND' })
})

test('邀请码：一个接口挂了仍返回另一个的结果并带错误说明', async () => {
  let index = 0
  const result = await fetchInvite({
    session: SESSION,
    fetchImpl: async () => {
      index += 1
      const body = index === 1 ? { code: '100002', desc: '登录已失效' } : { code: '000000', data: { activated: false } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    },
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.invite.codes.length, 0)
  assert.equal(result.invite.activation.activated, false)
  assert.match(result.codesError, /登录已失效/u)
})

test('绑定邀请码是 POST 且 isEmpty 的码直接被拒', async () => {
  const captured = []
  const ok = await redeemInvite({
    session: SESSION,
    inviteCode: '  C8DB2C  ',
    fetchImpl: fakeFetch({ code: '000000', data: { activated: true, appliedInvitationCode: 'C8DB2C' } }, { capture: captured }),
  })
  assert.equal(ok.kind, 'ok')
  assert.equal(captured[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(captured[0].init.body), { inviteCode: 'C8DB2C' })

  const empty = await redeemInvite({ session: SESSION, inviteCode: '   ', fetchImpl: fakeFetch({}) })
  assert.equal(empty.kind, 'failure')
  assert.equal(empty.code, 'bad_request')
})

test('批量刷新：一条失败不拖垮其他，并按 id 分开结果', async () => {
  const entries = [
    { id: 'ok-1', session: 'b'.repeat(32) },
    { id: 'bad', session: 'c'.repeat(32) },
    { id: 'ok-2', session: 'd'.repeat(32) },
  ]
  const fetchImpl = async (_url, init) => {
    if (init.headers.token === 'c'.repeat(32)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: '100002', desc: '失效' }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(creditsBody) }
  }
  const progress = []
  const { results, summary } = await refreshMany(entries, {
    concurrency: 2,
    fetchImpl,
    onProgress: (event) => progress.push(event.done),
  })
  assert.deepEqual(summary, { total: 3, ok: 2, failed: 1 })
  assert.equal(results.get('ok-1').kind, 'ok')
  assert.equal(results.get('bad').kind, 'failure')
  assert.equal(results.get('ok-2').kind, 'ok')
  // 进度必须一条一条报，且计数连续到总数
  assert.deepEqual(progress.sort((a, b) => a - b), [1, 2, 3])
})

test('批量刷新：并发度不超过设定值', async () => {
  let inFlight = 0
  let peak = 0
  const entries = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, session: 'b'.repeat(32) }))
  await refreshMany(entries, {
    concurrency: 3,
    fetchImpl: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { ok: true, status: 200, text: async () => JSON.stringify(creditsBody) }
    },
  })
  assert.ok(peak <= 3, `并发峰值 ${peak} 应 ≤ 3`)
})

test('网络异常被收敛成 failure，不抛出', async () => {
  const result = await fetchCredits({
    session: SESSION,
    fetchImpl: async () => {
      throw new Error('ECONNRESET')
    },
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, 'network')
  assert.match(result.message, /ECONNRESET/u)
})

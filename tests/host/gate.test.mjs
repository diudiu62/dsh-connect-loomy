/**
 * The per-account concurrency gate (`core/gate.ts`) and its wiring into the
 * chat runtime.
 *
 * Why it exists: the desktop clients this plugin borrows run their calls
 * sequentially — the Raccoon client caps its local relay at two in-flight
 * upstream requests — while a harness fans out. Eight plugin accounts got
 * flagged by the upstream risk control (`429 code 200108`) within ninety
 * seconds on 2026-11-23. The gate makes the plugin queue instead of fire.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createChatRuntime,
  createConcurrencyGate,
  createRaccoonChatDriver,
  DEFAULT_ACCOUNT_CONCURRENCY,
} from '../../lib/index.js'

/** 让出事件循环一次：等待者是在 acquire 里同步入队的，microtask 不够。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('acquire below the limit is instant; the release is idempotent', async () => {
  const gate = createConcurrencyGate({ limit: () => 2 })
  const releaseA = await gate.acquire('a')
  assert.equal(gate.active('a'), 1)
  releaseA()
  releaseA()
  assert.equal(gate.active('a'), 0)
  assert.deepEqual(gate.keys(), [], '空键的账目要回收')
})

test('callers beyond the limit queue FIFO and wake in order', async () => {
  const gate = createConcurrencyGate({ limit: () => 1 })
  const release = await gate.acquire('acc')
  const order = []
  const first = gate.acquire('acc').then((r) => (order.push('first'), r))
  const second = gate.acquire('acc').then((r) => (order.push('second'), r))
  await tick()
  assert.equal(gate.waiting('acc'), 2)
  release()
  const releaseFirst = await first
  assert.deepEqual(order, ['first'])
  releaseFirst()
  const releaseSecond = await second
  assert.deepEqual(order, ['first', 'second'])
  releaseSecond()
  assert.equal(gate.active('acc'), 0)
})

test('a limit of 0 (or less) means no gate at all', async () => {
  const gate = createConcurrencyGate({ limit: () => 0 })
  const release = await gate.acquire('anything')
  assert.equal(gate.active('anything'), 0)
  release()
  assert.deepEqual(gate.keys(), [])
})

test('a waiter aborted while queued rejects and frees its place', async () => {
  const gate = createConcurrencyGate({ limit: () => 1 })
  const controller = new AbortController()
  const holder = await gate.acquire('acc')
  const queued = gate.acquire('acc', controller.signal)
  await tick()
  controller.abort()
  await assert.rejects(queued, (error) => error.name === 'AbortError')
  assert.equal(gate.waiting('acc'), 0, '被中止的等待者要离开队列')
  holder()
})

test('the limit is re-read on every acquire, so a settings change applies at once', async () => {
  let limit = 1
  const gate = createConcurrencyGate({ limit: () => limit })
  const release = await gate.acquire('acc')
  const queued = gate.acquire('acc')
  await tick()
  assert.equal(gate.waiting('acc'), 1)
  limit = 2 // 放宽：等待者立刻该拿到槽位
  release()
  const releaseSecond = await queued
  assert.equal(gate.active('acc'), 1, '槽位已转移到等待者')
  assert.equal(gate.waiting('acc'), 0)
  releaseSecond()
})

test('the core default is no gate: only vendors that know the upstream declare one', () => {
  assert.equal(DEFAULT_ACCOUNT_CONCURRENCY, 0)
})

/**
 * 端到端：闸门在真实适配器路径上生效。
 *
 * 三条并发调用、每账号上限 1 → 上游一次只该看到一条在飞；上限 0（不限）→
 * 三条会同时打出去。这是 2026-11-23 `200108` 的形态差：官方客户端串行，
 * 插件不限就成批。
 */
const CATALOG_MODEL = {
  id: 'sn-glm-5-3-flash',
  name: 'GLM-5-3-Flash',
  multiplier: 0.2,
  contextWindow: 1_000_000,
  maxOutput: 100_000,
  vision: false,
  efforts: [],
  defaultEffort: '',
}

function sseBody(text) {
  const chunk = {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: CATALOG_MODEL.id,
    choices: [
      { index: 0, delta: { content: text }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' },
    ],
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
}

async function withStubbedFetch(limit, run) {
  const original = globalThis.fetch
  let inFlight = 0
  let peak = 0
  globalThis.fetch = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 20))
    inFlight -= 1
    return new Response(sseBody('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
  return peak
}

function raccoonRuntime(concurrency) {
  const baseUrl = 'https://raccoon.test/api/web/llm/v2'
  return createChatRuntime({
    vendorId: 'raccoon',
    chat: createRaccoonChatDriver({
      clientVersion: () => '1.2.0',
      deviceId: () => 'device-1',
    }),
    routes: () => [{ route: 'raccoon', displayName: 'Raccoon' }],
    baseUrl: () => baseUrl,
    models: () => [CATALOG_MODEL],
    resolveCredential: async () => ({ material: 'token-1', accountId: 'acc-1', deviceId: 'device-1' }),
    concurrency: () => concurrency,
  })
}

async function drain(runtime) {
  for await (const _chunk of runtime.adapter.stream({
    provider: 'raccoon',
    model: CATALOG_MODEL.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    // consume
  }
}

test('the gate serialises concurrent calls per account on the real adapter path', async () => {
  const peak = await withStubbedFetch(1, async () => {
    const runtime = raccoonRuntime(1)
    await Promise.all([drain(runtime), drain(runtime), drain(runtime)])
  })
  assert.equal(peak, 1, '上限 1：上游一次只看到一条在飞')
})

test('without a declared limit the same calls run in parallel', async () => {
  const peak = await withStubbedFetch(0, async () => {
    const runtime = raccoonRuntime(0)
    await Promise.all([drain(runtime), drain(runtime), drain(runtime)])
  })
  assert.equal(peak, 3, '不限：三条一起发（修复前的形态）')
})

test('after a slot is granted, aborting the signal neither frees it nor hands it on', async () => {
  const gate = createConcurrencyGate({ limit: () => 1 })
  const controller = new AbortController()
  const release = await gate.acquire('acc', controller.signal)
  assert.equal(gate.active('acc'), 1)
  controller.abort()
  assert.equal(gate.active('acc'), 1, '已取号的槽位不受迟到的 abort 影响')
  // 别人照常排队（不能被误放行）。
  const queued = gate.acquire('acc')
  await tick()
  assert.equal(gate.waiting('acc'), 1)
  release()
  const releaseNext = await queued
  assert.equal(gate.active('acc'), 1)
  releaseNext()
  assert.equal(gate.active('acc'), 0)
})

test('the aborted-waiter listener is detached once a slot is granted', async () => {
  // 间接验证：取号后 abort 不再触发任何拒绝（监听器已摘除）。
  const gate = createConcurrencyGate({ limit: () => 2 })
  const controller = new AbortController()
  const release = await gate.acquire('acc', controller.signal)
  controller.abort()
  release()
  assert.deepEqual(gate.keys(), [], '释放后账目回收，无悬挂状态')
})

/**
 * 槽位归还兜底：消费方提前放弃（拿一个 chunk 就 `break`）时，`wrap` 的
 * `finally` 必须把内层迭代器关掉、把槽位还回去——否则上限 1 的闸门会把
 * 后续调用永久卡死。
 */
test('abandoning a stream mid-flight releases the concurrency slot', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(sseBody('partial'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  try {
    const runtime = raccoonRuntime(1)
    // 第一条流只取一个 chunk 就放弃。
    for await (const _chunk of runtime.adapter.stream({
      provider: 'raccoon',
      model: CATALOG_MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      break
    }
    // 槽位若泄漏，这条会永远等不到号（测试超时即失败）。
    await drain(runtime)
  } finally {
    globalThis.fetch = original
  }
})

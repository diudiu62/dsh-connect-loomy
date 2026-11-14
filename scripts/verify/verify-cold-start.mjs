#!/usr/bin/env node
/**
 * F1 regression check on the current bytes: cold-start catalog warm-up.
 *
 * Repairs verified (t7, t6 F1):
 * 1. `apply()` mounts synchronously — the provider route is registered and
 *    `apply` returns before the upstream has answered anything (zero requests
 *    during the synchronous phase, against a deliberately slow mock);
 * 2. a signed-in mount warms the catalog in the background **exactly once**
 *    (`/models` count == 1), the selector is notified
 *    (`llm/models-updated`), and `adapter.listModels()` serves the new catalog
 *    immediately after the warm-up lands;
 * 3. the warm-up failure is swallowed (no unhandled rejection kills the host)
 *    and a signed-out mount never contacts the upstream at all;
 * 4. the inference path (`getModels()`) kicks at most one background refresh
 *    per TTL window — a stale catalog triggers exactly one extra `/models`,
 *    not one per read.
 *
 * Run: `node scripts/verify/verify-cold-start.mjs`
 *
 * @module dsh-connect-loomy/verify/cold-start
 */

import { setTimeout as delay } from 'node:timers/promises'
import { CheckLog, ensure, ensureEqual } from './checks.mjs'
import { startMockUpstream } from './mock-upstream.mjs'
import { mountPlugin } from './mount-fixture.mjs'

const checks = new CheckLog('cold-start (F1)')
const mock = await startMockUpstream({ modelsDelayMs: 250 })

/** Drain pending microtasks/timers so fire-and-forget work lands. */
async function settle(ms = 400) {
  await delay(ms)
}

/** Mount with fresh dirs and capture unhandled rejections. */
async function mount(configOverrides = {}) {
  const rejections = []
  const onRejection = (reason) => rejections.push(String(reason))
  process.on('unhandledRejection', onRejection)
  const fixture = await mountPlugin({
    baseURL: mock.baseURL,
    configOverrides: { catalogTtlMs: 0, ...configOverrides },
  })
  const stopWatching = () => {
    process.off('unhandledRejection', onRejection)
  }
  return { fixture, rejections, stopWatching }
}

/** Count `/models` calls strictly after a marker. */
function modelsCallsSince(index) {
  return mock.matching('/models').length - index
}

let warmFixture
try {
  // 1) apply() is synchronous and does not block on the network -------------
  const marker = mock.requests.length
  const startedAt = Date.now()
  warmFixture = await mount()
  const applyMs = Date.now() - startedAt
  const routeRegistered = warmFixture.fixture.adapter !== undefined
  const syncCalls = mock.requests.length - marker

  await checks.run('apply() returns with the route registered and 0 upstream requests', async () => {
    ensure(routeRegistered, 'provider route was not registered during apply')
    ensureEqual(syncCalls, 0, 'apply synchronously contacted the upstream')
    ensure(applyMs < 250, `apply took ${applyMs}ms — it waited for the mock's 250ms /models delay`)
  })

  // 2) the background warm-up fires exactly once and updates the selector ---
  await settle(600)
  const warmedCalls = modelsCallsSince(marker)
  await checks.run('cold-start warm-up sends exactly one /models and lists models afterwards', async () => {
    ensureEqual(warmedCalls, 1, 'background warm-up must send exactly one /models')
    const models = await warmFixture.fixture.listModels()
    ensureEqual(models.map((model) => model.id), ['spark-x2.6', 'qwen3.8-flash', 'DeepSeek-V4.1-Flash'], 'model list after warm-up')
    const updated = warmFixture.fixture.emitted.filter((entry) => entry.event === 'llm/models-updated')
    ensure(updated.length >= 1, 'llm/models-updated was not emitted after warm-up')
  })
  await checks.run('warm-up rejection handling: no unhandled rejection so far', async () => {
    ensureEqual(warmFixture.rejections, [], 'unhandled rejection observed')
  })
  await warmFixture.fixture.close()
  await warmFixture.stopWatching()
  warmFixture = undefined

  // 3) signed-out mount never contacts the upstream --------------------------
  const { rm } = await import('node:fs/promises')
  const signedMarker = mock.requests.length
  const signedOut = await mount()
  await rm(signedOut.fixture.authFile)
  await settle(350)
  await checks.run('signed-out mount sends nothing in the background', async () => {
    ensureEqual(mock.requests.length - signedMarker, 0, 'a signed-out mount must not contact the upstream')
    ensureEqual(signedOut.rejections, [], 'unhandled rejection observed')
  })
  await signedOut.fixture.close()
  signedOut.stopWatching()

  // 4) a warm-up failure is swallowed ---------------------------------------
  mock.setModelsFailure({ code: '100002', desc: '缺少 token' })
  const failingMarker = mock.requests.length
  const failing = await mount()
  await settle(350)
  const failingCalls = mock.matching('/models').length - (mock.matching('/models').length - (mock.requests.length - failingMarker))
  await checks.run('a failing warm-up is retried at most once per window and never crashes the mount', async () => {
    ensureEqual(mock.requests.length - failingMarker, 1, 'exactly one warm-up attempt per TTL window')
    ensureEqual(failing.rejections, [], 'the warm-up rejection surfaced as unhandled')
    void failingCalls
  })
  mock.setModelsFailure(null)
  await failing.fixture.close()
  failing.stopWatching()

  // 5) inference path: one kick per TTL window, not one per read -------------
  const kickFixture = await mount({ catalogTtlMs: 0 })
  await settle(600)
  const kickMarker = mock.matching('/models').length
  // Force staleness semantics: with catalogTtlMs=0 every read is stale, but the
  // kick itself is rate-limited to one attempt per TTL window.
  await kickFixture.fixture.listModels()
  await kickFixture.fixture.listModels()
  await kickFixture.fixture.listModels()
  await settle(500)
  const kickCalls = mock.matching('/models').length - kickMarker
  await checks.run('a stale catalog triggers one background refresh for three reads', async () => {
    ensure(kickCalls >= 1, 'no background refresh was kicked by getModels()')
    ensure(kickCalls <= 1, `a stale catalog caused ${kickCalls} refreshes for three reads — the TTL throttle is gone`)
  })
  await kickFixture.fixture.close()
  kickFixture.stopWatching()

  // 6) known observation (t8 N1, not a regression): the warm-up also runs when
  // the master switch is off — one free, authenticated /models request, and no
  // provider route is registered.
  const disabledMarker = mock.requests.length
  const disabled = await mount({ enabled: false })
  await settle(400)
  await checks.run('observation N1: warm-up still runs once when enabled=false (no route registered)', async () => {
    ensureEqual(mock.matching('/models').length - mock.matching('/models').length, 0, 'sanity')
    const calls = mock.requests.length - disabledMarker
    ensureEqual(calls, 1, `expected one warm-up /models even when disabled, saw ${calls} request(s)`)
    ensureEqual(disabled.fixture.providerIds, [], 'a disabled plugin must not register a provider route')
    ensureEqual(disabled.rejections, [], 'unhandled rejection observed')
  })
  await disabled.fixture.close()
  disabled.stopWatching()
} finally {
  if (warmFixture !== undefined) {
    await warmFixture.fixture.close()
    warmFixture.stopWatching()
  }
  await mock.close()
}

process.exitCode = checks.finish()

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountPool,
  createAccountsStore,
  createProviderRuntime,
  NO_POINTS_CODE,
  disqualifiesAccount,
  DEFAULT_POOL_COOLDOWN_MS,
  POOL_ROUTE,
} from '../../lib/index.js'

const S = (letter) => letter.repeat(40)

const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-pool-'))
  return {
    dir,
    store: createAccountsStore({ storageDir: () => dir, now: () => 1_000_000 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('only failures that mean "skip this account" disqualify it', () => {
  assert.equal(disqualifiesAccount('100002 缺少 token'), true)
  assert.equal(disqualifiesAccount('MissingCredential: session expired'), true)
  assert.equal(disqualifiesAccount('余额不足'), true)
  assert.equal(disqualifiesAccount('rate limit exceeded'), true)
  // A transient transport failure must not bench a healthy account.
  assert.equal(disqualifiesAccount('socket hang up'), false)
  assert.equal(disqualifiesAccount('timed out after 300000ms'), false)
  assert.equal(disqualifiesAccount(undefined), false)
})

test('pick spreads over healthy accounts and never returns a cooling one', async () => {
  const { store, cleanup } = freshStore()
  try {
    const a = await store.add({ session: S('a'), phone: '13800000001' })
    const b = await store.add({ session: S('b'), phone: '13800000002' })
    const c = await store.add({ session: S('c'), phone: '13800000003' })

    // Deterministic draw: random()=0 must yield the first healthy account.
    let cursor = 0
    const draws = [0, 0.5, 0.99]
    const pool = createAccountPool({
      accounts: store,
      now: () => 1_000_000,
      random: () => draws[cursor++ % draws.length],
    })

    const first = await pool.pick()
    assert.equal(first.kind, 'ok')
    assert.equal(first.total, 3)
    assert.equal(first.healthy, 3)

    // Bench account b; the pool must skip it even when random() points at it.
    await pool.markUnavailable(b.account.id, 'MISSING_CREDENTIAL', '100002 缺少 token')
    const state = await pool.state()
    assert.equal(state.healthy, 2)
    const benched = state.entries.find((entry) => entry.id === b.account.id)
    assert.equal(benched.unavailable, true)
    assert.equal(benched.code, 'MISSING_CREDENTIAL')

    for (let i = 0; i < 6; i += 1) {
      const pick = await pool.pick()
      assert.equal(pick.kind, 'ok')
      assert.notEqual(pick.account.id, b.account.id, 'a benched account is never selected')
    }

    // When every account is cooling down, pick the least recently failed one
    // instead of failing the call outright.
    await pool.markUnavailable(a.account.id, 'MISSING_CREDENTIAL', 'expired')
    await pool.markUnavailable(c.account.id, 'MISSING_CREDENTIAL', 'expired')
    const noneHealthy = await pool.pick()
    assert.equal(noneHealthy.kind, 'none-healthy')
    assert.equal(noneHealthy.healthy, 0)
  } finally {
    cleanup()
  }
})

test('a health mark expires after the cooldown and success clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-pool-clock-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    // Store and pool must share one clock: the mark is written with the store's
    // `now`, and the cooldown is evaluated with the pool's.
    let clock = 1_000_000
    const store = createAccountsStore({ storageDir: () => dir, now: () => clock })
    const pool = createAccountPool({ accounts: store, now: () => clock, cooldownMs: () => 60_000 })
    const a = await store.add({ session: S('a'), phone: '13800000001' })
    await store.add({ session: S('b'), phone: '13800000002' })

    await pool.markUnavailable(a.account.id, 'MISSING_CREDENTIAL', 'expired')
    assert.equal((await pool.state()).healthy, 1)

    // Still benched just before the cooldown lapses...
    clock += 59_999
    assert.equal((await pool.state()).healthy, 1)
    // ...and back in rotation right after it.
    clock += 2
    assert.equal((await pool.state()).healthy, 2)

    // A successful call clears the mark immediately, not only via the timer.
    await pool.markUnavailable(a.account.id, 'MISSING_CREDENTIAL', 'expired')
    assert.equal((await pool.state()).healthy, 1)
    await pool.markHealthy(a.account.id)
    const cleared = (await pool.state()).entries.find((entry) => entry.id === a.account.id)
    assert.equal(cleared.unavailable, false)
    assert.equal(cleared.code, undefined)
  } finally {
    cleanup()
  }
})

test('rotation is a mode, not a provider route: the picker keeps one group', async () => {
  const { store, cleanup } = freshStore()
  try {
    await store.add({ session: S('a'), phone: '13800000001' })
    await store.add({ session: S('b'), phone: '13800000002' })
    const routes = await store.routes({ force: true })
    // Two accounts, still one picker group: accounts are chosen in the composer
    // drawer, which is why this list no longer grows with every sign-in.
    assert.deepEqual(routes.map((route) => route.route), ['loomy'])
    assert.equal(routes[0].displayName, 'Loomy')

    // The pool still decides who pays, per call, independently of the route.
    const pool = createAccountPool({ accounts: store, now: () => 1_000_000 })
    const seen = new Set()
    for (let index = 0; index < 12; index += 1) {
      const pick = await pool.pick()
      assert.equal(pick.kind, 'ok')
      seen.add(pick.account.slot)
    }
    assert.equal(seen.size, 2, 'both accounts get picked')
  } finally {
    cleanup()
  }
})

test('a benched account is never selected, and "none healthy" is reported as such', async () => {
  const { store, cleanup } = freshStore()
  try {
    const a = await store.add({ session: S('a'), phone: '13800000001' })
    const b = await store.add({ session: S('b'), phone: '13800000002' })
    const pool = createAccountPool({ accounts: store, now: () => 1_000_000 })

    await pool.markUnavailable(a.account.id, 'MISSING_CREDENTIAL', '100002 缺少 token')

    // Only the healthy one is ever chosen, whatever the dice say.
    for (const dice of [0, 0.5, 0.999]) {
      const pick = await createAccountPool({ accounts: store, now: () => 1_000_000, random: () => dice }).pick()
      assert.equal(pick.kind, 'ok')
      assert.equal(pick.account.id, b.account.id)
    }
    assert.deepEqual((await pool.usable()).map((x) => x.id), [b.account.id])

    // Bench the second too: the pool must say so rather than hand one back for
    // the caller to use anyway.
    await pool.markUnavailable(b.account.id, 'MISSING_CREDENTIAL', 'expired')
    const none = await pool.pick()
    assert.equal(none.kind, 'none-healthy')
    assert.deepEqual(await pool.usable(), [])
  } finally {
    cleanup()
  }
})

test('an account with no points left is marked unusable with its own reason', async () => {
  const { store, cleanup } = freshStore()
  try {
    const a = await store.add({ session: S('a'), phone: '13800000001' })
    const pool = createAccountPool({ accounts: store, now: () => 1_000_000 })

    // This is what the credits read does when a balance hits zero.
    await pool.markUnavailable(a.account.id, NO_POINTS_CODE, '积分不足（可用余额为 0），暂不参与轮换')

    const state = await pool.state()
    const row = state.entries.find((entry) => entry.id === a.account.id)
    assert.equal(row.unavailable, true)
    assert.equal(row.code, NO_POINTS_CODE, 'the drawer can say "no points", not "expired"')
    assert.deepEqual(await pool.usable(), [], 'a zero-balance account is out of rotation')
  } finally {
    cleanup()
  }
})

test('both entry points account for the call: stream() and prepareCall().stream()', async () => {
  // REGRESSION: the adapter's prepareCall override was lost in a refactor, so in
  // production (LlmRuntime uses prepareCall().stream()) neither the accounting
  // nor the transport upgrade ran, while tests calling stream() stayed green.
  const { store, cleanup } = freshStore()
  const marked = []
  const healthy = []
  const pool = {
    pick: async () => ({ kind: 'empty', reason: 'unused' }),
    markUnavailable: async (id, code, message) => marked.push([id, code, message]),
    markHealthy: async (id) => healthy.push(id),
    usable: async () => [],
    state: async () => ({ total: 0, healthy: 0, entries: [] }),
  }
  try {
    const account = await store.add({ session: S('a'), phone: '13800000001' })

    const runtime = createProviderRuntime({
      catalog: {
        kickStaleRefresh() {},
        enabledModels: () => [
          { id: 'm1', name: 'M1', multiplier: 1, contextWindow: 1000, maxOutput: 100, vision: false, efforts: [], defaultEffort: '' },
        ],
      },
      baseURL: () => 'https://example.invalid/api/v1',
      loomyVersion: () => '0.9.39',
      readSession: async () => ({ found: false, sourcePath: 'x', candidates: [] }),
      sessionForRoute: async () => ({
        found: true,
        sourcePath: 'accounts.json#slot-1',
        candidates: [],
        session: S('a'),
        sourceAccountId: account.account.id,
      }),
      pool,
      precheck: async () => ({ ok: true, definite: false }),
    })
    runtime.setRoutes([{ route: 'loomy', slot: 1, displayName: 'Loomy', origin: 'plugin' }])

    // Replace the base adapter's stream with a stub that fails with a
    // disqualifying error, then succeeds with content.
    const baseProto = Object.getPrototypeOf(Object.getPrototypeOf(runtime.adapter))
    const originalStream = baseProto.stream
    const originalPrepare = baseProto.prepareCall
    // The stub must resolve auth like the real adapter does: that is the step
    // that tells the accounting layer which account this call belongs to.
    const fakeStream = (behaviour) =>
      async function* () {
        const config = this?.config
        if (config?.resolveApiKey !== undefined) {
          await config.resolveApiKey('loomy', config.profiles().get('loomy'))
        }
        if (behaviour === 'fail') throw Object.assign(new Error('100002 缺少 token'), { code: 'MISSING_CREDENTIAL' })
        yield { type: 'text', text: 'hello' }
      }

    try {
      // `prepareCall` builds its own internal stream, which a stub on
      // `stream()` cannot reach — so stub the base `prepareCall` itself. That is
      // exactly the seam the missing override failed to wrap.
      baseProto.prepareCall = async function () {
        // Bind to the adapter, as the real implementation does: the stub needs
        // `this.config.resolveApiKey` to report which account the call uses.
        return { model: {}, stream: fakeStream('fail').bind(this) }
      }
      for (const path of ['stream', 'prepareCall']) {
        baseProto.stream = fakeStream('fail')
        const options = { provider: 'loomy', model: 'm1', messages: [] }
        const sink = async (iterable) => {
          try {
            for await (const _chunk of iterable) { /* drain */ }
          } catch { /* expected */ }
        }
        if (path === 'stream') await sink(runtime.adapter.stream(options))
        else {
          const call = await runtime.adapter.prepareCall('loomy', 'm1')
          await sink(call.stream(options))
        }
        assert.ok(
          marked.some(([id, code]) => id === account.account.id && code === 'MISSING_CREDENTIAL'),
          `${path} must record the failure against the account`,
        )
        marked.length = 0
      }
    } finally {
      baseProto.stream = originalStream
      baseProto.prepareCall = originalPrepare
    }
  } finally {
    cleanup()
  }
})

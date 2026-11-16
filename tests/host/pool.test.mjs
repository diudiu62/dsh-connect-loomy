import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountPool,
  createAccountsStore,
  createProviderRuntime,
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

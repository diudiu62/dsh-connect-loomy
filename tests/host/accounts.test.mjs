import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountsFilePath,
  accountIdOf,
  accountsView,
  createAccountsStore,
  parseAccounts,
  routeDisplayName,
  routeForSlot,
  slotForRoute,
  isOurRoute,
  createProviderRuntime,
} from '../../lib/index.js'

const SESSION_A = 'a'.repeat(40)
const SESSION_B = 'b'.repeat(40)
const SESSION_C = 'c'.repeat(40)

test('route ids are stable per slot and never renumbered', () => {
  assert.equal(routeForSlot(1), 'loomy')
  assert.equal(routeForSlot(2), 'loomy-2')
  assert.equal(routeForSlot(7), 'loomy-7')
  assert.equal(slotForRoute('loomy'), 1)
  assert.equal(slotForRoute('loomy-2'), 2)
  assert.equal(slotForRoute('loomy-1'), undefined, 'slot 1 never carries a suffix')
  assert.equal(slotForRoute('loomy-x'), undefined)
  assert.equal(slotForRoute('other'), undefined)
  assert.equal(isOurRoute('loomy-9'), true)
  assert.equal(isOurRoute('loomy-0'), false)
})

test('parseAccounts degrades to empty and drops duplicate slots', () => {
  assert.deepEqual(parseAccounts('not json').accounts, [])
  assert.deepEqual(parseAccounts('{}').accounts, [])
  const doc = JSON.stringify({
    version: 1,
    accounts: [
      { id: 'x1', slot: 2, session: SESSION_A, addedAt: 1 },
      { id: 'x2', slot: 2, session: SESSION_B, addedAt: 2 }, // duplicate slot
      { id: 'x3', slot: 1, session: 'short', addedAt: 3 }, // too short
    ],
  })
  const parsed = parseAccounts(doc)
  assert.equal(parsed.accounts.length, 1)
  assert.equal(parsed.accounts[0].slot, 2)
})

test('a store keeps slots stable across add and remove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-acc-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 1000 })

    const first = await store.add({ session: SESSION_A, phone: '13800000001' })
    assert.equal(first.kind, 'ok')
    assert.equal(first.account.slot, 1)
    assert.equal(first.replaced, false)

    const second = await store.add({ session: SESSION_B, phone: '13800000002' })
    assert.equal(second.account.slot, 2)
    const third = await store.add({ session: SESSION_C, phone: '13800000003' })
    assert.equal(third.account.slot, 3)

    // Routes follow slots verbatim.
    let routes = await store.routes({ force: true })
    assert.deepEqual(routes.map((r) => r.route), ['loomy'], 'one route for three accounts')
    assert.deepEqual((await store.list({ force: true })).map((a) => a.slot), [1, 2, 3])
    assert.equal(routes[0].origin, 'plugin')

    // Removing the middle account must NOT renumber the third.
    const removed = await store.remove(second.account.id)
    assert.deepEqual(removed, { kind: 'ok', removed: true })
    routes = await store.routes({ force: true })
    assert.deepEqual(routes.map((r) => r.route), ['loomy'])
    assert.deepEqual((await store.list({ force: true })).map((a) => a.slot), [1, 3], 'slots are not renumbered')

    // A new account reuses the freed slot rather than taking a higher one.
    const fourth = await store.add({ session: 'd'.repeat(40), phone: '13800000004' })
    assert.equal(fourth.account.slot, 2)

    // The file is 0600 and never contains anything but sessions/identity.
    const mode = statSync(accountsFilePath(dir)).mode & 0o777
    assert.equal(mode, 0o600)
    const raw = readFileSync(accountsFilePath(dir), 'utf8')
    assert.equal(raw.includes('13800000001'), true, 'phone is stored to build the display name')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('re-login refreshes the same slot instead of adding a second account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-acc-relogin-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 1000 })
    const first = await store.add({ session: SESSION_A, phone: '13800000001', userId: 'u1' })
    const sessionA2 = 'z'.repeat(40)
    const again = await store.add({ session: sessionA2, phone: '13800000001', userId: 'u1' })
    assert.equal(again.kind, 'ok')
    assert.equal(again.replaced, true, 'same userId refreshes the existing row')
    assert.equal(again.account.slot, first.account.slot, 'slot is preserved')
    const list = await store.list({ force: true })
    assert.equal(list.length, 1)
    assert.equal(list[0].session, sessionA2, 'session is refreshed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no stored account, the desktop session becomes slot 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-acc-desktop-'))
  try {
    const store = createAccountsStore({
      storageDir: () => dir,
      now: () => 1000,
      readDesktop: async () => ({ found: true, session: SESSION_A, phone: '138****0001' }),
    })
    const routes = await store.routes({ force: true })
    assert.equal(routes.length, 1)
    assert.equal(routes[0].route, 'loomy')
    assert.equal(routes[0].origin, 'desktop')
    assert.equal(routes[0].displayName, 'Loomy')

    // A stored account takes over; the desktop session stops being offered.
    await store.add({ session: SESSION_B, phone: '13800000002' })
    const after = await store.routes({ force: true })
    assert.equal(after.length, 1)
    assert.equal(after[0].origin, 'plugin')
    assert.equal(after[0].route, 'loomy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('routeDisplayName distinguishes slots and shows the phone as stored', () => {
  // The name IS the account: the picker groups by it, so a shared prefix hid
  // the only part that differs.
  assert.equal(routeDisplayName({ slot: 1, phone: '13800000001' }), '13800000001')
  assert.equal(routeDisplayName({ slot: 2, phone: '13800000002' }), '13800000002')
  assert.equal(routeDisplayName({ slot: 3, label: '工作号' }), '工作号')
  assert.equal(routeDisplayName({ slot: 4 }), '账号 4')
})

test('accountsView reports rows; ids are session fingerprints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-acc-view-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 1000 })
    await store.add({ session: SESSION_A, phone: '13800000001', userId: 'u1' })
    const rows = await accountsView(store, { force: true })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, accountIdOf(SESSION_A))
    assert.equal(rows[0].route, 'loomy')
    assert.equal(rows[0].origin, 'plugin')
    assert.equal(JSON.stringify(rows).includes(SESSION_A), false, 'a view never carries the session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the provider installs one profile per route and re-collects on change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-acc-rt-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 1000 })
    await store.add({ session: SESSION_A, phone: '13800000001' })
    await store.add({ session: SESSION_B, phone: '13800000002' })
    const routes = await store.routes({ force: true })

    const seenRoutes = []
    const runtime = createProviderRuntime({
      catalog: {
        kickStaleRefresh() {},
        enabledModels: () => [
          { id: 'm1', name: 'Model One', multiplier: 1, contextWindow: 1000, maxOutput: 100, vision: false, efforts: [], defaultEffort: '' },
        ],
      },
      baseURL: () => 'https://example.invalid/api/v1',
      loomyVersion: () => '0.9.39',
      readSession: async () => ({ found: false, sourcePath: 'x', candidates: [] }),
      sessionForRoute: async (route) => {
        seenRoutes.push(route)
        return { found: true, sourcePath: `slot:${route}`, candidates: [], session: 's'.repeat(40) }
      },
      precheck: async () => ({ ok: true, definite: false }),
    })

    // Default state: exactly the single base route.
    assert.equal(runtime.routes().length, 1)
    assert.equal(runtime.routes()[0].route, 'loomy')

    runtime.setRoutes(routes)
    assert.deepEqual(runtime.routes().map((r) => r.route), ['loomy'])
    assert.equal(runtime.profiles.size, 1, 'one route, no matter how many accounts')

    // The models it serves carry that single route id.
    const models = runtime.profiles.get('loomy').piProvider.getModels()
    assert.equal(models[0].provider, 'loomy')

    // Auth resolution still goes through the adapter for that route.
    await runtime.adapter['config'].resolveApiKey('loomy', runtime.profiles.get('loomy'))
    assert.deepEqual(seenRoutes, ['loomy'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('export produces a portable bundle; import merges it without clobbering slots', async () => {
  const source = mkdtempSync(join(tmpdir(), 'loomy-exp-'))
  const target = mkdtempSync(join(tmpdir(), 'loomy-imp-'))
  try {
    const from = createAccountsStore({ storageDir: () => source, now: () => 1000 })
    await from.add({ session: SESSION_A, phone: '13800000001', userId: 'u1' })
    await from.add({ session: SESSION_B, phone: '13800000002', userId: 'u2' })
    const exported = await from.exportBundle()

    assert.equal(exported.bundle.kind, 'dsh-connect-loomy/accounts')
    assert.equal(exported.bundle.version, 1)
    assert.equal(exported.bundle.accounts.length, 2)
    assert.equal(exported.bundle.accounts[0].session, SESSION_A, 'the session is what makes it portable')

    // A fresh machine imports it and gets usable accounts, no SMS involved.
    const into = createAccountsStore({ storageDir: () => target, now: () => 2000 })
    const result = await into.importBundle(JSON.parse(JSON.stringify(exported.bundle)))
    assert.equal(result.kind, 'ok')
    assert.equal(result.added, 2)
    assert.equal(result.reassigned, 0)
    const routes = await into.routes({ force: true })
    assert.deepEqual(routes.map((r) => r.route), ['loomy'])

    // Importing again is idempotent: same sessions refresh, nothing duplicates.
    const again = await into.importBundle(exported.bundle)
    assert.equal(again.added, 0)
    assert.equal(again.refreshed, 2)
    assert.equal((await into.list({ force: true })).length, 2)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('import refuses foreign JSON and never overwrites an existing account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-imp-guard-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 1000 })
    await store.add({ session: SESSION_A, phone: '13800000001', userId: 'u1' })

    await assert.rejects(() => store.importBundle({ arbitrary: 'json' }), /账号包/u)
    await assert.rejects(() => store.importBundle({ kind: 'other', version: 1, accounts: [] }), /账号包/u)

    // A bundle whose slots clash with existing accounts relocates, never replaces.
    const clash = {
      kind: 'dsh-connect-loomy/accounts',
      version: 1,
      exportedAt: 1,
      accounts: [{ slot: 1, session: SESSION_B, phone: '13800000002', userId: 'u2' }],
    }
    const result = await store.importBundle(clash)
    assert.equal(result.added, 1)
    assert.equal(result.reassigned, 1, 'slot 1 was taken, so the import took a free slot')
    const list = await store.list({ force: true })
    assert.equal(list.length, 2)
    assert.equal(list.find((a) => a.userId === 'u1').session, SESSION_A, 'the existing account is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('import accepts the desktop client auth-session.json verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-imp-desktop-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 5000 })
    // Exactly the file the desktop client writes, as a user would paste it.
    const desktop = {
      session: '0a1deffc15054457bf04a77007f5662c',
      userid: '261116121019062767',
      phone: '16292320818',
    }
    const result = await store.importBundle(desktop)
    assert.equal(result.kind, 'ok')
    assert.equal(result.added, 1)

    const stored = (await store.list({ force: true }))[0]
    assert.equal(stored.session, desktop.session)
    assert.equal(stored.userId, desktop.userid, 'the lowercase userid is mapped')
    assert.equal(stored.phone, desktop.phone)
    assert.equal(stored.slot, 1)

    const routes = await store.routes({ force: true })
    assert.equal(routes[0].route, 'loomy')
    assert.equal(routes[0].displayName, 'Loomy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('import accepts a bare array of sessions and our own bundle equally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-imp-shapes-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 5000 })
    const arr = [{ session: 'a'.repeat(32), phone: '13800000001' }, { session: 'b'.repeat(32) }]
    const result = await store.importBundle(arr)
    assert.equal(result.added, 2)
    const list = await store.list({ force: true })
    assert.deepEqual(list.map((a) => a.slot), [1, 2])
    // Two identical sessions collapse onto one account, not two.
    const dup = await store.importBundle([{ session: 'a'.repeat(32) }])
    assert.equal(dup.refreshed, 1)
    assert.equal((await store.list({ force: true })).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('export falls back to the desktop session when nothing is stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-exp-desktop-'))
  try {
    // The reported case: signed in through Loomy.app, nothing in accounts.json.
    const store = createAccountsStore({
      storageDir: () => dir,
      now: () => 9000,
      readDesktop: async () => ({ found: true, session: SESSION_A, phone: '181****0898' }),
    })
    const exported = await store.exportBundle()
    assert.equal(exported.bundle.accounts.length, 1, 'a visible sign-in must be exportable')
    assert.equal(exported.bundle.accounts[0].session, SESSION_A)
    assert.equal(exported.bundle.accounts[0].slot, 1)

    // With nothing anywhere, the bundle is empty so the card can say so.
    const empty = createAccountsStore({ storageDir: () => dir, now: () => 9000, readDesktop: async () => ({ found: false }) })
    assert.equal((await empty.exportBundle()).bundle.accounts.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('export includes the desktop session even when stored accounts exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-exp-both-'))
  try {
    const desktopSession = 'd'.repeat(32)
    const store = createAccountsStore({
      storageDir: () => dir,
      now: () => 7000,
      readDesktop: async () => ({ found: true, session: desktopSession, phone: '181****0898' }),
    })
    await store.add({ session: SESSION_A, phone: '13800000001', userId: 'u1' })

    const exported = await store.exportBundle()
    assert.equal(exported.bundle.accounts.length, 2, 'the desktop sign-in must not be dropped')
    assert.equal(exported.bundle.accounts[0].session, SESSION_A)
    assert.equal(exported.bundle.accounts[0].origin, 'plugin')
    assert.equal(exported.bundle.accounts[1].session, desktopSession)
    assert.equal(exported.bundle.accounts[1].origin, 'desktop')
    // Its slot must not collide with a stored row, or import would overwrite it.
    assert.equal(exported.bundle.accounts[1].slot, 2)

    // A desktop session identical to a stored one is not exported twice.
    const dupDir = mkdtempSync(join(tmpdir(), 'loomy-exp-dup-'))
    try {
      const dup = createAccountsStore({
        storageDir: () => dupDir,
        now: () => 7000,
        readDesktop: async () => ({ found: true, session: SESSION_A }),
      })
      await dup.add({ session: SESSION_A, phone: '13800000001' })
      assert.equal((await dup.exportBundle()).bundle.accounts.length, 1)
    } finally {
      rmSync(dupDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the list shows the desktop sign-in next to stored accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-view-mixed-'))
  try {
    const desktopSession = 'd'.repeat(32)
    const store = createAccountsStore({
      storageDir: () => dir,
      now: () => 1000,
      readDesktop: async () => ({ found: true, session: desktopSession, phone: '18100000000' }),
    })
    await store.add({ session: SESSION_A, phone: '13800000001' })

    const rows = await accountsView(store, { force: true })
    assert.equal(rows.length, 2, 'both sources appear in one list')
    assert.equal(rows[0].origin, 'plugin')
    assert.equal(rows[0].route, 'loomy')
    assert.equal(rows[1].origin, 'desktop')
    assert.equal(
      rows[1].route,
      '',
      'the desktop sign-in has no route of its own while stored accounts exist',
    )

    // Once adopted (stored), it stops being listed twice.
    await store.add({ session: desktopSession, phone: '18100000000' })
    const after = await accountsView(store, { force: true })
    assert.equal(after.filter((row) => row.origin === 'desktop').length, 0)
    assert.equal(after.length, 2, 'it is the same account, now routable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adopting the desktop sign-in is one store call and becomes a route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-adopt-'))
  try {
    const desktopSession = 'e'.repeat(32)
    const store = createAccountsStore({
      storageDir: () => dir,
      now: () => 1000,
      readDesktop: async () => ({ found: true, session: desktopSession, phone: '18100000000' }),
    })
    // Shown in the list but not routable yet.
    let routes = await store.routes({ force: true })
    assert.equal(routes[0].origin, 'desktop')

    const adopted = await store.adoptDesktop()
    assert.equal(adopted.kind, 'ok')
    routes = await store.routes({ force: true })
    assert.equal(routes[0].origin, 'plugin', 'the desktop sign-in now has its own route')
    assert.equal(routes[0].route, 'loomy')

    // Nothing to adopt: an executable message, not a crash or a silent no-op.
    const empty = createAccountsStore({ storageDir: () => dir, now: () => 1000, readDesktop: async () => ({ found: false }) })
    const none = await empty.adoptDesktop()
    assert.equal(none.kind, 'failure')
    assert.match(none.message, /桌面端/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a single-account export carries only that account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-exp-one-'))
  try {
    const store = createAccountsStore({ storageDir: () => dir, now: () => 1000 })
    const a = await store.add({ session: SESSION_A, phone: '13800000001' })
    await store.add({ session: SESSION_B, phone: '13800000002' })

    const one = await store.exportBundle({ id: a.account.id })
    assert.equal(one.bundle.accounts.length, 1)
    assert.equal(one.bundle.accounts[0].session, SESSION_A)

    const unknown = await store.exportBundle({ id: 'nope' })
    assert.equal(unknown.bundle.accounts.length, 0, 'an unknown id exports nothing rather than everything')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

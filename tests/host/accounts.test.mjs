/**
 * The one account store (`core/accounts.ts`).
 *
 * Accounts used to be two implementations with different signatures — one
 * `async` with a cache, one synchronous — which is why the pool, the card and
 * the export format each needed two code paths. These tests pin the single
 * store's behaviour: stable slots, material-based de-duplication, health marks,
 * and a bundle both sides of an export/import understand.
 */
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAccountsStore, createDocument } from '../../lib/index.js'
import { tempDir } from './helpers.mjs'

function storeIn(dir, options = {}) {
  return createAccountsStore({
    document: createDocument({
      path: join(dir, 'accounts.json'),
      parse: (text) => JSON.parse(text),
      serialize: (document) => JSON.stringify(document),
      empty: () => ({ version: 1, accounts: [] }),
    }),
    routeBase: 'demo',
    routeMode: options.routeMode ?? 'slots',
    displayName: 'Demo',
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
  })
}

test('slots are assigned once and never renumbered by a removal', async (t) => {
  const dir = tempDir(t)
  const store = storeIn(dir)
  const first = await store.add({ kind: 'credentials', material: 'a'.repeat(32), phone: '1' })
  const second = await store.add({ kind: 'credentials', material: 'b'.repeat(32), phone: '2' })
  const third = await store.add({ kind: 'credentials', material: 'c'.repeat(32), phone: '3' })

  // Routes derive from the slot, so renumbering would silently repoint a
  // conversation at a different account.
  assert.equal(store.routeOf({ id: first.id, material: 'a', origin: 'plugin' }), 'demo')
  assert.equal(store.routeOf({ id: second.id, material: 'b', origin: 'plugin' }), 'demo-2')

  await store.remove(second.id)
  const routes = await store.routes({ poolEnabled: false })
  assert.deepEqual(
    routes.map((entry) => entry.route),
    ['demo', 'demo-3'],
    'the surviving accounts keep their slots: removing slot 2 never renumbers slot 3',
  )
  assert.equal(third.id.length > 0, true)
})

test('the same material is refreshed, not added twice', async (t) => {
  const dir = tempDir(t)
  const store = storeIn(dir)
  await store.add({ kind: 'credentials', material: 'x'.repeat(40), label: 'old' })
  const again = await store.add({ kind: 'credentials', material: 'x'.repeat(40), label: 'new' })
  assert.equal(again.replaced, true)
  const rows = await store.list({ force: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'new')
})

test('health marks persist and clear', async (t) => {
  const dir = tempDir(t)
  const store = storeIn(dir)
  const added = await store.add({ kind: 'credentials', material: 'h'.repeat(40) })
  await store.markUnavailable(added.id, 'no_points', '积分不足')
  let rows = await store.list({ force: true })
  assert.equal(rows[0].unavailableCode, 'no_points')

  await store.markHealthy(added.id)
  rows = await store.list({ force: true })
  assert.equal(rows[0].unavailableAt, undefined)

  // The document is private: it carries sessions.
  assert.equal(statSync(join(dir, 'accounts.json')).mode & 0o777, 0o600)
})

test('a pool route appears only when rotation is on and there is something to rotate', async (t) => {
  const dir = tempDir(t)
  const store = storeIn(dir)
  await store.add({ kind: 'credentials', material: 'p'.repeat(40) })
  assert.deepEqual(
    (await store.routes({ poolEnabled: true })).map((entry) => entry.route),
    ['demo'],
    'one account cannot rotate',
  )
  await store.add({ kind: 'credentials', material: 'q'.repeat(40) })
  assert.ok((await store.routes({ poolEnabled: true })).some((entry) => entry.route === 'demo-pool'))
  assert.ok(!(await store.routes({ poolEnabled: false })).some((entry) => entry.route === 'demo-pool'))
})

test('the desktop sign-in joins the pool without being written to the file', async (t) => {
  const dir = tempDir(t)
  const store = storeIn(dir, { desktop: async () => ({ material: 'd'.repeat(40), phone: '138****0000' }) })
  const candidates = await store.poolCandidates()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].origin, 'desktop')
  assert.deepEqual(await store.list({ force: true }), [], 'the desktop credential is read, never stored')
})

test('export → import round-trips without duplicating an account', async (t) => {
  const dir = tempDir(t)
  const source = storeIn(dir)
  await source.add({ kind: 'credentials', material: 'e'.repeat(40), label: 'one' })
  const exported = await source.exportBundle()
  assert.equal(typeof exported.bundle, 'object')

  const target = storeIn(join(tempDir(t)))
  const first = await target.importBundle(exported.bundle)
  assert.equal(first.added, 1)
  const second = await target.importBundle(exported.bundle)
  assert.equal(second.added, 0)
  assert.equal(second.refreshed, 1)
})

test('single-route vendors expose exactly one route, whatever the account count', async (t) => {
  const dir = tempDir(t)
  const store = storeIn(dir, { routeMode: 'single' })
  await store.add({ kind: 'credentials', material: 's'.repeat(40) })
  await store.add({ kind: 'credentials', material: 't'.repeat(40) })
  const routes = await store.routes({ poolEnabled: true })
  // 账号数量不改变路由集合：谁付费是每次调用的决定，不是会话绑定的属性。
  // 返回 N 条同 id 的条目会让宿主收到重复 provider id，选择器里同一个分组挂
  // N 遍（Loomy 曾经就是那样）。
  assert.deepEqual(routes.map((entry) => entry.route), ['demo'])
  assert.deepEqual(
    routes.map((entry) => entry.displayName),
    ['Demo'],
  )
  assert.equal(routes[0].slot, 1)
})

/**
 * 旧账号的身份补全：从会话材料里解出稳定标识，**但不改写落盘数据**。
 *
 * 用户真实数据是 9 条没有 phone 的账号（登录时上游没回号码，label 又被早先的
 * 代码写成了身份类型 `personal`），界面上只能显示「账号 1…9」。小浣熊的 JWT 里
 * 有 `sub`（`pu-01a1e893-…`），每一条都不同——用它补出 `userId` 就足以辨认。
 *
 * 关键约束：这只是**展示层**补全。不落盘，否则等于替用户改写数据，而且会在
 * 上游换了标识口径后留下错的东西。
 */
test('legacy accounts derive a stable identity from their material, without rewriting the file', async (t) => {
  const dir = tempDir(t)
  const token = (n) =>
    `h.${Buffer.from(JSON.stringify({ sub: `pu-01a1e89${n}`, exp: 9_999_999_999 })).toString('base64url')}.s`

  // 先写一份"旧数据"：没有 phone/userId，label 是身份类型。
  const seed = createDocument({
    path: join(dir, 'accounts.json'),
    parse: (text) => JSON.parse(text),
    serialize: (document) => JSON.stringify(document),
    empty: () => ({ version: 1, accounts: [] }),
  })
  await seed.save({
    version: 1,
    accounts: [0, 1, 2].map((n) => ({ id: `old-${n}`, material: token(n), origin: 'plugin', label: 'personal' })),
  })

  const store = createAccountsStore({
    document: seed,
    routeBase: 'demo',
    routeMode: 'single',
    displayName: 'Demo',
    // 供应商提供"从 material 能解出什么"。
    describeMaterial: (material) => {
      const payload = JSON.parse(Buffer.from(material.split('.')[1], 'base64url').toString('utf8'))
      return typeof payload.sub === 'string' ? { userId: payload.sub } : undefined
    },
  })

  const rows = await store.list({ force: true })
  assert.deepEqual(
    rows.map((row) => row.userId),
    ['pu-01a1e890', 'pu-01a1e891', 'pu-01a1e892'],
    '每条旧账号都补出了各自不同的标识',
  )

  // 补出来的值不能落盘。
  const after = await seed.load()
  assert.ok(
    after.accounts.every((account) => account.userId === undefined),
    '展示层补全不写回用户数据',
  )
})

/**
 * 账号保险箱测试。
 *
 * 关注两件安全边界：
 * 1. `list()` 给渲染进程的数据里**绝不能**出现完整 session；
 * 2. 同一 session 反复导入必须幂等（按指纹去重），不能长出一堆重复行。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { accountId, openVault } from '../src/main/vault.js'

const session = (n) => `${String(n).padStart(8, '0')}`.repeat(4)

async function freshVault() {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-vault-'))
  return { dir, file: join(dir, 'accounts.json'), vault: await openVault(join(dir, 'accounts.json')) }
}

test('账号 id 是 (平台, session) 的稳定指纹', () => {
  assert.equal(accountId('loomy', session(1)), accountId('loomy', session(1)))
  assert.notEqual(accountId('loomy', session(1)), accountId('loomy', session(2)))
  assert.equal(accountId('loomy', session(1)).length, 16)
  // 同一段 token 在不同平台必须是两条记录，否则删除/标记会互相误伤
  assert.notEqual(accountId('loomy', session(1)), accountId('raccoon', session(1)))
})

test('导出的视图不含完整 session', async () => {
  const { vault } = await freshVault()
  await vault.upsert([
    { session: session(1), phone: '13100000001', userid: 'u1' },
    { session: session(2), phone: '13100000002', userid: 'u2' },
  ])
  const view = vault.list()
  assert.equal(view.accounts.length, 2)
  const serialized = JSON.stringify(view)
  assert.ok(!serialized.includes(session(1)), '视图里不能出现完整 session')
  // 手机号与 userid 是明文（用户要能区分账号），session 才是唯一脱敏对象
  assert.equal(view.accounts[0].phone, '13100000001')
  assert.equal(view.accounts[0].userid, 'u1')
  assert.ok(!('maskedPhone' in view.accounts[0]), '不再给掩码手机号')
  assert.ok(!('session' in view.accounts[0]), '账号行不应带 session 字段')
  // 但尾巴要留着，供用户区分两份匿名账号
  assert.equal(view.accounts[0].sessionTail.length, 6)
})

test('重复导入同一 session 是幂等的', async () => {
  const { vault } = await freshVault()
  const first = await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  assert.deepEqual(first, { added: 1, updated: 0 })

  const again = await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  assert.deepEqual(again, { added: 0, updated: 1 })
  assert.equal(vault.list().accounts.length, 1)
})

test('重新导入会用新手机号刷新旧行', async () => {
  const { vault } = await freshVault()
  await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  await vault.upsert([{ session: session(1), phone: '13900000009', userid: 'u1' }])
  assert.equal(vault.list().accounts[0].phone, '13900000009')
})

test('备注、删除、当前标记都能落盘', async () => {
  const { file, vault } = await freshVault()
  await vault.upsert([
    { session: session(1), phone: '13100000001', userid: 'u1' },
    { session: session(2), phone: '13100000002', userid: 'u2' },
  ])
  const id = accountId('loomy', session(1))

  await vault.rename(id, '  工作号  ')
  assert.equal(vault.list().accounts.find((a) => a.id === id).label, '工作号')

  await vault.markActive(id)
  assert.equal(vault.list().activeId, id)

  const removed = await vault.remove(id)
  assert.equal(removed.removed, 1)
  assert.equal(vault.list().activeId, undefined, '删掉当前账号后 activeId 应清空')
  assert.equal(vault.list().accounts.length, 1)

  // 重新打开必须是同一份状态（原子写 + 0600）
  const reopened = await openVault(file)
  assert.equal(reopened.list().accounts.length, 1)
  assert.equal(reopened.get(id), undefined)
  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode.toString(8), '600', `accounts.json 权限应为 600，实际 ${mode.toString(8)}`)
})

test('文件损坏时返回空库而不是崩溃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-vault-'))
  const file = join(dir, 'accounts.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ this is not json')
  const vault = await openVault(file)
  assert.deepEqual(vault.list().accounts, [])
  // 还能正常写入并自愈
  await vault.upsert([{ session: session(3), phone: '13100000003', userid: 'u3' }])
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.accounts.length, 1)
})

test('导出 bundle 与 DSH 插件同格式', async () => {
  const { vault } = await freshVault()
  await vault.upsert([
    { session: session(1), phone: '13100000001', userid: 'u1' },
    { session: session(2), phone: '13100000002', userid: 'u2' },
  ])
  await vault.rename(accountId('loomy', session(1)), '个人')
  const bundle = vault.exportBundle()
  assert.equal(bundle.kind, 'dsh-connect-loomy/accounts')
  assert.equal(bundle.version, 1)
  assert.equal(bundle.accounts.length, 2)
  assert.equal(bundle.accounts[0].slot, 1)
  assert.equal(bundle.accounts[0].label, '个人')
  assert.equal(bundle.accounts[0].userId, 'u1', '插件读 userId，不是 userid')
  assert.equal(bundle.accounts[0].session, session(1), '导出必须带真 session')
})

test('缓存账号带过期信息，14 天 TTL', async () => {
  const { vault } = await freshVault()
  await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  const view = vault.list().accounts[0]

  assert.equal(typeof view.credentialedAt, 'number')
  assert.equal(typeof view.expiresAt, 'number')
  // 14 天
  assert.equal(view.expiresAt - view.credentialedAt, 14 * 24 * 60 * 60 * 1000)
  // 刚导入，剩余时间应接近 14 天
  assert.ok(view.expiresInMs > 13.9 * 24 * 60 * 60 * 1000, `剩余 ${view.expiresInMs}`)
  assert.ok(view.expiresInMs <= 14 * 24 * 60 * 60 * 1000)
})

test('重复导入同一 session 不刷新过期时间（同一张票不会因重贴而续期）', async () => {
  const { vault } = await freshVault()
  await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  const first = vault.list().accounts[0].credentialedAt

  await new Promise((resolve) => setTimeout(resolve, 15))
  await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  assert.equal(vault.list().accounts[0].credentialedAt, first, '过期计时不能被重复导入重置')
})

test('切换失败的原因会记在账号上，成功后清除', async () => {
  const { vault } = await freshVault()
  await vault.upsert([{ session: session(1), phone: '13100000001', userid: 'u1' }])
  const id = accountId('loomy', session(1))

  await vault.markFailure(id, '镜像仍是 131****0001')
  assert.equal(vault.list().accounts[0].lastError, '镜像仍是 131****0001')

  await vault.markActive(id)
  assert.equal(vault.list().accounts[0].lastError, undefined, '切换成功后应清除错误')
})

test('老格式文件（没有 credentialedAt）回退到 addedAt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-vault-'))
  const file = join(dir, 'accounts.json')
  const { writeFile, readFile } = await import('node:fs/promises')
  const addedAt = Date.now() - 15 * 24 * 60 * 60 * 1000 // 15 天前导入，已过期
  await writeFile(
    file,
    JSON.stringify({ version: 1, accounts: [{ id: 'abc', session: session(1), phone: '13100000001', userid: 'u1', addedAt }] }),
  )
  const vault = await openVault(file)
  const view = vault.list().accounts[0]
  assert.equal(view.credentialedAt, addedAt)
  assert.ok(view.expiresInMs < 0, '按 addedAt 推算应已过期')
})

test('多平台账号可以并存，互不覆盖', async () => {
  const { vault } = await freshVault()
  const shared = session(1) // 故意用同一段 token 来验证 id 隔离
  await vault.upsert([{ target: 'loomy', session: shared, phone: '13100000001', userid: 'u1' }])
  await vault.upsert([{ target: 'raccoon', session: shared, phone: '13200000002', userid: 'u2' }])

  const all = vault.list().accounts
  assert.equal(all.length, 2, '同一 token 在两个平台应是两条记录')
  assert.deepEqual(all.map((a) => a.target).sort(), ['loomy', 'raccoon'])
  assert.equal(all.find((a) => a.target === 'raccoon').phone, '13200000002')

  // 按平台过滤
  assert.equal(vault.secretList('loomy').length, 1)
  assert.equal(vault.secretList('raccoon').length, 1)
  assert.equal(vault.secretList().length, 2)

  // activeSecret 也按平台取
  const loomyId = accountId('loomy', shared)
  await vault.markActive(loomyId)
  assert.equal(vault.activeSecret('loomy').id, loomyId)
  assert.equal(vault.activeSecret('raccoon').id, accountId('raccoon', shared))

  // 删掉 loomy 那条不能动 raccoon
  await vault.remove(loomyId)
  assert.equal(vault.list().accounts.length, 1)
  assert.equal(vault.list().accounts[0].target, 'raccoon')
})

test('老文件没有 target 字段时迁移为 loomy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-vault-'))
  const file = join(dir, 'accounts.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      accounts: [{ id: 'old-id', session: session(1), phone: '13100000001', userid: 'u1', addedAt: Date.now(), credentialedAt: Date.now() }],
    }),
  )
  const vault = await openVault(file)
  const row = vault.list().accounts[0]
  assert.equal(row.target, 'loomy', '早期只有 Loomy，缺省迁移到 loomy')
  assert.equal(row.id, 'old-id', '已有 id 要保留，不能重算')
})

test('平台自己给的过期时间优先于推算值', async () => {
  const { vault } = await freshVault()
  const platformExpiry = Date.now() + 20 * 86_400_000 // 20 天后（JWT exp）
  await vault.upsert([{ target: 'raccoon', session: session(5), phone: '13200000005', userid: 'u5', expiresAt: platformExpiry }])
  const row = vault.list().accounts[0]
  assert.equal(row.expiresAt, platformExpiry, '小浣熊 JWT 的 exp 应覆盖默认 14 天推算')
  assert.ok(row.expiresInMs > 19 * 86_400_000)
})

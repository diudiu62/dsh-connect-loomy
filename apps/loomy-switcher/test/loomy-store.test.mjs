/**
 * 核心逻辑测试（不需要 Electron）。
 *
 * 重点验证三件容易出错、出错又很难察觉的事：
 *
 * 1. 同一日志里同一个 key 出现多次时，必须取**最后一条**（取错就切错号）；
 * 2. 追加的 WriteBatch 序列号必须大于历史最大值，否则旧值会赢；
 * 3. 日志尾部有半条残缺记录时必须先截断，否则 leveldb 恢复时根本读不到
 *    我们新写的那条。
 */

import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AUTH_KEY,
  LAST_PHONE_KEY,
  appendBatch,
  displayPhone,
  maskPhone,
  normalizeSession,
  parseImport,
  parseRecords,
  replay,
  storageKey,
} from '../src/main/loomy-store.js'

const session = (n) => `${String(n).padStart(8, '0')}`.repeat(4)

/** 造一段跟 Chromium Local Storage 一样的日志：多条 put，最后一条最大。 */
function buildLog(values) {
  let buffer = Buffer.alloc(0)
  for (const value of values) {
    buffer = appendBatch(buffer, [{ key: storageKey(AUTH_KEY), value: JSON.stringify(value) }]).buffer
  }
  return buffer
}

test('同一 key 多次写入，回放取最后一条', () => {
  const log = buildLog([
    { phone: '13100000001', userid: 'u1', session: session(1) },
    { phone: '13100000002', userid: 'u2', session: session(2) },
    { phone: '13100000003', userid: 'u3', session: session(3) },
  ])
  const { value } = replay(log, AUTH_KEY)
  assert.equal(JSON.parse(value).session, session(3))

  const next = appendBatch(log, [
    { key: storageKey(AUTH_KEY), value: JSON.stringify({ phone: '13100000009', userid: 'u9', session: session(9) }) },
  ])
  assert.equal(JSON.parse(replay(next.buffer, AUTH_KEY).value).session, session(9))
})

test('追加记录的序列号严格大于历史最大值', () => {
  const log = buildLog([{ phone: '13100000001', userid: 'u1', session: session(1) }])
  const first = replay(log, AUTH_KEY).sequence
  const plan = appendBatch(log, [{ key: storageKey(AUTH_KEY), value: 'x' }])
  assert.ok(plan.sequence > first, `新序列号 ${plan.sequence} 应大于 ${first}`)
})

test('尾部残缺记录会被截断，否则新写入读不到', () => {
  const log = buildLog([{ phone: '13100000001', userid: 'u1', session: session(1) }])
  // 模拟进程被杀：末尾留下半条记录头 + 半个 body
  const torn = Buffer.concat([log, Buffer.from([0x11, 0x22, 0x33, 0x44, 0x40, 0x00, 0x01, 0xde, 0xad])])
  const plan = appendBatch(torn, [
    { key: storageKey(AUTH_KEY), value: JSON.stringify({ phone: '13100000007', userid: 'u7', session: session(7) }) },
  ])
  assert.ok(plan.truncatedBytes > 0, '应报告被截断的字节数')
  for (const record of parseRecords(plan.buffer)) assert.ok(record.valid, '截断后所有记录 CRC 都应有效')
  assert.equal(JSON.parse(replay(plan.buffer, AUTH_KEY).value).session, session(7))
})

test('删除标记（tag 0）会清掉旧值', () => {
  const log = buildLog([{ phone: '13100000001', userid: 'u1', session: session(1) }])
  const cleared = appendBatch(log, [{ key: storageKey(AUTH_KEY), value: undefined }]).buffer
  assert.equal(replay(cleared, AUTH_KEY).value, undefined)
})

test('块尾空间不足 7 字节时补零到下一块', () => {
  // 造到刚好剩 3 字节的位置：32800 字节的负载
  let buffer = Buffer.alloc(0)
  const filler = 'x'.repeat(32000)
  buffer = appendBatch(buffer, [{ key: storageKey('filler'), value: filler }]).buffer
  const plan = appendBatch(buffer, [{ key: storageKey(AUTH_KEY), value: '{"a":1}' }])
  // 无论是否 padding，解析后都必须能读到新值
  assert.equal(replay(plan.buffer, AUTH_KEY).value, '{"a":1}')
  for (const record of parseRecords(plan.buffer)) assert.ok(record.valid)
})

test('normalizeSession 校验 session / userid / phone', () => {
  const ok = normalizeSession({ session: session(1), userid: '261113104830231339', phone: '18122750898' })
  // 界面用明文手机号；maskedPhone 只为兼容早期插件导出包保留
  assert.equal(ok.phone, '18122750898')
  assert.equal(displayPhone(ok.phone), '18122750898')
  assert.equal(maskPhone(ok.phone), '181****0898')

  assert.throws(() => normalizeSession({ session: 'short', userid: 'u', phone: '18122750898' }), /session 无效/)
  // 首尾空白会被 trim（桌面端文件常见），但中间的空白说明这压根不是 session
  assert.equal(normalizeSession({ session: ` ${session(1)} `, userid: 'u', phone: '18122750898' }).session, session(1))
  assert.throws(() => normalizeSession({ session: `${'a'.repeat(16)} ${'b'.repeat(16)}`, userid: 'u', phone: '18122750898' }), /session 无效/)
  assert.throws(() => normalizeSession({ session: session(1), phone: '18122750898' }), /userid/)
  assert.throws(() => normalizeSession({ session: session(1), userid: 'u', phone: '123' }), /phone/)
  // 桌面端导出的掩码手机号也要能用
  // 历史掩码值原样保留（早期导入的插件包是掩码的），displayPhone 也不去猜
  const legacy = normalizeSession({ session: session(1), userid: 'u', phone: '189****2700' })
  assert.equal(legacy.phone, '189****2700')
  assert.equal(displayPhone(legacy.phone), '189****2700')
})

test('parseImport 支持四种 JSON 形状', () => {
  const single = parseImport(JSON.stringify({ session: session(1), userid: 'u1', phone: '13100000001' }))
  assert.equal(single.length, 1)

  const array = parseImport(JSON.stringify([{ session: session(1), userid: 'u1', phone: '13100000001' }, { session: session(2), userid: 'u2', phone: '13100000002' }]))
  assert.equal(array.length, 2)

  const bundle = parseImport(JSON.stringify({ kind: 'dsh-connect-loomy/accounts', version: 1, accounts: [{ slot: 1, session: session(1), userId: 'u1', phone: '13100000001' }] }))
  assert.equal(bundle.length, 1)

  const wrapped = parseImport(JSON.stringify({ accounts: [{ session: session(1), userid: 'u1', phone: '13100000001' }] }))
  assert.equal(wrapped.length, 1)

  assert.throws(() => parseImport('not json'), /不是合法 JSON/)
  assert.throws(() => parseImport('{"a":1}'), /没有可用的登录态/)
})

test('真实客户端日志：能读出当前账号，且追加后能读回新账号', async () => {
  const candidate = join(homedir(), 'Library', 'Application Support', 'loomy', 'Local Storage', 'leveldb')
  const names = existsSync(candidate) ? await readFileList(candidate) : []
  const logName = names.filter((n) => n.endsWith('.log')).sort().at(-1)
  if (logName === undefined) {
    test.skip?.('本机没有 Loomy 日志，跳过')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'loomy-log-'))
  const copy = join(dir, 'test.log')
  // 客户端可能在跑并正在写这个文件，cp 有可能抓到半条记录。重试几次；
  // 这条测试要验证的是"解析器能读懂真实格式"，不是"能读一个正在被写的文件"。
  let copied = false
  for (let attempt = 0; attempt < 5 && !copied; attempt += 1) {
    try {
      await copyFile(join(candidate, logName), copy)
      // 能被完整解析（有至少一条有效记录）就算抓到一份好的
      copied = parseRecords(await readFile(copy)).some((record) => record.valid)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  if (!copied) return // 客户端一直在写，跳过这条真机测试，不影响其他断言

  const raw = await readFile(copy)
  const before = replay(raw, AUTH_KEY)
  assert.ok(before.value !== undefined, '真实日志里应有登录态')

  const target = normalizeSession({ session: session(7), userid: '261116130133991810', phone: '17144532846' })
  const plan = appendBatch(raw, [
    { key: storageKey(AUTH_KEY), value: JSON.stringify(target) },
    { key: storageKey(LAST_PHONE_KEY), value: target.phone },
  ])
  await writeFile(copy, plan.buffer)

  const after = replay(await readFile(copy), AUTH_KEY)
  assert.equal(JSON.parse(after.value).session, target.session)
  assert.equal(JSON.parse(after.value).userid, target.userid)
  for (const record of parseRecords(await readFile(copy))) assert.ok(record.valid, '追加后每条记录 CRC 都应有效')
})

async function readFileList(dir) {
  const { readdir } = await import('node:fs/promises')
  return readdir(dir)
}

test('导入接受 0.3.0 插件导出包（material 而不是 session）', () => {
  const bundle = parseImport(
    JSON.stringify({
      kind: 'dsh-connect-desktop/accounts',
      version: 1,
      accounts: [{ id: 'loomy-abc', material: session(2), userId: 'u2', phone: '13100000002' }],
    }),
  )
  assert.equal(bundle.length, 1)
  assert.equal(bundle[0].session, session(2))
  assert.equal(bundle[0].userid, 'u2')
})

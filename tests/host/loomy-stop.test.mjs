/**
 * Loomy: a benched pool must not be reported as "signed out", and the same
 * cooling contract as the Raccoon vendor applies.
 *
 * Old behaviour: with one stored account benched the code fell through to the
 * desktop `auth.json` fallback and reported `没有可用的 Loomy 登录态` — a message
 * that sends the user to re-login an account that is not broken. The account
 * rows exist and are merely cooling down.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  POOL_COOLING_CODE,
  createLoomyModule,
  createVendorDeps,
  disqualifiesFailureCode,
} from '../../lib/index.js'

async function runtimeIn(dir) {
  const module = createLoomyModule()
  return await module.create(
    createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir: join(dir, 'state'),
    }),
  )
}

test('a benched single account reports the cooldown, not a missing login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-stop-'))
  const saved = process.env['LOOMY_AUTH_SESSION_FILE']
  // 桌面登录态钉到不存在的文件：本用例只关心"有账号行但在冷却"。
  process.env['LOOMY_AUTH_SESSION_FILE'] = join(dir, 'no-session.json')
  try {
    const runtime = await runtimeIn(dir)
    const added = await runtime.accounts.add({ kind: 'credentials', material: 's'.repeat(40), label: 'one' })
    await runtime.accounts.markUnavailable(added.id, 'RATE_LIMIT', '429: rate limited')

    await assert.rejects(runtime.resolveCredential('loomy'), (error) => {
      assert.equal(error.code, POOL_COOLING_CODE, '冷却 ≠ 凭据缺失')
      assert.match(error.message, /冷却/u)
      assert.match(error.message, /自动恢复/u)
      assert.doesNotMatch(error.message, /没有可用的 Loomy 登录态/u)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env['LOOMY_AUTH_SESSION_FILE']
    else process.env['LOOMY_AUTH_SESSION_FILE'] = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a permanently dead account still gets the re-login instruction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-stop-'))
  const saved = process.env['LOOMY_AUTH_SESSION_FILE']
  process.env['LOOMY_AUTH_SESSION_FILE'] = join(dir, 'no-session.json')
  try {
    const runtime = await runtimeIn(dir)
    const added = await runtime.accounts.add({ kind: 'credentials', material: 's'.repeat(40), label: 'one' })
    await runtime.accounts.markUnavailable(added.id, 'MISSING_CREDENTIAL', '登录态已失效')

    await assert.rejects(runtime.resolveCredential('loomy'), (error) => {
      assert.equal(error.code, 'MISSING_CREDENTIAL')
      assert.match(error.message, /不可用|登录/u)
      assert.doesNotMatch(error.message, /自动恢复/u)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env['LOOMY_AUTH_SESSION_FILE']
    else process.env['LOOMY_AUTH_SESSION_FILE'] = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 429 的 message 可能只有一个状态码（`429 status code (no body)`），不含
 * "rate limit" 字样。只按文案判定的旧规则会放过它，账号不被 bench，下一次
 * 调用又挑到它。判定必须同时看 code。
 */
test('a bare 429 benches the account through its code, without any wording', () => {
  assert.equal(disqualifiesFailureCode('RATE_LIMIT'), true)
  assert.equal(disqualifiesFailureCode('RATE_LIMITED'), true)
  assert.equal(disqualifiesFailureCode('TOO_MANY_REQUESTS'), true)
  assert.equal(disqualifiesFailureCode('QUOTA_EXCEEDED'), true)
  assert.equal(disqualifiesFailureCode('TRANSPORT'), false)
  assert.equal(disqualifiesFailureCode(undefined), false)
})

/**
 * 桌面端登录态也要被 bench（core 共享实现）。
 *
 * 它不在持久化账号表里（插件永不写客户端文件），但它是 `poolCandidates()` 的
 * 第 0 个候选、轮换的成员之一。没有这块账，一个被限流的桌面令牌会被每次调用
 * 反复重试。
 */
test('the desktop identity is attributed, benched on failure and reported as cooling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-stop-'))
  const { writeFileSync } = await import('node:fs')
  const saved = process.env['LOOMY_AUTH_SESSION_FILE']
  const authPath = join(dir, 'auth-session.json')
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  const payload = Buffer.from(JSON.stringify({ exp, phone: '13812345678', userid: 'u1' })).toString('base64url')
  writeFileSync(authPath, JSON.stringify({ session: 'd'.repeat(40), phone: '13812345678', userid: 'u1', exp: exp * 1000 }))
  process.env['LOOMY_AUTH_SESSION_FILE'] = authPath
  try {
    const runtime = await runtimeIn(dir)
    // 桌面身份被归因：resolveCredential 返回它的 accountId。
    const desktop = await runtime.resolveCredential('loomy')
    assert.equal(desktop.accountId, 'desktop')

    await runtime.accounts.markUnavailable('desktop', 'RATE_LIMIT', '429 rate limited')
    await assert.rejects(runtime.resolveCredential('loomy'), (error) => {
      assert.equal(error.code, POOL_COOLING_CODE)
      assert.match(error.message, /冷却/u)
      assert.doesNotMatch(error.message, /没有可用的 Loomy 登录态/u)
      return true
    })

    // 成功一次就清空：桌面身份回到可用。
    await runtime.accounts.markHealthy('desktop')
    const recovered = await runtime.resolveCredential('loomy')
    assert.equal(recovered.accountId, 'desktop')
  } finally {
    if (saved === undefined) delete process.env['LOOMY_AUTH_SESSION_FILE']
    else process.env['LOOMY_AUTH_SESSION_FILE'] = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 冷却错误的第二条出路：桌面端有登录态时，告诉用户可以「加入账号表」。
 * 没有桌面登录态时这句话是噪音，必须不出现。
 */
test('the cooling error points at the adopt path only when a desktop session exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-stop-'))
  const { writeFileSync } = await import('node:fs')
  const saved = process.env['LOOMY_AUTH_SESSION_FILE']

  // ① 桌面端有登录态：提示「加入账号表」。
  const authPath = join(dir, 'auth-session.json')
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  const payload = Buffer.from(JSON.stringify({ exp, phone: '13812345678', userid: 'u1' })).toString('base64url')
  writeFileSync(authPath, JSON.stringify({ session: 'd'.repeat(40), phone: '13812345678', userid: 'u1', exp: exp * 1000 }))
  process.env['LOOMY_AUTH_SESSION_FILE'] = authPath
  try {
    const runtime = await runtimeIn(dir)
    const added = await runtime.accounts.add({ kind: 'credentials', material: 's'.repeat(40), label: 'one' })
    await runtime.accounts.markUnavailable(added.id, 'RATE_LIMIT', '429 rate limited')
    await assert.rejects(runtime.resolveCredential('loomy'), (error) => {
      assert.equal(error.code, POOL_COOLING_CODE)
      assert.match(error.message, /加入账号表/u)
      return true
    })
  } finally {
    process.env['LOOMY_AUTH_SESSION_FILE'] = saved
    rmSync(dir, { recursive: true, force: true })
  }

  // ② 没有桌面登录态：不提「加入账号表」。
  const dir2 = mkdtempSync(join(tmpdir(), 'loomy-stop-'))
  process.env['LOOMY_AUTH_SESSION_FILE'] = join(dir2, 'no-session.json')
  try {
    const runtime = await runtimeIn(dir2)
    const added = await runtime.accounts.add({ kind: 'credentials', material: 's'.repeat(40), label: 'one' })
    await runtime.accounts.markUnavailable(added.id, 'RATE_LIMIT', '429 rate limited')
    await assert.rejects(runtime.resolveCredential('loomy'), (error) => {
      assert.equal(error.code, POOL_COOLING_CODE)
      assert.doesNotMatch(error.message, /加入账号表/u)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env['LOOMY_AUTH_SESSION_FILE']
    else process.env['LOOMY_AUTH_SESSION_FILE'] = saved
    rmSync(dir2, { recursive: true, force: true })
  }
})

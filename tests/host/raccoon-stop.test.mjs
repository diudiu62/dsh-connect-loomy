/**
 * Raccoon: what happens when every account is benched.
 *
 * The upstream answers account-level risk control with `429 code 200108`
 * 「异常调用」 (2026-11-23: eight accounts inside ninety seconds). The old
 * behaviour picked the least-recently-failed account and fired anyway, which
 * re-confirmed the restriction every time. The contract now: stop, and say
 * when the first account comes back.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_POINTS_COOLDOWN_MS,
  NO_POINTS_CODE,
  POOL_COOLING_CODE,
  ZERO_POINTS_MESSAGE,
  createDocument,
  createRaccoonModule,
} from '../../lib/index.js'

const RATE_LIMIT_BODY =
  '429: {"code":200108,"message":"系统检测到当前账号存在异常调用，模型调用功能已暂时受限。","type":"rate_limit_error"}'

function fakeDeps(dir, settings = {}) {
  return {
    descriptor: { id: 'raccoon', displayName: 'Raccoon', capabilities: {}, accent: '#f60' },
    config: settings,
    setting: (key) => settings[key],
    storageDir: dir,
    document: (name, options) =>
      createDocument({ path: join(dir, name), ...options }),
    logger: { info() {}, warn() {}, error() {} },
    now: () => Date.now(),
    attachments: () => undefined,
    imageAccess: () => undefined,
    modelsUpdated() {},
  }
}

test('a fully benched pool stops instead of spending a restricted account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-stop-'))
  // 这台机器装着客户端：把凭据与设备标识钉到不存在的路径，避免读到真实登录态。
  const saved = {
    auth: process.env['RACCOON_AUTH_FILE'],
    device: process.env['RACCOON_DEVICE_ID_FILE'],
  }
  process.env['RACCOON_AUTH_FILE'] = join(dir, 'no-auth.json')
  process.env['RACCOON_DEVICE_ID_FILE'] = join(dir, 'no-device.json')
  try {
    const runtime = createRaccoonModule().create(fakeDeps(dir))
    const added = await runtime.accounts.add({ kind: 'credentials', material: 'token-1', label: 'one' })
    await runtime.preferences.setPoolEnabled(true)
    const verdict = await runtime.accounts.markUnavailable(added.id, 'RATE_LIMIT', RATE_LIMIT_BODY)
    assert.ok(verdict.cooldownMs > 0, '累加后的窗口要回报给调用方')

    await assert.rejects(
      runtime.resolveCredential('raccoon'),
      (error) => {
        assert.match(error.message, /冷却中/u)
        assert.match(error.message, /自动恢复/u)
        // 不再有"换一个被禁账号继续打"的措辞。
        assert.doesNotMatch(error.message, /最久/u)
        // 冷却 ≠ 凭据缺失：code 必须说清"登录是好的，只是现在不能花"。
        assert.equal(error.code, POOL_COOLING_CODE)
        assert.notEqual(error.code, 'MISSING_CREDENTIAL')
        return true
      },
    )

    // 预测器同样停手：探针不该在全部冷却时发请求。
    const probes = await runtime.probeEndpoints()
    assert.equal(probes.every((probe) => probe.ok === false), true)
    assert.match(probes[0].reason, /冷却中|限制/u)
  } finally {
    if (saved.auth === undefined) delete process.env['RACCOON_AUTH_FILE']
    else process.env['RACCOON_AUTH_FILE'] = saved.auth
    if (saved.device === undefined) delete process.env['RACCOON_DEVICE_ID_FILE']
    else process.env['RACCOON_DEVICE_ID_FILE'] = saved.device
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a permanent failure still gets the re-login instruction, not a cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-stop-'))
  const saved = process.env['RACCOON_AUTH_FILE']
  const savedDevice = process.env['RACCOON_DEVICE_ID_FILE']
  process.env['RACCOON_AUTH_FILE'] = join(dir, 'no-auth.json')
  process.env['RACCOON_DEVICE_ID_FILE'] = join(dir, 'no-device.json')
  try {
    const runtime = createRaccoonModule().create(fakeDeps(dir))
    const added = await runtime.accounts.add({ kind: 'credentials', material: 'token-1', label: 'one' })
    await runtime.preferences.setPoolEnabled(true)
    await runtime.accounts.markUnavailable(added.id, 'AUTH', '401: {"code":200003,"message":"authorization_verify_error"}')

    await assert.rejects(runtime.resolveCredential('raccoon'), (error) => {
      assert.match(error.message, /失效|重新登录/u)
      assert.doesNotMatch(error.message, /自动恢复/u)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env['RACCOON_AUTH_FILE']
    else process.env['RACCOON_AUTH_FILE'] = saved
    if (savedDevice === undefined) delete process.env['RACCOON_DEVICE_ID_FILE']
    else process.env['RACCOON_DEVICE_ID_FILE'] = savedDevice
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the vendor declares the concurrency the official client tolerates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-stop-'))
  try {
    const runtime = createRaccoonModule().create(fakeDeps(dir))
    assert.equal(runtime.concurrency?.(), 2, '官方本地中继自限 2 路')
    const raised = createRaccoonModule().create(fakeDeps(dir, { concurrency: 4 }))
    assert.equal(raised.concurrency?.(), 4, '配置可以放宽')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 冷却不等于签出：整组模型不能因为"账号在冷却"就从选择器里消失。
 *
 * 选择器/卡片看的 `credentials.read()` 退回无池路径（桌面端登录态还在就报
 * 已登录），调用侧才由 `resolveCredential` 说"现在不能花"。
 */
test('a cooling pool still reports the desktop login, so the group stays visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-stop-'))
  const saved = {
    auth: process.env['RACCOON_AUTH_FILE'],
    device: process.env['RACCOON_DEVICE_ID_FILE'],
  }
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  const payload = Buffer.from(JSON.stringify({ exp, iss: 'xiaohuanxiong.com/iam' })).toString('base64url')
  const authFile = join(dir, 'auth.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(authFile, JSON.stringify({ access_token: `h.${payload}.s`, office_identity: 'personal' }))
  process.env['RACCOON_AUTH_FILE'] = authFile
  process.env['RACCOON_DEVICE_ID_FILE'] = join(dir, 'no-device.json')
  try {
    const runtime = createRaccoonModule().create(fakeDeps(dir))
    const added = await runtime.accounts.add({ kind: 'credentials', material: 'token-1', label: 'one' })
    await runtime.preferences.setPoolEnabled(true)
    await runtime.accounts.markUnavailable(added.id, 'RATE_LIMIT', RATE_LIMIT_BODY)
    // 桌面端登录态也是池成员：也禁掉它，制造"全池冷却"。
    await runtime.accounts.markUnavailable('desktop', 'RATE_LIMIT', RATE_LIMIT_BODY)

    const state = await runtime.credentials.read({ force: true })
    assert.equal(state.found, true, '有桌面登录态就算已登录')
    assert.equal(state.sourceOrigin, 'desktop')

    await assert.rejects(runtime.resolveCredential('raccoon'), (error) => {
      assert.equal(error.code, POOL_COOLING_CODE)
      assert.match(error.message, /冷却中/u)
      return true
    })
  } finally {
    if (saved.auth === undefined) delete process.env['RACCOON_AUTH_FILE']
    else process.env['RACCOON_AUTH_FILE'] = saved.auth
    if (saved.device === undefined) delete process.env['RACCOON_DEVICE_ID_FILE']
    else process.env['RACCOON_DEVICE_ID_FILE'] = saved.device
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 轮换关闭时，锁定的账号也要被"暂停"覆盖。
 *
 * `pickWithoutPool` 同时回答"有没有登录"，所以暂停不能塞进它；调用侧必须自己
 * 拦一道。否则一个零余额账号被锁定时，每次对话都白烧一次上游调用，用户只看到
 * "又失败了"，看不到"额度不足，充值后自动回来"。
 */
test('a locked account that ran out of points is paused, not spent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-points-'))
  const saved = {
    auth: process.env['RACCOON_AUTH_FILE'],
    device: process.env['RACCOON_DEVICE_ID_FILE'],
  }
  process.env['RACCOON_AUTH_FILE'] = join(dir, 'no-auth.json')
  process.env['RACCOON_DEVICE_ID_FILE'] = join(dir, 'no-device.json')
  try {
    const runtime = createRaccoonModule().create(fakeDeps(dir))
    const added = await runtime.accounts.add({ kind: 'credentials', material: 'token-p', label: 'p' })
    // 轮换关闭，锁在这个账号上——用户以为"只用这个号"。
    await runtime.preferences.setPoolEnabled(false)
    await runtime.preferences.setActiveAccountId(added.id)
    // 读余额发现可用为 0：额度类暂停，窗口比限流长。
    const verdict = await runtime.accounts.markUnavailable(
      added.id,
      NO_POINTS_CODE,
      ZERO_POINTS_MESSAGE,
    )
    assert.ok(verdict.cooldownMs >= DEFAULT_POINTS_COOLDOWN_MS, '额度窗口不能比基础窗口短')

    await assert.rejects(runtime.resolveCredential('raccoon'), (error) => {
      assert.equal(error.code, POOL_COOLING_CODE, '额度不足仍是"已登录但不能花"')
      assert.match(error.message, /额度不足/u)
      assert.match(error.message, /自动恢复/u)
      assert.doesNotMatch(error.message, /重新登录/u, '额度不足不该引导去重新登录')
      return true
    })
  } finally {
    if (saved.auth === undefined) delete process.env['RACCOON_AUTH_FILE']
    else process.env['RACCOON_AUTH_FILE'] = saved.auth
    if (saved.device === undefined) delete process.env['RACCOON_DEVICE_ID_FILE']
    else process.env['RACCOON_DEVICE_ID_FILE'] = saved.device
    rmSync(dir, { recursive: true, force: true })
  }
})

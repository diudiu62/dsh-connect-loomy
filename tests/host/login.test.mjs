import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configFromEnv,
  createLoginService,
  decryptLoomyEnv,
  authSessionCandidatesWithPlugin,
  readPluginAuthSession,
  writePluginAuthSession,
  clearPluginAuthSession,
  pluginAuthPath,
  PHONE_PATTERN,
} from '../../lib/index.js'

/** Stand-in for the app's embedded account-plane credentials. */
const FAKE_CONFIG = {
  baseURL: 'https://account.invalid',
  accessKeyId: 'test-key-id',
  accessKeySecret: 'test-key-secret',
  appId: 'test-app',
}

/** A fake fetch that answers the account envelope the way the real one does. */
function fakeFetch(routes) {
  return async (url, init) => {
    const path = new URL(url).pathname
    const handler = routes[path]
    if (handler === undefined) throw new Error(`unexpected path ${path}`)
    return new Response(JSON.stringify(handler(init?.body === undefined ? undefined : JSON.parse(init.body))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('decryptLoomyEnv round-trips the app payload shape', () => {
  // A plain (dev) payload passes through unchanged.
  const plain = decryptLoomyEnv('FOO=bar\nBAZ_QUX=1')
  assert.equal(plain.FOO, 'bar')
  assert.equal(plain.BAZ_QUX, '1')
})

test('configFromEnv accepts both the LOOMY_ and VITE_ key spellings', () => {
  const loomy = configFromEnv({
    LOOMY_XFYUN_BASE_URL: 'https://a', LOOMY_XFYUN_ACCESS_KEY_ID: 'id',
    LOOMY_XFYUN_ACCESS_KEY_SECRET: 'sec', LOOMY_XFYUN_APP_ID: 'app',
  })
  assert.equal(loomy?.appId, 'app')
  const vite = configFromEnv({
    VITE_XFYUN_BASE_URL: 'https://b', VITE_XFYUN_ACCESS_KEY_ID: 'id2',
    VITE_XFYUN_ACCESS_KEY_SECRET: 'sec2', VITE_XFYUN_APP_ID: 'app2',
  })
  assert.equal(vite?.baseURL, 'https://b')
  assert.equal(configFromEnv({ VITE_XFYUN_BASE_URL: 'https://c' }), undefined)
})

test('PHONE_PATTERN accepts mainland mobiles only', () => {
  assert.ok(PHONE_PATTERN.test('13800001234'))
  assert.ok(!PHONE_PATTERN.test('10000001234'))
  assert.ok(!PHONE_PATTERN.test('1380000123'))
  assert.ok(!PHONE_PATTERN.test('abc'))
})

test('login service: send → cooldown → verify → session stored, precedence plugin-first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-login-'))
  try {
    let calls = 0
    const fetchImpl = fakeFetch({
      '/login/phone/sendMsgCode': (body) => {
        calls += 1
        assert.equal(body.param.phone, '13800001234')
        return { code: '000000', desc: '成功', data: { msgid: 'm1' } }
      },
      '/login/phone/checkCode': (body) => {
        assert.equal(body.param.mcode, '123456')
        return { code: '000000', desc: '成功', data: { session: 's'.repeat(40), userid: 'u-9' } }
      },
    })

    const service = createLoginService({
      storageDir: () => dir,
      invalidateAuth: () => {},
      now: () => 1_000_000,
      fetchImpl,
      // CI has no Loomy.app, so the credentials must be supplied here rather
      // than resolved from the filesystem.
      resolveConfig: () => ({ kind: 'ok', config: FAKE_CONFIG, sourcePath: 'test' }),
    })

    // Invalid phone is refused locally, no upstream call.
    const bad = await service.sendCode('12345')
    assert.equal(bad.ok, false)
    assert.equal(calls, 0)

    // A code round-trip.
    const sent = await service.sendCode('13800001234')
    assert.equal(sent.ok, true)
    assert.equal(sent.msgid, 'm1')
    assert.equal(sent.phone.startsWith('138'), true)
    assert.equal(sent.resendAfterMs, 60_000)

    // Cooldown: a second send before the window is refused without a call.
    const again = await service.sendCode('13800001234')
    assert.equal(again.ok, false)
    assert.equal(again.code, 'cooldown')
    assert.equal(calls, 1)

    // Login without the same pending phone is refused.
    const wrongPhone = await service.login('13900001234', '123456')
    assert.equal(wrongPhone.ok, false)
    assert.equal(wrongPhone.code, 'no_pending_code')

    // Successful verification persists the session with the document shape
    // the desktop parser reads, and 0600 modes.
    const done = await service.login('13800001234', '123456')
    assert.equal(done.ok, true)
    const stored = await readPluginAuthSession(dir)
    assert.equal(stored.found, true)
    assert.equal(stored.userId, 'u-9')
    const raw = JSON.parse(readFileSync(pluginAuthPath(dir), 'utf8'))
    assert.equal(typeof raw.session, 'string')
    assert.equal(raw.phone, '13800001234')
    assert.equal((statSync(pluginAuthPath(dir)).mode & 0o777), 0o600)

    // Candidates put the plugin store ahead of the desktop file.
    const candidates = authSessionCandidatesWithPlugin(dir)
    assert.equal(candidates[0].path, pluginAuthPath(dir))
    assert.equal(candidates[0].origin, 'plugin')

    // Logout removes only the plugin-side file.
    const out = await service.logout()
    assert.equal(out.ok, true)
    assert.equal(existsSync(pluginAuthPath(dir)), false)
    assert.equal((await readPluginAuthSession(dir)).found, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('login service surfaces upstream failures verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-login-err-'))
  try {
    const fetchImpl = fakeFetch({
      '/login/phone/sendMsgCode': () => ({ code: '000000', data: { msgid: 'm2' } }),
      '/login/phone/checkCode': () => ({ code: '100004', desc: '验证码错误' }),
    })
    const service = createLoginService({
      storageDir: () => dir,
      invalidateAuth: () => {},
      now: () => 2_000_000,
      fetchImpl,
      resolveConfig: () => ({ kind: 'ok', config: FAKE_CONFIG, sourcePath: 'test' }),
    })
    await service.sendCode('13800001234')
    const failed = await service.login('13800001234', '000000')
    assert.equal(failed.ok, false)
    assert.equal(failed.message.includes('验证码错误'), true)
    // No session was written on failure.
    assert.equal(existsSync(pluginAuthPath(dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 登录成功后，账号记录里必须带手机号。
 *
 * 用户报过："账号没有显示具体的号码，都是显示「账号 n」。"根因就在这里：
 * 上游 `checkCode` 只在响应里带 `phone` 时才回传，而它**并不总是带**。
 * 那种情况下账号记录没有 phone，设置卡片只能显示一个认不出来的序号。
 *
 * 号码有两个来源可以兜底：`verifySmsCode` 用请求里的号码、`persistLogin` 用
 * `fallbackPhone`。这条测试把「上游不返回 phone」这个真实情况固定下来。
 */
test('the stored account carries the phone the user typed, even when upstream omits it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-login-phone-'))
  try {
    const added = []
    const fetchImpl = fakeFetch({
      '/login/phone/sendMsgCode': () => ({ code: '000000', desc: '成功', data: { msgid: 'm2' } }),
      // 注意：响应里**没有** phone。这是上游真实行为之一。
      '/login/phone/checkCode': () => ({ code: '000000', desc: '成功', data: { session: 'z'.repeat(40) } }),
    })

    const service = createLoginService({
      storageDir: () => dir,
      invalidateAuth: () => {},
      now: () => 2_000_000,
      fetchImpl,
      resolveConfig: () => ({ kind: 'ok', config: FAKE_CONFIG, sourcePath: 'test' }),
      // 多账号：走 accounts.add，而不是落单文件。
      accounts: {
        async add(input) {
          added.push(input)
          return { kind: 'ok', account: { id: 'acc-1', slot: 1 }, replaced: false }
        },
      },
    })

    await service.sendCode('13800001234')
    const done = await service.login('13800001234', '123456')
    assert.equal(done.ok, true)
    assert.equal(added.length, 1)
    assert.equal(
      added[0].phone,
      '13800001234',
      '上游没回 phone 时必须用用户输入的号码，否则账号行显示不出号码',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

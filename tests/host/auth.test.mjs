/**
 * Credential discovery: `auth-session.json` parsing, phone masking and the
 * public (credential-free) views.
 *
 * The safety invariant is the point of this file: the raw session, the full
 * phone and the full user id may exist only inside the host's in-memory
 * snapshot, never in a value that a route, the CLI `--json` output or the
 * state cache could serialise.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  accountViewOf,
  authSessionCandidates,
  createAuthStore,
  credentialViewOf,
  maskPhone,
  maskUserId,
  nextStepsFor,
  readAuthSession,
  redactSensitive,
  sessionFingerprint,
} from '../../lib/index.js'
import {
  RAW_PHONE,
  RAW_USER_ID,
  SESSION,
  authDocument,
  candidate,
  tempDir,
  writeAuthFile,
} from './helpers.mjs'

const readAuth = readAuthSession
const createStore = createAuthStore

test('maskPhone keeps three digits and the last four, and degrades safely', () => {
  // The shape the card renders for a normal mainland mobile number.
  assert.equal(maskPhone('13812345678'), '138****5678')
  assert.equal(maskPhone(' 138 1234 5678 '), '138****5678')
  // Short/odd values must never leak the digits they happen to contain.
  assert.equal(maskPhone('1234567'), '1*****7')
  assert.equal(maskPhone('12345'), '1***5')
  assert.equal(maskPhone('1234'), '****')
  assert.equal(maskPhone('+'), undefined)
  assert.equal(maskPhone(''), undefined)
  assert.equal(maskPhone(undefined), undefined)
  assert.equal(maskPhone(null), undefined)
  assert.equal(maskPhone(42), undefined)
  assert.equal(maskPhone({}), undefined)
  assert.equal(maskPhone([]), undefined)
  // A value that is not an 11-digit mobile still gets masked, never echoed.
  assert.equal(maskPhone('8613812345678'), '861******5678')
})

test('maskUserId keeps only the first and last four characters', () => {
  assert.equal(maskUserId(RAW_USER_ID), '1234**********5678')
  assert.equal(maskUserId('abcdefgh'), '********')
  assert.equal(maskUserId('abc'), '***')
  assert.equal(maskUserId(''), undefined)
  assert.equal(maskUserId(undefined), undefined)
})

test('readAuthSession parses the real document shape and keeps the account readable', async (t) => {
  const dir = tempDir(t)
  const path = writeAuthFile(dir)
  const snapshot = await readAuth([candidate(path)])

  assert.equal(snapshot.found, true)
  assert.equal(snapshot.sourcePath, path)
  assert.equal(snapshot.session, SESSION, 'the raw session is available in memory')
  // 账号视图不脱敏（产品决定）：本地卡片要能让用户核对自己登的是哪个号。
  assert.equal(snapshot.phone, RAW_PHONE)
  assert.equal(snapshot.userId, RAW_USER_ID)
  assert.equal(snapshot.loginAt, 1_794_574_693_000)
  assert.equal(snapshot.candidates[0].state, 'ok')
  // A non-reversible fingerprint scopes caches; it must not be the token.
  assert.match(snapshot.fingerprint, /^[0-9a-f]{16}$/u)
  assert.notEqual(snapshot.fingerprint, SESSION)
  assert.equal(sessionFingerprint(SESSION), snapshot.fingerprint)

  const account = accountViewOf(snapshot)
  assert.deepEqual(account, {
    phone: RAW_PHONE,
    loginAt: 1_794_574_693_000,
    userId: RAW_USER_ID,
  })
  const credential = credentialViewOf(snapshot)
  assert.equal(credential.found, true)
  assert.equal(credential.sourcePath, path)
  // 视图现在带来源与候选列表：卡片和诊断读的是同一份事实，不能再只回答"找到没找到"。
  assert.equal(credential.sourceOrigin, 'desktop')
  assert.ok(credential.candidates.length > 0)
  assert.deepEqual(nextStepsFor(snapshot), [])

  // 账号信息按产品决定原样展示；**唯一**仍然绝对不能出门的是会话本身。
  for (const view of [account, credentialViewOf(snapshot), nextStepsFor(snapshot)]) {
    const text = JSON.stringify(view)
    assert.ok(!text.includes(SESSION), 'session must not reach a public view')
  }
  // 脱敏能力仍然存在，只是用途收窄到日志/上游错误文本。
  assert.equal(maskPhone(RAW_PHONE), '138****5678')
  assert.equal(maskUserId(RAW_USER_ID), '1234**********5678')
})

test('updatedAt is accepted both as seconds and milliseconds', async (t) => {
  const dir = tempDir(t)
  const seconds = writeAuthFile(dir, JSON.stringify({ session: SESSION, phone: RAW_PHONE, updatedAt: 1_794_574_693 }), 'seconds.json')
  const millis = writeAuthFile(dir, JSON.stringify({ session: SESSION, phone: RAW_PHONE, updatedAt: 1_794_574_693_123 }), 'millis.json')

  assert.equal((await readAuth([candidate(seconds)])).loginAt, 1_794_574_693_000)
  assert.equal((await readAuth([candidate(millis)])).loginAt, 1_794_574_693_123)
})

test('a missing file is a signed-out state with executable next steps', async (t) => {
  const dir = tempDir(t)
  const path = `${dir}/does-not-exist.json`
  const snapshot = await readAuth([candidate(path)])

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'missing')
  assert.equal(snapshot.session, undefined)
  assert.equal(snapshot.sourcePath, path)
  assert.ok(snapshot.problem.includes(path), 'the inspected path is named')
  assert.match(snapshot.problem, /启动 Loomy 客户端/u)
  assert.equal(accountViewOf(snapshot), null)
  const credential = credentialViewOf(snapshot)
  assert.equal(credential.found, false)
  assert.equal(credential.sourcePath, path)
  assert.equal(credential.sourceOrigin, 'none')
  assert.ok(nextStepsFor(snapshot).length >= 2)
  assert.equal(snapshot.candidates[0].exists, false)
  assert.equal(snapshot.candidates[0].state, 'missing')
})

test('invalid JSON reports invalid_json with a re-login instruction', async (t) => {
  const dir = tempDir(t)
  const path = writeAuthFile(dir, '{not json')
  const snapshot = await readAuth([candidate(path)])

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'invalid_json')
  assert.match(snapshot.problem, /不是合法 JSON/u)
  assert.match(snapshot.problem, /重新登录/u)
  assert.equal(snapshot.candidates[0].state, 'invalid_json')
})

test('a document without a usable session reports invalid_shape', async (t) => {
  const dir = tempDir(t)
  const path = writeAuthFile(dir, JSON.stringify({ session: 'short', phone: RAW_PHONE }))
  const snapshot = await readAuth([candidate(path)])

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'invalid_shape')
  assert.match(snapshot.problem, /session 字段/u)
  assert.equal(snapshot.candidates[0].state, 'invalid_shape')
})

test('an encrypted payload is not mistaken for a Loomy session', async (t) => {
  const dir = tempDir(t)
  const path = writeAuthFile(dir, JSON.stringify({ encrypted: true, data: 'ciphertext' }))
  const snapshot = await readAuth([candidate(path)])

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'encrypted')
  assert.match(snapshot.problem, /明文登录态/u)
  assert.equal(snapshot.candidates[0].state, 'encrypted')
})

test('candidates are inspected in order and the first valid one wins', async (t) => {
  const dir = tempDir(t)
  const broken = writeAuthFile(dir, '{oops', 'broken.json')
  const valid = writeAuthFile(dir, authDocument({ phone: '13900001111' }), 'valid.json')
  const snapshot = await readAuth([candidate(broken), candidate(valid)])

  assert.equal(snapshot.found, true)
  assert.equal(snapshot.sourcePath, valid)
  assert.equal(snapshot.phone, '13900001111')
  assert.deepEqual(
    snapshot.candidates.map((entry) => entry.state),
    ['invalid_json', 'ok'],
  )
})

test('createAuthStore caches for the TTL and invalidate() forces a re-read', async (t) => {
  const dir = tempDir(t)
  const path = writeAuthFile(dir)
  let clock = 0
  const store = createStore({ candidates: [candidate(path)], now: () => clock, ttlMs: () => 5_000 })

  assert.equal((await store.read()).phone, RAW_PHONE)

  // A desktop re-login rewrites the file; inside the TTL the old snapshot is
  // served, which keeps one model request from re-reading the file repeatedly.
  writeAuthFile(dir, authDocument({ phone: '13900001111', session: 'f'.repeat(32) }))
  assert.equal((await store.read()).phone, RAW_PHONE)

  clock = 6_000
  const refreshed = await store.read()
  assert.equal(refreshed.phone, '13900001111')
  assert.equal(refreshed.session, 'f'.repeat(32))

  writeAuthFile(dir, authDocument({ phone: '13700002222', session: 'e'.repeat(32) }))
  store.invalidate()
  assert.equal((await store.read()).phone, '13700002222')
})

test('redactSensitive removes token-like fragments from verbatim upstream text', () => {
  const text = redactSensitive(`登录已失效 token: ${SESSION}; phone=${RAW_PHONE}; Authorization: Bearer ${SESSION}`)
  assert.ok(!text.includes(SESSION), 'session is redacted')
  assert.ok(!text.includes(RAW_PHONE), 'phone is redacted')
  assert.match(text, /登录已失效/u, 'non-secret wording is preserved verbatim')
})

test('LOOMY_AUTH_SESSION_FILE replaces the candidate list (no appended desktop defaults)', (t) => {
  const dir = tempDir(t)
  const envPath = join(dir, 'env-auth.json')
  const home = join(dir, 'home')
  // Even when a desktop-shaped credential exists under this home, an explicit
  // env path must be the ONLY candidate inspected.
  const desktopDir = join(home, 'Library', 'Application Support', 'loomy')
  mkdirSync(desktopDir, { recursive: true })
  writeFileSync(join(desktopDir, 'auth-session.json'), authDocument(), { mode: 0o600 })

  const candidates = authSessionCandidates('darwin', { LOOMY_AUTH_SESSION_FILE: envPath }, home)
  assert.deepEqual(candidates, [{ path: envPath, origin: 'env' }])

  // A blank value is not a path; normal desktop discovery still applies.
  const blank = authSessionCandidates('darwin', { LOOMY_AUTH_SESSION_FILE: '   ' }, home)
  assert.ok(blank.length >= 1)
  assert.ok(blank.every((entry) => entry.origin === 'default'))
})

test('an env path that does not exist fails instead of falling back to the desktop session', async (t) => {
  const dir = tempDir(t)
  const home = join(dir, 'home')
  const desktopPath = join(home, 'Library', 'Application Support', 'loomy', 'auth-session.json')
  mkdirSync(dirname(desktopPath), { recursive: true })
  writeFileSync(desktopPath, authDocument(), { mode: 0o600 })
  const missing = join(dir, 'does-not-exist.json')

  const candidates = authSessionCandidates('darwin', { LOOMY_AUTH_SESSION_FILE: missing }, home)
  const snapshot = await readAuth(candidates)

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'missing')
  assert.equal(snapshot.session, undefined)
  assert.deepEqual(snapshot.candidates.map((entry) => entry.path), [missing])
  assert.equal(accountViewOf(snapshot), null)
})

/**
 * 登录后要把真实手机号存下来。
 *
 * 用户报过"小浣熊的账号都显示账号 1/2/3"。根因：登录响应只有 token 和
 * `office_identity`，JWT 里也只有 `sub`——**手机号只在 `user_info` 里**。
 * 不查它，账号表就没有号码。
 */
test('raccoon login stores the phone returned by user_info', async () => {
  const token = `h.${Buffer.from(JSON.stringify({ sub: 'pu-0001', exp: 9_999_999_999 })).toString('base64url')}.s`
  const seen = []
  const fetchImpl = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('login_with_sms')) {
      return new Response(JSON.stringify({ code: 0, data: { access_token: token, office_identity: 'personal' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('user_info')) {
      return new Response(
        JSON.stringify({ code: 0, data: { phone: '18122750898', name: 'RaccoonJoseph', id: 8039981 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const { createRaccoonModule, createVendorDeps } = await import('../../lib/index.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'rc-ui-'))

  // auth-flow 直接用全局 fetch（它不接收依赖注入），所以这里替换全局。
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const module = createRaccoonModule()
    const runtime = await module.create(
      createVendorDeps({
        descriptor: module.descriptor,
        config: () => ({ ...module.descriptor.config.defaults }),
        logger: { info() {}, warn() {}, error() {} },
        storageDir: dir,
      }),
    )

  const result = await runtime.login.login({ phone: '13800001234', code: '123456', method: 'sms-code' })
  assert.equal(result.ok, true)
  assert.ok(seen.some((url) => url.includes('user_info')), '登录后必须查一次 user_info')

  const rows = await runtime.accounts.list({ force: true })
  const stored = rows.find((row) => row.origin === 'plugin')
  // user_info 返回的号码优先于用户输入的那个（它才是账号真实绑定的号码）。
  assert.equal(stored?.phone, '18122750898')
  // **平台昵称不写进 label**：label 是"用户自己起的名字"，被自动昵称占用后账号行
  // 就永远显示 RaccoonJoseph 而不是手机号——用户要的是号码。
  assert.equal(stored?.label, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

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

test('readAuthSession parses the real document shape and masks the account', async (t) => {
  const dir = tempDir(t)
  const path = writeAuthFile(dir)
  const snapshot = await readAuth([candidate(path)])

  assert.equal(snapshot.found, true)
  assert.equal(snapshot.sourcePath, path)
  assert.equal(snapshot.session, SESSION, 'the raw session is available in memory')
  assert.equal(snapshot.maskedPhone, '138****5678')
  assert.equal(snapshot.maskedUserId, '1234**********5678')
  assert.equal(snapshot.loginAt, 1_794_574_693_000)
  assert.equal(snapshot.candidates[0].state, 'ok')
  // A non-reversible fingerprint scopes caches; it must not be the token.
  assert.match(snapshot.fingerprint, /^[0-9a-f]{16}$/u)
  assert.notEqual(snapshot.fingerprint, SESSION)
  assert.equal(sessionFingerprint(SESSION), snapshot.fingerprint)

  const account = accountViewOf(snapshot)
  assert.deepEqual(account, {
    maskedPhone: '138****5678',
    loginAt: 1_794_574_693_000,
    userId: '1234**********5678',
  })
  assert.deepEqual(credentialViewOf(snapshot), { sourcePath: path, found: true })
  assert.deepEqual(nextStepsFor(snapshot), [])

  // The public views must not serialise the raw secret or PII.
  for (const view of [account, credentialViewOf(snapshot), nextStepsFor(snapshot)]) {
    const text = JSON.stringify(view)
    assert.ok(!text.includes(SESSION), 'session must not reach a public view')
    assert.ok(!text.includes(RAW_PHONE), 'full phone must not reach a public view')
    assert.ok(!text.includes(RAW_USER_ID), 'full user id must not reach a public view')
  }
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
  assert.deepEqual(credentialViewOf(snapshot), { sourcePath: path, found: false })
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
  assert.equal(snapshot.maskedPhone, '139****1111')
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

  assert.equal((await store.read()).maskedPhone, '138****5678')

  // A desktop re-login rewrites the file; inside the TTL the old snapshot is
  // served, which keeps one model request from re-reading the file repeatedly.
  writeAuthFile(dir, authDocument({ phone: '13900001111', session: 'f'.repeat(32) }))
  assert.equal((await store.read()).maskedPhone, '138****5678')

  clock = 6_000
  const refreshed = await store.read()
  assert.equal(refreshed.maskedPhone, '139****1111')
  assert.equal(refreshed.session, 'f'.repeat(32))

  writeAuthFile(dir, authDocument({ phone: '13700002222', session: 'e'.repeat(32) }))
  store.invalidate()
  assert.equal((await store.read()).maskedPhone, '137****2222')
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

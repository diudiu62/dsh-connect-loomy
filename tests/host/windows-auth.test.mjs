/**
 * Windows credential discovery.
 *
 * The bug this file pins down: on Windows the plugin used to look at
 * `%APPDATA%\loomy` only (and at nothing at all when `APPDATA` was missing from
 * the host's environment), so a logged-in desktop client was reported as
 * "本机没有找到 Loomy 登录态文件（<plugin store>）" — a path the desktop client
 * never writes. The fix has three parts, each covered below:
 *
 * 1. more fixed candidates, plus a `<home>\AppData\Roaming` fallback;
 * 2. a bounded fallback scan of the app-data roots (`--depth`/budget capped);
 * 3. a diagnostic that names every inspected location instead of one of them.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  authSessionCandidates,
  createAuthDiscovery,
  createAuthStore,
  discoverAuthSessionFiles,
  discoveryRoots,
  notSignedInMessage,
  readAuthSession,
  windowsAppData,
} from '../../lib/index.js'
import { authDocument, SESSION, tempDir } from './helpers.mjs'

const WIN_HOME = 'C:\\Users\\HP'

test('windows candidates cover more than one userData spelling', () => {
  const env = { APPDATA: 'C:\\Users\\HP\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\HP\\AppData\\Local' }
  // `join` is host-platform specific, so the expectations are built the same
  // way the module builds them; only the platform *branch* is simulated here.
  const roaming = env.APPDATA
  const local = env.LOCALAPPDATA
  const expect = (...parts) => join(...parts)
  const paths = authSessionCandidates('win32', env, WIN_HOME).map((entry) => entry.path)

  // The Electron default for a build called `loomy` / `Loomy`.
  assert.ok(paths.includes(expect(roaming, 'loomy', 'auth-session.json')))
  assert.ok(paths.includes(expect(roaming, 'Loomy', 'auth-session.json')))
  // A build that nests under the vendor, or ships under the Chinese name.
  assert.ok(paths.includes(expect(roaming, 'iFlytek', 'Loomy', 'auth-session.json')))
  assert.ok(paths.includes(expect(roaming, '讯飞办公助手', 'auth-session.json')))
  // Per-user install data.
  assert.ok(paths.includes(expect(local, 'loomy', 'auth-session.json')))
  // Order is precedence: the plain name wins over the vendor-nested one.
  assert.ok(paths.indexOf(expect(roaming, 'loomy', 'auth-session.json')) < paths.indexOf(expect(roaming, 'iFlytek', 'Loomy', 'auth-session.json')))
  assert.ok(authSessionCandidates('win32', env, WIN_HOME).every((entry) => entry.origin === 'default'))
})

test('a host without APPDATA still gets candidates from the home directory', () => {
  // A DSH started by a service / stripped launcher can lose these variables;
  // an empty candidate list is indistinguishable from "never logged in".
  assert.equal(windowsAppData({}, WIN_HOME), join(WIN_HOME, 'AppData', 'Roaming'))
  const paths = authSessionCandidates('win32', {}, WIN_HOME).map((entry) => entry.path)
  assert.ok(paths.length >= 4, `expected the home-derived defaults, got ${paths.length}`)
  assert.ok(paths.includes(join(WIN_HOME, 'AppData', 'Roaming', 'loomy', 'auth-session.json')))
  assert.ok(paths.includes(join(WIN_HOME, 'AppData', 'Local', 'loomy', 'auth-session.json')))
  assert.deepEqual(discoveryRoots('win32', {}, WIN_HOME), [
    join(WIN_HOME, 'AppData', 'Roaming'),
    join(WIN_HOME, 'AppData', 'Local'),
  ])
})

test('an explicit LOOMY_AUTH_SESSION_FILE still replaces every Windows path', () => {
  const candidates = authSessionCandidates(
    'win32',
    { APPDATA: 'C:\\Users\\HP\\AppData\\Roaming', LOOMY_AUTH_SESSION_FILE: 'D:\\pinned\\auth-session.json' },
    WIN_HOME,
  )
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].origin, 'env')
})

test('the fallback scan finds a nested auth-session.json and skips noise', async (t) => {
  const root = tempDir(t, 'loomy-scan-')
  const write = (path) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, authDocument())
  }
  write(join(root, 'iFlytek', 'Loomy', 'auth-session.json'))
  write(join(root, 'some-app', 'auth-session.json'))
  // Must be ignored: dependency trees, caches and dot directories.
  write(join(root, 'node_modules', 'pkg', 'auth-session.json'))
  write(join(root, '.hidden', 'auth-session.json'))
  write(join(root, 'loomy', 'Code Cache', 'auth-session.json'))
  // Beyond the depth cap (root=0, so three levels of directories is the max).
  write(join(root, 'a', 'b', 'c', 'd', 'auth-session.json'))

  const found = await discoverAuthSessionFiles({ roots: [root], maxDepth: 3 })

  assert.deepEqual(found, [
    join(root, 'iFlytek', 'Loomy', 'auth-session.json'),
    join(root, 'some-app', 'auth-session.json'),
  ])
})

test('the scan stays bounded by its entry budget', async (t) => {
  const root = tempDir(t, 'loomy-budget-')
  for (let index = 0; index < 40; index += 1) {
    mkdirSync(join(root, `dir-${index}`), { recursive: true })
  }
  writeFileSync(join(root, 'dir-39', 'auth-session.json'), authDocument())

  const found = await discoverAuthSessionFiles({ roots: [root], maxDepth: 1, maxEntries: 5 })
  assert.deepEqual(found, [])
})

test('a discovered file wins when every fixed candidate is missing', async (t) => {
  const dir = tempDir(t, 'loomy-discover-')
  const actual = join(dir, 'Vendor', 'Odd Product', 'auth-session.json')
  mkdirSync(join(dir, 'Vendor', 'Odd Product'), { recursive: true })
  writeFileSync(actual, authDocument())

  const candidates = authSessionCandidates('win32', { APPDATA: join(dir, 'Roaming') }, dir)
  const snapshot = await readAuthSession(candidates, { discover: async () => [actual] })

  assert.equal(snapshot.found, true)
  assert.equal(snapshot.sourcePath, actual)
  assert.equal(snapshot.sourceOrigin, 'default')
  assert.equal(snapshot.session, SESSION, 'the in-memory snapshot carries the session (never a file copy)')
  // The inspected list keeps the fixed candidates first, then the hit.
  assert.ok(snapshot.candidates.some((entry) => entry.path === actual && entry.state === 'ok'))
})

test('discovery is not consulted while a candidate already parses', async (t) => {
  const dir = tempDir(t, 'loomy-fastpath-')
  const present = join(dir, 'loomy', 'auth-session.json')
  mkdirSync(join(dir, 'loomy'), { recursive: true })
  writeFileSync(present, authDocument())
  let scans = 0

  const store = createAuthStore({
    candidates: [{ path: present, origin: 'default' }],
    discover: Object.assign(async () => {
      scans += 1
      return []
    }, { invalidate: () => undefined }),
  })
  const snapshot = await store.read()

  assert.equal(snapshot.found, true)
  assert.equal(scans, 0)
})

test('createAuthDiscovery caches its answer and invalidate() rescans', async (t) => {
  const root = tempDir(t, 'loomy-cache-')
  const file = join(root, 'loomy', 'auth-session.json')
  mkdirSync(join(root, 'loomy'), { recursive: true })
  writeFileSync(file, authDocument())
  let clock = 1_000
  const discover = createAuthDiscovery({ roots: [root], now: () => clock })

  assert.deepEqual(await discover(), [file])
  writeFileSync(join(root, 'loomy', 'second-auth-session.json'), authDocument())
  // Same tick + same cache => the earlier answer is reused.
  assert.deepEqual(await discover(), [file])
  discover.invalidate()
  assert.equal((await discover()).length, 1, 'only auth-session.json is ever reported')
  clock += 60_000
  assert.equal((await discover()).length, 1)
})

test('the signed-out diagnostic names every inspected path, not just one', async (t) => {
  const dir = tempDir(t, 'loomy-win-')
  const pluginPath = join(dir, 'storages', 'dsh-connect-loomy', 'auth-session.json')
  const candidates = [
    { path: pluginPath, origin: 'plugin' },
    ...authSessionCandidates('win32', { APPDATA: join(dir, 'Roaming') }, dir),
  ]

  const snapshot = await readAuthSession(candidates)

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'missing')
  // The card renders `未找到：<sourcePath>`, so this must be the file the user
  // is expected to create — the desktop client's, not the plugin store's.
  assert.ok(snapshot.sourcePath.includes('Roaming'), snapshot.sourcePath)
  assert.notEqual(snapshot.sourcePath, pluginPath)
  const problem = snapshot.problem ?? ''
  for (const entry of candidates) {
    assert.ok(problem.includes(entry.path), `problem should mention ${entry.path}`)
  }
  assert.match(problem, /LOOMY_AUTH_SESSION_FILE/u)
  assert.match(problem, /重新检测/u)
})

test('notSignedInMessage never repeats the path it already contains', () => {
  const path = '/tmp/missing.json'
  assert.equal(notSignedInMessage(path), `未找到可用的 Loomy 登录态（${path}）`)
  assert.equal(notSignedInMessage(path, `文件不存在（${path}）`), `未找到可用的 Loomy 登录态：文件不存在（${path}）`)
  assert.equal(notSignedInMessage(path, '请启动客户端'), `未找到可用的 Loomy 登录态（${path}）：请启动客户端`)
  assert.equal(notSignedInMessage(path, '   '), `未找到可用的 Loomy 登录态（${path}）`)
})

test('a scan hit that belongs to another product does not rename the failure', async (t) => {
  // `Vibe助手/auth-session.json` is a real encrypted file with the same name.
  // Finding it must not turn "you are not signed in" into "that file is not
  // Loomy plaintext", which would send the user chasing the wrong thing.
  const dir = tempDir(t, 'loomy-other-product-')
  const other = join(dir, 'Vibe助手', 'auth-session.json')
  mkdirSync(dirname(other), { recursive: true })
  writeFileSync(other, JSON.stringify({ encrypted: true, data: 'v1:AAAA' }))

  const candidates = authSessionCandidates('win32', { APPDATA: join(dir, 'Roaming') }, dir)
  const snapshot = await readAuthSession(candidates, { discover: async () => [other] })

  assert.equal(snapshot.found, false)
  assert.equal(snapshot.reason, 'missing')
  assert.ok(snapshot.candidates.some((entry) => entry.path === other && entry.state === 'encrypted'))
  assert.match(snapshot.problem ?? '', /已查找/u)
})

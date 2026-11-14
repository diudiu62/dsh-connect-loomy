#!/usr/bin/env node
/**
 * F2 regression check on the current bytes: `LOOMY_AUTH_SESSION_FILE` is an
 * **exclusive** replacement, never a priority hint.
 *
 * The guarantee that matters: tests, CI and the CLI set the env var precisely
 * so that no real desktop credential can be handed to a temporary
 * `LOOMY_BASE_URL`. A fallback to the desktop default paths would silently
 * defeat that. Verified on the current bytes:
 *
 * 1. env set (even to a missing path) → the desktop default candidates are
 *    never inspected, `found:false`, no session — even though a realistic
 *    desktop sign-in file exists under `$HOME`;
 * 2. env blank/whitespace → falls back to the platform defaults (env is not
 *    "sticky empty");
 * 3. the real plugin entry (`apply` via the mount fixture) honours the same
 *    exclusivity end-to-end: with env pointing at a missing file and a real
 *    desktop file present, `GET /status` reports signed-out and the CLI
 *    documents the exclusive semantics.
 *
 * Run: `node scripts/verify/verify-auth-env-exclusive.mjs`
 *
 * @module dsh-connect-loomy/verify/auth-env-exclusive
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CheckLog, ensure, ensureEqual } from './checks.mjs'
import { FAKE_PHONE, FAKE_SESSION, startMockUpstream } from './mock-upstream.mjs'
import { mountPlugin } from './mount-fixture.mjs'

const checks = new CheckLog('auth-env-exclusive (F2)')
const mock = await startMockUpstream()

/** A realistic desktop sign-in file placed under the (sandboxed) HOME. */
const desktopDir = join(homedir(), 'Library', 'Application Support', 'loomy')

const previousEnv = {
  LOOMY_AUTH_SESSION_FILE: process.env['LOOMY_AUTH_SESSION_FILE'],
  HOME: process.env['HOME'],
}

try {
  // Sandbox the HOME so "desktop default" points at a directory we control.
  const sandboxHome = join(mock.baseURL.includes('://') ? '/tmp' : '/tmp', `loomy-f2-home-${Date.now()}`)
  await mkdir(join(sandboxHome, 'Library', 'Application Support', 'loomy'), { recursive: true })
  const desktopFile = join(sandboxHome, 'Library', 'Application Support', 'loomy', 'auth-session.json')
  await writeFile(
    desktopFile,
    JSON.stringify({ session: FAKE_SESSION, userid: '123456789012345678', phone: FAKE_PHONE, updatedAt: 1_794_574_693_000 }),
    { mode: 0o600 },
  )
  process.env['HOME'] = sandboxHome

  const module = await import('../../lib/index.js')

  await checks.run('env set to a missing path: desktop defaults are never inspected', async () => {
    const missing = join(sandboxHome, 'missing-auth.json')
    process.env['LOOMY_AUTH_SESSION_FILE'] = missing
    const snapshot = await module.readAuthSession()
    ensureEqual(snapshot.found, false, 'must not find a session')
    ensureEqual(snapshot.candidates.length, 1, 'only the env candidate may be inspected')
    ensureEqual(snapshot.candidates[0].path, missing, 'the single candidate must be the env path')
    ensure(snapshot.session === undefined, 'no session may leak from the desktop file')
  })

  await checks.run('env blank or whitespace: platform defaults are used again', async () => {
    for (const value of ['', '   ']) {
      process.env['LOOMY_AUTH_SESSION_FILE'] = value
      const snapshot = await module.readAuthSession()
      ensureEqual(snapshot.found, true, `blank env (${JSON.stringify(value)}) must fall back to desktop defaults`)
      ensureEqual(snapshot.candidates.filter((candidate) => candidate.origin === 'env').length, 0, 'no env candidate')
    }
  })

  await checks.run('env unset: platform defaults are used (control)', async () => {
    delete process.env['LOOMY_AUTH_SESSION_FILE']
    const snapshot = await module.readAuthSession()
    ensureEqual(snapshot.found, true, 'desktop default must be found when no env is set')
    ensureEqual(snapshot.session, FAKE_SESSION, 'the desktop fixture is the session source')
  })

  // End-to-end through the real plugin entry: env wins exclusively.
  await checks.run('plugin mount honours the exclusive env even with a real desktop file present', async () => {
    const fixture = await mountPlugin({
      baseURL: mock.baseURL,
      configOverrides: { catalogTtlMs: 0 },
      skipAuthFile: true,
      withDesktopAuthFile: true,
    })
    try {
      const response = await fixture.request('/plugins/dsh-connect-loomy/status')
      const body = JSON.parse(response.text)
      ensureEqual(body.credential.found, false, 'the mount must report signed out')
      ensureEqual(body.account, null, 'no account may be derived from the desktop file')
      ensure(!response.text.includes(FAKE_SESSION), 'the desktop session leaked into the status payload')
    } finally {
      await fixture.close()
    }
  })

  await checks.run('CLI documents the exclusive semantics', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'lib', 'bin.js'), '--help'], {
      encoding: 'utf8',
    })
    ensure(
      /LOOMY_AUTH_SESSION_FILE\s+use exactly this sign-in file \(no desktop fallback\)/u.test(stdout),
      `--help does not document exclusivity: ${JSON.stringify(stdout.split('\n').filter((line) => line.includes('LOOMY_AUTH')))}`,
    )
  })

  await rm(sandboxHome, { recursive: true, force: true })
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await mock.close()
}

process.exitCode = checks.finish()

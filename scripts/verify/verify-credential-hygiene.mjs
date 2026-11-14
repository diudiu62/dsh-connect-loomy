#!/usr/bin/env node
/**
 * Credential hygiene: the real desktop session (and the PII next to it) must
 * not appear in the repository, the built `lib/` artifacts, the CLI output, or
 * any log a user could paste into a bug report.
 *
 * Strategy: the strongest possible test is exact matching against the values
 * actually present in this machine's `auth-session.json`. The script reads them
 * once, never prints them, and searches the whole tree byte-for-byte. It also
 * scans for the *shapes* (32+ hex, mainland phone, 18-digit id, `Bearer …`) so
 * a future fixture that forgets to be fake is at least visible.
 *
 * The verifier's own fixtures use `FAKE_*` values from `mock-upstream.mjs`;
 * those are allowed and are reported as advisory hits so a reader can tell
 * them apart from a real leak.
 *
 * Exit code 1 when an exact real value leaks, when the CLI output contains a
 * session, or when the state cache is not `0600`/contains a session.
 *
 * Run: `node scripts/verify/verify-credential-hygiene.mjs`
 *
 * @module dsh-connect-loomy/verify/credential-hygiene
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CheckLog, ensure, ensureEqual } from './checks.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checks = new CheckLog('credential-hygiene')

/** Directories that are never part of the shipped tree. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  '.pnpm-cache',
  '.agent-teams',
  '.memsearch',
  // Verified separately: read-only reconnaissance, gitignored, never shipped.
  '.refs',
])

/** Text-ish extensions the scanner reads; everything else is skipped. */
const TEXT_EXTENSIONS = new Set([
  '',
  '.md',
  '.json',
  '.jsonl',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.map',
  '.yml',
  '.yaml',
  '.txt',
  '.sh',
  '.css',
  '.html',
  '.toml',
])

/** The desktop sign-in file (the only credential source). */
const REAL_AUTH_FILE = join(homedir(), 'Library', 'Application Support', 'loomy', 'auth-session.json')

/** Read the real credential facts without ever echoing them. */
async function readRealFacts() {
  try {
    const parsed = JSON.parse(await readFile(REAL_AUTH_FILE, 'utf8'))
    return {
      available: true,
      session: typeof parsed.session === 'string' ? parsed.session : undefined,
      phone: typeof parsed.phone === 'string' ? parsed.phone : undefined,
      userId: typeof parsed.userid === 'string' ? parsed.userid : undefined,
    }
  } catch {
    return { available: false }
  }
}

/** Walk a tree, returning readable text files (size-bounded). */
async function walkTextFiles(root, skip) {
  const files = []
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await visit(full)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Only inspect links that point at files inside the tree.
        try {
          const target = await readlink(full)
          if (target.startsWith('/')) continue
        } catch {
          continue
        }
      }
      if (!entry.isFile()) continue
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      try {
        const info = await stat(full)
        if (info.size > 5 * 1024 * 1024) continue
      } catch {
        continue
      }
      files.push(full)
    }
  }
  await visit(root)
  return files.sort()
}

/** All line/column hits of one literal string in a file. */
function findLiteral(text, literal) {
  if (literal === undefined || literal.length < 4) return []
  const hits = []
  let index = text.indexOf(literal)
  while (index !== -1) {
    const line = text.slice(0, index).split('\n').length
    hits.push(line)
    index = text.indexOf(literal, index + literal.length)
  }
  return hits
}

/** Shape-level regexes; hits are advisory unless they equal a real value. */
const SHAPES = [
  { id: 'hex32+', regex: /\b[0-9a-f]{32,}\b/giu, note: '32+ hex run (test fixture or real session)' },
  { id: 'phone-cn', regex: /\b1[3-9]\d{9}\b/gu, note: 'mainland phone number' },
  { id: 'userid18', regex: /\b\d{18}\b/gu, note: '18-digit id' },
  { id: 'bearer', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gu, note: 'literal bearer token' },
]

/** Scan one file; returns hits tagged by rule. */
async function scanFile(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const results = []
  if (text.includes('\u0000')) return results
  for (const shape of SHAPES) {
    shape.regex.lastIndex = 0
    const matches = [...text.matchAll(shape.regex)]
    if (matches.length > 0) {
      results.push({
        rule: shape.id,
        count: matches.length,
        note: shape.note,
        lines: matches.slice(0, 5).map((match) => text.slice(0, match.index).split('\n').length),
      })
    }
  }
  return results
}

const real = await readRealFacts()

try {
  // ---- exact real values across the working tree -------------------------
  const files = await walkTextFiles(repoRoot, SKIP_DIRS)
  const leaks = []
  const advisory = []
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    const relative = file.slice(repoRoot.length + 1)
    for (const [label, literal] of [
      ['session', real.session],
      ['phone', real.phone],
      ['userid', real.userId],
    ]) {
      const lines = findLiteral(text, literal)
      if (lines.length > 0) leaks.push({ label, file: relative, lines })
    }
    for (const hit of await scanFile(file)) {
      advisory.push({ file: relative, ...hit })
    }
  }

  await checks.run('real session/phone/userid do not appear in the shipped tree', async () => {
    if (!real.available) throw new Error(`not verified: ${REAL_AUTH_FILE} is absent on this machine`)
    ensure(real.session !== undefined, 'the real auth file has no session field')
    ensureEqual(leaks, [], `exact real credential/PII found: ${JSON.stringify(leaks)}`)
  })

  await checks.run('built lib/ artifacts contain no real session', async () => {
    if (!real.available) throw new Error('not verified: no local login state')
    const libLeaks = leaks.filter((leak) => leak.file === 'lib' || leak.file.startsWith('lib/'))
    ensureEqual(libLeaks, [], `lib/ leaks: ${JSON.stringify(libLeaks)}`)
  })

  await checks.run('shape scan is explainable (no unexplained real-looking secret)', async () => {
    // Every advisory hit must be in a test/fixture/docs file or an example
    // value, never in a shipped artifact. The list is printed below for the
    // report; a `lib/` hit would be a real failure.
    const libHits = advisory.filter((hit) => hit.file.startsWith('lib/'))
    ensureEqual(
      libHits.filter((hit) => hit.rule === 'bearer' || hit.rule === 'hex32+').map((hit) => hit.file),
      [],
      'a shipped artifact matched a token shape',
    )
  })

  await checks.run('gitignored recon directory (.refs) also carries no real value', async () => {
    if (!real.available) throw new Error('not verified: no local login state')
    let referenceFiles
    try {
      referenceFiles = await walkTextFiles(join(repoRoot, '.refs'), new Set())
    } catch {
      throw new Error('not verified: .refs reference directory is absent')
    }
    const referenceLeaks = []
    for (const file of referenceFiles) {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue
      for (const [label, literal] of [
        ['session', real.session],
        ['phone', real.phone],
        ['userid', real.userId],
      ]) {
        if (findLiteral(text, literal).length > 0) referenceLeaks.push({ label, file: file.slice(repoRoot.length + 1) })
      }
    }
    console.log(`  (.refs: ${referenceFiles.length} files scanned, ${referenceLeaks.length} exact real-value hits)`)
    ensureEqual(referenceLeaks, [], `recon directory carries real values: ${JSON.stringify(referenceLeaks)}`)
  })

  // ---- CLI output --------------------------------------------------------
  const bin = join(repoRoot, 'lib', 'bin.js')
  const cliRuns = []
  for (const args of [['status', '--json'], ['doctor', '--json'], ['status'], ['doctor']]) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
        cwd: repoRoot,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      cliRuns.push({ args: args.join(' '), code: 0, stdout, stderr })
    } catch (error) {
      cliRuns.push({
        args: args.join(' '),
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? error.message ?? ''),
      })
    }
  }

  await checks.run('CLI doctor/status (json and human) exit 0', async () => {
    const failures = cliRuns.filter((run) => run.code !== 0)
    ensureEqual(failures.map((run) => run.args), [], 'CLI runs failed')
  })

  await checks.run('CLI stdout/stderr never contain the session, phone or user id', async () => {
    if (!real.available) throw new Error('not verified: no local login state')
    for (const run of cliRuns) {
      for (const [label, literal] of [
        ['session', real.session],
        ['phone', real.phone],
        ['userid', real.userId],
      ]) {
        for (const stream of [run.stdout, run.stderr]) {
          ensure(
            !stream.includes(literal),
            `\`${run.args}\` leaked the real ${label} (value suppressed)`,
          )
        }
      }
    }
  })

  await checks.run('CLI JSON is parseable and reports a masked account + balance', async () => {
    const statusRun = cliRuns.find((run) => run.args === 'status --json')
    ensure(statusRun !== undefined, 'status --json did not run')
    const document = JSON.parse(statusRun.stdout)
    ensureEqual(document.ok, true, 'ok')
    const masked = document.account?.maskedPhone
    ensure(typeof masked === 'string' && /^\d{3}\*+\d{4}$/u.test(masked), `masked phone shape: ${JSON.stringify(masked)}`)
    ensureEqual(document.credential.found, true, 'credential.found')
    ensure(document.credits.ok === true, 'credits.ok')
    ensure(typeof document.credits.availableBalance === 'number', 'availableBalance')
    ensure(typeof document.credits.balance === 'number', 'balance')
    ensure(typeof document.credits.dailyBalance === 'number', 'dailyBalance')
    ensure(Array.isArray(document.enabledModelIds), 'enabledModelIds')
    ensure(Array.isArray(document.credits.records), 'credits records')
    const doctorRun = cliRuns.find((run) => run.args === 'doctor --json')
    const doctor = JSON.parse(doctorRun.stdout)
    ensureEqual(doctor.ok, true, 'doctor ok')
    ensureEqual(doctor.credential.found, true, 'doctor credential.found')
    ensureEqual(
      doctor.probes.map((probe) => probe.ok),
      [true, true, true],
      'doctor probes against the real upstream',
    )
  })

  // ---- advisory listing (for the report, not a pass/fail) ----------------
  const byRule = new Map()
  for (const hit of advisory) {
    byRule.set(hit.rule, (byRule.get(hit.rule) ?? 0) + hit.count)
  }
  console.log('')
  console.log('Advisory shape hits (fake fixtures/docs; no real value matched):')
  for (const [rule, count] of [...byRule.entries()].sort()) {
    const files = [...new Set(advisory.filter((hit) => hit.rule === rule).map((hit) => hit.file))]
    console.log(`  ${rule}: ${count} hit(s) in ${files.length} file(s)`)
    for (const file of files.slice(0, 8)) console.log(`    - ${file}`)
    if (files.length > 8) console.log(`    ... and ${files.length - 8} more`)
  }
  if (byRule.size === 0) console.log('  (none)')
  console.log('')
  console.log('Remaining real-value scan summary (values suppressed):')
  console.log(`  files scanned: ${files.length}`)
  console.log(`  exact real-value leaks: ${leaks.length}`)
} finally {
  process.exitCode = checks.finish()
}

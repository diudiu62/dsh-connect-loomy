#!/usr/bin/env node
/**
 * Run every independent verification script and return a single exit code.
 *
 * Prerequisites: `pnpm install && pnpm build` (the scripts drive the shipped
 * `lib/` artifacts, not `src/`). Each script is also runnable on its own.
 *
 * Run: `node scripts/verify/run-all.mjs`
 *
 * @module dsh-connect-loomy/verify/run-all
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  console.error('lib/index.js is missing — run `pnpm build` first.')
  process.exit(1)
}

const scripts = [
  'verify-entry-artifacts.mjs',
  'verify-auth-override.mjs',
  'verify-e2e-fake-upstream.mjs',
  'verify-contract-v2.mjs',
  'verify-credential-hygiene.mjs',
]

const results = []
for (const script of scripts) {
  console.log(`\n=== ${script} ===`)
  const result = spawnSync(process.execPath, [join(here, script)], { cwd: repoRoot, stdio: 'inherit' })
  results.push({ script, code: result.status ?? 1 })
}

console.log('\n== run-all summary ==')
for (const result of results) console.log(`  ${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.script} (exit ${result.code})`)
const failed = results.filter((result) => result.code !== 0)
console.log(`  ${results.length - failed.length}/${results.length} scripts passed`)
process.exitCode = failed.length === 0 ? 0 : 1

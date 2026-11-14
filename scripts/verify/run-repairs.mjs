#!/usr/bin/env node
/**
 * Run the three repair-round probes (t6 F1/F2/F3) on the current bytes and
 * aggregate their exit codes.
 *
 * These are kept out of `run-all.mjs` on purpose: `run-all` is the t5 core
 * suite (5 scripts), while these three exist to re-prove the specific repairs
 * on whatever bytes are current. Both runners are independent and offline.
 *
 * Run: `node scripts/verify/run-repairs.mjs`
 *
 * @module dsh-connect-loomy/verify/run-repairs
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
  'verify-cold-start.mjs',
  'verify-auth-env-exclusive.mjs',
  'verify-transport-precheck.mjs',
]

const results = []
for (const script of scripts) {
  console.log(`\n=== ${script} ===`)
  const result = spawnSync(process.execPath, [join(here, script)], { cwd: repoRoot, stdio: 'inherit' })
  results.push({ script, code: result.status ?? 1 })
}

console.log('\n== run-repairs summary ==')
for (const result of results) console.log(`  ${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.script} (exit ${result.code})`)
const failed = results.filter((result) => result.code !== 0)
console.log(`  ${results.length - failed.length}/${results.length} scripts passed`)
process.exitCode = failed.length === 0 ? 0 : 1

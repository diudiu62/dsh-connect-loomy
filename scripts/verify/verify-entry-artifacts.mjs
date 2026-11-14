#!/usr/bin/env node
/**
 * Entry-artifact verification: every path `package.json` promises must exist
 * and behave, because the DSH loader resolves exactly those strings.
 *
 * Covers:
 * - `main`, `types`, every `exports` target, `bin`, and every entry of `files`;
 * - the host entry's public surface (`name`/`inject`/`apply`/`Config`) and the
 *   declared `.d.ts` file;
 * - the client entry is the `window.__ModuleLoader__.load({ id, factory })`
 *   wrapper the web client requires, requires only platform seeds, and carries
 *   no Node builtin or relative import;
 * - the CLI entry starts with a shebang, is executable, and runs `--help`;
 * - `cordis.patch.yml` inserts the same package id the manifest declares;
 * - `locale/*.json` parse.
 *
 * Run: `node scripts/verify/verify-entry-artifacts.mjs`
 *
 * @module dsh-connect-loomy/verify/entry-artifacts
 */

import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CheckLog, ensure, ensureEqual, ensureMatch } from './checks.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const checks = new CheckLog('entry-artifacts')

/** Resolve one manifest path relative to the repo root. */
function at(relativePath) {
  return join(repoRoot, relativePath.replace(/^\.\//u, ''))
}

/** Assert one file exists, is a regular file, and is non-empty. */
async function requireFile(relativePath, label) {
  const target = at(relativePath)
  ensure(isAbsolute(target), `${label}: ${relativePath} must resolve to an absolute path`)
  const info = await stat(target)
  ensure(info.isFile(), `${label}: ${relativePath} is not a regular file`)
  ensure(info.size > 0, `${label}: ${relativePath} is empty`)
  return { target, info }
}

try {
  await checks.run('package identity and DSH manifest fields are consistent', async () => {
    ensureEqual(manifest.name, 'dsh-connect-loomy', 'package name')
    ensureEqual(manifest.type, 'module', 'module type')
    ensureEqual(manifest.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch')
    ensureEqual(manifest.dsh.client.platform, 'web', 'dsh.client.platform')
    ensureEqual(manifest.dsh.client.inject.length > 0, true, 'dsh.client.inject')
    for (const dependency of manifest.dsh.client.inject) {
      ensure(
        typeof manifest.peerDependencies?.[dependency] === 'string',
        `client inject dependency not declared as a peer: ${dependency}`,
      )
    }
  })

  await checks.run('main/types/exports/bin targets all exist and are non-empty', async () => {
    const files = new Set()
    files.add(await requireFile(manifest.main, 'main'))
    files.add(await requireFile(manifest.types, 'types'))
    files.add(await requireFile(manifest.bin['dsh-connect-loomy'], 'bin'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (typeof value === 'string') {
        // `./locale/*.json` is a pattern, not a literal path.
        if (value.includes('*')) continue
        files.add(await requireFile(value, `exports["${key}"]`))
      } else if (typeof value === 'object' && value !== null) {
        for (const [condition, target] of Object.entries(value)) {
          if (typeof target !== 'string') continue
          files.add(await requireFile(target, `exports["${key}"].${condition}`))
        }
      }
    }
    ensure(files.size >= 5, `expected main/types/bin/exports targets, found ${files.size}`)
  })

  await checks.run('every path listed in `files` exists', async () => {
    ensure(Array.isArray(manifest.files) && manifest.files.length > 0, 'files must be declared')
    for (const entry of manifest.files) {
      const target = at(entry)
      const info = await stat(target)
      ensure(info.isFile() || info.isDirectory(), `files entry missing: ${entry}`)
    }
  })

  await checks.run('host entry exports the loader contract', async () => {
    const host = await import(join(repoRoot, manifest.main))
    ensureEqual(host.name, 'connect-loomy', 'plugin name')
    ensureEqual(host.inject.includes('llm'), true, 'inject must include llm')
    ensureEqual(typeof host.apply, 'function', 'apply')
    ensureEqual(typeof host.Config, 'function', 'Config')
    ensureEqual(typeof host.createProviderRuntime, 'function', 'createProviderRuntime export')
    ensureEqual(typeof host.registerLoomyRoutes, 'function', 'registerLoomyRoutes export')
    const declarations = await readFile(join(repoRoot, manifest.types), 'utf8')
    ensureMatch(declarations, /declare function apply\(/u, 'declaration for apply')
    ensureMatch(declarations, /declare const name = "connect-loomy"/u, 'declaration for name')
  })

  await checks.run('client entry is a __ModuleLoader__ factory bundle', async () => {
    const client = await readFile(join(repoRoot, manifest.exports['./client']), 'utf8')
    const code = client.replace(/\n\/\/# sourceMappingURL=.*$/u, '').trimEnd()
    ensureMatch(code.slice(0, 80), /^window\.__ModuleLoader__\.load\(\{\s*\n\s*id: "dsh-connect-loomy",/u, 'loader header')
    ensureMatch(code, /factory: \(require\) =>/u, 'factory signature')
    ensureMatch(code, /return module\.exports;\s*\}\s*\}\);\s*$/u, 'loader footer closes the factory')
    // Browser bundles must not pull Node builtins or relative modules: the
    // loader supplies the platform seeds and nothing else is importable.
    ensure(!/from ["']node:/u.test(client), 'client bundle imports a node: builtin')
    const requires = [...client.matchAll(/require\((["'])([^"']+)\1\)/gu)].map((match) => match[2])
    for (const id of requires) {
      ensure(
        id === 'react' || id === 'react/jsx-runtime' || id.startsWith('@deepseek-ai/') || id.startsWith('@earendil-works/'),
        `client bundle requires an unexpected module: ${id}`,
      )
    }
    ensure(requires.length > 0, 'client bundle requires nothing (expected the react seed)')
  })

  await checks.run('CLI entry has a shebang, the exec bit, and runs --help', async () => {
    const { info, target } = await requireFile(manifest.bin['dsh-connect-loomy'], 'bin')
    ensure((info.mode & 0o111) !== 0, 'bin file is not executable')
    const text = await readFile(target, 'utf8')
    ensureMatch(text, /^#!\/usr\/bin\/env node\n/u, 'shebang')
    const output = execFileSync(process.execPath, [target, '--help'], { encoding: 'utf8' })
    ensureMatch(output, /Usage: dsh-connect-loomy <status\|doctor>/u, '--help output')
  })

  await checks.run('cordis.patch.yml inserts the same package id', async () => {
    const patch = await readFile(at(manifest.dsh.bundle.patch), 'utf8')
    ensureMatch(patch, /- insert:/u, 'insert layer')
    ensureMatch(patch, /id: dsh-connect-loomy/u, 'bundle entry id')
    ensureMatch(patch, /name: dsh-connect-loomy/u, 'bundle package name')
  })

  await checks.run('locale catalogs parse and describe the package', async () => {
    for (const locale of ['en', 'zh']) {
      const text = await readFile(at(`locale/${locale}.json`), 'utf8')
      const parsed = JSON.parse(text)
      ensure(typeof parsed === 'object' && parsed !== null, `${locale}.json must be an object`)
      ensureEqual(parsed.meta?.title, 'dsh-connect-loomy', `${locale}.json meta.title`)
      ensure(typeof parsed.meta?.description === 'string' && parsed.meta.description.length > 0, `${locale}.json description`)
    }
  })
} finally {
  process.exitCode = checks.finish()
}

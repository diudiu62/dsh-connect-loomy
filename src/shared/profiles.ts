/**
 * Read-only view of the DSH profiles on this machine.
 *
 * Why this exists: the plugin was renamed from `dsh-connect-loomy` to
 * `dsh-connect-desktop`. A profile that still lists the old bundle entry will
 * mount **both** packages, and both register the same provider routes — the
 * host then fails with `an adapter for provider "loomy" is already registered`
 * (`dsh-llm/lib/index.js:1872`), which reads like a broken harness rather than
 * a half-finished migration. This module is the cheap, purely local check that
 * lets the new package step aside and say something human instead.
 *
 * Everything here is tolerant by design: a missing directory, an unreadable
 * file or a malformed document degrades to "unknown", never to a thrown error.
 * Mounting must not depend on the shape of `$DSH_HOME`.
 *
 * @module dsh-connect-desktop/shared/profiles
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One profile's bundle list, as far as this plugin cares. */
export interface ProfileBundles {
  /** Profile directory name (`web`, `desktop`, …). */
  profile: string
  /** `package.json` path, for diagnostics. */
  packagePath: string
  /** `dependencies` + `devDependencies` + `dsh.profile.bundles`, de-duplicated. */
  entries: readonly string[]
}

/** What the probe found. */
export interface ProfilesSnapshot {
  /** Resolved `$DSH_HOME` (or `~/.dsh`). */
  dshHome: string
  /** Every profile that could be read, sorted by name. */
  profiles: readonly ProfileBundles[]
  /** `true` when the profiles directory itself could not be read. */
  unreadable: boolean
}

/** Resolve the harness home the same way the rest of the plugin does. */
export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env['DSH_HOME']
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(home, '.dsh')
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/**
 * Extract the bundle/package names one profile declares.
 *
 * Both halves matter: `dependencies` is what pnpm installs, while
 * `dsh.profile.bundles` is what the loader mounts. A half-migrated profile can
 * have the new dependency installed but the old bundle still listed, so the
 * caller must treat "listed in either" as "still active".
 */
export function bundlesOf(document: unknown): string[] {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return []
  const record = document as Record<string, unknown>
  const names = new Set<string>()
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const deps = record[key]
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name)
  }
  const dsh = record['dsh']
  if (dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)) {
    const profile = (dsh as Record<string, unknown>)['profile']
    if (profile !== null && typeof profile === 'object' && !Array.isArray(profile)) {
      for (const name of stringArray((profile as Record<string, unknown>)['bundles'])) names.add(name)
    }
  }
  return [...names].sort()
}

/** Read every profile on this machine. Never throws. */
export function readProfiles(dshHome: string = resolveDshHome()): ProfilesSnapshot {
  const root = join(dshHome, 'profiles')
  if (!existsSync(root)) return { dshHome, profiles: [], unreadable: true }
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return { dshHome, profiles: [], unreadable: true }
  }
  const profiles: ProfileBundles[] = []
  for (const profile of names) {
    if (profile.startsWith('.')) continue
    const dir = join(root, profile)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const packagePath = join(dir, 'package.json')
    if (!existsSync(packagePath)) continue
    try {
      const document: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
      profiles.push({ profile, packagePath, entries: bundlesOf(document) })
    } catch {
      // A corrupt profile must not break mounting; it simply cannot be judged.
      profiles.push({ profile, packagePath, entries: [] })
    }
  }
  return { dshHome, profiles, unreadable: false }
}

/** Which package names count as "the old plugin" for a given vendor id. */
export interface CoexistenceRule {
  /** The package this code ships as. */
  selfName: string
  /** Package names that must be removed before this one may register routes. */
  legacyNames: readonly string[]
}

/** What coexistence detection concluded. */
export type Coexistence =
  | { kind: 'clear' }
  | { kind: 'blocked'; profile: string; legacyName: string; packagePath: string }
  | { kind: 'unknown'; reason: string }

/**
 * Decide whether this package may register provider routes.
 *
 * "Blocked" means an old bundle entry is still mounted **in some profile**
 * while this one is too. The new package deliberately yields: the old one is
 * already serving those routes, so yielding costs the user nothing and avoids
 * a host-level duplicate-adapter crash.
 */
export function detectCoexistence(
  rule: CoexistenceRule,
  snapshot: ProfilesSnapshot = readProfiles(),
): Coexistence {
  if (snapshot.unreadable && snapshot.profiles.length === 0) {
    return { kind: 'unknown', reason: `无法读取 ${join(snapshot.dshHome, 'profiles')}` }
  }
  for (const profile of snapshot.profiles) {
    const mountedSelf = profile.entries.includes(rule.selfName)
    if (!mountedSelf) continue
    for (const legacyName of rule.legacyNames) {
      if (profile.entries.includes(legacyName)) {
        return { kind: 'blocked', profile: profile.profile, legacyName, packagePath: profile.packagePath }
      }
    }
  }
  return { kind: 'clear' }
}

/** The two commands that finish the migration, ready to paste. */
export function migrationCommands(profile: string, legacyName: string, selfName: string): string[] {
  return [
    `dsh plugin --profile ${profile} remove ${legacyName}`,
    `dsh plugin --profile ${profile} add github:diudiu62/${selfName}`,
  ]
}

/**
 * Bounded fallback search for a Loomy `auth-session.json`.
 *
 * Why this exists: the credential path is only *verified* on macOS
 * (`docs/loomy-upstream.md` §1.1). On Windows the desktop client's Electron
 * `userData` directory depends on the product name the shipped build used, so a
 * fixed candidate list inevitably misses some installs and the user is told
 * "you never logged in" while their client is logged in.
 *
 * The search is deliberately cheap and safe:
 *
 * - only the roots from `discoveryRoots()` are entered (never the whole disk);
 * - directory depth, visited-entry count and wall time are all capped;
 * - symlinks are never followed, so a junction loop cannot hang the host;
 * - only files literally named `auth-session.json` are reported, and the caller
 *   still has to parse them into a real session before they count.
 *
 * It runs **only while signed out** — a working candidate list short-circuits
 * before this module is touched — and its answer is cached for
 * {@link DEFAULT_DISCOVERY_TTL_MS} so a refresh loop cannot spin the disk.
 *
 * @module dsh-connect-loomy/shared/discover
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './paths.js'

/** File name the desktop client writes. */
export const AUTH_FILE_NAME = 'auth-session.json'

/** How long a scan answer (including an empty one) is reused. */
export const DEFAULT_DISCOVERY_TTL_MS = 30_000

/** Directory names that never hold an Electron `userData` credential. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'cache',
  'cacheddata',
  'code cache',
  'gpucache',
  'dawncache',
  'dawnwebgpucache',
  'shadercache',
  'dictionaries',
  'blob_storage',
  'local storage',
  'session storage',
  'service worker',
  'crashpad',
  'logs',
  'temp',
  'tmp',
])

/** One directory discovered on the way, with its depth below a root. */
interface PendingDirectory {
  path: string
  depth: number
  /** Directory name, used to rank "this looks like Loomy" above the rest. */
  name: string
}

export interface DiscoveryOptions {
  /** Directories to enter; nothing outside them is read. */
  roots: readonly string[]
  /** Maximum directory depth below a root (root itself is depth 0). */
  maxDepth?: number
  /** Hard cap on directories visited across all roots. */
  maxEntries?: number
  /** Hard cap on wall-clock time for one scan. */
  budgetMs?: number
  /** Stop after this many hits; the caller only needs the first parsable file. */
  maxResults?: number
  /** Injectable clock (tests). */
  now?: () => number
}

/** True when a directory name looks like the app we are hunting for. */
function looksLikeLoomy(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('loomy') || lower.includes('iflytek') || name.includes('讯飞')
}

function isSkipped(name: string): boolean {
  return SKIP_DIRECTORIES.has(name.toLowerCase()) || name.startsWith('.')
}

/**
 * Find every `auth-session.json` under `roots`, cheapest-first.
 *
 * Breadth-first so plausible locations surface before a deep alphabetical
 * sweep; the result is then ranked by name, depth and path. Errors on one
 * directory (permissions, a race with the client rewriting its tree) never
 * abort the scan.
 */
export async function discoverAuthSessionFiles(options: DiscoveryOptions): Promise<string[]> {
  const now = options.now ?? (() => Date.now())
  const deadline = now() + (options.budgetMs ?? 1200)
  const maxDepth = options.maxDepth ?? 2
  const maxEntries = options.maxEntries ?? 4000
  const maxResults = options.maxResults ?? 8

  const queue: PendingDirectory[] = []
  const seen = new Set<string>()
  for (const root of options.roots) {
    if (seen.has(root)) continue
    seen.add(root)
    queue.push({ path: root, depth: 0, name: root })
  }

  const hits: Array<{ path: string; depth: number; score: number }> = []
  let visited = 0

  while (queue.length > 0) {
    if (hits.length >= maxResults) break
    if (visited >= maxEntries) break
    if (now() > deadline) break
    const current = queue.shift()
    if (current === undefined) break
    visited += 1

    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) {
        if (entry.name.toLowerCase() !== AUTH_FILE_NAME) continue
        const path = join(current.path, entry.name)
        hits.push({ path, depth: current.depth, score: looksLikeLoomy(current.name) ? 0 : 1 })
      } else if (entry.isDirectory()) {
        if (current.depth >= maxDepth) continue
        if (isSkipped(entry.name)) continue
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1, name: entry.name })
      }
    }
  }

  hits.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score
    if (left.depth !== right.depth) return left.depth - right.depth
    return left.path.localeCompare(right.path)
  })
  return hits.map((hit) => hit.path)
}

/** A cached, single-flight discoverer plus the cache controls the store needs. */
export interface AuthDiscovery {
  (): Promise<string[]>
  /** Drop the cached answer so the next call rescans. */
  invalidate(): void
}

/**
 * Build the fallback discoverer used by the host.
 *
 * `roots` defaults to `discoveryRoots(platform, env, home)`. Answers — empty or
 * not — are reused for `ttlMs()` milliseconds; `invalidate()` is called by the
 * settings card's 「重新检测」 path so a login made a second ago is visible.
 */
export function createAuthDiscovery(options: {
  roots?: readonly string[]
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
  maxDepth?: number
  maxEntries?: number
  budgetMs?: number
  ttlMs?: () => number
  now?: () => number
} = {}): AuthDiscovery {
  const now = options.now ?? (() => Date.now())
  const platform = options.platform ?? process.platform
  const roots = options.roots ?? discoveryRoots(platform, options.env, options.home)
  // Windows nests vendor directories one level deeper than the macOS layout, so
  // `%APPDATA%\<vendor>\<product>\auth-session.json` (and one more level for
  // the client's own subdirectory) still resolves inside the budget.
  const maxDepth = options.maxDepth ?? (platform === 'win32' ? 3 : 2)
  const ttl = (): number => {
    const value = options.ttlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_DISCOVERY_TTL_MS
  }
  let cached: string[] | undefined
  let cachedAt = 0
  let pending: Promise<string[]> | undefined

  const discover = async (): Promise<string[]> => {
    if (cached !== undefined && now() - cachedAt < ttl()) return cached
    pending ??= discoverAuthSessionFiles({
      roots,
      maxDepth,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
      now,
    })
      .then((paths) => {
        cached = paths
        cachedAt = now()
        return paths
      })
      .catch((): string[] => {
        cached = []
        cachedAt = now()
        return []
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return Object.assign(discover, {
    invalidate(): void {
      cached = undefined
      cachedAt = 0
    },
  })
}

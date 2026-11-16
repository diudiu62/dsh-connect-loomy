/**
 * The plugin's own sign-in store: sessions the user logged into **from the
 * plugin's settings card**, persisted under the plugin's storage directory.
 *
 * Precedence (decision: plugin-first): {@link readAuthSession} in `auth.ts`
 * consults this store **before** the desktop client's `auth-session.json`, so
 * a login made here wins until the user signs out here — while a desktop-side
 * login is still picked up automatically when this store is empty. Signing out
 * in the plugin falls back to whatever the desktop client currently holds.
 *
 * The file mirrors the desktop client's document shape (`{session, userid,
 * phone, updatedAt}`) so `parseSessionDocument` can read both without special
 * cases. Writes are atomic with `0600`/`0700` modes, matching the state file.
 * The session never appears in logs, HTTP responses or views.
 *
 * @module dsh-connect-loomy/plugin-auth
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_SESSION_TTL_MS } from './shared/types.js'
import { authSessionCandidates, type AuthCandidate } from './shared/paths.js'
import { sessionFingerprint, type AuthSnapshot } from './auth.js'
import { displayPhone, displayUserId, safeErrorMessage, toEpochMs } from './shared/text.js'

/** File name inside the plugin storage directory. */
export const PLUGIN_AUTH_FILE = 'auth-session.json'

/** Resolve `<plugin storage dir>/auth-session.json`. */
export function pluginAuthPath(storageDir: string): string {
  return join(storageDir, PLUGIN_AUTH_FILE)
}

/** The default storage dir, resolved the same way the state store does it. */
export function defaultPluginStorageDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME']?.trim()
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), 'storages', 'dsh-connect-loomy')
}

/** What persisting one login produced. */
export type PluginAuthWriteResult =
  | { kind: 'ok'; path: string; fingerprint: string }
  | { kind: 'failure'; code: string; message: string }

/**
 * Persist one plugin-side login atomically.
 *
 * The document intentionally matches the desktop client's shape so the same
 * parser reads both; `updatedAt` uses the same epoch-ms convention.
 */
export async function writePluginAuthSession(options: {
  storageDir: string
  session: string
  userId?: string
  phone?: string
  now?: () => number
}): Promise<PluginAuthWriteResult> {
  const now = options.now ?? (() => Date.now())
  const path = pluginAuthPath(options.storageDir)
  const document = {
    session: options.session,
    ...(options.userId === undefined ? {} : { userid: options.userId }),
    ...(options.phone === undefined ? {} : { phone: options.phone }),
    updatedAt: now(),
  }
  const payload = `${JSON.stringify(document, undefined, 2)}\n`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
    await chmod(path, 0o600)
    await chmod(dirname(path), 0o700).catch(() => undefined)
    return { kind: 'ok', path, fingerprint: sessionFingerprint(options.session) }
  } catch (error) {
    return {
      kind: 'failure',
      code: 'write_failed',
      message: `登录态写入失败（${path}）：${safeErrorMessage(error)}`,
    }
  }
}

/** Remove the plugin-side session; the desktop client's file is untouched. */
export async function clearPluginAuthSession(storageDir: string): Promise<PluginAuthWriteResult> {
  const path = pluginAuthPath(storageDir)
  try {
    await rm(path, { force: true })
    return { kind: 'ok', path, fingerprint: '' }
  } catch (error) {
    return {
      kind: 'failure',
      code: 'remove_failed',
      message: `退出登录失败（${path}）：${safeErrorMessage(error)}`,
    }
  }
}

/**
 * Read the plugin-side session as a candidate-compatible view.
 *
 * Returned shapes mirror `auth.ts`'s snapshot so the auth store can splice
 * this source in ahead of the desktop candidates without a second code path.
 */
export async function readPluginAuthSession(
  storageDir: string,
): Promise<{ found: boolean; path: string; session?: string; userId?: string; phone?: string; loginAt?: number; problem?: string }> {
  const path = pluginAuthPath(storageDir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { found: false, path, problem: '插件侧暂无登录态' }
    return { found: false, path, problem: `插件登录态无法读取：${safeErrorMessage(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { found: false, path, problem: `插件登录态损坏（JSON 解析失败）：${safeErrorMessage(error)}` }
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['session'] !== 'string'
  ) {
    return { found: false, path, problem: '插件登录态缺少 session 字段' }
  }
  const record = parsed as Record<string, unknown>
  const session = record['session'] as string
  if (session.length < 16 || /\s/u.test(session)) {
    return { found: false, path, problem: '插件登录态的 session 字段无效' }
  }
  const userId = typeof record['userid'] === 'string' ? record['userid'] : undefined
  const phone = typeof record['phone'] === 'string' ? record['phone'] : undefined
  return {
    found: true,
    path,
    session,
    ...(userId === undefined ? {} : { userId }),
    ...(phone === undefined ? {} : { phone }),
    loginAt: toEpochMs(record['updatedAt']),
  }
}

/**
 * A snapshot view for diagnostics that reports where the *effective* session
 * came from (plugin store vs desktop client).
 */
export function pluginAuthSnapshotView(read: Awaited<ReturnType<typeof readPluginAuthSession>>): {
  exists: boolean
  path: string
  phone?: string
  userId?: string
  fingerprint?: string
  problem?: string
} {
  if (!read.found) {
    return { exists: false, path: read.path, ...(read.problem === undefined ? {} : { problem: read.problem }) }
  }
  return {
    exists: true,
    path: read.path,
    ...(read.phone === undefined ? {} : { phone: displayPhone(read.phone) }),
    ...(read.userId === undefined ? {} : { userId: displayUserId(read.userId) }),
    fingerprint: sessionFingerprint(read.session as string),
  }
}

/** TTL for the plugin's own snapshot cache mirrors the desktop reader's. */
export const PLUGIN_AUTH_TTL_MS = DEFAULT_SESSION_TTL_MS

/**
 * Build the credential candidate list with the plugin's own store first.
 *
 * Precedence (decision: plugin-first):
 * 1. `LOOMY_AUTH_SESSION_FILE` when set — an **exclusive replacement**, exactly
 *    as before, so tests and the CLI keep their "no real desktop credential"
 *    guarantee and this store cannot silently override a pinned file;
 * 2. the plugin's own login (`<storages>/dsh-connect-loomy/auth-session.json`);
 * 3. the desktop client's paths, in their existing order.
 *
 * Step 2 ahead of step 3 is the whole point: a login made in the settings card
 * is the newest credential the user asked for, and it must win over a stale
 * desktop file. Signing out here falls back to the desktop file automatically
 * because the candidate simply stops resolving.
 */
export function authSessionCandidatesWithPlugin(
  storageDir: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): AuthCandidate[] {
  const desktop = authSessionCandidates(platform, env, home)
  // The env override is exclusive by contract; never interleave with it.
  if (desktop.length === 1 && desktop[0]?.origin === 'env') return desktop
  const pluginCandidate: AuthCandidate = { path: pluginAuthPath(storageDir), origin: 'plugin' }
  if (desktop.some((candidate) => candidate.path === pluginCandidate.path)) return desktop
  return [pluginCandidate, ...desktop]
}

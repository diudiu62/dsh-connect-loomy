/**
 * Filesystem locations the Loomy host reads and writes.
 *
 * Two rules shape this module:
 *
 * 1. The **only** credential source is the desktop client's own
 *    `auth-session.json`; the plugin never writes it and never copies it.
 * 2. Everything the plugin owns lives under `$DSH_HOME` (then `~/.dsh`), so a
 *    profile reset is enough to remove every trace of it.
 *
 * @module dsh-connect-loomy/shared/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Environment variable that **replaces** the Loomy sign-in file (tests / CLI). */
export const LOOMY_AUTH_FILE_ENV = 'LOOMY_AUTH_SESSION_FILE'

/** Resolve the harness home: `$DSH_HOME` (non-blank) then `~/.dsh`. */
export function resolveDshHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env[DSH_HOME_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured.trim())
  }
  return resolve(home, '.dsh')
}

/**
 * 目录名与 `dsh-connect-desktop` 这个包名一致（`core/store.ts#STORAGE_ROOT` 是权威）。
 *
 * 0.3.0 起按供应商分目录：`$DSH_HOME/storages/dsh-connect-desktop/<vendorId>/`。
 * 这两个函数只服务于"没有宿主上下文"的调用方（CLI、测试）；运行时永远走
 * `deps.storageDir`。名字必须与 `core/store.ts` 一致，否则会出现"测试里能读到、
 * 真机上读不到"。
 */
export function stateDirectory(dshHome: string = resolveDshHome(), vendorId = 'loomy'): string {
  return join(dshHome, 'storages', 'dsh-connect-desktop', vendorId)
}

/** 某个供应商的 state 文档（目录缓存、已保存的选择、最后一次上游错误）。 */
export function stateFilePath(dshHome: string = resolveDshHome(), vendorId = 'loomy'): string {
  return join(stateDirectory(dshHome, vendorId), 'state.json')
}

/** One credential candidate plus whether it came from an explicit override. */
export interface AuthCandidate {
  path: string
  /** `env` when `LOOMY_AUTH_SESSION_FILE` supplied it; `plugin` for the plugin's own store. */
  origin: 'env' | 'default' | 'plugin'
}

/**
 * Every path the Loomy desktop client may have written its sign-in to.
 *
 * The macOS path is the verified one (docs/loomy-upstream.md §1.1). Windows and
 * Linux entries are Electron's standard `userData` locations for the same app
 * name; they are listed so `doctor` can answer "where did you look?" on those
 * platforms instead of silently reporting "no credentials".
 *
 * `LOOMY_AUTH_SESSION_FILE` is an **exclusive replacement**, not a priority
 * hint: when it is set, the desktop defaults are not inspected at all. Tests,
 * CI and the CLI set it precisely to guarantee that no real desktop credential
 * can be handed to a temporary `LOOMY_BASE_URL`; silently falling back would
 * defeat that guarantee.
 *
 * The plugin's **own** sign-in store (`<storages>/dsh-connect-loomy/auth-session.json`,
 * written by the settings card's SMS login) is spliced in ahead of the desktop
 * paths by `authSessionCandidatesWithPlugin` in `plugin-auth.ts`, not here: this
 * function stays exactly "what the desktop client may have written", which is
 * what its `origin` tag promises.
 */
export function authSessionCandidates(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): AuthCandidate[] {
  const override = env[LOOMY_AUTH_FILE_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    return [{ path: resolve(override.trim()), origin: 'env' }]
  }
  const candidates: AuthCandidate[] = []
  const xdg = env['XDG_CONFIG_HOME']
  if (platform === 'darwin') {
    candidates.push(
      { path: join(home, 'Library', 'Application Support', 'loomy', 'auth-session.json'), origin: 'default' },
      { path: join(home, 'Library', 'Application Support', 'Loomy', 'auth-session.json'), origin: 'default' },
    )
  } else if (platform === 'win32') {
    const appData = windowsAppData(env, home)
    // Electron's `userData` is `%APPDATA%\<productName>`, and the product name
    // is not stable across builds of the same app: the macOS bundle calls
    // itself `loomy`, a Windows build may ship as `Loomy`, nest under the
    // vendor (`iFlytek\Loomy`) or use the Chinese display name. `auth-session.json`
    // is a plain JSON file, so trying all of them costs four `stat` calls.
    candidates.push(
      { path: join(appData, 'loomy', 'auth-session.json'), origin: 'default' },
      { path: join(appData, 'Loomy', 'auth-session.json'), origin: 'default' },
      { path: join(appData, 'iFlytek', 'loomy', 'auth-session.json'), origin: 'default' },
      { path: join(appData, 'iFlytek', 'Loomy', 'auth-session.json'), origin: 'default' },
      { path: join(appData, '讯飞办公助手', 'auth-session.json'), origin: 'default' },
      { path: join(appData, 'iflytek-loomy', 'auth-session.json'), origin: 'default' },
      // Some Electron builds fall back to a dot-directory in the profile.
      { path: join(home, '.loomy', 'auth-session.json'), origin: 'default' },
    )
    const localAppData = windowsLocalAppData(env, home)
    candidates.push(
      { path: join(localAppData, 'loomy', 'auth-session.json'), origin: 'default' },
      { path: join(localAppData, 'Loomy', 'auth-session.json'), origin: 'default' },
    )
  } else {
    const configHome = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(home, '.config')
    candidates.push(
      { path: join(configHome, 'loomy', 'auth-session.json'), origin: 'default' },
      { path: join(configHome, 'Loomy', 'auth-session.json'), origin: 'default' },
    )
  }
  // De-duplicate while preserving precedence.
  const seen = new Set<string>()
  const unique: AuthCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)
    unique.push(candidate)
  }
  return unique
}

/**
 * `%APPDATA%` for this process.
 *
 * The environment variable is the authority, but it is **not always there**: a
 * DSH started from a service, a stripped-down shell or a GUI launcher may hand
 * the plugin an environment without `APPDATA`, and an empty candidate list is
 * indistinguishable from "the user never logged in". Falling back to
 * `<home>\AppData\Roaming` keeps discovery working in that case.
 */
export function windowsLocalAppData(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env['LOCALAPPDATA']
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(home, 'AppData', 'Local')
}

/**
 * `%APPDATA%` for the process, or the Electron default when it is absent.
 */
export function windowsAppData(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env['APPDATA']
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(home, 'AppData', 'Roaming')
}

/**
 * Directories a bounded fallback search may look into when none of the
 * {@link authSessionCandidates} parsed.
 *
 * Kept narrow on purpose: one level of Electron `userData` directories is what
 * the desktop client can plausibly use, and the search runs only while signed
 * out, with its own entry budget (see `shared/discover.ts`).
 */
export function discoveryRoots(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  if (platform === 'win32') {
    return [windowsAppData(env, home), windowsLocalAppData(env, home)]
  }
  const xdg = env['XDG_CONFIG_HOME']
  return [typeof xdg === 'string' && xdg.trim().length > 0 ? xdg.trim() : join(home, '.config')]
}

/** The primary credential path the card shows when nothing parsed. */
export function primaryAuthPath(
  candidates: readonly AuthCandidate[],
): string {
  return candidates[0]?.path ?? join(homedir(), 'Library', 'Application Support', 'loomy', 'auth-session.json')
}

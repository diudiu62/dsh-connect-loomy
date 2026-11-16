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

/** Directory this plugin owns under the harness home. */
export function stateDirectory(dshHome: string = resolveDshHome()): string {
  return join(dshHome, 'storages', 'dsh-connect-loomy')
}

/** The one JSON file holding the catalog cache, the saved selection and last error. */
export function stateFilePath(dshHome: string = resolveDshHome()): string {
  return join(stateDirectory(dshHome), 'state.json')
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
  const appData = env['APPDATA']
  const localAppData = env['LOCALAPPDATA']
  const xdg = env['XDG_CONFIG_HOME']
  if (platform === 'darwin') {
    candidates.push(
      { path: join(home, 'Library', 'Application Support', 'loomy', 'auth-session.json'), origin: 'default' },
      { path: join(home, 'Library', 'Application Support', 'Loomy', 'auth-session.json'), origin: 'default' },
    )
  } else if (platform === 'win32') {
    if (appData !== undefined && appData.trim().length > 0) {
      candidates.push(
        { path: join(appData, 'loomy', 'auth-session.json'), origin: 'default' },
        { path: join(appData, 'Loomy', 'auth-session.json'), origin: 'default' },
      )
    }
    if (localAppData !== undefined && localAppData.trim().length > 0) {
      candidates.push({ path: join(localAppData, 'loomy', 'auth-session.json'), origin: 'default' })
    }
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

/** The primary credential path the card shows when nothing parsed. */
export function primaryAuthPath(
  candidates: readonly AuthCandidate[],
): string {
  return candidates[0]?.path ?? join(homedir(), 'Library', 'Application Support', 'loomy', 'auth-session.json')
}

/**
 * File-mode helper for the two files this plugin writes itself.
 *
 * The acceptance rule is "plugin state and the plugin's own sign-in store are
 * `0600`, their directory `0700`". POSIX gets that from `chmod`; Windows has no
 * POSIX bits at all — `chmod` there only toggles the read-only attribute — so a
 * failure must degrade to "mode not enforced on this filesystem" instead of
 * failing the write. The file content is already written and renamed into place
 * by the time this runs, so throwing here would report a successful login or
 * account import as broken.
 *
 * @module dsh-connect-loomy/shared/modes
 */

import { chmod } from 'node:fs/promises'

/** Private file mode: owner read/write only. */
export const PRIVATE_FILE_MODE = 0o600

/** Private directory mode: owner only. */
export const PRIVATE_DIRECTORY_MODE = 0o700

/**
 * Best-effort `chmod`. Returns whether the mode was applied; never throws.
 */
export async function applyMode(path: string, mode: number): Promise<boolean> {
  try {
    await chmod(path, mode)
    return true
  } catch {
    return false
  }
}

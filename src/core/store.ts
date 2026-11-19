/**
 * The plugin's private storage: one directory per vendor, atomic JSON writes.
 *
 * Layout (fresh in this release — there is no migration from the single-vendor
 * layout, by product decision):
 *
 * ```
 * $DSH_HOME/storages/dsh-connect-desktop/
 *   <vendorId>/state.json        # catalog cache, selection, pool preference
 *   <vendorId>/accounts.json     # stored accounts (contains sessions, 0600)
 *   <vendorId>/auth-session.json # the plugin's own login, when it has one
 * ```
 *
 * Writes are atomic (temp file + rename) and `0600`, directory `0700`, and
 * serialised per path so two overlapping whole-document writes cannot
 * last-writer-win in an unpredictable order.
 *
 * @module dsh-connect-desktop/core/store
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '../shared/paths.js'
import type { DocumentOptions, DocumentStore } from '../vendor-sdk/contracts.js'

/** Directory name this plugin owns under `$DSH_HOME/storages`. */
export const STORAGE_ROOT = 'dsh-connect-desktop'

/** Root of every vendor's state. */
export function storageRoot(dshHome: string = resolveDshHome()): string {
  return join(dshHome, 'storages', STORAGE_ROOT)
}

/** One vendor's directory. */
export function vendorStorageDir(vendorId: string, dshHome: string = resolveDshHome()): string {
  return join(storageRoot(dshHome), vendorId)
}

/** Serialised, atomic, permission-restricted JSON document. */
export function createDocument<T>(
  options: DocumentOptions<T> & { path: string; now?: () => number },
): DocumentStore<T> {
  const { path } = options
  let queue: Promise<void> = Promise.resolve()

  return {
    path,
    async load() {
      try {
        return options.parse(await readFile(path, 'utf8'))
      } catch {
        // Missing or unreadable degrades to the empty document: a corrupt cache
        // must never stop the plugin from mounting.
        return options.empty()
      }
    },
    async save(value) {
      const text = options.serialize(value)
      const write = queue.then(async () => {
        const directory = dirname(path)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.${(options.now ?? Date.now)()}.tmp`
        try {
          await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
        // `mode` is advisory on some platforms; enforce it after the rename.
        await chmod(path, 0o600).catch(() => undefined)
      })
      // Keep the queue alive when this write fails, so one failure does not
      // wedge every later save.
      queue = write.catch(() => undefined)
      await write
    },
  }
}

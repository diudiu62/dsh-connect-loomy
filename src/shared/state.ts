/**
 * The plugin's one private state file.
 *
 * It lives under `$DSH_HOME/storages/dsh-connect-loomy/state.json` and holds
 * exactly three facts: the last successful catalog, the user's saved model
 * selection, and the last upstream error. It **never** holds the session
 * token: that value is re-read from the desktop client on demand and lives
 * only in `src/auth.ts`'s in-memory snapshot.
 *
 * Writes are atomic (unique temp file in the same directory, then rename) and
 * the file/directory modes are restricted to the current user (`0600`/`0700`).
 * The 0600 requirement is part of the acceptance criteria; `chmod` after the
 * rename keeps it true even when the platform ignores `mode` on creation.
 *
 * @module dsh-connect-loomy/shared/state
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CatalogModel, UpstreamErrorView } from './types.js'
import { isRecord } from './text.js'

/** Current state-file schema version. */
export const STATE_VERSION = 1

/** Everything persisted between DSH runs. */
export interface PersistedState {
  version: typeof STATE_VERSION
  /** `null` means "never saved" → first run defaults to every chat model. */
  selection: string[] | null
  catalog: CatalogModel[]
  refreshedAt: number | null
  lastError?: UpstreamErrorView
  /** Epoch ms of the last saved selection (diagnostics only). */
  savedAt?: number
  /**
   * Whether the rotation pool route should be offered.
   *
   * A user preference, not a fact about the accounts: some people want the
   * cheapest available account per call, others need to know exactly which
   * account is paying. Stored here because it must survive a restart.
   */
  poolEnabled?: boolean
  /**
   * Which account the single `loomy` route should authenticate as.
   *
   * Accounts are no longer one provider route each: the picker shows one
   * `loomy` group and the account is chosen in the composer's account drawer.
   * `undefined` means "first healthy account" (or the desktop sign-in).
   */
  activeAccountId?: string
}

/** Empty state: no cache, no explicit selection. */
export function emptyState(): PersistedState {
  return { version: STATE_VERSION, selection: null, catalog: [], refreshedAt: null }
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.multiplier === 'number' &&
    typeof value.contextWindow === 'number' &&
    typeof value.maxOutput === 'number' &&
    typeof value.vision === 'boolean' &&
    Array.isArray(value.efforts) &&
    value.efforts.every((entry) => typeof entry === 'string') &&
    typeof value.defaultEffort === 'string'
  )
}

function isUpstreamError(value: unknown): value is UpstreamErrorView {
  if (!isRecord(value)) return false
  return (
    typeof value.at === 'number' &&
    typeof value.path === 'string' &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  )
}

/**
 * Parse one state document. Anything unexpected degrades to the empty state
 * rather than throwing: a corrupt cache must never stop the plugin from
 * mounting.
 */
export function parseState(text: string): PersistedState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyState()
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return emptyState()
  const selection = Array.isArray(parsed.selection)
    ? parsed.selection.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : null
  const catalog = Array.isArray(parsed.catalog) ? parsed.catalog.filter(isCatalogModel) : []
  const refreshedAt =
    typeof parsed.refreshedAt === 'number' && Number.isFinite(parsed.refreshedAt) ? parsed.refreshedAt : null
  const state: PersistedState = { version: STATE_VERSION, selection, catalog, refreshedAt }
  if (isUpstreamError(parsed.lastError)) state.lastError = parsed.lastError
  if (typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)) state.savedAt = parsed.savedAt
  if (typeof parsed.poolEnabled === 'boolean') state.poolEnabled = parsed.poolEnabled
  if (typeof parsed.activeAccountId === 'string' && parsed.activeAccountId.length > 0) {
    state.activeAccountId = parsed.activeAccountId
  }
  return state
}

/** Serialise deterministically (stable key order) for readable diffs. */
export function serializeState(state: PersistedState): string {
  const document: Record<string, unknown> = {
    version: STATE_VERSION,
    selection: state.selection,
    catalog: state.catalog.map((model) => ({
      id: model.id,
      name: model.name,
      multiplier: model.multiplier,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      vision: model.vision,
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    })),
    refreshedAt: state.refreshedAt,
  }
  if (state.lastError !== undefined) document['lastError'] = state.lastError
  if (state.savedAt !== undefined) document['savedAt'] = state.savedAt
  if (state.poolEnabled !== undefined) document['poolEnabled'] = state.poolEnabled
  if (state.activeAccountId !== undefined) document['activeAccountId'] = state.activeAccountId
  return `${JSON.stringify(document, null, 2)}\n`
}

/** The state store handle. One instance per plugin; writes are serialised. */
export interface StateStore {
  /** Path of the JSON document (also used by diagnostics/tests). */
  readonly path: string
  /** Load and validate the document; missing/corrupt returns the empty state. */
  load(): Promise<PersistedState>
  /** Atomically persist; resolves once the rename is visible. */
  save(state: PersistedState): Promise<void>
}

/** Create the store for one absolute file path. */
export function createStateStore(path: string): StateStore {
  let queue: Promise<void> = Promise.resolve()
  return {
    path,
    async load() {
      try {
        return parseState(await readFile(path, 'utf8'))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return emptyState()
        return emptyState()
      }
    },
    async save(state) {
      // Serialise writes: two overlapping saves of a whole document would
      // otherwise last-writer-win in an unpredictable order.
      const write = queue.then(async () => {
        const directory = dirname(path)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
        try {
          await writeFile(temporary, serializeState(state), { encoding: 'utf8', mode: 0o600 })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
        // `mode` is advisory on some platforms; enforce the acceptance rule.
        await chmod(path, 0o600).catch(() => undefined)
      })
      // Keep the queue alive even when this write fails, so one failure does
      // not wedge every later save.
      queue = write.catch(() => undefined)
      await write
    },
  }
}

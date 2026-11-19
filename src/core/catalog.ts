/**
 * The one catalog store.
 *
 * A vendor supplies only `fetchModels` (its `/models` call, already normalised to
 * {@link CatalogModel}). Everything else — the TTL cache, the on-disk cache, the
 * saved selection, the capability overrides, the failure record, the
 * fire-and-forget refresh from the inference path — is identical for every
 * vendor and lives here.
 *
 * @module dsh-connect-desktop/core/catalog
 */

import type { CatalogDriver, CatalogSnapshot, DocumentStore } from '../vendor-sdk/contracts.js'
import type { CatalogModel, UpstreamErrorView } from '../shared/views.js'
import { safeErrorMessage } from '../shared/text.js'
import type { VendorState } from './state.js'

/** How long a `kickRefresh()` may be skipped after one attempt. */
const KICK_MIN_INTERVAL_MS = 30_000

export interface VisionOverrides {
  /** Force-declare image input for models the upstream tags wrongly. */
  visionModelIds: readonly string[]
  /** Force-declare text-only; wins over `visionModelIds`. */
  textOnlyModelIds: readonly string[]
}

/** Apply capability overrides without touching the cached raw catalog. */
export function applyVisionOverrides(models: readonly CatalogModel[], overrides: VisionOverrides): CatalogModel[] {
  const vision = new Set(overrides.visionModelIds)
  const textOnly = new Set(overrides.textOnlyModelIds)
  return models.map((model) => {
    if (textOnly.has(model.id)) return model.vision ? { ...model, vision: false } : model
    if (vision.has(model.id)) return model.vision ? model : { ...model, vision: true }
    return model
  })
}

export interface CatalogDriverOptions {
  /** Upstream read; must throw on failure (the store records it). */
  fetchModels: () => Promise<CatalogModel[]>
  /** Cache window; `0` refreshes on every read. */
  ttlMs: () => number
  state: DocumentStore<VendorState>
  /** Capability hatch applied on every read, never persisted. */
  overrides?: () => VisionOverrides
  endpoints: () => ReadonlyArray<{ label: string; url: string }>
  /** Called when the model list or the selection changed. */
  onChanged?: () => void
  logger?: { warn(message: string, error?: unknown): void }
  now?: () => number
}

export interface CatalogStore extends CatalogDriver {
  /** Models the user kept, with the capability overrides applied. */
  enabledModels(): CatalogModel[]
  /** Every model, overrides applied. */
  models(): CatalogModel[]
  /** Epoch ms of the last successful read. */
  refreshedAt(): number | null
  /** The saved selection, or `null` for "everything". */
  selection(): string[] | null
}

export function createCatalogStore(options: CatalogDriverOptions): CatalogStore {
  const now = options.now ?? (() => Date.now())
  /** Raw catalog as the upstream answered it (overrides applied on read). */
  let raw: CatalogModel[] = []
  let refreshedAt: number | null = null
  let selection: string[] | null = null
  let lastError: UpstreamErrorView | undefined
  let loadedAt = 0
  let hydrated = false
  let pending: Promise<CatalogSnapshot> | undefined
  let lastKick = 0

  const overridden = (): CatalogModel[] =>
    options.overrides === undefined ? raw : applyVisionOverrides(raw, options.overrides())

  const fresh = (): boolean => {
    if (raw.length === 0) return false
    const ttl = options.ttlMs()
    if (!Number.isFinite(ttl) || ttl <= 0) return false
    return now() - loadedAt < ttl
  }

  const persist = async (patch: Partial<VendorState>): Promise<void> => {
    const current = await options.state.load()
    await options.state.save({
      ...current,
      ...patch,
      ...(lastError === undefined ? {} : { lastError }),
    })
  }

  const adopt = (snapshot: { catalog: CatalogModel[]; refreshedAt: number | null; selection: string[] | null }): void => {
    raw = snapshot.catalog
    refreshedAt = snapshot.refreshedAt
    selection = snapshot.selection
  }

  const store: CatalogStore = {
    async hydrate() {
      if (hydrated) return
      hydrated = true
      const state = await options.state.load()
      selection = state.selection
      if (state.catalog.length > 0) {
        raw = state.catalog
        refreshedAt = state.refreshedAt
        // A disk cache is not "fresh": `loadedAt` stays 0 so the next read
        // refreshes when the TTL window has no in-memory answer yet.
      }
      if (state.lastError !== undefined) lastError = state.lastError
    },

    async read(readOptions = {}) {
      if (readOptions.force !== true && fresh()) {
        return { models: overridden(), refreshedAt, source: 'memory' }
      }
      if (pending !== undefined) return pending
      pending = (async () => {
        try {
          if (!hydrated) await store.hydrate()
          const models = await options.fetchModels()
          raw = models
          refreshedAt = now()
          loadedAt = refreshedAt
          lastError = undefined
          await persist({ catalog: models, refreshedAt, selection })
          options.onChanged?.()
          return { models: overridden(), refreshedAt, source: 'upstream' as const }
        } catch (error) {
          const failure: UpstreamErrorView = {
            at: now(),
            path: options.endpoints()[0]?.url ?? 'upstream',
            code: codeOf(error),
            message: safeErrorMessage(error),
          }
          lastError = failure
          await persist({}).catch(() => undefined)
          throw error
        } finally {
          pending = undefined
        }
      })()
      return pending
    },

    current() {
      return overridden()
    },

    models() {
      return overridden()
    },

    enabledIds() {
      const models = overridden()
      if (selection === null) return models.map((model) => model.id)
      const known = new Set(models.map((model) => model.id))
      return selection.filter((id) => known.has(id))
    },

    enabledModels() {
      const models = overridden()
      if (selection === null) return models
      const keep = new Set(selection)
      return models.filter((model) => keep.has(model.id))
    },

    selection() {
      return selection
    },

    refreshedAt() {
      return refreshedAt
    },

    async saveSelection(ids) {
      if (!hydrated) await store.hydrate()
      const known = new Set(overridden().map((model) => model.id))
      const next = [...new Set(ids)].filter((id) => known.has(id))
      selection = next
      await persist({ selection: next, savedAt: now() })
      options.onChanged?.()
      return next
    },

    kickRefresh() {
      const at = now()
      if (fresh()) return
      if (at - lastKick < KICK_MIN_INTERVAL_MS) return
      lastKick = at
      void store.read({ force: true }).catch((error: unknown) => {
        options.logger?.warn('dsh-connect-desktop: background catalog refresh failed', error)
      })
    },

    lastError() {
      return lastError
    },

    endpoints: options.endpoints,

    /** Test/diagnostic seam: adopt a snapshot without touching the network. */
    adopt,
  } as CatalogStore & { adopt(snapshot: unknown): void }

  return store
}

function codeOf(error: unknown): string {
  const carried = (error as { code?: unknown } | null)?.code
  if (typeof carried === 'string' && carried.length > 0) return carried
  return 'CATALOG_FAILED'
}

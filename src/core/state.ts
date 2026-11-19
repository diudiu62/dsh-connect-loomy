/**
 * The per-vendor state document.
 *
 * One JSON file per vendor under `$DSH_HOME/storages/dsh-connect-desktop/<id>/`
 * holding exactly: the cached catalog, the saved model selection, the last
 * upstream error and the pool preference. It **never** holds a session token.
 *
 * @module dsh-connect-desktop/core/state
 */

import type { CatalogModel, UpstreamErrorView } from '../shared/views.js'
import { isRecord } from '../shared/text.js'
import type { DocumentStore } from '../vendor-sdk/contracts.js'

/** Current state-document schema version. */
export const STATE_VERSION = 1

/** Everything persisted between DSH runs, for one vendor. */
export interface VendorState {
  version: typeof STATE_VERSION
  /** `null` means "never saved" → first run defaults to every chat model. */
  selection: string[] | null
  catalog: CatalogModel[]
  refreshedAt: number | null
  lastError?: UpstreamErrorView
  savedAt?: number
  /** Whether the rotation pool should be offered. */
  poolEnabled?: boolean
  /** Which account a non-rotating route authenticates as. */
  activeAccountId?: string
}

export function emptyVendorState(): VendorState {
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

/** Parse one document; anything unexpected degrades to the empty state. */
export function parseVendorState(text: string): VendorState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyVendorState()
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return emptyVendorState()
  const selection = Array.isArray(parsed.selection)
    ? parsed.selection.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : null
  const catalog = Array.isArray(parsed.catalog) ? parsed.catalog.filter(isCatalogModel) : []
  const refreshedAt =
    typeof parsed.refreshedAt === 'number' && Number.isFinite(parsed.refreshedAt) ? parsed.refreshedAt : null
  const state: VendorState = { version: STATE_VERSION, selection, catalog, refreshedAt }
  if (isUpstreamError(parsed.lastError)) state.lastError = parsed.lastError
  if (typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)) state.savedAt = parsed.savedAt
  if (typeof parsed.poolEnabled === 'boolean') state.poolEnabled = parsed.poolEnabled
  if (typeof parsed.activeAccountId === 'string' && parsed.activeAccountId.length > 0) {
    state.activeAccountId = parsed.activeAccountId
  }
  return state
}

/** Serialise deterministically (stable key order) for readable diffs. */
export function serializeVendorState(state: VendorState): string {
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

/** Convenience: the state store for one vendor directory. */
export function vendorStateStore(
  document: <T>(name: string, options: { parse(text: string): T; serialize(value: T): string; empty(): T }) => DocumentStore<T>,
): DocumentStore<VendorState> {
  return document<VendorState>('state.json', {
    parse: parseVendorState,
    serialize: serializeVendorState,
    empty: emptyVendorState,
  })
}

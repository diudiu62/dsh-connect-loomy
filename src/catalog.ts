/**
 * The Loomy model catalog: upstream fetch, normalisation, disk cache, saved
 * selection and live model view.
 *
 * The catalog is the **only** whitelist a request may name. The upstream
 * silently falls back to `spark-x2.6` for an unknown or empty model id and
 * bills nothing for it, so a request for a model this module does not list
 * must fail locally rather than pretend the user is talking to another model.
 * `auto` is excluded for a worse reason: it routes to GLM and **does** spend a
 * point.
 *
 * Selection semantics (contract v2):
 * - `selection === null` → never saved; every chat model is offered, and the
 *   host reports all ids rather than making the card guess.
 * - `selection` is an array (possibly empty) → exactly those ids, intersected
 *   with the live catalog. Refresh never mutates the saved selection.
 *
 * @module dsh-connect-loomy/catalog
 */

import type { CatalogModel, CatalogModelView, CatalogSnapshot, UpstreamErrorView } from './shared/types.js'
import { DEFAULT_BASE_URL, DEFAULT_CATALOG_TTL_MS } from './shared/types.js'
import { asPositiveInt, asString, asStringArray, isRecord, notSignedInMessage, redactSensitive, safeErrorMessage } from './shared/text.js'
import type { StateStore } from './shared/state.js'
import { emptyState, type PersistedState } from './shared/state.js'
import { modelsUrl, requestPlatform } from './shared/upstream.js'

/** Context fallback when the upstream omits `context_length`. */
export const FALLBACK_CONTEXT_WINDOW = 128_000

/** Output fallback when the upstream omits `max_output_tokens`. */
export const FALLBACK_MAX_OUTPUT = 8_192

/** Reasoning efforts the upstream currently advertises. */
export const KNOWN_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const

/** Pull the raw model array out of a `/models` success body. */
export function extractModelList(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body
  if (!isRecord(body)) return undefined
  const data = body['data']
  if (Array.isArray(data)) return data
  if (isRecord(data) && Array.isArray(data['data'])) return data['data']
  return undefined
}

/**
 * Normalise one upstream model entry, or reject it.
 *
 * Chat models only: `type === 'chat'` **and** `protocol === 'openai_chat'`.
 * Image models (`Hy-Image-*` and friends) are `type: 'image'` with
 * `output_modalities: ['image']`; registering one as a chat model would put a
 * guaranteed-404 entry in the selector. `auto` is excluded explicitly — the
 * gateway routes it to a paid model and bills a point.
 */
export function normalizeCatalogModel(raw: unknown): CatalogModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw['id'])
  if (id === undefined) return undefined
  if (id.toLowerCase() === 'auto') return undefined
  if (asString(raw['type']) !== 'chat') return undefined
  if (asString(raw['protocol']) !== 'openai_chat') return undefined

  const capabilities = isRecord(raw['capabilities']) ? raw['capabilities'] : undefined
  const outputModalities = asStringArray(capabilities?.['output_modalities'])
  if (outputModalities.length > 0 && !outputModalities.includes('text')) return undefined

  const name = asString(raw['name']) ?? id
  const reasoning = capabilities?.['reasoning'] === true
  const efforts = reasoning
    ? asStringArray(raw['reasoning_efforts']).filter((effort) =>
        (KNOWN_EFFORTS as readonly string[]).includes(effort),
      )
    : []
  const declaredDefault = asString(raw['default_reasoning_effort'])
  const defaultEffort =
    declaredDefault !== undefined && efforts.includes(declaredDefault) ? declaredDefault : (efforts[0] ?? '')

  const inputModalities = asStringArray(capabilities?.['input_modalities'])
  const vision = capabilities?.['vision'] === true && inputModalities.includes('image')

  return {
    id,
    name,
    multiplier: parseMultiplierOfName(name),
    contextWindow: asPositiveInt(raw['context_length']) ?? FALLBACK_CONTEXT_WINDOW,
    maxOutput: asPositiveInt(raw['max_output_tokens']) ?? FALLBACK_MAX_OUTPUT,
    vision,
    efforts,
    defaultEffort,
  }
}

function parseMultiplierOfName(name: string): number {
  // Kept local to avoid a runtime import cycle through shared/text in tests.
  const match = /[（(]\s*[xX×]\s*(\d+(?:\.\d+)?)\s*[)）]/u.exec(name)
  if (match === null) return 0
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** Normalise a whole `/models` body, keeping upstream order and de-duplicating. */
export function normalizeCatalog(body: unknown): CatalogModel[] {
  const list = extractModelList(body)
  if (list === undefined) return []
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  for (const raw of list) {
    const model = normalizeCatalogModel(raw)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/** Resolve the effective selection: `null` means "all chat models". */
export function resolveEnabledIds(models: readonly CatalogModel[], selection: readonly string[] | null): string[] {
  if (selection === null) return models.map((model) => model.id)
  const saved = new Set(selection)
  return models.filter((model) => saved.has(model.id)).map((model) => model.id)
}

/** Merge the saved selection into catalog entries for `POST /refresh`. */
export function mergeSelection(
  models: readonly CatalogModel[],
  selection: readonly string[] | null,
): CatalogModelView[] {
  const saved = selection === null ? null : new Set(selection)
  return models.map((model) => ({ ...model, enabled: saved === null || saved.has(model.id) }))
}

/** A catalog answer plus provenance, or a truthful failure. */
export type CatalogResult =
  | { kind: 'ok'; snapshot: CatalogSnapshot }
  | { kind: 'failure'; failure: UpstreamErrorView }

/** The auth facts the catalog needs; `session` is never persisted. */
export interface CatalogSession {
  session?: string
  sourcePath: string
  problem?: string
}

/** Dependencies of {@link createCatalogStore}. */
export interface CatalogDeps {
  /** Live base URL (configuration field may hot-update). */
  baseURL: () => string
  /** Read the desktop client's current session (re-read at most every 5s). */
  readSession: () => Promise<CatalogSession>
  state: StateStore
  /** Live cache TTL in ms; `0` forces every read to refresh. */
  ttlMs?: () => number
  /** Upstream request timeout. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  logger?: { warn(message: string): void }
  /** Called after a successful refresh or a saved selection. */
  onChanged?: () => void
}

/** The catalog service consumed by the provider, routes and CLI. */
export interface CatalogStore {
  readonly path: string
  hydrate(): Promise<void>
  current(): CatalogModel[]
  refreshedAt(): number | null
  selection(): string[] | null
  enabledIds(): string[]
  enabledModels(): CatalogModel[]
  lastError(): UpstreamErrorView | undefined
  /** Read from memory/disk, fetching only when allowed and stale. */
  ensure(options?: { allowNetwork?: boolean; force?: boolean }): Promise<CatalogResult>
  /** Force an upstream refresh, single-flight. */
  refresh(): Promise<CatalogResult>
  /**
   * Inference-path background sync: if the cached catalog is stale, start one
   * refresh without awaiting it. Never throws and never blocks the caller.
   *
   * Two guards keep a failing upstream from adding a `/models` call to every
   * request: `refresh()` is single-flight, and this method itself attempts at
   * most once per catalog-TTL window (successful or not).
   */
  kickStaleRefresh(): void
  /** Persist the user's explicit selection; unknown ids are dropped. */
  saveSelection(ids: readonly string[]): Promise<{ kind: 'ok'; enabled: string[] } | { kind: 'failure'; failure: UpstreamErrorView }>
  /** The catalog with the saved selection merged in. */
  view(): CatalogModelView[]
}

function failureOf(
  at: number,
  path: string,
  code: string,
  message: string,
  traceId?: string,
): UpstreamErrorView {
  return { at, path, code, message: redactSensitive(message), ...(traceId === undefined ? {} : { traceId }) }
}

/** Create the catalog store. One instance per plugin. */
export function createCatalogStore(deps: CatalogDeps): CatalogStore {
  const now = deps.now ?? (() => Date.now())
  let state: PersistedState = emptyState()
  let hydrated: Promise<void> | undefined
  let refreshing: Promise<CatalogResult> | undefined

  const hydrate = (): Promise<void> => {
    hydrated ??= deps.state.load().then((loaded) => {
      // Keep the strongest snapshot if a refresh finished while we were reading
      // the file (mount races), but never overwrite an explicit selection made
      // since the load started.
      if (state.catalog.length === 0 && loaded.catalog.length > 0) {
        state = {
          ...state,
          catalog: loaded.catalog,
          refreshedAt: loaded.refreshedAt,
          selection: state.selection ?? loaded.selection,
          ...(state.lastError === undefined && loaded.lastError !== undefined ? { lastError: loaded.lastError } : {}),
        }
      } else if (state.selection === null && loaded.selection !== null) {
        state = { ...state, selection: loaded.selection }
      }
    })
    return hydrated
  }

  const persist = async (): Promise<void> => {
    try {
      await deps.state.save(state)
    } catch (error) {
      deps.logger?.warn(`dsh-connect-loomy: could not write state cache: ${safeErrorMessage(error)}`)
    }
  }

  const ttl = (): number => {
    const value = deps.ttlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CATALOG_TTL_MS
  }

  const isStale = (): boolean => {
    if (state.catalog.length === 0) return true
    if (state.refreshedAt === null) return true
    return now() - state.refreshedAt >= ttl()
  }

  const doRefresh = async (): Promise<CatalogResult> => {
    await hydrate()
    const at = now()
    const baseURL = deps.baseURL() || DEFAULT_BASE_URL
    const readout = await deps.readSession()
    if (readout.session === undefined) {
      const failure = failureOf(
        at,
        '/models',
        'not_signed_in',
        notSignedInMessage(readout.sourcePath, readout.problem),
      )
      state = { ...state, lastError: failure }
      await persist()
      return { kind: 'failure', failure }
    }
    const answer = await requestPlatform({
      baseURL,
      path: '/models',
      session: readout.session,
      timeoutMs: deps.timeoutMs ?? 20_000,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    if (answer.kind === 'failure') {
      const failure = failureOf(at, '/models', answer.code, answer.message, answer.traceId)
      state = { ...state, lastError: failure }
      await persist()
      return { kind: 'failure', failure }
    }
    const models = normalizeCatalog(answer.body)
    if (models.length === 0) {
      const failure = failureOf(at, '/models', 'bad_response', '上游 /models 没有返回任何聊天模型（响应形状无法识别）')
      state = { ...state, lastError: failure }
      await persist()
      return { kind: 'failure', failure }
    }
    state = { ...state, catalog: models, refreshedAt: at }
    delete state.lastError
    await persist()
    deps.onChanged?.()
    return { kind: 'ok', snapshot: { models, refreshedAt: at, source: 'upstream' } }
  }

  const refresh = (): Promise<CatalogResult> => {
    if (refreshing !== undefined) return refreshing
    const run = doRefresh()
    refreshing = run.finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  const enabledIds = (): string[] => resolveEnabledIds(state.catalog, state.selection)

  let lastStaleKickAt = 0
  const kickStaleRefresh = (): void => {
    try {
      if (!isStale()) return
      const at = now()
      // One attempt per TTL window, whether it succeeds or not: a stale catalog
      // whose upstream is failing must not turn every inference request into
      // another `/models` attempt. `refresh()` already collapses overlap.
      if (lastStaleKickAt !== 0 && at - lastStaleKickAt < ttl()) return
      lastStaleKickAt = at
      void refresh().catch(() => undefined)
    } catch (error) {
      deps.logger?.warn(
        `dsh-connect-loomy: could not start a background catalog refresh: ${safeErrorMessage(error)}`,
      )
    }
  }

  return {
    path: deps.state.path,
    hydrate,
    current: () => state.catalog,
    refreshedAt: () => state.refreshedAt,
    selection: () => state.selection,
    enabledIds,
    enabledModels: () => {
      const enabled = new Set(enabledIds())
      return state.catalog.filter((model) => enabled.has(model.id))
    },
    lastError: () => state.lastError,
    async ensure(options = {}) {
      await hydrate()
      const force = options.force === true
      const allowNetwork = options.allowNetwork !== false
      if (force || isStale()) {
        if (allowNetwork) return refresh()
        return {
          kind: 'ok',
          snapshot: { models: state.catalog, refreshedAt: state.refreshedAt, source: 'cache' },
        }
      }
      return {
        kind: 'ok',
        snapshot: { models: state.catalog, refreshedAt: state.refreshedAt, source: 'memory' },
      }
    },
    refresh,
    kickStaleRefresh,
    async saveSelection(ids) {
      await hydrate()
      if (state.catalog.length === 0) {
        return {
          kind: 'failure',
          failure: failureOf(now(), '/save', 'catalog_empty', '模型目录尚未刷新，请先刷新目录再保存勾选'),
        }
      }
      const wanted = new Set<string>()
      for (const id of ids) {
        const text = asString(id)
        if (text !== undefined) wanted.add(text)
      }
      // Keep catalog order, drop ids the upstream no longer lists: a stale card
      // must never make a removed model selectable again.
      const enabled = state.catalog.filter((model) => wanted.has(model.id)).map((model) => model.id)
      state = { ...state, selection: enabled, savedAt: now() }
      await persist()
      deps.onChanged?.()
      return { kind: 'ok', enabled }
    },
    view: () => mergeSelection(state.catalog, state.selection),
  }
}

/** `GET /diagnostics` needs the upstream URLs without constructing a store. */
export function catalogUrls(baseURL: string): { modelsUrl: string; pointsUrl: string; baseUrl: string } {
  const base = baseURL || DEFAULT_BASE_URL
  return {
    baseUrl: base.replace(/\/+$/u, ''),
    modelsUrl: modelsUrl(base),
    pointsUrl: `${base.replace(/\/+$/u, '')}/points/records`,
  }
}

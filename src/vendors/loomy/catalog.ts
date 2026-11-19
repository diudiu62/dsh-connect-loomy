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
 * @module dsh-connect-desktop/catalog
 */

import type { CatalogModel, CatalogModelView } from '../../shared/views.js'
import { DEFAULT_BASE_URL, DEFAULT_CATALOG_TTL_MS } from './constants.js'
import { asPositiveInt, asString, asStringArray, isRecord, notSignedInMessage, redactSensitive, safeErrorMessage } from '../../shared/text.js'
import { modelsUrl, requestPlatform } from './upstream.js'

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

/** Configuration that overrides the upstream capability tag (see `config.ts`). */
export interface VisionOverrides {
  /** Force-declare image input for models the upstream tags wrongly. */
  visionModelIds?: readonly string[]
  /** Force-declare text-only; wins over {@link VisionOverrides.visionModelIds}. */
  textOnlyModelIds?: readonly string[]
}

/**
 * Apply the user's vision overrides on top of the parsed capabilities.
 *
 * The upstream `vision` flag is the gateway's only capability signal, and it is
 * wrong in both directions (`docs/loomy-upstream.md` §3.1 / §11): the default
 * model `spark-x2.6` declares text-only, and a session that already carries an
 * image is then refused by the host (`session/attachment-invalid`,
 * `MODEL_DOES_NOT_SUPPORT_IMAGES`) before any request leaves this process.
 *
 * Text-only wins when an id appears in both lists. The asymmetry is deliberate:
 * a wrong "can see" costs a failed request on every attachment, while a wrong
 * "cannot see" costs one text-only turn and is visible in the card.
 *
 * Unknown ids are ignored — the catalog stays the only whitelist.
 *
 * @param models - normalised catalog entries, `vision` as the upstream declared it.
 * @param overrides - live configuration; empty lists are a no-op.
 * @returns entries with `vision` re-labelled; unchanged rows keep their identity.
 */
export function applyVisionOverrides(
  models: readonly CatalogModel[],
  overrides: VisionOverrides = {},
): CatalogModel[] {
  const textOnly = new Set(overrides.textOnlyModelIds ?? [])
  const vision = new Set(overrides.visionModelIds ?? [])
  if (textOnly.size === 0 && vision.size === 0) return [...models]
  return models.map((model) => {
    if (textOnly.has(model.id)) return model.vision ? { ...model, vision: false } : model
    if (vision.has(model.id)) return model.vision ? model : { ...model, vision: true }
    return model
  })
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

/**
 * One `/models` read, normalised.
 *
 * This is the whole of Loomy's catalog protocol: the TTL cache, the on-disk
 * cache, the selection and the capability overrides live in `core/catalog.ts`,
 * because they are identical for every vendor.
 */
export async function fetchCatalogModels(options: {
  baseURL: string
  session: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<CatalogModel[]> {
  const answer = await requestPlatform({
    baseURL: options.baseURL,
    path: '/models',
    session: options.session,
    timeoutMs: options.timeoutMs ?? 20_000,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (answer.kind === 'failure') throw new UpstreamFailure(answer.code, answer.message, '/models', answer.traceId)
  const models = normalizeCatalog(answer.body)
  if (models.length === 0) {
    throw new UpstreamFailure('bad_response', '上游 /models 没有返回可识别的聊天模型', '/models')
  }
  return models
}

/** A normalised upstream failure, so `core/catalog.ts` can record it verbatim. */
export class UpstreamFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path: string,
    readonly traceId?: string,
  ) {
    super(message)
    this.name = 'UpstreamFailure'
  }
}

export function catalogUrls(baseURL: string): { modelsUrl: string; pointsUrl: string; baseUrl: string } {
  const base = baseURL || DEFAULT_BASE_URL
  return {
    baseUrl: base.replace(/\/+$/u, ''),
    modelsUrl: modelsUrl(base),
    pointsUrl: `${base.replace(/\/+$/u, '')}/points/records`,
  }
}

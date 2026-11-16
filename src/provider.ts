/**
 * The pi-ai side of the Loomy route: one provider route named `loomy`, whose
 * models are read live from the catalog, plus the adapter that plugs it into
 * the harness `llm` service.
 *
 * Design notes (all of them are acceptance criteria, not preferences):
 *
 * - **Only catalog entries are registered.** `getModels()` reads the live
 *   catalog and the user's saved selection. The upstream silently falls back
 *   to `spark-x2.6` for any unknown id, so a model that is not in this list
 *   must fail locally: pi-ai's `Models.getModel()` throws `UNKNOWN_MODEL`
 *   before any request is dispatched.
 * - **Model identity is the route id.** With a single Loomy route,
 *   `model.provider === 'loomy' === provider.id`, so `requireProvider` finds the
 *   provider and `isSameModel` (provider + api + model.id) stays true across
 *   turns. A second regional route would need WorkBuddy's double-key trick
 *   (contract doc §2.4).
 * - **The api string is `openai-completions` everywhere** and the wire fields
 *   are pinned through `compat`: `max_tokens` (the gateway's documented field),
 *   no `store`, no `developer` role, `reasoning_effort` enabled.
 * - **Vision is declared from upstream capabilities.** pi-ai 1.5.2 encodes
 *   attachments as `data:<mime>;base64,...` for both user messages and tool
 *   results (`@earendil-works/pi-ai/dist/api/openai-completions.js:937` and
 *   `:1086`), which is the only image form the gateway accepts.
 * - **Vision requires the durable attachment service.** `PiAiAdapter` only
 *   accepts image blocks when it can read them back from `ctx.attachments`:
 *   without `resolveAttachments` every image request fails before I/O with
 *   `pi-ai image input requires the durable attachment service`
 *   (`dsh-llm-pi-ai/lib/index.js:2003`). The profile that ships this plugin
 *   always mounts `dsh-attachment-local`, so the seam is resolved lazily per
 *   request and a missing service is reported as an actionable error rather
 *   than the generic capability failure.
 *
 * @module dsh-connect-loomy/provider
 */

import {
  LlmError,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  type GenerateOptions,
  type ImageAttachmentAccess,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import {
  PiAiAdapter,
  type PiAiAdapterOptions,
  type PiAiRequestHeaderContext,
  type ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import {
  createProvider,
  type Model,
  type ModelInputModality,
  type OpenAICompletionsCompat,
  type Provider,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { CatalogModel } from './shared/types.js'
import { PROVIDER_DISPLAY_NAME, PROVIDER_ID } from './shared/types.js'
import { missingCredentialMessage, type AuthSnapshot } from './auth.js'
import type { CatalogStore } from './catalog.js'
import { buildTracingHeaders } from './shared/trace.js'

/** Chat model api id; must be identical on the model and in its descriptor. */
export const LOOMY_API = 'openai-completions'

/** No per-token pricing is knowable for a points-billed subscription. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Idle timeout for one stream read (upstream can be slow, never silent). */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Request image bounds. The gateway's real limits are unmeasured, so these are
 * the host's conservative pi-ai defaults: 20 MiB of base64 per request, 50
 * occurrences, 4 MiB of pixels, ~1 MiB raw per image.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,
  requestImagePixelBudget: 4 * 1024 * 1024,
  requestImageMaxBytes: 1024 * 1024,
} as const

/**
 * Inert pi-ai credential plane. Loomy authenticates exclusively through the
 * desktop client's session, resolved per request via `resolveApiKey`; pi-ai's
 * own credential lifecycle must never manufacture a credential for this route.
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-loomy: the loomy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
} satisfies PiAiAdapterOptions['auth']

/**
 * Map upstream reasoning efforts onto pi-ai thinking levels.
 *
 * Upstream: `none|low|medium|high|xhigh`. pi-ai additionally knows `minimal`
 * and `max`, which the gateway does not offer; they are explicitly `null` so
 * the selector never advertises a level the request would be rejected for.
 */
export function thinkingLevelMapFor(efforts: readonly string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  }
  for (const effort of efforts) {
    if (effort === 'none') map.off = 'none'
    else if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
      map[effort] = effort
    }
  }
  return map
}

/**
 * The wire compatibility the gateway needs.
 *
 * `max_tokens` is the field the desktop client sends and the one documented in
 * docs/loomy-upstream.md §4.7; the auto-detected default for an unknown host
 * is `max_completion_tokens`, which the evidence run never exercised.
 */
export const LOOMY_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  // Silent truncation detection: pi-ai answers "Stream ended without
  // finish_reason"; dsh-llm-pi-ai classifies that as TRANSPORT (retryable).
  supportsFinishReason: true,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
}

/** Display name that always shows the upstream points multiplier. */
export function displayNameFor(model: CatalogModel): string {
  if (/[（(]\s*[xX×]\s*\d+(?:\.\d+)?\s*[)）]/u.test(model.name)) return model.name
  const rate = Number.isInteger(model.multiplier) ? model.multiplier.toFixed(1) : String(model.multiplier)
  return `${model.name} (x${rate})`
}


/** Convert one catalog entry into a pi-ai chat model descriptor. */
export function toPiModel(model: CatalogModel, baseURL: string): Model<'openai-completions'> {
  const input: ModelInputModality[] = model.vision ? ['text', 'image'] : ['text']
  const reasoning = model.efforts.length > 0
  return {
    id: model.id,
    name: displayNameFor(model),
    api: LOOMY_API,
    provider: PROVIDER_ID,
    baseUrl: baseURL.replace(/\/+$/u, ''),
    input,
    cost: { ...NO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutput,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMapFor(model.efforts) } : {}),
    compat: LOOMY_COMPAT,
  }
}

/** Build one request's tracing headers; exported for tests. */
export function prepareLoomyHeaders(
  request: PiAiRequestHeaderContext,
  headers: Headers,
  version: string,
): Headers {
  if (request.provider !== PROVIDER_ID) return headers
  const tracing = buildTracingHeaders({ version, invokeOrigin: 'user' })
  for (const [name, value] of Object.entries(tracing)) headers.set(name, value)
  return headers
}

/** Everything the plugin needs from the provider half. */
export interface ProviderRuntime {
  adapter: PiAiAdapter
  provider: Provider
  /** Stable profile map (PiAiAdapter memoises its snapshot by map identity). */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
}

/** Dependencies of {@link createProviderRuntime}. */
export interface ProviderDeps {
  catalog: CatalogStore
  baseURL: () => string
  loomyVersion: () => string
  readSession: () => Promise<AuthSnapshot>
  precheck: (
    session: string,
    options?: { force?: boolean },
  ) => Promise<{ ok: boolean; definite: boolean; message?: string }>
  /**
   * Lazily resolve the host's durable attachment service (`ctx.attachments`).
   *
   * Called at most once per inference request that actually carries an image,
   * so the service may be mounted after this plugin without a restart. When the
   * host has no attachment provider, image content is rejected with an
   * actionable `UNSUPPORTED_CONTENT` error instead of the adapter's generic
   * "requires the durable attachment service" failure.
   */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Bridge one durable image reference into the current tool execution world
   * (`ctx.fs.processPathFromHostPath`), so the model receives a readable path
   * beside the inline `data:` URL. Omission is legal: the handle text then says
   * no local path is available.
   */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  logger?: { warn(message: string, error?: unknown): void }
}

/**
 * Why image input cannot be served on a host without an attachment provider.
 *
 * The message names the missing capability and the fix, because the adapter's
 * own text ("pi-ai image input requires the durable attachment service") reads
 * like a plugin bug while the real cause is a profile without the
 * `dsh-attachment-local` bundle.
 */
export const MISSING_ATTACHMENT_SERVICE_MESSAGE =
  '当前 DSH profile 没有提供附件存储服务（ctx.attachments），无法把图片交给 Loomy 模型。请在该 profile 的 bundle 列表中启用 @deepseek-ai/dsh-attachment-local 后重启 DSH，或改用不带图片的对话。'

/** Whether a harness chunk carries user-visible output (empty deltas do not). */
function chunkHasContent(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length > 0
    case 'tool-call-delta':
      return chunk.argumentsDelta.length > 0
    default:
      return false
  }
}

/**
 * The harness adapter with one semantic upgrade at the stream tail.
 *
 * The upstream reports failures as HTTP 200 + a JSON envelope. pi-ai's SSE
 * reader sees no frames, so `dsh-llm-pi-ai` classifies the answer as
 * `TRANSPORT` / "Stream ended without finish_reason" — retryable by category,
 * but indistinguishable from a real truncation. When that terminal chunk is
 * also **empty and free** (no text/reasoning/tool output, `outputTokens === 0`)
 * it is far more likely that the desktop session died just after the cached
 * 60s precheck. In exactly that case we force one `/user/identity` probe and,
 * only if it *definitely* proves the session dead, throw an executable
 * `MISSING_CREDENTIAL` instead of the misleading truncation.
 *
 * A stream that produced output — including the legal `[DONE]`-without-
 * `finish_reason` truncation with text — keeps its original `TRANSPORT`
 * classification and costs no extra probe.
 */
class LoomyAdapter extends PiAiAdapter {
  constructor(
    config: PiAiAdapterOptions,
    private readonly deps: ProviderDeps,
  ) {
    super(config)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.guard(super.stream(options))
  }

  /**
   * The frozen per-step path used by `LlmRuntime` (`prepareCall().stream()`)
   * bypasses `stream()` and calls the adapter's internal snapshot closure, so
   * the upgrade must be applied here too — otherwise the production request
   * path silently loses it while direct `stream()` calls (tests) keep it.
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      stream: (options: GenerateOptions) => this.guard(call.stream(options)),
    }
  }

  private async *guard(upstream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk, void, undefined> {
    let outputTokens = 0
    let contentSeen = false
    try {
      for await (const chunk of upstream) {
        if (chunkHasContent(chunk)) contentSeen = true
        if (chunk.type === 'usage') outputTokens = chunk.usage.outputTokens

        if (
          chunk.type === 'finish' &&
          chunk.reason.kind === 'error' &&
          chunk.reason.failure.code === 'TRANSPORT' &&
          !contentSeen &&
          outputTokens === 0
        ) {
          const upgraded = await this.upgradeAmbiguousTransport()
          if (upgraded !== undefined) throw upgraded
        }
        yield chunk
      }
    } catch (error) {
      throw this.explainAttachmentFailure(error)
    }
  }

  /**
   * Replace the adapter's generic image-capability failure with the reason the
   * host could not serve it.
   *
   * `PiAiAdapter` raises `UNSUPPORTED_CONTENT` / "pi-ai image input requires the
   * durable attachment service" whenever `resolveAttachments()` answered
   * `undefined` (`dsh-llm-pi-ai/lib/index.js:2003`), which reads like a plugin
   * defect although the profile simply mounts no attachment provider. The
   * capability failure for a genuinely text-only model is left untouched.
   */
  private explainAttachmentFailure(error: unknown): unknown {
    if (!(error instanceof LlmError) || error.code !== 'UNSUPPORTED_CONTENT') return error
    if (!error.message.includes('durable attachment service')) return error
    if (this.deps.resolveAttachments?.() !== undefined) return error
    return new LlmError(MISSING_ATTACHMENT_SERVICE_MESSAGE, 'UNSUPPORTED_CONTENT', { cause: error })
  }

  /** One forced probe; returns the executable error only on a definite failure. */
  private async upgradeAmbiguousTransport(): Promise<LlmError | undefined> {
    try {
      const snapshot = await this.deps.readSession()
      if (!snapshot.found || snapshot.session === undefined) return undefined
      const verdict = await this.deps.precheck(snapshot.session, { force: true })
      if (!verdict.definite) return undefined
      return new LlmError(
        verdict.message ??
          `本机 Loomy 登录态已失效（${snapshot.sourcePath}），请在 Loomy 客户端重新登录后重试。`,
        'MISSING_CREDENTIAL',
      )
    } catch (error) {
      // Disambiguation must never replace the original, retryable failure.
      this.deps.logger?.warn('dsh-connect-loomy: forced session precheck failed', error)
      return undefined
    }
  }
}

/** Build the single Loomy pi-ai provider plus its harness adapter. */
export function createProviderRuntime(deps: ProviderDeps): ProviderRuntime {
  const buildModels = (): Model<'openai-completions'>[] => {
    try {
      // Background sync for the inference path: `getModels()` is synchronous
      // and must never throw (pi-ai's Provider contract), so a stale catalog is
      // refreshed fire-and-forget. `kickStaleRefresh()` is single-flight and
      // rate-limited to one attempt per catalog-TTL window, so a failing
      // upstream cannot add a `/models` call to every request. The new list
      // becomes visible on the *next* read; this call still answers from the
      // current cache.
      deps.catalog.kickStaleRefresh()
    } catch (error) {
      deps.logger?.warn('dsh-connect-loomy: could not schedule a catalog refresh', error)
    }
    try {
      return deps.catalog.enabledModels().map((model) => toPiModel(model, deps.baseURL()))
    } catch (error) {
      // Provider.getModels() must never throw; a throw means "no models".
      deps.logger?.warn('dsh-connect-loomy: could not build the model list', error)
      return []
    }
  }

  const provider: Provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'Loomy desktop session',
          // pi-ai funnels the harness' request-level `apiKey` override (the
          // desktop session from `resolveApiKey`) **through this method**:
          // `Models.applyAuth()` treats a falsy resolution as "provider is not
          // configured" and fails the request before any I/O
          // (`@earendil-works/pi-ai/dist/models.js:428-443` +
          // `dist/auth/resolve.js:17-22`). So the override must be echoed
          // back as the resolved auth; returning `undefined` here — the
          // intuitive reading of "inert credential plane" — breaks every
          // inference call. Nothing is ever looked up ambiently, and no pi-ai
          // credential is ever manufactured for this route.
          async resolve({ credential }) {
            const apiKey = credential?.key
            if (apiKey === undefined || apiKey.length === 0) return undefined
            return { auth: { apiKey }, source: 'Loomy desktop session' }
          },
        },
      },
      models: [],
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-loomy retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  // The map identity must stay stable: PiAiAdapter treats a new map as a new
  // configuration snapshot and rebuilds its Models collection on every call.
  // Everything that changes per request (base URL, catalog, selection) is
  // read live by the provider instead.
  const profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[PROVIDER_ID, profile]])

  const adapter = new LoomyAdapter({
    profiles: () => profiles,
    resolveApiKey: async (_provider, _profile) => {
      const snapshot = await deps.readSession()
      if (!snapshot.found || snapshot.session === undefined) {
        throw new LlmError(missingCredentialMessage(snapshot), 'MISSING_CREDENTIAL')
      }
      const verdict = await deps.precheck(snapshot.session)
      if (!verdict.ok && verdict.definite) {
        throw new LlmError(
          verdict.message ?? `Loomy 登录态已失效（${snapshot.sourcePath}），请在 Loomy 客户端重新登录后重试。`,
          'MISSING_CREDENTIAL',
        )
      }
      return snapshot.session
    },
    auth: INERT_AUTH,
    prepareHeaders: (request, headers) => prepareLoomyHeaders(request, headers, deps.loomyVersion()),
    // Without these two hooks every image request fails before I/O: the adapter
    // refuses image content unless it can read the durable attachment back
    // (`dsh-llm-pi-ai/lib/index.js:2003`). They are optional in the host types
    // because not every plugin routes images, but this route declares
    // `input: ['text', 'image']` from upstream capabilities, so both must be
    // present and must resolve lazily (the service may mount later).
    resolveAttachments: () => deps.resolveAttachments?.(),
    ...(deps.resolveImageAccess === undefined
      ? {}
      : {
          resolveImageAccess: (attachments: AttachmentStore, ref: ImageAttachmentRef) =>
            deps.resolveImageAccess?.(attachments, ref),
        }),
  }, deps)

  return { adapter, provider, profiles }
}

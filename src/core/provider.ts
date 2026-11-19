/**
 * The one pi-ai adapter, shared by every vendor.
 *
 * What used to be two ~110-line copies with drifting behaviour is here once:
 * the inert credential plane, the `apiKey` echo trick, the profiles map, the
 * image budgets, per-route providers, the pool accounting wrapper (both
 * `stream()` and `prepareCall().stream()`, because the host only ever calls the
 * latter), the "content must have arrived before a call counts as healthy" rule
 * and the retry-while-nothing-was-yielded loop.
 *
 * A vendor supplies a {@link ChatDriver}: how to build a model descriptor, which
 * headers to add, and (optionally) how to re-classify an ambiguous terminal
 * failure.
 *
 * @module dsh-connect-desktop/core/provider
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type ImageAttachmentAccess,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  PiAiAdapter,
  type PiAiAdapterOptions,
  type ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { CatalogModel } from '../shared/views.js'
import type { ChatDriver, Logger, ResolvedCredential, RouteEntry } from '../vendor-sdk/contracts.js'
import { disqualifiesAccount } from './pool.js'

/** No per-token pricing is knowable for a points-billed subscription. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Idle timeout for one stream read (upstream can be slow, never silent). */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Request image bounds. The gateways' real limits are unmeasured, so these are
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
 * Why image input cannot be served on a host without an attachment provider.
 *
 * The adapter's own text ("pi-ai image input requires the durable attachment
 * service") reads like a plugin bug while the real cause is a profile without
 * the `dsh-attachment-local` bundle, so it is replaced with the fix.
 */
export const MISSING_ATTACHMENT_SERVICE_MESSAGE =
  '当前 DSH profile 没有提供附件存储服务（ctx.attachments），无法把图片交给该模型。请在该 profile 的 bundle 列表中启用 @deepseek-ai/dsh-attachment-local 后重启 DSH，或改用不带图片的对话。'

/** Whether a harness chunk carries user-visible output (empty deltas do not). */
export function chunkHasContent(chunk: StreamChunk): boolean {
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

/** Inert pi-ai credential plane: the token comes from the desktop client only. */
function inertAuth(vendorId: string): PiAiAdapterOptions['auth'] {
  return {
    credentials: {
      async read() {
        return undefined
      },
      async list() {
        return []
      },
      async modify() {
        throw new Error(`dsh-connect-desktop: the ${vendorId} route has no pi-ai credential lifecycle`)
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
  }
}

export interface ChatRuntimeOptions {
  /** Vendor id, for error text and log prefixes. */
  vendorId: string
  chat: ChatDriver
  /** Routes currently installed (first one answers `provider`). */
  routes: () => readonly RouteEntry[]
  /** Base URL, live from configuration. */
  baseUrl: () => string
  /** Resolve the credential for one route; throws `LlmError` when signed out. */
  resolveCredential: (route: string) => Promise<ResolvedCredential>
  /** Enabled models for the installed routes. */
  models: () => readonly CatalogModel[]
  /**
   * Fire-and-forget sync hook, called on every synchronous `getModels()`.
   *
   * pi-ai's `Provider.getModels()` must be synchronous and must never throw, so a
   * stale catalog is refreshed in the background by the catalog itself (which
   * throttles). A throwing hook must not violate that contract.
   */
  onModelsRead?: () => void
  /** One call may try this many accounts while nothing was streamed (default 2). */
  retryLimit?: number
  pool?: {
    markHealthy(id: string): Promise<void>
    markUnavailable(id: string, code: string, message: string): Promise<void>
  }
  /** Vendor-specific disqualifying patterns, appended to the shared list. */
  extraPatterns?: RegExp
  attachments?: () => AttachmentStore | undefined
  imageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  logger?: Logger
}

export interface ChatRuntime {
  adapter: PiAiAdapter
  /** The first route's pi-ai provider (single-route parity). */
  provider: Provider
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Replace the route set; returns what was installed. */
  setRoutes(routes: readonly RouteEntry[]): readonly RouteEntry[]
  routes(): readonly RouteEntry[]
}

/**
 * Pool-aware adapter.
 *
 * Both `stream()` and `prepareCall().stream()` are wrapped: the host calls the
 * latter in production, so wrapping only the former leaves the accounting dead
 * while tests stay green.
 *
 * A call counts as a success only once content actually arrived — an empty
 * stream that ends in an error must not clear a bench, or a broken account would
 * look healthy again just by being picked.
 */
class PoolAdapter extends PiAiAdapter {
  /** Per-call selection, so two concurrent calls cannot spend the same account. */
  readonly callContext = new AsyncLocalStorage<{ accountId?: string }>()

  constructor(
    config: PiAiAdapterOptions,
    private readonly options: {
      isOwnRoute: (provider: string) => boolean
      pool?: ChatRuntimeOptions['pool']
      retryLimit: number
      extraPatterns?: RegExp
      explainAmbiguousFailure?: ChatDriver['explainAmbiguousFailure']
      resolveAttachments?: () => AttachmentStore | undefined
      logger?: Logger
    },
  ) {
    super(config)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const base = super.stream.bind(this)
    return this.wrap(options, () => base(options))
  }

  /**
   * The per-step path the host actually uses.
   *
   * `LlmRuntime` calls `prepareCall().stream()` and never `stream()` directly, so
   * anything wrapped only in `stream()` is dead code in production.
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      stream: (options: GenerateOptions) => this.wrap(options, () => call.stream(options)),
    }
  }

  /**
   * One call, wrapped.
   *
   * `AsyncLocalStorage.run(store, fn)` only covers what `fn` executes
   * synchronously, and an async generator's body runs on the first `next()` —
   * long after `run` returned. Each `next()` is therefore executed *inside* the
   * store, which is what makes the account attribution correct under concurrency.
   */
  private wrap(options: GenerateOptions, invoke: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (!this.options.isOwnRoute(options.provider)) return this.guard(invoke(), undefined)
    const self = this
    const limit = Math.max(1, this.options.retryLimit)
    return (async function* accounted(): AsyncGenerator<StreamChunk, void, undefined> {
      for (let attempt = 1; ; attempt += 1) {
        const context: { accountId?: string } = {}
        let yielded = false
        try {
          const iterator = self.guard(invoke(), context)[Symbol.asyncIterator]()
          for (;;) {
            const step = await self.callContext.run(context, () => iterator.next())
            if (step.done === true) return
            yielded = true
            yield step.value
          }
        } catch (error) {
          // Retry only when nothing reached the user yet: once a delta has been
          // yielded the text is on screen, and replaying it from another account
          // would duplicate the answer mid-sentence. The failed account is
          // already benched by `guard`, so the next pick differs.
          if (yielded || attempt >= limit) throw error
        }
      }
    })()
  }

  private async *guard(
    upstream: AsyncIterable<StreamChunk>,
    context: { accountId?: string } | undefined,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    let outputTokens = 0
    let contentSeen = false
    let finishFailure: { code: string; message: string } | undefined
    try {
      for await (const chunk of upstream) {
        if (chunkHasContent(chunk)) contentSeen = true
        if (chunk.type === 'usage') outputTokens = chunk.usage.outputTokens
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          finishFailure = { code: chunk.reason.failure.code, message: chunk.reason.failure.message }
          // An ambiguous, empty, free terminal failure is far more likely to be
          // a dead session than a truncation. The vendor decides whether it can
          // prove that; when it can, the misclassification is replaced.
          if (
            chunk.reason.failure.code === 'TRANSPORT' &&
            !contentSeen &&
            outputTokens === 0 &&
            this.options.explainAmbiguousFailure !== undefined
          ) {
            const upgraded = await this.options.explainAmbiguousFailure()
            if (upgraded !== undefined) throw upgraded
          }
        }
        yield chunk
      }
      const id = context?.accountId
      if (id !== undefined) {
        if (finishFailure !== undefined) {
          if (finishFailure.code === 'MISSING_CREDENTIAL' || disqualifiesAccount(finishFailure.message, this.options.extraPatterns)) {
            await this.options.pool?.markUnavailable(id, finishFailure.code, finishFailure.message).catch(() => undefined)
          }
        } else if (contentSeen) {
          await this.options.pool?.markHealthy(id).catch(() => undefined)
        }
      }
    } catch (error) {
      const id = context?.accountId
      if (id !== undefined) {
        const message = error instanceof Error ? error.message : String(error)
        const carried = (error as { code?: unknown } | null)?.code
        const code =
          error instanceof LlmError
            ? error.code
            : typeof carried === 'string' && carried.length > 0
              ? carried
              : 'CALL_FAILED'
        // The code is authoritative: MISSING_CREDENTIAL means "this account
        // cannot work", whatever wording the message happens to carry.
        if (code === 'MISSING_CREDENTIAL' || disqualifiesAccount(message, this.options.extraPatterns)) {
          await this.options.pool?.markUnavailable(id, code, message).catch(() => undefined)
        }
      }
      throw this.explainAttachmentFailure(error)
    }
  }

  private explainAttachmentFailure(error: unknown): unknown {
    if (!(error instanceof LlmError) || error.code !== 'UNSUPPORTED_CONTENT') return error
    if (!error.message.includes('durable attachment service')) return error
    if (this.options.resolveAttachments?.() !== undefined) return error
    return new LlmError(MISSING_ATTACHMENT_SERVICE_MESSAGE, 'UNSUPPORTED_CONTENT', { cause: error })
  }

  /** The account id parked in the async context by the current call. */
  currentAccountId(): string | undefined {
    return this.callContext.getStore()?.accountId
  }
}

/** Build the pi-ai runtime for one vendor. */
export function createChatRuntime(options: ChatRuntimeOptions): ChatRuntime {
  let routes: readonly RouteEntry[] = options.routes()
  const routeSet = (): Set<string> => new Set(routes.map((entry) => entry.route))
  const providers = new Map<string, Provider>()

  const buildProvider = (route: string, displayName: string): Provider =>
    ({
      ...createProvider({
        id: route,
        name: displayName,
        auth: {
          apiKey: {
            name: options.chat.credentialName ?? 'Desktop session',
            // pi-ai funnels the harness' request-level `apiKey` override (the
            // token from `resolveApiKey`) **through this method**:
            // `Models.applyAuth()` treats a falsy resolution as "provider is not
            // configured" and fails before any I/O. So the override must be
            // echoed back; returning `undefined` — the intuitive reading of
            // "inert credential plane" — breaks every inference call.
            async resolve({ credential }) {
              const apiKey = credential?.key
              if (apiKey === undefined || apiKey.length === 0) return undefined
              return { auth: { apiKey }, source: options.chat.credentialName ?? 'Desktop session' }
            },
          },
        },
        models: [],
        api: openAICompletionsApi(),
      }),
      getModels: () => {
        try {
          options.onModelsRead?.()
        } catch (error) {
          options.logger?.warn('dsh-connect-desktop: could not schedule a catalog refresh', error)
        }
        try {
          return (options.models() as CatalogModel[]).map((model) =>
            options.chat.toModel(model, { baseUrl: options.baseUrl(), route }),
          )
        } catch (error) {
          // `Provider.getModels()` must never throw; a throw means "no models".
          options.logger?.warn(`dsh-connect-desktop: could not build ${route} models`, error)
          return []
        }
      },
    }) as Provider

  const providerFor = (route: string, displayName: string): Provider => {
    let provider = providers.get(route)
    if (provider === undefined) {
      provider = buildProvider(route, displayName)
      providers.set(route, provider)
    }
    return provider
  }

  const buildProfiles = (entries: readonly RouteEntry[]): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const next = new Map<string, ResolvedPiAiProviderProfile>()
    for (const entry of entries) {
      next.set(entry.route, {
        provider: entry.route,
        displayName: entry.displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, `dsh-connect-desktop ${options.vendorId} retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: providerFor(entry.route, entry.displayName),
      })
    }
    return next
  }

  let profiles = buildProfiles(routes)
  let adapterRef: PoolAdapter | undefined

  const adapter = new PoolAdapter(
    {
      // A new Map instance is what tells PiAiAdapter its snapshot is stale; an
      // unchanged map is recognised by identity and costs nothing.
      profiles: () => profiles,
      resolveApiKey: async (route) => {
        const credential = await options.resolveCredential(route)
        // Attribute this call to its account so a failure can bench it.
        const context = adapterRef?.callContext.getStore()
        if (context !== undefined && credential.accountId !== undefined) context.accountId = credential.accountId
        if (credential.material.length === 0) {
          throw new LlmError(credential.problem ?? '没有可用的登录态。', 'MISSING_CREDENTIAL')
        }
        return credential.material
      },
      auth: inertAuth(options.vendorId),
      prepareHeaders: (request, headers) => options.chat.prepareHeaders(request, headers),
      ...(options.attachments === undefined ? {} : { resolveAttachments: options.attachments }),
      ...(options.imageAccess === undefined
        ? {}
        : {
            resolveImageAccess: (attachments: AttachmentStore, ref: ImageAttachmentRef) =>
              options.imageAccess?.(attachments, ref),
          }),
    },
    {
      isOwnRoute: (provider) => routeSet().has(provider),
      ...(options.pool === undefined ? {} : { pool: options.pool }),
      retryLimit: options.retryLimit ?? 2,
      ...(options.extraPatterns === undefined ? {} : { extraPatterns: options.extraPatterns }),
      ...(options.chat.explainAmbiguousFailure === undefined
        ? {}
        : { explainAmbiguousFailure: options.chat.explainAmbiguousFailure }),
      ...(options.attachments === undefined ? {} : { resolveAttachments: options.attachments }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
  )
  adapterRef = adapter

  return {
    adapter,
    get provider(): Provider {
      const first = routes[0]
      return providerFor(first?.route ?? options.vendorId, first?.displayName ?? options.vendorId)
    },
    get profiles() {
      return profiles
    },
    setRoutes(next) {
      // Drop memoised providers for routes that no longer exist, so a removed
      // account cannot keep answering from a stale closure.
      const keep = new Set(next.map((entry) => entry.route))
      for (const route of [...providers.keys()]) if (!keep.has(route)) providers.delete(route)
      routes = [...next]
      profiles = buildProfiles(routes)
      return routes
    },
    routes() {
      return routes
    },
  }
}

export { NO_COST, STREAM_IDLE_TIMEOUT_MS, REQUEST_IMAGE_BUDGETS }

/**
 * Loomy 的对话协议：模型描述符、请求头、推理档位映射。
 *
 * 适配器本身（pi-ai 的 profile 装配、池记账、并发归属、重试、"有内容才算成功"）
 * 在 `core/provider.ts` 里**只实现一次**。这里只留下"只有 Loomy 才知道"的部分：
 *
 * - **只注册目录里的模型。** `getModels()` 由 core 从目录读取；上游对未知 id 会
 *   静默回落到 `spark-x2.6` 并照常扣费，所以目录外的模型必须在本地就失败。
 * - **模型身份就是路由 id。** `model.provider === 'loomy' === provider.id`，历史
 *   消息里的 `isSameModel`（provider + api + model.id）才能跨轮成立。
 * - **api 串恒为 `openai-completions`**，线协议字段由 `compat` 钉死：`max_tokens`
 *   是网关文档里的字段，`store`/`developer` 角色不发送，`reasoning_effort` 可用。
 *
 * @module dsh-connect-desktop/vendors/loomy/provider
 */

import type {
  Model,
  ModelInputModality,
  OpenAICompletionsCompat,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'
import type { PiAiRequestHeaderContext } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CatalogModel } from '../../shared/views.js'
import { buildTracingHeaders } from '../../shared/trace.js'
import { DISPLAY_NAME, LOOMY_API, PROVIDER_ID } from './constants.js'
import { isOurRoute } from './accounts.js'

/** 没有可用的按 token 计价信息：这是点数计费的订阅。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

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
export function toPiModel(
  model: CatalogModel,
  baseURL: string,
  route: string = PROVIDER_ID,
): Model<'openai-completions'> {
  const input: ModelInputModality[] = model.vision ? ['text', 'image'] : ['text']
  const reasoning = model.efforts.length > 0
  return {
    id: model.id,
    name: displayNameFor(model),
    api: LOOMY_API,
    provider: route,
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
  if (!isOurRoute(request.provider)) return headers
  const tracing = buildTracingHeaders({ version, invokeOrigin: 'user' })
  for (const [name, value] of Object.entries(tracing)) headers.set(name, value)
  return headers
}

/** Everything the plugin needs from the provider half. */

// ── 测试接缝：一套 deps 直接装出 runtime ────────────────────────────────────
//
// 生产路径是 `core/registry.ts` 装配 `core/provider.ts`；这里的工厂只为测试与
// 嵌入方保留同形状入口，避免 20 多个"适配器行为"测试各自重搭 dev 装配。
// 它**不做任何业务判断**：身份选择仍然通过 `deps.sessionForRoute`/`readSession`
// 交给调用方，与生产一致。

import { createChatRuntime, type ChatRuntime } from '../../core/provider.js'
import type { AccountPool } from '../../core/pool.js'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
import type { ChatDriver, RouteEntry } from '../../vendor-sdk/contracts.js'
import type { AuthSnapshot } from './auth.js'
import { routeDisplayName } from './accounts.js'
export interface ProviderRuntime {
  adapter: ChatRuntime['adapter']
  provider: Provider
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  setRoutes(routes: readonly RouteEntry[]): readonly RouteEntry[]
  routes(): readonly RouteEntry[]
}

export interface ProviderDeps {
  catalog: {
    enabledModels(): readonly CatalogModel[]
    kickStaleRefresh?(): void
  }
  baseURL: () => string
  loomyVersion: () => string
  readSession: () => Promise<AuthSnapshot>
  sessionForRoute?: (route: string) => Promise<AuthSnapshot>
  pool?: Pick<AccountPool, 'markHealthy' | 'markUnavailable'>
  poolRetryLimit?: number
  precheck: (session: string, options?: { force?: boolean }) => Promise<{ ok: boolean; definite: boolean; message?: string }>
  resolveAttachments?: () => AttachmentStore | undefined
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  logger?: { warn(message: string, error?: unknown): void }
}

const DEFAULT_ROUTE: RouteEntry = { route: PROVIDER_ID, displayName: DISPLAY_NAME }

export function createProviderRuntime(deps: ProviderDeps): ProviderRuntime {
  const readFor = async (route: string): Promise<AuthSnapshot> =>
    deps.sessionForRoute === undefined ? deps.readSession() : deps.sessionForRoute(route)

  let routes: readonly RouteEntry[] = [DEFAULT_ROUTE]

  const chat: ChatDriver = {
    api: 'openai-completions',
    compat: LOOMY_COMPAT,
    credentialName: 'Loomy desktop session',
    toModel: (model, context) => toPiModel(model, context.baseUrl, context.route),
    prepareHeaders: (request, headers) => prepareLoomyHeaders(request, headers, deps.loomyVersion()),
    async explainAmbiguousFailure() {
      try {
        const snapshot = await deps.readSession()
        if (!snapshot.found || snapshot.session === undefined) return undefined
        const verdict = await deps.precheck(snapshot.session, { force: true })
        if (!verdict.definite) return undefined
        return new LlmError(verdict.message ?? `本机 Loomy 登录态已失效（${snapshot.sourcePath}）`, 'MISSING_CREDENTIAL')
      } catch (error) {
        deps.logger?.warn('dsh-connect-desktop: forced session precheck failed', error)
        return undefined
      }
    },
  }

  const runtime = createChatRuntime({
    vendorId: PROVIDER_ID,
    chat,
    routes: () => routes,
    baseUrl: deps.baseURL,
    models: () => deps.catalog.enabledModels(),
    onModelsRead: () => deps.catalog.kickStaleRefresh?.(),
    resolveCredential: async (route) => {
      const snapshot = await readFor(route)
      if (snapshot.found && snapshot.session !== undefined) {
        const verdict = await deps.precheck(snapshot.session)
        if (!verdict.ok && verdict.definite) {
          throw new LlmError(verdict.message ?? 'Loomy 登录态已失效', 'MISSING_CREDENTIAL')
        }
        return { material: snapshot.session, ...(snapshot.sourceAccountId === undefined ? {} : { accountId: snapshot.sourceAccountId }) }
      }
      if (snapshot.sourceAccountId !== undefined) {
        await deps.pool?.markUnavailable(snapshot.sourceAccountId, 'MISSING_CREDENTIAL', snapshot.problem ?? 'missing')
      }
      throw new LlmError(snapshot.problem ?? `未找到 Loomy 登录态（${snapshot.sourcePath}）`, 'MISSING_CREDENTIAL')
    },
    retryLimit: deps.poolRetryLimit ?? 2,
    ...(deps.pool === undefined ? {} : { pool: deps.pool }),
    ...(deps.resolveAttachments === undefined ? {} : { attachments: deps.resolveAttachments }),
    ...(deps.resolveImageAccess === undefined ? {} : { imageAccess: deps.resolveImageAccess }),
    ...(deps.logger === undefined ? {} : { logger: { info: () => {}, warn: deps.logger.warn, error: deps.logger.warn } }),
  })

  return {
    adapter: runtime.adapter,
    get provider(): Provider {
      return runtime.provider
    },
    get profiles() {
      return runtime.profiles
    },
    setRoutes(next) {
      routes = [...next]
      return runtime.setRoutes(routes)
    },
    routes: () => routes,
  }
}

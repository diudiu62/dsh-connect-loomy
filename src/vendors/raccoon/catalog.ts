/**
 * 小浣熊模型目录：抓取 + 归一化。**缓存、选择、能力覆盖、失败记录都不在这里**
 * ——它们在 `src/core/catalog.ts` 的 `createCatalogStore` 里，对所有供应商只有
 * 一份。本文件只回答"这一次上游说了什么"。
 *
 * 实测响应（2026-11-17，客户端 `2.0.0`）：
 *
 * ```json
 * {"code":0,"message":"success","data":{"categories":[{"type":"chat",
 *   "default_model":"raccoon-090dd3","models":[{
 *     "name":"sn-glm-5-3-flash","description":"GLM-5-3-Flash",
 *     "display_description":"…","visible":true,
 *     "tags":["general","chat","vision","auto"],
 *     "ability_level":1,
 *     "params":{"raccoon_thinking":{…},"context_window":1000000,"max_tokens":100000},
 *     "billing_multiplier":0.2,"billing_effective_multiplier":0.2,
 *     "billing_status":"normal","billing_status_note":"","billing_discounts":[]}]}]}}
 * ```
 *
 * 两个决定，都有实测依据：
 *
 * 1. **`visible:false` 行丢掉。** 它们是桌面端自己的 agent 路由
 *    （`raccoon-090dd3`、`raccoon-19b265`…）：用户在 app 里根本看不到，在这里
 *    提供就等于把点数花在一个我们无法描述行为的调度器上。
 * 2. **不宣告思考等级。** 目录里解析出 `params.raccoon_thinking.display_levels`
 *    （`level_1`…`level_5`）是 app 自己 UI 用的，但网关**完全不校验**
 *    `reasoning_effort`：`low`、`level_1` 和字面量 `banana` 都回 HTTP 200
 *    （2026-11-17 实测）。基于一个被忽略的字段做下拉框是撒谎，所以 `efforts`
 *    恒为空、`defaultEffort` 恒为空串，路由也声明 `supportsReasoningEffort: false`。
 *
 * @module dsh-connect-desktop/vendors/raccoon/catalog
 */

import type { CatalogModel } from '../../shared/views.js'
import {
  DEFAULT_RACCOON_BASE_URL,
  RACCOON_CLIENT_PLATFORM,
  RACCOON_FALLBACK_CONTEXT,
  RACCOON_FALLBACK_MAX_OUTPUT,
  RACCOON_OK_CODE,
  RACCOON_TIMEOUT_MS,
} from './constants.js'

/** 无论 tags 如何都不能提供出去的模型前缀（桌面端内部 agent 路由）。 */
const INTERNAL_MODEL_PREFIX = 'raccoon-'

/** 表示"网关这里接受图片"的 tag。 */
const VISION_TAG = 'vision'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 解析一行目录条目；不可用（内部路由、隐藏、无 id）时返回 `undefined`。 */
export function parseModel(raw: unknown): CatalogModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = nonEmptyString(raw['model_name']) ?? nonEmptyString(raw['name'])
  if (id === undefined) return undefined
  if (id.startsWith(INTERNAL_MODEL_PREFIX)) return undefined
  if (raw['visible'] === false) return undefined

  const params = isRecord(raw['params']) ? raw['params'] : {}
  const tags = Array.isArray(raw['tags'])
    ? raw['tags'].filter((tag): tag is string => typeof tag === 'string')
    : []
  const multiplier = raw['billing_effective_multiplier'] ?? raw['billing_multiplier']
  return {
    id,
    name: nonEmptyString(raw['description']) ?? id,
    multiplier: typeof multiplier === 'number' && Number.isFinite(multiplier) ? multiplier : 1,
    contextWindow: positiveInt(params['context_window'], RACCOON_FALLBACK_CONTEXT),
    maxOutput: positiveInt(params['max_tokens'], RACCOON_FALLBACK_MAX_OUTPUT),
    vision: tags.includes(VISION_TAG),
    // 故意为空：见文件头（网关忽略这个字段）。
    efforts: [],
    defaultEffort: '',
  }
}

/** 从一个 `model_catalog` 成功响应里取出 chat 模型。 */
export function parseCatalog(body: unknown): CatalogModel[] {
  if (!isRecord(body)) return []
  const data = body['data']
  if (!isRecord(data)) return []
  const categories = data['categories']
  if (!Array.isArray(categories)) return []
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const category of categories) {
    if (!isRecord(category)) continue
    if (category['type'] !== 'chat') continue
    const rows = category['models']
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      const model = parseModel(row)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

/** 桌面端每次 API 调用都会带的请求头。 */
export function raccoonHeaders(
  token: string,
  options: { orgCode?: string; clientVersion?: string; deviceId?: string; requestId?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Client-Platform': RACCOON_CLIENT_PLATFORM,
  }
  if (options.orgCode !== undefined && options.orgCode.length > 0) headers['X-Org-Code'] = options.orgCode
  if (options.clientVersion !== undefined) headers['X-Client-Version'] = options.clientVersion
  if (options.deviceId !== undefined) headers['X-Client-Device-ID'] = options.deviceId
  if (options.requestId !== undefined) headers['X-Request-Id'] = options.requestId
  return headers
}

/**
 * 上游失败，已脱敏。
 *
 * 带 `code` 是有原因的：`core/catalog.ts`、`core/credits.ts` 用 `error.code`
 * 记录失败类别，卡片上"最近一次上游错误"就直接是它。
 */
export class RaccoonError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RaccoonError'
  }
}

/** 抓一次线上目录。失败必抛（绝不返回空目录冒充成功）。 */
export async function fetchCatalog(options: {
  baseURL?: string
  token: string
  orgCode?: string
  clientVersion?: string
  deviceId?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<CatalogModel[]> {
  const baseURL = (options.baseURL ?? DEFAULT_RACCOON_BASE_URL).replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RACCOON_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${baseURL}/model_catalog`, {
      method: 'GET',
      headers: raccoonHeaders(options.token, {
        ...(options.orgCode === undefined ? {} : { orgCode: options.orgCode }),
        ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
        ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new RaccoonError(
        `小浣熊模型目录请求失败（HTTP ${response.status}）：${text.slice(0, 200)}`,
        'catalog_http',
        response.status,
      )
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new RaccoonError('小浣熊模型目录返回的不是 JSON', 'catalog_parse')
    }
    if (!isRecord(body) || body['code'] !== RACCOON_OK_CODE) {
      const message = isRecord(body) ? nonEmptyString(body['message']) ?? '未知错误' : '未知错误'
      throw new RaccoonError(`小浣熊模型目录返回错误：${message}`, 'catalog_code')
    }
    const models = parseCatalog(body)
    if (models.length === 0) throw new RaccoonError('小浣熊模型目录为空', 'catalog_empty')
    return models
  } finally {
    clearTimeout(timer)
  }
}

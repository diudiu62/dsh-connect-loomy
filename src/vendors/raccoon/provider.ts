/**
 * 小浣熊的 pi-ai 聊天驱动：**只实现协议**，不实现适配器。
 *
 * 这里的一切都是一条实测事实的推论：桌面端自己就是一个 OpenAI 兼容客户端
 * （`resources/default-llm-config.json` 里 `provider: "openai"` 打
 * `…/api/web/llm/v2`），所以不需要任何协议改写——只需要正确的请求头、正确的
 * wire 字段名，以及一份诚实的能力声明。
 *
 * 适配器（`PiAiAdapter`、profiles、图片预算、池记账、内容才算成功、未输出才重试）
 * 全部在 `src/core/provider.ts` 里，对所有供应商只有一份。本文件只提供
 * {@link ChatDriver}：`toModel` + `prepareHeaders`。
 *
 * 请求头对齐安装的桌面端（asar 反编译，2026-11-23）：
 *
 * | 头 | 官方值 | 说明 |
 * |---|---|---|
 * | `X-Client-Platform` | `desktop-macos` / `-windows` / `-linux` | 主进程按 `process.platform` 映射 |
 * | `X-Client-Version` | `app.getVersion()`（本机 `1.2.0`） | 运行时从 app.asar 读 |
 * | `X-Client-Device-ID` | `clientDeviceId` | 逐账号，不再全池共用 |
 * | `X-Client-Name` | `raccoon-work` | `package.json` 的 `clientName` |
 * | `X-Client-Page` | `background` | 无页面上下文时的兜底值 |
 *
 * 这些头**不是**鉴权（官方本地中继转发时只发 `authorization` + `content-type`），
 * 但它们正是上游风控给流量归档的字段：缺一个，插件就是在自报"我不是官方客户端"。
 *
 * @module dsh-connect-desktop/vendors/raccoon/provider
 */

import type { PiAiRequestHeaderContext } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Model, ModelInputModality } from '@earendil-works/pi-ai'
import type { CatalogModel } from '../../shared/views.js'
import type { ChatDriver, VendorHeaderContext } from '../../vendor-sdk/contracts.js'
import {
  RACCOON_API,
  RACCOON_CLIENT_NAME,
  RACCOON_CLIENT_PAGE,
  RACCOON_COMPAT,
  RACCOON_CREDENTIAL_NAME,
  RACCOON_PROVIDER_ID,
  raccoonClientPlatform,
} from './constants.js'

/** 按点数计费的订阅制，没有任何可知道的每 token 价格。 */
const NO_COST = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } as const

/**
 * 显示名：带上倍率，因为这个供应商的每个模型都是点数计费的。
 *
 * 整数倍率补两位小数（`x1.00`），非整数原样（`x0.2`），避免选择器里出现
 * `x0.20000000000000001` 或 `x1` 与 `x1.0` 混排。
 */
export function raccoonDisplayName(model: CatalogModel): string {
  const rate = Number.isInteger(model.multiplier) ? model.multiplier.toFixed(2) : String(model.multiplier)
  return `${model.name} · x${rate}`
}

/**
 * 把一个目录条目转成 pi-ai 的 model 描述符。
 *
 * `reasoning: false` 是**恒等**的，不是从目录推的：网关不校验 `reasoning_effort`，
 * 见 `catalog.ts` 文件头。
 */
export function toPiModel(model: CatalogModel, baseURL: string): Model<'openai-completions'> {
  const input: ModelInputModality[] = model.vision ? ['text', 'image'] : ['text']
  return {
    id: model.id,
    name: raccoonDisplayName(model),
    api: RACCOON_API,
    provider: RACCOON_PROVIDER_ID,
    baseUrl: baseURL.replace(/\/+$/u, ''),
    input,
    cost: { ...NO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutput,
    reasoning: false,
    compat: RACCOON_COMPAT,
  }
}

/** 加上网关要求的客户端身份头（只对 `raccoon` 这条路由生效）。 */
export function prepareRaccoonHeaders(
  request: PiAiRequestHeaderContext,
  headers: Headers,
  options: { clientVersion?: string; deviceId?: string; clientName?: string; clientPage?: string } = {},
): Headers {
  if (request.provider !== RACCOON_PROVIDER_ID) return headers
  headers.set('X-Client-Platform', raccoonClientPlatform())
  headers.set('X-Client-Name', options.clientName ?? RACCOON_CLIENT_NAME)
  headers.set('X-Client-Page', options.clientPage ?? RACCOON_CLIENT_PAGE)
  if (options.clientVersion !== undefined && options.clientVersion.length > 0) {
    headers.set('X-Client-Version', options.clientVersion)
  }
  if (options.deviceId !== undefined && options.deviceId.length > 0) {
    headers.set('X-Client-Device-ID', options.deviceId)
  }
  return headers
}

/** 构建 {@link ChatDriver} 需要的活配置（每次请求现读，设置一改就生效）。 */
export interface RaccoonChatDriverOptions {
  /** `X-Client-Version` 的来源。 */
  clientVersion: () => string
  /** `X-Client-Name` 的来源（`package.json` 的 `clientName`）。 */
  clientName?: () => string
  /**
   * `X-Client-Device-ID` 的来源。
   *
   * 收到 `context.deviceId`（本次调用所选账号自己的 uuid）时用它；没有账号上下文
   * （目录/余额这种聚合读取）才退回桌面端那一份。**不要**退回"一个全局值"——
   * 九个账号共用一个设备指纹正是 2026-11-23 `200108` 连环限流的画像。
   */
  deviceId: (context?: VendorHeaderContext) => string | undefined
}

/** 小浣熊的 {@link ChatDriver}：模型转换 + 请求头，仅此而已。 */
export function createRaccoonChatDriver(options: RaccoonChatDriverOptions): ChatDriver {
  return {
    api: 'openai-completions',
    compat: RACCOON_COMPAT,
    credentialName: RACCOON_CREDENTIAL_NAME,
    toModel: (model, context) => toPiModel(model, context.baseUrl),
    prepareHeaders: (request, headers, context) => {
      const deviceId = options.deviceId(context)
      return prepareRaccoonHeaders(request, headers, {
        clientVersion: options.clientVersion(),
        clientName: options.clientName?.() ?? RACCOON_CLIENT_NAME,
        ...(deviceId === undefined ? {} : { deviceId }),
      })
    },
  }
}

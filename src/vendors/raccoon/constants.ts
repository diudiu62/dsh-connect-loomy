/**
 * 小浣熊（商汤 Raccoon）的线缆常量，全部对着桌面端 `2.0.0`（2026-11-17）实测过。
 * 证据见 `docs/raccoon-upstream.md`。
 *
 * 这里只放**协议事实**：id、URL、超时、成功码、wire 兼容位。任何"怎么用"的逻辑
 * （缓存、路由、账号、视图）都在 `src/core` 里，本文件不依赖它。
 *
 * @module dsh-connect-desktop/vendors/raccoon/constants
 */

import type { OpenAICompletionsCompat } from '@earendil-works/pi-ai'

/** pi-ai provider id（= 路由 id = descriptor id）。冻结：模型身份依赖它。 */
export const RACCOON_PROVIDER_ID = 'raccoon'

/** 模型选择器里的分组名（路由 displayName，也是账号行的 displayName）。 */
export const RACCOON_DISPLAY_NAME = '小浣熊'

/** 设置卡片上的供应商名（比分组名正式一点，和 README 对齐）。 */
export const RACCOON_VENDOR_NAME = '商汤小浣熊'

/** 桌面端自己使用的 OpenAI 兼容 base URL。 */
export const DEFAULT_RACCOON_BASE_URL = 'https://xiaohuanxiong.com/api/web/llm/v2'

/** 只读积分余额接口。 */
export const DEFAULT_RACCOON_POINTS_URL = 'https://xiaohuanxiong.com/api/web/points/v1/balance'

/** `X-Client-Platform` 的取值，桌面端就是这么发的。 */
export const RACCOON_CLIENT_PLATFORM = 'desktop'

/** `X-Client-Version` 兜底值（实测的 app 版本，2026-11-10）。 */
export const DEFAULT_RACCOON_CLIENT_VERSION = '2.0.0'

/** 目录里缺 `params.context_window` 时的兜底上下文档位。 */
export const RACCOON_FALLBACK_CONTEXT = 128_000

/** 目录里缺 `params.max_tokens` 时的兜底输出上限。 */
export const RACCOON_FALLBACK_MAX_OUTPUT = 8_192

/** 目录缓存 TTL：目录很小、很少变。 */
export const DEFAULT_RACCOON_CATALOG_TTL_MS = 600_000

/** 积分缓存 TTL。 */
export const DEFAULT_RACCOON_CREDITS_TTL_MS = 60_000

/** 单次上游调用的超时。 */
export const RACCOON_TIMEOUT_MS = 20_000

/** 上游成功码（信封是 `{code, message, data}`，`code === 0` 才是成功）。 */
export const RACCOON_OK_CODE = 0

/** 登录接口的默认国家码（与桌面端的默认值一致）。 */
export const DEFAULT_RACCOON_NATION_CODE = '86'

/** Chat api id；必须与每个 model 描述符里的值完全一致。 */
export const RACCOON_API = 'openai-completions'

/** pi-ai 凭据显示名（"未配置"文案里出现）。 */
export const RACCOON_CREDENTIAL_NAME = '小浣熊桌面端登录态'

/**
 * Raccoon 网关需要的 wire 兼容位。
 *
 * 两条实测结论：
 *
 * 1. **`max_tokens`**：桌面端发的是 `max_tokens`，pi-ai 对未知宿主自动探测出的
 *    默认值是 `max_completion_tokens`，所以这里钉死。
 * 2. **`supportsReasoningEffort: false`**：网关根本不校验 `reasoning_effort`
 *    （`low`、`level_1`、字面量 `banana` 都回 200），做一个下拉框只是装饰；
 *    思考内容仍然通过 `delta.reasoning_content` 回来，pi-ai 自己映射。
 */
export const RACCOON_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
}

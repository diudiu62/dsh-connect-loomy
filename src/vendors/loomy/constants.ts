/**
 * Loomy 的冻结身份、路由命名空间与配置片。
 *
 * 这里只放"一旦发布就不能再变"的值：
 *
 * - `PROVIDER_ID` 进入 pi-ai 的模型身份（`provider` + `api` + model id），历史
 *   消息里已经持久化，改名会让旧会话看起来来自一个不存在的模型；
 * - `POOL_ROUTE` 是旧 slots 形态的池路由（现已不再生成，见其自身注释）；
 * - 配置字段名与默认值属于用户已经写进 settings 的数据，改名等于让他的配置丢失。
 *
 * 上游客（协议）常量同理：base URL、`loomy-version`、`api` 字符串都是抓包证据的一部分
 * （docs/loomy-upstream.md），不是可调项。
 *
 * @module dsh-connect-desktop/vendors/loomy/constants
 */

import z from '@deepseek-ai/schemastery'
import type { CreditField } from '../../shared/views.js'
import type { ConfigGroupDeclaration } from '../../vendor-sdk/contracts.js'
import { DEFAULT_CATALOG_TTL_MS, DEFAULT_CREDITS_TTL_MS, DEFAULT_SESSION_TTL_MS } from '../../shared/views.js'

/** 供应商 id；同时是 pi-ai 的 provider id 与模型身份的一部分。**永不改**。 */
export const PROVIDER_ID = 'loomy'

/** 模型选择器与设置卡片上的显示名。 */
export const DISPLAY_NAME = 'Loomy'

/** 旧名别名（大量文档与测试使用这个拼写）。 */
export const PROVIDER_DISPLAY_NAME = DISPLAY_NAME

/** 卡片框架用的品牌色（讯飞系蓝）。 */
export const ACCENT = '#2E6BE6'

/** Loomy 平台 API 基地址（桌面端自己用的那个，含 `/api/v1`）。 */
export const DEFAULT_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'

/** 对话请求携带的 `loomy-version`；服务端并不校验，但客户端始终发送。 */
export const DEFAULT_LOOMY_VERSION = '0.9.39'

/** 对话模型 api id；模型描述符与本字段必须完全一致。 */
export const LOOMY_API = 'openai-completions'

/**
 * 旧的池路由 id（`loomy-pool`）。
 *
 * 现在 Loomy 是 `routeMode: 'single'`：路由集合只有 `loomy` 一条，轮换由
 * 「随机池」开关在**每次调用**时决定，所以不再需要一条单独的池路由。常量保留
 * 是因为它是已发布的身份（历史消息、导出包、外部脚本都可能引用），删掉等于
 * 让那些引用指向一个不存在的名字。
 */
export const POOL_ROUTE = `${PROVIDER_ID}-pool`

/** 登录态预检（`/user/identity`）结果的复用窗口。 */
export const DEFAULT_PRECHECK_TTL_MS = 60_000

/** 服务端把 `pageSize` 夹到 100（docs/loomy-upstream.md §3.2）。 */
export const MAX_CREDITS_PAGE_SIZE = 100

/** 积分流水默认条数。 */
export const DEFAULT_CREDITS_PAGE_SIZE = 20

/** 平台接口的鉴权头名（**不是** `Authorization: Bearer`）。 */
export const PLATFORM_TOKEN_HEADER = 'token'

export {
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_CREDITS_TTL_MS,
}

/**
 * 积分展示的三个桶。
 *
 * `key` 是 `CreditsView.fields` 里的键，也是 core 做逐账号求和时的键；`labelKey`
 * 由客户端翻译。顺序即卡片上的顺序，`available` 是主数字。
 */
export const CREDIT_FIELDS: readonly CreditField[] = [
  { key: 'available', labelKey: 'credits.field.available', role: 'available' },
  { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
  { key: 'total', labelKey: 'credits.field.total', role: 'total' },
]

/**
 * Loomy 自己那一片配置。
 *
 * 每个字段都在 core 侧用 `deps.setting()` **实时**读取，所以改配置立刻生效，不需要
 * 重启插件。`.volatile()` 由 core 负责解包，这里不写。
 */
export const LOOMY_CONFIG_SCHEMA = z.object({
  /** 供应商级开关；core 用它决定要不要注册路由与 provider。 */
  enabled: z.boolean().default(true).description('启用 Loomy 模型接入'),
  baseURL: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description('Loomy 平台 API 基地址（含 /api/v1）'),
  loomyVersion: z
    .string()
    .default(DEFAULT_LOOMY_VERSION)
    .description('对话请求的 loomy-version 头（当前客户端 0.9.39）'),
  sessionTtlMs: z
    .number()
    .min(0)
    .step(1000)
    .default(DEFAULT_SESSION_TTL_MS)
    .description('登录态文件重读间隔（毫秒）'),
  precheckTtlMs: z
    .number()
    .min(0)
    .step(1000)
    .default(DEFAULT_PRECHECK_TTL_MS)
    .description('登录态上游预检结果缓存时长（毫秒）'),
  catalogTtlMs: z
    .number()
    .min(0)
    .step(1000)
    .default(DEFAULT_CATALOG_TTL_MS)
    .description('模型目录缓存时长（毫秒，0=每次都刷新）'),
  creditsTtlMs: z
    .number()
    .min(0)
    .step(1000)
    .default(DEFAULT_CREDITS_TTL_MS)
    .description('只读积分缓存时长（毫秒）'),
  creditsPageSize: z
    .number()
    .min(1)
    .max(MAX_CREDITS_PAGE_SIZE)
    .step(1)
    .default(DEFAULT_CREDITS_PAGE_SIZE)
    .description('积分流水条数（1-100）'),
  visionModelIds: z
    .array(z.string())
    .default([])
    .description('强制声明支持图片输入的模型 id（上游 capability 标错时的补丁）'),
  textOnlyModelIds: z
    .array(z.string())
    .default([])
    .description('强制声明纯文本的模型 id（优先于 visionModelIds）'),
})

/**
 * 配置页的分组。
 *
 * 由供应商声明，core 只按它归位——core 里出现 `creditsPageSize` 这种字段名，
 * 正是架构门禁要拦的东西（那等于把一家供应商的语义写进了平台层）。
 */
export const LOOMY_CONFIG_GROUPS: ConfigGroupDeclaration[] = [
  { id: 'connection', labelKey: 'config.group.connection', keys: ['enabled', 'baseURL', 'loomyVersion'] },
  { id: 'cache', labelKey: 'config.group.cache', keys: ['sessionTtlMs', 'precheckTtlMs', 'catalogTtlMs', 'creditsTtlMs'] },
  { id: 'credits', labelKey: 'config.group.credits', keys: ['creditsPageSize'] },
  { id: 'models', labelKey: 'config.group.models', keys: ['visionModelIds', 'textOnlyModelIds'] },
]

/** 与 {@link LOOMY_CONFIG_SCHEMA} 一致的默认值，供 core 在缺项时兜底。 */
export const LOOMY_CONFIG_DEFAULTS: Record<string, unknown> = {
  enabled: true,
  baseURL: DEFAULT_BASE_URL,
  loomyVersion: DEFAULT_LOOMY_VERSION,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  precheckTtlMs: DEFAULT_PRECHECK_TTL_MS,
  catalogTtlMs: DEFAULT_CATALOG_TTL_MS,
  creditsTtlMs: DEFAULT_CREDITS_TTL_MS,
  creditsPageSize: DEFAULT_CREDITS_PAGE_SIZE,
  visionModelIds: [],
  textOnlyModelIds: [],
}

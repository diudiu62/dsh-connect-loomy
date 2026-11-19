/**
 * 小浣熊积分余额——只读，而且刻意做得极小。
 *
 * 实测响应（2026-11-17）：
 * `{"code":0,"message":"success","data":{"available_points":13300,
 *   "daily_points":300,"monthly_points":0,"reward_points":13000,
 *   "topup_points":0,"enterprise_topup_points":…}}`
 *
 * 六个桶**分别**上报是有原因的：它们的过期时钟不同（每日额度会重置、奖励一年、
 * 充值永不过期），把它们加成一个数会告诉用户"余额很安全"，而实际上大部分马上
 * 就要蒸发。所以这里不做任何求和：桶名 → `CreditsView.fields` 的 key 一一对应，
 * 由前端按 `role` 决定谁是头条数字。
 *
 * 同时注意：**上游没给的桶不写进 `fields`**（不是写 0）。卡片对缺失 key 显示
 * `—`，而 0 会被读成"这个桶是空的"，是两件事。
 *
 * 缓存（60s TTL、单飞、失败不落缓存）在 `src/core/credits.ts`，不在这里。
 *
 * @module dsh-connect-desktop/vendors/raccoon/credits
 */

import type { CreditField, CreditsView } from '../../shared/views.js'
import { DEFAULT_RACCOON_POINTS_URL, RACCOON_OK_CODE, RACCOON_TIMEOUT_MS } from './constants.js'
import { raccoonHeaders } from './catalog.js'

/**
 * 上游桶名 → 视图 key 的唯一映射。
 *
 * `topup_points` 对外的 key 是 `recharge`（充值），`enterprise_topup_points` 是
 * `enterpriseRecharge`（企业充值）：上游用 topup，卡片用 recharge，映射只在这里。
 */
const BUCKETS = [
  { key: 'available', api: 'available_points' },
  { key: 'daily', api: 'daily_points' },
  { key: 'monthly', api: 'monthly_points' },
  { key: 'recharge', api: 'topup_points' },
  { key: 'reward', api: 'reward_points' },
  { key: 'enterpriseRecharge', api: 'enterprise_topup_points' },
] as const

/** 一个桶的视图 key。 */
export type RaccoonCreditKey = (typeof BUCKETS)[number]['key']

/**
 * descriptor 声明的积分字段：`CreditsView.fields` 的 key、locale key 与视觉角色。
 *
 * 这是 **唯一** 的定义处：descriptor 用它声明能力，{@link toCreditsView} 用它
 * 决定哪些桶进 `fields`，两边不可能对不上。
 */
export const RACCOON_CREDIT_FIELDS: readonly CreditField[] = [
  { key: 'available', labelKey: 'credits.field.available', role: 'available' },
  { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
  { key: 'monthly', labelKey: 'credits.field.monthly', role: 'other' },
  { key: 'recharge', labelKey: 'credits.field.recharge', role: 'other' },
  { key: 'reward', labelKey: 'credits.field.reward', role: 'other' },
  { key: 'enterpriseRecharge', labelKey: 'credits.field.enterpriseRecharge', role: 'other' },
]

/** 一次余额读数。上游没给的桶就是 `undefined`（与"给 0"不同）。 */
export interface RaccoonBalance {
  /** 现在就能花的点数。 */
  available?: number
  /** 今日额度（按上游自己的周期重置）。 */
  daily?: number
  /** 本周期会员额度。 */
  monthly?: number
  /** 充值点数（不过期）。 */
  recharge?: number
  /** 奖励/任务点数（长寿命）。 */
  reward?: number
  /** 企业充值（账号有才有）。 */
  enterpriseRecharge?: number
  /** 本次读数的毫秒时间戳。 */
  at: number
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 解析一个 `points/v1/balance` 成功响应。任何意外都返回 `undefined`。
 *
 * 只有 `data` 里的键存在时才写进结果——这样"上游没有这个桶"和"桶是 0"
 * 在视图层仍然是两件事。
 */
export function parseBalance(body: unknown, now: number = Date.now()): RaccoonBalance | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (record['code'] !== RACCOON_OK_CODE) return undefined
  const data = record['data']
  if (data === null || typeof data !== 'object') return undefined
  const source = data as Record<string, unknown>
  const balance: RaccoonBalance = { at: now }
  for (const bucket of BUCKETS) {
    const value = numberOrUndefined(source[bucket.api])
    if (value !== undefined) balance[bucket.key] = value
  }
  return balance
}

/** 把一次读数映射成通用视图（缺失的桶不进 `fields`）。 */
export function toCreditsView(balance: RaccoonBalance): CreditsView {
  const fields: Record<string, number> = {}
  for (const field of RACCOON_CREDIT_FIELDS) {
    const value = balance[field.key as RaccoonCreditKey]
    if (value !== undefined) fields[field.key] = value
  }
  return { fields, fetchedAt: balance.at }
}

/** 抓一次实时余额。传输/结构失败必抛（绝不静默当成 0）。 */
export async function fetchBalance(options: {
  token: string
  pointsURL?: string
  orgCode?: string
  clientVersion?: string
  deviceId?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<RaccoonBalance> {
  const url = options.pointsURL ?? DEFAULT_RACCOON_POINTS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RACCOON_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: raccoonHeaders(options.token, {
        ...(options.orgCode === undefined ? {} : { orgCode: options.orgCode }),
        ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
        ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`小浣熊积分接口返回 HTTP ${response.status}：${text.slice(0, 200)}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('小浣熊积分接口返回的不是 JSON')
    }
    const parsed = parseBalance(body, options.now?.() ?? Date.now())
    if (parsed === undefined) throw new Error('小浣熊积分接口返回结构不符合预期')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

// ── 账单（积分明细） ────────────────────────────────────────────────────────
//
// 实测（2026-11-19）：`GET /api/web/points/v2/bills` 返回
// `{code:0,data:{items:[…],has_more:true,next_cursor:"…"}}`，单条形如
// ```
// {"bill_id":"bill_…","group_id":"task_…","biz_id":"…","biz_type":"desktop",
//  "client_type":"desktop","event_name":"桌面端 LLM 对话消耗",
//  "points":-1,"bill_count":1,"created_at":"2026-11-19T16:04:34+08:00"}
// ```
// 三个要点：
// - `points` **带符号**（负数才是扣减），所以 `direction` 直接从符号推导；
// - 分页是**游标**（`next_cursor`），不是页码 —— 只取第一页就够卡片展示，
//   多翻页会把一次只读查询变成 N 次上游请求；
// - **没有余后余额、也没有模型名**，所以这两列留空而不是编造（`balanceAfter`
//   在视图里是可选的）。

/** 账单接口（v2）。与余额不同域：v2 才有 `items`。 */
export const RACCOON_BILLS_URL = 'https://xiaohuanxiong.com/api/web/points/v2/bills'

/** 一页账单的解析结果。 */
export interface RaccoonBillsPage {
  records: import('../../shared/views.js').CreditRecordView[]
  hasMore: boolean
  nextCursor?: string
}

/**
 * 解析一页账单。
 *
 * 单条脏数据（缺 `created_at`、`points` 不是数字）**跳过而不是整页失败**：
 * 明细是辅助信息，一条坏记录不该让整个面板消失。
 */
export function parseBills(body: unknown): RaccoonBillsPage | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const envelope = body as Record<string, unknown>
  if (envelope['code'] !== RACCOON_OK_CODE) return undefined
  const data = envelope['data']
  if (typeof data !== 'object' || data === null) return undefined
  const raw = (data as Record<string, unknown>)['items']
  if (!Array.isArray(raw)) return undefined

  const records: RaccoonBillsPage['records'] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const points = row['points']
    const createdAt = row['created_at']
    if (typeof points !== 'number' || !Number.isFinite(points)) continue
    if (typeof createdAt !== 'string') continue
    // 上游是带时区的 ISO（`+08:00`），`Date.parse` 直接吃；坏值跳过。
    const at = Date.parse(createdAt)
    if (!Number.isFinite(at)) continue
    const eventName = typeof row['event_name'] === 'string' ? row['event_name'] : ''
    const bizType = typeof row['biz_type'] === 'string' ? row['biz_type'] : ''
    records.push({
      description: eventName.length > 0 ? eventName : bizType,
      // 符号即方向：负数扣减，正数入账。
      direction: points < 0 ? 'debit' : 'credit',
      pointsActual: Math.abs(points),
      createdAt: at,
    })
  }

  const hasMore = (data as Record<string, unknown>)['has_more'] === true
  const nextCursor = (data as Record<string, unknown>)['next_cursor']
  return {
    records,
    hasMore,
    ...(typeof nextCursor === 'string' && nextCursor.length > 0 ? { nextCursor } : {}),
  }
}

/** 抓一页账单。传输/信封失败必抛；单条脏数据由 {@link parseBills} 跳过。 */
export async function fetchBills(options: {
  token: string
  cursor?: string
  limit?: number
  orgCode?: string
  clientVersion?: string
  deviceId?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  url?: string
}): Promise<RaccoonBillsPage> {
  const base = options.url ?? RACCOON_BILLS_URL
  const query = new URLSearchParams()
  if (options.cursor !== undefined && options.cursor.length > 0) query.set('cursor', options.cursor)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const url = query.size === 0 ? base : `${base}?${query.toString()}`

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RACCOON_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: raccoonHeaders(options.token, {
        ...(options.orgCode === undefined ? {} : { orgCode: options.orgCode }),
        ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
        ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`小浣熊账单接口返回 HTTP ${response.status}：${text.slice(0, 200)}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('小浣熊账单接口返回的不是 JSON')
    }
    const parsed = parseBills(body)
    if (parsed === undefined) throw new Error('小浣熊账单接口返回结构不符合预期')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

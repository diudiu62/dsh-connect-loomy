/**
 * Loomy 的路由命名空间。
 *
 * 账号存储本身在 `core/accounts.ts`；Loomy 用 `routeMode: 'single'`（与小浣熊
 * 一致）：账号再多也只有一条 `loomy` 路由，"谁付费"是每次调用的决定。这里保留的
 * 是**历史键**的解析算法，因为路由 id 同时出现在三处，必须只有一个实现：
 *
 * 1. 历史消息里的模型身份（`provider: 'loomy-3'` 这种旧会话）；
 * 2. 旧的 slots 形态留下的 `loomy-N` / `loomy-pool` 名字；
 * 3. 选择器/账号行展示（现在恒为 `Loomy`）。
 *
 * 也就是说：这些函数只负责**认得出**旧键，不再产出新键。
 *
 * @module dsh-connect-desktop/vendors/loomy/accounts
 */

import { createHash } from 'node:crypto'
import { DISPLAY_NAME, POOL_ROUTE, PROVIDER_ID } from './constants.js'

/** 主路由 id（slot 1）。 */
export const BASE_ROUTE = PROVIDER_ID

/** slot → 路由 id。slot 1 是主路由，其余是 `${id}-${slot}`。 */
export function routeForSlot(slot: number): string {
  return slot <= 1 ? BASE_ROUTE : `${BASE_ROUTE}-${slot}`
}

/** 路由 id → slot；不是本供应商的路由返回 `undefined`。 */
export function slotForRoute(route: string): number | undefined {
  if (route === BASE_ROUTE) return 1
  const match = new RegExp(`^${BASE_ROUTE}-(\\d+)$`, 'u').exec(route)
  if (match === null) return undefined
  const slot = Number(match[1])
  return Number.isInteger(slot) && slot > 1 ? slot : undefined
}

/** 路由在模型选择器里的显示名。 */
export function routeDisplayName(route: string): string {
  if (route === POOL_ROUTE) return `${DISPLAY_NAME} · 随机池`
  const slot = slotForRoute(route)
  if (slot === undefined || slot === 1) return DISPLAY_NAME
  return `${DISPLAY_NAME} · ${slot}`
}

/** 这条 provider 路由是不是本供应商的。 */
export function isOurRoute(route: string): boolean {
  return route === POOL_ROUTE || slotForRoute(route) !== undefined
}

/**
 * 会话的稳定指纹，用作账号去重键。
 *
 * 会话串本身是秘密，指纹只是它的短摘要，用于"同一个登录态不要加两次"。
 */
export function accountIdOf(material: string): string {
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

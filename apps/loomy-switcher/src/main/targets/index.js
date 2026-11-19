/**
 * 目标平台注册表。
 *
 * 目前两个：Loomy 与小浣熊。每个 target 提供同一组动词，上层不需要知道
 * 底层是 leveldb 还是明文 JSON。新增平台只需在这里加一项。
 *
 * @module account-switcher/targets
 */

import * as loomy from './loomy.js'
import * as raccoon from './raccoon.js'

/** 平台元信息（给界面画 tab 用）。 */
export const TARGETS = [
  { id: loomy.TARGET_ID, label: loomy.LABEL, appName: loomy.APP_NAME, supportsInvite: true, sessionLifeDays: 14 },
  {
    id: raccoon.TARGET_ID,
    label: raccoon.LABEL,
    appName: raccoon.APP_NAME,
    supportsInvite: false,
    sessionLifeDays: 30,
  },
]

const IMPLEMENTATIONS = {
  [loomy.TARGET_ID]: loomy,
  [raccoon.TARGET_ID]: raccoon,
}

/** 取一个平台的实现；未知 id 抛错而不是静默回退（静默回退会改错客户端的登录态）。 */
export function target(id) {
  const impl = IMPLEMENTATIONS[id]
  if (impl === undefined) throw new Error(`未知的平台：${id}`)
  return impl
}

export function isKnown(id) {
  return Object.hasOwn(IMPLEMENTATIONS, id)
}

export const DEFAULT_TARGET = loomy.TARGET_ID
/**
 * Plugin configuration: the fields the DSH settings page persists.
 *
 * The shape is deliberately **one namespaced bag per vendor**. The old layout
 * had nine Loomy fields and nine `raccoon*` fields flat on the root object, so
 * vendor #3 would have added a third parallel block and vendor #5 would have
 * made the settings schema unreadable. Now the root has exactly two knobs and
 * each vendor owns (and documents) its own slice.
 *
 * Every field is `.volatile()`: a settings save republishes the live object
 * without restarting the plugin, and every read unwraps it with {@link live}, so
 * the next request observes the new value.
 *
 * The model selection is deliberately **not** here: it is written by the card
 * through a route, and persisted in the vendor's own state document.
 *
 * @module dsh-connect-desktop/config
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LOOMY_CONFIG_DEFAULTS, LOOMY_CONFIG_SCHEMA, PROVIDER_ID as LOOMY_ID } from './vendors/loomy/constants.js'
import { RACCOON_CONFIG_DEFAULTS, RACCOON_CONFIG_SCHEMA, RACCOON_PROVIDER_ID } from './vendors/raccoon/index.js'

/** Fallback settings namespace when no loader entry is visible. */
export const FALLBACK_SETTINGS_NS = 'dsh-connect-desktop'

/** Per-vendor configuration; `Record<string, unknown>` because vendors own their schema. */
export type VendorConfigMap = Record<string, Record<string, unknown> | undefined>

/**
 * 每家供应商自己的配置片，**拼成一张具体的 schema**。
 *
 * 这里曾经是 `z.any()`，理由是"schemastery 渲染不了动态 map"。后果比渲染问题严重：
 * 用户打开配置只看到自己写过的那一家（通常是 loomy），另一家连字段名都不出现，
 * 于是"找不到配置的地方"。具体 schema 让两边都成立：
 *
 * - DSH 的配置视图 / `--dump-config` 能看到 `vendors.raccoon.baseURL` 等真实字段
 *   与默认值；
 * - 我们自己的卡片仍按 `auto: false` 自行绘制，不依赖 schemastery 的渲染能力。
 *
 * 加第三家 = 这张表加一行（import 它的 `_CONFIG_SCHEMA` / `_CONFIG_DEFAULTS`），
 * 不是"再发明一套平行字段"。
 */
const vendorSlices: Record<string, { schema: unknown; defaults: Record<string, unknown> }> = {
  [LOOMY_ID]: { schema: LOOMY_CONFIG_SCHEMA, defaults: LOOMY_CONFIG_DEFAULTS },
  [RACCOON_PROVIDER_ID]: { schema: RACCOON_CONFIG_SCHEMA, defaults: RACCOON_CONFIG_DEFAULTS },
}

/** 所有供应商配置片的默认值（`vendors.<id>.<field>` 的兜底）。 */
export const VENDOR_CONFIG_DEFAULTS: Readonly<Record<string, Record<string, unknown>>> = Object.fromEntries(
  Object.entries(vendorSlices).map(([id, slice]) => [id, slice.defaults]),
)

const vendorsSchema = z
  .object(
    Object.fromEntries(
      Object.entries(vendorSlices).map(([id, slice]) => [id, slice.schema]),
    ) as Record<string, never>,
  )
  // 缺省也给出完整的默认片，这样"从没写过配置"的用户也能在视图里看到字段。
  .default(
    Object.fromEntries(
      Object.entries(vendorSlices).map(([id, slice]) => [id, { ...slice.defaults }]),
    ),
  )

const configFields = {
  /** Master switch: disabled vendors register neither routes nor a provider. */
  enabled: z.boolean().default(true).description('启用桌面端模型接入').volatile(),
  /** 每家的独立配置片，按供应商 id 分组。 */
  vendors: vendorsSchema.description('各供应商的独立配置（按供应商 id 分组）').volatile(),
}

/** Runtime schema the settings page renders and the loader validates. */
export const Config = z.object(configFields)

/** Parsed plugin configuration (volatile fields are live references). */
export type Config = Schemastery.ObjectT<typeof configFields>

/** The settings namespace the host actually serves this plugin under. */
export function settingsNamespaceOf(ctx: Context): string {
  const fiber = ctx.fiber as unknown as { entry?: { options?: { id?: unknown } } }
  const id = fiber.entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : FALLBACK_SETTINGS_NS
}

/**
 * Unwrap a volatile config field.
 *
 * Schemastery's `.volatile()` fields are `{get(): T}` references that the loader
 * mutates in place. Reading through this helper on every request is what makes a
 * settings save take effect without a plugin restart.
 */
export function live<T>(value: T | Volatile<T>): T {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/** One vendor's slice, with the master switch folded in. */
export function vendorConfigOf(config: Config, vendorId: string): Record<string, unknown> {
  const map = live(config.vendors) as VendorConfigMap | undefined
  const slice = map?.[vendorId]
  return slice === undefined || slice === null ? {} : slice
}

/** Whether a vendor is switched on: its own `enabled` inside the master switch. */
export function vendorEnabled(config: Config, vendorId: string): boolean {
  if (live(config.enabled) !== true) return false
  return vendorConfigOf(config, vendorId)['enabled'] !== false
}

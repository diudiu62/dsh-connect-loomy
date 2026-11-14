/**
 * Plugin configuration: the fields the DSH settings page persists.
 *
 * The namespace is **not** a free choice — the settings service keys sections
 * by the loader entry id (`cordis.patch.yml` inserts `id: dsh-connect-loomy`),
 * so {@link settingsNamespaceOf} reads `ctx.fiber.entry.options.id` and only
 * falls back to the package name for hosts that mount the plugin without a
 * loader entry (tests, direct `ctx.plugin`).
 *
 * Every field is `.volatile()`: a settings save republishes the live object
 * without restarting the plugin. `src/index.ts` unwraps each read with
 * {@link live}, so the next request/route observes the new value. The model
 * selection is deliberately **not** a config field: it is persisted by the
 * plugin's own state file (`src/shared/state.ts`), because the card writes it
 * through a route, not through the settings form.
 *
 * @module dsh-connect-loomy/config
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_CREDITS_PAGE_SIZE,
  DEFAULT_CREDITS_TTL_MS,
  DEFAULT_LOOMY_VERSION,
  DEFAULT_PRECHECK_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  MAX_CREDITS_PAGE_SIZE,
} from './shared/types.js'

/** Fallback settings namespace when no loader entry is visible. */
export const FALLBACK_SETTINGS_NS = 'dsh-connect-loomy'

const configFields = {
  /** Master switch: a disabled plugin registers no provider route. */
  enabled: z.boolean().default(true).description('启用 Loomy 模型接入').volatile(),
  /** Loomy platform base URL (the desktop client's own endpoint). */
  baseURL: z.string().default(DEFAULT_BASE_URL).description('Loomy 平台 API 基地址（含 /api/v1）').volatile(),
  /** `loomy-version` sent on chat requests; the server does not validate it. */
  loomyVersion: z
    .string()
    .default(DEFAULT_LOOMY_VERSION)
    .description('对话请求的 loomy-version 头（当前客户端 0.9.39）')
    .volatile(),
  /** Re-read the desktop sign-in file at most every N ms. */
  sessionTtlMs: z
    .number()
    .default(DEFAULT_SESSION_TTL_MS)
    .min(0)
    .step(1000)
    .description('登录态文件重读间隔（毫秒）')
    .volatile(),
  /** Session precheck (identity probe) reuse window. */
  precheckTtlMs: z
    .number()
    .default(DEFAULT_PRECHECK_TTL_MS)
    .min(0)
    .step(1000)
    .description('登录态上游预检结果缓存时长（毫秒）')
    .volatile(),
  /** Catalog cache TTL; `0` refreshes on every read. */
  catalogTtlMs: z
    .number()
    .default(DEFAULT_CATALOG_TTL_MS)
    .min(0)
    .step(1000)
    .description('模型目录缓存时长（毫秒，0=每次都刷新）')
    .volatile(),
  /** Points overview TTL (contract v2 fixes the default at 60s). */
  creditsTtlMs: z
    .number()
    .default(DEFAULT_CREDITS_TTL_MS)
    .min(0)
    .step(1000)
    .description('只读积分缓存时长（毫秒）')
    .volatile(),
  /** Ledger rows requested from `/points/records` (server clamps at 100). */
  creditsPageSize: z
    .number()
    .default(DEFAULT_CREDITS_PAGE_SIZE)
    .min(1)
    .max(MAX_CREDITS_PAGE_SIZE)
    .step(1)
    .description('积分流水条数（1-100）')
    .volatile(),
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
 * Schemastery's `.volatile()` fields are `{get(): T}` references that the
 * loader mutates in place. Reading through this helper on every request is
 * what makes a settings save take effect without a plugin restart.
 */
export function live<T>(value: T | Volatile<T>): T {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

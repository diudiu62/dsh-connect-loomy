/**
 * Deterministic presentation helpers.
 *
 * Determinism matters: the jsdom suite asserts rendered rates, context windows
 * and timestamps, so nothing here uses locale-dependent `toLocaleString`. Dates
 * keep the `YYYY-MM-DD HH:mm` shape in the browser's own clock — the only time
 * a user can act on.
 *
 * `formatCredit` is the reason this module survived the capability refactor: a
 * balance that the host did not report must render as `—`, never as `0`, and
 * that rule needs to be expressed once rather than per panel.
 *
 * @module dsh-connect-desktop/client/format
 */

import type { CreditField, CreditsCapability, CreditsView } from '../shared/views.js'
import type { CardT } from './components/types.js'

/** Thousands-separated integer; `—` for missing/non-finite values. */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const digits = Math.round(Math.abs(value)).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * One credit figure, and whether it is actually known.
 *
 * The `missing` flag is what lets `CreditsBody` style a hole differently from a
 * truthful zero, instead of guessing from the formatted string.
 */
export function formatCredit(value: number | null | undefined): { text: string; missing: boolean } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { text: '—', missing: true }
  return { text: formatCount(value), missing: false }
}

/** A points multiplier as the UI writes it: `×2.0`, `×0.8`, `×0.0`. */
export function formatMultiplier(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const text = Number.isInteger(value) ? value.toFixed(1) : String(value)
  return `×${text}`
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Local `YYYY-MM-DD HH:mm`; `—` for missing/non-finite timestamps. */
export function formatDateTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * 凭据来源的中文说法。
 *
 * 抽出来共用，是因为诊断页曾经直接渲染 `sourceOrigin`，中文界面里冒出 `desktop`
 * / `plugin` 这种英文标识符；而账号页对同一个枚举做了映射。同一个事实必须只有一套说法。
 */
export function originLabel(
  origin: 'plugin' | 'desktop' | 'env' | 'none' | undefined,
  t: (key: never) => string,
): string {
  const label = (key: string): string => (t as unknown as (value: string) => string)(key)
  switch (origin) {
    case 'plugin':
      return label('account.sourcePlugin')
    case 'desktop':
      return label('account.sourceDesktop')
    case 'env':
      return label('account.sourceEnv')
    default:
      return label('account.sourceNone')
  }
}

/** Join reasoning efforts and mark the upstream default. */
export function formatEfforts(
  efforts: readonly string[],
  defaultEffort: string | undefined,
  t: CardT,
): string {
  if (efforts.length === 0) return t('models.efforts.none')
  const joined = efforts.join(' · ')
  if (typeof defaultEffort !== 'string' || defaultEffort.length === 0) return joined
  return `${joined} (${t('models.efforts.default', { effort: defaultEffort })})`
}

/**
 * 这张额度视图要不要画流水表。
 *
 * 抽成纯函数有两个原因：`kind` 与"有没有流水"是**两个**维度（Loomy 既有 3 个
 * 余额桶又有 `/points/records`），把判断散在 JSX 里就会重演"有余额就没流水"的
 * 功能丢失；其次它可以脱离 DOM 单测。
 */
export function showsLedger(capability: CreditsCapability): boolean {
  if (capability.kind === 'ledger') return true
  return capability.kind === 'balance' && capability.ledger === true
}

/** The fields a credits surface renders, or `null` when it renders no grid. */
export function creditFields(capability: CreditsCapability): readonly CreditField[] | null {
  return capability.kind === 'balance' ? capability.fields : null
}

/**
 * The headline figure of a balance surface: the field whose role is `available`.
 *
 * The role, not the key, is the contract — a vendor may call its bucket
 * `remaining` or `points_left` and still be the number the composer badge shows.
 */
export function headlineField(capability: CreditsCapability): CreditField | undefined {
  if (capability.kind !== 'balance') return undefined
  return capability.fields.find((field) => field.role === 'available') ?? capability.fields[0]
}

/**
 * 一个账号的主数字。
 *
 * 抽屉逐行显示额度时必须按 **accountId** 配对：多账号共用一个 provider route 时，
 * 按 route 配对会让每一行都显示同一个数字（旧抽屉的真实缺陷）。账号这一行读失败、
 * 或这家没有这个桶时返回 `undefined`，由 UI 渲染 `—` 而不是 0。
 */
export function perAccountAmount(
  view: CreditsView | null,
  accountId: string,
  key: string | undefined,
): number | undefined {
  if (view === null || key === undefined) return undefined
  const row = (view.perAccount ?? []).find((entry) => entry.accountId === accountId)
  if (row === undefined || row.error !== undefined) return undefined
  const value = row.fields[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The headline credit figure for a view, or `undefined` when the vendor has no balance. */
export function headlineAmount(capability: CreditsCapability, view: CreditsView | null): number | undefined {
  if (view === null) return undefined
  const field = headlineField(capability)
  if (field === undefined) return undefined
  const value = view.fields[field.key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

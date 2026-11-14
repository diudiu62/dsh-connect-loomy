/**
 * Presentation helpers: deterministic formatting and the copyable diagnostics
 * report.
 *
 * Determinism matters here: the jsdom tests assert the rendered rate, context,
 * max-output and timestamps, so the formatters avoid locale-dependent
 * `toLocaleString` output. Dates use the browser's local clock (the only thing
 * a user can act on) but always in a fixed `YYYY-MM-DD HH:mm` shape.
 *
 * @module dsh-connect-loomy/client/format
 */

import type { LoomyDiagnostics, LoomyStatus } from './api.js'
import { ROUTES } from './api.js'
import type { LoomyLocaleKey } from './locale.js'

/** Translates one key of this plugin's dictionary. */
export type TranslateLoomy = (key: LoomyLocaleKey, params?: Record<string, unknown>) => string

/** Thousands-separated integer; `—` for missing/non-finite values. */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const digits = Math.round(Math.abs(value)).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
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

/** Join reasoning efforts and mark the upstream default. */
export function formatEfforts(
  efforts: readonly string[],
  defaultEffort: string | undefined,
  t: TranslateLoomy,
): string {
  if (efforts.length === 0) return t('models.efforts.none')
  const joined = efforts.join(' · ')
  if (typeof defaultEffort !== 'string' || defaultEffort.length === 0) return joined
  return `${joined} (${t('models.efforts.default', { effort: defaultEffort })})`
}

/** Inputs to the copyable report; absent halves render as "none". */
export interface DiagnosticsReportInput {
  status: LoomyStatus | null
  diagnostics: LoomyDiagnostics | null
  /** Live counters (catalog refresh may have moved them past `/status`). */
  catalog: { total: number; enabled: number } | null
  /** Epoch milliseconds; pass `Date.now()` at click time. */
  generatedAt: number
}

/**
 * Build the plain-text block the diagnostics tab copies. Only typed, already
 * masked fields enter it: no session, no full phone number, no CSRF token.
 */
export function formatDiagnosticsReport(input: DiagnosticsReportInput, t: TranslateLoomy): string {
  const { status, diagnostics, catalog } = input
  const lines: string[] = []

  lines.push(t('diagnostics.report.title'))
  lines.push(`${t('diagnostics.report.generatedAt')}: ${formatDateTime(input.generatedAt)}`)
  lines.push(
    `${t('diagnostics.report.route')}: ${ROUTES.status}, ${ROUTES.diagnostics}, ${ROUTES.credits}, ` +
      `${ROUTES.refresh}, ${ROUTES.save}`,
  )
  lines.push('')

  lines.push(`${t('diagnostics.report.credentialPath')}:`)
  if (status === null) {
    lines.push(`- ${t('diagnostics.report.unknown')}`)
  } else {
    const conclusion = status.credential.found
      ? t('account.credentialFound', { path: status.credential.sourcePath })
      : t('account.credentialMissing', { path: status.credential.sourcePath })
    lines.push(`- ${conclusion}`)
  }
  lines.push('')

  lines.push(`${t('diagnostics.report.probes')}:`)
  if (diagnostics === null || diagnostics.probes.length === 0) {
    lines.push(`- ${t('diagnostics.report.none')}`)
  } else {
    for (const probe of diagnostics.probes) {
      const state = probe.ok ? t('diagnostics.probe.ok') : t('diagnostics.probe.fail')
      lines.push(`- ${probe.path} [${state}]${probe.reason.length > 0 ? ` ${probe.reason}` : ''}`)
    }
  }
  lines.push('')

  lines.push(`${t('diagnostics.report.upstream')}:`)
  if (diagnostics === null) {
    lines.push(`- ${t('diagnostics.report.unknown')}`)
  } else {
    lines.push(`- ${t('diagnostics.upstream.baseUrl')}: ${diagnostics.upstream.baseUrl}`)
    lines.push(`- ${t('diagnostics.upstream.models')}: ${diagnostics.upstream.modelsUrl}`)
    lines.push(`- ${t('diagnostics.upstream.points')}: ${diagnostics.upstream.pointsUrl}`)
  }
  lines.push('')

  const account = diagnostics?.account ?? status?.account ?? null
  lines.push(`${t('diagnostics.report.account')}: ${account === null ? t('diagnostics.report.none') : account.maskedPhone}`)

  const counters = catalog ?? diagnostics?.catalog ?? status?.catalog ?? null
  lines.push(
    `${t('diagnostics.report.catalog')}: ${
      counters === null
        ? t('diagnostics.report.unknown')
        : t('diagnostics.catalog.counts', { total: counters.total, enabled: counters.enabled })
    }`,
  )
  lines.push('')

  lines.push(`${t('diagnostics.report.lastError')}:`)
  const lastError = diagnostics?.lastError ?? status?.lastError
  if (lastError === undefined) {
    lines.push(`- ${t('diagnostics.report.none')}`)
  } else {
    lines.push(`- ${t('diagnostics.lastError.path')}: ${lastError.path}`)
    lines.push(`- ${t('diagnostics.lastError.code')}: ${lastError.code}`)
    lines.push(`- ${t('diagnostics.lastError.at')}: ${formatDateTime(lastError.at)}`)
    lines.push(`- ${t('diagnostics.lastError.message')}: ${lastError.message}`)
  }

  return lines.join('\n')
}

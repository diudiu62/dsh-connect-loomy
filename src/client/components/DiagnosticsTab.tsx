/**
 * Diagnostics tab: a read-only fact table with a one-click "copy the whole
 * block" action.
 *
 * Every value is already host-computed: credential candidates and their
 * conclusions, upstream URLs, the masked account, catalog counters, and the
 * last upstream error **verbatim** (the contract forbids translating or
 * summarizing `message`). The copy payload is assembled in `format.ts` from the
 * same typed fields, so a bug report can never include the session token.
 *
 * Fact precedence ("one fact, one outlet"):
 * 1. counters come from `/diagnostics.catalog` (the diagnostics route is the
 *    authoritative observation);
 * 2. a live catalog refresh (models tab) supersedes those counters, because it
 *    moved total/enabled after `/status` was read;
 * 3. `/status.lastError` is only a fallback when the diagnostics payload omits
 *    `lastError` — `/diagnostics.lastError` always wins.
 *
 * @module dsh-connect-loomy/client/components/DiagnosticsTab
 */

import type { LoomyDiagnostics, LoomyStatus } from '../api.js'
import { formatDateTime } from '../format.js'
import { Badge, CardButton, FactRow, Notice, Section } from './common.js'
import { loadableMessage, type Loadable, type LoomyT } from './types.js'

/** Copy-button feedback state. */
export type CopyState = 'idle' | 'copied' | 'failed'

/** Props supplied by the card shell. */
export interface DiagnosticsTabProps {
  t: LoomyT
  status: Loadable<LoomyStatus>
  diagnostics: Loadable<LoomyDiagnostics>
  /** Live counters after a catalog refresh, else `/status` counters. */
  catalog: { total: number; enabled: number } | null
  copyState: CopyState
  onReload: () => void
  onCopy: () => void
}

/** Render the diagnostics tab. */
export function DiagnosticsTab({
  t,
  status,
  diagnostics,
  catalog,
  copyState,
  onReload,
  onCopy,
}: DiagnosticsTabProps) {
  // 404/503 is a capability answer: hide the controls instead of offering
  // actions that would fail forever. `status` is still used as a fallback for
  // the counters and last-error line when the diagnostics route answers.
  const controlsAvailable = diagnostics.kind !== 'unavailable'

  return (
    <div className="loomy-panel">
      <Section
        title={t('diagnostics.title')}
        actions={
          controlsAvailable ? (
            <>
              {copyState === 'copied' ? <span className="loomy-muted">{t('common.copied')}</span> : null}
              {copyState === 'failed' ? <span className="loomy-error">{t('common.copyFailed')}</span> : null}
              <CardButton onClick={onReload} disabled={diagnostics.kind === 'loading'}>
                {t('diagnostics.refresh')}
              </CardButton>
              <CardButton variant="primary" onClick={onCopy} disabled={diagnostics.kind !== 'ready'}>
                {t('diagnostics.copy')}
              </CardButton>
            </>
          ) : null
        }
      >
        <p className="loomy-muted">{t('diagnostics.description')}</p>
        <DiagnosticsBody t={t} status={status} diagnostics={diagnostics} catalog={catalog} />
      </Section>
    </div>
  )
}

function DiagnosticsBody({
  t,
  status,
  diagnostics,
  catalog,
}: {
  t: LoomyT
  status: Loadable<LoomyStatus>
  diagnostics: Loadable<LoomyDiagnostics>
  catalog: { total: number; enabled: number } | null
}) {
  if (diagnostics.kind === 'idle' || diagnostics.kind === 'loading') {
    return <p className="loomy-muted">{t('diagnostics.loading')}</p>
  }
  if (diagnostics.kind === 'unavailable') {
    return <Notice tone="error">{t('diagnostics.unavailable')}</Notice>
  }
  if (diagnostics.kind === 'stale') {
    return <Notice tone="error">{diagnostics.message}</Notice>
  }
  if (diagnostics.kind === 'failed' || diagnostics.kind === 'error') {
    return <Notice tone="error">{loadableMessage(diagnostics, t)}</Notice>
  }

  const value = diagnostics.value
  const lastError = value.lastError ?? (status.kind === 'ready' ? status.value.lastError : undefined)
  const counts = catalog ?? value.catalog
  const account = value.account ?? (status.kind === 'ready' ? status.value.account : null)

  return (
    <div className="loomy-panel">
      <div>
        <div className="loomy-section-title">{t('diagnostics.probes')}</div>
        <div className="loomy-panel">
          {value.probes.map((probe) => (
            <div className="loomy-row" key={probe.path}>
              <span className="loomy-value">{probe.path}</span>
              <span className="loomy-value">
                <Badge tone={probe.ok ? 'ok' : 'danger'}>
                  {probe.ok ? t('diagnostics.probe.ok') : t('diagnostics.probe.fail')}
                </Badge>{' '}
                {probe.reason}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="loomy-section-title">{t('diagnostics.upstream')}</div>
        <FactRow label={t('diagnostics.upstream.baseUrl')}>{value.upstream.baseUrl}</FactRow>
        <FactRow label={t('diagnostics.upstream.models')}>{value.upstream.modelsUrl}</FactRow>
        <FactRow label={t('diagnostics.upstream.points')}>{value.upstream.pointsUrl}</FactRow>
      </div>

      <FactRow label={t('diagnostics.account')}>
        {account === null ? t('common.none') : account.phone}
      </FactRow>

      <FactRow label={t('diagnostics.catalog')}>
        {t('diagnostics.catalog.counts', { total: counts.total, enabled: counts.enabled })}
      </FactRow>

      <div>
        <div className="loomy-section-title">{t('diagnostics.lastError')}</div>
        {lastError === undefined ? (
          <p className="loomy-muted">{t('diagnostics.noLastError')}</p>
        ) : (
          <>
            <FactRow label={t('diagnostics.lastError.path')}>{lastError.path}</FactRow>
            <FactRow label={t('diagnostics.lastError.code')}>{lastError.code}</FactRow>
            <FactRow label={t('diagnostics.lastError.at')}>{formatDateTime(lastError.at)}</FactRow>
            <FactRow label={t('diagnostics.lastError.message')}>
              <code>{lastError.message}</code>
            </FactRow>
          </>
        )}
      </div>
    </div>
  )
}

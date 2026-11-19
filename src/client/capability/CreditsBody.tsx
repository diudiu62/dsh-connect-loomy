/**
 * The credits surface, generated entirely from the capability declaration.
 *
 * `capabilities.credits` is a three-way union, and each branch has exactly one
 * rendering rule:
 *
 * - `none`  → the panel is not rendered at all (the caller decides);
 * - `balance` → a grid of `fields`, in declaration order. The value is looked
 *   up in `CreditsView.fields` **by key**, so a vendor naming its buckets
 *   differently needs no client change; a key the host did not report renders
 *   `—`, never `0`, because an unreadable balance is not a balance of zero;
 * - `ledger` → a row per `CreditRecordView`. The declaration carries no fields,
 *   so rendering a numeric grid here would be inventing buckets.
 *
 * `perAccount` is rendered for `balance` only: on a ledger surface the rows
 * already carry `source`, and a per-account repeat of the same numbers would be
 * the duplication the old card had.
 *
 * @module dsh-connect-desktop/client/capability/CreditsBody
 */

import type { CreditsCapability, CreditsView } from '../../shared/views.js'
import { formatCount, formatCredit, formatDateTime, showsLedger } from '../format.js'
import { labelFor } from '../locale.js'
import { Notice } from '../components/common.js'
import { failureMessage, type CardT, type Loadable } from '../components/types.js'

export interface CreditsBodyProps {
  t: CardT
  capability: CreditsCapability
  state: Loadable<CreditsView>
  onRetry: () => void
}

/** Render the credits block for the declared kind. */
export function CreditsBody({ t, capability, state, onRetry }: CreditsBodyProps) {
  if (capability.kind === 'none') return null

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <p className="dcss-muted">{t('common.loading')}</p>
  }
  if (state.kind === 'unavailable') {
    return <p className="dcss-muted">{t('credits.unavailable')}</p>
  }
  if (state.kind === 'stale' || state.kind === 'failed') {
    return (
      <div className="dcss-panel">
        <Notice tone="error">{t('credits.failed', { message: failureMessage(state, t) ?? t('common.unknownError') })}</Notice>
        <div>
          <button type="button" className="dcss-button" onClick={onRetry}>
            {t('common.refresh')}
          </button>
        </div>
      </div>
    )
  }

  const view = state.value
  const balanceMissing = view.partial === 'balance_unavailable'
  return (
    <div className="dcss-panel" data-dcss-credits-kind={capability.kind}>
      {/*
        余额读不到但明细读到了 —— 如实说明，而不是整块报错把明细一起丢掉。
        用户至少能看到"最近花了多少"，这在余额接口被限流时是最有用的信息。
      */}
      {balanceMissing ? <Notice tone="info">{t('credits.balanceUnavailable')}</Notice> : null}
      {capability.kind === 'balance' && !balanceMissing ? (
        <BalanceGrid t={t} capacity={capability} view={view} />
      ) : null}
      {showsLedger(capability) ? <LedgerTable t={t} view={view} /> : null}
      <p className="dcss-row-note">{t('credits.fetchedAt', { time: formatDateTime(view.fetchedAt) })}</p>
    </div>
  )
}

/** One cell per declared field, in declaration order. */
function BalanceGrid({
  t,
  capacity,
  view,
}: {
  t: CardT
  capacity: Extract<CreditsCapability, { kind: 'balance' }>
  view: CreditsView
}) {
  if (capacity.fields.length === 0) return <p className="dcss-muted">{t('credits.empty')}</p>
  return (
    <div className="dcss-credit-grid">
      {capacity.fields.map((field) => {
        const amount = formatCredit(view.fields[field.key])
        const classes = ['dcss-credit-cell']
        if (field.role === 'available') classes.push('dcss-credit-headline')
        const valueClasses = ['dcss-credit-value']
        if (amount.missing) valueClasses.push('dcss-credit-value-missing')
        return (
          <div className={classes.join(' ')} key={field.key} data-dcss-field={field.key}>
            <span className="dcss-label">{labelFor(t, field.labelKey)}</span>
            <span className={valueClasses.join(' ')}>{amount.text}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Ledger rows; the amount keeps its sign from `direction`. */
function LedgerTable({ t, view }: { t: CardT; view: CreditsView }) {
  const records = view.records ?? []
  if (records.length === 0) return <p className="dcss-muted">{t('credits.ledger.empty')}</p>
  return (
    <div className="dcss-ledger" role="table" aria-label={t('credits.ledger.title')}>
      <div className="dcss-ledger-row dcss-ledger-head" role="row">
        <span className="dcss-ledger-time" role="columnheader">
          {t('credits.ledger.time')}
        </span>
        <span className="dcss-ledger-desc" role="columnheader">
          {t('credits.ledger.description')}
        </span>
        <span className="dcss-ledger-model" role="columnheader">
          {t('credits.ledger.model')}
        </span>
        <span className="dcss-ledger-amount" role="columnheader">
          {t('credits.ledger.amount')}
        </span>
      </div>
      {records.slice(0, 20).map((record, index) => (
        <div className="dcss-ledger-row" role="row" key={`${record.createdAt}-${index}`}>
          <span className="dcss-ledger-time">{formatDateTime(record.createdAt)}</span>
          <span className="dcss-ledger-desc">
            {record.description.length > 0 ? record.description : t('common.none')}
            {record.source === undefined ? null : (
              <span className="dcss-row-note">
                {' '}
                {t('credits.source', { account: record.source.account ?? record.source.route })}
              </span>
            )}
          </span>
          {record.model === undefined ? <span /> : <span className="dcss-ledger-model">{record.model}</span>}
          <span
            className={`dcss-ledger-amount ${record.direction === 'credit' ? 'dcss-record-positive' : 'dcss-record-negative'}`}
          >
            {record.direction === 'credit' ? '+' : '-'}
            {formatCount(record.pointsActual)}
          </span>
        </div>
      ))}
    </div>
  )
}


/**
 * The account list — one row per provider route, plus pool health.
 *
 * Pure list: adding, exporting and importing live in {@link AddAccountPanel},
 * so this file only answers "which accounts exist and are they usable".
 *
 * @module dsh-connect-loomy/client/components/AccountsList
 */

import type { LoomyAccountRow, LoomyAccounts } from '../api.js'
import { formatDateTime } from '../format.js'
import { Badge, CardButton, Notice } from './common.js'
import { type Loadable, loadableMessage, type LoomyT } from './types.js'

export interface AccountsListProps {
  t: LoomyT
  accounts: Loadable<LoomyAccounts>
  csrfToken: string | null
  removingId: string | null
  onRemove: (id: string) => void
}

/** Render every account as a compact row. */
export function AccountsList({ t, accounts, csrfToken, removingId, onRemove }: AccountsListProps) {
  if (accounts.kind === 'idle' || accounts.kind === 'loading') {
    return <p className="loomy-muted">{t('common.loading')}</p>
  }
  if (accounts.kind === 'stale') return <Notice tone="error">{accounts.message}</Notice>
  if (accounts.kind === 'unavailable') return <p className="loomy-muted">{t('accounts.unavailable')}</p>
  if (accounts.kind === 'failed' || accounts.kind === 'error') {
    return <Notice tone="error">{t('accounts.failed', { message: loadableMessage(accounts, t) })}</Notice>
  }
  if (accounts.value.accounts.length === 0) {
    return <p className="loomy-muted">{t('accounts.empty')}</p>
  }

  const poolActive = (accounts.value.routes ?? []).some((route) => route.route === 'loomy-pool')

  return (
    <div className="loomy-account-rows">
      {accounts.value.accounts.map((row) => (
        <div className="loomy-account-row" key={row.id}>
          <div className="loomy-account-main">
            <span className="loomy-account-identity">{identityOf(row, t)}</span>
            <code className="loomy-code">{row.route}</code>
            {row.unavailable === true ? <Badge tone="danger">{t('accounts.unavailableBadge')}</Badge> : null}
            {row.origin === 'desktop' ? <Badge tone="neutral">{t('accounts.originDesktop')}</Badge> : null}
          </div>
          {row.origin === 'plugin' ? (
            <CardButton
              variant="ghost"
              onClick={() => onRemove(row.id)}
              disabled={removingId === row.id || csrfToken === null}
            >
              {removingId === row.id ? t('accounts.removing') : t('accounts.remove')}
            </CardButton>
          ) : null}
          {row.unavailable === true && row.unavailableMessage !== undefined ? (
            <p className="loomy-row-note">{row.unavailableMessage}</p>
          ) : null}
          {row.addedAt === undefined ? null : (
            <p className="loomy-row-note">{t('accounts.addedAtShort', { time: formatDateTime(row.addedAt) })}</p>
          )}
        </div>
      ))}
      {poolActive ? <p className="loomy-row-note">{t('accounts.poolNote')}</p> : null}
    </div>
  )
}

/** What to call this account: its label, else the phone, else its slot. */
function identityOf(row: LoomyAccountRow, t: LoomyT): string {
  const label = row.label?.trim()
  if (label !== undefined && label.length > 0) return label
  if (row.phone !== undefined && row.phone.length > 0) return row.phone
  return t('accounts.slotOnly', { slot: String(row.slot) })
}

/**
 * The account list — one compact line per account, desktop sign-in included.
 *
 * A row is deliberately one line: identity, its route, and any health badge.
 * Details that only matter occasionally (added time, why the pool skipped it)
 * go on a second, small line and only when they exist. The list replaced two
 * separate blocks, so it also has to stay short.
 *
 * @module dsh-connect-loomy/client/components/AccountsList
 */

import { useState } from 'react'
import type { LoomyAccountRow, LoomyAccounts } from '../api.js'
import { formatCount } from '../format.js'
import { Badge, CardButton, Notice } from './common.js'
import { type Loadable, loadableMessage, type LoomyT } from './types.js'

export interface AccountsListProps {
  t: LoomyT
  accounts: Loadable<LoomyAccounts>
  csrfToken: string | null
  removingId: string | null
  onRemove: (id: string) => void
  /** Materialize the desktop sign-in into a stored, routable account. */
  onAdoptDesktop: () => void
  adopting: boolean
  /** Copy that one account's bundle to the clipboard. */
  onExportRow: (id: string) => void
  exportingId: string | null
  /** Each account's own points, keyed by stored account id. */
  creditsByAccount?: Map<string, { available: number; total: number; error?: string }>
}

/** Removal is destructive — the session dies with the row — so it asks twice. */
type ConfirmState = { id: string } | null

/** Render every account as a compact row. */
export function AccountsList({
  t,
  accounts,
  csrfToken,
  removingId,
  onRemove,
  onAdoptDesktop,
  adopting,
  onExportRow,
  exportingId,
  creditsByAccount,
}: AccountsListProps) {
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  if (accounts.kind === 'idle' || accounts.kind === 'loading') return <p className="loomy-muted">{t('common.loading')}</p>
  if (accounts.kind === 'stale') return <Notice tone="error">{accounts.message}</Notice>
  if (accounts.kind === 'unavailable') return <p className="loomy-muted">{t('accounts.unavailable')}</p>
  if (accounts.kind === 'failed' || accounts.kind === 'error') {
    return <Notice tone="error">{t('accounts.failed', { message: loadableMessage(accounts, t) })}</Notice>
  }
  if (accounts.value.accounts.length === 0) {
    // Removing the last account takes the provider route with it, so the picker
    // loses its Loomy group entirely — say that, not just "empty".
    return <Notice tone="info">{t('accounts.emptyNoRoute')}</Notice>
  }

  return (
    <div className="loomy-acct-list">
      {accounts.value.accounts.map((row) => (
        <div className="loomy-acct-row" key={row.id}>
          <span className="loomy-acct-identity">{identityOf(row, t)}</span>
          {row.origin === 'desktop' && row.route.length === 0 ? (
            <span className="loomy-label">{t('accounts.notRouted')}</span>
          ) : null}
          {row.origin === 'desktop' ? <Badge tone="neutral">{t('accounts.originDesktop')}</Badge> : null}
          {balanceOf(row, creditsByAccount, t) === null ? null : (
            <span className="loomy-acct-credits">{balanceOf(row, creditsByAccount, t)}</span>
          )}
          {row.unavailable === true ? <Badge tone="danger">{t('accounts.unavailableBadge')}</Badge> : null}
          <span className="loomy-toolbar-spacer" />
          <span className="loomy-acct-actions">
            {row.origin === 'desktop' ? (
              <CardButton
                variant="ghost"
                onClick={onAdoptDesktop}
                disabled={adopting || csrfToken === null}
                title={t('accounts.adoptHint')}
              >
                {adopting ? t('accounts.adopting') : t('accounts.adopt')}
              </CardButton>
            ) : (
              <>
                <CardButton
                  variant="ghost"
                  onClick={() => onExportRow(row.id)}
                  disabled={exportingId === row.id || csrfToken === null}
                  title={t('accounts.exportRowHint')}
                >
                  {exportingId === row.id ? t('accounts.exporting') : t('accounts.exportRow')}
                </CardButton>
                {confirm?.id === row.id ? (
                  <>
                    <CardButton
                      variant="ghost"
                      onClick={() => {
                        setConfirm(null)
                        onRemove(row.id)
                      }}
                      disabled={removingId === row.id || csrfToken === null}
                    >
                      {removingId === row.id ? t('accounts.removing') : t('accounts.removeConfirm')}
                    </CardButton>
                    <CardButton variant="ghost" onClick={() => setConfirm(null)}>
                      {t('common.cancel')}
                    </CardButton>
                  </>
                ) : (
                  <CardButton
                    variant="ghost"
                    onClick={() => setConfirm({ id: row.id })}
                    disabled={removingId === row.id || csrfToken === null}
                    title={t('accounts.removeHint')}
                  >
                    {t('accounts.remove')}
                  </CardButton>
                )}
              </>
            )}
          </span>
          {row.unavailable === true && row.unavailableMessage !== undefined ? (
            <p className="loomy-row-note">{row.unavailableMessage}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** This account's own available balance, or null when unreadable/not routed. */
function balanceOf(
  row: LoomyAccountRow,
  creditsByAccount: Map<string, { available: number; total: number; error?: string }> | undefined,
  t: LoomyT,
): string | null {
  // The desktop row has no stored id, so it has no figure to show.
  if (creditsByAccount === undefined || row.origin === 'desktop') return null
  const entry = creditsByAccount.get(row.id)
  if (entry === undefined) return null
  if (entry.error !== undefined) return t('accounts.creditsError')
  return t('accounts.creditsInline', { available: formatCount(entry.available) })
}

/** What to call this account: its label, else the phone, else its slot. */
function identityOf(row: LoomyAccountRow, t: LoomyT): string {
  const label = row.label?.trim()
  if (label !== undefined && label.length > 0) return label
  if (row.phone !== undefined && row.phone.length > 0) return row.phone
  if (row.origin === 'desktop') return t('accounts.desktopSignIn')
  return t('accounts.slotOnly', { slot: String(row.slot) })
}

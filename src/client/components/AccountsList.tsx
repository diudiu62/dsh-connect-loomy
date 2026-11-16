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

import type { LoomyAccountRow, LoomyAccounts } from '../api.js'
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
}

/** Render every account as a compact row. */
export function AccountsList({
  t,
  accounts,
  csrfToken,
  removingId,
  onRemove,
  onAdoptDesktop,
  adopting,
}: AccountsListProps) {
  if (accounts.kind === 'idle' || accounts.kind === 'loading') return <p className="loomy-muted">{t('common.loading')}</p>
  if (accounts.kind === 'stale') return <Notice tone="error">{accounts.message}</Notice>
  if (accounts.kind === 'unavailable') return <p className="loomy-muted">{t('accounts.unavailable')}</p>
  if (accounts.kind === 'failed' || accounts.kind === 'error') {
    return <Notice tone="error">{t('accounts.failed', { message: loadableMessage(accounts, t) })}</Notice>
  }
  if (accounts.value.accounts.length === 0) return <p className="loomy-muted">{t('accounts.empty')}</p>

  return (
    <div className="loomy-rows">
      {accounts.value.accounts.map((row) => (
        <div className="loomy-row" key={row.id}>
          <span className="loomy-row-identity">{identityOf(row, t)}</span>
          {row.route.length > 0 ? (
            <code className="loomy-code">{row.route}</code>
          ) : (
            <span className="loomy-label">{t('accounts.notRouted')}</span>
          )}
          {row.origin === 'desktop' ? <Badge tone="neutral">{t('accounts.originDesktop')}</Badge> : null}
          {row.unavailable === true ? <Badge tone="danger">{t('accounts.unavailableBadge')}</Badge> : null}
          <span className="loomy-toolbar-spacer" />
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
            <CardButton
              variant="ghost"
              onClick={() => onRemove(row.id)}
              disabled={removingId === row.id || csrfToken === null}
            >
              {removingId === row.id ? t('accounts.removing') : t('accounts.remove')}
            </CardButton>
          )}
          {row.unavailable === true && row.unavailableMessage !== undefined ? (
            <p className="loomy-row-note">{row.unavailableMessage}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** What to call this account: its label, else the phone, else its slot. */
function identityOf(row: LoomyAccountRow, t: LoomyT): string {
  const label = row.label?.trim()
  if (label !== undefined && label.length > 0) return label
  if (row.phone !== undefined && row.phone.length > 0) return row.phone
  if (row.origin === 'desktop') return t('accounts.desktopSignIn')
  return t('accounts.slotOnly', { slot: String(row.slot) })
}

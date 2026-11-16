/**
 * The account list inside the account tab.
 *
 * Multi-account model: **one Loomy sign-in = one provider route**. This list is
 * therefore also the legend for the model picker — the route shown here is the
 * exact provider id a conversation binds to, which is why it is displayed
 * verbatim rather than invented wording.
 *
 * Rows are read-only about secrets: the host's view never carries a session, so
 * nothing here could leak one. The desktop row (slot 1, no stored account) has
 * no remove action because the plugin does not own that sign-in.
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
  /** Removing an account needs the CSRF token. */
  csrfToken: string | null
  /** Called with the row id after a successful removal. */
  onRemove: (id: string) => void
  /** Re-read the list. */
  onRefresh: () => void
  /** Id of the row currently being removed, to disable just that button. */
  removingId: string | null
}

/** Render the account rows. */
export function AccountsList({ t, accounts, csrfToken, onRemove, onRefresh, removingId }: AccountsListProps) {
  return (
    <div className="loomy-accounts">
      {accounts.kind === 'idle' || accounts.kind === 'loading' ? (
        <p className="loomy-muted">{t('common.loading')}</p>
      ) : accounts.kind === 'unavailable' ? (
        <p className="loomy-muted">{t('accounts.unavailable')}</p>
      ) : accounts.kind === 'failed' || accounts.kind === 'error' ? (
        <Notice tone="error">{t('accounts.failed', { message: loadableMessage(accounts, t) })}</Notice>
      ) : accounts.value.accounts.length === 0 ? (
        <Notice tone="info">{t('accounts.empty')}</Notice>
      ) : (
        <>
          <p className="loomy-muted">{t('accounts.intro')}</p>
          <div className="loomy-account-rows">
            {accounts.value.accounts.map((row) => (
              <AccountRow
                key={row.id}
                t={t}
                row={row}
                csrfToken={csrfToken}
                removing={removingId === row.id}
                onRemove={onRemove}
              />
            ))}
          </div>
        </>
      )}
      <div className="loomy-actions">
        <CardButton onClick={onRefresh}>{t('common.refresh')}</CardButton>
      </div>
    </div>
  )
}

function AccountRow({
  t,
  row,
  csrfToken,
  removing,
  onRemove,
}: {
  t: LoomyT
  row: LoomyAccountRow
  csrfToken: string | null
  removing: boolean
  onRemove: (id: string) => void
}) {
  const identity = row.label?.trim() || row.maskedPhone || t('accounts.unknownPhone')
  return (
    <div className="loomy-account-row">
      <div className="loomy-account-main">
        <span className="loomy-account-identity">{identity}</span>
        <Badge tone={row.origin === 'desktop' ? 'neutral' : 'ok'}>
          {row.origin === 'desktop' ? t('accounts.originDesktop') : t('accounts.originPlugin')}
        </Badge>
      </div>
      <div className="loomy-account-meta">
        <span className="loomy-label">{t('accounts.route')}</span>
        <code className="loomy-code">{row.route}</code>
        {row.maskedUserId === undefined ? null : (
          <>
            <span className="loomy-label">{t('accounts.userId')}</span>
            <span className="loomy-value">{row.maskedUserId}</span>
          </>
        )}
        {row.addedAt === undefined ? null : (
          <>
            <span className="loomy-label">{t('accounts.addedAt')}</span>
            <span className="loomy-value">{formatDateTime(row.addedAt)}</span>
          </>
        )}
      </div>
      {row.origin === 'plugin' ? (
        <div className="loomy-actions">
          <CardButton onClick={() => onRemove(row.id)} disabled={removing || csrfToken === null}>
            {removing ? t('accounts.removing') : t('accounts.remove')}
          </CardButton>
        </div>
      ) : (
        <p className="loomy-muted">{t('accounts.desktopNote')}</p>
      )}
    </div>
  )
}

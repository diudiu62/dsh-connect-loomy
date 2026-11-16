/**
 * Account tab — four zones, in the order a user needs them:
 *
 * 1. **当前账号** — one line: who is in effect, where it came from, which route.
 *    Everything else (credential path, next steps) appears only when it is
 *    actionable, so the normal case is a single line.
 * 2. **账号** — every account as a row, with its route and pool health.
 * 3. **添加账号** — collapsed until asked for: SMS login, paste-import, export.
 * 4. **积分** — balances and the recent ledger.
 *
 * Signed out is a normal state, not an error: the host's own `nextSteps` are
 * rendered verbatim and only a transport failure turns red.
 *
 * @module dsh-connect-loomy/client/components/AccountTab
 */

import type { LoomyAccounts, LoomyAuthState, LoomyCredits, LoomyStatus } from '../api.js'
import { formatCount, formatDateTime } from '../format.js'
import { AccountsList } from './AccountsList.js'
import { AddAccountPanel } from './AddAccountPanel.js'
import { Badge, CardButton, FactRow, Notice, Section } from './common.js'
import { loadableMessage, type Loadable, type LoomyT } from './types.js'

/** Props supplied by the card shell. */
export interface AccountTabProps {
  t: LoomyT
  status: Loadable<LoomyStatus>
  credits: Loadable<LoomyCredits>
  redetecting: boolean
  onRedetect: () => void
  onRetryCredits: () => void
  csrfToken: string | null
  authState: LoomyAuthState | null
  onAuthChanged: () => void
  signal?: AbortSignal
  accounts: Loadable<LoomyAccounts>
  removingId: string | null
  onRemoveAccount: (id: string) => void
  onRefreshAccounts: () => void
  onExportAccounts: () => void
  onImportAccounts: (text: string) => void
  exporting: boolean
  importing: boolean
  transferNotice: string | null
  transferError: string | null
}

/** Render the account tab. */
export function AccountTab(props: AccountTabProps) {
  const { t, status, credits, redetecting, onRedetect, onRetryCredits, accounts } = props
  const accountCount = accounts.kind === 'ready' ? accounts.value.accounts.length : null

  return (
    <div className="loomy-panel">
      <Section
        title={t('account.title')}
        actions={
          <>
            {status.kind === 'ready' ? (
              status.value.account === null ? (
                <Badge tone="danger">{t('account.loggedOut')}</Badge>
              ) : (
                <Badge tone="ok">{t('account.loggedIn')}</Badge>
              )
            ) : null}
            <CardButton onClick={onRedetect} disabled={redetecting}>
              {redetecting ? t('account.redetecting') : t('account.redetect')}
            </CardButton>
          </>
        }
      >
        <CurrentAccount t={t} status={status} authState={props.authState} />
      </Section>

      <Section
        title={accountCount === null ? t('accounts.title') : t('accounts.titleCount', { count: String(accountCount) })}
        actions={
          <CardButton variant="ghost" onClick={props.onRefreshAccounts}>
            {t('common.refresh')}
          </CardButton>
        }
      >
        <AccountsList
          t={t}
          accounts={accounts}
          csrfToken={props.csrfToken}
          removingId={props.removingId}
          onRemove={props.onRemoveAccount}
        />
      </Section>

      <Section title={t('add.title')}>
        <AddAccountPanel
          t={t}
          csrfToken={props.csrfToken}
          authState={props.authState}
          onAuthChanged={props.onAuthChanged}
          {...(props.signal === undefined ? {} : { signal: props.signal })}
          onImport={props.onImportAccounts}
          onExport={props.onExportAccounts}
          exporting={props.exporting}
          importing={props.importing}
          notice={props.transferNotice}
          error={props.transferError}
        />
      </Section>

      <Section
        title={t('account.credits')}
        actions={
          credits.kind === 'failed' || credits.kind === 'error' ? (
            <CardButton onClick={onRetryCredits}>{t('common.refresh')}</CardButton>
          ) : null
        }
      >
        <CreditsBody t={t} credits={credits} />
      </Section>
    </div>
  )
}

/** One line of "who is in effect"; details only when they are actionable. */
function CurrentAccount({
  t,
  status,
  authState,
}: {
  t: LoomyT
  status: Loadable<LoomyStatus>
  authState: LoomyAuthState | null
}) {
  if (status.kind === 'idle' || status.kind === 'loading') {
    return <p className="loomy-muted">{t('common.loading')}</p>
  }
  if (status.kind === 'unavailable') return <Notice tone="error">{t('card.hostUnavailable')}</Notice>
  if (status.kind === 'stale') return <Notice tone="error">{status.message}</Notice>
  if (status.kind === 'failed' || status.kind === 'error') {
    return <Notice tone="error">{t('card.statusError', { message: loadableMessage(status, t) })}</Notice>
  }

  const { account, credential, nextSteps } = status.value
  const source =
    authState === null
      ? null
      : authState.effectiveSource === 'plugin'
        ? t('login.sourcePlugin')
        : authState.effectiveSource === 'desktop'
          ? t('login.sourceDesktop')
          : authState.effectiveSource === 'env'
            ? t('login.sourceEnv')
            : t('login.sourceNone')

  if (account === null) {
    const steps =
      nextSteps !== undefined && nextSteps.length > 0
        ? nextSteps
        : [t('account.nextStep.login'), t('account.nextStep.staySignedIn'), t('account.nextStep.recheck')]
    return (
      <div className="loomy-panel">
        <FactRow label={t('account.credential')}>
          {t('account.credentialMissing', { path: credential.sourcePath })}
        </FactRow>
        <div>
          <div className="loomy-section-title">{t('account.nextSteps')}</div>
          <ol className="loomy-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
    )
  }

  return (
    <div className="loomy-panel">
      <div className="loomy-account-main">
        <span className="loomy-current-account">{account.phone}</span>
        {source === null ? null : <Badge tone="neutral">{source}</Badge>}
        {account.route === undefined ? null : (
          <span className="loomy-muted">{t('account.routeOf', { route: account.route })}</span>
        )}
      </div>
      <p className="loomy-row-note">
        {t('account.signedInAt', { time: formatDateTime(account.loginAt) })} ·{' '}
        {credential.found
          ? t('account.credentialFound', { path: credential.sourcePath })
          : t('account.credentialMissing', { path: credential.sourcePath })}
      </p>
      {account.userId === undefined ? null : (
        <p className="loomy-row-note">{t('account.userIdShort', { userId: account.userId })}</p>
      )}
    </div>
  )
}

function CreditsBody({ t, credits }: { t: LoomyT; credits: Loadable<LoomyCredits> }) {
  if (credits.kind === 'idle' || credits.kind === 'loading') {
    return <p className="loomy-muted">{t('common.loading')}</p>
  }
  if (credits.kind === 'unavailable') return <p className="loomy-muted">{t('account.credits.unavailable')}</p>
  if (credits.kind === 'stale') return <Notice tone="error">{credits.message}</Notice>
  if (credits.kind === 'failed' || credits.kind === 'error') {
    return <Notice tone="error">{t('account.credits.failed', { message: loadableMessage(credits, t) })}</Notice>
  }

  const value = credits.value
  return (
    <div className="loomy-panel">
      <div className="loomy-credits">
        <div className="loomy-credit-cell">
          <span className="loomy-label">{t('account.credits.available')}</span>
          <span className="loomy-credit-value">{formatCount(value.availableBalance)}</span>
        </div>
        <div className="loomy-credit-cell">
          <span className="loomy-label">{t('account.credits.balance')}</span>
          <span className="loomy-credit-value">{formatCount(value.balance)}</span>
        </div>
        <div className="loomy-credit-cell">
          <span className="loomy-label">{t('account.credits.daily')}</span>
          <span className="loomy-credit-value">{formatCount(value.dailyBalance)}</span>
        </div>
      </div>
      {value.records.length === 0 ? null : (
        <div className="loomy-records">
          {value.records.slice(0, 3).map((record, index) => (
            <div className="loomy-record" key={`${record.createdAt}-${index}`}>
              <span className="loomy-value">{record.description.length > 0 ? record.description : t('common.none')}</span>
              <span className={record.direction === 'credit' ? 'loomy-record-positive' : 'loomy-record-negative'}>
                {record.direction === 'credit' ? '+' : '-'}
                {formatCount(record.pointsActual)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

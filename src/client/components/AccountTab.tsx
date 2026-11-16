/**
 * Account tab: local sign-in state, credential conclusion and the read-only
 * points overview.
 *
 * Signed out is a normal state here, not an error: the card shows the host's
 * executable `nextSteps` (with locale fallbacks when the host sent none), the
 * credential path it looked at, and the same “Re-check” action as when signed
 * in. Only a transport failure renders as an error.
 *
 * @module dsh-connect-loomy/client/components/AccountTab
 */

import type { LoomyAccounts, LoomyAuthState, LoomyCredits, LoomyStatus } from '../api.js'
import { formatCount, formatDateTime } from '../format.js'
import { Badge, CardButton, FactRow, Notice, Section } from './common.js'
import { LoginForm } from './LoginForm.js'
import { AccountsList } from './AccountsList.js'
import { loadableMessage, type Loadable, type LoomyT } from './types.js'

/** Props supplied by the card shell. */
export interface AccountTabProps {
  t: LoomyT
  status: Loadable<LoomyStatus>
  credits: Loadable<LoomyCredits>
  redetecting: boolean
  onRedetect: () => void
  onRetryCredits: () => void
  /** Process CSRF token; the login form's two writes need it. */
  csrfToken: string | null
  /** Plugin-side sign-in state (drives the login form's branch). */
  authState: LoomyAuthState | null
  /** Re-read /status after a login or logout. */
  onAuthChanged: () => void
  /** Abort signal for the login calls. */
  signal?: AbortSignal
  /** Every account the plugin routes to (one row per provider route). */
  accounts: Loadable<LoomyAccounts>
  /** Row id currently being removed. */
  removingId: string | null
  onRemoveAccount: (id: string) => void
  onRefreshAccounts: () => void
}

/** Render the account tab. */
export function AccountTab({
  t,
  status,
  credits,
  redetecting,
  onRedetect,
  onRetryCredits,
  csrfToken,
  authState,
  onAuthChanged,
  signal,
  accounts,
  removingId,
  onRemoveAccount,
  onRefreshAccounts,
}: AccountTabProps) {
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
        <SignInBody t={t} status={status} onRedetect={onRedetect} />
      </Section>

      <Section
        title={t('login.title')}
        actions={
          authState === null ? null : (
            <Badge tone={authState.pluginLoggedIn ? 'ok' : 'neutral'}>
              {authState.effectiveSource === 'plugin'
                ? t('login.sourcePlugin')
                : authState.effectiveSource === 'desktop'
                  ? t('login.sourceDesktop')
                  : authState.effectiveSource === 'env'
                    ? t('login.sourceEnv')
                    : t('login.sourceNone')}
            </Badge>
          )
        }
      >
        <LoginForm
          t={t}
          csrfToken={csrfToken}
          authState={authState}
          onChanged={onAuthChanged}
          {...(signal === undefined ? {} : { signal })}
        />
      </Section>

      <Section title={t('accounts.title')}>
        <AccountsList
          t={t}
          accounts={accounts}
          csrfToken={csrfToken}
          onRemove={onRemoveAccount}
          onRefresh={onRefreshAccounts}
          removingId={removingId}
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

function SignInBody({ t, status }: { t: LoomyT; status: Loadable<LoomyStatus>; onRedetect: () => void }) {
  if (status.kind === 'idle' || status.kind === 'loading') {
    return <p className="loomy-muted">{t('common.loading')}</p>
  }
  if (status.kind === 'unavailable') {
    return <Notice tone="error">{t('card.hostUnavailable')}</Notice>
  }
  if (status.kind === 'failed' || status.kind === 'error') {
    return <Notice tone="error">{t('card.statusError', { message: loadableMessage(status, t) })}</Notice>
  }

  const { account, credential, nextSteps } = status.value
  const steps =
    account === null
      ? nextSteps !== undefined && nextSteps.length > 0
        ? nextSteps
        : [t('account.nextStep.login'), t('account.nextStep.staySignedIn'), t('account.nextStep.recheck')]
      : []

  return (
    <div className="loomy-panel">
      <FactRow label={t('account.phone')}>
        {account === null ? t('common.none') : account.maskedPhone}
      </FactRow>
      <FactRow label={t('account.loginAt')}>
        {account === null ? t('common.none') : formatDateTime(account.loginAt)}
      </FactRow>
      <FactRow label={t('account.credential')}>
        {credential.found
          ? t('account.credentialFound', { path: credential.sourcePath })
          : t('account.credentialMissing', { path: credential.sourcePath })}
      </FactRow>

      {steps.length > 0 ? (
        <div>
          <div className="loomy-section-title">{t('account.nextSteps')}</div>
          <ol className="loomy-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

function CreditsBody({ t, credits }: { t: LoomyT; credits: Loadable<LoomyCredits> }) {
  if (credits.kind === 'idle' || credits.kind === 'loading') {
    return <p className="loomy-muted">{t('common.loading')}</p>
  }
  if (credits.kind === 'unavailable') {
    return <p className="loomy-muted">{t('account.credits.unavailable')}</p>
  }
  if (credits.kind === 'failed' || credits.kind === 'error') {
    return (
      <Notice tone="error">{t('account.credits.failed', { message: loadableMessage(credits, t) })}</Notice>
    )
  }

  const value = credits.value
  return (
    <div className="loomy-panel">
      <div className="loomy-credits">
        <div className="loomy-credit-cell">
          <span className="loomy-label">{t('account.credits.balance')}</span>
          <span className="loomy-credit-value">{formatCount(value.balance)}</span>
        </div>
        <div className="loomy-credit-cell">
          <span className="loomy-label">{t('account.credits.available')}</span>
          <span className="loomy-credit-value">{formatCount(value.availableBalance)}</span>
        </div>
        <div className="loomy-credit-cell">
          <span className="loomy-label">{t('account.credits.daily')}</span>
          <span className="loomy-credit-value">{formatCount(value.dailyBalance)}</span>
        </div>
      </div>
      <p className="loomy-muted">{t('account.credits.fetchedAt', { time: formatDateTime(value.fetchedAt) })}</p>

      <div>
        <div className="loomy-section-title">{t('account.credits.records')}</div>
        {value.records.length === 0 ? (
          <p className="loomy-muted">{t('account.credits.emptyRecords')}</p>
        ) : (
          <div className="loomy-records">
            {value.records.slice(0, 5).map((record, index) => (
              <div className="loomy-record" key={`${record.createdAt}-${index}`}>
                <span className="loomy-value">
                  {record.description.length > 0 ? record.description : t('common.none')}
                </span>
                <span
                  className={
                    record.direction === 'credit' ? 'loomy-record-positive' : 'loomy-record-negative'
                  }
                >
                  {record.direction === 'credit' ? '+' : '-'}
                  {formatCount(record.pointsActual)}
                </span>
                <span className="loomy-muted">{formatDateTime(record.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

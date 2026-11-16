/**
 * The body of the "add account" flow: SMS login or paste-import.
 *
 * The buttons that open it live in the section's top-right toolbar (see
 * AccountTab), so this component renders **only** the expanded form — the
 * section header owns the actions, the way every other panel header does.
 *
 * @module dsh-connect-loomy/client/components/AddAccountPanel
 */

import type { LoomyAuthState } from '../api.js'
import { CardButton, Notice } from './common.js'
import { LoginForm } from './LoginForm.js'
import type { LoomyT } from './types.js'

/** Which add flow is open. `null` means none. */
export type AddMode = 'login' | 'transfer' | null

export interface AddAccountPanelProps {
  t: LoomyT
  mode: Exclude<AddMode, null>
  csrfToken: string | null
  authState: LoomyAuthState | null
  onAuthChanged: () => void
  signal?: AbortSignal
  onImport: (text: string) => void
  importing: boolean
  text: string
  onText: (value: string) => void
  notice: string | null
  error: string | null
}

/** Render the expanded add-account form. */
export function AddAccountPanel({
  t,
  mode,
  csrfToken,
  authState,
  onAuthChanged,
  signal,
  onImport,
  importing,
  text,
  onText,
  notice,
  error,
}: AddAccountPanelProps) {
  return (
    <div className="loomy-add-body">
      {mode === 'login' ? (
        <LoginForm
          t={t}
          csrfToken={csrfToken}
          authState={authState}
          onChanged={onAuthChanged}
          {...(signal === undefined ? {} : { signal })}
        />
      ) : (
        <>
          <p className="loomy-row-note">{t('add.transferHint')}</p>
          <textarea
            className="loomy-input loomy-textarea"
            placeholder={t('add.pastePlaceholder')}
            value={text}
            rows={3}
            onChange={(event) => onText(event.target.value)}
          />
          <div className="loomy-actions">
            <CardButton
              onClick={() => onImport(text)}
              disabled={importing || csrfToken === null || text.trim().length === 0}
            >
              {importing ? t('accounts.importing') : t('add.import')}
            </CardButton>
          </div>
        </>
      )}
      {notice === null ? null : <Notice tone="ok">{notice}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </div>
  )
}

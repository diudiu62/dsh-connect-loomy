/**
 * "Add account" panel: SMS login and bundle import, behind one toggle.
 *
 * Both actions share a purpose — put another account into the list — so they
 * share one zone and one expandable panel instead of occupying two always-open
 * sections. Collapsed by default: the common case is *reading* the account
 * list, not adding to it.
 *
 * @module dsh-connect-loomy/client/components/AddAccountPanel
 */

import { useState } from 'react'
import type { LoomyAuthState } from '../api.js'
import { CardButton, Notice } from './common.js'
import { LoginForm } from './LoginForm.js'
import type { LoomyT } from './types.js'

export interface AddAccountPanelProps {
  t: LoomyT
  csrfToken: string | null
  authState: LoomyAuthState | null
  onAuthChanged: () => void
  signal?: AbortSignal
  onImport: (text: string) => void
  onExport: () => void
  exporting: boolean
  importing: boolean
  notice: string | null
  error: string | null
}

type Mode = 'login' | 'transfer'

/** Render the collapsed "add" affordances, expanding into one mode at a time. */
export function AddAccountPanel({
  t,
  csrfToken,
  authState,
  onAuthChanged,
  signal,
  onImport,
  onExport,
  exporting,
  importing,
  notice,
  error,
}: AddAccountPanelProps) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [text, setText] = useState('')

  return (
    <div className="loomy-add">
      {/* Sits exactly where the next account row would: adding is one more
          line in the list, not a separate destination. */}
      <div className="loomy-row loomy-add-row">
        <span className="loomy-row-identity">{t('add.title')}</span>
        <CardButton
          variant={mode === 'login' ? 'primary' : 'ghost'}
          onClick={() => setMode(mode === 'login' ? null : 'login')}
        >
          {t('add.login')}
        </CardButton>
        <CardButton
          variant={mode === 'transfer' ? 'primary' : 'ghost'}
          onClick={() => setMode(mode === 'transfer' ? null : 'transfer')}
        >
          {t('add.transfer')}
        </CardButton>
        <CardButton variant="ghost" onClick={onExport} disabled={exporting || importing || csrfToken === null}>
          {exporting ? t('accounts.exporting') : t('add.export')}
        </CardButton>
      </div>

      {mode === 'login' ? (
        <div className="loomy-add-body">
          <LoginForm
            t={t}
            csrfToken={csrfToken}
            authState={authState}
            onChanged={onAuthChanged}
            {...(signal === undefined ? {} : { signal })}
          />
        </div>
      ) : null}

      {mode === 'transfer' ? (
        <div className="loomy-add-body">
          <p className="loomy-row-note">{t('add.transferHint')}</p>
          <textarea
            className="loomy-input loomy-textarea"
            placeholder={t('add.pastePlaceholder')}
            value={text}
            rows={3}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="loomy-actions">
            <CardButton
              onClick={() => onImport(text)}
              disabled={importing || exporting || csrfToken === null || text.trim().length === 0}
            >
              {importing ? t('accounts.importing') : t('add.import')}
            </CardButton>
          </div>
        </div>
      ) : null}

      {notice === null ? null : <Notice tone="ok">{notice}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </div>
  )
}

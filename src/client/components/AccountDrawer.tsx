/**
 * The account drawer: everything about accounts, opened from the composer badge.
 *
 * Account switching used to happen in the model picker, which meant a second
 * picker group per sign-in and made "which account pays" look like "which model
 * am I using". The drawer keeps that decision where the result is visible: the
 * badge in the composer opens this list and the badge itself says who is active.
 *
 * Design constraints:
 * - the badge is 24px tall in a `flex:none` cluster, so the panel is absolutely
 *   positioned and must not widen the composer;
 * - it closes on outside click and on Escape, and only one instance exists;
 * - every action is a host call; the panel never guesses at state.
 *
 * @module dsh-connect-loomy/client/components/AccountDrawer
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchAccounts,
  fetchActiveAccount,
  fetchPool,
  savePool,
  setActiveAccount,
  type LoomyAccountRow,
  type LoomyActiveAccount,
  type LoomyPoolState,
} from '../api.js'
import { formatCount } from '../format.js'
import type { LoomyT } from './types.js'

export interface AccountDrawerProps {
  t: LoomyT
  /** CSRF token, read from /status by the badge before opening. */
  csrfToken: string | null
  /** Per-route points, so each row can show what it has. */
  creditsByAccount: Map<string, { available: number; error?: string }>
  onClose: () => void
  /** Called after any change so the badge can re-read its figure. */
  onChanged: () => void
  /**
   * Re-read the points from upstream, bypassing the host cache. The figures in
   * this panel live in the badge's state, so the drawer asks the badge to fetch
   * rather than reading /credits a second time.
   */
  onRefreshCredits: () => void
}

/** Render the drawer panel. */
export function AccountDrawer({ t, csrfToken, creditsByAccount, onClose, onChanged, onRefreshCredits }: AccountDrawerProps) {
  const [accounts, setAccounts] = useState<LoomyAccountRow[] | null>(null)
  const [active, setActive] = useState<LoomyActiveAccount | null>(null)
  const [pool, setPool] = useState<LoomyPoolState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    const [list, activeState, poolState] = await Promise.all([
      fetchAccounts({ signal: controller.signal }),
      fetchActiveAccount({ signal: controller.signal }),
      fetchPool({ signal: controller.signal }),
    ])
    if (list.kind === 'ok') setAccounts(list.value.accounts)
    if (activeState.kind === 'ok') setActive(activeState.value)
    if (poolState.kind === 'ok') setPool(poolState.value)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Close on Escape and on a click outside: a panel anchored over a conversation
  // must never trap the pointer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: MouseEvent): void => {
      const node = panelRef.current
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [onClose])

  /** One press: re-read the account list and the points behind it. */
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      await load()
      onRefreshCredits()
    } finally {
      setRefreshing(false)
    }
  }

  const select = async (id: string): Promise<void> => {
    if (csrfToken === null) return
    setBusy(id)
    setError(null)
    try {
      const result = await setActiveAccount(csrfToken, id)
      if (result.kind !== 'ok' || !result.value.ok) {
        setError(
          result.kind === 'ok'
            ? (result.value.error?.message ?? t('drawer.switchFailed'))
            : result.kind === 'unavailable'
              ? t('accounts.unavailable')
              : result.message,
        )
        return
      }
      setActive(result.value)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const togglePool = async (enabled: boolean): Promise<void> => {
    if (csrfToken === null) return
    setBusy('pool')
    setError(null)
    try {
      const result = await savePool(csrfToken, enabled)
      if (result.kind !== 'ok' || !result.value.ok) {
        setError(t('pool.failed'))
        return
      }
      setPool(result.value)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const rotating = pool !== null && pool.enabled && (accounts?.length ?? 0) > 1

  return (
    <div className="loomy-drawer" ref={panelRef} role="dialog" aria-label={t('drawer.title')}>
      <div className="loomy-drawer-head">
        <span className="loomy-section-title">{t('drawer.title')}</span>
        <button
          type="button"
          className="loomy-drawer-refresh"
          disabled={refreshing}
          onClick={() => void refresh()}
          title={t('drawer.refreshHint')}
          aria-label={t('drawer.refresh')}
        >
          {refreshing ? '⋯' : '⟳'}
        </button>
        <button type="button" className="loomy-drawer-close" onClick={onClose} aria-label={t('drawer.close')}>
          ×
        </button>
      </div>

      <label className="loomy-drawer-pool">
        <input
          type="checkbox"
          checked={pool?.enabled === true}
          disabled={busy !== null || csrfToken === null}
          onChange={(event) => void togglePool(event.target.checked)}
        />
        <span>{t('pool.label')}</span>
      </label>
      {pool?.enabled === true && (accounts?.length ?? 0) < 2 ? (
        <p className="loomy-row-note">{t('pool.needsTwo')}</p>
      ) : null}

      <div className="loomy-drawer-list">
        {accounts === null ? (
          <p className="loomy-muted">{t('common.loading')}</p>
        ) : accounts.length === 0 ? (
          <p className="loomy-muted">{t('drawer.empty')}</p>
        ) : (
          accounts.map((row) => {
            const isActive = rotating ? false : active?.activeId === row.id
                    const credits = creditsByAccount.get(row.id)
            return (
              <button
                type="button"
                key={row.id}
                className={`loomy-drawer-row${isActive ? ' loomy-drawer-row-active' : ''}`}
                onClick={() => row.origin === 'desktop' || row.id.startsWith('desktop-') ? undefined : void select(row.id)}
                disabled={rotating || busy !== null || row.id.startsWith('desktop-')}
                title={row.id.startsWith('desktop-') ? t('drawer.desktopHint') : undefined}
              >
                <span className="loomy-drawer-identity">{row.label?.trim() || row.phone || row.displayName}</span>
                {isActive ? <span className="loomy-drawer-check">✓</span> : null}
                {credits === undefined ? null : (
                  <span className="loomy-drawer-credits">
                    {credits.error === undefined ? formatCount(credits.available) : t('accounts.creditsError')}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>

      {rotating ? <p className="loomy-row-note">{t('drawer.rotating')}</p> : null}
      {error === null ? null : <p className="loomy-row-note loomy-error">{error}</p>}
      <p className="loomy-row-note">{t('drawer.footHint')}</p>
    </div>
  )
}

/**
 * The settings card shell registered into `settings.section` (settings sidebar).
 *
 * Ownership split: this component owns *all* mutable state (active tab,
 * draft, in-flight flags) so nothing is lost when the user switches tabs; the
 * three tab components below are pure projections of that state. The card never
 * receives a session or a phone number from the host — only `/status`'s masked
 * account and counts.
 *
 * Lifecycle: reads are abortable and tied to the card's mounted lifetime; the
 * tab registration itself is disposed by the slot registry. A render error is
 * contained by `CardErrorBoundary`, so a bad payload cannot take down the rest
 * of the settings page.
 *
 * @module dsh-connect-loomy/client/components/Card
 */

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  fetchCredits,
  fetchDiagnostics,
  describeError,
  fetchStatus,
  adoptDesktopAccount,
  exportAccounts,
  fetchAccounts,
  fetchPool,
  fetchAuthState,
  importAccounts,
  isAbortError,
  removeAccount,
  readEnabledModelIds,
  refreshCatalog,
  saveEnabledModels,
  savePool,
  type LoomyAccounts,
  type LoomyAuthState,
  type LoomyPoolState,
  type LoomyCatalog,
  type LoomyCredits,
  type LoomyDiagnostics,
  type LoomyStatus,
} from '../api.js'
import { copyToClipboard } from '../clipboard.js'
import {
  applyBaseline,
  commitSaved,
  createDraft,
  discardChanges,
  enabledIdsFromCatalog,
  toggleModel,
  type ModelDraft,
} from '../draft.js'
import { formatDiagnosticsReport } from '../format.js'
import type { LoomyLocaleKey } from '../locale.js'
import {
  COMMUNITY,
  communityChannels,
  communityHref,
  type CommunityChannel,
} from '../../shared/community.js'
import { ensureStyles } from '../styles.js'
import { AccountTab } from './AccountTab.js'
import { DiagnosticsTab, type CopyState } from './DiagnosticsTab.js'
import { ModelsTab } from './ModelsTab.js'
import { CardButton, Notice } from './common.js'
import { mapResult, type Loadable, type LoomyT } from './types.js'

/** Selectable card sections. */
type TabKey = 'account' | 'models' | 'diagnostics'

/**
 * Locale key per contact slot.
 *
 * The values live in `src/shared/community.ts`; only their *labels* belong to
 * the dictionary, so no UI copy is hard-coded in this component.
 */
const CHANNEL_LABEL: Record<CommunityChannel, LoomyLocaleKey> = {
  issues: 'community.issues',
  qqGroup: 'community.qqGroup',
  wechat: 'community.wechat',
  email: 'community.email',
}

/**
 * Contacts worth showing.
 *
 * Computed once at module load: `communityChannels()` already drops the
 * `[PLACEHOLDER]` entries, so an unreleased group number cannot render as a
 * dead invitation, and a release that fills one in needs no code change.
 */
const CONTACTS = communityChannels()

/** Props composed by the slot framework: the translate seat, plus the surface. */
export interface LoomySettingsCardProps {
  t: LoomyT
  /**
   * `'settings'` when the shell registered this as a settings *section*: it then
   * owns the panel chrome (title, close), so repeating our own title here would
   * print the page name twice. The explanatory subtitle stays either way.
   */
  surface?: string
}

function errorMessage(t: LoomyT, error: unknown): string {
  return t('errors.network', { message: describeError(error) })
}

/**
 * Counters shown in diagnostics: prefer the live catalog (a refresh may have
 * moved total/enabled past `/status`), then fall back to `/status`.
 */
function catalogCountsOf(
  status: Loadable<LoomyStatus>,
  catalog: Loadable<LoomyCatalog>,
  draft: ModelDraft | null,
): { total: number; enabled: number } | null {
  if (catalog.kind === 'ready') {
    const total = catalog.value.catalog.length
    if (draft !== null) return { total, enabled: draft.saved.length }
    if (status.kind === 'ready') return { total, enabled: status.value.catalog.enabled }
    return { total, enabled: catalog.value.catalog.filter((model) => model.enabled === true).length }
  }
  if (status.kind === 'ready') {
    return { total: status.value.catalog.total, enabled: status.value.catalog.enabled }
  }
  return null
}

/**
 * Slot entry: the error boundary must be the *outermost* element so it can
 * catch a throw from the card body (JSX children are evaluated eagerly, so a
 * boundary inside the card's own return could never catch its own render).
 */
export function LoomySettingsCard({ t, surface }: LoomySettingsCardProps) {
  return (
    <CardErrorBoundary t={t}>
      <LoomyCard t={t} surface={surface} />
    </CardErrorBoundary>
  )
}

/** Render the Loomy settings card (one section of the settings sidebar). */
function LoomyCard({ t, surface }: LoomySettingsCardProps) {
  const [tab, setTab] = useState<TabKey>('account')
  const [status, setStatus] = useState<Loadable<LoomyStatus>>({ kind: 'loading' })
  const [credits, setCredits] = useState<Loadable<LoomyCredits>>({ kind: 'loading' })
  const [diagnostics, setDiagnostics] = useState<Loadable<LoomyDiagnostics>>({ kind: 'idle' })
  const [catalog, setCatalog] = useState<Loadable<LoomyCatalog>>({ kind: 'idle' })
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [baselineKnown, setBaselineKnown] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [redetecting, setRedetecting] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [authState, setAuthState] = useState<LoomyAuthState | null>(null)
  const [accounts, setAccounts] = useState<Loadable<LoomyAccounts>>({ kind: 'idle' })
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [transferNotice, setTransferNotice] = useState<string | null>(null)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [pool, setPool] = useState<LoomyPoolState | null>(null)
  const [poolSaving, setPoolSaving] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)

  /**
   * accountId → that account's own points.
   *
   * Keyed by account, not route: every account shares the single `loomy` route,
   * so a route key collapsed them onto one row's worth of numbers.
   */
  const creditsByAccount = useMemo(() => {
    const map = new Map<string, { available: number; total: number; error?: string }>()
    if (credits.kind !== 'ready') return map
    for (const entry of credits.value.perAccount ?? []) {
      const key = entry.accountId ?? entry.route
      map.set(key, {
        available: entry.availableBalance,
        total: entry.balance,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })
    }
    return map
  }, [credits])

  const abortRef = useRef<AbortController | null>(null)
  const csrfRef = useRef<string | null>(null)
  const autoCatalogRef = useRef(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    setStatus({ kind: 'loading' })
    try {
      const result = await fetchStatus({ signal: abortRef.current?.signal })
      setStatus(mapResult(result))
      if (result.kind !== 'ok') return
      const token = result.value.csrfToken
      csrfRef.current = typeof token === 'string' && token.length > 0 ? token : null
      const enabledIds = readEnabledModelIds(result.value)
      setBaselineKnown(enabledIds !== null)
      if (enabledIds !== null) {
        setDraft((previous) => (previous === null ? createDraft(enabledIds) : applyBaseline(previous, enabledIds)))
      }
    } catch (error) {
      if (isAbortError(error)) return
      setStatus({ kind: 'error', code: 'network', message: errorMessage(t, error) })
    }
  }, [t])

  const loadAuthState = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchAuthState({ signal: abortRef.current?.signal })
      if (result.kind === 'ok') setAuthState(result.value)
    } catch (error) {
      if (isAbortError(error)) return
      // The login block is auxiliary; a failure here keeps the card usable and
      // the form simply renders its signed-out branch.
    }
  }, [])

  const loadPool = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchPool({ signal: abortRef.current?.signal })
      if (result.kind === 'ok') setPool(result.value)
    } catch (error) {
      if (isAbortError(error)) return
      // The switch is auxiliary: a failed read leaves it hidden, the list works.
    }
  }, [])

  const loadCredits = useCallback(async (): Promise<void> => {
    setCredits({ kind: 'loading' })
    try {
      setCredits(mapResult(await fetchCredits({ signal: abortRef.current?.signal })))
    } catch (error) {
      if (isAbortError(error)) return
      setCredits({ kind: 'error', code: 'network', message: errorMessage(t, error) })
    }
  }, [t])

  const loadAccounts = useCallback(async (): Promise<void> => {
    setAccounts({ kind: 'loading' })
    try {
      setAccounts(mapResult(await fetchAccounts({ signal: abortRef.current?.signal })))
    } catch (error) {
      if (isAbortError(error)) return
      setAccounts({ kind: 'error', code: 'network', message: errorMessage(t, error) })
    }
  }, [t])

  /**
   * One refresh for the whole accounts panel.
   *
   * An import or an adopt changes which accounts exist, so the points figures
   * and the route list go stale together; the 刷新 button and the post-import
   * path must both move all four, never one of them.
   */
  const refreshAccountsPanel = useCallback(async (): Promise<void> => {
    await Promise.all([loadAccounts(), loadStatus(), loadCredits(), loadPool()])
  }, [loadAccounts, loadStatus, loadCredits, loadPool])

  const removeAccountRow = useCallback(async (id: string): Promise<void> => {
    const token = csrfRef.current
    if (token === null) return
    setRemovingId(id)
    try {
      const result = await removeAccount(token, id, { signal: abortRef.current?.signal })
      if (result.kind === 'ok' && result.value.ok) {
        await loadAccounts()
        // The route set changed, so both the picker and the status counters did.
        await loadStatus()
        return
      }
      setNotice(null)
      if (result.kind === 'unavailable') setSaveError(t('accounts.unavailable'))
      else if (result.kind === 'ok') setSaveError(t('accounts.removeFailed'))
      else setSaveError(result.message)
    } catch (error) {
      if (isAbortError(error)) return
      setSaveError(errorMessage(t, error))
    } finally {
      setRemovingId(null)
    }
  }, [refreshAccountsPanel, t])

  const exportAccountsNow = useCallback(async (): Promise<void> => {
    const token = csrfRef.current
    if (token === null) return
    setExporting(true)
    setTransferNotice(null)
    setTransferError(null)
    try {
      const result = await exportAccounts(token, { signal: abortRef.current?.signal })
      if (result.kind !== 'ok') {
        setTransferError(result.kind === 'unavailable' ? t('accounts.unavailable') : result.message)
        return
      }
      if (!result.value.ok || result.value.bundle === undefined) {
        setTransferError(result.value.error?.message ?? t('accounts.exportEmpty'))
        return
      }
      // The bundle is the credential; it goes to the clipboard only because the
      // user pressed a button that says exactly that.
      const text = JSON.stringify(result.value.bundle, undefined, 2)
      const copied = await copyToClipboard(text)
      setTransferNotice(copied ? t('accounts.exportNotice') : text)
    } catch (error) {
      if (isAbortError(error)) return
      setTransferError(errorMessage(t, error))
    } finally {
      setExporting(false)
    }
  }, [t])

  const importAccountsNow = useCallback(async (text: string): Promise<void> => {
    const token = csrfRef.current
    if (token === null) return
    setImporting(true)
    setTransferNotice(null)
    setTransferError(null)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setTransferError(t('accounts.importBadJson'))
        return
      }
      const result = await importAccounts(token, parsed, { signal: abortRef.current?.signal })
      if (result.kind !== 'ok') {
        setTransferError(result.kind === 'unavailable' ? t('accounts.unavailable') : result.message)
        return
      }
      if (!result.value.ok) {
        setTransferError(result.value.error?.message ?? t('accounts.transferFailed'))
        return
      }
      setTransferNotice(
        t('accounts.importNotice', {
          added: String(result.value.added ?? 0),
          refreshed: String(result.value.refreshed ?? 0),
          skipped: String(result.value.skipped ?? 0),
        }),
      )
      // The new account has its own points: show them without the user having
      // to hunt for a refresh.
      await refreshAccountsPanel()
    } catch (error) {
      if (isAbortError(error)) return
      setTransferError(errorMessage(t, error))
    } finally {
      setImporting(false)
    }
  }, [refreshAccountsPanel, t])

  const togglePool = useCallback(async (enabled: boolean): Promise<void> => {
    const token = csrfRef.current
    if (token === null) return
    setPoolSaving(true)
    try {
      const result = await savePool(token, enabled, { signal: abortRef.current?.signal })
      if (result.kind === 'ok' && result.value.ok) {
        setPool(result.value)
        // The route set just changed; the picker and status counters both move.
        await loadStatus()
        await loadAccounts()
        return
      }
      setTransferError(
        result.kind === 'unavailable'
          ? t('accounts.unavailable')
          : result.kind === 'ok'
            ? (result.value.error?.message ?? t('pool.failed'))
            : result.message,
      )
    } catch (error) {
      if (isAbortError(error)) return
      setTransferError(errorMessage(t, error))
    } finally {
      setPoolSaving(false)
    }
  }, [loadStatus, loadAccounts, t])

  const adoptDesktop = useCallback(async (): Promise<void> => {
    const token = csrfRef.current
    if (token === null) return
    setAdopting(true)
    setTransferError(null)
    setTransferNotice(null)
    try {
      // One host call: the card used to export-then-import, and a failure in
      // either half read as "transfer failed" with nothing added. The host can
      // read the same session the row shows and store it directly.
      const result = await adoptDesktopAccount(token, { signal: abortRef.current?.signal })
      if (result.kind !== 'ok') {
        setTransferError(result.kind === 'unavailable' ? t('accounts.unavailable') : result.message)
        return
      }
      if (!result.value.ok) {
        setTransferError(result.value.error?.message ?? t('accounts.transferFailed'))
        return
      }
      setTransferNotice(t('accounts.adopted', { route: result.value.route ?? 'loomy' }))
      await refreshAccountsPanel()
    } catch (error) {
      if (isAbortError(error)) return
      setTransferError(errorMessage(t, error))
    } finally {
      setAdopting(false)
    }
  }, [refreshAccountsPanel, t])

  const exportRow = useCallback(
    async (id: string): Promise<void> => {
      const token = csrfRef.current
      if (token === null) return
      setExportingId(id)
      setTransferError(null)
      setTransferNotice(null)
      try {
        const result = await exportAccounts(token, { id, signal: abortRef.current?.signal })
        if (result.kind !== 'ok') {
          setTransferError(result.kind === 'unavailable' ? t('accounts.unavailable') : result.message)
          return
        }
        if (!result.value.ok || result.value.bundle === undefined) {
          setTransferError(result.value.error?.message ?? t('accounts.exportEmpty'))
          return
        }
        const text = JSON.stringify(result.value.bundle, undefined, 2)
        const copied = await copyToClipboard(text)
        setTransferNotice(copied ? t('accounts.exportNotice') : text)
      } catch (error) {
        if (isAbortError(error)) return
        setTransferError(errorMessage(t, error))
      } finally {
        setExportingId(null)
      }
    },
    [t],
  )

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    setDiagnostics({ kind: 'loading' })
    try {
      setDiagnostics(mapResult(await fetchDiagnostics({ signal: abortRef.current?.signal })))
    } catch (error) {
      if (isAbortError(error)) return
      setDiagnostics({ kind: 'error', code: 'network', message: errorMessage(t, error) })
    }
  }, [t])

  const refreshModels = useCallback(async (): Promise<void> => {
    const token = csrfRef.current
    if (token === null) {
      setCatalog({ kind: 'error', code: 'csrf', message: t('errors.csrf') })
      return
    }
    setRefreshing(true)
    try {
      const result = await refreshCatalog(token, { signal: abortRef.current?.signal })
      if (result.kind !== 'ok') {
        setCatalog(mapResult(result))
        return
      }
      setCatalog({ kind: 'ready', value: result.value })
      // The catalog's `enabled` flags are the host's saved baseline, never the
      // user's draft. A dirty draft is preserved by `applyBaseline`.
      const enabledIds = enabledIdsFromCatalog(result.value.catalog)
      if (enabledIds !== null) {
        setBaselineKnown(true)
        setDraft((previous) => (previous === null ? createDraft(enabledIds) : applyBaseline(previous, enabledIds)))
      }
    } catch (error) {
      if (isAbortError(error)) return
      setCatalog({ kind: 'error', code: 'network', message: errorMessage(t, error) })
    } finally {
      setRefreshing(false)
    }
  }, [t])

  // One abort controller for the card's mounted lifetime; every read rides it,
  // so unmounting a settings tab cancels outstanding host reads.
  useEffect(() => {
    ensureStyles()
    const controller = new AbortController()
    abortRef.current = controller
    return () => {
      controller.abort()
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadCredits()
    // These two have their own preconditions (a status read for the CSRF token,
    // an account list), so they are loaded here rather than lazily on a tab:
    // the account panel renders both the login state and the account rows, and
    // without this call they would sit in `idle` and read as "loading" forever.
    void loadAuthState()
    void loadAccounts()
    void loadPool()
  }, [loadStatus, loadCredits, loadAuthState, loadAccounts, loadPool])

  // The catalog is only fetched once the user opens the models tab, and only
  // after `/status` supplied the CSRF token the POST needs.
  useEffect(() => {
    if (tab !== 'models' || autoCatalogRef.current) return
    if (status.kind !== 'ready') return
    autoCatalogRef.current = true
    void refreshModels()
  }, [tab, status.kind, refreshModels])

  useEffect(() => {
    if (tab !== 'diagnostics' || diagnostics.kind !== 'idle') return
    void loadDiagnostics()
  }, [tab, diagnostics.kind, loadDiagnostics])

  const redetect = useCallback(async (): Promise<void> => {
    setRedetecting(true)
    setCopyState('idle')
    try {
      await loadStatus()
      await loadCredits()
      await loadAuthState()
      await loadAccounts()
      await loadPool()
      if (diagnostics.kind !== 'idle') await loadDiagnostics()
    } finally {
      setRedetecting(false)
    }
  }, [loadStatus, loadCredits, loadAuthState, loadAccounts, loadPool, loadDiagnostics, diagnostics.kind])

  const toggle = useCallback((id: string): void => {
    setDraft((previous) => (previous === null ? previous : toggleModel(previous, id)))
    setSaveError(null)
    setNotice(null)
  }, [])

  const discard = useCallback((): void => {
    setDraft((previous) => (previous === null ? previous : discardChanges(previous)))
    setSaveError(null)
    setNotice(null)
  }, [])

  const save = useCallback(async (): Promise<void> => {
    if (draft === null) return
    const token = csrfRef.current
    if (token === null) {
      setSaveError(t('errors.csrf'))
      return
    }
    setSaving(true)
    setSaveError(null)
    setNotice(null)
    try {
      const result = await saveEnabledModels(token, draft.draft, { signal: abortRef.current?.signal })
      if (result.kind === 'ok') {
        const enabled = Array.isArray(result.value.enabled) ? result.value.enabled : [...draft.draft]
        setDraft((previous) => (previous === null ? previous : commitSaved(previous, enabled)))
        setBaselineKnown(true)
        setNotice(t('models.saved'))
        setCatalog((previous) =>
          previous.kind === 'ready'
            ? {
                kind: 'ready',
                value: {
                  ...previous.value,
                  catalog: previous.value.catalog.map((model) => ({
                    ...model,
                    enabled: enabled.includes(model.id),
                  })),
                },
              }
            : previous,
        )
        return
      }
      if (result.kind === 'unavailable') setSaveError(t('models.unavailable'))
      else setSaveError(t('models.saveFailed', { message: result.message }))
    } catch (error) {
      if (isAbortError(error)) return
      setSaveError(t('models.saveFailed', { message: errorMessage(t, error) }))
    } finally {
      setSaving(false)
    }
  }, [draft, t])

  // Diagnostics' own counters are authoritative; a live catalog refresh wins
  // over both, because the host may have moved total/enabled after /status.
  const liveCatalogCounts = catalog.kind === 'ready' ? catalogCountsOf(status, catalog, draft) : null

  const copyDiagnostics = useCallback(async (): Promise<void> => {
    const text = formatDiagnosticsReport(
      {
        status: status.kind === 'ready' ? status.value : null,
        diagnostics: diagnostics.kind === 'ready' ? diagnostics.value : null,
        catalog: catalog.kind === 'ready' ? catalogCountsOf(status, catalog, draft) : null,
        generatedAt: Date.now(),
      },
      t,
    )
    setCopyState((await copyToClipboard(text)) ? 'copied' : 'failed')
  }, [status, diagnostics, catalog, draft, t])

  /**
   * Where to get help — pinned to the card's top-right corner so it is visible
   * without scrolling, and rendered in every state, including "the host exposed
   * no routes" and "the status read failed": exactly when a channel is needed.
   * The diagnostic-report hint is this group's tooltip; the diagnostics tab
   * already explains the copy-paste flow, so a visible duplicate is just noise.
   */
  const community = (
    <nav className="loomy-community" aria-label={t('community.title')} title={t('community.hint')}>
      <span className="loomy-community-title">{t('community.title')}</span>
      <span className="loomy-community-items">
        {CONTACTS.map((channel) => {
          const value = COMMUNITY[channel]
          const href = communityHref(channel, value)
          return href === undefined ? (
            <span key={channel} className="loomy-community-item">
              {t(CHANNEL_LABEL[channel])}：{value}
            </span>
          ) : (
            <a
              key={channel}
              className="loomy-community-link"
              href={href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t(CHANNEL_LABEL[channel])}
            </a>
          )
        })}
      </span>
    </nav>
  )

  const header = (
    <header className="loomy-header">
      <div className="loomy-header-text">
        {surface === 'settings' ? null : <div className="loomy-title">{t('card.title')}</div>}
        <div className="loomy-subtitle">{t('card.subtitle')}</div>
      </div>
      {community}
    </header>
  )

  if (status.kind === 'unavailable') {
    return (
      <div className="loomy-card">
        {header}
        <Notice tone="error">{t('card.hostUnavailable')}</Notice>
      </div>
    )
  }

  if (status.kind === 'failed' || status.kind === 'error') {
    return (
      <div className="loomy-card">
        {header}
        <Notice tone="error">{t('card.statusError', { message: status.message })}</Notice>
        <div>
          <CardButton onClick={() => void redetect()} disabled={redetecting}>
            {redetecting ? t('account.redetecting') : t('card.retry')}
          </CardButton>
        </div>
      </div>
    )
  }

  if (status.kind !== 'ready') {
    return (
      <div className="loomy-card">
        {header}
        <p className="loomy-muted">{t('common.loading')}</p>
      </div>
    )
  }

  const tabs: ReadonlyArray<{ key: TabKey; label: string }> = [
    { key: 'account', label: t('tabs.account') },
    { key: 'models', label: t('tabs.models') },
    { key: 'diagnostics', label: t('tabs.diagnostics') },
  ]

  return (
    <div className="loomy-card">
      {header}

      <div className="loomy-tabs" role="tablist" aria-label={t('tabs.aria')}>
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`loomy-tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`loomy-panel-${entry.key}`}
            className="loomy-tab"
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`loomy-panel-${tab}`} aria-labelledby={`loomy-tab-${tab}`}>
        {tab === 'account' ? (
          <AccountTab
            t={t}
            status={status}
            credits={credits}
            redetecting={redetecting}
            onRedetect={() => void redetect()}
            onRetryCredits={() => void loadCredits()}
            csrfToken={csrfRef.current}
            authState={authState}
            onAuthChanged={() => {
              void loadStatus()
              void loadCredits()
              void loadAuthState()
              void loadAccounts()
            }}
            accounts={accounts}
            removingId={removingId}
            onRemoveAccount={(id) => void removeAccountRow(id)}
            onRefreshAccounts={() => void refreshAccountsPanel()}
            onExportAccounts={() => void exportAccountsNow()}
            onImportAccounts={(text) => void importAccountsNow(text)}
            exporting={exporting}
            importing={importing}
            transferNotice={transferNotice}
            transferError={transferError}
            pool={pool}
            onTogglePool={(enabled) => void togglePool(enabled)}
            poolSaving={poolSaving}
            onAdoptDesktop={() => void adoptDesktop()}
            adopting={adopting}
            creditsByAccount={creditsByAccount}
            onExportRow={(id) => void exportRow(id)}
            exportingId={exportingId}
          />
        ) : null}

        {tab === 'models' ? (
          <ModelsTab
            t={t}
            status={status}
            catalog={catalog}
            draft={draft}
            baselineKnown={baselineKnown}
            canSave={csrfRef.current !== null}
            refreshing={refreshing}
            saving={saving}
            saveError={saveError}
            notice={notice}
            onRefresh={() => void refreshModels()}
            onToggle={toggle}
            onSave={() => void save()}
            onDiscard={discard}
          />
        ) : null}

        {tab === 'diagnostics' ? (
          <DiagnosticsTab
            t={t}
            status={status}
            diagnostics={diagnostics}
            catalog={liveCatalogCounts}
            copyState={copyState}
            onReload={() => void loadDiagnostics()}
            onCopy={() => void copyDiagnostics()}
          />
        ) : null}
      </div>

    </div>
  )
}

interface BoundaryProps {
  t: LoomyT
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

/**
 * Keeps a payload-triggered render error inside this card. The settings shell
 * mounts every plugin tab in one React tree, so an uncaught throw here would
 * blank the whole settings page.
 */
export class CardErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="loomy-card">
          <Notice tone="error">{this.props.t('card.renderFailed')}</Notice>
        </div>
      )
    }
    return this.props.children
  }
}

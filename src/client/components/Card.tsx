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

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  fetchCredits,
  fetchDiagnostics,
  describeError,
  fetchStatus,
  isAbortError,
  readEnabledModelIds,
  refreshCatalog,
  saveEnabledModels,
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
import { ensureStyles } from '../styles.js'
import { AccountTab } from './AccountTab.js'
import { DiagnosticsTab, type CopyState } from './DiagnosticsTab.js'
import { ModelsTab } from './ModelsTab.js'
import { CardButton, Notice } from './common.js'
import { mapResult, type Loadable, type LoomyT } from './types.js'

/** Selectable card sections. */
type TabKey = 'account' | 'models' | 'diagnostics'

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

  const loadCredits = useCallback(async (): Promise<void> => {
    setCredits({ kind: 'loading' })
    try {
      setCredits(mapResult(await fetchCredits({ signal: abortRef.current?.signal })))
    } catch (error) {
      if (isAbortError(error)) return
      setCredits({ kind: 'error', code: 'network', message: errorMessage(t, error) })
    }
  }, [t])

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
  }, [loadStatus, loadCredits])

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
      if (diagnostics.kind !== 'idle') await loadDiagnostics()
    } finally {
      setRedetecting(false)
    }
  }, [loadStatus, loadCredits, loadDiagnostics, diagnostics.kind])

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

  const header = (
    <header className="loomy-header">
      {surface === 'settings' ? null : <div className="loomy-title">{t('card.title')}</div>}
      <div className="loomy-subtitle">{t('card.subtitle')}</div>
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

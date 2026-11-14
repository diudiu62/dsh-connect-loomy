/**
 * Models tab: catalog refresh, per-model checkboxes and the draft toolbar.
 *
 * The acceptance contract lives in three lines of this component:
 * - the checkbox reflects `draft.draft`, never `enabled` from the catalog;
 * - the refresh button re-reads the catalog but leaves a dirty draft untouched;
 * - Save is the only path that posts the draft, Discard restores the baseline.
 *
 * @module dsh-connect-loomy/client/components/ModelsTab
 */

import type { LoomyCatalog, LoomyStatus } from '../api.js'
import { isDirty, type ModelDraft } from '../draft.js'
import { formatCount, formatDateTime, formatEfforts, formatMultiplier } from '../format.js'
import { Badge, CardButton, Notice, Section } from './common.js'
import { loadableMessage, type Loadable, type LoomyT } from './types.js'

/** Props supplied by the card shell. */
export interface ModelsTabProps {
  t: LoomyT
  status: Loadable<LoomyStatus>
  catalog: Loadable<LoomyCatalog>
  /** Null while the host has not reported the saved selection (contract v2). */
  draft: ModelDraft | null
  /** False when `/status` omitted `enabledModelIds`. */
  baselineKnown: boolean
  /** False while the CSRF token is missing, i.e. saving cannot work yet. */
  canSave: boolean
  refreshing: boolean
  saving: boolean
  saveError: string | null
  notice: string | null
  onRefresh: () => void
  onToggle: (id: string) => void
  onSave: () => void
  onDiscard: () => void
}

/** Render the models tab. */
export function ModelsTab(props: ModelsTabProps) {
  const { t, status, catalog, draft, baselineKnown, canSave, refreshing, saving, saveError, notice } = props
  const draftDirty = draft !== null && isDirty(draft)
  // A 404/503 means the host settled "no catalog route": render the capability
  // notice and hide every control that would only fail again.
  const hostAvailable = status.kind !== 'unavailable' && catalog.kind !== 'unavailable'

  return (
    <div className="loomy-panel">
      <Section
        title={t('models.title')}
        actions={
          hostAvailable ? (
            <CardButton onClick={props.onRefresh} disabled={refreshing || saving}>
              {refreshing ? t('models.refreshing') : t('models.refresh')}
            </CardButton>
          ) : null
        }
      >
        <p className="loomy-muted">{t('models.description')}</p>

        {!hostAvailable ? <Notice tone="error">{t('models.unavailable')}</Notice> : null}

        {hostAvailable ? (
          <>
            {!baselineKnown ? (
              <Notice>{t('models.baselineUnknown')}</Notice>
            ) : null}

            <div className="loomy-toolbar">
              {draftDirty ? <Badge tone="danger">{t('models.dirty')}</Badge> : <Badge>{t('models.clean')}</Badge>}
              <span className="loomy-muted">
                {t('models.selection', {
                  selected: draft === null ? 0 : draft.draft.length,
                  total: catalog.kind === 'ready' ? catalog.value.catalog.length : 0,
                })}
              </span>
              <span className="loomy-toolbar-spacer" />
              <CardButton
                variant="ghost"
                onClick={props.onDiscard}
                disabled={!draftDirty || saving}
              >
                {t('models.discard')}
              </CardButton>
              <CardButton
                variant="primary"
                onClick={props.onSave}
                disabled={!draftDirty || saving || !canSave}
              >
                {saving ? t('models.saving') : t('models.save')}
              </CardButton>
            </div>

            {!canSave ? <p className="loomy-warning">{t('models.saveNeedsHost')}</p> : null}
            {saveError !== null ? <Notice tone="error">{saveError}</Notice> : null}
            {notice !== null ? <Notice>{notice}</Notice> : null}

            <CatalogBody
              t={t}
              catalog={catalog}
              draft={draft}
              disabling={saving}
              onToggle={props.onToggle}
            />
          </>
        ) : null}
      </Section>
    </div>
  )
}

function CatalogBody({
  t,
  catalog,
  draft,
  disabling,
  onToggle,
}: {
  t: LoomyT
  catalog: Loadable<LoomyCatalog>
  draft: ModelDraft | null
  disabling: boolean
  onToggle: (id: string) => void
}) {
  if (catalog.kind === 'idle' || catalog.kind === 'loading') {
    return <p className="loomy-muted">{t('models.loading')}</p>
  }
  if (catalog.kind === 'unavailable') {
    return <Notice tone="error">{t('models.unavailable')}</Notice>
  }
  if (catalog.kind === 'failed' || catalog.kind === 'error') {
    return <Notice tone="error">{t('models.refreshFailed', { message: loadableMessage(catalog, t) })}</Notice>
  }

  const models = catalog.value.catalog
  if (models.length === 0) return <p className="loomy-muted">{t('models.empty')}</p>

  return (
    <div className="loomy-panel">
      <p className="loomy-muted">
        {t('models.refreshedAt', { time: formatDateTime(catalog.value.refreshedAt) })}
      </p>
      <div className="loomy-models" role="table" aria-label={t('models.title')}>
        <div className="loomy-model loomy-model-head" role="row">
          <span aria-hidden="true" />
          <span role="columnheader">{t('models.column.model')}</span>
          <span role="columnheader">{t('models.column.multiplier')}</span>
          <span role="columnheader">{t('models.column.context')}</span>
          <span role="columnheader">{t('models.column.maxOutput')}</span>
          <span role="columnheader">{t('models.column.vision')}</span>
          <span role="columnheader">{t('models.column.efforts')}</span>
        </div>

        {models.map((model) => {
          const checked = draft !== null && draft.draft.includes(model.id)
          return (
            <label className="loomy-model" role="row" key={model.id}>
              <input
                className="loomy-check"
                type="checkbox"
                checked={checked}
                disabled={draft === null || disabling}
                aria-label={t('models.toggle', { name: model.name })}
                onChange={() => onToggle(model.id)}
              />
              <span className="loomy-model-name">
                <span className="loomy-model-name-text">{model.name}</span>
                <span className="loomy-model-id">{model.id}</span>
              </span>
              <span className="loomy-badge" title={t('models.column.multiplier')}>
                {formatMultiplier(model.multiplier)}
              </span>
              <span>{formatCount(model.contextWindow)}</span>
              <span>{formatCount(model.maxOutput)}</span>
              <span>{model.vision ? t('models.vision.yes') : t('models.vision.no')}</span>
              <span>{formatEfforts(model.efforts, model.defaultEffort, t)}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

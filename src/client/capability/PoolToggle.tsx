/**
 * The rotation switch, rendered only when `capabilities.pool` is declared.
 *
 * Rotation is a *preference*, not a credential operation, so it never appears in
 * a vendor that does not declare it — the host does not register `/pool` there,
 * and offering a checkbox that can only 404 is the "dead control" failure this
 * refactor exists to remove.
 *
 * The control is rendered as soon as the capability is declared, and merely
 * disabled until the preference has been read: the capability-matrix test can
 * then assert "declared ⇒ present" without depending on a fixture's data.
 *
 * @module dsh-connect-desktop/client/capability/PoolToggle
 */

import type { PoolStateView } from '../../shared/views.js'
import { Badge } from '../components/common.js'
import type { CardT, Loadable } from '../components/types.js'

export interface PoolToggleProps {
  t: CardT
  state: Loadable<PoolStateView>
  onToggle: (enabled: boolean) => void
  /** A write is in flight. */
  saving: boolean
  /** No CSRF token yet, so a write would be rejected locally. */
  disabled: boolean
}

/** Render the pool preference row. */
export function PoolToggle({ t, state, onToggle, saving, disabled }: PoolToggleProps) {
  const value = state.kind === 'ready' ? state.value : null
  const messages: string[] = []
  if (state.kind === 'stale' || state.kind === 'failed') messages.push(state.message)
  if (state.kind === 'unavailable') messages.push(t('errors.unavailable'))

  return (
    <div className="dcss-check-row" data-dcss-cap="pool">
      <label className="dcss-check-label">
        <input
          type="checkbox"
          checked={value?.enabled === true}
          disabled={disabled || saving || value === null}
          onChange={(event) => onToggle(event.target.checked)}
        />{' '}
        {t('pool.label')}
      </label>
      <span className="dcss-toolbar-spacer" />
      {value === null ? null : (
        <>
          <Badge tone={value.active ? 'ok' : 'neutral'}>{value.active ? t('pool.on') : t('pool.off')}</Badge>
          {/* 「N 个账号中 M 个健康」在全员健康时只是重复段标题里的数量；
              只有掉队时才有信息量。 */}
          {value.healthy < value.total ? (
            <Badge tone="danger">{t('pool.summary', { healthy: value.healthy, total: value.total })}</Badge>
          ) : null}
        </>
      )}
      {value !== null && value.enabled && value.total < 2 ? (
        <p className="dcss-row-note">{t('pool.needsTwo')}</p>
      ) : null}
      {messages.map((message) => (
        <p className="dcss-row-note dcss-error" key={message}>
          {message}
        </p>
      ))}
    </div>
  )
}

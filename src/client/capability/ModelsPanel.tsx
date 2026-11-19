/**
 * 唯一的模型面板。
 *
 * 它不知道供应商是谁：目录里的每一行都来自 `/catalog`，勾选状态来自
 * `capabilities.catalog.selection`，能力没声明就根本没有这个面板（`tabsFor` 决定）。
 *
 * 三个请求，全部走同一条 `requestVendor`：
 * - `GET  catalog`   读目录 + 已保存的选择；
 * - `POST refresh`   强制上游重读；
 * - `POST save`      保存选择（保存后宿主会热更新模型列表，无需重启）。
 *
 * @module dsh-connect-desktop/client/capability/ModelsPanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CatalogModelView, VendorCapabilities } from '../../shared/views.js'
import { Badge, CardButton, Notice, Section } from '../components/common.js'
import { failureMessage, type CardT, type Loadable } from '../components/types.js'
import { formatCount, formatDateTime, formatEfforts, formatMultiplier } from '../format.js'
import { isAbortError, requestVendor } from '../transport.js'
import { useVendorRoute } from './loadable.js'

interface CatalogPayload {
  models: CatalogModelView[]
  refreshedAt: number | null
  selection: string[] | null
}

export interface ModelsPanelProps {
  t: CardT
  vendorId: string
  csrf: string | null
  /**
   * 能力声明。目前只用 `catalog.reasoningEffort`：上游不校验档位时，
   * 一列"推理档位"纯属装饰，还占掉 600px 宽度里的 143px。
   */
  capabilities: VendorCapabilities
  /** Called after a save so the composer/card can re-read the model list. */
  onChanged?: () => void
}

export function ModelsPanel({ t, vendorId, csrf, capabilities, onChanged }: ModelsPanelProps) {
  const load = useCallback(
    (signal: AbortSignal) => requestVendor<CatalogPayload>({ vendorId, suffix: 'catalog', csrf, signal }),
    [vendorId, csrf],
  )
  const catalog = useVendorRoute(load)
  const [draft, setDraft] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 目录刷新后丢弃草稿：宿主已经是新的基线，旧草稿没有意义。
  const server = catalog.state.kind === 'ready' ? catalog.state.value : null
  useEffect(() => {
    setDraft(null)
  }, [server?.refreshedAt, server?.models.length])

  const enabledSet = useMemo(() => {
    if (draft !== null) return draft
    return new Set((server?.models ?? []).filter((model) => model.enabled).map((model) => model.id))
  }, [draft, server])

  const dirty = useMemo(() => {
    if (draft === null || server === null) return false
    const saved = new Set(server.models.filter((model) => model.enabled).map((model) => model.id))
    if (saved.size !== draft.size) return true
    for (const id of draft) if (!saved.has(id)) return true
    return false
  }, [draft, server])

  const toggle = (id: string): void => {
    setDraft((current) => {
      const next = new Set(current ?? enabledSet)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (draft === null) return
    setSaving(true)
    setError(null)
    try {
      const result = await requestVendor<{ enabled: string[] }>({
        vendorId,
        suffix: 'save',
        method: 'POST',
        body: { enabledModelIds: [...draft] },
        csrf,
      })
      if (result.kind !== 'ok') {
        setError(result.kind === 'failed' ? result.message : t('models.saveFailed', { message: '—' }))
        return
      }
      setDraft(null)
      await catalog.reload({ silent: true })
      onChanged?.()
    } catch (cause) {
      if (!isAbortError(cause)) setError(t('common.unknownError') ?? null)
    } finally {
      setSaving(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      const result = await requestVendor<unknown>({ vendorId, suffix: 'refresh', method: 'POST', csrf })
      if (result.kind !== 'ok') {
        setError(result.kind === 'failed' ? result.message : t('models.refreshFailed', { message: '—' }))
        return
      }
      await catalog.reload({ silent: true })
    } finally {
      setRefreshing(false)
    }
  }

  const failure = failureMessage(catalog.state as Loadable<unknown>, t)

  return (
    <Section
      title={t('models.title')}
      cap="models"
      actions={
        <>
          <CardButton onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? t('models.refreshing') : t('models.refresh')}
          </CardButton>
          <CardButton variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? t('models.saving') : t('models.save')}
          </CardButton>
        </>
      }
    >
      <p className="dcss-hint">{t('models.description')}</p>
      {dirty ? <Notice tone="info">{t('models.dirty')}</Notice> : null}
      {error !== null ? <Notice tone="error">{error}</Notice> : null}
      {failure !== null ? <Notice tone="error">{failure}</Notice> : null}
      {catalog.state.kind === 'loading' ? <p className="dcss-hint">{t('models.loading')}</p> : null}
      {server !== null && server.models.length === 0 ? <p className="dcss-hint">{t('models.empty')}</p> : null}
      {server !== null && server.models.length > 0 ? (
        <>
          <div className="dcss-hint">
            {t('models.selection', { selected: enabledSet.size, total: server.models.length })}
            {server.refreshedAt === null ? '' : ` · ${t('models.refreshedAt', { time: formatDateTime(server.refreshedAt) })}`}
          </div>
          {/*
            三列，不是六列：600px 宽时六列吃掉 396px，把模型名压到 203px、名字换
            三行。最大输出 / 视觉 / 推理改挂在名字下面那行元信息里——它们是"这个
            模型是什么"，不是"用来比较什么"。剩下两列才是能横向比较的数字。
          */}
          <table className="dcss-table dcss-table-models">
            <thead>
              <tr>
                <th>{t('models.column.model')}</th>
                <th className="dcss-num">{t('models.column.multiplier')}</th>
                <th className="dcss-num">{t('models.column.context')}</th>
              </tr>
            </thead>
            <tbody>
              {server.models.map((model) => (
                <tr key={model.id}>
                  <td>
                    <label className="dcss-tick">
                      <input type="checkbox" checked={enabledSet.has(model.id)} onChange={() => toggle(model.id)} />
                      <span>{model.name}</span>
                    </label>
                    <div className="dcss-mono">{model.id}</div>
                    <div className="dcss-row-note">
                      {t('models.meta.output', { tokens: formatCount(model.maxOutput) })}
                      {' · '}
                      {model.vision ? t('models.meta.vision') : t('models.meta.textOnly')}
                      {/*
                        推理档位只在供应商声明 reasoningEffort 时才说。上游不校验
                        档位时这一列是装饰品（Raccoon 就是这种情况）。
                      */}
                      {capabilities.catalog.reasoningEffort && model.efforts.length > 0
                        ? ` · ${formatEfforts(model.efforts, model.defaultEffort, t)}`
                        : ''}
                    </div>
                  </td>
                  <td className="dcss-num">{formatMultiplier(model.multiplier)}</td>
                  <td className="dcss-num">{formatCount(model.contextWindow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Section>
  )
}

/**
 * 配置面板：这家供应商的接口地址与缓存时长。
 *
 * 为什么必须有这一页：`settings.configure({ auto: false })` 之后 DSH 不再为这个
 * section 生成表单，卡片就是**唯一**入口。这一页缺失的直接后果是——用户找不到改
 * 配置的地方，只能去翻 profile 文件，而 profile 里只有他上一次亲手写过的那几家。
 *
 * 字段不是手写清单：`GET <vendor>/config` 由宿主反射 vendor 的 schemastery schema
 * 生成（类型、默认值、是否被覆盖），所以新增一家供应商、或给它加一个字段，这一页
 * 自动跟上。
 *
 * @module dsh-connect-desktop/client/capability/ConfigPanel
 */

import { useCallback, useEffect, useState } from 'react'
import type { ConfigFieldView, VendorConfigView } from '../../shared/views.js'
import { CardButton, Notice, Section } from '../components/common.js'
import { failureMessage, type CardT, type Loadable } from '../components/types.js'
import { requestVendor } from '../transport.js'
import { useVendorRoute } from './loadable.js'

export interface ConfigPanelProps {
  t: CardT
  vendorId: string
  csrf: string | null
  onChanged?: () => void
}

/** 一次编辑的草稿：只放用户真的改过的字段。 */
type Draft = Record<string, unknown>

/**
 * 把字段按 `group` 收成几块。
 *
 * 顺序：先按字段在 schema 里出现的顺序决定分组顺序（不是按组名的字母序），
 * 没有分组的字段合成最后一块（`id: 'other'`，无标题）。
 */
function groupFields(
  fields: readonly ConfigFieldView[],
  labelKeys: ReadonlyMap<string, string>,
): Array<{ id: string; labelKey: string | undefined; fields: ConfigFieldView[] }> {
  const order: string[] = []
  const buckets = new Map<string, ConfigFieldView[]>()
  for (const field of fields) {
    const id = field.group ?? 'other'
    if (!buckets.has(id)) {
      buckets.set(id, [])
      order.push(id)
    }
    ;(buckets.get(id) as ConfigFieldView[]).push(field)
  }
  // 没有分组的排最后：它不是一组，只是"还没归类的那些"。
  const index = order.indexOf('other')
  if (index !== -1) order.splice(index, 1), order.push('other')
  return order.map((id) => ({
    id,
    // `other` 不是一组，只是"还没归类的那些"，不给标题。
    labelKey: id === 'other' ? undefined : labelKeys.get(id),
    fields: buckets.get(id) ?? [],
  }))
}

export function ConfigPanel({ t, vendorId, csrf, onChanged }: ConfigPanelProps) {
  const load = useCallback(
    (signal: AbortSignal) => requestVendor<VendorConfigView>({ vendorId, suffix: 'config', signal }),
    [vendorId],
  )
  const config = useVendorRoute(load)
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const view = config.state.kind === 'ready' ? config.state.value : null
  const failure = failureMessage(config.state as Loadable<unknown>, t)

  // 重新加载后丢弃草稿：宿主那边已经是新基线。
  useEffect(() => {
    setDraft({})
    setSaved(false)
  }, [view])

  const changed = Object.keys(draft).length > 0

  const save = async (): Promise<void> => {
    if (!changed) return
    setSaving(true)
    setError(null)
    try {
      const result = await requestVendor<{ ok: true }>({
        vendorId,
        suffix: 'config',
        method: 'POST',
        body: {
          fields: draft,
          // 带着读到的版本号保存：别人在这期间改过，宿主会拒绝而不是让两边互相覆盖。
          ...(view?.revision === undefined ? {} : { ifRevision: view.revision }),
        },
        csrf,
      })
      if (result.kind !== 'ok') {
        if (result.kind === 'failed' && result.code === 'config_stale') {
          // 别人的写入赢了。丢弃本地草稿并重读——否则用户会在一份已经不存在的
          // 基线上继续改，下一次保存照样失败。
          setDraft({})
          setSaved(false)
          await config.reload({ silent: true })
          setError(result.message)
          return
        }
        setError(result.kind === 'failed' ? result.message : t('config.saveFailed'))
        return
      }
      setSaved(true)
      await config.reload({ silent: true })
      onChanged?.()
    } finally {
      setSaving(false)
    }
  }

  /** 控件按字段类型渲染；未知类型退化成文本框，绝不因为类型没覆盖就少一个字段。 */
  const control = (field: ConfigFieldView): JSX.Element => {
    const value = field.key in draft ? draft[field.key] : field.value
    const update = (next: unknown): void => {
      setSaved(false)
      setDraft((current) => ({ ...current, [field.key]: next }))
    }
    if (field.type === 'boolean') {
      return (
        <label className="dcss-tick">
          <input type="checkbox" checked={value === true} onChange={(event) => update(event.target.checked)} />
          <span className="dcss-mono">{value === true ? 'true' : 'false'}</span>
        </label>
      )
    }
    if (field.type === 'number') {
      return (
        <input
          className="dcss-input"
          type="number"
          value={typeof value === 'number' ? value : Number(value ?? 0)}
          onChange={(event) => update(Number(event.target.value))}
        />
      )
    }
    if (field.type === 'string-list') {
      // 一行一个：比逗号分隔更不容易出错，也能保留带空格的模型 id。
      return (
        <textarea
          className="dcss-textarea"
          rows={2}
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(event) =>
            update(
              event.target.value
                .split('\n')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            )
          }
        />
      )
    }
    return (
      <input
        className="dcss-input"
        type="text"
        value={typeof value === 'string' ? value : String(value ?? '')}
        onChange={(event) => update(event.target.value)}
      />
    )
  }

  return (
    <Section
      title={t('config.title')}
      cap="config"
      actions={
        <>
          <CardButton
            onClick={() => {
              setDraft({})
              setSaved(false)
            }}
            disabled={!changed || saving}
          >
            {t('common.discard')}
          </CardButton>
          <CardButton variant="primary" onClick={() => void save()} disabled={!changed || saving || csrf === null}>
            {saving ? t('config.saving') : t('config.save')}
          </CardButton>
        </>
      }
    >
      <p className="dcss-hint">{t('config.description')}</p>
      {failure !== null ? <Notice tone="error">{failure}</Notice> : null}
      {error !== null ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="ok">{t('config.saved')}·{t('config.restartHint')}</Notice> : null}
      {config.state.kind === 'loading' ? <p className="dcss-hint">{t('common.loading')}</p> : null}

      {view !== null && view.fields.length === 0 ? <p className="dcss-hint">{t('config.empty')}</p> : null}

      {/*
        分组渲染：`field.group` 由供应商在 descriptor 里声明（core 不猜字段语义），
        没有分组的字段排到最后。同一份 schema 的十个字段平铺时，用户找不到
        "我要改缓存时长"该看哪儿。
      */}
      {view !== null && view.fields.length > 0
        ? groupFields(
            view.fields,
            new Map((view.groups ?? []).map((group) => [group.id, group.labelKey])),
          ).map((section) => (
            <div className="dcss-field-group" key={section.id}>
              {section.labelKey === undefined ? null : (
                <h4 className="dcss-field-group-title">{t(section.labelKey as never)}</h4>
              )}
              <div className="dcss-field-list">
                {section.fields.map((field) => {
                  const dirty = field.key in draft
                  return (
                    <div className="dcss-field" key={field.key} data-dcss-config={field.key}>
                      <div className="dcss-field-label">
                        {/*
                          说明文字当主标题、字段名降为副标题。
                          `baseURL` 这种键名对用户没有意义，而 schema 里的
                          description 本来就是"这个字段是干什么的"。
                        */}
                        <div className="dcss-field-title">{field.description ?? field.key}</div>
                        <div className="dcss-field-name">{field.key}</div>
                      </div>
                      <div className="dcss-field-control">
                        {control(field)}
                        {dirty || field.overridden ? (
                          <span className="dcss-field-badge">{t('config.overridden')}</span>
                        ) : null}
                      </div>
                      <div className="dcss-field-default">
                        <span
                          className="dcss-hint"
                          title={Array.isArray(field.default) ? field.default.join(', ') : String(field.default)}
                        >
                          {t('config.default')}{' '}
                          {Array.isArray(field.default) ? field.default.join(', ') || '—' : String(field.default)}
                        </span>
                        <CardButton
                          variant="ghost"
                          onClick={() => {
                            setSaved(false)
                            setDraft((current) => ({ ...current, [field.key]: field.default }))
                          }}
                          disabled={saving}
                        >
                          {t('config.reset')}
                        </CardButton>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        : null}
    </Section>
  )
}
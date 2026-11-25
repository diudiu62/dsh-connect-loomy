/**
 * 设置卡片的外壳 —— 这是重构后**唯一**需要维护的卡片代码。
 *
 * 它不认识任何供应商：`GET /status` 一次拿到所有供应商的能力声明，切换条由
 * `available` 决定，tab 由 `tabsFor(capabilities)` 决定，面板由 tab 决定。
 * 加第三家供应商时，这个文件一行都不用改。
 *
 * 上一版这里有 `useState<'loomy' | 'raccoon'>` 和 `if (vendor === 'raccoon')`：
 * 两家供应商被切成两个互斥世界，第三家就要第三个分支和第三份 tab 壳。
 *
 * @module dsh-connect-desktop/client/components/Card
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { StatusView, VendorStatusView } from '../../shared/views.js'
import type { ProviderRegisterView } from '../../shared/views.js'
import { COMMUNITY } from '../../shared/community.js'
import { fetchStatus, requestVendor } from '../transport.js'
import { Badge, CardButton, Notice } from './common.js'
import { ensureStyles } from '../styles.js'
import type { CardT } from './types.js'
import { failureMessage, mapResult } from './types.js'
import { AccountPanel } from '../capability/AccountPanel.js'
import { ModelsPanel } from '../capability/ModelsPanel.js'
import { DiagnosticsPanel } from '../capability/DiagnosticsPanel.js'
import { ConfigPanel } from '../capability/ConfigPanel.js'
import { resolveTab, tabsFor, type TabKey } from '../capability/tabs.js'
import { useVendorRoute } from '../capability/loadable.js'

export interface SettingsCardProps {
  /** 框架注入的翻译函数；缺失时退化为"返回键名"。 */
  t?: CardT
}

/** 兜底翻译：宁可显示键名，也不要因为缺 `t` 整张卡片崩掉。 */
const passthrough = ((key: string) => key) as unknown as CardT

export function DesktopSettingsCard(props: SettingsCardProps) {
  const t = props.t ?? passthrough
  // 卡片自己注入样式表：这里曾经漏掉，于是整张卡片在真机上以无样式状态渲染
  // （只有输入框旁的小徽标会注入，所以"看起来像能用"）。幂等，挂在首帧即可。
  useEffect(() => {
    ensureStyles()
  }, [])

  const load = useCallback((signal: AbortSignal) => fetchStatus({ signal }), [])
  const status = useVendorRoute(load)
  const [wantedTab, setWantedTab] = useState<TabKey | null>(null)
  const [wantedVendor, setWantedVendor] = useState<string | null>(null)
  const view: StatusView | null = status.state.kind === 'ready' ? status.state.value : null
  const vendors = useMemo((): readonly VendorStatusView[] => view?.vendors ?? [], [view])
  /**
   * 卡片列出**所有已挂载的供应商**，包括未登录的那几家。
   *
   * 这里曾经只看 `available`，后果很具体：小浣熊没登录 → 它在卡片里彻底消失 →
   * 用户找不到它的配置、看不到原因、连「重新检测」都点不到。而"没装就不出现"
   * 那条承诺只该作用于**模型选择器**（选一个必然失败的分组才有害），不该作用于
   * 设置页——设置页恰恰是用户修复它的地方。
   */
  const ordered = useMemo(
    () =>
      // 可用的排前面（用户多数时候只关心能用的），但一家都不隐藏。
      [...vendors].sort((left: VendorStatusView, right: VendorStatusView) =>
        left.available === right.available ? 0 : left.available ? -1 : 1,
      ),
    [vendors],
  )

  // 选中的供应商不见了（被关掉）时回落到第一个。
  useEffect(() => {
    if (ordered.length === 0) return
    if (wantedVendor !== null && ordered.some((vendor) => vendor.id === wantedVendor)) return
    setWantedVendor((ordered[0] as VendorStatusView).id)
  }, [ordered, wantedVendor])

  const current = ordered.find((vendor) => vendor.id === wantedVendor) ?? ordered[0]
  const tabs = current === undefined ? [] : tabsFor(current.capabilities)
  const tab = resolveTab(tabs, wantedTab)

  const failure = failureMessage(status.state, t)
  const csrf = view?.csrfToken ?? null

  return (
    <div className="dcss-card">
      <header className="dcss-header">
        <div className="dcss-header-text">
          <h2 className="dcss-title">{t('card.title')}</h2>
          <p className="dcss-subtitle">{t('card.subtitle')}</p>
        </div>
        <div className="dcss-header-actions">
          <CardButton onClick={() => void status.reload()}>{t('common.refresh')}</CardButton>
        </div>
      </header>

      {failure !== null ? <Notice tone="error">{failure}</Notice> : null}
      {status.state.kind === 'loading' ? <p className="dcss-hint">{t('common.loading')}</p> : null}

      {current?.provider !== undefined && current.provider.registered === false ? (
        <ProviderMissingNotice
          key={current.id}
          t={t}
          vendor={current}
          csrf={csrf}
          onDone={() => void status.reload({ silent: true })}
        />
      ) : null}

      {view !== null && ordered.length === 0 ? (
        <Notice tone="info">
          <div>{t('card.empty.title')}</div>
          <div>{t('card.empty.body')}</div>
        </Notice>
      ) : null}

      {current !== undefined ? (
        <div className="dcss-statusbar" data-dcss-cap="statusbar">
          <span className="dcss-statusbar-vendor" style={{ ['--dcss-accent' as string]: current.accent }}>
            {current.displayName}
          </span>
          <span className="dcss-statusbar-identity">
            {current.account === null
              ? t('account.loggedOut')
              : (current.account.label ?? current.account.phone ?? current.account.userId ?? t('account.loggedIn'))}
          </span>
          <span className="dcss-statusbar-spacer" />
          {current.available ? (
            <Badge tone="ok">{t('account.loggedIn')}</Badge>
          ) : (
            <Badge tone="danger">{t('account.loggedOut')}</Badge>
          )}
          {current.capabilities.catalog.selection ? (
            <span className="dcss-statusbar-metric">
              {t('models.selection', {
                selected: current.catalog.enabled,
                total: current.catalog.total,
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {ordered.length > 1 ? (
        <nav className="dcss-vendor-switch" role="tablist" aria-label={t('vendor.switchAria')}>
          {ordered.map((vendor) => (
            <button
              key={vendor.id}
              type="button"
              role="tab"
              aria-selected={vendor.id === current?.id}
              className="dcss-vendor-tab"
              style={{ ['--dcss-accent' as string]: vendor.accent }}
              onClick={() => {
                setWantedVendor(vendor.id)
                setWantedTab(null)
              }}
            >
              {vendor.displayName}
              {vendor.available ? null : <span className="dcss-vendor-tab-off">·</span>}
            </button>
          ))}
        </nav>
      ) : null}

      {current !== undefined && tabs.length > 0 ? (
        <>
          {/*
            tablist 需要三件东西才算可用：每个 tab 指向自己的面板（aria-controls）、
            面板反向指回 tab（aria-labelledby）、方向键能换 tab。原来只有
            role="tab" + aria-selected，键盘用户按 ←/→ 没有反应。
          */}
          <nav
            className="dcss-tabs"
            role="tablist"
            aria-label={t('tabs.aria')}
            onKeyDown={(event) => {
              const index = tabs.findIndex((entry) => entry.key === tab?.key)
              if (index === -1) return
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1
              if (next === -1) return
              event.preventDefault()
              setWantedTab((tabs[next] as (typeof tabs)[number]).key)
            }}
          >
            {tabs.map((entry) => (
              <button
                key={entry.key}
                id={`dcss-tab-${current?.id ?? 'vendor'}-${entry.key}`}
                type="button"
                role="tab"
                aria-selected={entry.key === tab?.key}
                aria-controls={`dcss-panel-${current?.id ?? 'vendor'}-${entry.key}`}
                tabIndex={entry.key === tab?.key ? 0 : -1}
                className="dcss-tab"
                onClick={() => setWantedTab(entry.key)}
              >
                {t(entry.labelKey)}
              </button>
            ))}
          </nav>

          <div
            className="dcss-panel dcss-tabpanel"
            role="tabpanel"
            id={`dcss-panel-${current.id}-${tab?.key ?? 'none'}`}
            aria-labelledby={`dcss-tab-${current.id}-${tab?.key ?? 'none'}`}
            tabIndex={0}
          >
          {/*
            `key` 是刻意的：切换供应商就是换了上下文。没有它，React 会复用同一个
            面板实例，于是上一家的账号列表、展开的表单、正在编辑的草稿都会留在
            屏幕上——用户看到的是"A 家的界面配 B 家的标题"。
          */}
          {tab?.key === 'account' ? (
            <AccountPanel
              key={current.id}
              t={t}
              vendor={current}
              csrf={csrf}
              onChanged={() => void status.reload({ silent: true })}
            />
          ) : null}
          {tab?.key === 'models' ? (
            <ModelsPanel
              key={current.id}
              t={t}
              vendorId={current.id}
              csrf={csrf}
              capabilities={current.capabilities}
              onChanged={() => void status.reload({ silent: true })}
            />
          ) : null}
          {tab?.key === 'config' ? (
            <ConfigPanel
              key={current.id}
              t={t}
              vendorId={current.id}
              csrf={csrf}
              onChanged={() => void status.reload({ silent: true })}
            />
          ) : null}
          {tab?.key === 'diagnostics' ? (
            <DiagnosticsPanel key={current.id} t={t} vendorId={current.id} csrf={csrf} />
          ) : null}
          </div>
        </>
      ) : null}

      {current !== undefined && tabs.length === 0 ? (
        <Notice tone="info">{t('card.noCapabilities')}</Notice>
      ) : null}

      {/*
        页脚一行。原来渲染 `{channel}: {value}`，于是界面里出现原始键名
        `issues: …` / `qqGroup: 537149884` —— 英文标识符漏进了中文界面。
        现在用字典里的说法，并且只留最常用的两个渠道。
      */}
      <footer className="dcss-footer">
        <span>{t('community.title')}</span>
        <a className="dcss-link" href={COMMUNITY.issues} target="_blank" rel="noreferrer">
          {t('community.issues')}
        </a>
        <span className="dcss-link">
          {t('community.qqGroup')} {COMMUNITY.qqGroup}
        </span>
      </footer>
    </div>
  )
}

/**
 * 「这家客户端还没有注册进模型选择器」提示 + 「重新注册」按钮。
 *
 * 为什么需要这个按钮：注册被拒（provider 名被别的插件占用、注册瞬间所在上下文
 * 已失效、句柄失效）之后，宿主的自动 reconcile 会被"签名没变就不动"的幂等阀挡
 * 住——错误说明会永远停在 `/status` 里，用户唯一的出路是重启 DSH。按钮把注册流程
 * 强制再走一遍，成功与否都如实反映到刷新后的状态里。
 *
 * `retryable === false` 的那几种原因（被配置禁用、没有可用登录态、双挂载让位、
 * 没有路由）不渲染按钮：修复动作在别的地方，一个必然失败的按钮正是本项目要
 * 消灭的死控件。
 */
function ProviderMissingNotice({
  t,
  vendor,
  csrf,
  onDone,
}: {
  t: CardT
  vendor: VendorStatusView
  csrf: string | null
  /** 请求结束后重新读一次 `/status`：要么提示消失，要么换成新的原因。 */
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  /** 请求本身失败（路由缺失/网络/CSRF）时的一句话；注册结果由 `/status` 说话。 */
  const [note, setNote] = useState<string | null>(null)

  const reRegister = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result = await requestVendor<ProviderRegisterView>({
        vendorId: vendor.id,
        suffix: 'register',
        method: 'POST',
        csrf,
      })
      // 业务层面的"仍然没注册上"不额外说话——原因本来就写在上面那一行，刷新后
      // 会换成新的。只有请求没走通才需要这里的文案，否则界面看起来像"按钮没反应"。
      if (result.kind !== 'ok') setNote(failureMessage(mapResult(result), t))
    } finally {
      setBusy(false)
      onDone()
    }
  }

  return (
    <Notice tone="error">
      <div>{t('card.providerMissing')}</div>
      <div className="dcss-hint">{vendor.provider?.error ?? '—'}</div>
      {vendor.provider?.retryable === true ? (
        <div className="dcss-notice-actions">
          <CardButton variant="primary" onClick={() => void reRegister()} disabled={busy || csrf === null}>
            {busy ? t('card.registering') : t('card.reregister')}
          </CardButton>
        </div>
      ) : null}
      {note === null ? null : <div className="dcss-hint">{note}</div>}
    </Notice>
  )
}

/** 旧名保留给索引文件；新名字表达"这里不再只有 Loomy"。 */
export { DesktopSettingsCard as LoomySettingsCard }

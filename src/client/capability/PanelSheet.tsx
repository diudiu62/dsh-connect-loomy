/**
 * 从聊天界面就近打开的完整面板。
 *
 * **为什么不是跳到宿主的设置页**：DSH 的浏览器端没有 URL 路由，也没有对外暴露
 * "打开某个设置分区"的服务。模拟点击侧边栏那条路在真实界面里走不通（入口是纯图标
 * 按钮，`textContent` 为空），所以改成自己把面板画出来——可靠、可测、不依赖宿主 DOM。
 *
 * **默认停在「账号」**：用户是从账号抽屉按进来的，此刻他关心的是"谁在付费、
 * 还有多少额度"。把他丢到配置页等于让他自己再找一次。设置有 `initialTab`
 * 兜底，只有真的没有账号面（`capabilities.accounts === 'none'`）时才落到配置。
 *
 * 面板与设置卡片里的**是同一批组件**：同一份字段、同一套校验、同一份乐观锁。
 * 两条入口不存在行为偏差。
 *
 * @module dsh-connect-desktop/client/capability/PanelSheet
 */

import { useEffect, useRef, useState } from 'react'

import { IconButton } from '../components/common.js'
import type { CardT } from '../components/types.js'
import type { VendorStatusView } from '../../shared/views.js'
import { AccountPanel } from './AccountPanel.js'
import { ConfigPanel } from './ConfigPanel.js'
import { DiagnosticsPanel } from './DiagnosticsPanel.js'
import { ModelsPanel } from './ModelsPanel.js'
import { resolveTab, tabsFor, type TabKey } from './tabs.js'

export interface PanelSheetProps {
  t: CardT
  vendor: VendorStatusView
  csrf: string | null
  onClose: () => void
  /** 打开时停在哪个 tab；给一个该供应商不存在的 tab 会被 `resolveTab` 兜底。 */
  initialTab?: TabKey
  /** 面板内的改动需要外层刷新状态条（账号数、额度、模型数都会变）。 */
  onChanged?: () => void
}

/**
 * 完整面板浮层。**模态**：配置与登录都有未保存状态，被一次误点弄丢说不过去。
 *
 * 与抽屉的分工：抽屉是非模态的即时操作（切账号、看额度、拨轮换），点外面就让开；
 * 这个浮层是要"读完再走"的东西。
 */
export function PanelSheet({ t, vendor, csrf, onClose, initialTab, onChanged }: PanelSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const tabs = tabsFor(vendor.capabilities)
  /*
   * 用 `resolveTab` 而不是 `useState(initialTab)`：声明的 tab 可能因为能力位
   * 不成立而根本没出现（例如没声明 diagnostics），那时要落到第一个可用的。
   */
  const [tab, setTab] = useState<TabKey>(() => resolveTab(tabs, initialTab ?? null)?.key ?? 'config')

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      <div className="dcss-sheet-backdrop" onMouseDown={onClose} aria-hidden="true" />
      <div
        className="dcss-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`dshcd-sheet-title-${vendor.id}`}
        data-dcss-cap="panel-sheet"
      >
        <div className="dcss-sheet-head">
          <strong id={`dshcd-sheet-title-${vendor.id}`}>{vendor.displayName}</strong>
          <span className="dcss-drawer-spacer" />
          <IconButton ref={closeRef} label={t('drawer.close')} onClick={onClose} />
        </div>

        {/* tab 条与设置卡片同一套语义：role=tab + aria-selected，键盘可用。 */}
        <div className="dcss-sheet-tabs" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={entry.key === tab}
              className={entry.key === tab ? 'dcss-sheet-tab dcss-sheet-tab-active' : 'dcss-sheet-tab'}
              onClick={() => setTab(entry.key)}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>

        <div className="dcss-sheet-body" role="tabpanel">
          {tab === 'account' ? (
            <AccountPanel
              key={`${vendor.id}-account`}
              t={t}
              vendor={vendor}
              csrf={csrf}
              onChanged={() => onChanged?.()}
            />
          ) : null}
          {tab === 'models' ? (
            <ModelsPanel
              key={`${vendor.id}-models`}
              t={t}
              vendorId={vendor.id}
              csrf={csrf}
              capabilities={vendor.capabilities}
              onChanged={() => onChanged?.()}
            />
          ) : null}
          {tab === 'config' ? (
            <ConfigPanel
              key={`${vendor.id}-config`}
              t={t}
              vendorId={vendor.id}
              csrf={csrf}
              onChanged={() => onChanged?.()}
            />
          ) : null}
          {tab === 'diagnostics' ? (
            <DiagnosticsPanel key={`${vendor.id}-diagnostics`} t={t} vendorId={vendor.id} csrf={csrf} />
          ) : null}
        </div>
      </div>
    </>
  )
}

/**
 * 输入框旁的额度徽标 —— 按**路由归属**判断，不再按供应商名写分支。
 *
 * 上一版是两个手写正则（`isLoomyRoute` / `isRaccoonRoute`）加两个徽标组件，
 * 于是第三家供应商需要第三个正则和第三个组件。现在只有一条规则：
 *
 * > 这条 provider 路由属于哪个供应商？= `route === id` 或 `route` 以 `${id}-` 开头。
 *
 * 归属判定用的是 `/status` 里各供应商自己的 id，也就是它声明的路由命名空间。
 * 额度数字取该供应商的 `credits` 路由，主数字由能力声明里的 `role: 'available'`
 * 决定（`headlineAmount`），所以换供应商不需要写格式化代码。
 *
 * @module dsh-connect-desktop/client/ComposerPill
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CreditsView, VendorStatusView } from '../shared/views.js'
import { Badge, IconButton } from './components/common.js'
import { PanelSheet } from './capability/PanelSheet.js'
import { ComposerDrawer } from './capability/ComposerDrawer.js'
import type { CardT } from './components/types.js'
import { formatCredit, headlineAmount } from './format.js'
import { ensureStyles } from './styles.js'
import { fetchStatus, requestVendor } from './transport.js'

/** 宿主交给 slot 组件的投影。 */
interface ModelSelectionSnapshot {
  readonly next?: { readonly provider?: string }
  readonly lastUsed?: { readonly provider?: string }
}

export interface ComposerPillProps {
  readonly t?: CardT
  readonly useProjection?: (name: 'modelSelection') => ModelSelectionSnapshot | undefined
}

/** 本次输入框会发往哪个 provider。 */
export function selectedProviderOf(projection: ModelSelectionSnapshot | undefined): string | undefined {
  const provider = (projection?.next ?? projection?.lastUsed)?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/**
 * 这条路由属于哪个供应商。
 *
 * 纯函数，可单测：给定供应商 id 集合与一个 provider 路由名，回答归属。没有别的地方
 * 再需要知道"loomy 的路由长什么样"。
 */
export function vendorForRoute(route: string | undefined, vendorIds: readonly string[]): string | undefined {
  if (route === undefined) return undefined
  return vendorIds.find((id) => route === id || route.startsWith(`${id}-`))
}

const passthrough = ((key: string) => key) as unknown as CardT

export function DesktopComposerPill(props: ComposerPillProps) {
  const t = props.t ?? passthrough
  const projection = props.useProjection?.('modelSelection')
  const route = selectedProviderOf(projection)
  const [vendors, setVendors] = useState<readonly VendorStatusView[]>([])
  const [csrf, setCsrf] = useState<string | null>(null)
  const [credits, setCredits] = useState<CreditsView | null>(null)
  const [open, setOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)


  const mounted = useRef(true)
  const pillRef = useRef<HTMLButtonElement>(null)

  /**
   * 关闭抽屉并把焦点还给徽标。
   *
   * 不归还焦点的话，抽屉一关，键盘用户的焦点就落回 `<body>`，下一次 Tab 要
   * 从头开始找。
   */
  const close = useCallback(() => {
    setOpen(false)
    pillRef.current?.focus()
  }, [])

  useEffect(() => {
    ensureStyles()
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const vendorId = useMemo(() => vendorForRoute(route, vendors.map((vendor) => vendor.id)), [route, vendors])

  const loadStatus = useCallback(async (): Promise<void> => {
    const result = await fetchStatus()
    if (!mounted.current || result.kind !== 'ok') return
    setVendors(result.value.vendors.filter((vendor) => vendor.available))
    setCsrf(result.value.csrfToken)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await loadStatus()
  }, [loadStatus])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (vendorId === undefined) {
      setCredits(null)
      return undefined
    }
    const controller = new AbortController()
    void (async () => {
      const result = await requestVendor<CreditsView>({ vendorId, suffix: 'credits', signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      setCredits(result.kind === 'ok' ? result.value : null)
    })()
    return () => controller.abort()
  }, [vendorId, route])

  const vendor = vendors.find((entry) => entry.id === vendorId)
  if (vendor === undefined) return null
  const amount = headlineAmount(vendor.capabilities.credits, credits)
  const formatted = formatCredit(amount ?? null)

  return (
    <div className="dcss-pill-anchor">
      <button
        ref={pillRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `dshcd-popover-${vendor.id}` : undefined}
        className={open ? 'dcss-pill dcss-pill-open' : 'dcss-pill'}
        title={t('composer.pillTitle', { vendor: vendor.displayName })}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ ['--dcss-accent' as string]: vendor.accent }}
      >
        <span className="dcss-pill-name">{vendor.displayName.split('（')[0]}</span>
        <span className="dcss-pill-sep" aria-hidden="true">·</span>
        <span className="dcss-pill-amount">{formatted.missing ? t('composer.pillBare', { vendor: vendor.displayName }) : formatted.text}</span>
      </button>
      {configOpen ? (
        <PanelSheet
          t={t}
          vendor={vendor}
          csrf={csrf}
          /* 从账号抽屉按进来，就先看账号——用户此刻关心的是"谁在付费"。 */
          initialTab="account"
          onClose={() => setConfigOpen(false)}
          onChanged={() => void refresh()}
        />
      ) : null}
      {open ? (
        vendor.capabilities.accounts === 'none' ? (
          <div className="dcss-drawer" role="dialog" aria-modal="false" id={`dshcd-popover-${vendor.id}`}>
            <div className="dcss-drawer-head">
              <strong>{vendor.displayName}</strong>
              <span className="dcss-drawer-spacer" />
              <Badge tone={vendor.available ? 'ok' : 'danger'}>
                {vendor.available ? t('account.loggedIn') : t('account.loggedOut')}
              </Badge>
              <IconButton className="dcss-drawer-close" label={t('drawer.close')} onClick={() => setOpen(false)} />
            </div>
            <p className="dcss-drawer-label">
              {vendor.credential.found
                ? vendor.credential.sourcePath
                : (vendor.credential.problem ?? t('card.empty.body'))}
            </p>
          </div>
        ) : (
          <ComposerDrawer
            t={t}
            vendor={vendor}
            csrf={csrf}
            onClose={close}
            onChanged={() => void refresh()}
            triggerRef={pillRef}
            onOpenConfig={() => setConfigOpen(true)}
          />
        )
      ) : null}
    </div>
  )
}

/** 旧名保留给索引文件。 */
export { DesktopComposerPill as LoomyComposerPill }

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

/**
 * 读额度失败后的静默重试：间隔与次数。
 *
 * 一个数字的失败通常是瞬时的（刚重启还没注册好、一次网络抖动），所以重试比让
 * 用户手动刷新更合适；但重试必须有上限，否则每次失败都会变成对上游的定时请求。
 *
 * **限流/风控/额度类失败不重试**：那正是"别马上再来"的信号，20 秒后再打一轮只
 * 会把它确认一遍（`docs/raccoon-upstream.md` §7.1：`balance` 连打十几次稳定
 * 403）。这类失败直接把原话留在按钮上，交给抽屉里的 ↻。
 */
const PILL_RETRY_MS = 20_000
const PILL_RETRY_LIMIT = 2

/** 这次失败是不是"再来一次只会更糟"的那一类。 */
function isThrottleLike(message: string): boolean {
  return /\b(403|429)\b|rate[\s_-]?limit|too many requests|throttl|限流|频繁|异常调用|暂时受限|风控|quota|insufficient|积分不足|余额不足/iu.test(
    message,
  )
}

const passthrough = ((key: string) => key) as unknown as CardT

export function DesktopComposerPill(props: ComposerPillProps) {
  const t = props.t ?? passthrough
  const projection = props.useProjection?.('modelSelection')
  const route = selectedProviderOf(projection)
  const [vendors, setVendors] = useState<readonly VendorStatusView[]>([])
  const [csrf, setCsrf] = useState<string | null>(null)
  const [credits, setCredits] = useState<CreditsView | null>(null)
  /*
   * 上一次读额度失败的原因。
   *
   * 旧代码把失败折叠成 `credits = null`，于是徽标只剩供应商名、没有任何线索——
   * 用户看到的"积分没显示"其实是一次 403/401/限流。原因必须能在这个按钮上读到
   * （`title`），否则同一句话又会变成"再刷新一下试试"。
   */
  const [creditsError, setCreditsError] = useState<string | null>(null)
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
      setCreditsError(null)
      return undefined
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0

    const run = async (): Promise<void> => {
      /*
       * `accounts=1`：徽标要的是**所有账号的合计**，而顶层 `fields` 只有在带这个
       * 参数时才由 `core/credits.ts#mergeCredits` 把逐账号数字相加得出。不带它，
       * 读到的是"本次挑中付费的那个账号"的余额——数字会随池轮换跳来跳去，而且
       * 明显偏小。
       *
       * 代价是 host 会为每个账号打一次上游（并发 3、各自 60s memo），所以这是
       * 一次"打开会话时贵一点、之后命中缓存"的取舍；徽标本来就是给"我还有多少
       * 额度"这个问题用的，单账号数字回答不了它。
       */
      const result = await requestVendor<CreditsView>({
        vendorId,
        suffix: 'credits',
        query: 'accounts=1',
        signal: controller.signal,
      })
      if (!mounted.current || controller.signal.aborted) return
      if (result.kind === 'ok') {
        setCredits(result.value)
        setCreditsError(null)
        return
      }
      /*
       * 失败 ≠ 没有额度：清掉可能已经过期的数字（不把旧值当现值），把上游原话
       * 留在按钮的 `title` 里，并静默重试有限次——上游限流与网关抖动都是瞬时的，
       * 用户不该为了一个数字自己去点刷新；无限重试则是在打上游，所以有上限。
       *
       * `stale`（宿主还是旧路由表）重试没有意义，只留文案。
       */
      setCredits(null)
      setCreditsError(result.message.length > 0 ? result.message : null)
      const transient = !isThrottleLike(result.message)
      if (result.kind !== 'stale' && transient && retries < PILL_RETRY_LIMIT) {
        retries += 1
        timer = setTimeout(() => void run(), PILL_RETRY_MS)
      }
    }

    void run()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [vendorId, route])

  const vendor = vendors.find((entry) => entry.id === vendorId)
  if (vendor === undefined) return null
  const amount = headlineAmount(vendor.capabilities.credits, credits)
  const formatted = formatCredit(amount ?? null)
  /*
   * 合计里少算了几个账号，必须说出来。
   *
   * `mergeCredits` 只累加读得到的账号：一个 401 的账号会让合计悄悄变小，而"合计
   * 变小"和"额度被用掉"在界面上长得一模一样。所以把读不到的个数写进 title，
   * 抽屉里还能逐行看到是哪几个。
   */
  const unreadable = (credits?.perAccount ?? []).filter((row) => row.error !== undefined).length
  /*
   * 三种状态三种说法：读到数字 / 正在读 / 读失败。
   *
   * 之前只有一个模板，且 `{available}` 在被调用时没有传——失败态下 title 会原样
   * 显示 `可用 {available}`，等于把占位符当文案发给了用户。
   */
  /*
   * 余额接口被限流时会拿到一份"有明细、没有余额桶"的视图（`partial`）。
   * 这时候说"仍在读取"是错的——它已经读完了，读到的是上游的 403。
   */
  const partial = credits?.partial === 'balance_unavailable'
  const pillTitle =
    partial && amount === undefined
      ? t('composer.pillPartial', { vendor: vendor.displayName, message: credits?.partialReason ?? '' })
      : amount === undefined
      ? creditsError === null
        ? t('composer.pillPending', { vendor: vendor.displayName })
        : t('composer.pillFailed', { vendor: vendor.displayName, message: creditsError })
      : unreadable === 0
        ? t('composer.pillTitle', { vendor: vendor.displayName, available: formatted.text })
        : t('composer.pillTitlePartial', {
            vendor: vendor.displayName,
            available: formatted.text,
            unreadable,
          })
  const pillClassName =
    creditsError === null ? (open ? 'dcss-pill dcss-pill-open' : 'dcss-pill') : 'dcss-pill dcss-pill-missing'

  return (
    <div className="dcss-pill-anchor">
      <button
        ref={pillRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `dshcd-popover-${vendor.id}` : undefined}
        className={pillClassName}
        title={pillTitle}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ ['--dcss-accent' as string]: vendor.accent }}
      >
        <span className="dcss-pill-name">{vendor.displayName.split('（')[0]}</span>
        <span className="dcss-pill-sep" aria-hidden="true">·</span>
        <span
          className="dcss-pill-amount"
          data-dcss-cap={creditsError === null ? 'pill-amount' : 'pill-amount-missing'}
        >
          {formatted.missing ? t('composer.pillBare', { vendor: vendor.displayName }) : formatted.text}
        </span>
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

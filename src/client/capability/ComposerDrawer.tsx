/**
 * 输入框旁的账号抽屉：**逐账号额度 + 切换 + 刷新**。
 *
 * 这一层在重构中一度退化成只读 popover（只剩凭据路径），把"多账号用户在聊天
 * 界面里快速看一眼谁的余额、并切过去"这个日常动作赶回了设置页。这里补回来，
 * 但**不复制设置卡片的账号行**：卡片负责增删改（重命名、导出、收养），抽屉只
 * 负责"看一眼 + 切过去"，两者职责不同。
 *
 * 它仍然不知道供应商是谁：账号来自 `<vendor>/accounts`，额度来自
 * `<vendor>/credits` 的 `perAccount`（按 `accountId` 配对），切换走
 * `<vendor>/accounts/active`。主数字取能力声明里 `role: 'available'` 的桶。
 *
 * @module dsh-connect-desktop/client/capability/ComposerDrawer
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useClampToViewport } from './clamp.js'
import type { AccountsView, CreditsView, PoolStateView, VendorStatusView } from '../../shared/views.js'
import { IconButton } from '../components/common.js'
import type { CardT } from '../components/types.js'
import { formatCredit, headlineField } from '../format.js'
import { requestVendor } from '../transport.js'
import { accountEntryAmount, useAccountCredits, type AccountCreditEntry } from './useAccountCredits.js'

export interface ComposerDrawerProps {
  t: CardT
  vendor: VendorStatusView
  csrf: string | null
  onClose: () => void
  /** 切换账号后通知外层（徽标要换成新账号的数字）。 */
  onChanged?: () => void
  /** 打开完整面板浮层（就地渲染，不依赖宿主导航；见 `PanelSheet`）。 */
  onOpenConfig: () => void
  /** 触发它的徽标：点它不算"点外面"（开合由它自己负责）。 */
  triggerRef?: React.RefObject<HTMLElement>
}

/**
 * 一个原因一个说法。
 *
 * 键名集中在这里而不是散在 JSX 里：账号页用的是同一套档案（`accounts.benched*`），
 * 两处的词必须能对上，否则抽屉说"登录已失效"、设置页说"轮换已跳过"。
 */
export const BENCHED_LABEL = {
  auth: 'drawer.benchedAuth',
  points: 'drawer.benchedPoints',
  temporary: 'drawer.benched',
} as const

export function ComposerDrawer({
  t,
  vendor,
  csrf,
  onClose,
  onChanged,
  onOpenConfig,
  triggerRef,
}: ComposerDrawerProps) {
  const [accounts, setAccounts] = useState<AccountsView | null>(null)
  const [credits, setCredits] = useState<CreditsView | null>(null)
  /*
   * 额度读数失败的原因。
   *
   * 之前这里只有 `if (creditsResult.kind === 'ok') setCredits(...)`——失败被丢掉，
   * 于是整列渲染成 `—` 却没有任何解释：上游 403、登录态过期、逐账号读取全挂，
   * 在界面上都长成同一个"没有数字"。失败必须说出来（抽屉右上角的 ↻ 就是重试）。
   */
  const [creditsError, setCreditsError] = useState<string | null>(null)
  const [pool, setPool] = useState<PoolStateView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const closeRef = useRef<HTMLButtonElement>(null)
  // 徽标靠左时抽屉会向左溢出（实测 −144px）：贴边矫正。
  const { ref: drawerRef, reclamp } = useClampToViewport<HTMLDivElement>()
  const titleId = `dshcd-drawer-title-${vendor.id}`

  const load = useCallback(
    async (options: { force?: boolean } = {}): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const [accountsResult, creditsResult, poolResult] = await Promise.all([
          requestVendor<AccountsView>({ vendorId: vendor.id, suffix: 'accounts' }),
          /*
           * 这里**只读总额**（`accounts=1` 由逐账号懒加载负责，见 needRefresh）。
           *
           * 早先是 `accounts=1` 一次拿全：90 个账号要 5 秒以上，抽屉在那段时间里
           * 是一列空的 `—`。现在逐账号走 `credits/account`，一行一条、随到随填。
           */
          requestVendor<CreditsView>({
            vendorId: vendor.id,
            suffix: 'credits',
            ...(options.force === true ? { query: 'force=1' } : {}),
          }),
          // 轮换开关只在供应商声明了 pool 时才有路由；没声明时这次请求会拿到 404，
          // 结果是 unavailable —— 下面据此不渲染开关。
          vendor.capabilities.pool
            ? requestVendor<PoolStateView>({ vendorId: vendor.id, suffix: 'pool' })
            : Promise.resolve({ kind: 'unavailable' as const, reason: 'missing_route' as const, message: 'pool' }),
        ])
        if (!alive.current) return
        if (accountsResult.kind === 'ok') setAccounts(accountsResult.value)
        else if (accountsResult.kind === 'failed') setError(accountsResult.message)
        if (creditsResult.kind === 'ok') {
          setCredits(creditsResult.value)
          setCreditsError(null)
        } else if (creditsResult.kind === 'failed') {
          // 保留上一次读到的数字（可能是这轮缓存的），但必须说明它为什么不再刷新。
          setCreditsError(creditsResult.message.length > 0 ? creditsResult.message : null)
        }
        if (poolResult.kind === 'ok') setPool(poolResult.value)
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [vendor.id],
  )

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // 数据落地后内容高度变化，位移可能不再合适：再算一次。
  useEffect(() => {
    if (accounts !== null) reclamp()
  }, [accounts, reclamp])

  /*
   * 点外面关闭。
   *
   * 抽屉浮在输入框上方、没有遮罩，用户最自然的动作是点别处继续聊天——那时
   * 抽屉必须让开。用 `mousedown` 而不是 `click`：click 会在用户开始拖选文本时
   * 才触发，导致"我明明只是选个字，抽屉却关了"。
   *
   * 触发器（pill）自己要被排除：它的 onClick 负责开合，两边都处理会对开合的
   * 同一次点击各关一次。
   */
  useEffect(() => {
    const onPointerDown = (event: MouseEvent | TouchEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      const drawer = drawerRef.current
      const trigger = triggerRef?.current
      if (drawer?.contains(target) === true) return
      if (trigger?.contains(target) === true) return
      onClose()
    }
    const view = closeRef.current?.ownerDocument.defaultView
    if (view === null || view === undefined) return undefined
    view.addEventListener('mousedown', onPointerDown)
    view.addEventListener('touchstart', onPointerDown)
    return () => {
      view.removeEventListener('mousedown', onPointerDown)
      view.removeEventListener('touchstart', onPointerDown)
    }
  }, [onClose, triggerRef, drawerRef])

  /*
   * 焦点管理：这是抽屉可用性的另一半（另一半是 aria-*）。
   * - 打开时把焦点移进来，否则键盘用户还停在输入框上、Esc 也听不到；
   * - Esc 关掉它；
   * - 关闭后由父级把焦点还给徽标（见 ComposerPill）。
   */
  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const switchTo = async (id: string): Promise<void> => {
    if (csrf === null) return
    setBusy(true)
    try {
      const result = await requestVendor<AccountsView>({
        vendorId: vendor.id,
        suffix: 'accounts/active',
        method: 'POST',
        body: { id },
        csrf,
      })
      if (result.kind !== 'ok') {
        setError(result.kind === 'failed' ? result.message : t('common.unknownError'))
        return
      }
      setAccounts(result.value)
      await load({ force: true })
      onChanged?.()
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  /** 抽屉里直接切换轮换：这是输入框旁最常被问的那个开关。 */
  const toggleRotation = async (enabled: boolean): Promise<void> => {
    if (csrf === null) return
    setBusy(true)
    setError(null)
    try {
      const result = await requestVendor<PoolStateView>({
        vendorId: vendor.id,
        suffix: 'pool',
        method: 'POST',
        body: { enabled },
        csrf,
      })
      if (result.kind !== 'ok') {
        setError(result.kind === 'failed' ? result.message : t('common.unknownError'))
        return
      }
      setPool(result.value)
      // 轮换开关会改变"谁在付费"，账号列表里的当前账号高亮要跟着变。
      await load({ force: true })
      onChanged?.()
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const rows = accounts?.accounts ?? []
  /*
   * 逐账号额度懒加载：账号行先画出来，数字一行一行到货。
   * 账号集合没变（内容相同）时不会重复请求；宿主侧还有 60 秒 per-account memo。
   */
  const { entries: perAccountCredits } = useAccountCredits({
    vendorId: vendor.id,
    accountIds: rows.map((row) => row.id),
    enabled: vendor.capabilities.credits.kind !== 'none',
  })
  /*
   * 合计也用**已经到货的**逐行结果自己累加，而不是等宿主一次性算完。
   *
   * 这就是"读到一个更新一个"：每行数字回来，合计跟着涨，进度跟着走。宿主那条
   * `credits?accounts=1` 仍是权威口径（CLI 与胶囊用），但它要等全部账号，不能
   * 拿来做这个数字。
   */
  const headlineKey = headlineField(vendor.capabilities.credits)?.key
  const arrived = rows.map((row) => perAccountCredits[row.id]).filter((entry) => entry !== undefined)
  const readableRows = arrived.filter((entry) => entry.error === undefined)
  const totalRead = rows.length === 0 ? 0 : arrived.length
  const totalAmount =
    readableRows.length === 0
      ? undefined
      : readableRows.reduce(
          (sum, entry) =>
            sum + (headlineKey !== undefined && typeof entry.fields[headlineKey] === 'number'
              ? entry.fields[headlineKey]
              : 0),
          0,
        )
  const rotating = accounts?.rotating === true
  // 轮换时 activeId 不代表"刚花了谁的钱"，用 lastUsedId 标出真实的那一笔。
  const lastUsedId = accounts?.lastUsedId
  const canSwitch = vendor.capabilities.accounts === 'multi' && !rotating && csrf !== null
  // 与输入框徽标同一个定义：`role: 'available'` 的桶，缺省回落到第一个。
  const key = headlineField(vendor.capabilities.credits)?.key

  return (
    <div
      ref={drawerRef}
      className="dcss-drawer"
      role="dialog"
      /* 非模态：它不锁住整个页面，只是浮在输入框上方。 */
      aria-modal="false"
      aria-labelledby={titleId}
      id={`dshcd-popover-${vendor.id}`}
      data-dcss-cap="drawer"
    >
      {/*
        所有动作统一在右上角，且都是图标按钮：抽屉只有 260px 宽，一个文字按钮
        就会把标题挤成省略号。三个图标 = 配置 · 刷新 · 关闭。
      */}
      <div className="dcss-drawer-head">
        <strong id={titleId}>{vendor.displayName}</strong>
        <span className="dcss-drawer-spacer" />
        <IconButton
          glyph="⚙"
          label={t('drawer.openPanel')}
          data-dcss-cap="drawer-open-config"
          onClick={() => {
            onOpenConfig()
            onClose()
          }}
        />
        <IconButton
          glyph="↻"
          label={busy ? t('drawer.refreshing') : t('drawer.refresh')}
          data-dcss-cap="drawer-refresh"
          disabled={busy}
          onClick={() => void load({ force: true })}
        />
        <IconButton ref={closeRef} className="dcss-drawer-close" label={t('drawer.close')} onClick={onClose} />
      </div>

      {error === null ? null : (
        <div className="dcss-drawer-error" role="alert">
          {error}
        </div>
      )}
      {/*
        额度读不出来时不能只留一列 `—`：用户分不清是"这个账号没额度""读取中"还是
        "上游把接口关了"。把原因原文放上来，并指向唯一能重试的地方（↻）。
      */}
      {creditsError === null ? null : (
        <div className="dcss-drawer-error" role="alert" data-dcss-cap="drawer-credits-error">
          {t('drawer.creditsFailed', { message: creditsError })}
        </div>
      )}
      {/*
        余额被限流、明细还能读：整列 `—` 必须有一句解释。
        没有这句时，"积分不见了"和"账号坏了"在界面上完全一样。
      */}
      {credits?.degraded === 'setting_info' ? (
        <div className="dcss-hint" data-dcss-cap="drawer-credits-degraded">
          {t('drawer.degraded')}
        </div>
      ) : null}
      {credits?.partial === 'balance_unavailable' ? (
        <div className="dcss-drawer-error" role="status" data-dcss-cap="drawer-credits-partial">
          {t('drawer.partial', { message: credits.partialReason ?? 'HTTP 403' })}
        </div>
      ) : null}
      {rows.length === 0 ? null : (
        <div className="dcss-drawer-total" data-dcss-cap="drawer-total">
          <span className="dcss-drawer-total-label">{t('drawer.totalLabel')}</span>
          <strong className="dcss-drawer-total-amount">
            {totalAmount === undefined ? '…' : formatCredit(totalAmount).text}
          </strong>
          {totalRead < rows.length ? (
            <span className="dcss-drawer-total-progress" data-dcss-cap="drawer-progress">
              {t('drawer.progress', { done: totalRead, total: rows.length })}
            </span>
          ) : null}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="dcss-drawer-label">
          {vendor.credential.found ? t('drawer.empty') : t('drawer.signedOut')}
        </div>
      ) : (
        <div className="dcss-drawer-list">
          {rows.map((row, index) => {
            /*
             * 三种状态要分开：还没到货（`…`）、读到了（数字）、读失败（`—`）。
             * 懒加载之后"没到货"会持续几百毫秒，把它画成 `—` 等于宣告失败。
             */
            const entry: AccountCreditEntry | undefined = perAccountCredits[row.id]
            const pending = entry === undefined
            const amount = accountEntryAmount(entry, key)
            const formatted = formatCredit(amount ?? null)
            const isActive = !rotating && accounts?.activeId === row.id
            return (
              <div key={row.id} className="dcss-drawer-row-wrap">
                <button
                  type="button"
                  className={isActive ? 'dcss-drawer-row dcss-drawer-row-active' : 'dcss-drawer-row'}
                  disabled={!canSwitch || isActive}
                  onClick={() => void switchTo(row.id)}
                  title={canSwitch || isActive ? t('drawer.title') : t('drawer.rotating')}
                >
                  <span className="dcss-drawer-identity">
                    {row.label ?? row.phone ?? t('drawer.accountFallback', { index: index + 1 })}
                  </span>
                  {/*
                    读不到时报 `—`（缺失不是 0），并把"为什么读不到"放进 title：
                    逐账号失败的原因（登录态过期、限流…）只在这一行上有意义。
                  */}
                  <span
                    className="dcss-drawer-credits"
                    data-dcss-cap={pending ? 'row-pending' : entry?.error === undefined ? 'row-amount' : 'row-error'}
                    title={entry?.error ?? creditsError ?? t('drawer.creditsMissing')}
                  >
                    {pending ? '…' : entry?.error === undefined ? formatted.text : '—'}
                  </span>
                  {/*
                    三种"被跳过"必须三种说法：401/密钥无效要去重新登录，额度不足要
                    充值，限流等一会儿就好。共用一个"轮换已跳过"时，用户唯一能做的
                    动作（重新登录）被这句话藏起来了。
                  */}
                  {row.unavailable ? (
                    <span
                      className={
                        row.unavailableKind === 'auth'
                          ? 'dcss-drawer-badge dcss-drawer-badge-bad'
                          : 'dcss-drawer-badge'
                      }
                      title={row.unavailableMessage ?? undefined}
                    >
                      {t(BENCHED_LABEL[row.unavailableKind ?? 'temporary'])}
                    </span>
                  ) : null}
                  {row.id === lastUsedId && !row.unavailable ? (
                    <span className="dcss-drawer-lastused" title={t('accounts.lastUsedHint')}>
                      {t('accounts.lastUsed')}
                    </span>
                  ) : null}
                  {isActive ? <span className="dcss-drawer-check">✓</span> : null}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/*
        轮换开关放在抽屉里：用户在输入框旁最常问的就是"这次是谁付费"。
        设置卡片里同一个开关仍在（那是完整配置），这里是快捷入口。
      */}
      {pool === null ? null : (
        <label className="dcss-drawer-pool-toggle" data-dcss-cap="drawer-pool">
          <input
            type="checkbox"
            checked={pool.enabled}
            disabled={busy || csrf === null}
            onChange={(event) => void toggleRotation(event.target.checked)}
          />
          <span>{t('pool.label')}</span>
        </label>
      )}

    </div>
  )
}

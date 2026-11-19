/**
 * The account list: one row per stored account, every action capability-gated.
 *
 * A row answers three questions in one line — who is this, is it usable, what is
 * it worth — and then offers only the actions its vendor declares:
 *
 * | capability                | control                       |
 * |---------------------------|-------------------------------|
 * | `accounts: 'multi'`       | switch (`/accounts/active`)   |
 * | `accounts: 'multi'`       | rename (`/accounts/rename`)   |
 * | any `accounts` mode       | remove (`/accounts/remove`)   |
 * | `adopt`                   | adopt the desktop sign-in     |
 * | `transfer`                | export this one account       |
 *
 * Identity never leaks an internal id: a row with no label and no phone renders
 * `Account {n}`, because `acc-1794989874567-nz093c` is an implementation detail a
 * user cannot act on (and the first build shipped exactly that).
 *
 * @module dsh-connect-desktop/client/capability/AccountRows
 */

import { useEffect, useRef, useState } from 'react'
import type {
  AccountRowView,
  AccountsView,
  CreditsView,
  VendorCapabilities,
} from '../../shared/views.js'
import { formatCredit } from '../format.js'
import { requestVendor } from '../transport.js'
import { Badge, CardButton, IconButton, Notice } from '../components/common.js'
import { failureMessage, type CardT, type Loadable } from '../components/types.js'
import { transportMessage } from './LoginForms.js'

export interface AccountRowsProps {
  t: CardT
  vendorId: string
  csrf: string | null
  state: Loadable<AccountsView>
  capabilities: VendorCapabilities
  /** Per-account figures for the inline column, when the vendor reports them. */
  credits: CreditsView | null
  onChanged: () => void
}

/** Render every account as a compact row. */
export function AccountRows({ t, vendorId, csrf, state, capabilities, credits, onChanged }: AccountRowsProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <p className="dcss-muted">{t('common.loading')}</p>
  }
  if (state.kind === 'unavailable') return <p className="dcss-muted">{t('accounts.unavailable')}</p>
  if (state.kind === 'stale') return <Notice tone="error">{state.message}</Notice>
  if (state.kind === 'failed') {
    return <Notice tone="error">{t('accounts.failed', { message: failureMessage(state, t) ?? state.message })}</Notice>
  }

  const view = state.value
  const rows = view.accounts
  const rotating = view.rotating === true
  const lastUsedId = view.lastUsedId
  /** 只有序号、没有任何可识别信息的账号——批量清理的对象。 */
  const unidentified = rows.filter(
    (row, index) =>
      needsIdentityHint(row) && identityOf(row, index, t) === t('accounts.accountFallback', { index: String(index + 1) }),
  )
  /*
   * 能不能回填：看这家供应商有没有声明 `enrich` 能力。客户端不知道 UUID 细节，
   * 只按能力位渲染——这是整个架构的约定。
   */
  const enrichable = capabilities.accounts === 'multi'

  /** 回填缺失的手机号（一次性修复老账号）。 */
  async function enrichIdentities(): Promise<void> {
    if (csrf === null) return
    setBusy('enrich')
    setError(null)
    try {
      const result = await requestVendor<{ ok: true; filled: number }>({
        vendorId,
        suffix: 'accounts/enrich',
        method: 'POST',
        csrf,
        body: {},
      })
      if (result.kind !== 'ok') {
        setError(transportMessage(result, t, t('common.unknownError')) ?? null)
        return
      }
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  /** 批量移除：逐个调用同一路由（低频操作，不值得为它加一个新接口）。 */
  async function removeMany(ids: readonly string[]): Promise<void> {
    setConfirmCleanup(false)
    for (const id of ids) {
      const ok = await post('accounts/remove', { id }, id)
      if (!ok) return
    }
  }

  async function post(suffix: string, body: unknown, id: string): Promise<boolean> {
    if (csrf === null) return false
    setBusy(id)
    setError(null)
    const result = await requestVendor<{ ok: true }>({ vendorId, suffix, method: 'POST', csrf, body })
    setBusy(null)
    if (result.kind !== 'ok') {
      setError(transportMessage(result, t, t('transfer.failed')) ?? null)
      return false
    }
    onChanged()
    return true
  }

  return (
    <div className="dcss-panel">
      {rows.length === 0 ? (
        <Notice tone="info">{t('accounts.empty')}</Notice>
      ) : (
        <div className="dcss-acct-list">
          {rows.map((row, index) => {
            const identity = identityOf(row, index, t)
            const isActive = rotating !== true && view.activeId === row.id
            const amount = inlineAmount(row, capabilities, credits)
            const classes = ['dcss-acct-row']
            if (isActive) classes.push('dcss-acct-row-active')
            return (
              <div className={classes.join(' ')} key={row.id} data-dcss-account={row.id}>
                {/*
                  三格：谁 | 多少额度 | 能做什么。
                  之前这里直接平铺了 7 个元素（名字、两个徽标、额度、spacer、动作、重命名框），
                  而网格只定义了 3 列——第 4 个开始每行一个，账号行于是被撑成三行。
                  现在把徽标收进「身份」格，重命名框跨整行。
                */}
                <span className="dcss-acct-who">
                  <span className="dcss-acct-identity" title={identity}>
                    {identity}
                  </span>
                  {row.origin === 'desktop' ? (
                    <span title={t('accounts.desktopNote')}>
                      <Badge tone="neutral">{t('account.originDesktop')}</Badge>
                    </span>
                  ) : null}
                  {isActive ? <Badge tone="ok">{t('accounts.active')}</Badge> : null}
                {row.id === lastUsedId && !row.unavailable ? (
                  <Badge tone="neutral" title={t('accounts.lastUsedHint')}>
                    {t('accounts.lastUsed')}
                  </Badge>
                ) : null}
                  {row.unavailable ? <Badge tone="danger">{t('accounts.benched')}</Badge> : null}
                  {row.route.length === 0 ? <span className="dcss-label">{t('accounts.notRouted')}</span> : null}
                  {needsIdentityHint(row) ? (
                    <span className="dcss-acct-hint" title={t('accounts.identityMissingHint')}>
                      ?
                    </span>
                  ) : null}
                </span>
                {amount === null ? <span className="dcss-acct-credits" /> : <span className="dcss-acct-credits">{amount}</span>}
                <span className="dcss-acct-actions">
                  {row.origin === 'desktop' && capabilities.adopt ? (
                    <CardButton
                      data-dcss-cap="adopt"
                      disabled={busy !== null || csrf === null}
                      onClick={() => void post('accounts/adopt', {}, row.id)}
                    >
                      {busy === row.id ? t('accounts.adopting') : t('accounts.adopt')}
                    </CardButton>
                  ) : null}
                  {capabilities.accounts === 'multi' && !isActive ? (
                    <CardButton
                      data-dcss-cap="switch"
                      disabled={busy !== null || csrf === null || rotating}
                      onClick={() => void post('accounts/active', { id: row.id }, row.id)}
                    >
                      {t('accounts.choose')}
                    </CardButton>
                  ) : null}
                  {row.origin === 'desktop' ? null : (
                    <AccountRowMenu
                      t={t}
                      row={row}
                      capabilities={capabilities}
                      busy={busy}
                      csrf={csrf}
                      confirmRemove={confirmRemove === row.id}
                      onRename={() => {
                        setRenaming(row.id)
                        setDraftLabel(row.label ?? '')
                      }}
                      onExport={() => void post('accounts/export', { id: row.id }, row.id)}
                      onAskRemove={() => setConfirmRemove(row.id)}
                      onCancelRemove={() => setConfirmRemove(null)}
                      onRemove={() => {
                        setConfirmRemove(null)
                        void post('accounts/remove', { id: row.id }, row.id)
                      }}
                    />
                  )}
                </span>
                {renaming === row.id ? (
                  <div className="dcss-acct-rename">
                    <input
                      className="dcss-inline-input"
                      value={draftLabel}
                      aria-label={t('accounts.rename')}
                      onChange={(event) => setDraftLabel(event.target.value)}
                    />
                    <CardButton
                      disabled={busy !== null || csrf === null}
                      onClick={() => {
                        setRenaming(null)
                        void post('accounts/rename', { id: row.id, label: draftLabel }, row.id)
                      }}
                    >
                      {t('accounts.renameSave')}
                    </CardButton>
                    <CardButton variant="ghost" onClick={() => setRenaming(null)}>
                      {t('common.cancel')}
                    </CardButton>
                  </div>
                ) : null}
                {row.unavailable && row.unavailableMessage !== undefined ? (
                  <p className="dcss-acct-note">{row.unavailableMessage}</p>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      <p className="dcss-row-note">
        {t('accounts.routesNow')}{' '}
        {(rows.length === 0
          ? [t('common.none')]
          : [...new Set(rows.map((row) => row.route).filter((route) => route.length > 0))]
        ).join(' · ')}
      </p>
      {/*
        一批账号既没有号码也没有名字时，界面上是一列「账号 1…9」——用户分不清
        谁是谁，也没法用。这类记录多半是早期导入/反复登录的残留（源头就没有号码，
        恢复不出来），与其让人一条条点 ⋯ 移除，不如给一次批量清理。
        仍然要二次确认：删的是登录态。
      */}
      {/*
        先救再删：手机号只存在于上游 `user_info` 里，早先的版本没存它。与其
        让用户把认不出的账号一条条删掉重登，不如先按 token 回填一次号码。
        只有回填后仍然认不出的，才提供清理。
      */}
      {unidentified.length >= 1 && enrichable ? (
        <div className="dcss-acct-cleanup" data-dcss-cap="enrich">
          <span className="dcss-hint">{t('accounts.enrichHint', { count: unidentified.length })}</span>
          <CardButton
            variant="ghost"
            disabled={busy !== null || csrf === null}
            onClick={() => void enrichIdentities()}
          >
            {t('accounts.enrich')}
          </CardButton>
        </div>
      ) : null}
      {unidentified.length >= 2 ? (
        <div className="dcss-acct-cleanup" data-dcss-cap="cleanup">
          <span className="dcss-hint">{t('accounts.cleanupHint', { count: unidentified.length })}</span>
          {confirmCleanup ? (
            <>
              <CardButton
                variant="ghost"
                disabled={busy !== null || csrf === null}
                onClick={() => void removeMany(unidentified.map((row) => row.id))}
              >
                {t('accounts.cleanupConfirm', { count: unidentified.length })}
              </CardButton>
              <CardButton variant="ghost" onClick={() => setConfirmCleanup(false)}>
                {t('common.cancel')}
              </CardButton>
            </>
          ) : (
            <CardButton variant="ghost" onClick={() => setConfirmCleanup(true)}>
              {t('accounts.cleanup')}
            </CardButton>
          )}
        </div>
      ) : null}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </div>
  )
}

/**
 * 这一行叫什么。
 *
 * 顺序：label（用户起的名字）→ 手机号 → 本地用户 id → 桌面端说明 → 序号。
 *
 * **不要用 `route` 兜底。** 单路由供应商（小浣熊）的所有账号共用一个 route，
 * 拿它当名字的结果是每一行都显示 "raccoon"——比序号还难认。route 只在多路由
 * 供应商里能区分账号，而客户端无法可靠判断这一点，所以这条回退必须去掉。
 */
/**
 * 身份类型枚举——不是名字。
 *
 * 早先的版本把上游返回的 `identity`（personal / enterprise）直接写进了
 * `label`，于是这些账号的名字变成一行英文。存量数据里还留着，显示时跳过它们。
 */
const IDENTITY_KIND_LABELS = new Set(['personal', 'enterprise', 'org', 'individual'])

/**
 * 旧数据里的身份类型，翻译成用户能读的说法。
 *
 * 早先版本把上游的 `personal`/`enterprise` 写进了 `label`。直接过滤掉会让
 * 账号变成「账号 3」；显示成「个人账号 / 企业账号」至少说明了这一条是什么。
 */
function identityKindLabel(label: string, t: CardT): string | undefined {
  switch (label.toLowerCase()) {
    case 'personal':
      return t('accounts.identityPersonal')
    case 'enterprise':
      return t('accounts.identityEnterprise')
    case 'individual':
      return t('accounts.identityPersonal')
    case 'org':
      return t('accounts.identityEnterprise')
    default:
      return undefined
  }
}

/**
 * 把长标识截短到可辨认的长度。
 *
 * 小浣熊的 `userId` 是 `pu-01a1e893-1354-727d-9e59-6a5d522a0172`——完整显示会
 * 撑满整行，但前缀已经足够区分不同账号。完整值放在 `title` 里。
 */
function shortenIdentity(value: string): string {
  return value.length <= 22 ? value : `${value.slice(0, 14)}…${value.slice(-6)}`
}

function identityOf(row: AccountRowView, index: number, t: CardT): string {
  const label = row.label?.trim()
  if (label !== undefined && label.length > 0) {
    const kind = identityKindLabel(label, t)
    // 身份类型不是名字：只有当它后面没有更好的信息时才用它。
    if (kind === undefined) return label
    if (row.phone !== undefined && row.phone.length > 0) return row.phone
    if (row.userId !== undefined && row.userId.length > 0) return shortenIdentity(row.userId)
    return kind
  }
  if (row.phone !== undefined && row.phone.length > 0) return row.phone
  if (row.userId !== undefined && row.userId.length > 0) return shortenIdentity(row.userId)
  if (row.origin === 'desktop') return t('accounts.desktopSignIn')
  return t('accounts.accountFallback', { index: String(index + 1) })
}

/**
 * 这个账号除了序号之外还有没有可识别的信息。
 *
 * 没有的话（早先登录时上游没回手机号、导入的包里也没有），界面要告诉用户
 * **能做什么**——`⋯` 菜单里可以重命名，或者移除后重新登录。
 * 只显示「账号 3」会让人以为功能坏了。
 */
function needsIdentityHint(row: AccountRowView): boolean {
  const label = row.label?.trim()
  const hasLabel = label !== undefined && label.length > 0 && !IDENTITY_KIND_LABELS.has(label.toLowerCase())
  const hasPhone = row.phone !== undefined && row.phone.length > 0
  const hasUserId = row.userId !== undefined && row.userId.length > 0
  return !hasLabel && !hasPhone && !hasUserId && row.origin !== 'desktop'
}

/**
 * This account's own figure, or `null` when the vendor reports none.
 *
 * Looked up by **account id**, then by route: one route can serve several
 * accounts, so a route-only key collapsed them onto whichever came first.
 */
function inlineAmount(
  row: AccountRowView,
  capabilities: VendorCapabilities,
  credits: CreditsView | null,
): string | null {
  if (credits === null || capabilities.credits.kind !== 'balance') return null
  const headline = capabilities.credits.fields.find((field) => field.role === 'available') ??
    capabilities.credits.fields[0]
  if (headline === undefined) return null
  const entries = credits.perAccount ?? []
  const entry = entries.find((candidate) => candidate.accountId === row.id) ??
    entries.find((candidate) => candidate.accountId === undefined && candidate.route === row.route)
  if (entry === undefined) return null
  if (entry.error !== undefined) return '· —'
  const amount = formatCredit(entry.fields[headline.key])
  return amount.missing ? null : amount.text
}

/**
 * 一个账号行的次要动作菜单。
 *
 * 为什么把「重命名 / 导出 / 移除」收进菜单：它们都不是高频动作（改名一次、导出换机
 * 时才做、移除更少），却和主按钮一样宽，一行四个按钮把账号名挤成一小条。
 *
 * 移除走二次确认：它会销毁登录态，用一次菜单点击就执行太轻了。
 */
function AccountRowMenu({
  t,
  row,
  capabilities,
  busy,
  csrf,
  confirmRemove,
  onRename,
  onExport,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  t: CardT
  row: AccountRowView
  capabilities: VendorCapabilities
  busy: string | null
  csrf: string | null
  confirmRemove: boolean
  onRename: () => void
  onExport: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  // 点外面或按 Esc 收起：菜单不该成为"必须再点一次触发器"的陷阱。
  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const disabled = busy !== null || csrf === null
  const canRename = capabilities.accounts === 'multi'
  const canExport = capabilities.transfer

  return (
    <span className="dcss-row-menu" ref={rootRef}>
      <IconButton
        glyph="⋯"
        label={t('accounts.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="dcss-row-menu-trigger"
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <span className="dcss-row-menu-panel" role="menu">
          {canRename ? (
            <button
              type="button"
              role="menuitem"
              className="dcss-row-menu-item"
              data-dcss-cap="rename"
              disabled={disabled}
              title={t('accounts.renameHint')}
              onClick={() => {
                setOpen(false)
                onRename()
              }}
            >
              {t('accounts.rename')}
            </button>
          ) : null}
          {canExport ? (
            <button
              type="button"
              role="menuitem"
              className="dcss-row-menu-item"
              disabled={disabled}
              onClick={() => {
                setOpen(false)
                onExport()
              }}
            >
              {t('transfer.exportRow')}
            </button>
          ) : null}
          {confirmRemove ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="dcss-row-menu-item dcss-row-menu-danger"
                disabled={disabled}
                onClick={onRemove}
              >
                {busy === row.id ? t('accounts.removing') : t('accounts.removeConfirm')}
              </button>
              <button type="button" role="menuitem" className="dcss-row-menu-item" onClick={onCancelRemove}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="dcss-row-menu-item dcss-row-menu-danger"
              disabled={disabled}
              title={t('accounts.removeHint')}
              onClick={onAskRemove}
            >
              {t('accounts.remove')}
            </button>
          )}
        </span>
      ) : null}
    </span>
  )
}

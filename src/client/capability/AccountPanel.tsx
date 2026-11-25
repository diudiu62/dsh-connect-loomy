/**
 * 唯一的账户面板 —— 按能力声明拼装，而不是按供应商名分支。
 *
 * 布局的四个决定（都是实测后的结论，不是审美偏好）：
 *
 * 1. **每个块都有标题。** 之前 6 个块里只有「当前账号」有标题，其余 5 块靠 14px
 *    空白硬隔开——用户不知道自己在看什么。现在一块一标题，分组由标题表达，
 *    不再需要分隔线。
 * 2. **身份是「一行摘要」，不是一张 4 行的表。** 那 4 行里 2 行与卡片顶部状态条
 *    重复（登录态、身份），剩下的只需一句话（身份 · 来源 · 重新检测）。
 * 3. **顺序按用户真实动作排**：看清我是谁 → 管/切账号 → 加一个 → 定策略 →
 *    看钱 → 搬家。「钱」原本插在「加账号」和「账号列表」之间，把最常看的列表
 *    埋到了 780px 以下。
 * 4. **每账号额度只在一个地方**。账号行自己显示额度，积分区不再重复一份。
 *
 * @module dsh-connect-desktop/client/capability/AccountPanel
 */

import { useCallback, useState } from 'react'
import type { AccountsView, AuthStateView, CreditsView, PoolStateView, VendorStatusView } from '../../shared/views.js'
import { CardButton, Notice, Section } from '../components/common.js'
import { failureMessage, type CardT } from '../components/types.js'
import { formatDateTime, originLabel } from '../format.js'
import { requestVendor } from '../transport.js'
import { AccountRows } from './AccountRows.js'
import { useAccountCredits } from './useAccountCredits.js'
import { CreditsBody } from './CreditsBody.js'
import { LoginForms } from './LoginForms.js'
import { PoolToggle } from './PoolToggle.js'
import { TransferBlock } from './TransferBlock.js'
import { useVendorRoute } from './loadable.js'

export interface AccountPanelProps {
  t: CardT
  vendor: VendorStatusView
  csrf: string | null
  /** Re-read `/status` after a mutation so the tab strip stays truthful. */
  onChanged: () => void
}

export function AccountPanel({ t, vendor, csrf, onChanged }: AccountPanelProps) {
  const capabilities = vendor.capabilities
  const vendorId = vendor.id
  const hasLogin = capabilities.login.some((method) => method !== 'none')
  const hasAccounts = capabilities.accounts !== 'none'
  const hasCredits = capabilities.credits.kind !== 'none'

  const loadAccounts = useCallback(
    (signal: AbortSignal) =>
      hasAccounts
        ? requestVendor<AccountsView>({ vendorId, suffix: 'accounts', signal })
        : Promise.resolve({ kind: 'ok' as const, value: { ok: true as const, accounts: [], rotating: false } }),
    [vendorId, hasAccounts],
  )
  const accounts = useVendorRoute(loadAccounts, hasAccounts)

  const loadAuth = useCallback(
    (signal: AbortSignal) => requestVendor<AuthStateView>({ vendorId, suffix: 'auth/state', signal }),
    [vendorId],
  )
  const authState = useVendorRoute(loadAuth, hasLogin)

  const loadCredits = useCallback(
    (signal: AbortSignal) =>
      hasCredits
        ? /*
           * 只读总额：每行余额改由 `useAccountCredits` 一条一条懒加载。
           * 一次拿全要等所有账号读完（90 个账号 5 秒以上），账号页会先空一片。
           */
          requestVendor<CreditsView>({ vendorId, suffix: 'credits', signal })
        : Promise.resolve({ kind: 'ok' as const, value: { fields: {}, fetchedAt: 0 } }),
    [vendorId, hasCredits],
  )
  const credits = useVendorRoute(loadCredits, hasCredits)

  const loadPool = useCallback(
    (signal: AbortSignal) => requestVendor<PoolStateView>({ vendorId, suffix: 'pool', signal }),
    [vendorId],
  )
  const pool = useVendorRoute(loadPool, capabilities.pool)
  const [savingPool, setSavingPool] = useState(false)
  const [checking, setChecking] = useState(false)
  /**
   * 账号段里当前展开的表单：`add`（登录）或 `transfer`（导出/导入）。
   *
   * 一个时刻只开一个：两个表单同时展开会把列表推到屏幕外，而这正是上一版
   * 「把一个折叠块放在积分后面」要解决的问题。
   */
  const [openPanel, setOpenPanel] = useState<'add' | 'transfer' | null>(null)

  const reloadAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      hasAccounts ? accounts.reload({ silent: true }) : Promise.resolve(null),
      hasCredits ? credits.reload({ silent: true }) : Promise.resolve(null),
      hasLogin ? authState.reload({ silent: true }) : Promise.resolve(null),
      capabilities.pool ? pool.reload({ silent: true }) : Promise.resolve(null),
    ])
    onChanged()
  }, [accounts, credits, authState, pool, capabilities.pool, hasAccounts, hasCredits, hasLogin, onChanged])

  /**
   * 重新检测：让宿主丢弃凭据缓存并重读一次文件。
   *
   * 没有这个按钮，用户在桌面端重新登录后只能等（凭据 TTL）或者重启 DSH。
   */
  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await requestVendor({ vendorId, suffix: 'recheck', method: 'POST', csrf })
      await reloadAll()
    } finally {
      setChecking(false)
    }
  }

  const togglePool = async (enabled: boolean): Promise<void> => {
    setSavingPool(true)
    try {
      await requestVendor<PoolStateView>({ vendorId, suffix: 'pool', method: 'POST', body: { enabled }, csrf })
      await reloadAll()
    } finally {
      setSavingPool(false)
    }
  }

  const credential = vendor.credential
  const account = vendor.account
  const rows = accounts.state.kind === 'ready' ? accounts.state.value.accounts : []
  /*
   * 逐账号额度：账号行先渲染，数字随到随填（`credits/account`，一行一条）。
   * 宿主侧 per-account memo 60 秒，所以反复切页签不会重复打上游。
   */
  const perAccountCredits = useAccountCredits({
    vendorId,
    accountIds: rows.map((row) => row.id),
    enabled: hasCredits,
  })
  const accountsFailure = failureMessage(accounts.state, t)

  /*
   * 信息架构：两段（账号 / 积分），账号段内部再分三块。
   *
   * 「新增账号」「导出/导入」是账号段内的**动作**，所以它们进 Section 的按钮区
   * （标题右侧），和模型页的「刷新目录 / 保存勾选」同一个位置。点按钮在段内展开
   * 对应表单，不额外占一个标题层级。
   *
   * 未登录时自动展开「新增账号」：那时登录是唯一有意义的事，不该让用户先找按钮。
   */
  const needsLogin = hasLogin && !vendor.available
  const hasLoginOrTransfer = hasLogin || capabilities.transfer
  /*
   * 未登录时默认展开「新增账号」：那时登录是唯一有意义的事，不该让用户先按一下。
   * 用户手动切换过之后以用户的选择为准。
   */
  const effectivePanel = openPanel ?? (needsLogin && hasLogin ? 'add' : null)
  const expanded = effectivePanel === 'add' ? renderAddPanel() : effectivePanel === 'transfer' ? renderTransferPanel() : null

  return (
    <>
      {/*
        身份摘要：只回答状态条答不了的两件事——凭据从哪来、什么时候登的。
        "谁在用、是否已登录"已经在卡片顶部说过，这里不重复。
      */}
      <div className="dcss-summary" data-dcss-cap="identity">
        <span className="dcss-summary-meta">
          {t('account.credential')}
          {'：'}
          {credential.found
            ? originLabel(credential.sourceOrigin, t)
            : t('account.credentialMissing', { path: credential.sourcePath || t('common.none') })}
          {account?.loginAt === undefined ? null : ` · ${t('account.signedInAt')} ${formatDateTime(account.loginAt)}`}
        </span>
        <span className="dcss-summary-spacer" />
        <CardButton onClick={() => void recheck()} disabled={checking} data-dcss-cap="recheck">
          {checking ? t('account.redetecting') : t('account.redetect')}
        </CardButton>
      </div>

      {credential.problem === undefined ? null : <Notice tone="error">{credential.problem}</Notice>}
      {vendor.nextSteps === undefined ? null : (
        <Notice tone="info">
          <div>{t('account.nextSteps')}</div>
          <ul className="dcss-list">
            {vendor.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </Notice>
      )}

      {/*
        「账号」是一个完整的领域段：列表、轮换、添加账号、导出/导入 都属于它。
        把"添加账号"放到积分之后，会让它变成一个孤立的低频块——用户看完账号、
        看完钱，再回头才发现"原来还能加一个"。领域内的动作就该留在领域里。
      */}
      {hasAccounts ? (
        <Section
          title={rows.length === 0 ? t('accounts.title') : t('accounts.titleCount', { count: rows.length })}
          cap="accounts"
          actions={
            hasLoginOrTransfer ? (
              <>
                {hasLogin ? (
                  <CardButton
                    data-dcss-cap="login"
                    aria-expanded={openPanel === 'add'}
                    onClick={() => setOpenPanel((current) => (current === 'add' ? null : 'add'))}
                  >
                    {t('accounts.add')}
                  </CardButton>
                ) : null}
                {capabilities.transfer ? (
                  <CardButton
                    data-dcss-cap="transfer"
                    aria-expanded={openPanel === 'transfer'}
                    onClick={() => setOpenPanel((current) => (current === 'transfer' ? null : 'transfer'))}
                  >
                    {t('transfer.title')}
                  </CardButton>
                ) : null}
              </>
            ) : null
          }
        >
          {/*
            按钮按下的表单就地展开，但**贴着段头**——触发它的按钮就在标题右侧，
            所以表单出现在列表之前：点完按钮视线不用穿过整个账号列表去找输入框
            （列表一长，表单排在末尾就会被推到屏幕外，等于"按钮按了没反应"）。
          */}
          {expanded !== null ? <div className="dcss-acct-form">{expanded}</div> : null}
          {accountsFailure === null ? null : <Notice tone="error">{accountsFailure}</Notice>}
          <AccountRows
            t={t}
            vendorId={vendorId}
            csrf={csrf}
            state={accounts.state}
            capabilities={capabilities}
            accountCredits={perAccountCredits.entries}
            onChanged={() => void reloadAll()}
          />
          {/* 轮换是账号的用法，跟列表放一起。 */}
          {capabilities.pool ? (
            <div className="dcss-acct-pool" data-dcss-cap="pool">
              <PoolToggle
                t={t}
                state={pool.state}
                onToggle={(enabled) => void togglePool(enabled)}
                saving={savingPool}
                disabled={rows.length < 2}
              />
            </div>
          ) : null}
        </Section>
      ) : hasLoginOrTransfer ? (
        /*
         * 没有账号概念的供应商（accounts: 'none'）：没有列表可挂，动作只能自成一段。
         * 这时按钮就是这一段的全部内容，默认展开——否则整段是空的。
         */
        <Section title={hasLogin ? t('accounts.add') : t('transfer.title')} cap="actions">
          {renderAddPanel() ?? null}
          {renderTransferPanel() ?? null}
        </Section>
      ) : null}

      {hasCredits ? (
        <Section title={t('credits.title')} cap="credits">
          <CreditsBody
            t={t}
            capability={capabilities.credits}
            state={credits.state}
            onRetry={() => void credits.reload()}
          />
        </Section>
      ) : null}
    </>
  )

  /** 新增账号表单（按钮按下时就地展开）。 */
  function renderAddPanel(): JSX.Element | null {
    if (!hasLogin) return null
    return (
      <div className="dcss-acct-form-block" data-dcss-cap="login-form">
        <LoginForms
          t={t}
          vendorId={vendorId}
          csrf={csrf}
          methods={capabilities.login}
          authState={authState.state}
          onChanged={() => void reloadAll()}
        />
      </div>
    )
  }

  /** 导出/导入表单。 */
  function renderTransferPanel(): JSX.Element | null {
    if (!capabilities.transfer) return null
    return (
      <div className="dcss-acct-form-block">
        <TransferBlock t={t} vendorId={vendorId} csrf={csrf} onChanged={() => void reloadAll()} />
      </div>
    )
  }
}
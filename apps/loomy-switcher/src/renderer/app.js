/**
 * 渲染进程：只画界面 + 转发意图，不做任何文件操作，也看不到 session。
 */

const api = window.api

const el = {
  statusChip: document.getElementById('status-chip'),
  currentChip: document.getElementById('current-chip'),
  targetTabs: document.getElementById('target-tabs'),
  accountCount: document.getElementById('account-count'),
  accountList: document.getElementById('account-list'),
  importText: document.getElementById('import-text'),
  optRestart: document.getElementById('opt-restart'),
  optDsh: document.getElementById('opt-dsh'),
  btnImport: document.getElementById('btn-import'),
  btnFile: document.getElementById('btn-file'),
  btnCapture: document.getElementById('btn-capture'),
  btnExport: document.getElementById('btn-export'),
  btnRefreshAll: document.getElementById('btn-refresh-all'),
  btnInviteRefresh: document.getElementById('btn-invite-refresh'),
  inviteBody: document.getElementById('invite-body'),
  btnBackups: document.getElementById('btn-backups'),
  btnClearLog: document.getElementById('btn-clear-log'),
  log: document.getElementById('log'),
  pathInfo: document.getElementById('path-info'),
  versionInfo: document.getElementById('version-info'),
}

let state
let busy = false

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const toast = (() => {
  const node = document.createElement('div')
  node.className = 'toast'
  document.body.append(node)
  let timer
  return (text, isError = false) => {
    node.textContent = text
    node.classList.toggle('is-error', isError)
    node.classList.add('is-visible')
    clearTimeout(timer)
    timer = setTimeout(() => node.classList.remove('is-visible'), 2600)
  }
})()

/** 积分千分位：12000 → 12,000（数字一眼看清量级很重要）。 */
function formatPoints(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN')
}

function formatTime(value) {
  if (typeof value !== 'number' || value <= 0) return '—'
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把距离过期的剩余时间说成人话。
 *
 * 开关在这里：`>48h` 绿、`<48h` 黄、已过期红。缓存账号最危险的时刻不是
 * 它失效的时候，而是"还有几小时就失效但看起来一切正常"的时候。
 */
function expiryBadge(expiresInMs) {
  const days = Math.floor(expiresInMs / 86_400_000)
  const hours = Math.floor((expiresInMs % 86_400_000) / 3_600_000)
  if (expiresInMs <= 0) return { text: '已过期', level: 'expired' }
  // 不足 1 分钟的边界：别显示 "0 小时后过期"
  if (expiresInMs < 3_600_000) return { text: `${Math.max(1, Math.ceil(expiresInMs / 60_000))} 分钟后过期`, level: 'warn' }
  if (expiresInMs < 3_600_000 * 2) return { text: `${hours || 1} 小时后过期`, level: 'warn' }
  // days 为 0 时只说小时，否则会写成 "0 天 23 小时后过期"
  if (days === 0) return { text: `${hours} 小时后过期`, level: 'warn' }
  if (days < 2) return { text: `${days} 天 ${hours} 小时后过期`, level: 'warn' }
  return { text: `还有 ${days} 天`, level: 'ok' }
}

function appendLog(text, level = 'info') {
  const line = document.createElement('li')
  line.className = `log-line log-${level}`
  const time = document.createElement('span')
  time.className = 'log-time'
  const now = new Date()
  time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  const body = document.createElement('span')
  body.textContent = text
  line.append(time, body)
  el.log.append(line)
  while (el.log.children.length > 200) el.log.firstElementChild.remove()
  el.log.scrollTop = el.log.scrollHeight
}

function setBusy(value) {
  busy = value
  document.body.classList.toggle('busy', value)
  for (const button of [el.btnImport, el.btnFile, el.btnCapture, el.btnExport, el.btnBackups, el.btnRefreshAll]) {
    button.disabled = value
  }
  // 邀请码按钮的可用性由**平台能力**决定，不只是 busy：
  // 上一版在 setBusy(false) 里无条件把它启用，把小浣熊的禁用状态冲掉了。
  el.btnInviteRefresh.disabled = value || state?.targetMeta?.supportsInvite === false
  for (const button of el.accountList.querySelectorAll('button')) button.disabled = value
}

/* ------------------------------------------------------------------ *
 * 绘制
 * ------------------------------------------------------------------ */

/** 平台切换 tab：带上各平台已缓存的账号数，不用切过去也能知道另一侧存了多少。 */
function renderTargets() {
  const targets = state?.targets ?? []
  el.targetTabs.replaceChildren()
  for (const target of targets) {
    const tab = document.createElement('button')
    tab.className = target.id === state.target ? 'target-tab is-active' : 'target-tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(target.id === state.target))
    tab.title = `${target.appName} · session 有效期约 ${target.sessionLifeDays} 天`
    const label = document.createElement('span')
    label.textContent = target.label
    tab.append(label)
    if (target.accounts > 0) {
      const count = document.createElement('span')
      count.className = 'target-tab-count'
      count.textContent = String(target.accounts)
      tab.append(count)
    }
    tab.addEventListener('click', () => switchTarget(target.id))
    el.targetTabs.append(tab)
  }
}

/** 切换平台：主进程持有当前平台，这里只发意图再整体重绘。 */
async function switchTarget(id) {
  if (busy || id === state?.target) return
  setBusy(true)
  try {
    const result = await api.setTarget({ id })
    if (result.ok) {
      render(result.state)
      appendLog(`已切到 ${state.targetMeta?.label ?? id}`)
    } else {
      toast(result.error, true)
    }
  } finally {
    setBusy(false)
  }
}

function renderStatus() {
  const chip = el.statusChip
  const label = state?.targetMeta?.label ?? '客户端'
  chip.className = 'chip'
  if (!state?.installed) {
    chip.classList.add('is-warn')
    chip.textContent = `未找到 ${label}`
  } else if (state.running) {
    chip.classList.add('is-on')
    chip.textContent = `${label} 运行中`
  } else {
    chip.classList.add('is-off')
    chip.textContent = `${label} 未运行`
  }

  el.currentChip.textContent = state?.current
    ? `客户端账号 ${state.current.phone}`
    : '客户端未登录'

  const parts = []
  if (state?.userData) parts.push(state.userData)
  if (state?.logPath) parts.push(`leveldb ${state.logPath.split('/').at(-1)}`)
  if (state?.dshEnabled) parts.push('DSH 插件已安装')
  if (state?.vaultPath) parts.push(`账号库 ${state.vaultPath.replace(/^.*\//u, '')}`)
  el.pathInfo.textContent = parts.length > 0 ? parts.join(' · ') : '未检测到 Loomy 客户端数据目录'
  el.versionInfo.textContent = state?.version ? `v${state.version}` : ''
}

function renderAccounts() {
  const all = state?.accounts ?? { accounts: [], activeId: undefined }
  // **必须按平台过滤**：账号库里 Loomy 与小浣熊的记录并存，不过滤的话
  // 切到小浣熊 tab 会看到 Loomy 的账号和它的积分，点切换就是改错客户端。
  const list = {
    ...all,
    accounts: all.accounts.filter((account) => account.target === state?.target),
  }
  el.accountCount.textContent = String(list.accounts.length)
  el.accountList.replaceChildren()

  if (list.accounts.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    const label = state?.targetMeta?.label ?? '客户端'
    empty.textContent = `${label} 的账号库还是空的。右边粘贴 JSON 导入，或点「捕获当前」把客户端正在用的账号存进来。导入后会一直留着，以后直接点「切换到此账号」。`
    el.accountList.append(empty)
    return
  }

  for (const account of list.accounts) {
    const card = document.createElement('div')
    card.className = 'account'
    if (account.id === list.activeId) card.classList.add('is-active')

    const top = document.createElement('div')
    top.className = 'account-top'

    const name = document.createElement('span')
    name.className = 'account-name'
    // 小浣熊的凭证里 phone 可能为空（JWT 只有 sub），所以退到昵称、再退到 userid
    name.textContent = account.phone || account.name || account.userid || '未知账号'
    top.append(name)

    if (account.label) {
      const label = document.createElement('span')
      label.className = 'account-label'
      label.textContent = account.label
      top.append(label)
    }

    const badge = document.createElement('span')
    badge.className = 'badge-active'
    badge.textContent = '当前'
    top.append(badge)

    // 过期徽标：贴在卡片右上角，一眼能看出哪条该换了
    if (typeof account.expiresInMs === 'number') {
      const badgeInfo = expiryBadge(account.expiresInMs)
      const expiry = document.createElement('span')
      expiry.className = `expiry expiry-${badgeInfo.level}`
      expiry.textContent = badgeInfo.text
      expiry.title = `session 签发于 ${formatTime(account.credentialedAt)}，上游签发有效期 14 天`
      top.append(expiry)
    }

    // 积分：可用额度是主数字（用户真正能花的），下面一行是平台特定的构成。
    // 读失败时不能显示 0 —— 那看起来像"没钱了"，实际是查不到。
    const cached = account.credits
    let creditsBox
    if (cached !== undefined) {
      const box = document.createElement('div')
      if (typeof cached.error === 'string' && cached.error.length > 0) {
        box.className = 'credits credits-error'
        const label = document.createElement('span')
        label.className = 'credits-label'
        label.textContent = '积分读取失败'
        const detail = document.createElement('span')
        detail.className = 'credits-detail'
        detail.textContent = cached.error
        box.append(label, detail)
      } else {
        box.className = 'credits'
        const main = document.createElement('span')
        main.className = 'credits-main'
        main.textContent = formatPoints(cached.available)
        const unit = document.createElement('span')
        unit.className = 'credits-unit'
        unit.textContent = '可用'
        box.append(main, unit)
        if (typeof cached.secondary === 'string' && cached.secondary.length > 0) {
          const split = document.createElement('span')
          split.className = 'credits-split'
          split.textContent = cached.secondary
          box.append(split)
        }
        const when = document.createElement('span')
        when.className = 'credits-when'
        when.textContent = formatTime(cached.at)
        box.append(when)
      }
      creditsBox = box
    }

    const meta = document.createElement('div')
    meta.className = 'account-meta'
    const pieces = [account.userid || 'userid —']
    if (account.lastUsedAt) pieces.push(`用过 ${formatTime(account.lastUsedAt)}`)
    else pieces.push(`加入 ${formatTime(account.addedAt)}`)
    for (const text of pieces) {
      const span = document.createElement('span')
      span.textContent = text
      meta.append(span)
    }

    // 上次切换失败的原因钉在卡片上，否则用户只会看到客户端停在登录页。
    // 必须挂在卡片上而不是 meta 里：meta 是 flex 行，塞进去会把 userid /
    // 时间挤成多行（实测 "2611…… 加入 10/29 7535 13:51" 那种乱码观感）。
    let errorNode
    if (account.lastError) {
      errorNode = document.createElement('div')
      errorNode.className = 'account-error'
      errorNode.textContent = `上次切换失败：${account.lastError}`
    }

    const actions = document.createElement('div')
    actions.className = 'account-actions'

    const expired = typeof account.expiresInMs === 'number' && account.expiresInMs <= 0
    const switchButton = document.createElement('button')
    switchButton.className = expired ? 'btn btn-switch btn-stale' : 'btn btn-primary btn-switch'
    switchButton.textContent = expired ? '已过期 · 仍要切换' : '切换到此账号'
    switchButton.title = expired
      ? '这张 session 已超过 14 天，切过去客户端可能直接回登录页'
      : '退出 Loomy、备份、写入、重启并校验'
    switchButton.addEventListener('click', () => switchTo(account))

    const renameButton = document.createElement('button')
    renameButton.className = 'btn'
    renameButton.textContent = '备注'
    renameButton.addEventListener('click', () => rename(account))

    const removeButton = document.createElement('button')
    removeButton.className = 'btn btn-danger'
    removeButton.textContent = '删除'
    removeButton.addEventListener('click', () => remove(account))

    actions.append(switchButton, renameButton, removeButton)
    // 顺序：号码行 → 积分 → userid/时间 → 失败原因 → 按钮。
    // 积分必须排在号码之后，否则卡片第一眼是数字，看不出这是谁。
    card.append(top)
    if (creditsBox !== undefined) card.append(creditsBox)
    card.append(meta)
    if (errorNode !== undefined) card.append(errorNode)
    card.append(actions)
    el.accountList.append(card)
  }
}

function render(next) {
  state = next
  renderTargets()
  renderStatus()
  renderAccounts()
  renderInvite()
}

async function refresh() {
  const result = await api.state()
  if (!result.ok) {
    toast(result.error, true)
    appendLog(result.error, 'error')
    return
  }
  render(result.state)
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function switchTo(account) {
  if (busy) return
  setBusy(true)
  const who = account.phone || account.name || account.userid
  appendLog(`开始切换到 ${who}${account.label ? `（${account.label}）` : ''}…`)
  try {
    const result = await api.switch({
      id: account.id,
      restart: el.optRestart.checked,
      syncDsh: el.optDsh.checked,
    })
    if (result.state) render(result.state)
    if (result.ok) {
      toast(`已切换到 ${who}`)
    } else {
      toast(result.error ?? '切换未完成，详情见操作记录', true)
      if (result.error) appendLog(result.error, 'error')
    }
  } finally {
    setBusy(false)
  }
}

async function importFromText() {
  const text = el.importText.value.trim()
  if (text.length === 0) {
    toast('先粘贴 JSON', true)
    return
  }
  if (busy) return
  setBusy(true)
  try {
    const result = await api.import(text)
    if (result.state) render(result.state)
    if (result.ok) {
      el.importText.value = ''
      appendLog(`导入完成：新增 ${result.added}，更新 ${result.updated}`, 'ok')
      toast(`导入成功（新增 ${result.added}）`)
    } else {
      appendLog(`导入失败：${result.error}`, 'error')
      toast(result.error, true)
    }
  } finally {
    setBusy(false)
  }
}

async function importFromFile() {
  if (busy) return
  setBusy(true)
  try {
    const result = await api.importFile()
    if (result.canceled) return
    if (result.state) render(result.state)
    if (result.ok) {
      appendLog(`从文件导入：新增 ${result.added}，更新 ${result.updated}`, 'ok')
      toast(`导入成功（新增 ${result.added}）`)
    } else {
      appendLog(`导入失败：${result.error}`, 'error')
      toast(result.error, true)
    }
  } finally {
    setBusy(false)
  }
}

async function capture() {
  if (busy) return
  setBusy(true)
  try {
    const result = await api.capture()
    if (result.state) render(result.state)
    if (result.ok) {
      appendLog(`已捕获当前账号（新增 ${result.added}，更新 ${result.updated}）`, 'ok')
      toast('已存进账号库')
    } else {
      toast(result.error, true)
      appendLog(result.error, 'error')
    }
  } finally {
    setBusy(false)
  }
}

async function rename(account) {
  const label = window.prompt('给这个账号一个备注（留空清除）', account.label ?? '')
  if (label === null) return
  const result = await api.rename({ id: account.id, label })
  if (result.ok) {
    render(result.state)
    toast('已保存备注')
  } else {
    toast(result.error, true)
  }
}

async function remove(account) {
  const ok = window.confirm(`从账号库删除 ${account.phone || account.name || account.userid}？\n（只删这里的副本，不影响客户端当前登录）`)
  if (!ok) return
  const result = await api.remove({ id: account.id })
  if (result.ok) {
    render(result.state)
    toast(`已删除 ${result.removed} 个账号`)
  } else {
    toast(result.error, true)
  }
}

/** 邀请码面板。 */
function renderInvite() {
  const invite = state?.invite
  el.inviteBody.replaceChildren()

  // 小浣熊没有个人邀请码接口（只有团队/项目邀请），如实说明比留个点不动的按钮好
  if (state?.targetMeta?.supportsInvite === false) {
    const na = document.createElement('p')
    na.className = 'empty invite-empty'
    na.textContent = `${state.targetMeta.label} 没有个人邀请码接口（只有团队/项目邀请），这一栏不适用。`
    el.inviteBody.append(na)
    el.btnInviteRefresh.disabled = true
    return
  }
  el.btnInviteRefresh.disabled = false

  // 邀请码是按平台缓存的，切平台时显示的是上一个平台的数据就不对了
  if (invite !== undefined && state?.target !== undefined && invite.target !== undefined && invite.target !== state.target) {
    const stale = document.createElement('p')
    stale.className = 'empty invite-empty'
    stale.textContent = `点「查询」查看 ${state.targetMeta?.label ?? ''} 当前账号的邀请码。`
    el.inviteBody.append(stale)
    return
  }

  if (invite === undefined) {
    const empty = document.createElement('p')
    empty.className = 'empty invite-empty'
    empty.textContent = '点「查询」查看当前账号名下的邀请码，以及是否已被别人邀请。'
    el.inviteBody.append(empty)
    return
  }

  // 我名下的邀请码
  const codes = Array.isArray(invite.codes) ? invite.codes : []
  if (codes.length === 0) {
    const none = document.createElement('p')
    none.className = 'empty invite-empty'
    none.textContent = '这个账号名下没有邀请码。'
    el.inviteBody.append(none)
  } else {
    const list = document.createElement('div')
    list.className = 'invite-codes'
    for (const entry of codes) {
      const row = document.createElement('div')
      row.className = 'invite-code'

      const code = document.createElement('code')
      code.className = 'invite-code-text'
      code.textContent = entry.inviteCode

      const usage = document.createElement('span')
      usage.className = 'invite-usage'
      const remaining = typeof entry.remaining === 'number' ? entry.remaining : undefined
      usage.textContent =
        entry.maxUses > 0 ? `已用 ${entry.usedCount}/${entry.maxUses}${remaining === 0 ? ' · 已用完' : ''}` : `已用 ${entry.usedCount}`
      if (entry.status !== 'active') usage.classList.add('is-inactive')

      const copy = document.createElement('button')
      copy.className = 'btn'
      copy.textContent = '复制'
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(entry.inviteCode)
          toast(`已复制 ${entry.inviteCode}`)
        } catch {
          toast('复制失败', true)
        }
      })

      row.append(code, usage, copy)
      list.append(row)
    }
    el.inviteBody.append(list)
  }

  // 我绑定过谁的码
  if (invite.activation !== undefined) {
    const line = document.createElement('div')
    line.className = invite.activation.activated ? 'invite-bound' : 'invite-unbound'
    line.textContent = invite.activation.activated
      ? `已绑定邀请码 ${invite.activation.appliedInvitationCode || '（未知）'}`
      : '尚未绑定任何人的邀请码'
    el.inviteBody.append(line)
  }

  // 单个接口失败时如实说明，别假装全绿
  for (const text of [invite.codesError, invite.activationError]) {
    if (typeof text !== 'string' || text.length === 0) continue
    const warn = document.createElement('div')
    warn.className = 'invite-warn'
    warn.textContent = text
    el.inviteBody.append(warn)
  }

  const foot = document.createElement('div')
  foot.className = 'invite-foot'
  const stamp = document.createElement('span')
  stamp.className = 'invite-stamp'
  stamp.textContent = invite.who ? `${invite.who} · ${formatTime(invite.fetchedAt)}` : formatTime(invite.fetchedAt)
  foot.append(stamp)

  if (invite.activation !== undefined && invite.activation.activated !== true) {
    const redeem = document.createElement('button')
    redeem.className = 'btn'
    redeem.textContent = '绑定邀请码…'
    redeem.addEventListener('click', redeemInviteCode)
    foot.append(redeem)
  }
  el.inviteBody.append(foot)
}

/** 绑定别人的邀请码（写操作，先问）。 */
async function redeemInviteCode() {
  const code = window.prompt('输入要绑定的邀请码（一个账号通常只能绑一次，请核对）', '')
  if (code === null) return
  const trimmed = code.trim()
  if (trimmed.length === 0) {
    toast('邀请码不能为空', true)
    return
  }
  const ok = window.confirm(`确认把这个账号绑定到邀请码 ${trimmed}？\n绑错了一般不能改。`)
  if (!ok) return
  setBusy(true)
  try {
    const result = await api.redeemInvite({ inviteCode: trimmed })
    if (result.state) render(result.state)
    if (result.ok) {
      toast(`已绑定 ${result.appliedInvitationCode}`)
      appendLog(`邀请码 ${result.appliedInvitationCode} 绑定成功`, 'ok')
      await refreshInvite()
    } else {
      toast(result.error, true)
      appendLog(`绑定失败：${result.error}`, 'error')
    }
  } finally {
    setBusy(false)
  }
}

/** 批量刷新账号库里所有账号的积分。 */
async function refreshAllCredits() {
  if (busy) return
  setBusy(true)
  appendLog('开始批量刷新积分…')
  try {
    const result = await api.refreshCredits()
    if (result.state) render(result.state)
    if (result.ok) {
      const s = result.summary
      toast(`刷新完成：${s.ok} 成功 / ${s.failed} 失败`)
      appendLog(`批量刷新完成：${s.ok} 成功，${s.failed} 失败`, s.failed === 0 ? 'ok' : 'error')
    } else {
      toast(result.error, true)
      appendLog(result.error, 'error')
    }
  } finally {
    setBusy(false)
  }
}

/** 查询当前账号的邀请码。 */
async function refreshInvite() {
  if (busy) return
  setBusy(true)
  try {
    const result = await api.refreshInvite({})
    if (result.state) render(result.state)
    if (result.ok) {
      const count = result.invite?.codes?.length ?? 0
      appendLog(`邀请码查询完成：${count} 个`, 'ok')
    } else {
      toast(result.error, true)
      appendLog(`邀请码查询失败：${result.error}`, 'error')
    }
  } finally {
    setBusy(false)
  }
}

async function exportBundle() {
  const result = await api.export()
  if (result.canceled) return
  if (result.ok) {
    appendLog(`已导出 ${result.count} 个账号 → ${result.path}（内含明文 session，注意保管）`, 'ok')
    toast('已导出')
  } else {
    toast(result.error ?? '导出失败', true)
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

el.btnImport.addEventListener('click', importFromText)
el.btnFile.addEventListener('click', importFromFile)
el.btnCapture.addEventListener('click', capture)
el.btnExport.addEventListener('click', exportBundle)
el.btnRefreshAll.addEventListener('click', refreshAllCredits)
el.btnInviteRefresh.addEventListener('click', refreshInvite)
el.btnBackups.addEventListener('click', () => api.revealBackups())
el.btnClearLog.addEventListener('click', () => {
  el.log.replaceChildren()
  appendLog('已清空')
})

el.importText.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') importFromText()
})

api.onProgress((payload) => {
  appendLog(payload.text, payload.level === 'error' ? 'error' : 'ok')
})

refresh().then(() => appendLog('已连上主进程'))

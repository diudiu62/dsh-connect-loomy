/**
 * Electron 主进程：只做三件事——发现客户端状态、改登录态、把结果告诉界面。
 *
 * 所有文件操作都在主进程，渲染进程拿不到 session（`vault.publicView` 只给
 * 掩码），也不开 nodeIntegration。
 *
 * @module loomy-switcher/main
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseImport as parseLoomyImport, displayPhone } from './loomy-store.js'
import { redeemInvite as loomyRedeemInvite } from './platform-api.js'
import { DEFAULT_TARGET, TARGETS, isKnown, target as targetOf } from './targets/index.js'
import { buildSession as buildRaccoonSession, parseAuthDocument as parseRaccoonImport } from './targets/raccoon.js'
import { openVault } from './vault.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const HOME = homedir()

/** DSH 插件的登录态文件（可选同步目标）。 */
const DSH_AUTH_PATH = join(HOME, '.dsh', 'storages', 'dsh-connect-loomy', 'auth-session.json')

let vault
let window

function emit(channel, payload) {
  if (window !== undefined && !window.isDestroyed()) window.webContents.send(channel, payload)
}

/** 每一步都回传界面，用户能看见"为什么慢"。 */
const progress = (text, level = 'info') => emit('progress', { text, level })

/**
 * 当前界面选中的平台。
 *
 * 放主进程而不是渲染进程：切换平台后立刻要拿到那一侧的快照，渲染进程
 * 存一份会和服务端状态不同步（两个窗口/重载后尤其明显）。
 */
let activeTarget = DEFAULT_TARGET

async function buildState() {
  const impl = targetOf(activeTarget)
  const snapshot = await impl.inspect(HOME)
  const meta = TARGETS.find((entry) => entry.id === activeTarget)
  return {
    ...snapshot,
    target: activeTarget,
    targets: TARGETS.map((entry) => ({
      ...entry,
      accounts: vault.list().accounts.filter((a) => a.target === entry.id).length,
    })),
    targetMeta: meta,
    // DSH 同步只对 Loomy 有意义（它读的就是 Loomy 的登录态格式）
    dshEnabled: activeTarget === 'loomy' && (await exists(DSH_AUTH_PATH)),
    accounts: vault.list(),
    vaultPath: VAULT_PATH,
    version: app.getVersion(),
    creditsSummary: vault.creditsSummary(),
    invite: vault.invite(),
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0f14',
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.loadFile(join(HERE, '..', 'renderer', 'index.html'))
  window.on('closed', () => {
    window = undefined
  })

  // 截图模式：`LOOMY_SWITCHER_CAPTURE=/tmp/ui.png` 启动时，等界面稳定后
  // 用 capturePage 出图再退出。文档与 README 里的界面图就是这么来的，
  // 免去手工截图，也能在无人值守时验证"界面真的渲染了"。
  const capturePath = process.env['LOOMY_SWITCHER_CAPTURE']
  if (typeof capturePath === 'string' && capturePath.length > 0) {
    window.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 2200))
      try {
        const image = await window.webContents.capturePage()
        await writeFile(capturePath, image.toPNG())
        process.stdout.write(`captured ${capturePath}\n`)
      } catch (error) {
        process.stdout.write(`capture failed: ${message(error)}\n`)
      }
      app.quit()
    })
  }
}

/**
 * 账号库的落点。
 *
 * 不用 `app.getPath('userData')`：那是 `~/Library/Application Support/Loomy
 * 账号切换器/`，Electron 会往里扔 Cache / GPUCache / Local Storage 一堆目录，
 * 用户想手工翻 `accounts.json` 根本找不到，备份时也容易连缓存一起拷。
 * 单独放一个干净目录，只存这一份文件。
 */
/**
 * 账号库落点。
 *
 * `ACCOUNT_SWITCHER_VAULT` 可以整体覆盖（测试与多份配置时用）：没有它，
 * 自动化测试就只能改真实账号库，跑一次测试污染一次用户数据。
 */
const VAULT_OVERRIDE = process.env['ACCOUNT_SWITCHER_VAULT']?.trim()
const VAULT_PATH = VAULT_OVERRIDE && VAULT_OVERRIDE.length > 0
  ? VAULT_OVERRIDE
  : join(HOME, '.account-switcher', 'accounts.json')
const VAULT_DIR = dirname(VAULT_PATH)

app.whenReady().then(async () => {
  await mkdir(VAULT_DIR, { recursive: true, mode: 0o700 })
  vault = await openVault(VAULT_PATH)
  // 只在用默认路径时迁移：显式指定了 ACCOUNT_SWITCHER_VAULT（测试、多份配置）
  // 却把真实库搬进去，会让一个空库突然出现别人的账号——实测踩过。
  if (VAULT_OVERRIDE === undefined || VAULT_OVERRIDE.length === 0) {
    // 两处历史位置各搬一次：`~/.loomy-account-switcher/`（改名前的家）与
    // Electron 的 userData（更早的实现把数据混在 Chromium 缓存里）
    await migrateLegacyDirs()
    await migrateLegacyVault()
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

/* ------------------------------------------------------------------ *
 * 导入解析（按平台）
 * ------------------------------------------------------------------ */

/**
 * 把用户粘贴的 JSON 展开成账号。
 *
 * Loomy 有自己的解析器（认 `{session,userid,phone}` / 数组 / 插件导出包）；
 * 小浣熊的解析在 target 里（`parseAuthDocument`），因为它要同时认下划线与
 * 驼峰两套字段名——插件导出的是 `accessToken`，桌面端 `auth.json` 是
 * `access_token`，少认一个就会在导入时报"没有可用的登录态"。
 */
function parseImport(text) {
  if (activeTarget === 'raccoon') {
    return parseRaccoonImport(text).map((session) => ({ target: 'raccoon', ...session }))
  }
  return parseLoomyImport(text).map((session) => ({ ...session, target: 'loomy' }))
}

/** 把平台当前登录态转成账号行。 */
function normalizeCaptured(id, current) {
  if (id === 'raccoon') {
    // identity 要带过来：企业号写回 auth.json 时若丢了它，客户端会按
    // personal 打开，跟当前登录态不是同一个工作区
    return {
      target: 'raccoon',
      ...buildRaccoonSession(current.session, {
        phone: current.phone,
        userid: current.userid,
        name: current.name,
        identity: current.identity,
        orgName: current.orgName,
        orgRole: current.orgRole,
      }),
    }
  }
  return {
    target: 'loomy',
    session: current.session,
    phone: current.phone,
    userid: current.userid,
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

ipcMain.handle('state', async () => {
  try {
    return { ok: true, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('import', async (_event, text) => {
  try {
    const sessions = parseImport(String(text ?? ''))
    const result = await vault.upsert(sessions, { target: activeTarget })
    return { ok: true, ...result, sessions: sessions.length, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('importFile', async () => {
  const picked = await dialog.showOpenDialog({
    title: '选择登录态 JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json', 'txt'] }],
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
  try {
    const text = await readFile(picked.filePaths[0], 'utf8')
    const sessions = parseImport(text)
    const result = await vault.upsert(sessions, { target: activeTarget })
    return { ok: true, ...result, sessions: sessions.length, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('capture', async () => {
  try {
    const impl = targetOf(activeTarget)
    const snapshot = await impl.inspect(HOME)
    if (snapshot.current === undefined) {
      return { ok: false, error: `客户端当前没有登录态，先在 ${impl.LABEL} 里登录一次` }
    }
    const session = normalizeCaptured(activeTarget, snapshot.current)
    const result = await vault.upsert([session], { target: activeTarget })
    return { ok: true, ...result, sessions: 1, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('switch', async (_event, payload) => {
  const options = payload ?? {}
  try {
    const row = vault.get(String(options.id ?? ''))
    if (row === undefined) return { ok: false, error: '账号不存在，请刷新' }
    // 切到另一个平台的账号时，先把"当前平台"切过去——否则界面会显示
    // 小浣熊的快照却标记了 Loomy 的账号
    if (row.target !== activeTarget) activeTarget = row.target

    const impl = targetOf(row.target)
    const session = {
      session: row.session,
      userid: row.userid,
      phone: row.phone,
      name: row.name ?? '',
      // 小浣熊写回 auth.json 时要带上 office_identity，否则企业号会被
      // 当成个人号打开（writeSession 的兜底是 'personal'）
      ...(row.identity === undefined ? {} : { identity: row.identity }),
      ...(row.orgName === undefined ? {} : { orgName: row.orgName }),
      ...(row.orgRole === undefined ? {} : { orgRole: row.orgRole }),
    }
    progress(`准备切换 ${impl.LABEL} 到 ${row.phone || row.userid || row.id}…`)
    const result = await impl.applySession(session, {
      home: HOME,
      restart: options.restart !== false,
      ...(options.syncDsh === true && row.target === 'loomy' ? { dshAuthPath: DSH_AUTH_PATH } : {}),
    })
    for (const step of result.steps) progress(step.text, step.ok ? 'info' : 'error')
    if (result.ok) {
      await vault.markActive(row.id)
    } else {
      const reason = result.verify?.reason ?? '切换未通过校验'
      await vault.markFailure(row.id, reason)
    }
    return {
      ok: result.ok,
      steps: result.steps,
      backupPath: result.backupPath,
      state: await buildState(),
    }
  } catch (error) {
    progress(message(error), 'error')
    return { ok: false, error: message(error), state: await buildState() }
  }
})

ipcMain.handle('signOut', async (_event, payload) => {
  try {
    const impl = targetOf(activeTarget)
    const result = await impl.signOut({ home: HOME, restart: (payload ?? {}).restart !== false })
    progress(`已退出登录，备份：${result.backupPath}`)
    return { ok: true, ...result, state: await buildState() }
  } catch (error) {
    progress(message(error), 'error')
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('rename', async (_event, payload) => {
  try {
    const view = await vault.rename(String(payload?.id ?? ''), payload?.label)
    return { ok: true, account: view, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('remove', async (_event, payload) => {
  try {
    const result = await vault.remove(String(payload?.id ?? ''))
    return { ok: true, ...result, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('export', async () => {
  const bundle = vault.exportBundle()
  const picked = await dialog.showSaveDialog({
    title: '导出账号包',
    defaultPath: `loomy-accounts-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (picked.canceled || picked.filePath === undefined) return { ok: false, canceled: true }
  await writeFile(picked.filePath, `${JSON.stringify(bundle, undefined, 2)}\n`, { mode: 0o600 })
  return { ok: true, path: picked.filePath, count: bundle.accounts.length }
})

/**
 * 批量刷新当前平台所有账号的积分。
 *
 * 用账号库里缓存的 session 直接打上游，不需要切账号、不需要重启客户端——
 * 这正是"能缓存的账号"最有用的地方：想知道哪个号还有积分，一次刷新看完。
 *
 * 只刷**当前平台**的账号：Loomy 的 token 打小浣熊的接口只会 401，混在一起
 * 刷会得到一堆假失败，把真正的失败淹没掉。
 */
ipcMain.handle('refreshCredits', async () => {
  try {
    const impl = targetOf(activeTarget)
    const rows = vault.secretList(activeTarget)
    if (rows.length === 0) {
      return { ok: false, error: `${impl.LABEL} 账号库是空的，先导入账号` }
    }

    progress(`开始刷新 ${impl.LABEL} 的 ${rows.length} 个账号积分…`)
    let done = 0
    let okCount = 0
    let failCount = 0
    const at = Date.now()

    // 并发 4：账号库动辄十几条，一次全打出去会触发限流，也会让界面反复重绘
    const queue = rows.slice()
    const worker = async () => {
      for (;;) {
        const row = queue.shift()
        if (row === undefined) return
        let result
        try {
          result = await impl.fetchPoints({ session: row.session })
        } catch (error) {
          result = { kind: 'failure', message: message(error) }
        }
        done += 1
        const who = row.phone || row.userid || row.id
        if (result.kind === 'ok') {
          okCount += 1
          await vault.setCredits(row.id, {
            available: result.points.available,
            secondary: result.points.secondary,
            at,
          })
          progress(`${done}/${rows.length} ${who}：可用 ${result.points.available}`)
        } else {
          failCount += 1
          await vault.setCredits(row.id, { error: result.message, at })
          progress(`${done}/${rows.length} ${who}：${result.message}`, 'error')
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])

    progress(
      failCount === 0
        ? `刷新完成：${okCount} 个账号全部成功`
        : `刷新完成：${okCount} 个成功，${failCount} 个失败`,
      failCount === 0 ? 'info' : 'error',
    )
    return { ok: true, summary: { total: rows.length, ok: okCount, failed: failCount }, at, state: await buildState() }
  } catch (error) {
    progress(message(error), 'error')
    return { ok: false, error: message(error), state: await buildState() }
  }
})

ipcMain.handle('refreshOne', async (_event, payload) => {
  try {
    const row = vault.get(String(payload?.id ?? ''))
    if (row === undefined) return { ok: false, error: '账号不存在' }
    const impl = targetOf(row.target)
    const result = await impl.fetchPoints({ session: row.session })
    if (result.kind === 'failure') {
      await vault.setCredits(row.id, { error: result.message, at: Date.now() })
      return { ok: false, error: result.message, state: await buildState() }
    }
    await vault.setCredits(row.id, {
      available: result.points.available,
      secondary: result.points.secondary,
      records: result.points.records?.slice(0, 5),
      at: Date.now(),
    })
    return { ok: true, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('refreshInvite', async (_event, payload) => {
  try {
    const impl = targetOf(activeTarget)
    if (impl.SUPPORTS_INVITE !== true) {
      return {
        ok: false,
        error: `${impl.LABEL} 没有个人邀请码接口（只有团队/项目邀请），这一栏不适用`,
        state: await buildState(),
      }
    }
    // 默认查账号库里 active 的账号；指定 id 则查那一条
    const id =
      typeof payload?.id === 'string' && payload.id.length > 0
        ? payload.id
        : vault.activeSecret(activeTarget)?.id
    const row = id === undefined ? undefined : vault.get(id)
    if (row === undefined) return { ok: false, error: '没有可用账号：先导入或切换一个账号' }
    const result = await impl.fetchInviteInfo({ session: row.session })
    if (result.kind === 'failure') {
      return { ok: false, error: result.message, state: await buildState() }
    }
    await vault.setInvite({
      accountId: row.id,
      target: row.target,
      who: row.phone || row.name || row.userid,
      ...result.invite,
    })
    return {
      ok: true,
      invite: result.invite,
      ...(result.codesError === undefined ? {} : { codesError: result.codesError }),
      ...(result.activationError === undefined ? {} : { activationError: result.activationError }),
      state: await buildState(),
    }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('redeemInvite', async (_event, payload) => {
  try {
    const code = String(payload?.inviteCode ?? '').trim()
    const id =
      typeof payload?.id === 'string' && payload.id.length > 0
        ? payload.id
        : vault.activeSecret(activeTarget)?.id
    const row = id === undefined ? undefined : vault.get(id)
    if (row === undefined) return { ok: false, error: '没有可用账号' }
    const impl = targetOf(row.target)
    if (impl.SUPPORTS_INVITE !== true) {
      return { ok: false, error: `${impl.LABEL} 没有个人邀请码接口` }
    }
    const result = await loomyRedeemInvite({ session: row.session, inviteCode: code })
    if (result.kind === 'failure') return { ok: false, error: result.message }
    progress(`邀请码 ${result.appliedInvitationCode} 已绑定`)
    return { ok: true, ...result, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('revealBackups', async () => {
  await shell.openPath(join(HOME, '.account-switcher', 'backups'))
  return { ok: true }
})

ipcMain.handle('launchClient', async () => {
  try {
    await targetOf(activeTarget).launch()
    return { ok: true, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

ipcMain.handle('quitClient', async () => {
  try {
    await targetOf(activeTarget).quit()
    return { ok: true, state: await buildState() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
})

/** 切换平台：返回新平台的快照，界面据此整体重绘。 */
ipcMain.handle('setTarget', async (_event, payload) => {
  const id = String(payload?.id ?? '')
  if (!isKnown(id)) return { ok: false, error: `未知的平台：${id}` }
  activeTarget = id
  return { ok: true, state: await buildState() }
})

/**
 * 迁移：早期版本把账号库放在 `~/.loomy-account-switcher/`（那时只有 Loomy），
 * 后来改成中性的 `~/.account-switcher/`。这里搬一次，避免用户升级后账号库"消失"。
 */
async function migrateLegacyDirs() {
  const legacyDir = join(HOME, '.loomy-account-switcher')
  const legacyVault = join(legacyDir, 'accounts.json')
  if (await exists(legacyVault)) {
    if (await exists(VAULT_PATH)) {
      appendLogToTerminal(`保留现有账号库，忽略旧文件 ${legacyVault}`)
    } else {
      await mkdir(VAULT_DIR, { recursive: true, mode: 0o700 })
      await copyFile(legacyVault, VAULT_PATH)
      vault = await openVault(VAULT_PATH)
      appendLogToTerminal(`已从 ${legacyVault} 迁移账号库`)
    }
  }
  // 备份目录也一起搬（不冲突时才动）
  const legacyBackups = join(legacyDir, 'backups')
  const newBackups = join(VAULT_DIR, 'backups')
  if ((await exists(legacyBackups)) && !(await exists(newBackups))) {
    try {
      await rename(legacyBackups, newBackups)
    } catch {
      // 跨卷或权限问题：保持原样，不影响主流程
    }
  }
}

function appendLogToTerminal(text) {
  process.stdout.write(`${text}\n`)
}

/** 把早期版本的 `userData/accounts.json` 搬到新位置，搬完删旧的。 */
async function migrateLegacyVault() {
  const legacy = join(app.getPath('userData'), 'accounts.json')
  if (legacy === VAULT_PATH) return
  try {
    await stat(legacy)
  } catch {
    return // 没有旧文件
  }
  try {
    await stat(VAULT_PATH)
    return // 新位置已有数据，不覆盖
  } catch {
    // 继续迁移
  }
  await mkdir(VAULT_DIR, { recursive: true, mode: 0o700 })
  await copyFile(legacy, VAULT_PATH)
  await rm(legacy, { force: true })
  vault = await openVault(VAULT_PATH)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

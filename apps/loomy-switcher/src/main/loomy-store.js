/**
 * Loomy 客户端的登录态存储层。
 *
 * 事实（反编译 /Applications/Loomy.app/Contents/Resources/app.asar 得到）：
 *
 * - 渲染进程才是登录态的**源头**：`localStorage['loomy-auth-session']`
 *   形如 `{phone, maskedPhone, session, userid, loggedInAt}`；
 * - 主进程的 `auth-session.json`（electron-store）只是**镜像**，启动时被
 *   渲染进程通过 `electronAPI.auth.setSession()` 反向覆盖；
 * - 因此只改 `auth-session.json` 无用，必须改 Chromium Local Storage 的
 *   leveldb 日志；改完启动，主进程镜像会被自动写回正确值；
 * - 打包版移除了 `--remote-debugging-port`（electron/utils/remote-debugging.js
 *   的 sanitizePackagedRemoteDebuggingSwitches），所以只能离线改 leveldb。
 *
 * 本模块只依赖 node 标准库，可在 Electron 之外的测试进程里直接跑。
 *
 * @module loomy-switcher/loomy-store
 */

import { execFile } from 'node:child_process'
import { copyFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** localStorage 里存登录态的键。 */
export const AUTH_KEY = 'loomy-auth-session'
/** 登录页预填的手机号键。 */
export const LAST_PHONE_KEY = 'loomy-last-login-phone'
/** 按账号区分的缓存键：切换后必须清掉，否则显示上一个账号的数据。 */
export const STALE_KEYS = ['loomy-user-identity', 'loomy-points-summary']

const LOOMY_BUNDLE = '/Applications/Loomy.app'
const LOOMY_BINARY = `${LOOMY_BUNDLE}/Contents/MacOS/Loomy`

/** leveldb 日志块大小。 */
const BLOCK = 32768

/* ------------------------------------------------------------------ *
 * 路径发现
 * ------------------------------------------------------------------ */

/**
 * Loomy 的 Electron `userData` 目录候选。
 *
 * macOS 上实测是 `~/Library/Application Support/loomy`（小写），但同一份
 * 代码的不同构建可能写成 `Loomy`，所以两个都试；命中条件是有
 * `Local Storage/leveldb`，比单纯看目录存在更可靠。
 */
export function userDataCandidates(home = homedir()) {
  const base = join(home, 'Library', 'Application Support')
  return [join(base, 'loomy'), join(base, 'Loomy')]
}

/** 找到真正在用、且确实存过登录态的 userData 目录。 */
export async function findUserData(home = homedir()) {
  for (const dir of userDataCandidates(home)) {
    try {
      await stat(join(dir, 'Local Storage', 'leveldb'))
      return dir
    } catch {
      // 下一个候选
    }
  }
  return undefined
}

/** 一份完整的客户端状态快照，供界面显示与切换前检查。 */
export async function inspect(home = homedir()) {
  const userData = await findUserData(home)
  if (userData === undefined) {
    return { installed: false, appInstalled: await exists(LOOMY_BINARY), running: false }
  }
  const logPath = await newestLog(userData)
  const current = logPath === undefined ? undefined : await readCurrentSession(logPath)
  const mirror = await readMirror(userData)
  return {
    installed: true,
    appInstalled: await exists(LOOMY_BINARY),
    userData,
    logPath,
    running: await isRunning(),
    current,
    mirror,
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

/* ------------------------------------------------------------------ *
 * 进程控制
 * ------------------------------------------------------------------ */

/** Loomy 主进程是否在跑。 */
export async function isRunning() {
  try {
    const { stdout } = await run('pgrep', ['-f', LOOMY_BINARY])
    return stdout.trim().length > 0
  } catch (error) {
    // pgrep 无匹配时退出码 1：这是"没在跑"，不是失败。
    if (error && typeof error === 'object' && error.code === 1) return false
    return false
  }
}

/**
 * 让 Loomy 退出。
 *
 * 顺序：AppleScript 优雅退出 → 轮询 → SIGTERM → SIGKILL。必须在写 leveldb
 * **之前**完成，否则它退出时会把内存里的旧登录态写回，覆盖我们的结果
 * （实测：改完 auth-session.json 重启，17:30:49 被回写成旧号）。
 */
export async function quit({ timeoutMs = 15_000 } = {}) {
  if (!(await isRunning())) return { alreadyStopped: true }

  try {
    await run('osascript', ['-e', 'tell application "Loomy" to quit'], { timeout: 8_000 })
  } catch {
    // 脚本退出失败不影响后面的强杀
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isRunning())) return { alreadyStopped: false, signal: 'quit' }
    await sleep(300)
  }

  for (const signal of ['TERM', 'KILL']) {
    try {
      await run('pkill', [`-${signal}`, '-f', LOOMY_BINARY])
    } catch {
      // 已经没了
    }
    const until = Date.now() + 4_000
    while (Date.now() < until) {
      if (!(await isRunning())) return { alreadyStopped: false, signal }
      await sleep(200)
    }
  }
  throw new Error('Loomy 无法退出：请手动退出后重试（⌘Q）')
}

/** 重新打开 Loomy。 */
export async function launch() {
  await run('open', ['-a', 'Loomy'])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * leveldb 日志：读
 * ------------------------------------------------------------------ */

/** CRC32C（Castagnoli），leveldb 的校验算法。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32c(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** leveldb 存的不是裸 CRC32C，而是"掩码"后的值。 */
const maskCrc = (crc) => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0

function writeVarint(value) {
  const out = []
  let n = value
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

function readVarint(buffer, position) {
  let result = 0
  let shift = 0
  let pos = position
  for (;;) {
    const byte = buffer[pos]
    pos += 1
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new Error('varint 过长，文件可能不是 leveldb 日志')
  }
  return [result >>> 0, pos]
}

/** 解析物理日志记录（含块边界 padding）。 */
export function parseRecords(buffer) {
  const records = []
  let pos = 0
  while (pos + 7 <= buffer.length) {
    const leftInBlock = BLOCK - (pos % BLOCK)
    if (leftInBlock < 7) {
      pos += leftInBlock
      continue
    }
    const storedCrc = buffer.readUInt32LE(pos)
    const length = buffer.readUInt16LE(pos + 4)
    const type = buffer[pos + 6]
    if (type === 0 && length === 0) {
      // 块尾 padding：直接跳到下一块
      pos += leftInBlock
      continue
    }
    if (pos + 7 + length > buffer.length) break
    const data = buffer.subarray(pos + 7, pos + 7 + length)
    records.push({
      offset: pos,
      length,
      type,
      data,
      valid: maskCrc(crc32c(Buffer.concat([Buffer.from([type]), data]))) === storedCrc,
    })
    pos += 7 + length
  }
  return records
}

/** 解析一条 WriteBatch。 */
export function parseBatch(data) {
  if (data.length < 12) return undefined
  const sequence = Number(data.readBigUInt64LE(0))
  const count = data.readUInt32LE(8)
  const entries = []
  let pos = 12
  for (let i = 0; i < count; i += 1) {
    if (pos >= data.length) break
    const tag = data[pos]
    pos += 1
    let keyLength
    ;[keyLength, pos] = readVarint(data, pos)
    const key = data.subarray(pos, pos + keyLength)
    pos += keyLength
    if (tag === 1) {
      let valueLength
      ;[valueLength, pos] = readVarint(data, pos)
      entries.push({ tag, key, value: data.subarray(pos, pos + valueLength) })
      pos += valueLength
    } else {
      entries.push({ tag, key })
    }
  }
  return { sequence, count, entries }
}

/** localStorage 的键在 leveldb 里的真实字节：`_file://\0\x01<name>`。 */
export function storageKey(name) {
  return Buffer.concat([Buffer.from('_file://'), Buffer.from([0x00, 0x01]), Buffer.from(name)])
}

/** localStorage 的值前面还有一个 0x01（UTF-16/UTF-8 编码标记）。 */
const encodeValue = (text) => Buffer.concat([Buffer.from([0x01]), Buffer.from(text, 'utf8')])

/**
 * 回放日志，得到某个 key 的最终值。
 *
 * 同一份日志里同一 key 会出现很多次（每次登录都追加一条），必须取最后一条
 * 有效记录 —— 这正是上一轮把账号改错的原因：只看到文件里第一个匹配。
 */
export function replay(buffer, keyName) {
  const target = storageKey(keyName)
  let found
  let sequence = 0
  for (const record of parseRecords(buffer)) {
    if (!record.valid || record.type !== 1) continue
    let batch
    try {
      batch = parseBatch(record.data)
    } catch {
      continue
    }
    if (batch === undefined) continue
    sequence = Math.max(sequence, batch.sequence + Math.max(batch.count - 1, 0))
    for (const entry of batch.entries) {
      if (!entry.key.equals(target)) continue
      found = entry.tag === 1 ? entry.value.subarray(1).toString('utf8') : undefined
    }
  }
  return { value: found, sequence }
}

/** 读当前登录态（渲染进程的真实源头）。 */
export async function readCurrentSession(logPath) {
  const buffer = await readFile(logPath)
  const { value } = replay(buffer, AUTH_KEY)
  if (value === undefined) return undefined
  return parseSession(value)
}

/** 读主进程镜像 `auth-session.json`。 */
export async function readMirror(userData) {
  try {
    const text = await readFile(join(userData, 'auth-session.json'), 'utf8')
    return parseSession(text)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * leveldb 日志：写
 * ------------------------------------------------------------------ */

/** 最新的 `.log`（压缩后编号会递增，不能写死 000003.log）。 */
export async function newestLog(userData) {
  const dir = join(userData, 'Local Storage', 'leveldb')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const logs = names
    .filter((name) => /^\d+\.log$/u.test(name))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
  return logs.length === 0 ? undefined : join(dir, logs.at(-1))
}

/**
 * 追加一个 WriteBatch 到日志末尾。
 *
 * 三条关键细节，缺一条 leveldb 恢复时就看不到我们的写入：
 *
 * 1. **截断尾部垃圾**：进程被杀可能留下半条记录，恢复时扫到坏记录即停止，
 *    所以先按"最后一条完整且 CRC 正确的记录"截断；
 * 2. **块尾 padding**：剩余空间不足 7 字节时必须补零到下一块；
 * 3. **序列号**：必须大于日志里见过的最大序列号，否则会被旧值覆盖。
 */
export function appendBatch(buffer, entries) {
  let lastEnd = 0
  let maxSequence = 0
  for (const record of parseRecords(buffer)) {
    if (!record.valid) break
    lastEnd = record.offset + 7 + record.length
    if (record.type !== 1) continue
    let batch
    try {
      batch = parseBatch(record.data)
    } catch {
      continue
    }
    if (batch === undefined) continue
    maxSequence = Math.max(maxSequence, batch.sequence + Math.max(batch.count - 1, 0))
  }

  const kept = buffer.subarray(0, lastEnd)
  const padToBlock = BLOCK - (kept.length % BLOCK)
  const prefix = padToBlock < 7 ? Buffer.alloc(padToBlock) : Buffer.alloc(0)

  const payload = []
  for (const entry of entries) {
    const key = entry.key
    const keyLength = writeVarint(key.length)
    if (entry.value === undefined) {
      payload.push(Buffer.from([0x00]), keyLength, key)
    } else {
      const value = encodeValue(entry.value)
      payload.push(Buffer.from([0x01]), keyLength, key, writeVarint(value.length), value)
    }
  }
  const body = Buffer.concat([Buffer.alloc(12), ...payload])
  body.writeBigUInt64LE(BigInt(maxSequence + 1), 0)
  body.writeUInt32LE(entries.length, 8)

  const header = Buffer.alloc(7)
  header.writeUInt32LE(maskCrc(crc32c(Buffer.concat([Buffer.from([0x01]), body]))), 0)
  header.writeUInt16LE(body.length, 4)
  header[6] = 0x01

  return {
    buffer: Buffer.concat([kept, prefix, header, body]),
    truncatedBytes: buffer.length - lastEnd,
    paddings: prefix.length,
    sequence: maxSequence + 1,
  }
}

/* ------------------------------------------------------------------ *
 * 切换
 * ------------------------------------------------------------------ */

/**
 * 把一份登录态写进客户端。
 *
 * 流程刻意做成"先备份、再退出、再写、再启动、再校验"，任何一步失败都留
 * 下可回滚的备份，并返回结构化结果给界面展示。
 */
export async function applySession(session, options = {}) {
  const home = options.home ?? homedir()
  const restart = options.restart !== false
  const steps = []
  const userData = await findUserData(home)
  if (userData === undefined) throw new Error('没有找到 Loomy 客户端数据目录（~/Library/Application Support/loomy）')

  const normalized = normalizeSession(session)
  const logPath = await newestLog(userData)
  if (logPath === undefined) throw new Error('没有找到 Local Storage/leveldb 日志：请先启动一次 Loomy 并完成登录')

  const backupDir = await backup(userData, home)
  steps.push({ ok: true, text: `已备份客户端状态 → ${backupDir}` })

  if (await isRunning()) {
    const quitResult = await quit()
    steps.push({ ok: true, text: quitResult.signal === undefined ? 'Loomy 已退出' : `Loomy 已退出（${quitResult.signal}）` })
  } else {
    steps.push({ ok: true, text: 'Loomy 未运行，跳过退出' })
  }

  const before = await readFile(logPath)
  const plan = appendBatch(before, [
    { key: storageKey(AUTH_KEY), value: JSON.stringify(normalized) },
    { key: storageKey(LAST_PHONE_KEY), value: normalized.phone },
    ...STALE_KEYS.map((name) => ({ key: storageKey(name), value: undefined })),
  ])

  const handle = await open(logPath, 'r+')
  try {
    await handle.truncate(0)
    await handle.write(plan.buffer, 0, plan.buffer.length, 0)
  } finally {
    await handle.close()
  }
  steps.push({
    ok: true,
    text: `已写入登录态（seq ${plan.sequence}${plan.truncatedBytes > 0 ? `，清理尾部残缺 ${plan.truncatedBytes}B` : ''}）`,
  })

  // 主进程镜像：留一份正确的初值，避免首次启动时界面闪一下旧号。
  const mirrorPath = join(userData, 'auth-session.json')
  const mirror = {
    session: normalized.session,
    userid: normalized.userid,
    phone: normalized.phone,
    updatedAt: Date.now(),
  }
  await writeFile(mirrorPath, `${JSON.stringify(mirror, undefined, 2)}\n`, { mode: 0o644 })
  steps.push({ ok: true, text: `已同步主进程镜像 auth-session.json` })

  if (options.dshAuthPath !== undefined) {
    await mkdir(join(options.dshAuthPath, '..'), { recursive: true })
    await writeFile(options.dshAuthPath, `${JSON.stringify(mirror, undefined, 2)}\n`, { mode: 0o600 })
    steps.push({ ok: true, text: '已同步 DSH 插件登录态' })
  }

  let verify
  if (restart) {
    await launch()
    steps.push({ ok: true, text: 'Loomy 已重新启动' })
    verify = await waitForSession(userData, normalized.session, 25_000)
    steps.push(
      verify.ok
        ? { ok: true, text: `校验通过：客户端当前账号 ${displayPhone(verify.session.phone)}` }
        : { ok: false, text: `校验未通过：${verify.reason}` },
    )
  } else {
    verify = { ok: true, session: normalized, reason: '跳过重启，下次启动生效' }
  }

  return { ok: verify.ok, steps, backupDir, session: normalized, verify }
}

/** 等客户端启动后自己把登录态读回来（也验证镜像被回写正确）。 */
async function waitForSession(userData, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastReason = '超时'
  while (Date.now() < deadline) {
    const current = await readMirror(userData)
    if (current?.session === expected) {
      const logPath = await newestLog(userData)
      const fromStore = logPath === undefined ? undefined : await readCurrentSession(logPath)
      if (fromStore?.session === expected) return { ok: true, session: current }
      lastReason = 'localStorage 与镜像不一致'
    } else if (current !== undefined) {
      lastReason = `镜像仍是 ${displayPhone(current.phone)}`
    }
    await sleep(600)
  }
  return { ok: false, reason: lastReason }
}

/** 备份 userData 里会动的凭证相关文件。 */
async function backup(userData, home = homedir()) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const root = join(home, '.loomy-account-switcher', 'backups')
  const dir = join(root, stamp)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const name of ['auth-session.json', 'Preferences']) {
    try {
      await copyFile(join(userData, name), join(dir, name))
    } catch {
      // 文件不存在就不备份
    }
  }
  await copyDirectory(join(userData, 'Local Storage', 'leveldb'), join(dir, 'leveldb'))
  // 只保留最近 20 份，避免无限增长
  try {
    const entries = (await readdir(root)).sort()
    for (const stale of entries.slice(0, Math.max(0, entries.length - 20))) {
      await rm(join(root, stale), { recursive: true, force: true })
    }
  } catch {
    // 清理失败不影响主流程
  }
  return dir
}

async function copyDirectory(from, to) {
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyDirectory(source, target)
    else if (entry.isFile()) await copyFile(source, target)
  }
}

/* ------------------------------------------------------------------ *
 * 解析 / 规整
 * ------------------------------------------------------------------ */

/** 校验并规整一份登录态。 */
export function normalizeSession(input) {
  if (input === null || typeof input !== 'object') throw new Error('登录态必须是 JSON 对象')
  const raw = input
  // 插件 0.3.0 起导出包用 `material`（旧版是 `session`）；两者都认，用户的
  // 粘贴动作不该因为字段改名而失败。
  const session = String(raw.session ?? raw.material ?? '').trim()
  const userid = String(raw.userid ?? raw.userId ?? '').trim()
  // 掩码手机号（`189****2700`，插件导出包里常见）不能被 digitsOnly 揉成
  // `1892700` 这种非手机号，必须原样保留——切换时它就是客户端要显示的值。
  const rawPhone = String(raw.phone ?? raw.maskedPhone ?? '').trim()
  const phone = /^\d{3}\*{4}\d{4}$/u.test(rawPhone) ? rawPhone : digitsOnly(rawPhone)
  if (session.length < 16 || /\s/u.test(session)) throw new Error('session 无效：需要 ≥16 位且不含空白')
  if (userid.length === 0) throw new Error('userid 不能为空')
  if (!/^1[3-9]\d{9}$/u.test(phone) && !/^\d{3}\*{4}\d{4}$/u.test(phone)) {
    throw new Error('phone 需要是 11 位手机号或 189****2700 这种掩码')
  }
  return {
    phone,
    maskedPhone: phone.includes('*') ? phone : `${phone.slice(0, 3)}****${phone.slice(7)}`,
    session,
    userid,
    loggedInAt: typeof raw.loggedInAt === 'string' && raw.loggedInAt.length > 0 ? raw.loggedInAt : new Date().toISOString(),
  }
}

function parseSession(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  try {
    return normalizeSession(parsed)
  } catch {
    return undefined
  }
}

const digitsOnly = (value) => String(value ?? '').replace(/\D/gu, '').slice(0, 11)

/**
 * 明文手机号（界面显示用）。
 *
 * 这个工具在本机、只服务账号所有者本人，遮住手机号没有任何安全收益，反而
 * 让多个同前七位的账号无法区分。历史遗留的掩码值（`171****2846`，来自早期
 * 导入的插件导出包）原样返回。
 */
export function displayPhone(phone) {
  const value = String(phone ?? '').trim()
  if (/^\d{3}\*{4}\d{4}$/u.test(value)) return value
  const digits = digitsOnly(value)
  return digits.length === 11 ? digits : value
}

/** 掩码手机号：只用于提醒上游失效时的日志文案，不用于界面。 */
export function maskPhone(phone) {
  const value = String(phone ?? '')
  if (/^\d{3}\*{4}\d{4}$/u.test(value)) return value
  const digits = digitsOnly(value)
  return digits.length === 11 ? `${digits.slice(0, 3)}****${digits.slice(7)}` : value
}

/**
 * 把用户粘贴的内容展开成若干登录态。
 *
 * 接受四种形状：单条 `{session,userid,phone}`、数组、本仓库插件导出的
 * `{kind:'dsh-connect-desktop/accounts',accounts:[…]}`（0.3.0）与旧名的同一形状、
 * 以及裸 `{accounts:[…]}`。`kind` 本身不参与判定：只看 `accounts` 数组里的字段。
 */
export function parseImport(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const one = (item) => {
    try {
      return normalizeSession(item)
    } catch {
      return undefined
    }
  }
  const list = (value) => (Array.isArray(value) ? value : [])
  const items = Array.isArray(parsed)
    ? list(parsed)
    : Array.isArray(parsed?.accounts)
      ? parsed.accounts
      : [parsed]
  const sessions = items.map(one).filter((entry) => entry !== undefined)
  if (sessions.length === 0) {
    throw new Error('JSON 里没有可用的登录态：需要 session / userid / phone')
  }
  return sessions
}

/** 退出登录：清掉本机登录态。 */
export async function signOut(options = {}) {
  const home = options.home ?? homedir()
  const userData = await findUserData(home)
  if (userData === undefined) throw new Error('没有找到 Loomy 客户端数据目录')
  const logPath = await newestLog(userData)
  if (logPath === undefined) throw new Error('没有找到 Local Storage/leveldb 日志')
  const backupDir = await backup(userData, home)
  if (await isRunning()) await quit()
  const before = await readFile(logPath)
  const plan = appendBatch(before, [
    { key: storageKey(AUTH_KEY), value: undefined },
    ...STALE_KEYS.map((name) => ({ key: storageKey(name), value: undefined })),
  ])
  const handle = await open(logPath, 'r+')
  try {
    await handle.truncate(0)
    await handle.write(plan.buffer, 0, plan.buffer.length, 0)
  } finally {
    await handle.close()
  }
  if (options.restart !== false) await launch()
  return { backupDir, backupPath: backupDir, userData, logFile: basename(logPath) }
}

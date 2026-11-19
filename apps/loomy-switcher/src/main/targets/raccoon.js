/**
 * 小浣熊（商汤）桌面客户端的登录态。
 *
 * 与 Loomy 完全不同的一套机制，反编译 `/Applications/商汤小浣熊.app/Contents/Resources/app.asar`
 * 得到的事实：
 *
 * - 登录态是一个**明文 JSON 文件**：`<userData>/agent/config/auth.json`，
 *   形如 `{access_token, office_identity}`，权限 0600；
 * - `access_token` 是 IAM 签发的 **JWT**（`iss: xiaohuanxiong.com/iam`），
 *   有效期 30 天，`exp` 字段可直接读出；
 * - 主进程启动时 `readDesktopAuthState()` 就读这个文件（`boxAgentAuthFile.js`），
 *   没有 leveldb、没有 safeStorage 加密，所以**切换账号只需改这一个文件**；
 * - 渲染进程在启动时会重新 `getUserInfo()` + `getUserSettingInfo()`，
 *   所以改完重启就生效，不需要清理 localStorage。
 *
 * 实测（2026-11-18）：回写同结构文件后启动客户端，登录态保持、token 未被覆盖。
 *
 * @module account-switcher/targets/raccoon
 */

import { execFile } from 'node:child_process'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const TARGET_ID = 'raccoon'
export const LABEL = '小浣熊'
export const APP_NAME = '商汤小浣熊'
const APP_BINARY = '/Applications/商汤小浣熊.app/Contents/MacOS/商汤小浣熊'

/** 平台网关（与客户端 `officeUrl` 默认值一致）。 */
export const BASE_URL = 'https://xiaohuanxiong.com'

/**
 * 官方 bootstrap 写在 profile 根目录的标记（`@raccoon/office-desktop`）。
 *
 * `clientProfile.ts` 里 `PROFILE_MARKER = '.raccoon-lab-client.json'`，
 * `PROFILE_CONTENT = '{"application":"@raccoon/office-desktop","version":1}\n'`。
 * 有它才说明这是新客户端的 profile：此时 `agentHome = <root>/agent`。
 * 没有它的老安装（legacy）则把 `~/.box-agent` 当 agentHome。
 */
const PROFILE_MARKER = '.raccoon-lab-client.json'

/** legacy 安装的 agentHome 目录名（`<home>/.box-agent`）。 */
const LEGACY_AGENT_HOME = '.box-agent'

/** profile 候选：新布局的三个可能命名，外加 legacy 的 `~/.box-agent`。 */
export function userDataCandidates(home = homedir()) {
  const base = join(home, 'Library', 'Application Support')
  return [
    join(base, 'office-raccoon'),
    join(base, 'raccoon-office'),
    join(base, 'Raccoon'),
    join(home, LEGACY_AGENT_HOME),
  ]
}

/**
 * 官方 `getBoxAgentAuthPath()` 的落点。
 *
 * 官方是 `join(BOX_AGENT_CONFIG_DIR || join(resolveBoxAgentHome(), 'config'), 'auth.json')`，
 * 而 `BOX_AGENT_HOME` 由 `clientProfileEnvironment(profile)` 设成
 * `profile.agentHome`：
 *
 * - 新 profile：`agentHome = <userData>/agent` → `<userData>/agent/config/auth.json`
 * - legacy：`agentHome = ~/.box-agent`      → `~/.box-agent/config/auth.json`
 *
 * 两者布局差一层 `agent`，所以这里按目录名判断，不能一律拼 `agent/`。
 */
export function authPathOf(userData) {
  if (basename(userData) === LEGACY_AGENT_HOME) return join(userData, 'config', 'auth.json')
  return join(userData, 'agent', 'config', 'auth.json')
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 这个目录是不是官方新客户端的 profile（带 marker）。 */
export async function isClientProfile(userData) {
  return isFile(join(userData, PROFILE_MARKER))
}

/**
 * 找到客户端真正在用的数据目录。
 *
 * 判定顺序与官方一致：先看哪个目录已经有 `config/auth.json`（那就是当前
 * 登录态所在），再退到"像不像一个 profile"——否则用户还没登录时切换账号
 * 会找不到写入目标（官方自己是用 `mkdir -p` 直接造的）。
 */
export async function findUserData(home = homedir()) {
  const candidates = userDataCandidates(home)
  for (const dir of candidates) {
    if (await isFile(authPathOf(dir))) return dir
  }
  for (const dir of candidates) {
    if (await isClientProfile(dir)) return dir
    if (basename(dir) === LEGACY_AGENT_HOME) {
      if (await isDir(join(dir, 'config'))) return dir
      continue
    }
    if (await isDir(join(dir, 'agent'))) return dir
  }
  return undefined
}

export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * JWT
 * ------------------------------------------------------------------ */

/** 解出 JWT 的 payload；不是 JWT 就返回 undefined（老式 opaque token）。 */
export function decodeJwt(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(json)
    return payload !== null && typeof payload === 'object' ? payload : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 官方凭证文件契约（对齐 `app.asar` 里的 boxAgentAuthFile.js）
 * ------------------------------------------------------------------ */

/**
 * 官方 `AUTH_FILE_KEYS`：字段名**只有下划线这一套**。
 *
 * 反编译 `/Applications/商汤小浣熊.app`（1.2.0）得到：
 *
 * ```js
 * const AUTH_FILE_KEYS = {
 *   accessToken: 'access_token',
 *   refreshToken: 'refresh_token',
 *   officeIdentity: 'office_identity',
 *   officeOrgName: 'office_org_name',
 *   officeOrgRole: 'office_org_role',
 * }
 * ```
 *
 * 写入走 `writeBoxAgentDesktopAuthState()`：**整份覆盖**成这五个键（空值
 * 直接省略），序列化 `JSON.stringify(payload, null, 2) + '\n'`，权限 0600，
 * 内容与权限都没变就跳过写盘；五个键全空则删文件。
 *
 * 读取走 `readBoxAgentDesktopAuthState()`：`access_token || token ||
 * auth_token`——官方自己认后两个别名，但**不认 `accessToken`**（驼峰只在
 * 我们插件自己的导出包里出现）。所以：
 *
 * - 写：严格用下面这张表，绝不写驼峰；
 * - 读：官方三个别名都对上，另外对我们自己导出的驼峰格式保持宽容（导入
 *   时用，不参与写客户端）。
 */
const AUTH_FILE_KEYS = {
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  officeIdentity: 'office_identity',
  officeOrgName: 'office_org_name',
  officeOrgRole: 'office_org_role',
}

/** 官方读取时的 token 别名顺序（`access_token || token || auth_token`）。 */
const OFFICIAL_TOKEN_KEYS = ['access_token', 'token', 'auth_token']

/**
 * 官方 `isIamToken()`：JWT 的 `iss` 以 `/iam` 结尾。
 *
 * 这条判定决定 refresh_token 的去留——IAM 令牌自带 30 天有效期，
 * 官方在里面**根本不落 refresh_token**（写了也会在读的时候被丢掉）。
 */
export function isIamToken(token) {
  if (typeof token !== 'string' || token.length === 0) return false
  const payload = decodeJwt(token)
  return typeof payload?.iss === 'string' && payload.iss.endsWith('/iam')
}

/* ------------------------------------------------------------------ *
 * 读 / 写登录态
 * ------------------------------------------------------------------ */

/**
 * 读一份登录态并补充元信息。
 *
 * 字段按官方的三个 token 别名 + 五个键取；`expiresAt` 来自 JWT 的 `exp`，
 * 老式 opaque token 没有过期信息时为 `undefined`（界面显示"未知"）。
 */
export async function readSession(userData) {
  const path = authPathOf(userData)
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  // 与官方一样按 truthy 顺序回退：`access_token || token || auth_token`
  const session = OFFICIAL_TOKEN_KEYS.map((key) =>
    typeof parsed[key] === 'string' ? parsed[key].trim() : '',
  ).find((value) => value.length > 0)
  if (session === undefined || session.length < 16) return undefined
  const payload = decodeJwt(session)
  const exp = typeof payload?.exp === 'number' ? payload.exp : undefined
  const iat = typeof payload?.iat === 'number' ? payload.iat : undefined
  const identity = nonEmpty(parsed[AUTH_FILE_KEYS.officeIdentity])
  const orgName = nonEmpty(parsed[AUTH_FILE_KEYS.officeOrgName])
  const orgRole = nonEmpty(parsed[AUTH_FILE_KEYS.officeOrgRole])
  // IAM 令牌不落 refresh_token，官方读的时候也当它不存在
  const refreshToken = isIamToken(session) ? undefined : nonEmpty(parsed[AUTH_FILE_KEYS.refreshToken])
  return {
    session,
    identity: identity ?? '',
    ...(orgName === undefined ? {} : { orgName }),
    ...(orgRole === undefined ? {} : { orgRole }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(iat === undefined ? {} : { issuedAt: iat * 1000 }),
    ...(exp === undefined ? {} : { expiresAt: exp * 1000 }),
    sub: typeof payload?.sub === 'string' ? payload.sub : undefined,
    iam: isIamToken(session),
  }
}

/** 取一个去空白的字符串；空串/非字符串都是 `undefined`（= 官方 `normalizeString`）。 */
function nonEmpty(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 写入登录态，**严格照官方形状**。
 *
 * 与官方 `writeBoxAgentDesktopAuthState` 逐条一致：
 * 1. 只写 `AUTH_FILE_KEYS` 里那五个键，空值省略；
 * 2. IAM 令牌不写 `refresh_token`（自带 30 天有效期，写了也被读时丢弃）；
 * 3. 序列化 `JSON.stringify(payload, null, 2) + '\n'`；
 * 4. 权限 0600，先写临时文件再 rename；
 * 5. 内容与权限都没变就跳过，不制造无谓的 mtime 抖动；
 * 6. 一个键都没有 → 删除文件（等价于官方 `clearBoxAgentDesktopAuthState`）。
 *
 * 注意这里**不保留旧文件里的未知字段**：官方每次也是整份覆盖，那些字段
 * 官方既不会读也不会写，留着反而会让上一个账号的组织信息残留到新账号上
 * （`office_org_name` / `office_org_role` 是账号级信息）。
 */
export async function writeSession(userData, session, options = {}) {
  const path = authPathOf(userData)
  const token = nonEmpty(session.session)
  if (token === undefined) throw new Error('没有可写入的 access_token')
  const payload = {}
  payload[AUTH_FILE_KEYS.accessToken] = token
  const refreshToken = isIamToken(token) ? undefined : nonEmpty(session.refreshToken)
  if (refreshToken !== undefined) payload[AUTH_FILE_KEYS.refreshToken] = refreshToken
  const identity = nonEmpty(session.identity)
  if (identity !== undefined) payload[AUTH_FILE_KEYS.officeIdentity] = identity
  const orgName = nonEmpty(session.orgName)
  if (orgName !== undefined) payload[AUTH_FILE_KEYS.officeOrgName] = orgName
  const orgRole = nonEmpty(session.orgRole)
  if (orgRole !== undefined) payload[AUTH_FILE_KEYS.officeOrgRole] = orgRole

  const serialized = `${JSON.stringify(payload, null, 2)}\n`
  // 官方 isCurrentAuthFile()：内容一字不差且权限已是 0600 才算"当前文件"
  if (await isCurrentAuthFile(path, serialized)) {
    return { path, bytes: Buffer.byteLength(serialized), unchanged: true }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
  return { path, bytes: Buffer.byteLength(serialized), unchanged: false }
}

/** 官方 `isCurrentAuthFile()`：内容相同且权限 0600（win32 免检权限）。 */
async function isCurrentAuthFile(path, serialized) {
  try {
    if ((await readFile(path, 'utf8')) !== serialized) return false
    if (process.platform === 'win32') return true
    return ((await stat(path)).mode & 0o777) === 0o600
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 导入解析
 * ------------------------------------------------------------------ */

/**
 * 字段名有**两套拼写**，两边都得认。
 *
 * - 桌面端自己的 `agent/config/auth.json` 是 `access_token`（下划线，服务端
 *   原样返回的名字）；
 * - 本仓库插件导出的账号包、以及不少人手抄的 JSON 是 `accessToken`（驼峰）。
 *
 * 只认下划线时，用户从插件复制出来的包粘进导入框会得到一句"没有可用的
 * 登录态"——而 JSON 里明明有 token，纯属名字对不上。所以这里按别名表取值，
 * 与插件侧 `parseBundle` 的宽容度对齐。
 */
const TOKEN_FIELDS = ['access_token', 'accessToken', 'token', 'session']
const IDENTITY_FIELDS = ['office_identity', 'identity']
const ORG_NAME_FIELDS = ['office_org_name', 'orgName']
const ORG_ROLE_FIELDS = ['office_org_role', 'orgRole']
const PHONE_FIELDS = ['phone', 'phoneMasked', 'phone_masked']
const USERID_FIELDS = ['userid', 'userId', 'user_id']
const REFRESH_FIELDS = ['refresh_token', 'refreshToken']
const NAME_FIELDS = ['name', 'label']

/** 取记录里第一个非空字符串字段（`null` / 空串 / 非字符串全部跳过）。 */
function firstString(record, names) {
  if (record === null || typeof record !== 'object') return undefined
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 把一条 token 补成账号行。
 *
 * `expiresAt` 直接取 JWT 的 `exp`——有效期是平台给的，不该靠 30 天去猜。
 */
export function buildSession(token, extra = {}) {
  const session = String(token ?? '').trim()
  if (session.length < 16) throw new Error('access_token 太短，不像是有效凭证')
  const payload = decodeJwt(session)
  const exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined
  const phone = firstString(extra, PHONE_FIELDS) ?? ''
  const userid =
    firstString(extra, USERID_FIELDS) ?? (typeof payload?.sub === 'string' ? payload.sub : '')
  const identity = firstString(extra, IDENTITY_FIELDS)
  const orgName = firstString(extra, ORG_NAME_FIELDS)
  const orgRole = firstString(extra, ORG_ROLE_FIELDS)
  // IAM 令牌自带 30 天有效期，官方在这种令牌上根本不落 refresh_token
  const refreshToken = isIamToken(session) ? undefined : firstString(extra, REFRESH_FIELDS)
  const name = firstString(extra, NAME_FIELDS)
  return {
    session,
    phone,
    userid,
    ...(identity === undefined ? {} : { identity }),
    ...(orgName === undefined ? {} : { orgName }),
    ...(orgRole === undefined ? {} : { orgRole }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(name === undefined ? {} : { name }),
    ...(exp === undefined ? {} : { expiresAt: exp }),
  }
}

/**
 * 把粘贴的 JSON 展开成账号。
 *
 * 接受：裸字符串、单条凭证对象（桌面端 `auth.json` 或插件导出的单条）、
 * 数组、以及带 `accounts` 的信封（`{kind:'dsh-connect-desktop/accounts'}` 与
 * 插件的 `{formatVersion,vendor:'raccoon',accounts:[…]}` 都走这一条）。
 */
export function parseAuthDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const one = (item) => {
    if (typeof item === 'string') return buildSession(item)
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const token = firstString(item, TOKEN_FIELDS)
    return token === undefined ? undefined : buildSession(token, item)
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.accounts)
      ? parsed.accounts
      : [parsed]
  const sessions = items.map(one).filter((entry) => entry !== undefined)
  if (sessions.length === 0) {
    throw new Error('JSON 里没有可用的登录态：需要 access_token 或 accessToken（也接受 token / session）')
  }
  return sessions
}

/* ------------------------------------------------------------------ *
 * 进程控制
 * ------------------------------------------------------------------ */

export async function isRunning() {
  try {
    const { stdout } = await run('pgrep', ['-f', APP_BINARY])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/** 优雅退出；写文件之前必须完成，否则应用会把内存里的旧 token 写回。 */
export async function quit({ timeoutMs = 20_000 } = {}) {
  if (!(await isRunning())) return { alreadyStopped: true }
  try {
    await run('osascript', ['-e', `tell application "${APP_NAME}" to quit`], { timeout: 8_000 })
  } catch {
    // 继续强杀
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isRunning())) return { alreadyStopped: false, signal: 'quit' }
    await sleep(300)
  }
  for (const signal of ['TERM', 'KILL']) {
    try {
      await run('pkill', [`-${signal}`, '-f', APP_BINARY])
    } catch {
      // 已经没了
    }
    const until = Date.now() + 4_000
    while (Date.now() < until) {
      if (!(await isRunning())) return { alreadyStopped: false, signal }
      await sleep(200)
    }
  }
  throw new Error(`${LABEL} 无法退出：请手动退出后重试（⌘Q）`)
}

export async function launch() {
  await run('open', ['-a', APP_NAME])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * 平台 API
 * ------------------------------------------------------------------ */

/**
 * 发一次带 Bearer 的平台请求。
 *
 * 小浣熊的响应外层是 `{code, message, data}`，`code === 0` 才是成功；
 * 401 表示 token 失效。与 Loomy 的裸 `token` 头是两套完全不同的约定。
 */
export async function request(options) {
  const { path, session, method = 'GET', body, timeoutMs = 15_000, fetchImpl = globalThis.fetch } = options
  if (typeof session !== 'string' || session.length < 16) {
    return { kind: 'failure', code: 'no_session', message: '没有可用的登录态' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'account-switcher/1.0',
        Authorization: `Bearer ${session}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failure', code: /abort|timeout|timed out/iu.test(message) ? 'timeout' : 'network', message }
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401) {
    return { kind: 'failure', code: '401', message: '登录已过期，请重新登录小浣熊' }
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    return { kind: 'failure', code: 'network', message: error instanceof Error ? error.message : String(error) }
  }
  let parsed
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    return { kind: 'failure', code: String(response.status), message: text.trim().slice(0, 200) || `HTTP ${response.status}` }
  }
  // 401/401 类业务码也视为失效
  if ([200003, 200009].includes(Number(parsed?.code))) {
    return { kind: 'failure', code: String(parsed.code), message: '登录已失效，请重新登录小浣熊' }
  }
  if (!response.ok) {
    return {
      kind: 'failure',
      code: String(response.status),
      message: String(parsed?.message ?? `HTTP ${response.status}`),
    }
  }
  if (Number(parsed?.code) !== 0) {
    return {
      kind: 'failure',
      code: String(parsed?.code ?? 'unknown'),
      message: String(parsed?.message ?? `业务码 ${parsed?.code}`),
    }
  }
  return { kind: 'ok', data: parsed?.data }
}

/** 账号信息：手机号、昵称、id。 */
export async function fetchIdentity(options) {
  const answer = await request({ ...options, path: '/api/web/auth/v1/user_info' })
  if (answer.kind === 'failure') return answer
  const d = answer.data ?? {}
  return {
    kind: 'ok',
    identity: {
      phone: typeof d.phone === 'string' ? d.phone : '',
      name: typeof d.name === 'string' ? d.name : '',
      userId: d.id === undefined ? '' : String(d.id),
      uuid: typeof d.uuid === 'string' ? d.uuid : '',
    },
  }
}

/**
 * 积分。
 *
 * 走 `GET /api/web/office/v3/setting_info`（客户端自己的设置接口，
 * `getUserSettingInfo()` 就是打它），里面有 `available_points` 与今日问答额度。
 * 实测返回 `available_points: 9873`。
 */
export async function fetchPoints(options) {
  const answer = await request({ ...options, path: '/api/web/office/v3/setting_info' })
  if (answer.kind === 'failure') return answer
  const d = answer.data ?? {}
  const available = asNumber(d.available_points)
  if (available === undefined) {
    return { kind: 'failure', code: 'bad_response', message: '设置接口里没有 available_points（不伪造成 0）' }
  }
  const used = asNumber(d.daily_question_count)
  const limit = asNumber(d.daily_question_limit)
  return {
    kind: 'ok',
    points: {
      available,
      // 副行文案：小浣熊没有 Loomy 那种余额/今日双桶，用今日提问额度代替
      secondary:
        limit === undefined || limit === 0
          ? '今日提问额度不限额'
          : `今日提问 ${used ?? 0}/${limit}`,
      at: options.now?.() ?? Date.now(),
    },
  }
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 对外统一接口
 * ------------------------------------------------------------------ */

/** 一处状态快照，供界面显示。 */
export async function inspect(home = homedir()) {
  const userData = await findUserData(home)
  const appInstalled = await exists(APP_BINARY)
  if (userData === undefined) {
    return { target: TARGET_ID, installed: false, appInstalled, running: false }
  }
  const session = await readSession(userData)
  let identity
  if (session !== undefined) {
    const answer = await fetchIdentity({ session: session.session, timeoutMs: 8_000 })
    identity = answer.kind === 'ok' ? answer.identity : undefined
  }
  return {
    target: TARGET_ID,
    installed: true,
    appInstalled,
    userData,
    authPath: authPathOf(userData),
    running: await isRunning(),
    current:
      session === undefined
        ? undefined
        : {
            session: session.session,
            phone: identity?.phone ?? '',
            name: identity?.name ?? '',
            userid: identity?.userId ?? session.sub ?? '',
            identity: session.identity,
            ...(session.orgName === undefined ? {} : { orgName: session.orgName }),
            ...(session.orgRole === undefined ? {} : { orgRole: session.orgRole }),
            ...(session.issuedAt === undefined ? {} : { issuedAt: session.issuedAt }),
            ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
          },
  }
}

/** 切换：退出 → 备份 → 写 auth.json → 启动 → 等待客户端自己读回来。 */
export async function applySession(session, options = {}) {
  const home = options.home ?? homedir()
  const restart = options.restart !== false
  const steps = []
  const userData = await findUserData(home)
  if (userData === undefined) {
    throw new Error(
      '没有找到小浣熊客户端数据目录：先启动一次客户端（新装机没有 auth.json 也能写，但 profile 目录得先建出来）',
    )
  }

  const backupPath = await backup(userData, home)
  steps.push({ ok: true, text: `已备份登录态 → ${backupPath}` })

  if (await isRunning()) {
    const result = await quit()
    steps.push({
      ok: true,
      text: result.signal === undefined ? `${LABEL} 已退出` : `${LABEL} 已退出（${result.signal}）`,
    })
  } else {
    steps.push({ ok: true, text: `${LABEL} 未运行，跳过退出` })
  }

  const written = await writeSession(userData, session)
  steps.push({
    ok: true,
    text: written.unchanged
      ? 'auth.json 内容已一致，跳过写入（0600 未变）'
      : '已写入 auth.json（明文 JWT，0600）',
  })

  let verify = { ok: true, reason: '跳过重启，下次启动生效' }
  if (restart) {
    await launch()
    steps.push({ ok: true, text: `${LABEL} 已重新启动` })
    verify = await waitForSession(userData, session.session, 30_000)
    steps.push(
      verify.ok
        ? { ok: true, text: `校验通过：客户端当前账号 ${verify.phone ?? '（已读取）'}` }
        : { ok: false, text: `校验未通过：${verify.reason}` },
    )
  }

  return { ok: verify.ok, steps, backupPath, session, verify }
}

async function waitForSession(userData, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastReason = '超时'
  while (Date.now() < deadline) {
    const current = await readSession(userData)
    if (current?.session === expected) {
      // 再确认一次文件没被覆盖（应用启动后可能刷新 token）
      await sleep(800)
      const again = await readSession(userData)
      if (again?.session === expected) {
        const identity = await fetchIdentity({ session: expected, timeoutMs: 8_000 })
        return {
          ok: true,
          ...(identity.kind === 'ok' ? { phone: identity.identity.phone } : {}),
        }
      }
      lastReason = '客户端启动后改写了 token'
    } else if (current !== undefined) {
      lastReason = 'auth.json 里的 token 与目标不一致'
    } else {
      lastReason = 'auth.json 尚未就绪'
    }
    await sleep(700)
  }
  return { ok: false, reason: lastReason }
}

/** 备份 auth.json 与其所在配置目录里的同名文件。 */
async function backup(userData, home = homedir()) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const dir = join(home, '.account-switcher', 'backups', 'raccoon', stamp)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // 配置目录随布局变：新 profile 是 <userData>/agent/config，legacy 是
  // <userData>/config（`~/.box-agent/config`）。用 auth.json 的位置推导，
  // 避免在 legacy 装机上备份到一个不存在的地方
  const configDir = dirname(authPathOf(userData))
  for (const name of ['auth.json', 'config.yaml', 'model-profiles.json']) {
    try {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(join(configDir, name), join(dir, name))
    } catch {
      // 文件不存在就跳过
    }
  }
  return dir
}

/** 退出登录：清空 token。 */
export async function signOut(options = {}) {
  const home = options.home ?? homedir()
  const userData = await findUserData(home)
  if (userData === undefined) throw new Error('没有找到小浣熊客户端数据目录')
  const backupPath = await backup(userData, home)
  if (await isRunning()) await quit()
  const path = authPathOf(userData)
  // 官方 clearBoxAgentDesktopAuthState() 是直接 unlink，不是写一个空 JSON
  // （写 `{}` 文件也行，但那就不是"官方形状"了，且客户端会认为文件还在）
  const { rm } = await import('node:fs/promises')
  await rm(path, { force: true })
  if (options.restart !== false) await launch()
  return { backupPath, userData, authPath: path }
}
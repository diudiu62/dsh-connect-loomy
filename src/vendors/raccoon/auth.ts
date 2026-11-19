/**
 * 小浣熊登录态发现：**只读**地取桌面端为本地 agent 写下的令牌。
 *
 * 实测布局（macOS，客户端 `2.0.0`，2026-11-17）：
 * `~/Library/Application Support/office-raccoon/agent/config/auth.json`，
 * 内容 `{access_token, office_identity}`。文档里的跨平台位置是
 * `$BOX_AGENT_CONFIG_DIR/auth.json`（默认 `~/.box-agent/config/auth.json`），
 * 所以两条都会试。
 *
 * 设计规则（验收条件，不是偏好）：
 *
 * 1. **永不写入。** 令牌文件属于客户端。刷新会让 refresh token 恰好轮换一次，
 *    插件若刷新而不回写就等于把用户登出；若回写又是在改别人的凭据库。所以本
 *    供应商只读，令牌过期时明确说"已过期"，**不代刷**。
 * 2. **永不打印令牌。** 只暴露 `exp` 和长度。
 * 3. **降级成"未登录"。** 文件缺失/损坏是正常状态：该供应商就不出现在模型
 *    选择器里。
 *
 * 本文件只做协议：候选路径、解析、候选探测。凭据优先级在 `index.ts` 的
 * `resolveCredential` 一处决定。
 *
 * @module dsh-connect-desktop/vendors/raccoon/auth
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CredentialCandidate, CredentialIdentity } from '../../vendor-sdk/contracts.js'

/** 一个候选位置。 */
export interface AuthCandidate {
  path: string
  origin: 'env' | 'default'
}

/** 一次凭据读取的结果。 */
export interface RaccoonAuthSnapshot {
  /** 是否找到了"形状可用"的文档（不看过期）。 */
  found: boolean
  /** 访问令牌。永不打印，永不进任何视图。 */
  token?: string
  /** JWT `exp` 换算的毫秒时间戳；解析不出来时 `undefined`。 */
  expiresAt?: number
  /** `expiresAt` 已过去。 */
  expired?: boolean
  /** `office_identity` 原样（`personal` / `enterprise`）。 */
  identity?: string
  /** `office_org_name`（有则带上）。 */
  orgName?: string
  /** 读的是哪个文件。 */
  sourcePath?: string
  /** 尝试过的每个候选，按顺序（`doctor` 用）。 */
  candidates: readonly AuthCandidate[]
  /** `found` 为 false 时的人类可读原因。 */
  problem?: string
}

/** 客户端在不同版本用过的令牌字段名。 */
const TOKEN_FIELDS = ['access_token', 'token', 'auth_token'] as const

/** 签出时的兜底提示：既要可执行，又要说清插件不代刷。 */
const MISSING_PROBLEM =
  '没有找到小浣熊客户端的登录态文件。请打开「商汤小浣熊」桌面端登录一次，' +
  '然后回到这里点「重新检测」；如果你是在别处登出的（或换过账号），客户端会重写这个文件。'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 枚举候选路径，最具体的在前。
 *
 * `RACCOON_AUTH_FILE` 是**排他替换**：设了它就不再碰任何默认路径，保证钉死
 * 路径的运行不会顺手读到真实凭据。
 */
export function authCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): AuthCandidate[] {
  const pinned = nonEmptyString(env['RACCOON_AUTH_FILE'])
  if (pinned !== undefined) return [{ path: pinned, origin: 'env' }]

  const boxAgentDir = nonEmptyString(env['BOX_AGENT_CONFIG_DIR'])
  const candidates: AuthCandidate[] = []
  const push = (path: string): void => {
    if (!candidates.some((entry) => entry.path === path)) candidates.push({ path, origin: 'default' })
  }

  // 文档里的位置：本地 agent 自己的配置目录。
  if (boxAgentDir !== undefined) push(join(boxAgentDir, 'auth.json'))
  push(join(home, '.box-agent', 'config', 'auth.json'))

  if (process.platform === 'darwin') {
    push(join(home, 'Library', 'Application Support', 'office-raccoon', 'agent', 'config', 'auth.json'))
    push(join(home, 'Library', 'Application Support', 'Raccoon', 'agent', 'config', 'auth.json'))
  } else if (process.platform === 'win32') {
    const appData = nonEmptyString(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    push(join(appData, 'office-raccoon', 'agent', 'config', 'auth.json'))
    push(join(appData, 'Raccoon', 'agent', 'config', 'auth.json'))
  } else {
    const configHome = nonEmptyString(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    push(join(configHome, 'office-raccoon', 'agent', 'config', 'auth.json'))
    push(join(configHome, 'raccoon', 'auth.json'))
  }
  return candidates
}

/** 不校验签名地解出 JWT payload（我们只读 `exp`）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  const payload = parts[1]
  if (payload === undefined) return undefined
  try {
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const document: unknown = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'))
    return isRecord(document) ? document : undefined
  } catch {
    return undefined
  }
}

/** 解析一份 auth 文档。永不抛异常。 */
export function parseAuthDocument(
  text: string,
  now: number = Date.now(),
): Omit<RaccoonAuthSnapshot, 'candidates' | 'sourcePath'> {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { found: false, problem: 'auth.json 不是合法 JSON' }
  }
  if (!isRecord(document)) return { found: false, problem: 'auth.json 结构不是对象' }

  let token: string | undefined
  for (const field of TOKEN_FIELDS) {
    token = nonEmptyString(document[field])
    if (token !== undefined) break
  }
  if (token === undefined) return { found: false, problem: 'auth.json 里没有 access_token/token 字段' }

  const claims = decodeJwtPayload(token)
  const exp = claims?.['exp']
  const expiresAt = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  const identity = nonEmptyString(document['office_identity'])
  const orgName = nonEmptyString(document['office_org_name'])
  return {
    found: true,
    token,
    ...(expiresAt === undefined ? {} : { expiresAt, expired: expiresAt <= now }),
    ...(identity === undefined ? {} : { identity }),
    ...(orgName === undefined ? {} : { orgName }),
  }
}

/** 读第一个存在的候选。永不抛异常。 */
export function readAuth(
  options: { env?: NodeJS.ProcessEnv; home?: string; now?: number } = {},
): RaccoonAuthSnapshot {
  const candidates = authCandidates(options.env, options.home)
  const now = options.now ?? Date.now()
  let problem = MISSING_PROBLEM
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    let text: string
    try {
      text = readFileSync(candidate.path, 'utf8')
    } catch {
      problem = `无法读取 ${candidate.path}`
      continue
    }
    const parsed = parseAuthDocument(text, now)
    return { ...parsed, candidates, sourcePath: candidate.path, ...(parsed.found ? {} : { problem }) }
  }
  return { found: false, candidates, problem }
}

/** 去掉令牌，任何会跨进程/跨端序列化的快照都必须先过这一步。 */
export function redactAuth(snapshot: RaccoonAuthSnapshot): Omit<RaccoonAuthSnapshot, 'token'> {
  const { token: _token, ...rest } = snapshot
  return rest
}

/**
 * 快照里的身份事实，映射成视图用的形状。
 *
 * `office_identity`（`personal` / `enterprise`）当作 `label`：卡片上写
 * "个人版 / 企业版"比写一个内部枚举名更有信息量。
 */
export function authIdentity(snapshot: RaccoonAuthSnapshot): CredentialIdentity | undefined {
  const identity: CredentialIdentity = {
    ...(snapshot.identity === undefined ? {} : { label: snapshot.identity }),
    ...(snapshot.orgName === undefined ? {} : { orgName: snapshot.orgName }),
  }
  return Object.keys(identity).length === 0 ? undefined : identity
}

/**
 * 每个候选文件的状态，给诊断/凭据视图用（"你去哪儿找过、各自什么结论"）。
 *
 * 与 {@link readAuth} 分开：`readAuth` 是"第一个存在的文件说了算"的**决策**路径，
 * 这里只回答"每个候选分别怎么样"，会多读几次磁盘，所以只在渲染卡片时调用。
 */
export function authCandidateStates(
  options: { env?: NodeJS.ProcessEnv; home?: string; now?: number } = {},
): CredentialCandidate[] {
  const now = options.now ?? Date.now()
  return authCandidates(options.env, options.home).map((candidate) => {
    if (!existsSync(candidate.path)) {
      return { path: candidate.path, exists: false, state: 'missing', reason: '文件不存在' }
    }
    let text: string
    try {
      text = readFileSync(candidate.path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { path: candidate.path, exists: true, state: 'unreadable', reason: `无法读取：${code ?? 'unknown'}` }
    }
    const parsed = parseAuthDocument(text, now)
    if (!parsed.found) {
      return { path: candidate.path, exists: true, state: 'invalid_shape', reason: parsed.problem ?? '结构不符合预期' }
    }
    if (parsed.expired === true && parsed.expiresAt !== undefined) {
      return {
        path: candidate.path,
        exists: true,
        state: 'expired',
        reason: `已过期（${new Date(parsed.expiresAt).toISOString()}）`,
      }
    }
    return { path: candidate.path, exists: true, state: 'ok', reason: '已读取' }
  })
}

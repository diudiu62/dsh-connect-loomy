/**
 * 应用自己的账号保险箱。
 *
 * 一份 `accounts.json`（0600）就是全部：加进去的每个账号都只是 session 的
 * 一份副本，谁拿到谁能花积分，所以文件权限与提示都要按凭证对待。切换时
 * 并不是"选一个已登录的账号"，而是把这个账号的 session 写回客户端。
 *
 * @module loomy-switcher/vault
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VERSION = 1

/**
 * 上游签发 session 时带 `expire: 14*24*3600`（见仓库根 `src/routes.ts` 的
 * `SESSION_TTL_DAYS`）。缓存下来的账号不是"永久可用"，过了这个窗口切换过去
 * 只会得到一个 401 的客户端，所以界面必须能提前看出哪条快过期。
 */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** 距离过期不足这么久就标黄提醒。 */
export const EXPIRY_WARN_MS = 48 * 60 * 60 * 1000

/**
 * 账号 id = `target:session 指纹`。
 *
 * 必须带 target：同一个 token 字符串理论上不会跨平台重复，但把平台编进
 * id 之后，`remove(id)` / `markActive(id)` 这类按 id 操作的接口就不可能
 * 误伤另一个平台的记录。也顺带让"同一个人两个平台各一条"这件事成立。
 */
export function accountId(target, session) {
  return createHash('sha256').update(`${target}\u0000${session}`).digest('hex').slice(0, 16)
}

function emptyDocument() {
  return { version: VERSION, accounts: [], activeId: undefined, invite: undefined }
}

/**
 * 把缓存的积分写回账号行时用的规整。
 *
 * 统一形状是 `{available, secondary}`：两个平台的积分模型不一样（Loomy 是
 * 余额/今日/可用三个桶，小浣熊是单一可用值 + 今日提问额度），界面只需要
 * "一个主数字 + 一行说明"，差异在两个 target 的 fetchPoints 里就消化掉了。
 * 老文件里的 `balance/dailyBalance/availableBalance` 会被读成 available，
 * 免得升级后已缓存的数字全丢。
 */
function normalizeCredits(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const at = typeof raw.at === 'number' ? raw.at : undefined
  if (typeof raw.error === 'string' && raw.error.length > 0) {
    return { error: raw.error, ...(at === undefined ? {} : { at }) }
  }
  const available = Number(raw.available ?? raw.availableBalance)
  if (!Number.isFinite(available)) return undefined
  const secondary =
    typeof raw.secondary === 'string'
      ? raw.secondary
      : Number.isFinite(Number(raw.balance)) && Number.isFinite(Number(raw.dailyBalance))
        ? `余额 ${Number(raw.balance)} · 今日 ${Number(raw.dailyBalance)}`
        : undefined
  return {
    available,
    ...(secondary === undefined ? {} : { secondary }),
    ...(at === undefined ? {} : { at }),
    records: Array.isArray(raw.records)
      ? raw.records
          .filter((row) => row !== null && typeof row === 'object')
          .slice(0, 10)
          .map((row) => ({
            description: typeof row.description === 'string' ? row.description : '',
            direction: row.direction === 'credit' ? 'credit' : 'debit',
            points: Number(row.points ?? row.pointsActual) || 0,
            balanceAfter: Number(row.balanceAfter) || 0,
            ...(typeof row.model === 'string' ? { model: row.model } : {}),
            createdAt: Number(row.createdAt) || 0,
          }))
      : [],
  }
}

/**
 * 规整一行存储记录。
 *
 * `target` 缺省为 `loomy`：早期版本只有 Loomy，老文件里没有这个字段，
 * 迁移必须是"读的时候补上"，而不是要求用户重新导入一遍。
 */
function normalizeRow(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.session !== 'string' || raw.session.length < 16) return undefined
  const target = typeof raw.target === 'string' && raw.target.length > 0 ? raw.target : 'loomy'
  // 已有 id 必须保留：它可能来自更早的指纹算法，重算会让外部引用失效
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : accountId(target, raw.session)
  return {
    id,
    target,
    session: raw.session,
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    userid: typeof raw.userid === 'string' ? raw.userid : '',
    label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : undefined,
    ...(typeof raw.name === 'string' && raw.name.length > 0 ? { name: raw.name } : {}),
    // 小浣熊的三件账号级信息（官方的 office_identity / office_org_name /
    // office_org_role）：切换时要原样写回 auth.json，丢了它们企业号会被当成
    // 个人号打开、或者带着上一个账号的组织名。Loomy 的行没有这些字段
    ...(typeof raw.identity === 'string' && raw.identity.length > 0 ? { identity: raw.identity } : {}),
    ...(typeof raw.orgName === 'string' && raw.orgName.length > 0 ? { orgName: raw.orgName } : {}),
    ...(typeof raw.orgRole === 'string' && raw.orgRole.length > 0 ? { orgRole: raw.orgRole } : {}),
    addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
    lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : undefined,
    credentialedAt:
      typeof raw.credentialedAt === 'number'
        ? raw.credentialedAt
        : typeof raw.addedAt === 'number'
          ? raw.addedAt
          : Date.now(),
    ...(typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? { expiresAt: raw.expiresAt } : {}),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    credits: normalizeCredits(raw.credits),
  }
}

/** 打开保险箱；文件损坏时返回空文档而不是抛错（界面要能自我修复）。 */
export async function openVault(filePath) {
  let document = emptyDocument()
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
      document = {
        version: VERSION,
        accounts: parsed.accounts.map(normalizeRow).filter((row) => row !== undefined),
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : undefined,
        invite:
          parsed.invite !== null && typeof parsed.invite === 'object' && Array.isArray(parsed.invite.codes)
            ? parsed.invite
            : undefined,
      }
    }
  } catch {
    // 首次运行或文件损坏
  }

  const save = async () => {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const temp = `${filePath}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(document, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, filePath)
  }

  return {
    /** 界面用的视图：不含 session。 */
    list() {
      return {
        accounts: document.accounts
          .slice()
          .sort((left, right) => (right.lastUsedAt ?? right.addedAt) - (left.lastUsedAt ?? left.addedAt))
          .map(publicView),
        activeId: document.activeId,
      }
    },

    get(id) {
      return document.accounts.find((row) => row.id === id)
    },

    /**
     * 导入一批登录态；按 (target, session) 去重，返回新增/更新计数。
     *
     * `target` 缺省取 `defaultTarget`，让早期版本的调用点（只有 Loomy）
     * 继续工作而不必改所有调用者。
     */
    async upsert(sessions, options = {}) {
      let added = 0
      let updated = 0
      for (const session of sessions) {
        const target = session.target ?? options.target ?? 'loomy'
        const id = accountId(target, session.session)
        const existing = document.accounts.find((row) => row.id === id)
        const now = Date.now()
        if (existing === undefined) {
          document.accounts.push({
            id,
            target,
            session: session.session,
            phone: session.phone,
            userid: session.userid,
            ...(typeof session.name === 'string' && session.name.length > 0 ? { name: session.name } : {}),
            ...(typeof session.identity === 'string' && session.identity.length > 0
              ? { identity: session.identity }
              : {}),
            ...(typeof session.orgName === 'string' && session.orgName.length > 0
              ? { orgName: session.orgName }
              : {}),
            ...(typeof session.orgRole === 'string' && session.orgRole.length > 0
              ? { orgRole: session.orgRole }
              : {}),
            addedAt: now,
            // 这份 session 是"现在拿到的"，过期时间从此刻算起
            credentialedAt: now,
            // 平台自己给了过期时间（小浣熊的 JWT 带 exp）就用它
            ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
          })
          added += 1
        } else {
          existing.phone = session.phone || existing.phone
          existing.userid = session.userid || existing.userid
          if (typeof session.identity === 'string' && session.identity.length > 0) {
            existing.identity = session.identity
          }
          if (typeof session.orgName === 'string') existing.orgName = session.orgName || existing.orgName
          if (typeof session.orgRole === 'string') existing.orgRole = session.orgRole || existing.orgRole
          if (session.expiresAt !== undefined) existing.expiresAt = session.expiresAt
          // 重复导入同一 session 不应刷新过期时间：它就是同一张票，
          // 上游的有效期不会因为我们又贴了一次而延长。只有 session 变了
          // （新登录拿到的）才算刷新。这里 id 就是 (target, session) 的指纹，
          // 所以走更新分支的必然是同一张票。
          updated += 1
        }
      }
      await save()
      return { added, updated }
    },

    async rename(id, label) {
      const row = document.accounts.find((entry) => entry.id === id)
      if (row === undefined) throw new Error('账号不存在')
      const trimmed = String(label ?? '').trim().slice(0, 24)
      row.label = trimmed.length === 0 ? undefined : trimmed
      await save()
      return publicView(row)
    },

    async remove(id) {
      const before = document.accounts.length
      document.accounts = document.accounts.filter((row) => row.id !== id)
      if (document.activeId === id) document.activeId = undefined
      if (document.accounts.length !== before) await save()
      return { removed: before - document.accounts.length }
    },

    async markActive(id) {
      document.activeId = id
      const row = document.accounts.find((entry) => entry.id === id)
      if (row !== undefined) {
        row.lastUsedAt = Date.now()
        // 切换成功 → 这张票现在被证明是好的，清掉历史错误
        row.lastError = undefined
      }
      await save()
    },

    /**
     * 记录一次切换失败。
     *
     * 缓存账号最容易踩的坑不是"切不过去"，而是"切过去了但对方已失效"——
     * 用户看到客户端停在登录页却不知道为什么。把错误钉在账号行上，下次打开
     * 界面就知道该换哪一条。
     */
    async markFailure(id, message) {
      const row = document.accounts.find((entry) => entry.id === id)
      if (row === undefined) return
      row.lastError = String(message).slice(0, 200)
      await save()
    },

    /**
     * 带 session 的账号列表：**只给主进程内部用**（批量刷新积分要拿 session
     * 去打上游）。绝不要把这个返回值放进任何发往渲染进程的 payload。
     */
    secretList(target) {
      return document.accounts
        .filter((row) => target === undefined || row.target === target)
        .map((row) => ({
          id: row.id,
          target: row.target,
          session: row.session,
          phone: row.phone,
          userid: row.userid,
        }))
    },

    /** 当前 active 账号（带 session），没有就退回最近使用的第一条。 */
    activeSecret(target) {
      const pool = document.accounts.filter((row) => target === undefined || row.target === target)
      const active = pool.find((row) => row.id === document.activeId)
      if (active !== undefined) {
        return { id: active.id, target: active.target, session: active.session, phone: active.phone }
      }
      const first = pool
        .slice()
        .sort((left, right) => (right.lastUsedAt ?? right.addedAt) - (left.lastUsedAt ?? left.addedAt))[0]
      return first === undefined
        ? undefined
        : { id: first.id, target: first.target, session: first.session, phone: first.phone }
    },

    /** 把一次积分查询的结果钉在账号上（成功或失败都记，失败也要能看见）。 */
    async setCredits(id, credits) {
      const row = document.accounts.find((entry) => entry.id === id)
      if (row === undefined) return
      const normalized = normalizeCredits({ ...credits, at: credits.at ?? Date.now() })
      row.credits = normalized
      await save()
    },

    /** 缓存邀请码信息（不按账号拆分：通常只看当前账号）。 */
    async setInvite(invite) {
      document.invite = { ...invite, fetchedAt: invite.fetchedAt ?? Date.now() }
      await save()
    },

    /** 账号库里每条账号各自的积分快照（视图侧已经挂在 account.credits 上）。 */
    creditsSummary() {
      return document.accounts
        .filter((row) => row.credits !== undefined)
        .map((row) => ({ id: row.id, phone: row.phone, credits: row.credits }))
    },

    invite() {
      return document.invite
    },

    /** 导出的 bundle 与 DSH 插件同格式，可互相粘贴。 */
    exportBundle() {
      return {
        kind: 'dsh-connect-loomy/accounts',
        version: 1,
        exportedAt: Date.now(),
        accounts: document.accounts.map((row, index) => ({
          slot: index + 1,
          target: row.target,
          session: row.session,
          ...(row.phone.length > 0 ? { phone: row.phone } : {}),
          ...(row.userid.length > 0 ? { userId: row.userid } : {}),
          ...(row.label === undefined ? {} : { label: row.label }),
          addedAt: row.addedAt,
        })),
      }
    },
  }
}

/**
 * 界面视图。
 *
 * **手机号与 userid 给明文**：这是用户自己的本机工具，账号本来就归他所有，
 * 遮成 `171****2846` 只会让他分不清"工作号"和"个人号"到底哪一个是哪个，
 * 尤其几个号前七位相同时（实测账号库里有一堆 `1651634xxxx` / `1629232xxxx`）。
 *
 * 唯一保留的脱敏对象是 **session** —— 它是可直接消费的凭据（谁拿到谁能花
 * 积分），而手机号/userid 只是标识符。所以这里没有任何 session 字段，
 * 只给末 6 位用于人工比对。
 */
function publicView(row) {
  return {
    id: row.id,
    target: row.target,
    phone: row.phone,
    userid: row.userid,
    ...(row.name === undefined ? {} : { name: row.name }),
    label: row.label,
    addedAt: row.addedAt,
    lastUsedAt: row.lastUsedAt,
    credentialedAt: row.credentialedAt,
    // 平台自己给了过期时间（小浣熊 JWT 的 exp）就信平台；否则按已知 TTL 推算
    expiresAt: row.expiresAt ?? row.credentialedAt + SESSION_TTL_MS,
    expiresInMs: (row.expiresAt ?? row.credentialedAt + SESSION_TTL_MS) - Date.now(),
    lastError: row.lastError,
    credits: row.credits,
    sessionTail: row.session.slice(-6),
  }
}

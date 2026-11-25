/**
 * The one account store, shared by every vendor.
 *
 * Before this module each vendor had its own: one `async` with a TTL cache, one
 * synchronous, one assigning `slot` numbers, one using opaque ids. They agreed
 * on nothing, so the pool, the card and the export format each needed two
 * implementations.
 *
 * The differences that remain are **policy**, expressed as options:
 *
 * - `routeMode: 'slots'` — every account gets its own provider route
 *   (`loomy`, `loomy-2`, …), so a conversation stays bound to one account.
 * - `routeMode: 'single'` — one route for every account (`raccoon`); which
 *   account pays is decided per call.
 * - `desktop` — a reader for the desktop client's own sign-in. It appears as a
 *   pool member and as the fallback identity, never as a stored row.
 *
 * @module dsh-connect-desktop/core/accounts
 */

import { createHash, randomUUID } from 'node:crypto'
import type { AccountBenchVerdict, AccountDriver, AccountInput, DocumentStore, StoredAccount } from '../vendor-sdk/contracts.js'
import { isRecord } from '../shared/text.js'
import { DEFAULT_POOL_COOLDOWN_MS, RATE_LIMIT_CODE, classifyUnavailable, pointsCooldownMs, rateLimitCooldownMs } from './pool.js'

/** The synthetic id of the desktop client's own sign-in. */
export const DESKTOP_ACCOUNT_ID = 'desktop'

/** One new per-account device identity, shaped like the official client's uuid. */
function newDeviceId(): string {
  return randomUUID()
}

/** One persisted account. Contains the session; the file is `0600`. */
export interface AccountRecord {
  id: string
  /** Stable per-account route number; only used by `routeMode: 'slots'`. */
  slot?: number
  material: string
  label?: string
  phone?: string
  userId?: string
  origin: 'plugin' | 'desktop'
  addedAt?: number
  /** Per-account device identity (uuid); see `StoredAccount.deviceId`. */
  deviceId?: string
  unavailableAt?: number
  /** 这次禁用的解禁时刻（失败时定死，随记录持久化）。 */
  unavailableUntil?: number
  /** 连续限流命中次数（限流阶梯的档位）；成功一次就清空。 */
  unavailableStreak?: number
  unavailableCode?: string
  unavailableMessage?: string
}

/** The accounts document. */
export interface AccountsDocument {
  version: 1
  accounts: AccountRecord[]
}

export function emptyAccountsDocument(): AccountsDocument {
  return { version: 1, accounts: [] }
}

function isRecordAccount(value: unknown): value is AccountRecord {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || value.id.length === 0) return false
  if (typeof value.material !== 'string' || value.material.length === 0) return false
  if (value.origin !== 'plugin' && value.origin !== 'desktop') return false
  return true
}

export function parseAccountsDocument(text: string): AccountsDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyAccountsDocument()
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.accounts)) return emptyAccountsDocument()
  const accounts = parsed.accounts.filter(isRecordAccount).map((account) => ({ ...account }))
  return { version: 1, accounts }
}

export function serializeAccountsDocument(document: AccountsDocument): string {
  const accounts = document.accounts.map((account) => ({
    id: account.id,
    ...(account.slot === undefined ? {} : { slot: account.slot }),
    material: account.material,
    ...(account.label === undefined ? {} : { label: account.label }),
    ...(account.phone === undefined ? {} : { phone: account.phone }),
    ...(account.userId === undefined ? {} : { userId: account.userId }),
    ...(account.deviceId === undefined ? {} : { deviceId: account.deviceId }),
    origin: account.origin,
    ...(account.addedAt === undefined ? {} : { addedAt: account.addedAt }),
    ...(account.unavailableAt === undefined ? {} : { unavailableAt: account.unavailableAt }),
    ...(account.unavailableUntil === undefined ? {} : { unavailableUntil: account.unavailableUntil }),
    ...(account.unavailableStreak === undefined ? {} : { unavailableStreak: account.unavailableStreak }),
    ...(account.unavailableCode === undefined ? {} : { unavailableCode: account.unavailableCode }),
    ...(account.unavailableMessage === undefined ? {} : { unavailableMessage: account.unavailableMessage }),
  }))
  return `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`
}

/** Stable fingerprint of a session material, used for de-duplication. */
export function materialKey(material: string): string {
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/** What the desktop client currently has signed in. */
export interface DesktopIdentity {
  material?: string
  phone?: string
  userId?: string
  label?: string
  /** Epoch ms of the credential change, when the vendor can tell. */
  loginAt?: number
}

export interface AccountsStoreOptions {
  document: DocumentStore<AccountsDocument>
  /** Base provider route id (`loomy`, `raccoon`). */
  routeBase: string
  /** `slots` gives every account its own route; `single` gives one route for all. */
  routeMode: 'slots' | 'single'
  /** Display name for the base route. */
  displayName: string
  /**
   * The desktop client's own sign-in. Returned as a synthetic account by
   * `list({ includeDesktop: true })` and used as the fallback identity.
   */
  desktop?: () => Promise<DesktopIdentity | undefined>
  /**
   * 从会话材料补出身份信息（**只用于展示，不落盘**）。
   *
   * 为什么需要它：早先写入的账号可能没有 `phone`/`userId`（上游当时没回号码，
   * 或者 label 被错误地写成了身份类型）。那种账号在界面上只能显示「账号 3」。
   * 供应商如果能从 token 里解出稳定标识（小浣熊的 JWT 有 `sub`），就应该补出来——
   * 这比序号有用得多，而且不需要重写用户数据。
   */
  describeMaterial?: (material: string) => { userId?: string; phone?: string } | undefined
  /** 池的基础冷却窗口（限流阶梯从它起步）；缺省用 `DEFAULT_POOL_COOLDOWN_MS`。 */
  cooldownMs?: () => number
  now?: () => number
}

/** The store plus the route bookkeeping the registry needs. */
export interface AccountsStore extends AccountDriver {
  /** Route list for the picker, given the pool preference. */
  routes(options: { poolEnabled: boolean }): Promise<Array<{ route: string; displayName: string; origin: 'plugin' | 'desktop'; slot: number }>>
  /** Accounts the pool may pick from, including the desktop identity. */
  poolCandidates(): Promise<StoredAccount[]>
  /** One account by id (stored or desktop). */
  find(id: string): Promise<StoredAccount | undefined>
  /**
   * 给还没有设备标识的账号补一个（一次性迁移，幂等）。
   *
   * 官方客户端一次安装生成一个 `clientDeviceId`；插件接管的账号各自要有一个，
   * 否则 N 个账号共用同一个设备指纹，正是上游风控眼里的"异常调用"画像。
   * `list()` 会自动调它，所以旧的账号文件在第一次读取后就被补齐。
   */
  ensureDeviceIds(): Promise<number>
  /**
   * 写回从上游查到的身份（只补缺失字段）。
   *
   * 与 `describeMaterial` 的分工：那个是每次 `list()` 现算的只读补全；这个是真的
   * 落盘，用于"这条账号原本没存号码，现在查到了"的一次性修复。
   */
  setIdentity(id: string, identity: { phone?: string; userId?: string; label?: string }): Promise<void>
  readonly path: string
}

export function createAccountsStore(options: AccountsStoreOptions): AccountsStore {
  const now = options.now ?? (() => Date.now())
  /** The vendor's base cooldown window, read live so a config change applies at once. */
  const baseCooldownMs = (): number => {
    const value = options.cooldownMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : rateLimitCooldownMs(1)
  }
  let cache: AccountsDocument | undefined
  let cacheAt = 0
  /** Serialise read-modify-write so two writes cannot drop an account. */
  let queue: Promise<void> = Promise.resolve()

  const load = async (force = false): Promise<AccountsDocument> => {
    if (!force && cache !== undefined && now() - cacheAt < 1_000) return cache
    cache = await options.document.load()
    cacheAt = now()
    return cache
  }

  const mutate = async (change: (document: AccountsDocument) => AccountsDocument): Promise<AccountsDocument> => {
    const run = queue.then(async () => {
      const current = await load(true)
      const next = change({ version: 1, accounts: current.accounts.map((account) => ({ ...account })) })
      await options.document.save(next)
      cache = next
      cacheAt = now()
      return next
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const routeFor = (account: AccountRecord): string => {
    if (options.routeMode === 'single') return options.routeBase
    const slot = account.slot ?? 1
    return slot === 1 ? options.routeBase : `${options.routeBase}-${slot}`
  }

  const displayNameFor = (account: AccountRecord): string => {
    if (options.routeMode === 'single') return options.displayName
    const slot = account.slot ?? 1
    return slot === 1 ? options.displayName : `${options.displayName} · ${slot}`
  }

  const toStored = (account: AccountRecord): StoredAccount => ({
    id: account.id,
    material: account.material,
    origin: account.origin,
    ...(account.label === undefined ? {} : { label: account.label }),
    ...(account.phone === undefined ? {} : { phone: account.phone }),
    ...(account.userId === undefined ? {} : { userId: account.userId }),
    ...(account.deviceId === undefined ? {} : { deviceId: account.deviceId }),
    ...(account.addedAt === undefined ? {} : { addedAt: account.addedAt }),
    ...(account.unavailableAt === undefined ? {} : { unavailableAt: account.unavailableAt }),
    ...(account.unavailableUntil === undefined ? {} : { unavailableUntil: account.unavailableUntil }),
    ...(account.unavailableStreak === undefined ? {} : { unavailableStreak: account.unavailableStreak }),
    ...(account.unavailableCode === undefined ? {} : { unavailableCode: account.unavailableCode }),
    ...(account.unavailableMessage === undefined ? {} : { unavailableMessage: account.unavailableMessage }),
  })

  const desktopAccount = async (): Promise<StoredAccount | undefined> => {
    if (options.desktop === undefined) return undefined
    const identity = await options.desktop()
    if (identity === undefined || identity.material === undefined) return undefined
    return {
      id: DESKTOP_ACCOUNT_ID,
      material: identity.material,
      origin: 'desktop',
      ...(identity.phone === undefined ? {} : { phone: identity.phone }),
      ...(identity.userId === undefined ? {} : { userId: identity.userId }),
      ...(identity.label === undefined ? {} : { label: identity.label }),
      ...(identity.loginAt === undefined ? {} : { addedAt: identity.loginAt }),
    }
  }

  /** 补出缺失的展示用身份（不改变落盘数据）。 */
  const withDerivedIdentity = (
    account: AccountRecord,
    describe: (material: string) => { userId?: string; phone?: string } | undefined,
  ): AccountRecord => {
    if (account.userId !== undefined && account.phone !== undefined) return account
    let derived: { userId?: string; phone?: string } | undefined
    try {
      derived = describe(account.material)
    } catch {
      derived = undefined
    }
    if (derived === undefined) return account
    return {
      ...account,
      ...(account.userId === undefined && derived.userId !== undefined ? { userId: derived.userId } : {}),
      ...(account.phone === undefined && derived.phone !== undefined ? { phone: derived.phone } : {}),
    }
  }

  const nextSlot = (accounts: readonly AccountRecord[]): number => {
    const used = new Set(accounts.map((account) => account.slot ?? 0))
    let slot = 1
    while (used.has(slot)) slot += 1
    return slot
  }

  /**
   * 补齐缺失的设备标识；返回补了几条。
   *
   * 幂等：已经有的账号一律不动（重装/重登不该换设备标识，官方客户端也是这样——
   * 文件在安装期生成一次）。
   */
  const seedDeviceIds = async (): Promise<AccountsDocument> => {
    return mutate((current) => {
      for (const account of current.accounts) {
        if (account.deviceId === undefined || account.deviceId.length === 0) account.deviceId = newDeviceId()
      }
      return current
    })
  }

  return {
    path: options.document.path,

    async list(listOptions = {}) {
      let document = await load(listOptions.force === true)
      // 旧账号文件没有 deviceId：第一次读取就补齐（幂等，写一次磁盘）。
      if (document.accounts.some((account) => account.deviceId === undefined)) {
        document = await seedDeviceIds()
      }
      return [...document.accounts]
        .map((account) => (options.describeMaterial === undefined ? account : withDerivedIdentity(account, options.describeMaterial)))
        .sort((left, right) => (left.slot ?? 0) - (right.slot ?? 0) || (left.addedAt ?? 0) - (right.addedAt ?? 0))
        .map(toStored)
    },

    async find(id) {
      if (id === DESKTOP_ACCOUNT_ID) return desktopAccount()
      const document = await load()
      const match = document.accounts.find((account) => account.id === id)
      return match === undefined ? undefined : toStored(match)
    },

    async active() {
      const document = await load()
      return document.accounts.length === 0 ? undefined : (document.accounts[0] as AccountRecord).id
    },

    async setActive(_id) {
      // Selection lives in the state document, not here: it is a preference,
      // and `routeMode: 'single'` vendors resolve it in their credential driver.
    },

    async add(input: AccountInput) {
      const material = input.kind === 'desktop' ? (await options.desktop?.())?.material : input.material
      if (material === undefined || material.length === 0) {
        throw new Error('该账号没有可用的登录态')
      }
      const key = materialKey(material)
      let replaced = false
      const document = await mutate((current) => {
        const existing = current.accounts.find((account) => materialKey(account.material) === key)
        if (existing !== undefined) {
          replaced = true
          existing.material = material
          if (input.kind === 'credentials') {
            if (input.label !== undefined) existing.label = input.label
            if (input.phone !== undefined) existing.phone = input.phone
            if (input.userId !== undefined) existing.userId = input.userId
          }
          if (existing.deviceId === undefined) existing.deviceId = newDeviceId()
          return current
        }
        const account: AccountRecord = {
          id: `${options.routeBase}-${now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          material,
          origin: input.kind === 'desktop' ? 'desktop' : 'plugin',
          addedAt: now(),
          deviceId: newDeviceId(),
          ...(input.kind === 'credentials' && input.label !== undefined ? { label: input.label } : {}),
          ...(input.kind === 'credentials' && input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.kind === 'credentials' && input.userId !== undefined ? { userId: input.userId } : {}),
          ...(options.routeMode === 'slots' ? { slot: nextSlot(current.accounts) } : {}),
        }
        current.accounts.push(account)
        return current
      })
      const account = document.accounts.find((entry) => materialKey(entry.material) === key)
      return { id: account?.id ?? '', replaced }
    },

    async remove(id) {
      await mutate((current) => {
        current.accounts = current.accounts.filter((account) => account.id !== id)
        return current
      })
    },

    async rename(id, label) {
      await mutate((current) => {
        const match = current.accounts.find((account) => account.id === id)
        if (match !== undefined) match.label = label
        return current
      })
    },

    /**
     * 补全一个账号的身份字段。
     *
     * 导入的账号只有一个 token（导出包里没有手机号），所以账号行只能显示「账号 3」。
     * 供应商可以用自己的接口把这个缺失补上；**空字符串视为"不覆盖"**，避免一次
     * 失败的远端查询把已有的手机号抹掉。
     */
    async update(id, patch) {
      await mutate((current) => {
        const match = current.accounts.find((account) => account.id === id)
        if (match === undefined) return current
        if (patch.label !== undefined && patch.label.length > 0) match.label = patch.label
        if (patch.phone !== undefined && patch.phone.length > 0) match.phone = patch.phone
        if (patch.userId !== undefined && patch.userId.length > 0) match.userId = patch.userId
        return current
      })
    },

    /**
     * 写回从上游查到的身份（手机号 / userId / 昵称）。
     *
     * 与 `describeMaterial` 的区别：那个是**只读的展示层补全**（每次 list 现算），
     * 这个是真的落盘——用于"这条账号原本没存号码，现在查到了"的一次性修复。
     * 只写传入且尚缺的字段，不覆盖已有的。
     */
    async setIdentity(id, identity) {
      if (id === DESKTOP_ACCOUNT_ID) return
      await mutate((current) => {
        const match = current.accounts.find((account) => account.id === id)
        if (match === undefined) return current
        if (identity.phone !== undefined && match.phone === undefined) match.phone = identity.phone
        if (identity.userId !== undefined && match.userId === undefined) match.userId = identity.userId
        if (
          identity.label !== undefined &&
          identity.label.length > 0 &&
          (match.label === undefined || match.label.length === 0)
        ) {
          match.label = identity.label
        }
        return current
      })
    },

    /**
     * 记一次失败，并返回这次实际生效的冷却窗口。
     *
     * 普通失败（401、额度）用基础窗口；**限流（`RATE_LIMIT`）走指数阶梯**：
     * 上一次失败还没出冷却就再次命中 → 窗口翻倍，封顶六小时。连续命中说明
     * 上游风控（如小浣熊 `200108`「异常调用」）没有解除，反复去试只会把限制
     * 一次次加深。窗口从"这次失败的落点在上次窗口的第几级"推导（见
     * `core/pool.ts`），不用给账号表加迁移列。
     */
    async markUnavailable(id, code, message): Promise<AccountBenchVerdict | undefined> {
      if (id === DESKTOP_ACCOUNT_ID) return undefined
      const at = now()
      let windowMs = baseCooldownMs()
      let recoverAt = at + windowMs
      await mutate((current) => {
        const match = current.accounts.find((account) => account.id === id)
        if (match === undefined) return current
        const previousUntil = match.unavailableUntil
        match.unavailableAt = at
        match.unavailableCode = code
        match.unavailableMessage = message
        if (code === RATE_LIMIT_CODE) {
          /*
           * 窗口在失败那一刻定死，并把连续命中次数一起落盘：
           *
           * - 上次的禁用还没到期就再次命中 → 档位 +1（风控没解除，别指望立刻好）；
           * - 上次已到期/没有记录 → 重新从第一级开始（这次是新的一次限流）。
           *
           * 重启不会把一个还被限制的账号放回池里——档位和解禁时刻都在文件里。
           */
          const stillBenched = previousUntil !== undefined && at < previousUntil
          const streak = (stillBenched ? (match.unavailableStreak ?? 1) : 0) + 1
          match.unavailableStreak = streak
          windowMs = rateLimitCooldownMs(streak, baseCooldownMs())
          match.unavailableUntil = at + windowMs
          recoverAt = at + windowMs
        } else if (classifyUnavailable(code, message) === 'points') {
          /*
           * 额度用光：窗口比普通失败长，但照样"在失败那一刻定死并落盘"。
           *
           * 两个都要：不落盘的话，重启就把一个零余额账号放回池里；写基础窗口的话，
           * 它会每十分钟被挑一次、烧一次必然失败的调用。解禁主路径是"读到余额
           * 又大于 0 时 markHealthy"（见 `core/credits.ts#applyZeroPoints`）。
           */
          delete match.unavailableStreak
          windowMs = pointsCooldownMs()
          match.unavailableUntil = at + windowMs
          recoverAt = at + windowMs
        } else {
          delete match.unavailableUntil
          delete match.unavailableStreak
        }
        return current
      })
      return { cooldownMs: windowMs, recoverAt }
    },

    async markHealthy(id) {
      if (id === DESKTOP_ACCOUNT_ID) return
      await mutate((current) => {
        const match = current.accounts.find((account) => account.id === id)
        if (match === undefined) return current
        delete match.unavailableAt
        delete match.unavailableUntil
        delete match.unavailableStreak
        delete match.unavailableCode
        delete match.unavailableMessage
        return current
      })
    },

    routeOf(account) {
      if (account.origin === 'desktop') return options.routeBase
      const record = cache?.accounts.find((entry) => entry.id === account.id)
      return record === undefined ? options.routeBase : routeFor(record)
    },

    displayNameOf(account) {
      if (account.origin === 'desktop') return options.displayName
      const record = cache?.accounts.find((entry) => entry.id === account.id)
      return record === undefined ? options.displayName : displayNameFor(record)
    },

    async exportBundle() {
      const document = await load(true)
      return {
        bundle: {
          kind: 'dsh-connect-desktop/accounts',
          version: 1,
          vendor: options.routeBase,
          exportedAt: now(),
          accounts: document.accounts.map((account) => ({
            id: account.id,
            material: account.material,
            ...(account.label === undefined ? {} : { label: account.label }),
            ...(account.phone === undefined ? {} : { phone: account.phone }),
            ...(account.userId === undefined ? {} : { userId: account.userId }),
            addedAt: account.addedAt,
          })),
        },
      }
    },

    async importBundle(document) {
      const entries = entriesOf(document)
      let added = 0
      let refreshed = 0
      let skipped = 0
      await mutate((current) => {
        for (const entry of entries) {
          const key = materialKey(entry.material)
          const existing = current.accounts.find((account) => materialKey(account.material) === key)
          if (existing !== undefined) {
            existing.material = entry.material
            if (entry.label !== undefined) existing.label = entry.label
            refreshed += 1
            continue
          }
          if (entry.material.length === 0) {
            skipped += 1
            continue
          }
          current.accounts.push({
            id: entry.id ?? `${options.routeBase}-${now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
            material: entry.material,
            origin: 'plugin',
            addedAt: now(),
            deviceId: newDeviceId(),
            ...(entry.label === undefined ? {} : { label: entry.label }),
            ...(entry.phone === undefined ? {} : { phone: entry.phone }),
            ...(entry.userId === undefined ? {} : { userId: entry.userId }),
            ...(options.routeMode === 'slots' ? { slot: nextSlot(current.accounts) } : {}),
          })
          added += 1
        }
        return current
      })
      return { added, refreshed, skipped }
    },

    async routes(routeOptions) {
      const document = await load(true)
      /**
       * `single`：路由集合与账号数量**无关**。
       *
       * 每个账号都映射到同一个 `routeBase`，所以"逐账号 map"会产出 N 条 id
       * 完全相同的条目；宿主的 `registerAdapter` 拿到重复 id 只会抱怨，选择器
       * 里则表现为同一个分组挂了 N 遍。这里直接返回那一条，origin 取第一个
       * 账号（没有账号时仍是桌面登录态）。
       */
      if (options.routeMode === 'single') {
        const first = document.accounts[0]
        return [{ route: options.routeBase, displayName: options.displayName, origin: first?.origin ?? 'desktop', slot: 1 }]
      }
      const entries = document.accounts
        .slice()
        .sort((left, right) => (left.slot ?? 0) - (right.slot ?? 0) || (left.addedAt ?? 0) - (right.addedAt ?? 0))
        .map((record) => ({
          route: routeFor(record),
          displayName: displayNameFor(record),
          origin: record.origin,
          slot: record.slot ?? 1,
        }))
      if (routeOptions.poolEnabled && entries.length > 1 && options.routeMode === 'slots') {
        entries.push({
          route: `${options.routeBase}-pool`,
          displayName: `${options.displayName} · 随机池`,
          origin: 'plugin',
          slot: 0,
        })
      }
      if (entries.length === 0) {
        entries.push({ route: options.routeBase, displayName: options.displayName, origin: 'desktop', slot: 1 })
      }
      return entries
    },

    async poolCandidates() {
      const document = await load(true)
      const stored = document.accounts.map(toStored)
      const desktop = await desktopAccount()
      return desktop === undefined ? stored : [...stored, desktop]
    },

    async ensureDeviceIds() {
      const before = await load(true)
      const missing = before.accounts.filter((account) => account.deviceId === undefined || account.deviceId.length === 0)
      if (missing.length === 0) return 0
      await seedDeviceIds()
      return missing.length
    },
  }
}

interface BundleEntry {
  id?: string
  material: string
  label?: string
  phone?: string
  userId?: string
}

/**
 * 认得出"登录态"的字段名。
 *
 * 为什么包含 snake_case：用户最自然的导入动作是**直接把客户端自己的
 * `auth.json` 粘进来**，那份文件里是 `access_token`（小浣熊 `boxAgentAuthFile.js`
 * 的写入契约）。只认 camelCase 的 `accessToken` 时，粘贴会"成功返回 0 条"——
 * 没有错误、也没有账号，最难排查的一类静默失败。
 */
const MATERIAL_FIELDS = ['material', 'session', 'token', 'accessToken', 'access_token', 'auth_token'] as const

/** 从一份文档里取出登录态；`Bearer ` 前缀会被剥掉（有些人连请求头一起粘）。 */
function pickMaterial(value: Record<string, unknown>): string | undefined {
  for (const field of MATERIAL_FIELDS) {
    const candidate = value[field]
    if (typeof candidate !== 'string') continue
    const material = candidate.trim().replace(/^Bearer\s+/iu, '').trim()
    if (material.length > 0) return material
  }
  return undefined
}

/** Accept our own bundle, a bare array, or one desktop `auth-session.json`. */
function entriesOf(document: unknown): BundleEntry[] {
  const entries: BundleEntry[] = []
  const push = (value: Record<string, unknown>): void => {
    const material = pickMaterial(value)
    if (material === undefined) return
    entries.push({
      material,
      ...(typeof value['id'] === 'string' ? { id: value['id'] } : {}),
      ...(typeof value['label'] === 'string' ? { label: value['label'] } : {}),
      ...(typeof value['phone'] === 'string' ? { phone: value['phone'] } : {}),
      ...(typeof value['userId'] === 'string' ? { userId: value['userId'] } : {}),
    })
  }
  if (Array.isArray(document)) {
    for (const entry of document) if (isRecord(entry)) push(entry)
    return entries
  }
  if (!isRecord(document)) return entries
  const nested = document['accounts']
  if (Array.isArray(nested)) {
    for (const entry of nested) if (isRecord(entry)) push(entry)
    return entries
  }
  const wrapped = document['bundle']
  if (isRecord(wrapped)) return entriesOf(wrapped)
  push(document)
  return entries
}

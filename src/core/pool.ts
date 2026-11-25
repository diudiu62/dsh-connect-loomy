/**
 * The account pool: pick a usable account per call, at random, and remember
 * which ones refused so the next call skips them.
 *
 * Why opt-in: routing a call to an account the user did not pick makes billing
 * unpredictable, so rotation is an explicit choice. Per-account routes (when the
 * vendor has them) stay exactly as they were.
 *
 * Selection rules:
 * - candidates are the accounts **not** in cooldown;
 * - the choice is uniform random among them (not round-robin: concurrent calls
 *   must not all land on the same account just because it was "next");
 * - when every account is benched the least-recently-failed one is reported as
 *   `none-healthy` and the caller decides, instead of silently spending an
 *   account the user was told is unusable.
 *
 * Cooldown policy (why `markUnavailable` can raise the window): a plain rate
 * limit recovers in minutes, but the upstream account-level risk control
 * (Raccoon `429 code 200108` 「异常调用」) persists — hitting a restricted
 * account again only re-confirms the restriction. `rateLimitCooldownMs`
 * therefore grows **exponentially with consecutive RATE_LIMIT hits** and is
 * persisted by the account store alongside the failure record, so a DSH
 * restart does not forget how restricted an account is.
 *
 * @module dsh-connect-desktop/core/pool
 */

import type { AccountBenchVerdict, AccountDriver, StoredAccount } from '../vendor-sdk/contracts.js'

/** Failure code used when an account has no spendable points left. */
export const NO_POINTS_CODE = 'no_points'

/** How long an account stays out of rotation after an ordinary failure. */
export const DEFAULT_POOL_COOLDOWN_MS = 10 * 60 * 1000

/**
 * 额度用光（积分不足）的冷却窗口。
 *
 * 为什么和限流分开：限流等十分钟会自己好，**额度不会**——它要等到充值或上游的
 * 每日额度刷新。共用基础窗口意味着一个零余额账号每十分钟被挑中一次、每次白烧
 * 一次必然失败的调用（用户看到的是"轮换又挑到了没钱的号"）；永久禁用又会让
 * "我刚充了钱"无路可走。
 *
 * 恢复的主路径其实不是等：两家供应商读到余额后，只要 `available > 0` 就会
 * `markHealthy`（`core/credits.ts#applyZeroPoints`），所以充值/每日刷新之后
 * 下一次读余额就会把账号放回池里。这个窗口只是"用户完全不看界面"时的兜底。
 */
export const DEFAULT_POINTS_COOLDOWN_MS = 30 * 60 * 1000

/**
 * The bench window for "out of points".
 *
 * Flat, not stepped: hitting a zero-balance account again proves nothing about a
 * risk control, and waiting never tops the account up.
 */
export function pointsCooldownMs(): number {
  return DEFAULT_POINTS_COOLDOWN_MS
}

/**
 * Rate-limit cooldown ladder: consecutive hits multiply the base window.
 *
 * The consecutive count is persisted by the account store
 * (`unavailableStreak`): a hit that lands while the previous bench is still
 * running means the limit did not lift, so it is one rung higher; a hit after
 * the bench expired (or after any healthy call) restarts at 1.
 */
export const RATE_LIMIT_COOLDOWN_STEPS = [1, 2, 4, 8, 16] as const

/** Upper bound for the exponential rate-limit cooldown (six hours). */
export const RATE_LIMIT_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000

/**
 * How long an account stays out of rotation after its Nth consecutive
 * rate-limit hit.
 *
 * The consecutive count is persisted by the account store
 * (`unavailableStreak`): a hit that lands while the previous bench is still
 * running means the limit did not lift, so it is one rung higher; a hit after
 * the bench expired (or after any healthy call) restarts at 1.
 */
export function rateLimitCooldownMs(consecutiveHits: number, baseMs: number = DEFAULT_POOL_COOLDOWN_MS): number {
  const step = RATE_LIMIT_COOLDOWN_STEPS[Math.min(Math.max(consecutiveHits - 1, 0), RATE_LIMIT_COOLDOWN_STEPS.length - 1)]
  return Math.min(baseMs * (step ?? 1), RATE_LIMIT_COOLDOWN_MAX_MS)
}

/**
 * Does this failure message read as the account-level risk control rather than
 * an ordinary QPS throttle?
 *
 * Raccoon's shape is `429 {"code":200108,"type":"rate_limit_error","message":
 * "系统检测到当前账号存在异常调用…模型调用功能已暂时受限…"}`. Matching on
 * `200108` / 「异常调用」 keeps the vendor-neutral pool free of vendor ids while
 * still recognising the class of failure that must not be retried soon.
 */
export function isRiskControlLimit(message?: string): boolean {
  if (message === undefined) return false
  return /\b200108\b|异常调用|暂时受限|abnormal call/iu.test(message)
}

/**
 * Failures that will **never** fix themselves by waiting.
 *
 * A 401 / `authorization_verify_error` / expired token is not a rate limit: after
 * the cooldown the account is still dead, and trying it again only spends one
 * more failed call. Those stay out of rotation until something actually changes
 * the account (a successful call, a re-login, a re-import).
 *
 * Kept as a separate pattern from {@link disqualifiesAccount} on purpose: that
 * one answers "skip it for now", this one answers "do not come back".
 */
const AUTH_FAILURE =
  /MISSING[_\s]?CREDENTIAL|authorization_verify_error|invalid[_\s-]?api[_\s-]?key|unauthori[sz]ed|\b(401|200003)\b|登录已失效|登录态已过期|令牌.*过期|token.*(?:expired|invalid)/iu

/** Failures that mean "no money right now" — recoverable by topping up. */
const POINTS_FAILURE = /余额不足|积分不足|no[_ ]?points|quota|insufficient/iu

/** Failure code `markUnavailable` stores for a rate-limited account. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT'

/**
 * Failure code for "the login is fine, but every account in the pool is
 * cooling down from a rate/points bench, so this call is refused locally".
 *
 * Deliberately NOT `MISSING_CREDENTIAL`: the caller is signed in — the picker
 * keeps showing the group and the card keeps showing the login — only the
 * call-side refuses. Also deliberately NOT in any retryable list: a retry
 * would just re-read the same cooling state without touching the network.
 */
export const POOL_COOLING_CODE = 'POOL_COOLING'
/**
 * Why an account is out of rotation.
 *
 * - `auth`: 登录态/密钥失效，等下去也不会好；
 * - `points`: 额度用光，充值后可恢复；
 * - `temporary`: 限流/网络抖动之类，冷却结束就会回到池里。
 */
export type UnavailableKind = 'auth' | 'points' | 'temporary'

/**
 * Classify a recorded failure.
 *
 * The UI renders a different badge per kind, because "轮换已跳过" tells a user
 * nothing when the real problem is "这个账号的密钥已经无效了，去重新登录".
 */
export function classifyUnavailable(code?: string, message?: string): UnavailableKind {
  const text = `${code ?? ''} ${message ?? ''}`
  if (AUTH_CODES.has(code ?? '') || AUTH_FAILURE.test(text)) return 'auth'
  if (POINTS_CODES.has(code ?? '') || POINTS_FAILURE.test(text)) return 'points'
  return 'temporary'
}

/**
 * Codes that already say "this account cannot work" without any message parsing.
 *
 * `AUTH` is what the pi-ai adapter carries for a 401; the others are ours. Listing
 * them explicitly means a future adapter wording cannot silently downgrade a dead
 * account into "wait ten minutes".
 */
const AUTH_CODES = new Set(['MISSING_CREDENTIAL', 'AUTH', 'AUTH_INVALID', 'CREDENTIAL_INVALID', 'UNAUTHORIZED'])

/** Codes that mean "out of points". */
const POINTS_CODES = new Set([NO_POINTS_CODE, 'NO_POINTS', 'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA'])

/** Does this failure survive the cooldown? */
export function isPermanentFailure(code?: string, message?: string): boolean {
  return classifyUnavailable(code, message) === 'auth'
}

/**
 * Failure classes that disqualify an account for the cooldown window.
 *
 * One list for every vendor. Vendors may append their own patterns through
 * `extraPatterns`; the shared part must never be duplicated, because the two
 * copies had already drifted (the second one had learned about
 * `authorization_verify_error` and the first had not).
 */
const DISQUALIFYING =
  /MISSING[_\s]?CREDENTIAL|authorization_verify_error|UNSUPPORTED[_\s]?CONTENT|\b(200003|1000007|100002|100004|200108)\b|登录已失效|令牌.*过期|余额不足|积分不足|quota|insufficient|rate[\s_-]?limit|异常调用|暂时受限/iu

/**
 * Codes that already mean "skip that account for now", **without** reading the
 * message.
 *
 * Why it matters: the harness classifies a bare `429 status code (no body)`
 * as `RATE_LIMIT` and the wording carries no `rate limit` substring, so a
 * message-only rule would never bench the account — the next call picks it
 * again and the upstream sees a hammer. Both vendors share this path.
 */
const DISQUALIFYING_CODES = new Set<string>([RATE_LIMIT_CODE, 'RATE_LIMITED', 'TOO_MANY_REQUESTS', ...POINTS_CODES])

/** Does this failure code mean "skip that account next time"? */
export function disqualifiesFailureCode(code: string | undefined): boolean {
  return code !== undefined && DISQUALIFYING_CODES.has(code)
}

/** Does this failure mean "skip that account next time"? */
export function disqualifiesAccount(text: string | undefined, extra?: RegExp): boolean {
  if (text === undefined) return false
  return DISQUALIFYING.test(text) || extra?.test(text) === true
}

/**
 * 限流类失败（看 code 也看文案）。
 *
 * 为什么单独一个判据：阶梯冷却只该对"上游在限流"升级；额度用光（`QUOTA_*`）
 * 升多久都没用，充值一次就恢复。文案那边只有 429/风险控制关键词，因为不同
 * 供应商的措辞完全不同。
 */
export function isRateLimitFailure(code?: string, message?: string): boolean {
  if (code !== undefined && (code === RATE_LIMIT_CODE || code === 'RATE_LIMITED' || code === 'TOO_MANY_REQUESTS')) {
    return true
  }
  if (message !== undefined && /\b429\b|rate[\s_-]?limit|too many requests/iu.test(message)) return true
  return isRiskControlLimit(message)
}

/** One benched identity's state. */
export interface DesktopBenchStatus {
  benched: boolean
  /** 永久失效（登录态/密钥）：等到"可以再试"只会换来同一个错误。 */
  permanent: boolean
  /** 解禁时刻（epoch ms）；永久失效时没有。 */
  until?: number
}

/**
 * 桌面端登录态的内存 bench。
 *
 * 为什么需要：桌面令牌属于客户端，插件**永不写**它，所以池的持久化禁用在这里
 * 没有落点（`core/accounts.ts` 明确忽略 `desktop` 的 mark*）。但"不能持久化"
 * 不等于"不能记着"——一个被限流/失效的桌面令牌如果每次调用都重试，就是在拿
 * 用户的账号去反复确认同一个限制。窗口在失败那一刻定死，进程重启清零（重装/
 * 重登后本来也该重新判断）。
 *
 * 与小浣熊和 Loomy 共用：两个供应商的桌面身份行为必须一致，否则同一台机器上
 * 两家的表现会莫名其妙地不同。
 */
export interface DesktopBench {
  /** 记一次失败；返回实际窗口（永久失效返回 `undefined`，它没有恢复时间）。 */
  markUnavailable(id: string, code: string, message: string): AccountBenchVerdict | undefined
  /** 一次成功调用清空全部失败状态。 */
  markHealthy(id: string): void
  /** 这个身份现在能不能用。 */
  status(id: string): DesktopBenchStatus
}

export function createDesktopBench(
  options: { now?: () => number; cooldownMs?: () => number } = {},
): DesktopBench {
  const now = options.now ?? (() => Date.now())
  const base = (): number => {
    const value = options.cooldownMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_POOL_COOLDOWN_MS
  }
  const entries = new Map<string, { at: number; until?: number; streak?: number; code: string; permanent: boolean }>()

  return {
    markUnavailable(id, code, message) {
      const previous = entries.get(id)
      if (previous?.permanent === true) return undefined
      const at = now()
      /*
       * 额度类是**平窗**：不升阶梯，也不共用基础值。
       *
       * 一个零余额账号每次重试都会拿到同一句"积分不足"，阶梯在这里只会在
       * 用户充完钱之后把人挡在门外；而基础窗口（10 分钟）又太短，等于每十分钟
       * 拿用户的账号去撞一次墙。见 `pointsCooldownMs`。
       */
      const points = classifyUnavailable(code, message) === 'points'
      const stillBenched = previous?.until !== undefined && at < previous.until
      const streak =
        !points && isRateLimitFailure(code, message) ? (stillBenched ? (previous?.streak ?? 1) : 0) + 1 : 0
      const window = points ? pointsCooldownMs() : streak === 0 ? base() : rateLimitCooldownMs(streak, base())
      const until = at + window
      const permanent = isPermanentFailure(code, message)
      entries.set(id, { at, until, ...(streak === 0 ? {} : { streak }), code, permanent })
      return permanent ? undefined : { cooldownMs: window, recoverAt: until }
    },

    markHealthy(id) {
      entries.delete(id)
    },

    status(id) {
      const entry = entries.get(id)
      if (entry === undefined) return { benched: false, permanent: false }
      if (entry.permanent) return { benched: true, permanent: true }
      const until = entry.until ?? entry.at
      return { benched: now() < until, permanent: false, until }
    },
  }
}

export type PoolPick =
  | { kind: 'ok'; account: StoredAccount; healthy: number; total: number }
  | { kind: 'empty'; reason: string }
  | {
      kind: 'none-healthy'
      accounts: StoredAccount[]
      /**
       * 冷却中、但**可以**再试的账号（限流、额度）。
       *
       * 以前没有这个划分，调用方在"全部不可用"时挑最久没失败的那个——于是
       * 401 的账号也会被拿去烧一次调用，用户看到的是"轮换又挑到了坏账号"。
       */
      recoverable: StoredAccount[]
      /** 永久失效（登录态/密钥）的账号：再试一次必然是同一个错误。 */
      permanent: StoredAccount[]
      /**
       * 最早一个可恢复账号解禁的时刻（epoch ms）；没有可恢复账号时为 `null`。
       *
       * 调用方把它变成"最早 HH:MM 自动恢复"给用户，而不是再打一次上游。
       */
      recoverAt: number | null
      healthy: number
      total: number
    }

export interface AccountPool {
  /** Choose an account for one call. Never throws. */
  pick(): Promise<PoolPick>
  /** Accounts not currently benched. */
  usable(): Promise<StoredAccount[]>
  state(): Promise<{ total: number; healthy: number; entries: PoolEntryView[] }>
  /** Would the pool skip this account right now? */
  isBenched(account: StoredAccount): boolean
  /**
   * Record that a call through `id` failed in a disqualifying way.
   *
   * Returns the cooldown actually applied, so a caller can tell the user when
   * the account comes back. Rate-limit hits grow the window exponentially.
   */
  markUnavailable(id: string, code: string, message: string): Promise<{ cooldownMs: number; recoverAt: number }>
  /** Record that a call through `id` succeeded. */
  markHealthy(id: string): Promise<void>
}

/** One account's pool status, session-free. */
export interface PoolEntryView {
  id: string
  route: string
  unavailable: boolean
  unavailableAt?: number
  code?: string
  message?: string
  /** Why it is out of rotation; absent when it is healthy. */
  kind?: UnavailableKind
}

export interface PoolOptions {
  accounts: AccountDriver
  cooldownMs?: () => number
  now?: () => number
  /** Injectable for deterministic tests. */
  random?: () => number
  /** Vendor-specific disqualifying patterns, appended to the shared list. */
  extraPatterns?: RegExp
}

export function createAccountPool(options: PoolOptions): AccountPool {
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const cooldownMs = (): number => {
    const value = options.cooldownMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_POOL_COOLDOWN_MS
  }
  const isPermanent = (account: StoredAccount): boolean =>
    account.unavailableAt !== undefined &&
    isPermanentFailure(account.unavailableCode, account.unavailableMessage)
  const isHealthy = (account: StoredAccount): boolean => {
    if (account.unavailableAt === undefined) return true
    // 永久失效不看冷却：等到"可以再试"只会换来同一个 401。
    if (isPermanent(account)) return false
    return now() >= benchUntil(account)
  }

  /**
   * 这个被禁账号什么时候解禁（epoch ms）。
   *
   * **窗口在失败那一刻定死并随记录持久化**（`unavailableUntil`），不是每次
   * 检查都从"过去了多久"现推——后者会自我延长（窗口随时间增长，永远等不到头）。
   * 旧的账号记录没有 `unavailableUntil`（其他驱动/旧版本写入的），退回基础窗口。
   */
  const benchUntil = (account: StoredAccount): number => {
    const failedAt = account.unavailableAt ?? now()
    if (account.unavailableUntil !== undefined) return account.unavailableUntil
    const base = cooldownMs()
    // 旧记录（没有 `unavailableUntil`）也得按同一套窗口推：额度类不升级，
    // 但窗口比普通失败长。
    const window =
      classifyUnavailable(account.unavailableCode, account.unavailableMessage) === 'points'
        ? pointsCooldownMs()
        : account.unavailableCode === RATE_LIMIT_CODE
          ? rateLimitCooldownMs(1, base)
          : base
    return failedAt + window
  }

  return {
    async pick() {
      const accounts = await options.accounts.list({ force: true })
      if (accounts.length === 0) {
        return { kind: 'empty', reason: '账号池里还没有账号，请先在账户页登录或导入。' }
      }
      const healthy = accounts.filter(isHealthy)
      if (healthy.length > 0) {
        const index = Math.min(healthy.length - 1, Math.floor(random() * healthy.length))
        return { kind: 'ok', account: healthy[index] as StoredAccount, healthy: healthy.length, total: accounts.length }
      }
      const recoverable = accounts.filter((account) => !isPermanent(account))
      const recoverAt =
        recoverable.length === 0
          ? null
          : Math.min(...recoverable.map((account) => benchUntil(account)))
      return {
        kind: 'none-healthy',
        accounts,
        recoverable,
        permanent: accounts.filter(isPermanent),
        recoverAt,
        healthy: 0,
        total: accounts.length,
      }
    },

    async usable() {
      const accounts = await options.accounts.list({ force: false })
      return accounts.filter(isHealthy)
    },

    async state() {
      const accounts = await options.accounts.list({ force: true })
      return {
        total: accounts.length,
        healthy: accounts.filter(isHealthy).length,
        entries: accounts.map((account) => {
          const unavailable = !isHealthy(account)
          return {
            id: account.id,
            route: options.accounts.routeOf(account),
            unavailable,
            ...(account.unavailableAt === undefined ? {} : { unavailableAt: account.unavailableAt }),
            ...(account.unavailableCode === undefined ? {} : { code: account.unavailableCode }),
            ...(account.unavailableMessage === undefined ? {} : { message: account.unavailableMessage }),
            ...(unavailable
              ? { kind: classifyUnavailable(account.unavailableCode, account.unavailableMessage) }
              : {}),
          }
        }),
      }
    },

    isBenched(account) {
      return !isHealthy(account)
    },

    async markUnavailable(id, code, message) {
      const verdict = await options.accounts.markUnavailable(id, code, message)
      const cooldownMsValue =
        verdict && typeof verdict.cooldownMs === 'number' && verdict.cooldownMs > 0
          ? verdict.cooldownMs
          : rateLimitCooldownMs(1, cooldownMs())
      const recoverAt =
        verdict && typeof verdict.recoverAt === 'number' && verdict.recoverAt > 0
          ? verdict.recoverAt
          : now() + cooldownMsValue
      return { cooldownMs: cooldownMsValue, recoverAt }
    },

    async markHealthy(id) {
      await options.accounts.markHealthy(id)
    },
  }
}

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
 * @module dsh-connect-desktop/core/pool
 */

import type { AccountDriver, StoredAccount } from '../vendor-sdk/contracts.js'

/** Failure code used when an account has no spendable points left. */
export const NO_POINTS_CODE = 'no_points'

/** How long an account stays out of rotation after a failure. */
export const DEFAULT_POOL_COOLDOWN_MS = 10 * 60 * 1000

/**
 * Failure classes that disqualify an account for the cooldown window.
 *
 * One list for every vendor. Vendors may append their own patterns through
 * `extraPatterns`; the shared part must never be duplicated, because the two
 * copies had already drifted (the second one had learned about
 * `authorization_verify_error` and the first had not).
 */
const DISQUALIFYING =
  /MISSING[_\s]?CREDENTIAL|authorization_verify_error|UNSUPPORTED[_\s]?CONTENT|\b(200003|1000007|100002|100004)\b|登录已失效|令牌.*过期|余额不足|积分不足|quota|insufficient|rate[\s_-]?limit/iu

/** Does this failure mean "skip that account next time"? */
export function disqualifiesAccount(text: string | undefined, extra?: RegExp): boolean {
  if (text === undefined) return false
  return DISQUALIFYING.test(text) || extra?.test(text) === true
}

export type PoolPick =
  | { kind: 'ok'; account: StoredAccount; healthy: number; total: number }
  | { kind: 'empty'; reason: string }
  | { kind: 'none-healthy'; accounts: StoredAccount[]; healthy: number; total: number }

export interface AccountPool {
  /** Choose an account for one call. Never throws. */
  pick(): Promise<PoolPick>
  /** Accounts not currently benched. */
  usable(): Promise<StoredAccount[]>
  state(): Promise<{ total: number; healthy: number; entries: PoolEntryView[] }>
  /** Record that a call through `id` failed in a disqualifying way. */
  markUnavailable(id: string, code: string, message: string): Promise<void>
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
  const isHealthy = (account: StoredAccount): boolean =>
    account.unavailableAt === undefined || now() - account.unavailableAt >= cooldownMs()

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
      return { kind: 'none-healthy', accounts, healthy: 0, total: accounts.length }
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
        entries: accounts.map((account) => ({
          id: account.id,
          route: options.accounts.routeOf(account),
          unavailable: !isHealthy(account),
          ...(account.unavailableAt === undefined ? {} : { unavailableAt: account.unavailableAt }),
          ...(account.unavailableCode === undefined ? {} : { code: account.unavailableCode }),
          ...(account.unavailableMessage === undefined ? {} : { message: account.unavailableMessage }),
        })),
      }
    },

    async markUnavailable(id, code, message) {
      await options.accounts.markUnavailable(id, code, message)
    },

    async markHealthy(id) {
      await options.accounts.markHealthy(id)
    },
  }
}

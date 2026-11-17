/**
 * The account pool: pick a usable account per call, at random, and remember
 * which ones refused so the next call skips them.
 *
 * Why opt-in (a separate `loomy-pool` route rather than the default):
 * routing a call to an account the user did not pick makes billing
 * unpredictable, so the pool is an explicit choice. The per-account routes stay
 * exactly as before, and a conversation that binds to `loomy-2` still spends
 * account 2 every time.
 *
 * Selection rules:
 * - candidates are the stored accounts that are **not** in cooldown;
 * - the choice is uniform random among them (not round-robin: concurrent calls
 *   must not all land on the same account just because it was "next");
 * - when every account is in cooldown, the least-recently-failed one is tried
 *   again instead of failing the request outright — a pool with no candidates
 *   is worse than a risky retry, and the failure is re-recorded if it recurs.
 *
 * Cooldown marks persist in `accounts.json` (`unavailableAt`/`Code`/`Message`)
 * so they survive a restart and the settings card can say *why* an account is
 * being skipped.
 *
 * @module dsh-connect-loomy/pool
 */

import type { AccountsStore, StoredAccount } from './accounts.js'

/** Route id of the pool. Kept out of `loomy-N` so slot maths never sees it. */
export const POOL_ROUTE = 'loomy-pool'

/** Failure code used when an account has no spendable points left. */
export const NO_POINTS_CODE = 'no_points'

/** How long an account stays out of rotation after a failure. */
export const DEFAULT_POOL_COOLDOWN_MS = 10 * 60 * 1000

/** One selection: the account, or why nothing could be chosen. */
export type PoolPick =
  | { kind: 'ok'; account: StoredAccount; healthy: number; total: number }
  | { kind: 'empty'; reason: string }
  | { kind: 'none-healthy'; account: StoredAccount; healthy: number; total: number }

export interface AccountPool {
  /** Choose an account for one call. Never throws. */
  pick(): Promise<PoolPick>
  /** Record that a call through `id` failed in a disqualifying way. */
  markUnavailable(id: string, code: string, message: string): Promise<void>
  /** Record that a call through `id` succeeded. */
  markHealthy(id: string): Promise<void>
  /** Accounts not currently benched, in store order. */
  usable(): Promise<StoredAccount[]>
  /** Pool state for the settings card. */
  state(): Promise<{ total: number; healthy: number; entries: PoolEntryView[] }>
}

/** One account's pool status, session-free. */
export interface PoolEntryView {
  id: string
  slot: number
  route: string
  unavailable: boolean
  unavailableAt?: number
  code?: string
  message?: string
}

/** Failure classes that disqualify an account for the cooldown window. */
const DISQUALIFYING =
  /MISSING[_\s]?CREDENTIAL|UNSUPPORTED[_\s]?CONTENT|100002|100004|余额不足|积分不足|quota|rate[\s_-]?limit/iu

/** Does this failure mean "skip that account next time"? */
export function disqualifiesAccount(text: string | undefined): boolean {
  return text !== undefined && DISQUALIFYING.test(text)
}

/** Create the pool over one accounts store. */
export function createAccountPool(options: {
  accounts: AccountsStore
  cooldownMs?: () => number
  now?: () => number
  /** Injectable for deterministic tests. */
  random?: () => number
}): AccountPool {
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const cooldownMs = (): number => {
    const value = options.cooldownMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_POOL_COOLDOWN_MS
  }

  const isHealthy = (account: StoredAccount): boolean =>
    account.unavailableAt === undefined || now() - account.unavailableAt >= cooldownMs()

  return {
    async pick() {
      const accounts = await options.accounts.list({ force: true })
      if (accounts.length === 0) {
        return { kind: 'empty', reason: 'endpoint 池里还没有账号，请先在账户页登录或导入。' }
      }
      const healthy = accounts.filter(isHealthy)
      if (healthy.length > 0) {
        const index = Math.min(healthy.length - 1, Math.floor(random() * healthy.length))
        return {
          kind: 'ok',
          account: healthy[index] as StoredAccount,
          healthy: healthy.length,
          total: accounts.length,
        }
      }
      // Every account is benched. Report that plainly instead of handing back
      // one of them: the caller used to call that account anyway, which is the
      // opposite of what a benched account is for.
      const oldest = [...accounts].sort(
        (left, right) => (left.unavailableAt ?? 0) - (right.unavailableAt ?? 0),
      )[0] as StoredAccount
      return { kind: 'none-healthy', account: oldest, healthy: 0, total: accounts.length }
    },

    async markUnavailable(id, code, message) {
      await options.accounts.markUnavailable(id, code, message)
    },

    async markHealthy(id) {
      await options.accounts.markHealthy(id)
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
          slot: account.slot,
          route: account.slot === 1 ? 'loomy' : `loomy-${account.slot}`,
          unavailable: !isHealthy(account),
          ...(account.unavailableAt === undefined ? {} : { unavailableAt: account.unavailableAt }),
          ...(account.unavailableCode === undefined ? {} : { code: account.unavailableCode }),
          ...(account.unavailableMessage === undefined ? {} : { message: account.unavailableMessage }),
        })),
      }
    },
  }
}

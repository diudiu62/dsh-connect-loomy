/**
 * The one credits cache + the per-account merge.
 *
 * A vendor supplies `load` (its balance call mapped into {@link CreditsView}).
 * The 60s TTL, the single-flight, "a failure is never a zero", the per-account
 * breakdown and the ledger source tags are identical everywhere.
 *
 * @module dsh-connect-desktop/core/credits
 */

import type { CreditsDriver, CreditsReadout, StoredAccount } from '../vendor-sdk/contracts.js'
import type { CreditsAccountView, CreditsView } from '../shared/views.js'
import { safeErrorMessage } from '../shared/text.js'
import { createMemo } from './ttl.js'

export interface CreditsDriverOptions {
  /** Read the balance; must throw on failure. */
  load: () => Promise<CreditsView>
  /** Per-account read; must throw on failure. */
  loadForAccount?: (account: StoredAccount) => Promise<CreditsView>
  ttlMs: () => number
  now?: () => number
  /** Called after a successful read, for "no points left" bench decisions. */
  onRead?: (view: CreditsView, account?: StoredAccount) => void
}

export interface CreditsStore extends CreditsDriver {
  /** Drop every cached figure (after a login/import). */
  invalidate(): void
}

export function createCreditsStore(options: CreditsDriverOptions): CreditsStore {
  const memo = createMemo<CreditsView>({
    ttlMs: options.ttlMs,
    load: options.load,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const perAccount = new Map<string, ReturnType<typeof createMemo<CreditsView>>>()

  const toReadout = async (read: () => Promise<CreditsView>, account?: StoredAccount): Promise<CreditsReadout> => {
    try {
      const view = await read()
      options.onRead?.(view, account)
      return { kind: 'ok', credits: view }
    } catch (error) {
      return {
        kind: 'failure',
        failure: {
          at: (options.now ?? Date.now)(),
          path: 'credits',
          code: codeOf(error),
          message: safeErrorMessage(error),
        },
      }
    }
  }

  const store: CreditsStore = {
    read(readOptions = {}) {
      return toReadout(() => memo.read(readOptions))
    },

    async readForAccount(account, readOptions = {}) {
      if (options.loadForAccount === undefined) return { kind: 'failure', failure: {
        at: (options.now ?? Date.now)(),
        path: 'credits',
        code: 'not_supported',
        message: '该供应商不提供逐账号余额。',
      } }
      let entry = perAccount.get(account.id)
      if (entry === undefined) {
        const load = options.loadForAccount
        entry = createMemo<CreditsView>({
          ttlMs: options.ttlMs,
          load: () => load(account),
          ...(options.now === undefined ? {} : { now: options.now }),
        })
        perAccount.set(account.id, entry)
      }
      // `force` 必须传下去：否则「刷新」只刷了总额，逐账号数字还是旧缓存。
      return toReadout(() => entry.read(readOptions.force === true ? { force: true } : {}), account)
    },

    invalidate() {
      memo.clear()
      perAccount.clear()
    },
  }

  return store
}

/**
 * Merge per-account figures into one view.
 *
 * Numeric buckets are **summed** — that is what "what do I have in total" means
 * once several accounts exist — while every ledger row keeps the account it came
 * from, because the same description can appear twice with different balances.
 *
 * A failure for one account becomes that row's `error`; it never blanks the list.
 * When nothing at all is readable the caller gets a failure: reporting zero
 * would look like an empty wallet instead of a dead session.
 */
export function mergeCredits(
  primary: CreditsReadout,
  rows: ReadonlyArray<{ account: StoredAccount; route: string; label?: string; readout: CreditsReadout }>,
): CreditsReadout {
  if (rows.length === 0) return primary

  const perAccount: CreditsAccountView[] = []
  const totals: Record<string, number> = {}
  let readable = 0
  let fetchedAt = 0
  const records: CreditsView['records'] = []

  for (const { account, route, label, readout } of rows) {
    if (readout.kind === 'failure') {
      perAccount.push({
        accountId: account.id,
        route,
        ...(label === undefined ? {} : { account: label }),
        fields: {},
        error: readout.failure.message,
      })
      continue
    }
    readable += 1
    fetchedAt = Math.max(fetchedAt, readout.credits.fetchedAt)
    for (const [key, value] of Object.entries(readout.credits.fields)) {
      totals[key] = (totals[key] ?? 0) + (Number.isFinite(value) ? value : 0)
    }
    perAccount.push({
      accountId: account.id,
      route,
      ...(label === undefined ? {} : { account: label }),
      fields: { ...readout.credits.fields },
    })
    for (const record of readout.credits.records ?? []) {
      records.push({
        ...record,
        source: { route, accountId: account.id, ...(label === undefined ? {} : { account: label }) },
      })
    }
  }

  if (readable === 0) {
    /*
     * 逐账号全失败，但总额可能仍有数据（例如余额接口限流、明细接口正常）。
     * 那种情况下必须返回总额，否则"能拿到的明细"会因为"读不到的逐账号数字"
     * 被一起丢掉——这正是用户报的现象。
     */
    if (primary.kind === 'ok') return primary
    const firstFailure = rows.find((row) => row.readout.kind === 'failure')
    if (firstFailure !== undefined && firstFailure.readout.kind === 'failure') {
      return { kind: 'failure', failure: firstFailure.readout.failure }
    }
    if (primary.kind === 'failure') return primary
    return {
      kind: 'failure',
      failure: {
        at: Date.now(),
        path: 'credits',
        code: 'no_readable_account',
        message: '没有任何账号的积分可以读取。',
      },
    }
  }

  return {
    kind: 'ok',
    credits: {
      fields: totals,
      fetchedAt: fetchedAt === 0 ? Date.now() : fetchedAt,
      perAccount,
      ...(records.length === 0 ? {} : { records }),
    },
  }
}

function codeOf(error: unknown): string {
  const carried = (error as { code?: unknown } | null)?.code
  if (typeof carried === 'string' && carried.length > 0) return carried
  return 'CREDITS_FAILED'
}

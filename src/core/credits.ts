/**
 * The one credits cache + the per-account merge.
 *
 * A vendor supplies `load` (its balance call mapped into {@link CreditsView}).
 * The 60s TTL, the single-flight, "a failure is never a zero", the per-account
 * breakdown and the ledger source tags are identical everywhere.
 *
 * @module dsh-connect-desktop/core/credits
 */

import type { AccountDriver, CreditsDriver, CreditsReadout, StoredAccount } from '../vendor-sdk/contracts.js'
import type { CreditsAccountView, CreditsView } from '../shared/views.js'
import { safeErrorMessage } from '../shared/text.js'
import { NO_POINTS_CODE, classifyUnavailable } from './pool.js'
import { createMemo } from './ttl.js'

/** 零余额账号在账号表里留下的原话（抽屉里就显示这句）。 */
export const ZERO_POINTS_MESSAGE = '积分不足（可用余额为 0），暂不参与轮换'

/**
 * 读到余额之后该不该动池：零余额 → 暂停；余额回来 → 解除暂停。
 *
 * 两条边界，都是踩过的坑：
 *
 * 1. **`available` 缺席不等于 0。** Raccoon 的余额接口被限流时，`readCreditsView`
 *    会给出"只有明细、没有余额桶"的视图（`partial: 'balance_unavailable'`）。
 *    把"读不到"当成"没钱"，会把一个完全健康的账号踢出轮换，用户在抽屉里只会
 *    看到"轮换已跳过"，而那正是他没法修的那件事。所以这里只认**读到的数字**。
 * 2. **解除必须在这里做。** 被暂停的账号永远不会被挑中去调用，于是
 *    `markHealthy` 没有别的调用点——不在这里解除，用户充值之后仍要坐等一个整窗口。
 *    这也是 `points` 用平窗（而不是永久禁用）的底气：真正的恢复信号是余额。
 */
export function applyZeroPoints(
  view: CreditsView,
  account: StoredAccount | undefined,
  driver: Pick<AccountDriver, 'markUnavailable' | 'markHealthy'>,
): void {
  if (account === undefined) return
  const available = view.fields['available']
  if (available === undefined || !Number.isFinite(available)) return
  if (available > 0) {
    // 充值 / 每日额度刷新：解除额度暂停，不必等冷却窗口走完。
    const benchedForPoints =
      account.unavailableAt !== undefined &&
      classifyUnavailable(account.unavailableCode, account.unavailableMessage) === 'points'
    if (benchedForPoints) void driver.markHealthy(account.id).catch(() => undefined)
    return
  }
  void driver.markUnavailable(account.id, NO_POINTS_CODE, ZERO_POINTS_MESSAGE).catch(() => undefined)
}

export interface CreditsDriverOptions {
  /** Read the balance; must throw on failure. */
  load: () => Promise<CreditsView>
  /** Per-account read; must throw on failure. */
  loadForAccount?: (account: StoredAccount) => Promise<CreditsView>
  ttlMs: () => number
  /**
   * 失败之后多久之内不要再打上游（缺省 {@link CREDITS_FAILURE_TTL_MS}）。
   *
   * 这是唯一一条"负缓存"：余额接口被网关限流（403 空 body）时，继续重试就是
   * 在把限流确认一遍——实测连打十几次会稳定复现 403，而账号越多一轮越快。
   * 用户在窗口内点"刷新"（`force`）仍然会真的再试一次，那是他明确的意图。
   */
  failureTtlMs?: () => number
  now?: () => number
  /**
   * 读到成功的余额之后调用，用来做"零余额就暂停"的决定。
   *
   * 供应商应该直接转给 {@link applyZeroPoints}：那条规则（读不到 ≠ 没钱、
   * 余额回来就解除暂停）必须两边一字不差，复制一份迟早在两家之间漂移。
   */
  onRead?: (view: CreditsView, account?: StoredAccount) => void
}

export interface CreditsStore extends CreditsDriver {
  /** Drop every cached figure (after a login/import). */
  invalidate(): void
}

/** 失败之后多久之内不再打上游。足够越过一次网关限流窗口，又不至于让人等太久。 */
export const CREDITS_FAILURE_TTL_MS = 60_000

/**
 * 这次失败像不像"别马上再来"（限流/风控/额度），而不是一次偶发抖动？
 *
 * 用于两处止血：负缓存（不再为该 key 打上游）与"整轮跳过"（总额都被限流时，
 * 不要再去逐账号打 N 次）。文案来自两家供应商与网关，只匹配类名不匹配具体 id。
 */
export function isThrottleFailure(message: string | undefined): boolean {
  if (message === undefined) return false
  return /\b(403|429)\b|rate[\s_-]?limit|too many requests|throttl|限流|频繁|异常调用|暂时受限|风控|quota|insufficient|积分不足|余额不足/iu.test(
    message,
  )
}

export function createCreditsStore(options: CreditsDriverOptions): CreditsStore {
  const now = options.now ?? (() => Date.now())
  const failureTtl = (): number => {
    const value = options.failureTtlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : CREDITS_FAILURE_TTL_MS
  }
  const memo = createMemo<CreditsView>({
    ttlMs: options.ttlMs,
    load: options.load,
    ...(options.now === undefined ? {} : { now }),
  })
  const perAccount = new Map<string, ReturnType<typeof createMemo<CreditsView>>>()
  /**
   * 每个 key（`'primary'` 或账号 id）最近一次失败。
   *
   * 为什么不缓存进 memo：memo 的契约是"失败不是值"，绝对不能把一个失败当成
   * 60 秒里的余额。这里存的是"别再问了"的时间戳，命中时**重放同一个失败**，
   * 让界面继续诚实地显示"读不到"，只是不再为它打一次上游。
   */
  const failures = new Map<string, { at: number; failure: Extract<CreditsReadout, { kind: 'failure' }>['failure'] }>()

  const replay = (
    key: string,
    readOptions: { force?: boolean },
  ): CreditsReadout | undefined => {
    if (readOptions.force === true) return undefined
    const entry = failures.get(key)
    if (entry === undefined) return undefined
    if (now() - entry.at >= failureTtl()) return undefined
    return { kind: 'failure', failure: entry.failure }
  }

  const toReadout = async (
    key: string,
    read: () => Promise<CreditsView>,
    account?: StoredAccount,
  ): Promise<CreditsReadout> => {
    try {
      const view = await read()
      failures.delete(key)
      options.onRead?.(view, account)
      return { kind: 'ok', credits: view }
    } catch (error) {
      const failure = {
        at: now(),
        path: 'credits' as const,
        code: codeOf(error),
        message: safeErrorMessage(error),
      }
      failures.set(key, { at: failure.at, failure })
      return { kind: 'failure', failure }
    }
  }

  const store: CreditsStore = {
    read(readOptions = {}) {
      const cached = replay('primary', readOptions)
      if (cached !== undefined) return Promise.resolve(cached)
      return toReadout('primary', () => memo.read(readOptions))
    },

    async readForAccount(account, readOptions = {}) {
      if (options.loadForAccount === undefined) return { kind: 'failure', failure: {
        at: now(),
        path: 'credits',
        code: 'not_supported',
        message: '该供应商不提供逐账号余额。',
      } }
      const key = `account:${account.id}`
      const cached = replay(key, readOptions)
      if (cached !== undefined) return cached
      let entry = perAccount.get(account.id)
      if (entry === undefined) {
        const load = options.loadForAccount
        entry = createMemo<CreditsView>({
          ttlMs: options.ttlMs,
          load: () => load(account),
          ...(options.now === undefined ? {} : { now }),
        })
        perAccount.set(account.id, entry)
      }
      // `force` 必须传下去：否则「刷新」只刷了总额，逐账号数字还是旧缓存。
      return toReadout(key, () => entry.read(readOptions.force === true ? { force: true } : {}), account)
    },

    invalidate() {
      memo.clear()
      perAccount.clear()
      failures.clear()
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

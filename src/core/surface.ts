/**
 * The vendor surface: every view the HTTP layer serves, built once.
 *
 * A vendor implements primitives (credential, accounts, catalog, credits,
 * login, chat). This module turns those primitives into `GET /status`, the
 * diagnostics payload, the credits payload, the catalog view and the
 * account/pool views — so a new vendor writes **no** view-assembly code at all
 * and cannot silently forget a field another vendor has.
 *
 * @module dsh-connect-desktop/core/surface
 */

import type {
  AccountDriver,
  ProviderState,
  StoredAccount,
  VendorDescriptor,
  VendorRuntime,
  VendorSurface,
} from '../vendor-sdk/contracts.js'
import { classifyUnavailable, type AccountPool, type UnavailableKind } from './pool.js'
import type { CreditsReadout } from '../vendor-sdk/contracts.js'
import { isThrottleFailure, mergeCredits } from './credits.js'
import type {
  AccountRowView,
  AccountView,
  AccountsView,
  CatalogModelView,
  CredentialView,
  DiagnosticsProbe,
  PoolStateView,
  VendorDiagnosticsView,
  VendorStatusView,
} from '../shared/views.js'

export interface SurfaceOptions {
  descriptor: VendorDescriptor
  runtime: VendorRuntime
  pool?: AccountPool
  now?: () => number
  /** registry 注入：让 `/status` 能回答"provider 到底注册了没有"。 */
  providerState?: () => ProviderState | undefined
}

/**
 * 逐账号余额读取的并发与间隔。
 *
 * 这两个数字是**上游风控参数**，不是性能参数：同一批账号背靠背请求正是网关
 * 眼里"异常调用"的形态（`docs/raccoon-upstream.md` §7.1、§10）。官方客户端
 * 的本地中继就是 2 路，这里对齐它。
 */
const CREDITS_ACCOUNT_CONCURRENCY = 2
const CREDITS_ACCOUNT_SPACING_MS = 120

export function createVendorSurface(options: SurfaceOptions): VendorSurface {
  const { descriptor, runtime } = options
  const now = options.now ?? (() => Date.now())
  const accounts: AccountDriver | undefined = runtime.accounts

  const credentialView = async (): Promise<CredentialView> => {
    const state = await runtime.credentials.read()
    if (!state.found) {
      return {
        found: false,
        sourcePath: state.candidates[0]?.path ?? '',
        sourceOrigin: 'none',
        problem: state.problem,
        candidates: [...state.candidates],
      }
    }
    return {
      found: true,
      sourcePath: state.sourcePath,
      sourceOrigin: state.sourceOrigin,
      candidates: [...state.candidates],
      ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
      ...(state.expired === undefined ? {} : { expired: state.expired }),
    }
  }

  /** Which provider route the effective credential is reachable as. */
  const routeOfCredential = async (accountId: string | undefined): Promise<string | undefined> => {
    if (accountId === undefined || accounts === undefined) return undefined
    const account = await accounts.list({ force: false }).then((rows) => rows.find((row) => row.id === accountId))
    if (account === undefined) return undefined
    return accounts.routeOf(account)
  }

  const accountSummary = async (): Promise<AccountView | null> => {
    const state = await runtime.credentials.read()
    if (!state.found) return null
    const identity = state.identity ?? {}
    const route = await routeOfCredential(state.accountId)
    return {
      ...(route === undefined ? {} : { route }),
      ...(identity.label === undefined ? {} : { label: identity.label }),
      ...(identity.phone === undefined ? {} : { phone: identity.phone }),
      ...(identity.userId === undefined ? {} : { userId: identity.userId }),
      ...(identity.orgName === undefined ? {} : { orgName: identity.orgName }),
      ...(identity.loginAt === undefined ? {} : { loginAt: identity.loginAt }),
    }
  }

  /**
   * 一行账号。
   *
   * `unavailable` 的语义是**池现在会不会跳过它**，不是一个历史事实：
   * - 登录态/密钥失效（401）→ 永远 true，冷却也不会好；
   * - 限流之类 → 只有冷却窗口内为 true，冷却结束池就会再用它，界面上不该再说
   *   "轮换已跳过"；
   * - 另外把**原因**一起给出去（`unavailableKind`），否则三个完全不同的故障在
   *   界面上共用同一句话，用户没法知道该去重新登录还是等一会儿。
   */
  const accountRow = (account: StoredAccount): AccountRowView => {
    const recorded = account.unavailableAt !== undefined
    const benched = recorded && (options.pool?.isBenched(account) ?? true)
    const kind: UnavailableKind | undefined = recorded
      ? classifyUnavailable(account.unavailableCode, account.unavailableMessage)
      : undefined
    return {
      id: account.id,
      route: accounts?.routeOf(account) ?? descriptor.id,
      displayName: accounts?.displayNameOf(account) ?? descriptor.displayName,
      origin: account.origin,
      unavailable: benched,
      ...(kind === undefined || !benched ? {} : { unavailableKind: kind }),
      ...(account.label === undefined ? {} : { label: account.label }),
      ...(account.phone === undefined ? {} : { phone: account.phone }),
      ...(account.userId === undefined ? {} : { userId: account.userId }),
      ...(account.addedAt === undefined ? {} : { addedAt: account.addedAt }),
      ...(account.unavailableAt === undefined ? {} : { unavailableAt: account.unavailableAt }),
      ...(account.unavailableCode === undefined ? {} : { unavailableCode: account.unavailableCode }),
      ...(account.unavailableMessage === undefined ? {} : { unavailableMessage: account.unavailableMessage }),
    }
  }

  const status = async (statusOptions: { allowNetwork?: boolean } = {}): Promise<VendorStatusView> => {
    const capabilities = descriptor.capabilities
    const credential = await credentialView()
    const catalog = runtime.catalog

    let total = 0
    let enabled = 0
    let refreshedAt: number | null = null
    if (catalog !== undefined) {
      const usable = credential.found && credential.expired !== true
      if (usable && statusOptions.allowNetwork !== false) {
        // First run / stale cache: read so the picker can list models instead of
        // making the card guess. A failure is reported through `lastError`.
        await catalog.read({}).catch(() => undefined)
      } else {
        await catalog.hydrate()
      }
      total = catalog.current().length
      enabled = catalog.enabledIds().length
      refreshedAt = catalog.refreshedAt()
    }

    const available = credential.found && credential.expired !== true
    const nextSteps: string[] = []
    if (!credential.found) {
      if (credential.problem !== undefined) nextSteps.push(credential.problem)
    } else if (credential.expired === true) {
      nextSteps.push('登录态已过期：请在桌面客户端重新登录，然后点「重新检测」。插件不会替你刷新令牌。')
    } else if (capabilities.catalog.selection && total === 0) {
      nextSteps.push('模型目录为空：请点「刷新」重新读取上游模型；插件不会把目录外的模型发给上游。')
      const failure = catalog?.lastError()
      if (failure !== undefined) nextSteps.push(`最近一次上游错误：${failure.code} ${failure.message}`)
    }

    const failure = catalog?.lastError()
    const provider = options.providerState?.()
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      capabilities,
      accent: descriptor.accent,
      available,
      ...(available ? {} : { unavailableReason: credential.problem ?? '未检测到登录态' }),
      credential,
      account: await accountSummary(),
      catalog: { total, enabled, refreshedAt },
      enabledModelIds: catalog?.enabledIds() ?? [],
      ...(provider === undefined ? {} : { provider: { ...provider, routes: [...provider.routes] } }),
      ...(nextSteps.length === 0 ? {} : { nextSteps }),
      ...(failure === undefined ? {} : { lastError: failure }),
    }
  }

  const diagnostics = async (): Promise<{ view: Omit<VendorDiagnosticsView, 'ok'>; probes: DiagnosticsProbe[] }> => {
    const credential = await credentialView()
    // Credential candidates are probes: they answer "where did you look?".
    const probes: DiagnosticsProbe[] = credential.candidates.map((candidate) => ({
      path: candidate.path,
      ok: candidate.state === 'ok',
      reason: candidate.reason,
    }))
    const catalog = runtime.catalog
    const rows = accounts === undefined ? [] : await accounts.list({ force: false })
    const failure = catalog?.lastError()
    return {
      probes,
      view: {
        id: descriptor.id,
        displayName: descriptor.displayName,
        baseUrl: catalog?.endpoints()[0]?.url ?? '',
        endpoints: [...(catalog?.endpoints() ?? [])],
        credential,
        account: await accountSummary(),
        inspected: [...runtime.credentials.probePaths()],
        probes,
        catalog: {
          total: catalog?.current().length ?? 0,
          enabled: catalog?.enabledIds().length ?? 0,
          refreshedAt: catalog?.refreshedAt() ?? null,
        },
        accounts:
          accounts === undefined
            ? null
            : {
                total: rows.length,
                // 与池同一定义：永久失效的账号不算健康，冷却中的才算健康。
                healthy: rows.filter((row) => options.pool?.isBenched(row) !== true).length,
              },
        ...(failure === undefined ? {} : { lastError: failure }),
      },
    }
  }

  /**
   * 一个账号的额度读数——**逐账号读取的唯一实现**。
   *
   * 批量的 `credits({withAccounts})` 与单条的 `accountCredits(id)` 都走这里：
   * 两处各写一遍就会出现"批量里记得跳过失效账号、单条忘了"的分叉。
   *
   * 已知登录态失效的账号直接把它记录下来的失败交出去，不再问上游——它们每一轮
   * 都会返回同一个 401，白打一次请求还拖慢整批。
   */
  const readOneAccount = async (
    account: StoredAccount,
    readOptions: { force?: boolean },
  ): Promise<CreditsReadout> => {
    const driver = runtime.credits
    if (driver?.readForAccount === undefined) {
      return {
        kind: 'failure',
        failure: { at: now(), path: 'credits', code: 'not_supported', message: '该供应商不提供逐账号余额。' },
      }
    }
    const knownFailure =
      options.pool?.isBenched(account) === true &&
      classifyUnavailable(account.unavailableCode, account.unavailableMessage) === 'auth'
    if (knownFailure) {
      return {
        kind: 'failure',
        failure: {
          at: now(),
          path: 'credits',
          code: account.unavailableCode ?? 'CREDENTIAL_INVALID',
          message: account.unavailableMessage ?? '该账号的登录态已失效。',
        },
      }
    }
    return driver.readForAccount(account, readOptions)
  }

  /**
   * 单个账号的额度——给**懒加载**用。
   *
   * 90 个账号一次性读完要 5 秒以上（2 并发 + 120ms 间隔，见下），抽屉就一直空着。
   * 分成一条一条之后，前端可以先把账号行画出来，数字随到随填。缓存仍在
   * `core/credits.ts` 的 per-account memo 上，所以重复请求不会重复打上游。
   */
  const accountCredits = async (accountId: string): Promise<CreditsReadout> => {
    if (accounts === undefined) {
      return {
        kind: 'failure',
        failure: { at: now(), path: 'credits', code: 'not_supported', message: '该供应商不提供账号列表。' },
      }
    }
    const rows = await accounts.list({ force: false })
    const account = rows.find((row) => row.id === accountId)
    if (account === undefined) {
      return {
        kind: 'failure',
        failure: { at: now(), path: 'credits', code: 'account_not_found', message: `没有这个账号：${accountId}` },
      }
    }
    return readOneAccount(account, {})
  }

  const credits = async (creditsOptions: { force?: boolean; withAccounts?: boolean } = {}) => {
    const driver = runtime.credits
    if (driver === undefined) {
      return {
        kind: 'failure' as const,
        failure: { at: now(), path: 'credits', code: 'not_supported', message: '该供应商不提供积分信息。' },
      }
    }
    const readOptions = creditsOptions.force === true ? { force: true } : {}
    const primary = await driver.read(readOptions)
    /*
     * 总额这一枪就被限流时，别再逐账号打 N 次。
     *
     * 实测：`points/v1/balance` 一旦进入 403 空 body 的窗口，对**同一批**账号
     * 连续请求只会把窗口续命（见 `docs/raccoon-upstream.md` §7.1）。旧行为是
     * 无视这次失败、照样把每个账号各打一遍，等于用户点一次「刷新」就往风控里
     * 再推 N 个请求。401 之类的失败**不**在这里拦：逐个标记失效账号是有意义的。
     */
    if (primary.kind === 'failure' && isThrottleFailure(primary.failure.message)) return primary
    if (driver.readForAccount === undefined || accounts === undefined) return primary
    /*
     * 逐账号数字是**可选**的：它会为每个账号各打一次上游（10 个账号 = 10 次请求），
     * 而额度面板只需要总额。只有账号页（要显示每行余额）才传 `withAccounts`。
     */
    if (creditsOptions.withAccounts !== true) return primary

    const rows = await accounts.list({ force: false })
    if (rows.length === 0) return primary

    /*
     * 限并发 2 + 每个账号之间 120ms 间隔。
     *
     * 3 路并发是之前的取法，实测仍然会把网关的突发限流打出来：10 个账号意味着
     * 一轮 10 个 `balance` 请求，几秒内集中到达，正是「连打十几次稳定 403」那个
     * 形态（`docs/raccoon-upstream.md` §7.1）。官方客户端是 2 路串行中继，这里
     * 对齐它；这块只是「每行余额」的辅助信息，多花一两秒无所谓。
     */
    const read: Array<{
      account: (typeof rows)[number]
      route: string
      label?: string
      readout: Awaited<ReturnType<NonNullable<typeof driver.readForAccount>>>
    }> = []
    const queue = [...rows]
    const worker = async (): Promise<void> => {
      for (;;) {
        const account = queue.shift()
        if (account === undefined) return
        const label = account.label ?? account.phone
        const route = accounts.routeOf(account)
        /*
         * 已经确认登录态失效的账号不再去问上游。
         *
         * 它们每一轮都会返回同一个 401（这是"等一会儿也不会好"的定义），所以
         * 每次打开抽屉都白打一次请求、还会让 10 个账号的读取慢上一档。直接把它
         * 已知的失败当作这一行的读数交出去：界面上的 `—` 与原因一字不差，只是
         * 省掉了必然失败的那次往返。
         */
        read.push({
          account,
          route,
          ...(label === undefined ? {} : { label }),
          readout: await readOneAccount(account, readOptions),
        })
        // 逐个之间留出间隔：同一批账号背靠背请求正是上游看到的突发形态。
        if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, CREDITS_ACCOUNT_SPACING_MS))
      }
    }
    await Promise.all(Array.from({ length: CREDITS_ACCOUNT_CONCURRENCY }, () => worker()))
    // 保持账号表顺序：并发完成顺序不可预测，按 store 顺序重排一次。
    const order = new Map(rows.map((row, index) => [row.id, index]))
    read.sort((left, right) => (order.get(left.account.id) ?? 0) - (order.get(right.account.id) ?? 0))
    return mergeCredits(primary, read)
  }

  const catalogView = async (viewOptions: { force?: boolean } = {}) => {
    const catalog = runtime.catalog
    if (catalog === undefined) return { models: [] as CatalogModelView[], refreshedAt: null, selection: null }
    let models = catalog.current()
    if (models.length === 0 || viewOptions.force === true) {
      const snapshot = await catalog.read(viewOptions.force === true ? { force: true } : {})
      models = snapshot.models
    }
    const enabledIds = catalog.enabledIds()
    const enabled = new Set(enabledIds)
    const selection = enabledIds.length === models.length ? null : enabledIds
    return {
      models: models.map((model) => ({ ...model, enabled: enabled.has(model.id) })),
      refreshedAt: catalog.refreshedAt(),
      selection,
    }
  }

  const accountsView = async (): Promise<AccountsView> => {
    /*
     * 打开账号页时补全"只有 token"的账号（导入的账号没有手机号）。
     *
     * 必须**等它完成**再列账号，否则用户第一次打开看到的还是「账号 3」——
     * 那正是他报的问题。代价是一次上游往返，所以给 4 秒上限：超时就先渲染，
     * 补全结果下次可见（供应商标记了已查过的账号，不会反复打上游）。
     */
    if (accounts?.enrichProfiles !== undefined) {
      await Promise.race([
        accounts.enrichProfiles().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 4_000)),
      ])
    }
    const rows = accounts === undefined ? [] : await accounts.list({ force: true })
    const poolEnabled = runtime.preferences === undefined ? false : await runtime.preferences.poolEnabled()
    const activeId =
      runtime.preferences === undefined || rows.length === 0 ? undefined : await runtime.preferences.activeAccountId()
    const lastPick = runtime.lastPick?.()
    return {
      ok: true,
      accounts: rows.map(accountRow),
      ...(activeId === undefined ? {} : { activeId }),
      rotating: poolEnabled,
      ...(lastPick?.accountId === undefined ? {} : { lastUsedId: lastPick.accountId }),
      ...(lastPick === undefined ? {} : { lastUsedAt: lastPick.at }),
    }
  }

  const poolView = async (): Promise<PoolStateView> => {
    const state = options.pool === undefined ? { total: 0, healthy: 0 } : await options.pool.state()
    const enabled = runtime.preferences === undefined ? false : await runtime.preferences.poolEnabled()
    return { ok: true, enabled, active: enabled && state.healthy > 1, total: state.total, healthy: state.healthy }
  }

  return {
    descriptor,
    runtime,
    status,
    diagnostics,
    credits,
    accountCredits,
    catalogView,
    saveSelection: async (ids) => (runtime.catalog === undefined ? [] : runtime.catalog.saveSelection(ids)),
    accounts: accountsView,
    pool: poolView,
    accountView: accountRow,
    credentialView,
    accountSummary,
    providerState: () => options.providerState?.(),
  }
}

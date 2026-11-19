/**
 * The vendor registry.
 *
 * One `mount()` per vendor replaces what used to be two bespoke mount functions
 * in `src/index.ts` (one of which registered routes before checking whether the
 * vendor was even enabled, and one of which had a dead `registerRoutes` callback
 * that nothing called).
 *
 * Order of operations, deliberately: build the runtime → verify it against its
 * own capability declaration → build the surface → plan routes → register
 * routes → register the provider adapter. A retirement of any step removes only
 * that step's work, and one vendor's failure can never take another's route down.
 *
 * @module dsh-connect-desktop/core/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess, type AdapterRegistrationHandle, type ImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { VendorModule, VendorRuntime, VendorSurface } from '../vendor-sdk/contracts.js'
import { assertRuntime } from '../vendor-sdk/conformance.js'
import { createAccountPool, type AccountPool } from './pool.js'
import { createChatRuntime, type ChatRuntime } from './provider.js'
import { createVendorSurface } from './surface.js'
import { planVendorRoutes } from './routes.js'
import { mountRoutes } from './http.js'
import { createVendorDeps } from './deps.js'
import { describeVendorConfig } from './config-fields.js'
import { vendorRoute } from '../shared/views.js'
import type { VendorStatusView } from '../shared/views.js'
import type { Logger, VendorDescriptor } from '../vendor-sdk/contracts.js'

export interface RegistryOptions {
  ctx: Context
  /** 这份实例声明的 provider 名（守卫会独占它们）。 */
  claimedProviders: readonly string[]
  /**
   * 读一家的完整配置片（用户覆盖 + 声明的默认值），以及把它写回 profile。
   *
   * 由 index.ts 绑定 settings 服务；registry 不自己碰 settings，因为它还要在
   * CLI（没有宿主上下文）里被复用。
   */
  readVendorConfig?: (vendorId: string) => Record<string, unknown>
  /** 只看用户层（profile 里显式写过的字段）；用来判断"这一项改过没有"。 */
  readVendorOverrides?: (vendorId: string) => Record<string, unknown>
  writeVendorConfig?: (vendorId: string, patch: Record<string, unknown>, expectedRevision?: number) => Promise<void>
  /** 当前配置版本号，用于乐观锁；缺省表示宿主没有版本概念。 */
  configRevision?: (vendorId: string) => number | undefined
  /** One process-level token for every vendor; the header name is shared. */
  csrfToken: string
  logger: Logger
  /** The whole plugin config; the registry slices it per vendor. */
  config: () => Record<string, unknown>
  /** Whether a vendor is switched on (`enabled` inside its own slice). */
  enabled: (vendorId: string) => boolean
  attachments: () => AttachmentStore | undefined
  imageAccess: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /** Tell selectors to re-list a provider's models. */
  modelsUpdated: (providerId: string) => void
  /**
   * 这一份实例是否持有 provider 的"所有权"。
   *
   * 同一进程里本插件被挂载两次时，两份会争夺 `loomy` / `raccoon` 这两个 provider
   * 名字：先到的注册成功，后到的永远失败，而失败那份还可能把先到的挤掉（异步
   * 释放）。由 `apply()` 用进程级令牌决定唯一的所有者，非所有者完全不参与注册。
   */
  ownsProviders?: boolean
}

export interface MountedVendor {
  readonly descriptor: VendorModule['descriptor']
  readonly runtime: VendorRuntime
  readonly surface: VendorSurface
  readonly pool?: AccountPool
  readonly chat: ChatRuntime
  /** Re-read the account list and reconcile the provider routes. */
  reconcile(): Promise<void>
  dispose(): void
}

export interface VendorRegistry {
  mount(module: VendorModule): Promise<MountedVendor | undefined>
  mounted(): readonly MountedVendor[]
  /** Every vendor's status, one entry per mounted vendor, failures isolated. */
  status(): Promise<VendorStatusView[]>
  reconcileAll(): Promise<void>
}

/**
 * 注册守卫：**独占**声明的 provider 名。
 *
 * 宿主的 `registerAdapter(providers, adapter)` 是全局名字空间，撞名直接抛
 * `DUPLICATE_ADAPTER`，而且**没有**"覆盖"参数 —— 一旦别的插件先注册了
 * `loomy`/`raccoon`（实测：dsh-our-free-model 的 channel-pack），我们这一份就永远
 * 拿不到，模型选择器缺组。
 *
 * 所以在挂载的**最早阶段**（任何 await 之前）把 `ctx.llm.registerAdapter` 包一层：
 * 其它插件对我们已声明名字的注册会被**过滤掉**（剩下的照常注册），全部被过滤时
 * 返回一个空操作 handle。效果：
 *
 * - 我们先挂载：我们抢到名字，对方拿到的是"少了这两个名字"的注册；
 * - 对方先挂载：它的注册已经落地，我们抢不到 —— 但从此以后**任何人**重挂载都会
 *   被过滤，等对方释放（热重载/重装）我们立刻接手。
 *
 * 恢复原方法挂在插件 fiber 的 effect 上。
 */
function installRegisterGuard(
  ctx: Context,
  claimed: readonly string[],
  log: (intercepted: { provider: string; by: string }) => void,
): { ownedByGuard: (adapter: unknown) => boolean; setOwned: (adapter: unknown) => void } {
  const llm = ctx.get?.('llm') as { registerAdapter?: unknown } | undefined
  // `ctx.get('llm')` 在 apply 阶段可能还没就绪：守卫退化为"不拦截"，注册仍按原逻辑
  // 走（撞名时由重试/回收兜底）。
  if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    return { ownedByGuard: () => false, setOwned: () => undefined }
  }
  const claimedSet = new Set(claimed)
  const original = llm.registerAdapter.bind(llm) as typeof llm.registerAdapter
  let ownedAdapter: unknown

  const wrapped = ((providers: readonly string[], adapter: unknown, ...rest: unknown[]) => {
    const ours = ownedAdapter !== undefined && adapter === ownedAdapter
    if (ours) return original(providers as string[], adapter, ...rest)
    const conflicted = providers.filter((provider) => claimedSet.has(provider))
    if (conflicted.length === 0) return original(providers as string[], adapter, ...rest)
    const restProviders = providers.filter((provider) => !claimedSet.has(provider))
    for (const provider of conflicted) log({ provider, by: 'unknown plugin' })
    if (restProviders.length === 0) {
      // 整个注册都是我们的名字：给它一个"成功"的空 handle，它的幂等逻辑就会跳过。
      const noop = () => {}
      noop.replace = () => undefined
      return noop as never
    }
    return original(restProviders as string[], adapter, ...rest)
  }) as typeof llm.registerAdapter

  ctx.effect(
    () => {
      llm.registerAdapter = wrapped
      return () => {
        llm.registerAdapter = original
      }
    },
    'dsh-connect-desktop: provider registration guard',
  )

  return {
    ownedByGuard: (adapter) => ownedAdapter !== undefined && adapter === ownedAdapter,
    setOwned: (adapter) => {
      ownedAdapter = adapter
    },
  }
}

export function createVendorRegistry(options: RegistryOptions): VendorRegistry {
  const vendors: MountedVendor[] = []
  const guard = installRegisterGuard(options.ctx, options.claimedProviders, (intercepted) => {
    options.logger.warn(
      `dsh-connect-desktop: 已拦截其它插件对 provider "${intercepted.provider}" 的注册（该名字由本插件独占）`,
    )
  })

  const mount = async (module: VendorModule): Promise<MountedVendor | undefined> => {
    const { descriptor } = module
    const configSlice = (): Record<string, unknown> => {
      const vendorsConfig = options.config()['vendors']
      if (vendorsConfig === null || typeof vendorsConfig !== 'object') return {}
      const slice = (vendorsConfig as Record<string, unknown>)[descriptor.id]
      // Defaults come from the descriptor, so a profile with no `vendors.<id>`
      // entry still gets the vendor's documented base URL and TTLs.
      return {
        ...descriptor.config.defaults,
        ...(slice !== null && typeof slice === 'object' ? (slice as Record<string, unknown>) : {}),
      }
    }

    const runtime = await module.create(
      createVendorDeps({
        descriptor,
        config: configSlice,
        logger: options.logger,
        attachments: options.attachments,
        imageAccess: options.imageAccess,
        modelsUpdated: () => options.modelsUpdated(descriptor.id),
      }),
    )

    // A declaration that does not match the implementation is a boot-time
    // failure, not a user staring at an empty tab.
    assertRuntime(module, runtime)

    const pool = runtime.accounts === undefined ? undefined : createAccountPool({ accounts: runtime.accounts })

    /** provider 注册状态：/status 要能回答"为什么选择器里没有这一组"。 */
    let providerState: { registered: boolean; routes: readonly string[]; models?: number; error?: string } = {
      registered: false,
      routes: [],
    }
    /** 适配器当前真正能给出的模型数（不是目录里的条数）。 */
    const adapterModelCount = (): number => {
      try {
        return chat.provider.getModels().length
      } catch {
        return 0
      }
    }
    const surface = createVendorSurface({
      descriptor,
      runtime,
      ...(pool === undefined ? {} : { pool }),
      providerState: () => ({ ...providerState, models: adapterModelCount() }),
    })
    const chat = createChatRuntime({
      vendorId: descriptor.id,
      chat: runtime.chat,
      routes: () => [],
      baseUrl: () => String(configSlice()['baseURL'] ?? descriptors0(descriptor)),
      models: () => runtime.catalog?.enabledModels() ?? [],
      ...(runtime.catalog === undefined ? {} : { onModelsRead: () => runtime.catalog?.kickRefresh() }),
      resolveCredential: (route) => runtime.resolveCredential(route),
      ...(pool === undefined ? {} : { pool: { markHealthy: (id) => pool.markHealthy(id), markUnavailable: (id, code, message) => pool.markUnavailable(id, code, message) } }),
      ...(runtime.catalog === undefined ? {} : {}),
      attachments: options.attachments,
      imageAccess: options.imageAccess,
      logger: options.logger,
    })

    let registration: AdapterRegistrationHandle | undefined
    let signature = ''
    /** 已经为当前这一代登录态预热过目录（换账号/重新检测后重置）。 */
    let warmed = false

    /**
     * 后台预热模型目录。
     *
     * 为什么必须显式做：`getModels()` 是同步的，而目录只存在于内存里；模型选择器
     * 看不到这一组就不会去问 provider，于是 `kickRefresh()` 那条懒惰路径永远不会被
     * 触发——"没有模型所以不显示，不显示所以没人加载模型"的死锁。
     *
     * 旧实现是在 `apply()` 里为 Loomy 单独做这件事；搬进 registry 后变成通用行为，
     * 所以每家供应商都受益。失败不抛：目录读失败是上游问题，由状态视图报告。
     */
    let warmTimer: ReturnType<typeof setTimeout> | undefined
    let warmAttempts = 0
    const WARM_MAX_ATTEMPTS = 12

    /**
     * 后台预热模型目录，失败则退避重试。
     *
     * 只做一次是不够的：目录读取可能因为网络抖动失败，而失败后**没有任何东西**
     * 会再来一次（`kickRefresh` 依赖有人调 `getModels()`，选择器看到空组就不调）。
     * 结果就是"provider 注册了、组却一直空着"——和没注册一样看不见。
     */
    const warmCatalog = (): void => {
      const catalog = runtime.catalog
      if (catalog === undefined || warmed) return
      warmed = true
      void catalog
        .read({})
        .then(() => {
          warmAttempts = 0
          if (warmTimer !== undefined) {
            clearTimeout(warmTimer)
            warmTimer = undefined
          }
          options.modelsUpdated(descriptor.id)
        })
        .catch(() => {
          warmed = false
          if (warmAttempts >= WARM_MAX_ATTEMPTS) return
          warmAttempts += 1
          if (warmTimer !== undefined) return
          const delay = Math.min(1_000 * 2 ** Math.min(warmAttempts - 1, 4), 10_000)
          warmTimer = setTimeout(() => {
            warmTimer = undefined
            warmCatalog()
          }, delay)
          if (typeof warmTimer === 'object' && warmTimer !== null && 'unref' in warmTimer) {
            ;(warmTimer as { unref?: () => void }).unref?.()
          }
        })
    }

    /**
     * 释放当前注册，并**等它真的把名字让出来**。
     *
     * cordis 的 `ctx.effect` 释放是异步的（execute 里的 `yield () => …` 会作为
     * 异步清理任务跑），而 `AdapterRegistrationHandle()` 是 fire-and-forget：
     * 它返回的 promise 被丢弃。所以"注销后立刻重新注册"会撞上
     * `DUPLICATE_ADAPTER: an adapter for provider "raccoon" is already registered`
     * ——名字还在 Map 里，清理由下一拍完成。
     */
    const disposeRegistration = async (): Promise<void> => {
      if (registration === undefined) return
      try {
        registration()
      } catch (error) {
        options.logger.warn(`dsh-connect-desktop: ${descriptor.id} 注销旧注册失败`, error)
      }
      registration = undefined
      // 让异步清理跑完再继续。
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    /**
     * 注册 provider 路由；撞上尚未落地的注销时重试。
     *
     * 重试而不是直接失败：这个竞态的成因是宿主内部的异步释放，而不是配置错误，
     * 用户不该因为一次时序问题就永远失去这一组模型。
     */
    const registerWithRetry = async (ids: string[]): Promise<void> => {
      const attemptDelays = [0, 20, 80]
      let lastError: unknown
      for (const delay of attemptDelays) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        try {
          registration = options.ctx.llm.registerAdapter(ids, chat.adapter)
          return
        } catch (error) {
          lastError = error
          const code = (error as { code?: unknown } | null)?.code
          if (code !== 'DUPLICATE_ADAPTER') throw error
        }
      }
      throw lastError
    }

    /**
     * 串行化 reconcile。
     *
     * 挂载时的 `reconcile()` 与 `loader/volatile-update` 触发的 `reconcileAll()` 会
     * 并发进来；两边都 `await` 完凭据读取后再看 `registration === undefined`，于是
     * **都去注册**，第二个撞 `DUPLICATE_ADAPTER` 并在 /status 里留下永久的失败记录。
     * 串行之后"检查 → 注册"成为一个不可分割的段落。
     */
    let reconcileQueue: Promise<void> = Promise.resolve()

    /**
     * 注册被"别人先占了名字"时的回收定时器。
     *
     * 现场证据：同一进程里出现两份本插件实例，先到的那份拿到 `loomy`/`raccoon`，
     * 后到的那份注册失败；先到的随后被释放（热重载/重复挂载的清理），名字空出来，
     * 但失败的那份**再没有人叫它重试**——最终两边都没有 provider，选择器全空。
     *
     * 所以注册失败于 `DUPLICATE_ADAPTER` 时必须自己安排重试，而不是把失败写进
     * `/status` 等用户重启。
     */
    let reclaimTimer: ReturnType<typeof setTimeout> | undefined
    let reclaimAttempts = 0
    const RECLAIM_MAX_ATTEMPTS = 20

    const scheduleReclaim = (): void => {
      if (reclaimTimer !== undefined) return
      if (reclaimAttempts >= RECLAIM_MAX_ATTEMPTS) return
      reclaimAttempts += 1
      // 指数退避，上限 5s：既不空转，也能在对方的异步释放落地后立刻接手。
      const delay = Math.min(500 * 2 ** Math.min(reclaimAttempts - 1, 4), 5_000)
      reclaimTimer = setTimeout(() => {
        reclaimTimer = undefined
        void reconcile()
      }, delay)
      // 不让这个定时器拖住宿主退出。
      if (typeof reclaimTimer === 'object' && reclaimTimer !== null && 'unref' in reclaimTimer) {
        ;(reclaimTimer as { unref?: () => void }).unref?.()
      }
    }

    const clearReclaim = (): void => {
      if (reclaimTimer !== undefined) {
        clearTimeout(reclaimTimer)
        reclaimTimer = undefined
      }
      reclaimAttempts = 0
    }

    const reconcile = (): Promise<void> => {
      const run = reconcileQueue.then(reconcileOnce, reconcileOnce)
      // 队列自身不能因为一次失败而断掉。
      reconcileQueue = run.catch(() => undefined)
      return run
    }

    const reconcileOnce = async (): Promise<void> => {
      try {
        if (options.ownsProviders === false) {
          providerState = {
            registered: false,
            routes: [],
            error: '同一进程内有另一份本插件实例持有 provider（双挂载），本实例不参与注册',
          }
          return
        }
        const routes = await runtime.routes()
        const next = routes.map((entry) => `${entry.route}\u0000${entry.displayName}`).join('\u0001')
        const installed = chat.setRoutes(routes)
        // 已经按**同一套路由**注册过，才是真正的"没事可做"。
        // 只看 `next === signature` 会漏掉"先签出、后登录"：第一次 reconcile 记下了
        // 签名却因为没登录而放弃注册，第二次进来签名没变就直接早退，永远不会注册。
        if (next === signature && registration !== undefined) return
        if (!options.enabled(descriptor.id)) {
          signature = next
          providerState = { registered: false, routes: [], error: 'vendor 已被配置禁用' }
          return
        }
        // 没有可用登录态就不注册 provider：模型选择器里不该出现一个"选了必失败"
        // 的分组（README 承诺过"没装客户端就没有这一组"）。这是通用规则，不针对
        // 某一家供应商。
        if ((descriptor.providerVisibility ?? 'signed-in') === 'signed-in') {
          const availability = await surface.status({ allowNetwork: false }).catch(() => undefined)
          if (availability === undefined || !availability.available) {
            const reason = availability?.unavailableReason ?? '状态读取失败'
            await disposeRegistration()
            // 清掉签名：登录态出现后必须重新走一遍注册。
            signature = ''
            providerState = { registered: false, routes: [], error: `没有可用登录态：${reason}` }
            options.logger.info(`dsh-connect-desktop: ${descriptor.id} 暂不注册 provider（${reason}）`)
            return
          }
        }
        const ids = installed.map((entry) => entry.route)
        if (ids.length === 0) {
          await disposeRegistration()
          signature = ''
          providerState = { registered: false, routes: [], error: '该供应商当前没有路由（账号或配置被清空）' }
          return
        }
        if (registration === undefined) {
          // **必须在注册前认领**：守卫要能认出"这是本插件自己的适配器"，
          // 否则它会连我们的首次注册一起过滤掉（表现为 registered:true 但实际
          // 一个 provider 都没注册——比失败更难发现）。
          guard.setOwned(chat.adapter)
          await registerWithRetry(ids)
        } else registration.replace(ids)
        // 只有真的注册（或替换）成功后，才认为"这套路由已经落地"。
        signature = next
        providerState = { registered: true, routes: ids }
        clearReclaim()
        options.logger.info(
          `dsh-connect-desktop: ${descriptor.id} provider 路由已注册（${ids.join(', ')}），适配器模型数=${adapterModelCount()}`,
        )
        // Selectors must re-list: both the provider set and each provider's
        // display name changed.
        options.modelsUpdated(ids[0] ?? descriptor.id)
        // 注册之后再预热：模型就绪时再通知一次，选择器的那一组才会真正长出条目。
        warmCatalog()
      } catch (error) {
        // 失败必须同时落在日志和 /status 上：只看日志的话，用户看到的是"选择器里
        // 什么都没有"，而真正的原因藏在启动日志里。
        const raw = error instanceof Error ? error.message : String(error)
        const duplicate = (error as { code?: unknown } | null)?.code === 'DUPLICATE_ADAPTER'
        // 把宿主的英文原文换成可执行的说明：这个名字很可能被**别的插件**占了
        // （实测：dsh-our-free-model 的 channel-pack 内置了同名的 loomy/raccoon 适配器）。
        const message = duplicate
          ? `provider 名 "${descriptor.id}" 已被另一个插件占用（${raw}）。` +
            '常见原因是同时安装了 dsh-our-free-model（它内置了同名的 loomy/raccoon 频道）。' +
            '在 profile 的 dsh.profile.bundles 里把 dsh-connect-desktop 放到那个插件之前即可；' +
            '它会检测到重名并让位。或者禁用其中之一。'
          : raw
        providerState = { registered: false, routes: providerState.routes, error: message }
        options.logger.error(`dsh-connect-desktop: ${descriptor.id} provider 注册失败：${message}`, error)
        // 名字被别的实例占着：等它释放后接手，而不是永远失败。
        if (duplicate) scheduleReclaim()
      }
    }

    if (options.enabled(descriptor.id)) {
      const specs = planVendorRoutes({
        surface,
        onChanged: reconcile,
        invalidate: () => {
          runtime.credentials.invalidate()
          // 登录态变了（重新检测、登录、登出）：允许下一次 reconcile 重新预热目录。
          warmed = false
        },
        ...(options.readVendorConfig === undefined ? {} : { readVendorConfig: options.readVendorConfig }),
        ...(options.writeVendorConfig === undefined ? {} : { writeVendorConfig: options.writeVendorConfig }),
        ...(options.configRevision === undefined ? {} : { configRevision: options.configRevision }),
        describeConfig: (target: VendorDescriptor) =>
          describeVendorConfig(
            target,
            options.readVendorConfig?.(target.id) ?? {},
            options.readVendorOverrides?.(target.id) ?? {},
          ),
        logger: options.logger,
      })
      mountRoutes(options.ctx, {
        vendorId: descriptor.id,
        csrfToken: options.csrfToken,
        specs,
        logger: options.logger,
        pathFor: (suffix) => vendorRoute(descriptor.id, suffix),
      })
    } else {
      // Disabled means *nothing* is registered — not "routes exist but the
      // model group is hidden". The old wiring exposed the credential export
      // route of a vendor the user had switched off.
      options.logger.info(`dsh-connect-desktop: ${descriptor.id} 已禁用，不注册任何路由`)
    }

    // 任何 adapter 拓扑变化都可能是"占着名字的那一份被释放了"：立刻尝试接手，
    // 不必等退避定时器。自己注册成功时 registered 为 true，这里是空操作。
    options.ctx.on?.('llm/adapters-updated', () => {
      if (!providerState.registered) scheduleReclaim()
    })

    options.ctx.effect(() => {
      void reconcile()
      return () => {
        registration?.()
        registration = undefined
      }
    }, `dsh-connect-desktop: ${descriptor.id} provider route`)

    const mounted: MountedVendor = {
      descriptor,
      runtime,
      surface,
      ...(pool === undefined ? {} : { pool }),
      chat,
      reconcile,
      dispose() {
        registration?.()
        registration = undefined
      },
    }
    vendors.push(mounted)
    return mounted
  }

  return {
    async mount(module) {
      try {
        return await mount(module)
      } catch (error) {
        // A vendor failure must never break another vendor's route.
        options.logger.error(`dsh-connect-desktop: ${module.descriptor.id} 挂载失败（其它供应商不受影响）`, error)
        return undefined
      }
    },

    mounted() {
      return vendors
    },

    async status() {
      const views = await Promise.all(
        vendors.map(async (vendor) => {
          try {
            return await vendor.surface.status()
          } catch (error) {
            options.logger.warn(`dsh-connect-desktop: ${vendor.descriptor.id} 状态读取失败`, error)
            return {
              id: vendor.descriptor.id,
              displayName: vendor.descriptor.displayName,
              capabilities: vendor.descriptor.capabilities,
              accent: vendor.descriptor.accent,
              available: false,
              unavailableReason: error instanceof Error ? error.message : String(error),
              credential: { found: false, sourcePath: '', sourceOrigin: 'none', candidates: [] },
              account: null,
              catalog: { total: 0, enabled: 0, refreshedAt: null },
              enabledModelIds: [],
            } satisfies VendorStatusView
          }
        }),
      )
      return views
    },

    async reconcileAll() {
      await Promise.all(vendors.map((vendor) => vendor.reconcile()))
    },
  }
}

/** The descriptor's declared default base URL, for the rare vendor that has none. */
function descriptors0(descriptor: VendorModule['descriptor']): string {
  return String(descriptor.config.defaults['baseURL'] ?? '')
}

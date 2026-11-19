/**
 * 预热模型目录：注册 provider 还不够，**选择器要有模型才显示那一组**。
 *
 * 这是一个真实踩到的死锁：
 *
 * 1. `getModels()` 是同步的，只能读内存里的目录；
 * 2. 内存目录在挂载时是空的（首次运行没有磁盘缓存）；
 * 3. 选择器因为"没有模型"不显示这一组，于是没人调用 `getModels()`；
 * 4. `getModels()` 里挂的懒惰 `kickRefresh()` 因此永远不触发。
 *
 * 旧实现是在 `apply()` 里为 Loomy 单独做一次后台预热，搬进 registry 后一度丢掉，
 * 结果小浣熊（以及任何 `providerVisibility: 'signed-in'` 的供应商）只要没打开过设置
 * 卡片，就永远不出现在选择器里。
 *
 * 这些用例用**真实模块 + 真实 registry**，只把 fetch 换成假网关。
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, registryOf, resetProviderOwnershipForTests } from '../../lib/index.js'
import { modelsBody, tempDir } from './helpers.mjs'

/** 一份未过期的 Raccoon 令牌（JWT 只需要 payload.exp）。 */
function raccoonAuthDocument() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = Buffer.from(JSON.stringify({ exp, iss: 'xiaohuanxiong.com/iam' })).toString('base64url')
  return JSON.stringify({ access_token: `h.${payload}.s`, office_identity: 'personal' })
}

/**
 * 假网关的目录响应。
 *
 * 形状必须与真实网关一致：`data.categories[].type === 'chat'` 下面才是 `models`。
 * 猜错形状的后果是"读到了但解析出 0 个模型"——比 404 更难发现。
 */
const CATALOG_BODY = {
  code: 0,
  message: 'success',
  data: {
    categories: [
      {
        type: 'chat',
        // 注意：id 不能以 `raccoon-` 开头——那是上游的内部 agent 路由，
        // `parseModel` 会主动丢弃（`INTERNAL_MODEL_PREFIX`）。
        default_model: 'sn-glm-5-3-flash',
        models: [
          {
            name: 'sn-glm-5-3-flash',
            description: 'GLM-5-3-Flash',
            model_name: 'sn-glm-5-3-flash',
            visible: true,
            tags: ['general'],
            params: { context_window: 1_000_000, max_tokens: 100_000 },
          },
          {
            name: 'sn-sensechat-5-5',
            description: 'SenseChat 5.5',
            model_name: 'sn-sensechat-5-5',
            visible: true,
            tags: ['general', 'vision'],
            params: { context_window: 32_000, max_tokens: 8_000 },
          },
        ],
      },
    ],
  },
}

function fakeContext() {
  const paths = []
  const seen = new Set()
  const adapters = []
  const emitted = []
  const context = {
    fiber: { entry: { options: { id: 'dsh-connect-desktop' } } },
    logger: { info() {}, warn() {}, error() {} },
    get() {
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ settings: { configure() {} } })
        return
      }
      if (services.includes('webServer')) {
        callback({
          effect(fn) {
            fn()
            return () => {}
          },
          webServer: {
            register(route) {
              // 与真宿主一致：同路径第二次注册直接抛。
              if (seen.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
              seen.add(route.path)
              paths.push(route.path)
              return () => {}
            },
          },
        })
        return
      }
    },
    on() {
      return () => {}
    },
    emit(name, ...args) {
      emitted.push([name, ...args])
    },
    llm: {
      registerAdapter(routes, adapter) {
        adapters.push({ routes: [...routes], adapter })
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }
  return { context, paths, adapters, emitted }
}

/** 隔离：临时 HOME/DSH_HOME，并用 RACCOON_AUTH_FILE 钉住凭据（绝不读真实客户端）。 */
function isolate(t, dir, authPath) {
  const saved = new Map()
  for (const key of ['HOME', 'DSH_HOME', 'RACCOON_AUTH_FILE', 'LOOMY_AUTH_SESSION_FILE']) saved.set(key, process.env[key])
  process.env.HOME = join(dir, 'home')
  process.env.DSH_HOME = join(dir, 'dsh-home')
  process.env.RACCOON_AUTH_FILE = authPath
  delete process.env.LOOMY_AUTH_SESSION_FILE
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function stubFetch(t) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    // 两家都要有合法目录，否则"模型数为 0"是夹具的问题，不是产品的问题。
    const body = target.includes('model_catalog')
      ? CATALOG_BODY
      : target.includes('/models')
        ? modelsBody()
        : { code: 0, message: 'ok', data: {} }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  t.after(() => {
    globalThis.fetch = original
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('condition was not met before the timeout')
}

test('a signed-in vendor has models in the picker without anyone asking first', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  const { context, adapters, emitted } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, { enabled: true, vendors: {} })

  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)

  // 关键断言：**没有任何人调用 getModels()**，目录也要自己长出来。
  const raccoon = registry.mounted().find((vendor) => vendor.descriptor.id === 'raccoon')
  assert.ok(raccoon !== undefined)
  await waitFor(() => raccoon.runtime.catalog.current().length > 0)

  const models = raccoon.chat.provider.getModels()
  assert.ok(models.length > 0, 'the model picker must have something to show')
  assert.ok(
    models.every((model) => model.provider === 'raccoon'),
    'every model is stamped with the vendor route, or the picker groups them wrong',
  )

  // provider 注册了，且模型就绪后又一次通知选择器重列。
  const raccoonAdapters = adapters.filter((entry) => entry.routes.includes('raccoon'))
  assert.ok(raccoonAdapters.length >= 1, 'the raccoon provider route is registered')
  // 事件与目录读取是两条异步链：等它到齐再断言，否则只是抢跑。
  await waitFor(
    () => emitted.filter(([name, provider]) => name === 'llm/models-updated' && provider === 'raccoon').length >= 2,
  )
})

test('re-checking refreshes the catalog for vendors that were signed out', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  // 先写一个**已过期**的令牌：挂载时这一家不该注册。
  const past = Math.floor(Date.now() / 1000) - 60
  writeFileSync(authPath, JSON.stringify({ access_token: `h.${Buffer.from(JSON.stringify({ exp: past })).toString('base64url')}.s` }))
  isolate(t, dir, authPath)
  stubFetch(t)

  const { context, adapters } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, { enabled: true, vendors: {} })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)
  await delay(80)
  assert.deepEqual(adapters.filter((entry) => entry.routes.includes('raccoon')), [], 'expired ⇒ no provider route')

  // 桌面端重新登录后，用户点「重新检测」：凭据缓存失效，下一次 reconcile 应该注册。
  writeFileSync(authPath, raccoonAuthDocument())
  const raccoon = registry.mounted().find((vendor) => vendor.descriptor.id === 'raccoon')
  raccoon.runtime.credentials.invalidate()
  await registry.reconcileAll()
  await delay(120)

  assert.ok(
    adapters.some((entry) => entry.routes.includes('raccoon')),
    're-checking must register the provider once a usable credential appears',
  )
})
/**
 * `/status` 必须回答"provider 到底注册了没有"。
 *
 * "已登录但模型选择器里没有这一组"是最难从外部判断的症状：凭据、目录、路由都可能
 * 正常，唯独注册失败，而失败原因只出现在启动日志里。把它变成一次 `/status` 请求。
 */
test('status reports whether the provider route actually registered', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  const { context } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, { enabled: true, vendors: {} })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)
  await delay(120)

  const status = await registry.status()

  const raccoon = status.find((vendor) => vendor.id === 'raccoon')
  assert.ok(raccoon !== undefined)
  assert.equal(raccoon.provider?.registered, true, '注册成功后 status 必须这么说')
  assert.deepEqual([...(raccoon.provider?.routes ?? [])], ['raccoon'])

  const loomy = status.find((vendor) => vendor.id === 'loomy')
  assert.ok(loomy !== undefined)
  // Loomy 是 providerVisibility: 'always'，没登录也注册（首次调用会把原因说清楚）。
  assert.equal(loomy.provider?.registered, true)
})

test('a signed-out vendor reports why its provider is not registered', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  const past = Math.floor(Date.now() / 1000) - 60
  writeFileSync(authPath, JSON.stringify({ access_token: `h.${Buffer.from(JSON.stringify({ exp: past })).toString('base64url')}.s` }))
  isolate(t, dir, authPath)
  stubFetch(t)

  const { context } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, { enabled: true, vendors: {} })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)
  await delay(120)

  const raccoon = (await registry.status()).find((vendor) => vendor.id === 'raccoon')
  assert.ok(raccoon !== undefined)
  assert.equal(raccoon.provider?.registered, false)
  // 原因必须可执行，而不是一句 "unknown"。
  assert.match(raccoon.provider?.error ?? '', /登录态|过期|未检测/u)
})

/**
 * 注册竞态：并发 reconcile 与"注销异步生效"都会撞 `DUPLICATE_ADAPTER`。
 *
 * 真实症状（用 /status 抓到的原文）：
 * `provider: { registered: false, error: 'an adapter for provider "raccoon" is already registered' }`
 * ——模型选择器因此永远看不到这一组，而凭据、目录、路由全都正常。
 *
 * 两个成因都在这里被复现：
 * 1. 假 host 的 `registerAdapter` **同步**占用名字，但 disposer 像 cordis 一样
 *    **异步**释放；
 * 2. 挂载时的 reconcile 与一次 volatile-update 的 reconcileAll 并发进入。
 */
function racingContext() {
  /** 名字 → 持有者 token。 */
  const owners = new Map()
  const adapters = []
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-desktop' } } },
    logger: { info() {}, warn() {}, error() {} },
    get() {
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ settings: { configure() {} } })
        return
      }
      if (services.includes('webServer')) {
        callback({
          effect(fn) {
            fn()
            return () => {}
          },
          webServer: { register: () => () => {} },
        })
        return
      }
    },
    on() {
      return () => {}
    },
    emit() {},
    llm: {
      registerAdapter(routes) {
        // 与真宿主一致：任一名字被占就整体失败（all-or-nothing）。
        for (const route of routes) {
          if (owners.has(route)) {
            const error = new Error(`an adapter for provider "${route}" is already registered`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        const token = Symbol('registration')
        for (const route of routes) owners.set(route, token)
        adapters.push([...routes])
        const dispose = () => {
          // cordis 的 effect 释放是异步任务：名字要等一拍才真正让出来。
          setTimeout(() => {
            for (const [route, holder] of owners) if (holder === token) owners.delete(route)
          }, 5)
        }
        dispose.replace = (next) => {
          for (const [route, holder] of owners) if (holder === token) owners.delete(route)
          for (const route of next) {
            if (owners.has(route)) {
              const error = new Error(`an adapter for provider "${route}" is already registered`)
              error.code = 'DUPLICATE_ADAPTER'
              throw error
            }
            owners.set(route, token)
          }
        }
        return dispose
      },
    },
  }
  return { ctx, adapters, owners }
}

test('concurrent reconciles never leave a vendor unregistered', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  const { ctx, owners } = racingContext()
  resetProviderOwnershipForTests()
  apply(ctx, { enabled: true, vendors: {} })
  const registry = registryOf(ctx)

  // 挂载 reconcile 仍在飞的时候，模拟一次 settings 写入触发的 reconcileAll。
  await registry.reconcileAll()
  await registry.reconcileAll()

  await waitFor(() => registry.mounted().length === 2)
  await delay(400)

  const status = await registry.status()
  for (const vendor of status) {
    assert.equal(
      vendor.provider?.registered,
      true,
      `${vendor.id} 必须注册成功；实际 error=${vendor.provider?.error ?? '(none)'}`,
    )
  }
  // 只有**本次有凭据的**那一家能读出目录；Loomy 在这个临时 HOME 下没有登录态，
  // 模型数为 0 是正确行为（它的 providerVisibility 是 'always'，注册但不为空壳）。
  const raccoon = status.find((vendor) => vendor.id === 'raccoon')
  assert.ok((raccoon?.provider?.models ?? 0) > 0, 'raccoon 的适配器必须真的能给出模型')
  // 名字确实被这一份注册持有，而不是"注册了个空壳"。
  assert.ok(owners.has('loomy'))
  assert.ok(owners.has('raccoon'))
})

test('a stale registration whose disposal has not landed is retried, not reported as failure', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  const { ctx } = racingContext()
  resetProviderOwnershipForTests()
  apply(ctx, { enabled: true, vendors: {} })
  const registry = registryOf(ctx)
  await waitFor(() => registry.mounted().length === 2)
  await delay(150)

  const raccoon = registry.mounted().find((vendor) => vendor.descriptor.id === 'raccoon')
  assert.ok(raccoon !== undefined)

  // 注销（模拟登出/重新检测）后立刻要求重新注册：旧名字的清理还没落地。
  await registry.reconcileAll()
  await delay(1)
  await registry.reconcileAll()

  await delay(200)
  const status = (await registry.status()).find((vendor) => vendor.id === 'raccoon')
  assert.equal(status?.provider?.registered, true, `重试后必须注册成功；error=${status?.provider?.error ?? ''}`)
})

/**
 * 残留注册：名字被占、但持有者已经"注销在途"。
 *
 * 这是用户机器上抓到的真实现象的精确复制：`registerAdapter` 抛
 * `DUPLICATE_ADAPTER`，而本地 `registration` 却是 `undefined`（上一次注销的异步
 * 清理还没跑完）。修法是重试；这条用例把"前两次一定撞车、第三次才放行"钉死，
 * 确保重试真的被执行，而不是靠运气。
 */
function staleOwnershipContext(staleFailures) {
  let failuresLeft = staleFailures
  const adapters = []
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-desktop' } } },
    logger: { info() {}, warn() {}, error() {} },
    get() {
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ settings: { configure() {} } })
        return
      }
      if (services.includes('webServer')) {
        callback({
          effect(fn) {
            fn()
            return () => {}
          },
          webServer: { register: () => () => {} },
        })
        return
      }
    },
    on() {
      return () => {}
    },
    emit() {},
    llm: {
      registerAdapter(routes) {
        if (failuresLeft > 0) {
          failuresLeft -= 1
          const error = new Error(`an adapter for provider "${routes[0]}" is already registered`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
        adapters.push([...routes])
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }
  return { ctx, adapters, remaining: () => failuresLeft }
}

test('a registration that collides with a not-yet-disposed owner is retried', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  // 前两次注册被残留的旧注册挡住，第三次应当成功。
  const { ctx, adapters, remaining } = staleOwnershipContext(4)
  resetProviderOwnershipForTests()
  apply(ctx, { enabled: true, vendors: {} })
  const registry = registryOf(ctx)
  await waitFor(() => registry.mounted().length === 2)
  await delay(300)

  assert.equal(remaining(), 0, '重试必须把 4 次撞车全部消化掉')
  const raccoon = (await registry.status()).find((vendor) => vendor.id === 'raccoon')
  assert.equal(raccoon?.provider?.registered, true, `重试后必须注册成功：${raccoon?.provider?.error ?? ''}`)
  assert.ok(adapters.some((routes) => routes.includes('raccoon')), '真的调用了 registerAdapter')
})

/**
 * 双挂载：同一进程里本插件被挂载两次。
 *
 * 现场证据（来自运行中的宿主）：两份实例都报
 * `an adapter for provider "loomy"/"raccoon" is already registered`，而 `models`
 * 分别是 5/7 —— 说明适配器都好，只是名字被另一份占着。先到的那份随后被释放，
 * 失败的那份因为没人再叫它而永远停在失败状态，最终**两边都没有 provider**。
 *
 * 两条防线：让位（不抛错、不抢路由）+ 回收（名字空出来后自己接手）。
 */
test('a second mount yields the routes instead of throwing', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  const paths = []
  const seen = new Set()
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-desktop' } } },
    logger: { info() {}, warn() {}, error() {} },
    get() {
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ settings: { configure() {} } })
        return
      }
      if (services.includes('webServer')) {
        callback({
          effect(fn) {
            fn()
            return () => {}
          },
          webServer: {
            register(route) {
              // 与真宿主一致：同路径第二次注册直接抛。
              if (seen.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
              seen.add(route.path)
              paths.push(route.path)
              return () => {}
            },
          },
        })
        return
      }
    },
    on() {
      return () => {}
    },
    emit() {},
    llm: {
      registerAdapter() {
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }

  // 两次 apply = 同一进程内两次挂载。第二次必须**不抛**，且让出已占用的路径。
  assert.doesNotThrow(() => {
    resetProviderOwnershipForTests()
    apply(ctx, { enabled: true, vendors: {} })
    resetProviderOwnershipForTests()
    apply(ctx, { enabled: true, vendors: {} })
  })

  await delay(300)
  const vendorPaths = paths.filter((path) => !path.endsWith('/status'))
  const statusPaths = paths.filter((path) => path.endsWith('/status'))
  assert.equal(statusPaths.length, 1, '状态路由只注册了一份')
  // 每个供应商路由也只注册一次（第二次让位）。
  const duplicates = vendorPaths.filter((path, index) => vendorPaths.indexOf(path) !== index)
  assert.deepEqual(duplicates, [], `重复注册的路径：${duplicates.join(', ')}`)
})

/**
 * 目录预热失败要自己重试。
 *
 * "provider 注册了、组却一直空着"和"没注册"在选择器里是同一种表现：都没有条目。
 * 而且失败后没有任何东西会再来一次（`kickRefresh` 依赖有人调 `getModels()`，
 * 空组不会被调用）。所以预热必须自带退避重试。
 */
test('a failed catalog warm-up retries until it succeeds', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)

  // 前两次目录请求失败，第三次才成功。
  const original = globalThis.fetch
  let catalogCalls = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('model_catalog')) {
      catalogCalls += 1
      if (catalogCalls <= 2) {
        return new Response(JSON.stringify({ code: 500, message: 'upstream hiccup' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(CATALOG_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = target.includes('/models') ? modelsBody() : { code: 0, message: 'ok', data: {} }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const { context } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, { enabled: true, vendors: {} })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)

  const raccoon = registry.mounted().find((vendor) => vendor.descriptor.id === 'raccoon')
  assert.ok(raccoon !== undefined)
  // 退避首跳 1s、次跳 2s：给足时间让第三跳成功。
  await waitFor(() => raccoon.runtime.catalog.current().length > 0, 8_000)
  assert.ok(catalogCalls >= 3, `预热必须重试（实际请求 ${catalogCalls} 次）`)
})

/**
 * 进程级单例：双挂载时第二份**不参与** provider 注册。
 *
 * 现场证据：两份实例都报 `already registered`，`models` 却有 5/7 —— 两边都有能力
 * 注册，只是名字只有一个。与其让它们互相抢（先到的还可能被挤掉），不如明确指定
 * 唯一所有者：先挂载的那份负责 provider，后来的那份只服务路由并说明原因。
 */
test('a second mount does not compete for the provider names', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  resetProviderOwnershipForTests()

  const first = fakeContext()
  apply(first.context, { enabled: true, vendors: {} })
  const firstRegistry = registryOf(first.context)
  await waitFor(() => firstRegistry.mounted().length === 2)
  await delay(200)

  // 第二份：同一进程，新的 ctx。
  const second = fakeContext()
  apply(second.context, { enabled: true, vendors: {} })
  const secondRegistry = registryOf(second.context)
  await waitFor(() => secondRegistry.mounted().length === 2)
  await delay(200)

  // 第一份照常注册（它是所有者）。
  const firstStatus = await firstRegistry.status()
  for (const vendor of firstStatus) {
    assert.equal(vendor.provider?.registered, true, `owner 必须注册：${vendor.id} ${vendor.provider?.error ?? ''}`)
  }

  // 第二份明确让位，而不是报一个会让人误判的 "already registered"。
  const secondStatus = await secondRegistry.status()
  for (const vendor of secondStatus) {
    assert.equal(vendor.provider?.registered, false)
    assert.match(vendor.provider?.error ?? '', /另一份本插件实例|双挂载/u)
  }
})

/**
 * 注册守卫：其它插件**再也无法**注册我们的 provider 名。
 *
 * 这回答了"能不能强制覆盖"：宿主没有覆盖 API、也无法摘掉别人的注册，但可以在
 * `ctx.llm.registerAdapter` 上装守卫 —— 其它插件对我们已声明名字的注册会被过滤掉。
 * 组合 bundle 顺序（首次抢占），provider 名从此归我们。
 */
test('the registration guard filters other plugins out of our provider names', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)
  stubFetch(t)

  resetProviderOwnershipForTests()

  const registrations = []
  const owners = new Map()
  const intercepted = []
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-desktop' } } },
    logger: { info() {}, warn(message) { intercepted.push(String(message)) }, error() {} },
    get(name) {
      // guard 在 apply 早期就要拿到 llm：这里直接给一个最小服务。
      if (name === 'llm') return llm
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ settings: { configure() {} } })
        return
      }
      if (services.includes('webServer')) {
        callback({
          effect(fn) {
            fn()
            return () => {}
          },
          webServer: { register: () => () => {} },
        })
        return
      }
    },
    on() {
      return () => {}
    },
    emit() {},
  }
  const llm = {
    registerAdapter(routes) {
      // 与真宿主一致：任一名字被占就整体失败（all-or-nothing）。
      for (const route of routes) {
        if (owners.has(route)) {
          const error = new Error(`an adapter for provider "${route}" is already registered`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
      }
      const token = Symbol('reg')
      for (const route of routes) owners.set(route, token)
      registrations.push([...routes])
      const dispose = () => {}
      dispose.replace = () => {}
      return dispose
    },
  }

  ctx.llm = llm

  apply(ctx, { enabled: true, vendors: {} })
  const registry = registryOf(ctx)
  await waitFor(() => registry.mounted().length === 2)
  await delay(150)

  // 我们的注册已落地。
  assert.ok(registrations.some((routes) => routes.includes('raccoon')))
  assert.ok(registrations.some((routes) => routes.includes('loomy')))

  // 现在：另一个插件试图注册 loomy / raccoon（以及它自己的名字）。
  const other = llm.registerAdapter(['loomy', 'raccoon', 'other-vendor'], { marker: 'other' })
  assert.ok(typeof other === 'function', 'a (filtered) registration handle is returned')
  // 它自己的名字注册成功，我们的名字被过滤。
  assert.deepEqual(registrations.at(-1), ['other-vendor'])
  // 守卫记下了这次拦截。
  assert.ok(intercepted.some((line) => line.includes('"loomy"')))
  assert.ok(intercepted.some((line) => line.includes('"raccoon"')))

  // 我们的名字仍归我们：没有新的占用者写入。
  assert.equal(registrations.filter((routes) => routes.includes('raccoon')).length, 1)
})

/**
 * Loomy 只有**一条**路由：账号再多也不会长成 `loomy-N` 分组。
 *
 * 旧形态是 `slots`（每个账号一条路由），模型选择器因此按账号复制整份模型目录；
 * 现在与小浣熊一致——`routes()` 恒为 `['loomy']`，"谁付费"由轮换开关与当前账号
 * 在**每次调用**时决定，不写进会话身份。
 */
test('loomy exposes a single route and rotates across accounts', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, undefined)
  // 必须 stub：`resolveCredential` 会调 precheck（真的打 /user/identity）。
  stubFetch(t)
  const { createLoomyModule, createVendorDeps } = await import('../../lib/index.js')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const module = createLoomyModule()
  const storageDir = join(dir, 'state')
  mkdirSync(storageDir, { recursive: true })
  // 两个插件账号：slot 1 与 slot 3（slot 不重用，删除后空出 2）。
  writeFileSync(
    join(storageDir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'a1', material: 's'.repeat(40), origin: 'plugin', addedAt: 1 },
        { id: 'a3', material: 't'.repeat(40), origin: 'plugin', addedAt: 2, slot: 3 },
      ],
    }),
  )
  writeFileSync(join(storageDir, 'state.json'), JSON.stringify({ version: 1, selection: null, catalog: [], refreshedAt: null, poolEnabled: true }))

  const runtime = await module.create(
    createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir,
    }),
  )

  // 路由集合与账号数量无关。
  const routes = await runtime.routes()
  assert.deepEqual(
    routes.map((entry) => entry.route),
    ['loomy'],
    '两个账号也只暴露一条路由',
  )
  assert.equal(routes[0].displayName, 'Loomy')

  // 轮换开着 → 两个账号都会被选中；选择与路由名无关。
  const seen = new Set()
  for (let i = 0; i < 40; i += 1) {
    const pick = await runtime.resolveCredential('loomy')
    seen.add(pick.accountId)
  }
  assert.deepEqual([...seen].sort(), ['a1', 'a3'], '轮换应当覆盖两个账号')

  // 旧的 `loomy-N` 名字不再是注册过的路由，也没有绑定语义：它只是被忽略。
  const viaLegacy = await runtime.resolveCredential('loomy-3')
  assert.ok(['a1', 'a3'].includes(viaLegacy.accountId), '旧路由名不再绑定账号')
  // "最近调用"只在**成功**后更新（core 的 markHealthy 是唯一信号）：
  // 单纯 resolveCredential 不该留下标记，否则失败的账号也会顶着标签。
  assert.equal(runtime.lastPick(), undefined, 'selecting a credential is not a success')
  await runtime.accounts.markHealthy('a3')
  assert.deepEqual(runtime.lastPick()?.accountId, 'a3')
})

/**
 * 导入的账号只有 token，没有手机号 —— 账号行只能显示「账号 3」。
 *
 * `user_info` 能用同一个 token 换回真实号码，所以账号页打开时补全一次并写回。
 * 这条用例同时钉住两件事：**补全发生**，且**平台昵称不占用 label**（否则手机号
 * 永远显示不出来）。
 */
test('imported accounts get their phone backfilled from user_info', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)

  const storageDir = join(dir, 'state', 'raccoon')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(storageDir, { recursive: true })
  // 一个只有 token 的账号（导入形态）。
  writeFileSync(
    join(storageDir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [{ id: 'rc-1', material: 'x'.repeat(40), origin: 'plugin', addedAt: 1 }],
    }),
  )

  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('user_info')) {
      return new Response(JSON.stringify({ code: 0, data: { phone: '16500004524', name: 'RaccoonSofia', id: 42 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = target.includes('model_catalog') ? CATALOG_BODY : { code: 0, message: 'ok', data: {} }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const { createRaccoonModule, createVendorDeps, createVendorSurface } = await import('../../lib/index.js')
  const module = createRaccoonModule()
  const runtime = await module.create(
    createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir,
    }),
  )
  const surface = createVendorSurface({ descriptor: module.descriptor, runtime })

  const view = await surface.accounts()
  const row = view.accounts.find((account) => account.id === 'rc-1')
  assert.ok(row !== undefined)
  assert.equal(row.phone, '16500004524', '手机号被补全')
  assert.equal(row.userId, '42')
  // 平台昵称不能占据 label：否则账号行永远显示 RaccoonSofia 而不是号码。
  assert.equal(row.label, undefined, 'label 只属于用户自己起的名字')

  // 再次打开：token 有效时不重复查询（enrich 内部去重）。
  const again = await surface.accounts()
  assert.equal(again.accounts.find((account) => account.id === 'rc-1')?.phone, '16500004524')
})

/**
 * "最近调用"必须落在**成功**的账号上，而不是"被选中后又失败被跳过"的账号。
 *
 * 用户报的现象：「上次成功」和「轮询已跳过」同时出现在同一个账号上——因为旧实现
 * 在**选中时**记录标签。现在只有 core 的 `markHealthy`（真的收到内容）才更新它。
 */
test('a failed pick never becomes the "last success" marker', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, undefined)
  stubFetch(t)
  const { createLoomyModule, createVendorDeps } = await import('../../lib/index.js')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const storageDir = join(dir, 'state')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(
    join(storageDir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'good', material: 'g'.repeat(40), origin: 'plugin', addedAt: 1 },
        { id: 'bad', material: 'b'.repeat(40), origin: 'plugin', addedAt: 2, slot: 3 },
      ],
    }),
  )

  const module = createLoomyModule()
  const runtime = await module.create(
    createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir,
    }),
  )

  // 选中某个账号（只发生选择，没有成功调用）→ 不该留下标记。
  await runtime.resolveCredential('loomy')
  assert.equal(runtime.lastPick(), undefined)

  // 成功调用（core 会调 markHealthy）→ 标记落在它身上。
  await runtime.accounts.markHealthy('good')
  assert.equal(runtime.lastPick()?.accountId, 'good')

  // 之后 bad 被 bench：标记仍然是 good，不会飘到被跳过的账号上。
  await runtime.accounts.markUnavailable('bad', 'no_points', '积分不足')
  assert.equal(runtime.lastPick()?.accountId, 'good')
})

/**
 * Raccoon 的额度视图要带上账单明细（`kind: 'balance'` + `ledger: true`）。
 *
 * 明细是**附加**信息：它失败时余额必须照常显示，否则一次账单接口抖动会让整个
 * 积分面板消失。
 */
test('raccoon credits carry the ledger, and a bills failure does not hide the balance', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)

  const storageDir = join(dir, 'state', 'raccoon')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(
    join(storageDir, 'accounts.json'),
    JSON.stringify({ version: 1, accounts: [{ id: 'rc-1', material: 'y'.repeat(40), origin: 'plugin', addedAt: 1, phone: '16500004524' }] }),
  )

  const original = globalThis.fetch
  let billsMode = 'ok'
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/points/v1/balance')) {
      return new Response(
        JSON.stringify({ code: 0, data: { available_points: 13300, daily_points: 300 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (target.includes('/points/v2/bills')) {
      if (billsMode === 'fail') {
        return new Response('forbidden', { status: 403 })
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            items: [
              { points: -2, created_at: '2026-11-19T16:04:34+08:00', event_name: '桌面端 LLM 对话消耗' },
            ],
            has_more: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const body = target.includes('model_catalog') ? CATALOG_BODY : { code: 0, message: 'ok', data: {} }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const { createRaccoonModule, createVendorDeps, createVendorSurface } = await import('../../lib/index.js')
  const module = createRaccoonModule()
  const runtime = await module.create(
    createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir,
    }),
  )
  const surface = createVendorSurface({ descriptor: module.descriptor, runtime })

  const ok = await surface.credits({ force: true })
  assert.equal(ok.kind, 'ok')
  if (ok.kind === 'ok') {
    // 账号页会把"桌面身份"也算一个成员，所以这里是逐账号求和（1 或 2 份）。
    assert.ok((ok.credits.fields['available'] ?? 0) >= 13300)
    // 逐账号合并：每个成员各一条，所以按"至少有一条"断言。
    assert.ok((ok.credits.records?.length ?? 0) >= 1, '明细随余额一起返回')
    assert.equal(ok.credits.records?.[0].direction, 'debit')
  }

  // 账单接口挂了：余额仍在，明细为空——不是整块失败。
  billsMode = 'fail'
  const degraded = await surface.credits({ force: true })
  assert.equal(degraded.kind, 'ok', '账单失败不该让余额消失')
  if (degraded.kind === 'ok') {
    assert.ok((degraded.credits.fields['available'] ?? 0) >= 13300, '余额仍在')
    assert.equal(degraded.credits.records, undefined, '账单失败时没有明细，但不影响余额')
  }
})

/**
 * 余额被限流（403）但明细可用时，**只显示明细**，并如实说明缺了什么。
 *
 * 这是用户实际遇到的情况：`points/v1/balance` 返回 403 空 body，`points/v2/bills`
 * 却是 200。整块报错会把能拿到的明细一起丢掉——最坏的结果。
 */
test('a rate-limited balance still shows the ledger', async (t) => {
  const dir = tempDir(t)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, raccoonAuthDocument())
  isolate(t, dir, authPath)

  const storageDir = join(dir, 'state', 'raccoon')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(
    join(storageDir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [{ id: 'rc-1', material: 'z'.repeat(40), origin: 'plugin', addedAt: 1, phone: '16500004524' }],
    }),
  )

  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/points/v1/balance')) {
      // 网关限流的形态：403 + 空 body（不是业务错误信封）。
      return new Response('', { status: 403 })
    }
    if (target.includes('/points/v2/bills')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            items: [
              { points: -2, created_at: '2026-11-19T16:04:34+08:00', event_name: '桌面端 LLM 对话消耗' },
              { points: 100, created_at: '2026-11-19T15:00:00+08:00', event_name: '邀请奖励' },
            ],
            has_more: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const body = target.includes('model_catalog') ? CATALOG_BODY : { code: 0, message: 'ok', data: {} }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const { createRaccoonModule, createVendorDeps, createVendorSurface } = await import('../../lib/index.js')
  const module = createRaccoonModule()
  const runtime = await module.create(
    createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir,
    }),
  )
  const surface = createVendorSurface({ descriptor: module.descriptor, runtime })

  // 不带逐账号：余额 403、明细 200 → 成功返回明细。
  const read = await surface.credits({ force: true })
  assert.equal(read.kind, 'ok', '明细可用时不能整块失败')
  if (read.kind === 'ok') {
    assert.deepEqual(read.credits.fields, {}, '余额缺失就是空桶，不伪造 0')
    assert.equal(read.credits.partial, 'balance_unavailable', 'UI 需要它来解释为什么没有总额')
    assert.equal(read.credits.records?.length, 2)
    assert.equal(read.credits.records?.[1].direction, 'credit')
  }

  // 带逐账号：逐账号余额同样 403，但总额层的明细不能被 merge 丢掉。
  const withAccounts = await surface.credits({ force: true, withAccounts: true })
  assert.equal(withAccounts.kind, 'ok')
  if (withAccounts.kind === 'ok') {
    assert.ok((withAccounts.credits.records?.length ?? 0) >= 2, '逐账号全失败不该吞掉明细')
  }
})

/**
 * `apply()` 的挂载契约（`core/registry.ts`）。
 *
 * 重构前这里是两段手写挂载：一段在判断 enabled **之前**就注册了全部路由（于是
 * "关掉供应商"仍然暴露导出登录态的接口），另一段声明了一个从未被调用的
 * `registerRoutes` 回调。这些测试钉住新的规矩：
 *
 * - 插件级只有一条 `GET /status`，一次回答所有供应商；
 * - 每家供应商的路由由能力声明推导；
 * - 关掉的供应商**一条路由都不注册**；
 * - 挂载是异步的，但 `apply()` 立刻返回（不能因为网络或磁盘阻塞宿主启动）。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, registryOf, resetProviderOwnershipForTests } from '../../lib/index.js'
import { modelsBody, tempDir, writeAuthFile } from './helpers.mjs'

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

/** 记录注册路径的假 ctx。 */
function fakeContext() {
  const paths = []
  const emitted = []
  const adapters = []
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
            // 真宿主按 `(kind, path)` 唯一注册：同路径第二次注册直接抛错。
            // 假 host 若不抛，就会放过"同一 suffix 注册两条"这类只在真机上炸的 bug。
            register(route) {
              if (paths.includes(route.path)) {
                throw new Error(`webserver: duplicate exact route "${route.path}"`)
              }
              paths.push(route.path)
              return () => {}
            },
          },
        })
        return
      }
      throw new Error(`unexpected inject: ${services.join(',')}`)
    },
    on() {
      return () => {}
    },
    emit(name, ...args) {
      emitted.push([name, ...args])
    },
    llm: {
      registerAdapter(routes, adapter) {
        adapters.push({ routes, adapter })
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }
  return { context, paths, emitted, adapters }
}

/** 隔离：临时 DSH_HOME + 固定的登录态文件，绝不读本机真实凭据。 */
function isolate(t, dir, authFile) {
  const saved = new Map()
  for (const key of ['HOME', 'DSH_HOME', 'LOOMY_AUTH_SESSION_FILE']) saved.set(key, process.env[key])
  process.env.HOME = join(dir, 'home')
  process.env.DSH_HOME = join(dir, 'dsh-home')
  if (authFile === undefined) delete process.env.LOOMY_AUTH_SESSION_FILE
  else process.env.LOOMY_AUTH_SESSION_FILE = authFile
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('apply() returns immediately and registers one status route for every vendor', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, writeAuthFile(dir))
  const { context, paths } = fakeContext()

  const started = Date.now()
  resetProviderOwnershipForTests()
  apply(context, { enabled: true, vendors: {} })
  assert.ok(Date.now() - started < 500, 'apply() must not wait for mounting')

  // 供应商级的状态路由是本插件唯一的全局入口。
  assert.ok(paths.includes('/plugins/dsh-connect-desktop/status'))

  const registry = registryOf(context)
  assert.ok(registry !== undefined)
  await waitFor(() => registry.mounted().length === 2)
  assert.deepEqual(
    registry.mounted().map((vendor) => vendor.descriptor.id),
    ['loomy', 'raccoon'],
  )
})

test('a switched-off vendor registers no route and no provider route', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, writeAuthFile(dir))
  const { context, paths, adapters } = fakeContext()

  resetProviderOwnershipForTests()

  apply(context, { enabled: true, vendors: { loomy: { enabled: false }, raccoon: { enabled: false } } })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)

  const vendorPaths = paths.filter((path) => path !== '/plugins/dsh-connect-desktop/status')
  assert.deepEqual(vendorPaths, [], '关闭的供应商连登录态导出口都不该存在')
  assert.deepEqual(adapters, [], '关闭的供应商不注册 provider 路由')
})

test('the master switch turns every vendor off, not just the model group', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, writeAuthFile(dir))
  const { context, paths } = fakeContext()

  resetProviderOwnershipForTests()

  apply(context, { enabled: false, vendors: {} })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)

  assert.deepEqual(paths, ['/plugins/dsh-connect-desktop/status'], '只有状态路由随宿主存在')
})

test('GET /status answers every vendor in one document', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, writeAuthFile(dir))
  const { context } = fakeContext()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify(modelsBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  let handler
  context.inject = ((inject) => (services, callback) => {
    if (services.includes('webServer')) {
      callback({
        effect(fn) {
          fn()
          return () => {}
        },
        webServer: {
          register(route) {
            if (route.path === '/plugins/dsh-connect-desktop/status') handler = route.handler
            return () => {}
          },
        },
      })
      return
    }
    if (services.includes('settings')) {
      callback({ settings: { configure() {} } })
      return
    }
    inject(services, callback)
  })(context.inject.bind(context))

  resetProviderOwnershipForTests()

  apply(context, { enabled: true, vendors: {} })
  const registry = registryOf(context)
  await waitFor(() => registry.mounted().length === 2)

  const captured = {}
  await handler(
    { method: 'GET', url: '/', headers: { host: '127.0.0.1:3000' }, socket: { localAddress: '127.0.0.1' }, on() {}, destroy() {} },
    {
      headersSent: false,
      writeHead(status, headers) {
        captured.status = status
        captured.headers = headers
        this.headersSent = true
      },
      end(payload) {
        captured.body = JSON.parse(payload)
        this.headersSent = true
      },
    },
  )

  assert.equal(captured.status, 200)
  assert.equal(captured.body.ok, true)
  assert.equal(typeof captured.body.csrfToken, 'string')
  assert.ok(Array.isArray(captured.body.vendors))
  assert.deepEqual(
    captured.body.vendors.map((vendor) => vendor.id),
    ['loomy', 'raccoon'],
  )
  for (const vendor of captured.body.vendors) {
    assert.equal(typeof vendor.capabilities.accounts, 'string')
    assert.equal(typeof vendor.available, 'boolean')
  }
  assert.equal(captured.headers['cache-control'], 'no-store')
})

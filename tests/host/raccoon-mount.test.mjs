/**
 * Raccoon vendor mount behavior.
 *
 * Two contracts, both from the migration plan:
 * - a machine with a readable Raccoon credential gets the `raccoon` route in
 *   addition to `loomy`, and mounting stays network-free;
 * - a machine without it gets **only** `loomy` — no extra group, no extra
 *   request, no failed chat.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, registryOf, resetProviderOwnershipForTests } from '../../lib/index.js'
import { jsonResponse, tempDir, writeAuthFile } from './helpers.mjs'

// 配置现在是"每家供应商一片"，不再有 raccoon* 前缀的平行字段。
const CONFIG = {
  enabled: true,
  vendors: {
    loomy: { baseURL: 'https://gateway.test/api/v1', catalogTtlMs: 600_000, creditsTtlMs: 60_000 },
    raccoon: {
      baseURL: 'https://raccoon.test/api/web/llm/v2',
      pointsURL: 'https://raccoon.test/api/web/points/v1/balance',
      clientVersion: '2.0.0',
      catalogTtlMs: 600_000,
      creditsTtlMs: 60_000,
    },
  },
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

/** 挂载是异步的（apply 立刻返回）；等两家都挂上再断言路由。 */
async function mountAndWait(context) {
  await waitFor(() => registryOf(context)?.mounted().length === 2)
  // 挂载完成 ≠ provider 注册完成：每次 reconcile 都在 effect 里异步跑（要读一次
  // 登录态）。等两个微任务周期，让"该注册的注册、该跳过的跳过"都落地。
  await delay(50)
  return registryOf(context)
}

/** 已经注册的 provider 路由集合（按供应商分组）。 */
function installedRoutes(registrations) {
  return registrations.map((entry) => entry.routes.join(','))
}

const CATALOG_BODY = {
  code: 0,
  message: 'success',
  data: {
    categories: [
      {
        type: 'chat',
        default_model: 'raccoon-090dd3',
        models: [
          { name: 'raccoon-090dd3', description: 'Raccoon-Work', visible: false, model_name: 'raccoon-090dd3', tags: [], params: {} },
          {
            name: 'sn-glm-5-3-flash',
            description: 'GLM-5-3-Flash',
            visible: true,
            model_name: 'sn-glm-5-3-flash',
            tags: ['general'],
            params: { context_window: 1_000_000, max_tokens: 100_000 },
            billing_multiplier: 0.2,
            billing_effective_multiplier: 0.2,
          },
        ],
      },
    ],
  },
}

function raccoonAuthDocument() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = Buffer.from(JSON.stringify({ exp, iss: 'xiaohuanxiong.com/iam' })).toString('base64url')
  return JSON.stringify({ access_token: `h.${payload}.s`, office_identity: 'personal' })
}

function fakeContext() {
  const registrations = []
  const seen = new Set()
  const emitted = []
  const context = {
    fiber: { entry: { options: { id: 'dsh-connect-desktop' } } },
    logger: { info() {}, warn() {}, error() {} },
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
            // 与真宿主一致：同路径第二次注册直接抛。
            register(route) {
              if (seen.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
              seen.add(route.path)
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
        const dispose = () => {}
        dispose.replace = () => {}
        registrations.push({ routes: [...routes], adapter })
        return dispose
      },
    },
  }
  return { context, registrations, emitted }
}

function isolate(t, dir, raccoonAuthPath) {
  const saved = new Map()
  for (const key of ['HOME', 'DSH_HOME', 'LOOMY_AUTH_SESSION_FILE', 'RACCOON_AUTH_FILE']) {
    saved.set(key, process.env[key])
  }
  process.env.HOME = join(dir, 'home')
  process.env.DSH_HOME = join(dir, 'dsh-home')
  delete process.env.LOOMY_AUTH_SESSION_FILE
  if (raccoonAuthPath === undefined) delete process.env.RACCOON_AUTH_FILE
  else process.env.RACCOON_AUTH_FILE = raccoonAuthPath
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function stubFetch(t, respond) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return respond(String(url))
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  return calls
}

test('raccoon route is registered when the client credential is readable', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir)
  const raccoonAuth = join(dir, 'raccoon-auth.json')
  writeFileSync(raccoonAuth, raccoonAuthDocument())
  process.env.RACCOON_AUTH_FILE = raccoonAuth
  writeAuthFile(dir)

  const calls = stubFetch(t, (url) =>
    url.includes('model_catalog') ? jsonResponse(CATALOG_BODY) : jsonResponse({ code: 0, data: [] }),
  )

  const { context, registrations } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, CONFIG)
  await mountAndWait(context)

  const routes = installedRoutes(registrations)
  assert.ok(routes.includes('loomy'), `loomy route registered (got ${routes.join(' | ')})`)
  assert.ok(routes.includes('raccoon'), `raccoon route registered (got ${routes.join(' | ')})`)

  // 挂载**不阻塞**在网络上：`apply()` 立刻返回，目录在后台预热。
  // 这里断言"预热确实发起了"——它是模型选择器能看到这一组的前提：
  // `getModels()` 是同步的，没人调用就没人加载，选择器会因为"没有模型"而不显示，
  // 于是永远不会有人调用（死锁）。
  assert.ok(
    calls.filter((url) => url.includes('model_catalog')).length >= 1,
    'a signed-in vendor warms its catalog in the background so the picker has models',
  )
})

test('raccoon route is absent without a credential, and nothing is fetched', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir)
  writeAuthFile(dir)

  const calls = stubFetch(t, () => jsonResponse(CATALOG_BODY))

  const { context, registrations } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, CONFIG)
  await mountAndWait(context)

  const routes = installedRoutes(registrations)
  assert.deepEqual(routes, ['loomy'])
  assert.equal(calls.filter((url) => url.includes('model_catalog')).length, 0, 'no Raccoon request without a credential')
})

test('raccoon route is skipped when raccoonEnabled is false', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir)
  const raccoonAuth = join(dir, 'raccoon-auth.json')
  writeFileSync(raccoonAuth, raccoonAuthDocument())
  process.env.RACCOON_AUTH_FILE = raccoonAuth
  writeAuthFile(dir)

  stubFetch(t, () => jsonResponse(CATALOG_BODY))

  const { context, registrations } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, { ...CONFIG, vendors: { ...CONFIG.vendors, raccoon: { ...CONFIG.vendors.raccoon, enabled: false } } })
  await mountAndWait(context)

  const routes = installedRoutes(registrations)
  assert.deepEqual(routes, ['loomy'])
})

test('an expired raccoon token does not register the route', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir)
  const exp = Math.floor(Date.now() / 1000) - 60
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  const raccoonAuth = join(dir, 'raccoon-auth.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(raccoonAuth, JSON.stringify({ access_token: `h.${payload}.s` }))
  process.env.RACCOON_AUTH_FILE = raccoonAuth
  writeAuthFile(dir)

  stubFetch(t, () => jsonResponse(CATALOG_BODY))

  const { context, registrations } = fakeContext()
  resetProviderOwnershipForTests()
  apply(context, CONFIG)
  await mountAndWait(context)

  const routes = installedRoutes(registrations)
  assert.deepEqual(routes, ['loomy'])
})

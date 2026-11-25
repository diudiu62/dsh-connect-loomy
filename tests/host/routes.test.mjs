/**
 * HTTP 守卫管线与能力门控（`core/http.ts` + `core/routes.ts`）。
 *
 * 重构前这条管线有两份拷贝，且已经漂移：一份没有请求体上限，一份的 loopback
 * 判断更弱。这些测试直接打在*唯一的*实现上，所以两边不可能再各自为政：
 * 方法 → loopback → content-type → CSRF（只有一个头名）→ 64KiB 上限 → 信封。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CSRF_HEADER, MAX_BODY_BYTES, mountAt, mountRoutes, planVendorRoutes } from '../../lib/index.js'

/** 只够喂给守卫的假请求。`socket.localAddress` 是 loopback 判断的输入。 */
function request({ method = 'GET', url = '/', headers = {}, body, localAddress = '127.0.0.1' } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers,
    socket: { localAddress },
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
    destroy() {},
  }
  // 让 readBody 的 for-await 语义成立：守卫只会在需要时订阅。
  queueMicrotask(() => {
    if (body !== undefined) listeners.get('data')?.(Buffer.from(body))
    listeners.get('end')?.()
  })
  return req
}

/** 记录状态码/响应体的假响应。 */
function response() {
  const captured = { status: 0, body: undefined, headers: {} }
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
      res.headersSent = true
    },
    end(payload) {
      captured.body = payload === undefined ? undefined : JSON.parse(payload)
      res.headersSent = true
    },
  }
  return { res, captured }
}

/** 在假 ctx 上装一条路由，返回可调用的 handler。 */
function mountOne(spec, paths = []) {
  const registered = []
  const ctx = {
    inject(_services, callback) {
      callback({
        effect(fn) {
          fn()
          return () => {}
        },
        webServer: {
          // 与真宿主一致：同路径第二次注册直接抛错。
          register(route) {
            if (registered.some((entry) => entry.path === route.path)) {
              throw new Error(`webserver: duplicate exact route "${route.path}"`)
            }
            registered.push(route)
            paths.push(route.path)
            return () => {}
          },
        },
      })
    },
  }
  mountAt(ctx, { path: '/x', csrfToken: 'tok', spec })
  return registered[0].handler
}

const GET_SPEC = { suffix: 'demo', methods: ['GET'], mutating: false, run: async () => ({ ok: true, hit: 'get' }) }
const POST_SPEC = {
  suffix: 'demo',
  methods: ['POST'],
  mutating: true,
  run: async ({ body }) => ({ ok: true, body: await body() }),
}

/** 合法请求必须带本机 Host 头（loopback 判断的前提）。 */
const LOCAL = { host: '127.0.0.1:3000', 'content-type': 'application/json' }

async function call(handler, options = {}) {
  const { res, captured } = response()
  // `undefined` 显式删掉默认头，用来构造"没有 content-type"的请求。
  const merged = { ...LOCAL, ...options.headers }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  await handler(request({ ...options, headers: merged }), res)
  return captured
}

test('the method guard answers 405 and names the allowed verbs', async () => {
  const handler = mountOne(POST_SPEC)
  const out = await call(handler, { method: 'DELETE' })
  assert.equal(out.status, 405)
  assert.equal(out.body.error.code, 'method_not_allowed')
  assert.match(out.body.error.message, /POST/u)
})

test('a Host header that is not this listener is rejected before anything runs', async () => {
  const handler = mountOne(GET_SPEC)
  const out = await call(handler, { headers: { host: 'attacker.example:3000' } })
  assert.equal(out.status, 403)
  assert.equal(out.body.error.code, 'host_not_allowed')
})

test('a cross-origin browser request is rejected', async () => {
  const handler = mountOne(GET_SPEC)
  const out = await call(handler, { headers: { host: '127.0.0.1:3000', origin: 'http://evil.example' } })
  assert.equal(out.status, 403)
  assert.equal(out.body.error.code, 'origin_not_allowed')
})

test('a mutating route needs JSON and the one CSRF header', async () => {
  const handler = mountOne(POST_SPEC)
  // 没有 content-type：先按"不是 JSON"拒掉。
  const noType = await call(handler, { method: 'POST', body: '{}', headers: { 'content-type': undefined } })
  assert.equal(noType.status, 415)
  assert.equal(noType.body.error.code, 'unsupported_media_type')

  const noToken = await call(handler, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(noToken.status, 403)
  assert.equal(noToken.body.error.code, 'csrf_invalid')
  assert.match(noToken.body.error.message, new RegExp(CSRF_HEADER, 'u'))

  const wrongToken = await call(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: 'nope' },
    body: '{}',
  })
  assert.equal(wrongToken.status, 403)

  const good = await call(handler, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: 'tok' },
    body: '{"hello":1}',
  })
  assert.equal(good.status, 200)
  assert.deepEqual(good.body, { ok: true, body: { hello: 1 } })
})

test('a GET never needs a token, even on a route that accepts writes', async () => {
  const spec = { ...POST_SPEC, methods: ['GET', 'POST'], run: async () => ({ ok: true, hit: 'read' }) }
  const handler = mountOne(spec)
  const out = await call(handler, {})
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, { ok: true, hit: 'read' })
})

test('the body cap is a shared constant, not a per-vendor guess', () => {
  assert.equal(MAX_BODY_BYTES, 64 * 1024)
})

test('a disabled vendor registers no route at all', () => {
  const paths = []
  const ctx = {
    inject(_services, callback) {
      callback({
        effect(fn) {
          fn()
          return () => {}
        },
        webServer: {
          register(route) {
            if (paths.includes(route.path)) {
              throw new Error(`webserver: duplicate exact route "${route.path}"`)
            }
            paths.push(route.path)
            return () => {}
          },
        },
      })
    },
  }
  const descriptor = {
    id: 'none',
    displayName: 'None',
    capabilities: {
      accounts: 'none',
      pool: false,
      login: ['none'],
      credits: { kind: 'none' },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
    accent: '#000',
    config: { schema: {}, defaults: {} },
  }
  const surface = {
    descriptor,
    runtime: { descriptor, credentials: {}, chat: { api: 'openai-completions' } },
    status: async () => ({}),
    diagnostics: async () => ({ view: {}, probes: [] }),
    credits: async () => ({ kind: 'failure', failure: { at: 0, path: '', code: '', message: '' } }),
    catalogView: async () => ({ models: [], refreshedAt: null, selection: null }),
    saveSelection: async (ids) => ids,
    accounts: async () => ({ ok: true, accounts: [], rotating: false }),
    pool: async () => ({ ok: true, enabled: false, active: false, total: 0, healthy: 0 }),
    accountView: (account) => account,
    credentialView: async () => ({ found: false, sourcePath: '', sourceOrigin: 'none', candidates: [] }),
    accountSummary: async () => null,
  }
  const specs = planVendorRoutes({ surface, onChanged: () => undefined, invalidate: () => undefined })
  assert.deepEqual(specs, [])
  mountRoutes(ctx, { vendorId: 'none', csrfToken: 'tok', specs, pathFor: (suffix) => `/p/none/${suffix}` })
  assert.deepEqual(paths, [], '关闭的供应商一条路由都不该留下')
})

/**
 * 回填手机号：一条只在供应商实现 `enrich` 时才存在的路由。
 *
 * 需求来源：手机号只存在于上游 `user_info`，早先的版本没在登录时存它，
 * 于是那批账号只能显示「账号 3」。这条路由让用户可以一次性把它们补回来。
 */
/** 只够 planVendorRoutes 用的最小 surface；`accountsExtra` 用来注入可选的账号能力。 */
function surfaceWith(capabilities, accountsExtra) {
  const descriptor = {
    id: 'acme',
    displayName: 'Acme',
    accent: '#000',
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: { kind: 'none' },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
      ...capabilities,
    },
    config: { schema: {}, defaults: {} },
  }
  return {
    descriptor,
    runtime: {
      descriptor,
      credentials: {},
      chat: { api: 'openai-completions' },
      accounts: {
        list: async () => [],
        add: async () => ({ id: 'a', replaced: false }),
        remove: async () => undefined,
        markUnavailable: async () => undefined,
        markHealthy: async () => undefined,
        routeOf: () => 'acme',
        displayNameOf: () => 'Acme',
        ...accountsExtra,
      },
    },
    status: async () => ({}),
    diagnostics: async () => ({ view: {}, probes: [] }),
    credits: async () => ({ kind: 'failure', failure: { at: 0, path: '', code: '', message: '' } }),
    catalogView: async () => ({ models: [], refreshedAt: null, selection: null }),
    saveSelection: async (ids) => ids,
    accounts: async () => ({ ok: true, accounts: [], rotating: false }),
    pool: async () => ({ ok: true, enabled: false, active: false, total: 0, healthy: 0 }),
    accountView: (account) => account,
    credentialView: async () => ({ found: false, sourcePath: '', sourceOrigin: 'none', candidates: [] }),
    accountSummary: async () => null,
  }
}

test('the enrich route exists only for a vendor that implements it', async () => {
  const withEnrich = planVendorRoutes({
    surface: surfaceWith({ accounts: 'multi' }, { enrich: async () => 3 }),
    onChanged: () => undefined,
    invalidate: () => undefined,
  })
  const enrichRoute = withEnrich.find((spec) => spec.suffix === 'accounts/enrich')
  assert.ok(enrichRoute !== undefined, '实现了 enrich 就有这条路由')

  const result = await enrichRoute.run({ req: { method: 'POST' }, query: new URLSearchParams(), body: async () => ({}) })
  assert.deepEqual(result, { ok: true, filled: 3 })

  // 没实现的供应商：路由根本不注册（调用方拿到 404，而不是一个永远失败的接口）。
  const withoutEnrich = planVendorRoutes({
    surface: surfaceWith({ accounts: 'multi' }, {}),
    onChanged: () => undefined,
    invalidate: () => undefined,
  })
  assert.equal(
    withoutEnrich.some((spec) => spec.suffix === 'accounts/enrich'),
    false,
    '没实现就不注册',
  )
})

/**
 * 「重新注册」：卡片上那个按钮的后端。
 *
 * 门槛与能力位一样严格：surface 不追踪 provider 状态（CLI、独立 surface）就根本
 * 不注册。行为面三条：成功回填注册结果、注册器抛错回 ok:false、缺省回落到普通
 * reconcile（测试/CLI 不传 onRegisterProvider 时路由依然可用）。
 */
test('the register route reports the provider state after a forced re-registration', async () => {
  let forced = 0
  const surface = surfaceWith({}, {})
  surface.providerState = () => ({ registered: forced > 0, routes: forced > 0 ? ['acme'] : [], ...(forced === 0 ? { error: '占位原因' } : {}) })
  const spec = planVendorRoutes({
    surface,
    onChanged: () => undefined,
    onRegisterProvider: async () => {
      forced += 1
    },
    invalidate: () => undefined,
  }).find((entry) => entry.suffix === 'register')
  assert.ok(spec !== undefined, 'providerState 存在 ⇒ register 路由被规划')

  const result = await spec.run({ req: { method: 'POST' }, query: new URLSearchParams(), body: async () => ({}) })
  assert.deepEqual(result, { ok: true, registered: true, routes: ['acme'] })
  assert.equal(forced, 1, '必须走 onRegisterProvider（manual 触发），而不是普通 reconcile')
})

test('a failing re-registration answers the unified failure envelope', async () => {
  const surface = surfaceWith({}, {})
  surface.providerState = () => ({ registered: false, routes: [], error: '还没走到' })
  const spec = planVendorRoutes({
    surface,
    onChanged: () => undefined,
    onRegisterProvider: async () => {
      throw new Error('宿主已经卸载了这一份')
    },
    invalidate: () => undefined,
  }).find((entry) => entry.suffix === 'register')

  const result = await spec.run({ req: { method: 'POST' }, query: new URLSearchParams(), body: async () => ({}) })
  assert.deepEqual(result, { ok: false, error: { code: 'register_failed', message: '宿主已经卸载了这一份' } })
})

test('without onRegisterProvider the register route degrades to a plain reconcile', async () => {
  let reconciled = 0
  const surface = surfaceWith({}, {})
  surface.providerState = () => ({ registered: false, routes: [] })
  const spec = planVendorRoutes({
    surface,
    onChanged: () => {
      reconciled += 1
    },
    invalidate: () => undefined,
  }).find((entry) => entry.suffix === 'register')
  assert.ok(spec !== undefined, 'providerState 存在 ⇒ 路由仍被规划（缺省退化为 reconcile）')

  const result = await spec.run({ req: { method: 'POST' }, query: new URLSearchParams(), body: async () => ({}) })
  assert.equal(result.ok, true)
  assert.equal(reconciled, 1)
})

test('the import route refuses an unrecognized document instead of a silent zero', async () => {
  const { createVendorSurface } = await import('../../lib/index.js')
  const capabilities = {
    accounts: 'single',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: true,
    adopt: false,
    diagnostics: false,
  }
  const descriptor = { id: 'acme', displayName: 'Acme', accent: '#000', capabilities }
  const surface = createVendorSurface({
    descriptor,
    runtime: {
      descriptor,
      credentials: { read: async () => ({ found: false, problem: 'x', candidates: [] }), invalidate() {}, probePaths: () => [] },
      chat: { api: 'openai-completions', compat: {}, toModel: () => ({}), prepareHeaders: (_r, h) => h },
      routes: async () => [],
      resolveCredential: async () => ({ material: 'x' }),
      accounts: {
        exportBundle: async () => ({ bundle: { accounts: [] } }),
        importBundle: async () => ({ added: 0, refreshed: 0, skipped: 0 }),
      },
    },
  })
  const spec = planVendorRoutes({ surface, onChanged: async () => undefined, invalidate: () => undefined }).find(
    (entry) => entry.suffix === 'accounts/import',
  )
  assert.ok(spec !== undefined)
  const payload = await spec.run({ body: async () => ({ bundle: { note: 'nothing recognizable' } }) })
  assert.equal(payload.ok, false, JSON.stringify(payload))
  assert.equal(payload.error.code, 'import_unrecognized')
  assert.match(payload.error.message, /access_token|session/u)
})

/**
 * 单账号额度路由：懒加载的入口。
 *
 * 批量读取要等所有账号（90 个约 5 秒），界面只能空着；这条让前端一行一条地拿。
 * 两个约束必须钉住：缺 id 要明确报错（不是 404），失败要 HTTP 200 + `ok:false`
 * （那一行要显示上游原话，而不是"路由不存在"）。
 */
test('the per-account credits route answers lazily and refuses without an id', async () => {
  const surface = {
    descriptor: {
      id: 'acme',
      displayName: 'Acme',
      accent: '#000',
      capabilities: {
        accounts: 'multi',
        pool: false,
        login: ['none'],
        credits: { kind: 'balance', fields: [] },
        catalog: { selection: false, visionOverride: false, reasoningEffort: false },
        transfer: false,
        adopt: false,
        diagnostics: false,
      },
    },
    runtime: {},
    status: async () => ({}),
    diagnostics: async () => ({ view: {}, probes: [] }),
    credits: async () => ({ kind: 'ok', credits: { fields: {}, fetchedAt: 1 } }),
    accountCredits: async (id) =>
      id === 'known'
        ? { kind: 'ok', credits: { fields: { available: 12 }, fetchedAt: 1 } }
        : {
            kind: 'failure',
            failure: { at: 1, path: 'credits', code: 'account_not_found', message: `没有这个账号：${id}` },
          },
    catalogView: async () => ({ models: [], refreshedAt: null, selection: null }),
    saveSelection: async () => [],
    accounts: async () => ({ ok: true, accounts: [], rotating: false }),
    pool: async () => ({ ok: true, enabled: false, active: false, total: 0, healthy: 0 }),
    accountView: () => ({}),
    credentialView: async () => ({ found: false, sourcePath: '', sourceOrigin: 'none', candidates: [] }),
    accountSummary: async () => null,
  }
  const specs = planVendorRoutes({
    surface,
    onChanged: async () => undefined,
    invalidate: () => undefined,
  })
  const route = specs.find((spec) => spec.suffix === 'credits/account')
  assert.ok(route !== undefined, '路由存在')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.mutating, false)

  /*
   * 用**真的** URLSearchParams：路由读的是 `query.get('id')`，缺值时它返回 `null`
   * （Map 返回 `undefined`）——用 Map 模拟会让"缺 id"那条分支永远走不到。
   */
  const query = (value) => ({ query: new URLSearchParams(value === undefined ? {} : { id: value }) })
  assert.deepEqual(await route.run(query(undefined)), {
    ok: false,
    error: { code: 'bad_request', message: '缺少账号 id。' },
  })
  assert.deepEqual(await route.run(query('known')), { ok: true, fields: { available: 12 }, fetchedAt: 1 })
  assert.deepEqual(await route.run(query('ghost')), {
    ok: false,
    error: { code: 'account_not_found', message: '没有这个账号：ghost' },
  })
})

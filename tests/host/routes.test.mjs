/**
 * Host routes: the contract-v2 JSON shapes plus the guard order.
 *
 * The routes are the only browser-facing surface, so this file pins three
 * invariants:
 * 1. responses carry host-computed, credential-free values (never the session);
 * 2. `/status` always returns `enabledModelIds` (including an explicit `[]`);
 * 3. the two POSTs require JSON + the process-level CSRF token, and a foreign
 *    Host/Origin cannot drive the surface at all.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequestModule } from 'node:http'
import { test } from 'node:test'
import { SESSION, jsonResponse, modelsBody, pointsBody,
  RAW_PHONE,
  RAW_USER_ID,
} from './helpers.mjs'
import {
  ROUTE_PREFIX,
  buildDiagnostics,
  buildStatus,
  normalizeCatalog,
  parseCreditsPayload,
  registerLoomyRoutes,
} from '../../lib/index.js'

const BASE = 'https://gateway.test/api/v1'
const CSRF = 'csrf-test-token'
const MODELS = normalizeCatalog(modelsBody())

const SNAPSHOT = {
  found: true,
  sourcePath: '/tmp/loomy/auth-session.json',
  session: SESSION,
  fingerprint: '0123456789abcdef',
  phone: RAW_PHONE,
  userId: RAW_USER_ID,
  loginAt: 1_794_574_693_000,
  candidates: [
    { path: '/tmp/loomy/auth-session.json', exists: true, state: 'ok', reason: '已读取登录态' },
  ],
}

function authOf(snapshot = SNAPSHOT) {
  return {
    candidates: snapshot.candidates ?? [],
    async read() {
      return snapshot
    },
    invalidate() {},
  }
}

function catalogOf(options = {}) {
  const models = options.models ?? MODELS
  const selection = options.selection ?? null
  let lastError = options.lastError
  const view = () => {
    const saved = selection === null ? null : new Set(selection)
    return models.map((model) => ({ ...model, enabled: saved === null || saved.has(model.id) }))
  }
  const enabledIds = () => view().filter((model) => model.enabled).map((model) => model.id)
  return {
    calls: { ensure: 0, hydrate: 0, refresh: 0, save: [] },
    path: '/tmp/state.json',
    async ensure() {
      this.calls.ensure += 1
      return { kind: 'ok', snapshot: { models, refreshedAt: options.refreshedAt ?? 5, source: 'memory' } }
    },
    async hydrate() {
      this.calls.hydrate += 1
    },
    current: () => models,
    refreshedAt: () => options.refreshedAt ?? 5,
    selection: () => selection,
    enabledIds,
    enabledModels: () => models.filter((model) => enabledIds().includes(model.id)),
    lastError: () => lastError,
    async refresh() {
      this.calls.refresh += 1
      if (options.refreshResult !== undefined) {
        if (options.refreshResult.kind === 'failure') lastError = options.refreshResult.failure
        return options.refreshResult
      }
      lastError = undefined
      return { kind: 'ok', snapshot: { models, refreshedAt: 9, source: 'upstream' } }
    },
    async saveSelection(ids) {
      this.calls.save.push([...ids])
      const wanted = new Set(ids)
      return { kind: 'ok', enabled: models.filter((model) => wanted.has(model.id)).map((model) => model.id) }
    },
    view,
  }
}

function creditsOf(result) {
  return {
    calls: [],
    async read(options = {}) {
      this.calls.push(options)
      return result ?? { kind: 'ok', credits: parseCreditsPayload(pointsBody(), 1).credits }
    },
  }
}

function makeDeps(overrides = {}) {
  return {
    auth: overrides.auth ?? authOf(),
    catalog: overrides.catalog ?? catalogOf(),
    credits: overrides.credits ?? creditsOf(),
    csrfToken: overrides.csrfToken ?? CSRF,
    baseURL: () => BASE,
    fetchImpl:
      overrides.fetchImpl ?? (async () => jsonResponse({ code: '000000', desc: '成功', data: {} })),
    now: () => 1_794_574_693_000,
    logger: { warn() {} },
  }
}

/** Start a real HTTP server that dispatches to the registered exact routes. */
async function startRoutes(t, deps) {
  const routes = new Map()
  const disposers = []
  const fakeCtx = {
    inject(_services, callback) {
      callback({
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
          return dispose
        },
        webServer: {
          register(spec) {
            routes.set(spec.path, spec)
            return () => routes.delete(spec.path)
          },
        },
      })
    },
  }
  registerLoomyRoutes(fakeCtx, deps)

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
    const spec = routes.get(pathname)
    if (spec === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    void spec.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        for (const dispose of disposers) dispose()
        server.close(resolve)
      }),
  )
  return `http://127.0.0.1:${server.address().port}`
}

/** Raw http.request so the test controls Host/Origin/content-type exactly. */
function httpRequest(urlString, options = {}) {
  const url = new URL(urlString)
  return new Promise((resolve, reject) => {
    const request = httpRequestModule(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) {
      request.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    }
    request.end()
  })
}

test('buildStatus reports a host-computed enabled list and the CSRF token', async () => {
  const deps = makeDeps({ catalog: catalogOf({ selection: ['spark-x2.6', 'qwen3.8-flash'] }) })
  const status = await buildStatus(deps)

  assert.equal(status.ok, true)
  assert.equal(status.csrfToken, CSRF)
  assert.deepEqual(status.account, {
    phone: RAW_PHONE,
    loginAt: 1_794_574_693_000,
    userId: '123456789012345678',
  })
  assert.deepEqual(status.credential, { sourcePath: '/tmp/loomy/auth-session.json', found: true })
  assert.deepEqual(status.catalog, { total: 4, enabled: 2, refreshedAt: 5 })
  assert.deepEqual(status.enabledModelIds, ['spark-x2.6', 'qwen3.8-flash'])
  assert.equal(status.nextSteps, undefined)
  assert.equal(deps.catalog.calls.ensure, 1)

  const serialised = JSON.stringify(status)
  assert.ok(!serialised.includes(SESSION), 'the session must never be serialised to the browser')
  // Phone and user id are display data on this machine, so they ARE reported;
  // only the session is a secret the browser must never receive.
})

test('buildStatus: a never-saved selection returns every chat model id', async () => {
  const status = await buildStatus(makeDeps())
  assert.deepEqual(status.enabledModelIds, MODELS.map((model) => model.id))
})

test('buildStatus: a manually emptied selection returns [] but keeps the field', async () => {
  const status = await buildStatus(makeDeps({ catalog: catalogOf({ selection: [] }) }))
  assert.deepEqual(status.enabledModelIds, [])
  assert.equal(status.catalog.enabled, 0)
})

test('buildStatus stays 200 while signed out and offers executable next steps', async () => {
  const signedOut = {
    found: false,
    sourcePath: '/tmp/missing-auth.json',
    reason: 'missing',
    problem: '本机没有找到 Loomy 登录态文件（/tmp/missing-auth.json）。请启动 Loomy 客户端并完成登录。',
    candidates: [{ path: '/tmp/missing-auth.json', exists: false, state: 'missing', reason: '文件不存在' }],
  }
  const catalog = catalogOf({ models: [] })
  const status = await buildStatus(makeDeps({ auth: authOf(signedOut), catalog }))

  assert.equal(status.ok, true)
  assert.equal(status.account, null)
  assert.deepEqual(status.credential, { sourcePath: '/tmp/missing-auth.json', found: false })
  assert.deepEqual(status.enabledModelIds, [])
  assert.ok(status.nextSteps.length >= 2)
  assert.match(status.nextSteps[0], /missing-auth\.json/u)
  assert.equal(catalog.calls.hydrate, 1, 'a signed-out status only reads the local cache')
  assert.equal(catalog.calls.ensure, 0)
})

test('buildStatus includes the last upstream error verbatim', async () => {
  const lastError = { at: 7, path: '/models', code: '100002', message: '登录已失效，请重新登录' }
  const status = await buildStatus(makeDeps({ catalog: catalogOf({ lastError }) }))
  assert.deepEqual(status.lastError, lastError)
})

test('buildDiagnostics probes all three upstream endpoints with host-computed data', async () => {
  const deps = makeDeps()
  const diagnostics = await buildDiagnostics(deps)

  assert.equal(diagnostics.ok, true)
  assert.deepEqual(diagnostics.upstream, {
    baseUrl: BASE,
    modelsUrl: `${BASE}/models`,
    pointsUrl: `${BASE}/points/records`,
  })
  assert.deepEqual(diagnostics.account, { phone: RAW_PHONE, userId: '123456789012345678' })
  assert.deepEqual(diagnostics.catalog, { total: 4, enabled: 4 })
  assert.deepEqual(
    diagnostics.probes.map((probe) => [probe.path, probe.ok]),
    [
      ['/models', true],
      ['/points/records', true],
      ['/user/identity', true],
    ],
  )
  assert.match(diagnostics.probes[0].reason, /4 个聊天模型/u)
  assert.deepEqual(deps.credits.calls, [{ force: true }], 'diagnostics force fresh reads')

  const serialised = JSON.stringify(diagnostics)
  assert.ok(!serialised.includes(SESSION))
  // The phone is display data and is reported; the session is not.
})

test('buildDiagnostics surfaces each upstream failure verbatim', async () => {
  const deps = makeDeps({
    catalog: catalogOf({
      refreshResult: { kind: 'failure', failure: { at: 1, path: '/models', code: '100002', message: '缺少 token' } },
    }),
    credits: creditsOf({
      kind: 'failure',
      failure: { at: 2, path: '/points/records', code: '100002', message: '登录已失效（积分）' },
    }),
    fetchImpl: async () => jsonResponse({ code: '100002', desc: '登录已失效（身份）' }),
  })
  const diagnostics = await buildDiagnostics(deps)

  assert.deepEqual(
    diagnostics.probes.map((probe) => [probe.path, probe.ok, probe.reason]),
    [
      ['/models', false, '缺少 token'],
      ['/points/records', false, '登录已失效（积分）'],
      ['/user/identity', false, '登录已失效（身份）'],
    ],
  )
  assert.deepEqual(diagnostics.lastError, { at: 1, path: '/models', code: '100002', message: '缺少 token' })
})

test('buildDiagnostics: signed out reports every probe with the credential reason', async () => {
  const signedOut = {
    found: false,
    sourcePath: '/tmp/missing-auth.json',
    reason: 'missing',
    problem: '本机没有找到 Loomy 登录态文件（/tmp/missing-auth.json）。',
    candidates: [],
  }
  const diagnostics = await buildDiagnostics(
    makeDeps({ auth: authOf(signedOut), catalog: catalogOf({ models: [] }) }),
  )

  assert.equal(diagnostics.account, null)
  assert.equal(diagnostics.probes.length, 3)
  for (const probe of diagnostics.probes) {
    assert.equal(probe.ok, false)
    assert.equal(probe.reason, signedOut.problem)
  }
})

test('routes: GET /status is 200, no-store and credential-free', async (t) => {
  const baseURL = await startRoutes(t, makeDeps())
  const response = await httpRequest(`${baseURL}${ROUTE_PREFIX}/status`)

  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.headers['content-type'], /application\/json/u)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.csrfToken, CSRF)
  assert.ok(!response.text.includes(SESSION))
})

test('routes: a foreign Host or Origin cannot drive the surface', async (t) => {
  const baseURL = await startRoutes(t, makeDeps())

  const badHost = await httpRequest(`${baseURL}${ROUTE_PREFIX}/status`, {
    headers: { host: 'attacker.example' },
  })
  assert.equal(badHost.status, 403)
  assert.equal(JSON.parse(badHost.text).error.code, 'host_not_allowed')

  const badOrigin = await httpRequest(`${baseURL}${ROUTE_PREFIX}/status`, {
    headers: { origin: 'http://attacker.example' },
  })
  assert.equal(badOrigin.status, 403)
  assert.equal(JSON.parse(badOrigin.text).error.code, 'origin_not_allowed')

  const localOrigin = await httpRequest(`${baseURL}${ROUTE_PREFIX}/status`, {
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(localOrigin.status, 200)
})

test('routes: POST /save requires JSON and the CSRF token, then persists the ids', async (t) => {
  const catalog = catalogOf()
  const baseURL = await startRoutes(t, makeDeps({ catalog }))
  const url = `${baseURL}${ROUTE_PREFIX}/save`

  const noToken = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { enabledModelIds: ['spark-x2.6'] },
  })
  assert.equal(noToken.status, 403)
  assert.equal(JSON.parse(noToken.text).error.code, 'csrf_invalid')

  const wrongToken = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loomy-csrf': 'wrong' },
    body: { enabledModelIds: ['spark-x2.6'] },
  })
  assert.equal(wrongToken.status, 403)

  const wrongType = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-loomy-csrf': CSRF },
    body: 'enabledModelIds=spark-x2.6',
  })
  assert.equal(wrongType.status, 415)
  assert.equal(JSON.parse(wrongType.text).error.code, 'unsupported_media_type')
  assert.deepEqual(catalog.calls.save, [], 'no mutation happened on a rejected request')

  const badShape = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loomy-csrf': CSRF },
    body: { enabledModelIds: 'spark-x2.6' },
  })
  assert.equal(badShape.status, 400)

  const saved = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loomy-csrf': CSRF },
    body: { enabledModelIds: ['spark-x2.6', 'qwen3.8-flash'] },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(JSON.parse(saved.text), { ok: true, enabled: ['spark-x2.6', 'qwen3.8-flash'] })
  assert.deepEqual(catalog.calls.save, [['spark-x2.6', 'qwen3.8-flash']])
  assert.ok(!saved.text.includes(SESSION))
})

test('routes: POST /refresh returns the host-merged catalog (saved selection, not a draft)', async (t) => {
  const catalog = catalogOf({ selection: ['qwen3.8-flash'] })
  const baseURL = await startRoutes(t, makeDeps({ catalog }))
  const response = await httpRequest(`${baseURL}${ROUTE_PREFIX}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loomy-csrf': CSRF },
    body: {},
  })

  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.refreshedAt, 9)
  assert.equal(body.catalog.length, 4)
  const enabled = body.catalog.filter((model) => model.enabled).map((model) => model.id)
  assert.deepEqual(enabled, ['qwen3.8-flash'])
  assert.equal(body.catalog[0].multiplier, 0)
  assert.equal(body.catalog[1].contextWindow, 1_048_576)
  assert.equal(catalog.calls.refresh, 1)
})

test('routes: a credits failure is 200 + ok:false, never a fabricated balance', async (t) => {
  const failure = { at: 3, path: '/points/records', code: '100002', message: '登录已失效' }
  const baseURL = await startRoutes(
    t,
    makeDeps({ credits: creditsOf({ kind: 'failure', failure }) }),
  )
  const response = await httpRequest(`${baseURL}${ROUTE_PREFIX}/credits`)

  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.text), {
    ok: false,
    error: { code: '100002', message: '登录已失效' },
  })
})

test('routes: a successful credits read returns all three buckets and the ledger', async (t) => {
  const baseURL = await startRoutes(t, makeDeps())
  const response = await httpRequest(`${baseURL}${ROUTE_PREFIX}/credits`)

  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.balance, 35_500)
  assert.equal(body.dailyBalance, 5_000)
  assert.equal(body.availableBalance, 40_500)
  assert.equal(body.records.length, 2)
  assert.ok(!response.text.includes(SESSION))
})

test('routes: wrong method is 405, an unknown path is not registered', async (t) => {
  const baseURL = await startRoutes(t, makeDeps())
  const wrongMethod = await httpRequest(`${baseURL}${ROUTE_PREFIX}/save`)
  assert.equal(wrongMethod.status, 405)
  assert.equal(JSON.parse(wrongMethod.text).error.code, 'method_not_allowed')

  const unknown = await httpRequest(`${baseURL}${ROUTE_PREFIX}/nope`)
  assert.equal(unknown.status, 404)
})

test('routes: diagnostics is read-only and never hands the session to the browser', async (t) => {
  const baseURL = await startRoutes(t, makeDeps())
  const response = await httpRequest(`${baseURL}${ROUTE_PREFIX}/diagnostics`)
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.deepEqual(body.probes.map((probe) => probe.path), ['/models', '/points/records', '/user/identity'])
  assert.ok(!response.text.includes(SESSION))
})

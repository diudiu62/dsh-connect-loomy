/**
 * 传输层四态（`client/transport`）。
 *
 * 这条边界决定了"用户看到什么话"：`failed` 要原样显示宿主给的上游文案，`stale`
 * 要说"重启 DSH"，`unavailable` 是能力缺失（不报错、只隐藏），网络异常另有说法。
 * 把它们混成一个"加载失败"，是旧版最难排的类问题。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { installFetch, mountPlugin } from './helpers.mjs'

const { exports } = mountPlugin()
const { requestVendor, fetchStatus, CSRF_HEADER } = exports

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 一次请求的最小参数。 */
function call(overrides = {}) {
  return requestVendor({ vendorId: 'loomy', suffix: 'accounts', ...overrides })
}

test('a successful read unwraps the ok:true envelope', async () => {
  installFetch({ '/plugins/dsh-connect-desktop/loomy/accounts': { body: { ok: true, accounts: [] } } })
  const result = await call()
  assert.equal(result.kind, 'ok')
  assert.equal(result.value.ok, true)
})

test('a host failure keeps the upstream message verbatim', async () => {
  installFetch({
    '/plugins/dsh-connect-desktop/loomy/credits': {
      body: { ok: false, error: { code: '100002', message: '登录已失效，请重新登录' } },
    },
  })
  const result = await requestVendor({ vendorId: 'loomy', suffix: 'credits' })
  assert.equal(result.kind, 'failed')
  assert.equal(result.code, '100002')
  assert.equal(result.message, '登录已失效，请重新登录', 'the user must see the upstream wording, not "加载失败"')
})

test('404 and 503 are "this host has no such route", not an error', async () => {
  installFetch({})
  const missing = await call()
  assert.equal(missing.kind, 'unavailable')
  assert.equal(missing.reason, 'missing_route')

  installFetch({ '/plugins/dsh-connect-desktop/loomy/accounts': { status: 503, body: { ok: false } } })
  const unavailable = await call()
  assert.equal(unavailable.kind, 'unavailable')
  assert.equal(unavailable.reason, 'missing_route')
})

test('405 means the running host predates this client build', async () => {
  installFetch({ '/plugins/dsh-connect-desktop/loomy/accounts': { status: 405, body: { ok: false } } })
  const result = await call()
  assert.equal(result.kind, 'stale')
  assert.match(result.message, /重启 DSH/u, 'the fix must be in the message')
})

test('a dead network is reported as network, not as a missing route', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:3080')
  }
  const result = await call()
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.reason, 'network')
  assert.match(result.message, /ECONNREFUSED/u)
})

test('a POST carries JSON, the single CSRF header and the body', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const result = await requestVendor({
    vendorId: 'raccoon',
    suffix: 'save',
    method: 'POST',
    body: { enabledModelIds: ['a'] },
    csrf: 'tok',
  })
  assert.equal(result.kind, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/plugins/dsh-connect-desktop/raccoon/save')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.headers[CSRF_HEADER], 'tok')
  assert.deepEqual(JSON.parse(calls[0].init.body), { enabledModelIds: ['a'] })
  // 只有这一个 CSRF 头名：旧版的 x-loomy-csrf / x-raccoon-csrf 已删除。
  assert.equal(CSRF_HEADER, 'x-dsh-connect-csrf')
  const names = Object.keys(calls[0].init.headers).filter((name) => name.toLowerCase().includes('csrf'))
  assert.deepEqual(names, [CSRF_HEADER])
})

test('a POST without a token fails locally instead of costing a round trip', async () => {
  let fetched = 0
  globalThis.fetch = async () => {
    fetched += 1
    return new Response('{}', { status: 200 })
  }
  const result = await requestVendor({ vendorId: 'loomy', suffix: 'save', method: 'POST', body: {} })
  assert.equal(result.kind, 'failed')
  assert.equal(result.code, 'csrf_missing')
  assert.equal(fetched, 0)
})

test('a query string is appended verbatim (cache bypass)', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await requestVendor({ vendorId: 'loomy', suffix: 'credits', query: 'force=1' })
  assert.equal(calls[0], '/plugins/dsh-connect-desktop/loomy/credits?force=1')
})

test('fetchStatus reads the plugin-level route and hands back the CSRF token', async () => {
  installFetch({
    '/plugins/dsh-connect-desktop/status': { body: { ok: true, csrfToken: 'tok', vendors: [] } },
  })
  const result = await fetchStatus()
  assert.equal(result.kind, 'ok')
  assert.equal(result.value.csrfToken, 'tok')
  assert.equal(result.value.vendors.length, 0)
})

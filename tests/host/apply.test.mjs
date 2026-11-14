/**
 * `apply()` mount behavior: cold-start catalog warm-up.
 *
 * A fresh `DSH_HOME` has no cached catalog, so without a background fetch the
 * model selector would stay empty until the settings card happened to be
 * opened (t6/F1). These tests pin the contract:
 * - apply() never waits for the network (it returns and registers the route
 *   while the warm-up request is still pending);
 * - the warm-up is started only when the desktop client is signed in;
 * - a warm-up rejection is swallowed (no unhandled rejection in the host).
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../../lib/index.js'
import { jsonResponse, modelsBody, tempDir, writeAuthFile } from './helpers.mjs'

const CONFIG = {
  enabled: true,
  baseURL: 'https://gateway.test/api/v1',
  loomyVersion: '0.9.39',
  sessionTtlMs: 5_000,
  precheckTtlMs: 60_000,
  catalogTtlMs: 600_000,
  creditsTtlMs: 60_000,
  creditsPageSize: 20,
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('condition was not met before the timeout')
}

function fakeContext() {
  const emitted = []
  let registration
  const context = {
    fiber: { entry: { options: { id: 'dsh-connect-loomy' } } },
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
          webServer: { register: () => () => {} },
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
        registration = { routes, adapter }
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }
  return { context, emitted, registration: () => registration }
}

/** Isolate credential discovery + state from the developer's real machine. */
function isolate(t, dir, authFile) {
  const saved = new Map()
  for (const key of ['HOME', 'DSH_HOME', 'LOOMY_AUTH_SESSION_FILE']) {
    saved.set(key, process.env[key])
  }
  process.env.HOME = join(dir, 'home')
  process.env.DSH_HOME = join(dir, 'dsh-home')
  if (authFile === undefined) delete process.env.LOOMY_AUTH_SESSION_FILE
  else process.env.LOOMY_AUTH_SESSION_FILE = authFile
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (saved.get('LOOMY_AUTH_SESSION_FILE') === undefined) delete process.env.LOOMY_AUTH_SESSION_FILE
  })
}

test('apply() returns before the network and warms a signed-in catalog in the background', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  isolate(t, dir, authPath)

  let releaseFetch
  const gate = new Promise((resolve) => {
    releaseFetch = resolve
  })
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    await gate
    return jsonResponse(modelsBody())
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { context, emitted, registration } = fakeContext()
  apply(context, CONFIG)

  // Mount is synchronous and complete before any byte of the warm-up request:
  // the route is registered and nothing has been fetched yet.
  const registered = registration()
  assert.ok(registered !== undefined, 'the provider route is registered during apply')
  assert.deepEqual(registered.routes, ['loomy'])
  assert.equal(calls.length, 0, 'apply must not contact the upstream synchronously')

  releaseFetch()
  await waitFor(() => calls.some((url) => url.endsWith('/models')))
  assert.match(calls[0], /\/models$/u)

  // A successful warm-up notifies selectors, otherwise a fresh selector would
  // keep showing its empty first read.
  await waitFor(() => emitted.some(([name, id]) => name === 'llm/models-updated' && id === 'loomy'))
})

test('apply() does not warm the catalog while signed out and never leaks a rejection', async (t) => {
  const dir = tempDir(t)
  isolate(t, dir, join(dir, 'missing-auth-session.json'))

  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))

  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return jsonResponse(modelsBody())
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { context, registration } = fakeContext()
  apply(context, CONFIG)
  assert.ok(registration() !== undefined)

  await delay(250)
  assert.equal(calls.length, 0, 'no upstream call without a usable session')
  assert.deepEqual(rejections, [], 'a failed warm-up must be swallowed, not surface as unhandled')
})

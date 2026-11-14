/**
 * Catalog normalisation, selection semantics and the on-disk cache contract.
 *
 * The upstream `/models` answer is the only whitelist a request may name, so
 * these tests pin: which entries may be registered, how multiplier / context /
 * output / vision / efforts are read, that a saved selection survives restart,
 * that a refresh updates rates without touching the saved selection, and that
 * the cache file is credential-free and mode 0600.
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CHAT_IDS,
  RAW_MODELS,
  SESSION,
  candidate,
  jsonResponse,
  modelsBody,
  platformFailure,
  tempDir,
  writeAuthFile,
} from './helpers.mjs'
import {
  createCatalogStore,
  createStateStore,
  emptyState,
  mergeSelection,
  normalizeCatalog,
  normalizeCatalogModel,
  parseMultiplier,
  parseState,
  resolveEnabledIds,
  serializeState,
  stateFilePath,
} from '../../lib/index.js'

const BASE = 'https://gateway.test/api/v1'

function catalogDeps(overrides = {}) {
  const statePath = overrides.statePath
  const state = createStateStore(statePath)
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = overrides.fetchImpl === undefined ? jsonResponse(modelsBody()) : overrides.fetchImpl(url, init, calls.length - 1)
    return next
  }
  const store = createCatalogStore({
    baseURL: () => overrides.baseURL ?? BASE,
    readSession: overrides.readSession ?? (async () => ({ session: SESSION, sourcePath: '/tmp/auth-session.json' })),
    state,
    ttlMs: () => overrides.ttlMs ?? 600_000,
    fetchImpl,
    now: overrides.now ?? (() => 1_794_574_693_000),
    logger: { warn() {} },
    onChanged: overrides.onChanged,
  })
  return { store, state, calls, fetchImpl }
}

test('normalizeCatalog keeps chat models only, in upstream order', () => {
  const models = normalizeCatalog(modelsBody())
  assert.deepEqual(models.map((model) => model.id), CHAT_IDS)

  // Every non-chat escape hatch is filtered: image models (with and without
  // capabilities), the billing `auto` alias and the legacy protocol.
  const ids = new Set(models.map((model) => model.id))
  assert.ok(!ids.has('Hy-Image-3.5-preview'))
  assert.ok(!ids.has('legacy-image-no-capabilities'))
  assert.ok(!ids.has('auto'))
  assert.ok(!ids.has('legacy-chat'))

  const spark = models[0]
  assert.equal(spark.name, 'Spark-X2.6 正式版(限时免费)(x0.0)')
  assert.equal(spark.multiplier, 0, 'x0.0 parses as a free model')
  assert.equal(spark.contextWindow, 1_048_576)
  assert.equal(spark.maxOutput, 131_072)
  assert.equal(spark.vision, false)
  assert.deepEqual(spark.efforts, ['none', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(spark.defaultEffort, 'low')

  const deepseek = models[1]
  assert.equal(deepseek.multiplier, 2)
  assert.equal(deepseek.contextWindow, 1_048_576)
  assert.equal(deepseek.maxOutput, 384_000)
  assert.equal(deepseek.vision, true)
  assert.equal(deepseek.defaultEffort, 'high')

  const qwen = models[2]
  assert.equal(qwen.multiplier, 0.8, 'full-width （x0.8） parses')
  assert.equal(qwen.vision, true)
  assert.deepEqual(qwen.efforts, ['none', 'low', 'high'], 'unknown `extreme` is dropped')
  assert.equal(qwen.defaultEffort, 'low')

  const fallback = models[3]
  assert.equal(fallback.multiplier, 0)
  assert.equal(fallback.contextWindow, 128_000, 'missing context_length uses the host fallback')
  assert.equal(fallback.maxOutput, 8_192, 'missing max_output_tokens uses the host fallback')
  assert.equal(fallback.vision, false)
  assert.deepEqual(fallback.efforts, [])
  assert.equal(fallback.defaultEffort, '')
})

test('normalizeCatalogModel degrades a malformed default effort to the first offered one', () => {
  const model = normalizeCatalogModel({
    id: 'odd',
    name: 'Odd(x1.5)',
    type: 'chat',
    protocol: 'openai_chat',
    reasoning_efforts: ['none', 'high'],
    default_reasoning_effort: 'extreme',
    capabilities: { reasoning: true, vision: false, input_modalities: ['text'], output_modalities: ['text'] },
  })
  assert.equal(model.defaultEffort, 'none')
  assert.deepEqual(model.efforts, ['none', 'high'])
  assert.equal(model.multiplier, 1.5)
})

test('normalizeCatalogModel rejects non-objects and entries without an id', () => {
  assert.equal(normalizeCatalogModel(undefined), undefined)
  assert.equal(normalizeCatalogModel('model'), undefined)
  assert.equal(normalizeCatalogModel({ name: 'no id' }), undefined)
})

test('normalizeCatalog accepts both the `data` array and a bare array body', () => {
  assert.equal(normalizeCatalog(RAW_MODELS).length, 4)
  assert.equal(normalizeCatalog({ data: { data: RAW_MODELS } }).length, 4)
  assert.deepEqual(normalizeCatalog({ nope: true }), [])
  assert.deepEqual(normalizeCatalog(undefined), [])
})

test('normalizeCatalog de-duplicates repeated ids, keeping the first entry', () => {
  const models = normalizeCatalog({
    data: [
      { id: 'same', name: 'Same(x1.0)', type: 'chat', protocol: 'openai_chat' },
      { id: 'same', name: 'Same(x9.0)', type: 'chat', protocol: 'openai_chat' },
    ],
  })
  assert.equal(models.length, 1)
  assert.equal(models[0].multiplier, 1)
})

test('parseMultiplier reads only parenthesised rates', () => {
  assert.equal(parseMultiplier('DeepSeek V4.1 Flash(x2.0)'), 2)
  assert.equal(parseMultiplier('qwen 3.8 flash（x0.8）'), 0.8)
  assert.equal(parseMultiplier('MiMo V2.5（x3.3）'), 3.3)
  assert.equal(parseMultiplier('（×1.5）'), 1.5)
  assert.equal(parseMultiplier('Spark-X2.6 正式版(限时免费)(x0.0)'), 0)
  assert.equal(parseMultiplier('Spark X2.5'), 0, 'an unparenthesised X2.5 is not a rate')
  assert.equal(parseMultiplier('free model'), 0)
  assert.equal(parseMultiplier('(x)'), 0)
})

test('resolveEnabledIds: null means every model, [] means none, unknown ids are dropped', () => {
  const models = normalizeCatalog(modelsBody())
  assert.deepEqual(resolveEnabledIds(models, null), CHAT_IDS)
  assert.deepEqual(resolveEnabledIds(models, []), [])
  assert.deepEqual(resolveEnabledIds(models, ['spark-x2.6', 'removed-model']), ['spark-x2.6'])
  // Catalog order wins, so a stale card cannot reorder the provider's list.
  assert.deepEqual(resolveEnabledIds(models, ['qwen3.8-flash', 'spark-x2.6']), ['spark-x2.6', 'qwen3.8-flash'])
})

test('mergeSelection reports the *saved* selection and never mutates its inputs', () => {
  const models = normalizeCatalog(modelsBody())
  const before = JSON.stringify(models)
  const all = mergeSelection(models, null)
  assert.ok(all.every((model) => model.enabled === true))
  const some = mergeSelection(models, ['spark-x2.6', 'qwen3.8-flash'])
  assert.deepEqual(
    some.map((model) => [model.id, model.enabled]),
    [
      ['spark-x2.6', true],
      ['DeepSeek-V4.1-Flash', false],
      ['qwen3.8-flash', true],
      ['mystery-chat', false],
    ],
  )
  assert.equal(JSON.stringify(models), before, 'normalisation output is not mutated')
})

test('refresh persists a 0600 cache without the session, and save persists the selection', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  const onChanged = []
  const { store } = catalogDeps({
    statePath,
    readSession: async () => ({ session: SESSION, sourcePath: authPath }),
    onChanged: () => onChanged.push('changed'),
  })

  await store.hydrate()
  const result = await store.ensure({ force: true })
  assert.equal(result.kind, 'ok')
  assert.deepEqual(store.enabledIds(), CHAT_IDS, 'a never-saved selection defaults to every chat model')
  assert.equal(store.refreshedAt(), 1_794_574_693_000)

  const cache = readFileSync(statePath, 'utf8')
  assert.equal(statSync(statePath).mode & 0o777, 0o600, 'the cache file is private to the user')
  assert.ok(!cache.includes(SESSION), 'the session must never be written to disk')
  assert.ok(cache.includes('"spark-x2.6"'))
  assert.ok(cache.includes('"selection": null'), 'first run keeps selection=null, not a fake array')

  const saved = await store.saveSelection(['spark-x2.6', 'not-in-catalog'])
  assert.deepEqual(saved, { kind: 'ok', enabled: ['spark-x2.6'] })
  assert.deepEqual(store.selection(), ['spark-x2.6'])
  assert.deepEqual(store.enabledIds(), ['spark-x2.6'])
  assert.equal(onChanged.length, 2, 'a refresh and a save each notify selectors')
  assert.ok(!readFileSync(statePath, 'utf8').includes(SESSION))

  // A restart re-hydrates both the catalog and the saved selection.
  const restarted = catalogDeps({
    statePath,
    readSession: async () => ({ session: SESSION, sourcePath: authPath }),
  }).store
  await restarted.hydrate()
  assert.deepEqual(restarted.current().map((model) => model.id), CHAT_IDS)
  assert.deepEqual(restarted.enabledIds(), ['spark-x2.6'])
})

test('refresh updates rates immediately without overwriting an unsaved draft selection', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  let body = modelsBody()
  const { store } = catalogDeps({
    statePath,
    fetchImpl: () => jsonResponse(body),
    readSession: async () => ({ session: SESSION, sourcePath: '/tmp/auth-session.json' }),
  })
  await store.hydrate()
  await store.ensure({ force: true })
  await store.saveSelection(['DeepSeek-V4.1-Flash'])

  // The card has an unsaved draft; it exists only in the browser. The host
  // refreshes the catalog and reports its *saved* selection.
  const refreshedBody = modelsBody(
    RAW_MODELS.map((model) =>
      model.id === 'DeepSeek-V4.1-Flash' ? { ...model, name: 'DeepSeek V4.1 Flash(x3.0)' } : model,
    ),
  )
  body = refreshedBody
  const refresh = await store.refresh()
  assert.equal(refresh.kind, 'ok')
  assert.equal(store.current().find((model) => model.id === 'DeepSeek-V4.1-Flash').multiplier, 3)
  assert.deepEqual(store.selection(), ['DeepSeek-V4.1-Flash'], 'refresh never rewrites the saved selection')
  const view = store.view()
  assert.deepEqual(
    view.filter((model) => model.enabled).map((model) => model.id),
    ['DeepSeek-V4.1-Flash'],
    'the view merges the host-side saved selection, not a draft',
  )
  assert.equal(view.find((model) => model.id === 'spark-x2.6').enabled, false)
})

test('an upstream failure is reported verbatim and is not cached as success', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  const { store } = catalogDeps({
    statePath,
    fetchImpl: () => jsonResponse(platformFailure('100002', '登录已失效，请重新登录')),
    readSession: async () => ({ session: SESSION, sourcePath: '/tmp/auth-session.json' }),
  })
  await store.hydrate()

  const result = await store.refresh()
  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, '100002')
  assert.equal(result.failure.message, '登录已失效，请重新登录', 'the upstream desc is surfaced verbatim')
  assert.match(result.failure.path, /\/models$/u)
  assert.deepEqual(store.current(), [], 'a failure does not fabricate a catalog')
  assert.deepEqual(store.enabledIds(), [])
  assert.equal(store.lastError().code, '100002')

  const cache = readFileSync(statePath, 'utf8')
  assert.ok(cache.includes('"code": "100002"'), 'the last error is persisted for diagnostics')
  assert.ok(cache.includes('登录已失效'), 'the verbatim desc is persisted')
  assert.ok(!cache.includes(SESSION))
})

test('a signed-out host fails the refresh before any network call', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  let calls = 0
  const { store } = catalogDeps({
    statePath,
    readSession: async () => ({ sourcePath: '/tmp/missing-auth.json', problem: '请启动 Loomy 客户端并登录' }),
    fetchImpl: () => {
      calls += 1
      return jsonResponse(modelsBody())
    },
  })
  await store.hydrate()
  const result = await store.refresh()

  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, 'not_signed_in')
  assert.match(result.failure.message, /missing-auth\.json/u)
  assert.match(result.failure.message, /请启动 Loomy 客户端并登录/u)
  assert.equal(calls, 0, 'no upstream request without a session')
})

test('an empty/unknown /models body is a failure, not an empty whitelist', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  const { store } = catalogDeps({ statePath, fetchImpl: () => jsonResponse({ object: 'list', data: [] }) })
  await store.hydrate()
  const result = await store.refresh()

  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, 'bad_response')
  assert.match(result.failure.message, /没有返回任何聊天模型/u)
})

test('a transport failure is labelled network and keeps the previous catalog', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  let mode = 'ok'
  const { store } = catalogDeps({
    statePath,
    fetchImpl: () => {
      if (mode === 'ok') return jsonResponse(modelsBody())
      throw new Error('ECONNREFUSED 127.0.0.1:9')
    },
  })
  await store.hydrate()
  await store.refresh()
  assert.equal(store.current().length, 4)

  mode = 'fail'
  const result = await store.refresh()
  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, 'network')
  assert.match(result.failure.message, /ECONNREFUSED/u)
  assert.equal(store.current().length, 4, 'an old catalog is not deleted by a failed refresh')
})

test('saveSelection refuses to run before a catalog exists', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  const { store } = catalogDeps({ statePath })
  await store.hydrate()
  const result = await store.saveSelection(['spark-x2.6'])
  assert.equal(result.kind, 'failure')
  assert.equal(result.failure.code, 'catalog_empty')
})

test('parseState degrades corrupt/future documents to the empty state', () => {
  assert.deepEqual(parseState('not json'), emptyState())
  assert.deepEqual(parseState(JSON.stringify({ version: 99, selection: ['x'] })), emptyState())
  const parsed = parseState(
    JSON.stringify({
      version: 1,
      selection: ['a', '', 42],
      catalog: [{ id: 'a', name: 'A', multiplier: 1, contextWindow: 1, maxOutput: 1, vision: false, efforts: [], defaultEffort: '' }],
      refreshedAt: 5,
      lastError: { at: 1, path: '/models', code: 'x', message: 'y' },
      savedAt: 6,
    }),
  )
  assert.deepEqual(parsed.selection, ['a'])
  assert.equal(parsed.catalog.length, 1)
  assert.equal(parsed.lastError.code, 'x')
  assert.equal(parsed.savedAt, 6)
})

test('serializeState is deterministic and never gains new fields', () => {
  const state = {
    version: 1,
    selection: ['b', 'a'],
    catalog: [],
    refreshedAt: 7,
    savedAt: 8,
  }
  const first = serializeState(state)
  assert.equal(first, serializeState(state))
  assert.deepEqual(Object.keys(JSON.parse(first)), ['version', 'selection', 'catalog', 'refreshedAt', 'savedAt'])
})

/** Let fire-and-forget background work settle without polling internals. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('kickStaleRefresh warms a stale catalog in the background without blocking the read', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  let clock = 1_000_000
  let calls = 0
  const { store } = catalogDeps({
    statePath,
    now: () => clock,
    ttlMs: 1_000,
    fetchImpl: () => {
      calls += 1
      return jsonResponse(modelsBody())
    },
  })
  await store.hydrate()
  assert.deepEqual(store.current(), [], 'fresh DSH_HOME starts empty')

  store.kickStaleRefresh()
  assert.deepEqual(store.current(), [], 'the synchronous read still sees the old cache')
  await settle()
  assert.equal(calls, 1)
  assert.equal(store.current().length, 4, 'the next read sees the refreshed catalog')

  // Fresh now: no further upstream call.
  store.kickStaleRefresh()
  await settle()
  assert.equal(calls, 1)

  // A TTL window has elapsed: exactly one new attempt is allowed even when
  // several inference reads kick at the same time.
  clock += 1_500
  store.kickStaleRefresh()
  store.kickStaleRefresh()
  store.kickStaleRefresh()
  await settle()
  assert.equal(calls, 2)
})

test('a failing background refresh retries at most once per TTL window', async (t) => {
  const dir = tempDir(t)
  const statePath = stateFilePath(join(dir, 'dsh-home'))
  let clock = 1_000_000
  let calls = 0
  const { store } = catalogDeps({
    statePath,
    now: () => clock,
    ttlMs: 1_000,
    fetchImpl: () => {
      calls += 1
      return jsonResponse(platformFailure('100002', '登录已失效'))
    },
  })
  await store.hydrate()

  store.kickStaleRefresh()
  await settle()
  assert.equal(calls, 1)
  assert.equal(store.lastError().code, '100002')

  // Still inside the window: a stale catalog whose upstream is failing must
  // not turn every inference request into another /models attempt.
  store.kickStaleRefresh()
  await settle()
  assert.equal(calls, 1)

  clock += 500
  store.kickStaleRefresh()
  await settle()
  assert.equal(calls, 1)

  clock += 600
  store.kickStaleRefresh()
  await settle()
  assert.equal(calls, 2, 'a new TTL window allows exactly one retry')
})

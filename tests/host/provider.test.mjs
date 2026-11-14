/**
 * Provider half: model descriptor mapping, request tracing headers, profile
 * construction and the failure classification at the harness seam.
 *
 * The classification cases are the upstream's recorded quirks:
 * - reasoning may consume `max_tokens`, so `content:""` + `finish_reason:length`
 *   is a legitimate length truncation (harness `max-tokens`), never an empty
 *   response;
 * - a stream that ends without `finish_reason` is a silent truncation and must
 *   reach the retryable path (`TRANSPORT`);
 * - a genuinely content-less `stop` is `EMPTY_RESPONSE`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxThinking } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import {
  LOOMY_API,
  createAuthStore,
  createProviderRuntime,
  displayNameFor,
  prepareLoomyHeaders,
  thinkingLevelMapFor,
  toPiModel,
} from '../../lib/index.js'
import { candidate, tempDir, writeAuthFile, SESSION } from './helpers.mjs'

const BASE = 'https://gateway.test/api/v1'

const CATALOG_MODEL = {
  id: 'qwen3.8-flash',
  name: 'qwen 3.8 flash（x0.8）',
  multiplier: 0.8,
  contextWindow: 1_000_000,
  maxOutput: 131_072,
  vision: true,
  efforts: ['none', 'low', 'high'],
  defaultEffort: 'low',
}

const PLAIN_MODEL = {
  id: 'plain-chat',
  name: 'Plain Chat',
  multiplier: 0,
  contextWindow: 128_000,
  maxOutput: 8_192,
  vision: false,
  efforts: [],
  defaultEffort: '',
}

const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('the loomy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

function baseProfile(piProvider, overrides = {}) {
  return {
    provider: 'loomy',
    displayName: 'Loomy',
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 4 * 1024 * 1024,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'test'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider,
    ...overrides,
  }
}

function classificationAdapter() {
  const faux = fauxProvider({
    provider: 'loomy',
    models: [{ id: 'm1', name: 'M1', contextWindow: 10_000, maxTokens: 1_000 }],
  })
  const profile = baseProfile(faux.provider)
  const adapter = new PiAiAdapter({
    profiles: () => new Map([['loomy', profile]]),
    resolveApiKey: async () => 'test-session',
    auth: INERT_AUTH,
  })
  return { faux, profile, adapter }
}

async function chunksFor(faux, adapter, response) {
  faux.setResponses([response])
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'loomy',
    model: 'm1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

test('displayNameFor always exposes the upstream multiplier exactly once', () => {
  assert.equal(displayNameFor(CATALOG_MODEL), 'qwen 3.8 flash（x0.8）')
  assert.equal(
    displayNameFor({ ...CATALOG_MODEL, name: 'Plain Chat', multiplier: 2 }),
    'Plain Chat (x2.0)',
  )
  assert.equal(
    displayNameFor({ ...CATALOG_MODEL, name: 'Odd', multiplier: 0.8 }),
    'Odd (x0.8)',
  )
  assert.equal(
    displayNameFor({ ...CATALOG_MODEL, name: 'MiMo V2.5', multiplier: 3.3 }),
    'MiMo V2.5 (x3.3)',
  )
})

test('toPiModel maps identity, limits, modalities and reasoning consistently', () => {
  const model = toPiModel(CATALOG_MODEL, `${BASE}/`)

  assert.equal(model.id, CATALOG_MODEL.id)
  assert.equal(model.name, 'qwen 3.8 flash（x0.8）', 'the picker shows the upstream name; the route badge beside it names the source')
  assert.equal(model.api, LOOMY_API)
  assert.equal(model.api, 'openai-completions')
  assert.equal(model.provider, 'loomy', 'a single-route design uses the route id as the model provider')
  assert.equal(model.baseUrl, BASE, 'trailing slashes are trimmed')
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.contextWindow, 1_000_000)
  assert.equal(model.maxTokens, 131_072)
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.thinkingLevelMap, {
    off: 'none',
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: null,
  })
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

  // The wire compatibility is part of the contract: max_tokens is the field
  // the desktop client sends, and a stream without finish_reason must be a
  // truncation (which is what feeds the retryable classification).
  assert.equal(model.compat.maxTokensField, 'max_tokens')
  assert.equal(model.compat.supportsFinishReason, true)
  assert.equal(model.compat.supportsReasoningEffort, true)
  assert.equal(model.compat.supportsUsageInStreaming, true)
  assert.equal(model.compat.supportsStore, false)
  assert.equal(model.compat.supportsDeveloperRole, false)
  assert.equal(model.compat.thinkingFormat, 'openai')

  const plain = toPiModel(PLAIN_MODEL, BASE)
  assert.deepEqual(plain.input, ['text'])
  assert.equal(plain.reasoning, false)
  assert.equal(plain.thinkingLevelMap, undefined)
  assert.equal(plain.name, 'Plain Chat (x0.0)')
})

test('thinkingLevelMapFor advertises only upstream-supported efforts', () => {
  assert.deepEqual(thinkingLevelMapFor(['none', 'medium', 'xhigh']), {
    off: 'none',
    minimal: null,
    low: null,
    medium: 'medium',
    high: null,
    xhigh: 'xhigh',
    max: null,
  })
  assert.deepEqual(thinkingLevelMapFor([]), {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  })
})

test('prepareLoomyHeaders mints fresh traceparent/chatid/msgid for every request', () => {
  const request = { provider: 'loomy', model: 'qwen3.8-flash', sessionId: 'session-1', baseURL: BASE }
  const first = prepareLoomyHeaders(request, new Headers(), '0.9.39')
  const second = prepareLoomyHeaders(request, new Headers(), '0.9.39')

  for (const headers of [first, second]) {
    assert.match(headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
    assert.match(headers.get('chatid'), /^chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    assert.match(headers.get('msgid'), /^msg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    assert.equal(headers.get('loomy-version'), '0.9.39')
    assert.equal(headers.get('invokeorigin'), 'user')
  }

  // A message must never reuse another message's msgid, and the whole tracing
  // tuple is per-dispatch rather than per-session.
  assert.notEqual(first.get('msgid'), second.get('msgid'))
  assert.notEqual(first.get('chatid'), second.get('chatid'))
  assert.notEqual(first.get('traceparent'), second.get('traceparent'))

  // Other routes are left untouched.
  const foreign = prepareLoomyHeaders({ ...request, provider: 'other' }, new Headers(), '0.9.39')
  assert.equal(foreign.get('traceparent'), null)
  assert.equal(foreign.get('loomy-version'), null)
})

test('prepareHeaders runs on a real adapter dispatch and reaches the wire request', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const auth = createAuthStore({ candidates: [candidate(authPath)] })
  const runtime = createProviderRuntime({
    catalog: { enabledModels: () => [CATALOG_MODEL] },
    baseURL: () => BASE,
    loomyVersion: () => '0.9.39',
    readSession: () => auth.read(),
    precheck: async () => ({ ok: true, definite: false }),
  })

  const frame = (choices) => ({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: CATALOG_MODEL.id,
    choices,
  })
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const frames = [
      frame([{ index: 0, delta: { content: 'hello' }, finish_reason: null }]),
      frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]
    return new Response(
      `${frames.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }

  try {
    const chunks = []
    for await (const chunk of runtime.adapter.stream({
      provider: 'loomy',
      model: CATALOG_MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    globalThis.fetch = originalFetch
  }

  // The tracing headers are minted by our hook and actually serialised by the
  // OpenAI-compatible client; authentication is the session read from the
  // desktop sign-in file, sent as `Authorization: Bearer`.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/chat/completions`)
  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${SESSION}`)
  assert.match(headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
  assert.match(headers.get('chatid'), /^chat-/u)
  assert.match(headers.get('msgid'), /^msg-/u)
  assert.equal(headers.get('loomy-version'), '0.9.39')
  assert.equal(headers.get('invokeorigin'), 'user')

  // A second dispatch must not reuse the first one's msgid.
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const frames = [frame([{ index: 0, delta: {}, finish_reason: 'stop' }])]
    return new Response(
      `${frames.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  let secondMsgId
  try {
    for await (const _chunk of runtime.adapter.stream({
      provider: 'loomy',
      model: CATALOG_MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
    })) {
      void _chunk
    }
    secondMsgId = new Headers(calls[calls.length - 1].init.headers).get('msgid')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.notEqual(secondMsgId, new Headers(calls[0].init.headers).get('msgid'))
})

test('createProviderRuntime builds the resolved profile the adapter requires', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const auth = createAuthStore({ candidates: [candidate(authPath)] })
  const models = [CATALOG_MODEL, PLAIN_MODEL]
  const runtime = createProviderRuntime({
    catalog: { enabledModels: () => models },
    baseURL: () => BASE,
    loomyVersion: () => '0.9.39',
    readSession: () => auth.read(),
    precheck: async () => ({ ok: true, definite: false }),
  })

  assert.equal(runtime.profiles.size, 1)
  assert.deepEqual([...runtime.profiles.keys()], ['loomy'])

  const profile = runtime.profiles.get('loomy')
  assert.equal(profile.provider, 'loomy')
  assert.equal(profile.displayName, 'Loomy')
  assert.equal(profile.streamIdleTimeoutMs, 300_000)
  assert.ok(profile.retryPolicy !== undefined, 'a resolved retry policy is captured with the route')
  assert.ok(profile.maxRequestImageBytes > 0)
  assert.ok(profile.maxRequestImages > 0)
  assert.ok(profile.requestImagePixelBudget > 0)
  assert.ok(profile.requestImageMaxBytes > 0)
  assert.ok(profile.configuredMaxTokens instanceof Map)
  assert.ok(profile.modelErrors instanceof Map)
  assert.equal(profile.piProvider.id, 'loomy')
  assert.equal(profile.piProvider.name, 'Loomy')

  const piModels = profile.piProvider.getModels()
  assert.deepEqual(piModels.map((model) => model.id), ['qwen3.8-flash', 'plain-chat'])
  for (const model of piModels) {
    assert.equal(model.provider, 'loomy')
    assert.equal(model.api, 'openai-completions')
    assert.equal(model.provider, profile.provider, 'identity: provider id, route key and model.provider agree')
  }

  // The adapter resolves the session through `readAuthSession` for every
  // operation, then serves the current live model list.
  const listed = await runtime.adapter.listModels('loomy')
  assert.deepEqual(listed.map((model) => model.id), ['qwen3.8-flash', 'plain-chat'])
  assert.deepEqual(runtime.adapter.providerInfo('loomy'), { id: 'loomy', name: 'Loomy' })
  assert.ok(runtime.adapter.providerRetryPolicy('loomy') !== undefined)
})

test('resolveApiKey surfaces MISSING_CREDENTIAL for a signed-out or expired session', async (t) => {
  const signedOut = createProviderRuntime({
    catalog: { enabledModels: () => [CATALOG_MODEL] },
    baseURL: () => BASE,
    loomyVersion: () => '0.9.39',
    readSession: async () => ({
      found: false,
      sourcePath: '/tmp/missing.json',
      problem: '本机没有找到 Loomy 登录态文件（/tmp/missing.json）。请启动 Loomy 客户端并完成登录。',
    }),
    precheck: async () => ({ ok: true, definite: false }),
  })
  assert.deepEqual(await signedOut.adapter.listModels('loomy'), [])
  await assert.rejects(
    () => signedOut.adapter.config.resolveApiKey('loomy', signedOut.profiles.get('loomy')),
    (error) => {
      assert.equal(error.code, 'MISSING_CREDENTIAL')
      assert.match(error.message, /missing\.json/u)
      return true
    },
  )

  const expired = createProviderRuntime({
    catalog: { enabledModels: () => [CATALOG_MODEL] },
    baseURL: () => BASE,
    loomyVersion: () => '0.9.39',
    readSession: async () => ({ found: true, sourcePath: '/tmp/auth.json', session: SESSION }),
    precheck: async () => ({ ok: false, definite: true, message: '本机 Loomy 登录态已失效（上游 100002）。请重新登录。' }),
  })
  assert.deepEqual(await expired.adapter.listModels('loomy'), [])
  await assert.rejects(
    () => expired.adapter.config.resolveApiKey('loomy', expired.profiles.get('loomy')),
    (error) => {
      assert.equal(error.code, 'MISSING_CREDENTIAL')
      assert.match(error.message, /100002/u)
      return true
    },
  )
})

test('a non-definite precheck never blocks inference', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const auth = createAuthStore({ candidates: [candidate(authPath)] })
  const runtime = createProviderRuntime({
    catalog: { enabledModels: () => [CATALOG_MODEL] },
    baseURL: () => BASE,
    loomyVersion: () => '0.9.39',
    readSession: () => auth.read(),
    precheck: async () => ({ ok: false, definite: false, message: 'identity probe timed out' }),
  })
  assert.deepEqual(
    (await runtime.adapter.listModels('loomy')).map((model) => model.id),
    ['qwen3.8-flash'],
  )
  assert.equal(
    await runtime.adapter.config.resolveApiKey('loomy', runtime.profiles.get('loomy')),
    SESSION,
  )
})

test('classification: reasoning-only finish_reason=length is a legitimate truncation', async () => {
  const { faux, adapter } = classificationAdapter()
  const chunks = await chunksFor(faux, adapter, fauxAssistantMessage([fauxThinking('think only')], { stopReason: 'length' }))
  const finish = chunks.at(-1)

  assert.equal(finish.type, 'finish')
  assert.deepEqual(finish.reason, { kind: 'max-tokens' })
  assert.notEqual(finish.reason.kind, 'error', 'length truncation is not an empty response')
  assert.ok(chunks.some((chunk) => chunk.type === 'reasoning-delta'), 'the reasoning block is preserved')
  assert.ok(!chunks.some((chunk) => chunk.type === 'text-delta'), 'no text answer exists by design')
})

test('classification: [DONE] without finish_reason is a retryable TRANSPORT truncation', async () => {
  const { faux, adapter } = classificationAdapter()
  const chunks = await chunksFor(
    faux,
    adapter,
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Stream ended without finish_reason' }),
  )
  const finish = chunks.at(-1)

  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
  assert.equal(finish.reason.failure.message, 'Stream ended without finish_reason')
})

test('classification: a completed response with no content is EMPTY_RESPONSE', async () => {
  const { faux, adapter } = classificationAdapter()
  const chunks = await chunksFor(faux, adapter, fauxAssistantMessage([], { stopReason: 'stop' }))
  const finish = chunks.at(-1)

  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
  assert.match(finish.reason.failure.message, /no content/u)
})

test('the real openai-completions stream accepts a separate choices:[] usage frame', async () => {
  const model = toPiModel(CATALOG_MODEL, BASE)
  const frame = (choices, extra = {}) => ({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: CATALOG_MODEL.id,
    choices,
    ...extra,
  })
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const frames = [
      frame([{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' }, finish_reason: null }]),
      frame([{ index: 0, delta: { content: 'hello' }, finish_reason: null }]),
      frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      // The upstream sends usage in its own frame with an empty choices array;
      // it must not be treated as an anomaly nor hide the finish reason.
      frame([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ]
    return new Response(
      `${frames.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }

  const events = []
  for await (const event of stream(model, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, {
    apiKey: 'conversation-session',
    fetch: fetchImpl,
  })) {
    events.push(event)
  }

  const done = events.at(-1)
  assert.equal(done.type, 'done')
  assert.equal(done.reason, 'stop')
  assert.equal(done.message.usage.totalTokens, 15, 'the standalone usage frame is applied')
  assert.ok(done.message.content.some((block) => block.type === 'text' && block.text === 'hello'))

  // The conversation endpoint authenticates with `Authorization: Bearer`, and
  // the request body asks for streamed usage (our compat enables it).
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/chat/completions`)
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer conversation-session')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.model, CATALOG_MODEL.id)
})

test('a stream that ends without finish_reason fails at the real pi-ai layer', async () => {
  // This is the upstream "silent truncation" quirk. Our compat says streams
  // always carry finish_reason, so pi-ai must refuse to infer `stop`; the
  // resulting message feeds the TRANSPORT classification exercised above.
  const model = toPiModel(CATALOG_MODEL, BASE)
  const fetchImpl = async () =>
    new Response(
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: CATALOG_MODEL.id,
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )

  const events = []
  for await (const event of stream(model, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, {
    apiKey: 'conversation-session',
    fetch: fetchImpl,
  })) {
    events.push(event)
  }
  const terminal = events.at(-1)
  assert.equal(terminal.type, 'error')
  assert.equal(terminal.error.errorMessage, 'Stream ended without finish_reason')
})

function runtimeWith(auth, precheck, catalog = {}) {
  return createProviderRuntime({
    catalog: {
      enabledModels: () => [CATALOG_MODEL],
      kickStaleRefresh() {},
      ...catalog,
    },
    baseURL: () => BASE,
    loomyVersion: () => '0.9.39',
    readSession: () => auth.read(),
    precheck,
    logger: { warn() {} },
  })
}

test('getModels kicks the background stale sync and stays synchronous/non-throwing', async (t) => {
  const dir = tempDir(t)
  const auth = createAuthStore({ candidates: [candidate(writeAuthFile(dir))] })
  const kicks = []
  const runtime = runtimeWith(auth, async () => ({ ok: true, definite: false }), {
    kickStaleRefresh() {
      kicks.push(Date.now())
    },
  })

  const first = runtime.provider.getModels()
  const second = runtime.provider.getModels()
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(kicks.length, 2, 'each synchronous read asks the catalog to sync; the catalog throttles')
  assert.equal(first[0].id, CATALOG_MODEL.id)

  // A throwing scheduling hook must not violate pi-ai's getModels() contract.
  const throwing = runtimeWith(auth, async () => ({ ok: true, definite: false }), {
    kickStaleRefresh() {
      throw new Error('scheduler exploded')
    },
  })
  assert.equal(throwing.provider.getModels().length, 1)
})

test('F3: an empty zero-token TRANSPORT is upgraded after a forced precheck', async (t) => {
  const dir = tempDir(t)
  const auth = createAuthStore({ candidates: [candidate(writeAuthFile(dir))] })
  const prechecks = []
  const runtime = runtimeWith(auth, async (_session, options) => {
    prechecks.push(Boolean(options?.force))
    if (options?.force === true) {
      return {
        ok: false,
        definite: true,
        message: '本机 Loomy 登录态已失效（上游 100002：登录已失效）。请在 Loomy 客户端重新登录。',
      }
    }
    return { ok: true, definite: false }
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: '100002', desc: '登录已失效' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of runtime.adapter.stream({
          provider: 'loomy',
          model: CATALOG_MODEL.id,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) {
          void _chunk
        }
      },
      (error) => {
        assert.equal(error.code, 'MISSING_CREDENTIAL')
        assert.match(error.message, /100002/u)
        assert.match(error.message, /重新登录/u)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(prechecks, [false, true], 'exactly one forced re-probe after the initial precheck')
})

test('F3: the upgrade also covers the production prepareCall().stream() path', async (t) => {
  const dir = tempDir(t)
  const auth = createAuthStore({ candidates: [candidate(writeAuthFile(dir))] })
  const prechecks = []
  const runtime = runtimeWith(auth, async (_session, options) => {
    prechecks.push(Boolean(options?.force))
    return options?.force === true
      ? { ok: false, definite: true, message: '本机 Loomy 登录态已失效（上游 100002）。请重新登录。' }
      : { ok: true, definite: false }
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: '100002', desc: '登录已失效' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  try {
    // `LlmRuntime` freezes a step with prepareCall() and consumes the closure's
    // stream, so the disambiguation has to live on that path too.
    const prepared = await runtime.adapter.prepareCall('loomy', CATALOG_MODEL.id)
    await assert.rejects(
      async () => {
        for await (const _chunk of prepared.stream({
          provider: 'loomy',
          model: CATALOG_MODEL.id,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) {
          void _chunk
        }
      },
      (error) => {
        assert.equal(error.code, 'MISSING_CREDENTIAL')
        assert.match(error.message, /100002/u)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(prechecks, [false, true])
})

test('F3: an empty zero-token TRANSPORT stays TRANSPORT when the forced probe is not definite', async (t) => {
  const dir = tempDir(t)
  const auth = createAuthStore({ candidates: [candidate(writeAuthFile(dir))] })
  const prechecks = []
  const runtime = runtimeWith(auth, async (_session, options) => {
    prechecks.push(Boolean(options?.force))
    return options?.force === true
      ? { ok: false, definite: false, code: 'timeout', message: 'identity probe timed out' }
      : { ok: true, definite: false }
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: '100002', desc: '登录已失效' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  try {
    const chunks = []
    for await (const chunk of runtime.adapter.stream({
      provider: 'loomy',
      model: CATALOG_MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'TRANSPORT')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(prechecks, [false, true])
})

test('F3: a truncation with content keeps TRANSPORT and costs no extra probe', async (t) => {
  const dir = tempDir(t)
  const auth = createAuthStore({ candidates: [candidate(writeAuthFile(dir))] })
  const prechecks = []
  const runtime = runtimeWith(auth, async (_session, options) => {
    prechecks.push(Boolean(options?.force))
    return { ok: true, definite: false }
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: CATALOG_MODEL.id,
        choices: [{ index: 0, delta: { content: 'partial answer' }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  try {
    const chunks = []
    for await (const chunk of runtime.adapter.stream({
      provider: 'loomy',
      model: CATALOG_MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'TRANSPORT')
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'partial answer'))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(prechecks, [false], 'no forced /user/identity probe for a content-bearing truncation')
})

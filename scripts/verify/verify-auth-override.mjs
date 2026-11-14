#!/usr/bin/env node
/**
 * The two header planes, proven on a real loopback gateway.
 *
 * This script exists because of one specific regression: the pi-ai auth-override
 * echo. `src/provider.ts` must return `{ auth: { apiKey: credential.key } }`
 * from `auth.apiKey.resolve`. If it returns `undefined` instead, pi-ai's
 * `Models.applyAuth()` throws `Provider is not configured: loomy` **before any
 * I/O**, so every inference request fails while the CLI, `doctor` and the
 * settings card keep looking healthy (they never run inference).
 *
 * The guard is behavioural and independent of `src/`:
 * 1. two hand-built providers — one echoing the override, one returning
 *    `undefined` — are driven through the real `PiAiAdapter` against a local
 *    HTTP gateway. The echoing one must reach the wire with
 *    `Authorization: Bearer <session>`; the broken one must fail with **zero**
 *    requests;
 * 2. the shipped provider runtime (`createProviderRuntime` from `lib/`) is
 *    driven the same way, so a source regression would fail after the next
 *    `pnpm build`;
 * 3. the platform client (`requestPlatform`) uses the bare `token:` header on
 *    all three platform paths and never `Authorization` — and the mock gateway,
 *    like the real one, answers `100002` when only `Authorization` is sent.
 *
 * Run: `node scripts/verify/verify-auth-override.mjs`
 *
 * @module dsh-connect-loomy/verify/auth-override
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { CheckLog, ensure, ensureEqual, ensureMatch } from './checks.mjs'
import { FAKE_SESSION, MOCK_CHAT_IDS, startMockUpstream } from './mock-upstream.mjs'

const checks = new CheckLog('auth-override')
const mock = await startMockUpstream()

/** Inert pi-ai credential plane, identical to the plugin's. */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('verify: no credential lifecycle')
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

/** One model descriptor pointing at the mock gateway. */
const MOCK_MODEL = {
  id: 'm1',
  name: 'M1',
  api: 'openai-completions',
  provider: 'loomy',
  baseUrl: mock.baseURL,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
  reasoning: false,
}

/** A resolved profile with the fields the adapter requires. */
function profileFor(provider) {
  return {
    provider: 'loomy',
    displayName: 'Loomy',
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'verify'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20 * 1024 * 1024,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 4 * 1024 * 1024,
    requestImageMaxBytes: 1024 * 1024,
    piProvider: provider,
  }
}

/**
 * The auth plane under test: `echo` mirrors `src/provider.ts`; `undefined`
 * mirrors the regression. Everything else is identical.
 */
function makeProvider(echoOverride) {
  return {
    ...createProvider({
      id: 'loomy',
      name: 'Loomy',
      auth: {
        apiKey: {
          name: 'Loomy desktop session',
          async resolve({ credential }) {
            if (!echoOverride) return undefined
            const apiKey = credential?.key
            if (apiKey === undefined || apiKey.length === 0) return undefined
            return { auth: { apiKey }, source: 'Loomy desktop session' }
          },
        },
      },
      models: [],
      api: openAICompletionsApi(),
    }),
    getModels: () => [MOCK_MODEL],
  }
}

function makeAdapter(echoOverride) {
  return new PiAiAdapter({
    profiles: () => new Map([['loomy', profileFor(makeProvider(echoOverride))]]),
    resolveApiKey: async () => FAKE_SESSION,
    auth: INERT_AUTH,
  })
}

/** Drive one stream to its terminal chunk, returning the chunks. */
async function collect(adapter) {
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

let fixture
try {
  // 1) echo override reaches the wire -------------------------------------
  const echoing = makeAdapter(true)
  const before = mock.matching('/chat/completions').length
  const echoedChunks = await collect(echoing)
  const echoedCalls = mock.matching('/chat/completions')

  await checks.run('echoed auth override sends exactly one request with Authorization: Bearer', async () => {
    ensureEqual(echoedCalls.length, before + 1, 'request count')
    ensureEqual(echoedCalls.at(-1).headers['authorization'], `Bearer ${FAKE_SESSION}`, 'authorization header')
    ensure(echoedCalls.at(-1).headers['token'] === undefined, 'the conversation plane must not use token:')
    const finish = echoedChunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason, { kind: 'stop' }, 'finish reason')
  })

  // 2) the regression fails before any I/O --------------------------------
  const broken = makeAdapter(false)
  const countBeforeBroken = mock.matching('/chat/completions').length
  const brokenChunks = await collect(broken)
  await checks.run('dropping the override fails with zero requests and no success', async () => {
    ensureEqual(
      mock.matching('/chat/completions').length,
      countBeforeBroken,
      'a provider that drops the override must not issue any request',
    )
    const finish = brokenChunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason.kind, 'error', 'finish kind')
    ensureMatch(finish.reason.failure.message, /Provider is not configured: loomy/u, 'failure message')
    ensure(finish.reason.kind !== 'stop', 'the regression must never look like a successful answer')
    const policy = profileFor(makeProvider(false)).retryPolicy
    ensure(
      !policy.retryableCodes.includes(finish.reason.failure.code),
      `PI_AI_ERROR must not be advertised as retryable (${finish.reason.failure.code})`,
    )
  })

  // 3) the shipped runtime behaves like the echoing provider ----------------
  const shipped = await import('../../lib/index.js')
  const runtime = shipped.createProviderRuntime({
    catalog: { enabledModels: () => [
      {
        id: 'qwen3.8-flash',
        name: 'qwen 3.8 flash（x0.8）',
        multiplier: 0.8,
        contextWindow: 1_000_000,
        maxOutput: 131_072,
        vision: true,
        efforts: ['none', 'low', 'high'],
        defaultEffort: 'low',
      },
    ] },
    baseURL: () => mock.baseURL,
    loomyVersion: () => '0.9.39',
    readSession: async () => ({ found: true, sourcePath: '/tmp/verify-auth.json', session: FAKE_SESSION }),
    precheck: async () => ({ ok: true, definite: false, checkedAt: 0 }),
  })
  const countBeforeShipped = mock.matching('/chat/completions').length
  const shippedChunks = []
  for await (const chunk of runtime.adapter.stream({
    provider: 'loomy',
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'shipped runtime' }] }],
  })) {
    shippedChunks.push(chunk)
  }
  await checks.run('shipped createProviderRuntime echoes the override to the wire', async () => {
    const calls = mock.matching('/chat/completions')
    ensureEqual(calls.length, countBeforeShipped + 1, 'the shipped runtime issued a request')
    ensureEqual(calls.at(-1).headers['authorization'], `Bearer ${FAKE_SESSION}`, 'authorization header')
    const finish = shippedChunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason, { kind: 'stop' }, 'finish reason')
    ensure(
      shippedChunks.some((chunk) => chunk.type === 'text-delta' && chunk.text.length > 0),
      'the answer text reached the harness',
    )
  })

  // 4) the platform plane is token-only ------------------------------------
  const platformCallsBefore = mock.requests.length
  const platformPaths = ['/models', '/points/records', '/user/identity']
  for (const path of platformPaths) {
    const result = await shipped.requestPlatform({ baseURL: mock.baseURL, path, session: FAKE_SESSION })
    ensureEqual(result.kind, 'ok', `requestPlatform(${path}) must succeed against the mock`)
  }
  await checks.run('all three platform paths send token: and never Authorization', async () => {
    const calls = mock.requests.slice(platformCallsBefore)
    ensureEqual(calls.length, platformPaths.length, 'platform request count')
    for (const call of calls) {
      ensureEqual(call.headers['token'], FAKE_SESSION, `${call.path} token header`)
      ensure(call.headers['authorization'] === undefined, `${call.path} must not send Authorization`)
    }
  })

  // The mock (like the real gateway) rejects a bearer-only platform call, so
  // the separation is observable, not just an assertion about our headers.
  const bearerOnly = await fetch(`${mock.baseURL}/models`, {
    headers: { authorization: `Bearer ${FAKE_SESSION}`, accept: 'application/json' },
  })
  const bearerOnlyBody = await bearerOnly.json()
  await checks.run('the gateway rejects a bearer-only platform call with 100002', async () => {
    ensureEqual(bearerOnly.status, 200, 'platform failures are HTTP 200 + envelope')
    ensureEqual(bearerOnlyBody.code, '100002', 'business code')
  })

  // And the reverse: a token-only conversation call is also rejected.
  const tokenOnly = await fetch(`${mock.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { token: FAKE_SESSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'spark-x2.6', messages: [] }),
  })
  const tokenOnlyBody = await tokenOnly.json()
  await checks.run('the gateway rejects a token-only conversation call with 100002', async () => {
    ensureEqual(tokenOnly.status, 200, 'conversation auth failures are HTTP 200 + envelope')
    ensureEqual(tokenOnlyBody.code, '100002', 'business code')
  })
} finally {
  if (fixture !== undefined) await fixture.close()
  await mock.close()
}

process.exitCode = checks.finish()

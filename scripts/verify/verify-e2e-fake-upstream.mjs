#!/usr/bin/env node
/**
 * End-to-end provider verification against a local OpenAI-compatible mock.
 *
 * What it proves, through the shipped `lib/index.js` (no source imports, no
 * fetch double, no stubbed adapter):
 *
 * 1. the plugin mounts and registers exactly one `loomy` provider route;
 * 2. a conversation request reaches the gateway with `Authorization: Bearer
 *    <desktop session>` plus the tracing headers (`traceparent`, `chatid`,
 *    `msgid`, `loomy-version`, `invokeorigin`), and the requested model id,
 *    `max_tokens` field and `stream_options.include_usage`;
 * 3. streaming and single-frame (non-incremental) answers both terminate
 *    cleanly with `stop`, and a reasoning-only `finish_reason:length` answer is
 *    `max-tokens` (a legal truncation, not an empty response);
 * 4. `[DONE]` without `finish_reason` (silent truncation) is classified as a
 *    retryable `TRANSPORT` failure, never as a successful `stop`; the resolved
 *    retry policy really lists `TRANSPORT`;
 * 5. the platform endpoints (`/models`, `/points/records`, `/user/identity`)
 *    authenticate with the bare `token:` header and never send `Authorization`
 *    — and the conversation endpoint never sends `token:`;
 * 6. the state cache is written `0600` and carries no session/PII, and the
 *    plugin's own log lines carry no session.
 *
 * Run: `node scripts/verify/verify-e2e-fake-upstream.mjs`
 *
 * @module dsh-connect-loomy/verify/e2e-fake-upstream
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CheckLog, ensure, ensureEqual, ensureMatch } from './checks.mjs'
import { FAKE_PHONE, FAKE_SESSION, FAKE_USER_ID, MOCK_CHAT_IDS, startMockUpstream } from './mock-upstream.mjs'
import { mountPlugin } from './mount-fixture.mjs'

const checks = new CheckLog('e2e-fake-upstream')
const mock = await startMockUpstream()

/** Drive one adapter stream and collect every chunk. */
async function collectStream(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** The terminal finish chunk of a collected stream. */
function finishOf(chunks) {
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  ensure(finish !== undefined, 'stream produced no finish chunk')
  return finish
}

/** Text/reasoning deltas concatenated, for readable assertions. */
function textOf(chunks) {
  return chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

let fixture
try {
  fixture = await mountPlugin({ baseURL: mock.baseURL })

  await checks.run('plugin mounts through lib/index.js without throwing', async () => {
    if (fixture.applyError !== undefined) throw fixture.applyError
  })
  await checks.run('exactly one provider route (loomy) is registered', async () => {
    ensureEqual(fixture.providerIds, ['loomy'], 'registered provider ids')
    ensure(fixture.adapter !== undefined, 'adapter captured from ctx.llm.registerAdapter')
  })

  // The catalog is fetched lazily on the first card/route read; do the real
  // HTTP round-trip the browser would do before asking for models.
  const statusResponse = await fixture.request('/plugins/dsh-connect-loomy/status')
  await checks.run('GET /status returns masked account and the enabled model ids', async () => {
    ensureEqual(statusResponse.status, 200, 'status code')
    ensureEqual(statusResponse.headers['cache-control'], 'no-store', 'cache-control')
    const body = JSON.parse(statusResponse.text)
    ensureEqual(body.ok, true, 'ok')
    ensureMatch(body.csrfToken, /^[A-Za-z0-9_-]{16,}$/u, 'csrfToken')
    ensureEqual(body.account.maskedPhone, '138****1234', 'masked phone')
    ensureEqual(body.account.userId, '1234**********5678', 'masked user id')
    ensureEqual(body.credential.found, true, 'credential.found')
    ensureEqual(body.enabledModelIds, MOCK_CHAT_IDS, 'enabledModelIds')
    ensure(!statusResponse.text.includes(FAKE_SESSION), 'the session must never reach the browser payload')
    ensure(!statusResponse.text.includes(FAKE_PHONE), 'the raw phone must never reach the browser payload')
  })
  await checks.run('model list comes from the live catalog and filters auto/image/legacy', async () => {
    const models = await fixture.listModels()
    ensureEqual(models.map((model) => model.id), MOCK_CHAT_IDS, 'adapter model ids')
    ensure(!models.some((model) => model.id === 'auto'), 'auto must never be registered')
    ensure(!models.some((model) => model.name.startsWith('Hy image')), 'image models must never be registered')
  })

  const creditsResponse = await fixture.request('/plugins/dsh-connect-loomy/credits')
  await checks.run('GET /credits reports the three upstream buckets and the ledger', async () => {
    ensureEqual(creditsResponse.status, 200, 'status code')
    const body = JSON.parse(creditsResponse.text)
    ensureEqual(body.ok, true, 'ok')
    ensureEqual(body.balance, 1_250, 'balance')
    ensureEqual(body.dailyBalance, 300, 'dailyBalance')
    ensureEqual(body.availableBalance, 1_550, 'availableBalance')
    ensureEqual(body.records.length, 2, 'ledger rows')
    ensure(!creditsResponse.text.includes(FAKE_SESSION), 'the session must never reach the browser payload')
  })

  const diagnosticsResponse = await fixture.request('/plugins/dsh-connect-loomy/diagnostics')
  await checks.run('GET /diagnostics probes the three platform endpoints without leaking credentials', async () => {
    ensureEqual(diagnosticsResponse.status, 200, 'status code')
    const body = JSON.parse(diagnosticsResponse.text)
    ensureEqual(
      body.probes.map((probe) => [probe.path, probe.ok]),
      [
        ['/models', true],
        ['/points/records', true],
        ['/user/identity', true],
      ],
      'probe verdicts',
    )
    ensureEqual(body.account.maskedPhone, '138****1234', 'masked phone')
    ensure(!diagnosticsResponse.text.includes(FAKE_SESSION), 'the session must never reach the browser payload')
  })

  // ---- streaming -----------------------------------------------------------
  mock.setChatMode('stream')
  const streamingChunks = await collectStream(fixture.adapter, {
    provider: 'loomy',
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    maxTokens: 64,
    reasoningEffort: 'high',
  })

  await checks.run('streaming answer terminates with stop and keeps the text', async () => {
    const finish = finishOf(streamingChunks)
    ensureEqual(finish.reason, { kind: 'stop' }, 'finish reason')
    ensureEqual(textOf(streamingChunks), '你好，我是 Loomy mock。', 'streamed text')
    ensure(
      streamingChunks.some((chunk) => chunk.type === 'reasoning-delta'),
      'reasoning delta must be preserved as a reasoning block',
    )
    const usage = streamingChunks.find((chunk) => chunk.type === 'usage')
    ensure(usage !== undefined, 'usage chunk must be emitted before finish')
    ensureEqual(usage.usage.totalTokens, 20, 'standalone usage frame is applied')
  })

  const chatCalls = mock.matching('/chat/completions')
  const firstChat = chatCalls[0]
  await checks.run('conversation request carries Authorization: Bearer <session>', async () => {
    ensure(firstChat !== undefined, 'no /chat/completions request was recorded')
    ensureEqual(firstChat.method, 'POST', 'method')
    ensureEqual(firstChat.headers['authorization'], `Bearer ${FAKE_SESSION}`, 'authorization header')
    ensure(firstChat.headers['token'] === undefined, 'the platform `token:` header must never reach the conversation endpoint')
  })
  await checks.run('conversation request carries traceparent/chatid/msgid/loomy-version/invokeorigin', async () => {
    ensureMatch(firstChat.headers['traceparent'], /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u, 'traceparent')
    ensureMatch(firstChat.headers['chatid'], /^chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'chatid')
    ensureMatch(firstChat.headers['msgid'], /^msg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'msgid')
    ensureEqual(firstChat.headers['loomy-version'], '0.9.39', 'loomy-version')
    ensureEqual(firstChat.headers['invokeorigin'], 'user', 'invokeorigin')
  })
  await checks.run('conversation body pins model, max_tokens, stream usage and reasoning effort', async () => {
    const body = JSON.parse(firstChat.rawBody)
    ensureEqual(body.model, 'qwen3.8-flash', 'body.model')
    ensureEqual(body.stream, true, 'body.stream')
    ensureEqual(body.stream_options, { include_usage: true }, 'body.stream_options')
    ensureEqual(body.max_tokens, 64, 'body.max_tokens (not max_completion_tokens)')
    ensure(body.max_completion_tokens === undefined, 'max_completion_tokens must not be sent')
    ensureEqual(body.reasoning_effort, 'high', 'body.reasoning_effort')
    ensure(body.store === undefined, 'store must not be sent (compat.supportsStore=false)')
  })
  await checks.run('a second dispatch mints a fresh msgid/chatid/traceparent', async () => {
    const before = mock.matching('/chat/completions').length
    await collectStream(fixture.adapter, {
      provider: 'loomy',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '再来一次' }] }],
    })
    const latest = mock.matching('/chat/completions').at(-1)
    ensure(mock.matching('/chat/completions').length === before + 1, 'second request was not sent')
    ensure(latest.headers['msgid'] !== firstChat.headers['msgid'], 'msgid must be per-message')
    ensure(latest.headers['chatid'] !== firstChat.headers['chatid'], 'chatid is minted per dispatch')
    ensure(latest.headers['traceparent'] !== firstChat.headers['traceparent'], 'traceparent is minted per dispatch')
  })

  // ---- single complete frame (the non-incremental upstream shape) -----------
  mock.setChatMode('single')
  const singleChunks = await collectStream(fixture.adapter, {
    provider: 'loomy',
    model: 'spark-x2.6',
    messages: [{ role: 'user', content: [{ type: 'text', text: '一次答完' }] }],
  })
  await checks.run('single-frame answer (non-incremental shape) terminates with stop', async () => {
    ensureEqual(finishOf(singleChunks).reason, { kind: 'stop' }, 'finish reason')
    ensureEqual(textOf(singleChunks), '一次完整应答。', 'text')
  })

  // ---- reasoning-only length truncation -------------------------------------
  mock.setChatMode('lengthOnly')
  const lengthChunks = await collectStream(fixture.adapter, {
    provider: 'loomy',
    model: 'DeepSeek-V4.1-Flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '用尽长度' }] }],
    maxTokens: 8,
  })
  await checks.run('reasoning-only finish_reason=length is max-tokens, not an empty response', async () => {
    const finish = finishOf(lengthChunks)
    ensureEqual(finish.reason, { kind: 'max-tokens' }, 'finish reason')
    ensure(textOf(lengthChunks) === '', 'reasoning ate the whole budget, so no text is expected')
    ensure(
      lengthChunks.some((chunk) => chunk.type === 'reasoning-delta'),
      'the reasoning block is preserved',
    )
  })

  // ---- silent truncation ----------------------------------------------------
  mock.setChatMode('truncation')
  const truncatedChunks = await collectStream(fixture.adapter, {
    provider: 'loomy',
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '说一半' }] }],
  })
  const truncatedFinish = finishOf(truncatedChunks)
  await checks.run('[DONE] without finish_reason is a TRANSPORT failure, never a success', async () => {
    ensureEqual(truncatedFinish.reason.kind, 'error', 'finish kind')
    ensure(truncatedFinish.reason.kind === 'error', 'finish must be an error')
    ensureEqual(truncatedFinish.reason.failure.code, 'TRANSPORT', 'failure code')
    ensureMatch(truncatedFinish.reason.failure.message, /without finish_reason/u, 'failure message')
    ensure(truncatedFinish.reason.kind !== 'stop', 'a truncated stream must never look successful')
  })
  await checks.run('the resolved retry policy really retries TRANSPORT', async () => {
    const policy = fixture.adapter.providerRetryPolicy('loomy')
    ensure(policy !== undefined, 'no retry policy')
    ensureEqual(policy.mode, 'normal', 'policy mode')
    ensure(policy.retryableCodes.includes('TRANSPORT'), `TRANSPORT missing from ${JSON.stringify(policy.retryableCodes)}`)
  })

  // A JSON completion on the stream wire is not part of the DSH path; record
  // what actually happens: a deterministic retryable failure, never a hang and
  // never a fabricated success.
  mock.setChatMode('json')
  const jsonChunks = await collectStream(fixture.adapter, {
    provider: 'loomy',
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '非流式' }] }],
  })
  await checks.run('a JSON (true non-streaming) completion is rejected as TRANSPORT, not accepted as success', async () => {
    const finish = finishOf(jsonChunks)
    ensureEqual(finish.reason.kind, 'error', 'finish kind')
    ensureEqual(finish.reason.failure.code, 'TRANSPORT', 'failure code')
    const body = JSON.parse(mock.matching('/chat/completions').at(-1).rawBody)
    ensureEqual(body.stream, true, 'the DSH path always asks for a stream; stream:false is never sent')
  })

  // ---- platform header separation ------------------------------------------
  await checks.run('platform endpoints use token:, never Authorization', async () => {
    for (const path of ['/models', '/points/records', '/user/identity']) {
      const calls = mock.matching(path)
      ensure(calls.length >= 1, `no ${path} request was made`)
      for (const call of calls) {
        ensureEqual(call.headers['token'], FAKE_SESSION, `${path} token header`)
        ensure(call.headers['authorization'] === undefined, `${path} must not send Authorization`)
      }
    }
  })
  await checks.run('platform requests are real HTTP GETs with the JSON accept header', async () => {
    for (const call of mock.matching('/models')) {
      ensureEqual(call.method, 'GET', '/models method')
      ensureMatch(call.headers['accept'], /application\/json/u, '/models accept')
    }
  })

  // ---- state cache and logs -------------------------------------------------
  await checks.run('state cache is 0600 and carries no session/PII', async () => {
    const info = await stat(fixture.statePath)
    ensureEqual(info.mode & 0o777, 0o600, 'state file mode')
    const directory = await stat(join(dirname(fixture.statePath)))
    ensureEqual(directory.mode & 0o777, 0o700, 'state directory mode')
    const text = await readFile(fixture.statePath, 'utf8')
    ensure(!text.includes(FAKE_SESSION), 'state file contains the session')
    ensure(!text.includes(FAKE_PHONE), 'state file contains the raw phone')
    ensure(!text.includes(FAKE_USER_ID), 'state file contains the raw user id')
    const parsed = JSON.parse(text)
    ensure(parsed.selection === null, 'no selection has been saved yet')
    ensureEqual(parsed.catalog.map((model) => model.id), MOCK_CHAT_IDS, 'cached catalog ids')
  })
  await checks.run('state writes leave no temp file behind', async () => {
    const entries = await readdir(dirname(fixture.statePath))
    ensureEqual(
      entries.filter((entry) => entry.endsWith('.tmp')),
      [],
      'temp files from the atomic write are still present',
    )
  })
  await checks.run('plugin log lines contain no session', async () => {
    for (const line of fixture.logs) ensure(!line.includes(FAKE_SESSION), `log line leaks the session: ${line}`)
  })
} finally {
  if (fixture !== undefined) await fixture.close()
  await mock.close()
}

process.exitCode = checks.finish()

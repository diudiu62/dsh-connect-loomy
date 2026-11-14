#!/usr/bin/env node
/**
 * F3 regression check on the current bytes: only an **empty, zero-token**
 * `TRANSPORT` terminal triggers one forced identity precheck, and only a
 * **definite** verdict upgrades it to an executable `MISSING_CREDENTIAL`.
 *
 * The mock's `/chat/completions` always answers HTTP 200 (like the real
 * gateway), so a `100002` envelope reaches pi-ai as a zero-output
 * "Stream ended without finish_reason" `TRANSPORT` — exactly the ambiguous
 * shape the repair targets. Scenarios, all through the shipped
 * `createProviderRuntime` + a real precheck against the mock:
 *
 * | scenario | chat script | identity | expectation |
 * | --- | --- | --- | --- |
 * | empty truncation, session dead | `truncationEmpty` | `100002` | THROWS `MISSING_CREDENTIAL`, exactly 1 forced probe |
 * | empty truncation, zero-usage frame, session dead | `truncationEmptyUsageZero` | `100002` | THROWS `MISSING_CREDENTIAL` |
 * | empty truncation, session alive | `truncationEmpty` | `000000` | stays `TRANSPORT` (retryable) |
 * | truncation **with content** | `truncation` | `100002` | stays `TRANSPORT`, **no** probe |
 * | empty truncation with non-zero usage | `truncationEmptyUsageNonzero` | `100002` | stays `TRANSPORT`, no probe |
 * | legal reasoning-only `length` | `lengthOnly` | `100002` | `max-tokens`, no probe |
 * | normal stream | `stream` | `000000` | `stop`, no probe |
 *
 * Run: `node scripts/verify/verify-transport-precheck.mjs`
 *
 * @module dsh-connect-loomy/verify/transport-precheck
 */

import { CheckLog, ensure, ensureEqual, ensureMatch } from './checks.mjs'
import { FAKE_SESSION, platformFailure, startMockUpstream } from './mock-upstream.mjs'

const checks = new CheckLog('transport-precheck (F3)')
const mock = await startMockUpstream()

const shipped = await import('../../lib/index.js')

/**
 * A real `createSessionPrecheck`, built the same way `src/index.ts` builds it
 * (the factory is internal to the shipped bundle, so we reconstruct it from the
 * same `requestPlatform` primitive the plugin uses — i.e. the real HTTP client,
 * not a stub).
 */
function makePrecheck() {
  const requestPlatform = (session) =>
    fetch(`${mock.baseURL}/user/identity`, {
      headers: { accept: 'application/json', token: session },
    }).then(async (response) => {
      const body = await response.json()
      if (body.code === '000000') return { kind: 'ok' }
      return { kind: 'failure', code: body.code, message: body.desc }
    })
  let cached
  return async (session, options = {}) => {
    if (!options.force && cached !== undefined) return cached
    const answer = await requestPlatform(session)
    if (answer.kind === 'ok') {
      cached = { ok: true, definite: false, checkedAt: Date.now() }
      return cached
    }
    const definite = answer.code === '100002' || answer.code === '401' || answer.code === '403' || answer.code === 'AUTH'
    if (definite) {
      cached = {
        ok: false,
        definite: true,
        code: answer.code,
        message: `本机 Loomy 登录态已失效（上游 ${answer.code}：${answer.message}）。请在 Loomy 客户端重新登录，然后点设置卡片的「重新检测」；无需重启 DSH。`,
        checkedAt: Date.now(),
      }
      return cached
    }
    return { ok: false, definite: false, code: answer.code, message: answer.message, checkedAt: Date.now() }
  }
}

/** A provider runtime wired to the mock with a real precheck. */
function runtime() {
  return shipped.createProviderRuntime({
    catalog: {
      enabledModels: () => [
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
      ],
      kickStaleRefresh() {},
    },
    baseURL: () => mock.baseURL,
    loomyVersion: () => '0.9.39',
    readSession: async () => ({ found: true, sourcePath: '/tmp/verify-f3.json', session: FAKE_SESSION }),
    precheck: (session, options) => makePrecheck()(session, options),
  })
}

/** Drive one stream; returns { chunks, threw } where threw is the caught error. */
async function runStream(adapter) {
  const chunks = []
  let threw
  try {
    for await (const chunk of adapter.stream({
      provider: 'loomy',
      model: 'qwen3.8-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
  } catch (error) {
    threw = error
  }
  return { chunks, threw }
}

/** Count identity/chat requests strictly after a marker. */
function countsSince(marker) {
  return {
    identity: mock.matching('/user/identity').length - marker.identity,
    chat: mock.matching('/chat/completions').length - marker.chat,
  }
}

function marker() {
  return {
    identity: mock.matching('/user/identity').length,
    chat: mock.matching('/chat/completions').length,
  }
}

try {
  // (a) empty truncation + session dies between precheck and stream end ------
  mock.setChatMode('truncationEmpty')
  mock.setIdentityScript(['ok', 'fail'])
  const rtA = runtime()
  const markerA = marker()
  const a = await runStream(rtA.adapter)
  const countsA = countsSince(markerA)
  await checks.run('empty zero-token TRANSPORT with a dead session throws MISSING_CREDENTIAL (1 forced probe)', async () => {
    ensure(a.threw !== undefined, 'the stream must throw an executable error')
    ensureEqual(a.threw.code, 'MISSING_CREDENTIAL', 'error code')
    ensureMatch(a.threw.message, /100002/u, 'the executable message carries the upstream code')
    ensureMatch(a.threw.message, /重新登录/u, 'the message is actionable')
    ensureEqual(countsA.identity, 2, 'one pre-dispatch precheck + one forced probe')
    ensureEqual(countsA.chat, 1, 'exactly one chat dispatch')
    const finish = a.chunks.find((chunk) => chunk.type === 'finish')
    ensure(finish === undefined || finish.reason.kind !== 'stop', 'the failure must not look like a success')
  })

  // (b) empty truncation with an explicit zero-usage frame -------------------
  mock.setChatMode('truncationEmptyUsageZero')
  mock.setIdentityScript(['ok', 'fail'])
  const rtB = runtime()
  const markerB = marker()
  const b = await runStream(rtB.adapter)
  const countsB = countsSince(markerB)
  await checks.run('empty truncation with a zero-usage frame also upgrades', async () => {
    ensure(b.threw !== undefined && b.threw.code === 'MISSING_CREDENTIAL', 'must upgrade to MISSING_CREDENTIAL')
    ensureEqual(countsB.identity, 2, 'one forced probe')
    ensureEqual(countsB.chat, 1, 'one chat dispatch')
  })

  // (c) empty truncation but the session stays alive → stay TRANSPORT ---------
  mock.setChatMode('truncationEmpty')
  mock.setIdentityScript(['ok'])
  const rtC = runtime()
  const markerC = marker()
  const c = await runStream(rtC.adapter)
  const countsC = countsSince(markerC)
  await checks.run('empty TRANSPORT with an alive session stays retryable TRANSPORT', async () => {
    const finish = c.chunks.find((chunk) => chunk.type === 'finish')
    ensure(finish !== undefined, 'no finish chunk')
    ensureEqual(finish.reason.kind, 'error', 'finish kind')
    ensureEqual(finish.reason.failure.code, 'TRANSPORT', 'failure code')
    ensure(c.threw === undefined, 'the stream must not throw')
    ensureEqual(countsC.identity, 2, 'pre-dispatch precheck + the forced disambiguation probe (definite=false)')
    ensureEqual(countsC.chat, 1, 'one chat dispatch')
  })

  // (d) truncation WITH content → no forced probe ----------------------------
  mock.setChatMode('truncation')
  mock.setIdentityScript(['ok'])
  const rtD = runtime()
  const markerD = marker()
  const d = await runStream(rtD.adapter)
  const countsD = countsSince(markerD)
  await checks.run('a truncation with content keeps TRANSPORT and costs no forced probe', async () => {
    const finish = d.chunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason.failure.code, 'TRANSPORT', 'failure code')
    ensure(d.threw === undefined, 'must not throw')
    ensureEqual(countsD.identity, 1, 'only the pre-dispatch precheck; no end-of-stream probe')
    ensureEqual(countsD.chat, 1, 'one chat dispatch')
  })

  // (e) empty truncation with non-zero output tokens → no forced probe -------
  mock.setChatMode('truncationEmptyUsageNonzero')
  mock.setIdentityScript(['ok'])
  const rtE = runtime()
  const markerE = marker()
  const e = await runStream(rtE.adapter)
  const countsE = countsSince(markerE)
  await checks.run('an empty-looking truncation with non-zero usage costs no forced probe', async () => {
    const finish = e.chunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason.failure.code, 'TRANSPORT', 'failure code')
    ensureEqual(countsE.identity, 1, 'no forced probe when outputTokens > 0')
  })

  // (f) legal reasoning-only length truncation → max-tokens, no forced probe --
  mock.setChatMode('lengthOnly')
  mock.setIdentityScript(['ok'])
  const rtF = runtime()
  const markerF = marker()
  const f = await runStream(rtF.adapter)
  const countsF = countsSince(markerF)
  await checks.run('reasoning-only length truncation stays max-tokens with no forced probe', async () => {
    const finish = f.chunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason, { kind: 'max-tokens' }, 'finish reason')
    ensureEqual(countsF.identity, 1, 'only the pre-dispatch precheck')
  })

  // (g) normal stream → stop, no forced probe --------------------------------
  mock.setChatMode('stream')
  mock.setIdentityScript(['ok'])
  const rtG = runtime()
  const markerG = marker()
  const g = await runStream(rtG.adapter)
  const countsG = countsSince(markerG)
  await checks.run('a normal stream finishes with stop and no forced probe', async () => {
    const finish = g.chunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason, { kind: 'stop' }, 'finish reason')
    ensureEqual(countsG.identity, 1, 'only the pre-dispatch precheck')
  })

  // (h) the production prepareCall().stream() path is guarded too ------------
  mock.setChatMode('truncationEmpty')
  mock.setIdentityScript(['ok', 'fail'])
  const rtH = runtime()
  const call = await rtH.adapter.prepareCall('loomy', 'qwen3.8-flash')
  const markerH = marker()
  const h = await runStream({ stream: (options) => call.stream(options) })
  const countsH = countsSince(markerH)
  await checks.run('the prepareCall().stream() production path also upgrades', async () => {
    ensure(h.threw !== undefined && h.threw.code === 'MISSING_CREDENTIAL', 'the frozen call path must upgrade too')
    ensureEqual(countsH.identity, 2, 'one pre-dispatch precheck + one forced probe')
    ensureEqual(countsH.chat, 1, 'one chat dispatch')
  })

  // (i) an indefinite probe never replaces the original retryable failure ----
  mock.setChatMode('truncationEmpty')
  mock.setIdentityScript(['ok', 'indefinite'])
  const rtI = runtime()
  const markerI = marker()
  const i = await runStream(rtI.adapter)
  const countsI = countsSince(markerI)
  await checks.run('an indefinite forced probe keeps the original TRANSPORT failure', async () => {
    ensure(i.threw === undefined, 'an indefinite probe must not turn into a thrown auth error')
    const finish = i.chunks.find((chunk) => chunk.type === 'finish')
    ensureEqual(finish.reason.failure.code, 'TRANSPORT', 'failure stays retryable TRANSPORT')
    ensureEqual(countsI.identity, 2, 'the forced probe ran once')
    ensureEqual(countsI.chat, 1, 'one chat dispatch')
  })
} finally {
  await mock.close()
}

process.exitCode = checks.finish()

#!/usr/bin/env node
/**
 * Contract-v2 runtime consistency, checked over real HTTP against a real mock
 * gateway and the shipped plugin entry.
 *
 * The browser half already relies on three host guarantees. Any one of them
 * silently breaking makes the settings card lie:
 *
 * 1. `GET /status` **always** carries `enabledModelIds`, an array (empty when
 *    the user saved an empty selection or is signed out);
 * 2. `POST /refresh` returns the catalog merged with the **saved** selection,
 *    never with whatever draft the browser happened to hold;
 * 3. `POST /save` persists the selection, hot-updates the live model list read
 *    by the provider on the next request, and emits `llm/models-updated`.
 *
 * Guards are re-checked here as well (a rejected mutation must not persist).
 *
 * Run: `node scripts/verify/verify-contract-v2.mjs`
 *
 * @module dsh-connect-loomy/verify/contract-v2
 */

import { readFile } from 'node:fs/promises'
import { CheckLog, ensure, ensureEqual, ensureMatch } from './checks.mjs'
import { FAKE_SESSION, MOCK_CHAT_IDS, startMockUpstream } from './mock-upstream.mjs'
import { mountPlugin } from './mount-fixture.mjs'

const checks = new CheckLog('contract-v2')
const mock = await startMockUpstream()
const fixture = await mountPlugin({ baseURL: mock.baseURL })
const STATUS = '/plugins/dsh-connect-loomy/status'
const SAVE = '/plugins/dsh-connect-loomy/save'
const REFRESH = '/plugins/dsh-connect-loomy/refresh'

/** Read one route's JSON body. */
async function getJson(path) {
  const response = await fixture.request(path)
  return { response, body: JSON.parse(response.text) }
}

/** POST JSON to one mutating route with the fixture's CSRF token. */
async function postJson(path, body, csrfToken, extraHeaders = {}) {
  const response = await fixture.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loomy-csrf': csrfToken, ...extraHeaders },
    body,
  })
  return { response, body: JSON.parse(response.text) }
}

try {
  let csrfToken
  await checks.run('GET /status always includes enabledModelIds (first run: every chat model)', async () => {
    const { response, body } = await getJson(STATUS)
    ensureEqual(response.status, 200, 'status code')
    ensure(Array.isArray(body.enabledModelIds), 'enabledModelIds must be an array')
    ensureEqual(body.enabledModelIds, MOCK_CHAT_IDS, 'first-run selection defaults to the whole catalog')
    ensureMatch(body.csrfToken, /^[A-Za-z0-9_-]{16,}$/u, 'csrfToken')
    csrfToken = body.csrfToken
  })

  await checks.run('POST /save persists the selection and hot-updates the live model list', async () => {
    const { response, body } = await postJson(SAVE, { enabledModelIds: ['qwen3.8-flash'] }, csrfToken)
    ensureEqual(response.status, 200, 'status code')
    ensureEqual(body, { ok: true, enabled: ['qwen3.8-flash'] }, 'save body')
    const models = await fixture.listModels()
    ensureEqual(models.map((model) => model.id), ['qwen3.8-flash'], 'live model list after save')
    const saved = JSON.parse(await readFile(fixture.statePath, 'utf8'))
    ensureEqual(saved.selection, ['qwen3.8-flash'], 'persisted selection')
    const updated = fixture.emitted.filter((entry) => entry.event === 'llm/models-updated')
    ensure(updated.length >= 1, 'llm/models-updated was not emitted')
    ensureEqual(updated.at(-1).payload, 'loomy', 'models-updated provider id')
  })

  await checks.run('GET /status reflects the saved selection immediately', async () => {
    const { body } = await getJson(STATUS)
    ensureEqual(body.enabledModelIds, ['qwen3.8-flash'], 'enabledModelIds after save')
    ensureEqual(body.catalog.enabled, 1, 'catalog.enabled')
    ensureEqual(body.catalog.total, MOCK_CHAT_IDS.length, 'catalog.total')
  })

  await checks.run('POST /refresh returns saved selection, not a draft', async () => {
    // A stale browser would post its draft ids here; refresh must ignore them.
    const { response, body } = await postJson(
      REFRESH,
      { enabledModelIds: ['spark-x2.6', 'DeepSeek-V4.1-Flash'] },
      csrfToken,
    )
    ensureEqual(response.status, 200, 'status code')
    ensureEqual(body.ok, true, 'ok')
    ensure(Array.isArray(body.catalog), 'catalog must be an array')
    ensureEqual(body.catalog.length, MOCK_CHAT_IDS.length, 'catalog length')
    ensureEqual(
      body.catalog.filter((model) => model.enabled).map((model) => model.id),
      ['qwen3.8-flash'],
      'refresh.enabled must be the saved selection, not the posted draft',
    )
    ensure(typeof body.refreshedAt === 'number', 'refreshedAt')
    const qwen = body.catalog.find((model) => model.id === 'qwen3.8-flash')
    ensureEqual(qwen.multiplier, 0.8, 'multiplier parsed from the upstream name')
  })

  await checks.run('POST /save with an empty array keeps the field and empties the model list', async () => {
    const { response, body } = await postJson(SAVE, { enabledModelIds: [] }, csrfToken)
    ensureEqual(response.status, 200, 'status code')
    ensureEqual(body, { ok: true, enabled: [] }, 'save body')
    ensureEqual((await fixture.listModels()).map((model) => model.id), [], 'live model list after emptying')
    const status = await getJson(STATUS)
    ensure(Array.isArray(status.body.enabledModelIds), 'enabledModelIds must still be an array')
    ensureEqual(status.body.enabledModelIds, [], 'enabledModelIds must be an empty array')
  })

  await checks.run('POST /save drops ids the catalog no longer lists', async () => {
    const { body } = await postJson(
      SAVE,
      { enabledModelIds: ['qwen3.8-flash', 'removed-model-id', 'auto'] },
      csrfToken,
    )
    ensureEqual(body.enabled, ['qwen3.8-flash'], 'unknown ids and auto must be dropped')
    ensureEqual(
      (await fixture.listModels()).map((model) => model.id),
      ['qwen3.8-flash'],
      'live model list after a stale save',
    )
  })

  await checks.run('rejected mutations do not persist', async () => {
    const before = JSON.parse(await readFile(fixture.statePath, 'utf8')).selection
    const noCsrf = await fixture.request(SAVE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { enabledModelIds: ['spark-x2.6'] },
    })
    ensureEqual(noCsrf.status, 403, 'missing CSRF must be rejected')
    ensureEqual(JSON.parse(noCsrf.text).error.code, 'csrf_invalid', 'error code')
    const wrongType = await fixture.request(REFRESH, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-loomy-csrf': csrfToken },
      body: '{}',
    })
    ensureEqual(wrongType.status, 415, 'non-JSON POST must be rejected')
    const after = JSON.parse(await readFile(fixture.statePath, 'utf8')).selection
    ensureEqual(after, before, 'selection must not change on a rejected mutation')
    ensureEqual((await fixture.listModels()).map((model) => model.id), before, 'live list must not change')
  })

} finally {
  await fixture.close()
}

// Signed-out status is verified on a *fresh* mount whose env override points at
// a missing file. Deleting the sign-in file mid-flight raced with the auth
// store's single-flight read (a read started before the unlink could still win),
// so the fresh mount is both deterministic and closer to the real "no sign-in"
// state.
const signedOut = await mountPlugin({
  baseURL: mock.baseURL,
  configOverrides: { catalogTtlMs: 0 },
  skipAuthFile: true,
})
try {
  await checks.run('GET /status stays 200 with a present enabledModelIds array while signed out', async () => {
    const response = await signedOut.request(STATUS)
    const body = JSON.parse(response.text)
    ensureEqual(response.status, 200, 'signed-out status code')
    ensureEqual(body.ok, true, 'ok')
    ensureEqual(body.account, null, 'account must be null')
    ensureEqual(body.credential.found, false, 'credential.found')
    ensure(Array.isArray(body.enabledModelIds), 'enabledModelIds must be present while signed out')
    ensure(Array.isArray(body.nextSteps) && body.nextSteps.length >= 2, 'signed-out next steps')
    ensure(!response.text.includes(FAKE_SESSION), 'the session must never reach the browser payload')
  })
} finally {
  await signedOut.close()
  await mock.close()
}

process.exitCode = checks.finish()

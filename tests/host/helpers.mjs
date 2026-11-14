/**
 * Shared fixtures for the host-side unit tests.
 *
 * Everything here is offline: fixture strings mirror the *shapes* recorded in
 * `docs/loomy-upstream.md` / `.refs/` with fake values, and every helper only
 * touches a fresh temp directory. The suite never reads the real
 * `auth-session.json` and never contacts the Loomy gateway, so it stays
 * deterministic on any machine (including CI without a Loomy install).
 *
 * The host code is imported from `lib/` — the same artifact `pnpm build`
 * ships and the loader mounts — so these tests cannot pass against a stale
 * source tree.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One usable fake session: long hex, no whitespace (shape the host accepts). */
export const SESSION = 'a1b2c3d4e5f6'.repeat(4)

/** Raw phone in the desktop sign-in file; must never reach a public view. */
export const RAW_PHONE = '13812345678'

/** Raw local user id in the desktop sign-in file; masked before display. */
export const RAW_USER_ID = '123456789012345678'

/** Epoch ms the fake credential was last written. */
export const LOGIN_AT = 1_794_574_693_000

/** A canonical desktop `auth-session.json` document (fake values). */
export function authDocument(overrides = {}) {
  return JSON.stringify({
    session: SESSION,
    userid: RAW_USER_ID,
    phone: RAW_PHONE,
    updatedAt: LOGIN_AT,
    ...overrides,
  })
}

/**
 * The recorded `/models` shape: five real chat models, three image models (one
 * of them without `capabilities`), the `auto` alias and one non-chat protocol.
 * Chat models must survive normalisation in upstream order; everything else
 * must be filtered out.
 */
export const RAW_MODELS = [
  {
    id: 'spark-x2.6',
    name: 'Spark-X2.6 正式版(限时免费)(x0.0)',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 131_072,
    reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'low',
    capabilities: {
      reasoning: true,
      vision: false,
      function_calling: true,
      streaming: true,
      system_message: true,
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
  },
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek V4.1 Flash(x2.0)',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 384_000,
    reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'high',
    capabilities: {
      reasoning: true,
      vision: true,
      function_calling: true,
      streaming: true,
      system_message: true,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
  },
  {
    id: 'qwen3.8-flash',
    name: 'qwen 3.8 flash（x0.8）',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_000_000,
    max_output_tokens: 131_072,
    // `extreme` is not a level the gateway offers: it must be dropped, and an
    // invalid default must fall back to the first surviving effort.
    reasoning_efforts: ['none', 'low', 'high', 'extreme'],
    default_reasoning_effort: 'low',
    capabilities: {
      reasoning: true,
      vision: true,
      function_calling: true,
      streaming: true,
      system_message: true,
      input_modalities: ['text', 'image', 'video'],
      output_modalities: ['text'],
    },
  },
  {
    // A chat model without `capabilities`/lengths: accepted, with host
    // fallbacks. (The upstream currently always sends capabilities for chat,
    // but a shape change must not silently drop every model.)
    id: 'mystery-chat',
    name: 'Mystery Chat',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
  },
  {
    id: 'Hy-Image-3.5-preview',
    name: 'Hy image 3.5 preview',
    object: 'model',
    type: 'image',
    protocol: 'openai_chat',
    context_length: 100_000,
    capabilities: {
      reasoning: false,
      vision: true,
      function_calling: false,
      streaming: false,
      system_message: true,
      input_modalities: ['text', 'image'],
      output_modalities: ['image'],
    },
  },
  {
    // Image model with no `capabilities` at all (the shape the pre-evidence
    // recon recorded): must be filtered by `type` alone, never registered.
    id: 'legacy-image-no-capabilities',
    name: 'Legacy image',
    object: 'model',
    type: 'image',
    protocol: 'openai_chat',
    context_length: 64_000,
  },
  {
    id: 'auto',
    name: '自动 · 均衡',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
  },
  {
    id: 'legacy-chat',
    name: 'Legacy chat',
    object: 'model',
    type: 'chat',
    protocol: 'legacy_chat',
  },
]

/** The `/models` body the tests feed the normaliser. */
export function modelsBody(models = RAW_MODELS) {
  return {
    reasoning_enabled: true,
    reasoning_catalog_version: 'sha256:test',
    object: 'list',
    data: models,
  }
}

/** The chat ids {@link RAW_MODELS} is expected to normalise to. */
export const CHAT_IDS = ['spark-x2.6', 'DeepSeek-V4.1-Flash', 'qwen3.8-flash', 'mystery-chat']

/** A v1 `/points/records` envelope with all three buckets and two ledger rows. */
export function pointsBody(overrides = {}) {
  return {
    code: '000000',
    desc: '成功',
    data: {
      balance: 35_500,
      dailyBalance: 5_000,
      availableBalance: 40_500,
      pageNo: 1,
      pageSize: 20,
      total: 2,
      list: [
        {
          ledgerId: 'pl_test_1',
          modelName: '',
          direction: 'credit',
          description: '邀请好友奖励',
          createdAt: 1_794_574_693,
          pointsActual: 5_000,
          consumeSource: '',
          balanceBefore: 35_500,
          balanceAfter: 40_500,
          dailyCycleDate: '2026-11-13',
        },
        {
          ledgerId: 'pl_test_2',
          modelName: 'DeepSeek-V4.1-Flash',
          direction: 'debit',
          description: 'DeepSeek V4.1 Flash(x2.0) 对话',
          createdAt: 1_794_574_700,
          pointsActual: 120,
          consumeSource: 'daily',
          balanceBefore: 5_000,
          balanceAfter: 4_880,
          dailyCycleDate: '2026-11-13',
        },
      ],
      ...overrides,
    },
  }
}

/** An identity success envelope. */
export function identityBody() {
  return {
    code: '000000',
    desc: '成功',
    data: { isInternal: false, currentTeamId: '', teams: [] },
  }
}

/**
 * A fake platform failure: HTTP 200 + business code, exactly how the real
 * gateway reports an expired sign-in. `desc` must be surfaced verbatim.
 */
export function platformFailure(code = '100002', desc = '登录已失效') {
  return { code, desc }
}

/** Create a temp dir that is removed when the test finishes. */
export function tempDir(t, prefix = 'loomy-host-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Write an `auth-session.json` fixture into `dir`, returning its path. */
export function writeAuthFile(dir, content = authDocument(), filename = 'auth-session.json') {
  const path = join(dir, filename)
  writeFileSync(path, content, { mode: 0o600 })
  return path
}

/** One credential candidate for `readAuthSession`/`createAuthStore`. */
export function candidate(path) {
  return { path, origin: 'default' }
}

/** A fetch double that records calls and returns one queued response. */
export function fetchSequence(responses) {
  const calls = []
  let index = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = typeof responses === 'function' ? responses(url, init, index) : responses[index]
    index += 1
    if (next === undefined) throw new Error(`unexpected fetch call #${index}: ${String(url)}`)
    return next
  }
  return { fetchImpl, calls }
}

/** A JSON response with no cache headers, like the upstream platform. */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Parse a route's JSON body. */
export async function jsonBody(response) {
  return JSON.parse(await response.text())
}

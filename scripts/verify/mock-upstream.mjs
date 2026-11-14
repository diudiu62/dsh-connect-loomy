/**
 * A local, OpenAI-compatible + Loomy-platform mock upstream for independent
 * verification.
 *
 * It is deliberately a real HTTP server on 127.0.0.1 rather than a fetch
 * double: the point of the end-to-end scripts is to prove what the provider
 * actually puts on the wire (headers, body, SSE framing) through the real
 * pi-ai transport, not to re-assert the unit-test stubs.
 *
 * Two surfaces:
 * - Loomy **platform** endpoints (`/models`, `/points/records`,
 *   `/user/identity`) authenticate with a bare `token:` header and answer
 *   HTTP 200 + business envelope (failures included).
 * - The **conversation** endpoint (`/chat/completions`) authenticates with
 *   `Authorization: Bearer` and answers SSE; a JSON 200 + `100002` envelope is
 *   what the real gateway does for a dead session.
 *
 * Every request is recorded verbatim (method, URL, headers, body) so a script
 * can assert header separation after the fact.
 *
 * @module dsh-connect-loomy/verify/mock-upstream
 */

import { createServer } from 'node:http'

/** The fake desktop session used by every verification fixture (never real). */
export const FAKE_SESSION = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'

/** Fake account facts written into the temp `auth-session.json`. */
export const FAKE_PHONE = '13800001234'

/** Fake local user id written into the temp `auth-session.json`. */
export const FAKE_USER_ID = '123456789012345678'

/** The `/models` body: chat models plus the entries the plugin must filter out. */
export const MOCK_MODELS = [
  {
    id: 'spark-x2.6',
    name: 'Spark-X2.6 正式版(限时免费)(x0.0)',
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
    id: 'qwen3.8-flash',
    name: 'qwen 3.8 flash（x0.8）',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_000_000,
    max_output_tokens: 131_072,
    reasoning_efforts: ['none', 'low', 'high'],
    default_reasoning_effort: 'low',
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
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek V4.1 Flash(x2.0)',
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
  // `auto` bills a point and silently routes to GLM: must never be registered.
  { id: 'auto', name: '自动 · 均衡', type: 'chat', protocol: 'openai_chat' },
  // Image model: must never be registered as a chat model.
  {
    id: 'Hy-Image-3.5-preview',
    name: 'Hy image 3.5 preview',
    type: 'image',
    protocol: 'openai_chat',
    capabilities: { output_modalities: ['image'], input_modalities: ['text', 'image'] },
  },
  // Non-OpenAI protocol chat model: not addressable through this API.
  { id: 'legacy-chat', name: 'Legacy chat', type: 'chat', protocol: 'legacy_chat' },
]

/** The ids the catalog is expected to keep, in upstream order. */
export const MOCK_CHAT_IDS = ['spark-x2.6', 'qwen3.8-flash', 'DeepSeek-V4.1-Flash']

/** The `/points/records` v1 body with all three buckets. */
export const MOCK_POINTS = {
  code: '000000',
  desc: '成功',
  data: {
    balance: 1_250,
    dailyBalance: 300,
    availableBalance: 1_550,
    pageNo: 1,
    pageSize: 20,
    total: 2,
    list: [
      {
        ledgerId: 'pl_verify_1',
        modelName: 'qwen3.8-flash',
        direction: 'debit',
        description: 'qwen 3.8 flash（x0.8） 对话',
        createdAt: 1_794_574_693,
        pointsActual: 16,
        consumeSource: 'daily',
        balanceBefore: 316,
        balanceAfter: 300,
        dailyCycleDate: '2026-11-14',
      },
      {
        ledgerId: 'pl_verify_2',
        modelName: '',
        direction: 'credit',
        description: '每日额度刷新',
        createdAt: 1_794_570_000,
        pointsActual: 300,
        consumeSource: '',
        balanceBefore: 1_250,
        balanceAfter: 1_550,
        dailyCycleDate: '2026-11-14',
      },
    ],
  },
}

/** The `/user/identity` success body. */
export const MOCK_IDENTITY = {
  code: '000000',
  desc: '成功',
  data: { isInternal: false, currentTeamId: '', teams: [] },
}

/** Business-code failure envelope the gateway returns with HTTP 200. */
export function platformFailure(code = '100002', desc = '缺少 token') {
  return { code, desc }
}

/** Scripted SSE frames for the conversation endpoint. */
const frame = (choices, extra = {}) => ({
  id: 'chatcmpl-verify',
  object: 'chat.completion.chunk',
  created: 1_794_574_693,
  model: 'mock',
  choices,
  ...extra,
})

/** Chat response scripts; each script lists the frames or a JSON body. */
const CHAT_SCRIPTS = {
  /** Incremental streaming: reasoning, text, finish, independent usage frame. */
  stream: [
    frame([{ index: 0, delta: { role: 'assistant', reasoning_content: '先想一下。' }, finish_reason: null }]),
    frame([{ index: 0, delta: { content: '你好，' }, finish_reason: null }]),
    frame([{ index: 0, delta: { content: '我是 Loomy mock。' }, finish_reason: null }]),
    frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    // The real gateway sends usage in its own frame with an empty choices array.
    frame([], { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }),
  ],
  /** "Non-streaming" upstream shape on the streaming wire: one complete frame. */
  single: [
    frame([{ index: 0, delta: { role: 'assistant', content: '一次完整应答。' }, finish_reason: 'stop' }]),
    frame([], { usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }),
  ],
  /** Silent truncation: deltas then [DONE] without any finish_reason. */
  truncation: [
    frame([{ index: 0, delta: { role: 'assistant', content: '这段回答没有收尾' }, finish_reason: null }]),
  ],
  /** Silent truncation with no output at all (the ambiguous auth-death shape). */
  truncationEmpty: [],
  /** Empty truncation with an explicit zero-token usage frame. */
  truncationEmptyUsageZero: [
    frame([], { usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } }),
  ],
  /** Empty truncation that still reports non-zero output tokens. */
  truncationEmptyUsageNonzero: [
    frame([], { usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }),
  ],
  /** reasoning-only length truncation (legal, must be `max-tokens`). */
  lengthOnly: [
    frame([{ index: 0, delta: { role: 'assistant', reasoning_content: '正在推理，长度用尽。' }, finish_reason: null }]),
    frame([{ index: 0, delta: {}, finish_reason: 'length' }]),
  ],
  /** A true non-streaming JSON completion (not reachable from the DSH path). */
  json: null,
}

/**
 * Start the mock upstream.
 *
 * @param {object} [options]
 * @param {keyof typeof CHAT_SCRIPTS} [options.chatMode] initial chat script
 * @param {{code:string,desc:string}|null} [options.modelsFailure] force a `/models` platform failure
 * @param {number} [options.modelsDelayMs] delay every `/models` answer (cold-start probes)
 * @returns {Promise<{baseURL:string, requests:Array, setChatMode:Function, setModelsFailure:Function, setIdentityFailure:Function, close:Function}>}
 */
export async function startMockUpstream(options = {}) {
  const requests = []
  let chatMode = options.chatMode ?? 'stream'
  let modelsFailure = options.modelsFailure ?? null
  let identityFailure = null
  let identityScript = null
  let identityScriptIndex = 0
  const modelsDelayMs = options.modelsDelayMs ?? 0

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const record = {
        method: req.method ?? '',
        path: url.pathname,
        search: url.search,
        headers: { ...req.headers },
        rawBody,
        at: Date.now(),
      }
      requests.push(record)
      route(record, res)
    })
  })

  function route(record, res) {
    const path = record.path.replace(/^\/api\/v1/u, '')
    const token = record.headers['token']
    const authorization = record.headers['authorization']

    if (path === '/chat/completions') {
      if (authorization !== `Bearer ${FAKE_SESSION}`) {
        // The real gateway reports a dead session as HTTP 200 + envelope, also
        // on the conversation endpoint.
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(platformFailure('100002', '登录已失效，请重新登录')))
        return
      }
      let body = {}
      try {
        body = JSON.parse(record.rawBody)
      } catch {
        // An unparseable body still gets a scripted answer; the script asserts
        // the body separately.
      }
      const model = typeof body.model === 'string' ? body.model : 'mock'
      const script = CHAT_SCRIPTS[chatMode]
      if (script === null) {
        const completion = {
          id: 'chatcmpl-verify',
          object: 'chat.completion',
          created: 1_794_574_693,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: '非流式 JSON 应答' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(completion))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const entry of script) {
        res.write(`data: ${JSON.stringify({ ...entry, model })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // Platform endpoints: `token:` only, never `Authorization`.
    if (token !== FAKE_SESSION) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(platformFailure('100002', '缺少 token')))
      return
    }
    if (path === '/models') {
      const answer = () => {
        if (modelsFailure !== null) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(modelsFailure))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ object: 'list', reasoning_enabled: true, data: MOCK_MODELS }))
      }
      if (modelsDelayMs > 0) setTimeout(answer, modelsDelayMs)
      else answer()
      return
    }
    if (path === '/points/records') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(MOCK_POINTS))
      return
    }
    if (path === '/user/identity') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(nextIdentityAnswer()))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  /**
   * Identity scripting: `null` → `identityFailure ?? success`; an array of
   * `'ok' | 'fail' | 'indefinite'` answers the entries in order and repeats the
   * last one ("first ok, then dead" is the F3 disambiguation shape).
   */
  function nextIdentityAnswer() {
    if (identityScript !== null) {
      const entry = identityScript[Math.min(identityScriptIndex, identityScript.length - 1)]
      identityScriptIndex += 1
      if (entry === 'ok') return MOCK_IDENTITY
      if (entry === 'indefinite') return platformFailure('100001', '参数错误')
      return platformFailure('100002', '登录已失效，请重新登录')
    }
    return identityFailure ?? MOCK_IDENTITY
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    baseURL: `http://127.0.0.1:${port}/api/v1`,
    requests,
    setChatMode(mode) {
      if (!(mode in CHAT_SCRIPTS)) throw new Error(`unknown chat mode ${mode}`)
      chatMode = mode
    },
    setModelsFailure(failure) {
      modelsFailure = failure
    },
    /** Script the next `/user/identity` answers; `null` restores success. */
    setIdentityFailure(failure) {
      identityFailure = failure
      identityScript = null
    },
    /**
     * Answer `/user/identity` with a sequence of `'ok' | 'fail' | 'indefinite'`
     * (last entry repeats). `['ok', 'fail']` is the F3 shape: alive at the
     * pre-dispatch precheck, dead at the forced end-of-stream probe.
     */
    setIdentityScript(script) {
      identityScript = script
      identityScriptIndex = 0
    },
    /** Requests whose path ends with `suffix`, newest last. */
    matching(suffix) {
      return requests.filter((request) => request.path.endsWith(suffix))
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

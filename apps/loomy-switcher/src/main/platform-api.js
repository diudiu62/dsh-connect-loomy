/**
 * Loomy 平台 API 客户端：积分、邀请码。
 *
 * 协议细节全部来自实测 + 反编译 `/Applications/Loomy.app/.../electron/points-service.js`，
 * 不靠猜：
 *
 * - 认证头是**裸 `token: <session>`**，不是 `Authorization: Bearer`——后者是
 *   对话接口的用法，混用会得到 HTTP 200 + `100002 缺少 token`；
 * - 失败也可能是 **HTTP 200 + 业务码**：`code` 才是权威，`000000` 才成功；
 * - 网关只有 `loomyad.xunfei.cn/api/v1` 有效。`points-config.json` 里那个
 *   `ossptest.voicecloud.cn/loomy/integration` 对本 session 直接回
 *   `100002 登录已失效`（实测），不要用；
 * - `balance` / `dailyBalance` / `availableBalance` 三个桶原样上报，缺一个就
 *   按失败处理，绝不伪造成 0（伪造的 0 看起来像空钱包，会误导人）。
 *
 * @module loomy-switcher/platform-api
 */

/** 平台网关，与 DSH 插件的 DEFAULT_BASE_URL 一致（实测唯一可用）。 */
export const DEFAULT_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'

/** 成功业务码（实测只有 000000，其余保留为兼容）。 */
const SUCCESS_CODES = new Set(['000000', '0', '200'])

/* ------------------------------------------------------------------ *
 * 底层请求
 * ------------------------------------------------------------------ */

/**
 * 发一次平台请求并分类结果。
 *
 * 返回 `{ kind:'ok', data }` 或 `{ kind:'failure', code, message, traceId? }`。
 * 业务码优先于 HTTP 状态：上游失败也常常是 HTTP 200。
 */
export async function requestPlatform(options) {
  const {
    path,
    session,
    method = 'GET',
    query,
    body,
    baseURL = DEFAULT_BASE_URL,
    timeoutMs = 15_000,
    fetchImpl = globalThis.fetch,
  } = options

  if (typeof session !== 'string' || session.length < 16) {
    return { kind: 'failure', code: 'no_session', message: '没有可用的 session' }
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value))
  }
  const queryString = params.toString()
  const url = `${baseURL.replace(/\/+$/u, '')}${path}${queryString.length > 0 ? `?${queryString}` : ''}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()

  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'loomy-account-switcher/1.0',
        token: session,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = /abort|timeout|timed out/iu.test(message)
    return { kind: 'failure', code: aborted ? 'timeout' : 'network', message }
  } finally {
    clearTimeout(timer)
  }

  let text
  try {
    text = await response.text()
  } catch (error) {
    return { kind: 'failure', code: 'network', message: error instanceof Error ? error.message : String(error) }
  }

  let parsed
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    return {
      kind: 'failure',
      code: String(response.status),
      message: text.trim().slice(0, 300) || `HTTP ${response.status}（非 JSON 响应）`,
    }
  }

  const code = typeof parsed?.code === 'string' ? parsed.code : undefined
  const traceId = typeof parsed?.trace_id === 'string' ? parsed.trace_id : undefined

  // 业务码优先于 HTTP 状态
  if (code !== undefined && !SUCCESS_CODES.has(code)) {
    return {
      kind: 'failure',
      code,
      message: String(parsed?.desc ?? parsed?.message ?? `上游业务码 ${code}`),
      ...(traceId === undefined ? {} : { traceId }),
    }
  }
  if (!response.ok) {
    return {
      kind: 'failure',
      code: String(response.status),
      message: String(parsed?.desc ?? parsed?.message ?? `HTTP ${response.status}`),
      ...(traceId === undefined ? {} : { traceId }),
    }
  }

  const data =
    parsed?.data !== undefined && parsed.data !== null && typeof parsed.data === 'object' ? parsed.data : parsed
  return { kind: 'ok', data, ...(traceId === undefined ? {} : { traceId }) }
}

/* ------------------------------------------------------------------ *
 * 积分
 * ------------------------------------------------------------------ */

/** 读一份积分，含最近几条流水。 */
export async function fetchCredits(options) {
  const answer = await requestPlatform({
    path: '/points/records',
    session: options.session,
    query: { pageNo: 1, pageSize: clampPageSize(options.pageSize ?? 5), recordType: 'all' },
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (answer.kind === 'failure') return answer

  const data = answer.data
  const balance = asNumber(data?.balance)
  const dailyBalance = asNumber(data?.dailyBalance)
  const availableBalance = asNumber(data?.availableBalance)
  if (balance === undefined || dailyBalance === undefined || availableBalance === undefined) {
    return {
      kind: 'failure',
      code: 'bad_response',
      message: '积分响应缺少 balance / dailyBalance / availableBalance（不伪造成 0）',
    }
  }

  const list = Array.isArray(data?.list) ? data.list : []
  const records = list
    .map((row) => {
      const points = asNumber(row?.pointsActual)
      const balanceAfter = asNumber(row?.balanceAfter)
      if (points === undefined || balanceAfter === undefined) return undefined
      return {
        description: typeof row?.description === 'string' ? row.description : '',
        direction: row?.direction === 'credit' ? 'credit' : 'debit',
        points,
        balanceAfter,
        ...(typeof row?.modelName === 'string' ? { model: row.modelName } : {}),
        createdAt: toEpochMs(row?.createdAt),
      }
    })
    .filter((row) => row !== undefined)

  return {
    kind: 'ok',
    credits: {
      balance,
      dailyBalance,
      availableBalance,
      records,
      fetchedAt: options.now?.() ?? Date.now(),
    },
  }
}

/* ------------------------------------------------------------------ *
 * 邀请码
 * ------------------------------------------------------------------ */

/**
 * 查我自己名下的邀请码 + 是否已经被别人邀请过。
 *
 * 两个接口分别打：`/invitation-codes` 拿码列表，`/points/activation` 拿
 * "我有没有兑换过别人的码"。前者失败不影响后者——它们回答的是不同问题。
 */
export async function fetchInvite(options) {
  const shared = {
    session: options.session,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }

  const [codesAnswer, activationAnswer] = await Promise.all([
    requestPlatform({ ...shared, path: '/invitation-codes' }),
    requestPlatform({ ...shared, path: '/points/activation' }),
  ])

  if (codesAnswer.kind === 'failure' && activationAnswer.kind === 'failure') {
    return codesAnswer
  }

  const codes = []
  if (codesAnswer.kind === 'ok') {
    const list = Array.isArray(codesAnswer.data?.list) ? codesAnswer.data.list : []
    for (const row of list) {
      const inviteCode = typeof row?.inviteCode === 'string' ? row.inviteCode.trim() : ''
      if (inviteCode.length === 0) continue
      const usedCount = asNumber(row?.usedCount) ?? 0
      const maxUses = asNumber(row?.maxUses) ?? 0
      codes.push({
        inviteCode,
        usedCount,
        maxUses,
        status: typeof row?.status === 'string' ? row.status.trim() : '',
        remaining: maxUses > 0 ? Math.max(0, maxUses - usedCount) : undefined,
      })
    }
  }

  const activation =
    activationAnswer.kind === 'ok'
      ? {
          activated: activationAnswer.data?.activated === true,
          appliedInvitationCode:
            typeof activationAnswer.data?.appliedInvitationCode === 'string'
              ? activationAnswer.data.appliedInvitationCode.trim()
              : '',
        }
      : undefined

  return {
    kind: 'ok',
    invite: {
      codes,
      activeCount: codes.filter((entry) => entry.status === 'active').length,
      ...(activation === undefined ? {} : { activation }),
      fetchedAt: options.now?.() ?? Date.now(),
    },
    // 单个接口失败时把原因带上，别假装全部成功
    ...(codesAnswer.kind === 'failure' ? { codesError: codesAnswer.message } : {}),
    ...(activationAnswer.kind === 'failure' ? { activationError: activationAnswer.message } : {}),
  }
}

/**
 * 绑定（兑换）别人的邀请码。
 *
 * 这是**写操作**：上游一人只能绑一次，绑错了通常不能改。所以界面必须先问，
 * 传过来才执行。
 */
export async function redeemInvite(options) {
  const inviteCode = String(options.inviteCode ?? '').trim()
  if (inviteCode.length === 0) {
    return { kind: 'failure', code: 'bad_request', message: '邀请码不能为空' }
  }
  const answer = await requestPlatform({
    path: '/points/activation',
    session: options.session,
    method: 'POST',
    body: { inviteCode },
    ...(options.deviceId === undefined ? {} : {}),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (answer.kind === 'failure') return answer
  return {
    kind: 'ok',
    activated: answer.data?.activated === true,
    appliedInvitationCode:
      typeof answer.data?.appliedInvitationCode === 'string' ? answer.data.appliedInvitationCode.trim() : inviteCode,
  }
}

/* ------------------------------------------------------------------ *
 * 批量刷新
 * ------------------------------------------------------------------ */

/**
 * 批量刷新多个账号的积分。
 *
 * 并发度压到 4：账号库动辄十几条，一次全打出去既有被上游限流的风险，也会让
 * 界面在每个格子之间反复重绘。每条独立 resolve，一条失败不影响别的——这是
 * "批量"的核心价值：谁挂了要能单独看出来。
 */
export function refreshMany(entries, options = {}) {
  const { concurrency = 4, onProgress, fetchImpl, timeoutMs, baseURL } = options
  const results = new Map()
  let cursor = 0
  let done = 0

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= entries.length) return
      const entry = entries[index]
      let result
      try {
        result = await fetchCredits({
          session: entry.session,
          ...(baseURL === undefined ? {} : { baseURL }),
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      } catch (error) {
        result = {
          kind: 'failure',
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      results.set(entry.id, result)
      done += 1
      onProgress?.({ done, total: entries.length, id: entry.id, result })
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(entries.length, 1)) }, worker)
  return Promise.all(workers).then(() => ({
    results,
    summary: {
      total: entries.length,
      ok: [...results.values()].filter((row) => row.kind === 'ok').length,
      failed: [...results.values()].filter((row) => row.kind === 'failure').length,
    },
  }))
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function clampPageSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 5
  return Math.min(100, Math.max(1, Math.trunc(n)))
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 上游时间是秒级时间戳，`1e11` 以下按秒算（与插件一致）。 */
function toEpochMs(value) {
  const n = asNumber(value)
  if (n === undefined) return 0
  const ms = n < 1e11 ? n * 1000 : n
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0
}

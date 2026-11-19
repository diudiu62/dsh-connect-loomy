/**
 * Loomy target：包装既有的 `loomy-store` + `platform-api`，对齐小浣熊的统一接口。
 *
 * 这一层不复制逻辑，只做形状适配——两个平台的差异（leveldb vs 明文 JSON、
 * 裸 token vs Bearer、14 天 vs 30 天）都收在各自的 target 里，上层（vault /
 * 路由 / 界面）只认 `inspect` / `applySession` / `fetchPoints` 这几个动词。
 *
 * @module account-switcher/targets/loomy
 */

import * as loomy from '../loomy-store.js'
import { fetchCredits, fetchInvite } from '../platform-api.js'

export const TARGET_ID = 'loomy'
export const LABEL = 'Loomy'
export const APP_NAME = 'Loomy'

/** 状态快照。Loomy 的 session 有过期时间吗？没有——上游不在 token 里带 exp，
 *  只能按签发日 + 14 天推算，由 vault 侧的 `credentialedAt` 负责。 */
export async function inspect(home) {
  const snapshot = await loomy.inspect(home)
  const current = snapshot.current
  return {
    target: TARGET_ID,
    installed: snapshot.installed,
    appInstalled: snapshot.appInstalled,
    userData: snapshot.userData,
    authPath: snapshot.logPath,
    running: snapshot.running,
    current:
      current === undefined
        ? undefined
        : {
            session: current.session,
            phone: current.phone,
            name: '',
            userid: current.userid,
            // Loomy 的 token 里没有 exp，只能按签发时刻 + 14 天推算。
            // `readMirror()` 只回 phone/userid，所以这里不塞 issuedAt——
            // vault 侧会用导入时的 credentialedAt 兜底，那个时间更准。
          },
  }
}

export async function applySession(session, options = {}) {
  const result = await loomy.applySession(
    { session: session.session, userid: session.userid, phone: session.phone },
    options,
  )
  return {
    ok: result.ok,
    steps: result.steps,
    backupPath: result.backupDir,
    session,
    verify: result.verify,
  }
}

export const quit = loomy.quit
export const launch = loomy.launch
export const isRunning = loomy.isRunning
export const signOut = loomy.signOut

/** 积分 → 统一形状（available + 一行副文案）。 */
export async function fetchPoints(options) {
  const answer = await fetchCredits({
    session: options.session,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (answer.kind === 'failure') return answer
  return {
    kind: 'ok',
    points: {
      available: answer.credits.availableBalance,
      secondary: `余额 ${answer.credits.balance} · 今日 ${answer.credits.dailyBalance}`,
      at: answer.credits.fetchedAt,
      records: answer.credits.records,
    },
  }
}

/** 邀请码（只有 Loomy 有个人邀请码接口）。 */
export async function fetchInviteInfo(options) {
  return fetchInvite({
    session: options.session,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

/** Loomy 是否支持邀请码。 */
export const SUPPORTS_INVITE = true
/**
 * The login service: the settings card's SMS flow, end to end.
 *
 * Responsibilities, strictly ordered:
 * 1. resolve the app's account credentials (runtime decryption of the app's
 *    own `.env.prod` — see `shared/xfyun.ts`);
 * 2. run the SMS flow (`sendMsgCode` → user types the code → `checkCode`);
 * 3. persist the resulting session to the plugin's own store (0600), which
 *    `authSessionCandidatesWithPlugin` places ahead of the desktop file;
 * 4. invalidate the auth cache so the very next inference uses the new
 *    session, and the status view reflects the login immediately.
 *
 * Every failure returns an executable message; nothing here throws, nothing
 * logs the phone number, the code, the msgid or the session — the card shows
 * the phone in full (local data), the log never records it at all.
 *
 * @module dsh-connect-desktop/login
 */

import {
  PHONE_PATTERN,
  resolveXfyunConfig,
  resetXfyunConfigCache,
  sendSmsCode,
  verifySmsCode,
  type ResolvedXfyunConfig,
} from './xfyun.js'
import { clearPluginAuthSession, writePluginAuthSession } from './plugin-auth.js'
import { displayPhone, displayUserId } from '../../shared/text.js'

/** Rate-limit guard for `sendMsgCode`: the account API rejects early resends. */
export const SEND_CODE_COOLDOWN_MS = 60_000

/** Login attempts may verify for a few minutes after the SMS lands. */
export const SMS_EXPIRES_MS = 300_000


/**
 * Store a freshly obtained session.
 *
 * Shared by both sign-in paths (SMS code and phone+password) so they cannot
 * diverge: with an accounts store the session becomes an account (and its own
 * route); without one it falls back to the legacy single-session file.
 */
type PersistedLogin =
  | { kind: 'ok'; login: LoginResult & { ok: true } }
  | { kind: 'failure'; login: LoginResult & { ok: false } }

async function persistLogin(
  deps: LoginDeps,
  now: () => number,
  result: { session: string; phone?: string; userId?: string },
  fallbackPhone?: string,
): Promise<PersistedLogin> {
  if (deps.accounts !== undefined) {
    /*
     * `result.phone` 只有上游在 `checkCode` 里带回来时才有值；实测它并不总是返回。
     * 而用户**亲手输入**的号码（`fallbackPhone`）一定是对的——不拿它兜底，账号
     * 记录就没有手机号，界面上只能显示「账号 1」这种没有信息量的序号。
     */
    const phone = result.phone ?? fallbackPhone
    const added = await deps.accounts.add({
      session: result.session,
      ...(phone === undefined ? {} : { phone }),
      ...(result.userId === undefined ? {} : { userId: result.userId }),
    })
    if (added.kind === 'failure') {
      return { kind: 'failure', login: { ok: false, code: added.code, message: added.message } }
    }
    await deps.refreshRoutes?.()
    deps.invalidateAuth()
    // `single` 模式（现在的默认）下没有 slot 这个概念：路由恒为 `loomy`，
    // 账号靠 id 区分。只有真的落在 `loomy-N` 上时才报告 slot。
    const slot = added.account.slot
    return {
      kind: 'ok',
      login: {
        ok: true,
        ...(result.phone === undefined ? {} : { phone: displayPhone(result.phone) }),
        ...(result.userId === undefined ? {} : { userId: displayUserId(result.userId) }),
        sourcePath: slot === undefined ? 'accounts.json' : `accounts.json#slot-${slot}`,
        fingerprint: added.account.id,
        ...(slot === undefined ? {} : { slot }),
        ...(added.account.route === undefined ? {} : { route: added.account.route }),
        replaced: added.replaced,
      },
    }
  }

  const written = await writePluginAuthSession({
    storageDir: deps.storageDir(),
    session: result.session,
    ...(result.userId === undefined ? {} : { userId: result.userId }),
    ...(result.phone === undefined ? (fallbackPhone === undefined ? {} : { phone: fallbackPhone }) : { phone: result.phone }),
    now,
  })
  if (written.kind === 'failure') {
    return { kind: 'failure', login: { ok: false, code: written.code, message: written.message } }
  }
  deps.invalidateAuth()
  return {
    kind: 'ok',
    login: {
      ok: true,
      ...(result.phone === undefined ? {} : { phone: displayPhone(result.phone) }),
      ...(result.userId === undefined ? {} : { userId: displayUserId(result.userId) }),
      sourcePath: written.path,
      fingerprint: written.fingerprint,
    },
  }
}

/** What one "send code" turn produced. */
export type SendCodeResult =
  | { ok: true; msgid: string; phone: string; resendAfterMs: number; expiresMs: number }
  | { ok: false; code: string; message: string }

/** What one "verify code" turn produced. */
export type LoginResult =
  | {
      ok: true
      phone?: string
      userId?: string
      sourcePath: string
      fingerprint: string
      /** Slot the account landed on; the route is derived from it. */
      slot?: number
      route?: string
      /** True when an existing account's session was refreshed instead of added. */
      replaced?: boolean
    }
  | { ok: false; code: string; message: string }

/** What "sign out" produced. */
export type LogoutResult =
  | { ok: true; message: string }
  | { ok: false; code: string; message: string }

export interface LoginDeps {
  /** Directory the plugin-side session file lives in. */
  storageDir: () => string
  /** Invalidate the auth snapshot cache (so the next read sees the login). */
  invalidateAuth: () => void
  /**
   * Multi-account store: a login appends (or refreshes) an account instead of
   * overwriting the single plugin session. Omission keeps the legacy
   * single-session behaviour for callers that have no store.
   */
  accounts?: {
    add(input: { session: string; phone?: string; userId?: string }): Promise<
      | { kind: 'ok'; account: { id: string; slot?: number; route?: string }; replaced: boolean }
      | { kind: 'failure'; code: string; message: string }
    >
  }
  /** Ask the host to reconcile provider routes after an account change. */
  refreshRoutes?: () => Promise<void>
  /**
   * Where the account-plane credentials come from.
   *
   * Injectable because resolving them reads the installed desktop app: a test
   * (or CI, where Loomy is not installed) must be able to supply credentials
   * without the app on disk, or every login test silently exercises the
   * "app missing" branch instead of the flow it claims to test.
   */
  resolveConfig?: () => ResolvedXfyunConfig
  now?: () => number
  fetchImpl?: typeof fetch
  logger?: { warn(message: string, error?: unknown): void }
}

/** Create the login service. One per plugin instance. */
export function createLoginService(deps: LoginDeps) {
  const now = deps.now ?? (() => Date.now())
  const resolveConfig = deps.resolveConfig ?? resolveXfyunConfig
  /** One pending SMS per process; a second send before cooldown is refused. */
  let pending: { msgid: string; phone: string; sentAt: number } | undefined

  return {
    /**
     * Send one login SMS.
     *
     * The 60s cooldown is enforced locally as well: the account API's own
     * limit answers with a business error, but a local guard keeps the card
     * from looking "sent" while the request actually bounced.
     */
    async sendCode(rawPhone: string): Promise<SendCodeResult> {
      const phone = rawPhone.trim()
      if (!PHONE_PATTERN.test(phone)) {
        return { ok: false, code: 'invalid_phone', message: '手机号格式不正确（需要中国大陆手机号）' }
      }
      const config = resolveConfig()
      if (config.kind === 'missing') {
        return { ok: false, code: 'app_missing', message: config.problem }
      }
      if (pending !== undefined && now() - pending.sentAt < SEND_CODE_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((SEND_CODE_COOLDOWN_MS - (now() - pending.sentAt)) / 1000)
        return {
          ok: false,
          code: 'cooldown',
          message: `验证码已发送（${displayPhone(pending.phone)}），${waitSeconds} 秒后才能重发。`,
        }
      }
      const result = await sendSmsCode({
        config: config.config,
        phone,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      })
      if (result.kind === 'failure') {
        return { ok: false, code: result.code, message: `验证码发送失败：${result.message}` }
      }
      pending = { msgid: result.msgid, phone, sentAt: now() }
      return {
        ok: true,
        msgid: result.msgid,
        phone: maskedValidPhone(phone),
        resendAfterMs: SEND_CODE_COOLDOWN_MS,
        expiresMs: SMS_EXPIRES_MS,
      }
    },

    /**
     * Verify the code and sign in. Success persists the session and invalidates
     * the auth cache; the next status read shows the new account.
     */
    async login(rawPhone: string, rawCode: string): Promise<LoginResult> {
      const phone = rawPhone.trim()
      const code = rawCode.trim()
      if (!PHONE_PATTERN.test(phone)) {
        return { ok: false, code: 'invalid_phone', message: '手机号格式不正确（需要中国大陆手机号）' }
      }
      if (!/^\d{4,8}$/u.test(code)) {
        return { ok: false, code: 'invalid_code', message: '验证码格式不正确（4–8 位数字）' }
      }
      if (pending === undefined || pending.phone !== phone) {
        return { ok: false, code: 'no_pending_code', message: '请先发送验证码，再输入登录。' }
      }
      const config = resolveConfig()
      if (config.kind === 'missing') {
        return { ok: false, code: 'app_missing', message: config.problem }
      }
      const result = await verifySmsCode({
        config: config.config,
        phone,
        code,
        msgid: pending.msgid,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      })
      if (result.kind === 'failure') {
        // A wrong-but-real code should clear the pending attempt only when the
        // upstream says the msgid is gone; format errors keep it for a retry.
        if (result.code === '100003' || result.code === 'invalid_msgid') pending = undefined
        return { ok: false, code: result.code, message: `登录失败：${result.message}` }
      }
      pending = undefined

      const persisted = await persistLogin(deps, now, result, phone)
      return persisted.login
    },

    /**
     * Sign out: remove the plugin-side session. The desktop client's file is
     * never touched; if it holds a session, the card falls back to it.
     */
    async logout(): Promise<LogoutResult> {
      if (deps.accounts !== undefined) {
        // Multi-account: "sign out" without an id means "detach every stored
        // account"; the card's per-account rows call `removeAccount` instead.
        const result = await clearPluginAuthSession(deps.storageDir())
        if (result.kind === 'failure') return { ok: false, code: result.code, message: result.message }
        deps.invalidateAuth()
        await deps.refreshRoutes?.()
        return { ok: true, message: '已退出登录。若 Loomy 桌面端仍处于登录状态，会改用它的登录态。' }
      }
      const result = await clearPluginAuthSession(deps.storageDir())
      if (result.kind === 'failure') return { ok: false, code: result.code, message: result.message }
      deps.invalidateAuth()
      return {
        ok: true,
        message: '已退出插件的登录。若 Loomy 桌面端仍处于登录状态，设置卡片会改用它的登录态。',
      }
    },

    /**
     * Forget the cached app-config resolution — used after the app updates or
     * reinstalls, so the next login re-reads the bundle.
     */
    resetConfigCache(): void {
      resetXfyunConfigCache()
    },
  }
}


/** A validated phone always masks; the fallback only satisfies the type. */
function maskedValidPhone(phone: string): string {
  return displayPhone(phone) ?? '*'.repeat(phone.length)
}

export type LoginService = ReturnType<typeof createLoginService>

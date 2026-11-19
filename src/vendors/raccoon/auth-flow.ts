/**
 * Raccoon auth flow: login, logout, refresh.
 *
 * Measured against the 2026-11-17 live gateway:
 *
 * | Operation | Endpoint | Auth | Confirmed |
 * |---|---|---|---|
 * | Logout | `POST /api/iam/v1/auth/logout` | `Authorization: Bearer` | 200 OK |
 * | Refresh | `POST /api/web/auth/v1/refresh` | body `{token}` | 400 (endpoint exists) |
 * | SMS login | `POST /api/web/auth/v1/login_with_sms` | body `{nation_code, phone, sms_code}` | 400 (phone must be encrypted) |
 * | Password login | `POST /api/web/auth/v1/login_with_password` | body `{nation_code, phone, password}` | 400 (phone must be encrypted) |
 * | Send SMS | `POST /api/web/auth/v1/send_sms` | body `{nation_code, phone}` | 400 (phone must be encrypted) |
 *
 * **Both the phone number and the password must be encrypted** before sending.
 * The client calls the same helper for both (`(0,l.yv)(m)` and `(0,l.yv)(g)` in
 * chunk 24605): AES-128-CFB with the passphrase `senseraccoon2023`, a fresh
 * 16-byte IV per call, IV prepended, Base64 throughout. See
 * {@link encryptRaccoonPhone} (which the client's `yv` is) and
 * `docs/raccoon-upstream.md` §9.1. The passphrase is obfuscation, not secrecy.
 *
 * `phoneEncryptor` stays injectable so a client update that rotates the
 * passphrase can be handled by configuration instead of a release.
 *
 * @module dsh-connect-desktop/vendors/raccoon/auth-flow
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { RACCOON_TIMEOUT_MS } from './constants.js'
import { raccoonHeaders } from './catalog.js'
import type { RaccoonAuthSnapshot } from './auth.js'

/** Phone encryption function. Takes raw phone, returns encrypted string. */
export type PhoneEncryptor = (phone: string, nationCode: string) => string | Promise<string>

/**
 * The default phone encryptor, matching the desktop client exactly.
 *
 * Reverse-engineered from the renderer chunk `21854` (module `24886`,
 * exported as `yv`), which every login call site uses:
 *
 * ```js
 * function l(e, t = "senseraccoon2023") {
 *   const r = CryptoJS.enc.Utf8.parse(t)          // key
 *   const s = CryptoJS.lib.WordArray.random(16)   // IV
 *   const n = CryptoJS.AES.encrypt(e, r, { iv: s, mode: AES.CFB, padding: NoPadding })
 *   return s.concat(n.ciphertext).toString(Base64) // IV ‖ ciphertext → Base64
 * }
 * ```
 *
 * So: **AES-128-CFB**, key `senseraccoon2023`, a fresh 16-byte IV per call,
 * the IV prepended to the ciphertext, the whole thing Base64-encoded. The
 * output is ~36 chars for an 11-digit phone, which is exactly what the main
 * process accepts (`/^[A-Za-z0-9+/]+={0,2}$/` in `accountRequests.js`).
 *
 * This is obfuscation, not secrecy — the passphrase ships in the app. It is
 * still pinned here because a wrong value makes login fail with an opaque
 * `100003 params_encryted_error` that looks like a network problem.
 */
export const RACCOON_PHONE_PASSPHRASE = 'senseraccoon2023'

export function encryptRaccoonPhone(phone: string, _nationCode?: string): string {
  const key = Buffer.from(RACCOON_PHONE_PASSPHRASE, 'utf8')
  if (key.length !== 16) {
    // Guard the one failure mode that produces a useless message: any AES key
    // of the wrong length throws "Invalid key length" from node:crypto, which
    // reads like a bug in the caller rather than in the pinned passphrase.
    throw new Error(`小浣熊手机号加密密钥长度异常（${key.length} 字节，需要 16）`)
  }
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-128-cfb', key, iv)
  const ciphertext = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

/** Inverse of {@link encryptRaccoonPhone}; used by tests and diagnostics. */
export function decryptRaccoonPhone(payload: string, passphrase: string = RACCOON_PHONE_PASSPHRASE): string {
  const raw = Buffer.from(payload, 'base64')
  if (raw.length <= 16) throw new Error('密文长度不足')
  const decipher = createDecipheriv('aes-128-cfb', Buffer.from(passphrase, 'utf8'), raw.subarray(0, 16))
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')
}

/** Result of a logout attempt. */
export interface LogoutResult {
  ok: boolean
  message: string
}

/** Result of a refresh attempt. */
export interface RefreshResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  message: string
}

/** Result of a login attempt. */
export interface LoginResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  identity?: string
  message: string
}

/** Result of a send-SMS attempt. */
export interface SendSmsResult {
  ok: boolean
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Encode a JSON body and send a POST. Returns the parsed response or throws. */
async function postJson(
  url: string,
  token: string | undefined,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = RACCOON_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: raccoonHeaders(token ?? '', {}),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) throw new Error(`响应不是 JSON 对象：${text.slice(0, 200)}`)
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `POST /api/iam/v1/auth/logout`
 *
 * The endpoint returns `{"code":"OK",...}` on success and a business error on
 * failure. No payload is required; the token goes in the header.
 */
export async function logout(
  token: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<LogoutResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RACCOON_TIMEOUT_MS)
  try {
    const response = await fetchImpl('https://xiaohuanxiong.com/api/iam/v1/auth/logout', {
      method: 'POST',
      headers: raccoonHeaders(token, {}),
      body: '{}',
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return { ok: false, message: `登出响应不是 JSON 对象：${text.slice(0, 200)}` }
    if (parsed['code'] === 'OK') return { ok: true, message: '已登出小浣熊账号' }
    const message = nonEmptyString(parsed['message']) ?? `HTTP ${response.status}`
    return { ok: false, message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `POST /api/web/auth/v1/refresh`
 *
 * The refresh endpoint expects a token in the body. The exact token type
 * (refresh token vs access token) is not yet confirmed — the server returned
 * `100002 param token invalid format` when an access token was sent, which
 * suggests it expects a different token format.
 */
export async function refreshToken(
  refreshToken: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RefreshResult> {
  try {
    const body = await postJson('https://xiaohuanxiong.com/api/web/auth/v1/refresh', undefined, { token: refreshToken }, options.fetchImpl ?? fetch)
    if (body['code'] === 0) {
      const data = isRecord(body['data']) ? body['data'] : {}
      return {
        ok: true,
        accessToken: nonEmptyString(data['access_token']),
        refreshToken: nonEmptyString(data['refresh_token']),
        message: '令牌已刷新',
      }
    }
    return { ok: false, message: nonEmptyString(body['message']) ?? '刷新失败' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * `POST /api/web/auth/v1/send_sms`
 *
 * Sends a verification code. The phone must be pre-encrypted.
 */
export async function sendSmsCode(
  token: string | undefined,
  nationCode: string,
  phone: string,
  encryptor: PhoneEncryptor,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SendSmsResult> {
  const encryptedPhone = await encryptor(phone, nationCode)
  try {
    const body = await postJson(
      'https://xiaohuanxiong.com/api/web/auth/v1/send_sms',
      token,
      { nation_code: nationCode, phone: encryptedPhone },
      options.fetchImpl ?? fetch,
    )
    if (body['code'] === 0) return { ok: true, message: '验证码已发送' }
    return { ok: false, message: nonEmptyString(body['message']) ?? '发送失败' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * `POST /api/web/auth/v1/login_with_sms`
 *
 * Logs in with a phone number and SMS code. Phone must be pre-encrypted.
 */
export async function loginWithSms(
  nationCode: string,
  phone: string,
  smsCode: string,
  encryptor: PhoneEncryptor,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<LoginResult> {
  const encryptedPhone = await encryptor(phone, nationCode)
  try {
    const body = await postJson(
      'https://xiaohuanxiong.com/api/web/auth/v1/login_with_sms',
      undefined,
      { nation_code: nationCode, phone: encryptedPhone, sms_code: smsCode },
      options.fetchImpl ?? fetch,
    )
    if (body['code'] === 0) {
      const data = isRecord(body['data']) ? body['data'] : {}
      return {
        ok: true,
        accessToken: nonEmptyString(data['access_token']),
        refreshToken: nonEmptyString(data['refresh_token']),
        identity: nonEmptyString(data['office_identity']),
        message: '登录成功',
      }
    }
    return { ok: false, message: nonEmptyString(body['message']) ?? '登录失败' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** `/api/web/auth/v1/user_info` 里我们关心的字段。 */
export interface UserInfoResult {
  ok: boolean
  /** 手机号（真实号码，不是掩码）——账号行要显示的就是它。 */
  phone?: string
  /** 昵称。 */
  name?: string
  /** 数字用户 id。 */
  userId?: string
  message: string
}

/**
 * `GET /api/web/auth/v1/user_info`
 *
 * 为什么需要它：登录响应只有 token 和 `office_identity`，**不含手机号**；
 * token 的 JWT 里也只有 `sub`。手机号只在这一处能拿到。不调它，账号行就永远
 * 只能显示「账号 3」。
 *
 * 桌面客户端对 `user_info` 用 GET（其余账号接口是 POST），见 `24605`。
 */
export async function fetchUserInfo(
  token: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<UserInfoResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RACCOON_TIMEOUT_MS)
  try {
    const response = await fetchImpl('https://xiaohuanxiong.com/api/web/auth/v1/user_info', {
      method: 'GET',
      headers: raccoonHeaders(token, {}),
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return { ok: false, message: 'user_info 响应不是 JSON 对象' }
    if (parsed['code'] !== 0) {
      return { ok: false, message: nonEmptyString(parsed['message']) ?? `HTTP ${response.status}` }
    }
    const data = isRecord(parsed['data']) ? parsed['data'] : {}
    const phone = nonEmptyString(data['phone'])
    const name = nonEmptyString(data['name'])
    const id = data['id']
    const userId = typeof id === 'number' ? String(id) : nonEmptyString(id)
    return {
      ok: true,
      ...(phone === undefined ? {} : { phone }),
      ...(name === undefined ? {} : { name }),
      ...(userId === undefined ? {} : { userId }),
      message: 'success',
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `POST /api/web/auth/v1/login_with_password`
 *
 * Logs in with phone and password. Phone must be pre-encrypted.
 */
export async function loginWithPassword(
  nationCode: string,
  phone: string,
  password: string,
  encryptor: PhoneEncryptor,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<LoginResult> {
  const encryptedPhone = await encryptor(phone, nationCode)
  // The client encrypts the password with the SAME helper as the phone:
  // `password: (0,l.yv)(g)` in chunk 24605. Sending it in clear text made the
  // gateway reject the request even when the phone was valid. Going through the
  // injected encryptor (not the built-in one) keeps a rotated passphrase
  // fixable by configuration for both fields at once.
  const encryptedPassword = await encryptor(password, nationCode)
  try {
    const body = await postJson(
      'https://xiaohuanxiong.com/api/web/auth/v1/login_with_password',
      undefined,
      { nation_code: nationCode, phone: encryptedPhone, password: encryptedPassword },
      options.fetchImpl ?? fetch,
    )
    if (body['code'] === 0) {
      const data = isRecord(body['data']) ? body['data'] : {}
      return {
        ok: true,
        accessToken: nonEmptyString(data['access_token']),
        refreshToken: nonEmptyString(data['refresh_token']),
        identity: nonEmptyString(data['office_identity']),
        message: '登录成功',
      }
    }
    return { ok: false, message: nonEmptyString(body['message']) ?? '登录失败' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Identity fields that come back from a successful login. */
export interface RaccoonLoginCredentials {
  accessToken: string
  refreshToken?: string
  identity?: string
}

/** Write a login credential into a snapshot (for the account store). */
export function credentialsFromSnapshot(snapshot: RaccoonAuthSnapshot): RaccoonLoginCredentials | undefined {
  if (!snapshot.found || snapshot.token === undefined) return undefined
  return {
    accessToken: snapshot.token,
    ...(snapshot.identity === undefined ? {} : { identity: snapshot.identity }),
  }
}

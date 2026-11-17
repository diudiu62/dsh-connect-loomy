/**
 * The Loomy account client: signed requests to iFlytek's account endpoints,
 * the SMS login flow, and the encrypted-app-config decryption.
 *
 * The account plane is a **separate host** (`account.xfinfr.com`) from the
 * Loomy platform (`loomyad.xunfei.cn`). Its requests authenticate with an
 * HMAC-SHA1 signature over `method/path/query/md5/contentType/date/nonce/...`
 * — the same scheme the desktop app ships (`electron/xfyun/sign.js`), with
 * credentials the app itself embeds encrypted in `.env.prod`.
 *
 * Where the credentials come from: the plugin **decrypts the app's own
 * `.env.prod` at runtime** rather than embedding a copy or asking the user to
 * type it. The passphrase ships with the app (obfuscation, not secrecy — the
 * app's own header says so), so decryption is exactly as legitimate as reading
 * the `auth-session.json` the app writes. Decrypted values live in memory only
 * and are never logged.
 *
 * @module dsh-connect-loomy/shared/xfyun
 */

import { constants, createDecipheriv, createHash, createHmac, publicEncrypt, randomUUID, scryptSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isRecord, safeErrorMessage } from './text.js'

/** The account plane's base URL, exactly as the app embeds it. */
export const XFYUN_DEFAULT_BASE_URL = 'https://account.xfinfr.com'

/** Fixed values the app sends in every `base` block. */
const MODEL_ID = 'Web'
const DEVICE_ID = 'web'
const UA = 'Loomy|Desktop|Electron|macOS'

/** The app's fixed values for the account request envelope. */
export interface XfyunBase {
  appid: string
  modelid: string
  version: string
  devid: string
  ua: string
  traceid: string
}

/** Everything the account client needs, decrypted from the app's config. */
export interface XfyunConfig {
  baseURL: string
  accessKeyId: string
  accessKeySecret: string
  appId: string
}

/** Resolving the app config either yields it or an executable problem. */
export type ResolvedXfyunConfig =
  | { kind: 'ok'; config: XfyunConfig; sourcePath: string }
  | { kind: 'missing'; problem: string }

const ENV_CRYPT_MAGIC = 'LOOMYENC1'
const ENV_CRYPT_PASSPHRASE = 'loomy::env::3f9c1d2a7b6e4f08::local-obfuscation::v1'
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/** App-bundle config candidates, in precedence order (macOS first). */
export function loomyAppEnvCandidates(): string[] {
  const home = homedir()
  return [
    '/Applications/Loomy.app/Contents/Resources/.env.prod',
    join(home, 'Applications', 'Loomy.app', 'Contents', 'Resources', '.env.prod'),
  ]
}

function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim())
    const key = match?.[1]
    if (key !== undefined && match !== null) values[key] = match[2] ?? ''
  }
  return values
}

/** Decrypt the app's `LOOMYENC1` payload (AES-256-GCM, scrypt-derived key). */
export function decryptLoomyEnv(raw: string): Record<string, string> {
  if (!raw.startsWith(`${ENV_CRYPT_MAGIC}:`)) return parseDotenv(raw)
  const buf = Buffer.from(raw.slice(ENV_CRYPT_MAGIC.length + 1).trim(), 'base64')
  if (buf.length < SALT_LEN + IV_LEN + TAG_LEN + 1) throw new Error('encrypted env payload too short')
  const salt = buf.subarray(0, SALT_LEN)
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const data = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN)
  const key = scryptSync(ENV_CRYPT_PASSPHRASE, salt, KEY_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  return parseDotenv(plaintext)
}

/** Extract the account config from a decrypted env map, or `undefined`. */
export function configFromEnv(env: Record<string, string>): XfyunConfig | undefined {
  const baseURL = env['LOOMY_XFYUN_BASE_URL'] || env['VITE_XFYUN_BASE_URL']
  const accessKeyId = env['LOOMY_XFYUN_ACCESS_KEY_ID'] || env['VITE_XFYUN_ACCESS_KEY_ID']
  const accessKeySecret = env['LOOMY_XFYUN_ACCESS_KEY_SECRET'] || env['VITE_XFYUN_ACCESS_KEY_SECRET']
  const appId = env['LOOMY_XFYUN_APP_ID'] || env['VITE_XFYUN_APP_ID']
  if (!baseURL || !accessKeyId || !accessKeySecret || !appId) return undefined
  return { baseURL, accessKeyId, accessKeySecret, appId }
}

let cachedConfig: ResolvedXfyunConfig | undefined

/**
 * Resolve the app's account credentials.
 *
 * A *missing* result is cached (re-probing every card render would reread the
 * app bundle for nothing); a *corrupt* payload is not, so reinstalling the app
 * is picked up on the next attempt.
 */
export function resolveXfyunConfig(): ResolvedXfyunConfig {
  if (cachedConfig !== undefined) return cachedConfig
  for (const path of loomyAppEnvCandidates()) {
    if (!existsSync(path)) continue
    try {
      const env = decryptLoomyEnv(readFileSync(path, 'utf8'))
      const config = configFromEnv(env)
      if (config === undefined) continue
      cachedConfig = { kind: 'ok', config, sourcePath: path }
      return cachedConfig
    } catch {
      continue
    }
  }
  cachedConfig = {
    kind: 'missing',
    problem:
      '没有找到可用的 Loomy 应用配置（需要本机安装 Loomy 桌面端）。安装后点「重新检测」即可，无需重启 DSH。',
  }
  return cachedConfig
}

/** Forget the cached config (tests; or after the app is reinstalled). */
export function resetXfyunConfigCache(): void {
  cachedConfig = undefined
}

/** Build the `base` object every account request embeds. */
export function xfyunBase(appId: string): XfyunBase {
  return {
    appid: appId,
    modelid: MODEL_ID,
    version: '1.0.0',
    devid: DEVICE_ID,
    ua: UA,
    traceid: randomUUID().replace(/-/gu, ''),
  }
}

function escapePathSegment(segment: string): string {
  return encodeURIComponent(segment)
    .replace(/!/gu, '%21')
    .replace(/'/gu, '%27')
    .replace(/\(/gu, '%28')
    .replace(/\)/gu, '%29')
    .replace(/\*/gu, '%2A')
}

/** RFC 3986 path escaping, segment by segment. */
export function escapeXfyunPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment ? escapePathSegment(segment) : ''))
    .join('/')
}

/**
 * The app's exact string-to-sign, exposed so a test can pin the algorithm
 * without re-deriving it: nine lines joined by `\n`, no trailing newline.
 */
export function xfyunStringToSign(options: {
  method: 'GET' | 'POST'
  path: string
  queryParams?: Record<string, string | number | boolean>
  body?: string
  contentType?: string
  date: string
  nonce: string
}): string {
  const contentType = options.contentType ?? 'application/json'
  const body = options.body ?? ''
  const md5 = body.length > 0 ? createHash('md5').update(body, 'utf8').digest('base64') : ''
  const escapedQuery = Object.entries(options.queryParams ?? {})
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
    .join('&')
  return [
    options.method.toUpperCase(),
    escapeXfyunPath(options.path),
    escapedQuery,
    md5,
    contentType,
    options.date,
    options.nonce,
    '',
    '',
  ].join('\n')
}

/** The four headers the account API requires (plus content-type). */
export function xfyunHeaders(options: {
  accessKeyId: string
  accessKeySecret: string
  method: 'GET' | 'POST'
  path: string
  queryParams?: Record<string, string | number | boolean>
  body?: string
  contentType?: string
  /** Injectable for deterministic tests. */
  date?: string
  nonce?: string
}): Record<string, string> {
  const contentType = options.contentType ?? 'application/json'
  const body = options.body ?? ''
  const date = options.date ?? new Date().toUTCString()
  const nonce = options.nonce ?? randomUUID()
  const stringToSign = xfyunStringToSign({ ...options, date, nonce, body, contentType })
  const signature = createHmac('sha1', options.accessKeySecret).update(stringToSign, 'utf8').digest('base64')
  const headers: Record<string, string> = {
    authorization: `account ${options.accessKeyId}:${signature}`,
    date,
    nonce,
    'content-type': contentType,
  }
  if (body.length > 0) headers['content-md5'] = createHash('md5').update(body, 'utf8').digest('base64')
  return headers
}

/** One account call's outcome. Mirrors the platform client's envelope rules. */
export type AccountResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'failure'; code: string; message: string }

/** Shape of the account API's error envelope. */
function envelopeFailure(body: unknown, status?: number): AccountResult | undefined {
  if (!isRecord(body)) return undefined
  const code = body['code']
  const desc = body['desc'] ?? body['message']
  if (code === undefined && desc === undefined) return undefined
  const codeText = typeof code === 'string' ? code : String(code ?? '')
  if (codeText === '' || codeText === '000000' || codeText === '0' || codeText === '200') return undefined
  return {
    kind: 'failure',
    code: codeText === '' && status !== undefined ? `HTTP_${status}` : codeText,
    message: typeof desc === 'string' && desc.length > 0 ? desc : `account API error ${codeText}`,
  }
}

/** POST one signed JSON request to the account plane. */
export async function requestAccount(options: {
  config: XfyunConfig
  path: string
  body: unknown
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<AccountResult> {
  const { config, path } = options
  const bodyText = JSON.stringify(options.body)
  const headers = { ...xfyunHeaders({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    method: 'POST',
    path,
    body: bodyText,
  }), 'content-type': 'application/json' }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()

  let response: Response
  try {
    response = await fetchImpl(`${config.baseURL.replace(/\/+$/u, '')}${path}`, {
      method: 'POST',
      headers,
      body: bodyText,
      signal: controller.signal,
    })
  } catch (error) {
    const name = isRecord(error) ? error['name'] : undefined
    const message = safeErrorMessage(error)
    return {
      kind: 'failure',
      code: name === 'AbortError' || /timed out|abort/iu.test(message) ? 'timeout' : 'network',
      message,
    }
  } finally {
    clearTimeout(timer)
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return { kind: 'failure', code: 'read_failed', message: safeErrorMessage(error) }
  }
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    return {
      kind: 'failure',
      code: `HTTP_${response.status}`,
      message: `account API answered ${response.status} with a non-JSON body`,
    }
  }
  const failure = envelopeFailure(parsed, response.status)
  if (failure !== undefined) return failure
  if (!response.ok) {
    return {
      kind: 'failure',
      code: `HTTP_${response.status}`,
      message: `account API answered HTTP ${response.status}`,
    }
  }
  return { kind: 'ok', data: isRecord(parsed) && 'data' in parsed ? parsed['data'] : parsed }
}

/** Phone shape the account API accepts (mainland China mobile numbers). */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/u

/** Send one login SMS; returns the `msgid` needed to verify the code. */
export async function sendSmsCode(options: {
  config: XfyunConfig
  phone: string
  fetchImpl?: typeof fetch
}): Promise<{ kind: 'ok'; msgid: string } | { kind: 'failure'; code: string; message: string }> {
  const result = await requestAccount({
    config: options.config,
    path: '/login/phone/sendMsgCode',
    body: {
      base: xfyunBase(options.config.appId),
      param: { ccode: '86', phone: options.phone, expire: 300 },
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (result.kind === 'failure') return result
  const msgid = isRecord(result.data) ? result.data['msgid'] : undefined
  if (typeof msgid !== 'string' || msgid.length === 0) {
    return { kind: 'failure', code: 'no_msgid', message: 'account API returned no msgid for the sent code' }
  }
  return { kind: 'ok', msgid }
}

/** Verify the code and return the session material the app would store. */
export async function verifySmsCode(options: {
  config: XfyunConfig
  phone: string
  code: string
  msgid: string
  fetchImpl?: typeof fetch
}): Promise<
  | { kind: 'ok'; session: string; userId?: string; phone?: string }
  | { kind: 'failure'; code: string; message: string }
> {
  const result = await requestAccount({
    config: options.config,
    path: '/login/phone/checkCode',
    body: {
      base: xfyunBase(options.config.appId),
      param: {
        ccode: '86',
        phone: options.phone,
        mcode: options.code,
        msgid: options.msgid,
        expire: 14 * 24 * 3600,
      },
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (result.kind === 'failure') return result
  const data = isRecord(result.data) ? result.data : undefined
  const session = data === undefined ? undefined : data['session']
  if (typeof session !== 'string' || session.length < 16 || /\s/u.test(session)) {
    return {
      kind: 'failure',
      code: 'no_session',
      message: '账号服务未返回可用的 session（登录可能被拒绝，请重试）',
    }
  }
  const userId = data?.['userid']
  const phone = data?.['phone']
  return {
    kind: 'ok',
    session,
    ...(typeof userId === 'string' && userId.length > 0 ? { userId } : {}),
    ...(typeof phone === 'string' && phone.length > 0 ? { phone } : {}),
  }
}

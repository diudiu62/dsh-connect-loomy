/**
 * Pure text/number helpers shared by the host, its routes, its CLI and the
 * Node test suite. No I/O and no clock reads: every function here is safe to
 * unit-test with a table of literals.
 *
 * The redaction helpers exist because upstream errors are reported verbatim
 * (contract: never translate `desc`). Verbatim text is the right default; the
 * one exception is a token/PII fragment the upstream happened to echo, which
 * must never reach a log, a settings section, the browser or a cache file.
 *
 * @module dsh-connect-desktop/shared/text
 */

/** A plain record (non-null, non-array object). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty trimmed string, or `undefined`. */
export function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Finite number, or `undefined` (never coerces strings). */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A positive integer, or `undefined`. */
export function asPositiveInt(value: unknown): number | undefined {
  const number = asNumber(value)
  if (number === undefined || number <= 0) return undefined
  return Math.trunc(number)
}

/** String array with empty entries removed and duplicates collapsed. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    const text = asString(entry)
    if (text === undefined || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

/** De-duplicate a string list while keeping first-seen order. */
export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * The phone number as the settings card shows it.
 *
 * Unmasked on purpose: this is the user's own machine, the value came from
 * their own login, and a masked number makes it impossible to tell two
 * accounts apart or to recognise which one a code was sent to. Masking is
 * kept for *logs* (see `maskPhone` / `redactSensitive`), where the value would
 * outlive its purpose in a file the user never asked to contain it.
 */
export function displayPhone(value: unknown): string | undefined {
  return asString(value)
}

/** The local user id as the settings card shows it (unmasked, see displayPhone). */
export function displayUserId(value: unknown): string | undefined {
  return asString(value)
}

/**
 * Mask a phone number **for logs**: `13812341234` → `138****1234`.
 *
 * 账号视图不脱敏（`displayPhone` 原样返回）；这里存在的唯一目的是日志与上游
 * 错误文本，避免把用户的手机号写进日志文件。
 *
 * The host never exposes the raw number — not in logs, not in a cache file,
 * not on an HTTP route and not on the command line. Short inputs degrade to a
 * fully starred string instead of leaking whatever digits they contain.
 */
/**
 * 掩码一个手机号（`138****1234`）。
 *
 * **只用于日志与上游错误文本**，不用于用户可见的账号视图：本地账号按产品决定
 * 原样展示（`displayPhone`）。视图里出现掩码值会让用户没法核对自己登录的是哪个号。
 */
export function maskPhone(value: unknown): string | undefined {
  const raw = asString(value)
  if (raw === undefined) return undefined
  const digits = raw.replace(/\D/gu, '')
  if (digits.length === 0) return undefined
  if (digits.length <= 4) return '*'.repeat(digits.length)
  if (digits.length <= 7) return `${digits.slice(0, 1)}${'*'.repeat(digits.length - 2)}${digits.slice(-1)}`
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 7)}${digits.slice(-4)}`
}

/**
 * Mask a local user id: keep the first and last four characters so a support
 * report can still tell two accounts apart without carrying the identifier.
 */
export function maskUserId(value: unknown): string | undefined {
  const raw = asString(value)
  if (raw === undefined) return undefined
  if (raw.length <= 8) return '*'.repeat(raw.length)
  return `${raw.slice(0, 4)}${'*'.repeat(raw.length - 8)}${raw.slice(-4)}`
}

/**
 * Parse the points multiplier out of an upstream model name.
 *
 * The gateway embeds it in the human name: `DeepSeek V4.1 Flash(x2.0)`,
 * `qwen 3.8 flash（x0.8）`, `Spark-X2.6 正式版(限时免费)(x0.0)`. Only parenthesised
 * forms count: names such as `Spark X2.5` must not be read as an `x2.5` rate.
 * An absent multiplier reports `0` (free) rather than inventing a price.
 */
export function parseMultiplier(name: string): number {
  const parenthesised = /[（(]\s*[xX×]\s*(\d+(?:\.\d+)?)\s*[)）]/u.exec(name)
  const match = parenthesised ?? null
  if (match === null) return 0
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Redact token-like and phone-like fragments from a string.
 *
 * Upstream messages are otherwise passed through unchanged (the contract
 * requires the original `desc`). This only rewrites fragments that look like a
 * secret: a 32+ hex session, a bearer value, a `token=` pair, or a bare
 * mainland phone number.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b[0-9a-f]{32,}\b/giu, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[redacted]')
    .replace(/(\b(?:token|session|authorization)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/\b1[3-9]\d{9}\b/gu, '[redacted phone]')
}

/**
 * Message for "there is no session at all".
 *
 * `problem` already names every path that was inspected, so also prefixing the
 * headline path produced `未找到可用的 Loomy 登录态（<path>）：…（<path>）` — the
 * same path twice in the red box the settings card renders.
 */
export function notSignedInMessage(sourcePath: string, problem?: string): string {
  if (problem === undefined || problem.trim().length === 0) {
    return `未找到可用的 Loomy 登录态（${sourcePath}）`
  }
  // Keep the headline path when the explanation does not already carry it,
  // but never print the same path twice.
  if (problem.includes(sourcePath)) return `未找到可用的 Loomy 登录态：${problem}`
  return `未找到可用的 Loomy 登录态（${sourcePath}）：${problem}`
}

/** Turn any thrown value into a redacted, length-bounded diagnostic string. */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return redactSensitive(raw).slice(0, 500)
}

/** Human-readable epoch-ms timestamp for CLI output; never throws. */
export function formatDateTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (part: number): string => (part < 10 ? `0${part}` : String(part))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Upstream `createdAt`/`updatedAt` values are seconds; normalise to epoch ms. */
export function toEpochMs(value: unknown): number {
  const number = asNumber(value)
  if (number === undefined) return 0
  // 1e11 ~= 1973 in seconds / 1970 in ms; anything smaller is a seconds stamp.
  const ms = number < 1e11 ? number * 1000 : number
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0
}

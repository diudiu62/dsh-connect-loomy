/**
 * Who may drive the plugin's own `/plugins/dsh-connect-loomy/*` routes.
 *
 * The harness webserver binds one concrete local interface and has no
 * per-route auth or CSRF layer of its own (contract doc §4.2). Two cheap
 * headers therefore gate this surface:
 *
 * - **Host** must name the interface the connection actually landed on (or a
 *   loopback name). This is what drops a DNS-rebinding page: its browser sends
 *   the attacker's domain in Host even though the name resolved to 127.0.0.1.
 * - **Origin**, when present, must be local. An absent Origin is a non-browser
 *   client (the card's own fetch, curl, the test suite) and must pass.
 *
 * Neither is authentication: any local process can forge both. They are the
 * minimum for a read/write surface whose writes only persist a selection; the
 * mutating routes additionally require a process-level CSRF token.
 *
 * @module dsh-connect-loomy/shared/loopback
 */

import { isIP } from 'node:net'

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]'])

function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255 && !(part.length > 1 && part.startsWith('0')))
  }
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return isIP(inner) === 6
}

function isIpv4Loopback(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
  if (match === null) return false
  const octets = match.slice(1, 5).map((part) => Number(part))
  if (octets.some((octet) => octet > 255)) return false
  if (match.slice(1, 5).some((part) => part.length > 1 && part.startsWith('0'))) return false
  return octets[0] === 127
}

/** Strip the optional `:port` from a Host header, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end === -1) return hostname
    const after = hostname.slice(end + 1)
    if (after !== '' && !/^:\d+$/u.test(after)) return hostname
    return hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/u.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

function isLocalHostname(hostname: string): boolean {
  const name = hostname.endsWith('.') && !hostname.endsWith('..') ? hostname.slice(0, -1) : hostname
  return LOOPBACK_HOSTS.has(name) || name === '::1' || isIpv4Loopback(name)
}

/** Whether a Host header names the address the connection arrived on. */
export function hostMatchesListener(host: string | undefined, localAddress: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  const hostname = hostnameOfHost(host)
  if (isLocalHostname(hostname)) return true
  if (hostname === '0.0.0.0' || hostname === '[::]') return false
  if (localAddress === undefined || localAddress.trim() === '') return false
  const local = localAddress.trim().toLowerCase()
  if (!isIpLiteral(local) && !isIpLiteral(`[${local}]`)) return false
  const bare = (value: string): string =>
    value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6 ? value.slice(1, -1) : value
  return bare(hostname) === bare(local)
}

/** Whether a browser-sent Origin may drive this route (absent passes). */
export function originIsLocal(origin: string | undefined, localAddress: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    if (isLocalHostname(hostname)) return true
    return hostMatchesListener(hostname, localAddress)
  } catch {
    return false
  }
}

/** One guard verdict. */
export type LoopbackVerdict = { ok: true } | { ok: false; reason: 'host' | 'origin' }

/** Evaluate both loopback guards for an incoming request. */
export function checkLoopback(req: {
  headers: { host?: string | undefined; origin?: string | undefined }
  socket: { localAddress?: string | undefined }
}): LoopbackVerdict {
  if (!hostMatchesListener(req.headers.host, req.socket.localAddress)) return { ok: false, reason: 'host' }
  if (!originIsLocal(req.headers.origin, req.socket.localAddress)) return { ok: false, reason: 'origin' }
  return { ok: true }
}

/**
 * 本机安装的小浣熊桌面客户端版本号，从 app bundle 里读出来。
 *
 * 为什么存在：`X-Client-Version` 是网关/WAF 聚类流量的特征头之一。插件早先把
 * 它钉死在 `2.0.0`（2026-11-17 取证时的实测值），而本机装着的客户端是 `1.2.0`
 * ——一个与所有真实客户端都不一致的版本号，就是"这不是官方客户端"的自白。
 * 现在运行时读真实 bundle；读不到（没装、路径变了）才退回常量兜底。
 *
 * 读取方式：解析 `app.asar` 的头（索引是 JSON），从 `package.json` 条目里取
 * `version`。macOS 的 bundle 是 `/Applications/商汤小浣熊.app`；Windows 的安装
 * 布局没有实测，先不猜，读不到就退回兜底（`app-version.ts` 的失败缓存让"没装"
 * 的机器不会每次请求都去碰磁盘）。
 *
 * @module dsh-connect-desktop/vendors/raccoon/app-version
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 失败结果的缓存窗口（成功结果一直用到进程结束：版本不会在中途变）。 */
export const APP_VERSION_FAILURE_TTL_MS = 60_000

interface CacheEntry {
  value: string | undefined
  at: number
}

const cache = new Map<string, CacheEntry>()

/**
 * app.asar 的候选位置。`RACCOON_APP_BUNDLE` 是排他替换（测试与非常规安装用）。
 */
export function raccoonAppBundleCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const override = env['RACCOON_APP_BUNDLE']
  if (typeof override === 'string' && override.trim().length > 0) return [override.trim()]
  if (process.platform === 'darwin') {
    // 系统安装优先，其次用户自己的 ~/Applications（先系统的那份，别读到旧副本）。
    return [
      '/Applications/商汤小浣熊.app/Contents/Resources/app.asar',
      join(home, 'Applications', '商汤小浣熊.app', 'Contents', 'Resources', 'app.asar'),
    ]
  }
  if (process.platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    return [
      join(localAppData, 'Programs', '商汤小浣熊', 'resources', 'app.asar'),
      join(localAppData, '商汤小浣熊', 'resources', 'app.asar'),
    ]
  }
  return []
}

interface AsarEntry {
  size?: number
  offset?: string
}

/**
 * 从 asar 里读 `package.json` 的 `version`。永不抛异常。
 *
 * asar 头布局（pickle）：`[0..4) = 4`、`[4..8) header size`（含 JSON 长度字段
 * 与对齐填充）、`[8..12)`/`[12..16)` 两个长度字段，JSON 在 `[16, 16+jsonLen)`；
 * 文件数据从 `8 + headerSize（u32@4）` 开始。用 `u32@12`（JSON 长度）当偏移是
 * 常见的错写法：填充字节会让读出来的内容前面带垃圾，`JSON.parse` 直接抛异常。
 */
function readAsarPackageVersion(path: string): string | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
  try {
    const jsonLength = buffer.readUInt32LE(12)
    const dataOffset = 8 + buffer.readUInt32LE(4)
    const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8')) as {
      files?: Record<string, AsarEntry>
    }
    const entry = header.files?.['package.json']
    if (entry === undefined || typeof entry.offset !== 'string' || typeof entry.size !== 'number') {
      return undefined
    }
    const start = dataOffset + Number(entry.offset)
    const document: unknown = JSON.parse(buffer.subarray(start, start + entry.size).toString('utf8'))
    if (document === null || typeof document !== 'object') return undefined
    const version = (document as Record<string, unknown>)['version']
    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 读安装的客户端版本。
 *
 * 读不到时返回 `undefined`（正常状态：没装客户端），**不抛异常**；
 * 失败缓存 {@link APP_VERSION_FAILURE_TTL_MS}，成功缓存到进程结束。
 */
export function readRaccoonAppVersion(
  options: { env?: NodeJS.ProcessEnv; home?: string; now?: number } = {},
): string | undefined {
  const now = options.now ?? Date.now()
  const candidates = raccoonAppBundleCandidates(options.env, options.home)
  const key = candidates[0] ?? 'none'
  const hit = cache.get(key)
  if (hit !== undefined) {
    if (hit.value !== undefined) return hit.value
    if (now - hit.at < APP_VERSION_FAILURE_TTL_MS) return undefined
  }
  let value: string | undefined
  for (const path of candidates) {
    value = readAsarPackageVersion(path)
    if (value !== undefined) break
  }
  cache.set(key, { value, at: now })
  return value
}

/** 丢掉进程内缓存（测试用）。 */
export function resetAppVersionCache(): void {
  cache.clear()
}

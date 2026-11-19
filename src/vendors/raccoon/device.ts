/**
 * 桌面端设备号（`clientDeviceId`）：读取 + 进程内缓存。
 *
 * 网关的每次调用都带 `X-Client-Device-ID`，值来自客户端自己写的
 * `desktop-device-identity.json`。旧实现每次取值都 `readFileSync` 一遍，而
 * 「刷新目录 + 读每个账号的余额」一次操作里会读 3 次以上（余额是逐账号读的，
 * N 个账号就是 N 次）。这里加一层进程内缓存，理由：
 *
 * 1. **文件只在客户端重装/重置身份时变**，不是每次启动都变；缓存不会读到旧值
 *    以外的错误状态。
 * 2. 读失败（文件不存在、客户端没装）**不是**否定结论，只表示"现在读不到"，
 *    所以失败只缓存 60 秒：既挡住一次操作里的重复系统调用，又不会让用户在装好
 *    客户端之后还得重启 DSH。
 * 3. 缓存键是**解析出来的路径**，不是 `undefined`／全局单例：`RACCOON_DEVICE_ID_FILE`
 *    一变就是另一条路径，各平台默认路径也各不相同，测试里互相不会串。
 * 4. 成功后不再重读（"读到成功为止"）：重装客户端会换 device id，但那种场景下
 *    进程重启是常态，且换取一个新的 device id 对我们只是多一次上游容忍。
 *
 * @module dsh-connect-desktop/vendors/raccoon/device
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 失败结果的缓存窗口（成功结果一直用到进程结束）。 */
export const DEVICE_ID_FAILURE_TTL_MS = 60_000

interface CacheEntry {
  /** 读到的 device id；`undefined` 表示这次没读到。 */
  value: string | undefined
  /** 写入缓存的时刻。 */
  at: number
}

const cache = new Map<string, CacheEntry>()

/** `desktop-device-identity.json` 的位置（`RACCOON_DEVICE_ID_FILE` 优先）。 */
export function deviceIdentityPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env['RACCOON_DEVICE_ID_FILE']
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'office-raccoon', 'desktop-device-identity.json')
  }
  if (process.platform === 'win32') {
    const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'office-raccoon', 'desktop-device-identity.json')
  }
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'office-raccoon', 'desktop-device-identity.json')
}

/** 读一次磁盘，不做缓存判断。 */
function readOnce(path: string): string | undefined {
  try {
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (document === null || typeof document !== 'object') return undefined
    const value = (document as Record<string, unknown>)['clientDeviceId']
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 读客户端的 device id。
 *
 * 读不到时返回 `undefined`（正常状态：没装客户端），**不抛异常**。
 */
export function readDeviceId(
  options: { env?: NodeJS.ProcessEnv; home?: string; now?: number } = {},
): string | undefined {
  const path = deviceIdentityPath(options.env, options.home)
  const at = options.now ?? Date.now()
  const hit = cache.get(path)
  if (hit !== undefined) {
    if (hit.value !== undefined) return hit.value
    if (at - hit.at < DEVICE_ID_FAILURE_TTL_MS) return undefined
  }
  const value = readOnce(path)
  cache.set(path, { value, at })
  return value
}

/** 丢掉进程内缓存（测试与「重新检测」用）。 */
export function resetDeviceIdCache(): void {
  cache.clear()
}

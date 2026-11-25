/**
 * 逐账号额度的**懒加载**：一行一条请求，数字随到随填。
 *
 * 为什么不是一次性批量：`credits?accounts=1` 要为每个账号打一次上游（2 并发 +
 * 120ms 间隔），90 个账号就是 5 秒以上——那段时间里抽屉只能空着，用户看到的是
 * "打开没反应"。拆成单条之后，账号行立刻画出来，每一行的数字各自到货。
 *
 * 上游请求量并没有变多（还是每账号一次），只是从"一次 HTTP 里串行等完"变成
 * "多条 HTTP 并行补"；宿主侧 `core/credits.ts` 的 per-account memo 仍然兜住
 * 60 秒内的重复打开。
 *
 * @module dsh-connect-desktop/client/capability/useAccountCredits
 */

import { useEffect, useState } from 'react'
import type { CreditsView } from '../../shared/views.js'
import { requestVendor } from '../transport.js'

/** 一个账号的读数：与 `CreditsAccountView` 同形，但可能处于"还没回来"的状态。 */
export interface AccountCreditEntry {
  fields: Record<string, number>
  error?: string
}

/** 同时在飞的请求数。与宿主侧逐账号读取的节奏一致，不再额外加压。 */
const CONCURRENCY = 3

export interface AccountCreditsState {
  /** 已到货的读数，键是账号 id。 */
  entries: Record<string, AccountCreditEntry>
  /** 还没有读数的账号数（用于"正在读取 N 个"这类提示）。 */
  pending: number
}

/**
 * 逐账号读取额度。
 *
 * 账号集合用**内容**做依赖（不是数组身份）：`rows.map(...)` 每次 render 都是
 * 新数组，按身份依赖会让 effect 每帧重启一次。
 */
export function useAccountCredits(options: {
  vendorId: string
  accountIds: readonly string[]
  enabled: boolean
}): AccountCreditsState {
  const [entries, setEntries] = useState<Record<string, AccountCreditEntry>>({})
  const idsKey = options.accountIds.join('\u0000')

  useEffect(() => {
    if (!options.enabled || options.accountIds.length === 0) return undefined
    const controller = new AbortController()
    const queue = [...options.accountIds]
    let alive = true

    const settle = (id: string, entry: AccountCreditEntry): void => {
      if (!alive) return
      // 逐行合并：一个账号回来就画一个，不等同批的其它账号。
      setEntries((prev) => ({ ...prev, [id]: entry }))
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        const id = queue.shift()
        if (id === undefined || !alive) return
        const result = await requestVendor<CreditsView>({
          vendorId: options.vendorId,
          suffix: 'credits/account',
          query: `id=${encodeURIComponent(id)}`,
          signal: controller.signal,
        })
        if (!alive || controller.signal.aborted) return
        if (result.kind === 'ok') settle(id, { fields: result.value.fields })
        else settle(id, { fields: {}, error: result.message })
      }
    }

    void Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    return () => {
      alive = false
      controller.abort()
    }
    // `idsKey` 覆盖 `accountIds` 的内容；`options` 整体作为依赖会每帧重启。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.vendorId, idsKey, options.enabled])

  const pending = options.accountIds.filter((id) => entries[id] === undefined).length
  return { entries, pending }
}

/**
 * 一个账号的主数字。
 *
 * 与 `format.ts#perAccountAmount` 的区别：这里的数据源是"单条请求的结果"，
 * 而不是批量视图里的 `perAccount`，所以"还没到货"是**第三种状态**——
 * 界面该显示 `…`（正在读），而不是 `—`（读不到）。
 */
export function accountEntryAmount(
  entry: AccountCreditEntry | undefined,
  key: string | undefined,
): number | undefined {
  if (entry === undefined || key === undefined || entry.error !== undefined) return undefined
  const value = entry.fields[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

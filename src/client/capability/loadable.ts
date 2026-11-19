/**
 * One hook for "read a vendor route and render whatever came back".
 *
 * All three capability panels need the same four things from a read — an
 * initial load, a manual reload, an abort on unmount, and a `Loadable` that
 * keeps "no such route" distinct from "the host said no" — so it lives here
 * once. Panels stay free of effect bookkeeping and only decide *which* route to
 * read and *when*.
 *
 * Aborts are swallowed on purpose: a reload triggered by a button press can
 * overtake the mount read, and the superseded response must not overwrite the
 * newer one. That is also why the previous controller is aborted before a new
 * request starts.
 *
 * @module dsh-connect-desktop/client/capability/loadable
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TransportResult } from '../transport.js'
import { isAbortError } from '../transport.js'
import { type Loadable, mapResult } from '../components/types.js'

/** What a panel consumes from {@link useVendorRoute}. */
export interface RouteHandle<T> {
  state: Loadable<T>
  /** Re-read the route; resolves with the value when it succeeded, else `null`. */
  reload: (options?: { silent?: boolean }) => Promise<T | null>
}

/**
 * Read one route on mount and on demand.
 *
 * @param load - stable loader (wrap in `useCallback`); receives the abort signal.
 * @param enabled - `false` means the capability is absent: stay `idle`, never fetch.
 */
export function useVendorRoute<T>(
  load: (signal: AbortSignal) => Promise<TransportResult<T>>,
  enabled = true,
): RouteHandle<T> {
  const [state, setState] = useState<Loadable<T>>(enabled ? { kind: 'loading' } : { kind: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  /*
   * 依赖 `load` 而不是空数组。
   *
   * 调用方用 `useCallback(..., [vendorId, csrf])` 生成 load，所以 load 的引用变化
   * 就代表"数据源变了"（例如用户在设置页切了供应商）。之前这里依赖 `[]`，配上
   * 只依赖 `[enabled, run]` 的 effect，切供应商时**根本不会重新拉取**——界面继续
   * 显示上一家的账号列表。
   */
  const run = useCallback(async (silent: boolean): Promise<T | null> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (!silent) setState({ kind: 'loading' })
    try {
      const result = await load(controller.signal)
      if (controller.signal.aborted) return null
      setState(mapResult(result))
      return result.kind === 'ok' ? result.value : null
    } catch (error) {
      if (isAbortError(error)) return null
      const message = error instanceof Error ? error.message : String(error)
      setState({ kind: 'unavailable', reason: 'network', message })
      return null
    }
  }, [load])

  useEffect(() => {
    if (!enabled) {
      setState({ kind: 'idle' })
      return undefined
    }
    void run(false)
    return () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [enabled, run])

  const reload = useCallback((options?: { silent?: boolean }) => run(options?.silent === true), [run])

  return { state, reload }
}

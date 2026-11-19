/**
 * TTL + single-flight memoisation, written once for every vendor.
 *
 * Three shapes of the same idea existed before this module: the catalog cache,
 * the credits cache, the credential re-read window and the precheck window.
 * They differ only in the TTL and the loader, so they are one function now.
 *
 * Contract:
 * - a fresh value is answered without touching the loader;
 * - concurrent misses share **one** loader invocation (single flight), because
 *   two panes opening at once must not double an upstream call;
 * - a loader failure is **re-thrown, never cached** — "we could not read it" is
 *   not a value, and caching it would turn a blip into a TTL-long outage.
 *
 * @module dsh-connect-desktop/core/ttl
 */

export interface MemoOptions<T> {
  /** Entry lifetime in milliseconds; `0` means "always reload". */
  ttlMs: () => number
  load: () => Promise<T>
  now?: () => number
  /** Called on every successful load, for stamping `refreshedAt`. */
  onLoaded?: (value: T, at: number) => void
}

export interface Memo<T> {
  /** Read, reloading when stale. Rejects when the loader rejects. */
  read(options?: { force?: boolean }): Promise<T>
  /** Value currently held, without any I/O. */
  peek(): T | undefined
  /** Epoch ms of the last successful load, or `null`. */
  loadedAt(): number | null
  /** True while a load is in flight. */
  busy(): boolean
  /** Drop the held value (the next read reloads). */
  clear(): void
  /** Replace the held value, e.g. after a write-through. */
  set(value: T): void
}

export function createMemo<T>(options: MemoOptions<T>): Memo<T> {
  const now = options.now ?? (() => Date.now())
  let value: T | undefined
  let at: number | null = null
  let pending: Promise<T> | undefined

  const fresh = (): boolean => {
    if (value === undefined || at === null) return false
    const ttl = options.ttlMs()
    if (!Number.isFinite(ttl) || ttl <= 0) return false
    return now() - at < ttl
  }

  return {
    async read(readOptions = {}) {
      if (readOptions.force !== true && fresh()) return value as T
      if (pending !== undefined) return pending
      pending = (async () => {
        try {
          const loaded = await options.load()
          value = loaded
          at = now()
          options.onLoaded?.(loaded, at)
          return loaded
        } finally {
          pending = undefined
        }
      })()
      return pending
    },
    peek: () => value,
    loadedAt: () => at,
    busy: () => pending !== undefined,
    clear() {
      value = undefined
      at = null
    },
    set(next) {
      value = next
      at = now()
    },
  }
}

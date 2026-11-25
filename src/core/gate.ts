/**
 * The per-account concurrency gate, written once for every vendor.
 *
 * Why it exists: the desktop clients this plugin borrows identities from run
 * their own calls **sequentially** — the Raccoon desktop client even caps its
 * local relay at two in-flight upstream requests (`dist/electron/main.cjs`
 * `upstreams.size >= 2 → 429`) — while a harness drives many calls at once
 * (agent loop, subagents, background summaries). Eight plugin accounts were all
 * flagged with the upstream risk control (`429 code 200108
 * 「异常调用」`) within ninety seconds on 2026-11-23; the shared fingerprint was
 * one part of it, but the call rate was the trigger. The gate makes this plugin
 * spend an account at the shape the upstream already tolerates: queue instead
 * of fire.
 *
 * The gate is a plain FIFO semaphore per key (the stored-account id). A held
 * slot is released by the provider runtime when the stream that acquired it
 * finishes, throws or is aborted — see `core/provider.ts`. `limit() <= 0`
 * means "no gate": acquire returns a no-op release.
 *
 * @module dsh-connect-desktop/core/gate
 */

export interface ConcurrencyGate {
  /**
   * Take one slot for `key`, waiting for a free one when at the limit.
   *
   * Resolves with an **idempotent** release function: calling it twice (or
   * after the call already failed) is harmless. Rejects with an `AbortError`
   * when `signal` fires before a slot frees up.
   */
  acquire(key: string, signal?: AbortSignal): Promise<() => void>
  /** Slots currently held, for one key or every key. */
  active(key?: string): number
  /** Calls currently queued, for one key or every key. */
  waiting(key?: string): number
  /** Keys that have live state (held slots or waiters). */
  keys(): readonly string[]
}

/** How the gate reads its limit; re-read on every acquire so a settings change applies at once. */
export interface GateOptions {
  limit: () => number
}

interface KeyState {
  active: number
  queue: Array<{
    resolve(release: () => void): void
    reject(error: Error): void
    signal?: AbortSignal
    onAbort?: () => void
  }>
}

function abortError(): Error {
  const error = new Error('concurrency gate acquire aborted')
  error.name = 'AbortError'
  return error
}

export function createConcurrencyGate(options: GateOptions): ConcurrencyGate {
  const states = new Map<string, KeyState>()
  const limit = (): number => {
    const value = options.limit()
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0
  }

  const stateFor = (key: string): KeyState => {
    let state = states.get(key)
    if (state === undefined) {
      state = { active: 0, queue: [] }
      states.set(key, state)
    }
    return state
  }

  const dropIfEmpty = (key: string, state: KeyState): void => {
    if (state.active === 0 && state.queue.length === 0) states.delete(key)
  }

  /** Hand freed slots to the longest-waiting acquirers, in order. */
  const pump = (key: string): void => {
    const state = states.get(key)
    if (state === undefined) return
    const cap = limit()
    while (state.queue.length > 0 && (cap === 0 || state.active < cap)) {
      const waiter = state.queue.shift()
      if (waiter === undefined) break
      if (waiter.signal?.aborted === true) {
        waiter.reject(abortError())
        continue
      }
      state.active += 1
      if (waiter.onAbort !== undefined) {
        // 拿到槽位后 signal 再 abort 与本次调用无关（也不该把槽位判给下一个）：
        // 摘掉监听，避免监听器挂在长生命周期 signal 上。
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.onAbort = undefined
      }
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        state.active -= 1
        dropIfEmpty(key, state)
        pump(key)
      })
    }
    dropIfEmpty(key, state)
  }

  return {
    acquire(key, signal) {
      if (signal?.aborted === true) return Promise.reject(abortError())
      const cap = limit()
      if (cap === 0) {
        // No gate configured: acquire is instant and the release is a no-op.
        return Promise.resolve(() => undefined)
      }
      return new Promise((resolve, reject) => {
        const state = stateFor(key)
        const waiter: KeyState['queue'][number] = { resolve, reject, signal }
        if (signal !== undefined) {
          waiter.onAbort = () => {
            const index = state.queue.indexOf(waiter)
            if (index >= 0) {
              state.queue.splice(index, 1)
              dropIfEmpty(key, state)
              reject(abortError())
            }
          }
          signal.addEventListener('abort', waiter.onAbort, { once: true })
        }
        state.queue.push(waiter)
        pump(key)
      })
    },

    active(key) {
      if (key !== undefined) return states.get(key)?.active ?? 0
      let total = 0
      for (const state of states.values()) total += state.active
      return total
    },

    waiting(key) {
      if (key !== undefined) return states.get(key)?.queue.length ?? 0
      let total = 0
      for (const state of states.values()) total += state.queue.length
      return total
    },

    keys() {
      return [...states.keys()]
    },
  }
}

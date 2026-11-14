/**
 * Minimal check harness shared by the independent verification scripts.
 *
 * Every script prints one `PASS`/`FAIL` line per check and a final summary; a
 * script exits non-zero as soon as any check failed. No framework, so the
 * evidence can be read straight out of the terminal transcript.
 *
 * @module dsh-connect-loomy/verify/checks
 */

/** One recorded check. */
export class CheckLog {
  constructor(label) {
    this.label = label
    this.results = []
    this.startedAt = Date.now()
  }

  /** Record a check that already ran; rethrow is decided by the caller. */
  record(name, ok, detail) {
    const entry = { name, ok: Boolean(ok), detail }
    this.results.push(entry)
    if (ok) {
      console.log(`PASS  ${name}`)
    } else {
      console.log(`FAIL  ${name}${detail === undefined ? '' : `\n      ${detail}`}`)
    }
    return entry
  }

  /**
   * Run one check. `fn` may be async; a throw becomes a FAIL. Returns whether
   * it passed so a script can stop early when the failure makes later checks
   * meaningless.
   */
  async run(name, fn) {
    try {
      const detail = await fn()
      this.record(name, true, undefined)
      return true
    } catch (error) {
      this.record(name, false, error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** Synchronous variant for pure assertions. */
  check(name, fn) {
    try {
      fn()
      this.record(name, true, undefined)
      return true
    } catch (error) {
      this.record(name, false, error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** Print the summary and return the process exit code. */
  finish() {
    const failed = this.results.filter((entry) => !entry.ok)
    const passed = this.results.length - failed.length
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1)
    console.log('')
    console.log(`== ${this.label}: ${passed}/${this.results.length} checks passed in ${seconds}s ==`)
    if (failed.length > 0) {
      console.log('FAILED CHECKS:')
      for (const entry of failed) console.log(`  - ${entry.name}`)
      return 1
    }
    return 0
  }
}

/** Assert helper: throw with a readable message instead of an opaque stack. */
export function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

/** Assert deep equality on JSON-able values with a readable diff. */
export function ensureEqual(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`)
}

/** Assert a string matches a regular expression. */
export function ensureMatch(value, regex, message) {
  if (typeof value !== 'string' || !regex.test(value)) {
    const shown = typeof value === 'string' ? (value.length > 120 ? `${value.slice(0, 117)}...` : value) : String(value)
    throw new Error(`${message}: ${JSON.stringify(shown)} does not match ${String(regex)}`)
  }
}

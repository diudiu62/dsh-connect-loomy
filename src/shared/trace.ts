/**
 * Per-request Loomy tracing headers.
 *
 * The upstream currently accepts missing/malformed tracing headers — the old
 * "missing traceparent hangs" report did not reproduce in the 0.9.39 evidence
 * run (docs/loomy-upstream.md §0.6) — but the desktop client always sends
 * them, they cost nothing, and a gateway change could start requiring them.
 * Correctness must never depend on them; they are defence, not authentication.
 *
 * `chatid` is session-scoped in the client, `msgid` is message/turn-scoped. We
 * mint both per request: the harness adapter gives us no stable Loomy session
 * id, and the upstream does not enforce the client's reuse rules. The one rule
 * that matters is that two different messages must not share a `msgid`, which
 * generating per dispatch guarantees.
 *
 * @module dsh-connect-loomy/shared/trace
 */

import { randomBytes, randomUUID } from 'node:crypto'

/** W3C traceparent: `00-<32 hex trace id>-<16 hex span id>-01`. */
export function newTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
}

/** Session id shape the client writes: `chat-<uuid>`. */
export function newChatId(): string {
  return `chat-${randomUUID()}`
}

/** Message id shape the client writes: `msg-<uuid>`. */
export function newMsgId(): string {
  return `msg-${randomUUID()}`
}

/** Validate a traceparent value (used by tests and doctor). */
export function isTraceparent(value: string): boolean {
  return /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(value)
}

/** Input for {@link buildTracingHeaders}. */
export interface TracingHeaderInput {
  /** `loomy-version` value. */
  version: string
  /** `invokeorigin` value; always `user` for harness traffic. */
  invokeOrigin?: string
}

/**
 * Build one dispatch's tracing headers.
 *
 * Called from `prepareHeaders` on every inference request, which the pi-ai
 * adapter invokes synchronously before SDK dispatch. Never throws: callers
 * must not fail a request because of a tracing nicety.
 */
export function buildTracingHeaders(input: TracingHeaderInput): Record<string, string> {
  return {
    traceparent: newTraceparent(),
    chatid: newChatId(),
    msgid: newMsgId(),
    'loomy-version': input.version,
    invokeorigin: input.invokeOrigin ?? 'user',
  }
}

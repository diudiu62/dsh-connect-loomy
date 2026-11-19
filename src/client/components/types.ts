/**
 * Shared UI state vocabulary: transport outcomes become renderable state here.
 *
 * `Loadable` mirrors `TransportResult` one-to-one, so no component ever inspects
 * an HTTP status code. The distinction that matters is preserved all the way to
 * the JSX: "this host serves no such route" is a capability answer (muted text),
 * while "the host said no" carries a message the user must read.
 *
 * @module dsh-connect-desktop/client/components/types
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TransportResult } from '../transport.js'
import type { CardLocaleKey, NS } from '../locale.js'

/** This plugin's namespace-bound translate function (the framework-injected `t`). */
export type CardT = TranslateNS<typeof NS>

/** A route read, rendered without losing the reason it has no data. */
export type Loadable<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  /** No route to call (404/503), or the network died. */
  | { kind: 'unavailable'; reason: 'missing_route' | 'network'; message: string }
  /** Host predates this client build (405): render "restart DSH". */
  | { kind: 'stale'; message: string }
  /** The host answered with an error envelope; `message` is the upstream's own text. */
  | { kind: 'failed'; code: string; message: string }

/** Convert a transport result into renderable state. */
export function mapResult<T>(result: TransportResult<T>): Loadable<T> {
  switch (result.kind) {
    case 'ok':
      return { kind: 'ready', value: result.value }
    case 'unavailable':
      return { kind: 'unavailable', reason: result.reason, message: result.message }
    case 'stale':
      return { kind: 'stale', message: result.message }
    case 'failed':
      return { kind: 'failed', code: result.code, message: result.message }
  }
}

/** The user-facing message for a loadable that cannot render data. */
export function loadableMessage(state: Loadable<unknown>, t: CardT): string {
  switch (state.kind) {
    case 'unavailable':
      return state.reason === 'network' ? t('errors.network', { message: state.message }) : t('errors.unavailable')
    case 'stale':
      return state.message
    case 'failed':
      return state.message.length > 0 ? state.message : t('common.unknownError')
    default:
      return t('common.loading')
  }
}

/** Whether a loadable carries a value. */
export function isReady<T>(state: Loadable<T>): state is { kind: 'ready'; value: T } {
  return state.kind === 'ready'
}

/**
 * The message for a loadable whose failure the user can retry.
 *
 * `unavailable` is separated because it is not a failure the retry button can
 * fix on its own — but the panel still needs one sentence, never a blank.
 */
export function failureMessage(state: Loadable<unknown>, t: CardT): string | null {
  if (state.kind === 'failed') return state.message
  if (state.kind === 'stale') return state.message
  if (state.kind === 'unavailable') return loadableMessage(state, t)
  return null
}

/** A locale key of this dictionary (re-exported for callers building descriptors). */
export type { CardLocaleKey }

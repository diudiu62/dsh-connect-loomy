/**
 * Shared UI state vocabulary for the card's three tabs.
 *
 * `Loadable` mirrors the transport split in `api.ts` one-to-one, so a component
 * never has to inspect HTTP status codes: "missing route", "upstream said no"
 * and "network died" stay distinct all the way to the JSX.
 *
 * @module dsh-connect-loomy/client/components/types
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RouteResult } from '../api.js'

/** This plugin's namespace-bound translate function (the framework-injected `t`). */
export type LoomyT = TranslateNS<'settings.loomy'>

/** A route read, rendered without losing the reason it has no data. */
export type Loadable<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'unavailable' }
  /** Host predates this client build (405): render "restart DSH". */
  | { kind: 'stale'; message: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'error'; code: string; message: string }

/** Convert a transport result into renderable state. */
export function mapResult<T>(result: RouteResult<T>): Loadable<T> {
  switch (result.kind) {
    case 'ok':
      return { kind: 'ready', value: result.value }
    case 'unavailable':
      return { kind: 'unavailable' }
    case 'stale':
      return { kind: 'stale', message: result.message }
    case 'failed':
      return { kind: 'failed', code: result.code, message: result.message }
    case 'error':
      return { kind: 'error', code: result.code, message: result.message }
  }
}

/** Whether a loadable carries a value. */
export function isReady<T>(state: Loadable<T>): state is { kind: 'ready'; value: T } {
  return state.kind === 'ready'
}

/** The user-facing message for a loadable that cannot render data. */
export function loadableMessage(state: Loadable<unknown>, t: LoomyT): string {
  switch (state.kind) {
    case 'unavailable':
      return t('errors.unavailable')
    case 'stale':
      return state.message
    case 'failed':
    case 'error':
      return state.message.length > 0 ? state.message : t('common.unknownError')
    default:
      return t('common.loading')
  }
}

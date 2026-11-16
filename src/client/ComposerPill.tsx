/**
 * The composer credit readout: `Loomy · 40,496`, rendered in
 * `conversation.input.left` — the left tool cluster of the composer.
 *
 * WHY IT IS GATED ON THE SELECTED MODEL. The number is one provider's credit
 * balance, so it must appear only while this session is actually using that
 * provider; a Loomy balance next to a WorkBuddy or DeepSeek model would be a
 * reading about a system the user is not talking to. The host exposes the
 * selection through `useProjection('modelSelection')`, whose snapshot carries
 * `next ?? lastUsed` — the same two fields the host's own composer reads, so
 * the readout follows a model switch without any event of our own.
 *
 * WHY THE FETCH LIVES HERE BUT THE CACHE DOES NOT. The host already caches
 * `/credits` for 60s with single-flight, so the pill does not carry a second
 * TTL: a re-render must not become an upstream request, and N tabs must not
 * become N requests. The component only re-reads when it mounts, when the
 * session switches to a different model, or when the user clicks it.
 *
 * A failure renders nothing rather than a fake zero — an unreadable balance is
 * not a balance of zero, and the settings card's diagnostics tab is where the
 * upstream's own error text lives.
 *
 * @module dsh-connect-loomy/client/ComposerPill
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  describeError,
  fetchAccounts,
  fetchCredits,
  fetchStatus,
  isAbortError,
  type LoomyCredits,
} from './api.js'
import { formatCount } from './format.js'
import { ensureStyles } from './styles.js'
import { AccountDrawer } from './components/AccountDrawer.js'
import type { LoomyT } from './components/types.js'

/** The provider route this pill reports on. */
/** Every route this plugin owns: `loomy`, `loomy-2`, … */
function isLoomyRoute(provider: string | undefined): boolean {
  if (provider === undefined) return false
  // `loomy` (slot 1), `loomy-2`, … and the rotation pool `loomy-pool`.
  return provider === 'loomy' || provider === 'loomy-pool' || /^loomy-\d+$/u.test(provider)
}

/** Minimal shape of the host's `modelSelection` projection snapshot. */
interface ModelSelectionSnapshot {
  readonly next?: { readonly provider?: string }
  readonly lastUsed?: { readonly provider?: string }
}

/**
 * Props the host hands every slot component. `useProjection` is framework
 * infrastructure, not something this plugin injects, which is why the
 * component tolerates its absence (older hosts, and the jsdom harness).
 */
export interface LoomyComposerPillProps {
  readonly t?: LoomyT
  readonly useProjection?: (
    name: 'modelSelection',
  ) => ModelSelectionSnapshot | undefined
}

/** The provider this session's composer would send to, if the host says so. */
export function selectedProviderOf(projection: ModelSelectionSnapshot | undefined): string | undefined {
  const provider = (projection?.next ?? projection?.lastUsed)?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/**
 * Credit readout for sessions on the Loomy route.
 *
 * Renders `null` for every other provider, so the composer stays clean and no
 * request is ever made on another provider's behalf.
 */
export function LoomyComposerPill({ t, useProjection }: LoomyComposerPillProps) {
  const projection = useProjection?.('modelSelection')
  const provider = selectedProviderOf(projection)
  const owns = isLoomyRoute(provider)

  const [credits, setCredits] = useState<LoomyCredits | null>(null)
  const [routeName, setRouteName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [creditsByRoute, setCreditsByRoute] = useState<Map<string, { available: number; error?: string }>>(new Map())
  const inFlight = useRef<AbortController | null>(null)

  const load = useCallback(
    (signal: AbortSignal, route: string) => {
      // The route id is internal; the picker names each group after the account,
      // so the badge reads the same word the user just selected.
      fetchStatus({ signal })
        .then((result) => {
          if (result.kind === 'ok') setCsrfToken(result.value.csrfToken ?? null)
        })
        .catch(() => {
          // Without a token the drawer opens read-only; switching is disabled.
        })
      fetchAccounts({ signal })
        .then((result) => {
          if (result.kind !== 'ok') return
          const entry = (result.value.routes ?? []).find((candidate) => candidate.route === route)
          if (entry !== undefined) setRouteName(entry.displayName)
        })
        .catch(() => {
          // Naming the account is a nicety; the figure below still renders.
        })
      fetchCredits({ signal })
        .then((result) => {
          // `unavailable` means this host serves no credits route (the host half
          // is disabled or not restarted). Stay silent: the settings card is
          // where that condition is explained.
          if (result.kind !== 'ok') return
          setCredits(result.value)
          const map = new Map<string, { available: number; error?: string }>()
          for (const entry of result.value.perAccount ?? []) {
            map.set(entry.route, {
              available: entry.availableBalance,
              ...(entry.error === undefined ? {} : { error: entry.error }),
            })
          }
          setCreditsByRoute(map)
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return
          // Deliberately no state change: an unreadable balance must not become
          // a rendered zero, and the card surfaces the upstream error text.
          console.warn('[dsh-connect-loomy] composer credits readout failed:', describeError(error))
        })
    },
    [],
  )

  useEffect(() => {
    // Another provider's session never subscribes: gating here (not inside the
    // render) is what keeps the fetch count at zero while Loomy is not selected.
    if (!owns || provider === undefined) return undefined
    ensureStyles()
    const controller = new AbortController()
    load(controller.signal, provider)
    return () => controller.abort()
  }, [owns, provider, load])

  const openDrawer = useCallback(() => {
    if (!owns) return
    setOpen((previous) => !previous)
  }, [owns])

  const refresh = useCallback(() => {
    if (!owns || busy || provider === undefined) return
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(true)
    fetchCredits({ signal: controller.signal })
      .then((result) => {
        if (result.kind === 'ok') setCredits(result.value)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        console.warn('[dsh-connect-loomy] composer credits refresh failed:', describeError(error))
      })
      .finally(() => {
        if (inFlight.current === controller) {
          inFlight.current = null
          setBusy(false)
        }
      })
  }, [busy, owns, provider])

  useEffect(() => () => inFlight.current?.abort(), [])

  // The badge's job is to say WHERE this session's model comes from; the number
  // is secondary. So an unread balance degrades to the bare route name instead
  // of hiding the readout entirely — a silent disappearance would look exactly
  // like "the plugin is not installed", which is the opposite of informative.
  if (!owns) return null

  // The badge must always say *whose* number it is showing. Until the account
  // list resolves, "Loomy" stands in for the account name rather than dropping
  // it — a bare figure with no source is the thing this badge exists to avoid.
  // The pool's own name is a sentence ("随机分配（2 个账号）"); the badge is 24px
  // tall, so it gets the short form and leaves the long name to the picker.
  const account =
    provider === 'loomy-pool'
      ? (t?.('composer.pillPool') ?? 'Pool')
      : (routeName ?? (t?.('composer.pillBare') ?? 'Loomy'))
  // This route's own points, when the host reports a split; otherwise the
  // aggregate, which is all a single-account host can know.
  const own = credits?.perAccount?.find((entry) => entry.route === provider)
  const amount = own === undefined ? credits?.availableBalance : own.availableBalance

  const label =
    amount === undefined
      ? account
      : (t?.('composer.pill', { account, amount: formatCount(amount) }) ?? `${account} · ${formatCount(amount)}`)
  // The pill's own number is `availableBalance`; the tooltip spells out the two
  // buckets it adds up, so a session never shows one figure here and a
  // differently-labelled second one on hover.
  const title =
    credits === null
      ? (t?.('composer.pillPending') ?? 'Loomy credits are still loading. Click to refresh.')
      : t?.('composer.pillTitle', {
      available: formatCount(credits.availableBalance),
      balance: formatCount(credits.balance),
      daily: formatCount(credits.dailyBalance),
      }) ??
      `Loomy credits — available ${formatCount(credits.availableBalance)} (monthly ${formatCount(credits.balance)} + today ${formatCount(credits.dailyBalance)})`

  return (
    <span className="loomy-pill-anchor">
      <button
        type="button"
        className={`loomy-pill${busy ? ' loomy-pill-busy' : ''}${open ? ' loomy-pill-open' : ''}`}
        onClick={openDrawer}
        title={title}
        aria-label={t?.('drawer.open') ?? label}
        aria-expanded={open}
        data-provider={provider}
      >
        {label}
      </button>
      {open ? (
        <AccountDrawer
          t={t as never}
          csrfToken={csrfToken}
          creditsByRoute={creditsByRoute}
          onClose={() => setOpen(false)}
          onChanged={() => {
            if (provider !== undefined) load(new AbortController().signal, provider)
          }}
        />
      ) : null}
    </span>
  )
}

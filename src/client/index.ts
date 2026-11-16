/**
 * dsh-connect-loomy — browser half.
 *
 * Runs inside the DSH web client's module loader (`lib/client.js` is a
 * `window.__ModuleLoader__.load({...})` CJS factory, see
 * `docs/dsh-plugin-contract.md` §5). It contributes exactly one thing to the
 * host UI: a tab inside **Settings → Plugins** (`settings.plugins.tab`) that
 * renders the Loomy account / models / diagnostics card.
 *
 * `inject` stays `['locale']` on purpose: the slot registry is requested with
 * `ctx.inject(['slots'], …)`, which is the cordis idiom for "run this once the
 * service appears" and keeps the registration tied to this plugin's fiber. That
 * also means a composition that never provides `slots` (headless boot, the
 * unit-test harness) loads this plugin without an error — the card simply never
 * registers.
 *
 * The browser half holds no credentials: every upstream fact arrives through
 * `/plugins/dsh-connect-loomy/*` and the card only renders masked fields.
 *
 * @module dsh-connect-loomy/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: they apply the `ctx.locale` / `ctx.slots` module
// augmentations and the `settings.plugins.tab` slot declaration. Erased at
// build time, so the bundle never requires these packages at runtime.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Declares `conversation.input.right`, the composer list slot this plugin adds a
// credit readout to. Type-only: erased at build time.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LoomyComposerPill } from './ComposerPill.js'
import { LoomySettingsCard } from './components/Card.js'
import type { LoomyT } from './components/types.js'
import { NS, en, zh } from './locale.js'

/** Browser services this plugin needs before `apply` runs. */
export const inject = ['locale']

/** Settings-tab identity inside the Plugins section. */
export const SETTINGS_TAB_ID = 'loomy'

/** Bumped when the client half's shape changes; printed at mount. */
export const CLIENT_BUILD_MARKER = 'settings-section+pill-near-model-v3+login-v4'

/** Slot-entry identity of the composer credit readout. */
export const COMPOSER_PILL_ID = 'dsh-connect-loomy-composer-pill'

/**
 * Register the settings tab against a context that provides `slots`.
 *
 * Extracted so the `ctx.inject` callback and the direct fallback share one
 * implementation. Registration failures are contained here: the host settings
 * page must keep working even if this plugin's tab cannot mount.
 */
function registerSettingsTab(ctx: Context, t: LoomyT): void {
  // `Partial` keeps this defensive read honest for harness compositions that
  // provide no slot registry at all.
  const slots = (ctx as Partial<Context>).slots
  if (slots === undefined) return
  try {
    slots.inject('settings.section', () =>
      slots.register(
        {
          // `settings.section` puts this page in the settings **sidebar**, beside
          // Account / Models / Plugins — the same seat the rest of the family
          // uses. `settings.plugins.tab` would nest it inside the plugin list
          // instead, where a user looking for a model route would not find it.
          name: 'settings.section',
          id: SETTINGS_TAB_ID,
          order: 35,
          label: () => t('tab.label'),
          locale: NS,
          inject: () => ({ surface: 'settings' }),
        },
        LoomySettingsCard,
      ),
    )
  } catch (error) {
    // Never rethrow: a failed tab must not block the surrounding settings page.
    console.error('[dsh-connect-loomy] settings tab registration failed (settings page unaffected):', error)
  }
}

/**
 * Register the composer credit readout.
 *
 * `conversation.input.right` is the composer list slot rendered immediately
 * before the model picker, so the entry appears as
 * `Loomy · <balance>` there and disappears the moment the session switches to
 * another provider. The component gates on the selected provider itself; registering
 * unconditionally is what makes a later model switch show up without this
 * plugin listening for events.
 *
 * Failures are contained for the same reason as the settings tab: a slot this
 * plugin cannot mount must not disturb the composer it lives in.
 */
function registerComposerPill(ctx: Context, t: LoomyT): void {
  const slots = (ctx as Partial<Context>).slots
  if (slots === undefined) return
  try {
    slots.inject('conversation.input.right', () =>
      slots.register(
        {
          // `conversation.input.right` renders immediately BEFORE the model
          // picker, which is where the readout belongs: the badge names the
          // source of the model shown next to it. It must stay narrow — the
          // right cluster is `flex:none`, and the host swaps the model's text
          // for an icon past its 560px container breakpoint, so a wide badge
          // would hide the very name it annotates. Hence the compact form.
          name: 'conversation.input.right',
          id: COMPOSER_PILL_ID,
          order: 4,
          locale: NS,
          // The framework supplies `useProjection`/`sessionId` to the component
          // itself; `inject` adds this plugin's own props beside them. Wrapping
          // the component in a closure instead (the first attempt) dropped the
          // framework props, so the pill could never see the selected provider
          // and silently rendered nothing.
          inject: () => ({ t }),
        },
        LoomyComposerPill,
      ),
    )
  } catch (error) {
    console.error('[dsh-connect-loomy] composer readout registration failed (composer unaffected):', error)
  }
}

/**
 * Mount the browser half.
 *
 * @param ctx - browser plugin context with `locale` available.
 */
export function apply(ctx: Context): void {
  // `ctx.effect` ties the registration to this plugin's fiber, so a hot reload
  // removes the dictionaries instead of throwing on a duplicate namespace.
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-connect-loomy: locale')
  const t = ctx.locale.bind(NS)

  // One line at mount, so "which build is the browser running?" is answerable
  // from the console. A client bundle is read by the host at boot: rebuilding
  // `lib/client.js` does nothing until DSH itself restarts, and a browser
  // refresh alone can leave a stale bundle running with no visible symptom.
  console.info(
    `[dsh-connect-loomy] client half loaded (${CLIENT_BUILD_MARKER}): settings.section + composer readout`,
  )

  // Prefer the cordis service-gated path: `slots` may arrive after this plugin
  // (the Plugins section itself is such a plugin). The direct call covers
  // compositions — and the jsdom harness — where `slots` is already present but
  // `ctx.inject` is not part of the surface.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['slots'], (scoped) => {
      registerSettingsTab(scoped, t)
      registerComposerPill(scoped, t)
    })
    return
  }
  registerSettingsTab(ctx, t)
  registerComposerPill(ctx, t)
}

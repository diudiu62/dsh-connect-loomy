/**
 * Capabilities in, tabs out — the whole point of the client refactor.
 *
 * This is a pure function on purpose. The card shell must not know that a
 * vendor exists: it calls `tabsFor(vendor.capabilities)` and renders whatever
 * comes back. A third vendor therefore gets its tabs by *declaring* them, and
 * `tests/client/tabs.test.mjs` can pin every combination without a DOM.
 *
 * The rules encoded here are the only vendor-shaped decisions left in the
 * client, and each one is derived from the declaration rather than a name:
 *
 * - **account** — somewhere to show "who is paying": accounts to list, a login
 *   to run, or credits to read. A vendor that declares none of those has no
 *   account surface even though the tab exists in this file;
 * - **models** — only when `catalog.selection` is set, because that is the
 *   capability that registers `/catalog`, `/refresh` and `/save`;
 * - **config** — always: the host can always describe its own config slice, and the
 *   card is the only place to edit it (`auto: false` disables DSH's own form);
 * - **diagnostics** — only when `/diagnostics` is registered.
 *
 * @module dsh-connect-desktop/client/capability/tabs
 */

import type { VendorCapabilities } from '../../shared/views.js'
import type { CardLocaleKey } from '../locale.js'

/** Selectable card sections. */
export type TabKey = 'account' | 'models' | 'config' | 'diagnostics'

/** One tab the card may render. `labelKey` always points into this plugin's dictionary. */
export interface TabDescriptor {
  key: TabKey
  labelKey: CardLocaleKey
}

/** Login methods that put a form on screen. `none` means "borrow the desktop session". */
function hasLoginForm(capabilities: VendorCapabilities): boolean {
  return capabilities.login.includes('sms-code') || capabilities.login.includes('password')
}

/** Whether the account surface has anything to say for this vendor. */
export function hasAccountSurface(capabilities: VendorCapabilities): boolean {
  return capabilities.accounts !== 'none' || capabilities.credits.kind !== 'none' || hasLoginForm(capabilities)
}

/**
 * Every tab this vendor's declaration justifies, in display order.
 *
 * Order is fixed (account → models → diagnostics) rather than declared: it is
 * the order a user needs them in, and a vendor has no business reordering the
 * card's information architecture.
 */
export function tabsFor(capabilities: VendorCapabilities): TabDescriptor[] {
  const tabs: TabDescriptor[] = []
  if (hasAccountSurface(capabilities)) tabs.push({ key: 'account', labelKey: 'tabs.account' })
  if (capabilities.catalog.selection) tabs.push({ key: 'models', labelKey: 'tabs.models' })
  // 配置总是存在：宿主永远可以提供它的配置片（auto:false 之后卡片是唯一条目）。
  tabs.push({ key: 'config', labelKey: 'tabs.config' })
  if (capabilities.diagnostics) tabs.push({ key: 'diagnostics', labelKey: 'tabs.diagnostics' })
  return tabs
}

/**
 * Which tab to show for a given selection.
 *
 * A capability can disappear between reads (a vendor switched off, a host
 * restarted with a narrower route table), so an unknown/vanished selection falls
 * back to the first available tab instead of rendering an empty panel.
 */
export function resolveTab(tabs: readonly TabDescriptor[], wanted: TabKey | null): TabDescriptor | null {
  if (tabs.length === 0) return null
  const match = tabs.find((entry) => entry.key === wanted)
  return match ?? tabs[0] ?? null
}

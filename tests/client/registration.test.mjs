/**
 * Slot registration lifecycle: the card must mount into the Plugins settings
 * tab, come off cleanly, and leave the rest of the settings page alone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  button,
  click,
  defaultRoutes,
  installFetch,
  loadClient,
  mountPlugin,
  renderCard,
  setupDom,
  window as domWindow,
} from './helpers.mjs'

test('bundle keeps the loader contract and locale-only cordis inject', () => {
  const exports = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['locale'])
  // 常量不带供应商名：卡片服务所有供应商。
  assert.equal(exports.SETTINGS_TAB_ID, 'desktop-models')
})

test('the sidebar glyph pairs with the section id and renders a brand mark', async () => {
  const { harness, entry } = mountPlugin()
  const iconEntry = harness.entries.find((candidate) => candidate.options.name === 'settings.section.icon')

  assert.ok(iconEntry, 'a settings.section.icon entry is registered')
  // The shell pairs icon and section BY ID. A different id is not an error — it
  // silently falls back to the generic gear, which is the failure mode worth
  // pinning here.
  assert.equal(iconEntry.options.id, entry.options.id, 'icon id must equal the section id')
  assert.equal(iconEntry.options.id, 'desktop-models', '与 SETTINGS_TAB_ID 一致，且不带供应商名')
  assert.equal(typeof iconEntry.component, 'function')

  await setupDom()
  const React = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const markup = renderToStaticMarkup(React.createElement(iconEntry.component, { size: 16, active: false }))
  assert.ok(markup.startsWith('<svg'), 'the glyph is an inline vector, not a raster <img>')
  assert.ok(markup.includes('aria-hidden="true"'), 'decorative: the row label is the accessible name')
  assert.ok(markup.includes('viewBox="0 0 128 128"'), 'traced on the app-icon grid')
  assert.ok(markup.includes('#344DFD'), 'brand blue')
  assert.ok(markup.includes('#37E1BE'), 'brand teal dot')
})


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
  assert.equal(exports.SETTINGS_TAB_ID, 'loomy')
})

test('apply registers one settings.section entry with locale-bound copy', () => {
  const { harness, entry } = mountPlugin()

  assert.equal(harness.localeRegistrations.length, 1)
  assert.equal(harness.localeRegistrations[0].ns, 'settings.loomy')
  assert.deepEqual(
    Object.keys(harness.localeRegistrations[0].dicts.zh).sort(),
    Object.keys(harness.localeRegistrations[0].dicts.en).sort(),
    'zh and en must carry identical key sets',
  )

  assert.equal(entry.options.name, 'settings.section')
  assert.equal(entry.options.id, 'loomy')
  assert.equal(entry.options.order, 35)
  assert.equal(entry.options.locale, 'settings.loomy')
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(entry.options.label(), 'Loomy')

  // A disposal removes the contribution: no stale tab survives an unload.
  // The composer readout is a separate registration and must survive it.
  const { dispose } = entry
  dispose()
  assert.equal(
    harness.entries.filter((candidate) => candidate.options.name === 'settings.section').length,
    0,
  )
  assert.equal(
    harness.entries.filter((candidate) => candidate.options.name === 'conversation.input.right').length,
    1,
  )
  assert.equal(harness.effects.length, 1)
})

test('the card mounts and unmounts without touching the surrounding page', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()

  await renderCard(entry, t, ({ container }) => {
    assert.ok(container.querySelector('.loomy-card'), 'the card renders its root node')
    assert.ok(container.textContent.includes('Loomy'))
  })

  // renderCard unmounted the React root; the document is left as it was.
  assert.equal(domWindow().document.body.querySelector('.loomy-card'), null)
})

test('a slot registry failure is contained: apply neither throws nor leaks the error', () => {
  const exports = loadClient()
  const locales = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register(ns) {
        locales.push(ns)
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    inject(deps, callback) {
      return callback(ctx)
    },
    slots: {
      inject() {
        throw new Error('slot declaration exploded')
      },
    },
  }
  const originalError = console.error
  const logged = []
  console.error = (...args) => logged.push(args)
  try {
    assert.doesNotThrow(() => exports.apply(ctx))
  } finally {
    console.error = originalError
  }
  assert.deepEqual(locales, ['settings.loomy'])
  // Two independent slot registrations (settings tab + composer readout). Each
  // contains its own failure, so a broken registry costs one diagnostic line
  // apiece and still does not throw out of `apply`.
  assert.equal(logged.length, 2, 'one diagnostic line per slot, no rethrow')
})

test('a render failure stays inside the card instead of breaking the settings page', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  // The hostile translate seat fails only for a key rendered *inside* the
  // boundary (the tablist aria-label), so the shell mounts and the boundary
  // must own the failure.
  const hostileT = (key, params) => {
    if (key === 'tabs.aria') throw new Error('translate seat exploded')
    return t(key, params)
  }

  await assert.doesNotReject(
    renderCard(entry, hostileT, async ({ container }) => {
      assert.ok(container.textContent.includes('Loomy 设置卡片渲染失败；宿主其余设置不受影响。'))
    }),
  )
})

test('the same card speaks English when the locale face switches', async () => {
  await setupDom()
  const { entry, t } = mountPlugin('en')
  installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    const text = container.textContent
    assert.ok(text.includes('Account'))
    assert.ok(text.includes('Models'))
    assert.ok(text.includes('Diagnostics'))
    assert.ok(text.includes('Signed in'))
    assert.ok(text.includes('Read-only credits overview'))
    assert.ok(!text.includes('本机登录态'))

    // The login form is deliberately collapsed behind "Add account"; open it to
    // prove the English face reaches the form too.
    await click(button(container, 'New account'))
    const phoneInput = container.querySelector('input[type="tel"]')
    assert.ok(phoneInput, 'the login form opened')
    assert.equal(phoneInput.getAttribute('placeholder'), 'Phone number', 'the form is in English too')
  })
})

test('the composer readout registers the real component with an inject face', async () => {
  const { composerEntry } = mountPlugin()

  assert.ok(composerEntry, 'a conversation.input.right entry is registered')
  assert.equal(composerEntry.options.id, 'dsh-connect-loomy-composer-pill')
  assert.equal(composerEntry.options.order, 4)
  assert.equal(composerEntry.options.locale, 'settings.loomy')

  // REGRESSION: the component must be registered *itself*. Wrapping it in a
  // closure (the original implementation) spawns a component that receives
  // none of the framework props, so `useProjection` is undefined, the selected
  // provider can never be read, and the pill silently renders nothing — a
  // failure with no error and no log.
  assert.equal(typeof composerEntry.component, 'function')
  assert.equal(
    composerEntry.component.name,
    'LoomyComposerPill',
    'the slot must receive the component itself, not a wrapper that drops framework props',
  )

  // Plugin-specific props arrive through `inject`, beside the framework's.
  assert.equal(typeof composerEntry.options.inject, 'function')
  const injected = composerEntry.options.inject()
  assert.equal(typeof injected.t, 'function')
  assert.equal(injected.t('composer.pill', { amount: '1' }), 'Loomy · 1')
})

test('the composer readout only appears for the loomy provider', async () => {
  const { composerEntry, t } = mountPlugin()
  installFetch(defaultRoutes())

  const renderWith = (provider) =>
    renderCard(
      composerEntry,
      t,
      ({ container }) => container.querySelector('[data-provider="loomy"]'),
      { useProjection: () => ({ next: { provider } }) },
    )

  // Another provider's session must render nothing: the number belongs to
  // Loomy and would be a reading about a system this session is not using.
  assert.equal(await renderWith('deepseek-account'), null)
  assert.equal(await renderWith(undefined), null)

  // The loomy session renders the readout, labelled with the route name.
  const pill = await renderWith('loomy')
  assert.ok(pill, 'a session on the loomy route gets the readout')
  assert.match(pill.textContent ?? '', /^Loomy · /u)
  assert.ok((pill.getAttribute('title') ?? '').includes('Loomy'))
})

test('the composer readout still names the source when the balance is unreadable', async () => {
  const { composerEntry, t } = mountPlugin()
  // The credits route fails; the badge must still identify the route rather
  // than vanish (a silent disappearance is indistinguishable from "not
  // installed", which is the least useful possible outcome).
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-loomy/credits': {
        status: 500,
        body: { ok: false, error: { code: 'upstream_error', message: 'boom' } },
      },
    }),
  )

  const pill = await renderCard(
    composerEntry,
    t,
    ({ container }) => container.querySelector('[data-provider="loomy"]'),
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )

  assert.ok(pill, 'the badge survives an unreadable balance')
  assert.equal(pill.textContent?.trim(), 'Loomy')
})

test('the settings section omits its own title because the shell draws the panel chrome', async () => {
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  // The framework hands a settings section this flag through `inject`.
  const surface = entry.options.inject()
  assert.equal(surface.surface, 'settings')

  const titles = await renderCard(
    entry,
    t,
    ({ container }) => [...container.querySelectorAll('.loomy-title')].map((node) => node.textContent),
    surface,
  )
  assert.deepEqual(titles, [], 'a settings section must not repeat the page title the shell already prints')

  // The explanatory subtitle survives: it is the "what this page is" line, and
  // the shell has nothing to say about it.
  await renderCard(
    entry,
    t,
    ({ container }) => {
      assert.ok(container.querySelector('.loomy-subtitle'))
    },
    surface,
  )
})

test('every accepted paste is normalized to one canonical bundle before it is sent', () => {
  const { normalizeImportDocument } = loadClient()
  assert.equal(typeof normalizeImportDocument, 'function')

  const raw = { session: 'b19824de45524cc59cf419bb800ae12f', userid: '261113195919807686', phone: '17166422065' }
  const fromRaw = normalizeImportDocument(raw)
  assert.equal(fromRaw.kind, 'dsh-connect-loomy/accounts')
  assert.equal(fromRaw.version, 1)
  assert.equal(fromRaw.accounts.length, 1)
  assert.equal(fromRaw.accounts[0].session, raw.session)
  assert.equal(fromRaw.accounts[0].phone, raw.phone, 'the lowercase userid is mapped to userId')
  assert.equal(fromRaw.accounts[0].userId, raw.userid)

  // The reported paste, which carries a masked phone from an earlier export.
  const masked = normalizeImportDocument({
    kind: 'dsh-connect-loomy/accounts',
    version: 1,
    exportedAt: 1794809822224,
    accounts: [{ slot: 1, session: '6850e7f2fd6541aa8a5f2deeb889d344', phone: '189****2700', userId: '261113120739987535', addedAt: 1794809814418 }],
  })
  assert.equal(masked.kind, 'dsh-connect-loomy/accounts', 'a canonical bundle is passed through untouched')

  // An array and an unmarked wrapper reach the same shape.
  const fromArray = normalizeImportDocument([raw, { session: 'c'.repeat(32) }])
  assert.equal(fromArray.accounts.length, 2)
  const fromWrapper = normalizeImportDocument({ accounts: [raw] })
  assert.equal(fromWrapper.accounts.length, 1)

  // A masked phone never survives as an identifier.
  const maskedOnly = normalizeImportDocument({ session: 'd'.repeat(32), phone: '189****2700' })
  assert.equal(maskedOnly.accounts[0].phone, undefined, 'a masked phone is not a phone')
  assert.equal(maskedOnly.accounts[0].label, '189****2700', 'it is kept as a label instead')
})

test('add-account actions live in the accounts section toolbar', async () => {
  await setupDom()
  const { entry, t } = mountPlugin('zh')
  installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    // No separate 添加账号 section heading...
    const headings = [...container.querySelectorAll('.loomy-section-title')].map((node) => node.textContent)
    assert.equal(headings.filter((text) => text === '添加账号').length, 0)

    // ...the actions sit in the accounts section's own toolbar, top-right.
    const section = [...container.querySelectorAll('.loomy-section')].find((node) =>
      node.textContent.includes('账号（'),
    )
    assert.ok(section, 'the accounts section renders')
    const toolbar = section.querySelector('.loomy-toolbar')
    const labels = [...toolbar.querySelectorAll('button')].map((node) => node.textContent)
    assert.ok(labels.includes('新增账号'), `toolbar holds the add action: ${JSON.stringify(labels)}`)
    assert.ok(labels.includes('导入 / 导出'))
    assert.ok(labels.includes('全部导出'))
    assert.ok(labels.includes('刷新'))

    // The form appears only once asked for, and inline under that toolbar.
    assert.equal(container.querySelector('.loomy-add-body'), null)
    await click(button(container, '新增账号'))
    const body = container.querySelector('.loomy-add-body')
    assert.ok(body, 'the login form expands')
    assert.ok(section.contains(body), 'inside the same section')
  })
})



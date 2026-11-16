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
    assert.ok(text.includes('Credits'))
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
  // The badge names the account first, then the figure: with several accounts a
  // bare number says nothing about whose points it is.
  assert.equal(injected.t('composer.pill', { account: '18912342700', amount: '1' }), '18912342700 · 1 积分')
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
    assert.ok(labels.includes('导入'), `toolbar holds the import action: ${JSON.stringify(labels)}`)
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



test('the composer badge opens an account drawer instead of relying on picker groups', async () => {
  await setupDom()
  const { composerEntry, t } = mountPlugin('zh')
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-loomy/accounts': {
        body: {
          ok: true,
          accounts: [
            { id: 'a1', slot: 1, route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '18912342700' },
            { id: 'a2', slot: 2, route: 'loomy-2', displayName: 'Loomy', origin: 'plugin', phone: '17166422065' },
          ],
          routes: [{ route: 'loomy', displayName: 'Loomy', origin: 'plugin', slot: 1 }],
        },
      },
      '/plugins/dsh-connect-loomy/accounts/active': { body: { ok: true, activeId: 'a1', rotating: false } },
      '/plugins/dsh-connect-loomy/pool': { body: { ok: true, enabled: false, accountCount: 2, active: false } },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(container.querySelector('.loomy-drawer'), null, 'closed by default')

      const pill = container.querySelector('.loomy-pill')
      assert.ok(pill, 'the badge renders')
      await click(pill)

      const drawer = container.querySelector('.loomy-drawer')
      assert.ok(drawer, 'clicking the badge opens the account drawer')
      // The drawer is where switching happens now: every account is a row.
      const rows = [...drawer.querySelectorAll('.loomy-drawer-row')].map((node) => node.textContent)
      assert.equal(rows.length, 2)
      assert.ok(rows[0].includes('18912342700'))
      assert.ok(rows[1].includes('17166422065'))
      // ...and the pool switch lives here, not in the settings card alone.
      assert.ok(drawer.textContent.includes('每次调用随机选一个健康账号'))
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

test('the badge stays short: Loomy plus the figure, sum when rotating', async () => {
  const render = async (rotating) => {
    await setupDom()
    const { composerEntry, t } = mountPlugin('zh')
    installFetch(
      defaultRoutes({
        '/plugins/dsh-connect-loomy/credits': {
          body: {
            ok: true,
            balance: 36700,
            dailyBalance: 5300,
            availableBalance: 42000,
            fetchedAt: 1,
            // The single route reports the active account's own points.
            perAccount: [
              { accountId: 'a1', route: 'loomy', account: '18912342700', balance: 35500, dailyBalance: 5000, availableBalance: 40500 },
            ],
            records: [],
          },
        },
        '/plugins/dsh-connect-loomy/accounts/active': { body: { ok: true, activeId: 'a1', rotating } },
      }),
    )
    return renderCard(
      composerEntry,
      t,
      async ({ container }) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return container.querySelector('.loomy-pill')?.textContent ?? ''
      },
      { useProjection: () => ({ next: { provider: 'loomy' } }) },
    )
  }

  // One account is paying, so its own balance is the honest number.
  assert.equal(await render(false), 'Loomy · 40,500 积分')
  // Any account may be charged next, so the badge shows what is left in total.
  assert.equal(await render(true), 'Loomy · 42,000 积分')
})

test('switching account in the drawer moves the badge figure', async () => {
  await setupDom()
  const { composerEntry, t } = mountPlugin('zh')

  let activeId = 'acc1'
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-loomy/credits': {
        body: {
          ok: true,
          balance: 44200,
          dailyBalance: 5300,
          availableBalance: 49500,
          fetchedAt: 1,
          // Two accounts behind ONE route: the badge must follow the account,
          // not the route id, or it would never move.
          perAccount: [
            { accountId: 'acc1', route: 'loomy', account: '18912342700', balance: 35500, dailyBalance: 5000, availableBalance: 40500 },
            { accountId: 'acc2', route: 'loomy', account: '17166422065', balance: 8700, dailyBalance: 300, availableBalance: 9000 },
          ],
          records: [],
        },
      },
      '/plugins/dsh-connect-loomy/accounts/active': (init) => {
        if (init?.method === 'POST') activeId = JSON.parse(init.body).id
        return new Response(JSON.stringify({ ok: true, activeId, rotating: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      '/plugins/dsh-connect-loomy/pool': { body: { ok: true, enabled: false, accountCount: 2, active: false } },
      '/plugins/dsh-connect-loomy/accounts': {
        body: {
          ok: true,
          accounts: [
            { id: 'acc1', slot: 1, route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '18912342700' },
            { id: 'acc2', slot: 2, route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '17166422065' },
          ],
          routes: [{ route: 'loomy', displayName: 'Loomy', origin: 'plugin', slot: 1 }],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      const badge = () => container.querySelector('.loomy-pill')?.textContent ?? ''
      assert.equal(badge(), 'Loomy · 40,500 积分', 'starts on the first account')

      await click(container.querySelector('.loomy-pill'))
      const rows = [...container.querySelectorAll('.loomy-drawer-row')]
      assert.equal(rows.length, 2)
      await click(rows[1])
      await new Promise((resolve) => setTimeout(resolve, 60))

      assert.equal(badge(), 'Loomy · 9,000 积分', 'the second account owns a different balance')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

test('the drawer refreshes the points, and bypasses the host cache when it does', async () => {
  await setupDom()
  const { composerEntry, t } = mountPlugin('zh')

  let available = 40500
  const calls = installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-loomy/credits': () => {
        return new Response(
          JSON.stringify({
            ok: true,
            balance: available,
            dailyBalance: 0,
            availableBalance: available,
            fetchedAt: 1,
            perAccount: [{ accountId: 'acc1', route: 'loomy', account: '18912342700', availableBalance: available, balance: available, dailyBalance: 0 }],
            records: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
      '/plugins/dsh-connect-loomy/accounts': {
        body: {
          ok: true,
          accounts: [{ id: 'acc1', slot: 1, route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '18912342700' }],
          routes: [{ route: 'loomy', displayName: 'Loomy', origin: 'plugin', slot: 1 }],
        },
      },
      '/plugins/dsh-connect-loomy/accounts/active': { body: { ok: true, activeId: 'acc1', rotating: false } },
      '/plugins/dsh-connect-loomy/pool': { body: { ok: true, enabled: false, accountCount: 1, active: false } },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await click(container.querySelector('.loomy-pill'))
      const drawer = container.querySelector('.loomy-drawer')
      assert.ok(drawer, 'drawer open')

      const before = calls.filter((call) => call.url.includes('/credits')).length
      available = 12345 // the upstream figure moved
      await click(drawer.querySelector('.loomy-drawer-refresh'))
      await new Promise((resolve) => setTimeout(resolve, 60))

      const after = calls
        .filter((call) => call.url.includes('/credits'))
        .slice(before)
        .map((call) => call.url)
      assert.ok(after.length >= 1, 'the button re-reads the points')
      assert.ok(
        after.some((url) => url.includes('force=1')),
        `a manual refresh must skip the host cache: ${JSON.stringify(after)}`,
      )
      assert.match(container.querySelector('.loomy-pill')?.textContent ?? '', /12,345/u, 'the badge shows the new figure')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

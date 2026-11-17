/**
 * The community entry in the settings card's top-right corner.
 *
 * It sits in the header (not a footer) so it is visible without scrolling, and
 * it renders in every state — including "the host exposed no routes" and "the
 * status read failed", which are the two moments a user needs a channel. It also
 * has to stay honest: an unfilled placeholder must never render as a group
 * number, neither as text nor inside the tooltip.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATUS, defaultRoutes, installFetch, mountPlugin, renderCard, setupDom } from './helpers.mjs'
import { DISCUSSIONS_URL, ISSUES_URL } from '../../lib/index.js'

const STATUS_URL = '/plugins/dsh-connect-loomy/status'

test('the community entry is pinned to the card header, top-right', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  await renderCard(entry, t, ({ container }) => {
    const header = container.querySelector('header.loomy-header')
    assert.ok(header !== null, 'the card renders a header')

    const community = header.querySelector('.loomy-community')
    assert.ok(community !== null, 'the community entry lives in the header')
    // Top-right: it is the header's last child, after the title/subtitle block.
    assert.equal(header.lastElementChild, community, 'the entry is the header\'s right-hand block')
    assert.ok(header.firstElementChild?.classList.contains('loomy-header-text'))

    // The old footer strip must be gone, not duplicated.
    assert.equal(container.querySelector('.loomy-footer'), null)
    assert.equal(container.querySelectorAll('.loomy-community').length, 1)

    const text = community.textContent ?? ''
    assert.ok(text.includes('社群与反馈'), 'the entry is titled')
    assert.ok(text.includes('GitHub Issues'), 'Issues is labelled')
    assert.ok(text.includes('Discussions'), 'Discussions is labelled')

    const links = [...community.querySelectorAll('a')]
    assert.deepEqual(
      links.map((link) => link.getAttribute('href')),
      [ISSUES_URL, DISCUSSIONS_URL],
      'both GitHub channels link out, in order',
    )
    for (const link of links) {
      assert.equal(link.getAttribute('target'), '_blank')
      assert.ok((link.getAttribute('rel') ?? '').includes('noreferrer'), 'external links use rel=noreferrer')
    }
  })
})

test('the reporting hint moved into the tooltip, not lost', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  await renderCard(entry, t, ({ container }) => {
    const community = container.querySelector('.loomy-community')
    const title = community?.getAttribute('title') ?? ''
    assert.match(title, /诊断页可一键复制/u, 'the copy-a-report advice survives as a tooltip')
    assert.equal(community?.getAttribute('aria-label'), '社群与反馈', 'the nav is announced by name')
  })
})

test('placeholders never reach the DOM, tooltip included', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  await renderCard(entry, t, ({ container }) => {
    const html = container.querySelector('.loomy-community')?.outerHTML ?? ''
    assert.ok(!html.includes('[QQ_GROUP]'), 'the QQ placeholder is filtered out')
    assert.ok(!html.includes('[WECHAT_ID]'), 'the WeChat placeholder is filtered out')
    assert.ok(!html.includes('[EMAIL]'), 'the email placeholder is filtered out')
  })
})

test('a broken host still shows where to ask for help', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch({
    ...defaultRoutes(),
    [STATUS_URL]: { body: { ok: false, error: { code: 'boom', message: '路由挂了' } } },
  })

  await renderCard(entry, t, ({ container }) => {
    const community = container.querySelector('header.loomy-header .loomy-community')
    assert.ok(community !== null, 'an error state still carries the entry')
    assert.ok([...community.querySelectorAll('a')].some((link) => link.getAttribute('href') === ISSUES_URL))
  })
})

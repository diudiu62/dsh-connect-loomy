/**
 * Diagnostics tab: read-only fact table and the copyable issue-report block.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DIAGNOSTICS,
  STATUS,
  button,
  buttonsByText,
  click,
  defaultRoutes,
  installFetch,
  mountPlugin,
  renderCard,
  setupDom,
  stubClipboard,
  tab,
} from './helpers.mjs'

const DIAGNOSTICS_URL = '/plugins/dsh-connect-loomy/diagnostics'

async function openDiagnostics(container) {
  await click(tab(container, '诊断'))
}


/*
 * 诊断页的结构契约：四段 + 一个折叠。
 *
 * 这些断言不是"长得对不对"，而是三条实测过的可用性规则：
 * 1. 第一行就给结论（摘要），不必滚到底；
 * 2. 不再有重复标题（曾经有两个「凭据结论」）；
 * 3. 「最近错误」默认收起，别让 4 行事实占着版面。
 */
test('diagnostics leads with a verdict and folds the last error', async () => {
  const { buildStatus, defaultRoutes, installFetch, mountPlugin, renderCard, resetDom, tab } = await import('./helpers.mjs')
  await resetDom()
  const { entry, t } = mountPlugin('zh')

  const capabilities = {
    accounts: 'none',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: true,
  }
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities }) },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await tab(container, t('tabs.diagnostics')).dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))

    // 1. 摘要行在第一屏，并且回答了"探针几条可用"
    const summary = container.querySelector('[data-dcss-cap="diagnostics-summary"]')
    assert.ok(summary !== null, 'the summary row exists')
    assert.match(summary.textContent ?? '', /探针 \d+\/\d+ 可用/u)

    // 2. 标题不重复（凭据只出现一次）
    const titles = [...container.querySelectorAll('.dcss-section-title')].map((el) => el.textContent)
    assert.equal(new Set(titles).size, titles.length, `duplicate section titles: ${titles.join(' / ')}`)

    // 3. 最近错误是折叠的，且默认收起
    const details = container.querySelector('details[data-dcss-cap="last-error"]')
    assert.ok(details !== null, 'the last-error block is foldable')
    assert.equal(details.hasAttribute('open'), false, 'collapsed by default')
  })
})

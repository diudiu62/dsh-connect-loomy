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

test('diagnostics renders probes, upstream URLs, account, counters and the verbatim error', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openDiagnostics(container)
    const text = container.textContent

    assert.ok(text.includes('凭据候选路径'))
    assert.ok(text.includes('/Users/test/Library/Application Support/loomy/auth-session.json'))
    assert.ok(text.includes('/Users/test/.config/loomy/auth-session.json'))
    assert.ok(text.includes('可用'))
    assert.ok(text.includes('不可用'))
    assert.ok(text.includes('ENOENT'))

    assert.ok(text.includes('https://loomyad.xunfei.cn/api/v1'))
    assert.ok(text.includes('https://loomyad.xunfei.cn/api/v1/models'))
    assert.ok(text.includes('https://loomyad.xunfei.cn/api/v1/points/records'))

    assert.ok(text.includes('138****5678'))
    assert.ok(text.includes('3 条，启用 2 条'))
    assert.ok(text.includes('POST /api/v1/chat/completions'))
    assert.ok(text.includes('100002'))
    assert.ok(text.includes('缺少 token（上游原文，不得改写）'), 'upstream message is not translated')
  })
})

test('copy all writes one report with every fact and no credential material', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const writes = stubClipboard(true)
  installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openDiagnostics(container)
    await click(button(container, '复制全部'))

    assert.equal(writes.length, 1)
    const report = writes[0]

    assert.ok(report.includes('DSH Connect Loomy 诊断报告'))
    assert.ok(report.includes('/plugins/dsh-connect-loomy/status'))
    assert.ok(report.includes('/Users/test/Library/Application Support/loomy/auth-session.json'))
    assert.ok(report.includes('/Users/test/.config/loomy/auth-session.json'))
    assert.ok(report.includes('https://loomyad.xunfei.cn/api/v1/models'))
    assert.ok(report.includes('138****5678'))
    assert.ok(report.includes('3 条，启用 2 条'))
    assert.ok(report.includes('POST /api/v1/chat/completions'))
    assert.ok(report.includes('100002'))
    assert.ok(report.includes('缺少 token（上游原文，不得改写）'))
    assert.match(report, /生成时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)

    // Credential hygiene: nothing secret can ride along in an issue report.
    assert.ok(!report.includes('deadbeefdeadbeefdeadbeefdeadbeef'))
    assert.ok(!report.includes('13812345678'))
    assert.ok(!report.includes('userid-secret-42'))
    assert.ok(!report.includes('csrf-test-token'))

    assert.ok(container.textContent.includes('已复制'))
  })
})

test('copy failure is reported and leaves the facts on screen', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  stubClipboard(false)
  installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openDiagnostics(container)
    await click(button(container, '复制全部'))
    assert.ok(container.textContent.includes('复制失败，请手动选择文本复制。'))
    assert.ok(container.textContent.includes('https://loomyad.xunfei.cn/api/v1'))
  })
})

test('diagnostics route missing: explains 404/503 and hides its controls', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes({ [DIAGNOSTICS_URL]: { status: 404, body: { ok: false } } }))

  await renderCard(entry, t, async ({ container }) => {
    await openDiagnostics(container)
    assert.ok(container.textContent.includes('宿主未提供诊断路由。'))
    assert.equal(buttonsByText(container, '复制全部').length, 0)
    assert.equal(buttonsByText(container, '重新读取').length, 0)
  })
})

test('diagnostics transport failure is retryable', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  let attempts = 0
  installFetch(
    defaultRoutes({
      [DIAGNOSTICS_URL]: () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary reset')
        return new Response(JSON.stringify(DIAGNOSTICS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openDiagnostics(container)
    assert.ok(container.textContent.includes('temporary reset'))
    await click(button(container, '重新读取'))
    assert.ok(container.textContent.includes('https://loomyad.xunfei.cn/api/v1/models'))
  })
})

test('diagnostics falls back to /status lastError and live counters when omitted', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [DIAGNOSTICS_URL]: {
        body: {
          ...DIAGNOSTICS,
          catalog: { total: 9, enabled: 9 },
          lastError: undefined,
        },
      },
      '/plugins/dsh-connect-loomy/status': {
        body: {
          ...STATUS,
          catalog: { total: 4, enabled: 1, refreshedAt: null },
          lastError: {
            at: 1794574810000,
            path: 'GET /api/v1/models',
            code: '100001',
            message: 'status 侧记录的原文',
          },
        },
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openDiagnostics(container)
    assert.ok(container.textContent.includes('GET /api/v1/models'))
    assert.ok(container.textContent.includes('status 侧记录的原文'))
  })
})

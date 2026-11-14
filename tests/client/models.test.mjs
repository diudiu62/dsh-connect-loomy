/**
 * Models tab: catalog facts, per-model checkboxes, and the draft contract —
 * refresh never overwrites unsaved checks, only Save applies them, Discard
 * restores the host-confirmed selection.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CATALOG,
  STATUS,
  button,
  buttonsByText,
  click,
  defaultRoutes,
  installFetch,
  modelCheckboxes,
  mountPlugin,
  renderCard,
  setupDom,
  tab,
} from './helpers.mjs'

const REFRESH_URL = '/plugins/dsh-connect-loomy/refresh'
const SAVE_URL = '/plugins/dsh-connect-loomy/save'
const STATUS_URL = '/plugins/dsh-connect-loomy/status'

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function openModels(container) {
  await click(tab(container, '模型'))
}

test('models tab renders rate, context, max output, vision and reasoning efforts', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    const text = container.textContent

    assert.ok(text.includes('模型目录'))
    assert.ok(text.includes('Spark-X2.6 正式版(限时免费)(x0.0)'))
    assert.ok(text.includes('×0.0'), 'free model rate')
    assert.ok(text.includes('×2.0'), 'paid model rate')
    assert.ok(text.includes('×0.8'), 'fractional rate')
    assert.ok(text.includes('1,048,576'), 'context window')
    assert.ok(text.includes('384,000'), 'max output')
    assert.ok(text.includes('不支持'), 'vision=false is shown')
    assert.ok(text.includes('none · low · medium · high (默认 low)'), 'efforts + default')

    // The saved selection from /status drives the initial checks.
    const checkboxes = modelCheckboxes(container)
    assert.equal(checkboxes.length, 3)
    assert.deepEqual(
      checkboxes.map((box) => box.checked),
      [true, true, false],
    )
    assert.ok(text.includes('已选 2/3'))
    assert.ok(text.includes('与已保存的选择一致'))
  })
})

test('a toggle is a draft: it survives a tab switch and only Save posts it', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const calls = installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    const checkboxes = modelCheckboxes(container)

    await click(checkboxes[2])
    assert.equal(modelCheckboxes(container)[2].checked, true)
    assert.ok(container.textContent.includes('有未保存的修改'))
    assert.ok(container.textContent.includes('已选 3/3'))
    assert.equal(calls.filter((call) => call.url === SAVE_URL).length, 0, 'toggling must not POST')

    // Switching sections keeps the draft alive.
    await click(tab(container, '账号'))
    assert.ok(container.textContent.includes('只读积分概览'))
    await click(tab(container, '模型'))
    assert.equal(modelCheckboxes(container)[2].checked, true, 'draft survived the tab switch')
    assert.ok(container.textContent.includes('有未保存的修改'))
    assert.ok(!container.textContent.includes('已保存，模型选择器已更新。'))
  })
})

test('refreshing the catalog never overwrites unsaved checks; discard restores the baseline', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  let catalog = CATALOG
  installFetch(
    defaultRoutes({
      [REFRESH_URL]: () => response(catalog),
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    // Draft: only DeepSeek enabled (Spark unchecked, GLM checked).
    await click(modelCheckboxes(container)[0])
    await click(modelCheckboxes(container)[2])
    assert.ok(container.textContent.includes('已选 2/3'))

    // The host now reports a different persisted baseline: all three enabled.
    catalog = {
      ...CATALOG,
      catalog: CATALOG.catalog.map((model) => ({ ...model, enabled: true })),
      refreshedAt: CATALOG.refreshedAt + 60000,
    }
    await click(button(container, '刷新目录'))

    const afterRefresh = modelCheckboxes(container)
    assert.deepEqual(
      afterRefresh.map((box) => box.checked),
      [false, true, true],
      'the dirty draft wins over the refreshed baseline',
    )
    assert.ok(container.textContent.includes('有未保存的修改'))

    // Discard restores what the host now considers saved (all three).
    await click(button(container, '放弃修改'))
    assert.deepEqual(
      modelCheckboxes(container).map((box) => box.checked),
      [true, true, true],
    )
    assert.ok(container.textContent.includes('与已保存的选择一致'))
  })
})

test('Save posts exactly the draft ids with JSON + CSRF and clears the dirty flag', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const calls = installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    await click(modelCheckboxes(container)[0]) // Spark off
    await click(modelCheckboxes(container)[2]) // GLM on
    await click(button(container, '保存勾选'))

    const saveCalls = calls.filter((call) => call.url === SAVE_URL)
    assert.equal(saveCalls.length, 1)
    const [saveCall] = saveCalls
    assert.equal(saveCall.init.method, 'POST')
    assert.equal(saveCall.init.headers['content-type'], 'application/json')
    assert.equal(saveCall.init.headers['x-loomy-csrf'], 'csrf-test-token')
    assert.deepEqual(saveCall.body, {
      enabledModelIds: ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash'],
    })

    assert.ok(container.textContent.includes('已保存，模型选择器已更新。'))
    assert.ok(container.textContent.includes('与已保存的选择一致'))
    assert.equal(modelCheckboxes(container)[0].checked, false)
    assert.equal(modelCheckboxes(container)[2].checked, true)
  })
})

test('Save failure keeps the draft and shows the host error verbatim', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [SAVE_URL]: {
        body: { ok: false, error: { code: 'config_readonly', message: '设置文件只读（宿主原文）' } },
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    await click(modelCheckboxes(container)[0])
    await click(button(container, '保存勾选'))

    assert.ok(container.textContent.includes('保存失败：设置文件只读（宿主原文）'))
    assert.equal(modelCheckboxes(container)[0].checked, false, 'draft was not rolled back')
    assert.ok(container.textContent.includes('有未保存的修改'))
  })
})

test('discard alone makes no request and restores the saved selection', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const calls = installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    await click(modelCheckboxes(container)[0])
    await click(button(container, '放弃修改'))
    assert.equal(modelCheckboxes(container)[0].checked, true)
    assert.ok(container.textContent.includes('与已保存的选择一致'))
  })
  assert.equal(calls.filter((call) => call.url === SAVE_URL).length, 0)
})

test('catalog route missing (404): controls are hidden instead of failing later', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes({ [REFRESH_URL]: { status: 404, body: { ok: false } } }))

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    assert.ok(container.textContent.includes('宿主未提供目录刷新路由。'))
    assert.equal(buttonsByText(container, '刷新目录').length, 0)
    assert.equal(buttonsByText(container, '保存勾选').length, 0)
    assert.equal(buttonsByText(container, '放弃修改').length, 0)
    assert.equal(modelCheckboxes(container).length, 0)
  })
})

test('empty catalog renders an empty state, not an error', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [REFRESH_URL]: { body: { ok: true, refreshedAt: CATALOG.refreshedAt, catalog: [] } },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    assert.ok(container.textContent.includes('上游目录中没有可用的聊天模型。'))
    assert.equal(modelCheckboxes(container).length, 0)
  })
})

test('status without enabledModelIds: empty state + note, no guessed checks, Save disabled', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [STATUS_URL]: {
        body: {
          ok: true,
          csrfToken: 'csrf-test-token',
          account: STATUS.account,
          credential: STATUS.credential,
          catalog: STATUS.catalog,
          // deliberately omitted: contract v2 requires it
        },
      },
      [REFRESH_URL]: {
        body: {
          ok: true,
          refreshedAt: CATALOG.refreshedAt,
          catalog: CATALOG.catalog.map(({ enabled, ...model }) => model),
        },
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    assert.ok(container.textContent.includes('宿主尚未提供已保存的勾选（enabledModelIds）。'))
    assert.equal(
      modelCheckboxes(container).filter((box) => box.checked).length,
      0,
      'nothing is guessed from counters',
    )
    const save = button(container, '保存勾选')
    assert.equal(save.disabled, true)
  })
})

test('catalog refresh failures are surfaced and retryable', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  let attempts = 0
  installFetch(
    defaultRoutes({
      [REFRESH_URL]: () => {
        attempts += 1
        if (attempts === 1) throw new Error('upstream reset')
        return response(CATALOG)
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await openModels(container)
    assert.ok(container.textContent.includes('刷新目录失败'))
    assert.ok(container.textContent.includes('upstream reset'))
    await click(button(container, '刷新目录'))
    assert.equal(modelCheckboxes(container).length, 3)
  })
})

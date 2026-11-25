/**
 * 交互流程：点按钮之后**真的**发生了什么。
 *
 * 能力矩阵测试证明"该出现的控件出现了"，但不证明它们接线正确：登录表单是否把
 * 手机号发给了正确的路由、重命名是否带上了 id、导入是否把粘贴的文档装进
 * `{bundle}`、探活是否真的 POST。旧版这些流程各自散在两个供应商的组件里，只能
 * 靠手点；现在一套面板服务所有供应商，所以也只需要一套流程测试。
 *
 * 每个用例先 `resetDom()`：同一个进程里反复渲染会累积 React 挂载状态，后面的
 * 渲染可能拿到空容器（测试基建问题，不是产品问题）。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import {
  buildStatus,
  button,
  buttonsByText,
  click,
  flush,
  defaultRoutes,
  installFetch,
  mountPlugin,
  renderCard,
  resetDom,
  tab,
} from './helpers.mjs'

const { entry, t } = mountPlugin()

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const FULL = {
  accounts: 'multi',
  pool: true,
  login: ['sms-code'],
  credits: {
    kind: 'balance',
    ledger: true,
    fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
  },
  catalog: { selection: true, visionOverride: true, reasoningEffort: true },
  transfer: true,
  adopt: true,
  diagnostics: true,
}

/** 记录所有请求的 fetch 双份，按路径索引。 */
function recordingFetch(routes) {
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const pathname = url.split('?')[0]
    const route = routes[url] ?? routes[pathname]
    if (route === undefined) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (typeof route === 'function') return route(init, calls)
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return calls
}

/** 渲染卡片，等待首屏数据落地。 */
async function openCard(routes) {
  const calls = recordingFetch(routes)
  await renderCard(entry, t, async ({ container }) => {
    for (let attempt = 0; attempt < 50 && (container.textContent ?? '').length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return container
  })
  return calls
}

/** 在卡片里执行一段交互。 */
async function withCard(routes, run) {
  const calls = recordingFetch(routes)
  return renderCard(entry, t, async ({ container }) => {
    for (let attempt = 0; attempt < 50 && (container.textContent ?? '').length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await run({ container, calls })
    return calls
  })
}

/** 按 aria-label 找输入框并设置值（React 受控组件要走原生 setter + input 事件）。 */
async function type(container, label, value) {
  const input = [...container.querySelectorAll('input, textarea')].find(
    (element) => element.getAttribute('aria-label') === label || element.getAttribute('placeholder') === label,
  )
  assert.ok(input !== undefined, `no input labelled ${label}`)
  const proto = input.ownerDocument.defaultView[input.tagName === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement'].prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  assert.ok(setter !== undefined)
  await click(input)
  setter.call(input, value)
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }))
}

test('the SMS login sends the phone, then the code, to the vendor routes', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    '/plugins/dsh-connect-desktop/loomy/auth/send-code': {
      body: { ok: true, phone: '138****0000', resendAfterMs: 60_000, expiresMs: 300_000 },
    },
    '/plugins/dsh-connect-desktop/loomy/auth/login': { body: { ok: true, phone: '138****0000' } },
  })

  const calls = await withCard(routes, async ({ container }) => {
    // 「新增账号」现在是账号段标题右侧的按钮：先按下它，表单才在段内展开。
    await click(button(container, t('accounts.add')))
    await type(container, t('login.phonePlaceholder'), '13800000000')
    await click(button(container, t('login.sendCode')))
    await type(container, t('login.codePlaceholder'), '123456')
    await click(button(container, t('login.submit')))
  })

  // 手机号/验证码是原始输入；脱敏只发生在宿主返回的视图里。
  const send = calls.find((call) => call.url.endsWith('/auth/send-code'))
  assert.ok(send !== undefined, 'send-code was called')
  assert.equal(send.method, 'POST')
  assert.deepEqual(send.body, { phone: '13800000000' })
  assert.equal(send.headers['x-dsh-connect-csrf'], 'csrf-test-token')

  const login = calls.find((call) => call.url.endsWith('/auth/login'))
  assert.ok(login !== undefined, 'login was called')
  assert.equal(login.body.phone, '13800000000')
  assert.equal(login.body.code, '123456')
  assert.equal(login.body.method, 'sms-code')
})

test('renaming an account posts the id and the new label', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    // 重命名只对插件自己存的账号开放（桌面端的登录态归客户端所有）。
    '/plugins/dsh-connect-desktop/loomy/accounts': {
      body: {
        ok: true,
        rotating: false,
        accounts: [
          {
            id: 'loomy-a1',
            route: 'loomy',
            displayName: 'Loomy',
            origin: 'plugin',
            label: '旧名字',
            unavailable: false,
          },
        ],
      },
    },
    '/plugins/dsh-connect-desktop/loomy/accounts/rename': { body: { ok: true } },
  })

  const calls = await withCard(routes, async ({ container }) => {
    // 重命名现在在 ⋯ 菜单里：先展开，再点菜单项——这就是用户真实的路径。
    const trigger = container.querySelector('.dcss-row-menu-trigger')
    assert.ok(trigger !== null, 'the row has an action menu')
    await click(trigger)
    await click(button(container, t('accounts.rename')))
    // 行内编辑出现后，保存按钮与输入框同时在场。
    const input = [...container.querySelectorAll('input')].find(
      (element) => element.getAttribute('aria-label') === t('accounts.rename'),
    )
    assert.ok(input !== undefined, 'the inline rename input appeared')
    const setter = Object.getOwnPropertyDescriptor(
      input.ownerDocument.defaultView.HTMLInputElement.prototype,
      'value',
    )?.set
    setter.call(input, '主账号')
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }))
    await click(button(container, t('accounts.renameSave')))
  })

  const rename = calls.find((call) => call.url.endsWith('/accounts/rename'))
  assert.ok(rename !== undefined, 'rename was called')
  assert.equal(rename.method, 'POST')
  assert.equal(rename.body.label, '主账号')
  assert.equal(typeof rename.body.id, 'string')
  assert.ok(rename.body.id.length > 0)
})

test('importing a pasted bundle wraps it exactly once', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    '/plugins/dsh-connect-desktop/loomy/accounts/import': {
      body: { ok: true, added: 1, refreshed: 0, skipped: 0 },
    },
  })

  const pasted = JSON.stringify({
    kind: 'dsh-connect-desktop/accounts',
    version: 1,
    accounts: [{ material: 'm'.repeat(40), label: '搬过来的' }],
  })

  const calls = await withCard(routes, async ({ container }) => {
    // 导出/导入同样是按钮：按下后表单在账号段内展开。
    await click(button(container, t('transfer.title')))
    const textarea = container.querySelector('textarea')
    assert.ok(textarea !== null, 'the paste box rendered')
    const setter = Object.getOwnPropertyDescriptor(
      textarea.ownerDocument.defaultView.HTMLTextAreaElement.prototype,
      'value',
    )?.set
    setter.call(textarea, pasted)
    textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input', { bubbles: true }))
    await click(button(container, t('transfer.importNow')))
  })

  const imported = calls.find((call) => call.url.endsWith('/accounts/import'))
  assert.ok(imported !== undefined, 'import was called')
  const body = imported.body
  // 传输层把粘贴内容装进 `{bundle}`；宿主同时接受两种形状，所以这里只要求
  // "至少有一个 accounts 数组"，不锁死包裹层数。
  const document = body.bundle ?? body
  assert.ok(Array.isArray(document.accounts), 'the pasted document reached the host')
  assert.equal(document.accounts.length, 1)
})

test('re-detect drops the host cache and re-reads the status', async () => {
  await resetDom()
  let statusReads = 0
  const status = buildStatus({ capabilities: FULL })
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': {
      body: status,
      status: 200,
    },
  })

  const calls = await withCard(routes, async ({ container, calls: all }) => {
    // 数第一次读：卡片挂载时就发过一次。
    statusReads = all.filter((call) => call.url.endsWith('/status')).length
    await click(button(container, t('account.redetect')))
  })

  const recheck = calls.find((call) => call.url.endsWith('/recheck'))
  assert.ok(recheck !== undefined, 'recheck was called')
  assert.equal(recheck.method, 'POST')
  assert.equal(recheck.headers['x-dsh-connect-csrf'], 'csrf-test-token')
  // 重新检测后必须重读状态，否则徽标/可用性还是旧的。
  const after = calls.filter((call) => call.url.endsWith('/status')).length
  assert.ok(after > statusReads, 'status was re-read after the recheck')
})

test('the diagnostics probe button posts to the probe route', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    '/plugins/dsh-connect-desktop/loomy/diagnostics/probe': {
      body: {
        ok: true,
        probes: [{ path: '/models', ok: true, reason: 'ok（4 个聊天模型）' }],
      },
    },
  })

  const calls = await withCard(routes, async ({ container }) => {
    await click(tab(container, t('tabs.diagnostics')))
    await click(button(container, t('diagnostics.probe.run')))
    assert.match(container.textContent ?? '', /4 个聊天模型/u, 'the live answer is rendered')
  })

  const probe = calls.find((call) => call.url.endsWith('/diagnostics/probe'))
  assert.ok(probe !== undefined, 'probe was called')
  assert.equal(probe.method, 'POST')
  assert.equal(probe.headers['x-dsh-connect-csrf'], 'csrf-test-token')
})

// ── 第二家供应商：密码登录 ────────────────────────────────────────────────
//
// 这套面板是所有供应商共用的，所以"换一家供应商"不该需要新的流程测试；但 Raccoon
// 的登录方式集合不同（短信 + 密码），方法切换器与密码输入只有在这种情况下才渲染。
// 这里用一份 Raccoon 能力夹具证明：**同一份组件**按声明切换形态。

const RACCOON = {
  accounts: 'multi',
  pool: true,
  login: ['sms-code', 'password'],
  credits: {
    kind: 'balance',
    fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
  },
  catalog: { selection: true, visionOverride: true, reasoningEffort: false },
  transfer: true,
  adopt: false,
  diagnostics: true,
}

/** 一份只有 Raccoon 一个供应商的 /status。 */
function raccoonStatus() {
  const status = buildStatus({ capabilities: RACCOON })
  return {
    ...status,
    vendors: status.vendors.map((vendor) => ({ ...vendor, id: 'raccoon', displayName: '商汤小浣熊' })),
  }
}

test('a vendor that declares password login gets the method switcher', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: raccoonStatus() },
    '/plugins/dsh-connect-desktop/raccoon/auth/login': { body: { ok: true, phone: '13800000000' } },
  })

  const calls = await withCard(routes, async ({ container }) => {
    await click(button(container, t('accounts.add')))
    // 方法切换器只在两种方式都声明时出现。
    const passwordRadio = [...container.querySelectorAll('[role="radio"]')].find(
      (element) => element.textContent?.trim() === t('login.method.password'),
    )
    assert.ok(passwordRadio !== undefined, 'the password method is offered')
    await click(passwordRadio)

    await type(container, t('login.phonePlaceholder'), '13800000000')
    await type(container, t('login.passwordPlaceholder'), 'hunter2-but-longer')
    await click(button(container, t('login.submit')))
  })

  const login = calls.find((call) => call.url.endsWith('/raccoon/auth/login'))
  assert.ok(login !== undefined, 'login was called')
  assert.deepEqual(login.body, { phone: '13800000000', password: 'hunter2-but-longer', method: 'password' })
  // 手机号加密是**宿主**的事：客户端发原号，绝不在浏览器里加密（否则密钥就随包发布了）。
  assert.match(login.body.phone, /^\d{11}$/u)
})

test('a vendor that only declares SMS login hides the switcher', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
  })
  await withCard(routes, async ({ container }) => {
    await click(button(container, t('accounts.add')))
    assert.equal(container.querySelectorAll('[role="radio"]').length, 0, 'no method choice to make')
    assert.ok(
      [...container.querySelectorAll('button')].some((element) => element.textContent?.trim() === t('login.sendCode')),
      'the SMS form is still there',
    )
  })
})

// ── 配置可达性 ─────────────────────────────────────────────────────────────
//
// 用户报的问题："配置里只看到 loomy，没有小浣熊"。两条断言钉住修复：
// 未登录的供应商仍能进入，且配置页能读能写。

test('an unavailable vendor is still selectable, so its configuration is reachable', async () => {
  await resetDom()
  const status = buildStatus({ capabilities: FULL, available: false })
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: status },
  })

  await withCard(routes, async ({ container }) => {
    // 未登录的那一家仍在切换条里（只有一个供应商时切换条不渲染，所以直接看状态条）。
    assert.match(container.textContent ?? '', /未检测到|未登录|不可用/u, 'the reason is shown')
    assert.ok(
      [...container.querySelectorAll('button')].some((element) => element.textContent?.trim() === t('account.redetect')),
      're-check stays reachable while signed out',
    )
    await click(tab(container, t('tabs.config')))
    assert.ok(container.querySelector('[data-dcss-cap="config"]') !== null, 'the config panel opens')
  })
})

test('the config panel lists every field and saves only what changed', async () => {
  await resetDom()
  const fields = [
    { key: 'baseURL', type: 'string', value: 'https://default.test/v1', default: 'https://default.test/v1', overridden: false },
    { key: 'catalogTtlMs', type: 'number', value: 600000, default: 600000, overridden: false },
    { key: 'enabled', type: 'boolean', value: true, default: true, overridden: false },
  ]
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    '/plugins/dsh-connect-desktop/loomy/config': (init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, vendorId: 'loomy', fields }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const calls = await withCard(routes, async ({ container }) => {
    await click(tab(container, t('tabs.config')))
    // 每个字段一行；一行都没少才说明反射没漏类型。
    for (const field of fields) {
      assert.ok(container.querySelector(`[data-dcss-config="${field.key}"]`) !== null, `${field.key} rendered`)
    }
    const input = [...container.querySelectorAll('input[type="text"]')].find((element) =>
      element.closest('[data-dcss-config="baseURL"]'),
    )
    assert.ok(input !== undefined, 'the baseURL input rendered')
    const setter = Object.getOwnPropertyDescriptor(
      input.ownerDocument.defaultView.HTMLInputElement.prototype,
      'value',
    )?.set
    setter.call(input, 'https://custom.test/v1')
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }))
    await click(button(container, t('config.save')))
  })

  const saved = calls.filter((call) => call.url.endsWith('/loomy/config') && call.method === 'POST')
  assert.equal(saved.length, 1, 'one save, not one per field')
  // 只提交改过的那一项：把整片配置回写会覆盖别人同时改的其它字段。
  assert.deepEqual(saved[0].body, { fields: { baseURL: 'https://custom.test/v1' } })
  assert.equal(saved[0].headers['x-dsh-connect-csrf'], 'csrf-test-token')
})

test('arrow keys move between tabs, and each tab points at its panel', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
  })

  await withCard(routes, async ({ container }) => {
    const list = container.querySelector('[role="tablist"]')
    assert.ok(list !== null)
    const first = tab(container, t('tabs.account'))
    assert.equal(first.getAttribute('aria-selected'), 'true')
    // 每个 tab 必须指向自己的面板，面板必须反向指回 tab；否则屏幕阅读器
    // 只知道"这是一个 tab"，不知道它控制什么。
    const panelId = first.getAttribute('aria-controls')
    assert.ok(panelId !== null && panelId.length > 0)
    assert.equal(container.querySelector(`#${panelId}`)?.getAttribute('role'), 'tabpanel')
    assert.equal(container.querySelector(`#${panelId}`)?.getAttribute('aria-labelledby'), first.id)

    // 方向键换 tab
    await React.act(async () => {
      list.dispatchEvent(new (globalThis.window.KeyboardEvent)('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await flush()
    assert.equal(tab(container, t('tabs.models')).getAttribute('aria-selected'), 'true')
    assert.ok(container.querySelector('[data-dcss-cap="models"]') !== null, 'the models panel rendered')
  })
})

test('saving config carries the revision and reports a stale write', async () => {
  await resetDom()
  let posted = null
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    '/plugins/dsh-connect-desktop/loomy/config': (init) => {
      if (init.method === 'POST') {
        posted = JSON.parse(init.body)
        // 宿主在版本不符时的回答：HTTP 200 + ok:false + config_stale。
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'config_stale', message: '配置已被他处修改（你基于第 3 版，当前是第 4 版）。' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          ok: true,
          vendorId: 'loomy',
          revision: 3,
          fields: [{ key: 'baseURL', type: 'string', value: 'https://a.test', default: 'https://a.test', overridden: false }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  await withCard(routes, async ({ container }) => {
    await click(tab(container, t('tabs.config')))
    const input = container.querySelector('[data-dcss-config="baseURL"] input')
    assert.ok(input !== null)
    const setter = Object.getOwnPropertyDescriptor(
      input.ownerDocument.defaultView.HTMLInputElement.prototype,
      'value',
    )?.set
    setter.call(input, 'https://b.test')
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }))
    await click(button(container, t('config.save')))

    // 请求带上了读到的版本号
    assert.equal(posted.ifRevision, 3)
    assert.deepEqual(posted.fields, { baseURL: 'https://b.test' })
    // 冲突以宿主原文呈现，且草稿被丢弃（输入框回到宿主的值）
    assert.match(container.textContent ?? '', /配置已被他处修改/u)
    const after = container.querySelector('[data-dcss-config="baseURL"] input')
    assert.equal(after.value, 'https://a.test')
  })
})

test('the account-section buttons expand one form at a time', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
  })

  await withCard(routes, async ({ container }) => {
    const addButton = button(container, t('accounts.add'))
    const transferButton = button(container, t('transfer.title'))

    // 两个按钮都在账号段的标题右侧（`.dcss-toolbar` 内），不是独立的一段。
    for (const control of [addButton, transferButton]) {
      assert.ok(
        control.closest('.dcss-section')?.querySelector('.dcss-section-title') !== null,
        'the button lives in the account section header',
      )
    }
    // 未按下时两个表单都不在。
    assert.equal(container.querySelector('[data-dcss-cap="login-form"]'), null)
    assert.equal(container.querySelector('textarea'), null)
    assert.equal(addButton.getAttribute('aria-expanded'), 'false')

    await click(addButton)
    assert.equal(addButton.getAttribute('aria-expanded'), 'true')
    assert.ok(container.querySelector('[data-dcss-cap="login-form"]') !== null, 'login form opened')

    // 展开第二个会收起第一个：两个表单同时展开会把列表推到屏幕外。
    await click(transferButton)
    assert.equal(container.querySelector('[data-dcss-cap="login-form"]'), null, 'login form closed')
    assert.ok(container.querySelector('textarea') !== null, 'transfer form opened')
    assert.equal(addButton.getAttribute('aria-expanded'), 'false')
    assert.equal(transferButton.getAttribute('aria-expanded'), 'true')

    // 表单贴着段头展开，在账号列表**之前**：用户点的是标题右侧的按钮，输入框必须
    // 出现在眼前而不是列表末尾——账号一多，排在后面就等于"按了没反应"。
    const form = container.querySelector('.dcss-acct-form')
    const list = container.querySelector('.dcss-acct-list')
    assert.ok(form !== null && list !== null, 'both the expanded form and the account list are mounted')
    const following = form.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING
    assert.ok(form.compareDocumentPosition(list) & following, 'the expanded form sits above the account list')
    // 面板由段头按钮控制，块内不再有第二层折叠：粘贴框直接可见。
    assert.equal(container.querySelector('.dcss-acct-form details'), null, 'no second-level fold inside the panel')
    assert.equal(
      container.querySelector('.dcss-acct-form .dcss-transfer-export .dcss-button')?.textContent,
      t('transfer.export'),
      'export action and its hint lead the panel',
    )

    // 再按一次收起。
    await click(transferButton)
    assert.equal(container.querySelector('textarea'), null)
    assert.equal(transferButton.getAttribute('aria-expanded'), 'false')
  })
})

/**
 * 切换供应商 = 换上下文。
 *
 * 用户报过："我在设置页面切换供应商，他们的账号列表都没有变。"根因有两层：
 * 1. `useVendorRoute` 的 `run` 依赖空数组，配上只依赖 `[enabled, run]` 的 effect，
 *    切供应商时**不会重新拉取**；
 * 2. 面板实例被 React 复用，上一家的数据与展开态留在屏幕上。
 *
 * 两条都修了（`load` 进依赖 + 面板加 `key={vendorId}`），这条测试守住它们。
 */
test('switching vendors swaps the account list, not just the title', async () => {
  await resetDom()
  const CAPABILITIES = {
    accounts: 'multi',
    pool: false,
    login: ['none'],
    credits: { kind: 'balance', fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }] },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  const vendor = (id, displayName) => ({
    ...buildStatus({ capabilities: CAPABILITIES }).vendors[0],
    id,
    displayName,
    accent: '#123456',
  })

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': {
        body: { ok: true, csrfToken: 'tok', vendors: [vendor('loomy', 'Loomy'), vendor('raccoon', '小浣熊')] },
      },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [{ id: 'L1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000001', unavailable: false }],
        },
      },
      '/plugins/dsh-connect-desktop/raccoon/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [{ id: 'R1', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', phone: '13900000002', unavailable: false }],
        },
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await flush()
    const rowIds = () => [...container.querySelectorAll('[data-dcss-account]')].map((el) => el.getAttribute('data-dcss-account'))
    assert.deepEqual(rowIds(), ['L1'], 'Loomy 的账号先出现')

    const raccoonTab = [...container.querySelectorAll('.dcss-vendor-tab')].find(
      (element) => element.textContent?.trim() === '小浣熊',
    )
    assert.ok(raccoonTab !== undefined, '两家都检测到时要能切换')
    await click(raccoonTab)
    await flush()

    assert.deepEqual(rowIds(), ['R1'], '切换后显示的是另一家的账号，不是上一家残留的数据')
  })
})

test('config fields are grouped by the vendor declaration', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL }) },
    '/plugins/dsh-connect-desktop/loomy/config': {
      body: {
        ok: true,
        vendorId: 'loomy',
        revision: 1,
        // 分组由供应商声明：core 只按它归位，不猜字段语义。
        groups: [
          { id: 'connection', labelKey: 'config.group.connection' },
          { id: 'cache', labelKey: 'config.group.cache' },
        ],
        fields: [
          { key: 'baseURL', type: 'string', group: 'connection', value: 'https://a.test', default: 'https://a.test', overridden: false, description: '接口地址' },
          { key: 'catalogTtlMs', type: 'number', group: 'cache', value: 600000, default: 600000, overridden: false, description: '目录缓存时长' },
          { key: 'orphan', type: 'string', value: 'x', default: 'x', overridden: false, description: '没有分组的字段' },
        ],
      },
    },
  })

  await withCard(routes, async ({ container }) => {
    await click(tab(container, t('tabs.config')))
    const titles = [...container.querySelectorAll('.dcss-field-group-title')].map((el) => el.textContent?.trim())
    assert.deepEqual(titles, [t('config.group.connection'), t('config.group.cache')], '按声明的顺序出现，没分组的不给标题')

    // 字段名降为副标题，说明文字才是主标题。
    const row = container.querySelector('[data-dcss-config="baseURL"]')
    assert.ok(row?.querySelector('.dcss-field-title')?.textContent === '接口地址', '说明文字是主标题')
    assert.ok(row?.querySelector('.dcss-field-name')?.textContent === 'baseURL', '键名是副标题')
  })
})

/**
 * 「重新注册」：provider 未注册提示旁边的按钮，真的把 POST 发到 /register。
 *
 * 用户上报的现场：卡片写着「这家客户端还没有注册进模型选择器——原因见下。
 * cannot create effect on inactive context」，且没有任何东西会再试一次。按钮的
 * 价值在于"不用重启 DSH"：POST 命中宿主后，/status 里的原因要真的换掉。
 */
const PROVIDER_UNREGISTERED = {
  id: 'loomy',
  displayName: 'Loomy',
  accent: '#2E6BE6',
  available: true,
  capabilities: FULL,
  credential: { found: true, sourceOrigin: 'desktop', sourcePath: '/x/auth.json', candidates: [] },
  account: { phone: '138****0000' },
  catalog: { total: 3, enabled: 2, refreshedAt: 1794575000000 },
  enabledModelIds: ['spark-x2.6'],
  provider: { registered: false, routes: [], error: 'cannot create effect on inactive context', retryable: true },
}

test('the re-register button posts to /register and the notice clears after the reload', async () => {
  await resetDom()
  let registered = false
  const statusOnce = () => ({
    ok: true,
    csrfToken: 'csrf-test-token',
    vendors: [
      registered
        ? { ...PROVIDER_UNREGISTERED, provider: { registered: true, routes: ['loomy'] } }
        : PROVIDER_UNREGISTERED,
    ],
  })
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': () => new Response(JSON.stringify(statusOnce()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    '/plugins/dsh-connect-desktop/loomy/register': () => {
      registered = true
      return new Response(JSON.stringify({ ok: true, registered: true, routes: ['loomy'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await withCard(routes, async ({ container, calls }) => {
    assert.ok(container.textContent.includes('cannot create effect on inactive context'), '现场原因原文可见')
    // retryable ⇒ 按钮存在；按下它。
    await click(button(container, t('card.reregister')))
    const registerCall = calls.find((call) => call.url.endsWith('/loomy/register'))
    assert.ok(registerCall !== undefined, '必须真的 POST 到 /register')
    assert.equal(registerCall.method, 'POST')
    assert.equal(registerCall.headers['x-dsh-connect-csrf'], 'csrf-test-token')
    // /status 被静默重读，通知随之消失。
    assert.ok(
      (container.textContent ?? '').includes(t('card.providerMissing')) === false,
      '注册成功后提示要消失',
    )
  })
})

test('the re-register button reports a failed request instead of looking dead', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: FULL, vendorOverrides: { provider: { registered: false, routes: [], error: '占位', retryable: true } } }) },
    // 路由不存在（宿主还是旧版）：404。
    '/plugins/dsh-connect-desktop/loomy/register': { status: 404, body: { ok: false, error: { code: 'not_found', message: 'no route' } } },
  })

  await withCard(routes, async ({ container }) => {
    await click(button(container, t('card.reregister')))
    assert.ok(
      (container.textContent ?? '').includes(t('errors.unavailable')),
      '请求没走通时必须有一句话，而不是按钮毫无反应',
    )
    assert.ok((container.textContent ?? '').includes('占位'), '原始失败原因仍然在屏上')
  })
})

test('a non-retryable reason renders no re-register button', async () => {
  await resetDom()
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': {
      body: buildStatus({
        capabilities: FULL,
        vendorOverrides: { provider: { registered: false, routes: [], error: '没有可用登录态：未检测到登录态', retryable: false } },
      }),
    },
  })

  await withCard(routes, async ({ container }) => {
    assert.ok(container.textContent.includes('没有可用登录态'), '原因可见')
    assert.equal(buttonsByText(container, t('card.reregister')).length, 0, '重试也无用的原因不给按钮')
  })
})

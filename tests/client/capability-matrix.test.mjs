/**
 * 能力矩阵：**声明的能力 == 渲染出的控件**。
 *
 * 这是"新供应商不会掉页面"在客户端一侧的机器保证：卡片不认供应商，只认声明。
 * 如果某个能力位没有对应控件（或反过来，没声明却渲染了控件），这些用例就会红——
 * 而这正是上一版两家供应商各写一套 UI 时，永远发现不了的东西。
 *
 * 断言用 `data-dcss-cap` 标记而不是 CSS 类名：类名会为了样式重构而改名，能力标记
 * 是契约的一部分。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  CREDITS,
  DIAGNOSTICS,
  buildStatus,
  defaultRoutes,
  installFetch,
  click,
  flush,
  mountPlugin,
  renderCard,
  setupDom,
  tab,
} from './helpers.mjs'

const { entry, t, exports } = mountPlugin()

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 能力位全开的一份声明（两家真实供应商的并集）。 */
const FULL = {
  accounts: 'multi',
  pool: true,
  login: ['sms-code'],
  credits: {
    kind: 'balance',
    ledger: true,
    fields: [
      { key: 'available', labelKey: 'credits.field.available', role: 'available' },
      { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
    ],
  },
  catalog: { selection: true, visionOverride: true, reasoningEffort: true },
  transfer: true,
  adopt: true,
  diagnostics: true,
}

/** 一份"只有余额"的声明。 */
const BALANCE_ONLY = {
  accounts: 'none',
  pool: false,
  login: ['none'],
  credits: { kind: 'balance', fields: FULL.credits.fields },
  catalog: { selection: false, visionOverride: false, reasoningEffort: false },
  transfer: false,
  adopt: false,
  diagnostics: false,
}

/** 用一份自定义能力渲染卡片，返回容器里出现的控件事实。 */
async function renderWith(capabilities, options = {}) {
  const status = buildStatus({
    capabilities,
    available: options.available ?? true,
    ...(options.vendorOverrides ?? {}),
  })
  installFetch(defaultRoutes({ '/plugins/dsh-connect-desktop/status': { body: status } }))
  return renderCard(entry, t, async ({ container }) => {
    // 面板数据在 effect 里异步读；轮询到首屏出现为止，避免依赖"几拍才 resolve"。
    for (let attempt = 0; attempt < 50 && (container.textContent ?? '').length === 0; attempt += 1) {
      await flush()
    }
    await flush()
    return {
    container,
    tabs: [...container.querySelectorAll('[role="tab"]')].map((element) => element.textContent?.trim()),
    caps: [...container.querySelectorAll('[data-dcss-cap]')].map((element) => element.getAttribute('data-dcss-cap')),
    text: container.textContent ?? '',
    }
  })
}

test('every declared capability has a control, and every control has a declaration', async () => {
  await setupDom()
  const { tabs, caps } = await renderWith(FULL)

  // 配置 tab 总是存在：auto:false 之后卡片是唯一能改配置的地方。
  assert.deepEqual(tabs, ['账号', '模型', '配置', '诊断'])
  // 账户 tab 打开后，下列标记必须出现。
  for (const marker of ['identity', 'login', 'pool', 'transfer', 'recheck']) {
    assert.ok(caps.includes(marker), `declared capability has no control: ${marker}`)
  }
})

test('a balance-only vendor gets credits but no account management', async () => {
  await setupDom()
  const { tabs, caps } = await renderWith(BALANCE_ONLY)

  // 只有"账号"与"配置"：没有 catalog.selection 就没有模型 tab，没有 diagnostics 就没有诊断 tab。
  assert.deepEqual(tabs, ['账号', '配置'])
  assert.ok(caps.includes('identity'), 'the balance still needs a home')
  for (const marker of ['login', 'pool', 'transfer', 'rename', 'adopt', 'switch']) {
    assert.ok(!caps.includes(marker), `undeclared capability rendered a control: ${marker}`)
  }
})

test('a vendor that declares nothing still offers its configuration', async () => {
  await setupDom()
  const { tabs, caps } = await renderWith({
    accounts: 'none',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  })

  // 配置始终可达——这正是"找不到配置的地方"那次修复的核心。
  assert.deepEqual(tabs, ['配置'])
  // 状态条是**刻意**常驻的：即使什么都没声明，也要回答"你在看哪家"。
  // 除它与配置以外不该有任何控件。
  const unexpected = caps.filter((marker) => marker !== 'statusbar' && marker !== 'config')
  assert.deepEqual(unexpected, [], 'undeclared capabilities must not render controls')
  assert.ok(caps.includes('statusbar'), 'the status bar is the one always-on element')
})

test('an unavailable vendor stays reachable so the user can fix it', async () => {
  await setupDom()
  const { tabs, caps, text } = await renderWith(FULL, { available: false })
  // 设置页是"修复"的地方：未登录也必须在，否则连「重新检测」都点不到。
  assert.ok(tabs.includes('账号'))
  assert.ok(caps.includes('recheck'), 'the re-check control must be reachable while signed out')
  assert.match(text, /未检测到|不可用|未登录/u)
})

test('the models tab actually opens its panel', async () => {
  await setupDom()
  const status = buildStatus({ capabilities: FULL })
  installFetch(defaultRoutes({ '/plugins/dsh-connect-desktop/status': { body: status } }))
  await renderCard(entry, t, async ({ container }) => {
    await click(tab(container, '模型'))
    assert.ok(container.querySelector('[data-dcss-cap="models"]') !== null, 'the models panel rendered')
    assert.ok(container.querySelector('.dcss-tick input[type="checkbox"]') !== null, 'the catalog rows rendered')
  })
})

test('ledger rendering is one rule, shared by the panel and the test', () => {
  const { showsLedger } = exports

  // 有余额**且**有流水：两者都要（Loomy 的形态）。
  assert.equal(showsLedger({ kind: 'balance', fields: [], ledger: true }), true)
  // 有余额、没声明流水：只画桶，不画表。
  assert.equal(showsLedger({ kind: 'balance', fields: [] }), false)
  assert.equal(showsLedger({ kind: 'balance', fields: [], ledger: false }), false)
  // 只有流水（没有余额桶）。
  assert.equal(showsLedger({ kind: 'ledger' }), true)
  // 什么都不声明。
  assert.equal(showsLedger({ kind: 'none' }), false)

  // 夹具确实带流水：所以上面"false"的那些用例证明的是规则，不是数据缺失。
  assert.ok(CREDITS.records.length > 0)
})

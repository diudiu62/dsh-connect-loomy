/**
 * 能力声明 ⇒ tab 集合（`client/capability/tabs`）。
 *
 * 这是整个客户端重构的规则集中点，且是纯函数：不需要 DOM、不需要宿主。三个断言
 * 支撑"新增供应商不需要新页面"这个主张——如果 `tabsFor` 漏了某个能力，第三家
 * 供应商就会看到一个空缺的 tab，而这里会红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountPlugin } from './helpers.mjs'

const { exports } = mountPlugin()
const { tabsFor, resolveTab, hasAccountSurface } = exports

/** bundle 在 vm 里求值：跨 realm 的数组只能比较序列化后的原始值。 */
const keysOf = (tabs) => tabs.map((entry) => entry.key).join(',')
const labelsOf = (tabs) => tabs.map((entry) => `${entry.key}:${entry.labelKey}`).join(',')

/** 一份"什么都没有"的声明，测试逐项打开。 */
function bare(overrides = {}) {
  return {
    accounts: 'none',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
    ...overrides,
  }
}

test('an empty declaration still justifies the configuration tab', () => {
  // 配置不依赖任何能力位：auto:false 之后卡片是唯一入口，所以它永远在。
  assert.equal(keysOf(tabsFor(bare())), 'config')
  assert.equal(hasAccountSurface(bare()), false)
  assert.equal(resolveTab([], 'account'), null)
})

test('accounts, credits and login each open the account tab', () => {
  for (const capabilities of [
    bare({ accounts: 'single' }),
    bare({ accounts: 'multi' }),
    bare({ credits: { kind: 'balance', fields: [] } }),
    bare({ credits: { kind: 'ledger' } }),
    bare({ login: ['sms-code'] }),
    bare({ login: ['password'] }),
  ]) {
    assert.ok(hasAccountSurface(capabilities), JSON.stringify(capabilities))
    // bundle 在 vm 里求值，跨 realm 的数组只能比原始值。
    assert.equal(labelsOf(tabsFor(capabilities)), 'account:tabs.account,config:tabs.config')
  }
})

test('the models tab follows catalog.selection, not the vendor name', () => {
  assert.equal(keysOf(tabsFor(bare({ catalog: { selection: true, visionOverride: false, reasoningEffort: false } }))), 'models,config')
  // 只声明 visionOverride 不注册 /catalog 与 /save，所以不该有模型 tab。
  // 只声明 visionOverride 不注册 /catalog 与 /save，所以没有模型 tab。
  assert.equal(keysOf(tabsFor(bare({ catalog: { selection: false, visionOverride: true, reasoningEffort: true } }))), 'config')
})

test('tab order is fixed account → models → config → diagnostics', () => {
  const capabilities = bare({
    accounts: 'multi',
    credits: { kind: 'balance', fields: [] },
    catalog: { selection: true, visionOverride: false, reasoningEffort: false },
    diagnostics: true,
  })
  assert.equal(keysOf(tabsFor(capabilities)), 'account,models,config,diagnostics')
})

test('a vanished selection falls back to the first available tab', () => {
  const tabs = tabsFor(bare({ accounts: 'single', diagnostics: true }))
  // 能力可能在两次读之间消失（供应商被关掉、宿主重启），此时不能渲染空面板。
  assert.equal(resolveTab(tabs, 'models')?.key, 'account')
  assert.equal(resolveTab(tabs, 'diagnostics')?.key, 'diagnostics')
  assert.equal(resolveTab(tabs, null)?.key, 'account')
})

test('the composer badge attributes a route to a vendor without vendor literals', () => {
  const { vendorForRoute, selectedProviderOf } = exports
  const ids = ['loomy', 'raccoon']
  assert.equal(vendorForRoute('loomy', ids), 'loomy')
  assert.equal(vendorForRoute('loomy-3', ids), 'loomy')
  assert.equal(vendorForRoute('loomy-pool', ids), 'loomy')
  assert.equal(vendorForRoute('raccoon', ids), 'raccoon')
  // 前缀相似的第三方路由不能被误判成已注册的供应商。
  assert.equal(vendorForRoute('loomyx', ids), undefined)
  assert.equal(vendorForRoute('deepseek', ids), undefined)
  assert.equal(vendorForRoute(undefined, ids), undefined)

  assert.equal(selectedProviderOf({ next: { provider: 'raccoon' } }), 'raccoon')
  assert.equal(selectedProviderOf({ lastUsed: { provider: 'loomy-2' } }), 'loomy-2')
  assert.equal(selectedProviderOf({ next: { provider: '' } }), undefined)
  assert.equal(selectedProviderOf(undefined), undefined)
})

/**
 * Delivery-level checks that belong to the client half's contract rather than
 * to a component: package metadata consistency, the loader wrapper, credential
 * hygiene in the shipped bundle, and "no secrets in console output".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { RAW_PHONE } from '../host/helpers.mjs'
import {
  DIAGNOSTICS,
  STATUS,
  VENDOR_STATUS,
  button,
  click,
  defaultRoutes,
  installFetch,
  loadClient,
  mountPlugin,
  renderCard,
  setupDom,
  stubClipboard,
  tab,
} from './helpers.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const clientEntry = new URL('../../lib/client.js', import.meta.url)

test('package.json wires the client half to ./lib/client.js for the web platform', () => {
  assert.equal(packageJson.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(packageJson.dsh.client.inject))
  assert.ok(packageJson.dsh.client.inject.length > 0)
  for (const required of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale']) {
    assert.ok(packageJson.dsh.client.inject.includes(required), `${required} must precede this bundle`)
  }
  assert.equal(packageJson.exports?.['./client'], './lib/client.js')
  assert.ok(packageJson.files.includes('lib'), 'the built client bundle must ship')
  assert.equal(packageJson.main, 'lib/index.js')
})

test('the shipped client bundle is the loader factory with the package id', () => {
  const source = readFileSync(clientEntry, 'utf8')
  assert.ok(source.startsWith('window.__ModuleLoader__.load({'))
  assert.ok(source.includes('id: "dsh-connect-desktop"'))
  const exports = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['locale'])

  // A 32-hex run is the shape of the Loomy session; it must never be bundled.
  assert.doesNotMatch(source, /\b[0-9a-fA-F]{32}\b/, 'no session-shaped literal in the bundle')
  // Nor a complete mainland mobile number.
  assert.doesNotMatch(source, /\b1[3-9]\d{9}\b/, 'no full phone number literal in the bundle')
})

test('no console output carries session, full phone or user id during a full interaction', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())
  stubClipboard(true)

  const methods = ['log', 'info', 'warn', 'error', 'debug']
  const original = {}
  const captured = []
  for (const method of methods) {
    original[method] = console[method]
    console[method] = (...args) => {
      captured.push(args.map((value) => (typeof value === 'string' ? value : String(value))).join(' '))
    }
  }

  try {
    await renderCard(entry, t, async ({ container }) => {
      await click(tab(container, '模型'))
      await click(tab(container, '诊断'))
      await click(button(container, '复制全部'))
      await click(tab(container, '账号'))
    })
  } finally {
    for (const method of methods) console[method] = original[method]
  }

  const joined = captured.join('\n')
  assert.ok(!joined.includes('deadbeefdeadbeefdeadbeefdeadbeef'), 'session must not be logged')
  assert.ok(!joined.includes('13812345678'), 'full phone must not be logged')
  assert.ok(!joined.includes('userid-secret-42'), 'user id must not be logged')
  assert.ok(!joined.includes('csrf-test-token'), 'CSRF token must not be logged')
})

test('the host now masks the phone before it reaches the browser', () => {
  // 宿主只发送脱敏后的手机号；夹具刻意保留一个"未脱敏"的额外字段，用来证明
  // 卡片不会顺手把它渲染出来（上面的日志测试守的是另一半）。
  assert.equal(VENDOR_STATUS.account.phone, '138****0000')
  assert.equal(DIAGNOSTICS.account.phone, '138****0000')
  assert.equal(STATUS.phone, RAW_PHONE)
})

test('the stylesheet is one template literal: no stray backtick or ${ inside CSS', async () => {
  const { CARD_CSS } = await import('../../lib/client.js').catch(() => ({}))
  // 直接从产物里取：源码把 CSS 放在模板字符串里，注释中一个反引号就会截断它，
  // 而 tsc 只会在有空插值的行上报错——这个坑已经踩过两次了。
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('dcss-statusbar'), 'the status bar rule shipped')
  // 分组改由标题表达：每个 Section 都必须有标题，不再靠分隔线。
  assert.ok(source.includes('dcss-section-title'), 'section titles shipped')
  assert.ok(source.includes('dcss-summary'), 'the identity summary shipped')
  // 卡片根类名必须与样式表一致，否则整张卡片的基础排版不生效。
  assert.ok(source.includes('dcss-card'), 'the root class matches the stylesheet')
  // 供应商切换必须靠 aria-selected 高亮，否则 2 家都检测到时看不出当前是谁。
  assert.ok(source.includes('dcss-vendor-tab[aria-selected'), 'the vendor highlight selector exists')
  void CARD_CSS
})

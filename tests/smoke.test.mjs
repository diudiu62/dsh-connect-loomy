/**
 * Artifact smoke tests — no upstream traffic, no DSH process.
 *
 * These prove the two things a later task must not break:
 * 1. `lib/index.js` exports a real cordis plugin (name/inject/Config/apply).
 * 2. `lib/client.js` is the `window.__ModuleLoader__.load({id, factory})`
 *    wrapper the web client's module table expects, that its factory returns
 *    the module exports, and that `apply` registers the `settings.loomy`
 *    dictionaries under an effect.
 *
 * The factory's `require` is the loader's module table, not Node's. The real
 * bundle requires only platform seeds (`react`, `react/jsx-runtime`) plus
 * packages listed in `dsh.client.inject`; anything else must fail loudly, or a
 * stray dependency would ship as an unresolved import in the browser.
 *
 * Run after `pnpm build` (`pnpm test`); `pnpm check` does both in order.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const HOST_ENTRY = new URL('../lib/index.js', import.meta.url)
const CLIENT_ENTRY = new URL('../lib/client.js', import.meta.url)

const nodeRequire = createRequire(import.meta.url)

/**
 * Stand-ins for the seeds the web client's loader injects into every bundle
 * factory. React is a platform module there (`dsh-client-ui-renderer` owns the
 * single instance), so the bundle may require it without declaring a dep.
 */
const PLATFORM_SEEDS = {
  react: nodeRequire('react'),
  'react-dom': nodeRequire('react-dom'),
  'react/jsx-runtime': nodeRequire('react/jsx-runtime'),
}

test('host entry exports a mountable cordis plugin', async () => {
  const plugin = await import(HOST_ENTRY.href)
  assert.equal(plugin.name, 'connect-desktop')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('llm'), 'the LLM registry must gate apply')
  assert.equal(typeof plugin.apply, 'function')
  // 契约层必须真的在产物里：这是"加供应商不需要改核心"的可执行证据。
  assert.equal(typeof plugin.createLoomyModule, 'function')
  assert.equal(typeof plugin.createRaccoonModule, 'function')
  assert.equal(typeof plugin.assertRuntime, 'function')

  // Schemastery schemas are callable: `Config(raw)` is what the loader and the
  // settings writer use (`dsh-llm-pi-ai/lib/index.js:111` does exactly this).
  // Every field is `.volatile()`: parsed values are `{get(): T}` live
  // references, so unwrap through the same contract the plugin's `live()` uses.
  const read = (value) =>
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  const parsed = plugin.Config({})
  assert.equal(read(parsed.enabled), true)
  // 供应商配置按 id 分组，而且**默认值就已展开**：从没写过配置的用户也要能在
  // 配置视图里看到两家的字段，否则就是"找不到配置的地方"。
  const vendors = read(parsed.vendors)
  assert.deepEqual(Object.keys(vendors).sort(), ['loomy', 'raccoon'])
  assert.equal(vendors.loomy.baseURL, 'https://loomyad.xunfei.cn/api/v1')
  assert.equal(vendors.raccoon.baseURL, 'https://xiaohuanxiong.com/api/web/llm/v2')

  const parsedOverride = plugin.Config({ enabled: false, vendors: { loomy: { baseURL: 'https://example.test/api/v1' } } })
  assert.equal(read(parsedOverride.enabled), false)
  assert.equal(read(parsedOverride.vendors).loomy.baseURL, 'https://example.test/api/v1')
})

test('client bundle is a module-loader factory that registers the locale dictionaries', () => {
  const source = readFileSync(CLIENT_ENTRY, 'utf8')
  assert.ok(
    source.startsWith('window.__ModuleLoader__.load({'),
    'the client bundle must be wrapped in the loader factory',
  )
  assert.ok(source.includes('id: "dsh-connect-desktop"'), 'the loader id must be the package name')

  /** @type {Array<{id: string, factory: (require: (id: string) => unknown) => unknown}>} */
  const loaded = []
  const context = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded.push(spec)
        },
      },
    },
    console,
    Symbol,
  }
  vm.runInNewContext(source, context, { filename: 'lib/client.js' })

  assert.equal(loaded.length, 1)
  const bundle = loaded[0]
  assert.equal(bundle.id, 'dsh-connect-desktop')

  const exports = bundle.factory((id) => {
    if (Object.hasOwn(PLATFORM_SEEDS, id)) return PLATFORM_SEEDS[id]
    throw new Error(`unexpected runtime require(${id}) — client deps must be loader-provided`)
  })
  assert.equal(typeof exports.apply, 'function')
  // Cross-realm arrays fail deepStrictEqual on prototype identity; compare values.
  assert.equal(exports.inject.length, 1)
  assert.equal(exports.inject[0], 'locale')

  const registrations = []
  const binds = []
  let effects = 0
  const ctx = {
    effect(fn) {
      effects += 1
      return fn()
    },
    // Deferred services are optional on a host without that surface; a no-op
    // inject keeps the smoke test from depending on which carriers are present.
    inject(_names, callback) {
      if (typeof callback === 'function') callback(ctx)
      return () => {}
    },
    locale: {
      register(ns, dicts) {
        registrations.push({ ns, dicts })
        return () => {}
      },
      // `bind(ns)` returns the namespace's translate function; the key itself
      // is a fine stand-in because this test asserts registration, not wording.
      bind(ns) {
        binds.push(ns)
        return (key) => key
      },
    },
  }
  exports.apply(ctx)

  assert.equal(effects, 1)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].ns, 'settings.dsh-connect-desktop')
  assert.ok(
    binds.includes('settings.dsh-connect-desktop'),
    'apply must bind its own namespace for translation',
  )
  assert.deepEqual(
    Object.keys(registrations[0].dicts.en).sort(),
    Object.keys(registrations[0].dicts.zh).sort(),
    'en and zh must carry identical key sets',
  )
  assert.ok(Object.keys(registrations[0].dicts.en).length > 0)
})

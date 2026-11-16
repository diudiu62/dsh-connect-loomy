/**
 * jsdom harness for the settings-card tests.
 *
 * These tests exercise the *shipped* bundle (`lib/client.js`) the same way the
 * web client does: evaluate the `window.__ModuleLoader__.load({id, factory})`
 * wrapper, call the factory with a `require` table, hand the resulting `apply`
 * a fake cordis context, and mount the component the slot registry captured.
 * That keeps the tests honest about the loader wrapper, the externalized React
 * imports and the registration shape, none of which a source-only test would
 * cover.
 *
 * Nothing here talks to a real host or upstream: `installFetch` serves the
 * frozen route contract from plain objects and records the requests.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const nodeRequire = createRequire(import.meta.url)

let dom
let React
let ReactDOMClient
let clientExports

/** Create the DOM exactly once per test process. */
export async function setupDom() {
  if (dom !== undefined) return
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:3080/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  globalThis.window = window
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  React = nodeRequire('react')
  ReactDOMClient = nodeRequire('react-dom/client')
}

/** The DOM window (after {@link setupDom}). */
export function window() {
  if (dom === undefined) throw new Error('setupDom() must run first')
  return dom.window
}

/**
 * Load and evaluate the built client bundle. The factory's `require` table
 * provides exactly the platform seeds this plugin uses (React + jsx-runtime);
 * anything else fails loudly.
 */
export function loadClient() {
  if (clientExports !== undefined) return clientExports
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  const loaded = []
  const loaderWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
  }
  const context = {
    window: loaderWindow,
    console,
    Symbol,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  // Browser globals the card reads must resolve at call time, not at bundle
  // evaluation time (the registration test loads the bundle before any DOM).
  for (const key of ['document', 'navigator', 'fetch']) {
    Object.defineProperty(context, key, {
      configurable: true,
      get: () => {
        if (key === 'fetch') return (...args) => globalThis.fetch(...args)
        return globalThis[key]
      },
    })
  }
  vm.runInNewContext(source, context, { filename: 'lib/client.js' })
  if (loaded.length !== 1) throw new Error(`expected one loader registration, got ${loaded.length}`)
  const bundle = loaded[0]
  if (bundle.id !== 'dsh-connect-loomy') throw new Error(`unexpected bundle id ${bundle.id}`)
  clientExports = bundle.factory((id) => {
    if (id === 'react') return nodeRequire('react')
    if (id === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
    if (id === 'react/jsx-dev-runtime') return nodeRequire('react/jsx-dev-runtime')
    throw new Error(`unexpected runtime require(${id}) — the bundle must only use platform seeds`)
  })
  return clientExports
}

function interpolate(template, params) {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  )
}

/**
 * A minimal cordis context with the two services the client half touches.
 *
 * - `locale.register` captures the dictionaries and `bind` returns a `t` that
 *   renders Simplified Chinese (the tests assert zh copy);
 * - `slots.inject` synchronously answers for the declared
 *   `settings.section` slot and `register` records the entry;
 * - `inject(['slots'])` mirrors the real service-gated path.
 */
export function createFakeCtx(locale = 'zh') {
  const localeRegistrations = []
  const effects = []
  const entries = []
  const declared = new Set(['settings.section', 'conversation.input.right'])
  let dictionaries

  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    inject(deps, callback) {
      if (!Array.isArray(deps) || !deps.includes('slots')) {
        throw new Error(`unexpected ctx.inject(${JSON.stringify(deps)})`)
      }
      return callback(ctx)
    },
    locale: {
      register(ns, dicts) {
        localeRegistrations.push({ ns, dicts })
        dictionaries = dicts
        return () => {}
      },
      bind(ns) {
        return (key, params) => {
          const dictionary = dictionaries?.[locale] ?? dictionaries?.zh ?? {}
          return interpolate(dictionary[key] ?? key, params)
        }
      },
    },
    slots: {
      inject(key, callback) {
        if (!declared.has(key)) throw new Error(`slot ${key} is not declared in this harness`)
        return callback()
      },
      register(options, component) {
        const entry = { options, component }
        entry.dispose = () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
        entries.push(entry)
        return entry.dispose
      },
    },
  }

  return { ctx, localeRegistrations, effects, entries, declared }
}

/** Apply the client plugin and return the captured settings-tab entry + fake ctx. */
export function mountPlugin(locale = 'zh') {
  const exports = loadClient()
  const harness = createFakeCtx(locale)
  exports.apply(harness.ctx)
  const entry = harness.entries.find((candidate) => candidate.options.name === 'settings.section')
  if (entry === undefined) {
    throw new Error(
      `expected a settings.section registration, got ${harness.entries.map((e) => e.options.name).join(', ') || 'none'}`,
    )
  }
  const composerEntry = harness.entries.find(
    (candidate) => candidate.options.name === 'conversation.input.right',
  )
  const t = harness.ctx.locale.bind(entry.options.locale)
  return { exports, harness, entry, composerEntry, t }
}

/**
 * Install a fetch mock. `routes` maps a URL path to either
 * `{status?, body}` or a `(init, calls) => Response` function.
 */
export function installFetch(routes) {
  const calls = []
  const handler = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const route = routes[url]
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
  globalThis.fetch = handler
  if (dom !== undefined) dom.window.fetch = handler
  return calls
}

/** Await React work and the promise chains kicked off by effects. */
export async function flush() {
  await React.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * Mount the captured settings-tab component into a fresh container, run the
 * callback, then unmount and remove the container.
 */
export async function renderCard(entry, t, run, props = {}) {
  await setupDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await React.act(async () => {
    root.render(React.createElement(entry.component, { t, ...props }))
  })
  await flush()
  try {
    return await run({ container, root, window: dom.window })
  } finally {
    await React.act(async () => {
      root.unmount()
    })
    container.remove()
  }
}

/** Click an element inside act(). */
export async function click(element) {
  if (element === undefined || element === null) throw new Error('click() received no element')
  await React.act(async () => {
    element.click()
  })
  await flush()
}

/** Buttons whose trimmed text equals `text`. */
export function buttonsByText(container, text) {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent?.trim() === text)
}

/** The single button with this text. */
export function button(container, text) {
  const found = buttonsByText(container, text)
  if (found.length !== 1) {
    throw new Error(`expected exactly one button "${text}", got ${found.length}`)
  }
  return found[0]
}

/** The tab button with this text. */
export function tab(container, text) {
  const found = [...container.querySelectorAll('[role="tab"]')].filter(
    (element) => element.textContent?.trim() === text,
  )
  if (found.length !== 1) throw new Error(`expected one tab "${text}", got ${found.length}`)
  return found[0]
}

/** All model-row checkboxes in document order. */
export function modelCheckboxes(container) {
  return [...container.querySelectorAll('.loomy-model input[type="checkbox"]')]
}

/** Set `navigator.clipboard.writeText` and record what it received. */
export function stubClipboard(result = true) {
  const writes = []
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) {
        writes.push(text)
        if (!result) throw new Error('clipboard denied')
      },
    },
  })
  return writes
}

/** Build the route table used by most tests. */
export function defaultRoutes(overrides = {}) {
  return {
    '/plugins/dsh-connect-loomy/status': { body: STATUS },
    '/plugins/dsh-connect-loomy/credits': { body: CREDITS },
    '/plugins/dsh-connect-loomy/diagnostics': { body: DIAGNOSTICS },
    '/plugins/dsh-connect-loomy/auth/state': {
      body: {
        ok: true,
        pluginLoggedIn: false,
        effectiveSource: 'desktop',
        phone: '138****0000',
      },
    },
    '/plugins/dsh-connect-loomy/accounts': {
      body: {
        ok: true,
        accounts: [
          {
            id: 'desktop-1',
            slot: 1,
            route: 'loomy',
            displayName: 'Loomy',
            origin: 'desktop',
            phone: '138****0000',
          },
        ],
      },
    },
    '/plugins/dsh-connect-loomy/refresh': { body: CATALOG },
    '/plugins/dsh-connect-loomy/save': (init) => {
      const request = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, enabled: request.enabledModelIds }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    ...overrides,
  }
}

/** `/status` payload (contract v2) with deliberately hostile extras. */
export const STATUS = {
  ok: true,
  csrfToken: 'csrf-test-token',
  account: { phone: '13812345678', loginAt: 1794574693000, userId: 'userid-secret-42' },
  credential: {
    sourcePath: '/Users/test/Library/Application Support/loomy/auth-session.json',
    found: true,
  },
  catalog: { total: 3, enabled: 2, refreshedAt: 1794575000000 },
  enabledModelIds: ['spark-x2.6', 'DeepSeek-V4.1-Flash'],
  // Extras a buggy host might append; the card must never display them.
  session: 'deadbeefdeadbeefdeadbeefdeadbeef',
  phone: '13812345678',
}

/** `/credits` payload. */
export const CREDITS = {
  ok: true,
  balance: 35500,
  dailyBalance: 5000,
  availableBalance: 40500,
  fetchedAt: 1794575100000,
  records: [
    {
      description: '邀请好友奖励',
      direction: 'credit',
      pointsActual: 5000,
      createdAt: 1794574693000,
      balanceAfter: 40500,
    },
    {
      description: '对话消费',
      direction: 'debit',
      pointsActual: 120,
      createdAt: 1794574600000,
      balanceAfter: 40380,
    },
  ],
}

/** `/diagnostics` payload with the upstream error message kept verbatim. */
export const DIAGNOSTICS = {
  ok: true,
  probes: [
    {
      path: '/Users/test/Library/Application Support/loomy/auth-session.json',
      ok: true,
      reason: 'parsed',
    },
    { path: '/Users/test/.config/loomy/auth-session.json', ok: false, reason: 'ENOENT' },
  ],
  upstream: {
    baseUrl: 'https://loomyad.xunfei.cn/api/v1',
    modelsUrl: 'https://loomyad.xunfei.cn/api/v1/models',
    pointsUrl: 'https://loomyad.xunfei.cn/api/v1/points/records',
  },
  account: { phone: '13812345678', userId: 'userid-secret-42' },
  catalog: { total: 3, enabled: 2 },
  lastError: {
    at: 1794574800000,
    path: 'POST /api/v1/chat/completions',
    code: '100002',
    message: '缺少 token（上游原文，不得改写）',
  },
}

/** `/refresh` payload: three chat models, two enabled. */
export const CATALOG = {
  ok: true,
  refreshedAt: 1794575200000,
  catalog: [
    {
      id: 'spark-x2.6',
      name: 'Spark-X2.6 正式版(限时免费)(x0.0)',
      multiplier: 0,
      contextWindow: 1048576,
      maxOutput: 131072,
      vision: false,
      efforts: ['none', 'low', 'medium', 'high'],
      defaultEffort: 'low',
      enabled: true,
    },
    {
      id: 'DeepSeek-V4.1-Flash',
      name: 'DeepSeek V4.1 Flash(x2.0)',
      multiplier: 2,
      contextWindow: 1048576,
      maxOutput: 384000,
      vision: true,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
      enabled: true,
    },
    {
      id: 'GLM-5.3-Flash',
      name: 'GLM 5.3 Flash(x0.8)',
      multiplier: 0.8,
      contextWindow: 1048576,
      maxOutput: 131072,
      vision: true,
      efforts: ['low'],
      defaultEffort: 'low',
      enabled: false,
    },
  ],
}

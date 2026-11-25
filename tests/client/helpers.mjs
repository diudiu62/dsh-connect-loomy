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
export function setupDom() {
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

/**
 * 丢掉上一套 DOM，重新建一套。
 *
 * 流程测试要在同一个进程里渲染多次（每次点一串按钮）。React 的挂载与 act 队列
 * 在单一 document 上累积后，后面的渲染可能拿到一个空容器 —— 这是测试基建的问题，
 * 不是产品的问题。每个用例从一套新 DOM 开始就没有这个耦合。
 */
export async function resetDom() {
  /*
   * **复用同一个 window**，只清空文档内容。
   *
   * 早先每次用例都 close 掉旧 jsdom 再建新的——对纯 React 组件没问题，但
   * `react-dom` 在**初始化时**就记住了 document（bundle 顶层 require('react-dom')，
   * 与真实浏览器一致）。换掉 window 之后，事件系统还挂在那个已经被 close 的
   * document 上：点击不再触发、受控输入不再更新，症状是"点了没反应"，而不是报错。
   * 真实浏览器里 document 不会中途换人，这里也不该换。
   */
  setupDom()
  globalThis.document.head.innerHTML = ''
  globalThis.document.body.innerHTML = ''
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
  /*
   * bundle 顶层会 `require('react-dom')`（浮层要 portal），而 react-dom 在初始化
   * 时就需要一个 document：先建好 jsdom，否则它会按"无 DOM 环境"初始化，之后再
   * 渲染出来的组件事件与状态更新全部失效。
   */
  setupDom()
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
    // 浏览器有的计时器：登录倒计时用 setInterval，缺了它在沙箱里就是 ReferenceError。
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
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
  if (bundle.id !== 'dsh-connect-desktop') throw new Error(`unexpected bundle id ${bundle.id}`)
  clientExports = bundle.factory((id) => {
    if (id === 'react') return nodeRequire('react')
    if (id === 'react-dom') return nodeRequire('react-dom')
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
  const declared = new Set(['settings.section', 'settings.section.icon', 'conversation.input.right'])
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
    // Match by path first, the way a real server routes: a request may carry a
    // query (`?force=1`) that is not part of the route identity.
    const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]
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
  return [...container.querySelectorAll('.dcss-tick input[type="checkbox"]')]
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
  const base = '/plugins/dsh-connect-desktop'
  return {
    [`${base}/status`]: { body: STATUS },
    [`${base}/loomy/credits`]: { body: CREDITS },
    [`${base}/loomy/diagnostics`]: { body: DIAGNOSTICS },
    [`${base}/loomy/auth/state`]: {
      body: { ok: true, pluginLoggedIn: false, effectiveSource: 'desktop', phone: '138****0000' },
    },
    [`${base}/loomy/accounts`]: {
      body: {
        ok: true,
        rotating: false,
        accounts: [
          {
            id: 'desktop-1',
            route: 'loomy',
            displayName: 'Loomy',
            origin: 'desktop',
            phone: '138****0000',
            unavailable: false,
          },
        ],
      },
    },
    [`${base}/loomy/catalog`]: { body: CATALOG },
    [`${base}/loomy/refresh`]: { body: CATALOG },
    [`${base}/loomy/save`]: (init) => {
      const request = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, enabled: request.enabledModelIds }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    ...overrides,
  }
}

/** `/status`（新契约：一次拿到所有供应商）—— 故意多塞敏感字段，卡片不该显示。 */
export const VENDOR_STATUS = {
  id: 'loomy',
  displayName: 'Loomy',
  accent: '#2E6BE6',
  available: true,
  capabilities: {
    accounts: 'multi',
    pool: true,
    login: ['sms-code'],
    credits: {
      kind: 'balance',
      fields: [
        { key: 'available', labelKey: 'credits.field.available', role: 'available' },
        { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
        { key: 'total', labelKey: 'credits.field.total', role: 'total' },
      ],
    },
    catalog: { selection: true, visionOverride: true, reasoningEffort: true },
    transfer: true,
    adopt: true,
    diagnostics: true,
  },
  credential: {
    found: true,
    sourceOrigin: 'desktop',
    sourcePath: '/Users/test/Library/Application Support/loomy/auth-session.json',
    candidates: [],
  },
  account: { phone: '138****0000', loginAt: 1794574693000, userId: '1234**********5678', route: 'loomy' },
  catalog: { total: 3, enabled: 2, refreshedAt: 1794575000000 },
  enabledModelIds: ['spark-x2.6', 'DeepSeek-V4.1-Flash'],
}

/**
 * 用一份自定义能力构造 `/status` 载荷。
 *
 * 能力矩阵测试要逐个能力位开关，手抄整份载荷会漂移，所以集中在这里拼装：
 * 除 `capabilities` / `available` 外的字段取自 {@link VENDOR_STATUS}。
 */
export function buildStatus({ capabilities, available = true, vendorOverrides = {} }) {
  const vendor = {
    ...VENDOR_STATUS,
    ...vendorOverrides,
    capabilities,
    available,
    ...(available ? {} : { unavailableReason: '未检测到该客户端' }),
  }
  return { ok: true, csrfToken: 'csrf-test-token', vendors: [vendor] }
}

export const STATUS = {
  ok: true,
  csrfToken: 'csrf-test-token',
  vendors: [VENDOR_STATUS],
  // 有 bug 的宿主可能多塞这些；卡片绝不能显示。
  session: 'deadbeefdeadbeefdeadbeefdeadbeef',
  phone: '13812345678',
}

/** `/credits` payload. */
export const CREDITS = {
  ok: true,
  // 桶按能力声明的 key 给出；`records` 与 `perAccount` 可选。
  fields: { available: 40500, daily: 5000, total: 35500 },
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

/** `/diagnostics` 载荷（新契约：供应商一片，含逐字保留的上游错误）。 */
export const DIAGNOSTICS = {
  ok: true,
  id: 'loomy',
  displayName: 'Loomy',
  baseUrl: 'https://loomyad.xunfei.cn/api/v1/models',
  endpoints: [
    { label: 'models', url: 'https://loomyad.xunfei.cn/api/v1/models' },
    { label: 'points', url: 'https://loomyad.xunfei.cn/api/v1/points/records' },
  ],
  credential: {
    found: true,
    sourceOrigin: 'desktop',
    sourcePath: '/Users/test/Library/Application Support/loomy/auth-session.json',
    candidates: [
      { path: '/Users/test/Library/Application Support/loomy/auth-session.json', exists: true, state: 'ok', reason: '已读取' },
      { path: '/Users/test/.config/loomy/auth-session.json', exists: false, state: 'missing', reason: '文件不存在' },
    ],
  },
  account: { phone: '138****0000', userId: '1234**********5678' },
  inspected: [
    '/Users/test/Library/Application Support/loomy/auth-session.json',
    '/Users/test/.config/loomy/auth-session.json',
  ],
  probes: [
    { path: '/Users/test/Library/Application Support/loomy/auth-session.json', ok: true, reason: '已读取' },
    { path: '/Users/test/.config/loomy/auth-session.json', ok: false, reason: '文件不存在' },
  ],
  catalog: { total: 3, enabled: 2, refreshedAt: 1794575000000 },
  accounts: { total: 1, healthy: 1 },
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
  selection: null,
  models: [
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

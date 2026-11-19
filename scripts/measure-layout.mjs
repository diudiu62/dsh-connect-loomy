#!/usr/bin/env node
/**
 * 量布局，而不是"看图觉得乱"。
 *
 * jsdom 没有布局引擎（`getBoundingClientRect()` 全是 0），所以任何关于间距、对齐、
 * 截断的结论都必须在真实浏览器里量。这个脚本复用截图那套渲染（真实组件 + 真实
 * 样式表 + 宿主设计 token），在无头 Chrome 里量每个盒子的坐标，输出一行一个 JSON。
 *
 * 为什么需要它：设置卡片住在 600–700px 的设置页列里，而截图用的是 900px 宽视口
 * ——密度、换行、截断这些问题在截图里被稀释掉了。评审和回归都以这里输出的数字为准。
 *
 * 用法：
 *   node scripts/measure-layout.mjs                 # 700/600/500 三档
 *   node scripts/measure-layout.mjs --width 640     # 指定宽度
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/u, '')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

function chromePath() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
  throw new Error(`no Chrome/Chromium found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)
}

/**
 * 宿主的 alias token 解析成字面颜色。
 *
 * `mode: 'dark'` 取 `body[data-ds-dark-theme]{…}` 里的覆盖值，其余沿用浅色。
 * 卡片所有颜色都走 `--dsw-*` token，但"走 token"不等于"暗色下能读"。
 */
function hostTokens(mode) {
  const checkout =
    process.env['DSH_CHECKOUT'] ?? '/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh'
  const bundle = join(checkout, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
  if (!existsSync(bundle)) return ''
  const source = readFileSync(bundle, 'utf8')
  const staticColoursIn = (text) => {
    const map = new Map()
    for (const match of text.matchAll(/(--dsw-static-[a-z0-9-]+):(#[0-9a-fA-F]{3,8})/gu)) {
      if (!map.has(match[1])) map.set(match[1], match[2])
    }
    return map
  }

  // 暗色的 static 覆盖
  const darkStart = source.indexOf('body[data-ds-dark-theme]{')
  const lightStatic = staticColoursIn(darkStart === -1 ? source : source.slice(0, darkStart))
  const darkStatic = darkStart === -1 ? new Map() : staticColoursIn(source.slice(darkStart))
  const statics = mode === 'dark' ? new Map([...lightStatic, ...darkStatic]) : lightStatic

  // alias 映射**每个 key 有两份**：浅色一份、暗色一份（暗色把 bg-base 指向深色阶）。
  // 按 key 去重会永远取到浅色那份 —— 那一刻"暗色 token"就静默失效了。
  const aliases = new Map()
  for (const match of source.matchAll(/(--dsw-alias-[a-z0-9-]+):var\((--dsw-static-[a-z0-9-]+)\)/gu)) {
    const list = aliases.get(match[1])
    if (list === undefined) aliases.set(match[1], [match[2]])
    else list.push(match[2])
  }

  const declarations = []
  for (const [alias, targets] of aliases) {
    const target = mode === 'dark' ? targets[targets.length - 1] : targets[0]
    const colour = statics.get(target)
    if (colour !== undefined) declarations.push(`${alias}:${colour};`)
  }
  if (declarations.length === 0) return ''
  return mode === 'dark'
    ? `body[data-ds-dark-theme]{${declarations.join('')}}`
    : `:root{${declarations.join('')}}`
}

/** 在页面里跑的测量代码：把结果写进 <pre id="measure">。 */
const MEASURE = `
  const box = (el) => {
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const card = document.querySelector('.dcss-card')
  const header = document.querySelector('.dcss-header')
  const sections = [...document.querySelectorAll('.dcss-section')]
  // 事实表对齐：值的起始 x 是否共线（不同 x = 标签列宽不一致）
  const valueXs = [...new Set([...document.querySelectorAll('.dcss-value')]
    .map((el) => Math.round(el.getBoundingClientRect().x)))]
  // 账号行：金额右边缘是否共线
  const creditRight = [...document.querySelectorAll('.dcss-acct-credits')]
    .map((el) => Math.round(el.getBoundingClientRect().right))
  // 溢出检测：抽屉、任何横向滚动的容器
  const overflow = [...document.querySelectorAll('.dcss-drawer, .dcss-card')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => el.className)
  // 模型表：第一列（名字）宽度与行高——6 列时 600px 宽里名字只有 203px、换 3 行。
  const modelRows = [...document.querySelectorAll('.dcss-table-models tbody tr')]
  const firstCells = modelRows.map((row) => Math.round(row.cells[0].getBoundingClientRect().width))
  // ── 暗色可读性：WCAG 对比度。看不到图，只能量。──
  const parseRgb = (value) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/u.exec(value)
    if (m === null) return null
    const alpha = m[4] === undefined ? 1 : Number(m[4])
    return alpha < 0.5 ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const luminance = ([r, g, b]) => {
    const channel = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const contrast = (fg, bg) => {
    const a = luminance(fg)
    const b = luminance(bg)
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
  }
  /** 往上找到第一个"有背景色"的祖先，作为实际背景。 */
  const backgroundOf = (el) => {
    let node = el
    while (node !== null) {
      const colour = parseRgb(getComputedStyle(node).backgroundColor)
      if (colour !== null) return colour
      node = node.parentElement
    }
    return [255, 255, 255]
  }
  const contrastOf = (selector) => {
    try {
      const el = document.querySelector(selector)
      if (el === null) return 'missing'
      const fg = parseRgb(getComputedStyle(el).color)
      if (fg === null) return 'fg-unparsed'
      const bg = backgroundOf(el)
      if (bg === null) return 'bg-unparsed'
      const value = contrast(fg, bg)
      return Number.isFinite(value) ? value : 'nan:' + JSON.stringify(fg) + '/' + JSON.stringify(bg)
    } catch (error) {
      return 'throw:' + (error instanceof Error ? error.message : String(error))
    }
  }
  const rawColour = (() => {
    const el = document.querySelector('.dcss-title')
    return el === null ? null : getComputedStyle(el).color
  })()
  const contrastReport = {
    body: contrastOf('.dcss-card'),
    title: contrastOf('.dcss-title'),
    sectionTitle: contrastOf('.dcss-section-title'),
    hint: contrastOf('.dcss-hint'),
    mono: contrastOf('.dcss-mono'),
    tab: contrastOf('.dcss-tab[aria-selected="true"]'),
    summary: contrastOf('.dcss-summary-meta'),
  }

  const result = {
    contrast: contrastReport,
    rawColor: rawColour,
    cardHeight: card === null ? null : Math.round(card.getBoundingClientRect().height),
    headerHeight: header === null ? null : Math.round(header.getBoundingClientRect().height),
    firstSectionY: sections.length === 0 ? null : Math.round(sections[0].getBoundingClientRect().y),
    sectionCount: sections.length,
    sectionTitles: [...document.querySelectorAll('.dcss-section-title')].map((el) => el.textContent),
    valueStartX: valueXs,
    accountCreditRights: [...new Set(creditRight)],
    modelFirstColWidths: [...new Set(firstCells)],
    // 配置页：输入框宽度（表格布局时被三列挤到 ~180px）
    configFieldCount: document.querySelectorAll('[data-dcss-config]').length,
    configInputWidths: [...new Set([...document.querySelectorAll('[data-dcss-config] input')]
      .map((el) => Math.round(el.getBoundingClientRect().width)))],
    modelRowHeights: [...new Set(modelRows.map((row) => Math.round(row.getBoundingClientRect().height)))],
    overflow,
    // 账号行：高度与三格宽度——行被内容撑成多行时高度会翻倍。
    accountRows: [...document.querySelectorAll('.dcss-acct-row')].map((row) => ({
      h: Math.round(row.getBoundingClientRect().height),
      cells: [...row.children].map((cell) => Math.round(cell.getBoundingClientRect().width)),
    })),
    // 抽屉：声明 260px 曾经实际渲染 282px（content-box + padding/border），
    // 且靠左锚定时会向左溢出视口。这两条都只能量出来。
    drawer: (() => {
      const el = document.querySelector('.dcss-drawer')
      if (el === null) return null
      const rect = el.getBoundingClientRect()
      return {
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        overflowsLeft: rect.left < 0,
        overflowsRight: rect.right > window.innerWidth + 1,
      }
    })(),
    // 溢出时找出具体是谁：只报容器名等于让人猜。
    overflowDetail: [...document.querySelectorAll('.dcss-card *')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
      .slice(0, 6)
      .map((el) => ({ cls: el.className, scroll: el.scrollWidth, client: el.clientWidth })),
    // 横向溢出到视口外的元素（典型的 260px 抽屉算成 282px）
    offscreen: [...document.querySelectorAll('.dcss-card *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 5)
      .map((el) => el.className),
  }
  document.title = 'MEASURED'
  const out = document.createElement('pre')
  out.id = 'measure'
  out.textContent = JSON.stringify(result)
  document.body.appendChild(out)
`

/** 用与截图相同的管线渲染一张卡片，返回完整 HTML。 */
async function renderHtml(width, view, mode = 'light') {
  // jsdom 里渲染 React 会产生大量 "not wrapped in act(...)" 告警：它们来自
  // 面板自己的异步读，与测量无关，只会把输出淹掉。
  const originalError = console.error
  console.error = (...parts) => {
    const text = parts.map((part) => (typeof part === 'string' ? part : '')).join(' ')
    if (text.includes('not wrapped in act')) return
    originalError(...parts)
  }
  const { setupDom, mountPlugin, installFetch, renderCard, defaultRoutes } = await import(
    join(ROOT, 'tests/client/helpers.mjs')
  )
  const { buildStatus } = await import(join(ROOT, 'tests/client/helpers.mjs'))

  await setupDom()
  const { entry, composerEntry, t } = mountPlugin('zh')

  const capabilities = {
    accounts: 'multi',
    pool: true,
    login: ['sms-code'],
    credits: {
      kind: 'balance',
      ledger: true,
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
  }
  const accounts = {
    ok: true,
    rotating: false,
    activeId: 'a1',
    accounts: [
      { id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', label: '工作号', phone: '13800000001', unavailable: false },
      { id: 'a2', route: 'loomy-2', displayName: 'Loomy · 2', origin: 'plugin', phone: '13900000002', unavailable: false },
    ],
  }
  // 配置片：字段形状决定控件形态，所以四种类型各给一个。
  const configFields = {
    ok: true,
    vendorId: 'loomy',
    groups: [{ id: 'connection', labelKey: 'config.group.connection' }],
    fields: [
      { key: 'baseURL', type: 'string', group: 'connection', value: 'https://loomyad.xunfei.cn/api/v1', default: 'https://loomyad.xunfei.cn/api/v1', overridden: false, description: 'Loomy 平台 API 基地址（含 /api/v1）' },
      { key: 'creditsPageSize', type: 'number', value: 20, default: 20, overridden: false, description: '积分流水条数（1-100）' },
      { key: 'autoRotate', type: 'boolean', value: true, default: true, overridden: false, description: '自动轮换健康账号' },
      { key: 'visionModelIds', type: 'string-list', value: [], default: [], overridden: true, description: '强制按「能识图」提供的模型 id' },
    ],
  }
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': { body: accounts },
      '/plugins/dsh-connect-desktop/loomy/config': { body: configFields },
    }),
  )

  let markup = ''
  if (view === 'composer') {
    await renderCard(
      composerEntry,
      t,
      async ({ container }) => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        const pill = container.querySelector('.dcss-pill')
        pill?.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 120))
        // 抽屉向上、向左展开，所以给它左侧与下方的空间。
        markup = `<div style="padding:250px 0 0 300px">${container.innerHTML}</div>`
      },
      { useProjection: () => ({ next: { provider: 'loomy' } }) },
    )
  } else {
  await renderCard(entry, t, async ({ container }) => {
    for (let attempt = 0; attempt < 50 && !container.querySelector('[data-dcss-account]'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // 切到目标 tab（`--tab models|diagnostics`），默认账号页。
    if (view !== 'accounts') {
      const label = { models: '模型', diagnostics: '诊断', config: '配置' }[view]
      const target = [...container.querySelectorAll('[role="tab"]')].find(
        (element) => element.textContent?.trim() === label,
      )
      target?.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
      for (let attempt = 0; attempt < 40 && !container.querySelector('[data-dcss-cap="' + view + '"]'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    markup = container.innerHTML
  })
  }

  // 样式表直接 import 源文件（Node 22.18+ 原生剥离类型）。**不要吞掉失败**：
  // 拿到空 CARD_CSS 的测量结果是无意义的——它会在无样式状态下量出一堆假溢出。
  const { CARD_CSS } = await import(join(ROOT, 'src/client/styles.ts')).catch((error) => {
    throw new Error(
      `无法 import src/client/styles.ts（需要 Node ≥ 22.18 的类型剥离）：${error instanceof Error ? error.message : String(error)}`,
    )
  })
  if (typeof CARD_CSS !== 'string' || CARD_CSS.length < 1000) {
    throw new Error(`样式表过短（${String(CARD_CSS).length} 字符），测量结果不可信`)
  }
  const background = mode === 'dark' ? 'var(--dsw-alias-bg-base, #14161a)' : 'var(--dsw-alias-bg-base, #fff)'
  const foreground = mode === 'dark' ? 'var(--dsw-alias-label-primary, #e8eaed)' : 'var(--dsw-alias-label-primary, #1f2328)'
  return `<!doctype html><meta charset="utf8"><style>
${hostTokens(mode)}
html { background: ${background}; }
body { margin: 0; padding: 24px; background: ${background}; color: ${foreground};
       font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.dcss-card { width: ${width}px; }
${CARD_CSS}
</style><body${mode === 'dark' ? ' data-ds-dark-theme' : ''}>${markup}</body><script>${MEASURE}</script>`
}

/** 在无头 Chrome 里渲染并取回测量结果。 */
function measure(html) {
  const temp = join(tmpdir(), `dcss-measure-${process.pid}-${Math.random().toString(36).slice(2, 8)}.html`)
  const profile = join(tmpdir(), `dcss-measure-profile-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  writeFileSync(temp, html)
  try {
    const dom = execFileSync(
      chromePath(),
      [
        '--headless=new',
        '--disable-gpu',
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--window-size=1200,2400',
        '--virtual-time-budget=2500',
        '--dump-dom',
        `file://${temp}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const match = /<pre id="measure">([\s\S]*?)<\/pre>/u.exec(dom)
    if (match === null) throw new Error('measurement did not run (no #measure element)')
    // `--dump-dom` 会转义引号与尖括号。
    const text = match[1]
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
    return JSON.parse(text)
  } finally {
    rmSync(temp, { force: true })
    rmSync(profile, { recursive: true, force: true })
  }
}

/**
 * 对比度门禁：`--check-contrast` 时跑四个 tab × 两种主题，任何一个关键元素
 * 低于 WCAG AA 的 4.5:1 就退出码 1。
 *
 * 为什么单独一个开关：这条检查需要真实浏览器（jsdom 没有布局与计算样式），
 * 所以它不能住进 `node --test`；但它是可执行的，不是"记得看一眼"。
 */
const MIN_CONTRAST = 4.5

const args = process.argv.slice(2)
const widthArg = args.indexOf('--width')
const tabArg = args.indexOf('--tab')
const tabView = tabArg !== -1 ? (args[tabArg + 1] ?? 'accounts') : 'accounts'
const themeMode = args.includes('--dark') ? 'dark' : 'light'
const widths = widthArg !== -1 ? [Number(args[widthArg + 1])] : [700, 600, 500]

/**
 * 布局门禁：`--check-layout` 时在 340/380/460/600/700 五档宽度下渲染四个 tab，
 * 任何一个出现横向溢出就失败。
 *
 * 为什么需要它：380px 的溢出在 600px 上完全看不出来，而"三列固定宽度加起来
 * 超过容器"这种事只会在很窄的分屏里发生。这条规则踩过一次（容器查询写在
 * 基础规则之前，降级从未生效）。
 */
if (args.includes('--check-layout')) {
  const WIDTHS = [700, 600, 460, 380, 340]
  const TABS = ['accounts', 'models', 'diagnostics', 'config']
  const problems = []
  for (const width of WIDTHS) {
    for (const tab of TABS) {
      const html = await renderHtml(width, tab, 'light')
      const result = measure(html)
      if (result.overflow.length > 0) {
        problems.push(`${width}px/${tab}: 横向溢出 — ${result.overflowDetail.map((d) => `${d.cls}(${d.scroll}>${d.client})`).join(', ') || result.overflow.join(', ')}`)
      }
      if (result.offscreen.length > 0) {
        problems.push(`${width}px/${tab}: 元素溢出视口 — ${result.offscreen.join(', ')}`)
      }
      // 标题数量少于内容块 = 用户不知道自己在看什么。
      if (result.sectionCount > 0 && result.sectionTitles.length !== result.sectionCount) {
        problems.push(`${width}px/${tab}: ${result.sectionCount} 个 section 只有 ${result.sectionTitles.length} 个标题`)
      }
    }
  }
  if (problems.length === 0) {
    process.stdout.write(`layout ok: ${WIDTHS.length} 宽度 × ${TABS.length} tab，无溢出\n`)
    process.exit(0)
  }
  process.stderr.write(`layout regression —\n  ${problems.join('\n  ')}\n`)
  process.exit(1)
}

if (args.includes('--check-contrast')) {
  const failures = []
  for (const theme of ['light', 'dark']) {
    for (const tab of ['accounts', 'models', 'diagnostics', 'config']) {
      const html = await renderHtml(600, tab, theme)
      const { contrast } = measure(html)
      for (const [element, value] of Object.entries(contrast)) {
        // `missing` 表示这个 tab 没有该元素（例如账号页没有事实行），不算失败。
        if (typeof value !== 'number') continue
        if (value < MIN_CONTRAST) failures.push(`${theme}/${tab}/${element}=${value}`)
      }
    }
  }
  if (failures.length === 0) {
    process.stdout.write(`contrast ok: every measured element ≥ ${MIN_CONTRAST}:1\n`)
    process.exit(0)
  }
  process.stderr.write(`contrast below ${MIN_CONTRAST}:1 —\n  ${failures.join('\n  ')}\n`)
  process.exit(1)
}

for (const width of widths) {
  const html = await renderHtml(width, tabView, themeMode)
  process.stdout.write(`${JSON.stringify({ width, tab: tabView, mode: themeMode, ...measure(html) })}\n`)
}

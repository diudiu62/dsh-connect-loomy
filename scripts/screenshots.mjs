#!/usr/bin/env node
/**
 * Regenerate the storefront screenshots from the real components.
 *
 * The market reads `screenshots.json` at the repo root and shows those images on
 * the plugin's page. Rendering them from the actual React components (rather
 * than assembling mockups) means a screenshot cannot drift from the UI: to
 * update one, rebuild the client and re-run this script.
 *
 * Pipeline per shot:
 * 1. jsdom mounts the component exactly as the tests do;
 * 2. the markup is wrapped in a document with the plugin's own CSS **plus the
 *    host's real design tokens**, extracted from the installed theme bundle;
 * 3. headless Chrome screenshots that document.
 *
 * The fixture data is invented: a published screenshot must never carry a real
 * phone number or balance.
 *
 * Usage: node scripts/screenshots.mjs [--height-multiplier 1]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'docs', 'assets')

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
 * `mode: 'light'` 取第一套（`:root`），`'dark'` 取 `body[data-ds-dark-theme]` 里的
 * 覆盖值。之所以要两套：卡片所有颜色都走 `--dsw-*` token，但"走 token"不等于
 * "暗色下能读"——必须真的在暗色里渲染一次。
 */
function hostTokens(mode = 'light') {
  const checkout =
    process.env['DSH_CHECKOUT'] ?? '/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh'
  const bundle = join(checkout, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
  if (!existsSync(bundle)) return ''
  const source = readFileSync(bundle, 'utf8')

  /** 某一个主题块里的 `--dsw-static-*` 定义。 */
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

/* Fixtures: invented numbers only. */
const PHONE_A = '13800000001'
const PHONE_B = '13900000002'
const PHONE_DESKTOP = '13700000003'

const CREDITS = {
  ok: true,
  // 桶按能力声明的 key 给出：`available` 是主数字。
  fields: { available: 42000, daily: 5300, total: 36700 },
  fetchedAt: 1_794_810_151_000,
  perAccount: [
    { accountId: 'acc1', route: 'loomy', account: PHONE_A, fields: { available: 40500, daily: 5000, total: 35500 } },
    { accountId: 'acc2', route: 'loomy', account: PHONE_B, fields: { available: 1500, daily: 300, total: 1200 } },
  ],
  records: [
    {
      description: '模型调用扣分',
      direction: 'debit',
      pointsActual: 6,
      createdAt: 1_794_810_151_000,
      balanceAfter: 35500,
      model: 'deepseek-v4-flash-1017',
      source: { route: 'loomy', account: PHONE_A, accountId: 'acc1' },
    },
    {
      description: '模型调用扣分',
      direction: 'debit',
      pointsActual: 22,
      createdAt: 1_794_809_748_000,
      balanceAfter: 35506,
      model: 'glm-5.3-flash',
      source: { route: 'loomy', account: PHONE_B, accountId: 'acc2' },
    },
    {
      description: '邀请好友奖励',
      direction: 'credit',
      pointsActual: 5000,
      createdAt: 1_794_574_692_000,
      balanceAfter: 40500,
      source: { route: 'loomy', account: PHONE_A, accountId: 'acc1' },
    },
  ],
}

const ACCOUNTS = {
  ok: true,
  rotating: false,
  activeId: 'acc1',
  accounts: [
    { id: 'acc1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', label: '工作号', phone: PHONE_A, addedAt: 1_794_574_693_000, unavailable: false },
    { id: 'acc2', route: 'loomy-2', displayName: 'Loomy · 2', origin: 'plugin', phone: PHONE_B, addedAt: 1_794_810_000_000, unavailable: false },
    { id: 'desktop', route: 'loomy', displayName: 'Loomy', origin: 'desktop', phone: PHONE_DESKTOP, unavailable: false },
  ],
}

/** `/status`（新契约）：一次描述所有供应商的能力与状态。 */
const LOOMY = {
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
  },
  credential: {
    found: true,
    sourceOrigin: 'desktop',
    sourcePath: '~/Library/Application Support/loomy/auth-session.json',
    candidates: [
      { path: '~/Library/Application Support/loomy/auth-session.json', exists: true, state: 'ok', reason: '已读取' },
      { path: '~/.config/loomy/auth-session.json', exists: false, state: 'missing', reason: '文件不存在' },
    ],
  },
  account: { phone: PHONE_A, loginAt: 1_794_574_693_000, userId: '261113120739987535', route: 'loomy' },
  catalog: { total: 6, enabled: 6, refreshedAt: 1_794_810_000_000 },
  enabledModelIds: [],
}

const STATUS = { ok: true, csrfToken: 'csrf-screenshot', vendors: [LOOMY] }

const BASE = '/plugins/dsh-connect-desktop'

/** `/catalog`：三条模型，两条启用（模型页要能看出倍率与上下文）。 */
const CATALOG_FIXTURE = {
  ok: true,
  refreshedAt: 1_794_810_000_000,
  selection: null,
  models: [
    { id: 'spark-x2.6', name: 'Spark-X2.6 正式版(限时免费)(x0.0)', multiplier: 0, contextWindow: 1048576, maxOutput: 131072, vision: false, efforts: ['none', 'low', 'high'], defaultEffort: 'low', enabled: true },
    { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash(x2.0)', multiplier: 2, contextWindow: 1048576, maxOutput: 384000, vision: true, efforts: ['low', 'high'], defaultEffort: 'high', enabled: true },
    { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash(x0.8)', multiplier: 0.8, contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['low'], defaultEffort: 'low', enabled: false },
  ],
}

const ROUTE_FIXTURES = {
  [`${BASE}/status`]: { body: STATUS },
  [`${BASE}/loomy/pool`]: { body: { ok: true, enabled: false, active: false, total: 3, healthy: 3 } },
  [`${BASE}/loomy/accounts`]: { body: ACCOUNTS },
  [`${BASE}/loomy/credits`]: { body: CREDITS },
  [`${BASE}/loomy/catalog`]: { body: CATALOG_FIXTURE },
  [`${BASE}/loomy/config`]: {
    body: {
      ok: true,
      vendorId: 'loomy',
      groups: [
        { id: 'connection', labelKey: 'config.group.connection' },
        { id: 'cache', labelKey: 'config.group.cache' },
      ],
      fields: [
        { key: 'baseURL', type: 'string', group: 'connection', value: 'https://loomyad.xunfei.cn/api/v1', default: 'https://loomyad.xunfei.cn/api/v1', overridden: false, description: 'Loomy 平台 API 基地址（含 /api/v1）' },
        { key: 'creditsPageSize', type: 'number', group: 'cache', value: 20, default: 20, overridden: false, description: '积分流水条数（1-100）' },
        { key: 'visionModelIds', type: 'string-list', group: 'cache', value: [], default: [], overridden: true, description: '强制按「能识图」提供的模型 id' },
      ],
    },
  },
}

/** Mount one scenario and return `{ html, height }`. */
async function renderShot({ view, poolEnabled = true, mode = 'light' }) {
  const { setupDom, mountPlugin, installFetch, renderCard, defaultRoutes } = await import(
    join(root, 'tests/client/helpers.mjs')
  )
  await setupDom()
  const { entry, composerEntry, t } = mountPlugin('zh')
  installFetch(
    defaultRoutes({
      ...ROUTE_FIXTURES,
      // Each shot states the mode it illustrates: the drawer shows a chosen
      // account (rotation off, hence the tick), the list shows rotation on.
      [`${BASE}/loomy/pool`]: {
        body: { ok: true, enabled: poolEnabled, active: poolEnabled, total: 3, healthy: 3 },
      },
      [`${BASE}/loomy/accounts`]: {
        body: { ...ACCOUNTS, rotating: poolEnabled, ...(poolEnabled ? {} : { activeId: 'acc1' }) },
      },
    }),
  )

  const collected = []
  const collectStyles = () => {
    collected.push(
      ...[...globalThis.document.querySelectorAll('style')].map((node) => node.textContent ?? ''),
    )
  }
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const click = (node) => node?.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))

  let markup = ''
  if (view === 'drawer') {
    await renderCard(
      composerEntry,
      t,
      async ({ container }) => {
        await wait(40)
        click(container.querySelector('.dcss-pill'))
        await wait(80)
        collectStyles()
        // The drawer opens upward and leftwards from the badge, so the badge
        // needs room to its left and below it inside the frame.
        markup = `<div style="padding:250px 0 0 300px">${container.innerHTML}</div>`
      },
      { useProjection: () => ({ next: { provider: 'loomy' } }) },
    )
  } else {
    await renderCard(entry, t, async ({ container }) => {
      await wait(40)
      collectStyles()
      if (view === 'models' || view === 'diagnostics' || view === 'config') {
        const label = view === 'models' ? '模型' : view === 'diagnostics' ? '诊断' : '配置'
        const target = [...container.querySelectorAll('[role="tab"]')].find(
          (element) => element.textContent?.trim() === label,
        )
        target?.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
        await wait(60)
        collectStyles()
      }
      if (view === 'credits') {
        // Take the credits section itself rather than slicing the HTML string:
        // a substring cut leaves attribute fragments behind.
        // 额度区块按它自己的能力标记定位：按"最后一个 section"取会随面板增减而漂移。
        const credits = container.querySelector('[data-dcss-credits-kind]')
        markup = credits?.outerHTML ?? container.innerHTML
      } else {
        markup = container.innerHTML
      }
    })
  }

  const background = mode === 'dark' ? 'var(--dsw-alias-bg-base, #14161a)' : 'var(--dsw-alias-bg-base, #ffffff)'
  const foreground = mode === 'dark' ? 'var(--dsw-alias-label-primary, #e8eaed)' : 'var(--dsw-alias-label-primary, #1f2328)'
  return `<!doctype html><meta charset="utf8"><style>
${hostTokens(mode)}
body { margin: 0; padding: 24px; background: ${background}; color: ${foreground};
       font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
${collected.join('\n')}
</style><body${mode === 'dark' ? ' data-ds-dark-theme' : ''}>${markup}</body>`
}

/**
 * Screenshot one document to a PNG, trimming the frame to the content height.
 *
 * `--no-sandbox` + a throwaway `--user-data-dir` are not optional in practice:
 * the default profile is locked while a normal Chrome window is open (exit 1,
 * no PNG), and a sandboxed macOS session cannot start the GPU helper at all.
 * Both flags only affect this temporary, file:// document.
 */
function shoot(html, file, width, height) {
  const temp = join(tmpdir(), `dcss-shot-${process.pid}-${Math.random().toString(36).slice(2, 8)}.html`)
  const profile = join(tmpdir(), `dcss-shot-profile-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  writeFileSync(temp, html)
  try {
    execFileSync(
      chromePath(),
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--force-device-scale-factor=2',
        `--window-size=${width},${height}`,
        `--screenshot=${file}`,
        '--virtual-time-budget=1500',
        `file://${temp}`,
      ],
      { stdio: 'ignore' },
    )
  } finally {
    rmSync(temp, { force: true })
    rmSync(profile, { recursive: true, force: true })
  }
}

/**
 * Heights are explicit: headless Chrome captures the viewport, not the content,
 * so a generic tall window leaves a large empty area under the card.
 */
const SHOTS = [
  { name: 'dsh-connect-desktop-accounts.png', view: 'accounts', width: 900, height: 540 },
  { name: 'dsh-connect-desktop-drawer.png', view: 'drawer', width: 600, height: 360, poolEnabled: false },
  { name: 'dsh-connect-desktop-credits.png', view: 'credits', width: 900, height: 280 },
  { name: 'dsh-connect-desktop-models.png', view: 'models', width: 700, height: 520 },
  { name: 'dsh-connect-desktop-diagnostics.png', view: 'diagnostics', width: 700, height: 700 },
  { name: 'dsh-connect-desktop-config.png', view: 'config', width: 700, height: 640 },
  { name: 'dsh-connect-desktop-dark.png', view: 'accounts', width: 700, height: 900, mode: 'dark' },
]

mkdirSync(outDir, { recursive: true })
for (const shot of SHOTS) {
  const html = await renderShot(shot)
  const file = join(outDir, shot.name)
  shoot(html, file, shot.width, shot.height)
  console.log('✓', shot.name)
}

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

/** The host's alias tokens as literal colours (its first/light definition). */
function hostTokens() {
  const checkout =
    process.env['DSH_CHECKOUT'] ?? '/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh'
  const bundle = join(checkout, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
  if (!existsSync(bundle)) return ''
  const source = readFileSync(bundle, 'utf8')
  const staticColour = new Map()
  for (const match of source.matchAll(/(--dsw-static-[a-z0-9-]+):(#[0-9a-fA-F]{6})/gu)) {
    if (!staticColour.has(match[1])) staticColour.set(match[1], match[2])
  }
  const declarations = []
  const seen = new Set()
  for (const match of source.matchAll(/(--dsw-alias-[a-z0-9-]+):var\((--dsw-static-[a-z0-9-]+)\)/gu)) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    const colour = staticColour.get(match[2])
    if (colour !== undefined) declarations.push(`${match[1]}:${colour};`)
  }
  return declarations.length === 0 ? '' : `:root{${declarations.join('')}}`
}

/* Fixtures: invented numbers only. */
const PHONE_A = '13800000001'
const PHONE_B = '13900000002'
const PHONE_DESKTOP = '13700000003'

const CREDITS = {
  ok: true,
  balance: 36700,
  dailyBalance: 5300,
  availableBalance: 42000,
  fetchedAt: 1_794_810_151_000,
  perAccount: [
    { accountId: 'acc1', route: 'loomy', account: PHONE_A, balance: 35500, dailyBalance: 5000, availableBalance: 40500 },
    { accountId: 'acc2', route: 'loomy', account: PHONE_B, balance: 1200, dailyBalance: 300, availableBalance: 1500 },
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
  accounts: [
    { id: 'acc1', slot: 1, route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: PHONE_A, addedAt: 1_794_574_693_000 },
    { id: 'acc2', slot: 2, route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: PHONE_B, addedAt: 1_794_810_000_000 },
    { id: 'desktop-1', slot: 0, route: '', displayName: '桌面端', origin: 'desktop', phone: PHONE_DESKTOP },
  ],
  routes: [{ route: 'loomy', displayName: 'Loomy', origin: 'plugin', slot: 1 }],
}

/** `/status` rewritten so the whole screenshot describes one coherent state. */
const STATUS = {
  ok: true,
  csrfToken: 'csrf-screenshot',
  account: { phone: PHONE_A, loginAt: 1_794_574_693_000, userId: '261113120739987535', route: 'loomy' },
  credential: { sourcePath: '~/Library/Application Support/loomy/auth-session.json', found: true },
  catalog: { total: 6, enabled: 6, refreshedAt: 1_794_810_000_000 },
  enabledModelIds: [],
}

const ROUTE_FIXTURES = {
  '/plugins/dsh-connect-loomy/status': { body: STATUS },
  '/plugins/dsh-connect-loomy/pool': { body: { ok: true, enabled: true, accountCount: 2, active: true } },
  '/plugins/dsh-connect-loomy/accounts': { body: ACCOUNTS },
  '/plugins/dsh-connect-loomy/accounts/active': { body: { ok: true, activeId: 'acc1', rotating: false } },
  '/plugins/dsh-connect-loomy/credits': { body: CREDITS },
}

/** Mount one scenario and return `{ html, height }`. */
async function renderShot({ view, poolEnabled = true }) {
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
      '/plugins/dsh-connect-loomy/pool': {
        body: { ok: true, enabled: poolEnabled, accountCount: 2, active: poolEnabled },
      },
      '/plugins/dsh-connect-loomy/accounts/active': {
        body: { ok: true, activeId: 'acc1', rotating: poolEnabled },
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
        click(container.querySelector('.loomy-pill'))
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
      if (view === 'credits') {
        // Take the credits section itself rather than slicing the HTML string:
        // a substring cut leaves attribute fragments behind.
        const sections = [...container.querySelectorAll('.loomy-section')]
        markup = sections.at(-1)?.outerHTML ?? container.innerHTML
      } else {
        markup = container.innerHTML
      }
    })
  }

  return `<!doctype html><meta charset="utf8"><style>
${hostTokens()}
body { margin: 0; padding: 24px; background: var(--dsw-alias-bg-base, #ffffff);
       color: var(--dsw-alias-label-primary, #1f2328);
       font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
${collected.join('\n')}
</style>${markup}`
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
  const temp = join(tmpdir(), `loomy-shot-${process.pid}-${Math.random().toString(36).slice(2, 8)}.html`)
  const profile = join(tmpdir(), `loomy-shot-profile-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
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
  { name: 'dsh-connect-loomy-accounts.png', view: 'accounts', width: 900, height: 540 },
  { name: 'dsh-connect-loomy-drawer.png', view: 'drawer', width: 600, height: 360, poolEnabled: false },
  { name: 'dsh-connect-loomy-credits.png', view: 'credits', width: 900, height: 280 },
]

mkdirSync(outDir, { recursive: true })
for (const shot of SHOTS) {
  const html = await renderShot(shot)
  const file = join(outDir, shot.name)
  shoot(html, file, shot.width, shot.height)
  console.log('✓', shot.name)
}

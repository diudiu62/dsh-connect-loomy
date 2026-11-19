#!/usr/bin/env node
/**
 * 宿主设计 token 的唯一来源。
 *
 * 为什么要有这个模块：卡片所有颜色都写成 `var(--dsw-alias-*, <浅色兜底>)`。兜底值
 * 是"浅色下正确"的那一半，所以在**没有**宿主 token 的页面里渲染暗色主题，画出来的
 * 就是深底 + 深字：实测 1.15:1。CI 里没有装 DSH，两个渲染脚本（截图、量布局）各抄
 * 了一份 `hostTokens()`，各自 `return ''`，于是对比度门禁每次都在暗色上红一片，
 * 而那些失败和卡片本身毫无关系 —— 门禁把"缺 token"误报成了"对比度不够"。
 *
 * 所以：
 * 1. token 解析只有一份实现（本文件），截图与量布局都 import 它；
 * 2. 解析结果落一份快照（`scripts/theme-tokens.json`），CI 用快照渲染真实配色；
 * 3. **拿不到 token 就抛错**，绝不再返回空字符串 —— 空 token 的量测结果是无意义的，
 *    而这个"静默降级"正是上次误报的根因。
 *
 * 优先级：显式 `DSH_THEME_BUNDLE` > `DSH_CHECKOUT` > 仓库内 node_modules >
 * nvm / 全局 npm 安装的 DSH > 提交在仓库里的快照。
 *
 * 用法：
 *   node scripts/theme-tokens.mjs --show          # 打印来源与每个 token 的字面颜色
 *   node scripts/theme-tokens.mjs --update        # 从本机 bundle 重写快照
 *   node scripts/theme-tokens.mjs --check         # 快照与本机 bundle 是否一致（无 bundle 时跳过）
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 快照位置。提交进仓库：CI 没有 DSH 安装，靠它拿到真实的浅色/暗色两套字面颜色。 */
export const SNAPSHOT_PATH = join(here, 'theme-tokens.json')

const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme'
const THEME_BUNDLE = 'lib/client.js'

/** 一个安装目录下主题包可能在的两个位置：作为 DSH 的依赖，或它自己就是主题包。 */
function bundlesUnder(installRoot) {
  return [
    join(installRoot, 'node_modules', THEME_PACKAGE, THEME_BUNDLE),
    join(installRoot, THEME_BUNDLE),
  ]
}

/**
 * 候选 bundle 路径，按可信度排序。
 *
 * 不用 `createRequire().resolve` 是因为 `@deepseek-ai/dsh` 不是本仓库的依赖：它住在
 * 用户全局安装目录里，从仓库的 resolve 路径够不到。
 */
export function candidateBundlePaths(env = process.env) {
  const candidates = []
  if (env['DSH_THEME_BUNDLE'] !== undefined) candidates.push(env['DSH_THEME_BUNDLE'])
  if (env['DSH_CHECKOUT'] !== undefined) candidates.push(...bundlesUnder(env['DSH_CHECKOUT']))

  // 仓库自己的 node_modules（将来把主题包加进 devDependencies 时命中）
  candidates.push(join(root, 'node_modules', THEME_PACKAGE, THEME_BUNDLE))

  const home = env['HOME'] ?? homedir()
  // nvm：~/.nvm/versions/node/<ver>/lib/node_modules/@deepseek-ai/dsh
  // 多版本共存时优先当前进程的版本：主题包版本是跟着 DSH 走的，用错版本量出来的
  // 配色和用户实际看到的不是一套。
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  const versions = (() => {
    try {
      return readdirSync(nvmRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => Number(b === process.version) - Number(a === process.version) || b.localeCompare(a, undefined, { numeric: true }))
    } catch {
      return []
    }
  })()
  for (const version of versions) {
    candidates.push(
      ...bundlesUnder(join(nvmRoot, version, 'lib', 'node_modules', '@deepseek-ai', 'dsh')),
      join(nvmRoot, version, 'lib', 'node_modules', THEME_PACKAGE, THEME_BUNDLE),
    )
  }
  // 系统级的全局安装
  for (const prefix of ['/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules']) {
    candidates.push(...bundlesUnder(join(prefix, '@deepseek-ai', 'dsh')))
    candidates.push(join(prefix, THEME_PACKAGE, THEME_BUNDLE))
  }
  // Windows 的全局 npm
  if (env['APPDATA'] !== undefined) {
    candidates.push(...bundlesUnder(join(env['APPDATA'], 'npm', 'node_modules', '@deepseek-ai', 'dsh')))
    candidates.push(join(env['APPDATA'], 'npm', 'node_modules', THEME_PACKAGE, THEME_BUNDLE))
  }
  return candidates
}

/**
 * 从主题包源码里解析出**两套** alias → 字面颜色。
 *
 * 每个 alias key 在源码里出现两次：浅色一次（`:root` 前）、暗色一次
 * （`body[data-ds-dark-theme]` 起）。按 key 去重会永远取到浅色那份 —— 那一刻
 * "暗色 token"就静默失效了，所以这里按出现顺序取第一份/最后一份。
 */
export function extractTokens(source) {
  /** 某一主题块里的 `--dsw-static-*` 定义（全是字面 hex）。 */
  const staticColoursIn = (text) => {
    const map = new Map()
    for (const match of text.matchAll(/(--dsw-static-[a-z0-9-]+):(#[0-9a-fA-F]{3,8})/gu)) {
      if (!map.has(match[1])) map.set(match[1], match[2])
    }
    return map
  }

  const darkStart = source.indexOf('body[data-ds-dark-theme]{')
  const lightStatic = staticColoursIn(darkStart === -1 ? source : source.slice(0, darkStart))
  const darkStatic = darkStart === -1 ? new Map() : staticColoursIn(source.slice(darkStart))
  const darkStatics = new Map([...lightStatic, ...darkStatic])

  // alias 的值有四种写法，缺一种就会把那个 token 漏掉：
  //   #0000001a            —— 带 alpha 的字面色（**全部 border 都是这种**）
  //   var(--dsw-static-x)  —— 走色阶
  //   var(--dsw-alias-y)   —— 指向另一个 alias
  //   color-mix(...)       —— 混色
  // 上一版只认第二种，于是 114 个 alias 里只解析出 72 个：border-l1..l4 全丢，
  // 卡片在渲染页里退回浅色兜底的 rgba(15,23,42,…)，暗色下的边框其实不可见。
  const VALUE = /(--dsw-alias-[a-z0-9-]+):(#[0-9a-fA-F]{3,8}|rgba?\([^;}]*\)|color-mix\([^;}]*\)|var\(--dsw-(?:static|alias)-[a-z0-9-]+\))/gu
  const declarations = new Map()
  for (const match of source.matchAll(VALUE)) {
    const list = declarations.get(match[1])
    if (list === undefined) declarations.set(match[1], [match[2]])
    else list.push(match[2])
  }

  /**
   * `var(...)` 解成字面色，其余写法（hex / rgba / color-mix）原样保留交给浏览器。
   * alias → alias 的引用要顺着解下去，否则那 7 个"转手 token"在渲染页里还是空。
   */
  const resolveWith = (statics, pick) => {
    const raw = new Map()
    for (const [alias, values] of declarations) {
      const value = pick(values)
      if (value !== undefined) raw.set(alias, value)
    }
    const resolved = new Map()
    const resolveAlias = (alias, depth) => {
      if (resolved.has(alias)) return resolved.get(alias)
      const value = raw.get(alias)
      if (value === undefined || depth > 8) return null
      const reference = /^var\((--dsw-(?:static|alias)-[a-z0-9-]+)\)$/u.exec(value)
      const colour = reference === null
        ? value
        : reference[1].startsWith('--dsw-static-')
          ? statics.get(reference[1]) ?? null
          : resolveAlias(reference[1], depth + 1)
      if (colour !== null) resolved.set(alias, colour)
      return colour
    }
    const tokens = {}
    for (const alias of raw.keys()) {
      const colour = resolveAlias(alias, 0)
      if (colour !== null) tokens[alias] = colour
    }
    return tokens
  }

  return {
    statics: { light: Object.fromEntries(lightStatic), dark: Object.fromEntries(darkStatics) },
    light: resolveWith(lightStatic, (values) => values[0]),
    dark: resolveWith(darkStatics, (values) => values[values.length - 1]),
  }
}

/** 主题包版本，用来判断快照是否过期（读不到就 null，不阻断）。 */
function versionOf(bundlePath) {
  try {
    const manifest = JSON.parse(readFileSync(join(bundlePath, '..', '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** 第一个存在的 bundle，没有则 null。 */
export function locateBundle(env = process.env) {
  for (const candidate of candidateBundlePaths(env)) {
    if (candidate !== undefined && existsSync(candidate)) {
      return { path: candidate, version: versionOf(candidate) }
    }
  }
  return null
}

export function readSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    if (typeof parsed?.light !== 'object' || typeof parsed?.dark !== 'object') return null
    if (Object.keys(parsed.light).length === 0 || Object.keys(parsed.dark).length === 0) return null
    if (typeof parsed?.statics?.light !== 'object' || typeof parsed?.statics?.dark !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

let cached = null

/**
 * 本次进程使用的 token。
 *
 * @returns {{ light: Record<string,string>, dark: Record<string,string>,
 *             origin: { kind: 'bundle' | 'snapshot', detail: string, version: string | null } }}
 */
export function loadThemeTokens(env = process.env) {
  if (cached !== null) return cached
  const bundle = locateBundle(env)
  if (bundle !== null) {
    const tokens = extractTokens(readFileSync(bundle.path, 'utf8'))
    cached = { ...tokens, origin: { kind: 'bundle', detail: bundle.path, version: bundle.version } }
    return cached
  }
  const snapshot = readSnapshot()
  if (snapshot !== null) {
    cached = {
      statics: snapshot.statics,
      light: snapshot.light,
      dark: snapshot.dark,
      origin: { kind: 'snapshot', detail: SNAPSHOT_PATH, version: snapshot.version ?? null },
    }
    return cached
  }
  throw new Error(
    [
      '拿不到宿主设计 token，拒绝在不真实的配色下渲染。',
      '  - 装 DSH（本机开发）或让脚本读到主题包：DSH_THEME_BUNDLE=<…/dsh-client-ui-theme/lib/client.js>',
      '  - 或提交快照：node scripts/theme-tokens.mjs --update',
      '  试过的路径：',
      ...candidateBundlePaths(env).map((candidate) => `    ${candidate}`),
    ].join('\n'),
  )
}

/** token → 一段 CSS。暗色写成 body 属性选择器，与宿主的主题切换方式一致。 */
export function tokensToCss(tokens, mode) {
  // 顺序有意义：alias 里的 `var(--dsw-static-*)` / `color-mix(...)` 要靠前面声明的
  // 色阶解析。只写 alias 的那一版，凡是引用色阶的 token 都会退回兜底值。
  const order = mode === 'dark' ? [tokens.statics.dark, tokens.dark] : [tokens.statics.light, tokens.light]
  const declarations = order
    .flatMap((group) => Object.entries(group))
    .map(([name, value]) => `${name}:${value};`)
    .join('')
  return mode === 'dark' ? `body[data-ds-dark-theme]{${declarations}}` : `:root{${declarations}}`
}

/** 渲染脚本要的那段 CSS；`mode` 取 `light` | `dark`。 */
export function hostTokens(mode = 'light') {
  const tokens = loadThemeTokens()
  return tokensToCss(tokens, mode === 'dark' ? 'dark' : 'light')
}

/** 内容指纹：快照与 bundle 是否同源，只比颜色本身，不比时间戳。 */
function fingerprint(tokens) {
  const sorted = Object.fromEntries(Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16)
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
/** 作为模块被 import 时不解析参数，更不打印 —— 调用方要的是函数，不是命令行。 */
const argv = invokedDirectly ? process.argv.slice(2) : []
if (argv.includes('--show')) {
  const { light, dark, origin } = loadThemeTokens()
  process.stdout.write(
    `source: ${origin.kind} — ${origin.detail}${origin.version === null ? '' : ` (${origin.version})`}\n` +
      `aliases: light=${Object.keys(light).length} dark=${Object.keys(dark).length}\n` +
      `fingerprint: light=${fingerprint(light)} dark=${fingerprint(dark)}\n`,
  )
  for (const key of Object.keys(light).sort()) {
    const mark = dark[key] !== light[key] ? '≠' : '='
    process.stdout.write(`  ${key} light=${light[key]} ${mark} dark=${dark[key] ?? '(absent)'}\n`)
  }
} else if (argv.includes('--update')) {
  const bundle = locateBundle()
  if (bundle === null) {
    process.stderr.write(
      `找不到主题包，无法更新快照。\n试过：\n  ${candidateBundlePaths().join('\n  ')}\n` +
        '用 DSH_THEME_BUNDLE 直接指定 client.js 路径也可以。\n',
    )
    process.exit(1)
  }
  const { statics, light, dark } = extractTokens(readFileSync(bundle.path, 'utf8'))
  const previous = readSnapshot()
  const payload = {
    $comment:
      '由 scripts/theme-tokens.mjs --update 生成，勿手改。CI 没有 DSH 安装，渲染脚本靠这份快照拿到真实的浅色/暗色配色。',
    package: THEME_PACKAGE,
    version: bundle.version,
    statics,
    light,
    dark,
  }
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`)
  const changed = previous === null
    ? null
    : Object.keys(light).filter((key) => previous.light?.[key] !== light[key]).length +
      Object.keys(dark).filter((key) => previous.dark?.[key] !== dark[key]).length
  process.stdout.write(
    `快照已写入 ${SNAPSHOT_PATH}\n  来源 ${bundle.path}${bundle.version === null ? '' : ` (${bundle.version})`}\n` +
      `  alias light=${Object.keys(light).length} dark=${Object.keys(dark).length}\n` +
      (changed === null ? '  之前没有快照\n' : `  与旧快照相比变化 ${changed} 处\n`),
  )
} else if (argv.includes('--check')) {
  const bundle = locateBundle()
  if (bundle === null) {
    process.stdout.write('跳过：本机没有主题包，无法比对快照\n')
    process.exit(0)
  }
  const snapshot = readSnapshot()
  if (snapshot === null) {
    process.stderr.write(`缺少快照 ${SNAPSHOT_PATH}；运行 node scripts/theme-tokens.mjs --update\n`)
    process.exit(1)
  }
  const live = extractTokens(readFileSync(bundle.path, 'utf8'))
  const drift = []
  for (const mode of ['light', 'dark']) {
    for (const key of new Set([...Object.keys(live[mode]), ...Object.keys(snapshot[mode] ?? {})])) {
      if (live[mode][key] !== snapshot[mode]?.[key]) {
        drift.push(`${mode}/${key}: 快照=${snapshot[mode]?.[key] ?? '(absent)'} bundle=${live[mode][key] ?? '(absent)'}`)
      }
    }
  }
  if (drift.length > 0) {
    process.stderr.write(`快照与主题包不一致（${drift.length} 处）——运行 --update 重生成：\n  ${drift.join('\n  ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`快照与 ${THEME_PACKAGE}${bundle.version === null ? '' : `@${bundle.version}`} 一致\n`)
} else if (invokedDirectly) {
  const { light, dark, origin } = loadThemeTokens()
  process.stdout.write(
    `source: ${origin.kind} — ${origin.detail}${origin.version === null ? '' : ` (${origin.version})`}\n` +
      `aliases: light=${Object.keys(light).length} dark=${Object.keys(dark).length}\n` +
      `fingerprint: light=${fingerprint(light)} dark=${fingerprint(dark)}\n`,
  )
}

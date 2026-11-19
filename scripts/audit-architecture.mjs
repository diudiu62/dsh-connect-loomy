#!/usr/bin/env node
/**
 * 架构门禁：把"新增供应商不用改核心"这条主张变成**机器可判**的检查。
 *
 * 这四条规则写在 `docs/product/vendor-capability-architecture.md` §10，但之前只有
 * 文档没有实现——而"没有门禁的一致性"正是上一版两家供应商各写一套 UI 的成因。
 *
 * | 规则 | 为什么 |
 * --- | --- |
 * | `core/` 与 `vendor-sdk/` 内零 vendor 字面量 | 那里应该是"所有供应商的公共部分" |
 * | `client/` 内零 `vendor === '...'` 分支 | 卡片按能力位渲染，不认供应商名 |
 * | `vendors/<id>/` 不 import 另一个 `vendors/<id2>/` | 否则等于把两家的协议耦合起来 |
 * | 每类重复常量只有一份 | `DISQUALIFYING` / `INERT_AUTH` / 图片预算 |
 *
 * 用法：`node scripts/audit-architecture.mjs`（CI 里在测试之前跑，失败即阻塞）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/u, '')

/** 递归收集某个目录下的源码文件。 */
function sources(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
    }
  }
  walk(join(ROOT, dir))
  return out
}

/** 已挂载的供应商 id：从 vendors 目录名读，避免再维护一张名单。 */
function vendorIds() {
  return readdirSync(join(ROOT, 'src/vendors')).filter((entry) =>
    statSync(join(ROOT, 'src/vendors', entry)).isDirectory(),
  )
}

const failures = []

/** 记录一次违规。 */
function fail(rule, file, line, detail) {
  failures.push({ rule, file: relative(ROOT, file), line, detail })
}

/**
 * 只匹配**代码里的字符串字面量**，不匹配注释与文档。
 *
 * 注释里出现供应商名是正常且必要的（"Raccoon 的网关不校验 effort"这类事实必须
 * 写在附近）。误报会让门禁被关掉，那比没有门禁更糟。
 */
function codeLines(text) {
  return text.split('\n').map((line, index) => ({ line, number: index + 1 }))
}

/** 粗略剥离行注释与块注释状态（够用：我们只要不在注释里误报）。 */
function stripComments(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) {
        out.push('')
        continue
      }
      line = line.slice(end + 2)
      inBlock = false
    }
    const start = line.indexOf('/*')
    if (start !== -1) {
      const end = line.indexOf('*/', start + 2)
      if (end === -1) {
        inBlock = true
        line = line.slice(0, start)
      } else {
        line = line.slice(0, start) + line.slice(end + 2)
      }
    }
    const slashes = line.indexOf('//')
    // `://` 出现在 URL 字符串里，不是注释起点。
    if (slashes !== -1 && line[slashes - 1] !== ':') line = line.slice(0, slashes)
    out.push(line)
  }
  return out.join('\n')
}

// ── 规则 1：core/ 与 vendor-sdk/ 内零 vendor 字面量 ────────────────────────
{
  const ids = vendorIds()
  const targets = [...sources('src/core'), ...sources('src/vendor-sdk')]
  for (const file of targets) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const { line, number } of codeLines(text)) {
      for (const id of ids) {
        // 匹配 `'loomy'` / `"loomy"`，但放过 `dsh-connect-loomy` 这类产品名。
        const pattern = new RegExp(`(['"\`])${id}\\1`, 'u')
        if (pattern.test(line)) {
          fail('core-vendor-literal', file, number, `core 出现供应商字面量 ${JSON.stringify(id)}：${line.trim()}`)
        }
      }
    }
  }
}

// ── 规则 2：client/ 内零 `vendor === '...'` 分支 ───────────────────────────
{
  const targets = sources('src/client')
  for (const file of targets) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const { line, number } of codeLines(text)) {
      // 只抓"拿供应商名做判断"的形态；`vendor === undefined` 是对 null 的检查，合法。
      if (/\bvendor(?:Id)?\s*===\s*['"`]/u.test(line)) {
        fail('client-vendor-branch', file, number, `客户端按供应商名分支：${line.trim()}`)
      }
    }
  }
}

// ── 规则 3：vendors/<id>/ 不 import 另一个供应商 ──────────────────────────
{
  const ids = vendorIds()
  for (const id of ids) {
    for (const file of sources(join('src/vendors', id))) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const { line, number } of codeLines(text)) {
        for (const other of ids) {
          if (other === id) continue
          if (new RegExp(`vendors/${other}/`, 'u').test(line)) {
            fail('vendor-cross-import', file, number, `${id} 引用了 ${other}：${line.trim()}`)
          }
        }
      }
    }
  }
}

// ── 规则 4：每类重复常量只有一份 ─────────────────────────────────────────
{
  /** 找出某个标识符在多少文件里被**定义**（不是引用）。 */
  const definitions = (name) => {
    const pattern = new RegExp(`(?:const|function|class)\\s+${name}\\b`, 'u')
    const hits = []
    for (const file of sources('src')) {
      const text = stripComments(readFileSync(file, 'utf8'))
      if (pattern.test(text)) hits.push(relative(ROOT, file))
    }
    return hits
  }

  for (const name of ['DISQUALIFYING', 'INERT_AUTH', 'REQUEST_IMAGE_BUDGETS', 'STREAM_IDLE_TIMEOUT_MS']) {
    const hits = definitions(name)
    if (hits.length > 1) {
      fail('duplicate-constant', join(ROOT, hits[1]), 0, `${name} 有 ${hits.length} 份定义：${hits.join(', ')}`)
    }
  }
}

/**
 * 规则五：CSS 模板字符串不能被一个反引号截断。
 *
 * `styles.ts` 把整张样式表放在一个模板字符串里（bundle 不需要 CSS 运行时）。
 * 代价是：注释或声明里出现一个反引号 / `${`，字符串就提前结束——`tsc` 只在
 * "有空插值的那一行"报一个很难读的错，而**整段样式会静默消失**。
 *
 * 这条规则在开发过程中被抓到 8 次。放进 audit 是因为它在 `pnpm run check` 的
 * 最前面跑：不用等构建和 200 多个测试跑完才发现。
 */
function checkStylesheet() {
  const file = join(ROOT, 'src/client/styles.ts')
  const source = readFileSync(file, 'utf8')
  const marker = 'export const CARD_CSS = `'
  const start = source.indexOf(marker)
  if (start === -1) {
    fail('stylesheet', file, 0, '找不到 CARD_CSS 模板字符串')
    return
  }
  const bodyStart = start + marker.length
  const end = source.indexOf('`', bodyStart)
  if (end === -1) {
    fail('stylesheet', file, 0, 'CARD_CSS 模板字符串没有结束')
    return
  }
  /*
   * 注意：`body` 是"到第一个反引号为止"，所以它内部永远不会出现反引号——
   * 直接在里面找反引号是抓不到截断的（这条检查的第一版就是这么失效的）。
   *
   * 真正可判的信号是**截断后的形状**：
   * 1. 正常样式表以 `}` 结尾；截断在注释/声明中间时结尾是别的字符。
   * 2. `/*` 与 `*​/` 的数量必须相等。
   * 3. 不能出现 `${`（它会被当成插值，同样截断）。
   */
  const body = source.slice(bodyStart, end)
  const lineOf = (index) => source.slice(0, bodyStart + index).split('\n').length
  const trimmed = body.trimEnd()
  if (trimmed.length > 0 && !trimmed.endsWith('}')) {
    const at = body.lastIndexOf('\n') + 1
    fail(
      'stylesheet',
      file,
      lineOf(at),
      `样式表没有以 \`}\` 结尾（多半是被一个反引号截断了）：…${JSON.stringify(trimmed.slice(-40))}`,
    )
  }
  const opens = (body.match(/\/\*/gu) ?? []).length
  const closes = (body.match(/\*\//gu) ?? []).length
  if (opens !== closes) {
    fail('stylesheet', file, 0, `注释不配对（/* ${opens} 个，*/ ${closes} 个）——某个块可能被截断`)
  }
  const interpolation = body.indexOf('${')
  if (interpolation !== -1) {
    fail('stylesheet', file, lineOf(interpolation), '模板字符串里出现 ${（会被当成插值）')
  }
  const corruption = body.indexOf('\uFFFD')
  if (corruption !== -1) {
    fail('stylesheet', file, lineOf(corruption), '出现替换字符（编码损坏，整条规则会失效）')
  }
  const balance = [...body].reduce((depth, char) => (char === '{' ? depth + 1 : char === '}' ? depth - 1 : depth), 0)
  if (balance !== 0) {
    fail('stylesheet', file, 0, `大括号不配平（差 ${balance}）——多半是某个块被误删`)
  }
}

checkStylesheet()

// ── 报告 ─────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  process.stdout.write(
    '架构门禁通过：core 无供应商字面量、客户端无供应商分支、无跨供应商引用、无重复常量、样式表完整。\n',
  )
  process.exit(0)
}

process.stderr.write(`架构门禁失败（${failures.length} 处）：\n`)
for (const { rule, file, line, detail } of failures) {
  process.stderr.write(`  [${rule}] ${file}${line === 0 ? '' : `:${line}`} — ${detail}\n`)
}
process.stderr.write(
  '\n这条门禁存在的原因：上一版两家供应商各写一套路由与 UI，功能靠人记得才没丢。\n' +
    '要让新增供应商不需要改核心，就得让"改了核心"这件事在 CI 里当场失败。\n',
)
process.exit(1)
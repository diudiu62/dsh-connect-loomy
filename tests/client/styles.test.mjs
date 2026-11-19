/**
 * 样式表的静态检查：有没有人会悄悄截断那段模板字符串。
 *
 * `styles.ts` 把整张 CSS 放在一个模板字符串里（bundle 不需要 CSS 运行时）。
 * 代价是：注释或声明里出现一个反引号 / `${` / 不可见字符，字符串就会提前结束，
 * 而 `tsc` 只在"有空插值的那一行"报一个很难读的错。这个坑在本项目里踩了三次，
 * 两次的后果都是整段样式静默丢失。
 *
 * 所以这里做两件事：
 * 1. 逐字节检查模板字符串体里没有反引号和 `${`；
 * 2. 检查每个 `dcss-*` 类在样式表与组件之间**双向对齐**（用了没定义 = 无样式渲染，
 *    定义了没用 = 死规则）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = new URL('../..', import.meta.url).pathname
const STYLES = join(ROOT, 'src/client/styles.ts')

/** 取出模板字符串的正文（`export const CARD_CSS = \`…\`` 之间的内容）。 */
function cssBody() {
  const source = readFileSync(STYLES, 'utf8')
  const marker = 'export const CARD_CSS = `'
  const start = source.indexOf(marker)
  assert.ok(start !== -1, 'CARD_CSS is still a template literal')
  const bodyStart = start + marker.length
  // 从标记处向后找**第一个**反引号：模板字符串本身不含反引号，所以那就是结尾。
  // （用 lastIndexOf 会跑到文件末尾的其它代码里，实测踩过一次。）
  const end = source.indexOf('`', bodyStart)
  assert.ok(end > bodyStart, 'the template literal is terminated')
  return source.slice(bodyStart, end)
}

/** 样式表里声明的每个 `.dcss-*` 类。 */
function definedClasses(body) {
  return new Set([...body.matchAll(/\.(dcss-[a-z0-9-]+)/gu)].map((match) => match[1]))
}

/** 递归列出组件文件（不依赖 Node 的 globSync，版本差异少踩一个坑）。 */
function tsxFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...tsxFiles(path))
    else if (entry.name.endsWith('.tsx')) found.push(path)
  }
  return found
}

/**
 * 组件里用到的每个 `dcss-*` 类名。
 *
 * 只忽略**带 `data-` 前缀**的出现（`data-dcss-config` 里的 `dcss-config` 是属性名，
 * 不是类名）。不能用"把这些名字整体排除"的做法：`dcss-field` / `dcss-config` 这种
 * 名字可能**既是**真实类名**又是** data 属性后缀，一刀切会把它从"已使用"里删掉，
 * 于是真实的类名被误报成死规则。
 */
function usedClasses() {
  const used = new Set()
  for (const file of tsxFiles(join(ROOT, 'src/client'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?<!data-)\b(dcss-[a-z0-9-]+)\b/gu)) used.add(match[1])
  }
  // `--dcss-accent` 是 CSS 变量，不是类名。
  used.delete('dcss-accent')
  return used
}

test('the stylesheet template holds no stray backtick or interpolation', () => {
  const body = cssBody()
  assert.equal(body.includes('${'), false, '`${` would be parsed as an interpolation')
  assert.equal(
    [...body].filter((char) => char === '`').length,
    0,
    'a backtick inside the CSS ends the template literal early',
  )
})

test('the stylesheet carries no replacement or control characters', () => {
  const body = cssBody()
  // U+FFFD 是编码损坏的标志：一个坏字节就能让整条规则失效，而且肉眼很难发现。
  assert.equal(body.includes('\uFFFD'), false, 'replacement characters break the rule they sit in')
  const control = [...body].filter((char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x09 || (code > 0x0d && code < 0x20 && code !== 0x1b)
  })
  assert.deepEqual(control, [], 'no stray control characters')
})

test('every class a component uses has a rule, and every rule is used', () => {
  const defined = definedClasses(cssBody())
  const used = usedClasses()

  const missing = [...used].filter((name) => !defined.has(name)).sort()
  const dead = [...defined].filter((name) => !used.has(name)).sort()

  assert.deepEqual(missing, [], `这些类在组件里用了却没有样式（会以无样式渲染）：${missing.join(', ')}`)
  assert.deepEqual(dead, [], `这些规则没有任何组件在使用（死规则）：${dead.join(', ')}`)
})

test('the card root class matches the stylesheet', () => {
  // 曾经 `.dcss-card` 定义了排版与品牌变量，而 Card.tsx 渲染的是 `.dcss-root`，
  // 于是整张卡片在真机上完全无样式。
  const card = readFileSync(join(ROOT, 'src/client/components/Card.tsx'), 'utf8')
  const rootClass = /className="(dcss-[a-z-]+)"/u.exec(card)?.[1]
  assert.equal(rootClass, 'dcss-card', 'the card root uses the class the stylesheet defines')
  assert.ok(definedClasses(cssBody()).has('dcss-card'))
})

test('the card injects its own stylesheet', () => {
  // 卡片不注入样式表时，只有输入框旁的小徽标会注入，于是"看起来像能用"。
  const card = readFileSync(join(ROOT, 'src/client/components/Card.tsx'), 'utf8')
  assert.match(card, /ensureStyles\(\)/u, 'the settings card must inject the sheet itself')
})

/**
 * 容器查询必须排在它所覆盖的基础规则**之后**。
 *
 * 同优先级下后写的赢：`@container` 写在 `.dcss-ledger-row { grid-template-columns }`
 * 前面时，窄屏降级完全不生效——而且没有任何可见症状，只有在 380px 宽度下才会
 * 看到横向溢出。这条规则踩过一次，用顺序断言钉住。
 */
test('container queries come after the rules they override', () => {
  const body = cssBody()
  const firstContainer = body.indexOf('@container')
  assert.ok(firstContainer !== -1, 'the stylesheet uses container queries')

  // 被容器查询覆盖的基础选择器：它们必须全部出现在第一个 @container 之前。
  for (const selector of ['.dcss-ledger-row', '.dcss-field', '.dcss-footer', '.dcss-table-models']) {
    const base = body.indexOf(`${selector} {`)
    if (base === -1) continue
    assert.ok(
      base < firstContainer,
      `${selector} 的基础规则必须排在 @container 之前，否则窄屏降级会被覆盖`,
    )
  }
})

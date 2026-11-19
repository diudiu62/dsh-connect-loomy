/**
 * 宿主设计 token 的单元门禁 —— 不需要浏览器。
 *
 * 这里守的是"配色真的存在、且真的够读"这两件事。浏览器门禁
 * （`node scripts/measure-layout.mjs --check-contrast`）量的是渲染结果，但它在
 * 拿不到宿主 token 时曾经静默降级成空配色，把"环境缺件"报成 24 条假失败。
 * 所以把可离线判定的部分搬进 `node --test`：
 *
 * 1. 快照存在、两套主题都在、颜色都是字面值；
 * 2. 卡片真正依赖的那几个 alias 都在，且浅色/暗色不是同一份；
 * 3. 卡片里成对出现的 前景/背景 组合，在两种主题下都达到 WCAG AA；
 * 4. 本机装了主题包时，快照必须与它一致（主题包升级后快照过期 = 门禁量的是旧配色）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  SNAPSHOT_PATH,
  extractTokens,
  locateBundle,
  loadThemeTokens,
  readSnapshot,
} from '../scripts/theme-tokens.mjs'

/** alias 的值可以是字面色、rgba 或 color-mix（宿主三种都用）。 */
const COLOUR = /^(#[0-9a-fA-F]{3,8}|rgba?\(|color-mix\()/u
const MIN = 4.5

/** 卡片依赖的 alias：缺任何一个，对应文字就退回浅色兜底，暗色下不可读。 */
const REQUIRED = [
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  // border 是 hex+alpha 写法。它曾经因为"只认 var(--dsw-static-*)"被整族丢掉，
  // 于是渲染页里所有边框都退回浅色兜底 —— 暗色下等于没有边框。
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l4',
]

/** 卡片里真实出现的前景/背景配对（与 measure-layout 量的是同一批元素）。 */
const PAIRS = [
  { what: '正文 / 卡片底', fg: '--dsw-alias-label-primary', bg: '--dsw-alias-bg-base' },
  { what: '二级文字 / 卡片底', fg: '--dsw-alias-label-secondary', bg: '--dsw-alias-bg-base' },
  { what: '二级文字 / 状态条', fg: '--dsw-alias-label-secondary', bg: '--dsw-alias-bg-layer-2' },
  { what: '错误文字 / 卡片底', fg: '--dsw-alias-state-error-primary', bg: '--dsw-alias-bg-base' },
]

const rgb = (hex) => {
  const digits = hex.replace('#', '')
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits.slice(0, 6)
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16))
}

/** WCAG 2.x 相对亮度与对比度。和浏览器门禁里的实现同一条公式。 */
const luminance = ([r, g, b]) => {
  const channel = (value) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const contrast = (foreground, background) => {
  const a = luminance(rgb(foreground))
  const b = luminance(rgb(background))
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
}

test('快照包含色阶与两套 alias，值都是真实颜色', () => {
  const snapshot = readSnapshot()
  assert.notEqual(snapshot, null, `缺少快照 ${SNAPSHOT_PATH}；运行 node scripts/theme-tokens.mjs --update`)
  for (const mode of ['light', 'dark']) {
    const tokens = snapshot[mode]
    assert.equal(typeof tokens, 'object', `${mode} 缺失`)
    // 主题包当前提供 114 个 alias；掉到这个数量以下说明某种取值写法又被漏掉了
    // （曾经只解析 var(--dsw-static-*)，72 个，border 整族丢失）。
    assert.ok(Object.keys(tokens).length >= 105, `${mode} 只有 ${Object.keys(tokens).length} 个 alias`)
    for (const [key, value] of Object.entries(tokens)) {
      assert.match(value, COLOUR, `${mode}/${key} 不是可用颜色：${String(value)}`)
    }
    const statics = snapshot.statics[mode]
    assert.equal(typeof statics, 'object', `${mode} 的色阶缺失`)
    assert.ok(Object.keys(statics).length >= 60, `${mode} 色阶只有 ${Object.keys(statics).length} 个`)
    for (const [key, value] of Object.entries(statics)) {
      assert.match(value, /^#[0-9a-fA-F]{3,8}$/u, `${mode}/${key} 不是字面色：${String(value)}`)
    }
  }
})

test('卡片依赖的 alias 在两套主题里都在，且深浅不是同一份', () => {
  const { light, dark, origin } = loadThemeTokens()
  const missing = REQUIRED.filter((key) => light[key] === undefined || dark[key] === undefined)
  assert.deepEqual(missing, [], `缺少 alias（来源 ${origin.detail}）`)
  // 只有这一条能区分"真的加载了暗色"和"两套都解析成浅色"。
  assert.notEqual(
    light['--dsw-alias-bg-base'],
    dark['--dsw-alias-bg-base'],
    '浅色与暗色的 bg-base 相同 —— 暗色 token 没生效',
  )
  assert.notEqual(
    light['--dsw-alias-label-primary'],
    dark['--dsw-alias-label-primary'],
    '浅色与暗色的主文字色相同 —— 暗色 token 没生效',
  )
})

test('两种主题下卡片的文字都达到 WCAG AA', () => {
  const { light, dark } = loadThemeTokens()
  const failures = []
  for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
    for (const pair of PAIRS) {
      const value = contrast(tokens[pair.fg], tokens[pair.bg])
      if (!(value >= MIN)) failures.push(`${mode} ${pair.what}: ${value}:1（${tokens[pair.fg]} on ${tokens[pair.bg]}）`)
    }
  }
  assert.deepEqual(failures, [], `对比度不足 ${MIN}:1 ——\n${failures.join('\n')}`)
})

test('alias 解析按出现顺序取浅色首份、暗色末份', () => {
  // 主题包每个 alias 写两遍：`:root` 里一遍、暗色块里一遍。按 key 去重会永远拿到
  // 浅色那份，"暗色 token"于是静默失效 —— 这正是本文件存在的理由。
  const source = [
    ':root{--dsw-static-light:#111111;--dsw-alias-ink:var(--dsw-static-light);}',
    'body[data-ds-dark-theme]{--dsw-static-dark:#eeeeee;--dsw-alias-ink:var(--dsw-static-dark);}',
  ].join('')
  const { light, dark } = extractTokens(source)
  assert.equal(light['--dsw-alias-ink'], '#111111')
  assert.equal(dark['--dsw-alias-ink'], '#eeeeee')
})

test('本机有主题包时，快照必须与它一致', (t) => {
  const bundle = locateBundle()
  if (bundle === null) {
    t.skip('本机没有 DSH 安装，无法比对（CI 走快照）')
    return
  }
  const snapshot = readSnapshot()
  assert.notEqual(snapshot, null)
  const live = extractTokens(readFileSync(bundle.path, 'utf8'))
  const drift = []
  for (const mode of ['light', 'dark']) {
    for (const key of new Set([...Object.keys(live[mode]), ...Object.keys(snapshot[mode])])) {
      if (live[mode][key] !== snapshot[mode][key]) {
        drift.push(`${mode}/${key}: 快照=${String(snapshot[mode][key])} bundle=${String(live[mode][key])}`)
      }
    }
  }
  assert.deepEqual(
    drift,
    [],
    `快照与主题包（${bundle.path}${bundle.version === null ? '' : ` @${bundle.version}`}）不一致，` +
      `运行 node scripts/theme-tokens.mjs --update：\n${drift.join('\n')}`,
  )
})

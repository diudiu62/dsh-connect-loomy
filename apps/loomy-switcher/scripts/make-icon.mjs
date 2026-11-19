/**
 * 生成应用图标：1024×1024 PNG（渐变圆角方块 + 双向切换箭头），再交给 macOS
 * 的 iconutil 打包成 .icns。
 *
 * 手写 PNG 编码器是刻意的：这个工程不想为了一张图引入 canvas/sharp 依赖，
 * 而 PNG 的 IDAT 就是 zlib 流，node 标准库够用。
 */

import { execFile } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'

const run = promisify(execFile)
const SIZE = 1024
const SS = 4 // 每像素 4×4 超采样，边缘才顺滑

/* ------------------------------ 形状判定 ------------------------------ */

/** 圆角矩形的内外判定（signed distance < 0 表示在内部）。 */
function roundedBox(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius)
  const dy = Math.abs(py - cy) - (halfH - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius
}

/** 胶囊（圆头线段）：距离线段两端点构成的走廊。 */
function capsule(px, py, x1, y1, x2, y2, halfThickness) {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = px - x1
  const wy = py - y1
  const lengthSq = vx * vx + vy * vy
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq))
  return Math.hypot(wx - vx * t, wy - vy * t) - halfThickness
}

/** 三角形内外判定（重心坐标）。 */
function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  const d1 = sign([px, py], a, b)
  const d2 = sign([px, py], b, c)
  const d3 = sign([px, py], c, a)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * 箭头三角。
 *
 * 之前额外在三个角画半径 26 的小圆来"圆化"，结果小圆比三角形还突出，
 * 变成节点连线图。以 1024px 的输出尺寸、下方还有 4×4 超采样，纯三角形
 * 的边缘已经足够顺滑，不需要补圆。
 */
function arrowHead(px, py, tip, back1, back2) {
  return inTriangle(px, py, tip, back1, back2)
}

/* ------------------------------ 绘制 ------------------------------ */

/** 渐变：左上蓝 → 右下紫。 */
function background(px, py) {
  const t = Math.max(0, Math.min(1, (px / SIZE) * 0.55 + (py / SIZE) * 0.45))
  const stops = [
    [0.0, [0x3f, 0x74, 0xff]],
    [0.5, [0x6b, 0x6c, 0xff]],
    [1.0, [0xa2, 0x5c, 0xf0]],
  ]
  let lo = stops[0]
  let hi = stops.at(-1)
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i]
      hi = stops[i + 1]
      break
    }
  }
  const k = (t - lo[0]) / Math.max(hi[0] - lo[0], 1e-6)
  return [
    Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * k),
    Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * k),
    Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * k),
  ]
}

const CENTER = SIZE / 2
const RADIUS = 224 // 圆角半径，接近 macOS Big Sur 图标比例

function insideTile(px, py) {
  return roundedBox(px, py, CENTER, CENTER, CENTER - 40, CENTER - 40, RADIUS) < 0
}

/** 两道反向箭头：上排 →，下排 ←。 */
function insideGlyph(px, py) {
  const thickness = 34
  const left = 300
  const right = 724
  const topY = 404
  const bottomY = 620

  // 注意：0 也是合法距离，必须显式 `< 0`，否则负数（内部）会被当成真值没问题，
  // 但 0 边界处会漏判——更要紧的是别写成 `if (capsule(...))`，那样只有恰好
  // 落在边上才算命中。这里统一用有符号距离 < 0 判定内部。
  // 上箭头：横杆 + 右侧箭头
  if (capsule(px, py, left + 20, topY, right - 54, topY, thickness) < 0) return true
  if (arrowHead(px, py, [right + 40, topY], [right - 78, topY - 96], [right - 78, topY + 96])) return true

  // 下箭头：横杆 + 左侧箭头
  if (capsule(px, py, left + 54, bottomY, right - 20, bottomY, thickness) < 0) return true
  if (arrowHead(px, py, [left - 40, bottomY], [left + 78, bottomY - 96], [left + 78, bottomY + 96])) return true

  return false
}

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const samples = SS * SS
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let tileHits = 0
      let glyphHits = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (!insideTile(px, py)) continue
          tileHits += 1
          if (insideGlyph(px, py)) glyphHits += 1
        }
      }
      const offset = (y * SIZE + x) * 4
      if (tileHits === 0) {
        pixels[offset + 3] = 0
        continue
      }
      const [r, g, b] = background(x, y)
      const glyphRatio = glyphHits / tileHits
      pixels[offset] = Math.round(r + (255 - r) * glyphRatio)
      pixels[offset + 1] = Math.round(g + (255 - g) * glyphRatio)
      pixels[offset + 2] = Math.round(b + (255 - b) * glyphRatio)
      pixels[offset + 3] = Math.round((tileHits / samples) * 255)
    }
  }
  return pixels
}

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------ 主流程 ------------------------------ */

const here = new URL('.', import.meta.url).pathname
const buildDir = join(here, '..', 'build')
const iconSource = join(buildDir, 'icon.png')

console.log('渲染 1024×1024 图标…')
const png = encodePng(SIZE, SIZE, render())
await mkdir(buildDir, { recursive: true })
await writeFile(iconSource, png)
console.log(`已写出 ${iconSource}（${(png.length / 1024).toFixed(0)} KB）`)

// iconset：macOS 要求的十个尺寸
const iconset = join(buildDir, 'icon.iconset')
await rm(iconset, { recursive: true, force: true })
await mkdir(iconset, { recursive: true })
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  await run('sips', ['-z', String(size), String(size), iconSource, '--out', join(iconset, `icon_${size}x${size}.png`)])
  if (size <= 512) {
    await run('sips', ['-z', String(size * 2), String(size * 2), iconSource, '--out', join(iconset, `icon_${size}x${size}@2x.png`)])
  }
}
await run('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
await rm(iconset, { recursive: true, force: true })
console.log(`已写出 ${join(buildDir, 'icon.icns')}`)

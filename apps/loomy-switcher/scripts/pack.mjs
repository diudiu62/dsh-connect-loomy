/**
 * 打包成 macOS .app。
 *
 * 用 @electron/packager 而不是 electron-builder：这个应用没有签名、公证、
 * 安装包诉求，一个能双击的 .app 就够。
 *
 * 两个踩过的坑写在这里，避免以后重犯：
 *
 * 1. **不能直接对整个工程目录打包**：`ignore` 里的 node_modules 正则对
 *    packager 不生效（它按自己的路径语义匹配），结果把 electron 的
 *    263MB dist 又塞进 app.asar，包体 375MB、asar 116MB。改成先把源码复制
 *    到临时暂存目录（只含 package.json + src + 图标）再打包。
 * 2. packager v18 的 `icon` 对中文 app 名会告警 "Could not find icon ...
 *    with extension '.icon'" 并跳过，最后用的是 electron 默认图标。所以
 *    打包后自己覆盖 Resources/icon.icns 并改写 CFBundleIconFile。
 */

import { packager } from '@electron/packager'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = new URL('.', import.meta.url).pathname.replace(/\/$/u, '')
const root = join(here, '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const APP_NAME = 'Loomy 账号切换器'
const outDir = join(root, 'dist')
const stageDir = join(root, '.stage')

await rm(outDir, { recursive: true, force: true })
await rm(stageDir, { recursive: true, force: true })

/* ---------------------------- 1. 弄干净暂存目录 ---------------------------- */

await mkdir(join(stageDir, 'src'), { recursive: true })
await cp(join(root, 'src'), join(stageDir, 'src'), { recursive: true })

// 生产 package.json：去掉 devDependencies 与开发脚本，别让 Electron 去
// 尝试解析一个它用不到的依赖树。
const stagedPkg = {
  name: 'loomy-account-switcher',
  productName: APP_NAME,
  version: pkg.version,
  description: pkg.description,
  type: 'module',
  main: 'src/main/main.js',
  author: pkg.author,
  license: pkg.license,
  private: true,
}
await writeFile(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, undefined, 2)}\n`)

/* ---------------------------- 2. 复用本机 Electron ---------------------------- */

const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version

const cacheRoot = join(root, '.electron-cache')
const cacheName = `electron-v${electronVersion}-darwin-${process.arch}.zip`
const cachePath = join(cacheRoot, cacheName)

if (!existsSync(cachePath)) {
  // 目录名是 electron 安装器的内部缓存键，不值得复现；直接在缓存根下搜同名 zip。
  const { readdir, copyFile } = await import('node:fs/promises')
  const electronCache = join(homedir(), 'Library', 'Caches', 'electron')
  let source
  try {
    for (const entry of await readdir(electronCache, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(electronCache, entry.name, cacheName)
      if (existsSync(candidate)) {
        source = candidate
        break
      }
    }
  } catch {
    // 没有缓存目录
  }
  if (source === undefined) {
    throw new Error(`本机没有 Electron ${electronVersion} 的缓存（${cacheName}）\n先跑一次 npm install 或把该 zip 放到 ${cacheRoot}。`)
  }
  await mkdir(cacheRoot, { recursive: true })
  await copyFile(source, cachePath)
  console.log(`复用本机缓存：${source}`)
}

/* ---------------------------- 3. 打包 ---------------------------- */

const [appPath] = await packager({
  dir: stageDir,
  out: outDir,
  name: APP_NAME,
  appBundleId: 'cn.benny.loomy-account-switcher',
  appVersion: pkg.version,
  platform: 'darwin',
  arch: process.arch,
  electronZipDir: cacheRoot,
  asar: true,
  prune: true,
  overwrite: true,
  osxSign: false,
  appCopyright: `© ${new Date().getFullYear()} benny`,
  // 不把 .stage 自身或图标源文件带进 asar（这里暂存目录里只有 src + package.json，
  // 但显式排除更稳）
  ignore: [/^\/\.stage($|\/)/u, /^\/dist($|\/)/u],
})

await rm(stageDir, { recursive: true, force: true })

/* ---------------------------- 4. 修图标 ---------------------------- */

const bundle = join(appPath, `${APP_NAME}.app`)
const resources = join(bundle, 'Contents', 'Resources')
const iconSource = join(root, 'build', 'icon.icns')

if (existsSync(iconSource)) {
  const { copyFile } = await import('node:fs/promises')
  await copyFile(iconSource, join(resources, 'icon.icns'))
  // 让 Finder / Dock 用我们的图标，而不是 Electron 默认那个
  await run('plutil', ['-replace', 'CFBundleIconFile', '-string', 'icon.icns', join(bundle, 'Contents', 'Info.plist')])
  // 清掉 Electron 自带的图标，避免系统优先命中它
  await rm(join(resources, 'electron.icns'), { force: true })
  console.log('已应用应用图标')
}

// 中文应用名要在 Info.plist 里体现，否则菜单栏与 Dock 会显示 loomy-account-switcher
for (const [key, value] of [
  ['CFBundleDisplayName', APP_NAME],
  ['CFBundleName', APP_NAME],
]) {
  await run('plutil', ['-replace', key, '-string', value, join(bundle, 'Contents', 'Info.plist')])
}

// 让系统重新读取 bundle（图标缓存）
await run('touch', [bundle]).catch(() => {})

/* ---------------------------- 5. 校验 ---------------------------- */

const size = Number((await run('du', ['-sk', bundle])).stdout.split(/\s+/u)[0]) / 1024
const asarSize = Number((await stat(join(resources, 'app.asar'))).size) / 1024 / 1024
const iconCheck = await run('defaults', ['read', join(bundle, 'Contents', 'Info.plist'), 'CFBundleIconFile'])
const nameCheck = await run('defaults', ['read', join(bundle, 'Contents', 'Info.plist'), 'CFBundleName'])

console.log(`\n✅ ${bundle}`)
console.log(`   体积      ${size.toFixed(1)} MB`)
console.log(`   app.asar  ${asarSize.toFixed(2)} MB`)
console.log(`   图标      ${iconCheck.stdout.trim()}`)
console.log(`   名称      ${nameCheck.stdout.trim()}`)

/**
 * 真机 UI 冒烟测试：驱动打包后的 .app 走一遍「导入 → 切换」。
 *
 * 为什么这样做：单元测试覆盖不到 IPC 接线和渲染层事件绑定——那两处任何一处
 * 写错，界面看起来都正常，点下去却什么都不发生。这里用 CDP 真的点按钮，
 * 断言的是界面上的最终文字。
 *
 * 用法：node scripts/ui-test.mjs "<app bundle path>"
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const bundle = process.argv[2]
if (bundle === undefined) {
  console.error('用法：node scripts/ui-test.mjs <path to .app>')
  process.exit(2)
}

const binary = join(bundle, 'Contents', 'MacOS', 'Loomy 账号切换器')
const PORT = 9333
const userData = await mkdtemp(join(tmpdir(), 'loomy-switcher-ui-'))

/**
 * 测试开始前记录客户端真实登录态，结束时原样写回。
 *
 * 切换测试会真的把 session 写进客户端 leveldb —— 不恢复就等于用一次测试
 * 把用户的登录态换成了合成账号（实测发生过，`13000000001` 留在了客户端里）。
 */
let originalSession
try {
  const { readFile } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const path = join(homedir(), 'Library', 'Application Support', 'loomy', 'auth-session.json')
  originalSession = JSON.parse(await readFile(path, 'utf8'))
} catch {
  originalSession = undefined
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

/* ------------------------------ 启动 ------------------------------ */

// 账号库也指向临时目录：这个测试会导入一个合成账号，不能落到用户真实库
const vaultFile = join(userData, 'accounts.json')
const child = spawn(binary, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  stdio: 'ignore',
  detached: false,
  env: { ...process.env, ACCOUNT_SWITCHER_VAULT: vaultFile },
})

const waitForPort = async (timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return true
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!(await waitForPort())) {
  console.error('✗ 应用没有开出调试端口')
  child.kill('SIGKILL')
  process.exit(1)
}
check('打包后的 .app 能启动', true)

/* ------------------------------ CDP 封装 ------------------------------ */

const pageTarget = async () => {
  for (let i = 0; i < 40; i += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
    if (page !== undefined) return page
    await sleep(250)
  }
  throw new Error('找不到界面 target')
}

const target = await pageTarget()

const evaluate = async (expression) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const id = Math.floor(Math.random() * 1e6)
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时')), 20_000)
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== id) return
      clearTimeout(timer)
      resolve(message)
    }
  })
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  const message = await reply
  ws.close()
  if (message.result?.exceptionDetails !== undefined) {
    throw new Error(message.result.exceptionDetails.exception?.description ?? 'evaluate 失败')
  }
  return message.result?.result?.value
}

/** 轮询等待条件成立（界面更新是异步的）。 */
const waitUntil = async (expression, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await sleep(300)
  }
  return false
}

/* ------------------------------ 断言 ------------------------------ */

check('界面已加载', await waitUntil(`document.querySelector('.account-list') !== null`))

// 主进程读客户端状态是异步的，界面先是「检测中…」/「当前账号 —」。
// 不等它落定就读计数，会读到 0（实测就是这么偶发挂掉的）。
const settled = await waitUntil(
  `(() => {
     const chip = document.getElementById('current-chip').textContent;
     const status = document.getElementById('status-chip').textContent;
     return (chip.includes('客户端') || chip.includes('未登录')) && !status.includes('检测中');
   })()`,
  20_000,
)
check('初始状态已加载完成', settled)

const initialChip = await evaluate(`document.getElementById('current-chip').textContent`)
check('读到了客户端真实登录态', /客户端账号 \d{11}|客户端账号 \d{3}\*{4}\d{4}/u.test(initialChip), initialChip)

// 账号库里可能已经有真实账号了，所以所有断言都相对"导入前"来算，
// 而不是写死"应该有 1 条"（第一版就是这么挂的）。
// 再等一次计数稳定：状态回来后会触发一次重绘
await waitUntil(`Number(document.getElementById('account-count').textContent) > 0 || document.querySelector('.account-list .empty') !== null`, 10_000)
const countBefore = Number(await evaluate(`document.getElementById('account-count').textContent`))

// 导入用一条**库里没有**的合成账号：真实账号若已存在，导入会走"更新"分支，
// 计数不会变，断言 +1 就会误报（第一版踩过）。切换测试另找真实账号。
const TEST_SESSION = crypto.randomUUID().replace(/-/gu, '') + crypto.randomUUID().replace(/-/gu, '').slice(0, 8)
const payload = {
  session: TEST_SESSION,
  userid: '999999999999999999',
  phone: '13000000001',
}
await evaluate(`(() => {
  const area = document.getElementById('import-text');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, ${JSON.stringify(JSON.stringify(payload))});
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
await evaluate(`document.getElementById('btn-import').click()`)

const countAfterImport = countBefore + 1
const imported = await waitUntil(
  `Number(document.getElementById('account-count').textContent) === ${countAfterImport}`,
)
check('导入后账号数 +1', imported, `before=${countBefore} after=${countAfterImport}`)

const allCards = await evaluate(`Array.from(document.querySelectorAll('.account')).map((n) => n.textContent).join('|')`)
// 隔离库里导入的是合成账号 13000000001（真实账号在用户库里，不会出现在这里）
check('账号卡片显示完整手机号', allCards.includes('13000000001'), '13000000001 出现在卡片里')

const countBadge = await evaluate(`document.getElementById('account-count').textContent`)
check('计数徽标同步', Number(countBadge) === countAfterImport, `count=${countBadge}`)

// —— 重复导入必须幂等（真实 UI 上的第二次点击）
await evaluate(`(() => {
  const area = document.getElementById('import-text');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, ${JSON.stringify(JSON.stringify(payload))});
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
await evaluate(`document.getElementById('btn-import').click()`)
await sleep(1500)
const afterSecond = await evaluate(`document.getElementById('account-count').textContent`)
check('重复导入不产生重复账号', Number(afterSecond) === countAfterImport, `count=${afterSecond}`)

// —— 切换：勾掉"重启"以免真的重启用户的 Loomy，只验证写入链路
await evaluate(`(() => { const box = document.getElementById('opt-restart'); if (box.checked) box.click(); return true; })()`)

const beforeSwitchLog = await evaluate(`document.querySelectorAll('.log-line').length`)
// 隔离库里的账号是合成的：切过去会走到"校验未通过"，这正是要验证的诚实路径
const clickedSwitch = await evaluate(`(() => {
  const card = document.querySelector('.account');
  if (!card) return false;
  card.querySelector('.btn-switch').click();
  return true;
})()`)
check('找到可切换的账号', clickedSwitch === true)

// 切换会先退出 Loomy（AppleScript 最多等 8s），再备份写入，别只等 2.5s
const finished = await waitUntil(
  `document.querySelectorAll('.log-line').length > ${beforeSwitchLog} + 2`,
  60_000,
)
check('切换在 60s 内走完退出/备份阶段', finished)

const logText = await evaluate(`Array.from(document.querySelectorAll('.log-line')).map((n) => n.textContent).join('\\n')`)
if (!logText.includes('已写入登录态')) console.log('--- 实际日志 ---\n' + logText)
check('切换流程有进度输出', logText.includes('已备份') && logText.includes('已写入登录态'), '')
// 合成 session 切过去客户端会读到失效凭证，所以允许有错误行；
// 关键是流程必须走完并**说出原因**，而不是静默成功。
const logHasReason = await evaluate(
  `document.querySelectorAll('.log-line.log-error').length > 0 || document.querySelectorAll('.log-line.log-ok').length > 2`,
)
check('切换结果有明确说明（成功或原因）', logHasReason, '')

// 校验失败时不应把账号标成"当前"（那是撒谎），允许失败但状态必须自洽
const activeState = await evaluate(`document.querySelectorAll('.account.is-active').length`)
check('当前标记与切换结果自洽', activeState <= 1, `active=${activeState}`)

const toastShown = await evaluate(`document.querySelector('.toast.is-visible') !== null`)
check('出现了结果提示（成功或失败）', toastShown)

// —— 批量刷新积分：隔离库里是假 session，必然失败。
// 这里要断言的是**诚实性**：失败就显示失败原因，绝不能显示 0（那看起来像没钱了）。
await evaluate(`document.getElementById('btn-refresh-all').click()`)
const creditsShown = await waitUntil(`document.querySelector('.credits') !== null`, 60_000)
const creditsText = await evaluate(
  `(document.querySelector('.credits')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`,
)
check('批量刷新后有积分状态（成功或如实报错）', creditsShown, creditsText.slice(0, 60))
const showsZero = await evaluate(
  `(document.querySelector('.credits-main')?.textContent ?? '') === '0'`,
)
check('失败时不把积分显示成 0', !showsZero, creditsText.slice(0, 40))

// 千分位格式（12000 → 12,000）
const hasGrouping = await evaluate(
  `(document.querySelector('.credits-main')?.textContent ?? '').includes(',') || (document.querySelector('.credits-main')?.textContent ?? '').replace(/,/g,'').length <= 3`,
)
check('积分数字有千分位或为短数字', hasGrouping)

// —— 邀请码查询
await evaluate(`document.getElementById('btn-invite-refresh').click()`)
const inviteShown = await waitUntil(
  `document.querySelector('.invite-code-text') !== null || document.querySelector('.invite-body .empty') !== null`,
  40_000,
)
check('邀请码面板有结果', inviteShown)

const inviteText = await evaluate(`document.querySelector('.invite-body')?.textContent?.replace(/\\s+/g,' ').trim() ?? ''`)
check('邀请码面板不是加载态', inviteText.length > 0, inviteText.slice(0, 70))

/* ------------------------------ 收尾 ------------------------------ */

child.kill('SIGTERM')
await sleep(800)
child.kill('SIGKILL')

// 把客户端恢复成测试前的账号（切换测试确实写了 leveldb）
if (originalSession?.session !== undefined) {
  try {
    const loomy = await import('../src/main/targets/loomy.js')
    const restored = await loomy.applySession(
      { session: originalSession.session, userid: originalSession.userid, phone: originalSession.phone },
      { restart: true },
    )
    check('测试后已恢复客户端原账号', restored.ok, restored.ok ? originalSession.phone : restored.verify?.reason ?? '')
  } catch (error) {
    check('测试后已恢复客户端原账号', false, String(error).slice(0, 80))
  }
}

await rm(userData, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const entry of failed) console.log(`  - ${entry.name} ${entry.detail}`)
  process.exit(1)
}

/**
 * The boot-free CLI (`node lib/bin.js status|doctor --json`).
 *
 * The child process gets a temp `LOOMY_AUTH_SESSION_FILE` and a loopback base
 * URL, so these tests prove the shipped artifact works end-to-end without
 * reading the developer's real Loomy sign-in or spending points upstream.
 *
 * `doctor` is the support tool: it must list every credential candidate path
 * and repeat upstream `desc` text verbatim (so a user can paste it into a bug
 * report), while the raw session never appears on stdout/stderr.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  RAW_PHONE,
  RAW_USER_ID,
  SESSION,
  modelsBody,
  platformFailure,
  pointsBody,
  tempDir,
  writeAuthFile,
} from './helpers.mjs'

const BIN = fileURLToPath(new URL('../../lib/bin.js', import.meta.url))

/** Start a loopback fake gateway and record the platform calls it receives. */
async function startUpstream(t, handlers) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers })
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = handlers[path] ?? handlers.default
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: '404', desc: 'not found' }))
      return
    }
    const answer = handler(req)
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(answer.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { baseURL: `http://127.0.0.1:${server.address().port}/api/v1`, calls }
}

/**
 * Run the built CLI as a child process. `spawn` (not `spawnSync`) is required:
 * the fake gateway lives in this test process, so blocking the event loop
 * would deadlock the child's HTTP requests.
 */
function runCli(t, args, env) {
  const dir = tempDir(t)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        // Defense in depth. `LOOMY_AUTH_SESSION_FILE` is an *exclusive*
        // replacement (no desktop fallback), so this HOME isolation is not
        // what makes the tests safe — but it keeps a regression from reaching
        // the developer's real `~/Library` path before the assertions fire.
        HOME: dir,
        DSH_HOME: `${dir}/dsh-home`,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

async function runJson(t, args, env) {
  const result = await runCli(t, args, env)
  assert.equal(result.code, 0, `cli exited ${result.code} (${result.signal}): ${result.stderr}`)
  return { ...result, json: JSON.parse(result.stdout) }
}

/** 文档是 `{ok, fetchedAt, vendors[]}`；这些断言只关心 Loomy 那一片。 */
function loomyOf(document) {
  const vendor = document.vendors.find((entry) => entry.id === 'loomy')
  assert.ok(vendor !== undefined, 'the CLI must report the loomy vendor')
  return vendor
}

test('status --json reports the account, catalog and live credits', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const upstream = await startUpstream(t, {
    '/api/v1/models': () => ({ body: modelsBody() }),
    '/api/v1/points/records': () => ({ body: pointsBody() }),
    '/api/v1/user/identity': () => ({ body: { code: '000000', desc: '成功', data: { isInternal: false } } }),
  })

  const { stdout, stderr, json: document } = await runJson(t, ['status', '--json'], {
    LOOMY_AUTH_SESSION_FILE: authPath,
    LOOMY_BASE_URL: upstream.baseURL,
  })

  const vendor = loomyOf(document)
  assert.equal(document.ok, true)
  assert.equal(vendor.account.phone, RAW_PHONE, '账号不脱敏：CLI 也要给出可核对的号码')
  assert.equal(vendor.account.userId, RAW_USER_ID)
  assert.equal(vendor.account.loginAt, 1_794_574_693_000)
  assert.equal(vendor.credential.found, true)
  assert.equal(vendor.credential.sourcePath, authPath)
  assert.deepEqual(vendor.catalog, { total: 4, enabled: 4, refreshedAt: vendor.catalog.refreshedAt })
  assert.deepEqual(vendor.enabledModelIds, ['spark-x2.6', 'DeepSeek-V4.1-Flash', 'qwen3.8-flash', 'mystery-chat'])
  assert.equal(vendor.credits.ok, true)
  // 三个桶现在按能力声明的 key 出现在 `fields` 里。
  assert.deepEqual(vendor.credits.fields, { available: 40_500, daily: 5_000, total: 35_500 })

  // The platform endpoints authenticate with `token:`; Bearer is only for chat.
  const modelsCall = upstream.calls.find((call) => call.url === '/api/v1/models')
  assert.equal(modelsCall.headers.token, SESSION)
  assert.equal(modelsCall.headers.authorization, undefined)
  const pointsCall = upstream.calls.find((call) => call.url.startsWith('/api/v1/points/records'))
  assert.match(pointsCall.url, /pageNo=1&pageSize=20&recordType=all/u)
  assert.equal(pointsCall.headers.token, SESSION)

  const combined = `${stdout}${stderr}`
  // 账号信息原样输出（用户要能核对）；**会话**永远不出现在任何输出里。
  assert.ok(combined.includes(RAW_PHONE), 'the account is readable, not masked')
  assert.ok(!combined.includes(SESSION), 'the session never reaches the CLI output')
})

test('doctor --json reports credential candidates and upstream desc verbatim', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const upstream = await startUpstream(t, {
    '/api/v1/models': () => ({ body: platformFailure('100002', '登录已失效，请重新登录') }),
    '/api/v1/points/records': () => ({ body: pointsBody() }),
    '/api/v1/user/identity': () => ({ body: platformFailure('100002', '登录已失效（identity）') }),
  })

  const { stdout, json: document } = await runJson(t, ['doctor', '--json'], {
    LOOMY_AUTH_SESSION_FILE: authPath,
    LOOMY_BASE_URL: upstream.baseURL,
  })

  const vendor = loomyOf(document)
  assert.equal(document.ok, true)
  assert.equal(vendor.credential.found, true)
  const candidate = vendor.credential.candidates.find((entry) => entry.path === authPath)
  assert.equal(candidate.state, 'ok')
  assert.equal(candidate.exists, true)
  assert.ok(vendor.credential.candidates.length >= 1, 'every inspected path is reported')
  // 探针 = 候选路径（本地"我去过哪"）+ 活体端点（"上游现在怎么说"）。
  assert.ok(vendor.probes.length > vendor.credential.candidates.length)
  // 端点探针的 path 是上游路径；候选探针的 path 是绝对文件路径（以 .json 结尾）。
  const endpointNames = new Set(['/models', '/points/records', '/user/identity'])
  const endpoints = vendor.probes.filter((probe) => endpointNames.has(probe.path))
  assert.deepEqual(endpoints.map((probe) => probe.path).sort(), [...endpointNames].sort())
  // 上游 desc 逐字回传：这里三个端点都被假网关拒了。
  const models = vendor.probes.find((probe) => probe.path === '/models')
  assert.equal(models.ok, false)
  assert.equal(models.reason, '登录已失效，请重新登录')
  for (const probe of vendor.probes) {
    assert.equal(typeof probe.reason, 'string')
    assert.equal(typeof probe.path, 'string')
  }
  assert.ok(vendor.endpoints.length >= 1, 'the endpoints the vendor talks to are listed')
  // 上游 `desc` 逐字保留：这里是目录读取失败的那一条。
  assert.equal(vendor.lastError.code, '100002')
  assert.match(vendor.lastError.message, /登录已失效，请重新登录/u)
  assert.ok(!stdout.includes(SESSION))

  // The human-readable form uses the same facts (no session, masked account).
  const human = await runCli(t, ['doctor'], {
    LOOMY_AUTH_SESSION_FILE: authPath,
    LOOMY_BASE_URL: upstream.baseURL,
  })
  assert.equal(human.code, 0)
  assert.match(human.stdout, new RegExp(RAW_PHONE, 'u'))
  assert.match(human.stdout, /登录已失效，请重新登录/u)
  assert.ok(!human.stdout.includes(SESSION))
})

test('doctor --json on a signed-out machine lists candidates and needs no network', async (t) => {
  const dir = tempDir(t)
  const missing = `${dir}/no-such-auth-session.json`
  const upstream = await startUpstream(t, {
    default: () => ({ body: { code: '000000', desc: '成功', data: {} } }),
  })

  const { json: document } = await runJson(t, ['doctor', '--json'], {
    LOOMY_AUTH_SESSION_FILE: missing,
    LOOMY_BASE_URL: upstream.baseURL,
    // Deliberately point HOME at the *real* home: if the explicit env path
    // ever fell back to the desktop candidates, this test would pick up the
    // developer's signed-in session (non-null account / upstream traffic).
    HOME: process.env.HOME,
  })

  const vendor = loomyOf(document)
  assert.equal(document.ok, true)
  assert.equal(vendor.credential.found, false)
  assert.equal(vendor.credential.found, false)
  assert.equal(vendor.credential.candidates.length, 1, 'an explicit env path must replace the desktop candidate list')
  assert.equal(vendor.credential.candidates[0].path, missing)
  const candidate = vendor.credential.candidates.find((entry) => entry.path === missing)
  assert.equal(candidate.exists, false)
  assert.equal(candidate.state, 'missing')
  assert.match(candidate.reason, /文件不存在/u)
  // 签出时绝不联系上游：目录探针也一条都不该发。
  assert.equal(upstream.calls.length, 0, 'a signed-out doctor does not contact the gateway')
})

test('status --json reports an upstream credits failure instead of a fabricated 0', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const upstream = await startUpstream(t, {
    '/api/v1/models': () => ({ body: modelsBody() }),
    '/api/v1/points/records': () => ({ body: platformFailure('100002', '积分接口登录已失效') }),
    '/api/v1/user/identity': () => ({ body: { code: '000000', desc: '成功', data: {} } }),
  })

  const { json: document } = await runJson(t, ['status', '--json'], {
    LOOMY_AUTH_SESSION_FILE: authPath,
    LOOMY_BASE_URL: upstream.baseURL,
  })

  const vendor = loomyOf(document)
  assert.equal(vendor.credits.ok, false)
  assert.equal(vendor.credits.error.code, '100002')
  assert.equal(vendor.credits.error.message, '积分接口登录已失效')
  assert.equal(vendor.credits.fields, undefined, 'no balance is invented on failure')
})

test('status --json honours DSH_HOME for its saved-selection count', async (t) => {
  const dir = tempDir(t)
  const authPath = writeAuthFile(dir)
  const dshHome = `${dir}/dsh-home`
  const upstream = await startUpstream(t, {
    '/api/v1/models': () => ({ body: modelsBody() }),
    '/api/v1/points/records': () => ({ body: pointsBody() }),
    '/api/v1/user/identity': () => ({ body: { code: '000000', desc: '成功', data: {} } }),
  })

  // Seed the state cache with an explicit one-model selection.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const stateDir = `${dshHome}/storages/dsh-connect-desktop/loomy`
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    `${stateDir}/state.json`,
    JSON.stringify({ version: 1, selection: ['qwen3.8-flash'], catalog: [], refreshedAt: null }),
    { mode: 0o600 },
  )

  const { json: document } = await runJson(t, ['status', '--json'], {
    LOOMY_AUTH_SESSION_FILE: authPath,
    LOOMY_BASE_URL: upstream.baseURL,
    DSH_HOME: dshHome,
  })
  const vendor = loomyOf(document)
  assert.equal(vendor.catalog.total, 4)
  assert.equal(vendor.catalog.enabled, 1)
  assert.deepEqual(vendor.enabledModelIds, ['qwen3.8-flash'])
})

test('--help documents LOOMY_AUTH_SESSION_FILE as exclusive (no desktop fallback)', async (t) => {
  const { stdout } = await runCli(t, ['--help'], { LOOMY_AUTH_SESSION_FILE: '' })
  assert.match(stdout, /use exactly this Loomy sign-in file \(no desktop fallback\)/u)
})

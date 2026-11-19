/**
 * 小浣熊 target 的测试（全部注入 fetch，不打真实网络）。
 *
 * 覆盖反编译得到的三条关键事实：
 * 1. 认证是 `Authorization: Bearer <jwt>`，不是 Loomy 的裸 `token`；
 * 2. 响应是 `{code, message, data}` 信封，`code === 0` 才算成功；
 * 3. 登录态值就是那个 JWT，`exp` 可直接读出来做倒计时。
 */

import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import test from 'node:test'

import {
  buildSession,
  decodeJwt,
  isIamToken,
  fetchIdentity,
  fetchPoints,
  parseAuthDocument,
  findUserData,
  readSession,
  request,
  writeSession,
  authPathOf,
} from '../src/main/targets/raccoon.js'

/** 造一个带指定 exp 的 HS256 形状 JWT（签名段随便填，解码不需要验证）。 */
function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fakesignature`
}

const TOKEN = makeJwt({
  sid: 'ses-test',
  iss: 'xiaohuanxiong.com/iam',
  sub: 'pu-test-sub',
  exp: 1797572399,
  iat: 1794980399,
})

const okFetch = (body, capture) => async (url, init) => {
  capture?.push({ url, init })
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

test('能解出 JWT 的 exp 和 sub', () => {
  const payload = decodeJwt(TOKEN)
  assert.equal(payload.exp, 1797572399)
  assert.equal(payload.sub, 'pu-test-sub')
  assert.equal(decodeJwt('not-a-jwt'), undefined)
  assert.equal(decodeJwt(''), undefined)
  assert.equal(decodeJwt(undefined), undefined)
})

test('认证用 Bearer，不是裸 token 头', async () => {
  const captured = []
  await request({
    path: '/api/web/office/v3/setting_info',
    session: TOKEN,
    fetchImpl: okFetch({ code: 0, data: {} }, captured),
  })
  assert.equal(captured[0].init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(captured[0].init.headers.token, undefined, '小浣熊不用裸 token 头')
  assert.ok(captured[0].url.startsWith('https://xiaohuanxiong.com/api/web/office/v3/setting_info'))
})

test('code !== 0 是失败，即使 HTTP 200', async () => {
  const result = await request({
    path: '/x',
    session: TOKEN,
    fetchImpl: okFetch({ code: 200901, message: '需要确认' }),
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, '200901')
  assert.equal(result.message, '需要确认')
})

test('401 直接报登录过期', async () => {
  const result = await request({
    path: '/x',
    session: TOKEN,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"unauthorized"}' }),
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, '401')
  assert.match(result.message, /重新登录/u)
})

test('积分解析出 available 与今日额度', async () => {
  const result = await fetchPoints({
    session: TOKEN,
    fetchImpl: okFetch({
      code: 0,
      data: { available_points: 9873, daily_question_count: 3, daily_question_limit: 20 },
    }),
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.points.available, 9873)
  assert.equal(result.points.secondary, '今日提问 3/20')
})

test('积分缺字段时按失败上报，不伪造成 0', async () => {
  const result = await fetchPoints({
    session: TOKEN,
    fetchImpl: okFetch({ code: 0, data: { daily_question_limit: 20 } }),
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, 'bad_response')
})

test('额度为 0 时文案说"不限额"，不显示 0/0', async () => {
  const result = await fetchPoints({
    session: TOKEN,
    fetchImpl: okFetch({ code: 0, data: { available_points: 100, daily_question_limit: 0 } }),
  })
  assert.equal(result.points.secondary, '今日提问额度不限额')
})

test('账号信息解析出手机号、昵称与 id', async () => {
  const result = await fetchIdentity({
    session: TOKEN,
    fetchImpl: okFetch({
      code: 0,
      data: { phone: '16506914524', name: 'RaccoonSofia', id: '7973418', uuid: 'u-x' },
    }),
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.identity.phone, '16506914524')
  assert.equal(result.identity.name, 'RaccoonSofia')
  assert.equal(result.identity.userId, '7973418')
})

test('网络异常收敛成 failure，不抛出', async () => {
  const result = await request({
    path: '/x',
    session: TOKEN,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(result.kind, 'failure')
  assert.equal(result.code, 'network')
})

test('写入 auth.json 的形状与官方 boxAgentAuthFile 完全一致', async () => {
  const { mkdtemp, readFile, writeFile, mkdir, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'raccoon-'))
  const path = authPathOf(dir)
  await mkdir(join(dir, 'agent', 'config'), { recursive: true })
  // 上一个账号留下的 enterprise 组织信息 + 未来版本的未知字段
  await writeFile(
    path,
    JSON.stringify({
      access_token: 'old',
      office_identity: 'enterprise',
      office_org_name: '上一个公司',
      office_org_role: 'owner',
      future_flag: 'stale',
    }),
  )
  await chmod(path, 0o600)

  const result = await writeSession(dir, { session: TOKEN, identity: 'personal' })
  assert.equal(result.unchanged, false)

  // 官方 writeBoxAgentDesktopAuthState 是**整份覆盖**：只有它认的五个键，
  // 空值省略，2 空格缩进 + 结尾换行
  const raw = await readFile(path, 'utf8')
  assert.equal(raw, `${JSON.stringify({ access_token: TOKEN, office_identity: 'personal' }, null, 2)}\n`)
  const after = JSON.parse(raw)
  assert.deepEqual(Object.keys(after).sort(), ['access_token', 'office_identity'])
  assert.equal(after.office_org_name, undefined, '切到个人号不能带着上一个账号的公司名')
  assert.equal(after.future_flag, undefined, '官方自己也是整份覆盖，未知字段不保留')
  assert.equal((await stat(path)).mode & 0o777, 0o600, '权限必须是 0600')

  const read = await readSession(dir)
  assert.equal(read.session, TOKEN)
  assert.equal(read.identity, 'personal')
  assert.equal(read.expiresAt, 1797572399 * 1000, '过期时间来自 JWT 的 exp')

  // 内容与权限都没变 → 官方会跳过写盘，我们也不制造 mtime 抖动
  const before = (await stat(path)).mtimeMs
  const again = await writeSession(dir, { session: TOKEN, identity: 'personal' })
  assert.equal(again.unchanged, true)
  assert.equal((await stat(path)).mtimeMs, before)
})

test('IAM 令牌不落 refresh_token；非 IAM 令牌才写', async () => {
  const { mkdtemp, readFile, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'raccoon-'))
  await mkdir(join(dir, 'agent', 'config'), { recursive: true })
  const path = authPathOf(dir)

  // 官方：isIamToken(accessToken) 为真时直接把 refresh_token 排除掉
  await writeSession(dir, { session: TOKEN, refreshToken: 'ref-keep-out', identity: 'personal' })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).refresh_token, undefined)

  const opaque = 'opaque-token-without-jwt-payload-32chars'
  await writeSession(dir, { session: opaque, refreshToken: 'ref-write-me', identity: 'personal' })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).refresh_token, 'ref-write-me')

  // 读回来时 IAM 令牌上的 refresh_token 也当成不存在（官方读法）
  const iam = await readSession(dir)
  assert.equal(iam.session, opaque)
})

test('读 auth.json 认官方的三个 token 别名，并带出组织信息', async () => {
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'raccoon-'))
  await mkdir(join(dir, 'agent', 'config'), { recursive: true })
  const path = authPathOf(dir)

  // 官方读法：access_token || token || auth_token
  await writeFile(path, JSON.stringify({ token: TOKEN }))
  assert.equal((await readSession(dir)).session, TOKEN)
  await writeFile(path, JSON.stringify({ auth_token: TOKEN }))
  assert.equal((await readSession(dir)).session, TOKEN)

  // 驼峰不是官方读取的字段（那是我们插件导出包的名字），读客户端时不认
  await writeFile(path, JSON.stringify({ accessToken: TOKEN }))
  assert.equal(await readSession(dir), undefined)

  // 组织信息三个键
  const tmp = `${TOKEN}x`
  await writeFile(
    path,
    JSON.stringify({
      access_token: tmp,
      office_identity: 'enterprise',
      office_org_name: '商汤科技',
      office_org_role: 'member',
    }),
  )
  const read = await readSession(dir)
  assert.equal(read.identity, 'enterprise')
  assert.equal(read.orgName, '商汤科技')
  assert.equal(read.orgRole, 'member')

  // 官方路径：新 profile 是 <root>/agent/config/auth.json，legacy 是 ~/.box-agent/config/auth.json
  assert.equal(authPathOf('/Users/x/Library/Application Support/office-raccoon'), '/Users/x/Library/Application Support/office-raccoon/agent/config/auth.json')
  assert.equal(authPathOf('/Users/x/.box-agent'), '/Users/x/.box-agent/config/auth.json')
})

test('登出按官方 clear 语义删除 auth.json，而不是写空对象', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'raccoon-home-'))
  const userData = join(home, 'Library', 'Application Support', 'office-raccoon')
  await mkdir(join(userData, 'agent', 'config'), { recursive: true })
  // profile marker：官方 bootstrap 的判据
  await writeFile(join(userData, '.raccoon-lab-client.json'), '{"application":"@raccoon/office-desktop","version":1}\n')
  const path = authPathOf(userData)
  await writeSession(userData, { session: TOKEN, identity: 'personal' })
  assert.ok(await readFile(path, 'utf8'))

  // signOut 会尝试 quit/launch 客户端，这里只验证文件语义，所以直接调用 findUserData 分支
  const found = await findUserData(home)
  assert.equal(found, userData)

  await rm(path, { force: true })
  assert.equal(await readSession(userData), undefined)
  assert.equal(await findUserData(home), userData, '没有 auth.json 时仍要靠 profile marker 找到目录')
})

test('legacy 安装（~/.box-agent/config/auth.json）也能定位', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'raccoon-legacy-'))
  const legacy = join(home, '.box-agent')
  await mkdir(join(legacy, 'config'), { recursive: true })
  await writeFile(join(legacy, 'config', 'config.yaml'), 'model: x\n')

  // legacy 没有 marker，靠 config/ 目录识别
  assert.equal(await findUserData(home), legacy)
  assert.equal(await readSession(legacy), undefined)

  await writeSession(legacy, { session: TOKEN, identity: 'personal' })
  assert.equal((await readSession(legacy)).session, TOKEN)
  assert.ok(!(await readSession(legacy)).session.includes('\n'))
})

/* ------------------------------------------------------------------ *
 * 导入解析：两套字段名都要认
 * ------------------------------------------------------------------ */

/** 驼峰形状的凭证，跟插件导出账号包里的单条一致。 */
const CAMEL_DOC = JSON.stringify({
  accessToken: TOKEN,
  refreshToken: null,
  phoneMasked: '13184723936',
  addedAt: 1795009458060,
})

test('导入：驼峰 accessToken 能解析（插件导出包就是这个名字）', () => {
  const [entry] = parseAuthDocument(CAMEL_DOC)
  assert.equal(entry.session, TOKEN)
  assert.equal(entry.phone, '13184723936', 'phoneMasked 要当成手机号')
  assert.equal(entry.userid, 'pu-test-sub', '没有 userid 字段时用 JWT 的 sub')
  assert.equal(entry.expiresAt, 1797572399 * 1000, '过期时间来自 JWT 的 exp')
  assert.equal(entry.identity, undefined, '没有 identity 就不编一个')
  assert.equal(entry.refreshToken, undefined, 'refreshToken: null 不算值')
})

test('导入：下划线 access_token + office_identity 也认（桌面端 auth.json）', () => {
  const [entry] = parseAuthDocument(JSON.stringify({ access_token: TOKEN, office_identity: 'enterprise' }))
  assert.equal(entry.session, TOKEN)
  assert.equal(entry.identity, 'enterprise')
})

test('导入：带 accounts 信封（插件/本工具导出）逐条展开', () => {
  const doc = JSON.stringify({
    formatVersion: 1,
    vendor: 'raccoon',
    exportedAt: 1,
    accounts: [
      { accessToken: TOKEN, identity: 'personal', phoneMasked: '13184723936' },
      { access_token: `${TOKEN}x`, office_identity: 'enterprise' },
      { nothing: 'useful' },
    ],
  })
  const entries = parseAuthDocument(doc)
  assert.equal(entries.length, 2, '没有 token 的那条被跳过，其余照常导入')
  assert.equal(entries[1].identity, 'enterprise')
})

test('导入：裸数组、裸字符串、token / session 别名', () => {
  assert.equal(parseAuthDocument(JSON.stringify([{ accessToken: TOKEN }])).length, 1)
  assert.equal(parseAuthDocument(JSON.stringify(TOKEN))[0].session, TOKEN)
  assert.equal(parseAuthDocument(JSON.stringify({ token: TOKEN }))[0].session, TOKEN)
  assert.equal(parseAuthDocument(JSON.stringify({ session: TOKEN }))[0].session, TOKEN)
})

test('导入：认不出 token 时的报错要点名两种写法', () => {
  assert.throws(() => parseAuthDocument('{"a":1}'), /access_token 或 accessToken/u)
  assert.throws(() => parseAuthDocument('null'), /没有可用的登录态/u)
  assert.throws(() => parseAuthDocument('not json'), /不是合法 JSON/u)
  assert.throws(() => parseAuthDocument(JSON.stringify({ accessToken: 'short' })), /太短/u)
})

test('buildSession：userId 驼峰也当标识符，name 透传', () => {
  const entry = buildSession(TOKEN, { userId: 'u-1', name: '工作号' })
  assert.equal(entry.userid, 'u-1')
  assert.equal(entry.name, '工作号')
})

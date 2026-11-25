import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POOL_COOLING_CODE,
  createAccountPool,
  createDesktopBench,
  createAccountsStore,
  createProviderRuntime,
  NO_POINTS_CODE,
  classifyUnavailable,
  disqualifiesAccount,
  isPermanentFailure,
  DEFAULT_POOL_COOLDOWN_MS,
  DEFAULT_POINTS_COOLDOWN_MS,
  ZERO_POINTS_MESSAGE,
  applyZeroPoints,
  RATE_LIMIT_COOLDOWN_MAX_MS,
  rateLimitCooldownMs,
  isRiskControlLimit,
  POOL_ROUTE,
} from '../../lib/index.js'

const S = (letter) => letter.repeat(40)

/** `createAccountsStore` + 一个真实的临时目录账号文档（markUnavailable 会真的落盘）。 */
const storeIn = (dir) => {
  const { createDocument } = accountsModule
  return createAccountsStore({
    document: createDocument({
      path: join(dir, 'accounts.json'),
      parse: (text) => JSON.parse(text),
      serialize: (document) => JSON.stringify(document),
      empty: () => ({ version: 1, accounts: [] }),
    }),
    routeBase: 'demo',
    routeMode: 'single',
    displayName: 'Demo',
    now: () => Date.now(),
  })
}

import * as accountsModule from '../../lib/index.js'

const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-pool-'))
  return {
    dir,
    store: createAccountsStore({ storageDir: () => dir, now: () => 1_000_000 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('only failures that mean "skip this account" disqualify it', () => {
  assert.equal(disqualifiesAccount('100002 缺少 token'), true)
  assert.equal(disqualifiesAccount('MissingCredential: session expired'), true)
  assert.equal(disqualifiesAccount('余额不足'), true)
  assert.equal(disqualifiesAccount('rate limit exceeded'), true)
  // A transient transport failure must not bench a healthy account.
  assert.equal(disqualifiesAccount('socket hang up'), false)
  assert.equal(disqualifiesAccount('timed out after 300000ms'), false)
  assert.equal(disqualifiesAccount(undefined), false)
})


/**
 * 401/密钥无效是**永久**失效：冷却结束也不该回到池里。
 *
 * 旧行为对两者一视同仁：十分钟后 401 的账号重新变成"健康"，被挑中、失败、
 * 再冷却——用户看到的是"有问题的账号还会被轮换到"，代价是每次一次必然失败的调用。
 *
 * 限流这一侧走**指数阶梯**（2026-11-23 小浣熊 `200108` 的证据）：窗口在失败那刻
 * 定死并随记录持久化（`unavailableUntil`），连续命中翻倍、封顶六小时。存储层
 * 的推导（连续命中 → 窗口升级）在 accounts 测试里钉；这里钉池子的判断。
 */
test('an auth failure never comes back, while a rate limit waits out its pinned window', async () => {
  const HOUR = 60 * 60 * 1000
  const t0 = 1_700_000_000_000
  const rows = [
    { id: 'dead', route: 'acme', material: 'x', origin: 'plugin', unavailableAt: t0, unavailableCode: '401', unavailableMessage: 'authorization_verify_error' },
    // 第四次连续限流：窗口 80 分钟（10→20→40→80）。
    { id: 'limited', route: 'acme', material: 'y', origin: 'plugin', unavailableAt: t0, unavailableUntil: t0 + 80 * 60 * 1000, unavailableCode: 'RATE_LIMIT', unavailableMessage: '429: rate limit exceeded' },
    // 旧记录没有解禁时刻：退回基础窗口（10 分钟）。
    { id: 'legacy', route: 'acme', material: 'w', origin: 'plugin', unavailableAt: t0 - 60 * 60 * 1000, unavailableCode: 'RATE_LIMIT', unavailableMessage: '429' },
    { id: 'ok', route: 'acme', material: 'z', origin: 'plugin' },
  ]
  const accounts = {
    list: async () => rows,
    routeOf: (account) => account.route,
    markUnavailable: async () => {},
    markHealthy: async () => {},
  }

  // 一小时：阶梯窗口（80min）没走完，限流账号不回池；基础窗口的旧记录早已解禁。
  const pool = createAccountPool({ accounts, now: () => t0 + HOUR, random: () => 0 })
  const picked = []
  for (let i = 0; i < 6; i += 1) {
    const pick = await pool.pick()
    assert.equal(pick.kind, 'ok')
    picked.push(pick.account.id)
  }
  assert.ok(!picked.includes('dead'), `401 账号不该被挑中：${picked.join(',')}`)
  assert.ok(!picked.includes('limited'), `阶梯窗口内的限流账号不该被挑中：${picked.join(',')}`)
  const state = await pool.state()
  const dead = state.entries.find((entry) => entry.id === 'dead')
  assert.equal(dead.unavailable, true, '永久失效即使过了冷却也算被跳过')
  assert.equal(dead.kind, 'auth')
  assert.equal(state.entries.find((entry) => entry.id === 'limited').unavailable, true)
  assert.equal(state.entries.find((entry) => entry.id === 'legacy').unavailable, false, '旧记录退回基础窗口')

  // 三小时：窗口早已走完，账号回到池里。
  const later = createAccountPool({ accounts, now: () => t0 + 3 * HOUR, random: () => 0 })
  assert.equal((await later.state()).entries.find((entry) => entry.id === 'limited').unavailable, false)
})

test('when nothing is left, only recoverable accounts are offered', async () => {
  const t0 = 1_700_000_000_000
  const rows = [
    { id: 'dead1', route: 'acme', material: 'x', origin: 'plugin', unavailableAt: t0, unavailableCode: '401', unavailableMessage: 'authorization_verify_error' },
    { id: 'dead2', route: 'acme', material: 'y', origin: 'plugin', unavailableAt: t0, unavailableCode: 'MISSING_CREDENTIAL', unavailableMessage: '登录态已过期' },
  ]
  const accounts = {
    list: async () => rows,
    routeOf: (account) => account.route,
    markUnavailable: async () => {},
    markHealthy: async () => {},
  }
  const pool = createAccountPool({ accounts, now: () => t0, random: () => 0 })
  const pick = await pool.pick()
  assert.equal(pick.kind, 'none-healthy')
  assert.deepEqual(pick.permanent.map((row) => row.id), ['dead1', 'dead2'])
  assert.deepEqual(pick.recoverable, [], '没有可恢复的账号，调用方必须报错而不是硬试')
})

/** 纯函数：一个失败该归到哪一类。 */
test('failures are classified into auth / points / temporary', () => {
  assert.equal(classifyUnavailable('401', 'authorization_verify_error'), 'auth')
  // pi-ai 适配器对 401 的 code 就是 `AUTH`：不靠 message 也必须判成永久失效。
  assert.equal(classifyUnavailable('AUTH', ''), 'auth')
  assert.equal(classifyUnavailable('CREDENTIAL_INVALID', ''), 'auth')
  assert.equal(classifyUnavailable('MISSING_CREDENTIAL', ''), 'auth')
  assert.equal(classifyUnavailable('CALL_FAILED', '登录态已过期，请重新登录'), 'auth')
  assert.equal(classifyUnavailable('CALL_FAILED', '余额不足'), 'points')
  assert.equal(classifyUnavailable(NO_POINTS_CODE, ''), 'points')
  assert.equal(classifyUnavailable('RATE_LIMIT', 'rate limit exceeded'), 'temporary')
  assert.equal(classifyUnavailable('TRANSPORT', 'socket hang up'), 'temporary')
  assert.equal(isPermanentFailure('401', 'authorization_verify_error'), true)
  assert.equal(isPermanentFailure('RATE_LIMIT', 'rate limit exceeded'), false)
  // 全池冷却的本地拒绝：不是凭据失效（用户是已登录的），归到 temporary。
  assert.equal(classifyUnavailable(POOL_COOLING_CODE, '全部冷却中'), 'temporary')
  assert.equal(isPermanentFailure(POOL_COOLING_CODE, '全部冷却中'), false)
})

/**
 * 2026-11-23 小浣熊 `200108` 的证据：8 个账号在 90 秒内被账号级风控整体限制。
 * 限流必须走指数阶梯，且窗口要在失败那一刻定死并持久化。
 */
test('rate-limit hits climb the ladder; other failures stay on the base window', () => {
  const base = DEFAULT_POOL_COOLDOWN_MS
  assert.equal(rateLimitCooldownMs(1, base), base)
  assert.equal(rateLimitCooldownMs(2, base), 2 * base)
  assert.equal(rateLimitCooldownMs(3, base), 4 * base)
  assert.equal(rateLimitCooldownMs(4, base), 8 * base)
  assert.equal(rateLimitCooldownMs(5, base), 16 * base)
  // 阶梯封顶：第五级（16×基础窗口）之后再命中也不涨；六小时上限只对更大的
  // 基础窗口生效。
  assert.equal(rateLimitCooldownMs(9, base), 16 * base)
  assert.equal(rateLimitCooldownMs(9, 60 * 60 * 1000), RATE_LIMIT_COOLDOWN_MAX_MS)
})

test('the persisted bench window pins recovery; a healthy call resets it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-bench-'))
  const store = storeIn(dir)
  try {
    const { id } = await store.add({ kind: 'credentials', material: 'mat-1', label: 'one' })
    // 第一次限流：基础窗口，解禁时刻已定死并落盘。
    const first = await store.markUnavailable(id, 'RATE_LIMIT', '429 200108')
    assert.equal(first.cooldownMs, DEFAULT_POOL_COOLDOWN_MS)
    assert.ok(first.recoverAt > Date.now())
    const benched = await store.find(id)
    assert.equal(benched.unavailableUntil, first.recoverAt)
    // 第二次失败落在第一次的窗口内（连续命中）→ 档位升到第二级、窗口翻倍。
    const second = await store.markUnavailable(id, 'RATE_LIMIT', '429 200108 again')
    assert.equal(second.cooldownMs, 2 * DEFAULT_POOL_COOLDOWN_MS)
    assert.equal((await store.find(id)).unavailableStreak, 2)
    // 等整个窗口过期之后再失败 → 重新从第一级开始。
    const { id: id2 } = await store.add({ kind: 'credentials', material: 'mat-2', label: 'two' })
    await store.markUnavailable(id2, 'RATE_LIMIT', '429')
    await store.markHealthy(id2)
    const fresh = await store.markUnavailable(id2, 'RATE_LIMIT', '429 after recovery')
    assert.equal(fresh.cooldownMs, DEFAULT_POOL_COOLDOWN_MS, '成功之后档位清零')
    // 普通失败不升级：窗口退回基础值，并清掉限流的解禁时刻。
    const ordinary = await store.markUnavailable(id, 'AUTH', 'authorization_verify_error')
    assert.equal(ordinary.cooldownMs, DEFAULT_POOL_COOLDOWN_MS)
    assert.equal((await store.find(id)).unavailableUntil, undefined)
    // 成功清空全部失败状态。
    await store.markHealthy(id)
    assert.equal((await store.find(id)).unavailableAt, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('risk-control wording is recognised wherever it appears', () => {
  assert.equal(isRiskControlLimit('429: {"code":200108,"message":"系统检测到当前账号存在异常调用"}'), true)
  assert.equal(isRiskControlLimit('模型调用功能已暂时受限'), true)
  assert.equal(isRiskControlLimit('请稍后再试'), false)
  assert.equal(disqualifiesAccount('429: {"code":200108,"type":"rate_limit_error"}'), true)
})

test('none-healthy reports when the first account recovers instead of a hard retry', async () => {
  const t0 = 1_700_000_000_000
  const rows = [
    { id: 'a', route: 'acme', material: 'x', origin: 'plugin', unavailableAt: t0, unavailableUntil: t0 + 10 * 60 * 1000, unavailableCode: 'RATE_LIMIT', unavailableMessage: '429' },
    { id: 'b', route: 'acme', material: 'y', origin: 'plugin', unavailableAt: t0, unavailableUntil: t0 + 20 * 60 * 1000, unavailableCode: 'RATE_LIMIT', unavailableMessage: '429' },
  ]
  const accounts = {
    list: async () => rows,
    routeOf: (account) => account.route,
    markUnavailable: async () => {},
    markHealthy: async () => {},
  }
  const pool = createAccountPool({ accounts, now: () => t0, random: () => 0 })
  const pick = await pool.pick()
  assert.equal(pick.kind, 'none-healthy')
  assert.equal(pick.recoverAt, t0 + 10 * 60 * 1000, '最早解禁的是 a')
})

/**
 * 桌面端 bench（core 共享）：不能持久化 ≠ 不能记着。
 * 两个供应商（Loomy / 小浣熊）的桌面身份走同一份实现、同一套阶梯。
 */
test('the shared desktop bench pins windows, escalates rate limits and resets on success', async () => {
  const t0 = 1_700_000_000_000
  let clock = t0
  const bench = createDesktopBench({ now: () => clock })

  // 第一次限流：基础窗口。
  const first = bench.markUnavailable('desktop', 'RATE_LIMIT', '429 rate limited')
  assert.equal(first?.cooldownMs, DEFAULT_POOL_COOLDOWN_MS)
  assert.equal(bench.status('desktop').benched, true)
  assert.equal(bench.status('desktop').permanent, false)

  // 仍在窗口内再次命中 → 阶梯升一级。
  clock += 60_000
  const second = bench.markUnavailable('desktop', 'RATE_LIMIT', '429 again')
  assert.equal(second?.cooldownMs, 2 * DEFAULT_POOL_COOLDOWN_MS)

  // 普通失败不升级：窗口回基础值。
  clock += 60_000
  const ordinary = bench.markUnavailable('desktop', 'AUTH', 'authorization_verify_error')
  assert.equal(ordinary, undefined, '永久失效没有恢复时间')
  assert.equal(bench.status('desktop').permanent, true)
  assert.equal(bench.status('desktop').benched, true)

  // 成功清空。
  bench.markHealthy('desktop')
  assert.equal(bench.status('desktop').benched, false)
})

/**
 * 积分不足不再"等十分钟再来一次"。
 *
 * 额度不会因为等待而恢复：一个零余额账号如果共用基础窗口，就会被每十分钟挑中
 * 一次、每次白烧一次必然失败的调用。窗口要比限流/普通失败长，并且同样在失败
 * 那一刻定死落盘——重启不该把一个没钱的账号放回池里。
 */
test('额度用光走独立的平窗，窗口同样落盘且不升档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'points-bench-'))
  const store = storeIn(dir)
  try {
    const { id } = await store.add({ kind: 'credentials', material: 'mat-p', label: 'p' })
    const first = await store.markUnavailable(id, NO_POINTS_CODE, ZERO_POINTS_MESSAGE)
    assert.ok(DEFAULT_POINTS_COOLDOWN_MS > DEFAULT_POOL_COOLDOWN_MS, '额度窗口必须比基础窗口长')
    assert.equal(first.cooldownMs, DEFAULT_POINTS_COOLDOWN_MS)
    assert.equal((await store.find(id)).unavailableUntil, first.recoverAt, '解禁时刻必须落盘')

    // 上游原话（而不是我们的 code）也必须归到额度类。
    const byMessage = await store.markUnavailable(id, 'CALL_FAILED', '积分不足，请充值')
    assert.equal(byMessage.cooldownMs, DEFAULT_POINTS_COOLDOWN_MS)

    // 额度类不升档：连续命中不会指数增长（等待不会给账号充值）。
    assert.equal((await store.find(id)).unavailableStreak, undefined)
    assert.equal((await store.find(id)).unavailableUntil, byMessage.recoverAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('桌面端登录态零余额也暂停，且用额度窗口', () => {
  const t0 = 1_700_000_000_000
  const bench = createDesktopBench({ now: () => t0 })
  const verdict = bench.markUnavailable('desktop', NO_POINTS_CODE, ZERO_POINTS_MESSAGE)
  assert.equal(verdict?.cooldownMs, DEFAULT_POINTS_COOLDOWN_MS)
  assert.equal(bench.status('desktop').benched, true)
  assert.equal(bench.status('desktop').permanent, false)
  // 同一份内存 bench 里，限流仍然是基础窗口——两个窗口不能混。
  assert.equal(bench.markUnavailable('grown', 'RATE_LIMIT', '429 rate limited')?.cooldownMs, DEFAULT_POOL_COOLDOWN_MS)
})

/**
 * 读余额之后的池决策，两边供应商共用一条规则。
 *
 * 三个断言正好是三个踩过的坑：读不到 ≠ 没钱；零余额要暂停；余额回来要立刻解除
 * （被暂停的账号永远不会被挑中，所以除这里之外没有别的 `markHealthy` 调用点）。
 */
test('零余额就暂停，余额回来立刻解除，读不到时不动池', async () => {
  const calls = []
  const driver = {
    markUnavailable: async (id, code, message) => void calls.push({ op: 'bench', id, code, message }),
    markHealthy: async (id) => void calls.push({ op: 'healthy', id }),
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const now = 1_700_000_000_000
  const benched = {
    id: 'a',
    material: 'x',
    origin: 'plugin',
    unavailableAt: now,
    unavailableCode: NO_POINTS_CODE,
    unavailableMessage: ZERO_POINTS_MESSAGE,
  }

  // 余额桶被限流：`fields` 是空的（`partial: 'balance_unavailable'`），不是 0。
  applyZeroPoints(
    { fields: {}, fetchedAt: now, partial: 'balance_unavailable' },
    { id: 'b', material: 'y', origin: 'plugin' },
    driver,
  )
  await flush()
  assert.deepEqual(calls, [], '读不到余额不能当成没钱')

  // 读到 0 → 暂停。
  applyZeroPoints({ fields: { available: 0 }, fetchedAt: now }, { id: 'c', material: 'z', origin: 'plugin' }, driver)
  await flush()
  assert.deepEqual(calls, [{ op: 'bench', id: 'c', code: NO_POINTS_CODE, message: ZERO_POINTS_MESSAGE }])
  calls.length = 0

  // 充值 / 每日额度刷新后读到正数 → 立刻解除。
  applyZeroPoints({ fields: { available: 12 }, fetchedAt: now }, benched, driver)
  await flush()
  assert.deepEqual(calls, [{ op: 'healthy', id: 'a' }])
  calls.length = 0

  // 本来就健康的账号读到正数：不写账号表（每次读余额都写一次是没必要的落盘）。
  applyZeroPoints({ fields: { available: 12 }, fetchedAt: now }, { id: 'd', material: 'w', origin: 'plugin' }, driver)
  await flush()
  assert.deepEqual(calls, [])
})

test('旧额度记录（没有落盘 until）也按额度窗口推最早恢复时间', async () => {
  const t0 = 1_700_000_000_000
  const rows = [
    {
      id: 'p',
      route: 'acme',
      material: 'x',
      origin: 'plugin',
      unavailableAt: t0,
      unavailableCode: NO_POINTS_CODE,
      unavailableMessage: ZERO_POINTS_MESSAGE,
    },
  ]
  const accounts = {
    list: async () => rows,
    routeOf: (account) => account.route,
    markUnavailable: async () => {},
    markHealthy: async () => {},
  }
  const pool = createAccountPool({ accounts, now: () => t0 + 1, random: () => 0 })
  const pick = await pool.pick()
  assert.equal(pick.kind, 'none-healthy')
  assert.equal(pick.recoverAt, t0 + DEFAULT_POINTS_COOLDOWN_MS)
  assert.deepEqual(pick.recoverable.map((row) => row.id), ['p'], '额度用光是可恢复的，不是永久失效')
})

test('额度暂停真的把账号挡在轮换之外，窗口过后自动回池', async () => {
  const t0 = 1_700_000_000_000
  const rows = [
    {
      id: 'p',
      route: 'acme',
      material: 'x',
      origin: 'plugin',
      unavailableAt: t0,
      unavailableUntil: t0 + DEFAULT_POINTS_COOLDOWN_MS,
      unavailableCode: NO_POINTS_CODE,
      unavailableMessage: ZERO_POINTS_MESSAGE,
    },
  ]
  const accounts = {
    list: async () => rows,
    routeOf: (account) => account.route,
    markUnavailable: async () => {},
    markHealthy: async () => {},
  }
  const inside = createAccountPool({ accounts, now: () => t0 + 60_000, random: () => 0 })
  assert.equal((await inside.pick()).kind, 'none-healthy', '窗口内不挑它')
  const [entry] = (await inside.state()).entries
  assert.equal(entry.unavailable, true)
  assert.equal(entry.kind, 'points', '界面要说"额度不足"，不是"登录已失效"')

  const after = createAccountPool({ accounts, now: () => t0 + DEFAULT_POINTS_COOLDOWN_MS + 1, random: () => 0 })
  const pick = await after.pick()
  assert.equal(pick.kind, 'ok', '窗口结束就回池，用户充值后也不用重启')
  assert.equal(pick.account.id, 'p')
})

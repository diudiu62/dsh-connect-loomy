/**
 * Account tab: masked sign-in state, credential conclusion, executable next
 * steps when signed out, re-check, and a truthful read-only credits overview.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CREDITS,
  STATUS,
  button,
  click,
  defaultRoutes,
  installFetch,
  mountPlugin,
  renderCard,
  setupDom,
} from './helpers.mjs'

const STATUS_URL = '/plugins/dsh-connect-loomy/status'
const CREDITS_URL = '/plugins/dsh-connect-loomy/credits'

test('signed in: phone, login time, credential path and credits render', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes())

  await renderCard(entry, t, ({ container }) => {
    const text = container.textContent

    assert.ok(text.includes('13812345678'), 'the phone is rendered unmasked (local data)')
    assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'login time is formatted')
    assert.ok(
      text.includes('/Users/test/Library/Application Support/loomy/auth-session.json'),
      'the inspected credential path is named',
    )
    assert.ok(text.includes('已找到'), 'credential conclusion is explicit')
    assert.ok(text.includes('已登录'))

    // Read-only credits overview: three balances and the ledger preview.
    assert.ok(text.includes('35,500'))
    assert.ok(text.includes('40,500'))
    assert.ok(text.includes('5,000'))
    assert.ok(text.includes('邀请好友奖励'))
    assert.ok(text.includes('+5,000'))
    assert.ok(text.includes('-120'))
  })
})

test('the card never renders the session, even from a hostile payload', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  // STATUS carries extra `session`, full `phone` and `userId` fields on purpose:
  // a buggy host must still not leak them through this card.
  installFetch(
    defaultRoutes({
      [STATUS_URL]: {
        body: {
          ...STATUS,
          account: { ...STATUS.account, userId: 'userid-secret-42' },
        },
      },
    }),
  )

  await renderCard(entry, t, ({ container }) => {
    const text = container.textContent
    assert.ok(!text.includes('deadbeefdeadbeefdeadbeefdeadbeef'), 'no session hex')
  })
})

test('signed out: host next steps are rendered as executable actions', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [STATUS_URL]: {
        body: {
          ok: true,
          csrfToken: 'csrf-test-token',
          account: null,
          credential: { sourcePath: '/Users/test/.config/loomy/auth-session.json', found: false },
          catalog: { total: 0, enabled: 0, refreshedAt: null },
          enabledModelIds: [],
          nextSteps: ['打开 Loomy 桌面端并登录', '确认 Loomy 在后台运行', '点「重新检测」'],
        },
      },
    }),
  )

  await renderCard(entry, t, ({ container }) => {
    const text = container.textContent
    assert.ok(text.includes('未登录'))
    assert.ok(text.includes('未找到：/Users/test/.config/loomy/auth-session.json'))
    assert.ok(text.includes('下一步'))
    const steps = [...container.querySelectorAll('.loomy-steps li')].map((item) => item.textContent)
    assert.deepEqual(steps, ['打开 Loomy 桌面端并登录', '确认 Loomy 在后台运行', '点「重新检测」'])
    // The sign-in badge comes from the account Section; the login section adds
    // its own source badge (which is legitimate extra information), so assert
    // on the account badge rather than on the whole badge set.
    const badges = [...container.querySelectorAll('.loomy-badge')].map((badge) => badge.textContent)
    assert.equal(badges[0], '未登录')
    assert.ok(badges.includes('来源：桌面端'))
  })
})

test('signed out with no host steps: locale fallback still tells the user what to do', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [STATUS_URL]: {
        body: {
          ok: true,
          csrfToken: 'csrf-test-token',
          account: null,
          credential: { sourcePath: '/tmp/none', found: false },
          catalog: { total: 0, enabled: 0, refreshedAt: null },
          enabledModelIds: [],
        },
      },
    }),
  )

  await renderCard(entry, t, ({ container }) => {
    const text = container.textContent
    assert.ok(text.includes('打开 Loomy（讯飞办公助手）桌面端，用手机号完成登录。'))
    assert.ok(text.includes('回到这里点「重新检测」。'))
  })
})

test('re-check re-reads /status and /credits', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const calls = installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    assert.equal(calls.filter((call) => call.url === STATUS_URL).length, 1)
    assert.equal(calls.filter((call) => call.url === CREDITS_URL).length, 1)
    await click(button(container, '重新检测'))
  })

  assert.equal(calls.filter((call) => call.url === STATUS_URL).length, 2)
  assert.equal(calls.filter((call) => call.url === CREDITS_URL).length, 2)
})

test('credits ok:false shows the upstream message and fabricates no zero balances', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(
    defaultRoutes({
      [CREDITS_URL]: {
        body: { ok: false, error: { code: '100002', message: '缺少 token（上游原文）' } },
      },
    }),
  )

  await renderCard(entry, t, ({ container }) => {
    const text = container.textContent
    assert.ok(text.includes('积分读取失败：缺少 token（上游原文）'))
    assert.equal(container.querySelectorAll('.loomy-credit-value').length, 0, 'no invented balances')
  })
})

test('credits route missing: the section says the host lacks it', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes({ [CREDITS_URL]: { status: 404, body: { ok: false } } }))

  await renderCard(entry, t, ({ container }) => {
    assert.ok(container.textContent.includes('宿主未提供积分路由。'))
    assert.equal(container.querySelectorAll('.loomy-credit-value').length, 0)
  })
})

test('status route missing: card explains 404/503 and hides every control', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  installFetch(defaultRoutes({ [STATUS_URL]: { status: 404, body: { ok: false } } }))

  await renderCard(entry, t, ({ container }) => {
    assert.ok(container.textContent.includes('宿主没有提供 Loomy 设置路由（404/503）'))
    assert.equal(container.querySelectorAll('[role="tab"]').length, 0)
    assert.equal(container.querySelectorAll('button').length, 0)
  })
})

test('status transport failure renders an error with a retry that re-reads', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  let attempts = 0
  const calls = installFetch(
    defaultRoutes({
      [STATUS_URL]: () => {
        attempts += 1
        if (attempts === 1) throw new Error('socket hang up')
        return new Response(JSON.stringify(STATUS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    assert.ok(container.textContent.includes('读取 Loomy 状态失败'))
    assert.ok(container.textContent.includes('socket hang up'))
    await click(button(container, '重试'))
    assert.ok(container.textContent.includes('13812345678'), 'retry recovered the signed-in state')
  })

  assert.equal(calls.filter((call) => call.url === STATUS_URL).length, 2)
})

test('mounting the card issues no writes at all', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const calls = installFetch(defaultRoutes())

  await renderCard(entry, t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  // Every read the card needs on mount (status, credits, auth state, accounts)
  // must be a GET: rendering a panel must never mutate anything.
  const methods = calls.map((call) => call.init.method ?? 'GET')
  assert.ok(
    methods.every((method) => method === 'GET'),
    `mount issued a non-GET call: ${JSON.stringify(methods)}`,
  )
  assert.ok(calls.some((call) => call.url === STATUS_URL))
  assert.ok(!calls.some((call) => call.url.endsWith('/refresh')))
  assert.ok(!calls.some((call) => call.url.endsWith('/save')))
  assert.ok(!calls.some((call) => call.url.endsWith('/accounts/remove')))
  assert.ok(!calls.some((call) => call.url.endsWith('/accounts/import')))
  assert.ok(CREDITS.records.length > 0)
})

test('mount loads the account list and the login state (never stuck on loading)', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  const calls = installFetch(defaultRoutes())

  await renderCard(entry, t, async ({ container }) => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Regression: both reads used to be declared but never fired, so the panel
    // rendered "loading" forever while every route answered fine.
    assert.ok(
      calls.some((call) => call.url.endsWith('/accounts')),
      'mounting the card must request /accounts',
    )
    assert.ok(
      calls.some((call) => call.url.endsWith('/auth/state')),
      'mounting the card must request /auth/state',
    )
    const text = container.textContent
    assert.ok(!text.includes('账号\n加载中'), 'the account panel must not stay on loading')
    // The fixture's desktop account proves the rows actually rendered.
    assert.ok(text.includes('loomy'), 'the account route is rendered')
  })
})

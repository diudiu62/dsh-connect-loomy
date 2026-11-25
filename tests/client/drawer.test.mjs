/**
 * 抽屉的判定规则（纯函数）。
 *
 * 抽屉本身是有状态组件，但真正容易写错的两件事都在纯函数里：
 *
 * 1. **按 `accountId` 配对额度**。多账号共用一个 provider route 时，按 route 配对
 *    会让每一行显示同一个数字——这是旧抽屉的真实缺陷；
 * 2. **主数字取哪个桶**。能力声明的 `role: 'available'`，缺省回落到第一个。
 *
 * 两者都在 `client/format` 里，所以这里不需要 DOM。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatus, click, defaultRoutes, flush, installFetch, mountPlugin, renderCard, resetDom } from './helpers.mjs'

const { exports } = mountPlugin()
const { perAccountAmount, headlineField, formatCredit } = exports

const capability = {
  kind: 'balance',
  fields: [
    { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
    { key: 'available', labelKey: 'credits.field.available', role: 'available' },
  ],
}

const view = {
  fields: { available: 300, daily: 100 },
  fetchedAt: 1,
  perAccount: [
    { accountId: 'a1', route: 'loomy', fields: { available: 100, daily: 10 } },
    { accountId: 'a2', route: 'loomy', fields: { available: 200, daily: 90 } },
    { accountId: 'a3', route: 'loomy', fields: {}, error: '登录已失效' },
  ],
}

test('the headline bucket is the declared role, not the first field', () => {
  assert.equal(headlineField(capability)?.key, 'available')
  // 没有 available 的角色时回落到第一个桶，而不是"没有数字"。
  assert.equal(headlineField({ kind: 'balance', fields: [capability.fields[0]] })?.key, 'daily')
  // 只有流水/没有额度时没有主数字。
  assert.equal(headlineField({ kind: 'ledger' }), undefined)
  assert.equal(headlineField({ kind: 'none' }), undefined)
})

test('each account reads its own figure, keyed by accountId', () => {
  assert.equal(perAccountAmount(view, 'a1', 'available'), 100)
  assert.equal(perAccountAmount(view, 'a2', 'available'), 200)
  // 两个账号共用一个 route，这正是"按 route 配对"会出错的地方。
  assert.equal(perAccountAmount(view, 'a1', 'available') !== perAccountAmount(view, 'a2', 'available'), true)
})

test('an unreadable or unknown account is missing, never zero', () => {
  assert.equal(perAccountAmount(view, 'a3', 'available'), undefined, 'a failed row renders —')
  assert.equal(perAccountAmount(view, 'nope', 'available'), undefined)
  assert.equal(perAccountAmount(view, 'a1', 'nope'), undefined, 'a bucket the vendor does not have')
  assert.equal(perAccountAmount(null, 'a1', 'available'), undefined)
  assert.equal(perAccountAmount(view, 'a1', undefined), undefined)

  // 缺失与"真的 0"必须能区分：0 是余额为零，undefined 是读不到。
  assert.equal(formatCredit(0).missing, false)
  assert.equal(formatCredit(undefined).missing, true)
})

test('a single-account view still pairs by id', () => {
  const single = { fields: { available: 42 }, fetchedAt: 1, perAccount: [{ accountId: 'only', route: 'acme', fields: { available: 42 } }] }
  assert.equal(perAccountAmount(single, 'only', 'available'), 42)
  // 没有 perAccount 的供应商（只报总额）也不能崩：抽屉会显示 —。
  assert.equal(perAccountAmount({ fields: { available: 42 }, fetchedAt: 1 }, 'only', 'available'), undefined)
})

/**
 * 关闭按钮：视觉上只有一个字形，名称必须由 `aria-label` 提供。
 *
 * 纯字形按钮（`<button>×</button>`）在屏幕阅读器里会被念成"乘号"——用户听到的
 * 是符号，不是动作。这类回归不会有任何可见症状，只能在 DOM 层钉住。
 */
test('the drawer close button is an icon with an accessible name', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: { kind: 'balance', fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }] },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [{ id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000000', unavailable: false }],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      const pill = container.querySelector('.dcss-pill')
      assert.ok(pill !== null, 'the badge rendered')
      pill.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 60))

      const close = container.querySelector('.dcss-drawer-close')
      assert.ok(close !== null, 'the drawer has a close control')
      // 视觉上只有一个字形，且该字形对辅助技术隐藏。
      assert.equal(close.textContent?.trim(), '×', 'the visible glyph is a multiplication sign')
      assert.equal(close.querySelector('[aria-hidden="true"]')?.textContent, '×')
      // 名称来自 aria-label：这是图标按钮唯一正确的命名方式。
      assert.equal(close.getAttribute('aria-label'), t('drawer.close'))
      assert.equal(close.getAttribute('title'), t('drawer.close'), 'hover hint matches the name')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 抽屉的键盘可用性：焦点进出、Esc、aria 指向。
 *
 * 这三条都没有可见症状——鼠标用户完全感知不到缺失，只有键盘与读屏用户会撞上。
 */
test('the drawer takes focus, closes on Escape, and hands focus back', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')
  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: { kind: 'balance', fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }] },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [{ id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000000', unavailable: false }],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      const pill = container.querySelector('.dcss-pill')
      assert.ok(pill !== null)
      // 收起时 aria-expanded=false，且不指向任何面板
      assert.equal(pill.getAttribute('aria-expanded'), 'false')
      assert.equal(pill.getAttribute('aria-haspopup'), 'dialog')

      pill.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))

      assert.equal(pill.getAttribute('aria-expanded'), 'true', 'expanded state is announced')
      const controls = pill.getAttribute('aria-controls')
      assert.ok(controls !== null && controls.length > 0)
      // 抽屉存在，且 id 与 aria-controls 对得上
      assert.ok(container.querySelector(`#${controls}`) !== null)

      // 焦点进入抽屉（落在关闭按钮上）
      const close = container.querySelector('.dcss-drawer-close')
      assert.equal(document.activeElement, close, 'focus moved into the drawer')

      // Esc 关闭，并把焦点还给徽标
      document.dispatchEvent(new (globalThis.window.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(container.querySelector('.dcss-drawer'), null, 'Escape closed the drawer')
      assert.equal(document.activeElement, pill, 'focus returned to the badge')
      assert.equal(pill.getAttribute('aria-expanded'), 'false')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 浮层贴边矫正的数学。
 *
 * 真实效果要在有布局的浏览器里看，而本仓库的静态测量页面不跑 React effect，
 * 量不到——所以把这段逻辑做成纯函数，在 Node 里逐个边界断言。
 */
test('a floating panel is shifted to stay inside the viewport', () => {
  const { clampShift } = exports
  const W = 600
  const WIDTH = 260

  // 徽标贴左边：向左溢出 144px → 右移 152px（留 8px 空隙）
  assert.equal(clampShift({ left: -144, right: 116, width: WIDTH }, W), 152)
  // 徽标贴右边：向右溢出 → 左移相应距离
  assert.equal(clampShift({ left: 500, right: 760, width: WIDTH }, W), -168)
  // 完整在内：不动
  assert.equal(clampShift({ left: 100, right: 360, width: WIDTH }, W), 0)
  // 刚好贴边（留 8px）：不动
  assert.equal(clampShift({ left: 8, right: 268, width: WIDTH }, W), 0)
  // 没有布局的宿主给出全 0：不要凭空平移
  assert.equal(clampShift({ left: 0, right: 0, width: 0 }, W), 0)
  // 比视口还宽：平移救不了，交给 max-width
  assert.equal(clampShift({ left: -50, right: 650, width: 700 }, W), 0)
})

/**
 * 抽屉里的两个快捷操作：轮换开关、打开配置。
 *
 * 用户明确要求："胶囊按钮的抽屉加一个打开到配置页面，和一个开启帐号轮询的开关。"
 * 轮换是输入框旁最常被问的事（"这次谁付费"），开关放这里比让人翻设置页合理。
 */
test('the drawer toggles rotation and offers a settings entry', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')
  const posted = []

  const capabilities = {
    accounts: 'multi',
    pool: true,
    login: ['none'],
    credits: { kind: 'balance', fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }] },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  const status = buildStatus({ capabilities })
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          activeId: 'a1',
          accounts: [{ id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', label: '工作号', phone: '13800000001', unavailable: false }],
        },
      },
      '/plugins/dsh-connect-desktop/loomy/pool': (init) => {
        if (init.method === 'POST') {
          const body = JSON.parse(init.body)
          posted.push(body)
          return new Response(
            JSON.stringify({ ok: true, enabled: body.enabled, active: false, total: 1, healthy: 1 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ ok: true, enabled: false, active: false, total: 1, healthy: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await flush()
      const pill = container.querySelector('.dcss-pill')
      assert.ok(pill !== null)
      pill.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
      await flush()

      // 轮换开关：反映宿主状态，勾选后 POST 到 pool 路由。
      const toggle = container.querySelector('[data-dcss-cap="drawer-pool"] input')
      assert.ok(toggle !== null, 'the rotation toggle rendered')
      assert.equal(toggle.checked, false, 'the host said rotation is off')
      await click(toggle)
      assert.deepEqual(posted, [{ enabled: true }], 'toggling posts the new preference')

      // 面板入口：和刷新/关闭一起排在右上角，是图标按钮——名称由 aria-label 提供。
      const configButton = container.querySelector('[data-dcss-cap="drawer-open-config"]')
      assert.ok(configButton !== null, 'the settings entry rendered')
      assert.equal(configButton.getAttribute('aria-label'), t('drawer.openPanel'))
      // 三个动作都在头部，不在正文里另起一行。
      const head = container.querySelector('.dcss-drawer-head')
      assert.ok(head?.contains(configButton) === true, 'the entry sits in the drawer header')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 点抽屉外面就关掉。
 *
 * 抽屉浮在输入框上方、没有遮罩，用户最自然的动作是点别处继续聊天。
 * 触发器徽标本身要排除：它的 onClick 负责开合，两边都处理会让一次点击关两次。
 */
test('clicking outside closes the drawer, clicking the badge does not', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')
  const capabilities = {
    accounts: 'multi',
    pool: false,
    login: ['none'],
    credits: { kind: 'balance', fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }] },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [{ id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000001', unavailable: false }],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await flush()
      const pill = container.querySelector('.dcss-pill')
      const openDrawer = async () => {
        pill.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
        await flush()
      }

      await openDrawer()
      assert.ok(container.querySelector('.dcss-drawer') !== null, '抽屉已打开')

      // 点抽屉内部不关。
      container.querySelector('.dcss-drawer')?.dispatchEvent(
        new (globalThis.window.MouseEvent)('mousedown', { bubbles: true }),
      )
      await flush()
      assert.ok(container.querySelector('.dcss-drawer') !== null, '点抽屉内部不该关')

      // 点外面关掉。
      globalThis.document.body.dispatchEvent(new (globalThis.window.MouseEvent)('mousedown', { bubbles: true }))
      await flush()
      assert.equal(container.querySelector('.dcss-drawer'), null, '点外面应当关掉')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 「打开配置」的跳转：走不通就返回 false（由调用方给指路文案），不抛错。
 *
 * 宿主没有 URL 路由，也没有公开的导航服务，所以这一步只能模拟用户点击：
 * 侧边栏「设置」→ 本插件分区 → 目标 tab。这里用一棵假 DOM 验证它确实按
 * 这个顺序点，以及在结构不符时安静失败。
 */

/**
 * 抽屉里的「打开配置」就地打开配置浮层。
 *
 * 为什么不是跳到宿主的设置页：DSH 的浏览器端没有 URL 路由，也没有公开的导航
 * 服务，唯一可行的手段是模拟点击侧边栏——实测在真实界面里找不到入口（用户点了
 * 只看到"没找到"的提示）。所以改成自己把配置画出来：可靠、可测、不依赖宿主 DOM。
 *
 * 两条路径（设置卡片 / 这个浮层）复用同一个 `ConfigPanel`，字段、校验与乐观锁
 * 完全一致，不存在"这里能改、那里改不了"的偏差。
 */

/**
 * 抽屉里的 ⚙ 打开**完整面板**，默认停在「账号」。
 *
 * 为什么默认账号：用户是从账号抽屉按进来的，此刻他关心的是"谁在付费、还有多少
 * 额度"。把他丢到配置页等于让他自己再找一次。这个浮层替代了"跳到宿主设置页"——
 * 那条路走不通（宿主没有 URL 路由，也没有导航服务）。
 */
test('the drawer opens a full panel sheet on the account tab', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')
  const capabilities = {
    accounts: 'multi',
    pool: true,
    login: ['none'],
    credits: { kind: 'balance', fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }] },
    catalog: { selection: true, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: true,
  }
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          activeId: 'a1',
          accounts: [{ id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', label: '工作号', phone: '13800000001', unavailable: false }],
        },
      },
      '/plugins/dsh-connect-desktop/loomy/config': {
        body: {
          ok: true,
          vendorId: 'loomy',
          revision: 1,
          groups: [],
          fields: [{ key: 'baseURL', type: 'string', value: 'https://a.test', default: 'https://a.test', overridden: false, description: '接口地址' }],
        },
      },
      '/plugins/dsh-connect-desktop/loomy/catalog': { body: { ok: true, models: [], refreshedAt: null, selection: [] } },
      '/plugins/dsh-connect-desktop/loomy/diagnostics': { body: { ok: true, view: {}, probes: [] } },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await flush()
      await click(container.querySelector('.dcss-pill'))
      await flush()
      await click(container.querySelector('[data-dcss-cap="drawer-open-config"]'))
      await flush()

      /*
       * 浮层是 portal：DOM 在 document.body 上，不在徽标的子树里。这条断言正是
       * 修复的机制——浮层挂在输入框周围会继承宿主的 containing block，溢出视口。
       */
      const sheet = globalThis.document.querySelector('[data-dcss-cap="panel-sheet"]')
      assert.equal(container.querySelector('[data-dcss-cap="panel-sheet"]'), null, '浮层不再住在输入框子树里')
      assert.ok(sheet !== null, '面板浮层开了')
      assert.equal(container.querySelector('.dcss-drawer'), null, '抽屉让位给浮层')
      assert.equal(sheet.getAttribute('aria-modal'), 'true', '面板是模态的：有草稿，不该被误点弄丢')

      // 四个 tab 都在，且默认选中「账号」。
      const tabs = [...sheet.querySelectorAll('[role="tab"]')]
      assert.deepEqual(
        tabs.map((element) => element.textContent),
        [t('tabs.account'), t('tabs.models'), t('tabs.config'), t('tabs.diagnostics')],
      )
      assert.equal(tabs[0].getAttribute('aria-selected'), 'true', '默认停在账号')

      await flush()
      assert.ok(sheet.querySelector('[data-dcss-account]') !== null, '账号行渲染出来了')
      assert.equal(sheet.querySelector('[data-dcss-config]'), null, '不该先显示配置')

      // 切到配置：同一个 ConfigPanel，同一份字段。
      await click(tabs[2])
      await flush()
      assert.ok(sheet.querySelector('[data-dcss-config="baseURL"]') !== null, '配置页可切换')
      assert.equal(tabs[2].getAttribute('aria-selected'), 'true')

      // Esc 关闭。
      globalThis.document.dispatchEvent(
        new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
      await flush()
      assert.equal(globalThis.document.querySelector('[data-dcss-cap="panel-sheet"]'), null)
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 抽屉的每一行数字只来自响应里的 `perAccount`，而 host 只在请求带 `accounts=1`
 * 时才装配它（`surface.credits()` 为额度面板省掉 N 次上游请求的那条分支）。
 *
 * 漏掉这个参数的症状极其误导：输入框胶囊用的是顶层 `fields`，照旧显示数字；
 * 抽屉每一行却是 `—`。看起来像"接口没有逐账号余额"，实际是自己没要。
 */
test('the drawer lazily fills each row instead of waiting for the whole batch', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  const calls = installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [
            { id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000001', unavailable: false },
            { id: 'a2', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000002', unavailable: false },
          ],
        },
      },
      // 总额只读一次；每行余额走 `credits/account`，一条一条回来。
      '/plugins/dsh-connect-desktop/loomy/credits': {
        body: { ok: true, fields: { available: 700 }, fetchedAt: 1 },
      },
      '/plugins/dsh-connect-desktop/loomy/credits/account': (init, calls) => {
        const url = calls[calls.length - 1].url
        const id = new URL(url, 'http://x').searchParams.get('id')
        const amount = id === 'a1' ? 300 : id === 'a2' ? 400 : 0
        return new Response(JSON.stringify({ ok: true, fields: { available: amount }, fetchedAt: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await click(container.querySelector('.dcss-pill'))
      await flush()
      const rows = [...container.querySelectorAll('.dcss-drawer-credits')]
      assert.equal(rows.length, 2, '两个账号两行')
      assert.deepEqual(rows.map((row) => row.textContent), ['300', '400'], '每行是自己的数字，不是 —')

      /*
       * 关键行为：逐账号是**单条**请求，不再有 `accounts=1` 的批量往返。
       * 那条批量请求会让 90 个账号的抽屉等 5 秒以上——这正是用户报的问题。
       */
      const creditsCalls = calls.filter((call) => call.url.includes('/loomy/credits'))
      /*
       * 徽标读**合计**时仍然带 `accounts=1`（那是唯一做加法的路径），抽屉则只读
       * 总额。所以断言是"存在一条不带 accounts=1 的 `/credits`"，而不是"全都不带"。
       */
      assert.ok(
        creditsCalls.some((call) => !call.url.includes('accounts=1')),
        `抽屉只该读总额，实际：${creditsCalls.map((call) => call.url).join(' , ')}`,
      )
      const perAccountCalls = calls.filter((call) => call.url.includes('/loomy/credits/account'))
      assert.equal(perAccountCalls.length, 2, '每行一条 lazily-fetched 请求')
      assert.ok(perAccountCalls.some((call) => call.url.includes('id=a1')))
      assert.ok(perAccountCalls.some((call) => call.url.includes('id=a2')))
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 额度读失败时，徽标不能只剩供应商名——那是"积分没显示"这句话的字面来源。
 *
 * 三件事一起钉住：数字位是 `—`、虚线态可被选择器命中、失败原因（上游原话）
 * 出现在 `title` 里（旧代码连 `{available}` 占位符都没替换，title 是字面模板）。
 */
test('a failed credits read shows a dash plus the upstream reason', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'none',
      pool: false,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/credits': {
        body: { ok: false, error: { code: 'UPSTREAM_403', message: '403 Forbidden' } },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      const pill = container.querySelector('.dcss-pill')
      assert.ok(pill !== null)
      const amount = container.querySelector('.dcss-pill-amount')
      assert.equal(amount.textContent, '—', '缺失不是 0，也不该重复供应商名')
      assert.ok(pill.className.includes('dcss-pill-missing'), '失败态可被样式与测试命中')
      assert.ok(pill.getAttribute('title').includes('403 Forbidden'), 'title 里是上游原话')
      assert.equal(amount.getAttribute('data-dcss-cap'), 'pill-amount-missing')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 徽标显示的是**所有账号的合计**，不是"这次轮到谁付费"那一个账号的余额。
 *
 * host 只有在请求带 `accounts=1` 时才会用 `mergeCredits()` 把逐账号数字相加
 * （那是唯一做加法的地方）；不带参数读到的只是 `pickCredential()` 挑中的那个
 * 账号。少了这个参数，徽标数字会随池轮换跳、而且明显偏小。
 */
test('the badge shows the sum across accounts, not the paying account', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'none',
      pool: true,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  const calls = installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/credits': (_init, seen) => {
        // 复刻 host 的两个分支：只有带 accounts=1 时顶层才是合计 + perAccount。
        const merged = seen[seen.length - 1].url.includes('accounts=1')
        return new Response(
          JSON.stringify(
            merged
              ? {
                  ok: true,
                  fields: { available: 700 },
                  fetchedAt: 1,
                  perAccount: [
                    { accountId: 'a1', route: 'loomy', fields: { available: 300 } },
                    { accountId: 'a2', route: 'loomy', fields: { available: 400 } },
                  ],
                }
              : { ok: true, fields: { available: 300 }, fetchedAt: 1 },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      const amount = container.querySelector('.dcss-pill-amount')
      assert.equal(amount.textContent, '700', '合计，不是本次付费账号的 300')

      const creditsCalls = calls.filter((call) => call.url.includes('/loomy/credits'))
      assert.ok(
        creditsCalls.every((call) => call.url.includes('accounts=1')),
        `徽标必须请求逐账号合计，实际：${creditsCalls.map((call) => call.url).join(' , ')}`,
      )
      const title = container.querySelector('.dcss-pill')?.getAttribute('title') ?? ''
      assert.ok(title.includes('700'), 'title 里也是合计')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 合计里漏掉账号时必须说出来。
 *
 * `mergeCredits` 只累加读得到的账号：一个 401 的账号会让合计悄悄变小，而"合计
 * 变小"与"额度被用掉"在界面上没有区别。徽标自己不会逐行解释，所以把"几个账号
 * 读不到"写进 title——具体是哪几个在抽屉里。
 */
test('the badge says when the total left accounts out', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'none',
      pool: true,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/credits': {
        body: {
          ok: true,
          fields: { available: 300 },
          fetchedAt: 1,
          perAccount: [
            { accountId: 'a1', route: 'loomy', fields: { available: 300 } },
            { accountId: 'a2', route: 'loomy', fields: {}, error: 'HTTP 401：authorization_verify_error' },
          ],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      const pill = container.querySelector('.dcss-pill')
      assert.equal(container.querySelector('.dcss-pill-amount').textContent, '300')
      const title = pill.getAttribute('title') ?? ''
      assert.ok(title.includes('1 个账号读不到'), `title 必须点明漏算，实际：${title}`)
      assert.ok(title.includes('300'), '合计数字仍在 title 里')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * "轮换已跳过"必须按原因分家。
 *
 * 401/密钥无效和限流在旧 UI 上是同一句话，于是唯一能做的动作（去重新登录）被
 * 藏起来了；用户只能理解为"插件跳过了一个其实还能用的账号"。
 */
test('the drawer names why an account is benched', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [
            {
              id: 'a1',
              route: 'loomy',
              displayName: 'Loomy',
              origin: 'plugin',
              phone: '13800000001',
              unavailable: true,
              unavailableKind: 'auth',
              unavailableCode: '401',
              unavailableMessage: 'authorization_verify_error',
            },
            {
              id: 'a2',
              route: 'loomy',
              displayName: 'Loomy',
              origin: 'plugin',
              phone: '13800000002',
              unavailable: true,
              unavailableKind: 'temporary',
              unavailableCode: 'RATE_LIMIT',
              unavailableMessage: 'rate limit exceeded',
            },
            { id: 'a3', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000003', unavailable: false },
          ],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await click(container.querySelector('.dcss-pill'))
      await flush()
      const badges = [...container.querySelectorAll('.dcss-drawer-badge')]
      assert.deepEqual(badges.map((badge) => badge.textContent), ['登录已失效', '轮换已跳过'])
      assert.equal(badges[0].getAttribute('title'), 'authorization_verify_error')
      assert.ok(badges[0].className.includes('dcss-drawer-badge-bad'), '失效账号用更重的视觉')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 浮层必须**不属于**输入框子树。
 *
 * 这是"点设置按钮后浮层下半截出视口、要滚页面"的根因：浮层当年渲染在徽标里，
 * 而 composer 那一行带着 transform / 过滤效果（宿主自己的布局与动画）。CSS 里
 * `position: fixed` 的包含块会被祖先的 transform 换成**那个祖先**，于是"视口居中"
 * 变成"以 60px 高的一行居中"，下半截必然落到视口外。
 *
 * 静态 HTML 量不出 DOM 归属，这条只能在 jsdom 里钉：浮层是 body 的直接子节点。
 */
test('the panel sheet is portalled to body, outside the composer subtree', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [
            { id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000001', unavailable: false },
          ],
        },
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await click(container.querySelector('.dcss-pill'))
      await flush()
      // 抽屉里的 ⚙：用户报的那个按钮。
      await click(container.querySelector('[data-dcss-cap="drawer-open-config"]'))
      await flush()

      const layer = globalThis.document.querySelector('.dcss-sheet-layer')
      assert.ok(layer !== null, '浮层渲染出来了')
      assert.equal(globalThis.document.querySelector('.dcss-sheet'), layer.querySelector('.dcss-sheet'))
      assert.equal(layer.parentElement, globalThis.document.body, '浮层挂在 body 上，不继承 composer 的 containing block')
      assert.equal(container.contains(layer), false, '浮层不是输入框子树的一部分')
      // 祖先链上不能有 transform/filter：fixed 的包含块必须还是视口。
      for (let node = layer.parentElement; node !== null; node = node.parentElement) {
        const style = node.style
        assert.equal(style?.transform ?? '', '', `祖先 ${node.tagName} 带 transform，fixed 会退化为它的包含块`)
        assert.equal(style?.filter ?? '', '', `祖先 ${node.tagName} 带 filter，同上`)
      }
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 余额接口被上游限流（明细还能读）时，界面必须说明"限流"，不能说"仍在读取"。
 *
 * 真实事故：`points/v1/balance` 返回 403 空 body，bills 仍 200——host 于是交回
 * 一份 `partial: 'balance_unavailable'` 的视图。旧徽标把它当成"还没读到"，
 * 抽屉则是一列 `—` 且没有任何解释，用户只能理解为"积分又丢了"。
 */
test('a rate-limited balance endpoint says so instead of spinning forever', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  const partial = {
    ok: true,
    fields: {},
    fetchedAt: 1,
    records: [{ description: '对话消耗', direction: 'debit', pointsActual: 3, createdAt: 1 }],
    partial: 'balance_unavailable',
    partialReason: '小浣熊积分接口返回 HTTP 403：',
  }

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [
            { id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000001', unavailable: false },
          ],
        },
      },
      '/plugins/dsh-connect-desktop/loomy/credits': { body: partial },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      const pill = container.querySelector('.dcss-pill')
      assert.equal(container.querySelector('.dcss-pill-amount').textContent, '—')
      const title = pill.getAttribute('title') ?? ''
      assert.ok(title.includes('限流'), `title 必须说明是限流，实际：${title}`)
      assert.ok(!title.includes('仍在读取'), '不是"还在加载"')

      await click(pill)
      await flush()
      const note = globalThis.document.querySelector('[data-dcss-cap="drawer-credits-partial"]')
      assert.ok(note !== null, '抽屉里有一句解释，而不是一列沉默的 —')
      assert.ok(note.textContent.includes('403'), '解释里带上上游原话')
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

/**
 * 合计必须**随着每一行到货**增长，而不是等全部读完再蹦出来。
 *
 * 这是"读到一个更新一个"的可见部分：90 个账号逐条读的时候，用户要能看见进度
 * （已读 N/M）与一个一直在涨的合计，否则打开抽屉就是几秒钟的空白。
 */
test('the drawer total grows as each account lands', async () => {
  await resetDom()
  const { composerEntry, t } = mountPlugin('zh')

  const status = buildStatus({
    capabilities: {
      accounts: 'multi',
      pool: false,
      login: ['none'],
      credits: {
        kind: 'balance',
        fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
      },
      catalog: { selection: false, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: false,
    },
  })

  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: status },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [
            { id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000001', unavailable: false },
            { id: 'a2', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000002', unavailable: false },
            { id: 'a3', route: 'loomy', displayName: 'Loomy', origin: 'plugin', phone: '13800000003', unavailable: false },
          ],
        },
      },
      '/plugins/dsh-connect-desktop/loomy/credits': { body: { ok: true, fields: {}, fetchedAt: 1 } },
      '/plugins/dsh-connect-desktop/loomy/credits/account': (_init, calls) => {
        const id = new URL(calls[calls.length - 1].url, 'http://x').searchParams.get('id')
        if (id === 'a3') {
          // 一个账号失败：它不该被算进合计，但也不该卡住其它两行。
          return new Response(JSON.stringify({ ok: false, error: { code: 'X', message: '401' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const amount = id === 'a1' ? 100 : 250
        return new Response(JSON.stringify({ ok: true, fields: { available: amount }, fetchedAt: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
  )

  await renderCard(
    composerEntry,
    t,
    async ({ container }) => {
      await click(container.querySelector('.dcss-pill'))
      await flush()
      // 等到三行都落地（并发 3，各自一个往返）。
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const progress = globalThis.document.querySelector('[data-dcss-cap="drawer-progress"]')
        if (progress === null) break
        await flush()
      }

      const total = globalThis.document.querySelector('[data-dcss-cap="drawer-total"]')
      assert.ok(total !== null, '抽屉顶部有合计行')
      // 100 + 250；失败的那个账号不计入，也不把合计打成 0。
      assert.equal(total.textContent.includes('350'), true, `合计应为 350，实际：${total.textContent}`)
      const rows = [...container.querySelectorAll('.dcss-drawer-credits')]
      assert.deepEqual(rows.map((row) => row.textContent), ['100', '250', '—'])
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

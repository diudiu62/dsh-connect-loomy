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

      const sheet = container.querySelector('[data-dcss-cap="panel-sheet"]')
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
      assert.equal(container.querySelector('[data-dcss-cap="panel-sheet"]'), null)
    },
    { useProjection: () => ({ next: { provider: 'loomy' } }) },
  )
})

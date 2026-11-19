/**
 * 账号行上的那些"谁可以改"规则。
 *
 * 这些规则不来自供应商名字，而来自**两个事实**：账号来源（桌面端 / 插件自己存的）
 * 和能力声明（`multi` / `transfer` / `adopt` / 轮换开关）。它们最容易在重构里被抹平，
 * 因为"少一个按钮"不会报错，只会让用户点不到或者点错——旧版正是这样让 Raccoon 的
 * 账号既不能改名、桌面身份也出现在可删除列表里。
 *
 * 用 `data-dcss-account` 定位到**具体那一行**再断言，而不是数整页的按钮。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { buildStatus, click, defaultRoutes, flush, installFetch, mountPlugin, renderCard, resetDom } from './helpers.mjs'

const { entry, t } = mountPlugin()

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 两个账号：桌面端持有的那个 + 插件自己登录的那个。 */
const TWO_ACCOUNTS = {
  ok: true,
  rotating: false,
  activeId: 'loomy-b2',
  accounts: [
    {
      id: 'desktop',
      route: 'loomy',
      displayName: 'Loomy',
      origin: 'desktop',
      phone: '13800000000',
      unavailable: false,
    },
    {
      id: 'loomy-b2',
      route: 'loomy',
      displayName: 'Loomy',
      origin: 'plugin',
      label: '工作号',
      phone: '13900001111',
      unavailable: false,
    },
  ],
}

const CAPABILITIES = {
  accounts: 'multi',
  pool: true,
  login: ['none'],
  credits: {
    kind: 'balance',
    fields: [{ key: 'available', labelKey: 'credits.field.available', role: 'available' }],
  },
  catalog: { selection: false, visionOverride: false, reasoningEffort: false },
  transfer: true,
  adopt: true,
  diagnostics: false,
}

/**
 * 渲染卡片并在渲染期间执行断言。
 *
 * 断言必须写在 `run` 里：`renderCard` 在回调返回后会卸载并清空容器，所以
 * "先拿到容器、事后再查"只会查到空 DOM。
 */
async function render(accounts, capabilities, run) {
  const routes = defaultRoutes({
    '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities }) },
    '/plugins/dsh-connect-desktop/loomy/accounts': { body: accounts },
  })
  installFetch(routes)
  return renderCard(entry, t, async ({ container }) => {
    for (let attempt = 0; attempt < 50 && container.querySelectorAll('[data-dcss-account]').length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // 用 getAttribute 过滤，而不是拼属性选择器：不依赖选择器引擎的细节。
    const rowOf = (id) => {
      const element = [...container.querySelectorAll('[data-dcss-account]')].find(
        (candidate) => candidate.getAttribute('data-dcss-account') === id,
      )
      assert.ok(element !== undefined, `account row ${id} rendered`)
      const capElement = (name) => element.querySelector(`[data-dcss-cap="${name}"]`)
      // 次要动作（重命名/导出/移除）收在 ⋯ 菜单里：展开它才是用户真实的路径。
      // 展开要等 React 渲染，所以是 async。
      const openMenu = async () => {
        const trigger = element.querySelector('.dcss-row-menu-trigger')
        if (trigger === null) return false
        trigger.dispatchEvent(new (globalThis.window.MouseEvent)('click', { bubbles: true }))
        await flush()
        return true
      }
      return {
        text: element.textContent ?? '',
        caps: () => [...element.querySelectorAll('[data-dcss-cap]')].map((entry) => entry.getAttribute('data-dcss-cap')),
        className: element.className,
        /** 某些控件是"存在但禁用"（例如轮换开启时的切换），比消失更好发现。 */
        disabled: (name) => capElement(name)?.disabled === true,
        openMenu,
        menuText: () => [...element.querySelectorAll('.dcss-row-menu-item')].map((item) => item.textContent).join(' '),
        hasTooltip: () => element.querySelector('[title]') !== null,
      }
    }
    return run(rowOf)
  })
}

test('the desktop sign-in can be adopted but never renamed, removed or exported', async () => {
  await resetDom()
  await render(TWO_ACCOUNTS, CAPABILITIES, async (row) => {
    const desktop = row('desktop')
    assert.ok(desktop.caps().includes('adopt'), 'a desktop identity can become a stored account')
    // 切回桌面登录态是合法动作（它就是 slot 1 / 池成员），所以 switch 必须留着。
    assert.ok(desktop.caps().includes('switch'), 'switching back to the desktop sign-in stays available')
    // 桌面行没有 ⋯ 菜单：重命名/导出/移除都归客户端所有，插件不该提供入口。
    assert.equal(await desktop.openMenu(), false, 'the desktop row has no action menu')
    // 说明从"与按钮抢宽度的一行文字"变成 Badge 的 tooltip：信息不丢，但不占版面。
    assert.match(desktop.text, /桌面/u, 'the row is marked as the desktop sign-in')
    assert.equal(desktop.hasTooltip(), true, 'the note survives as a tooltip')
  })
})

test('a stored account can be renamed and removed, and cannot be adopted', async () => {
  await resetDom()
  await render(TWO_ACCOUNTS, CAPABILITIES, async (row) => {
    const stored = row('loomy-b2')
    assert.ok(!stored.caps().includes('adopt'), 'only a desktop identity can be adopted')
    // 次要动作在菜单里；能力标记也只在展开后才存在。
    assert.equal(await stored.openMenu(), true, 'a stored account has an action menu')
    assert.ok(stored.caps().includes('rename'), 'rename lives in the menu')
    assert.match(stored.menuText(), /移除/u, 'a stored account can be removed')
  })
})

test('the active account offers no switch button; the others do', async () => {
  await resetDom()
  await render(TWO_ACCOUNTS, CAPABILITIES, async (row) => {
    // activeId = loomy-b2
    assert.match(row('loomy-b2').className, /dcss-acct-row-active/u)
    assert.ok(!row('loomy-b2').caps().includes('switch'), 'switching to the account you are on is a no-op')
    assert.ok(row('desktop').caps().includes('switch'))
  })
})

test('rotation removes the notion of a current account', async () => {
  await resetDom()
  await render({ ...TWO_ACCOUNTS, rotating: true }, CAPABILITIES, (row) => {
    for (const id of ['desktop', 'loomy-b2']) {
      // 轮换时没有"当前账号"可选：按钮留着但禁用，比凭空消失更容易理解。
      assert.ok(row(id).caps().includes('switch'))
      assert.equal(row(id).disabled('switch'), true, 'rotation decides per call: nothing to switch to')
      assert.doesNotMatch(row(id).className, /dcss-acct-row-active/u, 'rotation has no single active account')
    }
  })
})

test('a vendor that does not declare adopt never offers it, even for a desktop identity', async () => {
  await resetDom()
  await render(TWO_ACCOUNTS, { ...CAPABILITIES, adopt: false }, async (row) => {
    assert.ok(!row('desktop').caps().includes('adopt'), 'Raccoon 的桌面身份本来就是池成员，不需要"收养"')
    // 桌面端身份仍然不可改名/删除：那两条来自 origin，不来自 adopt。
    assert.ok(!row('desktop').caps().includes('rename'))
  })
})

test('a vendor without transfer has no per-row export button', async () => {
  await resetDom()
  await render(TWO_ACCOUNTS, { ...CAPABILITIES, transfer: false }, async (row) => {
    await row('loomy-b2').openMenu()
    assert.doesNotMatch(row('loomy-b2').menuText(), /导出/u)
  })
})

/**
 * 账号行显示什么。
 *
 * 用户报过："账号没有显示具体的号码，都是显示「账号 n」。"根因是**登录时没存号码**：
 * 上游 `checkCode` 不总是返回 phone，而插件这边也没用用户亲手输入的号码兜底。
 * 源头已修（`login.ts` 用 `fallbackPhone`），但**存量账号**已经拿不回号码了，
 * 所以回退链本身也必须更有信息量——否则这些用户只能看到没有意义的序号。
 */
test('a row without a phone falls back to something identifying', async () => {
  await resetDom()
  const CAPABILITIES = {
    accounts: 'multi',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  // 四种"缺字段"的账号：只有 label / 只有 userId / 只有 route / 什么都没有。
  const accounts = {
    ok: true,
    rotating: false,
    accounts: [
      { id: 'a1', route: 'loomy', displayName: 'Loomy', origin: 'plugin', label: '工作号', unavailable: false },
      { id: 'a2', route: 'loomy-2', displayName: 'Loomy · 2', origin: 'plugin', userId: 'user-4242', unavailable: false },
      { id: 'a3', route: 'loomy-3', displayName: 'Loomy · 3', origin: 'plugin', unavailable: false },
      { id: 'a4', route: '', displayName: 'Loomy · 4', origin: 'plugin', unavailable: false },
    ],
  }
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: CAPABILITIES }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': { body: accounts },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await flush()
    const textOf = (id) =>
      [...container.querySelectorAll('[data-dcss-account]')]
        .find((element) => element.getAttribute('data-dcss-account') === id)
        ?.textContent?.trim() ?? ''

    assert.match(textOf('a1'), /工作号/u, 'label 优先')
    assert.match(textOf('a2'), /user-4242/u, '没有号码时用 userId，而不是序号')
    /*
     * route **不参与**命名。单路由供应商（小浣熊）的所有账号共用一个 route，
     * 拿它当名字会让每一行都显示 "raccoon"——比序号还难认。这里确认它没有
     * 被当成名字：a3 的 route 是 `loomy-3`，但显示的是序号。
     */
    assert.match(textOf('a3'), /账号\s*3/u, 'route 不能当名字')
    assert.doesNotMatch(textOf('a3'), /loomy-3/u)
    assert.match(textOf('a4'), /账号\s*4/u, '全都没有时才退到序号')
    // 无标识的账号要告诉用户"能做什么"，否则会以为功能坏了。
    const hint = (id) =>
      [...container.querySelectorAll('[data-dcss-account]')]
        .find((element) => element.getAttribute('data-dcss-account') === id)
        ?.querySelector('.dcss-acct-hint')
    assert.ok(hint('a4') !== undefined && hint('a4') !== null, '无标识的账号带一个可操作提示')
    assert.equal(hint('a1'), null, '有名字的账号不需要这个提示')
  })

  // 单路由供应商：多个账号不能因为 route 相同而显示成同一个名字。
  await resetDom()
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: CAPABILITIES }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': {
        body: {
          ok: true,
          rotating: false,
          accounts: [
            { id: 'r1', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', phone: '13800000001', unavailable: false },
            { id: 'r2', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', phone: '13900000002', unavailable: false },
          ],
        },
      },
    }),
  )
  await renderCard(entry, t, async ({ container }) => {
    await flush()
    const texts = [...container.querySelectorAll('[data-dcss-account]')].map((el) => el.textContent?.trim() ?? '')
    assert.match(texts[0], /13800000001/u)
    assert.match(texts[1], /13900000002/u)
    // 关键：两行不能都是 "raccoon"。
    assert.ok(texts.every((text) => !/^raccoon$/u.test(text)), 'the shared route is not a name')
  })
})

/**
 * 旧的「身份类型当 label」数据要能读出有用信息。
 *
 * 早先的代码把上游的 `identity`（personal / enterprise）写进了 label。直接显示
 * 会是一行英文；直接过滤又会退成「账号 3」。正确做法是：有 phone/userId 就显示
 * 它们，只有都没有时才显示「个人账号 / 企业账号」。
 */
test('a legacy identity-kind label still reads as something', async () => {
  await resetDom()
  const CAPABILITIES = {
    accounts: 'multi',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  const accounts = {
    ok: true,
    rotating: false,
    accounts: [
      // label 是身份类型，但有 phone → 显示号码
      { id: 'k1', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', label: 'personal', phone: '13800000001', unavailable: false },
      // 只有 userId → 显示截短的 userId
      { id: 'k2', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', label: 'personal', userId: 'pu-01a1e893-1354-727d-9e59-6a5d522a0172', unavailable: false },
      // 什么都没有 → 显示身份类型的中文，而不是英文原词
      { id: 'k3', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', label: 'enterprise', unavailable: false },
    ],
  }
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: CAPABILITIES }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': { body: accounts },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await flush()
    const textOf = (id) =>
      [...container.querySelectorAll('[data-dcss-account]')]
        .find((element) => element.getAttribute('data-dcss-account') === id)
        ?.textContent?.trim() ?? ''

    assert.match(textOf('k1'), /13800000001/u, '有号码就显示号码，不显示 personal')
    assert.doesNotMatch(textOf('k1'), /personal/u)
    assert.match(textOf('k2'), /pu-01a1e893/u, '只有 userId 时用它区分账号')
    assert.match(textOf('k3'), /企业账号/u, '只剩身份类型时翻译成中文')
    assert.doesNotMatch(textOf('k3'), /enterprise/u)
  })
})

/**
 * 一批"没有号码也没有名字"的账号可以一次清掉。
 *
 * 用户真实数据是 9 条这样的记录（早期导入/反复登录的残留，源头就没有号码）。
 * 一条条点 ⋯ → 移除太折磨，所以只要有两个以上就已经给出批量清理入口——
 * 但仍然二次确认：删掉的是登录态。
 */
test('a batch of unidentifiable accounts can be cleaned up in one go', async () => {
  await resetDom()
  const CAPABILITIES = {
    accounts: 'multi',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  const accounts = {
    ok: true,
    rotating: false,
    accounts: [
      { id: 'u1', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', unavailable: false },
      { id: 'u2', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', unavailable: false },
      { id: 'k1', route: 'raccoon', displayName: '小浣熊', origin: 'plugin', phone: '13800000001', unavailable: false },
    ],
  }
  const removed = []
  installFetch(
    defaultRoutes({
      '/plugins/dsh-connect-desktop/status': { body: buildStatus({ capabilities: CAPABILITIES }) },
      '/plugins/dsh-connect-desktop/loomy/accounts': { body: accounts },
      '/plugins/dsh-connect-desktop/loomy/accounts/remove': (init) => {
        removed.push(JSON.parse(init.body).id)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }),
  )

  await renderCard(entry, t, async ({ container }) => {
    await flush()
    const cleanup = container.querySelector('[data-dcss-cap="cleanup"]')
    assert.ok(cleanup !== null, '两个以上的无标识账号才给入口')
    assert.match(cleanup.textContent ?? '', /2 个/u)

    const open = [...cleanup.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('accounts.cleanup'))
    await click(open)
    const confirm = [...container.querySelectorAll('[data-dcss-cap="cleanup"] button')].find(
      (b) => b.textContent?.includes('移除这'),
    )
    assert.ok(confirm !== undefined, '需要二次确认')
    await click(confirm)
    await flush()

    assert.deepEqual(removed, ['u1', 'u2'], '只删无标识的那两条，不动有号码的')
  })
})

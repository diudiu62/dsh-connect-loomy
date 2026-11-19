/**
 * The vendor contract: capability declaration ⇒ routes, and nothing more.
 *
 * These tests are the machine-checkable form of the rule this refactor exists
 * for: *a new vendor declares capabilities and gets a correct surface* — it
 * never writes a handler, a panel or a route table. If any of these fail, adding
 * vendor #3 means copying logic again.
 *
 * The fake vendors below deliberately do **not** exist in `src/vendors/`: they
 * are the "third vendor" fixture, built from the public contract only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conformanceProblems, planVendorRoutes } from '../../lib/index.js'

/** Minimal descriptor shape the planner reads. */
function descriptorOf(id, capabilities, overrides = {}) {
  return {
    id,
    displayName: overrides.displayName ?? id,
    capabilities,
    accent: '#123456',
    config: { schema: {}, defaults: {} },
  }
}

/**
 * A status credited to a vendor whose accounts are single, balance is three
 * buckets, and there is no plugin-side login.
 */
const ACME_CAPABILITIES = {
  accounts: 'single',
  pool: false,
  login: ['none'],
  credits: {
    kind: 'balance',
    fields: [
      { key: 'available', labelKey: 'credits.field.available', role: 'available' },
      { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
    ],
  },
  catalog: { selection: true, visionOverride: false, reasoningEffort: false },
  transfer: false,
  adopt: false,
  diagnostics: true,
}

/** A surface double: every method the planner can reach, nothing else. */
function surfaceOf(id, capabilities, runtimeOverrides = {}) {
  const runtime = {
    descriptor: descriptorOf(id, capabilities),
    credentials: { read: async () => ({ found: false, problem: 'signed out', candidates: [] }), invalidate() {}, probePaths: () => [] },
    chat: { api: 'openai-completions', compat: {}, toModel: () => ({}), prepareHeaders: (_, headers) => headers },
    routes: async () => [],
    resolveCredential: async () => ({ material: '' }),
    ...runtimeOverrides,
  }
  return {
    descriptor: descriptorOf(id, capabilities),
    runtime,
    status: async () => ({}),
    diagnostics: async () => ({ view: {}, probes: [] }),
    credits: async () => ({ kind: 'failure', failure: { at: 0, path: 'credits', code: 'x', message: 'x' } }),
    catalogView: async () => ({ models: [], refreshedAt: null, selection: null }),
    saveSelection: async (ids) => ids,
    accounts: async () => ({ ok: true, accounts: [], rotating: false }),
    pool: async () => ({ ok: true, enabled: false, active: false, total: 0, healthy: 0 }),
    accountView: (account) => account,
    credentialView: async () => ({ found: false, sourcePath: '', sourceOrigin: 'none', candidates: [] }),
    accountSummary: async () => null,
  }
}

/** Plan the routes and return their suffixes. */
function suffixesOf(id, capabilities, runtimeOverrides = {}) {
  const specs = planVendorRoutes({
    surface: surfaceOf(id, capabilities, runtimeOverrides),
    onChanged: () => undefined,
    invalidate: () => undefined,
  })
  return specs.map((spec) => spec.suffix).sort()
}

test('a new vendor gets a complete surface from its declaration alone', () => {
  // `accounts: 'single'` has an accounts store but no rename, no transfer and
  // no pool — the planner must offer exactly the routes it can serve.
  assert.deepEqual(suffixesOf('acme', ACME_CAPABILITIES), [
    'accounts',
    'accounts/active',
    'accounts/remove',
    'catalog',
    'credits',
    'diagnostics',
    'recheck',
    'refresh',
    'save',
  ])
})

test('capabilities gate routes: no declaration, no route registered', () => {
  const bare = {
    accounts: 'none',
    pool: false,
    login: ['none'],
    credits: { kind: 'none' },
    catalog: { selection: false, visionOverride: false, reasoningEffort: false },
    transfer: false,
    adopt: false,
    diagnostics: false,
  }
  // Nothing declared ⇒ nothing registered. This is what makes a disabled or
  // half-implemented vendor unable to expose (for example) a credential export.
  assert.deepEqual(suffixesOf('bare', bare), [])
})

test('transfer and adopt appear only when the drivers exist', () => {
  const withRenameOnly = { ...ACME_CAPABILITIES, accounts: 'multi' }
  // `multi` promises rename; without the driver the planner must not invent it.
  assert.ok(!suffixesOf('acme', withRenameOnly).includes('accounts/rename'))
  assert.ok(
    suffixesOf('acme', withRenameOnly, { accounts: { rename: async () => undefined } }).includes('accounts/rename'),
  )

  assert.ok(!suffixesOf('acme', ACME_CAPABILITIES).includes('accounts/export'))
  assert.ok(
    suffixesOf('acme', { ...ACME_CAPABILITIES, transfer: true }, {
      accounts: { exportBundle: async () => ({ bundle: { accounts: [] } }), importBundle: async () => ({ added: 0, refreshed: 0, skipped: 0 }) },
    }).includes('accounts/export'),
  )

  assert.ok(!suffixesOf('acme', ACME_CAPABILITIES).includes('accounts/adopt'))
  assert.ok(
    suffixesOf('acme', { ...ACME_CAPABILITIES, adopt: true }, { accounts: { adopt: async () => ({ id: 'x', replaced: false }) } }).includes(
      'accounts/adopt',
    ),
  )
})

test('login routes follow the declared methods', () => {
  const smsOnly = { ...ACME_CAPABILITIES, login: ['sms-code'] }
  const loginDriver = {
    state: async () => ({ ok: true, pluginLoggedIn: false, effectiveSource: 'none' }),
    sendCode: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true, message: '' }),
  }
  const routes = suffixesOf('acme', smsOnly, { login: loginDriver })
  assert.ok(routes.includes('auth/state'))
  assert.ok(routes.includes('auth/send-code'))
  assert.ok(routes.includes('auth/login'))
  assert.ok(routes.includes('auth/logout'))

  // A vendor that only borrows the desktop session has no login routes at all.
  assert.ok(!suffixesOf('acme', ACME_CAPABILITIES, { login: loginDriver }).some((suffix) => suffix.startsWith('auth/')))
})

test('the pool route needs both the declaration and the preference store', () => {
  const pooled = { ...ACME_CAPABILITIES, pool: true }
  assert.ok(!suffixesOf('acme', pooled).includes('pool'))
  const preferences = {
    poolEnabled: async () => true,
    setPoolEnabled: async () => undefined,
    activeAccountId: async () => undefined,
    setActiveAccountId: async () => undefined,
  }
  assert.ok(suffixesOf('acme', pooled, { preferences }).includes('pool'))
})

test('conformance rejects a declaration the runtime does not honour', () => {
  const module = { descriptor: descriptorOf('acme', { ...ACME_CAPABILITIES, accounts: 'multi', pool: true }) }
  // Declared multi-account + pool, but there is no accounts driver at all: this
  // must be a mount-time error, not a tab that renders nothing.
  const problems = conformanceProblems(module, {
    descriptor: module.descriptor,
    credentials: {},
    chat: { api: 'openai-completions' },
  })
  assert.ok(problems.some((problem) => problem.includes('accounts')))
})

test('conformance accepts a runtime that matches its declaration', () => {
  const capabilities = ACME_CAPABILITIES
  const module = { descriptor: descriptorOf('acme', capabilities) }
  const problems = conformanceProblems(module, {
    descriptor: module.descriptor,
    credentials: {},
    accounts: {},
    catalog: {},
    credits: {},
    chat: { api: 'openai-completions' },
    routes: async () => [],
    resolveCredential: async () => ({ material: '' }),
  })
  assert.deepEqual(problems, [])
})

/**
 * 决定性证据：把一家**从未存在过的**供应商挂进真实 registry，它会自动获得
 * 路由、provider 路由与状态条目 —— 不需要改 `src/core`、`src/client` 或任何
 * 路由表。这就是"第三家供应商不用再写一套逻辑"的可执行形式。
 */
test('a third vendor mounts through the real registry with zero core changes', async () => {
  const { createVendorRegistry } = await import('../../lib/index.js')

  const paths = []
  const adapters = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      fn()
      return () => {}
    },
    inject(services, callback) {
      if (services.includes('webServer')) {
        callback({
          effect(fn) {
            fn()
            return () => {}
          },
          webServer: {
            register(route) {
              paths.push(route.path)
              return () => {}
            },
          },
        })
      }
    },
    llm: {
      registerAdapter(routes) {
        adapters.push([...routes])
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }

  const descriptor = {
    id: 'acme',
    displayName: 'Acme',
    accent: '#abcdef',
    capabilities: {
      accounts: 'single',
      pool: false,
      login: ['none'],
      credits: { kind: 'balance', fields: [{ key: 'points', labelKey: 'credits.field.other', role: 'available' }] },
      catalog: { selection: true, visionOverride: false, reasoningEffort: false },
      transfer: false,
      adopt: false,
      diagnostics: true,
    },
    config: { schema: {}, defaults: { baseURL: 'https://acme.test/v1' } },
  }

  const credential = { found: true, material: 'tok', sourcePath: '/tmp/acme', sourceOrigin: 'desktop', candidates: [] }
  const module = {
    descriptor,
    create: () => ({
      descriptor,
      credentials: { read: async () => credential, invalidate() {}, probePaths: () => ['/tmp/acme'] },
      accounts: {
        list: async () => [],
        add: async () => ({ id: 'a1', replaced: false }),
        remove: async () => undefined,
        markUnavailable: async () => undefined,
        markHealthy: async () => undefined,
        routeOf: () => 'acme',
        displayNameOf: () => 'Acme',
      },
      catalog: {
        read: async () => ({ models: [], refreshedAt: null, source: 'memory' }),
        current: () => [],
        enabledIds: () => [],
        enabledModels: () => [],
        refreshedAt: () => null,
        saveSelection: async (ids) => ids,
        kickRefresh: () => undefined,
        hydrate: async () => undefined,
        lastError: () => undefined,
        endpoints: () => [{ label: 'models', url: 'https://acme.test/v1/models' }],
      },
      credits: {
        read: async () => ({ kind: 'ok', credits: { fields: { points: 42 }, fetchedAt: 1 } }),
      },
      chat: {
        api: 'openai-completions',
        compat: {},
        toModel: (model) => ({ id: model.id }),
        prepareHeaders: (_request, headers) => headers,
      },
      async routes() {
        return [{ route: 'acme', displayName: 'Acme', origin: 'desktop' }]
      },
      async resolveCredential() {
        return { material: 'tok' }
      },
    }),
  }

  const registry = createVendorRegistry({
    ctx,
    csrfToken: 'tok',
    logger: { info() {}, warn() {}, error() {} },
    config: () => ({ vendors: {} }),
    enabled: () => true,
    attachments: () => undefined,
    imageAccess: () => undefined,
    modelsUpdated: () => undefined,
  })

  const mounted = await registry.mount(module)
  assert.ok(mounted !== undefined, 'the registry must mount a vendor it has never seen')
  await new Promise((resolve) => setTimeout(resolve, 30))

  // 能力声明直接变成 URL：没有一张手写的路由表。
  assert.deepEqual(paths.sort(), [
    '/plugins/dsh-connect-desktop/acme/accounts',
    '/plugins/dsh-connect-desktop/acme/accounts/active',
    '/plugins/dsh-connect-desktop/acme/accounts/remove',
    '/plugins/dsh-connect-desktop/acme/catalog',
    '/plugins/dsh-connect-desktop/acme/credits',
    '/plugins/dsh-connect-desktop/acme/diagnostics',
    '/plugins/dsh-connect-desktop/acme/recheck',
    '/plugins/dsh-connect-desktop/acme/refresh',
    '/plugins/dsh-connect-desktop/acme/save',
  ])
  // 也没有一段手写的 provider 注册代码。
  assert.deepEqual(adapters, [['acme']])

  const status = await registry.status()
  assert.equal(status[0].id, 'acme')
  assert.equal(status[0].available, true)
  assert.equal(status[0].capabilities.credits.kind, 'balance')
})

/**
 * 两家真实供应商规划出的全部路由必须**路径唯一**。
 *
 * 宿主按 `(kind, path)` 唯一注册，同路径第二次注册会抛错；而抛错发生在 web.effect
 * 里，表现是"所有面板都说宿主未提供该路由"——这条断言把它变成一条可读的失败。
 * （真实踩过：`/config` 的 GET 与 POST 各注册了一条。）
 */
test('every planned route for both real vendors has a unique path', async () => {
  const { createLoomyModule, createRaccoonModule, planVendorRoutes, createVendorSurface, createVendorDeps } = await import(
    '../../lib/index.js'
  )
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  for (const module of [createLoomyModule(), createRaccoonModule()]) {
    const deps = createVendorDeps({
      descriptor: module.descriptor,
      config: () => ({ ...module.descriptor.config.defaults }),
      logger: { info() {}, warn() {}, error() {} },
      storageDir: join(dir, module.descriptor.id),
    })
    const runtime = await module.create(deps)
    const surface = createVendorSurface({ descriptor: module.descriptor, runtime })
    const specs = planVendorRoutes({
      surface,
      onChanged: () => undefined,
      invalidate: () => undefined,
      // 有 settings 服务时才注册 config 路由：这里模拟宿主环境。
      readVendorConfig: () => ({}),
      writeVendorConfig: async () => undefined,
      describeConfig: () => [],
    })
    const suffixes = specs.map((spec) => spec.suffix)
    const duplicates = suffixes.filter((suffix, index) => suffixes.indexOf(suffix) !== index)
    assert.deepEqual(duplicates, [], `${module.descriptor.id} 规划出了重复路由：${duplicates.join(', ')}`)
    // config 必须是一条承载两个动词的 spec，而不是两条。
    const configSpec = specs.find((spec) => spec.suffix === 'config')
    assert.ok(configSpec !== undefined, 'config route is planned when settings are available')
    assert.deepEqual([...configSpec.methods], ['GET', 'POST'])
  }
})

/**
 * 两家真实供应商的能力声明必须锁住几条**设计决策**，否则它们会悄悄漂回默认值。
 */
test('the two real vendors keep their declared decisions', async () => {
  const { createLoomyModule, createRaccoonModule } = await import('../../lib/index.js')

  const loomy = createLoomyModule().descriptor
  assert.equal(loomy.id, 'loomy', 'the id enters the model identity: never rename it')
  assert.equal(loomy.providerVisibility, 'always', 'Loomy is the primary vendor: visible while signed out')
  assert.equal(loomy.capabilities.accounts, 'multi')
  assert.equal(loomy.capabilities.adopt, true)
  assert.equal(loomy.capabilities.transfer, true)
  assert.deepEqual(loomy.capabilities.login, ['sms-code'], 'phone+password was reverted: do not re-declare it')
  // 有余额桶**和**流水：两者都能渲染，不能二选一。
  assert.equal(loomy.capabilities.credits.kind, 'balance')
  assert.equal(loomy.capabilities.credits.ledger, true)

  const raccoon = createRaccoonModule().descriptor
  assert.equal(raccoon.id, 'raccoon')
  assert.equal(raccoon.providerVisibility, 'signed-in', 'no client installed ⇒ no group in the picker')
  assert.equal(raccoon.capabilities.catalog.reasoningEffort, false, 'the gateway does not validate effort')
  assert.equal(raccoon.capabilities.adopt, false, 'the desktop identity is already a pool member')
})

/**
 * 活体探针与 `probePaths()`：结构化诊断回答"本地哪里有问题"，探针回答
 * "上游现在怎么说"。两者缺一，排障就只剩一半证据。
 */
test('diagnostics carries every inspected path, including the ones not reached', async () => {
  const { createLoomyModule, createVendorDeps } = await import('../../lib/index.js')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const authPath = join(dir, 'auth-session.json')
  writeFileSync(authPath, JSON.stringify({ session: 'a'.repeat(40), phone: '13812345678', userid: 'u1' }))
  const saved = process.env['LOOMY_AUTH_SESSION_FILE']
  process.env['LOOMY_AUTH_SESSION_FILE'] = authPath

  try {
    const module = createLoomyModule()
    const runtime = await module.create(
      createVendorDeps({
        descriptor: module.descriptor,
        config: () => ({ ...module.descriptor.config.defaults }),
        logger: { info() {}, warn() {}, error() {} },
        storageDir: join(dir, 'state'),
      }),
    )
    // 候选只有一条（env 是独占替换），但 probePaths 会列出完整候选表。
    assert.deepEqual(runtime.credentials.probePaths(), [authPath])

    // 签出时探针不发任何请求：三行同一句可执行原因。
    // 候选表在 `create()` 时就从环境变量解析，所以必须先改环境再建模块，
    // 否则会拿上一次的有效路径去真的连上游。
    process.env['LOOMY_AUTH_SESSION_FILE'] = join(dir, 'missing.json')
    const signedOut = await module.create(
      createVendorDeps({
        descriptor: module.descriptor,
        config: () => ({ ...module.descriptor.config.defaults }),
        logger: { info() {}, warn() {}, error() {} },
        storageDir: join(dir, 'state2'),
      }),
    )
    const probes = await signedOut.probeEndpoints()
    assert.equal(probes.length, 3, 'models / points / identity')
    for (const probe of probes) {
      assert.equal(probe.ok, false)
      assert.match(probe.reason, /missing\.json/u, 'the inspected path is named')
    }
  } finally {
    if (saved === undefined) delete process.env['LOOMY_AUTH_SESSION_FILE']
    else process.env['LOOMY_AUTH_SESSION_FILE'] = saved
  }
})

test('the probe route exists only for vendors that can probe', () => {
  const withProbe = {
    ...ACME_CAPABILITIES,
  }
  // 没有 probeEndpoints ⇒ 没有这条路由（不是注册后报 501）。
  assert.ok(!suffixesOf('acme', withProbe).includes('diagnostics/probe'))
  assert.ok(
    suffixesOf('acme', withProbe, { probeEndpoints: async () => [] }).includes('diagnostics/probe'),
  )
})

/**
 * 配置必须对**每一家**都可见，包括你从没写过配置的那一家。
 *
 * 这是用户实际报的问题："配置里只看到 loomy，没有小浣熊"。根因是 `vendors` 曾被
 * 声明为 `z.any()`——没有 schema 就没有默认值，视图里只出现手写过的那一片。
 */
test('the vendors schema materialises every vendor slice with its defaults', async () => {
  const { Config } = await import('../../lib/index.js')
  const read = (value) =>
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value

  const parsed = read(Config({}))
  const vendors = read(parsed.vendors)
  assert.deepEqual(Object.keys(vendors).sort(), ['loomy', 'raccoon'], '两家都要出现，哪怕用户没写过配置')

  for (const id of ['loomy', 'raccoon']) {
    const slice = vendors[id]
    assert.ok(Object.keys(slice).length >= 3, `${id} 的字段要有默认值，否则配置视图是空白`)
    assert.equal(typeof slice.enabled, 'boolean')
    assert.equal(typeof slice.baseURL, 'string')
    assert.equal(typeof slice.catalogTtlMs, 'number')
  }
})

test('the config route describes every declared field with type, default and override flag', async () => {
  const { createLoomyModule, createVendorDeps, describeVendorConfig } = await import('../../lib/index.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const module = createLoomyModule()
  const defaults = module.descriptor.config.defaults
  // 三个入参各自回答一件事：生效值 / 用户层 / 声明的默认值。
  const effective = { ...defaults, baseURL: 'https://custom.test/api/v1' }
  const overrides = { baseURL: 'https://custom.test/api/v1' }
  const fields = describeVendorConfig(module.descriptor, effective, overrides)

  const byKey = new Map(fields.map((field) => [field.key, field]))
  // 默认值来自声明，覆盖值来自用户写的片段。
  assert.equal(byKey.get('baseURL').value, 'https://custom.test/api/v1')
  assert.equal(byKey.get('baseURL').default, defaults.baseURL)
  assert.equal(byKey.get('baseURL').overridden, true)
  assert.equal(byKey.get('baseURL').type, 'string')

  /*
   * 关键回归：`overridden` 必须只看用户层。
   * 之前拿"合并后的生效值"判断，而生效值一定包含全部字段，
   * 于是每个字段都显示「已修改」，标记形同虚设。
   */
  const mergedOnly = describeVendorConfig(module.descriptor, effective)
  assert.ok(
    mergedOnly.every((field) => field.overridden === false),
    '合并值里有这个键 ≠ 用户改过它',
  )
  // 但显示值仍要跟着生效值走，不能因为"没改过"就退回默认值。
  assert.equal(
    mergedOnly.find((field) => field.key === 'baseURL').value,
    'https://custom.test/api/v1',
    '显示的永远是生效值',
  )

  assert.equal(byKey.get('catalogTtlMs').value, defaults.catalogTtlMs, '未覆盖的字段回落到默认值')
  assert.equal(byKey.get('catalogTtlMs').overridden, false)
  assert.equal(byKey.get('catalogTtlMs').type, 'number')
  assert.equal(byKey.get('enabled').type, 'boolean')
  assert.equal(byKey.get('visionModelIds').type, 'string-list')
  // 每个字段都带说明，配置页才能解释它是干什么的。
  assert.ok(fields.every((field) => typeof field.description === 'string' && field.description.length > 0))

  // 每个声明的默认字段都必须出现在列表里，不能因为反射漏类型就少一行。
  assert.deepEqual(fields.map((field) => field.key).sort(), Object.keys(defaults).sort())
})

/**
 * 配置的乐观锁：`ifRevision` 缺失时不校验（CLI 写入），带上时过期写入必须被拒绝。
 *
 * 这条规则的价值在于"两个窗口同时改配置"——后写的不该静默覆盖先写的，
 * 而失败方要能知道自己的改动没有落地。
 */
test('a stale config write is rejected instead of silently overwriting', async () => {
  const specs = planVendorRoutes({
    surface: surfaceOf('acme', ACME_CAPABILITIES),
    onChanged: () => undefined,
    invalidate: () => undefined,
    readVendorConfig: () => ({ baseURL: 'https://a.test' }),
    describeConfig: () => [
      { key: 'baseURL', type: 'string', value: 'https://a.test', default: 'https://a.test', overridden: false },
    ],
    configRevision: () => 4,
    writeVendorConfig: async (_vendorId, _patch, expectedRevision) => {
      if (expectedRevision !== undefined && expectedRevision !== 4) {
        const error = new Error('conflict')
        error.name = 'SettingsConflictError'
        throw error
      }
    },
  })

  const configSpec = specs.find((spec) => spec.suffix === 'config')
  assert.ok(configSpec !== undefined, 'the config route is planned when a reader exists')

  // GET 带回版本号
  const reads = await configSpec.run({ req: { method: 'GET' }, query: new URLSearchParams(), body: async () => ({}) })
  assert.equal(reads.revision, 4)

  // 过期写入：宿主拒绝，路由翻成 config_stale
  const stale = await configSpec.run({
    req: { method: 'POST' },
    query: new URLSearchParams(),
    body: async () => ({ fields: { baseURL: 'https://b.test' }, ifRevision: 3 }),
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'config_stale')
  assert.match(stale.error.message, /已被他处修改/u)

  // 正确版本：写入成功
  const fresh = await configSpec.run({
    req: { method: 'POST' },
    query: new URLSearchParams(),
    body: async () => ({ fields: { baseURL: 'https://b.test' }, ifRevision: 4 }),
  })
  assert.equal(fresh.ok, true)

  // 不带版本号：不校验（CLI / 脚本写入）
  const unlocked = await configSpec.run({
    req: { method: 'POST' },
    query: new URLSearchParams(),
    body: async () => ({ fields: { baseURL: 'https://c.test' } }),
  })
  assert.equal(unlocked.ok, true)
})

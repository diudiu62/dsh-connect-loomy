/**
 * Route planning: capabilities in, HTTP surface out.
 *
 * This is the module that makes "a new vendor needs no new routes" true. The
 * vendor never writes a handler; it declares capabilities, and each capability
 * switches on the routes that implement it. A route whose capability is absent
 * is **not registered at all** — not registered-then-404, not registered-then
 * throwing. That is what keeps `enabled: false` from still exposing the
 * credential-export route.
 *
 * @module dsh-connect-desktop/core/routes
 */

import type { RouteSpec } from './http.js'
import type { VendorDescriptor, VendorSurface } from '../vendor-sdk/contracts.js'
import type { ConfigFieldView, ProviderRegisterView } from '../shared/views.js'
import { isRecord, safeErrorMessage } from '../shared/text.js'

export interface PlanOptions {
  surface: VendorSurface
  /** Called after any mutation, so provider routes and caches are reconciled. */
  onChanged: () => Promise<unknown> | unknown
  /**
   * 「重新注册」：把 provider 注册流程**强制**再走一遍。
   *
   * 缺省回落到 `onChanged`（普通 reconcile）；registry 传入的是 manual 触发，
   * 能解开"注册被拒后签名没变、自动路径永远早退"的死锁。CLI/测试不传时路由
   * 照样存在——它只是退化为一次普通 reconcile。
   */
  onRegisterProvider?: () => Promise<unknown> | unknown
  /** Drop the memoised credential after a login/logout. */
  invalidate: () => void
  /** 读一家的配置片；缺省表示"没有 settings 服务"（CLI），于是不注册配置路由。 */
  readVendorConfig?: (vendorId: string) => Record<string, unknown>
  /** 把用户改过的字段写回 profile。 */
  writeVendorConfig?: (
    vendorId: string,
    patch: Record<string, unknown>,
    /** 过期写入会让宿主抛 SettingsConflictError。 */
    expectedRevision?: number,
  ) => Promise<void>
  /** 把配置片翻译成可渲染的字段列表（含类型、默认值、是否被覆盖）。 */
  describeConfig?: (descriptor: VendorDescriptor) => ConfigFieldView[]
  /** 当前配置的版本号；`undefined` 表示宿主没有版本概念（乐观锁关闭）。 */
  configRevision?: (vendorId: string) => number | undefined
  logger?: { warn(message: string, error?: unknown): void }
}

/** Build every route one vendor offers, gated by its own declaration. */
export function planVendorRoutes(options: PlanOptions): RouteSpec[] {
  const { surface } = options
  const runtime = surface.runtime
  const capabilities = surface.descriptor.capabilities
  const wantsLogin = capabilities.login.some((method) => method !== 'none')
  const specs: RouteSpec[] = []

  /**
   * 配置读写。
   *
   * 为什么放在这里而不是让用户在 patch YAML 里手写：`auto: false` 意味着 DSH 不
   * 会为这个 section 生成表单，卡片是唯一的入口。若连这里都不给，用户就只能翻
   * profile 文件——那正是"找不到配置的地方"。
   *
   * 只有 `readVendorConfig` 存在时才注册（CLI 场景没有 settings 服务）。
   */
  if (options.readVendorConfig !== undefined) {
    // 一条 spec 承载两个动词：宿主按 `(kind, path)` 去重，同一个 path 注册第二次
    // 会**直接抛** `webserver: duplicate exact route`，连带把这家后续的路由全部
    // 丢掉。这是只在真机上才会暴露的失败模式（测试里的假 host 不会抛）。
    specs.push({
      suffix: 'config',
      methods: ['GET', 'POST'],
      mutating: true,
      run: async ({ req, body }) => {
        const fields = options.describeConfig?.(surface.descriptor) ?? []
        if (req.method === 'GET') {
          const revision = options.configRevision?.(surface.descriptor.id)
          // 分组由供应商声明；这里只传 id 与文案键，客户端负责翻译。
          const groups = (surface.descriptor.config.groups ?? []).map((group) => ({
            id: group.id,
            labelKey: group.labelKey,
          }))
          return {
            ok: true,
            vendorId: surface.descriptor.id,
            fields,
            ...(revision === undefined ? {} : { revision }),
            ...(groups.length === 0 ? {} : { groups }),
          }
        }
        if (options.writeVendorConfig === undefined) {
          return { ok: false, error: { code: 'config_read_only', message: '当前宿主不支持写入配置。' } }
        }
        const payload = await body()
        if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
        const patch = payload['fields']
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          return badRequest('fields 必须是对象：{ 字段名: 新值 }')
        }
        // `ifRevision` 由客户端在读到配置时带回来。缺省表示"不校验"（CLI、
        // 脚本写入），带上则启用乐观锁。
        const ifRevision = payload['ifRevision']
        const expected = typeof ifRevision === 'number' && Number.isInteger(ifRevision) ? ifRevision : undefined
        try {
          await options.writeVendorConfig(surface.descriptor.id, patch as Record<string, unknown>, expected)
        } catch (error) {
          // 宿主抛的是 SettingsConflictError：它带 expected/actual 两个版本号，
          // 正好够客户端说清楚"你基于第 N 版改的，现在已经是第 M 版"。
          const carried = (error as { name?: string; expected?: unknown; actual?: unknown } | null) ?? {}
          if (carried.name === 'SettingsConflictError') {
            return {
              ok: false,
              error: {
                code: 'config_stale',
                message: `配置已被他处修改（你基于第 ${String(carried.expected ?? '?')} 版，当前是第 ${String(carried.actual ?? '?')} 版）。请重新读取后再保存。`,
              },
            }
          }
          return { ok: false, error: { code: 'config_write_failed', message: safeErrorMessage(error) } }
        }
        // 配置是 volatile 的：写回后下一次读就生效，不需要重启。
        options.invalidate()
        await options.onChanged()
        return { ok: true }
      },
    })
  }

  if (capabilities.diagnostics) {
    specs.push({
      suffix: 'diagnostics',
      methods: ['GET'],
      mutating: false,
      run: async () => ({ ok: true, ...(await surface.diagnostics()).view }),
    })
    /**
     * 活体探针：真的打一次上游。
     *
     * POST + CSRF 而不是 `GET ?probe=1`：这条请求会消耗配额（`/models`、余额、
     * 身份），不能让同机页面用 `<img src>` 触发。
     */
    if (runtime.probeEndpoints !== undefined) {
      specs.push({
        suffix: 'diagnostics/probe',
        methods: ['POST'],
        mutating: true,
        run: async () => {
          const probes = await runtime.probeEndpoints!()
          return { ok: true, probes }
        },
      })
    }
  }

  if (capabilities.credits.kind !== 'none') {
    /*
     * 单账号额度：给**懒加载**用。
     *
     * `credits?accounts=1` 会为每个账号打一次上游（2 并发 + 120ms 间隔），
     * 90 个账号要 5 秒以上，抽屉就一直空着。这条让界面先画行、数字随到随填。
     * 与批量那条共用 `surface` 的实现，所以"失效账号不再问上游"这类规则只有一处。
     */
    specs.push({
      suffix: 'credits/account',
      methods: ['GET'],
      mutating: false,
      run: async ({ query }) => {
        const id = query.get('id')
        if (id === null || id.length === 0) {
          return { ok: false, error: { code: 'bad_request', message: '缺少账号 id。' } } as const
        }
        const readout = await surface.accountCredits(id)
        if (readout.kind === 'failure') {
          // HTTP 200 + ok:false：这一行要能显示上游原话，而不是"路由不存在"。
          return { ok: false, error: { code: readout.failure.code, message: readout.failure.message } } as const
        }
        return { ok: true, ...readout.credits } as const
      },
    })
    specs.push({
      suffix: 'credits',
      methods: ['GET'],
      mutating: false,
      // A user-pressed refresh must not be answered from the 60s cache, or the
      // button looks broken right after a call was made.
      run: async ({ query }) => {
        const merged = await surface.credits({
          force: query.get('force') === '1',
          // 账号页要每行余额，额度面板不需要：后者不传，省下 N 次上游请求。
          withAccounts: query.get('accounts') === '1',
        })
        if (merged.kind === 'failure') {
          // HTTP 200 + ok:false on purpose: the card renders a truthful
          // upstream failure instead of treating it as a missing route.
          return { ok: false, error: { code: merged.failure.code, message: merged.failure.message } }
        }
        return { ok: true, ...merged.credits }
      },
    })
  }

  if (capabilities.catalog.selection) {
    specs.push({
      suffix: 'catalog',
      methods: ['GET'],
      mutating: false,
      run: async ({ query }) => ({ ok: true, ...(await surface.catalogView({ force: query.get('force') === '1' })) }),
    })
    specs.push({
      suffix: 'refresh',
      methods: ['POST'],
      mutating: true,
      run: async () => {
        const view = await surface.catalogView({ force: true })
        options.invalidate()
        await options.onChanged()
        return { ok: true, catalog: view.models, refreshedAt: view.refreshedAt ?? Date.now() }
      },
    })
    specs.push({
      suffix: 'save',
      methods: ['POST'],
      mutating: true,
      run: async ({ body }) => {
        const payload = await body()
        if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
        const ids = Array.isArray(payload['enabledModelIds'])
          ? payload['enabledModelIds'].filter((id): id is string => typeof id === 'string')
          : undefined
        if (ids === undefined) return badRequest('enabledModelIds 必须是字符串数组')
        const enabled = await surface.saveSelection(ids)
        await options.onChanged()
        return { ok: true, enabled }
      },
    })
  }

  if (capabilities.accounts !== 'none') {
    specs.push({
      suffix: 'accounts',
      methods: ['GET'],
      mutating: false,
      run: async () => surface.accounts(),
    })
    /*
     * 回填账号身份：对没有手机号的账号向上游查一次，把号码写回账号表。
     *
     * 为什么需要：手机号只存在于登录那一瞬间和 `user_info` 里。早先的版本没有
     * 在写入时存它，于是那批账号只能显示「账号 3」。现在能查回来——这是一个
     * 一次性修复动作，不是常规路径，所以做成显式按钮而不是在列表渲染时偷偷发请求。
     */
    /*
     * 只有声明了 `enrich` 才注册这条路由。
     *
     * 与其它能力位一致：能力为假时**根本不注册**，调用方看到的是 404（"这个宿主
     * 没有这条路由"），而不是一条"你能调但永远失败"的接口。也让"新供应商零改动"
     * 那条契约测试保持成立——它们的路由数不会因为别家的可选能力而变化。
     */
    if (runtime.accounts?.enrich !== undefined) {
      const enrich = runtime.accounts.enrich.bind(runtime.accounts)
      specs.push({
        suffix: 'accounts/enrich',
        methods: ['POST'],
        mutating: true,
        run: async () => {
          const filled = await enrich()
          await options.onChanged()
          return { ok: true, filled }
        },
      })
    }
    specs.push({
      suffix: 'accounts/active',
      methods: ['GET', 'POST'],
      mutating: true,
      run: async ({ req, body }) => {
        if (req.method === 'GET') return surface.accounts()
        const payload = await body()
        if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
        const id = payload['id']
        if (typeof id !== 'string' || id.length === 0) return badRequest('id 必须是非空字符串')
        if (runtime.preferences === undefined) return badRequest('该供应商不支持选择账号')
        const known = await runtime.accounts?.list({ force: false })
        if (known !== undefined && !known.some((account) => account.id === id)) {
          return { ok: false, error: { code: 'unknown_account', message: '该账号不在账号表里，请先刷新。' } }
        }
        await runtime.preferences.setActiveAccountId(id)
        options.invalidate()
        return surface.accounts()
      },
    })
    specs.push({
      suffix: 'accounts/remove',
      methods: ['POST'],
      mutating: true,
      run: async ({ body }) => {
        const payload = await body()
        if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
        const id = payload['id']
        if (typeof id !== 'string' || id.length === 0) return badRequest('id 必须是非空字符串')
        try {
          await runtime.accounts?.remove(id)
        } catch (error) {
          return { ok: false, error: { code: 'remove_failed', message: safeErrorMessage(error) } }
        }
        // Repoint the selection explicitly rather than leaving a dangling id:
        // the fallback would pick an account anyway, but silently.
        if (runtime.preferences !== undefined) {
          const current = await runtime.preferences.activeAccountId()
          if (current === id) {
            const rest = await runtime.accounts?.list({ force: true })
            await runtime.preferences.setActiveAccountId(rest?.[0]?.id)
          }
        }
        options.invalidate()
        await options.onChanged()
        return { ok: true }
      },
    })
    if (capabilities.accounts === 'multi' && runtime.accounts?.rename !== undefined) {
      specs.push({
        suffix: 'accounts/rename',
        methods: ['POST'],
        mutating: true,
        run: async ({ body }) => {
          const payload = await body()
          if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
          const id = payload['id']
          const label = payload['label']
          if (typeof id !== 'string' || id.length === 0 || typeof label !== 'string') {
            return badRequest('id 与 label 必须是字符串')
          }
          try {
            await runtime.accounts?.rename?.(id, label.slice(0, 40))
          } catch (error) {
            return { ok: false, error: { code: 'rename_failed', message: safeErrorMessage(error) } }
          }
          return { ok: true }
        },
      })
    }
    if (capabilities.adopt && runtime.accounts?.adopt !== undefined) {
      specs.push({
        suffix: 'accounts/adopt',
        methods: ['POST'],
        mutating: true,
        run: async () => {
          try {
            const result = await runtime.accounts?.adopt?.()
            options.invalidate()
            await options.onChanged()
            return { ok: true, ...(result ?? {}) }
          } catch (error) {
            return { ok: false, error: { code: 'adopt_failed', message: safeErrorMessage(error) } }
          }
        },
      })
    }
    if (capabilities.transfer && runtime.accounts?.exportBundle !== undefined) {
      specs.push({
        suffix: 'accounts/export',
        methods: ['POST'],
        mutating: true,
        // POST + CSRF on purpose: a GET would let a same-machine page trigger a
        // secret export through an <img>/navigation without our token.
        run: async ({ body }) => {
          const payload = await body()
          const id = payload !== undefined && typeof payload['id'] === 'string' ? (payload['id'] as string) : undefined
          void id
          try {
            const exported = await runtime.accounts!.exportBundle!()
            const bundle = exported.bundle as { accounts?: unknown[] }
            if (Array.isArray(bundle.accounts) && bundle.accounts.length === 0) {
              return { ok: false, error: { code: 'no_accounts', message: '没有可导出的凭证：请先在账户页登录，或打开桌面客户端登录后点「重新检测」。' } }
            }
            return {
              ok: true,
              bundle: exported.bundle,
              ...(exported.sessionTtlDays === undefined ? {} : { sessionTtlDays: exported.sessionTtlDays }),
            }
          } catch (error) {
            return { ok: false, error: { code: 'export_failed', message: safeErrorMessage(error) } }
          }
        },
      })
      specs.push({
        suffix: 'accounts/import',
        methods: ['POST'],
        mutating: true,
        run: async ({ body }) => {
          const payload = await body()
          if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
          // Two accepted shapes: our own wrapper (`{bundle: …}`) and the raw
          // document the user pasted (a desktop session file, an array, or our
          // exported bundle).
          const document: unknown = isRecord(payload['bundle']) ? payload['bundle'] : payload
          try {
            const result = await runtime.accounts?.importBundle?.(document)
            options.invalidate()
            await options.onChanged()
            const added = result?.added ?? 0
            const refreshed = result?.refreshed ?? 0
            /*
             * "成功返回 0 条"是最难排查的一类静默失败：用户粘的是客户端自己的
             * `auth.json`，字段名没认出来，界面却一声不吭。没有认出**任何**登录态
             * 时如实报错，把认得出的形状列出来——用户自己就能看出差在哪。
             */
            if (added === 0 && refreshed === 0) {
              return {
                ok: false,
                error: {
                  code: 'import_unrecognized',
                  message:
                    '没有从这份内容里认出登录态，因此没有添加任何账号。支持：小浣熊客户端的 auth.json（含 access_token）、' +
                    'Loomy 导出的账号包（含 session）、或本插件「导出」生成的账号包。',
                },
              }
            }
            return { ok: true, added, refreshed, skipped: result?.skipped ?? 0 }
          } catch (error) {
            return { ok: false, error: { code: 'import_failed', message: safeErrorMessage(error) } }
          }
        },
      })
    }
  }

  if (capabilities.pool && runtime.preferences !== undefined) {
    specs.push({
      suffix: 'pool',
      methods: ['GET', 'POST'],
      mutating: true,
      // One spec for both verbs: the web server keys by path, so a second
      // registration for the same path would silently drop the first.
      run: async ({ req, body }) => {
        if (req.method === 'GET') return surface.pool()
        const payload = await body()
        if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
        const enabled = payload['enabled']
        if (typeof enabled !== 'boolean') return badRequest('enabled 必须是布尔值')
        await runtime.preferences?.setPoolEnabled(enabled)
        // The provider route set depends on this preference; reconcile now.
        await options.onChanged()
        return surface.pool()
      },
    })
  }

  // 重新检测：不写任何持久状态，只丢弃凭据缓存并重读一次。
  //
  // 门槛是"这家有身份概念"（账号、登录方式或诊断之一），而不是永远注册：一个
  // 全无能力的供应商不该凭空多出一条路由。POST + CSRF 而不是 GET，避免同机页面
  // 用 `<img>` 触发一次无意的文件读取。
  if (capabilities.accounts !== 'none' || wantsLogin || capabilities.diagnostics) specs.push({
    suffix: 'recheck',
    methods: ['POST'],
    mutating: true,
    run: async () => {
      options.invalidate()
      const credential = await surface.credentialView()
      return { ok: true, credential, available: credential.found && credential.expired !== true }
    },
  })

  // 重新注册：把 provider 注册流程强制再走一遍。
  //
  // 面向"已登录但模型选择器里没有这一组"的残局：注册被拒（名字被别的插件占用、
  // INACTIVE_EFFECT、句柄失效）之后，自动 reconcile 被"签名没变"的幂等阀挡住，
  // 错误说明会永远停在 /status 里。这条路由是卡片上「重新注册」按钮的后端。
  //
  // 门槛：`providerState` 存在（即 registry 在追踪注册）。CLI 没有它，注册这个
  // 概念在那里根本不成立——又一个"能力为假就不注册"的例子。POST + CSRF：它会
  // 改变宿主的路由表，不能让同机页面用 `<img>` 触发。
  if (surface.providerState !== undefined) specs.push({
    suffix: 'register',
    methods: ['POST'],
    mutating: true,
    run: async () => {
      try {
        await (options.onRegisterProvider ?? options.onChanged)()
      } catch (error) {
        return { ok: false, error: { code: 'register_failed', message: safeErrorMessage(error) } }
      }
      const before = surface.providerState?.()
      if (before === undefined) return { ok: true, registered: null, routes: [] } satisfies ProviderRegisterView
      return {
        ok: true,
        registered: before.registered,
        routes: [...before.routes],
        ...(before.error === undefined ? {} : { error: before.error }),
      } satisfies ProviderRegisterView
    },
  })

  if (runtime.login !== undefined && wantsLogin) {
    const login = runtime.login
    specs.push({
      suffix: 'auth/state',
      methods: ['GET'],
      mutating: false,
      run: async () => login.state(),
    })
    if (capabilities.login.includes('sms-code')) {
      specs.push({
        suffix: 'auth/send-code',
        methods: ['POST'],
        mutating: true,
        run: async ({ body }) => {
          const payload = await body()
          const phone = payload?.['phone']
          if (typeof phone !== 'string' || phone.length === 0) return badRequest('phone 必须是非空字符串')
          try {
            return await login.sendCode(phone)
          } catch (error) {
            return { ok: false, error: { code: 'send_code_failed', message: safeErrorMessage(error) } }
          }
        },
      })
    }
    specs.push({
      suffix: 'auth/login',
      methods: ['POST'],
      mutating: true,
      run: async ({ body }) => {
        const payload = await body()
        if (payload === undefined) return badRequest('请求体必须是 JSON 对象')
        const phone = payload['phone']
        const code = payload['code']
        const password = payload['password']
        const method = payload['method'] === 'password' ? 'password' : 'sms-code'
        if (typeof phone !== 'string' || phone.length === 0) return badRequest('phone 必须是非空字符串')
        if (method === 'sms-code' && typeof code !== 'string') return badRequest('code 必须是字符串')
        if (method === 'password' && typeof password !== 'string') return badRequest('password 必须是字符串')
        if (!capabilities.login.includes(method)) return badRequest('该供应商不支持这种登录方式')
        try {
          const result = await login.login({
            phone,
            code: typeof code === 'string' ? code : '',
            ...(typeof password === 'string' ? { password } : {}),
            method,
          })
          options.invalidate()
          await options.onChanged()
          return result
        } catch (error) {
          return { ok: false, error: { code: 'login_failed', message: safeErrorMessage(error) } }
        }
      },
    })
    specs.push({
      suffix: 'auth/logout',
      methods: ['POST'],
      mutating: true,
      run: async () => {
        const result = await login.logout()
        options.invalidate()
        await options.onChanged()
        return result
      },
    })
  }

  return specs
}

function badRequest(message: string): unknown {
  return { ok: false, error: { code: 'bad_request', message } }
}

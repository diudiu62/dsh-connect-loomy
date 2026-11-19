# 多供应商架构：能力矩阵驱动的接入模型

- 范围：`dsh-connect-desktop`（原 `dsh-connect-loomy`）在已接入 Loomy、商汤小浣熊之后的**第三家及以后**供应商接入成本问题。
- 问题陈述：每新增一家供应商都要重写一套宿主逻辑 + 一套设置页面，功能与页面必然漏项；开发效率与质量随供应商数量线性下降。
- 本文日期：2026-11-18。上游事实来源：`src/**`、`src/vendors/raccoon/**`、`src/client/**`、`README.md`、[插件契约](../dsh-plugin-contract.md)、[改名与多供应商计划](./rename-and-multi-vendor-plan.md)。

---

## 0. 结论先行

1. **现在的"分层"只到目录名，没到接口。** 第一家（Loomy）在 `src/` 根目录，第二家（Raccoon）在 `src/vendors/raccoon/`，但后者里的 `accounts / pool / catalog / credits / provider / auth / routes` 与根目录同名模块是一一对应的**手抄副本**，签名还不一样（sync vs async、slot vs id、throw vs Result）。全仓真正被两家共用的抽象只有 3 处：`routeTable()`、`CatalogModel`/`applyVisionOverrides`、`shared/{text,state,paths}`。
2. **"掉页面"不是注意力问题，是结构问题。** 设置卡片由 `Card.tsx` 里一个 `useState<'loomy'|'raccoon'>` + `if (vendor === 'raccoon') return <RaccoonTab/>` 切开；Raccoon 的整套 UI 是 `RaccoonTab.tsx`（946 行）+ `RaccoonDrawer.tsx`（341 行）+ `raccoon-api.ts`（734 行）自包含复制。第三家 = 第三个分支 + 第三份 Tab 壳。
3. **漂移已经发生，不是理论风险。** 已确认 3 处"Loomy 有、Raccoon 界面根本没有入口"：账号重命名、积分流水、结构化诊断报告复制；另有 4 处"同一机制两种叫法"（CSRF 头名、路由前缀 schema、日志前缀、`creditsForAccount` vs `creditsByAccount`），7 处"结构相同各写一份"。
4. **治理缺失是根因的上层。** 没有能力矩阵、没有一致性断言、没有 CI 门禁。唯一的记录是 `RaccoonTab.tsx` 顶部一句注释 "three tabs matching Loomy"。
5. **处理方向：把"一家供应商是什么"写成类型。** `VendorDescriptor` 说明它有什么能力，`VendorRuntime` 说明它怎么实现，`core` 只写一次路由/守卫/缓存/账户/池/适配器，`client` 只按能力拼控件。做完后新增第三家的产出 = 一个 descriptor + 一份协议映射 + 一张能力矩阵填写 + 一组夹具，**`src/client/components/` 新增文件数必须为 0**。

一句话：**今天是"两家不同产品共用一个包名"，不是"一个插件接多家"。**

---

## 1. 现状能力矩阵（用户可见维度）

图例：✅ 有 · ◐ 部分/口径不一致 · ✗ 缺失 · n/a 业务不适用（未登记）

### A. 登录与身份

| 能力 | Loomy | Raccoon | 判断 |
|---|---|---|---|
| 只读复用桌面端登录态 | ✅ `auth.ts` | ✅ `vendors/raccoon/auth.ts` | 各自实现，无共用"候选路径 → 解析 → 过期判定"骨架 |
| 插件内自建登录 | ✅ 短信（解密客户端 `.env.prod`） | ✅ 短信 + 密码（手机号 AES-128-CFB） | **登录方式集合不一致**；密码登录在 Loomy 侧被 revert（`6c84a41`） |
| 登出 | ✅ | ✅ | 一致 |
| 令牌续期 | ✗ 只读不刷新 | ◐ 有 `/refresh-token` 路由但 `auth.ts` 文档明写"不刷新" | 实现与声明自相矛盾 |
| 桌面账号收养为插件账号 | ✅ `/accounts/adopt` | n/a（桌面账号直接是池成员） | 产品语义不同，未登记为 n/a |
| 凭据导出/导入 | ✅ bundle | ✅ bundle | 一致，格式不通用 |
| 稳定槽位编号 `loomy-N` | ✗ 已停用（`routeMode:'single'`） | ✗ 用不透明 id | 两边一致：路由集合不随账号数量变化 |

### B. 账号池

| 能力 | Loomy | Raccoon | 判断 |
|---|---|---|---|
| 列表 / 当前账号 / 切换 | ✅ | ✅ | 一致 |
| **重命名** | ✅ `/accounts/rename` | ✗ 无路由无 UI | **掉功能 #1** |
| 删除 / 轮换开关 / 冷却降权 | ✅ | ✅ | 语义一致，实现两份 |
| 每账号独立路由 `loomy-2..n` | ✅ | ✗ 只有 `raccoon-pool` | 会话绑定粒度不同 |
| 每账号余额 | ✅ `creditsForAccount` | ✅ `creditsByAccount` | **同一概念两个命名** |
| 池候选含桌面账号 | ✗ | ✅ | 差异未登记 |

### C. 积分 / 额度

| 能力 | Loomy | Raccoon | 判断 |
|---|---|---|---|
| 只读余额 | ✅ 3 桶 | ✅ 6 桶 | 桶结构不同，UI 各自硬编码 |
| **流水明细** | ✅ `/points/records` | ✗ | **掉功能 #2** |
| 模型倍率 / TTL+single-flight / 失败不伪造 0 | ✅ | ✅ | 一致，各两份 |
| 胶囊（composer pill） | ✅ | ✅ | 两份实现 + `isLoomyRoute`/`isRaccoonRoute` 手写正则 |
| 跨供应商合并展示 | 明确不做 | — | 正确（两种额度不是同一货币） |

### D. 模型目录

| 能力 | Loomy | Raccoon | 判断 |
|---|---|---|---|
| 拉取 + 缓存 + TTL / 白名单持久化 / vision 覆盖 | ✅ | ✅ | 两份 |
| 档位（effort） | ✅ | ✗ 恒为空（网关不校验） | 正确的不做，但矩阵没登记 n/a |
| 刷新路由 | `/refresh` | `/raccoon/refresh` | **命名不一致** |

### E. 设置卡片

| 能力 | Loomy | Raccoon | 判断 |
|---|---|---|---|
| 三 tab（账号/模型/诊断） | 3 个独立组件文件 | 1 个文件内 3 个 Panel | 结构同、实现异构 |
| **厂商 tab 可见性** | 常驻 | **未装客户端也常驻** | 与 README"没装就没有这一组"承诺不符 |
| 登录表单 / 账号列表 / 模型表 / 诊断面板 | 4 个组件 | 全部内嵌 | 两份 |
| 抽屉 | `AccountDrawer` 214 行 | `RaccoonDrawer` 341 行 | 两份 |
| 视觉皮肤 | `loomy-*` class | **复用 `loomy-*` class** | 品牌名写进共享层 |
| i18n | NS `settings.loomy` | `raccoon.*` 128 键 / 727 总键 | 键空间按厂商裂开 |

### F. 诊断与可观测

| 能力 | Loomy | Raccoon | 判断 |
|---|---|---|---|
| 诊断路由 | ✅ 探针列表 + 候选路径 | ✅ 单条 lastError | 字段结构不同 |
| **复制诊断报告** | ✅ `formatDiagnosticsReport` | ✗ `JSON.stringify` 原始 dump | **掉功能 #3** |
| 客户端构建标记 `CLIENT_BUILD_MARKER` | ✅ | ✗ | 排障无法确认浏览器跑的是哪版 |
| 双前缀兼容 | ✗ | ✅ | 临时措施未登记时限 |
| 日志前缀 | `dsh-connect-loomy:` | `dsh-connect-desktop:` | 同一产品两种自称 |
| CSRF 头名 | `x-loomy-csrf` | `x-raccoon-csrf` | **同一机制两个名字** |
| 失败隔离 | ◐ 无对称 try/catch | ✅ 全包裹 | 反向不一致 |

**这张表就是答案：14 处不一致 = 3 处用户点不到的页面 + 4 处同一机制两种叫法 + 7 处结构相同各写一份。**

---

## 2. 重复实现清单（比 `if` 更贵）

| # | 重复内容 | 位置 | 规模 |
|---|---|---|---|
| 1 | 路由守卫管线（method → loopback → content-type → CSRF 常量时间比对 → try/catch → `{ok:false,error}`）+ `readBody/readJsonObject/corsSafeJson` | `routes.ts:114-174`、`vendors/raccoon/routes.ts:79-143` | ~120 行 ×2 |
| 2 | loopback 校验：`shared/loopback.ts` 有完整实现，Raccoon 另写 `loopbackOk()` 只看 Host 正则 | — | 安全姿态不一致 |
| 3 | 请求体上限：Loomy 有 `MAX_BODY_BYTES=64KB` + `req.destroy()`；Raccoon 无上限 | — | 缺陷 |
| 4 | `DISQUALIFYING` 失败特征表 **3 份且已漂移**（Raccoon 多 `authorization_verify_error`/`200003`） | `pool.ts:68`、`vendors/raccoon/pool.ts:84`、`vendors/raccoon/provider.ts:205` | 3 份正则 |
| 5 | provider 常量（`NO_COST`、`STREAM_IDLE_TIMEOUT_MS`、`REQUEST_IMAGE_BUDGETS`、`INERT_AUTH`、`chunkHasContent`）逐字相同 | `provider.ts:76-120` × `vendors/raccoon/provider.ts:64-100` | ~60 行 |
| 6 | 适配器"池记账"骨架（stream+prepareCall 双包装、"只有出过内容才算成功"、error.code 提取） | 两家各 ~110 行 | 语义完全一致 |
| 7 | TTL + single-flight 缓存壳 | `credits.ts`、`vendors/raccoon/credits.ts`、`vendors/raccoon/catalog.ts`、`auth.ts` | 4 份 |
| 8 | 账户文档读写（原子写 + 0600 + parse 容错 + 健康标记），一份 async 一份 sync | `accounts.ts:372`、`vendors/raccoon/accounts.ts:94` | 2 份 |
| 9 | 客户端传输：`api.ts` 一份通用 `requestRoute` 服务 17 个调用；`raccoon-api.ts` 把同一段 `for (const prefix of PREFIXES)` 循环**抄了 14 遍** | — | ~420 行纯脚手架 |
| 10 | 设置卡片 Tab 壳（loading/abort/draft/dirty/save/diagnostics/redetect） | `Card.tsx:145-838` × `RaccoonTab.tsx:60-946` | 946 行几乎可参数化 |
| 11 | 抽屉同构（行 + 池开关 + 导出/导入 + 错误位） | 214 行 × 341 行 | 2 份 |
| 12 | locale 128 个 `raccoon.*` 键与 Loomy 同构 | — | ~35% 总键是 vendor 副本 |
| 13 | CSS 123 个 `loomy-` 前缀类被 Raccoon 复用 | `styles.ts` | 品牌层未抽象 |
| 14 | 路由前缀单一事实源被破坏：`shared/types.ts:13` 只有 Loomy 前缀，Raccoon 自定义 `PREFIXES` | — | — |

### 顺带确认的缺陷（重构时必须一并修）

1. **`enabled=false` 仍注册全部 handler。** `index.ts:762` 在 enabled 判断**之前**调用 `vendor.registerRoutes(ctx)`，Raccoon 会为 2 前缀 × 17 suffix 全注册——含 `accounts/export`（导出明文 token）与 `accounts/import`。Loomy 侧 `index.ts:643` 同样无条件。**"关闭供应商"目前只关模型，不关写接口。**
2. **死依赖**：`RaccoonMountDeps.registerRoutes` 被声明（`vendors/raccoon/index.ts:121`）、被实现（`index.ts:745`）、但从未被调用；两套注册路径并存。
3. **`apply()` 同步约束被打破**：`vendors/raccoon/index.ts:414` 用 `setTimeout(...,0)` 逃逸，`:426` 用 `void (async()=>await import('./routes.js'))()`，路由注册不可等待，`ctx.effect` 释放顺序不确定。
4. **两套 CSRF 不构成隔离**：同一进程、同一 API server、同一浏览器 origin，攻击面相同；只是双份实现。
5. **Raccoon 每次 `readDeviceId()` 都 `readFileSync`**（`creditsByAccount` 循环里每账号 3 次）。

### 已经被证明正确的两处方向（应推广）

- `accounts.ts:114` `routeTable(vendorId)`：把路由命名空间参数化，两家共用，`LOOMY_ROUTES`/`RACCOON_ROUTES` 都从它派生。这是全仓唯一真正的 vendor 抽象。
- `catalog.ts:144` `applyVisionOverrides`：能力修正是纯函数，可共享（Raccoon 已 re-export）。
- 两家的 `toPiModel` 都产出 `Model<'openai-completions'>`、`compat` 都 pinned——**协议层已同构，缺的只是描述它的类型。**

---

## 3. 目标分层

```
src/
├─ core/                      # 唯一实现，禁止 import vendors/*
│  ├─ http/                   #   守卫管线、body 上限、envelope、CSRF 工厂、upstream
│  ├─ routes/                 #   RoutePlan → 按 capability 生成 RouteSpec[]
│  ├─ ttl.ts                  #   cached / pending / single-flight 单点
│  ├─ pool.ts                 #   健康 / 冷却 / 挑选（DISQUALIFYING 单点）
│  ├─ store/                  #   原子写 0600、文档 parse 容错、路径排队
│  ├─ catalog.ts              #   normalize / override / selection 语义
│  ├─ provider/               #   adapter 基类、INERT_AUTH、image budgets、chunkHasContent
│  └─ registry.ts             #   VendorRegistry：mount / reconcile / dispose
├─ vendor-sdk/                # 只有类型与纯函数，零运行时依赖
│  ├─ contracts.ts            #   VendorModule / VendorDescriptor / Capabilities / 各 Driver
│  └─ conformance.ts          #   可复用契约断言（测试与启动自检共用）
├─ vendors/
│  ├─ loomy/                  # ← 由根目录迁移（行为不变）
│  └─ raccoon/                # ← 收敛为 descriptor + drivers
└─ client/
   ├─ transport.ts            # 一份 requestVendor({vendor, suffix, method, …})
   ├─ capability/             # tabsFor(capabilities) + 通用四面板
   ├─ vendors/<id>/           # 只放 formatter / 品牌图标 / 专属文案
   └─ components/             # 共享视觉原子（类名去 loomy- 前缀）
```

**硬规则（进 review checklist，可 grep 门禁）**

- `core/**`、`vendor-sdk/**` 内**禁止**出现 `'loomy'` / `'raccoon'` 字面量。
- `vendors/<id>/**`**禁止** import 另一个 `vendors/<id2>/**`。
- 新增供应商的 PR diff **不允许**出现在 `core/`、`client/capability/`、`shared/`、`src/client/components/`。
- 同名模块"两份实现"的副本数：`DISQUALIFYING`、`INERT_AUTH`、`REQUEST_IMAGE_BUDGETS` 各 1 份。

---

## 4. 能力矩阵：唯一事实源

### 4.1 矩阵条目定义（六列，缺一列不算定义完）

| 字段 | 说明 |
|---|---|
| `id` | 稳定标识，如 `accounts.rename`、`credits.ledger` |
| 级别 | `required` / `optional` / `n/a`（n/a **必须**附"为什么这家不做"） |
| 用户可见证据 | 哪个页面、哪个控件出现/消失——验收的唯一口径 |
| 空态与降级 | 缺该能力时界面显示什么（不显示 / 灰掉 / 文案） |
| 断言 | 一致性测试怎么判（路由存在？flag 为真时控件在？） |
| 归属层 | L0 平台 / L1 通用能力 / L2 适配器契约 / L3 可选扩展 |

### 4.2 分层职责

- **L0 平台层（供应商一律不许自己实现）**：路由命名 schema、CSRF 令牌与头名、loopback 守卫、`no-store`、TTL+single-flight、错误信封、脱敏管线、诊断信封、注册/卸载生命周期、失败隔离、i18n 键规范、构建标记、日志前缀。
- **L1 通用能力（供应商只给数据，不写组件）**：卡片壳、四个标准面板（账号/模型/额度/诊断）、账号行、登录表单骨架、模型表、胶囊、抽屉、空态/错误态/重新检测。
- **L2 适配器契约（每家必实现，窄接口）**：身份读取（候选路径→解析→过期判定）、请求头、目录映射、余额映射、路由 id 与显示名、能力声明。
- **L3 可选扩展（UI 必须做到"没有也能渲染"）**：多桶额度与流水、倍率、effort 档位、多登录方式、桌面账号收养、每账号独立路由、企业/组织维度。

### 4.3 治理铁律三条

1. **能力用 flag 声明，不用实现存在性推断。** UI 只按 `capabilities` 渲染；未声明的入口**不渲染**，而不是渲染后报错或留空白。
2. **缺省 = required。** 供应商做不了，必须在矩阵显式写 `n/a` 并给理由；空着等于 bug，测试红。
3. **能力矩阵由产品持有，可执行断言由工程持有。** 文档是投影，唯一事实源是类型 + 探针 + 一致性测试；二者必须同源生成。

判定规则（写进矩阵头部，防止以后反复讨论）：

- 矩阵里没有的能力，默认 `required`。
- 新供应商首次接入，`n/a` 条目数 > 总数 20% 时，需要一次产品评审（防止"接入即残缺"）。
- `optional` 能力上线后 3 个月内无任何供应商声明为真，就从矩阵删除（防止矩阵变许愿池）。

---

## 5. 关键契约（类型骨架）

```ts
// src/vendor-sdk/contracts.ts —— 零运行时依赖，只有类型
export interface VendorDescriptor {
  readonly id: string                 // 'loomy' | 'raccoon'；进入 model identity，永不改名
  readonly displayName: string        // 模型选择器分组名
  readonly routes: RouteTable         // routeTable(id)，来自 core
  readonly capabilities: VendorCapabilities
  readonly brand: { icon: unknown; accent: string }
  readonly config: { schema: Schema<Record<string, unknown>>; defaults: Record<string, unknown> }
}

/** 卡片的"生成说明书"——UI 与路由只读这一份 */
export interface VendorCapabilities {
  readonly accounts: 'multi' | 'single' | 'none'
  readonly pool: boolean
  readonly login: readonly ('sms-code' | 'password' | 'refresh-token' | 'none')[]
  readonly credits:
    | { kind: 'none' }
    | { kind: 'ledger' }
    | { kind: 'balance'; fields: readonly CreditField[] }   // 数据驱动余额网格
  readonly catalog: {
    readonly selection: boolean
    readonly visionOverride: boolean
    readonly reasoningEffort: boolean
  }
  readonly transfer: boolean          // /accounts/export|import
  readonly diagnostics: boolean
}

/** Loomy 3 桶与 Raccoon 6 桶都由它渲染，UI 内零分支 */
export interface CreditField {
  readonly key: string                // 'available' | 'daily' | 'monthly' …
  readonly labelKey: string           // locale 键（共享命名空间）
  readonly role: 'available' | 'today' | 'total' | 'other'
}

export type CredentialState<S> =
  | { found: false; problem: string; candidates: readonly CandidateView[] }
  | {
      found: true
      sourcePath: string
      sourceOrigin: 'plugin' | 'desktop' | 'env'
      material: S                     // 只在内存
      accountId?: string
      expiresAt?: number
      identity?: { label?: string; phoneMasked?: string; orgName?: string }
      candidates: readonly CandidateView[]
    }

export interface CredentialDriver<S> {
  read(options?: { force?: boolean }): Promise<CredentialState<S>>
  invalidate(): void
  probePaths(): readonly string[]     // 仅 diagnostics 渲染成 probe 行
}

export interface AccountDriver {
  list(options?: { force?: boolean }): Promise<AccountRowView[]>
  add(input: AccountInput): Promise<AddResult>
  remove(id: string): Promise<MutationResult>
  rename?(id: string, label: string): Promise<MutationResult>
  setActive?(id: string | null): Promise<MutationResult>
  exportBundle(options?: { id?: string }): Promise<{ bundle: unknown; paths: string[] }>
  importBundle(document: unknown): Promise<ImportResult>
  health: HealthSink                  // 写盘细节由 core 的 store 提供
}

export interface CatalogDriver {
  read(options?: { force?: boolean }): Promise<CatalogModel[]>
  refreshedAt(): number | null
  lastError(): UpstreamErrorView | undefined
  selection(): readonly string[] | null
  saveSelection(ids: readonly string[]): Promise<string[]>
  kickStaleRefresh(): void
}

export interface CreditsDriver {
  read(options?: { force?: boolean }): Promise<CreditsReadout>
  readForAccount?(account: AccountRowView): Promise<CreditsReadout>
}

export type CreditsReadout =
  | { kind: 'ok'; values: Record<string, number>; records?: CreditRecordView[]; fetchedAt: number }
  | { kind: 'failure'; failure: UpstreamErrorView }

export interface ChatDriver {
  readonly compat: OpenAICompletionsCompat
  toModel(model: CatalogModel, baseURL: string, route: string): Model<'openai-completions'>
  prepareHeaders(ctx: HeaderContext, headers: Headers): Headers
  readonly labels?: { credentialName: string; inertCredentialError: string }
}

export interface VendorModule {
  readonly descriptor: VendorDescriptor
  create(deps: VendorDeps): Promise<VendorRuntime> | VendorRuntime
}
```

**契约自检**（`vendor-sdk/conformance.ts`，启动 + 测试共用）：`assertRuntime(module, runtime)` 校验"声明了但没实现"——`capabilities.pool && !runtime.accounts`、`capabilities.transfer && !accounts.exportBundle` 之类，启动即抛，而不是让用户点进空 tab。

### 5.1 注册表：取代两套挂载

```ts
export class VendorRegistry {
  async mount(module: VendorModule): Promise<VendorRegistration | undefined> {
    const { descriptor } = module
    const config = this.deps.configFor(descriptor)              // 含 legacy 平铺字段迁移
    const runtime = await module.create({ ...this.deps.vendorDeps(descriptor), config })
    assertRuntime(module, runtime)                              // conformance
    const plan = planRoutes(descriptor, runtime)                // 能力 → 路由
    const disposers = this.deps.webserver.registerAll(plan, this.deps.guards)
    const routes = await this.providerRoutes(runtime)
    const registration = routes.length === 0
      ? undefined
      : this.deps.llm.registerAdapter(routes, this.deps.adapterFor(runtime))
    return { descriptor, runtime, registration, routeDisposers: disposers }
  }
  async reconcile(): Promise<void> { /* 账号变化 / 配置热更 / 开关切换统一入口 */ }
}
```

这一处直接删掉 `index.ts:711` 的 `mountRaccoonVendor()`（80 行）与 Loomy 的 `refreshRoutes()` 并存问题。

### 5.2 能力 → 路由自动生成

```ts
export function planRoutes(d: VendorDescriptor, v: VendorRuntime): RoutePlanEntry[] {
  const c = d.capabilities
  return [
    { suffix: 'status',      methods: ['GET'],  mutating: false, when: () => true },
    { suffix: 'diagnostics', methods: ['GET'],  mutating: false, when: () => c.diagnostics },
    { suffix: 'catalog',     methods: ['GET'],  mutating: false, when: () => !!c.catalog },
    { suffix: 'refresh',     methods: ['POST'], mutating: true,  when: () => c.catalog.selection },
    { suffix: 'save',        methods: ['POST'], mutating: true,  when: () => c.catalog.selection },
    { suffix: 'credits',     methods: ['GET'],  mutating: false, when: () => c.credits.kind !== 'none' },
    { suffix: 'accounts',    methods: ['GET'],  mutating: false, when: () => c.accounts !== 'none' },
    { suffix: 'accounts/rename', methods: ['POST'], mutating: true, when: () => !!c.accounts?.rename },
    { suffix: 'accounts/export', methods: ['POST'], mutating: true, when: () => c.transfer },
    { suffix: 'auth/send-code',  methods: ['POST'], mutating: true, when: () => c.login.includes('sms-code') },
    // pool / adopt / import / logout 同理
  ].filter((e) => e.when(c))
}
```

**关键收益**：`enabled=false` 时一个都不注册（修 §2 缺陷 1）；`when` 为假时**根本不注册**，而不是返回 404 文案。

**守卫管线只写一次**（`core/http/pipeline.ts`）：method → `checkLoopback` → content-type → CSRF（`core/http/csrf.ts` 每 vendor 一次 `randomBytes`，header 名由 descriptor 派生，保留 `x-loomy-csrf`/`x-raccoon-csrf` 别名）→ 64KB body → try/catch → `{ok:false,error}`。

### 5.3 能力 → 设置卡片自动生成

```tsx
export function tabsFor(c: VendorCapabilities, t: Translate): TabDescriptor[] {
  const tabs: TabDescriptor[] = []
  if (c.accounts !== 'none' || c.login.some((m) => m !== 'none') || c.credits.kind !== 'none')
    tabs.push({ key: 'account', label: t('tabs.account'), panel: AccountPanel })
  if (c.catalog.selection || c.catalog.visionOverride)
    tabs.push({ key: 'models', label: t('tabs.models'), panel: ModelsPanel })
  if (c.diagnostics)
    tabs.push({ key: 'diagnostics', label: t('tabs.diagnostics'), panel: DiagnosticsPanel })
  return tabs
}

export function CreditsBody({ credits, fields, t }: CreditsBodyProps) {
  if (fields.kind === 'ledger') return <LedgerTable credits={credits} t={t} />
  if (fields.kind === 'none') return null
  return (
    <div className="dcss-credit-grid">
      {fields.fields.map((f) => (
        <div key={f.key} className="dcss-credit-cell">
          <span className="dcss-label">{t(f.labelKey)}</span>
          <span className="dcss-credit-value">{formatCount(credits.values[f.key] ?? 0)}</span>
        </div>
      ))}
    </div>
  )
}
```

同一套机制顺带解决：

- **胶囊**：`isLoomyRoute`/`isRaccoonRoute` → `registry.matchRoute(provider)`（只用 `descriptor.routes.owns()`）。
- **CSS**：`styles.ts` 的 `loomy-` 前缀 → `dcss-`（无 vendor 名），品牌色由 `descriptor.brand.accent` 写成 `--dcss-accent`。
- **locale**：拆成"能力文案"（`tabs.account`、`credits.field.available`、`pool.label`，共享 1 份）+ "品牌文案"（`vendor.<id>.name`、`vendor.<id>.signInHint`，每家 2–5 条）；`raccoon.*` 的 128 键预计可删 90+。
- **配置**：`config.ts` 的 9 个 `raccoon*` 字段收进 `vendors[id]` 命名空间；旧平铺字段保留为 deprecated 读路径，仅在命名空间缺失时取值——用户 patch 文件不会被重写。

---

## 6. 重构路线（PR 顺序 / 迁移路径 / 兼容层）

> 原则：**每个 PR 独立可发布、行为可回归、用户数据零迁移**。core 下沉与 Loomy 搬迁分开；UI 生成化最后做；同一版本内不混"补缺口"与"平台化"。

### 阶段 0 · 止损与定稿（0.2.x，3–5 天，P0）
目标：让矩阵存在，把"用户点不到"的 3 处补回来，**不动架构**。

1. 把 §1 矩阵定稿为唯一事实源（文档 + 类型两处同源）。
2. 显式登记 `n/a`：Raccoon 的 `accounts.adopt`、`catalog.reasoningEffort`；Loomy 的 `pool.desktopMember`、`token.refresh`。**把"没做"与"不做"区分开**，这是治理分水岭。
3. 修 3 处掉功能：Raccoon 账号重命名；流水若不做则在矩阵登记 `n/a` 并在 UI 说明；诊断复制改为统一 `formatDiagnosticsReport`。
4. 修 3 处"同一机制两种叫法"：CSRF 头名、路由 schema、日志前缀。
5. 修 tab 可见性：未检测到客户端不渲染该厂商 tab（与模型选择器口径一致）。
6. 修 `enabled=false` 仍注册写接口的缺陷（`index.ts:762/643`）。

> 为什么不先抽象：现在两家长得不一样，先抽象会把差异一起固化。

### 阶段 1 · 一致性守卫（0.2.x+1，1 周，P0）
目标：**把"掉页面"从人的注意力问题变成 CI 红。**

1. 矩阵 → 生成断言：每个 `required` 能力在每家供应商上"路由存在 / flag 为真 / 控件出现"三选一必须成立。
2. `creditsForAccount` 与 `creditsByAccount` 对外统一为一个名字。
3. 补 Raccoon 的客户端表层测试（目前只有 `registration.test.mjs` 提到它）。
4. §7 的 checklist 进 CI 与 PR 模板。

### 阶段 2 · 宿主下沉（PR1–PR4，2 周，P1）

| PR | 内容 | 兼容做法 | 顺带修复 |
|---|---|---|---|
| PR0 | 冻结基线：golden HTTP 快照（每家每 path 的 `{status, headers, body-schema}`）、`tests/fixtures/legacy/` 升级样本、`scripts/audit/vendor-duplication.mjs` 度量脚本（CI 告警不阻塞） | — | 为后续 PR 提供回归网 |
| PR1 | 新增 `vendor-sdk/contracts.ts`、`core/registry.ts`、`core/routes/table.ts`（`routeTable` 原样搬入，`accounts.ts` re-export 保持）；`/status` 增 `vendors: [{id, displayName, capabilities}]` 供 UI 读取 | 旧路径仍在跑，只读挂载 | §2 缺陷 2 |
| PR2a | `core/http/pipeline.ts`：守卫 + body 上限 + CSRF 工厂 + envelope，Raccoon 改用它 | 保留双 header 名；`loopbackOk` 收敛到 `checkLoopback` | 缺陷 1/2/3、§2#1#2#3 |
| PR2b | `core/pool.ts`：`createPool({accounts, policy})`，`DISQUALIFYING` 单点（两家并集 + 按 vendor 可追加） | 两个 `pool.ts` 变薄壳，导出名不变 | §2#4 |
| PR2c | `core/ttl.ts`：`memo({ttl, singleFlight})` | 四处缓存壳换内部实现，`read()` 签名不变 | §2#7 |
| PR2d | `core/store.ts`：原子写 + parse 容错 + 健康标记 + 按路径排队；`createAccountsStore` 接受 `slotPolicy: 'slots' \| 'ids'` | Raccoon 从 sync fs 迁 async，保留同步包装一个 minor | §2#5#8 |
| PR3 | `git mv src/{auth,login,plugin-auth,catalog,credits,pool,accounts,provider,routes}.ts src/vendors/loomy/`；`shared/upstream.ts → core/http/upstream.ts`；`shared/xfyun.ts → vendors/loomy/auth/xfyun.ts`。`index.ts` 改为 `registry.mount(loomyModule)` | **`index.ts` 的测试导出面（约 120 行 re-export）全保留**；存储路径 `storages/dsh-connect-loomy/` **一字不改**；路由键 `loomy`/`loomy-N`/`loomy-pool` 与模型 identity 不改 | — |
| PR4 | Raccoon 收敛为五个 driver；删死依赖 `RaccoonMountDeps.registerRoutes`、删 `setTimeout(...,0)` 与动态 import 路由，注册回到 `apply()` 同步窗口 | 双前缀保留；`x-raccoon-csrf` 保留 | 缺陷 1/2/3 |

### 阶段 3 · 客户端平台化（PR5–PR7，2–3 周，P1）
目标：**第三家接入时 `src/client/components/` 新增文件 = 0。**

| PR | 内容 | 兼容做法 |
|---|---|---|
| PR5 | `src/client/transport.ts`：一份 `requestVendor<T>({vendor, suffix, method, body, csrf, prefixes, signal})`，内含 prefix 回退、405→`stale`、`ok:false`→`failed`、`unavailable` 四态；`raccoon-api.ts` 的 14 个手写循环 → 14 个 3 行声明（约 −400 行） | `api.ts` 全部具名导出改为薄封装，**组件不改** |
| PR6 | `Card.tsx` 删 `vendor` state 与 `if (vendor === 'raccoon')`，改为 `vendors.map(descriptor)` 生成切换条 + `tabsFor(capabilities)` 生成 tab；`RaccoonTab.tsx`(946) 拆解进 `client/capability/`；`ComposerPill` 改用 `registry.matchRoute` | `CLIENT_BUILD_MARKER` 升版；locale 旧键保留一个 minor（`t()` 回退旧键） |
| PR7 | 配置 schema 命名空间化（`vendors[id]`），旧平铺字段保留 deprecated 读路径 | `.volatile()` 保持；`vendors` 键缺省时不回写 |

**迁移顺序**：先迁 Raccoon（复制品、风险低、用户少），跑两周再迁 Loomy（用户多、会话历史敏感）；用 feature flag 并行，不做大爆炸。

### 阶段 4 · 清理与冷启动（下个 minor，P2）
删兼容别名（旧路由前缀、旧 CSRF header、旧 locale 键、旧账户文件名读取分支）、删无引用导出、audit 脚本从告警改阻塞。此时新增供应商的产出应只有：一个 descriptor、一份映射、一张矩阵填写、一组夹具，外加 1 行 `registry.mount()`。

### 新增第三家的成本对比

| | 现在 | 目标 |
|---|---|---|
| 新增文件 | `vendors/x/{index,auth,accounts,catalog,credits,pool,provider,routes}.ts` + `client/{x-api,components/XTab,XDrawer}.tsx` | `vendors/x/{index,api}.ts` + `client/vendors/x/{formatters,icon}.tsx` |
| 改动共享文件 | `config.ts`(+9 字段)、`index.ts`(+80 挂载)、`shared/types.ts`(+ROUTES)、`client/api.ts`、`Card.tsx`、`locale.ts`(+120 键)、`styles.ts` | 1 行注册 |
| 代码量 | ~2 300 行 | ~300–400 行 |
| 遗漏风险 | 高（已实证：`enabled` 生效范围、body 上限、loopback 一致性、3 处 UI 缺失） | 低（能力声明 + conformance 断言） |

---

## 7. 供应商接入 checklist（每项可机器判）

**门 0 · 准入**

- [ ] 有可读的桌面端本地登录态 → 产出候选路径清单 + 实测路径
- [ ] 有稳定模型目录 + 只读余额接口 → 产出字段实测记录（格式参照 `docs/raccoon-upstream.md`）
- [ ] 需求侧 ≥ 3 次独立请求或明确付费诉求
- [ ] 适配成本 ≤ 1 人周（不含侦察）
- [ ] **填完整张能力矩阵，含显式 `n/a` 及理由**

**门 1 · 宿主契约（只实现 L2）**

- [ ] 凭据读取只读、不写回、不刷新；若要刷新必须在矩阵登记 `token.refresh` 策略
- [ ] 路由 id、显示名、`api` 串、模型 identity 冻结并写入常量
- [ ] 目录/余额映射到通用信封，**不新增字段名**
- [ ] 能力声明中 `vision` / `effort` / `buckets` / `ledger` / `loginMethods` / `pool.perAccountRoute` 全部显式取值
- [ ] 挂载失败隔离，不影响其它供应商（两家都要有，目前只有一家有）
- [ ] `assertRuntime` 通过

**门 2 · 界面（只声明，不写组件）**

- [ ] 卡片壳零改动；四个面板零新增文件
- [ ] 未检测到客户端 → 该厂商 tab **不出现**（模型选择器与设置卡片口径一致）
- [ ] 登录表单只声明方式列表，不声明布局
- [ ] 额度只声明桶的 label + 单位，不声明排版
- [ ] 诊断走统一 `formatDiagnosticsReport`，含版本、路径、构建标记
- [ ] 胶囊与抽屉由 descriptor 驱动，不新增 `is<Vendor>Route` 正则
- [ ] 本 PR 内 `src/client/components/` 新增文件数 = **0**

**门 3 · 回归与发布**

- [ ] 一致性测试绿：矩阵每个 `required` 项在每家都成立
- [ ] 两家交叉切换 6 次，胶囊/抽屉/账号列表不串味
- [ ] 一家坏不影响另一家（**双向**）
- [ ] 老用户数据零迁移（`accounts.json`、`state.json` 原地可读）
- [ ] `enabled=false` 时该厂商零 handler（curl 404）

---

## 8. 测试策略

| 层 | 内容 | 解决的痛点 |
|---|---|---|
| ① 契约测试（新增，最重要）`tests/contract/vendor-conformance.test.mjs` | 对每家 module 跑同一套：descriptor 与 runtime 一致、`/status` 未登录仍 200、失败必是 `{ok:false,error:{code,message}}`、**不返回 token**（红线）、能力声明 ⊆ 实际注册的路由 | 新增供应商不会漏功能 |
| ② 能力矩阵快照 `tests/client/capability-matrix.test.mjs` | 组合 `{accounts} × {credits} × {pool} × {login}` 渲染 `AccountPanel`，jsdom 快照断言"声明的能力 = 出现的控件集合" | **直接消灭"页面遗漏"** |
| ③ Fake vendor fixture `tests/fixtures/vendor-acme/` | 只声明能力、不写 UI 的假供应商（`accounts:'single'`、`credits:{kind:'balance'}`、`login:['none']`）；断言自动出现 `acme/status`、`acme/credits` 路由 + acme 切换条 + 两个 tab；`/acme/accounts` **不**注册 | 验证生成器无遗漏分支 |
| ④ golden HTTP 快照 | PR0 建立，全程 diff 路径/方法/状态码/body JSON Schema（非逐字节，避免时间戳噪声） | 行为零回归 |
| ⑤ 升级矩阵 `tests/upgrade/*` | 0.1.3 / 0.2.0 的 `$DSH_HOME` 快照 → 新版本读出账号数、slot、activeAccountId、poolEnabled、selection、token 全一致；旧 patch 文件 effective config 逐字段相等 | 用户数据零迁移 |
| ⑥ 并发/池行为 | 沿用 `tests/host/pool.test.mjs` 的确定性注入（`random`/`now`），新增并发 `pick()` 不重复、读-改-写不丢更新 | 状态正确性 |
| ⑦ bundle 静态断言 | 校验导出面与 `CLIENT_BUILD_MARKER`；新增"产物内不含 `vendor ===`"grep 断言 | 防回潮 |
| ⑧ 手工验收（每 PR 必过） | 模型选择器两家分组 → 切模型后 composer badge 跟随 → 设置卡片各三 tab → 禁用一家后分组与路由同时消失 → 导出/导入 round-trip → 重启 DSH 配置不丢 | 端到端 |

---

## 9. 风险表

| # | 风险 | 触发点 | 缓解 |
|---|---|---|---|
| R1 | **模型身份被改** → 历史会话显示"未知模型" | provider id 从 `loomy`/`raccoon` 改成别的 | `VendorDescriptor.id` 冻结 + 契约测试断言 `id ∈ {'loomy','raccoon'}`；PR3/PR4 只搬文件不改字符串 |
| R2 | **存储路径被改** → 用户账号"消失" | 把 `storages/dsh-connect-loomy/` 改成新包名 | 目录名冻结（含旧包名）；`core/store` 只接路径不改路径；升级矩阵 |
| R3 | `state.json` schema 变更丢 selection/activeAccountId | PR2d / PR7 | `parseState` 向后兼容，新增字段只增不删；`STATE_VERSION` 暂不升 |
| R4 | 路由前缀 / CSRF header 改名 → 旧 bundle 404/403 | PR2a / PR6 | 一个 minor 内双前缀 + 双 header；`stale`(405) 分支已能提示"重启 DSH" |
| R5 | `apply()` 同步约束被破坏（路由注册变异步） | PR4 | conformance 断言"mount 后同步可查询 route 列表"；删 `setTimeout`/动态 import |
| R6 | 能力声明与实现脱节 | 新增 vendor | `assertRuntime()` 启动即抛 + 契约测试跑同一套 |
| R7 | Raccoon 从 sync fs 改 async 引入竞态 | PR2d | `core/store` 对同路径排队（复用 `state.ts:162` 的 queue 模式）+ 并发写测试 |
| R8 | 两家失败特征表合并误伤（可重试错误被判"跳账号"） | PR2b | 并集保守 + `policy.extraPatterns` 按 vendor 追加 + 真实报文表驱动测试 |
| R9 | UI 生成化丢掉 vendor 专属信息（`expiresAt`/`orgName`） | PR6 | 能力里加 `identity: { fields: [...] }`；快照逐字段覆盖 |
| R10 | 单文件 bundle 的测试耦合 | 全程 | `index.ts` 测试导出面在阶段 4 前不得删 |

---

## 10. 度量与门禁（防再次腐化）

| 指标 | 现在 | 目标 | 门禁 |
|---|---|---|---|
| `core/`、`vendor-sdk/` 内 vendor 字面量 | — | 0 | CI 阻塞 |
| `client/` 内 `vendor ===` 分支 | 2 | 0 | CI 阻塞 |
| 新增供应商 client 新增组件文件数 | 2（Tab + Drawer）+ 1 API | 0 | review |
| 新增供应商 client 新增行数 | ≈ 2.0k | < 300 | 告警 |
| `vendors/<id>/` 行数上限 | raccoon 2 728 | ≤ 600 | 告警（说明抽象不足） |
| 同一机制多种命名 | 4 处 | 0 | review |
| 两家用户可见能力差 | 10 项（含 3 项缺失） | 仅剩显式 `n/a` | 契约测试 |

全部是**仓库内可判**指标，不需要遥测。

---

## 11. 明确不做

- **不做登录协议 DSL。** 各家加密方式、参数名、app 凭证来源都不同（Loomy 要解密 `.env.prod`，Raccoon 要对手机号 AES），抽象成本远大于收益；只统一"方式列表 + 表单骨架"。
- **不做第三方自带 vendor 包。** 会破坏"一个插件、只读复用本机授权"的信任叙事，也会把双装冲突变成常态。
- **不为对齐而补齐无意义功能。** Raccoon 没有流水就登记 `n/a`；强造空流水页比缺页面更糟。
- **不做跨供应商余额合并**（两种额度不是同一货币）。
- **不在同一版本内同时做"补缺口"和"平台化"**（改名期的教训：一次只动一个变量）。

---

## 12. 需要拍板的三个决策

| ID | 决策 | 建议 | 影响 |
|---|---|---|---|
| D-101 | 每账号独立路由（`loomy-2..n`）是通用能力还是 Loomy 特有 | 登记 `optional`，第三家按需实现 | 决定"历史会话绑定到具体账号"是否成为产品承诺 |
| D-102 | "插件内自建登录"是否作为通用能力保留 | 保留但标 `optional`，且必须与"只读复用"在文案上分开 | 涉及计费责任与信任叙事 |
| D-103 | 能力矩阵的 owner | **产品持矩阵，工程持断言，同一份源生成** | 决定"掉页面"由谁在哪个环节拦住 |

---

## 13. 一句话交接

不要把这次重构理解成"把 raccoon 挪出去"——目录早就挪了。真正要做的是**把"一家供应商是什么"写成类型**：`VendorDescriptor` 说它有什么能力，`VendorRuntime` 说它怎么实现，`core` 只写一次路由/守卫/缓存/账户/池/适配器，`client` 只按能力拼控件。做完之后，"新增第三家"就从"复制一套逻辑并祈祷别漏页面"变成"填一个 200 行的 `create()` 并跑一遍 conformance"。

---

## 14. 落地结果（0.3.0）

方案已按「不做向后兼容」的决策全部实现。这一节记录**实际落地后的形状**，与前面的设计若有不一致，以本节为准。

### 14.1 最终目录

```
src/
├─ vendor-sdk/            contracts.ts（契约 + 能力声明）· conformance.ts（声明 vs 实现自检）
├─ core/                  http · routes · registry · deps · store · state · ttl · pool
│                         accounts · credential · catalog · credits · provider · surface
│                         preferences
├─ vendors/
│  ├─ loomy/              index.ts（descriptor + create）· auth · accounts · catalog · credits
│  │                      provider · login · plugin-auth · xfyun · upstream · constants
│  └─ raccoon/            index.ts（descriptor + create）· auth · auth-flow · catalog · credits
│                         provider · device · constants
├─ client/
│  ├─ transport.ts        一份 requestVendor：ok / failed / stale / unavailable 四态
│  ├─ capability/         tabs · AccountPanel · ModelsPanel · DiagnosticsPanel
│  │                      AccountRows · CreditsBody · LoginForms · PoolToggle · TransferBlock · loadable
│  ├─ components/         Card（外壳）· common · types · BrandIcon
│  └─ ComposerPill.tsx    按"路由归属"判断供应商，不再有 isLoomyRoute/isRaccoonRoute
└─ config.ts              { enabled, vendors: { <id>: {...} } }
```

被删除的重复实现：`src/{auth,accounts,catalog,credits,pool,provider,routes}.ts`、
`vendors/raccoon/{routes,accounts,pool}.ts`、`client/{api,raccoon-api}.ts`、
`client/components/{RaccoonTab,RaccoonDrawer,AccountTab,AccountDrawer,AddAccountPanel,LoginForm,AccountsList,ModelsTab,DiagnosticsTab}.tsx`。

### 14.2 三条落地时才定下来的规则

1. **`providerVisibility`**（descriptor 字段）：`'always'` 的供应商签出时也在模型选择器里
   （Loomy，主供应商）；`'signed-in'` 的只在有可用登录态时注册 provider 路由（Raccoon，
   兑现"没装客户端就没有这一组"）。这条规则在 registry 里，与具体供应商无关。
2. **路由在能力为假时根本不注册**：`enabled:false` 的供应商一条路由都没有，包括
   `accounts/export` —— 旧实现会把这个导出口留在开着。
3. **`/status` 一次回答所有供应商**：卡片打开只需要一个请求，切换供应商不再需要新的往返。

### 14.2.0 两条在真实使用中暴露的教训

1. **设置页不能按 `available` 过滤供应商。** 模型选择器隐藏未登录的供应商是对的
   （选一个必然失败的分组没有意义），但设置页正是用户**修复**它的地方。曾经共用
   同一个过滤条件，结果"小浣熊没登录 → 在卡片里彻底消失 → 连重新检测都点不到"。
   现在：卡片列出所有已挂载的供应商，可用的排前面；选择器仍然只列可用的。
2. **注册 provider ≠ 出现在选择器。** `getModels()` 是同步的、只读内存；目录没加载时
   返回 `[]`，选择器就隐藏这一组，于是没人调用 `getModels()`，懒惰刷新永远不触发。
   这是死锁，唯一解是**挂载时主动预热**（`registry.warmCatalog()`）。旧实现为 Loomy
   单独做过这件事，搬进 registry 时一度丢掉，表现为"小浣熊已登录但选择器里没有"。
3. **provider 名是全局的，可以「事实独占」但不能「强制覆盖」。** 宿主的
   `registerAdapter` 撞名抛 `DUPLICATE_ADAPTER`，也没有撤销别人注册的 API（那挂在
   对方的 fiber 上）。可行的组合是：
   - **首发靠顺序**：把本插件排在冲突插件之前（它用幂等注册，撞名会让位）；
   - **此后靠守卫**：`installRegisterGuard()` 在 `ctx.llm.registerAdapter` 上包一层，
     其它插件对已声明名字的注册会被**过滤**（剩余名字照常注册，全被过滤则返回空
     handle）。这是侵入式手段，所以只在 apply 最早阶段安装、并在 fiber 释放时还原。
   - 守卫必须能在**注册前**认出自己的适配器（`guard.setOwned`），否则会把首次注册
     也过滤掉——表现为 `registered: true` 但实际一个 provider 都没注册。
4. **provider 名是全局的，会被其它插件占用。** `registerAdapter` 的名字空间跨插件共享。
   实测：`dsh-our-free-model@2.8.5` 的 channel-pack 无条件注册 `loomy` / `raccoon`
   （连凭据 key 都是 `LOOMY_ACCOUNT_*`），bundle 顺序在前的先赢。我们的注册失败必须
   把这件事写进 `/status` 的 `provider.error`（可执行的说明，而不是宿主的英文原文）；
   它自己则用 `registerAdapterIdempotent` —— 撞名让位，所以我们排前面就能赢。
4. **注销是异步的，注册是同步的。** cordis 的 `ctx.effect` 释放会返回一个异步
   任务，而 `AdapterRegistrationHandle()` 丢弃了它的 promise。于是"注销 → 立刻重新
   注册"会撞 `DUPLICATE_ADAPTER: an adapter for provider "…" is already registered`。
   registry 现在：串行化 `reconcile`、注销后等一拍、注册时对 `DUPLICATE_ADAPTER`
   重试三次。这条故障的可见症状是"凭据、目录、路由全对，但模型选择器里没有这一组"。
4. **`/status` 必须包含 `provider: { registered, routes, models, error }`。**
   这个字段是"选择器看不到"这类问题的唯一可靠判据：`registered:false` 是注册被拒
   （`error` 给原因），`registered:true` 但 `models:0` 是模型没进适配器。
5. **`reconcile()` 的路由签名只能在实际注册成功后写入。** 先写签名再判断可用性，
   会在"第一次没登录"时把签名占住，之后登录也永远早退。
4. **配置 schema 不能用 `z.any()`。** 动态 map 渲染不出表单，所以卡片设了
   `auto: false` 自己画——于是 `z.any()` 唯一的实际后果是"没写过配置的那一家在配置
   里看不见"。现在 `vendors` 由各家的 schema/defaults **组合**而成，默认值就地展开。

### 14.2.2 轮换的语义：随机 ≠ 轮询，只有一条路由

- **随机，不是 round-robin**。严格轮询需要共享游标，并发请求会全部命中"下一个"；
  随机天然分散。卡片/抽屉里"当前账号"（activeId）是**非轮换**模式下的选择，轮换时
  唯一可信的"刚花了谁的钱"是 `lastUsedId`（`/accounts` 返回，UI 显示「最近调用」）。
- **路由集合与账号数量无关**（`routeMode: 'single'`，Loomy 与小浣熊一致）。
  账号再多也只有一条 `loomy` 路由：模型选择器不会按账号复制整份目录，"谁付费"是
  每次调用的决定，不是会话绑定的属性。
- **历史上的 slot 形态已停用**：`loomy-N` / `loomy-pool` 不再生成。旧会话里的
  `provider: 'loomy-3'` 不会再被注册，那类消息需要重新选一次模型；`slotForRoute` /
  `routeDisplayName` 仍能解析这些旧键（导出包、外部脚本、诊断输出还在用）。
- 实现：`VendorRuntime.lastPick()`（契约）+ `/accounts` 的 `lastUsedId`/`lastUsedAt`。

### 14.2.3 账号行要显示"人认得的信息"

导入的账号只有一个 token（导出包里没有手机号），账号行只能显示「账号 3」。两条规则：

1. **`label` 只属于用户自己起的名字**。平台自动昵称（`RaccoonSofia`）**不写进 label**，
   否则账号行永远显示昵称、真实手机号永远被挡住。身份类型（`personal`/`enterprise`）
   同理，只能进诊断。
2. **能补全就补全**。`user_info` 可以用同一个 token 换回真实手机号，所以打开账号页时
   调用 `AccountDriver.enrichProfiles()` 补一次并写回（实测 11 个账号里 9 个成功，
   失败的 2 个是 token 已失效）。`AccountsView` 必须**等它完成**再返回，否则用户第一次
   打开看到的还是「账号 3」。

### 14.2.4 部分可用 > 整块失败

一个供应商的"积分"可能由**多个端点**拼成（Raccoon：余额 v1 + 明细 v2），而它们会
各自失败——实测余额被网关限流返回 403 空 body 时，明细仍是 200。所以：

- **各自尝试，分别降级**：只有明细 → 返回 `{fields:{}, records, partial:'balance_unavailable'}`，
  UI 显示"余额暂时被限流"+完整明细；只有余额 → 正常显示，明细失败只记日志；
- **两者都失败才抛错**（报余额的那个，那才是用户要修的）；
- **`mergeCredits` 在逐账号全失败时优先返回 primary**：否则"读不到的逐账号数字"
  会把"能拿到的明细"一起丢掉；
- 桶缺失时给**空对象**而不是 `0`：`—` 是"读不到"，`0` 是"没有余额"，两件事。

### 14.2.1 一条产品决定：账号不脱敏

`/status`、`/accounts`、`/diagnostics` 里的 `phone` / `userId` 都是原值。理由：这是本机设置卡片，
用户要能确认"我当前用的是哪个号"；掩码只在两个地方保留——**日志**与**上游错误文本**
（`shared/text.ts#maskPhone`、`redactSensitive`）。唯一永不外传的仍是登录态 `material`，
`tests/host/auth.test.mjs` 守这条不变量。

### 14.3 接入第三家供应商的全部工作

> 逐步操作手册（含 descriptor 模板、conformance 必过项、测试写法）见
> [`docs/vendor-onboarding.md`](../vendor-onboarding.md)。下面是最短版本。

```ts
// src/vendors/acme/index.ts
export const ACME_DESCRIPTOR: VendorDescriptor = {
  id: 'acme',                         // 进入模型 identity，永不改
  displayName: 'Acme',
  accent: '#2E6BE6',
  providerVisibility: 'signed-in',
  capabilities: {
    accounts: 'single',
    pool: false,
    login: ['none'],
    credits: { kind: 'balance', fields: [{ key: 'points', labelKey: 'credits.field.other', role: 'available' }] },
    catalog: { selection: true, visionOverride: false, reasoningEffort: false },
    transfer: false, adopt: false, diagnostics: true,
  },
  config: { schema: ACME_CONFIG_SCHEMA, defaults: ACME_CONFIG_DEFAULTS },
}

export function createAcmeModule(): VendorModule {
  return { descriptor: ACME_DESCRIPTOR, create(deps) { /* 六个 driver，见契约 */ } }
}
```

然后 `src/index.ts` 的 `mountVendors()` 里加一行 `createAcmeModule`。**不需要**新增路由、
CSRF 处理、设置页面板、locale 键族或 CSS 类。

### 14.4 可执行的证据

- `tests/host/vendor-contract.test.mjs`：一个仓库里并不存在的 `acme` 模块挂进真实
  registry，自动得到 8 条路由 + 一条 provider 路由 + 一条 `/status` 条目；
  另有一组用例证明能力为假时路由**一条都不注册**。
- `tests/host/routes.test.mjs`：唯一的守卫管线（方法 → loopback → content-type →
  单一 CSRF 头 → 64KiB 上限）。
- `tests/host/apply.test.mjs`：`apply()` 立刻返回；关掉的供应商零路由、零 provider。
- `tests/client/bundle.test.mjs`：卡片从 `/status` 的供应商列表渲染，且不把宿主多塞的
  敏感字段带进 DOM 或控制台。

`pnpm run check`（typecheck ×2 + build + 139 个测试）全绿。

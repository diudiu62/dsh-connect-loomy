# 接入第三家供应商：逐步指南

本文是「新增一家桌面客户端」的操作手册。目标形状是：**只写协议**，不写路由、不写设置页面板、不写 CSS、不写 locale 键族。

先看工作量基线：

| 项目 | 0.2.x（重构前） | 现在 |
| --- | --- | --- |
| 新增文件 | `vendors/x/{index,auth,accounts,catalog,credits,pool,provider,routes}.ts` + `client/{x-api,components/XTab,XDrawer}.tsx` | `vendors/x/{index,api}.ts`（+ 协议细节按需拆分） |
| 改共享文件 | `config.ts`(+9 字段)、`index.ts`(+80 行挂载)、`shared/types.ts`(+ROUTES)、`client/api.ts`、`Card.tsx`、`locale.ts`(+120 键)、`styles.ts` | `src/index.ts` 一行 |
| 代码量 | ≈ 2 300 行 | ≈ 300–400 行 |
| 漏功能的方式 | 靠人记（Raccoon 就漏了重命名、流水、诊断报告） | 能力声明漏了 conformance 直接报错 |

参考实现：`src/vendors/loomy/`（多账号 + 每账号一条路由 + 导出/导入 + 收养 + 短信登录）、`src/vendors/raccoon/`（单路由 + 桌面身份参与轮换 + 手机号加密登录 + 签入才出现）。先读 `src/vendors/raccoon/index.ts`，它是最小完整样例。

---

## 0. 五分钟版本

1. `mkdir -p src/vendors/<id>`，写 `constants.ts`（冻结身份 + 配置片）与 `index.ts`（descriptor + `create()`）。
2. 在 `src/index.ts` 的 `mountVendors()` 数组里加一行 `createAcmeModule`。
3. 跑 `pnpm run check`。conformance 不通过会直接告诉你缺哪个 driver。
4. 在 `tests/host/vendor-contract.test.mjs` 里加一条「挂载后自动出现哪些路由」的断言。

没有第 5 步。**不需要**碰 `src/core/**`、`src/client/**`、`src/shared/**`。

---

## 1. 先填能力声明（这是设计决策，不是样板）

能力声明决定三件事：哪些 HTTP 路由被注册、设置卡片出现哪些面板、模型选择器里这一组什么时候出现。声明错 = 用户点进空 tab，所以先想清楚再写代码。

```ts
export interface VendorCapabilities {
  accounts: 'multi' | 'single' | 'none'   // 多账号 / 只有桌面一个身份 / 无账号概念
  pool: boolean                            // 是否提供"自动轮换"（需要 accounts）
  login: readonly ('sms-code' | 'password' | 'none')[]  // 插件内自建登录；只借用桌面登录就写 ['none']
  credits:
    | { kind: 'none' }
    | { kind: 'ledger' }                                        // 只有流水，没有余额桶
    | { kind: 'balance'; fields: readonly CreditField[]; ledger?: boolean }  // 余额桶；ledger 表示还有流水
  catalog: { selection: boolean; visionOverride: boolean; reasoningEffort: boolean }
  transfer: boolean   // 导出/导入登录态
  adopt: boolean      // 把桌面登录"收养"成一行账号
  diagnostics: boolean
}
```

### 决策规则

- **`accounts`**：桌面客户端本身支持多账号切换 → `'multi'`（每个账号可以有自己的 provider 路由）；只有一个登录态、靠插件自己加账号 → `'single'`。
- **`credits.fields` 的 `key`** 是你返回的 `CreditsView.fields` 里的键，`role` 决定谁是主数字（卡片徽标用它）：

  | role | 含义 |
  | --- | --- |
  | `available` | 主数字（徽标、默认大字号） |
  | `today` | 当日额度 |
  | `total` | 账本总额 |
  | `other` | 其余桶（月度、充值、奖励…） |

  桶缺失时**不要填 0**，直接不放进 `fields`；UI 会显示 `—`。0 是"没有积分"，缺字段是"这家没有这个概念"，前者会误导用户。
- **`catalog.reasoningEffort`**：只有上游真的校验档位时才声明 `true`。声明了 `true` 但上游接受任何值，选择器就是装饰品（Raccoon 就是因此声明 `false`）。
- **`login`**：只写你真的实现并测过的方式。声明了就必须有 `LoginDriver` 的对应分支，否则 conformance 报错。
- **`n/a` 与 `false` 的区别**：`false` 是"这家不做"（路由不存在、面板不出现，属于正常）；**忘了写**是 bug。所以每个布尔位都要显式给值，写完对照 §7 的自检表。

---

## 2. `descriptor`：冻结的身份

```ts
// src/vendors/acme/constants.ts
import z from '@deepseek-ai/schemastery'
import type { CreditField } from '../../shared/views.js'

/** 进入模型 identity（provider + api + model.id），**永不改**。 */
export const ACME_PROVIDER_ID = 'acme'

export const ACME_DISPLAY_NAME = 'Acme 桌面助手'
export const ACME_ACCENT = '#2E6BE6'
export const ACME_API = 'openai-completions'

export const ACME_CREDIT_FIELDS: readonly CreditField[] = [
  { key: 'available', labelKey: 'credits.field.available', role: 'available' },
  { key: 'daily', labelKey: 'credits.field.daily', role: 'today' },
]

/** 这家供应商自己的配置片；根配置只负责命名空间。 */
export const ACME_CONFIG_SCHEMA = z.object({
  enabled: z.boolean().default(true).description('启用 Acme 模型接入'),
  baseURL: z.string().default('https://acme.example/api/v1').description('Acme API 基地址'),
  catalogTtlMs: z.number().min(0).default(600_000).description('模型目录缓存时长（毫秒）'),
  creditsTtlMs: z.number().min(0).default(60_000).description('积分缓存时长（毫秒）'),
})

export const ACME_CONFIG_DEFAULTS: Record<string, unknown> = {
  enabled: true,
  baseURL: 'https://acme.example/api/v1',
  catalogTtlMs: 600_000,
  creditsTtlMs: 60_000,
}
```

```ts
// src/vendors/acme/index.ts
export const ACME_DESCRIPTOR: VendorDescriptor = {
  id: ACME_PROVIDER_ID,          // 冻结
  displayName: ACME_DISPLAY_NAME,
  accent: ACME_ACCENT,
  // 省略等于 'signed-in'。'always' 用于"主供应商"：签出也在选择器里。
  providerVisibility: 'signed-in',
  capabilities: ACME_CAPABILITIES,
  config: { schema: ACME_CONFIG_SCHEMA, defaults: ACME_CONFIG_DEFAULTS },
}
```

**必须冻结的三样**（改了等于把用户历史当成别的模型）：

1. `id` —— 写进每条 assistant 消息的 `provider`；
2. `chat.api` —— 目前唯一支持 `'openai-completions'`；
3. 配置片里的字段名 —— 用户已经写进 profile 的 patch YAML。

---

## 3. `create()`：六个 driver

`create(deps)` 返回 `VendorRuntime`。必选三项：`credentials`、`chat`、`routes()` + `resolveCredential()`；其余按能力声明提供。

### 3.0 账号展示不脱敏

`CredentialIdentity` / `AccountRowView` 里的 `phone`、`userId` 是**原值**：设置卡片与
抽屉要让用户核对自己登的是哪个号。`maskPhone` / `maskUserId` 仍然存在，但只用于
**日志与上游错误文本**。不要为了"看起来安全"在视图里打码——那会让用户没法确认身份，
而且这些值本来就只在本机流转（唯一绝对不能出门的是 `material`）。

### 3.1 `deps` 提供什么

| 字段 | 用途 |
| --- | --- |
| `deps.setting<T>(key)` | **实时**读自己配置片里的字段（改了立刻生效，不要缓存到闭包） |
| `deps.storageDir` | `$DSH_HOME/storages/dsh-connect-desktop/<id>/` |
| `deps.document(name, {parse,serialize,empty})` | 原子写 + `0600` 的 JSON 文档；`vendorStateStore(deps.document)` 拿到标准 state 文档 |
| `deps.logger` | 带前缀的日志 |
| `deps.now()` | 可注入时钟 |
| `deps.attachments()` / `deps.imageAccess()` | 图片输入需要的宿主服务（惰性，可能晚挂载） |
| `deps.modelsUpdated()` | 告诉宿主重新列出这一家的模型 |

### 3.2 可以复用的通用实现（不要自己再写一份）

| 你要的东西 | 用这个 |
| --- | --- |
| 账号存储（slot 路由 / 单路由、去重、健康标记、导出导入） | `core/accounts.ts#createAccountsStore` |
| 目录缓存 + 选择 + 能力覆盖 + 落盘 | `core/catalog.ts#createCatalogStore` |
| 积分缓存 + 单飞 + 逐账号合并 | `core/credits.ts#createCreditsStore` |
| 池挑选 + 冷却 + 失败分类 | `core/pool.ts#createAccountPool` |
| 候选文件读取 + TTL + 过期判定 + 诊断报告 | `core/credential.ts#createCredentialDriver` |
| 轮换开关 / 当前账号偏好 | `core/preferences.ts#createVendorPreferences` |
| state 文档的解析/序列化 | `core/state.ts#vendorStateStore` |

### 3.3 `resolveCredential(route)`：全插件唯一的决策点

这个函数回答「这次调用用谁的登录态」，返回值里带 `accountId` 让 `core/provider.ts` 能把失败归因到具体账号并冷却它。它必须是**唯一**一处做这个决定的地方——目录、积分、对话三处读到不同的账号，是本项目已经踩过的坑。

```ts
async resolveCredential(route: string) {
  // 1) 轮换开启且有多个候选 → 池里挑一个健康的
  // 2) 否则 → 用户选定的账号，被 bench 就退到第一个健康的
  // 3) 一个账号都没有 → 桌面端登录态
  // 全都不可用时抛 LlmError(MISSING_CREDENTIAL, 带每个账号的原因)
  return { material: token, ...(accountId === undefined ? {} : { accountId }) }
}
```

签出时抛 `new LlmError(message, 'MISSING_CREDENTIAL')`，message 要可执行（"请打开 X 客户端登录后重试"），不要写"未知错误"。

### 3.4 `chat`：只写协议差异

```ts
const chat: ChatDriver = {
  api: 'openai-completions',
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
            supportsUsageInStreaming: true, supportsFinishReason: true,
            maxTokensField: 'max_tokens', thinkingFormat: 'openai' },
  credentialName: 'Acme desktop session',
  // 每个路由的模型必须标上该路由 id，否则选择器分组和"这条会话用哪个账号"都会错
  toModel: (model, { baseUrl, route }) => ({ id: model.id, provider: route, api: 'openai-completions', /* … */ }),
  prepareHeaders: (request, headers) => { headers.set('X-Client-Version', version()); return headers },
  // 可选：把"看起来像截断"的终止失败升级成可执行的"登录态失效"
  async explainAmbiguousFailure() { /* … */ },
}
```

`core/provider.ts` 已经负责：inert credential plane、`apiKey` 回传、profile 装配、图片预算、**两个** stream 入口的包装（`stream()` 与 `prepareCall().stream()`）、并发归属、内容才算成功、未输出才重试。**不要再写这些。**

---

## 4. 路由会自动出现（不用写一行 handler）

`src/core/routes.ts#planVendorRoutes` 按能力声明生成，能力为假时**根本不注册**：

| suffix | 门槛 |
| --- | --- |
| `diagnostics` | `diagnostics: true` |
| `diagnostics/probe` | `diagnostics: true` 且实现了 `probeEndpoints` |
| `recheck` | 有身份概念（`accounts`/`login`/`diagnostics` 任一） |
| `config` | `GET`/`POST`，宿主提供 settings 服务时（CLI 没有，所以不注册） |
| `credits` | `credits.kind !== 'none'` |
| `catalog` / `refresh` / `save` | `catalog.selection` |
| `accounts` / `accounts/active` / `accounts/remove` | `accounts !== 'none'` |
| `accounts/rename` | `accounts === 'multi'` 且实现了 `rename` |
| `accounts/adopt` | `adopt: true` 且实现了 `adopt` |
| `accounts/export` / `import` | `transfer: true` |
| `pool` | `pool: true` |
| `auth/state` / `auth/logout` | `login` 含真实方式 |
| `auth/send-code` / `auth/login` | `login` 含对应方式 |

守卫（方法 → loopback → content-type → CSRF → 64 KiB → 错误信封）也由 `core/http.ts` 统一处理，**包括只有一个 CSRF 头名** `x-dsh-connect-csrf`。

> 反例（旧版踩过）：`enabled: false` 时只跳过 provider 注册、路由照旧注册，于是"关掉的供应商"仍然暴露 `accounts/export`（导出明文登录态）。新实现里关掉就是一条路由都没有。

---

## 5. 客户端：零改动

设置卡片从 `GET /status` 读 `vendors: VendorStatusView[]`，然后：

- 供应商切换条 = `vendors.filter(v => v.available)`，名字用 `displayName`；
- tab = `tabsFor(v.capabilities)`；
- 面板 = 一套通用面板，按能力位拼装（额度网格由 `credits.fields` 数据驱动）；
- 徽标归属 = `vendorForRoute(provider, vendorIds)`（`route === id || route.startsWith(id + '-')`）。

所以**不要**新增 `XTab.tsx`、`XDrawer.tsx`、`x-api.ts`、`isXRoute` 正则或 locale 键族。`BrandIcon.tsx` 是整插件在设置侧边栏的图标，不是每家一个。

唯一可能需要动的是文案：如果 `credits.fields[].labelKey` 用了字典里没有的 key，`labelFor()` 会降级成最后一段（`credits.field.monthly` → `monthly`）。想显示中文就在 `src/client/locale.ts` 的能力文案区加一条（**不是** vendor 命名空间）。

---

## 6. 配置片

- 字段只在 `constants.ts` 声明一次（`schema` + `defaults`），`deps.setting<T>()` 实时读；
- 用户 patch YAML 的形状是 `vendors: { acme: { baseURL: '…' } }`，缺项由 registry 用 `defaults` 补齐；
- **必须导出** `XXX_CONFIG_SCHEMA` 与 `XXX_CONFIG_DEFAULTS`（常量名约定），并在
  `src/config.ts` 的 `vendorSlices` 里加一行。`vendors` 是按家组合的**具体** schema，
  所以从没写过配置的用户也能在配置视图里看到你这家的字段与默认值——漏了这一步，
  用户会说"配置里没有这一家"；
- **不要**往根 `Config` 上加字段（0.2.x 的 `raccoon*` 平行字段就是这么来的）；
- `.volatile()` 由根 config 负责，供应商 schema 里不写。

---

## 7. 必过的门

### 7.1 conformance（挂载时自动跑，`assertRuntime`）

声明与实现不一致会**直接挂载失败**，并在日志里逐条列出：

- `accounts !== 'none'` 但没有 `accounts` driver；或反之；
- `pool: true` 但没有 accounts；
- `accounts: 'multi'` 没实现 `rename`；
- `transfer: true` 没实现 `exportBundle`；
- `adopt: true` 没实现 `adopt`；
- `credits.kind !== 'none'` 没有 credits，或反之；
- `catalog.selection` 没有 catalog；
- `login` 声明了真实方式却没有 `login` driver，或反之；
- `chat.api !== 'openai-completions'`；
- 缺 `resolveCredential` 或 `routes()`。

### 7.2 测试（三类，缺一不可）

```js
// tests/host/vendor-contract.test.mjs 里已有的假供应商写法可以直接抄
const module = { descriptor, create: () => ({ /* 六个 driver 的桩 */ }) }

const registry = createVendorRegistry({ ctx, csrfToken, logger, config, enabled, attachments, imageAccess, modelsUpdated })
const mounted = await registry.mount(module)
await new Promise((r) => setTimeout(r, 30))

assert.deepEqual(paths.sort(), [
  '/plugins/dsh-connect-desktop/acme/accounts',
  // …按 §4 的表逐一列出
])
assert.deepEqual(adapters, [['acme']])
```

1. **路由生成**：挂载后出现哪些 URL（能力为假的那些一条都不许出现）；
2. **provider 注册**：`providerVisibility` 在"有登录态 / 无登录态 / 被禁用"三种情况下的行为；
3. **协议**：把上游报文样本喂给你的 `parse*` 纯函数（参考 `tests/host/catalog.test.mjs`、`credits.test.mjs`）。

再跑一次 `pnpm run check`。**没有测试的供应商等于没接**：CI 是唯一能拦住"下次重构漏掉你这家"的东西。

### 7.3 客户端：通常不需要新测试

客户端测试按**能力位**组织，不按供应商：

| 文件 | 覆盖 |
| --- | --- |
| `tests/client/tabs.test.mjs` | 能力 ⇒ tab 集合 |
| `tests/client/drawer.test.mjs` | 逐账号额度配对、主数字取哪个桶 |
| `tests/client/transport.test.mjs` | 四态 + 单 CSRF 头 |
| `tests/client/capability-matrix.test.mjs` | 声明 == 渲染出的控件 |
| `tests/client/account-rules.test.mjs` | 谁可以改名/删除/收养/切换（来自 origin + 能力位） |
| `tests/client/flows.test.mjs` | 登录、重命名、导入、重新检测、探活 |

所以接一家新供应商时，这些用例**不用改**——它们本来就是用"假能力位"驱动的。只有一种例外：你往 `VendorCapabilities` 里**新增一个维度**，那要在 `capability-matrix` 加一条断言、并同步 §1 的决策表。

---

## 8. 常见症状 → 原因

| 症状 | 原因 |
| --- | --- |
| 挂载日志里 `挂载失败`，且提到"声明 X 但没有 driver" | conformance 拦住了；按提示补 driver 或改声明 |
| 模型选择器里没有这一组 | `providerVisibility: 'signed-in'` 且读不到有效登录态；或 vendor 的 `enabled: false` |
| 设置卡片里没有这家 | `GET /status` 里 `available: false`（看 `unavailableReason`） |
| 选择器里这一组存在，但一调用就失败 | `resolveCredential` 抛错但 `routes()` 仍返回路由；检查凭据优先级 |
| 多个账号时余额都显示成同一个数 | 没用 `credits.readForAccount`，或它忽略了传入的 account |
| 卡片上出现 `credits.field.xxx` 原文 | `labelFor` 找不到 key：在 `client/locale.ts` 的能力文案区补一条 |
| 轮换把请求打到已失效账号 | 失败没被归因：`resolveCredential` 没返回 `accountId` |
| 卡片有余额但没有流水表 | `credits.kind: 'balance'` 时忘了声明 `ledger: true`（两者可以并存） |
| 余额接口 403、但明细接口正常 | 不要整块报错。两个端点各自降级：只有明细时返回 `fields:{}` + `partial:'balance_unavailable'`，UI 会说明并照常显示明细 |
| 卡片上的手机号被打码 | 你在视图里调了 `maskPhone()`；账号展示不脱敏，掩码只用于日志 |
| 用户说"配置里没有这一家" | 没在 `src/config.ts` 的 `vendorSlices` 里登记它的 schema/defaults |
| 所有面板都说"宿主未提供该路由" | 同一 path 注册了两次：宿主按 `(kind, path)` 唯一注册，第二次抛错会连带丢掉这家后续全部路由。同一 suffix 的多个动词必须合成一条 spec（`methods: ['GET','POST']`） |
| 未登录的供应商在设置页消失 | 不要按 `available` 过滤卡片列表；"没装就不出现"只适用于模型选择器 |
| 诊断页「探活」按钮不可用 | 没实现 `probeEndpoints()`，路由因此不注册 |
| 已登录但模型选择器里没有这一组 | 目录没预热：`getModels()` 是同步的，注册后若目录为空，选择器不显示 → 没人调用 → 永远不会加载（死锁）。registry 的 `warmCatalog()` 负责在挂载/重新检测后后台拉一次 |
| 先签出、后登录，仍然不出现 | `reconcile()` 的签名必须只在实际注册成功后写入，否则「没登录时早退」会把签名占住，后续登录再也不会重试 |
| `/status` 里 `provider.error` 说 `already registered` | 先看是不是别的插件占了名字（已知：`dsh-our-free-model`）。**顺序首发 + 注册守卫**是完整解法：顺序让我们先抢到，守卫让后续任何人都抢不走。详见架构文档 14.2.0 第 3 条 | **先查是不是别的插件占了名字**。已知冲突：`dsh-our-free-model` 的 channel-pack 无条件注册同名的 `loomy` / `raccoon`。解法：在 profile 的 `dsh.profile.bundles` 里把 `dsh-connect-desktop` 排到它**之前**（对方用幂等注册，撞名时会让位），或禁用其中之一。排除了外部占用后，才是注销竞态（cordis 释放异步，registry 已做等一拍 + 重试 + 回收） |
| `/status` 里 `provider.models` 为 0 但 `catalog.total` 正常 | 目录有了但没进适配器：看 `selection` 是否为空数组，以及 `chat.toModel` 是否在抛错 |
| 账号行只显示「账号 N」 | 账号没有 `phone`/`label`/`userId`（多半是导入的，包里只有 token）。实现 `enrichProfiles()` 用 token 反查身份并写回；**不要**把平台昵称写进 `label`，那会永久挡住手机号 |
| 用户说"没有轮换" | 轮换是**随机**不是 round-robin（并发下 round-robin 会全部命中同一个）；用 `/accounts` 的 `lastUsedId` 证明它在工作。slot 路由（`loomy-3`）是**绑定**，不参与轮换——这是刻意语义 |
| 控制台里每次调用都多一次 `/models` | 你在自己的 `getModels` 里又读了一次目录；交给 `core/provider.ts` |

---

## 9. 交付清单

- [ ] `src/vendors/<id>/constants.ts`：冻结 id、显示名、accent、配置 schema/defaults、额度桶
- [ ] `src/vendors/<id>/index.ts`：descriptor + `create()`，六个 driver 按能力声明到位
- [ ] `resolveCredential` 是唯一决策点，返回 `accountId`
- [ ] `chat.toModel` 给每个路由打上该路由 id
- [ ] `src/index.ts` 的 `mountVendors()` 加一行
- [ ] 三类测试：路由生成、provider 注册、协议纯函数
- [ ] `pnpm run check` 全绿
- [ ] 能力声明逐位复核过（每个布尔位都是"想过之后的 false"，不是"忘了写"）
- [ ] 没有新增：路由 handler、CSRF 处理、设置页面板、`isXRoute` 正则、locale vendor 键族、CSS 类

最后一条是这份指南存在的理由：**如果为了接入这家供应商你发现必须改 `src/core`，那是 core 缺少一个扩展点——先补 core，再写供应商。**

### 7.4 布局回归：别靠看图

`scripts/measure-layout.mjs` 在**无头 Chrome** 里量真实盒子（`getBoundingClientRect`），
输出一行一个 JSON，用来替代"截图看起来还行"：

```bash
node scripts/measure-layout.mjs            # 700 / 600 / 500 三档
node scripts/measure-layout.mjs --width 640
```

回归时看四个数：

| 字段 | 健康值 | 说明 |
| --- | --- | --- |
| `headerHeight` | ≤ 60 | 标题块高度；>90 通常是 h2/p 的 UA 外边距没清 |
| `sectionCount` / `sectionTitles` | 每个内容块都有标题 | 标题数 < 内容块数 = 用户不知道自己在看什么 |
| `valueStartX` | 只有一个值 | 多个值 = 事实表每行各算各的列宽，值不对齐 |
| `offscreen` | `[]` | 非空说明有元素溢出视口 |
| `overflow` | `[]` | 非空说明某个容器内容比自身宽；配合 `overflowDetail` 看是谁 |
| `modelFirstColWidths` | ≥ 350（600px 宽时） | 模型名所在列；< 250 说明又加回了列 |
| `modelRowHeights` | ≤ 80 | 行高；> 80 说明模型名在换行 |

四个 tab 的基线（600px 宽，供回归对照）：

| tab | cardHeight | sectionCount | 备注 |
| --- | --- | --- | --- |
| accounts | ~876 | 5 | 每块都有标题；迁移块折叠 |
| models | ~514 | 1 | 3 列，模型列 412px |
| diagnostics | ~680 | 3 | 摘要行 + 凭据/探针/路由 + 折叠"最近错误" |
| config | ~629 | 1 | 每字段一行；输入框 252px（表格布局时约 180px） |

配置页另有一个指标 `configInputWidths`：600px 宽时文本输入框应 ≥ 240px。
低于 200 说明又退回"表格里塞输入框"的布局了。

jsdom 没有布局引擎（尺寸全是 0），所以**任何关于间距、对齐、截断的结论都必须在
这个脚本里量**，而不是在测试里断言 CSS 字符串。

### 7.4.4 为什么「打开配置」是自己画浮层，而不是跳到宿主的设置页

DSH 的浏览器端**没有 URL 路由**（全仓没有 `pushState` / `hashchange`），设置页完全由
React 状态驱动，也没有对外暴露"打开某个设置分区"的服务。

能想到的替代方案都试过了：

| 方案 | 结果 |
| --- | --- |
| `location.hash` / `history.pushState` | 无效：客户端不读 URL |
| 模拟点击 侧边栏 → 本插件分区 → tab | 找不到侧边栏入口（纯图标按钮，`textContent` 为空），点了没反应 |
| 伪造认证 cookie 抓 DOM 研究 | 不该这么做 |

所以最后改成**自己渲染**：抽屉里的 ⚙ 打开一个模态浮层，里面是同一个 `ConfigPanel`。
好处是可靠、可测、不依赖宿主 DOM；两条路径（设置卡片 / 浮层）看到的字段、校验与
乐观锁完全一致，不存在"这里能改、那里改不了"的偏差。

浮层是**模态**的（有遮罩、锁焦点）：配置里可能有未保存的草稿，一次误点就丢掉说不通。
抽屉则保持非模态——切账号、看额度是即时操作，点外面就该让开。

### 7.4.3 配置页的分组

字段由 **descriptor 声明**分组，core 只按它归位：

```ts
config: {
  schema, defaults,
  groups: [
    { id: 'connection', labelKey: 'config.group.connection', keys: ['enabled', 'baseURL', 'loomyVersion'] },
    { id: 'cache', labelKey: 'config.group.cache', keys: ['catalogTtlMs', 'creditsTtlMs'] },
  ],
}
```

**为什么不让 core 猜**（例如按 `*TtlMs` 归到"缓存"）：那要把供应商的字段名写进
`src/core`，而 core 里出现供应商字面量正是架构门禁要拦的东西。声明式还有个好处：
字段增删时分组跟着 schema 走，不会漂移。

没有归入任何组的字段合成最后一块，不给标题。

字段行本身：**说明文字是主标题，键名是副标题**。`baseURL` 对用户没有意义，
schema 里的 `description`（"Loomy 平台 API 基地址"）才是他要找的。

### 7.4.2 账号页的信息架构

四段，按"用户此刻要回答的问题"排，不是按功能清单排：

| 顺序 | 内容 | 为什么在这里 |
| --- | --- | --- |
| 1 | 身份摘要（一行） | 凭证从哪来、什么时候登的。**不重复**状态条已说的"谁在用" |
| 2 | **账号段**：标题右侧按钮（新增账号 / 导出·导入）→ 展开的表单 → 列表 → 轮换 | 这四件事都是"账号"这个领域的一部分。低频动作做成**段头按钮**而不是独立块：既有归属，又不占版面。表单**贴着段头展开**（列表之前）：触发按钮就在标题右侧，输入框必须出现在眼前——排在列表末尾时，账号一多它会被推到屏幕外，看起来像"按了没反应" |
| 3 | 积分 | 只读展示；用户看完账号自然会看钱 |

**领域内的动作留在领域内，并且做成那个领域段头的按钮。**

三种呈现低频动作的方式，差别在"归属"和"占版面"两件事上：

| 方式 | 归属 | 占版面 | 结论 |
| --- | --- | --- | --- |
| 独立一段（折叠或常驻） | ✗ 脱离领域 | 常驻时很贵 | 不要 |
| 段落末尾的折叠块 | ✓ | 折叠后便宜 | 不要：位置在列表之后，且和段头按钮叠成两层折叠 |
| **段头按钮**（`Section.actions`） | ✓ | 零 | **首选**，和「刷新目录 / 保存勾选」同一个模式。按开即见控件，**面板内不再套第二层 `<details>`**——两层开关做一件事，用户按完第一次只看到一个三角 |

同时只展开一个表单：两个表单并存会把列表推到屏幕外——那正是当初要解决的问题。
展开的位置在**列表之前**（贴着段头），不是段落末尾：低频动作的表单是用户按下按钮
那一刻唯一想看的东西，视线不该先穿过一个长列表。粘贴类输入框拿到自动焦点（⌘V 直接粘）。
未登录时「新增账号」自动展开：那时登录是唯一有意义的事，不该让用户先找按钮。

两条踩过的坑：

- **一个网格格子里只放一个视觉单元。** 账号行曾经把 7 个元素直接平铺在 3 列网格里，
  第 4 个起每行一个，一个账号被撑成三行。现在徽标收进「身份」格，重命名框用
  `grid-column: 1 / -1` 跨行。
- **tab 面板装的是"块"，用块间距（16px）；块内段落才用 8px。** 用 8px 时各段标题
  会和上一段粘在一起。

### 7.4.1 这些门禁在哪里跑

| 门禁 | 本地 | CI |
| --- | --- | --- |
| 类型 / 架构 / 构建 / 测试 | `pnpm run check` | `.github/workflows/ci.yml` 的 `check` job |
| 任何宽度都不横向溢出 | `pnpm run audit:layout` | `layout` job |
| 两种主题下文字对比度 ≥ 4.5:1 | `pnpm run audit:contrast` | `layout` job |
| 全部视觉门禁 | `pnpm run audit:visual` | 上面两步 |

`check` job 是纯 Node（快），`layout` job 需要真实 Chrome（慢）——所以拆开：布局检查
塞进 `pnpm run check` 会让本地每次改代码都启动浏览器，而它是回归门禁，不是快速反馈。

CI 的 `layout` job 会先确认 runner 上真有 Chrome；缺了**直接失败**而不是静默跳过——
一个永远不会跑的门禁比没有门禁更糟。截图会作为 artifact 上传（即使门禁红了），
因为失败时那些图就是判断"到底哪里挤了"的第一手材料。

> 加门禁时先做一次**负向验证**：故意删掉一条降级规则，确认门禁真的红。本项目
> 的 `--check-layout` 就是这样验证过的（删掉 460px 的流水表降级 → 380px 报
> `dcss-ledger-row(386>380)`）。

### 7.5 暗色与对比度

```bash
node scripts/measure-layout.mjs --dark --width 600   # 暗色下的同一组指标
node scripts/measure-layout.mjs --check-contrast     # 门禁：低于 4.5:1 退出码 1
```

`--check-contrast` 跑四个 tab × 浅色/暗色两种主题，用 WCAG 公式算每个关键元素的
前景/背景对比度。它抓到过三类真实问题，都只有量出来才发现：

| 元素 | 修复前（浅色） | 修复后 |
| --- | --- | --- |
| `.dcss-hint`（12px 说明文字） | 3.71 ✗ | 5.8 ✓ |
| 选中的 tab 文字 | 4.23 ✗ | 18.9 ✓ |
| `.dcss-summary-meta` | 3.71 ✗ | 5.8 ✓ |

### 7.6 三条只有量才发现的布局规则

1. **容器查询必须写在基础规则之后。** 同优先级下后写的赢：`@container` 写在
   `.dcss-ledger-row { grid-template-columns }` 前面时，窄屏降级完全不生效，而且在
   600px 上看不出任何异常——只有 380px 才溢出。`styles.test.mjs` 有一条顺序断言钉住。
2. **窄屏要测到 340px。** 420px 之前都正常，380px 起四列流水表（118+168+76 固定列）
   撑破容器。`@container (max-width: 460px)` 里丢掉"模型"列解决。
3. **抽屉的横向溢出用纯函数守。** 徽标贴左边时抽屉 `left: -144px`；真实效果只能在
   有布局的浏览器里看到，而静态测量页面不跑 React effect。所以位移算法抽成
   `clampShift()` 纯函数，在 Node 里对边界逐个断言。

暗色的实现要点（写脚本时踩过）：宿主主题包里 **alias 映射有两份**（浅色一份、
`body[data-ds-dark-theme]` 一份，暗色把 `bg-base` 指向深色阶）。按 key 去重会永远
取到浅色那份，于是"暗色 token"静默失效、对比度和浅色一模一样。

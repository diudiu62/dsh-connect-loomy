# dsh-connect-desktop：DSH 插件 API 契约（宿主 0.2.2-rc.1）

本文把 dsh-connect-desktop 要实现的技术底座逐条钉死：每条结论都给出**可照抄的代码片段**和**出处文件行**。
文中的核心 TypeScript 片段（§2.1–2.3 provider/profile、§3.3–3.4 headers/auth、§4.1 路由、§5.4 设置卡片）已在临时目录用 `tsc --noEmit` 实编通过（见 §10「验证记录」）；其余 JS/HTTP 片段是接口调用示意。

- 读者对象：后续实现 provider 适配器、设置卡片、积分路由的同学。
- 版本锚点：DSH **0.2.2-rc.1**、`@earendil-works/pi-ai` **1.5.2**（宿主实际安装）、`@deepseek-ai/cordis` **4.1.0**、`@deepseek-ai/schemastery` **3.19.0**、Node **22.23.2**。
- 本文写作日期：2026-11-14。

## 0. 路径缩写与证据来源

| 缩写 | 绝对路径 |
|---|---|
| `$HOST` | `/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` |
| `$PI` | `/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist` |
| `$WB` | `/Users/benny/.dsh/profiles/web/node_modules/dsh-connect-workbuddy`（已安装的家族范式实现，只读参考） |
| `$REPO` | 本仓库（包名 `dsh-connect-desktop`） |
| `.refs/` | 本仓库内只读侦察资料（已 gitignore，禁止发布） |

引用的三类证据：

1. **宿主 `.d.ts`**（契约权威）——优先引用，行号来自 `$HOST/<pkg>/lib/types/*.d.ts`。
2. **宿主打包后的 `lib/index.js`**（实现细节）——用于回答「时序/调用点」这类 `.d.ts` 不写的问题。
3. **已安装的 `dsh-connect-workbuddy`**（真实第三方插件）——用于确认「家族里实际能跑通的写法」，它的 `lib/*.js` 是构建产物但保留了源码注释，可读。

---

## 1. 宿主插件入口：`apply` / `inject` / `Config` / settings 持久化

### 1.1 最小插件形状

一个 DSH 插件就是一个 cordis 插件模块，约定导出 `name`、`inject`、`Config`、`apply`：

```ts
// $REPO/src/index.ts（本仓库已落地，可编译）
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 插件名，用于诊断与 loader 条目。 */
export const name = 'connect-loomy'

/** apply 之前必须就绪的服务；缺一个 cordis 就不会 apply。 */
export const inject = ['llm']

/** 配置字段表：Schemastery 描述 settings 页面如何渲染与校验。 */
const configFields = {
  enabled: z.boolean().default(true).description('启用 Loomy 模型接入'),
  baseURL: z
    .string()
    .default('https://loomyad.xunfei.cn/api/v1')
    .description('Loomy 平台 API 基地址'),
}

/** 运行时 schema；settings 页面与 loader 都用它做校验。 */
export const Config = z.object(configFields)

/** 校验后的配置类型（ObjectT 是 schema 的输出类型）。 */
export type Config = Schemastery.ObjectT<typeof configFields>

export function apply(ctx: Context, config: Config): void {
  ctx.logger.info(`dsh-connect-desktop: mounted (enabled=${String(config.enabled)})`)
}
```

出处：

- `name` / `inject` / `apply` 的导出约定：`$HOST/dsh-llm-pi-ai/lib/types/index.d.ts:11-12`（`name`、`inject`）、`:32`（`apply(ctx, config)`）。
- 同一份实现的真实取值：`$HOST/dsh-llm-pi-ai/lib/index.js:2858`（`const inject = ["llm"]`）、`:2902`（`function apply(ctx, config)`）、`:3011`（导出清单）。
- `Config` 字段用 `z.object({...})` + `.default()` + `.description()` 的官方写法：`$HOST/dsh-llm-deepseek/lib/index.js:320-345`（`deepSeekConfigFields` → `const Config = z.object(deepSeekConfigFields)`）。
- `Schemastery.ObjectT` 是 schema 输出类型：`$REPO/node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts:23-27`（`ObjectS`/`ObjectT` 定义）、`:78`（`object(dict)` 返回 `Schema<ObjectS<X>, ObjectT<X>>`）。

### 1.2 `inject` 的两种用法：硬门禁 vs 可选服务

```ts
// 硬门禁：llm 不在，apply 根本不执行。
export const inject = ['llm']

// 可选服务：settings 只在装上时才做「禁止自动生成页面」这个动作。
ctx.inject(['settings'], (child) => {
  child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
})

// webServer 同理：桌面端可能没有 web 载体，缺了也不该让插件加载失败。
ctx.inject(['webServer'], (web) => {
  // 注册只读路由……
})
```

要点：

- `inject` 是 cordis 的依赖门，**任一服务缺失都会让该插件实例永不 apply**。所以把「注册 provider 必需的 `llm`」放数组，把「只在某些载体才有的 `webServer`、`settings`、`authorization`」用 `ctx.inject([...], cb)` 延迟。
- `ctx.inject` 的回调在服务出现时执行；用 `ctx.effect(...)` 包住注册动作，插件卸载时自动收回。

出处：

- 宿主 pi-ai 适配器本身就是这个形状：`$HOST/dsh-llm-pi-ai/lib/index.js:2903-2905`（`settings` 延迟注入 + `configure({auto:false})`）、`:2957`（`authorization` 延迟注入）、`:2906`（读自己的 settings 命名空间）。
- `ctx.inject` 的文档语义在 cordis 类型里（`Context.inject`），宿主各处一致使用；`$HOST/dsh-llm-deepseek/lib/index.js:2700-2702` 是同样的 settings 写法。
- `ctx.effect(disposer | () => disposer)` 是 cordis fiber 生命周期 API；宿主用它收路由与注册：`$HOST/dsh-llm-pi-ai/lib/index.js:2957-2966`、`$WB/lib/index.js:12294`。

### 1.3 settings 命名空间与持久化

**命名空间不是随便起的字符串，而是 loader 条目 id（profile 里那个 entry 的 `id`）。**

```ts
// 宿主自己的取值方式：profile 里 entry 的 id 优先，兜底常量。
const settingsNs = ctx.fiber.entry?.options.id ?? 'llm-pi-ai'
```

出处：`$HOST/dsh-llm-pi-ai/lib/index.js:2906`。

对应到本插件：`cordis.patch.yml` 里 insert 的条目是

```yaml
- insert:
    - id: dsh-connect-desktop
      name: dsh-connect-desktop
```

所以本插件的 settings 命名空间是 **`dsh-connect-desktop`**（`src/config.ts#settingsNamespaceOf` 读 `ctx.fiber.entry.options.id`，兜底同一常量）。settings 页面读到的视图里，`ns` 字段就是它：

```ts
// $HOST/dsh-settings/lib/types/types.d.ts:18-41（SettingsNamespaceView）
interface SettingsNamespaceView {
  autoGenerate: boolean
  ns: string              // ← "llm-deepseek" / "llm-pi-ai" / "dsh-connect-desktop"
  schema: JsonValue       // schema.toJSON()，用 new Schema(json) 复原
  value: JsonValue        // 默认值 → 组合基线 → 用户层，已脱敏
  base?: JsonValue
  user?: JsonValue        // 出现即代表用户覆盖过该字段
  applies: 'live'
  secrets: SettingsSecretView[]
  revision: number        // 写回时作为 expectedRevision，防并发覆盖
}
```

持久化落点：**profile 的 patch YAML**，不是插件自己的文件。

- `ctx.settings` 是 `SettingsForms` 服务：`$HOST/dsh-settings/lib/types/index.d.ts:24-29`（`Context.settings`）。
- 读：`describe()` 返回 `SettingsDescriptor[]`（`:96`），字段含 `ns/schema/value/revision/base/user`（`:8-19`）。
- 写：`update(ns, patch, expectedRevision?)` 合并字段（`:102`）；`replace(ns, section, rev?)` 整体替换（`:108`）；`mutate(ns, ops, rev?)` 按路径改、用于「编辑器只看到脱敏视图」的场景（`:114`）。
- 文件位置：`documentPath`（`:87`）与 `prepareDocument()`（`:91`）暴露给原生编辑器；宿主实现里 `documentPath` 直接取自 `configEditor.documentPath`（`$HOST/dsh-settings/lib/index.js:399-407`），写入走 `configEditor` 的 profile patch。
- `configure({ auto: false }, owner?)` 关闭「没有自定义页面时自动生成表单」：`:80-82`。本插件带自定义设置卡片时必须关掉，否则同一 section 会出现两个入口。

`applies: 'live'` 的含义：字段改了**不重启**就进下一次请求。实现手段是 Schemastery 的 `.volatile()` + loader 的 `loader/volatile-update` 事件：

```ts
// 让字段成为「热更新字段」的写法（宿主 deepseek 路由的 Config 就是这么写的）
baseURL: z.string().volatile(),
streamIdleTimeoutMs: z.number().default(300_000).volatile(),
```

出处：`$HOST/dsh-llm-deepseek/lib/index.js:320-343`；`Config` 的 `Volatile<Record<...>>` 形状见 `$HOST/dsh-llm-pi-ai/lib/types/config.d.ts:209-217`。

消费热更新：

```ts
ctx.on('loader/volatile-update', () => {
  try {
    ensureRegistrationFacts() // 重新读 profiles() 并在必要时 replace 路由
  } catch (error) {
    ctx.logger.error('dsh-connect-desktop: configuration conflicts with an existing provider route')
    ctx.logger.error(error)
  }
})
```

出处：`$HOST/dsh-llm-pi-ai/lib/index.js:3000-3007`；另一个等价写法在 `$HOST/dsh-llm-deepseek/lib/index.js:2737-2748`（只在 retryPolicy 变化时 `registration.replace([provider])`）。

> ⚠️ 写入前校验：宿主在 `internal/config` 钩子里用 `Config(raw)` + `assertServiceable(...)` 先验后写，失败就拒绝保存（`$HOST/dsh-llm-pi-ai/lib/index.js:2927-2934`）。我们自己的 Config 应尽量把约束放进 Schemastery（`.min/.step/.union`），让 settings 页面在提交前就挡住坏值。

### 1.4 本仓库已落地的配置

`$REPO/package.json` 已声明：

```json
"dependencies": { "@deepseek-ai/schemastery": "3.19.0" }
```

Schemastery 必须是**运行时依赖**（`apply` 里 `z.object` 会被执行），与 `$WB/package.json` 的 `dependencies` 一致；其余 `@deepseek-ai/*` 全部作为 peer/dev，由宿主提供单实例。

**配置形状：根对象只有两个开关，每家供应商一片**（`src/config.ts`）：

```ts
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),   // 总开关：关掉后所有供应商都不注册
  vendors: z.any().default({}).volatile(),         // { <vendorId>: { ...该供应商自己的 schema } }
})
```

供应商配置片的字段与默认值由各自的 descriptor 声明（`descriptor.config.schema` / `.defaults`），
`src/core/registry.ts` 在缺项时补默认值。这样第 N 家供应商不需要再往根对象上加平行字段——
这正是 0.2.x 里 `baseURL` / `raccoonBaseURL` 并排那种形态要避免的。

---

## 2. `ResolvedPiAiProviderProfile` 与 pi-ai `Provider` / `Model`

### 2.1 适配器构造：最小形状

`PiAiAdapter` 是宿主提供的通用 pi-ai 适配器；本插件要做的是**给它一个 profile 工厂**，而不是自己实现 `LlmAdapter`。

```ts
// 已通过 tsc 的完整片段（见 §10）；节选核心
import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

const adapter = new PiAiAdapter({
  profiles,                                  // () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  resolveApiKey: async () => readToken(),    // 每个 stream 调用解析一次并冻结
  auth: INERT_AUTH,                          // 必填，见 §3.4
  prepareHeaders,                            // 可选，同步；见 §3.3
})
```

`PiAiAdapterOptions` 的权威定义：`$HOST/dsh-llm-pi-ai/lib/types/adapter.d.ts:35-82`。四个字段的语义（原文要点）：

| 字段 | 语义 | 出处 |
|---|---|---|
| `profiles()` | 每次操作读一次；返回 **不可变快照**。配置变化会建新 `Models` 集合，不会改旧集合 | `adapter.d.ts:35-37`；`$HOST/dsh-llm-pi-ai/lib/index.js:1892-1901` |
| `resolveApiKey(provider, profile)` | 每个 stream 调用一次并随调用冻结；`listModels` 也会调用它，抛 `MISSING_CREDENTIAL` 时不给模型 | `adapter.d.ts:38-47`；实现 `lib/index.js:2934-2941` |
| `auth` | **必填**。pi-ai 的 `CredentialStore` + `AuthContext`；缺失会退化为 pi-ai 的内存空 store，登录态每次重启蒸发 | `adapter.d.ts:48-56, 84-89` |
| `prepareHeaders(request, headers)` | 同步、在 SDK dispatch 前跑；抛错 → `REQUEST_HEADERS`，不会发包 | `adapter.d.ts:57-68`；实现 `lib/index.js:1847-1864` |

`auth` 对象的类型**没有从包根导出**（根只导出 `PiAiAdapterOptions` 与 `PiAiRequestHeaderContext`，见 `$HOST/dsh-llm-pi-ai/lib/types/index.d.ts:4-9`）。正确写法是用索引类型：

```ts
const INERT_AUTH = {
  credentials: {
    async read() { return undefined },   // 必须显式 return undefined；void 不满足 CredentialStore
    async list() { return [] },
    async modify() { throw new Error('loomy route has no pi-ai credential lifecycle') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
} satisfies PiAiAdapterOptions['auth']
```

出处：`PiAiAuthInjection` 在 `$HOST/dsh-llm-pi-ai/lib/types/adapter.d.ts:84-89`，但未出现在包根导出清单里（`index.d.ts:4-9` 只有 `PiAiAdapter`/`PiAiAdapterOptions`/`PiAiRequestHeaderContext`/`Config`/`recordKeyFor`/`supportedProtocols`）。`INERT_AUTH` 的真实范式见 `$WB/lib/index.js:1421-1443`（注释明确写了「pi-ai 的 credential lifecycle 与 ambient discovery 绝不能给这条路由凭空造出凭据」）。

### 2.2 `ResolvedPiAiProviderProfile` 的必填字段

```ts
const profile = (): ResolvedPiAiProviderProfile => ({
  provider: LOOMY_PROVIDER,            // 路由键，必须等于 registerAdapter 里的字符串
  displayName: 'Loomy',                // 选择器显示名
  streamIdleTimeoutMs: 300_000,        // 默认值由 resolveProfiles 填，这里显式更清楚
  maxRequestImageBytes: 20 * 1024 * 1024,
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,        // 必须 <= maxRequestImages
  requestImagePixelBudget: 4 * 1024 * 1024,
  requestImageMaxBytes: 1024 * 1024,
  retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-desktop retryPolicy'),
  configuredMaxTokens: new Map(),      // 显式配置的 per-request 上限；catalog 能力不要塞这里
  modelErrors: new Map(),              // 每个模型的失败原因；空 Map = 健康
  piProvider: provider,                // pi-ai Provider；没有它该路由不出模型
})
```

字段权威定义：`$HOST/dsh-llm-pi-ai/lib/types/config.d.ts:171-208`。重点：

- `provider` = 路由键 = `Models` 集合键 + 配置 dict 键（`:173-174`）。
- `piProvider?: Provider`：**缺少它时该路由仍是「可编辑配置」，但没有任何可请求模型**；`catalogError` 会给出诊断（`:193-197`）。
- `modelErrors` / `configuredMaxTokens` 是 `ReadonlyMap`，必须给（`:200-207`）。
- 其余字段（`streamIdleTimeoutMs`、图片预算、`retryPolicy`）是 `PiAiProviderProfile` 的可选字段，但 `Resolved...` 把它们标成已解析必填（`:179-192`）。用 `resolveRetryPolicy(undefined, 标签)` 生成 `retryPolicy`（`$HOST/dsh-llm/lib/types/retry-policy.d.ts` + `$WB/lib/index.js:2413`）。
- `piProvider` 与 profile 是两条独立通道：`$HOST/dsh-llm-pi-ai/lib/index.js:1895-1896` 先 `createModels(this.config.auth)`，再对每个 profile `models.setProvider(profile.piProvider)`。**profile 里没有 `piProvider` 的 route 不会被加进集合。**

### 2.3 `pi-ai Provider` 与 `Model` 的最小形状

```ts
import { createProvider, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function toPiModel(info: LoomyCatalogModel, baseURL: string): Model<'openai-completions'> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: LOOMY_MODEL_IDENTITY,     // 见 §2.4：不一定是路由键
    baseUrl: baseURL,
    input: ['text'],                    // Loomy 图片模型不注册为聊天模型
    cost: NO_COST,
    contextWindow: info.context_length ?? 128_000,
    maxTokens: info.max_output_tokens ?? 8_192,
    reasoning: false,                   // Loomy 模型目录没有 reasoning 能力字段时按 false
  }
}

const provider = createProvider({
  id: LOOMY_PROVIDER,
  name: 'Loomy',
  auth: {
    apiKey: {
      name: 'Loomy session token',
      // ⚠️ 必须把请求级覆盖回传成解析结果，详见下方「认证覆盖的回传义务」。
      // 直接 `return undefined`（「认证由 apiKey 覆盖，这里不用管」的直觉读法）
      // 会让**每一个**推理请求在发出前就失败。
      async resolve({ credential }) {
        const apiKey = credential?.key
        if (apiKey === undefined || apiKey.length === 0) return undefined
        return { auth: { apiKey }, source: 'Loomy desktop session' }
      },
    },
  },
  models: [],                                  // 静态模型；动态目录用 getModels 覆盖
  api: openAICompletionsApi(),                 // 返回 ProviderStreams
})
```

#### 认证覆盖的回传义务（本项目实测踩中的阻塞级坑）

`resolveApiKey` 交给适配器的 session 会作为**请求级 `apiKey` 覆盖**传给 pi-ai，而 `Models.applyAuth()` 并不直接使用它，而是**转发进 `provider.auth.apiKey.resolve({credential})`**；该方法返回 falsy 时，`applyAuth` 抛
`ModelsError("Provider is not configured: <route>")`，请求在**任何 I/O 之前**结束。

- 判据链：`$PI/models.js:435-444`（`applyAuth`）、`$PI/auth/resolve.js:17-22`（有 `overrides.apiKey` 且 provider 声明了 `apiKey` 时走 `resolveApiKey(..., {type:'api_key', key: overrides.apiKey})`）。
- 正确写法即上面的回传：`{ auth: { apiKey: credential.key } }`。家族同位置实现见 `$WB/lib/index.js:2386-2395`。
- **`INERT_AUTH`（§3.4）不是这一层**：那是适配器级 `PiAiAdapterOptions.auth`（credential store + authContext），路线不拥有 pi-ai 凭据生命周期时装 inert 是对的；provider 级 `auth.apiKey.resolve` 承载的是**请求级覆盖的回传**，两者不可混为一谈。
- 这类缺陷 CLI 与 `doctor`/`status` 都不覆盖（它们不跑推理），只有真实 dispatch 才暴露 —— 因此 `tests/host/provider.test.mjs` 用**真实 `PiAiAdapter` + 环回网关**断言真实请求头，而不是只测配置对象。

出处：

- `Provider` 接口（`id/name/baseUrl/auth/getModels/stream/streamSimple/...`）：`$PI/models.d.ts:72-130`。`auth` 必填，至少 `apiKey`/`oauth` 之一（`:76-84`）。
- `createProvider` 参数与语义：`$PI/models.d.ts:222-263`（`CreateProviderOptions` 在 `:222-254`，函数签名 `:263`）。`api` 可以是单个 `ProviderStreams` 或按 `model.api` 分派的 map（`:244-250`）。
- `ProviderStreams` 形状：`$PI/types.d.ts:205-210`（`stream` + `streamSimple` 必填）。
- `openAICompletionsApi(): ProviderStreams`：`$PI/api/openai-completions.lazy.d.ts:1-3`；子路径 `@earendil-works/pi-ai/api/*` 在 `$PI/../package.json` 的 `exports` 里（`./api/*`）。
- `Model` 字段（`id/name/api/provider/baseUrl/input/cost/contextWindow/maxTokens/reasoning` 必填）：`$PI/types.d.ts:647-683`。
- 家族里的对应实现：`$WB/lib/index.js:2383-2420`（`createProvider({id, name, auth, models, api})`）、`:1520-1560`（`toPiModel` 逐字段构造）、`:1412-1419`（图片预算常量）。

### 2.4 模型 identity：`isSameModel` 与 `requireProvider` 的两个坑

这是**最容易埋雷**的一节。pi-ai 的模型 identity 由三个字段共同决定：

```js
// $PI/api/transform-messages.js:85-96（pi-ai 1.5.2 实际源码）
if (msg.role === "assistant") {
  const assistantMsg = msg;
  const isSameModel = assistantMsg.provider === model.provider &&
    assistantMsg.api === model.api &&
    assistantMsg.model === model.id;
  ...
  if (block.type === "thinking") {
    // Thinking from another model is dropped...
    if (!isSameModel) return [];
```

结论与坑：

1. **`isSameModel` 是 `provider` + `api` + `model.id` 三者全等**。任何一项不同，历史 assistant 消息就按「别的模型」处理。1.5.2 的行为是**丢弃 thinking**（上面的 `if (!isSameModel) return []`）；旧版 pi-ai（workbuddy README 记录的 0.85）是**把 thinking 降级成正文**——后者会让模型把自己的工作笔记当回答读，还会改变计费口径。
2. **`requireProvider` 用的是模型对象上的 `model.provider` 字段，不是路由键**：

```js
// $PI/models.js:424-430
requireProvider(model) {
  const provider = this.providers.get(model.provider);
  if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
  return provider;
}
```

而注册表是按 **provider 对象的 `id`** 写键的：

```js
// $PI/models.js:52-55
setProvider(provider) {
  this.supersedeProviderRefresh(provider.id);
  this.providers.set(provider.id, provider);
}
```

3. 这两条叠加的后果（workbuddy 的实测记录）：
   - 若把「路由 id」直接盖到模型 `provider` 上，多路由共享同一模型 id 时，两条路由的 thinking 会互相被判定为「异模型」，历史被降级/丢弃。
   - 若为了规避上一条，把所有路由的模型都盖成同一个「共享 identity」，而**只注册路由 id 一个键**，那么 `requireProvider` 在 `models.get(model.provider)` 处找不到 provider，**每个请求在发出前就抛 `Unknown provider`**，且错误里不带插件名，看起来像宿主坏了。

   workbuddy 的最终修法：**每条路由把自己的注册表同时登记「路由 id」和「共享 identity」两个键**：

```ts
// $WB/lib/index.js:2438-2442（节选）
piProvider: key === providerId ? provider : {
  ...provider,
  id: key,
}
```

   模型上盖的 `provider` 字段仍是共享 identity（保证 `isSameModel` 成立），而 profile 的 `piProvider` 用路由 id 另造一个 provider 对象，`Models` 因此把两个键都写进注册表；`requireProvider` 查到的就是**本路由自己的** provider 对象（含自己的 baseUrl 与凭据）。

出处：`$WB/README.md:741`（`isSameModel` 判据与 thinking 降级）、`:744`（issue #75：`requireProvider` 用模型字段查表，双键注册的修法）。`$PI/api/transform-messages.js:85-96`、`$PI/models.js:52-55, 424-430` 是安装版本上的直接证据。

**对本插件的落地建议：**

- 只有一条 Loomy 路由时，`provider: 'loomy'`（模型字段）与路由 id `'loomy'` 相同即可，不触发坑 2。
- 若以后加「国内/国际」两条路由，**必须**按 workbuddy 的双键法：模型 identity 用共享常量，`piProvider` 用 `{...provider, id: route}`。
- 无论几条路由，`api` 字符串必须**处处一致**（`'openai-completions'`）；`profile.api` 与模型对象的 `api` 不要一个写 `openai` 一个写 `openai-completions`。
- 上游目录里的图片模型（`Hy-Image-*`）不要注册成聊天模型；`Model` 的 `type` 不写就是 chat（`$PI/types.d.ts:660-666`），注册了就会在选择器里出现一个必然失败的条目。Loomy 目录的识别规则见 `.refs/RECON.md`「模型目录字段」与 `.refs/loomy-models.json`。

### 2.5 动态目录：`getModels` 覆盖静态列表

Loomy 的模型目录在 `GET /api/v1/models`，且名称自带倍率、会变。推荐：

```ts
const provider = {
  ...createProvider({ id: LOOMY_PROVIDER, name: 'Loomy', auth, models: [], api: openAICompletionsApi() }),
  getModels: () => catalog.current().map((info) => toPiModel(info, baseUrl())),
}
```

`Provider.getModels()` 的契约：必须同步、不得抛异常；抛异常等价于「没有模型」（`$PI/models.d.ts:85-91`）。workbuddy 用同样手法把 loopback shim 的临时端口与实时目录接进来（`$WB/lib/index.js:2368-2381, 2438-2442`）。

目录变化后如何让选择器刷新：发 `llm/models-updated` 事件（参数是路由 id）：

```ts
ctx.emit('llm/models-updated', LOOMY_PROVIDER)
```

事件定义：`$HOST/dsh-llm/lib/types/types.d.ts:23-28`，注释明确「consumers reload `listModels()`」。宿主 deepseek 路由的用法：`$HOST/dsh-llm-deepseek/lib/index.js:2686-2688`。

---

## 3. `registerAdapter` 的时序与 `replace`、`prepareHeaders`、auth 注入

### 3.1 注册时序：在 `apply` 里同步注册，初始路由不能为空

```ts
const registration = ctx.llm.registerAdapter([LOOMY_PROVIDER], adapter)

// 之后目录/配置变化时，原子替换同一 adapter 实例的路由集合：
ctx.on('loader/volatile-update', () => registration.replace(currentRoutes()))
```

硬规则（都能在实现里看到）：

- **初始注册的 `providers` 不能是空数组**：`registerAdapter` 内 `if (providers.length === 0) throw new LlmError(..., 'INVALID_ADAPTER')`（`$HOST/dsh-llm/lib/index.js:1845-1847`）。所以「还没有模型目录」时不要先注册空路由；要么延迟到目录就绪，要么先注册一条有静态兜底模型的 route。
- **同名路由只能有一个 adapter**：重复注册抛 `DUPLICATE_ADAPTER`，且是 all-or-nothing（`$HOST/dsh-llm/lib/index.js:1872`）。
- **`providerInfo(provider)` 必须返回 `{id: provider, name: 非空}`**：宿主逐条校验（`$HOST/dsh-llm/lib/index.js:1873-1874`）。`PiAiAdapter` 已实现为读 profile 的 `displayName`（`$HOST/dsh-llm-pi-ai/lib/types/adapter.d.ts:111`）。
- **注册随 fiber 销毁**：`ctx.effect` 包裹，disposer 会删掉本注册持有的全部路由（`$HOST/dsh-llm/lib/index.js:1848-1853`）。

### 3.2 `replace` 语义：先全量校验，再一个同步区段换掉

```ts
// 接口签名
replace(providers: string[]): void
```

权威语义（`$HOST/dsh-llm/lib/types/index.d.ts:202-220`）：

- 候选集合**先整体校验**：与另一个 adapter 冲突、名字非法、provider 元数据坏 → 直接抛，**当前路由原样保留**。
- 校验通过后**一个同步区段**完成释放 + 重新注册，中间没有「路由真空期」。
- **`replace([])` 合法**（settings 把路由清空的场景），这是与「初始注册不能为空」的关键区别。
- 注册已 dispose 后再 `replace` 抛 `REGISTRATION_DISPOSED`。

实现证据：`$HOST/dsh-llm/lib/index.js:1856-1859`（replace）、`:1895-1903`（commitRoutes 原子换 + 发 `llm/adapters-updated`）、`:1867-1887`（prepareRoutes 全量校验）。

**何时 replace：**

- 路由集合变了（增删 provider）→ `replace(routes)`。
- 只是某个 route 的 `displayName` 变了 → 也要 replace，因为 `providerInfo` 的结果随注册快照走；pi-ai 用 `registrationFacts()` 把 `{provider, displayName, retryPolicy}` 排序后做比较，变了才 replace（`$HOST/dsh-llm-pi-ai/lib/index.js:2862-2878, 2988-2999`）。
- 模型目录变化 → **不需要** replace；`getModels()` 是每请求实时读的，发 `llm/models-updated` 让 UI 重新 `listModels()` 即可。

### 3.3 `prepareHeaders`：调用点、可用字段、失败语义

```ts
import type { PiAiRequestHeaderContext } from '@deepseek-ai/dsh-llm-pi-ai'

const prepareHeaders = (request: PiAiRequestHeaderContext, headers: Headers): Headers => {
  headers.set('loomy-version', '0.9.39')
  headers.set('invokeorigin', 'user')
  // traceparent 缺失时上游会挂死（见 .refs/RECON.md）
  headers.set('traceparent', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`)
  return headers
}
```

可读字段（`$HOST/dsh-llm-pi-ai/lib/types/types.d.ts:1-7`）：

```ts
interface PiAiRequestHeaderContext {
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly purpose?: string
  readonly baseURL: string   // 本次调用实际选中的模型 endpoint
}
```

实现细节（`$HOST/dsh-llm-pi-ai/lib/index.js:1847-1864`）：

1. 以 **profile.headers 的新副本** 初始化 `Headers`，同名不同大小写后者覆盖。
2. 构造 `Object.freeze({provider, model, baseURL, sessionId?, purpose?})`。
3. 调用 `prepare(request, initial)`；**同步**，返回值就是最终 headers 的基底。
4. 之后**宿主强制写入 attributionHeaders()**——所以插件改不了 `User-Agent` 等保留头，改了也会被覆盖（`$HOST/dsh-llm/lib/types/index.d.ts:124-129` 也要求每个 provider 请求带 `attributionHeaders()`）。
5. 任何抛错 → `LlmError(..., 'REQUEST_HEADERS')`，**不会发出半个请求**；`TypeError` 的细节会被替换成安全文案（防止 header 值里的密钥回显）。

调用点：**只在推理调用上**，且 `baseURL` 取 `model.baseUrl`（`$HOST/dsh-llm-pi-ai/lib/index.js:2031`），不在模型发现（discovery）上跑。所以聊天必带的 `chatid/msgid/traceparent` 应该在这里注入，而 `GET /models` 的追踪头要在 `resolveApiKey`/发现路径另想（本插件 scope 里不注册 discovery 即可）。

> `prepareHeaders` 是**直接构造 `PiAiAdapter`** 时的入口。若你挂的是宿主自己的 `dsh-llm-pi-ai` 插件（不是自己的 adapter），对应的扩展点是 waterfall 事件 `llm-pi-ai/request-headers`：`$HOST/dsh-llm-pi-ai/lib/types/index.d.ts:13-29`；事件在 `$HOST/dsh-llm-pi-ai/lib/index.js:2950` 接上。本插件走前者。

### 3.4 auth 注入：`credentialStoreFrom` / `authContextFrom` 的等价物

先说结论：**这两个函数没有从 `dsh-llm-pi-ai` 导出**，`PiAiAdapterOptions.auth` 需要你给两个 pi-ai 接口的实现：

- `credentials: CredentialStore`：pi-ai 的读写/刷新存储；
- `authContext: AuthContext`：pi-ai 在解析 provider 自身 auth 时问的「环境变量/文件是否存在」。

三条可选路线：

**路线 A（推荐给 Loomy）：完全惰性 auth + 每次请求的 `resolveApiKey`。**

Loomy 的凭据是本机桌面客户端的 `auth-session.json`（见 `.refs/RECON.md`），不是 DSH 凭据库。最贴合的做法就是 workbuddy 的 `INERT_AUTH`（`$WB/lib/index.js:1421-1443`）：所有 ambient 问题答「没有」，`resolveApiKey` 每次读文件返回 token。pi-ai 收到的 `apiKey` 是**请求级最高优先级 auth override**（`$HOST/dsh-llm-pi-ai/lib/types/adapter.d.ts:16-24` 解释了这个设计），因此 inert store 不会影响请求认证。

**路线 B：把 token 存进 DSH 凭据库，仍用请求级 `resolveApiKey`。**

```ts
const resolveApiKey = async (_provider: string, _profile: ResolvedPiAiProviderProfile) => {
  const credentials = ctx.get('credentials')
  const hit = await credentials?.resolve('LOOMY_SESSION_TOKEN')
  if (hit === undefined) throw new Error('LOOMY_SESSION_TOKEN is not set')
  return hit.value
}
```

`ctx.credentials` 的声明与 `resolve(ref)`：`$HOST/dsh-credentials/lib/types/index.d.ts:99-100`（`Context.credentials`）、`:130`（`resolve(ref)`）、`:18`（`credentialRef(value)`）。
宿主 pi-ai 的同款实现：`$HOST/dsh-llm-pi-ai/lib/index.js:2934-2941`（先 `credentials.resolve(ref)`，再退回 `launchEnvironmentOf(ctx)`，都没有就抛 `MISSING_CREDENTIAL`）。

**路线 C：完整复刻宿主凭据桥（需要登录态/刷新时）。**

宿主源码可直接照抄（都在 `$HOST/dsh-llm-pi-ai/lib/index.js`）：

- `credentialStoreFrom(ctx)`：`:2179-2214`。`read/list/modify/delete` 四个方法；`read` 对非法 record id 答 `undefined`；`modify` 对非法 id 抛 `UNSTORABLE_PROVIDER_ID`。
- `authContextFrom(ctx)`：`:2227-2250`。`env(name)` 先查凭据 `resolve`，再查 `launchEnvironmentOf`；`fileExists(path)` 处理 `~/` 展开。
- record key 格式：`recordKeyFor(providerId)`，这个**是导出的**（`$HOST/dsh-llm-pi-ai/lib/types/auth.d.ts:19-25`，包根再导出见 `index.d.ts:9`），scope 固定 `llm-pi-ai`。

⚠️ 路线 C 的文件都是压缩后的 JS，照抄时注意 `ctx.get('credentials')` 可能返回 `undefined`（组合里没装凭据服务），宿主对此的处理是「读答没有、写抛 `NO_CREDENTIAL_STORE`」（`$HOST/dsh-llm-pi-ai/lib/index.js:2160-2176`）。

### 3.5 `resolveApiKey` 的调用时机与冻结语义

- 每个 stream 调用在 dispatch 前调用一次，结果**随这次调用冻结**（`$HOST/dsh-llm-pi-ai/lib/types/adapter.d.ts:38-47`；实现 `lib/index.js:1994`）。
- `listModels` 也会调用；抛错时 `MISSING_CREDENTIAL` 会让该路由「暂时没有模型」而不是崩掉选择器。
- 返回 `undefined` = 交给 pi-ai 自己的 ambient discovery；**只有 profile 完全没命名凭据时才应该这么做**，否则会从「显式配置了但没值」悄悄变成「用环境里碰巧有的值」。

---

## 4. 宿主 HTTP 路由：`webServer`、校验约定、client↔host 只读范式

### 4.1 注册

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
// 关键：type-only import 才会加载 `ctx.webServer` 的声明合并
import type {} from '@deepseek-ai/dsh-host-webserver'

ctx.inject(['webServer'], (web) => {
  web.effect(
    () =>
      web.webServer.register({
        kind: 'exact',                       // 'exact' | 'prefix'
        path: '/plugins/dsh-connect-desktop/demo/usage',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          // 自己拥有完整响应生命周期（可挂 SSE）
        },
      }),
    'dsh-connect-desktop: usage route',
  )
})
```

契约：

- `WebRoute`：`kind`、`path`（绝对、无尾斜杠）、`handler(req, res)` **自己拥有完整响应生命周期**（`$HOST/dsh-host-webserver/lib/types/index.d.ts:36-45`）。
- `register(route)` 返回 disposer；重复 `(kind, path)` 直接抛（`$HOST/dsh-host-webserver/lib/index.js:377`：
  `webserver: duplicate ${kind} route "${path}"`）。
- **推论（踩过一次）**：同一个路径的多个动词只能注册**一次**。`src/core/routes.ts` 把
  `GET`/`POST` 合进一条 `RouteSpec.methods`；`src/core/http.ts#mountRoutes` 在挂载前
  对路径去重并给出可读错误，因为真实的抛错发生在 `web.effect` 里，表现是这一家的
  **所有**面板都说"宿主未提供该路由"，极难定位。
- 测试里的假 `webServer.register` **必须**像真宿主一样对重复路径抛错，否则这类问题
  只会在真机上暴露。
- 另有 `registerUpgrade`（WebSocket，`:195-200`）、`registerFallback`（SPA 静态回退，`:203-210`）。本插件只用 `register`。
- `webServer` 只保证「路由被调用」；**不含鉴权、不含 CSRF、不含 JSON 解析**。

### 4.2 CSRF / 鉴权：宿主没有内置的插件级令牌层

这是必须说清楚的现状（避免误以为「注册了就自动安全」）：

- `dsh-api-gateway` 的 `Config` 只有 WebSocket 心跳/缓冲/压缩三项（`$HOST/dsh-api-gateway/lib/types/index.d.ts:20-28`），没有 per-request token/CSRF 开关。
- 宿主自己的安全模型是「绑定地址即信任边界」：`webServer` 明确拒绝 `0.0.0.0`，只允许一个具体的本机接口地址（`$HOST/dsh-host-webserver/lib/types/index.d.ts:79-100`），并认为本机 origin 可信（`$HOST/dsh-host-webserver/lib/index.js:184` 的注释：浏览器把这些地址当 local/trustworthy origin）。
- 因此**插件自建路由必须自己设防**。家族里验证过的两道闸（workbuddy 的 `loopback.ts`，`$WB/lib/index.js:3440-3640`）：

  1. **Host 必须指向连接实际落在的本机接口**：防 DNS rebinding（攻击者域名解析到 127.0.0.1，但 `Host` 仍是攻击者域名）。判据是 `Host` 的 hostname 等于 `req.socket.localAddress`（或本身就是 `localhost`/127/8/`::1`）。
  2. **Origin 要么缺失，要么是本机**：缺 Origin 的是非浏览器客户端（插件自己的 fetch、curl、测试）；带 Origin 的必须是本机 origin。

  作者在注释里明确写了「两者都不是认证：本机任何进程都能伪造，只是这些 surface 的最低要求；当路由会花钱时不能拿它替代 secret」（`$WB/lib/index.js:3450-3470`）。

- 读路由（本插件 scope）的推荐骨架：

```ts
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const handler = (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
  if (!hostMatchesListener(req.headers.host, req.socket.localAddress)) return json(res, 403, { error: 'host not allowed' })
  const origin = req.headers.origin
  if (origin !== undefined && !originIsLocal(origin, req.socket.localAddress)) return json(res, 403, { error: 'origin not allowed' })
  // 只读业务……
}
```

  写路由额外三条：**只接受 POST**、**要求 JSON Content-Type**（跨站 simple request 带不了 `application/json`，天然挡掉表单型 CSRF）、**花钱/改状态的动作加一个进程级不可猜 token**（家族里 router-loomy 的 README 也强调「变更类操作带进程级 CSRF 令牌」，见 `.refs/router-loomy/README.md:96`）。token 的生成用 `node:crypto.randomBytes`，只注入到 index HTML 或通过一个同源 GET 引导接口下发，不要写进 URL query。

- 真实路由骨架（方法闸 → loopback → 可选前置条件 → 区域 → try/catch → 500）见 `$WB/lib/index.js:12307-12335`。它把每道闸收进一个 `raw()` 包装，避免「漏抄一道闸」——这是值得抄的结构。

### 4.3 client↔host 只读路由范式

路由 URL 约定：`/plugins/<package-name>/<vendorId>/<suffix>`。插件级只留一条
`/plugins/<package-name>/status`（一次回答所有供应商），其余全部挂在供应商命名空间下，
而且**只注册该供应商能力声明允许的那些**（见 §4.4）。这与 client-modules 注册的 `/plugins` **prefix** 路由同域，但不会冲突：宿主路由表**先查 exact 表、miss 后才在 prefix 表里做最长前缀匹配**（`$HOST/dsh-host-webserver/lib/index.js:576-590`），所以 `kind:'exact'` 的插件路由永远先命中；只有未登记的 `/plugins/...` URL 才落到 bundle 路由（它对未知 URL 答 404）。家族实例：

```ts
// $WB/lib/client.js:7-25（常量）
const WORKBUDDY_USAGE_PATH = "/plugins/dsh-connect-workbuddy/usage"
```

客户端读法（同源 GET、`credentials: 'same-origin'`、可被 AbortSignal 取消）：

```ts
const response = await fetch('/plugins/dsh-connect-desktop/loomy/credits', {
  headers: { accept: 'application/json' },
  credentials: 'same-origin',
  signal,                                 // 组件卸载时 abort
})
const value = await response.json().catch(() => undefined)
if (!response.ok) throw new Error(`HTTP ${response.status}`)
```

出处：`$WB/lib/client.js:9852-9862`（带 latest-wins 守卫的真实读）、`:2622-2636`（GET/POST 封装，404/503 被解释为「宿主没有这条路由」而不是错误）。

三条实践建议：

1. **`undefined`（404/503）与「有路由但值为空」必须区分**：前者用来隐藏 UI 控件，后者渲染空态。
2. 响应加 `cache-control: no-store`；客户端不要缓存。
3. 读路由不要触发上游写操作；积分概览这类会花配额的上游读，在 host 侧加短 TTL 缓存 + 单飞（in-flight 去重），避免卡片重渲染打爆上游。

---

### 4.4 本插件实际的路由表（能力驱动，0.3.0 起）

路由**不是手写的**：`src/core/routes.ts` 按供应商的能力声明生成，能力为假时该路由
**根本不注册**（不是注册后返 404/文案）。所以下面这张表是"声明 ⇒ URL"的对照，而不是一份
需要同步维护的清单。

插件级（一条，所有供应商共用）：

| 方法 | 路径 | 载荷 |
| --- | --- | --- |
| `GET` | `/plugins/dsh-connect-desktop/status` | `{ ok, csrfToken, vendors: VendorStatusView[] }` |

供应商命名空间 `/plugins/dsh-connect-desktop/<vendorId>/<suffix>`：

| suffix | 方法 | 门槛（能力声明） |
| --- | --- | --- |
| `diagnostics` | `GET` | `diagnostics: true` |
| `diagnostics/probe` | `POST` | `diagnostics: true` 且实现了 `probeEndpoints` |
| `recheck` | `POST` | 有身份概念（`accounts`/`login`/`diagnostics` 任一） |
| `credits` | `GET`（`?force=1` 绕过缓存） | `credits.kind !== 'none'` |
| `catalog` | `GET` | `catalog.selection` |
| `refresh` / `save` | `POST` | `catalog.selection` |
| `accounts` | `GET` | `accounts !== 'none'` |
| `accounts/active` | `GET`/`POST` | `accounts !== 'none'` |
| `accounts/remove` | `POST` | `accounts !== 'none'` |
| `accounts/rename` | `POST` | `accounts === 'multi'` 且实现了 rename |
| `accounts/adopt` | `POST` | `adopt: true` 且实现了 adopt |
| `accounts/export` / `accounts/import` | `POST` | `transfer: true` |
| `pool` | `GET`/`POST` | `pool: true` |
| `auth/state` | `GET` | `login` 含真实方式 |
| `auth/send-code` | `POST` | `login` 含 `sms-code` |
| `auth/login` | `POST` | `login` 含该方式 |
| `auth/logout` | `POST` | `login` 含真实方式 |

守卫管线（`src/core/http.ts`，**全插件一份**），顺序固定：

1. 方法不在 `methods` 内 → `405 method_not_allowed`；
2. `Host` 不指向本机监听地址 → `403 host_not_allowed`（DNS rebinding 防护）；
3. `Origin` 存在且非本机 → `403 origin_not_allowed`；
4. 仅对 mutating 且非 `GET`：`content-type` 必须是 `application/json`（否则 `415`），
   且 `x-dsh-connect-csrf` 必须等于 `/status` 返回的 `csrfToken`（否则 `403 csrf_invalid`）；
5. 请求体上限 64 KiB（`MAX_BODY_BYTES`）；
6. 处理函数抛错 → `500 { ok:false, error:{ code:'internal', message } }`，绝不断连。

两点与旧版不同，且**没有兼容层**：

- CSRF 头只有一个名字 `x-dsh-connect-csrf`。旧的 `x-loomy-csrf` / `x-raccoon-csrf` 是同一机制的
  两份实现（同一进程、同一 origin，不构成隔离），已删除。
- 业务失败一律是 **HTTP 200 + `{ ok:false, error:{ code, message } }`**（CSRF/方法/媒体类型这类
  协议级拒绝才用 4xx）。客户端据此把上游原文展示给用户，而不是显示"加载失败"。

出处：`src/core/http.ts`、`src/core/routes.ts`、`src/core/registry.ts`；
可执行断言：`tests/host/routes.test.mjs`、`tests/host/vendor-contract.test.mjs`。

---

## 5. 客户端插件：`dsh.client`、设置卡片、UI primitives、locale、产物格式

### 5.1 `dsh.client` 清单

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-settings-plugins",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-locale"
    ],
    "platform": "web"
  }
}
```

字段语义与解析器：

- `platform` 必须是 `'web'` 才会被当作客户端包（`$HOST/dsh-client-modules/lib/index.js:90`）；`inject`/`external` 是字符串数组（`:91-98`）。
- `inject`：**这些包的 client bundle 必须先于本包加载/可用**（排序用）。`external`：本包 `require(...)` 的非基线模块请求，必须由某个已登记的行精确回答（`$HOST/dsh-client-modules/README.md:34, 55`）。
- 产物必须是 `lib/client.js`，且 `exports` 的 `./client` 指向它；**构建必须在启动前完成**，缺 bundle 会在激活时大声失败并给出构建指令（`README.md:59`）。
- 加载语义：bundle 执行只登记 factory，模块体副作用（含 CSS 注入）在 factory 被 materialize 时才跑（`README.md:77`）。因此 bundle 顶层不要放依赖 DOM 的副作用。

### 5.2 产物格式：`window.__ModuleLoader__.load({id, factory})`

客户端 bundle 不是普通 ESM，而是 **CJS factory 包裹**：

```js
// $HOST/dsh-client-ui-settings-web-search/lib/client.js:1-6
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings-web-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		...
		return module.exports;
	}
});
```

本仓库用 tsdown 的 `banner` / `footer` 生成同一形状（`$REPO/tsdown.config.ts:28-40, 63-88`）：

```ts
const CLIENT_BANNER = `window.__ModuleLoader__.load({
	id: "dsh-connect-desktop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
`
const CLIENT_FOOTER = `
		return module.exports;
	}
});
`
// client 配置：format 'cjs'、fixedExtension false、outExtensions {js:'.js'}、
// deps.neverBundle [/^@deepseek-ai\//, /^react($|\/)/]、inputOptions {platform:'browser'}
```

构建后 `$REPO/lib/client.js` 的前 6 行与宿主产物逐字同构（见 §10 产物摘录）。

`require` 的解析顺序：平台 seed 表（react/react-dom/jsx-runtime 等）→ 已 materialize 的模块 → boot graph 行 → 已登记 factory；**miss 会抛** `client-modules: require("...") missed the module table ...`（`$HOST/dsh-client-modules/lib/client.js:842`）。所以客户端依赖要么是平台 seed，要么在 `dsh.client.inject/external` 里登记，不能靠 npm 直接解析。

### 5.3 客户端 `inject` 与 locale

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'   // ← 加载 ctx.locale 声明合并
import { NS, en, zh } from './locale.js'

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-connect-desktop: locale')
}
```

- `ctx.locale` 的声明合并：`$HOST/dsh-client-locale/lib/types/client/index.d.ts:57-72`。
- 词典注册：`register<N>(ns, dicts)`，`dicts` 必须同时含基线语言（en/zh），缺键/多键是**编译错误**（`:199`）；`bind(ns)` 返回按命名空间收窄的 `t`（`:219`）。
- 命名空间收窄来自 `LocaleNamespaceMap` 的 declaration merging；本仓库的写法在 `$REPO/src/client/locale.ts:20-35`。
- 真实插件的写法：`$WB/lib/client.js:16480`（`const inject = ["slots", "locale"]`）、`:16573-16578`（`ctx.effect(() => ctx.locale.register(ns, {zh, en}))` + `const t = ctx.locale.bind(ns)`）。

> 包级 `locale/en.json`、`locale/zh.json` 与运行时词典**不是一回事**：前者是插件市场的包元数据（`meta.title`/`meta.description`），后者是 UI 文案。家族（workbuddy/trae）都这么分。本仓库两者都已就位：`$REPO/locale/en.json`、`$REPO/src/client/locale.ts`。

### 5.4 设置页卡片：`settings.section`（推荐）与 `settings.plugins.tab`

**推荐 `settings.section`**：它直接产出「设置 → 左侧一项 + 右侧整页」，是 workbuddy 的形态。

槽契约：`settings.section` 是 **list**、root scope，选项 `id`（section key，驱动 `only` 过滤）、`order`（导航位置）、`label`（registrant 本地化文案，用 thunk 跟随语言）：

```ts
// $HOST/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73-77
'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
// 可选图标：id 必须等于目标 section 的 id
'settings.section.icon': { kind: 'list'; scope: 'root'; inline: true; owner: SettingsSectionIconOwnerProps }  // :84-90
```

**Plugins 页里的 tab**：`settings.plugins.tab` 是 list/root，选项 `id/order/label`，由 Plugins section 的 owner 渲染成 tab（`contract/slots.d.ts:99-103`；`$HOST/dsh-client-ui-settings-plugins/lib/types/client/PluginsSettingsSection.d.ts:18-24`）。

注册 API（经由 `ctx.slots`）：

```tsx
// 已通过 tsc 的完整片段
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'   // ← ctx.slots 声明合并
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'   // ← settings.* 槽声明
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'settings.dsh-connect-desktop'

export const inject = ['slots', 'locale']

function LoomyCard() {
  return (
    <div>
      <Pill>Loomy</Pill>
      <Button variant="primary">Refresh</Button>
    </div>
  )
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en: { title: 'Loomy' }, zh: { title: 'Loomy' } }), 'loomy: locale')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'loomy',
        order: 35,
        label: () => t('title'),
        locale: NS,
        inject: () => ({ refresh: async () => undefined }),
      },
      LoomyCard,
    ),
  )
}
```

关键 API 出处：

- `ctx.slots` / `ctx.uiRenderer` 声明：`$HOST/dsh-client-ui-renderer/lib/types/client/index.d.ts:25-32`。
- `SlotRegistry.register` 就是 `SlotCore['register']`，且**必须在原型方法上**（cordis service proxy 把 `this.ctx` 绑到调用者 fiber，从而让卸载级联生效）：`$HOST/dsh-client-ui-renderer/lib/types/client/registry.d.ts:69-85`。
- `SlotRegistry.inject(key, callback)`：等声明出现后执行回调；声明已经存在则同步执行；回调的 disposer 归调用者 fiber：`registry.d.ts:96-111`。
- `register` 选项 `BaseOptions`（`name`/`children`/`store`/`locale`/`registrant` + kind 字段 `id/order/label/priority`）：`$HOST/dsh-client-ui-slots/lib/types/index.d.ts:601-625`；重载签名 `:793`、`:806`。
- `SlotEntryDef`（kind/scope/owner/inject）：`$HOST/dsh-client-ui-slots/lib/types/index.d.ts:96-123`。
- **真实插件的完整注册**（含 icon、`surface: 'settings'`、失败不拖垮 host）：`$WB/lib/client.js:16633-16685`。它的注释特别值得读：`ctx.slots.inject(name, …)` 本身就是能力探测，**不要在它外面再加版本探测**；否则「不支持」会变成「永不注册」且没有任何报错。

> 不要 `declare` 一个不属于自己的 child slot：声明即认领（`ChildrenDecl`，`$HOST/dsh-client-ui-slots/lib/types/index.d.ts:157-170`），一个 key 只能有一个 declarer。

### 5.5 可用 UI primitives

`@deepseek-ai/dsh-client-ui-primitives` 是 cordis-free 的 React 组件库，只吃 `--dsw-*` 设计 token（`$REPO/node_modules/@deepseek-ai/dsh-client-ui-primitives/README.md:12, 36`）。本仓库已安装 0.2.2-rc.1，可直接 `import { Button, Switch, Pill } from '@deepseek-ai/dsh-client-ui-primitives'`。

常用导出（`lib/types/index.d.ts` 逐个 export）：

| 类别 | 组件 |
|---|---|
| 按钮/开关 | `Button`、`Switch`、`Checkbox`、`SegmentedControl`、`SegmentedTabs` |
| 输入 | `Input`、`InlineEditor` |
| 展示 | `Pill`、`Tag`、`StateDot`、`DisclosureRow`、`AnimatedRows`、`TextShimmer`、`PathLabel`、`ShortcutKeys` |
| 浮层 | `Menu`/`MenuItemButton`、`MenuSurface`、`MenuGroup`、`HoverCard`、`HoverCardGroup`、`Modal`、`RiskConfirmation` |
| 图标/品牌 | `FishLogo`、`BrandWordmark`、`ReferenceIcon*`、`LinkIcon*`、`PermissionIcon*` |
| 渲染器 | Markdown/TeX、终端、diff、文件读取、检索结果、JSON（README 里有专用 renderer 条目） |

`--dsw-*` token 示例：`--dsw-alias-label-primary`、`--dsw-alias-label-tertiary`、`--dsw-alias-border-l2`、`--dsw-alias-state-business-primary`、`--dsw-focus-ring-*`（见 `$HOST/dsh-client-ui-settings-plugins/lib/client.js:9` 的 CSS 变量用法）。

本仓库的卡片还没写，但样式方案沿用家族：**在 client bundle 里内联 CSS，按 `data-plugin-css` 去重后注入 `<head>`**：

```ts
const tagId = '@deepseek-ai/dsh-client-ui-settings-web-search/WebSearchCard.module.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-connect-desktop'
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}
```

出处：`$HOST/dsh-client-ui-settings-web-search/lib/client.js:269-275`；workbuddy 的等价实现 `$WB/lib/client.js:9301-9306`。

---

## 6. 打包：`package.json`、`cordis.patch.yml`、tsdown 多入口、两套 tsconfig

### 6.1 `package.json` 必备字段

本仓库的 `$REPO/package.json` 已按宿主 0.2.2-rc.1 对齐：

```jsonc
{
  "name": "dsh-connect-desktop",
  "displayName": "DSH Connect Loomy",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": ["lib", "locale", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["..."], "platform": "web" }
  }
}
```

逐项理由：

| 字段 | 作用 | 家族对照 |
|---|---|---|
| `type: module` + `main: lib/index.js` | 宿主 ESM 直接 `import()` 插件 | `.refs/workbuddy-manifest/package.json:17,21` |
| `types` | `tsc` 与编辑器用 | 同上 `:22` |
| `exports["./client"]` | client-modules 用 `import.meta.resolve(pkg + '/client')` 找 bundle | `:27-38` |
| `exports["./cordis.patch.yml"]` | profile 组合时读取 patch | `:27-38` |
| `exports["./locale/*.json"]` | 插件市场/本地化元数据 | `$WB/package.json` 同款 |
| `dsh.bundle.patch` | 声明「我是 bundle，patch 在这」 | `:67-70` |
| `dsh.client.inject/platform` | 浏览器半的加载顺序与平台 | `:71-79` |
| `files` | 发布白名单；**不要把 `.refs/`、源码、node_modules 带进去** | `:40-52` |
| `bin` | 只有确实要装 CLI 时才需要（workbuddy 有 `lib/bin.js`）；本插件 scope 不需要 | `:23-25` |

peerDependencies 全部钉 `0.2.2-rc.1`（与宿主一致），`@deepseek-ai/cordis: ^4.1.0`，`@earendil-works/pi-ai: ^1.3.0`（宿主装的是 1.5.2）。`@earendil-works/pi-ai` 标 `optional: true` 与家族一致：没有 pi-ai 时插件仍可加载（只是不产出模型）。

### 6.2 `cordis.patch.yml`

```yaml
# $REPO/cordis.patch.yml
- insert:
    - id: dsh-connect-desktop
      name: dsh-connect-desktop
```

家族三个包（workbuddy / trae / router-loomy）完全同构：`.refs/workbuddy-manifest/cordis.patch.yml:1-5`、`.refs/trae-manifest/cordis.patch.yml:1-4`、`.refs/router-loomy/cordis.patch.yml:1-6`。

- `id` 是 loader 条目 id，**就是 settings 命名空间与 `/plugins` 资源 id**（§1.3、§4.3）。
- `name` 是包名，Node 解析用。
- 不要在 patch 里改 profile 默认模型：家族注释明确「只注册 provider，不动默认模型」。

### 6.3 tsdown 多入口

```ts
// $REPO/tsdown.config.ts（完整文件已落地）
export default defineConfig([
  {
    name: 'dsh-connect-desktop:host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib', format: 'esm', platform: 'node', target: 'node22',
    fixedExtension: false,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//] },
    clean: false,
  },
  {
    name: 'dsh-connect-desktop:client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022',
    fixedExtension: false,
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    deps: { neverBundle: [/^@deepseek-ai\//, /^react($|\/)/] },
    inputOptions: { platform: 'browser' },
    banner: { js: CLIENT_BANNER },   // window.__ModuleLoader__.load({...
    footer: { js: CLIENT_FOOTER },   //   return module.exports; } });
    clean: false,
  },
])
```

要点：

- **两条配置数组**交给 tsdown 构建；`clean` 交给 npm script 统一做（`node -e "fs.rmSync('lib',{recursive:true,force:true})" && tsdown`），避免两条配置各自的 `clean` 互相删产物。
- `fixedExtension:false` + `outExtensions` 才能得到 `lib/index.js` / `lib/index.d.ts` / `lib/client.js` 这些**被 package.json 硬编码**的文件名（否则 node platform 会产出 `.mjs`/`.d.mts`）。
- `format:'cjs'` 时 tsdown 会警告「CJS always targets Node.js」；用 `inputOptions: {platform:'browser'}` 覆盖（这是 tsdown 0.23.7 的显式提示，见 `node_modules/tsdown/dist/build-S0sSJY-K.mjs:125`；`inputOptions` 是 `UserConfig` 的合法字段）。
- banner/footer 的类型是 `ChunkAddon`：`node_modules/tsdown/dist/types-kxOVN9XR.d.mts:547-556`。
- `deps.neverBundle` 保证宿主包与 React **不被内联**：否则会出现第二份 `LlmRuntime`/React，cordis 服务身份与 hooks 全乱。

### 6.4 两套 tsconfig

`$REPO/tsconfig.json`（host）：

```jsonc
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2023"],
    "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "isolatedModules": true, "verbatimModuleSyntax": true,
    "skipLibCheck": true, "noEmit": true, "types": ["node"]
  },
  "include": ["src/index.ts"],
  "exclude": ["src/client"]
}
```

`$REPO/tsconfig.client.json`（browser）：

```jsonc
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true, "noUncheckedIndexedAccess": true,
    "isolatedModules": true, "verbatimModuleSyntax": true,
    "resolveJsonModule": true, "skipLibCheck": true,
    "noEmit": true, "types": ["node"]
  },
  "include": ["src/client/**/*.ts", "src/client/**/*.tsx"],
  "exclude": ["src/index.ts"]
}
```

为什么要两套：

- host 不能看到 DOM lib（避免误用 `document`/`fetch` 的浏览器语义）；client 需要 DOM + JSX。
- client 的类型依赖（`@deepseek-ai/dsh-client-ui-*`）与 host 的（`dsh-llm*`、`dsh-host-webserver`）是两套 declaration merging，混在一个 program 里会互相污染（尤其 `Context` 增强）。
- `pnpm typecheck` 就是 `tsc -p tsconfig.json && tsc -p tsconfig.client.json`，与家族一致（`.refs/workbuddy-manifest/package.json` 的 `typecheck`）。

### 6.5 依赖拉不到时的退路：tsconfig `paths` 指向宿主

本机实测 npmmirror 上 `0.2.2-rc.1` 全部可拉（见 §10），但若某个 `@deepseek-ai/*` 版本在镜像上缺失，退路是：

```jsonc
// tsconfig.json（仅 typecheck 用；不要提交这种路径给发布）
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@deepseek-ai/dsh-llm": [
        "/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts"
      ],
      "@deepseek-ai/dsh-llm-pi-ai": [
        "/Users/benny/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/index.d.ts"
      ]
      // …按需补
    }
  }
}
```

代价（必须在 PR 描述里写清楚）：

1. **路径钉死本机与宿主版本**，换机器/升宿主就断；不能进发布产物。
2. 只能解决**类型检查**：`tsdown`/运行时仍然会 `import '@deepseek-ai/dsh-llm'`，靠 profile 的 node_modules 解析；本地 `pnpm test` 若 import 了这些包会失败。
3. 客户端类型包（`dsh-client-ui-slots` 等）**不在宿主安装目录里**（宿主只装了运行时 bundle，未装它们的 `.d.ts`），所以客户端没有这条退路；它们的类型只能从 npm 拉。若拉不到，临时方案是把 `ctx.slots`/`ctx.locale` 当结构化接口自己声明（家族里 workbuddy 就是用 `softGet` + 最小本地契约做到跨宿主版本兼容），但会失去槽名/词典键的编译校验。
4. `paths` 指向的是 `.d.ts` 而不是包目录时，`isolatedModules`/`resolveJsonModule` 等组合容易出怪错；宁可把包 tarball 下载到本地 `vendor/` 再用 `file:` 依赖。

---

## 7. 测试与构建：选型建议 + 如何断言 provider 行为而不打真上游

### 7.1 选型

本仓库的现状与建议：

| 场景 | 选型 | 理由 |
|---|---|---|
| 产物形状、`apply` 契约、纯函数（头构造、目录映射、SSE 切帧） | **`node:test`**（本仓库已用，`tests/smoke.test.mjs`） | 零依赖、Node 22 自带、`pnpm test` 不需要额外配置；可直接 `import('../lib/index.js')` 与 `vm` 执行 client bundle |
| React 卡片渲染、jsdom、locale 切换 | **vitest**（家族用 `vitest run`） | 需要 jsdom + `@testing-library/react`；vitest 的 ESM/TS 直跑最省事 |
| 真上游冒烟（手工、非 CI） | `node scripts/smoke.mjs`（家族范式） | 不阻塞 CI，凭证从本机客户端读 |

本仓库脚本：

```json
"build": "node -e \"fs.rmSync('lib',{recursive:true,force:true})\" && tsdown",
"typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.client.json",
"test": "node --test tests/*.test.mjs",
"check": "pnpm run typecheck && pnpm run build && pnpm run test"
```

`tests/smoke.test.mjs` 已断言：

- host 入口导出 `name='connect-loomy'`、`inject` 含 `llm`、`Config({})` 得到默认值。
- client bundle 以 `window.__ModuleLoader__.load({` 开头、id 正确、factory 返回 `{apply, inject}`、`apply` 会 `ctx.effect(() => ctx.locale.register('settings.dsh-connect-desktop', {en, zh}))` 且 en/zh 键集合一致。

### 7.2 如何断言 provider 行为而不打真上游

五条由浅入深的手段，建议组合使用：

**（a）纯函数层：目录映射 / 头构造 / SSE 切帧。**

把「Loomy 目录 JSON → `Model` 数组」「`chatid/msgid/traceparent` 生成」「SSE 帧切分与 `points_consumed` 提取」做成纯函数，直接断言输入输出。`.refs/router-loomy/src/api/sse.ts`、`headers.ts` 已有可借的实现与单测（`sse.test.ts`、`headers.test.ts`）。

**（b）本地假上游：把 `baseURL` 指向 loopback 上的 `node:http` server。**

pi-ai 的 `ProviderRequestOptions` 支持每请求 `fetch?: FetchFunction`（`$PI/types.d.ts:48-58`，`headers`/`env` 同理），你也可以注入一个受控 `fetch`；但更贴近真实、且能验证 SSE 与头的做法，是起一个**本地 loopback HTTP server**（`node:http`，端口 0）返回固定 JSON/SSE，把 `baseURL` 指过去：

```ts
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ data: [...] })); return }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }
  res.writeHead(404).end()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
```

这比 mock `globalThis.fetch` 更接近真实：能验证 URL、方法、必须头、SSE 解析与超时。注意上游的已知怪癖（`.refs/RECON.md`）：`[DONE]` 但无 `finish_reason`、`content:""` + `finish_reason:"length"` 是合法长度截断——这些都应该有固定用例如实反映。

**（c）适配器层：用真实 `PiAiAdapter` + 假 profile，断言 `StreamChunk` 序列。**

用 `PiAiAdapter` 的公开构造（`profiles()` + `resolveApiKey` + `auth` + `prepareHeaders`），把 `piProvider` 指向一个 `createProvider({ api: { stream, streamSimple } })`（`ProviderStreams` 两个方法都必填；`stream` 可以只是 `streamSimple` 的薄包装）。pi-ai 的 `createAssistantMessageEventStream` 可以手工喂事件（workbuddy 就 import 了它，`$WB/lib/index.js:10`）。这层测试能覆盖：`prepareHeaders` 是否真的被调用、`apiKey` 是否进入请求、错误码映射（`REQUEST_HEADERS`/`MISSING_CREDENTIAL`/`QUOTA`/`RATE_LIMIT`）。

**（d）注册表层：复现 `requireProvider` 的 identity 坑（回归测试）。**

用 pi-ai 的真实 `createModels` + `setProvider` + `streamSimple` 跑一遍，而不是只测自己的函数。workbuddy 的 `tests/issue75-global-provider-dispatch.spec.ts` 就是这么做的（README `:744` 有说明）：它断言「只注册路由 id 的注册表在 `streamSimple` 时抛 `Unknown provider`」，并保留一个反证用例固定旧文案。我们若未来加第二条路由，必须补同款测试。

**（e）HTTP 路由层：** 直接 `fetch` 一个真实 `webServer` 太重；家族的做法是把 handler 抽成可注入 `req/res` 的纯函数（或起 `node:http` 假 server 挂 handler），断言 405/403/200 与 JSON shape。

---

## 8. 映射到 Loomy（本插件的具体取值）

| 契约 | Loomy 取值 | 证据 |
|---|---|---|
| 路由 id | `loomy`（只读 scope 内先单路由） | 本仓库约定；未来双区再扩展 |
| 模型 identity | 单路由时同为 `loomy`；双路由时用共享常量 + 双键注册 | §2.4 |
| `api` | `'openai-completions'`（上游 OpenAI Chat Completions 兼容） | `.refs/RECON.md`、`.refs/router-loomy/README.md`「上游契约」 |
| `baseURL` | `https://loomyad.xunfei.cn/api/v1`（可配置） | `.refs/RECON.md` 上游表 |
| 认证 | `resolveApiKey` 每次读 `~/Library/Application Support/loomy/auth-session.json` 的 `session`，请求级 `apiKey` 注入；`auth` 用惰性实现 | `.refs/RECON.md`「登录态」；`$WB` INERT_AUTH 范式 |
| 必带请求头 | `traceparent`（缺失挂死）、`chatid`、`msgid`、`loomy-version`、`invokeorigin`；`Authorization: Bearer <session>` 由 pi-ai 的 apiKey 自动带 | `.refs/RECON.md`；`prepareHeaders` 注入（§3.3） |
| 平台接口（目录/积分） | `token: <session>` 头，**不是 Bearer**；因此目录与积分走 host 自己的 `fetch`，不经过 pi-ai | `.refs/RECON.md` |
| 图片模型 | 不注册为 chat（无 `capabilities`） | `.refs/RECON.md` |
| 积分概览 | 只读 `GET /api/v1/points/records?pageNo=1&pageSize=N&recordType=all`，host 路由 `/plugins/dsh-connect-desktop/loomy/credits`，client 卡片读 | `.refs/RECON.md`；§4.3 |

---

## 9. 在宿主里挂载验证的最小步骤（不重启当前 DSH）

> 下面每一步都**不碰当前正在运行的 `web` profile**（`$DSH_HOME/profiles/web` 和 3080 端口的进程）。全部在独立的 `loomy-dev` profile 里做。

**前置：** 本仓库 `pnpm install && pnpm build` 成功，`lib/index.js`、`lib/client.js` 存在（§10）。

1. 创建独立 profile（从官方 web 模板复制，不继承现有插件）：

   ```bash
   dsh --profile loomy-dev --from-default-profile web
   ```

   首次运行会把 `web` 模板复制成 `loomy-dev` 并直接启动。先 `Ctrl+C` 停掉，后续只做装配。

2. 把本仓库装进该 profile（二选一）：

   ```bash
   # 推荐：走 dsh 自己的插件安装入口（内部就是 pnpm，写 loomy-dev 的 package.json）
   dsh plugin --profile loomy-dev add file:<本仓库路径>

   # 或者手工：在 ~/.dsh/profiles/loomy-dev 下
   pnpm add file:<本仓库路径>
   ```

3. 在 `~/.dsh/profiles/loomy-dev/package.json` 里注册 bundle（若第 2 步没自动加）：

   ```jsonc
   {
     "dependencies": {
       "dsh-connect-desktop": "file:<本仓库路径>"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // …模板原有的 bundle…
           "dsh-connect-desktop"
         ]
       }
     }
   }
   ```

   顺序不敏感：插件用 `inject: ['llm']` 等 `llm` 就绪；`webServer` 是延迟注入。

4. **只做组合校验，不启动服务**：

   ```bash
   dsh --profile loomy-dev --dump-config | grep -n -A2 -B2 dsh-connect-desktop
   ```

   能看到 `dsh-connect-desktop` 条目即说明 `cordis.patch.yml` 被正确读取、包也能解析。
   （只做组合校验时用 `--dump-config`，不会监听端口。）

5. 启动隔离实例（用另一个端口，避免与 3080 冲突；具体端口 flag 以 `dsh --profile loomy-dev web --help` 为准）：

   ```bash
   dsh --profile loomy-dev web
   ```

   启动日志里应出现（INFO 级别；`apply` 里用的是 `ctx.logger.info`）：

   ```
   dsh-connect-desktop: mounted (enabled=true, baseURL=https://loomyad.xunfei.cn/api/v1)
   ```

6. 在浏览器打开隔离实例的 URL，检查：

   - 开发者工具 Console 无 `client-modules: ... missed the module table` 或 `bundle ... loaded without registering` 报错（说明 `lib/client.js` 的 `id` 与条目 id 一致、wrapper 正确）。
   - Network 里有本包的 `client.js` 请求（由 boot graph 的 `/plugins/...` URL 触发）。
   - 设置页：骨架阶段**还没有卡片**；T3 起应出现「设置 → Loomy」一项（`settings.section`，order 35）。
   - 模型选择器：骨架阶段**不应出现 Loomy 模型**；T3 起应出现上游目录里的聊天模型。

7. 验完停掉隔离实例；当前 DSH（3080）全程不受影响。

**排障速查：**

| 现象 | 可能原因 |
|---|---|
| `--dump-config` 里没有条目 | `dsh.profile.bundles` 没加、或 `cordis.patch.yml` 的 `name` 与包名不一致 |
| 启动即报 `an adapter for provider "loomy" is already registered` | 另一份插件（旧安装）仍在该 profile 里；清 profile 的 node_modules 或删重复条目 |
| 浏览器 404 找不到 client bundle | 没 `pnpm build`、或 `exports["./client"]` 没指向 `lib/client.js`、或 `dsh.client.platform` 不是 `web` |
| 卡片不出现但无报错 | `ctx.slots.inject('settings.section')` 的回调没跑（宿主没有该槽）、或 `dsh-client-ui-settings` 没在 `dsh.client.inject` 里 |
| 模型选择器空 | `profile.piProvider` 缺失、或 `getModels()` 抛错、或 `resolveApiKey` 抛 `MISSING_CREDENTIAL`（此时 `listModels` 故意返回空） |

---

## 10. 验证记录（2026-11-14，本机实测）

### 10.1 依赖可拉取性（npmmirror）

```
dsh-llm/0.2.2-rc.1                 200
dsh-llm-pi-ai/0.2.2-rc.1          200
dsh-settings/0.2.2-rc.1           200
dsh-host-webserver/0.2.2-rc.1     200
dsh-credentials/0.2.2-rc.1        200
dsh-client-ui-settings/0.2.2-rc.1 200
dsh-client-ui-settings-plugins/0.2.2-rc.1 200
dsh-client-ui-slots/0.2.2-rc.1    200
dsh-client-ui-primitives/0.2.2-rc.1 200
dsh-client-locale/0.2.2-rc.1      200
cordis/4.1.0                      200
schemastery/3.19.0                200
pi-ai/1.3.0                       200
```

`pnpm install` 首次会因 pi-ai 的传递依赖（`@google/genai`、`protobufjs`）的 postinstall 被 pnpm 12 判为 `ERR_PNPM_IGNORED_BUILDS`。本仓库用 `pnpm-workspace.yaml` 的 `allowBuilds` 显式拒绝这两个脚本（不执行、也不让安装失败），随后 `pnpm install` 退出码 0。

### 10.2 命令与退出码

| 命令 | 退出码 | 说明 |
|---|---|---|
| `pnpm install` | 0 | 依赖从 npmmirror 落地；store/cache 在仓库内（`.pnpm-store/`、`.pnpm-cache/`，已 gitignore） |
| `pnpm typecheck` | 0 | `tsc -p tsconfig.json && tsc -p tsconfig.client.json` |
| `pnpm build` | 0 | `tsdown` 双配置；无警告 |
| `pnpm test` | 0 | `node --test`，2 个用例全过 |
| `pnpm check` | 0 | typecheck + build + test 一条龙（最终验收命令） |
| 文档片段编译检查 | 0 | `.snippet-check/` 临时目录（已删除）：host 片段（provider/profile/adapter/prepareHeaders/webServer 路由）与 client 片段（slots 卡片/locale/primitives）各自 `tsc --noEmit` 通过 |

### 10.3 产物

```
lib/index.js         # host 入口（ESM，import '@deepseek-ai/schemastery'）
lib/index.d.ts       # types
lib/index.js.map
lib/client.js        # window.__ModuleLoader__.load({ id: "dsh-connect-desktop", ... })
lib/client.js.map
```

`lib/client.js` 头部实测：

```js
window.__ModuleLoader__.load({
	id: "dsh-connect-desktop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```

`lib/index.js` 的导出行实测（位于 chunks 末尾、sourcemap 注释之前）：

```js
export { Config, apply, inject, name };
```

### 10.4 已知限制

- 本次会话运行在 DSH 文件沙箱（workspace-write）下，**无法写 `~/.dsh`**：`dsh --profile web --help` 在准备 profile 时要写 `~/.dsh/profiles/web/cordis.yml`，被沙箱拒绝（EPERM）。因此 §9 的挂载步骤是**按 CLI 契约给出、未在本会话实跑**；组合校验与启动检查需要在一个允许写 `~/.dsh` 的终端里执行。
- 宿主安装目录里**没有** `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-store` 的 `.d.ts`（客户端包以运行时 bundle 形式随页面分发；`dsh-client-ui-renderer` 虽在安装目录，但它的类型依赖缺失的 `dsh-client-ui-slots`，单独也编不过），所以客户端类型只能从 npm 拉；这也是 `.npmrc` 固定 npmmirror 的原因之一。
- `docs/dsh-plugin-contract.md` 中引用的 workbuddy 行号来自本机 `5.23.0` 的安装产物；该包升级后行号会漂移，但小节标题与函数名稳定。

---

## 11. 附：本仓库文件清单（骨架交付）

```
$REPO
├── package.json            # name/version/license/engines/dsh.bundle/dsh.client/peer+dev deps/scripts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml     # allowBuilds：拒绝 @google/genai、protobufjs 的 postinstall
├── .npmrc                  # npmmirror + 仓库内 store/cache
├── .gitignore              # .refs/ node_modules/ lib/ .pnpm-store/ .pnpm-cache/
├── tsconfig.json           # host：ES2023 + node types，不含 DOM
├── tsconfig.client.json    # client：DOM + JSX + resolveJsonModule
├── tsdown.config.ts        # 双入口：ESM host + CJS client（loader wrapper）
├── cordis.patch.yml        # insert dsh-connect-desktop
├── locale/{en,zh}.json     # 包元数据（插件市场）
├── src/index.ts            # host apply（name/inject/Config，暂无业务）
├── src/client/index.ts     # browser apply（注册 locale，暂无卡片）
├── src/client/locale.ts    # settings.dsh-connect-desktop 词典 + LocaleNamespaceMap 增强
├── tests/smoke.test.mjs    # host 契约 + client bundle 形状/注册断言
├── docs/dsh-plugin-contract.md
├── README.md               # 快速开始 + 挂载步骤
└── LICENSE                 # MIT
```

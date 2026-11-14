# Loomy 上游契约（只读取证 / dsh-connect-loomy）

> 取证环境：macOS（Darwin），Loomy.app **0.9.39**（bundle id `com.loomy.desktop`），上游网关
> `https://loomyad.xunfei.cn/api/v1`，取证时间 **2026-11-14 19:37–19:55 +08**，Node 22 + curl（HTTP/2）。
> 取证方式：**只用本机已登录的 Loomy 登录态发只读请求**，对照客户端解包源码
> `/Applications/Loomy.app/Contents/Resources/app.asar.unpacked/electron/` 与渲染层
> `app.asar` 内的压缩 bundle。未改账号、未改客户端配置、未重启 Loomy/DSH。
>
> **本文件不记录任何真实凭据。** 所有样本中的 `session` / `userid` / `phone` / `trace_id` /
> `chatId` / `msgId` / `ledgerId` 均已替换为占位符（`<SESSION>`、`<TRACE_ID>` 等）。
>
> 证据强度标记：`[实测]` = 本次真实请求命中；`[源码]` = 客户端源码/压缩 bundle 静态取证；
> `[推断]` = 由前两者推导、未直接验证。未实测项见 §9。

---

## 0. 速查（实现前必须知道的 6 件事）

1. **平台接口失败也是 HTTP 200**：`/models`、`/points/records`、`/user/identity` 用
   `token:` 头鉴权，失败返回 `{"code":"100002",...}` 而非 4xx；**不能按 HTTP status 判错**。`[实测]`
2. **两套鉴权互不通用**：平台接口只认 `token: <session>`；`/chat/completions` 只认
   `Authorization: Bearer <session>`（缺 Bearer 前缀会得到 `100002 缺少 token`）。`[实测]`
3. **未知模型静默回落**：请求体里写任何不存在的 `model`（含空串/缺字段/大小写不符），上游
   **200 且改跑默认模型 `spark-x2.6`**，`points_consumed: 0`。只有图片模型会 404。`[实测]`
4. **推理链吃 `max_tokens`**：非流式 `content:""` + `finish_reason:"length"` 是**合法**的长度截断
   （token 全花在 `reasoning_content` 上），不是空响应。`[实测]`
5. **流式末帧有独立 usage 帧**：`choices: []`，`usage.points_consumed` 是 Loomy 平台积分字段
   （非 OpenAI 标准），解析器不能把 `choices[0]` 当必需。`[实测]`
6. **追踪头当前都不是硬性要求**：`traceparent`/`chatid`/`msgid`/`loomy-version`/`invokeorigin`
   缺失或乱填，本次实测全部 200（含流式、长回答）。但客户端源码注释称缺 `traceparent` 会挂死
   （旧结论），建议照旧发送（零成本保险）。`[实测][源码]`

---

## 1. 登录态

### 1.1 文件与字段

| 项 | 取值 |
| --- | --- |
| 路径（macOS） | `~/Library/Application Support/loomy/auth-session.json` |
| 写入者 | Electron 主进程 `electron-store`（`electron/auth/auth-session-runtime.js`） |
| 格式 | 明文 JSON（非加密），文件权限 `-rw-r--r--`（同机其他用户可读，注意不要落日志） |
| 读取时机 | 客户端启动 `restore()`；`update()` 在登录/换号时重写；`clear()` 清空 |

```json
{
  "session": "<SESSION 32 位 hex>",
  "userid": "<USERID 18 位数字>",
  "phone": "<PHONE 11 位数字>",
  "updatedAt": 1794571196571
}
```

| 字段 | 语义 | 证据 |
| --- | --- | --- |
| `session` | 32 位 hex 字符串；平台接口填 `token` 头，对话填 `Authorization: Bearer` | `[实测]` |
| `userid` | 18 位数字用户 id；仅本地标识，请求头不发送 | `[实测][源码]` |
| `phone` | 11 位手机号（PII）；插件**禁止**展示/写日志 | `[实测]` |
| `updatedAt` | **毫秒**级 epoch（13 位）。语义 = “凭据最后一次变更时间”，**不是**过期时间/续期心跳 | `[实测]`：`1794571196571` ↔ 文件 mtime 19:59 +08 精确对应；`[源码]`：`auth-session-controller.js#update()` 仅在 `credentialsChanged \|\| phoneChanged` 时写 store |

> 读取建议：插件按 5s TTL 重读（客户端换号会重写文件，但不会通知外部进程）；文件缺失/JSON
> 解析失败时降级为“未登录”，不要抛错误弹窗。`updatedAt` 只可用于展示“登录时间”，不可用于
> 判断有效性——有效性只能靠上游响应。

### 1.2 会话失效的上游响应（重点）

**不存在 401。** 本次用伪造 session 实测，三条链路全部是 **HTTP 200 + 业务码**：

| 场景 | HTTP | 响应体 | `[实测]` |
| --- | --- | --- | --- |
| 不带头 / 空 token | 200 | `{"code":"100002","desc":"缺少 token","trace_id":"<TRACE_ID>","data":{}}` | ✔ |
| `Authorization: Bearer` 打平台接口 | 200 | 同上（“缺少 token”，因为它只找 `token` 头） | ✔ |
| 无效/过期 session（平台接口） | 200 | `{"code":"100002","desc":"登录已失效，请重新登录",...}` | ✔ |
| 无效/过期 session（`/chat/completions`，流式与非流式） | 200 | `{"code":"100002","desc":"登录已失效，请重新登录",...}`，`content-type: application/json`（不是 SSE） | ✔ |

`100002` 的两种 `desc` 可区分“没带 token”与“token 失效”，但**无法**区分“伪造”与“自然过期”。
客户端 `opencode/event-router.js` 里仍保留 `statusCode === 401` 的失效自愈分支，属历史/防御性
代码，当前网关不会触发。

**处置**：适配器把「HTTP 200 + body.code==='100002'」映射为 `session_dead`；把「HTTP 200 +
body.code==='000000'」当成功；其它 `code` 按业务错误。详见 §6 错误方言。

### 1.3 多账号池可行性

- 客户端只有**一份**登录态：`auth-session.json` 单文件、单 session；无账号列表、无切换 UI，
  只有 `logout`（`preload.js#xfyun:account:logout` → `POST /login/account/logout`）。`[源码]`
- 本机扫描 `~/Library/Application Support` 只找到两个候选：`loomy/auth-session.json`（本文对象）
  与 `Vibe助手/auth-session.json`（**另一个产品**、内容为 `{encrypted:true,data:"v1..."}` 加密体，
  与 Loomy 网关无关）。`[实测]`
- **结论**：从单机单客户端拿不到多账号；多账号池需要多份 userData（多 OS 用户/多安装实例）或
  自行实现登录，超出“核心可用版”范围。插件按**单账号**设计即可。

---

## 2. 端点表

Base URL（对话与平台接口共用）：`https://loomyad.xunfei.cn/api/v1`
（来自 `~/.config/loomy-opencode/opencode.json` 的 `provider.imodel.options.baseURL`；`[源码]`）

| # | 用途 | 方法 / 路径 | 鉴权头 | 实测 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | 模型目录 | `GET /models` | `token: <session>` | 200 | 10 条；无分页/无缓存头 |
| 2 | 积分摘要 + 流水（v1） | `GET /points/records?pageNo=&pageSize=&recordType=` | `token` | 200 | 含三桶余额；`recordType=all\|earned\|consumed` |
| 3 | 积分流水（v2 聚合） | `GET https://loomyad.xunfei.cn/api/v2/points/records?pageNo=&pageSize=&direction=&granularity=`（注意是 `/api/v2`，与 `/api/v1` 平级） | `token` | 200 | 聚合视图，**无** `availableBalance`；`granularity=turn&direction=debit` 现返回 100001 |
| 4 | 团队积分余额 | `GET /team-points/balance`（= `/api/v1/team-points/balance`） | `token` | 未测 | `[源码]`：客户端把 `currentBalance` 归一成 `balance`；团队账号才用 |
| 5 | 团队流水（v2） | `GET https://loomyad.xunfei.cn/api/v2/team-points/records` | `token` | 未测 | `[源码]` |
| 6 | 用户身份 | `GET /user/identity` | `token` | 200 | `isInternal` / `teams` / `currentTeamId` |
| 7 | 对话 | `POST /chat/completions` | `Authorization: Bearer <session>` | 200 | OpenAI 兼容（chat + SSE） |
| 8 | 图片生成 | （生图链路，本文不覆盖） | Bearer | 未测 | 本插件只接 chat，见 §8 模型过滤 |
| 9 | 登录/登出/绑定 | `/login/*`、`/userinfo/*`、`/register/*` | 各自签名/会话 | 未测 | 插件**不得**调用（会动账号） |

平台接口的默认 points base 在客户端里另有配置：`points-config.json` 默认
`https://ossptest.voicecloud.cn/loomy/integration`（测试域）。**生产 session 打测试域会得到
`100002 登录已失效`**（`[实测]`）。插件应统一使用 `loomyad.xunfei.cn/api/v1`，不要读客户端的
points 配置。

---

## 3. 平台接口详解

### 3.1 `GET /api/v1/models`

请求头：`token: <session>`（**不是** Bearer）。无查询参数意义（传 `pageNo/pageSize` 被忽略，`[实测]`）。

响应头（`[实测]`）：`HTTP/2 200`、`server: nginx`、`content-type: application/json; charset=utf-8`；
**没有** `Cache-Control` / `ETag` / `Last-Modified` / 分页头。请在插件侧做内存缓存（10 分钟级）。

响应体（脱敏，字段全保留；本次实测 10 条）：

```json
{
  "reasoning_enabled": true,
  "reasoning_catalog_version": "sha256:<HASH>",
  "object": "list",
  "data": [
    {
      "reasoning_efforts": ["none", "low", "medium", "high", "xhigh"],
      "default_reasoning_effort": "low",
      "id": "spark-x2.6",
      "name": "Spark-X2.6 正式版(限时免费)(x0.0)",
      "object": "model",
      "created": 1792460565,
      "owned_by": "loomy",
      "type": "chat",
      "protocol": "openai_chat",
      "context_length": 1048576,
      "max_output_tokens": 131072,
      "capabilities": {
        "reasoning": true, "vision": false, "function_calling": true, "streaming": true,
        "system_message": true, "input_modalities": ["text"], "output_modalities": ["text"]
      },
      "is_default_model": true,
      "is_default_small_model": true
    }
  ]
}
```

实测目录（2026-11-14，10 条；名称里的 `(xN.N)` 是积分倍率，`(限时免费)` = x0.0）：

| id | type | context_length | max_output_tokens | vision | function_calling | input_modalities | reasoning_efforts | 倍率/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spark-x2.6` | chat | 1048576 | 131072 | false | true | text | none/low/medium/high/xhigh | x0.0；**default_model + default_small_model** |
| `DeepSeek-V4.1-Flash` | chat | 1048576 | 384000 | true | true | text,image | 同上 | x2.0 |
| `deepseek-v4-flash-1017` | chat | 1048576 | 384000 | true | true | text,image | 同上 | x2.0 |
| `GLM-5.3-Flash` | chat | 1048576 | 131072 | true | true | text,image,video | 同上 | x0.8 |
| `qwen3.8-flash` | chat | 1000000 | 131072 | true | true | text,image,video | 同上 | x0.8 |
| `mimo-v2.5` | chat | 1024000 | 128000 | true | true | text,audio,image,video | 同上 | x3.3 |
| `auto` | chat | — | — | — | — | — | — | **无 capabilities/limit**；实测路由到 GLM-5.3-Flash 且**扣分** |
| `Hy-Image-3.5-preview` | image | 100000 | — | true | false | text,image | — | output_modalities=["image"] |
| `doubao-seedream-5-lite` | image | 128000 | 131072 | true | false | text,image | — | 输出图片 |
| `qwen-image-3.0-pro` | image | — | — | true | false | text,image | — | 输出图片 |

> 与 `.refs/RECON.md` 的偏差：图片模型**有** `capabilities` 字段（`[实测]`），不能靠“无
> capabilities”过滤；应收敛为 **`type === "chat"` 且 `capabilities.output_modalities` 含
> `"text"`**，并单独处理 `id === "auto"`（建议排除，理由见 §8）。

失败形态（全部 HTTP 200，`[实测]`）：

```json
{"code":"100002","desc":"缺少 token","trace_id":"<TRACE_ID>","data":{}}
{"code":"100002","desc":"登录已失效，请重新登录","trace_id":"<TRACE_ID>","data":{}}
```

客户端如何用这个接口（`[源码]` `electron/model-service.js#fetchModelsFromProvider`）：
`token` 头、10s 超时、只认 `data.data[]`；拿到后按 `capabilities` 归一成 opencode 的
`modalities` / `limit` / `reasoning` / `tool_call` / `attachment`，再写入 `opencode.json` 的
`provider.imodel.models`（这也是本机该文件里 10 个模型的来源）。

### 3.2 `GET /api/v1/points/records`（v1，推荐给只读积分卡）

查询参数（`[源码]` + `[实测]`）：

| 参数 | 取值 | 行为 |
| --- | --- | --- |
| `recordType` | `all`（默认） / `earned` / `consumed` | 其它值 → `100001 请求参数错误`；缺省=all |
| `pageNo` | ≥1 整数 | 缺省 1；`0`/负数/非数字 → 归一为 1 |
| `pageSize` | 1–100 | 缺省 20；`0`/非数字 → 20；>100 → **服务端夹到 100** |

响应（脱敏；金额为真实结构的占位值）：

```json
{
  "code": "000000",
  "desc": "成功",
  "trace_id": "<TRACE_ID>",
  "data": {
    "balance": 35500,
    "dailyBalance": 5000,
    "availableBalance": 40500,
    "pageNo": 1,
    "pageSize": 3,
    "total": 8,
    "list": [
      {
        "ledgerId": "<LEDGER_ID>",
        "modelName": "",
        "direction": "credit",
        "description": "邀请好友奖励",
        "createdAt": 1794574693,
        "pointsActual": 5000,
        "consumeSource": "",
        "balanceBefore": 35500,
        "balanceAfter": 40500,
        "dailyCycleDate": "2026-11-13"
      }
    ]
  }
}
```

扣分流水样本（`[实测]`：GLM 调用后出现 4 条 `direction=debit`）：

```json
{
  "ledgerId": "<LEDGER_ID>",
  "modelName": "GLM-5.3-Flash",
  "direction": "debit",
  "description": "模型调用扣分",
  "createdAt": 1794656588,
  "pointsActual": 1,
  "consumeSource": "daily",
  "balanceBefore": 40498,
  "balanceAfter": 40497,
  "dailyCycleDate": "2026-11-14"
}
```

字段语义（**三桶模型**，有扣分前后对比证据 `[实测]`）：

| 字段 | 语义 | 关键证据 |
| --- | --- | --- |
| `balance` | 长期/永久积分余额（充值、邀请、任务奖励入这里） | 4 次调用扣分期间恒为 35500；`balanceBefore/After` 却是 `availableBalance` 口径 |
| `dailyBalance` | 当日免费/赠送额度的**剩余**（每日重置） | 5000 → 4997（扣 3 分后），与 `consumeSource:"daily"` 对应 |
| `availableBalance` | 可用总额 = `balance + dailyBalance` | 40500 = 35500 + 5000；扣 3 分后 40497 = 35500 + 4997 |
| `total` | 满足 `recordType` 的记录总数（跨页） | `all` 8→12、`earned` 8、`consumed` 4（累计 4 次付费调用） |
| `dailyCycleDate` | 该笔流水所属的**业务日**（客户端时区日期，`YYYY-MM-DD`） | 昨日奖励标 `2026-11-13`，当日扣分标 `2026-11-14` |
| `createdAt` | 秒级 epoch（10 位） | 与 `dailyCycleDate` 同日 |
| `pointsActual` | 该笔流水变动值（正数；方向看 `direction`） | 奖 +5000 / 扣 -1 均存正数 |
| `consumeSource` | 扣分来源桶：`"daily"` = 日额度；奖励行为空串 | 4 条扣分全为 `daily`（日额度优先扣） |
| `balanceBefore/After` | 变动前后的**可用总额**（含日额度） | 40499 → 40498，与 `availableBalance` 对齐 |
| `modelName` | 扣分调用所用模型；非模型流水为空串 | GLM-5.3-Flash |

> 注意：`balance` / `dailyBalance` / `availableBalance` 是**同一响应里冗余返回的三桶快照**，
> 不是某条流水字段。只读卡片请直接用这三个顶层字段，不要自己从 `list` 累加（`list` 只含当页）。

### 3.3 `GET /api/v2/points/records`（聚合视图，**不建议**用于卡片）

- 与 v1 的差异（`[实测]`）：`data` 里**没有** `availableBalance`；条目为聚合行
  （`recordKind` / `chatId` / `firstCreatedAt` / `lastCreatedAt` / `points` / `source`），无
  `balanceBefore/After`、无 `dailyCycleDate`。
- 参数：`direction=debit|credit`（其它 → `100001`）；`granularity=chat|msg|purpose|turn`。
  **`granularity=turn&direction=debit` 当前返回 `100001`**（`turn&credit` 200），客户端
  `normalizeGranularity` 认为 turn 合法，服务端 v2 实现与之不一致（`[实测]`）。
- 样本（chat 聚合，注意 `chatId` 就是请求头 `chatid`，可用于把扣分归到会话）：

```json
{
  "code": "000000",
  "desc": "成功",
  "trace_id": "<TRACE_ID>",
  "data": {
    "balance": 35500, "dailyBalance": 4997, "pageNo": 1, "pageSize": 5, "total": 3,
    "list": [
      {"recordKind":"chat_aggregate","chatId":"<CHAT_ID>","direction":"debit",
       "firstCreatedAt":1794656588,"lastCreatedAt":1794656588,"createdAt":1794656588,"points":1}
    ]
  }
}
```

- 样本（v1 单条流水在 v2 的形态，`direction=credit`）：

```json
{"ledgerId":"<LEDGER_ID>","description":"邀请好友奖励","direction":"credit",
 "createdAt":1794574693,"points":5000,"source":"invite"}
```

### 3.4 `GET /api/v1/user/identity`

```json
{
  "code": "000000",
  "desc": "成功",
  "trace_id": "<TRACE_ID>",
  "data": { "isInternal": false, "currentTeamId": "", "teams": [] }
}
```

| 字段 | 语义 | 证据 |
| --- | --- | --- |
| `isInternal` | 是否讯飞内部员工（客户端用它开启内部工具链，如 Lark CLI MCP / 内部额度策略） | `[源码]` 渲染层：`isInternal && applyLarkCliMcp()` |
| `teams` | 所属团队数组；本账号为空数组（元素结构未实测） | `[实测][源码]`（渲染层仅做 `Array.isArray` 兜底） |
| `currentTeamId` | 当前“以团队身份使用”的团队 id；`""` = 个人身份 | `[源码]`：非空时扣分走团队桶并显示团队错误文案 |

> 只读积分卡不必要调用 identity；若展示“个人/团队”标签，建议在 identity 已缓存时顺带显示，
> 拿不到就隐藏，不要为此阻塞。

---

## 4. 对话接口 `POST /api/v1/chat/completions`

### 4.1 请求头

| 头 | 取值 / 语义 | 是否强制 | 证据 |
| --- | --- | --- | --- |
| `Authorization` | **`Bearer <session>`**（必须带 `Bearer ` 前缀；裸 session → `100002 缺少 token`） | **是** | `[实测]` |
| `Content-Type` | `application/json` | 是 | `[实测]` |
| `loomy-version` | 客户端版本，本机 `0.9.39`（`app.getVersion()`，回退 `Resources/app.asar.unpacked/package.json` 的 `version`） | 否 | `[实测]`：`0.1.0`/`1.0.0`/`2.5.0`/空值都 200；`[源码]` `utils/app-version.js` |
| `invokeorigin` | `user` = 用户主动；`system` = 后台子调用（标题/记忆等） | 否 | `[实测]`：`robot` 也 200；`[源码]` `utils/request-headers.js#normalizeInvokeOrigin` |
| `traceparent` | W3C 形态 `00-<32hex>-<16hex>-01`，客户端每次生成 | 否（见怪癖 Q13） | `[实测]`：缺失/畸形/全零均 200 |
| `chatid` | `chat-<uuid>`，**会话级**；同一会话的所有请求相同 | 否 | `[源码]` 渲染层 `createChatId()`；`[实测]` 任意字符串（含空/300 字符）都 200 |
| `msgid` | `msg-<uuid>`，**用户消息级**；一轮一条，同轮重试/收尾复用 | 否 | `[源码]` 渲染层 `createMsgId()`；`turnId` 与 `msgid` 同值 |
| `TurnId`（可选） | 与 chatid/msgid 同套裸驼峰；客户端 `turnId = msgId`，服务端用于轮次结算 | 否 | `[源码]` `request-headers.js`、`stream-coordinator.js` |
| `X-Loomy-Request-Purpose` | 17 个用途枚举之一（`chat.message`、`kb.vision`、`memory.extract`…）；**只作业务声明，扣不扣分由服务端裁决** | 否 | `[源码]` `utils/request-purpose.js`；`[实测]` `chat.message` 与乱值都 200 |
| `x-session-affinity` | **0.9.39 已不存在**（全源码 grep 无命中）；旧文档说法过时 | — | `[源码]` |

> 头名大小写不敏感：客户端发 `ChatId`/`MsgId`/`TurnId`/`InvokeOrigin` 驼峰，本次实测小写
> `chatid`/`msgid`/`invokeorigin` 同样生效。

### 4.2 最小请求体与响应

最小可用（`[实测]`，`stream` 与 `max_tokens` 都可省，但**不建议**省 `max_tokens`）：

```json
{
  "model": "spark-x2.6",
  "max_tokens": 64,
  "stream": false,
  "messages": [{ "role": "user", "content": "用一句话确认你收到了请求" }]
}
```

非流式响应（`reasoning-only` 长度截断的真实样本，`[实测]`）：

```json
{
  "id": "cht000d16c0@dx1a1d9db8ab42881503",
  "object": "chat.completion",
  "created": 1794656408,
  "model": "spark-x2.6",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "",
      "reasoning_content": "用户需要我用一句话确认收到了请求……"
    },
    "finish_reason": "length"
  }],
  "usage": {
    "prompt_tokens": 26,
    "completion_tokens": 64,
    "total_tokens": 90,
    "completion_tokens_details": { "reasoning_tokens": 63 },
    "points_consumed": 0
  }
}
```

要点：

- `message.content` 与 `message.reasoning_content` 并存；**`content` 可能为空串**，只要
  `finish_reason` 是 `length` 即为合法截断（见 Q5）。
- `usage.points_consumed` 是 Loomy 平台积分（整数），免费模型为 `0`；非 OpenAI 标准字段。
- `usage.prompt_tokens_details` 并不总出现（spark 无、GLM 为 `{}`），不要依赖
  `cached_tokens`。
- `model` 可能与请求不一致（`auto` → `GLM-5.3-Flash`；未知模型 → `spark-x2.6`）。
- 响应头：`HTTP/2 200`、`content-type: application/json; charset=utf-8`、`content-length`。

### 4.3 流式（SSE）

请求加 `"stream": true`（`stream_options.include_usage` **不是必需**——0.9.39 网关无论是否传
都会在末帧给 `usage`，`[实测]`；传 `stream_options` 而 `stream:false` 会 400）。

响应头：`content-type: text/event-stream`、`cache-control: no-cache`，无 `event:`/`id:` 行、
无心跳注释；帧间空行分隔，纯 `data:` 行，末帧 `data: [DONE]`。

帧序列（`[实测]` 27 帧样本：1 role + 22 reasoning + 1 content + 1 finish + 1 usage + 1 DONE）：

```
data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"spark-x2.6","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"reasoning_content":"用户"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"content":"你好世界"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {...,"choices":[],"usage":{"prompt_tokens":25,"completion_tokens":58,"total_tokens":83,"completion_tokens_details":{"reasoning_tokens":54},"points_consumed":0}}

data: [DONE]
```

解析要求：

- `delta` 可能是 `{role}` / `{reasoning_content}` / `{content}` / `{tool_calls}` / `{}`；
- `usage` 帧 `choices` 为空数组，**不要**访问 `choices[0]`；
- `content` 帧可能一次给一整句（本样本一帧一整句），也可能是逐字；不要假设粒度；
- `finish_reason` 实测出现 `stop`、`length`、`tool_calls`；`content_filter` 未观测到；
- 帧内 `model` 以帧内为准，不做一致性校验。

### 4.4 reasoning / reasoning_effort

- 线字段名是 **`reasoning_effort`**（`[源码]` `model-metadata.js` 注释：“OpenCode 原生模型
  options；OpenAI 兼容 SDK 映射为 `reasoning_effort`”；`[实测]` 传了不报错）。
- 合法值来自 `/models` 的 `reasoning_efforts`：`none|low|medium|high|xhigh`；**乱值不报错**
  （被忽略或回落默认）。`default_reasoning_effort = low`。
- 实测 `spark-x2.6` 在 `none` 下**仍会产生** reasoning token（33~58 tok，波动大），即“关思考”
  在该模型上不可强依赖；客户端另有 `/no_think` 前缀 + `enable_thinking:false` +
  `chat_template_kwargs.enable_thinking=false` 三重软关（`[源码]` `llm/llm-completion.js`），
  是否对上游生效未逐项验证。
- 非流式同样把 `max_tokens` 花在 reasoning 上：`completion_tokens_details.reasoning_tokens`
  可能等于 `completion_tokens`。

### 4.5 工具调用

`tools` / `tool_choice` 为 OpenAI 标准结构，**实测可触发**：

非流式（`tool_choice` 硬绑函数）：

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "",
      "reasoning_content": "用户想了解北京的天气情况……",
      "tool_calls": [{
        "index": 0,
        "id": "call_<CALL_ID>",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"北京\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

流式（`tool_choice: "auto"`）分片形态（`[实测]`）：首帧带 `id`/`name`、`arguments: ""`；
后续帧 `id: ""`，`arguments` 逐段拼接；末帧 `finish_reason:"tool_calls"`；随后 usage 帧 + `[DONE]`。

```json
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_<CALL_ID>","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"function","function":{"name":"","arguments":"{\"city\":\""}}]},"finish_reason":null}]}
```

### 4.6 视觉输入（image）

**结论：只支持 `image_url` + `data:` URL（base64）**；远程 http(s) 图片 URL 不可用。

- 请求形态（`[源码]` `electron/knowledge/kb-vision.js` 与本次实测一致）：

```json
{
  "model": "GLM-5.3-Flash",
  "max_tokens": 256,
  "stream": false,
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "这张图是什么颜色？只回答颜色" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,<BASE64>" } }
    ]
  }]
}
```

- 实测结果：
  - `GLM-5.3-Flash` + 1×1 PNG data URL → 200，`content:"红色"`，`points_consumed: 1`；
  - 同请求改远程 URL → 网关耗时 **~92s** 后 400，`metadata.provider_name: "baidu-qianfan"`
    （网关把图转给第三方时失败）；
  - `spark-x2.6`（`vision:false`）+ 图片 part → **400** 通用错误（不降级、不提示 vision 不支持）；
  - 把 base64 直接塞进文本 → 200，但模型只是“读字符串”，没有真正看图。
- 处置：适配器遇到 `http(s)` 图片必须先自行下载并转 `data:` URL（客户端上限 10MB，
  `[源码]` `opencode-service.js#filePathToDataUrlCapped(..., 10MB)`），否则会白等 90s 再失败。

### 4.7 `max_tokens` 与限制

| 场景 | 行为 | `[实测]` |
| --- | --- | --- |
| 省略 `max_tokens` | 200，按服务端默认（可生成到 371 tok 仍 stop） | ✔ |
| `max_tokens: 1` | 200，`finish_reason: "length"`，`content:""`，全花在 reasoning | ✔ |
| `max_tokens: 0` / `-1` | **HTTP 400** `invalid_request_error` | ✔ |
| `max_tokens: 999999`（> 模型 131072） | 200，不报错（未证明被夹到上限，但未出现异常） | ✔ |
| 模型上下文 | `context_length` 从 `/models` 取；超上下文错误形态未实测 | — |

> 建议：始终显式下发 `max_tokens`（取 `max_output_tokens`，允许配置收紧），避免默认值导致
> 超长输出与额外积分。

---

## 5. 失败语义与错误码表

### 5.1 三种错误方言（必须分开解析）

**方言 A：平台 envelope（HTTP 200）** —— `/models`、`/points/*`、`/user/identity`、以及
`/chat/completions` 的**鉴权失败**：

```json
{"code":"100001","desc":"请求参数错误","trace_id":"<TRACE_ID>","data":{}}
{"code":"100002","desc":"登录已失效，请重新登录","trace_id":"<TRACE_ID>","data":{}}
```

**方言 B：OpenAI 风格错误（真实 HTTP 状态码）** —— `/chat/completions` 的业务/上游失败：

```json
{"error":{"message":"messages 不能为空","type":"invalid_request_error","param":"messages","code":400,"metadata":{"provider_name":"loomy"}}}
{"error":{"message":"请求有误，请重试；若多次出现请更新应用版本","type":"invalid_request_error","param":null,"code":400,"metadata":{"provider_name":"iflytek-spark-loomy"}}}
{"error":{"message":"该模型暂未开放，请切换其他模型","type":"not_found_error","param":null,"code":404,"metadata":{"provider_name":"loomy"}}}
```

**方言 C：网关裸响应** —— 路径写错等：`HTTP 404` + 纯文本 `404 page not found`（非 JSON）。

> `metadata.provider_name` 是很好的定位器：`loomy` = 网关本地校验（快速，50–160ms）；
> `iflytek-spark-loomy` / `baidu-qianfan` = 上游供应商错误（慢，秒级~分钟级）。

### 5.2 业务码表

| code | 语义 | 实测/来源 | 建议映射 |
| --- | --- | --- | --- |
| `000000` | 成功 | `[实测]` | 成功 |
| `100001` | 参数错误（也用于接口内语义校验，如非法 `recordType`、`granularity=turn&direction=debit`） | `[实测]` | `bad_request` |
| `100002` | 缺少/无效 session（`desc` 区分“缺少 token” vs “登录已失效”） | `[实测]` | `session_dead` |
| `100003` | 无权限（分享域，`[源码]` `share-buddy-service.js`） | `[源码]` | `forbidden` |
| `100005` | 限流（分享域映射；对话路径未实测到） | `[源码]` | `rate_limit` |
| `100006` | 载荷过大 | `[源码]` | `bad_request` |
| `200013`/`200014`（分享域另一处为 `200015`/`200016`/`200017`） | 未找到 / 过期 / 配额超限 | `[源码]` | `unavailable` / `expired` / `quota` |
| `900000` | 服务端错误 | `[源码]` | `unknown/5xx` |

> 上表 100003/100005/100006/2xxxxx/900000 来自客户端分享模块的业务码映射，**未在对话/积木
> 接口逐条实测**；对话链路日常只会遇到 100001/100002 与方言 B 的 HTTP 400/404。

### 5.3 HTTP 状态码与失败形态

| 状态 | 出现场景（实测） | 响应体 |
| --- | --- | --- |
| 200 | 绝大多数成功；**以及全部平台鉴权失败/业务失败** | envelope 或正常 JSON |
| 400 | `messages` 空/缺、非法 role、`max_tokens<=0`、`stream_options` 无 `stream`、vision 模型不匹配、远程图片 URL 失败 | 方言 B（`invalid_request_error`） |
| 404 | 图片模型当 chat 用（“该模型暂未开放”）；错误路径（纯文本） | 方言 B / 纯文本 |
| 429 | **未实测到**（20 并发免费模型无一条 429） | 未知；客户端按 429/100005 → rate-limited |
| 5xx | 未实测到 | 未知 |

### 5.4 内容策略拒绝

- 实测两条明显违规请求：**HTTP 200 + `finish_reason:"stop"` + 模型自然语言拒绝**，没有网关
  层错误、没有扣分。`[实测]`
- 客户端仍为“硬审核”留了文案映射（`[源码]` 渲染层）：错误 message 命中
  `/非法|违规|敏感|内容审核|content.?filter|moderation|blocked/i` → UI 显示
  “消息包含敏感内容，请修改后重试”。说明存在（或曾经存在）网关级内容审核错误，**未实测到**。
- 处置：把这类文本错误映射为 `content_policy`（非重试类）；模型级拒绝是正常 200 文本，不要
  当错误吞掉。

### 5.5 静默截断（`[DONE]` 无 `finish_reason`）

- 参考文档（`.refs/router-loomy/docs/loomy-upstream.md` §4、`MAX_TRUNCATION_RETRIES`）称上游
  会在生成中途发 `[DONE]` 而不给 `finish_reason`。本次 **3 段长回答（1370/437/1353 帧，
  2484/2003/4096 completion tokens）全部有 `finish_reason`（stop/stop/length）**，未复现。
- 处置：解析器仍应把“流结束但从未见过 `finish_reason`”视为截断（补 `length` 或报错），
  这是零成本防御；但**不要**因此无限重试（重试会重发上下文并再次扣分）。

### 5.6 只有 reasoning 的合法 `length`

- 实测 `max_tokens:1` 非流式：`content:""`、`reasoning_content` 非空、`finish_reason:"length"`、
  `points_consumed:0`。这是**合法**结果，适配器应把它当“长度截断的空回答”，而不是上游故障。
- 流式同理：只会出现 reasoning 帧 + `finish_reason:"length"` 帧，没有任何 content 帧。

---

## 6. 客户端运行时（版本 / 头 / 归属）

### 6.1 `loomy-version` 取什么

- 客户端：`app.getVersion()`（Electron，即 `Info.plist` 的 `CFBundleShortVersionString`），
  失败回退 `Resources/app.asar.unpacked/package.json` 的 `version`。本机两者都是 `0.9.39`。`[实测][源码]`
- 服务端不校验：`0.1.0`、`2.5.0`、空值均 200。插件可读 `Info.plist`（`plutil -extract
  CFBundleShortVersionString raw -o - /Applications/Loomy.app/Contents/Info.plist`）或
  `app.asar.unpacked/package.json`；读不到时用 `0.9.39` 兜底。`[实测]`

### 6.2 `invokeorigin`

- `user`（用户主动）/ `system`（标题生成、记忆提取等后台子调用）。客户端默认 `user`；
  子调用带 `x-parent-session-id` + `InvokeOrigin: system`（旧版头，本次源码里只有 `TurnId`/
  `InvokeOrigin` 裸驼峰）。
- 服务端不校验（`robot` 也 200）。插件一律 `user`。

### 6.3 `chatid` / `msgid` 作用域

| 头 | 作用域 | 生成规则（渲染层 bundle） | 备注 |
| --- | --- | --- | --- |
| `chatid` | **会话** | `createChatId() = \`chat-${crypto.randomUUID()}\``，新建会话时生成并持久化映射 | v2 积分聚合按它分组（实测 3 次调用 → 3 条 `chat_aggregate`） |
| `msgid` | **用户消息/轮次** | `createMsgId() = \`msg-${crypto.randomUUID()}\``，每轮新生成；`turnId = msgId` | 子代理继承祖先的 ChatId/TurnId，MsgId 另铸为 `<parentMsgId>-sub-<childSessionID>` |
| `TurnId` | 轮次结算 | 与 `msgId` 同值 | 缺失是常态（宠物/独立操作本就不带） |

- 服务端不校验格式：`abc`、空串、300 字符都 200；但**为了积分归属可读**，插件应生成规范
  `chat-<uuid>` / `msg-<uuid>`，并把 chatid 与 DSH session 稳定绑定（同 session 复用）。

### 6.4 `traceparent` 缺失的后果（与旧结论冲突）

- 客户端源码注释（`llm/llm-completion.js`）：“实测 Loomy iModel 缺 traceparent 时
  chat/completions 会挂死直到超时。” `.refs/router-loomy` 文档也写“缺失会挂死”。
- 本次实测（2026-11-14，网关同域）：非流式、流式、长回答（最长 59s / 4096 tok）在缺失/畸形/全零
  `traceparent` 下**全部 200 正常返回**（1.1s~18.7s）。**未复现挂死**。
- 推测：旧结论可能来自 0.9.36 时代网关或另一条链路（生图/识图/新会话首包）。处置：按 W3C
  生成并发送 `00-<32hex>-<16hex>-01`（客户端同款），成本为零；不要把它作为失败重试条件。

### 6.5 超时基线

- 客户端：opencode `options.timeout = 1200000ms`、`chunkTimeout = 1200000ms`；渲染层流式
  “无活动超时”也是 1200s（`[源码]` bundle `Zd=12e5`）。`[实测]` 长回答单次可达 ~59s（4096 tok）。
- 建议：连接/响应头超时 20–30s；流式空闲超时 ≥120s；整轮上限沿用宿主默认。

---

## 7. 怪癖清单与处置建议（按影响排序）

| # | 怪癖 | 证据 | 处置建议 |
| --- | --- | --- | --- |
| Q1 | 平台接口失败一律 HTTP 200 + envelope | `[实测]` | 解析 body `code`；HTTP 非 2xx 只当归类兜底 |
| Q2 | `token` 头与 `Bearer` 互不通用 | `[实测]` | 按端点分流，勿复用同一套头 |
| Q3 | **未知/空/缺 `model` 静默回落 `spark-x2.6`** | `[实测]` | 用 `/models` 白名单校验；UI 只提供目录内模型；不依赖上游报错 |
| Q4 | `auto` 无 capabilities/limit，实测路由 GLM 且扣分 | `[实测]` | 默认不暴露 `auto`；如要暴露需显式说明“自动路由、可能扣分” |
| Q5 | reasoning 吃 `max_tokens`，`content:""` + `length` 合法 | `[实测]` | 不把空 content 当失败；`length` 映射为截断；必要时放大 `max_tokens` |
| Q6 | usage 帧 `choices: []` | `[实测]` | SSE 解析对 choices 缺失/为空做保护 |
| Q7 | 不传 `stream_options.include_usage` 也有 usage 帧 | `[实测]` | 不要为了 usage 强加参数（但传了也无害） |
| Q8 | 响应 `model` 可能被改写 | `[实测]` | 以响应为准记录实际模型；不要用响应 model 反查成本 |
| Q9 | 远程图片 URL 失败（~92s→400），仅 data URL 可用 | `[实测]` | 统一转 base64 data URL（≤10MB），或明确报“不支持远程图” |
| Q10 | **失败的付费请求也可能扣分**（远程图 400 仍生成 1 分 debit） | `[实测]` | 积分卡按 ledger 读真值；不要假设“失败=不扣分” |
| Q11 | 三种错误方言混用 | `[实测]` | 先试 envelope，再试 `{error}`，最后纯文本 |
| Q12 | 400 文案是通用中文，靠 `provider_name`/耗时区分网关 vs 上游 | `[实测]` | 记诊断日志（不含凭据）时带 provider_name |
| Q13 | 追踪头当前均非强制；`traceparent` 挂死说法未复现 | `[实测][源码]` | 照客户端形态发送，但不做强制校验/重试依据 |
| Q14 | 静默截断未复现但历史存在 | `[实测][源码]` | 防御性：无 finish_reason → 截断；限次重试防扣分 |
| Q15 | `max_tokens` 0/负 → 400；缺省不报错 | `[实测]` | 显式下发正整数 `max_tokens` |
| Q16 | SSE 纯 `data:` 帧、无 event/id/heartbeat | `[实测]` | 按 `\n\n` 切帧、只认 `data:` 与 `[DONE]` |
| Q17 | 积分三桶：`balance` + `dailyBalance` = `availableBalance`；日额度先扣 | `[实测]` | 卡片同时展示三值；日切看 `dailyCycleDate` |
| Q18 | v2 `granularity=turn&direction=debit` → 100001 | `[实测]` | 只读卡片用 v1；v2 仅 chat/purpose/msg |
| Q19 | `/models` 无分页、无缓存头 | `[实测]` | 插件侧内存缓存 + TTL，失败时用上次成功快照 |
| Q20 | `updatedAt` 只在凭据变更时写，不是心跳 | `[源码][实测]` | 别拿它判过期；只在 UI 展示“登录于…” |
| Q21 | 单账号，无切换 | `[源码][实测]` | 不做多账号池 |
| Q22 | 0.9.39 无 `x-session-affinity` | `[源码]` | 不发；旧文档的该头可忽略 |
| Q23 | 客户端 points 默认域是测试环境 | `[源码][实测]` | 插件固定 `loomyad.xunfei.cn/api/v1` |
| Q24 | 错误路径是纯文本 404（非 JSON） | `[实测]` | JSON 解析失败时保留原文摘要（≤200 字） |
| Q25 | `stream_options` 无 `stream` → 400 | `[实测]` | 只在 `stream:true` 时附带 |
| Q26 | 长回答（>1k 帧）耗时 20–60s | `[实测]` | 流式超时别设太短（≥120s 空闲） |

---

## 8. 对 dsh-connect-loomy 的落地建议

### 8.1 模型注册

1. `GET /api/v1/models`（`token` 头）→ 过滤 **`type === "chat"`** 且 `capabilities.output_modalities`
   含 `"text"`；排除 `id === "auto"`（Q4）。
2. 映射到宿主 profile：
   - `id` → 模型 id；`name` → 名称（可直接用，含倍率与“限时免费”标签）；
   - `context_length` → `contextWindow`；`max_output_tokens` → `maxTokens`（同时作为请求
     `max_tokens` 的默认值/上限）；
   - `capabilities.vision && input_modalities.includes("image")` → 标记图片输入；
   - `reasoning_efforts` → `reasoningEfforts`；`default_reasoning_effort` → 默认档；
   - `capabilities.function_calling` → 工具调用能力。
3. 缓存 10 分钟；拉取失败时回退“上次成功快照”，再失败用内置兜底（至少 `spark-x2.6`），并在
   设置卡片提示“目录可能过期”。

### 8.2 请求构造

- 头：`Authorization: Bearer <session>`、`Content-Type: application/json`、
  `loomy-version: <检测到的版本|0.9.39>`、`invokeorigin: user`、`traceparent`（W3C 随机）、
  `chatid`（**DSH session 级稳定**，`chat-<uuid>`）、`msgid`（**每次请求新生成**，`msg-<uuid>`）、
  可选 `X-Loomy-Request-Purpose: chat.message`。
- 体：`{model, messages, max_tokens, stream: true, stream_options: {include_usage: true}, tools?, tool_choice?}`；
  `messages[].content` 支持字符串或 parts 数组；图片用 `image_url` + data URL。
- `reasoning_effort` 仅在用户选择思考档位时下发；不要假设 `none` 一定关掉思考（Q5/§4.4）。

### 8.3 响应/错误解析

- 先判 `content-type`：`text/event-stream` → SSE；`application/json` → 先试 envelope
  （有 `code` 字段）再试 OpenAI `{error}`。
- envelope `100002` → `session_dead`（提示“请先登录 Loomy 客户端”）；`100001` → `bad_request`；
  其它 → `unknown`。
- SSE：`delta.reasoning_content` → thinking；`delta.content` → text；`tool_calls` 按 `index` 合并；
  `usage` 帧取 `points_consumed`（可放 metadata）；`[DONE]` 收尾；无 `finish_reason` 视为截断。
- 非流式：`content` 为空且 `finish_reason==="length"` → 截断（合法），不要当空响应错误。

### 8.4 只读积分卡

- 数据源：`GET /points/records?pageNo=1&pageSize=1&recordType=all`（`token` 头）。
- 展示：`availableBalance`（可用总额）/ `dailyBalance`（今日额度剩余）/ `balance`（长期余额）；
  可选展示最近 5–20 条流水（`pageSize=20`）。`dailyCycleDate` 可标注“额度日切日期”。
- 禁用：`/api/v2/*`（无 `availableBalance`、turn 有 bug）、任何 `POST`（兑换/首次登录/宠物奖励）、
  `/login/*`。
- 刷新：打开卡片时拉一次 + 60s 缓存；失败静默降级为“积分暂不可用”，不阻塞模型使用。
- 隐私：绝不展示/记录 `phone`、`userid`、`session`、完整 `trace_id`。

### 8.5 安全与稳定性

- `auth-session.json` 是明文凭据：读取后只在内存持有；错误信息/日志里做 `[REDACTED]`；
  不要把 session 拼进 URL。
- 请求失败重试：只对网络层/5xx/429（如出现）做有限次指数退避；**业务 4xx 与内容策略不重试**。
- 长流式：空闲看门狗 ≥120s；用户取消要 Abort 上游连接（否则继续计费到服务端超时）。

---

## 9. 未实测项清单（后续可按 §10 方法补证）

| # | 未实测项 | 原因 | 补证方法 |
| --- | --- | --- | --- |
| U1 | 网关 HTTP 401/403 | 当前一律 200+100002 | 伪造/过期 session 已测；401 可能只在旧网关 |
| U2 | 429 限流形态与阈值 | 20 并发免费模型无 429 | 灰度压测（注意封号风险）；或用客户端 `100005` 映射推断 |
| U3 | 5xx 形态 | 未触发 | 断网/代理注入；或等运维故障 |
| U4 | 静默截断（[DONE] 无 finish_reason） | 3 段长回答未复现 | 多轮长输出 + 按帧统计；保留客户端防御 |
| U5 | `traceparent` 缺失挂死 | 本次全部正常 | 旧版 0.9.36 或生图链路复现 |
| U6 | 网关级内容审核错误文案/码 | 只触发模型级拒绝 | 构造更明确违规内容（有账号风险） |
| U7 | 上下文超限错误形态 | 需 >1M tokens 输入，成本高 | 小上下文模型 + 逼近 context_length |
| U8 | 团队身份 `teams[]` 元素结构、团队积分接口 | 账号无团队 | 团队账号实测 `/team-points/balance`、`/api/v2/team-points/records` |
| U9 | session 服务端 TTL / 自然过期表现 | 需等待过期 | 观察 `100002 登录已失效` 出现周期 |
| U10 | 积分公式（倍率 × token 如何取整） | 样本少（4 次扣分） | 多模型多长度采样，拟合 `ceil()` 假设 |
| U11 | `reasoning_effort` 各档实际效果 | 噪声大（spark 各档都思考） | 对 DeepSeek/GLM 做同 prompt 多档对比 |
| U12 | `finish_reason:"content_filter"` | 未出现 | 触及硬审核的请求 |
| U13 | `auto` 路由目标稳定性 | 仅 1 次（→GLM） | 多次采样 / 不同 prompt |
| U14 | 图片生成协议（生图） | 超出本插件范围 | `/images/generations` 等实测 |
| U15 | 无 `Authorization` 时 `/models` 的 500/404 回退 | 未构造 | 换错误 baseURL |
| U16 | `granularity=msg/purpose` 的条目字段 | 本账号无 msg/purpose 维度扣分（本轮调用都带 chatid） | 用 `kb.vision`/`memory.extract` 类请求制造 purpose 扣分 |
| U17 | `/models` 在 token 失效但 HTTP 200 时的客户端行为 | 已测 envelope，未测客户端自愈 UI | 观察客户端登录态被清除的时机 |

---

## 10. 复现方法与取证附录

### 10.1 只读复现命令（把 `<SESSION>` 换成本机 session；**勿写入文件/日志**）

```bash
S='<SESSION>'
# 模型目录
curl -sS -H "token: $S" https://loomyad.xunfei.cn/api/v1/models | jq '{n:(.data|length), ids:[.data[].id]}'
# 积分三桶
curl -sS -H "token: $S" 'https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all' \
  | jq '.data | {balance, dailyBalance, availableBalance, total, dailyCycleDate: .list[0].dailyCycleDate}'
# 身份
curl -sS -H "token: $S" https://loomyad.xunfei.cn/api/v1/user/identity | jq .data
# 免费模型非流式对话（不扣分）
curl -sS https://loomyad.xunfei.cn/api/v1/chat/completions \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $S" \
  -H 'loomy-version: 0.9.39' -H 'invokeorigin: user' \
  -H "chatid: chat-$(uuidgen)" -H "msgid: msg-$(uuidgen)" \
  -H "traceparent: 00-$(openssl rand -hex 16)-$(openssl rand -hex 8)-01" \
  -d '{"model":"spark-x2.6","max_tokens":64,"stream":false,"messages":[{"role":"user","content":"说\"好\""}]}' | jq .
```

> 免费模型 = `/models` 名称带 `(限时免费)(x0.0)` 的模型（当前仅 `spark-x2.6`）。实测其
> `points_consumed` 恒为 0；其它模型（GLM x0.8 等）每次调用至少扣 1 分（4 次实测 4 分）。

### 10.2 本次取证矩阵（摘要）

| 探针 | 请求 | 结果 |
| --- | --- | --- |
| 模型目录 | `GET /models` + token | 200，10 条，4303B，无缓存头 |
| 模型目录鉴权 | Bearer / 无 / 伪 token | 200 + 100002（两种 desc） |
| 分页参数 | `?pageNo=2&pageSize=3` | 200，忽略参数（内容不变） |
| 积分 v1 | all/earned/consumed、pageNo/pageSize 边界 | 200；非法 recordType → 100001；pageSize 夹到 100 |
| 积分 v2 | chat/msg/purpose/turn × debit/credit | turn+debit → 100001，其余 200 |
| 身份 | `GET /user/identity` | 200，`{isInternal:false, currentTeamId:"", teams:[]}` |
| 对话非流式 | spark-x2.6 最小体 | 200，reasoning + length（content 空） |
| 对话流式 | spark-x2.6 + include_usage | 200，27 帧，role/reasoning/content/finish/usage/DONE |
| reasoning_effort | none/low/high/xhigh/bogus/缺省 | 全 200；spark 各档均产出 reasoning |
| 工具调用 | tools + 硬绑 tool_choice；流式 auto | 200，`finish_reason:"tool_calls"`，分片合并形态 |
| 视觉 | GLM + 1×1 PNG data URL | 200，`content:"红色"`，扣 1 分 |
| 视觉（远程 URL） | GLM + https 图片 | ~92s 后 400（baidu-qianfan），仍扣 1 分 |
| 视觉（无 vision 模型） | spark-x2.6 + image part | 400 invalid_request_error |
| 空/缺 messages | — | 400 “messages 不能为空” |
| 非法 role | `wizard` | 400 通用错误 |
| 图片模型当 chat | Hy-Image-3.5-preview | 404 “该模型暂未开放” |
| 未知模型 | `zzz-does-not-exist` / 空 / 缺 / 大写 | 全部 200 且 `model=spark-x2.6`，0 分 |
| auto | `model:"auto"` | 200，`model=GLM-5.3-Flash`，扣 1 分 |
| max_tokens 边界 | 缺省/1/0/-1/999999 | 缺省 200；1→length；0/-1→400；999999→200 |
| stream_options 无 stream | — | 400 通用错误 |
| 内容策略 | 两条违规请求 | 200，模型拒绝文本，`finish_reason:"stop"`，0 分 |
| 长输出 | 3 段 2000–4096 tok | 全部有 finish_reason；未出现静默截断 |
| 头缺失矩阵 | traceparent/chatid/msgid/loomy-version/invokeorigin 逐个缺失 | 全部 200 |
| 版本矩阵 | 0.1.0/0.9.0/0.9.39/1.0.0/2.5.0/空 | 全部 200 |
| 鉴权形态 | 裸 session / 无 auth / Bearer+token | 裸/无 → 100002 缺少 token；两者同发 → 200 |
| 并发 | 20 并发免费模型 | 20/20 200，无 429 |
| 路径错误 | `/chat/completion` | 404 纯文本 |

### 10.3 客户端源码取证位置（本机只读）

| 事实 | 文件 |
| --- | --- |
| 追踪头构造 / 白名单 `invokeorigin` | `electron/utils/request-headers.js` |
| `loomy-version` 取值 | `electron/utils/app-version.js` |
| chat headers 注入（ChatId/MsgId/TurnId/traceparent，子代理继承） | `electron/opencode-plugin/loomy-chat-headers-source.js`、`electron/lib/chat-headers-store.js` |
| 积分接口：recordType/pageSize 夹取/100002 特判/token 头 | `electron/points-service.js` |
| 模型目录拉取与映射（token 头、10s、data.data、capabilities→modalities/limit） | `electron/model-service.js`（`normalizeFetchedModelMetadata` 在 `app.asar` 内 `src/lib/model-metadata.js`） |
| 视觉请求体（image_url + data URL + purpose 头） | `electron/knowledge/kb-vision.js` |
| 用途枚举（17 个） | `electron/utils/request-purpose.js` |
| 会话文件写入/清理/`updatedAt` 语义 | `electron/auth/auth-session-controller.js`、`electron/auth/auth-session-runtime.js` |
| 积分 usage 字段提取（`points_consumed` 多路径兜底） | `electron/opencode/stream-coordinator.js#extractPointsConsumed` |
| 401 自愈（历史/防御） | `electron/opencode/event-router.js#isHttpUnauthorized` |
| chatId/msgId 生成规则、错误文案映射 | `app.asar` 渲染层 bundle（`createChatId`/`createMsgId`、`消息包含敏感内容`） |
| 客户端 LLM 直连（`/chat/completions`、100002 处理、`/no_think`） | `electron/llm/llm-completion.js` |
| 调试代理（抓真实请求，替代注入证书） | `electron/llm/llm-debug-proxy.js`（`LOOMY_LLM_DEBUG_PROXY=1`、`LOOMY_LLM_DEBUG_PROXY_LOG=<path>`、`LOOMY_LLM_DEBUG_PROXY_LOG_SECRETS=1`） |

---

## 11. 与既有参考文档的差异（更正）

| 旧结论（`.refs/RECON.md` / `.refs/router-loomy/docs/loomy-upstream.md`） | 本次实测 |
| --- | --- |
| 图片模型无 `capabilities` 字段 | **有**；但 `type:"image"`、`output_modalities:["image"]`、`function_calling:false` |
| 缺 `traceparent` 会挂死 | 未复现（非流式/流式/长回答均正常） |
| 客户端会带 `x-session-affinity` | 0.9.39 源码无此头 |
| 平台接口失败为 401/403 | 全部 HTTP 200 + `100002`（对话鉴权失败同样 200） |
| `loomy-version` 发 `0.9.36` | 本机实际 `0.9.39`；服务端不校验 |
| 流式必须 `stream_options.include_usage` 才有 usage | 0.9.39 不传也有 usage 帧 |
| 未知模型会报错 | **静默回落默认模型**（spark-x2.6） |
| `chatid` 只是追踪 | 同时是 v2 积分聚合键（`chat_aggregate.chatId`） |

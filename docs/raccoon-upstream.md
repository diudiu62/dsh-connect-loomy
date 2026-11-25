# 小浣熊（Raccoon）上游实测记录

> 取证环境：macOS，`/Applications/商汤小浣熊.app`（`@raccoon/office-desktop`，构建 2026-11-10），
> 网关 `https://xiaohuanxiong.com`，取证时间 **2026-11-17 22:40–22:52 +08**，Node 22 + curl。
> 取证方式：**只使用本机已登录客户端的登录态发只读请求**，外加一次 `max_tokens:8` 的最小对话。
> 未改账号、未改客户端配置。
>
> **本文不记录任何真实凭据。** token 只以长度与 `exp` 形式出现。

## 0. 速查

| 项 | 值 |
|---|---|
| 登录态文件（macOS） | `~/Library/Application Support/office-raccoon/agent/config/auth.json`（legacy 安装为 `~/.box-agent/config/auth.json`） |
| 字段（写） | `access_token`、`refresh_token`、`office_identity`、`office_org_name`、`office_org_role`（**只有下划线这一套**，见 1.1） |
| 字段（读） | 官方认 `access_token \|\| token \|\| auth_token`；**不认**驼峰 `accessToken` |
| 令牌有效期 | **30 天**（`exp - iat = 2592000s`），JWT `iss: xiaohuanxiong.com/iam` |
| 对话基址 | `https://xiaohuanxiong.com/api/web/llm/v2` |
| 模型目录 | `GET /api/web/llm/v2/model_catalog` |
| 对话 | `POST /api/web/llm/v2/chat/completions`（OpenAI 兼容 + SSE） |
| 余额 | `GET /api/web/points/v1/balance` |
| 账单 | `GET /api/web/points/v2/bills`（游标分页，见 §7） |
| 身份 | `GET /api/web/auth/v1/user_info` |
| 鉴权头 | `Authorization: Bearer <access_token>`（只有这一种） |
| 信封 | `{code, message, data}`；`code === 0` 为成功 |

## 1. 登录态

```json
{
  "access_token": "<JWT 432 字符>",
  "office_identity": "personal"
}
```

- **没有 `refresh_token`。** 本机构建只落 access token；因此插件**不刷新**、**不写回**，令牌过期时给可执行提示（打开客户端重新登录）。
- 客户端另有一份设备标识：`~/Library/Application Support/office-raccoon/desktop-device-identity.json` 的 `clientDeviceId`（uuid），作为 `X-Client-Device-ID` 发送。
- 目录 `.raccoon-lab-client.json` 声明 `{"application":"@raccoon/office-desktop","version":1}`，不是凭据——**它是 profile 标记**，见 1.1。

### 1.1 凭证文件契约（1.2.0 `app.asar` 反编译核对，2026-11-18）

`app.asar` 里 `build/electron/main/agent/boxAgentAuthFile.js` 是唯一权威：

```js
const AUTH_FILE_KEYS = {
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  officeIdentity: 'office_identity',
  officeOrgName: 'office_org_name',
  officeOrgRole: 'office_org_role',
}
```

| 行为 | 官方实现 | 结论 |
|---|---|---|
| 写 | `writeBoxAgentDesktopAuthState()`：只写上面五个键、空值省略、**整份覆盖**旧文件、`JSON.stringify(payload, null, 2) + '\n'`、权限 `0600`、内容与权限都没变则跳过、五个键全空则 `unlink` | 字段名**只有下划线**；驼峰 `accessToken` 是我们插件导出包的名字，客户端不认 |
| 读 token | `raw.access_token \|\| raw.token \|\| raw.auth_token` | 官方自己认后两个别名，但**不认 `accessToken`** |
| 读身份 | `office_identity` / `office_org_name` / `office_org_role` | 后两个是账号级信息，切换时清不干净会串到下一个号 |
| `refresh_token` | `isIamToken(accessToken)` 为真时**不写**，读时也丢弃 | IAM 令牌自带 30 天 `exp`，refresh 字段是死的 |
| `isIamToken()` | `jwtDecode(token).iss.endsWith('/iam')` | 现网令牌 `iss: xiaohuanxiong.com/iam`，恒为 IAM |

路径解析链：

```
getBoxAgentAuthPath()
  = join(BOX_AGENT_CONFIG_DIR || join(resolveBoxAgentHome(), 'config'), 'auth.json')
        ↑ clientProfileEnvironment(profile) 设成 profile.agentHome
```

- 新 client profile（根目录有 `.raccoon-lab-client.json`）→ `agentHome = <userData>/agent`
  → `~/Library/Application Support/office-raccoon/agent/config/auth.json`
- legacy 安装（`resolveCredentialAgentHome` 的 legacy 分支要求 `agentHome` 的 realpath 等于 `~/.box-agent`）→ `~/.box-agent/config/auth.json`

两条布局差一层 `agent`，写文件前必须先判断，不能一律拼 `agent/`。

另外两点：

- `isEnterpriseLocal`（`enterprise.desktop.login.mode === 'local'`）为真时官方**完全不读写** auth.json（`read` 返回 `{}`、`write` 返回 `{persisted:false}`）。本发行版 `serializedEnterprise` 为空串，不走这条分支。
- `account/desktopAuthCookies.js` 只定义了 `getDesktopAuthCookie` / `setDesktopAuthCookie`，在这个构建里没有任何调用点——所以 cookie **不是**登录态载体，只改 auth.json 就够。

**客户端会自我校正身份。** 启动后它拿 auth.json 里的 token 请求 `/api/web/auth/v1/user_info`，
再用返回的 `office_identity` 覆盖本地值，不一致就 `credentials.write(next, 'refresh')` 写回 auth.json：

```js
const safeProfile = clientAccountProfile(profile)
if (safeProfile.officeIdentity && safeProfile.officeIdentity !== next.officeIdentity) {
  next.officeIdentity = safeProfile.officeIdentity
  rotated = true
}
if (rotated) credentials.write(next, 'refresh')
```

所以写 token 时即使漏了 `office_identity`，客户端也会自己补对（展示层另有 `officeIdentity || 'personal'` 兜底）。
写成"猜"出来的 `personal` 反而会在企业号上先错一次再被改回来——这也是不写空值更稳的原因。

## 2. 请求头

**2026-11-23 复核**：把本机安装的 `1.2.0` 客户端的 `app.asar` 拆开后，2.0.0 时代
的那张表已经过时——真实的字段集比当年多两个，`platform` 的取值也变了。

| 头 | 实测值（asar 证据） | 来源 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | 唯一凭据 |
| `Content-Type` | `application/json` | — |
| `X-Client-Platform` | `desktop-macos` / `desktop-windows` / `desktop-linux` | 主进程按 `process.platform` 映射（`desktopDeviceIdentity.js`） |
| `X-Client-Version` | `app.getVersion()`（本机 `1.2.0`） | asar `package.json` 的 `version`，与 `Info.plist` 一致 |
| `X-Client-Device-ID` | `clientDeviceId` | `desktop-device-identity.json` |
| `X-Client-Name` | `raccoon-work` | asar `package.json` 的 `clientName` |
| `X-Client-Page` | 页面路由名 / `background` | `requestHeaders.js`：无页面上下文的调用发 `background` |
| `X-Org-Code` | 企业号才发 | 渲染层 `createHeaders()` |

另有两点改变了认知：

1. **这些头不是鉴权必需**：客户端自己的本地模型中继（`dist/electron/main.cjs`
   的 `hostedModelRelay`）转发 chat 请求时只发 `content-type` + `authorization`
   两个头，一个 `X-Client-*` 都没有。它们的角色是**风控画像**——网关拿它们给
   流量归档，所以插件按客户端行为照发（"照发"从保险变成了必需）。
2. **官方客户端的调用形态是低并发的**：本地中继自限 2 路在飞请求
   （`upstreams.size >= 2 → 本地 429`），`maxConnections = 4`。插件多路并发 +
   多账号共用一个 device id，就是 2026-11-23 `200108` 连环限流的画像
   （见 §10）。

除 `Authorization` 外的头在 2026-11-17 的取证里缺省也返回 200（协议不校验），
但**协议不校验 ≠ 风控不看**。

## 3. 模型目录

`GET /api/web/llm/v2/model_catalog` → `data.categories[]`，只取 `type === "chat"`。

2026-11-17 实测：**10 行，其中 7 行 `visible: true`**。

| id | 显示名 | ctx | max_tokens | 倍率 | billing_status | tags |
|---|---|---|---|---|---|---|
| `raccoon-090dd3` | Raccoon-Work | 1M | 100k | 1 | normal | 隐藏（`visible:false`） |
| `raccoon-19b265` | — | 1M | 100k | 1 | normal | 隐藏 |
| `raccoon-405a1c` | — | 1M | 100k | 1 | normal | 隐藏 |
| `sn-sensenova-6-8-flash` | SenseNova-6.8-Flash | 256k | 63999 | 0.5 | **limited_free** | vision |
| `sn-sensenova-6-8-flash-lite` | …-Flash-Lite | 256k | 63999 | 0.5 | **limited_free** | vision |
| `sn-qwen4-max` | Qwen4-Max | 1M | 100k | 0.75 | discount | vision, reasoning |
| `sn-glm-5-3` | GLM-5-3 | 1M | 100k | 0.75 | normal | reasoning（**无 vision 标签**） |
| `sn-kimi-k3-1-pro` | Kimi-K3-1-Pro | 1M | 100k | 1 | normal | vision, reasoning |
| `sn-glm-5-3-flash` | GLM-5-3-Flash | 1M | 100k | 0.2 | normal | vision |
| `sn-deepseek-v4-1-flash-1017` | DeepSeek-V4.1-Flash | 1M | 100k | 0.25 | normal | vision, reasoning |

行内字段（全部实测存在）：

```text
name / description / display_description / visible / model_name / tags[]
ability_level / billing_category
params: { context_window, max_tokens, raccoon_thinking{managed,supported,can_disable,display_levels[],default_level} }
billing_multiplier / billing_effective_multiplier / billing_status / billing_status_note / billing_discounts[]
```

插件侧的三个决定：

1. **`visible:false` 一律丢弃**——那是客户端自己的 agent 路由位，用户在自己的 App 里也看不到。
2. **`raccoon_thinking.display_levels` 解析但不用**（见 §5）。
3. **倍率取 `billing_effective_multiplier`**（折后价），`billing_status` 为 `limited_free` 时仍显示倍率但标注免费。

## 4. 对话（SSE）

`POST /api/web/llm/v2/chat/completions`，标准 OpenAI 形状。实测事件序列：

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"好的"}}],"request_id":"…"}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"，用户让我只回答两个字…"}}]}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}
data: {"choices":[{"index":0,"delta":{}}],"usage":{"completion_tokens":64,"prompt_tokens":63,
       "completion_tokens_details":{"reasoning_tokens":64}}}
data: [DONE]
```

三条由此而来的判定：

- **思考链走非标准字段 `delta.reasoning_content`**，`delta.content` 在思考阶段为空串。pi-ai 的 `openai-completions` 已按 `reasoning_content → reasoning → reasoning_text` 顺序识别，插件不需要改写。
- **`max_tokens` 太小会得到"只有思考、没有正文"**：16 token 即触发 `finish_reason: "length"`，`content` 为空。这是合法截断，不是空响应；插件不主动设小档位。
- **末帧是独立 usage 帧**（`choices: []` 语义），解析器不能把 `choices[0]` 当必需。

## 5. `reasoning_effort` 不被校验（逐值实测）

对 `sn-glm-5-3-flash` 发最小请求（`max_tokens: 8`）：

| 送进去的值 | HTTP | 结论 |
|---|---|---|
| 不传 | 200 | — |
| `level_1` | 200 | 目录里的原生档位词 |
| `low` | 200 | — |
| **`banana`** | **200** | 垃圾值也 200 ⇒ 网关不做校验 |

因此：模型对象声明 `supportsReasoningEffort: false`，`efforts` 恒为空，**不提供档位下拉**。目录里的 `display_levels` 描述的是 App 自己的 UI，不是网关的强制语义。

## 6. 余额

`GET /api/web/points/v1/balance`：

```json
{"code":0,"message":"success","data":{
  "available_points":13300,"daily_points":300,"monthly_points":0,
  "reward_points":13000,"topup_points":0,"enterprise_topup_points":0}}
```

四个桶**分别展示、绝不求和**：每日额度按上游周期重置、奖励一年有效、充值永久，加总会让用户以为余额安全。

## 7. 已知易变点（客户端改版先查这里）

1. `auth.json` 的路径与字段名（本机是 `agent/config/auth.json`，文档记录的是 `~/.box-agent/config/auth.json`，两处都试）。
2. 是否开始下发 `refresh_token`；一旦下发，"只读不刷新"的决定要重审。
3. `model_catalog` 的 `categories[].type === "chat"` 与 `billing_*` 命名。
4. `tags` 里的 `vision` 与真实识图能力的对应关系（本节未做识图实测，插件按标签 + 配置兜底）。
5. `reasoning_effort` 是否开始真正校验（若开始校验，档位下拉才有意义）。

## 8. 未验证项（不要当事实用）

- 识图能力：本次只验证了文本对话，`vision` 标签是否可信**未实测**。
- 工具调用（`tools` / `tool_calls`）：未实测，路由按标准 OpenAI 透传处理。
- 企业账号路径（`X-Org-Code`）：未实测。
- Windows / Linux 客户端的登录态路径：按 `os.homedir()` 推导，未实机验证。

## 9. 登出 / 刷新 / 登录（2026-11-18 追加）

| 操作 | 端点 | 鉴权 | 实测 |
|---|---|---|---|
| 登出 | `POST /api/iam/v1/auth/logout` | `Authorization: Bearer` | **200 OK**（`code: "OK"`） |
| 刷新 | `POST /api/web/auth/v1/refresh` | body `{token}` | 400 `100002 param token invalid format`（端点存在，令牌类型待定） |
| 发送验证码 | `POST /api/web/auth/v1/send_sms` | body `{nation_code, phone}` | 400 `100003 params_encryted_error` |
| 短信登录 | `POST /api/web/auth/v1/login_with_sms` | body `{nation_code, phone, sms_code}` | 同上 |
| 密码登录 | `POST /api/web/auth/v1/login_with_password` | body `{nation_code, phone, password}` | 同上 |

### 9.1 手机号加密（已逆向完成）

`100003 params_encryted_error` 说明服务端要求密文。算法从渲染层 chunk `21854`（webpack 模块
`24886`，导出名 `yv`）里完整读出：

```js
function l(e, t = "senseraccoon2023") {
  const r = CryptoJS.enc.Utf8.parse(t)          // key
  const s = CryptoJS.lib.WordArray.random(16)   // IV
  const n = CryptoJS.AES.encrypt(e, r, { iv: s, mode: AES.CFB, padding: NoPadding })
  return s.concat(n.ciphertext).toString(Base64) // IV ‖ ciphertext
}
```

即 **AES-128-CFB**，密钥 `senseraccoon2023`，每次调用随机 16 字节 IV，IV 拼在密文前，
整体 Base64。11 位手机号得到 36 字符密文，正好满足主进程
`accountRequests.js` 的 `/^[A-Za-z0-9+/]+={0,2}$/` 校验。

**实测验证**（2026-11-18）：

| 请求 | 之前（明文手机号） | 现在（加密手机号） |
|---|---|---|
| `send_sms` | `100003 params_encryted_error` | `100006 captcha_verify_error`（手机号已解密成功，卡人机验证） |
| `login_with_sms` | `100003 params_encryted_error` | `100007 sms_code_verify_error`（手机号已解密成功，卡验证码） |

两个新错误都不是加密错误，证明服务端能正确解密。实现见
`src/vendors/raccoon/auth-flow.ts` 的 `encryptRaccoonPhone`。

**剩余阻塞**：`send_sms` 需要 `captcha_param`（人机验证 token），来自页面上的
`captcha-element`（腾讯/极验类）。登录本身只要拿到真实短信验证码即可完成，不需要插件内
破解验证码——用户在客户端或网页上取一次验证码填进来即可。

**加密函数仍保留注入点** `phoneEncryptor`：客户端若更换密钥或算法，用配置覆盖即可，
无需发版。

**多账号**：客户端的多账号凭据在 localStorage / 钥匙串，不在 `auth.json` 里。插件改为
**自己存**（`<stateDir>/raccoon-accounts.json`），登录成功后把 token 写进自己的账号表，
每行保留 `phoneMasked`（永远不存完整号码）。桌面客户端那一份始终作为「桌面登录态」存在，
可随时切回。

**刷新令牌**：本机 `auth.json` 没有 `refresh_token` 字段（只有 `access_token` 与
`office_identity`）。刷新接口存在但令牌类型未确定，因此插件的刷新路由**只做透传**：
由调用方提供 `refresh_token`，路由转给上游并返回结果，插件自己不做轮换、不写回。
### 9.2 密码登录：密码也要加密（2026-11-18 追加）

客户端在 `Password` 分支里传的是 `password:(0,l.yv)(g)` —— 与手机号**同一个加密函数**：

```js
// out/_next/static/chunks/24605.c9e51b647d777a90.js
let r = (0, l.yv)(m);              // phone
loginWithPassword({ nation_code: c, phone: r, password: (0, l.yv)(g) })   // g = password
```

插件早先只加密手机号、密码明文发送，网关会拒绝。现已改为两者都过同一个
`phoneEncryptor` 注入点（默认 `encryptRaccoonPhone`），这样密钥轮换时配置一处即可。

**一个已修的实现 bug**：`PhoneEncryptor` 的签名是 `(phone, nationCode)`，而
`encryptRaccoonPhone(phone, passphrase = 'senseraccoon2023')` 的第二个参数曾是密钥。
路由直接把前者当后者传入，导致 `nationCode='86'` 被当成 AES 密钥（2 字节），
node:crypto 抛 `Invalid key length`。现在第二参数改为忽略的 `nationCode`，密钥固定为
常量 `RACCOON_PHONE_PASSPHRASE`，并在长度不为 16 时给出明确的中文错误。


---

## 7. 账单（积分明细）：`GET /api/web/points/v2/bills`

实测 2026-11-19。信封仍是 `{code, message, data}`，`data` 是**游标分页**：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [
      {
        "group_id": "task_E9D4…",
        "bill_count": 1,
        "bill_id": "bill_337b…",
        "client_type": "desktop",
        "event_name": "桌面端 LLM 对话消耗",
        "biz_type": "desktop",
        "biz_id": "e15e…",
        "points": -1,
        "created_at": "2026-11-19T16:04:34+08:00"
      }
    ],
    "has_more": true,
    "next_cursor": "eyJvd25lcl90eXBlIjoidXNlcnMi…"
  }
}
```

要点：

- **`points` 带符号**：负数才是扣减（`-1` 表示消耗 1 点）。正数出现在奖励/充值类
  `biz_type` 上。视图里 `direction` 由符号推导，`pointsActual` 是绝对值。
- **`created_at` 是带时区的 ISO 8601**（`+08:00`），`Date.parse` 直接可用。
- **没有余后余额，也没有模型名**。所以卡片那两列留空，而不是编造。
- **分页是游标**：把上一页的 `next_cursor` 原样传回 `?cursor=`。卡片只取第一页
  （20 条），因为多翻页会把一次只读查询变成 N 次上游请求。
- 不知道 `limit` 参数是否被接受：**未验证**，不要依赖它。

### 7.1 `balance` 的**裸域**被路由级封锁，`www.` 子域可用

2026-11-25 订正。早前这一节把 403 记成"频率/风控、隔一会儿恢复"，**那个结论是错的**。

实测同一 token、同一时刻：

| 端点 | 结果 |
| --- | --- |
| `GET https://xiaohuanxiong.com/api/web/points/v1/balance` | `403` + 空 body + `X-TT-System-Error: 3` |
| `GET https://www.xiaohuanxiong.com/api/web/points/v1/balance` | `200`，六个桶齐全 |
| 裸域 `points/v2/bills` / `v1/tasks` / `office/v3/setting_info` | `200` |
| 裸域 `llm/v2/model_catalog` | `200` |

判据：

- **不带 token 也是 403**（不是 401）——拦在鉴权之前，属于**路由级封锁**，不是凭据问题；
- GET/POST/OPTIONS/HEAD、换 UA、换 `X-Client-*`、加 `Origin`/`Referer`、静默 90 秒后
  单发，全部 403——与请求形态和频率都无关；
- 同一时刻换 `www.` 子域，同一路径、同一 token → 200。

旁证：客户端 Chromium 缓存里那条 200 的 `balance` 响应来自 `www.` 域；另一个项目
（robotaxi 的小浣熊巡检）也独立得出了同样的结论，并保留了"先 www、再回落裸域"的
候选链。插件的对策：

- **余额按 `[www 子域, 裸域]` 顺序尝试**（`balanceUrls()`）：默认配置下 www 优先、
  裸域兜底；用户自己改过 `pointsURL` 时，尊重配置优先；
- 两条都不通时，退到 `office/v3/setting_info` 的 `available_points`（官方客户端首页
  那个数，只有一个桶），并用 `degraded: 'setting_info'` 让界面说明来源；
- 诊断页的 `balance` 探针走**同一条**候选链，否则余额能读也会报 403；
- 逐账号余额**一条一条懒加载**（`GET <vendor>/credits/account?id=…`）：账号行先画
  出来、数字随到随填。批量 `?accounts=1` 仍保留给 CLI 与一次性读取，但界面不再用它
  ——90 个账号的批量要 5 秒以上，抽屉在那段时间里是一列空的 `—`；
- 逐账号读取**限并发 2 + 每账号间隔 120ms**（对齐官方客户端的 2 路本地中继；
  3 路并发仍会把网关的突发限流打出来）；
- 逐账号**不取账单**（那是 N 倍的请求，且明细只需在总额层面展示一次）；
- 余额失败**不伪造 0**，如实报错；账单失败**不影响余额**；
- **失败负缓存 60 秒**（`CREDITS_FAILURE_TTL_MS`）：一个 key 失败之后窗口内不再
  打上游，直接把同一个失败重放给界面；窗口内用户点 ↻（`force=1`）仍然真的再试。
  这是最关键的一条——没有它，"被限流"会被自己的重试续命；
- **总额被限流即整轮短路**：`surface.credits()` 拿到 403/429 类失败后不再逐账号
  fan-out（旧行为是照样打 N 次，用户点一次刷新就往风控里再推 N 个请求）；
- 胶囊的静默重试只对抖动类失败；限流/额度类不重试。

---

## 10. 429 与账号级风控（2026-11-23 实测）

### 10.1 错误形态

`POST /chat/completions` 被限流时返回 **HTTP 429**，body 是一个业务信封而不是
OpenAI 标准错误：

```json
{"code":200108,
 "message":"系统检测到当前账号存在异常调用，模型调用功能已暂时受限。请稍后重试；如仍未恢复，或你认为是误判，请点击左下角头像，选择「问题反馈」提交说明。",
 "type":"rate_limit_error"}
```

要点：

- `code: 200108` 是**账号级**风控（"异常调用"画像命中），不是普通的 QPS 限流；
- 文案里已经写明"模型调用功能已暂时受限"——继续打只会把限制确认一遍；
- 同一批账号会在**同一分钟内**被整体打上：2026-11-23 09:30:52–09:32:19，
  9 个插件账号里 8 个在 90 秒内全部 429（另一个 09:08 是 401 `200003`）。

### 10.2 为什么插件比官方客户端容易中

| 维度 | 官方客户端 | 修复前的插件 |
|---|---|---|
| 并发 | 本地中继自限 **2** 路在飞 | harness 无上限（agent loop / 子代理 / 后台摘要） |
| 设备标识 | 一次安装一个 `clientDeviceId` | 9 个账号共用桌面端那一个 |
| UA / SDK 指纹 | Electron Chromium | `deepseek-harness/<ver>` + `x-stainless-*` 全套 |
| 平台/版本头 | `desktop-macos` / `1.2.0` / `raccoon-work` | `desktop` / `2.0.0` / 缺 `X-Client-Name`、`X-Client-Page` |
| 全池冷却时 | 不适用（单会话串行） | 挑"最久没失败"的账号**继续打** |
| 限流冷却 | 不适用 | 固定 10 分钟，到点即回池 |

### 10.3 现在的防御（代码位置）

1. **每账号并发闸门**：`core/gate.ts` + `core/provider.ts`，供应商用
   `concurrency()` 声明上限；小浣熊默认 2（配置项 `concurrency`，0 = 不限）。
   超出的调用排队，不发给上游。
2. **全池冷却即停手**：`vendors/raccoon/index.ts` 的 `pickCredential` 在
   `none-healthy` 且还有可恢复账号时直接返回"最早 HH:MM 自动恢复"的错误
   （code `POOL_COOLING`，与 `MISSING_CREDENTIAL` 区分开：冷却时用户是已登录的，
   选择器分组保持可见），不再把被限制的账号送上去。
3. **指数冷却 + 持久化**：限流命中第 N 次就乘 `RATE_LIMIT_COOLDOWN_STEPS`
   （10→20→40→80→160 分钟，封顶六小时），解禁时刻 `unavailableUntil` 与
   连续次数 `unavailableStreak` 都写进账号文件，重启不忘。成功一次才清零。
   桌面令牌的 bench 走 `core/pool.ts` 的共享 `createDesktopBench`（内存态，
   重启清零），Loomy 与小浣熊同一份实现。
4. **积分读取自己节流**：失败负缓存 + 总额限流短路 + 逐账号 2 路/120ms 间隔，
   见 §7.1；`balance` 的 403 是**裸域路由级封锁**（`www.` 正常），不是协议问题。
5. **额度用光单独一档**：`积分不足` / `余额不足` / `QUOTA_*` 归到 `points`
   （`classifyUnavailable`），窗口固定 30 分钟（`DEFAULT_POINTS_COOLDOWN_MS`），
   **不打指数阶梯**——等待不会给账号充值，升档只会把"我刚充完钱"的人挡在门外。
   读到余额为 0 时立刻按这一档暂停（`core/credits.ts#applyZeroPoints`，两家共用），
   不必等上游回一句失败；余额读回正数就 `markHealthy` 立刻解除。余额桶自己被
   限流（`partial: 'balance_unavailable'`，`fields` 为空）时**不动池**：读不到数字
   不是"没钱"。
6. **逐账号设备标识**：`core/accounts.ts` 给每个插件账号生成一个 uuid
   （与官方 `clientDeviceId` 同形），聊天/目录/余额请求按账号发送；桌面端身份
   仍用客户端自己的那份。
7. **请求头对齐**：平台值按 `process.platform` 映射、版本号运行时读 aapp.asar
   （读不到才用常量 `1.2.0`），补 `X-Client-Name: raccoon-work` 与
   `X-Client-Page: background`。

仍**不可**消除的差异：`User-Agent` 由 DSH 的 pi-ai 适配器在 `prepareHeaders`
之后强制覆盖为 `deepseek-harness/<ver>`（`dsh-llm-pi-ai` 的
`requestHeaders()`），插件层覆盖不了；`x-stainless-*` 由 OpenAI SDK 自动附加。
所以并发与节奏控制才是主要防线，头对齐只是减少额外的画像信号。

### 10.4 未验证项

- `200108` 的解除时长（观察到 10 分钟内未恢复；阶梯按六小时封顶设计）；
- 是否按 IP 聚类（9 个账号同机、同出口 IP，无法在本机区分账号级与 IP 级）；
- 官方客户端是否也会触发（单会话串行、无并发，未做对照实验）。

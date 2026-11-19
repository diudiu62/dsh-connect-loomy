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

| 头 | 实测值 | 必要性 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | 必需 |
| `Content-Type` | `application/json` | POST 必需 |
| `X-Client-Platform` | `desktop` | 未验证是否校验，照发 |
| `X-Client-Version` | `2.0.0` | 未验证是否校验 |
| `X-Client-Device-ID` | `clientDeviceId` | 未验证 |
| `X-Org-Code` | 个人账号为空串 | 企业账号才需要 |

除 `Authorization` 外的四个头在本次取证中**缺省也返回 200**，按客户端行为照发（零成本保险）。

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

### 7.1 一个已知的上游差异：`balance` 会比 `bills` 更早 403

实测同一 token、同一时刻：

| 端点 | 结果 |
| --- | --- |
| `GET /api/web/points/v2/bills` | `200` |
| `GET /api/web/points/v1/balance` | `403`（空 body） |

403 带空 body 是网关/WAF 的特征（业务错误会返回 `{code: 20xxxx, message}`）。
短时间内对 `balance` 连打十几次会稳定复现；隔一段时间恢复。**`bills` 不受影响**。

客户端缓存（`user-data/Cache/Cache_Data`）里能看到同一个 `balance` 请求返回过
`{"code":0,…,"available_points":8974,…}`，所以接口本身是好的——是**频率/风控**，
不是协议问题。插件的对策：

- 逐账号余额只在**账号页**读（`?accounts=1`），额度面板只读总额；
- 逐账号读取**限并发 3**；
- 逐账号**不取账单**（那是 N 倍的请求，且明细只需在总额层面展示一次）；
- 余额失败**不伪造 0**，如实报错；账单失败**不影响余额**。

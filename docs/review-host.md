# t6 — 宿主侧实现独立评审（provider / 凭据 / 目录 / 积分 / CLI）

- 评审人：reviewer-2（AgentTeams `dsh-connect-loomy`）
- 评审对象：t3「宿主侧实现」最终交付（attempt 3，changedPaths：`src/index.ts`、`src/provider.ts` + `tests/host/*`）
- 仓库：`/Users/benny/Documents/dsh-connect-loomy`（构建产物 `lib/` 21:11 由 `pretest` 重新生成，与 `src/` 同步）
- 结论：**needs_revision（不可直接判定可交付）**——2 条 medium 发现（F1 功能/正确性、F2 凭据隔离语义）需修复；其余 5 条为非阻塞记录。t3 的 8 条验收标准 8/8 判定为满足（其中第 2 条附 F1 保留），t6 的 6 条扩展判据全部满足（其中判据 2/3/5 附非阻塞发现 F3-F5）。

---

## 1. 评审方法与独立取证

除通读 `src/*.ts`、`src/shared/*.ts`、`tests/host/*`、`docs/`、`package.json`、`locale/`、`README.md` 外，做了四组**独立运行取证**（全部离线/环回，零扣费、零真实凭据落盘）：

| # | 取证 | 方式 | 关键结果 |
| --- | --- | --- | --- |
| R1 | `pnpm typecheck` / `pnpm test` | 本机执行 | 退出码 0 / 0；`node --test` 报告 **110/110 通过**（34 client + 2 smoke + 72 host + 2 其它） |
| R2 | 真实 `PiAiAdapter` + 真实 `openai-completions` SSE 解析 + 环回 HTTP 上游 | 导入 `lib/index.js` 的 `createProviderRuntime`，8 个应答场景（合法 length 截断、静默截断、空 stop、429、200 envelope 积分不足、200 envelope 登录失效、401、500） | 见 §4 分类矩阵；线上请求头含 `authorization: Bearer`、`traceparent/chatid/msgid/loomy-version/invokeorigin`，`max_tokens=8192`（非 `max_completion_tokens`），`stream:true` |
| R3 | 真实 `apply()`（最小 cordis 替身）+ 假上游 + 临时 `DSH_HOME`/`LOOMY_AUTH_SESSION_FILE` | 走通 5 条 exact 路由 + `llm.registerAdapter` + 保存/刷新/开关切换 | 见 §3 判据 3/5；state 目录 0700、文件 0600、缓存无 session/手机号/userid |
| R4 | `node lib/bin.js doctor --json`（真机登录态）+ `pnpm pack --dry-run` | 只读 | doctor 退出码 0，账号掩码（`189****2700` / `2611**********7535`）、6/6 模型、三探针 ok、stdout/stderr 无 hex32、无 11 位手机号；tarball 白名单不含 `.refs`/`tests`/`src` |

复现命令（探针脚本在 `/tmp/loomy-review/`，仓库内只新增本文档）：

```bash
pnpm typecheck && pnpm test                       # R1
node lib/bin.js doctor --json                     # R4（只读平台接口，0 积分消耗）
pnpm pack --dry-run                               # R4
node /tmp/loomy-review/probe1.mjs                 # R2 分类矩阵
node /tmp/loomy-review/probe2.mjs                 # R3 apply() 全链路
node /tmp/loomy-review/probe3.mjs                 # R3 主开关生命周期
node /tmp/loomy-review/probe4.mjs                 # R3 冷启动与缓存
```

---

## 2. t3 验收标准逐条核对（8 条）

| # | t3 验收标准 | 结论 | 证据（文件:行 / 取证） |
| --- | --- | --- | --- |
| 1 | typecheck/test/build 全过，main/exports/bin 产物真实存在 | **满足** | R1 两项 0；`lib/index.js`(76.9KB)、`lib/index.d.ts`(30KB)、`lib/bin.js`(42KB)、`lib/client.js`(71.6KB) 均存在（`lib/` 列目录）；`package.json:19-30,109-111` 的 main/types/exports/bin 与产物一一对应；`package.json:92` `pretest: pnpm run build` 使 test 先构建（t5 F2 已吸收） |
| 2 | 路由注册为 `loomy`，只注册 `openai_chat && type==='chat'` 且勾选的模型；展示名带倍率，上下文/最大输出取自上游 | **满足（有保留，见 F1）** | `src/shared/types.ts:25` `PROVIDER_ID='loomy'`；`src/catalog.ts:56-92`（`auto` :60、`type!=='chat'` :61、`protocol!=='openai_chat'` :62、图片模型 `output_modalities` 无 `text` :64-66）；`src/provider.ts:154-171` `toPiModel`（`provider:'loomy'` :161、`api:'openai-completions'` :160/:52、`contextWindow/maxTokens` :165-166、倍率名 :147-151）；R3：`registerAdapter(['loomy'])`、保存后 `listModels` 只剩勾选模型；fixtures 覆盖 `legacy_chat`/`auto`/图片（`tests/host/helpers.mjs:159,174`、`tests/host/catalog.test.mjs:68-72`） |
| 3 | `resolveApiKey` 读本机 auth-session.json；prepareHeaders 每请求 traceparent/chatid/msgid + loomy-version + invokeorigin；session 不出现在日志/设置/缓存/仓库 | **满足** | `src/provider.ts:264-277`（读 session，缺失/失效抛 `LlmError MISSING_CREDENTIAL` :267,:271-274）；`src/provider.ts:174-183,:279`（每请求 `buildTracingHeaders`，`src/shared/trace.ts:56-63`）；R2 线上头逐项断言（含两次请求 msgid 不同）；session 只存在于 `src/auth.ts:46-47` 内存快照，`state.json` 键白名单 `src/shared/state.ts:95-114` 无 session，R3 扫描 0 命中；宿主日志仅固定串+error 对象（`src/index.ts:194-195,222-223,235-237`），上游文案经 `redactSensitive`（`src/shared/upstream.ts:212,226,239`） |
| 4 | 刷新→缓存落盘（0600）→勾选为草稿→保存生效；刷新立即更新目录与倍率但不覆盖未保存勾选 | **满足** | `src/shared/state.ts:140-160`（同目录临时文件+rename、`mode:0o600`、`chmod 0o600`、目录 0700）；R3 实测 dir=700/file=600；「草稿只在浏览器」语义：`src/catalog.ts:125-131` `mergeSelection` 合并**已保存**勾选、`src/routes.ts:322-328` `/refresh` 回 `view()`；`tests/host/catalog.test.mjs:223-256`（倍率 x2.0→x3.0 立即生效且 selection 不变）；R3：refresh 后 rates `m-a:9.9`、enabled 仍为保存值 |
| 5 | 只读积分三桶+流水与身份接口可用；失败如实报错、不伪造 0、不缓存成成功 | **满足** | `src/credits.ts:72-94`（缺任一桶 → failure，文案「不伪造 0」）；v1 查询 `pageNo=1&pageSize≤100&recordType=all`（:121、`src/shared/types.ts:51-55`）；`src/credits.ts:203-223`（失败不写缓存、单飞、60s TTL）；R3：`/credits` 返回三桶+流水；`tests/host/credits.test.mjs:62-73,155+`；真机 R4：可用 40496 |
| 6 | 路由只返回宿主算好的只读结果，不把 session 交给浏览器；写操作有进程级 CSRF | **满足** | `src/routes.ts:60-68`（`cache-control:no-store`）；守卫顺序 method→loopback→JSON→CSRF（:236-271）；CSRF 常数时间比较（:74-84，`timingSafeEqual`）；R3 守卫矩阵：缺/错 csrf=403、非 JSON=415、外域 Host=403 `host_not_allowed`、外域 Origin=403 `origin_not_allowed`、错 method=405；`/status`/`/diagnostics`/`/credits` 序列化文本无 session/完整手机号（R3+`tests/host/routes.test.mjs:212,455,476`） |
| 7 | 单测覆盖 auth 解析/脱敏、目录归一化、profile 构建、积分解析、截断分类 | **满足** | `tests/host/` 72 用例：auth 11（`maskPhone` :36、`updatedAt` 秒/毫秒 :98、candidates 顺序 :159、TTL 缓存 :174）、catalog 17、credits 10、provider 13、routes 16、cli 5；截断三态用**真实 `PiAiAdapter` + 真实 openai-completions** 双层验证（`tests/host/provider.test.mjs:418-454` 真适配器分类、:456-534 真解析器「usage 独立帧」「无 finish_reason 即抛」），R1 全绿 |
| 8 | 真机 `status --json` 脱敏账号+余额；`doctor --json` 候选路径+上游错误原文 | **满足** | R4 独立复跑 `doctor --json`：退出 0、掩码账号、候选 `state=ok`、三探针 ok、catalog 6/6、无 hex32/手机号；t3/t5 真机 `status --json` 证据（余额 40496=35500+4996）与离线 `tests/host/cli.test.mjs:93-133`（token 头、Bearer 不上平台接口）、:135-182（desc 原文回显）一致 |

---

## 3. t6 扩展判据逐条结论（6 条）

### 判据 1 — provider 注册正确性（route id、pi-ai Provider 身份、requireProvider 可查到）→ **满足**

单路由设计下四层身份同键，`requireProvider(model.provider)` 必中：

- 路由键 = profile 键 = `piProvider.id` = `model.provider` = `'loomy'`：`src/shared/types.ts:25`、`src/provider.ts:161,216-218,245-246,260`；R2 实测 `['loomy']/loomy/loomy/glm-5.3-flash@openai-completions`、`providerInfo('loomy')={id:'loomy',name:'Loomy'}`。
- 宿主装配路径核对：`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1892-1896` —— `current()` 按 profiles 映射建 `Models` 集合并 `models.setProvider(profile.piProvider)`，pi-ai 的 `requireProvider` 按 `model.provider` 查表（`pi-ai/dist/models.js:424-431`），model.provider='loomy' 命中本路由；`isSameModel`（provider+api+model.id 三者全等，`pi-ai/dist/api/transform-messages.js` / 契约文档 §2.4）在单路由下天然成立，无需 workbuddy 双键法（契约文档 §2.4 也如此判定）。
- api 字符串处处一致：`LOOMY_API='openai-completions'`（`src/provider.ts:52`），`toPiModel` 用它，R2 线上确认 `stream:true`、`max_tokens`（`compat.maxTokensField`，pi-ai `getCompat` 以显式 compat 覆盖探测值，`pi-ai/dist/api/openai-completions.js:1311-1340`）。
- 「模型选择器能列出勾选模型」：`adapter.listModels('loomy')` → `resolveApiKey` → `getModels()`=`catalog.enabledModels()`（`src/provider.ts:205-242`）；未登录时 `resolveApiKey` 抛 `MISSING_CREDENTIAL`，宿主约定 `listModels` 返回空（`dsh-llm-pi-ai/lib/index.js:1933-1935`），R3/R2 验证。**保留**：见 F1——全新安装且从未打开设置卡片时选择器为空（目录无人预热）。

### 判据 2 — 错误与截断映射（无「限流说成配额」类误导；合法 length 不当空响应；静默截断可重试）→ **满足（附 1 条低危残留，F3）**

R2 实测矩阵（真实适配器 + 真实 SSE 解析，`failure.code` 与 `retryableCodes`）：

| 场景 | DSH 侧结果 | 可重试 |
| --- | --- | --- |
| reasoning-only + `finish_reason:length`（t1 记录的合法截断） | `finish {kind:'max-tokens'}`，reasoning 块保留，**不是错误** | — |
| `data:[DONE]` 无 finish_reason（静默截断） | `TRANSPORT`「Stream ended without finish_reason」 | ✅ |
| `stop` 且零内容 | `EMPTY_RESPONSE` | ✅（默认集含） |
| HTTP 429 + rate limit 文案 | `RATE_LIMIT`（非 QUOTA） | ✅ |
| HTTP 401 | `AUTH` | ❌ |
| HTTP 5xx | `SERVER` | ✅ |
| HTTP 200 + envelope `100002 登录已失效`（对话鉴权失败） | `TRANSPORT`「Stream ended without finish_reason」 | ✅（见 F3） |
| HTTP 200 + envelope `积分不足` | `TRANSPORT`（同上，见 F3） | ✅ |

机制核对：`compat.supportsFinishReason:true`（`src/provider.ts:139-141`）使 pi-ai 对无 finish_reason 的流抛「Stream ended without finish_reason」（`pi-ai/dist/api/openai-completions.js:468-476`），`classifyPiAiError` 归为 `TRANSPORT`（`dsh-llm-pi-ai/lib/index.js:1465-1483`），默认可重试集 `{EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT}`（`dsh-llm/lib/index.js:251-257`）；`length` 在 `mapStopReason` 中先于空内容检查映射为 `max-tokens`（`dsh-llm-pi-ai/lib/index.js:1487-1540`）。平台侧错误码**原样上报**（`100002`/`100001`/HTTP 状态码），无改写（`src/shared/upstream.ts:233-245`、`src/catalog.ts:262-266`）——不存在「把限流说成配额」的跨类误导。

### 判据 3 — 凭据边界（session 只在宿主内存/本机文件；不出现在设置、日志、HTTP 响应、错误原文；缓存权限收紧）→ **满足（附 1 条 medium 语义发现，F2）**

- session 唯一运行时落点：`src/auth.ts:46-47`（AuthSnapshot 内存快照），TTL 5s 重读（`src/auth.ts:241-274`），失效判定只信 `100002/401/403/AUTH`（`src/auth.ts:332-336`）。
- 不进设置：`Config` 8 个字段无一为凭据（`src/config.ts:36-88`）；模型勾选持久化走自有 state 而非 settings 命名空间（`src/config.ts:13-15` 注释明确）。
- 不进日志/错误原文：宿主日志只有固定串与 error 对象（§2 判据 3 证据）；上游文案在 `requestPlatform` 三个出口统一 `redactSensitive`（32+hex、Bearer、`token:`、手机号，`src/shared/text.ts:116-122`）；`tests/host/auth.test.mjs:197` 与 `tests/host/credits.test.mjs:115-124` 覆盖「回显 session/手机号被改写但措辞保留」。
- 不进 HTTP 响应：`/status` 只回 `mask*` 视图（`src/auth.ts:198-210`）；R3 全路由载荷扫描 0 命中；`/diagnostics` 探针 reason 均经脱敏。
- 权限收紧：state 目录 `mkdir 0o700`、文件 `mode:0o600` + 落盘后 `chmod 0o600`（`src/shared/state.ts:145,148,154`），R3 实测 700/600；R4 真机 CLI 输出无泄密。
- **F2（medium）**：`LOOMY_AUTH_SESSION_FILE` 文档写「override」（`src/shared/paths.ts:20-21`、`src/bin.ts:59` help），实现却是**前置追加、失效后仍回退真实桌面登录文件**（`src/shared/paths.ts:65-69` + darwin 默认候选 :73-77）。评审取证时把该变量指向不存在的 fixture，`resolveApiKey` 仍返回了**真实** session（本报告中不复现该值）。后果：期望用该变量做隔离的测试/CLI 场景会把真实凭据交给当时配置的任意 `baseURL`。既有测试因同时隔离了 `HOME`（`tests/host/cli.test.mjs:64-65`）才未踩中。

### 判据 4 — 设置语义（刷新落盘 vs 勾选草稿边界与文档一致；保存后立刻生效）→ **满足**

- 边界与文档一致：契约冻结稿（t3 description 路由契约 v2）、`README.md:13`、`docs/verification-report.md:150` 与实现三方一致——`/refresh` 回**已保存**勾选（`mergeSelection`，`src/catalog.ts:125-131`），草稿只存在浏览器端，刷新不覆盖草稿（`tests/host/catalog.test.mjs:223-256`、R3 实测）。
- 保存立刻生效：`/save` → `saveSelection` 落盘 → `onChanged` → `ctx.emit('llm/models-updated','loomy')`（`src/index.ts:142-146`，事件签名与 `dsh-llm/lib/types/types.d.ts:28` 一致）→ 下一次 `listModels/getModels` 即新集合（profile map 身份恒定，`src/provider.ts:256-260` 注释 + R3 实测保存后 `listModels=['m-a']`）。无需重启。
- 配置字段即时生效：全部 `.volatile()`（`src/config.ts:36-88`），`apply` 每次读取走 `live()`（`src/config.ts:110-115`、`src/index.ts:128-168`）；R3 实测 `enabled` 切换即撤/复路由、`baseURL` 变更触发目录重读（`src/index.ts:207-218`）。

### 判据 5 — 打包与元数据（exports/files 白名单、locale 三处一致、README 相符）→ **满足（附 2 条低危文档发现，F4/F5）**

- `pnpm pack --dry-run`：tarball = `lib/ + locale/ + docs/ + cordis.patch.yml + README.md + LICENSE + package.json`，**无** `.refs`、`tests/`、`src/`、`node_modules`；`lib/*.js` 无 `.refs` 字样、无 `/Users/benny` 绝对路径。
- locale 元数据三处一致（语义）：`locale/en.json`（"Connects the Loomy desktop assistant's already signed-in chat models … settings card and a read-only credits overview"）、`package.json:4`、`README.md:3` 讲同一件事；`meta.title=dsh-connect-loomy` 与包名一致（与 workbuddy 家族约定相同，`.refs/workbuddy-manifest/locale/*.json`）。措辞上有轻微差异（README 多「账号/模型/诊断」括注；en 为英译），属可接受的意译。
- README 与实现总体相符：路由表（README:66-69 ↔ `src/routes.ts:275-355`）、CLI（README:44-49 ↔ `src/bin.ts`）、配置键默认值 8 项逐一对上（README:53-64 ↔ `src/config.ts:36-88` 默认值 5000/60000/600000/60000/20/0.9.39）、仓库结构（README:82-93）、已知限制诚实（README:97-103，含「web profile 挂载未实测」「非流式 JSON→可重试 TRANSPORT」与 t5 L3 一致）。F4 记录两处不符。

### 判据 6 — verify 命令 → **满足**

`pnpm typecheck` 退出 0；`pnpm test` 退出 0（110/110，R1）。补充跑了 `pnpm pack --dry-run`、`node lib/bin.js doctor --json`（t3 契约的第 4 条 verify）均 0。

---

## 4. 发现清单（按严重度）

### F1【medium·功能/正确性】目录只在路由被调用时才与上游同步；冷启动选择器为空，陈旧白名单可让请求静默回落

- **证据**：
  - 挂载只读缓存不上网：`src/index.ts:220-224` 仅 `catalog.hydrate()`。
  - `/models` 上游请求只有四个触发点：`GET /status`（登录时 `ensure({allowNetwork:true})`，`src/routes.ts:127-135`）、`GET /diagnostics`（`refresh`，:179）、`POST /refresh`（:317）、baseURL volatile 变更（`src/index.ts:211-217`）。**推理路径从不刷新**：`buildModels` 同步读缓存且不看 `isStale()`（`src/provider.ts:205-213`）。
  - R3 探针（probe4）：全新 `DSH_HOME` + 已登录、从未调用路由 → `adapter.listModels('loomy')` 为 `[]`、上游 `/models` 请求 0 次；调一次 `GET /status` 后立即变为 `['m-a']`。CLI `status/doctor` 只活取不落盘（`src/bin.ts:71-101,143-147`），跑 CLI 也无法预热选择器。
- **影响**：
  1. 全新安装后，用户若不先打开设置卡片，模型选择器里 Loomy 一栏为空——与 `README.md:40`「生效后核对：…模型选择器出现 Loomy 路由的聊天模型」的承诺不符，且文档无此说明。
  2. 目录过期（默认 600s，`src/shared/types.ts:46`）后，仅聊天不碰设置的用户会一直用陈旧白名单：上游下架/改名的 id 仍会被放行到线上，命中 t1 记录的「未知 model 静默回落 spark-x2.6（200，0 分）」——用户以为在跟所选模型对话，实际不是。`src/catalog.ts:5-12` 的模块不变量（「目录是唯一白名单，目录外必须本地失败」）在陈旧态下失效。
- **requiredFix**（约 10 行）：`apply()` 在已登录时 fire-and-forget `void catalog.ensure({allowNetwork:true})`（不阻塞 apply，失败静默）；并在 `buildModels()` 里当 `isStale()` 时触发一次后台 single-flight `refresh()`（下一次请求即新目录）。同时把冷启动行为写进 README 已知限制（若不改代码）。

### F2【medium·凭据隔离语义】`LOOMY_AUTH_SESSION_FILE` 名为 override 实为前置候选，缺省回退真实登录文件

- **证据**：`src/shared/paths.ts:60-104`（env 候选 :65-69 push 在最前，darwin/win/linux 默认候选随后仍全部尝试）；文档表述「override the desktop sign-in file」（`src/shared/paths.ts:20-21`、`src/bin.ts:59`、`docs/dsh-plugin-contract.md` 同义）。评审取证实锤：指向不存在 fixture 时 `resolveApiKey` 返回真实 session（值未记录、未复述）。
- **影响**：以「隔离」为目的设置该变量的测试/脚本，在 fixture 缺失或损坏时会静默拿到真实凭据并发往当时配置的 `baseURL`（R3 那类假上游、或用户自定义网关）。既有测试因额外隔离 `HOME` 才幸免。
- **requiredFix**：env 存在时**只**使用它（不追加默认候选），或至少在回退到默认候选时 `logger.warn`；并更正两处「override」措辞为「优先候选（缺省回退桌面默认路径）」或改行为。

### F3【low·错误分类残留】对话路径的 HTTP 200 + envelope 失败（登录失效/积分不足）被归为可重试 `TRANSPORT`

- **证据**：R2 场景 E/F；机制见 §3 判据 2。pi-ai 对 200 + 非 SSE JSON 体读不到任何 `data:` 帧 → 「Stream ended without finish_reason」→ `TRANSPORT`。
- **影响**：预检（`src/auth.ts:300-366`，TTL 60s、每次 stream 调用冻结凭据）已把绝大多数「登录失效」挡在派发前并给出可执行文案；但会话在预检后失效、或凭据对平台有效而对对话失效（t1 未实测项）时，用户看到的是「流被截断」而非「请重新登录/积分不足」。SDK 层重试为 0（`dsh-llm-pi-ai/lib/index.js:1789` `maxRetries:0`），是否重试取决于宿主是否装配 dsh-llm-retry——不会放大请求量，但消息类别有误导。
- **requiredFix（建议）**：流以 `TRANSPORT` 结束且 usage=0、内容为空时强制做一次（force）预检再决定是否升级为 `MISSING_CREDENTIAL`；或在 README/契约文档「已知限制」明确该残留（现 README:101 只写了非流式 JSON 会被判 TRANSPORT，未提鉴权失败同型）。

### F4【low·文档失真】README 两处与实现/上游证据不符

1. `README.md:11`「图片模型没有 `capabilities` 字段，被过滤」——与 t1 §11 更正及 `.refs/loomy-models.json` 实测相反：图片模型**有** capabilities（`type:'image'`、`output_modalities:['image']`）；实现靠 `type!=='chat'` 与 output_modalities 过滤（`src/catalog.ts:61-66`），结论不变但论据错。`src/catalog.ts:52-55` 的注释写法是对的。
2. `README.md:51`「配置（设置 → Loomy 卡片或 cordis 配置）」——卡片三栏（账号/模型/诊断）不渲染任何 Config 字段（`src/client/` 无 `baseURL/sessionTtlMs/...` 引用），且宿主主动关闭了自动生成表单（`src/index.ts:124-126` `configure({auto:false})`），这 8 个键目前**只能**通过 cordis/profile 配置修改。README 应改为「cordis 配置」，或由卡片/设置表单补齐入口。
- **requiredFix**：更正 README 两处措辞（README 归 captain）。

### F5【low·打包隐私】`files` 含 `docs/`，发布物携带内部工程文档

- **证据**：`pnpm pack --dry-run` 包含 `docs/dsh-plugin-contract.md`、`docs/loomy-upstream.md`、`docs/verification-report.md`；其中 20 处 `/Users/benny/...` 绝对路径（contract 9、verification 8、README 3）、4 处 `$HOME/Library/Application Support/loomy` 路径、`.refs/RECON.md` 等不随包发布的引用，以及脱敏后的账号片段（`189****2700`、`2611**********7535`）。
- **影响**：无凭据泄漏（t1 脱敏要求达成），但发布物携带开发者本机路径与内部引用，对最终用户是噪音、对隐私是轻度暴露。
- **requiredFix（建议）**：`package.json.files` 移除 `docs/`（或只保留面向用户的说明），内部文档留在仓库不发布。

### F6【info·竞态，自愈】两处单飞槽位的轻微竞态

- `createAuthStore.read({force:true})` 在已有非 force 读在飞时返回该在飞读（`src/auth.ts:257-268`）——「重新检测」恰逢在飞读时可能报告一次登录前状态（≤5s TTL 窗口）。
- `createSessionPrecheck` 的 pending 槽被旧指纹的 `finally` 提前清空（`src/auth.ts:359-364`）——旧请求完成时会清掉新指纹的在飞标记，可能多打一次 `/user/identity`；结果仍正确（verdict 按指纹缓存）。
- 均无正确性影响；如需修，`pending` 按指纹分桶即可。

### F7【info·已文档化】`/save` 对目录外 id 静默丢弃

`src/catalog.ts:322-342`（注释明确「stale card 不得让已下架模型复活」），契约 v2 与 `README.md:13` 一致，`tests/host/catalog.test.mjs:183-222` 覆盖。列为记录，不要求修改。

---

## 5. 无法在本仓库验证的事项（如实声明，非缺陷）

| 项 | 原因 | 现有证据边界 |
| --- | --- | --- |
| 真实 `web` profile 挂载与浏览器渲染 | 本会话沙箱不可写 `~/.dsh`、不重启 3080 实例 | t5 §9.2 给出权威步骤；`scripts/verify/mount-fixture.mjs` 已用真实 `lib/index.js` 的 `apply` 验证装配 |
| `loader/volatile-update` 事件的真实发布时机 | loader 是宿主包，仓库内无该 npm 依赖可执行验证 | 契约文档 §1.3（其第 144 行给出宿主行号出处）；R3 用替身事件验证了**响应侧**逻辑正确 |
| dsh-llm-retry 的真实重试循环 | 仓库依赖树未装该插件 | `retryableCodes` 声明正确（R2）；SDK 层 `maxRetries:0`（`dsh-llm-pi-ai/lib/index.js:1789`） |
| 上游 429/5xx/401、积分耗尽、上下文超限的真实文案 | t1 列为未实测（17 条），不做真机付费探测 | 分类器行为已在 R2 用等价报文验证；残留见 F3 |
| state 目录在「已存在但权限更松」时的收紧 | 实现只对新目录设 0700，不 chmod 已有目录 | 实际部署中目录由本插件首建（`mkdir recursive`），风险有限 |

---

## 6. 结论

宿主侧实现的**代码质量与测试密度显著高于通常核心可用版标准**：单路由身份四层同键、凭据面收敛、守卫顺序正确、0600/0700 落盘、110/110 离线用例、真机 CLI 脱敏输出均经独立复核确认。t3 的 8 条验收标准 8/8 判定为满足，t6 的 6 条扩展判据全部满足（3 条附非阻塞发现 F3-F5）。

不满足「直接可交付」的原因集中在两处可小步修复的行为缺陷：

1. **F1**：目录与上游的同步完全寄生在设置路由上——冷启动选择器为空（违背 README 承诺且无说明），陈旧白名单会让已下架模型命中上游静默回落，破坏 `catalog.ts` 自己声明的「目录外必须本地失败」不变量。
2. **F2**：`LOOMY_AUTH_SESSION_FILE` 的「override」语义与「前置候选+回退真实文件」实现不一致，隔离场景可能把真实凭据送往任意 baseURL（评审中实际触发一次）。

判定：**needs_revision**。建议 captain 把 F1（index.ts/provider.ts 约 10 行 + 一句 README 说明）与 F2（paths.ts 行为或文档二选一）派回宿主实现方修复后复验；F3-F7 可作为后续小改进或记录，不阻塞。

---

## 7. 复审（t8 · repair round 2，2026-11-14 21:43）

复审对象：t7「repair-round-2」交付（F1/F2/F3 由宿主实现方修复，F4/F5 由 captain 修复）。本轮只做增核：新改动全部通读 + 四组独立取证复跑（R2'/'R3' 为上轮同一方法的新探针 probe6-probe12，位于 `/tmp/loomy-review/`）。

### 7.1 验证命令（复审自跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 退出 0 |
| `pnpm test` | 退出 0，**122/122**（上轮 110 + 新增 12：apply 2 / auth 2 / catalog 2 / provider 6） |
| `pnpm build` | 退出 0，四产物存在（lib/index.js 81.6KB、lib/index.d.ts 30.8KB、lib/bin.js 42.5KB、lib/client.js 71.6KB） |
| `node lib/bin.js doctor --json`（真机） | 退出 0：掩码账号、三探针 ok、catalog 6/6、stdout 无 hex32/11 位手机号、stderr 0 字节 |
| `pnpm pack --dry-run` | 白名单 = lib + locale + cordis.patch.yml + README + LICENSE + package.json，**docs 已移出**（F5 关闭） |

### 7.2 F1（medium→关闭）冷启动目录预热 + 陈旧白名单自愈

- 实现：`src/index.ts:226-238`（apply 尾部 fire-and-forget `auth.read()` → 已登录才 `catalog.ensure({allowNetwork:true})`，`.catch` 吞 rejection）；`src/catalog.ts:300-318` `kickStaleRefresh`（`isStale()` 才触发、每 TTL 窗口最多一次、`void refresh().catch()` 单飞不叠加）；`src/provider.ts:315-335` `buildModels()` 同步触发 kick 且 try/catch 包裹（不违反 pi-ai「getModels 同步且不抛」契约）。
- 独立取证（probe6）：全新 `DSH_HOME` + 已登录 → `apply()` 墙钟 **1ms**、同步期上游请求 **0**；后台完成后 `/models` 恰 1 次、`llm/models-updated` 发出、`listModels` 立即列出模型、state.json 落盘 0600。再把 `catalogTtlMs` 置 0 强制陈旧：`getModels()` 第一读仍回旧目录（契约注释「新目录下一次读生效」），后台刷新恰好 1 次、第二读即新目录。
- 回归测试：`tests/host/apply.test.mjs:106-143`（apply 先注册路由且同步期 0 请求 → warm-up 后发出 + 事件发出）、`:145-171`（未登录不 warm、rejection 被 process.on('unhandledRejection') 监视证明吞掉）；`tests/host/catalog.test.mjs:387-460`（kick 同步不阻塞/成功只 1 次/失败每 TTL 窗口最多重试一次）；`tests/host/provider.test.mjs:551-575`（每次同步读都 kick、catalog 节流；kick 钩子抛异常不违反 getModels 契约）。
- README 已知限制补齐（`README.md:102`）：「冷启动：挂载时会在后台拉取目录，拉取完成前模型选择器可能短暂为空……」。**F1 关闭**。

### 7.3 F2（medium→关闭）`LOOMY_AUTH_SESSION_FILE` 改为独占替换

- 实现：`src/shared/paths.ts:71-74`（env 非空 → **直接 return 单元素候选列表**，桌面默认路径完全不检查）；文档同步 `src/shared/paths.ts:20,60-65`（"replaces"/"exclusive replacement"）、`src/bin.ts:5-9`（模块注释）、`src/bin.ts:60`（help 文案 "use exactly this sign-in file (no desktop fallback)"）。
- 独立取证（probe7）：env 指向不存在文件 + `$HOME` 下存在桌面形态登录文件 → `readAuthSession` 只检查 env 路径、`found:false`、无 session。
- 回归测试：`tests/host/auth.test.mjs:207-218`（即使 $HOME 有真形态凭据，候选也仅 env 一条；空串不算路径）、`:220-240`（env 不存在 → found:false 且不回退桌面）。**F2 关闭**。

### 7.4 F3（low→关闭）空且零 token 的 TRANSPORT 终局升级为可执行错误

- 实现：`src/provider.ts:212-223` `chunkHasContent`（text/reasoning/tool 增量才算有输出）+ `src/provider.ts:242-311` `LoomyAdapter extends PiAiAdapter`（仅覆写两个公开契约方法 `stream`/`prepareCall`）：终局 chunk 为 `TRANSPORT` 且无任何内容、`outputTokens===0` 时 force 一次身份预检，**仅 definite** 才抛 `MISSING_CREDENTIAL`（`upgradeAmbiguousTransport` 自身 try/catch，探针失败绝不替换原始可重试失败）。`prepareCall` 覆写保 `{model, stream}` 完整返回（`PreparedAdapterCall` 恰好两字段，`dsh-llm/lib/types/index.d.ts:118-123`），且基类 `prepareCall` 内部直接闭包 `streamWithSnapshot`（`dsh-llm-pi-ai/lib/index.js:1967-1973`），两条生产路径各恰好一层 guard、不叠加。
- 独立取证（probe11，完整插件挂载 + 真实 auth store + 真实 `createSessionPrecheck` + 真实环回上游，身份探针「首 ok、后死」语义）：

| 场景 | 结果 | identity/chat 调用 |
| --- | --- | --- |
| (a) 200+envelope `100002`，空流，身份探针证实死亡 | **THREW MISSING_CREDENTIAL**（含上游 100002 + 「请重新登录」可执行文案） | 2/1（恰 1 次强制探针） |
| (b) 200+envelope `100003 积分不足`，身份探针证实死亡 | MISSING_CREDENTIAL（身份为准：会话确实死了） | 2/1 |
| (c) 有正文的静默截断 | 保持 `TRANSPORT`，**无**额外探针 | 1/1 |
| (d) 合法 reasoning-only `length` | `max-tokens`（非错误），无探针 | 1/1 |
| (e) `stop` 且零内容 | `EMPTY_RESPONSE`，无探针 | 1/1 |
| (f) 身份探针自身连接被重置（indefinite） | 保持 `TRANSPORT`（可重试），不冒充鉴权 | 2/1 |
| (g) 身份探针证实会话仍有效、仅对话被拒 | 保持 `TRANSPORT`（残留，见 N4） | 2/1 |

- 回归测试：`tests/host/provider.test.mjs:577-744`（六条 F3 用例覆盖升级、prepareCall 生产路径、indefinite 不升级、有正文不探针，并用 `prechecks=[false,true]` 精确断言强制探针次数）。**F3 关闭**。

### 7.5 F4/F5（low→关闭，captain 修复）

- `README.md:11` 更正为「图片模型虽带 capabilities，但 type 为 image、output_modalities 为 ["image"]，因此按 type 与输出模态过滤」——与 `.refs/loomy-models.json` 实测及 `src/catalog.ts:56-92` 一致；`README.md:51` 配置节改为「cordis / profile 配置，暂不在卡片里编辑」并说明 auto:false 的含义——与实现（卡片无 Config 字段、`src/index.ts:124-126`）一致；`README.md:102` 补冷启动说明。`package.json.files = ["lib","locale","cordis.patch.yml","README.md","LICENSE"]`（docs 移出），pack 白名单核对通过。**F4/F5 关闭**。

### 7.6 复审遗留观察（全部不阻塞）

| # | 观察 | 证据 | 建议 |
| --- | --- | --- | --- |
| N1 | 冷启动 warm-up 在 `enabled=false` 时也会发一次（免费的、已认证的）`/models` 请求 | probe12：enabled=false 挂载后 `/models` 调用 1 次 | 后续可把 warm-up 门在 `isEnabled()` 上 |
| N2 | indefinite TRANSPORT 每次失败都会 force 一次身份探针（force 无速率限制） | `src/auth.ts:359-371` force 绕过 TTL；重试策略下每次重试至多 1 个小 GET，有界 | 可接受；若要收紧可给 force 加最小间隔 |
| N3 | `README.md:77` 仍写「110 用例」（现 122）、结构清单未列 `tests/host/apply.test.mjs` | README 差异 | 顺手更正（captain 文件） |
| N4 | 会话有效但对话端被拒（chat-only 100002/积分类）仍呈现为可重试 `TRANSPORT` | probe11(g) | pi-ai 分类层无响应拦截点（`PiAiAdapterOptions` 无 onResponse 钩子），插件层已尽力（guard 只在身份也判死时升级）；残留与 README:106 的 JSON 应答说明同型，属上游契约固有限制 |

### 7.7 复审判据结论

t3 八条验收 + t6 六条扩展判据全部维持「满足」，其中判据 2（provider/选择器）的 F1 保留项已由冷启动预热 + 陈旧自愈消除（probe6 实证），判据 3（凭据边界）的 F2 保留项已由独占 env 语义消除（probe7 实证），判据 4（错误/截断映射）的 F3 残留已收敛为「空且零 token 才探针、仅身份证实死亡才升级」（probe11 实证）。F6（可选竞态）与 F7（已文档化行为）维持记录不变。

**复审判定：pass——宿主侧实现可交付。**

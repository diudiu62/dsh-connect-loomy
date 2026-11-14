# dsh-connect-loomy 独立验证报告（T5 + T9 重验）

- 验证人：`verifier-2`（与 host/client 实现者不同人，未参与 `src/` 实现）
- 日期：2026-11-14（t5 初验 21:0x；**t9 返修后重验 22:05–22:12，见文末「返修后重验」一节——阅读现状以该节为准**）
- 验证对象：本仓库 `/Users/benny/Documents/dsh-connect-loomy`（包名 `dsh-connect-loomy@0.1.0`，host 0.2.2-rc.1）
- 写域：本报告 + `scripts/verify/`；其余文件只读。**没有修改 `src/`、`tests/`、`package.json`、`README.md`、`.refs/`。**
- 边界：按任务要求 **不重启当前 DSH**、**不发送会扣费的真实对话**。当前 GUI（pid 88578，`127.0.0.1:3080`）未受影响（验证结束时 HTTP 401 正常响应）。

## 0. 结论

> 本表为 **t9（返修后）结论**；t5 时点的初验结论与其证据保留在 §1–§13（个别数字以 t9 注为准）。差异逐条见文末 R4。

| # | 验收项 | 结果 | 证据位置 |
| --- | --- | --- | --- |
| 1 | 干净检出 install/typecheck/test/build 全绿，逐条记录命令与退出码 | **通过**（`pretest` 已消除 t5 记录的字面顺序问题） | §2、R1 |
| 2 | 入口产物：`main`/`exports`/`bin` 指向的文件全部存在 | **通过** | §3 |
| 3 | 假上游端到端：Bearer + traceparent/chatid/msgid/loomy-version，流式收尾、静默截断可重试 | **通过（非流式 JSON 另列为限制 L3/N4）** | §4–§5、R2.3 |
| 4 | 凭据卫生：仓库/产物/CLI 输出无真实 session、完整手机号、真实 userid | **通过** | §7、R3 |
| 5 | 真机 CLI `status --json` / `doctor --json` 可运行、账号脱敏、余额真实 | **通过** | §8、R1 |
| 6 | 安装说明可执行，与实际产物、包名一致，并说明重启后生效 | **通过**（权威步骤在 §9.2；README 过时项 F1 已由 captain 修复） | §9 |
| 7 | 未通过项如实列出，不把「没验证」写成「通过」 | **通过** | §10、R4-D9 |

**总体结论（t9）：当前字节可交付，0 blocker。** t5 的 3 个发现（F1 README、F2 pretest、F5 docs 入包）已全部修复并在当前字节核实；t6 的 F1/F2/F3 三个修复在当前字节上独立复核成立（21/21 项）。三项专门攻击面（auth 覆盖回传、契约 v2 运行时一致性、凭据卫生）继续全部通过，且都用 `lib/` 产物 + 真实环回 HTTP 驱动，不碰 `src/`。

## 1. 环境与验证方法

| 项 | 值 |
| --- | --- |
| macOS（Darwin 24.x, arm64） | 本机 |
| Node | `v22.23.2` |
| pnpm | `12.11.2` |
| DSH | `0.2.2-rc.1`（`dsh --version`） |
| 本机 Loomy 登录态 | 存在：`~/Library/Application Support/loomy/auth-session.json`（只读；值在本报告中一律不出现在任何输出里） |
| 上游 | `https://loomyad.xunfei.cn/api/v1`（仅调用只读平台接口 `/models`、`/points/records`、`/user/identity`） |

验证脚本（全部在 `scripts/verify/`，驱动 **构建产物 `lib/`**，不是 `src/`）：

| 脚本 | 作用 | 结果 |
| --- | --- | --- |
| `verify-entry-artifacts.mjs` | 清单承诺的每个入口/文件存在且可用；client 是 loader factory；CLI shebang/执行位/`--help` | 8/8 |
| `verify-auth-override.mjs` | 认证覆盖回传 + 两套头隔离（专项 1） | 6/6 |
| `verify-e2e-fake-upstream.mjs` | 本地 OpenAI 兼容 mock 端到端（专项 3） | 21/21 |
| `verify-contract-v2.mjs` | 契约 v2 运行时一致性（专项 2） | 8/8 |
| `verify-credential-hygiene.mjs` | 真实凭据/PII 精确扫描 + CLI 输出扫描（专项 3） | 7/7 |
| `run-all.mjs` | 汇总上述 5 个脚本（t5 核心套件） | 5/5 脚本 |
| `clean-checkout.sh` | 干净副本 install→typecheck→test（pretest 先 build）→build→test→check→核心套件→修复探针 | 全绿 |
| `verify-cold-start.mjs` / `verify-auth-env-exclusive.mjs` / `verify-transport-precheck.mjs` + `run-repairs.mjs` | t7 三个修复点的回归探针（t9 新增，见文末 R2） | 7/7、5/5、9/9 |

```bash
pnpm install && pnpm build          # 脚本依赖构建产物
node scripts/verify/run-all.mjs     # t5 核心套件，exit 0 = 全部通过
node scripts/verify/run-repairs.mjs # t9 修复探针（F1/F2/F3）
bash scripts/verify/clean-checkout.sh
```

> **t9 注**：本节及 §1–§13 记录的是 t5 时点的字节（110 用例）。当前字节（122 用例、t7 修复后）的重验结果见文末「返修后重验」一节；两节之间的差异已逐条对齐（110→122、pack 清单、L1/F1/F2 的修复等）。

## 2. 干净检出验证

方法：`rsync` 只复制检出会有的文件（排除 `node_modules/`、`lib/`、`.refs/`、`.agent-teams/`、`.memsearch/`、`.pnpm-store/`、`.pnpm-cache/`），在 `mktemp -d` 目录里执行。可复现脚本：`scripts/verify/clean-checkout.sh`。下表为 **当前字节**（t9 22:05–22:12）重跑结果——t5 时点的字面顺序差异已由 `pretest` 消除（见 R4-D1）。

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm install` | 0 | 按 lockfile 安装（npmmirror，3.1s 级） |
| `pnpm typecheck` | 0 | host + client 两套 tsconfig |
| `pnpm test`（洁净副本；`pretest` 先 build） | 0 | **122/122** 通过（host 84 + client 36 + smoke 2） |
| `pnpm build` | 0 | 产出 `lib/index.js`、`lib/index.d.ts`、`lib/client.js`、`lib/bin.js` |
| `pnpm test`（显式 build 之后） | 0 | 122/122 |
| `pnpm check`（typecheck→build→test） | 0 | 仓库完整门禁 |
| `node scripts/verify/run-all.mjs`（在干净副本中） | 0 | 5/5 脚本、50 项检查全部通过（含真机 CLI 与真实凭据扫描） |
| `node scripts/verify/run-repairs.mjs`（在干净副本中） | 0 | 3/3 脚本、21 项修复探针全部通过（见 R2） |

**结论**：干净检出上验收链 `install → typecheck → test → build` 全部为 0，`pnpm check` 与两套验证脚本同样全绿。

## 3. 入口产物校验

`node scripts/verify/verify-entry-artifacts.mjs` → 8/8。逐项：

| 检查 | 结果 |
| --- | --- |
| `package.json` 的 `name/type/dsh.bundle.patch/dsh.client.platform` 自洽 | pass |
| `main`→`lib/index.js`、`types`→`lib/index.d.ts`、`bin`→`lib/bin.js`、`exports` 的每个目标、`files` 的每一项都存在且非空 | pass |
| host 入口导出 loader 契约：`name="connect-loomy"`、`inject` 含 `llm`、`apply`/`Config`/`createProviderRuntime`/`registerLoomyRoutes` 均为函数；`.d.ts` 有对应声明 | pass |
| client 入口是 `window.__ModuleLoader__.load({ id: "dsh-connect-loomy", factory: (require) => … })`，首尾完整；运行期只 `require("react")` / `require("react/jsx-runtime")`（无 node: 内建、无相对路径） | pass |
| CLI：首行 `#!/usr/bin/env node`、文件有执行位、`node lib/bin.js --help` 打印用法（exit 0） | pass |
| `cordis.patch.yml` 的 `insert` id/name 与包名一致 | pass |
| `locale/{en,zh}.json` 可解析且 `meta.title=dsh-connect-loomy` | pass |

产物（**2026-11-14 22:05 当前字节**重建，sha256；t5 时点的旧哈希见 R0）：

| 文件 | 大小 | 模式 | sha256（前 16 位） |
| --- | --- | --- | --- |
| `lib/index.js` | 81,573 B | 0644 | `e957bdfb8747eb37…` |
| `lib/index.d.ts` | 30,804 B | 0644 | `df13849c462bd33b…` |
| `lib/client.js` | 71,558 B | 0644 | `ccb830c3ba826caf…`（未变） |
| `lib/bin.js` | 42,453 B | **0755** | `959e28f82b04482f…` |

打包清单（`npm pack --dry-run --json`，13 个文件，`unpackedSize=637433`）：`LICENSE`、`README.md`、`cordis.patch.yml`、`lib/{index.js,index.d.ts,index.js.map,client.js,client.js.map,bin.js,bin.js.map}`、`locale/{en,zh}.json`、`package.json`。**`src/`、`tests/`、`scripts/`、`.refs/` 均不入包**；`lib/bin.js` 的模式在 tar 中保留为 `0755`。

## 4. 假上游端到端

方法：`scripts/verify/mock-upstream.mjs` 起一个真实 `node:http` 服务（127.0.0.1，随机端口），同时实现 Loomy 平台三接口与 OpenAI 兼容 `/chat/completions`；`scripts/verify/mount-fixture.mjs` 用最小 cordis 替身执行 **`lib/index.js` 的真实 `apply`**（设置节、`llm.registerAdapter`、五个 exact 路由都在），路由由真实 `node:http` 服务承接。`HOME`/`DSH_HOME`/`LOOMY_AUTH_SESSION_FILE` 全部重定向到临时目录，**绝不读真实登录态**。

mock 行为：平台接口只认 `token:`（缺失 → 200 + `{"code":"100002","desc":"缺少 token"}`）；对话接口只认 `Authorization: Bearer`（否则 200 + `100002 登录已失效`）；SSE 帧与真机同形（含独立 `choices:[]` 的 usage 帧）。

`node scripts/verify/verify-e2e-fake-upstream.mjs` → **21/21**。要点：

### 4.1 请求形态（流式）
- `POST /api/v1/chat/completions`，`authorization: Bearer <session>`，**没有** `token:` 头；
- `traceparent` 匹配 `00-<32hex>-<16hex>-01`、`chatid` 形如 `chat-<uuid>`、`msgid` 形如 `msg-<uuid>`、`loomy-version: 0.9.39`、`invokeorigin: user`；
- 第二次 dispatch 的 `msgid/chatid/traceparent` 全部重新生成（消息级唯一）；
- body：`model=<请求的 id>`、`stream: true`、`stream_options.include_usage: true`、`max_tokens: 64`（不是 `max_completion_tokens`）、`reasoning_effort: "high"`、无 `store`；
- 模型目录来自 `/models` 且只注册 3 个 chat 模型：`spark-x2.6`、`qwen3.8-flash`、`DeepSeek-V4.1-Flash`；`auto`、图片模型、非 `openai_chat` 协议模型全部被过滤。

### 4.2 收尾与截断分类
| 场景 | mock 行为 | 观测结果 |
| --- | --- | --- |
| 流式正常 | 增量 delta + `finish_reason:"stop"` + 独立 usage 帧 | `finish.reason={kind:"stop"}`，文本 `你好，我是 Loomy mock。`，reasoning 保留，usage `totalTokens=20` |
| 单帧完整应答（增量形态的“非流式”上游应答） | 一个帧同时含完整 content + `finish_reason:"stop"` | `stop`，文本完整 |
| reasoning-only 长度截断 | `content:""` + `finish_reason:"length"` | `{kind:"max-tokens"}`，**不是** `EMPTY_RESPONSE` |
| **静默截断** | 有 delta，随后直接 `data: [DONE]`、无任何 `finish_reason` | `{kind:"error", failure.code:"TRANSPORT"}`，消息 `Stream ended without finish_reason`；`TRANSPORT` 在 provider 的 `retryPolicy.retryableCodes` 里 → **可重试失败，绝非成功** |
| 真 JSON 非流式应答 | `content-type: application/json` 的 `chat.completion` | 同样判为 `TRANSPORT`（不挂起、不误判成功）。见 §10 L3 |

### 4.3 平台头隔离
- `/models`、`/points/records`、`/user/identity` 的每一次请求都只带 `token: <session>`，**从不带 `authorization`**；
- 对话请求从不带 `token:`；
- 反向证明：mock 对“只带 Bearer 的平台调用”和“只带 token 的对话调用”都回 `200 + 100002`，与真机行为一致（两套头不可互换）。

### 4.4 宿主状态与日志
- `DSH_HOME/storages/dsh-connect-loomy/state.json` 模式 **0600**，目录 **0700**，内容无 session/手机号/userid，无残留 `.tmp`；
- 插件自身日志行不含 session；
- `GET /status`、`/credits`、`/diagnostics` 的响应体都不含 session/完整手机号；`cache-control: no-store`。

## 5. 专项 1：auth 覆盖回传（唯一“挂载后必炸”缺陷的回潮防线）

机制：`PiAiAdapter` 在每次请求前调用 `Models.applyAuth()`；请求级 `apiKey`（宿主传入的桌面 session）会进入 `provider.auth.apiKey.resolve({credential})`。`src/provider.ts:219-241` 必须把它回传成 `{auth:{apiKey: credential.key}}`；若返回 `undefined`，`applyAuth` 直接抛 `Provider is not configured: loomy`，**在任何网络 I/O 之前**失败——CLI/doctor/status 都发现不了。

`node scripts/verify/verify-auth-override.mjs` → **6/6**，不修改 `src/`，在真实环回网关上证明：

| 检查 | 证据 |
| --- | --- |
| 回传版（`echo`） | 恰好 1 个请求上线，`authorization: Bearer <session>`，无 `token:`，`finish={kind:"stop"}` |
| 回归版（`return undefined`） | **0 个请求**；`finish={kind:"error", failure.code:"PI_AI_ERROR", message:"Provider is not configured: loomy"}`；且 `PI_AI_ERROR` 不在可重试码里（快速失败，不是伪装成网络抖动） |
| 交付版运行时（`lib/index.js` 的 `createProviderRuntime`） | 真实请求上线，`authorization: Bearer <session>`，`stop`，有文本 delta —— 若有人改回 `undefined`，下一次 `pnpm build` 后本脚本必红 |
| 平台三路径 | 每次只发 `token:`，从不发 `authorization` |
| 交叉头 | mock 对“Bearer-only 平台调用”和“token-only 对话调用”均回 `200 + 100002`（与真机一致） |

对照源码：`@earendil-works/pi-ai/dist/models.js:428-443`（`applyAuth` 对 falsy resolution 抛 `Provider is not configured`）与 `dist/auth/resolve.js:17-22`（请求级 `apiKey` 进入 `resolveApiKey`）。

## 6. 专项 2：契约 v2 运行时一致性

`node scripts/verify/verify-contract-v2.mjs` → **8/8**（真实 `apply` + 真实 HTTP + 真实 mock 上游）：

| 契约 | 实测 |
| --- | --- |
| `GET /status` **无条件**带 `enabledModelIds`（数组） | 首跑=全目录 3 个 id；保存后=已保存 id；保存空数组=`[]` 且字段仍在；**登出时也仍是数组**（字段存在、account=null、nextSteps≥2） |
| `POST /refresh` 的 catalog 项带**已保存勾选**，不是草稿 | 先保存 `qwen3.8-flash`，再 refresh 时故意在 body 里塞两个“草稿 id”；响应中 `enabled` 仍只有 `qwen3.8-flash`；`multiplier` 从名字解析（0.8） |
| `POST /save` 持久化 + 热更新 + 发 `llm/models-updated` | `{ok:true,enabled:["qwen3.8-flash"]}`；state.json 落盘；`adapter.listModels()` 立即只剩该模型；`ctx.emit` 收到 `llm/models-updated`/`loomy` |
| 未知/`auto` id | `save(["qwen3.8-flash","removed-model-id","auto"])` → 只保留 `qwen3.8-flash` |
| 被拒绝的写不落盘 | 无 CSRF → 403 `csrf_invalid`；`text/plain` → 415；选择与模型列表均无变化 |

## 7. 专项 3：凭据卫生

`node scripts/verify/verify-credential-hygiene.mjs` → **7/7**。方法：读取本机 `auth-session.json` 的 session/手机号/userid（**只用于精确匹配，绝不打印**），逐字节扫描：

| 扫描面 | 结果 |
| --- | --- |
| 交付树（排除 `node_modules/`、`.refs/`、团队状态） | **82 个文本文件**（t9 22:05 重跑；t5 时为 77——之后新增的验证脚本本身也纳入扫描），**0 处**真实 session / 完整手机号 / 真实 userid |
| `lib/` 产物 | 0 处真实值 |
| gitignored 侦察目录 `.refs/` | 39 个文件，0 处真实值（仍建议永不入库/不入包；`.gitignore` 已含 `.refs/`） |
| CLI stdout/stderr（`status --json`、`doctor --json`、`status`、`doctor` 四次运行） | 全部 exit 0；**0 处** session/手机号/userid；无 `Bearer` 明文 |
| 插件状态缓存（假上游 E2E 中实际写盘） | 0600 / 目录 0700 / 无 session/PII |

形状级扫描（32+ hex、大陆手机号、18 位 id、`Bearer …`）的命中全部可解释，且**没有一项是真实值**：
- `hex32+`：测试假 session、锁文件 integrity 片段、本验证脚本的 `FAKE_SESSION`；
- `phone-cn`：`src/shared/text.ts` 与 `lib/*.js` 里的**正则字面量** `1[3-9]\d{9}`、测试假号 `13812345678`/`13800001234`；
- `Bearer`：`tests/host/provider.test.mjs` 中的假值断言；
- `lib/` 里没有任何 token 形状的命中（已在脚本中断言）。
- `doctor`/`status` 输出中的账号恒为掩码（`189****2700`）与掩码 userid（`2611**********7535`），路径类字段（`credential.sourcePath`）按设计保留完整绝对路径，不含秘密。

## 8. 真机 CLI

```bash
node lib/bin.js status --json   # exit 0，stderr 0 字节
node lib/bin.js doctor --json   # exit 0，stderr 0 字节
```

`status --json` 关键字段（本机真实登录态，已脱敏；t9 22:05 在当前字节重跑，结果一致）：

| 字段 | 值 |
| --- | --- |
| `account.maskedPhone` / `userId` | `189****2700` / `2611**********7535` |
| `credential.found` / `sourcePath` | `true` / `~/Library/Application Support/loomy/auth-session.json` |
| `catalog` | `total=6, enabled=6`（`spark-x2.6`、`DeepSeek-V4.1-Flash`、`deepseek-v4-flash-1017`、`GLM-5.3-Flash`、`qwen3.8-flash`、`mimo-v2.5`） |
| `credits` | `availableBalance=40496 = balance 35500 + dailyBalance 4996`，`records=12` |
| `upstream` | `https://loomyad.xunfei.cn/api/v1`（models/points URL 同源） |

`doctor --json` 三个探针均 `ok`：`/models`（6 个聊天模型）、`/points/records`（可用 40496）、`/user/identity`（登录态有效）；凭据候选只有一条且 `state=ok`。

说明：以上只调用只读平台接口（不扣积分）；**没有**向 `/chat/completions` 发真实请求（§10 L5）。

## 9. 安装路径（可执行结论）

### 9.1 已实跑：隔离 `DSH_HOME` 下的真实 `dsh plugin add`

为了既能验证“能装”，又不写 `~/.dsh`、不重启当前 DSH，用独立 `DSH_HOME` 做了真实安装：

```bash
# t9（22:06，当前字节重跑；t5 的首轮安装同样通过）
export DSH_HOME=/tmp/loomy-dsh-home-t9
dsh plugin --profile loomy-verify-t9 add file:/Users/benny/Documents/dsh-connect-loomy
# dsh: initialized profile loomy-verify-t9 at /tmp/loomy-dsh-home-t9/profiles/loomy-verify-t9
# + dsh-connect-loomy file:../../../../../Users/benny/Documents/dsh-connect-loomy
# Done in 386ms using pnpm v12.11.2        → 退出码 0

dsh --profile loomy-verify-t9 --dump-config
# 组合出的插件树末尾为：
# == dsh-connect-loomy
# - id: dsh-connect-loomy
#   name: dsh-connect-loomy                 → 退出码 0
```

结果文件（`/tmp/loomy-dsh-home-t9/profiles/loomy-verify-t9/package.json`）：

```json
{
  "dependencies": { "dsh-connect-loomy": "file:/Users/benny/Documents/dsh-connect-loomy" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-connect-loomy"] } }
}
```

`node_modules/dsh-connect-loomy/` 内是构建产物（`lib/`、`locale/`、`cordis.patch.yml`、`README`、`LICENSE`）。这证明：`file:` 安装、**bundle 自动登记到 `dsh.profile.bundles`**（`dsh-plugin-manager` 的 `reconcile`：新依赖声明 `dsh.bundle.patch` 时自动追加并原子写回）、以及 `--dump-config` 组合成功。bare profile 下 pnpm 报 peer 警告，是因为该 profile 只有 `@deepseek-ai/dsh-base`；真实 `web/desktop` profile 自带宿主 bundle，peer 由安装锚点解析（见 F3）。

### 9.2 给 `web` profile 的权威步骤（与实际产物、包名一致）

前置：Node `^22.19.0 || >=24`、pnpm、本机 Loomy 桌面端已登录；仓库在 `/Users/benny/Documents/dsh-connect-loomy`。

```bash
# 1) 构建（dsh 安装的是仓库本身，lib/ 必须存在）
cd /Users/benny/Documents/dsh-connect-loomy
pnpm install
pnpm build

# 2) 装进 web profile（等价于在该 profile 目录执行 pnpm add file:…；
#    DSH 会自动把 dsh-connect-loomy 追加进 dsh.profile.bundles）
dsh plugin --profile web add file:/Users/benny/Documents/dsh-connect-loomy

# 3) 核对 profile 清单（应同时出现依赖与 bundle 两项）
node -e "const p=require(process.env.HOME+'/.dsh/profiles/web/package.json'); console.log(p.dependencies['dsh-connect-loomy'], p.dsh.profile.bundles.includes('dsh-connect-loomy'))"
# 期望输出：file:/Users/benny/Documents/dsh-connect-loomy true

# 4) 只做组合校验（不监听端口）
dsh --profile web --dump-config | grep -A2 -B2 dsh-connect-loomy

# 5) 重启 DSH —— bundle 的 host 半边在启动时加载，**重启后才会生效**
#    （客户端 bundle 另外需要刷新浏览器页面）

# 6) 生效后核对：设置 → Loomy 卡片出现；模型选择器出现 Loomy 路由的聊天模型
node lib/bin.js status --json
# 或者：dsh plugin --profile web exec dsh-connect-loomy status --json
```

卸载：`dsh plugin --profile web remove dsh-connect-loomy`，然后同样重启 DSH。

不生效时优先看：启动日志 `dsh-connect-loomy: mounted (enabled=true, baseURL=…)`；浏览器 Console 是否报 client module 未注册；否则用 `doctor --json` 看三个探针。

### 9.3 未执行的部分（如实说明）

- **没有**对真实 `web` profile 执行第 2 步：那会写 `~/.dsh`（沙箱只允许写工作区）且必须重启当前 DSH。实测证据：`dsh plugin --profile web list` 因 `EPERM ... ~/.dsh/profiles/web/package.json.lock` 失败；`dsh web --help` 因 `EPERM ... ~/.dsh/profiles/web/cordis.yml` 失败。因此“真实 web profile 已装上”属**未实测**（L2）。
- 没有启动任何新 DSH 实例/端口；当前 3080 实例保持原状。

## 10. 未通过 / 未覆盖 / 限制（t5 初验记录；当前状态见 R4-D9）

以下均为“没有验证”，不是“验证通过”。**t9 注**：L1 已由 `pretest` 修复（R4-D1）；其余各项在当前字节上仍未实测。

| 编号 | 项 | 证据 / 原因（t5 时点） | t9 现状 |
| --- | --- | --- | --- |
| L1 | 字面顺序 `install && typecheck && test && build` 在 `test` 处失败 | 干净副本中 `pnpm test` 先于 build 因测试 import `lib/` 而失败（`ERR_MODULE_NOT_FOUND .../lib/index.js`，测试刻意导入构建产物） | **已消除**：`pretest: pnpm run build` 落地，当前字节干净链全绿（§2） |
| L2 | 真实 `web` profile 的 `dsh plugin add` 未执行 | 沙箱 EPERM（见 §9.3）+ 任务禁止重启当前 DSH；隔离 `DSH_HOME` 的真实安装已通过（§9.1） | 维持未实测 |
| L3 | 真正的 JSON 非流式应答不被 pi-ai 流式通道接受 | 该路径在 DSH 里不存在：pi-ai 始终发 `stream: true`（已断言）；mock 回 JSON 时被分类为可重试 `TRANSPORT`，不挂起、不误判成功 | 维持（t8 N4 同型，属上游契约固有限制）；当前字节复测一致（run-all e2e 21/21） |
| L4 | 浏览器里的设置卡片未做真机渲染验证 | 未重启/未打开隔离实例；仅有 36 个 client 单测 + bundle 形状 + host 路由契约 | 维持未实测 |
| L5 | 真实上游推理请求未发送 | 为避免扣积分，`/chat/completions` 只打本地 mock；t1 已取证的头矩阵、长回答（59s/4096 tok）等未在本轮重放 | 维持（t9 同样只打 mock + 只读平台接口） |
| L6 | 重试循环本身未执行 | 只验证了失败分类与 `retryPolicy.retryableCodes` 包含 `TRANSPORT`，没有跑 dsh-llm-retry 的实际重试 | 维持未实测 |
| L7 | 上游异常矩阵（429/5xx/401/超时/上下文超限/硬审核/session TTL）未复现 | mock 只构造了平台 200+envelope 与对话 200+100002 两种失败 | 维持（t9 补充了 100001 indefinite 与身份序列脚本） |
| L8 | `dsh plugin --profile web list` 未跑成 | 同上 EPERM；无法枚举现有 web profile 的插件状态 | 维持 |
| L9 | 其他 DSH 版本兼容性 | 只在 0.2.2-rc.1 验证 | 维持 |
| L10 | 真实 profile 启动时的 peer 解析未验证 | `--dump-config` 只组合 patch，不 import `lib/index.js` | 维持 |
| L11 | 真实 `~/.dsh` 下的 state.json 不存在 | 插件未挂载，未产生真实状态文件；0600/0700 属假上游 E2E 实测 | 维持 |

## 11. 发现（t5 初验提出；修复状态见 R4）

| 编号 | 严重度 | 发现（t5 时点） | t9 状态 |
| --- | --- | --- | --- |
| F1 | **中** | `README.md` 仍停留在 T2 骨架文案，安装章节缺 web profile 步骤 | **已修复**（captain，t6 F4）：README 现为交付版文案，`README.md:77` 写 122 用例、`:102` 补冷启动说明 |
| F2 | 低 | 干净检出下 `pnpm test` 依赖先 `pnpm build` | **已修复**：`package.json` 新增 `"pretest": "pnpm run build"`，干净链实证全绿 |
| F3 | 信息 | bare default profile 安装时 pnpm 报 peer 警告；`web/desktop` profile 自带宿主 bundle，不受影响 | 维持（无需动作） |
| F4 | 信息 | 形态扫描在 `lib/*.js`、`src/shared/text.ts` 命中“手机号形状”，实为脱敏正则字面量；无真实值 | 维持（无需动作）；t9 新增脚本也使用假 fixture，见 R5-R-N1 |
| F5 | 信息 | `.refs/`（gitignored）含假形状，0 处真实值 | 维持；`package.json files` 已移除 docs（t6 F5），`.refs` 从不入包 |

## 12. 复现命令速查

```bash
# 1. 干净检出
bash scripts/verify/clean-checkout.sh        # exit 0；逐条打印每个命令的退出码

# 2. 入口产物
node scripts/verify/verify-entry-artifacts.mjs

# 3. auth 覆盖回传（会起本地 mock，不联网）
node scripts/verify/verify-auth-override.mjs

# 4. 假上游端到端（会起本地 mock，不联网）
node scripts/verify/verify-e2e-fake-upstream.mjs

# 5. 契约 v2
node scripts/verify/verify-contract-v2.mjs

# 6. 凭据卫生（需要本机真实登录态；只读，不出网）
node scripts/verify/verify-credential-hygiene.mjs

# 7. 真机 CLI（只读平台接口，不扣积分）
node lib/bin.js status --json
node lib/bin.js doctor --json

# 8. 一键（t5 核心套件 + t9 修复探针）
node scripts/verify/run-all.mjs
node scripts/verify/run-repairs.mjs
```

## 13. 附：本次验证没有改动的东西

- `src/`、`package.json`、`tsconfig*`、`tsdown.config.ts`、`cordis.patch.yml`、`locale/`、`tests/`、`.refs/` 全部只读；t5 新增仅 `scripts/verify/**` 与本报告，t9 亦只追加 `scripts/verify/{verify-cold-start,verify-auth-env-exclusive,verify-transport-precheck,run-repairs}.mjs` 并更新本报告。
- 没有写 `~/.dsh`（真实 `web` profile 未动），没有启动/重启任何 DSH 进程；隔离安装与 mock 均落在 `/tmp`。
- 没有打印任何真实 session / 完整手机号 / 真实 userid；本报告中的账号均为掩码。

---

# 返修后重验（T9 · repair round 2，2026-11-14 22:05）

> 本节由 t9 追加。§0–§13 描述的是 **t5 时点的字节**（110 用例、无冷启动预热、env 优先级语义、TRANSPORT 一律可重试）。t6/t7 返修已改变其中部分结论；本节在 **t7 之后的当前字节**上重新执行全套验证，并逐条标注「t5 原结论 → 本次结论」的差异。阅读时以本节为准；§1–§13 保留作为历史取证。

## R0. 字节基线

| 项 | 值 |
| --- | --- |
| 重验时点 | 2026-11-14 22:05–22:12（t7 返修 + t8 复审 + t6 判据全部关闭之后） |
| 测试规模 | **122/122**（t5 时 110；新增 12 条回归：apply 2 / auth 2 / catalog 2 / provider 6，分布 `tests/host/apply.test.mjs` 新增 171 行、`provider.test.mjs` 534→741 行） |
| t7 改动的源文件（6 个） | `src/index.ts`（冷启动预热，21b98791…）、`src/catalog.ts`（kickStaleRefresh，4e43ec51…）、`src/provider.ts`（LoomyAdapter guard，342196f4…）、`src/shared/paths.ts`（独占 env，9a959a2d…）、`src/auth.ts`（precheck force 语义，c382553b…）、`src/bin.ts`（help 文案，547a999b…）——sha256 前 8 位 |
| 重建产物（22:05，sha256 前 8 位） | `lib/index.js` e957bdfb、`lib/index.d.ts` df13849c、`lib/client.js` ccb830c3（与 t5 字节一致：客户端未改）、`lib/bin.js` 959e28f8 |
| 包清单 | 13 个文件（`npm pack --dry-run`，unpacked 637,433 B；`files` 已无 `docs`——t6 F5 关闭项保持） |
| 未变 | `package.json` 新增仅 `"pretest": "pnpm run build"`（t5 的 L1 建议已被采纳）；README 已是交付版文案（t5 F1 关闭），`README.md:77` 用例数已写 122 |

## R1. 验证命令与退出码（当前字节）

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | host + client |
| `pnpm test` | 0 | **122/122** |
| `pnpm build` | 0 | 四产物重建，哈希见 R0 |
| `node scripts/verify/run-all.mjs` | 0 | **5/5 脚本、50 项检查全过**（entry-artifacts 8/8、auth-override 6/6、e2e-fake-upstream 21/21、contract-v2 8/8、credential-hygiene 7/7） |
| `node scripts/verify/run-repairs.mjs` | 0 | **3/3 脚本、21 项检查全过**（新增的 t7 修复探针：cold-start 7/7、auth-env-exclusive 5/5、transport-precheck 9/9） |
| `node lib/bin.js status --json` / `doctor --json` | 0 / 0 | stderr 0 字节；掩码 `189****2700` / `2611**********7535`；catalog 6/6；credits `40496 = 35500 + 4996`、12 条流水；doctor 三探针 ok |
| `bash scripts/verify/clean-checkout.sh` | 0 | 干净副本 install=0、typecheck=0、**test=0（`pretest` 先 build）**、build=0、test=0、check=0、t5 套件=0、修复探针=0 |

## R2. t7 三个修复点在当前字节上的独立复核

新增探针 `scripts/verify/verify-{cold-start,auth-env-exclusive,transport-precheck}.mjs`（由 `run-repairs.mjs` 聚合；mock 新增可延迟的 `/models`、可脚本化的身份应答序列、三种截断脚本）。全部驱动 `lib/index.js` 真实 `apply` / `createProviderRuntime`，不碰 `src/`。

### R2.1 F1 冷启动后台预热（7/7）

| 检查 | 结果 |
| --- | --- |
| `apply()` 同步返回、路由已注册、同步期上游请求 **0**（mock 故意延迟 250ms 回 `/models`，apply 墙钟 80ms） | pass |
| 已登录挂载后台预热 `/models` **恰 1 次**，随后 `listModels()` 立即列出 3 个模型、`llm/models-updated` 发出 | pass |
| 预热失败路径：mock 强制 `/models` 回 `100002` → 每个 TTL 窗口**最多 1 次**尝试、rejection 被吞（`unhandledRejection` 监视为空）、挂载不受影响 | pass |
| 未登录挂载：后台 **0** 次上游请求 | pass |
| 推理路径节流：`catalogTtlMs=0`（每次读都陈旧）下连续 3 次 `listModels()`，后台刷新**恰 1 次**（kickStaleRefresh 每 TTL 窗口一次） | pass |
| 观测项 N1（t8 已知，非回归）：`enabled=false` 时预热仍发 1 次 `/models`（免费、已认证），且不注册 provider 路由——按 t8 结论记录为已知行为 | pass（记录性） |

**t5 原结论 → 本次**：t5 §2 的「apply 同步 0 网络」仍成立；新增能力（后台预热 + 陈旧自愈）在当前字节上成立，且失败与节流边界都守住了。

### R2.2 F2 `LOOMY_AUTH_SESSION_FILE` 独占（5/5）

| 检查 | 结果 |
| --- | --- |
| env 指向不存在文件（同目录 `$HOME` 下放真实形态桌面登录文件）→ 候选仅 env 一条、`found:false`、无 session——桌面默认路径**完全不被检查** | pass |
| env 为空串/纯空白 → 回退平台默认（env 非「粘性空」）；env 未设置 → 正常找到桌面 fixture（对照组） | pass |
| 真实 `apply` 端到端：`skipAuthFile`（env 指向缺失文件）+ `HOME` 下有桌面文件 → `GET /status` 报未登录、`account:null`、响应无 session | pass |
| `node lib/bin.js --help` 文档化独占语义（"use exactly this sign-in file (no desktop fallback)"） | pass |

**t5 原结论 → 本次**：t5 时 env 是「优先级提示」（首位失败后仍检查桌面默认），现在改为**独占替换**；fixture 的 `HOME` 重定向因此不再必要但保留为纵深防御。t5 §7 的凭据卫生结论不变且更强了。

### R2.3 F3 空 且零 token 的 TRANSPORT 才 force 预检（9/9）

方法：mock 的对话端**永远 HTTP 200**（与真机一致），`100002` envelope 到 pi-ai 就是「零输出 + Stream ended without finish_reason」的 `TRANSPORT`——正是歧义形态。身份探针用「首 ok、后死/不定」序列脚本化，预检走与 `src/index.ts` 相同的真实 `requestPlatform` 原语。

| 场景 | chat 脚本 | identity 序列 | 结果 |
| --- | --- | --- | --- |
| 空且零 token + 会话死 | `truncationEmpty` | ok→fail(100002) | **抛 `MISSING_CREDENTIAL`**（消息含 100002 与「重新登录」），强制探针恰 1 次，chat 恰 1 次 |
| 空流 + 显式零 usage 帧 + 会话死 | `truncationEmptyUsageZero` | ok→fail | 同样升级 |
| 空且零 token + 会话活 | `truncationEmpty` | ok | 保持 `TRANSPORT`（可重试），探针照跑（definite=false） |
| **有正文**的静默截断 | `truncation` | ok→(未用) | 保持 `TRANSPORT`，**无**强制探针（identity 仅预检 1 次） |
| 空流但 usage 非零 | `truncationEmptyUsageNonzero` | ok | 保持 `TRANSPORT`，无强制探针 |
| 合法 reasoning-only `length` | `lengthOnly` | ok | `max-tokens`，无强制探针 |
| 正常流式 | `stream` | ok | `stop`，无强制探针 |
| **生产路径** `prepareCall().stream()` | `truncationEmpty` | ok→fail | 同样升级（frozen call 路径也有一层 guard） |
| 探针自身失败（indefinite 100001） | `truncationEmpty` | ok→indefinite | 保持原 `TRANSPORT` 可重试失败，不冒充鉴权错误 |

**t5 原结论 → 本次**：t5 §4.2 的「[DONE] 无 finish_reason → 可重试 TRANSPORT」对**有正文/有 token** 的截断仍然完全成立（t5 的 `truncation` 脚本场景在 e2e 套件里原样通过）；变化仅限于新增的**空且零 token** 歧义分支——现在会先探一次身份、仅在身份判死时升级为可执行错误。两份行为共存于当前字节，互不冲突。

## R3. 凭据卫生（当前字节重跑）

`verify-credential-hygiene.mjs` 7/7：交付树 **82 个文本文件**（t5 时 77，新增脚本本身也被扫）**0 处**真实 session/手机号/userid；`lib/` 产物 0 处；`.refs/` 39 文件 0 处；CLI `status/doctor` JSON+human 四次 stdout/stderr 0 处、无 `Bearer` 明文；形状扫描命中仍全部为脱敏正则字面量/假 fixture/lockfile 片段。state.json 0600/0700、无 session（假上游 e2e 中实测）。

## R4. t5 原结论与本次结论的差异清单

| # | t5 原结论 | 当前字节结论 | 备注 |
| --- | --- | --- | --- |
| D1 | 干净检出下字面顺序 `typecheck && test && build` 的 `test` 会失败（L1/F2） | **已消除**：`package.json` 增加 `"pretest": "pnpm run build"`，字面顺序现在全绿（clean-checkout 实证） | t5 F2 采纳 |
| D2 | README 是 T2 骨架文案（F1 中危） | **已消除**：README 为交付版，安装/配置/已知限制齐全，`README.md:77` 写 122 用例、`:102` 补冷启动说明 | t5 F1 + t6 F4 采纳 |
| D3 | pack 含 `docs/`（t5 时未列，t6 F5 提出） | **已消除**：`files` 白名单 13 文件、无 docs | t5 §3 的 pack 清单在本节更新为 637,433 B |
| D4 | TRANSPORT 一律可重试，无身份升级 | **收敛**：空且零 token 才探针、仅 definite 才升级 `MISSING_CREDENTIAL`；其余场景行为不变（R2.3 矩阵） | t6 F3 修复 |
| D5 | env 是优先级提示 | **变更**：独占替换（R2.2） | t6 F2 修复 |
| D6 | 冷启动无预热、目录空要等卡片打开 | **新增**：后台预热 1 次 + 陈旧自愈每 TTL 一次（R2.1） | t6 F1 修复 |
| D7 | 用例数 110 | **更新**：122（报告与 README 均已一致） | 本节与 §2 差异以本节为准 |
| D8 | 非流式 JSON 应答判为可重试 TRANSPORT（L3） | **不变**（仍是 N4/上游契约固有限制），有正文截断不探针的行为也未变 | t8 N4 维持 |
| D9 | t5 未实测项 L2-L11 | **维持未实测**：真实 web profile 挂载（沙箱 EPERM + 禁重启）、浏览器卡片真机渲染、真实上游推理、重试循环本身、上游异常矩阵（429/5xx/401/超时）等仍未跑；本节不把这些写成通过 | 见 §10 |

## R5. 当前遗留（不阻塞）

| # | 观察 | 状态 |
| --- | --- | --- |
| N1 | `enabled=false` 仍 warm-up 1 次 `/models`（免费、已认证） | 在 t9 探针中固化为已知行为（记录性检查），建议后续把预热门在 `isEnabled()` 上 |
| N2 | force 预检无速率限制（indefinite TRANSPORT 每次失败探 1 次） | t8 已评估为有界可接受，维持 |
| N4 | 会话活但对话端被拒（chat-only 100002/积分类）仍呈现为可重试 `TRANSPORT` | t8 已定性为上游契约固有限制（pi-ai 无 onResponse 拦截点），维持；本节 (d)(e) 场景证明修复未扩大该残留 |
| R-N1 | `verify-credential-hygiene.mjs` 的形状扫描现在也会命中 `scripts/verify/*.mjs` 里的假 fixture 值（本轮新增脚本自带假 session/假手机号） | 已核实全部为 `FAKE_*` 假值，无真实值；advisory 列表在脚本输出中可见 |
| R-N2 | `README.md` 的冷启动说明（`:102`）与探针观测一致；`README.md:77` 已写 122 用例 | 无漂移 |
| R-N3 | 验证脚本自身的一次竞态：`verify-contract-v2.mjs` 原先用「删除登录文件后请求 /status」验证登出，会与 auth store 的单飞读（删文件前已发起的读仍可能返回 found）竞态，约 1/3 概率误报；现改为**独立挂载 + `skipAuthFile`**（env 指向缺失文件）的确定性场景 | 修复后连续 5 次 `run-all` 均 5/5；属脚本健壮性，非产品缺陷 |

## R6. 重验结论

**当前字节（t7 修复后）可交付：0 blocker。** t5 的 7 条验收结论全部维持通过（其中 3 条因 D1/D2/D3 的修复而**更强**），三个修复点在当前字节上独立复核成立（21/21 检查），凭据卫生在更大扫描面上仍然干净，遗留观察全部不阻塞且已固化到探针或本节记录。未实测项以 §10 + R4-D9 为准。

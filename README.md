# dsh-connect-loomy

把本机登录的 **Loomy（讯飞办公助手）** 模型接入 DeepSeek Harness 模型选择器，并提供设置卡片（账号 / 模型 / 诊断）与只读积分概览。

- 只依赖本机 Loomy 桌面客户端落盘的登录态（`auth-session.json`），不提供账号、不共享凭据、不绕过计费；每次调用消耗你自己账号的积分。
- 平台接口（模型目录 / 积分 / 身份）走 `token:` 头，对话走 `Authorization: Bearer`——两套头互不通用；上游失败一律 HTTP 200 + envelope `code`，插件不按 HTTP 状态码判错。
- session 只存在于宿主进程内存；浏览器永远拿不到，设置、日志、缓存文件里也不落明文。

## 功能

- **provider 路由 `loomy`**：模型目录来自上游 `GET /api/v1/models`，只注册 `protocol === 'openai_chat' && type === 'chat'` 的模型（图片模型虽带 `capabilities`，但 `type` 为 `image`、`output_modalities` 为 `["image"]`，因此按 `type` 与输出模态过滤；`auto` 会被上游静默回落到默认模型，绝不注册）。模型展示名带上游倍率，上下文与最大输出取自上游目录。
- **图片输入（视觉）**：上游目录里 `capabilities.vision === true` 的模型按 `input: ['text','image']` 注册，图片以 `image_url` + `data:<mime>;base64,…` 内联发送（上游只接受这种形式，见 `docs/loomy-upstream.md` §6）。图片字节经宿主附件服务 `ctx.attachments`（`@deepseek-ai/dsh-attachment-local`，DSH 默认 profile 已挂载）落盘并归一化后读取；同时在文本里给出附件句柄（文件名、请求预览尺寸），若宿主 `fs` 服务可用还会附上只读可读路径。profile 没有该服务时，请求在发出前即报错并指明如何补装，不会静默丢图。
- **设置 → Loomy 卡片**：账号栏（脱敏手机号、登录时间、凭据路径结论、重新检测）、模型栏（刷新目录 → 逐模型勾选 → 保存/放弃；倍率、上下文、最大输出、图片、推理档位）、诊断栏（只读事实表 + 上游错误原文，可整段复制进问题反馈）。
- **勾选是草稿，保存才生效**：目录与倍率随刷新即刻落盘生效，但不覆盖未保存的勾选；保存后热更新路由模型集合（发 `llm/models-updated`），无需重启。
- **只读积分**：余额三桶（`balance` / `dailyBalance` / `availableBalance`）+ 流水，宿主侧 60s TTL + 单飞，失败如实报错、绝不伪造 0。
- **CLI 诊断**：`status` / `doctor`，支持 `--json`，输出脱敏账号与余额。

## 安装（web profile）

前置：Node `^22.19.0 || >=24`、pnpm、本机 Loomy 桌面端已登录、DSH 0.2.2-rc.1。

```bash
# 1) 构建（dsh 安装的是仓库本身，lib/ 必须存在）
cd /Users/benny/Documents/dsh-connect-loomy
pnpm install
pnpm build

# 2) 装进 web profile（DSH 会自动把 dsh-connect-loomy 追加进 dsh.profile.bundles）
#    用 link: 而不是 file: —— 见下方「为什么必须用 link:」
dsh plugin --profile web add link:/Users/benny/Documents/dsh-connect-loomy

# 3) 核对 profile 清单（应同时出现依赖与 bundle 两项）
node -e "const p=require(process.env.HOME+'/.dsh/profiles/web/package.json'); console.log(p.dependencies['dsh-connect-loomy'], p.dsh.profile.bundles.includes('dsh-connect-loomy'))"
# 期望输出：file:/Users/benny/Documents/dsh-connect-loomy true

# 4) 只做组合校验（不监听端口）
dsh --profile web --dump-config | grep -A2 -B2 dsh-connect-loomy

# 5) 重启 DSH —— host 半边在启动时加载，重启后才会生效；客户端 bundle 需刷新浏览器页面
```

生效后核对：设置里出现 Loomy 卡片；模型选择器出现 Loomy 路由的聊天模型；`node lib/bin.js status --json` 返回脱敏账号与余额。卸载：`dsh plugin --profile web remove dsh-connect-loomy`，然后同样重启。

启动日志应出现 `dsh-connect-loomy: mounted (enabled=true, baseURL=…)`；不生效时先用 `doctor --json` 看三个探针（models / points / identity）。

### 为什么必须用 `link:` 而不是 `file:`

`file:` 是**复制**安装：pnpm 会把整个包快照进 profile 的 `node_modules/`，此后仓库里再 `pnpm build` 也不会传到 profile。表现是改了代码、重启、刷新都没有任何变化，而 Console 里连一行日志都没有——非常容易误判成"插件坏了"。

`link:` 建的是软链（`node_modules/dsh-connect-loomy -> <仓库>`），`pnpm build` 之后**重启 DSH** 即生效。

判断当前是哪种装法：

```sh
ls -ld ~/.dsh/profiles/web/node_modules/dsh-connect-loomy   # 以 l 开头 = 软链
```

### 改了代码为什么只刷新浏览器没用

宿主在**启动时**读取客户端 bundle（`lib/client.js`）。改完客户端代码后需要：`pnpm build` → **重启 DSH** → 刷新浏览器。只刷新浏览器会继续跑旧 bundle，且没有任何报错。

客户端挂载时会打一行标记，用来确认当前跑的是哪个版本：

```
[dsh-connect-loomy] client half loaded (settings-section+pill-near-model-v3+login-v4): settings.section + composer readout
```

## 命令行

```bash
node lib/bin.js status --json    # 登录状态 + 目录计数 + 积分概览
node lib/bin.js doctor --json    # 凭据候选路径 + 上游三探针 + 诊断
```

## 配置（cordis / profile 配置，暂不在卡片里编辑）

卡片三栏只做账号、模型与诊断，不渲染 `Config` 字段；宿主也关闭了自动生成的设置表单（`configure({ auto: false })`），因此下面这些键目前通过 cordis / profile 配置修改（改完即时生效，无需重启，`enabled` 除外——它决定路由是否注册）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 主开关；关闭时不注册 provider 路由 |
| `baseURL` | `https://loomyad.xunfei.cn/api/v1` | Loomy 平台 API 基地址 |
| `loomyVersion` | `0.9.39` | 对话请求的 `loomy-version` 头（服务端不校验） |
| `sessionTtlMs` | `5000` | 登录态文件重读间隔 |
| `precheckTtlMs` | `60000` | 登录态上游预检（`/user/identity`）结果缓存时长 |
| `catalogTtlMs` | `600000` | 模型目录缓存时长（0 = 每次都刷新） |
| `creditsTtlMs` | `60000` | 只读积分缓存时长 |
| `creditsPageSize` | `20`（1–100） | 积分流水条数（服务端夹 100） |

所有字段都是 `.volatile()`：设置保存即时生效，无需重启。

## HTTP 路由（设置卡片数据源，均为本机回环）

`GET /plugins/dsh-connect-loomy/status` · `/diagnostics` · `/credits`，`POST /refresh` · `/save`。
读路由只回宿主算好的结果；两个 POST 要求 `Content-Type: application/json` 与 `x-loomy-csrf`（值来自 `GET /status`），缺 token 返回 403。错误统一 `{ ok:false, error:{ code, message } }`；`message` 保留上游原文。

## 开发

```bash
pnpm install
pnpm check   # typecheck + build + test（122 用例）
```

测试为纯离线：fixture + 本地环回 HTTP，不打真上游、不读真实凭据。`node --test "tests/**/*.test.mjs"`（注意 Node 22.23.2 的 `--test` 不接受目录参数）。

仓库结构与契约：

```
src/index.ts            host 半：cordis 插件入口（apply / inject / Config）
src/provider.ts         pi-ai Provider/Model 装配（含认证覆盖回传，见下）
src/{auth,catalog,credits,routes,bin}.ts   凭据 / 目录 / 积分 / HTTP 路由 / CLI
src/shared/             上游 envelope、追踪头、状态缓存、loopback 闸
src/client/             设置卡片三栏（loader factory 产物 lib/client.js）
tests/host/             宿主侧单测（apply/auth/catalog/credits/provider/routes/cli）
tests/client/           卡片组件测试（jsdom）
docs/dsh-plugin-contract.md   DSH 插件契约（逐条含宿主源码行号出处）
docs/loomy-upstream.md        上游契约实测记录（脱敏）
docs/verification-report.md   独立验证报告
```

**实现者注意**：`createProvider` 的 `auth.apiKey.resolve` 必须把请求级覆盖回传成 `{auth:{apiKey: credential.key}}`——pi-ai 的 `applyAuth()` 会把它转发进这个方法，返回 falsy 时**每个推理请求在任何 I/O 之前就失败**（`Provider is not configured`），而 CLI 与 doctor 都发现不了。详见 `docs/dsh-plugin-contract.md` §2.3「认证覆盖的回传义务」。

## 已知限制

- 单账号：跟随本机桌面端当前登录，无多账号池/自动换号；Loomy 无「每日签到」接口，只有首次登录奖励与兑换码，插件不做领取。
- 冷启动：挂载时会在后台拉取目录，拉取完成前模型选择器可能短暂为空（打开设置卡片或稍候即出现）。目录过期后由下一次模型读取触发后台刷新，新目录在下一次读时生效。
- 真实 `web` profile 的挂载与浏览器卡片渲染**未实测**（验证在隔离 `DSH_HOME` 下完成，见 `docs/verification-report.md` §9/§10）；安装路径本身已用真实 `dsh plugin add` 走通。
- 非流式 JSON 应答不被 pi-ai 流式通道接受；DSH 路径恒发 `stream:true`，上游若回 JSON 会被分类为可重试 `TRANSPORT`（不挂起、不误判成功）。
- 上游「未知 model 静默回落」与「视觉仅 data URL」等契约细节见 `docs/loomy-upstream.md`。

## 许可

MIT

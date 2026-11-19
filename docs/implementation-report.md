# 落地记录：改名 + 小浣熊接入（0.2.0）

> 日期：2026-11-17。依据：[rename-and-migration-plan.md](rename-and-migration-plan.md)（执行总表）、
> [product/rename-and-multi-vendor-plan.md](product/rename-and-multi-vendor-plan.md)（产品决策）、
> [raccoon-upstream.md](raccoon-upstream.md)（上游实测）。

## 1. 已落地

| 阶段 | 内容 | 证据 |
|---|---|---|
| A1 | `LEGACY_DATA_ID` 等常量抽出（数据目录仍叫 `dsh-connect-loomy`，**不搬迁**） | `src/shared/paths.ts` 未改动行为；`ls ~/.dsh/storages/` 目录名不变 |
| A2 | `src/shared/profiles.ts`：只读扫 `$DSH_HOME/profiles/*/package.json`，识别「新旧包并存」 | `tests/raccoon.test.mjs` 的 profiles 两组用例 |
| B1 | `routeTable(vendorId)`：路由命名空间参数化，`loomy` 输出逐字节不变 | `tests/raccoon.test.mjs`「loomy namespace is byte-identical」 |
| C1–C3 | 小浣熊 vendor：凭据只读、目录、余额、provider 路由 `raccoon`、卡片只读路由 | `tests/host/raccoon-mount.test.mjs` 4 例 + 真机实测（见 §3） |
| D1 | 改名 `dsh-connect-desktop`：package.json / cordis.patch.yml / client bundle id / settings ns | `dsh --profile web --dump-config` → `id: dsh-connect-desktop` |
| D2 | 卡片路由**双前缀**（新名 + 旧名），0.3.0 撤旧 | `src/vendors/raccoon/routes.ts` 的 `PREFIXES` |
| D4 | 共存守卫：检测到旧包仍在 bundles → **新包让位**（不注册、打日志、给命令） | `mountRaccoonVendor()` 第一段 |
| D5 | bin 双键：`dsh-connect-desktop` + `dsh-connect-loomy` 指向同一入口 | `package.json#bin` |
| — | 文档：上游实测、产品计划、Release/市场文案 | `docs/raccoon-upstream.md`、`docs/product/`、`docs/release/`、`docs/market/` |

## 2. 明确未做（下一批）

| 项 | 原因 | 影响 |
|---|---|---|
| 小浣熊**多账号 / 账号池** | 客户端只有一份凭据文件，池化需要多份 userData；且本项目默认只读 | 单账号 |
| 小浣熊**令牌刷新与写回** | 本机构建不下发 `refresh_token`；且写回等于改别人的凭据文件 | 过期时提示重新登录 |
| ~~设置卡片增加 vendor tab~~ | 已补：卡片顶部新增「Loomy / 小浣熊」供应商切换，小浣熊面板只读展示登录态、四桶余额、模型数与刷新 | 无 |
| ~~输入框胶囊按 vendor 显示~~ | 已补：胶囊按当前模型所属供应商显示 `Loomy · N 积分` 或 `小浣熊 · N 积分` | 无 |
| Loomy 路由在**新前缀**下双注册 | 旧前缀仍由 client bundle 使用，暂不影响 | 0.3.0 一并处理 |
| 旧名 npm 别名 | 从未发布 npm，无迁移对象 | 无 |

## 3. 真机验证（2026-11-17 22:40–23:00）

| 检查 | 结果 |
|---|---|
| 客户度登录态 | `~/Library/Application Support/office-raccoon/agent/config/auth.json`，`access_token` 有效，剩余 **719.7h**（30 天） |
| 模型目录 | `GET /api/web/llm/v2/model_catalog` → 10 行，7 行 `visible`，内部 `raccoon-*` 被过滤 |
| 余额 | `available_points: 13300`（daily 300 / reward 13000） |
| 对话 | SSE 正常，思考走 `delta.reasoning_content`，末尾独立 usage 帧 + `[DONE]` |
| `reasoning_effort` | `level_1` / `low` / **`banana`** 全部 200 ⇒ 不校验 ⇒ 不提供档位下拉 |
| 插件内读取 | `readAuth()` 签名在、`fetchCatalog()` 7 个模型、`fetchBalance()` 13300 |

## 4. 复现命令

```bash
pnpm run check                     # typecheck + build + 211 个测试
node lib/bin.js status --json      # Loomy 侧账号与余额
dsh --profile web --dump-config | grep -A1 dsh-connect-desktop
```

浏览器侧验证（重启 DSH 之后）：设置 → 插件 → 卡片出现；模型选择器多出「小浣熊」一组；
`curl -s http://127.0.0.1:<端口>/plugins/dsh-connect-desktop/raccoon/status` 返回 `signedIn: true`。

## 5. 回滚

```bash
dsh plugin --profile web remove dsh-connect-desktop
dsh plugin --profile web add github:diudiu62/dsh-connect-loomy
```

数据目录未动，账号、当前账号、池开关、聊天记录都在。

## 6. 第二批：小浣熊登录 / 登出 / 多账号（2026-11-18）

| 能力 | 状态 | 位置 |
|---|---|---|
| 登出 | ✅ 可用（`POST /api/iam/v1/auth/logout`，实测 200） | `src/vendors/raccoon/auth-flow.ts` |
| 多账号（插件内） | ✅ 可用（增 / 切 / 删，账号表独立于客户端） | `src/vendors/raccoon/accounts.ts` |
| 登录（短信 / 密码） | ✅ **手机号加密已逆向完成并实测通过** | `auth-flow.ts`（`encryptRaccoonPhone`）+ `RaccoonTab.tsx` |
| 刷新令牌 | ⚠️ 路由透传就绪，本机 `auth.json` 无 `refresh_token` | `auth-flow.ts` |

新增 4 条 host 路由：`/raccoon/{logout,login,send-sms,refresh-token}`，
新增 3 条账号路由：`/raccoon/accounts{,/switch,/remove}`。

**手机号加密已解开**：从渲染层 chunk `21854` 的模块 `24886` 拿到完整实现——
AES-128-CFB、密钥 `senseraccoon2023`、随机 16 字节 IV 前置、整体 Base64。实测结果：

- `send_sms` 从 `100003 params_encryted_error` 变成 `100006 captcha_verify_error`
- `login_with_sms` 从 `100003` 变成 `100007 sms_code_verify_error`

两个新错误都证明**服务端成功解密了手机号**。`send_sms` 仍需人机验证 token，
但登录只需要用户从客户端/网页取一次真实验证码填进来即可。加密函数保留 `phoneEncryptor`
注入点，客户端换算法时无需发版。

测试：217 个全通过（新增 6 个覆盖登出、账号存储、加密注入）。

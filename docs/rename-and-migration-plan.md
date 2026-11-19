# 改名与版本递进总计划：`dsh-connect-loomy` → `dsh-connect-desktop`

> 产品侧决策来源：[docs/product/rename-and-multi-vendor-plan.md](product/rename-and-multi-vendor-plan.md)（CPO，264 行）。
> 本文是**执行总表**：把产品决策翻译成提交粒度、验收命令与回滚路径。两份文档冲突时以本文的技术事实为准，产品意图以 CPO 为准。
> 编写日期：2026-11-17；技术事实核对至 `v0.1.2`（commit `6b2f737`）。

---

## 0. 一页速览

| 版本 | 包名 | 一句话 | 决策门 |
|---|---|---|---|
| **0.1.3** | 旧 `dsh-connect-loomy` | 墓碑提醒版：零行为变化，只加提示与探测 | G1 |
| **0.2.0-rc.1** | 新 `dsh-connect-desktop` | 改名 + vendor 化 + 小浣熊（只读档），5–10 人 beta | G2 + G3 |
| **0.2.0** | 新 | 稳定版，新市场条目上线，旧条目转墓碑 | G4 |
| 0.3.0 | 新 | 第三家供应商（须过 G5），撤旧前缀 / 旧 bin / 旧资产 | G5 |

**三条铁律**（违反任一条就是数据事故）：

1. **路由键与模型 identity 永久冻结**：`loomy` / `loomy-N` / `loomy-pool`、`provider:'loomy'`、`api:'openai-completions'`。
2. **数据目录冻结在旧名**：新包继续读 `$DSH_HOME/storages/dsh-connect-loomy/`，不搬迁、不复制、不新建空目录。
3. **改名绑在有新功能的那一版（0.2.0）**，不打纯改名版。

---

## 1. 冻结清单（改名前必须逐项确认）

| 标识符 | 现值 | 代码位置 | 改名后果 | 处置 |
|---|---|---|---|---|
| 数据目录 | `storages/dsh-connect-loomy/` | `src/shared/paths.ts:37`、`src/plugin-auth.ts:39` | 换目录 = 用户看到"账号没了" | **冻结**，抽成 `LEGACY_DATA_ID` 常量 |
| 路由键 | `loomy` / `loomy-N` / `loomy-pool` | `src/accounts.ts:89`（`BASE_ROUTE`）、`src/pool.ts`（`POOL_ROUTE`） | 改键 → 历史 thinking 丢失或降级 | **冻结**，参数化为 `routeTable(vendorId)`，`loomy` 输出逐字节不变 |
| 模型 identity | `provider:'loomy'` + `api:'openai-completions'` | 每条 assistant 消息 | `requireProvider` 抛 `Unknown provider` | **冻结** |
| 设置命名空间 | `dsh-connect-loomy`（= loader entry id） | `src/config.ts:97`（`settingsNamespaceOf`） | 用户设的 `enabled:false`、自定义 `baseURL` 复活 | 切新 ns，**启动时一次性继承** |
| HTTP 前缀 | `/plugins/dsh-connect-loomy/*` | `src/shared/types.ts`（`ROUTES`） | 旧 client bundle 命中即 404，卡片空白 | 0.2.x **双前缀**，0.3.0 撤旧 |
| client bundle id | `dsh-connect-loomy` | `tsdown.config.ts`（`CLIENT_BUNDLE_ID`）、`tests/smoke.test.mjs:67,86` | 加载期键，不持久化 | 0.2.0 直接换，测试断言同步 |
| bin 名 | `dsh-connect-loomy` | `package.json#bin`、`src/bin.ts` | 用户脚本失效 | 0.2.x 双名指向同一入口，旧名打弃用提示 |
| 发布资产 | `releases/latest/download/dsh-connect-loomy.tgz` | `.github/workflows/release.yml` | 旧市场条目安装失败 | 新名 + **旧名继续上传 ≥ 3 个月** |

`locale` 命名空间（`settings.loomy`）不持久化，可保持不动，减少无谓 diff。

---

## 2. 技术实施：四个阶段、16 个提交

### 阶段 A — 0.1.3 墓碑版（旧包名，零行为变化）

| # | commit | 改什么 | 验收 |
|---|---|---|---|
| A1 | `refactor(paths): 抽出 LEGACY_DATA_ID / LEGACY_SETTINGS_NS 常量` | `src/shared/paths.ts`、`src/plugin-auth.ts`、`src/config.ts` 的字面量换成常量 | `pnpm check`；`ls ~/.dsh/storages/` 目录名不变 |
| A2 | `feat(profiles): 只读探测 $DSH_HOME/profiles/*/package.json` | 新增 `src/shared/profiles.ts`：扫依赖键与 `dsh.profile.bundles`，容错缺失/坏 JSON | 单测：三份 fixture（干净 / 已迁移 / 双装） |
| A3 | `feat(card): 迁移提示条（可关闭，一次性）` | `src/routes.ts`（status 增加 `migration` 字段）、`src/client/components/Card.tsx`、state 增加 `tombstoneShownFor:'0.1.3'` | 手测：升级后出现一次，点关闭后不再出现；重启不复现 |
| A4 | `feat(cli): doctor 迁移段 + migrate --print` | `src/bin.ts`：`doctor` 末尾打数据目录/命名空间/迁移命令；`migrate --print` 只打印不执行 | `node lib/bin.js doctor` 输出含两条命令；退出码仍为 0 |
| A5 | `docs: README 双语顶部横幅 + Release 0.1.3 文案` | `README.md`、`README.en.md` | 横幅在首屏可见；正文含"现在什么都不做也能继续用" |

**G1 判定**：`pnpm check` 全绿；0.1.2→0.1.3 前后 `accounts.json` / `state.json` 逐字段一致（`jq -S` 比对）；写文件只增字段、不升 schema。

> 注意 A3 的 `status` 只加字段、不改既有字段，旧前端忽略新字段即可（向后兼容）。

### 阶段 B — vendor 化（旧包名，行为不变）

| # | commit | 改什么 | 验收 |
|---|---|---|---|
| B1 | `refactor(routes): routeTable(vendorId)` | `src/accounts.ts`、`src/pool.ts`；`slotForRoute` / `isOurRoute` 接受路由表 | **新增快照测试**：`routeTable('loomy')` 的 `routeFor(1..3)` 与 `pool` 输出与 `v0.1.2` 完全相同 |
| B2 | `refactor(vendors): vendor 描述表 + 注册分发` | 新增 `src/vendors/index.ts`、`src/vendors/loomy/index.ts`（**薄壳 re-export**，不搬文件） | 模型选择器/卡片/胶囊与 `v0.1.2` 完全一致；`git diff --stat` 不出现大文件重命名 |
| B3 | `refactor(routes): 路由挂载按 vendor 命名空间化` | `src/routes.ts` 挂载函数接受前缀；loomy 前缀仍是 `/plugins/dsh-connect-loomy` | 浏览器网络面板：所有请求 URL 与旧版一致 |

**阶段 B 的边界**：只做"能装进两个 vendor 的框架"，不引入任何新供应商、不改任何字符串。

### 阶段 C — 小浣熊只读档（旧包名，0.2.0-rc 前置）

| # | commit | 改什么 | 验收 |
|---|---|---|---|
| C1 | `feat(raccoon): 凭据探测 + 模型目录 + 积分` | `src/vendors/raccoon/{auth,catalog,credits}.ts`；只读 `~/.box-agent/config/auth.json` | 无客户端时该分组不出现，Loomy 不受影响；有客户端时目录与余额正确 |
| C2 | `feat(raccoon): provider 注册 + 对话/SSE 透传` | `src/vendors/raccoon/provider.ts`；route 键 `raccoon` / `raccoon-N` | 一次真实对话跑通；`reasoning_content` 正常显示 |
| C3 | `feat(client): vendor tab + 胶囊按供应商显示` | `src/client/index.ts`、`Card.tsx`、`ComposerPill.tsx` | 选 Loomy 模型显 Loomy 积分，选 Raccoon 显 Raccoon；交叉切换 6 次无串味 |

**C 阶段的硬约束**：默认**只读**——token 过期时给可执行提示，不刷新、不写回 `~/.box-agent/config/auth.json`；写回必须显式开启（`managedRefresh: true`，默认 false）。

**G3 判定**：Raccoon 至少一条 chat 模型真跑通（不只是目录能读）；未登录空态/错误态齐备；两家互不污染。

### 阶段 D — 0.2.0 改名（提交次序不可调换）

| # | commit | 改什么 | 验收 |
|---|---|---|---|
| D1 | `chore: 包名/仓库/资产改名` | `package.json`（`name`、`displayName`、`bin` 双键、`repository`）、`cordis.patch.yml`（`insert.id`）、`tsdown.config.ts`（两个 `CLIENT_BUNDLE_ID` 常量）、`tests/smoke.test.mjs` 断言 | `dsh --dump-config` 出现 `id: dsh-connect-desktop` |
| D2 | `feat: 双 HTTP 前缀 + 旧前缀 0.3.0 撤` | `src/routes.ts` 同时注册 `/plugins/dsh-connect-loomy/*` 与 `/plugins/dsh-connect-desktop/*`（同一 handler，`no-store`） | 保留旧 bundle 缓存强刷，卡片与胶囊仍正常 |
| D3 | `feat: settings 一次性继承` | `src/config.ts` + 启动钩子：新 ns 无用户层时拷旧 ns 字段；已有值不覆盖；旧 ns 保留 | 0.1.3 里设 `enabled:false` 的用户升级后仍关闭 |
| D4 | `feat: 新旧包共存守卫（新包让位）` | `apply()` 最前探测；检测到旧包仍在 bundles → **不注册路由**、卡片红色横幅给 remove 命令 | 故意双装：**不出现** `DUPLICATE_ADAPTER`，模型仍由旧包提供 |
| D5 | `ci: 旧资产名继续发布` | `.github/workflows/release.yml` 额外上传 `dsh-connect-loomy.tgz` 副本 | 旧市场下载链接 200 |
| D6 | `docs: 迁移指引 + 市场条目文案` | `README` 中英、Release 0.2.0、市场新旧条目描述 | 两条命令可复制，顺序写死"先 remove 再动目录" |

**为什么 D4 选"新包让位"而不是抛错**：宿主对同一 provider 的第二次注册会抛 `DUPLICATE_ADAPTER`（`dsh-llm/lib/index.js:1872`），用户看到的是宿主堆栈，会以为 DSH 坏了。让新包检测到旧包后**主动不注册**，用户的模型仍在（旧包在工作），同时卡片用一句人话要求先卸载——失败模式从"崩溃"降级为"提示"。

---

## 3. 迁移的关键实现（可直接照抄的结构）

### 3.1 数据目录：冻结，不搬迁

```ts
// src/shared/paths.ts —— 常量与包名解耦，v0.2.0 继续用它
export const LEGACY_DATA_ID = 'dsh-connect-loomy'
export function storageRoot(dshHome = resolveDshHome()): string {
  return join(dshHome, 'storages', LEGACY_DATA_ID)
}
```

**绝不**在启动时"先创建新目录再尝试读旧目录"——那正是账号看起来消失的路径。

### 3.2 路由表：参数化但冻结输出

```ts
export interface RouteTable {
  readonly base: string
  readonly pool: string
  routeFor(slot: number): string
  slotFor(route: string): number | undefined
}
export function routeTable(vendorId: string): RouteTable { /* … */ }

export const LOOMY_ROUTE = routeTable('loomy')      // routeFor(1) === 'loomy'
export const RACCOON_ROUTE = routeTable('raccoon')  // 独立键，不共用
```

快照测试是这一层的唯一护栏：把 `v0.1.2` 的输出写成期望值，任何漂移立刻红。

### 3.3 设置继承：新 ns 为空才拷

```ts
if (ns !== LEGACY_SETTINGS_NS) {
  // 仅当新 ns 无用户层时，把旧 ns 用户层字段逐键拷入；旧 ns 原样保留
  // 实现前需核对 settings API 的写入形态（契约 §1.3 update/replace/mutate）
}
```

判定"新 ns 是否已有用户层"不要靠比默认值（用户可能恰好设成默认值），读 profile patch 文件里是否存在旧/新 `id` 段更可靠。

### 3.4 共存守卫（新包侧）

```ts
const profiles = await readProfiles(dshHome)          // 纯 fs，容错
if (profiles.some(p => p.bundles.includes('dsh-connect-loomy'))) {
  ctx.logger.error('检测到旧版 dsh-connect-loomy 仍在启用；请先执行：dsh plugin --profile <name> remove dsh-connect-loomy')
  migrationState = { kind: 'blocked-by-legacy' }       // 卡片据此渲染红条
  return                                               // 不注册任何 route
}
```

---

## 4. 兼容层清单（0.2.x 期间并存，0.3.0 撤）

| 兼容项 | 0.2.x | 0.3.0 |
|---|---|---|
| HTTP 前缀 | 新旧双注册 | 仅新 |
| bin 名 | 双键指向同一入口，旧名打弃用提示 | 仅新 |
| 发布资产 | 新旧两份 tgz | 仅新 |
| 设置命名空间 | 旧 ns 保留只读继承 | 旧 ns 可选清理提示 |
| 市场条目 | 旧条目转墓碑 + 指向说明 | 视下载量归档 |

---

## 5. 验收矩阵（每格都要跑）

| 从 ↓ 到 → | 0.1.2 | 0.1.3 | 0.2.0 |
|---|---|---|---|
| 0.1.2 | — | 数据逐字段一致、无提示 | 数据一致、设置继承、会话可续 |
| 0.1.3 | 可降级，账号不丢 | — | 同左 + 旧提示消失 |
| 0.2.0 | **可降级**（schema 只增不改） | 可降级 | — |
| 双装 | 守卫拦下并给 remove 命令 | 同左 | 同左 |

命令级验收（每次打 tag 前）：

```bash
pnpm run typecheck && pnpm run build && pnpm run test
node lib/bin.js status --json     # 账号、余额、选中模型
node lib/bin.js doctor --json     # 路径、登录态、迁移段
ls -l ~/.dsh/storages/            # 目录名必须仍是 dsh-connect-loomy
```

---

## 6. 风险与回滚

| 风险 | 触发 | 对策 | 回滚 |
|---|---|---|---|
| 账号"消失" | 新包用了新目录 | 目录冻结 + 先读旧目录 | 装回旧版即恢复（数据没动） |
| `DUPLICATE_ADAPTER` | 新旧双装 | 新包让位 + 卡片提示 | remove 旧包 |
| 历史 thinking 丢失 | 改了 route 键 | 快照测试冻结路由表 | 回退 D1 |
| 设置被重置 | ns 未继承 | 一次性继承 + 旧 ns 保留 | 手改 patch 恢复 |
| 卡片空白 | 旧 bundle 缓存打新前缀 | 双前缀 + `no-store` | 强刷页面 |
| 旧市场装不上 | 旧资产被删 | 继续发布旧资产 ≥3 个月 | 重新上传旧资产 |

降级路径写死一条：`dsh plugin --profile <name> remove dsh-connect-desktop && dsh plugin --profile <name> add github:diudiu62/dsh-connect-loomy`（数据不动、账号仍在）。

---

## 7. 现在就能开工的 5 件事

1. `A1` 抽常量（半小时，零风险，也是后面所有阶段的起点）。
2. `B1` 路由表参数化 + 快照测试（半天，决定后面能不能加第二家）。
3. `A2` profiles 探测模块（半天，0.1.3 与 0.2.0 共用）。
4. 装小浣熊客户端并登录 → 跑三条只读 curl（`model_catalog` / `points/v1/balance` / 一次最小对话），把真实报文落进 `docs/`（**这是 G3 的唯一依据**）。
5. 市场侧准备：新仓库名、新条目文案、旧条目描述追加行。

> 第 4 项是当前最大单点风险：Raccoon 的本地登录态与只读额度接口尚未在本机验证。未验证前，0.2.0 的 `desktop` 叙事只对 Loomy 成立。

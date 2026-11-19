> **本插件已更名为 `dsh-connect-desktop`**（0.2.0 起）。一个插件，多家桌面客户端：
> 目前支持 **Loomy（讯飞办公助手）** 与 **商汤小浣熊（Raccoon）**。
> 从旧版迁移只需两条命令 —— 见文末「从旧版迁移（0.3.0 起是破坏性变更）」。
> 注意：市场里还有一份同名 `dsh-connect-loomy` 的第三方实现（Windows-only），请以
> `github.com/diudiu62/dsh-connect-desktop` 为准。

# DSH Connect Desktop（原 dsh-connect-loomy）

把 **Loomy（讯飞办公助手）** 里已经登录的聊天模型，接到 **DSH** 的模型选择器里——装完就能像用其它模型一样直接对话，还能随时看到自己还剩多少积分。

> 只读取你在本机 Loomy 客户端已经有的登录状态。插件不提供账号、不共享凭据、不绕过计费：每次对话花的都是你自己账号的积分。

## 截图

| 账号管理 | 输入框旁的账号抽屉 | 积分概览 |
|---|---|---|
| ![账号](docs/assets/dsh-connect-desktop-accounts.png) | ![账号抽屉](docs/assets/dsh-connect-desktop-drawer.png) | ![积分概览](docs/assets/dsh-connect-desktop-credits.png) |
| 模型目录 | 诊断 | 配置 |
| ![模型目录](docs/assets/dsh-connect-desktop-models.png) | ![诊断](docs/assets/dsh-connect-desktop-diagnostics.png) | ![配置](docs/assets/dsh-connect-desktop-config.png) |
| 暗色主题 | | |
| ![暗色](docs/assets/dsh-connect-desktop-dark.png) | | |

## 小浣熊（Raccoon）—— 第二个接入的客户端

同一个插件，同一个设置卡片。只要你在这台机器上装过并登录了**商汤小浣熊桌面端**，
模型选择器里就会出现一组 `raccoon` 模型，规则和 Loomy 完全一样：

- **只读复用**：读客户端自己写的登录态（macOS 为
  `~/Library/Application Support/office-raccoon/agent/config/auth.json`），
  插件**不刷新、不写回、不上传**；令牌过期就去客户端重新登录一次。
- **能做**：对话（含思考链）、模型倍率显示、只读积分余额（可用/每日/奖励/充值分开显示）。
- **不做**：不提供账号、不共享凭据、不绕过计费；也不替你签到。
- **没有客户端就没有这一组**：未安装或未登录时，模型选择器不会多出任何东西，
  Loomy 一侧完全不受影响。

上游接口的实测记录见 [docs/raccoon-upstream.md](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/raccoon-upstream.md)（含目录字段、SSE 形状、
以及「`reasoning_effort` 不被校验」这条决定档位下拉的证据）。

## 装之前，先确认两件事

1. **电脑上装了 Loomy 桌面端，并且登录过一次**
   （插件读的是它保存的登录状态；登录一次就行，之后不用一直开着）
2. **电脑上装了 DSH**（版本 0.2.2-rc.1 或更高）

## 安装：三步

打开「终端」，把下面的命令**一段一段**粘贴执行。

**第 1 步：下载并构建**

```bash
cd ~/Documents
git clone https://github.com/diudiu62/dsh-connect-loomy.git
cd dsh-connect-loomy
pnpm install
pnpm build
```

**第 2 步：装进 DSH**

```bash
dsh plugin --profile web add link:$PWD
```

> 注意这里必须用 `link:`，不要用 `file:`。
> `file:` 会把插件**复制**一份到 DSH 里，以后你更新代码就不生效了。

**第 3 步：重启 DSH**

关掉 DSH 再打开。重启后：

- 打开 **设置 → Loomy**，能看到一张设置卡片，说明装好了
- 打开**模型选择器**，能看到 **Loomy** 一组模型，说明接上了

## 怎么用

### 1. 先确认是登录状态

打开 **设置 → Loomy**，最上面显示 **已登录** 和你的手机号就对了。

如果显示未登录：打开 Loomy 桌面端点一下登录，然后回到这里点 **重新检测**。

### 2. 选模型开始聊

在对话框下面的**模型选择器**里选 **Loomy**，再选具体模型，就能像平常一样对话了。

### 3. 随时看积分

模型选择器旁边有个小胶囊，长这样：

```
Loomy · 40,500 积分
```

数字就是**当前账号还剩多少积分**。每次对话会扣一点，点一下胶囊可以看明细。

### 4. 想用多个账号？

如果你有多个 Loomy 账号（比如工作和个人的），可以都加进来，随时切换：

1. 设置 → Loomy → 点 **新增账号**，用手机验证码登录；或者点**导入**，粘贴另一台电脑导出的账号
2. 回到对话框，**点胶囊**，弹出账号列表
3. 点哪个账号，就用哪个账号的积分

账号**不会**让模型选择器变多：不管加几个号，Loomy 永远只有一组模型。用哪个号付费是
**每次调用**决定的，不是你选的那个分组决定的。

抽屉里还有一个开关：**每次调用随机选一个健康账号**。

- 打开：每次对话自动挑一个还有积分的账号，某个账号失效了会自动跳过它
- 关闭：固定用你在列表里点选的那个账号

### 5. 想把账号搬到另一台电脑？

在设置卡片里点某个账号那行的 **导出**，把内容复制走；到新电脑上点 **导入** 粘进去，就不用再收验证码了。

> 导出的内容**就是登录凭证本身**，等于密码。别发到群里、别提交到 GitHub。

## 常见问题

**看不到 Loomy 设置卡片？**
重启 DSH（不是刷新浏览器）。还不行就检查第 2 步装成功了没有：`dsh plugin --profile web list`。

**模型选择器里没有 Loomy？**
说明还没登录。打开 Loomy 桌面端登录一次，然后到设置卡片点 **重新检测**。

**提示「没有找到可用的 Loomy 应用配置」？**
这台电脑没装 Loomy 桌面端，或者装的位置不常见。装上之后点 **重新检测**。

**提示「登录态已失效」？**
在 Loomy 桌面端重新登录一次，然后到设置卡片点 **重新检测**。

**胶囊不显示？**
只有当前会话选中了 Loomy 模型时才会出现。切到其它模型它就隐藏了。

**切换账号后数字没变？**
点抽屉里的 **刷新** 强制重新读一次（平时为了省请求有 60 秒缓存）。

**积分显示「不可用」？**
那个账号的登录状态过期了，重新登录即可；其它账号不受影响。

## 卡住了？来群里问

- **QQ 群**：`537149884`（最快，装上就能问）
- **提问题 / 提需求**：[GitHub Issues](https://github.com/diudiu62/dsh-connect-loomy/issues)

提问前先点设置卡片诊断页的 **复制诊断**，把那段文本一起贴上——里面有版本、路径和上游原话，但不含登录凭据、手机号和用户 id。

这一栏也常驻在设置卡片的**右上角**（标题旁），不用滚到底部就能点。联系方式只维护在 [`src/shared/community.ts`](src/shared/community.ts) 一处：群号已经填好，微信/邮箱还是占位符（`[WECHAT_ID]` 这种），占位符不会显示，填上真实值就会自动出现在卡片、`--help` 和这份文档里。

## 想了解更多

- **接入第三家供应商**：[接入手册](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/vendor-onboarding.md)
- **架构与为什么这样分层**：[多供应商架构](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/product/vendor-capability-architecture.md)
- **宿主 API 契约与实际路由表**：[插件契约](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/dsh-plugin-contract.md)
- **上游接口实测**：[Loomy](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/loomy-upstream.md) · [小浣熊](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/raccoon-upstream.md)
- **命令行**：`node lib/bin.js status --json`（账号与余额）、`node lib/bin.js doctor --json`（网络与登录排查，含上游活体探测）；`--vendor loomy|raccoon` 只看一家
- **配置项**：按供应商分组，形状是 `vendors: { loomy: { ... }, raccoon: { ... } }`；缺项自动回落到默认值
- **现在还不支持**：自动每日签到（Loomy 没有这个接口）、把积分转给别人

## 卸载

```bash
dsh plugin --profile web remove dsh-connect-loomy
```

然后重启 DSH。

## 许可

MIT

## 从旧版迁移（0.3.0 起是破坏性变更）

0.3.0 把「一家供应商」变成了一个**契约**（`src/vendor-sdk/contracts.ts`）：能力声明决定
路由、设置卡片的面板、以及模型选择器里的分组。代价是旧的数据与配置不再沿用：

```bash
dsh plugin --profile web remove dsh-connect-loomy
dsh plugin --profile web add github:diudiu62/dsh-connect-desktop
```

- **账号需要重新登录一次。** 新的数据目录是 `~/.dsh/storages/dsh-connect-desktop/<供应商>/`，
  旧目录 `~/.dsh/storages/dsh-connect-loomy/` 不再读取（产品决定：用户量小，一次性断干净）。
- **配置从平铺字段改成按供应商分组。** 旧 patch 里的 `baseURL` / `raccoonBaseURL` 等不再生效，
  新形状是 `vendors: { loomy: { baseURL }, raccoon: { baseURL } }`，缺省值由插件补全。
- **HTTP 路由统一到** `/plugins/dsh-connect-desktop/<供应商>/…`，CSRF 头统一为
  `x-dsh-connect-csrf`（旧的 `x-loomy-csrf` / `x-raccoon-csrf` 已移除）。
- 聊天记录不受影响：模型 identity（`provider='loomy'` / `'raccoon'`）被刻意冻结。

### 为什么值得这次破坏

新增一家供应商从「复制 2 300 行 + 祈祷别漏页面」变成**只写协议**：

```
src/vendors/<id>/index.ts   # 一个 descriptor（能力声明）+ create() 返回各 driver
```

路由、CSRF/loopback 守卫、TTL 缓存、账号池、pi-ai 适配器、设置卡片的面板，全部由
`src/core` 与 `src/client/capability` 按能力声明生成。`tests/host/vendor-contract.test.mjs`
里有一个从未在仓库中出现过的假供应商，它挂进真实 registry 后自动获得 8 条路由和一条
provider 路由——这就是那条主张的可执行形式。设计说明见
[`docs/product/vendor-capability-architecture.md`](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/product/vendor-capability-architecture.md)，
逐步接入手册见 [`docs/vendor-onboarding.md`](https://github.com/diudiu62/dsh-connect-loomy/blob/HEAD/docs/vendor-onboarding.md)。

**每次 push / PR 自动跑哪些检查**：类型与架构门禁、构建、全部测试，外加两条只能在
真实浏览器里量的门禁——五个宽度（340–700px）下不出现横向溢出、浅色与暗色两种主题下
文字对比度都不低于 WCAG AA 的 4.5:1。见 `.github/workflows/ci.yml`。本地等价命令是
`pnpm run check` 与 `pnpm run audit:visual`。

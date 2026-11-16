/**
 * Typed dictionary for the `settings.loomy` locale namespace.
 *
 * The runtime dictionaries live in the client bundle (the same split
 * `dsh-connect-workbuddy` uses); `locale/en.json` and `locale/zh.json` are the
 * *package* metadata the plugin market reads. Keeping the two apart is what the
 * family does, and it prevents a package-metadata edit from silently changing
 * UI copy.
 *
 * The `declare module` block is the family's standard idiom: it merges this
 * namespace into `LocaleNamespaceMap`, which makes `ctx.locale.register(ns, {en, zh})`
 * a compile-checked call where a missing key in either dictionary is an error.
 * Every string the card renders — including the copied diagnostics report —
 * goes through this dictionary; there is no hard-coded UI copy in components.
 *
 * @module dsh-connect-loomy/client/locale
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.loomy'

/** Every key this plugin can render. */
export type LoomyLocaleKey =
  | 'tab.label'
  | 'composer.pill'
  | 'composer.pillBare'
  | 'composer.pillPending'
  | 'composer.pillTitle'
  | 'login.title'
  | 'login.intro'
  | 'login.phonePlaceholder'
  | 'login.codePlaceholder'
  | 'login.sendCode'
  | 'login.sending'
  | 'login.resend'
  | 'login.resendIn'
  | 'login.login'
  | 'login.loggingIn'
  | 'login.logout'
  | 'login.loggingOut'
  | 'login.codeSent'
  | 'login.sendFailed'
  | 'login.failed'
  | 'login.logoutFailed'
  | 'login.success'
  | 'login.pluginActive'
  | 'login.sourcePlugin'
  | 'login.sourceDesktop'
  | 'login.sourceEnv'
  | 'login.sourceNone'
  | 'accounts.title'
  | 'accounts.intro'
  | 'accounts.empty'
  | 'accounts.unavailable'
  | 'accounts.failed'
  | 'accounts.originPlugin'
  | 'accounts.originDesktop'
  | 'accounts.route'
  | 'accounts.userId'
  | 'accounts.addedAt'
  | 'accounts.remove'
  | 'accounts.removing'
  | 'accounts.desktopNote'
  | 'accounts.unknownPhone'
  | 'accounts.removeFailed'
  | 'accounts.export'
  | 'accounts.exporting'
  | 'accounts.exportHint'
  | 'accounts.import'
  | 'accounts.importing'
  | 'accounts.importPlaceholder'
  | 'accounts.exportNotice'
  | 'accounts.importNotice'
  | 'accounts.transferFailed'
  | 'accounts.exportEmpty'
  | 'accounts.importBadJson'
  | 'accounts.registeredRoutes'
  | 'accounts.switchHint'
  | 'accounts.unavailableBadge'
  | 'accounts.unavailableWhy'
  | 'card.title'
  | 'card.subtitle'
  | 'card.hostUnavailable'
  | 'card.statusError'
  | 'card.renderFailed'
  | 'card.retry'
  | 'tabs.aria'
  | 'tabs.account'
  | 'tabs.models'
  | 'tabs.diagnostics'
  | 'common.loading'
  | 'common.refresh'
  | 'common.refreshing'
  | 'common.save'
  | 'common.saving'
  | 'common.discard'
  | 'common.copy'
  | 'common.copied'
  | 'common.copyFailed'
  | 'common.none'
  | 'common.unknownError'
  | 'account.title'
  | 'account.loggedIn'
  | 'account.loggedOut'
  | 'account.phone'
  | 'account.loginAt'
  | 'account.credential'
  | 'account.credentialFound'
  | 'account.credentialMissing'
  | 'account.redetect'
  | 'account.redetecting'
  | 'account.nextSteps'
  | 'account.nextStep.login'
  | 'account.nextStep.staySignedIn'
  | 'account.nextStep.recheck'
  | 'account.credits'
  | 'account.credits.balance'
  | 'account.credits.daily'
  | 'account.credits.available'
  | 'account.credits.fetchedAt'
  | 'account.credits.failed'
  | 'account.credits.unavailable'
  | 'account.credits.records'
  | 'account.credits.emptyRecords'
  | 'account.credits.credit'
  | 'account.credits.debit'
  | 'models.title'
  | 'models.description'
  | 'models.refresh'
  | 'models.refreshing'
  | 'models.save'
  | 'models.saving'
  | 'models.discard'
  | 'models.dirty'
  | 'models.clean'
  | 'models.saved'
  | 'models.saveFailed'
  | 'models.refreshFailed'
  | 'models.unavailable'
  | 'models.loading'
  | 'models.idle'
  | 'models.empty'
  | 'models.column.model'
  | 'models.column.multiplier'
  | 'models.column.context'
  | 'models.column.maxOutput'
  | 'models.column.vision'
  | 'models.column.efforts'
  | 'models.vision.yes'
  | 'models.vision.no'
  | 'models.efforts.none'
  | 'models.efforts.default'
  | 'models.selection'
  | 'models.refreshedAt'
  | 'models.baselineUnknown'
  | 'models.saveNeedsHost'
  | 'models.toggle'
  | 'diagnostics.title'
  | 'diagnostics.description'
  | 'diagnostics.copy'
  | 'diagnostics.unavailable'
  | 'diagnostics.loading'
  | 'diagnostics.probes'
  | 'diagnostics.probe.ok'
  | 'diagnostics.probe.fail'
  | 'diagnostics.upstream'
  | 'diagnostics.upstream.baseUrl'
  | 'diagnostics.upstream.models'
  | 'diagnostics.upstream.points'
  | 'diagnostics.account'
  | 'diagnostics.catalog'
  | 'diagnostics.catalog.counts'
  | 'diagnostics.lastError'
  | 'diagnostics.lastError.path'
  | 'diagnostics.lastError.code'
  | 'diagnostics.lastError.at'
  | 'diagnostics.lastError.message'
  | 'diagnostics.noLastError'
  | 'diagnostics.refresh'
  | 'diagnostics.report.title'
  | 'diagnostics.report.generatedAt'
  | 'diagnostics.report.route'
  | 'diagnostics.report.credentialPath'
  | 'diagnostics.report.probes'
  | 'diagnostics.report.upstream'
  | 'diagnostics.report.account'
  | 'diagnostics.report.catalog'
  | 'diagnostics.report.lastError'
  | 'diagnostics.report.none'
  | 'diagnostics.report.unknown'
  | 'errors.csrf'
  | 'errors.network'
  | 'errors.badResponse'
  | 'errors.unavailable'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Loomy settings card copy. */
    'settings.loomy': LoomyLocaleKey
  }
}

/** English copy. */
export const en: Record<LoomyLocaleKey, string> = {
  'tab.label': 'Loomy',
  'login.title': 'Sign in to Loomy',
  'login.intro': 'Sign in from this plugin with an SMS code. The plugin session takes precedence; signing out falls back to the desktop client session.',
  'login.phonePlaceholder': 'Phone number',
  'login.codePlaceholder': 'Verification code',
  'login.sendCode': 'Send code',
  'login.sending': 'Sending…',
  'login.resend': 'Resend',
  'login.resendIn': 'Resend in {seconds}s',
  'login.login': 'Sign in',
  'login.loggingIn': 'Signing in…',
  'login.logout': 'Sign out (plugin)',
  'login.loggingOut': 'Signing out…',
  'login.codeSent': 'Code sent to {phone}. Valid for 5 minutes.',
  'login.sendFailed': 'Could not send the code.',
  'login.failed': 'Sign-in failed.',
  'login.logoutFailed': 'Sign-out failed.',
  'login.success': 'Signed in — models and credits now use the new session.',
  'login.pluginActive': 'Using the account signed in through this plugin.',
  'login.sourcePlugin': 'Source: plugin',
  'login.sourceDesktop': 'Source: desktop client',
  'login.sourceEnv': 'Source: env override',
  'login.sourceNone': 'Signed out',
  'accounts.title': 'Accounts',
  'accounts.intro': 'Each sign-in below is its own provider route — pick that route in the model picker to use that account, so two conversations can spend two different accounts.',
  'accounts.empty': 'No account yet. Sign in above to add one.',
  'accounts.unavailable': 'The account list is not available on this host build.',
  'accounts.failed': 'Could not read the account list: {message}',
  'accounts.originPlugin': 'plugin',
  'accounts.originDesktop': 'desktop',
  'accounts.route': 'Route',
  'accounts.userId': 'User',
  'accounts.addedAt': 'Added',
  'accounts.remove': 'Remove',
  'accounts.removing': 'Removing…',
  'accounts.desktopNote': 'Owned by the Loomy desktop client — sign out there to remove it.',
  'accounts.unknownPhone': 'Unknown account',
  'accounts.removeFailed': 'Could not remove the account.',
  'accounts.export': 'Export accounts',
  'accounts.exporting': 'Exporting…',
  'accounts.exportHint': 'Exports every credential this machine can see — plugin accounts plus the Loomy desktop client sign-in. The file contains the session tokens themselves: it is the credential, not a cache. Anyone holding it can spend these accounts until the session expires (issued with a 14-day lifetime) or until you sign out. Keep it off shared machines.',
  'accounts.import': 'Import accounts',
  'accounts.importing': 'Importing…',
  'accounts.importPlaceholder': 'Paste an exported accounts bundle here',
  'accounts.exportNotice': 'Exported. Paste the bundle on the other machine to sign in there without a code.',
  'accounts.importNotice': 'Imported: added {added}, refreshed {refreshed}, skipped {skipped}.',
  'accounts.transferFailed': 'Transfer failed.',
  'accounts.exportEmpty': 'No accounts to export yet.',
  'accounts.importBadJson': 'That is not valid JSON — paste the whole exported file, including the outer braces.',
  'accounts.registeredRoutes': 'Routes now in the model picker',
  'accounts.switchHint': 'Switching accounts happens in the model picker: each route below is one account, so picking a model under that route spends that account. The choice is per conversation.',
  'accounts.unavailableBadge': 'skipped by pool',
  'accounts.unavailableWhy': 'The rotation pool is skipping this account for now: {message}',
  'composer.pill': 'Loomy · {amount}',
  'composer.pillBare': 'Loomy',
  'composer.pillPending': 'Loomy credits are still loading. Click to refresh.',
  'composer.pillTitle': 'Loomy credits — available {available} (monthly {balance} + today {daily}). Click to refresh.',
  'card.title': 'Loomy (iFlytek office assistant)',
  'card.subtitle':
    'Reuses the Loomy desktop app already signed in on this machine and adds its chat models to the DeepSeek Harness model picker.',
  'card.hostUnavailable':
    'The host does not expose the Loomy settings routes (404/503). Make sure the dsh-connect-loomy host half is enabled, then restart DSH.',
  'card.statusError': 'Failed to read Loomy status: {message}',
  'card.renderFailed': 'The Loomy settings card failed to render; the rest of the settings page is unaffected.',
  'card.retry': 'Retry',
  'tabs.aria': 'Loomy settings sections',
  'tabs.account': 'Account',
  'tabs.models': 'Models',
  'tabs.diagnostics': 'Diagnostics',
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',
  'common.refreshing': 'Refreshing…',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.discard': 'Discard',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.copyFailed': 'Copy failed — select the text and copy it manually.',
  'common.none': '—',
  'common.unknownError': 'Unknown error',
  'account.title': 'Local sign-in',
  'account.loggedIn': 'Signed in',
  'account.loggedOut': 'Not signed in',
  'account.phone': 'Phone number',
  'account.loginAt': 'Signed in at',
  'account.credential': 'Credential file',
  'account.credentialFound': 'Found: {path}',
  'account.credentialMissing': 'Not found: {path}',
  'account.redetect': 'Re-check',
  'account.redetecting': 'Re-checking…',
  'account.nextSteps': 'Next steps',
  'account.nextStep.login': 'Open the Loomy desktop app and sign in with your phone number.',
  'account.nextStep.staySignedIn':
    'Keep the Loomy app signed in and run it once so it refreshes its credential file.',
  'account.nextStep.recheck': 'Come back here and press “Re-check”.',
  'account.credits': 'Read-only credits overview',
  'account.credits.balance': 'Balance',
  'account.credits.daily': 'Daily balance',
  'account.credits.available': 'Available',
  'account.credits.fetchedAt': 'Read at {time}',
  'account.credits.failed': 'Could not read credits: {message}',
  'account.credits.unavailable': 'The host does not expose the credits route.',
  'account.credits.records': 'Recent records',
  'account.credits.emptyRecords': 'No records',
  'account.credits.credit': 'Credit',
  'account.credits.debit': 'Debit',
  'models.title': 'Model catalog',
  'models.description':
    'Checkboxes are a draft — only Save writes them into the model picker, and refreshing the catalog never overwrites unsaved checks.',
  'models.refresh': 'Refresh catalog',
  'models.refreshing': 'Refreshing…',
  'models.save': 'Save selection',
  'models.saving': 'Saving…',
  'models.discard': 'Discard changes',
  'models.dirty': 'Unsaved changes',
  'models.clean': 'Matches the saved selection',
  'models.saved': 'Saved — the model picker is up to date.',
  'models.saveFailed': 'Save failed: {message}',
  'models.refreshFailed': 'Catalog refresh failed: {message}',
  'models.unavailable': 'The host does not expose the catalog refresh route.',
  'models.loading': 'Loading the catalog…',
  'models.idle': 'The catalog has not been loaded yet.',
  'models.empty': 'The upstream catalog has no usable chat models.',
  'models.column.model': 'Model',
  'models.column.multiplier': 'Rate',
  'models.column.context': 'Context',
  'models.column.maxOutput': 'Max output',
  'models.column.vision': 'Vision',
  'models.column.efforts': 'Reasoning',
  'models.vision.yes': 'Yes',
  'models.vision.no': 'No',
  'models.efforts.none': 'None',
  'models.efforts.default': 'default {effort}',
  'models.selection': '{selected}/{total} selected',
  'models.refreshedAt': 'Catalog refreshed at {time}',
  'models.baselineUnknown': 'The host has not reported the saved selection (enabledModelIds).',
  'models.saveNeedsHost': 'The host is not ready yet; saving is disabled.',
  'models.toggle': 'Enable {name}',
  'diagnostics.title': 'Diagnostics',
  'diagnostics.description': 'Read-only facts — copy the whole block into a bug report.',
  'diagnostics.copy': 'Copy all',
  'diagnostics.unavailable': 'The host does not expose the diagnostics route.',
  'diagnostics.loading': 'Loading diagnostics…',
  'diagnostics.probes': 'Credential path candidates',
  'diagnostics.probe.ok': 'ok',
  'diagnostics.probe.fail': 'unavailable',
  'diagnostics.upstream': 'Upstream',
  'diagnostics.upstream.baseUrl': 'Base URL',
  'diagnostics.upstream.models': 'Models URL',
  'diagnostics.upstream.points': 'Points URL',
  'diagnostics.account': 'Account in service',
  'diagnostics.catalog': 'Catalog',
  'diagnostics.catalog.counts': '{total} models, {enabled} enabled',
  'diagnostics.lastError': 'Last upstream error (verbatim)',
  'diagnostics.lastError.path': 'Path',
  'diagnostics.lastError.code': 'Code',
  'diagnostics.lastError.at': 'At',
  'diagnostics.lastError.message': 'Message',
  'diagnostics.noLastError': 'No upstream error has been recorded',
  'diagnostics.refresh': 'Reload',
  'diagnostics.report.title': 'DSH Connect Loomy diagnostics report',
  'diagnostics.report.generatedAt': 'Generated at',
  'diagnostics.report.route': 'Host routes',
  'diagnostics.report.credentialPath': 'Credential file conclusion',
  'diagnostics.report.probes': 'Credential path candidates',
  'diagnostics.report.upstream': 'Upstream',
  'diagnostics.report.account': 'Account in service',
  'diagnostics.report.catalog': 'Catalog',
  'diagnostics.report.lastError': 'Last upstream error',
  'diagnostics.report.none': 'none',
  'diagnostics.report.unknown': 'unknown',
  'errors.csrf': 'The host has not provided a CSRF token yet — re-check first.',
  'errors.network': 'Cannot reach the host: {message}',
  'errors.badResponse': 'The host response was malformed.',
  'errors.unavailable': 'The host does not expose this route.',
}

/** Simplified Chinese copy. */
export const zh: Record<LoomyLocaleKey, string> = {
  'tab.label': 'Loomy',
  'login.title': '登录 Loomy 账号',
  'login.intro': '在本插件内用手机验证码登录；插件自己的登录态优先生效，退出后自动回落到 Loomy 桌面端的登录。',
  'login.phonePlaceholder': '手机号',
  'login.codePlaceholder': '验证码',
  'login.sendCode': '发送验证码',
  'login.sending': '发送中…',
  'login.resend': '重新发送',
  'login.resendIn': '{seconds} 秒后可重发',
  'login.login': '登录',
  'login.loggingIn': '登录中…',
  'login.logout': '退出插件登录',
  'login.loggingOut': '退出中…',
  'login.codeSent': '验证码已发送到 {phone}，5 分钟内有效。',
  'login.sendFailed': '验证码发送失败。',
  'login.failed': '登录失败。',
  'login.logoutFailed': '退出失败。',
  'login.success': '登录成功，模型与积分已切换到新会话。',
  'login.pluginActive': '当前使用插件内登录的账号。',
  'login.sourcePlugin': '来源：插件登录',
  'login.sourceDesktop': '来源：桌面端',
  'login.sourceEnv': '来源：环境变量指定',
  'login.sourceNone': '未登录',
  'accounts.title': '账号',
  'accounts.intro': '下面每个登录都对应一个独立的供应商路由——在模型选择器里选那条路由就是使用该账号，因此两个会话可以分别花两个账号的积分。',
  'accounts.empty': '还没有账号。在上方登录即可添加。',
  'accounts.unavailable': '当前宿主版本没有提供账号列表。',
  'accounts.failed': '读取账号列表失败：{message}',
  'accounts.originPlugin': '插件登录',
  'accounts.originDesktop': '桌面端',
  'accounts.route': '路由',
  'accounts.userId': '用户',
  'accounts.addedAt': '添加时间',
  'accounts.remove': '移除',
  'accounts.removing': '移除中…',
  'accounts.desktopNote': '该账号属于 Loomy 桌面端——请在桌面端退出登录来移除。',
  'accounts.unknownPhone': '未知账号',
  'accounts.removeFailed': '移除账号失败。',
  'accounts.export': '导出账号',
  'accounts.exporting': '导出中…',
  'accounts.exportHint': '会把本机能看到的凭证都导出——插件登录的账号，外加 Loomy 桌面端的登录态。文件里就是 session 本身，是凭证不是缓存：拿到它的人在你退出登录前（会话按 14 天签发）可以一直花这些账号的积分。请勿放在共享机器上。',
  'accounts.import': '导入账号',
  'accounts.importing': '导入中…',
  'accounts.importPlaceholder': '把导出的账号包粘贴到这里',
  'accounts.exportNotice': '已导出。把内容粘贴到另一台机器即可免验证码登录。',
  'accounts.importNotice': '导入完成：新增 {added}、刷新 {refreshed}、跳过 {skipped}。',
  'accounts.transferFailed': '传输失败。',
  'accounts.exportEmpty': '还没有可导出的账号。',
  'accounts.importBadJson': '内容不是合法 JSON——请把导出的完整文件粘进来（包括最外层的花括号）。',
  'accounts.registeredRoutes': '模型选择器里当前可用的路由',
  'accounts.switchHint': '切换账号在模型选择器里完成：下面每条路由就是一个账号，选中该路由下的模型就会用这个账号的额度。选择是按会话生效的。',
  'accounts.unavailableBadge': '池已跳过',
  'accounts.unavailableWhy': '自动轮换暂时跳过这个账号：{message}',
  'composer.pill': 'Loomy · {amount}',
  'composer.pillBare': 'Loomy',
  'composer.pillPending': 'Loomy 积分还在读取中，点击可重试。',
  'composer.pillTitle': 'Loomy 积分：可用 {available}（包月剩余 {balance} + 今日额度 {daily}）。点击可刷新。',
  'card.title': 'Loomy（讯飞办公助手）',
  'card.subtitle':
    '复用本机已登录的 Loomy 桌面端登录态，把它的聊天模型接入 DeepSeek Harness 模型选择器。',
  'card.hostUnavailable':
    '宿主没有提供 Loomy 设置路由（404/503）。请确认 dsh-connect-loomy 宿主侧已启用，然后重启 DSH。',
  'card.statusError': '读取 Loomy 状态失败：{message}',
  'card.renderFailed': 'Loomy 设置卡片渲染失败；宿主其余设置不受影响。',
  'card.retry': '重试',
  'tabs.aria': 'Loomy 设置分区',
  'tabs.account': '账号',
  'tabs.models': '模型',
  'tabs.diagnostics': '诊断',
  'common.loading': '加载中…',
  'common.refresh': '刷新',
  'common.refreshing': '刷新中…',
  'common.save': '保存',
  'common.saving': '保存中…',
  'common.discard': '放弃修改',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFailed': '复制失败，请手动选择文本复制。',
  'common.none': '—',
  'common.unknownError': '未知错误',
  'account.title': '本机登录态',
  'account.loggedIn': '已登录',
  'account.loggedOut': '未登录',
  'account.phone': '手机号',
  'account.loginAt': '登录时间',
  'account.credential': '凭据文件',
  'account.credentialFound': '已找到：{path}',
  'account.credentialMissing': '未找到：{path}',
  'account.redetect': '重新检测',
  'account.redetecting': '检测中…',
  'account.nextSteps': '下一步',
  'account.nextStep.login': '打开 Loomy（讯飞办公助手）桌面端，用手机号完成登录。',
  'account.nextStep.staySignedIn':
    '确认 Loomy 桌面端保持登录，并让它在后台运行一次，以刷新凭据文件。',
  'account.nextStep.recheck': '回到这里点「重新检测」。',
  'account.credits': '只读积分概览',
  'account.credits.balance': '账户余额',
  'account.credits.daily': '每日余额',
  'account.credits.available': '可用余额',
  'account.credits.fetchedAt': '读取于 {time}',
  'account.credits.failed': '积分读取失败：{message}',
  'account.credits.unavailable': '宿主未提供积分路由。',
  'account.credits.records': '最近流水',
  'account.credits.emptyRecords': '暂无流水',
  'account.credits.credit': '获得',
  'account.credits.debit': '消费',
  'models.title': '模型目录',
  'models.description':
    '勾选只是草稿，保存后才写入模型选择器；刷新目录不会覆盖未保存的勾选。',
  'models.refresh': '刷新目录',
  'models.refreshing': '刷新中…',
  'models.save': '保存勾选',
  'models.saving': '保存中…',
  'models.discard': '放弃修改',
  'models.dirty': '有未保存的修改',
  'models.clean': '与已保存的选择一致',
  'models.saved': '已保存，模型选择器已更新。',
  'models.saveFailed': '保存失败：{message}',
  'models.refreshFailed': '刷新目录失败：{message}',
  'models.unavailable': '宿主未提供目录刷新路由。',
  'models.loading': '正在读取目录…',
  'models.idle': '尚未读取目录。',
  'models.empty': '上游目录中没有可用的聊天模型。',
  'models.column.model': '模型',
  'models.column.multiplier': '倍率',
  'models.column.context': '上下文',
  'models.column.maxOutput': '最大输出',
  'models.column.vision': '图片',
  'models.column.efforts': '推理档位',
  'models.vision.yes': '支持',
  'models.vision.no': '不支持',
  'models.efforts.none': '无',
  'models.efforts.default': '默认 {effort}',
  'models.selection': '已选 {selected}/{total}',
  'models.refreshedAt': '目录刷新于 {time}',
  'models.baselineUnknown': '宿主尚未提供已保存的勾选（enabledModelIds）。',
  'models.saveNeedsHost': '宿主未就绪，暂时不能保存。',
  'models.toggle': '启用 {name}',
  'diagnostics.title': '诊断',
  'diagnostics.description': '只读事实表，可直接整段复制到问题反馈。',
  'diagnostics.copy': '复制全部',
  'diagnostics.unavailable': '宿主未提供诊断路由。',
  'diagnostics.loading': '正在读取诊断…',
  'diagnostics.probes': '凭据候选路径',
  'diagnostics.probe.ok': '可用',
  'diagnostics.probe.fail': '不可用',
  'diagnostics.upstream': '上游',
  'diagnostics.upstream.baseUrl': '基地址',
  'diagnostics.upstream.models': '模型目录',
  'diagnostics.upstream.points': '积分流水',
  'diagnostics.account': '在服务的账号',
  'diagnostics.catalog': '模型目录',
  'diagnostics.catalog.counts': '{total} 条，启用 {enabled} 条',
  'diagnostics.lastError': '上游最近一次错误原文',
  'diagnostics.lastError.path': '路径',
  'diagnostics.lastError.code': '错误码',
  'diagnostics.lastError.at': '时间',
  'diagnostics.lastError.message': '原文',
  'diagnostics.noLastError': '最近没有记录到上游错误',
  'diagnostics.refresh': '重新读取',
  'diagnostics.report.title': 'DSH Connect Loomy 诊断报告',
  'diagnostics.report.generatedAt': '生成时间',
  'diagnostics.report.route': '宿主路由',
  'diagnostics.report.credentialPath': '凭据文件结论',
  'diagnostics.report.probes': '凭据候选路径',
  'diagnostics.report.upstream': '上游',
  'diagnostics.report.account': '在服务的账号',
  'diagnostics.report.catalog': '模型目录',
  'diagnostics.report.lastError': '上游最近一次错误',
  'diagnostics.report.none': '无',
  'diagnostics.report.unknown': '未知',
  'errors.csrf': '宿主尚未提供 CSRF 令牌，请先点「重新检测」。',
  'errors.network': '无法连接宿主：{message}',
  'errors.badResponse': '宿主响应格式不正确。',
  'errors.unavailable': '宿主没有这条路由。',
}

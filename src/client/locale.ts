/**
 * One dictionary for the whole card — capability copy and brand copy, one namespace.
 *
 * WHY ONE NAMESPACE. The card used to carry a dictionary per vendor path
 * (`settings.loomy`, plus a `raccoon.*` prefix inside the same table), so adding
 * a vendor meant adding a key family and a second translator. Nothing here
 * belongs to a vendor any more: a panel renders `tabs.*`, `credits.field.*`,
 * `pool.*`, `actions.*` because a **capability** said so. The only
 * vendor-named keys left are brand strings (`vendor.<id>.name`), which is
 * exactly the one thing the host cannot hand us as a capability.
 *
 * `labelFor` is the bridge back to the host: a capability may carry a locale key
 * we have never seen (a third vendor's own credit bucket), and it must still
 * render something better than a raw dotted key. Unknown keys degrade to their
 * last segment; known ones go through the dictionary.
 *
 * @module dsh-connect-desktop/client/locale
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.dsh-connect-desktop'

/** Every key this plugin can render. */
export type CardLocaleKey =
  // ── card chrome ──────────────────────────────────────────────────────────
  | 'tab.label'
  | 'card.title'
  | 'card.subtitle'
  | 'card.empty.title'
  | 'card.empty.body'
  | 'card.renderFailed'
  | 'card.retry'
  | 'card.hostUnavailable'
  | 'card.statusError'
  | 'card.noCapabilities'
  | 'card.providerMissing'
  | 'card.reregister'
  | 'card.registering'
  | 'tabs.aria'
  | 'tabs.config'
  | 'tabs.account'
  | 'tabs.models'
  | 'tabs.diagnostics'
  | 'config.title'
  | 'config.description'
  | 'config.vendor'
  | 'config.field'
  | 'config.value'
  | 'config.default'
  | 'config.sheetTitle'
  | 'config.sheetSaved'
  | 'config.sheetFootHint'
  | 'config.group.connection'
  | 'config.group.cache'
  | 'config.group.credits'
  | 'config.group.models'
  | 'config.group.limits'
  | 'config.overridden'
  | 'config.reset'
  | 'config.save'
  | 'config.saving'
  | 'config.saved'
  | 'config.saveFailed'
  | 'config.unavailable'
  | 'config.empty'
  | 'config.restartHint'
  | 'vendor.switchAria'
  | 'vendor.unavailable'
  | 'vendor.loomy.name'
  | 'vendor.raccoon.name'
  // ── current account ──────────────────────────────────────────────────────
  | 'account.title'
  | 'account.loggedIn'
  | 'account.loggedOut'
  | 'account.credential'
  | 'account.credentialFound'
  | 'account.credentialMissing'
  | 'account.nextSteps'
  | 'account.nextStep.login'
  | 'account.nextStep.staySignedIn'
  | 'account.nextStep.recheck'
  | 'account.redetect'
  | 'account.redetecting'
  | 'account.signedInAt'
  | 'account.userIdShort'
  | 'account.source'
  | 'account.sourcePlugin'
  | 'account.sourceDesktop'
  | 'account.sourceEnv'
  | 'account.sourceNone'
  | 'account.originDesktop'
  // ── account rows ─────────────────────────────────────────────────────────
  | 'accounts.title'
  | 'accounts.titleCount'
  | 'accounts.empty'
  | 'accounts.unavailable'
  | 'accounts.failed'
  | 'accounts.refresh'
  | 'accounts.choose'
  | 'accounts.active'
  | 'accounts.benched'
  | 'accounts.benchedAuth'
  | 'accounts.benchedPoints'
  | 'accounts.rename'
  | 'accounts.more'
  | 'accounts.lastUsed'
  | 'accounts.lastUsedHint'
  | 'accounts.identityMissingHint'
  | 'accounts.identityPersonal'
  | 'accounts.identityEnterprise'
  | 'accounts.enrich'
  | 'accounts.enrichHint'
  | 'accounts.cleanup'
  | 'accounts.cleanupHint'
  | 'accounts.cleanupConfirm'
  | 'accounts.renameSave'
  | 'accounts.renameHint'
  | 'accounts.remove'
  | 'accounts.removeConfirm'
  | 'accounts.removeHint'
  | 'accounts.removing'
  | 'accounts.desktopSignIn'
  | 'accounts.desktopNote'
  | 'accounts.notRouted'
  | 'accounts.accountFallback'
  | 'accounts.creditsInline'
  | 'accounts.creditsError'
  | 'accounts.routesNow'
  | 'accounts.adopt'
  | 'accounts.adopting'
  | 'accounts.adopted'
  | 'accounts.removeFailed'
  | 'accounts.renameFailed'
  | 'accounts.switchFailed'
  | 'accounts.add'
  // ── rotation pool ────────────────────────────────────────────────────────
  | 'pool.label'
  | 'pool.title'
  | 'pool.on'
  | 'pool.off'
  | 'pool.needsTwo'
  | 'pool.failed'
  | 'pool.summary'
  // ── credits ──────────────────────────────────────────────────────────────
  | 'credits.title'
  | 'credits.unavailable'
  | 'credits.failed'
  | 'credits.fetchedAt'
  | 'credits.balanceUnavailable'
  | 'credits.degraded'
  | 'credits.total'
  | 'credits.perAccount'
  | 'credits.perAccountMissing'
  | 'credits.perAccountFailed'
  | 'credits.empty'
  | 'credits.source'
  | 'credits.ledger.title'
  | 'credits.ledger.time'
  | 'credits.ledger.description'
  | 'credits.ledger.model'
  | 'credits.ledger.amount'
  | 'credits.ledger.source'
  | 'credits.ledger.empty'
  | 'credits.field.available'
  | 'credits.field.today'
  | 'credits.field.total'
  | 'credits.field.balance'
  | 'credits.field.daily'
  | 'credits.field.reward'
  | 'credits.field.topup'
  | 'credits.field.other'
  // ── login ────────────────────────────────────────────────────────────────
  | 'login.title'
  | 'login.intro'
  | 'login.phone'
  | 'login.phonePlaceholder'
  | 'login.code'
  | 'login.codePlaceholder'
  | 'login.password'
  | 'login.passwordPlaceholder'
  | 'login.method.sms'
  | 'login.method.password'
  | 'login.sendCode'
  | 'login.sending'
  | 'login.resend'
  | 'login.resendIn'
  | 'login.submit'
  | 'login.submitting'
  | 'login.logout'
  | 'login.loggingOut'
  | 'login.codeSent'
  | 'login.sendFailed'
  | 'login.failed'
  | 'login.logoutFailed'
  | 'login.success'
  | 'login.pluginActive'
  | 'login.signedInAs'
  // ── models ───────────────────────────────────────────────────────────────
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
  | 'models.empty'
  | 'models.column.model'
  | 'models.column.multiplier'
  | 'models.column.context'
  | 'models.column.maxOutput'
  | 'models.column.vision'
  | 'models.column.efforts'
  | 'models.meta.output'
  | 'models.meta.vision'
  | 'models.meta.textOnly'
  | 'models.vision.yes'
  | 'models.vision.no'
  | 'models.efforts.none'
  | 'models.efforts.default'
  | 'models.selection'
  | 'models.refreshedAt'
  | 'models.baselineUnknown'
  | 'models.saveNeedsHost'
  | 'models.toggle'
  | 'models.unsupported'
  // ── diagnostics ──────────────────────────────────────────────────────────
  | 'diagnostics.title'
  | 'diagnostics.description'
  | 'diagnostics.refresh'
  | 'diagnostics.copy'
  | 'diagnostics.unavailable'
  | 'diagnostics.loading'
  | 'diagnostics.probes'
  | 'diagnostics.probe.run'
  | 'diagnostics.probe.hint'
  | 'diagnostics.summary.probes'
  | 'diagnostics.credential.candidate'
  | 'diagnostics.probe.ok'
  | 'diagnostics.probe.fail'
  | 'diagnostics.upstream'
  | 'diagnostics.upstream.baseUrl'
  | 'diagnostics.endpoints'
  | 'diagnostics.credential'
  | 'diagnostics.credential.source'
  | 'diagnostics.credential.problem'
  | 'diagnostics.credential.expires'
  | 'diagnostics.credential.expired'
  | 'diagnostics.account'
  | 'diagnostics.catalog'
  | 'diagnostics.catalog.counts'
  | 'diagnostics.accounts'
  | 'diagnostics.accounts.counts'
  | 'diagnostics.lastError'
  | 'diagnostics.lastError.path'
  | 'diagnostics.lastError.code'
  | 'diagnostics.lastError.at'
  | 'diagnostics.lastError.message'
  | 'diagnostics.noLastError'
  | 'diagnostics.report.title'
  | 'diagnostics.report.generatedAt'
  | 'diagnostics.report.vendor'
  | 'diagnostics.report.routes'
  | 'diagnostics.report.credential'
  | 'diagnostics.report.probes'
  | 'diagnostics.report.upstream'
  | 'diagnostics.report.endpoints'
  | 'diagnostics.report.account'
  | 'diagnostics.report.catalog'
  | 'diagnostics.report.accounts'
  | 'diagnostics.report.lastError'
  | 'diagnostics.report.none'
  | 'diagnostics.report.unknown'
  // ── transfer (export / import) ───────────────────────────────────────────
  | 'transfer.title'
  | 'transfer.export'
  | 'transfer.exportRow'
  | 'transfer.exportHint'
  | 'transfer.exporting'
  | 'transfer.exportNotice'
  | 'transfer.exportEmpty'
  | 'transfer.import'
  | 'transfer.importNow'
  | 'transfer.importing'
  | 'transfer.pasteHint'
  | 'transfer.pastePlaceholder'
  | 'transfer.pasteEmpty'
  | 'transfer.pasteReady'
  | 'transfer.importBadJson'
  | 'transfer.importDone'
  | 'transfer.failed'
  // ── composer drawer ──────────────────────────────────────────────────────
  | 'drawer.title'
  | 'drawer.close'
  | 'drawer.open'
  | 'drawer.empty'
  | 'drawer.rotating'
  | 'drawer.footHint'
  | 'drawer.openPanel'
  | 'drawer.refresh'
  | 'drawer.refreshHint'
  | 'drawer.refreshing'
  | 'drawer.benched'
  | 'drawer.benchedAuth'
  | 'drawer.benchedPoints'
  | 'drawer.accountFallback'
  | 'drawer.signedOut'
  | 'drawer.desktopHint'
  | 'drawer.creditsMissing'
  | 'drawer.creditsFailed'
  | 'drawer.partial'
  | 'drawer.degraded'
  | 'drawer.totalLabel'
  | 'drawer.progress'
  // ── composer pill ────────────────────────────────────────────────────────
  | 'composer.pill'
  | 'composer.pillBare'
  | 'composer.pillTitle'
  | 'composer.pillTitlePartial'
  | 'composer.pillPending'
  | 'composer.pillFailed'
  | 'composer.pillPartial'
  // ── shared vocabulary ────────────────────────────────────────────────────
  | 'common.loading'
  | 'common.refresh'
  | 'common.refreshing'
  | 'common.save'
  | 'common.saving'
  | 'common.discard'
  | 'common.cancel'
  | 'common.none'
  | 'common.copy'
  | 'common.copied'
  | 'common.copyFailed'
  | 'common.unknownError'
  | 'common.saveFailed'
  | 'errors.csrf'
  | 'errors.network'
  | 'errors.unavailable'
  | 'errors.stale'
  // ── community ────────────────────────────────────────────────────────────
  | 'community.title'
  | 'community.issues'
  | 'community.qqGroup'
  | 'community.wechat'
  | 'community.email'
  | 'community.hint'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Capability-driven card copy for every vendor. */
    'settings.dsh-connect-desktop': CardLocaleKey
  }
}

/** English copy. */
export const en: Record<CardLocaleKey, string> = {
  // Chrome. The sidebar label is rendered in a fixed 188px nav column with
  // `text-overflow:ellipsis`, so it stays short; the full brand lives in the
  // card title inside the wide content column.
  'tab.label': 'Desktop',
  'card.title': 'DSH Connect Desktop',
  'card.providerMissing': 'This client is not registered in the model picker yet — the reason is below.',
  'card.reregister': 'Register again',
  'card.registering': 'Registering…',
  'card.subtitle': 'Models from the desktop clients signed in on this machine, plus a read-only credits overview.',
  'card.empty.title': 'No desktop client detected',
  'card.empty.body':
    'Sign in once in one of the desktop clients below, then press “Re-check”. The card renders nothing else until a credential is found.',
  'card.renderFailed': 'The DSH Connect Desktop card failed to render; the rest of the settings page is unaffected.',
  'card.retry': 'Retry',
  'card.hostUnavailable':
    'The host does not expose the plugin routes (404/503). Make sure the host half is enabled, then restart DSH.',
  'card.statusError': 'Could not read the vendor status: {message}',
  'card.noCapabilities': 'This vendor declares no settings surface.',
  'tabs.aria': 'DSH Connect Desktop sections',
  'tabs.account': 'Account',
  'tabs.config': 'Configuration',
  'tabs.models': 'Models',
  'tabs.diagnostics': 'Diagnostics',
  'vendor.switchAria': 'Vendors',
  'vendor.unavailable': 'No {name} client detected.',
  'vendor.loomy.name': 'Loomy',
  'vendor.raccoon.name': 'Raccoon',
  // Current account
  'account.title': 'Current account',
  'account.loggedIn': 'Signed in',
  'account.loggedOut': 'Not signed in',
  'account.credential': 'Credential file',
  'account.credentialFound': 'Found',
  'account.credentialMissing': 'Not found: {path}',
  'account.nextSteps': 'Next steps',
  'account.nextStep.login': 'Open the desktop client and sign in once with your phone number.',
  'account.nextStep.staySignedIn': 'Keep the client signed in and run it once so it refreshes its credential file.',
  'account.nextStep.recheck': 'Come back here and press “Re-check”.',
  'account.redetect': 'Re-check',
  'account.redetecting': 'Re-checking…',
  'account.signedInAt': 'Signed in',
  'account.userIdShort': 'User {userId}',
  'account.source': 'Source',
  'account.sourcePlugin': 'this plugin',
  'account.sourceDesktop': 'desktop client',
  'account.sourceEnv': 'env override',
  'account.sourceNone': 'none',
  'account.originDesktop': 'desktop',
  // Account rows
  'accounts.title': 'Accounts',
  'accounts.titleCount': 'Accounts ({count})',
  'accounts.empty': 'No account yet.',
  'accounts.unavailable': 'The account list is not available on this host build.',
  'accounts.failed': 'Could not read the account list: {message}',
  'accounts.refresh': 'Refresh',
  'accounts.choose': 'Use this account',
  'accounts.active': 'in use',
  'accounts.benched': 'skipped by rotation',
  'accounts.benchedAuth': 'sign-in expired',
  'accounts.benchedPoints': 'out of points',
  'accounts.rename': 'Rename',
  'accounts.more': 'More actions',
  'accounts.lastUsed': 'last success',
  'accounts.lastUsedHint': 'The account that paid for the most recent successful model call. A benched account is never marked.',
  'accounts.identityMissingHint': 'This account has no recorded phone. Rename it from ⋯, or remove and sign in again.',
  'accounts.identityPersonal': 'Personal',
  'accounts.identityEnterprise': 'Enterprise',
  'accounts.enrich': 'Fill in phone numbers',
  'accounts.enrichHint': '{count} accounts have no phone number. Try looking them up from the vendor?',
  'accounts.cleanup': 'Clean up',
  'accounts.cleanupHint': '{count} accounts have no phone or name — you cannot tell them apart.',
  'accounts.cleanupConfirm': 'Remove all {count}',
  'accounts.renameSave': 'Save name',
  'accounts.renameHint': 'Shows up in the model picker instead of the phone number.',
  'accounts.remove': 'Remove',
  'accounts.removeConfirm': 'Remove it',
  'accounts.removeHint': 'Removes the sign-in from this machine; adding it back needs a fresh login unless you exported it.',
  'accounts.removing': 'Removing…',
  'accounts.desktopSignIn': 'Desktop sign-in',
  'accounts.desktopNote': 'Owned by the desktop client — sign out there to remove it.',
  'accounts.notRouted': 'not routed',
  'accounts.accountFallback': 'Account {index}',
  'accounts.creditsInline': '· {available} pts',
  'accounts.creditsError': '· points unavailable',
  'accounts.routesNow': 'Model picker routes:',
  'accounts.adopt': 'Add to list',
  'accounts.adopting': 'Adding…',
  'accounts.adopted': 'Added as {route} — pick it in the model picker.',
  'accounts.removeFailed': 'Could not remove the account.',
  'accounts.renameFailed': 'Could not rename the account.',
  'accounts.switchFailed': 'Could not switch the account.',
  'accounts.add': 'New account',
  // Pool
  'pool.label': 'Pick a healthy account at random for each call',
  'pool.title': 'Rotation',
  'pool.on': 'On',
  'pool.off': 'Off',
  'pool.needsTwo': 'Needs at least two accounts to appear in the model picker.',
  'pool.failed': 'Could not change the rotation setting.',
  'pool.summary': '{healthy} healthy of {total}',
  // Credits
  'credits.title': 'Credits',
  'credits.unavailable': 'The host does not expose the credits route.',
  'credits.failed': 'Could not read credits: {message}',
  'credits.balanceUnavailable':
    'The balance endpoint is rate-limited right now (HTTP 403), so the totals are hidden — the ledger below is live.',
  'credits.degraded':
    'Only the available total is shown — it comes from the settings summary, because the per-bucket endpoint is rate-limited. Daily / reward / top-up breakdown is unavailable.',
  'credits.fetchedAt': 'Read at {time}',
  'credits.total': 'Total (all accounts)',
  'credits.perAccount': 'Per account',
  'credits.perAccountMissing': 'not reported',
  'credits.perAccountFailed': 'unreadable',
  'credits.empty': 'The upstream reported no figures.',
  'credits.source': 'from {account}',
  'credits.ledger.title': 'Recent records',
  'credits.ledger.time': 'Time',
  'credits.ledger.description': 'What',
  'credits.ledger.model': 'Model',
  'credits.ledger.amount': 'Amount',
  'credits.ledger.source': 'Account',
  'credits.ledger.empty': 'No records',
  'credits.field.available': 'Available',
  'credits.field.today': 'Today',
  'credits.field.total': 'Balance',
  'credits.field.balance': 'Balance',
  'credits.field.daily': 'Daily balance',
  'credits.field.reward': 'Reward',
  'credits.field.topup': 'Top-up',
  'credits.field.other': 'Other',
  // Login
  'login.title': 'Add an account',
  'login.intro': 'Accounts signed in here take precedence over the desktop client.',
  'login.phone': 'Phone number',
  'login.phonePlaceholder': 'Phone number',
  'login.code': 'Verification code',
  'login.codePlaceholder': 'Verification code',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Account password',
  'login.method.sms': 'SMS code',
  'login.method.password': 'Password',
  'login.sendCode': 'Send code',
  'login.sending': 'Sending…',
  'login.resend': 'Resend',
  'login.resendIn': 'Resend in {seconds}s',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.logout': 'Sign out',
  'login.loggingOut': 'Signing out…',
  'login.codeSent': 'Code sent to {phone}.',
  'login.sendFailed': 'Could not send the code.',
  'login.failed': 'Sign-in failed.',
  'login.logoutFailed': 'Sign-out failed.',
  'login.success': 'Signed in.',
  'login.pluginActive': 'Using the account signed in through this plugin.',
  'login.signedInAs': 'Signed in as {account}',
  // Models
  'models.title': 'Model catalog',
  'models.description': 'Checkboxes are a draft — only Save writes them into the model picker.',
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
  'models.unavailable': 'The host does not expose the catalog routes.',
  'models.loading': 'Loading the catalog…',
  'models.empty': 'The upstream catalog has no usable chat models.',
  'models.column.model': 'Model',
  'models.column.multiplier': 'Rate',
  'models.column.context': 'Context',
  'models.column.maxOutput': 'Max output',
  'models.column.vision': 'Vision',
  'models.column.efforts': 'Reasoning',
  'models.meta.output': '{tokens} output',
  'models.meta.vision': 'images',
  'models.meta.textOnly': 'text only',
  'models.vision.yes': 'Yes',
  'models.vision.no': 'No',
  'models.efforts.none': 'None',
  'models.efforts.default': 'default {effort}',
  'models.selection': '{selected}/{total} selected',
  'models.refreshedAt': 'Catalog refreshed at {time}',
  'models.baselineUnknown': 'The host has not reported the saved selection yet.',
  'models.saveNeedsHost': 'The host is not ready yet; saving is disabled.',
  'models.toggle': 'Enable {name}',
  'models.unsupported': 'This vendor declares no model selection.',
  // Diagnostics
  'config.title': 'Configuration',
  'config.description': 'Endpoints and cache lifetimes for this client. Changes take effect immediately.',
  'config.vendor': 'Provider',
  'config.field': 'Field',
  'config.value': 'Value',
  'config.default': 'Default',
  'config.sheetTitle': '{vendor} · settings',
  'config.sheetSaved': 'Saved',
  'config.sheetFootHint': 'The full settings page is in Settings → Desktop models.',
  'config.group.connection': 'Connection',
  'config.group.cache': 'Cache',
  'config.group.credits': 'Points',
  'config.group.models': 'Models & capabilities',
  'config.group.limits': 'Rate limits',
  'config.overridden': 'changed',
  'config.reset': 'Reset to default',
  'config.save': 'Save',
  'config.saving': 'Saving…',
  'config.saved': 'Saved.',
  'config.saveFailed': 'Could not save the configuration.',
  'config.unavailable': 'This host does not expose its configuration.',
  'config.empty': 'This provider declares no configuration.',
  'config.restartHint': 'Saved values apply immediately; no restart needed.',
  'diagnostics.title': 'Diagnostics',
  'diagnostics.description': 'Read-only facts — copy the whole block into a bug report.',
  'diagnostics.refresh': 'Reload',
  'diagnostics.copy': 'Copy all',
  'diagnostics.unavailable': 'The host does not expose the diagnostics route.',
  'diagnostics.loading': 'Loading diagnostics…',
  'diagnostics.probes': 'Credential path candidates',
  'diagnostics.probe.run': 'Run probes',
  'diagnostics.probe.hint': 'Probes are recorded on read. Run them to ask the upstream now.',
  'diagnostics.summary.probes': '{ok}/{total} probes ok',
  'diagnostics.credential.candidate': 'Candidate',
  'diagnostics.probe.ok': 'ok',
  'diagnostics.probe.fail': 'unavailable',
  'diagnostics.upstream': 'Upstream',
  'diagnostics.upstream.baseUrl': 'Base URL',
  'diagnostics.endpoints': 'Endpoints',
  'diagnostics.credential': 'Credential conclusion',
  'diagnostics.credential.source': 'Credential file',
  'diagnostics.credential.problem': 'Problem',
  'diagnostics.credential.expires': 'Expires',
  'diagnostics.credential.expired': 'expired',
  'diagnostics.account': 'Account in service',
  'diagnostics.catalog': 'Catalog',
  'diagnostics.catalog.counts': '{total} models, {enabled} enabled',
  'diagnostics.accounts': 'Accounts',
  'diagnostics.accounts.counts': '{healthy} healthy of {total}',
  'diagnostics.lastError': 'Last upstream error (verbatim)',
  'diagnostics.lastError.path': 'Path',
  'diagnostics.lastError.code': 'Code',
  'diagnostics.lastError.at': 'At',
  'diagnostics.lastError.message': 'Message',
  'diagnostics.noLastError': 'No upstream error has been recorded',
  'diagnostics.report.title': 'DSH Connect Desktop diagnostics report',
  'diagnostics.report.generatedAt': 'Generated at',
  'diagnostics.report.vendor': 'Vendor',
  'diagnostics.report.routes': 'Host routes',
  'diagnostics.report.credential': 'Credential conclusion',
  'diagnostics.report.probes': 'Credential path candidates',
  'diagnostics.report.upstream': 'Upstream',
  'diagnostics.report.endpoints': 'Endpoints',
  'diagnostics.report.account': 'Account in service',
  'diagnostics.report.catalog': 'Catalog',
  'diagnostics.report.accounts': 'Accounts',
  'diagnostics.report.lastError': 'Last upstream error',
  'diagnostics.report.none': 'none',
  'diagnostics.report.unknown': 'unknown',
  // Transfer
  'transfer.title': 'Export / import',
  'transfer.export': 'Export all',
  'transfer.exportRow': 'Export',
  'transfer.exportHint': 'The bundle contains live sessions: treat it like a password.',
  'transfer.exporting': 'Exporting…',
  'transfer.exportNotice': 'Exported. Paste the bundle on the other machine to sign in there without a code.',
  'transfer.exportEmpty': 'No accounts to export yet.',
  'transfer.import': 'Import',
  'transfer.importNow': 'Confirm import',
  'transfer.importing': 'Importing…',
  'transfer.pasteHint': 'Paste a bundle exported from this plugin, or the desktop client session file.',
  'transfer.pastePlaceholder': 'Paste the JSON here',
  'transfer.pasteEmpty': 'Nothing pasted yet.',
  'transfer.pasteReady': 'Ready to import.',
  'transfer.importBadJson': 'That is not valid JSON — paste the whole document, including the outer braces.',
  'transfer.importDone': 'Imported: added {added}, refreshed {refreshed}, skipped {skipped}.',
  'transfer.failed': 'Transfer failed.',
  // Drawer
  'drawer.title': 'Accounts',
  'drawer.close': 'Close',
  'drawer.open': 'Choose account',
  'drawer.empty': 'No account yet — add one in the settings card.',
  'drawer.rotating': 'Rotation is on: each call picks a healthy account, so no single row is active.',
  'drawer.footHint': 'Add or remove accounts in Settings → Desktop models.',
  'drawer.openPanel': 'Open panel',
  'drawer.refresh': 'Refresh',
  'drawer.refreshHint': 'Re-read the balances from the vendor (bypasses the cache).',
  'drawer.refreshing': 'Reading…',
  'drawer.benched': 'skipped by rotation',
  'drawer.benchedAuth': 'sign-in expired',
  'drawer.benchedPoints': 'out of points',
  'drawer.accountFallback': 'Account {index}',
  'drawer.signedOut': 'Not signed in. Open the desktop client and sign in once.',
  'drawer.desktopHint': 'Owned by the desktop client — sign out there to remove it.',
  'drawer.creditsMissing': 'No points figure for this account yet — press the refresh button to read it.',
  'drawer.creditsFailed': 'Points could not be read: {message} — press the refresh button to retry.',
  'drawer.partial': 'The balance endpoint is rate limited ({message}), so the per-account figures are missing; the ledger still loads.',
  'drawer.degraded': 'Only the available total is shown (from the settings summary): the per-bucket endpoint is rate limited.',
  'drawer.totalLabel': 'Total',
  'drawer.progress': '{done}/{total} read',
  // Composer pill
  'composer.pill': '{vendor} · {amount} pts',
  'composer.pillBare': '—',
  'composer.pillTitle': '{vendor} credits — {available} in total across accounts. Click for the per-account list.',
  'composer.pillTitlePartial':
    '{vendor} credits — {available} counted across readable accounts ({unreadable} unreadable; open the drawer to see which).',
  'composer.pillPending': '{vendor} credits are still loading — click to open the drawer and retry.',
  'composer.pillFailed': '{vendor} credits could not be read: {message} — click to open the drawer and retry.',
  'composer.pillPartial': '{vendor} balance endpoint is rate limited right now — no total available. Click for the ledger.',
  // Shared
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',
  'common.refreshing': 'Refreshing…',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.discard': 'Discard',
  'common.cancel': 'Cancel',
  'common.none': '—',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.copyFailed': 'Copy failed — select the text and copy it manually.',
  'common.unknownError': 'Unknown error',
  'common.saveFailed': 'Save failed: {message}',
  'errors.csrf': 'The host has not provided a CSRF token yet — re-check first.',
  'errors.network': 'Cannot reach the host: {message}',
  'errors.unavailable': 'The host does not expose this route.',
  'errors.stale': 'This route does not exist in the running DSH process yet (old host). Restart DSH.',
  // Community
  'community.title': 'Community',
  'community.issues': 'GitHub Issues',
  'community.qqGroup': 'QQ group',
  'community.wechat': 'WeChat',
  'community.email': 'Email',
  'community.hint':
    'Stuck? The diagnostics tab copies a ready-to-paste report (no tokens). Ask in Issues, or in the QQ group.',
}

/** Simplified Chinese copy. */
export const zh: Record<CardLocaleKey, string> = {
  'tab.label': '桌面模型',
  'card.title': 'DSH Connect Desktop',
  'card.providerMissing': '这家客户端还没有注册进模型选择器——原因见下。',
  'card.reregister': '重新注册',
  'card.registering': '正在重新注册…',
  'card.subtitle': '把本机已登录桌面客户端的模型接入模型选择器，并提供只读积分概览。',
  'card.empty.title': '未检测到桌面客户端',
  'card.empty.body': '在下面的某个桌面客户端里登录一次，回到这里点「重新检测」。在找到凭证之前，卡片不渲染其他内容。',
  'card.renderFailed': 'DSH Connect Desktop 设置卡片渲染失败；宿主其余设置不受影响。',
  'card.retry': '重试',
  'card.hostUnavailable': '宿主没有提供插件路由（404/503）。请确认宿主半边已启用，然后重启 DSH。',
  'card.statusError': '读取供应商状态失败：{message}',
  'card.noCapabilities': '该供应商没有声明任何设置项。',
  'tabs.aria': 'DSH Connect Desktop 设置分区',
  'tabs.account': '账号',
  'tabs.config': '配置',
  'tabs.models': '模型',
  'tabs.diagnostics': '诊断',
  'vendor.switchAria': '供应商',
  'vendor.unavailable': '未检测到 {name} 客户端。',
  'vendor.loomy.name': 'Loomy',
  'vendor.raccoon.name': '小浣熊',
  'account.title': '当前账号',
  'account.loggedIn': '已登录',
  'account.loggedOut': '未登录',
  'account.credential': '凭证文件',
  'account.credentialFound': '已找到',
  'account.credentialMissing': '未找到：{path}',
  'account.nextSteps': '下一步',
  'account.nextStep.login': '打开桌面客户端，用手机号完成登录。',
  'account.nextStep.staySignedIn': '保持客户端登录，并运行一次，让它刷新凭证文件。',
  'account.nextStep.recheck': '回到这里点「重新检测」。',
  'account.redetect': '重新检测',
  'account.redetecting': '检测中…',
  'account.signedInAt': '登录于',
  'account.userIdShort': '用户 {userId}',
  'account.source': '来源',
  'account.sourcePlugin': '本插件',
  'account.sourceDesktop': '桌面客户端',
  'account.sourceEnv': '环境变量',
  'account.sourceNone': '无',
  'account.originDesktop': '桌面',
  'accounts.title': '账号',
  'accounts.titleCount': '账号（{count}）',
  'accounts.empty': '还没有账号。',
  'accounts.unavailable': '当前宿主版本未提供账号列表。',
  'accounts.failed': '读取账号列表失败：{message}',
  'accounts.refresh': '刷新',
  'accounts.choose': '使用此账号',
  'accounts.active': '使用中',
  'accounts.benched': '轮换已跳过',
  'accounts.benchedAuth': '登录已失效',
  'accounts.benchedPoints': '积分不足',
  'accounts.rename': '重命名',
  'accounts.more': '更多操作',
  'accounts.lastUsed': '上次成功',
  'accounts.lastUsedHint': '最近一次**成功**的模型调用用的是这个账号；已被跳过的账号不会带这个标记。',
  'accounts.identityMissingHint': '这个账号没有记录手机号。可以用 ⋯ → 重命名给它起个名字，或移除后重新登录。',
  'accounts.identityPersonal': '个人账号',
  'accounts.identityEnterprise': '企业账号',
  'accounts.enrich': '补全手机号',
  'accounts.enrichHint': '有 {count} 个账号没有手机号，可以向上游查一次补回来。',
  'accounts.cleanup': '清理',
  'accounts.cleanupHint': '有 {count} 个账号没有记录号码也没有名字，无法分辨是哪一条。',
  'accounts.cleanupConfirm': '移除这 {count} 个',
  'accounts.renameSave': '保存名称',
  'accounts.renameHint': '模型选择器里显示这个名字，替代手机号。',
  'accounts.remove': '移除',
  'accounts.removeConfirm': '确认移除',
  'accounts.removeHint': '会把这台机器上的登录态删掉；除非你导出过，否则重新添加需要再登录一次。',
  'accounts.removing': '移除中…',
  'accounts.desktopSignIn': '桌面客户端登录态',
  'accounts.desktopNote': '由桌面客户端持有——要移除请在客户端里退出登录。',
  'accounts.notRouted': '未接入路由',
  'accounts.accountFallback': '账号 {index}',
  'accounts.creditsInline': '· {available} 积分',
  'accounts.creditsError': '· 积分不可用',
  'accounts.routesNow': '模型选择器中的路由：',
  'accounts.adopt': '加入账号表',
  'accounts.adopting': '加入中…',
  'accounts.adopted': '已加入为 {route}——在模型选择器里选它即可。',
  'accounts.removeFailed': '移除账号失败。',
  'accounts.renameFailed': '重命名失败。',
  'accounts.switchFailed': '切换账号失败。',
  'accounts.add': '新增账号',
  'pool.label': '每次调用随机选一个健康账号',
  'pool.title': '轮换',
  'pool.on': '开',
  'pool.off': '关',
  'pool.needsTwo': '至少需要两个账号，才会出现在模型选择器里。',
  'pool.failed': '修改轮换设置失败。',
  'pool.summary': '{total} 个账号中 {healthy} 个健康',
  'credits.title': '积分',
  'credits.unavailable': '宿主未提供积分路由。',
  'credits.failed': '积分读取失败：{message}',
  'credits.balanceUnavailable': '余额接口暂时被限流（HTTP 403），所以不显示总额；下面的明细是实时数据。',
  'credits.degraded':
    '这里只有「可用积分」——余额桶接口被限流，这个数字来自设置摘要；每日/奖励/充值的拆分暂时读不到。',
  'credits.fetchedAt': '读取于 {time}',
  'credits.total': '合计（全部账号）',
  'credits.perAccount': '按账号',
  'credits.perAccountMissing': '未提供',
  'credits.perAccountFailed': '读取失败',
  'credits.empty': '上游没有给出任何数值。',
  'credits.source': '来自 {account}',
  'credits.ledger.title': '最近流水',
  'credits.ledger.time': '时间',
  'credits.ledger.description': '事项',
  'credits.ledger.model': '模型',
  'credits.ledger.amount': '数量',
  'credits.ledger.source': '账号',
  'credits.ledger.empty': '暂无流水',
  'credits.field.available': '可用',
  'credits.field.today': '今日',
  'credits.field.total': '总额',
  'credits.field.balance': '余额',
  'credits.field.daily': '每日余额',
  'credits.field.reward': '奖励',
  'credits.field.topup': '充值',
  'credits.field.other': '其他',
  'login.title': '新增账号',
  'login.intro': '在这里登录的账号优先于桌面客户端。',
  'login.phone': '手机号',
  'login.phonePlaceholder': '手机号',
  'login.code': '验证码',
  'login.codePlaceholder': '验证码',
  'login.password': '密码',
  'login.passwordPlaceholder': '账号密码',
  'login.method.sms': '短信验证码',
  'login.method.password': '密码',
  'login.sendCode': '发送验证码',
  'login.sending': '发送中…',
  'login.resend': '重新发送',
  'login.resendIn': '{seconds} 秒后可重发',
  'login.submit': '登录',
  'login.submitting': '登录中…',
  'login.logout': '退出登录',
  'login.loggingOut': '退出中…',
  'login.codeSent': '验证码已发送至 {phone}。',
  'login.sendFailed': '发送验证码失败。',
  'login.failed': '登录失败。',
  'login.logoutFailed': '退出登录失败。',
  'login.success': '已登录。',
  'login.pluginActive': '正在使用通过本插件登录的账号。',
  'login.signedInAs': '已登录：{account}',
  'models.title': '模型目录',
  'models.description': '勾选是草稿——只有「保存勾选」才会写进模型选择器。',
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
  'models.unavailable': '宿主未提供目录路由。',
  'models.loading': '正在读取目录…',
  'models.empty': '上游目录中没有可用的聊天模型。',
  'models.column.model': '模型',
  'models.column.multiplier': '倍率',
  'models.column.context': '上下文',
  'models.column.maxOutput': '最大输出',
  'models.column.vision': '视觉',
  'models.column.efforts': '推理',
  'models.meta.output': '{tokens} 输出',
  'models.meta.vision': '可识图',
  'models.meta.textOnly': '纯文本',
  'models.vision.yes': '支持',
  'models.vision.no': '不支持',
  'models.efforts.none': '无',
  'models.efforts.default': '默认 {effort}',
  'models.selection': '已选 {selected}/{total}',
  'models.refreshedAt': '目录刷新于 {time}',
  'models.baselineUnknown': '宿主尚未提供已保存的勾选。',
  'models.saveNeedsHost': '宿主还没准备好，保存已禁用。',
  'models.toggle': '启用 {name}',
  'models.unsupported': '该供应商没有声明模型选择能力。',
  'config.title': '配置',
  'config.description': '这家客户端的接口地址与缓存时长；保存后立即生效。',
  'config.vendor': '供应商',
  'config.field': '字段',
  'config.value': '当前值',
  'config.default': '默认值',
  'config.sheetTitle': '{vendor} · 配置',
  'config.sheetSaved': '已保存',
  'config.sheetFootHint': '完整设置见「设置 → 桌面模型」。',
  'config.group.connection': '连接',
  'config.group.cache': '缓存',
  'config.group.credits': '积分',
  'config.group.models': '模型与能力',
  'config.group.limits': '限流保护',
  'config.overridden': '已修改',
  'config.reset': '恢复默认',
  'config.save': '保存',
  'config.saving': '保存中…',
  'config.saved': '已保存。',
  'config.saveFailed': '配置没有保存成功。',
  'config.unavailable': '当前宿主没有暴露配置。',
  'config.empty': '这家供应商没有声明配置项。',
  'config.restartHint': '保存后立即生效，不需要重启。',
  'diagnostics.title': '诊断',
  'diagnostics.description': '只读事实——整块复制到问题报告里。',
  'diagnostics.refresh': '重新读取',
  'diagnostics.copy': '复制全部',
  'diagnostics.unavailable': '宿主未提供诊断路由。',
  'diagnostics.loading': '正在读取诊断信息…',
  'diagnostics.probes': '凭据候选路径',
  'diagnostics.probe.run': '运行探针',
  'diagnostics.probe.hint': '下面是上次读取时记录的结果；点「运行探针」问一次上游现在的答案。',
  'diagnostics.summary.probes': '探针 {ok}/{total} 可用',
  'diagnostics.credential.candidate': '候选',
  'diagnostics.probe.ok': '可用',
  'diagnostics.probe.fail': '不可用',
  'diagnostics.upstream': '上游',
  'diagnostics.upstream.baseUrl': 'Base URL',
  'diagnostics.endpoints': '端点',
  'diagnostics.credential': '凭据结论',
  'diagnostics.credential.source': '凭证文件',
  'diagnostics.credential.problem': '问题',
  'diagnostics.credential.expires': '过期时间',
  'diagnostics.credential.expired': '已过期',
  'diagnostics.account': '在用账号',
  'diagnostics.catalog': '目录',
  'diagnostics.catalog.counts': '{total} 条，启用 {enabled} 条',
  'diagnostics.accounts': '账号',
  'diagnostics.accounts.counts': '{total} 个账号，{healthy} 个健康',
  'diagnostics.lastError': '上游最近一次错误（原文）',
  'diagnostics.lastError.path': '路径',
  'diagnostics.lastError.code': '错误码',
  'diagnostics.lastError.at': '时间',
  'diagnostics.lastError.message': '消息',
  'diagnostics.noLastError': '还没有记录到上游错误',
  'diagnostics.report.title': 'DSH Connect Desktop 诊断报告',
  'diagnostics.report.generatedAt': '生成时间',
  'diagnostics.report.vendor': '供应商',
  'diagnostics.report.routes': '宿主路由',
  'diagnostics.report.credential': '凭据结论',
  'diagnostics.report.probes': '凭据候选路径',
  'diagnostics.report.upstream': '上游',
  'diagnostics.report.endpoints': '端点',
  'diagnostics.report.account': '在用账号',
  'diagnostics.report.catalog': '目录',
  'diagnostics.report.accounts': '账号',
  'diagnostics.report.lastError': '上游最近一次错误',
  'diagnostics.report.none': '无',
  'diagnostics.report.unknown': '未知',
  'transfer.title': '导出 / 导入',
  'transfer.export': '全部导出',
  'transfer.exportRow': '导出',
  'transfer.exportHint': '导出内容包含登录态，请像对待密码一样对待它。',
  'transfer.exporting': '导出中…',
  'transfer.exportNotice': '已导出。把这段内容粘贴到另一台机器即可免验证码登录。',
  'transfer.exportEmpty': '还没有可导出的账号。',
  'transfer.import': '导入',
  'transfer.importNow': '确认导入',
  'transfer.importing': '导入中…',
  'transfer.pasteHint': '粘贴本插件导出的凭证包，或桌面客户端的登录态文件。',
  'transfer.pastePlaceholder': '在这里粘贴 JSON',
  'transfer.pasteEmpty': '还没有粘贴内容。',
  'transfer.pasteReady': '可以导入了。',
  'transfer.importBadJson': '这不是合法的 JSON——请粘贴完整文档（包括外层大括号）。',
  'transfer.importDone': '已导入：新增 {added}，刷新 {refreshed}，跳过 {skipped}。',
  'transfer.failed': '迁移失败。',
  'drawer.title': '账号',
  'drawer.close': '关闭',
  'drawer.open': '选择账号',
  'drawer.empty': '还没有账号——请到设置卡片里添加。',
  'drawer.rotating': '轮换已开启：每次调用随机选一个健康账号，因此没有单一「当前账号」。',
  'drawer.footHint': '在「设置 → 桌面模型」里增删账号。',
  'drawer.openPanel': '打开面板',
  'drawer.refresh': '刷新',
  'drawer.refreshHint': '重新从上游读取余额（绕过缓存）。',
  'drawer.refreshing': '读取中…',
  'drawer.benched': '轮换已跳过',
  'drawer.benchedAuth': '登录已失效',
  'drawer.benchedPoints': '积分不足',
  'drawer.accountFallback': '账号 {index}',
  'drawer.signedOut': '未登录。请打开桌面客户端登录一次。',
  'drawer.desktopHint': '由桌面客户端持有——要移除请在客户端里退出登录。',
  'drawer.creditsMissing': '这个账号还没有积分读数——点右上角的刷新按钮读取。',
  'drawer.creditsFailed': '积分读取失败：{message}——可点右上角的刷新按钮重试。',
  'drawer.partial': '余额接口暂时被限流（{message}），逐账号数字读不到；流水明细仍可看。',
  'drawer.degraded': '只有「可用积分」（来自设置摘要）：余额桶接口被限流，每日/奖励/充值拆分读不到。',
  'drawer.totalLabel': '合计',
  'drawer.progress': '已读 {done}/{total}',
  'composer.pill': '{vendor} · {amount} 积分',
  /*
   * 缺数字时显示 `—`，不显示供应商名：名字已经在左边了，重复一遍等于把
   * "读不到"伪装成"这块本来就只有一个名字"。`—` 与卡片、抽屉里的缺失同义。
   */
  'composer.pillBare': '—',
  'composer.pillTitle': '{vendor} 积分——所有账号合计 {available}。点击查看每个账号。',
  'composer.pillTitlePartial':
    '{vendor} 积分——能读到的账号合计 {available}（{unreadable} 个账号读不到，打开抽屉看是哪一个）。',
  'composer.pillPending': '{vendor} 积分仍在读取——点击可打开抽屉重试。',
  'composer.pillFailed': '{vendor} 积分读取失败：{message}——点击可打开抽屉重试。',
  'composer.pillPartial': '{vendor} 余额接口暂时被限流，读不到总额；明细仍是实时数据。点击打开抽屉。',
  'common.loading': '加载中…',
  'common.refresh': '刷新',
  'common.refreshing': '刷新中…',
  'common.save': '保存',
  'common.saving': '保存中…',
  'common.discard': '放弃修改',
  'common.cancel': '取消',
  'common.none': '—',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFailed': '复制失败，请手动选择文本复制。',
  'common.unknownError': '未知错误',
  'common.saveFailed': '保存失败：{message}',
  'errors.csrf': '宿主尚未提供 CSRF 令牌，请先重新检测。',
  'errors.network': '无法访问宿主：{message}',
  'errors.unavailable': '宿主未提供该路由。',
  'errors.stale': '该接口在当前运行的 DSH 进程里还不存在（宿主仍是旧版本）。请重启 DSH 后再试。',
  'community.title': '社群与反馈',
  'community.issues': 'GitHub Issues',
  'community.qqGroup': 'QQ 群',
  'community.wechat': '微信',
  'community.email': '邮箱',
  'community.hint': '卡住了？诊断页可一键复制一份可直接粘贴的报告（不含令牌）。到 Issues 或 QQ 群提问。',
}

/** Whether a host-supplied key is one this dictionary knows. */
export function isCardLocaleKey(key: string): key is CardLocaleKey {
  return Object.prototype.hasOwnProperty.call(zh, key)
}

/**
 * Translate a **host-supplied** label key.
 *
 * A capability carries `labelKey` strings, so the key domain is open: a third
 * vendor declares `credits.field.<itsOwnBucket>` and this dictionary has never
 * heard of it. Rendering the raw dotted key would be a bug report of its own, so
 * an unknown key degrades to its last segment (`labelKey: 'points.earned'` →
 * `earned`), and a bare key is additionally tried as `credits.field.<key>`
 * because that is the one namespace the contract points at.
 */
export function labelFor(t: (key: never, params?: never) => string, key: string | undefined): string {
  if (key === undefined || key.length === 0) return '—'
  const candidates = [key, `credits.field.${key}`]
  for (const candidate of candidates) {
    if (isCardLocaleKey(candidate)) return (t as unknown as (key: string) => string)(candidate)
  }
  const segment = key.split('.').pop()
  return segment === undefined || segment.length === 0 ? key : segment
}

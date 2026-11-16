/**
 * The multi-account store.
 *
 * An account is one Loomy sign-in (session + masked identity) plus a **stable
 * slot number**. The slot is what the provider route derives from:
 *
 * | slot | route id   |
 * | --- | --- |
 * | 1 | `loomy`      |
 * | 2 | `loomy-2`    |
 * | 3 | `loomy-3`    |
 *
 * Slots are assigned once and never renumbered, so removing account 2 leaves
 * `loomy-3` in place: a conversation saved against `loomy-3` keeps resolving
 * instead of silently rebinding to a different person's quota.
 *
 * Two sources of accounts:
 * - **plugin accounts** — logged in through the settings card, persisted here;
 * - **desktop account** — the Loomy desktop client's `auth-session.json`, not
 *   stored, surfaced read-only as slot 1 **only while no plugin account
 *   exists** (the single-account behaviour that shipped before multi-account,
 *   preserved exactly).
 *
 * Sessions live only in this file (0600) and in memory; they are never logged,
 * never returned by a route, and never included in a snapshot view.
 *
 * @module dsh-connect-loomy/accounts
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { displayPhone, displayUserId, isRecord, safeErrorMessage } from './shared/text.js'


/** Current accounts-file schema version. */
export const ACCOUNTS_VERSION = 1

/** One account the plugin holds. */
export interface StoredAccount {
  /** SHA-256 prefix of the session; also the de-duplication key. */
  id: string
  /** Stable slot; 1 → route `loomy`, N → route `loomy-N`. Never renumbered. */
  slot: number
  /** The raw session. Never serialised into a view. */
  session: string
  phone?: string
  userId?: string
  /** User-editable display label; falls back to the masked phone. */
  label?: string
  addedAt: number
  /**
   * Pool health. Set when a request through this account failed in a way that
   * means "do not try this one next time" (dead session, upstream quota/auth
   * refusal). The pool skips it until the cooldown lapses; a successful call
   * clears it.
   */
  unavailableAt?: number
  unavailableCode?: string
  unavailableMessage?: string
}

/** Everything persisted. */
export interface PersistedAccounts {
  version: typeof ACCOUNTS_VERSION
  accounts: StoredAccount[]
}

/** A provider route plus the identity shown for it. */
export interface AccountRoute {
  /** pi-ai / harness provider id (`loomy`, `loomy-2`, …). */
  route: string
  /** Stable slot the route belongs to. */
  slot: number
  /** Shown as the provider name in the model picker. */
  displayName: string
  /** `plugin` for a stored account, `desktop` for the read-only fallback. */
  origin: 'plugin' | 'desktop'
  /** Account id (`undefined` for the desktop fallback, which is not stored). */
  accountId?: string
  phone?: string
}

/** What the single route is called in the model picker. */
export const PROVIDER_ROUTE_NAME = 'Loomy'

/** The base route id; slot 1 uses it verbatim. */
export const BASE_ROUTE = 'loomy'

/** Route id for one slot. */
export function routeForSlot(slot: number): string {
  return slot <= 1 ? BASE_ROUTE : `${BASE_ROUTE}-${slot}`
}

/** Slot encoded in a route id, or `undefined` when it is not ours. */
export function slotForRoute(route: string): number | undefined {
  if (route === BASE_ROUTE) return 1
  const match = /^loomy-(\d+)$/u.exec(route)
  if (match === null) return undefined
  const slot = Number(match[1])
  return Number.isInteger(slot) && slot > 1 ? slot : undefined
}

/** True for every route this plugin owns. */
export function isOurRoute(route: string): boolean {
  return slotForRoute(route) !== undefined
}

/** Session fingerprint used as the account id. */
export function accountIdOf(session: string): string {
  return createHash('sha256').update(session).digest('hex').slice(0, 16)
}

/** Accounts file path inside the plugin storage directory. */
export function accountsFilePath(storageDir: string): string {
  return join(storageDir, 'accounts.json')
}

/** Empty document. */
export function emptyAccounts(): PersistedAccounts {
  return { version: ACCOUNTS_VERSION, accounts: [] }
}

/**
 * Normalize one stored row on read.
 *
 * Older builds could store a **masked** phone (`189****2700`) where a number
 * belongs — it came from a bundle exported while masking was still on. Left
 * in place it masks down again to nonsense (`1*****0`) in the provider name,
 * so it is demoted to a label on the way out. The real number is not
 * recoverable from it; the user's next login or import supplies one.
 */
function normalizeStoredAccount(account: StoredAccount): StoredAccount {
  const phone = account.phone
  if (phone !== undefined && phone.includes('*')) {
    const { phone: _dropped, ...rest } = account
    return { ...rest, label: account.label ?? phone }
  }
  return account
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.slot === 'number' &&
    Number.isInteger(value.slot) &&
    value.slot >= 1 &&
    typeof value.session === 'string' &&
    value.session.length >= 16 &&
    !/\s/u.test(value.session) &&
    typeof value.addedAt === 'number' &&
    (value.unavailableAt === undefined || typeof value.unavailableAt === 'number')
  )
}

/**
 * Parse one accounts document. Anything unexpected degrades to "no accounts"
 * rather than throwing: a corrupt file must not stop the plugin from mounting,
 * and an empty list is a legal state (desktop fallback takes over).
 */
export function parseAccounts(text: string): PersistedAccounts {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyAccounts()
  }
  if (!isRecord(parsed)) return emptyAccounts()
  const raw = parsed['accounts']
  if (!Array.isArray(raw)) return emptyAccounts()
  const accounts = raw.filter(isStoredAccount)
  // Slots must be unique; a duplicate would make two accounts fight for one route.
  const seen = new Set<number>()
  const unique: StoredAccount[] = []
  for (const account of accounts) {
    if (seen.has(account.slot)) continue
    seen.add(account.slot)
    unique.push(account)
  }
  unique.sort((left, right) => left.slot - right.slot)
  return { version: ACCOUNTS_VERSION, accounts: unique.map(normalizeStoredAccount) }
}

/** What adding an account produced. */
export type AddAccountResult =
  | { kind: 'ok'; account: StoredAccount; replaced: boolean }
  | { kind: 'failure'; code: string; message: string }

/** The accounts service consumed by the provider, routes and login service. */
export interface AccountsStore {
  /** Re-read the file at most every `ttlMs`. */
  list(options?: { force?: boolean }): Promise<StoredAccount[]>
  /** Every route the plugin should register right now. */
  routes(options?: { force?: boolean }): Promise<AccountRoute[]>
  /** The stored account bound to one route, or `undefined`. */
  accountForRoute(route: string): Promise<StoredAccount | undefined>
  /** Add or refresh one account (de-duplicated by session, then by userId). */
  add(input: { session: string; phone?: string; userId?: string; label?: string }): Promise<AddAccountResult>
  /** Remove one account by id. */
  remove(id: string): Promise<{ kind: 'ok'; removed: boolean } | { kind: 'failure'; code: string; message: string }>
  /** Rename one account. */
  rename(id: string, label: string): Promise<{ kind: 'ok' } | { kind: 'failure'; code: string; message: string }>
  /**
   * The desktop client's own sign-in, when it is a credential the list should
   * show. `undefined` when there is none or it duplicates a stored account.
   */
  desktopAccount?: () => Promise<
    { id: string; session: string; phone?: string; userId?: string } | undefined
  >
  /**
   * Adopt the desktop client's sign-in into the store.
   *
   * One host-side step on purpose: the card used to export-then-import, so a
   * failure in either half surfaced as an unhelpful "transfer failed" with no
   * account added. Reading the same session the list already shows and adding
   * it directly cannot drift from what the user clicked.
   */
  adoptDesktop(): Promise<
    | { kind: 'ok'; account: StoredAccount; replaced: boolean }
    | { kind: 'failure'; code: string; message: string }
  >
  /** Mark one account unusable (pool health), with the reason for the card. */
  markUnavailable(id: string, code: string, message: string): Promise<void>
  /** Clear the health mark after a successful call. */
  markHealthy(id: string): Promise<void>
  /** Drop the in-memory cache so the next read hits disk. */
  invalidate(): void
  /** Produce a portable bundle carrying the sessions (secrets!). */
  exportBundle(options?: { id?: string }): Promise<{ bundle: AccountsBundle; paths: string[] }>
  /** Merge a bundle produced elsewhere; never renumbers existing slots. */
  importBundle(bundle: unknown): Promise<ImportResult>
}

/**
 * The portable form. This file is the credential: whoever holds it can spend
 * the accounts' points until the sessions expire (the upstream mints them with
 * a 14-day `expire`) or are revoked by `logout`.
 */
export interface AccountsBundle {
  kind: 'dsh-connect-loomy/accounts'
  version: 1
  exportedAt: number
  accounts: Array<{
    slot: number
    session: string
    phone?: string
    userId?: string
    label?: string
    addedAt?: number
    /** Where it came from; informational, ignored on import. */
    origin?: 'plugin' | 'desktop'
  }>
}

/** One import's outcome. */
export interface ImportResult {
  kind: 'ok'
  added: number
  refreshed: number
  skipped: number
  /** Slots the bundle asked for that were already taken by another account. */
  reassigned: number
}

/** Route display name for one account. */
export function routeDisplayName(account: Pick<StoredAccount, 'slot' | 'label' | 'phone'>): string {
  const identity = account.label?.trim() || displayPhone(account.phone) || `账号 ${account.slot}`
  // The picker groups models by this name, and the name of a group is the
  // account: 'Loomy · 18912342700' made every row start with the same word and
  // hid the only part that differs. Product context is already given by the
  // surrounding UI.
  return identity
}

/** Create the accounts store. One per plugin instance. */
export function createAccountsStore(options: {
  storageDir: () => string
  /** Desktop fallback: the snapshot the desktop client currently holds. */
  readDesktop?: () => Promise<{ found: boolean; session?: string; phone?: string; userId?: string }>
  ttlMs?: () => number
  now?: () => number
} = { storageDir: () => '.' } as never): AccountsStore {
  const now = options.now ?? (() => Date.now())
  let cached: { accounts: StoredAccount[]; at: number } | undefined
  let pending: Promise<StoredAccount[]> | undefined

  const ttl = (): number => {
    const value = options.ttlMs?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 5_000
  }

  const load = async (force: boolean): Promise<StoredAccount[]> => {
    if (!force && cached !== undefined && now() - cached.at < ttl()) return cached.accounts
    if (pending !== undefined) return pending
    pending = (async () => {
      const path = accountsFilePath(options.storageDir())
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          // Unreadable is not the same as absent, but both mean "no accounts to
          // offer"; the routes fall back to the desktop session and the card's
          // diagnostics surface the real reason through /auth/state.
        }
        cached = { accounts: [], at: now() }
        return []
      }
      const parsed = parseAccounts(text)
      cached = { accounts: parsed.accounts, at: now() }
      return parsed.accounts
    })().finally(() => {
      pending = undefined
    })
    return pending
  }

  const persist = async (accounts: StoredAccount[]): Promise<void> => {
    const path = accountsFilePath(options.storageDir())
    const payload = `${JSON.stringify({ version: ACCOUNTS_VERSION, accounts }, undefined, 2)}\n`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
    await chmod(path, 0o600)
    await chmod(dirname(path), 0o700).catch(() => undefined)
    cached = { accounts, at: now() }
  }

  const nextFreeSlot = (accounts: readonly StoredAccount[]): number => {
    const used = new Set(accounts.map((account) => account.slot))
    let slot = 1
    while (used.has(slot)) slot += 1
    return slot
  }

  const store: AccountsStore = {
    async list(listOptions = {}) {
      return load(listOptions.force === true)
    },

    async routes(routeOptions = {}) {
      const accounts = await load(routeOptions.force === true)
      const desktop = await options.readDesktop?.()
      // One route, always: the account is chosen in the composer drawer, not by
      // picking a different provider. Registering one route per account meant
      // the model picker grew a group per sign-in and account switching looked
      // like model selection.
      if (accounts.length > 0 || desktop?.found === true) {
        return [
          {
            route: BASE_ROUTE,
            slot: 1,
            displayName: PROVIDER_ROUTE_NAME,
            origin: accounts.length > 0 ? ('plugin' as const) : ('desktop' as const),
            ...(accounts.length > 0 ? {} : {}),
          },
        ]
      }
      return []
    },

    async desktopAccount() {
      const desktop = await options.readDesktop?.()
      if (desktop?.found !== true || desktop.session === undefined) return undefined
      return {
        id: accountIdOf(desktop.session),
        session: desktop.session,
        ...(desktop.phone === undefined ? {} : { phone: desktop.phone }),
        ...(desktop.userId === undefined ? {} : { userId: desktop.userId }),
      }
    },

    async adoptDesktop() {
      const desktop = await options.readDesktop?.()
      if (desktop?.found !== true || desktop.session === undefined) {
        return {
          kind: 'failure',
          code: 'no_desktop_session',
          message: '没有找到 Loomy 桌面端的登录态：请先打开 Loomy 客户端登录，然后点「刷新」。',
        }
      }
      return store.add({
        session: desktop.session,
        ...(desktop.phone === undefined ? {} : { phone: desktop.phone }),
        ...(desktop.userId === undefined ? {} : { userId: desktop.userId }),
      })
    },

    async accountForRoute(route) {
      const slot = slotForRoute(route)
      if (slot === undefined) return undefined
      const accounts = await load(false)
      return accounts.find((account) => account.slot === slot)
    },

    async add(input) {
      const id = accountIdOf(input.session)
      try {
        const accounts = await load(true)
        const existing = accounts.find((account) => account.id === id)
        const sameUser =
          input.userId === undefined
            ? undefined
            : accounts.find((account) => account.userId !== undefined && account.userId === input.userId)
        const target = existing ?? sameUser
        if (target !== undefined) {
          // Same person signing in again: refresh the session in place so the
          // slot (and every selection bound to its route) stays stable.
          const updated: StoredAccount = {
            ...target,
            id,
            session: input.session,
            ...(input.phone === undefined ? {} : { phone: input.phone }),
            ...(input.userId === undefined ? {} : { userId: input.userId }),
            ...(input.label === undefined ? {} : { label: input.label }),
          }
          const next = accounts.map((account) => (account.slot === target.slot ? updated : account))
          await persist(next)
          return { kind: 'ok', account: updated, replaced: true }
        }
        const account: StoredAccount = {
          id,
          slot: nextFreeSlot(accounts),
          session: input.session,
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          ...(input.userId === undefined ? {} : { userId: input.userId }),
          ...(input.label === undefined ? {} : { label: input.label }),
          addedAt: now(),
        }
        await persist([...accounts, account].sort((left, right) => left.slot - right.slot))
        return { kind: 'ok', account, replaced: false }
      } catch (error) {
        return {
          kind: 'failure',
          code: 'write_failed',
          message: `账号保存失败：${safeErrorMessage(error)}`,
        }
      }
    },

    async remove(id) {
      try {
        const accounts = await load(true)
        const next = accounts.filter((account) => account.id !== id)
        if (next.length === accounts.length) return { kind: 'ok', removed: false }
        await persist(next)
        return { kind: 'ok', removed: true }
      } catch (error) {
        return { kind: 'failure', code: 'write_failed', message: `账号删除失败：${safeErrorMessage(error)}` }
      }
    },

    async rename(id, label) {
      try {
        const accounts = await load(true)
        const next = accounts.map((account) => (account.id === id ? { ...account, label } : account))
        await persist(next)
        return { kind: 'ok' }
      } catch (error) {
        return { kind: 'failure', code: 'write_failed', message: `账号重命名失败：${safeErrorMessage(error)}` }
      }
    },

    async exportBundle(exportOptions = {}) {
      // Export **every credential this host can see**, not just what the store
      // happens to hold: the desktop client's session is a real sign-in the
      // user may want on another machine, and it is invisible to the store by
      // design (the plugin never writes that file). Previously any stored
      // account silently excluded it, so "export" did not mean "export what I
      // am signed in as".
      const all = await load(true)
      // One account at a time is the per-row export: it must not hand the user
      // every credential when they asked for one.
      const stored =
        exportOptions.id === undefined ? all : all.filter((account) => account.id === exportOptions.id)
      const desktop = exportOptions.id === undefined ? await options.readDesktop?.() : undefined
      const sessions = new Set(all.map((account) => account.session))

      const accounts: Array<{
        slot: number
        session: string
        phone?: string
        userId?: string
        label?: string
        addedAt?: number
        origin?: 'plugin' | 'desktop'
      }> = stored.map((account) => ({
        slot: account.slot,
        session: account.session,
        ...(account.phone === undefined ? {} : { phone: account.phone }),
        ...(account.userId === undefined ? {} : { userId: account.userId }),
        ...(account.label === undefined ? {} : { label: account.label }),
        addedAt: account.addedAt,
        origin: 'plugin' as const,
      }))

      // Append the desktop sign-in when it is a credential we do not already
      // hold. Its slot is one past the highest stored slot so the bundle never
      // collides with an existing row on import.
      if (desktop?.found === true && desktop.session !== undefined && !sessions.has(desktop.session)) {
        const nextSlot = stored.reduce((highest, account) => Math.max(highest, account.slot), 0) + 1
        accounts.push({ slot: nextSlot, session: desktop.session, origin: 'desktop' as const })
      }

      return {
        bundle: {
          kind: 'dsh-connect-loomy/accounts',
          version: 1,
          exportedAt: now(),
          accounts,
        },
        paths:
          stored.length > 0
            ? [accountsFilePath(options.storageDir()), ...(desktop?.found === true ? ['desktop client session'] : [])]
            : [accountsFilePath(options.storageDir())],
      }
    },

    async importBundle(bundle) {
      const parsed = parseBundle(bundle)
      if (parsed === undefined) {
        throw new Error(
          '导入内容无法识别：需要本插件导出的账号包、或 Loomy 桌面端的 auth-session.json，' +
            '或含 session 字段的数组。',
        )
      }
      let added = 0
      let refreshed = 0
      let skipped = 0
      let reassigned = 0
      for (const entry of parsed) {
        const result = await store.add({
          session: entry.session,
          ...(entry.phone === undefined ? {} : { phone: entry.phone }),
          ...(entry.userId === undefined ? {} : { userId: entry.userId }),
          ...(entry.label === undefined ? {} : { label: entry.label }),
        })
        if (result.kind === 'failure') {
          skipped += 1
          continue
        }
        if (result.replaced) refreshed += 1
        else added += 1
        // `add` allocates the smallest free slot, so a clash with an existing
        // account is resolved by relocation rather than by overwriting it.
        if (!result.replaced && result.account.slot !== entry.slot) reassigned += 1
      }
      cached = undefined
      return { kind: 'ok', added, refreshed, skipped, reassigned }
    },

    async markUnavailable(id, code, message) {
      try {
        const accounts = await load(true)
        const next = accounts.map((account) =>
          account.id === id
            ? { ...account, unavailableAt: now(), unavailableCode: code, unavailableMessage: message }
            : account,
        )
        await persist(next)
      } catch {
        // Health marking is advisory: a failed write must never fail a request.
      }
    },

    async markHealthy(id) {
      try {
        const accounts = await load(true)
        const changed = accounts.some(
          (account) => account.id === id && account.unavailableAt !== undefined,
        )
        if (!changed) return
        const next = accounts.map((account) => {
          if (account.id !== id) return account
          const { unavailableAt, unavailableCode, unavailableMessage, ...rest } = account
          return rest
        })
        await persist(next)
      } catch {
        // Same as above: advisory only.
      }
    },

    invalidate() {
      cached = undefined
    },
  }

  return store
}

/**
 * Validate an imported bundle.
 *
 * Only the shape this plugin writes is accepted: a foreign JSON file must not
 * be able to smuggle an arbitrary `session` into the credential store without
 * the user seeing what they imported.
 */
export function parseBundle(
  value: unknown,
): Array<{ slot: number; session: string; phone?: string; userId?: string; label?: string }> | undefined {
  /** One entry: our bundle's camelCase plus the desktop file's lowercase keys. */
  const one = (item: unknown, defaultSlot: number): {
    slot: number
    session: string
    phone?: string
    userId?: string
    label?: string
  } | undefined => {
    if (!isRecord(item)) return undefined
    const rawSession = item['session']
    if (typeof rawSession !== 'string') return undefined
    // The desktop client's file and our bundle both carry a 32-char opaque
    // session; anything with whitespace or absurdly short is not one.
    if (rawSession.length < 16 || /\s/u.test(rawSession)) return undefined
    const rawSlot = item['slot']
    const slot =
      typeof rawSlot === 'number' && Number.isInteger(rawSlot) && rawSlot >= 1 ? rawSlot : defaultSlot
    // `userid` is the desktop spelling, `userId` ours; `phone` is shared.
    const rawPhone = typeof item['phone'] === 'string' && item['phone'].length > 0 ? item['phone'] : undefined
    // A masked phone (`189****2700`) is display copy, never an identifier: it
    // must not be stored where a real number belongs, or a later login cannot
    // recognise the same person. It is preserved as a label instead.
    const masked = rawPhone !== undefined && rawPhone.includes('*')
    const phone = rawPhone === undefined || masked ? undefined : rawPhone
    const rawUser = item['userId'] ?? item['userid']
    const userId = typeof rawUser === 'string' && rawUser.length > 0 ? rawUser : undefined
    const explicitLabel = typeof item['label'] === 'string' && item['label'].length > 0 ? item['label'] : undefined
    const label = explicitLabel ?? (masked ? rawPhone : undefined)
    return {
      slot,
      session: rawSession,
      ...(phone === undefined ? {} : { phone }),
      ...(userId === undefined ? {} : { userId }),
      ...(label === undefined ? {} : { label }),
    }
  }

  // 1) Our own export bundle.
  if (isRecord(value) && value['kind'] === 'dsh-connect-loomy/accounts') {
    if (value['version'] !== 1) return undefined
    const raw = value['accounts']
    if (!Array.isArray(raw)) return undefined
    const entries = raw
      .map((item, index) => one(item, index + 1))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    return entries.length > 0 ? entries : undefined
  }

  // 2) A bare array of session documents.
  if (Array.isArray(value)) {
    const entries = value
      .map((item, index) => one(item, index + 1))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    return entries.length > 0 ? entries : undefined
  }

  // 3) The Loomy desktop client's own `auth-session.json`
  //    (`{session, userid, phone, updatedAt}`) — this is the file a user
  //    naturally copies between machines, so importing it must just work
  //    instead of demanding our wrapper around the same three fields.
  if (isRecord(value)) {
    const single = one(value, 1)
    if (single !== undefined) return [single]
    // 4) Tolerate a `{accounts: [...]}` wrapper without the `kind` marker.
    const raw = value['accounts']
    if (Array.isArray(raw)) {
      const entries = raw
        .map((item, index) => one(item, index + 1))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      return entries.length > 0 ? entries : undefined
    }
  }
  return undefined
}

/** Public, session-free view of one account for the settings card. */
export interface StoredAccountView {
  id: string
  slot: number
  route: string
  displayName: string
  origin: 'plugin' | 'desktop'
  label?: string
  phone?: string
  userId?: string
  addedAt?: number
  /** Pool health: true when the pool is currently skipping this account. */
  unavailable?: boolean
  unavailableAt?: number
  unavailableCode?: string
  unavailableMessage?: string
}

/**
 * Build the card's account list (no sessions).
 *
 * One list, mixed sources: the accounts the plugin stores, **and** the desktop
 * client's own sign-in when it is a credential we do not already hold. Showing
 * them separately made the common case look like two different things ("your
 * account" and "some desktop file"), and hid the desktop sign-in entirely once
 * an account was imported — the user could no longer see it at all.
 */
export async function accountsView(
  store: AccountsStore,
  options: { force?: boolean } = {},
): Promise<StoredAccountView[]> {
  const accounts = await store.list(options)
  const rows: StoredAccountView[] = accounts.map((account) => ({
    id: account.id,
    slot: account.slot,
    route: routeForSlot(account.slot),
    displayName: routeDisplayName(account),
    origin: 'plugin' as const,
    ...(account.label === undefined ? {} : { label: account.label }),
    ...(displayPhone(account.phone) === undefined ? {} : { phone: displayPhone(account.phone) }),
    ...(displayUserId(account.userId) === undefined ? {} : { userId: displayUserId(account.userId) }),
    addedAt: account.addedAt,
    ...(account.unavailableAt === undefined
      ? {}
      : {
          unavailable: true,
          unavailableAt: account.unavailableAt,
          ...(account.unavailableCode === undefined ? {} : { unavailableCode: account.unavailableCode }),
          ...(account.unavailableMessage === undefined
            ? {}
            : { unavailableMessage: account.unavailableMessage }),
        }),
  }))

  const desktop = await store.desktopAccount?.()
  if (desktop !== undefined && !accounts.some((account) => account.session === desktop.session)) {
    rows.push({
      // Not a stored row: no id the store can act on, so removal is impossible
      // by design (the plugin does not own that file).
      id: `desktop-${desktop.id}`,
      slot: 0,
      // It has no route of its own while stored accounts exist; `route` is left
      // out so the UI can render it as "not separately routed" instead of
      // inventing a slot number that would collide.
      route: accounts.length === 0 ? BASE_ROUTE : '',
      displayName: displayPhone(desktop.phone) ?? 'Loomy（桌面端）',
      origin: 'desktop' as const,
      ...(displayPhone(desktop.phone) === undefined ? {} : { phone: displayPhone(desktop.phone) }),
      ...(displayPhone(desktop.userId) === undefined ? {} : { userId: displayPhone(desktop.userId) }),
    })
  }
  return rows
}



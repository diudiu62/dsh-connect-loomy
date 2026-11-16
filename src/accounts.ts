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
import { isRecord, maskPhone, maskUserId, safeErrorMessage } from './shared/text.js'

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
  maskedPhone?: string
}

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
    typeof value.addedAt === 'number'
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
  return { version: ACCOUNTS_VERSION, accounts: unique }
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
  /** Drop the in-memory cache so the next read hits disk. */
  invalidate(): void
  /** Produce a portable bundle carrying the sessions (secrets!). */
  exportBundle(): Promise<{ bundle: AccountsBundle; paths: string[] }>
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
  const identity = account.label?.trim() || maskPhone(account.phone) || `账号 ${account.slot}`
  // Slot 1 keeps the bare product name so the single-account case looks exactly
  // as it did before multi-account; later slots are disambiguated by identity.
  return account.slot === 1 ? `Loomy · ${identity}` : `Loomy ${account.slot} · ${identity}`
}

/** Create the accounts store. One per plugin instance. */
export function createAccountsStore(options: {
  storageDir: () => string
  /** Desktop fallback: the snapshot the desktop client currently holds. */
  readDesktop?: () => Promise<{ found: boolean; session?: string; maskedPhone?: string; maskedUserId?: string }>
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
      if (accounts.length > 0) {
        return accounts.map((account) => ({
          route: routeForSlot(account.slot),
          slot: account.slot,
          displayName: routeDisplayName(account),
          origin: 'plugin' as const,
          accountId: account.id,
          ...(maskPhone(account.phone) === undefined ? {} : { maskedPhone: maskPhone(account.phone) }),
        }))
      }
      // No plugin account: fall back to the desktop client's sign-in on slot 1,
      // which is byte-for-byte the single-account behaviour that shipped first.
      const desktop = await options.readDesktop?.()
      if (desktop?.found === true && desktop.session !== undefined) {
        return [
          {
            route: BASE_ROUTE,
            slot: 1,
            displayName: 'Loomy',
            origin: 'desktop' as const,
            ...(desktop.maskedPhone === undefined ? {} : { maskedPhone: desktop.maskedPhone }),
          },
        ]
      }
      return []
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

    async exportBundle() {
      // Export what the plugin can actually route to, not just what it stores.
      //
      // The desktop client's session is a legitimate credential the user may
      // want to carry to another machine — and it is often the *only* one they
      // have (they signed in through Loomy.app, never through the card). Not
      // exporting it produced "no accounts to export" for a user who was
      // visibly signed in, which is the bug this mirrors `routes()` to avoid.
      const stored = await load(true)
      const accounts =
        stored.length > 0
          ? stored.map((account) => ({
              slot: account.slot,
              session: account.session,
              ...(account.phone === undefined ? {} : { phone: account.phone }),
              ...(account.userId === undefined ? {} : { userId: account.userId }),
              ...(account.label === undefined ? {} : { label: account.label }),
              addedAt: account.addedAt,
            }))
          : await (async () => {
              const desktop = await options.readDesktop?.()
              if (desktop?.found !== true || desktop.session === undefined) return []
              return [{ slot: 1, session: desktop.session }]
            })()
      return {
        bundle: {
          kind: 'dsh-connect-loomy/accounts',
          version: 1,
          exportedAt: now(),
          accounts,
        },
        paths:
          stored.length > 0
            ? [accountsFilePath(options.storageDir())]
            : [options.storageDir() + ' (desktop client session)'],
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
  maskedPhone?: string
  maskedUserId?: string
  addedAt?: number
}

/** Build the card's account list (no sessions). */
export async function accountsView(
  store: AccountsStore,
  options: { force?: boolean } = {},
): Promise<StoredAccountView[]> {
  const accounts = await store.list(options)
  if (accounts.length > 0) {
    return accounts.map((account) => ({
      id: account.id,
      slot: account.slot,
      route: routeForSlot(account.slot),
      displayName: routeDisplayName(account),
      origin: 'plugin' as const,
      ...(account.label === undefined ? {} : { label: account.label }),
      ...(maskPhone(account.phone) === undefined ? {} : { maskedPhone: maskPhone(account.phone) }),
      ...(maskUserId(account.userId) === undefined ? {} : { maskedUserId: maskUserId(account.userId) }),
      addedAt: account.addedAt,
    }))
  }
  const routes = await store.routes(options)
  return routes.map((route) => ({
    id: `desktop-${route.slot}`,
    slot: route.slot,
    route: route.route,
    displayName: route.displayName,
    origin: 'desktop' as const,
    ...(route.maskedPhone === undefined ? {} : { maskedPhone: route.maskedPhone }),
  }))
}

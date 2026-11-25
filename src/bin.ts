/**
 * Boot-free CLI: `dsh-connect-desktop status|doctor [--vendor <id>] [--json]`.
 *
 * The CLI is **vendor-generic**: it builds each vendor module with the same dep
 * builder the registry uses, so a new vendor is supported by this command
 * without touching it. Only the vendors' own modules know about upstreams.
 *
 * It runs in its own process and therefore cannot see the plugin's settings
 * section (the loader owns that), so configuration comes from the descriptor's
 * defaults plus environment overrides:
 *
 * - `DSH_CONNECT_BASE_URL` applies to every vendor;
 * - `LOOMY_BASE_URL` / `RACCOON_BASE_URL` override one vendor;
 * - `LOOMY_AUTH_SESSION_FILE` pins Loomy's credential file (exclusive).
 *
 * Both commands report a signed-out machine as data, not as a crash: the
 * credential candidates and their executable reasons are the whole point of
 * `doctor`. Only an internal failure produces exit code 1.
 *
 * @module dsh-connect-desktop/bin
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createVendorDeps } from './core/deps.js'
import { createAccountPool } from './core/pool.js'
import { createVendorSurface } from './core/surface.js'
import type { VendorModule } from './vendor-sdk/contracts.js'
import type { VendorDiagnosticsView, VendorStatusView } from './shared/views.js'
import { COMMUNITY, communityChannels, ISSUES_URL } from './shared/community.js'
import { formatDateTime, safeErrorMessage } from './shared/text.js'
import { createLoomyModule } from './vendors/loomy/index.js'
import { createRaccoonModule } from './vendors/raccoon/index.js'

/** Environment variable that overrides every vendor's gateway. */
export const BASE_URL_ENV = 'DSH_CONNECT_BASE_URL'

/** Vendors the CLI knows about. Order is the picker's order. */
function modules(): VendorModule[] {
  return [createLoomyModule(), createRaccoonModule()]
}

/** Per-vendor environment override, then the global one. */
function baseUrlOverride(vendorId: string): string | undefined {
  const specific = process.env[`${vendorId.toUpperCase()}_BASE_URL`]
  if (typeof specific === 'string' && specific.trim().length > 0) return specific.trim()
  const global = process.env[BASE_URL_ENV]
  return typeof global === 'string' && global.trim().length > 0 ? global.trim() : undefined
}

const CLI_LOGGER = {
  info: (message: string): void => {
    process.stderr.write(`${message}\n`)
  },
  warn: (message: string): void => {
    process.stderr.write(`${message}\n`)
  },
  error: (message: string): void => {
    process.stderr.write(`${message}\n`)
  },
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: dsh-connect-desktop <status|doctor> [--vendor <id>] [--json]',
      '',
      '  status   per-vendor sign-in state, catalog counters, saved selection and read-only credits',
      '  doctor   credential candidate paths + live upstream probes (verbatim error text)',
      '  --vendor only report one vendor id (loomy, raccoon)',
      '  --json   emit one credential-free JSON document',
      '',
      'Environment:',
      `  ${BASE_URL_ENV}          override every vendor gateway`,
      '  LOOMY_BASE_URL          override the Loomy gateway only',
      '  RACCOON_BASE_URL        override the Raccoon gateway only',
      '  LOOMY_AUTH_SESSION_FILE use exactly this Loomy sign-in file (no desktop fallback)',
      '  DSH_HOME                harness home used for the state documents (default ~/.dsh)',
      '',
      'Community:',
      `  issues                  ${ISSUES_URL}`,
      ...communityChannels()
        .filter((channel) => channel !== 'issues')
        .map((channel) => `  ${channel.padEnd(24)} ${COMMUNITY[channel]}`),
      '',
    ].join('\n'),
  )
}

interface StatusEntry {
  status: VendorStatusView
  credits?:
    | {
        ok: true
        fields: Record<string, number>
        fetchedAt: number
        /**
         * 余额桶缺失时的原因标签（`balance_unavailable`）。
         *
         * 不带它的话，CLI 会输出一个 `fields: {}` 而不说为什么——和界面上
         * "积分不见了"是同一种误导。`--json` 的消费者（排障时的人、脚本）
         * 需要与界面同样的那句解释。
         */
        partial?: string
        partialReason?: string
      }
    | { ok: false; error: { code: string; message: string } }
}

interface DoctorEntry {
  view: Omit<VendorDiagnosticsView, 'ok'>
  probes: Array<{ path: string; ok: boolean; reason: string }>
}

/** Build one vendor's surface for a boot-free run. */
async function surfaceOf(module: VendorModule, vendorId: string) {
  const override = baseUrlOverride(vendorId)
  const baseConfig = { ...module.descriptor.config.defaults, ...(override === undefined ? {} : { baseURL: override }) }
  const deps = createVendorDeps({
    descriptor: module.descriptor,
    config: () => baseConfig,
    logger: CLI_LOGGER,
  })
  const runtime = await module.create(deps)
  const pool = runtime.accounts === undefined ? undefined : createAccountPool({ accounts: runtime.accounts })
  return createVendorSurface({ descriptor: module.descriptor, runtime, ...(pool === undefined ? {} : { pool }) })
}

async function statusEntries(only: string | undefined): Promise<StatusEntry[]> {
  const entries: StatusEntry[] = []
  for (const module of modules()) {
    if (only !== undefined && module.descriptor.id !== only) continue
    const surface = await surfaceOf(module, module.descriptor.id)
    const status = await surface.status({ allowNetwork: true })
    let credits: StatusEntry['credits']
    if (status.capabilities.credits.kind !== 'none') {
      const readout = await surface.credits({ force: false })
      credits =
        readout.kind === 'ok'
          ? {
              ok: true,
              fields: readout.credits.fields,
              fetchedAt: readout.credits.fetchedAt,
              ...(readout.credits.partial === undefined ? {} : { partial: readout.credits.partial }),
              ...(readout.credits.partialReason === undefined
                ? {}
                : { partialReason: readout.credits.partialReason }),
            }
          : { ok: false, error: { code: readout.failure.code, message: readout.failure.message } }
    }
    entries.push({ status, ...(credits === undefined ? {} : { credits }) })
  }
  return entries
}

async function doctorEntries(only: string | undefined): Promise<DoctorEntry[]> {
  const entries: DoctorEntry[] = []
  for (const module of modules()) {
    if (only !== undefined && module.descriptor.id !== only) continue
    const surface = await surfaceOf(module, module.descriptor.id)
    // 先做一次真实读取：`doctor` 的价值一半在"上游到底说了什么"，而那只有
    // 真正打过一次上游之后才有。签出时它不会产生任何请求（目录读在本地失败）。
    await surface.status({ allowNetwork: true }).catch(() => undefined)
    const entry = await surface.diagnostics()
    // 再补一层活体探针：逐端点回传上游原文（签出时每行都是同一句可执行原因）。
    const live = await surface.runtime.probeEndpoints?.().catch(() => undefined)
    entries.push(live === undefined ? entry : { ...entry, probes: [...entry.probes, ...live] })
  }
  return entries
}

function printStatusHuman(entries: readonly StatusEntry[]): void {
  const lines: string[] = ['DSH Connect Desktop status', '==========================']
  for (const { status, credits } of entries) {
    lines.push('', `[${status.id}] ${status.displayName} — ${status.available ? 'signed in' : 'unavailable'}`)
    if (!status.available) lines.push(`  why: ${status.unavailableReason ?? 'unknown'}`)
    lines.push(
      `  credential: ${status.credential.found ? 'found' : 'missing'} — ${status.credential.sourcePath}` +
        (status.credential.problem === undefined ? '' : ` (${status.credential.problem})`),
    )
    if (status.account !== null) {
      lines.push(
        `  account: ${status.account.label ?? status.account.phone ?? status.account.userId ?? 'unknown'}` +
          (status.account.route === undefined ? '' : ` as ${status.account.route}`),
      )
    }
    lines.push(`  models: ${status.catalog.enabled}/${status.catalog.total} enabled`)
    if (status.provider !== undefined) {
      lines.push(
        status.provider.registered
          ? `  provider: registered (${status.provider.routes.join(', ')})`
          : `  provider: NOT registered — ${status.provider.error ?? 'unknown'}`,
      )
    }
    if (credits !== undefined) {
      if (credits.ok) {
        const buckets = Object.entries(credits.fields)
          .map(([key, value]) => `${key} ${value}`)
          .join(' · ')
        lines.push(`  credits: ${buckets}`, `  fetched: ${formatDateTime(credits.fetchedAt)}`)
      } else {
        lines.push(`  credits: unavailable — ${credits.error.code} ${credits.error.message}`)
      }
    }
    if (status.lastError !== undefined) {
      lines.push(
        `  last error: ${status.lastError.code} ${status.lastError.message} (${status.lastError.path}, ${formatDateTime(status.lastError.at)})`,
      )
    }
    for (const step of status.nextSteps ?? []) lines.push(`  next: ${step}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printDoctorHuman(entries: readonly DoctorEntry[]): void {
  const lines: string[] = ['DSH Connect Desktop doctor', '==========================']
  for (const { view, probes } of entries) {
    lines.push('', `[${view.id}] ${view.displayName}`, `  base: ${view.baseUrl}`)
    lines.push(
      `  account: ${
        view.account === null
          ? 'signed out'
          : (view.account.label ?? view.account.phone ?? view.account.userId ?? 'unknown')
      }`,
    )
    lines.push(`  inspected: ${view.inspected.length === 0 ? '—' : view.inspected.join(', ')}`)
    lines.push('  credential candidates:')
    for (const candidate of view.credential.candidates) {
      lines.push(`    [${candidate.state}] ${candidate.path}${candidate.reason === '' ? '' : ` — ${candidate.reason}`}`)
    }
    lines.push('  probes:')
    for (const probe of probes) {
      lines.push(`    ${probe.ok ? 'ok  ' : 'FAIL'} ${probe.path}: ${probe.reason}`)
    }
    lines.push(`  models: ${view.catalog.enabled}/${view.catalog.total} enabled`)
    if (view.accounts !== null) lines.push(`  accounts: ${view.accounts.total} (${view.accounts.healthy} healthy)`)
    if (view.lastError !== undefined) lines.push(`  last error: ${view.lastError.code} ${view.lastError.message}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** Execute one command; returns the process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [action, ...flags] = argv
  if (action !== 'status' && action !== 'doctor') {
    process.stderr.write(`dsh-connect-desktop: expected status or doctor; got ${JSON.stringify(action)}\n`)
    return 1
  }
  const json = flags.includes('--json')
  let only: string | undefined
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === '--json') continue
    if (flag === '--vendor') {
      only = flags[index + 1]
      index += 1
      if (only === undefined) {
        process.stderr.write('dsh-connect-desktop: --vendor needs an id\n')
        return 1
      }
      continue
    }
    process.stderr.write(`dsh-connect-desktop: invalid option ${flag}\n`)
    return 1
  }
  try {
    if (action === 'status') {
      const entries = await statusEntries(only)
      if (json) process.stdout.write(`${JSON.stringify({ ok: true, fetchedAt: Date.now(), vendors: entries.map((entry) => ({ ...entry.status, ...(entry.credits === undefined ? {} : { credits: entry.credits }) })) })}\n`)
      else printStatusHuman(entries)
      return 0
    }
    const entries = await doctorEntries(only)
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, fetchedAt: Date.now(), vendors: entries.map((entry) => ({ ...entry.view, probes: entry.probes })) })}\n`)
    else printDoctorHuman(entries)
    return 0
  } catch (error) {
    const failure = { ok: false, error: { code: 'internal', message: safeErrorMessage(error) } }
    if (json) process.stdout.write(`${JSON.stringify(failure)}\n`)
    else process.stderr.write(`dsh-connect-desktop: ${action} failed: ${safeErrorMessage(error)}\n`)
    return 1
  }
}

// Only run when executed as a program (`node lib/bin.js`, or the npm bin shim).
// Importing the module from a test must stay side-effect free.
if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}

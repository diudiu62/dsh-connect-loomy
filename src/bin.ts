/**
 * Boot-free CLI: `dsh-connect-loomy status|doctor [--json]`.
 *
 * The CLI runs in its own process and therefore cannot see the plugin's
 * settings section (the loader owns that). `LOOMY_BASE_URL` overrides the
 * gateway; `LOOMY_AUTH_SESSION_FILE`, when set, **replaces** the credential
 * candidate list (the desktop paths are not inspected at all, so an isolated
 * run can never pick up the real desktop session). It never writes the plugin's
 * state file: `status` reads the saved selection for its model count but its
 * catalog/credit reads are live.
 *
 * Both commands report a signed-out machine as data, not as a crash: the
 * credential candidates and their executable reasons are the whole point of
 * `doctor`. Only an internal failure produces exit code 1.
 *
 * @module dsh-connect-loomy/bin
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { accountViewOf, credentialViewOf, readAuthSession } from './auth.js'
import { normalizeCatalog } from './catalog.js'
import { fetchCredits, fetchIdentity } from './credits.js'
import { authSessionCandidates, resolveDshHome, stateFilePath } from './shared/paths.js'
import { COMMUNITY, communityChannels, ISSUES_URL } from './shared/community.js'
import { createAuthDiscovery } from './shared/discover.js'
import { createStateStore } from './shared/state.js'
import { resolveEnabledIds } from './catalog.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CREDITS_PAGE_SIZE,
  type AccountView,
  type CatalogModel,
  type CredentialCandidateView,
  type CreditsView,
  type FailureView,
  type UpstreamErrorView,
} from './shared/types.js'
import { formatDateTime, safeErrorMessage } from './shared/text.js'
import { catalogUrls } from './catalog.js'
import { modelsUrl, requestPlatform } from './shared/upstream.js'

/** Environment variable that overrides the gateway for CLI runs. */
export const LOOMY_BASE_URL_ENV = 'LOOMY_BASE_URL'

function baseURL(): string {
  const override = process.env[LOOMY_BASE_URL_ENV]
  return typeof override === 'string' && override.trim().length > 0 ? override.trim() : DEFAULT_BASE_URL
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: dsh-connect-loomy <status|doctor> [--json]',
      '',
      '  status   sign-in state, catalog counters, saved selection and read-only credits',
      '  doctor   credential candidate paths + live upstream probes (verbatim error text)',
      '  --json   emit one credential-free JSON document',
      '',
      'Environment:',
      `  LOOMY_BASE_URL             override the gateway (default ${DEFAULT_BASE_URL})`,
      '  LOOMY_AUTH_SESSION_FILE    use exactly this sign-in file (no desktop fallback)',
      '  DSH_HOME                   harness home used for the catalog cache (default ~/.dsh)',
      '',
      'Community:',
      `  issues                     ${ISSUES_URL}`,
      ...communityChannels()
        .filter((channel) => channel !== 'issues')
        .map((channel) => `  ${channel.padEnd(26)} ${COMMUNITY[channel]}`),
      '',
    ].join('\n'),
  )
}

interface CatalogReadout {
  models: CatalogModel[]
  failure?: UpstreamErrorView
}

async function fetchCatalog(session: string | undefined, sourcePath: string): Promise<CatalogReadout> {
  const at = Date.now()
  if (session === undefined) {
    return {
      models: [],
      failure: {
        at,
        path: '/models',
        code: 'not_signed_in',
        message: `未找到可用的 Loomy 登录态（${sourcePath}）`,
      },
    }
  }
  const answer = await requestPlatform({
    baseURL: baseURL(),
    path: '/models',
    session,
    timeoutMs: 20_000,
  })
  if (answer.kind === 'failure') {
    return {
      models: [],
      failure: { at, path: '/models', code: answer.code, message: answer.message, ...(answer.traceId === undefined ? {} : { traceId: answer.traceId }) },
    }
  }
  const models = normalizeCatalog(answer.body)
  if (models.length === 0) {
    return { models: [], failure: { at, path: '/models', code: 'bad_response', message: '上游 /models 没有返回可识别的聊天模型' } }
  }
  return { models }
}

interface CandidateReport {
  path: string
  exists: boolean
  state: string
  reason: string
}

interface StatusDocument {
  ok: true
  fetchedAt: number
  account: AccountView | null
  credential: { sourcePath: string; found: boolean; reason?: string }
  upstream: { baseUrl: string; modelsUrl: string; pointsUrl: string }
  catalog: { total: number; enabled: number }
  enabledModelIds: string[]
  credits: ({ ok: true; balance: number; dailyBalance: number; availableBalance: number; fetchedAt: number; records: CreditsView['records'] } | FailureView) | undefined
  lastError?: UpstreamErrorView
}

interface DoctorDocument {
  ok: true
  fetchedAt: number
  account: AccountView | null
  credential: { sourcePath: string; found: boolean }
  candidates: CandidateReport[]
  upstream: { baseUrl: string; modelsUrl: string; pointsUrl: string }
  probes: Array<{ path: string; ok: boolean; reason: string }>
  catalog: { total: number; enabled: number }
  lastError?: UpstreamErrorView
}

/**
 * Credential read for the CLI.
 *
 * `LOOMY_AUTH_SESSION_FILE` is an **exclusive** replacement by contract, so a
 * pinned run never scans: the whole point of pinning is that this process can
 * not pick up a real desktop credential. Everything else gets the same bounded
 * fallback search the host uses, which is what makes `doctor` useful on a
 * Windows install whose `userData` directory is named differently.
 */
function readAuthForCli(): ReturnType<typeof readAuthSession> {
  const candidates = authSessionCandidates()
  const pinned = candidates.length === 1 && candidates[0]?.origin === 'env'
  return readAuthSession(candidates, pinned ? {} : { discover: createAuthDiscovery() })
}

function credentialCandidates(snapshot: Awaited<ReturnType<typeof readAuthSession>>): CandidateReport[] {
  return snapshot.candidates.map((candidate: CredentialCandidateView) => ({
    path: candidate.path,
    exists: candidate.exists,
    state: candidate.state,
    reason: candidate.reason,
  }))
}

async function readSavedSelection(): Promise<string[] | null> {
  const store = createStateStore(stateFilePath(resolveDshHome()))
  const state = await store.load()
  return state.selection
}

async function statusDocument(): Promise<StatusDocument> {
  const snapshot = await readAuthForCli()
  const catalog = await fetchCatalog(snapshot.session, snapshot.sourcePath)
  const selection = await readSavedSelection()
  const enabledModelIds = resolveEnabledIds(catalog.models, selection)
  const creditsResult = await fetchCredits({
    baseURL: baseURL(),
    session: { session: snapshot.session, sourcePath: snapshot.sourcePath, ...(snapshot.problem === undefined ? {} : { problem: snapshot.problem }) },
    pageSize: DEFAULT_CREDITS_PAGE_SIZE,
  })
  const credits = creditsResult.kind === 'ok'
    ? { ok: true as const, balance: creditsResult.credits.balance, dailyBalance: creditsResult.credits.dailyBalance, availableBalance: creditsResult.credits.availableBalance, fetchedAt: creditsResult.credits.fetchedAt, records: creditsResult.credits.records }
    : { ok: false as const, error: { code: creditsResult.failure.code, message: creditsResult.failure.message } }
  return {
    ok: true,
    fetchedAt: Date.now(),
    account: accountViewOf(snapshot),
    credential: {
      ...credentialViewOf(snapshot),
      ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
    },
    upstream: catalogUrls(baseURL()),
    catalog: { total: catalog.models.length, enabled: enabledModelIds.length },
    enabledModelIds,
    credits,
    ...(catalog.failure === undefined ? {} : { lastError: catalog.failure }),
  }
}

async function doctorDocument(): Promise<DoctorDocument> {
  const snapshot = await readAuthForCli()
  const urls = catalogUrls(baseURL())
  const probes: DoctorDocument['probes'] = []
  let lastError: UpstreamErrorView | undefined
  let models: CatalogModel[] = []

  if (snapshot.session === undefined) {
    const reason = snapshot.problem ?? `未找到 Loomy 登录态（${snapshot.sourcePath}）`
    probes.push(
      { path: '/models', ok: false, reason },
      { path: '/points/records', ok: false, reason },
      { path: '/user/identity', ok: false, reason },
    )
  } else {
    const [catalog, points, identity] = await Promise.all([
      fetchCatalog(snapshot.session, snapshot.sourcePath),
      fetchCredits({
        baseURL: baseURL(),
        session: { session: snapshot.session, sourcePath: snapshot.sourcePath },
        pageSize: DEFAULT_CREDITS_PAGE_SIZE,
      }),
      fetchIdentity({
        baseURL: baseURL(),
        session: { session: snapshot.session, sourcePath: snapshot.sourcePath },
      }),
    ])
    models = catalog.models
    if (catalog.failure !== undefined) lastError = catalog.failure
    probes.push(
      catalog.failure === undefined
        ? { path: '/models', ok: true, reason: `ok（${models.length} 个聊天模型）` }
        : { path: '/models', ok: false, reason: catalog.failure.message },
      points.kind === 'ok'
        ? { path: '/points/records', ok: true, reason: `ok（可用 ${points.credits.availableBalance}）` }
        : { path: '/points/records', ok: false, reason: points.failure.message },
      identity.kind === 'ok'
        ? { path: '/user/identity', ok: true, reason: 'ok（登录态有效）' }
        : { path: '/user/identity', ok: false, reason: identity.failure.message },
    )
  }

  const selection = await readSavedSelection()
  const enabledModelIds = resolveEnabledIds(models, selection)
  return {
    ok: true,
    fetchedAt: Date.now(),
    account: accountViewOf(snapshot),
    credential: credentialViewOf(snapshot),
    candidates: credentialCandidates(snapshot),
    upstream: urls,
    probes,
    catalog: { total: models.length, enabled: enabledModelIds.length },
    ...(lastError === undefined ? {} : { lastError }),
  }
}

function printStatusHuman(document: StatusDocument): void {
  const lines: string[] = ['Loomy Connect status', '===================']
  lines.push(
    `Account: ${document.account === null ? 'signed out' : `${document.account.phone} (since ${formatDateTime(document.account.loginAt)})`}`,
  )
  lines.push(
    `Credential: ${document.credential.found ? 'found' : 'missing'} — ${document.credential.sourcePath}${document.credential.reason === undefined ? '' : ` (${document.credential.reason})`}`,
  )
  lines.push(`Upstream: ${document.upstream.baseUrl}`)
  lines.push(`Models: ${document.catalog.enabled}/${document.catalog.total} enabled`)
  if (document.credits === undefined) {
    lines.push('Credits: unavailable (no cached snapshot)')
  } else if (document.credits.ok) {
    lines.push(
      `Credits: available ${document.credits.availableBalance} = balance ${document.credits.balance} + daily ${document.credits.dailyBalance}`,
      `Fetched: ${formatDateTime(document.credits.fetchedAt)}; ledger rows: ${document.credits.records.length}`,
    )
  } else {
    lines.push(`Credits: unavailable — ${document.credits.error.code} ${document.credits.error.message}`)
  }
  if (document.lastError !== undefined) {
    lines.push(
      `Last upstream error: ${document.lastError.code} ${document.lastError.message} (${document.lastError.path}, ${formatDateTime(document.lastError.at)})`,
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printDoctorHuman(document: DoctorDocument): void {
  const lines: string[] = ['Loomy Connect doctor', '====================']
  lines.push(`Account: ${document.account === null ? 'signed out' : document.account.phone}`)
  lines.push('Credential candidates:')
  for (const candidate of document.candidates) {
    lines.push(`  [${candidate.state}] ${candidate.path}${candidate.reason === '' ? '' : ` — ${candidate.reason}`}`)
  }
  lines.push(`Upstream: ${document.upstream.baseUrl}`)
  lines.push('Probes:')
  for (const probe of document.probes) {
    lines.push(`  ${probe.ok ? 'ok  ' : 'FAIL'} ${probe.path}: ${probe.reason}`)
  }
  lines.push(`Models: ${document.catalog.enabled}/${document.catalog.total} enabled`)
  if (document.lastError !== undefined) {
    lines.push(`Last upstream error: ${document.lastError.code} ${document.lastError.message}`)
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
    process.stderr.write(`dsh-connect-loomy: expected status or doctor; got ${JSON.stringify(action)}\n`)
    return 1
  }
  const json = flags.includes('--json')
  if (flags.some((flag) => flag !== '--json')) {
    process.stderr.write(`dsh-connect-loomy: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    if (action === 'status') {
      const document = await statusDocument()
      if (json) process.stdout.write(`${JSON.stringify(document)}\n`)
      else printStatusHuman(document)
      return 0
    }
    const document = await doctorDocument()
    if (json) process.stdout.write(`${JSON.stringify(document)}\n`)
    else printDoctorHuman(document)
    return 0
  } catch (error) {
    const failure: FailureView = { ok: false, error: { code: 'internal', message: safeErrorMessage(error) } }
    if (json) process.stdout.write(`${JSON.stringify(failure)}\n`)
    else process.stderr.write(`dsh-connect-loomy: ${action} failed: ${safeErrorMessage(error)}\n`)
    return 1
  }
}

// Only run when executed as a program (`node lib/bin.js`, or the npm bin shim).
// Importing the module from a test must stay side-effect free.
if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}

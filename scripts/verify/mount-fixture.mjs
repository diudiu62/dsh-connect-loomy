/**
 * Mount the real plugin entry (`lib/index.js` → `apply`) into a minimal cordis
 * stand-in, against a real HTTP server.
 *
 * The stand-in implements exactly the context surface `src/index.ts` and
 * `src/routes.ts` touch (`inject`, `effect`, `on`, `emit`, `logger`, `llm`,
 * `fiber.entry.options.id`), so the verification drives the shipped artifact
 * and the real route guards rather than re-implementing them:
 *
 * - settings sections are collected instead of rendered;
 * - `webServer.register` records the five exact routes, which are then served
 *   by a real `node:http` server (so the scripts can also exercise the
 *   Host/Origin/CSRF guards and the JSON bodies over the wire);
 * - `llm.registerAdapter` records the adapter, so model streaming can be driven
 *   through the very adapter the host would serve;
 * - `ctx.emit` records `llm/models-updated` for the hot-update check.
 *
 * All filesystem state is a fresh temp dir: `DSH_HOME` and
 * `LOOMY_AUTH_SESSION_FILE` are redirected before `apply`, and restored on
 * `close()`.
 *
 * @module dsh-connect-loomy/verify/mount-fixture
 */

import { createServer, request as httpRequestModule } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_PHONE, FAKE_SESSION, FAKE_USER_ID } from './mock-upstream.mjs'

/** Serialise one `auth-session.json` fixture (fake account, real shape). */
function authDocument() {
  return JSON.stringify({
    session: FAKE_SESSION,
    userid: FAKE_USER_ID,
    phone: FAKE_PHONE,
    updatedAt: 1_794_574_693_000,
  })
}

/** Make one raw HTTP request so a script controls Host/Origin/body exactly. */
export function httpRequest(urlString, options = {}) {
  const url = new URL(urlString)
  return new Promise((resolve, reject) => {
    const request = httpRequestModule(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) {
      request.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    }
    request.end()
  })
}

/**
 * Mount the plugin.
 *
 * @param {object} options
 * @param {string} options.baseURL upstream base URL (mock gateway)
 * @param {object} [options.configOverrides] extra `Config` fields
 * @param {boolean} [options.skipAuthFile] point the env override at the fixture
 *   path but never create the file (exercises the exclusive-env, signed-out
 *   path while `HOME` may still hold a desktop-shaped file)
 * @param {boolean} [options.withDesktopAuthFile] also write a realistic desktop
 *   sign-in file into the sandboxed `HOME` default location (fallback bait)
 * @returns {Promise<object>} the mounted fixture
 */
export async function mountPlugin(options) {
  const { baseURL } = options
  const module = await import('../../lib/index.js')

  const root = await mkdtemp(join(tmpdir(), 'loomy-verify-'))
  const dshHome = join(root, 'dsh-home')
  const authFile = join(root, 'auth-session.json')
  const statePath = join(dshHome, 'storages', 'dsh-connect-loomy', 'state.json')
  if (options.skipAuthFile !== true) {
    await writeFile(authFile, authDocument(), { mode: 0o600 })
  }
  if (options.withDesktopAuthFile === true) {
    const desktop = join(root, 'home', 'Library', 'Application Support', 'loomy')
    await mkdir(desktop, { recursive: true })
    await writeFile(join(desktop, 'auth-session.json'), authDocument(), { mode: 0o600 })
  }

  const previousEnv = {
    DSH_HOME: process.env['DSH_HOME'],
    LOOMY_AUTH_SESSION_FILE: process.env['LOOMY_AUTH_SESSION_FILE'],
    HOME: process.env['HOME'],
  }
  process.env['DSH_HOME'] = dshHome
  // The override is set even when `skipAuthFile` left the file absent: that is
  // exactly the exclusive-env, signed-out path this fixture must be able to
  // exercise (defaults are never inspected, even if HOME holds a desktop file).
  process.env['LOOMY_AUTH_SESSION_FILE'] = authFile
  // `authSessionCandidates()` also probes the platform's default paths; point
  // HOME at the temp dir so a real desktop login on this machine can never leak
  // into the fixture (and so a "signed out" scenario is actually signed out).
  process.env['HOME'] = join(root, 'home')

  const routes = new Map()
  const effects = []
  const disposers = []
  const emitted = []
  const logs = []
  const settingsSections = []
  const adapters = []
  let registeredProviderIds = []
  let registrationReplaced = 0

  const runEffect = (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') {
      effects.push(dispose)
      disposers.push(dispose)
    }
    return dispose
  }

  const settings = {
    configure(section) {
      settingsSections.push(section)
      return () => {}
    },
  }
  const webServer = {
    register(spec) {
      routes.set(spec.path, spec)
      return () => routes.delete(spec.path)
    },
  }
  const llm = {
    registerAdapter(providerIds, adapter) {
      registeredProviderIds = [...providerIds]
      const handle = () => {
        registeredProviderIds = []
      }
      handle.replace = (nextIds) => {
        registrationReplaced += 1
        registeredProviderIds = [...nextIds]
      }
      adapters.push({ providerIds: [...providerIds], adapter, handle })
      return handle
    },
  }

  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-loomy' } } },
    logger: {
      info: (message) => logs.push(`info: ${String(message)}`),
      warn: (message) => logs.push(`warn: ${String(message)}`),
      error: (message) => logs.push(`error: ${String(message)}`),
    },
    inject(_services, callback) {
      callback({ effect: runEffect, settings, webServer })
    },
    effect(fn) {
      return runEffect(fn)
    },
    on(event, callback) {
      emitted.push({ event: `listener:${event}`, payload: typeof callback })
    },
    emit(event, payload) {
      emitted.push({ event, payload })
    },
    llm,
  }

  const config = module.Config({
    baseURL,
    loomyVersion: '0.9.39',
    enabled: true,
    sessionTtlMs: 0,
    precheckTtlMs: 0,
    catalogTtlMs: 0,
    creditsTtlMs: 0,
    ...options.configOverrides,
  })

  let failure
  try {
    module.apply(ctx, config)
  } catch (error) {
    failure = error
  }

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
    const spec = routes.get(pathname)
    if (spec === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    void spec.handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const serverURL = `http://127.0.0.1:${port}`

  const fixture = {
    module,
    baseURL,
    serverURL,
    root,
    dshHome,
    authFile,
    statePath,
    config,
    ctx,
    routes,
    settingsSections,
    emitted,
    logs,
    adapters,
    applyError: failure,
    get adapter() {
      return adapters[0]?.adapter
    },
    get providerIds() {
      return registeredProviderIds
    },
    get registrationReplaced() {
      return registrationReplaced
    },
    /** The live model list the adapter serves (read live, per request). */
    async listModels() {
      return fixture.adapter.listModels('loomy')
    },
    /** GET/POST one host route over the real HTTP server. */
    request(path, options = {}) {
      return httpRequest(`${serverURL}${path}`, options)
    },
    async close() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Disposal failures are reported by the checks that need them.
        }
      }
      await new Promise((resolve) => server.close(() => resolve()))
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      // A background persist can still be finishing when the fixture closes;
      // retry the recursive remove instead of failing teardown on ENOTEMPTY.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
    },
  }
  return fixture
}

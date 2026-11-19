/**
 * Raccoon vendor + route-namespace tests.
 *
 * The catalog fixture is a **trimmed copy of a real 2026-11-17 response**
 * (`/api/web/llm/v2/model_catalog`): the hidden `raccoon-090dd3` rows, the
 * `visible:false` filter, `billing_effective_multiplier`, and the
 * `params.context_window` / `params.max_tokens` names all appear exactly as the
 * gateway sent them.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  applyVisionOverrides,
  authCandidates,
  bundlesOf,
  decodeJwtPayload,
  detectCoexistence,
  parseAuthDocument,
  parseBalance,
  parseCatalog,
  parseModel,
  raccoonHeaders,
} from '../lib/index.js'

const CATALOG = {
  code: 0,
  message: 'success',
  data: {
    categories: [
      {
        type: 'chat',
        default_model: 'raccoon-090dd3',
        models: [
          {
            name: 'raccoon-090dd3',
            description: 'Raccoon-Work',
            visible: false,
            model_name: 'raccoon-090dd3',
            tags: ['general', 'office', 'vision'],
            params: { context_window: 1000000, max_tokens: 100000 },
            billing_multiplier: 1,
            billing_effective_multiplier: 1,
          },
          {
            name: 'sn-glm-5-3-flash',
            description: 'GLM-5-3-Flash',
            visible: true,
            model_name: 'sn-glm-5-3-flash',
            tags: ['general', 'chat', 'vision', 'auto'],
            params: {
              raccoon_thinking: {
                managed: true,
                supported: true,
                can_disable: false,
                display_levels: [
                  { value: 'level_1', label: 'Minimal' },
                  { value: 'level_3', label: 'Medium' },
                ],
                default_level: 'level_1',
              },
              context_window: 1000000,
              max_tokens: 100000,
            },
            billing_multiplier: 0.2,
            billing_effective_multiplier: 0.2,
            billing_status: 'normal',
          },
          {
            name: 'sn-glm-5-3',
            description: 'GLM-5-3',
            visible: true,
            model_name: 'sn-glm-5-3',
            tags: ['general', 'office'],
            params: { context_window: 1000000, max_tokens: 100000 },
            billing_multiplier: 0.75,
            billing_effective_multiplier: 0.75,
          },
        ],
      },
      {
        type: 'image',
        models: [{ name: 'sn-image-gen', visible: true }],
      },
    ],
  },
}

test('catalog: hidden internal routes are dropped, chat category only', () => {
  const models = parseCatalog(CATALOG)
  assert.deepEqual(
    models.map((model) => model.id),
    ['sn-glm-5-3-flash', 'sn-glm-5-3'],
  )
})

test('catalog: upstream field names map onto CatalogModel', () => {
  const [flash] = parseCatalog(CATALOG)
  assert.equal(flash.name, 'GLM-5-3-Flash')
  assert.equal(flash.multiplier, 0.2)
  assert.equal(flash.contextWindow, 1_000_000)
  assert.equal(flash.maxOutput, 100_000)
  assert.equal(flash.vision, true)
  // `reasoning_effort` is not validated upstream (banana → 200), so no levels
  // are ever advertised.
  assert.deepEqual(flash.efforts, [])
})

test('catalog: missing params fall back instead of producing NaN', () => {
  const model = parseModel({ name: 'x', visible: true, tags: [] })
  assert.equal(model.contextWindow, 128_000)
  assert.equal(model.maxOutput, 8_192)
  assert.equal(model.multiplier, 1)
  assert.equal(model.vision, false)
})

test('catalog: vision overrides win, textOnly wins over vision', () => {
  const models = parseCatalog(CATALOG)
  const overridden = applyVisionOverrides(models, { visionModelIds: ['sn-glm-5-3'] })
  assert.equal(overridden.find((model) => model.id === 'sn-glm-5-3').vision, true)
  const both = applyVisionOverrides(models, {
    visionModelIds: ['sn-glm-5-3'],
    textOnlyModelIds: ['sn-glm-5-3'],
  })
  assert.equal(both.find((model) => model.id === 'sn-glm-5-3').vision, false)
})

test('catalog: empty or malformed bodies yield an empty list, never a throw', () => {
  assert.deepEqual(parseCatalog(undefined), [])
  assert.deepEqual(parseCatalog({ code: 0, data: {} }), [])
  assert.deepEqual(parseCatalog({ code: 200003, data: { categories: [{ type: 'chat', models: [] }] } }), [])
})

test('headers: bearer + client identity, org code only when set', () => {
  const base = raccoonHeaders('tok')
  assert.equal(base['Authorization'], 'Bearer tok')
  assert.equal(base['X-Client-Platform'], 'desktop')
  assert.equal(base['X-Org-Code'], undefined)
  assert.equal(raccoonHeaders('tok', { orgCode: 'org1' })['X-Org-Code'], 'org1')
  assert.equal(raccoonHeaders('tok', { deviceId: 'dev' })['X-Client-Device-ID'], 'dev')
})

test('auth: JWT exp is decoded, token aliases are accepted', () => {
  const exp = 1_800_000_000
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  const token = `h.${payload}.s`
  const snapshot = parseAuthDocument(
    JSON.stringify({ access_token: token, office_identity: 'personal' }),
    (exp - 60) * 1000,
  )
  assert.equal(snapshot.found, true)
  assert.equal(snapshot.expiresAt, exp * 1000)
  assert.equal(snapshot.expired, false)
  assert.equal(snapshot.identity, 'personal')
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined)

  const expired = parseAuthDocument(JSON.stringify({ token }), (exp + 60) * 1000)
  assert.equal(expired.expired, true)
})

test('auth: malformed documents degrade to signed-out with a reason', () => {
  assert.equal(parseAuthDocument('{').found, false)
  assert.equal(parseAuthDocument('{}').found, false)
  assert.match(parseAuthDocument('{}').problem, /access_token/u)
})

test('auth: RACCOON_AUTH_FILE is an exclusive replacement', () => {
  const candidates = authCandidates({ RACCOON_AUTH_FILE: '/tmp/pinned.json' }, '/home/u')
  assert.deepEqual(candidates, [{ path: '/tmp/pinned.json', origin: 'env' }])
  assert.ok(authCandidates({}, '/home/u').length >= 1)
})

test('profiles: bundles come from dependencies and dsh.profile.bundles', () => {
  const names = bundlesOf({
    dependencies: { 'dsh-connect-loomy': 'link:.' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-connect-desktop'] } },
  })
  assert.deepEqual(names, ['@deepseek-ai/dsh-base', 'dsh-connect-desktop', 'dsh-connect-loomy'])
  assert.deepEqual(bundlesOf(null), [])
})

test('profiles: coexistence blocks only when both names are mounted together', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  try {
    const profile = (name, document) => {
      mkdirSync(join(root, 'profiles', name), { recursive: true })
      writeFileSync(join(root, 'profiles', name, 'package.json'), JSON.stringify(document))
    }
    profile('web', { dsh: { profile: { bundles: ['dsh-connect-desktop'] } } })
    const rule = { selfName: 'dsh-connect-desktop', legacyNames: ['dsh-connect-loomy'] }

    const clear = detectCoexistence(rule, { dshHome: root, profiles: [
      { profile: 'web', packagePath: join(root, 'profiles/web/package.json'), entries: ['dsh-connect-desktop'] },
    ], unreadable: false })
    assert.equal(clear.kind, 'clear')

    profile('desktop', { dsh: { profile: { bundles: ['dsh-connect-desktop', 'dsh-connect-loomy'] } } })
    const blocked = detectCoexistence(rule, { dshHome: root, profiles: [
      { profile: 'desktop', packagePath: join(root, 'profiles/desktop/package.json'), entries: ['dsh-connect-desktop', 'dsh-connect-loomy'] },
    ], unreadable: false })
    assert.equal(blocked.kind, 'blocked')
    assert.equal(blocked.legacyName, 'dsh-connect-loomy')
    assert.equal(blocked.profile, 'desktop')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Raccoon auth flow + account store ──────────────────────────────────────

test('auth-flow: logout posts to the iam endpoint and reads the OK envelope', async () => {
  const { raccoonLogout: logout } = await import('../lib/index.js')
  const calls = []
  const result = await logout('tok', {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization, body: init.body })
      return new Response(JSON.stringify({ code: 'OK', message: 'success' }), { status: 200 })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/iam\/v1\/auth\/logout$/u)
  assert.equal(calls[0].auth, 'Bearer tok')
})

test('auth-flow: logout surfaces a business error verbatim', async () => {
  const { raccoonLogout: logout } = await import('../lib/index.js')
  const result = await logout('tok', {
    fetchImpl: async () => new Response(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }), { status: 200 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'authorization_verify_error')
})

test('auth-flow: sms login sends the encrypted phone from the injected encryptor', async () => {
  const { loginWithSms } = await import('../lib/index.js')
  let seen
  const result = await loginWithSms('86', '13812345678', '123456', (phone) => `enc(${phone})`, {
    fetchImpl: async (_url, init) => {
      seen = JSON.parse(init.body)
      return new Response(JSON.stringify({ code: 0, data: { access_token: 'a', refresh_token: 'r' } }), { status: 200 })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accessToken, 'a')
  assert.equal(seen.phone, 'enc(13812345678)')
  assert.equal(seen.sms_code, '123456')
  assert.equal(seen.nation_code, '86')
})

test('phone encryption matches the client: AES-128-CFB, key senseraccoon2023, IV-prefixed base64', async () => {
  const { encryptRaccoonPhone, decryptRaccoonPhone } = await import('../lib/index.js')
  const encrypted = encryptRaccoonPhone('13812345678')
  // 16-byte IV + 11-byte ciphertext → 36 base64 chars, which is what the main
  // process accepts via /^[A-Za-z0-9+/]+={0,2}$/.
  assert.match(encrypted, /^[A-Za-z0-9+/]+={0,2}$/u)
  assert.equal(encrypted.length, 36)
  assert.equal(decryptRaccoonPhone(encrypted), '13812345678')
  // A fresh IV every call: two encryptions of the same number must differ.
  assert.notEqual(encryptRaccoonPhone('13812345678'), encryptRaccoonPhone('13812345678'))
})

test('encryptor: nation code is NOT treated as the passphrase (regression: Invalid key length)', async () => {
  const { encryptRaccoonPhone, decryptRaccoonPhone } = await import('../lib/index.js')
  // The route passes (phone, nationCode); treating nationCode as the AES key
  // produced a 2-byte key and threw "Invalid key length" before any request.
  const encrypted = encryptRaccoonPhone('13812345678', '86')
  assert.equal(encrypted.length, 36)
  assert.equal(decryptRaccoonPhone(encrypted), '13812345678')
  // Same number, different nation code → still valid ciphertext.
  assert.equal(decryptRaccoonPhone(encryptRaccoonPhone('13812345678', '1')), '13812345678')
})

test('password login encrypts the password, not just the phone', async () => {
  const { loginWithPassword } = await import('../lib/index.js')
  let seen
  await loginWithPassword('86', '13812345678', 'hunter2', (p) => `enc(${p})`, {
    fetchImpl: async (_url, init) => {
      seen = JSON.parse(init.body)
      return new Response(JSON.stringify({ code: 0, data: { access_token: 'a' } }), { status: 200 })
    },
  })
  assert.equal(seen.phone, 'enc(13812345678)')
  assert.equal(seen.password, 'enc(hunter2)', 'the client sends the password encrypted too')
})

// ── Raccoon account pool ───────────────────────────────────────────────────


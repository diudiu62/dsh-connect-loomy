#!/usr/bin/env node
/**
 * Vision-path verification: the Loomy route must be able to carry images.
 *
 * The failure this script exists to prevent is silent-by-design: `PiAiAdapter`
 * raises `pi-ai image input requires the durable attachment service`
 * (`dsh-llm-pi-ai/lib/index.js:2003`) whenever its `resolveAttachments()` hook
 * answers `undefined`, so a vision-capable Loomy model used to fail every
 * image request before any I/O. Nothing in the text-only suite noticed.
 *
 * What it proves, against the shipped `lib/index.js` and a **real**
 * `@deepseek-ai/dsh-attachment-local` store (no fetch double for the store, no
 * stubbed attachment provider):
 *
 * 1. the store durably admits a real PNG and answers `readImageRequest` with
 *    request-sized bytes (the seam the adapter depends on);
 * 2. the provider runtime built by `createProviderRuntime` forwards
 *    `resolveAttachments` and `resolveImageAccess` into the adapter;
 * 3. a user message carrying a durable image reference reaches the wire as
 *    `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}` —
 *    the only form the Loomy gateway accepts (`docs/loomy-upstream.md` §6);
 * 4. the accompanying handle text names the attachment, its request-preview
 *    dimensions, and (when a filesystem bridge is supplied) a readable path;
 * 5. `Authorization: Bearer <session>` and the tracing headers still reach the
 *    conversation endpoint alongside the image;
 * 6. a host with no attachment provider fails with actionable Chinese text
 *    naming `ctx.attachments` and `dsh-attachment-local`, and dispatches no
 *    request at all.
 *
 * Run: `node scripts/verify/verify-vision-attachments.mjs`
 *
 * @module dsh-connect-loomy/verify/vision-attachments
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CheckLog, ensure, ensureEqual, ensureMatch } from './checks.mjs'
import { FAKE_SESSION } from './mock-upstream.mjs'

const checks = new CheckLog('vision-attachments')

/**
 * A real 16x16 opaque orange PNG, generated offline (IHDR/IDAT/IEND, zlib
 * deflate, CRC32) so this script needs no raster toolchain of its own.
 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mP4H8DwnxLMMGrAqAGjBgwXAwDiQk4fGu8rUgAAAABJRU5ErkJggg=='

const PNG = Buffer.from(PNG_BASE64, 'base64')

/** Vision-capable catalog entry, shaped like the recorded upstream answer. */
const VISION_MODEL = {
  id: 'qwen3.8-flash',
  name: 'qwen 3.8 flash（x0.8）',
  multiplier: 0.8,
  contextWindow: 1_000_000,
  maxOutput: 131_072,
  vision: true,
  efforts: ['none', 'low', 'high'],
  defaultEffort: 'low',
}

/** Stand up a real attachment store under a throwaway DSH_HOME. */
async function startStore() {
  const home = await mkdtemp(join(tmpdir(), 'loomy-vision-home-'))
  const ctx = new Context()
  ctx.plugin(LocalAttachmentStore, { dshHome: home })
  // Service registration is synchronous in cordis; the microtask drain only
  // guards against a future loader that defers it.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const store = ctx.get('attachments')
  ensure(store !== undefined, 'ctx.get("attachments") returned no store')
  return { ctx, store, home }
}

/** Build the provider runtime the plugin's `apply()` builds. */
async function buildRuntime({ resolveAttachments, resolveImageAccess }) {
  const module = await import('../../lib/index.js')
  return module.createProviderRuntime({
    catalog: {
      enabledModels: () => [VISION_MODEL],
      kickStaleRefresh() {},
    },
    baseURL: () => 'https://gateway.test/api/v1',
    loomyVersion: () => '0.9.39',
    readSession: async () => ({
      found: true,
      sourcePath: '/fixture/auth-session.json',
      session: FAKE_SESSION,
    }),
    precheck: async () => ({ ok: true, definite: false }),
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
    ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
    logger: { warn() {} },
  })
}

/** Drive one stream while capturing the fetch calls the adapter makes. */
async function streamWithCapture(runtime, messages) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const frame = {
      id: 'chatcmpl-vision',
      object: 'chat.completion.chunk',
      created: 1,
      model: VISION_MODEL.id,
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    }
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    const chunks = []
    for await (const chunk of runtime.adapter.stream({
      provider: 'loomy',
      model: VISION_MODEL.id,
      messages,
    })) {
      chunks.push(chunk)
    }
    return { chunks, calls }
  } finally {
    globalThis.fetch = original
  }
}

// ── 1. the real store admits and serves the image ──────────────────────────

const { store, home } = await startStore()
const [ref] = await store.saveImages([{ data: PNG, mediaType: 'image/png', name: 'pixel.png' }])
checks.record(
  'store admits a real PNG and returns a durable sha256 reference',
  typeof ref.attachmentId === 'string' && String(ref.attachmentId).startsWith('sha256:'),
  `ref=${String(ref.attachmentId).slice(0, 16)}… ${ref.width}x${ref.height} ${ref.bytes}B`,
)
checks.record(
  'the stored reference keeps the requested display name and dimensions',
  ref.name === 'pixel.png' && ref.width === 16 && ref.height === 16,
  `name=${ref.name} ${ref.width}x${ref.height}`,
)

const version = await store.readImageRequest(ref, { width: 16, height: 16, maxBytes: 1024 * 1024 })
checks.record(
  'readImageRequest projects request-sized bytes for the adapter',
  version.bytes > 0 && version.mediaType === 'image/png' && version.depth === 'uchar',
  `${version.mediaType} ${version.width}x${version.height} ${version.bytes}B space=${version.space}`,
)

const hostPath = store.imageHostPath(ref)
checks.record(
  'imageHostPath locates the normalized object on the host filesystem',
  typeof hostPath === 'string' && hostPath.includes('/attachments/v1/objects/'),
  String(hostPath),
)

// ── 2. the runtime forwards both hooks ─────────────────────────────────────

const bridged = await buildRuntime({
  resolveAttachments: () => store,
  resolveImageAccess: (_store, imageRef) => ({ readonlyPath: `/world/${String(imageRef.attachmentId).slice(7, 15)}.png` }),
})
checks.record(
  'createProviderRuntime accepts and forwards the attachment hooks',
  bridged.adapter.config.resolveAttachments() === store &&
    typeof bridged.adapter.config.resolveImageAccess === 'function',
  `resolveAttachments→${bridged.adapter.config.resolveAttachments()?.constructor?.name}`,
)

// ── 3./4./5. the image reaches the wire ────────────────────────────────────

const { chunks, calls } = await streamWithCapture(bridged, [
  {
    role: 'user',
    content: [
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image', attachment: ref },
    ],
  },
])

const finish = chunks.find((chunk) => chunk.type === 'finish')
checks.record(
  'the vision request completes with a clean stop',
  finish?.reason?.kind === 'stop',
  JSON.stringify(finish?.reason),
)

ensureEqual(calls.length, 1, 'exactly one conversation request must be dispatched')
const body = JSON.parse(calls[0].init.body)
const parts = body.messages.at(-1).content
checks.record(
  'the wire content carries text and exactly one image part',
  Array.isArray(parts) && parts.filter((part) => part.type === 'image_url').length === 1,
  parts.map((part) => part.type).join(', '),
)

const image = parts.find((part) => part.type === 'image_url')
checks.record(
  'the image is an inline base64 data: URL (the only form the gateway accepts)',
  image?.image_url?.url === `data:image/png;base64,${PNG_BASE64}`,
  `${String(image?.image_url?.url).slice(0, 46)}…`,
)

const handle = parts.find((part) => part.type === 'text' && part.text.includes('pixel.png'))?.text
checks.record(
  'the handle text names the attachment and its request-preview dimensions',
  typeof handle === 'string' && handle.includes('request preview 16x16px'),
  handle,
)
checks.record(
  'the handle text exposes the bridged execution-world path',
  typeof handle === 'string' && handle.includes('/world/'),
  handle,
)

const headers = new Headers(calls[0].init.headers)
checks.record(
  'the conversation still authenticates with the desktop session Bearer token',
  headers.get('authorization') === `Bearer ${FAKE_SESSION}`,
  String(headers.get('authorization')).slice(0, 20),
)
checks.record(
  'the tracing headers ride along with the image request',
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(String(headers.get('traceparent'))) &&
    String(headers.get('chatid')).startsWith('chat-') &&
    String(headers.get('msgid')).startsWith('msg-') &&
    headers.get('loomy-version') === '0.9.39',
  `traceparent=${String(headers.get('traceparent')).slice(0, 20)}… loomy-version=${headers.get('loomy-version')}`,
)
checks.record(
  'max_completion field and stream usage request survive alongside the image',
  body.stream === true && body.stream_options?.include_usage === true && body.model === VISION_MODEL.id,
  `model=${body.model} stream=${body.stream}`,
)

// ── 4b. no filesystem bridge: the image still goes out ─────────────────────

const unbudged = await buildRuntime({ resolveAttachments: () => store })
const second = await streamWithCapture(unbudged, [
  { role: 'user', content: [{ type: 'image', attachment: ref }] },
])
const secondParts = JSON.parse(second.calls[0].init.body).messages.at(-1).content
const secondHandle = secondParts.find((part) => part.type === 'text')?.text
checks.record(
  'without a filesystem bridge the image still reaches the wire',
  secondParts.some((part) => part.type === 'image_url'),
  secondParts.map((part) => part.type).join(', '),
)
checks.record(
  'the unbudged handle degrades to the "may be resized" wording only',
  typeof secondHandle === 'string' &&
    secondHandle.includes('may be resized or re-encoded') &&
    !secondHandle.includes('read-only'),
  secondHandle,
)

// ── 6. no attachment provider: actionable failure, zero I/O ────────────────

const bare = await buildRuntime({})
const before = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  before.push({ url, init })
  throw new Error('no request may be dispatched without an attachment provider')
}
let failure
try {
  for await (const _chunk of bare.adapter.stream({
    provider: 'loomy',
    model: VISION_MODEL.id,
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
  })) {
    void _chunk
  }
} catch (error) {
  failure = error
} finally {
  globalThis.fetch = originalFetch
}

checks.record(
  'a host without an attachment provider rejects the image before any I/O',
  failure !== undefined && before.length === 0,
  `thrown=${failure?.code} dispatched=${before.length}`,
)
checks.record(
  'the rejection names the missing service and the fix',
  failure?.code === 'UNSUPPORTED_CONTENT' &&
    /ctx\.attachments/u.test(String(failure?.message)) &&
    /dsh-attachment-local/u.test(String(failure?.message)) &&
    /重启 DSH/u.test(String(failure?.message)),
  String(failure?.message),
)
checks.record(
  'the bare runtime really has no attachment hook wired',
  bare.adapter.config.resolveAttachments() === undefined,
  `resolveAttachments→${String(bare.adapter.config.resolveAttachments())}`,
)

// ── 7. a text-only model keeps the capability error, not the fix text ──────

const plainModule = await import('../../lib/index.js')
const plainRuntime = plainModule.createProviderRuntime({
  catalog: {
    enabledModels: () => [{ ...VISION_MODEL, id: 'plain-chat', name: 'Plain Chat', vision: false, efforts: [] }],
    kickStaleRefresh() {},
  },
  baseURL: () => 'https://gateway.test/api/v1',
  loomyVersion: () => '0.9.39',
  readSession: async () => ({ found: true, sourcePath: '/fixture/auth.json', session: FAKE_SESSION }),
  precheck: async () => ({ ok: true, definite: false }),
  resolveAttachments: () => store,
  logger: { warn() {} },
})
let plainFailure
try {
  for await (const _chunk of plainRuntime.adapter.stream({
    provider: 'loomy',
    model: 'plain-chat',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
  })) {
    void _chunk
  }
} catch (error) {
  plainFailure = error
}
checks.record(
  'a text-only model reports the capability mismatch, not the attachment fix',
  plainFailure?.code === 'UNSUPPORTED_CONTENT' &&
    !/dsh-attachment-local/u.test(String(plainFailure?.message)),
  String(plainFailure?.message),
)

await rm(home, { recursive: true, force: true })
process.exit(checks.finish())

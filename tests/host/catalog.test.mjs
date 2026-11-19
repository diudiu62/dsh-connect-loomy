/**
 * Catalog normalisation and selection semantics.
 *
 * The upstream `/models` answer is the only whitelist a request may name, so
 * these tests pin which entries may be registered and how multiplier / context /
 * output / vision / efforts are read. The cache, the TTL and the persisted
 * selection now live in `core/catalog.ts` and are covered by
 * `tests/host/stores.test.mjs`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHAT_IDS, RAW_MODELS, modelsBody, tempDir } from './helpers.mjs'
import {
  applyVisionOverrides,
  mergeSelection,
  normalizeCatalog,
  normalizeCatalogModel,
  parseMultiplier,
  resolveEnabledIds,
  toPiModel,
} from '../../lib/index.js'

test('normalizeCatalog keeps chat models only, in upstream order', () => {
  const models = normalizeCatalog(modelsBody())
  assert.deepEqual(models.map((model) => model.id), CHAT_IDS)

  // Every non-chat escape hatch is filtered: image models (with and without
  // capabilities), the billing `auto` alias and the legacy protocol.
  const ids = new Set(models.map((model) => model.id))
  assert.ok(!ids.has('Hy-Image-3.5-preview'))
  assert.ok(!ids.has('legacy-image-no-capabilities'))
  assert.ok(!ids.has('auto'))
  assert.ok(!ids.has('legacy-chat'))

  const spark = models[0]
  assert.equal(spark.name, 'Spark-X2.6 正式版(限时免费)(x0.0)')
  assert.equal(spark.multiplier, 0, 'x0.0 parses as a free model')
  assert.equal(spark.contextWindow, 1_048_576)
  assert.equal(spark.maxOutput, 131_072)
  assert.equal(spark.vision, false)
  assert.deepEqual(spark.efforts, ['none', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(spark.defaultEffort, 'low')

  const deepseek = models[1]
  assert.equal(deepseek.multiplier, 2)
  assert.equal(deepseek.contextWindow, 1_048_576)
  assert.equal(deepseek.maxOutput, 384_000)
  assert.equal(deepseek.vision, true)
  assert.equal(deepseek.defaultEffort, 'high')

  const qwen = models[2]
  assert.equal(qwen.multiplier, 0.8, 'full-width （x0.8） parses')
  assert.equal(qwen.vision, true)
  assert.deepEqual(qwen.efforts, ['none', 'low', 'high'], 'unknown `extreme` is dropped')
  assert.equal(qwen.defaultEffort, 'low')

  const fallback = models[3]
  assert.equal(fallback.multiplier, 0)
  assert.equal(fallback.contextWindow, 128_000, 'missing context_length uses the host fallback')
  assert.equal(fallback.maxOutput, 8_192, 'missing max_output_tokens uses the host fallback')
  assert.equal(fallback.vision, false)
  assert.deepEqual(fallback.efforts, [])
  assert.equal(fallback.defaultEffort, '')
})

test('normalizeCatalogModel degrades a malformed default effort to the first offered one', () => {
  const model = normalizeCatalogModel({
    id: 'odd',
    name: 'Odd(x1.5)',
    type: 'chat',
    protocol: 'openai_chat',
    reasoning_efforts: ['none', 'high'],
    default_reasoning_effort: 'extreme',
    capabilities: { reasoning: true, vision: false, input_modalities: ['text'], output_modalities: ['text'] },
  })
  assert.equal(model.defaultEffort, 'none')
  assert.deepEqual(model.efforts, ['none', 'high'])
  assert.equal(model.multiplier, 1.5)
})

test('normalizeCatalogModel rejects non-objects and entries without an id', () => {
  assert.equal(normalizeCatalogModel(undefined), undefined)
  assert.equal(normalizeCatalogModel('model'), undefined)
  assert.equal(normalizeCatalogModel({ name: 'no id' }), undefined)
})

test('normalizeCatalog accepts both the `data` array and a bare array body', () => {
  assert.equal(normalizeCatalog(RAW_MODELS).length, 4)
  assert.equal(normalizeCatalog({ data: { data: RAW_MODELS } }).length, 4)
  assert.deepEqual(normalizeCatalog({ nope: true }), [])
  assert.deepEqual(normalizeCatalog(undefined), [])
})

test('normalizeCatalog de-duplicates repeated ids, keeping the first entry', () => {
  const models = normalizeCatalog({
    data: [
      { id: 'same', name: 'Same(x1.0)', type: 'chat', protocol: 'openai_chat' },
      { id: 'same', name: 'Same(x9.0)', type: 'chat', protocol: 'openai_chat' },
    ],
  })
  assert.equal(models.length, 1)
  assert.equal(models[0].multiplier, 1)
})

test('parseMultiplier reads only parenthesised rates', () => {
  assert.equal(parseMultiplier('DeepSeek V4.1 Flash(x2.0)'), 2)
  assert.equal(parseMultiplier('qwen 3.8 flash（x0.8）'), 0.8)
  assert.equal(parseMultiplier('MiMo V2.5（x3.3）'), 3.3)
  assert.equal(parseMultiplier('（×1.5）'), 1.5)
  assert.equal(parseMultiplier('Spark-X2.6 正式版(限时免费)(x0.0)'), 0)
  assert.equal(parseMultiplier('Spark X2.5'), 0, 'an unparenthesised X2.5 is not a rate')
  assert.equal(parseMultiplier('free model'), 0)
  assert.equal(parseMultiplier('(x)'), 0)
})

test('resolveEnabledIds: null means every model, [] means none, unknown ids are dropped', () => {
  const models = normalizeCatalog(modelsBody())
  assert.deepEqual(resolveEnabledIds(models, null), CHAT_IDS)
  assert.deepEqual(resolveEnabledIds(models, []), [])
  assert.deepEqual(resolveEnabledIds(models, ['spark-x2.6', 'removed-model']), ['spark-x2.6'])
  // Catalog order wins, so a stale card cannot reorder the provider's list.
  assert.deepEqual(resolveEnabledIds(models, ['qwen3.8-flash', 'spark-x2.6']), ['spark-x2.6', 'qwen3.8-flash'])
})

test('mergeSelection reports the *saved* selection and never mutates its inputs', () => {
  const models = normalizeCatalog(modelsBody())
  const before = JSON.stringify(models)
  const all = mergeSelection(models, null)
  assert.ok(all.every((model) => model.enabled === true))
  const some = mergeSelection(models, ['spark-x2.6', 'qwen3.8-flash'])
  assert.deepEqual(
    some.map((model) => [model.id, model.enabled]),
    [
      ['spark-x2.6', true],
      ['DeepSeek-V4.1-Flash', false],
      ['qwen3.8-flash', true],
      ['mystery-chat', false],
    ],
  )
  assert.equal(JSON.stringify(models), before, 'normalisation output is not mutated')
})

test('applyVisionOverrides re-labels only the listed ids, text-only wins', () => {
  const models = normalizeCatalog(modelsBody())
  const spark = models.find((model) => model.id === 'spark-x2.6')
  const qwen = models.find((model) => model.id === 'qwen3.8-flash')

  const promoted = applyVisionOverrides([spark], { visionModelIds: ['spark-x2.6'] })[0]
  assert.equal(promoted.vision, true)
  assert.equal(spark.vision, false, 'the normalised entry itself is never mutated')

  assert.deepEqual(applyVisionOverrides(models, {}), models, 'no configuration is a no-op')
  assert.equal(
    applyVisionOverrides(models, { visionModelIds: ['ghost-model'] })[0].vision,
    false,
    'unknown ids are ignored: the catalog stays the whitelist',
  )

  const both = applyVisionOverrides(models, {
    visionModelIds: ['spark-x2.6'],
    textOnlyModelIds: ['spark-x2.6'],
  })
  assert.equal(both[0].vision, false, 'text-only beats vision for the same id')
  assert.equal(
    applyVisionOverrides(models, { textOnlyModelIds: ['qwen3.8-flash'] }).find((m) => m.id === 'qwen3.8-flash').vision,
    false,
  )
  assert.equal(qwen.vision, true, 'a demoted model leaves its neighbours alone')
})

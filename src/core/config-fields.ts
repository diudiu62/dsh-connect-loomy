/**
 * 把一家供应商的配置片翻译成可渲染的字段列表。
 *
 * 为什么需要它：`settings.configure({ auto: false })` 之后，DSH 不会为这个 section
 * 生成表单，卡片是唯一条目。而卡片要能画出「接口地址 / 缓存时长 / 开关」这些控件，
 * 就必须知道**每个字段的类型、默认值和是否被用户改过**——这些都藏在 vendor 自己的
 * schemastery schema 里，只有在运行时反射才拿得到。
 *
 * 反射而不是手写清单：手写清单会和 schema 漂移，而漂移的后果是"配置里看不到某个
 * 字段"，正是这次要修的问题。
 *
 * @module dsh-connect-desktop/core/config-fields
 */

import type { ConfigFieldView } from '../shared/views.js'
import type { VendorDescriptor } from '../vendor-sdk/contracts.js'

/** schemastery 的 schema 实例（只用到我们反射的那几个属性）。 */
interface SchemaLike {
  dict?: Record<string, SchemaLike>
  meta?: { default?: unknown; description?: string }
  type?: string
  toString?: () => string
}

/**
 * 从 schema 推断控件形态。
 *
 * schemastery 没有公开的"字段类型"枚举，`toString()` 是它自己的渲染入口，输出形如
 * `boolean` / `natural` / `string` / `array`。用它可以覆盖我们声明过的全部字段，
 * 且不必为每种类型写一个映射常量。
 */
function typeOf(schema: SchemaLike, fallback: unknown): ConfigFieldView['type'] {
  const rendered = typeof schema.toString === 'function' ? schema.toString() : ''
  if (rendered.startsWith('array') || rendered.includes('array')) return 'string-list'
  if (rendered.startsWith('boolean')) return 'boolean'
  if (/natural|number|percent|range/u.test(rendered)) return 'number'
  if (Array.isArray(fallback)) return 'string-list'
  if (typeof fallback === 'boolean') return 'boolean'
  if (typeof fallback === 'number') return 'number'
  return 'string'
}

/**
 * 一家的字段列表。
 *
 * 三个入参各自回答一件事，**不能合并**：
 * - `effective`：合并后的生效值（用户层覆盖默认层）→ 控件里显示什么；
 * - `overrides`：**只看用户层**→ 这一项到底有没有被改过；
 * - `descriptor.config.defaults`：声明的默认值 → 「恢复默认」的目标。
 *
 * 之前把 `overridden` 判断在 `effective` 上，而 `effective` 一定包含全部字段，
 * 于是"已修改"标记永远为真、形同虚设。用户层必须是单独一份。
 *
 * `group` 来自 descriptor 声明的 `groups`：core 不猜字段语义（猜就要写
 * `creditsPageSize` 这种供应商字面量），只按供应商给的清单归位。
 */
export function describeVendorConfig(
  descriptor: VendorDescriptor,
  effective: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ConfigFieldView[] {
  const defaults = descriptor.config.defaults
  const schema = descriptor.config.schema as SchemaLike | undefined
  const dict = schema?.dict ?? {}
  const keys = Object.keys(defaults)

  /** 这个字段属于哪一组（由 descriptor 的 `groups` 声明；没声明就不分组）。 */
  const groupOf = (key: string): string | undefined =>
    descriptor.config.groups?.find((group) => group.keys.includes(key))?.id

  return keys.map((key) => {
    const fieldSchema = dict[key] as SchemaLike | undefined
    const fallback = defaults[key]
    // 只看用户层：它里面有这个键，才说明用户显式写过（只控制"已修改"标记）。
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key)
    // 显示值永远取生效值：即使没被用户改过，也可能是「历史上写过又恢复」。
    const value = Object.prototype.hasOwnProperty.call(effective, key) ? effective[key] : fallback
    const description = fieldSchema?.meta?.description
    return {
      key,
      type: fieldSchema === undefined ? typeOf({}, fallback) : typeOf(fieldSchema, fallback),
      value,
      default: fallback,
      overridden,
      ...(description === undefined ? {} : { description }),
      ...(groupOf(key) === undefined ? {} : { group: groupOf(key) as string }),
    }
  })
}
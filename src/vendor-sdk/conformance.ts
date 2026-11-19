/**
 * Contract self-check: does the runtime actually implement what the descriptor
 * declares?
 *
 * This runs at mount time, so "declared `pool: true` but never implemented
 * accounts" is a boot error instead of a user clicking into a tab that renders
 * nothing. The same function backs the conformance tests, so a new vendor is
 * checked by the same rules in CI.
 *
 * @module dsh-connect-desktop/vendor-sdk/conformance
 */

import type { VendorModule, VendorRuntime } from './contracts.js'

/** Collect every mismatch between a descriptor and its runtime. */
export function conformanceProblems(module: VendorModule, runtime: VendorRuntime): string[] {
  const problems: string[] = []
  const declared = module.descriptor.capabilities
  const hasAccounts = runtime.accounts !== undefined

  if (declared.accounts !== 'none' && !hasAccounts) {
    problems.push(`声明 accounts=${declared.accounts} 但没有 accounts driver`)
  }
  if (declared.accounts === 'none' && hasAccounts) {
    problems.push('accounts driver 存在但能力声明为 none')
  }
  if (declared.pool && !hasAccounts) {
    problems.push('声明 pool 但没有 accounts driver')
  }
  if (declared.accounts === 'multi' && runtime.accounts?.rename === undefined) {
    problems.push('声明 accounts=multi 但没有 rename 实现')
  }
  if (declared.transfer && runtime.accounts?.exportBundle === undefined) {
    problems.push('声明 transfer 但没有 exportBundle 实现')
  }
  if (declared.adopt && runtime.accounts?.adopt === undefined) {
    problems.push('声明 adopt 但没有 adopt 实现')
  }
  if (declared.credits.kind !== 'none' && runtime.credits === undefined) {
    problems.push(`声明 credits=${declared.credits.kind} 但没有 credits driver`)
  }
  if (declared.credits.kind === 'none' && runtime.credits !== undefined) {
    problems.push('credits driver 存在但能力声明为 none')
  }
  if (declared.catalog.selection && runtime.catalog === undefined) {
    problems.push('声明 catalog.selection 但没有 catalog driver')
  }
  const wantsLogin = declared.login.some((method) => method !== 'none')
  if (wantsLogin && runtime.login === undefined) {
    problems.push(`声明 login=[${declared.login.join(',')}] 但没有 login driver`)
  }
  if (!wantsLogin && runtime.login !== undefined) {
    problems.push('login driver 存在但能力声明为 none')
  }
  if (runtime.chat.api !== 'openai-completions') {
    problems.push(`chat.api 必须是 openai-completions，实际为 ${String(runtime.chat.api)}`)
  }
  if (typeof runtime.resolveCredential !== 'function') {
    problems.push('缺少 resolveCredential：凭据优先级必须在一处决定')
  }
  if (typeof runtime.routes !== 'function') {
    problems.push('缺少 routes()：无法推导 provider 路由')
  }
  return problems
}

/** Throw when the runtime does not honour its declaration. */
export function assertRuntime(module: VendorModule, runtime: VendorRuntime): void {
  const problems = conformanceProblems(module, runtime)
  if (problems.length === 0) return
  throw new Error(
    `供应商 ${module.descriptor.id} 的能力声明与实现不一致：\n- ${problems.join('\n- ')}`,
  )
}

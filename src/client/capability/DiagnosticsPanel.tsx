/**
 * 诊断面板：**四段 + 一个折叠**，不再是一棵 7 层嵌套的 section 树。
 *
 * 原来的问题（都是实测出来的，不是审美）：
 * - 8 个 section 标题、7 层嵌套，整块 790px；用户要滚到底才知道结论；
 * - 有**两个**「凭据结论」（第二处其实是宿主路由，键用错了）；
 * - 按钮叫「凭据候选路径」，和它下面那段标题同名 —— 动作和对象分家；
 * - `sourceOrigin` / 候选 `state` 直接渲染成英文 enum（`desktop`、`ok`）；
 * - 「目录」「账号」两段的数字在模型 tab、账号 tab 都有，各占一段只为放两个数。
 *
 * 现在的顺序按排障时真正会问的问题排：
 *   我在看谁 → 凭据好不好 → 上游怎么答 → 宿主有哪些路由 → 最近一次错在哪儿。
 *
 * @module dsh-connect-desktop/client/capability/DiagnosticsPanel
 */

import { useCallback, useState } from 'react'
import type { DiagnosticsProbe, VendorDiagnosticsView } from '../../shared/views.js'
import { copyToClipboard } from '../clipboard.js'
import { Badge, CardButton, FactRow, Notice, Section } from '../components/common.js'
import { failureMessage, type CardT, type Loadable } from '../components/types.js'
import { formatDateTime, originLabel } from '../format.js'
import { requestVendor } from '../transport.js'
import { useVendorRoute } from './loadable.js'

type Payload = Omit<VendorDiagnosticsView, 'ok'>

export interface DiagnosticsPanelProps {
  t: CardT
  vendorId: string
  /** 活体探针是 POST + CSRF（会消耗配额，不能被 `<img src>` 触发）。 */
  csrf: string | null
}

export function DiagnosticsPanel({ t, vendorId, csrf }: DiagnosticsPanelProps) {
  const load = useCallback(
    (signal: AbortSignal) => requestVendor<Payload>({ vendorId, suffix: 'diagnostics', signal }),
    [vendorId],
  )
  const diagnostics = useVendorRoute(load)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const [probes, setProbes] = useState<readonly DiagnosticsProbe[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const view = diagnostics.state.kind === 'ready' ? diagnostics.state.value : null

  /** 真打一次上游，把每个端点现在说的话逐条带回来。 */
  const probe = async (): Promise<void> => {
    setProbing(true)
    setProbeError(null)
    try {
      const result = await requestVendor<{ probes: DiagnosticsProbe[] }>({
        vendorId,
        suffix: 'diagnostics/probe',
        method: 'POST',
        csrf,
      })
      if (result.kind === 'ok') setProbes(result.value.probes)
      else setProbeError(result.kind === 'failed' ? result.message : t('common.unknownError'))
    } finally {
      setProbing(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (view === null) return
    setCopied((await copyToClipboard(formatReport(view, vendorId, t))) ? 'ok' : 'failed')
  }

  const failure = failureMessage(diagnostics.state as Loadable<unknown>, t)
  const shownProbes = probes ?? view?.probes ?? []
  const probeOk = shownProbes.filter((entry) => entry.ok).length

  return (
    <>
      {/*
        摘要行：让这块面板在第一行就给出结论。原来要滚过 7 段才知道"到底好不好"。
      */}
      <div className="dcss-summary" data-dcss-cap="diagnostics-summary">
        <span className="dcss-summary-meta">
          {view === null
            ? t('diagnostics.loading')
            : `${view.displayName} · ${t('diagnostics.summary.probes', { ok: probeOk, total: shownProbes.length })}`}
        </span>
        <span className="dcss-summary-spacer" />
        <CardButton onClick={() => void diagnostics.reload()}>{t('diagnostics.refresh')}</CardButton>
        <CardButton onClick={() => void copy()} disabled={view === null}>
          {copied === 'ok' ? t('common.copied') : copied === 'failed' ? t('common.copyFailed') : t('diagnostics.copy')}
        </CardButton>
      </div>

      {failure !== null ? <Notice tone="error">{failure}</Notice> : null}
      {diagnostics.state.kind === 'loading' ? <p className="dcss-hint">{t('diagnostics.loading')}</p> : null}

      {view !== null ? (
        <>
          <Section title={t('diagnostics.credential')} cap="credential">
            <FactRow label={t('diagnostics.credential.source')}>
              <span className="dcss-mono">{view.credential.sourcePath || '—'}</span>
            </FactRow>
            <FactRow label={t('account.source')}>{originLabel(view.credential.sourceOrigin, t)}</FactRow>
            {view.credential.expiresAt === undefined ? null : (
              <FactRow label={t('diagnostics.credential.expires')}>{formatDateTime(view.credential.expiresAt)}</FactRow>
            )}
            {view.credential.problem === undefined ? null : (
              <FactRow label={t('diagnostics.credential.problem')}>{view.credential.problem}</FactRow>
            )}
            {view.credential.candidates.map((candidate) => (
              <FactRow key={candidate.path} label={t('diagnostics.credential.candidate')}>
                <Badge tone={candidate.state === 'ok' ? 'ok' : 'danger'}>
                  {candidate.state === 'ok' ? t('diagnostics.probe.ok') : t('diagnostics.probe.fail')}
                </Badge>
                <span className="dcss-mono"> {candidate.path}</span>
                {candidate.reason === '' ? null : <span className="dcss-hint"> — {candidate.reason}</span>}
              </FactRow>
            ))}
          </Section>

          <Section
            title={t('diagnostics.probes')}
            cap="probes"
            actions={
              // 按钮归到它自己那一段：原来它和段标题同名，动作与对象分家。
              <CardButton onClick={() => void probe()} disabled={probing || csrf === null} data-dcss-cap="probe">
                {probing ? t('diagnostics.loading') : t('diagnostics.probe.run')}
              </CardButton>
            }
          >
            {probeError === null ? null : <Notice tone="error">{probeError}</Notice>}
            {shownProbes.length === 0 ? (
              <p className="dcss-hint">{t('diagnostics.report.none')}</p>
            ) : (
              shownProbes.map((entry) => (
                <div key={entry.path} className="dcss-probe">
                  <Badge tone={entry.ok ? 'ok' : 'danger'}>
                    {entry.ok ? t('diagnostics.probe.ok') : t('diagnostics.probe.fail')}
                  </Badge>
                  <span className="dcss-mono">{entry.path}</span>
                  <span className="dcss-hint"> {entry.reason}</span>
                </div>
              ))
            )}
            {probes === null ? <p className="dcss-hint">{t('diagnostics.probe.hint')}</p> : null}
          </Section>

          <Section title={t('diagnostics.report.routes')} cap="routes">
            <p className="dcss-hint">
              {(view.inspected ?? []).length === 0
                ? t('diagnostics.report.none')
                : (view.inspected ?? []).join('\n')}
            </p>
            <FactRow label={t('diagnostics.upstream.baseUrl')}>
              <span className="dcss-mono">{view.baseUrl || '—'}</span>
            </FactRow>
          </Section>

          {/*
            「最近一次错误」默认收起：它只在出问题之后才需要看，却要占 4 行事实。
            折叠后这段从 4 行降到 1 行。
          */}
          <details className="dcss-details" data-dcss-cap="last-error">
            <summary className="dcss-add-summary">
              {view.lastError === undefined
                ? `${t('diagnostics.lastError')} · ${t('diagnostics.noLastError')}`
                : `${t('diagnostics.lastError')} · ${view.lastError.code}`}
            </summary>
            {view.lastError === undefined ? null : (
              <>
                <FactRow label={t('diagnostics.lastError.code')}>{view.lastError.code}</FactRow>
                <FactRow label={t('diagnostics.lastError.path')}>{view.lastError.path}</FactRow>
                <FactRow label={t('diagnostics.lastError.at')}>{formatDateTime(view.lastError.at)}</FactRow>
                <FactRow label={t('diagnostics.lastError.message')}>{view.lastError.message}</FactRow>
              </>
            )}
          </details>
        </>
      ) : null}
    </>
  )
}

/**
 * 一段可以整段粘走的纯文本。
 *
 * 字段与视图一一对应，所以新供应商不需要新增格式化代码 —— 这也正是"诊断报告"
 * 以前只有一家有的原因。
 */
export function formatReport(view: Payload, vendorId: string, t: CardT): string {
  const lines: string[] = [
    t('diagnostics.report.title'),
    `${t('diagnostics.report.vendor')}: ${view.id} (${view.displayName}) [${vendorId}]`,
    `${t('diagnostics.report.generatedAt')}: ${new Date().toISOString()}`,
    '',
    `${t('diagnostics.report.upstream')}: ${view.baseUrl || '—'}`,
  ]
  for (const endpoint of view.endpoints) lines.push(`  ${endpoint.label}: ${endpoint.url}`)
  lines.push('', `${t('diagnostics.report.credential')}:`)
  lines.push(`  sourceOrigin: ${view.credential.sourceOrigin}`)
  lines.push(`  found: ${String(view.credential.found)}`)
  lines.push(`  sourcePath: ${view.credential.sourcePath || '—'}`)
  if (view.credential.problem !== undefined) lines.push(`  problem: ${view.credential.problem}`)
  if (view.credential.expiresAt !== undefined) lines.push(`  expiresAt: ${new Date(view.credential.expiresAt).toISOString()}`)
  for (const candidate of view.credential.candidates) {
    lines.push(`  [${candidate.state}] ${candidate.path}${candidate.reason === '' ? '' : ` — ${candidate.reason}`}`)
  }
  lines.push('', `${t('diagnostics.report.probes')}:`)
  if (view.probes.length === 0) lines.push(`  ${t('diagnostics.report.none')}`)
  for (const probe of view.probes) lines.push(`  ${probe.ok ? 'ok  ' : 'FAIL'} ${probe.path}: ${probe.reason}`)
  lines.push('', `${t('diagnostics.report.routes')}: ${(view.inspected ?? []).join(', ') || '—'}`)
  lines.push(`${t('diagnostics.report.catalog')}: ${view.catalog.enabled}/${view.catalog.total}`)
  if (view.accounts !== null) {
    lines.push(`${t('diagnostics.report.accounts')}: ${view.accounts.healthy}/${view.accounts.total}`)
  }
  if (view.lastError === undefined) {
    lines.push(`${t('diagnostics.report.lastError')}: ${t('diagnostics.report.none')}`)
  } else {
    lines.push(
      `${t('diagnostics.report.lastError')}: ${view.lastError.code} ${view.lastError.message} (${view.lastError.path} @ ${new Date(view.lastError.at).toISOString()})`,
    )
  }
  return lines.join('\n')
}

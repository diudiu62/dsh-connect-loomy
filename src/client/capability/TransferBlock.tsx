/**
 * Portable-credential transfer: export a bundle, paste one back.
 *
 * `capabilities.transfer` is the only thing that decides whether this block
 * exists — the host does not register `/accounts/export` or `/accounts/import`
 * for a vendor that does not declare it, and a UI that offers a button which can
 * only 404 is a support ticket waiting to happen.
 *
 * The bundle **is** the credential, so the block says so before the click
 * (`transfer.exportHint`), copies to the clipboard only when the user pressed the
 * button that names that action, and never logs the payload.
 *
 * 面板显隐的开关在账号段头部的「导出 / 导入」按钮（`AccountPanel` 的
 * `openPanel`），本组件自己没有 `<details>` 也没有 `summary`：按钮按开即可见，
 * 粘贴框自动拿焦点，导出（按钮 + 提示）在上、导入（提示 + 文本框 + 确认）在下，
 * 两个方向各占一行，不互相推挤。
 *
 * @module dsh-connect-desktop/client/capability/TransferBlock
 */

import { useState } from 'react'
import type { AccountExportView, AccountImportView } from '../../shared/views.js'
import { normalizeImportDocument, requestVendor } from '../transport.js'
import { copyToClipboard } from '../clipboard.js'
import { CardButton, Notice } from '../components/common.js'
import type { CardT } from '../components/types.js'
import { transportMessage } from './LoginForms.js'

export interface TransferBlockProps {
  t: CardT
  vendorId: string
  csrf: string | null
  /** Re-read everything that a finished transfer invalidates. */
  onChanged: () => void
  /** `id` narrows the export to one account; omitted exports every account. */
  accountId?: string
}

/** Render the export/import block. */
export function TransferBlock({ t, vendorId, csrf, onChanged, accountId }: TransferBlockProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function exportNow(): Promise<void> {
    if (csrf === null || busy !== null) return
    setBusy('export')
    setNotice(null)
    setError(null)
    const result = await requestVendor<AccountExportView>({
      vendorId,
      suffix: 'accounts/export',
      method: 'POST',
      csrf,
      body: accountId === undefined ? {} : { id: accountId },
    })
    setBusy(null)
    if (result.kind !== 'ok') {
      setError(transportMessage(result, t, t('transfer.failed')) ?? null)
      return
    }
    if (result.value.bundle === undefined) {
      setError(t('transfer.exportEmpty') ?? null)
      return
    }
    const payload = JSON.stringify(result.value.bundle, undefined, 2)
    const copied = await copyToClipboard(payload)
    if (copied) setNotice(t('transfer.exportNotice') ?? null)
    else setNotice(payload ?? null)
  }

  async function importNow(): Promise<void> {
    if (csrf === null || busy !== null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setError(t('transfer.importBadJson') ?? null)
      return
    }
    setBusy('import')
    setNotice(null)
    setError(null)
    const result = await requestVendor<AccountImportView>({
      vendorId,
      suffix: 'accounts/import',
      method: 'POST',
      csrf,
      body: { bundle: normalizeImportDocument(parsed) },
    })
    setBusy(null)
    if (result.kind !== 'ok') {
      setError(transportMessage(result, t, t('transfer.failed')) ?? null)
      return
    }
    setNotice(
      t('transfer.importDone', {
        added: String(result.value.added ?? 0),
        refreshed: String(result.value.refreshed ?? 0),
        skipped: String(result.value.skipped ?? 0),
      }),
    )
    setText('')
    onChanged()
  }

  return (
    <div className="dcss-add-body" data-dcss-cap="transfer">
      {/*
        显隐由账号段头部的「导出 / 导入」按钮负责，块内**不再放第二层折叠**。
        旧版这里是一个 `<details>`：用户按完按钮只看到一行三角，还得再点一次才
        露出粘贴框——两次开关做一件事，而且第一次的落点在列表下面，看起来像没反应。
        现在一次摆平：导出在上，粘贴框在下，粘贴框拿到焦点（⌘V 直接粘）。
      */}
      <div className="dcss-transfer-export">
        <CardButton onClick={() => void exportNow()} disabled={busy !== null || csrf === null}>
          {busy === 'export' ? t('transfer.exporting') : t('transfer.export')}
        </CardButton>
        <p className="dcss-row-note">{t('transfer.exportHint')}</p>
      </div>
      <div className="dcss-transfer-import">
        <p className="dcss-row-note">{t('transfer.pasteHint')}</p>
        <textarea
          className="dcss-textarea"
          placeholder={t('transfer.pastePlaceholder')}
          aria-label={t('transfer.pastePlaceholder')}
          autoFocus
          value={text}
          rows={4}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="dcss-add-foot">
          <span className="dcss-row-note">
            {text.trim().length === 0 ? t('transfer.pasteEmpty') : t('transfer.pasteReady')}
          </span>
          <CardButton
            onClick={() => void importNow()}
            disabled={busy !== null || csrf === null || text.trim().length === 0}
          >
            {busy === 'import' ? t('transfer.importing') : t('transfer.importNow')}
          </CardButton>
        </div>
      </div>
      {notice === null ? null : <Notice tone="ok">{notice}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </div>
  )
}

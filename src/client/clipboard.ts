/**
 * Clipboard helper for the diagnostics report.
 *
 * Prefers the async Clipboard API; falls back to the hidden-textarea trick for
 * hosts that do not expose `navigator.clipboard` (older WebViews, jsdom tests
 * that only exercise the fallback). Returns `false` instead of throwing so the
 * UI can show its own "copy failed" copy.
 *
 * @module dsh-connect-desktop/client/clipboard
 */

/** Copy `text`; resolves to whether the write was accepted. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { clipboard?: { writeText?: (value: string) => Promise<void> } }).clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the DOM fallback; some browsers reject without focus.
    }
  }

  if (typeof document === 'undefined') return false
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

/**
 * Report actions toolbar (Tasks 19/19b; design §9.4).
 *
 * - **复制 Markdown** renders the report through the shared Task 7 renderer and
 *   writes it to the clipboard (the shared renderer is explicitly meant to be
 *   reused by the client copy action; no model/prompt text is involved).
 * - **下载 Markdown** is a same-origin link to `GET /export?job=<id>&format=md`,
 *   so the Host's persisted report (not a client-side reconstruction) is what the
 *   browser downloads.
 * - **下载 JSON** (Task 19b) is the matching `GET /export?job=<id>&format=json`
 *   link; both links carry the report's job id and propose a file name.
 *
 * The copy action reports its own status in an `aria-live` region; the clipboard
 * helper degrades to the legacy `execCommand` path and finally returns `false`
 * instead of throwing, so a denied clipboard permission can never crash the
 * report view.
 */
import { useState } from 'react'
import { defaultTranslate, type Translate } from '../locale'

/** Write text to the system clipboard; resolves to false when unavailable. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      return true
    }
    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const command = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    textarea.remove()
    return command === true
  } catch {
    return false
  }
}

/** Props of {@link ReportToolbar}. */
export interface ReportToolbarProps {
  /** Renders + copies the Markdown report; resolves to success. */
  onCopy?: () => Promise<boolean> | boolean
  /** `href` of the Host Markdown export (`GET /export?job=…&format=md`). */
  exportHref?: string
  /** File name suggested to the browser for the Markdown download. */
  exportFileName?: string
  /** `href` of the Host JSON export (`GET /export?job=…&format=json`). */
  exportJsonHref?: string
  /** File name suggested to the browser for the JSON download. */
  exportJsonFileName?: string
  /** Called when an export link is activated (UI feedback hook). */
  onExport?: () => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the copy/export actions and their status. */
export function ReportToolbar({
  onCopy,
  exportHref,
  exportFileName,
  exportJsonHref,
  exportJsonFileName,
  onExport,
  t = defaultTranslate,
}: ReportToolbarProps) {
  const [copyState, setCopyState] = useState<'idle' | 'working' | 'copied' | 'error'>('idle')

  const handleCopy = async (): Promise<void> => {
    if (onCopy === undefined) return
    setCopyState('working')
    try {
      const ok = await onCopy()
      setCopyState(ok ? 'copied' : 'error')
    } catch {
      setCopyState('error')
    }
  }

  return (
    <div className="lgp-report-toolbar" data-lgp-part="report-toolbar">
      <button
        type="button"
        className="lgp-button"
        onClick={() => void handleCopy()}
        disabled={onCopy === undefined || copyState === 'working'}
      >
        {t('report.copy')}
      </button>
      {exportHref === undefined ? null : (
        <a
          className="lgp-button lgp-report-export"
          href={exportHref}
          download={exportFileName ?? 'report.md'}
          data-lgp-export="md"
          onClick={() => onExport?.()}
        >
          {t('report.export')}
        </a>
      )}
      {exportJsonHref === undefined ? null : (
        <a
          className="lgp-button lgp-report-export"
          href={exportJsonHref}
          download={exportJsonFileName ?? 'report.json'}
          data-lgp-export="json"
          onClick={() => onExport?.()}
        >
          {t('report.exportJson')}
        </a>
      )}
      <span className="lgp-report-toolbar-status" role="status" aria-live="polite">
        {copyState === 'copied'
          ? t('report.copied')
          : copyState === 'error'
            ? t('report.copyFailed')
            : ''}
      </span>
    </div>
  )
}

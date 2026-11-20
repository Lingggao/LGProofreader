/**
 * Panel header (Task 17; design §9.1/§1.4).
 *
 * Left: the compact brand icon (`alt` = plugin name) + Chinese name + the
 * "newspaper page proofreading" subtitle. Right: the current document's file
 * name and the upload/cancel actions. The component is presentational: labels
 * are injected by `App` (locale-bound) and default to the zh dictionary so it
 * can be rendered in isolation.
 */
import { sidebarIcon } from '../assets'
import { defaultTranslate } from '../locale'

/** Props of {@link Header}. */
export interface HeaderProps {
  /** Localized plugin name (`Ling Gao 校对员` / `Ling Gao Proofreader`). */
  name: string
  /** File name (or newspaper/date/edition label) of the open document. */
  documentName?: string
  /** Subtitle under the plugin name. */
  tagline?: string
  /** Upload button label. */
  uploadLabel?: string
  /** Cancel-while-busy button label. */
  cancelLabel?: string
  /** Settings button label (Task 19 renders the drawer). */
  settingsLabel?: string
  /** True while an upload/parse/analyze flow is running. */
  busy?: boolean
  /** Opens the PDF picker. */
  onUpload: () => void
  /** Aborts the running flow (only rendered while `busy`). */
  onCancel?: () => void
  /** Opens the settings drawer (only rendered when provided). */
  onSettings?: () => void
}

/** Render the panel header. */
export function Header({
  name,
  documentName,
  tagline = defaultTranslate('subtitle'),
  uploadLabel = defaultTranslate('header.upload'),
  cancelLabel = defaultTranslate('header.cancel'),
  settingsLabel = defaultTranslate('header.settings'),
  busy = false,
  onUpload,
  onCancel,
  onSettings,
}: HeaderProps) {
  return (
    <header className="lgp-header" data-lgp-part="header">
      <div className="lgp-brand">
        <img
          className="lgp-header-icon"
          src={sidebarIcon}
          alt={name}
          width={20}
          height={20}
          draggable={false}
        />
        <div className="lgp-brand-text">
          <span className="lgp-header-name">{name}</span>
          <span className="lgp-header-tagline">{tagline}</span>
        </div>
      </div>
      {documentName !== undefined && documentName !== '' ? (
        <span className="lgp-header-document" title={documentName}>
          {documentName}
        </span>
      ) : (
        <span className="lgp-header-document" />
      )}
      <div className="lgp-header-actions">
        {busy && onCancel !== undefined ? (
          <button type="button" className="lgp-button lgp-button--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="lgp-button lgp-button--primary"
          onClick={onUpload}
          disabled={busy}
        >
          {uploadLabel}
        </button>
        {onSettings !== undefined ? (
          <button
            type="button"
            className="lgp-button lgp-button--ghost"
            onClick={onSettings}
            aria-label={settingsLabel}
          >
            {settingsLabel}
          </button>
        ) : null}
      </div>
    </header>
  )
}

/**
 * Welcome / empty state (Task 17; design §9.2).
 *
 * Full wordmark (light + dark variants, switched by the DSH theme attribute via
 * `styles.ts`), the plugin name, one explanatory sentence, the PDF drop zone and
 * an inline validation error. Prompt text never appears here (design §1.4: the
 * Prompt Library is Host-only).
 *
 * The component stays presentational: `App` owns the file picker and the upload
 * flow, so `onUpload` opens the picker and `onFiles` forwards dropped files.
 */
import { useState, type DragEvent } from 'react'
import { wordmarkDark, wordmarkLight } from '../assets'
import { defaultTranslate } from '../locale'

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** Localized plugin name. */
  name: string
  /** Opens the PDF picker. */
  onUpload: () => void
  /** Receives files dropped onto the drop zone. */
  onFiles?: (files: File[]) => void
  /** One-sentence product explanation. */
  lead?: string
  /** Drop-zone hint. */
  dropHint?: string
  /** Drop-zone button label. */
  chooseLabel?: string
  /** File constraints hint (single page, 150 MB). */
  constraints?: string
  /** Accessible name of the drop zone (localized by `App`). */
  dropzoneLabel?: string
  /** Inline validation/upload error, already localized by `App`. */
  error?: string | null
  /** True while an upload/parse/analyze flow is already running. */
  busy?: boolean
}

/** Render the welcome screen shown before any document is open. */
export function EmptyState({
  name,
  onUpload,
  onFiles,
  lead = defaultTranslate('empty.lead'),
  dropHint = defaultTranslate('empty.dropHint'),
  chooseLabel = defaultTranslate('empty.choose'),
  constraints = defaultTranslate('empty.constraints'),
  dropzoneLabel = defaultTranslate('a11y.dropzone'),
  error,
  busy = false,
}: EmptyStateProps) {
  const [dragging, setDragging] = useState(false)

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (): void => {
    setDragging(false)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const files = event.dataTransfer?.files
    if (files === undefined || files.length === 0) return
    onFiles?.(Array.from(files))
  }

  return (
    <section className="lgp-empty" data-lgp-part="empty" aria-label={name}>
      <div className="lgp-wordmark">
        <img
          className="lgp-wordmark-image lgp-wordmark--light"
          src={wordmarkLight}
          alt={name}
        />
        <img
          className="lgp-wordmark-image lgp-wordmark--dark"
          src={wordmarkDark}
          alt=""
          aria-hidden="true"
        />
      </div>
      <h1 className="lgp-empty-name">{name}</h1>
      <p className="lgp-empty-lead">{lead}</p>
      <div
        className="lgp-dropzone"
        data-dragging={dragging ? 'true' : 'false'}
        role="group"
        aria-label={dropzoneLabel}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <p className="lgp-drop-hint">{dropHint}</p>
        <button
          type="button"
          className="lgp-button lgp-button--primary"
          onClick={onUpload}
          disabled={busy}
        >
          {chooseLabel}
        </button>
        <p className="lgp-empty-hint">{constraints}</p>
      </div>
      {error !== undefined && error !== null && error !== '' ? (
        <p className="lgp-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

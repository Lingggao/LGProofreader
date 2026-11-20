/**
 * Recent-documents rail (Task 17; design §9.2).
 *
 * Lists this session's documents (the Host API has no document-list route yet,
 * so the rail is fed from the session's upload/open results) with their
 * newspaper/date/edition title and status, and offers the upload action. Row
 * click re-opens a document through `App`.
 */
import { defaultTranslate } from '../locale'
import type { DocumentMeta, DocumentSummary } from '../../shared/types'

/** Props of {@link DocumentRail}. */
export interface DocumentRailProps {
  /** Documents already known to this session, newest first. */
  documents: DocumentSummary[]
  /** Id of the document currently open in the workbench. */
  activeId?: string
  /** Opens a document. */
  onOpen: (id: string) => void
  /** Opens the PDF picker. */
  onUpload: () => void
  /**
   * True while a transfer owns the workbench: every row (including the upload
   * action) is disabled so the panel cannot switch documents mid-parse/analyze.
   */
  busy?: boolean
  /** Rail heading. */
  title?: string
  /** Shown when no document exists yet. */
  emptyLabel?: string
  /** Upload button label. */
  uploadLabel?: string
  /** Collapses the rail to a narrow strip so the PDF preview can grow. */
  collapsed?: boolean
  /** Toggles {@link collapsed}. */
  onToggleCollapsed?: () => void
  /** Accessible label for the collapse control. */
  collapseLabel?: string
  /** Accessible label for the expand control. */
  expandLabel?: string
  /** Localized status labels (default zh). */
  statusLabels?: Partial<Record<DocumentMeta['status'], string>>
}

/** Newspaper/date/edition title, falling back to the stored file name. */
export function documentTitle(meta: DocumentMeta): string {
  const parts = [meta.newspaper, meta.date, meta.edition].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  return parts.length === 0 ? meta.fileName : parts.join(' · ')
}

/** Render the left document rail. */
export function DocumentRail({
  documents,
  activeId,
  onOpen,
  onUpload,
  busy = false,
  title = defaultTranslate('rail.title'),
  emptyLabel = defaultTranslate('rail.empty'),
  uploadLabel = defaultTranslate('rail.upload'),
  collapsed = false,
  onToggleCollapsed,
  collapseLabel = defaultTranslate('rail.collapse'),
  expandLabel = defaultTranslate('rail.expand'),
  statusLabels,
}: DocumentRailProps) {
  const labels: Record<DocumentMeta['status'], string> = {
    parsing: statusLabels?.parsing ?? defaultTranslate('rail.status.parsing'),
    ready: statusLabels?.ready ?? defaultTranslate('rail.status.ready'),
    failed: statusLabels?.failed ?? defaultTranslate('rail.status.failed'),
  }

  return (
    <nav
      className={collapsed ? 'lgp-rail lgp-rail--collapsed' : 'lgp-rail'}
      data-lgp-part="document-rail"
      data-lgp-collapsed={collapsed ? 'true' : 'false'}
      aria-label={title}
      aria-busy={busy ? 'true' : undefined}
    >
      {collapsed ? (
        <button
          type="button"
          className="lgp-button lgp-button--ghost lgp-rail-expand"
          aria-label={expandLabel}
          title={expandLabel}
          aria-expanded="false"
          aria-controls="lgp-document-rail-content"
          disabled={busy}
          onClick={onToggleCollapsed}
        >
          »
        </button>
      ) : (
        <div id="lgp-document-rail-content" className="lgp-rail-content">
          <div className="lgp-rail-head">
            <span className="lgp-rail-title">{title}</span>
            <button
              type="button"
              className="lgp-button lgp-button--ghost lgp-rail-collapse"
              aria-label={collapseLabel}
              title={collapseLabel}
              aria-expanded="true"
              aria-controls="lgp-document-rail-content"
              disabled={busy}
              onClick={onToggleCollapsed}
            >
              «
            </button>
            <button
              type="button"
              className="lgp-button lgp-button--ghost"
              onClick={onUpload}
              disabled={busy}
            >
              {uploadLabel}
            </button>
          </div>
          {documents.length === 0 ? (
            <p className="lgp-rail-empty">{emptyLabel}</p>
          ) : (
            <div className="lgp-rail-list">
              {documents.map((item) => {
                const label = documentTitle(item.meta)
                const active = item.meta.id === activeId
                return (
                  <button
                    key={item.meta.id}
                    type="button"
                    className="lgp-rail-item"
                    aria-current={active ? 'true' : undefined}
                    title={label}
                    disabled={busy}
                    onClick={() => onOpen(item.meta.id)}
                  >
                    <span className="lgp-rail-item-title">{label}</span>
                    <span className="lgp-rail-item-meta">{labels[item.meta.status]}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </nav>
  )
}

/**
 * Workbench state reducer (Task 17; design §9.3).
 *
 * The panel keeps one durable state machine in `ClientState`; transient
 * transport details (upload ratio, current parse stage) stay in `App` local
 * state because they are not part of the workbench model.
 *
 * Binding rules:
 * - **No auto-selection**: `documentLoaded`/`layoutLoaded` always leave
 *   `selectedArticleIds` untouched/empty; proofreading only starts from an
 *   explicit user selection (design §9.4);
 * - the phase machine is `empty → analyzing → ready → proofreading → report`,
 *   with `failed` reachable from in-flight phases;
 * - the reducer is pure: every action returns a new state and mutates neither
 *   the previous state nor its collections.
 */
import type { JobView } from '../../shared/api/protocol'
import type { Article, ArticleId, DocumentMeta, Region, Report } from '../../shared/types'

/** Durable workbench phase (design §9.3). */
export type WorkbenchPhase =
  | 'empty'
  | 'uploading'
  | 'parsing'
  | 'analyzing'
  | 'ready'
  | 'proofreading'
  | 'report'
  | 'failed'

/** Everything the panel's React tree renders from. */
export interface ClientState {
  phase: WorkbenchPhase
  document: DocumentMeta | null
  regions: Region[]
  articles: Article[]
  /** Explicitly selected articles; never populated automatically. */
  selectedArticleIds: ArticleId[]
  /** Warnings from the layout job (low-confidence regions, continuation hints). */
  warnings: string[]
  job: JobView | null
  report: Report | null
  error: string | null
}

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */
/* ------------------------------------------------------------------------- */

/** A document was opened/uploaded; `articles` may still be empty while parsing. */
export interface DocumentLoadedAction {
  type: 'documentLoaded'
  document: DocumentMeta
  articles?: Article[]
  regions?: Region[]
  warnings?: string[]
}

/** The layout job finished (or an edited layout was saved). */
export interface LayoutLoadedAction {
  type: 'layoutLoaded'
  articles: Article[]
  regions?: Region[]
  warnings?: string[]
}

/** The user toggled articles (Task 18 UI); ids are stored verbatim. */
export interface SelectionChangedAction {
  type: 'selectionChanged'
  ids: ArticleId[]
}

/** A polled job snapshot. */
export interface JobUpdatedAction {
  type: 'jobUpdated'
  job: JobView
}

/** A finished proofreading report arrived. */
export interface ReportLoadedAction {
  type: 'reportLoaded'
  report: Report
}

/** A user-facing error message. */
export interface ErrorSetAction {
  type: 'errorSet'
  error: string
}

/** A running proofread job ended in a failure/malformed result (not a cancel). */
export interface ProofreadFailedAction {
  type: 'proofreadFailed'
}

/** Back to the empty workbench. */
export interface ResetAction {
  type: 'reset'
}

/** Every action the panel dispatches. */
export type ClientAction =
  | DocumentLoadedAction
  | LayoutLoadedAction
  | SelectionChangedAction
  | JobUpdatedAction
  | ReportLoadedAction
  | ProofreadFailedAction
  | ErrorSetAction
  | ResetAction

/* ------------------------------------------------------------------------- */
/* Initial state                                                              */
/* ------------------------------------------------------------------------- */

/** A fresh, empty workbench. */
export function createInitialState(): ClientState {
  return {
    phase: 'empty',
    document: null,
    regions: [],
    articles: [],
    selectedArticleIds: [],
    warnings: [],
    job: null,
    report: null,
    error: null,
  }
}

/* ------------------------------------------------------------------------- */
/* Reducer                                                                    */
/* ------------------------------------------------------------------------- */

/** Durable phase implied by a document's own persisted status. */
function phaseForDocument(document: DocumentMeta): WorkbenchPhase {
  if (document.status === 'parsing') return 'analyzing'
  if (document.status === 'failed') return 'failed'
  return 'ready'
}

/** Deduplicate article ids, dropping empty values (selection order is kept). */
function uniqueArticleIds(ids: readonly ArticleId[]): ArticleId[] {
  const seen = new Set<ArticleId>()
  const unique: ArticleId[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return unique
}

/** Phase implied by a job snapshot; `undefined` keeps the current phase. */
function phaseForJob(job: JobView, current: ClientState): WorkbenchPhase {
  const active = job.status === 'queued' || job.status === 'running'
  if (job.kind === 'layout') {
    if (active) return 'analyzing'
    if (job.status === 'failed') return 'failed'
    if (job.status === 'cancelled') return current.document === null ? 'empty' : 'ready'
    return 'ready'
  }
  if (active) return 'proofreading'
  if (job.status === 'failed') return 'failed'
  if (job.status === 'cancelled') return 'ready'
  return 'report'
}

/**
 * Apply one action to the workbench state.
 *
 * The action list is the panel's whole mutation surface; everything else is
 * derived (article counts, placeholder hints) or kept as App-local transport
 * detail.
 */
export function reduce(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case 'documentLoaded': {
      return {
        phase: phaseForDocument(action.document),
        document: action.document,
        regions: action.regions === undefined ? [] : [...action.regions],
        articles: action.articles === undefined ? [] : [...action.articles],
        // Design §9.4: loading a document never selects an article.
        selectedArticleIds: [],
        warnings: action.warnings === undefined ? [] : [...action.warnings],
        job: null,
        report: null,
        error: null,
      }
    }
    case 'layoutLoaded': {
      return {
        ...state,
        phase: 'ready',
        regions: action.regions === undefined ? state.regions : [...action.regions],
        articles: [...action.articles],
        warnings: action.warnings === undefined ? state.warnings : [...action.warnings],
        document:
          state.document === null ? null : { ...state.document, status: 'ready' as const },
        error: null,
      }
    }
    case 'selectionChanged': {
      return { ...state, selectedArticleIds: uniqueArticleIds(action.ids) }
    }
    case 'jobUpdated': {
      const phase = phaseForJob(action.job, state)
      const failed = phase === 'failed'
      return {
        ...state,
        job: action.job,
        phase,
        error: failed ? (action.job.error ?? state.error) : state.error,
      }
    }
    case 'reportLoaded': {
      return { ...state, report: action.report, phase: 'report', error: null }
    }
    case 'proofreadFailed': {
      // A failed proofread must not throw away the document or fall through to
      // the upload error panel: the workbench stays usable and the panel shows
      // the proofread-specific error with its own retry action. A previous
      // successful report (if any) stays visible as the last good result.
      const phase: WorkbenchPhase =
        state.document === null ? 'empty' : state.report === null ? 'ready' : 'report'
      return { ...state, phase, job: null, error: null }
    }
    case 'errorSet': {
      return {
        ...state,
        error: action.error,
        // Keep the inline upload picker available when nothing was opened yet.
        phase: state.document === null ? 'empty' : 'failed',
      }
    }
    case 'reset': {
      return createInitialState()
    }
    default: {
      // The action union is exhaustive; keep a defensive branch for JS callers.
      return state
    }
  }
}

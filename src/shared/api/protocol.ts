/**
 * Shared HTTP protocol for the Ling Gao 校对员 plugin (design §10.2).
 *
 * The Host registers the routes through `ctx.connection.fetch.register()` with
 * **exact paths** under `/api/lgproofreader` (no `:id` dynamic segments: ids
 * travel in the query string or the JSON body). This module is the single
 * source of truth for those paths and for the request/response shapes exchanged
 * with the Client; both sides import it, so it stays free of Node.js, React and
 * DeepSeek Harness imports.
 *
 * Only the Host may read prompt text: nothing here (or in any response type)
 * carries prompt content, only the opaque prompt `version` hash.
 */
import type {
  Article,
  ArticleId,
  Depth,
  DocId,
  DocumentMeta,
  DocumentRecord,
  FactCheckProgress,
  JobId,
  NounProgress,
  PageTextInput,
  Region,
  RoleId,
  StageState,
} from '../types'

/* ------------------------------------------------------------------------- */
/* Routes                                                                      */
/* ------------------------------------------------------------------------- */

/** Prefix of every route registered by the plugin. */
export const API_PREFIX = '/api/lgproofreader' as const

/**
 * Exact route paths, keyed by handler name.
 *
 * Note that `pageImage` (POST upload) and `pageImageGet` (GET) deliberately
 * share one path: the transport only allows GET/HEAD/POST, so the method
 * distinguishes reading the stored page image from uploading it.
 */
export const API_PATHS = {
  uploadDocument: `${API_PREFIX}/documents`,
  pageText: `${API_PREFIX}/page-text`,
  pageImage: `${API_PREFIX}/page-image`,
  pageOverlay: `${API_PREFIX}/page-overlay`,
  analyze: `${API_PREFIX}/analyze`,
  document: `${API_PREFIX}/document`,
  layout: `${API_PREFIX}/layout`,
  pageImageGet: `${API_PREFIX}/page-image`,
  proofread: `${API_PREFIX}/proofread`,
  job: `${API_PREFIX}/job`,
  cancel: `${API_PREFIX}/cancel`,
  deleteDoc: `${API_PREFIX}/delete`,
  meta: `${API_PREFIX}/meta`,
  settingsGet: `${API_PREFIX}/settings`,
  settingsPost: `${API_PREFIX}/settings`,
  exportReport: `${API_PREFIX}/export`,
  health: `${API_PREFIX}/health`,
} as const

/** Query-string parameter names used by the exact-path routes. */
export const QUERY_PARAMS = {
  doc: 'doc',
  job: 'job',
  format: 'format',
} as const

/** Request headers that are part of the contract (not browser-fetch metadata). */
export const REQUEST_HEADERS = {
  /** Client-reported page count of the uploaded PDF; must be `'1'` in v1. */
  pageCount: 'x-page-count',
  /** `encodeURIComponent(file.name)` of the uploaded PDF (optional). */
  fileName: 'x-file-name',
} as const

/** Every handler the API exposes (the `connection.fetch` route table reuses it). */
export type HandlerName = keyof typeof API_PATHS

/** The complete handler surface returned by `createHandlers()` (Task 14). */
export type PluginHandlers = Record<HandlerName, (request: Request) => Promise<Response>>

/* ------------------------------------------------------------------------- */
/* Errors                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Machine-readable error code of the `{ error: { code, message } }` envelope
 * (design §10.2: every handler validates its request and returns this shape).
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unprocessable_entity'
  | 'internal_error'

/** Error body shared by every non-2xx JSON response. */
export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode
    message: string
  }
}

/* ------------------------------------------------------------------------- */
/* Shared views                                                                */
/* ------------------------------------------------------------------------- */

/** Limits reported by `/meta` (design §11.1). */
export interface MetaLimits {
  maxUploadBytes: number
  maxImageBytes: number
  maxJsonBytes: number
  /** v1: exactly one page per document. */
  maxPages: number
}

/** One selectable model of the `/meta` catalogue (id/name only). */
export interface ModelCatalogueModel {
  id: string
  name?: string
}

/** One provider and its selectable models in the `/meta` catalogue. */
export interface ModelCatalogueProvider {
  id: string
  title?: string
  models: ModelCatalogueModel[]
}

/**
 * Provider/model catalogue exposed by `/meta` (design §11.2: the Settings UI
 * lists selectable models from `/meta`). Only ids/titles/names are carried:
 * credentials, endpoints, API keys and pricing internals are never included.
 */
export type ModelCatalogue = ModelCatalogueProvider[]

/** `GET /meta`: version / effective model / prompt version / limits / catalogue. */
export interface MetaView {
  version: string
  model: { provider: string; model: string }
  promptVersion: string
  limits: MetaLimits
  /** Selectable providers/models for the Settings UI; empty when unknown. */
  modelCatalogue: ModelCatalogue
}

/** `GET /health`. */
export interface HealthView {
  ok: true
  version: string
}

/**
 * Response of the small mutating routes (`page-text`, `page-image`, `layout`,
 * `settings`, `cancel`, `delete`): an explicit `{ ok }` acknowledgement.
 */
export interface OkResponse {
  ok: boolean
}

/** `GET /document`: the parsed page, saved layout/articles and report ids. */
export interface DocumentView extends DocumentRecord {
  /** True when both `layout.json` and `articles.json` exist and parse. */
  hasLayout: boolean
}

/** `GET /job`: one background job snapshot (structurally the orchestrator's `JobState`). */
export interface JobView {
  id: JobId
  kind: 'layout' | 'proofread'
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  /** Completed stages / total stages, in `[0, 1]`. */
  progress: number
  stages: StageState[]
  /** Live network fact-check plan/progress while the facts role is running. */
  factProgress?: FactCheckProgress
  /** Live network noun-check plan/progress while the independent nouns role runs. */
  nounProgress?: NounProgress
  /** Layout: assembled layout; proofread: the final `Report`. */
  result?: unknown
  error?: string
}

/**
 * `GET /settings` body. Mirrors the Host `Settings` shape (design §11.2)
 * structurally so the shared protocol never imports Host-only modules.
 */
export interface SettingsView {
  provider: string
  model: string
  reasoningEffort: string
  depth: Depth
  factCheck: boolean
  maxConcurrentWorkers: number
  perCallTimeoutMs: number
  maxClaimsPerArticle: number
  maxSearchQueriesPerArticle: number
  searchResultsPerClaim: number
  fetchPagesPerClaim: number
  includeHeaderFooter: boolean
}

/** `POST /settings` body: a partial update merged over the persisted settings. */
export type SettingsPatch = Partial<SettingsView>

/* ------------------------------------------------------------------------- */
/* Request bodies                                                              */
/* ------------------------------------------------------------------------- */

/** `POST /page-text?doc=<id>` body (design §10.1 `PageTextInput`). */
export type PageTextRequest = PageTextInput

/** `POST /layout` body: manually corrected regions and articles. */
export interface LayoutRequest {
  docId: DocId
  regions: Region[]
  articles: Article[]
}

/** `POST /analyze` body. `force` restarts analysis even when a layout exists. */
export interface AnalyzeRequest {
  docId: DocId
  force?: boolean
}

/** `POST /proofread` body. `roles` is an optional hint; v1 derives roles from `depth`. */
export interface ProofreadRequest {
  docId: DocId
  articleIds: ArticleId[]
  depth: Depth
  /** Network fact checking; defaults to on (design §11.2). */
  factCheck?: boolean
  roles?: RoleId[]
}

/** `POST /cancel` body. */
export interface CancelRequest {
  jobId: JobId
}

/** `POST /delete` body. */
export interface DeleteRequest {
  docId: DocId
}

/* ------------------------------------------------------------------------- */
/* Response bodies                                                             */
/* ------------------------------------------------------------------------- */

/**
 * `POST /documents` response. `pages` is the number of pages stored for the
 * document (always 1 in v1, kept for forward compatibility).
 */
export interface UploadDocumentResponse {
  document: DocumentMeta
  pages: number
}

/** `POST /analyze` response: the background layout job id. */
export interface AnalyzeResponse {
  jobId: JobId
}

/** `POST /proofread` response: the background proofreading job id. */
export interface ProofreadResponse {
  jobId: JobId
}

/** `GET /export?job=<id>&format=md|json` supported formats (default `md`). */
export type ExportFormat = 'md' | 'json'

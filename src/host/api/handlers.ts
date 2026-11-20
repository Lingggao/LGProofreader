/**
 * Host API handlers for the Ling Gao 校对员 plugin (Task 14; design §10.2).
 *
 * `createHandlers(deps)` returns one `(request: Request) => Promise<Response>`
 * function per exact route. The `connection.fetch` carrier has already
 * authenticated the browser session and dispatched by method/path, so these
 * handlers contain **no auth checks** and no routing: they validate the request
 * (content type, body cap, ids, JSON shape), call exactly one injected
 * dependency, and serialize the documented response.
 *
 * Guarantees pinned by `tests/host/api.test.ts`:
 * - validation and error codes: 400 (bad request), 404 (unknown document/job/
 *   report), 413 (body cap), 415 (content type), 422 (multipage PDF, non-PDF
 *   bytes, non-PNG image), 500 (internal, generic message);
 * - upload accepts exactly one page: the client's `x-page-count` header and the
 *   raw-bytes scan ({@link countPdfPages}) are both enforced;
 * - `delete` cancels every job this API started for the document **before**
 *   `store.delete`, so a running job can never recreate files after deletion;
 * - an analyze start failure marks the document `failed` via `store.updateMeta`;
 * - an unknown/malformed orchestrator result never reaches the client;
 * - no handler reads prompt text: responses carry only the prompt version hash,
 *   and the 500 message is always the generic `internal error`.
 *
 * Host-only module; Node.js built-ins only.
 */
import type {
  Article,
  ArticleId,
  Depth,
  PageTextInput,
  Region,
  RoleId,
} from '../../shared/types'
import { renderReportMarkdown } from '../../shared/report/markdown'
import {
  QUERY_PARAMS,
  REQUEST_HEADERS,
  type DocumentView,
  type ExportFormat,
  type JobView,
  type MetaView,
  type ModelCatalogue,
  type ModelCatalogueModel,
  type ModelCatalogueProvider,
  type PluginHandlers,
  type SettingsView,
  type UploadDocumentResponse,
} from '../../shared/api/protocol'
import type { JobOrchestrator } from '../proof/orchestrator'
import {
  DOC_ID_PATTERN,
  DocumentNotFoundError,
  InvalidDocumentIdError,
  InvalidJobIdError,
  JOB_ID_PATTERN,
  type DocumentStore,
} from '../services/store'
import { SettingsValidationError } from '../services/settings'
import { countPdfPages } from '../pdf/page-count'
import {
  ApiRequestError,
  binaryResponse,
  errorResponse,
  fail,
  jsonResponse,
  readBoundedBody,
  readJson,
  requireContentType,
} from './http'

/* ------------------------------------------------------------------------- */
/* Constants                                                                   */
/* ------------------------------------------------------------------------- */

/** v1 accepts exactly one page per document (design §10.2). */
const REQUIRED_PAGE_COUNT = 1

/** Default JSON body cap; Task 15's config can override it via `limits`. */
export const DEFAULT_MAX_JSON_BYTES = 20 * 1024 * 1024

const DEFAULT_FILE_NAME = 'document.pdf'
const MAX_FILE_NAME_HEADER_LENGTH = 2048
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8'
const PNG_CONTENT_TYPE = 'image/png'
const PDF_MEDIA_TYPES = ['application/pdf', 'application/octet-stream'] as const
const PNG_MEDIA_TYPES = [PNG_CONTENT_TYPE] as const

/** `%PDF-` file header (design §6.1: PDF file header validation). */
const PDF_HEADER_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d] as const
/** PNG signature (ISO/IEC 15948 §5.2). */
const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

const ROLE_IDS: ReadonlySet<string> = new Set([
  'master',
  'words',
  'idioms',
  'style',
  'facts',
  'headline',
  'consistency',
  'consolidator',
])

/* ------------------------------------------------------------------------- */
/* Dependency contract                                                         */
/* ------------------------------------------------------------------------- */

/** Limits supplied by the Host entry point (design §11.1). */
export interface HandlerLimits {
  maxUploadBytes: number
  maxImageBytes: number
  /** JSON body cap; defaults to {@link DEFAULT_MAX_JSON_BYTES}. */
  maxJsonBytes?: number
}

/** Everything the handlers need; wired once in `src/host/index.ts` (Task 15). */
export interface HandlerDeps {
  store: DocumentStore
  orchestrator: JobOrchestrator
  limits: HandlerLimits
  /** Plugin version reported by `/health` and `/meta`. */
  version: string
  /** Effective model route reported by `/meta` (selection resolved by Task 15). */
  model: { provider: string; model: string }
  /** Prompt library version hash reported by `/meta`; never prompt text. */
  promptVersion: string
  /**
   * Optional provider/model catalogue for the Settings UI (design §11.2).
   *
   * Task 15 supplies it from `ctx.llm.listProviders()` / `listModels()`; the
   * handler never calls `ctx.llm` itself. A plain array or a sync/async factory
   * is accepted so the Host can resolve the catalogue lazily. Only provider
   * `id`/`title` and model `id`/`name` are sent to the browser (credentials,
   * endpoints, API keys and pricing internals are stripped by the handler).
   */
  modelCatalogue?: ModelCatalogueSource
}

/** Source of the `/meta` provider/model catalogue (value or lazy factory). */
export type ModelCatalogueSource =
  | ModelCatalogue
  | (() => ModelCatalogue | Promise<ModelCatalogue>)

/** One route handler. */
type Handler = (request: Request) => Promise<Response>

/* ------------------------------------------------------------------------- */
/* Factory                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Create the 17 exact-route handlers. All validation is performed here (and
 * hardened by the store/orchestrator), so the route layer can stay a plain
 * method/path table.
 */
export function createHandlers(deps: HandlerDeps): PluginHandlers {
  const store = deps.store
  const orchestrator = deps.orchestrator

  const maxUploadBytes = positiveInteger('limits.maxUploadBytes', deps.limits?.maxUploadBytes)
  const maxImageBytes = positiveInteger('limits.maxImageBytes', deps.limits?.maxImageBytes)
  const maxJsonBytes =
    deps.limits?.maxJsonBytes === undefined
      ? DEFAULT_MAX_JSON_BYTES
      : positiveInteger('limits.maxJsonBytes', deps.limits.maxJsonBytes)

  if (typeof deps.version !== 'string' || deps.version.trim() === '') {
    throw new TypeError('createHandlers() requires a non-empty version')
  }
  if (
    typeof deps.model?.provider !== 'string' ||
    typeof deps.model?.model !== 'string'
  ) {
    throw new TypeError('createHandlers() requires model.provider and model.model strings')
  }
  if (typeof deps.promptVersion !== 'string' || deps.promptVersion.trim() === '') {
    throw new TypeError('createHandlers() requires a non-empty promptVersion')
  }
  const version = deps.version
  const promptVersion = deps.promptVersion
  const model = { provider: deps.model.provider, model: deps.model.model }

  /** Resolve the optional `/meta` catalogue; empty when the Host did not supply one. */
  async function readModelCatalogue(): Promise<ModelCatalogue> {
    const source = deps.modelCatalogue
    if (source === undefined) return []
    const resolved = typeof source === 'function' ? await source() : source
    return normalizeModelCatalogue(resolved)
  }

  /**
   * Job ids started through this API, grouped by document. The orchestrator
   * seam has no "jobs of a document" query, so the API remembers what it
   * started; `deleteDoc` cancels these before removing the document directory.
   */
  const startedJobs = new Map<string, Set<string>>()

  function rememberJob(docId: string, jobId: string): void {
    const jobIds = startedJobs.get(docId) ?? new Set<string>()
    jobIds.add(jobId)
    startedJobs.set(docId, jobIds)
  }

  function cancelDocumentJobs(docId: string): void {
    const jobIds = startedJobs.get(docId)
    if (jobIds === undefined) return
    startedJobs.delete(docId)
    for (const jobId of jobIds) {
      try {
        orchestrator.cancel(jobId)
      } catch {
        // Deleting the document must proceed even if a job is misbehaving.
      }
    }
  }

  /** Best-effort `meta.status = failed`; never hides the original failure. */
  async function markDocumentFailed(docId: string): Promise<void> {
    try {
      await store.updateMeta(docId, { status: 'failed' })
    } catch {
      // The analyze call's own error is the primary failure.
    }
  }

  /** Validate the job id returned by the orchestrator and remember it. */
  function trackJob(docId: string, jobId: unknown): string {
    if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
      throw new Error('internal error: orchestrator returned an invalid job id')
    }
    rememberJob(docId, jobId)
    return jobId
  }

  /**
   * Start a layout job. A synchronous start failure marks the document `failed`
   * (design: analyze failure must never leave the meta in `parsing`); request
   * validation errors (`ApiRequestError`) do not change the meta.
   */
  async function startLayoutJob(docId: string): Promise<string> {
    try {
      return trackJob(docId, await orchestrator.startLayout({ docId }))
    } catch (error) {
      if (!(error instanceof ApiRequestError)) await markDocumentFailed(docId)
      throw error
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Upload and page data                                                    */
  /* ----------------------------------------------------------------------- */

  const uploadDocument: Handler = async (request) => {
    requireContentType(request, PDF_MEDIA_TYPES)
    const declaredPages = readDeclaredPageCount(request)
    if (declaredPages !== undefined && declaredPages !== REQUIRED_PAGE_COUNT) {
      fail(422, 'unprocessable_entity', singlePageMessage(declaredPages))
    }

    const pdfBytes = await readBoundedBody(request, maxUploadBytes)
    if (pdfBytes.byteLength === 0) fail(400, 'bad_request', 'request body is empty')
    if (!hasPdfHeader(pdfBytes)) {
      fail(422, 'unprocessable_entity', 'request body is not a PDF file (missing %PDF- header)')
    }
    const detectedPages = countPdfPages(pdfBytes)
    if (detectedPages > REQUIRED_PAGE_COUNT) {
      fail(422, 'unprocessable_entity', singlePageMessage(detectedPages))
    }

    const meta = await store.create({ fileName: readUploadFileName(request), pdfBytes })
    const payload: UploadDocumentResponse = { document: meta, pages: meta.pageCount }
    return jsonResponse(payload, 201)
  }

  const pageText: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    const docId = requireDocIdQuery(request)
    await store.savePageText(docId, requirePageTextInput(body))
    return jsonResponse({ ok: true })
  }

  /** Shared POST /page-image and POST /page-overlay implementation. */
  function pageImageUpload(
    save: (docId: string, png: Uint8Array) => Promise<void>,
  ): Handler {
    return async (request) => {
      requireContentType(request, PNG_MEDIA_TYPES)
      const docId = requireDocIdQuery(request)
      const png = await readBoundedBody(request, maxImageBytes)
      if (png.byteLength === 0) fail(400, 'bad_request', 'request body is empty')
      if (!hasPngSignature(png)) {
        fail(422, 'unprocessable_entity', 'request body is not a PNG image')
      }
      await save(docId, png)
      return jsonResponse({ ok: true })
    }
  }

  const pageImage = pageImageUpload((docId, png) => store.savePageImage(docId, png))
  const pageOverlay = pageImageUpload((docId, png) => store.savePageOverlay(docId, png))

  /* ----------------------------------------------------------------------- */
  /* Jobs                                                                    */
  /* ----------------------------------------------------------------------- */

  const analyze: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    const docId = requireDocId(body.docId)
    if ('force' in body && typeof body.force !== 'boolean') {
      fail(400, 'bad_request', 'force must be a boolean')
    }
    const jobId = await startLayoutJob(docId)
    return jsonResponse({ jobId }, 202)
  }

  const proofread: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    const docId = requireDocId(body.docId)
    const articleIds = requireArticleIds(body.articleIds)
    const depth = requireDepth(body.depth)
    const factCheck = 'factCheck' in body ? requireBoolean('factCheck', body.factCheck) : true
    // `roles` is accepted for forward compatibility; v1 derives the role set
    // from `depth` (design §7.5) and the orchestrator seam has no override.
    if ('roles' in body) requireRoles(body.roles)
    const jobId = trackJob(docId, await orchestrator.startProofread({ docId, articleIds, depth, factCheck }))
    return jsonResponse({ jobId }, 202)
  }

  const job: Handler = async (request) => {
    const jobId = requireJobIdQuery(request)
    const state = orchestrator.get(jobId)
    if (state === undefined) fail(404, 'not_found', `job not found: ${jobId}`)
    const view: JobView = state
    return jsonResponse(view)
  }

  const cancel: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    const jobId = requireJobId(body.jobId)
    if (orchestrator.get(jobId) === undefined) fail(404, 'not_found', `job not found: ${jobId}`)
    return jsonResponse({ ok: orchestrator.cancel(jobId) })
  }

  const deleteDoc: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    const docId = requireDocId(body.docId)
    // Cancel first: a running job must not recreate files under the document
    // directory after it has been deleted.
    cancelDocumentJobs(docId)
    const deleted = await store.delete(docId)
    if (!deleted) fail(404, 'not_found', `document not found: ${docId}`)
    return jsonResponse({ ok: true })
  }

  /* ----------------------------------------------------------------------- */
  /* Documents and layout                                                    */
  /* ----------------------------------------------------------------------- */

  const document: Handler = async (request) => {
    const docId = requireDocIdQuery(request)
    const record = await store.getDocument(docId)
    if (record === undefined) fail(404, 'not_found', `document not found: ${docId}`)
    const view: DocumentView = {
      ...record,
      hasLayout: Array.isArray(record.regions) && Array.isArray(record.articles),
    }
    return jsonResponse(view)
  }

  const layout: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    const docId = requireDocId(body.docId)
    const regions = requireObjectArray(body.regions, 'regions') as Region[]
    const articles = requireObjectArray(body.articles, 'articles') as Article[]
    await store.saveLayout(docId, { regions, articles })
    return jsonResponse({ ok: true })
  }

  const pageImageGet: Handler = async (request) => {
    const docId = requireDocIdQuery(request)
    const png = await store.getPageImage(docId)
    if (png === undefined) fail(404, 'not_found', `page image not found: ${docId}`)
    return binaryResponse(png, PNG_CONTENT_TYPE)
  }

  /* ----------------------------------------------------------------------- */
  /* Meta, settings and report export                                        */
  /* ----------------------------------------------------------------------- */

  const meta: Handler = async () => {
    const payload: MetaView = {
      version,
      model: { ...model },
      promptVersion,
      limits: {
        maxUploadBytes,
        maxImageBytes,
        maxJsonBytes,
        maxPages: REQUIRED_PAGE_COUNT,
      },
      modelCatalogue: await readModelCatalogue(),
    }
    return jsonResponse(payload)
  }

  const settingsGet: Handler = async () => {
    const settings = await store.getSettings()
    // Compile-time guard: the Host `Settings` shape must stay wire-compatible
    // with the shared `SettingsView` the Client imports.
    const view: SettingsView = settings
    return jsonResponse(view)
  }

  const settingsPost: Handler = async (request) => {
    const body = requireJsonObject(await readJson(request, maxJsonBytes))
    await store.saveSettings(body)
    return jsonResponse({ ok: true })
  }

  const exportReport: Handler = async (request) => {
    const jobId = requireJobIdQuery(request)
    const format = readExportFormat(request)
    const report = await store.getReport(jobId)
    if (report === undefined) fail(404, 'not_found', `report not found: ${jobId}`)
    if (format === 'json') return jsonResponse(report)

    const documentRecord = await store.getDocument(report.docId)
    // Single-source the footer version: the Host reads `package.json` at startup
    // and reports that same version from `/health` and `/meta`.
    const markdown = renderReportMarkdown(report, documentRecord?.articles ?? [], version)
    return new Response(markdown, {
      status: 200,
      headers: { 'content-type': MARKDOWN_CONTENT_TYPE, 'cache-control': 'no-store' },
    })
  }

  const health: Handler = async () => jsonResponse({ ok: true, version })

  /* ----------------------------------------------------------------------- */
  /* Guard and return                                                        */
  /* ----------------------------------------------------------------------- */

  return {
    uploadDocument: guard(uploadDocument),
    pageText: guard(pageText),
    pageImage: guard(pageImage),
    pageOverlay: guard(pageOverlay),
    analyze: guard(analyze),
    document: guard(document),
    layout: guard(layout),
    pageImageGet: guard(pageImageGet),
    proofread: guard(proofread),
    job: guard(job),
    cancel: guard(cancel),
    deleteDoc: guard(deleteDoc),
    meta: guard(meta),
    settingsGet: guard(settingsGet),
    settingsPost: guard(settingsPost),
    exportReport: guard(exportReport),
    health: guard(health),
  }
}

/* ------------------------------------------------------------------------- */
/* Error mapping                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Wrap one handler so every failure becomes the documented JSON error response.
 *
 * `ApiRequestError` carries its own status/code; store/settings validation
 * errors are client errors; everything else is a generic 500 that never echoes
 * internal details (paths, model output or prompt text) to the browser.
 */
function guard(handler: Handler): Handler {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return toErrorResponse(error)
    }
  }
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiRequestError) {
    return errorResponse(error.code, error.message, error.status)
  }
  if (error instanceof DocumentNotFoundError) {
    return errorResponse('not_found', error.message, 404)
  }
  if (error instanceof InvalidDocumentIdError || error instanceof InvalidJobIdError) {
    return errorResponse('bad_request', error.message, 400)
  }
  if (error instanceof SettingsValidationError) {
    return errorResponse('bad_request', error.message, 400)
  }
  return errorResponse('internal_error', 'internal error', 500)
}

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`createHandlers() requires ${name} to be a positive integer`)
  }
  return value
}

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail(400, 'bad_request', 'request body must be a JSON object')
  return value
}

function requireDocId(value: unknown, label = 'docId'): string {
  if (typeof value !== 'string' || !DOC_ID_PATTERN.test(value)) {
    fail(400, 'bad_request', `${label} must be a valid document id`)
  }
  return value
}

function requireJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    fail(400, 'bad_request', 'jobId must be a valid job id')
  }
  return value
}

function requireDocIdQuery(request: Request): string {
  const raw = new URL(request.url).searchParams.get(QUERY_PARAMS.doc)
  if (raw === null || raw.trim() === '') {
    fail(400, 'bad_request', 'doc query parameter is required')
  }
  return requireDocId(raw.trim(), 'doc')
}

function requireJobIdQuery(request: Request): string {
  const raw = new URL(request.url).searchParams.get(QUERY_PARAMS.job)
  if (raw === null || raw.trim() === '') {
    fail(400, 'bad_request', 'job query parameter is required')
  }
  return requireJobId(raw.trim())
}

function readExportFormat(request: Request): ExportFormat {
  const raw = new URL(request.url).searchParams.get(QUERY_PARAMS.format)
  if (raw === null) return 'md'
  const format = raw.trim().toLowerCase()
  if (format !== 'md' && format !== 'json') {
    fail(400, 'bad_request', 'format must be md or json')
  }
  return format
}

function requireBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(400, 'bad_request', `${field} must be a boolean`)
  return value
}

function requireDepth(value: unknown): Depth {
  if (value !== 'quick' && value !== 'standard' && value !== 'deep') {
    fail(400, 'bad_request', 'depth must be one of quick, standard, deep')
  }
  return value
}

function requireArticleIds(value: unknown): ArticleId[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, 'bad_request', 'articleIds must be a non-empty array')
  }
  const ids: ArticleId[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      fail(400, 'bad_request', 'articleIds entries must be non-empty strings')
    }
    ids.push(entry.trim())
  }
  return ids
}

function requireRoles(value: unknown): RoleId[] {
  if (!Array.isArray(value)) fail(400, 'bad_request', 'roles must be an array')
  const roles: RoleId[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !ROLE_IDS.has(entry)) {
      fail(400, 'bad_request', `roles entries must be one of: ${[...ROLE_IDS].join(', ')}`)
    }
    roles.push(entry as RoleId)
  }
  return roles
}

function requirePageTextInput(body: Record<string, unknown>): PageTextInput {
  const { lines, candidates, widthPt, heightPt } = body
  if (!Array.isArray(lines)) fail(400, 'bad_request', 'lines must be an array')
  if (!Array.isArray(candidates)) fail(400, 'bad_request', 'candidates must be an array')
  if (typeof widthPt !== 'number' || !Number.isFinite(widthPt)) {
    fail(400, 'bad_request', 'widthPt must be a finite number')
  }
  if (typeof heightPt !== 'number' || !Number.isFinite(heightPt)) {
    fail(400, 'bad_request', 'heightPt must be a finite number')
  }
  return {
    lines: lines as PageTextInput['lines'],
    candidates: candidates as PageTextInput['candidates'],
    widthPt,
    heightPt,
  }
}

/** Validate a top-level array whose entries must be JSON objects; returns it. */
function requireObjectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(400, 'bad_request', `${field} must be an array`)
  for (const entry of value) {
    if (!isRecord(entry)) fail(400, 'bad_request', `${field} entries must be JSON objects`)
  }
  return value
}

/**
 * Project an arbitrary catalogue source onto the documented wire shape.
 *
 * Only provider `id`/`title` and model `id`/`name` are copied into the response;
 * any other property on the supplied objects (API keys, endpoints, pricing
 * internals, ...) is dropped. Malformed entries are skipped instead of failing
 * `/meta`, so a partially configured Host still shows a usable model list.
 */
function normalizeModelCatalogue(value: unknown): ModelCatalogue {
  if (!Array.isArray(value)) return []
  const providers: ModelCatalogueProvider[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue

    const models: ModelCatalogueModel[] = []
    if (Array.isArray(entry.models)) {
      for (const model of entry.models) {
        if (!isRecord(model)) continue
        const modelId = typeof model.id === 'string' ? model.id.trim() : ''
        if (modelId === '') continue
        const option: ModelCatalogueModel = { id: modelId }
        if (typeof model.name === 'string' && model.name.trim() !== '') {
          option.name = model.name.trim()
        }
        models.push(option)
      }
    }

    const provider: ModelCatalogueProvider = { id, models }
    if (typeof entry.title === 'string' && entry.title.trim() !== '') {
      provider.title = entry.title.trim()
    }
    providers.push(provider)
  }
  return providers
}

/* ------------------------------------------------------------------------- */
/* Upload helpers                                                              */
/* ------------------------------------------------------------------------- */

function readDeclaredPageCount(request: Request): number | undefined {
  const raw = request.headers.get(REQUEST_HEADERS.pageCount)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    fail(400, 'bad_request', 'x-page-count must be a positive integer')
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value > REQUIRED_PAGE_COUNT) {
    // Report the client's actual declared count, even when it is too large to
    // represent as a safe number (never a placeholder value).
    fail(422, 'unprocessable_entity', singlePageMessage(trimmed))
  }
  return value
}

function readUploadFileName(request: Request): string {
  const raw = request.headers.get(REQUEST_HEADERS.fileName)
  if (raw === null) return DEFAULT_FILE_NAME
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_FILE_NAME
  if (trimmed.length > MAX_FILE_NAME_HEADER_LENGTH) {
    fail(400, 'bad_request', 'x-file-name is too long')
  }
  try {
    return decodeURIComponent(trimmed)
  } catch {
    // A raw (non-percent-encoded) header is sanitized by the store instead.
    return trimmed
  }
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return hasSignature(bytes, PDF_HEADER_BYTES)
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return hasSignature(bytes, PNG_SIGNATURE_BYTES)
}

function hasSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

function singlePageMessage(pageCount: number | string): string {
  return (
    `PDF must contain exactly ${REQUIRED_PAGE_COUNT} page; got ${pageCount}. ` +
    'Split the PDF and upload a single page.'
  )
}

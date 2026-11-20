/**
 * Host-side document store for the Ling Gao 校对员 plugin.
 *
 * One document is one single-page newspaper PDF. Everything the plugin needs
 * for a document lives below `<dataDir>/documents/doc_<timestamp>_<6 hex>/`:
 *
 * ```text
 * index.json                              # document list (atomic, serialized)
 * settings.json                           # user settings (see ./settings.ts)
 * documents/doc_<timestamp>_<6hex>/
 *   meta.json
 *   original.pdf
 *   pages/0001.png                        # page image rendered by the Client
 *   pages/0001.overlay.png                # candidate overlay image
 *   pages/0001.lines.json                 # TextLine[]
 *   pages/0001.candidates.json            # { widthPt, heightPt, candidates }
 *   layout.json                           # { regions }
 *   articles.json                         # { articles }
 *   reports/job_<id>/report.json
 *   reports/job_<id>/<articleId>/<role>.json   # cached role results
 *   reports/job_<id>/<articleId>/facts-evidence.json
 * ```
 *
 * Design requirements implemented here:
 * - ids are `doc_<timestamp>_<6 hex>`; every id is validated against
 *   `/^doc_[a-z0-9_]+$/` before it is used as a path component, so path
 *   separators and traversal can never reach the filesystem;
 * - all writes are atomic (temporary file + rename);
 * - `index.json` writes are serialized through a promise chain;
 * - a corrupt or stale `index.json` is rebuilt from the documents' `meta.json`
 *   files on {@link DocumentStore.init}, which also drops directory-less
 *   entries and unreadable document metas;
 * - deleting a document removes the whole `doc_<id>` directory only.
 *
 * Only Node.js built-ins are used; this module is Host-only.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  Article,
  CandidateBlock,
  DocId,
  DocumentMeta,
  DocumentRecord,
  DocumentSummary,
  PageTextInput,
  Region,
  Report,
  TextLine,
} from '../../shared/types'
import { loadSettings, saveSettings, writeFileAtomic } from './settings'
import type { Settings } from './settings'

export { resolveDataDir } from './settings'
export type { Settings } from './settings'

/** Valid document ids, e.g. `doc_1763500000000_ab12cd`. */
export const DOC_ID_PATTERN = /^doc_[a-z0-9_]+$/

/** Valid proofreading job ids, e.g. `job_1763500000000`. */
export const JOB_ID_PATTERN = /^job_[a-z0-9_]+$/

/**
 * Valid article ids used as a report path component. Vision-model article ids are
 * usually `a1`, but the model may pick any non-empty label, so Unicode letters
 * and digits are allowed; path separators, control characters and a leading
 * `.` are not (the id can never leave the report directory or create a hidden
 * file).
 */
export const ARTICLE_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u

/**
 * Valid role result file stems (`<role>.json`). Covers every {@link RoleId} plus
 * the `facts-evidence` audit artifact; no path separators, no uppercase.
 */
export const ROLE_FILE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

const INDEX_FILE_NAME = 'index.json'
const META_FILE_NAME = 'meta.json'
const ORIGINAL_PDF_FILE_NAME = 'original.pdf'
const PAGES_DIR_NAME = 'pages'
const LAYOUT_FILE_NAME = 'layout.json'
const ARTICLES_FILE_NAME = 'articles.json'
const REPORTS_DIR_NAME = 'reports'
const REPORT_FILE_NAME = 'report.json'
const PAGE_FILE_STEM = '0001'

/** Raised when an id fails {@link DOC_ID_PATTERN}; the id is never used as a path. */
export class InvalidDocumentIdError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`invalid document id: ${id}`)
    this.name = 'InvalidDocumentIdError'
    this.id = id
  }
}

/** Raised when a report job id fails {@link JOB_ID_PATTERN}. */
export class InvalidJobIdError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`invalid job id: ${id}`)
    this.name = 'InvalidJobIdError'
    this.id = id
  }
}

/** Raised when a role result article id fails {@link ARTICLE_ID_PATTERN}. */
export class InvalidArticleIdError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`invalid article id: ${id}`)
    this.name = 'InvalidArticleIdError'
    this.id = id
  }
}

/** Raised when a role result file stem fails {@link ROLE_FILE_PATTERN}. */
export class InvalidRoleIdError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`invalid role id: ${id}`)
    this.name = 'InvalidRoleIdError'
    this.id = id
  }
}

/** Raised when a write targets a document that does not exist on disk. */
export class DocumentNotFoundError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`document not found: ${id}`)
    this.name = 'DocumentNotFoundError'
    this.id = id
  }
}

/** Shape of the persisted document index. */
interface StoreIndex {
  version: 1
  documents: DocumentMeta[]
}

/** Shape of `pages/0001.candidates.json`. */
interface PageCandidatesFile {
  widthPt: number
  heightPt: number
  candidates: CandidateBlock[]
}

/** Shape of `layout.json`. */
interface LayoutFile {
  regions: Region[]
}

/** Shape of `articles.json`. */
interface ArticlesFile {
  articles: Article[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidDocId(id: string): boolean {
  return DOC_ID_PATTERN.test(id)
}

function isValidJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id)
}

function isValidArticleId(id: string): boolean {
  return typeof id === 'string' && ARTICLE_ID_PATTERN.test(id)
}

function isValidRoleName(role: string): boolean {
  return typeof role === 'string' && ROLE_FILE_PATTERN.test(role)
}

function isDocumentMeta(value: unknown, id: string): value is DocumentMeta {
  if (!isRecord(value)) return false
  const status = value.status
  return (
    value.id === id &&
    typeof value.fileName === 'string' &&
    value.pageCount === 1 &&
    typeof value.createdAt === 'number' &&
    (status === 'parsing' || status === 'ready' || status === 'failed')
  )
}

function compareDocumentMetas(a: DocumentMeta, b: DocumentMeta): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}

/** Read and parse JSON, returning `undefined` for missing or corrupt files. */
async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Keep only the last path segment of an uploaded file name and strip control
 * characters, so `meta.fileName` can never contain a path separator.
 */
function sanitizeFileName(fileName: string): string {
  const lastSegment = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'document.pdf'
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned
}

/**
 * Apply a whitelisted `updateMeta` patch. Only `status`, `newspaper`, `edition`
 * and `date` are ever copied; every other key is ignored. A blank string clears
 * an optional field. Invalid values raise `TypeError` so a bad API payload cannot
 * corrupt the persisted meta.
 */
function applyMetaPatch(meta: DocumentMeta, patch: Record<string, unknown>): DocumentMeta {
  const next: DocumentMeta = { ...meta }
  let changed = 0

  if ('status' in patch) {
    const status = patch.status
    if (status !== 'parsing' && status !== 'ready' && status !== 'failed') {
      throw new TypeError('meta status must be one of parsing | ready | failed')
    }
    next.status = status
    changed += 1
  }

  for (const field of ['newspaper', 'edition', 'date'] as const) {
    if (!(field in patch)) continue
    const value = patch[field]
    if (value === null || value === '') {
      delete next[field]
      changed += 1
      continue
    }
    if (typeof value !== 'string') throw new TypeError(`meta ${field} must be a string`)
    const trimmed = value.trim()
    if (trimmed === '') throw new TypeError(`meta ${field} must not be blank`)
    if (trimmed.length > 200) {
      throw new TypeError(`meta ${field} must be at most 200 characters`)
    }
    if (field === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new TypeError('meta date must use YYYY-MM-DD')
    }
    next[field] = trimmed
    changed += 1
  }

  if (changed === 0) {
    throw new TypeError('updateMeta() requires at least one of status, newspaper, edition, date')
  }
  return next
}

/**
 * Single-page document store backed by the plugin data directory.
 *
 * Every public method awaits {@link init} internally, so callers only need to
 * construct the store and can call `init()` explicitly for eager validation.
 */
export class DocumentStore {
  readonly #rootDir: string
  #documents = new Map<DocId, DocumentMeta>()
  #indexQueue: Promise<void> = Promise.resolve()
  #ready: Promise<void> | undefined

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
      throw new TypeError('DocumentStore requires a data directory')
    }
    this.#rootDir = resolve(rootDir)
  }

  /** Create the data directory structure and load/repair the document index. */
  init(): Promise<void> {
    if (!this.#ready) {
      this.#ready = this.#init().catch((error: unknown) => {
        this.#ready = undefined
        throw error
      })
    }
    return this.#ready
  }

  /**
   * Persist a new single-page document. The PDF bytes are written to
   * `original.pdf`; the returned metadata has `pageCount: 1` and starts in the
   * `parsing` status until a layout is saved.
   */
  async create(input: { fileName: string; pdfBytes: Uint8Array }): Promise<DocumentMeta> {
    await this.init()
    if (!isRecord(input)) throw new TypeError('create() requires an input object')
    const fileName = input.fileName
    const pdfBytes = input.pdfBytes
    if (typeof fileName !== 'string') throw new TypeError('fileName must be a string')
    if (!(pdfBytes instanceof Uint8Array)) throw new TypeError('pdfBytes must be a Uint8Array')

    const { id, dir } = await this.#allocateDocumentDir()
    const meta: DocumentMeta = {
      id,
      fileName: sanitizeFileName(fileName),
      pageCount: 1,
      createdAt: Date.now(),
      status: 'parsing',
    }
    await mkdir(join(dir, PAGES_DIR_NAME), { recursive: true })
    await writeFileAtomic(join(dir, META_FILE_NAME), JSON.stringify(meta, null, 2))
    await writeFileAtomic(join(dir, ORIGINAL_PDF_FILE_NAME), pdfBytes)
    await this.#updateIndex(() => {
      this.#documents.set(id, meta)
    })
    return { ...meta }
  }

  /**
   * Load one document and all of its persisted artefacts. Unknown, deleted or
   * malformed ids resolve to `undefined` instead of throwing.
   */
  async getDocument(id: string): Promise<DocumentRecord | undefined> {
    await this.init()
    if (typeof id !== 'string' || !isValidDocId(id)) return undefined
    const meta = await this.#readMeta(id)
    if (!meta) return undefined
    const dir = this.#docDir(id)
    const pagesDir = join(dir, PAGES_DIR_NAME)
    const lines = await readJsonFile<TextLine[]>(join(pagesDir, `${PAGE_FILE_STEM}.lines.json`))
    const pageCandidates = await readJsonFile<PageCandidatesFile>(
      join(pagesDir, `${PAGE_FILE_STEM}.candidates.json`),
    )
    const layout = await readJsonFile<LayoutFile>(join(dir, LAYOUT_FILE_NAME))
    const articlesFile = await readJsonFile<ArticlesFile>(join(dir, ARTICLES_FILE_NAME))

    const record: DocumentRecord = { meta, reportIds: await this.#listReportIds(id) }
    if (Array.isArray(lines)) record.lines = lines
    if (isRecord(pageCandidates) && Array.isArray(pageCandidates.candidates)) {
      record.candidates = pageCandidates.candidates as CandidateBlock[]
      if (typeof pageCandidates.widthPt === 'number') record.widthPt = pageCandidates.widthPt
      if (typeof pageCandidates.heightPt === 'number') record.heightPt = pageCandidates.heightPt
    }
    // A layout is only usable when both files are present and readable: a crash
    // between the two writes must never expose a half-saved page.
    if (
      isRecord(layout) &&
      Array.isArray(layout.regions) &&
      isRecord(articlesFile) &&
      Array.isArray(articlesFile.articles)
    ) {
      record.regions = layout.regions as Region[]
      record.articles = articlesFile.articles as Article[]
    }
    return record
  }

  /** Persist the Client-parsed text layer: lines plus page size and candidates. */
  async savePageText(id: string, input: PageTextInput): Promise<void> {
    this.#requireValidDocId(id)
    await this.init()
    await this.#requireMeta(id)
    if (!isRecord(input)) throw new TypeError('savePageText() requires an input object')
    const lines = input.lines
    const candidates = input.candidates
    const widthPt = input.widthPt
    const heightPt = input.heightPt
    if (!Array.isArray(lines)) throw new TypeError('lines must be an array')
    if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array')
    if (typeof widthPt !== 'number' || !Number.isFinite(widthPt)) {
      throw new TypeError('widthPt must be a finite number')
    }
    if (typeof heightPt !== 'number' || !Number.isFinite(heightPt)) {
      throw new TypeError('heightPt must be a finite number')
    }
    const pagesDir = join(this.#docDir(id), PAGES_DIR_NAME)
    await writeFileAtomic(join(pagesDir, `${PAGE_FILE_STEM}.lines.json`), JSON.stringify(lines))
    await writeFileAtomic(
      join(pagesDir, `${PAGE_FILE_STEM}.candidates.json`),
      JSON.stringify({ widthPt, heightPt, candidates }),
    )
  }

  /** Persist the rendered page PNG (`pages/0001.png`). */
  async savePageImage(id: string, png: Uint8Array): Promise<void> {
    await this.#savePageAsset(id, `${PAGE_FILE_STEM}.png`, png)
  }

  /** Persist the candidate overlay PNG (`pages/0001.overlay.png`). */
  async savePageOverlay(id: string, png: Uint8Array): Promise<void> {
    await this.#savePageAsset(id, `${PAGE_FILE_STEM}.overlay.png`, png)
  }

  /**
   * Persist the layout: `layout.json` for regions and `articles.json` for
   * articles. A saved layout marks the document `ready` (the parse/analysis
   * pipeline has produced its result).
   */
  async saveLayout(id: string, layout: { regions: Region[]; articles: Article[] }): Promise<void> {
    this.#requireValidDocId(id)
    await this.init()
    const meta = await this.#requireMeta(id)
    if (!isRecord(layout)) throw new TypeError('saveLayout() requires a layout object')
    const regions = layout.regions
    const articles = layout.articles
    if (!Array.isArray(regions)) throw new TypeError('regions must be an array')
    if (!Array.isArray(articles)) throw new TypeError('articles must be an array')

    const dir = this.#docDir(id)
    await writeFileAtomic(join(dir, LAYOUT_FILE_NAME), JSON.stringify({ regions }))
    await writeFileAtomic(join(dir, ARTICLES_FILE_NAME), JSON.stringify({ articles }))
    if (meta.status !== 'ready') {
      const updated: DocumentMeta = { ...meta, status: 'ready' }
      await writeFileAtomic(join(dir, META_FILE_NAME), JSON.stringify(updated, null, 2))
      await this.#updateIndex(() => {
        this.#documents.set(id, updated)
      })
    }
  }

  /** Persist a finished proofreading report under `reports/<jobId>/report.json`. */
  async saveReport(id: string, report: Report): Promise<void> {
    this.#requireValidDocId(id)
    await this.init()
    await this.#requireMeta(id)
    if (!isRecord(report)) throw new TypeError('saveReport() requires a report object')
    const jobId = report.jobId
    if (typeof jobId !== 'string' || !isValidJobId(jobId)) {
      throw new InvalidJobIdError(String(jobId))
    }
    if (report.docId !== id) {
      throw new Error(`report docId ${String(report.docId)} does not match document ${id}`)
    }
    const reportDir = join(this.#docDir(id), REPORTS_DIR_NAME, jobId)
    await mkdir(reportDir, { recursive: true })
    await writeFileAtomic(join(reportDir, REPORT_FILE_NAME), JSON.stringify(report))
  }

  /**
   * Read a persisted report.
   *
   * With one argument the value is a job id and every document is searched
   * (the `/export?job=` API only knows the job id). With two arguments the
   * first value is the document id, for direct lookups.
   */
  async getReport(jobIdOrDocId: string, maybeJobId?: string): Promise<Report | undefined> {
    await this.init()
    if (typeof jobIdOrDocId !== 'string') return undefined
    if (maybeJobId !== undefined) {
      if (
        !isValidDocId(jobIdOrDocId) ||
        typeof maybeJobId !== 'string' ||
        !isValidJobId(maybeJobId)
      ) {
        return undefined
      }
      return this.#readReport(jobIdOrDocId, maybeJobId)
    }
    if (!isValidJobId(jobIdOrDocId)) return undefined
    for (const id of this.#documents.keys()) {
      const report = await this.#readReport(id, jobIdOrDocId)
      if (report) return report
    }
    return undefined
  }

  /**
   * Persist one role result for a job and article:
   * `reports/<jobId>/<articleId>/<role>.json` (design §7.5 "每完成一个角色就写
   * ...，进程重启可恢复"). The value is stored as returned by `JSON.stringify`,
   * so the orchestrator can cache parsed findings and fact checks and reload them
   * in the same job after a restart. All path components are validated.
   */
  async saveRoleResult(
    id: string,
    jobId: string,
    articleId: string,
    role: string,
    value: unknown,
  ): Promise<void> {
    this.#requireValidDocId(id)
    await this.init()
    await this.#requireMeta(id)
    if (typeof jobId !== 'string' || !isValidJobId(jobId)) {
      throw new InvalidJobIdError(String(jobId))
    }
    if (!isValidArticleId(articleId)) throw new InvalidArticleIdError(String(articleId))
    if (!isValidRoleName(role)) throw new InvalidRoleIdError(String(role))
    const data = value === undefined ? undefined : JSON.stringify(value)
    if (data === undefined) throw new TypeError('role result value must be JSON-serializable')
    const dir = join(this.#docDir(id), REPORTS_DIR_NAME, jobId, articleId)
    await writeFileAtomic(join(dir, `${role}.json`), data)
  }

  /**
   * Read every persisted role result of one job/article as `role -> parsed JSON`.
   * Unknown/invalid ids, a missing directory and corrupt files resolve to an empty
   * map or are skipped, so a damaged cache never breaks a job. Keys are sorted for
   * deterministic iteration.
   */
  async getRoleResults(
    id: string,
    jobId: string,
    articleId: string,
  ): Promise<Record<string, unknown>> {
    await this.init()
    if (
      typeof id !== 'string' ||
      !isValidDocId(id) ||
      typeof jobId !== 'string' ||
      !isValidJobId(jobId) ||
      !isValidArticleId(articleId)
    ) {
      return {}
    }
    let entries
    try {
      entries = await readdir(join(this.#docDir(id), REPORTS_DIR_NAME, jobId, articleId), {
        withFileTypes: true,
      })
    } catch {
      return {}
    }
    const results: Record<string, unknown> = {}
    // Code-unit sort (not localeCompare) keeps iteration order platform-independent.
    const sorted = entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of sorted) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const role = entry.name.slice(0, -'.json'.length)
      if (!isValidRoleName(role)) continue
      const value = await readJsonFile<unknown>(
        join(this.#docDir(id), REPORTS_DIR_NAME, jobId, articleId, entry.name),
      )
      if (value !== undefined) results[role] = value
    }
    return results
  }

  /**
   * Update the whitelisted metadata fields of one document and persist them to
   * `meta.json` plus `index.json`. Unknown fields are ignored (never copied into
   * the meta); `status` must be `parsing | ready | failed`; `date` must be
   * `YYYY-MM-DD`; `newspaper`/`edition` are trimmed strings. An empty patch is a
   * programming error.
   *
   * A document can only be marked `ready` once both `layout.json` and
   * `articles.json` are on disk, so a half-saved layout is never advertised as
   * ready.
   */
  async updateMeta(id: string, patch: unknown): Promise<DocumentMeta> {
    this.#requireValidDocId(id)
    await this.init()
    const meta = await this.#requireMeta(id)
    if (!isRecord(patch)) throw new TypeError('updateMeta() requires a patch object')
    const next = applyMetaPatch(meta, patch)
    const dir = this.#docDir(id)
    if (next.status === 'ready' && !(await this.#hasCompleteLayout(id))) {
      throw new Error('cannot mark document ready before layout.json and articles.json are saved')
    }
    await writeFileAtomic(join(dir, META_FILE_NAME), JSON.stringify(next, null, 2))
    await this.#updateIndex(() => {
      this.#documents.set(id, next)
    })
    return next
  }

  /** Persisted page PNG, or `undefined` when absent. */
  async getPageImage(id: string): Promise<Uint8Array | undefined> {
    return this.#readPageAsset(id, `${PAGE_FILE_STEM}.png`)
  }

  /** Persisted overlay PNG, or `undefined` when absent. */
  async getPageOverlay(id: string): Promise<Uint8Array | undefined> {
    return this.#readPageAsset(id, `${PAGE_FILE_STEM}.overlay.png`)
  }

  /**
   * List persisted documents, newest first. `hasLayout` and `reportCount` are
   * derived from disk, not from the index, so the list cannot go stale.
   */
  async list(): Promise<DocumentSummary[]> {
    await this.init()
    const summaries: DocumentSummary[] = []
    for (const id of this.#documents.keys()) {
      const meta = await this.#readMeta(id)
      if (!meta) continue
      const hasLayout = await this.#hasCompleteLayout(id)
      summaries.push({
        meta,
        hasLayout,
        reportCount: (await this.#listReportIds(id)).length,
      })
    }
    summaries.sort((a, b) => compareDocumentMetas(a.meta, b.meta))
    return summaries
  }

  /**
   * Delete a document and everything below its directory. Returns `false` for
   * unknown or invalid ids (path separators are never accepted).
   */
  async delete(id: string): Promise<boolean> {
    await this.init()
    if (typeof id !== 'string' || !isValidDocId(id)) return false
    const dir = this.#docDir(id)
    if (!(await pathExists(dir))) {
      if (this.#documents.has(id)) {
        await this.#updateIndex(() => {
          this.#documents.delete(id)
        })
      }
      return false
    }
    await rm(dir, { recursive: true, force: true })
    await this.#updateIndex(() => {
      this.#documents.delete(id)
    })
    return true
  }

  /** Read the persisted user settings (`settings.json`, defaults when absent). */
  async getSettings(): Promise<Settings> {
    await this.init()
    return loadSettings(this.#rootDir)
  }

  /** Validate and persist a settings patch; returns the full stored settings. */
  async saveSettings(input: unknown): Promise<Settings> {
    await this.init()
    return saveSettings(this.#rootDir, input)
  }

  /* ----------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ----------------------------------------------------------------------- */

  async #init(): Promise<void> {
    await mkdir(this.#documentsDir(), { recursive: true })
    const entries = await readdir(this.#documentsDir(), { withFileTypes: true })
    const documents = new Map<DocId, DocumentMeta>()
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidDocId(entry.name)) continue
      const meta = await this.#readMeta(entry.name)
      if (meta) documents.set(meta.id, meta)
    }
    this.#documents = documents
    await this.#writeIndex()
  }

  #documentsDir(): string {
    return join(this.#rootDir, 'documents')
  }

  #docDir(id: string): string {
    return join(this.#documentsDir(), id)
  }

  /**
   * True only when both layout files exist, parse, and have the documented
   * top-level shape. A crash between the two `saveLayout` writes (or a corrupt
   * file) must never be reported as a usable layout.
   */
  async #hasCompleteLayout(id: string): Promise<boolean> {
    const dir = this.#docDir(id)
    const layout = await readJsonFile<LayoutFile>(join(dir, LAYOUT_FILE_NAME))
    if (!isRecord(layout) || !Array.isArray(layout.regions)) return false
    const articles = await readJsonFile<ArticlesFile>(join(dir, ARTICLES_FILE_NAME))
    return isRecord(articles) && Array.isArray(articles.articles)
  }

  async #readMeta(id: string): Promise<DocumentMeta | undefined> {
    const value = await readJsonFile<unknown>(join(this.#docDir(id), META_FILE_NAME))
    return isDocumentMeta(value, id) ? value : undefined
  }

  async #requireMeta(id: string): Promise<DocumentMeta> {
    const meta = await this.#readMeta(id)
    if (!meta) throw new DocumentNotFoundError(id)
    return meta
  }

  #requireValidDocId(id: string): void {
    if (typeof id !== 'string' || !isValidDocId(id)) {
      throw new InvalidDocumentIdError(String(id))
    }
  }

  async #savePageAsset(id: string, fileName: string, bytes: Uint8Array): Promise<void> {
    this.#requireValidDocId(id)
    await this.init()
    await this.#requireMeta(id)
    if (!(bytes instanceof Uint8Array)) throw new TypeError('page image must be a Uint8Array')
    await writeFileAtomic(join(this.#docDir(id), PAGES_DIR_NAME, fileName), bytes)
  }

  async #readPageAsset(id: string, fileName: string): Promise<Uint8Array | undefined> {
    await this.init()
    if (typeof id !== 'string' || !isValidDocId(id)) return undefined
    try {
      return new Uint8Array(await readFile(join(this.#docDir(id), PAGES_DIR_NAME, fileName)))
    } catch {
      return undefined
    }
  }

  async #readReport(id: string, jobId: string): Promise<Report | undefined> {
    const value = await readJsonFile<unknown>(
      join(this.#docDir(id), REPORTS_DIR_NAME, jobId, REPORT_FILE_NAME),
    )
    if (!isRecord(value) || value.jobId !== jobId || value.docId !== id) return undefined
    return value as unknown as Report
  }

  async #listReportIds(id: string): Promise<string[]> {
    const reportsDir = join(this.#docDir(id), REPORTS_DIR_NAME)
    let entries
    try {
      entries = await readdir(reportsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const reportIds: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidJobId(entry.name)) continue
      if (await pathExists(join(reportsDir, entry.name, REPORT_FILE_NAME))) {
        reportIds.push(entry.name)
      }
    }
    return reportIds.sort()
  }

  async #allocateDocumentDir(): Promise<{ id: DocId; dir: string }> {
    await mkdir(this.#documentsDir(), { recursive: true })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `doc_${Date.now()}_${randomBytes(3).toString('hex')}`
      const dir = this.#docDir(id)
      try {
        await mkdir(dir)
        return { id, dir }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('failed to allocate a unique document id')
  }

  async #writeIndex(): Promise<void> {
    const index: StoreIndex = {
      version: 1,
      documents: [...this.#documents.values()].sort(compareDocumentMetas),
    }
    await writeFileAtomic(join(this.#rootDir, INDEX_FILE_NAME), JSON.stringify(index, null, 2))
  }

  /** Run a synchronous index mutation followed by an atomic index write. */
  #updateIndex(mutate: () => void): Promise<void> {
    return this.#withIndexLock(async () => {
      mutate()
      await this.#writeIndex()
    })
  }

  /** Serialize index mutations so concurrent creates/deletes never interleave. */
  #withIndexLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#indexQueue
    const run = previous.then(task, task)
    this.#indexQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * Panel workbench (Tasks 17–18; design §6.1/§6.5/§9).
 *
 * This module owns:
 * - the upload flow: `%PDF-` + 150 MB validation → client-side parse at
 *   `{ dpi: 240, maxEdge: 3000 }` (HD page; vision overlay at 1600 px) →
 *   `POST /documents` → `page-text` →
 *   `page-image` → `page-overlay` → `POST /analyze` → poll `GET /job` → layout;
 * - the workbench composition (header, recent-document rail, page canvas +
 *   region overlay + inspector, article list, proofread placeholder) over the
 *   reducer in `state/store.ts`;
 * - the layout-edit handlers: every region operation goes through
 *   `src/shared/layout/edit.ts` (move/resize clamp to the page, merge/split are
 *   page-clamped before the call, split passes the parsed line list) and then
 *   dispatches `layoutLoaded`;
 * - the API seam of the panel (`WorkbenchApi`): one object the tests can fake
 *   and the later UI tasks (19) can reuse.
 *
 * Binding rule (design §2/§9.4): finishing analysis ends at `ready`; this module
 * never calls `/proofread`. The proofread call exists on the seam only for the
 * explicit user action added by Task 19. Loading/refreshing/editing a layout
 * never fills `selectedArticleIds`: the article list starts fully unchecked.
 *
 * No Host module, prompt text, credential or Node built-in is imported here:
 * only the browser API client, the PDF parser, React, shared types/geometry and
 * the panel's own modules.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import {
  ApiError,
  getJson,
  pageImageUrl,
  postBinary,
  postJson,
  uploadDocument,
  type UploadProgress,
} from './api/client'
import { MultiPagePdfError, parsePdfPage, type ParsedPage, type ParsePdfPageOptions } from './pdf/parser'
import { ArticleList, type ArticleTextChange } from './components/ArticleList'
import { Canvas } from './components/Canvas'
import { EmptyState } from './components/EmptyState'
import { DocumentRail } from './components/DocumentRail'
import { Header } from './components/Header'
import { ProofreadPanel } from './components/ProofreadPanel'
import { ReportView } from './components/ReportView'
import { SettingsDrawer } from './components/SettingsDrawer'
import { copyToClipboard } from './components/ReportToolbar'
import {
  RegionInspector,
  isStraightCut,
  type RegionChange,
} from './components/RegionInspector'
import { createInitialState, reduce } from './state/store'
import {
  DEFAULT_LAYOUT_SAVE_DELAY_MS,
  createLayoutSaver,
  flushBeforeProofread,
  type LayoutSavePayload,
  type SaveStatus,
} from './state/layout-saver'
import {
  assignRegionToArticle,
  computeLayoutWarnings,
  deleteRegionFromLayout,
  mergeRegionsIntoLayout,
  reconcileLayout,
  regionWarningFlags,
  sortRegionsByOrder,
  splitRegionsIntoLayout,
  type LayoutSnapshot,
} from './layout/ops'
import { defaultTranslate, type Translate } from './locale'
import { clientStyles } from './styles'
import { renderReportMarkdown } from '../shared/report/markdown'
import {
  API_PATHS,
  type AnalyzeResponse,
  type DocumentView,
  type JobView,
  type MetaView,
  type ProofreadRequest,
  type ProofreadResponse,
  type SettingsPatch,
  type SettingsView,
} from '../shared/api/protocol'
import {
  mergeRegions,
  moveRegion,
  reorderRegion,
  resizeRegion,
  splitRegion,
} from '../shared/layout/edit'
import { normalizeBBox } from '../shared/geometry/bbox'
import { renderArticleFullText } from '../shared/text/clean'
import type {
  Article,
  BBox,
  Depth,
  DocumentMeta,
  DocumentSummary,
  Finding,
  PageSize,
  PageTextInput,
  Region,
  Report,
  TextLine,
} from '../shared/types'

/* ------------------------------------------------------------------------- */
/* Upload contract constants (design §11.1)                                   */
/* ------------------------------------------------------------------------- */

/** Single-upload cap: 150 MB (design §11.1 `maxUploadBytes` default). */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024

/** Client parse resolution (Task 24: HD page + smaller vision overlay). */
export const PARSE_OPTIONS: ParsePdfPageOptions = Object.freeze({
  dpi: 240,
  maxEdge: 3000,
  overlayMaxEdge: 1600,
})

/** PDF header the Host also validates on upload. */
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const

/** Poll cadence: 1 s initially, backing off to 3 s on transport failures. */
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_MAX_POLL_INTERVAL_MS = 3_000
const DEFAULT_MAX_POLL_FAILURES = 8

/* ------------------------------------------------------------------------- */
/* File validation                                                            */
/* ------------------------------------------------------------------------- */

/** Why a file was rejected before parsing (mapped to a localized message). */
export type UploadValidationCode = 'empty_file' | 'too_large' | 'not_pdf'

/** A file that fails the client-side PDF pre-check. */
export class UploadValidationError extends Error {
  readonly code: UploadValidationCode

  constructor(code: UploadValidationCode) {
    super(`invalid PDF upload: ${code}`)
    this.name = 'UploadValidationError'
    this.code = code
  }
}

/** Read the first bytes of a file (Blob.arrayBuffer, else FileReader fallback). */
function readFilePrefix(file: File, length: number): Promise<Uint8Array> {
  const slice = typeof file.slice === 'function' ? file.slice(0, length) : file
  const withArrayBuffer = slice as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof withArrayBuffer.arrayBuffer === 'function') {
    return withArrayBuffer.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new Error('cannot read the selected file'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(0))
    }
    reader.onerror = () => {
      reject(reader.error instanceof Error ? reader.error : new Error('failed to read the file'))
    }
    reader.readAsArrayBuffer(slice)
  })
}

/** True when the bytes start with `%PDF-` (the same check the Host applies). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_HEADER.length) return false
  return PDF_HEADER.every((value, index) => bytes[index] === value)
}

/**
 * Client-side pre-check, run *before* PDF.js touches the file (a rejected file
 * must never create a Host document or start a worker).
 *
 * @throws {UploadValidationError} for an empty, oversized or non-PDF file.
 */
export async function assertPdfFile(file: File): Promise<void> {
  if (file === null || typeof file !== 'object' || typeof file.size !== 'number') {
    throw new UploadValidationError('empty_file')
  }
  if (file.size <= 0) throw new UploadValidationError('empty_file')
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadValidationError('too_large')
  const prefix = await readFilePrefix(file, PDF_HEADER.length)
  if (!hasPdfHeader(prefix)) throw new UploadValidationError('not_pdf')
}

/* ------------------------------------------------------------------------- */
/* Abort helpers                                                              */
/* ------------------------------------------------------------------------- */

/** An `AbortError`-named error, so aborts are distinguishable from failures. */
export function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

/** True for both DOM `AbortError`s and the API client's `aborted` ApiError. */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  return (error as { code?: unknown }).code === 'aborted'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

/** Abortable sleep used between job polls (default implementation). */
export function sleepUntilAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    function onAbort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/* ------------------------------------------------------------------------- */
/* API seam                                                                   */
/* ------------------------------------------------------------------------- */

/** Everything the panel needs from the Host API; tests replace it wholesale. */
export interface WorkbenchApi {
  /** Parse + render one single-page PDF (Task 16). */
  parsePdfPage(file: File, options: ParsePdfPageOptions): Promise<ParsedPage>
  /** Upload the PDF, returning the created document metadata. */
  uploadDocument(
    file: File,
    onProgress?: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<DocumentMeta>
  /** Submit the extracted lines/candidates/page size. */
  pageText(docId: string, input: PageTextInput, signal?: AbortSignal): Promise<void>
  /** Submit the rendered page PNG. */
  pageImage(docId: string, png: Blob, signal?: AbortSignal): Promise<void>
  /** Submit the candidate-overlay PNG. */
  pageOverlay(docId: string, overlay: Blob, signal?: AbortSignal): Promise<void>
  /** Start the layout analysis job. */
  analyze(docId: string, signal?: AbortSignal): Promise<{ jobId: string }>
  /** Poll one job. */
  getJob(jobId: string, signal?: AbortSignal): Promise<JobView>
  /** Cancel a job (best effort). */
  cancelJob(jobId: string, signal?: AbortSignal): Promise<void>
  /**
   * Persist the edited layout (`POST /layout`). The Host proofread job reads the
   * stored articles, so edits must be flushed here before proofreading.
   */
  saveLayout(docId: string, layout: LayoutSavePayload, signal?: AbortSignal): Promise<void>
  /** Start a proofread job — only for the explicit user action (Task 19). */
  proofread(request: ProofreadRequest, signal?: AbortSignal): Promise<{ jobId: string }>
  /** Load an existing document (used when re-opening a rail entry). */
  getDocument(docId: string, signal?: AbortSignal): Promise<DocumentView>
  /** Read `/meta`: version, effective model, prompt version and model catalogue. */
  getMeta(signal?: AbortSignal): Promise<MetaView>
  /** Read `/settings` (the persisted user preferences). */
  getSettings(signal?: AbortSignal): Promise<SettingsView>
  /** Persist a `/settings` patch; the Host validates + merges it. */
  saveSettings(patch: SettingsPatch, signal?: AbortSignal): Promise<void>
}

/** The real API seam: Task 16 helpers bound to the shared protocol routes. */
export function createWorkbenchApi(): WorkbenchApi {
  return {
    parsePdfPage: (file, options) => parsePdfPage(file, options),
    uploadDocument: (file, onProgress, signal) => uploadDocument(file, onProgress, signal),
    pageText: async (docId, input, signal) => {
      await postJson(API_PATHS.pageText, input, { params: { doc: docId }, signal })
    },
    pageImage: async (docId, png, signal) => {
      await postBinary(API_PATHS.pageImage, png, { params: { doc: docId }, signal })
    },
    pageOverlay: async (docId, overlay, signal) => {
      await postBinary(API_PATHS.pageOverlay, overlay, { params: { doc: docId }, signal })
    },
    analyze: (docId, signal) => postJson<AnalyzeResponse>(API_PATHS.analyze, { docId }, { signal }),
    getJob: (jobId, signal) => getJson<JobView>(API_PATHS.job, { job: jobId }, { signal }),
    cancelJob: async (jobId, signal) => {
      await postJson(API_PATHS.cancel, { jobId }, { signal })
    },
    saveLayout: async (docId, layout, signal) => {
      await postJson(
        API_PATHS.layout,
        { docId, regions: layout.regions, articles: layout.articles },
        { signal },
      )
    },
    proofread: (request, signal) =>
      postJson<ProofreadResponse>(API_PATHS.proofread, request, { signal }),
    getDocument: (docId, signal) =>
      getJson<DocumentView>(API_PATHS.document, { doc: docId }, { signal }),
    getMeta: (signal) => getJson<MetaView>(API_PATHS.meta, undefined, { signal }),
    getSettings: (signal) => getJson<SettingsView>(API_PATHS.settingsGet, undefined, { signal }),
    saveSettings: async (patch, signal) => {
      await postJson(API_PATHS.settingsPost, patch, { signal })
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Upload flow                                                                */
/* ------------------------------------------------------------------------- */

/** Stages reported to the UI while one file is being processed. */
export type UploadFlowPhase = 'validating' | 'parsing' | 'uploading' | 'submitting' | 'analyzing'

/** Options of {@link runUploadFlow}. */
export interface UploadFlowOptions {
  /** Aborts the flow (upload XHR, page POSTs, polling). */
  signal?: AbortSignal
  /** Initial poll interval in ms (default 1000). */
  pollIntervalMs?: number
  /** Backoff ceiling in ms (default 3000). */
  maxPollIntervalMs?: number
  /** Consecutive poll failures tolerated before the flow fails (default 8). */
  maxConsecutivePollFailures?: number
  /** Sleep implementation (tests inject a no-op to avoid real waiting). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onPhase?: (phase: UploadFlowPhase) => void
  onProgress?: (progress: UploadProgress) => void
  onDocument?: (document: DocumentMeta) => void
  /**
   * Fired once the page PNG reached the Host (`POST /page-image`). The panel
   * bumps its canvas image version here: the canvas has been showing the 404 of
   * the not-yet-uploaded PNG, and a new image URL is what makes it retry.
   */
  onPageImage?: () => void
  onJob?: (job: JobView) => void
}

/** Everything a completed layout flow produced. */
export interface UploadFlowResult {
  document: DocumentMeta
  regions: Region[]
  articles: Article[]
  warnings: string[]
  /** Final (done) layout job snapshot. */
  job: JobView
  /**
   * Parsed text lines of the page. Task 18's `splitRegion` uses them to
   * partition line ids by line centre (the region's `lineIds` reference these
   * line ids); without them every id would land in the second part.
   */
  lines: TextLine[]
  /** Page size in PDF points (the canvas coordinate space). */
  page: PageSize
}

/** Defensive reader of the layout job result `{ regions, articles, warnings }`. */
export function readLayoutResult(result: unknown): {
  regions: Region[]
  articles: Article[]
  warnings: string[]
} {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('layout job finished without a layout result')
  }
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.articles)) {
    throw new Error('layout result is missing the articles list')
  }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  return {
    regions: Array.isArray(record.regions) ? (record.regions as Region[]) : [],
    articles: record.articles as Article[],
    warnings,
  }
}

/** Defensive reader of the proofread job result (the `Report` itself). */
export function readProofreadReport(result: unknown): Report {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('校对任务已完成，但缺少报告结果')
  }
  const record = result as Record<string, unknown>
  if (!Array.isArray(record.findings) || !Array.isArray(record.factChecks)) {
    throw new Error('校对报告缺少问题列表或事实核查清单')
  }
  if (typeof record.summary !== 'object' || record.summary === null || Array.isArray(record.summary)) {
    throw new Error('校对报告缺少摘要')
  }
  return record as unknown as Report
}

/** Poll one background job until done/failed/cancelled, backing off on failures. */
async function pollJob(
  jobId: string,
  api: WorkbenchApi,
  options: UploadFlowOptions,
  kind: 'layout' | 'proofread',
): Promise<JobView> {
  const sleep = options.sleep ?? sleepUntilAborted
  const baseInterval = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const maxInterval = Math.max(baseInterval, options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS)
  const maxFailures = Math.max(1, options.maxConsecutivePollFailures ?? DEFAULT_MAX_POLL_FAILURES)
  let delay = baseInterval
  let failures = 0

  for (;;) {
    let job: JobView
    try {
      job = await api.getJob(jobId, options.signal)
      failures = 0
      delay = baseInterval
    } catch (error) {
      if (isAbortError(error)) throw error
      failures += 1
      if (failures >= maxFailures) throw error
      await sleep(Math.min(delay, maxInterval), options.signal)
      delay = Math.min(delay * 2, maxInterval)
      continue
    }

    options.onJob?.(job)
    if (job.status === 'done') return job
    if (job.status === 'failed') {
      throw new Error(job.error ?? `${kind} job failed: ${job.id}`)
    }
    if (job.status === 'cancelled') throw abortError()
    await sleep(delay, options.signal)
  }
}

/**
 * Run the complete upload → analyze → poll flow for one single-page PDF.
 *
 * Order matters (design §6.1/§10.2): validate the file, parse/render it client
 * side (so a multi-page PDF is rejected before it reaches the Host), upload the
 * PDF, submit page text + page/overlay PNGs, start the layout job, then poll it
 * until done. The returned layout is **not** proofread; that stays an explicit
 * user action (Task 19).
 *
 * @throws {UploadValidationError} for the client-side file pre-check;
 * @throws {MultiPagePdfError} for more than one page;
 * @throws {Error} for API/job failures;
 * @throws {Error} named `AbortError` when `options.signal` aborts.
 */
export async function runUploadFlow(
  file: File,
  api: WorkbenchApi,
  options: UploadFlowOptions = {},
): Promise<UploadFlowResult> {
  throwIfAborted(options.signal)

  options.onPhase?.('validating')
  await assertPdfFile(file)
  throwIfAborted(options.signal)

  options.onPhase?.('parsing')
  const parsed = await api.parsePdfPage(file, PARSE_OPTIONS)
  throwIfAborted(options.signal)

  options.onPhase?.('uploading')
  const document = await api.uploadDocument(file, options.onProgress, options.signal)
  if (typeof document?.id !== 'string' || document.id === '') {
    throw new Error('upload response is missing document.id')
  }
  options.onDocument?.(document)

  options.onPhase?.('submitting')
  const pageText: PageTextInput = {
    lines: parsed.lines,
    candidates: parsed.candidates,
    widthPt: parsed.widthPt,
    heightPt: parsed.heightPt,
  }
  await api.pageText(document.id, pageText, options.signal)
  await api.pageImage(document.id, parsed.pagePng, options.signal)
  // The canvas mounted when the document was created, so it is still showing
  // the 404 of the not-yet-uploaded PNG: let the panel refresh the image URL.
  options.onPageImage?.()
  await api.pageOverlay(document.id, parsed.overlayPng, options.signal)
  throwIfAborted(options.signal)

  options.onPhase?.('analyzing')
  const { jobId } = await api.analyze(document.id, options.signal)
  const job = await pollJob(jobId, api, options, 'layout')
  const layout = readLayoutResult(job.result)
  return {
    document,
    ...layout,
    job,
    lines: parsed.lines,
    page: { widthPt: parsed.widthPt, heightPt: parsed.heightPt },
  }
}

/** Turn a thrown upload/analyze error into localized, user-facing text. */
export function describeUploadError(error: unknown, t: Translate): string {
  if (error instanceof UploadValidationError) return t(`error.${error.code}`)
  if (error instanceof MultiPagePdfError) {
    return t('error.multi_page', { count: error.numPages })
  }
  if (isAbortError(error)) return t('error.cancelled')
  if (error instanceof ApiError) return t('error.generic', { message: error.message })
  if (error instanceof Error) return t('error.generic', { message: error.message })
  return t('error.generic', { message: String(error) })
}

/* ------------------------------------------------------------------------- */
/* Layout edit helpers (Task 18)                                              */
/* ------------------------------------------------------------------------- */

/**
 * Fallback page size when neither the parse flow nor the stored document
 * carries `widthPt`/`heightPt`. Real documents always carry the parsed page
 * size, so this only keeps the canvas measurable for defensive/legacy records.
 */
export const DEFAULT_PAGE_SIZE: PageSize = Object.freeze({ widthPt: 612, heightPt: 792 })

/* ------------------------------------------------------------------------- */
/* Report locate (Task 19b; design §9.4)                                     */
/* ------------------------------------------------------------------------- */

/** A finding resolved to the article/region it should be located on. */
export interface FindingLocation {
  /** Article the finding belongs to. */
  articleId: string
  /** Display title of that article (falls back to its id). */
  articleTitle: string
  /** Region to select/highlight when it can be determined, else `null`. */
  regionId: string | null
  /** Region ids to highlight (the located region, else every article region). */
  regionIds: string[]
}

/** Normalize text for quote matching: drop whitespace and quote characters. */
function normalizeLocateText(value: string): string {
  return value.replace(/\s+/g, '').replace(/[“”"'‘’「」『』]/g, '').toLowerCase()
}

/**
 * Resolve where one finding lives on the page (design §9.4 "点击卡片：画布定位").
 *
 * The target region is deterministic:
 * 1. an article with exactly one region → that region;
 * 2. a multi-region article → the region whose lines contain the finding quote
 *    (whitespace/quote-normalized match);
 * 3. otherwise every region of the article is highlighted and no single region
 *    is selected.
 *
 * The article text and the finding are never mutated.
 */
export function locateFinding(
  finding: Finding,
  articles: readonly Article[],
  regions: readonly Region[],
  lines: readonly TextLine[],
): FindingLocation | null {
  if (typeof finding?.articleId !== 'string' || finding.articleId === '') return null
  const article = articles.find((candidate) => candidate?.id === finding.articleId)
  if (article === undefined) return null

  // Region ids of the article, reconciled with `Region.articleId` defensively so
  // a legacy record where only one side is populated still resolves.
  const regionById = new Map<string, Region>()
  for (const region of regions) {
    if (typeof region?.id === 'string' && region.id !== '') regionById.set(region.id, region)
  }
  const articleRegionIds: string[] = []
  const seen = new Set<string>()
  const addRegionId = (id: unknown): void => {
    if (typeof id !== 'string' || id === '' || seen.has(id) || !regionById.has(id)) return
    seen.add(id)
    articleRegionIds.push(id)
  }
  for (const id of Array.isArray(article.regionIds) ? article.regionIds : []) addRegionId(id)
  for (const region of regions) {
    if (region?.articleId === article.id) addRegionId(region.id)
  }

  let regionId: string | null = null
  if (articleRegionIds.length === 1) {
    regionId = articleRegionIds[0]
  } else if (articleRegionIds.length > 1) {
    const quote = normalizeLocateText(typeof finding.quote === 'string' ? finding.quote : '')
    if (quote !== '') {
      const lineById = new Map<string, TextLine>()
      for (const line of lines) {
        if (typeof line?.id === 'string') lineById.set(line.id, line)
      }
      for (const id of articleRegionIds) {
        const region = regionById.get(id)
        if (region === undefined) continue
        const lineIds = Array.isArray(region.lineIds) ? region.lineIds : []
        const matched = lineIds.some((lineId) => {
          const line = lineById.get(lineId)
          return line !== undefined && normalizeLocateText(line.text).includes(quote)
        })
        if (matched) {
          regionId = region.id
          break
        }
      }
    }
  }

  return {
    articleId: article.id,
    articleTitle:
      typeof article.title === 'string' && article.title.trim() !== ''
        ? article.title
        : article.id,
    regionId,
    regionIds: regionId === null ? [...articleRegionIds] : [regionId],
  }
}

/** Default duration of the card→canvas locate pulse (design §9.4 “~2 s”). */
export const DEFAULT_LOCATE_HIGHLIGHT_MS = 2_000

/** Stable empty region-id list (keeps the canvas-highlight memo identity). */
const NO_REGION_IDS: string[] = []

/** The active card→canvas locate pulse. */
interface LocateTarget {
  /** Generation token: a stale timer must not clear a newer locate. */
  token: number
  location: FindingLocation
  /** Localized region-kind label of the located region, if any. */
  regionLabel: string | null
}

/**
 * Page size used by the canvas: stored/parsed dimensions when valid, else the
 * extent of the region boxes, else {@link DEFAULT_PAGE_SIZE}.
 */
export function pageSizeFor(
  regions: readonly Region[],
  widthPt?: number,
  heightPt?: number,
): PageSize {
  if (
    typeof widthPt === 'number' &&
    Number.isFinite(widthPt) &&
    widthPt > 0 &&
    typeof heightPt === 'number' &&
    Number.isFinite(heightPt) &&
    heightPt > 0
  ) {
    return { widthPt, heightPt }
  }
  let maxX = 0
  let maxY = 0
  for (const region of regions) {
    const box = normalizeBBox(region.bbox)
    maxX = Math.max(maxX, box.x + box.w)
    maxY = Math.max(maxY, box.y + box.h)
  }
  if (maxX > 0 && maxY > 0) return { widthPt: maxX, heightPt: maxY }
  return DEFAULT_PAGE_SIZE
}

/* ------------------------------------------------------------------------- */
/* Local transport state                                                      */
/* ------------------------------------------------------------------------- */

/** Visual stage of the current transfer (durable phase lives in the reducer). */
type TransferStatus = 'idle' | UploadFlowPhase

/** Right-column tab: 文章 (article list + inspector) or 校对 (proofread + report). */
export type AsideTab = 'articles' | 'proofread'

interface TransferState {
  status: TransferStatus
  /** Upload ratio in `[0, 1]` while `status === 'uploading'`. */
  ratio?: number
}

const TRANSFER_KEYS: Record<UploadFlowPhase, string> = {
  validating: 'transfer.validating',
  parsing: 'transfer.parsing',
  uploading: 'transfer.uploading',
  submitting: 'transfer.submitting',
  analyzing: 'transfer.analyzing',
}

/* ------------------------------------------------------------------------- */
/* App                                                                        */
/* ------------------------------------------------------------------------- */

/** Props of the workbench page. */
export interface AppProps {
  /** Localized plugin name; defaults to the locale dictionary's `panel`. */
  name?: string
  /** Locale-bound translator seat supplied by the slot registry. */
  t?: Translate
  /** API seam; tests inject a fake. Defaults to {@link createWorkbenchApi}. */
  api?: WorkbenchApi
  /**
   * Debounce delay of the `POST /layout` save in ms (default
   * {@link DEFAULT_LAYOUT_SAVE_DELAY_MS}); `0` saves on the next microtask so
   * tests can await the payload without waiting for a timer.
   */
  saveDebounceMs?: number
  /**
   * Poll cadence of the proofread `GET /job` loop in ms (default 1000); tests
   * pass a small value so a scripted fake job sequence can settle immediately.
   */
  proofreadPollIntervalMs?: number
  /**
   * Duration of the card→canvas locate pulse in ms (default
   * {@link DEFAULT_LOCATE_HIGHLIGHT_MS}); tests pass a small value instead of
   * waiting two real seconds.
   */
  locateHighlightMs?: number
}

/** Undo/redo history limit (the design requires at least 20 steps). */
export const HISTORY_LIMIT = 50

/** Localized status keys of the layout save queue. */
const SAVE_STATUS_KEYS: Record<Exclude<SaveStatus, 'idle'>, string> = {
  pending: 'save.pending',
  saving: 'save.saving',
  saved: 'save.saved',
  error: 'save.error',
}

/** Transfer banner shown above the workbench while a file is in flight. */
function TransferBanner({
  label,
  percent,
  progressLabel,
}: {
  label: string
  percent: number | null
  progressLabel: string
}) {
  return (
    <div className="lgp-transfer" role="status" aria-live="polite" data-lgp-part="transfer">
      <span className="lgp-transfer-label">{label}</span>
      {percent === null ? null : (
        <>
          <progress
            className="lgp-transfer-bar"
            max={100}
            value={percent}
            aria-label={progressLabel}
          />
          <span className="lgp-transfer-percent">{percent}%</span>
        </>
      )}
    </div>
  )
}

/**
 * One in-flight upload flow (per `runFiles` call).
 *
 * `documentId` is the Host document the flow last created, so stale callbacks
 * can be dropped once another document is open. `controller` is the flow's
 * abort source; `flowRef` identity is the generation guard: only the flow whose
 * token is still `flowRef.current` may dispatch into the workbench reducer.
 */
interface FlowToken {
  controller: AbortController
  documentId: string | null
}

/**
 * One in-flight proofread job.
 *
 * `controller` aborts the start/poll calls, `cancelled` distinguishes a user
 * cancellation (a notice) from a real failure, `jobId` is filled after
 * `POST /proofread`, and `lastJob` is the latest polled snapshot so a cancelled/
 * aborted poll can still put the reducer back into a `cancelled` job state.
 * `proofreadRef` identity is the generation guard for stale poll callbacks.
 */
interface ProofreadToken {
  controller: AbortController
  jobId: string
  cancelled: boolean
  lastJob: JobView | null
}

/** A synthetic snapshot shown while `POST /proofread` is still in flight. */
const PROOFREAD_STARTING_JOB: JobView = Object.freeze({
  id: '',
  kind: 'proofread',
  status: 'queued',
  progress: 0,
  stages: [],
})

/**
 * The workbench page registered into the `main` slot under key
 * `lgproofreader`.
 *
 * Task 18 replaces the `data-lgp-slot="canvas"` and `data-lgp-slot="article-list"`
 * placeholders; Task 19 replaces `data-lgp-slot="proofread-panel"`. The
 * `data-lgp-phase` / `data-lgp-document-id` attributes on the root are the
 * stable test hooks for the workbench phase and open document.
 */
export function App(props: AppProps = {}) {
  const t = props.t ?? defaultTranslate
  const [state, dispatch] = useReducer(reduce, undefined, createInitialState)
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [transfer, setTransfer] = useState<TransferState>({ status: 'idle' })
  /** Status of the debounced `POST /layout` save queue. */
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  /** Undo/redo snapshots of the edited layout (most recent last). */
  const [history, setHistory] = useState<{
    past: LayoutSnapshot[]
    future: LayoutSnapshot[]
  }>({ past: [], future: [] })
  /** Parsed text lines of the open page (Task 18: split line-id partition). */
  const [lines, setLines] = useState<TextLine[]>([])
  /** Page size in PDF points; `null` until known (inferred for legacy records). */
  const [page, setPage] = useState<PageSize | null>(null)
  /**
   * Cache-busting version of the page image URL. It changes after
   * `POST /page-image` succeeds (the canvas has been showing the 404 of the
   * not-yet-uploaded PNG) and each time a stored document is re-opened, so the
   * browser always re-requests the current image instead of a cached response.
   */
  const [imageVersion, setImageVersion] = useState(0)
  /** Selected region id (inspector target); local UI state, not durable. */
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  /** Right-column tab selection (Task 19b; design §9.2). */
  const [asideTab, setAsideTab] = useState<AsideTab>('articles')
  /** Narrow-window drawer state; the wide layout always shows the aside. */
  const [asideOpen, setAsideOpen] = useState(false)
  /** Active card→canvas locate pulse, cleared after `locateHighlightMs`. */
  const [locateTarget, setLocateTarget] = useState<LocateTarget | null>(null)
  /** Locate generation token (stale timers must not clear a newer locate). */
  const locateTokenRef = useRef(0)
  /** Tab buttons, so arrow-key navigation can move focus between them. */
  const articlesTabRef = useRef<HTMLButtonElement | null>(null)
  const proofreadTabRef = useRef<HTMLButtonElement | null>(null)
  /** Explicit proofreading options controlled by `ProofreadPanel`. */
  const [depth, setDepth] = useState<Depth>('standard')
  const [factCheck, setFactCheck] = useState(true)
  /** Local start/cancel notice of the proofread action (not durable state). */
  const [proofNotice, setProofNotice] = useState<string | null>(null)
  const [proofError, setProofError] = useState<string | null>(null)
  /** True between the start click and the first `GET /job` snapshot. */
  const [proofStarting, setProofStarting] = useState(false)
  /** Running proofread job token (generation guard for stale poll callbacks). */
  const proofreadRef = useRef<ProofreadToken | null>(null)
  /**
   * Latest report snapshot for status updates. Batch accept fires several
   * `onStatusChange` calls in one event; a reducer-closure update per call would
   * drop all but the last, so the handler composes on this ref instead.
   */
  const reportRef = useRef<Report | null>(null)
  /** `factCheck` flag of the last started run; drives the offline report marker. */
  const proofreadFactCheckRef = useRef<boolean | null>(null)
  /** Settings drawer: opened from the header, loaded lazily on first open. */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Recent-documents rail: can collapse to give the PDF preview more width. */
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [meta, setMeta] = useState<MetaView | null>(null)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const settingsAttemptedRef = useRef(false)
  /** `/settings` defaults are seeded into the start controls exactly once. */
  const settingsSeededRef = useRef(false)
  /** True once the user changed a control: a late settings seed must not win. */
  const depthTouchedRef = useRef(false)
  const factCheckTouchedRef = useRef(false)
  const flowRef = useRef<FlowToken | null>(null)
  /** Bumped by every new flow/open/cancel so late async replies can be dropped. */
  const activityRef = useRef(0)
  const mountedRef = useRef(true)
  const lastFileRef = useRef<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const name = props.name ?? t('panel')

  // The API seam is layered: the raw seam (fake in tests, real fetch client in
  // production), the debounced layout saver, and the proofread-safe seam that
  // flushes the pending `POST /layout` before any proofread request (Task 13
  // reads the persisted articles, so the Host must have the latest edits).
  const baseApi = useMemo<WorkbenchApi>(() => props.api ?? createWorkbenchApi(), [props.api])
  const saver = useMemo(
    () =>
      createLayoutSaver({
        save: (docId, payload) => baseApi.saveLayout(docId, payload),
        delayMs: props.saveDebounceMs ?? DEFAULT_LAYOUT_SAVE_DELAY_MS,
        onStatus: (status) => {
          if (mountedRef.current) setSaveStatus(status)
        },
      }),
    [baseApi, props.saveDebounceMs],
  )
  /** Await the pending `POST /layout`; rejects when the save failed. */
  const flushLayoutSave = useCallback((): Promise<void> => saver.flush(), [saver])
  const api = useMemo<WorkbenchApi>(
    () => ({
      ...baseApi,
      // Task 13 reads the persisted articles: never start proofreading before
      // the last edit reached the Host.
      proofread: flushBeforeProofread(baseApi.proofread, flushLayoutSave),
    }),
    [baseApi, flushLayoutSave],
  )

  useEffect(() => {
    // StrictMode/replay safety: the effect may run after an initial false.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activityRef.current += 1
      const flow = flowRef.current
      flowRef.current = null
      flow?.controller.abort()
      const proofread = proofreadRef.current
      proofreadRef.current = null
      proofread?.controller.abort()
    }
  }, [])

  // Never drop the last edit silently when the panel unloads: force the pending
  // save out (fire-and-forget because React cleanup cannot await).
  useEffect(
    () => () => {
      void flushLayoutSave().catch(() => undefined)
    },
    [flushLayoutSave],
  )

  // A new document starts a fresh undo/redo history and save-status.
  useEffect(() => {
    setHistory({ past: [], future: [] })
    setSaveStatus('idle')
  }, [state.document?.id])

  // A region selection only lives while that region exists: deleting a region,
  // replacing the layout or opening another document clears the inspector
  // instead of leaving it bound to a stale object.
  useEffect(() => {
    if (selectedRegionId === null) return
    if (!state.regions.some((region) => region.id === selectedRegionId)) {
      setSelectedRegionId(null)
    }
  }, [selectedRegionId, state.regions])

  // Batch-safe status updates read the newest report from the ref (see
  // `reportRef`); keep it in sync with the reducer without re-dispatching.
  useEffect(() => {
    reportRef.current = state.report
  }, [state.report])

  // Design §9.4: a finished proofreading run brings the report tab to the front.
  useEffect(() => {
    if (state.phase === 'report') setAsideTab('proofread')
  }, [state.phase])

  // The narrow-window drawer closes on Escape (Task 19b; design §9.4 a11y).
  useEffect(() => {
    if (!asideOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAsideOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [asideOpen])

  // Clear the canvas pulse after the locate duration; a newer locate wins.
  useEffect(() => {
    if (locateTarget === null) return
    const token = locateTarget.token
    const duration = Math.max(0, props.locateHighlightMs ?? DEFAULT_LOCATE_HIGHLIGHT_MS)
    const timer = setTimeout(() => {
      if (!mountedRef.current) return
      setLocateTarget((current) => (current !== null && current.token === token ? null : current))
    }, duration)
    return () => clearTimeout(timer)
  }, [locateTarget, props.locateHighlightMs])

  /** Only the current, non-aborted flow may dispatch into the workbench. */
  const isCurrentFlow = useCallback(
    (flow: FlowToken): boolean =>
      mountedRef.current && flowRef.current === flow && !flow.controller.signal.aborted,
    [],
  )

  const runFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0 || flowRef.current !== null || proofreadRef.current !== null) return
      lastFileRef.current = files[0] ?? null
      const flow: FlowToken = { controller: new AbortController(), documentId: null }
      flowRef.current = flow
      // Any pending "open document" reply is stale the moment a flow starts.
      activityRef.current += 1
      // Push pending edits of the previous document to the Host before its
      // layout can be replaced (fire-and-forget: the saver serialises itself).
      void flushLayoutSave().catch(() => undefined)
      // A new document invalidates the previous page geometry and selection.
      setLines([])
      setPage(null)
      // The new document's page PNG does not exist yet: start from the plain URL
      // and bump the version once the upload succeeded.
      setImageVersion(0)
      setSelectedRegionId(null)
      setLocateTarget(null)
      setTransfer({ status: 'validating' })
      try {
        for (const file of files) {
          const result = await runUploadFlow(file, api, {
            signal: flow.controller.signal,
            onPhase: (phase) => {
              if (isCurrentFlow(flow)) setTransfer({ status: phase })
            },
            onPageImage: () => {
              if (isCurrentFlow(flow)) setImageVersion((current) => current + 1)
            },
            onProgress: (progress) => {
              if (isCurrentFlow(flow)) {
                setTransfer({ status: 'uploading', ratio: progress.ratio })
              }
            },
            onDocument: (document) => {
              // Record the target first: a later stale callback must never touch it.
              flow.documentId = document.id
              if (!isCurrentFlow(flow)) return
              dispatch({ type: 'documentLoaded', document, articles: [] })
              // Keep the document visible from the start so a failure is retryable.
              setDocuments((previous) => [
                { meta: document, hasLayout: false, reportCount: 0 },
                ...previous.filter((item) => item.meta.id !== document.id),
              ])
            },
            onJob: (job) => {
              if (isCurrentFlow(flow)) dispatch({ type: 'jobUpdated', job })
            },
          })
          if (!isCurrentFlow(flow)) return
          // Reconcile `Region.articleId` and `Article.regionIds` before the
          // layout becomes editable (single owner per region).
          const layout = reconcileLayout(result.regions, result.articles)
          dispatch({
            type: 'layoutLoaded',
            regions: layout.regions,
            articles: layout.articles,
            warnings: result.warnings,
          })
          // Task 18: keep the parsed page geometry + lines for canvas edits
          // (`splitRegion` partitions the region's line ids from this list).
          setLines(result.lines)
          setPage(result.page)
          setSelectedRegionId(null)
          const documentId = result.document.id
          setDocuments((previous) =>
            previous.map((item) =>
              item.meta.id === documentId
                ? {
                    ...item,
                    meta: { ...item.meta, status: 'ready' },
                    hasLayout: layout.articles.length > 0,
                  }
                : item,
            ),
          )
        }
      } catch (error) {
        // A cancelled/superseded flow must not paint errors into a new document.
        if (!isCurrentFlow(flow)) return
        if (flow.documentId !== null) {
          const failedId = flow.documentId
          setDocuments((previous) =>
            previous.map((item) =>
              item.meta.id === failedId
                ? { ...item, meta: { ...item.meta, status: 'failed' } }
                : item,
            ),
          )
        }
        // A user cancel is not an error: cancelTransfer already reset the view.
        if (!isAbortError(error)) {
          dispatch({ type: 'errorSet', error: describeUploadError(error, t) })
        }
      } finally {
        // Identity guard: never reset a newer flow's banner or controller.
        if (flowRef.current === flow) {
          flowRef.current = null
          if (mountedRef.current) setTransfer({ status: 'idle' })
        }
      }
    },
    [api, flushLayoutSave, isCurrentFlow, t],
  )

  const cancelTransfer = useCallback((): void => {
    const flow = flowRef.current
    flowRef.current = null
    activityRef.current += 1
    flow?.controller.abort()
    const job = state.job
    if (job !== null && (job.status === 'queued' || job.status === 'running')) {
      void api.cancelJob(job.id).catch(() => undefined)
    }
    if (state.document !== null) {
      const documentId = state.document.id
      setDocuments((previous) =>
        previous.map((item) =>
          item.meta.id === documentId
            ? { ...item, meta: { ...item.meta, status: 'failed' } }
            : item,
        ),
      )
      dispatch({ type: 'errorSet', error: t('error.cancelled') })
    }
    setTransfer({ status: 'idle' })
  }, [api, state.document, state.job, t])

  const openDocument = useCallback(
    (id: string): void => {
      // Switching the panel while a transfer is parsing/analyzing or a
      // proofread job is running is blocked: the flow owns the workbench until
      // it settles (design §9.3 notice).
      if (flowRef.current !== null || proofreadRef.current !== null) return
      if (state.document?.id === id && state.phase !== 'failed') return
      // Persist pending edits of the document being left before switching.
      void flushLayoutSave().catch(() => undefined)
      const activity = ++activityRef.current
      const isStale = (): boolean =>
        !mountedRef.current || activity !== activityRef.current || flowRef.current !== null
      void api
        .getDocument(id)
        .then((view) => {
          if (isStale()) return
          const layout = reconcileLayout(view.regions ?? [], view.articles ?? [])
          dispatch({
            type: 'documentLoaded',
            document: view.meta,
            articles: layout.articles,
            regions: layout.regions,
          })
          if (view.hasLayout) {
            dispatch({
              type: 'layoutLoaded',
              regions: layout.regions,
              articles: layout.articles,
              warnings: [],
            })
          }
          // Task 18: restore the canvas coordinate space + split line list.
          setPage(pageSizeFor(layout.regions, view.widthPt, view.heightPt))
          setLines(view.lines ?? [])
          // A fresh image version defeats a cached 404/old render from a
          // previous visit of this document.
          setImageVersion((current) => current + 1)
          setSelectedRegionId(null)
          setLocateTarget(null)
        })
        .catch((error: unknown) => {
          if (isStale()) return
          dispatch({ type: 'errorSet', error: describeUploadError(error, t) })
        })
    },
    [api, flushLayoutSave, state.document?.id, state.phase, t],
  )

  const openFilePicker = useCallback((): void => {
    fileInputRef.current?.click()
  }, [])

  const handleFiles = useCallback(
    (files: File[]): void => {
      void runFiles(files)
    },
    [runFiles],
  )

  const handleRetry = useCallback((): void => {
    const file = lastFileRef.current
    if (file !== null) void runFiles([file])
  }, [runFiles])

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? [])
    // Allow re-selecting the same file later.
    event.currentTarget.value = ''
    handleFiles(files)
  }

  /* ----------------------------------------------------------------------- */
  /* Layout editing (Task 18; design §6.5/§9.4)                              */
  /* ----------------------------------------------------------------------- */

  /** Page geometry of the canvas (parsed/restored size, else region extent). */
  const canvasPage = useMemo<PageSize>(
    () => page ?? pageSizeFor(state.regions),
    [page, state.regions],
  )

  /** Edits are only allowed once the layout reached `ready` (design §9.3). */
  const canEditLayout = state.phase === 'ready'

  /**
   * Apply one user edit: snapshot the current layout for undo/redo, reconcile
   * `Region.articleId` ↔ `Article.regionIds`, replace the reducer layout and
   * schedule the debounced `POST /layout`.
   */
  const commitLayout = useCallback(
    (regions: Region[], articles: Article[]): void => {
      const normalized = reconcileLayout(regions, articles)
      setHistory((previous) => ({
        past: [...previous.past, { regions: state.regions, articles: state.articles }].slice(
          -HISTORY_LIMIT,
        ),
        future: [],
      }))
      dispatch({
        type: 'layoutLoaded',
        regions: normalized.regions,
        articles: normalized.articles,
        warnings: state.warnings,
      })
      if (state.document !== null) {
        saver.schedule(state.document.id, normalized)
      }
    },
    [saver, state.articles, state.document, state.regions, state.warnings],
  )

  /** Replay one undo/redo snapshot (already reconciled when snapshotted). */
  const applyHistorySnapshot = useCallback(
    (snapshot: LayoutSnapshot): void => {
      const normalized = reconcileLayout(snapshot.regions, snapshot.articles)
      dispatch({
        type: 'layoutLoaded',
        regions: normalized.regions,
        articles: normalized.articles,
        warnings: state.warnings,
      })
      if (state.document !== null) {
        saver.schedule(state.document.id, normalized)
      }
    },
    [saver, state.document, state.warnings],
  )

  const handleUndo = useCallback((): void => {
    if (!canEditLayout || history.past.length === 0) return
    const previous = history.past[history.past.length - 1]
    setHistory({
      past: history.past.slice(0, -1),
      future: [
        ...history.future,
        { regions: state.regions, articles: state.articles },
      ].slice(-HISTORY_LIMIT),
    })
    applyHistorySnapshot(previous)
  }, [applyHistorySnapshot, canEditLayout, history, state.articles, state.regions])

  const handleRedo = useCallback((): void => {
    if (!canEditLayout || history.future.length === 0) return
    const next = history.future[history.future.length - 1]
    setHistory({
      past: [...history.past, { regions: state.regions, articles: state.articles }].slice(
        -HISTORY_LIMIT,
      ),
      future: history.future.slice(0, -1),
    })
    applyHistorySnapshot(next)
  }, [applyHistorySnapshot, canEditLayout, history, state.articles, state.regions])

  // Ctrl/Cmd+Z = undo, Shift+Ctrl/Cmd+Z = redo (toolbar buttons are the visible
  // alternative; text fields keep their native undo so typing is not hijacked).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return
      }
      event.preventDefault()
      if (event.shiftKey) handleRedo()
      else handleUndo()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleRedo, handleUndo])

  const handleSelectRegion = useCallback((regionId: string): void => {
    setSelectedRegionId(regionId)
  }, [])

  const handleMoveRegion = useCallback(
    (regionId: string, dx: number, dy: number): void => {
      if (!canEditLayout) return
      const region = state.regions.find((candidate) => candidate.id === regionId)
      if (region === undefined) return
      // Task 3: `moveRegion` clamps the translated box into the page.
      const moved = moveRegion(region, dx, dy, canvasPage)
      commitLayout(
        state.regions.map((candidate) => (candidate.id === regionId ? moved : candidate)),
        state.articles,
      )
    },
    [canEditLayout, canvasPage, commitLayout, state.articles, state.regions],
  )

  const handleResizeRegion = useCallback(
    (regionId: string, bbox: BBox): void => {
      if (!canEditLayout) return
      const region = state.regions.find((candidate) => candidate.id === regionId)
      if (region === undefined) return
      // Task 3: `resizeRegion` normalizes + clamps the absolute box to the page.
      const resized = resizeRegion(region, bbox, canvasPage)
      commitLayout(
        state.regions.map((candidate) => (candidate.id === regionId ? resized : candidate)),
        state.articles,
      )
    },
    [canEditLayout, canvasPage, commitLayout, state.articles, state.regions],
  )

  const handleChangeRegion = useCallback(
    (change: RegionChange): void => {
      if (!canEditLayout || selectedRegionId === null) return
      const region = state.regions.find((candidate) => candidate.id === selectedRegionId)
      if (region === undefined) return
      let next: Region = region
      if (change.kind !== undefined) {
        next = { ...next, kind: change.kind, source: 'manual' }
      }
      if (change.bbox !== undefined) {
        next = resizeRegion(next, { ...next.bbox, ...change.bbox }, canvasPage)
      }
      if (next === region) return
      commitLayout(
        state.regions.map((candidate) => (candidate.id === region.id ? next : candidate)),
        state.articles,
      )
    },
    [canEditLayout, canvasPage, commitLayout, selectedRegionId, state.articles, state.regions],
  )

  const handleMergeNext = useCallback((): void => {
    if (!canEditLayout || selectedRegionId === null) return
    const ordered = sortRegionsByOrder(state.regions)
    const index = ordered.findIndex((candidate) => candidate.id === selectedRegionId)
    if (index < 0 || index + 1 >= ordered.length) return
    const first = ordered[index]
    const second = ordered[index + 1]
    // Task 3 contract: page-clamp both boxes before merging, then union them.
    const merged = mergeRegions(
      resizeRegion(first, first.bbox, canvasPage),
      resizeRegion(second, second.bbox, canvasPage),
    )
    const layout = mergeRegionsIntoLayout(
      state.regions,
      state.articles,
      first.id,
      second.id,
      merged,
    )
    commitLayout(layout.regions, layout.articles)
  }, [canEditLayout, canvasPage, commitLayout, selectedRegionId, state.articles, state.regions])

  const handleSplitRegion = useCallback(
    (splitBBox: BBox): void => {
      if (!canEditLayout || selectedRegionId === null) return
      const region = state.regions.find((candidate) => candidate.id === selectedRegionId)
      if (region === undefined) return
      // Task 3 contract: page-clamp the region before the split, allow only a
      // straight cut (full width or full height), and pass the document's line
      // list so line ids are partitioned by line centre. Note: the implemented
      // `splitRegion(region, splitBBox, lines)` has no page parameter — the
      // clamp is applied to the region here, per `edit.ts`'s documented contract.
      const clamped = resizeRegion(region, region.bbox, canvasPage)
      if (!isStraightCut(clamped, splitBBox)) return
      let parts: [Region, Region]
      try {
        parts = splitRegion(clamped, splitBBox, lines)
      } catch (error) {
        if (error instanceof RangeError) return
        throw error
      }
      // Task 18 fix round: the second part gets a unique id and both parts are
      // inserted immediately after the source region (0..n-1 renumbering).
      const layout = splitRegionsIntoLayout(
        state.regions,
        state.articles,
        region.id,
        parts[0],
        parts[1],
      )
      commitLayout(layout.regions, layout.articles)
      setSelectedRegionId(parts[0].id)
    },
    [
      canEditLayout,
      canvasPage,
      commitLayout,
      lines,
      selectedRegionId,
      state.articles,
      state.regions,
    ],
  )

  const handleDeleteRegion = useCallback((): void => {
    if (!canEditLayout || selectedRegionId === null) return
    const region = state.regions.find((candidate) => candidate.id === selectedRegionId)
    if (region === undefined) return
    const layout = deleteRegionFromLayout(state.regions, state.articles, region.id)
    setSelectedRegionId(null)
    commitLayout(layout.regions, layout.articles)
  }, [canEditLayout, commitLayout, selectedRegionId, state.articles, state.regions])

  const handleReorderRegion = useCallback(
    (direction: 'up' | 'down'): void => {
      if (!canEditLayout || selectedRegionId === null) return
      // `reorderRegion` renumbers `order` 0..n-1 and leaves edge moves unchanged.
      commitLayout(reorderRegion(state.regions, selectedRegionId, direction), state.articles)
    },
    [canEditLayout, commitLayout, selectedRegionId, state.articles, state.regions],
  )

  /** Region assignment from the inspector: updates both sides, never shares. */
  const handleAssignRegion = useCallback(
    (articleId: string | null): void => {
      if (!canEditLayout || selectedRegionId === null) return
      const layout = assignRegionToArticle(
        state.regions,
        state.articles,
        selectedRegionId,
        articleId,
      )
      commitLayout(layout.regions, layout.articles)
    },
    [canEditLayout, commitLayout, selectedRegionId, state.articles, state.regions],
  )

  /** Inline article text edit (title/byline/body); persisted by `saveLayout`. */
  const handleChangeArticle = useCallback(
    (articleId: string, change: ArticleTextChange): void => {
      if (!canEditLayout) return
      const articles = state.articles.map((article) => {
        if (article.id !== articleId) return article
        const next = { ...article, ...change }
        return { ...next, fullText: renderArticleFullText(next) }
      })
      commitLayout(state.regions, articles)
    },
    [canEditLayout, commitLayout, state.articles, state.regions],
  )

  /* ----------------------------------------------------------------------- */
  /* Explicit article selection (never populated automatically)              */
  /* ----------------------------------------------------------------------- */

  const handleToggleArticle = useCallback(
    (articleId: string): void => {
      const selected = state.selectedArticleIds.includes(articleId)
      dispatch({
        type: 'selectionChanged',
        ids: selected
          ? state.selectedArticleIds.filter((id) => id !== articleId)
          : [...state.selectedArticleIds, articleId],
      })
    },
    [state.selectedArticleIds],
  )

  const handleSelectAllArticles = useCallback((): void => {
    dispatch({ type: 'selectionChanged', ids: state.articles.map((article) => article.id) })
  }, [state.articles])

  const handleClearArticles = useCallback((): void => {
    dispatch({ type: 'selectionChanged', ids: [] })
  }, [])

  /* ----------------------------------------------------------------------- */
  /* Explicit proofread action (design §2/§9.4: never starts automatically)  */
  /* ----------------------------------------------------------------------- */

  /**
   * Start the proofread job for the explicitly selected articles.
   *
   * This is the **only** place `/proofread` is called. The function is bound to
   * the panel's start button, guards every precondition again (document, phase,
   * selection, no flow/job in flight) and uses the Task 18 API seam whose
   * `proofread` awaits `flushLayoutSave`, so the Host always proofs the layout
   * the user currently sees.
   */
  const startProofread = useCallback((): void => {
    if (flowRef.current !== null || proofreadRef.current !== null) return
    if (state.document === null || state.selectedArticleIds.length === 0) return
    if (state.phase !== 'ready' && state.phase !== 'report') return

    const token: ProofreadToken = {
      controller: new AbortController(),
      jobId: '',
      cancelled: false,
      lastJob: null,
    }
    proofreadRef.current = token
    proofreadFactCheckRef.current = factCheck
    setProofStarting(true)
    setProofNotice(null)
    setProofError(null)

    const request: ProofreadRequest = {
      docId: state.document.id,
      articleIds: [...state.selectedArticleIds],
      depth,
      factCheck,
    }
    const pollOptions: UploadFlowOptions = {
      signal: token.controller.signal,
      pollIntervalMs: props.proofreadPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      onJob: (job) => {
        token.lastJob = job
        // A failed job is handled by the catch below: dispatching it as a job
        // update would switch the whole workbench to the upload `failed` phase.
        if (job.status === 'failed') return
        if (mountedRef.current && proofreadRef.current === token) {
          dispatch({ type: 'jobUpdated', job })
        }
      },
    }

    void (async () => {
      try {
        const { jobId } = await api.proofread(request, token.controller.signal)
        token.jobId = jobId
        const job = await pollJob(jobId, api, pollOptions, 'proofread')
        if (!mountedRef.current || proofreadRef.current !== token) return
        dispatch({ type: 'reportLoaded', report: readProofreadReport(job.result) })
      } catch (error) {
        if (proofreadRef.current !== token) return
        if (isAbortError(error)) {
          if (token.cancelled && mountedRef.current) {
            // A user cancel returns to `ready` with a notice, never to `failed`.
            if (token.lastJob !== null) {
              dispatch({ type: 'jobUpdated', job: { ...token.lastJob, status: 'cancelled' } })
            }
            setProofNotice(t('proof.cancelled'))
          } else if (mountedRef.current) {
            // The Host cancelled the job itself (e.g. document deleted): keep the
            // document usable and say so instead of leaving the spinner running.
            dispatch({ type: 'proofreadFailed' })
            setProofNotice(t('proof.cancelled'))
          }
          return
        }
        if (!mountedRef.current) return
        if (token.jobId === '') {
          // The job never started (e.g. the layout save flush failed): keep the
          // workbench usable and show the reason inside the panel.
          dispatch({ type: 'proofreadFailed' })
          setProofError(t('proof.startFailed', { message: describeUploadError(error, t) }))
          return
        }
        // The job did start: never fall through to the upload `failed` phase.
        // Ask the Host to stop a possibly still-running job, then return to the
        // usable workbench with a proofread-specific error + retry action.
        void api.cancelJob(token.jobId).catch(() => undefined)
        dispatch({ type: 'proofreadFailed' })
        const detail = error instanceof Error && error.message !== '' ? error.message : String(error)
        setProofError(t('proof.failed', { message: detail }))
      } finally {
        if (proofreadRef.current === token) proofreadRef.current = null
        if (mountedRef.current) setProofStarting(false)
      }
    })()
  }, [
    api,
    depth,
    factCheck,
    props.proofreadPollIntervalMs,
    state.document,
    state.phase,
    state.selectedArticleIds,
    t,
  ])

  /** Cancel the running proofread job (aborts the poll and asks the Host to stop). */
  const cancelProofread = useCallback((): void => {
    const token = proofreadRef.current
    if (token === null) return
    token.cancelled = true
    token.controller.abort()
    if (token.jobId !== '') {
      void api.cancelJob(token.jobId).catch(() => undefined)
    }
    setProofNotice(null)
  }, [api])

  /**
   * Accept/reject/defer only changes the report state, never the article text.
   *
   * The newest report is read from `reportRef` and written back synchronously:
   * a batch accept calls this several times within one event, and building every
   * update from the same stale `state.report` would drop all but the last change.
   */
  const handleFindingStatusChange = useCallback(
    (findingId: string, status: Finding['status']): void => {
      const current = reportRef.current ?? state.report
      if (current === null) return
      const next: Report = {
        ...current,
        findings: current.findings.map((finding) =>
          finding.id === findingId ? { ...finding, status } : finding,
        ),
      }
      reportRef.current = next
      dispatch({ type: 'reportLoaded', report: next })
    },
    [state.report],
  )

  /** Switch the right-column tab (selection state lives in the reducer). */
  const handleAsideTab = useCallback((tab: AsideTab): void => {
    setAsideTab(tab)
  }, [])

  const toggleAside = useCallback((): void => {
    setAsideOpen((open) => !open)
  }, [])

  const closeAside = useCallback((): void => {
    setAsideOpen(false)
  }, [])

  /** Arrow-key navigation of the WAI-ARIA tablist (focus follows selection). */
  const handleTabListKeyDown = useCallback(
    (event: { key: string; preventDefault: () => void }): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const next: AsideTab = asideTab === 'articles' ? 'proofread' : 'articles'
      setAsideTab(next)
      if (next === 'articles') articlesTabRef.current?.focus()
      else proofreadTabRef.current?.focus()
    },
    [asideTab],
  )

  /**
   * Card → canvas locate (Task 19b; design §9.4): select the finding's article
   * and region, scroll the canvas to the region box and pulse it for
   * `locateHighlightMs`. The report findings/statuses and the article text are
   * not touched.
   */
  const handleLocateFinding = useCallback(
    (finding: Finding): void => {
      const location = locateFinding(finding, state.articles, state.regions, lines)
      if (location === null) return
      // "Sets the selected article": the article list selection follows the
      // located finding (this is an explicit user action, never automatic).
      dispatch({ type: 'selectionChanged', ids: [location.articleId] })
      setSelectedRegionId(location.regionId)
      const targetRegion =
        location.regionId === null
          ? undefined
          : state.regions.find((region) => region.id === location.regionId)
      const token = ++locateTokenRef.current
      setLocateTarget({
        token,
        location: {
          ...location,
          regionIds: location.regionIds.length === 0 ? NO_REGION_IDS : location.regionIds,
        },
        regionLabel: targetRegion === undefined ? null : t(`region.kind.${targetRegion.kind}`),
      })
      if (location.regionId === null) return
      const regionId = location.regionId
      const scrollToRegion = (): void => {
        if (!mountedRef.current || typeof document === 'undefined') return
        const element = Array.from(document.querySelectorAll('[data-lgp-region-id]')).find(
          (candidate) => candidate.getAttribute('data-lgp-region-id') === regionId,
        ) as HTMLElement | undefined
        if (element !== undefined && typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ block: 'center', inline: 'center' })
        }
      }
      // Wait for the selection/highlight render before scrolling.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scrollToRegion)
      else setTimeout(scrollToRegion, 0)
    },
    [lines, state.articles, state.regions, t],
  )

  /**
   * Copy the report Markdown through the shared Task 7 renderer (the same
   * renderer the Host export uses), so the clipboard text cannot drift from the
   * exported document.
   */
  const handleCopyReport = useCallback(async (): Promise<boolean> => {
    if (state.report === null) return false
    // The footer version comes from `/meta` (the Host's own package version);
    // before `/meta` was loaded the renderer falls back to the manifest default.
    return copyToClipboard(renderReportMarkdown(state.report, state.articles, meta?.version))
  }, [meta?.version, state.articles, state.report])

  /* ----------------------------------------------------------------------- */
  /* Settings drawer (only runtime-effective settings; design §11.2)         */
  /* ----------------------------------------------------------------------- */

  const openSettings = useCallback((): void => {
    setSettingsOpen(true)
  }, [])

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
  }, [])

  const loadSettings = useCallback(async (): Promise<void> => {
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      const [metaView, settingsView] = await Promise.all([api.getMeta(), api.getSettings()])
      if (!mountedRef.current) return
      setMeta(metaView)
      setSettings(settingsView)
    } catch (error) {
      if (!mountedRef.current) return
      setSettingsError(describeUploadError(error, t))
    } finally {
      if (mountedRef.current) setSettingsLoading(false)
    }
  }, [api, t])

  // Lazy load: the panel never touches `/meta` or `/settings` until the user
  // opens the settings drawer (mounting the empty workbench stays network-free).
  useEffect(() => {
    if (!settingsOpen || settingsAttemptedRef.current) return
    settingsAttemptedRef.current = true
    void loadSettings()
  }, [loadSettings, settingsOpen])

  const handleRetrySettings = useCallback((): void => {
    void loadSettings()
  }, [loadSettings])

  const handleSaveSettings = useCallback(
    async (patch: SettingsPatch): Promise<void> => {
      await api.saveSettings(patch)
      setSettings((current) => (current === null ? current : { ...current, ...patch }))
      if (patch.depth !== undefined) {
        depthTouchedRef.current = true
        setDepth(patch.depth)
      }
      if (patch.factCheck !== undefined) {
        factCheckTouchedRef.current = true
        setFactCheck(patch.factCheck)
      }
      setSettingsError(null)
    },
    [api],
  )

  /**
   * Seed the explicit start controls from the persisted `/settings` the first
   * time a document reaches `ready` (design §11.2: the user's saved depth/联网
   * preference are the defaults of the next run). Only `/settings` is read here;
   * the `/meta` model catalogue stays lazy and is fetched when the settings
   * drawer opens. A user who already changed a control wins over a late seed.
   */
  useEffect(() => {
    if (settingsSeededRef.current) return
    if (state.document === null || state.phase !== 'ready') return
    settingsSeededRef.current = true
    // Legacy fake/test seams may not implement the settings routes.
    if (typeof api.getSettings !== 'function') return
    void api
      .getSettings()
      .then((view) => {
        if (!mountedRef.current) return
        if (
          !depthTouchedRef.current &&
          (view.depth === 'quick' || view.depth === 'standard' || view.depth === 'deep')
        ) {
          setDepth(view.depth)
        }
        if (!factCheckTouchedRef.current && typeof view.factCheck === 'boolean') {
          setFactCheck(view.factCheck)
        }
      })
      .catch(() => undefined)
  }, [api, state.document, state.phase])

  const handleDepthChange = useCallback((next: Depth): void => {
    depthTouchedRef.current = true
    setDepth(next)
  }, [])

  const handleFactCheckChange = useCallback((next: boolean): void => {
    factCheckTouchedRef.current = true
    setFactCheck(next)
  }, [])

  /** Region ids belonging to the explicitly selected articles (highlight). */
  const highlightedRegionIds = useMemo<string[]>(() => {
    if (state.selectedArticleIds.length === 0) return []
    const selected = new Set(state.selectedArticleIds)
    const ids = new Set<string>()
    for (const article of state.articles) {
      if (!selected.has(article.id)) continue
      for (const regionId of article.regionIds) ids.add(regionId)
    }
    return [...ids]
  }, [state.articles, state.selectedArticleIds])

  /** Located region ids while the locate pulse is active (Task 19b). */
  const locatedRegionIds = locateTarget?.location.regionIds ?? NO_REGION_IDS

  /** Canvas highlight: selected-article regions plus the active locate target. */
  const canvasHighlightedRegionIds = useMemo<string[]>(() => {
    if (locatedRegionIds.length === 0) return highlightedRegionIds
    const merged = new Set(highlightedRegionIds)
    for (const regionId of locatedRegionIds) merged.add(regionId)
    return [...merged]
  }, [highlightedRegionIds, locatedRegionIds])

  /** Locate status text ("已定位：文章 · 区域"); text so the pulse is not colour-only. */
  const locateNotice =
    locateTarget === null
      ? null
      : locateTarget.regionLabel === null
        ? t('report.locateNoticeArticle', { article: locateTarget.location.articleTitle })
        : t('report.locateNotice', {
            article: locateTarget.location.articleTitle,
            region: locateTarget.regionLabel,
          })

  const orderedRegions = useMemo(() => sortRegionsByOrder(state.regions), [state.regions])
  const selectedRegion =
    selectedRegionId === null
      ? null
      : (state.regions.find((region) => region.id === selectedRegionId) ?? null)
  const selectedOrderIndex =
    selectedRegionId === null
      ? -1
      : orderedRegions.findIndex((region) => region.id === selectedRegionId)
  const canMergeNext =
    selectedOrderIndex >= 0 && selectedOrderIndex < orderedRegions.length - 1
  const canReorderUp = selectedOrderIndex > 0
  const canReorderDown =
    selectedOrderIndex >= 0 && selectedOrderIndex < orderedRegions.length - 1
  const canUndo = canEditLayout && history.past.length > 0
  const canRedo = canEditLayout && history.future.length > 0

  /**
   * Layout warnings (design §6.5) recomputed from the current regions/articles:
   * overlaps, unassigned regions, empty articles and out-of-page boxes.
   */
  const layoutWarnings = useMemo(
    () => computeLayoutWarnings(state.regions, state.articles, canvasPage),
    [canvasPage, state.articles, state.regions],
  )
  const selectedRegionWarnings =
    selectedRegion === null ? undefined : regionWarningFlags(layoutWarnings, selectedRegion.id)

  const transferLabel = transfer.status === 'idle' ? null : t(TRANSFER_KEYS[transfer.status])
  const transferPercent =
    transfer.status === 'uploading' && transfer.ratio !== undefined
      ? Math.round(transfer.ratio * 100)
      : transfer.status === 'analyzing' && state.job?.kind === 'layout'
        ? Math.round(state.job.progress * 100)
        : null
  /**
   * The canvas may mount as soon as the document metadata exists, before
   * `POST /page-image` finishes. `imageVersion === 0` on that path means the
   * PNG is not readable yet; rendering the placeholder avoids a transient 404
   * request for the page image. Opening a stored document bumps the version.
   */
  const imageReady = state.document !== null && imageVersion > 0

  /** A proofread job is queued/running (blocks uploads, switching and start). */
  const proofreadActive =
    state.phase === 'proofreading' &&
    state.job?.kind === 'proofread' &&
    (state.job.status === 'queued' || state.job.status === 'running')
  /** Any long-running activity the header/rail must not disturb. */
  const activityBusy = transfer.status !== 'idle' || proofreadActive
  /** The panel can start only when the layout is ready and nothing is running. */
  const canStartProofread =
    (state.phase === 'ready' || state.phase === 'report') &&
    transfer.status === 'idle' &&
    !proofreadActive
  /** The proofread job snapshot shown in the panel (hidden once a report exists). */
  const visibleProofreadJob =
    state.phase !== 'report' && state.job?.kind === 'proofread' ? state.job : undefined
  /** Start request in flight: a queued placeholder keeps cancel reachable. */
  const panelProofreadJob =
    visibleProofreadJob ?? (proofStarting ? PROOFREAD_STARTING_JOB : undefined)

  const showEmptyState = state.document === null
  const showFailedPanel = state.document !== null && state.phase === 'failed'

  return (
    <div
      className="lgp-root"
      data-lgp-part="root"
      data-lgp-phase={state.phase}
      data-lgp-document-id={state.document?.id}
      data-lgp-article-count={state.articles.length}
    >
      <style>{clientStyles}</style>
      <Header
        name={name}
        tagline={t('subtitle')}
        documentName={state.document?.fileName}
        uploadLabel={t('header.upload')}
        cancelLabel={t('header.cancel')}
        settingsLabel={t('header.settings')}
        busy={activityBusy}
        onUpload={openFilePicker}
        onCancel={transfer.status !== 'idle' ? cancelTransfer : undefined}
        onSettings={openSettings}
      />
      {settingsOpen ? (
        <div
          className="lgp-settings-overlay"
          data-lgp-part="settings-overlay"
          onClick={(event) => {
            // Task 24: the workbench stays visible behind a dimmed/blurred
            // backdrop; clicking it (outside the drawer) closes the settings.
            if (event.target === event.currentTarget) closeSettings()
          }}
        >
          <SettingsDrawer
            settings={settings}
            catalogue={meta?.modelCatalogue ?? null}
            loading={settingsLoading || (settings === null && settingsError === null)}
            loadError={settingsError}
            onRetry={handleRetrySettings}
            onSave={handleSaveSettings}
            onClose={closeSettings}
            t={t}
          />
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        className="lgp-file-input"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        aria-label={t('a11y.uploadInput')}
        onChange={handleFileInput}
      />
      {transferLabel === null ? null : (
        <TransferBanner
          label={transferLabel}
          percent={transferPercent}
          progressLabel={t('a11y.progress')}
        />
      )}
      <div className="lgp-body" data-lgp-part="body">
        <DocumentRail
          documents={documents}
          activeId={state.document?.id}
          title={t('rail.title')}
          emptyLabel={t('rail.empty')}
          uploadLabel={t('rail.upload')}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsed((value) => !value)}
          collapseLabel={t('rail.collapse')}
          expandLabel={t('rail.expand')}
          busy={activityBusy}
          statusLabels={{
            parsing: t('rail.status.parsing'),
            ready: t('rail.status.ready'),
            failed: t('rail.status.failed'),
          }}
          onOpen={openDocument}
          onUpload={openFilePicker}
        />
        <main className="lgp-center" data-lgp-part="center">
          {showEmptyState ? null : (
            <div className="lgp-drawer-bar" data-lgp-part="drawer-bar">
              <button
                type="button"
                className="lgp-button lgp-aside-toggle"
                aria-expanded={asideOpen}
                aria-controls="lgp-aside"
                aria-label={t('aside.toggleLabel')}
                onClick={toggleAside}
              >
                {t('aside.toggle')}
              </button>
            </div>
          )}
          {showEmptyState ? (
            <EmptyState
              name={name}
              lead={t('empty.lead')}
              dropHint={t('empty.dropHint')}
              chooseLabel={t('empty.choose')}
              constraints={t('empty.constraints')}
              dropzoneLabel={t('a11y.dropzone')}
              error={state.error}
              busy={transfer.status !== 'idle'}
              onUpload={openFilePicker}
              onFiles={handleFiles}
            />
          ) : showFailedPanel ? (
            <div className="lgp-error-panel" data-lgp-part="error" role="alert">
              <p className="lgp-error-text">{state.error ?? t('error.parse_failed')}</p>
              <div className="lgp-error-actions">
                {lastFileRef.current === null ? null : (
                  <button
                    type="button"
                    className="lgp-button lgp-button--primary"
                    onClick={handleRetry}
                  >
                    {t('error.retry')}
                  </button>
                )}
                <button type="button" className="lgp-button" onClick={openFilePicker}>
                  {t('header.upload')}
                </button>
              </div>
            </div>
          ) : (
            <section
              className="lgp-workspace"
              data-lgp-part="workspace"
              data-lgp-locate-active={locateTarget === null ? undefined : 'true'}
            >
              <Canvas
                imageUrl={
                  state.document === null
                    ? ''
                    : imageVersion > 0
                      ? pageImageUrl(state.document.id, imageVersion)
                      : pageImageUrl(state.document.id)
                }
                imageReady={imageReady}
                page={canvasPage}
                regions={state.regions}
                selectedRegionId={selectedRegionId}
                highlightedRegionIds={canvasHighlightedRegionIds}
                onSelectRegion={handleSelectRegion}
                onMoveRegion={handleMoveRegion}
                onResizeRegion={handleResizeRegion}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={handleUndo}
                onRedo={handleRedo}
                t={t}
              />
              {locateNotice === null ? null : (
                <p
                  className="lgp-locate-status"
                  data-lgp-locate-active="true"
                  role="status"
                  aria-live="polite"
                >
                  {locateNotice}
                </p>
              )}
              <p className="lgp-canvas-status" data-lgp-part="canvas-status" role="status">
                <span>{state.phase === 'ready' ? t('view.ready') : t('view.analyzing')}</span>
                <span aria-hidden="true"> · </span>
                <span>{t('view.articleCount', { count: state.articles.length })}</span>
                <span aria-hidden="true"> · </span>
                <span>{t('canvas.regionCount', { count: state.regions.length })}</span>
                {state.warnings.length > 0 ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span>{t('view.warningCount', { count: state.warnings.length })}</span>
                  </>
                ) : null}
                {saveStatus === 'idle' ? null : (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="lgp-save-status" data-lgp-save-status={saveStatus}>
                      {t(SAVE_STATUS_KEYS[saveStatus])}
                    </span>
                  </>
                )}
              </p>
            </section>
          )}
        </main>
        {state.document === null ? null : asideOpen ? (
          <div
            className="lgp-drawer-backdrop"
            data-lgp-part="drawer-backdrop"
            aria-hidden="true"
            onClick={closeAside}
          />
        ) : null}
        {state.document === null ? null : (
          <aside
            id="lgp-aside"
            className="lgp-aside"
            data-lgp-part="aside"
            data-lgp-drawer-open={asideOpen ? 'true' : 'false'}
            data-lgp-active-tab={asideTab}
            aria-label={t('aside.label')}
          >
            <div
              className="lgp-aside-tabs"
              role="tablist"
              aria-label={t('tabs.label')}
              onKeyDown={handleTabListKeyDown}
            >
              <button
                ref={articlesTabRef}
                type="button"
                role="tab"
                id="lgp-tab-articles"
                className="lgp-aside-tab"
                aria-selected={asideTab === 'articles'}
                aria-controls="lgp-tab-panel-articles"
                tabIndex={asideTab === 'articles' ? 0 : -1}
                onClick={() => handleAsideTab('articles')}
              >
                {t('tabs.articles')}
              </button>
              <button
                ref={proofreadTabRef}
                type="button"
                role="tab"
                id="lgp-tab-proofread"
                className="lgp-aside-tab"
                aria-selected={asideTab === 'proofread'}
                aria-controls="lgp-tab-panel-proofread"
                tabIndex={asideTab === 'proofread' ? 0 : -1}
                onClick={() => handleAsideTab('proofread')}
              >
                {t('tabs.proofread')}
              </button>
              <button
                type="button"
                className="lgp-aside-close"
                aria-label={t('aside.close')}
                onClick={closeAside}
              >
                ×
              </button>
            </div>
            <div
              role="tabpanel"
              id="lgp-tab-panel-articles"
              aria-labelledby="lgp-tab-articles"
              data-lgp-tab-panel="articles"
              className="lgp-aside-panel"
              hidden={asideTab !== 'articles'}
            >
              <section
                className="lgp-aside-section"
                data-lgp-slot="article-list"
                data-lgp-article-count={state.articles.length}
              >
                <ArticleList
                  articles={state.articles}
                  selectedIds={state.selectedArticleIds}
                  onToggle={handleToggleArticle}
                  onSelectAll={handleSelectAllArticles}
                  onClear={handleClearArticles}
                  warnings={layoutWarnings}
                  onChangeArticle={handleChangeArticle}
                  t={t}
                />
              </section>
              {selectedRegion === null ? null : (
                <section className="lgp-aside-section" data-lgp-slot="region-inspector">
                  <RegionInspector
                    region={selectedRegion}
                    onChange={handleChangeRegion}
                    onMerge={handleMergeNext}
                    onSplit={handleSplitRegion}
                    onDelete={handleDeleteRegion}
                    onReorder={handleReorderRegion}
                    articles={state.articles}
                    onAssignArticle={handleAssignRegion}
                    warnings={selectedRegionWarnings}
                    canMerge={canMergeNext}
                    canReorderUp={canReorderUp}
                    canReorderDown={canReorderDown}
                    onClose={() => setSelectedRegionId(null)}
                    t={t}
                  />
                </section>
              )}
            </div>
            <div
              role="tabpanel"
              id="lgp-tab-panel-proofread"
              aria-labelledby="lgp-tab-proofread"
              data-lgp-tab-panel="proofread"
              className="lgp-aside-panel"
              hidden={asideTab !== 'proofread'}
            >
              <section className="lgp-aside-section" data-lgp-slot="proofread-panel">
                <ProofreadPanel
                  selectedCount={state.selectedArticleIds.length}
                  articleCount={state.articles.length}
                  depth={depth}
                  factCheck={factCheck}
                  disabled={!canStartProofread}
                  onDepthChange={handleDepthChange}
                  onFactCheckChange={handleFactCheckChange}
                  onStart={startProofread}
                  job={panelProofreadJob}
                  onCancel={cancelProofread}
                  notice={proofNotice ?? undefined}
                  error={proofError ?? undefined}
                  onRetry={startProofread}
                  failedRoles={state.report?.failedRoles}
                  t={t}
                />
                {state.phase === 'report' && state.report !== null ? (
                  <ReportView
                    key={state.report.jobId}
                    report={state.report}
                    articles={state.articles}
                    offline={
                      proofreadFactCheckRef.current === false &&
                      state.report.factCheckMode === undefined
                        ? true
                        : undefined
                    }
                    onStatusChange={handleFindingStatusChange}
                    onLocate={handleLocateFinding}
                    onCopy={handleCopyReport}
                    t={t}
                  />
                ) : null}
              </section>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

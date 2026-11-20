/**
 * Tests for the Host HTTP API seam (Task 14): the shared protocol constants
 * (`src/shared/api/protocol.ts`), the request/response helpers
 * (`src/host/api/http.ts`) and the exact-path handlers
 * (`src/host/api/handlers.ts`).
 *
 * Every dependency is a fake (`DocumentStore`, `JobOrchestrator`) so no
 * filesystem, model or network is touched. The tests pin the design contract
 * (§10.2): exact paths, content-type/body-cap validation, id validation, the
 * single-page upload guard, error codes, cancel-before-delete, report export and
 * the fact that no handler reaches outside its documented dependency calls.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  Article,
  Depth,
  DocumentMeta,
  DocumentRecord,
  PageTextInput,
  Region,
  Report,
} from '../../src/shared/types'
import {
  API_PATHS,
  API_PREFIX,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type DocumentView,
  type MetaView,
  type ModelCatalogue,
  type UploadDocumentResponse,
} from '../../src/shared/api/protocol'
import {
  ApiRequestError,
  errorResponse,
  jsonResponse,
  readBoundedBody,
  readJson,
} from '../../src/host/api/http'
import { createHandlers, type HandlerDeps } from '../../src/host/api/handlers'
import type { JobState } from '../../src/host/proof/orchestrator'
import { DocumentNotFoundError } from '../../src/host/services/store'
import type { DocumentStore, Settings } from '../../src/host/services/store'
import { DEFAULT_SETTINGS, SettingsValidationError } from '../../src/host/services/settings'

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* ------------------------------------------------------------------------- */

const BASE_URL = 'http://localhost'
const DOC_ID = 'doc_1700000000000_abcdef'
const OTHER_DOC_ID = 'doc_1700000000001_abcdef'
const JOB_ID = 'job_1700000000000_abcdef'
const VERSION = '0.1.0'
const MODEL = { provider: 'deepseek-official', model: 'deepseek-flash' }
const PROMPT_VERSION = 'pv_0123456789ab'
const LIMITS = { maxUploadBytes: 1024, maxImageBytes: 1024, maxJsonBytes: 4096 }

const PDF_HEADER = '%PDF-1.4'
const ONE_PAGE_PDF = `${PDF_HEADER}\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Pages >> endobj\n%%EOF`
const TWO_PAGE_PDF = `${PDF_HEADER}\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF`

/** A tiny but structurally valid PNG signature followed by filler bytes. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const NOT_A_PNG = new TextEncoder().encode('this is not a png')

function makeMeta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: DOC_ID,
    fileName: 'page.pdf',
    pageCount: 1,
    createdAt: 1,
    status: 'ready',
    ...overrides,
  }
}

function makeRegion(): Region {
  return {
    id: 'r1',
    page: 1,
    kind: 'lead',
    bbox: { x: 10, y: 20, w: 300, h: 100 },
    lineIds: [],
    order: 0,
    confidence: 0.9,
    source: 'vision',
  }
}

function makeArticle(): Article {
  return {
    id: 'a1',
    page: 1,
    role: 'lead',
    title: '头条标题',
    body: '本报讯 记者张三报道。',
    regionIds: ['r1'],
    readingOrder: 1,
    confidence: 0.9,
    warnings: [],
  }
}

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    meta: makeMeta(),
    lines: [],
    candidates: [],
    widthPt: 600,
    heightPt: 800,
    regions: [makeRegion()],
    articles: [makeArticle()],
    reportIds: [JOB_ID],
    ...overrides,
  }
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    jobId: JOB_ID,
    docId: DOC_ID,
    articleIds: ['a1'],
    createdAt: 1,
    model: 'deepseek-official/deepseek-flash',
    promptVersion: PROMPT_VERSION,
    depth: 'standard',
    summary: {
      mustFixCount: 1,
      suggestedCount: 0,
      optionalCount: 0,
      factCheck: { confirmed: 1, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
      byCategory: { typo: 1 },
      mustFixList: ['《头条标题》错别字：“他的确” → 他确实'],
    },
    findings: [
      {
        id: 'a1:f1',
        articleId: 'a1',
        category: 'typo',
        severity: 'must_fix',
        quote: '他的确',
        occurrence: 1,
        issue: '错别字',
        suggestion: '他确实',
        confidence: 'high',
        needsHuman: false,
        roles: ['words'],
        status: 'open',
      },
    ],
    factChecks: [
      {
        id: 'a1:fc1',
        articleId: 'a1',
        claim: '日期',
        quote: '2026年',
        kind: 'date',
        verdict: 'confirmed',
        evidence: '官方页面',
        sources: [{ title: '来源', url: 'https://example.com/source' }],
        confidence: 'high',
        needsHuman: false,
      },
    ],
    stats: { calls: 1, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 1 },
    ...overrides,
  }
}

const JOB_STATE: JobState = {
  id: JOB_ID,
  kind: 'layout',
  status: 'running',
  progress: 0.5,
  stages: [
    { id: 'load', label: '读取页面数据', status: 'done' },
    { id: 'analyze', label: '视觉版面分析', status: 'running' },
  ],
}

const PAGE_TEXT: PageTextInput = { lines: [], candidates: [], widthPt: 600, heightPt: 800 }

/* ------------------------------------------------------------------------- */
/* Fake dependencies and harness                                               */
/* ------------------------------------------------------------------------- */

function makeStore() {
  return {
    create: vi.fn(
      async (_input: { fileName: string; pdfBytes: Uint8Array }): Promise<DocumentMeta> =>
        makeMeta(),
    ),
    savePageText: vi.fn(
      async (_id: string, _input: PageTextInput): Promise<void> => undefined,
    ),
    savePageImage: vi.fn(async (_id: string, _png: Uint8Array): Promise<void> => undefined),
    savePageOverlay: vi.fn(async (_id: string, _png: Uint8Array): Promise<void> => undefined),
    saveLayout: vi.fn(
      async (_id: string, _layout: { regions: Region[]; articles: Article[] }): Promise<void> =>
        undefined,
    ),
    getDocument: vi.fn(
      async (_id: string): Promise<DocumentRecord | undefined> => makeDocument(),
    ),
    updateMeta: vi.fn(async (_id: string, _patch: unknown): Promise<DocumentMeta> => makeMeta()),
    getPageImage: vi.fn(async (_id: string): Promise<Uint8Array | undefined> => PNG_BYTES),
    getPageOverlay: vi.fn(async (_id: string): Promise<Uint8Array | undefined> => PNG_BYTES),
    getReport: vi.fn(
      async (_jobOrDocId: string, _maybeJobId?: string): Promise<Report | undefined> => makeReport(),
    ),
    getSettings: vi.fn(async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS })),
    saveSettings: vi.fn(async (_input: unknown): Promise<Settings> => ({ ...DEFAULT_SETTINGS })),
    delete: vi.fn(async (_id: string): Promise<boolean> => true),
  }
}

function makeOrchestrator() {
  return {
    startLayout: vi.fn(async (_input: { docId: string }): Promise<string> => 'job_layout1'),
    startProofread: vi.fn(
      async (_input: {
        docId: string
        articleIds: string[]
        depth: Depth
        factCheck: boolean
      }): Promise<string> => 'job_proof1',
    ),
    get: vi.fn((_jobId: string): JobState | undefined => undefined),
    cancel: vi.fn((_jobId: string): boolean => true),
  }
}

function createHarness(overrides: Pick<HandlerDeps, 'modelCatalogue'> = {}) {
  const store = makeStore()
  const orchestrator = makeOrchestrator()
  const handlers = createHandlers({
    store: store as unknown as DocumentStore,
    orchestrator,
    limits: { ...LIMITS },
    version: VERSION,
    model: { ...MODEL },
    promptVersion: PROMPT_VERSION,
    ...overrides,
  })
  return { store, orchestrator, handlers }
}

/* ------------------------------------------------------------------------- */
/* Request / response helpers                                                  */
/* ------------------------------------------------------------------------- */

function apiRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE_URL}${path}`, init)
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return apiRequest(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function postBinary(
  path: string,
  bytes: Uint8Array | string,
  contentType: string,
  headers: Record<string, string> = {},
): Request {
  return apiRequest(path, {
    method: 'POST',
    body:
      typeof bytes === 'string'
        ? bytes
        : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    headers: { 'content-type': contentType, ...headers },
  })
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function expectError(
  response: Response,
  status: number,
  code: ApiErrorCode,
): Promise<ApiErrorEnvelope> {
  expect(response.status).toBe(status)
  const payload = await responseJson<ApiErrorEnvelope>(response)
  expect(payload.error).toEqual({ code, message: expect.any(String) })
  return payload
}

async function expectApiRequestError(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).status).toBe(status)
    return
  }
  throw new Error(`expected an ApiRequestError with status ${status}`)
}

/** Every object key appearing anywhere in a JSON value (credential-leak check). */
function collectKeys(value: unknown, keys: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
    return keys
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

/* ------------------------------------------------------------------------- */
/* Protocol                                                                    */
/* ------------------------------------------------------------------------- */

describe('protocol path constants', () => {
  it('exposes the exact /api/lgproofreader paths from design §10.2', () => {
    expect(API_PREFIX).toBe('/api/lgproofreader')
    expect(API_PATHS).toEqual({
      uploadDocument: '/api/lgproofreader/documents',
      pageText: '/api/lgproofreader/page-text',
      pageImage: '/api/lgproofreader/page-image',
      pageOverlay: '/api/lgproofreader/page-overlay',
      analyze: '/api/lgproofreader/analyze',
      document: '/api/lgproofreader/document',
      layout: '/api/lgproofreader/layout',
      pageImageGet: '/api/lgproofreader/page-image',
      proofread: '/api/lgproofreader/proofread',
      job: '/api/lgproofreader/job',
      cancel: '/api/lgproofreader/cancel',
      deleteDoc: '/api/lgproofreader/delete',
      meta: '/api/lgproofreader/meta',
      settingsGet: '/api/lgproofreader/settings',
      settingsPost: '/api/lgproofreader/settings',
      exportReport: '/api/lgproofreader/export',
      health: '/api/lgproofreader/health',
    })
  })

  it('uses only exact paths (no dynamic segments)', () => {
    for (const path of Object.values(API_PATHS)) {
      expect(path.startsWith(`${API_PREFIX}/`)).toBe(true)
      expect(path).not.toContain(':')
      expect(path).not.toContain('*')
    }
  })
})

/* ------------------------------------------------------------------------- */
/* HTTP helpers                                                                */
/* ------------------------------------------------------------------------- */

describe('http helpers', () => {
  it('jsonResponse serializes JSON with the requested status', async () => {
    const response = jsonResponse({ ok: true }, 201)
    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await responseJson(response)).toEqual({ ok: true })
  })

  it('errorResponse uses the { error: { code, message } } envelope', async () => {
    const response = errorResponse('not_found', 'document not found', 404)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await responseJson(response)).toEqual({
      error: { code: 'not_found', message: 'document not found' },
    })
  })

  it('readBoundedBody returns the body and accepts exactly the cap', async () => {
    const bytes = await readBoundedBody(
      new Request('http://x/', { method: 'POST', body: '12345' }),
      5,
    )
    expect(Array.from(bytes)).toEqual([0x31, 0x32, 0x33, 0x34, 0x35])
  })

  it('readBoundedBody enforces the cap while streaming', async () => {
    await expectApiRequestError(
      readBoundedBody(new Request('http://x/', { method: 'POST', body: '0123456789' }), 5),
      413,
    )
  })

  it('readBoundedBody rejects an oversized declared content-length without reading', async () => {
    const request = new Request('http://x/', {
      method: 'POST',
      body: '123',
      headers: { 'content-length': '999' },
    })
    await expectApiRequestError(readBoundedBody(request, 5), 413)
  })

  it('readBoundedBody rejects an invalid content-length header', async () => {
    const request = new Request('http://x/', {
      method: 'POST',
      body: '123',
      headers: { 'content-length': 'abc' },
    })
    await expectApiRequestError(readBoundedBody(request, 5), 400)
  })

  it('readJson requires application/json', async () => {
    const request = new Request('http://x/', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'text/plain' },
    })
    await expectApiRequestError(readJson(request, 1024), 415)
  })

  it('readJson rejects malformed JSON and empty bodies', async () => {
    await expectApiRequestError(
      readJson(
        new Request('http://x/', {
          method: 'POST',
          body: '{not json',
          headers: { 'content-type': 'application/json' },
        }),
        1024,
      ),
      400,
    )
    await expectApiRequestError(
      readJson(
        new Request('http://x/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }),
        1024,
      ),
      400,
    )
  })

  it('readJson parses a valid object and accepts charset parameters', async () => {
    const request = new Request('http://x/', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(await readJson(request, 1024)).toEqual({ a: 1 })
  })
})

/* ------------------------------------------------------------------------- */
/* Handler surface                                                             */
/* ------------------------------------------------------------------------- */

describe('createHandlers', () => {
  it('creates exactly the 17 documented handlers', () => {
    const { handlers } = createHarness()
    expect(Object.keys(handlers).sort()).toEqual(
      [
        'uploadDocument',
        'pageText',
        'pageImage',
        'pageOverlay',
        'analyze',
        'document',
        'layout',
        'pageImageGet',
        'proofread',
        'job',
        'cancel',
        'deleteDoc',
        'meta',
        'settingsGet',
        'settingsPost',
        'exportReport',
        'health',
      ].sort(),
    )
    for (const handler of Object.values(handlers)) expect(typeof handler).toBe('function')
  })
})

/* ------------------------------------------------------------------------- */
/* Upload                                                                      */
/* ------------------------------------------------------------------------- */

describe('uploadDocument', () => {
  it('rejects a wrong content type with 415', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      apiRequest(API_PATHS.uploadDocument, {
        method: 'POST',
        body: 'x',
        headers: { 'content-type': 'text/plain' },
      }),
    )
    await expectError(response, 415, 'unsupported_media_type')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('rejects a multipage PDF declared by x-page-count with 422', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      apiRequest(API_PATHS.uploadDocument, {
        method: 'POST',
        body: TWO_PAGE_PDF,
        headers: { 'content-type': 'application/pdf', 'x-page-count': '2' },
      }),
    )
    await expectError(response, 422, 'unprocessable_entity')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('rejects a multipage PDF detected from its bytes with 422', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, TWO_PAGE_PDF, 'application/pdf'),
    )
    await expectError(response, 422, 'unprocessable_entity')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('rejects x-page-count=1 when the bytes contain more page objects', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, TWO_PAGE_PDF, 'application/pdf', {
        'x-page-count': '1',
      }),
    )
    await expectError(response, 422, 'unprocessable_entity')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric x-page-count with 400 and a zero page count with 422', async () => {
    const { handlers } = createHarness()
    const invalid = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, ONE_PAGE_PDF, 'application/pdf', {
        'x-page-count': 'two',
      }),
    )
    await expectError(invalid, 400, 'bad_request')
    const zero = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, ONE_PAGE_PDF, 'application/pdf', {
        'x-page-count': '0',
      }),
    )
    await expectError(zero, 422, 'unprocessable_entity')
  })

  it('reports the actual declared page count even when it is not a safe integer', async () => {
    const { handlers } = createHarness()
    const declared = '99999999999999999999'
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, ONE_PAGE_PDF, 'application/pdf', {
        'x-page-count': declared,
      }),
    )
    const payload = await expectError(response, 422, 'unprocessable_entity')
    expect(payload.error.message).toContain(declared)
    expect(payload.error.message).not.toContain('got 2.')
  })

  it('rejects a body without the %PDF- prefix with 422', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, 'not a pdf at all', 'application/pdf'),
    )
    await expectError(response, 422, 'unprocessable_entity')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('rejects an empty body with 400', async () => {
    const { handlers } = createHarness()
    const response = await handlers.uploadDocument(
      apiRequest(API_PATHS.uploadDocument, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
      }),
    )
    await expectError(response, 400, 'bad_request')
  })

  it('rejects an oversized upload with 413 before touching the store', async () => {
    const { handlers, store } = createHarness()
    const oversized = `${PDF_HEADER}${'x'.repeat(LIMITS.maxUploadBytes + 1)}`
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, oversized, 'application/pdf'),
    )
    await expectError(response, 413, 'payload_too_large')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('accepts a single-page PDF, decodes the file name and returns the meta', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, ONE_PAGE_PDF, 'application/pdf', {
        'x-page-count': '1',
        'x-file-name': encodeURIComponent('报纸 2026.pdf'),
      }),
    )
    expect(response.status).toBe(201)
    expect(await responseJson<UploadDocumentResponse>(response)).toEqual({
      document: makeMeta(),
      pages: 1,
    })
    expect(store.create).toHaveBeenCalledTimes(1)
    const input = store.create.mock.calls[0][0]
    expect(input.fileName).toBe('报纸 2026.pdf')
    expect(input.pdfBytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(input.pdfBytes).startsWith(PDF_HEADER)).toBe(true)
  })

  it('accepts application/octet-stream and defaults the file name', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.uploadDocument(
      postBinary(API_PATHS.uploadDocument, ONE_PAGE_PDF, 'application/octet-stream', {
        'x-page-count': '1',
      }),
    )
    expect(response.status).toBe(201)
    expect(store.create.mock.calls[0][0].fileName).toBe('document.pdf')
  })
})

/* ------------------------------------------------------------------------- */
/* Page text                                                                   */
/* ------------------------------------------------------------------------- */

describe('pageText', () => {
  it('requires the doc query parameter with 400', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.pageText(
      new Request('http://x/api/lgproofreader/page-text', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expectError(response, 400, 'bad_request')
    expect(store.savePageText).not.toHaveBeenCalled()
  })

  it('rejects an invalid doc id with 400', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.pageText(
      postJson(`${API_PATHS.pageText}?doc=${encodeURIComponent('../etc/passwd')}`, PAGE_TEXT),
    )
    await expectError(response, 400, 'bad_request')
    expect(store.savePageText).not.toHaveBeenCalled()
  })

  it('rejects a wrong content type with 415', async () => {
    const { handlers } = createHarness()
    const response = await handlers.pageText(
      apiRequest(`${API_PATHS.pageText}?doc=${DOC_ID}`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'text/plain' },
      }),
    )
    await expectError(response, 415, 'unsupported_media_type')
  })

  it('rejects malformed JSON with 400', async () => {
    const { handlers } = createHarness()
    const response = await handlers.pageText(
      apiRequest(`${API_PATHS.pageText}?doc=${DOC_ID}`, {
        method: 'POST',
        body: '{oops',
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expectError(response, 400, 'bad_request')
  })

  it('rejects invalid page-text shapes with 400', async () => {
    const { handlers, store } = createHarness()
    for (const body of [
      {},
      { lines: 'nope', candidates: [], widthPt: 600, heightPt: 800 },
      { lines: [], candidates: [], widthPt: 'wide', heightPt: 800 },
      { lines: [], candidates: [], widthPt: 600, heightPt: Number.NaN },
    ]) {
      const response = await handlers.pageText(
        postJson(`${API_PATHS.pageText}?doc=${DOC_ID}`, body),
      )
      await expectError(response, 400, 'bad_request')
    }
    expect(store.savePageText).not.toHaveBeenCalled()
  })

  it('saves the parsed page text through the store', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.pageText(
      postJson(`${API_PATHS.pageText}?doc=${DOC_ID}`, PAGE_TEXT),
    )
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: true })
    expect(store.savePageText).toHaveBeenCalledWith(DOC_ID, PAGE_TEXT)
    expect(store.saveLayout).not.toHaveBeenCalled()
  })

  it('rejects an oversized JSON body with 413', async () => {
    const { handlers, store } = createHarness()
    const oversized = {
      lines: [],
      candidates: [],
      widthPt: 600,
      heightPt: 800,
      pad: 'x'.repeat(LIMITS.maxJsonBytes + 1),
    }
    const response = await handlers.pageText(
      postJson(`${API_PATHS.pageText}?doc=${DOC_ID}`, oversized),
    )
    await expectError(response, 413, 'payload_too_large')
    expect(store.savePageText).not.toHaveBeenCalled()
  })

  it('maps a missing document to 404', async () => {
    const { handlers, store } = createHarness()
    store.savePageText.mockRejectedValueOnce(new DocumentNotFoundError(DOC_ID))
    const response = await handlers.pageText(
      postJson(`${API_PATHS.pageText}?doc=${DOC_ID}`, PAGE_TEXT),
    )
    await expectError(response, 404, 'not_found')
  })
})

/* ------------------------------------------------------------------------- */
/* Page image / overlay uploads                                                */
/* ------------------------------------------------------------------------- */

describe('pageImage and pageOverlay', () => {
  it('rejects a wrong content type with 415', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.pageImage(
      postBinary(`${API_PATHS.pageImage}?doc=${DOC_ID}`, PNG_BYTES, 'text/plain'),
    )
    await expectError(response, 415, 'unsupported_media_type')
    expect(store.savePageImage).not.toHaveBeenCalled()
  })

  it('requires the doc query parameter with 400', async () => {
    const { handlers } = createHarness()
    const response = await handlers.pageImage(
      postBinary(API_PATHS.pageImage, PNG_BYTES, 'image/png'),
    )
    await expectError(response, 400, 'bad_request')
  })

  it('rejects oversized images with 413', async () => {
    const { handlers } = createHarness()
    const bytes = new Uint8Array(LIMITS.maxImageBytes + 1)
    bytes.set(PNG_BYTES)
    const response = await handlers.pageImage(
      postBinary(`${API_PATHS.pageImage}?doc=${DOC_ID}`, bytes, 'image/png'),
    )
    await expectError(response, 413, 'payload_too_large')
  })

  it('rejects bytes that are not a PNG with 422', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.pageImage(
      postBinary(`${API_PATHS.pageImage}?doc=${DOC_ID}`, NOT_A_PNG, 'image/png'),
    )
    await expectError(response, 422, 'unprocessable_entity')
    expect(store.savePageImage).not.toHaveBeenCalled()
  })

  it('maps a missing document to 404', async () => {
    const { handlers, store } = createHarness()
    store.savePageImage.mockRejectedValueOnce(new DocumentNotFoundError(DOC_ID))
    const response = await handlers.pageImage(
      postBinary(`${API_PATHS.pageImage}?doc=${DOC_ID}`, PNG_BYTES, 'image/png'),
    )
    await expectError(response, 404, 'not_found')
  })

  it('saves a valid page PNG and overlay PNG', async () => {
    const { handlers, store } = createHarness()
    const imageResponse = await handlers.pageImage(
      postBinary(`${API_PATHS.pageImage}?doc=${DOC_ID}`, PNG_BYTES, 'image/png'),
    )
    expect(imageResponse.status).toBe(200)
    expect(await responseJson(imageResponse)).toEqual({ ok: true })
    expect(store.savePageImage).toHaveBeenCalledWith(DOC_ID, PNG_BYTES)

    const overlayResponse = await handlers.pageOverlay(
      postBinary(`${API_PATHS.pageOverlay}?doc=${DOC_ID}`, PNG_BYTES, 'image/png'),
    )
    expect(overlayResponse.status).toBe(200)
    expect(store.savePageOverlay).toHaveBeenCalledWith(DOC_ID, PNG_BYTES)
    expect(store.savePageImage).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------- */
/* Analyze                                                                     */
/* ------------------------------------------------------------------------- */

describe('analyze', () => {
  it('requires a valid docId in the body', async () => {
    const { handlers, orchestrator } = createHarness()
    for (const body of [{}, { docId: '../../etc/passwd' }, { docId: DOC_ID, force: 'yes' }]) {
      const response = await handlers.analyze(postJson(API_PATHS.analyze, body))
      await expectError(response, 400, 'bad_request')
    }
    expect(orchestrator.startLayout).not.toHaveBeenCalled()
  })

  it('starts a layout job and returns 202 with the job id', async () => {
    const { handlers, orchestrator } = createHarness()
    const response = await handlers.analyze(postJson(API_PATHS.analyze, { docId: DOC_ID }))
    expect(response.status).toBe(202)
    expect(await responseJson(response)).toEqual({ jobId: 'job_layout1' })
    expect(orchestrator.startLayout).toHaveBeenCalledWith({ docId: DOC_ID })
    expect(orchestrator.startProofread).not.toHaveBeenCalled()
  })

  it('marks the document failed when the layout job cannot start, without leaking internals', async () => {
    const { handlers, store, orchestrator } = createHarness()
    orchestrator.startLayout.mockRejectedValueOnce(new Error('analyzer unavailable at C:\\secrets'))
    const response = await handlers.analyze(postJson(API_PATHS.analyze, { docId: DOC_ID }))
    const payload = await expectError(response, 500, 'internal_error')
    expect(payload.error.message).toBe('internal error')
    expect(JSON.stringify(payload)).not.toContain('analyzer unavailable')
    expect(store.updateMeta).toHaveBeenCalledWith(DOC_ID, { status: 'failed' })
  })

  it('treats a programmer TypeError from the orchestrator as a generic 500', async () => {
    const { handlers, store, orchestrator } = createHarness()
    orchestrator.startLayout.mockRejectedValueOnce(new TypeError('bug: undefined field'))
    const response = await handlers.analyze(postJson(API_PATHS.analyze, { docId: DOC_ID }))
    const payload = await expectError(response, 500, 'internal_error')
    expect(payload.error.message).toBe('internal error')
    // A start failure is still an analyze failure: the document must not stay `parsing`.
    expect(store.updateMeta).toHaveBeenCalledWith(DOC_ID, { status: 'failed' })
  })

  it('does not mark the document failed for an invalid request', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.analyze(postJson(API_PATHS.analyze, { docId: 'nope' }))
    await expectError(response, 400, 'bad_request')
    expect(store.updateMeta).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------------- */
/* Document, layout, page image GET                                            */
/* ------------------------------------------------------------------------- */

describe('document', () => {
  it('requires a valid doc query parameter', async () => {
    const { handlers } = createHarness()
    await expectError(
      await handlers.document(apiRequest(API_PATHS.document)),
      400,
      'bad_request',
    )
    await expectError(
      await handlers.document(apiRequest(`${API_PATHS.document}?doc=nope`)),
      400,
      'bad_request',
    )
  })

  it('returns 404 for an unknown document', async () => {
    const { handlers, store } = createHarness()
    store.getDocument.mockResolvedValueOnce(undefined)
    const response = await handlers.document(apiRequest(`${API_PATHS.document}?doc=${DOC_ID}`))
    await expectError(response, 404, 'not_found')
  })

  it('returns the document view with hasLayout', async () => {
    const { handlers, store } = createHarness()
    const record = makeDocument()
    store.getDocument.mockResolvedValueOnce(record)
    const response = await handlers.document(apiRequest(`${API_PATHS.document}?doc=${DOC_ID}`))
    expect(response.status).toBe(200)
    expect(await responseJson<DocumentView>(response)).toEqual({ ...record, hasLayout: true })
  })

  it('reports hasLayout=false before a layout is saved', async () => {
    const { handlers, store } = createHarness()
    const record = makeDocument({ regions: undefined, articles: undefined })
    store.getDocument.mockResolvedValueOnce(record)
    const response = await handlers.document(apiRequest(`${API_PATHS.document}?doc=${DOC_ID}`))
    expect(await responseJson<DocumentView>(response)).toEqual({ ...record, hasLayout: false })
  })
})

describe('layout', () => {
  it('requires docId and array-shaped regions/articles', async () => {
    const { handlers, store } = createHarness()
    for (const body of [
      { regions: [], articles: [] },
      { docId: DOC_ID, regions: 'nope', articles: [] },
      { docId: DOC_ID, regions: [], articles: 'nope' },
      { docId: DOC_ID, regions: ['r1'], articles: [] },
    ]) {
      const response = await handlers.layout(postJson(API_PATHS.layout, body))
      await expectError(response, 400, 'bad_request')
    }
    expect(store.saveLayout).not.toHaveBeenCalled()
  })

  it('saves manually corrected regions and articles', async () => {
    const { handlers, store } = createHarness()
    const regions = [makeRegion()]
    const articles = [makeArticle()]
    const response = await handlers.layout(
      postJson(API_PATHS.layout, { docId: DOC_ID, regions, articles }),
    )
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: true })
    expect(store.saveLayout).toHaveBeenCalledWith(DOC_ID, { regions, articles })
    expect(store.savePageText).not.toHaveBeenCalled()
  })

  it('maps a missing document to 404', async () => {
    const { handlers, store } = createHarness()
    store.saveLayout.mockRejectedValueOnce(new DocumentNotFoundError(DOC_ID))
    const response = await handlers.layout(
      postJson(API_PATHS.layout, { docId: DOC_ID, regions: [], articles: [] }),
    )
    await expectError(response, 404, 'not_found')
  })
})

describe('pageImageGet', () => {
  it('requires a valid doc query parameter', async () => {
    const { handlers } = createHarness()
    await expectError(await handlers.pageImageGet(apiRequest(API_PATHS.pageImageGet)), 400, 'bad_request')
  })

  it('returns 404 when the document page image is absent', async () => {
    const { handlers, store } = createHarness()
    store.getPageImage.mockResolvedValueOnce(undefined)
    const response = await handlers.pageImageGet(
      apiRequest(`${API_PATHS.pageImageGet}?doc=${DOC_ID}`),
    )
    await expectError(response, 404, 'not_found')
  })

  it('returns the stored PNG with the image/png content type', async () => {
    const { handlers } = createHarness()
    const response = await handlers.pageImageGet(
      apiRequest(`${API_PATHS.pageImageGet}?doc=${DOC_ID}`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(PNG_BYTES),
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Proofread                                                                   */
/* ------------------------------------------------------------------------- */

describe('proofread', () => {
  it('requires docId, articleIds and a valid depth', async () => {
    const { handlers, orchestrator } = createHarness()
    for (const body of [
      { articleIds: ['a1'], depth: 'standard' },
      { docId: DOC_ID, articleIds: [], depth: 'standard' },
      { docId: DOC_ID, articleIds: 'a1', depth: 'standard' },
      { docId: DOC_ID, articleIds: [1], depth: 'standard' },
      { docId: DOC_ID, articleIds: ['a1'], depth: 'extreme' },
      { docId: DOC_ID, articleIds: ['a1'], depth: 'standard', factCheck: 'yes' },
      { docId: DOC_ID, articleIds: ['a1'], depth: 'standard', roles: 'words' },
    ]) {
      const response = await handlers.proofread(postJson(API_PATHS.proofread, body))
      await expectError(response, 400, 'bad_request')
    }
    expect(orchestrator.startProofread).not.toHaveBeenCalled()
  })

  it('starts a proofreading job with fact checking enabled by default', async () => {
    const { handlers, orchestrator } = createHarness()
    const response = await handlers.proofread(
      postJson(API_PATHS.proofread, {
        docId: DOC_ID,
        articleIds: ['a1', 'a2'],
        depth: 'quick',
      }),
    )
    expect(response.status).toBe(202)
    expect(await responseJson(response)).toEqual({ jobId: 'job_proof1' })
    expect(orchestrator.startProofread).toHaveBeenCalledWith({
      docId: DOC_ID,
      articleIds: ['a1', 'a2'],
      depth: 'quick',
      factCheck: true,
    })
    expect(orchestrator.startLayout).not.toHaveBeenCalled()
  })

  it('forwards an explicit factCheck=false and ignores the optional roles hint', async () => {
    const { handlers, orchestrator } = createHarness()
    const response = await handlers.proofread(
      postJson(API_PATHS.proofread, {
        docId: DOC_ID,
        articleIds: ['a1'],
        depth: 'deep',
        factCheck: false,
        roles: ['words'],
      }),
    )
    expect(response.status).toBe(202)
    expect(orchestrator.startProofread).toHaveBeenCalledWith({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'deep',
      factCheck: false,
    })
  })
})

/* ------------------------------------------------------------------------- */
/* Job status and cancellation                                                 */
/* ------------------------------------------------------------------------- */

describe('job', () => {
  it('requires a valid job query parameter', async () => {
    const { handlers } = createHarness()
    await expectError(await handlers.job(apiRequest(API_PATHS.job)), 400, 'bad_request')
    await expectError(
      await handlers.job(apiRequest(`${API_PATHS.job}?job=not-a-job`)),
      400,
      'bad_request',
    )
  })

  it('returns 404 for an unknown job', async () => {
    const { handlers } = createHarness()
    const response = await handlers.job(apiRequest(`${API_PATHS.job}?job=${JOB_ID}`))
    await expectError(response, 404, 'not_found')
  })

  it('returns the job state snapshot', async () => {
    const { handlers, orchestrator } = createHarness()
    orchestrator.get.mockReturnValueOnce(JOB_STATE)
    const response = await handlers.job(apiRequest(`${API_PATHS.job}?job=${JOB_ID}`))
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual(JOB_STATE)
  })
})

describe('cancel', () => {
  it('requires a valid jobId in the body', async () => {
    const { handlers } = createHarness()
    for (const body of [{}, { jobId: 'not-a-job' }, { jobId: 42 }]) {
      const response = await handlers.cancel(postJson(API_PATHS.cancel, body))
      await expectError(response, 400, 'bad_request')
    }
  })

  it('returns 404 for an unknown job and does not call cancel', async () => {
    const { handlers, orchestrator } = createHarness()
    const response = await handlers.cancel(postJson(API_PATHS.cancel, { jobId: JOB_ID }))
    await expectError(response, 404, 'not_found')
    expect(orchestrator.cancel).not.toHaveBeenCalled()
  })

  it('cancels a running job and reports ok', async () => {
    const { handlers, orchestrator } = createHarness()
    orchestrator.get.mockReturnValueOnce(JOB_STATE)
    const response = await handlers.cancel(postJson(API_PATHS.cancel, { jobId: JOB_ID }))
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: true })
    expect(orchestrator.cancel).toHaveBeenCalledWith(JOB_ID)
  })

  it('reports ok=false when the job is already terminal', async () => {
    const { handlers, orchestrator } = createHarness()
    orchestrator.get.mockReturnValueOnce({ ...JOB_STATE, status: 'done', progress: 1 })
    orchestrator.cancel.mockReturnValueOnce(false)
    const response = await handlers.cancel(postJson(API_PATHS.cancel, { jobId: JOB_ID }))
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: false })
  })
})

/* ------------------------------------------------------------------------- */
/* Delete                                                                      */
/* ------------------------------------------------------------------------- */

describe('deleteDoc', () => {
  it('requires a valid docId in the body', async () => {
    const { handlers, store } = createHarness()
    for (const body of [{}, { docId: '../etc/passwd' }, { docId: 42 }]) {
      const response = await handlers.deleteDoc(postJson(API_PATHS.deleteDoc, body))
      await expectError(response, 400, 'bad_request')
    }
    expect(store.delete).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown document', async () => {
    const { handlers, store } = createHarness()
    store.delete.mockResolvedValueOnce(false)
    const response = await handlers.deleteDoc(postJson(API_PATHS.deleteDoc, { docId: DOC_ID }))
    await expectError(response, 404, 'not_found')
  })

  it('cancels every tracked running job of the document before deleting it', async () => {
    const { handlers, store, orchestrator } = createHarness()
    orchestrator.startLayout
      .mockResolvedValueOnce('job_layout1')
      .mockResolvedValueOnce('job_layout2')
    orchestrator.startProofread.mockResolvedValueOnce('job_proof1')
    await handlers.analyze(postJson(API_PATHS.analyze, { docId: DOC_ID }))
    await handlers.proofread(
      postJson(API_PATHS.proofread, { docId: DOC_ID, articleIds: ['a1'], depth: 'standard' }),
    )
    await handlers.analyze(postJson(API_PATHS.analyze, { docId: OTHER_DOC_ID }))

    const response = await handlers.deleteDoc(postJson(API_PATHS.deleteDoc, { docId: DOC_ID }))
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: true })
    expect(orchestrator.cancel.mock.calls.map((call) => call[0]).sort()).toEqual([
      'job_layout1',
      'job_proof1',
    ])
    expect(store.delete).toHaveBeenCalledWith(DOC_ID)

    const lastCancelOrder = Math.max(...orchestrator.cancel.mock.invocationCallOrder)
    expect(lastCancelOrder).toBeLessThan(store.delete.mock.invocationCallOrder[0])
  })
})

/* ------------------------------------------------------------------------- */
/* Meta, settings, health                                                      */
/* ------------------------------------------------------------------------- */

describe('meta', () => {
  it('exposes version, model, prompt version, limits and an empty catalogue by default', async () => {
    const { handlers } = createHarness()
    const response = await handlers.meta(apiRequest(API_PATHS.meta))
    expect(response.status).toBe(200)
    const payload = await responseJson<MetaView>(response)
    expect(Object.keys(payload).sort()).toEqual([
      'limits',
      'model',
      'modelCatalogue',
      'promptVersion',
      'version',
    ])
    expect(payload).toEqual({
      version: VERSION,
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      limits: { ...LIMITS, maxPages: 1 },
      modelCatalogue: [],
    })
    // Never leak prompt text: /meta only carries the version hash.
    expect(JSON.stringify(payload)).not.toContain('system')
  })

  it('returns the supplied provider/model catalogue with ids and display names only', async () => {
    const dirtyCatalogue = [
      {
        id: 'deepseek-official',
        title: 'DeepSeek Official',
        apiKey: 'sk-provider-secret',
        baseURL: 'https://internal.example.invalid/v1',
        pricing: { input: 0.5, output: 1.5 },
        models: [
          {
            id: 'deepseek-flash',
            name: 'DeepSeek Flash',
            apiKey: 'sk-model-secret',
            endpoint: 'https://internal.example.invalid/model',
          },
        ],
      },
      { id: 'other-provider', models: [{ id: 'model-x' }] },
    ] as unknown as ModelCatalogue
    const { handlers } = createHarness({ modelCatalogue: dirtyCatalogue })
    const response = await handlers.meta(apiRequest(API_PATHS.meta))
    expect(response.status).toBe(200)
    const payload = await responseJson<MetaView>(response)
    expect(payload.modelCatalogue).toEqual([
      {
        id: 'deepseek-official',
        title: 'DeepSeek Official',
        models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
      },
      { id: 'other-provider', models: [{ id: 'model-x' }] },
    ])
    // Whitelist projection: only provider id/title and model id/name leave the Host.
    expect([...collectKeys(payload.modelCatalogue)].sort()).toEqual([
      'id',
      'models',
      'name',
      'title',
    ])
    const wire = JSON.stringify(payload)
    for (const secret of [
      'sk-provider-secret',
      'sk-model-secret',
      'apiKey',
      'baseURL',
      'endpoint',
      'pricing',
    ]) {
      expect(wire).not.toContain(secret)
    }
  })

  it('supports an async catalogue factory', async () => {
    const { handlers } = createHarness({
      modelCatalogue: async () => [
        { id: 'deepseek-official', title: 'DeepSeek', models: [{ id: 'deepseek-flash' }] },
      ],
    })
    const payload = await responseJson<MetaView>(await handlers.meta(apiRequest(API_PATHS.meta)))
    expect(payload.modelCatalogue).toEqual([
      { id: 'deepseek-official', title: 'DeepSeek', models: [{ id: 'deepseek-flash' }] },
    ])
  })

  it('drops malformed catalogue entries instead of failing /meta', async () => {
    const { handlers } = createHarness({
      modelCatalogue: [
        { id: '', models: [] },
        { id: 'ok', models: [{ name: 'no id' }, { id: 'm1' }] },
        { id: 'no-models' },
      ] as unknown as ModelCatalogue,
    })
    const payload = await responseJson<MetaView>(await handlers.meta(apiRequest(API_PATHS.meta)))
    expect(payload.modelCatalogue).toEqual([
      { id: 'ok', models: [{ id: 'm1' }] },
      { id: 'no-models', models: [] },
    ])
  })
})

describe('settings', () => {
  it('reads the persisted settings', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.settingsGet(apiRequest(API_PATHS.settingsGet))
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual(DEFAULT_SETTINGS)
    expect(store.getSettings).toHaveBeenCalledTimes(1)
  })

  it('saves a settings patch and returns { ok: true }', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.settingsPost(
      postJson(API_PATHS.settingsPost, { depth: 'deep' }),
    )
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: true })
    expect(store.saveSettings).toHaveBeenCalledWith({ depth: 'deep' })
  })

  it('rejects a non-object body with 400', async () => {
    const { handlers, store } = createHarness()
    const response = await handlers.settingsPost(postJson(API_PATHS.settingsPost, ['nope']))
    await expectError(response, 400, 'bad_request')
    expect(store.saveSettings).not.toHaveBeenCalled()
  })

  it('maps a settings validation error to 400', async () => {
    const { handlers, store } = createHarness()
    store.saveSettings.mockRejectedValueOnce(
      new SettingsValidationError('depth', 'depth must be one of quick, standard, deep'),
    )
    const response = await handlers.settingsPost(
      postJson(API_PATHS.settingsPost, { depth: 'nope' }),
    )
    await expectError(response, 400, 'bad_request')
  })
})

describe('health', () => {
  it('reports ok and the plugin version', async () => {
    const { handlers } = createHarness()
    const response = await handlers.health(apiRequest(API_PATHS.health))
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ ok: true, version: VERSION })
  })
})

/* ------------------------------------------------------------------------- */
/* Export                                                                      */
/* ------------------------------------------------------------------------- */

describe('exportReport', () => {
  it('requires a valid job query parameter', async () => {
    const { handlers } = createHarness()
    await expectError(await handlers.exportReport(apiRequest(API_PATHS.exportReport)), 400, 'bad_request')
    await expectError(
      await handlers.exportReport(apiRequest(`${API_PATHS.exportReport}?job=nope`)),
      400,
      'bad_request',
    )
  })

  it('rejects an unsupported format with 400', async () => {
    const { handlers } = createHarness()
    const response = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}&format=pdf`),
    )
    await expectError(response, 400, 'bad_request')
  })

  it('returns 404 for an unknown report', async () => {
    const { handlers, store } = createHarness()
    store.getReport.mockResolvedValueOnce(undefined)
    const response = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}`),
    )
    await expectError(response, 404, 'not_found')
  })

  it('renders Markdown by default, without rewriting the article body', async () => {
    const { handlers, store } = createHarness()
    store.getReport.mockResolvedValueOnce(makeReport())
    store.getDocument.mockResolvedValueOnce(makeDocument())
    const response = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const markdown = await response.text()
    expect(markdown).toContain('# Ling Gao 校对员 · 校对报告')
    expect(markdown).toContain('## 头条标题')
    expect(markdown).toContain('## 事实核查清单')
    expect(markdown).toContain('## 必须修改的条目')
    expect(markdown).toContain('他的确')
    // The export never contains the full article body (no rewritten text).
    expect(markdown).not.toContain('本报讯 记者张三报道')
  })

  it('still renders Markdown when the source articles are gone', async () => {
    const { handlers, store } = createHarness()
    store.getReport.mockResolvedValueOnce(makeReport())
    store.getDocument.mockResolvedValueOnce(undefined)
    const response = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}&format=md`),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('## 文章 a1')
  })

  it('returns the raw report JSON for format=json', async () => {
    const { handlers, store } = createHarness()
    const report = makeReport()
    store.getReport.mockResolvedValueOnce(report)
    const response = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}&format=json`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await responseJson(response)).toEqual(report)
  })

  it('exports failed roles in the Markdown warning and the raw JSON (Task 21f)', async () => {
    const { handlers, store } = createHarness()
    const report = makeReport({
      failedRoles: [{ articleId: 'a1', role: 'facts', error: 'provider refused the request' }],
      factChecks: [],
    })
    store.getReport.mockResolvedValueOnce(report).mockResolvedValueOnce(report)
    store.getDocument.mockResolvedValueOnce(makeDocument())

    const markdownResponse = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}&format=md`),
    )
    const markdown = await markdownResponse.text()
    expect(markdown).toContain('## 未完成角色（未核查提示）')
    expect(markdown).toContain('provider refused the request')
    expect(markdown).toContain('事实核查角色未完成，不能视为未发现可核查项。')
    expect(markdown).not.toContain('\n未发现可核查项。')

    const jsonResponse = await handlers.exportReport(
      apiRequest(`${API_PATHS.exportReport}?job=${JOB_ID}&format=json`),
    )
    expect(await responseJson(jsonResponse)).toEqual(report)
  })
})

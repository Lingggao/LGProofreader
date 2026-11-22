// @vitest-environment jsdom
/**
 * Client shell / branding / upload-flow tests (Task 17).
 *
 * Covers the task's acceptance surface:
 * - branding: the header shows the sidebar icon + Chinese name; the empty state
 *   shows the full wordmark + name and never prompt text; light/dark wordmarks
 *   are switched by the DSH theme attribute;
 * - locale: `lgproofreader` dictionaries exist in zh AND en with the same keys,
 *   and the registered panel label follows the active locale;
 * - slot registration: `apply(ctx)` registers the `main` panel key and the
 *   `sidebar.panellist` entry (id/order/label) against a fake Cordis ctx;
 * - upload flow: `%PDF-`/150 MB validation, dpi 240/maxEdge 3000 HD parsing with
 *   a 1600 px vision overlay, the document + page-text/page-image/page-overlay +
 *   analyze + poll sequence, and the binding rule that **`/proofread` is never
 *   called automatically**.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createElement } from 'react'

vi.mock('../../src/client/assets', () => ({
  sidebarIcon: 'data:image/png;base64,AAA',
  wordmarkLight: 'light.png',
  wordmarkDark: 'dark.png',
}))

import {
  App,
  MAX_UPLOAD_BYTES,
  PARSE_OPTIONS,
  UploadValidationError,
  createWorkbenchApi,
  runUploadFlow,
  type WorkbenchApi,
} from '../../src/client/app'
import { EmptyState } from '../../src/client/components/EmptyState'
import { DocumentRail } from '../../src/client/components/DocumentRail'
import { Header } from '../../src/client/components/Header'
import { apply, inject, type ClientContext } from '../../src/client/index'
import { NS, createTranslator, defaultTranslate, en, interpolate, zh } from '../../src/client/locale'
import { clientStyles } from '../../src/client/styles'
import type { UploadProgress, UploadProgressHandler } from '../../src/client/api/client'
import type { ParsePdfPageOptions, ParsedPage } from '../../src/client/pdf/parser'
import { MultiPagePdfError } from '../../src/client/pdf/parser'
import type { DocumentView, JobView, ProofreadRequest } from '../../src/shared/api/protocol'
import type {
  Article,
  CandidateBlock,
  DocumentMeta,
  DocumentSummary,
  PageTextInput,
  Region,
  TextLine,
} from '../../src/shared/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const NOT_PDF_BYTES = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])

function pdfFile(name = 'page.pdf'): File {
  return new File([PDF_BYTES], name, { type: 'application/pdf' })
}

function nonPdfFile(): File {
  return new File([NOT_PDF_BYTES], 'page.pdf', { type: 'application/pdf' })
}

function oversizedFile(): File {
  return {
    name: 'huge.pdf',
    type: 'application/pdf',
    size: MAX_UPLOAD_BYTES + 1,
    slice: () => new Blob([PDF_BYTES], { type: 'application/pdf' }),
  } as unknown as File
}

const TEXT_LINE: TextLine = {
  id: 'l1',
  text: '版面文字',
  bbox: { x: 10, y: 20, w: 40, h: 12 },
  fontSize: 12,
  fontWeight: 400,
  baseline: 20,
  column: 0,
}

const CANDIDATE: CandidateBlock = {
  candidateId: 'c1',
  bbox: { x: 10, y: 20, w: 40, h: 12 },
  lineIds: ['l1'],
  fontSizeBand: 'body',
  firstLineText: '版面文字',
  lineCount: 1,
}

const ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'lead',
  title: '头条',
  body: '正文',
  regionIds: ['r1'],
  readingOrder: 0,
  confidence: 0.9,
  warnings: [],
}

const REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 10, y: 20, w: 100, h: 60 },
  lineIds: ['l1'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const DOCUMENT: DocumentMeta = {
  id: 'doc_1',
  fileName: 'page.pdf',
  pageCount: 1,
  createdAt: 1_760_000_000_000,
  status: 'parsing',
}

const DONE_JOB: JobView = {
  id: 'job_1',
  kind: 'layout',
  status: 'done',
  progress: 1,
  stages: [],
  result: { regions: [REGION], articles: [ARTICLE], warnings: ['低置信区块'] },
}

function parsedPage(): ParsedPage {
  return {
    widthPt: 612,
    heightPt: 792,
    textItems: [],
    lines: [TEXT_LINE],
    candidates: [CANDIDATE],
    pagePng: new Blob(['page-png'], { type: 'image/png' }),
    overlayPng: new Blob(['overlay-png'], { type: 'image/png' }),
  }
}

/** A promise whose settlement the test controls (for in-flight race tests). */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function metaFor(id: string, fileName: string): DocumentMeta {
  return { ...DOCUMENT, id, fileName }
}

function articleFor(id: string, title: string): Article {
  return { ...ARTICLE, id, title }
}

function doneLayoutJob(id: string, articles: Article[]): JobView {
  return {
    id,
    kind: 'layout',
    status: 'done',
    progress: 1,
    stages: [],
    result: { regions: [REGION], articles, warnings: [] },
  }
}

function viewFor(meta: DocumentMeta, articles: Article[]): DocumentView {
  return {
    meta: { ...meta, status: 'ready' },
    hasLayout: true,
    regions: [REGION],
    articles,
    reportIds: [],
  }
}

/** Current article count reported by the article-list placeholder. */
function articleCount(container: HTMLElement): string | null {
  return (
    container
      .querySelector('[data-lgp-slot="article-list"]')
      ?.getAttribute('data-lgp-article-count') ?? null
  )
}

/** Current open-document id reported by the workbench root hook. */
function openDocumentId(container: HTMLElement): string | null {
  return container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-document-id') ?? null
}

function workbenchPhase(container: HTMLElement): string | null {
  return container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase') ?? null
}

/** Fake workbench API: records every call and never touches the network. */
function makeFakeApi() {
  const page = parsedPage()
  const mocks = {
    parsePdfPage: vi.fn(
      async (_file: File, _options: ParsePdfPageOptions): Promise<ParsedPage> => page,
    ),
    uploadDocument: vi.fn(
      async (
        _file: File,
        onProgress?: UploadProgressHandler,
        _signal?: AbortSignal,
      ): Promise<DocumentMeta> => {
        onProgress?.({ loaded: 1, total: 2, ratio: 0.5 })
        return DOCUMENT
      },
    ),
    pageText: vi.fn(async (_docId: string, _input: PageTextInput, _signal?: AbortSignal) => {}),
    pageImage: vi.fn(async (_docId: string, _png: Blob, _signal?: AbortSignal) => {}),
    pageOverlay: vi.fn(async (_docId: string, _overlay: Blob, _signal?: AbortSignal) => {}),
    analyze: vi.fn(async (_docId: string, _signal?: AbortSignal) => ({ jobId: 'job_1' })),
    getJob: vi.fn(async (_jobId: string, _signal?: AbortSignal): Promise<JobView> => DONE_JOB),
    cancelJob: vi.fn(async (_jobId: string, _signal?: AbortSignal) => {}),
    proofread: vi.fn(async (_request: ProofreadRequest, _signal?: AbortSignal) => ({
      jobId: 'proof_1',
    })),
    getDocument: vi.fn(async (_docId: string): Promise<DocumentView> => ({
      meta: { ...DOCUMENT, status: 'ready' },
      hasLayout: true,
      regions: [REGION],
      articles: [ARTICLE],
      reportIds: [],
    })),
  }
  const api = mocks as unknown as WorkbenchApi
  return { api, mocks, page }
}

/* ------------------------------------------------------------------------- */
/* Fake Cordis client context                                                 */
/* ------------------------------------------------------------------------- */

interface CapturedRegistration {
  options: {
    name: string
    key?: string
    id?: string
    order?: number
    label?: string | (() => string)
    locale?: string
  }
  component: ComponentType<any>
}

interface FakeContext {
  ctx: ClientContext
  effects: string[]
  locales: { ns: string; dicts: { zh: Record<string, string>; en: Record<string, string> } }[]
  injectedSlots: string[]
  registrations: CapturedRegistration[]
  setActive(locale: 'zh' | 'en'): void
}

function createFakeContext(): FakeContext {
  const effects: string[] = []
  const locales: FakeContext['locales'] = []
  const injectedSlots: string[] = []
  const registrations: CapturedRegistration[] = []
  let activeLocale: 'zh' | 'en' = 'zh'

  const ctx = {
    effect(callback: () => (() => void) | void, label?: string): () => void {
      effects.push(label ?? '')
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void {
        locales.push({ ns, dicts })
        return () => {}
      },
      bind(ns: string) {
        return (key: string, params?: Record<string, string | number>): string => {
          const registration = locales.find((entry) => entry.ns === ns)
          const dictionary = registration?.dicts[activeLocale] ?? {}
          return interpolate(dictionary[key] ?? key, params)
        }
      },
    },
    slots: {
      inject(name: string, register: () => unknown): unknown {
        injectedSlots.push(name)
        return register()
      },
      register(options: CapturedRegistration['options'], component: ComponentType<any>): () => void {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  return {
    ctx: ctx as unknown as ClientContext,
    effects,
    locales,
    injectedSlots,
    registrations,
    setActive(locale) {
      activeLocale = locale
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Branding                                                                   */
/* ------------------------------------------------------------------------- */

describe('branding', () => {
  it('shows the Chinese plugin name and icon', () => {
    render(
      <Header
        name="Ling Gao 校对员"
        documentName="文汇报 2026-11-14 第14版"
        onUpload={() => {}}
      />,
    )
    expect(screen.getByText('Ling Gao 校对员')).toBeTruthy()
    expect(screen.getByAltText('Ling Gao 校对员').getAttribute('src')).toContain('data:image/png')
    expect(screen.getByText('文汇报 2026-11-14 第14版')).toBeTruthy()
    expect(screen.getByText('报纸版面智能校对')).toBeTruthy()
  })

  it('empty state shows full wordmark and name and no prompt text', () => {
    const { container } = render(<EmptyState name="Ling Gao 校对员" onUpload={() => {}} />)
    expect(screen.getByText('Ling Gao 校对员')).toBeTruthy()
    expect(screen.queryByText(/请担任新闻校对员/)).toBeNull()
    const light = container.querySelector('.lgp-wordmark--light') as HTMLImageElement
    const dark = container.querySelector('.lgp-wordmark--dark') as HTMLImageElement
    expect(light.getAttribute('src')).toBe('light.png')
    expect(dark.getAttribute('src')).toBe('dark.png')
    expect(light.getAttribute('alt')).toBe('Ling Gao 校对员')
    expect(dark.getAttribute('aria-hidden')).toBe('true')
  })

  it('header upload action calls onUpload and exposes a busy/cancel affordance', () => {
    const onUpload = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(<Header name="Ling Gao 校对员" onUpload={onUpload} />)
    fireEvent.click(screen.getByRole('button', { name: '上传 PDF' }))
    expect(onUpload).toHaveBeenCalledTimes(1)
    rerender(<Header name="Ling Gao 校对员" onUpload={onUpload} busy onCancel={onCancel} />)
    expect(screen.getByRole('button', { name: '上传 PDF' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('empty state choose and drop both forward PDF files', () => {
    const onUpload = vi.fn()
    const onFiles = vi.fn()
    const { container, rerender } = render(
      <EmptyState name="Ling Gao 校对员" onUpload={onUpload} onFiles={onFiles} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '选择 PDF 文件' }))
    expect(onUpload).toHaveBeenCalledTimes(1)
    const dropzone = container.querySelector('.lgp-dropzone') as HTMLElement
    const file = pdfFile()
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0]).toEqual([file])
    rerender(<EmptyState name="Ling Gao 校对员" onUpload={onUpload} onFiles={onFiles} busy />)
    expect(
      screen.getByRole('button', { name: '选择 PDF 文件' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('shows an inline validation error in the empty state', () => {
    render(<EmptyState name="Ling Gao 校对员" onUpload={() => {}} error="不是有效的 PDF 文件" />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('不是有效的 PDF 文件')
  })

  it('document rail lists recent documents and forwards open/upload', () => {
    const documents: DocumentSummary[] = [
      {
        meta: {
          ...DOCUMENT,
          status: 'ready',
          fileName: 'a.pdf',
          newspaper: '文汇报',
          date: '2026-11-14',
          edition: '第14版',
        },
        hasLayout: true,
        reportCount: 1,
      },
      { meta: { ...DOCUMENT, id: 'doc_2', status: 'parsing', fileName: 'b.pdf' }, hasLayout: false, reportCount: 0 },
    ]
    const onOpen = vi.fn()
    const onUpload = vi.fn()
    render(<DocumentRail documents={documents} activeId="doc_1" onOpen={onOpen} onUpload={onUpload} />)
    expect(screen.getByText('最近文档')).toBeTruthy()
    expect(screen.getByText(/文汇报/)).toBeTruthy()
    expect(screen.getByText('已就绪')).toBeTruthy()
    expect(screen.getByText('解析中')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /文汇报/ }))
    expect(onOpen).toHaveBeenCalledWith('doc_1')
    fireEvent.click(screen.getByRole('button', { name: '上传' }))
    expect(onUpload).toHaveBeenCalledTimes(1)
    cleanup()
    render(<DocumentRail documents={[]} onOpen={onOpen} onUpload={onUpload} />)
    expect(screen.getByText('暂无文档')).toBeTruthy()
  })

  it('disables rail rows and the rail upload action while a transfer is busy', () => {
    const documents: DocumentSummary[] = [
      {
        meta: { ...DOCUMENT, status: 'ready', fileName: 'a.pdf', newspaper: '文汇报', date: '2026-11-14', edition: '第14版' },
        hasLayout: true,
        reportCount: 0,
      },
    ]
    const onOpen = vi.fn()
    const onUpload = vi.fn()
    render(
      <DocumentRail documents={documents} onOpen={onOpen} onUpload={onUpload} busy />,
    )
    const rail = document.querySelector('.lgp-rail') as HTMLElement
    expect(rail.getAttribute('aria-busy')).toBe('true')
    const upload = screen.getByRole('button', { name: '上传' }) as HTMLButtonElement
    expect(upload.disabled).toBe(true)
    const row = screen.getByRole('button', { name: /文汇报/ }) as HTMLButtonElement
    expect(row.disabled).toBe(true)
  })

  it('styles use only DSH alias tokens, the lgp- prefix and the dark wordmark switch', () => {
    expect(clientStyles).toContain('.lgp-root')
    expect(clientStyles).toContain('.lgp-header')
    expect(clientStyles).toContain('.lgp-rail')
    expect(clientStyles).toContain('.lgp-aside')
    expect(clientStyles).toContain('.lgp-wordmark--light')
    expect(clientStyles).toContain('.lgp-wordmark--dark')
    expect(clientStyles).toMatch(/body\[data-ds-dark-theme\][^{]*\.lgp-wordmark--light/)
    expect(clientStyles).toContain('@media (prefers-reduced-motion: reduce)')
    const tokens = clientStyles.match(/--dsw-[a-z0-9-]+/g) ?? []
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token.startsWith('--dsw-alias-')).toBe(true)
    expect(clientStyles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

/* ------------------------------------------------------------------------- */
/* Locale                                                                     */
/* ------------------------------------------------------------------------- */

describe('locale', () => {
  it('registers a bilingual, key-identical lgproofreader dictionary', () => {
    expect(NS).toBe('lgproofreader')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(zh['panel']).toBe('Ling Gao 校对员')
    expect(en['panel']).toBe('Ling Gao Proofreader')
    expect(zh['subtitle']).toBe('报纸版面智能校对')
    for (const value of Object.values(zh)) expect(value.length).toBeGreaterThan(0)
    for (const value of Object.values(en)) expect(value.length).toBeGreaterThan(0)
  })

  it('interpolates placeholders and defaults to the Chinese dictionary', () => {
    expect(interpolate('共 {count} 篇文章', { count: 3 })).toBe('共 3 篇文章')
    expect(createTranslator(zh)('view.articleCount', { count: 2 })).toBe(zh['view.articleCount']!.replace('{count}', '2'))
    expect(defaultTranslate('panel')).toBe('Ling Gao 校对员')
    expect(defaultTranslate('missing.key')).toBe('missing.key')
  })

  it('never carries prompt text into the client dictionaries', () => {
    const serialized = JSON.stringify({ zh, en })
    expect(serialized).not.toMatch(/请担任新闻校对员/)
    expect(serialized).not.toMatch(/校对提示词/)
    expect(serialized).not.toMatch(/system prompt/i)
  })
})

/* ------------------------------------------------------------------------- */
/* Slot registration                                                          */
/* ------------------------------------------------------------------------- */

describe('apply(ctx)', () => {
  it('requires the slots and locale services', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the locale dictionaries and both panel slots once', () => {
    const fake = createFakeContext()
    apply(fake.ctx)

    expect(fake.locales).toHaveLength(1)
    expect(fake.locales[0]!.ns).toBe(NS)
    expect(fake.locales[0]!.dicts.zh).toBe(zh)
    expect(fake.locales[0]!.dicts.en).toBe(en)

    expect(fake.injectedSlots).toEqual(['main', 'sidebar.panellist'])
    expect(fake.effects[0]).toContain('locale')

    const main = fake.registrations.find((item) => item.options.name === 'main')
    expect(main).toBeDefined()
    expect(main!.options.key).toBe('lgproofreader')
    expect(main!.options.locale).toBe(NS)

    const rail = fake.registrations.find((item) => item.options.name === 'sidebar.panellist')
    expect(rail).toBeDefined()
    expect(rail!.options.id).toBe('lgproofreader')
    expect(rail!.options.order).toBe(20)
    const label = rail!.options.label as () => string
    expect(label()).toBe('Ling Gao 校对员')
    fake.setActive('en')
    expect(label()).toBe('Ling Gao Proofreader')
  })

  it('renders the registered main panel and sidebar icon components', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const fake = createFakeContext()
    apply(fake.ctx)

    const main = fake.registrations.find((item) => item.options.name === 'main')!
    const { container } = render(createElement(main.component))
    expect(container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase')).toBe('empty')
    expect(screen.getAllByText('Ling Gao 校对员').length).toBeGreaterThan(0)
    expect(fetchSpy).not.toHaveBeenCalled()

    const rail = fake.registrations.find((item) => item.options.name === 'sidebar.panellist')!
    const icon = render(createElement(rail.component, { size: 16, active: true }))
    const image = icon.container.querySelector('img') as HTMLImageElement
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(image.getAttribute('width')).toBe('16')
    expect(image.getAttribute('alt')).toBe('')
  })
})

/* ------------------------------------------------------------------------- */
/* Real API seam                                                              */
/* ------------------------------------------------------------------------- */

describe('createWorkbenchApi', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as Response
  }

  it('maps page text/image/overlay, analyze and job polling onto the exact routes', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init: init ?? {} })
      if (url.includes('/job')) return jsonResponse(DONE_JOB)
      return jsonResponse({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    const api = createWorkbenchApi()
    const page = parsedPage()
    await api.pageText('doc_1', {
      lines: page.lines,
      candidates: page.candidates,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
    })
    await api.pageImage('doc_1', page.pagePng)
    await api.pageOverlay('doc_1', page.overlayPng)
    await api.analyze('doc_1')
    const job = await api.getJob('job_1')

    expect(job.id).toBe('job_1')
    expect(calls.map((call) => call.url)).toEqual([
      'api/lgproofreader/page-text?doc=doc_1',
      'api/lgproofreader/page-image?doc=doc_1',
      'api/lgproofreader/page-overlay?doc=doc_1',
      'api/lgproofreader/analyze',
      'api/lgproofreader/job?job=job_1',
    ])
    const headers = (call: { init: RequestInit }): Record<string, string> =>
      (call.init.headers ?? {}) as Record<string, string>
    expect(calls[0]!.init.method).toBe('POST')
    expect(headers(calls[0]!)['content-type']).toBe('application/json')
    expect(calls[1]!.init.method).toBe('POST')
    expect(calls[1]!.init.body).toBe(page.pagePng)
    expect(headers(calls[1]!)['content-type']).toBe('image/png')
    expect(calls[2]!.init.method).toBe('POST')
    expect(calls[2]!.init.body).toBe(page.overlayPng)
    expect(headers(calls[2]!)['content-type']).toBe('image/png')
    expect(calls[3]!.init.method).toBe('POST')
    expect(calls[4]!.init.method).toBe('GET')
    // The proofread route exists on the seam for the explicit Task 19 action only.
    expect(api.proofread).toBeTypeOf('function')
  })
})

/* ------------------------------------------------------------------------- */
/* Upload flow                                                                */
/* ------------------------------------------------------------------------- */

describe('runUploadFlow', () => {
  it('parses at 480 dpi / maxEdge 6000 with a 1600 overlay, uploads page data, analyzes and polls to ready without proofreading', async () => {
    const { api, mocks, page } = makeFakeApi()
    const phases: string[] = []
    const progress: UploadProgress[] = []
    const documents: DocumentMeta[] = []
    const jobs: JobView[] = []
    const file = pdfFile()

    const result = await runUploadFlow(file, api, {
      onPhase: (phase) => phases.push(phase),
      onProgress: (value) => progress.push(value),
      onDocument: (document) => documents.push(document),
      onJob: (job) => jobs.push(job),
    })

    expect(phases).toEqual(['validating', 'parsing', 'uploading', 'submitting', 'analyzing'])
    expect(mocks.parsePdfPage).toHaveBeenCalledWith(file, {
      dpi: 480,
      maxEdge: 6000,
      overlayMaxEdge: 1600,
    })
    expect(PARSE_OPTIONS).toEqual({ dpi: 480, maxEdge: 6000, overlayMaxEdge: 1600 })
    expect(mocks.uploadDocument).toHaveBeenCalledWith(file, expect.any(Function), undefined)
    expect(progress).toEqual([{ loaded: 1, total: 2, ratio: 0.5 }])
    expect(documents).toEqual([DOCUMENT])
    expect(jobs).toEqual([DONE_JOB])
    expect(mocks.pageText).toHaveBeenCalledWith(
      'doc_1',
      {
        lines: [TEXT_LINE],
        candidates: [CANDIDATE],
        widthPt: 612,
        heightPt: 792,
      },
      undefined,
    )
    expect(mocks.pageImage).toHaveBeenCalledWith('doc_1', page.pagePng, undefined)
    expect(mocks.pageOverlay).toHaveBeenCalledWith('doc_1', page.overlayPng, undefined)
    expect(mocks.analyze).toHaveBeenCalledWith('doc_1', undefined)
    expect(mocks.getJob).toHaveBeenCalledWith('job_1', undefined)

    const order = [
      mocks.parsePdfPage.mock.invocationCallOrder[0]!,
      mocks.uploadDocument.mock.invocationCallOrder[0]!,
      mocks.pageText.mock.invocationCallOrder[0]!,
      mocks.pageImage.mock.invocationCallOrder[0]!,
      mocks.pageOverlay.mock.invocationCallOrder[0]!,
      mocks.analyze.mock.invocationCallOrder[0]!,
      mocks.getJob.mock.invocationCallOrder[0]!,
    ]
    expect(order).toEqual([...order].sort((left, right) => left - right))

    expect(result.document).toBe(DOCUMENT)
    expect(result.regions).toEqual([REGION])
    expect(result.articles).toEqual([ARTICLE])
    expect(result.warnings).toEqual(['低置信区块'])
    expect(result.job.status).toBe('done')

    // The binding rule: finishing analysis must never start a proofread job.
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('reports the page-image upload so the panel can refresh the canvas', async () => {
    const { api, mocks } = makeFakeApi()
    const events: string[] = []
    await runUploadFlow(pdfFile(), api, {
      onPageImage: () => events.push('pageImage'),
    })
    // The callback fires once, after POST /page-image succeeded (not before).
    expect(events).toEqual(['pageImage'])
    expect(mocks.pageImage).toHaveBeenCalledTimes(1)
    expect(mocks.pageOverlay).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-PDF file before parsing or uploading', async () => {
    const { api, mocks } = makeFakeApi()
    const error = await runUploadFlow(nonPdfFile(), api).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(UploadValidationError)
    expect((error as UploadValidationError).code).toBe('not_pdf')
    expect(mocks.parsePdfPage).not.toHaveBeenCalled()
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('rejects a file over the 150 MB limit before parsing', async () => {
    const { api, mocks } = makeFakeApi()
    const error = await runUploadFlow(oversizedFile(), api).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(UploadValidationError)
    expect((error as UploadValidationError).code).toBe('too_large')
    expect(mocks.parsePdfPage).not.toHaveBeenCalled()
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('rejects an empty file before parsing', async () => {
    const { api, mocks } = makeFakeApi()
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' })
    const error = await runUploadFlow(empty, api).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(UploadValidationError)
    expect((error as UploadValidationError).code).toBe('empty_file')
    expect(mocks.parsePdfPage).not.toHaveBeenCalled()
  })

  it('rejects a multi-page PDF before creating a document', async () => {
    const { api, mocks } = makeFakeApi()
    mocks.parsePdfPage.mockRejectedValueOnce(new MultiPagePdfError(2))
    const error = await runUploadFlow(pdfFile(), api).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(MultiPagePdfError)
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('stops at a failed layout job without proofreading', async () => {
    const { api, mocks } = makeFakeApi()
    mocks.getJob.mockResolvedValueOnce({ ...DONE_JOB, status: 'failed', error: '模型调用超时' })
    const error = await runUploadFlow(pdfFile(), api).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('模型调用超时')
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('retries a transient poll failure with a supplied sleep and still reaches ready', async () => {
    const { api, mocks } = makeFakeApi()
    const sleep = vi.fn(async () => {})
    mocks.getJob.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(DONE_JOB)
    const result = await runUploadFlow(pdfFile(), api, { sleep, pollIntervalMs: 10 })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(result.articles).toEqual([ARTICLE])
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('honours an already-aborted signal before touching the network', async () => {
    const { api, mocks } = makeFakeApi()
    const controller = new AbortController()
    controller.abort()
    const error = await runUploadFlow(pdfFile(), api, { signal: controller.signal }).catch(
      (value: unknown) => value,
    )
    expect((error as Error).name).toBe('AbortError')
    expect(mocks.parsePdfPage).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------------- */
/* App integration                                                            */
/* ------------------------------------------------------------------------- */

describe('App upload integration', () => {
  function fileInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"]')
    expect(input).toBeTruthy()
    return input as HTMLInputElement
  }

  async function chooseFile(container: HTMLElement, file: File): Promise<void> {
    await act(async () => {
      fireEvent.change(fileInput(container), { target: { files: [file] } })
    })
  }

  it('runs the upload flow to ready and never starts proofreading automatically', async () => {
    const { api, mocks } = makeFakeApi()
    const { container } = render(<App name="Ling Gao 校对员" api={api} />)
    expect(container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase')).toBe('empty')
    expect(container.querySelector('[data-lgp-slot="canvas"]')).toBeNull()

    const file = pdfFile()
    await act(async () => {
      fireEvent.change(fileInput(container), { target: { files: [file] } })
    })
    await waitFor(() => {
      expect(
        container.querySelector('[data-lgp-slot="article-list"]')?.getAttribute('data-lgp-article-count'),
      ).toBe('1')
    })
    expect(container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase')).toBe('ready')
    expect(container.querySelector('[data-lgp-slot="canvas"]')).toBeTruthy()
    expect(container.querySelector('[data-lgp-slot="proofread-panel"]')).toBeTruthy()
    expect(mocks.analyze).toHaveBeenCalledTimes(1)
    expect(mocks.proofread).not.toHaveBeenCalled()
    expect(screen.getAllByText('page.pdf').length).toBeGreaterThan(0)
    expect(screen.getByText('版面分析完成')).toBeTruthy()
  })

  it('shows an inline error and keeps the empty workbench for an invalid file', async () => {
    const { api, mocks } = makeFakeApi()
    const { container } = render(<App name="Ling Gao 校对员" api={api} />)
    await act(async () => {
      fireEvent.change(fileInput(container), { target: { files: [nonPdfFile()] } })
    })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('不是有效的 PDF')
    expect(container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase')).toBe('empty')
    expect(mocks.parsePdfPage).not.toHaveBeenCalled()
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('cancels an in-flight upload and stays on the empty workbench', async () => {
    const { api, mocks } = makeFakeApi()
    let uploadSignal: AbortSignal | undefined
    let uploadStarted = false
    mocks.uploadDocument.mockImplementationOnce(
      (_file: File, _onProgress?: UploadProgressHandler, signal?: AbortSignal) => {
        uploadStarted = true
        uploadSignal = signal
        return new Promise<DocumentMeta>(() => {})
      },
    )
    const { container } = render(<App name="Ling Gao 校对员" api={api} />)
    await act(async () => {
      fireEvent.change(fileInput(container), { target: { files: [pdfFile()] } })
    })
    // Wait until the upload XHR actually started before cancelling (under load
    // the busy banner appears while the parse is still in flight).
    await waitFor(() => expect(uploadStarted).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(uploadSignal?.aborted).toBe(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消' })).toBeNull())
    expect(container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase')).toBe('empty')
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('localizes the drop zone label and shell copy through the injected t seat', () => {
    const { api } = makeFakeApi()
    render(<App name="Ling Gao Proofreader" t={createTranslator(en)} api={api} />)
    expect(screen.getByRole('group', { name: 'PDF upload area' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeTruthy()
    expect(screen.getByText('Recent documents')).toBeTruthy()
    expect(screen.getByText('Choose a PDF file')).toBeTruthy()
    expect(screen.queryByText('PDF 上传区')).toBeNull()
  })

  it('keeps a failed document in the rail so it can be retried or deleted', async () => {
    const { api, mocks } = makeFakeApi()
    mocks.getJob.mockResolvedValueOnce({ ...DONE_JOB, status: 'failed', error: '模型调用超时' })
    const { container } = render(<App name="Ling Gao 校对员" api={api} />)
    await chooseFile(container, pdfFile())
    await waitFor(() => expect(workbenchPhase(container)).toBe('failed'))
    expect(screen.getByRole('alert').textContent).toContain('模型调用超时')
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    const uploadButtons = screen.getAllByRole('button', {
      name: '上传 PDF',
    }) as HTMLButtonElement[]
    expect(uploadButtons.length).toBeGreaterThan(0)
    expect(uploadButtons.some((button) => !button.disabled)).toBe(true)
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('blocks switching documents while a transfer is in flight and keeps states separate', async () => {
    const { api, mocks } = makeFakeApi()
    const metaB = metaFor('doc_b', 'b.pdf')
    const metaA = metaFor('doc_a', 'a.pdf')
    const deferredA = deferred<JobView>()
    mocks.uploadDocument
      .mockResolvedValueOnce(metaB)
      .mockResolvedValueOnce(metaA)
    mocks.analyze
      .mockResolvedValueOnce({ jobId: 'job_b' })
      .mockResolvedValueOnce({ jobId: 'job_a' })
    mocks.getJob
      .mockResolvedValueOnce(doneLayoutJob('job_b', [articleFor('b1', 'B头条'), articleFor('b2', 'B二条')]))
      .mockImplementationOnce(() => deferredA.promise)
    const { container } = render(<App name="Ling Gao 校对员" api={api} />)

    await chooseFile(container, pdfFile('b.pdf'))
    await waitFor(() => expect(openDocumentId(container)).toBe('doc_b'))
    await waitFor(() => expect(articleCount(container)).toBe('2'))

    await chooseFile(container, pdfFile('a.pdf'))
    await waitFor(() => expect(openDocumentId(container)).toBe('doc_a'))
    await waitFor(() => expect(workbenchPhase(container)).toBe('analyzing'))

    // The rail is frozen while A owns the workbench (design §9.3 notice).
    const rows = Array.from(container.querySelectorAll('.lgp-rail-item')) as HTMLButtonElement[]
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '上传' }) as HTMLButtonElement).disabled).toBe(true)

    // A switch attempt is ignored instead of racing the flow.
    const rowB = rows.find((row) => (row.textContent ?? '').includes('b.pdf'))
    expect(rowB).toBeTruthy()
    fireEvent.click(rowB!)
    expect(mocks.getDocument).not.toHaveBeenCalled()

    // Finishing A updates only A; B's rail entry is untouched.
    await act(async () => {
      deferredA.resolve(doneLayoutJob('job_a', [articleFor('a1', 'A头条')]))
      await Promise.resolve()
    })
    await waitFor(() => expect(articleCount(container)).toBe('1'))
    expect(openDocumentId(container)).toBe('doc_a')
    expect(workbenchPhase(container)).toBe('ready')
    expect(mocks.getDocument).not.toHaveBeenCalled()
    expect(screen.getByText(/b\.pdf/)).toBeTruthy()
    expect(screen.getAllByText('已就绪')).toHaveLength(2)
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('drops late callbacks from a cancelled flow after another document is opened', async () => {
    const { api, mocks } = makeFakeApi()
    const metaB = metaFor('doc_b', 'b.pdf')
    const metaA = metaFor('doc_a', 'a.pdf')
    const articlesB = [articleFor('b1', 'B头条'), articleFor('b2', 'B二条')]
    const deferredA = deferred<JobView>()
    mocks.uploadDocument.mockResolvedValueOnce(metaB).mockResolvedValueOnce(metaA)
    mocks.analyze
      .mockResolvedValueOnce({ jobId: 'job_b' })
      .mockResolvedValueOnce({ jobId: 'job_a' })
    mocks.getJob
      .mockResolvedValueOnce(doneLayoutJob('job_b', articlesB))
      .mockImplementationOnce(() => deferredA.promise)
    mocks.getDocument.mockResolvedValueOnce(viewFor(metaB, articlesB))
    const { container } = render(<App name="Ling Gao 校对员" api={api} />)

    // 1) doc B is uploaded and ready.
    await chooseFile(container, pdfFile('b.pdf'))
    await waitFor(() => expect(openDocumentId(container)).toBe('doc_b'))
    await waitFor(() => expect(articleCount(container)).toBe('2'))

    // 2) doc A starts analyzing (job reply still pending).
    await chooseFile(container, pdfFile('a.pdf'))
    await waitFor(() => expect(openDocumentId(container)).toBe('doc_a'))
    await waitFor(() => expect(workbenchPhase(container)).toBe('analyzing'))

    // 3) cancel A, then open B (allowed again once the flow was cancelled).
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消' })).toBeNull())
    const rowB = screen.getByRole('button', { name: /b\.pdf/ }) as HTMLButtonElement
    expect(rowB.disabled).toBe(false)
    fireEvent.click(rowB)
    await waitFor(() => expect(openDocumentId(container)).toBe('doc_b'))
    await waitFor(() => expect(articleCount(container)).toBe('2'))
    expect(screen.queryByRole('alert')).toBeNull()

    // 4) A's late job result must not overwrite B's document/articles.
    await act(async () => {
      deferredA.resolve(doneLayoutJob('job_a', [articleFor('a1', 'A头条')]))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(openDocumentId(container)).toBe('doc_b')
    expect(articleCount(container)).toBe('2')
    expect(workbenchPhase(container)).toBe('ready')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.getDocument).toHaveBeenCalledTimes(1)
    expect(mocks.getDocument).toHaveBeenCalledWith('doc_b')
    expect(mocks.proofread).not.toHaveBeenCalled()
  })
})

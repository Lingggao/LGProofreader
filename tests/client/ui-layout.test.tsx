// @vitest-environment jsdom
/**
 * Page canvas, region overlay, article list and region editing tests (Task 18).
 *
 * Covers the task's acceptance surface:
 * - `Canvas`: page image + absolute overlay boxes scaled from page coordinates,
 *   kind colour classes/labels, confidence, low-confidence warning icon, zoom
 *   controls, click/keyboard selection and arrow-key moves (1 pt, Shift 10 pt),
 *   pointer drag move/resize (delta converted with the zoom scale) and
 *   highlighted regions of the selected articles;
 * - `ArticleList`: role labels, explicit checkboxes, "本页全部"/"全不选" and no
 *   automatic selection (a controlled list);
 * - `RegionInspector`: numeric x/y/w/h + kind edits, merge/split/delete,
 *   reading-order up/down, and the straight-cut-only split contract
 *   (full width or full height);
 * - `App` integration: after a layout reaches `ready` the canvas and article
 *   list replace the placeholders, article selection highlights its regions,
 *   region edits go through `edit.ts` (`moveRegion`/`resizeRegion` page
 *   clamping), split passes the document line list to partition line ids, and
 *   merge/split/delete/reorder keep the page state consistent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('../../src/client/assets', () => ({
  sidebarIcon: 'data:image/png;base64,AAA',
  wordmarkLight: 'light.png',
  wordmarkDark: 'dark.png',
}))

import { App, type WorkbenchApi } from '../../src/client/app'
import { ArticleList } from '../../src/client/components/ArticleList'
import { Canvas, type CanvasProps } from '../../src/client/components/Canvas'
import { RegionInspector, straightSplitBBox } from '../../src/client/components/RegionInspector'
import {
  createLayoutSaver,
  flushBeforeProofread,
  type LayoutSavePayload,
  type SaveStatus,
} from '../../src/client/state/layout-saver'
import { reconcileLayout, uniqueRegionId } from '../../src/client/layout/ops'
import type { JobView, ProofreadRequest } from '../../src/shared/api/protocol'
import type { Article, BBox, DocumentMeta, PageSize, Region, TextLine } from '../../src/shared/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const PAGE: PageSize = { widthPt: 1000, heightPt: 1000 }

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

function pdfFile(): File {
  return new File([PDF_BYTES], 'page.pdf', { type: 'application/pdf' })
}

const TEXT_LINES: TextLine[] = [
  {
    id: 'l1',
    text: '头条导语',
    bbox: { x: 120, y: 220, w: 260, h: 12 },
    fontSize: 12,
    fontWeight: 400,
    baseline: 220,
    column: 0,
  },
  {
    id: 'l3',
    text: '头条正文',
    bbox: { x: 120, y: 270, w: 260, h: 12 },
    fontSize: 12,
    fontWeight: 400,
    baseline: 270,
    column: 0,
  },
  {
    id: 'l2',
    text: '二条正文',
    bbox: { x: 120, y: 420, w: 260, h: 12 },
    fontSize: 12,
    fontWeight: 400,
    baseline: 420,
    column: 0,
  },
]

const LEAD_REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 100, y: 200, w: 300, h: 100 },
  lineIds: ['l1', 'l3'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const SECOND_REGION: Region = {
  id: 'r2',
  page: 1,
  kind: 'second',
  bbox: { x: 100, y: 400, w: 300, h: 100 },
  lineIds: ['l2'],
  order: 1,
  confidence: 0.3,
  source: 'vision',
}

const LEAD_ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'lead',
  title: '头条新闻',
  body: '头条正文内容',
  regionIds: ['r1'],
  readingOrder: 0,
  confidence: 0.9,
  warnings: [],
}

const SECOND_ARTICLE: Article = {
  id: 'a2',
  page: 1,
  role: 'second',
  title: '二条新闻',
  body: '二条正文内容',
  regionIds: ['r2'],
  readingOrder: 1,
  confidence: 0.3,
  warnings: ['低置信度区域'],
}

const DOCUMENT: DocumentMeta = {
  id: 'doc_1',
  fileName: 'page.pdf',
  pageCount: 1,
  createdAt: 1_760_000_000_000,
  status: 'parsing',
}

/** Overlapping-region fixture for the warning recomputation tests. */
const OVERLAP_REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 100, y: 200, w: 300, h: 100 },
  lineIds: ['l1'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const OVERLAP_SECOND_REGION: Region = {
  id: 'r2',
  page: 1,
  kind: 'second',
  bbox: { x: 300, y: 250, w: 300, h: 100 },
  lineIds: ['l2'],
  order: 1,
  confidence: 0.9,
  source: 'vision',
}

const OUT_OF_PAGE_REGION: Region = {
  id: 'r3',
  page: 1,
  kind: 'image',
  bbox: { x: 950, y: 900, w: 100, h: 100 },
  lineIds: [],
  order: 2,
  confidence: 0.9,
  source: 'vision',
}

const EMPTY_ARTICLE: Article = {
  id: 'a3',
  page: 1,
  role: 'normal',
  title: '空文章',
  body: '',
  regionIds: [],
  readingOrder: 2,
  confidence: 0.5,
  warnings: [],
}

const WARNING_LAYOUT = {
  regions: [OVERLAP_REGION, OVERLAP_SECOND_REGION, OUT_OF_PAGE_REGION],
  articles: [
    { ...LEAD_ARTICLE, regionIds: ['r1'] },
    { ...SECOND_ARTICLE, regionIds: ['r2'] },
    EMPTY_ARTICLE,
  ],
}

const INSPECT_REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 10, y: 20, w: 100, h: 60 },
  lineIds: ['l1'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

/* ------------------------------------------------------------------------- */
/* DOM helpers                                                                */
/* ------------------------------------------------------------------------- */

function regionBox(container: HTMLElement, regionId: string): HTMLElement {
  const element = container.querySelector(`[data-lgp-region-id="${regionId}"]`)
  expect(element).toBeTruthy()
  return element as HTMLElement
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
}

function fieldValue(container: HTMLElement, label: string): string {
  return (container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).value
}

/* ------------------------------------------------------------------------- */
/* ArticleList                                                                */
/* ------------------------------------------------------------------------- */

describe('ArticleList', () => {
  it('requires an explicit selection and can select all', () => {
    // The brief's fixture (kept verbatim apart from typing).
    const onToggle = vi.fn()
    const onSelectAll = vi.fn()
    const onClear = vi.fn()
    render(
      <ArticleList
        articles={[{ id: 'a1', title: '头条', role: 'lead' } as never]}
        selectedIds={[]}
        onToggle={onToggle}
        onSelectAll={onSelectAll}
        onClear={onClear}
      />,
    )
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(onToggle).toHaveBeenCalledWith('a1')
    fireEvent.click(screen.getByText('本页全部'))
    expect(onSelectAll).toHaveBeenCalled()
  })

  it('renders role labels, titles and unchecked checkboxes without auto-selecting', () => {
    const { container } = render(
      <ArticleList
        articles={[LEAD_ARTICLE, SECOND_ARTICLE]}
        selectedIds={[]}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
      />,
    )
    const boxes = checkboxes(container)
    expect(boxes).toHaveLength(2)
    for (const checkbox of boxes) expect(checkbox.checked).toBe(false)

    const rows = Array.from(container.querySelectorAll('[data-lgp-article-id]'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-lgp-article-id')).toBe('a1')
    expect(rows[0]!.textContent).toContain('头条')
    expect(rows[0]!.textContent).toContain('头条新闻')
    expect(rows[1]!.textContent).toContain('二条')
    expect(rows[1]!.textContent).toContain('二条新闻')
  })

  it('toggles, selects all and clears through its callbacks', () => {
    const onToggle = vi.fn()
    const onSelectAll = vi.fn()
    const onClear = vi.fn()
    const { container } = render(
      <ArticleList
        articles={[LEAD_ARTICLE, SECOND_ARTICLE]}
        selectedIds={['a2']}
        onToggle={onToggle}
        onSelectAll={onSelectAll}
        onClear={onClear}
      />,
    )
    const boxes = checkboxes(container)
    expect(boxes[0]!.checked).toBe(false)
    expect(boxes[1]!.checked).toBe(true)

    fireEvent.click(boxes[0]!)
    expect(onToggle).toHaveBeenCalledWith('a1')
    fireEvent.click(screen.getByRole('button', { name: '本页全部' }))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '全不选' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------- */
/* Canvas / RegionOverlay                                                     */
/* ------------------------------------------------------------------------- */

function renderCanvas(overrides: Partial<CanvasProps> = {}) {
  const handlers = {
    onSelectRegion: vi.fn(),
    onMoveRegion: vi.fn(),
    onResizeRegion: vi.fn(),
  }
  const props: CanvasProps = {
    imageUrl: 'api/lgproofreader/page-image?doc=doc_1',
    page: PAGE,
    regions: [LEAD_REGION, SECOND_REGION],
    selectedRegionId: null,
    ...handlers,
    ...overrides,
  }
  const view = render(<Canvas {...props} />)
  return { ...view, ...handlers }
}

describe('Canvas and RegionOverlay', () => {
  it('renders the page image and absolute boxes scaled from page coordinates', () => {
    const { container } = renderCanvas()

    const image = container.querySelector('.lgp-canvas-image') as HTMLImageElement
    expect(image).toBeTruthy()
    expect(image.getAttribute('src')).toBe('api/lgproofreader/page-image?doc=doc_1')
    expect(image.getAttribute('alt')).toBe('页面图')

    const lead = regionBox(container, 'r1')
    expect(lead.style.left).toBe('10%')
    expect(lead.style.top).toBe('20%')
    expect(lead.style.width).toBe('30%')
    expect(lead.style.height).toBe('10%')
    expect(lead.className).toContain('lgp-region--kind-lead')
    expect(lead.textContent).toContain('头条')
    expect(lead.textContent).toContain('90%')

    const second = regionBox(container, 'r2')
    expect(second.className).toContain('lgp-region--kind-second')
    expect(second.textContent).toContain('二条')
    // Low confidence gets a warning icon (0.3 < 0.5), the lead does not.
    expect(second.querySelector('.lgp-region-warning')).toBeTruthy()
    expect(lead.querySelector('.lgp-region-warning')).toBeNull()
  })

  it('selects a region on click and moves it with arrow keys (Shift accelerates)', () => {
    const { container, onSelectRegion, onMoveRegion } = renderCanvas()
    const lead = regionBox(container, 'r1')

    fireEvent.click(lead)
    expect(onSelectRegion).toHaveBeenCalledWith('r1')

    fireEvent.keyDown(lead, { key: 'ArrowRight' })
    expect(onMoveRegion).toHaveBeenLastCalledWith('r1', 1, 0)
    fireEvent.keyDown(lead, { key: 'ArrowLeft' })
    expect(onMoveRegion).toHaveBeenLastCalledWith('r1', -1, 0)
    fireEvent.keyDown(lead, { key: 'ArrowDown' })
    expect(onMoveRegion).toHaveBeenLastCalledWith('r1', 0, 1)
    fireEvent.keyDown(lead, { key: 'ArrowUp', shiftKey: true })
    expect(onMoveRegion).toHaveBeenLastCalledWith('r1', 0, -10)
  })

  it('marks the selected region and exposes four resize handles', () => {
    const { container } = renderCanvas({ selectedRegionId: 'r1' })
    const lead = regionBox(container, 'r1')
    expect(lead.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('[data-lgp-handle]')).toHaveLength(4)
    expect(regionBox(container, 'r2').getAttribute('aria-pressed')).toBe('false')
  })

  it('zooms the page with the toolbar and keeps the page size in points', () => {
    const { container } = renderCanvas()
    const zoom = (): string | null =>
      container.querySelector('[data-lgp-zoom]')?.getAttribute('data-lgp-zoom') ?? null
    const page = container.querySelector('.lgp-canvas-page') as HTMLElement

    expect(zoom()).toBe('100')
    expect(page.style.width).toBe('1000px')
    expect(page.style.height).toBe('1000px')

    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(zoom()).toBe('125')
    expect(page.style.width).toBe('1250px')
    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(zoom()).toBe('100')
  })

  it('highlights every region of the selected articles', () => {
    const { container } = renderCanvas({ highlightedRegionIds: ['r2'] })
    const highlighted = regionBox(container, 'r2')
    expect(highlighted.getAttribute('data-lgp-highlighted')).toBe('true')
    expect(highlighted.className).toContain('lgp-region--highlighted')
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('false')
  })

  it('drag-moves and drag-resizes in page points using the zoom scale', () => {
    const { container, onMoveRegion, onResizeRegion } = renderCanvas({
      selectedRegionId: 'r1',
    })
    const lead = regionBox(container, 'r1')

    fireEvent.mouseDown(lead, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 150, clientY: 120 })
    expect(onMoveRegion).toHaveBeenLastCalledWith('r1', 50, 20)
    fireEvent.mouseUp(window)
    fireEvent.mouseMove(window, { clientX: 400, clientY: 300 })
    expect(onMoveRegion).toHaveBeenCalledTimes(1)

    const handle = container.querySelector('[data-lgp-handle="se"]') as HTMLElement
    expect(handle).toBeTruthy()
    fireEvent.mouseDown(handle, { clientX: 400, clientY: 300 })
    fireEvent.mouseMove(window, { clientX: 500, clientY: 350 })
    expect(onResizeRegion).toHaveBeenLastCalledWith('r1', { x: 100, y: 200, w: 400, h: 150 })
    fireEvent.mouseUp(window)
  })
})

/* ------------------------------------------------------------------------- */
/* RegionInspector                                                            */
/* ------------------------------------------------------------------------- */

function renderInspector(
  overrides: Partial<ComponentProps<typeof RegionInspector>> = {},
) {
  const handlers = {
    onChange: vi.fn(),
    onMerge: vi.fn(),
    onSplit: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
  }
  const view = render(<RegionInspector region={INSPECT_REGION} {...handlers} {...overrides} />)
  return { ...view, ...handlers }
}

describe('RegionInspector', () => {
  it('shows numeric coordinates, kind and order, and edits them through onChange', () => {
    const { container, onChange } = renderInspector()
    expect(fieldValue(container, 'x 坐标')).toBe('10')
    expect(fieldValue(container, 'y 坐标')).toBe('20')
    expect(fieldValue(container, '宽度')).toBe('100')
    expect(fieldValue(container, '高度')).toBe('60')
    expect(container.textContent).toContain('阅读顺序 1')

    fireEvent.change(screen.getByLabelText('x 坐标'), { target: { value: '15' } })
    expect(onChange).toHaveBeenCalledWith({ bbox: { x: 15 } })
    fireEvent.change(screen.getByLabelText('高度'), { target: { value: '70' } })
    expect(onChange).toHaveBeenCalledWith({ bbox: { h: 70 } })
    fireEvent.change(screen.getByLabelText('区域类型'), { target: { value: 'ad' } })
    expect(onChange).toHaveBeenCalledWith({ kind: 'ad' })
  })

  it('ignores non-numeric input instead of emitting NaN', () => {
    const { onChange } = renderInspector()
    fireEvent.change(screen.getByLabelText('x 坐标'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('x 坐标'), { target: { value: 'abc' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('splits only along a straight cut that spans the region width or height', () => {
    const { onSplit } = renderInspector()

    expect(straightSplitBBox(INSPECT_REGION, 'horizontal', 0.5)).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 30,
    })
    expect(straightSplitBBox(INSPECT_REGION, 'vertical', 0.25)).toEqual({
      x: 10,
      y: 20,
      w: 25,
      h: 60,
    })

    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))
    expect(onSplit).toHaveBeenLastCalledWith({ x: 10, y: 20, w: 100, h: 30 })

    fireEvent.change(screen.getByLabelText('拆分方向'), { target: { value: 'vertical' } })
    fireEvent.change(screen.getByLabelText('拆分位置'), { target: { value: '0.25' } })
    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))
    expect(onSplit).toHaveBeenLastCalledWith({ x: 10, y: 20, w: 25, h: 60 })
  })

  it('calls merge/delete/order handlers and disables merge without a target', () => {
    const { onMerge, onDelete, onReorder } = renderInspector()
    fireEvent.click(screen.getByRole('button', { name: '合并下一区域' }))
    expect(onMerge).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '上移' }))
    expect(onReorder).toHaveBeenLastCalledWith('up')
    fireEvent.click(screen.getByRole('button', { name: '下移' }))
    expect(onReorder).toHaveBeenLastCalledWith('down')
    fireEvent.click(screen.getByRole('button', { name: '删除区域' }))
    expect(onDelete).toHaveBeenCalledTimes(1)

    cleanup()
    const disabled = renderInspector({ canMerge: false })
    expect(
      (screen.getByRole('button', { name: '合并下一区域' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(disabled.onMerge).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------------- */
/* App integration                                                            */
/* ------------------------------------------------------------------------- */

/** A fake workbench API whose layout result is the given fixture. */
function makeFakeApi(
  layout: { regions?: Region[]; articles?: Article[]; warnings?: string[] } = {},
) {
  const regions = layout.regions ?? [LEAD_REGION, SECOND_REGION]
  const articles = layout.articles ?? [LEAD_ARTICLE, SECOND_ARTICLE]
  const warnings = layout.warnings ?? []
  const page = {
    widthPt: PAGE.widthPt,
    heightPt: PAGE.heightPt,
    textItems: [],
    lines: TEXT_LINES,
    candidates: [],
    pagePng: new Blob(['page'], { type: 'image/png' }),
    overlayPng: new Blob(['overlay'], { type: 'image/png' }),
  }
  const job: JobView = {
    id: 'job_1',
    kind: 'layout',
    status: 'done',
    progress: 1,
    stages: [],
    result: { regions, articles, warnings },
  }
  const mocks = {
    parsePdfPage: vi.fn(async () => page),
    uploadDocument: vi.fn(async () => DOCUMENT),
    pageText: vi.fn(async () => {}),
    pageImage: vi.fn(async () => {}),
    pageOverlay: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ jobId: 'job_1' })),
    getJob: vi.fn(async () => job),
    cancelJob: vi.fn(async () => {}),
    saveLayout: vi.fn(async (_docId: string, _layout: LayoutSavePayload) => {}),
    proofread: vi.fn(async () => ({ jobId: 'proof_1' })),
    getDocument: vi.fn(async () => ({
      meta: { ...DOCUMENT, status: 'ready' as const },
      hasLayout: true,
      regions,
      articles,
      lines: TEXT_LINES,
      widthPt: PAGE.widthPt,
      heightPt: PAGE.heightPt,
      reportIds: [],
    })),
  }
  return { api: mocks as unknown as WorkbenchApi, mocks }
}

async function renderReady(
  fake = makeFakeApi(),
  appProps: Omit<ComponentProps<typeof App>, 'api' | 'name'> = {},
) {
  const view = render(<App name="Ling Gao 校对员" api={fake.api} {...appProps} />)
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [pdfFile()] } })
  })
  await waitFor(() => {
    expect(view.container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase')).toBe(
      'ready',
    )
  })
  return { ...view, ...fake }
}

/** A promise whose settlement the test controls (for the in-flight image upload). */
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

function phase(container: HTMLElement): string | null {
  return container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase') ?? null
}

function canvasImage(container: HTMLElement): HTMLImageElement {
  return container.querySelector('.lgp-canvas-image') as HTMLImageElement
}

function articleCount(container: HTMLElement): string | null {
  return (
    container
      .querySelector('[data-lgp-slot="article-list"]')
      ?.getAttribute('data-lgp-article-count') ?? null
  )
}

function saveStatus(container: HTMLElement): string | null {
  return (
    container.querySelector('[data-lgp-save-status]')?.getAttribute('data-lgp-save-status') ?? null
  )
}

function regionIds(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('[data-lgp-region-id]')).map((element) =>
    element.getAttribute('data-lgp-region-id'),
  )
}

describe('App layout integration', () => {
  it('renders the page canvas and article list after analysis, without auto-selection', async () => {
    const { container, mocks } = await renderReady()

    expect(phase(container)).toBe('ready')
    expect(container.querySelector('[data-lgp-slot="canvas"]')).toBeTruthy()
    expect(container.querySelector('[data-lgp-slot="article-list"]')).toBeTruthy()
    expect(articleCount(container)).toBe('2')
    expect(screen.getByText('版面分析完成')).toBeTruthy()

    // The page PNG was uploaded during the flow, so the canvas URL carries the
    // cache-busting version that replays the pre-upload 404.
    const image = canvasImage(container)
    expect(image.getAttribute('src')).toBe('api/lgproofreader/page-image?doc=doc_1&v=1')

    expect(container.querySelectorAll('[data-lgp-region-id]')).toHaveLength(2)
    const boxes = checkboxes(container)
    expect(boxes).toHaveLength(2)
    for (const checkbox of boxes) expect(checkbox.checked).toBe(false)
    // Binding rule: reaching ready never starts proofreading or selects anything.
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('shows a page-image placeholder until POST /page-image succeeds', async () => {
    const fake = makeFakeApi()
    const gate = deferred<void>()
    fake.mocks.pageImage.mockImplementation(() => gate.promise)
    const view = render(<App name="Ling Gao 校对员" api={fake.api} />)
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [pdfFile()] } })
    })

    // The canvas mounts while the flow is still submitting the page data. It
    // must not request the not-yet-uploaded PNG (the old transient 404).
    await waitFor(() => expect(phase(view.container)).toBe('analyzing'))
    expect(canvasImage(view.container)).toBeNull()
    expect(
      view.container.querySelector('[data-lgp-image-placeholder="true"]'),
    ).toBeTruthy()

    await act(async () => {
      gate.resolve()
      await gate.promise
    })

    // After the PNG upload the real image (with cache-busting version) appears.
    await waitFor(() => {
      expect(canvasImage(view.container).getAttribute('src')).toBe(
        'api/lgproofreader/page-image?doc=doc_1&v=1',
      )
    })
    expect(
      view.container.querySelector('[data-lgp-image-placeholder="true"]'),
    ).toBeNull()
    await waitFor(() => expect(phase(view.container)).toBe('ready'))
  })

  it('cache-busts the stored page image again when re-opening a document', async () => {
    const fake = makeFakeApi()
    fake.mocks.uploadDocument
      .mockImplementationOnce(async () => ({ ...DOCUMENT, id: 'doc_1', fileName: 'a.pdf' }))
      .mockImplementationOnce(async () => ({ ...DOCUMENT, id: 'doc_2', fileName: 'b.pdf' }))
    fake.mocks.getDocument.mockResolvedValueOnce({
      meta: { ...DOCUMENT, id: 'doc_1', fileName: 'a.pdf', status: 'ready' as const },
      hasLayout: true,
      regions: [LEAD_REGION, SECOND_REGION],
      articles: [LEAD_ARTICLE, SECOND_ARTICLE],
      lines: TEXT_LINES,
      widthPt: PAGE.widthPt,
      heightPt: PAGE.heightPt,
      reportIds: [],
    })
    const view = render(<App name="Ling Gao 校对员" api={fake.api} />)
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement

    // First document: image version 1 after its page PNG upload.
    await act(async () => {
      fireEvent.change(input, { target: { files: [pdfFile()] } })
    })
    await waitFor(() => expect(phase(view.container)).toBe('ready'))
    expect(canvasImage(view.container).getAttribute('src')).toBe(
      'api/lgproofreader/page-image?doc=doc_1&v=1',
    )

    // Second document starts a fresh page, then re-opening the first one must
    // use a *new* image URL again (never the previously cached response).
    await act(async () => {
      fireEvent.change(input, { target: { files: [pdfFile()] } })
    })
    await waitFor(() => expect(phase(view.container)).toBe('ready'))
    expect(canvasImage(view.container).getAttribute('src')).toBe(
      'api/lgproofreader/page-image?doc=doc_2&v=1',
    )

    fireEvent.click(screen.getByRole('button', { name: /a\.pdf/ }))
    await waitFor(() => {
      expect(canvasImage(view.container).getAttribute('src')).toBe(
        'api/lgproofreader/page-image?doc=doc_1&v=2',
      )
    })
  })

  it('highlights the regions of selected articles and supports select all/none', async () => {
    const { container } = await renderReady()
    const boxes = checkboxes(container)

    fireEvent.click(boxes[0]!)
    expect(checkboxes(container)[0]!.checked).toBe(true)
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('true')
    expect(regionBox(container, 'r2').getAttribute('data-lgp-highlighted')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: '本页全部' }))
    expect(checkboxes(container).every((checkbox) => checkbox.checked)).toBe(true)
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('true')
    expect(regionBox(container, 'r2').getAttribute('data-lgp-highlighted')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '全不选' }))
    expect(checkboxes(container).every((checkbox) => checkbox.checked)).toBe(false)
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('false')
  })

  it('selects a region and moves it with the keyboard, clamped to the page', async () => {
    const { container } = await renderReady()
    const lead = regionBox(container, 'r1')

    fireEvent.click(lead)
    expect(screen.getByLabelText('x 坐标')).toBeTruthy()

    fireEvent.keyDown(regionBox(container, 'r1'), { key: 'ArrowRight' })
    expect(fieldValue(container, 'x 坐标')).toBe('101')

    // A numeric edit above the page limit is clamped by edit.ts (x = 1000 - 300).
    fireEvent.change(screen.getByLabelText('x 坐标'), { target: { value: '990' } })
    expect(fieldValue(container, 'x 坐标')).toBe('700')
    expect(regionBox(container, 'r1').style.left).toBe('70%')

    // The arrow-key alternative clamps too: it cannot leave the page.
    fireEvent.keyDown(regionBox(container, 'r1'), { key: 'ArrowRight' })
    expect(fieldValue(container, 'x 坐标')).toBe('700')

    // A numeric width edit larger than the page is clamped to the page width.
    fireEvent.change(screen.getByLabelText('宽度'), { target: { value: '5000' } })
    expect(fieldValue(container, '宽度')).toBe('1000')
    expect(regionBox(container, 'r1').style.width).toBe('100%')
    expect(regionBox(container, 'r1').style.left).toBe('0%')
  })

  it('changes the region kind through the inspector and keeps it on the box', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.change(screen.getByLabelText('区域类型'), { target: { value: 'ad' } })

    const lead = regionBox(container, 'r1')
    expect(lead.getAttribute('data-lgp-region-kind')).toBe('ad')
    expect(lead.className).toContain('lgp-region--kind-ad')
    expect(lead.textContent).toContain('广告')
  })

  it('merges the selected region with the next one through mergeRegions', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.click(screen.getByRole('button', { name: '合并下一区域' }))

    const merged = container.querySelectorAll('[data-lgp-region-id]')
    expect(merged).toHaveLength(1)
    const leadBox = regionBox(container, 'r1')
    expect(leadBox.style.top).toBe('20%')
    expect(leadBox.style.height).toBe('30%')
    expect(leadBox.getAttribute('data-lgp-region-lines')).toBe('l1,l3,l2')
    expect(container.querySelector('[data-lgp-region-id="r2"]')).toBeNull()

    // The merged region belongs to the selected region's article only: a1 owns
    // it and a2 (which owned r2) becomes an empty article.
    fireEvent.click(checkboxes(container)[0]!)
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('true')
    const summary = container.querySelector('[data-lgp-warning-summary]')
    expect(summary?.getAttribute('data-lgp-warning-empty-articles')).toBe('1')
  })

  it('splits with a straight cut and partitions line ids from the document lines', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))

    const first = regionBox(container, 'r1')
    const second = regionBox(container, 'r1-2')
    expect(first.style.top).toBe('20%')
    expect(first.style.height).toBe('5%')
    expect(second.style.top).toBe('25%')
    expect(second.style.height).toBe('5%')
    // splitRegion(region, splitBBox, lines) partitions the region's line ids by
    // line centre: l1 lies in the top half, l3 in the bottom half.
    expect(first.getAttribute('data-lgp-region-lines')).toBe('l1')
    expect(second.getAttribute('data-lgp-region-lines')).toBe('l3')
    expect(container.querySelectorAll('[data-lgp-region-id]')).toHaveLength(3)
  })

  it('reorders the selected region up/down in reading order', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r2'))
    expect(fieldValue(container, 'x 坐标')).toBe('100')

    fireEvent.click(screen.getByRole('button', { name: '上移' }))
    expect(regionBox(container, 'r2').getAttribute('data-lgp-region-order')).toBe('0')
    expect(regionBox(container, 'r1').getAttribute('data-lgp-region-order')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: '下移' }))
    expect(regionBox(container, 'r2').getAttribute('data-lgp-region-order')).toBe('1')
    expect(regionBox(container, 'r1').getAttribute('data-lgp-region-order')).toBe('0')
  })

  it('deletes a region, clears its selection and keeps article membership consistent', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r2'))
    expect(screen.getByLabelText('y 坐标')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '删除区域' }))
    expect(container.querySelector('[data-lgp-region-id="r2"]')).toBeNull()
    expect(container.querySelectorAll('[data-lgp-region-id]')).toHaveLength(1)
    // Deleting the selected region clears the inspector (no stale selection).
    expect(screen.queryByLabelText('y 坐标')).toBeNull()
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('false')
    // The deleted region is removed from its article, which is now empty.
    expect(
      container
        .querySelector('[data-lgp-warning-summary]')
        ?.getAttribute('data-lgp-warning-empty-articles'),
    ).toBe('1')
  })

  it('mints unique split ids and inserts both parts right after the source region', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))

    // r2 followed r1 before the split; the new second part must be inserted
    // between them (r1:0, r1-2:1, r2:2).
    expect(regionBox(container, 'r1').getAttribute('data-lgp-region-order')).toBe('0')
    expect(regionBox(container, 'r1-2').getAttribute('data-lgp-region-order')).toBe('1')
    expect(regionBox(container, 'r2').getAttribute('data-lgp-region-order')).toBe('2')

    // Splitting r1 again must not duplicate `<id>-2`.
    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))
    const ids = regionIds(container)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(new Set(ids)).toEqual(new Set(['r1', 'r1-2', 'r1-2-2', 'r2']))
    const orders = Array.from(container.querySelectorAll('[data-lgp-region-id]'))
      .map((element) => Number(element.getAttribute('data-lgp-region-order')))
      .sort((left, right) => left - right)
    expect(orders).toEqual([0, 1, 2, 3])
  })

  it('merges the second split part with merge-next', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))
    expect(regionBox(container, 'r1-2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '合并下一区域' }))
    expect(container.querySelector('[data-lgp-region-id="r1-2"]')).toBeNull()
    expect(regionIds(container)).toEqual(['r1', 'r2'])
    expect(regionBox(container, 'r1').getAttribute('data-lgp-region-order')).toBe('0')
    expect(regionBox(container, 'r2').getAttribute('data-lgp-region-order')).toBe('1')
    // The merged box is the union of both split parts (the original region).
    expect(regionBox(container, 'r1').style.top).toBe('20%')
    expect(regionBox(container, 'r1').style.height).toBe('10%')
  })

  it('persists the layout after a move and after a split through saveLayout', async () => {
    const fake = makeFakeApi()
    const { container } = await renderReady(fake, { saveDebounceMs: 0 })
    const { mocks } = fake

    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.keyDown(regionBox(container, 'r1'), { key: 'ArrowRight' })
    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalled())
    await waitFor(() => expect(saveStatus(container)).toBe('saved'))

    const moveCall = mocks.saveLayout.mock.calls[mocks.saveLayout.mock.calls.length - 1]!
    expect(moveCall[0]).toBe('doc_1')
    expect(moveCall[1].regions.find((region) => region.id === 'r1')!.bbox.x).toBe(101)
    expect(moveCall[1].regions.find((region) => region.id === 'r1')!.articleId).toBe('a1')
    expect(moveCall[1].articles.map((article) => article.id)).toEqual(['a1', 'a2'])

    mocks.saveLayout.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '拆分区域' }))
    await waitFor(() => {
      const calls = mocks.saveLayout.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[calls.length - 1]![1].regions.map((region) => region.id)).toEqual([
        'r1',
        'r1-2',
        'r2',
      ])
    })
    const splitCall = mocks.saveLayout.mock.calls[mocks.saveLayout.mock.calls.length - 1]!
    expect(splitCall[1].regions.map((region) => region.order)).toEqual([0, 1, 2])
    // Both split parts stay assigned to the source region's article.
    expect(splitCall[1].regions.find((region) => region.id === 'r1-2')!.articleId).toBe('a1')
    expect(splitCall[1].articles[0]!.regionIds).toEqual(['r1', 'r1-2'])
  })

  it('undoes/redoes with the toolbar and Ctrl/Cmd+Z, truncating redo after a new edit', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    fireEvent.keyDown(regionBox(container, 'r1'), { key: 'ArrowRight' })
    expect(fieldValue(container, 'x 坐标')).toBe('101')

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(fieldValue(container, 'x 坐标')).toBe('100')
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(fieldValue(container, 'x 坐标')).toBe('101')

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(fieldValue(container, 'x 坐标')).toBe('100')
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(fieldValue(container, 'x 坐标')).toBe('101')

    // Undo, then a new edit: the redo stack is truncated.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('区域类型'), { target: { value: 'ad' } })
    expect((screen.getByRole('button', { name: '重做' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(regionBox(container, 'r1').getAttribute('data-lgp-region-kind')).toBe('ad')
  })

  it('replays at least 20 undo steps', async () => {
    const { container } = await renderReady()
    fireEvent.click(regionBox(container, 'r1'))
    for (let step = 0; step < 25; step += 1) {
      fireEvent.keyDown(regionBox(container, 'r1'), { key: 'ArrowRight' })
    }
    expect(fieldValue(container, 'x 坐标')).toBe('125')

    for (let step = 0; step < 25; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    }
    expect(fieldValue(container, 'x 坐标')).toBe('100')
  })

  it('edits article title/byline/body and saves the new text', async () => {
    const fake = makeFakeApi()
    const { mocks } = await renderReady(fake, { saveDebounceMs: 0 })

    fireEvent.click(screen.getByRole('button', { name: '编辑文章：头条新闻' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '改后标题' } })
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('改后标题')
    fireEvent.change(screen.getByLabelText('署名'), { target: { value: '本报记者 张三' } })
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '改后正文' } })

    await waitFor(() => {
      const calls = mocks.saveLayout.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      const article = calls[calls.length - 1]![1].articles.find((item) => item.id === 'a1')!
      expect(article.title).toBe('改后标题')
      expect(article.body).toBe('改后正文')
    })
    const article = mocks.saveLayout.mock.calls[mocks.saveLayout.mock.calls.length - 1]![1]
      .articles.find((item) => item.id === 'a1')!
    expect(article.byline).toBe('本报记者 张三')
  })

  it('assigns a region to another article and updates both sides', async () => {
    const fake = makeFakeApi()
    const { container } = await renderReady(fake, { saveDebounceMs: 0 })

    fireEvent.click(regionBox(container, 'r2'))
    const select = screen.getByLabelText('所属文章') as HTMLSelectElement
    expect(select.value).toBe('a2')
    fireEvent.change(select, { target: { value: 'a1' } })

    expect(regionBox(container, 'r2').getAttribute('data-lgp-region-article')).toBe('a1')
    // Selecting a1 now highlights both regions; a2 is an empty article.
    fireEvent.click(checkboxes(container)[0]!)
    expect(regionBox(container, 'r1').getAttribute('data-lgp-highlighted')).toBe('true')
    expect(regionBox(container, 'r2').getAttribute('data-lgp-highlighted')).toBe('true')
    const summary = container.querySelector('[data-lgp-warning-summary]')
    expect(summary?.getAttribute('data-lgp-warning-empty-articles')).toBe('1')

    await waitFor(() => expect(fake.mocks.saveLayout).toHaveBeenCalled())
    const payload = fake.mocks.saveLayout.mock.calls[fake.mocks.saveLayout.mock.calls.length - 1]![1]
    expect(payload.regions.find((region) => region.id === 'r2')!.articleId).toBe('a1')
    expect(payload.articles.find((article) => article.id === 'a2')!.regionIds).toEqual([])
    expect(payload.articles.find((article) => article.id === 'a1')!.regionIds).toContain('r2')

    // Unassigning moves the region to the "未归属" bucket with the distinct style.
    fireEvent.change(screen.getByLabelText('所属文章'), { target: { value: '' } })
    expect(regionBox(container, 'r2').getAttribute('data-lgp-unassigned')).toBe('true')
    expect(regionBox(container, 'r2').className).toContain('lgp-region--unassigned')
    expect(regionBox(container, 'r2').textContent).toContain('未归属')
  })

  it('recomputes overlap/unassigned/empty/out-of-page warnings after edits', async () => {
    const fake = makeFakeApi(WARNING_LAYOUT)
    const { container } = await renderReady(fake)

    let summary = container.querySelector('[data-lgp-warning-summary]')
    expect(summary).toBeTruthy()
    expect(summary?.getAttribute('data-lgp-warning-overlaps')).toBe('1')
    expect(summary?.getAttribute('data-lgp-warning-unassigned')).toBe('1')
    expect(summary?.getAttribute('data-lgp-warning-empty-articles')).toBe('1')
    expect(summary?.getAttribute('data-lgp-warning-out-of-page')).toBe('1')
    expect(summary?.textContent).toContain('布局警告')
    expect(container.querySelector('[data-lgp-unassigned-list]')?.textContent).toContain('r3')

    // The unassigned region gets the distinct style/badge.
    expect(regionBox(container, 'r3').getAttribute('data-lgp-unassigned')).toBe('true')
    expect(regionBox(container, 'r3').className).toContain('lgp-region--unassigned')
    expect(regionBox(container, 'r3').textContent).toContain('未归属')

    // Inspector lists the region-specific warnings.
    fireEvent.click(regionBox(container, 'r3'))
    let inspectorWarnings = container.querySelector('[data-lgp-inspector-warnings]')
    expect(inspectorWarnings?.getAttribute('data-lgp-inspector-unassigned')).toBe('true')
    expect(inspectorWarnings?.getAttribute('data-lgp-inspector-out-of-page')).toBe('true')
    expect(inspectorWarnings?.getAttribute('data-lgp-inspector-overlap')).toBe('false')
    expect(inspectorWarnings?.textContent).toContain('未归属文章')
    expect(inspectorWarnings?.textContent).toContain('超出页面')

    fireEvent.click(regionBox(container, 'r2'))
    inspectorWarnings = container.querySelector('[data-lgp-inspector-warnings]')
    expect(inspectorWarnings?.getAttribute('data-lgp-inspector-overlap')).toBe('true')
    expect(inspectorWarnings?.textContent).toContain('与其它区域重叠')

    // Assigning r3 resolves its unassigned + empty-article warnings.
    fireEvent.click(regionBox(container, 'r3'))
    fireEvent.change(screen.getByLabelText('所属文章'), { target: { value: 'a3' } })
    summary = container.querySelector('[data-lgp-warning-summary]')
    expect(summary?.getAttribute('data-lgp-warning-unassigned')).toBe('0')
    expect(summary?.getAttribute('data-lgp-warning-empty-articles')).toBe('0')
    expect(summary?.getAttribute('data-lgp-warning-out-of-page')).toBe('1')
  })
})

/* ------------------------------------------------------------------------- */
/* Coordinate helper contract                                                 */
/* ------------------------------------------------------------------------- */

describe('straightSplitBBox', () => {
  it('always spans the full region width or height and clamps the ratio', () => {
    const region: Region = { ...INSPECT_REGION }
    const preview = straightSplitBBox(region, 'horizontal', 0.5)
    expect(preview.x).toBe(region.bbox.x)
    expect(preview.w).toBe(region.bbox.w)
    const below = straightSplitBBox(region, 'vertical', 10)
    expect(below.y).toBe(region.bbox.y)
    expect(below.h).toBe(region.bbox.h)
    expect(below.w).toBe(region.bbox.w * 0.9)
    const bbox: BBox = below
    expect(bbox.w).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------------- */
/* Layout saver / proofread flush                                             */
/* ------------------------------------------------------------------------- */

const SAVE_PAYLOAD: LayoutSavePayload = {
  regions: [LEAD_REGION],
  articles: [LEAD_ARTICLE],
}

describe('createLayoutSaver', () => {
  it('debounces a burst of edits into one save of the latest snapshot', async () => {
    const save = vi.fn(async (_docId: string, _payload: LayoutSavePayload) => {})
    const statuses: SaveStatus[] = []
    const saver = createLayoutSaver({
      save,
      delayMs: 10,
      onStatus: (status) => statuses.push(status),
    })

    saver.schedule('doc_1', SAVE_PAYLOAD)
    saver.schedule('doc_1', { regions: [SECOND_REGION], articles: [SECOND_ARTICLE] })
    expect(save).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toBe('doc_1')
    expect(save.mock.calls[0]![1].regions[0]!.id).toBe('r2')

    await saver.flush()
    expect(statuses).toContain('saving')
    expect(statuses.at(-1)).toBe('saved')
  })

  it('flush saves the pending snapshot immediately', async () => {
    const save = vi.fn(async (_docId: string, _payload: LayoutSavePayload) => {})
    const saver = createLayoutSaver({ save, delayMs: 10_000 })
    saver.schedule('doc_1', SAVE_PAYLOAD)
    await saver.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush rejects when the Host save failed', async () => {
    const save = vi.fn(async (_docId: string, _payload: LayoutSavePayload) => {
      throw new Error('disk full')
    })
    const saver = createLayoutSaver({ save, delayMs: 10_000 })
    saver.schedule('doc_1', SAVE_PAYLOAD)
    await expect(saver.flush()).rejects.toThrow('disk full')
    expect(save).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------- */
/* Layout ops reconciliation                                                  */
/* ------------------------------------------------------------------------- */

describe('layout ops reconciliation', () => {
  it('keeps a disputed region with only one article and fixes both sides', () => {
    const layout = reconcileLayout(
      [{ ...LEAD_REGION }],
      [
        { ...LEAD_ARTICLE, regionIds: ['r1'] },
        { ...SECOND_ARTICLE, regionIds: ['r1'] },
      ],
    )
    expect(layout.articles[0]!.regionIds).toEqual(['r1'])
    expect(layout.articles[1]!.regionIds).toEqual([])
    expect(layout.regions[0]!.articleId).toBe('a1')
  })

  it('mints unique region ids until a free suffix is found', () => {
    const regions = [
      LEAD_REGION,
      { ...SECOND_REGION, id: 'r1-2' },
      { ...SECOND_REGION, id: 'r1-2-2' },
    ]
    expect(uniqueRegionId(regions, 'r1-2')).toBe('r1-2-3')
    expect(uniqueRegionId(regions, 'r9')).toBe('r9')
  })

  it('drops an articleId that references a missing article', () => {
    const layout = reconcileLayout(
      [{ ...LEAD_REGION, articleId: 'ghost' }],
      [{ ...LEAD_ARTICLE, regionIds: [] }],
    )
    expect(layout.regions[0]!.articleId).toBeUndefined()
    expect(layout.articles[0]!.regionIds).toEqual([])
  })
})

/* ------------------------------------------------------------------------- */
/* Layout flush before proofreading                                           */
/* ------------------------------------------------------------------------- */

describe('flushBeforeProofread', () => {
  it('awaits the pending layout save before calling the proofread API', async () => {
    const order: string[] = []
    let releaseFlush!: () => void
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('flush')
          releaseFlush = resolve
        }),
    )
    const proofread = vi.fn(async (_request: ProofreadRequest) => {
      order.push('proofread')
      return { jobId: 'job_2' }
    })
    const guarded = flushBeforeProofread(proofread, flush)
    const request: ProofreadRequest = { docId: 'doc_1', articleIds: ['a1'], depth: 'standard' }

    const result = guarded(request)
    await Promise.resolve()
    expect(order).toEqual(['flush'])
    expect(proofread).not.toHaveBeenCalled()

    releaseFlush()
    await expect(result).resolves.toEqual({ jobId: 'job_2' })
    expect(order).toEqual(['flush', 'proofread'])
    expect(proofread).toHaveBeenCalledWith(request, undefined)
  })

  it('does not start proofreading when the layout save failed', async () => {
    const proofread = vi.fn(async (_request: ProofreadRequest) => ({ jobId: 'job_2' }))
    const guarded = flushBeforeProofread(proofread, async () => {
      throw new Error('layout save failed')
    })
    const request: ProofreadRequest = { docId: 'doc_1', articleIds: ['a1'], depth: 'standard' }
    await expect(guarded(request)).rejects.toThrow('layout save failed')
    expect(proofread).not.toHaveBeenCalled()
  })
})

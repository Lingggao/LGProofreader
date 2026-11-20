import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLUSTER_GAP_RATIO,
  MultiPagePdfError,
  assertSinglePage,
  computeRenderScale,
  parsePdfPage,
  toTextItems,
} from '../../src/client/pdf/parser'
import { createWorkerSrc, disposePdfWorker, installPdfWorker } from '../../src/client/pdf/worker'

/*
 * The parser module is imported without evaluating PDF.js or a canvas: the
 * pure conversion/guard helpers are re-exported from `items.ts` and PDF.js is
 * only loaded dynamically inside `parsePdfPage`. The one `parsePdfPage` test
 * replaces the PDF.js module with a fake multi-page document so the page-count
 * guard can be exercised without a real PDF or canvas.
 */
const pdfjsMock = vi.hoisted(() => ({
  numPages: 1,
  getDocument: vi.fn(),
  destroy: vi.fn(async () => undefined),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: pdfjsMock.getDocument,
}))

/**
 * Task 21b: capture the options `parsePdfPage` hands to the shared line
 * clusterer (the parser must pass the tighter newspaper gap ratio while the
 * shared Task 2 default stays untouched). The real implementation still runs.
 */
const clusterCalls = vi.hoisted(() => [] as { options?: unknown }[])

vi.mock('../../src/shared/layout/lines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/layout/lines')>()
  return {
    ...actual,
    clusterTextItems: (
      items: Parameters<typeof actual.clusterTextItems>[0],
      options?: Parameters<typeof actual.clusterTextItems>[1],
    ) => {
      clusterCalls.push({ options })
      return actual.clusterTextItems(items, options)
    },
  }
})

const SAMPLE_ITEM = { str: '你好', transform: [12, 0, 0, 12, 100, 700], width: 24, height: 12 }

beforeEach(() => {
  pdfjsMock.numPages = 1
  clusterCalls.length = 0
  pdfjsMock.destroy.mockClear()
  pdfjsMock.getDocument.mockReset()
  pdfjsMock.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      numPages: pdfjsMock.numPages,
      getPage: vi.fn(async () => {
        throw new Error('getPage must not be reached: the page-count guard comes first')
      }),
    }),
    destroy: pdfjsMock.destroy,
  }))
})

afterEach(() => {
  disposePdfWorker()
  vi.unstubAllGlobals()
})

function fakePdfFile(bytes = [0x25, 0x50, 0x44, 0x46, 0x2d]): File {
  return {
    name: 'page.pdf',
    size: bytes.length,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as File
}

describe('toTextItems', () => {
  it('converts pdf.js text items to page coordinates', () => {
    const items = toTextItems([SAMPLE_ITEM], { scale: 1 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      str: '你好',
      x: 100,
      y: 688,
      w: 24,
      h: 12,
      fontSize: 12,
    })
  })

  it('maps the pdf.js viewport transform to top-down page points', () => {
    // A Letter page: viewport transform [1, 0, 0, -1, 0, 792]. The raw item
    // baseline at y=700 (PDF y-up) is 92 pt below the top edge, so the item's
    // top edge is 92 - 12 = 80 pt.
    const items = toTextItems([SAMPLE_ITEM], { scale: 1, transform: [1, 0, 0, -1, 0, 792] })
    expect(items[0]).toMatchObject({ x: 100, y: 80, w: 24, h: 12, fontSize: 12 })
  })

  it('scales coordinates and sizes by the viewport scale', () => {
    const items = toTextItems([SAMPLE_ITEM], { scale: 2 })
    expect(items[0]).toMatchObject({ x: 200, y: 1376, w: 48, h: 24, fontSize: 24 })
  })

  it('drops empty/whitespace runs and keeps font names when present', () => {
    const items = toTextItems(
      [
        { str: '', transform: [12, 0, 0, 12, 0, 0], width: 0, height: 12 },
        { str: '   ', transform: [12, 0, 0, 12, 0, 0], width: 0, height: 12 },
        {
          str: '正文',
          transform: [12, 0, 0, 12, 10, 20],
          width: 24,
          height: 12,
          fontName: 'g_d0_f1',
        },
      ],
      { scale: 1 },
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ str: '正文', fontName: 'g_d0_f1' })
  })

  it('omits the optional fontName property when the run has none', () => {
    const items = toTextItems([SAMPLE_ITEM], { scale: 1 })
    expect('fontName' in items[0]).toBe(false)
  })

  it('rejects a non-positive or non-finite scale', () => {
    expect(() => toTextItems([SAMPLE_ITEM], { scale: 0 })).toThrow(RangeError)
    expect(() => toTextItems([SAMPLE_ITEM], { scale: Number.NaN })).toThrow(RangeError)
    expect(() => toTextItems([SAMPLE_ITEM], { scale: -1 })).toThrow(RangeError)
  })
})

/*
 * Task 21a: real newspaper pages contain a few vertical (`dir: 'ttb'`) slogan
 * runs. PDF.js reports a vertical run's **font-size extent as `width`** and its
 * **advance/length as `height`** (the opposite of a horizontal run), and the
 * transform translation is the visual top-left corner of the run. The converted
 * bbox must therefore be the visual tall-thin box below the page top edge, never
 * a negative y / off-page box like the pre-fix `y - height` estimate.
 */
describe('toTextItems vertical (ttb) runs', () => {
  // PDF user space: a 750 pt long, 50 pt wide vertical headline starting at
  // (85.5, 750) on a 792 pt tall Letter page.
  const VERTICAL_ITEM = {
    str: '以高质量党建引领企业高质量发展',
    dir: 'ttb',
    transform: [50, 0, 0, 50, 85.5, 750],
    width: 50,
    height: 750,
  }
  const LETTER_VIEWPORT = [1, 0, 0, -1, 0, 792]

  it('converts a ttb run to its visual top-down box (no negative y)', () => {
    const items = toTextItems([VERTICAL_ITEM], { scale: 1, transform: LETTER_VIEWPORT })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      str: VERTICAL_ITEM.str,
      x: 85.5,
      // 792 - 750 = 42 pt below the page top; the run extends downward.
      y: 42,
      // The horizontal (font-size) extent is `width`, the vertical advance is
      // `height`: for ttb items the two dimensions are swapped.
      w: 50,
      h: 750,
      fontSize: 50,
    })
    expect(items[0].y).toBeGreaterThanOrEqual(0)
    expect(items[0].y + items[0].h).toBeLessThanOrEqual(792)
  })

  it('scales ttb geometry consistently with the viewport scale', () => {
    const items = toTextItems([VERTICAL_ITEM], {
      scale: 2,
      transform: [1, 0, 0, -1, 0, 792],
    })
    expect(items[0]).toMatchObject({ x: 171, y: 84, w: 100, h: 1500, fontSize: 100 })
  })

  it('keeps axis-aligned horizontal runs on the baseline-top convention', () => {
    const [horizontal] = toTextItems([SAMPLE_ITEM], { scale: 1, transform: LETTER_VIEWPORT })
    const [vertical] = toTextItems([VERTICAL_ITEM], { scale: 1, transform: LETTER_VIEWPORT })
    // Horizontal: translation is the baseline, so y = translation - height.
    expect(horizontal).toMatchObject({ x: 100, y: 80, w: 24, h: 12, fontSize: 12 })
    // Vertical: translation is already the visual top edge.
    expect(vertical).toMatchObject({ x: 85.5, y: 42, w: 50, h: 750, fontSize: 50 })
  })

  it('never drops ttb text', () => {
    const items = toTextItems(
      [VERTICAL_ITEM, { ...VERTICAL_ITEM, str: '   ' }],
      { scale: 1, transform: LETTER_VIEWPORT },
    )
    expect(items.map((item) => item.str)).toEqual([VERTICAL_ITEM.str])
  })
})

describe('computeRenderScale', () => {
  it('renders at the requested DPI when the long edge fits the cap', () => {
    expect(computeRenderScale(612, 792, { dpi: 180, maxEdge: 2600 })).toBeCloseTo(2.5, 10)
    expect(computeRenderScale(100, 100, { dpi: 240, maxEdge: 2600 })).toBeCloseTo(240 / 72, 10)
  })

  it('shrinks the scale so the long edge never exceeds maxEdge', () => {
    const scale = computeRenderScale(2000, 3000, { dpi: 180, maxEdge: 2600 })
    expect(scale).toBeCloseTo(2600 / 3000, 10)
    expect(3000 * scale).toBeLessThanOrEqual(2600)
    expect(computeRenderScale(3000, 2000, { dpi: 180, maxEdge: 2600 })).toBeCloseTo(2600 / 3000, 10)
  })

  it('rejects invalid dpi/maxEdge options', () => {
    expect(() => computeRenderScale(612, 792, { dpi: 0, maxEdge: 2600 })).toThrow(RangeError)
    expect(() => computeRenderScale(612, 792, { dpi: Number.NaN, maxEdge: 2600 })).toThrow(RangeError)
    expect(() => computeRenderScale(612, 792, { dpi: 180, maxEdge: 0 })).toThrow(RangeError)
    expect(() => computeRenderScale(612, 792, { dpi: 180, maxEdge: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    )
  })
})

describe('single-page guard', () => {
  it('accepts exactly one page', () => {
    expect(() => assertSinglePage(1)).not.toThrow()
  })

  it('throws MultiPagePdfError for any other page count', () => {
    expect(() => assertSinglePage(2)).toThrow(MultiPagePdfError)
    let caught: unknown
    try {
      assertSinglePage(3)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MultiPagePdfError)
    expect((caught as MultiPagePdfError).numPages).toBe(3)
    expect((caught as MultiPagePdfError).message).toContain('exactly 1 page')
    expect((caught as MultiPagePdfError).name).toBe('MultiPagePdfError')
  })

  it('rejects a multi-page PDF before rendering anything', async () => {
    pdfjsMock.numPages = 2
    await expect(parsePdfPage(fakePdfFile(), { dpi: 180, maxEdge: 2600 })).rejects.toMatchObject({
      name: 'MultiPagePdfError',
      numPages: 2,
    })
    expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(1)
    // The PDF.js loading task is always destroyed, even on the guard failure.
    expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1)
    const init = pdfjsMock.getDocument.mock.calls[0]?.[0] as { data: Uint8Array }
    expect(init.data).toBeInstanceOf(Uint8Array)
    expect(init.data.byteLength).toBe(5)
  })

  it('validates options before touching the file or PDF.js', async () => {
    await expect(
      parsePdfPage(fakePdfFile(), { dpi: 0, maxEdge: 2600 }),
    ).rejects.toThrow(RangeError)
    expect(pdfjsMock.getDocument).not.toHaveBeenCalled()
  })
})

describe('parsePdfPage', () => {
  it('parses one page into lines, candidates and page/overlay PNGs', async () => {
    const render = vi.fn((_params?: unknown) => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }))
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale],
      })),
      getTextContent: vi.fn(async () => ({
        items: [
          {
            str: '你好',
            transform: [12, 0, 0, 12, 100, 700],
            width: 24,
            height: 12,
            fontName: 'g_d0_f1',
          },
        ],
        styles: {},
        lang: null,
      })),
      render,
    }
    pdfjsMock.getDocument.mockImplementation(() => ({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
      destroy: pdfjsMock.destroy,
    }))

    const context = {
      lineWidth: 0,
      font: '',
      textBaseline: 'top',
      strokeStyle: '',
      fillStyle: '',
      drawImage: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    }
    class FakeCanvas {
      width = 0
      height = 0
      getContext(): unknown {
        return context
      }
      toBlob(callback: (blob: Blob | null) => void, type?: string): void {
        callback(new Blob(['png'], { type }))
      }
    }
    const canvases: FakeCanvas[] = []
    vi.stubGlobal('document', {
      createElement: () => {
        const canvas = new FakeCanvas()
        canvases.push(canvas)
        return canvas
      },
    })

    // Task 24: HD page render (240 DPI, long edge ≤ 3000) plus a smaller
    // vision overlay (long edge ≤ 1600, the new `overlayMaxEdge` option).
    const result = await parsePdfPage(fakePdfFile(), {
      dpi: 240,
      maxEdge: 3000,
      overlayMaxEdge: 1600,
    })
    expect(result.widthPt).toBe(612)
    expect(result.heightPt).toBe(792)
    // The viewport transform [1, 0, 0, -1, 0, 792] puts the page top at y=0.
    expect(result.textItems[0]).toMatchObject({
      str: '你好',
      x: 100,
      y: 80,
      w: 24,
      h: 12,
      fontSize: 12,
    })
    expect(result.lines).toHaveLength(1)
    expect(result.candidates.length).toBeGreaterThan(0)

    // Task 21b: the parser clusters with the newspaper gap ratio (`0.5`) and the
    // page width, while the shared Task 2 default (1.2) stays untouched.
    expect(CLUSTER_GAP_RATIO).toBe(0.5)
    expect(clusterCalls).toHaveLength(1)
    expect(clusterCalls[0]?.options).toMatchObject({
      widthPt: 612,
      gapRatio: CLUSTER_GAP_RATIO,
    })
    expect(result.pagePng).toBeInstanceOf(Blob)
    expect(result.pagePng.type).toBe('image/png')
    expect(result.overlayPng.type).toBe('image/png')
    expect(result.pagePng).not.toBe(result.overlayPng)

    // 240 DPI => scale 240/72 = 3.333…; canvas is sized to the render viewport
    // (612 × 3.333 = 2040, 792 × 3.333 = 2640; both under maxEdge 3000).
    expect(render).toHaveBeenCalledTimes(1)
    const renderParams = render.mock.calls[0]?.[0] as unknown as {
      canvas: FakeCanvas
      viewport: { width: number; height: number }
    }
    expect(renderParams.viewport.width).toBeCloseTo(2040, 6)
    expect(renderParams.viewport.height).toBeCloseTo(2640, 6)
    expect(renderParams.canvas.width).toBe(2040)
    expect(renderParams.canvas.height).toBe(2640)

    // The overlay PNG is downscaled to the vision long edge: 1600/2640 of the
    // page render (2040 × 1600/2640 = 1236.36 → 1237 px wide).
    expect(canvases).toHaveLength(2)
    expect(canvases[1]!.width).toBe(1237)
    expect(canvases[1]!.height).toBe(1600)

    // Overlay: page drawn first (scaled into the smaller overlay canvas), then a
    // border and a c1 label per candidate.
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1237, 1600)
    expect(context.strokeRect).toHaveBeenCalledTimes(result.candidates.length)
    expect(context.fillText).toHaveBeenCalledTimes(result.candidates.length)
    expect(context.fillText.mock.calls[0]?.[0]).toBe('c1')
    expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1)
  })

  it('defaults the vision overlay to a 1600 px long edge', async () => {
    const render = vi.fn((_params?: unknown) => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }))
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale],
      })),
      getTextContent: vi.fn(async () => ({
        items: [
          { str: '你好', transform: [12, 0, 0, 12, 100, 700], width: 24, height: 12 },
        ],
        styles: {},
        lang: null,
      })),
      render,
    }
    pdfjsMock.getDocument.mockImplementation(() => ({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
      destroy: pdfjsMock.destroy,
    }))

    const context = {
      lineWidth: 0,
      font: '',
      textBaseline: 'top',
      strokeStyle: '',
      fillStyle: '',
      drawImage: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    }
    const canvases: { width: number; height: number }[] = []
    class FakeCanvas {
      width = 0
      height = 0
      getContext(): unknown {
        return context
      }
      toBlob(callback: (blob: Blob | null) => void, type?: string): void {
        callback(new Blob(['png'], { type }))
      }
    }
    vi.stubGlobal('document', {
      createElement: () => {
        const canvas = new FakeCanvas()
        canvases.push(canvas)
        return canvas
      },
    })

    await parsePdfPage(fakePdfFile(), { dpi: 240, maxEdge: 3000 })
    expect(canvases).toHaveLength(2)
    expect(Math.max(canvases[1]!.width, canvases[1]!.height)).toBe(1600)

    // A custom overlay long edge is honoured and validated.
    canvases.length = 0
    await parsePdfPage(fakePdfFile(), { dpi: 240, maxEdge: 3000, overlayMaxEdge: 800 })
    expect(Math.max(canvases[1]!.width, canvases[1]!.height)).toBe(800)
  })

  it('rejects an invalid overlayMaxEdge before touching the file or PDF.js', async () => {
    await expect(
      parsePdfPage(fakePdfFile(), { dpi: 240, maxEdge: 3000, overlayMaxEdge: 0 }),
    ).rejects.toThrow(RangeError)
    expect(pdfjsMock.getDocument).not.toHaveBeenCalled()
  })
})

describe('pdf.js worker bootstrap', () => {
  it('uses a Blob URL with the real browser/Node globals', () => {
    disposePdfWorker()
    // Regression: `typeof URL` is "function" in browsers, so the default
    // environment must not require it to be an "object".
    expect(createWorkerSrc('self.x = 1')).toMatch(/^blob:/)
    disposePdfWorker()
  })

  it('creates a Blob URL from the injected worker source', () => {
    disposePdfWorker()
    const revoked: string[] = []
    const environment = {
      Blob: class FakeBlob {
        constructor(
          readonly parts: readonly unknown[],
          readonly options: unknown,
        ) {}
      } as unknown as typeof Blob,
      URL: {
        createObjectURL: vi.fn(() => 'blob:fake-worker'),
        revokeObjectURL: vi.fn((url: string) => {
          revoked.push(url)
        }),
      },
    }
    const target = { workerSrc: 'original' }
    expect(installPdfWorker(target, 'self.onmessage = null', environment)).toBe('blob:fake-worker')
    expect(target.workerSrc).toBe('blob:fake-worker')
    disposePdfWorker()
    expect(revoked).toEqual(['blob:fake-worker'])
  })

  it('falls back to a data URL when Blob URLs are unavailable', () => {
    disposePdfWorker()
    const target = { workerSrc: 'original' }
    const environment = {
      Blob: class FakeBlob {} as unknown as typeof Blob,
      URL: {
        createObjectURL: () => {
          throw new Error('blocked by CSP')
        },
        revokeObjectURL: vi.fn(),
      },
    }
    const source = installPdfWorker(target, 'self.x = 1', environment)
    expect(source).toMatch(/^data:text\/javascript/)
    expect(source).toContain(encodeURIComponent('self.x = 1'))
    expect(target.workerSrc).toBe(source)
  })

  it('leaves workerSrc untouched when no worker source was injected', () => {
    disposePdfWorker()
    expect(createWorkerSrc('')).toBeNull()
    expect(createWorkerSrc('   ')).toBeNull()
    const target = { workerSrc: 'keep-me' }
    expect(installPdfWorker(target, '   ', {})).toBeNull()
    expect(target.workerSrc).toBe('keep-me')
  })
})

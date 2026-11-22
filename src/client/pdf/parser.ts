/**
 * Client-side PDF page parsing (Task 16; design §6.1).
 *
 * `parsePdfPage(file, { dpi, maxEdge, overlayMaxEdge? })` parses exactly one
 * page with PDF.js, converts the text layer to shared page coordinates, clusters
 * lines and candidate blocks with the shared pure functions, renders a clean
 * HD page PNG and a numbered candidate-overlay PNG (downscaled to the vision
 * long edge) for the Host's vision model, and returns everything the upload
 * flow needs.
 *
 * Everything that does not need PDF.js or a canvas lives in `items.ts`
 * (page-coordinate conversion, single-page guard, render scale); this module
 * re-exports those helpers so callers/tests have one public entry point, and
 * loads `pdfjs-dist` dynamically inside {@link parsePdfPage} only. That keeps
 * `import { toTextItems } from './parser'` safe in Node/Vitest, where neither
 * PDF.js nor a canvas is available.
 *
 * Page coordinates are top-left origin, y down (binding convention): the PDF.js
 * page viewport transform `[1, 0, 0, -1, 0, heightPt]` is applied to every text
 * matrix before conversion.
 */
import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist'
import { buildCandidates } from '../../shared/layout/candidates'
import { clusterTextItems } from '../../shared/layout/lines'
import type { CandidateBlock, TextItem, TextLine } from '../../shared/types'
import {
  MultiPagePdfError,
  assertSinglePage,
  computeRenderScale,
  toTextItems,
} from './items'
import { installPdfWorker } from './worker'

export { MultiPagePdfError, assertSinglePage, computeRenderScale, toTextItems }
export type { PdfTextItemLike, RenderScaleOptions, ToTextItemsOptions } from './items'
export type { CandidateBlock, TextItem, TextLine } from '../../shared/types'

/**
 * Gap ratio used when clustering the page's text runs into lines (Task 21b).
 *
 * `splitRow` breaks a baseline row into separate lines at a gap wider than
 * `gapRatio × fontSize`, using the **largest** run font of the row. The shared
 * default (`1.2`, Task 2) is tuned for simple pages, but a newspaper front page
 * mixes small body runs with large headline runs on the same baseline row: with
 * the default the threshold is sized by the 35–49 pt display type
 * (`1.2 × 49 = 58.8`), so a normal column gutter next to that headline is not
 * wide enough to split and two different columns merge into one long line.
 * `0.5` keeps the headline-sized threshold below the real gutter
 * (`0.5 × 49 = 24.5`) while still joining ordinary body runs
 * (`0.5 × 8.2 ≈ 4` pt is far below the intra-word gaps PDF.js reports). The
 * shared default is deliberately left unchanged so Task 2's public contract
 * stays stable; Task 21b measured 44 page-wide merged lines at `1.2` vs 11
 * (legitimately wide headlines) at `0.5` on the real sample.
 */
export const CLUSTER_GAP_RATIO = 0.5

/** Options for {@link parsePdfPage} (Task 24 HD page + smaller vision overlay). */
export interface ParsePdfPageOptions {
  /** Render resolution in dots per inch. */
  dpi: number
  /** Maximum length of the rendered page's long edge, in pixels. */
  maxEdge: number
  /**
   * Maximum length of the candidate-overlay PNG's long edge, in pixels
   * (Task 24). The overlay is downscaled from the HD page render before the
   * candidate boxes/labels are drawn, so the vision input stays small and fast
   * while the page shown in the panel keeps its full resolution. Defaults to
   * {@link DEFAULT_OVERLAY_MAX_EDGE}.
   */
  overlayMaxEdge?: number
  /**
   * Upper bound for the final page PNG bytes (v1.1.0). A very high-resolution
   * newspaper page can exceed the Host's 20 MiB image limit; the parser then
   * downsamples the encoded display bitmap only (the vision overlay is still
   * rendered from the full-resolution canvas). Defaults to
   * {@link MAX_PAGE_IMAGE_BYTES}.
   */
  maxPngBytes?: number
}

/**
 * Default vision-overlay long edge (Task 24): the HD page render is now 480 DPI /
 * 6000 px for the preview, but the vision model does not need that many pixels to
 * locate blocks; 1600 px keeps candidate labels/boxes legible while shrinking
 * the upload.
 */
export const DEFAULT_OVERLAY_MAX_EDGE = 1600

/**
 * Host `/page-image` limit (20 MiB). The page bitmap is supersampled at high
 * resolution for the preview; if the PNG is larger than this, only the stored
 * display bitmap is progressively downsampled so the upload never fails.
 */
export const MAX_PAGE_IMAGE_BYTES = 20 * 1024 * 1024

/** Everything produced from one single-page PDF. */
export interface ParsedPage {
  /** Page width in PDF points (viewport at scale 1). */
  widthPt: number
  /** Page height in PDF points (viewport at scale 1). */
  heightPt: number
  /** Raw text runs in page coordinates (top-left origin, y down). */
  textItems: TextItem[]
  /** Lines clustered from `textItems` in reading order. */
  lines: TextLine[]
  /** Candidate layout blocks for the vision model. */
  candidates: CandidateBlock[]
  /** Clean rendered page, `image/png`. */
  pagePng: Blob
  /** Rendered page with candidate boxes and `c1`… labels, `image/png`. */
  overlayPng: Blob
}

/** Overlay style; a thin border plus a small translucent badge (never a text mask). */
const OVERLAY_COLORS: Record<CandidateBlock['fontSizeBand'], string> = {
  headline: 'rgba(220, 38, 38, 0.9)',
  subhead: 'rgba(234, 88, 12, 0.9)',
  body: 'rgba(37, 99, 235, 0.85)',
  small: 'rgba(22, 163, 74, 0.85)',
}
const LABEL_BACKGROUND = 'rgba(17, 24, 39, 0.62)'
const LABEL_COLOR = '#ffffff'
const PAGE_BACKGROUND = '#ffffff'

/** `document.createElement('canvas')` with an error instead of a silent null. */
function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('parsePdfPage: a DOM document with canvas support is required')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('parsePdfPage: could not create a 2D canvas context')
  return context
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('parsePdfPage: canvas.toBlob() is unavailable'))
      return
    }
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('parsePdfPage: failed to encode the canvas as PNG'))
      else resolve(blob)
    }, 'image/png')
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** One candidate box in canvas pixels (page bbox scaled by the canvas ratio). */
interface BoxPixels {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Draw the candidate overlay: the (downscaled) clean page plus thin candidate
 * rectangles and small semi-transparent `c1`… labels. Labels sit just above
 * their box when the page margin allows it and are translucent otherwise, so
 * the page text stays readable/OCR-able; boxes are border-only and never fill
 * the text area.
 *
 * The overlay canvas is downscaled from the HD page render so its long edge is
 * at most `overlayMaxEdge` px (Task 24): the vision model gets a small, fast
 * image, while the page PNG stored for the panel stays at `dpi`/`maxEdge`.
 */
function drawCandidateOverlay(
  pageCanvas: HTMLCanvasElement,
  candidates: readonly CandidateBlock[],
  widthPt: number,
  heightPt: number,
  overlayMaxEdge: number,
): HTMLCanvasElement {
  const pageLongEdge = Math.max(pageCanvas.width, pageCanvas.height)
  const factor =
    pageLongEdge > overlayMaxEdge && overlayMaxEdge > 0 ? overlayMaxEdge / pageLongEdge : 1
  const overlayWidth = Math.max(1, Math.ceil(pageCanvas.width * factor))
  const overlayHeight = Math.max(1, Math.ceil(pageCanvas.height * factor))
  const overlay = createCanvas(overlayWidth, overlayHeight)
  const context = canvasContext(overlay)
  context.drawImage(pageCanvas, 0, 0, overlayWidth, overlayHeight)

  const xRatio = widthPt > 0 ? overlay.width / widthPt : 1
  const yRatio = heightPt > 0 ? overlay.height / heightPt : 1
  const pxPerPt = Math.min(xRatio, yRatio)
  const lineWidth = Math.max(1, Math.round(pxPerPt))
  const fontPx = Math.max(11, Math.round(pxPerPt * 6))
  const padding = Math.max(2, Math.round(pxPerPt * 1.5))

  context.lineWidth = lineWidth
  context.font = `600 ${fontPx}px sans-serif`
  context.textBaseline = 'top'

  const boxes: { box: BoxPixels; candidate: CandidateBlock }[] = []
  for (const candidate of candidates) {
    const left = clamp(candidate.bbox.x * xRatio, 0, overlay.width)
    const top = clamp(candidate.bbox.y * yRatio, 0, overlay.height)
    const right = clamp((candidate.bbox.x + candidate.bbox.w) * xRatio, left, overlay.width)
    const bottom = clamp((candidate.bbox.y + candidate.bbox.h) * yRatio, top, overlay.height)
    boxes.push({ box: { left, top, right, bottom }, candidate })
  }

  // Boxes first, then labels: a label of one block may overlap a neighbouring
  // box border, but labels never hide the page beneath them (semi-transparent).
  for (const { box, candidate } of boxes) {
    context.strokeStyle = OVERLAY_COLORS[candidate.fontSizeBand]
    context.strokeRect(
      box.left + lineWidth / 2,
      box.top + lineWidth / 2,
      Math.max(0, box.right - box.left - lineWidth),
      Math.max(0, box.bottom - box.top - lineWidth),
    )
  }

  for (const { box, candidate } of boxes) {
    const label = candidate.candidateId
    const textWidth = context.measureText(label).width
    const badgeWidth = Math.ceil(textWidth + padding * 2)
    const badgeHeight = Math.ceil(fontPx + padding * 2)
    // Prefer the whitespace above the block, then below it; only a block
    // touching both page edges gets its label inside. The badge is translucent,
    // so even the last case leaves the page text readable.
    const above = box.top - badgeHeight - lineWidth
    const below = box.bottom + lineWidth
    const badgeTop =
      above >= 0 ? above : below + badgeHeight <= overlay.height ? below : box.top + lineWidth
    const badgeLeft = clamp(box.left, 0, Math.max(0, overlay.width - badgeWidth))

    context.fillStyle = LABEL_BACKGROUND
    context.fillRect(badgeLeft, badgeTop, badgeWidth, badgeHeight)
    context.fillStyle = LABEL_COLOR
    context.fillText(label, badgeLeft + padding, badgeTop + padding)
  }

  return overlay
}

/** Normalized parse options; the overlay long edge always has a value. */
interface NormalizedParseOptions extends ParsePdfPageOptions {
  overlayMaxEdge: number
  maxPngBytes: number
}

/** Normalize/validate the parse options before touching the file or PDF.js. */
function parseOptions(options: ParsePdfPageOptions): NormalizedParseOptions {
  if (typeof options !== 'object' || options === null) {
    throw new RangeError('parsePdfPage: options with dpi and maxEdge are required')
  }
  // Reuse the render-scale validator for one source of truth on the limits.
  computeRenderScale(0, 0, options)
  const overlayMaxEdge =
    options.overlayMaxEdge === undefined ? DEFAULT_OVERLAY_MAX_EDGE : options.overlayMaxEdge
  computeRenderScale(0, 0, { dpi: 1, maxEdge: overlayMaxEdge })
  const maxPngBytes = options.maxPngBytes === undefined ? MAX_PAGE_IMAGE_BYTES : options.maxPngBytes
  if (!Number.isFinite(maxPngBytes) || maxPngBytes <= 0) {
    throw new RangeError('parsePdfPage: maxPngBytes must be a positive finite number')
  }
  return { dpi: options.dpi, maxEdge: options.maxEdge, overlayMaxEdge, maxPngBytes }
}

/**
 * Encode the display page bitmap, progressively downsampling when the PNG
 * exceeds `maxPngBytes` (v1.1.0). The high-resolution source canvas remains
 * untouched and is still used for the vision overlay; only the bytes sent to
 * the Host and shown in the preview are bounded.
 */
async function encodeBoundedPagePng(
  source: HTMLCanvasElement,
  maxPngBytes: number,
): Promise<Blob> {
  let current = source
  let png = await canvasToPng(current)
  let attempt = 0
  while (png.size > maxPngBytes && attempt < 4 && current.width > 1 && current.height > 1) {
    const ratio = Math.max(0.4, Math.min(0.9, Math.sqrt(maxPngBytes / png.size) * 0.92))
    const next = createCanvas(
      Math.max(1, Math.floor(current.width * ratio)),
      Math.max(1, Math.floor(current.height * ratio)),
    )
    const context = canvasContext(next)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(current, 0, 0, next.width, next.height)
    current = next
    png = await canvasToPng(current)
    attempt += 1
  }
  if (png.size > maxPngBytes) {
    throw new Error(
      `parsePdfPage: page PNG is still ${png.size} bytes after downsampling (limit ${maxPngBytes})`,
    )
  }
  return png
}

/** PDF.js text-content entries: text runs plus marked-content markers. */
type PdfJsTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type PdfJsTextContentEntry = PdfJsTextContent['items'][number]
/** A real text run (the marked-content markers have no `str`). */
type PdfJsTextItem = Extract<PdfJsTextContentEntry, { str: string }>

/** PDF.js also reports marked-content markers; keep only real text runs. */
function isPdfTextContentItem(item: PdfJsTextContentEntry): item is PdfJsTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as { str?: unknown }).str === 'string' &&
    Array.isArray((item as { transform?: unknown }).transform)
  )
}

/**
 * Parse one single-page PDF into page coordinates, lines, candidates and PNGs.
 *
 * @throws {MultiPagePdfError} when the PDF has more than one page; nothing is
 *   rendered or returned in that case (v1 requires exactly one page).
 * @throws {RangeError} for invalid `dpi`/`maxEdge`/`overlayMaxEdge` options.
 */
export async function parsePdfPage(
  file: File,
  options: ParsePdfPageOptions,
): Promise<ParsedPage> {
  const { dpi, maxEdge, overlayMaxEdge, maxPngBytes } = parseOptions(options)
  if (file === null || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('parsePdfPage: a File/Blob with arrayBuffer() is required')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const pdfjs = await import('pdfjs-dist')
  installPdfWorker(pdfjs.GlobalWorkerOptions)

  // PDF.js 6 no longer evaluates font programs on the main thread, so no
  // `isEvalSupported` flag is needed; the page is only read, never scripted.
  const loadingTask: PDFDocumentLoadingTask = pdfjs.getDocument({ data: bytes })

  try {
    const documentProxy = await loadingTask.promise
    assertSinglePage(documentProxy.numPages)

    const page = await documentProxy.getPage(1)
    const pageViewport = page.getViewport({ scale: 1 })
    const widthPt = pageViewport.width
    const heightPt = pageViewport.height

    const textContent = await page.getTextContent()
    const pdfItems = textContent.items.filter(isPdfTextContentItem)
    const textItems = toTextItems(pdfItems, {
      scale: 1,
      transform: pageViewport.transform,
    })
    const lines = clusterTextItems(textItems, { widthPt, gapRatio: CLUSTER_GAP_RATIO })
    const candidates = buildCandidates(lines, { widthPt, heightPt })

    const renderScale = computeRenderScale(widthPt, heightPt, { dpi, maxEdge })
    const renderViewport = page.getViewport({ scale: renderScale })
    const pageCanvas = createCanvas(
      Math.max(1, Math.ceil(renderViewport.width)),
      Math.max(1, Math.ceil(renderViewport.height)),
    )
    const context = canvasContext(pageCanvas)

    const renderTask = page.render({
      canvas: pageCanvas,
      canvasContext: context,
      viewport: renderViewport,
      background: PAGE_BACKGROUND,
    })
    try {
      await renderTask.promise
    } catch (error) {
      try {
        renderTask.cancel()
      } catch {
        // The render task may already have settled; keep the original error.
      }
      throw error
    }

    const pagePng = await encodeBoundedPagePng(pageCanvas, maxPngBytes)
    const overlayPng = await canvasToPng(
      drawCandidateOverlay(pageCanvas, candidates, widthPt, heightPt, overlayMaxEdge),
    )

    return { widthPt, heightPt, textItems, lines, candidates, pagePng, overlayPng }
  } finally {
    // Always release the PDF.js document/worker: a rejected page-count guard
    // must not leave a worker running for the panel's lifetime.
    try {
      await loadingTask.destroy()
    } catch {
      // The loading task may already have failed/destroyed itself.
    }
  }
}

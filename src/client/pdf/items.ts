/**
 * Pure PDF.js text-layer conversion and single-page guard (Client, Task 16).
 *
 * Everything here is a plain function over numbers: no PDF.js import, no DOM,
 * no canvas. That keeps the page-coordinate conversion testable in Node and
 * lets `parser.ts` re-export the helpers as its public surface while loading
 * PDF.js dynamically only when a page is actually parsed.
 *
 * Coordinate convention (binding for the whole plugin, design §6.3): page
 * coordinates use a top-left origin with `y` growing downward, matching the
 * PDF.js viewport/canvas. A `TextItem.y` is the **top edge** of the run and
 * `y + h` is its bottom edge.
 *
 * PDF.js `TextItem.transform` is the text matrix in PDF user space (y grows
 * upward, origin bottom-left). Pass the page viewport's transform (from
 * `page.getViewport({ scale: 1 }).transform`) as `options.transform` to map the
 * items into top-down page points; without it the transform is taken as already
 * top-down. `options.scale` then rescales the resulting coordinates/sizes
 * (default `1`, i.e. PDF points).
 */
import type { TextItem } from '../../shared/types'

/**
 * The subset of a PDF.js text-content item this module needs.
 *
 * Structurally compatible with PDF.js's `TextItem`; kept local so the pure
 * module never imports the (browser-only) PDF.js package.
 */
export interface PdfTextItemLike {
  /** Text content of the run. */
  str: string
  /** PDF.js text matrix `[a, b, c, d, e, f]` (PDF user space). */
  transform: readonly number[]
  /** Run width in text-space units (already includes the font size). */
  width: number
  /** Run height in text-space units (≈ font size). */
  height: number
  /** PDF.js internal font name, when available. */
  fontName?: string
  /** PDF.js end-of-line marker; not needed for geometry. */
  hasEOL?: boolean
  /**
   * Text direction (`ltr`, `rtl`, `ttb`). A `ttb` run is laid out vertically:
   * PDF.js reports its font-size extent as `width` and its advance/length as
   * `height` (the opposite of a horizontal run), and its transform translation
   * is the visual top-left corner of the run.
   */
  dir?: string
}

/** Options for {@link toTextItems}. */
export interface ToTextItemsOptions {
  /**
   * Multiplier applied to the converted coordinates and sizes. The default `1`
   * returns PDF points; pass the render scale only when the caller wants the
   * result in device pixels.
   */
  scale?: number
  /**
   * PDF.js viewport transform `[a, b, c, d, e, f]` (from
   * `page.getViewport(...).transform`) applied to every item before scaling.
   * The usual `{ scale: 1 }` Letter viewport is `[1, 0, 0, -1, 0, 792]`, which
   * flips PDF's y-up text matrices into top-down page coordinates.
   */
  transform?: readonly number[]
}

/** Render options for {@link computeRenderScale}. */
export interface RenderScaleOptions {
  /** Render resolution in dots per inch (design §11.1: 120–240). */
  dpi: number
  /** Maximum length of the rendered page's long edge, in pixels. */
  maxEdge: number
}

/** A 2D affine matrix `[a, b, c, d, e, f]`. */
type Matrix = readonly [number, number, number, number, number, number]

/** Thrown when a PDF does not contain exactly one page (v1 is single-page only). */
export class MultiPagePdfError extends Error {
  /** Page count reported by PDF.js. */
  readonly numPages: number

  constructor(numPages: number) {
    super(
      `PDF must contain exactly 1 page; got ${numPages}. ` +
        'Split the PDF and upload a single page.',
    )
    this.name = 'MultiPagePdfError'
    this.numPages = numPages
  }
}

/**
 * Enforce the v1 single-page rule on a PDF.js page count.
 *
 * @throws {MultiPagePdfError} for any count other than exactly one page.
 */
export function assertSinglePage(numPages: number): void {
  if (numPages !== 1) throw new MultiPagePdfError(numPages)
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
  return value
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Validate a 6-element affine matrix (extra trailing members are ignored). */
function toMatrix(value: readonly number[] | undefined, name: string): Matrix {
  if (value === undefined || value.length < 6) {
    throw new TypeError(`${name} must be a 6-number affine matrix`)
  }
  const matrix = value.slice(0, 6)
  for (const component of matrix) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new TypeError(`${name} must contain only finite numbers`)
    }
  }
  return matrix as unknown as Matrix
}

/**
 * Matrix product `a × b` (column-vector convention), matching PDF.js
 * `Util.transform(a, b)`.
 */
function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/**
 * Convert PDF.js text-content items into shared `TextItem`s in page
 * coordinates (top-left origin, y down).
 *
 * Rules:
 * - whitespace-only runs are dropped (the line clusterer drops them too, but
 *   dropping them here keeps the conversion output clean);
 * - for a horizontal run `x` is the transformed run origin, `y` is the
 *   transformed baseline minus the run height (the top edge), so
 *   `x..x + w` / `y..y + h` bound the run;
 * - for a vertical (`dir: 'ttb'`) run the transform translation is already the
 *   visual top-left corner: `y` is the translation's y and the run's advance
 *   (`height`) becomes the vertical `h`, while the font-size extent (`width`)
 *   becomes the horizontal `w`. This keeps vertical slogans on-page (the old
 *   `baseline - height` produced negative y / off-page boxes) and still reports
 *   them as tall-thin boxes so the line clusterer can filter them;
 * - `fontSize` is the effective font size after the viewport transform
 *   (`hypot(matrix[2], matrix[3])` horizontally,
 *   `hypot(matrix[0], matrix[1])` for a vertical run);
 * - `fontName` is copied only when PDF.js provides one;
 * - the input array is never mutated.
 */
export function toTextItems(
  items: readonly PdfTextItemLike[],
  options: ToTextItemsOptions = {},
): TextItem[] {
  const scale =
    options.scale === undefined ? 1 : positiveNumber(options.scale, 'toTextItems: scale')
  const viewport = options.transform === undefined ? null : toMatrix(options.transform, 'transform')

  const converted: TextItem[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.str !== 'string' || item.str.trim() === '') continue

    const source = toMatrix(item.transform, 'item.transform')
    const matrix = viewport === null ? source : multiplyMatrix(viewport, source)
    const width = nonNegativeNumber(item.width) * scale
    const height = nonNegativeNumber(item.height) * scale
    const baseline = matrix[5] * scale
    const textItem: TextItem =
      item.dir === 'ttb'
        ? {
            str: item.str,
            // Vertical run: translation is the visual top-left corner; the
            // PDF.js width/height dimensions are swapped relative to a
            // horizontal run (width = font-size extent, height = advance).
            x: matrix[4] * scale,
            y: baseline,
            w: width,
            h: height,
            fontSize: Math.hypot(matrix[0], matrix[1]) * scale,
          }
        : {
            str: item.str,
            x: matrix[4] * scale,
            y: baseline - height,
            w: width,
            h: height,
            fontSize: Math.hypot(matrix[2], matrix[3]) * scale,
          }
    if (typeof item.fontName === 'string' && item.fontName !== '') {
      textItem.fontName = item.fontName
    }
    converted.push(textItem)
  }
  return converted
}

/**
 * Render scale for one page: `dpi / 72` (PDF points are 1/72 inch), capped so
 * the long edge stays within `maxEdge` pixels (design §6.1: 180 DPI, long edge
 * ≤ 2600 px).
 *
 * @throws {RangeError} when `dpi`/`maxEdge` are not positive finite numbers.
 */
export function computeRenderScale(
  widthPt: number,
  heightPt: number,
  options: RenderScaleOptions,
): number {
  const dpi = positiveNumber(options?.dpi, 'computeRenderScale: dpi')
  const maxEdge = positiveNumber(options?.maxEdge, 'computeRenderScale: maxEdge')
  const longestEdge = Math.max(nonNegativeNumber(widthPt), nonNegativeNumber(heightPt))
  const dpiScale = dpi / 72
  if (longestEdge === 0) return dpiScale
  return Math.min(dpiScale, maxEdge / longestEdge)
}

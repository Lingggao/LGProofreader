import type { BBox, TextItem, TextLine } from '../types'
import { unionBBox } from '../geometry/bbox'

/**
 * Deterministic text-line clustering for one PDF page.
 *
 * Page coordinates use a **top-left origin with `y` growing downward**, matching
 * the PDF.js viewport and the page canvas: a line's top edge is `bbox.y`, and a
 * smaller `y` means higher on the page. {@link clusterTextItems} folds the raw
 * runs into lines, splits lines at column gutters and returns them in reading
 * order (columns left to right, top to bottom inside a column).
 *
 * The shared `TextLine.baseline` field is the y of the line's top edge
 * (`bbox.y`), i.e. the coordinate that groups the line's runs together; it is
 * not the typographic baseline.
 */

/** Options for {@link clusterTextItems}. */
export interface ClusterTextItemsOptions {
  /**
   * Baseline tolerance as a multiple of font size. Two runs whose `y` values
   * differ by at most `baselineTolerance × fontSize` belong to the same visual
   * row. Defaults to `0.35`.
   */
  baselineTolerance?: number
  /**
   * Column gap as a multiple of font size: a horizontal gap wider than
   * `gapRatio × fontSize` inside one baseline starts a new line/column. When the
   * adjacent runs differ in size the smaller font sets the threshold, so a
   * display/vertical run can never swallow a body column across a real gutter.
   * Defaults to `1.2`.
   */
  gapRatio?: number
  /**
   * Page width in PDF points, used by the body-like line filter
   * (`w > 0.5 × page width` is page furniture, never a column sample).
   * Defaults to the right-most extent of the page's lines.
   */
  widthPt?: number
}

const DEFAULT_BASELINE_TOLERANCE = 0.35
const DEFAULT_GAP_RATIO = 1.2
/** Below this fraction of the font size a non-CJK gap is joined without a space. */
const SPACE_RATIO = 0.2
/** Lines no wider than this multiple of the median width are body-like. */
const BODY_LINE_RATIO = 1.2
/**
 * Body-like sample thresholds (design §6.1): a column is found from the *left
 * edges* of ordinary body-text lines only. Furniture that spans the page
 * (masthead, section headline, wide standfirst) and display type must never
 * contribute to the sample, otherwise it bridges the gutters it crosses.
 */
/** Lines taller than this multiple of the median line height are excluded. */
const BODY_MAX_HEIGHT_RATIO = 3
/** Lines wider than this fraction of the page width are excluded. */
const BODY_MAX_WIDTH_RATIO = 0.5
/** Body font sizes lie within these multiples of the median font size. */
const BODY_MIN_FONT_RATIO = 0.8
const BODY_MAX_FONT_RATIO = 1.6
/** Left-edge clustering tolerance as a multiple of the median font size. */
const COLUMN_TOLERANCE_RATIO = 2.5
/** A left-edge cluster needs at least this many lines ... */
const MIN_COLUMN_SUPPORT = 3
/** ... and at least this fraction of the body-like lines. */
const COLUMN_SUPPORT_RATIO = 0.03
/** Upper bound of column bands (a newspaper page rarely exceeds it). */
const MAX_COLUMNS = 8

/**
 * Characters that join without an inter-word space: CJK radicals and
 * punctuation, kana, Bopomofo, Hangul, CJK unified ideographs (incl.
 * extensions and compatibility ideographs) and full-width forms.
 */
const CJK_CHAR =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** A non-empty text run with precomputed horizontal extent. */
interface Run {
  item: TextItem
  /** Trimmed text; never empty. */
  text: string
  /** Left edge in page coordinates (sizes are treated as non-negative). */
  left: number
  /** Right edge in page coordinates. */
  right: number
}

/** A line before its column index and id are assigned. */
interface RawLine {
  text: string
  bbox: BBox
  fontSize: number
  fontWeight: number
  fontName?: string
  /** Top edge y of the line's union box (`bbox.y`; y grows downward). */
  baseline: number
}

/** Stable code-unit comparison; never locale-dependent. */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function toRun(item: TextItem): Run | null {
  const text = item.str.trim()
  if (text === '') return null
  return {
    item,
    text,
    left: Math.min(item.x, item.x + item.w),
    right: Math.max(item.x, item.x + item.w),
  }
}

function lastChar(text: string): string {
  return text.slice(-1)
}

function firstChar(text: string): string {
  return text.charAt(0)
}

function isCjkChar(char: string): boolean {
  return char !== '' && CJK_CHAR.test(char)
}

/** Top-to-bottom (ascending y, top edge first), then left-to-right. */
function compareRunsByTopLeft(a: Run, b: Run): number {
  return a.item.y - b.item.y || a.left - b.left || compareText(a.text, b.text)
}

/** Left-to-right within one baseline group (top edge first when x ties). */
function compareRunsByLeft(a: Run, b: Run): number {
  return a.left - b.left || a.item.y - b.item.y || compareText(a.text, b.text)
}

/**
 * Group runs of one page into baseline rows.
 *
 * Runs are visited from the top of the page downwards; a run joins the current
 * row while its top edge is within `baselineTolerance × fontSize` of the row's
 * top y, using the larger of the two font sizes for the tolerance. A run that
 * does not fit starts a new row, and because runs are sorted by `y` the rows are
 * contiguous and themselves in top-to-bottom order.
 */
function buildRows(runs: readonly Run[], baselineTolerance: number): Run[][] {
  const sorted = [...runs].sort(compareRunsByTopLeft)
  const rows: Run[][] = []
  let rowTopY = Number.NaN
  let rowMaxFontSize = 0

  for (const run of sorted) {
    const tolerance = baselineTolerance * Math.max(rowMaxFontSize, run.item.fontSize)
    if (rows.length === 0 || run.item.y - rowTopY > tolerance) {
      rows.push([run])
      rowTopY = run.item.y
      rowMaxFontSize = run.item.fontSize
    } else {
      rows[rows.length - 1].push(run)
      rowMaxFontSize = Math.max(rowMaxFontSize, run.item.fontSize)
    }
  }

  return rows.map((row) => row.sort(compareRunsByLeft))
}

/**
 * Split one baseline row into physical lines wherever the horizontal gap is
 * wider than `gapRatio × fontSize` (a column gutter).
 *
 * The threshold font is the **smaller** of the current segment's largest font
 * and the next run's font (Task 21c). A row can legitimately mix very different
 * type sizes — e.g. a 50 pt vertical slogan box that shares its baseline with
 * 8 pt body runs from the next column. Sizing the gutter by the larger font
 * (`0.5 × 50 = 25`) makes a 25 pt column gutter look "small" and merges the two
 * different typographic elements into one long line; sizing it by the smaller
 * font separates the columns. Runs of the **same** font size are unaffected
 * (min = max), so ordinary headline/body rows still join as before.
 */
function splitRow(row: readonly Run[], gapRatio: number): Run[][] {
  const segments: Run[][] = []
  let current: Run[] = []
  let currentMaxFontSize = 0

  for (const run of row) {
    if (current.length > 0) {
      const previous = current[current.length - 1]
      const gap = run.left - previous.right
      const thresholdFontSize = Math.min(currentMaxFontSize, run.item.fontSize)
      if (gap > gapRatio * thresholdFontSize) {
        segments.push(current)
        current = []
        currentMaxFontSize = 0
      }
    }
    current.push(run)
    currentMaxFontSize = Math.max(currentMaxFontSize, run.item.fontSize)
  }

  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * Join runs of one line: CJK + CJK never gets a space, otherwise a single space
 * is kept when the physical gap is wider than `0.2 × fontSize`.
 */
function mergeRunText(runs: readonly Run[]): string {
  let text = ''
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (index === 0) {
      text = run.text
      continue
    }
    const previous = runs[index - 1]
    const gap = run.left - previous.right
    const fontSize = Math.max(previous.item.fontSize, run.item.fontSize)
    const cjkBoundary = isCjkChar(lastChar(previous.text)) && isCjkChar(firstChar(run.text))
    if (!cjkBoundary && gap > SPACE_RATIO * fontSize) text += ' '
    text += run.text
  }
  return text
}

/** Turn one group of runs into a line (id and column are assigned later). */
function buildLine(runs: readonly Run[]): RawLine {
  const bbox = unionBBox(
    runs.map((run) => ({ x: run.item.x, y: run.item.y, w: run.item.w, h: run.item.h })),
  )
  if (bbox === null) {
    // Unreachable: `runs` always holds at least one item.
    throw new Error('clusterTextItems: cannot build a line from zero runs')
  }

  const fontSize = Math.max(...runs.map((run) => run.item.fontSize))
  const bold = runs.some((run) => run.item.fontName?.includes('Bold') === true)
  const fontRun =
    runs.find((run) => run.item.fontSize === fontSize && run.item.fontName !== undefined) ??
    runs.find((run) => run.item.fontName !== undefined)

  const line: RawLine = {
    text: mergeRunText(runs),
    bbox,
    fontSize,
    fontWeight: bold ? 700 : 400,
    // Top edge y of the union box; page coordinates grow downward.
    baseline: bbox.y,
  }
  if (fontRun !== undefined && fontRun.item.fontName !== undefined) {
    line.fontName = fontRun.item.fontName
  }
  return line
}

/** A contiguous band of x coordinates: one page column. */
interface XBand {
  start: number
  end: number
  center: number
}

/** Median of a non-empty numeric list (mean of the two middle values). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * Page width used by the body-like filter: the caller-provided page width when
 * valid, else the right-most extent of the page's lines.
 */
function pageWidthOf(lines: readonly RawLine[], requested: unknown): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return requested
  }
  let maxRight = 0
  for (const line of lines) maxRight = Math.max(maxRight, line.bbox.x + line.bbox.w)
  return maxRight
}

/**
 * Body-like lines of the column sample: ordinary text lines only.
 *
 * Excluded are very tall lines (vertical slogans, stacked display type), very
 * wide lines (masthead/section headlines and any page-wide furniture) and lines
 * whose font size is not a body font size. Those lines still belong to a column
 * afterwards; they simply must not *define* one.
 */
function bodyLikeLines(lines: readonly RawLine[], pageWidth: number): RawLine[] {
  if (lines.length === 0) return []
  const medianHeight = median(lines.map((line) => line.bbox.h))
  const medianFontSize = median(lines.map((line) => line.fontSize))
  const maxHeight = medianHeight * BODY_MAX_HEIGHT_RATIO
  const maxWidth = pageWidth * BODY_MAX_WIDTH_RATIO
  const minFont = medianFontSize * BODY_MIN_FONT_RATIO
  const maxFont = medianFontSize * BODY_MAX_FONT_RATIO
  return lines.filter(
    (line) =>
      line.bbox.h <= maxHeight &&
      (pageWidth <= 0 || line.bbox.w <= maxWidth) &&
      line.fontSize >= minFont &&
      line.fontSize <= maxFont,
  )
}

/** A contiguous cluster of body-like line left edges. */
interface StartCluster {
  /** Smallest left edge of the cluster. */
  start: number
  /** Largest left edge of the cluster (also the chaining reference). */
  end: number
  /** Member lines, all with a left edge in `start..end`. */
  lines: RawLine[]
}

/**
 * Cluster the body-like lines' left edges: consecutive starts within
 * `tolerance` belong to one cluster (one column). The raster of a newspaper is
 * uniform, so index lines, indented first lines and one-line strays of the same
 * column chain into a single cluster, while neighbouring columns start far
 * enough apart to stay separate.
 */
function clusterLeftEdges(bodyLines: readonly RawLine[], tolerance: number): StartCluster[] {
  const sorted = [...bodyLines].sort(
    (a, b) => a.bbox.x - b.bbox.x || a.bbox.y - b.bbox.y || compareText(a.text, b.text),
  )
  const clusters: StartCluster[] = []
  for (const line of sorted) {
    const left = line.bbox.x
    const last = clusters[clusters.length - 1]
    if (last !== undefined && left - last.end <= tolerance) {
      last.end = left
      last.lines.push(line)
    } else {
      clusters.push({ start: left, end: left, lines: [line] })
    }
  }
  return clusters
}

/** Robust column centre of one left-edge cluster (median start). */
function clusterCenter(cluster: StartCluster): number {
  return median(cluster.lines.map((line) => line.bbox.x))
}

/**
 * Supported column centres from the body-like left-edge clusters.
 *
 * A cluster needs `max(3, 3% of the body-like lines)` lines to be a column.
 * When more than {@link MAX_COLUMNS} clusters qualify, the strongest clusters
 * win (ties left-to-right). The result is sorted left-to-right.
 */
function supportedColumnCenters(bodyLines: readonly RawLine[], tolerance: number): number[] {
  if (bodyLines.length === 0) return []
  const clusters = clusterLeftEdges(bodyLines, tolerance)
  const minSupport = Math.max(MIN_COLUMN_SUPPORT, Math.ceil(COLUMN_SUPPORT_RATIO * bodyLines.length))
  return clusters
    .filter((cluster) => cluster.lines.length >= minSupport)
    .sort((a, b) => b.lines.length - a.lines.length || clusterCenter(a) - clusterCenter(b))
    .slice(0, MAX_COLUMNS)
    .map(clusterCenter)
    .sort((a, b) => a - b)
}

/**
 * Turn column centres into contiguous Voronoi x-bands: the boundary between two
 * neighbouring columns is the midpoint of their centres, so every line edge
 * belongs to exactly one band and {@link columnOf} can pick a column without
 * page-specific x values.
 */
function bandsFromCenters(centers: readonly number[], pageWidth: number): XBand[] {
  const sorted = [...centers].sort((a, b) => a - b)
  const bands: XBand[] = []
  for (let index = 0; index < sorted.length; index += 1) {
    const center = sorted[index]
    const start = index === 0 ? 0 : (sorted[index - 1] + center) / 2
    const end = index === sorted.length - 1 ? Math.max(pageWidth, center) : (center + sorted[index + 1]) / 2
    bands.push({ start, end, center })
  }
  return bands
}

/**
 * Find the page's column x-bands by clustering the body-like lines' left edges
 * (design §6.1).
 *
 * This replaces the interval-union projection wherever the page yields at least
 * two supported columns: the interval method cannot survive a header/weather
 * line that bridges the gutters, while the left edges of ordinary body lines
 * still line up per column. When fewer than two columns are supported (very
 * short pages, a single-column document, or a page without body-like lines),
 * the old interval method below is used unchanged.
 */
function computeLeftEdgeColumnBands(lines: readonly RawLine[], pageWidth: number): XBand[] {
  const bodyLines = bodyLikeLines(lines, pageWidth)
  if (bodyLines.length === 0) return []
  const medianFontSize = median(lines.map((line) => line.fontSize))
  const tolerance = COLUMN_TOLERANCE_RATIO * medianFontSize
  const centers = supportedColumnCenters(bodyLines, tolerance)
  if (centers.length < 2) return []
  return bandsFromCenters(centers, pageWidth)
}

/**
 * Interval-union column bands (the pre-Task-21 fallback).
 *
 * Only body-like lines (no wider than `BODY_LINE_RATIO × median line width`) are
 * projected onto the x axis: a headline spanning several columns would
 * otherwise bridge the gutter and collapse every column into one band. The
 * x-coverage intervals of the body-like spans are merged, and a gap wider than
 * `gapRatio × median fontSize` is a column gutter, so each coverage interval is
 * one column band. Spanning lines are assigned to a band afterwards (see
 * {@link columnOf}) and never take part in finding the bands.
 */
function computeIntervalColumnBands(lines: readonly RawLine[], gapRatio: number): XBand[] {
  const medianWidth = median(lines.map((line) => line.bbox.w))
  const gutter = gapRatio * median(lines.map((line) => line.fontSize))
  const bodyLike = lines.filter((line) => line.bbox.w <= medianWidth * BODY_LINE_RATIO)
  const projected = bodyLike.length > 0 ? bodyLike : lines
  const spans = projected
    .map((line) => ({ start: line.bbox.x, end: line.bbox.x + line.bbox.w }))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const bands: XBand[] = []
  for (const span of spans) {
    const band = bands[bands.length - 1]
    if (band !== undefined && span.start - band.end <= gutter) {
      band.end = Math.max(band.end, span.end)
    } else {
      bands.push({ start: span.start, end: span.end, center: 0 })
    }
  }
  return bands.map((band) => ({ ...band, center: (band.start + band.end) / 2 }))
}

/**
 * Column x-bands of the page: the left-edge clustering result when it finds at
 * least two supported columns, else the interval-union fallback.
 */
function computeColumnBands(
  lines: readonly RawLine[],
  gapRatio: number,
  widthPt: unknown,
): XBand[] {
  const pageWidth = pageWidthOf(lines, widthPt)
  const clustered = computeLeftEdgeColumnBands(lines, pageWidth)
  if (clustered.length >= 2) return clustered
  return computeIntervalColumnBands(lines, gapRatio)
}

/** Index of the band containing `x`, or `null` when no band contains it. */
function bandAt(bands: readonly XBand[], x: number): number | null {
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]
    if (x >= band.start && x <= band.end) return index
  }
  return null
}

/**
 * 0-based column band index for a line.
 *
 * A line crossing a column boundary is a spanning line (headline, standfirst,
 * full-width furniture): it is filed under the column its **left edge** starts
 * in, so it leads that column's reading flow instead of being dumped into the
 * widest middle column. Ordinary lines overlap one band only and use the band
 * with the largest horizontal overlap (ties: nearest centre, then left-most).
 */
function columnOf(bands: readonly XBand[], line: RawLine): number {
  if (bands.length <= 1) return 0

  const lineStart = line.bbox.x
  const lineEnd = line.bbox.x + line.bbox.w
  const lineCenter = lineStart + line.bbox.w / 2
  const startBand = bandAt(bands, lineStart)
  const endBand = bandAt(bands, lineEnd)
  if (startBand !== null && endBand !== null && startBand !== endBand) return startBand

  let bestColumn = 0
  let bestOverlap = Number.NEGATIVE_INFINITY
  let bestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]
    const overlap = Math.min(lineEnd, band.end) - Math.max(lineStart, band.start)
    const distance = Math.abs(lineCenter - band.center)
    if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
      bestColumn = index
      bestOverlap = overlap
      bestDistance = distance
    }
  }
  return bestColumn
}

/**
 * Reading order: column, then top-to-bottom (ascending y, y grows downward),
 * then left-to-right.
 */
function compareLines(
  a: RawLine & { column: number },
  b: RawLine & { column: number },
): number {
  return (
    a.column - b.column ||
    a.bbox.y - b.bbox.y ||
    a.bbox.x - b.bbox.x ||
    b.fontSize - a.fontSize ||
    compareText(a.text, b.text)
  )
}

/**
 * Cluster PDF text runs into lines and return them in reading order.
 *
 * Rules:
 * - whitespace-only runs are dropped;
 * - runs sharing a baseline (`0.35 × fontSize` tolerance) are grouped, sorted
 *   by `x` and split at column gutters (`> 1.2 × fontSize` gap);
 * - CJK runs join without a space, other runs keep one space across a gap
 *   larger than `0.2 × fontSize`;
 * - `bbox` is the union of the runs, `fontSize` the largest run size,
 *   `fontWeight` 700 when any run's font name contains `Bold`;
 * - lines are sorted by column, then top-to-bottom (ascending `bbox.y`), then
 *   left-to-right, and ids `l1`, `l2`, … are assigned in that order;
 * - columns are detected by clustering the left edges of body-like lines
 *   (tall/wide/display lines excluded), capped at 8; pages with fewer than two
 *   supported columns fall back to the interval-union projection.
 *
 * Page coordinates are top-left origin with y growing downward; `baseline` is
 * the line's top edge (`bbox.y`).
 */
export function clusterTextItems(
  items: readonly TextItem[],
  options: ClusterTextItemsOptions = {},
): TextLine[] {
  const baselineTolerance = options.baselineTolerance ?? DEFAULT_BASELINE_TOLERANCE
  const gapRatio = options.gapRatio ?? DEFAULT_GAP_RATIO

  const runs = items.map(toRun).filter((run): run is Run => run !== null)
  if (runs.length === 0) return []

  const lines: RawLine[] = []
  for (const row of buildRows(runs, baselineTolerance)) {
    for (const segment of splitRow(row, gapRatio)) {
      lines.push(buildLine(segment))
    }
  }

  const bands = computeColumnBands(lines, gapRatio, options.widthPt)
  const sorted = lines
    .map((line) => ({ ...line, column: columnOf(bands, line) }))
    .sort(compareLines)
  return sorted.map((line, index) => ({ ...line, id: `l${index + 1}` }))
}

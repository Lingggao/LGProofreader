import type { BBox, CandidateBlock, PageSize, TextLine } from '../types'
import { unionBBox } from '../geometry/bbox'

/**
 * Deterministic candidate-block generation for one newspaper page.
 *
 * The candidate blocks are the coarse layout proposals sent (as numbered boxes)
 * to the vision model; they are *not* the final article regions (see Task 5).
 * Page coordinates use the shared convention: top-left origin, `y` grows
 * downward, so a smaller `y` is higher on the page.
 *
 * Algorithm:
 * 1. `line.column` (assigned by `clusterTextItems`) is the primary column hint.
 *    Lines are grouped by that value only; no page-level x-projection is
 *    recomputed here, so a caller can deliberately merge/split columns upstream.
 * 2. Inside one column, lines are visited top-to-bottom and a new block starts
 *    when the vertical gap between the previous line's bottom edge and the next
 *    line's top edge is wider than `verticalGapRatio (1.6) × median line height`.
 * 3. Each block is banded by its largest font size relative to the page body
 *    font size: `headline` above `1.8 ×` body, `subhead` above `1.3 ×`, `small`
 *    below `0.8 ×`, otherwise `body`.
 * 4. A `headline` block is merged with the block directly below it in the same
 *    column when their horizontal overlap is wider than 60% of the narrower
 *    block (a title with the start of its body text) **and** the two blocks are
 *    actually adjacent: the vertical gap between them must be small, and a block
 *    that contains a very tall line (stacked display type / a vertical slogan)
 *    never merges. Without those guards a large title block could swallow a
 *    distant body/headline block and produce a candidate spanning the page.
 * 5. Blocks are capped at `maxCandidates (120)`, then ids `c1`, `c2`, … are
 *    assigned top-to-bottom and then left-to-right. Blocks beyond the cap are
 *    dropped from the end of that order (the lowest/right-most blocks).
 *
 * The page body font size is the median line font size when the page has enough
 * lines to be body-dominated; short pages (fewer than 8 lines) fall back to the
 * typical Chinese newspaper body size so a page made only of a big headline
 * still bands as `headline`.
 *
 * `lineIds` keep the order of the input `lines` array (which `clusterTextItems`
 * already returns in reading order) and every input line appears in at most one
 * candidate. Blocks are never merged across `column` bands, and line ids are not
 * duplicated.
 */

/** Tunables for {@link buildCandidates}; the defaults are the brief's values. */
export interface BuildCandidatesOptions {
  /** Maximum number of candidates returned. Defaults to `120`. */
  maxCandidates?: number
  /**
   * A vertical gap wider than this multiple of the median line height splits a
   * column into two blocks. Defaults to `1.6`.
   */
  verticalGapRatio?: number
  /**
   * A block whose font size exceeds this multiple of the body font size is a
   * `headline`. Defaults to `1.8`.
   */
  headlineRatio?: number
  /**
   * Horizontal overlap required to merge a headline with the block below it,
   * as a fraction of the narrower block's width. Defaults to `0.6`.
   */
  mergeOverlapRatio?: number
  /**
   * Maximum vertical gap between a headline block and the block below it for a
   * merge, as a multiple of the median line height. Defaults to `1.5`.
   */
  mergeGapRatio?: number
  /**
   * Overrides the estimated page body font size used for banding. Useful when
   * the caller knows the newspaper's body size; by default it is estimated from
   * the lines.
   */
  bodyFontSize?: number
}

/** A candidate block before ids are assigned. */
interface Block {
  column: number
  bbox: BBox
  lineIds: string[]
  /** Largest line font size in the block. */
  fontSize: number
  band: CandidateBlock['fontSizeBand']
  /**
   * True when a member line is very tall (`h > TALL_LINE_RATIO × median line
   * height`): stacked display type or a vertical slogan. Such a block never
   * merges with its neighbour, because the union would be a huge box.
   */
  tall: boolean
}

const DEFAULT_MAX_CANDIDATES = 120
const DEFAULT_VERTICAL_GAP_RATIO = 1.6
const DEFAULT_HEADLINE_RATIO = 1.8
const DEFAULT_MERGE_OVERLAP_RATIO = 0.6
const DEFAULT_MERGE_GAP_RATIO = 1.5
/**
 * A headline may still bridge up to this many block-splitting gaps: a title with
 * its own body on a sparse page can be separated by a couple of blank lines even
 * though the page median line height is small. Both limits must be respected.
 */
const MERGE_MIN_SPLIT_GAP_RATIO = 2.5
/** Lines taller than this multiple of the median line height block a merge. */
const TALL_LINE_RATIO = 3
/** Band thresholds relative to the page body font size (see `fontSizeBandOf`). */
const SUBHEAD_RATIO = 1.3
const SMALL_RATIO = 0.8
/** Typical Chinese newspaper body size, used when the page sample is too small. */
const DEFAULT_BODY_FONT_SIZE = 12
/** Below this many lines the page median is not a body-text estimate. */
const MIN_BODY_SAMPLE_LINES = 8

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Median of a non-empty numeric list (mean of the two middle values). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Line height in page points (`bbox.h`; `y` grows downward). */
function lineHeight(line: TextLine): number {
  return line.bbox.h
}

/** Clamp a box to the page; boxes that stick out are clipped to the page edge. */
function clampBBoxToPage(box: BBox, page: PageSize): BBox {
  const x = clamp(box.x, 0, page.widthPt)
  const y = clamp(box.y, 0, page.heightPt)
  const right = clamp(box.x + box.w, 0, page.widthPt)
  const bottom = clamp(box.y + box.h, 0, page.heightPt)
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}

/**
 * Page body font size: the median line font size when the page is
 * body-dominated, otherwise the default newspaper body size (a single big
 * headline on an otherwise empty page must still band as `headline`).
 */
function estimateBodyFontSize(lines: readonly TextLine[]): number {
  if (lines.length < MIN_BODY_SAMPLE_LINES) return DEFAULT_BODY_FONT_SIZE
  return median(lines.map((line) => line.fontSize))
}

/** Band a block by its largest font size, relative to the body font size. */
function fontSizeBandOf(
  fontSize: number,
  bodyFontSize: number,
  headlineRatio: number,
): CandidateBlock['fontSizeBand'] {
  if (fontSize > headlineRatio * bodyFontSize) return 'headline'
  if (fontSize > SUBHEAD_RATIO * bodyFontSize) return 'subhead'
  if (fontSize < SMALL_RATIO * bodyFontSize) return 'small'
  return 'body'
}

/**
 * Width of the horizontal intersection of two boxes, as a fraction of the
 * narrower box (1 = the narrower box is completely inside the other one).
 */
function horizontalOverlapRatio(a: BBox, b: BBox): number {
  const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const narrower = Math.min(a.w, b.w)
  if (overlap <= 0 || narrower <= 0) return 0
  return overlap / narrower
}

/** Build one block from a set of line indexes (line ids keep input order). */
function buildBlock(
  lines: readonly TextLine[],
  members: readonly number[],
  column: number,
  page: PageSize,
  bodyFontSize: number,
  headlineRatio: number,
  tallLimit: number,
): Block {
  const ordered = [...members].sort((a, b) => a - b)
  const memberLines = ordered.map((index) => lines[index])
  const box = unionBBox(memberLines.map((line) => line.bbox))
  if (box === null) {
    // Unreachable: a block is only built from at least one line.
    throw new Error('buildCandidates: cannot build a block from zero lines')
  }
  const fontSize = Math.max(...memberLines.map((line) => line.fontSize))
  return {
    column,
    bbox: clampBBoxToPage(box, page),
    lineIds: memberLines.map((line) => line.id),
    fontSize,
    band: fontSizeBandOf(fontSize, bodyFontSize, headlineRatio),
    tall: memberLines.some((line) => line.bbox.h > tallLimit),
  }
}

/** Merge a headline block with the block directly below it. */
function mergeBlocks(
  headline: Block,
  below: Block,
  page: PageSize,
  bodyFontSize: number,
  headlineRatio: number,
): Block {
  const box = unionBBox([headline.bbox, below.bbox])
  if (box === null) {
    // Unreachable: both blocks carry a box.
    throw new Error('buildCandidates: cannot merge blocks without boxes')
  }
  const fontSize = Math.max(headline.fontSize, below.fontSize)
  return {
    column: headline.column,
    bbox: clampBBoxToPage(box, page),
    lineIds: [...headline.lineIds, ...below.lineIds],
    fontSize,
    band: fontSizeBandOf(fontSize, bodyFontSize, headlineRatio),
    tall: headline.tall || below.tall,
  }
}

/** Visitor for one column band: split the top-down list into blocks. */
function splitColumn(
  lines: readonly TextLine[],
  indexes: readonly number[],
  column: number,
  splitGap: number,
  page: PageSize,
  bodyFontSize: number,
  headlineRatio: number,
  tallLimit: number,
): Block[] {
  const topDown = [...indexes].sort(
    (a, b) =>
      lines[a].bbox.y - lines[b].bbox.y ||
      lines[a].bbox.x - lines[b].bbox.x ||
      a - b,
  )

  const blocks: Block[] = []
  let members: number[] = []
  let bottom = Number.NEGATIVE_INFINITY

  const flush = (): void => {
    if (members.length === 0) return
    blocks.push(
      buildBlock(lines, members, column, page, bodyFontSize, headlineRatio, tallLimit),
    )
    members = []
  }

  for (const index of topDown) {
    const line = lines[index]
    if (members.length > 0 && line.bbox.y - bottom > splitGap) flush()
    members.push(index)
    const lineBottom = line.bbox.y + lineHeight(line)
    bottom = members.length === 1 ? lineBottom : Math.max(bottom, lineBottom)
  }
  flush()
  return blocks
}

/**
 * Split the text lines of one page into candidate layout blocks.
 *
 * The result is deterministic (same lines and options always give the same
 * blocks, ids and line ids), never mutates `lines`, and is safe for an empty
 * page (returns `[]`).
 */
export function buildCandidates(
  lines: readonly TextLine[],
  page: PageSize,
  options: BuildCandidatesOptions = {},
): CandidateBlock[] {
  const maxCandidates = Math.max(0, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES))
  if (lines.length === 0 || maxCandidates === 0) return []

  const verticalGapRatio = options.verticalGapRatio ?? DEFAULT_VERTICAL_GAP_RATIO
  const headlineRatio = options.headlineRatio ?? DEFAULT_HEADLINE_RATIO
  const mergeOverlapRatio = options.mergeOverlapRatio ?? DEFAULT_MERGE_OVERLAP_RATIO
  const mergeGapRatio = options.mergeGapRatio ?? DEFAULT_MERGE_GAP_RATIO
  const bodyFontSize = options.bodyFontSize ?? estimateBodyFontSize(lines)
  const medianHeight = median(lines.map(lineHeight))
  const splitGap = verticalGapRatio * medianHeight
  const tallLimit = TALL_LINE_RATIO * medianHeight
  // A merge may bridge the gap between the headline block and its body, but no
  // further: a large title must never swallow a distant block (which is how a
  // candidate ends up spanning the whole body of the page).
  const mergeGap = Math.max(mergeGapRatio * medianHeight, MERGE_MIN_SPLIT_GAP_RATIO * splitGap)

  const indexesByColumn = new Map<number, number[]>()
  lines.forEach((line, index) => {
    const bucket = indexesByColumn.get(line.column)
    if (bucket === undefined) indexesByColumn.set(line.column, [index])
    else bucket.push(index)
  })

  const blocks: Block[] = []
  for (const column of [...indexesByColumn.keys()].sort((a, b) => a - b)) {
    const columnBlocks = splitColumn(
      lines,
      indexesByColumn.get(column) ?? [],
      column,
      splitGap,
      page,
      bodyFontSize,
      headlineRatio,
      tallLimit,
    )
    // A headline absorbs the block directly below it (title + start of body).
    for (let index = 0; index < columnBlocks.length; index += 1) {
      const current = columnBlocks[index]
      const below = columnBlocks[index + 1]
      if (below !== undefined) {
        const verticalGap = below.bbox.y - (current.bbox.y + current.bbox.h)
        const merges =
          current.band === 'headline' &&
          !current.tall &&
          !below.tall &&
          verticalGap <= mergeGap &&
          horizontalOverlapRatio(current.bbox, below.bbox) > mergeOverlapRatio
        if (merges) {
          blocks.push(mergeBlocks(current, below, page, bodyFontSize, headlineRatio))
          index += 1
          continue
        }
      }
      blocks.push(current)
    }
  }

  blocks.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.column - b.column)

  const textById = new Map(lines.map((line) => [line.id, line.text]))
  return blocks.slice(0, maxCandidates).map((block, index) => ({
    candidateId: `c${index + 1}`,
    bbox: block.bbox,
    lineIds: [...block.lineIds],
    fontSizeBand: block.band,
    firstLineText: textById.get(block.lineIds[0]) ?? '',
    lineCount: block.lineIds.length,
  }))
}

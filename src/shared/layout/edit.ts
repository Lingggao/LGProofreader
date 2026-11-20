import type { BBox, PageSize, Point, Region, TextLine } from '../types'
import { bboxCenter, containsPoint, normalizeBBox, unionBBox } from '../geometry/bbox'

/**
 * Pure, defensive manual editing of layout regions (Task 18's inspector and
 * canvas call these).
 *
 * Rules shared by every operation:
 * - the input regions are never mutated: all results are fresh objects with
 *   fresh `bbox` and `lineIds` arrays;
 * - `lineIds` stay unique inside every result (duplicates are dropped, order of
 *   first occurrence is kept);
 * - geometric operations return a box clamped to the page (top-left origin,
 *   `y` grows downward) and mark the result `source: 'manual'`, because the
 *   boundary is now author-defined rather than model-proposed;
 * - ids are preserved: `move`/`resize` keep the region id, `merge` keeps the
 *   first region's id, `split` keeps the id for the first part and derives
 *   `<id>-2` for the second part.
 *
 * `mergeRegions`/`splitRegion` have no page argument: they combine boxes that
 * are already page-clamped, so their result cannot leave the page for regular
 * input. `splitRegion`'s optional `lines` are used to partition the line ids by
 * line bbox centre; without them every id stays in one part (still unique).
 */

const EPSILON = 1e-9

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Keep the first occurrence of every line id, preserving order. */
function uniqueLineIds(lineIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const lineId of lineIds) {
    if (seen.has(lineId)) continue
    seen.add(lineId)
    unique.push(lineId)
  }
  return unique
}

/** Fresh copy of a region (defensive: callers may keep the original). */
function cloneRegion(region: Region): Region {
  return {
    ...region,
    bbox: { ...region.bbox },
    lineIds: uniqueLineIds(region.lineIds),
  }
}

/**
 * Clamp a box into the page. Oversized boxes are shrunk to the page and then
 * positioned, so the result is always inside the page for a positive page size.
 */
function clampToPage(box: BBox, page: PageSize): BBox {
  const normalized = normalizeBBox(box)
  const w = Math.min(normalized.w, page.widthPt)
  const h = Math.min(normalized.h, page.heightPt)
  return {
    x: clamp(normalized.x, 0, page.widthPt - w),
    y: clamp(normalized.y, 0, page.heightPt - h),
    w,
    h,
  }
}

/** Translate a region by `(dx, dy)` and clamp the result to the page. */
export function moveRegion(region: Region, dx: number, dy: number, page: PageSize): Region {
  const box = normalizeBBox(region.bbox)
  return {
    ...cloneRegion(region),
    bbox: clampToPage({ ...box, x: box.x + dx, y: box.y + dy }, page),
    source: 'manual',
  }
}

/** Replace a region's box (inverted boxes are normalized) and clamp it to the page. */
export function resizeRegion(region: Region, bbox: BBox, page: PageSize): Region {
  return {
    ...cloneRegion(region),
    bbox: clampToPage(bbox, page),
    source: 'manual',
  }
}

/**
 * Merge two regions into one: union box, unique line ids (first region's first),
 * smallest order, first region's id/kind/page and confidence, and `manual`
 * source. An `articleId` only present on the second region is carried over.
 */
export function mergeRegions(first: Region, second: Region): Region {
  const box = unionBBox([first.bbox, second.bbox])
  if (box === null) {
    // Unreachable: two regions always contribute a box.
    throw new Error('mergeRegions: cannot merge regions without boxes')
  }
  const merged: Region = {
    ...cloneRegion(first),
    bbox: normalizeBBox(box),
    lineIds: uniqueLineIds([...first.lineIds, ...second.lineIds]),
    order: Math.min(first.order, second.order),
    source: 'manual',
  }
  if (merged.articleId === undefined && second.articleId !== undefined) {
    merged.articleId = second.articleId
  }
  return merged
}

/** Intersection of two normalized boxes, or `null` when it has no area. */
function intersectBoxes(a: BBox, b: BBox): BBox | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (right - x <= EPSILON || bottom - y <= EPSILON) return null
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Largest axis-aligned strip left over when `taken` is removed from `source`.
 * The strip spans the source's full width (above/below) or full height
 * (left/right), so a normal "cut the region in two" split (the taken box
 * spanning one axis) produces an exact complement. The largest strip wins, with
 * ties in the fixed order above, below, left, right.
 */
function largestRemainingStrip(source: BBox, taken: BBox): BBox | null {
  const candidates: BBox[] = [
    { x: source.x, y: source.y, w: source.w, h: taken.y - source.y },
    { x: source.x, y: taken.y + taken.h, w: source.w, h: source.y + source.h - (taken.y + taken.h) },
    { x: source.x, y: source.y, w: taken.x - source.x, h: source.h },
    { x: taken.x + taken.w, y: source.y, w: source.x + source.w - (taken.x + taken.w), h: source.h },
  ]
  let best: BBox | null = null
  let bestArea = 0
  for (const box of candidates) {
    if (box.w <= EPSILON || box.h <= EPSILON) continue
    const area = box.w * box.h
    if (area > bestArea) {
      best = box
      bestArea = area
    }
  }
  return best
}

/**
 * Split a region in two.
 *
 * `splitBBox` is the area of the first part; it is clamped to the region, and
 * the second part is the largest remaining strip of the region's box (exact
 * complement for a straight cut). Line ids are partitioned by line bbox centre
 * when `lines` is given: ids whose centre lies in the first part go there, all
 * others stay in the second part. Without line geometry every id stays in the
 * second part, so no id is duplicated or lost.
 *
 * Throws `RangeError` when the split box does not overlap the region or covers
 * all of it. The first part keeps the region id and the second part uses
 * `<id>-2`; a caller that splits the same id repeatedly must de-duplicate ids
 * before persisting the layout.
 */
export function splitRegion(
  region: Region,
  splitBBox: BBox,
  lines: readonly TextLine[] = [],
): [Region, Region] {
  const source = normalizeBBox(region.bbox)
  const taken = intersectBoxes(source, normalizeBBox(splitBBox))
  if (taken === null) {
    throw new RangeError('splitRegion: the split box does not overlap the region')
  }
  const rest = largestRemainingStrip(source, taken)
  if (rest === null) {
    throw new RangeError('splitRegion: the split box covers the whole region')
  }

  const centers = new Map<string, Point>()
  for (const line of lines) centers.set(line.id, bboxCenter(line.bbox))

  const firstLineIds: string[] = []
  const secondLineIds: string[] = []
  for (const lineId of uniqueLineIds(region.lineIds)) {
    const center = centers.get(lineId)
    if (center !== undefined && containsPoint(taken, center)) firstLineIds.push(lineId)
    else secondLineIds.push(lineId)
  }

  const first: Region = {
    ...cloneRegion(region),
    bbox: taken,
    lineIds: firstLineIds,
    source: 'manual',
  }
  const second: Region = {
    ...cloneRegion(region),
    id: `${region.id}-2`,
    bbox: rest,
    lineIds: secondLineIds,
    order: region.order + 1,
    source: 'manual',
  }
  return [first, second]
}

/**
 * Move a region one place earlier (`up`) or later (`down`) in reading order.
 *
 * The returned array is a fresh copy in `order` order (ties keep the input
 * order) with the region moved one slot and every `order` renumbered 0..n-1.
 * The edges and an unknown `regionId` leave the sequence unchanged.
 */
export function reorderRegion(
  regions: readonly Region[],
  regionId: string,
  direction: 'up' | 'down',
): Region[] {
  const ordered = regions
    .map((region, index) => ({ region, index }))
    .sort((a, b) => a.region.order - b.region.order || a.index - b.index)
    .map((entry) => cloneRegion(entry.region))
  const index = ordered.findIndex((region) => region.id === regionId)
  if (index < 0) return ordered

  const neighbour = direction === 'up' ? index - 1 : index + 1
  if (neighbour >= 0 && neighbour < ordered.length) {
    const moved = ordered[index]
    ordered[index] = ordered[neighbour]
    ordered[neighbour] = moved
  }
  return ordered.map((region, position) => ({ ...region, order: position }))
}

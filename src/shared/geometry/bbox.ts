import type { BBox, Point } from '../types'

/**
 * Axis-aligned rectangle helpers shared by the layout pipeline (Host) and the
 * page canvas (Client).
 *
 * Only the sign of `w`/`h` is treated specially: negative sizes describe an
 * inverted box whose origin is not its top-left corner. No assumption is made
 * about whether the y axis grows up or down, so every helper here works in
 * either orientation.
 */

/** Normalize an inverted box (negative `w`/`h`) to a positive-size box. */
export function normalizeBBox(box: BBox): BBox {
  return {
    x: box.w < 0 ? box.x + box.w : box.x,
    y: box.h < 0 ? box.y + box.h : box.y,
    w: Math.abs(box.w),
    h: Math.abs(box.h),
  }
}

/** Center point of a box; inverted boxes are normalized first. */
export function bboxCenter(box: BBox): Point {
  const normalized = normalizeBBox(box)
  return {
    x: normalized.x + normalized.w / 2,
    y: normalized.y + normalized.h / 2,
  }
}

/**
 * True when two boxes overlap with a positive area.
 * Boxes that only share an edge or a corner do not intersect.
 */
export function intersects(a: BBox, b: BBox): boolean {
  const left = normalizeBBox(a)
  const right = normalizeBBox(b)
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  )
}

/** True when a point lies inside the box or on its edge. */
export function containsPoint(box: BBox, point: Point): boolean {
  const normalized = normalizeBBox(box)
  return (
    point.x >= normalized.x &&
    point.x <= normalized.x + normalized.w &&
    point.y >= normalized.y &&
    point.y <= normalized.y + normalized.h
  )
}

/**
 * Smallest box containing every input box, or `null` when `boxes` is empty
 * (an empty union has no meaningful location or size).
 */
export function unionBBox(boxes: readonly BBox[]): BBox | null {
  if (boxes.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const box of boxes) {
    const normalized = normalizeBBox(box)
    minX = Math.min(minX, normalized.x)
    minY = Math.min(minY, normalized.y)
    maxX = Math.max(maxX, normalized.x + normalized.w)
    maxY = Math.max(maxY, normalized.y + normalized.h)
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

import { describe, expect, it } from 'vitest'
import { bboxCenter, containsPoint, intersects, normalizeBBox, unionBBox } from '../../src/shared/geometry/bbox'

describe('bbox', () => {
  it('normalizes inverted boxes', () => {
    expect(normalizeBBox({ x: 30, y: 40, w: -10, h: -20 })).toEqual({ x: 20, y: 20, w: 10, h: 20 })
  })
  it('detects intersection and containment', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    expect(intersects(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(intersects(a, { x: 20, y: 0, w: 5, h: 5 })).toBe(false)
    expect(containsPoint(a, { x: 9, y: 1 })).toBe(true)
  })
  it('unions and centers boxes', () => {
    expect(unionBBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }]))
      .toEqual({ x: 0, y: 0, w: 30, h: 30 })
    expect(bboxCenter({ x: 0, y: 0, w: 10, h: 20 })).toEqual({ x: 5, y: 10 })
  })
})

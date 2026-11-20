import { describe, expect, it } from 'vitest'
import { moveRegion, mergeRegions, reorderRegion, resizeRegion, splitRegion } from '../../src/shared/layout/edit'

const region = (id: string, x = 0, y = 0, w = 100, h = 100) => ({
  id, page: 1, kind: 'article' as const, bbox: { x, y, w, h }, lineIds: [id], order: 0,
  confidence: 1, source: 'manual' as const,
})

const page = { widthPt: 500, heightPt: 500 }

// Text line geometry used by splitRegion to partition ids by bbox centre.
const textLine = (id: string, x: number, y: number, w = 40, h = 12) =>
  ({ id, text: id, bbox: { x, y, w, h }, fontSize: 12, fontWeight: 400, baseline: y, column: 0 })

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('edit', () => {
  it('moves and clamps inside the page', () => {
    const moved = moveRegion(region('r1'), -200, -200, { widthPt: 500, heightPt: 500 })
    expect(moved.bbox).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })
  it('merges line ids without duplicates', () => {
    expect(mergeRegions(region('r1'), { ...region('r2'), lineIds: ['r1', 'r3'] }).lineIds.sort()).toEqual(['r1', 'r3'])
  })
  it('splits by bbox and reorders', () => {
    expect(splitRegion(region('r1'), { x: 0, y: 0, w: 50, h: 100 })).toHaveLength(2)
    expect(reorderRegion([region('a'), region('b')], 'b', 'up').map(r => r.id)).toEqual(['b', 'a'])
  })
})

// Extra coverage for the edit-operation rules in the task brief. The three tests
// above are the required acceptance tests; these pin page clamping, input
// immutability, id uniqueness, split partitioning and reorder edge cases.
describe('edit rules', () => {
  it('keeps the region size when moving and clamps at the page edges', () => {
    const moved = moveRegion(region('r1', 400, 400), 1000, 1000, page)
    expect(moved.bbox).toEqual({ x: 400, y: 400, w: 100, h: 100 })
    expect(moved.id).toBe('r1')
    expect(moved.kind).toBe('article')
    expect(moved.page).toBe(1)
    expect(moved.source).toBe('manual')
  })

  it('does not mutate the regions passed to the edit operations', () => {
    const original = region('r1', 10, 10)
    const before = clone(original)
    moveRegion(original, 50, 50, page)
    resizeRegion(original, { x: 1, y: 2, w: 3, h: 4 }, page)
    splitRegion(original, { x: 0, y: 0, w: 50, h: 100 })
    expect(original).toEqual(before)
  })

  it('resizes, normalizes an inverted box and clamps it to the page', () => {
    const resized = resizeRegion(region('r1'), { x: 100, y: 100, w: -50, h: -20 }, page)
    expect(resized.bbox).toEqual({ x: 50, y: 80, w: 50, h: 20 })
    const clamped = resizeRegion(region('r1'), { x: -50, y: 900, w: 200, h: 200 }, page)
    expect(clamped.bbox).toEqual({ x: 0, y: 300, w: 200, h: 200 })
  })

  it('merges boxes, keeps the first identity and does not mutate the inputs', () => {
    const first = region('r1', 0, 0, 100, 100)
    const second = { ...region('r2', 50, 50, 100, 100), lineIds: ['r2', 'r3'] }
    const beforeFirst = clone(first)
    const beforeSecond = clone(second)
    const merged = mergeRegions(first, second)
    expect(merged.bbox).toEqual({ x: 0, y: 0, w: 150, h: 150 })
    expect(merged.lineIds).toEqual(['r1', 'r2', 'r3'])
    expect(merged.id).toBe('r1')
    expect(merged.order).toBe(0)
    expect(first).toEqual(beforeFirst)
    expect(second).toEqual(beforeSecond)
  })

  it('splits boxes and line ids by line bbox centre', () => {
    const target = { ...region('r1', 0, 0, 100, 100), lineIds: ['l1', 'l2', 'l3'] }
    const before = clone(target)
    const [left, right] = splitRegion(target, { x: 0, y: 0, w: 50, h: 100 }, [
      textLine('l1', 0, 0), // centre x = 20 -> left
      textLine('l2', 60, 0), // centre x = 80 -> right
      textLine('l3', 10, 0), // centre x = 30 -> left
    ])
    expect(left.bbox).toEqual({ x: 0, y: 0, w: 50, h: 100 })
    expect(right.bbox).toEqual({ x: 50, y: 0, w: 50, h: 100 })
    expect(left.lineIds).toEqual(['l1', 'l3'])
    expect(right.lineIds).toEqual(['l2'])
    expect(left.id).toBe('r1')
    expect(right.id).toBe('r1-2')
    expect(target).toEqual(before)
  })

  it('keeps split line ids unique when no line geometry is given', () => {
    const [first, second] = splitRegion(region('r1'), { x: 0, y: 0, w: 50, h: 100 })
    expect(first.id).not.toBe(second.id)
    expect([...first.lineIds, ...second.lineIds]).toEqual(['r1'])
  })

  it('rejects a split box that does not overlap the region', () => {
    expect(() => splitRegion(region('r1'), { x: 200, y: 200, w: 10, h: 10 })).toThrow(RangeError)
  })

  it('reorders by swapping with the neighbour and renumbers order', () => {
    const regions = [region('a'), region('b'), region('c')]
    const before = clone(regions)
    const movedUp = reorderRegion(regions, 'c', 'up')
    expect(movedUp.map(item => item.id)).toEqual(['a', 'c', 'b'])
    expect(movedUp.map(item => item.order)).toEqual([0, 1, 2])
    const movedDown = reorderRegion(regions, 'a', 'down')
    expect(movedDown.map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect(movedDown.map(item => item.order)).toEqual([0, 1, 2])
    expect(regions).toEqual(before)
  })

  it('leaves the order unchanged at the edges and for an unknown id', () => {
    const regions = [region('a'), region('b')]
    expect(reorderRegion(regions, 'a', 'up').map(item => item.id)).toEqual(['a', 'b'])
    expect(reorderRegion(regions, 'b', 'down').map(item => item.id)).toEqual(['a', 'b'])
    expect(reorderRegion(regions, 'missing', 'up').map(item => item.id)).toEqual(['a', 'b'])
  })
})

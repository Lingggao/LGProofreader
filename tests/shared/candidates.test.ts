import { describe, expect, it } from 'vitest'
import { buildCandidates } from '../../src/shared/layout/candidates'
import { clusterTextItems } from '../../src/shared/layout/lines'

// Page coordinates are top-left origin with y growing downward (PDF.js viewport
// / canvas convention): a smaller y is higher on the page.
const line = (id: string, text: string, x: number, y: number, w: number, fontSize = 12) =>
  ({ id, text, bbox: { x, y, w, h: fontSize }, fontSize, fontWeight: 400, baseline: y, column: x > 500 ? 1 : 0 })

const page = { widthPt: 1000, heightPt: 1400 }

describe('buildCandidates', () => {
  it('keeps two columns separate', () => {
    const candidates = buildCandidates([
      line('l1', '左栏一', 10, 700, 200), line('l2', '左栏二', 10, 685, 200),
      line('l3', '右栏一', 600, 700, 200), line('l4', '右栏二', 600, 685, 200),
    ], { widthPt: 1000, heightPt: 1400 })
    expect(candidates).toHaveLength(2)
    expect(candidates[0].lineIds).toEqual(['l1', 'l2'])
  })
  it('splits a column at a large vertical gap', () => {
    const candidates = buildCandidates([
      line('l1', '上', 10, 700, 200), line('l2', '下', 10, 600, 200),
    ], { widthPt: 1000, heightPt: 1400 })
    expect(candidates).toHaveLength(2)
  })
  it('assigns font bands and stable ids', () => {
    const candidates = buildCandidates([line('l1', '大标题', 10, 700, 300, 30)], { widthPt: 1000, heightPt: 1400 })
    expect(candidates[0].candidateId).toBe('c1')
    expect(candidates[0].fontSizeBand).toBe('headline')
  })
})

// Extra coverage for the candidate rules in the task brief. The three tests
// above are the required acceptance tests; these pin the numeric thresholds,
// ordering, font bands, headline merging, capping, page clamping and the
// `line.column` contract (the column hint, not an x-projection, is authoritative).
describe('buildCandidates rules', () => {
  it('returns no candidates for an empty page', () => {
    expect(buildCandidates([], page)).toEqual([])
  })

  it('groups by the line.column hint instead of recomputing x bands', () => {
    // Same column although the left edges are far apart: no large vertical gap.
    expect(buildCandidates([
      { ...line('l1', '左', 10, 700, 100), column: 0 },
      { ...line('l2', '右', 300, 685, 100), column: 0 },
    ], page)).toHaveLength(1)
    // Conflicting geometry must not override the hint: same x, different columns.
    expect(buildCandidates([
      { ...line('l1', '甲', 10, 700, 100), column: 0 },
      { ...line('l2', '乙', 10, 685, 100), column: 1 },
    ], page)).toHaveLength(2)
  })

  it('splits a column only when the vertical gap exceeds 1.6 × median line height', () => {
    const upper = line('l1', '上', 10, 600, 200)
    expect(buildCandidates([upper, line('l2', '下', 10, 631, 200)], page)).toHaveLength(1) // gap 19
    expect(buildCandidates([upper, line('l2', '下', 10, 632, 200)], page)).toHaveLength(2) // gap 20
  })

  it('orders ids top-to-bottom and then left-to-right', () => {
    const candidates = buildCandidates([
      line('l3', '左二', 10, 400, 200),
      line('l1', '左一', 10, 100, 200),
      line('l2', '右一', 600, 100, 200),
    ], page)
    expect(candidates.map((candidate) => candidate.candidateId)).toEqual(['c1', 'c2', 'c3'])
    expect(candidates.map((candidate) => candidate.firstLineText)).toEqual(['左一', '右一', '左二'])
  })

  it('estimates the page body font size and assigns all four bands', () => {
    const body = Array.from({ length: 8 }, (_, index) =>
      line(`b${index}`, `正文${index}`, 10, 700 - index * 15, 200, 10))
    const candidates = buildCandidates([
      ...body,
      { ...line('s1', '小标题', 600, 700, 200, 15), column: 1 },
      { ...line('z1', '小字', 800, 700, 100, 7), column: 2 },
    ], page)
    const bands = candidates.map((candidate) => [candidate.firstLineText, candidate.fontSizeBand])
    expect(bands).toContainEqual(['正文0', 'body'])
    expect(bands).toContainEqual(['小标题', 'subhead'])
    expect(bands).toContainEqual(['小字', 'small'])
  })

  it('merges a headline with the block directly below when they overlap', () => {
    const candidates = buildCandidates([
      line('l1', '大标题', 10, 100, 300, 30),
      line('l2', '正文第一行', 10, 200, 300),
    ], page)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].fontSizeBand).toBe('headline')
    expect(candidates[0].lineIds).toEqual(['l1', 'l2'])
    expect(candidates[0].lineCount).toBe(2)
    expect(candidates[0].firstLineText).toBe('大标题')
    expect(candidates[0].bbox).toEqual({ x: 10, y: 100, w: 300, h: 112 })
  })

  it('does not merge when the horizontal overlap is at most 60%', () => {
    expect(buildCandidates([
      line('l1', '大标题', 10, 100, 200, 30),
      line('l2', '正文', 110, 200, 200), // overlap 50%
    ], page)).toHaveLength(2)
    expect(buildCandidates([
      line('l1', '大标题', 10, 100, 200, 30),
      line('l2', '正文', 210, 200, 200), // overlap 0%
    ], page)).toHaveLength(2)
  })

  it('caps the number of candidates and renumbers ids', () => {
    const lines = Array.from({ length: 130 }, (_, index) => ({
      ...line(`l${index}`, `t${index}`, index * 7, 700, 6),
      column: index,
    }))
    const capped = buildCandidates(lines, page)
    expect(capped).toHaveLength(120)
    expect(capped[0].candidateId).toBe('c1')
    expect(capped[capped.length - 1].candidateId).toBe('c120')
    expect(capped[capped.length - 1].firstLineText).toBe('t119')
    const limited = buildCandidates(lines, page, { maxCandidates: 5 })
    expect(limited.map((candidate) => candidate.candidateId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('honours the option overrides', () => {
    const headline = [line('l1', '标题', 10, 100, 300, 30)]
    expect(buildCandidates(headline, page)[0].fontSizeBand).toBe('headline')
    expect(buildCandidates(headline, page, { bodyFontSize: 30 })[0].fontSizeBand).toBe('body')
    expect(buildCandidates(headline, page, { headlineRatio: 2.5 })[0].fontSizeBand).toBe('subhead')

    const stack = [line('l1', '上', 10, 600, 200), line('l2', '下', 10, 632, 200)] // gap 20
    expect(buildCandidates(stack, page)).toHaveLength(2)
    expect(buildCandidates(stack, page, { verticalGapRatio: 2 })).toHaveLength(1)

    const title = line('l1', '大标题', 10, 100, 200, 30)
    const body = line('l2', '正文', 110, 200, 200) // 50% overlap
    expect(buildCandidates([title, body], page)).toHaveLength(2)
    expect(buildCandidates([title, body], page, { mergeOverlapRatio: 0.4 })).toHaveLength(1)
  })

  it('clamps a candidate box to the page', () => {
    const candidates = buildCandidates([line('l1', '溢出', 900, 700, 200)], page)
    expect(candidates[0].bbox).toEqual({ x: 900, y: 700, w: 100, h: 12 })
  })

  it('consumes clusterTextItems output with its columns and reading order intact', () => {
    const lines = clusterTextItems([
      { str: '左栏第一行', x: 10, y: 700, w: 200, h: 12, fontSize: 12 },
      { str: '左栏第二行', x: 10, y: 715, w: 200, h: 12, fontSize: 12 },
      { str: '右栏第一行', x: 600, y: 700, w: 200, h: 12, fontSize: 12 },
      { str: '右栏第二行', x: 600, y: 715, w: 200, h: 12, fontSize: 12 },
    ])
    const candidates = buildCandidates(lines, page)
    expect(candidates).toHaveLength(2)
    expect(candidates[0].lineIds).toEqual(['l1', 'l2'])
    expect(candidates[1].lineIds).toEqual(['l3', 'l4'])
  })

  it('does not merge a headline with a distant block below it', () => {
    // Same column and full horizontal overlap, but the body block is far below
    // the title: merging them would produce a candidate spanning the page body.
    const candidates = buildCandidates(
      [
        line('l1', '大标题', 10, 100, 300, 30),
        line('l2', '远处正文', 10, 900, 300),
      ],
      page,
    )
    expect(candidates).toHaveLength(2)
    expect(candidates.some((candidate) => candidate.lineIds.includes('l1'))).toBe(true)
    expect(candidates.every((candidate) => candidate.lineIds.length === 1)).toBe(true)
  })

  it('still merges a normal title with the start of its body', () => {
    // The gap is one blank body line: the title keeps its body start.
    const candidates = buildCandidates(
      [
        line('l1', '大标题', 10, 100, 300, 30),
        line('l2', '正文第一行', 10, 180, 300),
      ],
      page,
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0].fontSizeBand).toBe('headline')
    expect(candidates[0].lineIds).toEqual(['l1', 'l2'])
  })

  it('does not merge a block that contains a very tall display/ttb line', () => {
    const body = Array.from({ length: 6 }, (_, index) =>
      line(`b${index}`, `正文${index}`, 600, 100 + index * 15, 200, 10),
    )
    // A vertical slogan: small font but a 300 pt tall box (like a ttb run).
    const slogan = {
      ...line('l1', '竖排标语', 10, 100, 40, 30),
      bbox: { x: 10, y: 100, w: 40, h: 300 },
    }
    const below = line('l2', '下方正文', 10, 440, 300)

    const candidates = buildCandidates([slogan, below, ...body], page)
    const sloganCandidate = candidates.find((candidate) => candidate.lineIds.includes('l1'))!
    const belowCandidate = candidates.find((candidate) => candidate.lineIds.includes('l2'))!
    // The slogan keeps its own box; the union would be dominated by the tall line.
    expect(sloganCandidate.lineIds).toEqual(['l1'])
    expect(belowCandidate.lineIds).toEqual(['l2'])
    expect(candidates.every((candidate) => candidate.bbox.h < 500)).toBe(true)
  })

  it('assigns every line to exactly one candidate and does not mutate the input', () => {
    const lines = [
      line('l1', '标题', 10, 100, 300, 30),
      line('l2', '正文一', 10, 200, 300),
      line('l3', '正文二', 10, 215, 300),
      line('l4', '右标题', 600, 100, 300, 30),
      line('l5', '右正文', 600, 200, 300),
    ]
    const before = JSON.parse(JSON.stringify(lines))
    const candidates = buildCandidates(lines, page)
    expect(candidates.flatMap((candidate) => candidate.lineIds).sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'])
    expect(lines).toEqual(before)
  })
})

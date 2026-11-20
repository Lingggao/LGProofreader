import { describe, expect, it } from 'vitest'
import { clusterTextItems } from '../../src/shared/layout/lines'
import { buildCandidates } from '../../src/shared/layout/candidates'

// Page coordinates are top-left origin with y growing downward (PDF.js viewport
// / canvas convention): a smaller y is higher on the page.
const item = (str: string, x: number, y: number, w = 12, h = 12, fontSize = 12) =>
  ({ str, x, y, w, h, fontSize })

describe('clusterTextItems', () => {
  it('merges adjacent runs on the same baseline', () => {
    const lines = clusterTextItems([
      item('今日', 10, 700), item('天气', 23, 700), item('晴', 36, 700),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('今日天气晴')
    expect(lines[0].bbox.x).toBe(10)
  })

  it('does not merge across a large column gap', () => {
    const lines = clusterTextItems([item('左栏', 10, 700), item('右栏', 600, 700)])
    expect(lines).toHaveLength(2)
  })

  it('drops empty runs and keeps largest font for the line', () => {
    const lines = clusterTextItems([item('  ', 10, 700), item('标题', 10, 730, 60, 30, 30)])
    expect(lines).toHaveLength(1)
    expect(lines[0].fontSize).toBe(30)
  })

  it('orders by column then top-to-bottom', () => {
    const lines = clusterTextItems([
      item('a', 10, 680), item('b', 10, 700), item('c', 600, 720),
    ])
    expect(lines.map(line => line.text)).toEqual(['a', 'b', 'c'])
  })
})

// Extra coverage for the clustering rules in the task brief. The four tests
// above are the required acceptance tests; these pin the numeric thresholds and
// the edge cases the rules mention (ids, columns, baseline, bold runs, options).
describe('clusterTextItems rules', () => {
  it('returns no lines for empty or whitespace-only input', () => {
    expect(clusterTextItems([])).toEqual([])
    expect(clusterTextItems([item('   ', 10, 700), item('\n', 10, 700)])).toEqual([])
  })

  it('groups baselines within 0.35 × fontSize', () => {
    expect(clusterTextItems([item('甲', 10, 700), item('乙', 10, 704)])).toHaveLength(1)
    expect(clusterTextItems([item('甲', 10, 700), item('乙', 10, 705)])).toHaveLength(2)
  })

  it('splits a baseline at a gap wider than 1.2 × fontSize', () => {
    expect(clusterTextItems([item('甲', 10, 700), item('乙', 36, 700)])).toHaveLength(1) // 14pt gap
    expect(clusterTextItems([item('甲', 10, 700), item('乙', 37, 700)])).toHaveLength(2) // 15pt gap
  })

  it('joins CJK runs without a space even across a wide gap', () => {
    const lines = clusterTextItems([item('今日', 10, 700), item('天气', 25, 700)]) // 3pt gap
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('今日天气')
  })

  it('keeps one space between non-CJK runs only when the gap is wide enough', () => {
    expect(clusterTextItems([item('ab', 10, 700), item('cd', 25, 700)])[0].text).toBe('ab cd') // 3pt gap
    expect(clusterTextItems([item('ab', 10, 700), item('cd', 24, 700)])[0].text).toBe('abcd') // 2pt gap
  })

  it('sets baseline to the top edge (bbox.y) of mixed-height runs', () => {
    const lines = clusterTextItems([
      item('甲', 10, 680, 12, 12),
      item('乙', 23, 678, 12, 20),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].bbox).toEqual({ x: 10, y: 678, w: 25, h: 20 })
    expect(lines[0].baseline).toBe(678)
    expect(lines[0].baseline).toBe(lines[0].bbox.y)
  })

  it('marks the line bold and keeps the largest run font name', () => {
    const lines = clusterTextItems([
      { ...item('标题', 10, 680, 60, 30, 30), fontName: 'SimHei-Bold' },
      item('正文', 10, 700, 24, 12, 12),
    ])
    expect(lines).toHaveLength(2)
    expect(lines.map(line => line.id)).toEqual(['l1', 'l2'])
    expect(lines[0]).toMatchObject({
      text: '标题', fontSize: 30, fontWeight: 700, fontName: 'SimHei-Bold', column: 0, baseline: 680,
    })
    expect(lines[1]).toMatchObject({ text: '正文', fontSize: 12, fontWeight: 400 })
  })

  it('keeps two columns intact, numbered left-to-right with stable ids', () => {
    const lines = clusterTextItems([
      item('左一', 10, 680), item('左二', 10, 700),
      item('右一', 600, 680), item('右二', 600, 700),
    ])
    expect(lines.map(line => line.text)).toEqual(['左一', '左二', '右一', '右二'])
    expect(lines.map(line => line.column)).toEqual([0, 0, 1, 1])
    expect(lines.map(line => line.id)).toEqual(['l1', 'l2', 'l3', 'l4'])
  })

  it('keeps indented paragraph lines in their column', () => {
    const lines = clusterTextItems([
      item('左一', 74, 1070, 200), item('左二', 50, 1085, 250), item('左三', 50, 1100, 250),
      item('右一', 350, 1070, 250), item('右二', 350, 1085, 250),
    ])
    expect(lines.map(line => line.text)).toEqual(['左一', '左二', '左三', '右一', '右二'])
    expect(lines.map(line => line.column)).toEqual([0, 0, 0, 1, 1])
  })

  it('keeps columns when a centered headline bridges the gutter', () => {
    const lines = clusterTextItems([
      item('居中标题', 155, 1000, 340),
      item('左一', 50, 1060, 250), item('左二', 50, 1085, 250),
      item('右一', 350, 1060, 250), item('右二', 350, 1085, 250),
    ])
    expect(lines.map(line => line.text)).toEqual(['居中标题', '左一', '左二', '右一', '右二'])
    expect(lines.map(line => line.column)).toEqual([0, 0, 0, 1, 1])
  })

  it('reads a realistic interleaved two-column page in column order', () => {
    // Input deliberately in PDF run order: left/right columns interleaved, an
    // indented paragraph first line, and a lead headline spanning both columns.
    const lines = clusterTextItems([
      item('（本报讯）本报记者张三报道', 50, 1000, 550, 30, 30),
      item('第一栏第一行', 50, 1060, 250),
      item('右栏第一行', 350, 1060, 250),
      item('第一栏第二行', 74, 1075, 226),
      item('右栏第二行', 350, 1075, 250),
      item('第一栏第三行', 50, 1090, 250),
      item('右栏第三行', 374, 1090, 226),
    ])
    expect(lines.map(line => line.text)).toEqual([
      '（本报讯）本报记者张三报道',
      '第一栏第一行', '第一栏第二行', '第一栏第三行',
      '右栏第一行', '右栏第二行', '右栏第三行',
    ])
  })

  it('honours baselineTolerance and gapRatio overrides', () => {
    const a = item('甲', 10, 700)
    const b = item('乙', 23, 701)
    expect(clusterTextItems([a, b], { baselineTolerance: 0 })).toHaveLength(2)
    expect(clusterTextItems([a, b])).toHaveLength(1)

    const wide = clusterTextItems([item('左栏', 10, 700), item('右栏', 600, 700)], { gapRatio: 100 })
    expect(wide).toHaveLength(1)
    expect(wide[0].text).toBe('左栏右栏')
  })

  it('does not mutate the input items', () => {
    const items = [item(' 甲 ', 10, 700)]
    const snapshot = JSON.parse(JSON.stringify(items))
    const lines = clusterTextItems(items)
    expect(items).toEqual(snapshot)
    expect(lines[0].text).toBe('甲')
  })
})

/*
 * Task 21a: column detection on a newspaper-like page.
 *
 * The real failing page collapsed into a single column because full-width
 * header/weather lines bridged every gutter in the interval-union projection.
 * The fixed detector clusters the *left edges* of body-like lines instead, so
 * spanning furniture can no longer merge the columns.
 */
describe('column detection (left-edge clustering)', () => {
  const PAGE = { widthPt: 1000, heightPt: 1200 }
  const BODY_FONT = 10
  const COLUMN_X = [40, 230, 420, 610, 800] as const
  const COLUMN_WIDTH = 150

  /** Five body-text columns plus a masthead and gutter-bridging weather labels. */
  function fiveColumnPage() {
    const items = []
    // Full-width masthead headline: must never become a column or a body block.
    items.push(item('文汇报', 40, 20, 920, 34, 34))
    // Short weather labels starting inside the gutters (they bridge columns).
    for (const [index, x] of [60, 200, 390, 580, 770].entries()) {
      items.push(item(`上海晴${index}`, x, 64, 80, 8, 8))
    }
    // Five body columns, each an eight-line paragraph with an indented start.
    for (const [column, x] of COLUMN_X.entries()) {
      for (let line = 0; line < 8; line += 1) {
        const indent = line % 3 === 0 ? 16 : 0
        items.push(item(`第${column + 1}栏第${line + 1}行`, x + indent, 110 + line * 14, COLUMN_WIDTH, BODY_FONT, BODY_FONT))
      }
    }
    return items
  }

  it('finds several columns and candidates on a 5-column page with header/weather noise', () => {
    const items = fiveColumnPage()
    const lines = clusterTextItems(items, { widthPt: PAGE.widthPt })
    const bodyLines = lines.filter((line) => line.fontSize === BODY_FONT)
    expect(bodyLines).toHaveLength(COLUMN_X.length * 8)

    const columns = new Set(bodyLines.map((line) => line.column))
    expect(columns.size).toBeGreaterThan(1)
    expect(columns.size).toBe(COLUMN_X.length)

    const candidates = buildCandidates(lines, PAGE)
    expect(candidates.length).toBeGreaterThanOrEqual(5)

    // The real-page regression was one candidate holding almost every body
    // line; no candidate may swallow the whole body like that again.
    const bodyIds = new Set(bodyLines.map((line) => line.id))
    for (const candidate of candidates) {
      const bodyLineShare =
        candidate.lineIds.filter((lineId) => bodyIds.has(lineId)).length / bodyLines.length
      expect(bodyLineShare).toBeLessThan(0.5)
    }

    // Every body line stays in exactly one candidate.
    const seen = new Set<string>()
    for (const candidate of candidates) {
      for (const lineId of candidate.lineIds) {
        expect(seen.has(lineId)).toBe(false)
        seen.add(lineId)
      }
    }
  })

  it('caps the detected columns at 8', () => {
    const items = []
    for (let column = 0; column < 10; column += 1) {
      for (let line = 0; line < 6; line += 1) {
        items.push(item(`列${column}行${line}`, 20 + column * 95, 110 + line * 14, 70, 10, 10))
      }
    }
    const lines = clusterTextItems(items, { widthPt: PAGE.widthPt })
    const columns = new Set(lines.map((line) => line.column))
    expect(columns.size).toBeGreaterThan(1)
    expect(columns.size).toBeLessThanOrEqual(8)
  })

  it('never lets vertical slogan runs create columns', () => {
    const items = []
    // Two real body columns.
    for (let line = 0; line < 8; line += 1) {
      items.push(item(`左栏第${line}行`, 100, 110 + line * 14, 200, 10, 10))
      items.push(item(`右栏第${line}行`, 700, 110 + line * 14, 200, 10, 10))
    }
    // A tall large-font vertical slogan above the body and a small one below it:
    // both are excluded from the body-like sample and must not add a column.
    items.push(item('以高质量党建引领企业高质量发展', 30, 40, 40, 700, 40))
    items.push(item('扫码看视频', 560, 800, 8, 44, 8))

    const lines = clusterTextItems(items, { widthPt: PAGE.widthPt })
    const bodyColumns = new Set(
      lines.filter((line) => line.fontSize === BODY_FONT).map((line) => line.column),
    )
    expect(bodyColumns.size).toBe(2)
  })

  it('falls back to the interval method when fewer than 2 left-edge clusters are supported', () => {
    // Two lines per column: the left-edge clusters have support 2, below the
    // 3-line minimum, so the interval projection still separates the columns.
    const lines = clusterTextItems(
      [
        item('左一', 50, 100, 250),
        item('左二', 50, 130, 250),
        item('右一', 350, 100, 250),
        item('右二', 350, 130, 250),
      ],
      { widthPt: 1000 },
    )
    expect(new Set(lines.map((line) => line.column)).size).toBe(2)
  })

  it('keeps a single full-width column as column 0', () => {
    const lines = clusterTextItems(
      Array.from({ length: 12 }, (_, line) => item(`正文第${line}行`, 50, 100 + line * 14, 500)),
      { widthPt: 600 },
    )
    expect(new Set(lines.map((line) => line.column))).toEqual(new Set([0]))
  })
})

/*
 * Task 21c: a baseline row may contain a display/vertical run and body text at
 * very different font sizes. The gutter threshold must be set by the *smaller*
 * font, otherwise a 50 pt slogan box swallows the 8 pt body column to its right
 * (the real page's polluted `l5` title). Same-size runs keep the old behaviour.
 */
describe('mixed font-size gutters', () => {
  // Horizontal body runs after the page parser's ttb conversion: 50 pt slogan
  // box ending at x = 135.5, body text starting at x = 160 (24.5 pt gutter).
  const slogan = { str: '以高质量党建引领企业高质量发展', x: 85.5, y: 250, w: 50, h: 756, fontSize: 50 }
  const bodyRun = { str: '日电新华社北京', x: 160, y: 250, w: 96.8, h: 8.19, fontSize: 8.19 }

  it('splits a 50 pt vertical/display run from an 8 pt body run across a 25 pt gutter', () => {
    const lines = clusterTextItems([slogan, bodyRun], { gapRatio: 0.5 })
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.text)).toEqual([
      '以高质量党建引领企业高质量发展',
      '日电新华社北京',
    ])
  })

  it('splits the mixed-size pair at the shared default gap ratio too', () => {
    // min(50, 8.19) × 1.2 ≈ 9.8 pt < the 24.5 pt gutter: still a column break.
    expect(clusterTextItems([slogan, bodyRun])).toHaveLength(2)
  })

  it('keeps same-font display runs joined at normal spacing', () => {
    const lines = clusterTextItems(
      [
        { str: '习近平', x: 100, y: 250, w: 150, h: 50, fontSize: 50 },
        { str: '将出席', x: 255, y: 250, w: 150, h: 50, fontSize: 50 },
      ],
      { gapRatio: 0.5 },
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('习近平将出席')
  })
})

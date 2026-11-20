import { describe, expect, it } from 'vitest'
import { assembleArticles } from '../../src/shared/layout/assemble'
import type { AssembleInput } from '../../src/shared/layout/assemble'
import { cleanTextSpacing } from '../../src/shared/text/clean'
import type { CandidateBlock, PageSize, TextLine } from '../../src/shared/types'
import type {
  VisionArticle,
  VisionLayout,
  VisionRegion,
} from '../../src/shared/layout/vision-schema'

// Page coordinates are top-left origin with y growing downward (PDF.js viewport
// / canvas convention): bbox.y is the top edge, a smaller y is higher on the
// page, and reading order is column asc, bbox.y asc, bbox.x asc.
//
// The Task 5 brief fixture encoded the old y-up convention (title at y=1200
// above body lines at y=1085). The same physical page is expressed here in the
// binding top-down coordinates (title above byline above both body rows); the
// pinned title/byline/body/overlap expectations are the brief's, unchanged.
const page: PageSize = { widthPt: 1000, heightPt: 1400 }
const line = (id: string, text: string, x: number, y: number, w: number, fontSize = 12): TextLine => ({
  id, text, bbox: { x, y, w, h: fontSize }, fontSize, fontWeight: 400,
  baseline: y, column: x > 500 ? 1 : 0,
})
const candidate = (candidateId: string, lineIds: string[], band: 'headline' | 'body' = 'body'): CandidateBlock => ({
  candidateId, bbox: { x: 0, y: 0, w: 100, h: 100 }, lineIds, fontSizeBand: band,
  firstLineText: '', lineCount: lineIds.length,
})
const vision: VisionLayout = {
  pageType: 'news',
  regions: [
    { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 0.9 },
    { candidateId: 'c2', kind: 'article', articleGroup: 'a1', readingOrder: 2, confidence: 0.9 },
  ],
  articles: [{ id: 'a1', titleCandidateId: 'c1', role: 'lead', order: 1, regionIds: ['c1', 'c2'], continuation: 'none', confidence: 0.9 }],
  warnings: [],
}
const lines = [
  line('l1', '主标题', 50, 100, 300, 30),
  line('l2', '本报讯 记者 张三', 50, 160, 300),
  line('l3', '第一栏第一行', 50, 200, 400),
  line('l4', '第一栏第二行', 50, 215, 400),
  line('l5', '第二栏第一行', 550, 200, 400),
  line('l6', '第二栏第二行', 550, 215, 400),
]

describe('assembleArticles', () => {
  it('reads columns left-to-right and keeps title/byline/body', () => {
    const result = assembleArticles({
      page, lines,
      candidates: [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4', 'l5', 'l6'])],
      vision,
    })
    expect(result.articles).toHaveLength(1)
    expect(result.articles[0].title).toBe('主标题')
    expect(result.articles[0].byline).toBe('本报讯记者张三')
    expect(result.articles[0].body).toBe('第一栏第一行第一栏第二行第二栏第一行第二栏第二行')
    expect(result.stats.overlap).toBe(0)
  })

  it('cleans PDF glyph spaces and preserves natural paragraphs without indentation', () => {
    const result = assembleArticles({
      page,
      lines: [
        line('l1', '主 标 题', 50, 100, 300, 30),
        line('l2', '第 一 段 第 一 行', 50, 200, 400),
        line('l3', '第 一 段 第 二 行', 50, 215, 400),
        line('l4', '第 二 段 第 一 行', 68, 230, 400),
        line('l5', '第 二 段 第 二 行', 50, 245, 400),
      ],
      candidates: [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4', 'l5'])],
      vision: {
        ...vision,
        articles: [
          {
            ...vision.articles[0],
            titleCandidateId: 'c1',
            regionIds: ['c1', 'c2'],
          },
        ],
      },
    })
    expect(result.articles[0].title).toBe('主标题')
    expect(result.articles[0].body).toBe(
      '第一段第一行第一段第二行\n\n第二段第一行第二段第二行',
    )
    expect(result.articles[0].body.startsWith(' ')).toBe(false)
    expect(result.articles[0].body).not.toMatch(/ {2,}/)
  })

  it('does not treat a short bold phrase as a name-only byline', () => {
    const result = assembleArticles({
      page,
      lines: [
        line('l1', '标题', 50, 100, 300, 30),
        line('l2', '正文前半句', 50, 200, 400, 9),
        line('l3', '砥砺前行', 300, 205, 80, 12),
        line('l4', '正文后半句', 50, 210, 400, 9),
      ],
      candidates: [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4'])],
      vision: {
        ...vision,
        articles: [
          {
            ...vision.articles[0],
            titleCandidateId: 'c1',
            regionIds: ['c1', 'c2'],
          },
        ],
      },
    })
    expect(result.articles[0].byline).toBeUndefined()
    expect(result.articles[0].body).toContain('砥砺前行')
  })

  it('folds a name-only byline inserted between body lines out of the body', () => {
    const result = assembleArticles({
      page,
      lines: [
        line('l1', '古寺赏枫记', 50, 100, 300, 30),
        line('l2', '从银阁到方丈东侧有一泓碧水，池畔遍植红枫青松，高低', 50, 200, 400, 9),
        line('l3', '范慕尤', 300, 205, 80, 12),
        line('l4', '不同，错落有致。', 50, 210, 400, 9),
      ],
      candidates: [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4'])],
      vision: {
        ...vision,
        articles: [
          {
            ...vision.articles[0],
            titleCandidateId: 'c1',
            regionIds: ['c1', 'c2'],
          },
        ],
      },
    })
    expect(result.articles[0].byline).toBe('范慕尤')
    expect(result.articles[0].body).toBe(
      '从银阁到方丈东侧有一泓碧水，池畔遍植红枫青松，高低不同，错落有致。',
    )
    expect(result.articles[0].body).not.toContain('范慕尤')
    expect(result.articles[0].fullText).toBe(
      '古寺赏枫记\n\n范慕尤\n\n从银阁到方丈东侧有一泓碧水，池畔遍植红枫青松，高低不同，错落有致。',
    )
  })

  it('folds a decorative byline and the following author name out of the body', () => {
    const result = assembleArticles({
      page,
      lines: [
        line('l1', '标 题', 50, 100, 300, 30),
        line('l2', '■本报记者', 50, 150, 200, 12),
        line('l3', '沈 雷', 100, 150, 80, 10),
        line('l4', '自 2024 年 起 正 文', 50, 180, 400, 12),
      ],
      candidates: [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4'])],
      vision: {
        ...vision,
        articles: [
          {
            ...vision.articles[0],
            titleCandidateId: 'c1',
            regionIds: ['c1', 'c2'],
          },
        ],
      },
    })
    expect(result.articles[0].byline).toBe('本报记者沈雷')
    expect(result.articles[0].body).toBe('自2024年起正文')
    expect(result.articles[0].body).not.toContain('本报记者')
  })

  it('reports unassigned lines and continuation', () => {
    const result = assembleArticles({
      page, lines: [...lines, line('l7', '（下转第2版）', 50, 1000, 200)],
      candidates: [candidate('c1', ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'], 'headline')],
      vision: { ...vision, articles: [{ ...vision.articles[0], regionIds: ['c1'] }], regions: [vision.regions[0]] },
    })
    expect(result.articles[0].continuation?.direction).toBe('down')
    expect(result.warnings.some(w => w.includes('未归类') || w.includes('续文'))).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */
/* Extra coverage for the assembly rules in the task brief.                    */
/* ------------------------------------------------------------------------- */

interface RegionOptions {
  kind?: VisionRegion['kind']
  confidence?: number
}

const region = (
  candidateId: string,
  articleGroup: string,
  readingOrder: number,
  options: RegionOptions = {},
): VisionRegion => ({
  candidateId,
  kind: options.kind ?? 'article',
  articleGroup,
  readingOrder,
  confidence: options.confidence ?? 0.9,
})

interface ArticleOptions {
  titleCandidateId?: string
  role?: VisionArticle['role']
  order?: number
  continuation?: VisionArticle['continuation']
  confidence?: number
}

const article = (id: string, regionIds: string[], options: ArticleOptions = {}): VisionArticle => ({
  id,
  titleCandidateId: options.titleCandidateId ?? regionIds[0] ?? 'c1',
  role: options.role ?? 'normal',
  order: options.order ?? 1,
  regionIds,
  continuation: options.continuation ?? 'none',
  confidence: options.confidence ?? 0.9,
})

const makeVision = (
  regions: VisionRegion[],
  articles: VisionArticle[],
  warnings: string[] = [],
): VisionLayout => ({ pageType: 'news', regions, articles, warnings })

const input = (
  lines: TextLine[],
  candidates: CandidateBlock[],
  visionLayout: VisionLayout,
): AssembleInput => ({ page, lines, candidates, vision: visionLayout })

describe('assembleArticles rules', () => {
  it('maps vision regions to r1… ids in reading order with articleId and fallback source', () => {
    const result = assembleArticles(input(
      [line('l1', '版面标题', 10, 100, 200, 24), line('l2', '另一栏目正文', 600, 100, 200)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'])],
      makeVision(
        // Deliberately out of order: readingOrder decides the rN ids.
        [region('c2', 'a1', 2, { kind: 'article', confidence: 0.3 }), region('c1', 'a1', 1, { kind: 'lead' })],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1', role: 'lead' })],
      ),
    ))
    expect(result.regions.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(result.regions.map(r => [r.order, r.page])).toEqual([[0, 1], [1, 1]])
    expect(result.regions[0]).toMatchObject({
      kind: 'lead', source: 'vision', articleId: 'a1', lineIds: ['l1'],
      bbox: { x: 10, y: 100, w: 200, h: 24 },
    })
    expect(result.regions[1]).toMatchObject({
      kind: 'article', source: 'fallback', articleId: 'a1', lineIds: ['l2'],
    })
    expect(result.articles[0].regionIds).toEqual(['r1', 'r2'])
    expect(result.articles[0].title).toBe('版面标题')
    expect(result.articles[0].role).toBe('lead')
    expect(result.articles[0].confidence).toBe(0.9)
  })

  it('unions regionIds with every region whose articleGroup matches', () => {
    const result = assembleArticles(input(
      [line('l1', '标题', 50, 100, 200, 24), line('l2', '补充分区正文', 600, 100, 200)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'])],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a1', 2)], [article('a1', ['c1'])]),
    ))
    expect(result.articles[0].regionIds).toEqual(['r1', 'r2'])
    expect(result.articles[0].body).toContain('补充分区正文')
    expect(result.regions[1].articleId).toBe('a1')
    expect(result.warnings.some(w => w.includes('不一致'))).toBe(false)
    expect(result.stats.overlap).toBe(0)
  })

  it('treats articleGroup as authoritative over a conflicting article.regionIds entry', () => {
    const result = assembleArticles(input(
      [line('l1', '甲区正文', 50, 100, 200, 24), line('l2', '乙区正文', 600, 100, 200)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'])],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a2', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' }), article('a2', [], { titleCandidateId: 'c2', order: 2 })],
      ),
    ))
    const first = result.articles.find(a => a.id === 'a1')
    const second = result.articles.find(a => a.id === 'a2')
    expect(first?.regionIds).toEqual(['r1'])
    expect(second?.regionIds).toEqual(['r2'])
    expect(result.regions[1].articleId).toBe('a2')
    expect(result.warnings.some(w => w.includes('不一致') && w.includes('以 articleGroup 为准'))).toBe(true)
    // r2 was claimed by both articles before authority resolution: overlap flags it.
    expect(result.stats.overlap).toBeGreaterThan(0)
  })

  it('warns when a region is claimed by more than one article and picks a deterministic owner', () => {
    const result = assembleArticles(input(
      [line('l1', '甲区正文', 50, 100, 200, 24), line('l2', '乙区正文', 600, 100, 200)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'])],
      makeVision(
        [region('c1', '', 1, { kind: 'lead' }), region('c2', '', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' }), article('a2', ['c2'], { titleCandidateId: 'c2', order: 2 })],
      ),
    ))
    expect(result.regions[1].articleId).toBe('a1') // smaller article order wins
    expect(result.articles.find(a => a.id === 'a1')?.regionIds).toEqual(['r1', 'r2'])
    expect(result.articles.find(a => a.id === 'a2')?.regionIds).toEqual([])
    expect(result.warnings.some(w => w.includes('c2') && w.includes('多篇'))).toBe(true)
  })

  it('leaves regions with an empty articleGroup unassigned when no article claims them', () => {
    const result = assembleArticles(input(
      [line('l1', '甲区正文', 50, 100, 200, 24), line('l2', '乙区正文', 600, 100, 200)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'])],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', '', 2, { kind: 'other' })],
        [article('a1', ['c1'], { titleCandidateId: 'c1' })],
      ),
    ))
    expect(result.regions[1].articleId).toBeUndefined()
    expect(result.articles[0].regionIds).toEqual(['r1'])
    expect(result.articles[0].body).not.toContain('乙区正文')
    // The line is assigned to a region, so it still counts as covered text.
    expect(result.stats.coverage).toBe(1)
    expect(result.stats.unassignedLineIds).toEqual([])
    expect(result.regions.flatMap(r => r.lineIds)).toEqual(['l1', 'l2'])
  })

  it('collects unassigned lines and warns when coverage is below 80%', () => {
    const result = assembleArticles(input(
      [
        line('l1', '标题', 50, 100, 200, 24),
        line('l2', '正文', 50, 130, 200),
        line('l3', '未归类行', 600, 900, 200),
      ],
      [candidate('c1', ['l1', 'l2'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(result.stats.unassignedLineIds).toEqual(['l3'])
    expect(result.stats.coverage).toBeCloseTo(0.5, 10)
    expect(result.warnings.some(w => w.includes('未归类'))).toBe(true)
    expect(result.warnings.some(w => w.includes('覆盖率'))).toBe(true)
    expect(result.regions.flatMap(r => r.lineIds)).toEqual(['l1', 'l2'])
    expect(result.articles[0].title).toBe('标题')
    expect(result.articles[0].body).toBe('正文')
  })

  it('assigns a line to the smallest region containing its center', () => {
    const result = assembleArticles(input(
      [
        line('l1', '标题行', 0, 0, 400, 24),
        line('l2', '甲正文', 0, 200, 400),
        line('l3', '乙正文', 50, 100, 40),
      ],
      [candidate('c1', ['l1', 'l2'], 'headline'), candidate('c2', ['l3'])],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' })],
      ),
    ))
    // l3's center is inside the large union box of c1 too, but c2 is smaller.
    expect(result.regions[0].lineIds).toEqual(['l1', 'l2'])
    expect(result.regions[1].lineIds).toEqual(['l3'])
    expect(result.articles[0].title).toBe('标题行')
    expect(result.articles[0].body).toBe('乙正文甲正文')
  })

  it('sorts article lines by column, then top-down y, then x, ignoring input order', () => {
    const result = assembleArticles(input(
      [
        line('l3', '右一', 600, 100, 200),
        line('l1', '左标题', 50, 100, 200, 24),
        line('l4', '右二', 600, 115, 200),
        line('l2', '左二', 50, 115, 200),
      ],
      [candidate('c1', ['l1', 'l2'], 'headline'), candidate('c2', ['l3', 'l4'])],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' })],
      ),
    ))
    expect(result.articles[0].title).toBe('左标题')
    expect(result.articles[0].body).toBe('左二右一右二')
  })

  it('merges line text without newlines: CJK joins directly, Latin tokens keep one space', () => {
    const result = assembleArticles(input(
      [
        line('l1', 'Headline  ', 50, 100, 300, 20),
        line('l2', 'Hello', 50, 200, 100),
        line('l3', 'World', 50, 215, 100),
        line('l4', '中文行   ', 50, 230, 100),
        line('l5', '尾行\n续行', 50, 245, 100),
      ],
      [candidate('c1', ['l1', 'l2', 'l3', 'l4', 'l5'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(result.articles[0].title).toBe('Headline')
    expect(result.articles[0].body).toBe('Hello World中文行尾行续行')
    expect(result.articles[0].body).not.toContain('\n')
  })

  it('detects 上接 continuation as up and warns instead of merging pages', () => {
    const build = (hint: string) => assembleArticles(input(
      [line('l1', '标题', 50, 100, 200, 24), line('l2', '正文内容', 50, 140, 200), line('l3', hint, 50, 170, 200)],
      [candidate('c1', ['l1', 'l2', 'l3'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    const up = build('（上接第1版）')
    expect(up.articles[0].continuation?.direction).toBe('up')
    expect(up.articles[0].warnings.some(w => w.includes('续文'))).toBe(true)
    expect(up.warnings.some(w => w.includes('续文'))).toBe(true)
    // The regex must also accept Chinese numerals and a missing 第.
    expect(build('（下转二版）').articles[0].continuation?.direction).toBe('down')
  })

  it('keeps a continuation hint supplied by the vision layout', () => {
    const result = assembleArticles(input(
      [line('l1', '标题', 50, 100, 200, 24), line('l2', '正文内容', 50, 140, 200)],
      [candidate('c1', ['l1', 'l2'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'], { continuation: 'down' })]),
    ))
    expect(result.articles[0].continuation?.direction).toBe('down')
    expect(result.warnings.some(w => w.includes('续文'))).toBe(true)
  })

  it('takes the title from the titleCandidateId region and falls back to the first region', () => {
    const lines = [line('l1', '小标题', 50, 100, 200, 18), line('l2', '另一区大字', 600, 100, 200, 24)]
    const candidates = [candidate('c1', ['l1']), candidate('c2', ['l2'])]
    const preferred = assembleArticles(input(
      lines, candidates,
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' })],
      ),
    ))
    expect(preferred.articles[0].title).toBe('小标题')

    const fallback = assembleArticles(input(
      lines, candidates,
      makeVision(
        [region('c1', '', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [article('a1', ['c2'], { titleCandidateId: 'c1' })],
      ),
    ))
    expect(fallback.articles[0].regionIds).toEqual(['r2'])
    expect(fallback.articles[0].title).toBe('另一区大字')
  })

  it('extracts a larger-font subtitle but never invents one from body-size lines', () => {
    const withSubtitle = assembleArticles(input(
      [
        line('l1', '主标题', 50, 100, 300, 30),
        line('l2', '副标题', 50, 140, 200, 18),
        line('l3', '正文一', 50, 170, 200),
        line('l4', '正文二', 50, 185, 200),
      ],
      [candidate('c1', ['l1', 'l2', 'l3', 'l4'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(withSubtitle.articles[0].title).toBe('主标题')
    expect(withSubtitle.articles[0].subtitle).toBe('副标题')
    expect(withSubtitle.articles[0].body).toBe('正文一正文二')

    const withoutSubtitle = assembleArticles(input(
      [line('l1', '主标题', 50, 100, 300, 30), line('l2', '第一行', 50, 140, 200), line('l3', '第二行', 50, 155, 200)],
      [candidate('c1', ['l1', 'l2', 'l3'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(withoutSubtitle.articles[0].subtitle).toBeUndefined()
    expect(withoutSubtitle.articles[0].body).toBe('第一行第二行')
  })

  it('detects every byline prefix from the brief and ignores mid-sentence mentions', () => {
    const bylines = ['本报讯 记者 张三', '本报记者 李四', '记者 王五', '通讯员 赵六', '新华社北京11月18日电']
    for (const byline of bylines) {
      const result = assembleArticles(input(
        [line('l1', '标题', 50, 100, 200, 24), line('l2', byline, 50, 140, 300), line('l3', '正文行', 50, 170, 200)],
        [candidate('c1', ['l1', 'l2', 'l3'], 'headline')],
        makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
      ))
      expect(result.articles[0].byline).toBe(cleanTextSpacing(byline))
      expect(result.articles[0].body).toBe('正文行')
    }

    const midSentence = assembleArticles(input(
      [line('l1', '标题', 50, 100, 200, 24), line('l2', '他说，记者昨日获悉此事', 50, 140, 300)],
      [candidate('c1', ['l1', 'l2'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(midSentence.articles[0].byline).toBeUndefined()
    expect(midSentence.articles[0].body).toContain('记者昨日')
  })

  it('warns about a body shorter than 40 characters, and not at exactly 40', () => {
    const build = (bodyText: string) => assembleArticles(input(
      [line('l1', '标题', 50, 100, 200, 24), line('l2', bodyText, 50, 140, 400)],
      [candidate('c1', ['l1', 'l2'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    const short = build('正'.repeat(39))
    const exact = build('正'.repeat(40))
    expect(short.articles[0].body.length).toBe(39)
    expect(short.articles[0].warnings.some(w => w.includes('正文'))).toBe(true)
    expect(short.warnings.some(w => w.includes('正文'))).toBe(true)
    expect(exact.articles[0].warnings.some(w => w.includes('正文'))).toBe(false)
    expect(exact.warnings.some(w => w.includes('正文'))).toBe(false)
  })

  it('excludes masthead/header/footer/ad text from the coverage denominator', () => {
    const result = assembleArticles(input(
      [
        line('l1', '头'.repeat(100), 10, 10, 980, 20),
        line('l2', '标题', 10, 500, 200, 24),
        line('l3', '文'.repeat(10), 10, 530, 400),
        line('l4', '未'.repeat(10), 600, 900, 200),
      ],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3'], 'headline')],
      makeVision(
        [region('c1', '', 1, { kind: 'masthead' }), region('c2', 'a1', 2, { kind: 'lead' })],
        [article('a1', ['c2'], { titleCandidateId: 'c2' })],
      ),
    ))
    expect(result.stats.coverage).toBeCloseTo(12 / 22, 10)
    expect(result.regions[0].articleId).toBeUndefined()
    expect(result.articles[0].body).toBe('文'.repeat(10))
    expect(result.warnings.some(w => w.includes('未归类'))).toBe(true)
  })

  it('orders the output articles by their vision order and numbers readingOrder from 1', () => {
    const result = assembleArticles(input(
      [line('l1', '甲文标题', 50, 100, 200, 24), line('l2', '乙文标题', 600, 100, 200, 24)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'], 'headline')],
      makeVision(
        [region('c1', 'a2', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [
          article('a2', ['c1'], { titleCandidateId: 'c1', order: 1 }),
          article('a1', ['c2'], { titleCandidateId: 'c2', order: 2 }),
        ],
      ),
    ))
    expect(result.articles.map(a => [a.id, a.readingOrder])).toEqual([['a2', 1], ['a1', 2]])
    expect(result.articles.map(a => a.title)).toEqual(['甲文标题', '乙文标题'])
    expect(result.articles[0].regionIds).toEqual(['r1'])
    expect(result.articles[1].regionIds).toEqual(['r2'])
  })

  it('reports every line as unassigned when the vision layout is empty', () => {
    const result = assembleArticles(input(
      [line('l1', '一行文字', 50, 100, 200)],
      [candidate('c1', ['l1'])],
      makeVision([], []),
    ))
    expect(result.regions).toEqual([])
    expect(result.articles).toEqual([])
    expect(result.stats.unassignedLineIds).toEqual(['l1'])
    expect(result.stats.coverage).toBe(0)
    expect(result.warnings.some(w => w.includes('未归类'))).toBe(true)
    expect(result.warnings.some(w => w.includes('覆盖率'))).toBe(true)
  })

  it('returns an empty result for an empty page', () => {
    const result = assembleArticles(input([], [], makeVision([], [])))
    expect(result).toEqual({
      regions: [],
      articles: [],
      warnings: [],
      stats: { coverage: 1, overlap: 0, unassignedLineIds: [] },
    })
  })

  it('keeps an article that matched no text, warning about the empty body', () => {
    const result = assembleArticles(input(
      [],
      [candidate('c1', [], 'body')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(result.regions[0].lineIds).toEqual([])
    expect(result.regions[0].bbox).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(result.articles[0].title).toBe('')
    expect(result.articles[0].body).toBe('')
    expect(result.articles[0].regionIds).toEqual(['r1'])
    expect(result.warnings.some(w => w.includes('正文'))).toBe(true)
    expect(result.stats.coverage).toBe(1)
  })

  it('clamps the reported region box to the page', () => {
    const result = assembleArticles(input(
      [line('l1', '标题', 50, 100, 200, 24), line('l2', '溢出页面的一行', 900, 100, 200)],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2'])],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' })],
      ),
    ))
    expect(result.regions[1].bbox).toEqual({ x: 900, y: 100, w: 100, h: 12 })
    // The line still belongs to the (unclamped) assignment box.
    expect(result.regions[1].lineIds).toEqual(['l2'])
  })

  it('is deterministic and does not mutate its inputs', () => {
    const inputLines = lines
    const inputCandidates = [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4', 'l5', 'l6'])]
    const before = JSON.parse(JSON.stringify({ lines: inputLines, candidates: inputCandidates, vision }))
    const first = assembleArticles({ page, lines: inputLines, candidates: inputCandidates, vision })
    const second = assembleArticles({ page, lines: inputLines, candidates: inputCandidates, vision })
    expect(first).toEqual(second)
    expect(JSON.parse(JSON.stringify({ lines: inputLines, candidates: inputCandidates, vision }))).toEqual(before)
    expect(first.articles[0].id).toBe('a1')
    expect(first.regions.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(first.regions.every(r => r.page === 1)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */
/* Spec-gap fix round: binding spec §6.3 behaviors the brief left open.        */
/* ------------------------------------------------------------------------- */

describe('assembleArticles spec-gap rules', () => {
  it('joins the 1-3 contiguous largest-font lines at the title top', () => {
    const result = assembleArticles(input(
      [
        line('l1', '城市更新', 50, 100, 300, 24),
        line('l2', '按下加速键', 50, 126, 300, 22),
        line('l3', '城市更美好', 50, 150, 300, 21),
        line('l4', '正文第一行', 50, 200, 400),
        line('l5', '正文第二行', 50, 215, 400),
        line('l6', '正文第三行', 50, 230, 400),
      ],
      [candidate('c1', ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(result.articles[0].title).toBe('城市更新按下加速键城市更美好')
    expect(result.articles[0].body).toBe('正文第一行正文第二行正文第三行')
    expect(result.articles[0].body).not.toContain('城市更新')
    expect(result.articles[0].body).not.toContain('按下加速键')
  })

  it('uses the next larger-font line under the title as the subtitle', () => {
    const result = assembleArticles(input(
      [
        line('l1', '主标题', 50, 100, 300, 30),
        line('l2', '副标题', 50, 150, 300, 16),
        line('l3', '正文一', 50, 180, 400),
        line('l4', '正文二', 50, 195, 400),
        line('l5', '正文三', 50, 210, 400),
      ],
      [candidate('c1', ['l1', 'l2', 'l3', 'l4', 'l5'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(result.articles[0].title).toBe('主标题')
    expect(result.articles[0].subtitle).toBe('副标题')
    expect(result.articles[0].body).toBe('正文一正文二正文三')
  })

  it('keeps a near-body-size line in the body instead of making it a subtitle', () => {
    const result = assembleArticles(input(
      [
        line('l1', '主标题', 50, 100, 300, 30),
        line('l2', '近正文行', 50, 150, 300, 12.5),
        line('l3', '正文一', 50, 180, 400),
        line('l4', '正文二', 50, 195, 400),
        line('l5', '正文三', 50, 210, 400),
      ],
      [candidate('c1', ['l1', 'l2', 'l3', 'l4', 'l5'], 'headline')],
      makeVision([region('c1', 'a1', 1, { kind: 'lead' })], [article('a1', ['c1'])]),
    ))
    expect(result.articles[0].subtitle).toBeUndefined()
    expect(result.articles[0].body).toBe('近正文行正文一正文二正文三')
  })

  it('assigns a line straddling two regions to the largest overlap and warns', () => {
    const result = assembleArticles(input(
      [
        line('l1', '左区第一行', 0, 100, 70, 20),
        line('l2', '左区第二行', 0, 180, 70, 20),
        line('l3', '右区第一行', 70, 100, 100, 20),
        line('l4', '右区第二行', 70, 180, 100, 20),
        line('ls', '跨区域行', 0, 150, 100, 12),
      ],
      [candidate('c1', ['l1', 'l2'], 'headline'), candidate('c2', ['l3', 'l4'], 'headline')],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a2', 2)],
        [
          article('a1', ['c1'], { titleCandidateId: 'c1' }),
          article('a2', ['c2'], { titleCandidateId: 'c2', order: 2 }),
        ],
      ),
    ))
    expect(result.regions[0].lineIds).toContain('ls') // 70% overlap with the left region
    expect(result.articles.find(a => a.id === 'a1')?.body).toContain('跨区域行')
    expect(result.articles.find(a => a.id === 'a2')?.body).not.toContain('跨区域行')
    expect(result.warnings.some(w => w.includes('跨区域行按多数归属'))).toBe(true)
  })

  it('warns when the title font is not clearly larger than the body median', () => {
    const result = assembleArticles(input(
      [
        line('l1', '标题', 50, 100, 200, 13),
        line('l2', '正文一', 50, 140, 400),
        line('l3', '正文二', 50, 155, 400),
        line('l4', '正文三', 50, 170, 400),
      ],
      [candidate('c1', ['l1'], 'headline'), candidate('c2', ['l2', 'l3', 'l4'])],
      makeVision(
        [region('c1', 'a1', 1, { kind: 'lead' }), region('c2', 'a1', 2)],
        [article('a1', ['c1', 'c2'], { titleCandidateId: 'c1' })],
      ),
    ))
    expect(result.articles[0].title).toBe('标题')
    expect(result.articles[0].warnings.some(w => w.includes('标题字号与正文接近'))).toBe(true)
    expect(result.warnings.some(w => w.includes('标题字号与正文接近'))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { ExtractJsonError, extractJsonObject } from '../../src/shared/json/extract'
import {
  fallbackVisionLayout,
  parseVisionLayout,
  VisionLayoutError,
} from '../../src/shared/layout/vision-schema'
import type { CandidateBlock } from '../../src/shared/types'

const candidates = [
  {
    candidateId: 'c1',
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    lineIds: ['l1'],
    fontSizeBand: 'headline' as const,
    firstLineText: '标题',
    lineCount: 1,
  },
]

const twoCandidates: CandidateBlock[] = [
  ...candidates,
  {
    candidateId: 'c2',
    bbox: { x: 0, y: 2, w: 1, h: 1 },
    lineIds: ['l2'],
    fontSizeBand: 'body',
    firstLineText: '正文',
    lineCount: 1,
  },
]

/** A model payload that satisfies every rule; each test overrides one field. */
function layoutJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pageType: 'news',
    regions: [{ candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 0.9 }],
    articles: [
      {
        id: 'a1',
        titleCandidateId: 'c1',
        role: 'lead',
        order: 1,
        regionIds: ['c1'],
        continuation: 'none',
        confidence: 0.9,
      },
    ],
    warnings: [],
    ...overrides,
  })
}

/** Run the parser and return the typed validation error it threw. */
function parseError(
  raw: string,
  candidateList: readonly CandidateBlock[] = candidates,
): VisionLayoutError {
  try {
    parseVisionLayout(raw, candidateList)
  } catch (error) {
    if (error instanceof VisionLayoutError) return error
    throw error
  }
  throw new Error('expected parseVisionLayout to throw')
}

/** Run the extractor and return the typed error it threw. */
function extractError(raw: string): ExtractJsonError {
  try {
    extractJsonObject(raw)
  } catch (error) {
    if (error instanceof ExtractJsonError) return error
    throw error
  }
  throw new Error('expected extractJsonObject to throw')
}

describe('parseVisionLayout', () => {
  it('parses fenced JSON', () => {
    const layout = parseVisionLayout('```json\n{"pageType":"news","regions":[{"candidateId":"c1","kind":"lead","articleGroup":"a1","readingOrder":1,"confidence":0.9}],"articles":[{"id":"a1","titleCandidateId":"c1","role":"lead","order":1,"regionIds":["c1"],"continuation":"none","confidence":0.9}],"warnings":[]}\n```', candidates)
    expect(layout.articles[0].id).toBe('a1')
  })
  it('rejects unknown candidate ids', () => {
    expect(() => parseVisionLayout(JSON.stringify({ pageType: 'news', regions: [{ candidateId: 'c9', kind: 'article', articleGroup: 'a1', readingOrder: 1, confidence: 1 }], articles: [], warnings: [] }), candidates))
      .toThrow(VisionLayoutError)
  })
  it('falls back to one article per candidate', () => {
    const layout = fallbackVisionLayout(candidates)
    expect(layout.articles).toHaveLength(1)
    expect(layout.regions[0].confidence).toBeLessThan(0.5)
  })

  it('parses JSON surrounded by prose even without fences', () => {
    const layout = parseVisionLayout(`版面识别结果如下：\n${layoutJson()}\n请查收。`, candidates)
    expect(layout.articles[0].id).toBe('a1')
  })

  it('rejects unusable model output with INVALID_JSON', () => {
    expect(parseError('抱歉，我无法完成这个任务。').code).toBe('INVALID_JSON')
  })

  it('rejects a non-object JSON root with INVALID_SHAPE', () => {
    expect(parseError('[]').code).toBe('INVALID_SHAPE')
  })

  it('requires pageType to be a string', () => {
    expect(parseError(layoutJson({ pageType: 7 })).code).toBe('INVALID_SHAPE')
    expect(parseVisionLayout(layoutJson({ pageType: 'front page' }), candidates).pageType).toBe(
      'front page',
    )
  })

  it('rejects an unknown region kind and a non-numeric readingOrder', () => {
    expect(
      parseError(
        layoutJson({
          regions: [
            { candidateId: 'c1', kind: 'banner', articleGroup: 'a1', readingOrder: 1, confidence: 0.9 },
          ],
        }),
      ).code,
    ).toBe('INVALID_SHAPE')
    expect(
      parseError(
        layoutJson({
          regions: [
            { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: '1', confidence: 0.9 },
          ],
        }),
      ).code,
    ).toBe('INVALID_SHAPE')
  })

  it('accepts confidence boundaries and rejects values outside 0..1', () => {
    const lowest = parseVisionLayout(
      layoutJson({
        regions: [
          { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 0 },
        ],
      }),
      candidates,
    )
    expect(lowest.regions[0].confidence).toBe(0)
    expect(
      parseError(
        layoutJson({
          regions: [
            { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 1.01 },
          ],
        }),
      ).code,
    ).toBe('INVALID_SHAPE')
  })

  it('rejects duplicate region candidate ids with DUPLICATE_CANDIDATE', () => {
    expect(
      parseError(
        layoutJson({
          regions: [
            { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 0.9 },
            { candidateId: 'c1', kind: 'article', articleGroup: 'a1', readingOrder: 2, confidence: 0.9 },
          ],
        }),
      ).code,
    ).toBe('DUPLICATE_CANDIDATE')
  })

  it('rejects article regionIds that are unknown candidates', () => {
    expect(
      parseError(
        layoutJson({
          articles: [
            { id: 'a1', titleCandidateId: 'c1', role: 'lead', order: 1, regionIds: ['c9'], continuation: 'none', confidence: 0.9 },
          ],
        }),
      ).code,
    ).toBe('UNKNOWN_CANDIDATE')
  })

  it('rejects article regionIds for known candidates that have no vision region', () => {
    expect(
      parseError(
        layoutJson({
          articles: [
            { id: 'a1', titleCandidateId: 'c1', role: 'lead', order: 1, regionIds: ['c2'], continuation: 'none', confidence: 0.9 },
          ],
        }),
        twoCandidates,
      ).code,
    ).toBe('INVALID_SHAPE')
  })

  it('rejects an unknown titleCandidateId', () => {
    expect(
      parseError(
        layoutJson({
          articles: [
            { id: 'a1', titleCandidateId: 'c9', role: 'lead', order: 1, regionIds: ['c1'], continuation: 'none', confidence: 0.9 },
          ],
        }),
      ).code,
    ).toBe('UNKNOWN_CANDIDATE')
  })

  it('rejects duplicate article ids and invalid article enums', () => {
    const article = {
      id: 'a1',
      titleCandidateId: 'c1',
      role: 'lead',
      order: 1,
      regionIds: ['c1'],
      continuation: 'none',
      confidence: 0.9,
    }
    expect(parseError(layoutJson({ articles: [article, { ...article, regionIds: [] }] })).code).toBe(
      'INVALID_SHAPE',
    )
    expect(parseError(layoutJson({ articles: [{ ...article, role: 'headline' }] })).code).toBe(
      'INVALID_SHAPE',
    )
    expect(parseError(layoutJson({ articles: [{ ...article, continuation: 'left' }] })).code).toBe(
      'INVALID_SHAPE',
    )
  })

  it('rejects a region id repeated inside one article', () => {
    expect(
      parseError(
        layoutJson({
          articles: [
            { id: 'a1', titleCandidateId: 'c1', role: 'lead', order: 1, regionIds: ['c1', 'c1'], continuation: 'none', confidence: 0.9 },
          ],
        }),
      ).code,
    ).toBe('INVALID_SHAPE')
  })

  it('reports MISSING_ARTICLE for an articleGroup without an article', () => {
    expect(parseError(layoutJson({ articles: [] })).code).toBe('MISSING_ARTICLE')
  })

  it('requires pageType, regions, articles and a string warnings array', () => {
    expect(parseError(JSON.stringify({ regions: [], articles: [] })).code).toBe('INVALID_SHAPE')
    expect(parseError(JSON.stringify({ pageType: 'news', articles: [], warnings: [] })).code).toBe(
      'INVALID_SHAPE',
    )
    expect(parseError(JSON.stringify({ pageType: 'news', regions: [], warnings: [] })).code).toBe(
      'INVALID_SHAPE',
    )
    expect(
      parseError(JSON.stringify({ pageType: 'news', regions: [], articles: [], warnings: [1] })).code,
    ).toBe('INVALID_SHAPE')
    expect(
      parseVisionLayout(JSON.stringify({ pageType: 'news', regions: [], articles: [] }), candidates)
        .warnings,
    ).toEqual([])
  })

  it('accepts regions outside any article and strips unknown fields', () => {
    const layout = parseVisionLayout(
      JSON.stringify({
        pageType: 'news',
        regions: [
          { candidateId: 'c1', kind: 'masthead', articleGroup: null, readingOrder: 1, confidence: 0.8, bbox: { x: 0 } },
        ],
        articles: [],
        warnings: ['报头置信度低'],
        extra: 'ignored',
      }),
      candidates,
    )
    expect(layout).toEqual({
      pageType: 'news',
      regions: [
        { candidateId: 'c1', kind: 'masthead', articleGroup: '', readingOrder: 1, confidence: 0.8 },
      ],
      articles: [],
      warnings: ['报头置信度低'],
    })
  })
})

describe('fallbackVisionLayout', () => {
  it('creates one low-confidence article region per candidate', () => {
    const layout = fallbackVisionLayout(twoCandidates)
    expect(layout.pageType).toBe('unknown')
    expect(layout.regions.map((region) => region.candidateId)).toEqual(['c1', 'c2'])
    expect(layout.regions.map((region) => region.articleGroup)).toEqual(['a1', 'a2'])
    expect(layout.regions.map((region) => region.readingOrder)).toEqual([1, 2])
    expect(layout.regions.every((region) => region.kind === 'article')).toBe(true)
    expect(layout.regions.every((region) => region.confidence === 0.3)).toBe(true)
    expect(layout.articles.map((article) => article.id)).toEqual(['a1', 'a2'])
    expect(layout.articles.map((article) => article.titleCandidateId)).toEqual(['c1', 'c2'])
    expect(layout.articles.map((article) => article.regionIds)).toEqual([['c1'], ['c2']])
    expect(layout.articles.every((article) => article.role === 'normal')).toBe(true)
    expect(layout.articles.every((article) => article.continuation === 'none')).toBe(true)
    expect(layout.articles.every((article) => article.confidence === 0.3)).toBe(true)
    expect(layout.warnings).toEqual(['vision-fallback'])
  })

  it('returns an empty layout when there are no candidates', () => {
    const layout = fallbackVisionLayout([])
    expect(layout.regions).toEqual([])
    expect(layout.articles).toEqual([])
    expect(layout.warnings).toEqual(['vision-fallback'])
  })

  it('produces a layout that the parser accepts', () => {
    const layout = fallbackVisionLayout(twoCandidates)
    expect(() => parseVisionLayout(JSON.stringify(layout), twoCandidates)).not.toThrow()
  })
})

describe('extractJsonObject', () => {
  it('extracts fenced JSON that follows prose', () => {
    expect(extractJsonObject('说明\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('extracts the first JSON array and nested braces', () => {
    expect(extractJsonObject('```\n[1,{"a":{"b":2}}]\n```')).toEqual([1, { a: { b: 2 } }])
  })

  it('strips CRLF fences without a language tag', () => {
    expect(extractJsonObject('```\r\n{"a":1}\r\n```\r\n')).toEqual({ a: 1 })
  })

  it('handles a truncated response that is missing the closing fence', () => {
    expect(extractJsonObject('```json\n{"a":1}')).toEqual({ a: 1 })
  })

  it('handles trailing prose after the closing fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```\n希望对你有帮助。')).toEqual({ a: 1 })
  })

  it('throws ExtractJsonError when there is no JSON object', () => {
    expect(extractError('没有 JSON，只有普通文字').code).toBe('INVALID_JSON')
  })

  it('throws ExtractJsonError on malformed JSON', () => {
    expect(extractError('{"a":}').code).toBe('INVALID_JSON')
  })

  it('throws ExtractJsonError on empty text', () => {
    expect(extractError('   ').code).toBe('INVALID_JSON')
  })

  it('throws ExtractJsonError for a JSON primitive', () => {
    expect(extractError('42').code).toBe('INVALID_JSON')
  })
})

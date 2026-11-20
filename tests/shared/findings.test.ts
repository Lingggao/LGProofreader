import { describe, expect, it } from 'vitest'
import {
  FindingsError,
  UNLOCATABLE_QUOTE_REASON,
  locateQuote,
  normalizeForMatch,
  parseFindings,
} from '../../src/shared/proof/findings'

const article = '他说：“你好。”随后离开。'

/** A model finding that satisfies every rule; each test overrides one field. */
function findingJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'typo',
    severity: 'must_fix',
    quote: '你好',
    occurrence: 1,
    issue: '错别字',
    suggestion: '您好',
    confidence: 'high',
    needs_human: false,
    ...overrides,
  }
}

/** Wrap findings into the `{ findings, notes }` reply contract. */
function payload(findings: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ findings, ...extra })
}

/** Run the parser and return the typed validation error it threw. */
function parseError(raw: string, text: string = article): FindingsError {
  try {
    parseFindings(raw, text)
  } catch (error) {
    if (error instanceof FindingsError) return error
    throw error
  }
  throw new Error('expected parseFindings to throw')
}

describe('parseFindings', () => {
  it('matches a quote whose full-width punctuation differs', () => {
    const raw = JSON.stringify({ findings: [{ category: 'punctuation', severity: 'must_fix', quote: '他说:"你好。"', occurrence: 1, issue: '引号不配对', suggestion: '他说：“你好。”', confidence: 'high', needs_human: false }] })
    const findings = parseFindings(raw, article)
    expect(findings).toHaveLength(1)
    expect(findings[0].needsHuman).toBe(false)
    // The stored quote is the real article snippet, not the model's ASCII spelling.
    expect(findings[0].quote).toBe('他说：“你好。”')
  })

  it('marks an unfindable quote as needsHuman instead of dropping it', () => {
    const raw = JSON.stringify({ findings: [{ category: 'typo', severity: 'must_fix', quote: '不存在的句子', issue: 'x', suggestion: 'y', confidence: 'low', needs_human: false }] })
    const findings = parseFindings(raw, article)
    expect(findings[0].needsHuman).toBe(true)
    expect(findings[0].reason).toContain('引用无法定位')
  })

  it('rejects invalid severity', () => {
    const raw = JSON.stringify({ findings: [{ category: 'typo', severity: 'fatal', quote: '你好', issue: 'x', suggestion: 'y', confidence: 'low', needs_human: false }] })
    expect(() => parseFindings(raw, article)).toThrow()
    expect(parseError(raw).code).toBe('INVALID_SHAPE')
  })

  it('reuses the shared extractor for fenced JSON wrapped in prose', () => {
    const raw = `校对结果如下：\n\`\`\`json\n${payload([findingJson()])}\n\`\`\`\n希望对你有帮助。`
    const findings = parseFindings(raw, article)
    expect(findings).toHaveLength(1)
    expect(findings[0].id).toBe('f1')
  })

  it('returns an empty list for an empty findings array', () => {
    expect(parseFindings(payload([]), article)).toEqual([])
  })

  it('produces the exact documented finding shape with deterministic ids', () => {
    const findings = parseFindings(payload([findingJson()]), article)
    expect(findings).toEqual([
      {
        id: 'f1',
        articleId: '',
        category: 'typo',
        severity: 'must_fix',
        quote: '你好',
        occurrence: 1,
        issue: '错别字',
        suggestion: '您好',
        confidence: 'high',
        needsHuman: false,
        roles: [],
        status: 'open',
      },
    ])
  })

  it('numbers ids f1... in reply order, independent of quotes', () => {
    const raw = payload([
      findingJson({ quote: '随后离开', suggestion: '随后离去' }),
      findingJson({ category: 'punctuation', quote: '你好', needs_human: true }),
    ])
    const findings = parseFindings(raw, article)
    expect(findings.map((finding) => finding.id)).toEqual(['f1', 'f2'])
    expect(parseFindings(raw, article)).toEqual(findings)
  })

  it('keeps a model-provided occurrence, needs_human flag and reason', () => {
    const [finding] = parseFindings(
      payload([findingJson({ occurrence: 2, needs_human: true, reason: '需人工确认' })]),
      article,
    )
    expect(finding.occurrence).toBe(2)
    expect(finding.needsHuman).toBe(true)
    expect(finding.reason).toBe('需人工确认')
  })

  it('locates a quote that only differs by whitespace and stores the article snippet', () => {
    const [finding] = parseFindings(payload([findingJson({ quote: '他说： “你好。”' })]), article)
    expect(finding.needsHuman).toBe(false)
    expect(finding.quote).toBe('他说：“你好。”')
  })

  it('restores the original snippet including whitespace inside the match', () => {
    const [finding] = parseFindings(
      payload([findingJson({ quote: '他说:"你好。"' })]),
      '他 说：“你好。”',
    )
    expect(finding.needsHuman).toBe(false)
    expect(finding.quote).toBe('他 说：“你好。”')
  })

  it('locates a quote that only differs by full-width letters and digits', () => {
    const fullWidthArticle = 'ＡＢＣ２０２６年，他说：“好的。”'
    const [finding] = parseFindings(
      payload([findingJson({ quote: 'ABC2026年' })]),
      fullWidthArticle,
    )
    expect(finding.needsHuman).toBe(false)
    expect(finding.quote).toBe('ＡＢＣ２０２６年')
  })

  it('keeps an exact quote unchanged', () => {
    const [finding] = parseFindings(payload([findingJson({ quote: '随后离开' })]), article)
    expect(finding.quote).toBe('随后离开')
    expect(finding.needsHuman).toBe(false)
  })

  it('overwrites the reason when the quote cannot be located', () => {
    const [finding] = parseFindings(
      payload([findingJson({ quote: '不存在的句子', needs_human: false, reason: '模型自己的理由' })]),
      article,
    )
    expect(finding.needsHuman).toBe(true)
    expect(finding.reason).toBe(UNLOCATABLE_QUOTE_REASON)
    expect(UNLOCATABLE_QUOTE_REASON).toBe('引用无法定位')
  })

  it('cannot locate any quote in an empty article', () => {
    const [finding] = parseFindings(payload([findingJson()]), '')
    expect(finding.needsHuman).toBe(true)
    expect(finding.reason).toBe(UNLOCATABLE_QUOTE_REASON)
  })

  it('rejects an invalid category', () => {
    expect(parseError(payload([findingJson({ category: 'spelling' })])).code).toBe('INVALID_SHAPE')
  })

  it('rejects an invalid confidence', () => {
    expect(parseError(payload([findingJson({ confidence: 'certain' })])).code).toBe('INVALID_SHAPE')
  })

  it('rejects a missing, empty or non-string quote', () => {
    const { quote: _quote, ...missing } = findingJson()
    expect(parseError(payload([missing])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ quote: '   ' })])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ quote: 42 })])).code).toBe('INVALID_SHAPE')
  })

  it('requires a string suggestion and accepts an empty one as a deletion', () => {
    const { suggestion: _suggestion, ...missing } = findingJson()
    expect(parseError(payload([missing])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ suggestion: 7 })])).code).toBe('INVALID_SHAPE')
    const [deletion] = parseFindings(payload([findingJson({ suggestion: '' })]), article)
    expect(deletion.suggestion).toBe('')
  })

  it('rejects a missing or empty issue', () => {
    const { issue: _issue, ...missing } = findingJson()
    expect(parseError(payload([missing])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ issue: '   ' })])).code).toBe('INVALID_SHAPE')
  })

  it('rejects an invalid needs_human flag and a non-positive occurrence', () => {
    expect(parseError(payload([findingJson({ needs_human: 'yes' })])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ occurrence: 0 })])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ occurrence: 1.5 })])).code).toBe('INVALID_SHAPE')
  })

  it('defaults occurrence to 1 and needs_human to false when absent', () => {
    const { occurrence: _occurrence, needs_human: _needsHuman, ...minimal } = findingJson()
    const [finding] = parseFindings(payload([minimal]), article)
    expect(finding.occurrence).toBe(1)
    expect(finding.needsHuman).toBe(false)
  })

  it('validates the payload root, findings array and entry shape', () => {
    expect(parseError('[]').code).toBe('INVALID_SHAPE')
    expect(parseError(JSON.stringify({})).code).toBe('INVALID_SHAPE')
    expect(parseError(JSON.stringify({ findings: {} })).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([42])).code).toBe('INVALID_SHAPE')
  })

  it('reports unusable text as INVALID_JSON', () => {
    expect(parseError('抱歉，我无法完成这个任务。').code).toBe('INVALID_JSON')
    expect(parseError('```json\n{"findings": [}\n```').code).toBe('INVALID_JSON')
  })

  it('validates optional reason/evidence/sources and strips unknown fields', () => {
    const [finding] = parseFindings(
      payload([
        findingJson({
          reason: '标点规范',
          evidence: '《标点符号用法》',
          sources: [{ title: '规范', url: 'https://example.com/spec' }],
          extra: 'ignored',
        }),
      ]),
      article,
    )
    expect(finding.reason).toBe('标点规范')
    expect(finding.evidence).toBe('《标点符号用法》')
    expect(finding.sources).toEqual([{ title: '规范', url: 'https://example.com/spec' }])
    expect(finding).not.toHaveProperty('extra')
  })

  it('rejects malformed optional fields instead of storing garbage', () => {
    expect(parseError(payload([findingJson({ reason: 7 })])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ evidence: 7 })])).code).toBe('INVALID_SHAPE')
    expect(parseError(payload([findingJson({ sources: 'nope' })])).code).toBe('INVALID_SHAPE')
    expect(
      parseError(payload([findingJson({ sources: [{ title: 1, url: 'https://example.com' }] })])).code,
    ).toBe('INVALID_SHAPE')
  })
})

describe('normalizeForMatch', () => {
  it('removes all whitespace including full-width spaces and newlines', () => {
    expect(normalizeForMatch(' 他 说\n：\t你\u3000好\r\n')).toBe('他说:你好')
  })

  it('folds full-width ASCII punctuation, digits and letters to ASCII', () => {
    expect(normalizeForMatch('ＡＢＣ１２３，！？：；（）')).toBe('ABC123,!?:;()')
  })

  it('folds curly single and double quotes to ASCII quotes', () => {
    expect(normalizeForMatch('“你好”‘再见’')).toBe('"你好"\'再见\'')
  })

  it('leaves CJK punctuation without an ASCII counterpart unchanged', () => {
    expect(normalizeForMatch('。、《》—…')).toBe('。、《》—…')
  })

  it('is idempotent', () => {
    const once = normalizeForMatch(' Ａ “Ｂ”\n')
    expect(normalizeForMatch(once)).toBe(once)
  })
})

describe('locateQuote', () => {
  it('locates an exact quote at the first occurrence', () => {
    expect(locateQuote('甲。乙。甲。', '甲')).toEqual({ quote: '甲', occurrence: 1 })
  })

  it('locates the second occurrence when it is requested', () => {
    expect(locateQuote('甲。乙。甲。', '甲', 2)).toEqual({ quote: '甲', occurrence: 2 })
  })

  it('falls back to normalized matching and returns the canonical article snippet', () => {
    // The model quote uses ASCII quotes; the article has full-width curly quotes.
    expect(locateQuote(article, '他说:"你好。"')).toEqual({ quote: '他说：“你好。”', occurrence: 1 })
  })

  it('normalized matching can locate the second occurrence of the same snippet', () => {
    const text = '他说：“你好。”随后离开。他说：“你好。”'
    expect(locateQuote(text, '他说:"你好。"', 2)).toEqual({
      quote: '他说：“你好。”',
      occurrence: 2,
    })
  })

  it('counts an earlier normalized-only variant when locating the exact occurrence', () => {
    // The first occurrence has full-width curly quotes; the exact ASCII spelling
    // is the second occurrence in the article, so occurrence is 2.
    const text = '他说：“你好。”随后离开。他说:"你好。"'
    expect(locateQuote(text, '他说:"你好。"')).toEqual({
      quote: '他说:"你好。"',
      occurrence: 2,
    })
  })

  it('returns undefined for an empty quote, a missing quote or an out-of-range occurrence', () => {
    expect(locateQuote(article, '')).toBeUndefined()
    expect(locateQuote(article, '不存在的句子')).toBeUndefined()
    expect(locateQuote('甲。乙。甲。', '甲', 3)).toBeUndefined()
  })
})

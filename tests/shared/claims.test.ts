/**
 * Tests for the facts-role claims/verdict parsers (`src/shared/proof/claims.ts`).
 *
 * The model is untrusted input, so the parsers validate the documented
 * `claims.schema.json` / `factchecks.schema.json` shape and normalize the
 * advisory fields (query variants, priority) instead of rejecting a whole reply
 * over them: dropping a claim would violate the "应查尽查" rule.
 */
import { describe, expect, it } from 'vitest'
import {
  CLAIM_KINDS,
  ClaimsError,
  FACT_VERDICTS,
  MAX_QUERY_VARIANTS,
  parseClaims,
  parseVerdicts,
} from '../../src/shared/proof/claims'

/** A model claim that satisfies every rule; each test overrides one field. */
function claimJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: '文汇报创刊于1938年',
    quote: '文汇报创刊于1938年',
    kind: 'date',
    queries: ['文汇报 创刊 1938', '文汇报 历史'],
    priority: 1,
    ...overrides,
  }
}

/** Wrap claims into the `{ claims, notes }` reply contract. */
function claimsPayload(claims: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claims, ...extra })
}

/** A model verdict that satisfies every rule; each test overrides one field. */
function verdictJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: '文汇报创刊于1938年',
    verdict: 'confirmed',
    evidence: '创刊号影印件',
    sources: [{ title: '文汇报简介', url: 'https://example.com/history' }],
    confidence: 'high',
    needs_human: false,
    ...overrides,
  }
}

/** Wrap verdicts into the `{ verdicts, notes }` reply contract. */
function verdictsPayload(verdicts: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ verdicts, ...extra })
}

/** Run the claims parser and return the typed validation error it threw. */
function claimsError(raw: string): ClaimsError {
  try {
    parseClaims(raw)
  } catch (error) {
    if (error instanceof ClaimsError) return error
    throw error
  }
  throw new Error('expected parseClaims to throw')
}

/** Run the verdict parser and return the typed validation error it threw. */
function verdictsError(raw: string): ClaimsError {
  try {
    parseVerdicts(raw)
  } catch (error) {
    if (error instanceof ClaimsError) return error
    throw error
  }
  throw new Error('expected parseVerdicts to throw')
}

describe('claim and verdict enums', () => {
  it('exposes exactly the documented claim kinds', () => {
    expect(CLAIM_KINDS).toEqual([
      'date',
      'time',
      'person',
      'title',
      'organization',
      'place',
      'book',
      'event',
      'number',
      'quote',
      'other',
    ])
  })

  it('exposes exactly the documented verdicts', () => {
    expect(FACT_VERDICTS).toEqual(['confirmed', 'contradicted', 'unverified', 'insufficient', 'not_checked'])
  })

  it('caps query variants at three', () => {
    expect(MAX_QUERY_VARIANTS).toBe(3)
  })
})

describe('parseClaims', () => {
  it('produces the exact documented claim shape with trimmed strings', () => {
    const claims = parseClaims(
      claimsPayload([claimJson({ claim: '  文汇报创刊于1938年 ', quote: ' 文汇报创刊于1938年 ' })]),
    )
    expect(claims).toEqual([
      {
        claim: '文汇报创刊于1938年',
        quote: '文汇报创刊于1938年',
        kind: 'date',
        queries: ['文汇报 创刊 1938', '文汇报 历史'],
        priority: 1,
      },
    ])
  })

  it('parses every documented kind', () => {
    const claims = parseClaims(
      claimsPayload(
        CLAIM_KINDS.map((kind) => claimJson({ claim: `claim-${kind}`, quote: `quote-${kind}`, kind })),
      ),
    )
    expect(claims.map((claim) => claim.kind)).toEqual([...CLAIM_KINDS])
  })

  it('reuses the shared extractor for fenced JSON wrapped in prose', () => {
    const raw = `核查结果如下：\n\`\`\`json\n${claimsPayload([claimJson()])}\n\`\`\`\n希望对你有帮助。`
    const claims = parseClaims(raw)
    expect(claims).toHaveLength(1)
    expect(claims[0].claim).toBe('文汇报创刊于1938年')
  })

  it('returns an empty list when the model reports no checkable claim', () => {
    expect(parseClaims(claimsPayload([], { notes: '未发现可核查项' }))).toEqual([])
  })

  it('accepts a single query variant (the brief example) so the claim is never dropped', () => {
    const claims = parseClaims(claimsPayload([claimJson({ queries: ['文汇报 2026年11月14日'] })]))
    expect(claims[0].queries).toEqual(['文汇报 2026年11月14日'])
  })

  it('trims, dedupes and caps query variants, and falls back to the claim text', () => {
    const [claim] = parseClaims(
      claimsPayload([claimJson({ queries: [' 文汇报 创刊 ', '文汇报创刊', '第二', '第三', '第四'] })]),
    )
    expect(claim.queries).toEqual(['文汇报 创刊', '第二', '第三'])

    const [missing] = parseClaims(claimsPayload([claimJson({ queries: undefined })]))
    expect(missing.queries).toEqual([missing.claim])

    const [blank] = parseClaims(claimsPayload([claimJson({ queries: ['', '   '] })]))
    expect(blank.queries).toEqual([blank.claim])
  })

  it('clamps priority to at least 1 and falls back to the extraction order when absent', () => {
    const [zero] = parseClaims(claimsPayload([claimJson({ priority: 0 })]))
    expect(zero.priority).toBe(1)

    const [fractional] = parseClaims(claimsPayload([claimJson({ priority: 2.9 })]))
    expect(fractional.priority).toBe(2)

    const missing = parseClaims(
      claimsPayload([
        claimJson({ claim: 'a', quote: 'a', priority: undefined }),
        claimJson({ claim: 'b', quote: 'b', priority: undefined }),
      ]),
    )
    expect(missing.map((claim) => claim.priority)).toEqual([1, 2])
  })

  it('ignores unknown fields instead of rejecting the reply', () => {
    const [claim] = parseClaims(claimsPayload([claimJson({ note: '模型自述' })]))
    expect(claim).toEqual({
      claim: '文汇报创刊于1938年',
      quote: '文汇报创刊于1938年',
      kind: 'date',
      queries: ['文汇报 创刊 1938', '文汇报 历史'],
      priority: 1,
    })
  })

  it('reports INVALID_JSON for unparseable output', () => {
    expect(claimsError('这不是 JSON').code).toBe('INVALID_JSON')
    expect(claimsError('{"claims": [}').code).toBe('INVALID_JSON')
  })

  it('reports INVALID_SHAPE when the claims array is missing or malformed', () => {
    expect(claimsError('{}').code).toBe('INVALID_SHAPE')
    expect(claimsError(JSON.stringify({ claims: {} })).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([42])).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([claimJson()]).slice(0, 10)).code).toBe('INVALID_JSON')
  })

  it('reports INVALID_SHAPE for a bad claim, empty quote, unknown kind or malformed queries', () => {
    expect(claimsError(claimsPayload([claimJson({ claim: '  ' })])).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([claimJson({ quote: '' })])).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([claimJson({ kind: 'weather' })])).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([claimJson({ queries: 'query' })])).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([claimJson({ queries: [42] })])).code).toBe('INVALID_SHAPE')
    expect(claimsError(claimsPayload([claimJson({ priority: 'high' })])).code).toBe('INVALID_SHAPE')
  })

  it('fails the whole reply when one claim violates the contract (caller retries)', () => {
    const raw = claimsPayload([claimJson(), claimJson({ kind: 'weather' })])
    expect(claimsError(raw).code).toBe('INVALID_SHAPE')
  })
})

describe('parseVerdicts', () => {
  it('produces the exact documented verdict shape', () => {
    expect(parseVerdicts(verdictsPayload([verdictJson()]))).toEqual([
      {
        claim: '文汇报创刊于1938年',
        verdict: 'confirmed',
        evidence: '创刊号影印件',
        sources: [{ title: '文汇报简介', url: 'https://example.com/history' }],
        confidence: 'high',
        needsHuman: false,
      },
    ])
  })

  it('parses fenced JSON wrapped in prose and ignores unknown fields', () => {
    const raw = `核验结果：\n\`\`\`json\n${verdictsPayload([verdictJson({ note: 'ok' })])}\n\`\`\`\n完毕。`
    expect(parseVerdicts(raw)[0].verdict).toBe('confirmed')
  })

  it('defaults optional fields: no sources -> [], no needs_human -> false, no evidence key', () => {
    const [verdict] = parseVerdicts(
      verdictsPayload([{ claim: '文汇报创刊于1938年', verdict: 'unverified', confidence: 'low' }]),
    )
    expect(verdict).toEqual({
      claim: '文汇报创刊于1938年',
      verdict: 'unverified',
      sources: [],
      confidence: 'low',
      needsHuman: false,
    })
    expect('evidence' in verdict).toBe(false)
  })

  it('accepts every documented verdict value', () => {
    const verdicts = parseVerdicts(
      verdictsPayload(
        FACT_VERDICTS.map((verdict) => ({
          claim: `claim-${verdict}`,
          verdict,
          confidence: 'medium',
        })),
      ),
    )
    expect(verdicts.map((entry) => entry.verdict)).toEqual([...FACT_VERDICTS])
  })

  it('keeps source order and derives a missing title from its URL', () => {
    const [verdict] = parseVerdicts(
      verdictsPayload([
        verdictJson({
          sources: [
            { title: '第一来源', url: 'https://example.com/1' },
            { url: 'https://example.com/2' },
          ],
        }),
      ]),
    )
    expect(verdict.sources).toEqual([
      { title: '第一来源', url: 'https://example.com/1' },
      { title: 'https://example.com/2', url: 'https://example.com/2' },
    ])
  })

  it('returns an empty list for an empty verdicts array', () => {
    expect(parseVerdicts(verdictsPayload([]))).toEqual([])
  })

  it('reports INVALID_JSON for unparseable output', () => {
    expect(verdictsError('not json').code).toBe('INVALID_JSON')
  })

  it('reports INVALID_SHAPE for bad required fields and malformed sources', () => {
    expect(verdictsError('{}').code).toBe('INVALID_SHAPE')
    expect(verdictsError(JSON.stringify({ verdicts: {} })).code).toBe('INVALID_SHAPE')
    expect(verdictsError(verdictsPayload([42])).code).toBe('INVALID_SHAPE')
    expect(verdictsError(verdictsPayload([verdictJson({ claim: '' })])).code).toBe('INVALID_SHAPE')
    expect(verdictsError(verdictsPayload([verdictJson({ verdict: 'guessed' })])).code).toBe('INVALID_SHAPE')
    expect(verdictsError(verdictsPayload([verdictJson({ confidence: 'certain' })])).code).toBe('INVALID_SHAPE')
    expect(
      verdictsError(verdictsPayload([{ claim: 'x', verdict: 'confirmed', sources: [] }])).code,
    ).toBe('INVALID_SHAPE')
    expect(verdictsError(verdictsPayload([verdictJson({ sources: 'https://example.com' })])).code).toBe(
      'INVALID_SHAPE',
    )
    expect(verdictsError(verdictsPayload([verdictJson({ sources: [{ title: '无 URL' }] })])).code).toBe(
      'INVALID_SHAPE',
    )
    expect(verdictsError(verdictsPayload([verdictJson({ needs_human: 'yes' })])).code).toBe('INVALID_SHAPE')
  })
})

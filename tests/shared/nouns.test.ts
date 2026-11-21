import { describe, expect, it } from 'vitest'
import {
  MAX_NOUN_QUERY_VARIANTS,
  NOUN_KINDS,
  NounsError,
  parseNounCandidates,
} from '../../src/shared/proof/nouns'

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '复旦大学附属华山医院',
    quote: '复旦大学附属华山医院团队',
    kind: 'institution',
    queries: ['复旦大学附属华山医院', '华山医院'],
    priority: 1,
    ...overrides,
  }
}

function payload(nouns: unknown[]): string {
  return JSON.stringify({ nouns })
}

function parseError(raw: string): NounsError {
  try {
    parseNounCandidates(raw)
  } catch (error) {
    if (error instanceof NounsError) return error
    throw error
  }
  throw new Error('expected parseNounCandidates to throw')
}

describe('parseNounCandidates', () => {
  it('parses, trims and preserves a prioritized noun plan', () => {
    const candidates = parseNounCandidates(
      payload([
        row({ priority: 2 }),
        row({
          name: ' 脑机接口系统NEO ',
          quote: ' 脑机接口系统NEO ',
          kind: 'system',
          queries: [' 脑机接口系统NEO ', 'NEO 脑机接口'],
          priority: 1,
        }),
      ]),
    )
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      name: '复旦大学附属华山医院',
      kind: 'institution',
      priority: 2,
      queries: ['复旦大学附属华山医院', '华山医院'],
    })
    expect(candidates[1]).toMatchObject({
      name: '脑机接口系统NEO',
      kind: 'system',
      priority: 1,
    })
    expect(NOUN_KINDS).toContain('technical_term')
  })

  it('dedupes the same normalized noun and keeps the highest priority', () => {
    const candidates = parseNounCandidates(
      payload([
        row({ name: '脑智天地', priority: 5, quote: '园区', kind: 'place' }),
        row({ name: ' 脑智天地 ', priority: 2, quote: '另一个引用', kind: 'project' }),
      ]),
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0].priority).toBe(2)
    expect(candidates[0].quote).toBe('园区')
    expect(candidates[0].kind).toBe('place')
  })

  it('falls back to the noun for a missing quote/queries and caps query variants', () => {
    const candidates = parseNounCandidates(
      payload([
        row({
          quote: '',
          queries: ['a', 'b', 'c', 'd'],
        }),
      ]),
    )
    expect(candidates[0].quote).toBe('复旦大学附属华山医院')
    expect(candidates[0].queries).toHaveLength(MAX_NOUN_QUERY_VARIANTS)
  })

  it('accepts an empty plan and fenced JSON', () => {
    expect(parseNounCandidates('{"nouns":[]}')).toEqual([])
    expect(parseNounCandidates('```json\n{"nouns":[]}\n```')).toEqual([])
  })

  it('rejects invalid JSON and a non-array nouns field', () => {
    expect(parseError('not json').code).toBe('INVALID_JSON')
    expect(parseError('{"nouns":{}}').code).toBe('INVALID_SHAPE')
    expect(parseError('{"items":[]}').code).toBe('INVALID_SHAPE')
  })

  it('rejects missing name, invalid kind and non-object rows', () => {
    expect(parseError(payload([row({ name: ' ' })])).message).toContain('name')
    expect(parseError(payload([row({ kind: 'aliens' })])).message).toContain('unknown noun kind')
    expect(parseError(payload(['x'])).message).toContain('must be an object')
  })
})

import { describe, expect, it } from 'vitest'
import { parseFindings } from '../../src/shared/proof/findings'
import { SUGGESTION_CONFLICT_REASON, mergeFindings } from '../../src/shared/proof/merge'
import type { Finding } from '../../src/shared/types'

/** Minimal role reply payload, as the roles are expected to answer (§7.3). */
function roleReply(findings: Record<string, unknown>[]): string {
  return JSON.stringify({ findings, notes: 'role notes' })
}

/** Attach the article/role context that the orchestrator knows (Task 13). */
function stamp(findings: readonly Finding[], articleId: string, role: string): Finding[] {
  return findings.map((finding) => ({ ...finding, articleId, roles: [role] }))
}

/** A valid finding; each test overrides the fields it cares about. */
function finding(
  id: string,
  quote: string,
  severity: Finding['severity'],
  role: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id,
    articleId: 'a1',
    category: 'typo',
    severity,
    quote,
    occurrence: 1,
    issue: 'x',
    suggestion: 'y',
    confidence: 'high',
    needsHuman: false,
    roles: [role],
    status: 'open',
    ...overrides,
  }
}

it('dedupes by normalized quote and keeps the highest severity', () => {
  const merged = mergeFindings([finding('1', '你好', 'suggested', 'words'), finding('2', ' 你好 ', 'must_fix', 'master')])
  expect(merged).toHaveLength(1)
  expect(merged[0].severity).toBe('must_fix')
  expect(merged[0].roles.sort()).toEqual(['master', 'words'])
  expect(merged[0].id).toBe('f1')
})

describe('mergeFindings', () => {
  it('does not merge findings of different categories', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'must_fix', 'words'),
      finding('2', '你好', 'must_fix', 'words', { category: 'punctuation' }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged.map((item) => item.category)).toEqual(['typo', 'punctuation'])
  })

  it('groups quotes that differ only by whitespace or full/half-width punctuation', () => {
    const merged = mergeFindings([
      finding('1', '他说:"你好。"', 'must_fix', 'words'),
      finding('2', '他说：“你好。”', 'suggested', 'master'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].severity).toBe('must_fix')
    expect(merged[0].roles).toEqual(['words', 'master'])
  })

  it('takes the maximum confidence and the first credible suggestion', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'suggested', 'words', { confidence: 'low', suggestion: '' }),
      finding('2', '你好', 'must_fix', 'master', { confidence: 'high', suggestion: '您好' }),
      finding('3', '你好', 'optional', 'style', { confidence: 'medium', suggestion: '您好' }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].severity).toBe('must_fix')
    expect(merged[0].confidence).toBe('high')
    expect(merged[0].suggestion).toBe('您好')
    expect(merged[0].needsHuman).toBe(false)
  })

  it('does not treat whitespace variants of one suggestion as a conflict', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'must_fix', 'words', { suggestion: '您好' }),
      finding('2', '你好', 'must_fix', 'master', { suggestion: '您 好' }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].needsHuman).toBe(false)
    expect(merged[0].suggestion).toBe('您好')
  })

  it('flags conflicting suggestions as needsHuman and keeps the first credible one', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'must_fix', 'words', { suggestion: '您好' }),
      finding('2', '你好', 'must_fix', 'master', { suggestion: '你 好' }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].needsHuman).toBe(true)
    expect(merged[0].reason).toContain('建议冲突')
    expect(merged[0].suggestion).toBe('您好')
    expect(SUGGESTION_CONFLICT_REASON).toBe('建议冲突，需人工确认')
  })

  it('keeps the primary fields of the highest-severity, highest-confidence finding', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'suggested', 'words', {
        issue: '次要问题',
        occurrence: 3,
        suggestion: '您好',
        status: 'deferred',
      }),
      finding('2', '你好', 'must_fix', 'master', {
        issue: '严重问题',
        occurrence: 2,
        suggestion: '您好',
      }),
    ])
    expect(merged[0].severity).toBe('must_fix')
    expect(merged[0].issue).toBe('严重问题')
    expect(merged[0].occurrence).toBe(2)
    expect(merged[0].status).toBe('open')
    expect(merged[0].suggestion).toBe('您好')
  })

  it('preserves needsHuman and its reason from any member', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'must_fix', 'words', { needsHuman: true, reason: '引用无法定位' }),
      finding('2', '你好', 'suggested', 'master'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].needsHuman).toBe(true)
    expect(merged[0].reason).toBe('引用无法定位')
  })

  it('unions roles without duplicates in first-seen order', () => {
    const merged = mergeFindings([
      finding('1', '你好', 'must_fix', 'words'),
      finding('2', '你好', 'must_fix', 'words'),
      finding('3', '你好', 'must_fix', 'master'),
    ])
    expect(merged[0].roles).toEqual(['words', 'master'])
  })

  it('assigns f1... ids in first-appearance order deterministically', () => {
    const input = [
      finding('x', '你好', 'must_fix', 'words'),
      finding('y', '随后离开', 'suggested', 'master'),
      finding('z', '你好', 'suggested', 'style'),
    ]
    const first = mergeFindings(input)
    const second = mergeFindings(input)
    expect(first.map((item) => item.id)).toEqual(['f1', 'f2'])
    expect(second).toEqual(first)
    expect(first[0].roles).toEqual(['words', 'style'])
  })

  it('returns an empty list for no findings', () => {
    expect(mergeFindings([])).toEqual([])
  })

  it('does not mutate the input findings', () => {
    const words = finding('1', '你好', 'suggested', 'words', { roles: ['words'] })
    const master = finding('2', ' 你好 ', 'must_fix', 'master', { roles: ['master'] })
    const input = [words, master]
    const snapshot = JSON.parse(JSON.stringify(input))
    const merged = mergeFindings(input)
    expect(input).toEqual(snapshot)
    expect(merged[0]).not.toBe(words)
    expect(merged[0]).not.toBe(master)
    expect(merged[0].roles).not.toBe(words.roles)
  })
})

describe('parseFindings -> mergeFindings (per-article seam, Task 13)', () => {
  const article = '本报讯 记者张三报道：城市更新按下加速键，随后他说：“你好。”'

  const masterReply = roleReply([
    {
      category: 'punctuation',
      severity: 'suggested',
      quote: '他说:"你好。"',
      issue: '引号格式',
      suggestion: '他说：“你好。”',
      confidence: 'high',
      needs_human: false,
    },
    {
      category: 'typo',
      severity: 'must_fix',
      quote: '记者张三',
      issue: '姓名待核',
      suggestion: '记者张叁',
      confidence: 'medium',
      needs_human: false,
    },
  ])
  const wordsReply = roleReply([
    {
      category: 'punctuation',
      severity: 'must_fix',
      quote: '他说：“你好。”',
      issue: '引号不配对',
      suggestion: '他说：“你好。”',
      confidence: 'high',
      needs_human: false,
    },
    {
      category: 'typo',
      severity: 'must_fix',
      quote: '不存在的引用',
      issue: '无法定位示例',
      suggestion: 'x',
      confidence: 'low',
      needs_human: false,
    },
  ])

  it('merges the same problem reported by two roles and keeps unlocated findings', () => {
    const merged = mergeFindings([
      ...stamp(parseFindings(masterReply, article), 'a1', 'master'),
      ...stamp(parseFindings(wordsReply, article), 'a1', 'words'),
    ])

    expect(merged.map((finding) => finding.id)).toEqual(['f1', 'f2', 'f3'])
    const [punctuation, name, unlocated] = merged
    expect(punctuation.category).toBe('punctuation')
    expect(punctuation.severity).toBe('must_fix')
    expect(punctuation.roles).toEqual(['master', 'words'])
    expect(punctuation.quote).toBe('他说：“你好。”')
    expect(punctuation.needsHuman).toBe(false)
    expect(name.category).toBe('typo')
    expect(name.roles).toEqual(['master'])
    expect(unlocated.needsHuman).toBe(true)
    expect(unlocated.reason).toBe('引用无法定位')
    expect(unlocated.roles).toEqual(['words'])
  })
})

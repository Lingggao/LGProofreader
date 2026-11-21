import { describe, expect, it } from 'vitest'
import { renderReportMarkdown } from '../../src/shared/report/markdown'
import type {
  Article,
  FactCheck,
  Finding,
  NounCheck,
  Report,
  ReportRoleFailure,
} from '../../src/shared/types'

/** One finding with the brief's fixture shape; each test overrides what it needs. */
function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    articleId: 'a1',
    category: 'typo',
    severity: 'must_fix',
    quote: '他的确',
    occurrence: 1,
    issue: '错别字',
    suggestion: '他的确',
    confidence: 'high',
    needsHuman: false,
    roles: ['master'],
    status: 'open',
    ...overrides,
  }
}

/** One fact check with the brief's fixture shape. */
function factCheck(overrides: Partial<FactCheck> = {}): FactCheck {
  return {
    id: 'fc1',
    articleId: 'a1',
    claim: '2026年11月14日',
    quote: '2026年11月14日',
    kind: 'date',
    verdict: 'confirmed',
    sources: [{ title: '来源', url: 'https://example.com' }],
    confidence: 'high',
    needsHuman: false,
    ...overrides,
  }
}

/** One existence-only noun check with the brief's fixture shape. */
function nounCheck(overrides: Partial<NounCheck> = {}): NounCheck {
  return {
    id: 'noun1',
    articleId: 'a1',
    name: '复旦大学附属华山医院',
    quote: '复旦大学附属华山医院团队',
    kind: 'institution',
    priority: 1,
    status: 'exists',
    evidence: '检索到 2 个来源可佐证该名词存在。',
    sources: [{ title: '来源', url: 'https://example.com/huashan' }],
    confidence: 'medium',
    needsHuman: false,
    ...overrides,
  }
}

/** Noun-check summary counts; overriding replaces the whole block. */
function nounSummary(
  overrides: Partial<NonNullable<Report['summary']['nounCheck']>> = {},
): NonNullable<Report['summary']['nounCheck']> {
  return { exists: 1, uncertain: 0, notFound: 0, notChecked: 0, ...overrides }
}

/** One article with the brief's fixture shape. */
function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    page: 1,
    role: 'lead',
    title: '标题',
    body: '正文',
    regionIds: ['r1'],
    readingOrder: 1,
    confidence: 1,
    warnings: [],
    ...overrides,
  }
}

/** The report summary block; overriding it replaces the whole block. */
function summary(overrides: Partial<Report['summary']> = {}): Report['summary'] {
  return {
    mustFixCount: 1,
    suggestedCount: 0,
    optionalCount: 0,
    factCheck: { confirmed: 1, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
    byCategory: { typo: 1 },
    mustFixList: ['改“的地得”'],
    ...overrides,
  }
}

/** One failed role; each test overrides what it needs. */
function failedRole(overrides: Partial<ReportRoleFailure> = {}): ReportRoleFailure {
  return {
    articleId: 'a1',
    role: 'facts',
    error: 'provider refused the request',
    ...overrides,
  }
}

/** The report object from the brief's fixture; each test overrides what it needs. */
function report(overrides: Partial<Report> = {}): Report {
  return {
    jobId: 'j1',
    docId: 'd1',
    articleIds: ['a1'],
    createdAt: 0,
    model: 'deepseek-flash',
    promptVersion: 'v1',
    depth: 'standard',
    summary: summary(),
    findings: [finding()],
    factChecks: [factCheck()],
    stats: { calls: 1, failedCalls: 0, searchCalls: 1, fetchCalls: 0, elapsedMs: 1 },
    ...overrides,
  }
}

/** The line that contains `needle`, as a single-line assertion helper. */
function lineWith(markdown: string, needle: string): string {
  const line = markdown.split('\n').find((candidate) => candidate.includes(needle))
  expect(line, `no line contains ${needle}`).toBeDefined()
  return line as string
}

/** The part of the document starting at the must-fix summary heading. */
function summarySection(markdown: string): string {
  const start = markdown.indexOf('## 必须修改的条目')
  expect(start, 'missing 必须修改的条目 section').toBeGreaterThanOrEqual(0)
  return markdown.slice(start)
}

it('renders findings, bold suggestions, fact checklist and must-fix summary', () => {
  const markdown = renderReportMarkdown(report(), [article()])
  expect(markdown).toContain('# Ling Gao 校对员 · 校对报告')
  expect(markdown).toContain('**他的确**')
  expect(markdown).toContain('## 事实核查清单')
  expect(markdown).toContain('## 必须修改的条目')
  expect(markdown).toContain('改“的地得”')
  expect(markdown.indexOf('## 必须修改的条目')).toBeGreaterThan(markdown.indexOf('## 事实核查清单'))
})

describe('document layout', () => {
  it('orders title, article findings, fact checklist, must-fix summary and footer', () => {
    const markdown = renderReportMarkdown(report(), [article()])
    const title = markdown.indexOf('# Ling Gao 校对员 · 校对报告')
    const articleHeading = markdown.indexOf('## 标题')
    const findings = markdown.indexOf('- [必改] 错别字 · “他的确”')
    const facts = markdown.indexOf('## 事实核查清单')
    const factRow = markdown.indexOf('| 2026年11月14日 |')
    const mustFix = markdown.indexOf('## 必须修改的条目')
    const summaryItem = markdown.indexOf('改“的地得”')
    const footer = markdown.indexOf('Ling Gao Proofreader v1.0.0')
    expect(title).toBe(0)
    expect(articleHeading).toBeGreaterThan(title)
    expect(findings).toBeGreaterThan(articleHeading)
    expect(facts).toBeGreaterThan(findings)
    expect(factRow).toBeGreaterThan(facts)
    expect(mustFix).toBeGreaterThan(factRow)
    expect(summaryItem).toBeGreaterThan(mustFix)
    expect(footer).toBeGreaterThan(summaryItem)
  })

  it('renders each article under its own heading and keeps its findings there', () => {
    const markdown = renderReportMarkdown(
      report({
        articleIds: ['a1', 'a2'],
        findings: [
          finding({ id: 'f1', articleId: 'a1', quote: '甲处', issue: '错误甲', suggestion: '改甲' }),
          finding({ id: 'f2', articleId: 'a2', quote: '乙处', issue: '错误乙', suggestion: '改乙' }),
        ],
      }),
      [article({ id: 'a1', title: '第一篇' }), article({ id: 'a2', title: '第二篇' })],
    )
    const secondHeading = markdown.indexOf('## 第二篇')
    expect(markdown).toContain('## 第一篇')
    expect(markdown.indexOf('错误甲')).toBeLessThan(secondHeading)
    expect(markdown.indexOf('错误乙')).toBeGreaterThan(secondHeading)
  })

  it('renders every finding exactly once even when report.findings is interleaved', () => {
    const findings = [
      finding({ id: 'f1', articleId: 'a1', quote: '甲处', suggestion: '改甲', issue: '错误甲' }),
      finding({ id: 'f2', articleId: 'a2', quote: '乙处', suggestion: '改乙', issue: '错误乙' }),
      finding({ id: 'f3', articleId: 'a1', quote: '丙处', suggestion: '改丙', issue: '错误丙' }),
    ]
    const markdown = renderReportMarkdown(report({ articleIds: ['a1', 'a2'], findings }), [
      article({ id: 'a1', title: '第一篇' }),
      article({ id: 'a2', title: '第二篇' }),
    ])
    for (const issue of ['错误甲', '错误乙', '错误丙']) {
      expect(markdown.split(issue)).toHaveLength(2)
    }
  })

  it('never includes the article body (no rewritten full text)', () => {
    const body = '这是完整的文章正文，报告不得输出改写后的全文。'
    const markdown = renderReportMarkdown(report(), [article({ body })])
    expect(markdown).not.toContain(body)
  })

  it('is deterministic and does not mutate its inputs', () => {
    const input = report()
    const articles = [article()]
    const snapshot = JSON.stringify([input, articles])
    const first = renderReportMarkdown(input, articles)
    const second = renderReportMarkdown(input, articles)
    expect(second).toBe(first)
    expect(JSON.stringify([input, articles])).toBe(snapshot)
  })
})

describe('findings', () => {
  it('renders the brief bullet shape with the issue, quote and a bold suggestion', () => {
    const markdown = renderReportMarkdown(report(), [article()])
    expect(markdown).toContain('- [必改] 错别字 · “他的确” → **他的确**')
  })

  it('labels severities and preserves the report order (no re-sorting in the renderer)', () => {
    const markdown = renderReportMarkdown(
      report({
        findings: [
          finding({ id: 'f1', severity: 'suggested', quote: '甲处', issue: '建议甲', suggestion: '改甲' }),
          finding({ id: 'f2', severity: 'must_fix', quote: '乙处', issue: '必改乙', suggestion: '改乙' }),
          finding({ id: 'f3', severity: 'optional', quote: '丙处', issue: '可选丙', suggestion: '改丙' }),
        ],
      }),
      [article()],
    )
    expect(markdown).toContain('- [建议] 建议甲 · “甲处” → **改甲**')
    expect(markdown).toContain('- [必改] 必改乙 · “乙处” → **改乙**')
    expect(markdown).toContain('- [可选] 可选丙 · “丙处” → **改丙**')
    expect(markdown.indexOf('建议甲')).toBeLessThan(markdown.indexOf('必改乙'))
  })

  it('includes the reason, evidence, sources and needs-human marker as 依据', () => {
    const markdown = renderReportMarkdown(
      report({
        findings: [
          finding({
            reason: '词典依据',
            evidence: '规范示例',
            sources: [{ title: '现代汉语词典', url: 'https://example.com/dict' }],
            needsHuman: true,
          }),
        ],
      }),
      [article()],
    )
    const line = lineWith(markdown, '“他的确”')
    expect(line).toContain('（依据：')
    expect(line).toContain('词典依据')
    expect(line).toContain('规范示例')
    expect(line).toContain('[现代汉语词典](https://example.com/dict)')
    expect(line).toContain('需人工确认')
  })

  it('does not repeat the needs-human marker when the reason already says it', () => {
    const markdown = renderReportMarkdown(
      report({ findings: [finding({ needsHuman: true, reason: '引用无法定位，需人工确认' })] }),
      [article()],
    )
    const line = lineWith(markdown, '“他的确”')
    expect(line.match(/需人工确认/g)).toHaveLength(1)
  })

  it('omits the 依据 parenthetical when every optional field is missing', () => {
    const markdown = renderReportMarkdown(report(), [article()])
    const line = lineWith(markdown, '“他的确”')
    expect(line).not.toContain('（依据：')
    expect(line).not.toContain('需人工确认')
  })

  it('keeps bold markers already present in the suggestion instead of double-wrapping', () => {
    const markdown = renderReportMarkdown(
      report({ findings: [finding({ suggestion: '改为**他的确**' })] }),
      [article()],
    )
    expect(markdown).toContain('→ 改为**他的确**')
    expect(markdown).not.toContain('**改为**')
  })

  it('marks an empty suggestion as a deletion', () => {
    const markdown = renderReportMarkdown(report({ findings: [finding({ suggestion: '' })] }), [article()])
    expect(markdown).toContain('→ **（删除）**')
  })
})

describe('articles', () => {
  it('says 未发现问题 for an article without findings', () => {
    const markdown = renderReportMarkdown(
      report({ findings: [], summary: summary({ mustFixCount: 0, byCategory: {}, mustFixList: [] }) }),
      [article()],
    )
    expect(markdown).toContain('## 标题')
    expect(markdown).toContain('未发现问题。')
  })

  it('falls back to a readable heading when the article lookup misses', () => {
    const markdown = renderReportMarkdown(report(), [])
    expect(markdown).toContain('## 文章 a1')
    expect(markdown).toContain('**他的确**')
  })

  it('falls back to 未归属文章 for findings without an article id', () => {
    const markdown = renderReportMarkdown(
      report({ articleIds: [], findings: [finding({ articleId: '' })] }),
      [],
    )
    expect(markdown).toContain('## 未归属文章')
  })

  it('still renders findings whose article is not listed in report.articleIds', () => {
    const markdown = renderReportMarkdown(
      report({ articleIds: [], findings: [finding({ articleId: 'a9', quote: '漏列' })] }),
      [],
    )
    expect(markdown).toContain('## 文章 a9')
    expect(markdown).toContain('“漏列”')
  })

  it('falls back to a readable heading when an article title is empty', () => {
    const markdown = renderReportMarkdown(report(), [article({ title: '' })])
    expect(markdown).toContain('## 文章 a1')
  })
})

describe('fact checklist', () => {
  it('renders a five-column table with verdict labels and source links', () => {
    const checks = [
      factCheck({ id: 'fc1', verdict: 'confirmed' }),
      factCheck({ id: 'fc2', verdict: 'contradicted' }),
      factCheck({ id: 'fc3', verdict: 'unverified' }),
      factCheck({ id: 'fc4', verdict: 'insufficient' }),
      factCheck({ id: 'fc5', verdict: 'not_checked' }),
    ]
    const markdown = renderReportMarkdown(report({ factChecks: checks }), [article()])
    expect(markdown).toContain('| 主张 | 原文引用 | 类型 | 结论 | 依据/来源 |')
    expect(markdown).toContain('| 日期 | 已核实 |')
    expect(markdown).toContain('| 日期 | 有冲突 |')
    expect(markdown).toContain('| 日期 | 未核实 |')
    expect(markdown).toContain('| 日期 | 证据不足 |')
    expect(markdown).toContain('| 日期 | 未检查 |')
    expect(markdown).toContain('[来源](https://example.com)')
  })

  it('escapes pipes and collapses newlines so table cells cannot break the table', () => {
    const markdown = renderReportMarkdown(
      report({
        factChecks: [factCheck({ claim: 'A|B', quote: '第一行\n第二行' })],
        findings: [],
      }),
      [article()],
    )
    expect(markdown).toContain('| A\\|B |')
    expect(markdown).toContain('| 第一行 第二行 |')
    const row = lineWith(markdown, 'A\\|B')
    expect(row.startsWith('|')).toBe(true)
    expect(row.endsWith('|')).toBe(true)
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(6)
  })

  it('shows evidence and the needs-human marker in the last column', () => {
    const markdown = renderReportMarkdown(
      report({
        factChecks: [factCheck({ evidence: '官方公告', needsHuman: true })],
        findings: [],
      }),
      [article()],
    )
    const row = lineWith(markdown, '2026年11月14日 |')
    expect(row).toContain('官方公告')
    expect(row).toContain('需人工确认')
    expect(row).toContain('[来源](https://example.com)')
  })

  it('says 未发现可核查项 and renders no table when there are no fact checks', () => {
    const markdown = renderReportMarkdown(report({ factChecks: [] }), [article()])
    expect(markdown).toContain('未发现可核查项。')
    expect(markdown).not.toContain('| 主张 |')
  })
})

describe('must-fix summary and footer', () => {
  it('lists summary.mustFixList entries verbatim', () => {
    const markdown = renderReportMarkdown(
      report({ summary: summary({ mustFixList: ['第一条必改', '第二条必改'] }) }),
      [article()],
    )
    expect(summarySection(markdown)).toContain('- 第一条必改')
    expect(summarySection(markdown)).toContain('- 第二条必改')
  })

  it('derives the summary from must_fix findings when mustFixList is empty', () => {
    const markdown = renderReportMarkdown(
      report({ summary: summary({ mustFixList: [], mustFixCount: 1 }) }),
      [article()],
    )
    const section = summarySection(markdown)
    expect(section).toContain('- [必改]')
    expect(section).toContain('**他的确**')
  })

  it('says 无必须修改的条目 when nothing must be fixed', () => {
    const markdown = renderReportMarkdown(
      report({
        findings: [],
        summary: summary({ mustFixCount: 0, byCategory: {}, mustFixList: [] }),
      }),
      [article()],
    )
    expect(summarySection(markdown)).toContain('无必须修改的条目。')
  })

  it('ends with a footer carrying product version, model and prompt version', () => {
    const markdown = renderReportMarkdown(report(), [article()])
    const footer = markdown.trimEnd().split('\n').at(-1) as string
    expect(footer).toContain('Ling Gao Proofreader v1.0.0')
    expect(footer).toContain('deepseek-flash')
    expect(footer).toContain('v1')
  })

  it('renders an empty report without crashing', () => {
    const markdown = renderReportMarkdown(
      report({
        articleIds: [],
        findings: [],
        factChecks: [],
        summary: summary({ mustFixCount: 0, byCategory: {}, mustFixList: [] }),
      }),
      [],
    )
    expect(markdown).toContain('# Ling Gao 校对员 · 校对报告')
    expect(markdown).toContain('未发现可核查项。')
    expect(markdown).toContain('无必须修改的条目。')
    expect(markdown).toContain('Ling Gao Proofreader v1.0.0')
  })
})

describe('noun checklist (existence only)', () => {
  /** The part of the document from the noun heading to the must-fix block. */
  function nounSection(markdown: string): string {
    const start = markdown.indexOf('## 名词核查')
    expect(start, 'missing 名词核查 section').toBeGreaterThanOrEqual(0)
    return markdown.slice(start, markdown.indexOf('## 必须修改的条目'))
  }

  it('renders a compact name/status/evidence/source table after the fact checklist', () => {
    const checks = [
      nounCheck({ id: 'noun1', status: 'exists', confidence: 'high' }),
      nounCheck({
        id: 'noun2',
        name: '脑机接口系统NEO',
        status: 'uncertain',
        evidence: '仅检索到一个来源，尚不足以确认该名词存在，需人工确认。',
        needsHuman: true,
      }),
      nounCheck({
        id: 'noun3',
        name: '虚假机构',
        status: 'not_found',
        evidence: '检索完成但未找到匹配来源；不能据此判定该名词不存在，需人工确认。',
        sources: [],
        needsHuman: true,
      }),
      nounCheck({
        id: 'noun4',
        name: '未核实术语',
        status: 'not_checked',
        evidence: '超出本次名词核查预算，未完成联网核查。',
        sources: [],
      }),
    ]
    const markdown = renderReportMarkdown(
      report({ nounChecks: checks, summary: summary({ nounCheck: nounSummary() }) }),
      [article()],
    )
    expect(markdown).toContain('## 名词核查')
    expect(markdown).toContain('| 名词 | 状态 | 依据/来源 |')
    expect(nounSection(markdown)).toContain('| 复旦大学附属华山医院 | 有网络收录 |')
    expect(nounSection(markdown)).toContain('| 脑机接口系统NEO | 证据不足 |')
    expect(nounSection(markdown)).toContain('| 虚假机构 | 未找到来源 |')
    expect(nounSection(markdown)).toContain('| 未核实术语 | 未核查 |')
    expect(nounSection(markdown)).toContain('[来源](https://example.com/huashan)')
    expect(nounSection(markdown)).toContain('需人工确认')
    // Missing evidence is never rendered as a non-existence verdict: the only
    // "不存在" is the explicit caution that it cannot be claimed.
    expect(nounSection(markdown)).not.toMatch(/\| 不存在 \|/)
    expect(nounSection(markdown)).toContain('不能据此判定该名词不存在')
    // The section keeps the documented order: facts → nouns → must-fix.
    const facts = markdown.indexOf('## 事实核查清单')
    const nouns = markdown.indexOf('## 名词核查')
    const mustFix = markdown.indexOf('## 必须修改的条目')
    expect(facts).toBeGreaterThanOrEqual(0)
    expect(nouns).toBeGreaterThan(facts)
    expect(mustFix).toBeGreaterThan(nouns)
  })

  it('says 未发现可核查名词 when a new report has an empty noun checklist', () => {
    const markdown = renderReportMarkdown(
      report({ nounChecks: [], summary: summary({ nounCheck: nounSummary() }) }),
      [article()],
    )
    expect(markdown).toContain('## 名词核查')
    expect(markdown).toContain('未发现可核查名词。')
    expect(markdown).not.toContain('| 名词 | 状态 |')
  })

  it('says the nouns were not checked when the nouns role failed', () => {
    const markdown = renderReportMarkdown(
      report({
        nounChecks: [],
        failedRoles: [failedRole({ role: 'nouns', error: 'provider refused' })],
        summary: summary({ nounCheck: nounSummary() }),
      }),
      [article()],
    )
    expect(markdown).toContain('## 未完成角色（未核查提示）')
    expect(markdown).toContain('名词核查')
    expect(nounSection(markdown)).toContain('名词核查角色未完成，不能视为未发现可核查名词。')
    // No standalone "未发现可核查名词。" empty-state line is rendered.
    expect(nounSection(markdown).split('\n').map((line) => line.trim())).not.toContain(
      '未发现可核查名词。',
    )
  })

  it('omits the noun section entirely for legacy reports without noun data', () => {
    const markdown = renderReportMarkdown(report(), [article()])
    expect(markdown).not.toContain('## 名词核查')
    expect(markdown).not.toContain('未发现可核查名词。')
  })

  it('escapes pipes and newlines in noun table cells', () => {
    const markdown = renderReportMarkdown(
      report({
        nounChecks: [
          nounCheck({ name: 'A|B', evidence: '第一行\n第二行' }),
        ],
        summary: summary({ nounCheck: nounSummary() }),
      }),
      [article()],
    )
    expect(markdown).toContain('| A\\|B |')
    expect(markdown).toContain('第一行 第二行')
    const row = lineWith(markdown, 'A\\|B')
    expect(row.startsWith('|')).toBe(true)
    expect(row.endsWith('|')).toBe(true)
    // 3 columns => 4 unescaped pipes.
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(4)
  })
})

describe('failed roles (Task 21f)', () => {
  /** The part of the document from the fact-checklist heading to the must-fix block. */
  function factSection(markdown: string): string {
    const start = markdown.indexOf('## 事实核查清单')
    expect(start, 'missing 事实核查清单 section').toBeGreaterThanOrEqual(0)
    return markdown.slice(start, markdown.indexOf('## 必须修改的条目'))
  }

  it('renders a prominent warning before the findings naming the article, role and error', () => {
    const markdown = renderReportMarkdown(report({ failedRoles: [failedRole()] }), [article()])
    const warning = markdown.indexOf('## 未完成角色')
    expect(warning).toBeGreaterThan(markdown.indexOf('# Ling Gao 校对员 · 校对报告'))
    expect(warning).toBeLessThan(markdown.indexOf('## 标题'))
    const section = markdown.slice(warning, markdown.indexOf('## 标题'))
    expect(section).toContain('未核查提示')
    expect(section).toContain('《标题》')
    expect(section).toContain('事实核查')
    expect(section).toContain('provider refused the request')
  })

  it('says the facts were not checked instead of 未发现可核查项 when facts failed', () => {
    const markdown = renderReportMarkdown(
      report({ failedRoles: [failedRole()], factChecks: [] }),
      [article()],
    )
    const facts = factSection(markdown)
    expect(facts).toContain('事实核查角色未完成，不能视为未发现可核查项。')
    expect(facts.split('\n')).not.toContain('未发现可核查项。')
  })

  it('keeps the normal empty fact state when only a non-facts role failed', () => {
    const markdown = renderReportMarkdown(
      report({
        failedRoles: [failedRole({ role: 'master', error: 'provider refused the request' })],
        factChecks: [],
      }),
      [article()],
    )
    expect(markdown).toContain('## 未完成角色（未核查提示）')
    expect(markdown).toContain('主审')
    const facts = factSection(markdown)
    expect(facts).toContain('未发现可核查项。')
    expect(facts).not.toContain('不能视为未发现可核查项')
  })

  it('falls back to the article id and tolerates a missing error message', () => {
    const markdown = renderReportMarkdown(
      report({
        failedRoles: [failedRole({ articleId: 'a9', role: 'consolidator', error: undefined })],
      }),
      [article()],
    )
    const section = markdown.slice(markdown.indexOf('## 未完成角色'), markdown.indexOf('## 标题'))
    expect(section).toContain('文章 a9')
    expect(section).toContain('汇总')
  })

  it('omits the warning section entirely when no role failed', () => {
    const markdown = renderReportMarkdown(report(), [article()])
    expect(markdown).not.toContain('## 未完成角色')
  })
})

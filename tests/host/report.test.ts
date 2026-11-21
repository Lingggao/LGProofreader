/**
 * Tests for the deterministic page-report assembly of the independent noun
 * checker (`src/host/proof/report.ts`, requirement: existence-only checklist).
 *
 * The report builder is pure, so these tests call it directly with fixture
 * articles and verify the noun-specific contract: per-article plan order, the
 * `articleId`-prefixed ids, the summary counts and the backwards-compatible
 * `[]`/absent defaults for reports/callers that predate the nouns role.
 */
import { describe, expect, it } from 'vitest'
import { buildReport, type BuildReportInput } from '../../src/host/proof/report'
import type { Article, NounCheck } from '../../src/shared/types'

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    page: 1,
    role: 'lead',
    title: '标题甲',
    body: '正文',
    regionIds: [],
    readingOrder: 1,
    confidence: 1,
    warnings: [],
    ...overrides,
  }
}

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

function baseInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    jobId: 'job_1',
    docId: 'doc_1',
    depth: 'standard',
    factCheckMode: 'on',
    model: 'deepseek-official/deepseek-flash',
    promptVersion: 'pv1',
    createdAt: 1,
    articles: [],
    stats: { calls: 0, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 0 },
    ...overrides,
  }
}

describe('buildReport noun checks', () => {
  it('lists noun checks in article/plan order with article-prefixed ids', () => {
    const report = buildReport(
      baseInput({
        articles: [
          {
            article: article({ id: 'a1', title: '第一篇' }),
            findings: [],
            factChecks: [],
            nounChecks: [
              nounCheck({ id: 'noun1', name: '甲名词', priority: 1 }),
              nounCheck({ id: 'noun2', name: '乙名词', priority: 2, status: 'uncertain' }),
            ],
          },
          {
            article: article({ id: 'a2', title: '第二篇' }),
            findings: [],
            factChecks: [],
            nounChecks: [nounCheck({ id: 'noun1', name: '丙名词', status: 'not_checked' })],
          },
        ],
      }),
    )

    expect(report.nounChecks?.map((check) => check.name)).toEqual(['甲名词', '乙名词', '丙名词'])
    expect(report.nounChecks?.map((check) => check.id)).toEqual([
      'a1:noun1',
      'a1:noun2',
      'a2:noun1',
    ])
    expect(report.nounChecks?.map((check) => check.articleId)).toEqual(['a1', 'a1', 'a2'])
    expect(report.summary.nounCheck).toEqual({
      exists: 1,
      uncertain: 1,
      notFound: 0,
      notChecked: 1,
    })
    // The noun list never becomes findings.
    expect(report.findings).toEqual([])
  })

  it('counts every existence status and defaults absent nounChecks to an empty list', () => {
    const report = buildReport(
      baseInput({
        articles: [
          {
            article: article(),
            findings: [],
            factChecks: [],
            // `nounChecks` omitted on purpose: old callers/fixtures still compile.
          },
        ],
      }),
    )
    expect(report.nounChecks).toEqual([])
    expect(report.summary.nounCheck).toEqual({
      exists: 0,
      uncertain: 0,
      notFound: 0,
      notChecked: 0,
    })

    const counted = buildReport(
      baseInput({
        articles: [
          {
            article: article(),
            findings: [],
            factChecks: [],
            nounChecks: [
              nounCheck({ id: 'noun1', status: 'exists' }),
              nounCheck({ id: 'noun2', status: 'uncertain' }),
              nounCheck({ id: 'noun3', status: 'not_found' }),
              nounCheck({ id: 'noun4', status: 'not_checked' }),
            ],
          },
        ],
      }),
    )
    expect(counted.summary.nounCheck).toEqual({
      exists: 1,
      uncertain: 1,
      notFound: 1,
      notChecked: 1,
    })
    expect(counted.nounChecks?.map((check) => check.id)).toEqual([
      'a1:noun1',
      'a1:noun2',
      'a1:noun3',
      'a1:noun4',
    ])
  })
})

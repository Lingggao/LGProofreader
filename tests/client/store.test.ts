/**
 * Workbench reducer contract (Task 17; design §9.3).
 *
 * The two first cases are the brief's binding fixtures: loading a document must
 * never auto-select an article (design §9.4: proofreading only starts from an
 * explicit selection), and a selection change is stored verbatim.
 *
 * The remaining cases pin the durable phase machine the later UI tasks (18/19)
 * build on: `documentLoaded`/`layoutLoaded` end at `ready`, layout job updates
 * move through `analyzing`, proofreading job updates move through
 * `proofreading` to `report`, failures end at `failed`, and `reset` returns a
 * fresh empty workbench.
 */
import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type ClientState } from '../../src/client/state/store'
import type { JobView } from '../../src/shared/api/protocol'
import type { Article, DocumentMeta, Region, Report } from '../../src/shared/types'

const DOCUMENT: DocumentMeta = {
  id: 'doc_1',
  fileName: '文汇报 2026-11-14 第14版.pdf',
  pageCount: 1,
  createdAt: 1_760_000_000_000,
  status: 'ready',
}

const ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'lead',
  title: '头条',
  body: '正文',
  regionIds: ['r1'],
  readingOrder: 0,
  confidence: 0.9,
  warnings: [],
}

const SECOND_ARTICLE: Article = { ...ARTICLE, id: 'a2', role: 'second', title: '二条', readingOrder: 1 }

const REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 10, y: 20, w: 100, h: 60 },
  lineIds: ['l1'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const LAYOUT_JOB: JobView = {
  id: 'job_1',
  kind: 'layout',
  status: 'done',
  progress: 1,
  stages: [],
  result: { regions: [REGION], articles: [ARTICLE] },
}

function layoutJob(status: JobView['status']): JobView {
  return { ...LAYOUT_JOB, status }
}

const PROOFREAD_JOB: JobView = {
  id: 'job_2',
  kind: 'proofread',
  status: 'running',
  progress: 0.5,
  stages: [],
}

const REPORT: Report = {
  jobId: 'job_2',
  docId: 'doc_1',
  articleIds: ['a1'],
  createdAt: 1_760_000_100_000,
  model: 'deepseek-flash',
  promptVersion: 'abc123',
  depth: 'standard',
  summary: {
    mustFixCount: 0,
    suggestedCount: 0,
    optionalCount: 0,
    factCheck: { confirmed: 0, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
    byCategory: {},
    mustFixList: [],
  },
  findings: [],
  factChecks: [],
  stats: { calls: 0, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 1 },
}

/** A workbench state with one document and two articles but no selection. */
function loadedState(): ClientState {
  return reduce(createInitialState(), {
    type: 'documentLoaded',
    document: DOCUMENT,
    articles: [ARTICLE, SECOND_ARTICLE],
    regions: [REGION],
  })
}

describe('createInitialState', () => {
  it('starts empty with no document, articles, selection or job', () => {
    const state = createInitialState()
    expect(state.phase).toBe('empty')
    expect(state.document).toBeNull()
    expect(state.articles).toEqual([])
    expect(state.regions).toEqual([])
    expect(state.selectedArticleIds).toEqual([])
    expect(state.warnings).toEqual([])
    expect(state.job).toBeNull()
    expect(state.report).toBeNull()
    expect(state.error).toBeNull()
  })

  it('returns a fresh, independent state on every call', () => {
    const first = createInitialState()
    const second = createInitialState()
    expect(first).not.toBe(second)
    expect(first.articles).not.toBe(second.articles)
    expect(first.selectedArticleIds).not.toBe(second.selectedArticleIds)
  })
})

describe('documentLoaded', () => {
  it('never auto-selects articles on document load', () => {
    const state = reduce(createInitialState(), {
      type: 'documentLoaded',
      document: { id: 'd1' } as never,
      articles: [{ id: 'a1' }, { id: 'a2' }] as never,
    })
    expect(state.selectedArticleIds).toEqual([])
    expect(state.phase).toBe('ready')
  })

  it('stores the document, articles and regions and clears stale work', () => {
    const withJob = reduce(loadedState(), { type: 'jobUpdated', job: PROOFREAD_JOB })
    const state = reduce(withJob, {
      type: 'documentLoaded',
      document: DOCUMENT,
      articles: [SECOND_ARTICLE],
      regions: [REGION],
    })
    expect(state.document).toBe(DOCUMENT)
    expect(state.articles).toEqual([SECOND_ARTICLE])
    expect(state.regions).toEqual([REGION])
    expect(state.selectedArticleIds).toEqual([])
    expect(state.job).toBeNull()
    expect(state.report).toBeNull()
    expect(state.error).toBeNull()
    expect(state.phase).toBe('ready')
  })

  it('keeps analyzing while the uploaded document is still parsing', () => {
    const state = reduce(createInitialState(), {
      type: 'documentLoaded',
      document: { ...DOCUMENT, status: 'parsing' },
      articles: [],
    })
    expect(state.phase).toBe('analyzing')
  })

  it('clears an explicit selection when another document is loaded', () => {
    const selected = reduce(loadedState(), { type: 'selectionChanged', ids: ['a1'] })
    expect(selected.selectedArticleIds).toEqual(['a1'])
    const state = reduce(selected, {
      type: 'documentLoaded',
      document: { ...DOCUMENT, id: 'doc_2' },
      articles: [SECOND_ARTICLE],
    })
    expect(state.selectedArticleIds).toEqual([])
    expect(state.articles).toEqual([SECOND_ARTICLE])
  })

  it('reflects a document loaded in failed state', () => {
    const state = reduce(createInitialState(), {
      type: 'documentLoaded',
      document: { ...DOCUMENT, status: 'failed' },
      articles: [],
    })
    expect(state.phase).toBe('failed')
  })
})

describe('layoutLoaded', () => {
  it('marks the layout ready without selecting anything', () => {
    const analyzing = reduce(createInitialState(), {
      type: 'documentLoaded',
      document: { ...DOCUMENT, status: 'parsing' },
      articles: [],
    })
    const state = reduce(analyzing, {
      type: 'layoutLoaded',
      regions: [REGION],
      articles: [ARTICLE, SECOND_ARTICLE],
      warnings: ['2 处低置信区块'],
    })
    expect(state.phase).toBe('ready')
    expect(state.articles).toEqual([ARTICLE, SECOND_ARTICLE])
    expect(state.regions).toEqual([REGION])
    expect(state.warnings).toEqual(['2 处低置信区块'])
    expect(state.selectedArticleIds).toEqual([])
    expect(state.document?.status).toBe('ready')
  })

  it('keeps an explicit selection when a layout refresh arrives', () => {
    const selected = reduce(loadedState(), { type: 'selectionChanged', ids: ['a1'] })
    const state = reduce(selected, { type: 'layoutLoaded', articles: [ARTICLE, SECOND_ARTICLE] })
    expect(state.phase).toBe('ready')
    expect(state.selectedArticleIds).toEqual(['a1'])
  })
})

describe('selectionChanged', () => {
  it('tracks article selection', () => {
    const state = reduce(createInitialState(), { type: 'selectionChanged', ids: ['a1'] })
    expect(state.selectedArticleIds).toEqual(['a1'])
  })

  it('de-duplicates ids and skips empty values, even before articles load', () => {
    const state = reduce(createInitialState(), {
      type: 'selectionChanged',
      ids: ['a1', '', 'a1', 'a2'],
    })
    expect(state.selectedArticleIds).toEqual(['a1', 'a2'])
  })
})

describe('jobUpdated', () => {
  it('moves a layout job from analyzing to ready and back', () => {
    expect(reduce(createInitialState(), { type: 'jobUpdated', job: layoutJob('queued') }).phase).toBe(
      'analyzing',
    )
    expect(reduce(createInitialState(), { type: 'jobUpdated', job: layoutJob('running') }).phase).toBe(
      'analyzing',
    )
    expect(reduce(createInitialState(), { type: 'jobUpdated', job: layoutJob('done') }).phase).toBe(
      'ready',
    )
    expect(reduce(createInitialState(), { type: 'jobUpdated', job: layoutJob('failed') }).phase).toBe(
      'failed',
    )
    expect(loadedState().phase).toBe('ready')
  })

  it('records the job snapshot verbatim', () => {
    const state = reduce(createInitialState(), { type: 'jobUpdated', job: PROOFREAD_JOB })
    expect(state.job).toBe(PROOFREAD_JOB)
  })

  it('runs a proofreading job through proofreading to report', () => {
    const running = reduce(loadedState(), { type: 'jobUpdated', job: PROOFREAD_JOB })
    expect(running.phase).toBe('proofreading')
    const done = reduce(running, { type: 'jobUpdated', job: { ...PROOFREAD_JOB, status: 'done' } })
    expect(done.phase).toBe('report')
  })

  it('ends at failed with the job error on a failed job', () => {
    const state = reduce(loadedState(), {
      type: 'jobUpdated',
      job: { ...PROOFREAD_JOB, status: 'failed', error: '模型调用失败' },
    })
    expect(state.phase).toBe('failed')
    expect(state.error).toBe('模型调用失败')
  })

  it('returns a cancelled layout job to ready (empty without a document)', () => {
    const cancelled = { ...layoutJob('cancelled') }
    expect(reduce(loadedState(), { type: 'jobUpdated', job: cancelled }).phase).toBe('ready')
    expect(reduce(createInitialState(), { type: 'jobUpdated', job: cancelled }).phase).toBe('empty')
  })

  it('returns a cancelled proofread job to ready without a report', () => {
    const state = reduce(loadedState(), {
      type: 'jobUpdated',
      job: { ...PROOFREAD_JOB, status: 'cancelled' },
    })
    expect(state.phase).toBe('ready')
    expect(state.report).toBeNull()
  })
})

describe('reportLoaded', () => {
  it('stores the report and switches to the report phase', () => {
    const state = reduce(loadedState(), { type: 'reportLoaded', report: REPORT })
    expect(state.report).toBe(REPORT)
    expect(state.phase).toBe('report')
    expect(state.error).toBeNull()
  })
})

describe('errorSet', () => {
  it('stays on the empty screen for an inline upload error', () => {
    const state = reduce(createInitialState(), { type: 'errorSet', error: '不是有效的 PDF' })
    expect(state.error).toBe('不是有效的 PDF')
    expect(state.phase).toBe('empty')
  })

  it('shows the failure screen once a document exists', () => {
    const state = reduce(loadedState(), { type: 'errorSet', error: '版面分析失败' })
    expect(state.error).toBe('版面分析失败')
    expect(state.phase).toBe('failed')
  })
})

describe('reset', () => {
  it('returns to a fresh empty workbench', () => {
    const selected = reduce(loadedState(), { type: 'selectionChanged', ids: ['a1'] })
    const failed = reduce(selected, { type: 'errorSet', error: 'x' })
    expect(reduce(failed, { type: 'reset' })).toEqual(createInitialState())
  })
})

describe('reducer purity', () => {
  it('never mutates the previous state or its collections', () => {
    const before = loadedState()
    const beforeArticles = before.articles
    const beforeSelection = before.selectedArticleIds
    const next = reduce(before, { type: 'selectionChanged', ids: ['a1'] })
    expect(before.articles).toBe(beforeArticles)
    expect(before.selectedArticleIds).toBe(beforeSelection)
    expect(before.selectedArticleIds).toEqual([])
    expect(next.selectedArticleIds).toEqual(['a1'])
    expect(next).not.toBe(before)
  })
})

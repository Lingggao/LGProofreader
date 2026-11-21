/**
 * Tests for the job orchestrator (`src/host/proof/orchestrator.ts`) and its two
 * seams (`src/host/proof/roles.ts`, `src/host/proof/report.ts`).
 *
 * Every external service (LLM, web, prompts, store, layout analyzer) is faked as
 * a plain object so the real orchestration logic runs end to end: job state,
 * progress, concurrency, role failure isolation, retry, depth role sets,
 * fact-check integration, deterministic report building, caching and
 * cancellation (design §7.5/§7.6, Review Focus 5).
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  Article,
  CandidateBlock,
  DocumentRecord,
  FactCheck,
  Finding,
  PromptLibrary,
  Report,
  RoleId,
  TextLine,
} from '../../src/shared/types'
import { fallbackVisionLayout, type VisionLayout } from '../../src/shared/layout/vision-schema'
import type { LayoutAnalyzer, LayoutAnalyzerInput } from '../../src/host/layout/analyzer'
import type { LlmClient, LlmRequest, LlmResult } from '../../src/host/services/llm-client'
import type { DocumentStore } from '../../src/host/services/store'
import type { WebClient, WebFetchResult, WebSearchRequest, WebSearchResult } from '../../src/host/services/web-client'
import {
  DEFAULT_PER_CALL_TIMEOUT_MS,
  FACTS_PER_CALL_TIMEOUT_MS,
  NOUN_PER_CALL_TIMEOUT_MS,
  JobCancelledError,
  createJobOrchestrator,
  type JobState,
  type OrchestratorDeps,
} from '../../src/host/proof/orchestrator'
import {
  ROLE_REASONING_EFFORT,
  articleCacheText,
  factBudgetForDepth,
  nounBudgetForDepth,
  roleCacheKey,
  rolesForDepth,
} from '../../src/host/proof/roles'

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* ------------------------------------------------------------------------- */

const DOC_ID = 'doc_1700000000000_abcdef'
const PROMPT_VERSION = 'pv1'
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'
const ROUTE_LABEL = `${PROVIDER}/${MODEL}`
const QUOTE = '错误'
const ARTICLE_BODY = '本报讯 记者张三报道，这是错误的内容。'

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    page: 1,
    role: 'lead',
    title: '标题甲',
    body: ARTICLE_BODY,
    regionIds: ['r1'],
    readingOrder: 1,
    confidence: 0.9,
    warnings: [],
    ...overrides,
  }
}

const LINE: TextLine = {
  id: 'l1',
  text: '标题甲',
  bbox: { x: 10, y: 10, w: 100, h: 20 },
  fontSize: 24,
  fontWeight: 700,
  baseline: 10,
  column: 0,
}

const CANDIDATE: CandidateBlock = {
  candidateId: 'c1',
  bbox: { x: 10, y: 10, w: 100, h: 20 },
  lineIds: ['l1'],
  fontSizeBand: 'headline',
  firstLineText: '标题甲',
  lineCount: 1,
}

const VISION: VisionLayout = {
  pageType: 'news',
  regions: [
    { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 0.9 },
  ],
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
}

function makeDoc(
  articles: Article[] = [makeArticle()],
  overrides: Partial<DocumentRecord> = {},
): DocumentRecord {
  return {
    meta: {
      id: DOC_ID,
      fileName: 'page.pdf',
      pageCount: 1,
      createdAt: 1,
      status: 'ready',
    },
    lines: [LINE],
    candidates: [CANDIDATE],
    widthPt: 600,
    heightPt: 800,
    regions: [],
    articles,
    reportIds: [],
    ...overrides,
  }
}

/* ------------------------------------------------------------------------- */
/* Store fake                                                                  */
/* ------------------------------------------------------------------------- */

interface StoreFixture {
  store: DocumentStore
  getDocument: ReturnType<typeof vi.fn>
  getPageOverlay: ReturnType<typeof vi.fn>
  saveLayout: ReturnType<typeof vi.fn>
  saveReport: ReturnType<typeof vi.fn>
  saveRoleResult: ReturnType<typeof vi.fn>
  getRoleResults: ReturnType<typeof vi.fn>
  updateMeta: ReturnType<typeof vi.fn>
  layoutSaves: Array<{ docId: string; regions: unknown[]; articles: unknown[] }>
  reports: Report[]
  roleSaves: Array<{
    docId: string
    jobId: string
    articleId: string
    role: string
    value: unknown
  }>
  roleResults: Map<string, Record<string, unknown>>
  /** Seed one completed job (report id + role files) without running the model. */
  seedCompletedJob(jobId: string, articleId: string, roles: Record<string, unknown>): void
}

/**
 * Minimal in-memory store. Role results are keyed by job id + article id and
 * completed jobs are appended to the document's `reportIds`, so a fresh
 * orchestrator can reload persisted role results exactly like the real store.
 */
function makeStore(
  doc: DocumentRecord | undefined,
  options: { overlay?: Uint8Array } = {},
): StoreFixture {
  const overlay = 'overlay' in options ? options.overlay : new Uint8Array([9, 9])
  /** `${jobId}\u0000${articleId}` → role → value. */
  const roleResults = new Map<string, Record<string, unknown>>()
  const reportedJobIds: string[] = []
  const layoutSaves: StoreFixture['layoutSaves'] = []
  const reports: Report[] = []
  const roleSaves: StoreFixture['roleSaves'] = []

  const jobRolesKey = (jobId: string, articleId: string): string =>
    `${jobId}\u0000${articleId}`

  const getDocument = vi.fn(async (id: string) => {
    if (doc === undefined || doc.meta.id !== id) return undefined
    return { ...doc, reportIds: [...(doc.reportIds ?? []), ...reportedJobIds] }
  })
  const getPageOverlay = vi.fn(async (id: string) =>
    doc !== undefined && doc.meta.id === id ? overlay : undefined,
  )
  const saveLayout = vi.fn(async (docId: string, layout: { regions: unknown[]; articles: unknown[] }) => {
    layoutSaves.push({ docId, regions: layout.regions, articles: layout.articles })
  })
  const saveReport = vi.fn(async (_docId: string, report: Report) => {
    reports.push(report)
    if (!reportedJobIds.includes(report.jobId)) reportedJobIds.push(report.jobId)
  })
  const saveRoleResult = vi.fn(
    async (
      docId: string,
      jobId: string,
      articleId: string,
      role: string,
      value: unknown,
    ) => {
      roleSaves.push({ docId, jobId, articleId, role, value })
      const key = jobRolesKey(jobId, articleId)
      const current = roleResults.get(key) ?? {}
      roleResults.set(key, { ...current, [role]: value })
    },
  )
  const getRoleResults = vi.fn(async (_docId: string, jobId: string, articleId: string) => ({
    ...(roleResults.get(jobRolesKey(jobId, articleId)) ?? {}),
  }))
  const updateMeta = vi.fn(async (_id: string, patch: Partial<DocumentRecord['meta']>) =>
    doc === undefined ? undefined : { ...doc.meta, ...patch },
  )

  const seedCompletedJob = (
    jobId: string,
    articleId: string,
    roles: Record<string, unknown>,
  ): void => {
    if (!reportedJobIds.includes(jobId)) reportedJobIds.push(jobId)
    roleResults.set(jobRolesKey(jobId, articleId), { ...roles })
  }

  return {
    store: {
      getDocument,
      getPageOverlay,
      saveLayout,
      saveReport,
      saveRoleResult,
      getRoleResults,
      updateMeta,
    } as unknown as DocumentStore,
    getDocument,
    getPageOverlay,
    saveLayout,
    saveReport,
    saveRoleResult,
    getRoleResults,
    updateMeta,
    layoutSaves,
    reports,
    roleSaves,
    roleResults,
    seedCompletedJob,
  }
}

/* ------------------------------------------------------------------------- */
/* Prompt / LLM / web / analyzer fakes                                         */
/* ------------------------------------------------------------------------- */

interface PromptFixture {
  prompts: PromptLibrary
  compose: ReturnType<typeof vi.fn>
}

/** Fake prompt library: marker text plus the article id/title for dispatch. */
function makePrompts(version = PROMPT_VERSION): PromptFixture {
  const compose = vi.fn((role: RoleId, input: { article: Article; context: string }) => ({
    system: `SYSTEM-${role.toUpperCase()}`,
    user: `USER-${role} article=${input.article.id} title=${input.article.title}`,
  }))
  return {
    compose,
    prompts: { version, roles: [], compose } as unknown as PromptLibrary,
  }
}

function roleOfSystem(system: string): string | undefined {
  const match = /^SYSTEM-([A-Z]+)$/.exec(system)
  return match === null ? undefined : match[1].toLowerCase()
}

function userText(request: LlmRequest): string {
  return request.messages
    .flatMap((message) => message.content)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const FINDING_PAYLOAD = {
  category: 'typo',
  severity: 'must_fix',
  quote: QUOTE,
  issue: '错别字',
  suggestion: '正确',
  confidence: 'high',
  needs_human: false,
}

/** Reply for the fake prompt markers; unknown roles get one located finding. */
function defaultReply(request: LlmRequest): string {
  const role = roleOfSystem(request.system)
  if (role === 'facts') {
    return userText(request).includes('第一阶段')
      ? JSON.stringify({ claims: [] })
      : JSON.stringify({ verdicts: [] })
  }
  // The independent nouns role only plans names/queries; the fake plan is empty
  // so it performs no network searches in the text-role tests.
  if (role === 'nouns') return JSON.stringify({ nouns: [] })
  if (role === 'consolidator') return JSON.stringify({ findings: [], notes: '' })
  return JSON.stringify({ findings: [FINDING_PAYLOAD] })
}

type LlmHandler = (
  request: LlmRequest,
  signal: AbortSignal,
  callIndex: number,
) => string | Promise<string>

interface LlmFixture {
  llm: LlmClient
  complete: ReturnType<typeof vi.fn>
  calls: LlmRequest[]
}

function makeLlm(
  handler: LlmHandler = (request) => defaultReply(request),
  usage?: { inputTokens: number; outputTokens: number },
): LlmFixture {
  const calls: LlmRequest[] = []
  const complete = vi.fn(async (request: LlmRequest, signal: AbortSignal) => {
    calls.push(request)
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    const text = await handler(request, signal, calls.length - 1)
    const result: LlmResult = { text }
    if (usage !== undefined) result.usage = { ...usage }
    return result
  })
  return { llm: { complete } as LlmClient, complete, calls }
}

interface WebFixture {
  web: WebClient
  search: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
}

function makeWeb(
  handlers: {
    search?: (request: WebSearchRequest, signal: AbortSignal) => WebSearchResult | Promise<WebSearchResult>
    fetch?: (
      request: { url: string },
      signal: AbortSignal,
    ) => WebFetchResult | Promise<WebFetchResult>
  } = {},
): WebFixture {
  const search = vi.fn(
    async (request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> => {
      if (handlers.search !== undefined) return handlers.search(request, signal)
      return { content: '', sources: [], truncated: false }
    },
  )
  const fetch = vi.fn(
    async (request: { url: string }, signal: AbortSignal): Promise<WebFetchResult> => {
      if (handlers.fetch !== undefined) return handlers.fetch(request, signal)
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: '' }, truncated: false }
    },
  )
  return { web: { search, fetch } as WebClient, search, fetch }
}

interface AnalyzerFixture {
  analyzer: LayoutAnalyzer
  analyze: ReturnType<typeof vi.fn>
}

function makeAnalyzer(
  handler: (input: LayoutAnalyzerInput, signal: AbortSignal) => Promise<VisionLayout> = async () =>
    VISION,
): AnalyzerFixture {
  const analyze = vi.fn(handler)
  return { analyzer: { analyze } as LayoutAnalyzer, analyze }
}

/* ------------------------------------------------------------------------- */
/* Dependency assembly                                                         */
/* ------------------------------------------------------------------------- */

interface DepsOptions {
  store?: StoreFixture
  llm?: LlmFixture
  prompts?: PromptFixture
  analyzer?: AnalyzerFixture
  web?: WebFixture
  now?: () => number
  concurrency?: number
  model?: { provider: string; model: string }
  perCallTimeoutMs?: number
  /** Presence signal for the optional `web` service (defaults to true). */
  webAvailable?: boolean
}

interface DepsFixture {
  deps: OrchestratorDeps
  store: StoreFixture
  llm: LlmFixture
  prompts: PromptFixture
  analyzer: AnalyzerFixture
  web: WebFixture
}

function makeDeps(options: DepsOptions = {}): DepsFixture {
  const store = options.store ?? makeStore(makeDoc())
  const llm = options.llm ?? makeLlm()
  const prompts = options.prompts ?? makePrompts()
  const analyzer = options.analyzer ?? makeAnalyzer()
  const web = options.web ?? makeWeb()
  let tick = 1_000
  const deps: OrchestratorDeps = {
    llm: llm.llm,
    web: web.web,
    prompts: prompts.prompts,
    store: store.store,
    analyzer: analyzer.analyzer,
    now: options.now ?? (() => (tick += 1)),
    concurrency: options.concurrency ?? 2,
    model: options.model ?? { provider: PROVIDER, model: MODEL },
    ...(options.perCallTimeoutMs !== undefined
      ? { perCallTimeoutMs: options.perCallTimeoutMs }
      : {}),
    ...(options.webAvailable !== undefined ? { webAvailable: options.webAvailable } : {}),
  }
  return { deps, store, llm, prompts, analyzer, web }
}

async function waitForStatus(
  orchestrator: ReturnType<typeof createJobOrchestrator>,
  jobId: string,
  status: JobState['status'],
): Promise<JobState> {
  await vi.waitFor(() => expect(orchestrator.get(jobId)?.status).toBe(status), {
    timeout: 5_000,
  })
  return orchestrator.get(jobId) as JobState
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function roleCalls(llm: LlmFixture, role: RoleId): LlmRequest[] {
  return llm.calls.filter((request) => roleOfSystem(request.system) === role)
}

/* ------------------------------------------------------------------------- */
/* Layout jobs                                                                 */
/* ------------------------------------------------------------------------- */

describe('layout jobs', () => {
  it('loads the page, runs the analyzer, assembles articles and saves the layout', async () => {
    const store = makeStore(makeDoc([]))
    const analyzer = makeAnalyzer()
    const { deps } = makeDeps({ store, analyzer })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    expect(jobId).toMatch(/^job_[a-z0-9_]+$/)

    const state = await waitForStatus(orchestrator, jobId, 'done')
    expect(state.kind).toBe('layout')
    expect(analyzer.analyze).toHaveBeenCalledTimes(1)

    const input = analyzer.analyze.mock.calls[0][0] as LayoutAnalyzerInput
    expect(input.candidates).toEqual([CANDIDATE])
    expect(input.page).toEqual({ widthPt: 600, heightPt: 800 })
    expect(input.overlayPng).toEqual(new Uint8Array([9, 9]))

    expect(store.saveLayout).toHaveBeenCalledTimes(1)
    const saved = store.layoutSaves[0]
    expect(saved.docId).toBe(DOC_ID)
    expect(saved.regions).toHaveLength(1)
    expect(saved.articles).toHaveLength(1)
    expect((saved.articles[0] as Article).id).toBe('a1')

    expect(state.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done'])
    expect(state.progress).toBe(1)
    expect(state.result).toEqual(
      expect.objectContaining({ regions: expect.any(Array), articles: expect.any(Array) }),
    )
  })

  it('stores a fallback layout and surfaces the vision warnings in the job result', async () => {
    const store = makeStore(makeDoc([]))
    const fallback = fallbackVisionLayout([CANDIDATE])
    const analyzer = makeAnalyzer(async () => ({
      ...fallback,
      warnings: [...fallback.warnings, 'vision-timeout'],
    }))
    const { deps } = makeDeps({ store, analyzer })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    // A degraded layout is still a stored `ready` layout: every stage finished,
    // progress is complete and the fallback articles were saved.
    expect(state.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done'])
    expect(state.progress).toBe(1)
    expect(store.saveLayout).toHaveBeenCalledTimes(1)
    expect((state.result as { articles: Article[] }).articles).toHaveLength(1)

    // The analyzer's warnings (vision-fallback/vision-timeout) must reach the
    // Client warning count; otherwise a degraded page looks like a clean one.
    expect((state.result as { warnings: string[] }).warnings).toEqual(
      expect.arrayContaining(['vision-fallback', 'vision-timeout']),
    )
  })

  it('fails the job and marks the document failed when the analyzer throws', async () => {
    const store = makeStore(makeDoc([]))
    const analyzer = makeAnalyzer(async () => {
      throw new Error('vision exploded')
    })
    const { deps } = makeDeps({ store, analyzer })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    const state = await waitForStatus(orchestrator, jobId, 'failed')

    expect(state.error).toContain('vision exploded')
    expect(state.stages.find((stage) => stage.id === 'analyze')?.status).toBe('failed')
    expect(store.saveLayout).not.toHaveBeenCalled()
    expect(store.updateMeta).toHaveBeenCalledWith(DOC_ID, { status: 'failed' })
  })

  it('fails the job when the document does not exist', async () => {
    const store = makeStore(undefined)
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    const state = await waitForStatus(orchestrator, jobId, 'failed')

    expect(state.error).toBeTruthy()
    expect(store.saveLayout).not.toHaveBeenCalled()
    expect(store.updateMeta).not.toHaveBeenCalled()
  })

  it('fails the job when candidates exist but the overlay image is missing', async () => {
    const store = makeStore(makeDoc([]), { overlay: undefined })
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    const state = await waitForStatus(orchestrator, jobId, 'failed')

    expect(state.error).toContain('叠加图')
    expect(store.saveLayout).not.toHaveBeenCalled()
  })

  it('cancels a running analysis, keeps progress below one and never saves the layout', async () => {
    const store = makeStore(makeDoc([]))
    let analyzerCalled = false
    const analyzer = makeAnalyzer(
      (_input, signal) =>
        new Promise<VisionLayout>((_resolve, reject) => {
          analyzerCalled = true
          const abort = (): void => reject(signal.reason ?? new JobCancelledError('cancelled'))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
    )
    const { deps } = makeDeps({ store, analyzer })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    await vi.waitFor(() => expect(analyzerCalled).toBe(true))

    expect(orchestrator.cancel(jobId)).toBe(true)
    expect(orchestrator.get(jobId)?.status).toBe('cancelled')
    expect(orchestrator.get(jobId)?.progress).toBeCloseTo(0.25)

    await delay(20)
    expect(orchestrator.get(jobId)?.status).toBe('cancelled')
    expect(orchestrator.get(jobId)?.stages.some((stage) => stage.status === 'running')).toBe(false)
    expect(store.saveLayout).not.toHaveBeenCalled()
    expect(orchestrator.cancel(jobId)).toBe(false)
  })
})

/* ------------------------------------------------------------------------- */
/* Depth role sets, failure isolation, retry                                   */
/* ------------------------------------------------------------------------- */

describe('proofread role execution', () => {
  const DEPTH_CASES: Array<[string, RoleId[]]> = [
    ['quick', ['master', 'facts', 'nouns', 'words']],
    ['standard', ['master', 'facts', 'nouns', 'words', 'idioms', 'style', 'headline']],
    [
      'deep',
      ['master', 'facts', 'nouns', 'words', 'idioms', 'style', 'headline', 'consistency'],
    ],
  ]

  it.each(DEPTH_CASES)('runs the %s depth role set plus the consolidator', async (depth, expected) => {
    const store = makeStore(makeDoc())
    const prompts = makePrompts()
    const { deps } = makeDeps({ store, prompts })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: depth as 'quick' | 'standard' | 'deep',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    const composedRoles = [...new Set(prompts.compose.mock.calls.map((call) => call[0] as RoleId))]
    expect(composedRoles.filter((role) => role !== 'consolidator').sort()).toEqual(
      [...expected].sort(),
    )
    expect(composedRoles).toContain('consolidator')

    const stageIds = state.stages.map((stage) => stage.id)
    for (const role of expected) expect(stageIds).toContain(`a1:${role}`)
    expect(stageIds).toContain('a1:consolidator')

    const report = state.result as Report
    expect(report.depth).toBe(depth)
    expect(report.articleIds).toEqual(['a1'])
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.findings.every((finding) => finding.id.startsWith('a1:'))).toBe(true)
  })

  it('keeps the job running when one role fails (brief acceptance)', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'idioms') throw new Error('role failed')
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(state.status).toBe('done')
    const idiomsStage = state.stages.find((stage) => stage.id === 'a1:idioms')
    expect(idiomsStage?.status).toBe('failed')
    expect(idiomsStage?.error).toContain('role failed')
    expect(state.stages.find((stage) => stage.id === 'a1:master')?.status).toBe('done')
    expect(state.stages.find((stage) => stage.id === 'a1:consolidator')?.status).toBe('done')

    // The role failure was retried once (design §7.5: 失败重试 1 次).
    expect(roleCalls(llm, 'idioms')).toHaveLength(2)

    expect(store.reports).toHaveLength(1)
    expect(store.reports[0].findings.length).toBeGreaterThan(0)
  })

  it('records failed roles in the report instead of silently treating them as empty (Task 21f)', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'master') throw new Error('provider refused: content safety')
      if (role === 'facts') throw new Error('provider refused: content safety')
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: true,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    const report = state.result as Report
    expect(report.factCheckMode).toBe('on')
    expect(report.factChecks).toEqual([])
    expect(report.failedRoles).toEqual([
      {
        articleId: 'a1',
        role: 'master',
        error: expect.stringContaining('provider refused: content safety'),
      },
      {
        articleId: 'a1',
        role: 'facts',
        error: expect.stringContaining('provider refused: content safety'),
      },
    ])
    // The report is still persisted with the same explicit failed-role list.
    expect(store.reports).toHaveLength(1)
    expect(store.reports[0].failedRoles).toEqual(report.failedRoles)
  })

  it('omits failedRoles for a run in which every role finished', async () => {
    const store = makeStore(makeDoc())
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect((state.result as Report).failedRoles).toBeUndefined()
  })

  it('retries a failed role once and keeps its findings when the retry succeeds', async () => {
    const store = makeStore(makeDoc())
    let attempts = 0
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) !== 'master') return defaultReply(request)
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return JSON.stringify({ findings: [FINDING_PAYLOAD] })
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(state.stages.find((stage) => stage.id === 'a1:master')?.status).toBe('done')
    expect(roleCalls(llm, 'master')).toHaveLength(2)
    expect((state.result as Report).findings.some((finding) => finding.issue === '错别字')).toBe(
      true,
    )
  })

  it('marks a role failed for non-Error thrown values without hanging', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'words') throw 'weird failure'
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    const wordsStage = state.stages.find((stage) => stage.id === 'a1:words')
    expect(wordsStage?.status).toBe('failed')
    expect(wordsStage?.error).toContain('weird failure')
  })

  it('fails the job without hanging when loading the document throws', async () => {
    const store = makeStore(makeDoc())
    store.getDocument.mockRejectedValue(new Error('disk on fire'))
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'failed')

    expect(state.error).toContain('disk on fire')
    expect(store.reports).toHaveLength(0)
  })

  it('fails the job when a requested article does not exist', async () => {
    const store = makeStore(makeDoc())
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1', 'a9'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'failed')

    expect(state.error).toContain('a9')
    expect(store.reports).toHaveLength(0)
  })

  it('rejects invalid start inputs before creating a job', async () => {
    const { deps } = makeDeps()
    const orchestrator = createJobOrchestrator(deps)

    await expect(
      orchestrator.startProofread({
        docId: DOC_ID,
        articleIds: [],
        depth: 'quick',
        factCheck: false,
      }),
    ).rejects.toThrow()
    await expect(
      orchestrator.startProofread({
        docId: DOC_ID,
        articleIds: ['a1'],
        depth: 'maximal' as never,
        factCheck: false,
      }),
    ).rejects.toThrow()
    await expect(orchestrator.startLayout({ docId: '../evil' })).rejects.toThrow()
  })

  it('times out a hanging role attempt, retries once and continues the job', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) =>
      roleOfSystem(request.system) === 'master'
        ? new Promise<string>(() => {
            // Deliberately ignores the abort signal to prove the timeout races it.
            // Only `master` hangs: the facts role now has its own longer bound.
          })
        : defaultReply(request),
    )
    const { deps } = makeDeps({ store, llm, perCallTimeoutMs: 20 })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    const masterStage = state.stages.find((stage) => stage.id === 'a1:master')
    expect(masterStage?.status).toBe('failed')
    expect(masterStage?.error).toContain('timed out')
    expect(roleCalls(llm, 'master')).toHaveLength(2)
    expect(store.reports).toHaveLength(1)
  })

  it('defaults general role attempts to 300 s and network roles to fixed ceilings', () => {
    expect(DEFAULT_PER_CALL_TIMEOUT_MS).toBe(300_000)
    expect(FACTS_PER_CALL_TIMEOUT_MS).toBe(780_000)
    expect(NOUN_PER_CALL_TIMEOUT_MS).toBe(540_000)
  })

  it('lets a slow facts role exceed the general per-call bound while other roles still time out', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm(async (request) => {
      if (roleOfSystem(request.system) === 'facts') {
        // Longer than the configured 20 ms general bound, far below 600 s.
        await delay(80)
        return defaultReply(request)
      }
      if (roleOfSystem(request.system) === 'master') {
        // Never settles and ignores the signal: the general 20 ms bound kills it.
        return new Promise<string>(() => {})
      }
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm, perCallTimeoutMs: 20 })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    // Facts uses the extended facts bound and finishes; master keeps the general one.
    expect(state.stages.find((stage) => stage.id === 'a1:facts')?.status).toBe('done')
    expect(state.stages.find((stage) => stage.id === 'a1:master')?.status).toBe('failed')
    expect(state.stages.find((stage) => stage.id === 'a1:master')?.error).toContain('timed out')
    expect(store.reports).toHaveLength(1)
  })

  it('locates a headline finding whose quote occurs only in the title (Task 21d)', async () => {
    const article = makeArticle({ title: '独特标题', body: '本报讯 这是正文，正文里没有标题文字。' })
    const store = makeStore(makeDoc([article]))
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: [] })
      if (role === 'consolidator') return JSON.stringify({ findings: [] })
      if (role !== 'headline') return JSON.stringify({ findings: [] })
      return JSON.stringify({
        findings: [
          {
            category: 'headline',
            severity: 'suggested',
            quote: '独特标题',
            issue: '标题问题',
            suggestion: '新标题',
            confidence: 'high',
            needs_human: false,
          },
          {
            category: 'typo',
            severity: 'suggested',
            quote: '正文',
            issue: '正文问题',
            suggestion: '正文乙',
            confidence: 'high',
            needs_human: false,
          },
        ],
      })
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    // The title-only quote is locatable because title + body are searched.
    const titleFinding = report.findings.find((finding) => finding.quote === '独特标题')
    expect(titleFinding).toBeDefined()
    expect(titleFinding?.needsHuman).toBe(false)
    expect(titleFinding?.reason).toBeUndefined()
    // A body-only quote keeps its old behaviour.
    const bodyFinding = report.findings.find((finding) => finding.quote === '正文')
    expect(bodyFinding).toBeDefined()
    expect(bodyFinding?.needsHuman).toBe(false)
    expect(bodyFinding?.reason).toBeUndefined()
  })

  it('locates a headline finding whose quote occurs only in the subtitle (Task 21e)', async () => {
    const article = makeArticle({
      title: '独特标题',
      subtitle: '副标题独有短语',
      body: '本报讯 这是正文，正文里没有标题或副标题文字。',
    })
    const store = makeStore(makeDoc([article]))
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: [] })
      if (role === 'consolidator') return JSON.stringify({ findings: [] })
      if (role !== 'headline') return JSON.stringify({ findings: [] })
      return JSON.stringify({
        findings: [
          {
            category: 'headline',
            severity: 'suggested',
            quote: '副标题独有短语',
            issue: '副标题问题',
            suggestion: '新副标题',
            confidence: 'high',
            needs_human: false,
          },
        ],
      })
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    const subtitleFinding = report.findings.find((finding) => finding.quote === '副标题独有短语')
    expect(subtitleFinding).toBeDefined()
    expect(subtitleFinding?.needsHuman).toBe(false)
    expect(subtitleFinding?.reason).toBeUndefined()
  })

  it('cancels promptly even when a role ignores the abort signal', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm(
      () =>
        new Promise<string>(() => {
          // Never settles and never observes the signal.
        }),
    )
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    await vi.waitFor(() => expect(llm.calls.length).toBeGreaterThan(0))

    expect(orchestrator.cancel(jobId)).toBe(true)
    expect(orchestrator.get(jobId)?.status).toBe('cancelled')
    await delay(30)
    expect(orchestrator.get(jobId)?.status).toBe('cancelled')
    expect(orchestrator.get(jobId)?.stages.some((stage) => stage.status === 'running')).toBe(false)
    expect(store.reports).toHaveLength(0)
  })

  it('respects the global concurrency cap across articles and roles', async () => {
    const articleA = makeArticle({ id: 'a1', title: '标题甲', body: '标题甲正文，包含错误。' })
    const articleB = makeArticle({ id: 'a2', title: '标题乙', body: '标题乙正文，包含错误。' })
    const store = makeStore(makeDoc([articleA, articleB]))
    let active = 0
    let peak = 0
    const llm = makeLlm(async (request) => {
      active += 1
      peak = Math.max(peak, active)
      await delay(5)
      active -= 1
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm, concurrency: 2 })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1', 'a2'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(state.status).toBe('done')
    expect(peak).toBe(2)
  })

  it('starts the network roles right after the master role so the long roles overlap (Task 25)', async () => {
    const store = makeStore(makeDoc())
    const prompts = makePrompts()
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') return JSON.stringify({ claims: [] })
      return defaultReply(request)
    })
    // concurrency 1 makes the dispatch order observable: the network roles must
    // be scheduled right after the master role instead of last, so they overlap
    // the text roles whenever the Host has more than one worker.
    const { deps } = makeDeps({ store, llm, prompts, concurrency: 1 })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: false,
    })
    await waitForStatus(orchestrator, jobId, 'done')

    const workerComposeOrder = prompts.compose.mock.calls
      .map((call) => call[0] as RoleId)
      .filter((role) => role !== 'consolidator')
    expect(workerComposeOrder).toEqual([
      'master',
      'facts',
      'nouns',
      'words',
      'idioms',
      'style',
      'headline',
    ])
  })

  it('sends provider-supported high reasoning effort on every role request (Task 25)', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') return JSON.stringify({ claims: [] })
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'deep',
      factCheck: true,
    })
    await waitForStatus(orchestrator, jobId, 'done')

    const effortByRole = new Map<string, (string | undefined)[]>()
    for (const request of llm.calls) {
      const role = roleOfSystem(request.system) ?? 'unknown'
      const efforts = effortByRole.get(role) ?? []
      efforts.push(request.reasoningEffort)
      effortByRole.set(role, efforts)
    }

    // Every role uses the provider-supported `high` effort: key roles need it
    // for accuracy and `medium` is rejected by the provider at runtime (live
    // regression), while `high` is still faster than the global `max` default.
    for (const role of [
      'master',
      'facts',
      'nouns',
      'consistency',
      'consolidator',
      'words',
      'idioms',
      'style',
      'headline',
    ]) {
      expect(effortByRole.get(role), `role ${role} missing a model call`).toEqual(['high'])
    }
    // No role silently loses its request override (the activation default stays
    // the fallback for requests that do not set one).
    expect([...effortByRole.values()].flat().every((effort) => effort === 'high')).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */
/* Fact-check integration                                                      */
/* ------------------------------------------------------------------------- */

describe('proofread fact-check integration', () => {
  const FACT_ARTICLE = makeArticle({
    body: '本报2026年11月14日电，这是错误的内容。',
  })

  it('runs fact checking with an explicit unverified result when the network switch is off', async () => {
    const store = makeStore(makeDoc([FACT_ARTICLE]))
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') {
        return JSON.stringify({
          claims: [
            {
              claim: '报道日期是2026年11月14日',
              quote: '2026年11月14日',
              kind: 'date',
              queries: ['2026年11月14日 报道'],
              priority: 1,
            },
          ],
        })
      }
      return defaultReply(request)
    })
    const web = makeWeb()
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(state.stages.find((stage) => stage.id === 'a1:facts')?.status).toBe('done')
    const report = state.result as Report
    expect(report.factChecks).toHaveLength(1)
    expect(report.factChecks[0]).toMatchObject({
      articleId: 'a1',
      verdict: 'unverified',
      occurrence: 1,
    })
    // Network disabled: the real web seam is never touched and no searches are reported.
    expect(web.search).not.toHaveBeenCalled()
    expect(report.stats.searchCalls).toBe(0)
    expect(report.stats.fetchCalls).toBe(0)
  })

  it('verifies claims with the web, saves evidence and turns contradictions into must-fix findings', async () => {
    const store = makeStore(makeDoc([FACT_ARTICLE]))
    const llm = makeLlm(
      (request) => {
        const role = roleOfSystem(request.system)
        if (role === 'facts') {
          if (userText(request).includes('第一阶段')) {
            return JSON.stringify({
              claims: [
                {
                  claim: '报道日期是2026年11月14日',
                  quote: '2026年11月14日',
                  kind: 'date',
                  queries: ['2026年11月14日 报道'],
                  priority: 1,
                },
              ],
            })
          }
          return JSON.stringify({
            verdicts: [
              {
                claim: '报道日期是2026年11月14日',
                verdict: 'contradicted',
                evidence: '官方日期为11月15日',
                sources: [{ title: '来源', url: 'https://example.com' }],
                confidence: 'high',
              },
            ],
          })
        }
        if (role === 'consolidator') return JSON.stringify({ findings: [], notes: '' })
        if (role === 'nouns') return JSON.stringify({ nouns: [] })
        return JSON.stringify({ findings: [] })
      },
      { inputTokens: 10, outputTokens: 20 },
    )
    const web = makeWeb({
      search: () => ({
        content: '检索摘要',
        sources: [{ url: 'https://example.com', title: '来源' }],
        truncated: false,
      }),
      fetch: (request) => ({
        url: request.url,
        statusCode: 200,
        body: { kind: 'text', content: '权威正文' },
        truncated: false,
      }),
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: true,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    expect(report.factChecks).toHaveLength(1)
    const check = report.factChecks[0]
    expect(check).toMatchObject({
      id: 'a1:fc1',
      articleId: 'a1',
      verdict: 'contradicted',
      quote: '2026年11月14日',
      occurrence: 1,
      confidence: 'high',
      needsHuman: false,
    })
    expect(check.sources).toEqual([{ title: '来源', url: 'https://example.com' }])

    const contradiction = report.findings.find((finding) => finding.category === 'fact')
    expect(contradiction).toBeDefined()
    expect(contradiction).toMatchObject({
      articleId: 'a1',
      severity: 'must_fix',
      quote: '2026年11月14日',
      occurrence: 1,
    })
    expect(contradiction?.id).toMatch(/^a1:f\d+$/)
    expect(contradiction?.roles).toContain('facts')

    // saveEvidence sink → reports/<jobId>/<articleId>/facts-evidence.json via the store.
    const evidenceSave = store.roleSaves.find((save) => save.role === 'facts-evidence')
    expect(evidenceSave).toBeDefined()
    expect(evidenceSave?.docId).toBe(DOC_ID)
    expect(evidenceSave?.articleId).toBe('a1')
    expect(evidenceSave?.value).toEqual(
      expect.objectContaining({ articleId: 'a1', claims: expect.any(Array) }),
    )
    // The cached facts result persists its depth/network cache identity.
    const factsSave = store.roleSaves.find((save) => save.role === 'facts')
    expect(factsSave?.value).toMatchObject({ depth: 'standard', factCheck: true })

    expect(web.search).toHaveBeenCalled()
    expect(report.stats.calls).toBeGreaterThan(0)
    expect(report.stats.searchCalls).toBeGreaterThanOrEqual(1)
    expect(report.stats.fetchCalls).toBeGreaterThanOrEqual(1)
    expect(report.stats.inputTokens).toBe(report.stats.calls * 10)
    expect(report.stats.outputTokens).toBe(report.stats.calls * 20)
    expect(report.stats.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(report.stats.failedCalls).toBe(0)

    // No prompt text may leak into the report or job state (design §8.1).
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('SYSTEM-')
    expect(serialized).not.toContain('USER-')
    expect(serialized).not.toContain('第一阶段')
    expect(serialized).not.toContain('汇总裁决角色')
  })

  it('keeps the facts role visible when the web service is unavailable', async () => {
    const store = makeStore(makeDoc([FACT_ARTICLE]))
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') {
        return JSON.stringify({
          claims: [
            {
              claim: '报道日期是2026年11月14日',
              quote: '2026年11月14日',
              kind: 'date',
              queries: ['2026年11月14日 报道'],
              priority: 1,
            },
          ],
        })
      }
      return defaultReply(request)
    })
    const web = makeWeb({
      search: () => {
        throw new Error('offline')
      },
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    expect(state.stages.find((stage) => stage.id === 'a1:facts')?.status).toBe('done')
    expect(report.factChecks).toHaveLength(1)
    expect(report.factChecks[0].verdict).toBe('unverified')
    expect(report.stats.searchCalls).toBe(1)
  })

  it('stamps factCheckMode unavailable when the Host has no web service', async () => {
    const store = makeStore(makeDoc([FACT_ARTICLE]))
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') {
        return JSON.stringify({
          claims: [
            {
              claim: '报道日期是2026年11月14日',
              quote: '2026年11月14日',
              kind: 'date',
              queries: ['2026年11月14日 报道'],
              priority: 1,
            },
          ],
        })
      }
      return defaultReply(request)
    })
    const web = makeWeb({
      search: () => {
        throw new Error('must not be called when the service is absent')
      },
    })
    const { deps } = makeDeps({ store, llm, web, webAvailable: false })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    // The mode is explicit even though `stats.searchCalls` can be > 0: the fact
    // checker counts the attempt before the call, so the counter must never be
    // used to decide whether the network was available.
    expect(report.factCheckMode).toBe('unavailable')
    expect(report.stats.searchCalls).toBeGreaterThan(0)
    expect(
      report.factChecks.every(
        (check) => check.verdict === 'unverified' || check.verdict === 'not_checked',
      ),
    ).toBe(true)
    expect(web.search).not.toHaveBeenCalled()
  })

  it('stamps factCheckMode off/on for explicit factCheck choices', async () => {
    const { deps } = makeDeps()
    const orchestrator = createJobOrchestrator(deps)

    const offId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const off = (await waitForStatus(orchestrator, offId, 'done')).result as Report
    expect(off.factCheckMode).toBe('off')

    const onId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const on = (await waitForStatus(orchestrator, onId, 'done')).result as Report
    expect(on.factCheckMode).toBe('on')
  })

  it('maps depth to the fact-check claim/search budget', () => {
    const quick = factBudgetForDepth('quick')
    const standard = factBudgetForDepth('standard')
    const deep = factBudgetForDepth('deep')
    expect(standard).toEqual({ maxClaims: 200, maxSearches: 240, resultsPerClaim: 5, fetchPerClaim: 2 })
    expect(deep).toEqual({ maxClaims: 400, maxSearches: 480, resultsPerClaim: 5, fetchPerClaim: 2 })
    expect(quick.maxClaims).toBeLessThan(standard.maxClaims)
    expect(quick.maxSearches).toBeLessThan(standard.maxSearches)
    expect(deep.maxClaims).toBeGreaterThan(standard.maxClaims)
    expect(deep.maxSearches).toBeGreaterThan(standard.maxSearches)
  })
})

/* ------------------------------------------------------------------------- */
/* Noun-check integration                                                      */
/* ------------------------------------------------------------------------- */

describe('proofread noun-check integration', () => {
  const NOUN_ARTICLE = makeArticle({
    body: '本报讯 复旦大学附属华山医院团队与脑机接口系统NEO亮相，这是错误的内容。',
  })
  const NOUN_PLAN = [
    {
      name: '脑机接口系统NEO',
      quote: '脑机接口系统NEO',
      kind: 'system',
      queries: ['NEO 脑机接口', '脑机接口系统NEO'],
      priority: 1,
    },
    {
      name: '复旦大学附属华山医院',
      quote: '复旦大学附属华山医院团队',
      kind: 'institution',
      queries: ['华山医院', '复旦大学附属华山医院'],
      priority: 2,
    },
  ]

  it('runs the independent nouns role and reports existence-only checks without findings', async () => {
    const store = makeStore(makeDoc([NOUN_ARTICLE]))
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: NOUN_PLAN })
      return JSON.stringify({ findings: [] })
    })
    const web = makeWeb({
      search: (request) => {
        if (request.query.includes('NEO')) {
          return {
            content: '',
            sources: [
              { url: 'https://baike.baidu.com/item/neo', title: 'NEO 百科' },
              { url: 'https://example.com/neo', title: 'NEO 报道' },
            ],
            truncated: false,
          }
        }
        return {
          content: '',
          sources: [{ url: 'https://example.com/huashan', title: '华山医院报道' }],
          truncated: false,
        }
      },
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'standard',
      factCheck: true,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(state.stages.find((stage) => stage.id === 'a1:nouns')?.status).toBe('done')
    const report = state.result as Report
    expect(report.nounChecks).toHaveLength(2)
    const [first, second] = report.nounChecks ?? []
    // The plan is priority-ordered and the local ids are `noun1…`.
    expect(first).toMatchObject({
      id: 'a1:noun1',
      articleId: 'a1',
      name: '脑机接口系统NEO',
      status: 'exists',
      confidence: 'high',
      needsHuman: false,
    })
    expect(first.sources).toHaveLength(2)
    expect(second).toMatchObject({
      id: 'a1:noun2',
      articleId: 'a1',
      name: '复旦大学附属华山医院',
      status: 'uncertain',
      confidence: 'low',
      needsHuman: true,
    })
    expect(report.summary.nounCheck).toEqual({
      exists: 1,
      uncertain: 1,
      notFound: 0,
      notChecked: 0,
    })
    // Existence information only: the nouns role never contributes findings.
    expect(report.findings).toEqual([])
  })

  it('does not reuse an offline not_checked noun result when the network is enabled', async () => {
    const store = makeStore(makeDoc([NOUN_ARTICLE]))
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: [NOUN_PLAN[1]] })
      return JSON.stringify({ findings: [] })
    })
    const web = makeWeb({
      search: () => ({
        content: '',
        sources: [
          { url: 'https://www.gov.cn/notice', title: '政府公告' },
          { url: 'https://example.com/huashan', title: '华山医院报道' },
        ],
        truncated: false,
      }),
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const offlineJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const offlineReport = (await waitForStatus(orchestrator, offlineJob, 'done')).result as Report
    expect(offlineReport.nounChecks).toHaveLength(1)
    expect(offlineReport.nounChecks?.[0]).toMatchObject({
      status: 'not_checked',
      needsHuman: false,
    })
    expect(offlineReport.summary.nounCheck).toEqual({
      exists: 0,
      uncertain: 0,
      notFound: 0,
      notChecked: 1,
    })
    // No real network is touched when the switch is off.
    expect(web.search).not.toHaveBeenCalled()
    const offlineSave = store.roleSaves.find(
      (save) => save.jobId === offlineJob && save.role === 'nouns',
    )
    expect(offlineSave?.value).toMatchObject({ depth: 'quick', factCheck: false })

    const onlineJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const onlineReport = (await waitForStatus(orchestrator, onlineJob, 'done')).result as Report
    // A fresh noun plan + search run, never the cached offline not_checked rows.
    expect(roleCalls(llm, 'nouns')).toHaveLength(2)
    expect(onlineReport.nounChecks?.[0]?.status).toBe('exists')
    expect(web.search).toHaveBeenCalled()
    const onlineSave = store.roleSaves.find(
      (save) => save.jobId === onlineJob && save.role === 'nouns',
    )
    expect(onlineSave?.value).toMatchObject({ depth: 'quick', factCheck: true })

    // A same-depth/online rerun may hit the cache and keeps the online result.
    const rerunJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const rerunReport = (await waitForStatus(orchestrator, rerunJob, 'done')).result as Report
    expect(roleCalls(llm, 'nouns')).toHaveLength(2)
    expect(rerunReport.nounChecks?.[0]?.status).toBe('exists')
    expect(store.roleSaves.filter((save) => save.jobId === rerunJob)).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------- */
/* Caching                                                                     */
/* ------------------------------------------------------------------------- */

describe('proofread caching', () => {
  it('reuses in-memory role results for a repeated identical job', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm()
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const firstJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    await waitForStatus(orchestrator, firstJob, 'done')
    const roleCallsAfterFirst = llm.calls.filter(
      (request) => roleOfSystem(request.system) !== 'consolidator',
    )
    expect(roleCallsAfterFirst).toHaveLength(4)
    const persistedAfterFirst = store.roleSaves.filter((save) => save.role !== 'facts-evidence')
    expect(persistedAfterFirst).toHaveLength(4)

    const secondJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, secondJob, 'done')

    expect(
      llm.calls.filter((request) => roleOfSystem(request.system) !== 'consolidator'),
    ).toHaveLength(4)
    expect(state.stages.filter((stage) => stage.id.startsWith('a1:') && stage.id !== 'a1:consolidator').every((stage) => stage.status === 'done')).toBe(true)
    // Cache hits skip the model and do not rewrite the per-job cache files.
    expect(store.roleSaves.filter((save) => save.jobId === secondJob)).toHaveLength(0)
    expect(store.reports).toHaveLength(2)
    expect((state.result as Report).findings.length).toBeGreaterThan(0)
  })

  it('reloads persisted role results in a fresh orchestrator (restart recovery)', async () => {
    const store = makeStore(makeDoc())
    const article = makeDoc().articles?.[0] as Article
    const first = makeLlm()
    const { deps: firstDeps } = makeDeps({ store, llm: first })
    const firstOrchestrator = createJobOrchestrator(firstDeps)

    const firstJob = await firstOrchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    await waitForStatus(firstOrchestrator, firstJob, 'done')

    const cachedKey = roleCacheKey({
      articleId: 'a1',
      role: 'master',
      promptVersion: PROMPT_VERSION,
      model: ROUTE_LABEL,
      text: articleCacheText(article),
    })
    expect(
      store.roleSaves.some(
        (save) => save.role === 'master' && (save.value as { cacheKey?: string }).cacheKey === cachedKey,
      ),
    ).toBe(true)

    // A new orchestrator (process restart) with fresh clients reloads the cache.
    const secondLlm = makeLlm()
    const { deps: secondDeps } = makeDeps({ store, llm: secondLlm })
    const secondOrchestrator = createJobOrchestrator(secondDeps)
    const secondJob = await secondOrchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    expect(secondJob).not.toBe(firstJob)
    // The restarted process must not read results it has not written: the new
    // job's report directory is empty before the cache hit.
    expect(store.roleResults.has(`${secondJob}\u0000a1`)).toBe(false)

    const state = await waitForStatus(secondOrchestrator, secondJob, 'done')

    expect(roleCalls(secondLlm, 'master')).toHaveLength(0)
    expect(roleCalls(secondLlm, 'words')).toHaveLength(0)
    expect(roleCalls(secondLlm, 'facts')).toHaveLength(0)
    // The network nouns role is cached and keyed on depth/network mode too.
    expect(roleCalls(secondLlm, 'nouns')).toHaveLength(0)
    expect(roleCalls(secondLlm, 'consolidator')).toHaveLength(1)
    // The previous completed job's role files were the reload source.
    expect(
      store.getRoleResults.mock.calls.some(
        (call) => call[1] === firstJob && call[2] === 'a1',
      ),
    ).toBe(true)
    expect(
      store.getRoleResults.mock.calls.some(
        (call) => call[1] === secondJob && call[2] === 'a1',
      ),
    ).toBe(true)
    // Cache hits do not write into the new job's directory.
    expect(store.roleSaves.filter((save) => save.jobId === secondJob)).toHaveLength(0)
    expect(store.roleResults.has(`${secondJob}\u0000a1`)).toBe(false)
    expect(state.stages.find((stage) => stage.id === 'a1:master')?.status).toBe('done')
    expect((state.result as Report).findings.length).toBeGreaterThan(0)
  })

  it('invalidates the cache when the prompt version, model or provider changes', async () => {
    const store = makeStore(makeDoc())
    const firstLlm = makeLlm()
    const { deps: firstDeps } = makeDeps({ store, llm: firstLlm })
    const firstOrchestrator = createJobOrchestrator(firstDeps)
    const firstJob = await firstOrchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const firstState = await waitForStatus(firstOrchestrator, firstJob, 'done')
    // The report identifies the real route, not only the model name.
    expect((firstState.result as Report).model).toBe(ROUTE_LABEL)

    const secondLlm = makeLlm()
    const { deps: secondDeps } = makeDeps({
      store,
      llm: secondLlm,
      prompts: makePrompts('pv2'),
    })
    const secondOrchestrator = createJobOrchestrator(secondDeps)
    const secondJob = await secondOrchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    await waitForStatus(secondOrchestrator, secondJob, 'done')
    expect(
      secondLlm.calls.filter((request) => roleOfSystem(request.system) !== 'consolidator'),
    ).toHaveLength(4)

    const thirdLlm = makeLlm()
    const { deps: thirdDeps } = makeDeps({
      store,
      llm: thirdLlm,
      model: { provider: 'deepseek-official', model: 'deepseek-pro' },
    })
    const thirdOrchestrator = createJobOrchestrator(thirdDeps)
    const thirdJob = await thirdOrchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    await waitForStatus(thirdOrchestrator, thirdJob, 'done')
    expect(
      thirdLlm.calls.filter((request) => roleOfSystem(request.system) !== 'consolidator'),
    ).toHaveLength(4)

    // A provider-only change (same model name) must also invalidate the cache.
    const fourthLlm = makeLlm()
    const { deps: fourthDeps } = makeDeps({
      store,
      llm: fourthLlm,
      model: { provider: 'other-provider', model: MODEL },
    })
    const fourthOrchestrator = createJobOrchestrator(fourthDeps)
    const fourthJob = await fourthOrchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const fourthState = await waitForStatus(fourthOrchestrator, fourthJob, 'done')
    expect(
      fourthLlm.calls.filter((request) => roleOfSystem(request.system) !== 'consolidator'),
    ).toHaveLength(4)
    expect((fourthState.result as Report).model).toBe(`other-provider/${MODEL}`)
  })

  it('does not reuse a quick facts result for a deep run', async () => {
    const article = makeArticle({ body: '本报2026年11月14日电，这是错误的内容。' })
    const store = makeStore(makeDoc([article]))
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') return JSON.stringify({ claims: [] })
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const quickJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    await waitForStatus(orchestrator, quickJob, 'done')
    expect(roleCalls(llm, 'facts')).toHaveLength(1)
    const quickFacts = store.roleSaves.find(
      (save) => save.jobId === quickJob && save.role === 'facts',
    )
    expect(quickFacts?.value).toMatchObject({ depth: 'quick', factCheck: true })

    const deepJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'deep',
      factCheck: true,
    })
    await waitForStatus(orchestrator, deepJob, 'done')

    // The depth is part of the facts cache identity: the deep run re-runs the role
    // instead of reusing the (cheaper) quick budget result.
    expect(roleCalls(llm, 'facts')).toHaveLength(2)
    const deepFacts = store.roleSaves.find(
      (save) => save.jobId === deepJob && save.role === 'facts',
    )
    expect(deepFacts?.value).toMatchObject({ depth: 'deep', factCheck: true })
  })

  it('does not reuse an offline facts result when the network is enabled', async () => {
    const article = makeArticle({ body: '本报2026年11月14日电，这是错误的内容。' })
    const store = makeStore(makeDoc([article]))
    const claims = [
      {
        claim: '报道日期是2026年11月14日',
        quote: '2026年11月14日',
        kind: 'date',
        queries: ['2026年11月14日 报道'],
        priority: 1,
      },
    ]
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role !== 'facts') return defaultReply(request)
      if (userText(request).includes('第一阶段')) return JSON.stringify({ claims })
      return JSON.stringify({
        verdicts: [
          {
            claim: claims[0].claim,
            verdict: 'confirmed',
            evidence: '官方日期一致',
            sources: [{ title: '来源', url: 'https://example.com' }],
            confidence: 'high',
          },
        ],
      })
    })
    const web = makeWeb({
      search: () => ({
        content: '摘要',
        sources: [{ url: 'https://example.com', title: '来源' }],
        truncated: false,
      }),
      fetch: (request) => ({
        url: request.url,
        statusCode: 200,
        body: { kind: 'text', content: '正文' },
        truncated: false,
      }),
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const offlineJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const offlineState = await waitForStatus(orchestrator, offlineJob, 'done')
    const offlineReport = offlineState.result as Report
    expect(offlineReport.factChecks).toHaveLength(1)
    expect(offlineReport.factChecks[0].verdict).toBe('unverified')
    expect(roleCalls(llm, 'facts')).toHaveLength(1) // extraction only: no network
    expect(web.search).not.toHaveBeenCalled()
    const offlineSave = store.roleSaves.find(
      (save) => save.jobId === offlineJob && save.role === 'facts',
    )
    expect(offlineSave?.value).toMatchObject({ depth: 'quick', factCheck: false })

    const onlineJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const onlineState = await waitForStatus(orchestrator, onlineJob, 'done')
    const onlineReport = onlineState.result as Report
    expect(onlineReport.factChecks[0].verdict).toBe('confirmed')
    // A fresh extract + verdict run, not the cached offline checklist.
    expect(roleCalls(llm, 'facts')).toHaveLength(3)
    expect(web.search).toHaveBeenCalled()
    const onlineSave = store.roleSaves.find(
      (save) => save.jobId === onlineJob && save.role === 'facts',
    )
    expect(onlineSave?.value).toMatchObject({ depth: 'quick', factCheck: true })

    // A same-depth/online rerun may hit the cache and keeps the verified result.
    const rerunJob = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    const rerunState = await waitForStatus(orchestrator, rerunJob, 'done')
    expect(roleCalls(llm, 'facts')).toHaveLength(3)
    expect((rerunState.result as Report).factChecks[0].verdict).toBe('confirmed')
    expect(store.roleSaves.filter((save) => save.jobId === rerunJob)).toHaveLength(0)
  })

  it('only reloads role results from the five most recent completed jobs', async () => {
    const store = makeStore(makeDoc())
    const article = makeDoc().articles?.[0] as Article
    const cacheKey = roleCacheKey({
      articleId: 'a1',
      role: 'master',
      promptVersion: PROMPT_VERSION,
      model: ROUTE_LABEL,
      text: articleCacheText(article),
    })
    const cachedFinding = (issue: string): Finding => ({
      id: 'f1',
      articleId: 'a1',
      category: 'typo',
      severity: 'must_fix',
      quote: QUOTE,
      occurrence: 1,
      issue,
      suggestion: '正确',
      confidence: 'high',
      needsHuman: false,
      roles: ['master'],
      status: 'open',
    })
    store.seedCompletedJob('job_1763500000001', 'a1', {
      master: {
        cacheKey,
        articleId: 'a1',
        role: 'master',
        findings: [cachedFinding('来自很旧的任务')],
      },
    })
    for (const jobId of [
      'job_1763500000002',
      'job_1763500000003',
      'job_1763500000004',
      'job_1763500000005',
      'job_1763500000006',
    ]) {
      store.seedCompletedJob(jobId, 'a1', {})
    }
    store.seedCompletedJob('job_1763500000007', 'a1', {
      master: {
        cacheKey,
        articleId: 'a1',
        role: 'master',
        findings: [cachedFinding('来自最近的任务')],
      },
    })

    const llm = makeLlm()
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)
    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    expect(roleCalls(llm, 'master')).toHaveLength(0)
    expect(report.findings.some((finding) => finding.issue === '来自最近的任务')).toBe(true)
    expect(report.findings.some((finding) => finding.issue === '来自很旧的任务')).toBe(false)
    const readJobIds = store.getRoleResults.mock.calls.map((call) => call[1])
    expect(readJobIds).toContain('job_1763500000007')
    expect(readJobIds).not.toContain('job_1763500000001')
    expect(readJobIds).not.toContain('job_1763500000002')
  })

  it('builds cache keys from article, role, prompt version, model and text', () => {
    const base = {
      articleId: 'a1',
      role: 'master' as RoleId,
      promptVersion: 'pv1',
      model: 'm1',
      text: '文本',
    }
    const key = roleCacheKey(base)
    expect(roleCacheKey({ ...base })).toBe(key)
    expect(roleCacheKey({ ...base, articleId: 'a2' })).not.toBe(key)
    expect(roleCacheKey({ ...base, role: 'words' })).not.toBe(key)
    expect(roleCacheKey({ ...base, promptVersion: 'pv2' })).not.toBe(key)
    expect(roleCacheKey({ ...base, model: 'm2' })).not.toBe(key)
    expect(roleCacheKey({ ...base, text: '文本2' })).not.toBe(key)
  })

  it('keys the network roles on depth and network mode, not only the text', () => {
    const base = {
      articleId: 'a1',
      role: 'nouns' as RoleId,
      promptVersion: 'pv1',
      model: 'm1',
      text: '文本',
    }
    const quickOffline = roleCacheKey({ ...base, depth: 'quick', factCheck: false })
    expect(roleCacheKey({ ...base, depth: 'quick', factCheck: false })).toBe(quickOffline)
    // An offline not_checked noun result must never be reused online.
    expect(roleCacheKey({ ...base, depth: 'quick', factCheck: true })).not.toBe(quickOffline)
    expect(roleCacheKey({ ...base, depth: 'deep', factCheck: false })).not.toBe(quickOffline)
    // The facts role keeps the identical identity rule.
    expect(
      roleCacheKey({ articleId: 'a1', role: 'facts', promptVersion: 'pv1', model: 'm1', text: '文本' }),
    ).not.toBe(
      roleCacheKey({
        articleId: 'a1',
        role: 'facts',
        promptVersion: 'pv1',
        model: 'm1',
        text: '文本',
        depth: 'quick',
        factCheck: false,
      }),
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Consolidator and report building                                            */
/* ------------------------------------------------------------------------- */

describe('consolidation and reports', () => {
  it('skips the consolidator when the roles found nothing', async () => {
    const store = makeStore(makeDoc())
    const prompts = makePrompts()
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'facts') {
        return JSON.stringify({ claims: [] })
      }
      if (roleOfSystem(request.system) === 'nouns') return JSON.stringify({ nouns: [] })
      return JSON.stringify({ findings: [] })
    })
    const { deps } = makeDeps({ store, llm, prompts })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(prompts.compose.mock.calls.some((call) => call[0] === 'consolidator')).toBe(false)
    expect(state.stages.find((stage) => stage.id === 'a1:consolidator')?.status).toBe('done')
    const report = state.result as Report
    expect(report.findings).toEqual([])
    expect(report.summary.mustFixList).toEqual([])
  })

  it('uses the consolidator verdict while keeping roles, evidence and sources from the merge', async () => {
    const store = makeStore(makeDoc())
    const masterFinding = {
      category: 'typo',
      severity: 'must_fix',
      quote: QUOTE,
      issue: '字词问题',
      suggestion: '正确写法',
      confidence: 'high',
      needs_human: false,
      sources: [{ title: '词典', url: 'https://dict.example' }],
    }
    const wordsFinding = {
      category: 'typo',
      severity: 'suggested',
      quote: QUOTE,
      issue: '字词问题',
      suggestion: '正确写法',
      confidence: 'medium',
      needs_human: false,
      evidence: '词语证据',
      sources: [
        { title: '词典', url: 'https://dict.example' },
        { title: '其他', url: 'https://other.example' },
      ],
    }
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'master') return JSON.stringify({ findings: [masterFinding] })
      if (role === 'words') return JSON.stringify({ findings: [wordsFinding] })
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: [] })
      if (role === 'consolidator') {
        return JSON.stringify({
          findings: [
            {
              category: 'typo',
              severity: 'suggested',
              quote: QUOTE,
              issue: '合并后的问题',
              suggestion: '最终建议',
              confidence: 'medium',
              needs_human: false,
            },
          ],
          notes: '已去重',
        })
      }
      return JSON.stringify({ findings: [] })
    })
    const prompts = makePrompts()
    const { deps } = makeDeps({ store, llm, prompts })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    expect(report.findings).toHaveLength(1)
    const finding = report.findings[0]
    expect(finding).toMatchObject({
      id: 'a1:f1',
      articleId: 'a1',
      severity: 'suggested',
      issue: '合并后的问题',
      suggestion: '最终建议',
      quote: QUOTE,
      evidence: '词语证据',
    })
    expect(finding.roles.sort()).toEqual(['master', 'words'])
    expect(finding.sources).toEqual([
      { title: '词典', url: 'https://dict.example' },
      { title: '其他', url: 'https://other.example' },
    ])

    // The consolidator received the merged findings JSON, not the raw article only.
    const consolidatorRequest = llm.calls.find(
      (request) => roleOfSystem(request.system) === 'consolidator',
    ) as LlmRequest
    const consolidatorUser = userText(consolidatorRequest)
    expect(consolidatorUser).toContain('<findings>')
    expect(consolidatorUser).toContain('"quote":"错误"')
    expect(consolidatorUser).toContain('article=a1')
  })

  it('keeps the merged findings when the consolidator fails', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) => {
      if (roleOfSystem(request.system) === 'consolidator') throw new Error('consolidator down')
      return defaultReply(request)
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    expect(state.status).toBe('done')
    expect(state.stages.find((stage) => stage.id === 'a1:consolidator')?.status).toBe('failed')
    expect((state.result as Report).findings.length).toBeGreaterThan(0)
    // A failed consolidator is a failed role, not a silent empty result.
    expect((state.result as Report).failedRoles).toEqual([
      {
        articleId: 'a1',
        role: 'consolidator',
        error: expect.stringContaining('consolidator down'),
      },
    ])
    expect(roleCalls(llm, 'consolidator')).toHaveLength(2)
  })

  it('keeps a merged problem the consolidator omitted', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: [] })
      if (role === 'consolidator') return JSON.stringify({ findings: [] })
      return JSON.stringify({
        findings: [
          {
            category: 'typo',
            severity: 'must_fix',
            quote: QUOTE,
            issue: '不可丢失的问题',
            suggestion: '正确',
            confidence: 'high',
            needs_human: false,
          },
        ],
      })
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')

    const report = state.result as Report
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].issue).toBe('不可丢失的问题')
  })

  it('builds a deterministic page report with prefixed ids, ordering and summary', async () => {
    const articleA = makeArticle({ id: 'a1', title: '标题甲', body: '前缀甲乙错误内容。' })
    const articleB = makeArticle({ id: 'a2', title: '标题乙', body: '标题乙正文。' })
    const store = makeStore(makeDoc([articleA, articleB]))
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      const user = userText(request)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') return JSON.stringify({ nouns: [] })
      if (role === 'consolidator') return JSON.stringify({ findings: [] })
      if (role === 'master') {
        if (user.includes('article=a1')) {
          return JSON.stringify({
            findings: [
              {
                category: 'typo',
                severity: 'suggested',
                quote: '内容',
                issue: '建议改内容',
                suggestion: '内容乙',
                confidence: 'high',
                needs_human: false,
              },
            ],
          })
        }
        return JSON.stringify({
          findings: [
            {
              category: 'headline',
              severity: 'must_fix',
              quote: '标题乙',
              issue: '标题问题',
              suggestion: '新标题',
              confidence: 'high',
              needs_human: false,
            },
          ],
        })
      }
      if (role === 'words') {
        if (!user.includes('article=a1')) return JSON.stringify({ findings: [] })
        return JSON.stringify({
          findings: [
            {
              category: 'typo',
              severity: 'must_fix',
              quote: '甲乙',
              issue: '错别字甲',
              suggestion: '甲已',
              confidence: 'high',
              needs_human: false,
            },
            {
              category: 'word',
              severity: 'must_fix',
              quote: '错误',
              issue: '误用',
              suggestion: '正确',
              confidence: 'medium',
              needs_human: false,
            },
          ],
        })
      }
      return JSON.stringify({ findings: [] })
    })
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1', 'a2'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const report = state.result as Report

    expect(report.jobId).toBe(jobId)
    expect(report.docId).toBe(DOC_ID)
    expect(report.articleIds).toEqual(['a1', 'a2'])
    expect(report.depth).toBe('quick')
    expect(report.model).toBe(ROUTE_LABEL)
    expect(report.promptVersion).toBe(PROMPT_VERSION)
    expect(typeof report.createdAt).toBe('number')

    expect(report.findings.map((finding) => finding.id)).toEqual([
      'a1:f1',
      'a1:f2',
      'a1:f3',
      'a2:f1',
    ])
    expect(report.findings.map((finding) => finding.severity)).toEqual([
      'must_fix',
      'must_fix',
      'suggested',
      'must_fix',
    ])
    // Same severity is ordered by the quote's position in the article body.
    expect(report.findings.map((finding) => finding.quote)).toEqual([
      '甲乙',
      '错误',
      '内容',
      '标题乙',
    ])
    expect(report.summary.mustFixCount).toBe(3)
    expect(report.summary.suggestedCount).toBe(1)
    expect(report.summary.optionalCount).toBe(0)
    expect(report.summary.byCategory).toEqual({ typo: 2, word: 1, headline: 1 })
    expect(report.summary.factCheck).toEqual({
      confirmed: 0,
      contradicted: 0,
      unverified: 0,
      insufficient: 0,
      notChecked: 0,
    })
    expect(report.summary.mustFixList).toEqual([
      '《标题甲》错别字甲：“甲乙” → 甲已',
      '《标题甲》误用：“错误” → 正确',
      '《标题乙》标题问题：“标题乙” → 新标题',
    ])
    expect(report.factChecks).toEqual([])
    // New reports always carry the noun checklist + summary, even when empty.
    expect(report.nounChecks).toEqual([])
    expect(report.summary.nounCheck).toEqual({
      exists: 0,
      uncertain: 0,
      notFound: 0,
      notChecked: 0,
    })
    expect(report.stats.failedCalls).toBe(0)
    expect(report.stats.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('fails the job when the report cannot be saved', async () => {
    const store = makeStore(makeDoc())
    store.saveReport.mockRejectedValue(new Error('disk full'))
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    const state = await waitForStatus(orchestrator, jobId, 'failed')

    expect(state.error).toContain('disk full')
    expect(state.stages.find((stage) => stage.id === 'report')?.status).toBe('failed')
  })
})

/* ------------------------------------------------------------------------- */
/* Cancellation and job state                                                  */
/* ------------------------------------------------------------------------- */

describe('cancellation and job state', () => {
  it('cancels a running proofread job and never overwrites the cancelled state', async () => {
    const store = makeStore(makeDoc())
    const llm = makeLlm(
      (request, signal) =>
        new Promise<string>((_resolve, reject) => {
          const abort = (): void => reject(signal.reason ?? new JobCancelledError('cancelled'))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
    )
    const { deps } = makeDeps({ store, llm })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: false,
    })
    await vi.waitFor(() => expect(llm.calls.length).toBeGreaterThan(0))

    expect(orchestrator.cancel(jobId)).toBe(true)
    expect(orchestrator.get(jobId)?.status).toBe('cancelled')

    await delay(20)
    const state = orchestrator.get(jobId) as JobState
    expect(state.status).toBe('cancelled')
    expect(state.stages.some((stage) => stage.status === 'running')).toBe(false)
    expect(store.reports).toHaveLength(0)
    expect(orchestrator.cancel(jobId)).toBe(false)
  })

  it('returns defensive job snapshots and handles unknown job ids', async () => {
    const store = makeStore(makeDoc([]))
    const { deps } = makeDeps({ store })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startLayout({ docId: DOC_ID })
    const first = orchestrator.get(jobId) as JobState
    const second = orchestrator.get(jobId) as JobState
    expect(second).not.toBe(first)
    expect(second.stages).not.toBe(first.stages)
    expect(second.stages[0]).not.toBe(first.stages[0])

    expect(orchestrator.get('job_9999999999999_1')).toBeUndefined()
    expect(orchestrator.cancel('job_9999999999999_1')).toBe(false)

    const state = await waitForStatus(orchestrator, jobId, 'done')
    expect(orchestrator.cancel(jobId)).toBe(false)
    expect(state.stages.every((stage) => stage.status === 'done')).toBe(true)
  })

  it('generates collision-free job ids across orchestrator instances that share a clock', async () => {
    const store = makeStore(makeDoc([]))
    const fixedNow = (): number => 5_000
    const first = createJobOrchestrator(makeDeps({ store, now: fixedNow }).deps)
    const second = createJobOrchestrator(makeDeps({ store, now: fixedNow }).deps)

    const ids = new Set<string>()
    for (let index = 0; index < 5; index += 1) {
      ids.add(await first.startLayout({ docId: DOC_ID }))
    }
    for (let index = 0; index < 5; index += 1) {
      ids.add(await second.startLayout({ docId: DOC_ID }))
    }

    expect(ids.size).toBe(10)
    for (const id of ids) expect(id).toMatch(/^job_5000_[0-9a-f]{12}$/)
    await vi.waitFor(
      () =>
        expect(
          [...ids].every(
            (id) => first.get(id)?.status === 'done' || second.get(id)?.status === 'done',
          ),
        ).toBe(true),
      { timeout: 5_000 },
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Role helpers                                                                */
/* ------------------------------------------------------------------------- */

describe('role helpers', () => {
  it('defines the documented depth role sets with the network roles early (Task 25)', () => {
    expect(rolesForDepth('quick')).toEqual(['master', 'facts', 'nouns', 'words'])
    expect(rolesForDepth('standard')).toEqual([
      'master',
      'facts',
      'nouns',
      'words',
      'idioms',
      'style',
      'headline',
    ])
    expect(rolesForDepth('deep')).toEqual([
      'master',
      'facts',
      'nouns',
      'words',
      'idioms',
      'style',
      'headline',
      'consistency',
    ])
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      expect(rolesForDepth(depth)).toContain('facts')
      expect(rolesForDepth(depth)).toContain('nouns')
      // The longest roles are scheduled right after the master role so they
      // overlap the shorter text roles under the global concurrency cap.
      expect(rolesForDepth(depth)[1]).toBe('facts')
      expect(rolesForDepth(depth)[2]).toBe('nouns')
    }
    // The text role sets are unchanged: only the network role was added.
    expect([...rolesForDepth('standard')].sort()).toEqual(
      ['facts', 'headline', 'idioms', 'master', 'nouns', 'style', 'words'].sort(),
    )
    expect([...rolesForDepth('deep')].sort()).toEqual(
      ['consistency', 'facts', 'headline', 'idioms', 'master', 'nouns', 'style', 'words'].sort(),
    )
  })

  it('maps depth to the noun-check plan/search budget', () => {
    expect(nounBudgetForDepth('quick')).toEqual({ maxNouns: 30, maxSearches: 40, resultsPerNoun: 5 })
    expect(nounBudgetForDepth('standard')).toEqual({
      maxNouns: 80,
      maxSearches: 120,
      resultsPerNoun: 5,
    })
    expect(nounBudgetForDepth('deep')).toEqual({
      maxNouns: 120,
      maxSearches: 180,
      resultsPerNoun: 5,
    })
  })

  it('defines high reasoning effort for every role (Task 25 live fix)', () => {
    expect(ROLE_REASONING_EFFORT).toEqual({
      master: 'high',
      facts: 'high',
      nouns: 'high',
      consistency: 'high',
      consolidator: 'high',
      words: 'high',
      idioms: 'high',
      style: 'high',
      headline: 'high',
    })
  })

  it('only uses reasoning efforts the provider supports (off|low|high|max)', () => {
    // Live regression: `deepseek-official/deepseek-flash` rejects `medium`
    // (`does not support reasoning effort "medium"`) and failed the four
    // language roles. Every per-role value must stay in the provider-supported
    // set; `low` is allowed by the provider but deliberately unused (accuracy).
    const supported = new Set(['off', 'low', 'high', 'max'])
    for (const [role, effort] of Object.entries(ROLE_REASONING_EFFORT)) {
      expect(supported.has(effort), `role ${role} uses unsupported effort ${effort}`).toBe(true)
    }
    expect(new Set(Object.values(ROLE_REASONING_EFFORT))).toEqual(new Set(['high']))
  })
})

/* ------------------------------------------------------------------------- */
/* Live fact-check plan/progress in GET /job (2026-11-20)                      */
/* ------------------------------------------------------------------------- */

describe('fact-check plan progress', () => {
  it('exposes the planned claims and final checked count through the job snapshot', async () => {
    const store = makeStore(makeDoc())
    let releaseSearch: (() => void) | undefined
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'nouns') return JSON.stringify({ nouns: [] })
      if (role !== 'facts') return JSON.stringify({ findings: [] })
      if (userText(request).includes('第一阶段')) {
        return JSON.stringify({
          claims: [
            {
              claim: '报道日期是2026年11月14日',
              quote: '2026年11月14日',
              kind: 'date',
              queries: ['2026年11月14日 报道'],
              priority: 1,
            },
          ],
        })
      }
      return JSON.stringify({
        verdicts: [
          {
            claim: '报道日期是2026年11月14日',
            verdict: 'confirmed',
            sources: [{ title: '来源', url: 'https://example.com/date' }],
            confidence: 'high',
          },
        ],
      })
    })
    const web = makeWeb({
      search: async () => {
        await searchGate
        return { content: '摘要', sources: [{ url: 'https://example.com/date', title: '来源' }], truncated: false }
      },
      fetch: (request) => ({ url: request.url, statusCode: 200, body: { kind: 'text', content: '正文' }, truncated: false }),
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    await vi.waitFor(() => {
      const progress = orchestrator.get(jobId)?.factProgress
      expect(progress?.total).toBe(1)
      expect(progress?.items[0]?.claim).toContain('2026年11月14日')
    })
    const live = orchestrator.get(jobId)?.factProgress
    expect(live?.phase).toBe('searching')
    expect(live?.items[0]?.priority).toBe(1)

    releaseSearch?.()
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const final = state.factProgress
    expect(final?.phase).toBe('done')
    expect(final?.checked).toBe(1)
    expect(final?.notChecked).toBe(0)
    expect(final?.items[0]?.status).toBe('checked')
    expect(final?.items[0]?.verdict).toBe('confirmed')
  })
})

/* ------------------------------------------------------------------------- */
/* Live noun-check plan/progress in GET /job                                   */
/* ------------------------------------------------------------------------- */

describe('noun-check plan progress', () => {
  it('exposes the planned nouns and the final checked count through the job snapshot', async () => {
    const store = makeStore(makeDoc())
    let releaseSearch: (() => void) | undefined
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    const llm = makeLlm((request) => {
      const role = roleOfSystem(request.system)
      if (role === 'facts') return JSON.stringify({ claims: [] })
      if (role === 'nouns') {
        return JSON.stringify({
          nouns: [
            {
              name: '脑机接口系统NEO',
              quote: '脑机接口系统NEO',
              kind: 'system',
              queries: ['NEO 脑机接口', '脑机接口系统NEO'],
              priority: 1,
            },
          ],
        })
      }
      return JSON.stringify({ findings: [] })
    })
    const web = makeWeb({
      search: async () => {
        await searchGate
        return {
          content: '',
          sources: [
            { url: 'https://example.com/neo', title: 'NEO 报道' },
            { url: 'https://www.wikipedia.org/wiki/NEO', title: 'NEO 维基' },
          ],
          truncated: false,
        }
      },
    })
    const { deps } = makeDeps({ store, llm, web })
    const orchestrator = createJobOrchestrator(deps)

    const jobId = await orchestrator.startProofread({
      docId: DOC_ID,
      articleIds: ['a1'],
      depth: 'quick',
      factCheck: true,
    })
    await vi.waitFor(() => {
      const progress = orchestrator.get(jobId)?.nounProgress
      expect(progress?.total).toBe(1)
      expect(progress?.items[0]?.name).toBe('脑机接口系统NEO')
    })
    const live = orchestrator.get(jobId)?.nounProgress
    expect(live?.phase).toBe('searching')
    expect(live?.items[0]?.priority).toBe(1)
    expect(live?.items[0]?.status).toBe('pending')
    expect(live?.items[0]?.id).toBe('a1:noun1')

    releaseSearch?.()
    const state = await waitForStatus(orchestrator, jobId, 'done')
    const final = state.nounProgress
    expect(final?.phase).toBe('done')
    expect(final?.checked).toBe(1)
    expect(final?.notChecked).toBe(0)
    expect(final?.items[0]?.status).toBe('checked')
    expect(final?.items[0]?.result).toBe('exists')
  })

  it('does not retry a noun-role timeout (fixed 9 min bound)', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore(makeDoc())
      const llm = makeLlm((request) => {
        if (roleOfSystem(request.system) !== 'nouns') return defaultReply(request)
        // Never settles and ignores the abort signal: the 9-minute bound races it.
        return new Promise<string>(() => {})
      })
      const { deps } = makeDeps({ store, llm })
      const orchestrator = createJobOrchestrator(deps)

      const jobId = await orchestrator.startProofread({
        docId: DOC_ID,
        articleIds: ['a1'],
        depth: 'quick',
        factCheck: false,
      })
      await vi.waitFor(() => expect(roleCalls(llm, 'nouns')).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(540_000)
      const state = await waitForStatus(orchestrator, jobId, 'done')

      const nounsStage = state.stages.find((stage) => stage.id === 'a1:nouns')
      expect(nounsStage?.status).toBe('failed')
      expect(nounsStage?.error).toContain('timed out')
      // A timeout is final: the retry would double the user-visible ceiling.
      expect(roleCalls(llm, 'nouns')).toHaveLength(1)
      expect(store.reports).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
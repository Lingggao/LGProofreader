/**
 * Tests for the independent Host noun checker (`src/host/proof/nouns.ts`).
 *
 * The LLM and web services are faked as plain objects (no module mocking), so the
 * tests drive the real planning call, query scheduling/budget, deterministic
 * existence classification, progress plan, time budget and cancellation end to
 * end. The checker never runs a verdict model call: existence is decided from
 * the collected `ctx.web` sources alone.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_NOUN_QUERIES_PER_NOUN,
  NOUN_DEEP_BUDGET,
  NOUN_HARD_STOP_MS,
  NOUN_QUICK_BUDGET,
  NOUN_SEARCH_CONCURRENCY,
  NOUN_SOFT_STOP_MS,
  NOUN_STANDARD_BUDGET,
  createNounChecker,
  isAuthoritativeSourceUrl,
  type NounCheckBudget,
  type NounProgressUpdate,
} from '../../src/host/proof/nouns'
import type { WebClient, WebSearchRequest, WebSearchResult } from '../../src/host/services/web-client'
import { NounsError } from '../../src/shared/proof/nouns'
import type { LlmRequest } from '../../src/host/services/llm-client'
import type { Article, NounCheck } from '../../src/shared/types'

const ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'normal',
  title: '文汇报版面',
  body: '复旦大学附属华山医院团队与脑机接口系统NEO亮相，这是错误的内容。',
  regionIds: [],
  readingOrder: 1,
  confidence: 1,
  warnings: [],
}

const CONTEXT = '文汇报 2026-11-14 第14版'

const SIGNAL = new AbortController().signal

/** A successful empty search result; `truncated` is always false in fixtures. */
function searchOk(sources: { url: string; title?: string; snippet?: string }[] = []): WebSearchResult {
  return { sources, truncated: false }
}

/** One valid planning row; each test overrides what it needs. */
function nounRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '复旦大学附属华山医院',
    quote: '复旦大学附属华山医院团队',
    kind: 'institution',
    queries: ['复旦大学附属华山医院', '华山医院'],
    priority: 1,
    ...overrides,
  }
}

interface PromptFixture {
  library: { version: string; roles: string[]; compose: ReturnType<typeof vi.fn> }
  compose: ReturnType<typeof vi.fn>
}

/** Fake prompt library: records compose() calls and returns marker text. */
function makePrompts(): PromptFixture {
  const compose = vi.fn(() => ({ system: 'SYS-PROMPT', user: 'USER-PROMPT' }))
  return { compose, library: { version: 'v1', roles: ['nouns'], compose } }
}

interface LlmFixture {
  llm: { complete: ReturnType<typeof vi.fn> }
  complete: ReturnType<typeof vi.fn>
  calls: LlmRequest[]
}

/** Fake LLM client that answers from a fixed reply; the checker calls it once. */
function makeLlm(reply: string | Error): LlmFixture {
  const calls: LlmRequest[] = []
  const complete = vi.fn(async (request: LlmRequest) => {
    calls.push(request)
    if (reply instanceof Error) throw reply
    return { text: reply }
  })
  return { complete, calls, llm: { complete } }
}

interface WebFixture {
  web: WebClient
  search: ReturnType<typeof vi.fn>
}

/** Fake web service; the handler defaults to an empty hit list. */
function makeWeb(
  handler: (request: WebSearchRequest, signal: AbortSignal) => WebSearchResult | Promise<WebSearchResult> = () =>
    searchOk(),
): WebFixture {
  const search = vi.fn(async (request: WebSearchRequest, signal: AbortSignal) => {
    return handler(request, signal)
  })
  return { search, web: { search, fetch: vi.fn() } as unknown as WebClient }
}

interface CheckerFixture {
  checker: ReturnType<typeof createNounChecker>
  llm: LlmFixture
  prompts: PromptFixture
  web: WebFixture
}

/** Build a noun checker whose planning reply is `nouns` (rows or raw text). */
function makeChecker(options: {
  nouns: unknown[] | string
  web?: WebFixture
  budget?: Partial<NounCheckBudget>
  prompts?: PromptFixture
  onProgress?: (update: NounProgressUpdate) => void
  now?: () => number
  softStopMs?: number
  hardStopMs?: number
}): CheckerFixture {
  const prompts = options.prompts ?? makePrompts()
  const reply =
    typeof options.nouns === 'string' ? options.nouns : JSON.stringify({ nouns: options.nouns })
  const llm = makeLlm(reply)
  const web = options.web ?? makeWeb()
  const checker = createNounChecker({
    llm: llm.llm as never,
    web: web.web as never,
    prompts: prompts.library as never,
    budget: { ...NOUN_STANDARD_BUDGET, ...options.budget },
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.softStopMs !== undefined ? { softStopMs: options.softStopMs } : {}),
    ...(options.hardStopMs !== undefined ? { hardStopMs: options.hardStopMs } : {}),
  })
  return { checker, llm, prompts, web }
}

/** The user text of one `LlmRequest`'s single text block. */
function userText(request: LlmRequest): string {
  const block = request.messages[0].content[0]
  if (block.type !== 'text') throw new Error('expected a text block')
  return block.text
}

async function checkError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the noun check to throw')
}

const QUICK = NOUN_QUICK_BUDGET
const STANDARD = NOUN_STANDARD_BUDGET
const DEEP = NOUN_DEEP_BUDGET

/* ------------------------------------------------------------------------- */
/* Budgets and contract constants                                              */
/* ------------------------------------------------------------------------- */

describe('noun-check budgets', () => {
  it('uses the documented depth budgets and time stops', () => {
    expect({ ...QUICK }).toEqual({ maxNouns: 30, maxSearches: 40, resultsPerNoun: 5 })
    expect({ ...STANDARD }).toEqual({ maxNouns: 80, maxSearches: 120, resultsPerNoun: 5 })
    expect({ ...DEEP }).toEqual({ maxNouns: 120, maxSearches: 180, resultsPerNoun: 5 })
    expect(NOUN_SOFT_STOP_MS).toBe(7 * 60_000)
    expect(NOUN_HARD_STOP_MS).toBe(8 * 60_000)
    expect(NOUN_SEARCH_CONCURRENCY).toBe(4)
    expect(MAX_NOUN_QUERIES_PER_NOUN).toBe(2)
  })

  it('recognizes the documented authoritative source domains only', () => {
    for (const url of [
      'https://baike.baidu.com/item/neo',
      'https://zh.wikipedia.org/wiki/NEO',
      'https://www.gov.cn/notice',
      'https://example.edu.cn/paper',
    ]) {
      expect(isAuthoritativeSourceUrl(url), url).toBe(true)
    }
    for (const url of [
      'https://example.com/neo',
      'https://gov.cn.evil.example/notice',
      'https://notedu.cn/paper',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isAuthoritativeSourceUrl(url), url).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Planning                                                                    */
/* ------------------------------------------------------------------------- */

describe('noun planning stage', () => {
  it('parses the prioritized plan and returns existence checks in plan order', async () => {
    const { checker, llm, prompts, web } = makeChecker({
      nouns: [
        nounRow({ name: '低优先名词', quote: '低优先名词', priority: 2, queries: ['低优先'] }),
        nounRow({ name: '高优先名词', quote: '高优先名词', priority: 1, queries: ['高优先'] }),
      ],
      web: makeWeb(() => searchOk([{ url: 'https://example.com/x', title: '来源' }])),
    })

    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)

    // Priority order, not extraction order, and local ids `noun1…`.
    expect(checks.map((check) => check.name)).toEqual(['高优先名词', '低优先名词'])
    expect(checks.map((check) => check.id)).toEqual(['noun1', 'noun2'])
    expect(checks.map((check) => check.articleId)).toEqual(['a1', 'a1'])
    expect(checks.map((check) => check.priority)).toEqual([1, 2])
    expect(checks.map((check) => check.kind)).toEqual(['institution', 'institution'])
    expect(checks[0].quote).toBe('高优先名词')

    // Exactly one planning model call, composed with the `nouns` role prompt.
    expect(llm.calls).toHaveLength(1)
    expect(userText(llm.calls[0])).toContain('USER-PROMPT')
    expect(prompts.compose).toHaveBeenCalledTimes(1)
    expect((prompts.compose.mock.calls[0] as unknown[])[0]).toBe('nouns')
    expect(llm.calls[0].system).toBe('SYS-PROMPT')
    // A single source per noun is "uncertain", never a non-existence claim.
    expect(checks.every((check) => check.status === 'uncertain')).toBe(true)
    expect(web.search).toHaveBeenCalled()
  })

  it('dedupes the same normalized noun and keeps the highest priority', async () => {
    const { checker } = makeChecker({
      nouns: [
        nounRow({ name: '脑智天地', priority: 5, quote: '园区', kind: 'place' }),
        nounRow({ name: ' 脑智天地 ', priority: 2, quote: '另一个引用', kind: 'project' }),
      ],
      web: makeWeb(() => searchOk([{ url: 'https://example.com/y' }])),
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: '脑智天地', priority: 2, quote: '园区' })
    expect(checks[0].status).toBe('uncertain')
  })

  it('returns an empty checklist and no searches when the plan is empty', async () => {
    const updates: NounProgressUpdate[] = []
    const { checker, llm, web } = makeChecker({
      nouns: [],
      onProgress: (update) => updates.push(update),
    })
    expect(await checker.check(ARTICLE, CONTEXT, SIGNAL)).toEqual([])
    expect(llm.calls).toHaveLength(1)
    expect(web.search).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ phase: 'done', articleId: 'a1', items: [] })
  })

  it('propagates malformed planner output before any search runs', async () => {
    const { checker, web } = makeChecker({ nouns: 'not json' })
    const error = await checkError(checker.check(ARTICLE, CONTEXT, SIGNAL))
    expect(error).toBeInstanceOf(NounsError)
    expect(web.search).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------------- */
/* Deterministic existence classification                                      */
/* ------------------------------------------------------------------------- */

describe('existence classification', () => {
  it('marks a noun with two distinct URLs as existing with medium confidence', async () => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() =>
        searchOk([
          { url: 'https://example.com/a', title: '来源甲' },
          { url: 'https://example.com/b', title: '来源乙' },
          { url: 'https://example.com/a', title: '来源甲重复' },
        ]),
      ),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check).toMatchObject({ status: 'exists', confidence: 'medium', needsHuman: false })
    expect(check.sources).toEqual([
      { title: '来源甲', url: 'https://example.com/a' },
      { title: '来源乙', url: 'https://example.com/b' },
    ])
    expect(check.evidence).toContain('2 个来源')
  })

  it('marks three distinct URLs as existing with high confidence', async () => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() =>
        searchOk([
          { url: 'https://example.com/a', title: '来源甲' },
          { url: 'https://example.com/b', title: '来源乙' },
          { url: 'https://example.com/c', title: '来源丙' },
        ]),
      ),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check).toMatchObject({ status: 'exists', confidence: 'high' })
    expect(check.sources).toHaveLength(3)
  })

  it.each([
    'https://baike.baidu.com/item/x',
    'https://zh.wikipedia.org/wiki/X',
    'https://www.gov.cn/notice',
    'https://example.edu.cn/paper',
  ])('treats one authoritative source (%s) as existing with high confidence', async (url) => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() => searchOk([{ url, title: '权威来源' }])),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check).toMatchObject({ status: 'exists', confidence: 'high', needsHuman: false })
    expect(check.sources).toHaveLength(1)
  })

  it('marks exactly one non-authoritative source as uncertain and needs-human', async () => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb((request) =>
        request.query === '复旦大学附属华山医院'
          ? searchOk()
          : searchOk([{ url: 'https://example.com/a', title: '来源' }]),
      ),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check).toMatchObject({ status: 'uncertain', confidence: 'low', needsHuman: true })
    expect(check.sources).toHaveLength(1)
    expect(check.evidence).toContain('需人工确认')
    expect(check.evidence).not.toContain('不存在')
  })

  it('marks a completed search with no source as not_found, never as non-existence', async () => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() => searchOk([])),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check).toMatchObject({
      status: 'not_found',
      confidence: 'low',
      needsHuman: true,
      sources: [],
    })
    expect(check.evidence).toContain('不能据此判定该名词不存在')
  })

  it('keeps a not_checked row when every search fails', async () => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() => {
        throw new Error('provider down')
      }),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check).toMatchObject({ status: 'not_checked', confidence: 'low', needsHuman: false })
    expect(check.sources).toEqual([])
    expect(check.evidence).toContain('联网检索失败')
  })

  it('never issues a second model call for a verdict', async () => {
    const { checker, llm } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() => searchOk([{ url: 'https://example.com/a' }])),
    })
    await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(llm.calls).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------- */
/* Search caps and budgets                                                     */
/* ------------------------------------------------------------------------- */

describe('search caps and budgets', () => {
  it('runs at most two distinct query variants per noun', async () => {
    const { checker, web } = makeChecker({
      nouns: [
        nounRow({
          queries: ['查询甲', '查询乙', '查询丙', '查询甲'],
        }),
      ],
      web: makeWeb(() => searchOk()),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(web.search).toHaveBeenCalledTimes(2)
    expect((web.search.mock.calls as unknown[][]).map((call) => (call[0] as { query: string }).query)).toEqual([
      '查询甲',
      '查询乙',
    ])
    expect(check.status).toBe('not_found')
  })

  it('stops the query variants once enough evidence is collected', async () => {
    const { checker, web } = makeChecker({
      nouns: [nounRow({ queries: ['查询甲', '查询乙'] })],
      web: makeWeb(() =>
        searchOk([
          { url: 'https://example.com/a', title: '来源甲' },
          { url: 'https://example.com/b', title: '来源乙' },
        ]),
      ),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(web.search).toHaveBeenCalledTimes(1)
    expect(check).toMatchObject({ status: 'exists', confidence: 'medium' })
  })

  it('enforces the global maxSearches budget exactly and lists untouched nouns not_checked', async () => {
    const nouns = ['甲', '乙', '丙', '丁'].map((name, index) =>
      nounRow({ name, quote: name, priority: index + 1, queries: [`query-${name}`] }),
    )
    const { checker, web } = makeChecker({
      nouns,
      budget: { maxNouns: 10, maxSearches: 3 },
      web: makeWeb(() => searchOk()),
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(web.search).toHaveBeenCalledTimes(3)
    expect(checks.map((check) => check.status)).toEqual([
      'not_found',
      'not_found',
      'not_found',
      'not_checked',
    ])
    expect(checks[3].evidence).toContain('预算')
  })

  it('marks every noun not_checked when maxSearches is zero (no silent drop)', async () => {
    const { checker, web } = makeChecker({
      nouns: [nounRow(), nounRow({ name: '另一个名词', quote: '另一个名词' })],
      budget: { maxSearches: 0 },
      web: makeWeb(),
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(web.search).not.toHaveBeenCalled()
    expect(checks).toHaveLength(2)
    expect(checks.every((check) => check.status === 'not_checked')).toBe(true)
    expect(checks.every((check) => check.evidence?.includes('预算'))).toBe(true)
  })

  it('lists nouns beyond maxNouns as not_checked instead of dropping them', async () => {
    const { checker } = makeChecker({
      nouns: [
        nounRow({ name: '甲', quote: '甲', priority: 1 }),
        nounRow({ name: '乙', quote: '乙', priority: 2 }),
      ],
      budget: { maxNouns: 1, maxSearches: 10 },
      web: makeWeb(() => searchOk()),
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(checks).toHaveLength(2)
    expect(checks[0].status).toBe('not_found')
    expect(checks[1]).toMatchObject({ status: 'not_checked', priority: 2, sources: [] })
  })

  it('caps the sources kept per noun with resultsPerNoun', async () => {
    const sources = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({
      url: `https://example.com/${name}`,
      title: `来源${name}`,
    }))
    const { checker } = makeChecker({
      nouns: [nounRow()],
      budget: { resultsPerNoun: 2 },
      web: makeWeb(() => searchOk(sources)),
    })
    const [check] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(check.sources).toHaveLength(2)
    expect(check.status).toBe('exists')
  })

  it('isolates one failed concurrent query instead of failing the whole check', async () => {
    const { checker } = makeChecker({
      nouns: [
        nounRow({ name: '甲', quote: '甲', priority: 1, queries: ['fail'] }),
        nounRow({ name: '乙', quote: '乙', priority: 2, queries: ['ok'] }),
      ],
      web: makeWeb((request) => {
        if (request.query === 'fail') throw new Error('search provider down')
        return searchOk([
          { url: 'https://example.com/a', title: '来源甲' },
          { url: 'https://example.com/b', title: '来源乙' },
        ])
      }),
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(checks[0].status).toBe('not_checked')
    expect(checks[1].status).toBe('exists')
  })

  it('bounds concurrent searches at four', async () => {
    let active = 0
    let peak = 0
    const { checker } = makeChecker({
      nouns: ['甲', '乙', '丙', '丁', '戊', '己'].map((name, index) =>
        nounRow({ name, quote: name, priority: index + 1, queries: [`query-${name}`] }),
      ),
      web: makeWeb(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return searchOk([{ url: `https://example.com/${active}` }])
      }),
    })
    await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(peak).toBe(NOUN_SEARCH_CONCURRENCY)
  })
})

/* ------------------------------------------------------------------------- */
/* Live progress plan                                                          */
/* ------------------------------------------------------------------------- */

describe('noun progress plan', () => {
  it('emits after planning, after each search round and after the final statuses', async () => {
    const updates: NounProgressUpdate[] = []
    const { checker } = makeChecker({
      nouns: [
        nounRow({ name: '低优先名词', quote: '低优先名词', priority: 2, queries: ['q-low'] }),
        nounRow({ name: '高优先名词', quote: '高优先名词', priority: 1, queries: ['q-high'] }),
      ],
      web: makeWeb((request) =>
        request.query === 'q-high'
          ? searchOk([
              { url: 'https://example.com/high1', title: '高优先来源一' },
              { url: 'https://example.com/high2', title: '高优先来源二' },
            ])
          : searchOk([{ url: 'https://example.com/low', title: '低优先来源' }]),
      ),
      onProgress: (update) => updates.push(update),
      now: () => 1_000,
    })

    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(checks).toHaveLength(2)
    expect(updates.length).toBeGreaterThanOrEqual(3)

    // The first update is the planned, priority-ordered plan.
    const plan = updates[0]
    expect(plan.phase).toBe('searching')
    expect(plan.articleId).toBe('a1')
    expect(plan.startedAt).toBe(1_000)
    expect(plan.softDeadlineAt).toBe(1_000 + NOUN_SOFT_STOP_MS)
    expect(plan.hardDeadlineAt).toBe(1_000 + NOUN_HARD_STOP_MS)
    expect(plan.items.map((item) => item.id)).toEqual(['a1:noun1', 'a1:noun2'])
    expect(plan.items.map((item) => item.name)).toEqual(['高优先名词', '低优先名词'])
    expect(plan.items.every((item) => item.status === 'pending')).toBe(true)
    expect(plan.items.every((item) => item.searched === false)).toBe(true)

    // The final update carries the exact final statuses as `checked` rows.
    const final = updates[updates.length - 1]
    expect(final.phase).toBe('done')
    expect(final.items.map((item) => item.status)).toEqual(['checked', 'checked'])
    expect(final.items.map((item) => item.result)).toEqual(['exists', 'uncertain'])
    expect(final.items.every((item) => item.searched)).toBe(true)
  })

  it('reports nouns skipped by the search budget as not_checked from the start', async () => {
    const updates: NounProgressUpdate[] = []
    const { checker } = makeChecker({
      nouns: [
        nounRow({ name: '甲', quote: '甲', priority: 1 }),
        nounRow({ name: '乙', quote: '乙', priority: 2 }),
      ],
      budget: { maxNouns: 1 },
      web: makeWeb(() => searchOk()),
      onProgress: (update) => updates.push(update),
    })
    await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(updates[0].items.map((item) => item.status)).toEqual(['pending', 'not_checked'])
  })
})

/* ------------------------------------------------------------------------- */
/* Time budget and cancellation                                                */
/* ------------------------------------------------------------------------- */

describe('time budget and cancellation', () => {
  it('stops scheduling searches at the soft deadline and lists unfinished nouns as not_checked', async () => {
    const updates: NounProgressUpdate[] = []
    const { checker, llm, web } = makeChecker({
      nouns: [nounRow(), nounRow({ name: '另一个名词', quote: '另一个名词', priority: 2 })],
      softStopMs: 0,
      onProgress: (update) => updates.push(update),
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(llm.calls).toHaveLength(1)
    expect(web.search).not.toHaveBeenCalled()
    expect(checks.map((check) => check.status)).toEqual(['not_checked', 'not_checked'])
    expect(checks.every((check) => check.evidence?.includes('时间预算'))).toBe(true)

    const final = updates[updates.length - 1]
    expect(final.phase).toBe('done')
    expect(final.items.every((item) => item.status === 'not_checked')).toBe(true)
    expect(final.softDeadlineAt).toBe(final.startedAt)
  })

  it('stops before the next round when the clock reaches the hard stop', async () => {
    const updates: NounProgressUpdate[] = []
    const timestamps = [0, 100, 8 * 60_000]
    let index = 0
    const { checker, web } = makeChecker({
      nouns: [nounRow({ queries: ['q1', 'q2'] })],
      hardStopMs: 8 * 60_000,
      // A far-away soft stop isolates the hard-stop check.
      softStopMs: 60 * 60_000,
      web: makeWeb(() => searchOk()),
      onProgress: (update) => updates.push(update),
      now: () => timestamps[Math.min(index++, timestamps.length - 1)],
    })
    const checks = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    // Round one ran one query; the hard stop then ended the second round.
    expect(web.search).toHaveBeenCalledTimes(1)
    expect(checks[0].status).toBe('not_found')
    expect(updates[updates.length - 1].phase).toBe('done')
  })

  it('rejects an already-aborted check before calling the model', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before start')
    controller.abort(reason)
    const { checker, llm, web } = makeChecker({ nouns: [] })
    expect(await checkError(checker.check(ARTICLE, CONTEXT, controller.signal))).toBe(reason)
    expect(llm.calls).toHaveLength(0)
    expect(web.search).not.toHaveBeenCalled()
  })

  it('rethrows cancellation instead of converting it into not_checked rows', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during search')
    const web = makeWeb(
      (_request, signal) =>
        new Promise<WebSearchResult>((_resolve, reject) => {
          const abort = (): void => reject(signal.reason ?? reason)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
    )
    const { checker } = makeChecker({ nouns: [nounRow()], web })
    const pending = checker.check(ARTICLE, CONTEXT, controller.signal)
    await vi.waitFor(() => expect(web.search).toHaveBeenCalled())
    controller.abort(reason)
    expect(await checkError(pending)).toBe(reason)
  })
})

/* ------------------------------------------------------------------------- */
/* No findings                                                                */
/* ------------------------------------------------------------------------- */

describe('existence-only role output', () => {
  it('returns NounCheck rows stamped with the article id and never a finding', async () => {
    const { checker } = makeChecker({
      nouns: [nounRow()],
      web: makeWeb(() => searchOk([{ url: 'https://example.com/a' }])),
    })
    const checks: NounCheck[] = await checker.check(ARTICLE, CONTEXT, SIGNAL)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ articleId: 'a1', name: '复旦大学附属华山医院', id: 'noun1' })
    // The returned row has no finding fields at all.
    expect(checks[0]).not.toHaveProperty('issue')
    expect(checks[0]).not.toHaveProperty('suggestion')
    expect(checks[0]).not.toHaveProperty('severity')
  })
})

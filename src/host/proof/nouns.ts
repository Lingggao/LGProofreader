/**
 * Independent network noun checking ("联网名词核查") for the Ling Gao 校对员
 * (Ling Gao Proofreader) plugin.
 *
 * The `nouns` role answers one narrow question: **does this named entity/term
 * appear in web evidence at all?** It never judges whether a sentence is true and
 * never emits `Finding`s; the report lists every planned noun with an
 * existence-only status.
 *
 * The Host drives two deterministic stages:
 *
 * 1. **planning** — one `nouns` model call (through the role prompt) returns a
 *    prioritized `{ nouns: [{ name, quote, kind, queries, priority }] }` list.
 *    The reply is validated by Task X's `parseNounCandidates`; malformed output
 *    throws so the orchestrator can retry the role.
 * 2. **web search** — the Host (not the model) searches the query variants with
 *    `ctx.web` for the highest-priority nouns first. At most
 *    {@link MAX_NOUN_QUERIES_PER_NOUN} distinct queries run per noun, at most
 *    {@link NOUN_SEARCH_CONCURRENCY} searches run at once, and the per-depth
 *    noun/search budgets below bound the whole check. Searches are collected as
 *    distinct `{ title, url }` sources.
 *
 * Existence is then classified **deterministically from the collected sources**,
 * never by a second model call:
 *
 * - `exists` — at least two distinct URLs, or one authoritative source
 *   (`baike.baidu.com`, `wikipedia.org`, `.gov.cn`, `.edu.cn`);
 * - `uncertain` — exactly one non-authoritative source;
 * - `not_found` — the searches completed but returned no source;
 * - `not_checked` — time/budget/a failed search prevented checking.
 *
 * A missing source is **never** reported as non-existence: `uncertain` and
 * `not_found` carry a "cannot prove the name does not exist" evidence text and
 * `needsHuman: true`. Every planned noun stays in the returned checklist; nouns
 * dropped by the noun/search budget are listed as `not_checked` instead of being
 * silently discarded.
 *
 * Host-only module: no React/DSH imports and no npm dependencies.
 */
import type {
  Article,
  ArticleId,
  Confidence,
  FactCheckProgressPhase,
  NounCheck,
  NounCheckKind,
  NounCheckStatus,
  NounProgressItem,
  PromptLibrary,
} from '../../shared/types'
import { type NounCandidate, parseNounCandidates } from '../../shared/proof/nouns'
import { mapWithConcurrency } from '../../shared/async'
import type { LlmClient, LlmMessage, LlmRequest } from '../services/llm-client'
import type { WebClient, WebSearchResult } from '../services/web-client'

/* ------------------------------------------------------------------------- */
/* Public API                                                                  */
/* ------------------------------------------------------------------------- */

/** Per-article noun-check budget (derived from the depth preset). */
export interface NounCheckBudget {
  /** Max nouns scheduled for searching; the rest become `not_checked`. */
  maxNouns: number
  /** Max real `web.search` calls per article. */
  maxSearches: number
  /** `maxResults` asked from each search; also caps sources kept per noun. */
  resultsPerNoun: number
}

/**
 * Depth → noun/search budget. A normal article has far fewer nouns than these
 * caps; the 7-minute soft stop is the real limit, the counts are a safety valve
 * for pathological pages.
 */
export const NOUN_QUICK_BUDGET: Readonly<NounCheckBudget> = Object.freeze({
  maxNouns: 30,
  maxSearches: 40,
  resultsPerNoun: 5,
})
export const NOUN_STANDARD_BUDGET: Readonly<NounCheckBudget> = Object.freeze({
  maxNouns: 80,
  maxSearches: 120,
  resultsPerNoun: 5,
})
export const NOUN_DEEP_BUDGET: Readonly<NounCheckBudget> = Object.freeze({
  maxNouns: 120,
  maxSearches: 180,
  resultsPerNoun: 5,
})

/** Default (standard-depth) budget for callers that do not derive one. */
export const DEFAULT_NOUN_BUDGET: Readonly<NounCheckBudget> = NOUN_STANDARD_BUDGET

/** Soft stop: stop scheduling new searches and wrap up the collected evidence. */
export const NOUN_SOFT_STOP_MS = 7 * 60 * 1000
/** Hard stop: the noun-check role should not run longer than this (Host timeout is 9 min). */
export const NOUN_HARD_STOP_MS = 8 * 60 * 1000

/**
 * Max `web.search` calls in flight at once.
 *
 * The network is the shared Host seam, so the cap stays small; the noun/search
 * budget still bounds the total. Searches are dispatched in priority/noun order
 * and the collected evidence keeps a deterministic order, so bounded concurrency
 * never changes the checklist.
 */
export const NOUN_SEARCH_CONCURRENCY = 4

/** Max distinct queries executed per noun (the role prompt asks for 2–3 variants). */
export const MAX_NOUN_QUERIES_PER_NOUN = 2

/** Distinct sources that stop a noun's remaining query variants early. */
const ENOUGH_SOURCES = 2

/**
 * Hosts whose single source is enough to mark a noun `exists` with high
 * confidence: encyclopaedias and the official/government/education domains.
 */
export const AUTHORITATIVE_NOUN_HOSTS: readonly string[] = Object.freeze([
  'baike.baidu.com',
  'wikipedia.org',
])
/** Domain suffixes treated as authoritative; a match must be on a label boundary. */
export const AUTHORITATIVE_NOUN_SUFFIXES: readonly string[] = Object.freeze([
  'gov.cn',
  'edu.cn',
])

/** One live progress snapshot for one article's noun-check plan. */
export interface NounProgressUpdate {
  articleId: ArticleId
  items: NounProgressItem[]
  phase: FactCheckProgressPhase
  startedAt: number
  softDeadlineAt: number
  hardDeadlineAt: number
}

/** Dependencies of {@link createNounChecker}. */
export interface NounCheckerDeps {
  llm: LlmClient
  web: WebClient
  prompts: PromptLibrary
  budget: NounCheckBudget
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
  /** Soft stop in ms from the start of one check; defaults to 7 minutes. */
  softStopMs?: number
  /** Hard stop in ms from the start of one check; defaults to 8 minutes. */
  hardStopMs?: number
  /** Receives the live plan after planning, after each search round and at the end. */
  onProgress?: (update: NounProgressUpdate) => void
}

/** Two-stage noun checker seam used by the `nouns` role worker. */
export interface NounChecker {
  /**
   * Run the planning call plus the Host web searches for one article and return
   * one {@link NounCheck} per planned noun, in priority plan order (`noun1…`).
   */
  check(article: Article, context: string, signal: AbortSignal): Promise<NounCheck[]>
}

/**
 * Create one noun checker bound to the LLM client, web seam, prompt library and
 * per-article budget of the current job. The checker keeps no state between
 * `check()` calls, so two articles never share search evidence.
 */
export function createNounChecker(deps: NounCheckerDeps): NounChecker {
  const now = deps.now ?? Date.now

  return {
    async check(article: Article, context: string, signal: AbortSignal): Promise<NounCheck[]> {
      signal.throwIfAborted()
      const prompt = deps.prompts.compose('nouns', { article, context })
      const startedAt = now()
      const softDeadlineAt = startedAt + positiveMs(deps.softStopMs, NOUN_SOFT_STOP_MS)
      const hardDeadlineAt = startedAt + positiveMs(deps.hardStopMs, NOUN_HARD_STOP_MS)
      const budget = normalizeBudget(deps.budget)
      const emitProgress = (
        phase: FactCheckProgressPhase,
        candidates: readonly NounCandidate[],
        evidence: readonly NounEvidence[],
        scheduled: ReadonlySet<number>,
        planRank: readonly number[],
        finalChecks?: readonly NounCheck[],
      ): void => {
        deps.onProgress?.({
          articleId: article.id,
          items: buildNounProgressItems(
            article,
            candidates,
            evidence,
            scheduled,
            planRank,
            finalChecks,
          ),
          phase,
          startedAt,
          softDeadlineAt,
          hardDeadlineAt,
        })
      }

      // Stage 1: one planning call for the prioritized noun + query list.
      const reply = await complete(deps.llm, prompt.system, [prompt.user, PLAN_REMINDER], signal)
      const candidates = parseNounCandidates(reply)
      if (candidates.length === 0) {
        emitProgress('done', candidates, [], new Set(), [])
        return []
      }

      // Plan order: lowest priority number first, ties keep extraction order.
      // `planRank[extractionIndex]` is the rank used for the local `noun<n>` ids
      // and the progress rows, so both stay in priority order.
      const order = candidates
        .map((_, index) => index)
        .sort((left, right) => candidates[left].priority - candidates[right].priority || left - right)
      const planRank = candidates.map(() => 0)
      order.forEach((candidateIndex, rank) => {
        planRank[candidateIndex] = rank
      })
      const scheduledOrder = order.slice(0, Math.min(budget.maxNouns, candidates.length))
      const scheduled = new Set(scheduledOrder)
      const evidence = candidates.map(() => emptyEvidence())
      const queries = candidates.map((candidate) => searchQueries(candidate))
      emitProgress('searching', candidates, evidence, scheduled, planRank)

      // Stage 2: Host web searches. One new query per noun per round keeps the
      // priority order observable while different nouns' searches overlap with
      // bounded concurrency. Evidence is attached synchronously when each search
      // settles, so the returned sources are deterministic.
      const cursor = candidates.map(() => 0)
      const settled = new Set<number>()
      let searches = 0
      let timedOut = false
      const timeLimitReached = (): boolean => {
        const timestamp = now()
        return timestamp >= softDeadlineAt || timestamp >= hardDeadlineAt
      }

      for (;;) {
        signal.throwIfAborted()
        if (timeLimitReached()) {
          timedOut = true
          break
        }
        const needs: NounSearchNeed[] = []
        for (const index of scheduledOrder) {
          if (settled.has(index)) continue
          const item = evidence[index]
          if (hasEnoughEvidence(item) || cursor[index] >= queries[index].length) {
            settled.add(index)
            continue
          }
          if (searches + needs.length >= budget.maxSearches) {
            item.budgetBlocked = true
            settled.add(index)
            continue
          }
          const query = queries[index][cursor[index]]
          cursor[index] += 1
          needs.push({ index, query })
        }
        if (needs.length === 0) break
        await mapWithConcurrency(needs, NOUN_SEARCH_CONCURRENCY, async (need) => {
          const item = evidence[need.index]
          try {
            const result = await deps.web.search(
              { query: need.query, maxResults: budget.resultsPerNoun },
              signal,
            )
            item.searched = true
            item.successSearches += 1
            collectSources(item, result, budget.resultsPerNoun)
          } catch (error) {
            // A cancelled check must surface its own error (never become a
            // `not_checked` row); a provider failure is recorded instead.
            if (signal.aborted) throw error
            item.searched = true
            item.failedSearches += 1
          }
        })
        searches += needs.length
        signal.throwIfAborted()
        emitProgress('searching', candidates, evidence, scheduled, planRank)
      }

      // Every planned noun is returned in priority order; nothing is dropped.
      const checks = order.map((candidateIndex, rank) =>
        toNounCheck(
          article,
          candidates[candidateIndex],
          rank,
          evidence[candidateIndex],
          scheduled.has(candidateIndex),
          timedOut,
        ),
      )
      emitProgress('done', candidates, evidence, scheduled, planRank, checks)
      return checks
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Model call                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Host-only directive appended to the composed `nouns` user message.
 *
 * The role prompt owns the responsibility and the JSON contract; this reminder
 * only keeps the single planning call focused on the Host's division of labour
 * (the model plans, the Host searches) and never contains a search conclusion.
 */
const PLAN_REMINDER = [
  '请执行名词核查的规划阶段：只列出值得联网核查的名词与查询词，由 Host 负责检索。',
  '只输出 {"nouns":[...]} JSON（不要 findings、不要 Markdown、不要判断存在与否）；没有可核查名词时输出 {"nouns":[]}。',
].join('\n')

/** Send the one planning request through the injected client. */
async function complete(
  llm: LlmClient,
  system: string,
  userParts: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const messages: LlmMessage[] = [
    { role: 'user', content: [{ type: 'text', text: userParts.join('\n') }] },
  ]
  const request: LlmRequest = { system, messages }
  const result = await llm.complete(request, signal)
  return result.text
}

/* ------------------------------------------------------------------------- */
/* Evidence collection and classification                                      */
/* ------------------------------------------------------------------------- */

/** One distinct search source (title already backfilled from the URL). */
interface NounSource {
  title: string
  url: string
}

/** Everything stage 2 collected for one noun. */
interface NounEvidence {
  sources: NounSource[]
  seenUrls: Set<string>
  /** True once at least one search query was executed (success or failure). */
  searched: boolean
  /** Searches that completed without throwing. */
  successSearches: number
  /** Searches that threw a provider/stage error (not cancellation). */
  failedSearches: number
  /** True when the global search budget prevented a planned query. */
  budgetBlocked: boolean
}

function emptyEvidence(): NounEvidence {
  return {
    sources: [],
    seenUrls: new Set(),
    searched: false,
    successSearches: 0,
    failedSearches: 0,
    budgetBlocked: false,
  }
}

/** One unique query dispatched in one stage-2 round. */
interface NounSearchNeed {
  /** Extraction-order index of the noun that reached the query. */
  index: number
  query: string
}

/** Distinct, non-empty query variants for one noun, capped at the per-noun limit. */
function searchQueries(candidate: NounCandidate): string[] {
  const queries: string[] = []
  for (const query of candidate.queries) {
    const trimmed = query.trim()
    if (trimmed === '' || queries.includes(trimmed)) continue
    queries.push(trimmed)
    if (queries.length >= MAX_NOUN_QUERIES_PER_NOUN) break
  }
  // `parseNounCandidates` always keeps at least the noun itself; stay defensive.
  return queries.length > 0 ? queries : [candidate.name]
}

/** True when the noun already has enough evidence to stop its query variants. */
function hasEnoughEvidence(evidence: NounEvidence): boolean {
  return (
    evidence.sources.length >= ENOUGH_SOURCES ||
    evidence.sources.some((source) => isAuthoritativeSourceUrl(source.url))
  )
}

/** Copy search hits into a noun's evidence, deduping URLs and capping at `limit`. */
function collectSources(evidence: NounEvidence, result: WebSearchResult, limit: number): void {
  for (const source of result.sources) {
    if (evidence.sources.length >= limit) break
    const url = source.url.trim()
    if (url === '' || evidence.seenUrls.has(url)) continue
    evidence.seenUrls.add(url)
    const title = source.title?.trim()
    evidence.sources.push({
      title: title !== undefined && title !== '' ? title : url,
      url,
    })
  }
}

/** True when `url` points at an authoritative encyclopaedia/official domain. */
export function isAuthoritativeSourceUrl(url: string): boolean {
  let hostname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    hostname = parsed.hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname === '') return false
  const hostMatches = (domain: string): boolean =>
    hostname === domain || hostname.endsWith(`.${domain}`)
  return (
    AUTHORITATIVE_NOUN_HOSTS.some(hostMatches) ||
    AUTHORITATIVE_NOUN_SUFFIXES.some(hostMatches)
  )
}

/** One noun converted to the report model (status/evidence/confidence only). */
function toNounCheck(
  article: Article,
  candidate: NounCandidate,
  rank: number,
  evidence: NounEvidence,
  scheduled: boolean,
  timedOut: boolean,
): NounCheck {
  const sources = evidence.sources.map((source) => ({ title: source.title, url: source.url }))
  const base: NounCheck = {
    id: `noun${rank + 1}`,
    articleId: article.id,
    name: candidate.name,
    quote: candidate.quote,
    kind: candidate.kind,
    priority: candidate.priority,
    status: 'not_checked',
    sources,
    confidence: 'low',
    needsHuman: false,
  }

  if (!scheduled) {
    return { ...base, evidence: notCheckedEvidence('budget'), sources: [] }
  }
  if (sources.length === 0) {
    if (evidence.successSearches > 0) {
      return {
        ...base,
        status: 'not_found',
        confidence: 'low',
        needsHuman: true,
        evidence: NOT_FOUND_EVIDENCE,
      }
    }
    if (evidence.searched) {
      return {
        ...base,
        status: 'not_checked',
        confidence: 'low',
        evidence: notCheckedEvidence('search'),
      }
    }
    return {
      ...base,
      status: 'not_checked',
      confidence: 'low',
      evidence: notCheckedEvidence(timedOut ? 'time' : 'budget'),
    }
  }

  const authoritative = sources.some((source) => isAuthoritativeSourceUrl(source.url))
  if (authoritative || sources.length >= ENOUGH_SOURCES) {
    let confidence: Confidence = 'medium'
    if (authoritative || sources.length >= 3) confidence = 'high'
    return {
      ...base,
      status: 'exists',
      confidence,
      needsHuman: false,
      evidence: existsEvidence(sources.length, authoritative),
    }
  }
  return {
    ...base,
    status: 'uncertain',
    confidence: 'low',
    needsHuman: true,
    evidence: UNCERTAIN_EVIDENCE,
  }
}

/** Max distinct sources shown per noun (kept aligned with the search request). */
function existsEvidence(count: number, authoritative: boolean): string {
  return `检索到 ${count} 个来源可佐证该名词存在${authoritative ? '（含权威来源）' : ''}。`
}

/** Exactly one non-authoritative source: existence is possible but unproven. */
const UNCERTAIN_EVIDENCE = '仅检索到一个来源，尚不足以确认该名词存在，需人工确认。'

/** Searches completed with no hit; never turn that into a non-existence claim. */
const NOT_FOUND_EVIDENCE = '检索完成但未找到匹配来源；不能据此判定该名词不存在，需人工确认。'

type NotCheckedReason = 'time' | 'budget' | 'search'

/** Explains why a noun stayed `not_checked`; never claims the noun is false. */
function notCheckedEvidence(reason: NotCheckedReason): string {
  switch (reason) {
    case 'time':
      return '名词核查时间预算已用完，未完成联网核查。'
    case 'search':
      return '联网检索失败，未完成名词核查。'
    case 'budget':
      return '超出本次名词核查预算，未完成联网核查。'
  }
}

/* ------------------------------------------------------------------------- */
/* Live progress plan                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Build the priority-ordered live plan rows for one article.
 *
 * `planRank` maps the extraction index to the rank (`noun<rank+1>`), so the live
 * rows already carry the same local ids as the final checklist. `finalChecks`
 * (plan order) supplies the exact final status/result labels.
 */
function buildNounProgressItems(
  article: Article,
  candidates: readonly NounCandidate[],
  evidence: readonly NounEvidence[],
  scheduled: ReadonlySet<number>,
  planRank: readonly number[],
  finalChecks?: readonly NounCheck[],
): NounProgressItem[] {
  return candidates
    .map((candidate, index): NounProgressItem & { index: number } => {
      const rank = planRank[index] ?? index
      const final = finalChecks?.[rank]
      const searched = evidence[index]?.searched === true
      let status: NounProgressItem['status']
      if (final !== undefined) {
        status = final.status === 'not_checked' ? 'not_checked' : 'checked'
      } else if (!scheduled.has(index)) {
        status = 'not_checked'
      } else if (searched) {
        status = 'searched'
      } else {
        status = 'pending'
      }
      const item: NounProgressItem & { index: number } = {
        id: `${article.id}:noun${rank + 1}`,
        articleId: article.id,
        name: candidate.name,
        quote: candidate.quote,
        kind: candidate.kind,
        priority: candidate.priority,
        searched,
        status,
        index,
      }
      if (final !== undefined) item.result = final.status
      return item
    })
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ index: _index, ...item }) => item)
}

/* ------------------------------------------------------------------------- */
/* Budget and time helpers                                                     */
/* ------------------------------------------------------------------------- */

function normalizeBudget(budget: NounCheckBudget): NounCheckBudget {
  return {
    maxNouns: clampInteger(budget.maxNouns, 0),
    maxSearches: clampInteger(budget.maxSearches, 0),
    resultsPerNoun: clampInteger(budget.resultsPerNoun, 1),
  }
}

function clampInteger(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : minimum
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/** Kind re-export so Host callers can narrow ids without importing shared types. */
export type { NounCheckKind, NounCheckStatus }

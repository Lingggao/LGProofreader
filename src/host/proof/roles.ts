/**
 * Role execution for one proofreading job (design §7.2, §7.5, §7.6).
 *
 * This module owns the deterministic part of the multi-role pipeline:
 *
 * - the role set of every depth preset — the `facts` and `nouns` roles run at
 *   **every** depth (设计 §7.2: 事实核查是所有深度的必选角色), only their network
 *   budget shrinks for `quick`; the worker order lists both network roles early
 *   so they overlap the shorter text roles while the global concurrency cap is
 *   saturated (Task 25);
 * - the depth → fact-check/noun-check budget mapping (fact checking: standard
 *   16 claims / 24 searches, deep 24 / 36, quick lower; nouns: quick 30/40,
 *   standard 80/120, deep 120/180);
 * - the role cache key `articleId|role|promptVersion|model|articleTextHash`,
 *   extended with the depth and the network mode for the network roles
 *   (`facts`, `nouns`);
 * - the per-role reasoning effort (Task 25: every role gets `high`, a
 *   provider-supported value that is still faster than the global `max`
 *   default; `medium` is rejected by `deepseek-official`), sent as a
 *   per-request override while the activation-level selection stays the
 *   fallback;
 * - one-attempt execution of a worker role: compose the Host prompt, call the
 *   model, validate the reply with Task 6's `parseFindings` (against the article
 *   **title + subtitle + body**, so a headline finding can locate a title or
 *   subtitle quote — Task 21d/21e), stamp `articleId`/`roles`; the `facts` role
 *   instead runs Task 12's three-stage fact checker and converts sourced
 *   contradictions into `must_fix` findings, and the `nouns` role runs the
 *   independent existence-only noun checker (no findings at all);
 * - one-attempt consolidator execution: merged findings → consolidator model
 *   call → validated final findings with the merged `roles`/`sources`/`evidence`
 *   restored and merged problems the model omitted re-attached.
 *
 * Retry/cancellation/timeout policy is the orchestrator's job: this module throws
 * on any failure (including caller cancellation) and the orchestrator retries
 * once, marks the role failed or cancels the job.
 *
 * Host-only module: Node's `crypto` for the text hash, no npm/DSH imports, and no
 * prompt text is ever persisted or returned to the API; only the prompt version
 * hash leaves the Host.
 */
import { createHash } from 'node:crypto'
import type {
  Article,
  Depth,
  FactCheck,
  Finding,
  NounCheck,
  PromptLibrary,
  RoleId,
} from '../../shared/types'
import { parseFindings } from '../../shared/proof/findings'
import type { LlmClient, LlmMessage } from '../services/llm-client'
import type { WebClient } from '../services/web-client'
import {
  DEFAULT_FACT_BUDGET,
  contradictionFindings,
  createFactChecker,
  type FactCheckBudget,
  type FactCheckProgressUpdate,
  type FactCheckerStats,
  type SaveEvidence,
} from './facts'
import {
  NOUN_DEEP_BUDGET,
  NOUN_QUICK_BUDGET,
  NOUN_STANDARD_BUDGET,
  createNounChecker,
  type NounCheckBudget,
  type NounProgressUpdate,
} from './nouns'
import { findingGroupKey, firstNonEmptyText, unionSources } from './report'

/* ------------------------------------------------------------------------- */
/* Depth presets                                                               */
/* ------------------------------------------------------------------------- */

/** Worker roles of the `quick` depth (design §7.2). */
export const QUICK_ROLES: readonly RoleId[] = Object.freeze([
  'master',
  'facts',
  'nouns',
  'words',
])

/**
 * Worker roles of the `standard` depth (the default).
 *
 * Task 25 ordering: the network roles (`facts`, then the independent `nouns`
 * role) run right after the master role so the longest roles overlap the shorter
 * text roles under the global concurrency cap instead of starting last and
 * pushing the job over their per-role timeout. The role *set* is the documented
 * standard preset.
 */
export const STANDARD_ROLES: readonly RoleId[] = Object.freeze([
  'master',
  'facts',
  'nouns',
  'words',
  'idioms',
  'style',
  'headline',
])

/** Worker roles of the `deep` depth: every role except the consolidator (same network-roles-early order). */
export const DEEP_ROLES: readonly RoleId[] = Object.freeze([
  'master',
  'facts',
  'nouns',
  'words',
  'idioms',
  'style',
  'headline',
  'consistency',
])

/** Depth → worker role list; the consolidator is added per article by the caller. */
export const DEPTH_ROLES: Readonly<Record<Depth, readonly RoleId[]>> = Object.freeze({
  quick: QUICK_ROLES,
  standard: STANDARD_ROLES,
  deep: DEEP_ROLES,
})

/** Display labels for job stages; deliberately contains no prompt text. */
export const ROLE_LABELS: Readonly<Record<RoleId, string>> = Object.freeze({
  master: '通读主审',
  words: '字词精校',
  idioms: '词语成语',
  style: '规范',
  facts: '事实核查',
  nouns: '名词核查',
  headline: '标题导语',
  consistency: '一致性',
  consolidator: '汇总裁决',
})

/** Known role ids, in pipeline order (Task 25: network roles early, consolidator last). */
export const ROLE_IDS: readonly RoleId[] = Object.freeze([
  'master',
  'facts',
  'nouns',
  'words',
  'idioms',
  'style',
  'headline',
  'consistency',
  'consolidator',
])

/**
 * Reasoning effort values accepted by the DSH provider (Task 25).
 *
 * Live verification showed `deepseek-official` rejects anything outside
 * `off|low|high|max` (`… does not support reasoning effort "medium"`), so the
 * role table below is typed against this exact set and pinned by a test.
 */
export type SupportedReasoningEffort = 'off' | 'low' | 'high' | 'max'

/**
 * Per-role reasoning effort (Task 25).
 *
 * Every role keeps a `high` effort: the key roles whose verdicts drive findings
 * (`master` full-reading review, `consistency`, `facts` verification and the
 * consolidator) need it for accuracy, and the mechanical language roles
 * (`words`/`idioms`/`style`/`headline`) use it too because the provider does
 * **not** support `medium` (runtime rejection) and the accuracy priority rules
 * out dropping to `low`. `high` is still cheaper/faster than the global default
 * `max`, so the per-request override keeps the latency win while every request
 * stays on a provider-supported value. The activation-level selection
 * (settings / `agentDefaultModel`) remains the fallback for requests that do
 * not set one.
 */
export const ROLE_REASONING_EFFORT: Readonly<Record<RoleId, SupportedReasoningEffort>> =
  Object.freeze({
    master: 'high',
    words: 'high',
    idioms: 'high',
    style: 'high',
    facts: 'high',
    nouns: 'high',
    headline: 'high',
    consistency: 'high',
    consolidator: 'high',
  })

/** Worker roles every depth preset must include (fact checking is mandatory). */
export const MANDATORY_ROLE: RoleId = 'facts'

/**
 * Worker roles for one depth. Unknown values throw instead of silently choosing a
 * preset, so a bad request cannot run the wrong (cheaper) pipeline.
 */
export function rolesForDepth(depth: Depth): readonly RoleId[] {
  const roles = (DEPTH_ROLES as Partial<Record<string, readonly RoleId[]>>)[depth]
  if (roles === undefined) throw new RangeError(`unknown proofreading depth: ${String(depth)}`)
  return roles
}

/* ------------------------------------------------------------------------- */
/* Fact-check budgets                                                          */
/* ------------------------------------------------------------------------- */

/**
 * `quick` budget: still covers a typical short article, but with a smaller
 * per-article cap; the 11-minute soft stop remains the real bound.
 */
export const QUICK_FACT_BUDGET: Readonly<FactCheckBudget> = Object.freeze({
  maxClaims: 48,
  maxSearches: 64,
  resultsPerClaim: 5,
  fetchPerClaim: 1,
})

/** `standard` budget: high safety cap; exhaustive behavior is bounded by time. */
export const STANDARD_FACT_BUDGET: Readonly<FactCheckBudget> = DEFAULT_FACT_BUDGET

/** `deep` budget: higher safety cap for long/important articles. */
export const DEEP_FACT_BUDGET: Readonly<FactCheckBudget> = Object.freeze({
  maxClaims: 400,
  maxSearches: 480,
  resultsPerClaim: 5,
  fetchPerClaim: 2,
})

/** Return a mutable copy of the depth's fact-check budget for one checker. */
export function factBudgetForDepth(depth: Depth): FactCheckBudget {
  if (depth === 'quick') return { ...QUICK_FACT_BUDGET }
  if (depth === 'standard') return { ...STANDARD_FACT_BUDGET }
  if (depth === 'deep') return { ...DEEP_FACT_BUDGET }
  throw new RangeError(`unknown proofreading depth: ${String(depth)}`)
}

/* ------------------------------------------------------------------------- */
/* Noun-check budgets                                                          */
/* ------------------------------------------------------------------------- */

/** `quick` noun budget: 30 nouns / 40 searches (from `src/host/proof/nouns.ts`). */
export const QUICK_NOUN_BUDGET: Readonly<NounCheckBudget> = NOUN_QUICK_BUDGET
/** `standard` noun budget: 80 nouns / 120 searches. */
export const STANDARD_NOUN_BUDGET: Readonly<NounCheckBudget> = NOUN_STANDARD_BUDGET
/** `deep` noun budget: 120 nouns / 180 searches. */
export const DEEP_NOUN_BUDGET: Readonly<NounCheckBudget> = NOUN_DEEP_BUDGET

/** Return a mutable copy of the depth's noun-check budget for one checker. */
export function nounBudgetForDepth(depth: Depth): NounCheckBudget {
  if (depth === 'quick') return { ...QUICK_NOUN_BUDGET }
  if (depth === 'standard') return { ...STANDARD_NOUN_BUDGET }
  if (depth === 'deep') return { ...DEEP_NOUN_BUDGET }
  throw new RangeError(`unknown proofreading depth: ${String(depth)}`)
}

/* ------------------------------------------------------------------------- */
/* Cache key                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Canonical article text used for the cache key: title/subtitle/byline/body in a
 * fixed order. Changing any field the roles can see invalidates the cache, not
 * only a body edit.
 */
export function articleCacheText(article: Article): string {
  return JSON.stringify([
    article.title,
    article.subtitle ?? '',
    article.byline ?? '',
    article.body,
  ])
}

/**
 * Identity of one role cache entry (design §7.5).
 *
 * `model` is the real model route label (`<provider>/<model>`), not only the model
 * name, so switching the provider invalidates the cache and the report identifies
 * the actual route.
 *
 * `depth` and `factCheck` are part of the identity **for the network roles**
 * (`facts`, `nouns`): their results depend on the depth-derived claim/noun/search
 * budget and on whether the network was enabled (an offline run only produces
 * `unverified` fact checks and `not_checked` noun checks). A quick/offline
 * network result must never be reused by a deep/online run. Other roles see
 * neither field, so their cache behavior is unchanged.
 */
export interface RoleCacheIdentity {
  articleId: string
  role: RoleId
  promptVersion: string
  model: string
  text: string
  /** Network roles only: depth preset that produced the result. */
  depth?: Depth
  /** Network roles only: whether network checking was enabled. */
  factCheck?: boolean
}

/**
 * Role cache key: `articleId|role|promptVersion|model|articleTextHash`, plus
 * `|depth|online|offline` for the `facts` and `nouns` roles.
 */
export function roleCacheKey(input: RoleCacheIdentity): string {
  const textHash = createHash('sha256').update(input.text, 'utf8').digest('hex')
  const base = `${input.articleId}|${input.role}|${input.promptVersion}|${input.model}|${textHash}`
  if (!isNetworkRole(input.role)) return base
  const depth = input.depth ?? ''
  const network = input.factCheck === undefined ? '' : input.factCheck ? 'online' : 'offline'
  return `${base}|${depth}|${network}`
}

/** Roles whose result depends on the depth budget and the network mode. */
function isNetworkRole(role: RoleId): boolean {
  return role === 'facts' || role === 'nouns'
}

/* ------------------------------------------------------------------------- */
/* Role execution                                                              */
/* ------------------------------------------------------------------------- */

/** One role's contribution to one article. */
export interface RoleRunResult {
  role: RoleId
  findings: Finding[]
  /** Present only for the `facts` role. */
  factChecks?: FactCheck[]
  /** Present only for the `nouns` role (existence-only checklist, no findings). */
  nounChecks?: NounCheck[]
}

/** Persisted role result (`reports/<jobId>/<articleId>/<role>.json`). */
export interface CachedRoleResult extends RoleRunResult {
  cacheKey: string
  articleId: string
  /** Network roles only: depth preset the result was produced with (cache identity). */
  depth?: Depth
  /** Network roles only: whether the network was enabled (cache identity). */
  factCheck?: boolean
}

/** Extra cache-identity fields persisted with a role result (network roles). */
export interface CachedRoleIdentity {
  depth?: Depth
  factCheck?: boolean
}

/** Dependencies of a single-job {@link RoleRunner}. */
export interface RoleRunnerDeps {
  llm: LlmClient
  web: WebClient
  prompts: PromptLibrary
  /** Depth-derived fact-check budget; one checker is created for the whole job. */
  factBudget: FactCheckBudget
  /** Depth-derived noun-check budget; one checker is created for the whole job. */
  nounBudget: NounCheckBudget
  /** Optional evidence sink, usually the store's role-result writer. */
  saveEvidence?: SaveEvidence
  /** Live claim-plan progress for the facts role. */
  onFactProgress?: (update: FactCheckProgressUpdate) => void
  /** Live noun-plan progress for the independent nouns role. */
  onNounProgress?: (update: NounProgressUpdate) => void
  /** Injectable clock for the network roles' time budgets (defaults to Date.now). */
  now?: () => number
  /** Facts soft stop/hard stop overrides; default 11/12 minutes. */
  factSoftStopMs?: number
  factHardStopMs?: number
  /** Nouns soft stop/hard stop overrides; default 7/8 minutes. */
  nounSoftStopMs?: number
  nounHardStopMs?: number
}

/** Per-job role executor: one fact/noun checker, one prompt library, retries outside. */
export interface RoleRunner {
  /** Run one worker role once; throws on model/validation/cancellation failure. */
  run(role: RoleId, article: Article, context: string, signal: AbortSignal): Promise<RoleRunResult>
  /** Run the consolidator once; throws on model/validation/cancellation failure. */
  consolidate(
    article: Article,
    context: string,
    findings: readonly Finding[],
    signal: AbortSignal,
  ): Promise<Finding[]>
  /** Cumulative fact-checker counters (search/fetch/model call counts). */
  factStats(): FactCheckerStats
}

/**
 * Create the role executor for one proofreading job.
 *
 * The fact and noun checkers are created once per runner, so they bound the
 * whole job's network work and their budgets apply per article `check()` call.
 */
export function createRoleRunner(deps: RoleRunnerDeps): RoleRunner {
  const factChecker = createFactChecker({
    // The fact checker issues its own extraction/verification calls; binding the
    // facts effort here covers both stages without teaching the checker about
    // role policy (Task 25: facts stays `high`; the parallel network stage
    // offsets its latency).
    llm: withReasoningEffort(deps.llm, ROLE_REASONING_EFFORT.facts),
    web: deps.web,
    prompts: deps.prompts,
    budget: deps.factBudget,
    ...(deps.saveEvidence !== undefined ? { saveEvidence: deps.saveEvidence } : {}),
    ...(deps.onFactProgress !== undefined ? { onProgress: deps.onFactProgress } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.factSoftStopMs !== undefined ? { softStopMs: deps.factSoftStopMs } : {}),
    ...(deps.factHardStopMs !== undefined ? { hardStopMs: deps.factHardStopMs } : {}),
  })
  const nounChecker = createNounChecker({
    llm: withReasoningEffort(deps.llm, ROLE_REASONING_EFFORT.nouns),
    web: deps.web,
    prompts: deps.prompts,
    budget: deps.nounBudget,
    ...(deps.onNounProgress !== undefined ? { onProgress: deps.onNounProgress } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.nounSoftStopMs !== undefined ? { softStopMs: deps.nounSoftStopMs } : {}),
    ...(deps.nounHardStopMs !== undefined ? { hardStopMs: deps.nounHardStopMs } : {}),
  })

  return {
    async run(
      role: RoleId,
      article: Article,
      context: string,
      signal: AbortSignal,
    ): Promise<RoleRunResult> {
      throwIfAborted(signal)
      if (role === 'facts') {
        const checks = await factChecker.check(article, context, signal)
        return { role, findings: contradictionFindings(checks), factChecks: checks }
      }
      if (role === 'nouns') {
        // Existence information only: the nouns role never emits findings.
        const checks = await nounChecker.check(article, context, signal)
        return { role, findings: [], nounChecks: checks }
      }
      const prompt = deps.prompts.compose(role, { article, context })
      const messages: LlmMessage[] = [
        { role: 'user', content: [{ type: 'text', text: prompt.user }] },
      ]
      const result = await deps.llm.complete(
        { system: prompt.system, messages, reasoningEffort: ROLE_REASONING_EFFORT[role] },
        signal,
      )
      const findings = parseFindings(result.text, findingLocationText(article)).map((finding) =>
        stampFinding(finding, article.id, role),
      )
      return { role, findings }
    },

    async consolidate(
      article: Article,
      context: string,
      findings: readonly Finding[],
      signal: AbortSignal,
    ): Promise<Finding[]> {
      throwIfAborted(signal)
      const prompt = deps.prompts.compose('consolidator', { article, context })
      const messages: LlmMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildConsolidatorUserMessage(prompt.user, findings) },
          ],
        },
      ]
      const result = await deps.llm.complete(
        {
          system: prompt.system,
          messages,
          reasoningEffort: ROLE_REASONING_EFFORT.consolidator,
        },
        signal,
      )
      const consolidated = parseFindings(result.text, findingLocationText(article)).map((finding) =>
        stampFinding(finding, article.id, 'consolidator'),
      )
      return reconcileConsolidatedFindings(article, findings, consolidated)
    },

    factStats(): FactCheckerStats {
      return factChecker.stats()
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Cached role results                                                         */
/* ------------------------------------------------------------------------- */

/** Build the JSON value persisted for one finished role. */
export function toCachedRoleResult(
  cacheKey: string,
  articleId: string,
  result: RoleRunResult,
  identity: CachedRoleIdentity = {},
): CachedRoleResult {
  const cached: CachedRoleResult = {
    cacheKey,
    articleId,
    role: result.role,
    findings: result.findings,
  }
  if (result.factChecks !== undefined) cached.factChecks = result.factChecks
  if (result.nounChecks !== undefined) cached.nounChecks = result.nounChecks
  // Network roles only: persist the depth/network part of the cache identity so
  // a stale quick/offline result can never be validated as a deep/online hit.
  if (identity.depth !== undefined) cached.depth = identity.depth
  if (identity.factCheck !== undefined) cached.factCheck = identity.factCheck
  return cached
}

/** Expected identity of a persisted role result; facts adds depth/network. */
export interface RoleCacheExpectation extends CachedRoleIdentity {
  cacheKey: string
}

/**
 * Read one persisted role result. A value written for a different cache key
 * (text/prompt/model changed) or with an unknown shape is ignored, so a stale
 * cache never feeds the report. When the expectation carries `depth`/`factCheck`
 * (the network roles), the persisted value must match them exactly; missing or
 * different values are a cache miss.
 */
export function readCachedRoleResult(
  value: unknown,
  expected: RoleCacheExpectation,
): RoleRunResult | undefined {
  if (!isRecord(value) || value.cacheKey !== expected.cacheKey) return undefined
  const role = value.role
  if (typeof role !== 'string' || !Object.hasOwn(ROLE_LABELS, role)) return undefined
  if (!Array.isArray(value.findings)) return undefined
  if (expected.depth !== undefined && value.depth !== expected.depth) return undefined
  if (expected.factCheck !== undefined && value.factCheck !== expected.factCheck) return undefined
  const result: RoleRunResult = {
    role: role as RoleId,
    findings: value.findings as Finding[],
  }
  if (value.factChecks !== undefined) {
    if (!Array.isArray(value.factChecks)) return undefined
    result.factChecks = value.factChecks as FactCheck[]
  }
  if (value.nounChecks !== undefined) {
    if (!Array.isArray(value.nounChecks)) return undefined
    result.nounChecks = value.nounChecks as NounCheck[]
  }
  return result
}

/* ------------------------------------------------------------------------- */
/* Consolidator payload and reconciliation                                     */
/* ------------------------------------------------------------------------- */

/** Host-only directive appended to the composed consolidator user message. */
const CONSOLIDATE_DIRECTIVE = [
  '请作为汇总裁决角色，只依据下面 <findings> 中的条目工作：',
  '1. 去重合并同一问题，保留最严重级别与最高置信度；',
  '2. 裁决互相矛盾的建议并给出最终建议，无法裁决时标 needs_human；',
  '3. 复核严重级别：must_fix 只留给确凿错误（错别字、事实错误、标点不配对、语法错误、明确误用）；',
  '4. 不新增任何角色未提出的问题，不改写全文，不输出 findings 契约之外的字段；',
  '5. 只输出 {"findings": [...], "notes": "..."} JSON，字段必须符合 findings 契约。',
].join('\n')

/** Build the consolidator user message: composed article prompt + findings JSON. */
function buildConsolidatorUserMessage(promptUser: string, findings: readonly Finding[]): string {
  return [
    promptUser,
    '',
    CONSOLIDATE_DIRECTIVE,
    '<findings>',
    serializeFindings(findings),
    '</findings>',
  ].join('\n')
}

/**
 * Serialize the merged findings for the consolidator. Field order is fixed and
 * only contract fields are included (roles/status/ids are Host bookkeeping).
 * Findings are untrusted model text, so a literal `</findings>` is escaped to
 * `\u003c/findings>`: the model reads the same characters but the data tag can
 * never be closed by an injected quote.
 */
function serializeFindings(findings: readonly Finding[]): string {
  const payload = { findings: findings.map(toConsolidatorInput) }
  return JSON.stringify(payload).replace(/<\/findings>/gi, '\\u003c/findings>')
}

function toConsolidatorInput(finding: Finding): Record<string, unknown> {
  const item: Record<string, unknown> = {
    category: finding.category,
    severity: finding.severity,
    quote: finding.quote,
    occurrence: finding.occurrence,
    issue: finding.issue,
    suggestion: finding.suggestion,
    confidence: finding.confidence,
    needs_human: finding.needsHuman,
  }
  const reason = finding.reason?.trim()
  if (reason !== undefined && reason !== '') item.reason = finding.reason
  const evidence = finding.evidence?.trim()
  if (evidence !== undefined && evidence !== '') item.evidence = finding.evidence
  if (finding.sources !== undefined && finding.sources.length > 0) {
    item.sources = finding.sources.map((source) => ({ title: source.title, url: source.url }))
  }
  return item
}

/**
 * Apply the consolidator's final findings to one article.
 *
 * The consolidator owns severity/suggestion/issue ordering intent, but it must not
 * silently drop evidence: a matched finding keeps the merged `roles`, gets the
 * union of both source lists and the first non-empty evidence; a merged problem
 * the model omitted is re-attached so no role-reported issue is lost. IDs are
 * reassigned `f1…` in final order (the page report prefixes them with the article
 * id), so cached/role-local ids can never collide.
 */
export function reconcileConsolidatedFindings(
  article: Article,
  merged: readonly Finding[],
  consolidated: readonly Finding[],
): Finding[] {
  const mergedByKey = new Map<string, Finding>()
  for (const finding of merged) {
    if (!mergedByKey.has(findingGroupKey(finding))) mergedByKey.set(findingGroupKey(finding), finding)
  }

  const consumed = new Set<string>()
  const finalFindings: Finding[] = []
  for (const candidate of consolidated) {
    const key = findingGroupKey(candidate)
    if (consumed.has(key)) continue
    consumed.add(key)
    const source = mergedByKey.get(key)
    if (source === undefined) {
      finalFindings.push({ ...candidate, articleId: article.id })
      continue
    }
    finalFindings.push(combineWithMerged(candidate, source))
  }
  for (const source of merged) {
    const key = findingGroupKey(source)
    if (consumed.has(key)) continue
    consumed.add(key)
    finalFindings.push({ ...source, articleId: article.id })
  }
  return finalFindings.map((finding, index) => ({ ...finding, id: `f${index + 1}` }))
}

/** Consolidator verdict + merged roles/sources/evidence for one problem. */
function combineWithMerged(candidate: Finding, source: Finding): Finding {
  const combined: Finding = {
    ...candidate,
    articleId: source.articleId,
    roles: source.roles.length > 0 ? [...source.roles] : ['consolidator'],
  }
  const sources = unionSources([...(candidate.sources ?? []), ...(source.sources ?? [])])
  if (sources.length > 0) combined.sources = sources
  else delete combined.sources
  const evidence = firstNonEmptyText(candidate.evidence, source.evidence)
  if (evidence !== undefined) combined.evidence = evidence
  else delete combined.evidence
  return combined
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Text a model finding's `quote` is located in: the article **title, subtitle
 * and body** (Task 21d, extended by Task 21e).
 *
 * The `headline` role legitimately quotes the article title or subtitle, neither
 * of which is part of `article.body`; validating against the body alone marked
 * those findings `引用无法定位` (`needsHuman`). The newlines keep the fields from
 * gluing into one synthetic snippet, and an absent/empty subtitle is skipped.
 */
function findingLocationText(article: Article): string {
  return [article.title, article.subtitle, article.body]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n')
}

/** Stamp the owning article and the reporting role onto a parsed finding. */
function stampFinding(finding: Finding, articleId: string, role: RoleId): Finding {
  return { ...finding, articleId, roles: [role] }
}

/**
 * Bind one reasoning effort to every request of a client (Task 25).
 *
 * Used for the `facts` role, whose extraction and verification calls are issued
 * inside the injected fact checker rather than by `run()` itself: wrapping the
 * client keeps the role policy in this module, while every concrete request
 * still carries an explicit per-request override that the LLM client forwards.
 */
function withReasoningEffort(llm: LlmClient, reasoningEffort: string): LlmClient {
  return {
    complete(request, signal) {
      return llm.complete({ ...request, reasoningEffort }, signal)
    },
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('role execution aborted')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

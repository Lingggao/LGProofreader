/**
 * Background job orchestrator for the Ling Gao 校对员 (Ling Gao Proofreader)
 * plugin — the core seam between the Host API (Task 14), the persistence layer
 * (Task 8), the layout pipeline (Task 5/11) and the proofreading roles
 * (Task 6/9/12).
 *
 * Two job kinds are supported (design §7.5):
 *
 * - **layout**: read the document's text layer/candidates/page size and overlay
 *   image, run the vision analyzer, assemble articles deterministically, save both
 *   layout files and finish with the assembled `{ regions, articles }` result;
 * - **proofread**: load the selected articles, run every depth role concurrently
 *   for every article (bounded by one global `concurrency` cap), then one
 *   consolidator call per article, then build and persist the deterministic page
 *   report.
 *
 * Cross-cutting guarantees:
 * - `start*()` returns the job id immediately and runs in the background; `get()`
 *   always exposes a defensive snapshot of state/progress/stages; `cancel()`
 *   aborts the shared `AbortController` and reports `true` exactly once;
 * - a single role failure is recorded on its stage and never blocks the other
 *   roles or the job (Review Focus 5); each role attempt is retried once and is
 *   bounded by `perCallTimeoutMs` (default 300 s, design §7.5). The network roles
 *   get longer, fixed ceilings: the `facts` role 13 min (Task 21d) because it
 *   extracts claims and runs the network verification searches, and the
 *   independent `nouns` role 9 min (existence-only planning + web searches). A
 *   network role timeout is final (never retried) so the user-visible ceiling
 *   cannot double; the consolidator always stays within the general bound;
 * - role results are cached in memory and under
 *   `reports/<jobId>/<articleId>/<role>.json` with the key
 *   `articleId|role|promptVersion|model|articleTextHash`; a cache hit skips the
 *   model call, a changed text/prompt/model misses, and the network roles
 *   (`facts`, `nouns`) also key on depth + network mode;
 * - the `facts` and `nouns` roles run at every depth, using the depth budgets
 *   and a `saveEvidence` sink that writes `facts-evidence.json`; with the network
 *   switch off the web seam is replaced by an always-failing stub so fact claims
 *   still end up `unverified` and nouns end up `not_checked` instead of the roles
 *   being skipped;
 * - a failed role is listed explicitly in `Report.failedRoles`
 *   (`articleId`/`role`/`error`), so a partial report can never pretend the role
 *   ran (Task 21f): an empty fact checklist from a failed `facts` role is “not
 *   checked”, not “未发现可核查项”;
 * - progress = completed (`done` or `failed`) stages / total stages;
 * - no prompt text is stored in a job, report or error message: stages carry only
 *   static labels, reports carry only the prompt version hash.
 *
 * Host-only module; Node built-ins only.
 */
import { randomBytes } from 'node:crypto'
import type {
  Article,
  Depth,
  DocumentMeta,
  FactCheck,
  FactCheckProgress,
  FactCheckProgressItem,
  FactCheckProgressPhase,
  Finding,
  JobId,
  NounCheck,
  NounProgress,
  NounProgressItem,
  Report,
  ReportRoleFailure,
  RoleId,
  StageState,
} from '../../shared/types'
import { mapWithConcurrency } from '../../shared/async'
import { assembleArticles } from '../../shared/layout/assemble'
import type { LayoutAnalyzer } from '../layout/analyzer'
import { DOC_ID_PATTERN, type DocumentStore } from '../services/store'
import type { LlmClient, LlmResult } from '../services/llm-client'
import type { WebClient } from '../services/web-client'
import type { PromptLibrary } from '../../shared/types'
import {
  buildReport,
  mergeArticleFindings,
  type ReportArticleInput,
} from './report'
import {
  ROLE_IDS,
  ROLE_LABELS,
  articleCacheText,
  createRoleRunner,
  factBudgetForDepth,
  nounBudgetForDepth,
  readCachedRoleResult,
  roleCacheKey,
  rolesForDepth,
  toCachedRoleResult,
  type CachedRoleIdentity,
  type RoleCacheExpectation,
  type RoleRunResult,
  type RoleRunner,
} from './roles'
import {
  FACT_HARD_STOP_MS,
  FACT_SOFT_STOP_MS,
  type FactCheckProgressUpdate,
} from './facts'
import {
  NOUN_HARD_STOP_MS,
  NOUN_SOFT_STOP_MS,
  type NounProgressUpdate,
} from './nouns'

/* ------------------------------------------------------------------------- */
/* Contracts                                                                   */
/* ------------------------------------------------------------------------- */

/** Background job kind. */
export type JobKind = 'layout' | 'proofread'

/** Job lifecycle status exposed to the polling client. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One job as exposed by `get()` (a defensive snapshot). */
export interface JobState {
  id: JobId
  kind: JobKind
  status: JobStatus
  /** Completed (`done` or `failed`) stages / total stages, in `[0, 1]`. */
  progress: number
  stages: StageState[]
  /** Live network fact-check plan/progress while the facts role is running. */
  factProgress?: FactCheckProgress
  /** Live network noun-check plan/progress while the nouns role is running. */
  nounProgress?: NounProgress
  /** Layout: `{ regions, articles, warnings }`; proofread: the final `Report`. */
  result?: unknown
  error?: string
}

/** Everything the orchestrator needs; wired in the Host entry point (Task 15). */
export interface OrchestratorDeps {
  llm: LlmClient
  web: WebClient
  prompts: PromptLibrary
  store: DocumentStore
  analyzer: LayoutAnalyzer
  now(): number
  /** Global cap for concurrent background model calls (`maxConcurrentWorkers`). */
  concurrency: number
  /** Model route selected for this Host, reported in the report and cache key. */
  model: { provider: string; model: string }
  /**
   * Timeout of one general role attempt (design §7.5; Task 21d default: 300 s,
   * configurable). Missing or non-positive values fall back to
   * {@link DEFAULT_PER_CALL_TIMEOUT_MS}. The `facts` role always gets
   * {@link FACTS_PER_CALL_TIMEOUT_MS} (780 s) and the `nouns` role
   * {@link NOUN_PER_CALL_TIMEOUT_MS} (540 s) because they run network searches.
   */
  perCallTimeoutMs?: number
  /**
   * Whether the Host deployment has a `web` service at all.
   *
   * This is a *presence* signal, not a probe: when it is `false` the run cannot
   * perform network fact-checking even with `factCheck: true`, so the report is
   * stamped `factCheckMode: 'unavailable'` (the client must show 未联网核查
   * explicitly instead of inferring it from call counters). Defaults to `true`
   * so existing callers/embedders keep the previous behaviour.
   */
  webAvailable?: boolean
}

/** The seam consumed by the Host API handlers (Task 14). */
export interface JobOrchestrator {
  startLayout(input: { docId: string }): Promise<JobId>
  startProofread(input: {
    docId: string
    articleIds: string[]
    depth: Depth
    factCheck: boolean
  }): Promise<JobId>
  get(jobId: string): JobState | undefined
  cancel(jobId: string): boolean
}

/** Raised as the abort reason when a job is cancelled. */
export class JobCancelledError extends Error {
  readonly jobId: JobId

  constructor(jobId: JobId) {
    super(`job cancelled: ${jobId}`)
    this.name = 'JobCancelledError'
    this.jobId = jobId
  }
}

/**
 * Raised internally when one role attempt exceeds its attempt timeout (the
 * general `perCallTimeoutMs`, or a network role's longer bound).
 */
export class RoleTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`role attempt timed out after ${timeoutMs}ms`)
    this.name = 'RoleTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/* ------------------------------------------------------------------------- */
/* Constants                                                                   */
/* ------------------------------------------------------------------------- */

const DEFAULT_CONCURRENCY = 4
/**
 * Default timeout of one general role attempt (Task 21d raised it from 180 s: a
 * deep reasoner + long article routinely exceeded the old bound).
 */
export const DEFAULT_PER_CALL_TIMEOUT_MS = 300_000
/**
 * Timeout of one `facts` role attempt: claim extraction plus up to two network
 * verification stages. The internal soft stop is 11 min and the internal hard
 * stop is 12 min; 13 min is the program-level ceiling with one minute of slack.
 */
export const FACTS_PER_CALL_TIMEOUT_MS = 780_000
/**
 * Timeout of one independent `nouns` role attempt: one planning call plus the
 * Host web searches. The internal soft stop is 7 min and the internal hard stop
 * is 8 min; 9 min is the program-level ceiling with one minute of slack.
 */
export const NOUN_PER_CALL_TIMEOUT_MS = 540_000
/** Initial attempt plus exactly one retry (design §7.5). */
const MAX_ROLE_ATTEMPTS = 2
/** How many previously completed jobs of a document seed the role cache. */
const MAX_PREVIOUS_JOBS = 5
/** Message used by the network-disabled web stub; never reaches the model. */
const WEB_DISABLED_MESSAGE = '联网核查未启用'

/* ------------------------------------------------------------------------- */
/* Internal job state                                                          */
/* ------------------------------------------------------------------------- */

/** One running job: public state plus cancellation plumbing. */
interface JobContext {
  state: JobState
  controller: AbortController
  cancelled: boolean
}

/** Model-call counters aggregated into `Report.stats`. */
interface CallStats {
  calls: number
  failedCalls: number
  inputTokens: number
  outputTokens: number
  usageSeen: boolean
}

/** Result of one worker role (success) or of its retry budget (failure). */
type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/** One article's role results, before the consolidator phase. */
interface ArticleWork {
  article: Article
  merged: Finding[]
  factChecks: FactCheck[]
  nounChecks: NounCheck[]
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Create one orchestrator instance for one Host plugin process. Jobs are kept in
 * memory (the report itself is persisted through the store); the role-result
 * cache survives across jobs in this process and is reloaded from the job's
 * report directory when a job starts.
 */
export function createJobOrchestrator(deps: OrchestratorDeps): JobOrchestrator {
  const jobs = new Map<JobId, JobContext>()
  const memoryCache = new Map<string, RoleRunResult>()

  /* ----------------------------------------------------------------------- */
  /* Dependency helpers                                                      */
  /* ----------------------------------------------------------------------- */

  function now(): number {
    const value = deps.now()
    return Number.isFinite(value) ? value : 0
  }

  function concurrency(): number {
    const value =
      typeof deps.concurrency === 'number' && Number.isFinite(deps.concurrency)
        ? Math.floor(deps.concurrency)
        : DEFAULT_CONCURRENCY
    return Math.max(1, value)
  }

  function perCallTimeoutMs(): number {
    const value = deps.perCallTimeoutMs
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return DEFAULT_PER_CALL_TIMEOUT_MS
    }
    return Math.floor(value)
  }

  /**
   * Timeout of one worker-role attempt.
   *
   * The network roles extract a plan and then run web searches, so they get
   * fixed longer bounds: `facts` 13 min (Task 21d) and `nouns` 9 min. A
   * configured larger general bound still wins for the text roles; the
   * consolidator deliberately uses {@link perCallTimeoutMs} only.
   */
  function roleAttemptTimeoutMs(role: RoleId): number {
    const general = perCallTimeoutMs()
    // A network role owns a fixed ceiling (soft stop + hard stop + slack); a
    // larger general setting must not extend it.
    if (role === 'facts') return FACTS_PER_CALL_TIMEOUT_MS
    if (role === 'nouns') return NOUN_PER_CALL_TIMEOUT_MS
    return general
  }

  /**
   * Whether the deployment can reach the network at all. A missing/undefined
   * dep is treated as available (backwards-compatible default); only an explicit
   * `false` marks the run as network-unavailable.
   */
  function webAvailable(): boolean {
    return deps.webAvailable !== false
  }

  /**
   * Effective network fact-checking mode written into every report.
   *
   * `off` is a user choice, `unavailable` is a missing Host `web` service and
   * `on` means network checking was requested *and* a service existed — a
   * single failed lookup does not change the mode (its verdict is `unverified`).
   */
  function factCheckModeFor(factCheck: boolean): NonNullable<Report['factCheckMode']> {
    if (!factCheck) return 'off'
    return webAvailable() ? 'on' : 'unavailable'
  }

  /**
   * Real model route label (`<provider>/<model>`), used both in the report and in
   * the role cache identity so switching the provider invalidates the cache.
   */
  function modelLabel(): string {
    const provider = typeof deps.model?.provider === 'string' ? deps.model.provider.trim() : ''
    const model = typeof deps.model?.model === 'string' ? deps.model.model.trim() : ''
    if (provider === '') return model
    if (model === '') return provider
    return `${provider}/${model}`
  }

  /* ----------------------------------------------------------------------- */
  /* Job bookkeeping                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * Create a job with a collision-free id: `job_<timestamp>_<12 random hex>`.
   * The random suffix (not a per-instance counter) keeps ids unique across
   * orchestrator instances that share the same clock, so a restarted process can
   * never mistake its own job directory for a previous job's.
   */
  function createJob(kind: JobKind, stages: StageState[]): JobContext {
    const timestamp = Math.max(0, Math.floor(now()))
    let id: JobId = ''
    for (let attempt = 0; attempt < 8; attempt += 1) {
      id = `job_${timestamp}_${randomBytes(6).toString('hex')}`
      if (!jobs.has(id)) break
    }
    const state: JobState = { id, kind, status: 'queued', progress: 0, stages }
    const job: JobContext = { state, controller: new AbortController(), cancelled: false }
    jobs.set(id, job)
    return job
  }

  function makeStages(definitions: readonly { id: string; label: string }[]): StageState[] {
    return definitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      status: 'pending',
    }))
  }

  function layoutStages(): StageState[] {
    return makeStages([
      { id: 'load', label: '读取页面数据' },
      { id: 'analyze', label: '视觉版面分析' },
      { id: 'assemble', label: '文本回填与文章组装' },
      { id: 'save', label: '保存版面结果' },
    ])
  }

  /**
   * Proofread stage list, in execution order: load → every role of every article
   * → every article's consolidator → report. The role set is fixed at start time
   * so progress has a stable denominator even before the document is loaded.
   */
  function buildProofreadStages(
    articleIds: readonly string[],
    roles: readonly RoleId[],
  ): StageState[] {
    const definitions: { id: string; label: string }[] = [
      { id: 'load', label: '读取文档与文章' },
    ]
    for (const articleId of articleIds) {
      for (const role of roles) {
        definitions.push({ id: `${articleId}:${role}`, label: `${articleId} · ${ROLE_LABELS[role]}` })
      }
    }
    for (const articleId of articleIds) {
      definitions.push({
        id: `${articleId}:consolidator`,
        label: `${articleId} · ${ROLE_LABELS.consolidator}`,
      })
    }
    definitions.push({ id: 'report', label: '生成报告' })
    return makeStages(definitions)
  }

  function refreshProgress(job: JobContext): void {
    const total = job.state.stages.length
    if (total === 0) {
      job.state.progress = 0
      return
    }
    const completed = job.state.stages.filter(
      (stage) => stage.status === 'done' || stage.status === 'failed',
    ).length
    job.state.progress = Math.min(1, completed / total)
  }

  function stageOf(job: JobContext, stageId: string): StageState {
    const stage = job.state.stages.find((candidate) => candidate.id === stageId)
    if (stage === undefined) throw new Error(`internal error: unknown job stage ${stageId}`)
    return stage
  }

  function cancellationError(job: JobContext): Error {
    const reason = job.controller.signal.reason
    return reason instanceof Error ? reason : new JobCancelledError(job.state.id)
  }

  function throwIfCancelled(job: JobContext): void {
    if (job.cancelled || job.controller.signal.aborted) throw cancellationError(job)
  }

  function resetRunningStages(job: JobContext): void {
    for (const stage of job.state.stages) {
      if (stage.status === 'running') {
        stage.status = 'pending'
        delete stage.error
      }
    }
  }

  /** Run one critical stage; a failure marks it failed and aborts the job. */
  async function runStage<T>(
    job: JobContext,
    stageId: string,
    task: () => Promise<T> | T,
  ): Promise<T> {
    throwIfCancelled(job)
    const stage = stageOf(job, stageId)
    stage.status = 'running'
    delete stage.error
    refreshProgress(job)
    try {
      const value = await task()
      throwIfCancelled(job)
      stage.status = 'done'
      refreshProgress(job)
      return value
    } catch (error) {
      if (job.cancelled || job.controller.signal.aborted) {
        stage.status = 'pending'
        delete stage.error
        refreshProgress(job)
        throw cancellationError(job)
      }
      stage.status = 'failed'
      stage.error = describeError(error)
      refreshProgress(job)
      throw error
    }
  }

  /** Start a background job; terminal state is always set exactly once. */
  function launch(job: JobContext, run: (signal: AbortSignal) => Promise<void>): void {
    job.state.status = 'running'
    void run(job.controller.signal)
      .then(() => {
        if (job.cancelled) return
        job.state.status = 'done'
        refreshProgress(job)
      })
      .catch((error: unknown) => {
        if (job.cancelled || job.controller.signal.aborted) {
          job.state.status = 'cancelled'
          resetRunningStages(job)
          refreshProgress(job)
          return
        }
        job.state.status = 'failed'
        job.state.error = describeError(error)
        for (const stage of job.state.stages) {
          if (stage.status === 'running') {
            stage.status = 'failed'
            stage.error = stage.error ?? job.state.error
          }
        }
        refreshProgress(job)
      })
  }

  /* ----------------------------------------------------------------------- */
  /* Layout job                                                              */
  /* ----------------------------------------------------------------------- */

  async function runLayout(job: JobContext, docId: string, signal: AbortSignal): Promise<void> {
    let docLoaded = false
    try {
      const loaded = await runStage(job, 'load', async () => {
        const document = await deps.store.getDocument(docId)
        if (document === undefined) throw new Error(`文档不存在：${docId}`)
        docLoaded = true
        const { lines, candidates, widthPt, heightPt } = document
        if (!Array.isArray(lines)) throw new Error('页面文字尚未解析，无法进行版面分析')
        if (!Array.isArray(candidates)) throw new Error('候选块尚未解析，无法进行版面分析')
        if (
          typeof widthPt !== 'number' ||
          !Number.isFinite(widthPt) ||
          typeof heightPt !== 'number' ||
          !Number.isFinite(heightPt)
        ) {
          throw new Error('页面尺寸缺失，无法进行版面分析')
        }
        const overlayPng = await deps.store.getPageOverlay(docId)
        if (candidates.length > 0 && overlayPng === undefined) {
          throw new Error('页面叠加图未上传，无法进行版面分析')
        }
        return {
          lines,
          candidates,
          page: { widthPt, heightPt },
          overlayPng: overlayPng ?? new Uint8Array(),
        }
      })

      const vision = await runStage(job, 'analyze', () =>
        deps.analyzer.analyze(
          { overlayPng: loaded.overlayPng, candidates: loaded.candidates, page: loaded.page },
          signal,
        ),
      )
      const assembled = await runStage(job, 'assemble', () =>
        assembleArticles({
          page: loaded.page,
          lines: loaded.lines,
          candidates: loaded.candidates,
          vision,
        }),
      )
      await runStage(job, 'save', () =>
        deps.store.saveLayout(docId, {
          regions: assembled.regions,
          articles: assembled.articles,
        }),
      )
      // Vision-level warnings (`vision-fallback`, `vision-timeout`) are part of
      // the job result too: a degraded page is stored and `ready` exactly like a
      // clean one, so this is the only channel that lets the Client warning count
      // surface that the layout was not classified by the model (Task 21g).
      job.state.result = {
        regions: assembled.regions,
        articles: assembled.articles,
        warnings: [...assembled.warnings, ...vision.warnings],
      }
    } catch (error) {
      if (!job.cancelled && !signal.aborted && docLoaded) {
        await markDocumentFailed(docId)
      }
      throw error
    }
  }

  /** Best-effort `meta.status = failed`; never hides the original failure. */
  async function markDocumentFailed(docId: string): Promise<void> {
    try {
      await deps.store.updateMeta(docId, { status: 'failed' })
    } catch {
      // The job error already describes the failure; a meta write failure is secondary.
    }
  }

  async function startLayout(input: { docId: string }): Promise<JobId> {
    const docId = requireDocId(input?.docId)
    const job = createJob('layout', layoutStages())
    launch(job, (signal) => runLayout(job, docId, signal))
    return job.state.id
  }

  /* ----------------------------------------------------------------------- */
  /* Proofread job                                                           */
  /* ----------------------------------------------------------------------- */

  async function runProofread(
    job: JobContext,
    input: { docId: string; articleIds: string[]; depth: Depth; factCheck: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    const callStats = createCallStats()
    const startedAt = now()

    const loaded = await runStage(job, 'load', async () => {
      const document = await deps.store.getDocument(input.docId)
      if (document === undefined) throw new Error(`文档不存在：${input.docId}`)
      const available = new Map((document.articles ?? []).map((article) => [article.id, article]))
      const articles: Article[] = []
      const missing: string[] = []
      for (const articleId of input.articleIds) {
        const article = available.get(articleId)
        if (article === undefined) missing.push(articleId)
        else articles.push(article)
      }
      if (missing.length > 0) throw new Error(`文章不存在：${missing.join('、')}`)
      const preloaded = await loadPreloadedRoleResults(
        input.docId,
        job.state.id,
        document.reportIds ?? [],
        articles,
      )
      return { meta: document.meta, articles, preloaded }
    })

    const runner = createJobRoleRunner(
      job,
      input,
      callStats,
      (update) => {
        mergeFactProgress(update)
      },
      (update) => {
        mergeNounProgress(update)
      },
    )
    const context = buildArticleContext(loaded.meta)
    const roles = rolesForDepth(input.depth)
    const roleResults = new Map<string, RoleRunResult>()

    // Aggregate live fact plans from every article's facts role into one
    // priority-ordered job snapshot. `GET /job` exposes it while the job runs.
    const factItems = new Map<string, FactCheckProgressItem>()
    const factPhases = new Map<string, FactCheckProgressPhase>()
    const factStartedAt = new Map<string, number>()
    const factSoftDeadlineAt = new Map<string, number>()
    const factHardDeadlineAt = new Map<string, number>()

    function mergeFactProgress(update: FactCheckProgressUpdate): void {
      for (const item of update.items) factItems.set(item.id, item)
      factPhases.set(update.articleId, update.phase)
      factStartedAt.set(update.articleId, update.startedAt)
      factSoftDeadlineAt.set(update.articleId, update.softDeadlineAt)
      factHardDeadlineAt.set(update.articleId, update.hardDeadlineAt)
      const items = [...factItems.values()].sort(
        (left, right) =>
          left.priority - right.priority ||
          left.articleId.localeCompare(right.articleId) ||
          left.id.localeCompare(right.id),
      )
      const phases = [...factPhases.values()]
      const phase: FactCheckProgressPhase = phases.includes('searching')
        ? 'searching'
        : phases.includes('verifying')
          ? 'verifying'
          : phases.includes('planning')
            ? 'planning'
            : 'done'
      job.state.factProgress = {
        total: items.length,
        searched: items.filter((item) => item.searched).length,
        checked: items.filter((item) => item.status === 'checked').length,
        notChecked: items.filter((item) => item.status === 'not_checked').length,
        phase,
        items,
        startedAt: Math.min(...factStartedAt.values()),
        softDeadlineAt: Math.min(...factSoftDeadlineAt.values()),
        hardDeadlineAt: Math.min(...factHardDeadlineAt.values()),
      }
    }

    // Aggregate live noun plans the same way: one priority-ordered snapshot over
    // every article's independent nouns role.
    const nounItems = new Map<string, NounProgressItem>()
    const nounPhases = new Map<string, FactCheckProgressPhase>()
    const nounStartedAt = new Map<string, number>()
    const nounSoftDeadlineAt = new Map<string, number>()
    const nounHardDeadlineAt = new Map<string, number>()

    function mergeNounProgress(update: NounProgressUpdate): void {
      for (const item of update.items) nounItems.set(item.id, item)
      nounPhases.set(update.articleId, update.phase)
      nounStartedAt.set(update.articleId, update.startedAt)
      nounSoftDeadlineAt.set(update.articleId, update.softDeadlineAt)
      nounHardDeadlineAt.set(update.articleId, update.hardDeadlineAt)
      const items = [...nounItems.values()].sort(
        (left, right) =>
          left.priority - right.priority ||
          left.articleId.localeCompare(right.articleId) ||
          left.id.localeCompare(right.id),
      )
      const phases = [...nounPhases.values()]
      const phase: FactCheckProgressPhase = phases.includes('searching')
        ? 'searching'
        : phases.includes('verifying')
          ? 'verifying'
          : phases.includes('planning')
            ? 'planning'
            : 'done'
      job.state.nounProgress = {
        total: items.length,
        searched: items.filter((item) => item.searched).length,
        checked: items.filter((item) => item.status === 'checked').length,
        notChecked: items.filter((item) => item.status === 'not_checked').length,
        phase,
        items,
        startedAt: Math.min(...nounStartedAt.values()),
        softDeadlineAt: Math.min(...nounSoftDeadlineAt.values()),
        hardDeadlineAt: Math.min(...nounHardDeadlineAt.values()),
      }
    }

    // Phase 1: every role of every article, globally bounded by `concurrency`.
    const roleTasks: { article: Article; role: RoleId }[] = []
    for (const article of loaded.articles) {
      for (const role of roles) roleTasks.push({ article, role })
    }
    await mapWithConcurrency(
      roleTasks,
      concurrency(),
      async (task, _index, taskSignal) => {
        throwIfCancelled(job)
        const stage = stageOf(job, `${task.article.id}:${task.role}`)
        stage.status = 'running'
        delete stage.error
        refreshProgress(job)

        // A network role's result depends on the depth budget and on whether the
        // network was enabled, so both are part of its cache identity and become
        // a miss on any mismatch; other roles keep the documented article/role/
        // prompt/model/text identity.
        const networkIdentity: CachedRoleIdentity =
          task.role === 'facts' || task.role === 'nouns'
            ? { depth: input.depth, factCheck: input.factCheck }
            : {}
        const cacheKey = roleCacheKey({
          articleId: task.article.id,
          role: task.role,
          promptVersion: deps.prompts.version,
          model: modelLabel(),
          text: articleCacheText(task.article),
          ...networkIdentity,
        })
        const cached = findCachedRoleResult(
          memoryCache,
          loaded.preloaded.get(task.article.id)?.[task.role],
          { cacheKey, role: task.role, ...networkIdentity },
        )
        if (cached !== undefined) {
          memoryCache.set(cacheKey, cached)
          roleResults.set(roleTaskKey(task.article.id, task.role), cached)
          stage.status = 'done'
          refreshProgress(job)
          return
        }

        const outcome = await runRoleAttempts(runner, job, task.article, task.role, context, signal)
        if (!outcome.ok) {
          stage.status = 'failed'
          stage.error = outcome.error
          refreshProgress(job)
          return
        }
        memoryCache.set(cacheKey, outcome.value)
        roleResults.set(roleTaskKey(task.article.id, task.role), outcome.value)
        await persistRoleResult(
          input.docId,
          job.state.id,
          task.article.id,
          task.role,
          cacheKey,
          outcome.value,
          networkIdentity,
        )
        stage.status = 'done'
        refreshProgress(job)
      },
      signal,
    )

    // Program dedupe per article (design §7.6.2), before the consolidator.
    const articleWork: ArticleWork[] = loaded.articles.map((article) => {
      const findings: Finding[] = []
      const factChecks: FactCheck[] = []
      const nounChecks: NounCheck[] = []
      for (const role of roles) {
        const result = roleResults.get(roleTaskKey(article.id, role))
        if (result === undefined) continue
        findings.push(...result.findings)
        if (result.factChecks !== undefined) factChecks.push(...result.factChecks)
        if (result.nounChecks !== undefined) nounChecks.push(...result.nounChecks)
      }
      return { article, merged: mergeArticleFindings(findings), factChecks, nounChecks }
    })

    // Phase 2: one consolidator call per article (skipped when nothing was found).
    const finalFindings = new Map<string, Finding[]>()
    await mapWithConcurrency(
      articleWork,
      concurrency(),
      async (work, _index, taskSignal) => {
        throwIfCancelled(job)
        const stage = stageOf(job, `${work.article.id}:consolidator`)
        if (work.merged.length === 0) {
          finalFindings.set(work.article.id, work.merged)
          stage.status = 'done'
          refreshProgress(job)
          return
        }
        stage.status = 'running'
        delete stage.error
        refreshProgress(job)
        const outcome = await runConsolidatorAttempts(
          runner,
          job,
          work.article,
          context,
          work.merged,
          signal,
        )
        if (!outcome.ok) {
          // A consolidator failure must not lose the deduped findings.
          finalFindings.set(work.article.id, work.merged)
          stage.status = 'failed'
          stage.error = outcome.error
          refreshProgress(job)
          return
        }
        finalFindings.set(work.article.id, outcome.value)
        stage.status = 'done'
        refreshProgress(job)
      },
      signal,
    )

    // Phase 3: deterministic page report + persistence.
    await runStage(job, 'report', async () => {
      // A failed role stage carries the provider/stage error. The report must
      // record those roles explicitly (Task 21f): a failed `facts` role leaves
      // `factChecks` empty, and an empty checklist may never be presented as
      // “未发现可核查项”.
      const failedRoles = failedRolesFromStages(job.state.stages)
      const report = buildReport({
        jobId: job.state.id,
        docId: input.docId,
        depth: input.depth,
        factCheckMode: factCheckModeFor(input.factCheck),
        model: modelLabel(),
        promptVersion: deps.prompts.version,
        createdAt: now(),
        articles: articleWork.map(
          (work): ReportArticleInput => ({
            article: work.article,
            findings: finalFindings.get(work.article.id) ?? work.merged,
            factChecks: work.factChecks,
            nounChecks: work.nounChecks,
          }),
        ),
        failedRoles,
        stats: buildReportStats(callStats, runner, startedAt, input.factCheck),
      })
      await deps.store.saveReport(input.docId, report)
      job.state.result = report
    })
  }

  function createJobRoleRunner(
    job: JobContext,
    input: { docId: string; depth: Depth; factCheck: boolean },
    callStats: CallStats,
    onFactProgress: (update: FactCheckProgressUpdate) => void,
    onNounProgress: (update: NounProgressUpdate) => void,
  ): RoleRunner {
    return createRoleRunner({
      llm: createCountedLlm(deps.llm, callStats),
      // When the deployment declares no web service, never touch the injected
      // stub: the network roles still run (mandatory) and produce unverified
      // fact checks / not_checked noun checks, but the report mode is
      // `unavailable`, not `on`.
      web: input.factCheck && webAvailable() ? deps.web : createDisabledWebClient(),
      prompts: deps.prompts,
      factBudget: factBudgetForDepth(input.depth),
      nounBudget: nounBudgetForDepth(input.depth),
      saveEvidence: (articleId, evidence) =>
        deps.store.saveRoleResult(input.docId, job.state.id, articleId, 'facts-evidence', evidence),
      onFactProgress,
      onNounProgress,
      now,
      factSoftStopMs: FACT_SOFT_STOP_MS,
      factHardStopMs: FACT_HARD_STOP_MS,
      nounSoftStopMs: NOUN_SOFT_STOP_MS,
      nounHardStopMs: NOUN_HARD_STOP_MS,
    })
  }

  /** One role attempt loop: retry once on any error, never after cancellation. */
  async function runRoleAttempts(
    runner: RoleRunner,
    job: JobContext,
    article: Article,
    role: RoleId,
    context: string,
    signal: AbortSignal,
  ): Promise<AttemptOutcome<RoleRunResult>> {
    let lastError: unknown
    const timeoutMs = roleAttemptTimeoutMs(role)
    for (let attempt = 1; attempt <= MAX_ROLE_ATTEMPTS; attempt += 1) {
      throwIfCancelled(job)
      try {
        const value = await withAttemptTimeout(
          (attemptSignal) => runner.run(role, article, context, attemptSignal),
          signal,
          timeoutMs,
        )
        return { ok: true, value }
      } catch (error) {
        if (job.cancelled || signal.aborted) throw cancellationError(job)
        // The network roles own long (13/9 min) budgets. Retrying after a timeout
        // would double the user-visible ceiling, so a network-role timeout is
        // final; ordinary provider errors still get the documented one retry.
        if ((role === 'facts' || role === 'nouns') && error instanceof RoleTimeoutError) {
          return { ok: false, error: describeError(error) }
        }
        lastError = error
      }
    }
    return { ok: false, error: describeError(lastError) }
  }

  /** One consolidator attempt loop; same retry/cancellation policy as a role. */
  async function runConsolidatorAttempts(
    runner: RoleRunner,
    job: JobContext,
    article: Article,
    context: string,
    findings: readonly Finding[],
    signal: AbortSignal,
  ): Promise<AttemptOutcome<Finding[]>> {
    let lastError: unknown
    // The consolidator stays within the general role bound (Task 21d).
    const timeoutMs = perCallTimeoutMs()
    for (let attempt = 1; attempt <= MAX_ROLE_ATTEMPTS; attempt += 1) {
      throwIfCancelled(job)
      try {
        const value = await withAttemptTimeout(
          (attemptSignal) => runner.consolidate(article, context, findings, attemptSignal),
          signal,
          timeoutMs,
        )
        return { ok: true, value }
      } catch (error) {
        if (job.cancelled || signal.aborted) throw cancellationError(job)
        lastError = error
      }
    }
    return { ok: false, error: describeError(lastError) }
  }

  /**
   * Run `task` under the job signal plus a per-attempt timeout.
   *
   * The returned promise settles on the first of: the task result/failure, the
   * job cancellation, or the timeout. Racing the abort (instead of only forwarding
   * the signal) guarantees a misbehaving client that ignores its signal can never
   * hang a role or a cancelled job; the abandoned task promise is drained so it
   * cannot become an unhandled rejection.
   */
  async function withAttemptTimeout<T>(
    task: (signal: AbortSignal) => Promise<T>,
    jobSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new RoleTimeoutError(timeoutMs)), timeoutMs)
    const combined = AbortSignal.any([jobSignal, controller.signal])
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false
        const settle = (action: () => void): void => {
          if (settled) return
          settled = true
          combined.removeEventListener('abort', onAbort)
          action()
        }
        const onAbort = (): void => {
          const reason = combined.reason
          settle(() =>
            reject(reason instanceof Error ? reason : new Error('role attempt aborted')),
          )
        }
        if (combined.aborted) onAbort()
        else combined.addEventListener('abort', onAbort, { once: true })
        task(combined).then(
          (value) => settle(() => resolve(value)),
          (error: unknown) => settle(() => reject(error)),
        )
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Cache and stats                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * Role results that may seed this job's cache: the current job's own report
   * directory (a resumed/retried job) plus the most recent completed jobs of the
   * same document (design §7.5: 文本/提示词/模型不变时同一文章重复校对直接复用).
   * Each value is still validated against the current cache key before it is
   * used, so stale text/prompt/model combinations miss.
   */
  async function loadPreloadedRoleResults(
    docId: string,
    jobId: string,
    reportIds: readonly string[],
    articles: readonly Article[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const previousJobIds = reportIds.filter((id) => id !== jobId).slice(-MAX_PREVIOUS_JOBS)
    const preloaded = new Map<string, Record<string, unknown>>()
    for (const article of articles) {
      const values: Record<string, unknown> = {}
      for (const previousJobId of previousJobIds) {
        try {
          Object.assign(
            values,
            await deps.store.getRoleResults(docId, previousJobId, article.id),
          )
        } catch {
          // A damaged cache directory only means a cache miss.
        }
      }
      try {
        Object.assign(values, await deps.store.getRoleResults(docId, jobId, article.id))
      } catch {
        // Same for the current job's directory.
      }
      preloaded.set(article.id, values)
    }
    return preloaded
  }

  function findCachedRoleResult(
    cache: Map<string, RoleRunResult>,
    persisted: unknown,
    expected: RoleCacheExpectation & { role: RoleId },
  ): RoleRunResult | undefined {
    const inMemory = cache.get(expected.cacheKey)
    if (inMemory !== undefined) return inMemory
    if (persisted === undefined) return undefined
    const fromDisk = readCachedRoleResult(persisted, expected)
    if (fromDisk === undefined || fromDisk.role !== expected.role) return undefined
    return fromDisk
  }

  /** Persist one role result; a cache write failure never fails the role. */
  async function persistRoleResult(
    docId: string,
    jobId: string,
    articleId: string,
    role: RoleId,
    cacheKey: string,
    result: RoleRunResult,
    identity: CachedRoleIdentity = {},
  ): Promise<void> {
    try {
      await deps.store.saveRoleResult(
        docId,
        jobId,
        articleId,
        role,
        toCachedRoleResult(cacheKey, articleId, result, identity),
      )
    } catch {
      // The cache is an optimization; the findings are already in memory.
    }
  }

  function buildReportStats(
    callStats: CallStats,
    runner: RoleRunner,
    startedAt: number,
    factCheckEnabled: boolean,
  ): Report['stats'] {
    const factStats = runner.factStats()
    const stats: Report['stats'] = {
      calls: callStats.calls,
      failedCalls: callStats.failedCalls,
      // Attempts against the disabled-network stub are not real network work.
      searchCalls: factCheckEnabled ? factStats.searches : 0,
      fetchCalls: factCheckEnabled ? factStats.fetches : 0,
      elapsedMs: Math.max(0, now() - startedAt),
    }
    if (callStats.usageSeen) {
      stats.inputTokens = callStats.inputTokens
      stats.outputTokens = callStats.outputTokens
    }
    return stats
  }

  /* ----------------------------------------------------------------------- */
  /* Start / get / cancel                                                    */
  /* ----------------------------------------------------------------------- */

  async function startProofread(input: {
    docId: string
    articleIds: string[]
    depth: Depth
    factCheck: boolean
  }): Promise<JobId> {
    const docId = requireDocId(input?.docId)
    const articleIds = requireArticleIds(input?.articleIds)
    const depth = requireDepth(input?.depth)
    const factCheck = requireFactCheck(input?.factCheck)
    const job = createJob('proofread', buildProofreadStages(articleIds, rolesForDepth(depth)))
    launch(job, (signal) => runProofread(job, { docId, articleIds, depth, factCheck }, signal))
    return job.state.id
  }

  function get(jobId: string): JobState | undefined {
    const job = jobs.get(jobId)
    if (job === undefined) return undefined
    return {
      ...job.state,
      stages: job.state.stages.map((stage) => ({ ...stage })),
      ...(job.state.factProgress === undefined
        ? {}
        : {
            factProgress: {
              ...job.state.factProgress,
              items: job.state.factProgress.items.map((item) => ({ ...item })),
            },
          }),
      ...(job.state.nounProgress === undefined
        ? {}
        : {
            nounProgress: {
              ...job.state.nounProgress,
              items: job.state.nounProgress.items.map((item) => ({ ...item })),
            },
          }),
    }
  }

  function cancel(jobId: string): boolean {
    const job = jobs.get(jobId)
    if (job === undefined) return false
    if (job.state.status !== 'queued' && job.state.status !== 'running') return false
    job.cancelled = true
    job.state.status = 'cancelled'
    delete job.state.error
    resetRunningStages(job)
    refreshProgress(job)
    if (!job.controller.signal.aborted) job.controller.abort(new JobCancelledError(job.state.id))
    return true
  }

  return { startLayout, startProofread, get, cancel }
}

/* ------------------------------------------------------------------------- */
/* Dependency-free helpers                                                     */
/* ------------------------------------------------------------------------- */

/** Key of one role's result inside the per-job `roleResults` map. */
function roleTaskKey(articleId: string, role: RoleId): string {
  return `${articleId}\u0000${role}`
}

/** Known role ids as a runtime set, for parsing `<articleId>:<role>` stage ids. */
const ROLE_ID_SET: ReadonlySet<string> = new Set(ROLE_IDS)

/**
 * Collect failed role stages into `Report.failedRoles` (Task 21f).
 *
 * Role/consolidator stages are the only ones whose ids contain `:`
 * (`<articleId>:<role>`); the critical stages (`load`, `report`, layout stages)
 * fail the whole job and never reach report building. Stage order — article order
 * then role order — is preserved so the report field is deterministic, and a
 * missing/blank stage error stays absent rather than becoming an empty string.
 */
function failedRolesFromStages(stages: readonly StageState[]): ReportRoleFailure[] {
  const failures: ReportRoleFailure[] = []
  for (const stage of stages) {
    if (stage.status !== 'failed') continue
    const separator = stage.id.lastIndexOf(':')
    if (separator <= 0 || separator === stage.id.length - 1) continue
    const articleId = stage.id.slice(0, separator)
    const role = stage.id.slice(separator + 1)
    if (!ROLE_ID_SET.has(role)) continue
    const failure: ReportRoleFailure = { articleId, role: role as RoleId }
    const error = typeof stage.error === 'string' ? stage.error.trim() : ''
    if (error !== '') failure.error = error
    failures.push(failure)
  }
  return failures
}

/** Context handed to every role: newspaper/date/edition when known. */
function buildArticleContext(meta: DocumentMeta): string {
  const parts: string[] = []
  if (meta.newspaper !== undefined && meta.newspaper.trim() !== '') {
    parts.push(`报纸：${meta.newspaper.trim()}`)
  }
  if (meta.date !== undefined && meta.date.trim() !== '') parts.push(`日期：${meta.date.trim()}`)
  if (meta.edition !== undefined && meta.edition.trim() !== '') {
    parts.push(`版次：${meta.edition.trim()}`)
  }
  return parts.length > 0 ? parts.join('；') : '未提供版面信息'
}

function createCallStats(): CallStats {
  return { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, usageSeen: false }
}

/** Count every model call/failure/usage for `Report.stats`. */
function createCountedLlm(llm: LlmClient, stats: CallStats): LlmClient {
  return {
    async complete(request, signal): Promise<LlmResult> {
      stats.calls += 1
      try {
        const result = await llm.complete(request, signal)
        if (result.usage !== undefined) {
          if (result.usage.inputTokens !== undefined) {
            stats.inputTokens += result.usage.inputTokens
            stats.usageSeen = true
          }
          if (result.usage.outputTokens !== undefined) {
            stats.outputTokens += result.usage.outputTokens
            stats.usageSeen = true
          }
        }
        return result
      } catch (error) {
        stats.failedCalls += 1
        throw error
      }
    },
  }
}

/** Web seam used when the user disabled network fact checking. */
function createDisabledWebClient(): WebClient {
  const fail = async (): Promise<never> => {
    throw new Error(WEB_DISABLED_MESSAGE)
  }
  return { search: fail, fetch: fail }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/* ------------------------------------------------------------------------- */
/* Input validation                                                            */
/* ------------------------------------------------------------------------- */

function requireDocId(value: unknown): string {
  if (typeof value !== 'string' || !DOC_ID_PATTERN.test(value)) {
    throw new TypeError('docId must be a valid document id')
  }
  return value
}

function requireArticleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('articleIds must be a non-empty array')
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new TypeError('articleIds entries must be non-empty strings')
    }
    const id = entry.trim()
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function requireDepth(value: unknown): Depth {
  if (value !== 'quick' && value !== 'standard' && value !== 'deep') {
    throw new TypeError('depth must be one of quick, standard, deep')
  }
  return value
}

function requireFactCheck(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('factCheck must be a boolean')
  return value
}

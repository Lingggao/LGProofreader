/**
 * Deterministic report assembly for one proofreading job (design §7.6).
 *
 * The page report is built from the per-article results the orchestrator
 * produced, without any further model call (design §7.6.1: 本页摘要由程序确定性
 * 汇总):
 *
 * 1. per article, merge the worker roles' findings (`mergeFindings`, Task 6) and
 *    enrich the merged result with the union of every merged member's `sources`
 *    (deduped by URL) and the first non-empty `evidence` — Task 6's merge keeps
 *    only the primary member's fields, which would silently drop evidence found
 *    by another role;
 * 2. sort each article's findings by severity (`must_fix → suggested → optional`)
 *    and then by the quote's position in the article body, so the report order is
 *    deterministic even when the consolidator's order is not;
 * 3. prefix every finding id with the article id (`a1:f1`), every fact-check id
 *    the same way (`a1:fc1`) and every noun-check id the same way (`a1:noun1`),
 *    because each role/parser restarts its local ids and a page report contains
 *    several articles;
 * 4. build the page summary: severity/category counts, fact-check verdict
 *    counts, existence-only noun-check counts, and the deterministic
 *    "必须修改的条目" list;
 * 5. carry the failed-role list through unchanged (omitted when empty), so a
 *    partial report is explicit: a failed `facts`/`nouns` role means “not
 *    checked”, never “未发现可核查项”/“未发现可核查名词” (Task 21f).
 *
 * The renderer (Task 7) keeps `report.findings` order, so this module owns the
 * documented ordering.
 */
import type {
  Article,
  Depth,
  DocId,
  FactCheck,
  Finding,
  JobId,
  NounCheck,
  Report,
  ReportRoleFailure,
} from '../../shared/types'
import { FINDING_CATEGORIES, normalizeForMatch } from '../../shared/proof/findings'
import { mergeFindings } from '../../shared/proof/merge'

/* ------------------------------------------------------------------------- */
/* Merge enrichment                                                            */
/* ------------------------------------------------------------------------- */

/** Stable merge key from Task 6: category + normalized quote. */
export function findingGroupKey(finding: Pick<Finding, 'category' | 'quote'>): string {
  return `${finding.category}\u0000${normalizeForMatch(finding.quote)}`
}

/** Union sources in first-seen order, deduped by trimmed URL; blank URLs dropped. */
export function unionSources(
  sources: readonly { title: string; url: string }[],
): { title: string; url: string }[] {
  const unique: { title: string; url: string }[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const url = source.url.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    unique.push({ title: source.title, url })
  }
  return unique
}

/** First value that is defined and not blank, in input order. */
export function firstNonEmptyText(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Merge one article's role findings and restore the evidence the primary member
 * lost: sources from every merged member (URL-deduped) and the first non-empty
 * `evidence`. The merged severity/confidence/roles/suggestion policy stays Task
 * 6's (`mergeFindings`); this function only enriches its output.
 */
export function mergeArticleFindings(findings: readonly Finding[]): Finding[] {
  if (findings.length === 0) return []
  const merged = mergeFindings(findings)

  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = findingGroupKey(finding)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [finding])
    else group.push(finding)
  }

  return merged.map((result) => {
    const members = groups.get(findingGroupKey(result)) ?? [result]
    const enriched: Finding = { ...result }
    const sources = unionSources(members.flatMap((member) => member.sources ?? []))
    if (sources.length > 0) enriched.sources = sources
    const evidence = firstNonEmptyText(...members.map((member) => member.evidence))
    if (evidence !== undefined) enriched.evidence = evidence
    return enriched
  })
}

/* ------------------------------------------------------------------------- */
/* Finding order                                                               */
/* ------------------------------------------------------------------------- */

const SEVERITY_ORDER: Readonly<Record<Finding['severity'], number>> = {
  must_fix: 0,
  suggested: 1,
  optional: 2,
}

/** Quote offset in the article body, with a normalized fallback for fuzzy quotes. */
function quotePosition(
  finding: Finding,
  articleText: string,
  normalizedArticleText: string,
): number {
  const exact = articleText.indexOf(finding.quote)
  if (exact >= 0) return exact
  const normalizedQuote = normalizeForMatch(finding.quote)
  if (normalizedQuote === '') return Number.POSITIVE_INFINITY
  const normalizedIndex = normalizedArticleText.indexOf(normalizedQuote)
  return normalizedIndex >= 0 ? normalizedIndex : Number.POSITIVE_INFINITY
}

/**
 * Sort one article's final findings by severity, then by the position of the
 * quote in the article body (unlocatable quotes go last), then by occurrence.
 * The sort is stable for equal keys, so the consolidator's order is preserved
 * within one position.
 */
export function sortFindingsForArticle(
  article: Article,
  findings: readonly Finding[],
): Finding[] {
  const normalizedArticleText = normalizeForMatch(article.body)
  const positioned = findings.map((finding, index) => ({
    finding,
    index,
    position: quotePosition(finding, article.body, normalizedArticleText),
  }))
  positioned.sort(
    (left, right) =>
      SEVERITY_ORDER[left.finding.severity] - SEVERITY_ORDER[right.finding.severity] ||
      left.position - right.position ||
      left.finding.occurrence - right.finding.occurrence ||
      left.index - right.index,
  )
  return positioned.map((entry) => entry.finding)
}

/* ------------------------------------------------------------------------- */
/* Report building                                                             */
/* ------------------------------------------------------------------------- */

/** One article's finished contribution to the page report. */
export interface ReportArticleInput {
  article: Article
  /** Final per-article findings (consolidated, or the merged fallback). */
  findings: readonly Finding[]
  /** Fact checks from the `facts` role, in extraction order. */
  factChecks: readonly FactCheck[]
  /**
   * Noun checks from the independent `nouns` role, in priority plan order.
   * Optional so old fixtures/callers that only know fact checks still compile;
   * it defaults to no noun checks.
   */
  nounChecks?: readonly NounCheck[]
}

/** Everything {@link buildReport} needs; assembled by the orchestrator. */
export interface BuildReportInput {
  jobId: JobId
  docId: DocId
  depth: Depth
  /** Effective network fact-checking mode of the run (never inferred later). */
  factCheckMode: NonNullable<Report['factCheckMode']>
  /** Model label (`provider/model` is folded into settings' model field). */
  model: string
  promptVersion: string
  createdAt: number
  articles: readonly ReportArticleInput[]
  /**
   * Roles that failed before producing a result; copied into the report so the
   * UI/export can say “not checked” instead of showing an empty result as
   * complete (Task 21f). Omitted or empty → `Report.failedRoles` is omitted.
   */
  failedRoles?: readonly ReportRoleFailure[]
  stats: Report['stats']
}

/** Suggestion text for the must-fix summary; a blank suggestion means "delete". */
function mustFixSuggestion(finding: Finding): string {
  const suggestion = finding.suggestion.trim()
  return suggestion === '' ? '删除' : suggestion
}

/**
 * One deterministic "必须修改的条目" line, e.g.
 * `《文汇报》错别字：“他的确” → 他的确`.
 */
function mustFixLine(articleTitle: string, finding: Finding): string {
  const title = articleTitle.trim()
  const prefix = title === '' ? '' : `《${title}》`
  return `${prefix}${finding.issue.trim()}：“${finding.quote.trim()}” → ${mustFixSuggestion(finding)}`
}

/** Category counts in the documented category order (unknown categories last). */
function countByCategory(findings: readonly Finding[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const finding of findings) {
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1)
  }
  const ordered: Record<string, number> = {}
  for (const category of FINDING_CATEGORIES) {
    const count = counts.get(category)
    if (count !== undefined) {
      ordered[category] = count
      counts.delete(category)
    }
  }
  for (const category of [...counts.keys()].sort()) {
    ordered[category] = counts.get(category) as number
  }
  return ordered
}

/** Deterministic page summary (counts + must-fix list); never model-generated. */
function buildSummary(
  articleTitles: ReadonlyMap<string, string>,
  findings: readonly Finding[],
): Report['summary'] {
  let mustFixCount = 0
  let suggestedCount = 0
  let optionalCount = 0
  const mustFixList: string[] = []
  for (const finding of findings) {
    switch (finding.severity) {
      case 'must_fix':
        mustFixCount += 1
        mustFixList.push(mustFixLine(articleTitles.get(finding.articleId) ?? '', finding))
        break
      case 'suggested':
        suggestedCount += 1
        break
      case 'optional':
        optionalCount += 1
        break
    }
  }
  return {
    mustFixCount,
    suggestedCount,
    optionalCount,
    factCheck: {
      confirmed: 0,
      contradicted: 0,
      unverified: 0,
      insufficient: 0,
      notChecked: 0,
    },
    nounCheck: {
      exists: 0,
      uncertain: 0,
      notFound: 0,
      notChecked: 0,
    },
    byCategory: countByCategory(findings),
    mustFixList,
  }
}

/** Count every fact-check verdict into the report summary shape. */
function fillFactCheckSummary(
  summary: Report['summary'],
  factChecks: readonly FactCheck[],
): void {
  for (const check of factChecks) {
    switch (check.verdict) {
      case 'confirmed':
        summary.factCheck.confirmed += 1
        break
      case 'contradicted':
        summary.factCheck.contradicted += 1
        break
      case 'unverified':
        summary.factCheck.unverified += 1
        break
      case 'insufficient':
        summary.factCheck.insufficient += 1
        break
      case 'not_checked':
        summary.factCheck.notChecked += 1
        break
    }
  }
}

/** Count every existence-only noun check into the report summary shape. */
function fillNounCheckSummary(
  summary: Report['summary'],
  nounChecks: readonly NounCheck[],
): void {
  const counts = summary.nounCheck
  if (counts === undefined) return
  for (const check of nounChecks) {
    switch (check.status) {
      case 'exists':
        counts.exists += 1
        break
      case 'uncertain':
        counts.uncertain += 1
        break
      case 'not_found':
        counts.notFound += 1
        break
      case 'not_checked':
        counts.notChecked += 1
        break
    }
  }
}

/**
 * Copy the failed-role records into plain, JSON-safe objects.
 *
 * Blank article ids and blank error messages are dropped rather than persisted
 * as empty strings, and the source list is never mutated. The array is empty for
 * a run in which every role finished, so the caller can omit the field entirely.
 */
function normalizeFailedRoles(
  roles: readonly ReportRoleFailure[] | undefined,
): ReportRoleFailure[] {
  if (!Array.isArray(roles)) return []
  const failures: ReportRoleFailure[] = []
  for (const failure of roles) {
    if (typeof failure?.articleId !== 'string' || failure.articleId === '') continue
    if (typeof failure.role !== 'string' || failure.role === '') continue
    const normalized: ReportRoleFailure = {
      articleId: failure.articleId,
      role: failure.role,
    }
    const error = typeof failure.error === 'string' ? failure.error.trim() : ''
    if (error !== '') normalized.error = error
    failures.push(normalized)
  }
  return failures
}

/**
 * Build the final page report from the per-article results.
 *
 * Article order follows `input.articles` (the user's selection order). Each
 * article's findings are sorted and renumbered (`f1…`); ids are prefixed with the
 * article id so they stay unique across the page. Fact checks keep their `facts`
 * extraction order and noun checks their priority plan order; both are prefixed
 * the same way and always emitted (`[]` for an empty run). Failed roles are
 * carried through verbatim (field omitted when none), so an empty result is never
 * silently presented as a complete check.
 */
export function buildReport(input: BuildReportInput): Report {
  const findings: Finding[] = []
  const factChecks: FactCheck[] = []
  const nounChecks: NounCheck[] = []
  const articleTitles = new Map<string, string>()

  for (const entry of input.articles) {
    const articleId = entry.article.id
    articleTitles.set(articleId, entry.article.title)
    const sorted = sortFindingsForArticle(entry.article, entry.findings)
    sorted.forEach((finding, index) => {
      findings.push({
        ...finding,
        id: `${articleId}:f${index + 1}`,
        articleId,
      })
    })
    for (const check of entry.factChecks) {
      factChecks.push({ ...check, id: `${articleId}:${check.id}`, articleId })
    }
    for (const check of entry.nounChecks ?? []) {
      nounChecks.push({ ...check, id: `${articleId}:${check.id}`, articleId })
    }
  }

  const summary = buildSummary(articleTitles, findings)
  fillFactCheckSummary(summary, factChecks)
  fillNounCheckSummary(summary, nounChecks)

  const report: Report = {
    jobId: input.jobId,
    docId: input.docId,
    articleIds: input.articles.map((entry) => entry.article.id),
    createdAt: input.createdAt,
    model: input.model,
    promptVersion: input.promptVersion,
    depth: input.depth,
    factCheckMode: input.factCheckMode,
    summary,
    findings,
    factChecks,
    nounChecks,
    stats: input.stats,
  }
  const failedRoles = normalizeFailedRoles(input.failedRoles)
  if (failedRoles.length > 0) report.failedRoles = failedRoles
  return report
}

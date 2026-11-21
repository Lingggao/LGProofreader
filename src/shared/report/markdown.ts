/**
 * Markdown export for one proofreading `Report` (brief Task 7; design §7.6.4 and
 * §9.4).
 *
 * The renderer is shared by the Host export endpoint (Task 14) and the Client
 * copy/export actions (Task 19), so it stays free of Node.js, React and
 * DeepSeek Harness imports and is pure: no I/O, clock, randomness or environment
 * access, and the inputs are never mutated.
 *
 * Document order is fixed by the brief:
 * title → each article's findings → 事实核查清单 → 名词核查（仅当报告带有名词核查
 * 数据时） → 必须修改的条目 → footer.
 *
 * Guarantees:
 * - only findings, the fact checklist, the existence-only noun checklist and the
 *   must-fix summary are rendered; the article body is never emitted, so the
 *   export can never contain a rewritten full text (design §7.3);
 * - a finding's suggestion is bolded, while `**…**` markers the consolidator
 *   already put around the changed words are kept instead of double-wrapped;
 * - fact/noun table cells escape `|` and collapse newlines, so untrusted model
 *   text cannot break the table;
 * - findings keep the order of `report.findings` (the consolidator owns the
 *   must_fix → suggested → optional sort, design §7.6.4); this renderer only
 *   groups them per article;
 * - empty findings/fact checks, a missing article lookup and missing optional
 *   fields degrade to a readable fallback instead of throwing or silently
 *   dropping an entry;
 * - failed roles (`Report.failedRoles`) are rendered as a prominent warning
 *   before the findings, and a failed `facts`/`nouns` role changes the empty
 *   checklist text to “事实核查角色未完成，不能视为未发现可核查项” /
 *   “名词核查角色未完成，不能视为未发现可核查名词” — a failed role is “not
 *   checked”, never “checked, nothing found” (Task 21f).
 */
import type {
  Article,
  FactCheck,
  Finding,
  NounCheck,
  Report,
  ReportRoleFailure,
  RoleId,
} from '../types'

/**
 * Fallback product version shown in the footer.
 *
 * The real version is owned by `package.json`; both callers pass it explicitly
 * (the Host export handler passes the version it read from the installed
 * package, the Client copy action passes the `/meta` version). This constant only
 * keeps the pure renderer usable on its own (tests/tools) and must stay equal to
 * the manifest version — `scripts/validate.mjs` fails on drift.
 */
export const DEFAULT_REPORT_VERSION = '1.0.0'

/**
 * Build-time injected default footer banner (`Ling Gao Proofreader v<version>`).
 *
 * `scripts/build.mjs` replaces this identifier through esbuild `define` for both
 * artifacts, so the compiled fallback contains the manifest version as one
 * contiguous string and `scripts/validate.mjs` can prove a stale artifact fails
 * validation. The identifier is absent in the Vitest/standalone bundle, where
 * {@link defaultFooterBanner} falls back to {@link DEFAULT_REPORT_VERSION}.
 */
declare const __PLUGIN_VERSION_BANNER__: string

/** The banner used when the caller does not pass an explicit version. */
function defaultFooterBanner(): string {
  try {
    if (
      typeof __PLUGIN_VERSION_BANNER__ === 'string' &&
      __PLUGIN_VERSION_BANNER__.trim() !== ''
    ) {
      return __PLUGIN_VERSION_BANNER__
    }
  } catch {
    // Development/test bundles do not define the build constant.
  }
  return `Ling Gao Proofreader v${DEFAULT_REPORT_VERSION}`
}

/** Compiled default banner; the Host/Client passers always match it at release. */
const DEFAULT_FOOTER_BANNER = defaultFooterBanner()

/** Heading used for a report whose summary carries no articles. */
const UNASSIGNED_ARTICLE_HEADING = '## 未归属文章'

/** Severity labels used in the finding bullets. */
const SEVERITY_LABELS: Readonly<Record<Finding['severity'], string>> = {
  must_fix: '必改',
  suggested: '建议',
  optional: '可选',
}

/** Fact-check verdict labels (design: 已核实/有冲突/未核实/证据不足/未检查). */
const VERDICT_LABELS: Readonly<Record<FactCheck['verdict'], string>> = {
  confirmed: '已核实',
  contradicted: '有冲突',
  unverified: '未核实',
  insufficient: '证据不足',
  not_checked: '未检查',
}

/** Fact-check kind labels. */
const KIND_LABELS: Readonly<Record<FactCheck['kind'], string>> = {
  date: '日期',
  time: '时间',
  person: '人物',
  title: '职务',
  organization: '机构',
  place: '地点',
  book: '书名',
  event: '事件',
  number: '数字',
  quote: '引语',
  other: '其他',
}

/**
 * Noun-check existence labels. A missing source is never rendered as
 * “不存在”: `not_found` reads “未找到来源”, an explicit evidence gap.
 */
const NOUN_STATUS_LABELS: Readonly<Record<NonNullable<NounCheck['status']>, string>> = {
  exists: '有网络收录',
  uncertain: '证据不足',
  not_found: '未找到来源',
  not_checked: '未核查',
}

const NO_FINDINGS_TEXT = '未发现问题。'
const NO_FACT_CHECKS_TEXT = '未发现可核查项。'
const NO_FACT_CHECKS_FAILED_TEXT = '事实核查角色未完成，不能视为未发现可核查项。'
const NO_NOUN_CHECKS_TEXT = '未发现可核查名词。'
const NO_NOUN_CHECKS_FAILED_TEXT = '名词核查角色未完成，不能视为未发现可核查名词。'
const NO_MUST_FIX_TEXT = '无必须修改的条目。'
const NEEDS_HUMAN_LABEL = '需人工确认'
const DELETED_SUGGESTION_LABEL = '**（删除）**'
const MISSING_VALUE = '—'

/** Failed-role warning block (Task 21f); deliberately rendered before findings. */
const FAILED_ROLES_HEADING = '## 未完成角色（未核查提示）'
const FAILED_ROLES_INTRO = '以下角色未完成：报告不包含它们的结果，不能视为已检查。'
const FACTS_FAILED_NOTICE = '事实核查角色未完成：不能视为未发现可核查项，相关事实未核查。'
const NOUNS_FAILED_NOTICE = '名词核查角色未完成：不能视为未发现可核查名词，相关名词未核查。'
const UNASSIGNED_ARTICLE_LABEL = '未归属文章'

/** Role labels for the failed-role warning (same wording as the Client locale). */
const ROLE_LABELS: Readonly<Record<RoleId, string>> = {
  master: '主审',
  words: '字词',
  idioms: '成语',
  style: '规范',
  facts: '事实核查',
  nouns: '名词核查',
  headline: '标题',
  consistency: '一致性',
  consolidator: '汇总',
}

/** Source descriptor; fields are optional so malformed stored data degrades. */
interface ReportSource {
  title?: string
  url?: string
}

/* ------------------------------------------------------------------------- */
/* Small text helpers                                                          */
/* ------------------------------------------------------------------------- */

/** Collapse every whitespace run (incl. newlines) to one space and trim. */
function oneLine(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Make arbitrary text safe inside one Markdown table cell. */
function escapeTableCell(value: string | undefined): string {
  return oneLine(value).replace(/\|/g, '\\|')
}

/** Render one source as a Markdown link; a title-less source falls back to its URL. */
function formatSource(source: ReportSource): string {
  const url = oneLine(source?.url)
  const title = oneLine(source?.title)
  if (url === '') return title
  const label = title === '' ? url : title.replace(/[[\]]/g, '\\$&')
  return `[${label}](${url})`
}

/** Join sources with `；`; returns '' for absent/empty source lists. */
function formatSources(sources: readonly ReportSource[] | undefined): string {
  if (!Array.isArray(sources) || sources.length === 0) return ''
  return sources.map(formatSource).filter((source) => source !== '').join('；')
}

/* ------------------------------------------------------------------------- */
/* Findings                                                                    */
/* ------------------------------------------------------------------------- */

/** Default descriptor when a finding carries no issue text. */
function findingIssue(finding: Finding): string {
  return oneLine(finding.issue) || '问题'
}

/**
 * Bold the suggestion. The consolidator may already have wrapped the changed
 * words in `**…**` (design §7.6.4), so an already-bold suggestion is emitted
 * as-is; only plain suggestions are wrapped. A blank suggestion means "delete".
 */
function renderSuggestion(suggestion: string | undefined): string {
  const text = oneLine(suggestion)
  if (text === '') return DELETED_SUGGESTION_LABEL
  return text.includes('**') ? text : `**${text}**`
}

/**
 * Append the needs-human marker unless one of the parts already says it (the
 * parser stores `引用无法定位`-style reasons, the consolidator a `建议冲突` one),
 * so the report never repeats the same phrase twice in one line.
 */
function appendNeedsHumanMarker(parts: string[], needsHuman: boolean): void {
  if (!needsHuman) return
  if (parts.some((part) => part.includes(NEEDS_HUMAN_LABEL))) return
  parts.push(NEEDS_HUMAN_LABEL)
}

/** `（依据：…）` made from reason, evidence, sources and the needs-human marker. */
function renderFindingBasis(finding: Finding): string {
  const parts: string[] = []
  const reason = oneLine(finding.reason)
  if (reason !== '') parts.push(reason)
  const evidence = oneLine(finding.evidence)
  if (evidence !== '') parts.push(evidence)
  const sources = formatSources(finding.sources)
  if (sources !== '') parts.push(`来源：${sources}`)
  appendNeedsHumanMarker(parts, finding.needsHuman)
  return parts.length === 0 ? '' : `（依据：${parts.join('；')}）`
}

/**
 * One finding as a bullet, e.g.
 * `- [必改] 错别字 · “他的确” → **他的确**（依据：…）`.
 */
function renderFinding(finding: Finding): string {
  const severity = SEVERITY_LABELS[finding.severity] ?? '问题'
  const quote = oneLine(finding.quote)
  const quoteText = quote === '' ? '（无引用）' : `“${quote}”`
  return `- [${severity}] ${findingIssue(finding)} · ${quoteText} → ${renderSuggestion(finding.suggestion)}${renderFindingBasis(finding)}`
}

/* ------------------------------------------------------------------------- */
/* Articles                                                                    */
/* ------------------------------------------------------------------------- */

/** Article ids in report order, extended with ids only seen in findings. */
function articleIdsInReportOrder(report: Report): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string): void => {
    if (typeof id !== 'string' || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const id of report.articleIds ?? []) add(id)
  for (const finding of report.findings ?? []) add(finding.articleId)
  return ids
}

/** Heading for one article; a missed lookup or empty title falls back to the id. */
function renderArticleHeading(articleId: string, articlesById: ReadonlyMap<string, Article>): string {
  const title = oneLine(articlesById.get(articleId)?.title)
  if (title !== '') return `## ${title}`
  return articleId === '' ? UNASSIGNED_ARTICLE_HEADING : `## 文章 ${articleId}`
}

/** One article block: heading plus its findings (or an empty-state line). */
function renderArticleBlock(
  articleId: string,
  report: Report,
  articlesById: ReadonlyMap<string, Article>,
): string {
  const findings = (report.findings ?? []).filter((finding) => finding.articleId === articleId)
  const lines = [renderArticleHeading(articleId, articlesById), '']
  if (findings.length === 0) lines.push(NO_FINDINGS_TEXT)
  else lines.push(...findings.map(renderFinding))
  return lines.join('\n')
}

/* ------------------------------------------------------------------------- */
/* Failed roles                                                                */
/* ------------------------------------------------------------------------- */

/** Failed-role records of a report; stored/malformed data degrades to none. */
function failedRolesOf(report: Report): ReportRoleFailure[] {
  return Array.isArray(report.failedRoles) ? report.failedRoles : []
}

/**
 * Failed records of one role for the articles this report claims to cover.
 *
 * The Host only fails role stages for the articles the user selected, so the
 * article-id filter is defensive: an unknown id in `failedRoles` still appears in
 * the warning block, but it must not change the claim that the reported articles
 * were checked. An empty `articleIds` list means the report carries no article
 * scope, so every recorded failure counts.
 */
function roleFailuresOf(report: Report, role: RoleId): ReportRoleFailure[] {
  const reported = new Set(
    (report.articleIds ?? []).filter((id): id is string => typeof id === 'string'),
  )
  return failedRolesOf(report).filter(
    (failure) => failure.role === role && (reported.size === 0 || reported.has(failure.articleId)),
  )
}

/** Failed `facts` roles that belong to an article this report claims to cover. */
function factsFailuresOf(report: Report): ReportRoleFailure[] {
  return roleFailuresOf(report, 'facts')
}

/** Failed `nouns` roles that belong to an article this report claims to cover. */
function nounsFailuresOf(report: Report): ReportRoleFailure[] {
  return roleFailuresOf(report, 'nouns')
}

/** One failed role: article title when resolvable, role label and stage error. */
function renderFailedRoleItem(
  failure: ReportRoleFailure,
  articlesById: ReadonlyMap<string, Article>,
): string {
  const title = oneLine(articlesById.get(failure.articleId)?.title)
  let article: string
  if (title !== '') article = `《${title}》`
  else if (failure.articleId === '') article = UNASSIGNED_ARTICLE_LABEL
  else article = `文章 ${failure.articleId}`
  const role = ROLE_LABELS[failure.role] ?? String(failure.role)
  const error = oneLine(failure.error)
  return `- ${article}${role}${error === '' ? '' : `：${error}`}`
}

/**
 * `## 未完成角色（未核查提示）` block, rendered before the findings. A failed
 * `facts`/`nouns` role additionally spells out that the facts/nouns were *not*
 * checked, so the export can never read an empty checklist as “未发现可核查项” or
 * “未发现可核查名词”. Returns `null` when no role failed (the field is fully
 * omitted from the document).
 */
function renderFailedRoles(
  report: Report,
  articlesById: ReadonlyMap<string, Article>,
): string | null {
  const failures = failedRolesOf(report)
  if (failures.length === 0) return null
  const lines = [FAILED_ROLES_HEADING, '', FAILED_ROLES_INTRO, '']
  lines.push(...failures.map((failure) => renderFailedRoleItem(failure, articlesById)))
  if (failures.some((failure) => failure.role === 'facts')) {
    lines.push('', FACTS_FAILED_NOTICE)
  }
  if (failures.some((failure) => failure.role === 'nouns')) {
    lines.push('', NOUNS_FAILED_NOTICE)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------------- */
/* Fact checklist                                                              */
/* ------------------------------------------------------------------------- */

/** One fact-check row; `依据/来源` joins evidence, source links and the marker. */
function renderFactCheckRow(factCheck: FactCheck): string {
  const verdict = VERDICT_LABELS[factCheck.verdict] ?? '未知'
  const kind = KIND_LABELS[factCheck.kind] ?? '其他'
  const basisParts: string[] = []
  const evidence = oneLine(factCheck.evidence)
  if (evidence !== '') basisParts.push(evidence)
  const sources = formatSources(factCheck.sources)
  if (sources !== '') basisParts.push(sources)
  appendNeedsHumanMarker(basisParts, factCheck.needsHuman)
  const basis = basisParts.length === 0 ? MISSING_VALUE : basisParts.join('；')
  return `| ${escapeTableCell(factCheck.claim)} | ${escapeTableCell(factCheck.quote)} | ${kind} | ${verdict} | ${escapeTableCell(basis)} |`
}

/** `## 事实核查清单` block: a Markdown table, or an explicit empty-state line. */
function renderFactChecklist(report: Report): string {
  const lines = ['## 事实核查清单', '']
  const factChecks = report.factChecks ?? []
  if (factChecks.length === 0) {
    // A failed facts role means the claims were never checked; that is the
    // opposite of “no verifiable claims found” (Task 21f).
    lines.push(
      factsFailuresOf(report).length > 0 ? NO_FACT_CHECKS_FAILED_TEXT : NO_FACT_CHECKS_TEXT,
    )
    return lines.join('\n')
  }
  lines.push('| 主张 | 原文引用 | 类型 | 结论 | 依据/来源 |')
  lines.push('| --- | --- | --- | --- | --- |')
  lines.push(...factChecks.map(renderFactCheckRow))
  return lines.join('\n')
}

/* ------------------------------------------------------------------------- */
/* Noun checklist (existence only)                                             */
/* ------------------------------------------------------------------------- */

/** One noun-check row; `依据/来源` joins evidence, source links and the marker. */
function renderNounCheckRow(nounCheck: NounCheck): string {
  const status = NOUN_STATUS_LABELS[nounCheck.status] ?? '未知'
  const basisParts: string[] = []
  const evidence = oneLine(nounCheck.evidence)
  if (evidence !== '') basisParts.push(evidence)
  const sources = formatSources(nounCheck.sources)
  if (sources !== '') basisParts.push(sources)
  appendNeedsHumanMarker(basisParts, nounCheck.needsHuman)
  const basis = basisParts.length === 0 ? MISSING_VALUE : basisParts.join('；')
  return `| ${escapeTableCell(nounCheck.name)} | ${status} | ${escapeTableCell(basis)} |`
}

/**
 * True when the report carries noun-check data at all.
 *
 * New reports always set `summary.nounCheck`, so the compact section is rendered
 * even for an empty plan; reports persisted before the noun role existed carry
 * neither field and stay unchanged.
 */
function hasNounCheckData(report: Report): boolean {
  return (report.nounChecks?.length ?? 0) > 0 || report.summary?.nounCheck !== undefined
}

/**
 * `## 名词核查` block: a compact existence table, or an explicit empty-state line.
 * Returns `null` for reports without any noun-check data, so older Markdown
 * exports keep their exact previous document order.
 */
function renderNounChecklist(report: Report): string | null {
  if (!hasNounCheckData(report)) return null
  const lines = ['## 名词核查', '']
  const nounChecks = report.nounChecks ?? []
  if (nounChecks.length === 0) {
    // A failed nouns role means the terms were never checked; that is the
    // opposite of “no checkable nouns found”.
    lines.push(nounsFailuresOf(report).length > 0 ? NO_NOUN_CHECKS_FAILED_TEXT : NO_NOUN_CHECKS_TEXT)
    return lines.join('\n')
  }
  lines.push('| 名词 | 状态 | 依据/来源 |')
  lines.push('| --- | --- | --- |')
  lines.push(...nounChecks.map(renderNounCheckRow))
  return lines.join('\n')
}

/* ------------------------------------------------------------------------- */
/* Must-fix summary and footer                                                 */
/* ------------------------------------------------------------------------- */

/**
 * `## 必须修改的条目` block. `summary.mustFixList` is the consolidator's own
 * summary and is preferred verbatim; when it is empty but must-fix findings
 * exist, the findings are listed so the summary cannot contradict the list.
 */
function renderMustFixSummary(report: Report): string {
  const lines = ['## 必须修改的条目', '']
  const items = (report.summary?.mustFixList ?? []).map(oneLine).filter((item) => item !== '')
  if (items.length > 0) {
    lines.push(...items.map((item) => `- ${item}`))
    return lines.join('\n')
  }
  const mustFixFindings = (report.findings ?? []).filter(
    (finding) => finding.severity === 'must_fix',
  )
  if (mustFixFindings.length > 0) {
    lines.push(...mustFixFindings.map(renderFinding))
    return lines.join('\n')
  }
  lines.push(NO_MUST_FIX_TEXT)
  return lines.join('\n')
}

/** Footer: English product name + version, model and prompt version. */
function renderFooter(report: Report, version: string): string {
  const model = oneLine(report.model) || MISSING_VALUE
  const promptVersion = oneLine(report.promptVersion) || MISSING_VALUE
  const productVersion = oneLine(version) || DEFAULT_REPORT_VERSION
  // The release path passes the manifest version, which equals the pinned
  // fallback, so the compiled banner is used verbatim; an explicit other version
  // (tests/tools) is interpolated instead.
  const banner =
    productVersion === DEFAULT_REPORT_VERSION
      ? DEFAULT_FOOTER_BANNER
      : `Ling Gao Proofreader v${productVersion}`
  return ['---', `${banner} · 模型：${model} · 提示词版本：${promptVersion}`].join('\n')
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Render one report as Markdown for copy/download. See the module header for the
 * document order and guarantees.
 *
 * `version` is the plugin version shown in the footer. Callers that know the
 * installed package version (the Host reads `package.json`, the Client reads
 * `/meta`) should pass it so a released package always reports its real version;
 * the default exists for standalone rendering and tests.
 */
export function renderReportMarkdown(
  report: Report,
  articles: readonly Article[],
  version: string = DEFAULT_REPORT_VERSION,
): string {
  const articlesById = new Map<string, Article>()
  for (const article of articles ?? []) {
    if (typeof article?.id === 'string') articlesById.set(article.id, article)
  }

  const blocks: string[] = ['# Ling Gao 校对员 · 校对报告']
  const failedRoles = renderFailedRoles(report, articlesById)
  if (failedRoles !== null) blocks.push(failedRoles)
  for (const articleId of articleIdsInReportOrder(report)) {
    blocks.push(renderArticleBlock(articleId, report, articlesById))
  }
  blocks.push(renderFactChecklist(report))
  const nounChecklist = renderNounChecklist(report)
  if (nounChecklist !== null) blocks.push(nounChecklist)
  blocks.push(renderMustFixSummary(report))
  blocks.push(renderFooter(report, version))
  return `${blocks.join('\n\n')}\n`
}

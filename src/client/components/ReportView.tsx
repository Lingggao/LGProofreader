/**
 * Proofreading report view (Tasks 19/19b; design §7.6/§9.3/§9.4).
 *
 * Composes the deterministic page summary (involved-article count, severity
 * counts, unverified count, the "必须修改的条目" list, effective model, depth and
 * generation timestamp) with the filterable findings list and the fact checklist.
 * The offline marker is derived by default from the report itself
 * (`isOfflineFactCheck`), and `App` can force it when it knows the run was
 * started with `factCheck: false`.
 *
 * Task 19b additions:
 * - the summary now shows 涉及文章 and 未核实项 counts (design §7.6.4);
 * - an unknown category renders its raw label instead of silently becoming
 *   错别字 (the category set is versioned with the Host);
 * - the export toolbar carries both the Markdown and the JSON
 *   `GET /export?job=<id>&format=md|json` links;
 * - locate and batch-accept intents are forwarded to `App` through
 *   `ReportList`; nothing here mutates the report findings or the article text.
 *
 * Task 21f addition: `report.failedRoles` is rendered as a warning block before
 * the summary/findings, and forwarded to `FactCheckList` so a failed `facts` role
 * replaces “未发现可核查项” with an explicit “not checked” state.
 *
 * The copy action reuses the shared Task 7 Markdown renderer. Nothing here
 * renders prompt text or model reasoning — only findings, verdicts, sources and
 * the prompt version hash.
 */
import { defaultTranslate, type Translate } from '../locale'
import { exportUrl } from '../api/client'
import type { Article, FactCheck, Finding, Report, ReportRoleFailure } from '../../shared/types'
import { categoryLabel } from './FindingCard'
import { FactCheckList, isOfflineFactCheck } from './FactCheckList'
import { FailedRolesNotice } from './FailedRolesNotice'
import { InlineMarkdown } from './InlineMarkdown'
import { ReportList } from './ReportList'

/** Localized depth labels, reused from the proofread panel. */
const DEPTH_KEYS: Record<Report['depth'], string> = {
  quick: 'proof.depth.quick',
  standard: 'proof.depth.standard',
  deep: 'proof.depth.deep',
}

/** Render one deterministic count item. */
function Count({ stat, value, label }: { stat: string; value: number; label: string }) {
  return (
    <li className="lgp-summary-count" data-lgp-summary-item={stat}>
      <span className="lgp-summary-value">{value}</span>
      <span className="lgp-summary-label">{label}</span>
    </li>
  )
}

/** Distinct article ids that have at least one finding (design §7.6.4). */
export function involvedArticleCount(findings: readonly Finding[] | undefined): number {
  const ids = new Set<string>()
  for (const finding of findings ?? []) {
    if (typeof finding?.articleId === 'string' && finding.articleId !== '') {
      ids.add(finding.articleId)
    }
  }
  return ids.size
}

/** Props of {@link ReportView}. */
export interface ReportViewProps {
  /** The finished report stored as the proofread job result. */
  report: Report
  /** Articles of the open page (titles for the group headings). */
  articles?: readonly Article[]
  /** Force the 未联网核查 marker; omitted → derived from report stats/verdicts. */
  offline?: boolean
  /** Reports a finding status change. */
  onStatusChange?: (findingId: string, status: Finding['status']) => void
  /** Asks the canvas to locate + highlight one finding. */
  onLocate?: (finding: Finding) => void
  /** Copy the rendered Markdown report. */
  onCopy?: () => Promise<boolean> | boolean
  /** Called when an export link is activated. */
  onExport?: () => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the report summary, findings list and fact checklist. */
export function ReportView({
  report,
  articles = [],
  offline,
  onStatusChange,
  onLocate,
  onCopy,
  onExport,
  t = defaultTranslate,
}: ReportViewProps) {
  const factOffline =
    offline ?? isOfflineFactCheck(report.factChecks, report.stats, report.factCheckMode)
  const createdAt = new Date(report.createdAt)
  const iso = Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : ''
  const summary = report.summary
  const mustFixList = Array.isArray(summary.mustFixList) ? summary.mustFixList : []
  const findings = Array.isArray(report.findings) ? report.findings : []
  const facts: FactCheck[] = Array.isArray(report.factChecks) ? report.factChecks : []
  const failedRoles: readonly ReportRoleFailure[] = Array.isArray(report.failedRoles)
    ? report.failedRoles
    : []
  const byCategory =
    typeof summary.byCategory === 'object' && summary.byCategory !== null
      ? Object.entries(summary.byCategory).filter(
          ([, count]) => typeof count === 'number' && count > 0,
        )
      : []
  const involved = involvedArticleCount(findings)
  const unverified = summary.factCheck?.unverified ?? 0

  return (
    <section className="lgp-report" data-lgp-part="report">
      <header className="lgp-report-head">
        <h2 className="lgp-report-title">{t('report.title')}</h2>
      </header>

      {/* A partial report must say so up front (Task 21f): a failed role is
          “not checked”, never an empty result. */}
      <FailedRolesNotice failedRoles={failedRoles} articles={articles} t={t} />

      <section
        className="lgp-report-summary"
        data-lgp-report-summary="true"
        data-lgp-summary-articles={involved}
        data-lgp-summary-must-fix={summary.mustFixCount}
        data-lgp-summary-suggested={summary.suggestedCount}
        data-lgp-summary-optional={summary.optionalCount}
        data-lgp-summary-confirmed={summary.factCheck?.confirmed ?? 0}
        data-lgp-summary-contradicted={summary.factCheck?.contradicted ?? 0}
        data-lgp-summary-unverified={unverified}
        data-lgp-summary-insufficient={summary.factCheck?.insufficient ?? 0}
        data-lgp-summary-not-checked={summary.factCheck?.notChecked ?? 0}
        aria-label={t('report.summary')}
      >
        <ul className="lgp-summary-counts">
          <Count stat="articles" value={involved} label={t('report.summaryArticles')} />
          <Count stat="must_fix" value={summary.mustFixCount} label={t('report.severity.must_fix')} />
          <Count stat="suggested" value={summary.suggestedCount} label={t('report.severity.suggested')} />
          <Count stat="optional" value={summary.optionalCount} label={t('report.severity.optional')} />
          <Count stat="unverified" value={unverified} label={t('report.summaryUnverified')} />
        </ul>
        {byCategory.length === 0 ? null : (
          <ul className="lgp-summary-categories" data-lgp-summary-categories="true">
            {byCategory.map(([category, count]) => (
              <li key={category} className="lgp-summary-category">
                {categoryLabel(category, t)} {count}
              </li>
            ))}
          </ul>
        )}
        <p className="lgp-report-meta">
          <span>{t('report.model', { model: report.model })}</span>
          <span aria-hidden="true"> · </span>
          <span>{t('report.depthLabel', { depth: t(DEPTH_KEYS[report.depth] ?? 'proof.depth.standard') })}</span>
          <span aria-hidden="true"> · </span>
          <span className="lgp-report-time">
            {t('report.createdAt')}
            {': '}
            <time dateTime={iso}>{iso}</time>
          </span>
          {report.promptVersion === undefined || report.promptVersion === '' ? null : (
            <>
              <span aria-hidden="true"> · </span>
              <span>{t('report.promptVersion', { version: report.promptVersion })}</span>
            </>
          )}
        </p>
      </section>

      <section className="lgp-report-must-fix" data-lgp-must-fix-list="true">
        <h3 className="lgp-report-section-title">{t('report.mustFixList')}</h3>
        {mustFixList.length === 0 ? (
          <p className="lgp-report-empty">{t('report.noMustFix')}</p>
        ) : (
          <ul className="lgp-must-fix-items">
            {mustFixList.map((item, index) => (
              <li key={`${index}-${item}`} className="lgp-must-fix-item">
                {/* Task 24: the consolidator marks the changed words with
                    `**…**`; render them as <strong> instead of leaking raw
                    Markdown markers into the summary. */}
                <InlineMarkdown text={item} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReportList
        findings={findings}
        articles={articles}
        onStatusChange={onStatusChange}
        onLocate={onLocate}
        onCopy={onCopy}
        exportHref={exportUrl(report.jobId, 'md')}
        exportFileName={`LingGao-${report.jobId}.md`}
        exportJsonHref={exportUrl(report.jobId, 'json')}
        exportJsonFileName={`LingGao-${report.jobId}.json`}
        onExport={onExport}
        t={t}
      />

      <FactCheckList
        checks={facts}
        offline={factOffline}
        failedRoles={failedRoles}
        articleIds={report.articleIds}
        articles={articles}
        t={t}
      />
    </section>
  )
}

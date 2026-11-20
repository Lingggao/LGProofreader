/**
 * Fact-check checklist (Task 19; design §7.4/§9.2/§9.4).
 *
 * The checklist is a *complete* record of what was checked: confirmed rows are
 * shown next to contradicted / unverified / insufficient / not_checked ones, so
 * a claim can never silently disappear from the report (global constraint:
 * "每个可核查项必须有状态，不能静默跳过"). `FactCheck.occurrence` is rendered
 * when present, which is what distinguishes the same quote appearing several
 * times in one article.
 *
 * The five columns follow the amended design §7.4 ruling: claim | quote | kind |
 * verdict | evidence/sources (no "已改" column — the user's handling of a problem
 * belongs to `Finding.status`, not to a fact check).
 *
 * Offline marker: a report produced without network verification (the setting was
 * off or the Host has no `web` service) is explicitly marked 未联网核查 at the top
 * of the section. `isOfflineFactCheck` derives that from the deterministic
 * report stats/verdicts, so an older stored report still gets the marker.
 *
 * Failed facts role (Task 21f): an empty checklist may be the result of a failed
 * `facts` role, not of “no verifiable claims”. `failedRoles` therefore replaces
 * the empty state with “事实核查角色未完成，不能视为未发现可核查项” and lists the
 * failed articles/errors; a failure of another role never changes this state, and
 * a missing `failedRoles` keeps the normal “未发现可核查项”.
 *
 * Priority order (Task 29): the final report rows are ordered by
 * `FactCheck.priority` ascending (1 = most important), with rows that carry no
 * priority after all prioritized rows in their original input order. Sorting is
 * presentation-only: every row stays in the report (the completeness rule above
 * still holds), and reports persisted without priorities keep their order.
 */
import { defaultTranslate, type Translate } from '../locale'
import type { Article, FactCheck, Report, ReportRoleFailure } from '../../shared/types'
import { FailedRolesNotice } from './FailedRolesNotice'

/** Localized verdict labels, in the documented verdict order. */
const VERDICT_KEYS: Record<FactCheck['verdict'], string> = {
  confirmed: 'report.verdict.confirmed',
  contradicted: 'report.verdict.contradicted',
  unverified: 'report.verdict.unverified',
  insufficient: 'report.verdict.insufficient',
  not_checked: 'report.verdict.not_checked',
}

/** Localized fact kind labels (shared with the live fact-check plan). */
export const FACT_KIND_KEYS: Record<FactCheck['kind'], string> = {
  date: 'report.kind.date',
  time: 'report.kind.time',
  person: 'report.kind.person',
  title: 'report.kind.title',
  organization: 'report.kind.organization',
  place: 'report.kind.place',
  book: 'report.kind.book',
  event: 'report.kind.event',
  number: 'report.kind.number',
  quote: 'report.kind.quote',
  other: 'report.kind.other',
}

/**
 * True when the report was produced without network fact-checking.
 *
 * The authoritative signal is the report's explicit `factCheckMode`:
 * `off` (user disabled it) and `unavailable` (the Host has no `web` service) both
 * mean “未联网核查”. `on` means network checking was requested and available; a
 * failed lookup keeps the mode `on` and is visible per row as `unverified`.
 *
 * The `checks`/`stats` heuristic is **only a legacy fallback** for reports
 * persisted before `factCheckMode` existed. It must not be treated as proof that
 * the network ran: `stats.searchCalls`/`fetchCalls` count attempts before the
 * call, so an unavailable/failed service can still report a call.
 */
export function isOfflineFactCheck(
  checks: readonly FactCheck[] | undefined,
  stats: Report['stats'] | undefined,
  factCheckMode?: Report['factCheckMode'],
): boolean {
  if (factCheckMode === 'off' || factCheckMode === 'unavailable') return true
  if (factCheckMode === 'on') return false
  if (!Array.isArray(checks) || checks.length === 0) return false
  if (stats !== undefined) {
    const searchCalls = Number(stats.searchCalls)
    const fetchCalls = Number(stats.fetchCalls)
    if ((Number.isFinite(searchCalls) && searchCalls > 0) || (Number.isFinite(fetchCalls) && fetchCalls > 0)) {
      return false
    }
  }
  return checks.every(
    (check) => check.verdict === 'unverified' || check.verdict === 'not_checked',
  )
}

/**
 * Normalize `FactCheck.priority` for ordering: a finite number is a real
 * priority, anything else (absent, `NaN`) sorts after every prioritized row.
 */
function normalizeFactPriority(priority: FactCheck['priority']): number | undefined {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : undefined
}

/**
 * Order report rows by `FactCheck.priority` ascending, returning a new array.
 *
 * Rows without a priority come last in their original input order (a stable
 * index tiebreak keeps the sort stable even in engines without a stable
 * `Array#sort`). The input array itself is never mutated and no row is dropped.
 */
export function sortFactChecksByPriority(checks: readonly FactCheck[]): FactCheck[] {
  // `Array.isArray` narrows a readonly array to `any[]`, so re-annotate.
  const rows: readonly FactCheck[] = Array.isArray(checks) ? checks : []
  return rows
    .map((check, index) => ({ check, index }))
    .sort((left, right) => {
      const leftPriority = normalizeFactPriority(left.check.priority)
      const rightPriority = normalizeFactPriority(right.check.priority)
      if (leftPriority !== undefined && rightPriority !== undefined) {
        return leftPriority === rightPriority
          ? left.index - right.index
          : leftPriority - rightPriority
      }
      if (leftPriority !== undefined) return -1
      if (rightPriority !== undefined) return 1
      return left.index - right.index
    })
    .map((entry) => entry.check)
}

/** Props of {@link FactCheckList}. */
export interface FactCheckListProps {
  /** Every fact check of the report; confirmed rows are always rendered. */
  checks: readonly FactCheck[]
  /** Force the 未联网核查 marker (e.g. the run was started with factCheck off). */
  offline?: boolean
  /**
   * Roles that failed for this report (`Report.failedRoles`). When a `facts`
   * role failed, the empty state says the facts were not checked instead of
   * “未发现可核查项”.
   */
  failedRoles?: readonly ReportRoleFailure[]
  /** Articles the report covers; restricts failures to the reported scope. */
  articleIds?: readonly string[]
  /** Articles of the open page (titles for the failed-role list). */
  articles?: readonly Article[]
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** One `{ title, url }` source of a fact check. */
type FactCheckSource = FactCheck['sources'][number]

/** Render one source link; blank URLs are rendered as plain text. */
function sourceLink(source: FactCheckSource, t: Translate) {
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const title = typeof source.title === 'string' && source.title.trim() !== '' ? source.title : url
  if (url === '') return <span key={title}>{title}</span>
  return (
    <a
      key={url}
      className="lgp-source-link"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={t('report.sourceLink', { title })}
    >
      {title}
    </a>
  )
}

/** Render the complete fact checklist table with the offline marker. */
export function FactCheckList({
  checks,
  offline = false,
  failedRoles,
  articleIds,
  articles,
  t = defaultTranslate,
}: FactCheckListProps) {
  // `Array.isArray` narrows a readonly array to `any[]`, so re-annotate: each
  // row must stay a typed `FactCheck` for the verdict/kind key lookups below.
  // `sortFactChecksByPriority` is presentation-only and keeps every row.
  const rows: readonly FactCheck[] = sortFactChecksByPriority(
    Array.isArray(checks) ? checks : [],
  )
  const failures: readonly ReportRoleFailure[] = Array.isArray(failedRoles) ? failedRoles : []
  const reported = new Set(
    (articleIds ?? []).filter((id): id is string => typeof id === 'string'),
  )
  // Only the facts role changes the checklist state, and only for an article
  // this report claims to cover. Other role failures are irrelevant here.
  const factsFailures = failures.filter(
    (failure) =>
      failure.role === 'facts' && (reported.size === 0 || reported.has(failure.articleId)),
  )
  return (
    <section className="lgp-facts" data-lgp-part="fact-checklist">
      <header className="lgp-report-section-head">
        <h3 className="lgp-report-section-title">{t('report.fact.title')}</h3>
        {offline ? (
          <span className="lgp-offline-badge" data-lgp-offline="true">
            {t('report.fact.offline')}
          </span>
        ) : null}
      </header>
      {offline ? <p className="lgp-facts-offline">{t('report.fact.offlineDetail')}</p> : null}
      {factsFailures.length === 0 ? null : (
        <FailedRolesNotice
          failedRoles={factsFailures}
          articles={articles}
          title={t('report.fact.failedTitle')}
          detail={t('report.fact.emptyFailed')}
          part="fact-failed-roles"
          factFailed
          t={t}
        />
      )}
      {rows.length === 0 ? (
        factsFailures.length > 0 ? null : (
          <p className="lgp-report-empty">{t('report.fact.empty')}</p>
        )
      ) : (
        <div className="lgp-facts-scroll">
          <table className="lgp-facts-table">
            <thead>
              <tr>
                <th scope="col">{t('report.fact.claim')}</th>
                <th scope="col">{t('report.fact.quote')}</th>
                <th scope="col">{t('report.fact.kind')}</th>
                <th scope="col">{t('report.fact.verdict')}</th>
                <th scope="col">{t('report.fact.basis')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((check) => {
                const occurrence =
                  typeof check.occurrence === 'number' &&
                  Number.isFinite(check.occurrence) &&
                  check.occurrence > 0
                    ? check.occurrence
                    : undefined
                const priority = normalizeFactPriority(check.priority)
                const sources = Array.isArray(check.sources) ? check.sources : []
                return (
                  <tr
                    key={check.id}
                    data-lgp-fact-id={check.id}
                    data-lgp-fact-verdict={check.verdict}
                    data-lgp-fact-article-id={check.articleId}
                    data-lgp-fact-occurrence={occurrence ?? ''}
                    data-lgp-fact-priority={priority ?? ''}
                  >
                    <td className="lgp-fact-claim">
                      {priority === undefined ? null : (
                        <span className="lgp-fact-priority">
                          {t('fact.priority', { priority })}
                        </span>
                      )}
                      {check.claim}
                    </td>
                    <td className="lgp-fact-quote">
                      “{check.quote}”
                      {occurrence === undefined ? null : (
                        <span className="lgp-fact-occurrence">
                          {t('report.fact.occurrence', { occurrence })}
                        </span>
                      )}
                    </td>
                    <td className="lgp-fact-kind">
                      {t(FACT_KIND_KEYS[check.kind] ?? 'report.kind.other')}
                    </td>
                    <td>
                      <span className={`lgp-verdict lgp-verdict--${check.verdict}`}>
                        {t(VERDICT_KEYS[check.verdict] ?? 'report.verdict.unverified')}
                      </span>
                      {check.needsHuman ? (
                        <span className="lgp-needs-human">{t('report.finding.needsHuman')}</span>
                      ) : null}
                    </td>
                    <td className="lgp-fact-basis">
                      {typeof check.evidence === 'string' && check.evidence.trim() !== '' ? (
                        <span className="lgp-fact-evidence">{check.evidence}</span>
                      ) : null}
                      {sources.length === 0 ? null : (
                        <span className="lgp-fact-sources">
                          {t('report.finding.sources')}
                          {'：'}
                          {sources.map((source) => sourceLink(source, t))}
                        </span>
                      )}
                      {sources.length === 0 &&
                      (typeof check.evidence !== 'string' || check.evidence.trim() === '') ? (
                        <span className="lgp-fact-basis-empty">—</span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

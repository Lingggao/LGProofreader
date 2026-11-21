/**
 * Network noun-check checklist (v1.0.0; independent `nouns` role).
 *
 * The checklist is the report section for the existence-only noun check: every
 * planned noun/term is listed with its kind, the article quote that contains it,
 * the `exists` / `uncertain` / `not_found` / `not_checked` status, the Host's
 * evidence and the sources the search provider returned.
 *
 * Wording constraint (release notes): `not_found` means “the current sources did
 * not include this term”, **never** “the term does not exist”. The status label is
 * 未找到/Not found, and the section carries an explicit disclaimer instead of an
 * absolute judgement.
 *
 * The section is rendered only when the report actually carries noun checks.
 * Older reports (persisted before the `nouns` role existed) therefore keep their
 * previous layout, and a failed `nouns` role does not invent an empty section:
 * role failures are shown by the generic `FailedRolesNotice` instead.
 *
 * Rows are ordered by `NounCheck.priority` ascending (1 = most important), with
 * rows that carry no finite priority after every prioritized row in their input
 * order. Sorting is presentation-only: no row is dropped, and reports persisted
 * without priorities keep their order.
 */
import { defaultTranslate, type Translate } from '../locale'
import type { NounCheck } from '../../shared/types'

/** Localized noun status labels (shared with the live noun-check plan). */
export const NOUN_STATUS_KEYS: Record<NounCheck['status'], string> = {
  exists: 'noun.result.exists',
  uncertain: 'noun.result.uncertain',
  not_found: 'noun.result.not_found',
  not_checked: 'noun.result.not_checked',
}

/** Localized noun-kind labels (shared with the live noun-check plan). */
export const NOUN_KIND_KEYS: Record<NounCheck['kind'], string> = {
  organization: 'noun.kind.organization',
  company: 'noun.kind.company',
  institution: 'noun.kind.institution',
  place: 'noun.kind.place',
  product: 'noun.kind.product',
  system: 'noun.kind.system',
  project: 'noun.kind.project',
  event: 'noun.kind.event',
  person: 'noun.kind.person',
  title: 'noun.kind.title',
  technical_term: 'noun.kind.technical_term',
  other: 'noun.kind.other',
}

/**
 * Normalize `NounCheck.priority` for ordering: a finite number is a real
 * priority, anything else (absent, `NaN`) sorts after every prioritized row.
 */
function normalizeNounPriority(priority: NounCheck['priority']): number | undefined {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : undefined
}

/**
 * Order report rows by `NounCheck.priority` ascending, returning a new array.
 *
 * Rows without a priority come last in their original input order (a stable
 * index tiebreak keeps the sort stable even in engines without a stable
 * `Array#sort`). The input array itself is never mutated and no row is dropped.
 */
export function sortNounChecksByPriority(checks: readonly NounCheck[]): NounCheck[] {
  // `Array.isArray` narrows a readonly array to `any[]`, so re-annotate.
  const rows: readonly NounCheck[] = Array.isArray(checks) ? checks : []
  return rows
    .map((check, index) => ({ check, index }))
    .sort((left, right) => {
      const leftPriority = normalizeNounPriority(left.check.priority)
      const rightPriority = normalizeNounPriority(right.check.priority)
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

/** Props of {@link NounCheckList}. */
export interface NounCheckListProps {
  /** Existence checks of the report; absent/empty renders nothing. */
  checks?: readonly NounCheck[]
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** One `{ title, url }` source of a noun check. */
type NounCheckSource = NounCheck['sources'][number]

/** Render one source link; blank URLs are rendered as plain text. */
function sourceLink(source: NounCheckSource, t: Translate) {
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const title =
    typeof source.title === 'string' && source.title.trim() !== '' ? source.title : url
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

/** Count the four existence statuses of a noun-check list. */
function countNounStatuses(rows: readonly NounCheck[]): {
  exists: number
  uncertain: number
  notFound: number
  notChecked: number
} {
  let exists = 0
  let uncertain = 0
  let notFound = 0
  let notChecked = 0
  for (const row of rows) {
    if (row.status === 'exists') exists += 1
    else if (row.status === 'uncertain') uncertain += 1
    else if (row.status === 'not_found') notFound += 1
    else notChecked += 1
  }
  return { exists, uncertain, notFound, notChecked }
}

/** Render the noun-check report section, or nothing when the report has no checks. */
export function NounCheckList({ checks, t = defaultTranslate }: NounCheckListProps) {
  // `Array.isArray` narrows a readonly array to `any[]`, so re-annotate: each
  // row must stay a typed `NounCheck` for the status/kind key lookups below.
  const rows: readonly NounCheck[] = sortNounChecksByPriority(
    Array.isArray(checks) ? checks : [],
  )
  // “If no nounChecks, render nothing”: an absent/empty list is not presented as
  // “no nouns found”. A failed nouns role is reported by `FailedRolesNotice`.
  if (rows.length === 0) return null
  const counts = countNounStatuses(rows)
  return (
    <section className="lgp-nouns" data-lgp-part="noun-checklist">
      <header className="lgp-report-section-head">
        <h3 className="lgp-report-section-title">{t('report.noun.title')}</h3>
      </header>
      <p
        className="lgp-noun-counts"
        data-lgp-noun-counts="true"
        data-lgp-noun-count-total={rows.length}
        data-lgp-noun-count-exists={counts.exists}
        data-lgp-noun-count-uncertain={counts.uncertain}
        data-lgp-noun-count-not-found={counts.notFound}
        data-lgp-noun-count-not-checked={counts.notChecked}
      >
        {t('report.noun.total', { total: rows.length })}
        <span aria-hidden="true"> · </span>
        {t('report.noun.exists', { exists: counts.exists })}
        <span aria-hidden="true"> · </span>
        {t('report.noun.uncertain', { uncertain: counts.uncertain })}
        <span aria-hidden="true"> · </span>
        {t('report.noun.notFound', { notFound: counts.notFound })}
        {counts.notChecked > 0 ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('report.noun.notChecked', { notChecked: counts.notChecked })}
          </>
        ) : null}
      </p>
      <p className="lgp-noun-disclaimer" data-lgp-noun-disclaimer="true">
        {t('report.noun.disclaimer')}
      </p>
      <div className="lgp-nouns-scroll">
        <table className="lgp-nouns-table">
          <thead>
            <tr>
              <th scope="col">{t('report.noun.name')}</th>
              <th scope="col">{t('report.noun.kind')}</th>
              <th scope="col">{t('report.noun.quote')}</th>
              <th scope="col">{t('report.noun.status')}</th>
              <th scope="col">{t('report.noun.basis')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((check) => {
              const priority = normalizeNounPriority(check.priority)
              const sources = Array.isArray(check.sources) ? check.sources : []
              return (
                <tr
                  key={check.id}
                  data-lgp-noun-id={check.id}
                  data-lgp-noun-status={check.status}
                  data-lgp-noun-article-id={check.articleId}
                  data-lgp-noun-priority={priority ?? ''}
                >
                  <td className="lgp-noun-name">
                    {priority === undefined ? null : (
                      <span className="lgp-noun-priority">
                        {t('fact.priority', { priority })}
                      </span>
                    )}
                    {check.name}
                  </td>
                  <td className="lgp-noun-kind">
                    {t(NOUN_KIND_KEYS[check.kind] ?? 'noun.kind.other')}
                  </td>
                  <td className="lgp-noun-quote">
                    {typeof check.quote === 'string' && check.quote.trim() !== ''
                      ? `“${check.quote}”`
                      : '—'}
                  </td>
                  <td>
                    <span className={`lgp-noun-status lgp-noun-status--${check.status}`}>
                      {t(NOUN_STATUS_KEYS[check.status] ?? 'noun.result.not_checked')}
                    </span>
                    {check.needsHuman ? (
                      <span
                        className="lgp-needs-human"
                        data-lgp-noun-needs-human="true"
                      >
                        {t('report.finding.needsHuman')}
                      </span>
                    ) : null}
                  </td>
                  <td className="lgp-noun-basis">
                    {typeof check.evidence === 'string' && check.evidence.trim() !== '' ? (
                      <span className="lgp-noun-evidence">{check.evidence}</span>
                    ) : null}
                    {sources.length === 0 ? null : (
                      <span className="lgp-noun-sources">
                        {t('report.finding.sources')}
                        {'：'}
                        {sources.map((source) => sourceLink(source, t))}
                      </span>
                    )}
                    {sources.length === 0 &&
                    (typeof check.evidence !== 'string' || check.evidence.trim() === '') ? (
                      <span className="lgp-noun-basis-empty">—</span>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

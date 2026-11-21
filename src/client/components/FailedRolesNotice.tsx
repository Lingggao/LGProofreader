/**
 * Failed-role warning block (Task 21f; design §7.5/§7.6).
 *
 * A failed background role produces **no** result. Rendering an empty result as
 * complete is exactly the release-gate bug this block fixes: a report with
 * `factCheckMode: "on"` and a failed `facts` role must never look like
 * “未发现可核查项”. The component lists every failed role with its article and
 * the provider/stage error, and the fact-checklist variant replaces the normal
 * empty state.
 *
 * The error text comes from `Report.failedRoles[].error`, i.e. the provider/stage
 * message recorded by the Host — never prompt text.
 */
import { defaultTranslate, type Translate } from '../locale'
import type { Article, ReportRoleFailure, RoleId } from '../../shared/types'

/** Locale keys of the proofreading roles (shared with the report role filter). */
const ROLE_KEYS: Record<RoleId, string> = {
  master: 'report.role.master',
  words: 'report.role.words',
  idioms: 'report.role.idioms',
  style: 'report.role.style',
  facts: 'report.role.facts',
  nouns: 'report.role.nouns',
  headline: 'report.role.headline',
  consistency: 'report.role.consistency',
  consolidator: 'report.role.consolidator',
}

/** Localized label of one proofreading role; unknown ids render verbatim. */
export function proofreadRoleLabel(role: RoleId, t: Translate = defaultTranslate): string {
  const key = (ROLE_KEYS as Record<string, string | undefined>)[role]
  return typeof key === 'string' ? t(key) : String(role)
}

/**
 * Article title when it can be resolved, otherwise a readable article-id
 * fallback (a failed role may reference an article the caller did not pass in).
 */
export function failedRoleArticleLabel(
  articleId: string,
  articles: readonly Article[] | undefined,
  t: Translate = defaultTranslate,
): string {
  for (const article of articles ?? []) {
    if (article?.id !== articleId) continue
    const title = typeof article.title === 'string' ? article.title.trim() : ''
    if (title !== '') return title
    break
  }
  if (articleId.trim() === '') return t('report.articleFallbackUnknown')
  return t('report.articleFallback', { id: articleId })
}

/** Provider/stage error of a failed role, or a localized placeholder. */
export function failedRoleErrorLabel(
  failure: ReportRoleFailure,
  t: Translate = defaultTranslate,
): string {
  const error = typeof failure.error === 'string' ? failure.error.trim() : ''
  return error === '' ? t('report.failedRoles.noError') : error
}

/** Props of {@link FailedRolesNotice}. */
export interface FailedRolesNoticeProps {
  /** Roles that failed; an empty/absent list renders nothing. */
  failedRoles?: readonly ReportRoleFailure[]
  /** Articles of the open page, used to resolve articles to titles. */
  articles?: readonly Article[]
  /** Heading override (the fact checklist uses its own wording). */
  title?: string
  /** Explanatory line override. */
  detail?: string
  /** `data-lgp-part` marker; defaults to `failed-roles`. */
  part?: string
  /** Adds `data-lgp-fact-failed` for the fact-checklist variant. */
  factFailed?: boolean
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the failed-role warning block (article, role and error per entry). */
export function FailedRolesNotice({
  failedRoles,
  articles,
  title,
  detail,
  part = 'failed-roles',
  factFailed = false,
  t = defaultTranslate,
}: FailedRolesNoticeProps) {
  const failures: readonly ReportRoleFailure[] = Array.isArray(failedRoles) ? failedRoles : []
  if (failures.length === 0) return null
  const heading = title ?? t('report.failedRoles.title')
  return (
    <section
      className="lgp-failed-roles"
      data-lgp-part={part}
      data-lgp-failed-roles="true"
      data-lgp-failed-role-count={failures.length}
      {...(factFailed ? { 'data-lgp-fact-failed': 'true' } : {})}
      role="alert"
      aria-label={heading}
    >
      <p className="lgp-failed-roles-title">{heading}</p>
      <p className="lgp-failed-roles-detail">{detail ?? t('report.failedRoles.detail')}</p>
      <ul className="lgp-failed-roles-list">
        {failures.map((failure, index) => (
          <li
            key={`${index}-${failure.articleId}-${failure.role}`}
            className="lgp-failed-role"
            data-lgp-failed-role={failure.role}
            data-lgp-failed-role-article={failure.articleId}
          >
            <span className="lgp-failed-role-article">
              {failedRoleArticleLabel(failure.articleId, articles, t)}
            </span>
            <span aria-hidden="true"> · </span>
            <span className="lgp-failed-role-name">{proofreadRoleLabel(failure.role, t)}</span>
            <span className="lgp-failed-role-error">{failedRoleErrorLabel(failure, t)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

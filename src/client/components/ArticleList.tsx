/**
 * Article list of the workbench aside (Task 18; design §9.2/§9.4/§6.5).
 *
 * The list is a **controlled** component: it never selects anything by itself.
 * `App` owns `selectedArticleIds` (the reducer's `selectionChanged` action) and
 * upload/analysis finishing always leaves the selection empty, so the user has
 * to tick an article (or press "本页全部") before Task 19's proofread action can
 * start. This component only renders the explicit selection and reports user
 * intent through `onToggle` / `onSelectAll` / `onClear`.
 *
 * Rows show the article role label (头条/二条/三条/正文), title, confidence and a
 * warning icon (text + icon, never colour alone). The edit toggle reveals
 * controlled title/byline/body fields; every keystroke is reported through
 * `onChangeArticle` (the App snapshots it and `saveLayout`s it, so text is never
 * silently discarded). Layout warnings (overlaps, unassigned regions, empty
 * articles, out-of-page boxes) are listed above the rows and per empty article.
 */
import { useState } from 'react'
import { defaultTranslate, type Translate } from '../locale'
import { renderArticleFullText } from '../../shared/text/clean'
import type { LayoutWarningSummary } from '../layout/ops'
import type { Article, ArticleId } from '../../shared/types'

/** Localized role label of one article (`article.role.<role>`). */
export function articleRoleLabel(role: Article['role'], t: Translate = defaultTranslate): string {
  return t(`article.role.${role}`)
}

/** Text patch reported while editing one article (only the edited fields). */
export interface ArticleTextChange {
  title?: string
  byline?: string
  body?: string
}

/** Confidence as a 0–100 integer for display. */
function confidencePercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100)
}

/** Articles in reading order; ties keep the input order. */
export function sortArticlesByReadingOrder(articles: readonly Article[]): Article[] {
  return articles
    .map((article, index) => ({ article, index }))
    .sort((left, right) => {
      const leftOrder =
        typeof left.article.readingOrder === 'number' && Number.isFinite(left.article.readingOrder)
          ? left.article.readingOrder
          : left.index
      const rightOrder =
        typeof right.article.readingOrder === 'number' && Number.isFinite(right.article.readingOrder)
          ? right.article.readingOrder
          : right.index
      return leftOrder - rightOrder || left.index - right.index
    })
    .map((entry) => entry.article)
}

/** Props of {@link ArticleList}. */
export interface ArticleListProps {
  /** Articles of the open page. */
  articles: readonly Article[]
  /** Explicitly selected article ids; never populated automatically. */
  selectedIds: readonly ArticleId[]
  /** Toggles one article's selection. */
  onToggle: (articleId: ArticleId) => void
  /** Selects every article of the page ("本页全部"). */
  onSelectAll: () => void
  /** Clears the selection ("全不选"). */
  onClear: () => void
  /** Recomputed layout warnings, listed above the rows. */
  warnings?: LayoutWarningSummary
  /** Reports a title/byline/body edit for one article. */
  onChangeArticle?: (articleId: ArticleId, change: ArticleTextChange) => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the explicit article selection list with inline text editing. */
export function ArticleList({
  articles,
  selectedIds,
  onToggle,
  onSelectAll,
  onClear,
  warnings,
  onChangeArticle,
  t = defaultTranslate,
}: ArticleListProps) {
  const selected = new Set(selectedIds)
  const ordered = sortArticlesByReadingOrder(articles)
  const [editingId, setEditingId] = useState<ArticleId | null>(null)

  const toggleEditing = (articleId: ArticleId): void => {
    setEditingId((current) => (current === articleId ? null : articleId))
  }

  return (
    <section className="lgp-article-list" data-lgp-part="article-list" aria-label={t('article.title')}>
      <header className="lgp-article-list-head">
        <h2 className="lgp-article-list-title">{t('article.title')}</h2>
        <span className="lgp-article-list-count">
          {t('article.selected', { count: selected.size, total: ordered.length })}
        </span>
      </header>
      <div className="lgp-article-list-actions">
        <button type="button" className="lgp-button" onClick={onSelectAll}>
          {t('article.selectAll')}
        </button>
        <button type="button" className="lgp-button" onClick={onClear}>
          {t('article.clear')}
        </button>
      </div>
      {warnings !== undefined && warnings.total > 0 ? (
        <div
          className="lgp-article-warnings"
          data-lgp-warning-summary="true"
          data-lgp-warning-overlaps={warnings.overlapCount}
          data-lgp-warning-unassigned={warnings.unassignedRegionIds.length}
          data-lgp-warning-empty-articles={warnings.emptyArticleIds.length}
          data-lgp-warning-out-of-page={warnings.outOfPageRegionIds.length}
          data-lgp-warning-total={warnings.total}
        >
          <span>
            {t('warnings.summary', {
              overlap: warnings.overlapCount,
              unassigned: warnings.unassignedRegionIds.length,
              empty: warnings.emptyArticleIds.length,
              outOfPage: warnings.outOfPageRegionIds.length,
            })}
          </span>
          {warnings.unassignedRegionIds.length > 0 ? (
            <span className="lgp-article-warnings-list" data-lgp-unassigned-list="true">
              {t('warnings.unassignedList', {
                ids: warnings.unassignedRegionIds.join('、'),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {ordered.length === 0 ? (
        <p className="lgp-article-empty">{t('article.empty')}</p>
      ) : (
        <ul className="lgp-article-items">
          {ordered.map((article) => {
            const checked = selected.has(article.id)
            // Defensive: partially-populated article fixtures are valid input
            // for this presentational list (the brief's test passes only id/
            // title/role).
            const warningCount = Array.isArray(article.warnings) ? article.warnings.length : 0
            const percent = confidencePercent(
              typeof article.confidence === 'number' ? article.confidence : 1,
            )
            const title = typeof article.title === 'string' ? article.title : ''
            const byline = typeof article.byline === 'string' ? article.byline : ''
            const body = typeof article.body === 'string' ? article.body : ''
            const fullText = renderArticleFullText(article)
            const emptyArticle = warnings?.emptyArticleIds.includes(article.id) === true
            const editing = editingId === article.id
            const displayTitle = title === '' ? t('article.untitled') : title
            return (
              <li
                key={article.id}
                className={checked ? 'lgp-article-item lgp-article-item--selected' : 'lgp-article-item'}
                data-lgp-article-id={article.id}
                data-lgp-article-selected={checked ? 'true' : 'false'}
                data-lgp-article-editing={editing ? 'true' : 'false'}
              >
                <div className="lgp-article-item-head">
                  <label className="lgp-article-check">
                    <input
                      type="checkbox"
                      className="lgp-article-checkbox"
                      checked={checked}
                      aria-label={`${articleRoleLabel(article.role, t)} ${displayTitle}`}
                      onChange={() => onToggle(article.id)}
                    />
                    <span className="lgp-article-role">{articleRoleLabel(article.role, t)}</span>
                    <span className="lgp-article-title">{displayTitle}</span>
                  </label>
                  <button
                    type="button"
                    className="lgp-button lgp-button--ghost lgp-article-edit"
                    aria-label={t('article.editLabel', { title: displayTitle })}
                    aria-expanded={editing}
                    onClick={() => toggleEditing(article.id)}
                  >
                    {editing ? t('article.editDone') : t('article.edit')}
                  </button>
                </div>
                <span className="lgp-article-meta">
                  {t('article.confidence', { percent })}
                  {emptyArticle ? (
                    <span className="lgp-article-empty-flag" data-lgp-article-empty="true">
                      {t('warnings.emptyArticle')}
                    </span>
                  ) : null}
                  {warningCount > 0 ? (
                    <span
                      className="lgp-article-warning"
                      role="img"
                      aria-label={t('article.warningCount', { count: warningCount })}
                    >
                      !
                    </span>
                  ) : null}
                </span>
                {editing ? (
                  <div className="lgp-article-editor">
                    {fullText === '' ? null : (
                      <div className="lgp-article-fulltext" data-lgp-article-fulltext="true">
                        <span className="lgp-article-field-label">{t('article.fullText')}</span>
                        <pre className="lgp-article-fulltext-body">{fullText}</pre>
                      </div>
                    )}
                    <label className="lgp-article-field">
                      <span className="lgp-article-field-label">{t('article.field.title')}</span>
                      <input
                        className="lgp-input lgp-article-input"
                        aria-label={t('article.field.title')}
                        value={title}
                        onChange={(event) =>
                          onChangeArticle?.(article.id, { title: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="lgp-article-field">
                      <span className="lgp-article-field-label">{t('article.field.byline')}</span>
                      <input
                        className="lgp-input lgp-article-input"
                        aria-label={t('article.field.byline')}
                        value={byline}
                        onChange={(event) =>
                          onChangeArticle?.(article.id, { byline: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="lgp-article-field">
                      <span className="lgp-article-field-label">{t('article.field.body')}</span>
                      <textarea
                        className="lgp-input lgp-article-textarea"
                        aria-label={t('article.field.body')}
                        rows={5}
                        value={body}
                        onChange={(event) =>
                          onChangeArticle?.(article.id, { body: event.currentTarget.value })
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

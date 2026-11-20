/**
 * Findings list with filters and report actions (Tasks 19/19b; design §9.4).
 *
 * Findings are grouped by article in report order (`report.articleIds` order is
 * preserved through the `articles` prop; findings of an article missing from the
 * prop still render under a `文章 <id>` heading so nothing is dropped). Filters:
 * severity, category and article (Task 19) plus finding role, status and a
 * case-insensitive keyword over issue/quote/suggestion (Task 19b).
 *
 * Empty states are deliberately distinct (Task 19b):
 * - a report with **no findings at all** shows 未发现问题 and renders no filter
 *   controls (there is nothing to filter);
 * - a filtered-to-empty list shows 没有符合筛选条件的问题 while keeping the
 *   filters, so the user can see why nothing matches.
 *
 * Batch accept (Task 19b): each card has a checkbox; 接受所选 accepts the checked
 * findings, 全部接受 accepts every finding of the report (a report-wide action
 * that filters do not narrow). Both only report `Finding.status` changes through
 * `onStatusChange` — the article text is never mutated, and the report data
 * itself stays owned by `App`.
 */
import { useMemo, useState } from 'react'
import { defaultTranslate, type Translate } from '../locale'
import type { Article, ArticleId, Finding } from '../../shared/types'
import { FindingCard, STATUS_KEYS, categoryLabel } from './FindingCard'
import { ReportToolbar } from './ReportToolbar'

/** Category order used by the category filter and labels. */
export const CATEGORY_ORDER: readonly Finding['category'][] = [
  'typo',
  'punctuation',
  'word',
  'idiom',
  'grammar',
  'fact',
  'consistency',
  'headline',
  'format',
]

/** Role order used by the role filter (design §7.2). */
export const ROLE_ORDER: readonly string[] = [
  'master',
  'words',
  'idioms',
  'style',
  'facts',
  'headline',
  'consistency',
  'consolidator',
]

/** Localized severity filter labels. */
const SEVERITY_FILTER_KEYS: ReadonlyArray<{ value: Finding['severity']; key: string }> = [
  { value: 'must_fix', key: 'report.severity.must_fix' },
  { value: 'suggested', key: 'report.severity.suggested' },
  { value: 'optional', key: 'report.severity.optional' },
]

/** Status filter order. */
const STATUS_ORDER: readonly Finding['status'][] = ['open', 'accepted', 'rejected', 'deferred']

/** Role label; unknown role ids fall back to the raw value instead of a default. */
export function roleLabel(role: string, t: Translate = defaultTranslate): string {
  const key = `report.role.${role}`
  const translated = t(key)
  return translated === key ? role : translated
}

/** Case-insensitive keyword match over issue, quote and suggestion. */
export function matchesKeyword(finding: Finding, keyword: string): boolean {
  const query = keyword.trim().toLowerCase()
  if (query === '') return true
  const haystack = [finding.issue, finding.quote, finding.suggestion]
  return haystack.some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(query),
  )
}

/** Props of {@link ReportList}. */
export interface ReportListProps {
  /** Every finding of the report, in report order. */
  findings: readonly Finding[]
  /** Articles used for the group headings + article filter. */
  articles?: readonly Article[]
  /** Reports a finding status change (accept/reject/defer). */
  onStatusChange?: (findingId: string, status: Finding['status']) => void
  /** Asks the canvas to locate + highlight one finding (Task 19b). */
  onLocate?: (finding: Finding) => void
  /** Copy action (rendered through {@link ReportToolbar}). */
  onCopy?: () => Promise<boolean> | boolean
  /** `href` of the Host Markdown export. */
  exportHref?: string
  /** File name suggested to the browser for the Markdown download. */
  exportFileName?: string
  /** `href` of the Host JSON export (Task 19b). */
  exportJsonHref?: string
  /** File name suggested to the browser for the JSON download. */
  exportJsonFileName?: string
  /** Export-link activation hook. */
  onExport?: () => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the filterable, per-article findings list. */
export function ReportList({
  findings,
  articles = [],
  onStatusChange,
  onLocate,
  onCopy,
  exportHref,
  exportFileName,
  exportJsonHref,
  exportJsonFileName,
  onExport,
  t = defaultTranslate,
}: ReportListProps) {
  const [severity, setSeverity] = useState<'' | Finding['severity']>('')
  const [category, setCategory] = useState<'' | Finding['category']>('')
  const [articleId, setArticleId] = useState<'' | ArticleId>('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState<'' | Finding['status']>('')
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>())

  const articleTitles = useMemo(() => {
    const map = new Map<ArticleId, string>()
    for (const article of articles) {
      if (typeof article?.id !== 'string') continue
      map.set(article.id, typeof article.title === 'string' ? article.title : '')
    }
    return map
  }, [articles])

  /** Article ids in report/article order, extended with ids only seen in findings. */
  const orderedArticleIds = useMemo(() => {
    const ids: ArticleId[] = []
    const seen = new Set<ArticleId>()
    const add = (id: ArticleId): void => {
      if (typeof id !== 'string' || id === '' || seen.has(id)) return
      seen.add(id)
      ids.push(id)
    }
    for (const article of articles) add(article.id)
    for (const finding of findings) add(finding.articleId)
    return ids
  }, [articles, findings])

  const categories = useMemo(() => {
    const present = new Set(findings.map((finding) => finding.category))
    const ordered = CATEGORY_ORDER.filter((value) => present.has(value))
    const unknown = [...present].filter((value) => !CATEGORY_ORDER.includes(value)).sort()
    return [...ordered, ...unknown]
  }, [findings])

  const roles = useMemo(() => {
    const present = new Set<string>()
    for (const finding of findings) {
      if (!Array.isArray(finding.roles)) continue
      for (const value of finding.roles) {
        if (typeof value === 'string' && value !== '') present.add(value)
      }
    }
    const ordered = ROLE_ORDER.filter((value) => present.has(value))
    const unknown = [...present].filter((value) => !ROLE_ORDER.includes(value)).sort()
    return [...ordered, ...unknown]
  }, [findings])

  const visible = findings.filter(
    (finding) =>
      (severity === '' || finding.severity === severity) &&
      (category === '' || finding.category === category) &&
      (articleId === '' || finding.articleId === articleId) &&
      (role === '' ||
        (Array.isArray(finding.roles) && finding.roles.includes(role))) &&
      (status === '' || finding.status === status) &&
      matchesKeyword(finding, keyword),
  )

  const groups = orderedArticleIds
    .map((id) => ({
      id,
      title: articleTitles.get(id) ?? '',
      findings: visible.filter((finding) => finding.articleId === id),
    }))
    .filter((group) => group.findings.length > 0)

  const groupTitle = (id: ArticleId, title: string): string => {
    if (title.trim() !== '') return title
    return id === '' ? t('report.articleFallbackUnknown') : t('report.articleFallback', { id })
  }

  /** Checked findings that still exist in the report (stale ids are ignored). */
  const selectedFindings = findings.filter((finding) => selectedIds.has(finding.id))
  const selectedCount = selectedFindings.length

  const toggleSelected = (findingId: string, selected: boolean): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (selected) next.add(findingId)
      else next.delete(findingId)
      return next
    })
  }

  /** Accept one set of findings through `onStatusChange`; never mutates a finding. */
  const accept = (targets: readonly Finding[]): void => {
    if (onStatusChange === undefined) return
    for (const finding of targets) {
      if (finding.status === 'accepted') continue
      onStatusChange(finding.id, 'accepted')
    }
    setSelectedIds(new Set<string>())
  }

  return (
    <section className="lgp-report-list" data-lgp-part="report-list">
      <ReportToolbar
        onCopy={onCopy}
        exportHref={exportHref}
        exportFileName={exportFileName}
        exportJsonHref={exportJsonHref}
        exportJsonFileName={exportJsonFileName}
        onExport={onExport}
        t={t}
      />
      {findings.length === 0 ? (
        <p className="lgp-report-empty" data-lgp-report-empty="none">
          {t('report.noFindings')}
        </p>
      ) : (
        <>
          <div className="lgp-report-filters" data-lgp-part="report-filters">
            <label className="lgp-report-filter">
              <span className="lgp-report-filter-label">{t('report.filter.severity')}</span>
              <select
                className="lgp-report-select"
                aria-label={t('report.filter.severity')}
                value={severity}
                onChange={(event) => setSeverity(event.currentTarget.value as '' | Finding['severity'])}
              >
                <option value="">{t('report.filter.all')}</option>
                {SEVERITY_FILTER_KEYS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="lgp-report-filter">
              <span className="lgp-report-filter-label">{t('report.filter.category')}</span>
              <select
                className="lgp-report-select"
                aria-label={t('report.filter.category')}
                value={category}
                onChange={(event) => setCategory(event.currentTarget.value as '' | Finding['category'])}
              >
                <option value="">{t('report.filter.all')}</option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {categoryLabel(value, t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="lgp-report-filter">
              <span className="lgp-report-filter-label">{t('report.filter.article')}</span>
              <select
                className="lgp-report-select"
                aria-label={t('report.filter.article')}
                value={articleId}
                onChange={(event) => setArticleId(event.currentTarget.value)}
              >
                <option value="">{t('report.filter.all')}</option>
                {orderedArticleIds.map((id) => (
                  <option key={id} value={id}>
                    {groupTitle(id, articleTitles.get(id) ?? '')}
                  </option>
                ))}
              </select>
            </label>
            <label className="lgp-report-filter">
              <span className="lgp-report-filter-label">{t('report.filter.role')}</span>
              <select
                className="lgp-report-select"
                aria-label={t('report.filter.role')}
                value={role}
                onChange={(event) => setRole(event.currentTarget.value)}
              >
                <option value="">{t('report.filter.all')}</option>
                {roles.map((value) => (
                  <option key={value} value={value}>
                    {roleLabel(value, t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="lgp-report-filter">
              <span className="lgp-report-filter-label">{t('report.filter.status')}</span>
              <select
                className="lgp-report-select"
                aria-label={t('report.filter.status')}
                value={status}
                onChange={(event) => setStatus(event.currentTarget.value as '' | Finding['status'])}
              >
                <option value="">{t('report.filter.all')}</option>
                {STATUS_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {t(STATUS_KEYS[value])}
                  </option>
                ))}
              </select>
            </label>
            <label className="lgp-report-filter lgp-report-filter--keyword">
              <span className="lgp-report-filter-label">{t('report.filter.keyword')}</span>
              <input
                type="search"
                className="lgp-report-input"
                aria-label={t('report.filter.keyword')}
                placeholder={t('report.filter.keywordPlaceholder')}
                value={keyword}
                onChange={(event) => setKeyword(event.currentTarget.value)}
              />
            </label>
            <span className="lgp-report-count" data-lgp-report-visible={visible.length}>
              {t('report.showing', { visible: visible.length, total: findings.length })}
            </span>
          </div>
          <div className="lgp-report-batch" data-lgp-part="report-batch">
            <span className="lgp-report-batch-count" data-lgp-report-selected={selectedCount}>
              {t('report.batch.selected', { count: selectedCount })}
            </span>
            <button
              type="button"
              className="lgp-button"
              disabled={onStatusChange === undefined || selectedCount === 0}
              onClick={() => accept(selectedFindings)}
            >
              {t('report.batch.acceptSelected')}
            </button>
            <button
              type="button"
              className="lgp-button"
              disabled={onStatusChange === undefined || findings.length === 0}
              onClick={() => accept(findings)}
            >
              {t('report.batch.acceptAll')}
            </button>
          </div>
          {visible.length === 0 ? (
            <p className="lgp-report-empty" data-lgp-report-empty="filtered">
              {t('report.noMatch')}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="lgp-report-article" data-lgp-report-article={group.id}>
                <h3 className="lgp-report-article-title">{groupTitle(group.id, group.title)}</h3>
                <div className="lgp-report-cards">
                  {group.findings.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      selected={selectedIds.has(finding.id)}
                      onSelectChange={(selected) => toggleSelected(finding.id, selected)}
                      onStatusChange={onStatusChange}
                      onLocate={onLocate}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </section>
  )
}

/**
 * One proofreading finding card (Tasks 19/19b; design §7.3/§7.6/§9.4).
 *
 * Every card shows: severity + category badges (text, never colour alone), the
 * confidence badge (Task 19b), the article it belongs to, the quote (with its
 * `occurrence` when the same quote appears more than once), the issue, the
 * suggestion, the reason/evidence and every source link. A finding the validator
 * could not locate is marked 需人工确认 instead of being hidden.
 *
 * Suggestion bolding follows design §7.6.4: the consolidator may mark the changed
 * words with `**…**`, and only those marked segments are rendered as `<strong>`;
 * the markers themselves are never shown and the rest of the suggestion is never
 * bolded. A suggestion without markers is the replacement text itself, so it is
 * bolded as a whole (matching the Markdown export, which bold-wraps it).
 *
 * Task 19b adds:
 * - a 定位 action (`onLocate`) that asks `App` to select the article/region and
 *   pulse it on the canvas — it never rewrites the article;
 * - an optional per-finding selection checkbox used by the report's batch accept
 *   (`selected` / `onSelectChange`).
 *
 * Status actions (接受 / 忽略 / 待定) and batch accept only change the report
 * state — the article text is never rewritten (design §9.4).
 */
import { defaultTranslate, type Translate } from '../locale'
import type { Finding } from '../../shared/types'
import { InlineMarkdown, parseBoldSpans } from './InlineMarkdown'

/** Localized severity labels. */
export const SEVERITY_KEYS: Record<Finding['severity'], string> = {
  must_fix: 'report.severity.must_fix',
  suggested: 'report.severity.suggested',
  optional: 'report.severity.optional',
}

/** Localized category labels. */
export const CATEGORY_KEYS: Record<Finding['category'], string> = {
  typo: 'report.category.typo',
  punctuation: 'report.category.punctuation',
  word: 'report.category.word',
  idiom: 'report.category.idiom',
  grammar: 'report.category.grammar',
  fact: 'report.category.fact',
  consistency: 'report.category.consistency',
  headline: 'report.category.headline',
  format: 'report.category.format',
}

/** Localized finding status labels. */
export const STATUS_KEYS: Record<Finding['status'], string> = {
  open: 'report.finding.status.open',
  accepted: 'report.finding.status.accepted',
  rejected: 'report.finding.status.rejected',
  deferred: 'report.finding.status.deferred',
}

/** Localized confidence labels (Task 19b). */
export const CONFIDENCE_KEYS: Record<Finding['confidence'], string> = {
  high: 'report.confidence.high',
  medium: 'report.confidence.medium',
  low: 'report.confidence.low',
}

/** Localized status action labels. */
const ACTION_KEYS: ReadonlyArray<{ status: Finding['status']; key: string }> = [
  { status: 'accepted', key: 'report.finding.accept' },
  { status: 'rejected', key: 'report.finding.reject' },
  { status: 'deferred', key: 'report.finding.defer' },
]

/**
 * Category label; an unknown/malformed category falls back to its **raw** value
 * instead of a default such as 错别字, so a future category is never mislabelled.
 */
export function categoryLabel(category: string, t: Translate = defaultTranslate): string {
  const key = CATEGORY_KEYS[category as Finding['category']]
  if (key !== undefined) return t(key)
  const raw = typeof category === 'string' ? category.trim() : ''
  return raw === '' ? '—' : raw
}

/** Severity label with the same raw fallback for malformed stored reports. */
export function severityLabel(severity: string, t: Translate = defaultTranslate): string {
  const key = SEVERITY_KEYS[severity as Finding['severity']]
  if (key !== undefined) return t(key)
  const raw = typeof severity === 'string' ? severity.trim() : ''
  return raw === '' ? '—' : raw
}

/**
 * One piece of a suggestion: `strong` parts come from `**…**` markers, plain
 * parts are the surrounding text.
 */
export interface SuggestionSpan {
  text: string
  strong: boolean
}

/**
 * Split a suggestion into bold/plain spans.
 *
 * - `**…**` pairs mark bold segments; the markers are removed;
 * - an unmatched marker is kept literally (no text is ever dropped);
 * - a suggestion without any marker is the replacement text itself and is
 *   returned as one bold span (the Markdown export bold-wraps it too).
 *
 * The span parsing is the shared Task 24 {@link parseBoldSpans}; only the
 * whole-bold fallback below is specific to suggestions.
 */
export function parseSuggestionSpans(text: string | undefined): SuggestionSpan[] {
  const value = typeof text === 'string' ? text : ''
  const spans = parseBoldSpans(value)
  if (spans.length === 0) return []
  const hasMarked = spans.some((span) => span.strong)
  // No `**` marker at all: the whole suggestion is the replacement text and is
  // bolded (same as the Markdown export). A literal unmatched marker is kept as
  // plain text and must not turn the whole suggestion bold by accident.
  if (!hasMarked && !value.includes('**')) return [{ text: value, strong: true }]
  return spans
}

/** Render a suggestion with only the marked segments bolded. */
function Suggestion({ text, t }: { text: string | undefined; t: Translate }) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') {
    return <strong className="lgp-finding-suggestion">{t('report.finding.deleteSuggestion')}</strong>
  }
  const spans = parseSuggestionSpans(value)
  return (
    <span className="lgp-finding-suggestion" data-lgp-suggestion-spans={spans.length}>
      <InlineMarkdown text={value} boldUnmarked />
    </span>
  )
}

/** Props of {@link FindingCard}. */
export interface FindingCardProps {
  /** The finding to render. */
  finding: Finding
  /** Reports 接受 / 忽略 / 待定 for this finding. */
  onStatusChange?: (findingId: string, status: Finding['status']) => void
  /** Asks the parent to select + highlight the finding on the canvas (Task 19b). */
  onLocate?: (finding: Finding) => void
  /** Whether this finding is checked for a batch action. */
  selected?: boolean
  /** Reports a batch-selection change for this finding. */
  onSelectChange?: (selected: boolean) => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render one finding card. */
export function FindingCard({
  finding,
  onStatusChange,
  onLocate,
  selected,
  onSelectChange,
  t = defaultTranslate,
}: FindingCardProps) {
  const severity = severityLabel(finding.severity, t)
  const category = categoryLabel(finding.category, t)
  const status = t(STATUS_KEYS[finding.status] ?? 'report.finding.status.open')
  const confidenceKey = CONFIDENCE_KEYS[finding.confidence]
  const confidence = confidenceKey === undefined ? '' : t(confidenceKey)
  const occurrence =
    typeof finding.occurrence === 'number' &&
    Number.isFinite(finding.occurrence) &&
    finding.occurrence > 0
      ? finding.occurrence
      : undefined
  const sources = Array.isArray(finding.sources) ? finding.sources : []
  const selectable = onSelectChange !== undefined
  const checkboxLabel = t('report.batch.selectFinding', {
    issue: finding.issue !== '' ? finding.issue : finding.id,
  })

  return (
    <article
      className={`lgp-finding lgp-finding--${finding.severity}`}
      data-lgp-finding-id={finding.id}
      data-lgp-article-id={finding.articleId}
      data-lgp-severity={finding.severity}
      data-lgp-category={finding.category}
      data-lgp-status={finding.status}
      data-lgp-card-confidence={finding.confidence}
      data-lgp-selected={selected === true ? 'true' : 'false'}
      aria-label={`${severity} ${category}`}
    >
      <header className="lgp-finding-head">
        {selectable ? (
          <input
            type="checkbox"
            className="lgp-finding-select"
            checked={selected === true}
            aria-label={checkboxLabel}
            onChange={(event) => onSelectChange?.(event.currentTarget.checked)}
          />
        ) : null}
        <span className={`lgp-severity lgp-severity--${finding.severity}`}>{severity}</span>
        <span className={`lgp-category lgp-category--${finding.category}`}>{category}</span>
        {confidence === '' ? null : (
          <span className="lgp-confidence" data-lgp-confidence={finding.confidence}>
            {confidence}
          </span>
        )}
        <span className="lgp-finding-status">{status}</span>
      </header>
      <blockquote className="lgp-finding-quote">
        “{finding.quote}”
        {occurrence === undefined ? null : (
          <span className="lgp-finding-occurrence">
            {t('report.finding.occurrence', { occurrence })}
          </span>
        )}
      </blockquote>
      <p className="lgp-finding-issue">{t('report.finding.issueText', { issue: finding.issue })}</p>
      <p className="lgp-finding-suggestion-line">
        <span className="lgp-finding-suggestion-label">{t('report.finding.suggestion')}</span>
        <Suggestion text={finding.suggestion} t={t} />
      </p>
      {typeof finding.reason === 'string' && finding.reason.trim() !== '' ? (
        <p className="lgp-finding-basis">{t('report.finding.reason', { reason: finding.reason })}</p>
      ) : null}
      {typeof finding.evidence === 'string' && finding.evidence.trim() !== '' ? (
        <p className="lgp-finding-basis">{t('report.finding.evidence', { evidence: finding.evidence })}</p>
      ) : null}
      {finding.needsHuman ? (
        <span className="lgp-needs-human" data-lgp-needs-human="true">
          {t('report.finding.needsHuman')}
        </span>
      ) : null}
      <footer className="lgp-finding-foot">
        {sources.length === 0 ? null : (
          <span className="lgp-finding-sources">
            {t('report.finding.sources')}
            {'：'}
            {sources.map((source) => {
              const url = typeof source.url === 'string' ? source.url.trim() : ''
              const label =
                typeof source.title === 'string' && source.title.trim() !== ''
                  ? source.title
                  : url
              return url === '' ? (
                <span key={label}>{label}</span>
              ) : (
                <a
                  key={url}
                  className="lgp-source-link"
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {label}
                </a>
              )
            })}
          </span>
        )}
        <span className="lgp-finding-actions">
          {onLocate === undefined ? null : (
            <button
              type="button"
              className="lgp-button lgp-button--ghost lgp-finding-action lgp-finding-locate"
              title={t('report.finding.locateLabel', { quote: finding.quote })}
              onClick={() => onLocate(finding)}
            >
              {t('report.finding.locate')}
            </button>
          )}
          {onStatusChange === undefined
            ? null
            : ACTION_KEYS.map((action) => (
                <button
                  key={action.status}
                  type="button"
                  className="lgp-button lgp-button--ghost lgp-finding-action"
                  aria-pressed={finding.status === action.status}
                  onClick={() => onStatusChange(finding.id, action.status)}
                >
                  {t(action.key)}
                </button>
              ))}
        </span>
      </footer>
    </article>
  )
}

/**
 * Live network noun-check plan and progress (v1.0.0; independent `nouns` role).
 *
 * Presentational child of `JobProgress`: whenever the Host emits
 * `JobView.nounProgress` (after noun extraction, after each search round and
 * after the existence classification), the proofreading panel shows the
 * exhaustive plan — summary counts, phase/elapsed and the priority-ordered noun
 * rows — instead of only the coarse job stages. The component owns no clock:
 * every polled `JobView` prop change re-renders the latest snapshot; the elapsed
 * time is computed from `NounProgress.startedAt` against the current time (or an
 * injected `now` in tests).
 *
 * `total === 0` (“no nouns worth checking”, a valid planning result) shows the
 * explicit empty line instead of an empty list. A failed `nouns` role is *not*
 * rendered here — role failures are shown by the generic `FailedRolesNotice` —
 * so the two states cannot be conflated.
 *
 * The noun list is the plan as supplied (the Host already sorts by priority; the
 * component sorts defensively anyway); it is capped and scrollable so the
 * proofread controls below stay reachable while the noun role runs.
 */
import { defaultTranslate, type Translate } from '../locale'
import { NOUN_KIND_KEYS, NOUN_STATUS_KEYS } from './NounCheckList'
import type {
  NounProgress as NounProgressData,
  NounProgressItem,
} from '../../shared/types'

/** Localized phase labels, in the documented phase order. */
const PHASE_KEYS: Record<NounProgressData['phase'], string> = {
  planning: 'noun.phase.planning',
  searching: 'noun.phase.searching',
  verifying: 'noun.phase.verifying',
  done: 'noun.phase.done',
}

/** Localized item status labels, in the documented item status order. */
const ITEM_STATUS_KEYS: Record<NounProgressItem['status'], string> = {
  pending: 'noun.status.pending',
  searching: 'noun.status.searching',
  searched: 'noun.status.searched',
  verifying: 'noun.status.verifying',
  checked: 'noun.status.checked',
  not_checked: 'noun.status.not_checked',
}

/** Clamp a non-finite/negative duration to 0. */
function normalizeDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0
  return ms
}

/**
 * Format an elapsed duration as `m:ss` (e.g. `1:05`).
 *
 * Elapsed proofs are bounded by the role timeout (well under an hour), but the
 * minutes are deliberately not wrapped at 60 so a stalled job stays readable.
 */
export function formatNounElapsed(ms: number): string {
  const totalSeconds = Math.floor(normalizeDuration(ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Normalize a finite priority; anything else sorts after prioritized rows. */
function normalizeItemPriority(priority: NounProgressItem['priority']): number | undefined {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : undefined
}

/**
 * Order plan rows by `priority` ascending, returning a new array.
 *
 * Rows without a finite priority come last in their original input order; a
 * stable index tiebreak keeps the sort deterministic. The input is not mutated.
 */
export function sortNounPlanItems(
  items: readonly NounProgressItem[],
): NounProgressItem[] {
  // `Array.isArray` narrows a readonly array to `any[]`, so re-annotate.
  const rows: readonly NounProgressItem[] = Array.isArray(items) ? items : []
  return rows
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftPriority = normalizeItemPriority(left.item.priority)
      const rightPriority = normalizeItemPriority(right.item.priority)
      if (leftPriority !== undefined && rightPriority !== undefined) {
        return leftPriority === rightPriority
          ? left.index - right.index
          : leftPriority - rightPriority
      }
      if (leftPriority !== undefined) return -1
      if (rightPriority !== undefined) return 1
      return left.index - right.index
    })
    .map((entry) => entry.item)
}

/** Props of {@link NounProgress}. */
export interface NounProgressProps {
  /** The latest `JobView.nounProgress` snapshot polled from the Host. */
  progress: NounProgressData
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
  /**
   * Injectable clock (epoch ms) for the elapsed label; defaults to `Date.now()`.
   * Tests pass a fixed value instead of mocking the global clock.
   */
  now?: number
}

/** Render the live noun-check plan: summary counts, phase/elapsed and ordered nouns. */
export function NounProgress({ progress, t = defaultTranslate, now }: NounProgressProps) {
  const items = sortNounPlanItems(Array.isArray(progress.items) ? progress.items : [])
  const total = typeof progress.total === 'number' && Number.isFinite(progress.total)
    ? progress.total
    : items.length
  const searched = typeof progress.searched === 'number' ? progress.searched : 0
  const checked = typeof progress.checked === 'number' ? progress.checked : 0
  const notChecked = typeof progress.notChecked === 'number' ? progress.notChecked : 0
  const phaseKey = PHASE_KEYS[progress.phase] ?? 'noun.phase.planning'
  const startedAt =
    typeof progress.startedAt === 'number' && Number.isFinite(progress.startedAt)
      ? progress.startedAt
      : undefined
  const current = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const elapsed = startedAt === undefined ? undefined : formatNounElapsed(current - startedAt)

  if (total === 0) {
    return (
      <section
        className="lgp-noun-plan"
        data-lgp-part="noun-progress"
        data-lgp-noun-plan-phase={progress.phase}
        aria-label={t('noun.plan.title')}
      >
        <h4 className="lgp-noun-plan-title">{t('noun.plan.title')}</h4>
        <p className="lgp-noun-plan-empty" data-lgp-noun-plan-empty="true">
          {t('noun.plan.empty')}
        </p>
      </section>
    )
  }

  return (
    <section
      className="lgp-noun-plan"
      data-lgp-part="noun-progress"
      data-lgp-noun-plan-phase={progress.phase}
      data-lgp-noun-plan-total={total}
      data-lgp-noun-plan-elapsed={elapsed ?? ''}
      aria-label={t('noun.plan.title')}
    >
      <h4 className="lgp-noun-plan-title">{t('noun.plan.title')}</h4>
      <p
        className="lgp-noun-plan-summary"
        role="status"
        aria-live="polite"
        data-lgp-noun-plan-summary="true"
      >
        {t('noun.plan.needed', { total })}
        <span aria-hidden="true"> · </span>
        {t('noun.plan.searched', { searched })}
        <span aria-hidden="true"> · </span>
        {t('noun.plan.checked', { checked })}
        {notChecked > 0 ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('noun.plan.notChecked', { notChecked })}
          </>
        ) : null}
      </p>
      <p className="lgp-noun-plan-meta">
        <span className="lgp-noun-plan-phase">
          {t('noun.plan.phase', { phase: t(phaseKey) })}
        </span>
        {elapsed === undefined ? null : (
          <>
            <span aria-hidden="true"> · </span>
            <span className="lgp-noun-plan-elapsed">
              {t('noun.plan.elapsed', { elapsed })}
            </span>
          </>
        )}
      </p>
      {items.length === 0 ? null : (
        <ol className="lgp-noun-plan-list" aria-label={t('noun.plan.listLabel')}>
          {items.map((item) => {
            const result =
              item.result === undefined ? undefined : NOUN_STATUS_KEYS[item.result]
            return (
              <li
                key={item.id}
                className={`lgp-noun-plan-item lgp-noun-plan-item--${item.status}`}
                data-lgp-noun-plan-id={item.id}
                data-lgp-noun-plan-status={item.status}
                data-lgp-noun-plan-priority={item.priority}
                data-lgp-noun-plan-article-id={item.articleId}
                data-lgp-noun-plan-result={item.result ?? ''}
              >
                <span className="lgp-noun-plan-priority">
                  {t('fact.priority', { priority: item.priority })}
                </span>
                <span className="lgp-noun-plan-kind">
                  {t(NOUN_KIND_KEYS[item.kind] ?? 'noun.kind.other')}
                </span>
                <span className="lgp-noun-plan-name">{item.name}</span>
                {typeof item.quote === 'string' && item.quote.trim() !== '' ? (
                  <span className="lgp-noun-plan-quote">“{item.quote}”</span>
                ) : null}
                <span
                  className={`lgp-noun-plan-status lgp-noun-plan-status--${item.status}`}
                >
                  {t(ITEM_STATUS_KEYS[item.status] ?? 'noun.status.pending')}
                </span>
                {result === undefined || item.status !== 'checked' ? null : (
                  <span
                    className={`lgp-noun-plan-result lgp-noun-plan-result--${item.result}`}
                  >
                    {t(result)}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

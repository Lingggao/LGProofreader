/**
 * Live network fact-check plan and progress (Task 29; design §9.3).
 *
 * Presentational child of `JobProgress`: whenever the Host emits
 * `JobView.factProgress` (after claim extraction, after each search round and
 * after the verdict call), the proofreading panel shows the exhaustive plan —
 * summary counts, phase and the priority-ordered claim rows — instead of only
 * the coarse job stages. The component owns no timers: every polled `JobView`
 * prop change simply re-renders the latest snapshot.
 *
 * `total === 0` (“no verifiable claims found”) is a valid plan result. A failed
 * facts role is *not* rendered here — that notice lives in `FactCheckList` — so
 * the two states cannot be conflated.
 *
 * The claim list is the plan as supplied (the Host already sorts by priority);
 * it is capped and scrollable so the proofread controls below stay reachable
 * while the facts role runs.
 */
import { defaultTranslate, type Translate } from '../locale'
import { FACT_KIND_KEYS } from './FactCheckList'
import type { FactCheckProgress, FactCheckProgressItem } from '../../shared/types'

/** Localized phase labels, in the documented phase order. */
const PHASE_KEYS: Record<FactCheckProgress['phase'], string> = {
  planning: 'fact.phase.planning',
  searching: 'fact.phase.searching',
  verifying: 'fact.phase.verifying',
  done: 'fact.phase.done',
}

/** Localized claim status labels, in the documented item status order. */
const ITEM_STATUS_KEYS: Record<FactCheckProgressItem['status'], string> = {
  pending: 'fact.status.pending',
  searching: 'fact.status.searching',
  searched: 'fact.status.searched',
  verifying: 'fact.status.verifying',
  checked: 'fact.status.checked',
  not_checked: 'fact.status.not_checked',
}

/** Props of {@link FactProgress}. */
export interface FactProgressProps {
  /** The latest `JobView.factProgress` snapshot polled from the Host. */
  progress: FactCheckProgress
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the live fact-check plan: summary counts, phase and ordered claims. */
export function FactProgress({ progress, t = defaultTranslate }: FactProgressProps) {
  const items = Array.isArray(progress.items) ? progress.items : []
  const { total, checked, searched, notChecked } = progress
  const phaseKey = PHASE_KEYS[progress.phase] ?? 'fact.phase.planning'
  // "已检索" only means something once searching has started; a non-zero count
  // is kept visible even if a stale phase still says planning.
  const showSearched =
    progress.phase === 'searching' ||
    progress.phase === 'verifying' ||
    progress.phase === 'done' ||
    searched > 0

  if (total === 0) {
    return (
      <section
        className="lgp-fact-plan"
        data-lgp-part="fact-progress"
        data-lgp-fact-plan-phase={progress.phase}
        aria-label={t('fact.plan.title')}
      >
        <h4 className="lgp-fact-plan-title">{t('fact.plan.title')}</h4>
        <p className="lgp-fact-plan-empty" data-lgp-fact-plan-empty="true">
          {t('fact.plan.empty')}
        </p>
      </section>
    )
  }

  return (
    <section
      className="lgp-fact-plan"
      data-lgp-part="fact-progress"
      data-lgp-fact-plan-phase={progress.phase}
      data-lgp-fact-plan-total={total}
      aria-label={t('fact.plan.title')}
    >
      <h4 className="lgp-fact-plan-title">{t('fact.plan.title')}</h4>
      <p
        className="lgp-fact-plan-summary"
        role="status"
        aria-live="polite"
        data-lgp-fact-plan-summary="true"
      >
        {t('fact.plan.needed', { total })}
        <span aria-hidden="true"> · </span>
        {t('fact.plan.checked', { checked })}
        {notChecked > 0 ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('fact.plan.notChecked', { notChecked })}
          </>
        ) : null}
      </p>
      <p className="lgp-fact-plan-meta">
        <span className="lgp-fact-plan-phase">
          {t('fact.plan.phase', { phase: t(phaseKey) })}
        </span>
        {showSearched ? (
          <>
            <span aria-hidden="true"> · </span>
            <span className="lgp-fact-plan-searched">
              {t('fact.plan.searched', { searched })}
            </span>
          </>
        ) : null}
      </p>
      {items.length === 0 ? null : (
        <ol className="lgp-fact-plan-list" aria-label={t('fact.plan.listLabel')}>
          {items.map((item) => (
            <li
              key={item.id}
              className={`lgp-fact-plan-item lgp-fact-plan-item--${item.status}`}
              data-lgp-fact-plan-id={item.id}
              data-lgp-fact-plan-status={item.status}
              data-lgp-fact-plan-priority={item.priority}
            >
              <span className="lgp-fact-plan-priority">
                {t('fact.priority', { priority: item.priority })}
              </span>
              <span className="lgp-fact-plan-kind">
                {t(FACT_KIND_KEYS[item.kind] ?? 'report.kind.other')}
              </span>
              <span className="lgp-fact-plan-claim">{item.claim}</span>
              <span
                className={`lgp-fact-plan-status lgp-fact-plan-status--${item.status}`}
              >
                {t(ITEM_STATUS_KEYS[item.status] ?? 'fact.status.pending')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

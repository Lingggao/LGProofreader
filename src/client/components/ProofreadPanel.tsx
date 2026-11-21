/**
 * Proofreading start panel (Task 19; design §7.2/§7.5/§9.2/§9.4/§11.2).
 *
 * The panel is the **only** place a proofreading job can be started, and it
 * never starts one by itself: the button is disabled until the user explicitly
 * selected at least one article, and two cases require a second, explicit
 * confirmation (design §9.4/§11.2):
 *
 * - a whole-page selection (`selectedCount === articleCount`), because the
 *   estimate can be large; the confirmation shows the article count and the
 *   model-call estimate;
 * - `factCheck: false`, because the report will be marked 未联网核查; the
 *   confirmation spells out that the report contains no network verification.
 *
 * The call estimate is `selectedCount × roleCount` (design §7.5); role counts
 * mirror the Host depth presets — since v1.0.0 every preset also runs the
 * independent `nouns` role, and the consolidator adds one more per article:
 * `quick` 4 workers + consolidator = 5, `standard` 7 + 1 = 8, `deep` 8 + 1 = 9.
 * The component is presentational: `App` owns the depth/factCheck state and the
 * actual proofread API call.
 *
 * Task 21f: the panel also surfaces the failed roles of the latest report, so a
 * run whose result is partial (e.g. provider refusal on `facts`) is visible next
 * to the start/retry controls — the detailed list lives in `ReportView`.
 */
import { useEffect, useState } from 'react'
import { defaultTranslate, type Translate } from '../locale'
import type { JobView } from '../../shared/api/protocol'
import type { Depth, ReportRoleFailure } from '../../shared/types'
import {
  failedRoleErrorLabel,
  proofreadRoleLabel,
} from './FailedRolesNotice'
import { JobProgress } from './JobProgress'

/**
 * Role count of every depth preset, including the consolidator (design §7.2).
 *
 * v1.0.0: the independent `nouns` role runs at every depth next to `facts`, so
 * every preset gained one worker role (quick 5, standard 8, deep 9 in total).
 */
export const PROOFREAD_ROLE_COUNTS: Readonly<Record<Depth, number>> = Object.freeze({
  quick: 5,
  standard: 8,
  deep: 9,
})

/** Roles of the depth presets, for the hint under the depth control. */
const DEPTH_ORDER: readonly Depth[] = ['quick', 'standard', 'deep']

/** Estimated model calls of a run (`articles × roles`, design §7.5). */
export function estimateProofreadCalls(articleCount: number, depth: Depth): number {
  const articles = Number.isFinite(articleCount) ? Math.max(0, Math.floor(articleCount)) : 0
  return articles * (PROOFREAD_ROLE_COUNTS[depth] ?? PROOFREAD_ROLE_COUNTS.standard)
}

/** A job is still running while it is queued or executing. */
export function isActiveJob(job: JobView | undefined): boolean {
  return job !== undefined && (job.status === 'queued' || job.status === 'running')
}

/** Props of {@link ProofreadPanel}. */
export interface ProofreadPanelProps {
  /** Number of explicitly selected articles (0 → start disabled). */
  selectedCount: number
  /** Whole-page article count; enables the whole-page confirmation. */
  articleCount?: number
  /** Selected proofreading depth. */
  depth: Depth
  /** Network fact-checking toggle (the facts role itself always runs). */
  factCheck: boolean
  /** Start button disabled (analysis running, transfer busy, …). */
  disabled?: boolean
  /** Changes the depth preset. */
  onDepthChange: (depth: Depth) => void
  /** Toggles network fact-checking. */
  onFactCheckChange: (factCheck: boolean) => void
  /** Starts the proofread job — only ever called from an explicit user action. */
  onStart: () => void
  /** Latest proofread job snapshot, when one exists. */
  job?: JobView
  /** Cancels the running job. */
  onCancel: () => void
  /** A cancelled/failed notice shown above the controls. */
  notice?: string
  /** A start/proofread failure shown above the controls. */
  error?: string
  /** Retries the last proofread with the same document/selection/options. */
  onRetry?: () => void
  /**
   * Failed roles of the latest report (`Report.failedRoles`). A finished job can
   * contain failed roles while still producing a partial report; surfacing them
   * here (above the controls) means a re-run is offered knowingly (Task 21f).
   */
  failedRoles?: readonly ReportRoleFailure[]
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the depth/fact-check controls, call estimate and start action. */
export function ProofreadPanel({
  selectedCount,
  articleCount,
  depth,
  factCheck,
  disabled = false,
  onDepthChange,
  onFactCheckChange,
  onStart,
  job,
  onCancel,
  notice,
  error,
  onRetry,
  failedRoles,
  t = defaultTranslate,
}: ProofreadPanelProps) {
  const [confirming, setConfirming] = useState(false)
  const active = isActiveJob(job)
  const failures: readonly ReportRoleFailure[] = Array.isArray(failedRoles) ? failedRoles : []
  const wholePage =
    typeof articleCount === 'number' && articleCount > 0 && selectedCount === articleCount
  const offline = factCheck === false
  const calls = estimateProofreadCalls(selectedCount, depth)
  const roles = PROOFREAD_ROLE_COUNTS[depth] ?? PROOFREAD_ROLE_COUNTS.standard
  const needsConfirmation = selectedCount > 0 && (wholePage || offline)
  const startDisabled = selectedCount === 0 || active || disabled

  // A new selection/option invalidates an open confirmation instead of letting
  // a stale "confirm" start a different run than the one it described.
  useEffect(() => {
    setConfirming(false)
  }, [selectedCount, articleCount, depth, factCheck])

  const handleStart = (): void => {
    if (startDisabled) return
    if (needsConfirmation && !confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    onStart()
  }

  const confirmationText = (): string => {
    if (wholePage && offline) {
      return t('proof.confirmWholePageOffline', { articles: articleCount ?? 0, calls })
    }
    if (wholePage) return t('proof.confirmWholePage', { articles: articleCount ?? 0, calls })
    return t('proof.confirmOffline')
  }

  return (
    <section
      className="lgp-proof-panel"
      data-lgp-part="proofread-panel"
      aria-label={t('proof.title')}
    >
      <header className="lgp-proof-head">
        <h2 className="lgp-proof-title">{t('proof.title')}</h2>
        <span className="lgp-proof-selected">
          {selectedCount === 0
            ? t('proof.noSelection')
            : t('proof.selected', { count: selectedCount })}
        </span>
      </header>

      {typeof notice === 'string' && notice !== '' ? (
        <p className="lgp-proof-notice" role="status" data-lgp-proof-notice="true">
          {notice}
        </p>
      ) : null}
      {typeof error === 'string' && error !== '' ? (
        <div className="lgp-proof-error-block">
          <p className="lgp-proof-error" role="alert" data-lgp-proof-error="true">
            {error}
          </p>
          {onRetry === undefined ? null : (
            <button
              type="button"
              className="lgp-button"
              onClick={onRetry}
              disabled={active || disabled}
            >
              {t('proof.retry')}
            </button>
          )}
        </div>
      ) : null}

      {failures.length === 0 ? null : (
        <p
          className="lgp-proof-warning lgp-proof-failed-roles"
          role="alert"
          data-lgp-proof-failed-roles="true"
          data-lgp-proof-failed-role-count={failures.length}
        >
          <span className="lgp-proof-failed-roles-title">
            {t('proof.failedRoles', { count: failures.length })}
          </span>
          {'：'}
          {failures.map((failure, index) => (
            <span
              key={`${index}-${failure.articleId}-${failure.role}`}
              className="lgp-proof-failed-role"
              data-lgp-proof-failed-role={failure.role}
            >
              {index > 0 ? '；' : null}
              {failure.articleId}
              {' · '}
              {proofreadRoleLabel(failure.role, t)}
              {'：'}
              {failedRoleErrorLabel(failure, t)}
            </span>
          ))}
          {'。'}
          {t('proof.failedRolesDetail')}
        </p>
      )}

      {active && job !== undefined ? <JobProgress job={job} t={t} /> : null}

      <fieldset className="lgp-proof-fieldset" disabled={active || disabled}>
        <legend className="lgp-proof-legend">{t('proof.depth')}</legend>
        <div className="lgp-proof-depths">
          {DEPTH_ORDER.map((option) => (
            <label key={option} className="lgp-proof-depth">
              <input
                type="radio"
                name="lgp-proof-depth"
                value={option}
                checked={depth === option}
                aria-label={t(`proof.depth.${option}`)}
                onChange={() => onDepthChange(option)}
              />
              <span>{t(`proof.depth.${option}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="lgp-proof-hint">
        {t('proof.roles', { count: roles })} · {t('proof.estimate', { calls })}
      </p>

      <button
        type="button"
        className="lgp-proof-check"
        role="switch"
        aria-checked={factCheck}
        aria-label={t('proof.factCheck')}
        disabled={active || disabled}
        onClick={() => onFactCheckChange(!factCheck)}
      >
        <span className="lgp-proof-check-mark" aria-hidden="true">
          {factCheck ? '✓' : '—'}
        </span>
        <span>{t('proof.factCheck')}</span>
      </button>
      {offline ? (
        <p className="lgp-proof-warning" data-lgp-proof-offline="true">
          {t('proof.factCheckOffWarning')}
        </p>
      ) : null}

      {selectedCount === 0 ? (
        <p className="lgp-proof-hint">{t('proof.noSelectionHint')}</p>
      ) : null}

      <div className="lgp-proof-actions">
        <button
          type="button"
          className="lgp-button lgp-button--primary"
          onClick={handleStart}
          disabled={startDisabled}
        >
          {t('proof.start')}
        </button>
        {active ? (
          <button type="button" className="lgp-button" onClick={onCancel}>
            {t('proof.cancel')}
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div className="lgp-proof-confirm" data-lgp-proof-confirm="true" role="group">
          <p className="lgp-proof-confirm-text">{confirmationText()}</p>
          <div className="lgp-proof-actions">
            <button
              type="button"
              className="lgp-button lgp-button--primary"
              onClick={handleStart}
            >
              {t('proof.confirmStart')}
            </button>
            <button
              type="button"
              className="lgp-button"
              onClick={() => setConfirming(false)}
            >
              {t('proof.confirmCancel')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

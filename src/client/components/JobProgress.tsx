/**
 * Proofreading job progress (Task 19; design §9.3).
 *
 * Presentational: renders the durable `JobView` the panel polls from
 * `GET /job` — one row per stage (`pending/running/done/failed`), the overall
 * status and an accessible progress bar. The cancel action belongs to
 * `ProofreadPanel` (it owns the API seam), so this component stays read-only and
 * can be unit-tested with a plain job fixture.
 *
 * A failed stage keeps its error text visible (the design requires a single role
 * failure to be surfaced without hiding the rest of the job), and the current
 * stage list is announced as a status region.
 *
 * Task 29: while the `facts` role runs, the Host additionally emits the live
 * exhaustive fact-check plan as `job.factProgress`; it is rendered by the
 * `FactProgress` child (ordered claims, counts and phase) right in this panel.
 */
import { defaultTranslate, type Translate } from '../locale'
import type { JobView } from '../../shared/api/protocol'
import type { StageState } from '../../shared/types'
import { FactProgress } from './FactProgress'

/** Localized keys of the job statuses. */
const JOB_STATUS_KEYS: Record<JobView['status'], string> = {
  queued: 'job.status.queued',
  running: 'job.status.running',
  done: 'job.status.done',
  failed: 'job.status.failed',
  cancelled: 'job.status.cancelled',
}

/** Localized keys of the stage statuses. */
const STAGE_STATUS_KEYS: Record<StageState['status'], string> = {
  pending: 'job.stage.pending',
  running: 'job.stage.running',
  done: 'job.stage.done',
  failed: 'job.stage.failed',
}

/** Props of {@link JobProgress}. */
export interface JobProgressProps {
  /** The latest job snapshot polled from the Host. */
  job: JobView
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Clamp a `JobView.progress` value to a 0–100 integer. */
export function progressPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.min(1, Math.max(0, progress)) * 100)
}

/** Render the proofreading job status, stages and progress bar. */
export function JobProgress({ job, t = defaultTranslate }: JobProgressProps) {
  const percent = progressPercent(job.progress)
  const stages = Array.isArray(job.stages) ? job.stages : []
  const completed = stages.filter(
    (stage) => stage.status === 'done' || stage.status === 'failed',
  ).length

  return (
    <section
      className="lgp-job"
      data-lgp-part="job-progress"
      data-lgp-job-id={job.id}
      data-lgp-job-status={job.status}
      data-lgp-job-progress={percent}
      aria-label={t('job.title')}
    >
      <header className="lgp-job-head">
        <h3 className="lgp-job-title">{t('job.title')}</h3>
        <span className="lgp-job-status" data-lgp-job-status-label="true">
          {t(JOB_STATUS_KEYS[job.status] ?? 'job.status.running')}
        </span>
      </header>
      <progress
        className="lgp-job-bar"
        max={100}
        value={percent}
        aria-label={t('a11y.proofProgress')}
      />
      <p className="lgp-job-summary" role="status" aria-live="polite">
        {t('job.progress', { percent })}
        <span aria-hidden="true"> · </span>
        {t('job.stageCount', { done: completed, total: stages.length })}
      </p>
      {typeof job.error === 'string' && job.error !== '' ? (
        <p className="lgp-job-error" role="alert">
          {job.error}
        </p>
      ) : null}
      {job.factProgress === undefined ? null : (
        <FactProgress progress={job.factProgress} t={t} />
      )}
      {stages.length === 0 ? null : (
        <ol className="lgp-job-stages">
          {stages.map((stage) => (
            <li
              key={stage.id}
              className={`lgp-job-stage lgp-job-stage--${stage.status}`}
              data-lgp-stage-id={stage.id}
              data-lgp-stage-status={stage.status}
            >
              <span className="lgp-job-stage-label">{stage.label}</span>
              <span className={`lgp-job-stage-status lgp-job-stage-status--${stage.status}`}>
                {t(STAGE_STATUS_KEYS[stage.status] ?? 'job.stage.pending')}
              </span>
              {typeof stage.error === 'string' && stage.error !== '' ? (
                <span className="lgp-job-stage-error">{stage.error}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

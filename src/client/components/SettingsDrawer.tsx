/**
 * Settings drawer (Task 19; design §11.2).
 *
 * Only settings with a runtime effect are exposed: the provider/model pair from
 * the `/meta` catalogue, the default depth, network fact-checking, worker
 * concurrency and the per-call timeout. The fact-budget fields
 * (`maxClaimsPerArticle`, `maxSearchQueriesPerArticle`, `searchResultsPerClaim`,
 * `fetchPagesPerClaim`) and `includeHeaderFooter` are deliberately **not**
 * rendered: the Host does not read them at job time yet, so exposing them would
 * be a dead control. `reasoningEffort` is intentionally omitted for the same
 * reason (the Host resolves it once at activation, not per run).
 *
 * Saving goes through `POST /settings`; the Host persists the patch to
 * `settings.json` and applies the model/concurrency/timeout values on the next
 * plugin activation (the drawer says so). Batch-threshold changes therefore never
 * lie about being effective immediately.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { defaultTranslate, type Translate } from '../locale'
import type {
  ModelCatalogue,
  SettingsPatch,
  SettingsView,
} from '../../shared/api/protocol'
import type { Depth } from '../../shared/types'

/** The runtime-effective settings the drawer edits. */
export interface EffectiveSettings {
  provider: string
  model: string
  depth: Depth
  factCheck: boolean
  maxConcurrentWorkers: number
  perCallTimeoutMs: number
}

/** Project a `SettingsView` onto the runtime-effective subset. */
export function effectiveSettings(settings: SettingsView): EffectiveSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    depth: settings.depth,
    factCheck: settings.factCheck,
    maxConcurrentWorkers: settings.maxConcurrentWorkers,
    perCallTimeoutMs: settings.perCallTimeoutMs,
  }
}

/** Build the `POST /settings` patch from the effective draft (never dead fields). */
export function toSettingsPatch(draft: EffectiveSettings): SettingsPatch {
  return {
    provider: draft.provider,
    model: draft.model,
    depth: draft.depth,
    factCheck: draft.factCheck,
    maxConcurrentWorkers: draft.maxConcurrentWorkers,
    perCallTimeoutMs: draft.perCallTimeoutMs,
  }
}

/** Localized depth labels. */
const DEPTHS: readonly Depth[] = ['quick', 'standard', 'deep']

/** Props of {@link SettingsDrawer}. */
export interface SettingsDrawerProps {
  /** Loaded settings; `null` while the drawer is still loading. */
  settings: SettingsView | null
  /** Provider/model catalogue from `GET /meta` (may be empty). */
  catalogue: ModelCatalogue | null
  /** True while `/meta` + `/settings` are loading. */
  loading?: boolean
  /** Load error (the drawer offers a retry). */
  loadError?: string | null
  /** Retries the `/meta` + `/settings` load. */
  onRetry?: () => void
  /** Persists the effective settings patch. */
  onSave: (patch: SettingsPatch) => Promise<void> | void
  /** Closes the drawer. */
  onClose: () => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the settings drawer. */
export function SettingsDrawer({
  settings,
  catalogue,
  loading = false,
  loadError = null,
  onRetry,
  onSave,
  onClose,
  t = defaultTranslate,
}: SettingsDrawerProps) {
  const headingId = useId()
  const backRef = useRef<HTMLButtonElement | null>(null)
  const [draft, setDraft] = useState<EffectiveSettings | null>(() =>
    settings === null ? null : effectiveSettings(settings),
  )
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')

  // Loaded settings replace the draft (also after a successful save).
  useEffect(() => {
    if (settings !== null) setDraft(effectiveSettings(settings))
  }, [settings])

  // Opening the drawer puts focus on the prominent 返回 control (Task 24), so a
  // keyboard/screen-reader user lands on the way back instead of the page body.
  useEffect(() => {
    backRef.current?.focus()
  }, [])

  // Escape closes the drawer (keyboard alternative to the close button).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const providers = (catalogue ?? []).filter((provider) => typeof provider.id === 'string')
  const currentProvider = draft?.provider ?? ''
  const providerOptions =
    currentProvider !== '' && !providers.some((provider) => provider.id === currentProvider)
      ? [{ id: currentProvider, title: currentProvider, models: [] }, ...providers]
      : providers
  const selectedProvider = providerOptions.find((provider) => provider.id === currentProvider)
  const models = selectedProvider?.models ?? []
  const modelOptions =
    draft !== null && draft.model !== '' && !models.some((model) => model.id === draft.model)
      ? [{ id: draft.model, name: draft.model }, ...models]
      : models

  const concurrency = draft?.maxConcurrentWorkers ?? 4
  const timeoutSeconds =
    draft === null ? 300 : Math.round((draft.perCallTimeoutMs / 1000) * 10) / 10
  const invalid =
    draft === null ||
    !Number.isInteger(concurrency) ||
    concurrency < 2 ||
    concurrency > 8 ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 1800

  const update = (patch: Partial<EffectiveSettings>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }))
    setSaveState('idle')
  }

  const handleProviderChange = (providerId: string): void => {
    const provider = providerOptions.find((entry) => entry.id === providerId)
    const firstModel = provider?.models[0]?.id ?? ''
    update({ provider: providerId, model: firstModel })
  }

  const handleSave = async (): Promise<void> => {
    if (draft === null || invalid) return
    setSaveState('saving')
    setSaveError('')
    try {
      await onSave(toSettingsPatch({ ...draft, perCallTimeoutMs: Math.round(timeoutSeconds * 1000) }))
      setSaveState('saved')
    } catch (error) {
      setSaveState('error')
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <aside
      className="lgp-settings"
      data-lgp-part="settings-drawer"
      role="dialog"
      aria-labelledby={headingId}
      aria-modal="true"
    >
      <header className="lgp-settings-head">
        {/* Task 24: an obvious way back. Not a tiny ghost button hidden under
            the page header — this is the first, focused control of the drawer. */}
        <button
          ref={backRef}
          type="button"
          className="lgp-button lgp-settings-back"
          onClick={onClose}
        >
          {t('settings.back')}
        </button>
        <h2 className="lgp-settings-title" id={headingId}>
          {t('settings.title')}
        </h2>
        <button
          type="button"
          className="lgp-button lgp-button--ghost lgp-settings-close"
          aria-label={t('settings.close')}
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
          <span className="lgp-settings-close-label">{t('settings.closeShort')}</span>
        </button>
      </header>

      {draft === null ? (
        <div className="lgp-settings-loading">
          {loading ? (
            <p role="status">{t('settings.loading')}</p>
          ) : (
            <>
              <p className="lgp-inline-error" role="alert">
                {t('settings.loadFailed', { message: loadError ?? '' })}
              </p>
              {onRetry === undefined ? null : (
                <button type="button" className="lgp-button" onClick={onRetry}>
                  {t('error.retry')}
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="lgp-settings-body">
          <label className="lgp-settings-field">
            <span className="lgp-settings-label">{t('settings.provider')}</span>
            <select
              className="lgp-report-select"
              aria-label={t('settings.provider')}
              value={draft.provider}
              onChange={(event) => handleProviderChange(event.currentTarget.value)}
            >
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {typeof provider.title === 'string' && provider.title !== ''
                    ? provider.title
                    : provider.id}
                </option>
              ))}
            </select>
          </label>

          <label className="lgp-settings-field">
            <span className="lgp-settings-label">{t('settings.model')}</span>
            <select
              className="lgp-report-select"
              aria-label={t('settings.model')}
              value={draft.model}
              onChange={(event) => update({ model: event.currentTarget.value })}
            >
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {typeof model.name === 'string' && model.name !== '' ? model.name : model.id}
                </option>
              ))}
            </select>
          </label>
          {catalogue === null || providers.length === 0 ? (
            <p className="lgp-settings-note">{t('settings.noCatalogue')}</p>
          ) : null}

          <label className="lgp-settings-field">
            <span className="lgp-settings-label">{t('settings.depth')}</span>
            <select
              className="lgp-report-select"
              aria-label={t('settings.depth')}
              value={draft.depth}
              onChange={(event) => update({ depth: event.currentTarget.value as Depth })}
            >
              {DEPTHS.map((depth) => (
                <option key={depth} value={depth}>
                  {t(`proof.depth.${depth}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="lgp-settings-field">
            <span className="lgp-settings-label">{t('settings.concurrency')}</span>
            <input
              className="lgp-input lgp-settings-number"
              type="number"
              min={2}
              max={8}
              step={1}
              aria-label={t('settings.concurrency')}
              value={concurrency}
              onChange={(event) =>
                update({ maxConcurrentWorkers: Number(event.currentTarget.value) })
              }
            />
          </label>

          <label className="lgp-settings-field">
            <span className="lgp-settings-label">{t('settings.timeout')}</span>
            <input
              className="lgp-input lgp-settings-number"
              type="number"
              min={1}
              max={1800}
              step={1}
              aria-label={t('settings.timeout')}
              value={timeoutSeconds}
              onChange={(event) => {
                const seconds = Number(event.currentTarget.value)
                update({
                  perCallTimeoutMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
                })
              }}
            />
          </label>

          <label className="lgp-settings-check">
            <input
              type="checkbox"
              checked={draft.factCheck}
              aria-label={t('settings.factCheck')}
              onChange={(event) => update({ factCheck: event.currentTarget.checked })}
            />
            <span>{t('settings.factCheck')}</span>
          </label>
          <p className="lgp-settings-note">{t('settings.restartNote')}</p>

          <div className="lgp-settings-actions">
            <button
              type="button"
              className="lgp-button lgp-button--primary"
              onClick={() => void handleSave()}
              disabled={invalid || saveState === 'saving'}
            >
              {saveState === 'saving' ? t('settings.saving') : t('settings.save')}
            </button>
            <span className="lgp-settings-status" role="status" aria-live="polite">
              {saveState === 'saved' ? t('settings.saved') : ''}
            </span>
          </div>
          {saveState === 'error' ? (
            <p className="lgp-inline-error" role="alert">
              {t('settings.saveFailed', { message: saveError })}
            </p>
          ) : null}
        </div>
      )}
    </aside>
  )
}

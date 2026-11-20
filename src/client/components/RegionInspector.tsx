/**
 * Region inspector of the workbench aside (Task 18; design §6.5/§9.4).
 *
 * The inspector is the precise, non-drag editing surface for the selected
 * region: numeric x/y/w/h, kind (label) change, reading-order up/down,
 * merge with the next region in reading order, straight-cut split and delete.
 *
 * Split contract (Task 3 + the Task 18 SDD contract):
 * - the split box produced here always spans the region's **full width**
 *   (horizontal cut → top/bottom parts) or **full height** (vertical cut →
 *   left/right parts), so it is always a straight cut;
 * - `App` page-clamps the region (`resizeRegion`) and calls
 *   `splitRegion(region, splitBBox, lines)` with the document's line list, so
 *   line ids are partitioned by line centre instead of all landing in one part;
 * - `onChange` only reports intent: `App` applies (`resizeRegion`) and clamps it.
 *
 * Every control has a visible label and an accessible name; the numeric inputs
 * are the required alternative to dragging/resizing on the canvas.
 */
import { useEffect, useState, type ChangeEvent } from 'react'
import { defaultTranslate, type Translate } from '../locale'
import { normalizeBBox } from '../../shared/geometry/bbox'
import { confidencePercent, isLowConfidence, regionKindLabel } from './RegionOverlay'
import type { RegionWarningFlags } from '../layout/ops'
import type { Article, BBox, Region } from '../../shared/types'

/** Every region kind, in the order shown by the kind select. */
export const REGION_KINDS: readonly Region['kind'][] = [
  'masthead',
  'header',
  'footer',
  'lead',
  'second',
  'third',
  'article',
  'image',
  'caption',
  'ad',
  'index',
  'other',
]

/** Split axis: a horizontal cut yields top/bottom parts, vertical yields left/right. */
export type SplitAxis = 'horizontal' | 'vertical'

/** Smallest/largest split ratio (the first part never covers the whole region). */
export const SPLIT_RATIO_MIN = 0.1
export const SPLIT_RATIO_MAX = 0.9
/** Default split ratio (two equal parts). */
export const DEFAULT_SPLIT_RATIO = 0.5

/** Clamp a split ratio into `[SPLIT_RATIO_MIN, SPLIT_RATIO_MAX]`. */
export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio))
}

/**
 * First part of a straight split, in page coordinates.
 *
 * A horizontal cut spans the region's full width (`w` unchanged) and takes
 * `h × ratio` at the top; a vertical cut spans the full height (`h` unchanged)
 * and takes `w × ratio` at the left. The second part is derived by
 * `splitRegion` from the region box, so no non-straight shape can be produced.
 */
export function straightSplitBBox(region: Region, axis: SplitAxis, ratio: number): BBox {
  const box = normalizeBBox(region.bbox)
  const clamped = clampSplitRatio(ratio)
  if (axis === 'horizontal') {
    return { x: box.x, y: box.y, w: box.w, h: box.h * clamped }
  }
  return { x: box.x, y: box.y, w: box.w * clamped, h: box.h }
}

/**
 * True when `splitBBox` spans the region's full width or full height (i.e. it is
 * a straight cut). `App` refuses any other split box as a defensive guard.
 */
export function isStraightCut(region: Region, splitBBox: BBox): boolean {
  const source = normalizeBBox(region.bbox)
  const taken = normalizeBBox(splitBBox)
  const epsilon = 1e-6
  const spansWidth =
    Math.abs(taken.x - source.x) <= epsilon && Math.abs(taken.w - source.w) <= epsilon
  const spansHeight =
    Math.abs(taken.y - source.y) <= epsilon && Math.abs(taken.h - source.h) <= epsilon
  return spansWidth || spansHeight
}

/** A pending region change reported by {@link RegionInspector}. */
export interface RegionChange {
  /** New region kind (label). */
  kind?: Region['kind']
  /** Partial box edit; `App` merges it into the box and clamps to the page. */
  bbox?: Partial<BBox>
}

/** Props of {@link RegionInspector}. */
export interface RegionInspectorProps {
  /** The selected region. */
  region: Region
  /** Reports a kind / coordinate edit. */
  onChange: (change: RegionChange) => void
  /** Merges the selected region with the next one in reading order. */
  onMerge: () => void
  /** Splits along the reported straight-cut box (first part). */
  onSplit: (splitBBox: BBox) => void
  /** Deletes the selected region. */
  onDelete: () => void
  /** Moves the region one slot earlier/later in reading order. */
  onReorder?: (direction: 'up' | 'down') => void
  /** Articles selectable as the region's owner (assignment UI). */
  articles?: readonly Article[]
  /** Assigns the region to an article (`null` = unassigned). */
  onAssignArticle?: (articleId: string | null) => void
  /** Recomputed warnings for the selected region (shown as a list). */
  warnings?: RegionWarningFlags
  /** False when there is no next region to merge with. */
  canMerge?: boolean
  /** False when the region is already first/last in reading order. */
  canReorderUp?: boolean
  canReorderDown?: boolean
  /** Closes the inspector (clears the canvas selection) without changing the region. */
  onClose?: () => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

type BoxField = 'x' | 'y' | 'w' | 'h'

const BOX_FIELDS: readonly BoxField[] = ['x', 'y', 'w', 'h']
const BOX_FIELD_KEYS: Record<BoxField, string> = {
  x: 'inspector.x',
  y: 'inspector.y',
  w: 'inspector.width',
  h: 'inspector.height',
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 100) / 100)
}

function draftFromRegion(region: Region): Record<BoxField, string> {
  return {
    x: formatNumber(region.bbox.x),
    y: formatNumber(region.bbox.y),
    w: formatNumber(region.bbox.w),
    h: formatNumber(region.bbox.h),
  }
}

/** Render the selected region's precise editor. */
export function RegionInspector({
  region,
  onChange,
  onMerge,
  onSplit,
  onDelete,
  onReorder,
  articles = [],
  onAssignArticle,
  warnings,
  canMerge = true,
  canReorderUp = true,
  canReorderDown = true,
  onClose,
  t = defaultTranslate,
}: RegionInspectorProps) {
  const [draft, setDraft] = useState<Record<BoxField, string>>(() => draftFromRegion(region))
  const [splitAxis, setSplitAxis] = useState<SplitAxis>('horizontal')
  const [splitRatio, setSplitRatio] = useState(String(DEFAULT_SPLIT_RATIO))

  // Re-sync the drafts when the app clamps/updates the selected region (e.g. a
  // numeric edit clamps at the page edge or a keyboard move changes x).
  useEffect(() => {
    setDraft(draftFromRegion(region))
  }, [region.id, region.bbox.x, region.bbox.y, region.bbox.w, region.bbox.h])

  const handleBoxChange =
    (field: BoxField) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const raw = event.currentTarget.value
      setDraft((previous) => ({ ...previous, [field]: raw }))
      if (raw.trim() === '') return
      const value = Number(raw)
      if (!Number.isFinite(value)) return
      onChange({ bbox: { [field]: value } })
    }

  const handleSplit = (): void => {
    onSplit(straightSplitBBox(region, splitAxis, Number(splitRatio)))
  }

  const kindLabel = regionKindLabel(region.kind, t)
  const percent = confidencePercent(region.confidence)
  const low = isLowConfidence(region)
  const fieldId = (field: BoxField): string => `lgp-inspector-${region.id}-${field}`

  return (
    <section
      className="lgp-inspector"
      data-lgp-part="region-inspector"
      data-lgp-inspector-region={region.id}
      aria-label={t('inspector.title')}
    >
      <header className="lgp-inspector-head">
        <h2 className="lgp-inspector-title">{t('inspector.title')}</h2>
        <span className="lgp-inspector-meta">
          {kindLabel} · {t('inspector.order', { order: region.order + 1 })}
        </span>
        {onClose === undefined ? null : (
          <button
            type="button"
            className="lgp-button lgp-button--ghost lgp-inspector-close"
            data-lgp-inspector-close="true"
            aria-label={t('inspector.close')}
            title={t('inspector.close')}
            onClick={onClose}
          >
            × 关闭
          </button>
        )}
      </header>

      <div className="lgp-inspector-grid">
        {BOX_FIELDS.map((field) => (
          <label key={field} className="lgp-inspector-field" htmlFor={fieldId(field)}>
            <span className="lgp-inspector-label">{t(BOX_FIELD_KEYS[field])}</span>
            <input
              id={fieldId(field)}
              className="lgp-input lgp-inspector-number"
              type="number"
              inputMode="decimal"
              step="1"
              aria-label={t(BOX_FIELD_KEYS[field])}
              value={draft[field]}
              onChange={handleBoxChange(field)}
            />
          </label>
        ))}
      </div>

      <label className="lgp-inspector-field" htmlFor={`${fieldId('x')}-kind`}>
        <span className="lgp-inspector-label">{t('inspector.kind')}</span>
        <select
          id={`${fieldId('x')}-kind`}
          className="lgp-input lgp-inspector-select"
          aria-label={t('inspector.kind')}
          value={region.kind}
          onChange={(event) =>
            onChange({ kind: event.currentTarget.value as Region['kind'] })
          }
        >
          {REGION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {regionKindLabel(kind, t)}
            </option>
          ))}
        </select>
      </label>

      <label className="lgp-inspector-field" htmlFor={`${fieldId('x')}-article`}>
        <span className="lgp-inspector-label">{t('inspector.assign')}</span>
        <select
          id={`${fieldId('x')}-article`}
          className="lgp-input lgp-inspector-select"
          aria-label={t('inspector.assign')}
          value={region.articleId ?? ''}
          disabled={onAssignArticle === undefined}
          onChange={(event) =>
            onAssignArticle?.(event.currentTarget.value === '' ? null : event.currentTarget.value)
          }
        >
          <option value="">{t('inspector.assignNone')}</option>
          {articles.map((article) => {
            const title =
              typeof article.title === 'string' && article.title !== ''
                ? article.title
                : t('article.untitled')
            return (
              <option key={article.id} value={article.id}>
                {`${t(`article.role.${article.role}`)} ${title}`}
              </option>
            )
          })}
        </select>
      </label>

      <p className="lgp-inspector-confidence">
        {t('canvas.confidence', { percent })}
        {low ? (
          <span className="lgp-inspector-warning" role="img" aria-label={t('canvas.lowConfidence')}>
            !
          </span>
        ) : null}
      </p>

      {warnings !== undefined &&
      (warnings.overlapping || warnings.unassigned || warnings.outOfPage) ? (
        <ul
          className="lgp-inspector-warnings"
          data-lgp-inspector-warnings="true"
          data-lgp-inspector-overlap={warnings.overlapping ? 'true' : 'false'}
          data-lgp-inspector-unassigned={warnings.unassigned ? 'true' : 'false'}
          data-lgp-inspector-out-of-page={warnings.outOfPage ? 'true' : 'false'}
        >
          {warnings.unassigned ? <li>{t('warnings.region.unassigned')}</li> : null}
          {warnings.overlapping ? <li>{t('warnings.region.overlap')}</li> : null}
          {warnings.outOfPage ? <li>{t('warnings.region.outOfPage')}</li> : null}
        </ul>
      ) : null}

      <div className="lgp-inspector-row">
        <button
          type="button"
          className="lgp-button"
          onClick={() => onReorder?.('up')}
          disabled={onReorder === undefined || !canReorderUp}
        >
          {t('inspector.orderUp')}
        </button>
        <button
          type="button"
          className="lgp-button"
          onClick={() => onReorder?.('down')}
          disabled={onReorder === undefined || !canReorderDown}
        >
          {t('inspector.orderDown')}
        </button>
      </div>

      <div className="lgp-inspector-row">
        <button
          type="button"
          className="lgp-button"
          onClick={onMerge}
          disabled={!canMerge}
        >
          {t('inspector.merge')}
        </button>
        <button type="button" className="lgp-button" onClick={onDelete}>
          {t('inspector.delete')}
        </button>
      </div>

      <fieldset className="lgp-inspector-split">
        <legend className="lgp-inspector-split-legend">{t('inspector.split')}</legend>
        <div className="lgp-inspector-row">
          <label className="lgp-inspector-field" htmlFor={`${fieldId('x')}-axis`}>
            <span className="lgp-inspector-label">{t('inspector.splitAxis')}</span>
            <select
              id={`${fieldId('x')}-axis`}
              className="lgp-input lgp-inspector-select"
              aria-label={t('inspector.splitAxis')}
              value={splitAxis}
              onChange={(event) => setSplitAxis(event.currentTarget.value as SplitAxis)}
            >
              <option value="horizontal">{t('inspector.splitAxis.horizontal')}</option>
              <option value="vertical">{t('inspector.splitAxis.vertical')}</option>
            </select>
          </label>
          <label className="lgp-inspector-field" htmlFor={`${fieldId('x')}-ratio`}>
            <span className="lgp-inspector-label">{t('inspector.splitRatio')}</span>
            <input
              id={`${fieldId('x')}-ratio`}
              className="lgp-input lgp-inspector-number"
              type="number"
              inputMode="decimal"
              min={SPLIT_RATIO_MIN}
              max={SPLIT_RATIO_MAX}
              step="0.1"
              aria-label={t('inspector.splitRatio')}
              value={splitRatio}
              onChange={(event) => setSplitRatio(event.currentTarget.value)}
            />
          </label>
        </div>
        <button type="button" className="lgp-button" onClick={handleSplit}>
          {t('inspector.split')}
        </button>
      </fieldset>
    </section>
  )
}

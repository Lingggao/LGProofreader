/**
 * Region overlay of the page canvas (Task 18; design §6.5/§9.2/§9.4).
 *
 * Draws every layout region as an absolutely positioned box **inside** the page
 * container, so positions/sizes scale from page points to percent of the page
 * and therefore follow the current zoom automatically:
 *
 *   left = bbox.x / page.widthPt, width = bbox.w / page.widthPt, ...
 *
 * Accessibility: each box is a focusable `role="button"` with an accessible
 * label (kind + reading order). Arrow keys move the region by 1 pt
 * (Shift: 10 pt) through `onMoveRegion`; numeric inputs in `RegionInspector` are
 * the precise alternative to dragging. Resize handles are pointer-only targets
 * on the selected box; their accessible alternative is the inspector's numeric
 * width/height. Low-confidence regions use a dashed border plus a warning icon,
 * so kind/confidence never rely on colour alone; the numeric confidence is
 * intentionally **not** drawn inside the box (it crowded the preview and is
 * available in the inspector).
 *
 * This module never mutates its inputs and never computes the page clamp: the
 * `App` applies `moveRegion`/`resizeRegion` from `src/shared/layout/edit.ts`,
 * which is where the page-clamping contract lives.
 */
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { defaultTranslate, type Translate } from '../locale'
import { normalizeBBox } from '../../shared/geometry/bbox'
import { sortRegionsByOrder } from '../layout/ops'
import type { BBox, PageSize, Region } from '../../shared/types'

export { sortRegionsByOrder } from '../layout/ops'

/** Regions below this confidence are drawn dashed + with a warning icon. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5

/** Editable corners of a selected region. */
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

/** Pointer corner order (top-left, top-right, bottom-left, bottom-right). */
export const RESIZE_CORNERS: readonly ResizeCorner[] = ['nw', 'ne', 'sw', 'se']

/** Localized label of one region kind (`region.kind.<kind>`). */
export function regionKindLabel(kind: Region['kind'], t: Translate = defaultTranslate): string {
  return t(`region.kind.${kind}`)
}

function percentOf(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%'
  const ratio = Math.min(1, Math.max(0, value / total))
  // Four decimals keep the scale faithful without long floating-point strings.
  return `${Math.round(ratio * 1e6) / 1e4}%`
}

/**
 * Absolute-position style of a region box in percent of the page.
 *
 * The page container and the overlay share the same coordinate space, so zoom
 * never has to be part of the position (it only changes the container size).
 */
export function regionBoxStyle(bbox: BBox, page: PageSize): CSSProperties {
  const box = normalizeBBox(bbox)
  return {
    left: percentOf(box.x, page.widthPt),
    top: percentOf(box.y, page.heightPt),
    width: percentOf(box.w, page.widthPt),
    height: percentOf(box.h, page.heightPt),
  }
}

/** Confidence as a 0–100 integer for display. */
export function confidencePercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100)
}

/** True when the region is drawn dashed + with the warning icon. */
export function isLowConfidence(region: Region): boolean {
  return !(region.confidence >= LOW_CONFIDENCE_THRESHOLD)
}

/** True when no article owns the region (distinct dotted style + badge). */
export function isUnassignedRegion(region: Region): boolean {
  return region.articleId === undefined
}

/**
 * New absolute box when `corner` is dragged by `(dx, dy)` page points.
 *
 * The box is normalized, so dragging a handle past the opposite edge flips the
 * box instead of producing negative sizes; the caller still clamps it to the
 * page with `resizeRegion`.
 */
export function resizeBBox(base: BBox, corner: ResizeCorner, dx: number, dy: number): BBox {
  const box = normalizeBBox(base)
  let x = box.x
  let y = box.y
  let w = box.w
  let h = box.h
  if (corner === 'nw' || corner === 'sw') {
    x += dx
    w -= dx
  } else {
    w += dx
  }
  if (corner === 'nw' || corner === 'ne') {
    y += dy
    h -= dy
  } else {
    h += dy
  }
  return normalizeBBox({ x, y, w, h })
}

/* ------------------------------------------------------------------------- */
/* Props                                                                      */
/* ------------------------------------------------------------------------- */

/** Props of {@link RegionOverlay}. */
export interface RegionOverlayProps {
  /** Page size in PDF points (the coordinate space of every bbox). */
  page: PageSize
  /** Regions to draw; rendered in reading (`order`) order. */
  regions: readonly Region[]
  /** Currently selected region id (inspector target). */
  selectedRegionId: string | null
  /** Region ids of the explicitly selected articles; they get a highlight. */
  highlightedRegionIds?: readonly string[]
  /** Canvas zoom in pixels per page point (default 1). */
  scale?: number
  /** Selects a region (click / Enter / Space). */
  onSelectRegion: (regionId: string) => void
  /** Arrow-key move by `(dx, dy)` page points (App clamps with `moveRegion`). */
  onMoveRegion?: (regionId: string, dx: number, dy: number) => void
  /** Absolute resize target (App clamps with `resizeRegion`). */
  onResizeRegion?: (regionId: string, bbox: BBox) => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

type Interaction =
  | {
      kind: 'move'
      regionId: string
      lastX: number
      lastY: number
      scale: number
    }
  | {
      kind: 'resize'
      regionId: string
      corner: ResizeCorner
      startX: number
      startY: number
      baseBBox: BBox
      scale: number
    }

/* ------------------------------------------------------------------------- */
/* Component                                                                  */
/* ------------------------------------------------------------------------- */

/** Draw the scalable region boxes over the page image. */
export function RegionOverlay({
  page,
  regions,
  selectedRegionId,
  highlightedRegionIds = [],
  scale = 1,
  onSelectRegion,
  onMoveRegion,
  onResizeRegion,
  t = defaultTranslate,
}: RegionOverlayProps) {
  const interactionRef = useRef<Interaction | null>(null)
  const moveRef = useRef(onMoveRegion)
  const resizeRef = useRef(onResizeRegion)

  useEffect(() => {
    moveRef.current = onMoveRegion
    resizeRef.current = onResizeRegion
  }, [onMoveRegion, onResizeRegion])

  // One window listener pair for the lifetime of the overlay: pointer moves
  // outside the region/box (or even outside the canvas) still finish the drag.
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const interaction = interactionRef.current
      if (interaction === null) return
      const factor = interaction.scale > 0 ? interaction.scale : 1
      if (interaction.kind === 'move') {
        const dx = (event.clientX - interaction.lastX) / factor
        const dy = (event.clientY - interaction.lastY) / factor
        interaction.lastX = event.clientX
        interaction.lastY = event.clientY
        if (dx !== 0 || dy !== 0) moveRef.current?.(interaction.regionId, dx, dy)
        return
      }
      const dx = (event.clientX - interaction.startX) / factor
      const dy = (event.clientY - interaction.startY) / factor
      resizeRef.current?.(
        interaction.regionId,
        resizeBBox(interaction.baseBBox, interaction.corner, dx, dy),
      )
    }
    const handleMouseUp = (): void => {
      interactionRef.current = null
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const startMove = (event: ReactMouseEvent<HTMLDivElement>, region: Region): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    onSelectRegion(region.id)
    if (onMoveRegion === undefined) return
    interactionRef.current = {
      kind: 'move',
      regionId: region.id,
      lastX: event.clientX,
      lastY: event.clientY,
      scale,
    }
  }

  const startResize = (
    event: ReactMouseEvent<HTMLElement>,
    region: Region,
    corner: ResizeCorner,
  ): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    if (onResizeRegion === undefined) return
    interactionRef.current = {
      kind: 'resize',
      regionId: region.id,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      baseBBox: normalizeBBox(region.bbox),
      scale,
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, region: Region): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectRegion(region.id)
      return
    }
    const step = event.shiftKey ? 10 : 1
    let dx = 0
    let dy = 0
    switch (event.key) {
      case 'ArrowLeft':
        dx = -step
        break
      case 'ArrowRight':
        dx = step
        break
      case 'ArrowUp':
        dy = -step
        break
      case 'ArrowDown':
        dy = step
        break
      default:
        return
    }
    event.preventDefault()
    onMoveRegion?.(region.id, dx, dy)
  }

  const highlighted = new Set(highlightedRegionIds)

  return (
    <div className="lgp-region-overlay" data-lgp-part="region-overlay">
      {sortRegionsByOrder(regions).map((region) => {
        const label = regionKindLabel(region.kind, t)
        const low = isLowConfidence(region)
        const selected = region.id === selectedRegionId
        const isHighlighted = highlighted.has(region.id)
        const unassigned = isUnassignedRegion(region)
        const className = [
          'lgp-region',
          `lgp-region--kind-${region.kind}`,
          selected ? 'lgp-region--selected' : '',
          isHighlighted ? 'lgp-region--highlighted' : '',
          low ? 'lgp-region--low-confidence' : '',
          unassigned ? 'lgp-region--unassigned' : '',
        ]
          .filter((value) => value !== '')
          .join(' ')
        return (
          <div
            key={region.id}
            className={className}
            style={regionBoxStyle(region.bbox, page)}
            data-lgp-region-id={region.id}
            data-lgp-region-kind={region.kind}
            data-lgp-region-order={region.order}
            data-lgp-region-lines={region.lineIds.join(',')}
            data-lgp-region-article={region.articleId ?? ''}
            data-lgp-highlighted={isHighlighted ? 'true' : 'false'}
            data-lgp-low-confidence={low ? 'true' : 'false'}
            data-lgp-unassigned={unassigned ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={
              `${t('canvas.regionLabel', { kind: label })}，` +
              `${t('canvas.order', { order: region.order + 1 })}`
            }
            onClick={() => onSelectRegion(region.id)}
            onMouseDown={(event) => startMove(event, region)}
            onKeyDown={(event) => handleKeyDown(event, region)}
          >
            <span className="lgp-region-label">{label}</span>
            {unassigned ? (
              <span className="lgp-region-unassigned">{t('region.unassigned')}</span>
            ) : null}
            {low ? (
              <span
                className="lgp-region-warning"
                role="img"
                aria-label={t('canvas.lowConfidence')}
              >
                !
              </span>
            ) : null}
            {selected
              ? RESIZE_CORNERS.map((corner) => (
                  <span
                    key={corner}
                    className={`lgp-region-handle lgp-region-handle--${corner}`}
                    data-lgp-handle={corner}
                    aria-hidden="true"
                    onMouseDown={(event) => startResize(event, region, corner)}
                  />
                ))
              : null}
          </div>
        )
      })}
    </div>
  )
}

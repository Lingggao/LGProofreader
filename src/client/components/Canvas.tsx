/**
 * Page canvas (Task 18; design §6.1/§9.2/§9.4).
 *
 * Renders the stored page PNG at its true size scaled by the local zoom factor
 * (pixels per page point) and composes the {@link RegionOverlay} on top. The
 * page is laid out at `widthPt × zoom` / `heightPt × zoom` pixels, so the
 * overlay's percent positions always line up with the image at every zoom level.
 *
 * Interactions:
 * - zoom in / zoom out / fit width (local state; no page reload);
 * - fit mode is the **default** (Task 24): the page opens at the widest readable
 *   fit and re-fits live through a `ResizeObserver` whenever the viewport
 *   changes (right panel/window/resizing), so the user never gets a half-hidden
 *   page; a manual zoom leaves fit mode and 适应宽度 re-enables it;
 * - pan by scrolling the viewport or by dragging the page/background, which is
 *   the viewport's native overflow rather than a second scroll model;
 * - selection and keyboard moving of regions are delegated to `RegionOverlay`.
 *
 * Readable-minimum choice (Task 24 brief): the fit itself is the minimum — no
 * extra “minimum zoom” is forced above it, because that is exactly what used to
 * crop the page. The only floor is the normal `ZOOM_MIN` (20%), plus the
 * source-pixel cap that stops CSS upscaling from blurring the 240 DPI bitmap.
 *
 * The component stays presentational: it never touches page coordinates itself.
 * Every clamp happens in `App` through `moveRegion`/`resizeRegion` from
 * `src/shared/layout/edit.ts`, so a drag can never push a box outside the page.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from 'react'
import { defaultTranslate, type Translate } from '../locale'
import { RegionOverlay } from './RegionOverlay'
import type { BBox, PageSize, Region } from '../../shared/types'

/** Zoom when the canvas first mounts: 1 px per page point (100%). */
export const DEFAULT_ZOOM = 1
/** Smallest allowed zoom factor. */
export const ZOOM_MIN = 0.2
/** Largest allowed zoom factor. */
export const ZOOM_MAX = 4
/** One zoom-in / zoom-out step factor. */
export const ZOOM_STEP = 1.25

/** Pixels of padding kept around the page when fitting the width. */
export const FIT_PADDING_PX = 32

/** Clamp a zoom factor into `[ZOOM_MIN, ZOOM_MAX]`. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/** Zoom factor as the percentage shown in the toolbar. */
export function zoomPercent(zoom: number): number {
  return Math.round(clampZoom(zoom) * 100)
}

/**
 * Zoom factor that fits `pageWidthPt` into `availablePx` pixels.
 * A non-measurable viewport (0/negative) keeps the default zoom.
 */
export function fitZoom(availablePx: number, pageWidthPt: number): number {
  if (!Number.isFinite(availablePx) || !Number.isFinite(pageWidthPt)) return DEFAULT_ZOOM
  if (availablePx <= 0 || pageWidthPt <= 0) return DEFAULT_ZOOM
  return clampZoom(availablePx / pageWidthPt)
}

/**
 * Highest zoom that still maps one page point to at least one rendered source
 * pixel (Task 24: “no blurry CSS scaling beyond source”).
 *
 * The page PNG is rendered at 240 DPI (≈3.33 px/pt for a 612 pt US-Letter
 * page), so zooming past `naturalWidth / widthPt` would only upscale the stored
 * bitmap. The returned cap is clamped to the normal zoom range; a page image
 * that has not loaded yet (`0`) imposes no extra cap.
 */
export function sharpZoomLimit(naturalWidth: number, pageWidthPt: number): number {
  if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) return ZOOM_MAX
  if (!Number.isFinite(pageWidthPt) || pageWidthPt <= 0) return ZOOM_MAX
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, naturalWidth / pageWidthPt))
}

/** Props of {@link Canvas}. */
export interface CanvasProps {
  /** URL of the stored page PNG (`pageImageUrl(docId)`). */
  imageUrl: string
  /** Page size in PDF points. */
  page: PageSize
  /**
   * True once the page bitmap has reached the Host. While false the canvas
   * still renders its page frame/regions but does not issue a request for a
   * not-yet-uploaded PNG (which would log a transient 404 in DevTools).
   */
  imageReady?: boolean
  /** Layout regions to draw. */
  regions: readonly Region[]
  /** Currently selected region id. */
  selectedRegionId: string | null
  /** Selects a region. */
  onSelectRegion: (regionId: string) => void
  /** Arrow-key / drag move by `(dx, dy)` page points. */
  onMoveRegion: (regionId: string, dx: number, dy: number) => void
  /** Absolute resize target; `App` clamps it with `resizeRegion`. */
  onResizeRegion?: (regionId: string, bbox: BBox) => void
  /** Ids of the regions belonging to the selected articles. */
  highlightedRegionIds?: readonly string[]
  /** Undo/redo (toolbar alternative to Ctrl/Cmd+Z). */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** Locale-bound translator; defaults to the zh dictionary. */
  t?: Translate
}

/** Render the zoomable page canvas with the region overlay. */
export function Canvas({
  imageUrl,
  page,
  imageReady = true,
  regions,
  selectedRegionId,
  onSelectRegion,
  onMoveRegion,
  onResizeRegion,
  highlightedRegionIds = [],
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  t = defaultTranslate,
}: CanvasProps) {
  /** Current zoom factor; in fit mode it is recomputed from the viewport. */
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  /**
   * Fit mode is on by default (Task 24): the page opens at the readable fit
   * width instead of 100% (which showed only part of a newspaper page once the
   * right aside took its share of the workbench).
   */
  const [fitMode, setFitMode] = useState(true)
  /**
   * Cap that prevents upscaling the stored page bitmap past its rendered pixel
   * source (`naturalWidth / widthPt`); `ZOOM_MAX` until the image loads.
   */
  const [sourceMaxZoom, setSourceMaxZoom] = useState(ZOOM_MAX)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  // Background/page drag = pan by moving the viewport's native scroll offsets.
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const pan = panRef.current
      const viewport = viewportRef.current
      if (pan === null || viewport === null) return
      viewport.scrollLeft = pan.left - (event.clientX - pan.x)
      viewport.scrollTop = pan.top - (event.clientY - pan.y)
    }
    const handleMouseUp = (): void => {
      panRef.current = null
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const clampToSource = useCallback(
    (value: number): number => Math.min(clampZoom(value), sourceMaxZoom),
    [sourceMaxZoom],
  )

  // A new page image is a new bitmap: drop the old source cap until it loads.
  useEffect(() => {
    setSourceMaxZoom(ZOOM_MAX)
  }, [imageUrl])

  // If the page image is smaller than the current manual zoom allows, pull the
  // zoom back to the source resolution instead of upscaling a blurry bitmap.
  useEffect(() => {
    setZoom((current) => Math.min(current, sourceMaxZoom))
  }, [sourceMaxZoom])

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const naturalWidth = event.currentTarget.naturalWidth
    const pageWidthPt = page.widthPt
    setSourceMaxZoom(sharpZoomLimit(naturalWidth, pageWidthPt))
  }

  /**
   * Zoom around the pointer without letting the point under the cursor drift.
   * Wheel zoom is intentionally a separate manual-zoom gesture: it leaves fit
   * mode, and the viewport's native scrollbars/left-drag take over panning.
   */
  const zoomAtPoint = useCallback(
    (factor: number, clientX: number, clientY: number): void => {
      const viewport = viewportRef.current
      const pageElement = pageRef.current
      if (viewport === null || pageElement === null) return
      const current = zoomRef.current
      const next = clampToSource(current * factor)
      if (!Number.isFinite(next) || Math.abs(next - current) < 0.0001) return
      const rect = pageElement.getBoundingClientRect()
      const pageX = current > 0 ? (clientX - rect.left) / current : 0
      const pageY = current > 0 ? (clientY - rect.top) / current : 0
      setFitMode(false)
      setZoom(next)
      const restore = (): void => {
        const nextRect = pageElement.getBoundingClientRect()
        viewport.scrollLeft += nextRect.left + pageX * next - clientX
        viewport.scrollTop += nextRect.top + pageY * next - clientY
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore)
      else queueMicrotask(restore)
    },
    [clampToSource],
  )

  // Native, non-passive wheel listener: React's synthetic wheel handler is
  // passive in some browsers, which would let the page scroll while zooming.
  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      event.preventDefault()
      zoomAtPoint(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [zoomAtPoint])

  /**
   * Fit the page width into the viewport.
   *
   * `useLayoutEffect` runs before paint, so the first frame already shows the
   * fitted page (no 100% flash / half page). The `ResizeObserver` refits while
   * fit mode is on, which is what keeps the page whole when the right panel or
   * the window changes width. A zero/unknown viewport width leaves the default
   * zoom in place (first render in a hidden panel).
   */
  useLayoutEffect(() => {
    if (!fitMode) return
    const viewport = viewportRef.current
    if (viewport === null) return
    const refit = (): void => {
      const available = viewport.clientWidth - FIT_PADDING_PX
      setZoom(clampToSource(fitZoom(available, page.widthPt)))
    }
    refit()
    if (typeof ResizeObserver === 'undefined') {
      // Older embedded runtimes: at least follow window width changes.
      window.addEventListener('resize', refit)
      return () => window.removeEventListener('resize', refit)
    }
    const observer = new ResizeObserver(refit)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [clampToSource, fitMode, page.widthPt])

  const startPan = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    const viewport = viewportRef.current
    if (viewport === null) return
    const onPage =
      target === event.currentTarget ||
      target.classList.contains('lgp-canvas-page') ||
      target.classList.contains('lgp-canvas-image') ||
      target.classList.contains('lgp-region-overlay')
    // Region interaction owns its own mousedown; pressing on a region box must
    // move that region, not pan the page. Pressing the overlay background pans.
    if (!onPage || target.closest('.lgp-region') !== null) return
    event.preventDefault()
    panRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    }
  }

  /** Manual zoom leaves fit mode: the user picked a size explicitly. */
  const zoomBy = (factor: number): void => {
    setFitMode(false)
    setZoom((current) => clampToSource(current * factor))
  }

  const handleFit = (): void => {
    setFitMode(true)
    const available = (viewportRef.current?.clientWidth ?? 0) - FIT_PADDING_PX
    setZoom(clampToSource(fitZoom(available, page.widthPt)))
  }

  const scale = zoom > 0 ? zoom : DEFAULT_ZOOM
  // Defensive: a malformed page size must not produce `NaNpx` styles; the
  // overlay's percent helper treats a zero total as 0%.
  const pageWidthPt = Number.isFinite(page.widthPt) && page.widthPt > 0 ? page.widthPt : 0
  const pageHeightPt = Number.isFinite(page.heightPt) && page.heightPt > 0 ? page.heightPt : 0
  const canvasPage: PageSize = { widthPt: pageWidthPt, heightPt: pageHeightPt }
  const pageStyle: CSSProperties = {
    width: `${pageWidthPt * scale}px`,
    height: `${pageHeightPt * scale}px`,
  }

  return (
    <div
      className="lgp-canvas-shell"
      data-lgp-slot="canvas"
      data-lgp-part="canvas"
      data-lgp-fit={fitMode ? 'true' : 'false'}
    >
      <div className="lgp-canvas-toolbar" role="toolbar" aria-label={t('canvas.toolbar')}>
        <button
          type="button"
          className="lgp-button lgp-canvas-history-button"
          aria-label={t('history.undo')}
          disabled={!canUndo || onUndo === undefined}
          onClick={() => onUndo?.()}
        >
          {t('history.undo')}
        </button>
        <button
          type="button"
          className="lgp-button lgp-canvas-history-button"
          aria-label={t('history.redo')}
          disabled={!canRedo || onRedo === undefined}
          onClick={() => onRedo?.()}
        >
          {t('history.redo')}
        </button>
        <span className="lgp-canvas-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="lgp-button lgp-button--ghost lgp-canvas-zoom-button"
          aria-label={t('canvas.zoomOut')}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          −
        </button>
        <output className="lgp-canvas-zoom" data-lgp-zoom={zoomPercent(zoom)}>
          {t('canvas.zoom', { percent: zoomPercent(zoom) })}
        </output>
        <button
          type="button"
          className="lgp-button lgp-button--ghost lgp-canvas-zoom-button"
          aria-label={t('canvas.zoomIn')}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="lgp-button lgp-canvas-fit-button"
          aria-pressed={fitMode}
          onClick={handleFit}
        >
          {t('canvas.fit')}
        </button>
      </div>
      <div
        ref={viewportRef}
        className="lgp-canvas-viewport"
        data-lgp-part="canvas-viewport"
        onMouseDown={startPan}
      >
        <div className="lgp-canvas-page" ref={pageRef} data-lgp-part="canvas-page" style={pageStyle}>
          {imageReady ? (
            <img
              className="lgp-canvas-image"
              src={imageUrl}
              alt={t('canvas.pageImage')}
              draggable={false}
              onLoad={handleImageLoad}
            />
          ) : (
            <div
              className="lgp-canvas-image-placeholder"
              data-lgp-image-placeholder="true"
              aria-hidden="true"
            />
          )}
          <RegionOverlay
            page={canvasPage}
            regions={regions}
            selectedRegionId={selectedRegionId}
            highlightedRegionIds={highlightedRegionIds}
            scale={scale}
            onSelectRegion={onSelectRegion}
            onMoveRegion={onMoveRegion}
            onResizeRegion={onResizeRegion}
            t={t}
          />
        </div>
      </div>
    </div>
  )
}

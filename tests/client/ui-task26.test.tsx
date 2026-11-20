// @vitest-environment jsdom
/**
 * Task 26: preview gestures, empty-state copy and collapsible recent-documents rail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../src/client/assets', () => ({
  sidebarIcon: 'data:image/png;base64,AAA',
  wordmarkLight: 'light.png',
  wordmarkDark: 'dark.png',
}))

import { Canvas } from '../../src/client/components/Canvas'
import { DocumentRail } from '../../src/client/components/DocumentRail'
import { defaultTranslate } from '../../src/client/locale'
import type { PageSize, Region } from '../../src/shared/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PAGE: PageSize = { widthPt: 1000, heightPt: 1000 }

const REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'article',
  bbox: { x: 100, y: 100, w: 300, h: 300 },
  lineIds: [],
  order: 1,
  confidence: 0.9,
  source: 'vision',
}

function renderCanvas() {
  return render(
    <Canvas
      imageUrl="data:image/png;base64,AAA"
      page={PAGE}
      regions={[REGION]}
      selectedRegionId={null}
      onSelectRegion={vi.fn()}
      onMoveRegion={vi.fn()}
    />,
  )
}

describe('Task 26 preview gestures', () => {
  it('zooms with the mouse wheel and leaves fit mode', () => {
    const { container } = renderCanvas()
    const viewport = container.querySelector('.lgp-canvas-viewport') as HTMLElement
    const shell = container.querySelector('.lgp-canvas-shell') as HTMLElement
    expect(shell.getAttribute('data-lgp-fit')).toBe('true')

    fireEvent.wheel(viewport, { deltaY: -120, clientX: 100, clientY: 100 })
    const zoom = container.querySelector('[data-lgp-zoom]') as HTMLElement
    expect(Number(zoom.getAttribute('data-lgp-zoom'))).toBeGreaterThan(100)
    expect(shell.getAttribute('data-lgp-fit')).toBe('false')
  })

  it('pans by dragging the overlay/page with the left button', () => {
    const { container } = renderCanvas()
    const viewport = container.querySelector('.lgp-canvas-viewport') as HTMLElement
    const overlay = container.querySelector('.lgp-region-overlay') as HTMLElement
    viewport.scrollLeft = 100
    viewport.scrollTop = 100

    fireEvent.mouseDown(overlay, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 25, clientY: 20 })
    fireEvent.mouseUp(window)

    expect(viewport.scrollLeft).toBe(85)
    expect(viewport.scrollTop).toBe(90)
  })

  it('does not start a pan when the left button goes down on a region box', () => {
    const { container } = renderCanvas()
    const viewport = container.querySelector('.lgp-canvas-viewport') as HTMLElement
    const region = container.querySelector('[data-lgp-region-id="r1"]') as HTMLElement
    viewport.scrollLeft = 100

    fireEvent.mouseDown(region, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 30, clientY: 10 })
    fireEvent.mouseUp(window)

    // The region's own drag handler may move it, but the viewport pan must not
    // consume the gesture.
    expect(viewport.scrollLeft).toBe(100)
  })
})

describe('Task 26 empty-state copy', () => {
  it('uses the new Chinese lead copy', () => {
    expect(defaultTranslate('empty.lead')).toBe(
      '把一页报纸 PDF 分解为可校对的文章。先分析版面，再按需校对。',
    )
  })
})

describe('Task 26 collapsible recent-documents rail', () => {
  it('collapses and expands from accessible controls', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <DocumentRail
        documents={[]}
        onOpen={vi.fn()}
        onUpload={vi.fn()}
        collapsed={false}
        onToggleCollapsed={onToggle}
        collapseLabel="折叠最近文档"
        expandLabel="展开最近文档"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '折叠最近文档' }))
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(
      <DocumentRail
        documents={[]}
        onOpen={vi.fn()}
        onUpload={vi.fn()}
        collapsed
        onToggleCollapsed={onToggle}
        collapseLabel="折叠最近文档"
        expandLabel="展开最近文档"
      />,
    )
    expect(screen.queryByText('最近文档')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开最近文档' }))
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-lgp-part="document-rail"]')?.getAttribute('data-lgp-collapsed')).toBe('true')
  })
})

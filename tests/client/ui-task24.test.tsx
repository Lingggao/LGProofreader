// @vitest-environment jsdom
/**
 * Task 24 — UI/UX and PDF-preview acceptance tests.
 *
 * Covers the user-reported issues and the required fixes:
 * - Settings drawer: prominent ← 返回 + explicit close, initial focus, Escape,
 *   `role=dialog`/`aria-modal=true`, and a dimmed workbench whose backdrop
 *   closes the drawer without blanking the page;
 * - Region overlay: the visual halo is drawn outward by `::before`, labels and
 *   badges are >= 12 px/10 px, and the halo is not colour-only;
 * - Must-fix Markdown: `**…**` renders as `<strong>` (no literal `**`), while a
 *   finding suggestion without markers keeps its whole-bold fallback;
 * - Typography: Chinese font stack, a type scale, no UI copy below 12 px,
 *   body 15 px/1.6, 24 px summary numbers and the wider 400 px aside;
 * - PDF canvas: fit mode is the default, a faux `ResizeObserver` refits on
 *   viewport/page changes, manual zoom exits fit and 适应宽度 re-enables it, and
 *   zoom never scales the image beyond its rendered pixel source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('../../src/client/assets', () => ({
  sidebarIcon: 'data:image/png;base64,AAA',
  wordmarkLight: 'light.png',
  wordmarkDark: 'dark.png',
}))

import { App, type WorkbenchApi } from '../../src/client/app'
import { Canvas, fitZoom, sharpZoomLimit, type CanvasProps } from '../../src/client/components/Canvas'
import {
  InlineMarkdown,
  parseBoldSpans,
} from '../../src/client/components/InlineMarkdown'
import { ReportView } from '../../src/client/components/ReportView'
import { SettingsDrawer } from '../../src/client/components/SettingsDrawer'
import { clientStyles } from '../../src/client/styles'
import type { MetaView, SettingsView } from '../../src/shared/api/protocol'
import type { Article, PageSize, Region, Report } from '../../src/shared/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const SETTINGS: SettingsView = {
  provider: 'provider_a',
  model: 'model_x',
  reasoningEffort: 'max',
  depth: 'standard',
  factCheck: true,
  maxConcurrentWorkers: 4,
  perCallTimeoutMs: 180_000,
  maxClaimsPerArticle: 16,
  maxSearchQueriesPerArticle: 24,
  searchResultsPerClaim: 5,
  fetchPagesPerClaim: 2,
  includeHeaderFooter: false,
}

const META: MetaView = {
  version: '1.0.0',
  model: { provider: 'provider_a', model: 'model_x' },
  promptVersion: 'prompt-v1',
  limits: { maxUploadBytes: 1, maxImageBytes: 1, maxJsonBytes: 1, maxPages: 1 },
  modelCatalogue: [{ id: 'provider_a', title: '服务商 A', models: [{ id: 'model_x', name: '模型 X' }] }],
}

const REPORT: Report = {
  jobId: 'proof_1',
  docId: 'doc_1',
  articleIds: ['a1'],
  createdAt: 1_760_000_000_000,
  model: 'deepseek-flash',
  promptVersion: 'prompt-v1',
  depth: 'standard',
  summary: {
    mustFixCount: 1,
    suggestedCount: 0,
    optionalCount: 0,
    factCheck: { confirmed: 0, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
    byCategory: {},
    mustFixList: [
      '《头条新闻》错别字：**“他的确”** → 他确实',
      '二条标题缺标点',
    ],
  },
  findings: [],
  factChecks: [],
  stats: { calls: 1, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 100 },
}

const ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'lead',
  title: '头条新闻',
  body: '头条正文',
  regionIds: ['r1'],
  readingOrder: 0,
  confidence: 0.9,
  warnings: [],
}

const PAGE: PageSize = { widthPt: 1000, heightPt: 1000 }

const REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 100, y: 200, w: 300, h: 100 },
  lineIds: ['l1'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

/* ------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* ------------------------------------------------------------------------- */

describe('InlineMarkdown', () => {
  it('splits marked segments and drops the markers', () => {
    expect(parseBoldSpans('可改为**他确实**。')).toEqual([
      { text: '可改为', strong: false },
      { text: '他确实', strong: true },
      { text: '。', strong: false },
    ])
  })

  it('keeps an unmatched marker literally (no dropped text)', () => {
    expect(parseBoldSpans('**未闭合')).toEqual([{ text: '**未闭合', strong: false }])
    expect(parseBoldSpans('')).toEqual([])
  })

  it('renders <strong> spans and keeps unmatched markers as text', () => {
    const { container } = render(<InlineMarkdown text={'修正为**“他确实”**'} />)
    expect(container.querySelector('strong')?.textContent).toBe('“他确实”')
    expect(container.textContent).toBe('修正为“他确实”')

    cleanup()
    const literal = render(<InlineMarkdown text="**未闭合" />)
    expect(literal.container.querySelector('strong')).toBeNull()
    expect(literal.container.textContent).toBe('**未闭合')
    // No whole-string bold fallback for the must-fix renderer.
    expect(literal.container.querySelector('strong')).toBeNull()
  })

  it('renders the must-fix list with <strong> and no literal **', () => {
    const { container } = render(
      <ReportView report={REPORT} articles={[ARTICLE]} />,
    )
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-lgp-must-fix-list] .lgp-must-fix-item'),
    )
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('strong')?.textContent).toBe('“他的确”')
    expect(items[0]!.textContent).not.toContain('**')
    // A plain must-fix item stays plain (never whole-string bold).
    expect(items[1]!.querySelector('strong')).toBeNull()
    expect(items[1]!.textContent).toBe('二条标题缺标点')
  })
})

/* ------------------------------------------------------------------------- */
/* Settings drawer                                                            */
/* ------------------------------------------------------------------------- */

function renderDrawer(overrides: Partial<ComponentProps<typeof SettingsDrawer>> = {}) {
  const handlers = {
    onSave: vi.fn(async (_patch: unknown) => {}),
    onClose: vi.fn(),
  }
  const view = render(
    <SettingsDrawer
      settings={SETTINGS}
      catalogue={META.modelCatalogue}
      {...handlers}
      {...overrides}
    />,
  )
  return { ...view, ...handlers }
}

describe('SettingsDrawer back/close affordances', () => {
  it('is a modal dialog with a prominent back button that takes initial focus', () => {
    const { container } = renderDrawer()
    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    const back = screen.getByRole('button', { name: '← 返回' })
    expect(back.className).toContain('lgp-settings-back')
    expect(container.querySelector('.lgp-settings-head')?.firstElementChild).toBe(back)
    expect(document.activeElement).toBe(back)
  })

  it('closes from the back button and from the explicit close button', () => {
    const { onClose } = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    const close = screen.getByRole('button', { name: '关闭设置' })
    expect(close.textContent).toContain('×')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape and keeps the save/error behavior', async () => {
    const onClose = vi.fn()
    const onSave = vi.fn(async () => {
      throw new Error('网络失败')
    })
    renderDrawer({ onClose, onSave })

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('网络失败'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Settings overlay over the workbench', () => {
  function fakeApi(): WorkbenchApi {
    return {
      getMeta: vi.fn(async () => META),
      getSettings: vi.fn(async () => SETTINGS),
      saveSettings: vi.fn(async () => ({ ok: true })),
    } as unknown as WorkbenchApi
  }

  it('dims the workbench instead of replacing it and closes on backdrop click', async () => {
    const { container } = render(<App api={fakeApi()} />)
    // The workbench stays mounted below the overlay.
    expect(container.querySelector('[data-lgp-part="header"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy())
    expect(container.querySelector('[data-lgp-part="header"]')).toBeTruthy()

    const overlay = container.querySelector('[data-lgp-part="settings-overlay"]') as HTMLElement
    // A click inside the drawer must not close it.
    fireEvent.click(screen.getByRole('dialog', { name: '设置' }))
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()

    fireEvent.click(overlay)
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
    // The workbench is still there after closing.
    expect(container.querySelector('[data-lgp-part="header"]')).toBeTruthy()
  })
})

/* ------------------------------------------------------------------------- */
/* Region overlay + typography styles                                         */
/* ------------------------------------------------------------------------- */

describe('Task 24 stylesheet', () => {
  it('draws the outward region halo and enlarged labels without clipping', () => {
    const regionRule = clientStyles.match(/\.lgp-region \{([^}]*)\}/)?.[1] ?? ''
    expect(regionRule).toContain('overflow: visible')
    const halo = clientStyles.match(/\.lgp-region::before \{([^}]*)\}/)?.[1] ?? ''
    expect(halo).toMatch(/inset: -\d+px/)
    expect(halo).toMatch(/border: 1\.5px solid/)
    expect(halo).toContain('color-mix(')
    // Selected/highlighted halos are stronger and not colour-only.
    expect(clientStyles).toMatch(/\.lgp-region--selected::before[^{]*\{[^}]*border-width/s)
    expect(clientStyles).toMatch(/\.lgp-region--highlighted::before[^{]*\{[^}]*border-style:\s*dashed/s)

    const label = clientStyles.match(/\.lgp-region-label \{([^}]*)\}/)?.[1] ?? ''
    expect(label).toMatch(/font-size: var\(--lgp-text-label\)|font-size: 12px/)
    expect(label).toContain('padding:')
    expect(label).toContain('border-radius: 6px')
    // 1.0.0 removed the in-box confidence text to keep the preview uncluttered.
    expect(clientStyles).not.toContain('.lgp-region-confidence')
    const handle = clientStyles.match(/\.lgp-region-handle \{([^}]*)\}/)?.[1] ?? ''
    expect(handle).toMatch(/width: 1[0-2]px/)
    expect(handle).toMatch(/height: 1[0-2]px/)
  })

  it('ships the Chinese font stack and a calm type scale without tiny UI copy', () => {
    expect(clientStyles).toContain('--lgp-font-sans')
    expect(clientStyles).toContain('"Noto Sans SC"')
    expect(clientStyles).toContain('"Microsoft YaHei UI"')
    expect(clientStyles).toContain('--lgp-text-base: 15px')
    expect(clientStyles).toContain('--lgp-text-control: 14px')
    expect(clientStyles).toContain('--lgp-text-heading: 17px')
    expect(clientStyles).toContain('--lgp-text-title: 22px')
    expect(clientStyles).toContain('--lgp-text-stat: 24px')
    expect(clientStyles).toContain('font-synthesis: none')
    expect(clientStyles).toContain('-webkit-font-smoothing: antialiased')
    expect(clientStyles).toMatch(/\.lgp-root \{[^}]*font-size: var\(--lgp-text-base\)/s)
    expect(clientStyles).toContain('--lgp-line-body: 1.6')
    expect(clientStyles).toMatch(/\.lgp-root \{[^}]*line-height: var\(--lgp-line-body\)/s)
    expect(clientStyles).toMatch(/\.lgp-summary-value \{[^}]*font-size: var\(--lgp-text-stat\)/s)
    // The right column got wider so the larger type still fits.
    expect(clientStyles).toMatch(/\.lgp-aside \{[^}]*width: 400px/s)
    // No 9/10/11 px UI copy is left anywhere in the panel stylesheet.
    expect(clientStyles).not.toMatch(/font-size:\s*(?:9|10|11)px/)
  })

  it('keeps the settings overlay translucent and blurred over the workbench', () => {
    const overlay = clientStyles.match(/\.lgp-settings-overlay \{([^}]*)\}/)?.[1] ?? ''
    expect(overlay).toContain('position: fixed')
    expect(overlay).toContain('backdrop-filter: blur(')
    expect(overlay).toContain('color-mix(')
    expect(overlay).not.toContain('background: var(--dsw-alias-bg-base);')
  })
})

/* ------------------------------------------------------------------------- */
/* Canvas adaptive fit                                                        */
/* ------------------------------------------------------------------------- */

/** Minimal faux ResizeObserver: tests trigger it after changing clientWidth. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed: Element[] = []
  private connected = true
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.connected = true
    this.observed.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    // A disconnected observer never fires again (the real one also stops).
    this.connected = false
    this.observed.length = 0
  }

  trigger(): void {
    if (!this.connected) return
    this.callback([], this)
  }
}

function stubViewportWidth(width: number): { setWidth: (next: number) => void } {
  const spy = vi
    .spyOn(Element.prototype, 'clientWidth', 'get')
    .mockReturnValue(width) as unknown as { mockReturnValue: (next: number) => void }
  return { setWidth: (next: number) => spy.mockReturnValue(next) }
}

function renderCanvas(overrides: Partial<ComponentProps<typeof Canvas>> = {}) {
  const handlers = {
    onSelectRegion: vi.fn(),
    onMoveRegion: vi.fn(),
    onResizeRegion: vi.fn(),
  }
  const view = render(
    <Canvas
      imageUrl="api/lgproofreader/page-image?doc=doc_1"
      page={PAGE}
      regions={[REGION]}
      selectedRegionId={null}
      {...handlers}
      {...overrides}
    />,
  )
  return { ...view, ...handlers }
}

function zoomValue(container: HTMLElement): string | null {
  return (
    container.querySelector('[data-lgp-zoom]')?.getAttribute('data-lgp-zoom') ?? null
  )
}

function fitFlag(container: HTMLElement): string | null {
  return (
    container.querySelector('.lgp-canvas-shell')?.getAttribute('data-lgp-fit') ?? null
  )
}

function pageWidth(container: HTMLElement): string {
  return (container.querySelector('.lgp-canvas-page') as HTMLElement).style.width
}

describe('Canvas adaptive fit', () => {
  it('starts in fit mode and fits the page width on first layout', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubViewportWidth(832)

    const { container } = renderCanvas()

    // (832 - 32) / 1000 pt = 0.8 → 80%.
    expect(fitFlag(container)).toBe('true')
    const fitButton = screen.getByRole('button', { name: '适应宽度' })
    expect(fitButton.getAttribute('aria-pressed')).toBe('true')
    expect(zoomValue(container)).toBe('80')
    expect(pageWidth(container)).toBe('800px')
  })

  it('refits when the viewport (aside opening) or the page changes', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const viewport = stubViewportWidth(832)
    const view = renderCanvas()
    expect(zoomValue(view.container)).toBe('80')

    viewport.setWidth(532)
    act(() => FakeResizeObserver.instances.at(-1)!.trigger())
    // (532 - 32) / 1000 = 0.5 → 50%.
    expect(zoomValue(view.container)).toBe('50')
    expect(pageWidth(view.container)).toBe('500px')

    view.rerender(
      <Canvas
        imageUrl="api/lgproofreader/page-image?doc=doc_1"
        page={{ widthPt: 500, heightPt: 500 }}
        regions={[REGION]}
        selectedRegionId={null}
        onSelectRegion={vi.fn()}
        onMoveRegion={vi.fn()}
        onResizeRegion={vi.fn()}
      />,
    )
    // (532 - 32) / 500 = 1 → 100%.
    expect(zoomValue(view.container)).toBe('100')
  })

  it('manual zoom exits fit and 适应宽度 re-enables the live fit', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const viewport = stubViewportWidth(832)
    const view = renderCanvas()
    expect(zoomValue(view.container)).toBe('80')

    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    // 0.8 × 1.25 = 1.0 → 100%; the fit flag is off.
    expect(zoomValue(view.container)).toBe('100')
    expect(fitFlag(view.container)).toBe('false')
    expect(screen.getByRole('button', { name: '适应宽度' }).getAttribute('aria-pressed')).toBe(
      'false',
    )

    // A viewport change no longer moves the manual zoom.
    viewport.setWidth(532)
    act(() => FakeResizeObserver.instances.at(-1)!.trigger())
    expect(zoomValue(view.container)).toBe('100')

    fireEvent.click(screen.getByRole('button', { name: '适应宽度' }))
    expect(fitFlag(view.container)).toBe('true')
    // (532 - 32) / 1000 = 0.5 → 50%.
    expect(zoomValue(view.container)).toBe('50')
    act(() => FakeResizeObserver.instances.at(-1)!.trigger())
    expect(zoomValue(view.container)).toBe('50')
  })

  it('never scales the page image beyond its rendered pixel source', () => {
    expect(sharpZoomLimit(2040, 612)).toBeCloseTo(2040 / 612, 10)
    expect(sharpZoomLimit(0, 612)).toBe(4)
    expect(fitZoom(4000, 500)).toBe(4)

    // A loaded bitmap caps a manual zoom above its source resolution.
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubViewportWidth(0)
    const view = renderCanvas()
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(zoomValue(view.container)).toBe('156')

    const image = view.container.querySelector('.lgp-canvas-image') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 })
    fireEvent.load(image)
    // 1200 px / 1000 pt = 1.2 → the 156% manual zoom is pulled back to 120%.
    expect(zoomValue(view.container)).toBe('120')
  })
})

// @vitest-environment jsdom
/**
 * Proofreading UI and report tests (Task 19).
 *
 * Covers the task's acceptance surface:
 * - `ProofreadPanel`: start disabled with no selection, depth quick/standard/deep,
 *   fact-check toggle with the offline warning and its second confirmation, call
 *   estimate `articles × roles`, whole-page confirmation (article count + estimate),
 *   "no auto start" (nothing runs before the explicit click);
 * - `JobProgress`: per-stage statuses, progress bar, failed-stage error;
 * - `FactCheckList`: every verdict row (confirmed / unverified / not_checked /
 *   insufficient / contradicted), `FactCheck.occurrence` for repeated claims,
 *   sources/evidence and the explicit 未联网核查 marker;
 * - `FindingCard` / `ReportList` / `ReportView`: severity/category/article filters,
 *   quote/issue/bold suggestion/sources, finding status actions, summary counts,
 *   must-fix list, model/depth/timestamps;
 * - `SettingsDrawer`: only runtime-effective settings (provider/model from the
 *   `/meta` catalogue, depth, concurrency, timeout, factCheck); the dead
 *   fact-budget/includeHeaderFooter controls are not rendered;
 * - `App` integration: the proofread request payload (`depth`, `factCheck`,
 *   `articleIds`), progress polling, cancel, report rendering + 未联网核查,
 *   copy/export, and settings persistence through the fake API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('../../src/client/assets', () => ({
  sidebarIcon: 'data:image/png;base64,AAA',
  wordmarkLight: 'light.png',
  wordmarkDark: 'dark.png',
}))

import { App, createWorkbenchApi, readProofreadReport, type WorkbenchApi } from '../../src/client/app'
import { FactCheckList, isOfflineFactCheck } from '../../src/client/components/FactCheckList'
import { FindingCard } from '../../src/client/components/FindingCard'
import { JobProgress } from '../../src/client/components/JobProgress'
import {
  ProofreadPanel,
  PROOFREAD_ROLE_COUNTS,
  estimateProofreadCalls,
} from '../../src/client/components/ProofreadPanel'
import { ReportList } from '../../src/client/components/ReportList'
import { ReportView } from '../../src/client/components/ReportView'
import { SettingsDrawer } from '../../src/client/components/SettingsDrawer'
import type {
  DocumentView,
  JobView,
  MetaView,
  ProofreadRequest,
  SettingsView,
} from '../../src/shared/api/protocol'
import type {
  Article,
  CandidateBlock,
  DocumentMeta,
  FactCheck,
  Finding,
  Region,
  Report,
  TextLine,
} from '../../src/shared/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

function pdfFile(name = 'page.pdf'): File {
  return new File([PDF_BYTES], name, { type: 'application/pdf' })
}

const TEXT_LINE: TextLine = {
  id: 'l1',
  text: '版面文字',
  bbox: { x: 10, y: 20, w: 40, h: 12 },
  fontSize: 12,
  fontWeight: 400,
  baseline: 20,
  column: 0,
}

const CANDIDATE: CandidateBlock = {
  candidateId: 'c1',
  bbox: { x: 10, y: 20, w: 40, h: 12 },
  lineIds: ['l1'],
  fontSizeBand: 'body',
  firstLineText: '版面文字',
  lineCount: 1,
}

const LEAD_ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'lead',
  title: '头条新闻',
  body: '他的确来到了现场，现场秩序良好。',
  regionIds: ['r1'],
  readingOrder: 0,
  confidence: 0.9,
  warnings: [],
}

const SECOND_ARTICLE: Article = {
  id: 'a2',
  page: 1,
  role: 'second',
  title: '二条新闻',
  body: '二条正文内容。',
  regionIds: ['r2'],
  readingOrder: 1,
  confidence: 0.8,
  warnings: [],
}

const LEAD_REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'lead',
  bbox: { x: 10, y: 20, w: 100, h: 60 },
  lineIds: ['l1'],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const SECOND_REGION: Region = {
  id: 'r2',
  page: 1,
  kind: 'second',
  bbox: { x: 10, y: 120, w: 100, h: 60 },
  lineIds: [],
  order: 1,
  confidence: 0.8,
  source: 'vision',
}

const DOCUMENT: DocumentMeta = {
  id: 'doc_1',
  fileName: 'page.pdf',
  pageCount: 1,
  createdAt: 1_760_000_000_000,
  status: 'parsing',
}

const FINDING_MUST: Finding = {
  id: 'a1:f1',
  articleId: 'a1',
  category: 'typo',
  severity: 'must_fix',
  quote: '他的确',
  occurrence: 2,
  issue: '错别字',
  suggestion: '他确实',
  reason: '“的确”是规范写法',
  evidence: '现代汉语词典',
  sources: [{ title: '现代汉语词典', url: 'https://example.com/dict' }],
  confidence: 'high',
  needsHuman: false,
  roles: ['words'],
  status: 'open',
}

const FINDING_SUGGESTED: Finding = {
  id: 'a2:f1',
  articleId: 'a2',
  category: 'headline',
  severity: 'suggested',
  quote: '二条正文',
  occurrence: 1,
  issue: '标题与正文不一致',
  suggestion: '二条正文内容',
  reason: '标题需概括正文',
  confidence: 'medium',
  needsHuman: true,
  roles: ['headline'],
  status: 'open',
}

const FINDING_OPTIONAL: Finding = {
  id: 'a2:f2',
  articleId: 'a2',
  category: 'format',
  severity: 'optional',
  quote: '秩序良好',
  occurrence: 1,
  issue: '表述可更简洁',
  suggestion: '秩序井然',
  confidence: 'low',
  needsHuman: false,
  roles: ['style'],
  status: 'deferred',
}

const FACT_CONFIRMED: FactCheck = {
  id: 'a1:fc1',
  articleId: 'a1',
  claim: '2026年11月14日',
  quote: '2026年11月14日',
  kind: 'date',
  verdict: 'confirmed',
  evidence: '官网发布了同一天的公告',
  sources: [{ title: '示例来源', url: 'https://example.com/source' }],
  occurrence: 1,
  confidence: 'high',
  needsHuman: false,
}

const FACT_UNVERIFIED: FactCheck = {
  id: 'a1:fc2',
  articleId: 'a1',
  claim: '现场观众超过一万人',
  quote: '现场秩序良好',
  kind: 'number',
  verdict: 'unverified',
  sources: [],
  occurrence: 2,
  confidence: 'low',
  needsHuman: true,
}

const FACT_NOT_CHECKED: FactCheck = {
  id: 'a1:fc3',
  articleId: 'a1',
  claim: '主办方为示例单位',
  quote: '主办方',
  kind: 'organization',
  verdict: 'not_checked',
  sources: [],
  confidence: 'low',
  needsHuman: false,
}

const SUMMARY: Report['summary'] = {
  mustFixCount: 1,
  suggestedCount: 1,
  optionalCount: 1,
  factCheck: {
    confirmed: 1,
    contradicted: 0,
    unverified: 1,
    insufficient: 0,
    notChecked: 1,
  },
  byCategory: { typo: 1, headline: 1, format: 1 },
  mustFixList: ['《头条新闻》错别字：“他的确” → 他确实'],
}

const REPORT: Report = {
  jobId: 'proof_1',
  docId: 'doc_1',
  articleIds: ['a1', 'a2'],
  createdAt: 1_760_000_000_000,
  model: 'deepseek-flash',
  promptVersion: 'prompt-v1',
  depth: 'standard',
  summary: SUMMARY,
  findings: [FINDING_MUST, FINDING_SUGGESTED, FINDING_OPTIONAL],
  factChecks: [FACT_CONFIRMED, FACT_UNVERIFIED, FACT_NOT_CHECKED],
  stats: { calls: 12, failedCalls: 0, searchCalls: 4, fetchCalls: 2, elapsedMs: 12_345 },
}

const OFFLINE_REPORT: Report = {
  ...REPORT,
  jobId: 'proof_offline',
  factChecks: [
    FACT_UNVERIFIED,
    { ...FACT_NOT_CHECKED, id: 'a1:fc4', claim: '另一条未核查项', quote: '另一条' },
  ],
  summary: {
    ...SUMMARY,
    factCheck: { confirmed: 0, contradicted: 0, unverified: 1, insufficient: 0, notChecked: 1 },
  },
  stats: { calls: 8, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 8_000 },
}

/**
 * The critical regression fixture: the Host had no `web` service, but the fact
 * checker already counted one search **attempt**, so `stats.searchCalls > 0`.
 * The explicit mode must still mark the report 未联网核查.
 */
const UNAVAILABLE_REPORT: Report = {
  ...REPORT,
  jobId: 'proof_unavailable',
  factCheckMode: 'unavailable',
  factChecks: [FACT_UNVERIFIED, FACT_NOT_CHECKED],
  summary: {
    ...SUMMARY,
    factCheck: { confirmed: 0, contradicted: 0, unverified: 1, insufficient: 0, notChecked: 1 },
  },
  stats: { ...REPORT.stats, searchCalls: 1, fetchCalls: 0 },
}

const META: MetaView = {
  version: '0.1.0',
  model: { provider: 'provider_a', model: 'model_x' },
  promptVersion: 'prompt-v1',
  limits: { maxUploadBytes: 1, maxImageBytes: 1, maxJsonBytes: 1, maxPages: 1 },
  modelCatalogue: [
    {
      id: 'provider_a',
      title: '服务商 A',
      models: [
        { id: 'model_x', name: '模型 X' },
        { id: 'model_y', name: '模型 Y' },
      ],
    },
    { id: 'provider_b', title: '服务商 B', models: [{ id: 'model_z' }] },
  ],
}

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

function runningJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'proof_1',
    kind: 'proofread',
    status: 'running',
    progress: 0.5,
    stages: [
      { id: 'load', label: '读取文档与文章', status: 'done' },
      { id: 'a1:master', label: 'a1 · 通读主审', status: 'running' },
      { id: 'a1:words', label: 'a1 · 字词精校', status: 'pending' },
      { id: 'report', label: '生成报告', status: 'pending' },
    ],
    ...overrides,
  }
}

function doneJob(report: Report): JobView {
  return {
    id: report.jobId,
    kind: 'proofread',
    status: 'done',
    progress: 1,
    stages: [{ id: 'report', label: '生成报告', status: 'done' }],
    result: report,
  }
}

function failedJob(error = '模型调用超时'): JobView {
  return {
    id: 'proof_1',
    kind: 'proofread',
    status: 'failed',
    progress: 0.2,
    stages: [{ id: 'a1:master', label: 'a1 · 通读主审', status: 'failed', error }],
    error,
  }
}

/** A promise whose settlement the test controls. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function abortedError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/* ------------------------------------------------------------------------- */
/* Fake workbench API                                                         */
/* ------------------------------------------------------------------------- */

interface FakeApiOptions {
  articles?: Article[]
  proofSteps?: (JobView | ((signal?: AbortSignal) => Promise<JobView>))[]
  report?: Report
  meta?: MetaView
  settings?: SettingsView
  saveLayoutFails?: boolean
}

function makeFakeApi(options: FakeApiOptions = {}) {
  const articles = options.articles ?? [LEAD_ARTICLE, SECOND_ARTICLE]
  const report = options.report ?? REPORT
  const steps: (JobView | ((signal?: AbortSignal) => Promise<JobView>))[] = [
    ...(options.proofSteps ?? [runningJob(), doneJob(report)]),
  ]
  const layoutJob: JobView = {
    id: 'job_1',
    kind: 'layout',
    status: 'done',
    progress: 1,
    stages: [],
    result: { regions: [LEAD_REGION, SECOND_REGION], articles, warnings: [] },
  }
  const parsed = {
    widthPt: 1000,
    heightPt: 1000,
    textItems: [],
    lines: [TEXT_LINE],
    candidates: [CANDIDATE],
    pagePng: new Blob(['page'], { type: 'image/png' }),
    overlayPng: new Blob(['overlay'], { type: 'image/png' }),
  }
  const mocks = {
    parsePdfPage: vi.fn(async () => parsed),
    uploadDocument: vi.fn(async () => DOCUMENT),
    pageText: vi.fn(async () => {}),
    pageImage: vi.fn(async () => {}),
    pageOverlay: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ jobId: 'job_1' })),
    getJob: vi.fn(async (jobId: string, signal?: AbortSignal): Promise<JobView> => {
      if (jobId === 'job_1') return layoutJob
      if (steps.length === 0) return doneJob(report)
      const step = steps.length > 1 ? steps.shift()! : steps[0]!
      if (typeof step === 'function') return step(signal)
      return step
    }),
    cancelJob: vi.fn(async (_jobId: string, _signal?: AbortSignal) => {}),
    saveLayout: vi.fn(async (_docId: string, _layout: unknown) => {
      if (options.saveLayoutFails === true) throw new Error('layout save failed')
    }),
    proofread: vi.fn(async (_request: ProofreadRequest, _signal?: AbortSignal) => ({
      jobId: 'proof_1',
    })),
    getDocument: vi.fn(async (): Promise<DocumentView> => ({
      meta: { ...DOCUMENT, status: 'ready' as const },
      hasLayout: true,
      regions: [LEAD_REGION, SECOND_REGION],
      articles,
      lines: [TEXT_LINE],
      widthPt: 1000,
      heightPt: 1000,
      reportIds: [],
    })),
    getMeta: vi.fn(async (): Promise<MetaView> => options.meta ?? META),
    getSettings: vi.fn(async (): Promise<SettingsView> => options.settings ?? SETTINGS),
    saveSettings: vi.fn(async (_patch: unknown) => {}),
  }
  return { api: mocks as unknown as WorkbenchApi, mocks }
}

/* ------------------------------------------------------------------------- */
/* DOM helpers                                                                */
/* ------------------------------------------------------------------------- */

function phase(container: HTMLElement): string | null {
  return container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase') ?? null
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
}

/**
 * Activate the 校对 tab of the right column. Task 19b made the aside tabbed
 * (文章: article list + inspector, 校对: proofread controls + report), so the
 * proofread controls are only reachable from that tab.
 */
function openProofreadTab(container: HTMLElement): void {
  fireEvent.click(within(container).getByRole('tab', { name: '校对' }))
}

async function renderReady(
  fake = makeFakeApi(),
  appProps: Omit<ComponentProps<typeof App>, 'api' | 'name'> = {},
) {
  const view = render(
    <App
      name="Ling Gao 校对员"
      api={fake.api}
      saveDebounceMs={0}
      proofreadPollIntervalMs={0}
      {...appProps}
    />,
  )
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [pdfFile()] } })
  })
  await waitFor(() => expect(phase(view.container)).toBe('ready'))
  return { ...view, ...fake }
}

/** Select one article and press start (single selection → no whole-page confirm). */
async function startSingleArticle(container: HTMLElement, confirm = false): Promise<void> {
  fireEvent.click(checkboxes(container)[0]!)
  openProofreadTab(container)
  fireEvent.click(screen.getByRole('button', { name: '开始校对' }))
  if (confirm) fireEvent.click(screen.getByRole('button', { name: '确认开始' }))
}

function stubClipboard(): { writeText: ReturnType<typeof vi.fn>; restore: () => void } {
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return {
    writeText,
    restore: () => {
      delete (window.navigator as { clipboard?: unknown }).clipboard
    },
  }
}

/* ------------------------------------------------------------------------- */
/* ProofreadPanel                                                             */
/* ------------------------------------------------------------------------- */

describe('ProofreadPanel', () => {
  function renderPanel(overrides: Partial<ComponentProps<typeof ProofreadPanel>> = {}) {
    const handlers = {
      onDepthChange: vi.fn(),
      onFactCheckChange: vi.fn(),
      onStart: vi.fn(),
      onCancel: vi.fn(),
    }
    const props: ComponentProps<typeof ProofreadPanel> = {
      selectedCount: 0,
      depth: 'standard',
      factCheck: true,
      job: undefined,
      ...handlers,
      ...overrides,
    }
    const view = render(<ProofreadPanel {...props} />)
    return { ...view, ...handlers }
  }

  it('disables start with no selection', () => {
    renderPanel({ selectedCount: 0 })
    expect(
      (screen.getByRole('button', { name: /开始校对/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('starts when an article is selected, and reports depth/factCheck changes', () => {
    const { onStart, onDepthChange, onFactCheckChange } = renderPanel({ selectedCount: 1 })
    fireEvent.click(screen.getByRole('button', { name: /开始校对/ }))
    expect(onStart).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('radio', { name: '深度' }))
    expect(onDepthChange).toHaveBeenCalledWith('deep')
    fireEvent.click(screen.getByLabelText('联网事实核查'))
    expect(onFactCheckChange).toHaveBeenCalledWith(false)
  })

  it('shows the role-call estimate and confirms a whole-page run', () => {
    const onStart = vi.fn()
    renderPanel({ selectedCount: 2, articleCount: 2, onStart })

    expect(PROOFREAD_ROLE_COUNTS).toEqual({ quick: 4, standard: 7, deep: 8 })
    expect(estimateProofreadCalls(2, 'standard')).toBe(14)
    expect(screen.getByText(/预计模型调用 14 次/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '开始校对' }))
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getByText(/本页全部 2 篇文章/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认开始' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('warns about and requires a second confirmation when factCheck is off', () => {
    const onStart = vi.fn()
    renderPanel({ selectedCount: 1, factCheck: false, onStart })

    expect(screen.getByText(/本次报告不含联网核查/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '开始校对' }))
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getAllByText(/报告会标注“未联网核查”/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '确认开始' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('renders job progress and cancels a running job', () => {
    const { onCancel } = renderPanel({ selectedCount: 1, job: runningJob() })
    expect(screen.getByText('校对中')).toBeTruthy()
    expect(screen.getByText('a1 · 通读主审')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消校对' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(
      (screen.getByRole('button', { name: '开始校对' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */
/* JobProgress                                                                */
/* ------------------------------------------------------------------------- */

describe('JobProgress', () => {
  it('renders stages, statuses and the progress bar', () => {
    const { container } = render(<JobProgress job={runningJob()} />)
    expect(screen.getByText('校对中')).toBeTruthy()
    expect(screen.getByText('读取文档与文章')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getAllByText('等待中').length).toBeGreaterThan(0)
    const progress = container.querySelector('progress') as HTMLProgressElement
    expect(progress.value).toBe(50)
    expect(progress.getAttribute('aria-label')).toBe('校对进度')
  })

  it('shows a failed stage error', () => {
    render(
      <JobProgress
        job={runningJob({
          status: 'failed',
          error: '模型调用超时',
          stages: [
            { id: 'a1:facts', label: 'a1 · 事实核查', status: 'failed', error: '模型调用超时' },
          ],
        })}
      />,
    )
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0)
    expect(screen.getAllByText('模型调用超时').length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------------- */
/* FactCheckList                                                              */
/* ------------------------------------------------------------------------- */

describe('FactCheckList', () => {
  it('shows every verdict row including confirmed, unverified and not_checked', () => {
    render(
      <FactCheckList
        checks={[
          FACT_CONFIRMED,
          FACT_UNVERIFIED,
          FACT_NOT_CHECKED,
          {
            ...FACT_UNVERIFIED,
            id: 'a1:fc5',
            verdict: 'contradicted',
            claim: '有冲突的主张',
          },
          {
            ...FACT_UNVERIFIED,
            id: 'a1:fc6',
            verdict: 'insufficient',
            claim: '证据不足的主张',
          },
        ]}
      />,
    )
    expect(screen.getByText('事实核查清单')).toBeTruthy()
    expect(screen.getByText('已核实')).toBeTruthy()
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()
    expect(screen.getByText('有冲突')).toBeTruthy()
    expect(screen.getByText('证据不足')).toBeTruthy()
    // The confirmed row is never hidden, and its source stays a link.
    const link = screen.getByRole('link', { name: /示例来源/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com/source')
    expect(screen.getByText('2026年11月14日')).toBeTruthy()
    expect(screen.getByText('现场观众超过一万人')).toBeTruthy()
    expect(screen.getByText('主办方为示例单位')).toBeTruthy()
  })

  it('uses FactCheck.occurrence to distinguish repeated claims', () => {
    const { container } = render(<FactCheckList checks={[FACT_CONFIRMED, FACT_UNVERIFIED]} />)
    const rows = Array.from(container.querySelectorAll('[data-lgp-fact-id]'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-lgp-fact-occurrence')).toBe('1')
    expect(rows[1]!.getAttribute('data-lgp-fact-occurrence')).toBe('2')
    expect(screen.getByText('第 2 处')).toBeTruthy()
  })

  it('renders an explicit 未联网核查 marker and an empty state', () => {
    const { rerender } = render(
      <FactCheckList checks={[FACT_UNVERIFIED, FACT_NOT_CHECKED]} offline />,
    )
    expect(screen.getByText('未联网核查')).toBeTruthy()
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()

    rerender(<FactCheckList checks={[]} />)
    expect(screen.getByText('未发现可核查项。')).toBeTruthy()
  })

  it('uses the explicit factCheckMode instead of the call counters', () => {
    // Critical regression: the Host counts a search attempt before the call, so
    // `searchCalls > 0` must NOT override an explicit `unavailable`/`off` mode.
    expect(
      isOfflineFactCheck(UNAVAILABLE_REPORT.factChecks, UNAVAILABLE_REPORT.stats, 'unavailable'),
    ).toBe(true)
    expect(isOfflineFactCheck([FACT_CONFIRMED], REPORT.stats, 'off')).toBe(true)
    expect(
      isOfflineFactCheck(
        [FACT_UNVERIFIED],
        { calls: 0, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 0 },
        'on',
      ),
    ).toBe(false)

    // Only reports persisted before the field existed fall back to the heuristic.
    expect(isOfflineFactCheck(OFFLINE_REPORT.factChecks, OFFLINE_REPORT.stats)).toBe(true)
    expect(isOfflineFactCheck(REPORT.factChecks, REPORT.stats)).toBe(false)
    expect(isOfflineFactCheck([], REPORT.stats)).toBe(false)
  })
})

/* ------------------------------------------------------------------------- */
/* FindingCard                                                                */
/* ------------------------------------------------------------------------- */

describe('FindingCard', () => {
  it('renders severity/category badges, quote, issue, bold suggestion and sources', () => {
    render(<FindingCard finding={FINDING_MUST} />)
    const card = document.querySelector('[data-lgp-finding-id="a1:f1"]') as HTMLElement
    expect(card.getAttribute('data-lgp-severity')).toBe('must_fix')
    expect(card.getAttribute('data-lgp-category')).toBe('typo')
    expect(within(card).getByText('必改')).toBeTruthy()
    expect(within(card).getByText('错别字')).toBeTruthy()
    expect(within(card).getByText(/他的确/)).toBeTruthy()
    expect(within(card).getByText('问题：错别字')).toBeTruthy()
    const suggestion = card.querySelector('.lgp-finding-suggestion') as HTMLElement
    expect(suggestion.textContent).toBe('他确实')
    // An unmarked suggestion is the replacement text itself and stays bold.
    expect(suggestion.querySelector('strong')?.textContent).toBe('他确实')
    const link = within(card).getByRole('link', { name: '现代汉语词典' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com/dict')
  })

  it('marks needs-human findings and reports status changes', () => {
    const onStatusChange = vi.fn()
    render(
      <FindingCard finding={FINDING_SUGGESTED} onStatusChange={onStatusChange} />,
    )
    expect(screen.getByText('需人工确认')).toBeTruthy()
    expect(screen.getByText('第 1 处')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '接受' }))
    expect(onStatusChange).toHaveBeenCalledWith('a2:f1', 'accepted')
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    expect(onStatusChange).toHaveBeenCalledWith('a2:f1', 'rejected')
    fireEvent.click(screen.getByRole('button', { name: '待定' }))
    expect(onStatusChange).toHaveBeenCalledWith('a2:f1', 'deferred')
  })

  it('shows the finding status badge', () => {
    render(<FindingCard finding={{ ...FINDING_MUST, status: 'accepted' }} />)
    expect(screen.getByText('已接受')).toBeTruthy()
  })
})

/* ------------------------------------------------------------------------- */
/* ReportList filters                                                         */
/* ------------------------------------------------------------------------- */

describe('ReportList', () => {
  const ARTICLES = [LEAD_ARTICLE, SECOND_ARTICLE]

  function renderList(overrides: Partial<ComponentProps<typeof ReportList>> = {}) {
    const handlers = {
      onStatusChange: vi.fn(),
      onCopy: vi.fn(() => true),
      onExport: vi.fn(),
    }
    render(
      <ReportList
        findings={[FINDING_MUST, FINDING_SUGGESTED, FINDING_OPTIONAL]}
        articles={ARTICLES}
        exportHref="api/lgproofreader/export?job=proof_1&format=md"
        exportFileName="LingGao-proof_1.md"
        {...handlers}
        {...overrides}
      />,
    )
    return handlers
  }

  function visibleFindingIds(): string[] {
    return Array.from(document.querySelectorAll('[data-lgp-finding-id]')).map(
      (element) => element.getAttribute('data-lgp-finding-id') ?? '',
    )
  }

  it('groups findings by article and filters by severity', () => {
    renderList()
    expect(screen.getByRole('heading', { name: '头条新闻' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '二条新闻' })).toBeTruthy()
    expect(visibleFindingIds()).toEqual(['a1:f1', 'a2:f1', 'a2:f2'])

    fireEvent.change(screen.getByLabelText('按严重级别筛选'), { target: { value: 'suggested' } })
    expect(visibleFindingIds()).toEqual(['a2:f1'])
    expect(screen.getByText('显示 1/3 条')).toBeTruthy()
  })

  it('filters by category and by article', () => {
    renderList()
    fireEvent.change(screen.getByLabelText('按类别筛选'), { target: { value: 'headline' } })
    expect(visibleFindingIds()).toEqual(['a2:f1'])

    fireEvent.change(screen.getByLabelText('按类别筛选'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('按文章筛选'), { target: { value: 'a1' } })
    expect(visibleFindingIds()).toEqual(['a1:f1'])
  })

  it('exposes copy and export actions', () => {
    const { onCopy, onExport } = renderList()
    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }))
    expect(onCopy).toHaveBeenCalledTimes(1)

    const link = screen.getByRole('link', { name: '下载 Markdown' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('api/lgproofreader/export?job=proof_1&format=md')
    expect(link.getAttribute('download')).toContain('proof_1')
    // jsdom would try to navigate on the anchor click; suppress only the
    // default action so the React onClick hook is still exercised.
    const preventNavigation = (event: Event): void => event.preventDefault()
    link.addEventListener('click', preventNavigation)
    fireEvent.click(link)
    link.removeEventListener('click', preventNavigation)
    expect(onExport).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------- */
/* ReportView summary, facts and offline marker                               */
/* ------------------------------------------------------------------------- */

describe('ReportView', () => {
  function renderReport(overrides: Partial<ComponentProps<typeof ReportView>> = {}) {
    const handlers = {
      onStatusChange: vi.fn(),
      onCopy: vi.fn(() => true),
      onExport: vi.fn(),
    }
    const view = render(
      <ReportView report={REPORT} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} {...handlers} {...overrides} />,
    )
    return { ...view, ...handlers }
  }

  it('renders the summary counts, must-fix list, model, depth and timestamp', () => {
    const { container } = renderReport()
    const summary = container.querySelector('[data-lgp-report-summary]') as HTMLElement
    expect(summary.getAttribute('data-lgp-summary-must-fix')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-suggested')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-optional')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-confirmed')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-unverified')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-not-checked')).toBe('1')

    expect(screen.getByText('必须修改的条目')).toBeTruthy()
    expect(screen.getByText('《头条新闻》错别字：“他的确” → 他确实')).toBeTruthy()
    expect(screen.getByText(/deepseek-flash/)).toBeTruthy()
    expect(screen.getByText(/深度：标准/)).toBeTruthy()
    const time = container.querySelector('time') as HTMLTimeElement
    expect(time.getAttribute('datetime')).toBe(new Date(REPORT.createdAt).toISOString())
  })

  it('renders the fact checklist and forwards status changes', () => {
    const { onStatusChange } = renderReport()
    expect(screen.getByText('事实核查清单')).toBeTruthy()
    expect(screen.getByText('已核实')).toBeTruthy()
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '接受' })[0]!)
    expect(onStatusChange).toHaveBeenCalledWith('a1:f1', 'accepted')
  })

  it('shows the explicit 未联网核查 marker for an offline report', () => {
    renderReport({ report: OFFLINE_REPORT, offline: true })
    expect(screen.getByText('未联网核查')).toBeTruthy()
    // Unverified/not_checked rows are still listed, never hidden.
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()
  })

  it('derives the offline marker from the report stats when not told', () => {
    renderReport({ report: OFFLINE_REPORT })
    expect(screen.getByText('未联网核查')).toBeTruthy()
  })

  it('shows the marker for an unavailable-network report even with searchCalls > 0', () => {
    const { container } = renderReport({ report: UNAVAILABLE_REPORT })
    expect(screen.getByText('未联网核查')).toBeTruthy()
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()
    expect(
      container.querySelector('[data-lgp-offline="true"]'),
    ).toBeTruthy()
  })
})

/* ------------------------------------------------------------------------- */
/* SettingsDrawer                                                             */
/* ------------------------------------------------------------------------- */

describe('SettingsDrawer', () => {
  function renderDrawer(overrides: Partial<ComponentProps<typeof SettingsDrawer>> = {}) {
    const handlers = {
      onSave: vi.fn(async (_patch: unknown) => {}),
      onClose: vi.fn(),
    }
    const view = render(
      <SettingsDrawer settings={SETTINGS} catalogue={META.modelCatalogue} {...handlers} {...overrides} />,
    )
    return { ...view, ...handlers }
  }

  it('renders only runtime-effective settings and the /meta catalogue', () => {
    renderDrawer()
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(screen.getByLabelText('模型服务商')).toBeTruthy()
    expect(screen.getByLabelText('模型')).toBeTruthy()
    expect(screen.getByLabelText('默认校对深度')).toBeTruthy()
    expect(screen.getByLabelText('并发工作数')).toBeTruthy()
    expect(screen.getByLabelText('单次调用超时（秒）')).toBeTruthy()
    expect(screen.getByLabelText('联网事实核查')).toBeTruthy()

    const provider = screen.getByLabelText('模型服务商') as HTMLSelectElement
    expect(Array.from(provider.options).map((option) => option.value)).toEqual([
      'provider_a',
      'provider_b',
    ])
    const model = screen.getByLabelText('模型') as HTMLSelectElement
    expect(Array.from(model.options).map((option) => option.value)).toEqual([
      'model_x',
      'model_y',
    ])
    // Dead settings (no runtime effect yet) are not rendered at all.
    expect(screen.queryByText(/事实主张上限/)).toBeNull()
    expect(screen.queryByText(/搜索上限/)).toBeNull()
    expect(screen.queryByText(/包含报头报脚/)).toBeNull()
    expect(document.body.textContent).not.toContain('maxClaimsPerArticle')
  })

  it('saves exactly the runtime-effective patch', async () => {
    const { onSave } = renderDrawer()
    fireEvent.change(screen.getByLabelText('并发工作数'), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText('单次调用超时（秒）'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('默认校对深度'), { target: { value: 'quick' } })
    fireEvent.click(screen.getByLabelText('联网事实核查'))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]![0]).toEqual({
      provider: 'provider_a',
      model: 'model_x',
      depth: 'quick',
      factCheck: false,
      maxConcurrentWorkers: 6,
      perCallTimeoutMs: 120_000,
    })
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())
  })

  it('closes through the close button', () => {
    const { onClose } = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------- */
/* App integration                                                            */
/* ------------------------------------------------------------------------- */

describe('App proofreading integration', () => {
  it('never starts proofreading automatically and keeps start disabled without a selection', async () => {
    const fake = makeFakeApi()
    const { container, mocks } = await renderReady(fake)

    expect(phase(container)).toBe('ready')
    expect(container.querySelector('[data-lgp-slot="proofread-panel"]')).toBeTruthy()
    expect(mocks.proofread).not.toHaveBeenCalled()
    openProofreadTab(container)
    expect(
      (screen.getByRole('button', { name: '开始校对' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('starts only after confirmation with the selected article ids, depth and factCheck', async () => {
    const fake = makeFakeApi()
    const { container, mocks } = await renderReady(fake)

    fireEvent.click(screen.getByRole('button', { name: '本页全部' }))
    openProofreadTab(container)
    fireEvent.click(screen.getByRole('radio', { name: '深度' }))
    fireEvent.click(screen.getByLabelText('联网事实核查'))
    fireEvent.click(screen.getByRole('button', { name: '开始校对' }))
    // Whole page + offline: an explicit second confirmation is required.
    expect(mocks.proofread).not.toHaveBeenCalled()
    expect(screen.getByText(/本页全部 2 篇文章/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认开始' }))

    await waitFor(() => expect(mocks.proofread).toHaveBeenCalledTimes(1))
    expect(mocks.proofread.mock.calls[0]![0]).toEqual({
      docId: 'doc_1',
      articleIds: ['a1', 'a2'],
      depth: 'deep',
      factCheck: false,
    })
  })

  it('polls job progress and renders the report when the job finishes', async () => {
    const gate = deferred<JobView>()
    const fake = makeFakeApi({
      proofSteps: [
        runningJob(),
        (signal?: AbortSignal) =>
          new Promise<JobView>((resolve, reject) => {
            gate.promise.then(resolve, reject)
            signal?.addEventListener('abort', () => reject(abortedError()))
          }),
      ],
    })
    const { container } = await renderReady(fake)
    await startSingleArticle(container)

    await waitFor(() => expect(phase(container)).toBe('proofreading'))
    expect(screen.getByText('校对中')).toBeTruthy()
    const progress = container.querySelector('progress') as HTMLProgressElement
    expect(progress.value).toBe(50)

    await act(async () => {
      gate.resolve(doneJob(REPORT))
    })
    await waitFor(() => expect(phase(container)).toBe('report'))
    expect(screen.getByText('校对报告')).toBeTruthy()
    expect(screen.getByText('《头条新闻》错别字：“他的确” → 他确实')).toBeTruthy()
    expect(screen.getByText('事实核查清单')).toBeTruthy()
  })

  it('cancels a running proofread job and returns to ready', async () => {
    const fake = makeFakeApi({
      proofSteps: [
        runningJob(),
        (signal?: AbortSignal) =>
          new Promise<JobView>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(abortedError()))
          }),
      ],
    })
    const { container, mocks } = await renderReady(fake)
    await startSingleArticle(container)
    await waitFor(() => expect(phase(container)).toBe('proofreading'))

    fireEvent.click(screen.getByRole('button', { name: '取消校对' }))
    await waitFor(() => expect(mocks.cancelJob).toHaveBeenCalledWith('proof_1'))
    await waitFor(() => expect(phase(container)).toBe('ready'))
    expect(screen.getByText('校对已取消')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '开始校对' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    // A cancelled job never produces a report.
    expect(screen.queryByText('校对报告')).toBeNull()
  })

  it('shows the 未联网核查 marker when factCheck was off for the run', async () => {
    const fake = makeFakeApi({ proofSteps: [doneJob(OFFLINE_REPORT)] })
    const { container } = await renderReady(fake)

    fireEvent.click(checkboxes(container)[0]!)
    openProofreadTab(container)
    fireEvent.click(screen.getByLabelText('联网事实核查'))
    fireEvent.click(screen.getByRole('button', { name: '开始校对' }))
    fireEvent.click(screen.getByRole('button', { name: '确认开始' }))

    await waitFor(() => expect(phase(container)).toBe('report'))
    expect(screen.getByText('未联网核查')).toBeTruthy()
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()
  })

  it('shows the explicit marker for an unavailable-network report with search attempts', async () => {
    const fake = makeFakeApi({ proofSteps: [doneJob(UNAVAILABLE_REPORT)] })
    const { container } = await renderReady(fake)
    await startSingleArticle(container)

    await waitFor(() => expect(phase(container)).toBe('report'))
    expect(screen.getByText('未联网核查')).toBeTruthy()
  })

  it('keeps the document and retries proofreading after a failed job', async () => {
    const fake = makeFakeApi({ proofSteps: [failedJob(), doneJob(REPORT)] })
    const { container, mocks } = await renderReady(fake)
    await startSingleArticle(container)

    await waitFor(() => expect(screen.getByText(/校对失败/)).toBeTruthy())
    // The workbench stays usable: no upload failure panel, same document.
    expect(phase(container)).toBe('ready')
    expect(
      container.querySelector('[data-lgp-document-id]')?.getAttribute('data-lgp-document-id'),
    ).toBe('doc_1')
    expect(container.querySelector('[data-lgp-part="error"]')).toBeNull()
    expect(mocks.uploadDocument).toHaveBeenCalledTimes(1)
    // A possibly running Host job is cancelled before the error is surfaced.
    expect(mocks.cancelJob).toHaveBeenCalledWith('proof_1')

    fireEvent.click(screen.getByRole('button', { name: '重试校对' }))
    await waitFor(() => expect(mocks.proofread).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(phase(container)).toBe('report'))
    // Retry re-ran proofreading, never the upload flow.
    expect(mocks.uploadDocument).toHaveBeenCalledTimes(1)
    expect(screen.getByText('校对报告')).toBeTruthy()
  })

  it('surfaces a malformed report as a proofread error without losing the document', async () => {
    const malformed = { ...doneJob(REPORT), result: { findings: 'not-an-array' } } as JobView
    const fake = makeFakeApi({ proofSteps: [malformed] })
    const { container, mocks } = await renderReady(fake)
    await startSingleArticle(container)

    await waitFor(() => expect(screen.getByText(/校对失败/)).toBeTruthy())
    expect(screen.getByText(/校对报告缺少问题列表/)).toBeTruthy()
    expect(phase(container)).toBe('ready')
    expect(mocks.uploadDocument).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '重试校对' })).toBeTruthy()
  })

  it('cancels the Host job and keeps the document when polling fails terminally', async () => {
    const fake = makeFakeApi({
      proofSteps: [() => Promise.reject(new Error('network down'))],
    })
    const { container, mocks } = await renderReady(fake)
    await startSingleArticle(container)

    await waitFor(() => expect(screen.getByText(/校对失败/)).toBeTruthy(), {
      timeout: 3_000,
    })
    expect(mocks.cancelJob).toHaveBeenCalledWith('proof_1')
    expect(phase(container)).toBe('ready')
    expect(container.querySelector('[data-lgp-document-id]')).toBeTruthy()
    expect(mocks.uploadDocument).toHaveBeenCalledTimes(1)
  })

  it('seeds the start controls from persisted settings before any drawer open', async () => {
    const fake = makeFakeApi({ settings: { ...SETTINGS, depth: 'deep', factCheck: false } })
    const { container, mocks } = await renderReady(fake)
    openProofreadTab(container)

    await waitFor(() =>
      expect((screen.getByRole('radio', { name: '深度' }) as HTMLInputElement).checked).toBe(true),
    )
    const panelSwitch = container.querySelector(
      '.lgp-proof-panel [role="switch"]',
    ) as HTMLButtonElement
    expect(panelSwitch.getAttribute('aria-checked')).toBe('false')
    // Only `/settings` is seeded; `/meta` stays lazy for the drawer.
    expect(mocks.getSettings).toHaveBeenCalledTimes(1)
    expect(mocks.getMeta).not.toHaveBeenCalled()

    fireEvent.click(checkboxes(container)[0]!)
    fireEvent.click(screen.getByRole('button', { name: '开始校对' }))
    fireEvent.click(screen.getByRole('button', { name: '确认开始' }))
    await waitFor(() => expect(mocks.proofread).toHaveBeenCalledTimes(1))
    expect(mocks.proofread.mock.calls[0]![0]).toEqual({
      docId: 'doc_1',
      articleIds: ['a1'],
      depth: 'deep',
      factCheck: false,
    })
  })

  it('copies the rendered Markdown and links the GET /export download', async () => {
    const fake = makeFakeApi({ proofSteps: [doneJob(REPORT)] })
    const { container } = await renderReady(fake)
    await startSingleArticle(container)
    await waitFor(() => expect(phase(container)).toBe('report'))

    const clipboard = stubClipboard()
    try {
      fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }))
      await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
      const markdown = clipboard.writeText.mock.calls[0]![0] as string
      expect(markdown).toContain('# Ling Gao 校对员 · 校对报告')
      expect(markdown).toContain('“他的确”')
      expect(markdown).toContain('## 事实核查清单')
      expect(markdown).toContain('## 必须修改的条目')
      await waitFor(() => expect(screen.getByText('已复制')).toBeTruthy())
    } finally {
      clipboard.restore()
    }

    const link = screen.getByRole('link', { name: '下载 Markdown' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('api/lgproofreader/export?job=proof_1&format=md')
    expect(link.getAttribute('download')).toContain('proof_1')
  })

  it('loads /meta + /settings into the drawer and persists only effective settings', async () => {
    const fake = makeFakeApi()
    const { container, mocks } = await renderReady(fake)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))

    await waitFor(() => expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy())
    const drawer = screen.getByRole('dialog', { name: '设置' })
    await waitFor(() => expect(within(drawer).getByLabelText('并发工作数')).toBeTruthy())
    expect(mocks.getMeta).toHaveBeenCalledTimes(1)
    // One seed read when the document reached `ready`, one drawer read.
    expect(mocks.getSettings).toHaveBeenCalledTimes(2)

    fireEvent.change(within(drawer).getByLabelText('并发工作数'), { target: { value: '4' } })
    fireEvent.change(within(drawer).getByLabelText('单次调用超时（秒）'), {
      target: { value: '120' },
    })
    fireEvent.change(within(drawer).getByLabelText('默认校对深度'), {
      target: { value: 'quick' },
    })
    fireEvent.click(within(drawer).getByLabelText('联网事实核查'))
    fireEvent.click(within(drawer).getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1))
    expect(mocks.saveSettings.mock.calls[0]![0]).toEqual({
      provider: 'provider_a',
      model: 'model_x',
      depth: 'quick',
      factCheck: false,
      maxConcurrentWorkers: 4,
      perCallTimeoutMs: 120_000,
    })
    await waitFor(() => expect(within(drawer).getByText('已保存')).toBeTruthy())

    fireEvent.click(within(drawer).getByRole('button', { name: '关闭设置' }))
    // Saved defaults are applied to the panel's explicit start controls.
    openProofreadTab(container)
    expect((screen.getByRole('radio', { name: '快速' }) as HTMLInputElement).checked).toBe(true)
    const panelSwitch = container.querySelector(
      '.lgp-proof-panel [role="switch"]',
    ) as HTMLButtonElement
    expect(panelSwitch.getAttribute('aria-checked')).toBe('false')
  })

  it('does not start when the layout save flush fails', async () => {
    const fake = makeFakeApi({ saveLayoutFails: true })
    const { container, mocks } = await renderReady(fake)

    // Force a pending layout save so the proofread seam has to flush it first.
    fireEvent.click(screen.getByRole('button', { name: '编辑文章：头条新闻' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '改后标题' } })
    fireEvent.click(checkboxes(container)[0]!)
    openProofreadTab(container)
    fireEvent.click(screen.getByRole('button', { name: '开始校对' }))

    await waitFor(() => expect(screen.getByText(/无法开始校对/)).toBeTruthy())
    expect(mocks.proofread).not.toHaveBeenCalled()
  })

  it('reports an invalid finished job result instead of rendering a broken report', () => {
    expect(() => readProofreadReport(undefined)).toThrow(/报告/)
    expect(readProofreadReport(REPORT)).toEqual(REPORT)
  })
})

/* ------------------------------------------------------------------------- */
/* Real API seam: settings routes                                            */
/* ------------------------------------------------------------------------- */

describe('createWorkbenchApi settings routes', () => {
  it('maps /meta and /settings reads plus the settings patch onto exact routes', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init: init ?? {} })
      const method = init?.method ?? 'GET'
      const body = url.includes('/meta') ? META : method === 'GET' ? SETTINGS : { ok: true }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const api = createWorkbenchApi()
    await api.getMeta()
    await api.getSettings()
    await api.saveSettings({ depth: 'quick' })

    expect(calls.map((call) => call.url)).toEqual([
      'api/lgproofreader/meta',
      'api/lgproofreader/settings',
      'api/lgproofreader/settings',
    ])
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[1]!.init.method).toBe('GET')
    expect(calls[2]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ depth: 'quick' })
  })
})

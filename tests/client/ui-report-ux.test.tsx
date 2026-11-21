// @vitest-environment jsdom
/**
 * Report UX completion tests (Task 19b; design §9.2/§9.4).
 *
 * Covers the task's acceptance surface:
 * - `FindingCard`: confidence badge, `**…**` suggestion segments rendered as
 *   `<strong>` only on the marked parts (the whole suggestion is never stripped),
 *   the 定位 action, and the existing per-finding status actions;
 * - `ReportList`: severity/category/article filters kept, plus role/status/keyword
 *   filters, the two distinct empty states (no findings vs. no filter match) and
 *   per-finding checkboxes with 接受所选 / 全部接受 batch status updates;
 * - `ReportToolbar` / `ReportView`: Markdown AND JSON export links
 *   (`GET /export?job=<id>&format=md|json`), the summary fixes (involved-article
 *   count, unverified count, raw unknown-category labels) and zero findings;
 * - `App`: card → canvas locate (selected article + region, scroll + ~2 s pulse),
 *   the 文章 / 校对 tabs with preserved selection, the narrow-window drawer
 *   (accessible label, toggle, Escape close), batch-safe report status updates,
 *   and the no-auto-selection/no-auto-proofread regression;
 * - a11y/i18n: zh/en key parity of the new labels, tablist roles and that no
 *   primitives/Host/prompt import leaks into the report UI modules.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ComponentProps } from 'react'

vi.mock('../../src/client/assets', () => ({
  sidebarIcon: 'data:image/png;base64,AAA',
  wordmarkLight: 'light.png',
  wordmarkDark: 'dark.png',
}))

import { App, locateFinding, type WorkbenchApi } from '../../src/client/app'
import { FactCheckList } from '../../src/client/components/FactCheckList'
import { FindingCard, parseSuggestionSpans } from '../../src/client/components/FindingCard'
import { ProofreadPanel } from '../../src/client/components/ProofreadPanel'
import { ReportList } from '../../src/client/components/ReportList'
import { ReportToolbar } from '../../src/client/components/ReportToolbar'
import { ReportView } from '../../src/client/components/ReportView'
import { en, zh } from '../../src/client/locale'
import { clientStyles } from '../../src/client/styles'
import type {
  DocumentView,
  JobView,
  MetaView,
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
  ReportRoleFailure,
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
  text: '他的确来到了现场',
  bbox: { x: 10, y: 20, w: 120, h: 12 },
  fontSize: 12,
  fontWeight: 400,
  baseline: 20,
  column: 0,
}

const LINE_2: TextLine = { ...TEXT_LINE, id: 'l2', text: '二条正文内容' }
const LINE_3: TextLine = { ...TEXT_LINE, id: 'l3', text: '其他段落' }

const CANDIDATE: CandidateBlock = {
  candidateId: 'c1',
  bbox: { x: 10, y: 20, w: 40, h: 12 },
  lineIds: ['l1'],
  fontSizeBand: 'body',
  firstLineText: '他的确来到了现场',
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
  regionIds: ['r2', 'r3'],
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
  articleId: 'a1',
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const SECOND_REGION_A: Region = {
  id: 'r2',
  page: 1,
  kind: 'second',
  bbox: { x: 10, y: 120, w: 100, h: 60 },
  lineIds: ['l2'],
  articleId: 'a2',
  order: 1,
  confidence: 0.8,
  source: 'vision',
}

const SECOND_REGION_B: Region = {
  id: 'r3',
  page: 1,
  kind: 'article',
  bbox: { x: 10, y: 220, w: 100, h: 60 },
  lineIds: ['l3'],
  articleId: 'a2',
  order: 2,
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
  occurrence: 1,
  issue: '错别字',
  suggestion: '可改为**他确实**',
  reason: '“的确”是规范写法',
  confidence: 'high',
  needsHuman: false,
  roles: ['words', 'master'],
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
  confidence: 'medium',
  needsHuman: false,
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

/** Unknown category fixture: must render the raw label, never 错别字. */
const FINDING_UNKNOWN: Finding = {
  ...FINDING_SUGGESTED,
  id: 'a2:f3',
  category: 'style-guide' as Finding['category'],
  issue: 'AI 助手用词',
  quote: '智能工具',
  suggestion: 'AI 助手',
  roles: ['consistency' as string],
}

const FACT_UNVERIFIED: FactCheck = {
  id: 'a1:fc1',
  articleId: 'a1',
  claim: '现场游客超过一万人',
  quote: '现场秩序良好',
  kind: 'number',
  verdict: 'unverified',
  sources: [],
  confidence: 'low',
  needsHuman: true,
}

const SUMMARY: Report['summary'] = {
  mustFixCount: 1,
  suggestedCount: 1,
  optionalCount: 1,
  factCheck: { confirmed: 0, contradicted: 0, unverified: 1, insufficient: 0, notChecked: 0 },
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
  factChecks: [FACT_UNVERIFIED],
  stats: { calls: 3, failedCalls: 0, searchCalls: 1, fetchCalls: 1, elapsedMs: 1_000 },
}

const EMPTY_REPORT: Report = {
  ...REPORT,
  jobId: 'proof_empty',
  summary: {
    mustFixCount: 0,
    suggestedCount: 0,
    optionalCount: 0,
    factCheck: { confirmed: 0, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
    byCategory: {},
    mustFixList: [],
  },
  findings: [],
  factChecks: [],
}

/** Task 21f fixtures: roles that failed before producing any result. */
const FAILED_FACTS: ReportRoleFailure = {
  articleId: 'a2',
  role: 'facts',
  error: 'provider refused the request',
}
const FAILED_MASTER: ReportRoleFailure = {
  articleId: 'a1',
  role: 'master',
  error: 'provider refused the request',
}

/** One report carrying the given failed roles. */
function reportWithFailures(...failedRoles: ReportRoleFailure[]): Report {
  return { ...REPORT, failedRoles }
}

const META: MetaView = {
  version: '1.0.0',
  model: { provider: 'provider_a', model: 'model_x' },
  promptVersion: 'prompt-v1',
  limits: { maxUploadBytes: 1, maxImageBytes: 1, maxJsonBytes: 1, maxPages: 1 },
  modelCatalogue: [],
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

/* ------------------------------------------------------------------------- */
/* Fake workbench API                                                         */
/* ------------------------------------------------------------------------- */

interface FakeApiOptions {
  report?: Report
}

function makeFakeApi(options: FakeApiOptions = {}) {
  const report = options.report ?? REPORT
  const layoutJob: JobView = {
    id: 'job_1',
    kind: 'layout',
    status: 'done',
    progress: 1,
    stages: [],
    result: {
      regions: [LEAD_REGION, SECOND_REGION_A, SECOND_REGION_B],
      articles: [LEAD_ARTICLE, SECOND_ARTICLE],
      warnings: [],
    },
  }
  const parsed = {
    widthPt: 1000,
    heightPt: 1000,
    textItems: [],
    lines: [TEXT_LINE, LINE_2, LINE_3],
    candidates: [CANDIDATE],
    pagePng: new Blob(['page'], { type: 'image/png' }),
    overlayPng: new Blob(['overlay'], { type: 'image/png' }),
  }
  const doneReport: JobView = {
    id: report.jobId,
    kind: 'proofread',
    status: 'done',
    progress: 1,
    stages: [{ id: 'report', label: '生成报告', status: 'done' }],
    result: report,
  }
  const mocks = {
    parsePdfPage: vi.fn(async () => parsed),
    uploadDocument: vi.fn(async () => DOCUMENT),
    pageText: vi.fn(async () => {}),
    pageImage: vi.fn(async () => {}),
    pageOverlay: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ jobId: 'job_1' })),
    getJob: vi.fn(
      async (jobId: string): Promise<JobView> => (jobId === 'job_1' ? layoutJob : doneReport),
    ),
    cancelJob: vi.fn(async () => {}),
    saveLayout: vi.fn(async () => {}),
    proofread: vi.fn(async () => ({ jobId: 'proof_1' })),
    getDocument: vi.fn(
      async (): Promise<DocumentView> => ({
        meta: { ...DOCUMENT, status: 'ready' as const },
        hasLayout: true,
        regions: [LEAD_REGION, SECOND_REGION_A, SECOND_REGION_B],
        articles: [LEAD_ARTICLE, SECOND_ARTICLE],
        lines: [TEXT_LINE, LINE_2, LINE_3],
        widthPt: 1000,
        heightPt: 1000,
        reportIds: [],
      }),
    ),
    getMeta: vi.fn(async (): Promise<MetaView> => META),
    getSettings: vi.fn(async (): Promise<SettingsView> => SETTINGS),
    saveSettings: vi.fn(async () => {}),
  }
  return { api: mocks as unknown as WorkbenchApi, mocks }
}

/* ------------------------------------------------------------------------- */
/* DOM helpers                                                                */
/* ------------------------------------------------------------------------- */

function phase(container: HTMLElement): string | null {
  return container.querySelector('[data-lgp-phase]')?.getAttribute('data-lgp-phase') ?? null
}

function articleCheckboxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll('[data-lgp-article-id] input[type="checkbox"]'),
  ) as HTMLInputElement[]
}

function visibleFindingIds(): string[] {
  return Array.from(document.querySelectorAll('[data-lgp-finding-id]')).map(
    (element) => element.getAttribute('data-lgp-finding-id') ?? '',
  )
}

async function renderReady(fake = makeFakeApi()) {
  const view = render(
    <App
      name="Ling Gao 校对员"
      api={fake.api}
      saveDebounceMs={0}
      proofreadPollIntervalMs={0}
      locateHighlightMs={30}
    />,
  )
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [pdfFile()] } })
  })
  await waitFor(() => expect(phase(view.container)).toBe('ready'))
  return { ...view, ...fake }
}

function openTab(container: HTMLElement, name: '文章' | '校对'): void {
  fireEvent.click(within(container).getByRole('tab', { name }))
}

/** Select one article, switch to the 校对 tab and finish a scripted job. */
async function startProofreadToReport(container: HTMLElement): Promise<void> {
  fireEvent.click(articleCheckboxes(container)[0]!)
  openTab(container, '校对')
  fireEvent.click(within(container).getByRole('button', { name: '开始校对' }))
  await waitFor(() => expect(phase(container)).toBe('report'))
}

/* ------------------------------------------------------------------------- */
/* FindingCard: confidence, suggestion segments, locate                       */
/* ------------------------------------------------------------------------- */

describe('FindingCard details', () => {
  it('shows the localized confidence badge', () => {
    const { container } = render(<FindingCard finding={FINDING_MUST} />)
    const badge = container.querySelector('[data-lgp-confidence="high"]') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.textContent).toContain('置信度')
    expect(badge.textContent).toContain('高')

    cleanup()
    const medium = render(<FindingCard finding={FINDING_SUGGESTED} />)
    expect(
      medium.container.querySelector('[data-lgp-confidence="medium"]')?.textContent,
    ).toContain('置信度')
  })

  it('renders **…** suggestion markers as <strong> only on the marked segments', () => {
    const spans = parseSuggestionSpans('可改为**他确实**。')
    expect(spans).toEqual([
      { text: '可改为', strong: false },
      { text: '他确实', strong: true },
      { text: '。', strong: false },
    ])
    expect(parseSuggestionSpans('他确实')).toEqual([{ text: '他确实', strong: true }])
    expect(parseSuggestionSpans('**a** 和 **b**')).toEqual([
      { text: 'a', strong: true },
      { text: ' 和 ', strong: false },
      { text: 'b', strong: true },
    ])
    // An unmatched marker is kept literally instead of dropping text.
    expect(parseSuggestionSpans('**未闭合')).toEqual([{ text: '**未闭合', strong: false }])

    const { container } = render(<FindingCard finding={FINDING_MUST} />)
    const suggestion = container.querySelector('.lgp-finding-suggestion') as HTMLElement
    expect(suggestion.textContent).toBe('可改为他确实')
    const strongs = Array.from(suggestion.querySelectorAll('strong')).map(
      (node) => node.textContent,
    )
    expect(strongs).toEqual(['他确实'])
    // The unmarked prefix is not bold.
    expect(suggestion.querySelector('strong')?.textContent).not.toContain('可改为')
  })

  it('keeps unmarked suggestions bold as the changed replacement text', () => {
    const { container } = render(
      <FindingCard finding={{ ...FINDING_SUGGESTED, suggestion: '二条正文内容' }} />,
    )
    const suggestion = container.querySelector('.lgp-finding-suggestion') as HTMLElement
    expect(suggestion.textContent).toBe('二条正文内容')
    expect(suggestion.querySelector('strong')?.textContent).toBe('二条正文内容')
  })

  it('reports the 定位 action and keeps the status actions', () => {
    const onLocate = vi.fn()
    const onStatusChange = vi.fn()
    render(
      <FindingCard
        finding={FINDING_MUST}
        onLocate={onLocate}
        onStatusChange={onStatusChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '定位' }))
    expect(onLocate).toHaveBeenCalledWith(FINDING_MUST)
    fireEvent.click(screen.getByRole('button', { name: '接受' }))
    expect(onStatusChange).toHaveBeenCalledWith('a1:f1', 'accepted')
  })
})

/* ------------------------------------------------------------------------- */
/* ReportList: filters, empty states and batch accept                        */
/* ------------------------------------------------------------------------- */

describe('ReportList filters and batch actions', () => {
  const ARTICLES = [LEAD_ARTICLE, SECOND_ARTICLE]
  const FINDINGS = [FINDING_MUST, FINDING_SUGGESTED, FINDING_OPTIONAL, FINDING_UNKNOWN]

  function renderList(overrides: Partial<ComponentProps<typeof ReportList>> = {}) {
    const handlers = {
      onStatusChange: vi.fn(),
      onLocate: vi.fn(),
      onCopy: vi.fn(() => true),
      onExport: vi.fn(),
    }
    const view = render(
      <ReportList
        findings={FINDINGS}
        articles={ARTICLES}
        exportHref="api/lgproofreader/export?job=proof_1&format=md"
        exportJsonHref="api/lgproofreader/export?job=proof_1&format=json"
        {...handlers}
        {...overrides}
      />,
    )
    return { ...view, ...handlers }
  }

  function safeChange(label: string, value: string): void {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }

  it('keeps the severity/category/article filters', () => {
    renderList()
    expect(visibleFindingIds()).toEqual(['a1:f1', 'a2:f1', 'a2:f2', 'a2:f3'])
    safeChange('按严重级别筛选', 'suggested')
    expect(visibleFindingIds()).toEqual(['a2:f1', 'a2:f3'])
    safeChange('按严重级别筛选', '')
    safeChange('按类别筛选', 'format')
    expect(visibleFindingIds()).toEqual(['a2:f2'])
    safeChange('按类别筛选', '')
    safeChange('按文章筛选', 'a1')
    expect(visibleFindingIds()).toEqual(['a1:f1'])
  })

  it('filters by finding role', () => {
    renderList()
    safeChange('按角色筛选', 'headline')
    expect(visibleFindingIds()).toEqual(['a2:f1'])
    safeChange('按角色筛选', 'words')
    expect(visibleFindingIds()).toEqual(['a1:f1'])
  })

  it('filters by finding status', () => {
    renderList()
    safeChange('按状态筛选', 'deferred')
    expect(visibleFindingIds()).toEqual(['a2:f2'])
    safeChange('按状态筛选', 'open')
    expect(visibleFindingIds()).toEqual(['a1:f1', 'a2:f1', 'a2:f3'])
  })

  it('filters by keyword across issue/quote/suggestion, case-insensitively', () => {
    renderList()
    safeChange('按关键词筛选', '秩序')
    expect(visibleFindingIds()).toEqual(['a2:f2'])

    // `issue` matching and case-insensitive English matching.
    safeChange('按关键词筛选', 'ai')
    expect(visibleFindingIds()).toEqual(['a2:f3'])

    // `suggestion` matching (the suggestion of the unknown-category finding).
    safeChange('按关键词筛选', '助手')
    expect(visibleFindingIds()).toEqual(['a2:f3'])
  })

  it('distinguishes zero findings from a filtered-empty result', () => {
    const view = renderList()
    safeChange('按关键词筛选', '不存在的关键词')
    expect(screen.getByText('没有符合筛选条件的问题。')).toBeTruthy()
    expect(screen.queryByText('未发现问题。')).toBeNull()
    expect(screen.getByLabelText('按严重级别筛选')).toBeTruthy()
    view.unmount()

    cleanup()
    render(<ReportList findings={[]} articles={[]} />)
    expect(screen.getByText('未发现问题。')).toBeTruthy()
    // A report with no findings does not render the filter controls at all.
    expect(screen.queryByLabelText('按严重级别筛选')).toBeNull()
    expect(screen.queryByLabelText('按角色筛选')).toBeNull()
    expect(screen.queryByLabelText('按状态筛选')).toBeNull()
    expect(screen.queryByLabelText('按关键词筛选')).toBeNull()
  })

  it('batch-accepts the selected findings and resets the selection', () => {
    const { onStatusChange } = renderList()
    const checkboxes = screen.getAllByRole('checkbox')
    const acceptSelected = screen.getByRole('button', { name: '接受所选' }) as HTMLButtonElement
    const acceptAll = screen.getByRole('button', { name: '全部接受' }) as HTMLButtonElement
    expect(acceptSelected.disabled).toBe(true)
    expect(acceptAll.disabled).toBe(false)

    fireEvent.click(checkboxes[0]!)
    fireEvent.click(checkboxes[1]!)
    expect(screen.getByText('已选 2 条')).toBeTruthy()
    expect(acceptSelected.disabled).toBe(false)
    fireEvent.click(acceptSelected)

    expect(onStatusChange).toHaveBeenCalledTimes(2)
    expect(onStatusChange).toHaveBeenNthCalledWith(1, 'a1:f1', 'accepted')
    expect(onStatusChange).toHaveBeenNthCalledWith(2, 'a2:f1', 'accepted')
    expect(screen.getByText('已选 0 条')).toBeTruthy()
    expect(acceptSelected.disabled).toBe(true)
  })

  it('accepts every finding in the report at once (filters do not narrow it)', () => {
    const { onStatusChange } = renderList()
    safeChange('按状态筛选', 'open')
    expect(visibleFindingIds()).toEqual(['a1:f1', 'a2:f1', 'a2:f3'])
    fireEvent.click(screen.getByRole('button', { name: '全部接受' }))
    const ids = onStatusChange.mock.calls.map((call) => call[0])
    expect(ids).toEqual(['a1:f1', 'a2:f1', 'a2:f2', 'a2:f3'])
    for (const call of onStatusChange.mock.calls) expect(call[1]).toBe('accepted')
  })

  it('disables the batch actions without a status-change handler', () => {
    render(<ReportList findings={FINDINGS} articles={ARTICLES} />)
    expect(
      (screen.getByRole('button', { name: '接受所选' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: '全部接受' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

/* ------------------------------------------------------------------------- */
/* Export links                                                               */
/* ------------------------------------------------------------------------- */

describe('report export links', () => {
  it('renders Markdown and JSON download links that carry the job id', () => {
    render(
      <ReportToolbar
        onCopy={vi.fn(() => true)}
        exportHref="api/lgproofreader/export?job=proof_1&format=md"
        exportFileName="LingGao-proof_1.md"
        exportJsonHref="api/lgproofreader/export?job=proof_1&format=json"
        exportJsonFileName="LingGao-proof_1.json"
      />,
    )
    const markdown = screen.getByRole('link', { name: '下载 Markdown' }) as HTMLAnchorElement
    expect(markdown.getAttribute('href')).toBe(
      'api/lgproofreader/export?job=proof_1&format=md',
    )
    expect(markdown.getAttribute('download')).toBe('LingGao-proof_1.md')
    const json = screen.getByRole('link', { name: '下载 JSON' }) as HTMLAnchorElement
    expect(json.getAttribute('href')).toBe('api/lgproofreader/export?job=proof_1&format=json')
    expect(json.getAttribute('download')).toBe('LingGao-proof_1.json')
  })

  it('wires both export URLs into ReportView for the report job id', () => {
    render(<ReportView report={REPORT} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} />)
    const markdown = screen.getByRole('link', { name: '下载 Markdown' }) as HTMLAnchorElement
    const json = screen.getByRole('link', { name: '下载 JSON' }) as HTMLAnchorElement
    expect(markdown.getAttribute('href')).toBe(
      'api/lgproofreader/export?job=proof_1&format=md',
    )
    expect(json.getAttribute('href')).toBe(
      'api/lgproofreader/export?job=proof_1&format=json',
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Report summary and zero findings                                           */
/* ------------------------------------------------------------------------- */

describe('ReportView summary fixes', () => {
  it('shows the involved-article count and the unverified count', () => {
    const { container } = render(
      <ReportView report={REPORT} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} />,
    )
    const summary = container.querySelector('[data-lgp-report-summary]') as HTMLElement
    expect(summary.getAttribute('data-lgp-summary-articles')).toBe('2')
    expect(summary.textContent).toContain('涉及文章')
    expect(summary.textContent).toContain('未核实')
    expect(summary.getAttribute('data-lgp-summary-must-fix')).toBe('1')
    // Existing severity counts survive.
    expect(summary.textContent).toContain('必改')
    expect(screen.getByText('必须修改的条目')).toBeTruthy()
  })

  it('falls back to the raw label for an unknown category', () => {
    const report: Report = {
      ...REPORT,
      findings: [...REPORT.findings, FINDING_UNKNOWN],
      summary: { ...SUMMARY, byCategory: { ...SUMMARY.byCategory, 'style-guide': 1 } },
    }
    const { container } = render(
      <ReportView report={report} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} />,
    )
    const chips = Array.from(container.querySelectorAll('.lgp-summary-category'))
    const unknownChip = chips.find((chip) => chip.textContent?.includes('style-guide'))
    expect(unknownChip).toBeTruthy()
    expect(unknownChip?.textContent).not.toContain('错别字')

    const card = container.querySelector('[data-lgp-finding-id="a2:f3"]') as HTMLElement
    expect(within(card).getByText('style-guide')).toBeTruthy()
  })

  it('renders 未发现问题 with no filters for a zero-finding report', () => {
    const view = render(
      <ReportView report={EMPTY_REPORT} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} />,
    )
    expect(screen.getByText('未发现问题。')).toBeTruthy()
    expect(screen.getByText('无必须修改的条目。')).toBeTruthy()
    expect(screen.queryByLabelText('按严重级别筛选')).toBeNull()
    expect(screen.queryByLabelText('按角色筛选')).toBeNull()
    expect(view.container.querySelectorAll('[data-lgp-finding-id]').length).toBe(0)
  })
})

/* ------------------------------------------------------------------------- */
/* Failed roles (Task 21f)                                                    */
/* ------------------------------------------------------------------------- */

describe('failed roles', () => {
  it('shows a prominent warning block in ReportView with article, role and error', () => {
    const { container } = render(
      <ReportView report={reportWithFailures(FAILED_FACTS)} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} />,
    )
    const warning = container.querySelector('[data-lgp-failed-roles="true"]') as HTMLElement
    expect(warning).toBeTruthy()
    expect(warning.getAttribute('role')).toBe('alert')
    expect(warning.textContent).toContain('未完成角色')
    expect(warning.textContent).toContain('二条新闻')
    expect(warning.textContent).toContain('事实')
    expect(warning.textContent).toContain('provider refused the request')
    expect(warning.textContent).toContain('不能视为已检查')
    // The fact checklist owns the facts-specific “not checked, not no claims” text.
    const factsNotice = container.querySelector('[data-lgp-fact-failed="true"]') as HTMLElement
    expect(factsNotice.textContent).toContain('不能视为未发现可核查项')
  })

  it('shows no failed-role warning for a report without failedRoles (no inference)', () => {
    const { container } = render(
      <ReportView report={REPORT} articles={[LEAD_ARTICLE, SECOND_ARTICLE]} />,
    )
    expect(container.querySelector('[data-lgp-failed-roles]')).toBeNull()
  })

  it('FactCheckList replaces the 未发现可核查项 empty state when facts failed', () => {
    render(
      <FactCheckList
        checks={[]}
        failedRoles={[FAILED_FACTS]}
        articles={[LEAD_ARTICLE, SECOND_ARTICLE]}
      />,
    )
    expect(screen.getByText('事实核查角色未完成，不能视为未发现可核查项。')).toBeTruthy()
    const warning = document.querySelector('[data-lgp-fact-failed="true"]') as HTMLElement
    expect(warning).toBeTruthy()
    expect(warning.textContent).toContain('二条新闻')
    expect(warning.textContent).toContain('事实')
    expect(warning.textContent).toContain('provider refused the request')
    expect(screen.queryByText('未发现可核查项。')).toBeNull()
  })

  it('FactCheckList keeps the normal empty state without failed roles', () => {
    render(<FactCheckList checks={[]} />)
    expect(screen.getByText('未发现可核查项。')).toBeTruthy()
    expect(document.querySelector('[data-lgp-fact-failed]')).toBeNull()
  })

  it('FactCheckList keeps the normal empty state when only another role failed', () => {
    render(<FactCheckList checks={[]} failedRoles={[FAILED_MASTER]} />)
    expect(screen.getByText('未发现可核查项。')).toBeTruthy()
    expect(document.querySelector('[data-lgp-fact-failed]')).toBeNull()
  })

  it('FactCheckList still lists finished checks when facts failed for one article', () => {
    render(
      <FactCheckList
        checks={[FACT_UNVERIFIED]}
        failedRoles={[FAILED_FACTS]}
        articles={[LEAD_ARTICLE, SECOND_ARTICLE]}
      />,
    )
    expect(screen.getByText('现场游客超过一万人')).toBeTruthy()
    expect(document.querySelector('[data-lgp-fact-failed="true"]')).toBeTruthy()
  })

  it('ProofreadPanel warns about failed roles above the controls', () => {
    render(
      <ProofreadPanel
        selectedCount={0}
        depth="standard"
        factCheck={true}
        onDepthChange={vi.fn()}
        onFactCheckChange={vi.fn()}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        failedRoles={[FAILED_FACTS, FAILED_MASTER]}
      />,
    )
    const warning = document.querySelector('[data-lgp-proof-failed-roles="true"]') as HTMLElement
    expect(warning).toBeTruthy()
    expect(warning.getAttribute('role')).toBe('alert')
    expect(warning.textContent).toContain('未完成')
    expect(warning.textContent).toContain('a2')
    expect(warning.textContent).toContain('事实')
    expect(warning.textContent).toContain('provider refused the request')
  })

  it('App surfaces the report failed roles in both the panel and the report view', async () => {
    const fake = makeFakeApi({ report: reportWithFailures(FAILED_FACTS) })
    const { container } = await renderReady(fake)
    await startProofreadToReport(container)
    expect(container.querySelector('[data-lgp-failed-roles="true"]')).toBeTruthy()
    expect(container.querySelector('[data-lgp-fact-failed="true"]')).toBeTruthy()
    expect(container.querySelector('[data-lgp-proof-failed-roles="true"]')).toBeTruthy()
    expect(screen.getAllByText(/provider refused the request/).length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------------- */
/* App integration: tabs, drawer, locate, batch-safe statuses                */
/* ------------------------------------------------------------------------- */

describe('App tabs and narrow drawer', () => {
  it('switches between the 文章 and 校对 tabs and preserves the selection', async () => {
    const { container } = await renderReady()
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement
    expect(tablist).toBeTruthy()
    expect(tablist.getAttribute('aria-label')).toBeTruthy()

    const articlesTab = within(container).getByRole('tab', { name: '文章' })
    const proofreadTab = within(container).getByRole('tab', { name: '校对' })
    expect(articlesTab.getAttribute('aria-selected')).toBe('true')
    expect(proofreadTab.getAttribute('aria-selected')).toBe('false')

    // Default tab shows the article list; proofread controls live in 校对.
    expect(
      container.querySelector('[data-lgp-tab-panel="articles"]')?.hasAttribute('hidden'),
    ).toBe(false)
    expect(
      container.querySelector('[data-lgp-tab-panel="proofread"]')?.hasAttribute('hidden'),
    ).toBe(true)

    fireEvent.click(articleCheckboxes(container)[0]!)
    openTab(container, '校对')
    expect(proofreadTab.getAttribute('aria-selected')).toBe('true')
    expect(
      container.querySelector('[data-lgp-tab-panel="proofread"]')?.hasAttribute('hidden'),
    ).toBe(false)
    expect(
      container.querySelector('[data-lgp-tab-panel="articles"]')?.hasAttribute('hidden'),
    ).toBe(true)

    openTab(container, '文章')
    expect(articleCheckboxes(container)[0]!.checked).toBe(true)

    // WAI-ARIA tablist keyboard navigation (ArrowRight moves to the next tab).
    fireEvent.keyDown(articlesTab, { key: 'ArrowRight' })
    expect(proofreadTab.getAttribute('aria-selected')).toBe('true')
    expect(articlesTab.getAttribute('aria-selected')).toBe('false')
    fireEvent.keyDown(proofreadTab, { key: 'ArrowRight' })
    expect(articlesTab.getAttribute('aria-selected')).toBe('true')
  })

  it('toggles the drawer with an accessible label and closes on Escape', async () => {
    const { container } = await renderReady()
    const aside = container.querySelector('aside') as HTMLElement
    expect(aside).toBeTruthy()
    expect(aside.getAttribute('aria-label')).toBeTruthy()
    expect(aside.getAttribute('data-lgp-drawer-open')).toBe('false')

    const toggle = within(container).getByRole('button', {
      name: '打开或关闭文章与校对侧栏',
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(aside.getAttribute('data-lgp-drawer-open')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(aside.getAttribute('data-lgp-drawer-open')).toBe('false')

    fireEvent.click(toggle)
    fireEvent.click(within(container).getByRole('button', { name: '关闭侧栏' }))
    expect(aside.getAttribute('data-lgp-drawer-open')).toBe('false')
  })

  it('never auto-selects articles or auto-starts proofreading', async () => {
    const { container, mocks } = await renderReady()
    expect(mocks.proofread).not.toHaveBeenCalled()
    for (const checkbox of articleCheckboxes(container)) expect(checkbox.checked).toBe(false)
    openTab(container, '校对')
    expect(
      (within(container).getByRole('button', { name: '开始校对' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    openTab(container, '文章')
    for (const checkbox of articleCheckboxes(container)) expect(checkbox.checked).toBe(false)
    expect(mocks.proofread).not.toHaveBeenCalled()
  })
})

describe('App report locate and batch status', () => {
  it('locates a finding on the canvas (article + region, scroll, pulse) without touching the report state', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const fake = makeFakeApi()
    const { container, mocks } = await renderReady(fake)
    await startProofreadToReport(container)
    expect(visibleFindingIds()).toEqual(['a1:f1', 'a2:f1', 'a2:f2'])

    const card = container.querySelector('[data-lgp-finding-id="a1:f1"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: '定位' }))

    // Selected article + region (the article has exactly one region).
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-lgp-article-id="a1"]')
          ?.getAttribute('data-lgp-article-selected'),
      ).toBe('true'),
    )
    const region = container.querySelector('[data-lgp-region-id="r1"]') as HTMLElement
    expect(region.getAttribute('aria-pressed')).toBe('true')
    expect(region.getAttribute('data-lgp-highlighted')).toBe('true')
    const located = container.querySelector('[data-lgp-locate-active="true"]') as HTMLElement
    expect(located).toBeTruthy()
    expect(located.textContent).toContain('已定位')
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())

    // The pulse is temporary (~2 s in production, 30 ms in this test).
    await waitFor(() =>
      expect(container.querySelector('[data-lgp-locate-active="true"]')).toBeNull(),
    )

    // The report itself is untouched: statuses and article text are unchanged.
    expect(card.getAttribute('data-lgp-status')).toBe('open')
    expect(mocks.saveLayout).not.toHaveBeenCalled()
  })

  it('accepts findings (single and batch) in report state only', async () => {
    const { container, mocks } = await renderReady()
    await startProofreadToReport(container)
    const firstCard = container.querySelector('[data-lgp-finding-id="a1:f1"]') as HTMLElement
    fireEvent.click(within(firstCard).getByRole('button', { name: '接受' }))
    expect(firstCard.getAttribute('data-lgp-status')).toBe('accepted')

    const checkboxes = within(container)
      .getAllByRole('checkbox')
      .filter((checkbox) => checkbox.classList.contains('lgp-finding-select'))
    expect(checkboxes.length).toBe(3)
    fireEvent.click(checkboxes[1]!)
    fireEvent.click(within(container).getByRole('button', { name: '接受所选' }))
    expect(
      container.querySelector('[data-lgp-finding-id="a2:f1"]')?.getAttribute('data-lgp-status'),
    ).toBe('accepted')
    // Accepting a suggestion never rewrites the article text / saves a layout.
    expect(mocks.saveLayout).not.toHaveBeenCalled()
    // Both export links are wired for the finished job.
    const json = within(container).getByRole('link', { name: '下载 JSON' }) as HTMLAnchorElement
    expect(json.getAttribute('href')).toBe('api/lgproofreader/export?job=proof_1&format=json')
    const markdown = within(container).getByRole('link', {
      name: '下载 Markdown',
    }) as HTMLAnchorElement
    expect(markdown.getAttribute('href')).toBe(
      'api/lgproofreader/export?job=proof_1&format=md',
    )
  })
})

/* ------------------------------------------------------------------------- */
/* locateFinding pure helper                                                  */
/* ------------------------------------------------------------------------- */

describe('locateFinding', () => {
  const articles = [LEAD_ARTICLE, SECOND_ARTICLE]
  const regions = [LEAD_REGION, SECOND_REGION_A, SECOND_REGION_B]
  const lines = [TEXT_LINE, LINE_2, LINE_3]

  it('uses the single region of the article', () => {
    expect(locateFinding(FINDING_MUST, articles, regions, lines)).toEqual({
      articleId: 'a1',
      articleTitle: '头条新闻',
      regionId: 'r1',
      regionIds: ['r1'],
    })
  })

  it('locates the quote inside a multi-region article', () => {
    expect(locateFinding(FINDING_SUGGESTED, articles, regions, lines)).toEqual({
      articleId: 'a2',
      articleTitle: '二条新闻',
      regionId: 'r2',
      regionIds: ['r2'],
    })
  })

  it('highlights every region when the quote cannot be located', () => {
    const finding: Finding = { ...FINDING_SUGGESTED, quote: '不存在的引用' }
    expect(locateFinding(finding, articles, regions, lines)).toEqual({
      articleId: 'a2',
      articleTitle: '二条新闻',
      regionId: null,
      regionIds: ['r2', 'r3'],
    })
  })

  it('returns null for an unknown article', () => {
    const finding: Finding = { ...FINDING_SUGGESTED, articleId: 'missing' }
    expect(locateFinding(finding, articles, regions, lines)).toBeNull()
  })
})

/* ------------------------------------------------------------------------- */
/* A11y / i18n / import hygiene                                               */
/* ------------------------------------------------------------------------- */

describe('report UX a11y and i18n', () => {
  const NEW_KEYS = [
    'tabs.articles',
    'tabs.proofread',
    'tabs.label',
    'aside.label',
    'aside.toggle',
    'aside.toggleLabel',
    'aside.close',
    'report.filter.role',
    'report.filter.status',
    'report.filter.keyword',
    'report.batch.selected',
    'report.batch.acceptSelected',
    'report.batch.acceptAll',
    'report.exportJson',
    'report.noFindings',
    'report.finding.locate',
    'report.confidence.high',
    'report.confidence.medium',
    'report.confidence.low',
    'report.role.master',
    'report.role.words',
    'report.role.idioms',
    'report.role.style',
    'report.role.facts',
    'report.role.nouns',
    'report.role.headline',
    'report.role.consistency',
    'report.role.consolidator',
    'report.locateNotice',
    'report.failedRoles.title',
    'report.failedRoles.detail',
    'report.failedRoles.noError',
    'report.fact.failedTitle',
    'report.fact.emptyFailed',
    'proof.failedRoles',
    'proof.failedRolesDetail',
  ]

  it('ships every new label in both zh and en', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    const zhDict = zh as Record<string, string>
    const enDict = en as Record<string, string>
    for (const key of NEW_KEYS) {
      expect(typeof zhDict[key]).toBe('string')
      expect(typeof enDict[key]).toBe('string')
      expect(zhDict[key]!.length).toBeGreaterThan(0)
      expect(enDict[key]!.length).toBeGreaterThan(0)
    }
    expect(zhDict['report.exportJson']).toBe('下载 JSON')
    expect(enDict['report.exportJson']).toBe('Download JSON')
    expect(zhDict['report.noFindings']).toBe('未发现问题。')
    expect(enDict['report.noFindings']).toBe('No issues found.')
    expect(zhDict['report.batch.acceptAll']).toBe('全部接受')
  })

  it('keeps report UI styles token-based with focus rings and reduced motion', () => {
    expect(clientStyles).toContain('.lgp-aside-tabs')
    expect(clientStyles).toContain('.lgp-aside-tab:focus-visible')
    expect(clientStyles).toContain('.lgp-report-batch')
    expect(clientStyles).toContain('.lgp-finding-select:focus-visible')
    expect(clientStyles).toContain('.lgp-report-input:focus-visible')
    expect(clientStyles).toContain('@media (max-width: 1199px)')
    expect(clientStyles).toContain('lgp-locate-pulse')
    expect(clientStyles).toContain('@media (prefers-reduced-motion: reduce)')
    const tokens = clientStyles.match(/--dsw-[a-z0-9-]+/g) ?? []
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token.startsWith('--dsw-alias-')).toBe(true)
  })

  it('does not import primitives, Host modules or prompt text', () => {
    const root = resolve(__dirname, '..', '..')
    const files = [
      'src/client/components/FindingCard.tsx',
      'src/client/components/ReportList.tsx',
      'src/client/components/ReportToolbar.tsx',
      'src/client/components/ReportView.tsx',
      'src/client/components/FactCheckList.tsx',
      'src/client/components/FailedRolesNotice.tsx',
      'src/client/components/ProofreadPanel.tsx',
      'src/client/app.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source).not.toContain('dsh-client-ui-primitives')
      expect(source).not.toMatch(/from ['"][^'"]*src\/host/)
      expect(source).not.toMatch(/from ['"][^'"]*prompts\//)
      expect(source).not.toContain('请担任新闻校对员')
      expect(source).not.toMatch(/system prompt/i)
    }
  })
})

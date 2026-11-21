// @vitest-environment jsdom
/**
 * Independent network noun-check UI (v1.0.0).
 *
 * Acceptance surface:
 * - `NounProgress` renders the live `job.nounProgress` plan: the summary line
 *   “需要核查 N 个名词 · 已检索 M 个 · 已核查 K 个”, phase and elapsed time, and
 *   the priority-ordered noun rows (kind/name/quote/status) in a capped,
 *   scrollable list; `total === 0` is an explicit valid empty plan and a failed
 *   noun role is never invented here;
 * - `JobProgress` renders the noun plan next to the existing fact-check plan
 *   without changing fact behaviour (either plan may be absent);
 * - `NounCheckList` renders the report section “名词核查” with counts, name,
 *   kind, quote, evidence, source links and the four existence statuses
 *   (exists=有网络收录, uncertain=证据不足, not_found=未找到, not_checked=未核查)
 *   plus the needs-human badge; it renders nothing without noun checks and never
 *   uses “不存在” wording;
 * - `ReportView` keeps the existing section order and appends the noun checklist
 *   after the fact checklist; the report summary carries the noun-check counts;
 * - `FailedRolesNotice` labels the `nouns` role as 名词核查;
 * - `ProofreadPanel` role counts include the new role (quick 5 / standard 8 /
 *   deep 9 including the consolidator), and the new copy ships in zh + en.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { JobProgress } from '../../src/client/components/JobProgress'
import { NounCheckList, sortNounChecksByPriority } from '../../src/client/components/NounCheckList'
import {
  NounProgress,
  formatNounElapsed,
  sortNounPlanItems,
} from '../../src/client/components/NounProgress'
import { FailedRolesNotice } from '../../src/client/components/FailedRolesNotice'
import {
  ProofreadPanel,
  PROOFREAD_ROLE_COUNTS,
  estimateProofreadCalls,
} from '../../src/client/components/ProofreadPanel'
import { ReportView } from '../../src/client/components/ReportView'
import { en, zh } from '../../src/client/locale'
import { clientStyles } from '../../src/client/styles'
import type { JobView } from '../../src/shared/api/protocol'
import type {
  FactCheckProgress,
  NounCheck,
  NounProgress as NounProgressData,
  NounProgressItem,
  Report,
} from '../../src/shared/types'

afterEach(cleanup)

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const START = 1_760_000_000_000
const NOW = START + 65_000

const ITEM_INSTITUTION: NounProgressItem = {
  id: 'a1:np1',
  articleId: 'a1',
  name: '复旦大学附属华山医院',
  quote: '在复旦大学附属华山医院举行',
  kind: 'institution',
  priority: 1,
  searched: true,
  status: 'checked',
  result: 'exists',
}

const ITEM_PRODUCT: NounProgressItem = {
  id: 'a1:np2',
  articleId: 'a1',
  name: '灵犀文档',
  quote: '灵犀文档正式发布',
  kind: 'product',
  priority: 2,
  searched: true,
  status: 'searching',
}

const ITEM_PLACE: NounProgressItem = {
  id: 'a1:np3',
  articleId: 'a1',
  name: '临港新片区',
  quote: '落地临港新片区',
  kind: 'place',
  priority: 3,
  searched: false,
  status: 'pending',
}

/** Deliberately unsorted: the component is expected to order by priority. */
const PLAN: NounProgressData = {
  total: 3,
  searched: 1,
  checked: 1,
  notChecked: 0,
  phase: 'searching',
  items: [ITEM_PLACE, ITEM_INSTITUTION, ITEM_PRODUCT],
  startedAt: START,
  softDeadlineAt: START + 60_000,
  hardDeadlineAt: START + 120_000,
}

function runningJob(options: {
  nounProgress?: NounProgressData
  factProgress?: FactCheckProgress
} = {}): JobView {
  return {
    id: 'proof_1',
    kind: 'proofread',
    status: 'running',
    progress: 0.5,
    stages: [
      { id: 'a1:nouns', label: 'a1 · 名词核查', status: 'running' },
      { id: 'a1:facts', label: 'a1 · 事实核查', status: 'running' },
    ],
    ...(options.factProgress === undefined ? {} : { factProgress: options.factProgress }),
    ...(options.nounProgress === undefined ? {} : { nounProgress: options.nounProgress }),
  }
}

function planItem(
  id: string,
  status: NounProgressItem['status'],
): NounProgressItem {
  return {
    id,
    articleId: 'a1',
    name: `名词 ${id}`,
    quote: `引用 ${id}`,
    kind: 'other',
    priority: 1,
    searched: false,
    status,
  }
}

/** One existence check; overrides carry the per-status fixture details. */
function nounCheck(
  id: string,
  name: string,
  status: NounCheck['status'],
  overrides: Partial<NounCheck> = {},
): NounCheck {
  return {
    id,
    articleId: 'a1',
    name,
    quote: `原文提到${name}`,
    kind: 'other',
    priority: 1,
    status,
    sources: [],
    confidence: 'low',
    needsHuman: false,
    ...overrides,
  }
}

const NOUN_EXISTS: NounCheck = nounCheck('a1:n1', '复旦大学附属华山医院', 'exists', {
  kind: 'institution',
  priority: 1,
  evidence: '医院官网与多家媒体报道了该活动',
  sources: [{ title: '医院官网', url: 'https://example.com/hospital' }],
  confidence: 'high',
})

const NOUN_UNCERTAIN: NounCheck = nounCheck('a1:n2', '灵犀文档', 'uncertain', {
  kind: 'product',
  priority: 2,
  evidence: '仅检索到一条二手转载',
  needsHuman: true,
})

const NOUN_NOT_FOUND: NounCheck = nounCheck('a1:n3', '临港新片区', 'not_found', {
  kind: 'place',
  priority: 3,
  evidence: '检索 5 个来源均未收录该名称',
})

const NOUN_NOT_CHECKED: NounCheck = nounCheck('a1:n4', '某专项计划', 'not_checked', {
  kind: 'project',
  priority: 4,
})

const NOUN_CHECKS: NounCheck[] = [
  NOUN_NOT_FOUND,
  NOUN_EXISTS,
  NOUN_UNCERTAIN,
  NOUN_NOT_CHECKED,
]

const BASE_SUMMARY: Report['summary'] = {
  mustFixCount: 0,
  suggestedCount: 0,
  optionalCount: 0,
  factCheck: { confirmed: 0, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
  byCategory: {},
  mustFixList: [],
}

const BASE_REPORT: Report = {
  jobId: 'proof_1',
  docId: 'doc_1',
  articleIds: ['a1'],
  createdAt: START,
  model: 'deepseek-flash',
  promptVersion: 'prompt-v1',
  depth: 'standard',
  summary: BASE_SUMMARY,
  findings: [],
  factChecks: [],
  stats: { calls: 0, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 0 },
}

/** A report that carries the independent noun checks and their summary counts. */
const REPORT_NOUNS: Report = {
  ...BASE_REPORT,
  summary: {
    ...BASE_SUMMARY,
    nounCheck: { exists: 1, uncertain: 1, notFound: 1, notChecked: 1 },
  },
  nounChecks: NOUN_CHECKS,
}

/* ------------------------------------------------------------------------- */
/* NounProgress: live plan                                                     */
/* ------------------------------------------------------------------------- */

describe('NounProgress live plan', () => {
  it('renders the summary, phase/elapsed and priority-ordered noun rows', () => {
    const { container } = render(<NounProgress progress={PLAN} now={NOW} />)

    const plan = container.querySelector('[data-lgp-part="noun-progress"]') as HTMLElement
    expect(plan).toBeTruthy()
    expect(plan.getAttribute('data-lgp-noun-plan-phase')).toBe('searching')
    expect(plan.getAttribute('data-lgp-noun-plan-total')).toBe('3')
    expect(within(plan).getByText('名词核查计划')).toBeTruthy()

    const summary = container.querySelector('[data-lgp-noun-plan-summary]') as HTMLElement
    expect(summary.textContent).toBe('需要核查 3 个名词 · 已检索 1 个 · 已核查 1 个')
    expect(summary.getAttribute('aria-live')).toBe('polite')

    expect(screen.getByText('阶段：检索中')).toBeTruthy()
    expect(screen.getByText('已耗时 1:05')).toBeTruthy()

    const list = container.querySelector('ol.lgp-noun-plan-list') as HTMLOListElement
    expect(list).toBeTruthy()
    const items = Array.from(list.querySelectorAll('[data-lgp-noun-plan-id]'))
    // Input order was 3-1-2; the plan must render by priority ascending.
    expect(items.map((item) => item.getAttribute('data-lgp-noun-plan-id'))).toEqual([
      'a1:np1',
      'a1:np2',
      'a1:np3',
    ])
    expect(items.map((item) => item.getAttribute('data-lgp-noun-plan-priority'))).toEqual([
      '1',
      '2',
      '3',
    ])

    const first = items[0] as HTMLElement
    expect(within(first).getByText('复旦大学附属华山医院')).toBeTruthy()
    expect(within(first).getByText('院校/院所')).toBeTruthy()
    expect(within(first).getByText('“在复旦大学附属华山医院举行”')).toBeTruthy()
    expect(within(first).getByText('优先级 1')).toBeTruthy()
    expect(within(first).getByText('已核查')).toBeTruthy()
    // The checked row also exposes its existence result.
    expect(within(first).getByText('有网络收录')).toBeTruthy()
    const second = items[1] as HTMLElement
    expect(within(second).getByText('检索中')).toBeTruthy()
    expect(within(items[2] as HTMLElement).getByText('待核查')).toBeTruthy()
  })

  it('updates counts and statuses on each poll without dropping rows', () => {
    const { container, rerender } = render(<NounProgress progress={PLAN} now={NOW} />)

    const updated: NounProgressData = {
      ...PLAN,
      phase: 'verifying',
      searched: 3,
      checked: 2,
      notChecked: 1,
      items: [
        { ...ITEM_INSTITUTION },
        { ...ITEM_PRODUCT, status: 'checked', result: 'not_found' },
        { ...ITEM_PLACE, searched: true, status: 'not_checked' },
      ],
    }
    rerender(<NounProgress progress={updated} now={NOW + 5_000} />)

    const summary = container.querySelector('[data-lgp-noun-plan-summary]') as HTMLElement
    expect(summary.textContent).toBe(
      '需要核查 3 个名词 · 已检索 3 个 · 已核查 2 个 · 未核查 1 个',
    )
    expect(screen.getByText('阶段：判定中')).toBeTruthy()
    expect(screen.getByText('已耗时 1:10')).toBeTruthy()

    const items = Array.from(container.querySelectorAll('[data-lgp-noun-plan-id]'))
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.getAttribute('data-lgp-noun-plan-id'))).toEqual([
      'a1:np1',
      'a1:np2',
      'a1:np3',
    ])
    expect(within(items[1] as HTMLElement).getByText('未找到')).toBeTruthy()
    expect(within(items[2] as HTMLElement).getByText('未核查')).toBeTruthy()
  })

  it('shows 未发现需要核查的名词 for total === 0 (a valid plan result)', () => {
    const empty: NounProgressData = {
      total: 0,
      searched: 0,
      checked: 0,
      notChecked: 0,
      phase: 'done',
      items: [],
    }
    const { container } = render(<NounProgress progress={empty} />)

    expect(screen.getByText('未发现需要核查的名词')).toBeTruthy()
    expect(container.querySelector('[data-lgp-noun-plan-id]')).toBeNull()
    expect(container.querySelector('ol.lgp-noun-plan-list')).toBeNull()
    // A failed noun role is not invented here: the generic notice owns it.
    expect(container.querySelector('[data-lgp-failed-roles]')).toBeNull()
    expect(container.querySelector('[data-lgp-part="failed-roles"]')).toBeNull()
  })

  it('labels every phase', () => {
    const done: NounProgressData = { ...PLAN, phase: 'done' }
    const { rerender } = render(<NounProgress progress={done} now={NOW} />)
    expect(screen.getByText('阶段：已完成')).toBeTruthy()
    rerender(<NounProgress progress={{ ...PLAN, phase: 'planning' }} now={NOW} />)
    expect(screen.getByText('阶段：规划中')).toBeTruthy()
    rerender(<NounProgress progress={{ ...PLAN, phase: 'searching' }} now={NOW} />)
    expect(screen.getByText('阶段：检索中')).toBeTruthy()
    rerender(<NounProgress progress={{ ...PLAN, phase: 'verifying' }} now={NOW} />)
    expect(screen.getByText('阶段：判定中')).toBeTruthy()
  })

  it('labels every item status', () => {
    const statuses: NounProgressItem['status'][] = [
      'pending',
      'searching',
      'searched',
      'verifying',
      'checked',
      'not_checked',
    ]
    const { container } = render(
      <NounProgress
        progress={{
          ...PLAN,
          phase: 'verifying',
          total: statuses.length,
          items: statuses.map((status, index) => planItem(`a1:np${index + 1}`, status)),
        }}
        now={NOW}
      />,
    )
    for (const label of ['待核查', '检索中', '已检索', '判定中', '已核查', '未核查']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(container.querySelectorAll('[data-lgp-noun-plan-id]')).toHaveLength(statuses.length)
  })

  it('formats elapsed durations defensively', () => {
    expect(formatNounElapsed(0)).toBe('0:00')
    expect(formatNounElapsed(8_000)).toBe('0:08')
    expect(formatNounElapsed(65_000)).toBe('1:05')
    expect(formatNounElapsed(3_665_000)).toBe('61:05')
    expect(formatNounElapsed(Number.NaN)).toBe('0:00')
    expect(formatNounElapsed(-5_000)).toBe('0:00')
  })

  it('sorts unprioritized plan rows last without mutating the input', () => {
    const rows = [
      { ...planItem('a', 'pending'), priority: Number.NaN },
      { ...planItem('b', 'pending'), priority: 2 },
      { ...planItem('c', 'pending'), priority: 1 },
      { ...planItem('d', 'pending'), priority: 2 },
    ]
    const order = sortNounPlanItems(rows).map((item) => item.id)
    expect(order).toEqual(['c', 'b', 'd', 'a'])
    expect(rows.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

/* ------------------------------------------------------------------------- */
/* JobProgress: noun plan alongside the fact plan                             */
/* ------------------------------------------------------------------------- */

describe('JobProgress nounProgress', () => {
  it('renders the noun plan alongside the fact-check plan', () => {
    const factProgress: FactCheckProgress = {
      total: 1,
      searched: 1,
      checked: 1,
      notChecked: 0,
      phase: 'done',
      items: [
        {
          id: 'a1:fc1',
          articleId: 'a1',
          claim: '现场游客超过一万人',
          quote: '现场游客超过一万人',
          kind: 'number',
          priority: 1,
          searched: true,
          status: 'checked',
          verdict: 'confirmed',
        },
      ],
    }
    const { container } = render(
      <JobProgress job={runningJob({ nounProgress: PLAN, factProgress })} />,
    )

    const fact = container.querySelector('[data-lgp-part="fact-progress"]') as HTMLElement
    const noun = container.querySelector('[data-lgp-part="noun-progress"]') as HTMLElement
    expect(fact).toBeTruthy()
    expect(noun).toBeTruthy()
    // Fact behaviour is untouched: the fact plan still renders first.
    expect(fact.compareDocumentPosition(noun) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(fact).getByText('事实核查计划')).toBeTruthy()
    expect(within(noun).getByText('名词核查计划')).toBeTruthy()
  })

  it('renders the noun plan when only nounProgress exists', () => {
    const { container } = render(<JobProgress job={runningJob({ nounProgress: PLAN })} />)
    expect(container.querySelector('[data-lgp-part="noun-progress"]')).toBeTruthy()
    expect(container.querySelector('[data-lgp-part="fact-progress"]')).toBeNull()
    expect(container.querySelector('[data-lgp-part="job-progress"]')).toBeTruthy()
  })

  it('renders no noun section when nounProgress is absent', () => {
    const { container } = render(<JobProgress job={runningJob()} />)
    expect(container.querySelector('[data-lgp-part="noun-progress"]')).toBeNull()
  })
})

/* ------------------------------------------------------------------------- */
/* NounCheckList: final report section                                        */
/* ------------------------------------------------------------------------- */

describe('NounCheckList report section', () => {
  it('renders every existence status with kind, quote, evidence and sources', () => {
    const { container } = render(<NounCheckList checks={NOUN_CHECKS} />)

    const section = container.querySelector('[data-lgp-part="noun-checklist"]') as HTMLElement
    expect(section).toBeTruthy()
    expect(screen.getByText('名词核查')).toBeTruthy()

    const counts = container.querySelector('[data-lgp-noun-counts]') as HTMLElement
    expect(counts.getAttribute('data-lgp-noun-count-total')).toBe('4')
    expect(counts.getAttribute('data-lgp-noun-count-exists')).toBe('1')
    expect(counts.getAttribute('data-lgp-noun-count-uncertain')).toBe('1')
    expect(counts.getAttribute('data-lgp-noun-count-not-found')).toBe('1')
    expect(counts.getAttribute('data-lgp-noun-count-not-checked')).toBe('1')
    expect(counts.textContent).toContain('共 4 个名词')
    expect(counts.textContent).toContain('未核查 1')

    const rows = Array.from(container.querySelectorAll('[data-lgp-noun-id]'))
    // Priority order despite the unsorted input; no row is dropped.
    expect(rows.map((row) => row.getAttribute('data-lgp-noun-id'))).toEqual([
      'a1:n1',
      'a1:n2',
      'a1:n3',
      'a1:n4',
    ])
    expect(rows.map((row) => row.getAttribute('data-lgp-noun-status'))).toEqual([
      'exists',
      'uncertain',
      'not_found',
      'not_checked',
    ])

    const existsRow = rows[0] as HTMLElement
    expect(within(existsRow).getByText('复旦大学附属华山医院')).toBeTruthy()
    expect(within(existsRow).getByText('院校/院所')).toBeTruthy()
    expect(within(existsRow).getByText('“原文提到复旦大学附属华山医院”')).toBeTruthy()
    expect(within(existsRow).getByText('有网络收录')).toBeTruthy()
    expect(within(existsRow).getByText('医院官网与多家媒体报道了该活动')).toBeTruthy()
    const link = within(existsRow).getByRole('link', { name: '来源：医院官网' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com/hospital')
    // The required labels are exactly the agreed wording.
    expect(within(rows[1] as HTMLElement).getByText('证据不足')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText('需人工确认')).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText('未找到')).toBeTruthy()
    expect(within(rows[3] as HTMLElement).getByText('未核查')).toBeTruthy()

    // “not_found means the current sources did not include it” — never “不存在”.
    expect(container.textContent).not.toContain('不存在')
    expect(container.querySelector('[data-lgp-noun-disclaimer]')).toBeTruthy()
  })

  it('renders nothing without noun checks (older reports stay unchanged)', () => {
    const empty = render(<NounCheckList checks={[]} />)
    expect(empty.container.querySelector('[data-lgp-part="noun-checklist"]')).toBeNull()
    empty.unmount()

    const missing = render(<NounCheckList />)
    expect(missing.container.querySelector('[data-lgp-part="noun-checklist"]')).toBeNull()
  })

  it('sorts by priority with unprioritized rows last and stable', () => {
    const checks = [
      { ...nounCheck('c', '无优先级一', 'uncertain'), priority: Number.NaN },
      { ...nounCheck('b', '第二优先', 'exists'), priority: 2 },
      { ...nounCheck('a', '第一优先', 'exists'), priority: 1 },
      { ...nounCheck('d', '无优先级二', 'not_found'), priority: Number.NaN },
    ]
    expect(sortNounChecksByPriority(checks).map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])

    render(<NounCheckList checks={checks} />)
    expect(
      Array.from(document.querySelectorAll('[data-lgp-noun-id]')).map((row) =>
        row.getAttribute('data-lgp-noun-id'),
      ),
    ).toEqual(['a', 'b', 'c', 'd'])
    // Every row stays visible, including the unprioritized ones.
    for (const name of ['无优先级一', '第二优先', '第一优先', '无优先级二']) {
      expect(screen.getByText(name)).toBeTruthy()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* ReportView integration                                                     */
/* ------------------------------------------------------------------------- */

describe('ReportView noun integration', () => {
  it('renders the noun checklist after the fact checklist and keeps the old order', () => {
    const { container } = render(<ReportView report={REPORT_NOUNS} />)

    const mustFix = container.querySelector('[data-lgp-must-fix-list="true"]') as HTMLElement
    const facts = container.querySelector('[data-lgp-part="fact-checklist"]') as HTMLElement
    const nouns = container.querySelector('[data-lgp-part="noun-checklist"]') as HTMLElement
    expect(mustFix).toBeTruthy()
    expect(facts).toBeTruthy()
    expect(nouns).toBeTruthy()
    // The pre-existing layout is preserved: must-fix summary before fact checklist.
    expect(
      mustFix.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // ... and the noun checklist is appended right after the fact checklist.
    expect(facts.compareDocumentPosition(nouns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(nouns).getByText('名词核查')).toBeTruthy()

    const summary = container.querySelector('[data-lgp-report-summary]') as HTMLElement
    expect(summary.getAttribute('data-lgp-summary-noun-exists')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-noun-uncertain')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-noun-not-found')).toBe('1')
    expect(summary.getAttribute('data-lgp-summary-noun-not-checked')).toBe('1')
    expect(summary.textContent).toContain('名词已收录')
    expect(summary.textContent).toContain('名词未找到')
  })

  it('keeps reports without noun checks unchanged', () => {
    const { container } = render(<ReportView report={BASE_REPORT} />)
    expect(container.querySelector('[data-lgp-part="noun-checklist"]')).toBeNull()
    const summary = container.querySelector('[data-lgp-report-summary]') as HTMLElement
    // Stable summary contract: the noun attributes default to 0, but no noun
    // summary card is rendered when the report has no noun-check summary.
    expect(summary.getAttribute('data-lgp-summary-noun-exists')).toBe('0')
    expect(summary.getAttribute('data-lgp-summary-noun-not-checked')).toBe('0')
    expect(summary.querySelector('[data-lgp-summary-item="noun_exists"]')).toBeNull()
    expect(screen.queryByText('名词已收录')).toBeNull()
  })

  it('shows a failed nouns role through the generic failed-role notice', () => {
    const report: Report = {
      ...BASE_REPORT,
      failedRoles: [{ articleId: 'a1', role: 'nouns', error: 'provider refused the request' }],
    }
    const { container } = render(<ReportView report={report} />)

    const warning = container.querySelector('[data-lgp-failed-roles="true"]') as HTMLElement
    expect(warning).toBeTruthy()
    expect(warning.textContent).toContain('名词核查')
    expect(warning.textContent).toContain('provider refused the request')
    // A failed role produces no results: no noun section is invented.
    expect(container.querySelector('[data-lgp-part="noun-checklist"]')).toBeNull()
  })

  it('FailedRolesNotice labels the nouns role as 名词核查', () => {
    render(
      <FailedRolesNotice
        failedRoles={[{ articleId: 'a1', role: 'nouns', error: 'timeout' }]}
      />,
    )
    expect(screen.getByText('名词核查')).toBeTruthy()
  })
})

/* ------------------------------------------------------------------------- */
/* Proofread role counts                                                      */
/* ------------------------------------------------------------------------- */

describe('proofread role counts include the nouns role', () => {
  it('counts the nouns worker in every depth preset', () => {
    expect(PROOFREAD_ROLE_COUNTS).toEqual({ quick: 5, standard: 8, deep: 9 })
    expect(estimateProofreadCalls(1, 'quick')).toBe(5)
    expect(estimateProofreadCalls(1, 'standard')).toBe(8)
    expect(estimateProofreadCalls(1, 'deep')).toBe(9)
  })

  it('shows the updated role count and call estimate in the panel hint', () => {
    render(
      <ProofreadPanel
        selectedCount={2}
        depth="standard"
        factCheck
        onDepthChange={() => {}}
        onFactCheckChange={() => {}}
        onStart={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/角色 8 个/)).toBeTruthy()
    expect(screen.getByText(/预计模型调用 16 次/)).toBeTruthy()
  })
})

/* ------------------------------------------------------------------------- */
/* Copy and styles                                                            */
/* ------------------------------------------------------------------------- */

describe('noun-check copy and styles', () => {
  const NEW_KEYS = [
    'noun.plan.title',
    'noun.plan.needed',
    'noun.plan.searched',
    'noun.plan.checked',
    'noun.plan.notChecked',
    'noun.plan.phase',
    'noun.plan.elapsed',
    'noun.plan.listLabel',
    'noun.plan.empty',
    'noun.phase.planning',
    'noun.phase.searching',
    'noun.phase.verifying',
    'noun.phase.done',
    'noun.status.pending',
    'noun.status.searching',
    'noun.status.searched',
    'noun.status.verifying',
    'noun.status.checked',
    'noun.status.not_checked',
    'noun.result.exists',
    'noun.result.uncertain',
    'noun.result.not_found',
    'noun.result.not_checked',
    'noun.kind.organization',
    'noun.kind.company',
    'noun.kind.institution',
    'noun.kind.place',
    'noun.kind.product',
    'noun.kind.system',
    'noun.kind.project',
    'noun.kind.event',
    'noun.kind.person',
    'noun.kind.title',
    'noun.kind.technical_term',
    'noun.kind.other',
    'report.role.nouns',
    'report.noun.title',
    'report.noun.total',
    'report.noun.exists',
    'report.noun.uncertain',
    'report.noun.notFound',
    'report.noun.notChecked',
    'report.noun.name',
    'report.noun.kind',
    'report.noun.quote',
    'report.noun.status',
    'report.noun.basis',
    'report.noun.disclaimer',
    'report.noun.summaryExists',
    'report.noun.summaryNotFound',
  ]

  it('ships every noun label in both zh and en', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    const zhDict = zh as Record<string, string>
    const enDict = en as Record<string, string>
    for (const key of NEW_KEYS) {
      expect(typeof zhDict[key]).toBe('string')
      expect(typeof enDict[key]).toBe('string')
      expect(zhDict[key]!.length).toBeGreaterThan(0)
      expect(enDict[key]!.length).toBeGreaterThan(0)
    }
    expect(zhDict['noun.plan.needed']).toBe('需要核查 {total} 个名词')
    expect(zhDict['noun.result.exists']).toBe('有网络收录')
    expect(zhDict['noun.result.uncertain']).toBe('证据不足')
    expect(zhDict['noun.result.not_found']).toBe('未找到')
    expect(zhDict['noun.result.not_checked']).toBe('未核查')
    expect(zhDict['report.role.nouns']).toBe('名词核查')
    expect(enDict['report.role.nouns']).toBe('Noun checks')
    expect(enDict['noun.result.not_found']).toBe('Not found')
  })

  it('never uses 不存在 wording in the noun copy', () => {
    const zhDict = zh as Record<string, string>
    for (const key of NEW_KEYS) {
      if (key.startsWith('noun.') || key.startsWith('report.noun.')) {
        expect(zhDict[key]).not.toContain('不存在')
      }
    }
  })

  it('styles the plan list as a capped, token-based scroll area', () => {
    expect(clientStyles).toContain('.lgp-noun-plan-list')
    expect(clientStyles).toMatch(/\.lgp-noun-plan-list\s*\{[^}]*max-height:\s*220px/)
    expect(clientStyles).toMatch(/\.lgp-noun-plan-list\s*\{[^}]*overflow:\s*auto/)
    expect(clientStyles).toContain('.lgp-noun-plan-status--checked')
    expect(clientStyles).toContain('.lgp-noun-plan-result--exists')
    const tokens = clientStyles.match(/--dsw-[a-z0-9-]+/g) ?? []
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token.startsWith('--dsw-alias-')).toBe(true)
  })

  it('styles the noun checklist with existence status colours', () => {
    expect(clientStyles).toContain('.lgp-nouns-table')
    expect(clientStyles).toContain('.lgp-noun-status--exists')
    expect(clientStyles).toContain('.lgp-noun-status--uncertain')
    expect(clientStyles).toContain('.lgp-noun-status--not_found')
    expect(clientStyles).toContain('.lgp-noun-status--not_checked')
    expect(clientStyles).toContain('.lgp-noun-disclaimer')
  })
})

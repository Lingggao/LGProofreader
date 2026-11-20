// @vitest-environment jsdom
/**
 * Exhaustive fact-check planning + live progress UI (Task 29).
 *
 * Acceptance surface:
 * - `JobProgress` renders the live `job.factProgress` plan (summary counts,
 *   phase, searched count, priority-ordered claim rows) and re-renders on each
 *   polled prop change without dropping items;
 * - the plan section announces its summary with `aria-live="polite"`, uses a
 *   semantic ordered list and shows 未发现可核查项 for `total === 0`;
 * - `FactProgress` labels every phase and item status;
 * - `FactCheckList` orders the final report rows by `priority` ascending
 *   (undefined last, input order kept) without dropping any row.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { FactProgress } from '../../src/client/components/FactProgress'
import { FactCheckList, sortFactChecksByPriority } from '../../src/client/components/FactCheckList'
import { JobProgress } from '../../src/client/components/JobProgress'
import { en, zh } from '../../src/client/locale'
import { clientStyles } from '../../src/client/styles'
import type { JobView } from '../../src/shared/api/protocol'
import type {
  FactCheck,
  FactCheckProgress,
  FactCheckProgressItem,
} from '../../src/shared/types'

afterEach(cleanup)

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const ITEM_DATE: FactCheckProgressItem = {
  id: 'a1:fc1',
  articleId: 'a1',
  claim: '2026年11月14日',
  quote: '2026年11月14日',
  kind: 'date',
  priority: 1,
  searched: true,
  status: 'checked',
  verdict: 'confirmed',
}

const ITEM_NUMBER: FactCheckProgressItem = {
  id: 'a1:fc2',
  articleId: 'a1',
  claim: '现场观众超过一万人',
  quote: '现场观众超过一万人',
  kind: 'number',
  priority: 2,
  searched: true,
  status: 'searching',
}

const ITEM_ORGANIZATION: FactCheckProgressItem = {
  id: 'a1:fc3',
  articleId: 'a1',
  claim: '主办方为示例单位',
  quote: '主办方为示例单位',
  kind: 'organization',
  priority: 3,
  searched: false,
  status: 'pending',
}

const PLAN: FactCheckProgress = {
  total: 3,
  searched: 1,
  checked: 1,
  notChecked: 0,
  phase: 'searching',
  items: [ITEM_DATE, ITEM_NUMBER, ITEM_ORGANIZATION],
  startedAt: 1_760_000_000_000,
  softDeadlineAt: 1_760_000_060_000,
  hardDeadlineAt: 1_760_000_120_000,
}

function runningJob(factProgress?: FactCheckProgress): JobView {
  return {
    id: 'proof_1',
    kind: 'proofread',
    status: 'running',
    progress: 0.5,
    stages: [{ id: 'a1:facts', label: 'a1 · 事实核查', status: 'running' }],
    ...(factProgress === undefined ? {} : { factProgress }),
  }
}

function check(id: string, claim: string, priority?: number): FactCheck {
  return {
    id,
    articleId: 'a1',
    claim,
    quote: claim,
    kind: 'other',
    verdict: 'unverified',
    sources: [],
    confidence: 'low',
    needsHuman: false,
    ...(priority === undefined ? {} : { priority }),
  }
}

function planItem(
  id: string,
  status: FactCheckProgressItem['status'],
): FactCheckProgressItem {
  return {
    id,
    articleId: 'a1',
    claim: `主张 ${id}`,
    quote: `主张 ${id}`,
    kind: 'other',
    priority: 1,
    searched: false,
    status,
  }
}

/* ------------------------------------------------------------------------- */
/* JobProgress: live fact-check plan                                          */
/* ------------------------------------------------------------------------- */

describe('JobProgress factProgress', () => {
  it('renders the summary, phase, searched count and priority-ordered claims', () => {
    const { container } = render(<JobProgress job={runningJob(PLAN)} />)

    const plan = container.querySelector('[data-lgp-part="fact-progress"]') as HTMLElement
    expect(plan).toBeTruthy()
    expect(within(plan).getByText('事实核查计划')).toBeTruthy()

    const summary = container.querySelector('[data-lgp-fact-plan-summary]') as HTMLElement
    expect(summary.textContent).toBe('需要核查 3 项 · 已核查 1 项')
    expect(summary.getAttribute('aria-live')).toBe('polite')

    expect(screen.getByText('阶段：检索中')).toBeTruthy()
    expect(within(plan).getByText(/已检索 1/)).toBeTruthy()

    const list = container.querySelector('ol.lgp-fact-plan-list') as HTMLOListElement
    expect(list).toBeTruthy()
    const items = Array.from(list.querySelectorAll('[data-lgp-fact-plan-id]'))
    expect(items.map((item) => item.getAttribute('data-lgp-fact-plan-id'))).toEqual([
      'a1:fc1',
      'a1:fc2',
      'a1:fc3',
    ])
    expect(items.map((item) => item.getAttribute('data-lgp-fact-plan-priority'))).toEqual([
      '1',
      '2',
      '3',
    ])

    const first = items[0] as HTMLElement
    expect(within(first).getByText('2026年11月14日')).toBeTruthy()
    expect(within(first).getByText('日期')).toBeTruthy()
    expect(within(first).getByText('优先级 1')).toBeTruthy()
    expect(within(first).getByText('已核查')).toBeTruthy()
    expect(within(items[1] as HTMLElement).getByText('检索中')).toBeTruthy()
    expect(within(items[2] as HTMLElement).getByText('待核查')).toBeTruthy()
  })

  it('updates counts and keeps every item when the polled props change', () => {
    const { container, rerender } = render(<JobProgress job={runningJob(PLAN)} />)

    const updated: FactCheckProgress = {
      ...PLAN,
      phase: 'verifying',
      searched: 3,
      checked: 2,
      notChecked: 1,
      items: [
        { ...ITEM_DATE },
        { ...ITEM_NUMBER, status: 'checked', verdict: 'contradicted' },
        { ...ITEM_ORGANIZATION, searched: true, status: 'not_checked' },
      ],
    }
    rerender(<JobProgress job={runningJob(updated)} />)

    const summary = container.querySelector('[data-lgp-fact-plan-summary]') as HTMLElement
    expect(summary.textContent).toBe('需要核查 3 项 · 已核查 2 项 · 未核查 1 项')
    expect(screen.getByText('阶段：核验中')).toBeTruthy()
    expect(screen.getByText(/已检索 3/)).toBeTruthy()

    const items = Array.from(container.querySelectorAll('[data-lgp-fact-plan-id]'))
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.getAttribute('data-lgp-fact-plan-id'))).toEqual([
      'a1:fc1',
      'a1:fc2',
      'a1:fc3',
    ])
    expect(within(items[1] as HTMLElement).getByText('已核查')).toBeTruthy()
    expect(within(items[2] as HTMLElement).getByText('未核查')).toBeTruthy()
  })

  it('shows 未发现可核查项 when the plan has no claims', () => {
    const empty: FactCheckProgress = {
      total: 0,
      searched: 0,
      checked: 0,
      notChecked: 0,
      phase: 'done',
      items: [],
    }
    const { container } = render(<JobProgress job={runningJob(empty)} />)

    expect(screen.getByText('未发现可核查项')).toBeTruthy()
    expect(container.querySelector('[data-lgp-fact-plan-id]')).toBeNull()
    expect(container.querySelector('ol.lgp-fact-plan-list')).toBeNull()
  })

  it('renders no plan section when factProgress is absent', () => {
    const { container } = render(<JobProgress job={runningJob()} />)
    expect(container.querySelector('[data-lgp-part="fact-progress"]')).toBeNull()
  })
})

/* ------------------------------------------------------------------------- */
/* FactProgress: phase and status labels                                      */
/* ------------------------------------------------------------------------- */

describe('FactProgress labels', () => {
  it('labels every phase', () => {
    const donePlan: FactCheckProgress = { ...PLAN, phase: 'done' }
    const { container, rerender } = render(<FactProgress progress={donePlan} />)
    expect(screen.getByText('阶段：已完成')).toBeTruthy()
    expect(container.querySelector('[data-lgp-fact-plan-summary]')).toBeTruthy()

    rerender(<FactProgress progress={{ ...PLAN, phase: 'planning' }} />)
    expect(screen.getByText('阶段：规划中')).toBeTruthy()
    rerender(<FactProgress progress={{ ...PLAN, phase: 'searching' }} />)
    expect(screen.getByText('阶段：检索中')).toBeTruthy()
    rerender(<FactProgress progress={{ ...PLAN, phase: 'verifying' }} />)
    expect(screen.getByText('阶段：核验中')).toBeTruthy()
  })

  it('labels every item status', () => {
    const statuses: FactCheckProgressItem['status'][] = [
      'pending',
      'searching',
      'searched',
      'verifying',
      'checked',
      'not_checked',
    ]
    const { container } = render(
      <FactProgress
        progress={{
          ...PLAN,
          phase: 'verifying',
          total: statuses.length,
          items: statuses.map((status, index) => planItem(`a1:fc${index + 1}`, status)),
        }}
      />,
    )
    for (const label of ['待核查', '检索中', '已检索', '核验中', '已核查', '未核查']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    const items = Array.from(container.querySelectorAll('[data-lgp-fact-plan-id]'))
    expect(items).toHaveLength(statuses.length)
  })
})

/* ------------------------------------------------------------------------- */
/* FactCheckList: final report priority order                                 */
/* ------------------------------------------------------------------------- */

describe('FactCheckList priority ordering', () => {
  it('sorts rows by priority ascending with unprioritized rows last and stable', () => {
    const checks = [
      check('a1:fc2', '无优先级一'),
      check('a1:fc3', '第二优先', 2),
      check('a1:fc1', '第一优先', 1),
      check('a1:fc4', '无优先级二'),
    ]

    expect(sortFactChecksByPriority(checks).map((row) => row.id)).toEqual([
      'a1:fc1',
      'a1:fc3',
      'a1:fc2',
      'a1:fc4',
    ])

    render(<FactCheckList checks={checks} />)
    const rows = Array.from(document.querySelectorAll('[data-lgp-fact-id]'))
    expect(rows.map((row) => row.getAttribute('data-lgp-fact-id'))).toEqual([
      'a1:fc1',
      'a1:fc3',
      'a1:fc2',
      'a1:fc4',
    ])
    // No row is dropped and every claim is still visible.
    expect(rows).toHaveLength(4)
    for (const claim of ['无优先级一', '第二优先', '第一优先', '无优先级二']) {
      expect(screen.getByText(claim)).toBeTruthy()
    }
    // The priority is shown subtly without adding a column.
    expect(screen.getByText('优先级 1')).toBeTruthy()
    expect(screen.getByText('优先级 2')).toBeTruthy()
  })

  it('keeps the input order when no row has a priority', () => {
    const checks = [check('a1:fc1', '甲'), check('a1:fc2', '乙'), check('a1:fc3', '丙')]
    render(<FactCheckList checks={checks} />)
    expect(
      Array.from(document.querySelectorAll('[data-lgp-fact-id]')).map((row) =>
        row.getAttribute('data-lgp-fact-id'),
      ),
    ).toEqual(['a1:fc1', 'a1:fc2', 'a1:fc3'])
    expect(document.querySelectorAll('thead th')).toHaveLength(5)
  })

  it('treats a non-finite priority as unprioritized', () => {
    const checks = [
      { ...check('a1:fc1', '坏优先级'), priority: Number.NaN },
      { ...check('a1:fc2', '有效优先级'), priority: 2 },
    ]
    expect(sortFactChecksByPriority(checks).map((row) => row.id)).toEqual([
      'a1:fc2',
      'a1:fc1',
    ])
  })
})

/* ------------------------------------------------------------------------- */
/* Copy and styles                                                            */
/* ------------------------------------------------------------------------- */

describe('fact-check plan copy and styles', () => {
  const NEW_KEYS = [
    'fact.plan.title',
    'fact.plan.needed',
    'fact.plan.checked',
    'fact.plan.notChecked',
    'fact.plan.phase',
    'fact.plan.searched',
    'fact.plan.listLabel',
    'fact.plan.empty',
    'fact.priority',
    'fact.phase.planning',
    'fact.phase.searching',
    'fact.phase.verifying',
    'fact.phase.done',
    'fact.status.pending',
    'fact.status.searching',
    'fact.status.searched',
    'fact.status.verifying',
    'fact.status.checked',
    'fact.status.not_checked',
  ]

  it('ships every plan label in both zh and en', () => {
    const zhDict = zh as Record<string, string>
    const enDict = en as Record<string, string>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of NEW_KEYS) {
      expect(typeof zhDict[key]).toBe('string')
      expect(typeof enDict[key]).toBe('string')
      expect(zhDict[key]!.length).toBeGreaterThan(0)
      expect(enDict[key]!.length).toBeGreaterThan(0)
    }
    expect(zhDict['fact.plan.needed']).toBe('需要核查 {total} 项')
    expect(enDict['fact.status.checked']).toBe('Checked')
  })

  it('styles the plan list as a capped, token-based scroll area', () => {
    expect(clientStyles).toContain('.lgp-fact-plan-list')
    expect(clientStyles).toMatch(/\.lgp-fact-plan-list\s*\{[^}]*max-height:\s*280px/)
    expect(clientStyles).toMatch(/\.lgp-fact-plan-list\s*\{[^}]*overflow:\s*auto/)
    expect(clientStyles).toContain('.lgp-fact-plan-status--checked')
    expect(clientStyles).toContain('.lgp-fact-priority')
    const tokens = clientStyles.match(/--dsw-[a-z0-9-]+/g) ?? []
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token.startsWith('--dsw-alias-')).toBe(true)
  })
})

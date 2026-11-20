// @vitest-environment jsdom
/** Region inspector close affordance (2026-11-19). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RegionInspector } from '../../src/client/components/RegionInspector'
import type { Region } from '../../src/shared/types'

afterEach(cleanup)

const REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'article',
  bbox: { x: 10, y: 20, w: 300, h: 200 },
  lineIds: [],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

describe('RegionInspector close', () => {
  it('renders a close control and reports onClose', () => {
    const onClose = vi.fn()
    render(
      <RegionInspector
        region={REGION}
        onChange={vi.fn()}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    )
    const close = screen.getByRole('button', { name: '关闭区域检查器' })
    expect(close.textContent).toContain('关闭')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not render a dead close control without a handler', () => {
    render(
      <RegionInspector
        region={REGION}
        onChange={vi.fn()}
        onMerge={vi.fn()}
        onSplit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '关闭区域检查器' })).toBeNull()
  })
})

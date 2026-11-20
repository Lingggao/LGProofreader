// @vitest-environment jsdom
/** Complete article text view (Task 28). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ArticleList } from '../../src/client/components/ArticleList'
import type { Article } from '../../src/shared/types'

afterEach(cleanup)

const ARTICLE: Article = {
  id: 'a1',
  page: 1,
  role: 'lead',
  title: '古寺赏枫记',
  subtitle: '京都访古',
  byline: '范慕尤',
  body: '从银阁到方丈东侧有一泓碧水。\n\n池畔遍植红枫青松。',
  regionIds: ['r1'],
  readingOrder: 1,
  confidence: 0.9,
  warnings: [],
}

describe('ArticleList complete text', () => {
  it('shows title, subtitle, byline and body in order in the editor', () => {
    const { container } = render(
      <ArticleList
        articles={[ARTICLE]}
        selectedIds={[]}
        onToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onClear={vi.fn()}
        onChangeArticle={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }))
    const fullText = container.querySelector('[data-lgp-article-fulltext="true"]')
    expect(fullText).not.toBeNull()
    const text = fullText?.textContent ?? ''
    expect(text).toContain('古寺赏枫记')
    expect(text).toContain('京都访古')
    expect(text).toContain('范慕尤')
    expect(text).toContain('从银阁到方丈东侧有一泓碧水。')
    expect(text.indexOf('古寺赏枫记')).toBeLessThan(text.indexOf('京都访古'))
    expect(text.indexOf('京都访古')).toBeLessThan(text.indexOf('范慕尤'))
    expect(text.indexOf('范慕尤')).toBeLessThan(text.indexOf('从银阁到方丈东侧'))
  })
})

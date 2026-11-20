import { describe, expect, it } from 'vitest'
import {
  buildCleanBody,
  cleanTextSpacing,
  isCjkOrPunctuation,
  renderArticleFullText,
  splitParagraphs,
} from '../../src/shared/text/clean'
import type { TextLine } from '../../src/shared/types'

const line = (id: string, text: string, x: number, y: number, fontSize = 10, column = 0): TextLine => ({
  id,
  text,
  bbox: { x, y, w: 200, h: fontSize },
  fontSize,
  fontWeight: 400,
  baseline: y,
  column,
})

describe('cleanTextSpacing', () => {
  it('removes PDF glyph spaces between Han characters', () => {
    expect(cleanTextSpacing('球 员 出 场 情 况 进 行 汇 总 并 分 析 。 如 果')).toBe(
      '球员出场情况进行汇总并分析。如果',
    )
  })

  it('removes spaces around digits, quotes and Latin/CJK boundaries', () => {
    expect(cleanTextSpacing('2024 年 第 1 季')).toBe('2024年第1季')
    expect(cleanTextSpacing('“ 出 场 大 户 ”杨 希')).toBe('“出场大户”杨希')
    expect(cleanTextSpacing('U21 球 员 和 U19 球 员')).toBe('U21球员和U19球员')
    expect(cleanTextSpacing('405.0% 和 774.9%')).toBe('405.0%和774.9%')
    expect(cleanTextSpacing('2003- 04年龄段')).toBe('2003-04年龄段')
    expect(cleanTextSpacing('17℃20℃3 4最高')).toBe('17℃20℃34最高')
    expect(cleanTextSpacing('17℃ 20℃ 3 4 最高')).toBe('17℃20℃34最高')
  })

  it('keeps spaces between Latin words and in English punctuation', () => {
    expect(cleanTextSpacing('the quick brown fox')).toBe('the quick brown fox')
    expect(cleanTextSpacing('Hello, world')).toBe('Hello, world')
    expect(cleanTextSpacing('APEC 2026 summit')).toBe('APEC 2026 summit')
  })

  it('collapses repeated whitespace and trims its ends', () => {
    expect(cleanTextSpacing('  A  B\tC  ')).toBe('A B C')
    expect(cleanTextSpacing('   ')).toBe('')
    expect(cleanTextSpacing('中 文')).toBe('中文')
    expect(cleanTextSpacing('中 文\n英 文')).toBe('中文英文')
  })

  it('recognises CJK punctuation and full-width forms', () => {
    expect(isCjkOrPunctuation('，')).toBe(true)
    expect(isCjkOrPunctuation('“')).toBe(true)
    expect(isCjkOrPunctuation('中')).toBe(true)
    expect(isCjkOrPunctuation('A')).toBe(false)
    expect(isCjkOrPunctuation('1')).toBe(false)
  })
})

describe('splitParagraphs', () => {
  it('starts a paragraph at an indented line and keeps columns as continuations', () => {
    const lines = [
      line('a', '第一段第一行', 50, 100),
      line('b', '第一段第二行', 50, 112),
      line('c', '第二段第一行', 68, 124),
      line('d', '第二段第二行', 50, 136),
    ]
    expect(splitParagraphs(lines).map((paragraph) => paragraph.map((entry) => entry.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('separates a larger heading from the body and does not drop lines', () => {
    const lines = [
      line('a', '第一段', 50, 100),
      line('b', '小标题', 50, 120, 16),
      line('c', '第二段', 50, 140),
    ]
    expect(splitParagraphs(lines).map((paragraph) => paragraph.map((entry) => entry.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ])
  })

  it('uses a new column baseline instead of treating the column reset as an indent', () => {
    const lines = [
      line('a', '左栏末尾', 50, 100, 10, 0),
      line('b', '右栏开头', 550, 100, 10, 1),
      line('c', '右栏第二行', 550, 112, 10, 1),
    ]
    expect(splitParagraphs(lines).map((paragraph) => paragraph.map((entry) => entry.id))).toEqual([
      ['a', 'b', 'c'],
    ])
  })
})

describe('buildCleanBody', () => {
  it('cleans each paragraph, drops indentation and separates paragraphs with a blank line', () => {
    const lines = [
      line('a', '第 一 段 第 一 行', 50, 100),
      line('b', '第 一 段 第 二 行', 50, 112),
      line('c', '第 二 段 第 一 行', 68, 124),
      line('d', '第 二 段 第 二 行', 50, 136),
    ]
    const body = buildCleanBody(lines, (paragraph) => paragraph.map((entry) => entry.text).join(''))
    expect(body).toBe('第一段第一行第一段第二行\n\n第二段第一行第二段第二行')
    expect(body).not.toContain('  ')
    expect(body.startsWith(' ')).toBe(false)
  })
})

describe('renderArticleFullText', () => {
  it('orders title, subtitle, byline and body with blank-line separators', () => {
    expect(
      renderArticleFullText({
        title: '古寺赏枫记',
        subtitle: '京都访古',
        byline: '范慕尤',
        body: '从银阁到方丈东侧有一泓碧水。\n\n池畔遍植红枫青松。',
      }),
    ).toBe('古寺赏枫记\n\n京都访古\n\n范慕尤\n\n从银阁到方丈东侧有一泓碧水。\n\n池畔遍植红枫青松。')
  })

  it('omits absent optional fields and trims empty parts', () => {
    expect(renderArticleFullText({ title: '标题', body: '正文' })).toBe('标题\n\n正文')
    expect(renderArticleFullText({ title: '', subtitle: ' ', body: '正文' })).toBe('正文')
  })
})

import type { TextLine } from '../types'

/**
 * Text cleanup for article text extracted from PDF pages.
 *
 * PDF.js exposes text runs, not sentences: many Chinese newspaper fonts are
 * encoded glyph-by-glyph, so the extracted text often contains spaces between
 * every Han character ("球 员 出 场"). Those spaces are layout artefacts, not
 * content. This module removes them while preserving the one place a space is
 * meaningful — between words of an English sentence or a multi-word foreign
 * name — and it reconstructs natural paragraphs from line geometry.
 *
 * All functions are pure and deterministic; they never read the clock or I/O.
 */

/**
 * Characters that belong to Chinese/CJK text or its punctuation/symbols.
 *
 * A space next to any of these is a layout artefact and is removed. The set
 * intentionally includes CJK punctuation, curly quotes, the ellipsis, em/en
 * dashes, the middle dot used in foreign names, and common full-width forms.
 */
const CJK_OR_PUNCT =
  /[\-\u00B7\u2010-\u201F\u2026\u2013\u2014\u2103\u2109\u2E80-\u2FFF\u3000-\u303F\u3040-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** True for a single CJK ideograph/punctuation/symbol character. */
export function isCjkOrPunctuation(char: string): boolean {
  return char !== '' && CJK_OR_PUNCT.test(char)
}

/** True for an ASCII/full-width decimal digit. */
function isDigit(char: string): boolean {
  return /[0-9０-９]/.test(char)
}

/**
 * Remove PDF text-layer spacing artefacts from one string.
 *
 * - whitespace runs collapse to one space or disappear at the ends;
 * - a space is removed when either neighbour is CJK text/punctuation, so
 *   `球 员`, `2024 年`, `“ 出 场 ”`, `U21 球 员` and `405.0% 和` all join;
 * - a single space is kept when both neighbours are non-CJK (English words,
 *   numbers/units, URLs), e.g. `the quick brown fox`, `Hello, world`;
 * - explicit newlines are treated as whitespace and collapsed. Callers that
 *   need paragraph breaks must split paragraphs before calling this.
 */
export function cleanTextSpacing(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  const chars = Array.from(text.replace(/\u00A0/g, ' '))
  let result = ''
  let pendingSpace = false

  for (const char of chars) {
    if (/\s/u.test(char)) {
      pendingSpace = true
      continue
    }
    if (pendingSpace && result !== '') {
      const previous = result.slice(-1)
      // Keep one space only between Latin-word material. A space between two
      // digits is a PDF layout artefact (`3 4最高`, `2024 2025`), never a word
      // boundary; digits next to letters are still left intact for English
      // such as `Chapter 3 A`.
      const digitPair = isDigit(previous) && isDigit(char)
      if (!digitPair && !isCjkOrPunctuation(previous) && !isCjkOrPunctuation(char)) {
        result += ' '
      }
    }
    result += char
    pendingSpace = false
  }

  return result.trim()
}

/** Median of a numeric list (mean of the two middle values); 0 when empty. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Default paragraph-start indent as a multiple of the line's font size. */
export const PARAGRAPH_INDENT_RATIO = 0.75

/** Font growth that marks a heading line and therefore a paragraph boundary. */
export const HEADING_FONT_RATIO = 1.15

/**
 * Split reading-ordered article body lines into natural paragraphs.
 *
 * Chinese newspaper paragraphs are normally marked by a first-line indent of
 * roughly two characters; the body's common left edge is the column baseline.
 * A line that starts more than `PARAGRAPH_INDENT_RATIO × fontSize` right of its
 * column's median left edge starts a new paragraph. A new column is a
 * continuation unless the first line there is itself indented. Larger font
 * lines (inline headings) start a paragraph, and a following smaller line starts
 * another paragraph after the heading.
 *
 * Deliberately no vertical-gap heuristic: synthetic/edited blocks can be far
 * apart without being separate paragraphs, while a first-line indent is the
 * stable signal in Chinese newspaper columns.
 *
 * The output preserves input order; lines are never dropped or reordered.
 */
export function splitParagraphs(lines: readonly TextLine[]): TextLine[][] {
  if (lines.length === 0) return []

  const leftsByColumn = new Map<number, number[]>()
  for (const line of lines) {
    const lefts = leftsByColumn.get(line.column)
    if (lefts === undefined) leftsByColumn.set(line.column, [line.bbox.x])
    else lefts.push(line.bbox.x)
  }
  const baselineByColumn = new Map<number, number>()
  for (const [column, lefts] of leftsByColumn) baselineByColumn.set(column, median(lefts))

  const paragraphs: TextLine[][] = []
  let current: TextLine[] = []
  let previous: TextLine | undefined

  for (const line of lines) {
    const baseline = baselineByColumn.get(line.column) ?? line.bbox.x
    const fontSize = Math.max(line.fontSize, 1)
    const threshold = Math.max(4, PARAGRAPH_INDENT_RATIO * fontSize)
    const indented = line.bbox.x > baseline + threshold
    const largerFont = previous !== undefined && line.fontSize > previous.fontSize * HEADING_FONT_RATIO
    const afterHeading =
      previous !== undefined && previous.fontSize > line.fontSize * HEADING_FONT_RATIO
    const startsParagraph = previous === undefined || indented || largerFont || afterHeading

    if (startsParagraph && current.length > 0) {
      paragraphs.push(current)
      current = []
    }
    current.push(line)
    previous = line
  }

  if (current.length > 0) paragraphs.push(current)
  return paragraphs
}

/**
 * Build a clean article body from reading-ordered body lines.
 *
 * Each paragraph is merged without line breaks (CJK joins directly; Latin words
 * that a wrap split keep one space), then character-level spacing is cleaned.
 * Paragraphs are separated by exactly one blank line (`\n\n`), and no paragraph
 * keeps a first-line indent.
 */
export function buildCleanBody(lines: readonly TextLine[], merge: (lines: readonly TextLine[]) => string): string {
  return splitParagraphs(lines)
    .map((paragraph) => cleanTextSpacing(merge(paragraph)))
    .filter((paragraph) => paragraph !== '')
    .join('\n\n')
}

/** Fields needed to render the complete extracted article. */
export interface ArticleTextParts {
  title: string
  subtitle?: string
  byline?: string
  body: string
}

/**
 * Render the complete article in reading order: title, subtitle (if any),
 * byline/author (if any), then body. Parts are separated by one blank line, so
 * the same `\n\n` paragraph convention applies to the whole article.
 */
export function renderArticleFullText(article: ArticleTextParts): string {
  const parts = [article.title, article.subtitle, article.byline, article.body]
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  return parts.join('\n\n')
}

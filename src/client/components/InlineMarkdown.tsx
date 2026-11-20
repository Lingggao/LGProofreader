/**
 * Minimal inline Markdown renderer (Task 24).
 *
 * The consolidator writes the must-fix summary and some suggestions with
 * `**…**` markers (the same markers the Markdown export keeps). Rendering that
 * raw string showed the asterisks to the user (`**text**`), which is the bug
 * this module fixes.
 *
 * Only bold spans are supported, deliberately: the source text is user/model
 * content, so it is rendered as React text nodes (never `dangerouslySetInnerHTML`)
 * and a full Markdown parser is neither needed nor shipped.
 *
 * Rules (shared with the finding-suggestion renderer):
 * - a `**…**` pair becomes one `strong` span, markers removed;
 * - an unmatched `**` is kept literally (text is never dropped);
 * - no whole-string bold fallback here — callers that need the
 *   "suggestion without markers is the replacement text" behaviour pass
 *   `boldUnmarked`.
 */
import type { ReactNode } from 'react'

/** One piece of an inline-Markdown string. */
export interface BoldSpan {
  text: string
  strong: boolean
}

/**
 * Split a string into plain/bold spans.
 *
 * `**` pairs mark bold segments, the markers are removed, and an unmatched
 * marker stays in the literal text. An empty/non-string value yields no spans.
 */
export function parseBoldSpans(text: string | undefined): BoldSpan[] {
  const value = typeof text === 'string' ? text : ''
  const spans: BoldSpan[] = []
  let rest = value
  while (rest.length > 0) {
    const open = rest.indexOf('**')
    if (open < 0) {
      spans.push({ text: rest, strong: false })
      break
    }
    const close = rest.indexOf('**', open + 2)
    if (close < 0) {
      // Unmatched marker: keep the remaining text literally.
      spans.push({ text: rest, strong: false })
      break
    }
    if (open > 0) spans.push({ text: rest.slice(0, open), strong: false })
    spans.push({ text: rest.slice(open + 2, close), strong: true })
    rest = rest.slice(close + 2)
  }
  return spans
}

/** Props of {@link InlineMarkdown}. */
export interface InlineMarkdownProps {
  /** Raw text that may contain `**bold**` markers. */
  text: string | undefined
  /** Class name of the wrapping element (optional). */
  className?: string
  /**
   * When true, a string without any marker is rendered as one bold span (the
   * finding-suggestion "replacement text" contract). Must-fix items leave this
   * off so plain items stay plain.
   */
  boldUnmarked?: boolean
}

/**
 * Render `**bold**` markers as `<strong>` and everything else as text.
 *
 * The returned structure is flat (no extra wrapping element when no
 * `className` is given) so existing text queries keep working.
 */
export function InlineMarkdown({
  text,
  className,
  boldUnmarked = false,
}: InlineMarkdownProps): JSX.Element {
  const value = typeof text === 'string' ? text : ''
  let spans = parseBoldSpans(value)
  // A marker-less suggestion is the replacement text itself and is bolded
  // (matches the Markdown export). Must-fix items never take this path.
  if (boldUnmarked && !value.includes('**')) {
    spans = value === '' ? [] : [{ text: value, strong: true }]
  }
  const children: ReactNode = spans.map((span, index) =>
    span.strong ? (
      <strong key={index}>{span.text}</strong>
    ) : (
      <span key={index}>{span.text}</span>
    ),
  )
  return className === undefined ? <>{children}</> : <span className={className}>{children}</span>
}

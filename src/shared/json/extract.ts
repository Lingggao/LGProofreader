/**
 * Generic extraction of a JSON object or array from a raw model reply.
 *
 * Models rarely return pure JSON: they wrap the payload in a Markdown code
 * fence and/or surround it with prose. This helper strips the fences, finds the
 * first JSON object/array and parses it. It is shared by the layout, finding and
 * claim parsers (Tasks 4/6/10), so it must stay free of Node.js, React and
 * DeepSeek Harness imports.
 */

/** Error thrown by {@link extractJsonObject} for unusable model output. */
export class ExtractJsonError extends Error {
  readonly code = 'INVALID_JSON' as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExtractJsonError'
  }
}

/**
 * Index of the first `{` or `[` in `text`, or `-1` when neither occurs.
 * `Array.prototype.indexOf` returns `-1` for a missing needle, so a single
 * minimum would wrongly prefer the missing one; they are handled separately.
 */
function firstJsonStart(text: string): number {
  const objectStart = text.indexOf('{')
  const arrayStart = text.indexOf('[')
  if (objectStart === -1) return arrayStart
  if (arrayStart === -1) return objectStart
  return Math.min(objectStart, arrayStart)
}

/**
 * Extract the first JSON object or array from a raw model reply.
 *
 * Steps: trim the text, drop Markdown code-fence lines (keeping their content,
 * including a fence that was never closed because the reply was truncated),
 * locate the first `{`/`[` and the last matching `}`/`]`, then `JSON.parse`
 * that slice. Missing, truncated or malformed JSON raises
 * {@link ExtractJsonError} (never a raw `SyntaxError`), so callers can tell
 * "the model did not follow the schema" apart from a programming error.
 *
 * Only objects and arrays are accepted at the top level: every caller expects a
 * structured payload, so a bare `42` or `"text"` is treated as invalid output.
 */
export function extractJsonObject(raw: string): unknown {
  // Fence delimiters are whole lines ("```json", "```", "~~~"); removing them
  // keeps fenced content and any prose that precedes/follows the block.
  const text = raw.replace(/^[ \t]*(?:`{3,}|~{3,})[A-Za-z0-9_+.-]*[ \t]*\r?$/gm, '').trim()
  if (text.length === 0) {
    throw new ExtractJsonError('expected a JSON object or array but the text is empty')
  }

  const start = firstJsonStart(text)
  if (start === -1) {
    throw new ExtractJsonError('expected a JSON object or array but found no "{" or "["')
  }

  const closing = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(closing)
  if (end <= start) {
    throw new ExtractJsonError(`JSON is truncated: no closing "${closing}" found`)
  }

  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    throw new ExtractJsonError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (typeof value !== 'object' || value === null) {
    throw new ExtractJsonError('expected a JSON object or array, got another JSON value')
  }
  return value
}

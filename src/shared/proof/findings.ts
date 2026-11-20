/**
 * Validation and quote location for the per-role findings JSON.
 *
 * Each proofreading role answers with `{ findings: [...], notes?: string }` (see
 * Design §7.3). The model is
 * untrusted input: every required field is validated and the model's `quote` is
 * located in the article text before the finding can be shown to the user.
 *
 * Quote location runs the model quote through two passes:
 * 1. an exact `indexOf` on the article text;
 * 2. a normalized comparison that removes whitespace and folds full-width /
 *    curly punctuation to ASCII (`normalizeForMatch`).
 *
 * A quote that cannot be located is **kept** and marked `needsHuman` with
 * `reason = '引用无法定位'` (this replaces the model's own reason, so the report
 * always explains the downgrade); silently dropping it would hide a problem the
 * role reported. When only the normalized pass succeeds, the stored `quote` is
 * the real article snippet so the report/overlay can highlight the original text.
 *
 * The module has no Node.js, React or DeepSeek Harness imports (shared Host +
 * Client code) and is pure: same input -> same output, inputs are not mutated.
 */
import type { Confidence, Finding } from '../types'
import { ExtractJsonError, extractJsonObject } from '../json/extract'

/** Error codes produced by {@link parseFindings}. */
export type FindingsErrorCode = 'INVALID_JSON' | 'INVALID_SHAPE'

/** Typed validation failure; the orchestrator retries the role on this error. */
export class FindingsError extends Error {
  readonly code: FindingsErrorCode

  constructor(code: FindingsErrorCode, message: string) {
    super(message)
    this.name = 'FindingsError'
    this.code = code
  }
}

/** Reason attached to a finding whose quote is not present in the article text. */
export const UNLOCATABLE_QUOTE_REASON = '引用无法定位'

/** Categories from the findings output contract (§7.3). */
export const FINDING_CATEGORIES: readonly Finding['category'][] = [
  'typo',
  'punctuation',
  'word',
  'idiom',
  'grammar',
  'fact',
  'consistency',
  'headline',
  'format',
]

/** Severity from most to least urgent. */
export const FINDING_SEVERITIES: readonly Finding['severity'][] = [
  'must_fix',
  'suggested',
  'optional',
]

/** Confidence labels from most to least trustworthy. */
export const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low']

/* ------------------------------------------------------------------------- */
/* Normalization                                                               */
/* ------------------------------------------------------------------------- */

/** Curly/smart quotes are folded to ASCII quotes as well as their full-width variants. */
const FOLDED_QUOTES: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
}

/** One non-whitespace character of the normalized text plus its original span. */
interface NormalizedChar {
  value: string
  /** Original `articleText` index where this character starts. */
  start: number
  /** Original `articleText` index just past this character. */
  end: number
}

/** Full-width ASCII forms (`！`..`～`) become their ASCII counterpart. */
function foldChar(char: string): string {
  const code = char.codePointAt(0) as number
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0)
  return FOLDED_QUOTES[char] ?? char
}

/**
 * Walk `text` once, dropping every whitespace character and folding full-width
 * ASCII / curly quotes, while remembering where each surviving character came
 * from. `for...of` iterates code points, so surrogate pairs stay intact.
 */
function normalizedChars(text: string): NormalizedChar[] {
  const chars: NormalizedChar[] = []
  let index = 0
  for (const char of text) {
    const start = index
    index += char.length
    if (/\s/.test(char)) continue
    chars.push({ value: foldChar(char), start, end: index })
  }
  return chars
}

/**
 * Normalize text for quote matching: remove all whitespace and fold full-width
 * ASCII punctuation/letters/digits plus curly quotes to ASCII. Chinese
 * punctuation without an ASCII counterpart (`。、《》—…`) is preserved.
 */
export function normalizeForMatch(text: string): string {
  return normalizedChars(text)
    .map((char) => char.value)
    .join('')
}

/** Every index in `chars` where `needle` occurs (code point by code point). */
function findNormalizedIndexes(
  chars: readonly NormalizedChar[],
  needle: readonly string[],
): number[] {
  const indexes: number[] = []
  outer: for (let start = 0; start + needle.length <= chars.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (chars[start + offset].value !== needle[offset]) continue outer
    }
    indexes.push(start)
  }
  return indexes
}

/** Every index in `text` where `quote` occurs exactly (overlapping matches included). */
function exactMatchIndexes(text: string, quote: string): number[] {
  const indexes: number[] = []
  let from = 0
  for (;;) {
    const index = text.indexOf(quote, from)
    if (index === -1) break
    indexes.push(index)
    from = index + 1
  }
  return indexes
}

/**
 * A quote located in the article text (design §7.3/§7.4).
 *
 * `quote` is the canonical article snippet (original punctuation/whitespace
 * restored); `occurrence` is its 1-based occurrence in the article text.
 */
export interface LocatedQuote {
  quote: string
  occurrence: number
}

/**
 * Locate `quote` in `text` and return the canonical snippet + 1-based
 * occurrence, or `undefined` when it cannot be located.
 *
 * Matching runs the same two passes as the finding validator:
 * 1. exact `indexOf` on the article text;
 * 2. a normalized comparison that removes whitespace and folds full-width /
 *    curly punctuation to ASCII ({@link normalizeForMatch}).
 *
 * The optional `occurrence` (1-based, default 1) selects which occurrence to
 * locate, letting callers that know the intended repetition resolve it; the
 * default locates the first occurrence. Exact matches are preferred over
 * normalized-only ones. `undefined` is returned for an empty quote, a quote
 * that does not occur at all, or an occurrence beyond the available matches.
 */
export function locateQuote(
  text: string,
  quote: string,
  occurrence = 1,
): LocatedQuote | undefined {
  if (quote === '') return undefined
  const wanted = Number.isFinite(occurrence) ? Math.max(1, Math.floor(occurrence)) : 1
  const needle = Array.from(normalizeForMatch(quote))
  const chars = needle.length === 0 ? [] : normalizedChars(text)
  const normalizedMatches = needle.length === 0 ? [] : findNormalizedIndexes(chars, needle)

  // Exact matches win over normalized-only ones; report the located snippet's
  // real ordinal among the normalized occurrences so an earlier full-width /
  // whitespace variant is counted (occurrence is 1-based in the article).
  const exactIndex = exactMatchIndexes(text, quote)[wanted - 1]
  if (exactIndex !== undefined) {
    const ordinal = normalizedMatches.filter((match) => chars[match].start < exactIndex).length + 1
    return { quote, occurrence: ordinal }
  }

  const match = normalizedMatches[wanted - 1]
  if (match === undefined) return undefined
  return {
    quote: text.slice(chars[match].start, chars[match + needle.length - 1].end),
    occurrence: wanted,
  }
}

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* ------------------------------------------------------------------------- */

function invalidShape(message: string): never {
  throw new FindingsError('INVALID_SHAPE', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalidShape(`${path} must be a JSON object`)
  return value
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalidShape(`${path} must be a JSON array`)
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') invalidShape(`${path} must be a string`)
  return value
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidShape(`${path} must be a non-empty string`)
  }
  return value
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string') invalidShape(`${path} must be one of ${allowed.join(' | ')}`)
  const normalized = value.trim()
  if (!(allowed as readonly string[]).includes(normalized)) {
    invalidShape(`${path} must be one of ${allowed.join(' | ')}, got "${value}"`)
  }
  return normalized as T
}

/** Optional string fields (`reason`, `evidence`) may be omitted or null. */
function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, path)
}

/** `occurrence` is 1-based and defaults to the first occurrence. */
function readOccurrence(value: unknown, path: string): number {
  if (value === undefined || value === null) return 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalidShape(`${path} must be a positive integer`)
  }
  return value
}

/** `needs_human` is optional and defaults to false. */
function readNeedsHuman(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') invalidShape(`${path} must be a boolean`)
  return value
}

function readSources(value: unknown, path: string): { title: string; url: string }[] | undefined {
  if (value === undefined || value === null) return undefined
  return requireArray(value, path).map((entry, index) => {
    const entryPath = `${path}[${index}]`
    const source = requireRecord(entry, entryPath)
    return {
      title: requireString(source.title, `${entryPath}.title`),
      url: requireString(source.url, `${entryPath}.url`),
    }
  })
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* ------------------------------------------------------------------------- */

/** Fields known from one model finding object; anything else is ignored. */
interface RawFinding {
  category: Finding['category']
  severity: Finding['severity']
  quote: string
  occurrence: number
  issue: string
  suggestion: string
  confidence: Confidence
  needsHuman: boolean
  reason?: string
  evidence?: string
  sources?: { title: string; url: string }[]
}

function readFinding(value: unknown, index: number): RawFinding {
  const path = `findings[${index}]`
  const finding = requireRecord(value, path)
  return {
    category: requireEnum(finding.category, FINDING_CATEGORIES, `${path}.category`),
    severity: requireEnum(finding.severity, FINDING_SEVERITIES, `${path}.severity`),
    quote: requireNonEmptyString(finding.quote, `${path}.quote`),
    occurrence: readOccurrence(finding.occurrence, `${path}.occurrence`),
    issue: requireNonEmptyString(finding.issue, `${path}.issue`),
    suggestion: requireString(finding.suggestion, `${path}.suggestion`),
    confidence: requireEnum(finding.confidence, CONFIDENCES, `${path}.confidence`),
    needsHuman: readNeedsHuman(finding.needs_human, `${path}.needs_human`),
    reason: readOptionalString(finding.reason, `${path}.reason`),
    evidence: readOptionalString(finding.evidence, `${path}.evidence`),
    sources: readSources(finding.sources, `${path}.sources`),
  }
}

/**
 * Validate one role reply and return its findings in reply order.
 *
 * Each returned finding has a deterministic `f1...` id. `articleId` is left
 * empty and `roles` empty because one role reply covers one article and this
 * pure function does not know that context; the orchestrator stamps both before
 * merging.
 *
 * Throws {@link FindingsError} for unusable model output: `INVALID_JSON` when no
 * JSON object can be extracted, `INVALID_SHAPE` when a required field is
 * missing/invalid. One bad finding fails the whole reply so the caller retries
 * the role instead of silently showing a partial result.
 */
export function parseFindings(raw: string, articleText: string): Finding[] {
  let parsed: unknown
  try {
    parsed = extractJsonObject(raw)
  } catch (error) {
    if (error instanceof ExtractJsonError) {
      throw new FindingsError('INVALID_JSON', `findings payload is not valid JSON: ${error.message}`)
    }
    throw error
  }

  const root = requireRecord(parsed, 'findings payload')
  return requireArray(root.findings, 'findings').map((entry, index) => {
    const rawFinding = readFinding(entry, index)
    const located = locateQuote(articleText, rawFinding.quote)
    const locatedQuote = located?.quote ?? null
    const finding: Finding = {
      id: `f${index + 1}`,
      articleId: '',
      category: rawFinding.category,
      severity: rawFinding.severity,
      quote: locatedQuote ?? rawFinding.quote,
      occurrence: rawFinding.occurrence,
      issue: rawFinding.issue,
      suggestion: rawFinding.suggestion,
      confidence: rawFinding.confidence,
      needsHuman: rawFinding.needsHuman || locatedQuote === null,
      roles: [],
      status: 'open',
    }
    const reason = locatedQuote === null ? UNLOCATABLE_QUOTE_REASON : rawFinding.reason
    if (reason !== undefined) finding.reason = reason
    if (rawFinding.evidence !== undefined) finding.evidence = rawFinding.evidence
    if (rawFinding.sources !== undefined) finding.sources = rawFinding.sources
    return finding
  })
}

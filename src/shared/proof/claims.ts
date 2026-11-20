/**
 * Validation for the facts role's two JSON replies (design §7.4, claims stage 1
 * and verdict stage 3).
 *
 * The `facts` model call is untrusted input. Stage 1 must return
 * `{ claims: [{ claim, quote, kind, queries, priority }] }`; stage 3 must return
 * `{ verdicts: [{ claim, verdict, evidence?, sources?, confidence, needs_human? }] }`.
 * The JSON Schemas are `prompts/zh/contracts/claims.schema.json` and
 * `prompts/zh/contracts/factchecks.schema.json`.
 *
 * Validation philosophy ("应查尽查" is binding):
 * - structural violations that make an entry uninterpretable (missing/blank
 *   claim or quote, unknown kind/verdict, malformed sources, wrong types) raise
 *   {@link ClaimsError} so the orchestrator can retry the whole role instead of
 *   showing a partial fact-check list;
 * - advisory values are normalized, never used to drop a claim: the contract's
 *   `queries` (2–3 variants) and `priority` (integer ≥ 1) are clamped/normalized
 *   because silently dropping a claim over a missing query variant or a
 *   zero-based priority would violate "every checkable item must appear in the
 *   checklist". One query variant is accepted; a missing/blank variant list
 *   falls back to the claim text itself; extra variants are capped at
 *   {@link MAX_QUERY_VARIANTS}.
 * - `sources` entries may omit their title (the URL is used instead): the title
 *   is a presentation detail, the URL is the evidence. A source without a URL is
 *   invalid output and is retried.
 *
 * The module has no Node.js, React or DeepSeek Harness imports (it is shared by
 * the Host tests and future report code) and is pure: same input -> same output,
 * inputs are not mutated.
 */
import type { Confidence, FactCheck } from '../types'
import { CONFIDENCES, normalizeForMatch } from './findings'
import { ExtractJsonError, extractJsonObject } from '../json/extract'

/** Error codes produced by {@link parseClaims} and {@link parseVerdicts}. */
export type ClaimsErrorCode = 'INVALID_JSON' | 'INVALID_SHAPE'

/** Typed validation failure; the fact checker propagates it so the role can retry. */
export class ClaimsError extends Error {
  readonly code: ClaimsErrorCode

  constructor(code: ClaimsErrorCode, message: string) {
    super(message)
    this.name = 'ClaimsError'
    this.code = code
  }
}

/** Checkable claim kinds from the claims contract (design §7.4). */
export const CLAIM_KINDS: readonly FactCheck['kind'][] = Object.freeze([
  'date',
  'time',
  'person',
  'title',
  'organization',
  'place',
  'book',
  'event',
  'number',
  'quote',
  'other',
])

/** Verdicts from the fact-checks contract (design §7.4 stage 3). */
export const FACT_VERDICTS: readonly FactCheck['verdict'][] = Object.freeze([
  'confirmed',
  'contradicted',
  'unverified',
  'insufficient',
  'not_checked',
])

/** The claims contract asks for 2–3 query variants; extra variants are capped. */
export const MAX_QUERY_VARIANTS = 3

/** One verifiable claim extracted in stage 1. */
export interface Claim {
  /** The fact to check, one sentence. */
  claim: string
  /** Consecutive snippet of the article supporting the claim. */
  quote: string
  kind: FactCheck['kind']
  /** Search query variants, 1..{@link MAX_QUERY_VARIANTS}; never empty. */
  queries: string[]
  /** Check order, 1 = most important; normalized to an integer ≥ 1. */
  priority: number
}

/** One model verdict for a claim, as returned in stage 3. */
export interface Verdict {
  /** Claim text as echoed by the model, used to match it back to stage 1. */
  claim: string
  verdict: FactCheck['verdict']
  /** Short basis for the verdict, when the model supplied one. */
  evidence?: string
  /** Sources backing the verdict; may be empty for unverified/insufficient. */
  sources: { title: string; url: string }[]
  confidence: Confidence
  /** True when the model itself asked for a human decision. */
  needsHuman: boolean
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Validate the stage-1 reply and return its claims in reply order.
 *
 * Throws {@link ClaimsError} (`INVALID_JSON` for unparseable output,
 * `INVALID_SHAPE` for an unusable claim) so the caller retries the extraction
 * instead of showing a partial / silently shortened checklist. An empty
 * `claims` array is valid and means "未发现可核查项".
 */
export function parseClaims(raw: string): Claim[] {
  const root = requireRecord(extractPayload(raw, 'claims payload'), 'claims payload')
  return requireArray(root.claims, 'claims').map((entry, index) => readClaim(entry, index))
}

/**
 * Validate the stage-3 reply and return its verdicts in reply order.
 *
 * Throws {@link ClaimsError} for unusable output. Verdict entries whose `claim`
 * does not match a stage-1 claim are simply not matched later; missing verdicts
 * are handled by the fact checker as `unverified` (never dropped).
 */
export function parseVerdicts(raw: string): Verdict[] {
  const root = requireRecord(extractPayload(raw, 'verdicts payload'), 'verdicts payload')
  return requireArray(root.verdicts, 'verdicts').map((entry, index) => readVerdict(entry, index))
}

/* ------------------------------------------------------------------------- */
/* Claim reading                                                               */
/* ------------------------------------------------------------------------- */

function readClaim(value: unknown, index: number): Claim {
  const path = `claims[${index}]`
  const record = requireRecord(value, path)
  const claim = requireNonEmptyString(record.claim, `${path}.claim`)
  const quote = requireNonEmptyString(record.quote, `${path}.quote`)
  return {
    claim,
    quote,
    kind: requireEnum(record.kind, CLAIM_KINDS, `${path}.kind`),
    queries: readQueries(record.queries, `${path}.queries`, claim),
    priority: readPriority(record.priority, `${path}.priority`, index),
  }
}

/**
 * Normalize the advisory query variants: trim, drop blanks, dedupe by
 * whitespace/full-width-insensitive text and cap at {@link MAX_QUERY_VARIANTS}.
 * A missing or blank list falls back to the claim text so the claim can still be
 * searched (never dropped). Wrongly typed entries are a schema violation.
 */
function readQueries(value: unknown, path: string, fallback: string): string[] {
  if (value === undefined || value === null) return [fallback]
  const queries: string[] = []
  const seen = new Set<string>()
  for (const [index, entry] of requireArray(value, path).entries()) {
    if (typeof entry !== 'string') invalidShape(`${path}[${index}] must be a string`)
    const query = entry.trim()
    if (query === '') continue
    const key = normalizeForMatch(query)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
    if (queries.length === MAX_QUERY_VARIANTS) break
  }
  return queries.length === 0 ? [fallback] : queries
}

/** Normalize the advisory priority: integer ≥ 1; absent falls back to extraction order. */
function readPriority(value: unknown, path: string, index: number): number {
  if (value === undefined || value === null) return index + 1
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidShape(`${path} must be a number`)
  }
  return Math.max(1, Math.floor(value))
}

/* ------------------------------------------------------------------------- */
/* Verdict reading                                                             */
/* ------------------------------------------------------------------------- */

function readVerdict(value: unknown, index: number): Verdict {
  const path = `verdicts[${index}]`
  const record = requireRecord(value, path)
  const verdict: Verdict = {
    claim: requireNonEmptyString(record.claim, `${path}.claim`),
    verdict: requireEnum(record.verdict, FACT_VERDICTS, `${path}.verdict`),
    sources: readSources(record.sources, `${path}.sources`),
    confidence: requireEnum(record.confidence, CONFIDENCES, `${path}.confidence`),
    needsHuman: readOptionalBoolean(record.needs_human, `${path}.needs_human`),
  }
  const evidence = readOptionalString(record.evidence, `${path}.evidence`)
  if (evidence !== undefined && evidence !== '') verdict.evidence = evidence
  return verdict
}

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* ------------------------------------------------------------------------- */

function invalidShape(message: string): never {
  throw new ClaimsError('INVALID_SHAPE', message)
}

/** Extract the first JSON object from the model reply, mapping parse errors to INVALID_JSON. */
function extractPayload(raw: string, label: string): unknown {
  try {
    return extractJsonObject(raw)
  } catch (error) {
    if (error instanceof ExtractJsonError) {
      throw new ClaimsError('INVALID_JSON', `${label} is not valid JSON: ${error.message}`)
    }
    throw error
  }
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

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidShape(`${path} must be a non-empty string`)
  }
  return value.trim()
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string') invalidShape(`${path} must be one of ${allowed.join(' | ')}`)
  const normalized = value.trim()
  if (!(allowed as readonly string[]).includes(normalized)) {
    invalidShape(`${path} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`)
  }
  return normalized as T
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') invalidShape(`${path} must be a string`)
  return value.trim()
}

function readOptionalBoolean(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') invalidShape(`${path} must be a boolean`)
  return value
}

/**
 * Validate the optional `sources` array. A title is a presentation detail, so it
 * may be omitted (the URL is used); the URL is required because the report must
 * show the evidence link.
 */
function readSources(value: unknown, path: string): { title: string; url: string }[] {
  if (value === undefined || value === null) return []
  return requireArray(value, path).map((entry, index) => {
    const entryPath = `${path}[${index}]`
    const source = requireRecord(entry, entryPath)
    const url = requireNonEmptyString(source.url, `${entryPath}.url`)
    const title = readOptionalString(source.title, `${entryPath}.title`)
    return { title: title !== undefined && title !== '' ? title : url, url }
  })
}

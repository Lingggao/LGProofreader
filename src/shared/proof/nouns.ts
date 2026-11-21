/**
 * Validation for the independent `nouns` role's planning reply.
 *
 * The noun checker only asks the model for a prioritized list of names/terms
 * and search queries; existence is decided from Host-collected web evidence.
 * The JSON is untrusted: malformed/ambiguous rows are rejected so the role can
 * retry, while advisory query/priority values are normalized instead of
 * silently dropping a term.
 */
import { ExtractJsonError, extractJsonObject } from '../json/extract'
import { normalizeForMatch } from './findings'
import type { NounCheckKind } from '../types'

/** Error codes produced by {@link parseNounCandidates}. */
export type NounsErrorCode = 'INVALID_JSON' | 'INVALID_SHAPE'

/** Typed validation failure; the role propagates it so the orchestrator retries. */
export class NounsError extends Error {
  readonly code: NounsErrorCode

  constructor(code: NounsErrorCode, message: string) {
    super(message)
    this.name = 'NounsError'
    this.code = code
  }
}

/** Noun kinds accepted from the planning contract. */
export const NOUN_KINDS: readonly NounCheckKind[] = Object.freeze([
  'organization',
  'company',
  'institution',
  'place',
  'product',
  'system',
  'project',
  'event',
  'person',
  'title',
  'technical_term',
  'other',
])

/** Max query variants retained per noun (contract asks for 2–3). */
export const MAX_NOUN_QUERY_VARIANTS = 3

/** One noun/term proposed by the model. */
export interface NounCandidate {
  name: string
  quote: string
  kind: NounCheckKind
  queries: string[]
  /** 1 = highest importance. */
  priority: number
}

function invalidShape(message: string): never {
  throw new NounsError('INVALID_SHAPE', message)
}

function payload(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new NounsError('INVALID_JSON', 'noun reply is empty')
  }
  try {
    return extractJsonObject(raw)
  } catch (error) {
    if (error instanceof ExtractJsonError) {
      throw new NounsError('INVALID_JSON', `noun reply is not valid JSON: ${error.message}`)
    }
    throw error
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function normalizeKind(value: unknown): NounCheckKind {
  if (typeof value !== 'string' || !NOUN_KINDS.includes(value as NounCheckKind)) {
    invalidShape(`unknown noun kind: ${String(value)}`)
  }
  return value as NounCheckKind
}

function normalizeQueries(value: unknown, name: string): string[] {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  if (!Array.isArray(value)) return [name]
  const queries = value
    .filter((query): query is string => typeof query === 'string' && query.trim() !== '')
    .map((query) => query.trim())
    .filter((query, index, all) => all.indexOf(query) === index)
    .slice(0, MAX_NOUN_QUERY_VARIANTS)
  return queries.length === 0 ? [name] : queries
}

function normalizePriority(value: unknown, index: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return index + 1
  return Math.max(1, Math.floor(number))
}

/**
 * Parse `{ "nouns": [{ name, quote, kind, queries, priority }] }`.
 *
 * Every unique normalized name appears exactly once; duplicate spellings keep
 * the first quote and the highest (smallest) priority. A missing `nouns` array
 * and malformed required fields are fatal so a partial plan can never be shown
 * as complete.
 */
export function parseNounCandidates(raw: string): NounCandidate[] {
  const value = payload(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidShape('noun reply must be an object')
  }
  const list = (value as { nouns?: unknown }).nouns
  if (!Array.isArray(list)) invalidShape('noun reply must contain a nouns array')

  const candidates: NounCandidate[] = []
  const byName = new Map<string, NounCandidate>()
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      invalidShape(`nouns[${index}] must be an object`)
    }
    const record = item as Record<string, unknown>
    if (!nonEmptyString(record.name)) invalidShape(`nouns[${index}].name is required`)
    const name = record.name.trim()
    const quote = nonEmptyString(record.quote) ? record.quote.trim() : name
    const candidate: NounCandidate = {
      name,
      quote,
      kind: normalizeKind(record.kind),
      queries: normalizeQueries(record.queries, name),
      priority: normalizePriority(record.priority, index),
    }
    const key = normalizeForMatch(name)
    const existing = byName.get(key)
    if (existing === undefined) {
      byName.set(key, candidate)
      candidates.push(candidate)
    } else {
      existing.priority = Math.min(existing.priority, candidate.priority)
    }
  }
  return candidates
}

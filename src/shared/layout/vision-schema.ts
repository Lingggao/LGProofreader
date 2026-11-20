import type { CandidateBlock } from '../types'
import { ExtractJsonError, extractJsonObject } from '../json/extract'

/**
 * Vision layout contract for one newspaper page.
 *
 * The vision model only classifies and groups the numbered candidate blocks
 * (`c1`, `c2`, …) produced by `buildCandidates`; it never transcribes text and
 * never supplies coordinates. This module validates that JSON and turns it into
 * the {@link VisionLayout} consumed by the deterministic article assembly.
 *
 * `VisionRegion.kind` mirrors `Region['kind']` and `VisionArticle.role` mirrors
 * `Article['role']` in `../types`; they are declared here so the validation
 * arrays and the inferred unions stay in one place for the model contract.
 */

/** Region classification (same union as `Region['kind']`). */
export type VisionRegionKind =
  | 'masthead'
  | 'header'
  | 'footer'
  | 'lead'
  | 'second'
  | 'third'
  | 'article'
  | 'image'
  | 'caption'
  | 'ad'
  | 'index'
  | 'other'

/** Article role (same union as `Article['role']`). */
export type VisionArticleRole = 'lead' | 'second' | 'third' | 'normal'

/** Continuation hint; the product is single-page, so this is never auto-joined. */
export type VisionContinuation = 'none' | 'down' | 'up'

/** One classified candidate block. */
export interface VisionRegion {
  candidateId: string
  kind: VisionRegionKind
  /**
   * Article group this region belongs to, or `''` for regions outside any
   * article (masthead/header/footer/image/ad/index/other). A non-empty group
   * must name exactly one article.
   */
  articleGroup: string
  readingOrder: number
  /** Model confidence in `[0, 1]`. */
  confidence: number
}

/** One article assembled from one or more classified regions. */
export interface VisionArticle {
  id: string
  titleCandidateId: string
  role: VisionArticleRole
  order: number
  regionIds: string[]
  continuation: VisionContinuation
  /** Model confidence in `[0, 1]`. */
  confidence: number
}

/** Validated output of one vision-layout call. */
export interface VisionLayout {
  /**
   * Page classification. The prompt asks for `front | news | supplement |
   * literary | ad | unknown`, but it is carried as an open string: the brief
   * validates only that it is a string, so an unexpected label never costs the
   * whole layout.
   */
  pageType: string
  regions: VisionRegion[]
  articles: VisionArticle[]
  warnings: string[]
}

/** Error codes produced by {@link parseVisionLayout}. */
export type VisionLayoutErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_SHAPE'
  | 'UNKNOWN_CANDIDATE'
  | 'DUPLICATE_CANDIDATE'
  | 'MISSING_ARTICLE'

/** Typed validation failure; the analyzer retries once on this error then falls back. */
export class VisionLayoutError extends Error {
  readonly code: VisionLayoutErrorCode

  constructor(code: VisionLayoutErrorCode, message: string) {
    super(message)
    this.name = 'VisionLayoutError'
    this.code = code
  }
}

/** Confidence assigned to regions/articles produced by the deterministic fallback. */
export const FALLBACK_CONFIDENCE = 0.3

/** Warning recorded on a fallback layout (checked by the analyzer). */
export const FALLBACK_WARNING = 'vision-fallback'

const REGION_KINDS: readonly VisionRegionKind[] = [
  'masthead',
  'header',
  'footer',
  'lead',
  'second',
  'third',
  'article',
  'image',
  'caption',
  'ad',
  'index',
  'other',
]

const ARTICLE_ROLES: readonly VisionArticleRole[] = ['lead', 'second', 'third', 'normal']

const CONTINUATIONS: readonly VisionContinuation[] = ['none', 'down', 'up']

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* ------------------------------------------------------------------------- */

function invalidShape(message: string): never {
  throw new VisionLayoutError('INVALID_SHAPE', message)
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

/** Ids are trimmed so stray whitespace does not turn into a lookup miss. */
function requireIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidShape(`${path} must be a non-empty string`)
  }
  return value.trim()
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidShape(`${path} must be a finite number`)
  }
  return value
}

function requireConfidence(value: unknown, path: string): number {
  const confidence = requireFiniteNumber(value, path)
  if (confidence < 0 || confidence > 1) invalidShape(`${path} must be between 0 and 1`)
  return confidence
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string') invalidShape(`${path} must be one of ${allowed.join(' | ')}`)
  const normalized = value.trim()
  if (!(allowed as readonly string[]).includes(normalized)) {
    invalidShape(`${path} must be one of ${allowed.join(' | ')}, got "${value}"`)
  }
  return normalized as T
}

/**
 * `articleGroup` is optional: regions such as masthead, image or ad belong to no
 * article, so a missing/null group is normalized to `''` instead of failing the
 * whole layout.
 */
function readArticleGroup(value: unknown, path: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') invalidShape(`${path} must be a string when present`)
  return value.trim()
}

/** The prompt asks for a closed set, but the brief only requires a string. */
function readPageType(value: unknown): string {
  if (typeof value !== 'string') invalidShape('pageType must be a string')
  return value.trim()
}

/** Missing warnings default to an empty list; provided ones must be strings. */
function readWarnings(value: unknown): string[] {
  if (value === undefined) return []
  return requireArray(value, 'warnings').map((entry, index) => {
    if (typeof entry !== 'string') invalidShape(`warnings[${index}] must be a string`)
    return entry
  })
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Parse and validate one vision-layout reply.
 *
 * Validation rules:
 * - the payload must be a JSON object whose `pageType` is a string (the
 *   suggested labels are `front | news | supplement | literary | ad | unknown`
 *   but any string is accepted);
 * - every region must reference a known candidate id, appear only once, carry a
 *   valid `kind`, a string `articleGroup` (or none), a finite `readingOrder` and
 *   a confidence in `[0, 1]`;
 * - every article id must be unique, carry valid `role`/`continuation` values, a
 *   finite `order` and a confidence in `[0, 1]`, its `titleCandidateId` must be a
 *   known candidate, and each `regionIds` entry must be a region of this layout;
 * - every non-empty region `articleGroup` must match an article id
 *   (`MISSING_ARTICLE` otherwise);
 * - optional `warnings` must be an array of strings.
 *
 * Unknown fields are dropped, so the returned objects always have exactly the
 * documented shape; the input candidates are never mutated.
 */
export function parseVisionLayout(
  raw: string,
  candidates: readonly CandidateBlock[],
): VisionLayout {
  let parsed: unknown
  try {
    parsed = extractJsonObject(raw)
  } catch (error) {
    if (error instanceof ExtractJsonError) {
      throw new VisionLayoutError('INVALID_JSON', `vision layout is not valid JSON: ${error.message}`)
    }
    throw error
  }

  const root = requireRecord(parsed, 'vision layout')
  const pageType = readPageType(root.pageType)
  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId))

  const visitedCandidateIds = new Set<string>()
  const regions: VisionRegion[] = requireArray(root.regions, 'regions').map((entry, index) => {
    const path = `regions[${index}]`
    const region = requireRecord(entry, path)
    const candidateId = requireIdentifier(region.candidateId, `${path}.candidateId`)
    if (!knownCandidateIds.has(candidateId)) {
      throw new VisionLayoutError(
        'UNKNOWN_CANDIDATE',
        `${path}.candidateId "${candidateId}" is not one of the ${knownCandidateIds.size} candidate blocks`,
      )
    }
    if (visitedCandidateIds.has(candidateId)) {
      throw new VisionLayoutError(
        'DUPLICATE_CANDIDATE',
        `${path}.candidateId "${candidateId}" appears more than once in regions`,
      )
    }
    visitedCandidateIds.add(candidateId)
    return {
      candidateId,
      kind: requireEnum(region.kind, REGION_KINDS, `${path}.kind`),
      articleGroup: readArticleGroup(region.articleGroup, `${path}.articleGroup`),
      readingOrder: requireFiniteNumber(region.readingOrder, `${path}.readingOrder`),
      confidence: requireConfidence(region.confidence, `${path}.confidence`),
    }
  })

  const candidateIdsWithRegion = new Set(regions.map((region) => region.candidateId))
  const articleIds = new Set<string>()
  const articles: VisionArticle[] = requireArray(root.articles, 'articles').map((entry, index) => {
    const path = `articles[${index}]`
    const article = requireRecord(entry, path)
    const id = requireIdentifier(article.id, `${path}.id`)
    if (articleIds.has(id)) invalidShape(`${path}.id "${id}" is duplicated`)
    articleIds.add(id)

    const titleCandidateId = requireIdentifier(article.titleCandidateId, `${path}.titleCandidateId`)
    if (!knownCandidateIds.has(titleCandidateId)) {
      throw new VisionLayoutError(
        'UNKNOWN_CANDIDATE',
        `${path}.titleCandidateId "${titleCandidateId}" is not one of the ${knownCandidateIds.size} candidate blocks`,
      )
    }

    const regionIds: string[] = []
    requireArray(article.regionIds, `${path}.regionIds`).forEach((value, regionIndex) => {
      const regionPath = `${path}.regionIds[${regionIndex}]`
      const regionId = requireIdentifier(value, regionPath)
      if (!candidateIdsWithRegion.has(regionId)) {
        if (!knownCandidateIds.has(regionId)) {
          throw new VisionLayoutError(
            'UNKNOWN_CANDIDATE',
            `${regionPath} "${regionId}" is not one of the ${knownCandidateIds.size} candidate blocks`,
          )
        }
        invalidShape(`${regionPath} "${regionId}" has no entry in regions`)
      }
      if (regionIds.includes(regionId)) invalidShape(`${regionPath} "${regionId}" is repeated`)
      regionIds.push(regionId)
    })

    return {
      id,
      titleCandidateId,
      role: requireEnum(article.role, ARTICLE_ROLES, `${path}.role`),
      order: requireFiniteNumber(article.order, `${path}.order`),
      regionIds,
      continuation: requireEnum(article.continuation, CONTINUATIONS, `${path}.continuation`),
      confidence: requireConfidence(article.confidence, `${path}.confidence`),
    }
  })

  for (const region of regions) {
    if (region.articleGroup !== '' && !articleIds.has(region.articleGroup)) {
      throw new VisionLayoutError(
        'MISSING_ARTICLE',
        `region for candidate "${region.candidateId}" refers to article group "${region.articleGroup}" but no article has that id`,
      )
    }
  }

  return { pageType, regions, articles, warnings: readWarnings(root.warnings) }
}

/**
 * Deterministic degraded layout used when the vision call keeps failing.
 *
 * Every candidate block becomes its own `article` region and article (`a1`,
 * `a2`, …) at {@link FALLBACK_CONFIDENCE}, with a single
 * {@link FALLBACK_WARNING} warning so the UI can mark the page as low
 * confidence. The result is itself a valid {@link VisionLayout}.
 */
export function fallbackVisionLayout(candidates: readonly CandidateBlock[]): VisionLayout {
  return {
    pageType: 'unknown',
    regions: candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      kind: 'article',
      articleGroup: `a${index + 1}`,
      readingOrder: index + 1,
      confidence: FALLBACK_CONFIDENCE,
    })),
    articles: candidates.map((candidate, index) => ({
      id: `a${index + 1}`,
      titleCandidateId: candidate.candidateId,
      role: 'normal',
      order: index + 1,
      regionIds: [candidate.candidateId],
      continuation: 'none',
      confidence: FALLBACK_CONFIDENCE,
    })),
    warnings: [FALLBACK_WARNING],
  }
}

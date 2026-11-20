/**
 * Deterministic merge of the findings reported by several proofreading roles.
 *
 * The same problem is usually reported by more than one role (e.g. `master` and
 * `words` both spot a typo). `mergeFindings` groups findings by **normalized
 * quote + category** (spec §7.6.2) and produces one finding per problem:
 * - the highest severity wins (`must_fix > suggested > optional`);
 * - the highest confidence wins (`high > medium > low`);
 * - `roles` are unioned (first-seen order, unique);
 * - textual fields come from the primary finding (highest severity, then
 *   highest confidence, then earliest input position);
 * - the suggestion is the first credible (non-blank) suggestion in input order;
 * - distinct credible suggestions are a conflict: the result is `needsHuman`
 *   and carries a `建议冲突` reason. A conflict never silently picks a side.
 *
 * This module dedupes only; it does not sort the report (see the report
 * renderer) and it does not mutate its input. The caller merges **per article**
 * because the grouping key intentionally omits the article id, exactly as the
 * brief specifies.
 */
import type { Confidence, Finding } from '../types'
import { normalizeForMatch } from './findings'

const SEVERITY_RANK: Readonly<Record<Finding['severity'], number>> = {
  optional: 0,
  suggested: 1,
  must_fix: 2,
}

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
}

/** Reason recorded when merged roles suggest different replacements. */
export const SUGGESTION_CONFLICT_REASON = '建议冲突，需人工确认'

function isCredibleSuggestion(suggestion: string): boolean {
  return suggestion.trim().length > 0
}

function maxSeverity(findings: readonly Finding[]): Finding['severity'] {
  let severity = findings[0].severity
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[severity]) severity = finding.severity
  }
  return severity
}

function maxConfidence(findings: readonly Finding[]): Confidence {
  let confidence = findings[0].confidence
  for (const finding of findings) {
    if (CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[confidence]) {
      confidence = finding.confidence
    }
  }
  return confidence
}

/** Highest severity, then highest confidence, then earliest input position. */
function pickPrimary(findings: readonly Finding[]): Finding {
  let primary = findings[0]
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[primary.severity]) {
      primary = finding
      continue
    }
    if (
      SEVERITY_RANK[finding.severity] === SEVERITY_RANK[primary.severity] &&
      CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[primary.confidence]
    ) {
      primary = finding
    }
  }
  return primary
}

function unionRoles(findings: readonly Finding[]): string[] {
  const roles: string[] = []
  for (const finding of findings) {
    for (const role of finding.roles) {
      if (!roles.includes(role)) roles.push(role)
    }
  }
  return roles
}

/**
 * Merge one article's findings. The group order follows the first appearance of
 * each group in `findings`, and ids are reassigned `f1...` in that order so ids
 * stay unique after combining several roles (each role's parser restarts at
 * `f1`).
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = `${finding.category}\u0000${normalizeForMatch(finding.quote)}`
    const group = groups.get(key)
    if (group) group.push(finding)
    else groups.set(key, [finding])
  }

  const merged: Finding[] = []
  for (const group of groups.values()) {
    const primary = pickPrimary(group)
    const credible = group.find((finding) => isCredibleSuggestion(finding.suggestion))
    const distinctSuggestions = new Set<string>()
    for (const finding of group) {
      if (!isCredibleSuggestion(finding.suggestion)) continue
      distinctSuggestions.add(normalizeForMatch(finding.suggestion))
    }
    const conflict = distinctSuggestions.size > 1

    const reason =
      [primary.reason, ...group.map((finding) => finding.reason)].find(
        (candidate) => candidate !== undefined && candidate.trim().length > 0,
      ) ?? (conflict ? SUGGESTION_CONFLICT_REASON : undefined)

    const result: Finding = {
      id: `f${merged.length + 1}`,
      articleId: primary.articleId,
      category: primary.category,
      severity: maxSeverity(group),
      quote: primary.quote,
      occurrence: primary.occurrence,
      issue: primary.issue,
      suggestion: credible?.suggestion ?? primary.suggestion,
      confidence: maxConfidence(group),
      needsHuman: conflict || group.some((finding) => finding.needsHuman),
      roles: unionRoles(group),
      status: primary.status,
    }
    if (reason !== undefined) result.reason = reason
    if (primary.evidence !== undefined) result.evidence = primary.evidence
    if (primary.sources !== undefined) {
      result.sources = primary.sources.map((source) => ({ title: source.title, url: source.url }))
    }
    merged.push(result)
  }
  return merged
}

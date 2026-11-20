/**
 * Pure layout operations for the workbench (Task 18; design §6.5).
 *
 * `Region` and `Article` carry the same assignment twice (`Region.articleId` and
 * `Article.regionIds`); `reconcileLayout` keeps the two sides consistent and
 * enforces "one region belongs to at most one article". Every structural edit
 * (split/merge/delete/assign) goes through this module, so the invariants hold
 * after edits, undo/redo replay and layout loads alike.
 *
 * Split rules (Task 18 fix round):
 * - the first part keeps the source region's id, the second part gets a fresh
 *   `<id>-<n>` suffix that is not used by any existing region (splitting the
 *   same region twice therefore never duplicates ids);
 * - both parts are inserted **immediately after** the source region in reading
 *   order and all orders are renumbered `0..n-1`, so the region that followed
 *   the source moves down instead of overtaking the new second part.
 *
 * All functions are pure: inputs are never mutated and every changed region is
 * a fresh object.
 */
import { intersects, normalizeBBox } from '../../shared/geometry/bbox'
import type { Article, ArticleId, PageSize, Region } from '../../shared/types'

/** The two collections that make up a saved layout. */
export interface LayoutSnapshot {
  regions: Region[]
  articles: Article[]
}

/** Regions in reading (`order`) order; ties keep the input order. */
export function sortRegionsByOrder(regions: readonly Region[]): Region[] {
  return regions
    .map((region, index) => ({ region, index }))
    .sort((left, right) => left.region.order - right.region.order || left.index - right.index)
    .map((entry) => entry.region)
}

/** Fresh region with a new id; `articleId` is set or removed explicitly. */
function withIdentity(region: Region, id: string, articleId: ArticleId | undefined): Region {
  const copy: Region = { ...region, id, bbox: { ...region.bbox }, lineIds: [...region.lineIds] }
  if (articleId === undefined) delete copy.articleId
  else copy.articleId = articleId
  return copy
}

/** Re-number `order` to `0..n-1` in reading order (ties keep the input order). */
function renumber(regions: readonly Region[]): Region[] {
  return sortRegionsByOrder(regions).map((region, order) => ({ ...region, order }))
}

/**
 * First id not used by `regions`, starting from `baseId` and appending `-2`,
 * `-3`, … until free. (`splitRegion` always returns `<id>-2` for the second
 * part; splitting the same region twice would otherwise duplicate that id.)
 */
export function uniqueRegionId(regions: readonly Region[], baseId: string): string {
  const taken = new Set(regions.map((region) => region.id))
  if (!taken.has(baseId)) return baseId
  let suffix = 2
  for (;;) {
    const candidate = `${baseId}-${suffix}`
    if (!taken.has(candidate)) return candidate
    suffix += 1
  }
}

/**
 * Make `Region.articleId` and `Article.regionIds` agree.
 *
 * `Article.regionIds` is read first (it is the article-side membership Task 5
 * assembles); a region listed by several articles stays with the first one and
 * is removed from the rest. A region whose `articleId` names an existing
 * article that did not list it is appended to that article. Every dangling id
 * is dropped, so both directions agree afterwards.
 */
export function reconcileLayout(
  regions: readonly Region[],
  articles: readonly Article[],
): LayoutSnapshot {
  const regionById = new Map(regions.map((region) => [region.id, region]))
  const articleById = new Map(articles.map((article) => [article.id, article]))
  const owners = new Map<string, ArticleId>()
  const nextArticles: Article[] = []

  for (const article of articles) {
    const regionIds: string[] = []
    const seen = new Set<string>()
    for (const regionId of article.regionIds) {
      if (!regionById.has(regionId) || seen.has(regionId) || owners.has(regionId)) continue
      seen.add(regionId)
      owners.set(regionId, article.id)
      regionIds.push(regionId)
    }
    // The region-side assignment may name this article without being listed.
    for (const region of regions) {
      if (region.articleId !== article.id) continue
      if (owners.has(region.id) || seen.has(region.id)) continue
      seen.add(region.id)
      owners.set(region.id, article.id)
      regionIds.push(region.id)
    }
    const unchanged =
      regionIds.length === article.regionIds.length &&
      regionIds.every((regionId, index) => regionId === article.regionIds[index])
    nextArticles.push(unchanged ? article : { ...article, regionIds })
  }

  const nextRegions = regions.map((region) => {
    const owner = owners.get(region.id)
    if (owner !== undefined) {
      return region.articleId === owner ? region : { ...region, articleId: owner }
    }
    if (region.articleId === undefined) return region
    // A stale `articleId` (missing article or a duplicate claim) is dropped.
    if (!articleById.has(region.articleId)) {
      const copy: Region = { ...region }
      delete copy.articleId
      return copy
    }
    return region
  })

  return { regions: nextRegions, articles: nextArticles }
}

/**
 * Assign the region to `articleId` (`null` = unassigned). The region is removed
 * from every other article first, so a region can never be shared by two
 * articles; both `Region.articleId` and `Article.regionIds` are updated.
 */
export function assignRegionToArticle(
  regions: readonly Region[],
  articles: readonly Article[],
  regionId: string,
  articleId: ArticleId | null,
): LayoutSnapshot {
  const targetExists = articleId !== null && articles.some((article) => article.id === articleId)
  const nextArticles = articles.map((article) => {
    const without = article.regionIds.filter((id) => id !== regionId)
    const nextIds =
      targetExists && article.id === articleId ? [...without, regionId] : without
    const unchanged =
      nextIds.length === article.regionIds.length &&
      nextIds.every((id, index) => id === article.regionIds[index])
    return unchanged ? article : { ...article, regionIds: nextIds }
  })
  const nextRegions = regions.map((region) => {
    if (region.id !== regionId) return region
    if (!targetExists) {
      if (region.articleId === undefined) return region
      const copy: Region = { ...region }
      delete copy.articleId
      return copy
    }
    return region.articleId === articleId ? region : { ...region, articleId }
  })
  return reconcileLayout(nextRegions, nextArticles)
}

/**
 * Apply a split result: the first part keeps the source id, the second part is
 * renamed to a unique id, both are inserted immediately after the source in
 * reading order, and the owning article lists both parts (deduplicated). An
 * unassigned source produces two unassigned parts.
 */
export function splitRegionsIntoLayout(
  regions: readonly Region[],
  articles: readonly Article[],
  sourceId: string,
  first: Region,
  second: Region,
): LayoutSnapshot {
  const ordered = sortRegionsByOrder(regions)
  const index = ordered.findIndex((region) => region.id === sourceId)
  if (index < 0) return reconcileLayout(regions, articles)

  const source = ordered[index]
  const owner = source.articleId
  const secondId = uniqueRegionId(regions, second.id)
  const firstPart = withIdentity(first, sourceId, owner)
  const secondPart = withIdentity(second, secondId, owner)

  const nextOrdered = [
    ...ordered.slice(0, index),
    firstPart,
    secondPart,
    ...ordered.slice(index + 1),
  ]
  const nextRegions = nextOrdered.map((region, order) => ({ ...region, order }))

  let nextArticles = articles.map((article) => {
    if (!article.regionIds.includes(sourceId)) return article
    return {
      ...article,
      regionIds: article.regionIds.filter((regionId) => regionId !== sourceId),
    }
  })
  if (owner !== undefined) {
    nextArticles = nextArticles.map((article) => {
      if (article.id !== owner) return article
      const kept = article.regionIds.filter(
        (regionId) => regionId !== firstPart.id && regionId !== secondPart.id,
      )
      return { ...article, regionIds: [...kept, firstPart.id, secondPart.id] }
    })
  }
  return reconcileLayout(nextRegions, nextArticles)
}

/**
 * Apply a merge result: the merged region takes the first region's slot
 * (renumbered), the owner article (first region's article, else the removed
 * region's article) lists it, and no article keeps pointing at either source id.
 */
export function mergeRegionsIntoLayout(
  regions: readonly Region[],
  articles: readonly Article[],
  firstId: string,
  secondId: string,
  merged: Region,
): LayoutSnapshot {
  const ordered = sortRegionsByOrder(regions)
  const index = ordered.findIndex((region) => region.id === firstId)
  if (index < 0) return reconcileLayout(regions, articles)

  const first = ordered[index]
  const second = ordered.find((region) => region.id === secondId)
  const owner = first.articleId ?? second?.articleId
  const mergedRegion = withIdentity(merged, firstId, owner)

  const nextRegions = ordered
    .map((region) => (region.id === firstId ? mergedRegion : region))
    .filter((region) => region.id !== secondId)
    .map((region, order) => ({ ...region, order }))

  const nextArticles = articles.map((article) => {
    const kept = article.regionIds.filter(
      (regionId) =>
        regionId !== firstId && regionId !== secondId && regionId !== mergedRegion.id,
    )
    if (owner !== undefined && article.id === owner) {
      return { ...article, regionIds: [...kept, mergedRegion.id] }
    }
    return kept.length === article.regionIds.length ? article : { ...article, regionIds: kept }
  })
  return reconcileLayout(nextRegions, nextArticles)
}

/** Remove a region and every article reference to it. */
export function deleteRegionFromLayout(
  regions: readonly Region[],
  articles: readonly Article[],
  regionId: string,
): LayoutSnapshot {
  const nextRegions = renumber(regions.filter((region) => region.id !== regionId))
  const nextArticles = articles.map((article) => {
    if (!article.regionIds.includes(regionId)) return article
    return {
      ...article,
      regionIds: article.regionIds.filter((id) => id !== regionId),
    }
  })
  return reconcileLayout(nextRegions, nextArticles)
}

/* ------------------------------------------------------------------------- */
/* Warnings                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Client-side layout warnings recomputed after every edit (design §6.5):
 * overlapping regions, regions not assigned to an article, articles without any
 * region and regions whose box leaves the page.
 */
export interface LayoutWarningSummary {
  /** Number of overlapping region pairs (each pair counted once). */
  overlapCount: number
  /** Ids of regions involved in at least one overlap. */
  overlapRegionIds: string[]
  /** Ids of regions that no article lists. */
  unassignedRegionIds: string[]
  /** Ids of articles without any region. */
  emptyArticleIds: ArticleId[]
  /** Ids of regions whose box is not fully inside the page. */
  outOfPageRegionIds: string[]
  /** Number of warning entries (pairs + regions + articles). */
  total: number
}

const OUT_OF_PAGE_EPSILON = 1e-6

/** Recompute the layout warning lists from the current regions/articles. */
export function computeLayoutWarnings(
  regions: readonly Region[],
  articles: readonly Article[],
  page: PageSize,
): LayoutWarningSummary {
  const assigned = new Set<string>()
  for (const article of articles) {
    for (const regionId of article.regionIds) assigned.add(regionId)
  }

  const overlapIds = new Set<string>()
  let overlapCount = 0
  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      if (!intersects(regions[left].bbox, regions[right].bbox)) continue
      overlapCount += 1
      overlapIds.add(regions[left].id)
      overlapIds.add(regions[right].id)
    }
  }

  const unassignedRegionIds = regions
    .filter((region) => !assigned.has(region.id))
    .map((region) => region.id)

  const emptyArticleIds = articles
    .filter((article) => article.regionIds.length === 0)
    .map((article) => article.id)

  const outOfPageRegionIds = regions
    .filter((region) => {
      const box = normalizeBBox(region.bbox)
      return (
        box.x < -OUT_OF_PAGE_EPSILON ||
        box.y < -OUT_OF_PAGE_EPSILON ||
        box.x + box.w > page.widthPt + OUT_OF_PAGE_EPSILON ||
        box.y + box.h > page.heightPt + OUT_OF_PAGE_EPSILON
      )
    })
    .map((region) => region.id)

  return {
    overlapCount,
    overlapRegionIds: [...overlapIds],
    unassignedRegionIds,
    emptyArticleIds,
    outOfPageRegionIds,
    total: overlapCount + unassignedRegionIds.length + emptyArticleIds.length + outOfPageRegionIds.length,
  }
}

/** Warning flags shown for one region in the inspector. */
export interface RegionWarningFlags {
  overlapping: boolean
  unassigned: boolean
  outOfPage: boolean
}

/** Per-region projection of {@link LayoutWarningSummary}. */
export function regionWarningFlags(
  warnings: LayoutWarningSummary,
  regionId: string,
): RegionWarningFlags {
  return {
    overlapping: warnings.overlapRegionIds.includes(regionId),
    unassigned: warnings.unassignedRegionIds.includes(regionId),
    outOfPage: warnings.outOfPageRegionIds.includes(regionId),
  }
}

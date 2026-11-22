import type {
  Article,
  BBox,
  CandidateBlock,
  PageSize,
  Region,
  TextLine,
} from '../types'
import type { VisionArticle, VisionLayout, VisionRegion } from './vision-schema'
import { bboxCenter, containsPoint, normalizeBBox, unionBBox } from '../geometry/bbox'
import { buildCleanBody, cleanTextSpacing, renderArticleFullText } from '../text/clean'

/**
 * Deterministic article assembly for one newspaper page (the core seam of the
 * layout pipeline).
 *
 * Inputs are the clustered text lines of one page (Task 2), the deterministic
 * candidate blocks (Task 3) and the validated vision layout (Task 4). The
 * function is pure: it never mutates its inputs, never reads a clock, the
 * environment or I/O, and returns the same result for the same input.
 *
 * Page coordinates are top-left origin with `y` growing downward: `bbox.y` is
 * the top edge, a smaller `y` is higher on the page, and reading order is
 * `column asc`, then `bbox.y asc`, then `bbox.x asc`.
 *
 * Pipeline:
 * 1. **Region map.** Every classified vision region resolves to exactly one
 *    candidate block; regions are put in page reading order and get the stable
 *    ids `r1`, `r2`, … (`Region.order` is the 0-based rank). A region's
 *    assignment box is the union of its candidate's line boxes (the candidate's
 *    own `bbox` is only a fallback for blocks whose lines are not in the text
 *    layer), because the candidate line ids are authoritative and the candidate
 *    bbox may have been clamped to the page. `Region.source` is `vision` for a
 *    confident classification and `fallback` for a model confidence below 0.4;
 *    `manual` is only produced by the manual editor (Task 18).
 * 2. **Line assignment.** Each line is assigned exactly once to the region its
 *    bbox overlaps most (a line that straddles several regions goes to the
 *    majority region); equal overlaps go to the smaller box and then to the box
 *    containing the line's centre. A line that meaningfully straddles more than
 *    one region is reported. Lines outside every region stay unassigned.
 * 3. **Membership.** Article membership is the union of `article.regionIds` and
 *    every region whose `articleGroup === article.id`. A non-empty
 *    `articleGroup` is authoritative: a region listed by another article (or by
 *    several articles) keeps its group and a warning is recorded. Regions with
 *    no group and no claim stay unassigned.
 * 4. **Article text.** Lines are sorted in reading order (column, then
 *    top-to-bottom, then left-to-right). The 1–3 contiguous largest-font lines
 *    at the top of the `titleCandidateId` region (falling back to the first
 *    region) form the title; only the line directly below it that is clearly
 *    larger than the body becomes the subtitle; the first line matching the
 *    byline prefixes is the byline; the rest is the body. Lines are merged
 *    without newlines: CJK joins directly, Latin/digit tokens keep one space.
 * 5. **Diagnostics.** Coverage excludes masthead/header/footer/ad text;
 *    overlap counts article line claims that are duplicated before the
 *    `articleGroup` authority resolves them; warnings cover low coverage,
 *    unassigned lines, spanning lines, membership conflicts, a title font close
 *    to the body font, short bodies and continuation hints.
 *
 * The product is single-page only: a `下转`/`上接` hint is reported, never
 * joined with another page.
 */

/** Everything article assembly needs for one page. */
export interface AssembleInput {
  page: PageSize
  lines: readonly TextLine[]
  candidates: readonly CandidateBlock[]
  vision: VisionLayout
}

/** Page-level assembly diagnostics. */
export interface AssembleStats {
  /** Assigned non-header/footer characters / covered characters (1 when empty). */
  coverage: number
  /** Article line claims that are duplicated before authority resolution / total claims. */
  overlap: number
  /** Ids of lines no region contains, in input order. */
  unassignedLineIds: string[]
}

/** Deterministic result of one assembly pass. */
export interface AssembleResult {
  regions: Region[]
  articles: Article[]
  warnings: string[]
  stats: AssembleStats
}

/* ------------------------------------------------------------------------- */
/* Constants                                                                   */
/* ------------------------------------------------------------------------- */

/** Region kinds whose text is page furniture, not article text. */
const EXCLUDED_KINDS: ReadonlySet<Region['kind']> = new Set<Region['kind']>([
  'masthead',
  'header',
  'footer',
  'ad',
])

/** A region is marked `fallback` when the model confidence is below this. */
const FALLBACK_CONFIDENCE_BELOW = 0.4

/** Coverage below this ratio produces a warning. */
const MIN_COVERAGE = 0.8

/** A body shorter than this many characters is suspicious. */
const MIN_BODY_CHARS = 40

/** A title line's font size must be at least this fraction of the title region's largest font. */
const TITLE_FONT_RATIO = 0.85

/** A title joins at most this many lines (spec §6.3 allows 1–3 title rows). */
const MAX_TITLE_LINES = 3

/** A subtitle must be at least this much larger than the body median font. */
const SUBTITLE_FONT_RATIO = 1.15

/** A title must be at least this much larger than the body median font. */
const TITLE_BODY_RATIO = 1.1

/** A crossing line only warns when the runner-up region covers at least this share of it. */
const MIN_SPANNING_OVERLAP_RATIO = 0.1

/** How many unassigned line ids are listed in one warning. */
const MAX_WARNING_LINE_IDS = 10

/** Byline prefixes from the spec; anchored so a mid-sentence 「记者」 is not one. */
const BYLINE_PATTERN = /^(本报讯|本报记者|记者|通讯员|新华社)/

/** Leading decorative marks used before a byline in some papers (e.g. `■本报记者`). */
const BYLINE_MARK_PREFIX = /^[■●□◆◇★☆▪▫·\s]+/

/** A byline label that is followed by the author name on the next line. */
const BYLINE_LABEL_ONLY = /^(本报讯|本报记者|记者|通讯员|新华社)$/

/** A short Chinese name line directly after `■本报记者` is the author, not body. */
const BYLINE_NAME = /^[\u3400-\u4DBF\u4E00-\u9FFF·]{1,12}$/

/** A name-only byline line: 2–6 Han characters (or a middle-dot name). */
const NAME_ONLY_BYLINE = /^[\u3400-\u4DBF\u4E00-\u9FFF·]{2,6}$/

/**
 * Common Chinese surnames used to reject short bold/phrase lines (`砥砺前行`)
 * as a name-only byline. Prefix bylines (`本报记者`, etc.) are unaffected; this
 * guard only applies to the heuristic name-only path.
 */
const COMMON_SURNAMES = new Set(
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明佘池查麻苑迟邝封淡楚盖益桓公'
    .split(''),
)

/** True when a short Han string starts with a common surname (name heuristic). */
function looksLikePersonName(text: string): boolean {
  return COMMON_SURNAMES.has(text.charAt(0))
}

/** Sentence-final punctuation: a byline inserted mid-sentence is preceded by text without it. */
const SENTENCE_END = /[。！？；：.!?;:]$/

/** `下转第2版` / `上接第3版` / `（下转二版）` continuation hint. */
const CONTINUATION_PATTERN = /(下转|上接)第?\s*[一二三四五六七八九十0-9]+\s*版/

/**
 * Characters that join without an inter-word space: CJK radicals and
 * punctuation, kana, Bopomofo, Hangul, CJK unified ideographs and full-width
 * forms. Mirrors the class used by `clusterTextItems` (Task 2).
 */
const CJK_CHAR =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** ASCII letters and digits: the tokens that keep a space across a soft wrap. */
const LATIN_WORD_CHAR = /[0-9A-Za-z]/

/* ------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* ------------------------------------------------------------------------- */

/** Stable code-unit comparison; never locale-dependent. */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Median of a numeric list (mean of the two middle values); 0 when empty. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Normalize an inverted box and clamp it inside the page. */
function clampBBoxToPage(box: BBox, page: PageSize): BBox {
  const normalized = normalizeBBox(box)
  const width = Math.max(0, page.widthPt)
  const height = Math.max(0, page.heightPt)
  const x = clamp(normalized.x, 0, width)
  const y = clamp(normalized.y, 0, height)
  const right = clamp(normalized.x + normalized.w, 0, width)
  const bottom = clamp(normalized.y + normalized.h, 0, height)
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}

/** Area of the intersection of two normalized boxes (0 when they do not overlap). */
function boxOverlapArea(a: BBox, b: BBox): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function isCjkChar(char: string): boolean {
  return char !== '' && CJK_CHAR.test(char)
}

function isLatinWordChar(char: string): boolean {
  return char !== '' && LATIN_WORD_CHAR.test(char)
}

/** Placeholder for a line-internal soft wrap while it is being normalized. */
const SOFT_WRAP = '\u0000'

/**
 * Collapse a line to one physical line. Line-internal spaces are kept (a
 * byline such as `本报讯 记者 张三` must survive intact); only a `\r`/`\n`/tab
 * soft wrap is removed — directly between two CJK characters, otherwise as one
 * space — and the ends are trimmed, so no `\n` can reach an article.
 */
function normalizeLineText(text: string): string {
  const marked = text.replace(/[ \t\f\v]*[\r\n]+[ \t\f\v]*/g, SOFT_WRAP)
  let unwrapped = ''
  for (let index = 0; index < marked.length; index += 1) {
    const char = marked[index]
    if (char !== SOFT_WRAP) {
      unwrapped += char
      continue
    }
    const left = unwrapped.slice(-1)
    const right = marked.charAt(index + 1)
    if (!(isCjkChar(left) && isCjkChar(right))) unwrapped += ' '
  }
  return unwrapped.replace(/[\t\f\v]/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/** Trimmed one-line text of a line (title/byline/subtitle extraction). */
function singleLineText(text: string): string {
  return normalizeLineText(text)
}

/** Normalize a byline for matching by removing leading decorative marks. */
function bylineMatchText(text: string): string {
  return singleLineText(text).replace(BYLINE_MARK_PREFIX, '')
}

/**
 * Find a name-only byline inserted in the body stream.
 *
 * Some layouts put the author name in its own larger-font line at the top of a
 * later column, so the prefix-based byline detector misses it and the name is
 * merged into the body. Such a line is a short Han name, larger than the body
 * font, and sits between two non-sentence-final body lines (the author name is
 * often dropped into the middle of a sentence by the column reading order).
 */
function findNameOnlyByline(
  entries: readonly LineEntry[],
  bodyFontSize: number,
): LineEntry | undefined {
  if (entries.length < 3 || bodyFontSize <= 0) return undefined
  for (let index = 1; index < entries.length - 1; index += 1) {
    const entry = entries[index]
    const text = cleanTextSpacing(singleLineText(entry.line.text))
    if (!NAME_ONLY_BYLINE.test(text)) continue
    if (!looksLikePersonName(text)) continue
    if (entry.line.fontSize < bodyFontSize * 1.12) continue
    const before = entries[index - 1]
    const after = entries[index + 1]
    if (cleanTextSpacing(singleLineText(before.line.text)) === '') continue
    if (cleanTextSpacing(singleLineText(after.line.text)) === '') continue
    if (SENTENCE_END.test(cleanTextSpacing(singleLineText(before.line.text)))) continue
    return entry
  }
  return undefined
}

/**
 * Merge lines into one paragraph: no `\n`, no line-end whitespace, CJK joined
 * directly, and one space between two Latin/digit tokens that a soft wrap split.
 */
function mergeLineTexts(lines: readonly TextLine[]): string {
  let text = ''
  for (const line of lines) {
    const part = normalizeLineText(line.text)
    if (part === '') continue
    if (text !== '') {
      const left = text.slice(-1)
      const right = part.charAt(0)
      const boundaryIsCjk = isCjkChar(left) || isCjkChar(right)
      if (!boundaryIsCjk && (isLatinWordChar(left) || isLatinWordChar(right))) {
        text += ' '
      }
    }
    text += part
  }
  return text
}

/** `0.5` → `50.0%`; fixed decimal digits for deterministic warning strings. */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** `part / whole` as a whole percent for deterministic warning strings. */
function formatOverlapShare(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`
}

/* ------------------------------------------------------------------------- */
/* Internal shapes                                                             */
/* ------------------------------------------------------------------------- */

/** One input line with its normalized box and input position. */
interface LineEntry {
  line: TextLine
  index: number
  box: BBox
}

/** One candidate block with its input position. */
interface CandidateEntry {
  candidate: CandidateBlock
  index: number
}

/** One vision article with its input position. */
interface ArticleEntry {
  article: VisionArticle
  index: number
}

/** A region being assembled; `order`/`id` are assigned after the page sort. */
interface RegionDraft {
  candidateId: string
  kind: Region['kind']
  articleGroup: string
  readingOrder: number
  confidence: number
  candidateIndex: number
  /** Box used to decide which lines belong to this region. */
  assignmentBox: BBox
  /** Assigned line indexes, sorted in reading order. */
  lineIndexes: number[]
  order: number
  id: string
}

/** Reading order of article lines: column, then top-to-bottom, then left-to-right. */
function compareLineEntries(a: LineEntry, b: LineEntry): number {
  return (
    a.line.column - b.line.column ||
    a.box.y - b.box.y ||
    a.box.x - b.box.x ||
    b.line.fontSize - a.line.fontSize ||
    compareText(a.line.text, b.line.text) ||
    a.index - b.index
  )
}

/** Article page order: the vision order, ties by input position. */
function orderArticles(articles: readonly VisionArticle[]): ArticleEntry[] {
  return articles
    .map((article, index) => ({ article, index }))
    .sort((a, b) => a.article.order - b.article.order || a.index - b.index)
}

/* ------------------------------------------------------------------------- */
/* Region map                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Turn the vision regions into page-ordered drafts with stable `rN` ids and an
 * assignment box. A vision region whose candidate block is unknown (the layout
 * is expected to be validated by `parseVisionLayout`) is ignored; a candidate
 * classified twice keeps its first region.
 */
function buildRegionDrafts(
  candidates: readonly CandidateBlock[],
  visionRegions: readonly VisionRegion[],
  lineById: ReadonlyMap<string, LineEntry>,
): RegionDraft[] {
  const candidateById = new Map<string, CandidateEntry>()
  candidates.forEach((candidate, index) => {
    if (!candidateById.has(candidate.candidateId)) {
      candidateById.set(candidate.candidateId, { candidate, index })
    }
  })

  const drafts: RegionDraft[] = []
  const seenCandidates = new Set<string>()
  for (const visionRegion of visionRegions) {
    const candidateEntry = candidateById.get(visionRegion.candidateId)
    if (candidateEntry === undefined || seenCandidates.has(visionRegion.candidateId)) continue
    seenCandidates.add(visionRegion.candidateId)

    const declaredLines: TextLine[] = []
    const declared = new Set<string>()
    for (const lineId of candidateEntry.candidate.lineIds) {
      const lineEntry = lineById.get(lineId)
      if (lineEntry === undefined || declared.has(lineId)) continue
      declared.add(lineId)
      declaredLines.push(lineEntry.line)
    }
    // The candidate's line ids are authoritative: derive the box from the real
    // line geometry and only use the candidate bbox when those lines are absent.
    const assignmentBox =
      unionBBox(declaredLines.map((line) => line.bbox)) ??
      normalizeBBox(candidateEntry.candidate.bbox)

    drafts.push({
      candidateId: visionRegion.candidateId,
      kind: visionRegion.kind,
      articleGroup: visionRegion.articleGroup.trim(),
      readingOrder: visionRegion.readingOrder,
      confidence: visionRegion.confidence,
      candidateIndex: candidateEntry.index,
      assignmentBox,
      lineIndexes: [],
      order: 0,
      id: '',
    })
  }

  drafts.sort(
    (a, b) =>
      a.readingOrder - b.readingOrder ||
      a.candidateIndex - b.candidateIndex ||
      compareText(a.candidateId, b.candidateId),
  )
  return drafts.map((draft, index) => ({ ...draft, order: index, id: `r${index + 1}` }))
}

/** Result of the line-to-region pass: the region index per line plus ambiguity warnings. */
interface LineAssignment {
  assigned: Array<number | undefined>
  warnings: string[]
}

function regionArea(box: BBox): number {
  return box.w * box.h
}

/**
 * Assign every line to at most one region: the region whose box it overlaps
 * most (a line straddling two blocks goes to the region covering the majority
 * of it, as spec §6.3 requires). Equal overlaps go to the smaller region, then
 * to the region containing the line's centre, then to the earlier page-order
 * region. A line whose winning region does not cover all of it while another
 * region still covers a meaningful share is reported as a crossing line, but
 * keeps the majority assignment. Returns the region index per input line and
 * fills every draft's reading-ordered `lineIndexes`.
 */
function assignLines(
  drafts: RegionDraft[],
  lineEntries: readonly LineEntry[],
): LineAssignment {
  const assigned: Array<number | undefined> = []
  const warnings: string[] = []

  for (const entry of lineEntries) {
    const center = bboxCenter(entry.line.bbox)
    const lineArea = regionArea(entry.box)
    const hits: Array<{ regionIndex: number; overlap: number }> = []
    for (let regionIndex = 0; regionIndex < drafts.length; regionIndex += 1) {
      const overlap = boxOverlapArea(entry.box, drafts[regionIndex].assignmentBox)
      if (overlap > 0) hits.push({ regionIndex, overlap })
    }

    if (hits.length === 0) {
      // Only a degenerate (zero-size) line has no positive overlap; keep the
      // centre rule for it so it can still be placed.
      let bestRegion = -1
      let bestArea = Number.POSITIVE_INFINITY
      for (let regionIndex = 0; regionIndex < drafts.length; regionIndex += 1) {
        const box = drafts[regionIndex].assignmentBox
        if (!containsPoint(box, center)) continue
        const area = regionArea(box)
        if (area < bestArea) {
          bestArea = area
          bestRegion = regionIndex
        }
      }
      assigned.push(bestRegion < 0 ? undefined : bestRegion)
      continue
    }

    hits.sort((a, b) => {
      const boxA = drafts[a.regionIndex].assignmentBox
      const boxB = drafts[b.regionIndex].assignmentBox
      return (
        b.overlap - a.overlap ||
        regionArea(boxA) - regionArea(boxB) ||
        Number(containsPoint(boxB, center)) - Number(containsPoint(boxA, center)) ||
        a.regionIndex - b.regionIndex
      )
    })
    const winner = hits[0]
    assigned.push(winner.regionIndex)

    const runnerUp = hits[1]
    if (
      runnerUp !== undefined &&
      lineArea > 0 &&
      winner.overlap < lineArea &&
      runnerUp.overlap >= lineArea * MIN_SPANNING_OVERLAP_RATIO
    ) {
      warnings.push(
        `行 ${entry.line.id} 跨越多个区域（重叠 ${formatOverlapShare(winner.overlap, lineArea)} / ${formatOverlapShare(runnerUp.overlap, lineArea)}），跨区域行按多数归属 ${drafts[winner.regionIndex].id}`,
      )
    }
  }

  const linesByRegion: LineEntry[][] = drafts.map(() => [])
  lineEntries.forEach((entry, lineIndex) => {
    const regionIndex = assigned[lineIndex]
    if (regionIndex === undefined) return
    linesByRegion[regionIndex].push(entry)
  })
  drafts.forEach((draft, regionIndex) => {
    linesByRegion[regionIndex].sort(compareLineEntries)
    draft.lineIndexes = linesByRegion[regionIndex].map((entry) => entry.index)
  })
  return { assigned, warnings }
}

/* ------------------------------------------------------------------------- */
/* Membership                                                                  */
/* ------------------------------------------------------------------------- */

/** Resolved article ownership plus the raw claims used for the overlap stat. */
interface MembershipResolution {
  /** Owning article id per region (`undefined` = unassigned). */
  owners: Array<string | undefined>
  /** Article ids claiming each region before `articleGroup` authority. */
  claimants: string[][]
  warnings: string[]
}

/**
 * Resolve which article owns each region.
 *
 * `membership = union(article.regionIds, regions whose articleGroup === article.id)`:
 * a region named by an article's `regionIds` is claimed by that article and a
 * region whose `articleGroup` names an article is claimed by it as well. A
 * non-empty `articleGroup` is authoritative when the two sources disagree; a
 * region claimed by several articles and a disagreement between the group and
 * `regionIds` both produce a warning. A region with an empty group is
 * unassigned unless exactly one article claims it; when several claim it, the
 * first article in page order owns it and a warning is recorded.
 */
function resolveMembership(
  drafts: readonly RegionDraft[],
  articles: readonly VisionArticle[],
): MembershipResolution {
  const orderedArticles = orderArticles(articles)
  const articleById = new Map<string, ArticleEntry>()
  for (const entry of orderedArticles) {
    if (!articleById.has(entry.article.id)) articleById.set(entry.article.id, entry)
  }

  const regionIndexByCandidateId = new Map<string, number>()
  drafts.forEach((draft, index) => {
    if (!regionIndexByCandidateId.has(draft.candidateId)) {
      regionIndexByCandidateId.set(draft.candidateId, index)
    }
  })

  const warnings: string[] = []
  const claimsByRegion = new Map<number, string[]>()
  const warnedMissing = new Set<string>()
  for (const entry of orderedArticles) {
    const articleId = entry.article.id
    const seenCandidates = new Set<string>()
    for (const candidateId of entry.article.regionIds) {
      if (seenCandidates.has(candidateId)) continue
      seenCandidates.add(candidateId)
      const regionIndex = regionIndexByCandidateId.get(candidateId)
      if (regionIndex === undefined) {
        const key = `${articleId}\u0000${candidateId}`
        if (!warnedMissing.has(key)) {
          warnedMissing.add(key)
          warnings.push(`文章 ${articleId} 的 regionIds 引用了未知候选块 ${candidateId}`)
        }
        continue
      }
      const claimed = claimsByRegion.get(regionIndex)
      if (claimed === undefined) claimsByRegion.set(regionIndex, [articleId])
      else claimed.push(articleId)
    }
  }

  const owners: Array<string | undefined> = []
  const claimants: string[][] = []
  drafts.forEach((draft, regionIndex) => {
    const claims = claimsByRegion.get(regionIndex) ?? []
    const group = draft.articleGroup
    const groupIsKnownArticle = group !== '' && articleById.has(group)

    if (groupIsKnownArticle) {
      claimants.push([group, ...claims.filter((claim) => claim !== group)])
      owners.push(group)
      if (claims.length > 1) {
        warnings.push(
          `候选块 ${draft.candidateId} 被多篇文章声明（${claims.join('、')}），以 articleGroup=${group} 为准`,
        )
      } else if (claims.length === 1 && claims[0] !== group) {
        warnings.push(
          `候选块 ${draft.candidateId} 的 articleGroup=${group} 与文章 ${claims[0]} 的 regionIds 不一致，以 articleGroup 为准`,
        )
      }
      return
    }

    if (group !== '') {
      // No article has this id, so the group cannot be authoritative.
      claimants.push([...claims])
      const owner = claims[0]
      owners.push(owner)
      if (claims.length > 1) {
        warnings.push(
          `候选块 ${draft.candidateId} 的 articleGroup=${group} 不是已知文章，且被多篇文章声明（${claims.join('、')}），已按文章顺序归入 ${owner}`,
        )
      } else if (claims.length === 1) {
        warnings.push(
          `候选块 ${draft.candidateId} 的 articleGroup=${group} 不是已知文章，已按 regionIds 归入 ${owner}`,
        )
      } else {
        warnings.push(
          `候选块 ${draft.candidateId} 的 articleGroup=${group} 不是已知文章，暂不归属`,
        )
      }
      return
    }

    claimants.push([...claims])
    if (claims.length > 1) {
      owners.push(claims[0])
      warnings.push(
        `候选块 ${draft.candidateId} 未声明 articleGroup，被多篇文章 regionIds 声明（${claims.join('、')}），已按文章顺序归入 ${claims[0]}`,
      )
    } else {
      owners.push(claims[0])
    }
  })

  return { owners, claimants, warnings }
}

/* ------------------------------------------------------------------------- */
/* Article text                                                                */
/* ------------------------------------------------------------------------- */

/** Wide-enough lines used to infer the real body columns of one article. */
const COLUMN_FRAGMENT_WIDTH_RATIO = 0.55
/** Minimum number of wide body lines before detached-fragment filtering runs. */
const MIN_COLUMN_BAND_LINES = 3
/** Font-relative slack when deciding whether a short line belongs to a column. */
const COLUMN_BAND_SLACK_RATIO = 0.5

/**
 * Drop short text fragments that sit completely outside every body column of an
 * article.
 *
 * Real page text is occasionally captured inside a neighbouring article's
 * rectangular region: a photo caption in the gutter, a sidebar, or a fragment of
 * an image label. The region rectangle still covers it, but the fragment's
 * narrow box is detached from all wide text columns. The deterministic repair
 * below keeps wide lines (and short lines whose centre/overlap falls inside a
 * wide-line column band), so legitimate indented/short paragraph endings and
 * multi-column articles survive, while detached caption fragments do not leak
 * into the body.
 *
 * This is deliberately narrow: it only runs when the article has at least
 * `MIN_COLUMN_BAND_LINES` wide lines, and it never changes the region map,
 * coverage statistics or title/byline detection.
 */
function dropDetachedColumnFragments(entries: readonly LineEntry[]): LineEntry[] {
  if (entries.length < MIN_COLUMN_BAND_LINES) return [...entries]
  const widths = entries.map((entry) => entry.box.w).filter((width) => width > 0).sort((a, b) => a - b)
  if (widths.length === 0) return [...entries]
  const medianWidth = (() => {
    const middle = Math.floor(widths.length / 2)
    return widths.length % 2 === 0
      ? (widths[middle - 1] + widths[middle]) / 2
      : widths[middle]
  })()
  if (medianWidth <= 0) return [...entries]

  const wide = entries.filter((entry) => entry.box.w >= medianWidth * COLUMN_FRAGMENT_WIDTH_RATIO)
  if (wide.length < MIN_COLUMN_BAND_LINES) return [...entries]
  const medianFont = median(wide.map((entry) => entry.line.fontSize))
  const slack = Math.max(1.5, medianFont * COLUMN_BAND_SLACK_RATIO)

  // Merge wide-line horizontal intervals into body-column bands. A short line is
  // kept when it sits inside a band; detached caption/sidebar fragments are not.
  const bands: Array<{ left: number; right: number }> = []
  for (const entry of [...wide].sort((a, b) => a.box.x - b.box.x || a.box.w - b.box.w)) {
    const left = entry.box.x
    const right = entry.box.x + entry.box.w
    const last = bands[bands.length - 1]
    if (last !== undefined && left <= last.right + slack) {
      last.right = Math.max(last.right, right)
    } else {
      bands.push({ left, right })
    }
  }

  return entries.filter((entry) => {
    if (entry.box.w >= medianWidth * COLUMN_FRAGMENT_WIDTH_RATIO) return true
    const left = entry.box.x
    const right = entry.box.x + entry.box.w
    const center = left + entry.box.w / 2
    return bands.some((band) => {
      const overlap = Math.min(right, band.right) - Math.max(left, band.left)
      return (
        (center >= band.left - slack && center <= band.right + slack) ||
        overlap >= entry.box.w * 0.5
      )
    })
  })
}

/** Largest-font line of a non-empty reading-ordered pool (first wins ties). */
function pickLargestLine(pool: readonly LineEntry[]): LineEntry | undefined {
  let best: LineEntry | undefined
  for (const entry of pool) {
    if (best === undefined || entry.line.fontSize > best.line.fontSize) best = entry
  }
  return best
}

/**
 * Title = the 1–3 contiguous lines at the top of the title region whose font
 * size is at least `0.85 ×` the region's largest font, so body-size lines are
 * never dragged into the title. When even the top line does not qualify (noisy
 * layout) the single largest line is used instead.
 */
function pickTitleLines(pool: readonly LineEntry[]): LineEntry[] {
  if (pool.length === 0) return []
  const maxFontSize = Math.max(...pool.map((entry) => entry.line.fontSize))
  const minTitleFontSize = maxFontSize * TITLE_FONT_RATIO
  const titleLines: LineEntry[] = []
  for (const entry of pool) {
    if (titleLines.length >= MAX_TITLE_LINES) break
    if (entry.line.fontSize < minTitleFontSize) break
    titleLines.push(entry)
  }
  if (titleLines.length === 0) {
    const largest = pickLargestLine(pool)
    if (largest !== undefined) titleLines.push(largest)
  }
  return titleLines
}

/**
 * Subtitle = only the line directly below the title block (the first remaining
 * line in reading order), and only when it is clearly larger than the body
 * median font (×1.15). A body-size or near-body-size line always stays in the
 * body even when it is the largest remaining line.
 */
function pickSubtitle(bodyPool: readonly LineEntry[]): LineEntry | undefined {
  const candidate = bodyPool[0]
  if (candidate === undefined) return undefined
  const bodyFontSize = median(bodyPool.slice(1).map((entry) => entry.line.fontSize))
  if (bodyFontSize <= 0) return undefined
  return candidate.line.fontSize > bodyFontSize * SUBTITLE_FONT_RATIO ? candidate : undefined
}

/** Detect a `下转`/`上接` hint in the article text or fall back to the vision hint. */
function detectContinuation(
  articleLines: readonly LineEntry[],
  visionArticle: VisionArticle,
): Article['continuation'] {
  for (const entry of articleLines) {
    const match = CONTINUATION_PATTERN.exec(singleLineText(entry.line.text))
    if (match !== null) {
      return { direction: match[1] === '上接' ? 'up' : 'down' }
    }
  }
  if (visionArticle.continuation !== 'none') {
    return {
      direction: visionArticle.continuation,
      note: '视觉分区提示续文，正文中未检测到',
    }
  }
  return undefined
}

/** Build one article from its owned regions and reading-ordered lines. */
function buildArticle(
  visionArticle: VisionArticle,
  readingOrder: number,
  drafts: readonly RegionDraft[],
  owners: ReadonlyArray<string | undefined>,
  lineEntries: readonly LineEntry[],
): Article {
  const memberRegions: RegionDraft[] = []
  drafts.forEach((draft, regionIndex) => {
    if (owners[regionIndex] === visionArticle.id) memberRegions.push(draft)
  })

  const lineIndexes = new Set<number>()
  for (const region of memberRegions) {
    for (const lineIndex of region.lineIndexes) lineIndexes.add(lineIndex)
  }
  const articleLines = [...lineIndexes]
    .map((lineIndex) => lineEntries[lineIndex])
    .sort(compareLineEntries)

  const titleCandidateRegion = memberRegions.find(
    (region) => region.candidateId === visionArticle.titleCandidateId,
  )
  const titleRegion =
    titleCandidateRegion !== undefined && titleCandidateRegion.lineIndexes.length > 0
      ? titleCandidateRegion
      : memberRegions.find((region) => region.lineIndexes.length > 0)
  const titlePool =
    titleRegion !== undefined
      ? titleRegion.lineIndexes.map((lineIndex) => lineEntries[lineIndex]).sort(compareLineEntries)
      : articleLines
  const titleLines = pickTitleLines(titlePool)
  const titleLineIndexes = new Set(titleLines.map((entry) => entry.index))
  const title = cleanTextSpacing(titleLines.map((entry) => singleLineText(entry.line.text)).join(''))
  const titleFontSize =
    titleLines.length === 0 ? 0 : Math.max(...titleLines.map((entry) => entry.line.fontSize))

  const remaining = articleLines.filter((entry) => !titleLineIndexes.has(entry.index))
  const prefixByline = remaining.find((entry) =>
    BYLINE_PATTERN.test(bylineMatchText(entry.line.text)),
  )
  const nameOnlyByline =
    prefixByline === undefined
      ? findNameOnlyByline(
          remaining,
          median(remaining.map((entry) => entry.line.fontSize)),
        )
      : undefined
  const bylineLine = prefixByline ?? nameOnlyByline
  const bylineIsNameOnly = prefixByline === undefined && nameOnlyByline !== undefined
  const bylinePos = bylineLine === undefined ? -1 : remaining.indexOf(bylineLine)
  const bylineLabel =
    bylineLine === undefined
      ? ''
      : bylineIsNameOnly
        ? cleanTextSpacing(singleLineText(bylineLine.line.text))
        : bylineMatchText(bylineLine.line.text)
  const bylineNameLine =
    !bylineIsNameOnly &&
    bylineLine !== undefined &&
    BYLINE_LABEL_ONLY.test(bylineLabel) &&
    bylinePos >= 0 &&
    bylinePos + 1 < remaining.length
      ? remaining[bylinePos + 1]
      : undefined
  const bylineName =
    bylineNameLine !== undefined
      ? cleanTextSpacing(singleLineText(bylineNameLine.line.text))
      : ''
  const bylineNameIsAuthor =
    bylineName !== '' && BYLINE_NAME.test(bylineName) && !/[，。；：！？,.!?]/.test(bylineName)
  const excludedBylineIndexes = new Set<number>()
  if (bylineLine !== undefined) excludedBylineIndexes.add(bylineLine.index)
  if (bylineNameIsAuthor && bylineNameLine !== undefined) {
    excludedBylineIndexes.add(bylineNameLine.index)
  }
  const afterByline = remaining.filter((entry) => !excludedBylineIndexes.has(entry.index))
  const subtitleLine = pickSubtitle(afterByline)
  const bodyCandidates = afterByline.filter((entry) => entry.index !== subtitleLine?.index)
  const bodyLines = dropDetachedColumnFragments(bodyCandidates)
  const body = buildCleanBody(
    bodyLines.map((entry) => entry.line),
    (paragraph) => mergeLineTexts(paragraph),
  )
  const bodyFontSize = median(bodyLines.map((entry) => entry.line.fontSize))

  const article: Article = {
    id: visionArticle.id,
    page: 1,
    role: visionArticle.role,
    title,
    body,
    regionIds: memberRegions.map((region) => region.id),
    readingOrder,
    confidence: visionArticle.confidence,
    warnings: [],
  }
  if (subtitleLine !== undefined) {
    article.subtitle = cleanTextSpacing(singleLineText(subtitleLine.line.text))
  }
  if (bylineLine !== undefined) {
    const author = !bylineIsNameOnly && bylineNameIsAuthor ? bylineName : ''
    article.byline = cleanTextSpacing(`${bylineLabel}${author}`)
  }
  article.fullText = renderArticleFullText(article)

  const continuation = detectContinuation(articleLines, visionArticle)
  if (continuation !== undefined) article.continuation = continuation

  if (body.length < MIN_BODY_CHARS) {
    article.warnings.push(`正文偏短（${body.length} 字），可能漏配文字`)
  }
  if (continuation !== undefined) {
    article.warnings.push(
      `含续文提示（${continuation.direction === 'down' ? '下转' : '上接'}），当前仅校对本版可见内容`,
    )
  }
  if (
    titleLines.length > 0 &&
    bodyLines.length > 0 &&
    titleFontSize < bodyFontSize * TITLE_BODY_RATIO
  ) {
    article.warnings.push(
      `标题字号与正文接近（标题 ${titleFontSize}pt，正文 ${bodyFontSize}pt），请确认标题识别`,
    )
  }
  return article
}

/* ------------------------------------------------------------------------- */
/* Region output and statistics                                                */
/* ------------------------------------------------------------------------- */

function toRegion(
  draft: RegionDraft,
  owner: string | undefined,
  page: PageSize,
  lineEntries: readonly LineEntry[],
): Region {
  const region: Region = {
    id: draft.id,
    page: 1,
    kind: draft.kind,
    bbox: clampBBoxToPage(draft.assignmentBox, page),
    lineIds: draft.lineIndexes.map((lineIndex) => lineEntries[lineIndex].line.id),
    order: draft.order,
    confidence: draft.confidence,
    source: draft.confidence < FALLBACK_CONFIDENCE_BELOW ? 'fallback' : 'vision',
  }
  if (owner !== undefined) region.articleId = owner
  return region
}

/**
 * Compute coverage and overlap.
 *
 * - Coverage: assigned characters / characters that should be covered, with
 *   masthead/header/footer/ad text excluded from both the numerator and the
 *   denominator. Unassigned lines always count towards the denominator, so a
 *   page whose regions miss text drops below 1.
 * - Overlap: duplicate line claims between articles, counted before the
 *   `articleGroup` authority resolves them, divided by the total number of
 *   claims. Authority resolution means a line never ends up in two finished
 *   articles, so a non-zero overlap flags ambiguous vision grouping.
 */
function computeStats(
  lineEntries: readonly LineEntry[],
  drafts: readonly RegionDraft[],
  assignedRegion: ReadonlyArray<number | undefined>,
  claimants: ReadonlyArray<readonly string[]>,
): AssembleStats {
  const unassignedLineIds: string[] = []
  let totalChars = 0
  let assignedChars = 0

  lineEntries.forEach((entry, lineIndex) => {
    const chars = singleLineText(entry.line.text).length
    const regionIndex = assignedRegion[lineIndex]
    if (regionIndex === undefined) {
      totalChars += chars
      unassignedLineIds.push(entry.line.id)
      return
    }
    if (EXCLUDED_KINDS.has(drafts[regionIndex].kind)) return
    totalChars += chars
    assignedChars += chars
  })

  const claimCounts = new Map<number, number>()
  let totalClaims = 0
  drafts.forEach((draft, regionIndex) => {
    const regionClaimants = claimants[regionIndex]
    if (regionClaimants.length === 0) return
    for (const lineIndex of draft.lineIndexes) {
      for (let claim = 0; claim < regionClaimants.length; claim += 1) {
        claimCounts.set(lineIndex, (claimCounts.get(lineIndex) ?? 0) + 1)
        totalClaims += 1
      }
    }
  })
  let duplicateClaims = 0
  for (const count of claimCounts.values()) {
    if (count > 1) duplicateClaims += count - 1
  }

  return {
    coverage: totalChars === 0 ? 1 : assignedChars / totalChars,
    overlap: totalClaims === 0 ? 0 : duplicateClaims / totalClaims,
    unassignedLineIds,
  }
}

/** Page-level warnings: coverage, unassigned/spanning lines, membership, article warnings. */
function buildPageWarnings(
  stats: AssembleStats,
  spanningWarnings: readonly string[],
  membershipWarnings: readonly string[],
  articles: readonly Article[],
): string[] {
  const warnings: string[] = []
  if (stats.coverage < MIN_COVERAGE) {
    warnings.push(
      `文字覆盖率 ${formatPercent(stats.coverage)}，低于 80%，请检查未归类文字`,
    )
  }
  if (stats.unassignedLineIds.length > 0) {
    const shown = stats.unassignedLineIds.slice(0, MAX_WARNING_LINE_IDS)
    const rest = stats.unassignedLineIds.length - shown.length
    warnings.push(
      `有 ${stats.unassignedLineIds.length} 行文字未归类：${shown.join('、')}${rest > 0 ? ' 等' : ''}`,
    )
  }
  warnings.push(...spanningWarnings)
  warnings.push(...membershipWarnings)
  for (const article of articles) {
    for (const warning of article.warnings) warnings.push(`文章 ${article.id}：${warning}`)
  }
  return warnings
}

/* ------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Assemble the page's regions and articles from the text lines, candidate
 * blocks and the vision layout.
 *
 * Pure and deterministic: the inputs are never mutated, no I/O or clock is
 * read, region ids are `r1…` in page order and article ids are the vision ids.
 */
export function assembleArticles(input: AssembleInput): AssembleResult {
  const lineEntries: LineEntry[] = input.lines.map((line, index) => ({
    line,
    index,
    box: normalizeBBox(line.bbox),
  }))
  const lineById = new Map<string, LineEntry>()
  for (const entry of lineEntries) {
    if (!lineById.has(entry.line.id)) lineById.set(entry.line.id, entry)
  }

  const drafts = buildRegionDrafts(input.candidates, input.vision.regions, lineById)
  const assignment = assignLines(drafts, lineEntries)
  const membership = resolveMembership(drafts, input.vision.articles)

  const orderedArticles = orderArticles(input.vision.articles)
  const articles = orderedArticles.map((entry, index) =>
    buildArticle(entry.article, index + 1, drafts, membership.owners, lineEntries),
  )
  const regions = drafts.map((draft, index) =>
    toRegion(draft, membership.owners[index], input.page, lineEntries),
  )
  const stats = computeStats(lineEntries, drafts, assignment.assigned, membership.claimants)
  const warnings = buildPageWarnings(stats, assignment.warnings, membership.warnings, articles)

  return { regions, articles, warnings, stats }
}

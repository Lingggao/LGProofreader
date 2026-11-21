/**
 * Shared data model for the Ling Gao 校对员 (Ling Gao Proofreader) DSH plugin.
 *
 * This module is imported by both the Host plugin and the Client bundle, so it
 * must stay free of Node.js, React and DeepSeek Harness imports.
 */

/** Document identifier, e.g. `doc_1763500000000_ab12cd`. */
export type DocId = string

/** Article identifier, e.g. `a1`. */
export type ArticleId = string

/** Layout or proofreading job identifier, e.g. `job_1763500000000`. */
export type JobId = string

/** 1-based page number. v1 supports exactly one page per document. */
export type PageNo = number

/** Proofreading depth preset. */
export type Depth = 'quick' | 'standard' | 'deep'

/** Background proofreading roles. */
export type RoleId =
  | 'master'
  | 'words'
  | 'idioms'
  | 'style'
  | 'facts'
  | 'nouns'
  | 'headline'
  | 'consistency'
  | 'consolidator'

/** Confidence reported by a model, or assigned by a deterministic fallback. */
export type Confidence = 'high' | 'medium' | 'low'

/* ------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Axis-aligned rectangle in page coordinates (PDF points).
 *
 * `w` extends towards +x and `h` towards +y; negative sizes are accepted on
 * input and normalized by the helpers in `src/shared/geometry/bbox.ts`.
 */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** A point in the same coordinate space as {@link BBox}. */
export interface Point {
  x: number
  y: number
}

/** Page dimensions in PDF points. */
export interface PageSize {
  widthPt: number
  heightPt: number
}

/* ------------------------------------------------------------------------- */
/* PDF text layer and layout                                                   */
/* ------------------------------------------------------------------------- */

/** One text run as reported by the PDF text layer. */
export interface TextItem {
  /** Text content of the run. */
  str: string
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  fontName?: string
}

/** A text line built by clustering adjacent {@link TextItem}s. */
export interface TextLine {
  id: string
  text: string
  bbox: BBox
  fontSize: number
  /** CSS-style font weight: 400 (regular) or 700 (bold). */
  fontWeight: number
  fontName?: string
  /** Top y coordinate used as the clustering baseline, in page coordinates. */
  baseline: number
  /** 0-based column band index, assigned while sorting the lines. */
  column: number
}

/** A candidate layout block proposed by the deterministic pre-pass. */
export interface CandidateBlock {
  candidateId: string
  bbox: BBox
  lineIds: string[]
  fontSizeBand: 'headline' | 'subhead' | 'body' | 'small'
  firstLineText: string
  lineCount: number
}

/** A layout region produced by the vision model, a fallback, or a manual edit. */
export interface Region {
  id: string
  page: PageNo
  kind:
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
  bbox: BBox
  lineIds: string[]
  articleId?: ArticleId
  /** Reading order within the page (0-based, ascending). */
  order: number
  confidence: number
  source: 'vision' | 'manual' | 'fallback'
}

/** An article reassembled from one or more layout regions. */
export interface Article {
  id: ArticleId
  page: PageNo
  role: 'lead' | 'second' | 'third' | 'normal'
  title: string
  subtitle?: string
  byline?: string
  body: string
  /**
   * Complete extracted text in reading order: title, subtitle, byline, body,
   * separated by blank lines. Derived from the fields above for extraction/API
   * consumers; `body` remains the editable body-only field.
   */
  fullText?: string
  regionIds: string[]
  readingOrder: number
  /** Only a hint that the article continues elsewhere; never auto-joined. */
  continuation?: { direction: 'down' | 'up'; note?: string }
  confidence: number
  warnings: string[]
}

/* ------------------------------------------------------------------------- */
/* Proofreading                                                                */
/* ------------------------------------------------------------------------- */

/** One proofreading finding produced by one or more roles. */
export interface Finding {
  id: string
  articleId: ArticleId
  category:
    | 'typo'
    | 'punctuation'
    | 'word'
    | 'idiom'
    | 'grammar'
    | 'fact'
    | 'consistency'
    | 'headline'
    | 'format'
  severity: 'must_fix' | 'suggested' | 'optional'
  /** Consecutive snippet of the article text; located by the validator. */
  quote: string
  /** 1-based occurrence of `quote` in the article. */
  occurrence: number
  issue: string
  suggestion: string
  reason?: string
  evidence?: string
  sources?: { title: string; url: string }[]
  confidence: Confidence
  /** True when the quote cannot be located or the finding needs a human. */
  needsHuman: boolean
  roles: string[]
  status: 'open' | 'accepted' | 'rejected' | 'deferred'
}

/** One verifiable claim and its verdict; always listed in the report. */
export interface FactCheck {
  id: string
  articleId: ArticleId
  claim: string
  quote: string
  kind:
    | 'date'
    | 'time'
    | 'person'
    | 'title'
    | 'organization'
    | 'place'
    | 'book'
    | 'event'
    | 'number'
    | 'quote'
    | 'other'
  /** Extraction-order priority; 1 is the most important item to verify. */
  priority?: number
  verdict: 'confirmed' | 'contradicted' | 'unverified' | 'insufficient' | 'not_checked'
  evidence?: string
  sources: { title: string; url: string }[]
  /**
   * 1-based occurrence of `quote` in the article text, when the quote could be
   * located. Program-generated contradiction findings inherit it.
   */
  occurrence?: number
  confidence: Confidence
  needsHuman: boolean
}

/** Progress phase of the network fact-check plan. */
export type FactCheckProgressPhase = 'planning' | 'searching' | 'verifying' | 'done'

/** One claim row in the live fact-check plan shown in the proofreading panel. */
export interface FactCheckProgressItem {
  /** Stable per-article claim id (`<articleId>:fc<n>`). */
  id: string
  articleId: ArticleId
  claim: string
  quote: string
  kind: FactCheck['kind']
  /** 1 = most important; the plan is sorted by this value. */
  priority: number
  /** True once at least one search query was executed or answered from cache. */
  searched: boolean
  /**
   * - `pending`: planned, no search yet
   * - `searching`: currently being searched
   * - `searched`: evidence collected, waiting for the verdict call
   * - `verifying`: included in the current verdict batch
   * - `checked`: verdict available
   * - `not_checked`: time/budget ran out (still listed)
   */
  status: 'pending' | 'searching' | 'searched' | 'verifying' | 'checked' | 'not_checked'
  /** Final verdict, when `status` is `checked`. */
  verdict?: FactCheck['verdict']
}

/**
 * Live fact-check plan/progress for one proofreading job.
 *
 * The Host emits this after claim extraction, after each search round and after
 * the verdict call. The Client polls `GET /job` and renders the ordered plan so
 * the user can see what will be checked and how many items are done.
 */
export interface FactCheckProgress {
  total: number
  /** Items with at least one search attempt. */
  searched: number
  /** Items with a final verdict (confirmed/contradicted/unverified/insufficient). */
  checked: number
  /** Items that ran out of time/budget and are still listed as not_checked. */
  notChecked: number
  phase: FactCheckProgressPhase
  /** Priority-ordered (then article/input order) claim rows. */
  items: FactCheckProgressItem[]
  /** Epoch milliseconds; used by the UI to show elapsed time. */
  startedAt?: number
  /** Epoch milliseconds: stop scheduling new searches and wrap up. */
  softDeadlineAt?: number
  /** Epoch milliseconds: the role-level hard timeout boundary. */
  hardDeadlineAt?: number
}

/** Kinds of named entities/terms checked by the independent `nouns` role. */
export type NounCheckKind =
  | 'organization'
  | 'company'
  | 'institution'
  | 'place'
  | 'product'
  | 'system'
  | 'project'
  | 'event'
  | 'person'
  | 'title'
  | 'technical_term'
  | 'other'

/** Existence-only result of the network noun check. */
export type NounCheckStatus = 'exists' | 'uncertain' | 'not_found' | 'not_checked'

/** One named entity/term and its existence evidence; always listed in the report. */
export interface NounCheck {
  id: string
  articleId: ArticleId
  /** The noun/term itself (e.g. 复旦大学附属华山医院). */
  name: string
  /** Article quote that contains the noun. */
  quote: string
  kind: NounCheckKind
  /** 1 = highest importance; the plan is sorted by this value. */
  priority: number
  status: NounCheckStatus
  evidence?: string
  sources: { title: string; url: string }[]
  confidence: Confidence
  needsHuman: boolean
}

/** One row in the live noun-check plan. */
export interface NounProgressItem {
  id: string
  articleId: ArticleId
  name: string
  quote: string
  kind: NounCheckKind
  priority: number
  searched: boolean
  status: 'pending' | 'searching' | 'searched' | 'verifying' | 'checked' | 'not_checked'
  result?: NounCheckStatus
}

/** Live noun-check plan/progress for one proofreading job. */
export interface NounProgress {
  total: number
  searched: number
  checked: number
  notChecked: number
  phase: FactCheckProgressPhase
  items: NounProgressItem[]
  startedAt?: number
  softDeadlineAt?: number
  hardDeadlineAt?: number
}



/**
 * One role that failed for one article in a proofreading run.
 *
 * A failed role produced **no** result: its findings (and, for the `facts` role,
 * its whole fact checklist) are missing from the report. Clients must use this
 * field to tell "not checked" from "checked, nothing found" — an empty
 * `factChecks` list alone is not proof that no claim existed (Task 21f).
 *
 * `error` is the provider/stage error message, never prompt text.
 */
export interface ReportRoleFailure {
  articleId: ArticleId
  role: RoleId
  error?: string
}

/* ------------------------------------------------------------------------- */
/* Documents and jobs                                                          */
/* ------------------------------------------------------------------------- */

/** Document metadata persisted in the plugin data directory. */
export interface DocumentMeta {
  id: DocId
  fileName: string
  newspaper?: string
  edition?: string
  /** `YYYY-MM-DD`. */
  date?: string
  /** v1 accepts exactly one page per PDF. */
  pageCount: 1
  createdAt: number
  status: 'parsing' | 'ready' | 'failed'
}

/** Everything the Host persists for one document. */
export interface DocumentRecord {
  meta: DocumentMeta
  lines?: TextLine[]
  candidates?: CandidateBlock[]
  widthPt?: number
  heightPt?: number
  regions?: Region[]
  articles?: Article[]
  reportIds: string[]
}

/** Lightweight document entry shown in the document rail. */
export interface DocumentSummary {
  meta: DocumentMeta
  hasLayout: boolean
  reportCount: number
}

/** Payload the Client submits for one parsed page. */
export interface PageTextInput {
  lines: TextLine[]
  candidates: CandidateBlock[]
  widthPt: number
  heightPt: number
}

/** One progress stage of a layout or proofreading job. */
export interface StageState {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed'
  error?: string
}

/** Read-only prompt library loaded on the Host; never sent to the Client. */
export interface PromptLibrary {
  version: string
  roles: readonly RoleId[]
  compose(
    role: RoleId,
    input: { article: Article; context: string },
  ): { system: string; user: string }
}

/** Final proofreading report for one job. */
export interface Report {
  jobId: JobId
  docId: DocId
  articleIds: ArticleId[]
  createdAt: number
  model: string
  promptVersion: string
  depth: Depth
  /**
   * Effective network fact-checking mode of the run.
   *
   * - `off`: the user disabled network fact-checking for this run;
   * - `unavailable`: the run asked for network checking but the Host has no `web`
   *   service, so every verdict is unverified/not_checked;
   * - `on`: network checking was enabled and a `web` service existed. Individual
   *   lookups may still have failed (see each `FactCheck.verdict`).
   *
   * Optional only for backwards compatibility with reports persisted before the
   * field existed; new reports always set it. Clients must not infer the mode
   * from `stats.searchCalls`: the fact checker counts an attempt *before* the
   * call, so a failed/unavailable lookup can still report one search call.
   */
  factCheckMode?: 'off' | 'on' | 'unavailable'
  summary: {
    mustFixCount: number
    suggestedCount: number
    optionalCount: number
    factCheck: {
      confirmed: number
      contradicted: number
      unverified: number
      insufficient: number
      notChecked: number
    }
    /** Existence-only noun-check counts (present on 1.0.0+ reports). */
    nounCheck?: {
      exists: number
      uncertain: number
      notFound: number
      notChecked: number
    }
    byCategory: Record<string, number>
    /** The "必须修改的条目" summary shown at the end of the report. */
    mustFixList: string[]
  }
  findings: Finding[]
  factChecks: FactCheck[]
  /** Existence-only noun checks (independent `nouns` role; present on 1.0.0+). */
  nounChecks?: NounCheck[]
  /**
   * Roles that did not finish for the reported articles, with their
   * provider/stage error. Absent or empty means every role finished.
   *
   * Reported so a failed `facts` role can never be presented as
   * “未发现可核查项” (Task 21f); optional only for reports persisted before the
   * field existed.
   */
  failedRoles?: ReportRoleFailure[]
  stats: {
    calls: number
    failedCalls: number
    searchCalls: number
    fetchCalls: number
    inputTokens?: number
    outputTokens?: number
    elapsedMs: number
  }
}

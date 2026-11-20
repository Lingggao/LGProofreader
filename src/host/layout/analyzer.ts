/**
 * Host vision layout analyzer (Task 11).
 *
 * One newspaper page needs a semantic partition (which candidate block is a
 * lead/second/article, which blocks form one article, what is the reading
 * order) that no geometric rule can decide. This module owns exactly that one
 * model call and its degradation path:
 *
 * 1. the Client's candidate-overlay PNG is persisted through the injected
 *    `saveImage` seam (the real Host passes `ctx.attachments.saveImage`) so it
 *    can be attached to a user message — the Host never composites images and
 *    has no native canvas dependency;
 * 2. the static vision prompt (candidate list + layout contract) is sent with
 *    the image to the injected {@link LlmClient} at a `high` reasoning effort
 *    ({@link VISION_REASONING_EFFORT}), overriding the activation default;
 * 3. the reply is validated by `parseVisionLayout`, every candidate block must
 *    appear in `regions` (no silent block loss) and page furniture must stay out
 *    of articles; on a validation failure the call is retried **once** with the
 *    concrete validation error in the prompt, while a transport failure retries
 *    once with a neutral "previous attempt did not complete" preamble;
 * 4. when the retry also fails (or the image could not be saved) the page
 *    degrades to `fallbackVisionLayout` ("candidate block = article block") with
 *    the `vision-fallback` warning instead of failing the whole analysis.
 *
 * A model call is also bounded per attempt (Task 21g): {@link
 * VISION_ATTEMPT_TIMEOUT_MS} after the call starts, the attempt is abandoned and
 * the page falls back **immediately** (no retry) with {@link VISION_TIMEOUT_WARNING}
 * in addition to `vision-fallback`. This is what keeps a provider stream that
 * never finishes from hanging the layout job at 25% forever.
 *
 * Caller cancellation always wins: an aborted `AbortSignal` is rethrown, never
 * retried and never turned into a fallback. The analyzer never transcribes
 * text — it returns only the validated {@link VisionLayout}; all article text is
 * back-filled deterministically by `assembleArticles`.
 *
 * Host-only module: no Node.js, npm or DSH imports; the two I/O seams are
 * injected so the behavior is fully testable.
 */
import type { CandidateBlock, PageSize } from '../../shared/types'
import {
  VisionLayoutError,
  fallbackVisionLayout,
  parseVisionLayout,
  type VisionLayout,
  type VisionRegionKind,
} from '../../shared/layout/vision-schema'
import type {
  ImageAttachmentRef,
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResult,
} from '../services/llm-client'
import {
  VISION_LAYOUT_SYSTEM_PROMPT,
  buildVisionLayoutUserPrompt,
  type VisionLayoutRetry,
} from './vision-prompt'

/** Input of the injected attachment writer (structural subset of the DSH attachments API). */
export interface SaveImageInput {
  /** PNG bytes exactly as the Client uploaded them. */
  data: Uint8Array
  mediaType: 'image/png'
  /** Display name; only attachment metadata, never part of the prompt. */
  name: string
}

/**
 * Persist one image and return the attachment reference used by an image
 * content block. In the real Host this is `ctx.attachments.saveImage`.
 */
export type SaveImage = (input: SaveImageInput) => Promise<ImageAttachmentRef>

/** One page to analyze. */
export interface LayoutAnalyzerInput {
  /** Page image with the numbered candidate boxes drawn by the Client. */
  overlayPng: Uint8Array
  /** Candidate blocks the Client segmented from the text layer. */
  candidates: CandidateBlock[]
  /** Page size in PDF points (top-left origin, y grows downward). */
  page: PageSize
}

/** One-shot semantic layout analyzer used by the job orchestrator. */
export interface LayoutAnalyzer {
  /**
   * Analyze one page's layout.
   *
   * Never throws for model/validation/attachment failures or for an attempt that
   * hit the per-attempt timeout: the deterministic fallback layout is returned
   * instead (always with the `vision-fallback` warning; a timeout adds
   * `vision-timeout`). A caller cancellation is rethrown.
   */
  analyze(input: LayoutAnalyzerInput, signal: AbortSignal): Promise<VisionLayout>
}

/** Dependencies of {@link createLayoutAnalyzer}. */
export interface LayoutAnalyzerDeps {
  /** Bound one-shot model client (provider/model/reasoning effort already fixed). */
  llm: LlmClient
  /** Attachment writer for the overlay PNG (injected: `ctx.attachments.saveImage`). */
  saveImage: SaveImage
  /**
   * Per-attempt vision timeout in milliseconds. Production omits it and uses
   * {@link VISION_ATTEMPT_TIMEOUT_MS}; tests inject a short bound.
   */
  visionAttemptTimeoutMs?: number
}

/** One initial attempt plus exactly one retry (design §6.2). */
const MAX_ATTEMPTS = 2

/**
 * Hard bound for one vision attempt (Task 21g).
 *
 * If the provider stream never finishes, the layout job must not stay in the
 * `analyze` stage forever (live uploads were stuck at 25% with no layout). After
 * this bound the attempt is abandoned, no retry is made and the page degrades to
 * the deterministic fallback. 240s leaves room for a slow but healthy vision
 * reply while bounding a stuck upload to a few minutes.
 */
export const VISION_ATTEMPT_TIMEOUT_MS = 240_000

/**
 * Visible warning of a fallback caused by the vision timeout. It is carried next
 * to `vision-fallback` so the layout job result (and thus the existing UI
 * warning count) distinguishes a timed-out page from a clean one.
 */
export const VISION_TIMEOUT_WARNING = 'vision-timeout'

/** Display name of the overlay attachment (the attachment id is generated by the Host). */
const OVERLAY_NAME = 'page-overlay.png'

/**
 * Reasoning effort of the one vision call (Task 25).
 *
 * Semantic page segmentation is the accuracy-critical step of the layout
 * pipeline and its replies are long structured JSON, so it keeps a `high`
 * effort even though the latency budget matters: the per-attempt timeout
 * ({@link VISION_ATTEMPT_TIMEOUT_MS}) and the deterministic fallback bound the
 * worst case instead of silently degrading the analysis.
 */
export const VISION_REASONING_EFFORT = 'high'

/** Region kinds that are page furniture, never article material. */
const FURNITURE_KINDS: ReadonlySet<VisionRegionKind> = new Set<VisionRegionKind>([
  'masthead',
  'header',
  'footer',
  'ad',
])

/**
 * Create the vision layout analyzer for one fixed model selection.
 *
 * The returned analyzer is stateless and safe to reuse for concurrent pages:
 * every call saves its own overlay attachment and sends exactly one model call
 * (plus at most one retry).
 */
export function createLayoutAnalyzer(deps: LayoutAnalyzerDeps): LayoutAnalyzer {
  const { llm, saveImage } = deps
  const attemptTimeoutMs = deps.visionAttemptTimeoutMs ?? VISION_ATTEMPT_TIMEOUT_MS

  return {
    async analyze(input: LayoutAnalyzerInput, signal: AbortSignal): Promise<VisionLayout> {
      const { overlayPng, candidates, page } = input

      throwIfAborted(signal)

      // Without candidate blocks there is nothing to classify: answer
      // deterministically instead of paying for an unparseable vision call.
      if (candidates.length === 0) return fallbackVisionLayout(candidates)

      let attachment: ImageAttachmentRef
      try {
        attachment = await saveImage({ data: overlayPng, mediaType: 'image/png', name: OVERLAY_NAME })
      } catch (error) {
        if (signal.aborted) throw error
        // The page can still be assembled from its candidates; don't fail the
        // whole analysis because the attachment service is unavailable.
        return fallbackVisionLayout(candidates)
      }

      let retry: VisionLayoutRetry | undefined
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal)

        // A fresh message array per attempt: the previous request must stay
        // untouched (the model client may keep a reference to it).
        const user =
          retry === undefined
            ? buildVisionLayoutUserPrompt({ candidates, page })
            : buildVisionLayoutUserPrompt({ candidates, page, retry })
        const messages: LlmMessage[] = [
          {
            role: 'user',
            content: [
              { type: 'image', attachment },
              { type: 'text', text: user },
            ],
          },
        ]
        const request: LlmRequest = {
          system: VISION_LAYOUT_SYSTEM_PROMPT,
          messages,
          reasoningEffort: VISION_REASONING_EFFORT,
        }

        try {
          const result = await completeVisionAttempt(llm, request, signal, attemptTimeoutMs)
          const layout = parseVisionLayout(result.text, candidates)
          assertCandidateCoverage(layout, candidates)
          assertFurnitureSeparated(layout)
          return layout
        } catch (error) {
          if (signal.aborted) throw error
          // A timeout says nothing about the next reply and retrying the same
          // stalled provider stream would only add another 240s to the upload:
          // degrade to the deterministic layout immediately.
          if (error instanceof VisionAttemptTimeoutError) return timeoutFallback(candidates)
          // A structured validation failure is actionable feedback for the model;
          // a thrown transport/LLM failure says nothing about a previous reply.
          retry =
            error instanceof VisionLayoutError
              ? { kind: 'validation', error: describeError(error) }
              : { kind: 'transport' }
        }
      }

      return fallbackVisionLayout(candidates)
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Internals                                                                   */
/* ------------------------------------------------------------------------- */

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Internal marker of one timed-out vision attempt. It is never retried and never
 * reaches the caller: the analyzer turns it into the deterministic fallback with
 * {@link VISION_TIMEOUT_WARNING}.
 */
class VisionAttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`vision layout call timed out after ${timeoutMs}ms`)
    this.name = 'VisionAttemptTimeoutError'
  }
}

/**
 * Run one vision attempt under the caller's signal plus a hard per-attempt
 * timeout.
 *
 * The returned promise settles on the first of: the model result/failure, the
 * caller's cancellation, or the timeout. Racing the abort (instead of only
 * forwarding the signal to the model client) is what makes a client that ignores
 * its signal harmless: a never-finishing stream can neither hang the layout job
 * nor delay a cancellation for the rest of the timeout. The abandoned model
 * promise is drained by the attached `then`, so a late rejection cannot become
 * an unhandled rejection; the caller's abort is checked before the timeout in
 * `analyze`'s catch, so cancellation always wins over degradation.
 */
async function completeVisionAttempt(
  llm: LlmClient,
  request: LlmRequest,
  callerSignal: AbortSignal,
  timeoutMs: number,
): Promise<LlmResult> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => {
    timeoutController.abort(new VisionAttemptTimeoutError(timeoutMs))
  }, timeoutMs)
  const signal = AbortSignal.any([callerSignal, timeoutController.signal])
  try {
    return await new Promise<LlmResult>((resolve, reject) => {
      let settled = false
      function settle(action: () => void): void {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        action()
      }
      function onAbort(): void {
        // Defer one microtask so the client's own failure (when it rejects in the
        // same synchronous turn as the abort) is not masked by the generic abort
        // reason; a still-pending call is rejected in the same tick regardless.
        queueMicrotask(() => settle(() => reject(abortReason(signal))))
      }

      // Start the attempt before wiring the abort listener: a client may cancel
      // the caller's signal synchronously and then fail, and its specific error
      // should surface (the abort is observed right after the listener is added).
      const pending = llm.complete(request, signal)
      pending.then(
        (result) => settle(() => resolve(result)),
        (error: unknown) => settle(() => reject(error)),
      )

      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Abort reason of the combined signal, always as an `Error` for the caller. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('vision layout attempt aborted')
}

/**
 * Degraded layout for a timed-out attempt: the deterministic fallback (and its
 * `vision-fallback` warning) plus the visible {@link VISION_TIMEOUT_WARNING}, so
 * the outcome is an honest, stored `ready` layout instead of a stuck job.
 */
function timeoutFallback(candidates: readonly CandidateBlock[]): VisionLayout {
  const layout = fallbackVisionLayout(candidates)
  return { ...layout, warnings: [...layout.warnings, VISION_TIMEOUT_WARNING] }
}

/**
 * Throw the caller's abort reason before doing any work. The analyzer checks
 * the signal itself (rather than relying on the model client) so it never saves
 * an image or starts a retry after cancellation.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('layout analysis aborted')
}

/**
 * Enforce complete candidate coverage: every candidate block must appear exactly
 * once in `regions`. `parseVisionLayout` already rejects unknown and duplicate
 * candidate ids, so only missing ids are left to check here. A silently dropped
 * block would lose its text in `assembleArticles` (unassigned lines / low
 * coverage), so a reply that does not cover every candidate is treated as an
 * invalid layout: the analyzer retries with the missing ids in the error and
 * falls back (which covers all candidates by construction) if it repeats.
 */
function assertCandidateCoverage(
  layout: VisionLayout,
  candidates: readonly CandidateBlock[],
): void {
  const covered = new Set(layout.regions.map((region) => region.candidateId))
  const missing = candidates
    .filter((candidate) => !covered.has(candidate.candidateId))
    .map((candidate) => candidate.candidateId)
  if (missing.length === 0) return
  throw new VisionLayoutError(
    'INVALID_SHAPE',
    `视觉分区结果缺少候选块 ${missing.join('、')}：每个候选块必须在 regions 中出现且只出现一次`,
  )
}

/**
 * Enforce the page-furniture rule the prompt states: `masthead|header|footer|ad`
 * is never article material. A parse-valid reply that groups furniture into an
 * article (or uses it as the article title) would make `assembleArticles` pull
 * the masthead/footer/ad text into the proofread body, so it is treated as an
 * invalid layout: the analyzer retries with this error and falls back if the
 * model repeats it.
 */
function assertFurnitureSeparated(layout: VisionLayout): void {
  const regionByCandidateId = new Map(
    layout.regions.map((region) => [region.candidateId, region] as const),
  )

  for (const region of layout.regions) {
    if (!FURNITURE_KINDS.has(region.kind)) continue
    if (region.articleGroup !== '') {
      throw new VisionLayoutError(
        'INVALID_SHAPE',
        `版面家具候选块 ${region.candidateId}（${region.kind}）的 articleGroup 必须为空字符串，不能归入文章`,
      )
    }
  }

  for (const article of layout.articles) {
    const titleRegion = regionByCandidateId.get(article.titleCandidateId)
    if (titleRegion !== undefined && FURNITURE_KINDS.has(titleRegion.kind)) {
      throw new VisionLayoutError(
        'INVALID_SHAPE',
        `文章 ${article.id} 的 titleCandidateId 指向版面家具候选块 ${titleRegion.candidateId}（${titleRegion.kind}），标题候选不得是家具`,
      )
    }
    for (const regionId of article.regionIds) {
      const region = regionByCandidateId.get(regionId)
      if (region !== undefined && FURNITURE_KINDS.has(region.kind)) {
        throw new VisionLayoutError(
          'INVALID_SHAPE',
          `文章 ${article.id} 的 regionIds 包含版面家具候选块 ${regionId}（${region.kind}），家具不得归入文章`,
        )
      }
    }
  }
}

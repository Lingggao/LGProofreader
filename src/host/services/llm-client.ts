/**
 * Host-only LLM client for the Ling Gao 校对员 (Ling Gao Proofreader) plugin.
 *
 * Every background model call goes through {@link createLlmClient}, which wraps
 * the DSH Host `llm` service (`ctx.llm.stream`) with one narrow seam:
 *
 * - one text completion: provider/model are fixed when the client is created;
 *   each request supplies `system`, user messages (text and image blocks), an
 *   optional `maxTokens` and an optional `reasoningEffort` that overrides the
 *   activation-level effort for that one call (Task 25: role and vision calls
 *   pin their own effort; values must be provider-supported, e.g.
 *   `off|low|high|max` for `deepseek-official`);
 * - visible `text-delta`s are reassembled, `reasoning-delta`s and the tool/block
 *   chunks are ignored, and reported token usage is captured;
 * - a terminal `error`/`aborted` finish becomes a typed {@link LlmCallError}; a
 *   stream that ends without any finish is also an error (never a silent empty
 *   answer);
 * - the caller's `AbortSignal` is forwarded to the service untouched.
 *
 * No Agent, session or conversation is created (design §3.2): `ctx.llm.stream`
 * is a raw single-shot model call, and job bookkeeping/retries stay in the
 * plugin. The message and chunk types below are a structural subset of the DSH
 * `0.2.2-rc.5` `llm` service contract, so this module imports neither DSH
 * packages nor npm dependencies (Host runtime has zero npm dependencies).
 */

/* ------------------------------------------------------------------------- */
/* Request messages                                                            */
/* ------------------------------------------------------------------------- */

/** Image reference returned by the Host `attachments` service (DSH `ImageAttachmentRef`). */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

/** Plain text content block of a user message. */
export interface LlmTextBlock {
  type: 'text'
  text: string
}

/** Image content block; images are only allowed in user messages. */
export interface LlmImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
  offloaded?: true
}

/** One user message block: text or a saved image attachment. */
export type LlmContentBlock = LlmTextBlock | LlmImageBlock

/** One user message sent to the model. */
export interface LlmMessage {
  role: 'user'
  content: LlmContentBlock[]
}

/** One model request: a system prompt plus user messages. */
export interface LlmRequest {
  system: string
  messages: LlmMessage[]
  maxTokens?: number
  /**
   * Optional per-request reasoning effort (Task 25). When present it overrides
   * the reasoning effort fixed on the client selection for this one call, so the
   * same client can run a key role deeper than other calls. The value must be
   * supported by the selected provider (`off|low|high|max` for
   * `deepseek-official`; anything else is rejected at runtime). Omitted/blank
   * keeps the activation-level selection.
   */
  reasoningEffort?: string
}

/* ------------------------------------------------------------------------- */
/* Results                                                                     */
/* ------------------------------------------------------------------------- */

/** Token usage reported by the provider, when available. */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
}

/** Assembled model answer. */
export interface LlmResult {
  text: string
  usage?: LlmUsage
}

/** One-shot model-call seam used by the analyzer, fact checker and role workers. */
export interface LlmClient {
  complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResult>
}

/* ------------------------------------------------------------------------- */
/* Host `llm` service contract (structural subset)                             */
/* ------------------------------------------------------------------------- */

/** Provider failure carried by a terminal `error`/`aborted` finish chunk. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
}

/** Terminal reason of one streamed call (DSH `FinishReason`). */
export type LlmFinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure?: LlmFailure }
  | { kind: 'error'; failure?: LlmFailure }

/** Token usage chunk payload (DSH `TokenUsage`); only input/output are consumed. */
export interface LlmTokenUsage extends LlmUsage {
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** One chunk of `ctx.llm.stream` (structural subset of DSH `StreamChunk`). */
export type LlmStreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: LlmTokenUsage }
  | { type: 'finish'; reason: LlmFinishReason }

/** Options forwarded to `ctx.llm.stream` (structural subset of `GenerateOptions`). */
export interface LlmStreamOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: LlmMessage[]
  system?: string
  maxTokens?: number
  signal?: AbortSignal
}

/** Structural subset of the DSH Host plugin `Context` (`apply(ctx)`) this module needs. */
export interface LlmClientContext {
  llm: { stream(options: LlmStreamOptions): AsyncIterable<LlmStreamChunk> }
}

/** Provider/model/reasoning-effort selected once for one client (plugin settings). */
export interface LlmSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/* ------------------------------------------------------------------------- */
/* Typed failure                                                               */
/* ------------------------------------------------------------------------- */

/** Terminal kind of a failed model call. */
export type LlmCallFailureKind = 'error' | 'aborted'

/** Options for {@link LlmCallError}. */
export interface LlmCallErrorOptions {
  /** Which terminal finish produced the failure. */
  kind: LlmCallFailureKind
  /** Provider failure code, or a local code (`ABORTED`, `MISSING_FINISH`). */
  code?: string
  /** HTTP status from the provider failure, when reported. */
  status?: number
  /** Original error or thrown abort reason, when there is one. */
  cause?: unknown
}

/** Fallback codes when a failure chunk carries no usable code. */
const DEFAULT_FAILURE_CODES: Readonly<Record<LlmCallFailureKind, string>> = Object.freeze({
  error: 'LLM_ERROR',
  aborted: 'ABORTED',
})

/**
 * Raised when one model call fails: a terminal `error`/`aborted` finish, a
 * stream that ends without a finish, or a consumer cancellation that reaches
 * the stream iterator as a thrown error. Callers can retry on this error and
 * inspect `kind`/`code`/`status` for reporting.
 */
export class LlmCallError extends Error {
  /** Terminal kind that produced the failure. */
  readonly kind: LlmCallFailureKind
  /** Provider failure code, or a local code (`ABORTED`, `MISSING_FINISH`). */
  readonly code: string
  /** HTTP status from the provider failure, when reported. */
  readonly status?: number

  constructor(message: string, options: LlmCallErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LlmCallError'
    this.kind = options.kind
    this.code = options.code ?? DEFAULT_FAILURE_CODES[options.kind]
    if (options.status !== undefined) this.status = options.status
  }
}

/* ------------------------------------------------------------------------- */
/* Client                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Create one {@link LlmClient} bound to a fixed provider/model/reasoning effort.
 *
 * Every `complete()` sends exactly one `ctx.llm.stream` call: no Agent, no
 * session, no tool definitions. The returned client is stateless and safe to
 * reuse for sequential and concurrent calls.
 */
export function createLlmClient(ctx: LlmClientContext, selection: LlmSelection): LlmClient {
  const { provider, model, reasoningEffort } = selection

  return {
    async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResult> {
      const options: LlmStreamOptions = {
        provider,
        model,
        messages: request.messages,
        system: request.system,
        signal,
      }
      // A request-level effort (Task 25) wins over the activation selection; a
      // request without one (or with a blank one) keeps the documented global
      // behaviour instead of silently disabling reasoning.
      const requestEffort = request.reasoningEffort?.trim()
      const effort =
        requestEffort !== undefined && requestEffort !== '' ? requestEffort : reasoningEffort
      if (effort !== undefined) options.reasoningEffort = effort
      if (request.maxTokens !== undefined) options.maxTokens = request.maxTokens

      let text = ''
      let usage: LlmUsage | undefined
      let finished = false

      try {
        for await (const chunk of ctx.llm.stream(options)) {
          switch (chunk.type) {
            case 'text-delta':
              text += chunk.text
              break
            case 'usage':
              usage = pickUsage(chunk.usage)
              break
            case 'finish': {
              const reason = chunk.reason
              if (reason.kind === 'error' || reason.kind === 'aborted') {
                throw toCallError(reason.kind, reason.failure)
              }
              finished = true
              break
            }
            default:
              // block-start / block-end / reasoning-delta / tool-call-delta are
              // not part of a text-only completion; reasoning is never exposed.
              break
          }
        }
      } catch (error) {
        if (error instanceof LlmCallError) throw error
        // A caller abort can reach the iterator as a thrown `AbortError` before
        // the service turns it into an `aborted` finish; keep the typed contract.
        if (signal.aborted) {
          throw new LlmCallError('LLM call aborted', {
            kind: 'aborted',
            code: DEFAULT_FAILURE_CODES.aborted,
            cause: error,
          })
        }
        throw error
      }

      if (!finished) {
        throw new LlmCallError('LLM stream ended without a finish event', {
          kind: 'error',
          code: 'MISSING_FINISH',
        })
      }
      return usage === undefined ? { text } : { text, usage }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Internals                                                                   */
/* ------------------------------------------------------------------------- */

/** Build the typed error from a terminal failure reason. */
function toCallError(kind: 'error' | 'aborted', failure: LlmFailure | undefined): LlmCallError {
  const message = failure?.message?.trim()
  return new LlmCallError(message !== undefined && message !== '' ? message : defaultFailureMessage(kind), {
    kind,
    code: failure?.code,
    status: failure?.status,
  })
}

function defaultFailureMessage(kind: 'error' | 'aborted'): string {
  return kind === 'aborted' ? 'LLM call aborted' : 'LLM call failed'
}

/** Copy only the two usage counters the plugin reports, ignoring provider extras. */
function pickUsage(usage: LlmTokenUsage): LlmUsage {
  const captured: LlmUsage = {}
  if (usage.inputTokens !== undefined) captured.inputTokens = usage.inputTokens
  if (usage.outputTokens !== undefined) captured.outputTokens = usage.outputTokens
  return captured
}

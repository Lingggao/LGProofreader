/**
 * Host-only wrapper around the DSH Host `web` service (`ctx.web`).
 *
 * The fact checker (and any future proofreading stage that needs the network)
 * depends on the small {@link WebClient} seam below instead of the live service,
 * so tests can inject a fake. The wrapper does exactly three things:
 *
 * - forward `search`/`fetch` with the caller's `AbortSignal` untouched;
 * - inject the model route (`llmProvider`) configured for this Host when the
 *   caller did not set one, which is how DSH picks the search provider for a
 *   model request (design §3.2, §7.4);
 * - keep the request/result types a **structural subset** of the live DSH
 *   `0.2.2-rc.5` `web` service contract, pinned via the Cordis Service
 *   inspector. Non-2xx fetches resolve descriptively, so `statusCode` is part of
 *   the result instead of an exception; provider/selection failures throw
 *   `WebError`, which callers treat as "web unavailable".
 *
 * The module imports no Node.js built-ins, npm packages or DSH packages: the
 * Host runtime has zero npm dependencies and the project must not add a
 * `@deepseek-ai/*` type dependency.
 */

/* ------------------------------------------------------------------------- */
/* DSH `web` service contract (structural subset)                              */
/* ------------------------------------------------------------------------- */

/** One search hit (DSH `WebSearchSource`). */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly summary?: string
  readonly publishedAt?: string
}

/** One search request (DSH `WebSearchRequest`). */
export interface WebSearchRequest {
  readonly query: string
  readonly maxResults?: number
  /** Route of the model request the search serves; selects the provider. */
  readonly llmProvider?: string
}

/** One search outcome (DSH `WebSearchResult`); `content` may be a synthesized answer. */
export interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}

/** One fetch request (DSH `WebFetchRequest`). */
export interface WebFetchRequest {
  readonly url: string
}

/** Fetched body (DSH `WebFetchBody`). */
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/** One fetch outcome (DSH `WebFetchResult`); non-2xx responses resolve descriptively. */
export interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: WebFetchBody
  readonly truncated: boolean
}

/** Structural subset of the Host plugin `Context.web` this wrapper needs. */
export interface WebClientContext {
  web: {
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
    fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
  }
}

/* ------------------------------------------------------------------------- */
/* Seam                                                                        */
/* ------------------------------------------------------------------------- */

/** Narrow network seam used by the fact checker; fakeable in tests. */
export interface WebClient {
  search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult>
  fetch(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult>
}

/** Options bound once when the wrapper is created. */
export interface WebClientOptions {
  /**
   * Provider route id of the model request the searches serve
   * (`ctx.llm.stream` provider, e.g. `deepseek-official`). DSH uses it to pick
   * the search provider; `undefined` keeps DSH's own default selection.
   */
  llmProvider?: string
}

/**
 * Wrap the live Host `web` service as a {@link WebClient}.
 *
 * The returned client is stateless and safe to reuse/concur; provider selection
 * is resolved by DSH on every call. A per-request `llmProvider` always wins over
 * the configured default.
 */
export function createWebClient(ctx: WebClientContext, options: WebClientOptions = {}): WebClient {
  const configuredProvider =
    options.llmProvider !== undefined && options.llmProvider.trim() !== ''
      ? options.llmProvider.trim()
      : undefined

  return {
    search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> {
      if (configuredProvider === undefined || request.llmProvider !== undefined) {
        return ctx.web.search(request, signal)
      }
      return ctx.web.search({ ...request, llmProvider: configuredProvider }, signal)
    },
    fetch(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
      return ctx.web.fetch(request, signal)
    },
  }
}

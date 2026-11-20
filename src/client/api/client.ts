/**
 * Same-origin API client for the Ling Gao 校对员 panel (Task 16; design §10.2).
 *
 * The Host registers exact routes through `ctx.connection.fetch`; the browser
 * resolves them against `document.baseURI`, so every URL built here is
 * **relative** (`api/lgproofreader/...`, no leading slash) and carries the DSH
 * browser session automatically. Nothing in this module touches prompt text,
 * model configuration or Host-only modules.
 *
 * - `uploadDocument` streams the PDF with XHR (progress + abort) and sends the
 *   `x-file-name` / `x-page-count: 1` headers the Host validates; any 2xx is
 *   accepted (the upload handler returns 201) and `response.document` is read.
 * - `postJson` / `getJson` / `postBinary` use `fetch` and map the Host's
 *   `{ error: { code, message } }` envelope to {@link ApiError}.
 * - `apiUrl` / `exportUrl` / `pageImageUrl` are the URL builders used by links,
 *   images and polling.
 */
import {
  API_PATHS,
  API_PREFIX,
  REQUEST_HEADERS,
  type ApiErrorCode,
  type ExportFormat,
  type UploadDocumentResponse,
} from '../../shared/api/protocol'
import type { DocumentMeta } from '../../shared/types'

/* ------------------------------------------------------------------------- */
/* URLs                                                                       */
/* ------------------------------------------------------------------------- */

/** Query-string values accepted by {@link apiUrl}; `null`/`undefined` are skipped. */
export type QueryValue = string | number | boolean | null | undefined

/** Query parameters of a route; property order is preserved. */
export type QueryParams = Record<string, QueryValue>

/** Relative prefix the browser resolves against `document.baseURI`. */
const RELATIVE_API_PREFIX = API_PREFIX.replace(/^\/+/, '')
const RELATIVE_API_ROUTE_PREFIX = `${RELATIVE_API_PREFIX}/`

/** Normalize a handler path to the route part after `api/lgproofreader/`. */
function normalizeRoutePath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('apiUrl() requires a non-empty route path')
  }
  let route = path.trim().replace(/^\/+/, '')
  if (route === RELATIVE_API_PREFIX) {
    throw new TypeError(`apiUrl() requires a route path under ${API_PREFIX}`)
  }
  if (route.startsWith(RELATIVE_API_ROUTE_PREFIX)) {
    route = route.slice(RELATIVE_API_ROUTE_PREFIX.length)
  }
  route = route.replace(/^\/+/, '')
  if (route === '') throw new TypeError(`apiUrl() requires a route path under ${API_PREFIX}`)
  return route
}

function buildQuery(params: QueryParams | undefined): string {
  if (params === undefined) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.join('&')
}

/**
 * Build a relative API URL such as `api/lgproofreader/page-text?doc=doc_1`.
 *
 * `path` may be a handler name (`'page-text'`), a protocol path
 * (`API_PATHS.pageText`) or a root-relative path; all are normalized to the
 * same relative route. Values are percent-encoded; `undefined`/`null` params
 * are skipped. The result never starts with `/`, so `fetch`, `<img src>` and
 * `<a href>` all resolve it against the current document base.
 */
export function apiUrl(path: string, params?: QueryParams): string {
  const route = normalizeRoutePath(path)
  const query = buildQuery(params)
  return query === '' ? `${RELATIVE_API_PREFIX}/${route}` : `${RELATIVE_API_PREFIX}/${route}?${query}`
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

/** URL of a report export (`GET /export?job=<id>&format=md|json`). */
export function exportUrl(jobId: string, format: ExportFormat = 'md'): string {
  const id = requireId(jobId, 'exportUrl: jobId')
  if (format !== 'md' && format !== 'json') {
    throw new TypeError("exportUrl: format must be 'md' or 'json'")
  }
  return apiUrl(API_PATHS.exportReport, { job: id, format })
}

/**
 * URL of a document's stored page image (`GET /page-image?doc=<id>`).
 *
 * `version` is an optional cache-busting token (`&v=<value>`): the canvas
 * requests the page image while the PNG upload is still in flight (the Host
 * answers 404), so the panel passes a new version after `POST /page-image`
 * succeeds and when re-opening a document. A changed query string makes the
 * browser drop the cached 404/previous render and re-request the stored PNG.
 */
export function pageImageUrl(docId: string, version?: number | string): string {
  const params: QueryParams = { doc: requireId(docId, 'pageImageUrl: docId') }
  if (version !== undefined) {
    if (typeof version === 'number') {
      if (!Number.isFinite(version)) {
        throw new TypeError('pageImageUrl: version must be a finite number or a non-empty string')
      }
      params.v = version
    } else if (typeof version === 'string') {
      if (version.trim() === '') {
        throw new TypeError('pageImageUrl: version must be a finite number or a non-empty string')
      }
      params.v = version
    } else {
      throw new TypeError('pageImageUrl: version must be a finite number or a non-empty string')
    }
  }
  return apiUrl(API_PATHS.pageImageGet, params)
}

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

/** Error codes produced by this client in addition to the Host's API codes. */
export type ApiClientErrorCode =
  | ApiErrorCode
  | 'network_error'
  | 'aborted'
  | 'bad_response'
  | 'http_error'
  | 'timeout'

/**
 * One failed API call.
 *
 * `status` is the HTTP status (0 for network/abort failures); `code` is the
 * Host's machine-readable error code when the response carried the standard
 * `{ error: { code, message } }` envelope, otherwise one of the client codes.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function abortedError(): ApiError {
  return new ApiError(0, 'aborted', 'request aborted')
}

function networkError(message: string): ApiError {
  return new ApiError(0, 'network_error', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one JSON body; an empty 2xx body resolves to `undefined`. */
function parseJsonText<T>(status: number, text: string): T {
  if (text.trim() === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(status, 'bad_response', 'response body is not valid JSON')
  }
}

/** Map a non-2xx body to {@link ApiError} using the shared error envelope. */
function errorFromBody(status: number, text: string): ApiError {
  try {
    const parsed = JSON.parse(text) as unknown
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const { code, message } = parsed.error
      if (typeof code === 'string' && typeof message === 'string') {
        return new ApiError(status, code, message)
      }
    }
  } catch {
    // Not JSON: fall back to the generic HTTP error below.
  }
  return new ApiError(status, 'http_error', `request failed with status ${status}`)
}

function toFetchError(error: unknown): ApiError {
  if (error instanceof Error && error.name === 'AbortError') return abortedError()
  const message =
    error instanceof Error && error.message !== '' ? error.message : 'network request failed'
  return networkError(message)
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return networkError(error instanceof Error && error.message !== '' ? error.message : 'request failed')
}

/* ------------------------------------------------------------------------- */
/* fetch-based helpers                                                        */
/* ------------------------------------------------------------------------- */

const JSON_CONTENT_TYPE = 'application/json'

/** Options shared by the fetch helpers. */
export interface RequestOptions {
  /** Query parameters appended to the route. */
  params?: QueryParams
  /** Abort signal; aborting rejects with an `aborted` {@link ApiError}. */
  signal?: AbortSignal
}

/** Options for {@link postBinary}. */
export interface BinaryRequestOptions extends RequestOptions {
  /** Body content type; defaults to the Blob's own type, else octet-stream. */
  contentType?: string
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw toFetchError(error)
  }

  let text: string
  try {
    text = await response.text()
  } catch {
    throw networkError('failed to read the response body')
  }

  if (!response.ok) throw errorFromBody(response.status, text)
  return parseJsonText<T>(response.status, text)
}

/** `POST` a JSON body to a relative API route and parse the JSON response. */
export async function postJson<T>(
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const url = apiUrl(path, options.params)
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': JSON_CONTENT_TYPE, accept: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
    signal: options.signal,
  })
}

/** `GET` a relative API route (with query params) and parse the JSON response. */
export async function getJson<T>(
  path: string,
  params?: QueryParams,
  options: Omit<RequestOptions, 'params'> = {},
): Promise<T> {
  return fetchJson<T>(apiUrl(path, params), {
    method: 'GET',
    headers: { accept: JSON_CONTENT_TYPE },
    signal: options.signal,
  })
}

/**
 * `POST` a binary body (page PNG/overlay PNG) to a relative API route and parse
 * the JSON acknowledgement. The Host only accepts `image/png` on the image
 * routes, so the Blob's own type is used when the caller does not override it.
 */
export async function postBinary<T>(
  path: string,
  body: Blob,
  options: BinaryRequestOptions = {},
): Promise<T> {
  if (body === null || typeof body !== 'object') {
    throw new TypeError('postBinary() requires a Blob body')
  }
  const declaredType = typeof body.type === 'string' ? body.type : ''
  const contentType = options.contentType ?? (declaredType !== '' ? declaredType : 'application/octet-stream')
  return fetchJson<T>(apiUrl(path, options.params), {
    method: 'POST',
    headers: { 'content-type': contentType, accept: JSON_CONTENT_TYPE },
    body,
    signal: options.signal,
  })
}

/* ------------------------------------------------------------------------- */
/* uploadDocument (XHR: progress + abort)                                     */
/* ------------------------------------------------------------------------- */

/** Upload progress of {@link uploadDocument}. */
export interface UploadProgress {
  /** Bytes sent so far. */
  loaded: number
  /** Total bytes (from the progress event, else `file.size`). */
  total: number
  /** `loaded / total` in `[0, 1]`; `0` when the total is unknown. */
  ratio: number
}

/** Progress callback of {@link uploadDocument}. */
export type UploadProgressHandler = (progress: UploadProgress) => void

/** v1 accepts exactly one page per PDF (design §6.1/§10.2). */
const REQUIRED_PAGE_COUNT = '1'
const PDF_CONTENT_TYPE = 'application/pdf'

/** Read `{ document, pages }` from a successful upload response. */
function parseUploadResponse(status: number, text: string): DocumentMeta {
  const payload = parseJsonText<Partial<UploadDocumentResponse> | undefined>(status, text)
  if (!isRecord(payload) || !isRecord(payload.document)) {
    throw new ApiError(status, 'bad_response', 'upload response is missing response.document')
  }
  const document = payload.document as unknown as DocumentMeta
  if (typeof document.id !== 'string' || document.id.trim() === '') {
    throw new ApiError(status, 'bad_response', 'upload response is missing response.document.id')
  }
  return document
}

/** Encode the file name header; an unencodable name falls back to the Host default. */
function encodeFileName(name: unknown): string {
  if (typeof name !== 'string' || name === '') return ''
  try {
    return encodeURIComponent(name)
  } catch {
    return ''
  }
}

/**
 * Upload one PDF through `POST /documents` and resolve with the created
 * document metadata.
 *
 * Headers: `content-type: application/pdf`, `x-page-count: 1` and the
 * percent-encoded `x-file-name`. Any 2xx response is accepted (the Host returns
 * 201); the body is read from `response.document`. Aborting `signal` cancels the
 * XHR; network failures, timeouts and the Host's error envelope become
 * {@link ApiError}s.
 */
export function uploadDocument(
  file: File,
  onProgress?: UploadProgressHandler,
  signal?: AbortSignal,
): Promise<DocumentMeta> {
  if (typeof XMLHttpRequest === 'undefined') {
    return Promise.reject(networkError('XMLHttpRequest is unavailable'))
  }
  if (file === null || typeof file !== 'object') {
    return Promise.reject(new TypeError('uploadDocument() requires a File'))
  }
  if (signal?.aborted === true) {
    return Promise.reject(abortedError())
  }

  return new Promise<DocumentMeta>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false

    const cleanup = (): void => {
      signal?.removeEventListener('abort', handleAbort)
    }
    const succeed = (document: DocumentMeta): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(document)
    }
    const fail = (error: ApiError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function handleAbort(): void {
      try {
        xhr.abort()
      } catch {
        fail(abortedError())
      }
    }

    signal?.addEventListener('abort', handleAbort)

    try {
      xhr.open('POST', apiUrl(API_PATHS.uploadDocument))
      xhr.setRequestHeader('content-type', PDF_CONTENT_TYPE)
      xhr.setRequestHeader(REQUEST_HEADERS.fileName, encodeFileName(file.name))
      xhr.setRequestHeader(REQUEST_HEADERS.pageCount, REQUIRED_PAGE_COUNT)
    } catch (error) {
      fail(toApiError(error))
      return
    }

    xhr.upload.onprogress = (event: ProgressEvent): void => {
      if (onProgress === undefined) return
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size
      const loaded = event.loaded
      const ratio = total > 0 ? Math.min(1, Math.max(0, loaded / total)) : 0
      try {
        onProgress({ loaded, total, ratio })
      } catch {
        // A progress renderer must never break or fail the upload.
      }
    }

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          succeed(parseUploadResponse(xhr.status, xhr.responseText))
        } catch (error) {
          fail(toApiError(error))
        }
        return
      }
      fail(errorFromBody(xhr.status, xhr.responseText))
    }
    xhr.onerror = (): void => {
      fail(networkError('upload failed: network error'))
    }
    xhr.ontimeout = (): void => {
      fail(new ApiError(0, 'timeout', 'upload timed out'))
    }
    xhr.onabort = (): void => {
      fail(abortedError())
    }

    try {
      xhr.send(file)
    } catch (error) {
      fail(toApiError(error))
    }
  })
}

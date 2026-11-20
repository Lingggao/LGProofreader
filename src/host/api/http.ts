/**
 * Request/response plumbing for the Ling Gao 校对员 Host API
 * (`src/host/api/handlers.ts`, design §10.2).
 *
 * The `connection.fetch` carrier has already authenticated the browser session
 * before a handler runs (design §10.2), so this module only deals with HTTP
 * mechanics: JSON/error envelopes, content-type checks, bounded body reads and
 * JSON parsing. Every failure is an {@link ApiRequestError} carrying the status
 * and error code the handler guard serializes; nothing here touches the
 * filesystem, the model or the prompt library.
 *
 * Host-only module; Node.js built-ins only.
 */
import type { ApiErrorCode } from '../../shared/api/protocol'

/** Media type every JSON body must declare. */
export const JSON_CONTENT_TYPE = 'application/json'

/** Status/code/message triple thrown by the helpers and mapped to an error response. */
export class ApiRequestError extends Error {
  readonly status: number
  readonly code: ApiErrorCode

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

/** Throw an {@link ApiRequestError}; declared `never` so callers narrow. */
export function fail(status: number, code: ApiErrorCode, message: string): never {
  throw new ApiRequestError(status, code, message)
}

/** Serialize `value` as a JSON response with the plugin's standard headers. */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Build the `{ error: { code, message } }` envelope (design §10.2). */
export function errorResponse(code: ApiErrorCode, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status)
}

/**
 * Build a binary response (`image/png` etc.). The body is passed as an
 * `ArrayBuffer` copy boundary because the DOM/undici `BodyInit` type only
 * guarantees `ArrayBuffer`-backed views; the bytes themselves are not mutated.
 */
export function binaryResponse(
  bytes: Uint8Array,
  contentType: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(toArrayBuffer(bytes), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

/** Copy `bytes` into an `ArrayBuffer` (copying only when the view is offset). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Normalized lower-case media type without parameters, or `undefined` when absent. */
export function requestMediaType(request: Request): string | undefined {
  const raw = request.headers.get('content-type')
  if (raw === null) return undefined
  const mediaType = raw.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === '' ? undefined : mediaType
}

/**
 * Require one of `allowed` media types (parameters such as `charset=utf-8` are
 * accepted) and return the normalized media type. Missing/other types raise a
 * 415 `unsupported_media_type`.
 */
export function requireContentType(request: Request, allowed: readonly string[]): string {
  const mediaType = requestMediaType(request)
  if (mediaType === undefined) {
    fail(415, 'unsupported_media_type', `content-type must be one of: ${allowed.join(', ')}`)
  }
  if (!allowed.includes(mediaType)) {
    fail(415, 'unsupported_media_type', `content-type must be one of: ${allowed.join(', ')}`)
  }
  return mediaType
}

/**
 * Read a `content-length` header. A malformed header is a 400 and an unreadable
 * (non-safe-integer) length is a 413. Absent header returns `undefined`.
 */
function declaredContentLength(request: Request): number | undefined {
  const raw = request.headers.get('content-length')
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    fail(400, 'bad_request', 'invalid content-length header')
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) {
    fail(413, 'payload_too_large', 'request body is too large')
  }
  return value
}

/**
 * Read the whole request body into memory, enforcing `maxBytes`.
 *
 * The declared `content-length` is checked first (cheap rejection, never reads
 * the body), then the stream is read chunk by chunk and aborted as soon as it
 * exceeds the cap, so an oversized/malicious body cannot exhaust the Host heap.
 * Exceeding the cap raises 413; a malformed `content-length` raises 400. An
 * absent body reads as an empty `Uint8Array` (callers decide whether empty is
 * valid).
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('readBoundedBody() requires a non-negative integer byte cap')
  }
  const declared = declaredContentLength(request)
  if (declared !== undefined && declared > maxBytes) {
    fail(413, 'payload_too_large', `request body exceeds the ${maxBytes} byte limit`)
  }
  if (request.body === null) return new Uint8Array(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        fail(413, 'payload_too_large', `request body exceeds the ${maxBytes} byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A cancelled/errored stream may already have released the lock.
    }
  }
  return concatChunks(chunks, total)
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/**
 * Read and parse a JSON request body.
 *
 * Requires `application/json` (415 otherwise), enforces `maxBytes` (413), and
 * maps an empty or syntactically invalid body to 400. The parsed value is
 * returned as `unknown`; handlers validate the actual shape themselves.
 */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  requireContentType(request, [JSON_CONTENT_TYPE])
  const bytes = await readBoundedBody(request, maxBytes)
  if (bytes.byteLength === 0) {
    fail(400, 'bad_request', 'request body must be a JSON value')
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    fail(400, 'bad_request', 'request body is not valid JSON')
  }
}

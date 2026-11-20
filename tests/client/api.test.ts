import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  apiUrl,
  exportUrl,
  getJson,
  pageImageUrl,
  postBinary,
  postJson,
  uploadDocument,
  type UploadProgress,
} from '../../src/client/api/client'

const DOCUMENT = {
  id: 'doc_1',
  fileName: '页面.pdf',
  pageCount: 1,
  createdAt: 1_760_000_000_000,
  status: 'parsing',
} as const

/* ------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* ------------------------------------------------------------------------- */

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []

  static latest(): FakeXMLHttpRequest {
    const instance = FakeXMLHttpRequest.instances.at(-1)
    if (instance === undefined) throw new Error('no XMLHttpRequest was opened')
    return instance
  }

  static reset(): void {
    FakeXMLHttpRequest.instances = []
  }

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 0
  responseText = ''
  aborted = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  send(body: unknown): void {
    this.body = body
    FakeXMLHttpRequest.instances.push(this)
  }

  abort(): void {
    this.aborted = true
    this.onabort?.()
  }

  respond(status: number, body: unknown): void {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.onload?.()
  }

  emitProgress(loaded: number, total: number): void {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent)
  }
}

function stubXhr(): void {
  FakeXMLHttpRequest.reset()
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest as unknown as typeof XMLHttpRequest)
}

function fakeFile(name = '页面.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, {
    type: 'application/pdf',
  })
}

type FetchStub = ReturnType<typeof vi.fn>

function stubFetch(response: Response | (() => Promise<Response>)): FetchStub {
  const fetcher = vi.fn(async () => (typeof response === 'function' ? response() : response))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------------- */
/* apiUrl                                                                     */
/* ------------------------------------------------------------------------- */

describe('apiUrl', () => {
  it('builds relative API urls under /api/lgproofreader', () => {
    expect(apiUrl('page-text', { doc: 'doc_1' })).toMatch(/api\/lgproofreader\/page-text\?doc=doc_1$/)
    expect(apiUrl('page-text', { doc: 'doc_1' })).toBe('api/lgproofreader/page-text?doc=doc_1')
  })

  it('never emits a leading slash so document.baseURI resolves it', () => {
    expect(apiUrl('health').startsWith('/')).toBe(false)
    expect(apiUrl('health')).toBe('api/lgproofreader/health')
  })

  it('normalizes handler names and full protocol paths to one relative route', () => {
    expect(apiUrl('/page-text')).toBe('api/lgproofreader/page-text')
    expect(apiUrl('api/lgproofreader/page-text')).toBe('api/lgproofreader/page-text')
    expect(apiUrl('/api/lgproofreader/page-text')).toBe('api/lgproofreader/page-text')
  })

  it('encodes query params, skips undefined/null and keeps insertion order', () => {
    expect(
      apiUrl('delete', { doc: 'a b&c', skipped: undefined, alsoSkipped: null, n: 2, ok: true }),
    ).toBe('api/lgproofreader/delete?doc=a%20b%26c&n=2&ok=true')
  })

  it('rejects empty route paths', () => {
    expect(() => apiUrl('')).toThrow(TypeError)
    expect(() => apiUrl('/')).toThrow(TypeError)
    expect(() => apiUrl('api/lgproofreader')).toThrow(TypeError)
  })

  it('builds export and page-image urls', () => {
    expect(exportUrl('job_1')).toBe('api/lgproofreader/export?job=job_1&format=md')
    expect(exportUrl('job_1', 'md')).toBe('api/lgproofreader/export?job=job_1&format=md')
    expect(exportUrl('job_1', 'json')).toBe('api/lgproofreader/export?job=job_1&format=json')
    expect(pageImageUrl('doc_1')).toBe('api/lgproofreader/page-image?doc=doc_1')
  })

  it('cache-busts the page image url with an optional version', () => {
    // The canvas requests the page image before POST /page-image exists; a new
    // version after the upload makes the browser fetch the stored PNG again
    // instead of showing the cached 404.
    expect(pageImageUrl('doc_1', 1)).toBe('api/lgproofreader/page-image?doc=doc_1&v=1')
    expect(pageImageUrl('doc_1', 2)).not.toBe(pageImageUrl('doc_1', 1))
    expect(pageImageUrl('doc_1', 'reopen-3')).toBe(
      'api/lgproofreader/page-image?doc=doc_1&v=reopen-3',
    )
  })

  it('validates export formats and ids', () => {
    expect(() => exportUrl('job_1', 'pdf' as never)).toThrow(TypeError)
    expect(() => exportUrl('')).toThrow(TypeError)
    expect(() => pageImageUrl('')).toThrow(TypeError)
    expect(() => pageImageUrl('doc_1', Number.NaN)).toThrow(TypeError)
    expect(() => pageImageUrl('doc_1', '   ')).toThrow(TypeError)
    expect(() => pageImageUrl('doc_1', {} as never)).toThrow(TypeError)
  })
})

/* ------------------------------------------------------------------------- */
/* uploadDocument (XHR)                                                       */
/* ------------------------------------------------------------------------- */

describe('uploadDocument', () => {
  it('POSTs the PDF with x-file-name and x-page-count headers and reads response.document', async () => {
    stubXhr()
    const progress: UploadProgress[] = []
    const pending = uploadDocument(fakeFile('页面.pdf'), (event) => progress.push(event))

    const xhr = FakeXMLHttpRequest.latest()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('api/lgproofreader/documents')
    expect(xhr.headers['content-type']).toBe('application/pdf')
    expect(xhr.headers['x-file-name']).toBe(encodeURIComponent('页面.pdf'))
    expect(xhr.headers['x-page-count']).toBe('1')

    xhr.emitProgress(30, 100)
    xhr.respond(201, { document: DOCUMENT, pages: 1 })

    await expect(pending).resolves.toMatchObject({ id: 'doc_1', pageCount: 1 })
    expect(progress[0]).toMatchObject({ loaded: 30, total: 100, ratio: 0.3 })
  })

  it('accepts any 2xx upload response (upload returns 201)', async () => {
    for (const status of [200, 201, 299]) {
      stubXhr()
      const pending = uploadDocument(fakeFile())
      FakeXMLHttpRequest.latest().respond(status, { document: DOCUMENT, pages: 1 })
      await expect(pending).resolves.toMatchObject({ id: 'doc_1' })
    }
  })

  it('maps the error envelope of a rejected upload', async () => {
    stubXhr()
    const pending = uploadDocument(fakeFile())
    FakeXMLHttpRequest.latest().respond(422, {
      error: { code: 'unprocessable_entity', message: 'PDF must contain exactly 1 page; got 2.' },
    })
    await expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      code: 'unprocessable_entity',
      message: 'PDF must contain exactly 1 page; got 2.',
    })
  })

  it('maps a non-JSON upload failure to a generic http_error', async () => {
    stubXhr()
    const pending = uploadDocument(fakeFile())
    FakeXMLHttpRequest.latest().respond(500, 'boom')
    await expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      code: 'http_error',
    })
  })

  it('maps XHR network failures', async () => {
    stubXhr()
    const pending = uploadDocument(fakeFile())
    FakeXMLHttpRequest.latest().onerror?.()
    await expect(pending).rejects.toMatchObject({ name: 'ApiError', code: 'network_error' })
  })

  it('rejects malformed upload responses', async () => {
    stubXhr()
    const pending = uploadDocument(fakeFile())
    FakeXMLHttpRequest.latest().respond(201, { ok: true })
    await expect(pending).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('aborts the upload when the signal aborts', async () => {
    stubXhr()
    const controller = new AbortController()
    const pending = uploadDocument(fakeFile(), undefined, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'ApiError', code: 'aborted' })
    expect(FakeXMLHttpRequest.latest().aborted).toBe(true)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    stubXhr()
    const controller = new AbortController()
    controller.abort()
    await expect(uploadDocument(fakeFile(), undefined, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    })
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------- */
/* JSON helpers (fetch)                                                       */
/* ------------------------------------------------------------------------- */

describe('postJson', () => {
  it('POSTs JSON to a relative route and parses the response', async () => {
    const fetcher = stubFetch(jsonResponse({ ok: true }))
    const result = await postJson<{ ok: boolean }>('settings', { depth: 'deep' })

    expect(result).toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('api/lgproofreader/settings')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ depth: 'deep' })
    expect(init.signal).toBeUndefined()
  })

  it('passes query params and the abort signal through', async () => {
    const fetcher = stubFetch(jsonResponse({ ok: true }))
    const controller = new AbortController()
    await postJson('cancel', { jobId: 'job_1' }, { params: { doc: 'doc_1' }, signal: controller.signal })
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('api/lgproofreader/cancel?doc=doc_1')
    expect(init.signal).toBe(controller.signal)
  })

  it('maps JSON error envelopes to ApiError', async () => {
    stubFetch(jsonResponse({ error: { code: 'bad_request', message: 'nope' } }, 400))
    const pending = postJson('settings', {})
    await expect(pending).rejects.toBeInstanceOf(ApiError)
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'bad_request', message: 'nope' })
  })
})

describe('getJson', () => {
  it('GETs a relative route with params and parses the response', async () => {
    const fetcher = stubFetch(jsonResponse({ id: 'doc_1' }))
    const result = await getJson<{ id: string }>('document', { doc: 'doc_1' })

    expect(result).toEqual({ id: 'doc_1' })
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('api/lgproofreader/document?doc=doc_1')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('maps 404 envelopes', async () => {
    stubFetch(jsonResponse({ error: { code: 'not_found', message: 'job not found: job_9' } }, 404))
    await expect(getJson('job', { job: 'job_9' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'job not found: job_9',
    })
  })

  it('rejects malformed JSON success bodies', async () => {
    stubFetch(new Response('<html>not json</html>', { status: 200 }))
    await expect(getJson('health')).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('maps fetch network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(getJson('health')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'network_error',
    })
  })

  it('maps aborted fetches', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortError
      }),
    )
    await expect(getJson('health')).rejects.toMatchObject({ name: 'ApiError', code: 'aborted' })
  })
})

describe('postBinary', () => {
  it('POSTs a PNG with its content type and query params', async () => {
    const fetcher = stubFetch(jsonResponse({ ok: true }))
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    const result = await postBinary('page-image', png, { params: { doc: 'doc_1' } })

    expect(result).toEqual({ ok: true })
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('api/lgproofreader/page-image?doc=doc_1')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'content-type': 'image/png' })
    expect(init.body).toBe(png)
  })

  it('maps binary upload errors', async () => {
    stubFetch(jsonResponse({ error: { code: 'payload_too_large', message: 'too big' } }, 413))
    const png = new Blob([new Uint8Array([0x89])], { type: 'image/png' })
    await expect(postBinary('page-overlay', png, { params: { doc: 'doc_1' } })).rejects.toMatchObject({
      status: 413,
      code: 'payload_too_large',
      message: 'too big',
    })
  })
})

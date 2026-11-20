/**
 * PDF.js worker bootstrap (Client, Task 16).
 *
 * The prebuilt Client bundle inlines the PDF.js worker script as a string
 * (`worker-source.ts`). At runtime this module converts it into a worker URL and
 * assigns it to PDF.js's `GlobalWorkerOptions.workerSrc`:
 *
 * 1. prefer `URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))`
 *    (works from a single-file bundle without any DSH asset protocol);
 * 2. if Blob URL creation is unavailable/blocked (CSP, old environment), fall
 *    back to a `data:text/javascript` URL so PDF.js can still import the worker
 *    script and, when even that fails, fall back to its in-main-thread fake
 *    worker;
 * 3. when no worker source was injected at all (development/tests), leave
 *    `workerSrc` untouched so PDF.js uses its fake worker.
 *
 * The Blob URL is created lazily once per module and revoked by
 * {@link disposePdfWorker}; keeping one URL for the panel's lifetime avoids
 * leaking a new Blob per parsed file.
 */
import { PDF_WORKER_SOURCE } from './worker-source'

/** The PDF.js `GlobalWorkerOptions` surface this module needs (static class). */
export interface PdfWorkerOptionsTarget {
  /** PDF.js worker script URL (static property in pdfjs-dist 6.x). */
  workerSrc: string
}

/** The browser APIs used to build worker URLs; injectable for tests. */
export interface WorkerUrlEnvironment {
  /** `Blob` constructor; the Blob URL branch is skipped when absent. */
  Blob?: typeof Blob
  /** URL helpers; `createObjectURL` may throw or be absent. */
  URL?: {
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
  }
}

/** Worker URL handed to PDF.js, plus how to revoke it (only Blob URLs need it). */
interface InstalledWorker {
  url: string
  revoke: (() => void) | null
}

let installed: InstalledWorker | null = null

function defaultEnvironment(): WorkerUrlEnvironment {
  const environment: WorkerUrlEnvironment = {}
  if (typeof Blob === 'function') environment.Blob = Blob
  // `URL` is a constructor function in browsers and Node (not an object).
  if ((typeof URL === 'function' || typeof URL === 'object') && URL !== null) {
    environment.URL = URL
  }
  return environment
}

function toDataUrl(source: string): string | null {
  try {
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`
  } catch {
    // A source containing lone surrogates cannot be percent-encoded; PDF.js
    // then falls back to its fake worker on its own.
    return null
  }
}

/**
 * Build a URL for the PDF.js worker script source.
 *
 * Returns a `blob:` URL when available, otherwise a `data:` URL, and `null`
 * when there is no injected source (development/tests). The fallback keeps the
 * fake-worker path available instead of leaving `workerSrc` unusable.
 */
export function createWorkerSrc(
  source: string,
  environment: WorkerUrlEnvironment = defaultEnvironment(),
): string | null {
  if (typeof source !== 'string' || source.trim() === '') return null

  const BlobConstructor = environment.Blob
  const urlApi = environment.URL
  if (
    typeof BlobConstructor === 'function' &&
    urlApi !== undefined &&
    typeof urlApi.createObjectURL === 'function'
  ) {
    try {
      return urlApi.createObjectURL(new BlobConstructor([source], { type: 'text/javascript' }))
    } catch {
      // Fall through to the data URL so PDF.js can still load its worker.
    }
  }
  return toDataUrl(source)
}

/**
 * Install the injected worker URL into PDF.js `GlobalWorkerOptions` once.
 *
 * Idempotent: later calls return the URL installed by the first one (the panel
 * may parse several documents). When no source is available nothing is set, so
 * PDF.js keeps its fake-worker fallback.
 *
 * @returns the installed URL, or `null` when no worker source was injected.
 */
export function installPdfWorker(
  target: PdfWorkerOptionsTarget,
  source: string = PDF_WORKER_SOURCE,
  environment?: WorkerUrlEnvironment,
): string | null {
  if (installed !== null) return installed.url

  const url = createWorkerSrc(source, environment)
  if (url === null) return null

  const urlApi = (environment ?? defaultEnvironment()).URL
  const revokeObjectURL = urlApi?.revokeObjectURL
  const revoke =
    typeof revokeObjectURL === 'function'
      ? () => {
          try {
            revokeObjectURL.call(urlApi, url)
          } catch {
            // Revoking an already-revoked/foreign URL must never fail a panel.
          }
        }
      : null

  installed = { url, revoke }
  target.workerSrc = url
  return url
}

/**
 * Revoke the installed Blob URL (call on panel unmount). Safe to call when
 * nothing was installed or when the fallback data URL was used (`data:` URLs
 * need no revocation), and safe to call repeatedly.
 */
export function disposePdfWorker(): void {
  const current = installed
  installed = null
  current?.revoke?.()
}

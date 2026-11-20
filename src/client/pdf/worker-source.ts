/**
 * Build-time PDF.js worker source declaration (Client, Task 16).
 *
 * The Client bundle is a single prebuilt file (design §12.2): the PDF.js worker
 * script is **not** shipped as a separate asset. Instead `scripts/build.mjs`
 * (Task 20) reads `pdfjs-dist/build/pdf.worker.min.mjs` and injects it through
 * esbuild's `define` as the string literal `__PDF_WORKER_SOURCE__`. At runtime
 * `worker.ts` turns that string into a worker URL and assigns it to PDF.js's
 * `GlobalWorkerOptions.workerSrc`.
 *
 * The injected constant does not exist in development/test bundles, so the
 * reference is wrapped in `try`/`catch` and falls back to an empty string there
 * (safe: a bare identifier is only evaluated inside the guarded block, and only
 * one copy of the injected literal is emitted by the build). With no source,
 * `parser.ts` leaves the PDF.js worker configuration untouched and PDF.js uses
 * its in-main-thread fake worker, which is what Vitest relies on.
 */

declare global {
  /**
   * PDF.js worker script source, replaced at build time by esbuild's `define`.
   * Never read outside the guarded accessor in this module: it does not exist
   * outside the production bundle.
   */
  const __PDF_WORKER_SOURCE__: string
}

function readInjectedWorkerSource(): string {
  try {
    return __PDF_WORKER_SOURCE__
  } catch {
    // Development/test bundles do not define the constant.
    return ''
  }
}

/**
 * The injected PDF.js worker source, or `''` when the bundle did not define it
 * (development/tests).
 */
export const PDF_WORKER_SOURCE: string = readInjectedWorkerSource()

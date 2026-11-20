/**
 * Tests for the Host-side single-page guard (`src/host/pdf/page-count.ts`).
 *
 * The Host has no PDF parser dependency (global constraint: Host runtime has
 * zero npm dependencies), so the upload handler validates the page count with a
 * minimal, deterministic scanner over the raw bytes. The scanner counts page
 * objects (`/Type /Page`) and must never count the page tree node
 * (`/Type /Pages`) or names that merely start with `Page`.
 *
 * These tests pin the scanner's contract on synthetic bytes only; they never
 * load a real PDF.
 */
import { describe, expect, it } from 'vitest'
import { countPdfPages } from '../../src/host/pdf/page-count'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const ONE_PAGE_PDF = '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Pages >> endobj\n%%EOF'
const TWO_PAGE_PDF = '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF'

describe('countPdfPages', () => {
  it('counts page objects in a minimal PDF', () => {
    expect(countPdfPages(encode(ONE_PAGE_PDF))).toBe(1)
  })

  it('counts every page object of a multipage PDF', () => {
    expect(countPdfPages(encode(TWO_PAGE_PDF))).toBe(2)
  })

  it('does not count the page tree node (/Type /Pages)', () => {
    const pdf =
      '%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 /Kids [2 0 R 3 0 R] >> endobj\n' +
      '2 0 obj << /Type /Page /Parent 1 0 R >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 1 0 R >> endobj\n%%EOF'
    expect(countPdfPages(encode(pdf))).toBe(2)
  })

  it('accepts arbitrary PDF whitespace and a comment between the names', () => {
    expect(countPdfPages(encode('%PDF-1.4\n<</Type/Page>>>>EOF'))).toBe(1)
    expect(countPdfPages(encode('%PDF-1.4\n<</Type  /Page>>>>EOF'))).toBe(1)
    expect(countPdfPages(encode('%PDF-1.4\n<</Type\n\t/Page>>>>EOF'))).toBe(1)
  })

  it('ignores names that only start with Page', () => {
    const pdf =
      '%PDF-1.4\n1 0 obj << /Type /Pages /Type /PageLayout /Type /PageMode >> endobj\n%%EOF'
    expect(countPdfPages(encode(pdf))).toBe(0)
  })

  it('returns 0 when the bytes contain no page object', () => {
    expect(countPdfPages(new Uint8Array(0))).toBe(0)
    expect(countPdfPages(encode('not a pdf'))).toBe(0)
    // A page tree without any leaf page object is not a usable page.
    expect(countPdfPages(encode('%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n%%EOF'))).toBe(0)
  })

  it('works on a Uint8Array view with a byte offset', () => {
    const padded = encode(`padding${ONE_PAGE_PDF}`)
    const view = padded.subarray('padding'.length)
    expect(countPdfPages(view)).toBe(1)
  })
})

/**
 * Minimal PDF page-count guard for the Host upload path (design §10.2: v1
 * accepts exactly one page per PDF, and the Host validates the page count).
 *
 * The Host runtime is constrained to Node.js built-ins (global constraint:
 * zero npm dependencies), so this module reads the raw PDF bytes and counts page
 * objects (`/Type /Page`) with a small token scanner instead of a full parser.
 * That is deliberate:
 *
 * - the Client already parses the PDF with PDF.js and rejects multipage files
 *   before uploading (Task 16); this Host scan is the defence-in-depth check;
 * - the scan is deterministic and allocation-free (it never decodes the whole
 *   file to a string), so a 150 MB upload cannot blow the Host heap;
 * - it counts only leaf page objects and explicitly ignores the page tree node
 *   (`/Type /Pages`) and longer names (`/PageMode`, `/PageLayout`, ...).
 *
 * Limitation (documented on purpose): a PDF whose page dictionaries live inside
 * a compressed object stream (`/ObjStm`) has no plain `/Type /Page` text and
 * therefore counts as 0 pages. The upload handler treats "not detected" as
 * acceptable because the Client already enforced exactly one page; a count
 * greater than one is always rejected.
 *
 * Host-only module; Node built-ins only.
 */

/** ASCII `/Type` following the name slash. */
const TYPE_NAME = [0x54, 0x79, 0x70, 0x65] as const
/** ASCII `Page` following the value slash. */
const PAGE_NAME = [0x50, 0x61, 0x67, 0x65] as const

const SLASH = 0x2f

/** PDF white-space characters (ISO 32000-1 §7.2.2). */
function isPdfWhitespace(byte: number): boolean {
  return (
    byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20
  )
}

/** PDF delimiters `()<>[]{}/%`; anything else continues a name. */
function isPdfDelimiter(byte: number): boolean {
  return (
    isPdfWhitespace(byte) ||
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === SLASH || // /
    byte === 0x25 // %
  )
}

/** True when `name` appears at `offset` in `bytes`. */
function matchesName(bytes: Uint8Array, offset: number, name: readonly number[]): boolean {
  if (offset + name.length > bytes.length) return false
  for (let index = 0; index < name.length; index += 1) {
    if (bytes[offset + index] !== name[index]) return false
  }
  return true
}

/**
 * Count leaf page objects (`/Type /Page`) in the given PDF bytes.
 *
 * Returns 0 when no page object is visible in the raw bytes (empty input,
 * non-PDF bytes, or a compressed object stream), and the number of page objects
 * otherwise. The scan never throws.
 */
export function countPdfPages(bytes: Uint8Array): number {
  let pages = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== SLASH) continue
    if (!matchesName(bytes, index + 1, TYPE_NAME)) continue

    // `/Type` may be separated from `/Page` by any amount of PDF whitespace
    // (zero included: `/Type/Page` is valid because `/` is a delimiter).
    let cursor = index + 1 + TYPE_NAME.length
    while (cursor < bytes.length && isPdfWhitespace(bytes[cursor] as number)) cursor += 1
    if (bytes[cursor] !== SLASH) continue
    cursor += 1
    if (!matchesName(bytes, cursor, PAGE_NAME)) continue

    // `/Page` must end at a delimiter; otherwise it is a longer name such as
    // `/Pages`, `/PageMode` or `/PageLayout`.
    const afterName = cursor + PAGE_NAME.length
    if (afterName < bytes.length && !isPdfDelimiter(bytes[afterName] as number)) continue

    pages += 1
    index = afterName - 1
  }
  return pages
}

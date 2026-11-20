#!/usr/bin/env node
/**
 * Generate the plugin-details page assets (Task 20; design §12.1/§12.3).
 *
 * The Plugin Manager detail page shows the localized `meta.description` plus the
 * one feature image named by `meta.detail` (plugin-details checklist). This
 * script regenerates those committed files deterministically from source assets:
 *
 * - `docs/preview.svg` — a self-contained 640×300 workbench illustration with the
 *   unchanged `assets/brand/wordmark-dark.png` embedded as a base64 PNG data URL
 *   (allowed for redistribution-permitted brand artwork). It uses only shapes:
 *   no `<text>`, `<style>`, `<script>`, `<foreignObject>`, event handlers or
 *   remote references, so it renders on light and dark themes without a font or
 *   network dependency.
 * - `docs/DETAIL.md` / `docs/DETAIL.zh.md` — exactly one localized image line
 *   with meaningful alternative text. Functionality and usage stay in the locale
 *   `meta.description` (plugin-details checklist), never duplicated here.
 *
 * Run `pnpm detail` after changing the illustration template or the wordmark.
 * Node.js built-ins only; not shipped.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository/package root (this file lives in `<root>/scripts/`). */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const DOCS_DIR = join(ROOT, 'docs')
const WORDMARK_DARK = join(ROOT, 'assets', 'brand', 'wordmark-dark.png')

/** English detail document (one localized image line). */
const DETAIL_EN = [
  '![Ling Gao Proofreader workbench: a newspaper page with detected article regions and a proofreading checklist](preview.svg)',
  '',
].join('\n')

/** Chinese detail document (one localized image line). */
const DETAIL_ZH = [
  '![Ling Gao 校对员界面示意：报纸版面区域识别与校对问题清单](preview.svg)',
  '',
].join('\n')

/**
 * Render the 640×300 feature image.
 *
 * The illustration shows the three-column workbench: recent-document rail, the
 * newspaper page with red/blue detected region boxes, and the findings/fact
 * checklist panel. Brand navy `#0F172A`, red `#E54646` and blue `#184785` come
 * from `assets/brand/README.md`; neutrals are theme-independent UI greys.
 *
 * @param {string} wordmarkDataUrl `data:image/png;base64,…` of the dark wordmark.
 * @returns {string} Self-contained SVG source.
 */
export function renderPreviewSvg(wordmarkDataUrl) {
  if (typeof wordmarkDataUrl !== 'string' || !wordmarkDataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('renderPreviewSvg() requires the wordmark PNG data URL')
  }

  /** Repeated grey text line. */
  const line = (x, y, width, opacity = '1') =>
    `<rect x="${x}" y="${y}" width="${width}" height="3" rx="1.5" fill="#94A3B8" opacity="${opacity}"/>`

  /** Repeated findings-panel row (severity dot + two text bars). */
  const finding = (x, y, color) =>
    [
      `<circle cx="${x + 4}" cy="${y + 4}" r="4" fill="${color}"/>`,
      line(x + 14, y + 1, 118),
      line(x + 14, y + 9, 84, '0.75'),
    ].join('')

  // The left rail's four document rows.
  const railRows = [0, 1, 2, 3]
    .map(
      (index) =>
        `<rect x="38" y="${120 + index * 32}" width="84" height="24" rx="5" fill="#E2E8F0"/>` +
        line(46, 127 + index * 32, 54) +
        line(46, 134 + index * 32, 34, '0.7'),
    )
    .join('')

  // Three body columns of a newspage, with the page header above them.
  const columnLines = [0, 1, 2]
    .map((column) => {
      const x = 152 + column * 76
      return [0, 1, 2, 3, 4, 5, 6, 7]
        .map((row) => line(x, 150 + row * 13, row === 7 ? 44 : 62, '0.85'))
        .join('')
    })
    .join('')

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300" role="img">',
    '  <rect width="640" height="300" fill="#0F172A"/>',
    `  <image x="24" y="18" width="180" height="58" href="${wordmarkDataUrl}"/>`,
    '  <rect x="224" y="32" width="392" height="4" rx="2" fill="#184785" opacity="0.55"/>',
    '  <rect x="224" y="43" width="250" height="4" rx="2" fill="#E54646" opacity="0.65"/>',
    '  <!-- workbench card -->',
    '  <rect x="24" y="96" width="592" height="182" rx="12" fill="#F8FAFC"/>',
    '  <rect x="24" y="96" width="592" height="182" rx="12" fill="none" stroke="#CBD5E1"/>',
    '  <!-- recent-document rail -->',
    '  <rect x="34" y="106" width="92" height="162" rx="8" fill="#EEF2F7"/>',
    line(46, 114, 44),
    railRows,
    '  <!-- newspaper page -->',
    '  <rect x="136" y="106" width="246" height="162" rx="6" fill="#FFFFFF"/>',
    '  <rect x="136" y="106" width="246" height="162" rx="6" fill="none" stroke="#CBD5E1"/>',
    '  <rect x="146" y="114" width="226" height="22" rx="4" fill="#0F172A"/>',
    '  <rect x="154" y="121" width="70" height="8" rx="2" fill="#F8FAFC"/>',
    '  <rect x="232" y="121" width="52" height="8" rx="2" fill="#E54646" opacity="0.85"/>',
    '  <rect x="292" y="121" width="30" height="8" rx="2" fill="#184785" opacity="0.85"/>',
    columnLines,
    '  <!-- detected article regions (lead red / body blue) -->',
    '  <rect x="146" y="144" width="142" height="54" rx="4" fill="#E54646" fill-opacity="0.14" stroke="#E54646"/>',
    '  <rect x="296" y="144" width="74" height="118" rx="4" fill="#184785" fill-opacity="0.12" stroke="#184785"/>',
    '  <rect x="146" y="206" width="142" height="54" rx="4" fill="#184785" fill-opacity="0.12" stroke="#184785"/>',
    '  <!-- proofreading report panel -->',
    '  <rect x="394" y="106" width="212" height="162" rx="8" fill="#EEF2F7"/>',
    line(406, 116, 76),
    '  <rect x="406" y="126" width="188" height="2" fill="#CBD5E1"/>',
    finding(406, 136, '#E54646'),
    finding(406, 165, '#D97706'),
    finding(406, 194, '#184785'),
    finding(406, 223, '#64748B'),
    '  <rect x="406" y="248" width="188" height="2" fill="#CBD5E1"/>',
    line(406, 255, 120, '0.8'),
    '  <!-- brand underline -->',
    '  <rect x="24" y="290" width="96" height="4" rx="2" fill="#E54646"/>',
    '  <rect x="120" y="290" width="96" height="4" rx="2" fill="#184785"/>',
    '</svg>',
    '',
  ].join('\n')
}

/** Read the unchanged dark wordmark and turn it into a PNG data URL. */
async function readWordmarkDataUrl() {
  const png = await readFile(WORDMARK_DARK)
  const signature = png.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${WORDMARK_DARK} is not a PNG file`)
  }
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Write all three generated detail-page files. */
async function main() {
  const wordmarkDataUrl = await readWordmarkDataUrl()
  const preview = renderPreviewSvg(wordmarkDataUrl)

  await mkdir(DOCS_DIR, { recursive: true })
  await writeFile(join(DOCS_DIR, 'preview.svg'), preview, 'utf8')
  await writeFile(join(DOCS_DIR, 'DETAIL.md'), DETAIL_EN, 'utf8')
  await writeFile(join(DOCS_DIR, 'DETAIL.zh.md'), DETAIL_ZH, 'utf8')

  console.log(`detail: docs/preview.svg ${(Buffer.byteLength(preview, 'utf8') / 1024).toFixed(1)} KiB`)
  console.log('detail: docs/DETAIL.md')
  console.log('detail: docs/DETAIL.zh.md')
  console.log('detail: ok')
}

// Run only when executed as a script (the renderer stays importable by tooling).
if (isExecutedAsScript()) await main()

/** True when Node was asked to run this file directly, not to import it. */
function isExecutedAsScript() {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  return pathToFileURL(resolve(entry)).href === import.meta.url
}

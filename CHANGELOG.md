# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-22

### Fixed

- Photo captions/sidebar fragments that fall inside a neighbouring article's
  rectangular vision region no longer leak into that article's body. A
  deterministic wide-column-band filter keeps short indented lines and
  multi-column prose; verified on `2B20261122.pdf` (the C罗 article no longer
  contains the 奔流音乐会 caption).

### Changed

- PDF preview is supersampled at up to 6000 px / 480 DPI (instead of 3000 px /
  240 DPI), with automatic downsampling only for the stored display PNG when it
  would exceed the Host's 20 MiB image limit.
- Default preview mode is **fit page** (whole page visible), with a separate
  **fit width** control. The image uses `object-fit: contain`, so a tiny
  page/bitmap ratio difference can never stretch text horizontally.

## [1.0.0] - 2026-11-21

First stable release. Adds an independent, network-backed noun-existence check
alongside fact checking, removes confidence text from PDF region boxes, and
ships the one-click GitHub Actions release workflow.

### Added

- Independent `nouns` role: prioritized noun/term extraction, Host web search,
  deterministic existence classification (`exists` / `uncertain` / `not_found` /
  `not_checked`), sources, live plan/progress and a report section. It runs in
  parallel with `facts`, has its own sub-agent and its own time budget; it never
  judges whether a sentence is true and never claims a term does not exist.
- `docs/releases/v1.0.0.md` and `.github/workflows/release.yml`: manual
  `workflow_dispatch` release that runs typecheck/tests/build/validate/release
  and publishes the GitHub Release assets automatically.

### Changed

- PDF preview region boxes no longer print percentage confidence; the inspector
  still exposes the numeric confidence.
- Release workflow version input defaults to `1.0.0`.

## [0.1.0] - 2026-11-20

First public release. Ling Gao 校对员 / Ling Gao Proofreader is a DeepSeek Harness
bundle that turns single-page newspaper PDFs into structured articles and an
itemized, source-backed proofreading report.

### Added

- DeepSeek Harness bundle manifest, Cordis patch row and localized plugin-manager
  metadata (zh `Ling Gao 校对员`, en `Ling Gao Proofreader`), 512×512 icon and a
  one-image plugin details page.
- Shared data model and pure geometry/layout helpers (`src/shared/`): reading-order
  line clustering, column detection, candidate blocks, deterministic article
  reassembly, JSON repair, claim/finding validation, finding merge and the shared
  Markdown report renderer.
- Client workbench (prebuilt single-file `lib/client.js` loaded through the DSH
  ModuleLoader): document rail, PDF canvas with editable colored region boxes,
  article list and manual corrections (move/resize/merge/split/relabel, undo/redo,
  article text editing, layout save), proofreading progress, fact-check checklist,
  report filters/batch actions and Markdown/JSON export.
- Client-side PDF parsing with PDF.js: single-page guard, text-run extraction,
  line/candidate generation, page and numbered-overlay PNG rendering, and the
  PDF.js worker inlined at build time.
- Host plugin (`lib/index.js`) with a local-only document store under
  `plugin-data/lgproofreader/`, 17 exact `/api/lgproofreader` connection routes,
  settings, metadata and health endpoints.
- Background layout analysis (one vision call, validated grouping, fallback) and
  deterministic text reassembly with coverage/overlap warnings.
- Background proofreading pipeline: quick/standard/deep role presets, fact
  checking in every depth (claim extraction, host-side web search/fetch, verdict
  adjudication), per-role retry/timeout/cancel, cache and crash-safe per-role
  result files, and consolidator reporting.
- Prompt library under `prompts/zh/` (base prompt, shared rules, 8 role prompts,
  4 JSON-schema contracts); prompt text is read only by the Host and never sent
  to the browser, an API response or a report.
- Build and release tooling: `scripts/build.mjs` (Host ESM + wrapped Client
  bundle, artifact checks), `scripts/detail.mjs` (detail page image/docs),
  `scripts/validate.mjs` (manifest/locale/icon/artifacts/prompts/version plus an
  installed-layout prompt-resolution smoke test), `scripts/release.mjs`
  (deterministic `.zip`, `.tgz`, `SHA256SUMS.txt`), `scripts/package-release.ps1`
  wrapper and the dev-only `scripts/baseline-pdfium.py` character baseline.
- Documentation: README install/build/privacy notes, plugin details documents,
  feature preview, MIT `LICENSE`, and `THIRD_PARTY_NOTICES.md` (pdfjs-dist under
  Apache-2.0, brand artwork excluded from the MIT code license).

### Known limitations

- v1 accepts exactly one page per PDF and rejects multi-page files (no page
  navigation or cross-page continuation stitching); continuation markers are
  reported as a notice only.
- Scanned PDFs without a text layer are not OCR'd; the page may finish with no
  articles and a layout warning rather than an explicit "no text layer" error.
- Proofreading never rewrites the article: it only lists itemized suggestions.
- The panel does not create chat sessions or write session logs.

# Testing

This repository's 1.0.0 release was validated with:

- **915 unit/integration/UI tests** across 39 test files (`pnpm test`);
- `pnpm typecheck` with zero errors;
- `pnpm build`, `pnpm validate`, and `pnpm release`;
- a clean-directory install of the generated `.tgz` (`pnpm add file:...`) with both bundles passing `node --check`;
- a real-browser end-to-end check of the independent noun role: one article, 34 nouns planned, noun plan visible at 00:22, 30 `exists` + 4 `not_checked`, 34 rows in the final report UI, 0 console errors and 0 failed HTTP responses;
- the PDF preview showed **no confidence text** in region boxes (`0` confidence elements) while region editing still worked;
- an earlier real-browser matrix of **10 single-page newspaper PDFs**: 10/10 reached `ready`, 48 articles assembled, page images returned 200, 0 console errors / 0 failed HTTP responses;
- browser interaction checks for settings back/close, collapsible document rail, PDF wheel zoom and fit width, region-inspector close, complete article text, live fact-check progress and live noun-check plan/progress, and cancelling a proofreading job;
- error-path checks for an invalid PDF, a multi-page PDF, and recovery by uploading a valid file afterward.

The test corpus includes only locally supplied newspaper pages and is **not committed** to the repository. Temporary screenshots and reports were used during development and are not part of the public source tree.

For a clean install, download a Release asset:

- `LGProofreader-1.0.0.tgz` — recommended DSH Add plugin target;
- `LGProofreader-1.0.0.zip` — extract and select the directory containing `package.json`;
- `SHA256SUMS.txt` — verify both artifacts.

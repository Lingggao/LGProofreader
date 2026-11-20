# Testing

This repository's release was validated with:

- **841 unit/integration/UI tests** across 35 test files (`pnpm test`);
- `pnpm typecheck` with zero errors;
- `pnpm build`, `pnpm validate`, and `pnpm release`;
- a clean-directory install of the generated `.tgz` (`pnpm add file:...`) with both bundles passing `node --check`;
- a real-browser matrix of **10 single-page newspaper PDFs**: 10/10 reached `ready`, 48 articles were assembled, page images returned 200, and the matrix recorded 0 console errors / 0 failed HTTP responses;
- browser interaction checks for settings back/close, collapsible document rail, PDF wheel zoom and fit width, region-inspector close, complete article text, live fact-check progress, and cancelling a proofreading job;
- error-path checks for an invalid PDF, a multi-page PDF, and recovery by uploading a valid file afterward.

The test corpus includes only locally supplied newspaper pages and is **not committed** to the repository. Temporary screenshots and reports were used during development and are not part of the public source tree.

For a clean install, download a Release asset:

- `LGProofreader-0.1.0.tgz` — recommended DSH Add plugin target;
- `LGProofreader-0.1.0.zip` — extract and select the directory containing `package.json`;
- `SHA256SUMS.txt` — verify both artifacts.

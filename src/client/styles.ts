/**
 * Panel stylesheet (Task 17; design §9.2/§9.5; type scale + overlays Task 24).
 *
 * Rules of engagement:
 * - every class is prefixed `lgp-` so the panel can never leak selectors into
 *   the shipped DSH UI;
 * - colors come **only** from `--dsw-alias-*` theme tokens, so light/dark
 *   follow the DSH theme automatically (no literal colors);
 * - the wordmark pair switches on `body[data-ds-dark-theme]`, which is the
 *   attribute the DSH theme presenter maintains;
 * - animations are limited to 150 ms background/border transitions and are
 *   disabled under `prefers-reduced-motion`;
 * - typography comes from the `.lgp-root` type scale (Task 24): a Chinese-safe
 *   font stack, 15 px/1.6 body, 14 px controls, >=12 px labels, 17–22 px
 *   headings and 24 px summary numbers. No UI copy below 12 px.
 *
 * `App` injects this string through a `<style>` element it owns, so HMR/unload
 * removes it with the panel (no global `document.head` side channel).
 */
export const clientStyles = `
.lgp-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  /* Task 24 type scale: Chinese-friendly stack + calm, readable sizes. */
  --lgp-font-sans: "Noto Sans SC", "Microsoft YaHei UI", "Segoe UI", sans-serif;
  --lgp-text-label: 12px;
  --lgp-text-sm: 13px;
  --lgp-text-control: 14px;
  --lgp-text-base: 15px;
  --lgp-text-heading: 17px;
  --lgp-text-title: 22px;
  --lgp-text-stat: 24px;
  --lgp-line-body: 1.6;
  font-family: var(--lgp-font-sans);
  font-size: var(--lgp-text-base);
  line-height: var(--lgp-line-body);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
.lgp-root *,
.lgp-root *::before,
.lgp-root *::after {
  box-sizing: border-box;
}

.lgp-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.lgp-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 56px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.lgp-header-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  flex: 0 0 auto;
}
.lgp-brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lgp-header-name {
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.lgp-header-tagline {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.lgp-header-document {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-secondary);
}
.lgp-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.lgp-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 5px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: var(--lgp-font-sans);
  font-size: var(--lgp-text-control);
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  transition: background 150ms ease, border-color 150ms ease;
}
.lgp-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.lgp-button:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
}
.lgp-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.lgp-button:disabled {
  opacity: 0.55;
  cursor: default;
}
.lgp-button--primary {
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-inverted);
}
.lgp-button--primary:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary);
  filter: brightness(1.08);
}
.lgp-button--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--dsw-alias-label-secondary);
}
.lgp-button--ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.lgp-transfer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-secondary);
}
.lgp-transfer-label {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.lgp-transfer-bar {
  flex: 1 1 auto;
  height: 8px;
  accent-color: var(--dsw-alias-brand-primary);
}
.lgp-transfer-percent {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

.lgp-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}

.lgp-rail {
  width: 240px;
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 14px;
  overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lgp-rail-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.lgp-rail-collapse {
  min-width: 30px;
  min-height: 30px;
  padding: 2px 8px;
  font-size: 18px;
  line-height: 1;
}
.lgp-rail--collapsed {
  width: 48px;
  flex: 0 0 48px;
  padding: 10px 6px;
  overflow: visible;
}
.lgp-rail-expand {
  width: 36px;
  min-height: 40px;
  padding: 2px 0;
  font-size: 18px;
  line-height: 1;
}
.lgp-rail-title {
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary);
}
.lgp-rail-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow: auto;
}
.lgp-rail-empty {
  margin: 0;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-rail-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lgp-rail-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.lgp-rail-item:disabled {
  opacity: 0.55;
  cursor: default;
}
.lgp-rail-item:disabled:hover {
  background: transparent;
}
.lgp-rail-item:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.lgp-rail-item[aria-current='true'] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-active);
}
.lgp-rail-item-title {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--lgp-text-control);
  font-weight: 600;
}
.lgp-rail-item-meta {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}

.lgp-center {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.lgp-aside {
  width: 400px;
  flex: 0 0 400px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 14px;
  overflow: auto;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}

.lgp-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 24px;
  text-align: center;
}
.lgp-wordmark {
  width: 220px;
  max-width: 60%;
}
.lgp-wordmark-image {
  display: block;
  width: 100%;
  height: auto;
}
.lgp-wordmark--dark {
  display: none;
}
body[data-ds-dark-theme] .lgp-wordmark--light {
  display: none;
}
body[data-ds-dark-theme] .lgp-wordmark--dark {
  display: block;
}
.lgp-empty-name {
  margin: 0;
  font-size: var(--lgp-text-title);
  font-weight: 600;
  line-height: 1.3;
  color: var(--dsw-alias-label-primary);
}
.lgp-empty-lead {
  margin: 0;
  max-width: 520px;
  font-size: var(--lgp-text-base);
  color: var(--dsw-alias-label-secondary);
}
.lgp-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: min(560px, 100%);
  padding: 28px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color 150ms ease, background 150ms ease;
}
.lgp-dropzone[data-dragging='true'] {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.lgp-drop-hint {
  margin: 0;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-secondary);
}
.lgp-empty-hint {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-inline-error {
  margin: 0;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-state-error-primary);
}

.lgp-canvas-placeholder {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 24px;
  padding: 24px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  text-align: center;
}
.lgp-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 160px;
  margin: 0;
  padding: 24px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  text-align: center;
}
.lgp-placeholder-title {
  margin: 0;
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.lgp-placeholder-hint {
  margin: 0;
  font-size: var(--lgp-text-sm);
}
.lgp-placeholder-pending {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}

.lgp-error-panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 24px;
  padding: 24px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  text-align: center;
}
.lgp-error-text {
  margin: 0;
  font-size: var(--lgp-text-base);
  color: var(--dsw-alias-state-error-primary);
}
.lgp-error-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lgp-panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.lgp-panel-icon img {
  display: block;
  object-fit: contain;
}

/* Page canvas, region overlay, article list and inspector (Task 18). */
.lgp-workspace {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 12px;
}
.lgp-canvas-shell {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-canvas-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-canvas-zoom {
  min-width: 88px;
  padding: 0 4px;
  text-align: center;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.lgp-canvas-zoom-button {
  min-width: 34px;
  padding: 2px 8px;
  font-size: 17px;
  line-height: 1;
}
.lgp-canvas-history-button {
  min-height: 30px;
  padding: 2px 10px;
}
.lgp-canvas-fit-button[aria-pressed='true'] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.lgp-canvas-toolbar-divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--dsw-alias-border-l1);
}
.lgp-canvas-viewport {
  flex: 1 1 auto;
  min-height: 240px;
  padding: 16px;
  overflow: auto;
  cursor: grab;
}
.lgp-canvas-viewport:active {
  cursor: grabbing;
}
.lgp-canvas-page {
  position: relative;
  margin: 0 auto;
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l1);
}
.lgp-canvas-image {
  display: block;
  width: 100%;
  height: 100%;
  user-select: none;
  -webkit-user-drag: none;
  /* Task 24: let the browser use its high-quality scaler (the page PNG is
     rendered at 240 DPI, so fit/zoom downscale instead of blurring). The
     "high-quality" keyword is CSS Images 4; unsupported runtimes keep "auto". */
  image-rendering: auto;
  image-rendering: high-quality;
}
.lgp-canvas-image-placeholder {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-region-overlay {
  position: absolute;
  inset: 0;
}
.lgp-canvas-status {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 4px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-save-status {
  font-variant-numeric: tabular-nums;
}
.lgp-save-status[data-lgp-save-status='saved'] {
  color: var(--dsw-alias-state-success-primary);
}
.lgp-save-status[data-lgp-save-status='error'] {
  color: var(--dsw-alias-state-error-primary);
}

/*
 * Task 24 region box: the bbox itself stays the exact page-coordinate box (drag
 * and resize math are unchanged), while a 5 px halo drawn by ::before extends
 * the visible frame outward. Text runs sit at the bbox edge, so without the halo
 * glyph pixels could appear outside the coloured frame; overflow: visible also
 * keeps labels/handles from being clipped.
 */
.lgp-region {
  position: absolute;
  box-sizing: border-box;
  overflow: visible;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: move;
}
.lgp-region::before {
  content: '';
  position: absolute;
  inset: -5px;
  border: 1.5px solid var(--lgp-region-color, var(--dsw-alias-border-l2));
  border-radius: 9px;
  background: color-mix(
    in srgb,
    var(--lgp-region-color, var(--dsw-alias-border-l2)) 12%,
    transparent
  );
  pointer-events: none;
  transition: border-color 150ms ease, background 150ms ease;
}
.lgp-region:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 4px;
}
.lgp-region[aria-pressed='true'] {
  z-index: 2;
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 4px;
}
/* Selected: a stronger halo and solid outline (never colour alone). */
.lgp-region--selected::before {
  border-width: 2.5px;
  background: color-mix(
    in srgb,
    var(--lgp-region-color, var(--dsw-alias-border-l2)) 20%,
    transparent
  );
}
/* Highlighted (selected articles / locate target): dashed halo, not just colour. */
.lgp-region--highlighted::before {
  border-style: dashed;
  border-width: 2.5px;
  box-shadow: 0 0 0 3px var(--dsw-alias-state-warn-primary);
}
.lgp-region--low-confidence::before {
  border-style: dashed;
}
.lgp-region--kind-masthead {
  --lgp-region-color: var(--dsw-alias-brand-primary);
}
.lgp-region--kind-header {
  --lgp-region-color: var(--dsw-alias-label-secondary);
}
.lgp-region--kind-footer {
  --lgp-region-color: var(--dsw-alias-label-tertiary);
}
.lgp-region--kind-lead {
  --lgp-region-color: var(--dsw-alias-state-error-primary);
}
.lgp-region--kind-second {
  --lgp-region-color: var(--dsw-alias-state-warn-primary);
}
.lgp-region--kind-third {
  --lgp-region-color: var(--dsw-alias-brand-primary);
}
.lgp-region--kind-article {
  --lgp-region-color: var(--dsw-alias-label-secondary);
}
.lgp-region--kind-image {
  --lgp-region-color: var(--dsw-alias-state-success-primary);
}
.lgp-region--kind-caption {
  --lgp-region-color: var(--dsw-alias-label-tertiary);
}
.lgp-region--kind-ad {
  --lgp-region-color: var(--dsw-alias-label-tertiary);
}
.lgp-region--kind-index {
  --lgp-region-color: var(--dsw-alias-brand-primary);
}
.lgp-region--kind-other {
  --lgp-region-color: var(--dsw-alias-label-secondary);
}
.lgp-region-label {
  position: absolute;
  top: -2px;
  left: 0;
  max-width: 100%;
  padding: 1px 6px;
  overflow: hidden;
  border: 1px solid var(--lgp-region-color, var(--dsw-alias-border-l2));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: var(--lgp-text-label);
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lgp-region-warning {
  position: absolute;
  top: -6px;
  right: 0;
  width: 18px;
  height: 18px;
  text-align: center;
  border-radius: 6px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary-inverted);
  font-size: var(--lgp-text-label);
  font-weight: 700;
  line-height: 18px;
}
.lgp-region--unassigned::before {
  border-style: dotted;
}
.lgp-region-unassigned {
  position: absolute;
  right: 20px;
  bottom: 0;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary-inverted);
  font-size: var(--lgp-text-label);
  line-height: 16px;
  white-space: nowrap;
}
.lgp-region-handle {
  position: absolute;
  width: 11px;
  height: 11px;
  border: 2px solid var(--dsw-alias-brand-primary);
  border-radius: 3px;
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-region-handle--nw {
  top: -6px;
  left: -6px;
  cursor: nwse-resize;
}
.lgp-region-handle--ne {
  top: -6px;
  right: -6px;
  cursor: nesw-resize;
}
.lgp-region-handle--sw {
  bottom: -6px;
  left: -6px;
  cursor: nesw-resize;
}
.lgp-region-handle--se {
  right: -6px;
  bottom: -6px;
  cursor: nwse-resize;
}

/* Article list (explicit selection only). */
.lgp-aside-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.lgp-article-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-article-list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.lgp-article-list-title {
  margin: 0;
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.lgp-article-list-count {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-article-list-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.lgp-article-warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--lgp-text-label);
}
.lgp-article-warnings-list {
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.lgp-article-empty-flag {
  padding: 1px 6px;
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 6px;
  color: var(--dsw-alias-state-warn-primary);
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-article-empty {
  margin: 0;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-article-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: auto;
}
.lgp-article-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
}
.lgp-article-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.lgp-article-item--selected {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-active);
}
.lgp-article-check {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.lgp-article-checkbox {
  flex: 0 0 auto;
  accent-color: var(--dsw-alias-brand-primary);
}
.lgp-article-role {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-article-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lgp-article-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 22px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-article-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.lgp-article-edit {
  min-height: 28px;
  padding: 2px 10px;
  font-size: var(--lgp-text-label);
}
.lgp-article-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-article-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.lgp-article-field-label {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-article-fulltext {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.lgp-article-fulltext-body {
  box-sizing: border-box;
  width: 100%;
  max-height: 260px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-sm);
  line-height: var(--lgp-line-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.lgp-article-input,
.lgp-article-textarea {
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-control);
}
.lgp-article-textarea {
  resize: vertical;
  line-height: var(--lgp-line-body);
}
.lgp-article-input:focus-visible,
.lgp-article-textarea:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-article-warning {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary-inverted);
  font-size: var(--lgp-text-label);
  font-weight: 700;
  line-height: 1;
}

/* Region inspector (numeric/keyboard alternative to drag). */
.lgp-inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lgp-inspector-title {
  margin: 0;
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.lgp-inspector-meta {
  margin-right: auto;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-inspector-close {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 4px 10px;
  font-size: var(--lgp-text-label);
}
.lgp-inspector-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.lgp-inspector-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.lgp-inspector-label {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-inspector-number,
.lgp-inspector-select {
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-control);
}
.lgp-inspector-number:focus-visible,
.lgp-inspector-select:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-inspector-confidence {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-inspector-warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 8px 10px 8px 22px;
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--lgp-text-label);
}
.lgp-inspector-warning {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary-inverted);
  font-size: var(--lgp-text-label);
  font-weight: 700;
  line-height: 1;
}
.lgp-inspector-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lgp-inspector-split {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 10px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.lgp-inspector-split-legend {
  padding: 0 4px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}

/* Proofreading panel, job progress and report (Task 19; design §9.2/§9.3/§9.4). */
.lgp-proof-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-proof-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.lgp-proof-title {
  margin: 0;
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.lgp-proof-selected {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-proof-notice {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-secondary);
}
.lgp-proof-error {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 6px;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-state-error-primary);
}
.lgp-proof-error-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lgp-proof-fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}
.lgp-proof-legend {
  padding: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-proof-depths {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.lgp-proof-depth {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.lgp-proof-depth input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-proof-hint {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-proof-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-control);
  cursor: pointer;
}
.lgp-proof-check[aria-checked='true'] {
  border-color: var(--dsw-alias-brand-primary);
}
.lgp-proof-check:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-proof-check:disabled {
  cursor: default;
  opacity: 0.7;
}
.lgp-proof-check-mark {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-brand-primary);
}
.lgp-proof-warning {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 6px;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-secondary);
}
.lgp-proof-failed-roles {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary);
}
.lgp-proof-failed-roles-title {
  font-weight: 600;
  color: var(--dsw-alias-state-error-primary);
}
.lgp-proof-failed-role {
  display: block;
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.lgp-proof-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.lgp-proof-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-proof-confirm-text {
  margin: 0;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-primary);
}

.lgp-job {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-job-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.lgp-job-title {
  margin: 0;
  font-size: var(--lgp-text-base);
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.lgp-job-status {
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-brand-primary);
}
.lgp-job-bar {
  width: 100%;
  height: 8px;
  accent-color: var(--dsw-alias-brand-primary);
}
.lgp-job-summary {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-job-error {
  margin: 0;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-state-error-primary);
}
.lgp-job-stages {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 200px;
  overflow: auto;
}
.lgp-job-stage {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-secondary);
}
.lgp-job-stage-status {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-job-stage-status--running {
  color: var(--dsw-alias-brand-primary);
}
.lgp-job-stage-status--done {
  color: var(--dsw-alias-state-success-primary);
}
.lgp-job-stage-status--failed {
  color: var(--dsw-alias-state-error-primary);
}
.lgp-job-stage-error {
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

/*
 * Live exhaustive fact-check plan (Task 29): a compact, token-coloured summary
 * plus a capped claim list. The max-height keeps the plan from pushing the
 * depth/fact-check/start controls out of the proofread panel while the facts
 * role runs; the list itself scrolls instead.
 */
.lgp-fact-plan {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.lgp-fact-plan-title {
  margin: 0;
  font-size: var(--lgp-text-sm);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.lgp-fact-plan-summary {
  margin: 0;
  font-size: var(--lgp-text-label);
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.lgp-fact-plan-meta {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-fact-plan-empty {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-fact-plan-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.lgp-fact-plan-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  padding: 3px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-primary);
}
.lgp-fact-plan-item:last-child {
  border-bottom: 0;
}
.lgp-fact-plan-priority,
.lgp-fact-plan-kind,
.lgp-fact-plan-status {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-fact-plan-priority {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-fact-plan-kind {
  color: var(--dsw-alias-label-secondary);
}
.lgp-fact-plan-claim {
  flex: 1 1 140px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.lgp-fact-plan-status {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
}
.lgp-fact-plan-status--searching,
.lgp-fact-plan-status--verifying {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.lgp-fact-plan-status--searched,
.lgp-fact-plan-status--not_checked {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.lgp-fact-plan-status--checked {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

/*
 * Live noun-check plan (v1.0.0): the independent nouns role streams its own
 * plan next to the fact-check plan. Same compact pattern (summary + capped
 * scroll list) with a dashed divider so two plans in one job stay visually
 * distinct; the shorter cap keeps both lists from pushing the controls away.
 */
.lgp-noun-plan {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
}
.lgp-noun-plan-title {
  margin: 0;
  font-size: var(--lgp-text-sm);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.lgp-noun-plan-summary {
  margin: 0;
  font-size: var(--lgp-text-label);
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.lgp-noun-plan-meta {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-noun-plan-empty {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-noun-plan-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.lgp-noun-plan-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  padding: 3px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-primary);
}
.lgp-noun-plan-item:last-child {
  border-bottom: 0;
}
.lgp-noun-plan-priority,
.lgp-noun-plan-kind,
.lgp-noun-plan-status,
.lgp-noun-plan-result {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-noun-plan-priority {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-noun-plan-kind {
  color: var(--dsw-alias-label-secondary);
}
.lgp-noun-plan-name {
  flex: 1 1 120px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.lgp-noun-plan-quote {
  flex: 1 1 160px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.lgp-noun-plan-status {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
}
.lgp-noun-plan-status--searching,
.lgp-noun-plan-status--verifying {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.lgp-noun-plan-status--searched,
.lgp-noun-plan-status--not_checked {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.lgp-noun-plan-status--checked {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.lgp-noun-plan-result {
  border-style: dashed;
  color: var(--dsw-alias-label-secondary);
}
.lgp-noun-plan-result--exists {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.lgp-noun-plan-result--uncertain,
.lgp-noun-plan-result--not_found {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.lgp-noun-plan-result--not_checked {
  color: var(--dsw-alias-label-tertiary);
}

.lgp-report {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.lgp-report-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lgp-report-title {
  margin: 0;
  font-size: var(--lgp-text-title);
  font-weight: 600;
  line-height: 1.3;
  color: var(--dsw-alias-label-primary);
}
.lgp-offline-badge {
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 999px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-state-warn-primary);
  white-space: nowrap;
}
.lgp-report-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-summary-counts {
  display: flex;
  align-items: center;
  gap: 18px;
  margin: 0;
  padding: 0;
  list-style: none;
  flex-wrap: wrap;
}
.lgp-summary-count {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.lgp-summary-value {
  font-size: var(--lgp-text-stat);
  font-weight: 600;
  line-height: 1.2;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.lgp-summary-label {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-summary-categories {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  flex-wrap: wrap;
}
.lgp-summary-category {
  padding: 1px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-size: var(--lgp-text-label);
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.lgp-report-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px;
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-report-time time {
  font-variant-numeric: tabular-nums;
}
.lgp-report-must-fix {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
}
.lgp-must-fix-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 20px;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-primary);
}
.lgp-must-fix-items strong {
  color: var(--dsw-alias-state-error-primary);
  font-weight: 600;
}
.lgp-report-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lgp-report-section-title {
  margin: 0;
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.lgp-report-empty {
  margin: 0;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-tertiary);
}
/* Failed-role warning (Task 21f): a partial report must never look complete. */
.lgp-failed-roles {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-left-width: 3px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-failed-roles-title {
  margin: 0;
  font-size: var(--lgp-text-heading);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-state-error-primary);
}
.lgp-failed-roles-detail {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-secondary);
}
.lgp-failed-roles-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding-left: 20px;
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-primary);
}
.lgp-failed-role {
  overflow-wrap: anywhere;
}
.lgp-failed-role-article {
  color: var(--dsw-alias-label-primary);
}
.lgp-failed-role-name {
  color: var(--dsw-alias-state-error-primary);
}
.lgp-failed-role-error {
  margin-left: 4px;
  color: var(--dsw-alias-label-secondary);
}
.lgp-report-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lgp-report-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lgp-report-export {
  text-decoration: none;
}
.lgp-report-toolbar-status {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-state-success-primary);
}
.lgp-report-filters {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.lgp-report-filter {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.lgp-report-filter-label {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-report-select {
  max-width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-control);
}
.lgp-report-select:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-report-count {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-report-article {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lgp-report-article-title {
  margin: 0;
  font-size: var(--lgp-text-base);
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.lgp-report-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lgp-finding {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-left-width: 3px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-finding--must_fix {
  border-left-color: var(--dsw-alias-state-error-primary);
}
.lgp-finding--suggested {
  border-left-color: var(--dsw-alias-state-warn-primary);
}
.lgp-finding--optional {
  border-left-color: var(--dsw-alias-border-l2);
}
.lgp-finding-head {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.lgp-severity,
.lgp-category,
.lgp-finding-status,
.lgp-verdict,
.lgp-needs-human {
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-severity--must_fix,
.lgp-verdict--contradicted {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.lgp-severity--suggested,
.lgp-verdict--insufficient,
.lgp-verdict--unverified {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.lgp-verdict--confirmed {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.lgp-verdict--not_checked {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-finding-status {
  color: var(--dsw-alias-label-tertiary);
}
.lgp-needs-human {
  border-style: dashed;
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
  margin-left: 2px;
}
.lgp-finding-quote {
  margin: 0;
  padding: 6px 10px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  font-size: var(--lgp-text-base);
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.lgp-finding-occurrence,
.lgp-fact-occurrence {
  display: block;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-finding-issue,
.lgp-finding-basis,
.lgp-finding-suggestion-line {
  margin: 0;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.lgp-finding-basis {
  font-size: var(--lgp-text-sm);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-finding-suggestion-label {
  margin-right: 5px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-finding-suggestion {
  color: var(--dsw-alias-brand-primary);
}
.lgp-finding-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.lgp-finding-sources {
  display: flex;
  align-items: baseline;
  gap: 5px;
  flex-wrap: wrap;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-source-link {
  color: var(--dsw-alias-brand-primary);
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.lgp-source-link:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-finding-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.lgp-finding-action {
  min-height: 28px;
  padding: 2px 8px;
  font-size: var(--lgp-text-label);
  line-height: 18px;
}

/* Report UX completion: tabs, drawer, batch accept, locate (Task 19b). */
.lgp-aside-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.lgp-aside-tab {
  flex: 1 1 auto;
  min-height: 32px;
  padding: 3px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: var(--lgp-text-control);
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms ease, color 150ms ease;
}
.lgp-aside-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.lgp-aside-tab[aria-selected='true'] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.lgp-aside-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-aside-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.lgp-aside-close:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-aside-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.lgp-aside-panel[hidden] {
  display: none;
}
.lgp-drawer-bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 0;
}
.lgp-aside-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-drawer-backdrop {
  display: none;
}

/* The drawer toggle/close affordances belong to the narrow layout only. */
@media (min-width: 1200px) {
  .lgp-drawer-bar,
  .lgp-aside-close {
    display: none;
  }
}

.lgp-report-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.lgp-report-batch-count {
  min-width: 72px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-report-filter--keyword {
  flex: 1 1 140px;
  min-width: 120px;
}
.lgp-report-input {
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-control);
}
.lgp-report-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-report-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.lgp-finding-select {
  flex: 0 0 auto;
  accent-color: var(--dsw-alias-brand-primary);
}
.lgp-finding-select:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-confidence {
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-locate-status {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 10px;
  border: 1px dashed var(--dsw-alias-state-warn-primary);
  border-radius: 6px;
  color: var(--dsw-alias-label-primary);
  font-size: var(--lgp-text-sm);
}
.lgp-workspace[data-lgp-locate-active='true'] .lgp-region--highlighted {
  outline: 2px dashed var(--dsw-alias-state-warn-primary);
  outline-offset: 2px;
  animation: lgp-locate-pulse 900ms ease-in-out 2;
}
@keyframes lgp-locate-pulse {
  from {
    outline-color: var(--dsw-alias-state-warn-primary);
  }
  50% {
    outline-color: var(--dsw-alias-brand-primary);
  }
  to {
    outline-color: var(--dsw-alias-state-warn-primary);
  }
}

.lgp-facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.lgp-facts-offline {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 6px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-secondary);
}
.lgp-facts-scroll {
  overflow-x: auto;
}
.lgp-facts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--lgp-text-label);
}
.lgp-facts-table th,
.lgp-facts-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: top;
  text-align: left;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.lgp-facts-table th {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 600;
  white-space: nowrap;
}
.lgp-fact-claim {
  color: var(--dsw-alias-label-primary);
}
/* Task 29: subtle priority badge inside the claim cell (no new column). */
.lgp-fact-priority {
  display: inline-block;
  margin-right: 5px;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--lgp-text-label);
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.lgp-fact-quote {
  min-width: 96px;
}
.lgp-fact-kind {
  white-space: nowrap;
}
.lgp-fact-evidence,
.lgp-fact-sources {
  display: block;
}
.lgp-fact-sources {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary);
}

/*
 * Network noun-check report section (v1.0.0): same table pattern as the fact
 * checklist, with existence-only status colours and a capped horizontally
 * scrollable table. The not_found status uses the warning colour on purpose —
 * it means “not in the retrieved sources”, never a confirmed non-existence.
 */
.lgp-nouns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.lgp-noun-counts {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.lgp-noun-disclaimer {
  margin: 0;
  padding: 6px 10px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 6px;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-nouns-scroll {
  overflow-x: auto;
}
.lgp-nouns-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--lgp-text-label);
}
.lgp-nouns-table th,
.lgp-nouns-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: top;
  text-align: left;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.lgp-nouns-table th {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 600;
  white-space: nowrap;
}
.lgp-noun-name {
  color: var(--dsw-alias-label-primary);
}
.lgp-noun-priority {
  display: inline-block;
  margin-right: 5px;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--lgp-text-label);
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.lgp-noun-kind {
  white-space: nowrap;
}
.lgp-noun-quote {
  min-width: 96px;
}
.lgp-noun-evidence,
.lgp-noun-sources {
  display: block;
}
.lgp-noun-sources {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary);
}
.lgp-noun-basis-empty {
  color: var(--dsw-alias-label-tertiary);
}
.lgp-noun-status {
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  font-size: var(--lgp-text-label);
  line-height: 18px;
  white-space: nowrap;
}
.lgp-noun-status--exists {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.lgp-noun-status--uncertain,
.lgp-noun-status--not_found {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.lgp-noun-status--not_checked {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
}

/*
 * Task 24 settings overlay: the workbench stays visible underneath (dimmed and
 * slightly blurred) instead of being replaced by an opaque page. Clicking the
 * backdrop closes the drawer (handled in App); the drawer panel itself keeps
 * the click.
 */
.lgp-settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.lgp-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(400px, 100%);
  height: 100%;
  padding: 16px 20px;
  overflow: auto;
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l1);
}
.lgp-settings-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.lgp-settings-back {
  min-height: 36px;
  padding: 6px 14px;
  border-color: var(--dsw-alias-border-l2);
  font-size: var(--lgp-text-control);
  font-weight: 600;
}
.lgp-settings-back:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.lgp-settings-title {
  margin: 0;
  text-align: center;
  font-size: var(--lgp-text-title);
  font-weight: 600;
  line-height: 1.25;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lgp-settings-close {
  min-height: 36px;
  padding: 6px 10px;
  font-size: var(--lgp-text-control);
}
.lgp-settings-close:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.lgp-settings-close-label {
  margin-left: 2px;
}
.lgp-settings-loading {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-secondary);
}
.lgp-settings-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lgp-settings-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.lgp-settings-label {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-settings-number {
  width: 100%;
  min-height: 34px;
  padding: 5px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--lgp-text-control);
}
.lgp-settings-number:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.lgp-settings-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--lgp-text-control);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.lgp-settings-note {
  margin: 0;
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-label-tertiary);
}
.lgp-settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lgp-settings-status {
  font-size: var(--lgp-text-label);
  color: var(--dsw-alias-state-success-primary);
}

@keyframes lgp-report-highlight {
  from {
    background: var(--dsw-alias-interactive-bg-active);
  }
  to {
    background: var(--dsw-alias-bg-layer-2);
  }
}
.lgp-finding--must_fix {
  animation: lgp-report-highlight 150ms ease;
}

@media (max-width: 1199px) {
  .lgp-body {
    flex-direction: column;
    position: relative;
  }
  .lgp-rail {
    width: auto;
    flex: 0 0 auto;
    flex-direction: row;
    align-items: center;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
  }
  .lgp-rail-list {
    flex-direction: row;
  }
  .lgp-rail-item {
    width: auto;
  }
  /* The right column becomes an overlay drawer instead of stacking under the
     canvas; it keeps the same tabbed content and closes on Escape/backdrop. */
  .lgp-aside {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 6;
    width: min(400px, 100%);
    flex: 0 0 auto;
    border-top: 0;
    border-left: 1px solid var(--dsw-alias-border-l1);
    box-shadow: 0 0 0 1px var(--dsw-alias-border-l1);
    transform: translateX(100%);
    visibility: hidden;
    transition: transform 180ms ease, visibility 180ms ease;
  }
  .lgp-aside[data-lgp-drawer-open='true'] {
    transform: translateX(0);
    visibility: visible;
  }
  .lgp-drawer-bar {
    display: flex;
  }
  .lgp-aside-close {
    display: inline-flex;
  }
  .lgp-drawer-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 5;
    background: color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lgp-button,
  .lgp-dropzone,
  .lgp-region,
  .lgp-finding--must_fix,
  .lgp-aside,
  .lgp-aside-tab {
    transition: none;
    animation: none;
  }
  .lgp-workspace[data-lgp-locate-active='true'] .lgp-region--highlighted {
    animation: none;
  }
}
`

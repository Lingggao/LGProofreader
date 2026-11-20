/**
 * Brand asset URLs (Task 17; design §1.4).
 *
 * `assets/brand/` holds the derived brand images; the source artwork
 * (`LING_2_Graffiti.png`) is not shipped. The build (Task 20) bundles every
 * `.png` imported here as a data URL (`esbuild` `loader: { '.png': 'dataurl' }`),
 * so the client artifact stays a single file with no external asset requests.
 *
 * Tests mock this module (see `tests/client/ui-shell.test.tsx`) so Vitest never
 * has to resolve the binary imports.
 */
import sidebarIconUrl from '../../assets/brand/sidebar-icon.png'
import wordmarkDarkUrl from '../../assets/brand/wordmark-dark.png'
import wordmarkLightUrl from '../../assets/brand/wordmark-light.png'

/** Compact "LG" monogram badge used by the sidebar panellist icon. */
export const sidebarIcon: string = sidebarIconUrl

/** Full wordmark for light themes (panel header / empty state). */
export const wordmarkLight: string = wordmarkLightUrl

/** Full wordmark for dark themes (panel header / empty state). */
export const wordmarkDark: string = wordmarkDarkUrl

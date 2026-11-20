/**
 * Client asset module declarations (Task 16).
 *
 * Brand images are imported as URLs from `src/client/assets.ts` and inlined as
 * data URLs by the build (`scripts/build.mjs`, esbuild `loader: { ".png":
 * "dataurl" }`); TypeScript only needs to know the import resolves to a string.
 */
declare module '*.png' {
  /** Data URL (production build) or asset URL (dev server) of the image. */
  const source: string
  export default source
}

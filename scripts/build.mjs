#!/usr/bin/env node
/**
 * Prebuilt-artifact build for the Ling Gao 校对员 (Ling Gao Proofreader) plugin
 * (Task 20; design §5, §8.1, §12.2).
 *
 * `pnpm build` produces exactly two committed, runtime-ready files:
 *
 * 1. `lib/index.js` — the Host half. One ESM bundle (`format: esm`,
 *    `platform: node`, `target: node24`) of `src/host/index.ts` with only
 *    `@deepseek-ai/*` external (none are imported today). ESM is required by the
 *    package (`"type": "module"`) and by the installed-package prompt lookup,
 *    which walks up from `import.meta.url` (`src/host/config.ts`), so the bundle
 *    must keep `import.meta.url` intact — this script fails if esbuild dropped it.
 *    Prompt files are **not** bundled: the Host reads `<packageRoot>/prompts/zh`
 *    at runtime, so a release only has to ship the `prompts/` directory.
 *
 * 2. `lib/client.js` — the Web half, in the DSH `__ModuleLoader__` format. A
 *    single-file CJS body (`format: cjs`, `platform: browser`, `target:
 *    chrome152`, `jsx: automatic`) is wrapped in
 *    `window.__ModuleLoader__.load({ id: <package name>, factory(require) { … } })`,
 *    where `react`, `react/jsx-runtime`, `react-dom` and `react-dom/client` are
 *    provided by the DSH browser runtime (externals). Brand PNGs become data
 *    URLs (`loader: { ".png": "dataurl" }`) and the PDF.js worker script is
 *    inlined through `define: { __PDF_WORKER_SOURCE__: <source string> }`, so the
 *    artifact loads without any extra asset request. Prompt text and Host code
 *    are rejected in the browser body.
 *
 * Safety checks run inside this script (so a bad build fails immediately):
 * `node --check` on both outputs, the ModuleLoader header/factory return, the
 * preserved `import.meta.url`, prompt-dir resolvability from the package root,
 * and the absence of prompt text / absolute build-machine paths.
 *
 * Node.js built-ins and the `esbuild` devDependency only; not shipped.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** Repository/package root (this file lives in `<root>/scripts/`). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Emitted artifact directory (committed; `files` in package.json ships it). */
export const LIB_DIR = join(REPO_ROOT, 'lib')

const HOST_ENTRY = join(REPO_ROOT, 'src', 'host', 'index.ts')
const CLIENT_ENTRY = join(REPO_ROOT, 'src', 'client', 'index.tsx')
const PACKAGE_MANIFEST = join(REPO_ROOT, 'package.json')

/** PDF.js worker source inlined into the Client bundle (design §12.2). */
const PDF_WORKER_SOURCE = join(
  REPO_ROOT,
  'node_modules',
  'pdfjs-dist',
  'build',
  'pdf.worker.min.mjs',
)

/** URL fragment the Host bundle must preserve for its prompt lookup. */
const HOST_IMPORT_META_URL = 'import.meta.url'

/** Browser modules supplied by the DSH runtime, never bundled (design §12.2). */
export const CLIENT_EXTERNALS = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
])

/** Host modules supplied by the DSH runtime, never bundled (design §12.2). */
export const HOST_EXTERNALS = Object.freeze(['@deepseek-ai/*'])

/** Recursively list files below `dir` as sorted POSIX paths relative to it. */
async function listFilesRecursive(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(join(dir, entry.name), relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

/**
 * Every shipped prompt (`prompts/zh/**`) is a leak needle.
 *
 * `full` holds the complete file content; `lines` holds every substantive
 * non-empty line (short JSON punctuation-only lines are skipped). The build
 * rejects any built artifact that contains prompt text, so a prompt accidentally
 * imported into the Client (or copied into the Host instead of read at runtime)
 * fails immediately instead of shipping.
 */
async function collectPromptNeedles(root) {
  const promptRoot = join(root, 'prompts', 'zh')
  const full = []
  const lines = []
  const seenFull = new Set()
  const seenLines = new Set()

  for (const relative of await listFilesRecursive(promptRoot)) {
    const text = await readFile(join(promptRoot, ...relative.split('/')), 'utf8')
    if (text.trim().length > 0 && !seenFull.has(text)) {
      seenFull.add(text)
      full.push({ needle: text, reason: `full content of prompts/zh/${relative}` })
    }
    // Line-level needles only for prose prompts: a JSON schema's enum lines
    // (e.g. `"title",`) legitimately repeat strings the UI also uses, while its
    // complete content is already checked above.
    if (!relative.endsWith('.md')) continue
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      // Skip empty/structural lines that are too generic to be a leak signal.
      if (trimmed.length < 8 || /^[{}[\],;:]+$/u.test(trimmed) || seenLines.has(trimmed)) continue
      seenLines.add(trimmed)
      lines.push({ needle: trimmed, reason: `line from prompts/zh/${relative}` })
    }
  }

  return { full, lines }
}

/** Text that must never appear in the browser artifact (prompt / Host internals). */
function forbiddenClientText(promptNeedles) {
  return [
    { needle: 'prompts/zh', reason: 'prompt directory reference' },
    { needle: 'plugin-data', reason: 'Host plugin-data directory reference' },
    { needle: 'node:fs', reason: 'Node.js fs import' },
    { needle: 'node:crypto', reason: 'Node.js crypto import' },
    { needle: "from './services/store'", reason: 'Host store import' },
    ...promptNeedles.lines,
    ...promptNeedles.full,
  ].filter(({ needle }) => needle.length > 0)
}

/** Text that must never appear in the Host artifact (prompt text is runtime-read). */
function forbiddenHostText(promptNeedles) {
  return [
    { needle: 'window.__ModuleLoader__', reason: 'browser ModuleLoader wrapper' },
    ...promptNeedles.full,
  ].filter(({ needle }) => needle.length > 0)
}

/**
 * Wrap one esbuild CJS body in the DSH ModuleLoader factory.
 *
 * The launcher requires a lazy, side-effect-free factory whose id is the npm
 * package name; the factory returns the `module.exports` object produced by the
 * bundle. `require` is the launcher-provided browser module table (React).
 *
 * `'use strict';` is the first statement of the factory, so the whole factory
 * body (including the wrappers around the minified CJS body) runs in strict mode;
 * the CJS body's own leading `"use strict";` would otherwise be preceded by the
 * `const module` declaration and stop being a directive.
 *
 * @param {string} cjsBody Generated CJS text.
 * @param {string} packageName npm package name (`lg-proofreader`).
 * @returns {string} The loadable client artifact.
 */
export function wrapClientBundle(cjsBody, packageName) {
  if (typeof cjsBody !== 'string' || cjsBody.trim() === '') {
    throw new Error('wrapClientBundle() requires a non-empty CJS body')
  }
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    throw new Error('wrapClientBundle() requires the package name')
  }
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)},`,
    '  factory(require) {',
    "    'use strict';",
    '    const module = { exports: {} };',
    '',
    cjsBody.trim(),
    '',
    '    return module.exports;',
    '  },',
    '});',
    '',
  ].join('\n')
}

/** `node --check` one artifact; a syntax error aborts the build. */
function checkJavaScript(filePath) {
  execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' })
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${filePath}: ${error instanceof Error ? error.message : error}`)
  }
}

/** Build the Host ESM artifact (`lib/index.js`). */
async function buildHost(versionBanner) {
  const result = await build({
    entryPoints: [HOST_ENTRY],
    outfile: join(LIB_DIR, 'index.js'),
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    external: [...HOST_EXTERNALS],
    define: { __PLUGIN_VERSION_BANNER__: JSON.stringify(versionBanner) },
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    metafile: false,
  })
  const output = result.outputFiles?.[0]
  if (output === undefined) throw new Error('esbuild produced no Host output')
  return output.text
}

/** Build the wrapped Client artifact (`lib/client.js`). */
async function buildClient(packageName, workerSource, versionBanner) {
  const result = await build({
    entryPoints: [CLIENT_ENTRY],
    outfile: join(LIB_DIR, 'client.js'),
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome152',
    jsx: 'automatic',
    loader: { '.png': 'dataurl' },
    external: [...CLIENT_EXTERNALS],
    define: {
      __PDF_WORKER_SOURCE__: JSON.stringify(workerSource),
      __PLUGIN_VERSION_BANNER__: JSON.stringify(versionBanner),
    },
    charset: 'utf8',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: false,
  })
  const output = result.outputFiles?.[0]
  if (output === undefined) throw new Error('esbuild produced no Client output')
  return wrapClientBundle(output.text, packageName)
}

/** Reject a built artifact that contradicts the release contract. */
function verifyArtifacts({ host, client, packageName, promptNeedles, versionBanner }) {
  const errors = []

  if (!host.includes(HOST_IMPORT_META_URL)) {
    errors.push(
      'lib/index.js lost import.meta.url: prompts could no longer be resolved from the installed package',
    )
  }
  if (!client.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}`)) {
    errors.push(`lib/client.js does not start with the ModuleLoader factory for ${packageName}`)
  }
  // Strict mode must actually be in effect: `'use strict';` has to be the first
  // statement of the factory, before the `const module` shim.
  const factoryStart = client.indexOf('  factory(require) {\n')
  const strictAt = client.indexOf("    'use strict';\n", factoryStart)
  const moduleAt = client.indexOf('    const module =', factoryStart)
  if (factoryStart < 0 || strictAt !== factoryStart + '  factory(require) {\n'.length) {
    errors.push("lib/client.js factory must start with the 'use strict'; directive")
  }
  if (moduleAt < 0 || strictAt < 0 || moduleAt < strictAt) {
    errors.push('lib/client.js factory declares the module shim before strict mode')
  }
  if (!client.includes('return module.exports')) {
    errors.push('lib/client.js factory does not return module.exports')
  }
  // The compiled fallback must name the manifest version as one literal, so a
  // stale bundle cannot pass as current.
  for (const [name, text] of [
    ['lib/index.js', host],
    ['lib/client.js', client],
  ]) {
    if (!text.includes(versionBanner)) {
      errors.push(`${name} is missing the compiled report version banner ${JSON.stringify(versionBanner)}`)
    }
  }
  // The client artifact must be valid as a classic script (the worker source
  // string legitimately contains the text "import.meta.url").
  try {
    new Function(client)
  } catch (error) {
    errors.push(
      `lib/client.js is not a valid classic script: ${error instanceof Error ? error.message : error}`,
    )
  }

  for (const artifact of [
    { name: 'lib/client.js', text: client, forbidden: forbiddenClientText(promptNeedles) },
    { name: 'lib/index.js', text: host, forbidden: forbiddenHostText(promptNeedles) },
  ]) {
    for (const { needle, reason } of artifact.forbidden) {
      if (artifact.text.includes(needle)) {
        errors.push(`${artifact.name} contains ${reason}: ${JSON.stringify(needle.slice(0, 40))}`)
      }
    }
    // Absolute build-machine paths would break the installed package.
    if (/[A-Za-z]:[\\/](?:Users|Program Files)[\\/]/u.test(artifact.text)) {
      errors.push(`${artifact.name} contains an absolute build-machine path`)
    }
  }

  if (errors.length > 0) throw new Error(`build verification failed:\n- ${errors.join('\n- ')}`)
}

/** Reject an artifact whose `require(...)` calls are not in the external table. */
function verifyClientExternals(client, packageName) {
  const required = new Map([
    ['react', 'react'],
    ['react/jsx-runtime', 'react/jsx-runtime'],
  ])
  const errors = []
  for (const [specifier, label] of required) {
    if (!client.includes(`require(${JSON.stringify(specifier)})`)) {
      errors.push(`lib/client.js does not require the runtime-provided ${label} module`)
    }
  }
  // No bare require of a bundled npm package may remain: it would throw in the
  // browser because the ModuleLoader only resolves declared externals.
  for (const match of client.matchAll(/require\("([^"]+)"\)/gu)) {
    const specifier = match[1]
    if (specifier.startsWith('node:') || (!CLIENT_EXTERNALS.includes(specifier) && specifier !== '.')) {
      errors.push(`lib/client.js requires undeclared module ${JSON.stringify(specifier)}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(`client external verification failed for ${packageName}:\n- ${errors.join('\n- ')}`)
  }
}

async function main() {
  const manifest = await readJson(PACKAGE_MANIFEST)
  const packageName = typeof manifest.name === 'string' ? manifest.name : ''
  if (packageName === '' || typeof manifest.version !== 'string') {
    throw new Error('package.json must declare a name and version before building')
  }

  const workerSource = await readFile(PDF_WORKER_SOURCE, 'utf8')
  const promptNeedles = await collectPromptNeedles(REPO_ROOT)
  const versionBanner = `Ling Gao Proofreader v${manifest.version}`

  await rm(LIB_DIR, { recursive: true, force: true })
  await mkdir(LIB_DIR, { recursive: true })

  const host = await buildHost(versionBanner)
  await writeFile(join(LIB_DIR, 'index.js'), host, 'utf8')
  const client = await buildClient(packageName, workerSource, versionBanner)
  await writeFile(join(LIB_DIR, 'client.js'), client, 'utf8')

  checkJavaScript(join(LIB_DIR, 'index.js'))
  checkJavaScript(join(LIB_DIR, 'client.js'))
  verifyArtifacts({ host, client, packageName, promptNeedles, versionBanner })
  verifyClientExternals(client, packageName)

  // Prompt-dir smoke check: a release ships `prompts/` beside `lib/`, so the Host
  // resolver (walk up from lib/index.js to the package root, then prompts/<locale>)
  // must find the same prompt files in this checkout.
  const promptDir = join(REPO_ROOT, 'prompts', 'zh')
  await access(join(promptDir, 'base.md'))
  await access(join(promptDir, 'contracts', 'findings.schema.json'))

  for (const [file, text] of [
    ['lib/index.js', host],
    ['lib/client.js', client],
  ]) {
    console.log(
      `build: ${file} ${formatBytes(Buffer.byteLength(text, 'utf8'))} sha256 ${sha256(text).slice(0, 16)}`,
    )
  }
  console.log(`build: prompts resolve from ${promptDir} (import.meta.url preserved)`)
  console.log('build: ok')
}

// Run only when executed as a script (the helpers stay importable by tooling).
if (isExecutedAsScript()) await main()

/** True when Node was asked to run this file directly, not to import it. */
function isExecutedAsScript() {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  return pathToFileURL(resolve(entry)).href === import.meta.url
}

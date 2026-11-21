#!/usr/bin/env node
/**
 * Release validation for the Ling Gao 校对员 (Ling Gao Proofreader) plugin
 * (Task 20; design §12.2/§12.3, plugin-details/Host-plugin checklist).
 *
 * `pnpm validate` is the last gate before packaging. It checks the package
 * manifest and exports, the localized plugin-manager metadata and its one-image
 * detail documents, the icon, the two built artifacts (syntax, DSH
 * ModuleLoader wrapper, preserved `import.meta.url`, no prompt/Host leakage),
 * the shipped prompt library (files + JSON schemas), the single-sourced report
 * version, and finally runs a staged-apply smoke test that proves
 * `lib/index.js` resolves `prompts/zh` from an *installed package layout* — the
 * exact failure mode a bundled `import.meta.url` regression would cause.
 *
 * Exit code 0 with a final `ok` line, or 1 with one `validate: ERROR …` line per
 * problem. Read-only: the only writes happen inside an OS temp directory that is
 * removed again.
 *
 * Node.js built-ins only; not shipped.
 */
import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository/package root (this file lives in `<root>/scripts/`). */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Package name (global constraint). */
const PACKAGE_NAME = 'lg-proofreader'

/** Cordis Loader row id inserted by `cordis.patch.yml` (design §12.1). */
const CORDIS_ROW_ID = 'lg-proofreader'

/** Host API prefix (global constraint). */
const API_PREFIX = '/api/lgproofreader'

/** DSH runtime range validated in this release (global constraint). */
const DSH_RANGE = '>=0.2.2-rc.5 <0.3.0'

/** Maximum plugin icon size accepted by Plugin Manager (global constraint). */
const MAX_ICON_BYTES = 256 * 1024

/** Maximum feature-image size accepted by Plugin Manager (5 MiB default). */
const MAX_DETAIL_IMAGE_BYTES = 5 * 1024 * 1024

/** Client modules supplied by the DSH runtime (must never be bundled). */
const CLIENT_EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

/** Prompt roles that must each have a `roles/<id>.md` file (design §7.2/§8.1). */
const PROMPT_ROLES = [
  'master',
  'words',
  'idioms',
  'style',
  'facts',
  'nouns',
  'headline',
  'consistency',
  'consolidator',
]

/** Contract schemas that must exist and parse (design §8.1). */
const PROMPT_CONTRACTS = [
  'findings.schema.json',
  'claims.schema.json',
  'factchecks.schema.json',
  'nouns.schema.json',
  'layout.schema.json',
]

/** Expected locale titles (global constraint). */
const LOCALE_TITLES = { zh: 'Ling Gao 校对员', en: 'Ling Gao Proofreader' }

/** Expected localized detail documents (plugin-details checklist). */
const LOCALE_DETAILS = { zh: 'docs/DETAIL.zh.md', en: 'docs/DETAIL.md' }

/** Files every release archive must contain (design §12.3). */
const RELEASE_REQUIRED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'icon.png',
  'lib/index.js',
  'lib/client.js',
  'locale/en.json',
  'locale/zh.json',
  'prompts/zh/base.md',
  'prompts/zh/rules.md',
  'prompts/zh/contracts/findings.schema.json',
  'docs/DETAIL.md',
  'docs/DETAIL.zh.md',
  'docs/preview.svg',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

/** Paths that are never install-relevant and must not be packaged. */
const RELEASE_FORBIDDEN_PREFIXES = [
  'node_modules/',
  'src/',
  'assets/',
  'tests/',
  'scripts/',
  'release/',
  '.git/',
]

/* ------------------------------------------------------------------------- */
/* Result collection                                                           */
/* ------------------------------------------------------------------------- */

const problems = []

/** Record one failed check. */
function fail(message) {
  problems.push(message)
}

/** Run `check` and turn an exception into a readable validation problem. */
async function check(label, action) {
  try {
    await action()
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Assert a condition, recording a problem instead of throwing. */
function expectTrue(condition, message) {
  if (!condition) fail(message)
}

/** Assert strict equality with a readable message. */
function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/** Read and parse a JSON file. */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

/** True when `path` stays inside `root` (no traversal). */
function isInside(root, path) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return path.startsWith(normalizedRoot) || path === root
}

/* ------------------------------------------------------------------------- */
/* Manifest                                                                    */
/* ------------------------------------------------------------------------- */

/** Validate the bundle manifest fields the Host and Plugin Manager read. */
async function checkManifest() {
  const manifest = await readJson(join(ROOT, 'package.json'))

  expectEqual(manifest.name, PACKAGE_NAME, 'package.json name')
  expectEqual(manifest.type, 'module', 'package.json type')
  expectTrue(
    typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version),
    `package.json version must be semver, got ${JSON.stringify(manifest.version)}`,
  )
  expectEqual(manifest.license, 'MIT', 'package.json license')
  expectEqual(manifest.engines?.node, '>=24', 'package.json engines.node')
  expectEqual(manifest.engines?.dsh, DSH_RANGE, 'package.json engines.dsh')
  expectEqual(manifest.icon, './icon.png', 'package.json icon')

  const exportsField = manifest.exports ?? {}
  expectEqual(exportsField['.'], './lib/index.js', 'package.json exports["."]')
  expectEqual(exportsField['./client'], './lib/client.js', 'package.json exports["./client"]')
  expectEqual(exportsField['./locale/*.json'], './locale/*.json', 'package.json exports locale')
  expectEqual(exportsField['./icon'], './icon.png', 'package.json exports icon')
  expectEqual(exportsField['./package.json'], './package.json', 'package.json exports package')

  expectEqual(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'package.json dsh.bundle.patch')
  expectEqual(manifest.dsh?.client?.platform, 'web', 'package.json dsh.client.platform')
  expectEqual(manifest.dsh?.client?.immediately, true, 'package.json dsh.client.immediately')
  const inject = manifest.dsh?.client?.inject
  expectTrue(Array.isArray(inject), 'package.json dsh.client.inject must be an array')
  for (const moduleName of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-locale',
  ]) {
    expectTrue(
      Array.isArray(inject) && inject.includes(moduleName),
      `package.json dsh.client.inject must include ${moduleName}`,
    )
  }

  const files = Array.isArray(manifest.files) ? manifest.files : []
  expectTrue(files.length > 0, 'package.json files must not be empty')
  for (const entry of files) {
    expectTrue(typeof entry === 'string', 'package.json files entries must be strings')
    const normalized = String(entry).replace(/\\/gu, '/')
    for (const forbidden of RELEASE_FORBIDDEN_PREFIXES) {
      expectTrue(
        !(normalized === forbidden.replace(/\/$/u, '') || normalized.startsWith(forbidden)),
        `package.json files must not include non-install-relevant path ${entry}`,
      )
    }
  }
  for (const required of [
    'lib',
    'locale',
    'prompts',
    'icon.png',
    'cordis.patch.yml',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'docs/DETAIL.md',
    'docs/DETAIL.zh.md',
    'docs/preview.svg',
  ]) {
    expectTrue(
      files.some((entry) => String(entry).replace(/\\/gu, '/') === required),
      `package.json files must include ${required}`,
    )
  }

  await access(join(ROOT, 'cordis.patch.yml'))
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  expectTrue(/insert:\s*/u.test(patch), 'cordis.patch.yml must use the Loader insert syntax')
  expectTrue(
    new RegExp(`id:\\s*${CORDIS_ROW_ID}(?:\\s|$)`, 'u').test(patch),
    `cordis.patch.yml must insert the ${CORDIS_ROW_ID} row`,
  )
  expectTrue(
    new RegExp(`name:\\s*['"]?${PACKAGE_NAME}['"]?(?:\\s|$)`, 'u').test(patch),
    `cordis.patch.yml row name must be ${PACKAGE_NAME}`,
  )

  // Keep the release whitelist honest: declared runtime files exist.
  for (const required of RELEASE_REQUIRED_FILES) {
    await access(join(ROOT, ...required.split('/')))
  }
}

/* ------------------------------------------------------------------------- */
/* Locale metadata, detail documents and the preview image                     */
/* ------------------------------------------------------------------------- */

/** Validate one locale file and return its parsed content. */
async function checkLocale(locale) {
  const filePath = join(ROOT, 'locale', `${locale}.json`)
  await access(filePath)
  const content = await readJson(filePath)
  const meta = content.meta
  expectTrue(
    typeof meta === 'object' && meta !== null && !Array.isArray(meta),
    `locale/${locale}.json must declare meta`,
  )
  expectEqual(meta?.title, LOCALE_TITLES[locale], `locale/${locale}.json meta.title`)
  expectTrue(
    typeof meta?.description === 'string' && meta.description.trim().length >= 80,
    `locale/${locale}.json meta.description must explain the feature (>= 80 chars)`,
  )
  expectEqual(meta?.detail, LOCALE_DETAILS[locale], `locale/${locale}.json meta.detail`)
  return content
}

/** Validate one detail document: exactly one image line pointing inside docs/. */
async function checkDetailDocument(relativePath) {
  const filePath = join(ROOT, ...relativePath.split('/'))
  await access(filePath)
  const text = await readFile(filePath, 'utf8')
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
  expectEqual(lines.length, 1, `${relativePath} must contain exactly one image line`)
  const match = /^!\[([^\]]{4,})\]\(([^)]+)\)$/u.exec(lines[0]?.trim() ?? '')
  expectTrue(match !== null, `${relativePath} must be a single Markdown image line`)
  if (match === null) return
  const imageTarget = match[2].trim()
  expectTrue(!/^https?:/iu.test(imageTarget), `${relativePath} image must be packaged locally`)
  expectTrue(!imageTarget.startsWith('/'), `${relativePath} image path must be relative`)
  const imagePath = join(ROOT, 'docs', imageTarget)
  expectTrue(isInside(join(ROOT, 'docs'), imagePath), `${relativePath} image must stay in docs/`)
  await access(imagePath)
  expectTrue(/\.svg$/iu.test(imageTarget), `${relativePath} image must be the SVG preview`)
}

/** Validate `docs/preview.svg` against the plugin-details image rules. */
async function checkPreviewSvg() {
  const filePath = join(ROOT, 'docs', 'preview.svg')
  const info = await stat(filePath)
  expectTrue(info.size > 0 && info.size <= MAX_DETAIL_IMAGE_BYTES, 'docs/preview.svg size is out of range')
  const svg = await readFile(filePath, 'utf8')
  expectTrue(/^<svg[\s>]/u.test(svg.trim()), 'docs/preview.svg must start with an <svg> element')
  expectTrue(svg.trim().endsWith('</svg>'), 'docs/preview.svg must end with </svg>')
  expectTrue(
    /width="640"/u.test(svg) && /height="300"/u.test(svg) && /viewBox="0 0 640 300"/u.test(svg),
    'docs/preview.svg must be 640x300 with viewBox "0 0 640 300"',
  )
  for (const forbidden of ['<script', '<foreignObject', '<text', '<style', ' onanimation', ' onclick']) {
    expectTrue(
      !svg.toLowerCase().includes(forbidden.toLowerCase()),
      `docs/preview.svg must not contain ${forbidden}`,
    )
  }
  expectTrue(!/\son[a-z]+\s*=/iu.test(svg), 'docs/preview.svg must not use event handlers')
  expectTrue(!/href="https?:/iu.test(svg) && !/src="https?:/iu.test(svg), 'docs/preview.svg must be self-contained')

  // The brand wordmark is embedded unchanged as a base64 PNG data URL.
  const image = /<image\b[^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/u.exec(svg)
  expectTrue(image !== null, 'docs/preview.svg must embed the brand wordmark as a base64 PNG')
  if (image !== null) {
    const png = Buffer.from(image[1], 'base64')
    expectTrue(
      png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      'docs/preview.svg embedded asset is not a PNG',
    )
  }
}

/* ------------------------------------------------------------------------- */
/* Icon                                                                        */
/* ------------------------------------------------------------------------- */

/** Validate the Plugin Manager icon: real PNG, square, <= 256 KiB. */
async function checkIcon() {
  const filePath = join(ROOT, 'icon.png')
  const info = await stat(filePath)
  expectTrue(info.size <= MAX_ICON_BYTES, `icon.png must be <= 256 KiB, got ${info.size} bytes`)
  const png = await readFile(filePath)
  expectTrue(
    png.length >= 24 &&
      png[0] === 0x89 &&
      png[1] === 0x50 &&
      png[2] === 0x4e &&
      png[3] === 0x47 &&
      png[4] === 0x0d &&
      png[5] === 0x0a &&
      png[6] === 0x1a &&
      png[7] === 0x0a,
    'icon.png must be a valid PNG file',
  )
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  expectTrue(width === 512 && height === 512, `icon.png must be 512x512, got ${width}x${height}`)
}

/* ------------------------------------------------------------------------- */
/* Built artifacts                                                             */
/* ------------------------------------------------------------------------- */

/** `node --check` one artifact (throws with the real diagnostic). */
function checkSyntax(filePath) {
  execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' })
}

/** The prompt text that must never be exported to the browser (design §8.1). */
async function collectPromptNeedles() {
  const promptRoot = join(ROOT, 'prompts', 'zh')
  const full = []
  const lines = []
  const seenFull = new Set()
  const seenLines = new Set()

  /** Recursively list files below `dir`. */
  async function filesBelow(dir) {
    const files = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = join(dir, entry.name)
      if (entry.isDirectory()) files.push(...(await filesBelow(relative)))
      else if (entry.isFile()) files.push(relative)
    }
    return files.sort()
  }

  // Every shipped prompt file is a leak needle: its complete content and every
  // substantive line, so a partial import/copy of any prompt is caught, not just
  // `base.md` or role headers.
  for (const filePath of await filesBelow(promptRoot)) {
    const text = await readFile(filePath, 'utf8')
    const relative = filePath.slice(promptRoot.length + 1).replace(/\\/gu, '/')
    if (text.trim().length > 0 && !seenFull.has(text)) {
      seenFull.add(text)
      full.push({ needle: text, reason: `full content of prompts/zh/${relative}` })
    }
    // Line-level needles only for prose prompts: JSON schema enum lines like
    // `"title",` legitimately repeat UI strings, while the complete schema
    // content is already checked above.
    if (!relative.endsWith('.md')) continue
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed.length < 8 || /^[{}[\],;:]+$/u.test(trimmed) || seenLines.has(trimmed)) continue
      seenLines.add(trimmed)
      lines.push({ needle: trimmed, reason: `line from prompts/zh/${relative}` })
    }
  }

  return { full, lines }
}

/**
 * The only version string a shipped artifact may report as its compiled default.
 *
 * `scripts/build.mjs` injects this banner through esbuild `define` for both
 * artifacts; a stale `lib/` (built from an older manifest version) therefore
 * fails here even when the source files are current.
 */
export function checkArtifactVersion(hostText, clientText, version) {
  const problems = []
  const banner = `Ling Gao Proofreader v${version}`
  if (typeof hostText !== 'string' || !hostText.includes(banner)) {
    problems.push(`lib/index.js must contain the compiled report version banner ${JSON.stringify(banner)}`)
  }
  if (typeof clientText !== 'string' || !clientText.includes(banner)) {
    problems.push(`lib/client.js must contain the compiled report version banner ${JSON.stringify(banner)}`)
  }
  const hostFallback = /DEFAULT_REPORT_VERSION\s*=\s*"([^"]+)"/u.exec(hostText ?? '')
  if (hostFallback !== null && hostFallback[1] !== version) {
    problems.push(
      `lib/index.js compiled fallback ${JSON.stringify(hostFallback[1])} does not match package.json version ${JSON.stringify(version)}`,
    )
  }
  return problems
}

/** Validate both prebuilt artifacts. */
async function checkArtifacts(manifest) {
  const hostPath = join(ROOT, 'lib', 'index.js')
  const clientPath = join(ROOT, 'lib', 'client.js')
  await access(hostPath)
  await access(clientPath)

  const host = await readFile(hostPath, 'utf8')
  const client = await readFile(clientPath, 'utf8')
  const promptNeedles = await collectPromptNeedles()

  // Host: one loadable ESM file with the resolution anchor intact.
  await check('lib/index.js syntax', () => checkSyntax(hostPath))
  expectTrue(host.includes('import.meta.url'), 'lib/index.js must preserve import.meta.url')
  expectTrue(!host.includes('module.exports'), 'lib/index.js must stay ESM (no module.exports)')
  expectTrue(
    !host.includes('window.__ModuleLoader__'),
    'lib/index.js must not contain the browser ModuleLoader wrapper',
  )
  for (const { needle, reason } of promptNeedles.full) {
    expectTrue(!host.includes(needle), `lib/index.js contains ${reason}`)
  }
  expectTrue(
    !/[A-Za-z]:[\\/](?:Users|Program Files)[\\/]/u.test(host),
    'lib/index.js contains an absolute build-machine path',
  )
  // The report renderer ships in the Host bundle; the version is passed at runtime.
  expectTrue(host.includes('Ling Gao Proofreader v'), 'lib/index.js must bundle the report renderer')

  // Client: DSH ModuleLoader wrapper, strict mode, classic-script parse, no
  // prompt/Host code.
  await check('lib/client.js syntax', () => checkSyntax(clientPath))
  const expectedHeader = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)},`
  expectTrue(client.startsWith(expectedHeader), `lib/client.js must start with ${expectedHeader}`)
  expectTrue(client.includes('return module.exports'), 'lib/client.js factory must return module.exports')
  expectTrue(client.trimEnd().endsWith('});'), 'lib/client.js wrapper must end with });')
  const factoryStart = client.indexOf('  factory(require) {\n')
  const strictAt = client.indexOf("    'use strict';\n", factoryStart)
  const moduleAt = client.indexOf('    const module =', factoryStart)
  expectTrue(
    factoryStart >= 0 && strictAt === factoryStart + '  factory(require) {\n'.length,
    "lib/client.js factory must start with the 'use strict'; directive (strict mode)",
  )
  expectTrue(
    moduleAt >= 0 && strictAt >= 0 && strictAt < moduleAt,
    'lib/client.js factory must enter strict mode before the module shim',
  )
  await check('lib/client.js classic-script parse', () => new Function(client))
  await check('lib/client.js ModuleLoader id', () => {
    const registered = /^window\.__ModuleLoader__\.load\(\{ id: "([^"]+)"/u.exec(client)
    expectEqual(registered?.[1], manifest.name, 'lib/client.js ModuleLoader id')
  })
  expectTrue(
    client.split('window.__ModuleLoader__.load(').length === 2,
    'lib/client.js must register exactly one ModuleLoader factory',
  )
  expectTrue(
    client.length > 1_000_000,
    'lib/client.js is too small to contain the bundled PDF.js + worker',
  )
  expectTrue(
    (client.match(/data:image\/png;base64,/gu) ?? []).length >= 3,
    'lib/client.js must inline the three brand PNG assets',
  )
  expectTrue(client.includes('GlobalWorkerOptions'), 'lib/client.js must bundle the PDF.js worker bootstrap')
  for (const { needle, reason } of promptNeedles.lines) {
    expectTrue(!client.includes(needle), `lib/client.js contains ${reason}`)
  }
  for (const { needle, reason } of promptNeedles.full) {
    expectTrue(!client.includes(needle), `lib/client.js contains ${reason}`)
  }
  for (const marker of ['node:fs', 'node:crypto', 'plugin-data', 'DocumentStore', 'createHandlers']) {
    expectTrue(!client.includes(marker), `lib/client.js must not contain Host code (${marker})`)
  }
  // Every `require()` must be a declared DSH runtime module.
  for (const match of client.matchAll(/require\("([^"]+)"\)/gu)) {
    expectTrue(
      CLIENT_EXTERNALS.has(match[1]),
      `lib/client.js requires undeclared browser module ${JSON.stringify(match[1])}`,
    )
  }
}

/* ------------------------------------------------------------------------- */
/* Prompts                                                                     */
/* ------------------------------------------------------------------------- */

/** Validate the shipped prompt library files and contract schemas. */
async function checkPrompts() {
  const promptRoot = join(ROOT, 'prompts', 'zh')
  await access(promptRoot)

  for (const relative of [
    'base.md',
    'rules.md',
    'README.md',
    ...PROMPT_ROLES.map((role) => `roles/${role}.md`),
    ...PROMPT_CONTRACTS.map((contract) => `contracts/${contract}`),
  ]) {
    const filePath = join(promptRoot, ...relative.split('/'))
    await access(filePath)
    const text = await readFile(filePath, 'utf8')
    if (relative.endsWith('.json')) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        fail(`prompts/zh/${relative} is not valid JSON: ${error instanceof Error ? error.message : error}`)
        continue
      }
      expectTrue(
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
        `prompts/zh/${relative} must be an object-rooted JSON Schema`,
      )
    } else {
      expectTrue(text.trim().length > 0, `prompts/zh/${relative} must not be empty`)
    }
  }

  // The role list is the cross-task contract: every documented role has a file.
  expectTrue(PROMPT_ROLES.length === 9, 'the prompt role inventory must stay at 9 roles')
}

/* ------------------------------------------------------------------------- */
/* Version single-sourcing                                                     */
/* ------------------------------------------------------------------------- */

/** The report version must be the manifest version, and the manifest must be tagged. */
async function checkVersionSync(manifest) {
  const markdown = await readFile(join(ROOT, 'src', 'shared', 'report', 'markdown.ts'), 'utf8')
  const fallback = /DEFAULT_REPORT_VERSION\s*=\s*'([^']+)'/u.exec(markdown)
  expectTrue(fallback !== null, 'src/shared/report/markdown.ts must declare DEFAULT_REPORT_VERSION')
  if (fallback !== null) {
    expectEqual(fallback[1], manifest.version, 'report footer fallback version')
  }
  expectTrue(
    /renderReportMarkdown\(report,[\s\S]{0,160}?, version\)/u.test(
      await readFile(join(ROOT, 'src', 'host', 'api', 'handlers.ts'), 'utf8'),
    ),
    'the Host export handler must pass its package version into the report renderer',
  )
  // The compiled artifacts must carry the manifest version as a literal, so a
  // stale `lib/` built from an older manifest fails validation.
  const [host, client] = await Promise.all([
    readFile(join(ROOT, 'lib', 'index.js'), 'utf8'),
    readFile(join(ROOT, 'lib', 'client.js'), 'utf8'),
  ])
  for (const problem of checkArtifactVersion(host, client, manifest.version)) fail(problem)
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8')
  expectTrue(
    changelog.includes(`## [${manifest.version}]`),
    `CHANGELOG.md must contain a ${manifest.version} release section`,
  )
}

/* ------------------------------------------------------------------------- */
/* Installed-package prompt-resolution smoke test                              */
/* ------------------------------------------------------------------------- */

/** Stage a minimal installed package and run the Host entry's `apply`. */
async function smokePromptResolution() {
  const stage = await mkdtemp(join(tmpdir(), 'lgproofreader-validate-'))
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  try {
    await mkdir(join(stage, 'lib'), { recursive: true })
    await cp(join(ROOT, 'package.json'), join(stage, 'package.json'))
    await cp(join(ROOT, 'prompts'), join(stage, 'prompts'), { recursive: true })
    await cp(join(ROOT, 'lib', 'index.js'), join(stage, 'lib', 'index.js'))
    process.env.DSH_PROFILE_DIR = join(stage, 'data')

    const hostModule = await import(pathToFileURL(join(stage, 'lib', 'index.js')).href)
    expectTrue(typeof hostModule.apply === 'function', 'lib/index.js must export apply()')

    const routes = []
    const context = {
      logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get: () => undefined,
      llm: {
        async *stream() {
          throw new Error('the validation smoke test must not call the model')
        },
        listProviders: () => [],
        listModels: async () => [],
      },
      attachments: {
        saveImage: async () => ({ id: 'img_1', width: 1, height: 1, mediaType: 'image/png' }),
      },
      effect: (execute) => execute(),
      connection: {
        fetch: {
          register: (route) => {
            routes.push(route)
            return async () => {}
          },
        },
      },
    }

    await hostModule.apply(context)

    // 15 exact transport paths: 17 handler routes with /page-image and /settings
    // merged per path (design §10.2).
    expectTrue(routes.length === 15, `apply() must register 15 API routes, got ${routes.length}`)
    for (const route of routes) {
      expectTrue(
        typeof route.path === 'string' && route.path.startsWith(`${API_PREFIX}/`),
        `route ${String(route.path)} must use the ${API_PREFIX} prefix`,
      )
      expectTrue(Array.isArray(route.methods) && route.methods.length > 0, `route ${route.path} must declare methods`)
      expectTrue(typeof route.fetch === 'function', `route ${route.path} must expose fetch()`)
    }
  } finally {
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
    await rm(stage, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* ------------------------------------------------------------------------- */

async function main() {
  let manifest
  try {
    manifest = await readJson(join(ROOT, 'package.json'))
  } catch (error) {
    fail(`package.json: ${error instanceof Error ? error.message : error}`)
    report()
    return
  }

  await check('manifest', () => checkManifest())
  await check('locale/zh.json', () => checkLocale('zh'))
  await check('locale/en.json', () => checkLocale('en'))
  await check('docs/DETAIL.md', () => checkDetailDocument('docs/DETAIL.md'))
  await check('docs/DETAIL.zh.md', () => checkDetailDocument('docs/DETAIL.zh.md'))
  await check('docs/preview.svg', () => checkPreviewSvg())
  await check('icon.png', () => checkIcon())
  await check('lib artifacts', () => checkArtifacts(manifest))
  await check('prompts', () => checkPrompts())
  await check('version sync', () => checkVersionSync(manifest))
  await check('installed-package prompt resolution', () => smokePromptResolution())

  report()
}

/** Print the problems and set the process exit code. */
function report() {
  for (const problem of problems) console.error(`validate: ERROR ${problem}`)
  if (problems.length > 0) {
    console.error(`validate: failed (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
    process.exitCode = 1
    return
  }
  console.log('ok')
}

// Run only when executed as a script (helpers stay importable by tooling/tests).
if (isExecutedAsScript()) await main()

/** True when Node was asked to run this file directly, not to import it. */
function isExecutedAsScript() {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  return pathToFileURL(resolve(entry)).href === import.meta.url
}

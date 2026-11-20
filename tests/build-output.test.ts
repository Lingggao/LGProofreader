/**
 * Build-output and release-script verification (Task 20; design §12).
 *
 * Unlike the other suites, these are integration checks over the committed
 * build artifacts: `lib/index.js` (Host ESM) and `lib/client.js` (DSH
 * `__ModuleLoader__` client bundle). They require `pnpm build` before `pnpm test`;
 * the release script always builds and validates first.
 *
 * The checks pin the public DSH contract of the artifacts (module id, factory
 * return, preserved `import.meta.url`, no prompt/Host leakage into the browser
 * bundle) and the version single-sourcing of the exported report footer.
 */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHandlers } from '../src/host/api/handlers'
import type { JobOrchestrator } from '../src/host/proof/orchestrator'
import type { DocumentStore } from '../src/host/services/store'
import { API_PATHS } from '../src/shared/api/protocol'
import { renderReportMarkdown } from '../src/shared/report/markdown'
import type { DocumentRecord, Report } from '../src/shared/types'

const ROOT = process.cwd()
const LIB_DIR = path.join(ROOT, 'lib')
const CLIENT_BUNDLE = path.join(LIB_DIR, 'client.js')
const HOST_BUNDLE = path.join(LIB_DIR, 'index.js')

const PACKAGE_NAME = 'lg-proofreader'

/** Read the version from the package manifest (the release source of truth). */
async function readPackageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    version: string
  }
  return manifest.version
}

/** One minimal, schema-valid report for the Markdown footer checks. */
function minimalReport(overrides: Partial<Report> = {}): Report {
  return {
    jobId: 'job_1700000000000_abcdef',
    docId: 'doc_1700000000000_abcdef',
    articleIds: [],
    createdAt: 1_700_000_000_000,
    model: 'deepseek-official/deepseek-flash',
    promptVersion: 'pv_0123456789ab',
    depth: 'standard',
    summary: {
      mustFixCount: 0,
      suggestedCount: 0,
      optionalCount: 0,
      factCheck: { confirmed: 0, contradicted: 0, unverified: 0, insufficient: 0, notChecked: 0 },
      byCategory: {},
      mustFixList: [],
    },
    findings: [],
    factChecks: [],
    stats: { calls: 0, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 0 },
    ...overrides,
  }
}

/** One minimal document record whose articles resolve in the export. */
function minimalDocument(): DocumentRecord {
  return {
    meta: {
      id: 'doc_1700000000000_abcdef',
      fileName: 'sample.pdf',
      pageCount: 1,
      createdAt: 1_700_000_000_000,
      status: 'ready',
    },
    articles: [],
    reportIds: ['job_1700000000000_abcdef'],
  }
}

/** Run `node --check <file>` so a syntax error fails with the real diagnostic. */
function checkSyntax(filePath: string): void {
  execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' })
}

describe('client bundle', () => {
  it('emits a loadable client bundle wrapper', async () => {
    const js = await readFile(CLIENT_BUNDLE, 'utf8')
    // The exact DSH ModuleLoader contract: one lazy factory whose id is the
    // package name, returning the CJS export object.
    expect(js.startsWith('window.__ModuleLoader__.load({ id: "lg-proofreader"')).toBe(true)
    expect(js).toContain('return module.exports')
    expect(js.trimEnd().endsWith('});')).toBe(true)
    // The wrapper must parse as a classic script (the inlined PDF.js worker
    // source legitimately mentions `import.meta` inside its own string literal).
    expect(() => new Function(js)).not.toThrow()
    // Strict mode must actually be in effect: the directive is the factory's
    // first statement, before the `const module` shim (otherwise the body's own
    // leading `"use strict";` would no longer be a directive and the whole
    // factory would run sloppy).
    const factoryStart = js.indexOf('  factory(require) {\n')
    const strictStart = "  factory(require) {\n    'use strict';"
    expect(factoryStart).toBeGreaterThan(0)
    expect(js.slice(factoryStart, factoryStart + strictStart.length)).toBe(strictStart)
    expect(js.indexOf("    'use strict';", factoryStart)).toBeLessThan(
      js.indexOf('    const module =', factoryStart),
    )
    checkSyntax(CLIENT_BUNDLE)
  })

  it('inlines the PDF.js worker source and the brand assets', async () => {
    const js = await readFile(CLIENT_BUNDLE, 'utf8')
    // The PDF.js worker is a build-time string; no separate asset is fetched.
    expect(js).toContain('data:image/png;base64,')
    expect(js).toContain('GlobalWorkerOptions')
    expect(js.length).toBeGreaterThan(500 * 1024)
    // The runtime worker is installed from the injected source, not a URL asset.
    expect(js).toContain('createObjectURL')
  })

  it('does not leak prompt text or Host-only code into the browser bundle', async () => {
    const js = await readFile(CLIENT_BUNDLE, 'utf8')
    // Prompt files are read by the Host only (design §8.1).
    expect(js).not.toContain('请担任新闻校对员')
    expect(js).not.toContain('prompts/zh')
    // Host-only Node/database modules cannot exist in a browser bundle.
    expect(js).not.toContain('node:fs')
    expect(js).not.toContain('node:crypto')
    expect(js).not.toContain('plugin-data')
    // No absolute build-machine paths may be baked into the artifact.
    expect(js).not.toMatch(/[A-Za-z]:\\\\Users\\\\/)
  })
  it('executes its factory and exports the Cordis entry', () => {
    // Execute the wrapper as a browser module would: capture the factory, call
    // it with the real React modules from node_modules, and check the Cordis
    // entry exports. Runs in a child process so `window` stays out of Vitest.
    const script = [
      "import { createRequire } from 'node:module'",
      "import { pathToFileURL } from 'node:url'",
      `const require = createRequire(${JSON.stringify(pathToFileURL(path.join(ROOT, 'package.json')).href)})`,
      'globalThis.window = {}',
      'let captured = null',
      'globalThis.window.__ModuleLoader__ = { load(options) { captured = options } }',
      `await import(${JSON.stringify(pathToFileURL(CLIENT_BUNDLE).href)})`,
      "if (captured === null) throw new Error('ModuleLoader.load was not called')",
      `if (captured.id !== ${JSON.stringify(PACKAGE_NAME)}) throw new Error('wrong module id: ' + captured.id)`,
      // Prove strict mode from the executed factory itself: its source must
      // begin with the directive as the first statement.
      'const factorySource = captured.factory.toString()',
      "if (!/^factory\\(require\\) \\{\\n    'use strict';/.test(factorySource)) {",
      "  throw new Error('factory is not in strict mode: ' + factorySource.slice(0, 80))",
      '}',
      'const exported = captured.factory(require)',
      "if (typeof exported.apply !== 'function') throw new Error('factory did not return apply()')",
      "if (!Array.isArray(exported.inject)) throw new Error('factory did not return inject[]')",
      "if (!exported.inject.includes('slots') || !exported.inject.includes('locale')) throw new Error('unexpected inject[]')",
    ].join('\n')
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      stdio: 'pipe',
    })
  })
})

describe('host bundle', () => {
  it('keeps import.meta.url for installed-package prompt resolution', async () => {
    const js = await readFile(HOST_BUNDLE, 'utf8')
    expect(js).toContain('import.meta.url')
    // The Host bundle must stay one ESM file that resolves prompts at runtime.
    expect(js).not.toContain('module.exports')
    expect(js).not.toContain('请担任新闻校对员')
    checkSyntax(HOST_BUNDLE)
  })

  it('imports as an ESM module that exports apply', () => {
    const script = [
      `const module = await import(${JSON.stringify(pathToFileURL(HOST_BUNDLE).href)})`,
      "if (typeof module.apply !== 'function') {",
      "  console.error('missing apply export')",
      '  process.exit(2)',
      '}',
    ].join('\n')
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' })
  })
})

describe('version single-sourcing', () => {
  it('renders an explicitly supplied plugin version in the report footer', () => {
    const markdown = renderReportMarkdown(minimalReport(), [], '9.9.9')
    expect(markdown).toContain('Ling Gao Proofreader v9.9.9')
  })

  it('renders the package version by default', async () => {
    const version = await readPackageVersion()
    const markdown = renderReportMarkdown(minimalReport(), [])
    expect(markdown).toContain(`Ling Gao Proofreader v${version}`)
  })

  it('embeds the package version in both built artifacts as a compiled fallback', async () => {
    const version = await readPackageVersion()
    const banner = `Ling Gao Proofreader v${version}`
    const [host, client] = await Promise.all([
      readFile(HOST_BUNDLE, 'utf8'),
      readFile(CLIENT_BUNDLE, 'utf8'),
    ])
    // The build injects the manifest version as one contiguous literal, so a
    // stale artifact cannot pose as a current release (validate.mjs checks it).
    expect(host).toContain(banner)
    expect(client).toContain(banner)
    // The compiled Host fallback constant stays in sync as well.
    expect(host).toContain(`DEFAULT_REPORT_VERSION = "${version}"`)
  })

  it('passes the Host package version through the export handler', async () => {
    const version = await readPackageVersion()
    const report = minimalReport()
    const document = minimalDocument()
    const store = {
      getReport: async (): Promise<Report> => report,
      getDocument: async (): Promise<DocumentRecord> => document,
    } as unknown as DocumentStore
    const handlers = createHandlers({
      store,
      orchestrator: {} as JobOrchestrator,
      limits: { maxUploadBytes: 1024, maxImageBytes: 1024 },
      version,
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
      promptVersion: 'pv_0123456789ab',
    })
    const response = await handlers.exportReport(
      new Request(`http://localhost${API_PATHS.exportReport}?job=job_1700000000000_abcdef`),
    )
    expect(response.status).toBe(200)
    const markdown = await response.text()
    expect(markdown).toContain(`Ling Gao Proofreader v${version}`)
  })
})

describe('repository scripts', () => {
  it('validate.mjs accepts the built package and prints ok', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'validate.mjs')],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(output.trim().split(/\r?\n/).at(-1)).toBe('ok')
  })

  it('rejects a stale built-artifact version (version-sync helper)', async () => {
    const version = await readPackageVersion()
    const validateUrl = pathToFileURL(path.join(ROOT, 'scripts', 'validate.mjs')).href
    const script = [
      "import { readFile } from 'node:fs/promises'",
      `const { checkArtifactVersion } = await import(${JSON.stringify(validateUrl)})`,
      `const [host, client] = await Promise.all([readFile(${JSON.stringify(HOST_BUNDLE)}, 'utf8'), readFile(${JSON.stringify(CLIENT_BUNDLE)}, 'utf8')])`,
      `const version = ${JSON.stringify(version)}`,
      'const clean = checkArtifactVersion(host, client, version)',
      "if (clean.length !== 0) { console.error('current artifacts rejected: ' + clean.join('; ')); process.exit(2) }",
      `const stale = client.split('Ling Gao Proofreader v' + version).join('Ling Gao Proofreader v0.0.9')`,
      'const staleProblems = checkArtifactVersion(host, stale, version)',
      "if (staleProblems.length === 0) { console.error('stale artifact version was accepted'); process.exit(3) }",
    ].join('\n')
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      stdio: 'pipe',
    })
  })
})

// Keep the package name assertion explicit: the ModuleLoader id must equal it.
it('registers the client factory under the package name', async () => {
  const js = await readFile(CLIENT_BUNDLE, 'utf8')
  expect(js.slice(0, 200)).toContain(`id: "${PACKAGE_NAME}"`)
})

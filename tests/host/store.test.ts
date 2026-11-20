import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Article, DocumentMeta, Region, Report } from '../../src/shared/types'
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  loadSettings,
  saveSettings,
} from '../../src/host/services/settings'
import {
  DocumentNotFoundError,
  DocumentStore,
  InvalidArticleIdError,
  InvalidDocumentIdError,
  InvalidJobIdError,
  InvalidRoleIdError,
  resolveDataDir,
} from '../../src/host/services/store'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lgp-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeStore(): Promise<{ dir: string; store: DocumentStore }> {
  const dir = await makeTempDir()
  const store = new DocumentStore(dir)
  await store.init()
  return { dir, store }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function tempFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries.filter((entry) => entry.endsWith('.tmp'))
}

function docDir(dir: string, id: string): string {
  return join(dir, 'documents', id)
}

function regionFixture(): Region {
  return {
    id: 'r1',
    page: 1,
    kind: 'lead',
    bbox: { x: 10, y: 20, w: 300, h: 100 },
    lineIds: ['l1'],
    articleId: 'a1',
    order: 0,
    confidence: 0.9,
    source: 'vision',
  }
}

function articleFixture(): Article {
  return {
    id: 'a1',
    page: 1,
    role: 'lead',
    title: '标题',
    body: '正文',
    regionIds: ['r1'],
    readingOrder: 0,
    confidence: 0.9,
    warnings: [],
  }
}

function reportFixture(docId: string, jobId: string): Report {
  return {
    jobId,
    docId,
    articleIds: ['a1'],
    createdAt: 1_763_500_000_000,
    model: 'deepseek-flash',
    promptVersion: 'v1',
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
    stats: { calls: 1, failedCalls: 0, searchCalls: 0, fetchCalls: 0, elapsedMs: 12 },
  }
}

describe('DocumentStore', () => {
  it('creates, persists and deletes one single-page document (brief acceptance)', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'a.pdf', pdfBytes: new Uint8Array([37, 80, 68, 70]) })
    expect(doc.pageCount).toBe(1)
    await store.savePageText(doc.id, { lines: [], candidates: [], widthPt: 1000, heightPt: 1400 })
    await store.savePageImage(doc.id, new Uint8Array([1, 2, 3]))
    await store.saveLayout(doc.id, { regions: [], articles: [] })
    expect((await store.getDocument(doc.id))?.meta.fileName).toBe('a.pdf')
    expect(await store.delete(doc.id)).toBe(true)
    expect(await store.getDocument(doc.id)).toBeUndefined()
    expect(await pathExists(docDir(dir, doc.id))).toBe(false)
  })

  it('init creates the data root, documents dir and an index', async () => {
    const { dir, store } = await makeStore()
    const index = await readJson<{ documents: DocumentMeta[] }>(join(dir, 'index.json'))
    expect(index.documents).toEqual([])
    expect(await pathExists(join(dir, 'documents'))).toBe(true)
    // init is idempotent and safe to call again
    await expect(store.init()).resolves.toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('creates ids in doc_<timestamp>_<6 hex> form and persists meta.json + original.pdf', async () => {
    const { dir, store } = await makeStore()
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10])
    const doc = await store.create({ fileName: '报纸 2026-11-14.pdf', pdfBytes })
    expect(doc.id).toMatch(/^doc_\d+_[0-9a-f]{6}$/)
    expect(doc.fileName).toBe('报纸 2026-11-14.pdf')
    expect(doc.pageCount).toBe(1)
    expect(doc.status).toBe('parsing')
    expect(typeof doc.createdAt).toBe('number')

    const dirOfDoc = docDir(dir, doc.id)
    expect(await readJson<DocumentMeta>(join(dirOfDoc, 'meta.json'))).toEqual(doc)
    expect(await readBytes(join(dirOfDoc, 'original.pdf'))).toEqual(pdfBytes)
    expect((await store.getDocument(doc.id))?.meta).toEqual(doc)

    const index = await readJson<{ documents: DocumentMeta[] }>(join(dir, 'index.json'))
    expect(index.documents).toEqual([doc])
  })

  it('sanitizes uploaded file names so no path escapes the document directory', async () => {
    const { store } = await makeStore()
    const bytes = new Uint8Array([1])
    expect((await store.create({ fileName: '..\\..\\C:\\tmp\\evil.pdf', pdfBytes: bytes })).fileName).toBe('evil.pdf')
    expect((await store.create({ fileName: '../../etc/passwd', pdfBytes: bytes })).fileName).toBe('passwd')
    expect((await store.create({ fileName: '..', pdfBytes: bytes })).fileName).toBe('document.pdf')
    expect((await store.create({ fileName: '', pdfBytes: bytes })).fileName).toBe('document.pdf')
  })

  it('rejects path traversal ids and never writes outside the data dir', async () => {
    const { dir, store } = await makeStore()
    const pageText = { lines: [], candidates: [], widthPt: 1, heightPt: 1 }

    await expect(store.getDocument('../evil')).resolves.toBeUndefined()
    await expect(store.getDocument('doc_1700000000000_abcdef/../evil')).resolves.toBeUndefined()
    await expect(store.getDocument('not-a-doc')).resolves.toBeUndefined()
    await expect(store.getDocument('doc_1700000000000_abcdef')).resolves.toBeUndefined()

    await expect(store.savePageText('../evil', pageText)).rejects.toBeInstanceOf(InvalidDocumentIdError)
    await expect(store.savePageImage('..\\evil', new Uint8Array([1]))).rejects.toBeInstanceOf(InvalidDocumentIdError)
    await expect(store.savePageOverlay('doc_1/../evil', new Uint8Array([1]))).rejects.toBeInstanceOf(
      InvalidDocumentIdError,
    )
    await expect(store.saveLayout('../evil', { regions: [], articles: [] })).rejects.toBeInstanceOf(
      InvalidDocumentIdError,
    )
    await expect(store.delete('../../evil')).resolves.toBe(false)

    expect(await pathExists(join(dir, 'evil'))).toBe(false)
    expect(await pathExists(join(dir, '..', 'evil'))).toBe(false)
  })

  it('throws DocumentNotFoundError when saving to a document that does not exist', async () => {
    const { store } = await makeStore()
    const missing = 'doc_1700000000000_abcdef'
    await expect(store.savePageImage(missing, new Uint8Array([1]))).rejects.toThrow()
    await expect(store.saveLayout(missing, { regions: [], articles: [] })).rejects.toThrow()
    await expect(store.saveReport(missing, reportFixture(missing, 'job_1763500000000'))).rejects.toThrow()
  })

  it('persists page text as 0001.lines.json and 0001.candidates.json', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const lines = [
      {
        id: 'l1',
        text: '标题',
        bbox: { x: 10, y: 20, w: 100, h: 30 },
        fontSize: 30,
        fontWeight: 700,
        baseline: 20,
        column: 0,
      },
    ]
    const candidates = [
      {
        candidateId: 'c1',
        bbox: { x: 10, y: 20, w: 100, h: 30 },
        lineIds: ['l1'],
        fontSizeBand: 'headline' as const,
        firstLineText: '标题',
        lineCount: 1,
      },
    ]
    await store.savePageText(doc.id, { lines, candidates, widthPt: 1000.3, heightPt: 1488.6 })

    const pages = join(docDir(dir, doc.id), 'pages')
    expect(await readJson(join(pages, '0001.lines.json'))).toEqual(lines)
    expect(await readJson(join(pages, '0001.candidates.json'))).toEqual({
      widthPt: 1000.3,
      heightPt: 1488.6,
      candidates,
    })

    const record = await store.getDocument(doc.id)
    expect(record?.lines).toEqual(lines)
    expect(record?.candidates).toEqual(candidates)
    expect(record?.widthPt).toBe(1000.3)
    expect(record?.heightPt).toBe(1488.6)
  })

  it('persists page image and overlay bytes and returns them through getters', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const overlay = new Uint8Array([1, 2, 3, 4])

    await store.savePageImage(doc.id, png)
    await store.savePageOverlay(doc.id, overlay)

    const pages = join(docDir(dir, doc.id), 'pages')
    expect(await readBytes(join(pages, '0001.png'))).toEqual(png)
    expect(await readBytes(join(pages, '0001.overlay.png'))).toEqual(overlay)
    expect(await store.getPageImage(doc.id)).toEqual(png)
    expect(await store.getPageOverlay(doc.id)).toEqual(overlay)
    expect(await store.getPageImage('doc_1700000000000_abcdef')).toBeUndefined()
    expect(await store.getPageImage('../evil')).toBeUndefined()
  })

  it('persists layout.json + articles.json, marks the document ready and reports hasLayout', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    expect((await store.list())[0]).toMatchObject({ hasLayout: false, reportCount: 0 })

    const regions = [regionFixture()]
    const articles = [articleFixture()]
    await store.saveLayout(doc.id, { regions, articles })

    const dirOfDoc = docDir(dir, doc.id)
    expect(await readJson(join(dirOfDoc, 'layout.json'))).toEqual({ regions })
    expect(await readJson(join(dirOfDoc, 'articles.json'))).toEqual({ articles })
    const record = await store.getDocument(doc.id)
    expect(record?.regions).toEqual(regions)
    expect(record?.articles).toEqual(articles)
    expect(record?.meta.status).toBe('ready')

    const summary = (await store.list())[0]
    expect(summary).toMatchObject({
      hasLayout: true,
      reportCount: 0,
      meta: { id: doc.id, status: 'ready' },
    })
  })

  it('persists reports under reports/<jobId>/report.json and finds them by job id', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const jobId = 'job_1763500000000'
    const report = reportFixture(doc.id, jobId)

    await store.saveReport(doc.id, report)

    expect(await readJson(join(docDir(dir, doc.id), 'reports', jobId, 'report.json'))).toEqual(report)
    expect(await store.getReport(jobId)).toEqual(report)
    expect(await store.getReport(doc.id, jobId)).toEqual(report)
    expect(await store.getReport('job_9999999999999')).toBeUndefined()
    expect(await store.getReport('doc_1700000000000_abcdef', jobId)).toBeUndefined()

    expect((await store.getDocument(doc.id))?.reportIds).toEqual([jobId])
    const summary = (await store.list())[0]
    expect(summary.reportCount).toBe(1)
    expect(summary.hasLayout).toBe(false)
  })

  it('rejects report job ids containing path separators', async () => {
    const { store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    await expect(store.saveReport(doc.id, reportFixture(doc.id, '../evil'))).rejects.toBeInstanceOf(
      InvalidJobIdError,
    )
    await expect(store.saveReport(doc.id, reportFixture(doc.id, 'job_1'))).resolves.toBeUndefined()
    await expect(store.getReport('../evil')).resolves.toBeUndefined()
  })

  it('returns a meta-only record for a document without page artefacts yet', async () => {
    const { store } = await makeStore()
    const doc = await store.create({ fileName: 'fresh.pdf', pdfBytes: new Uint8Array([1]) })
    const record = await store.getDocument(doc.id)
    expect(record?.meta).toEqual(doc)
    expect(record?.reportIds).toEqual([])
    expect(record).not.toHaveProperty('lines')
    expect(record).not.toHaveProperty('candidates')
    expect(record).not.toHaveProperty('widthPt')
    expect(record).not.toHaveProperty('heightPt')
    expect(record).not.toHaveProperty('regions')
    expect(record).not.toHaveProperty('articles')
  })

  it('ignores corrupt page artefacts and corrupt report JSON instead of throwing', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const pages = join(docDir(dir, doc.id), 'pages')
    await store.savePageText(doc.id, { lines: [], candidates: [], widthPt: 1, heightPt: 2 })
    await writeFile(join(pages, '0001.lines.json'), 'garbage', 'utf8')
    await writeFile(join(pages, '0001.candidates.json'), '{"widthPt":"bad"}', 'utf8')

    const record = await store.getDocument(doc.id)
    expect(record?.meta.id).toBe(doc.id)
    expect(record).not.toHaveProperty('lines')
    expect(record).not.toHaveProperty('candidates')
    expect(record).not.toHaveProperty('widthPt')

    const jobId = 'job_1763500000002'
    await store.saveReport(doc.id, reportFixture(doc.id, jobId))
    await writeFile(join(docDir(dir, doc.id), 'reports', jobId, 'report.json'), 'garbage', 'utf8')
    expect(await store.getReport(jobId)).toBeUndefined()
    expect((await store.getDocument(doc.id))?.reportIds).toEqual([jobId])
  })

  it('lists documents newest first with layout and report counts', async () => {
    const { store } = await makeStore()
    const first = await store.create({ fileName: 'first.pdf', pdfBytes: new Uint8Array([1]) })
    const second = await store.create({ fileName: 'second.pdf', pdfBytes: new Uint8Array([2]) })
    await store.saveLayout(second.id, { regions: [], articles: [] })

    const summaries = await store.list()
    expect(summaries).toHaveLength(2)
    expect(summaries.map((summary) => summary.meta.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    )
    expect(summaries[0].meta.createdAt).toBeGreaterThanOrEqual(summaries[1].meta.createdAt)
    expect(summaries.find((summary) => summary.meta.id === second.id)?.hasLayout).toBe(true)
    expect(summaries.find((summary) => summary.meta.id === first.id)?.hasLayout).toBe(false)
  })

  it('delete returns false for unknown ids and is idempotent', async () => {
    const { store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    expect(await store.delete(doc.id)).toBe(true)
    expect(await store.delete(doc.id)).toBe(false)
    expect(await store.delete('doc_1700000000000_abcdef')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('serializes index writes so concurrent creates keep index.json valid and complete', async () => {
    const { dir, store } = await makeStore()
    const docs = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.create({ fileName: `doc-${index}.pdf`, pdfBytes: new Uint8Array([index]) }),
      ),
    )
    expect(new Set(docs.map((doc) => doc.id)).size).toBe(6)

    const index = await readJson<{ documents: DocumentMeta[] }>(join(dir, 'index.json'))
    expect(index.documents).toHaveLength(6)
    expect(index.documents.map((meta) => meta.id).sort()).toEqual(docs.map((doc) => doc.id).sort())
    expect(await store.list()).toHaveLength(6)

    await Promise.all([store.delete(docs[0].id), store.delete(docs[1].id)])
    const afterDeletes = await readJson<{ documents: DocumentMeta[] }>(join(dir, 'index.json'))
    expect(afterDeletes.documents.map((meta) => meta.id).sort()).toEqual(
      docs
        .slice(2)
        .map((doc) => doc.id)
        .sort(),
    )
    expect(await tempFiles(dir)).toEqual([])
  })

  it('recovers from a corrupt index.json by rebuilding it from meta files', async () => {
    const { dir, store } = await makeStore()
    const first = await store.create({ fileName: 'first.pdf', pdfBytes: new Uint8Array([1]) })
    const second = await store.create({ fileName: 'second.pdf', pdfBytes: new Uint8Array([2]) })
    await writeFile(join(dir, 'index.json'), '{ this is not json', 'utf8')

    const reopened = new DocumentStore(dir)
    await reopened.init()
    const listed = await reopened.list()
    expect(listed.map((summary) => summary.meta.id).sort()).toEqual([first.id, second.id].sort())

    const repaired = await readJson<{ documents: DocumentMeta[] }>(join(dir, 'index.json'))
    expect(repaired.documents.map((meta) => meta.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('drops stale index entries and corrupt document metas on init', async () => {
    const { dir, store } = await makeStore()
    const real = await store.create({ fileName: 'real.pdf', pdfBytes: new Uint8Array([1]) })
    const ghost: DocumentMeta = {
      id: 'doc_1700000000000_abcdef',
      fileName: 'ghost.pdf',
      pageCount: 1,
      createdAt: 1,
      status: 'ready',
    }
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({ version: 1, documents: [real, ghost] }),
      'utf8',
    )
    // A second document whose meta.json is corrupt must be skipped, not crash init.
    const broken = await store.create({ fileName: 'broken.pdf', pdfBytes: new Uint8Array([2]) })
    await writeFile(join(docDir(dir, broken.id), 'meta.json'), 'garbage', 'utf8')

    const reopened = new DocumentStore(dir)
    await reopened.init()
    expect((await reopened.list()).map((summary) => summary.meta.id)).toEqual([real.id])
    const index = await readJson<{ documents: DocumentMeta[] }>(join(dir, 'index.json'))
    expect(index.documents.map((meta) => meta.id)).toEqual([real.id])
  })

  it('does not leave temporary files after mixed writes', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    await Promise.all([
      store.savePageText(doc.id, { lines: [], candidates: [], widthPt: 1, heightPt: 2 }),
      store.savePageImage(doc.id, new Uint8Array([1, 2])),
      store.savePageOverlay(doc.id, new Uint8Array([3])),
      store.saveLayout(doc.id, { regions: [], articles: [] }),
      store.saveReport(doc.id, reportFixture(doc.id, 'job_1763500000001')),
    ])
    expect(await tempFiles(dir)).toEqual([])
  })
})

describe('settings', () => {
  it('loads documented defaults when settings.json does not exist', async () => {
    const dir = await makeTempDir()
    await expect(loadSettings(dir)).resolves.toEqual(DEFAULT_SETTINGS)
    expect(await pathExists(join(dir, 'settings.json'))).toBe(false)
  })

  it('has the spec defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      provider: '',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      depth: 'standard',
      factCheck: true,
      maxConcurrentWorkers: 4,
      perCallTimeoutMs: 300_000,
      maxClaimsPerArticle: 16,
      maxSearchQueriesPerArticle: 24,
      searchResultsPerClaim: 5,
      fetchPagesPerClaim: 2,
      includeHeaderFooter: false,
    })
  })

  it('saves a partial patch, merges it over the current settings and reloads it', async () => {
    const dir = await makeTempDir()
    const saved = await saveSettings(dir, { depth: 'deep', factCheck: false, maxConcurrentWorkers: 8 })
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, depth: 'deep', factCheck: false, maxConcurrentWorkers: 8 })
    expect(await loadSettings(dir)).toEqual(saved)
    expect(await readJson(join(dir, 'settings.json'))).toEqual(saved)

    const updated = await saveSettings(dir, { model: 'deepseek-pro', includeHeaderFooter: true })
    expect(updated).toEqual({ ...saved, model: 'deepseek-pro', includeHeaderFooter: true })
    expect(await loadSettings(dir)).toEqual(updated)
  })

  it('rejects invalid depth, factCheck, concurrency and model fields without writing', async () => {
    const dir = await makeTempDir()
    await expect(saveSettings(dir, { depth: 'thorough' })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { factCheck: 'yes' })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { maxConcurrentWorkers: 1 })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { maxConcurrentWorkers: 9 })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { maxConcurrentWorkers: 4.5 })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { model: '' })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { model: 42 })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { reasoningEffort: ' ' })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, { provider: 42 })).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(saveSettings(dir, 'nope')).rejects.toBeInstanceOf(SettingsValidationError)
    expect(await pathExists(join(dir, 'settings.json'))).toBe(false)
  })

  it('accepts a blank provider as "use the host default model" and ignores unknown fields', async () => {
    const dir = await makeTempDir()
    const saved = await saveSettings(dir, { provider: '', unknownFutureField: true })
    expect(saved.provider).toBe('')
    expect(saved).toEqual(DEFAULT_SETTINGS)
    expect(saved).not.toHaveProperty('unknownFutureField')
  })

  it('falls back to defaults for a corrupt or invalid settings.json and can rewrite it', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'settings.json'), '{ broken', 'utf8')
    await expect(loadSettings(dir)).resolves.toEqual(DEFAULT_SETTINGS)

    await writeFile(join(dir, 'settings.json'), JSON.stringify({ depth: 'bogus' }), 'utf8')
    await expect(loadSettings(dir)).resolves.toEqual(DEFAULT_SETTINGS)

    const saved = await saveSettings(dir, { depth: 'quick' })
    expect(saved.depth).toBe('quick')
    expect(await loadSettings(dir)).toEqual(saved)
  })

  it('serializes concurrent saves so every patch is applied to the persisted settings', async () => {
    const dir = await makeTempDir()
    await Promise.all([
      saveSettings(dir, { depth: 'deep' }),
      saveSettings(dir, { factCheck: false }),
      saveSettings(dir, { maxConcurrentWorkers: 6 }),
    ])
    const final = await loadSettings(dir)
    expect(final.depth).toBe('deep')
    expect(final.factCheck).toBe(false)
    expect(final.maxConcurrentWorkers).toBe(6)
    expect(await tempFiles(dir)).toEqual([])
  })
})

describe('DocumentStore settings delegation', () => {
  it('reads the default settings and persists saved ones under the data root', async () => {
    const { dir, store } = await makeStore()
    await expect(store.getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
    const saved = await store.saveSettings({ depth: 'quick', includeHeaderFooter: true })
    expect(saved).toMatchObject({ depth: 'quick', includeHeaderFooter: true })
    expect(await store.getSettings()).toEqual(saved)
    expect(await pathExists(join(dir, 'settings.json'))).toBe(true)
  })
})

describe('resolveDataDir', () => {
  it('prefers DSH_PROFILE_DIR', async () => {
    const base = await makeTempDir()
    expect(resolveDataDir({ DSH_PROFILE_DIR: base, DSH_HOME: join(base, 'home') })).toBe(
      join(base, 'plugin-data', 'lgproofreader'),
    )
  })

  it('falls back to DSH_HOME when DSH_PROFILE_DIR is missing or blank', async () => {
    const base = await makeTempDir()
    expect(resolveDataDir({ DSH_HOME: base })).toBe(join(base, 'plugin-data', 'lgproofreader'))
    expect(resolveDataDir({ DSH_PROFILE_DIR: '   ', DSH_HOME: base })).toBe(
      join(base, 'plugin-data', 'lgproofreader'),
    )
  })

  it('falls back to ~/.dsh/plugin-data/lgproofreader when no env var is set', () => {
    expect(resolveDataDir({})).toBe(join(homedir(), '.dsh', 'plugin-data', 'lgproofreader'))
    expect(resolveDataDir({ DSH_PROFILE_DIR: '', DSH_HOME: '' })).toBe(
      join(homedir(), '.dsh', 'plugin-data', 'lgproofreader'),
    )
  })
})

describe('DocumentStore role results, meta updates and layout completeness', () => {
  function roleResultFixture(cacheKey = 'a1|master|v1|deepseek-flash|abc'): Record<string, unknown> {
    return {
      cacheKey,
      role: 'master',
      articleId: 'a1',
      findings: [{ id: 'f1', quote: '错误' }],
    }
  }

  it('persists role results under reports/<jobId>/<articleId>/<role>.json and reloads them from a fresh store', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const jobId = 'job_1763500000100'
    const value = roleResultFixture()

    await store.saveRoleResult(doc.id, jobId, 'a1', 'master', value)

    expect(
      await readJson(join(docDir(dir, doc.id), 'reports', jobId, 'a1', 'master.json')),
    ).toEqual(value)
    expect(await store.getRoleResults(doc.id, jobId, 'a1')).toEqual({ master: value })

    const evidence = { articleId: 'a1', claims: [] }
    await store.saveRoleResult(doc.id, jobId, 'a1', 'facts-evidence', evidence)
    expect(await store.getRoleResults(doc.id, jobId, 'a1')).toEqual({
      master: value,
      'facts-evidence': evidence,
    })

    const replaced = roleResultFixture('a1|master|v2|deepseek-flash|abc')
    await store.saveRoleResult(doc.id, jobId, 'a1', 'master', replaced)
    expect((await store.getRoleResults(doc.id, jobId, 'a1')).master).toEqual(replaced)

    expect(await store.getRoleResults(doc.id, jobId, 'a2')).toEqual({})
    expect(await store.getRoleResults(doc.id, 'job_9999999999999', 'a1')).toEqual({})

    const reopened = new DocumentStore(dir)
    await reopened.init()
    expect((await reopened.getRoleResults(doc.id, jobId, 'a1')).master).toEqual(replaced)
  })

  it('rejects role result ids and role names that could escape the report directory', async () => {
    const { store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const jobId = 'job_1763500000101'

    await expect(
      store.saveRoleResult('../evil', jobId, 'a1', 'master', roleResultFixture()),
    ).rejects.toBeInstanceOf(InvalidDocumentIdError)
    await expect(
      store.saveRoleResult(doc.id, '../evil', 'a1', 'master', roleResultFixture()),
    ).rejects.toBeInstanceOf(InvalidJobIdError)
    await expect(
      store.saveRoleResult(doc.id, jobId, '../a1', 'master', roleResultFixture()),
    ).rejects.toBeInstanceOf(InvalidArticleIdError)
    await expect(
      store.saveRoleResult(doc.id, jobId, 'a1', '../master', roleResultFixture()),
    ).rejects.toBeInstanceOf(InvalidRoleIdError)
    await expect(
      store.saveRoleResult(doc.id, jobId, 'a1', 'Master', roleResultFixture()),
    ).rejects.toBeInstanceOf(InvalidRoleIdError)

    expect(await store.getRoleResults('../evil', jobId, 'a1')).toEqual({})
    expect(await store.getRoleResults(doc.id, '../evil', 'a1')).toEqual({})
    expect(await store.getRoleResults(doc.id, jobId, '../a1')).toEqual({})
  })

  it('ignores corrupt role result files and unrelated files', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const jobId = 'job_1763500000102'
    const value = roleResultFixture()
    await store.saveRoleResult(doc.id, jobId, 'a1', 'master', value)

    const articleDir = join(docDir(dir, doc.id), 'reports', jobId, 'a1')
    await writeFile(join(articleDir, 'broken.json'), 'not json', 'utf8')
    await writeFile(join(articleDir, 'notes.txt'), 'ignored', 'utf8')
    await writeFile(join(articleDir, 'UPPER.json'), '{}', 'utf8')

    expect(await store.getRoleResults(doc.id, jobId, 'a1')).toEqual({ master: value })
  })

  it('updates whitelisted document meta fields and persists them', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })

    const updated = await store.updateMeta(doc.id, {
      newspaper: '文汇报',
      edition: '第14版',
      date: '2026-11-14',
    })
    expect(updated).toMatchObject({
      id: doc.id,
      newspaper: '文汇报',
      edition: '第14版',
      date: '2026-11-14',
      status: 'parsing',
    })
    expect(await readJson(join(docDir(dir, doc.id), 'meta.json'))).toEqual(updated)
    expect((await store.getDocument(doc.id))?.meta).toEqual(updated)
    expect((await store.list())[0].meta).toEqual(updated)

    const failed = await store.updateMeta(doc.id, { status: 'failed' })
    expect(failed.status).toBe('failed')
    expect((await store.getDocument(doc.id))?.meta.status).toBe('failed')

    const ignored = await store.updateMeta(doc.id, {
      status: 'parsing',
      id: 'doc_1700000000000_abcdef',
      pageCount: 5,
      fileName: '../evil.pdf',
    } as never)
    expect(ignored.id).toBe(doc.id)
    expect(ignored.pageCount).toBe(1)
    expect(ignored.fileName).toBe('page.pdf')
    expect(ignored.status).toBe('parsing')
  })

  it('rejects invalid or empty meta patches and unknown documents', async () => {
    const { store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })

    await expect(store.updateMeta(doc.id, { status: 'done' } as never)).rejects.toThrow()
    await expect(store.updateMeta(doc.id, { newspaper: 42 } as never)).rejects.toThrow()
    await expect(store.updateMeta(doc.id, { date: '14/11/2026' })).rejects.toThrow()
    await expect(store.updateMeta(doc.id, { unknownField: true } as never)).rejects.toThrow()
    await expect(
      store.updateMeta('doc_1700000000000_abcdef', { status: 'failed' }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError)
  })

  it('requires layout.json and articles.json together before a document is ready or hasLayout', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const docDirectory = docDir(dir, doc.id)

    await expect(store.updateMeta(doc.id, { status: 'ready' })).rejects.toThrow()
    await writeFile(join(docDirectory, 'layout.json'), JSON.stringify({ regions: [regionFixture()] }), 'utf8')

    expect((await store.list())[0].hasLayout).toBe(false)
    const halfRecord = await store.getDocument(doc.id)
    expect(halfRecord).not.toHaveProperty('regions')
    expect(halfRecord).not.toHaveProperty('articles')
    await expect(store.updateMeta(doc.id, { status: 'ready' })).rejects.toThrow()

    await writeFile(join(docDirectory, 'articles.json'), JSON.stringify({ articles: [articleFixture()] }), 'utf8')

    expect((await store.list())[0].hasLayout).toBe(true)
    const fullRecord = await store.getDocument(doc.id)
    expect(fullRecord?.regions).toEqual([regionFixture()])
    expect(fullRecord?.articles).toEqual([articleFixture()])
    await expect(store.updateMeta(doc.id, { status: 'ready' })).resolves.toMatchObject({
      status: 'ready',
    })
  })

  it('does not report a layout when one of the two layout files is corrupt', async () => {
    const { dir, store } = await makeStore()
    const doc = await store.create({ fileName: 'page.pdf', pdfBytes: new Uint8Array([1]) })
    const docDirectory = docDir(dir, doc.id)
    await writeFile(join(docDirectory, 'layout.json'), JSON.stringify({ regions: [regionFixture()] }), 'utf8')
    await writeFile(join(docDirectory, 'articles.json'), 'not json', 'utf8')

    expect((await store.list())[0].hasLayout).toBe(false)
    const record = await store.getDocument(doc.id)
    expect(record).not.toHaveProperty('regions')
    expect(record).not.toHaveProperty('articles')
    await expect(store.updateMeta(doc.id, { status: 'ready' })).rejects.toThrow()
  })
})

/**
 * Tests for the Host entry layer (Task 15): plugin constants and data-dir /
 * package-location resolution (`src/host/config.ts`), the exact-path
 * `connection.fetch` route table (`src/host/api/routes.ts`), the bundle manifest
 * with its locale metadata and patch, and the `apply(ctx)` wiring of
 * `src/host/index.ts`.
 *
 * Nothing here talks to a live Cordis application: the `apply` tests use a fake
 * `PluginContext` that mimics the two behaviours that matter — `connection.fetch`
 * refuses a second route on one path (as the real Connection service does) and
 * `effect()` runs its body immediately and owns the returned cleanup. The plugin
 * still uses its real store, prompt library, handlers and orchestrator, writing
 * only below a temporary profile directory; no model or network call is made.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  API_PATHS,
  API_PREFIX,
  type HandlerName,
  type MetaView,
  type ModelCatalogue,
  type PluginHandlers,
} from '../../src/shared/api/protocol'
import {
  API_PREFIX as CONFIG_API_PREFIX,
  FALLBACK_MODEL,
  FALLBACK_PLUGIN_VERSION,
  FALLBACK_PROVIDER,
  LIMITS,
  PLUGIN_ID,
  PROMPT_LOCALE,
  resolveDataDir,
  resolveModelSelection,
  resolvePackageLocation,
  resolvePromptDir,
  type AgentDefaultModelSelection,
  type SavedModelSelection,
} from '../../src/host/config'
import {
  ROUTE_TABLE,
  ROUTES_EFFECT_LABEL,
  createRoutes,
  registerRoutes,
  type ConnectionFetchRoute,
  type RouteRegistrationContext,
} from '../../src/host/api/routes'
import { loadPromptLibrary } from '../../src/host/services/prompts'
import { DEFAULT_SETTINGS } from '../../src/host/services/settings'
import type { ImageAttachmentRef } from '../../src/host/services/llm-client'
import {
  apply,
  createUnavailableWebClient,
  inject,
  type PluginContext,
} from '../../src/host/index'

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* ------------------------------------------------------------------------- */

/** Repository/package root, resolved from this test file rather than the cwd. */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))

const INDEX_MODULE_URL = new URL('../../src/host/index.ts', import.meta.url).href

const EXPECTED_ROUTE_COUNT = 17
const EXPECTED_UNIQUE_PATH_COUNT = 15
const EXPECTED_ROUTES: readonly { name: HandlerName; method: string; path: string }[] = [
  { name: 'uploadDocument', method: 'POST', path: `${API_PREFIX}/documents` },
  { name: 'pageText', method: 'POST', path: `${API_PREFIX}/page-text` },
  { name: 'pageImage', method: 'POST', path: `${API_PREFIX}/page-image` },
  { name: 'pageOverlay', method: 'POST', path: `${API_PREFIX}/page-overlay` },
  { name: 'analyze', method: 'POST', path: `${API_PREFIX}/analyze` },
  { name: 'document', method: 'GET', path: `${API_PREFIX}/document` },
  { name: 'layout', method: 'POST', path: `${API_PREFIX}/layout` },
  { name: 'pageImageGet', method: 'GET', path: `${API_PREFIX}/page-image` },
  { name: 'proofread', method: 'POST', path: `${API_PREFIX}/proofread` },
  { name: 'job', method: 'GET', path: `${API_PREFIX}/job` },
  { name: 'cancel', method: 'POST', path: `${API_PREFIX}/cancel` },
  { name: 'deleteDoc', method: 'POST', path: `${API_PREFIX}/delete` },
  { name: 'meta', method: 'GET', path: `${API_PREFIX}/meta` },
  { name: 'settingsGet', method: 'GET', path: `${API_PREFIX}/settings` },
  { name: 'settingsPost', method: 'POST', path: `${API_PREFIX}/settings` },
  { name: 'exportReport', method: 'GET', path: `${API_PREFIX}/export` },
  { name: 'health', method: 'GET', path: `${API_PREFIX}/health` },
]

interface PackageManifest {
  name: string
  version: string
  type: string
  icon?: string
  exports: Record<string, string>
  files: string[]
  engines?: { node?: string; dsh?: string }
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string; immediately?: boolean; inject?: string[] }
  }
}

let packageManifest: PackageManifest
let expectedPromptVersion: string
let basePromptText: string

beforeAll(async () => {
  packageManifest = JSON.parse(
    await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as PackageManifest
  expectedPromptVersion = (await loadPromptLibrary(join(PACKAGE_ROOT, 'prompts', 'zh'))).version
  basePromptText = await readFile(join(PACKAGE_ROOT, 'prompts', 'zh', 'base.md'), 'utf8')
})

/* ------------------------------------------------------------------------- */
/* Temporary directories / environment                                         */
/* ------------------------------------------------------------------------- */

const PROJECT_CWD = process.cwd()
const temporaryDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

/**
 * Run `task` with this process's plugin data root pointed at a temporary
 * profile directory, restoring `DSH_PROFILE_DIR`/`DSH_HOME` afterwards.
 */
async function withTemporaryProfile<T>(task: (profileDir: string) => Promise<T>): Promise<T> {
  const profileDir = await makeTempDir('lgproofreader-profile-')
  const previousProfile = process.env.DSH_PROFILE_DIR
  const previousHome = process.env.DSH_HOME
  process.env.DSH_PROFILE_DIR = profileDir
  delete process.env.DSH_HOME
  try {
    return await task(profileDir)
  } finally {
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

function pluginDataDir(profileDir: string): string {
  return join(profileDir, 'plugin-data', PLUGIN_ID)
}

/** Persist an explicit saved model selection before the plugin starts. */
async function writeSavedSettings(
  profileDir: string,
  patch: Partial<SavedModelSelection>,
): Promise<void> {
  const dataDir = pluginDataDir(profileDir)
  await mkdir(dataDir, { recursive: true })
  await writeFile(
    join(dataDir, 'settings.json'),
    JSON.stringify({ ...DEFAULT_SETTINGS, ...patch }, null, 2),
    'utf8',
  )
}

afterEach(async () => {
  process.chdir(PROJECT_CWD)
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------- */
/* Fake Cordis context for `apply(ctx)`                                        */
/* ------------------------------------------------------------------------- */

type EffectCleanup = () => void | Promise<void>

interface FakeLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

interface FakeModelProviderInfo {
  readonly id: string
  readonly name: string
}

interface FakeModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
}

interface FakeLlmService {
  stream: (...args: unknown[]) => AsyncIterable<never>
  listProviders: () => readonly FakeModelProviderInfo[]
  listModels: (provider: string) => Promise<readonly FakeModelInfo[]>
}

interface FakeAttachmentsService {
  saveImage: (input: {
    data: Uint8Array
    mediaType: 'image/png'
    name?: string
  }) => Promise<ImageAttachmentRef>
}

interface FakePluginContext extends PluginContext {
  readonly registeredRoutes: ConnectionFetchRoute[]
  readonly routeDisposers: (() => Promise<void>)[]
  readonly logs: { level: string; message: string }[]
  readonly dispose: () => Promise<void>
}

interface FakeContextOptions {
  llm?: FakeLlmService
  web?: unknown
  agentDefaultModel?: unknown
  /** 1-based registration call that throws instead of registering (rollback test). */
  failRegisterAt?: number
}

function createFakeLlm(overrides: Partial<FakeLlmService> = {}): FakeLlmService {
  return {
    stream: vi.fn(async function* emptyStream(): AsyncGenerator<never> {
      // Never consumed: `apply` only constructs clients and the orchestrator.
    }),
    listProviders: vi.fn(
      (): readonly FakeModelProviderInfo[] => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'other-provider', name: 'Other' },
      ],
    ),
    listModels: vi.fn(
      async (provider: string): Promise<readonly FakeModelInfo[]> => [
        { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
      ],
    ),
    ...overrides,
  }
}

function createFakeAttachments(): FakeAttachmentsService {
  return {
    saveImage: vi.fn(
      async (input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => {
        const ref: ImageAttachmentRef = {
          attachmentId: 'att_test',
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }
        if (input.name !== undefined) ref.name = input.name
        return ref
      },
    ),
  }
}

function formatLogMessage(args: unknown[]): string {
  return args
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
}

function createFakeContext(options: FakeContextOptions = {}): FakePluginContext {
  const registeredRoutes: ConnectionFetchRoute[] = []
  const routeDisposers: (() => Promise<void>)[] = []
  const cleanups: EffectCleanup[] = []
  const logs: { level: string; message: string }[] = []
  const llm = options.llm ?? createFakeLlm()
  const attachments = createFakeAttachments()

  const register = vi.fn((route: ConnectionFetchRoute): (() => Promise<void>) => {
    if (
      options.failRegisterAt !== undefined &&
      registeredRoutes.length + 1 === options.failRegisterAt
    ) {
      throw new Error(`injected route registration failure at ${options.failRegisterAt}`)
    }
    // Mirror the real Connection service: one exact route object per path.
    if (registeredRoutes.some((existing) => existing.path === route.path)) {
      throw new Error(
        `connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`,
      )
    }
    registeredRoutes.push(route)
    const dispose = vi.fn(async (): Promise<void> => {})
    routeDisposers.push(dispose)
    return dispose
  })

  function createLogger(): FakeLogger {
    const record = (level: string) => (...args: unknown[]) => {
      logs.push({ level, message: formatLogMessage(args) })
    }
    return {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    }
  }

  const context: FakePluginContext = {
    registeredRoutes,
    routeDisposers,
    logs,
    effect: (execute: () => EffectCleanup) => {
      const cleanup = execute()
      cleanups.push(cleanup)
      return cleanup
    },
    logger: () => createLogger(),
    get: (name: string) => {
      if (name === 'web') return options.web
      if (name === 'agentDefaultModel') return options.agentDefaultModel
      return undefined
    },
    llm,
    attachments,
    connection: { fetch: { register } },
    async dispose(): Promise<void> {
      for (const cleanup of cleanups.splice(0).reverse()) {
        if (typeof cleanup === 'function') await cleanup()
      }
    },
  }
  return context
}

function findRegisteredRoute(ctx: FakePluginContext, path: string): ConnectionFetchRoute {
  const route = ctx.registeredRoutes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  return route
}

async function requestJson(
  ctx: FakePluginContext,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await findRegisteredRoute(ctx, path).fetch(
    new Request(`http://localhost${path}`, init),
  )
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as unknown, text }
}

function makeFakeHandlers(): PluginHandlers & Record<HandlerName, ReturnType<typeof vi.fn>> {
  const handlers: Partial<Record<HandlerName, ReturnType<typeof vi.fn>>> = {}
  for (const name of Object.keys(API_PATHS) as HandlerName[]) {
    handlers[name] = vi.fn(async () => new Response(name, { status: 200 }))
  }
  return handlers as PluginHandlers & Record<HandlerName, ReturnType<typeof vi.fn>>
}

interface FakeRouteRegistrationContext extends RouteRegistrationContext {
  readonly registered: ConnectionFetchRoute[]
  readonly disposers: (() => Promise<void>)[]
  readonly effects: string[]
  readonly dispose: () => Promise<void>
}

function createFakeRegistrationContext(failRegisterAt?: number): FakeRouteRegistrationContext {
  const registered: ConnectionFetchRoute[] = []
  const disposers: (() => Promise<void>)[] = []
  const effects: string[] = []
  const cleanups: EffectCleanup[] = []
  const context: FakeRouteRegistrationContext = {
    registered,
    disposers,
    effects,
    effect: (execute: () => EffectCleanup, label?: string) => {
      effects.push(label ?? 'anonymous')
      const cleanup = execute()
      cleanups.push(cleanup)
      return cleanup
    },
    connection: {
      fetch: {
        register: (route: ConnectionFetchRoute) => {
          if (failRegisterAt !== undefined && registered.length + 1 === failRegisterAt) {
            throw new Error('injected registration failure')
          }
          if (registered.some((existing) => existing.path === route.path)) {
            throw new Error(`duplicate route ${route.path}`)
          }
          registered.push(route)
          const dispose = vi.fn(async (): Promise<void> => {})
          disposers.push(dispose)
          return dispose
        },
      },
    },
    async dispose(): Promise<void> {
      for (const cleanup of cleanups.splice(0).reverse()) {
        if (typeof cleanup === 'function') await cleanup()
      }
    },
  }
  return context
}

/* ------------------------------------------------------------------------- */
/* config.ts: constants and data-dir resolution                                */
/* ------------------------------------------------------------------------- */

describe('config: plugin constants', () => {
  it('uses the documented plugin id and api prefix', () => {
    expect(PLUGIN_ID).toBe('lgproofreader')
    expect(CONFIG_API_PREFIX).toBe('/api/lgproofreader')
    expect(CONFIG_API_PREFIX).toBe(API_PREFIX)
    expect(PROMPT_LOCALE).toBe('zh')
    expect(FALLBACK_PLUGIN_VERSION).toBe('1.1.0')
    expect(FALLBACK_PROVIDER).toBe('deepseek-official')
    expect(FALLBACK_MODEL).toBe('deepseek-flash')
  })

  it('pins the deployment limits from the design (§11.1)', () => {
    expect(LIMITS).toEqual({
      maxUploadBytes: 157_286_400,
      maxPages: 1,
      maxImageBytes: 20_971_520,
      maxJsonBytes: 20 * 1024 * 1024,
      visionDpi: 180,
      maxPageImageEdge: 2600,
    })
    expect(Object.isFrozen(LIMITS)).toBe(true)
  })
})

describe('config: resolveDataDir precedence', () => {
  it('prefers <DSH_PROFILE_DIR>/plugin-data/lgproofreader', () => {
    expect(
      resolveDataDir({
        DSH_PROFILE_DIR: 'C:/profiles/desktop',
        DSH_HOME: 'C:/dsh-home',
      } as NodeJS.ProcessEnv),
    ).toBe(resolve('C:/profiles/desktop', 'plugin-data', PLUGIN_ID))
  })

  it('falls back to <DSH_HOME>/plugin-data/lgproofreader', () => {
    expect(resolveDataDir({ DSH_HOME: 'C:/dsh-home' } as NodeJS.ProcessEnv)).toBe(
      resolve('C:/dsh-home', 'plugin-data', PLUGIN_ID),
    )
  })

  it('falls back to ~/.dsh/plugin-data/lgproofreader', () => {
    expect(resolveDataDir({} as NodeJS.ProcessEnv)).toBe(
      resolve(homedir(), '.dsh', 'plugin-data', PLUGIN_ID),
    )
  })

  it('ignores blank environment values', () => {
    expect(
      resolveDataDir({
        DSH_PROFILE_DIR: '   ',
        DSH_HOME: '\t',
      } as NodeJS.ProcessEnv),
    ).toBe(resolve(homedir(), '.dsh', 'plugin-data', PLUGIN_ID))
    expect(
      resolveDataDir({
        DSH_PROFILE_DIR: '   ',
        DSH_HOME: 'C:/dsh-home',
      } as NodeJS.ProcessEnv),
    ).toBe(resolve('C:/dsh-home', 'plugin-data', PLUGIN_ID))
  })
})

/* ------------------------------------------------------------------------- */
/* config.ts: package location and prompt directory                            */
/* ------------------------------------------------------------------------- */

describe('config: package location and prompt directory', () => {
  it('resolves the package root by walking up from the module URL', async () => {
    const location = await resolvePackageLocation(INDEX_MODULE_URL)
    expect(location.root).toBe(PACKAGE_ROOT)
    expect(location.version).toBe(packageManifest.version)
    expect(resolvePromptDir(location.root)).toBe(join(PACKAGE_ROOT, 'prompts', PROMPT_LOCALE))
    expect((await stat(resolvePromptDir(location.root))).isDirectory()).toBe(true)
  })

  it('finds a package root that is not the current working directory', async () => {
    const root = await makeTempDir('lgproofreader-package-')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'lg-proofreader', version: '9.9.9' }),
      'utf8',
    )
    await mkdir(join(root, 'lib'), { recursive: true })
    const location = await resolvePackageLocation(pathToFileURL(join(root, 'lib', 'index.js')).href)
    expect(location.root).toBe(root)
    expect(location.version).toBe('9.9.9')
    expect(resolvePromptDir(location.root)).toBe(join(root, 'prompts', 'zh'))
  })

  it('rejects a module URL with no lg-proofreader package.json above it', async () => {
    const root = await makeTempDir('lgproofreader-no-package-')
    await expect(
      resolvePackageLocation(pathToFileURL(join(root, 'lib', 'index.js')).href),
    ).rejects.toThrow(/package root/)
  })

  it('falls back to the documented version when package.json has none', async () => {
    const root = await makeTempDir('lgproofreader-no-version-')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'lg-proofreader' }), 'utf8')
    await expect(resolvePackageLocation(pathToFileURL(join(root, 'index.js')).href)).resolves.toEqual(
      { root, version: FALLBACK_PLUGIN_VERSION },
    )
  })
})

/* ------------------------------------------------------------------------- */
/* config.ts: effective model selection                                       */
/* ------------------------------------------------------------------------- */

describe('config: effective model selection', () => {
  const saved = (patch: Partial<SavedModelSelection> = {}): SavedModelSelection => ({
    provider: DEFAULT_SETTINGS.provider,
    model: DEFAULT_SETTINGS.model,
    reasoningEffort: DEFAULT_SETTINGS.reasoningEffort,
    ...patch,
  })
  const agent = (
    patch: Partial<AgentDefaultModelSelection> = {},
  ): AgentDefaultModelSelection => ({
    provider: 'deepseek-official',
    model: 'deepseek-pro',
    ...patch,
  })

  it('uses the agent default when the user has not saved a selection', () => {
    expect(resolveModelSelection(saved(), agent())).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-pro',
      reasoningEffort: 'max',
    })
  })

  it('uses a saved provider/model over the agent default', () => {
    expect(
      resolveModelSelection(
        saved({ provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'high' }),
        agent(),
      ),
    ).toEqual({ provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'high' })
  })

  it('falls back to the built-in route without agent default or saved provider', () => {
    expect(resolveModelSelection(saved(), undefined)).toEqual({
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
      reasoningEffort: 'max',
    })
    expect(resolveModelSelection(saved({ provider: '  ' }), undefined)).toEqual({
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
      reasoningEffort: 'max',
    })
  })

  it('fills a missing agent model from the built-in default', () => {
    expect(resolveModelSelection(saved(), { provider: 'deepseek-official' })).toEqual({
      provider: 'deepseek-official',
      model: FALLBACK_MODEL,
      reasoningEffort: 'max',
    })
    expect(resolveModelSelection(saved(), { model: 'deepseek-pro' })).toEqual({
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
      reasoningEffort: 'max',
    })
  })

  it('keeps a saved model when no route is known', () => {
    expect(resolveModelSelection(saved({ model: 'custom-model' }), undefined)).toEqual({
      provider: FALLBACK_PROVIDER,
      model: 'custom-model',
      reasoningEffort: 'max',
    })
  })

  it('accepts invalid persisted values defensively', () => {
    const corrupted: SavedModelSelection = { provider: '', model: '', reasoningEffort: '' }
    expect(resolveModelSelection(corrupted, undefined)).toEqual({
      provider: FALLBACK_PROVIDER,
      model: FALLBACK_MODEL,
      reasoningEffort: 'max',
    })
    expect(resolveModelSelection(corrupted, agent())).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-pro',
      reasoningEffort: 'max',
    })
  })
})

/* ------------------------------------------------------------------------- */
/* routes.ts: ROUTE_TABLE                                                      */
/* ------------------------------------------------------------------------- */

describe('routes: ROUTE_TABLE', () => {
  it('lists every exact method/path of the design (§10.2)', () => {
    expect(ROUTE_TABLE.map((row) => `${row.name} ${row.methods.join(',')} ${row.path}`)).toEqual(
      EXPECTED_ROUTES.map((route) => `${route.name} ${route.method} ${route.path}`),
    )
    expect(ROUTE_TABLE).toHaveLength(EXPECTED_ROUTE_COUNT)
    expect(new Set(ROUTE_TABLE.map((row) => row.path)).size).toBe(EXPECTED_UNIQUE_PATH_COUNT)
  })

  it('covers every handler exactly once, with the documented paths and no dynamic segment', () => {
    expect(new Set(ROUTE_TABLE.map((row) => row.name))).toEqual(
      new Set(Object.keys(API_PATHS) as HandlerName[]),
    )
    for (const row of ROUTE_TABLE) {
      expect(row.path).toBe(API_PATHS[row.name])
      expect(row.path.startsWith(`${API_PREFIX}/`)).toBe(true)
      expect(row.path).not.toMatch(/[:*]/)
      expect(row.methods.length).toBeGreaterThan(0)
      expect(row.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))).toBe(true)
    }
  })

  it('shares one /page-image path between GET and POST', () => {
    const rows = ROUTE_TABLE.filter((row) => row.path === `${API_PREFIX}/page-image`)
    expect(rows.map((row) => row.name)).toEqual(['pageImage', 'pageImageGet'])
    expect(rows[0].methods).toEqual(['POST'])
    expect(rows[1].methods).toEqual(['GET'])
  })

  it('streams only the PDF upload; every other route is buffered', () => {
    for (const row of ROUTE_TABLE) {
      expect(row.requestBody).toBe(row.name === 'uploadDocument' ? 'streaming' : 'buffered')
    }
  })
})

/* ------------------------------------------------------------------------- */
/* routes.ts: createRoutes                                                     */
/* ------------------------------------------------------------------------- */

describe('routes: createRoutes', () => {
  it('returns one connection route per unique path', () => {
    const routes = createRoutes(makeFakeHandlers())
    expect(routes).toHaveLength(EXPECTED_UNIQUE_PATH_COUNT)
    expect(new Set(routes.map((route) => route.path)).size).toBe(EXPECTED_UNIQUE_PATH_COUNT)
    for (const row of ROUTE_TABLE) {
      expect(routes.some((route) => route.path === row.path)).toBe(true)
    }
  })

  it('maps single-handler routes directly to the handler function', () => {
    const handlers = makeFakeHandlers()
    const routes = createRoutes(handlers)
    const pathCounts = new Map<string, number>()
    for (const route of EXPECTED_ROUTES) {
      pathCounts.set(route.path, (pathCounts.get(route.path) ?? 0) + 1)
    }
    const singleHandlerRows = EXPECTED_ROUTES.filter(
      (route) => pathCounts.get(route.path) === 1,
    )
    expect(singleHandlerRows).toHaveLength(EXPECTED_ROUTE_COUNT - 4)
    for (const row of singleHandlerRows) {
      const route = routes.find((candidate) => candidate.path === row.path)
      expect(route?.fetch).toBe(handlers[row.name])
      expect(route?.methods).toEqual([row.method])
    }
  })

  it('combines the shared /settings path and dispatches by method', async () => {
    const handlers = makeFakeHandlers()
    const route = createRoutes(handlers).find(
      (candidate) => candidate.path === `${API_PREFIX}/settings`,
    )
    expect(route?.methods).toEqual(['GET', 'POST'])

    await route?.fetch(new Request(`http://localhost${API_PREFIX}/settings`, { method: 'GET' }))
    await route?.fetch(new Request(`http://localhost${API_PREFIX}/settings`, { method: 'POST' }))
    expect(handlers.settingsGet).toHaveBeenCalledTimes(1)
    expect(handlers.settingsPost).toHaveBeenCalledTimes(1)
  })

  it('combines the shared /page-image path and dispatches by method', async () => {
    const handlers = makeFakeHandlers()
    const routes = createRoutes(handlers)
    const route = routes.find((candidate) => candidate.path === `${API_PREFIX}/page-image`)
    expect(route).toBeDefined()
    expect(route?.methods).toEqual(['POST', 'GET'])
    expect(route?.requestBody).toBe('buffered')

    const post = await route?.fetch(
      new Request(`http://localhost${API_PREFIX}/page-image`, { method: 'POST' }),
    )
    expect(post?.status).toBe(200)
    expect(handlers.pageImage).toHaveBeenCalledTimes(1)
    expect(handlers.pageImageGet).not.toHaveBeenCalled()

    const get = await route?.fetch(
      new Request(`http://localhost${API_PREFIX}/page-image`, { method: 'GET' }),
    )
    expect(get?.status).toBe(200)
    expect(handlers.pageImageGet).toHaveBeenCalledTimes(1)
    expect(handlers.pageImage).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown method on the combined route without calling a handler', async () => {
    const handlers = makeFakeHandlers()
    const route = createRoutes(handlers).find(
      (candidate) => candidate.path === `${API_PREFIX}/page-image`,
    )
    const response = await route?.fetch(
      new Request(`http://localhost${API_PREFIX}/page-image`, { method: 'PUT' }),
    )
    expect(response?.status).toBe(405)
    expect(handlers.pageImage).not.toHaveBeenCalled()
    expect(handlers.pageImageGet).not.toHaveBeenCalled()
  })

  it('keeps the upload route streaming and all other routes buffered', () => {
    for (const route of createRoutes(makeFakeHandlers())) {
      expect(route.requestBody).toBe(
        route.path === `${API_PREFIX}/documents` ? 'streaming' : 'buffered',
      )
    }
  })
})

/* ------------------------------------------------------------------------- */
/* routes.ts: registerRoutes                                                   */
/* ------------------------------------------------------------------------- */

describe('routes: registerRoutes', () => {
  it('registers every unique route inside one owned effect', async () => {
    const context = createFakeRegistrationContext()
    registerRoutes(context, makeFakeHandlers())

    expect(context.effects).toEqual([ROUTES_EFFECT_LABEL])
    expect(context.registered).toHaveLength(EXPECTED_UNIQUE_PATH_COUNT)
    expect(new Set(context.registered.map((route) => route.path)).size).toBe(
      EXPECTED_UNIQUE_PATH_COUNT,
    )

    await context.dispose()
    expect(context.disposers).toHaveLength(EXPECTED_UNIQUE_PATH_COUNT)
    for (const dispose of context.disposers) expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes already-registered routes when registration fails midway', () => {
    const context = createFakeRegistrationContext(3)
    expect(() => registerRoutes(context, makeFakeHandlers())).toThrow(
      /injected registration failure/,
    )
    expect(context.registered).toHaveLength(2)
    expect(context.disposers).toHaveLength(2)
    for (const dispose of context.disposers) expect(dispose).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------------- */
/* Bundle manifest, patch and locale                                           */
/* ------------------------------------------------------------------------- */

describe('bundle manifest, patch and locale', () => {
  it('declares the documented package metadata and exports', () => {
    expect(packageManifest.name).toBe('lg-proofreader')
    expect(packageManifest.version).toBe('1.1.0')
    expect(packageManifest.type).toBe('module')
    expect(packageManifest.icon).toBe('./icon.png')
    expect(packageManifest.exports['.']).toBe('./lib/index.js')
    expect(packageManifest.exports['./client']).toBe('./lib/client.js')
    expect(packageManifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(packageManifest.exports['./icon']).toBe('./icon.png')
    expect(packageManifest.exports['./package.json']).toBe('./package.json')
    expect(packageManifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(packageManifest.dsh?.client?.platform).toBe('web')
    expect(packageManifest.dsh?.client?.immediately).toBe(true)
    expect(packageManifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-locale',
    ])
    expect(packageManifest.engines?.node).toBe('>=24')
    expect(packageManifest.engines?.dsh).toBe('>=0.2.2-rc.5 <0.3.0')
    expect(packageManifest.files).toEqual(
      expect.arrayContaining([
        'lib',
        'locale',
        'prompts',
        'docs/DETAIL.md',
        'docs/DETAIL.zh.md',
        'docs/preview.svg',
        'icon.png',
        'cordis.patch.yml',
        'README.md',
        'CHANGELOG.md',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md',
      ]),
    )
    // Internal design/plan documents must never be packaged (Task 20 release).
    expect(packageManifest.files).not.toContain('docs')
    expect(packageManifest.files).not.toContain('src')
    expect(packageManifest.files).not.toContain('assets')
    expect(packageManifest.files).not.toContain('tests')
  })

  it('ships the exact Host row in cordis.patch.yml', async () => {
    const patch = await readFile(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^\s*- insert:/m)
    expect(patch).toMatch(/^\s*- id: lg-proofreader$/m)
    expect(patch).toMatch(/^\s*name: 'lg-proofreader'$/m)
    expect(patch).toMatch(/^\s*config: \{\}$/m)
  })

  it('exports the zh plugin metadata exactly', async () => {
    const locale = JSON.parse(await readFile(join(PACKAGE_ROOT, 'locale', 'zh.json'), 'utf8')) as {
      meta: { title: string; description: string; detail: string }
    }
    // The Plugin Manager detail page shows this description: it must explain the
    // capability, where the entry lives, the data boundary and the limitations
    // (plugin-details checklist), without any prompt text.
    expect(locale).toEqual({
      meta: {
        title: 'Ling Gao 校对员',
        description:
          '在左侧栏「Ling Gao 校对员」打开报纸校对工作台：上传单页报纸 PDF 后自动识别报头/报脚/头条/二条/三条与各篇文章并抽取完整文本；勾选单篇或「本页全部」并确认后，后台多个校对角色逐条给出修改建议与事实核查清单。PDF、页面图与校对报告只保存在本机 plugin-data；校对时文章文本与页面图会发送给配置的模型 provider，联网事实核查会向搜索 provider 发送事实关键词。不创建聊天会话，不展示提示词；仅支持单页 PDF，不做扫描件 OCR。',
        detail: 'docs/DETAIL.zh.md',
      },
    })
  })

  it('exports the en plugin metadata with the English display name', async () => {
    const locale = JSON.parse(await readFile(join(PACKAGE_ROOT, 'locale', 'en.json'), 'utf8')) as {
      meta: { title: string; description: string; detail: string }
    }
    expect(locale.meta.title).toBe('Ling Gao Proofreader')
    expect(locale.meta.detail).toBe('docs/DETAIL.md')
    expect(locale.meta.description.length).toBeGreaterThan(40)
  })

  it('ships a valid icon below the plugin-manager limit', async () => {
    const iconPath = join(PACKAGE_ROOT, 'icon.png')
    const info = await stat(iconPath)
    expect(info.isFile()).toBe(true)
    expect(info.size).toBeGreaterThan(0)
    expect(info.size).toBeLessThanOrEqual(256 * 1024)
    const bytes = await readFile(iconPath)
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })
})

/* ------------------------------------------------------------------------- */
/* index.ts: exports and apply()                                               */
/* ------------------------------------------------------------------------- */

describe('host entry: exports', () => {
  it('declares the required services and the apply entry point', () => {
    expect(inject).toEqual(['connection', 'llm', 'attachments'])
    expect(typeof apply).toBe('function')
  })

  it('provides a web seam that fails loudly instead of silently skipping checks', async () => {
    const web = createUnavailableWebClient()
    await expect(
      web.search({ query: 'test' }, new AbortController().signal),
    ).rejects.toThrow(/web|联网|unavailable/i)
    await expect(
      web.fetch({ url: 'https://example.com' }, new AbortController().signal),
    ).rejects.toThrow(/web|联网|unavailable/i)
  })
})

describe('host entry: apply', () => {
  const agentDefaultModel = {
    currentSelection: () => ({
      provider: 'deepseek-official',
      model: 'deepseek-pro',
      reasoningEffort: 'high',
    }),
  }

  it('registers every exact route once, serves /meta and /health, and disposes', async () => {
    await withTemporaryProfile(async (profileDir) => {
      const ctx = createFakeContext({ agentDefaultModel })
      await apply(ctx)

      // One exact route per path (the fake refuses duplicates like Connection).
      expect(ctx.registeredRoutes).toHaveLength(EXPECTED_UNIQUE_PATH_COUNT)
      expect(new Set(ctx.registeredRoutes.map((route) => route.path)).size).toBe(
        EXPECTED_UNIQUE_PATH_COUNT,
      )
      const expectedRegistered = new Map<string, string[]>()
      for (const row of EXPECTED_ROUTES) {
        const methods = expectedRegistered.get(row.path) ?? []
        methods.push(row.method)
        expectedRegistered.set(row.path, methods)
      }
      for (const route of ctx.registeredRoutes) {
        expect(expectedRegistered.get(route.path)).toEqual(route.methods)
        expect(route.requestBody).toBe(
          route.path === `${API_PREFIX}/documents` ? 'streaming' : 'buffered',
        )
      }

      const meta = await requestJson(ctx, `${API_PREFIX}/meta`)
      expect(meta.status).toBe(200)
      const view = meta.body as MetaView
      expect(view.version).toBe(packageManifest.version)
      expect(view.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-pro' })
      expect(view.promptVersion).toBe(expectedPromptVersion)
      expect(view.promptVersion).toMatch(/^[0-9a-f]{12}$/)
      expect(view.limits).toEqual({
        maxUploadBytes: LIMITS.maxUploadBytes,
        maxImageBytes: LIMITS.maxImageBytes,
        maxJsonBytes: LIMITS.maxJsonBytes,
        maxPages: 1,
      })
      expect(view.modelCatalogue).toEqual([
        {
          id: 'deepseek-official',
          title: 'DeepSeek',
          models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
        },
        {
          id: 'other-provider',
          title: 'Other',
          models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
        },
      ] satisfies ModelCatalogue)

      // Prompt text never leaves the Host: /meta carries only the version hash.
      const promptSample = basePromptText.trim().slice(0, 20)
      expect(promptSample.length).toBeGreaterThan(0)
      expect(meta.text).not.toContain(promptSample)
      expect(meta.text).not.toContain('promptText')

      const health = await requestJson(ctx, `${API_PREFIX}/health`)
      expect(health.status).toBe(200)
      expect(health.body).toEqual({ ok: true, version: packageManifest.version })

      const settings = await requestJson(ctx, `${API_PREFIX}/settings`)
      expect(settings.status).toBe(200)
      expect((settings.body as { provider: string }).provider).toBe(DEFAULT_SETTINGS.provider)

      // The plugin data root follows DSH_PROFILE_DIR.
      expect((await stat(pluginDataDir(profileDir))).isDirectory()).toBe(true)

      // Startup is logged; shutdown is not logged until dispose.
      const logText = ctx.logs.map((entry) => entry.message).join('\n')
      expect(
        ctx.logs.some((entry) => entry.level === 'info' && entry.message.includes('started')),
      ).toBe(true)
      expect(ctx.logs.some((entry) => entry.message.includes('stopped'))).toBe(false)
      // Neither the hash-only /meta response nor the log may carry prompt text.
      expect(logText).not.toContain(promptSample)

      await ctx.dispose()
      for (const dispose of ctx.routeDisposers) expect(dispose).toHaveBeenCalledTimes(1)
      expect(ctx.logs.some((entry) => entry.message.includes('stopped'))).toBe(true)
    })
  })

  it('prefers an explicit saved selection over the agent default model', async () => {
    await withTemporaryProfile(async (profileDir) => {
      await writeSavedSettings(profileDir, {
        provider: 'saved-provider',
        model: 'saved-model',
        reasoningEffort: 'high',
      })
      const ctx = createFakeContext({ agentDefaultModel })
      await apply(ctx)

      const meta = await requestJson(ctx, `${API_PREFIX}/meta`)
      expect(meta.status).toBe(200)
      expect((meta.body as MetaView).model).toEqual({
        provider: 'saved-provider',
        model: 'saved-model',
      })
      await ctx.dispose()
    })
  })

  it('starts without the optional web and agentDefaultModel services', async () => {
    await withTemporaryProfile(async () => {
      const ctx = createFakeContext({ web: undefined, agentDefaultModel: undefined })
      await apply(ctx)

      expect(ctx.registeredRoutes).toHaveLength(EXPECTED_UNIQUE_PATH_COUNT)
      const meta = await requestJson(ctx, `${API_PREFIX}/meta`)
      expect(meta.status).toBe(200)
      expect((meta.body as MetaView).model).toEqual({
        provider: FALLBACK_PROVIDER,
        model: FALLBACK_MODEL,
      })
      await ctx.dispose()
    })
  })

  it('returns an empty catalogue when the llm catalogue fails, keeping /meta usable', async () => {
    await withTemporaryProfile(async () => {
      const llm = createFakeLlm({
        listProviders: vi.fn((): readonly FakeModelProviderInfo[] => {
          throw new Error('llm service unavailable')
        }),
      })
      const ctx = createFakeContext({ llm, agentDefaultModel })
      await apply(ctx)

      const meta = await requestJson(ctx, `${API_PREFIX}/meta`)
      expect(meta.status).toBe(200)
      const view = meta.body as MetaView
      expect(view.modelCatalogue).toEqual([])
      // version/model/promptVersion/limits are still present.
      expect(view.version).toBe(packageManifest.version)
      expect(view.promptVersion).toBe(expectedPromptVersion)
      expect(view.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-pro' })
      await ctx.dispose()
    })
  })

  it('degrades a failing listModels call to that provider without models', async () => {
    await withTemporaryProfile(async () => {
      const llm = createFakeLlm({
        listModels: vi.fn(async (): Promise<readonly FakeModelInfo[]> => {
          throw new Error('model discovery failed')
        }),
      })
      const ctx = createFakeContext({ llm })
      await apply(ctx)

      const meta = await requestJson(ctx, `${API_PREFIX}/meta`)
      expect((meta.body as MetaView).modelCatalogue).toEqual([
        { id: 'deepseek-official', title: 'DeepSeek', models: [] },
        { id: 'other-provider', title: 'Other', models: [] },
      ])
      await ctx.dispose()
    })
  })

  it('loads prompts from the package directory, not the working directory', async () => {
    const emptyCwd = await makeTempDir('lgproofreader-cwd-')
    process.chdir(emptyCwd)
    try {
      await withTemporaryProfile(async () => {
        const ctx = createFakeContext({ agentDefaultModel })
        await apply(ctx)
        const meta = await requestJson(ctx, `${API_PREFIX}/meta`)
        expect((meta.body as MetaView).promptVersion).toBe(expectedPromptVersion)
        await ctx.dispose()
      })
    } finally {
      process.chdir(PROJECT_CWD)
    }
  })

  it('rolls back registered routes when route registration fails', async () => {
    await withTemporaryProfile(async () => {
      const ctx = createFakeContext({ failRegisterAt: 4 })
      await expect(apply(ctx)).rejects.toThrow(/injected route registration failure/)
      expect(ctx.registeredRoutes).toHaveLength(3)
      expect(ctx.routeDisposers).toHaveLength(3)
      for (const dispose of ctx.routeDisposers) expect(dispose).toHaveBeenCalledTimes(1)
      // The plugin only logs a startup line after a successful registration.
      expect(ctx.logs.some((entry) => entry.message.includes('started'))).toBe(false)
    })
  })
})

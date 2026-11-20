/**
 * Host entry point of the Ling Gao 校对员 (Ling Gao Proofreader) plugin
 * (Task 15; design §5, §10, §11).
 *
 * The bundle's `cordis.patch.yml` inserts this module as one Cordis plugin; the
 * Loader calls {@link apply} with the plugin `Context` and `{}` config. `apply`
 * wires the whole background service and tears it down again:
 *
 * 1. resolve the data root (`<DSH_PROFILE_DIR>` → `<DSH_HOME>` → `~/.dsh`,
 *    always `plugin-data/lgproofreader`) and open the {@link DocumentStore};
 * 2. locate the installed package from this module's own `import.meta.url` and
 *    load the shipped prompt library from `<packageRoot>/prompts/zh` (prompt
 *    text never leaves the Host);
 * 3. resolve the effective provider/model: an explicit saved settings selection
 *    wins, otherwise the DSH default model (`ctx.get('agentDefaultModel')`),
 *    otherwise the built-in `deepseek-official/deepseek-flash` route;
 * 4. create the LLM client, the optional web client, the vision layout analyzer
 *    (`saveImage` = `ctx.attachments.saveImage`) and the job orchestrator;
 * 5. create the 17 API handlers and register the exact routes through
 *    {@link registerRoutes} (one owned Cordis effect; no double registration);
 * 6. log start and, through an owned effect, log stop when the plugin unloads.
 *
 * Optional services are read with `ctx.get(…)` and never required: a deployment
 * without `web` still runs fact checking, but every network lookup fails and the
 * claims end up visibly `unverified` ("未联网核查") instead of the role being
 * silently skipped; a missing `agentDefaultModel` falls back to the configured
 * defaults. A failing model-catalogue query (`ctx.llm.listProviders()` /
 * `listModels()`) degrades to an empty `/meta` catalogue, never to a failing
 * `/meta`.
 *
 * Only Node.js built-ins and this package's own modules are imported; the Host
 * runtime has zero npm dependencies.
 */
import {
  LIMITS,
  PACKAGE_NAME,
  resolveDataDir,
  resolveModelSelection,
  resolvePackageLocation,
  resolvePromptDir,
  type AgentDefaultModelSelection,
} from './config'
import { createHandlers } from './api/handlers'
import { registerRoutes, type RouteRegistrationContext } from './api/routes'
import { createLayoutAnalyzer, type SaveImageInput } from './layout/analyzer'
import { createJobOrchestrator } from './proof/orchestrator'
import {
  createLlmClient,
  type ImageAttachmentRef,
  type LlmClientContext,
} from './services/llm-client'
import { loadPromptLibrary } from './services/prompts'
import { DocumentStore } from './services/store'
import { createWebClient, type WebClient, type WebClientContext } from './services/web-client'
import type {
  ModelCatalogue,
  ModelCatalogueModel,
  ModelCatalogueProvider,
} from '../shared/api/protocol'

/* ------------------------------------------------------------------------- */
/* Cordis context contract (structural subset)                                 */
/* ------------------------------------------------------------------------- */

/** One named Cordis logger. */
export interface PluginLogger {
  info(format: unknown, ...params: unknown[]): void
  warn(format: unknown, ...params: unknown[]): void
  error(format: unknown, ...params: unknown[]): void
  debug(format: unknown, ...params: unknown[]): void
}

/** Provider metadata returned by the DSH `llm.listProviders()` Remote method. */
export interface PluginModelProviderInfo {
  readonly id: string
  /** Display name (`LlmProviderInfo.name`), used as the catalogue title. */
  readonly name?: string
}

/** Model metadata returned by the DSH `llm.listModels(provider)` method. */
export interface PluginModelInfo {
  readonly id: string
  readonly name?: string
}

/** The `llm` service members this entry consumes. */
export type PluginLlmService = LlmClientContext['llm'] & {
  listProviders(): readonly PluginModelProviderInfo[]
  listModels(
    provider: string,
  ): PromiseLike<readonly PluginModelInfo[]> | readonly PluginModelInfo[]
}

/** The `attachments` service members this entry consumes. */
export interface PluginAttachmentsService {
  saveImage(input: SaveImageInput): Promise<ImageAttachmentRef>
}

/**
 * Structural subset of the DSH Host plugin `Context` used by {@link apply}.
 * Verified against the installed `0.2.2-rc.5` services with the Cordis
 * inspector; the Host entry has zero `@deepseek-ai/*` type dependencies.
 */
export interface PluginContext extends RouteRegistrationContext {
  logger(name?: string): PluginLogger
  get(name: string): unknown
  llm: PluginLlmService
  attachments: PluginAttachmentsService
}

/** Required services: the plugin only activates when all three are available. */
export const inject = ['connection', 'llm', 'attachments']

/* ------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Activate the Host half of the plugin: open the store, load the prompts, build
 * the background pipeline, register the exact API routes and log start/stop.
 *
 * A startup failure (unwritable data directory, missing/corrupt packaged
 * prompts) rejects so Cordis marks the plugin failed: running a proofreading
 * service without its Prompt Library would be worse than a visible failure.
 * Registered routes are rolled back by {@link registerRoutes} when registration
 * itself fails.
 */
export async function apply(ctx: PluginContext): Promise<void> {
  const log = ctx.logger(PACKAGE_NAME)

  const dataDir = resolveDataDir()
  const store = new DocumentStore(dataDir)
  await store.init()

  // Prompts come from the installed package directory, never from the cwd.
  const packageLocation = await resolvePackageLocation(import.meta.url)
  const prompts = await loadPromptLibrary(resolvePromptDir(packageLocation.root))

  const settings = await store.getSettings()
  const selection = resolveModelSelection(settings, readAgentDefaultModelSelection(ctx))
  const model = { provider: selection.provider, model: selection.model }

  const llm = createLlmClient(ctx, selection)
  // Read the optional service once: the same presence signal decides the web
  // client and the report's explicit `factCheckMode` (off/on/unavailable). A
  // malformed service (missing search/fetch) counts as unavailable, exactly
  // like `resolveWebClient` treats it.
  const webService = ctx.get('web')
  const webAvailable =
    isRecord(webService) &&
    typeof webService.search === 'function' &&
    typeof webService.fetch === 'function'
  const web = resolveWebClient(webService, selection.provider)
  const analyzer = createLayoutAnalyzer({
    llm,
    saveImage: (input) => ctx.attachments.saveImage(input),
  })
  const orchestrator = createJobOrchestrator({
    llm,
    web,
    webAvailable,
    prompts,
    store,
    analyzer,
    now: () => Date.now(),
    concurrency: settings.maxConcurrentWorkers,
    model,
    perCallTimeoutMs: settings.perCallTimeoutMs,
  })
  const handlers = createHandlers({
    store,
    orchestrator,
    limits: LIMITS,
    version: packageLocation.version,
    model,
    promptVersion: prompts.version,
    modelCatalogue: createModelCatalogueSource(ctx.llm),
  })

  registerRoutes(ctx, handlers)

  ctx.effect(
    () => () => {
      log.info('stopped (%s)', PACKAGE_NAME)
    },
    `${PACKAGE_NAME}: stop log`,
  )
  log.info(
    'started: version=%s, model=%s/%s, promptVersion=%s, dataDir=%s',
    packageLocation.version,
    model.provider,
    model.model,
    prompts.version,
    dataDir,
  )
}

/* ------------------------------------------------------------------------- */
/* Optional services                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Network seam used when the deployment has no `web` service.
 *
 * Every call fails, which the fact checker records as a failed lookup while
 * still emitting one `unverified` FactCheck per extracted claim (design §7.4:
 * the checklist is never silently empty and no claim is dropped). Returning
 * `undefined`/skipping the role would hide the missing verification, so this
 * stub deliberately throws.
 */
export function createUnavailableWebClient(): WebClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('web service unavailable: fact checking stays unverified (未联网核查)')
  }
  return { search: unavailable, fetch: unavailable }
}

function resolveWebClient(service: unknown, llmProvider: string): WebClient {
  if (
    !isRecord(service) ||
    typeof service.search !== 'function' ||
    typeof service.fetch !== 'function'
  ) {
    return createUnavailableWebClient()
  }
  return createWebClient(
    { web: service as unknown as WebClientContext['web'] },
    { llmProvider },
  )
}

/** Read the optional DSH default model selection; malformed/absent is ignored. */
function readAgentDefaultModelSelection(
  ctx: PluginContext,
): AgentDefaultModelSelection | undefined {
  const service = ctx.get('agentDefaultModel')
  if (!isRecord(service) || typeof service.currentSelection !== 'function') return undefined
  try {
    const value: unknown = (service.currentSelection as () => unknown)()
    if (!isRecord(value)) return undefined
    const selection: AgentDefaultModelSelection = {}
    if (typeof value.provider === 'string') selection.provider = value.provider
    if (typeof value.model === 'string') selection.model = value.model
    if (typeof value.reasoningEffort === 'string') {
      selection.reasoningEffort = value.reasoningEffort
    }
    return selection
  } catch {
    // An unavailable default model only means the built-in fallback route.
    return undefined
  }
}

/* ------------------------------------------------------------------------- */
/* `/meta` model catalogue                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Lazy provider/model catalogue source for `/meta` (design §11.2).
 *
 * The catalogue is read only when `/meta` is requested, so a slow or broken
 * provider discovery never delays activation. Failures degrade instead of
 * propagating: a failing `listProviders()` yields an empty catalogue, a failing
 * `listModels()` leaves that provider without models, and only provider
 * `id`/`name` (mapped to the wire `title`) plus model `id`/`name` are copied out
 * — credentials, endpoints and pricing internals never reach the browser.
 */
function createModelCatalogueSource(llm: PluginLlmService): () => Promise<ModelCatalogue> {
  return async () => {
    try {
      const providers = llm.listProviders()
      if (!Array.isArray(providers)) return []
      const catalogue: ModelCatalogueProvider[] = []
      for (const provider of providers as readonly unknown[]) {
        if (!isRecord(provider)) continue
        const id = readCatalogText(provider.id)
        if (id === '') continue
        const entry: ModelCatalogueProvider = { id, models: [] }
        const title = readCatalogText(provider.name)
        if (title !== '') entry.title = title
        try {
          const models = await llm.listModels(id)
          if (Array.isArray(models)) {
            for (const model of models as readonly unknown[]) {
              if (!isRecord(model)) continue
              const modelId = readCatalogText(model.id)
              if (modelId === '') continue
              const option: ModelCatalogueModel = { id: modelId }
              const name = readCatalogText(model.name)
              if (name !== '') option.name = name
              entry.models.push(option)
            }
          }
        } catch {
          // One provider's discovery failure must not hide the other providers.
        }
        catalogue.push(entry)
      }
      return catalogue
    } catch {
      // `/meta` must still answer version/model/promptVersion/limits.
      return []
    }
  }
}

function readCatalogText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Host entry configuration for the Ling Gao 校对员 (Ling Gao Proofreader) plugin
 * (Task 15; design §11.1, §12.2).
 *
 * This module owns the constants and pure resolution helpers the Host entry
 * (`src/host/index.ts`) needs before any service is wired:
 *
 * - plugin/package identity (`PLUGIN_ID`, `PACKAGE_NAME`) and the shared
 *   `/api/lgproofreader` prefix (re-exported from the shared protocol so the two
 *   declarations cannot drift);
 * - the deployment limits of design §11.1, frozen so a handler cannot mutate
 *   them at runtime;
 * - the data-root chain `<DSH_PROFILE_DIR>` → `<DSH_HOME>` → `~/.dsh` (delegated
 *   to the settings module that already implements and tests the same chain);
 * - the installed package directory and prompt directory, resolved by walking up
 *   from this module's own `import.meta.url` (never from the process cwd), which
 *   works both for `src/host/index.ts` (development/tests) and for the bundled
 *   `lib/index.js` of an installed package;
 * - the effective provider/model selection: an explicit user selection saved in
 *   `settings.json` wins, otherwise the DSH default model (`agentDefaultModel`)
 *   is used, otherwise the built-in default route.
 *
 * Node.js built-ins only; this module is Host-only and must never be imported by
 * Client code.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------------- */
/* Identity                                                                    */
/* ------------------------------------------------------------------------- */

/** npm package name of the bundle (must match `package.json` `name`). */
export const PACKAGE_NAME = 'lg-proofreader'

/** Panel/data id (design §1.4): data dir `plugin-data/lgproofreader/`, panel id `lgproofreader`. */
export const PLUGIN_ID = 'lgproofreader'

/**
 * Prefix of every Host API route. Re-exported from the shared protocol so the
 * entry constant, the route table and the Client can never drift apart.
 */
export { API_PREFIX } from '../shared/api/protocol'

/** Locale of the shipped prompt set (`prompts/zh/`, design §8.1). */
export const PROMPT_LOCALE = 'zh'

/* ------------------------------------------------------------------------- */
/* Defaults and limits                                                         */
/* ------------------------------------------------------------------------- */

/** Version reported by `/meta`/`/health` when `package.json` has no version. */
export const FALLBACK_PLUGIN_VERSION = '0.1.0'

/** Built-in model route used when neither settings nor `agentDefaultModel` decide one. */
export const FALLBACK_PROVIDER = 'deepseek-official'
export const FALLBACK_MODEL = 'deepseek-flash'
export const FALLBACK_REASONING_EFFORT = 'max'

/** Deployment limits (design §11.1; `maxJsonBytes` is the Task 14 handler default). */
export interface PluginLimits {
  readonly maxUploadBytes: number
  readonly maxPages: number
  readonly maxImageBytes: number
  readonly maxJsonBytes: number
  readonly visionDpi: number
  readonly maxPageImageEdge: number
}

export const LIMITS: PluginLimits = Object.freeze({
  maxUploadBytes: 157_286_400,
  maxPages: 1,
  maxImageBytes: 20_971_520,
  maxJsonBytes: 20 * 1024 * 1024,
  visionDpi: 180,
  maxPageImageEdge: 2600,
})

/* ------------------------------------------------------------------------- */
/* Effective model selection                                                   */
/* ------------------------------------------------------------------------- */

/** Persisted user selection (design §11.2); `provider` is `''` until the user saves one. */
export interface SavedModelSelection {
  provider: string
  model: string
  reasoningEffort: string
}

/** Subset of the DSH `agentDefaultModel.currentSelection()` result this entry uses. */
export interface AgentDefaultModelSelection {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** Provider/model/reasoning effort the plugin actually calls (fixed at activation). */
export interface EffectiveModelSelection {
  provider: string
  model: string
  reasoningEffort: string
}

/**
 * Resolve the effective model route.
 *
 * An explicit saved provider wins as a complete route (its model must not be
 * silently replaced by another provider's model). While no provider has been
 * saved, the DSH default selection (`agentDefaultModel`) decides both provider
 * and model; the plugin's persisted model is only used when no DSH default
 * exists, because `DEFAULT_SETTINGS.model` is a default rather than a user
 * choice. Every blank/malformed piece falls back to the documented defaults.
 */
export function resolveModelSelection(
  saved: SavedModelSelection,
  agentDefault?: AgentDefaultModelSelection,
): EffectiveModelSelection {
  const savedProvider = readText(saved?.provider)
  const savedModel = readText(saved?.model)
  const reasoningEffort = readText(saved?.reasoningEffort) || FALLBACK_REASONING_EFFORT

  if (savedProvider !== '') {
    return { provider: savedProvider, model: savedModel || FALLBACK_MODEL, reasoningEffort }
  }

  const agentProvider = readText(agentDefault?.provider)
  const agentModel = readText(agentDefault?.model)
  if (agentProvider !== '') {
    return { provider: agentProvider, model: agentModel || FALLBACK_MODEL, reasoningEffort }
  }

  return { provider: FALLBACK_PROVIDER, model: savedModel || FALLBACK_MODEL, reasoningEffort }
}

/* ------------------------------------------------------------------------- */
/* Package and prompt directory                                                */
/* ------------------------------------------------------------------------- */

/** Absolute package root plus the version declared by its manifest. */
export interface PackageLocation {
  root: string
  version: string
}

/**
 * Locate the installed package root from a module URL.
 *
 * Walks up from the module file and returns the first directory whose
 * `package.json` declares {@link PACKAGE_NAME}. Using `import.meta.url` means the
 * lookup is independent of `process.cwd()` and works for both the source tree
 * (`src/host/index.ts` → package root) and the bundled plugin
 * (`lib/index.js` → package root).
 *
 * @throws {Error} when no manifest for this package exists above the module.
 */
export async function resolvePackageLocation(
  moduleUrl: string = import.meta.url,
): Promise<PackageLocation> {
  if (typeof moduleUrl !== 'string' || moduleUrl.trim() === '') {
    throw new TypeError('resolvePackageLocation() requires a module URL')
  }
  const startDir = dirname(fileURLToPath(moduleUrl))
  let directory = startDir
  for (;;) {
    const manifest = await readPackageJson(join(directory, 'package.json'))
    if (manifest?.name === PACKAGE_NAME) {
      return { root: directory, version: readText(manifest.version) || FALLBACK_PLUGIN_VERSION }
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`cannot locate the ${PACKAGE_NAME} package root above ${startDir}`)
    }
    directory = parent
  }
}

/** Absolute shipped prompt directory (`<packageRoot>/prompts/<locale>`). */
export function resolvePromptDir(
  packageRoot: string,
  locale: string = PROMPT_LOCALE,
): string {
  return join(packageRoot, 'prompts', locale)
}

/* ------------------------------------------------------------------------- */
/* Data directory                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the plugin data root:
 * `<DSH_PROFILE_DIR>/plugin-data/lgproofreader`, then
 * `<DSH_HOME>/plugin-data/lgproofreader`, then
 * `~/.dsh/plugin-data/lgproofreader`.
 *
 * Implemented (and unit-tested) by the settings module that owns the same
 * directory; re-exported here so the entry point imports one config surface.
 */
export { resolveDataDir } from './services/settings'

/* ------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* ------------------------------------------------------------------------- */

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and parse one package.json manifest; a missing/corrupt file is absent. */
async function readPackageJson(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

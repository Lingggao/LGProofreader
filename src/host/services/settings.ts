/**
 * Host-side persistence plumbing for the Ling Gao 校对员 plugin.
 *
 * This module owns three things:
 * 1. the user settings written to `plugin-data/lgproofreader/settings.json`
 *    (design §11.2), including defaults and validation;
 * 2. the data-root resolution used by the Host entry point
 *    (`<DSH_PROFILE_DIR>` → `<DSH_HOME>` → `~/.dsh`);
 * 3. the shared atomic-write helper (`temp file + rename`) used by both the
 *    settings store and the document store, so a crash can never leave a
 *    half-written JSON file behind.
 *
 * Only Node.js built-ins are used; the module is Host-only (never bundled into
 * the Client).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Depth } from '../../shared/types'

/** Plugin data directory name below `<profile|home>/plugin-data/`. */
export const PLUGIN_DATA_DIR_NAME = 'lgproofreader'

/** Settings file name inside the plugin data directory. */
export const SETTINGS_FILE_NAME = 'settings.json'

/**
 * User preferences persisted in `settings.json` (design §11.2).
 *
 * `provider` is the empty string until the Host fills it from
 * `agentDefaultModel.currentSelection()`; a blank provider therefore means
 * "use the Host default model" and is accepted on save.
 */
export interface Settings {
  provider: string
  model: string
  /**
   * Activation-level reasoning effort; the fallback for any model request that
   * does not set its own.
   *
   * Task 25 (intentional): every plugin call site now sends a per-request
   * `reasoningEffort` override (all roles and the vision analyzer use the
   * provider-supported `high`, while the brief's `medium` is unavailable on
   * `deepseek-official`), so this persisted value no longer changes the
   * proofreading requests in practice. It is kept for the contract/API and as
   * the fallback for future requests without an override.
   */
  reasoningEffort: string
  depth: Depth
  /** Network fact-checking. It runs at every depth; only the network part is optional. */
  factCheck: boolean
  maxConcurrentWorkers: number
  perCallTimeoutMs: number
  maxClaimsPerArticle: number
  maxSearchQueriesPerArticle: number
  searchResultsPerClaim: number
  fetchPagesPerClaim: number
  includeHeaderFooter: boolean
}

/** Defaults from design §11.2. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  provider: '',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  depth: 'standard',
  factCheck: true,
  maxConcurrentWorkers: 4,
  // Task 21d: 300 s general role bound (the facts role gets a longer 600 s
  // bound in the orchestrator because it extracts claims and runs web searches).
  perCallTimeoutMs: 300_000,
  maxClaimsPerArticle: 16,
  maxSearchQueriesPerArticle: 24,
  searchResultsPerClaim: 5,
  fetchPagesPerClaim: 2,
  includeHeaderFooter: false,
})

/** Raised for an invalid settings patch or settings file value. */
export class SettingsValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'SettingsValidationError'
    this.field = field
  }
}

/**
 * Resolve the plugin data root:
 * `<DSH_PROFILE_DIR>/plugin-data/lgproofreader`, falling back to
 * `<DSH_HOME>/plugin-data/lgproofreader`, then
 * `~/.dsh/plugin-data/lgproofreader`.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const profileDir = env.DSH_PROFILE_DIR?.trim()
  if (profileDir) return resolve(profileDir, 'plugin-data', PLUGIN_DATA_DIR_NAME)
  const dshHome = env.DSH_HOME?.trim()
  if (dshHome) return resolve(dshHome, 'plugin-data', PLUGIN_DATA_DIR_NAME)
  return resolve(homedir(), '.dsh', 'plugin-data', PLUGIN_DATA_DIR_NAME)
}

/**
 * Write a file atomically: the bytes go to a temporary file in the target
 * directory first and are then renamed over the destination. `rename` is
 * atomic within one filesystem, so readers see either the old or the new file,
 * never a truncated one. The temporary file is removed on failure.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`,
  )
  try {
    await writeFile(tempPath, data)
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Read and validate `settings.json`.
 *
 * Missing, unreadable or unparsable files fall back to {@link DEFAULT_SETTINGS}.
 * Valid fields in an otherwise damaged file are kept and invalid fields fall
 * back to their default, so one bad value cannot wipe the other preferences.
 */
export async function loadSettings(dataDir: string): Promise<Settings> {
  let raw: string
  try {
    raw = await readFile(join(dataDir, SETTINGS_FILE_NAME), 'utf8')
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS }
  return applySettings({ ...DEFAULT_SETTINGS }, parsed).settings
}

/**
 * Validate a patch, merge it over the currently persisted settings and write
 * the result atomically. Concurrent calls are serialized per settings file so
 * no update is lost. Returns the full persisted settings.
 *
 * @throws {SettingsValidationError} when a known field has an invalid value.
 */
export async function saveSettings(dataDir: string, input: unknown): Promise<Settings> {
  const filePath = join(dataDir, SETTINGS_FILE_NAME)
  return serializeWrite(filePath, async () => {
    if (!isRecord(input)) {
      throw new SettingsValidationError('settings', 'settings patch must be a JSON object')
    }
    const current = await loadSettings(dataDir)
    const { settings, errors } = applySettings(current, input)
    if (errors.length > 0) throw errors[0]
    await writeFileAtomic(filePath, JSON.stringify(settings, null, 2))
    return settings
  })
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                  */
/* ------------------------------------------------------------------------- */

const DEPTHS: readonly Depth[] = ['quick', 'standard', 'deep']

type SettingsReader<K extends keyof Settings> = () => Settings[K]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function applySettings(
  base: Settings,
  input: Record<string, unknown>,
): { settings: Settings; errors: SettingsValidationError[] } {
  const settings: Settings = { ...base }
  const errors: SettingsValidationError[] = []

  const apply = <K extends keyof Settings>(field: K, read: SettingsReader<K>): void => {
    if (!(field in input)) return
    try {
      settings[field] = read()
    } catch (error) {
      if (error instanceof SettingsValidationError) errors.push(error)
      else throw error
    }
  }

  apply('provider', () => readProvider(input.provider))
  apply('model', () => readText('model', input.model, 200))
  apply('reasoningEffort', () => readText('reasoningEffort', input.reasoningEffort, 100))
  apply('depth', () => readDepth(input.depth))
  apply('factCheck', () => readBoolean('factCheck', input.factCheck))
  apply('maxConcurrentWorkers', () =>
    readInteger('maxConcurrentWorkers', input.maxConcurrentWorkers, 2, 8),
  )
  apply('perCallTimeoutMs', () => readInteger('perCallTimeoutMs', input.perCallTimeoutMs, 1_000, 1_800_000))
  apply('maxClaimsPerArticle', () => readInteger('maxClaimsPerArticle', input.maxClaimsPerArticle, 1, 128))
  apply('maxSearchQueriesPerArticle', () =>
    readInteger('maxSearchQueriesPerArticle', input.maxSearchQueriesPerArticle, 1, 256),
  )
  apply('searchResultsPerClaim', () => readInteger('searchResultsPerClaim', input.searchResultsPerClaim, 1, 20))
  apply('fetchPagesPerClaim', () => readInteger('fetchPagesPerClaim', input.fetchPagesPerClaim, 0, 10))
  apply('includeHeaderFooter', () => readBoolean('includeHeaderFooter', input.includeHeaderFooter))

  return { settings, errors }
}

function readProvider(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SettingsValidationError('provider', 'provider must be a string')
  }
  return value.trim()
}

function readText(field: string, value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new SettingsValidationError(field, `${field} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new SettingsValidationError(field, `${field} must not be empty`)
  }
  if (trimmed.length > maxLength) {
    throw new SettingsValidationError(field, `${field} must be at most ${maxLength} characters`)
  }
  return trimmed
}

function readDepth(value: unknown): Depth {
  if (typeof value === 'string' && (DEPTHS as readonly string[]).includes(value)) {
    return value as Depth
  }
  throw new SettingsValidationError('depth', 'depth must be one of quick, standard, deep')
}

function readBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new SettingsValidationError(field, `${field} must be a boolean`)
  }
  return value
}

function readInteger(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsValidationError(field, `${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

/* ------------------------------------------------------------------------- */
/* Serialized writes                                                           */
/* ------------------------------------------------------------------------- */

const writeQueues = new Map<string, Promise<void>>()

/**
 * Run `task` after every previously queued task for `key` settled. A failed
 * task does not block the queue (the next task still runs).
 */
function serializeWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(key, tail)
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key)
  })
  return run
}

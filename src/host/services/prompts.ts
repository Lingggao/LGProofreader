/**
 * Host-only prompt library for the Ling Gao 校对员 (Ling Gao Proofreader) plugin.
 *
 * The prompt set lives in `prompts/<locale>/` (design §8). The Host reads it
 * with {@link loadPromptLibrary} at startup and keeps the frozen result. This
 * module composes the files into model messages and computes their content hash;
 * it never sends prompt text anywhere else:
 *
 * - prompt text is returned only to Host callers that build LLM requests;
 * - no API response, Client bundle, report or log may contain it (design §8.1);
 * - only the 12-hex `version` hash is allowed to leave the Host (report/job
 *   bookkeeping, cache keys).
 *
 * Composition (design §7.2/§8.2):
 *
 * ```text
 * system = rules.md                      (all shared hard rules)
 *        + base.md                       (master only: the user's verbatim prompt)
 *        + roles/<role>.md               (role-specific responsibility)
 * user   = <article> title/subtitle/byline/body </article>
 *        + <context> newspaper/date/edition </context>
 * ```
 *
 * Node.js built-ins only; the module is Host-only and must never be imported by
 * Client code.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Article, PromptLibrary, RoleId } from '../../shared/types'

/**
 * All background proofreading roles, in the order used by the depth presets.
 * Every id has a `prompts/<locale>/roles/<id>.md` file.
 */
export const PROMPT_ROLE_IDS: readonly RoleId[] = Object.freeze([
  'master',
  'words',
  'idioms',
  'style',
  'facts',
  'headline',
  'consistency',
  'consolidator',
])

/** Required JSON Schemas under `contracts/`; they document the model output. */
export const PROMPT_CONTRACT_FILES: readonly string[] = Object.freeze([
  'findings.schema.json',
  'claims.schema.json',
  'factchecks.schema.json',
  'layout.schema.json',
])

/** Raised when the prompt directory is missing a file, unreadable or invalid. */
export class PromptLibraryError extends Error {
  /** Absolute or relative path of the offending file, when known. */
  readonly filePath?: string

  constructor(message: string, filePath?: string) {
    super(message)
    this.name = 'PromptLibraryError'
    this.filePath = filePath
  }
}

/** Raised by `compose()` for a role that has no prompt file. */
export class UnknownPromptRoleError extends PromptLibraryError {
  readonly role: string

  constructor(role: string) {
    super(`unknown prompt role ${JSON.stringify(role)}; available roles: ${PROMPT_ROLE_IDS.join(', ')}`)
    this.name = 'UnknownPromptRoleError'
    this.role = role
  }
}

/**
 * Read the whole prompt directory, validate that every required file exists and
 * the contracts parse, then return a frozen {@link PromptLibrary}.
 *
 * `dir` may be absolute or relative to the current working directory. The
 * version hash covers **every file** under `dir` (sorted by relative POSIX
 * path), so even a README edit invalidates the prompt cache rather than leaving
 * stale prompt text behind.
 *
 * @throws {PromptLibraryError} when the directory is empty/unreadable, a
 *   required prompt file is missing or empty, or a contract is not a JSON
 *   object.
 */
export async function loadPromptLibrary(dir: string): Promise<PromptLibrary> {
  const root = resolve(dir)
  const files = await readPromptFiles(root)
  if (files.size === 0) {
    throw new PromptLibraryError(`prompt directory contains no files: ${root}`, root)
  }

  const readRequired = (relPath: string): string => {
    const text = files.get(relPath)
    if (text === undefined) {
      throw new PromptLibraryError(`missing prompt file "${relPath}" in ${root}`, join(root, relPath))
    }
    if (text.trim() === '') {
      throw new PromptLibraryError(`prompt file "${relPath}" is empty in ${root}`, join(root, relPath))
    }
    return text
  }

  const base = readRequired('base.md')
  const rules = readRequired('rules.md')

  const roleTexts = new Map<RoleId, string>()
  for (const role of PROMPT_ROLE_IDS) {
    roleTexts.set(role, readRequired(`roles/${role}.md`))
  }

  for (const contract of PROMPT_CONTRACT_FILES) {
    readRequired(`contracts/${contract}`)
  }
  // Every contract under `contracts/` (including a future layout schema) must be
  // valid JSON so the prompt set cannot silently contain a broken schema.
  for (const [relPath, text] of files) {
    if (relPath.startsWith('contracts/') && relPath.endsWith('.json')) {
      assertContract(relPath.slice('contracts/'.length), text, root)
    }
  }

  const systems = new Map<RoleId, string>()
  for (const role of PROMPT_ROLE_IDS) {
    const sections = [rules.trimEnd()]
    // The master role owns the user's complete original prompt; all other roles
    // receive only the extracted shared rules (design §7.2).
    if (role === 'master') sections.push(base.trimEnd())
    sections.push((roleTexts.get(role) as string).trimEnd())
    systems.set(role, sections.join('\n\n---\n\n'))
  }

  const roles = Object.freeze([...PROMPT_ROLE_IDS])
  const version = computeVersion(files)

  return Object.freeze({
    version,
    roles,
    compose(role: RoleId, input: { article: Article; context: string }): { system: string; user: string } {
      const system = systems.get(role)
      if (system === undefined) throw new UnknownPromptRoleError(String(role))
      return { system, user: renderUserMessage(input.article, input.context) }
    },
  })
}

/* ------------------------------------------------------------------------- */
/* Internals                                                                   */
/* ------------------------------------------------------------------------- */

/** Recursively list files below `dir` as sorted POSIX-style relative paths. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(dir, entry.name), relPath)))
    } else if (entry.isFile()) {
      files.push(relPath)
    }
  }
  return files
}

/** Read every file below `root` into a `path → text` map (sorted by path). */
async function readPromptFiles(root: string): Promise<Map<string, string>> {
  let relPaths: string[]
  try {
    relPaths = (await listFiles(root)).sort()
  } catch (error) {
    throw new PromptLibraryError(`cannot read prompt directory ${root}: ${errorMessage(error)}`, root)
  }
  const files = new Map<string, string>()
  for (const relPath of relPaths) {
    try {
      files.set(relPath, await readFile(join(root, ...relPath.split('/')), 'utf8'))
    } catch (error) {
      throw new PromptLibraryError(
        `cannot read prompt file "${relPath}" in ${root}: ${errorMessage(error)}`,
        join(root, ...relPath.split('/')),
      )
    }
  }
  return files
}

/** Content hash of the prompt set: SHA-256 over `path\0content\0` pairs, 12 hex. */
function computeVersion(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256')
  for (const relPath of [...files.keys()].sort()) {
    hash.update(relPath, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(files.get(relPath) as string, 'utf8')
    hash.update('\0', 'utf8')
  }
  return hash.digest('hex').slice(0, 12)
}

/** Parse one contract file and require an object-rooted JSON Schema. */
function assertContract(relPath: string, text: string, root: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new PromptLibraryError(
      `contract "contracts/${relPath}" is not valid JSON in ${root}: ${errorMessage(error)}`,
      join(root, 'contracts', relPath),
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PromptLibraryError(
      `contract "contracts/${relPath}" must be an object-rooted JSON Schema in ${root}`,
      join(root, 'contracts', relPath),
    )
  }
}

/** Render the user message: data only, wrapped in explicit data tags. */
function renderUserMessage(article: Article, context: string): string {
  const lines: string[] = ['<article>', `<title>${article.title}</title>`]
  if (article.subtitle !== undefined && article.subtitle.trim() !== '') {
    lines.push(`<subtitle>${article.subtitle}</subtitle>`)
  }
  if (article.byline !== undefined && article.byline.trim() !== '') {
    lines.push(`<byline>${article.byline}</byline>`)
  }
  lines.push('<body>', article.body, '</body>', '</article>', '', '<context>', context, '</context>')
  return lines.join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

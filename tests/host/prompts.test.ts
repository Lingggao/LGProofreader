import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Article, RoleId } from '../../src/shared/types'
import {
  PROMPT_ROLE_IDS,
  PromptLibraryError,
  UnknownPromptRoleError,
  loadPromptLibrary,
} from '../../src/host/services/prompts'

/**
 * The real prompt library shipped with the plugin. Resolved from this test file
 * (not from the process cwd) so the suite can run from any working directory.
 */
const PROMPT_DIR = fileURLToPath(new URL('../../prompts/zh', import.meta.url))

const EXPECTED_ROLES: readonly RoleId[] = [
  'master',
  'words',
  'idioms',
  'style',
  'facts',
  'headline',
  'consistency',
  'consolidator',
]

/** The user's original proofreading prompt, quoted verbatim from spec §18. */
const BASE_PROMPT =
  '请担任新闻校对员。我会发给你一篇文章，请进行校对。找出 1. 错字、别字 2. 引号括号书名号等标点不配对 3. 词语 / 成语错字或误用 4. 事实错误 5. 语法错误。(要求：任务是校对而非润色，请尊重原文，可改可不改的地方不改，如表达啰嗦等问题不改) 不要直接将修改后的文章发给我，而是一项项列出申请修改哪里、怎样修改。文章内容从报纸 PDF 文档中复制而来，请自行去除 \\n 等换行与截断，无需列为错误。注意：如需进行事实核查，请自行安排联网搜索，无需询问用户。一般情况下，日期时间、人名 (及职务)、公司 / 机构名、地名、书名 (及书中人物与情节)、活动名等应重点联网核查。它们在同一篇文章中多次出现时，应处处统一。在输出的结尾部分需剔除无关内容，单独总结一遍必须修改的条目，并在建议改动的位置善用加粗。'

const CONTEXT = '文汇报 2026-11-14 第14版'

const tempDirs: string[] = []

function articleFixture(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    page: 1,
    role: 'normal',
    title: 'T',
    body: 'B',
    regionIds: [],
    readingOrder: 1,
    confidence: 1,
    warnings: [],
    ...overrides,
  }
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lgp-prompts-'))
  tempDirs.push(dir)
  return dir
}

/** Copy the shipped prompt directory to a temp location so tests can mutate it. */
async function copyPromptDir(): Promise<string> {
  const dir = join(await makeTempDir(), 'zh')
  await cp(PROMPT_DIR, dir, { recursive: true })
  return dir
}

async function promptFile(...parts: string[]): Promise<string> {
  return readFile(join(PROMPT_DIR, ...parts), 'utf8')
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('loadPromptLibrary', () => {
  it('loads all eight roles and exposes a stable 12-hex content version', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    expect(library.roles).toEqual(EXPECTED_ROLES)
    expect(PROMPT_ROLE_IDS).toEqual(EXPECTED_ROLES)
    expect(library.version).toMatch(/^[0-9a-f]{12}$/)

    const reloaded = await loadPromptLibrary(PROMPT_DIR)
    expect(reloaded.version).toBe(library.version)
  })

  it('composes shared rules plus the verbatim user prompt into the master system prompt', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    const rules = (await promptFile('rules.md')).trim()
    const base = (await promptFile('base.md')).trim()
    const master = (await promptFile('roles', 'master.md')).trim()

    expect(base).toBe(BASE_PROMPT.trim())

    const prompt = library.compose('master', { article: articleFixture(), context: CONTEXT })
    expect(prompt.system).toContain('校对而非润色')
    expect(prompt.system).toContain(rules)
    expect(prompt.system).toContain(base)
    expect(prompt.system.trim().endsWith(master)).toBe(true)
    expect(prompt.user.startsWith('<article>')).toBe(true)
  })

  it('gives every role the shared rules and its own role prompt, with no cross-role leakage', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    const rules = (await promptFile('rules.md')).trim()
    const base = (await promptFile('base.md')).trim()
    const systems = new Set<string>()

    for (const role of EXPECTED_ROLES) {
      const roleText = (await promptFile('roles', `${role}.md`)).trim()
      const prompt = library.compose(role, { article: articleFixture(), context: CONTEXT })
      expect(prompt.system).toContain(rules)
      expect(prompt.system.trim().endsWith(roleText)).toBe(true)
      expect(prompt.user).not.toContain(rules)
      // The full user prompt is the master's job only; other roles get the
      // extracted rules instead of the original paragraph.
      if (role !== 'master') expect(prompt.system).not.toContain('请担任新闻校对员')
      systems.add(prompt.system)
    }
    expect(systems.size).toBe(EXPECTED_ROLES.length)
    expect(library.compose('master', { article: articleFixture(), context: CONTEXT }).system).toContain(base)
    expect(Object.keys(library.compose('master', { article: articleFixture(), context: CONTEXT }))).toEqual([
      'system',
      'user',
    ])
  })

  it('points every role at the output contract it must follow', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    for (const role of EXPECTED_ROLES) {
      const system = library.compose(role, { article: articleFixture(), context: CONTEXT }).system
      if (role === 'facts') {
        expect(system).toContain('claims.schema.json')
        expect(system).toContain('factchecks.schema.json')
      } else {
        expect(system).toContain('findings.schema.json')
      }
    }
  })

  it('wraps the article title, subtitle, byline and body in <article> and the context in <context>', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    const article = articleFixture({
      title: '本报记者获表彰',
      subtitle: '连续三年获奖',
      byline: '本报记者 李明',
      body: '第一段内容。\n\n第二段内容。',
    })

    const prompt = library.compose('headline', { article, context: CONTEXT })
    expect(prompt.user).toContain('<article>')
    expect(prompt.user).toContain('<title>本报记者获表彰</title>')
    expect(prompt.user).toContain('<subtitle>连续三年获奖</subtitle>')
    expect(prompt.user).toContain('<byline>本报记者 李明</byline>')
    expect(prompt.user).toContain('第一段内容。\n\n第二段内容。')
    expect(prompt.user).toContain(`<context>\n${CONTEXT}\n</context>`)
    expect(prompt.user.trimEnd().endsWith('</context>')).toBe(true)

    const titleAt = prompt.user.indexOf('<title>')
    const bylineAt = prompt.user.indexOf('<byline>')
    const bodyAt = prompt.user.indexOf('<body>')
    const articleEndAt = prompt.user.indexOf('</article>')
    const contextAt = prompt.user.indexOf('<context>')
    expect(titleAt).toBeGreaterThanOrEqual(0)
    expect(titleAt).toBeLessThan(bylineAt)
    expect(bylineAt).toBeLessThan(bodyAt)
    expect(bodyAt).toBeLessThan(articleEndAt)
    expect(articleEndAt).toBeLessThan(contextAt)

    // Prompt text belongs to the system message; the user message is data only.
    expect(prompt.system).not.toContain(CONTEXT)
    expect(prompt.user).not.toContain('校对而非润色')
  })

  it('omits subtitle and byline tags when the article has none', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    const prompt = library.compose('words', { article: articleFixture(), context: CONTEXT })
    expect(prompt.user).not.toContain('<subtitle>')
    expect(prompt.user).not.toContain('<byline>')
    expect(prompt.user).toContain('<title>T</title>')
  })

  it('changes the prompt version when any prompt file changes in a temp copy', async () => {
    const dir = await copyPromptDir()
    const original = await loadPromptLibrary(dir)
    expect(original.version).toBe((await loadPromptLibrary(PROMPT_DIR)).version)

    const edits: { path: string[]; content: string }[] = [
      { path: ['roles', 'words.md'], content: '\n- 测试追加：逐字复核。\n' },
      { path: ['rules.md'], content: '\n10. 测试追加规则。\n' },
      { path: ['base.md'], content: '\n测试追加原稿。\n' },
      { path: ['contracts', 'claims.schema.json'], content: '\n' },
      { path: ['contracts', 'layout.schema.json'], content: '\n' },
      { path: ['README.md'], content: '\n\n测试追加说明。\n' },
    ]

    let previous = original.version
    for (const edit of edits) {
      const filePath = join(dir, ...edit.path)
      await writeFile(filePath, (await readFile(filePath, 'utf8')) + edit.content, 'utf8')
      const next = await loadPromptLibrary(dir)
      expect(next.version).toMatch(/^[0-9a-f]{12}$/)
      expect(next.version).not.toBe(previous)
      previous = next.version
    }

    // Editing the copy never changes the shipped library version.
    expect((await loadPromptLibrary(PROMPT_DIR)).version).toBe(original.version)
  })

  it('rejects an unknown role with an error listing the available roles', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    let error: unknown
    try {
      library.compose('bogus' as RoleId, { article: articleFixture(), context: CONTEXT })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(UnknownPromptRoleError)
    expect(error).toBeInstanceOf(PromptLibraryError)
    expect((error as Error).message).toContain('bogus')
    expect((error as Error).message).toContain('consolidator')
    expect((error as Error).message).toContain('facts')
  })

  it('rejects a missing prompt directory, missing required files and empty required files', async () => {
    const emptyDir = await makeTempDir()
    await expect(loadPromptLibrary(emptyDir)).rejects.toBeInstanceOf(PromptLibraryError)
    await expect(loadPromptLibrary(join(emptyDir, 'does-not-exist'))).rejects.toBeInstanceOf(PromptLibraryError)

    const missingRole = await copyPromptDir()
    await rm(join(missingRole, 'roles', 'idioms.md'))
    await expect(loadPromptLibrary(missingRole)).rejects.toBeInstanceOf(PromptLibraryError)
    await expect(loadPromptLibrary(missingRole)).rejects.toThrow(/idioms/)

    const missingBase = await copyPromptDir()
    await rm(join(missingBase, 'base.md'))
    await expect(loadPromptLibrary(missingBase)).rejects.toThrow(/base\.md/)

    const emptyRole = await copyPromptDir()
    await writeFile(join(emptyRole, 'roles', 'words.md'), '  \n', 'utf8')
    await expect(loadPromptLibrary(emptyRole)).rejects.toThrow(/words\.md/)

    const emptyRules = await copyPromptDir()
    await writeFile(join(emptyRules, 'rules.md'), '\n\n', 'utf8')
    await expect(loadPromptLibrary(emptyRules)).rejects.toBeInstanceOf(PromptLibraryError)

    const missingContract = await copyPromptDir()
    await rm(join(missingContract, 'contracts', 'layout.schema.json'))
    await expect(loadPromptLibrary(missingContract)).rejects.toThrow(/layout\.schema\.json/)
  })

  it('rejects a contract file that is not valid JSON', async () => {
    const dir = await copyPromptDir()
    await writeFile(join(dir, 'contracts', 'claims.schema.json'), 'not json', 'utf8')
    await expect(loadPromptLibrary(dir)).rejects.toBeInstanceOf(PromptLibraryError)
    await expect(loadPromptLibrary(dir)).rejects.toThrow(/claims\.schema\.json/)
  })

  it('keeps the prompt files editable, compact and complete', async () => {
    expect((await promptFile('README.md')).trim().length).toBeGreaterThan(0)
    expect((await promptFile('base.md')).trim()).toBe(BASE_PROMPT.trim())

    for (const role of EXPECTED_ROLES) {
      const lines = (await promptFile('roles', `${role}.md`))
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
      expect(lines.length, `roles/${role}.md should stay between 5 and 12 lines`).toBeGreaterThanOrEqual(5)
      expect(lines.length, `roles/${role}.md should stay between 5 and 12 lines`).toBeLessThanOrEqual(12)
    }

    const rules = await promptFile('rules.md')
    for (const required of ['校对而非润色', '应查尽查', 'not_checked', 'needs_human', '无来源不判', '改写全文', 'JSON']) {
      expect(rules, `rules.md must state ${required}`).toContain(required)
    }
    expect(rules).toContain('若 `base.md` 或 `roles/<role>.md` 与 `rules.md` 冲突，以 `rules.md` 为准')
    expect(await promptFile('README.md')).toContain('以 `rules.md` 为准')

    const facts = await promptFile('roles', 'facts.md')
    for (const required of ['应查尽查', '逐项', '无来源不判错', '列全部来源', 'not_checked']) {
      expect(facts, `roles/facts.md must state ${required}`).toContain(required)
    }
  })

  it('keeps role prompts aligned with the findings JSON contract fields', async () => {
    // findings.schema.json is closed (`additionalProperties: false`) and has no
    // `roles` or secondary-location fields, so the prompts must not ask for them.
    for (const role of EXPECTED_ROLES) {
      const text = await promptFile('roles', `${role}.md`)
      expect(text, `roles/${role}.md must not ask for fields absent from the contracts`).not.toMatch(/\broles\b/)
      expect(text, `roles/${role}.md must not ask for a secondLocation field`).not.toMatch(/secondLocation/)
    }

    const consolidator = await promptFile('roles', 'consolidator.md')
    expect(consolidator).toContain('Host')
    expect(consolidator).toContain('程序')
    expect(consolidator).not.toContain('roles 取并集')

    const consistency = await promptFile('roles', 'consistency.md')
    expect(consistency).toContain('issue')
    expect(consistency).toContain('notes')
    expect(consistency).toContain('`quote`')
    expect(consistency).toContain('`occurrence`')

    const rules = await promptFile('rules.md')
    expect(rules).toContain('契约之外的字段')
  })

  it('exposes no raw prompt text on the library surface', async () => {
    const library = await loadPromptLibrary(PROMPT_DIR)
    expect(Object.keys(library).sort()).toEqual(['compose', 'roles', 'version'])
    expect(library).not.toHaveProperty('files')
    expect(library).not.toHaveProperty('promptDir')
    // Only the version and role ids are serializable; prompt text never is.
    const serialized = JSON.stringify(library)
    expect(serialized).not.toContain('校对而非润色')
    expect(serialized).not.toContain('请担任新闻校对员')
    expect(serialized).not.toContain('<article>')
  })
})

/* ------------------------------------------------------------------------- */
/* Output contracts                                                            */
/* ------------------------------------------------------------------------- */

interface JsonSchema {
  $schema?: string
  title?: string
  type?: string
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: string[]
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
}

async function readContract(name: string): Promise<JsonSchema> {
  return JSON.parse(await promptFile('contracts', name)) as JsonSchema
}

function itemOf(schema: JsonSchema, rootKey: string): JsonSchema {
  const array = schema.properties?.[rootKey]
  expect(array?.type).toBe('array')
  const item = array?.items
  expect(item?.type).toBe('object')
  expect(item?.additionalProperties).toBe(false)
  return item as JsonSchema
}

describe('prompt output contracts', () => {
  it('ships object-rooted draft-07 schemas for findings, claims, fact checks and layout', async () => {
    for (const name of [
      'findings.schema.json',
      'claims.schema.json',
      'factchecks.schema.json',
      'layout.schema.json',
    ]) {
      const schema = await readContract(name)
      expect(schema.$schema, name).toContain('draft-07')
      expect(schema.type, name).toBe('object')
      expect(schema.title, name).toBeTruthy()
    }
  })

  it('matches findings.schema.json to the shared Finding contract', async () => {
    const schema = await readContract('findings.schema.json')
    expect(schema.required).toContain('findings')
    const item = itemOf(schema, 'findings')
    expect(item.required).toEqual(
      expect.arrayContaining(['category', 'severity', 'quote', 'issue', 'suggestion', 'confidence']),
    )
    expect(item.properties?.category?.enum).toEqual([
      'typo',
      'punctuation',
      'word',
      'idiom',
      'grammar',
      'fact',
      'consistency',
      'headline',
      'format',
    ])
    expect(item.properties?.severity?.enum).toEqual(['must_fix', 'suggested', 'optional'])
    expect(item.properties?.confidence?.enum).toEqual(['high', 'medium', 'low'])
    expect(item.properties?.quote?.type).toBe('string')
    expect(item.properties?.occurrence?.type).toBe('integer')
    expect(item.properties?.needs_human?.type).toBe('boolean')
    const source = item.properties?.sources?.items
    expect(source?.required).toEqual(['title', 'url'])
  })

  it('matches claims.schema.json to the claim-extraction contract', async () => {
    const schema = await readContract('claims.schema.json')
    expect(schema.required).toContain('claims')
    const item = itemOf(schema, 'claims')
    expect(item.required).toEqual(expect.arrayContaining(['claim', 'quote', 'kind', 'queries', 'priority']))
    expect(item.properties?.kind?.enum).toEqual([
      'date',
      'time',
      'person',
      'title',
      'organization',
      'place',
      'book',
      'event',
      'number',
      'quote',
      'other',
    ])
    expect(item.properties?.queries?.type).toBe('array')
    expect(item.properties?.queries?.minItems).toBe(2)
    expect(item.properties?.queries?.maxItems).toBe(3)
    expect(item.properties?.priority?.type).toBe('integer')
  })

  it('matches factchecks.schema.json to the verdict contract and forbids source-less contradictions', async () => {
    const schema = await readContract('factchecks.schema.json')
    expect(schema.required).toContain('verdicts')
    const item = itemOf(schema, 'verdicts')
    expect(item.required).toEqual(expect.arrayContaining(['claim', 'verdict', 'confidence']))
    expect(item.properties?.verdict?.enum).toEqual([
      'confirmed',
      'contradicted',
      'unverified',
      'insufficient',
      'not_checked',
    ])
    expect(item.properties?.needs_human?.type).toBe('boolean')
    const serialized = JSON.stringify(schema)
    expect(serialized).toContain('contradicted')
    expect(serialized).toContain('minItems')
    expect(serialized).toContain('sources')
  })

  it('matches layout.schema.json to the shared vision-layout contract', async () => {
    const schema = await readContract('layout.schema.json')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(
      expect.arrayContaining(['pageType', 'regions', 'articles', 'warnings']),
    )
    expect(schema.properties?.pageType?.type).toBe('string')

    const region = itemOf(schema, 'regions')
    expect(region.required).toEqual(
      expect.arrayContaining(['candidateId', 'kind', 'articleGroup', 'readingOrder', 'confidence']),
    )
    expect(region.properties?.kind?.enum).toEqual([
      'masthead',
      'header',
      'footer',
      'lead',
      'second',
      'third',
      'article',
      'image',
      'caption',
      'ad',
      'index',
      'other',
    ])
    expect(region.properties?.confidence?.minimum).toBe(0)
    expect(region.properties?.confidence?.maximum).toBe(1)
    expect(region.properties?.candidateId?.type).toBe('string')

    const article = itemOf(schema, 'articles')
    expect(article.required).toEqual(
      expect.arrayContaining([
        'id',
        'titleCandidateId',
        'role',
        'order',
        'regionIds',
        'continuation',
        'confidence',
      ]),
    )
    expect(article.properties?.role?.enum).toEqual(['lead', 'second', 'third', 'normal'])
    expect(article.properties?.continuation?.enum).toEqual(['none', 'down', 'up'])
    expect(article.properties?.regionIds?.type).toBe('array')
    expect(article.properties?.confidence?.minimum).toBe(0)
    expect(article.properties?.confidence?.maximum).toBe(1)
  })
})

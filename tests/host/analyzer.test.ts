/**
 * Tests for the Host vision layout analyzer (`src/host/layout/analyzer.ts`) and
 * its static prompt (`src/host/layout/vision-prompt.ts`).
 *
 * The two Host seams — `LlmClient.complete` and the injected `saveImage` — are
 * faked with real async functions, so the analyzer's actual prompt building,
 * image hand-off, retry, validation and deterministic fallback run end to end.
 * Nothing inside the analyzer or the prompt module is mocked.
 *
 * The required fields/enums are also checked against the shipped
 * `prompts/zh/contracts/layout.schema.json`, the machine-readable contract, so
 * the static prompt cannot silently drift from the layout contract.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CandidateBlock } from '../../src/shared/types'
import { FALLBACK_CONFIDENCE, FALLBACK_WARNING } from '../../src/shared/layout/vision-schema'
import type { LlmClient, LlmImageBlock, LlmRequest } from '../../src/host/services/llm-client'
import {
  VISION_ATTEMPT_TIMEOUT_MS,
  VISION_TIMEOUT_WARNING,
  createLayoutAnalyzer,
  type LayoutAnalyzer,
  type SaveImage,
} from '../../src/host/layout/analyzer'
import {
  VISION_LAYOUT_SYSTEM_PROMPT,
  buildVisionLayoutUserPrompt,
} from '../../src/host/layout/vision-prompt'

/** The shipped machine-readable layout contract. */
const SCHEMA_FILE = fileURLToPath(new URL('../../prompts/zh/contracts/layout.schema.json', import.meta.url))

/** Subset of the JSON Schema shape this test reads (draft-07 object). */
interface SchemaNode {
  required?: string[]
  enum?: string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
}

const PAGE = { widthPt: 1000, heightPt: 1400 }

const OVERLAY = new Uint8Array([137, 80, 78, 71])

/**
 * Three candidates: a lead headline, its body and the page footer. The footer
 * is a page-furniture candidate that must never become article material.
 */
const CANDIDATES: CandidateBlock[] = [
  {
    candidateId: 'c1',
    bbox: { x: 40, y: 80, w: 600, h: 72 },
    lineIds: ['l1', 'l2'],
    fontSizeBand: 'headline',
    firstLineText: '文汇报头条标题',
    lineCount: 2,
  },
  {
    candidateId: 'c2',
    bbox: { x: 40, y: 160, w: 600, h: 420 },
    lineIds: ['l3'],
    fontSizeBand: 'body',
    firstLineText: '头条正文第一行',
    lineCount: 1,
  },
  {
    candidateId: 'c3',
    bbox: { x: 40, y: 1320, w: 920, h: 40 },
    lineIds: ['l4'],
    fontSizeBand: 'small',
    firstLineText: '本报地址 电话',
    lineCount: 1,
  },
]

/** A valid vision-layout reply for {@link CANDIDATES}. */
function visionResponse(): string {
  return JSON.stringify({
    pageType: 'news',
    regions: [
      { candidateId: 'c1', kind: 'lead', articleGroup: 'a1', readingOrder: 1, confidence: 0.92 },
      { candidateId: 'c2', kind: 'article', articleGroup: 'a1', readingOrder: 2, confidence: 0.88 },
      { candidateId: 'c3', kind: 'footer', articleGroup: '', readingOrder: 3, confidence: 0.97 },
    ],
    articles: [
      {
        id: 'a1',
        titleCandidateId: 'c1',
        role: 'lead',
        order: 1,
        regionIds: ['c1', 'c2'],
        continuation: 'none',
        confidence: 0.9,
      },
    ],
    warnings: [],
  })
}

/** Parse-valid output that wrongly uses the furniture block as an article title. */
function furnitureTitleResponse(): string {
  const layout = JSON.parse(visionResponse()) as {
    articles: Array<{ titleCandidateId: string }>
  }
  layout.articles[0].titleCandidateId = 'c3'
  return JSON.stringify(layout)
}

/** Parse-valid output that wrongly groups the furniture block into an article. */
function furnitureGroupResponse(): string {
  const layout = JSON.parse(visionResponse()) as {
    regions: Array<{ candidateId: string; articleGroup: string }>
    articles: Array<{ regionIds: string[] }>
  }
  const footer = layout.regions.find((region) => region.candidateId === 'c3')
  if (footer !== undefined) footer.articleGroup = 'a1'
  layout.articles[0].regionIds.push('c3')
  return JSON.stringify(layout)
}

/** Parse-valid output that silently drops the `c2` candidate block. */
function incompleteVisionResponse(): string {
  const layout = JSON.parse(visionResponse()) as {
    regions: Array<{ candidateId: string }>
    articles: Array<{ regionIds: string[] }>
  }
  layout.regions = layout.regions.filter((region) => region.candidateId !== 'c2')
  layout.articles[0].regionIds = layout.articles[0].regionIds.filter((id) => id !== 'c2')
  return JSON.stringify(layout)
}

/** Fake attachment writer: records the overlay bytes and returns a PNG ref. */
function fakeSaveImage() {
  return vi.fn<SaveImage>(async (input) => ({
    attachmentId: 'att_1',
    mediaType: 'image/png',
    bytes: input.data.length,
    width: 10,
    height: 14,
  }))
}

/**
 * Build an analyzer around the two faked Host seams. `visionAttemptTimeoutMs`
 * shortens the production 240s per-attempt bound for the timeout tests.
 */
function makeAnalyzer(
  complete: LlmClient['complete'],
  saveImage: SaveImage = fakeSaveImage(),
  visionAttemptTimeoutMs?: number,
): LayoutAnalyzer {
  return createLayoutAnalyzer({
    llm: { complete },
    saveImage,
    ...(visionAttemptTimeoutMs === undefined ? {} : { visionAttemptTimeoutMs }),
  })
}

/** Every image block of a request (the analyzer must send exactly one). */
function imageOf(request: LlmRequest): LlmImageBlock | undefined {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'image') return block
    }
  }
  return undefined
}

/** Concatenated text blocks of a request. */
function textOf(request: LlmRequest): string {
  const parts: string[] = []
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** The candidate list JSON embedded in a user prompt. */
function candidateListOf(user: string): unknown {
  const start = user.indexOf('[')
  const end = user.lastIndexOf(']')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return JSON.parse(user.slice(start, end + 1)) as unknown
}

const ANALYSIS_INPUT = { overlayPng: OVERLAY, candidates: CANDIDATES, page: PAGE }

describe('createLayoutAnalyzer', () => {
  it('parses a valid layout, saving the overlay once and passing it to the model', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: visionResponse() })
    const saveImage = fakeSaveImage()
    const controller = new AbortController()

    const layout = await makeAnalyzer(complete, saveImage).analyze(ANALYSIS_INPUT, controller.signal)

    expect(layout.pageType).toBe('news')
    expect(layout.articles).toHaveLength(1)
    expect(layout.articles[0].id).toBe('a1')
    expect(layout.articles[0].titleCandidateId).toBe('c1')
    expect(layout.articles[0].regionIds).toEqual(['c1', 'c2'])
    expect(layout.regions.find((region) => region.candidateId === 'c3')?.kind).toBe('footer')
    expect(complete).toHaveBeenCalledTimes(1)

    // The overlay is handed to the injected attachment writer byte-for-byte.
    expect(saveImage).toHaveBeenCalledTimes(1)
    const saved = saveImage.mock.calls[0][0]
    expect(saved.data).toBe(OVERLAY)
    expect(saved.mediaType).toBe('image/png')
    expect(saved.name).toMatch(/\.png$/)

    // One user message, an image block with the saved attachment and a text
    // block with the candidate prompt. The forwarded signal is the caller's
    // signal combined with the per-attempt timeout, so cancellation still
    // reaches the model.
    const forwarded = complete.mock.calls[0][1]
    expect(forwarded).not.toBe(controller.signal)
    expect(forwarded.aborted).toBe(false)
    controller.abort()
    expect(forwarded.aborted).toBe(true)
    const request = complete.mock.calls[0][0]
    expect(request.system).toBe(VISION_LAYOUT_SYSTEM_PROMPT)
    expect(request.reasoningEffort).toBe('high')
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0].role).toBe('user')
    const image = imageOf(request)
    expect(image?.type).toBe('image')
    expect(image?.attachment).toMatchObject({
      attachmentId: 'att_1',
      mediaType: 'image/png',
      bytes: OVERLAY.length,
    })
    expect(textOf(request)).toContain('c1')
  })

  it('accepts a reply wrapped in a Markdown fence', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: `结果如下：\n\`\`\`json\n${visionResponse()}\n\`\`\`\n` })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(layout.articles[0].id).toBe('a1')
    expect(layout.warnings).not.toContain(FALLBACK_WARNING)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('builds a user prompt with the page size and the whole candidate list', async () => {
    const user = buildVisionLayoutUserPrompt({ candidates: CANDIDATES, page: PAGE })

    for (const candidate of CANDIDATES) {
      expect(user).toContain(candidate.candidateId)
    }
    expect(candidateListOf(user)).toEqual(CANDIDATES)
    expect(user).toContain(String(PAGE.widthPt))
    expect(user).toContain(String(PAGE.heightPt))
    expect(user).toMatch(/JSON/)
  })

  it('distinguishes a transport retry from a validation retry', () => {
    const validation = buildVisionLayoutUserPrompt({
      candidates: CANDIDATES,
      page: PAGE,
      retry: { kind: 'validation', error: '文章 a1 的 titleCandidateId 不得是家具' },
    })
    expect(validation).toContain('上一次输出未通过校验')
    expect(validation).toContain('文章 a1 的 titleCandidateId 不得是家具')

    const transport = buildVisionLayoutUserPrompt({
      candidates: CANDIDATES,
      page: PAGE,
      retry: { kind: 'transport' },
    })
    expect(transport).not.toContain('上一次输出未通过校验')
    expect(transport).toMatch(/未完成|重新执行/)
    expect(transport).not.toContain('Error')
    // The neutral retry still repeats the same task with the same candidate list.
    expect(candidateListOf(transport)).toEqual(CANDIDATES)
  })

  it('states every required field and enum from the layout contract', async () => {
    const schema = JSON.parse(await readFile(SCHEMA_FILE, 'utf8')) as SchemaNode
    const requiredFields = [
      ...(schema.required ?? []),
      ...(schema.properties?.regions?.items?.required ?? []),
      ...(schema.properties?.articles?.items?.required ?? []),
    ]
    const enums = [
      ...(schema.properties?.regions?.items?.properties?.kind?.enum ?? []),
      ...(schema.properties?.articles?.items?.properties?.role?.enum ?? []),
      ...(schema.properties?.articles?.items?.properties?.continuation?.enum ?? []),
    ]

    expect(schema.required).toEqual(['pageType', 'regions', 'articles', 'warnings'])
    expect(requiredFields.length).toBeGreaterThan(10)
    expect(enums.length).toBeGreaterThan(10)
    for (const field of requiredFields) {
      expect(VISION_LAYOUT_SYSTEM_PROMPT).toContain(field)
    }
    for (const value of enums) {
      expect(VISION_LAYOUT_SYSTEM_PROMPT).toContain(value)
    }
    for (const pageType of ['front', 'news', 'supplement', 'literary', 'ad', 'unknown']) {
      expect(VISION_LAYOUT_SYSTEM_PROMPT).toContain(pageType)
    }
  })

  it('separates page furniture and forbids using it as an article title', () => {
    const system = VISION_LAYOUT_SYSTEM_PROMPT

    expect(system).toMatch(/家具/)
    for (const furniture of ['masthead', 'header', 'footer', 'ad']) {
      expect(system).toContain(furniture)
    }
    expect(system).toContain('titleCandidateId')
    expect(system).toMatch(/titleCandidateId[^。]*(不得|不能|绝不)指向/)
    expect(system).toMatch(/家具候选块/)
  })

  it('never transcribes article text into the parsed layout', async () => {
    const response = JSON.parse(visionResponse()) as {
      regions: Array<Record<string, unknown>>
      articles: Array<Record<string, unknown>>
    }
    response.regions[0].text = '这是模型转录的标题文字'
    response.articles[0].title = '这是模型转录的正文文字'
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: JSON.stringify(response) })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(JSON.stringify(layout)).not.toContain('转录')
    expect(Object.keys(layout.articles[0]).sort()).toEqual([
      'confidence',
      'continuation',
      'id',
      'order',
      'regionIds',
      'role',
      'titleCandidateId',
    ])
    expect(VISION_LAYOUT_SYSTEM_PROMPT).toMatch(/不要转写|不得转写|不要抄录/)
  })

  it('retries once with the validation error after invalid JSON', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValueOnce({ text: 'not json' })
    complete.mockResolvedValueOnce({ text: visionResponse() })
    const saveImage = fakeSaveImage()

    const layout = await makeAnalyzer(complete, saveImage).analyze(
      ANALYSIS_INPUT,
      new AbortController().signal,
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(layout.articles[0].id).toBe('a1')
    expect(layout.warnings).not.toContain(FALLBACK_WARNING)

    const firstAttempt = textOf(complete.mock.calls[0][0])
    const retry = textOf(complete.mock.calls[1][0])
    expect(retry).not.toBe(firstAttempt)
    expect(retry).toContain('上一次')
    expect(retry).toMatch(/JSON/)
    // The retry reuses the already-saved attachment instead of duplicating it.
    expect(imageOf(complete.mock.calls[1][0])?.attachment).toEqual(
      imageOf(complete.mock.calls[0][0])?.attachment,
    )
  })

  it('retries once after an LLM call failure with a neutral preamble, not validation feedback', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockRejectedValueOnce(new Error('provider down'))
    complete.mockResolvedValueOnce({ text: visionResponse() })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.articles[0].id).toBe('a1')
    expect(layout.warnings).not.toContain(FALLBACK_WARNING)
    const retry = textOf(complete.mock.calls[1][0])
    // A transport failure says nothing about the model's JSON output, so the
    // retry must not claim that a previous answer failed validation.
    expect(retry).not.toContain('上一次输出未通过校验')
    expect(retry).not.toContain('provider down')
    expect(retry).toMatch(/未完成|重新执行/)
    expect(candidateListOf(retry)).toEqual(CANDIDATES)
  })

  it('retries when a candidate block is missing from regions and accepts the complete reply', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValueOnce({ text: incompleteVisionResponse() })
    complete.mockResolvedValueOnce({ text: visionResponse() })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).not.toContain(FALLBACK_WARNING)
    expect(layout.regions.map((region) => region.candidateId)).toEqual(['c1', 'c2', 'c3'])
    expect(layout.articles[0].regionIds).toEqual(['c1', 'c2'])
    const retry = textOf(complete.mock.calls[1][0])
    expect(retry).toContain('上一次输出未通过校验')
    expect(retry).toContain('c2')
  })

  it('falls back when candidate blocks keep missing from regions', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: incompleteVisionResponse() })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    // The deterministic fallback covers every candidate block.
    expect(layout.regions.map((region) => region.candidateId)).toEqual(['c1', 'c2', 'c3'])
    expect(layout.articles).toHaveLength(3)
    expect(textOf(complete.mock.calls[1][0])).toContain('c2')
  })

  it('falls back to the deterministic layout after two invalid replies', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: '抱歉，我无法完成这个任务。' })
    const saveImage = fakeSaveImage()

    const layout = await makeAnalyzer(complete, saveImage).analyze(
      ANALYSIS_INPUT,
      new AbortController().signal,
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(layout.articles.map((article) => article.id)).toEqual(['a1', 'a2', 'a3'])
    expect(layout.regions.every((region) => region.confidence === FALLBACK_CONFIDENCE)).toBe(true)
    expect(layout.articles.every((article) => article.confidence === FALLBACK_CONFIDENCE)).toBe(true)
  })

  it('falls back to the deterministic layout after two LLM call failures', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockRejectedValue(new Error('network down'))

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
  })

  it('falls back without calling the model when the overlay cannot be saved', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    const saveImage = vi.fn<SaveImage>(async () => {
      throw new Error('attachment store down')
    })

    const layout = await makeAnalyzer(complete, saveImage).analyze(
      ANALYSIS_INPUT,
      new AbortController().signal,
    )

    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(complete).not.toHaveBeenCalled()
  })

  it('falls back immediately for an empty candidate list without saving or calling', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    const saveImage = fakeSaveImage()

    const layout = await makeAnalyzer(complete, saveImage).analyze(
      { overlayPng: OVERLAY, candidates: [], page: PAGE },
      new AbortController().signal,
    )

    expect(layout.pageType).toBe('unknown')
    expect(layout.regions).toEqual([])
    expect(layout.articles).toEqual([])
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(saveImage).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('rejects an already-aborted signal without touching the image or the model', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    const saveImage = fakeSaveImage()
    const controller = new AbortController()
    controller.abort()

    await expect(
      makeAnalyzer(complete, saveImage).analyze(ANALYSIS_INPUT, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(saveImage).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not retry or fall back when the caller cancels the attempt', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    const saveImage = fakeSaveImage()
    const controller = new AbortController()
    complete.mockImplementation(async () => {
      controller.abort()
      throw new Error('cancelled by caller')
    })

    await expect(
      makeAnalyzer(complete, saveImage).analyze(ANALYSIS_INPUT, controller.signal),
    ).rejects.toThrow('cancelled by caller')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(saveImage).toHaveBeenCalledTimes(1)
  })

  it('retries when furniture is used as an article title and accepts the corrected reply', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValueOnce({ text: furnitureTitleResponse() })
    complete.mockResolvedValueOnce({ text: visionResponse() })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.articles[0].titleCandidateId).toBe('c1')
    expect(layout.regions.find((region) => region.candidateId === 'c3')?.kind).toBe('footer')
    expect(textOf(complete.mock.calls[1][0])).toContain('titleCandidateId')
  })

  it('rethrows a cancelled image save instead of falling back', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    const controller = new AbortController()
    const saveImage = vi.fn<SaveImage>(async () => {
      controller.abort()
      throw new Error('save cancelled')
    })

    await expect(
      makeAnalyzer(complete, saveImage).analyze(ANALYSIS_INPUT, controller.signal),
    ).rejects.toThrow('save cancelled')
    expect(complete).not.toHaveBeenCalled()
  })

  it('retries when furniture is put into article regionIds and falls back on repetition', async () => {
    const response = JSON.parse(visionResponse()) as {
      articles: Array<{ regionIds: string[] }>
    }
    // The footer keeps its empty articleGroup but is listed as article content.
    response.articles[0].regionIds.push('c3')
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: JSON.stringify(response) })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(textOf(complete.mock.calls[1][0])).toContain('regionIds')
  })

  it('falls back when page furniture keeps being grouped into an article', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValue({ text: furnitureGroupResponse() })

    const layout = await makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(textOf(complete.mock.calls[1][0])).toMatch(/家具/)
  })
})

/* ------------------------------------------------------------------------- */
/* Per-attempt vision timeout (Task 21g: never hang at 25%)                    */
/* ------------------------------------------------------------------------- */

describe('vision attempt timeout', () => {
  /** Short injected bound: the analyze path is the production one, only faster. */
  const SHORT_TIMEOUT_MS = 20

  /** A client whose call never settles — a provider stream that never finishes. */
  function neverCompletes(): LlmClient['complete'] {
    return vi.fn<LlmClient['complete']>(() => new Promise<never>(() => {}))
  }

  it('exports the production 240s bound and the visible timeout warning', () => {
    expect(VISION_ATTEMPT_TIMEOUT_MS).toBe(240_000)
    expect(VISION_TIMEOUT_WARNING).toBe('vision-timeout')
  })

  it('falls back after exactly one attempt when a stalled call times out', async () => {
    const complete = neverCompletes()
    const saveImage = fakeSaveImage()

    const layout = await makeAnalyzer(complete, saveImage, SHORT_TIMEOUT_MS).analyze(
      ANALYSIS_INPUT,
      new AbortController().signal,
    )

    // A timeout is not retried: the page degrades to the deterministic layout.
    expect(complete).toHaveBeenCalledTimes(1)
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(layout.warnings).toContain(VISION_TIMEOUT_WARNING)
    expect(layout.regions.map((region) => region.candidateId)).toEqual(['c1', 'c2', 'c3'])
    expect(layout.regions.every((region) => region.confidence === FALLBACK_CONFIDENCE)).toBe(true)
    expect(layout.articles.map((article) => article.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('uses the production 240s bound when no shorter timeout is injected', async () => {
    vi.useFakeTimers()
    try {
      const complete = neverCompletes()
      let settled = false
      const analyzing = makeAnalyzer(complete).analyze(ANALYSIS_INPUT, new AbortController().signal)
      const tracked = analyzing.then(
        (layout) => {
          settled = true
          return layout
        },
        (error: unknown) => {
          settled = true
          throw error
        },
      )

      // Let the async image save settle so the attempt timer is registered.
      await vi.advanceTimersByTimeAsync(0)
      expect(complete).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(VISION_ATTEMPT_TIMEOUT_MS - 1)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const layout = await tracked
      expect(layout.warnings).toContain(VISION_TIMEOUT_WARNING)
      expect(complete).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains the abandoned model promise so a late rejection is not unhandled', async () => {
    let rejectLate: ((error: Error) => void) | undefined
    const complete = vi.fn<LlmClient['complete']>(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLate = reject
        }),
    )
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const layout = await makeAnalyzer(complete, fakeSaveImage(), SHORT_TIMEOUT_MS).analyze(
        ANALYSIS_INPUT,
        new AbortController().signal,
      )
      expect(layout.warnings).toContain(VISION_TIMEOUT_WARNING)

      // The model stream eventually fails after the attempt was abandoned.
      rejectLate?.(new Error('late model failure after timeout'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('rejects an aborted caller instead of timing out or falling back', async () => {
    const complete = neverCompletes()
    const saveImage = fakeSaveImage()
    const controller = new AbortController()

    const analyzing = makeAnalyzer(complete, saveImage, 5_000).analyze(
      ANALYSIS_INPUT,
      controller.signal,
    )
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    controller.abort(new Error('caller cancelled the layout job'))

    await expect(analyzing).rejects.toThrow('caller cancelled the layout job')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(saveImage).toHaveBeenCalledTimes(1)
  })

  it('still retries once on non-timeout failures and never reports a timeout', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockRejectedValueOnce(new Error('provider down'))
    complete.mockRejectedValueOnce(new Error('provider still down'))

    const layout = await makeAnalyzer(complete, fakeSaveImage(), SHORT_TIMEOUT_MS).analyze(
      ANALYSIS_INPUT,
      new AbortController().signal,
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(layout.warnings).not.toContain(VISION_TIMEOUT_WARNING)
  })

  it('does not retry again when the retry attempt itself times out', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    complete.mockResolvedValueOnce({ text: 'not json' })
    complete.mockImplementationOnce(() => new Promise<never>(() => {}))

    const layout = await makeAnalyzer(complete, fakeSaveImage(), SHORT_TIMEOUT_MS).analyze(
      ANALYSIS_INPUT,
      new AbortController().signal,
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(layout.warnings).toContain(FALLBACK_WARNING)
    expect(layout.warnings).toContain(VISION_TIMEOUT_WARNING)
  })
})

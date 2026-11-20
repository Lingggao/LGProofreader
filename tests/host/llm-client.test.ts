/**
 * Tests for the Host LLM client (`src/host/services/llm-client.ts`).
 *
 * The DSH `ctx.llm.stream` service is faked with real async generators, so the
 * tests drive the actual chunk protocol (text/reasoning deltas, usage, terminal
 * finish) end to end. Nothing inside the client is mocked.
 */
import { describe, expect, it } from 'vitest'
import {
  LlmCallError,
  createLlmClient,
  type ImageAttachmentRef,
  type LlmMessage,
  type LlmStreamChunk,
  type LlmStreamOptions,
} from '../../src/host/services/llm-client'

type Stream = (options: LlmStreamOptions) => AsyncIterable<LlmStreamChunk>

interface FakeContext {
  llm: { stream: Stream }
}

/** A fake Host context whose only service is `llm`; records every stream call. */
function fakeContext(stream: Stream): { ctx: FakeContext; calls: LlmStreamOptions[] } {
  const calls: LlmStreamOptions[] = []
  return {
    calls,
    ctx: {
      llm: {
        stream(options) {
          calls.push(options)
          return stream(options)
        },
      },
    },
  }
}

/** Async generator from a literal chunk list. */
async function* chunks(...values: LlmStreamChunk[]): AsyncGenerator<LlmStreamChunk> {
  yield* values
}

const STOP_FINISH: LlmStreamChunk = { type: 'finish', reason: { kind: 'stop' } }

const IMAGE: ImageAttachmentRef = {
  attachmentId: 'att_1',
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

const USER_TEXT: LlmMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

function clientWith(chunksToEmit: LlmStreamChunk[]): ReturnType<typeof createLlmClient> {
  return createLlmClient(fakeContext(() => chunks(...chunksToEmit)).ctx, { provider: 'p', model: 'm' })
}

/** Await a completion that must reject with the typed LLM error. */
async function rejection(promise: Promise<unknown>): Promise<LlmCallError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof LlmCallError) return error
    throw error
  }
  throw new Error('expected the LLM completion to reject')
}

const SIGNAL = new AbortController().signal

describe('createLlmClient', () => {
  it('assembles text deltas and resolves the stop finish', async () => {
    const { ctx, calls } = fakeContext(() =>
      chunks(
        { type: 'text-delta', index: 0, text: '你' },
        { type: 'text-delta', index: 0, text: '好' },
        STOP_FINISH,
      ),
    )
    const client = createLlmClient(ctx, { provider: 'p', model: 'm' })

    await expect(
      client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL),
    ).resolves.toEqual({ text: '你好' })
    expect(calls).toHaveLength(1)
  })

  it('forwards selection, system, messages (with images), maxTokens and signal', async () => {
    const { ctx, calls } = fakeContext(() => chunks(STOP_FINISH))
    const client = createLlmClient(ctx, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
    const signal = new AbortController().signal
    const messages: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: IMAGE }] },
    ]

    await client.complete({ system: 'SYS', messages, maxTokens: 256 }, signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      system: 'SYS',
      maxTokens: 256,
    })
    expect(calls[0].signal).toBe(signal)
    expect(calls[0].messages).toEqual(messages)
    // A raw model call must not create or reference an Agent/session.
    expect(calls[0]).not.toHaveProperty('sessionId')
    expect(calls[0]).not.toHaveProperty('tools')
    expect(calls[0]).not.toHaveProperty('purpose')
  })

  it('lets a request override the selection reasoning effort (Task 25)', async () => {
    const { ctx, calls } = fakeContext(() => chunks(STOP_FINISH))
    const client = createLlmClient(ctx, {
      provider: 'p',
      model: 'm',
      reasoningEffort: 'max',
    })

    await client.complete(
      { system: 's', messages: [USER_TEXT], reasoningEffort: 'low' },
      SIGNAL,
    )
    await client.complete({ system: 's', messages: [USER_TEXT], reasoningEffort: 'high' }, SIGNAL)
    // A request without an override keeps the activation-level selection, and a
    // blank override does not silently disable reasoning.
    await client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL)
    await client.complete({ system: 's', messages: [USER_TEXT], reasoningEffort: '  ' }, SIGNAL)

    expect(calls.map((options) => options.reasoningEffort)).toEqual([
      'low',
      'high',
      'max',
      'max',
    ])
  })

  it('touches only the llm service on the Host context', async () => {
    const readProps: string[] = []
    const target = { llm: { stream: (() => chunks(STOP_FINISH)) as Stream } }
    const ctx = new Proxy(target, {
      get(object, property, receiver) {
        readProps.push(String(property))
        return Reflect.get(object, property, receiver)
      },
    })

    await createLlmClient(ctx, { provider: 'p', model: 'm' }).complete(
      { system: 's', messages: [USER_TEXT] },
      SIGNAL,
    )

    expect(readProps).toEqual(['llm'])
  })

  it('ignores reasoning deltas and the other non-text chunks', async () => {
    const client = clientWith([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking…' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '答' },
      { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'search', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '答' } },
      STOP_FINISH,
    ])

    await expect(client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL)).resolves.toEqual({
      text: '答',
    })
  })

  it('captures input/output usage from the usage chunk', async () => {
    const client = clientWith([
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 } },
      { type: 'text-delta', index: 0, text: 'x' },
      STOP_FINISH,
    ])

    await expect(client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL)).resolves.toEqual({
      text: 'x',
      usage: { inputTokens: 12, outputTokens: 34 },
    })
  })

  it('throws a typed LlmCallError on an error finish', async () => {
    const client = clientWith([
      { type: 'text-delta', index: 0, text: 'partial' },
      {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'X', message: 'bad', status: 503 } },
      },
    ])

    const error = await rejection(client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL))

    expect(error).toBeInstanceOf(LlmCallError)
    expect(error.name).toBe('LlmCallError')
    expect(error.kind).toBe('error')
    expect(error.code).toBe('X')
    expect(error.status).toBe(503)
    expect(error.message).toBe('bad')
  })

  it('throws a typed LlmCallError on an aborted finish', async () => {
    const client = clientWith([
      {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped by provider' } },
      },
    ])

    const error = await rejection(client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL))

    expect(error.kind).toBe('aborted')
    expect(error.code).toBe('ABORTED')
    expect(error.message).toBe('stopped by provider')
  })

  it('forwards caller cancellation and rejects the aborted finish', async () => {
    const controller = new AbortController()
    const seenSignals: (AbortSignal | undefined)[] = []
    const { ctx } = fakeContext((options) => {
      seenSignals.push(options.signal)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' } as const
        controller.abort()
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled by caller' } },
        } as const
      })()
    })
    const client = createLlmClient(ctx, { provider: 'p', model: 'm' })

    const error = await rejection(
      client.complete({ system: 's', messages: [USER_TEXT] }, controller.signal),
    )

    expect(seenSignals).toEqual([controller.signal])
    expect(controller.signal.aborted).toBe(true)
    expect(error.kind).toBe('aborted')
    expect(error.code).toBe('ABORTED')
    expect(error.message).toBe('cancelled by caller')
  })

  it('translates a thrown AbortError into an aborted LlmCallError', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('aborted', 'AbortError')
    const { ctx } = fakeContext(() =>
      (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' } as const
        controller.abort()
        throw abortError
      })(),
    )
    const client = createLlmClient(ctx, { provider: 'p', model: 'm' })

    const error = await rejection(
      client.complete({ system: 's', messages: [USER_TEXT] }, controller.signal),
    )

    expect(error.kind).toBe('aborted')
    expect(error.code).toBe('ABORTED')
    expect(error.cause).toBe(abortError)
  })

  it('rethrows a non-abort stream failure unchanged', async () => {
    const failure = new Error('network down')
    const { ctx } = fakeContext(() =>
      (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' } as const
        throw failure
      })(),
    )
    const client = createLlmClient(ctx, { provider: 'p', model: 'm' })

    await expect(client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL)).rejects.toBe(failure)
  })

  it('rejects a stream that ends without a finish event', async () => {
    const empty = clientWith([])
    const emptyError = await rejection(empty.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL))
    expect(emptyError.kind).toBe('error')
    expect(emptyError.code).toBe('MISSING_FINISH')
    expect(emptyError.message).toContain('finish')

    const truncated = clientWith([{ type: 'text-delta', index: 0, text: 'cut' }])
    const truncatedError = await rejection(
      truncated.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL),
    )
    expect(truncatedError.code).toBe('MISSING_FINISH')
  })

  it('resolves partial text on a max-tokens finish (only error/aborted throw)', async () => {
    const client = clientWith([
      { type: 'text-delta', index: 0, text: '{"findings":' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])

    await expect(client.complete({ system: 's', messages: [USER_TEXT] }, SIGNAL)).resolves.toEqual({
      text: '{"findings":',
    })
  })
})

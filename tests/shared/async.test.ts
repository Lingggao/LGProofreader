/**
 * Tests for the shared concurrency helper (`src/shared/async.ts`).
 *
 * `mapWithConcurrency` is the one place that bounds how many model calls run at
 * the same time (design §7.5: total concurrency = `maxConcurrentWorkers`), so the
 * tests pin the observable contract: input-order results, a hard cap on in-flight
 * tasks, signal forwarding, first-error propagation and prompt rejection on
 * cancellation.
 */
import { describe, expect, it, vi } from 'vitest'
import { mapWithConcurrency } from '../../src/shared/async'

const SIGNAL = new AbortController().signal

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('mapWithConcurrency', () => {
  it('returns results in input order while keeping at most `limit` tasks in flight', async () => {
    let active = 0
    let peak = 0
    const results = await mapWithConcurrency(
      [10, 20, 30, 40, 50],
      2,
      async (item) => {
        active += 1
        peak = Math.max(peak, active)
        await delay(5)
        active -= 1
        return item * 2
      },
      SIGNAL,
    )

    expect(results).toEqual([20, 40, 60, 80, 100])
    expect(peak).toBe(2)
  })

  it('runs every task when the limit is at least the item count', async () => {
    let active = 0
    let peak = 0
    const results = await mapWithConcurrency(
      [1, 2, 3],
      10,
      async (item) => {
        active += 1
        peak = Math.max(peak, active)
        await delay(2)
        active -= 1
        return item
      },
      SIGNAL,
    )
    expect(results).toEqual([1, 2, 3])
    expect(peak).toBe(3)
  })

  it('clamps a non-positive or fractional limit to at least one worker', async () => {
    const seen: number[] = []
    await mapWithConcurrency(
      [1, 2, 3],
      0,
      async (item) => {
        seen.push(item)
        return item
      },
      SIGNAL,
    )
    expect(seen).toEqual([1, 2, 3])

    const peak = await mapWithConcurrency(
      [1, 2, 3, 4],
      2.9,
      async () => {
        await delay(1)
        return 1
      },
      SIGNAL,
    )
    expect(peak).toHaveLength(4)
  })

  it('passes the item, its input index and the caller signal to the task', async () => {
    const calls: Array<{ item: string; index: number; signal: AbortSignal }> = []
    await mapWithConcurrency(
      ['a', 'b'],
      2,
      async (item, index, signal) => {
        calls.push({ item, index, signal })
        return item
      },
      SIGNAL,
    )
    expect(calls).toEqual([
      { item: 'a', index: 0, signal: SIGNAL },
      { item: 'b', index: 1, signal: SIGNAL },
    ])
  })

  it('resolves an empty array without calling the task', async () => {
    const task = vi.fn(async () => 1)
    await expect(mapWithConcurrency([], 4, task, SIGNAL)).resolves.toEqual([])
    expect(task).not.toHaveBeenCalled()
  })

  it('rejects immediately for an already-aborted signal without starting tasks', async () => {
    const controller = new AbortController()
    controller.abort(new Error('aborted before start'))
    const task = vi.fn(async () => 1)

    await expect(mapWithConcurrency([1, 2], 2, task, controller.signal)).rejects.toThrow(
      'aborted before start',
    )
    expect(task).not.toHaveBeenCalled()
  })

  it('rejects with the abort reason and stops scheduling new tasks', async () => {
    const controller = new AbortController()
    const task = vi.fn(async (item: number) => {
      if (item === 1) controller.abort(new Error('stop now'))
      return item
    })

    await expect(mapWithConcurrency([1, 2, 3], 1, task, controller.signal)).rejects.toThrow(
      'stop now',
    )
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('propagates the first task error and stops scheduling new tasks', async () => {
    const task = vi.fn(async (item: number) => {
      if (item === 2) throw new Error(`boom ${item}`)
      return item
    })

    await expect(mapWithConcurrency([1, 2, 3, 4], 1, task, SIGNAL)).rejects.toThrow('boom 2')
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('rejects promptly when aborted while a task ignores the signal', async () => {
    const controller = new AbortController()
    let started = false
    const pending = mapWithConcurrency(
      [1, 2],
      1,
      () => {
        started = true
        return new Promise<number>(() => {
          // Deliberately ignores the signal: the helper itself must still settle.
        })
      },
      controller.signal,
    )
    await vi.waitFor(() => expect(started).toBe(true))
    controller.abort(new Error('stop now'))
    await expect(pending).rejects.toThrow('stop now')
  })

  it('does not need a signal to run', async () => {
    await expect(mapWithConcurrency([1, 2], 2, async (item) => item + 1)).resolves.toEqual([2, 3])
  })
})

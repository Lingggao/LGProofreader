/**
 * Shared async orchestration helpers.
 *
 * The job orchestrator must never start more than `maxConcurrentWorkers`
 * background model calls at once (design §7.5), across every article and role.
 * `mapWithConcurrency` is the single place that enforces that cap, while keeping
 * the mapping deterministic: results are returned in input order, unrelated to
 * which task finished first.
 *
 * The helper is pure orchestration: no I/O, clock, randomness or environment
 * access, and it never mutates its input. The caller owns the `AbortSignal`:
 * - an already-aborted signal rejects before any task starts;
 * - aborting during the run rejects the returned promise promptly, stops
 *   scheduling new tasks, and forwards the signal to every started task so the
 *   task can abandon its own work (in-flight task promises are drained in the
 *   background and never raise unhandled rejections);
 * - the first task error stops new scheduling and rejects with that error.
 */

/** Normalize a caller-provided concurrency limit to a usable worker count. */
function normalizeLimit(limit: number, total: number): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : total
  return Math.min(Math.max(1, value), Math.max(1, total))
}

/** The caller's abort reason, or a generic `Error` for signals without one. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  return new Error('operation aborted')
}

/**
 * Map `items` through an async `fn` with at most `limit` tasks in flight.
 *
 * @param items  Input items; never mutated.
 * @param limit  Maximum concurrently-running tasks (clamped to `1..items.length`;
 *               non-finite values fall back to "run everything at once").
 * @param fn     Async task; receives the item, its input index and the signal.
 * @param signal Optional caller cancellation.
 * @returns The task results in input order.
 */
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R> | R,
  signal?: AbortSignal,
): Promise<R[]> {
  const list = Array.from(items)
  const total = list.length
  if (total === 0) {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))
    return Promise.resolve([])
  }

  const results = new Array<R>(total)
  const workerCount = normalizeLimit(limit, total)
  let cursor = 0
  let failure: { error: unknown } | undefined

  return new Promise<R[]>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }

    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => {
      finish(() => reject(abortReason(signal as AbortSignal)))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (failure !== undefined) return
        if (signal?.aborted === true) return
        const index = cursor
        cursor += 1
        if (index >= total) return
        try {
          results[index] = await fn(list[index], index, signal as AbortSignal)
        } catch (error) {
          if (failure === undefined) failure = { error }
          return
        }
      }
    }

    const workers = Array.from({ length: workerCount }, () => runWorker())
    void Promise.all(workers).then(
      () => {
        if (failure !== undefined) {
          finish(() => reject(failure?.error))
          return
        }
        if (signal?.aborted === true) {
          finish(() => reject(abortReason(signal as AbortSignal)))
          return
        }
        finish(() => resolve(results))
      },
      (error: unknown) => {
        finish(() => reject(error))
      },
    )
  })
}

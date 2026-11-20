/**
 * Debounced layout persistence (Task 18 fix round; design §6.5/§10.2).
 *
 * The workbench edits the layout locally, but proofreading (Task 13) reads the
 * articles from the Host's document store, so edits must reach the Host via
 * `POST /layout`. Every edit schedules a save of the **latest** `{regions,
 * articles}` snapshot after a short debounce; `flush()` forces the pending save
 * and is awaited before a proofread job starts (the proofread request must see
 * the same article text the user sees).
 *
 * The queue is intentionally small and framework-free: React (`App`) owns the
 * status state, this module owns the timer/in-flight sequencing so a failed save
 * can be retried by the next edit and `flush()` rejects instead of letting a
 * stale layout be proofread.
 */
import type { Article, Region } from '../../shared/types'

/** What `POST /layout` receives for one document. */
export interface LayoutSavePayload {
  regions: Region[]
  articles: Article[]
}

/** Status surfaced by the workbench ("未保存 / 保存中 / 已保存 / 保存失败"). */
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/** Default debounce delay of one layout save, in ms. */
export const DEFAULT_LAYOUT_SAVE_DELAY_MS = 300

/** Options of {@link createLayoutSaver}. */
export interface LayoutSaverOptions {
  /** Persist one snapshot (the App binds this to `WorkbenchApi.saveLayout`). */
  save(docId: string, payload: LayoutSavePayload): Promise<void>
  /** Debounce delay in ms (default 300; `<= 0` saves on the next microtask). */
  delayMs?: number
  /** Status updates for the workbench. Errors thrown here are ignored. */
  onStatus?: (status: SaveStatus) => void
}

/** The debounced save queue owned by one workbench page. */
export interface LayoutSaver {
  /** Queue the latest layout snapshot for `docId` (replaces any pending one). */
  schedule(docId: string, payload: LayoutSavePayload): void
  /**
   * Save the pending snapshot immediately and await it. Resolves when the Host
   * has the latest layout; rejects when the last save attempt failed (so a
   * proofread job is never started against a stale layout).
   */
  flush(): Promise<void>
}

/**
 * Create the debounced save queue.
 *
 * Sequencing rules:
 * - `schedule` replaces the pending payload and restarts the debounce timer, so
 *   a burst of edits produces one save of the newest layout;
 * - only one save is in flight at a time; snapshots scheduled while a save runs
 *   are saved afterwards (latest wins);
 * - after a failed save `flush()` rejects; a later successful save clears the
 *   error and the status becomes `saved` again.
 */
export function createLayoutSaver(options: LayoutSaverOptions): LayoutSaver {
  const delay = Number.isFinite(options.delayMs)
    ? Math.max(0, Math.floor(options.delayMs ?? DEFAULT_LAYOUT_SAVE_DELAY_MS))
    : DEFAULT_LAYOUT_SAVE_DELAY_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { docId: string; payload: LayoutSavePayload } | null = null
  let inflight: Promise<void> | null = null
  let lastError: unknown = null

  const notify = (status: SaveStatus): void => {
    try {
      options.onStatus?.(status)
    } catch {
      // A broken status renderer must never break saving.
    }
  }

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const saveNow = (): Promise<void> => {
    const current = pending
    if (current === null) return Promise.resolve()
    pending = null
    notify('saving')
    const promise = options.save(current.docId, current.payload).then(
      () => {
        lastError = null
      },
      (error: unknown) => {
        lastError = error
      },
    )
    inflight = promise.finally(() => {
      inflight = null
    })
    return inflight.then(() => {
      if (lastError === null && pending === null) notify('saved')
    })
  }

  const drain = async (): Promise<void> => {
    while (inflight !== null || pending !== null) {
      if (inflight !== null) {
        await inflight
        continue
      }
      await saveNow()
    }
    if (lastError !== null) throw lastError
  }

  return {
    schedule(docId, payload) {
      clearTimer()
      pending = { docId, payload }
      notify('pending')
      if (delay <= 0) {
        void drain().catch(() => undefined)
        return
      }
      timer = setTimeout(() => {
        timer = null
        void drain().catch(() => undefined)
      }, delay)
    },
    flush() {
      clearTimer()
      return drain()
    },
  }
}

/**
 * Wrap a proofread call so the pending layout save is flushed first.
 *
 * The Host's proofread job reads the persisted articles, so starting it before
 * the last edit reached `POST /layout` would proofread stale text. If flushing
 * fails the proofread call is **not** made and the failure propagates.
 */
export function flushBeforeProofread<Request, Response>(
  proofread: (request: Request, signal?: AbortSignal) => Promise<Response>,
  flush: () => Promise<void>,
): (request: Request, signal?: AbortSignal) => Promise<Response> {
  return async (request, signal) => {
    await flush()
    return proofread(request, signal)
  }
}

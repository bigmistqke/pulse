import { stabilize } from 'r3'

/** A scheduler decides when the reactive graph is flushed. */
export interface Scheduler {
  /** Request a flush. Called after every write. */
  request(): void
}

/** The function a scheduler calls to actually flush the graph. */
export type FlushFn = () => void

/** The canonical flush: drain r3's dirty heap (recompute computeds, run effects). */
export const flush: FlushFn = () => stabilize()

/** Batches all requests in a tick into one flush on a microtask. The default. */
export function microtaskScheduler(flushFn: FlushFn): Scheduler {
  let queued = false
  return {
    request() {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        // Reset BEFORE flush() so that writes occurring during flush() re-queue
        // the scheduler instead of being dropped (otherwise a write inside an
        // effect would be lost because queued stays true through flush).
        queued = false
        flushFn()
      })
    },
  }
}

/** Flushes synchronously on every request. Useful in tests. */
export function syncScheduler(flushFn: FlushFn): Scheduler {
  return { request: flushFn }
}

let current: Scheduler = microtaskScheduler(flush)

/** Swap the active scheduler. */
export function setScheduler(scheduler: Scheduler): void {
  current = scheduler
}

/** Ask the active scheduler to flush. Called by writers. */
export function requestFlush(): void {
  current.request()
}

// src/pending.ts
import { isPromise } from './is-promise'
import { track } from './async'
import type { Accessor } from './signal'

/** Internal entry describing the pending state of an async-aware accessor.
 *  Registered by `computed` (and any future async-producing primitive) and
 *  consumed by `isPending` / `promiseOf`.
 *
 *  `pending` is a reactive accessor: reading it inside a tracking context
 *  re-fires when this stage flips in/out of pending.
 *  `promise` is a reactive accessor: returns the in-flight Promise for THIS
 *  stage (null if not pending). Pipeline-OR walking is done by
 *  `isPending`/`promiseOf`, not by the entry.
 *  `upstream` (optional) points to the entry of the immediate upstream
 *  stage; the pipeline-OR walk follows this chain.
 */
export interface PendingEntry {
  pending: Accessor<boolean>
  promise: Accessor<Promise<unknown> | null>
  upstream?: PendingEntry
}

const registry = new WeakMap<Accessor<unknown>, PendingEntry>()

/** Register an accessor with the pending tracker. Called by primitives that
 *  produce async-aware accessors (currently: `computed`). */
export function registerPending(accessor: Accessor<unknown>, entry: PendingEntry): void {
  registry.set(accessor, entry)
}

/** Look up the pending entry for an accessor, if registered. Internal. */
export function lookupPending(accessor: Accessor<unknown>): PendingEntry | undefined {
  return registry.get(accessor)
}

/** Reactive accessor: is this signal/computed (or anything upstream) pending?
 *  Returns `() => boolean`. Read inside a tracking context to subscribe. */
export function isPending<T>(x: Accessor<T>): Accessor<boolean> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry !== undefined) {
      // Walk the chain: pending if this stage OR any upstream is.
      let cur: PendingEntry | undefined = entry
      while (cur !== undefined) {
        if (cur.pending()) return true
        cur = cur.upstream
      }
      return false
    }
    // Fallback: inspect the value — signals holding a Promise are pending
    // until that Promise settles.
    const value = x()
    if (!isPromise(value)) return false
    return track(value).status === 'pending'
  }
}

/** Reactive accessor: the in-flight Promise for this stage, or anything
 *  upstream that is pending. Returns `null` when nothing is pending. */
export function promiseOf<T>(x: Accessor<T>): Accessor<Promise<T> | null> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry !== undefined) {
      // Return the deepest in-flight Promise found by walking upstream.
      // "Deepest" = closest to the user's read site that is actually pending.
      // We walk top-down (this stage first) so local takes precedence.
      let cur: PendingEntry | undefined = entry
      while (cur !== undefined) {
        const p = cur.promise()
        if (p !== null) return p as Promise<T> | null
        cur = cur.upstream
      }
      return null
    }
    const value = x()
    if (!isPromise(value)) return null
    return track(value).status === 'pending' ? (value as Promise<T>) : null
  }
}

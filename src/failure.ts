// src/failure.ts
import type { Accessor } from './signal'

/**
 * A failure is graph state, exactly like pending — parked out of band, propagating
 * along the upstream chain, and NOT destroying the value the node last resolved
 * to. This is the mirror of `pending.ts`.
 *
 * `error` is reactive: reading it inside a tracking context re-fires when this
 * node fails or recovers.
 *
 * `value` reads the node's published value WITHOUT the error conversion — the raw,
 * non-throwing read. It is what lets `latest` degrade to the stale value instead
 * of throwing.
 *
 * `upstream` points at the immediate upstream stage's entry; the walk follows the
 * chain, the same way `isPending` does.
 */
export interface FailureEntry {
  error: Accessor<unknown>
  value: Accessor<unknown>
  upstream?: FailureEntry
}

const registry = new WeakMap<Accessor<unknown>, FailureEntry>()

/** Register a node with the failure tracker. Called by `computed`. */
export function registerFailure(accessor: Accessor<unknown>, entry: FailureEntry): void {
  registry.set(accessor, entry)
}

/** Look up a node's failure entry, if registered. Internal. */
export function lookupFailure(accessor: Accessor<unknown>): FailureEntry | undefined {
  return registry.get(accessor)
}

/**
 * Reactive accessor: has this node — or anything upstream — failed? Returns the
 * error, or `null` when healthy. Read inside a tracking context to subscribe.
 *
 * This is the *query* view of a failure. The other views of the same state:
 * `use(x)` throws it (the fatal read, which an error boundary catches), and
 * `latest(x)` ignores it and returns the stale value (the tolerant read).
 */
export function failure<T>(x: Accessor<T>): Accessor<unknown> {
  return () => {
    let cur = registry.get(x as Accessor<unknown>)
    while (cur !== undefined) {
      const e = cur.error()
      if (e !== null && e !== undefined) return e
      cur = cur.upstream
    }
    return null
  }
}

/** The node's published value read WITHOUT the error conversion, so a tolerant
 *  read can degrade to it. Falls back to calling the accessor when the node is
 *  not registered (a plain signal, which never parks an error anyway). */
export function rawValueOf<T>(x: Accessor<T>): T {
  const entry = registry.get(x as Accessor<unknown>)
  return (entry !== undefined ? (entry.value() as T) : x())
}

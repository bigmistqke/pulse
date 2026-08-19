// src/error.ts
import type { Accessor } from './signal'

/**
 * An error is graph state, exactly like pending — parked out of band, propagating
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
export interface ErrorEntry {
  error: Accessor<unknown>
  value: Accessor<unknown>
  /** Clear this node's parked error and recompute it. */
  reset: () => void
  upstream?: ErrorEntry
}

const registry = new WeakMap<Accessor<unknown>, ErrorEntry>()

/** Register a node with the error tracker. Called by `computed`. */
export function registerError(accessor: Accessor<unknown>, entry: ErrorEntry): void {
  registry.set(accessor, entry)
}

/** Look up a node's error entry, if registered. Internal. */
export function lookupError(accessor: Accessor<unknown>): ErrorEntry | undefined {
  return registry.get(accessor)
}

/**
 * Has this node — or anything upstream — failed? Returns the error, or `null` when
 * healthy. Reactive: it reads the underlying error signals, so calling it inside
 * a tracking context subscribes, and it re-fires on error or recovery.
 *
 * Reads DIRECTLY, like `latest` — not as an accessor-returning factory. (`isPending`
 * still has that older shape; it is the odd one out.)
 *
 * This is the *query* projection of the error state. The others: `latest(x)`
 * projects the value (and so never throws), and `use(x)` is the strict combinator
 * that treats "unavailable" as fatal and throws — which is what feeds an error
 * boundary.
 */
export function error<T>(x: Accessor<T>): unknown {
  let cur = registry.get(x as Accessor<unknown>)
  while (cur !== undefined) {
    const e = cur.error()
    if (e !== null && e !== undefined) return e
    cur = cur.upstream
  }
  return null
}

/** The node's published value read WITHOUT the error conversion, so a tolerant
 *  read can degrade to it. Falls back to calling the accessor when the node is
 *  not registered (a plain signal, which never parks an error anyway). */
export function rawValueOf<T>(x: Accessor<T>): T {
  const entry = registry.get(x as Accessor<unknown>)
  return (entry !== undefined ? (entry.value() as T) : x())
}

/**
 * Clear the error at the ROOT of this node's upstream chain and recompute it.
 *
 * A downstream stage only propagates its upstream's error. Resetting it alone
 * would leave the real source parked, and the retry would fail identically. So walk
 * the chain the way `error()` does and reset the deepest stage that is actually
 * failed — the one the error originated in.
 *
 * A no-op if nothing in the chain is failed, or the node is not registered (a plain
 * signal, which never parks an error).
 */
export function resetError<T>(x: Accessor<T>): void {
  let cur = registry.get(x as Accessor<unknown>)
  let root: ErrorEntry | undefined
  while (cur !== undefined) {
    const e = cur.error()
    if (e !== null && e !== undefined) root = cur
    cur = cur.upstream
  }
  root?.reset()
}

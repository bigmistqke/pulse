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
  /** Sources whose values this node's recipe read through a verb on its last
   *  run — its DYNAMIC upstream, as opposed to the static pipeline chain that
   *  `upstream` holds.
   *
   *  This is what carries loading state across a tolerant read. A node that
   *  read `latest(x)` holds a value and is not itself suspended, so its own
   *  `pending` is false, but the value it holds was computed from `x` and will
   *  change when `x` resolves. Walking these makes `isPending` report that,
   *  and it stays correct without the node re-running because each recorded
   *  source is consulted live rather than at record time.
   *
   *  Reactive: reading it subscribes to the recorded collection changing, so a
   *  consumer re-evaluates when the node's next run reads a different set. */
  reads?: Accessor<readonly Accessor<unknown>[]>
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

/** Is this signal/computed (or anything upstream) pending right now? Reactive
 *  — reads the underlying tracked accessors, so calling this inside a
 *  tracking context subscribes. Call fresh at each read site (an effect
 *  body, a getter-converted prop) rather than storing the result, the same
 *  way a `signal()` read is meant to be called fresh. */
export function isPending<T>(x: Accessor<T>): boolean {
  return sourcePending(x as Accessor<unknown>, null)
}

/** Is this source pending, following both its static pipeline chain and the
 *  dynamic reads its recipe made? Falls back to inspecting the value for an
 *  accessor that was never registered — a plain signal holding a Promise is
 *  pending until that Promise settles. */
function sourcePending(
  source: Accessor<unknown>,
  seen: Set<PendingEntry> | null,
): boolean {
  const entry = registry.get(source)
  if (entry !== undefined) return entryPending(entry, seen)
  const value = source()
  if (!isPromise(value)) return false
  return track(value).status === 'pending'
}

/** Walk one entry: this stage, then anything its recipe read, then upstream.
 *
 *  `seen` is created only once a dynamic read is actually encountered, so the
 *  common case — a pipeline whose stages read nothing through a verb — walks a
 *  finite chain and allocates nothing. Cycles are only reachable through the
 *  dynamic reads, which is exactly where the guard is armed. */
function entryPending(entry: PendingEntry, seen: Set<PendingEntry> | null): boolean {
  let cur: PendingEntry | undefined = entry
  while (cur !== undefined) {
    if (cur.pending()) return true
    const sources = cur.reads?.()
    if (sources !== undefined && sources.length > 0) {
      if (seen === null) seen = new Set()
      if (seen.has(cur)) return false
      seen.add(cur)
      for (const source of sources) {
        if (sourcePending(source, seen)) return true
      }
    }
    cur = cur.upstream
  }
  return false
}

/** The in-flight Promise for this stage, or anything upstream that is
 *  pending — `null` when nothing is pending. Reactive; call fresh at each
 *  read site, same as `isPending`. */
export function promiseOf<T>(x: Accessor<T>): Promise<T> | null {
  return sourcePromise(x as Accessor<unknown>, null) as Promise<T> | null
}

/** The in-flight Promise behind this source, following the same two chains
 *  `sourcePending` follows. Most-local wins: this stage first, then what its
 *  recipe read, then upstream. */
function sourcePromise(
  source: Accessor<unknown>,
  seen: Set<PendingEntry> | null,
): Promise<unknown> | null {
  const entry = registry.get(source)
  if (entry !== undefined) return entryPromise(entry, seen)
  const value = source()
  if (!isPromise(value)) return null
  return track(value).status === 'pending' ? value : null
}

function entryPromise(
  entry: PendingEntry,
  seen: Set<PendingEntry> | null,
): Promise<unknown> | null {
  let cur: PendingEntry | undefined = entry
  while (cur !== undefined) {
    const own = cur.promise()
    if (own !== null) return own
    const sources = cur.reads?.()
    if (sources !== undefined && sources.length > 0) {
      if (seen === null) seen = new Set()
      if (seen.has(cur)) return null
      seen.add(cur)
      for (const source of sources) {
        const found = sourcePromise(source, seen)
        if (found !== null) return found
      }
    }
    cur = cur.upstream
  }
  return null
}

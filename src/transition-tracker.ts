/**
 * Module-level tracker for what happened during the current binding compute —
 * which pending sources it read the value of, whether `use()` was engaged, and
 * which node's parked error (if any) the compute threw.
 *
 * When a binding's compute function calls `use(...)` — even if it doesn't
 * throw — we want that binding to participate in transition coordination with
 * the nearest `<Loading>` boundary. This module provides:
 *
 * - `markUsedInBinding()`: called by `use()` unconditionally to flag engagement.
 * - `markPendingValueRead()`: called by `latest()` whenever the source it read
 *   is pending, recording WHICH source and whether that source has resolved
 *   before. The boundary needs the second fact to tell a background refresh
 *   apart from a genuine first load.
 * - `runBindingCompute(fn)`: wraps a binding's compute, captures both, and
 *   returns them alongside the computed value.
 *
 * It also tracks which node's parked error (if any) the compute threw, so the
 * binding's catch handler can hand that provenance to an `<Errored>` boundary:
 *
 * - `markErrorSource()`: called by a computed's accessor right before it
 *   throws its parked error.
 * - `takeErrorSource()`: called by the catch handler after the throw has
 *   unwound, to read and clear the recorded source.
 * - `clearErrorSource()`: called at the entry of a consumer that does not go
 *   through `runBindingCompute` (a plain `effect()`), to clear a stale source
 *   left behind by an earlier, unrelated compute without reading it.
 *
 * The prev/finally restoration in `runBindingCompute` correctly handles nested
 * compute frames (e.g., a reactive child inside a reactive prop) for DOM bindings,
 * which all route their compute through `runBindingCompute`. The invariant this
 * whole module depends on is broader than that one function, though: EVERY
 * consumer of the error source must clear it on entry, not just read it —
 * otherwise a source set by one binding's throw can survive past that binding and
 * be picked up by a later, unrelated one. `runBindingCompute` is what satisfies
 * this invariant for bindings; a plain `effect()` does not go through it (it calls
 * its body directly), so it clears the source itself at the start of its own body.
 */

import type { Accessor } from './signal'

/**
 * One pending source whose VALUE a binding compute read.
 *
 * Reading a source's value is what makes a binding depend on that source
 * settling. Reading only its pending state — `isPending(x)` on its own — is
 * not recorded here, because a binding that merely reports staleness must keep
 * updating during exactly the window it exists to describe.
 */
export interface PendingValueRead {
  /** The source that was read. Reads are deduplicated on this within a single
   *  compute, so a binding that reads the same source six times records it
   *  once. */
  source: Accessor<unknown>
  /** The promise that source is waiting on right now. */
  promise: Promise<unknown>
  /** Whether this source has ever resolved a real value before. A boundary
   *  treats the two cases oppositely: a source that has resolved before is
   *  refreshing behind content that is already on screen, and one that has not
   *  is loading for the first time, which is what a placeholder is for. */
  everResolved: boolean
}

/** Shared empty result, so a compute that read nothing pending — the common
 *  case — allocates nothing. */
const NO_PENDING_READS: readonly PendingValueRead[] = []

let usedInCurrentBinding = false
let errorSourceInCurrentBinding: Accessor<unknown> | null = null
let pendingValueReadsInCurrentBinding: Map<Accessor<unknown>, PendingValueRead> | null = null
let ambientErrorInCurrentBinding: { error: unknown; source: Accessor<unknown> } | null = null

/** Called by `use()` to mark the current binding as engaged in transition coordination. */
export function markUsedInBinding(): void {
  usedInCurrentBinding = true
}

/**
 * Called by `latest()` when the source it read is pending. Records the source
 * itself rather than only its promise, so a compute that read two pending
 * sources reports both — the single-promise slot this replaced kept only
 * whichever read happened last.
 *
 * A source with a construction-time fallback (`signal(fn, default)`) still
 * reports with `everResolved` false until it genuinely resolves: `peek` hands
 * back the default, so there IS a value to show from the caller's point of
 * view, but a seed says what to display meanwhile rather than that the fetch
 * has finished. See ADR 0015.
 */
export function markPendingValueRead(
  source: Accessor<unknown>,
  promise: Promise<unknown>,
  everResolved: boolean,
): void {
  if (pendingValueReadsInCurrentBinding === null) {
    pendingValueReadsInCurrentBinding = new Map()
  }
  pendingValueReadsInCurrentBinding.set(source, { source, promise, everResolved })
}

/**
 * Called by `latest()` when the accessor it read is parked in an error state.
 * The tolerant read degrades to the last good value rather than throwing, so
 * without this the error would reach no `<Errored>` at all — the boundary's
 * only other intake is a binding that threw. Reported ambiently instead, from
 * the accessor's own state, so a subtree that reads exclusively through
 * `latest()` still participates in error boundaries.
 *
 * Distinct from `markErrorSource` below, which serves the THROW path: that one
 * records provenance for an error already unwinding the stack, this one is the
 * whole report for an error that never throws at all.
 */
export function markAmbientError(error: unknown, source: Accessor<unknown>): void {
  ambientErrorInCurrentBinding = { error, source }
}

/** Called by a computed's accessor before it throws its parked error, so the
 *  binding that catches it knows WHICH node failed and can reset it. */
export function markErrorSource(source: Accessor<unknown>): void {
  errorSourceInCurrentBinding = source
}

/**
 * The node whose parked error was thrown during the binding compute that just
 * threw, or `null` if the throw did not come from one. Reading it clears it.
 *
 * Called from the CATCH handler, after `runBindingCompute` has unwound. That is why
 * `runBindingCompute` restores this flag only on its success path: on the throw path
 * the value has to survive the unwind so the catcher can take it.
 */
export function takeErrorSource(): Accessor<unknown> | null {
  const source = errorSourceInCurrentBinding
  errorSourceInCurrentBinding = null
  return source
}

/**
 * Clear the recorded error source without reading it. Called at the ENTRY of a
 * consumer that does not go through `runBindingCompute` (a plain `effect()`), to
 * satisfy the invariant that every consumer clears the source on entry rather than
 * only when a catch handler happens to run. Unlike `takeErrorSource()`, the
 * caller has no use for the discarded value — it exists purely to prevent a stale
 * source (set by an earlier, unrelated compute) from being misattributed here.
 */
export function clearErrorSource(): void {
  errorSourceInCurrentBinding = null
}

/**
 * Run `fn` as a binding compute, capturing what it read and whether `use()`
 * was called inside it. Restores the prior state on return (handles nesting).
 */
export function runBindingCompute<T>(fn: () => T): {
  value: T
  engagedTransition: boolean
  pendingReads: readonly PendingValueRead[]
  ambientError: { error: unknown; source: Accessor<unknown> } | null
} {
  const prevUsed = usedInCurrentBinding
  const prevSource = errorSourceInCurrentBinding
  const prevPendingReads = pendingValueReadsInCurrentBinding
  const prevAmbientError = ambientErrorInCurrentBinding
  usedInCurrentBinding = false
  errorSourceInCurrentBinding = null
  pendingValueReadsInCurrentBinding = null
  ambientErrorInCurrentBinding = null
  try {
    const value = fn()
    // Success: nothing threw, so no catcher is waiting to take the source.
    errorSourceInCurrentBinding = prevSource
    // The cast defeats control-flow narrowing: this slot was set to null a few
    // lines above, and TypeScript does not model `fn()` writing to a
    // module-level variable, so without it the non-null branch narrows to
    // `never`. Filling the slot during `fn()` is the entire point of it.
    const collected = pendingValueReadsInCurrentBinding as Map<
      Accessor<unknown>,
      PendingValueRead
    > | null
    return {
      value,
      engagedTransition: usedInCurrentBinding,
      pendingReads: collected === null ? NO_PENDING_READS : Array.from(collected.values()),
      ambientError: ambientErrorInCurrentBinding,
    }
  } finally {
    usedInCurrentBinding = prevUsed
    pendingValueReadsInCurrentBinding = prevPendingReads
    ambientErrorInCurrentBinding = prevAmbientError
  }
}

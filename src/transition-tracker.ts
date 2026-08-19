/**
 * Module-level tracker for what happened during the current binding compute —
 * not only whether `use()` was engaged, but also which node's parked error
 * (if any) the compute threw.
 *
 * When a binding's compute function calls `use(...)` — even if it doesn't
 * throw — we want that binding to participate in transition coordination with
 * the nearest `<Loading>` boundary. This module provides:
 *
 * - `markUsedInBinding()`: called by `use()` unconditionally to flag engagement.
 * - `runBindingCompute(fn)`: wraps a binding's compute, captures the flag, and
 *   returns both the computed value and whether `use()` was called.
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

let usedInCurrentBinding = false
let errorSourceInCurrentBinding: Accessor<unknown> | null = null

/** Called by `use()` to mark the current binding as engaged in transition coordination. */
export function markUsedInBinding(): void {
  usedInCurrentBinding = true
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
 * Run `fn` as a binding compute, capturing whether `use()` was called inside it.
 * Restores the prior flag state on return (handles nesting).
 */
export function runBindingCompute<T>(fn: () => T): { value: T; engagedTransition: boolean } {
  const prevUsed = usedInCurrentBinding
  const prevSource = errorSourceInCurrentBinding
  usedInCurrentBinding = false
  errorSourceInCurrentBinding = null
  try {
    const value = fn()
    // Success: nothing threw, so no catcher is waiting to take the source.
    errorSourceInCurrentBinding = prevSource
    return { value, engagedTransition: usedInCurrentBinding }
  } finally {
    usedInCurrentBinding = prevUsed
  }
}

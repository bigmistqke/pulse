/**
 * Module-level tracker for whether the current binding compute called `use()`.
 *
 * When a binding's compute function calls `use(...)` — even if it doesn't
 * throw — we want that binding to participate in transition coordination with
 * the nearest `<Loading>` boundary. This module provides:
 *
 * - `markUsedInBinding()`: called by `use()` unconditionally to flag engagement.
 * - `runBindingCompute(fn)`: wraps a binding's compute, captures the flag, and
 *   returns both the computed value and whether `use()` was called.
 *
 * The prev/finally restoration in `runBindingCompute` correctly handles nested
 * compute frames (e.g., a reactive child inside a reactive prop).
 */

let usedInCurrentBinding = false

/** Called by `use()` to mark the current binding as engaged in transition coordination. */
export function markUsedInBinding(): void {
  usedInCurrentBinding = true
}

/**
 * Run `fn` as a binding compute, capturing whether `use()` was called inside it.
 * Restores the prior flag state on return (handles nesting).
 */
export function runBindingCompute<T>(fn: () => T): { value: T; engagedTransition: boolean } {
  const prev = usedInCurrentBinding
  usedInCurrentBinding = false
  try {
    const value = fn()
    return { value, engagedTransition: usedInCurrentBinding }
  } finally {
    usedInCurrentBinding = prev
  }
}

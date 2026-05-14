import { computed as r3Computed } from 'r3'

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs (after the scheduler flushes) whenever a signal it read changes.
 *
 * Implemented as an r3 computed whose return value is unused — the scheduler's
 * `flush` (stabilize) re-runs it when r3 marks it dirty.
 */
export function effect(fn: () => void): void {
  r3Computed(fn)
}

/** Register a cleanup function for the current effect/computed. r3's, re-exported. */
export { onCleanup } from 'r3'

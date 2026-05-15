import { isPromise } from './is-promise'
import type { Signal } from './signal'

/** Reactive predicate: is the signal's current value a (pending) promise? */
export function isPending(s: Signal<unknown>): boolean {
  return isPromise(s())
}

/**
 * Records the most recent resolved value observed for each signal. Keyed on the
 * signal (accessor) object — entries are garbage-collected with the signal.
 */
const lastResolved = new WeakMap<object, unknown>()

/**
 * The latest *resolved* value of a signal. Returns `undefined` until the signal
 * first resolves, then always the most recent resolved value — it does NOT
 * revert to `undefined` while a newer promise is pending (stale-while-revalidate).
 * Reactive: reads `s()`, so it re-evaluates when the signal changes.
 */
export function latest<T>(s: Signal<T>): Awaited<T> | undefined {
  const value = s()
  if (isPromise(value)) {
    return lastResolved.get(s) as Awaited<T> | undefined
  }
  lastResolved.set(s, value)
  return value as Awaited<T>
}

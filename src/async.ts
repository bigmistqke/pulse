import { isPromise } from './is-promise'
import type { Signal } from './signal'

/** Reactive predicate: is the signal's current value a (pending) promise? */
export function isPending(s: Signal<unknown>): boolean {
  return isPromise(s())
}

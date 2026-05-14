import { computed as r3Computed } from 'r3'
import { makeAccessor, type Signal } from './signal'

/** Create a derived signal from a single computation function. */
export function computed<T>(fn: () => T): Signal<T> {
  return makeAccessor(r3Computed(fn))
}

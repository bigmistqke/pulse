import type { Child } from './h'
import { mapArray } from './map-array'

export interface ForProps<T> {
  each: T[] | Promise<T[]> | (() => T[] | Promise<T[]>)
  fallback?: Child
  children: (item: T, index: () => number) => Child
}

/**
 * Render one row per item in `each`. Rows are reference-keyed: the array
 * slot's value is the key. Reorders preserve row identity (same DOM
 * nodes, repositioned). Empty `each` (or pending `Promise<T[]>`) renders
 * `fallback`.
 *
 * The renderer receives `(item, index)` where `index` is an accessor that
 * updates when the row's position changes.
 *
 * See `mapArray` for the reconciliation engine. `For` adds the
 * fallback-on-empty handoff and flattens row outputs into a single
 * Node sequence.
 */
export function For<T>(props: ForProps<T>): () => unknown {
  const mapped = mapArray<T, Child>(props.each, props.children)
  return () => {
    const flat = mapped().flat()
    return flat.length === 0 ? props.fallback : flat
  }
}

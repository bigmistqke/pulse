import type { Child } from './h'
import { mapArray } from './map-array'
import { readDynamic } from './resolve'

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
  // props.each is read here, once, at construction (component-runs-once) -
  // eagerly reading a getter-backed prop here would take a one-time
  // snapshot, not live reactivity. mapArray calls its `list` argument
  // itself, every time it runs, so wrapping the read in a thunk lets it
  // re-trigger the getter fresh each time. readDynamic then handles the
  // OTHER shape `each` can still legitimately have: an explicitly
  // hand-written accessor function (e.g. one that calls use() inside,
  // which the compiler always leaves as a real function, never a getter).
  const mapped = mapArray<T, Child>(() => readDynamic(props, 'each') as T[] | Promise<T[]>, props.children)
  return () => {
    const flat = mapped().flat()
    // Read directly inside this closure, which itself re-runs on every
    // reactive pass (via insertChild's effect) - a getter-backed fallback
    // is already live here, no unwrap needed.
    return flat.length === 0 ? props.fallback : flat
  }
}

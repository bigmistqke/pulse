import { untrack } from 'r3'
import { isPromise } from '../is-promise'
import { createSubOwner, disposeOwner, getOwner, runWithOwner, type Owner } from '../owner'
import { signal, type Accessor, type Setter } from '../signal'

type Entry<T, U> = {
  item: T
  mapped: U
  indexAccessor: Accessor<number>
  setIndex: Setter<number>
  owner: Owner
}

/**
 * Reactive list-with-identity-preserving-disposal engine.
 *
 * `list` may be an array, a Promise of an array, or a function returning
 * either. The mapper is called once per **new** item (matched by strict
 * reference equality). Items that survive across runs reuse their mapped
 * output (same reference) and their per-item sub-owner. Items that leave
 * have their sub-owner disposed (cascading any onCleanup / effects the
 * mapper created).
 *
 * Output order matches the current `list` order — so consumers (like
 * `For`) can render entries at the right DOM positions.
 *
 * `index` is a signal accessor reflecting the item's current position;
 * reorders update via `setSignal(indexSig, newIndex)`.
 *
 * Pending `Promise<T[]>` coerces to `[]` (mirrors spec §5's pending-as-
 * empty rule for lists).
 *
 * Internal — not exported from the public barrel.
 */
export function mapArray<T, U>(
  list: T[] | Promise<T[]> | (() => T[] | Promise<T[]>),
  mapFn: (item: T, index: () => number) => U,
): () => U[] {
  const parentOwner = getOwner()
  let entries = new Map<T, Entry<T, U>>()

  return () => {
    const raw = typeof list === 'function' ? list() : list
    const arr: T[] = isPromise(raw) || !Array.isArray(raw) ? [] : raw

    const next = new Map<T, Entry<T, U>>()
    const output: U[] = []
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      let entry = entries.get(item)
      if (entry !== undefined) {
        if (entry.indexAccessor() !== i) entry.setIndex(i)
      } else {
        const owner = createSubOwner(parentOwner)
        const [indexAccessor, setIndex] = signal(i)
        const mapped = untrack(() => runWithOwner(owner, () => mapFn(item, () => indexAccessor())))
        entry = { item, mapped, indexAccessor, setIndex, owner }
      }
      next.set(item, entry)
      output.push(entry.mapped)
    }

    for (const [item, entry] of entries) {
      if (!next.has(item)) disposeOwner(entry.owner)
    }
    entries = next
    return output
  }
}

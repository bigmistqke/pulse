import {
  getContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  untrack,
  type Computed as R3Computed,
  type Signal as R3Signal,
} from 'r3'
import { requestFlush } from './scheduler'
import { isPromise } from './is-promise'
import { track } from './async'
import { readValue, signalNode, writeValue } from './scope'

/** The underlying r3 node behind any pulse signal or computed accessor. */
type R3Node<T> = R3Signal<T> | R3Computed<T>

/** Internal key under which a pulse accessor stashes its r3 node. */
export const NODE = Symbol('pulse.node')

/** A pulse signal or computed: an accessor function carrying its r3 node. */
export interface Signal<T> {
  (): T
  [NODE]: R3Node<T>
}

/** A callable that reads a reactive signal or computed value. */
export type Accessor<T> = () => T

/** A function that writes a new value into a signal, or updates it via a function. */
export type Setter<T> = (next: T | ((prev: T) => T)) => void

/**
 * Wrap an r3 node in a pull-on-read accessor.
 * - Inside an r3 context: delegate to r3's `read` (tracks the dep, pulls computeds).
 * - At top level: `stabilize()` first so the value is never stale, then read.
 */
export function makeAccessor<T>(node: R3Node<T>): Signal<T> {
  const accessor = (() => {
    if (getContext()) return r3Read(node)
    stabilize()
    return node.value
  }) as Signal<T>
  accessor[NODE] = node
  return accessor
}

/** Create a writable reactive signal, returning an [accessor, setter] tuple.
 *  A signal stores exactly what you put in it — Promise values are NOT
 *  auto-resolved. For async derivations use `computed(() => fetchX())` or
 *  read a Promise-valued signal at the leaf via `use(signal())`. */
export function signal<T>(initial: T): [Accessor<T>, Setter<T>] {
  const node = signalNode(initial)

  // Eagerly install the .then listener on Promise values (unchanged behavior).
  if (isPromise(initial)) track(initial)

  const accessor = (() => readValue(node)) as Signal<T>
  // NODE stays the r3 backing node — async.ts's presence check and any
  // r3-node consumer keep working; the scope Node is closure-captured.
  accessor[NODE] = node.backing!

  const setter: Setter<T> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: T) => T)(untrack(() => readValue(node)))
        : next
    // Register a promise write and seed the stale-while-revalidate prior from the
    // current value, so latest()/use() can read the previous value while the new
    // one is pending. The stored value is the plain promise — no wrapper.
    if (isPromise(value) && getContext() === null) {
      const cur = untrack(() => readValue(node)) as unknown
      const prior = isPromise(cur) ? track(cur as Promise<unknown>).value : cur
      track(value as Promise<unknown>, prior)
    }
    writeValue(node, value)
    requestFlush()
  }

  return [accessor, setter]
}

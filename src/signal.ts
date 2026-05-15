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

/**
 * Per-signal generation counter. Every write bumps it; a scheduled write-back
 * captures the generation at schedule time and applies only if it still matches —
 * so a superseded (stale) promise cannot clobber a newer value.
 */
const generation = new WeakMap<object, number>()

/**
 * If `value` is a promise, schedule its resolved value to be written back into
 * the signal once it settles — unless the signal has been re-assigned since
 * (generation guard). A rejected promise does not write back; the signal keeps
 * holding the rejected promise and `use` surfaces the rejection when the value
 * is read.
 */
function scheduleWriteBack(
  node: R3Signal<unknown>,
  genKey: object,
  value: unknown,
  write: (v: unknown) => void,
): void {
  if (!isPromise(value)) return
  const captured = generation.get(genKey) ?? 0
  value.then(
    (resolved) => {
      if ((generation.get(genKey) ?? 0) === captured) write(resolved)
    },
    () => {
      // Rejected: write-back is happy-path only (error boundaries are Plan 2c).
    },
  )
}

/** Create a writable reactive signal, returning an [accessor, setter] tuple. */
export function signal<T>(initial: T): [Accessor<Awaited<T> | T>, Setter<Awaited<T> | T>] {
  const r3Node = r3Signal(initial) as R3Signal<Awaited<T> | T>
  const accessor = makeAccessor(r3Node) as Signal<Awaited<T> | T>
  // Use the accessor object as the generation key (stable object identity).
  const genKey = accessor
  generation.set(genKey, 0)

  const write = (value: Awaited<T> | T): void => {
    generation.set(genKey, (generation.get(genKey) ?? 0) + 1)
    r3SetSignal(r3Node, value)
    scheduleWriteBack(r3Node as R3Signal<unknown>, genKey, value, write as (v: unknown) => void)
    requestFlush()
  }

  const setter: Setter<Awaited<T> | T> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: Awaited<T> | T) => Awaited<T> | T)(untrack(() => accessor()))
        : next
    write(value)
  }

  scheduleWriteBack(r3Node as R3Signal<unknown>, genKey, initial, write as (v: unknown) => void)

  return [accessor, setter]
}

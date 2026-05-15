import {
  getContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  type Computed as R3Computed,
  type Signal as R3Signal,
} from 'r3'
import { requestFlush } from './scheduler'

/** The underlying r3 node behind any pulse signal or computed accessor. */
type R3Node<T> = R3Signal<T> | R3Computed<T>

/** Internal key under which a pulse accessor stashes its r3 node. */
export const NODE = Symbol('pulse.node')

/** Nominal brand distinguishing writable signals from read-only computeds. */
declare const WRITABLE: unique symbol

/** A pulse signal or computed: an accessor function carrying its r3 node. */
export interface Signal<T> {
  (): T
  [NODE]: R3Node<T>
}

/** A writable pulse signal: branded subtype of Signal that setSignal will accept. */
export interface WritableSignal<T> extends Signal<T> {
  readonly [WRITABLE]: true
}

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

/** Create a writable reactive signal. */
export function signal<T>(initial: T): WritableSignal<Awaited<T> | T> {
  return makeAccessor(r3Signal(initial)) as WritableSignal<Awaited<T> | T>
}

/** Write a new value into a signal and request a scheduler flush. */
export function setSignal<T>(s: WritableSignal<T>, value: T): void {
  r3SetSignal(s[NODE] as R3Signal<T>, value)
  requestFlush()
}

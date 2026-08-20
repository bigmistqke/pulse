import { latest, type WithFallback } from './async'
import { committed, getCurrentScope, onSettled, ROOT_SCOPE, type Scope } from './scope'
import { signal, type Accessor } from './signal'

/** Distinguishes "no overlay is live" from any real overlay value, including
 *  undefined, so the reader can fall back to the canonical value only when the
 *  stack is genuinely empty. */
const EMPTY = Symbol('empty')

/**
 * Wrap a signal with an optimistic-UI overlay. Returns a three-tuple:
 *
 * - a reader that returns the most recent in-flight overlay value if any action
 *   has one live, and the wrapped signal's canonical value otherwise;
 * - a setter that writes an overlay layer keyed to the enclosing action, and
 *   throws when called with no active speculative scope;
 * - a reactive boolean that is true while any overlay is live.
 *
 * `source` is the signal being overlaid, passed directly — not a thunk that
 * reads it. The canonical read is `latest(source)`, made here rather than at
 * the call site: an overlay layers plain values over plain values, so a
 * fetch-backed source has to be read tolerantly (its raw read is
 * `T | Promise<T>`, and there is nothing sensible to overlay onto a Promise).
 * Reading through `latest` rather than `peek` also means a binding that
 * consumes the overlay ambiently reports a background refresh of `source` to
 * its nearest `<Loading>` boundary — see ADR 0015. The overloads mirror
 * `latest`'s own: a `signal(fn, default)` source carries its fallback in its
 * type, any other source can be given one as a second argument, and without
 * either the reader includes `undefined` for the window before `source` has
 * ever resolved.
 *
 * The overlay deliberately leaks past a speculation's isolation: its backing
 * write is forced to committed state, so consumers binding outside the writing
 * action see it immediately and reactively. Each action's overlay is removed
 * when that action closes — on both the commit and the discard face — via
 * onSettled. Reading the wrapped signal directly still reports canonical truth.
 */
export function optimistic<T, D>(
  source: WithFallback<Accessor<T>, D>,
): [Accessor<Awaited<T> | D>, (value: Awaited<T> | D) => void, Accessor<boolean>]
export function optimistic<T>(
  source: Accessor<T>,
): [Accessor<Awaited<T> | undefined>, (value: Awaited<T>) => void, Accessor<boolean>]
export function optimistic<T, D>(
  source: Accessor<T>,
  fallback: D,
): [Accessor<Awaited<T> | D>, (value: Awaited<T> | D) => void, Accessor<boolean>]
export function optimistic<T, D>(
  source: Accessor<T>,
  fallback?: D,
): [Accessor<unknown>, (value: never) => void, Accessor<boolean>] {
  type Overlaid = Awaited<T> | D
  // One entry per action that currently has a live overlay. A Map iterates in
  // insertion order, so the most recently written entry is the top of the stack.
  const overlays = new Map<Scope, Overlaid>()
  const [top, setTop] = signal<Overlaid | typeof EMPTY>(EMPTY)

  const publishTop = (): void => {
    let current: Overlaid | typeof EMPTY = EMPTY
    for (const overlayValue of overlays.values()) current = overlayValue
    // Force the write to committed state so it is visible outside the writing
    // action and is a real reactive write, rather than being isolated to the
    // action's own speculative slot.
    committed(() => setTop(current))
  }

  const setOptimisticValue = (value: Overlaid): void => {
    const scope = getCurrentScope()
    if (scope === ROOT_SCOPE) {
      throw new Error('setOptimisticValue requires an active speculative scope')
    }
    const firstForScope = !overlays.has(scope)
    // Re-insert so a repeated write from the same action bumps it to the top of
    // the stack rather than adding a second entry.
    overlays.delete(scope)
    overlays.set(scope, value)
    publishTop()
    if (firstForScope) {
      onSettled(() => {
        overlays.delete(scope)
        publishTop()
      })
    }
  }

  const optimisticValue: Accessor<Overlaid> = () => {
    const current = top()
    return current === EMPTY ? (latest(source, fallback as D) as Overlaid) : current
  }
  const isOptimistic: Accessor<boolean> = () => top() !== EMPTY

  return [
    optimisticValue,
    setOptimisticValue as (value: never) => void,
    isOptimistic,
  ]
}

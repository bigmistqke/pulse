import { committed, getCurrentScope, onSettle, ROOT_SCOPE, type Scope } from './scope'
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
 * The overlay deliberately leaks past a speculation's isolation: its backing
 * write is forced to committed state, so consumers binding outside the writing
 * action see it immediately and reactively. Each action's overlay is removed
 * when that action closes — on both the commit and the discard face — via
 * onSettle. Reading the wrapped signal directly still reports canonical truth.
 */
export function optimistic<T>(
  source: Accessor<T>,
): [Accessor<T>, (value: T) => void, Accessor<boolean>] {
  // One entry per action that currently has a live overlay. A Map iterates in
  // insertion order, so the most recently written entry is the top of the stack.
  const overlays = new Map<Scope, T>()
  const [top, setTop] = signal<T | typeof EMPTY>(EMPTY)

  const publishTop = (): void => {
    let current: T | typeof EMPTY = EMPTY
    for (const overlayValue of overlays.values()) current = overlayValue
    // Force the write to committed state so it is visible outside the writing
    // action and is a real reactive write, rather than being isolated to the
    // action's own speculative slot.
    committed(() => setTop(current))
  }

  const setOptimisticValue = (value: T): void => {
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
      onSettle(() => {
        overlays.delete(scope)
        publishTop()
      })
    }
  }

  const optimisticValue: Accessor<T> = () => {
    const current = top()
    return current === EMPTY ? source() : current
  }
  const isOptimistic: Accessor<boolean> = () => top() !== EMPTY

  return [optimisticValue, setOptimisticValue, isOptimistic]
}

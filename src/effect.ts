import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { NotReadyYet } from './async'
import { findLoadingScope, getOwner, routeError, registerWithOwner } from './owner'
import { signal } from './signal'

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs (after the scheduler flushes) whenever a signal it read changes.
 *
 * If the body throws `NotReadyYet` (via `use` on a pending promise), the effect
 * suspends: it holds — running nothing further this pass — and re-runs once the
 * carried promise settles. Re-running is driven by an internal "kick" signal the
 * body reads every pass; settling calls setKick(...), marking the effect dirty.
 * Any other thrown value is a genuine error and is re-thrown.
 *
 * When suspended, the effect also registers itself with the nearest enclosing
 * `loadingScope` (attached by `<Loading>`) so a Loading boundary observes the
 * suspension. Unregisters on successful re-run or disposal.
 *
 * `suspendedOn` tracks the promise the effect is currently suspended on (or
 * `null`). A successful run clears it; the kick callback only fires if
 * `suspendedOn` still matches — so when an effect is already scheduled by some
 * other path on settle, the redundant kick becomes a no-op.
 */
export function effect(fn: () => void): void {
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  // `kickCount` increments per kick so each setKick(...) is a distinct value
  // (r3's setSignal bails on `el.value === v`, so writing the same value would be a no-op).
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let unregisterPending: (() => void) | null = null

  const body = () => {
    kick() // depend on the kick signal so a settled promise can re-trigger this effect
    try {
      fn()
      suspendedOn = null // completed successfully — no longer suspended
      // If we were previously registered with a loading scope, unregister now.
      if (unregisterPending !== null) {
        unregisterPending()
        unregisterPending = null
      }
    } catch (e) {
      if (e instanceof NotReadyYet) {
        const alreadySuspendedOnSame = suspendedOn === e.promise
        suspendedOn = e.promise
        if (!alreadySuspendedOnSame) {
          const p = e.promise
          const rerun = () => {
            if (suspendedOn === p) {
              suspendedOn = null
              setKick(++kickCount)
            }
          }
          p.then(rerun, rerun)
        }
        // Register with nearest loadingScope (idempotent — only on first throw per pending cycle).
        if (unregisterPending === null) {
          const scope = findLoadingScope(myOwner)
          if (scope !== null) unregisterPending = scope.register()
        }
        return // suspended: hold — do not run the rest of fn, do not propagate
      }
      routeError(myOwner, e) // throws if no handler catches
    }
  }

  const node = r3Computed(body)
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      // If we're disposed while pending, unregister from loading scope.
      if (unregisterPending !== null) {
        unregisterPending()
        unregisterPending = null
      }
    },
  })
}

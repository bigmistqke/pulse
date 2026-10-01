import { computed as r3Computed, untrack as r3Untrack, unwatched, type Computed as R3Computed } from 'r3'
import { NotReadyYet, use } from './async'
import type { Resolved } from './async'
import { computed } from './computed'
import {
  findBoundaryScope,
  findNearestErrorScope,
  getOwner,
  routeError,
  routeErrorFromRerun,
  registerWithOwner,
  type BindingController,
  type ErrorScope,
} from './owner'
import { sameValueZero } from './same-value-zero'
import { chainFor, getCurrentScope } from './scope'
import { signal } from './signal'
import { clearErrorSource, runBindingCompute, takeErrorSource } from './transition-tracker'

/** A pipeline stage: takes the prior stage's resolved value, returns sync/Promise/generator. */
type Stage<In, Out> = (value: In) => Out

// Existing single-arg overload — unchanged signature
export function effect(fn: () => void): void

// Staged-effect overloads, 1–5 stages
export function effect<A>(
  stages: [() => A],
  commit: (value: Resolved<A>) => void,
): void
export function effect<A, B>(
  stages: [() => A, Stage<Resolved<A>, B>],
  commit: (value: Resolved<B>) => void,
): void
export function effect<A, B, C>(
  stages: [() => A, Stage<Resolved<A>, B>, Stage<Resolved<B>, C>],
  commit: (value: Resolved<C>) => void,
): void
export function effect<A, B, C, D>(
  stages: [() => A, Stage<Resolved<A>, B>, Stage<Resolved<B>, C>, Stage<Resolved<C>, D>],
  commit: (value: Resolved<D>) => void,
): void
export function effect<A, B, C, D, E>(
  stages: [
    () => A,
    Stage<Resolved<A>, B>,
    Stage<Resolved<B>, C>,
    Stage<Resolved<C>, D>,
    Stage<Resolved<D>, E>,
  ],
  commit: (value: Resolved<E>) => void,
): void

export function effect(
  ...args:
    | [fn: () => void]
    | [stages: Array<(value: any) => unknown>, commit: (value: unknown) => void]
): void {
  refuseInsideSpeculation()
  if (typeof args[0] === 'function') {
    return userEffect(args[0] as () => void)
  }
  const stages = args[0] as Array<(value: unknown) => unknown>
  const commit = args[1] as (value: unknown) => void
  return stagedEffect(stages, commit)
}

/**
 * An effect pushes values out of the reactive graph, so one created inside a
 * speculation would publish the speculation's writes before they commit, where
 * a discard could no longer take them back. Every effect is created through
 * `effect()`, and every binding through `bindingEffect()`, and both refuse.
 * The throw lands in the action body, which fails the action like any other
 * error there.
 */
function refuseInsideSpeculation(): void {
  if (chainFor(getCurrentScope()).some((scope) => scope.kind === 'speculative')) {
    throw new Error(
      'effect: cannot create an effect inside an action. An effect would publish the ' +
        "action's writes before they commit; create it outside the action instead.",
    )
  }
}

function stagedEffect(
  stages: Array<(value: unknown) => unknown>,
  commit: (value: unknown) => void,
): void {
  if (stages.length === 0) {
    throw new Error('effect: staged form requires at least one stage')
  }
  const pipeline = (computed as unknown as (
    ...s: Array<(value: unknown) => unknown>
  ) => () => unknown)(...stages)

  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let disposed = false
  let suspendedOn: Promise<unknown> | null = null
  const UNSET = Symbol('unset')
  let lastCommitted: unknown = UNSET
  // See `userEffect`: throw out of the caller's own first run, report out of a
  // write-driven re-run.
  let isFirstRun = true

  const body = () => {
    kick()
    let value: unknown
    try {
      // runBindingCompute isolates this run's reads from a binding compute that
      // may be running around the effect's creation; its report is not used,
      // because no boundary coordinates an effect.
      value = runBindingCompute(() => use(pipeline)).value
    } catch (e) {
      if (e instanceof NotReadyYet) {
        rerunOnSettle(e.promise)
        return
      }
      if (isFirstRun) routeError(myOwner, e)
      else routeErrorFromRerun(myOwner, e)
      return
    }
    suspendedOn = null
    // Dedupe: if the resolved value is the same as what we last committed,
    // skip — this guards against double-fire from use()'s pendingSig + value
    // signals both triggering re-runs under syncScheduler when a promise settles.
    if (sameValueZero(value, lastCommitted)) return
    lastCommitted = value
    if (!disposed) commit(value)
  }

  const rerunOnSettle = (p: Promise<unknown>): void => {
    if (suspendedOn === p) return
    suspendedOn = p
    const rerun = () => {
      if (suspendedOn === p) {
        suspendedOn = null
        setKick(++kickCount)
      }
    }
    p.then(rerun, rerun)
  }

  // Created with no computation running, so the effect runs now and the
  // computation creating it, if any, does not come to depend on it.
  const node = r3Untrack(() => r3Computed(body))
  isFirstRun = false
  registerWithOwner({
    dispose: () => {
      disposed = true
      unwatched(node as R3Computed<unknown>)
    },
  })
}

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs whenever a signal it read changes.
 *
 * An effect is its own: no boundary coordinates it. If the body throws
 * `NotReadyYet`, the effect waits and re-runs when the carried promise
 * settles, and no `<Loading>` hears about it. Any other throw goes to the
 * nearest `catchError` handler that accepts it, never to an `<Errored>`
 * boundary; unclaimed, it is thrown on the first run and logged on a later one.
 */
function userEffect(fn: () => void): void {
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  // r3 runs the body eagerly on creation, so the first run happens inside the
  // caller's own stack: an error nobody handles is theirs to see, and is thrown.
  // Every later run is driven by a graph write, where throwing would unwind the
  // writer — see `routeErrorFromRerun`.
  let isFirstRun = true

  const body = () => {
    kick()
    try {
      // runBindingCompute isolates this run's reads from a binding compute that
      // may be running around the effect's creation, and clears the error
      // source on entry; its report is not used, because no boundary
      // coordinates an effect.
      runBindingCompute(fn)
      suspendedOn = null
    } catch (e) {
      if (e instanceof NotReadyYet) {
        const p = e.promise
        if (suspendedOn === p) return
        suspendedOn = p
        const rerun = () => {
          if (suspendedOn === p) {
            suspendedOn = null
            setKick(++kickCount)
          }
        }
        p.then(rerun, rerun)
        return
      }
      if (isFirstRun) routeError(myOwner, e)
      else routeErrorFromRerun(myOwner, e)
    }
  }

  // Created with no computation running, so the effect runs now and the
  // computation creating it, if any, does not come to depend on it.
  const node = r3Untrack(() => r3Computed(body))
  isFirstRun = false
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
    },
  })
}

/**
 * Internal: the effect every binding runs in. Unlike a public `effect`, it
 * takes part in the boundaries above it, because a binding is part of what a
 * component returns.
 *
 * If the body throws `NotReadyYet`, the binding suspends: registers with the
 * nearest `<Loading>` scope (reporting `'throwing'`), and re-runs when the
 * carried promise settles. On the next successful run it reports `'idle'`.
 * Plain effects do not provide a commit — their body's side effects already
 * happened on the successful pass, so there is nothing to defer for the
 * boundary's atomic flush. They only contribute to the boundary's pending
 * state while throwing.
 *
 * Any non-`NotReadyYet` throw routes to the nearest `catchError`.
 */
export function bindingEffect(fn: () => void): void {
  refuseInsideSpeculation()
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let controller: BindingController | null = null
  let errorController: BindingController | null = null
  // Which scope errorController is currently registered with — a later
  // error of the same binding can find a DIFFERENT accepting scope (its
  // error is a different type, and the previously-claimed scope's own for
  // now declines it, or a nearer scope newly exists), and the controller
  // must move with it rather than keep reporting into the old collection.
  let errorControllerScope: ErrorScope | null = null
  // r3 runs the body eagerly on creation, so the first run happens inside the
  // caller's own stack: an error nobody handles is theirs to see, and is thrown.
  // Every later run is driven by a graph write, where throwing would unwind the
  // writer — see `routeErrorFromRerun`.
  let isFirstRun = true

  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findBoundaryScope(myOwner, 'pending')
    if (scope === null) return null
    controller = scope.register()
    return controller
  }

  const ensureErrorController = (scope: ErrorScope): BindingController => {
    if (errorController !== null && errorControllerScope !== scope) {
      errorController.unregister()
      errorController = null
    }
    if (errorController === null) {
      errorController = scope.register()
      errorControllerScope = scope
    }
    return errorController
  }

  const body = () => {
    kick()
    // Invariant: every consumer of the module-level error source clears it on
    // entry, so a source can never survive past the binding compute that set it.
    // `runBindingCompute` does this for DOM bindings; a plain effect calls `fn()`
    // directly instead of going through `runBindingCompute`, so it has to clear the
    // source itself here. Without this, an error this effect swallows (no
    // `<Errored>` boundary above it, so `takeErrorSource()` is never reached below)
    // would leave `poisoned`'s accessor parked in module state, and a later,
    // unrelated error under a real boundary would inherit it as its `source`.
    clearErrorSource()
    try {
      fn()
      suspendedOn = null
      controller?.report({ status: 'idle' })
      // Recovered: leave the failed collection, so the boundary can unlatch.
      errorController?.report({ status: 'idle' })
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
        ensureController()?.report({ status: 'throwing' })
        return
      }
      // A real error. It is graph state, not an event: report it to the nearest
      // <Errored> boundary, which collects it and selects its fallback. The same
      // controller reporting repeatedly is one entry, so a single rejection that
      // re-runs this body several times still renders one fallback.
      controller?.report({ status: 'idle' }) // failed is not pending
      const errorScope = findNearestErrorScope(myOwner, e)
      if (errorScope !== null) {
        ensureErrorController(errorScope.scope).report({
          status: 'error',
          error: e,
          source: takeErrorSource(),
          retry: () => setKick(++kickCount),
        })
        return
      }
      if (isFirstRun) routeError(myOwner, e)
      else routeErrorFromRerun(myOwner, e)
    }
  }

  // Created with no computation running, so the effect runs now and the
  // computation creating it, if any, does not come to depend on it.
  const node = r3Untrack(() => r3Computed(body))
  isFirstRun = false
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
      errorController?.unregister()
      errorController = null
      errorControllerScope = null
    },
  })
}

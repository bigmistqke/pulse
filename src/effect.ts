import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { NotReadyYet, use } from './async'
import type { Resolved } from './async'
import { computed } from './computed'
import {
  findBoundaryScope,
  findNearestFailedScope,
  getOwner,
  routeError,
  routeErrorFromRerun,
  registerWithOwner,
  type BindingController,
  type FailedScope,
} from './owner'
import { signal } from './signal'
import { clearFailureSource, runBindingCompute, takeFailureSource } from './transition-tracker'

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
  if (typeof args[0] === 'function') {
    return singleArgEffect(args[0] as () => void)
  }
  const stages = args[0] as Array<(value: unknown) => unknown>
  const commit = args[1] as (value: unknown) => void
  return stagedEffect(stages, commit)
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
  let controller: BindingController | null = null
  let failedController: BindingController | null = null
  // Which scope failedController is currently registered with — a later
  // failure of the same binding can find a DIFFERENT accepting scope (its
  // error is a different type, and the previously-claimed scope's own for
  // now declines it, or a nearer scope newly exists), and the controller
  // must move with it rather than keep reporting into the old collection.
  let failedControllerScope: FailedScope | null = null
  const UNSET = Symbol('unset')
  let lastCommitted: unknown = UNSET
  // See the identical flag in `singleArgEffect`: throw out of the caller's own
  // first run, report out of a write-driven re-run.
  let isFirstRun = true

  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findBoundaryScope(myOwner, 'pending')
    if (scope === null) return null
    controller = scope.register()
    return controller
  }

  const ensureFailedController = (scope: FailedScope): BindingController => {
    if (failedController !== null && failedControllerScope !== scope) {
      failedController.unregister()
      failedController = null
    }
    if (failedController === null) {
      failedController = scope.register()
      failedControllerScope = scope
    }
    return failedController
  }

  const body = () => {
    kick()
    let value: unknown
    let engagedTransition = false
    try {
      const computeResult = runBindingCompute(() => use(pipeline))
      value = computeResult.value
      engagedTransition = computeResult.engagedTransition
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
      // A real failure is not a pending state: this binding registered a
      // pending controller above when it threw NotReadyYet, and it must
      // leave that collection now, or the boundary's pending count can never
      // reach zero and its gate stays shut forever.
      controller?.report({ status: 'idle' })
      // It is graph state, not an event: report it to the nearest
      // <Failed> boundary, which collects it and selects its fallback. The same
      // controller reporting repeatedly is one entry, so a single rejection that
      // re-runs this body several times still renders one fallback.
      const failedScope = findNearestFailedScope(myOwner, e)
      if (failedScope !== null) {
        ensureFailedController(failedScope.scope).report({
          status: 'failed',
          error: e,
          source: takeFailureSource(),
          retry: () => setKick(++kickCount),
        })
        return
      }
      if (isFirstRun) routeError(myOwner, e)
      else routeErrorFromRerun(myOwner, e)
      return
    }
    suspendedOn = null
    // Recovered: leave the failed collection, so the boundary can unlatch.
    failedController?.report({ status: 'idle' })
    // Dedupe: if the resolved value is the same as what we last committed,
    // skip — this guards against double-fire from use()'s pendingSig + value
    // signals both triggering re-runs under syncScheduler when a promise settles.
    if (Object.is(value, lastCommitted)) return
    lastCommitted = value
    // Build the commit closure. It runs the user's commit with the resolved value.
    const userCommitFn = (): void => {
      if (disposed) return
      commit(value)
    }
    // Route via existing-controller, deferOrCommit (if engaged + pending), or immediate.
    const scope = findBoundaryScope(myOwner, 'pending')
    if (controller !== null) {
      controller.report({ status: 'ready', commit: userCommitFn })
    } else if (engagedTransition && scope !== null && scope.active()) {
      scope.deferOrCommit(userCommitFn)
    } else {
      userCommitFn()
    }
  }

  const node = r3Computed(body)
  isFirstRun = false
  registerWithOwner({
    dispose: () => {
      disposed = true
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
      failedController?.unregister()
      failedController = null
      failedControllerScope = null
    },
  })
}

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs whenever a signal it read changes.
 *
 * If the body throws `NotReadyYet`, the effect suspends: registers with the
 * nearest `<Loading>` scope (reporting `'throwing'`), and re-runs when the
 * carried promise settles. On the next successful run it reports `'idle'`.
 * Plain effects do not provide a commit — their body's side effects already
 * happened on the successful pass, so there is nothing to defer for the
 * boundary's atomic flush. They only contribute to the boundary's pending
 * state while throwing.
 *
 * Any non-`NotReadyYet` throw routes to the nearest `catchError`.
 */
function singleArgEffect(fn: () => void): void {
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let controller: BindingController | null = null
  let failedController: BindingController | null = null
  // Which scope failedController is currently registered with — a later
  // failure of the same binding can find a DIFFERENT accepting scope (its
  // error is a different type, and the previously-claimed scope's own for
  // now declines it, or a nearer scope newly exists), and the controller
  // must move with it rather than keep reporting into the old collection.
  let failedControllerScope: FailedScope | null = null
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

  const ensureFailedController = (scope: FailedScope): BindingController => {
    if (failedController !== null && failedControllerScope !== scope) {
      failedController.unregister()
      failedController = null
    }
    if (failedController === null) {
      failedController = scope.register()
      failedControllerScope = scope
    }
    return failedController
  }

  const body = () => {
    kick()
    // Invariant: every consumer of the module-level failure source clears it on
    // entry, so a source can never survive past the binding compute that set it.
    // `runBindingCompute` does this for DOM bindings; a plain effect calls `fn()`
    // directly instead of going through `runBindingCompute`, so it has to clear the
    // source itself here. Without this, a failure this effect swallows (no
    // `<Failed>` boundary above it, so `takeFailureSource()` is never reached below)
    // would leave `poisoned`'s accessor parked in module state, and a later,
    // unrelated failure under a real boundary would inherit it as its `source`.
    clearFailureSource()
    try {
      fn()
      suspendedOn = null
      controller?.report({ status: 'idle' })
      // Recovered: leave the failed collection, so the boundary can unlatch.
      failedController?.report({ status: 'idle' })
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
      // A real failure. It is graph state, not an event: report it to the nearest
      // <Failed> boundary, which collects it and selects its fallback. The same
      // controller reporting repeatedly is one entry, so a single rejection that
      // re-runs this body several times still renders one fallback.
      controller?.report({ status: 'idle' }) // failed is not pending
      const failedScope = findNearestFailedScope(myOwner, e)
      if (failedScope !== null) {
        ensureFailedController(failedScope.scope).report({
          status: 'failed',
          error: e,
          source: takeFailureSource(),
          retry: () => setKick(++kickCount),
        })
        return
      }
      if (isFirstRun) routeError(myOwner, e)
      else routeErrorFromRerun(myOwner, e)
    }
  }

  const node = r3Computed(body)
  isFirstRun = false
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
      failedController?.unregister()
      failedController = null
      failedControllerScope = null
    },
  })
}

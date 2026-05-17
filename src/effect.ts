import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { NotReadyYet } from './async'
import {
  findLoadingScope,
  getOwner,
  routeError,
  registerWithOwner,
  type BindingController,
} from './owner'
import { signal } from './signal'

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
export function effect(fn: () => void): void {
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let controller: BindingController | null = null

  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findLoadingScope(myOwner)
    if (scope === null) return null
    controller = scope.register()
    return controller
  }

  const body = () => {
    kick()
    try {
      fn()
      suspendedOn = null
      controller?.report({ status: 'idle' })
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
      routeError(myOwner, e)
    }
  }

  const node = r3Computed(body)
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
    },
  })
}

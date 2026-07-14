import {
  createSubOwner,
  getOwner,
  runWithOwner,
  type BindingController,
  type FailedScope,
  type Owner,
} from '../owner'
import { signal, type Accessor } from '../signal'

/** What a failed binding reported: the error, and how to re-run it. */
interface FailureReport {
  error: unknown
  retry: () => void
}

export interface FailedProps {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Rendered in place of the subtree while anything beneath is failed. */
  fallback: (error: unknown, reset: () => void) => unknown
}

/**
 * Failure boundary. Bindings beneath it that throw a real error report themselves
 * here; the boundary collects them and renders `fallback` in place of the subtree
 * while the collection is non-empty.
 *
 * It is a SELECTION over live graph state, not a latch. A React-style error
 * boundary remembers that an error happened and shows its fallback until something
 * resets it. This one shows the fallback exactly while something under it is
 * currently failed — so when a failure clears on its own (an upstream dependency
 * changes and the stage re-runs successfully), the binding reports `idle`, the
 * collection empties, and the subtree returns with no `reset()` call.
 *
 * That is also what makes it idempotent: a single rejection re-runs the consuming
 * binding several times, but every report comes from the same controller, so the
 * collection holds one entry and the fallback renders once.
 *
 * Suspension is NOT a failure: `NotReadyYet` is handled by `<Loading>` and never
 * reaches here.
 */
export function Failed(props: FailedProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)

  // The collection: one entry per currently-failed binding, keyed on its
  // controller — so a binding that re-runs and re-reports stays ONE entry.
  const failedSet = new Map<BindingController, FailureReport>()

  /**
   * The boundary's collection state, published as ONE signal so that a change is ONE
   * graph transition. Two signals (active, error) publish two, and under the sync
   * scheduler the selector re-runs in between — rendering the fallback with an error
   * that has already been cleared on the way out, or with a stale one on the way in.
   * Neither write order is safe; the state has to move atomically.
   */
  interface Collection {
    readonly active: boolean
    readonly error: unknown
  }

  // Mirrored in a plain variable so `recompute` can skip a no-op write without an
  // untracked read. The skip is load-bearing: a single rejection re-runs a binding
  // several times and it re-reports `failed` each time, and the boundary must not
  // re-render its fallback for reports that change nothing.
  let current: Collection = { active: false, error: null }
  const [collection, setCollection] = signal<Collection>(current)

  const recompute = () => {
    const first: FailureReport | undefined = failedSet.values().next().value
    const next: Collection = {
      active: failedSet.size > 0,
      error: first === undefined ? null : first.error,
    }
    if (next.active === current.active && Object.is(next.error, current.error)) return
    current = next
    setCollection(next)
  }

  const reset = (): void => {
    const reports = Array.from(failedSet.values())
    failedSet.clear()
    recompute()
    // Re-run each failed binding. If it fails again it reports again, refilling the
    // collection and bringing the fallback straight back — which is correct.
    for (const report of reports) report.retry()
  }

  const scope: FailedScope = {
    kind: 'failed',
    active: () => collection().active,
    register(): BindingController {
      const controller: BindingController = {
        report(state): void {
          if (state.status === 'failed') {
            failedSet.set(controller, { error: state.error, retry: state.retry })
          } else {
            // Any other status means this binding is no longer failed.
            failedSet.delete(controller)
          }
          recompute()
        },
        unregister(): void {
          failedSet.delete(controller)
          recompute()
        },
      }
      return controller
    },
    reset,
  }
  boundaryOwner.boundaries.failed = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    const { active, error } = collection()
    if (!active) return subtree
    return props.fallback(error, reset)
  }
}

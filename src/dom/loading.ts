import { effect } from '../effect'
import {
  createSubOwner,
  findLoadingScope,
  getOwner,
  runWithOwner,
  type BindingController,
  type BindingState,
  type LoadingScope,
  type Owner,
} from '../owner'
import { signal, type Accessor } from '../signal'

const CONST_FALSE_ACCESSOR: Accessor<boolean> = () => false

/**
 * Reads the nearest enclosing `<Loading>` boundary's pending state. Returns
 * a constant-false accessor when called outside any Loading subtree.
 */
export function useLoading(): Accessor<boolean> {
  const scope = findLoadingScope(getOwner())
  return scope === null ? CONST_FALSE_ACCESSOR : scope.pending
}

export interface LoadingProps {
  /** Function child REQUIRED — defers JSX construction until inside the
   *  boundary owner so descendants register with the right loadingScope. */
  children: () => unknown
  fallback?: unknown
  initial?: unknown
}

/**
 * Coordinated suspension boundary. Children's bindings register their
 * pending state with this boundary; Loading aggregates and selects:
 *
 * - All settled → loaded subtree.
 * - Pending and never-loaded → `initial ?? fallback`.
 * - Pending and previously loaded → `fallback ?? loaded subtree (hold-prior)`.
 *
 * Components inside run once (per pulse's components-run-once invariant);
 * only individual bindings re-run on their own promises settling.
 */
export function Loading(props: LoadingProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)

  // pendingSet: controllers currently throwing.
  // readySet: controllers that recomputed successfully and have a commit waiting.
  // Gate opens (commits flush together) when pendingSet.size === 0 && readySet.size > 0.
  const pendingSet = new Set<BindingController>()
  const readySet = new Map<BindingController, () => void>()

  const [pendingSig, setPendingSig] = signal(false)
  const recomputePending = () =>
    setPendingSig(pendingSet.size > 0 || readySet.size > 0)

  const scope: LoadingScope = {
    pending: pendingSig,
    register(): BindingController {
      const controller: BindingController = {
        report(state: BindingState): void {
          if (state.status === 'throwing') {
            pendingSet.add(controller)
            readySet.delete(controller)
          } else if (state.status === 'ready') {
            pendingSet.delete(controller)
            readySet.set(controller, state.commit)
          } else {
            // idle
            pendingSet.delete(controller)
            readySet.delete(controller)
          }
          // Gate check: nothing throwing AND something ready → flush all.
          if (pendingSet.size === 0 && readySet.size > 0) {
            // Snapshot to avoid iterator invalidation if a commit re-registers.
            const commits = Array.from(readySet.values())
            readySet.clear()
            for (const commit of commits) commit()
          }
          recomputePending()
        },
        unregister(): void {
          pendingSet.delete(controller)
          readySet.delete(controller)
          recomputePending()
        },
      }
      return controller
    },
  }
  boundaryOwner.loadingScope = scope

  // Construct loaded subtree once, inside boundaryOwner.
  const loadedSubtree: unknown = runWithOwner(boundaryOwner, props.children)

  // Detect "ever loaded": flip true the first time pending drops to false.
  // Owned by boundaryOwner (symmetric with loadedSubtree) so the lifetime
  // is bound to the boundary, not the calling parent.
  let hasEverLoaded = false
  runWithOwner(boundaryOwner, () => {
    effect(() => {
      if (!pendingSig()) hasEverLoaded = true
    })
  })

  return () => {
    if (!pendingSig()) return loadedSubtree
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
}

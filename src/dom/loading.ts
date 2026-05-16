import { effect } from '../effect'
import {
  createSubOwner,
  findLoadingScope,
  getOwner,
  runWithOwner,
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
  const [pendingCount, setPendingCount] = signal(0)
  const pending: Accessor<boolean> = () => pendingCount() > 0

  const scope: LoadingScope = {
    pending,
    register: () => {
      setPendingCount((c) => c + 1)
      return () => setPendingCount((c) => c - 1)
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
      if (!pending()) hasEverLoaded = true
    })
  })

  return () => {
    if (!pending()) return loadedSubtree
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
}

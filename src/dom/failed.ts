import {
  createFailedScope,
  createSubOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Accessor } from '../signal'

export interface FailedProps {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Optional. When provided, behaves as a full-subtree swap: replace the
   *  whole subtree with `fallback(error, reset)` while the boundary is
   *  active. When omitted, `<Failed>` is pure scoping — children stay
   *  mounted always, and `useFailed()` (or `Failed.Error`) is how a
   *  descendant shows the failure without unmounting anything. */
  fallback?: (error: unknown, reset: () => void) => unknown
}

export interface FailedState {
  /** True while the nearest boundary's collection is non-empty. */
  readonly active: Accessor<boolean>
  /** The first failed report's error, or `null`. Same value `fallback`
   *  receives as its first argument when a `<Failed>` swaps for it. */
  readonly error: Accessor<unknown>
  /** Retry every failed report the boundary is currently holding — the exact
   *  same operation a `<Failed>`'s own `reset` performs. Exposed under the
   *  name `retry` for symmetry with `ActionHandle.retry()`. */
  retry(): void
}

const CONST_FAILED_STATE: FailedState = {
  active: () => false,
  error: () => null,
  retry: () => {},
}

/**
 * Reads the nearest enclosing `<Failed>` boundary's state — active/error/retry
 * — without swapping anything, the same way `useLoading()` reads a `<Loading>`
 * boundary's pending state. Returns a safe, always-inactive state when called
 * outside any owner at all (mirrors `useLoading()`'s `CONST_FALSE_ACCESSOR`).
 * Every root created via `createRoot()` always has a real boundary to find —
 * see `createFailedScope()`'s installation there.
 */
export function useFailed(): FailedState {
  const scope = findBoundaryScope(getOwner(), 'failed')
  if (scope === null) return CONST_FAILED_STATE
  return { active: scope.active, error: scope.error, retry: scope.reset }
}

/**
 * Failure boundary. Bindings beneath it that throw a real error report themselves
 * here; the boundary collects them.
 *
 * With a `fallback`, it behaves the way it always has: a SELECTION over live
 * graph state, not a latch. A React-style error boundary remembers that an
 * error happened and shows its fallback until something resets it. This one
 * shows the fallback exactly while something under it is currently failed —
 * so when a failure clears on its own (an upstream dependency changes and the
 * stage re-runs successfully), the binding reports `idle`, the collection
 * empties, and the subtree returns with no `reset()` call.
 *
 * Without a `fallback`, the children are always returned — nothing ever
 * swaps. `useFailed()`/`Failed.Error` are how a descendant reads the same
 * collection state without unmounting anything.
 *
 * Suspension is NOT a failure: `NotReadyYet` is handled by `<Loading>` and never
 * reaches here.
 */
export function Failed(props: FailedProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)
  const scope = createFailedScope()
  boundaryOwner.boundaries.failed = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    if (props.fallback === undefined) return subtree
    if (!scope.active()) return subtree
    return props.fallback(scope.error(), scope.reset)
  }
}

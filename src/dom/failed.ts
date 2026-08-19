import { untrack } from 'r3'
import {
  createFailedScope,
  createSubOwner,
  disposeOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Accessor } from '../signal'

export interface FailedProps<E = unknown> {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Optional. When provided, behaves as a full-subtree swap: replace the
   *  whole subtree with `fallback(error, reset)` while the boundary is
   *  active. When omitted, `<Failed>` is pure scoping — children stay
   *  mounted always, and `useFailed()` (or `Failed.Error`) is how a
   *  descendant shows the failure without unmounting anything. */
  fallback?: (error: E, reset: () => void) => unknown
  /** Optional. When given, this boundary only claims an error if `for`
   *  returns true for it — anything else is treated as if this boundary did
   *  not exist, and the search continues to the next ancestor `<Failed>` (or
   *  `catchError`) instead. Omitted means "accepts everything", exactly the
   *  behaviour without this prop.
   *
   *  Written as a type guard (`(value: unknown) => value is E`), `fallback`'s
   *  own `error` parameter is narrowed to `E`. A plain boolean predicate
   *  still works when there's nothing to narrow to (filtering by message, by
   *  a custom `.code` property, etc.) — just without the narrowing. */
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
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
 * boundary's pending state. Returns a safe, always-inactive state when no
 * boundary is found (mirrors `useLoading()`'s `CONST_FALSE_ACCESSOR`) — today
 * that includes both "called with no owner at all" and "called under a root
 * with no explicit `<Failed>` anywhere in it".
 *
 * Uses `findBoundaryScope`, not `findNearestFailedScope` — a plain owner walk
 * that does not stop early for a nearer `catchError`, unlike the walk actual
 * failure routing (`effect.ts`, `action()`) uses. This answers "which boundary
 * would swap me out if it went active", not "who intercepts my own failure" —
 * a `catchError` between this call and a `<Failed>` does not hide that
 * `<Failed>`'s state from `useFailed()`, since that boundary still owns
 * whatever DOM this call's descendants sit inside.
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
export function Failed<E = unknown>(props: FailedProps<E>): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)
  const scope = createFailedScope(undefined, props.for)
  boundaryOwner.boundaries.failed = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    if (props.fallback === undefined) return subtree
    if (!scope.active()) return subtree
    // Safe: fallback only runs while scope.active() is true, meaning
    // something registered a 'failed' report that findNearestFailedScope/
    // action() already checked against this exact scope.for before ever
    // calling register() — see FailedScope.for's own doc comment.
    return props.fallback(scope.error() as E, scope.reset)
  }
}

export interface FailedErrorProps {
  /** Called once per active-transition (branch-cached, the same way `Show`'s
   *  children are — see `src/dom/show.ts`) — not re-invoked on every change
   *  to the boundary's collection. If the underlying error changes while the
   *  boundary stays active (a second failure supersedes the first while this
   *  is still showing), reflecting that needs its own nested reactive read
   *  inside the render prop's body (e.g. call `useFailed()` again there),
   *  the same way `Show`'s own docs recommend for a value that changes
   *  without a truthy/falsy transition. */
  children: (error: unknown, retry: () => void) => unknown
}

/**
 * Compound sugar for showing the nearest `<Failed>` boundary's error inline,
 * anywhere, with no unmounting of anything around it — built entirely on
 * `useFailed()`, nothing more.
 *
 * Gets its own sub-owner, disposed on each active/inactive transition — the
 * same pattern `Show` uses internally — so that whatever the render prop
 * constructs (its own effects, its own owner-sensitive registrations) is
 * torn down cleanly when the failure clears, not merely removed from the DOM
 * while still alive underneath.
 *
 * Declared via `namespace Failed { ... }` merged with the `function Failed`
 * declaration above — the standard TypeScript pattern for attaching a typed
 * static property to a function. A plain `Failed.Error = ...` assignment
 * after the fact does not typecheck: `Failed`'s inferred type has no `Error`
 * property unless it's declared this way.
 */
export namespace Failed {
  export function Error(props: FailedErrorProps): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useFailed()
    let branchOwner: Owner | null = null
    let lastActive: boolean | null = null
    let cached: unknown

    return () => {
      const isActive = active()
      if (isActive === lastActive) return cached

      if (branchOwner !== null) disposeOwner(branchOwner)
      branchOwner = createSubOwner(parentOwner)
      // untrack: the render prop may call onCleanup or create effects.
      // Without untrack, those would route to the calling binding-effect's
      // r3 per-run cleanup instead of branchOwner, disposing them on the
      // very next re-run — same pattern as Show/mapArray.
      cached = isActive
        ? untrack(() => runWithOwner(branchOwner!, () => props.children(error(), retry)))
        : null
      lastActive = isActive
      return cached
    }
  }
}

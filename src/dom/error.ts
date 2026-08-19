import { untrack } from 'r3'
import {
  createErrorScope,
  createSubOwner,
  disposeOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type ErrorReport,
  type Owner,
} from '../owner'
import type { Accessor } from '../signal'

export interface ErroredProps<E = unknown> {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Optional. When provided, behaves as a full-subtree swap: replace the
   *  whole subtree with `fallback(error, reset)` while the boundary is
   *  active. When omitted, `<Errored>` is pure scoping — children stay
   *  mounted always, and `useErrored()` (or `Errored.Error`) is how a
   *  descendant shows the error without unmounting anything. */
  fallback?: (error: E, reset: () => void) => unknown
  /** Optional. When given, this boundary only claims an error if `for`
   *  returns true for it — anything else is treated as if this boundary did
   *  not exist, and the search continues to the next ancestor `<Errored>` (or
   *  `catchError`) instead. Omitted means "accepts everything", exactly the
   *  behaviour without this prop.
   *
   *  Written as a type guard (`(value: unknown) => value is E`), `fallback`'s
   *  own `error` parameter is narrowed to `E`. A plain boolean predicate
   *  still works when there's nothing to narrow to (filtering by message, by
   *  a custom `.code` property, etc.) — just without the narrowing. */
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
}

export interface ErroredState<E = unknown> {
  /** True while whatever this reads — the whole boundary, or only reports
   *  matching a given predicate — is non-empty. */
  readonly active: Accessor<boolean>
  /** The first matching failed report's error, or `null`. Same value
   *  `fallback` receives as its first argument when an `<Errored>` swaps for
   *  it, when no predicate narrows what "matching" means. */
  readonly error: Accessor<E | null>
  /** Retry every matching failed report — the same per-report operation a
   *  `<Errored>`'s own `reset` performs, but only over the reports this
   *  state actually reflects. Exposed under the name `retry` for symmetry
   *  with `ActionHandle.retry()`. */
  retry(): void
}

const CONST_ERROR_STATE: ErroredState<unknown> = {
  active: () => false,
  error: () => null,
  retry: () => {},
}

/**
 * Reads the nearest enclosing `<Errored>` boundary's state — active/error/retry
 * — without swapping anything, the same way `useLoading()` reads a `<Loading>`
 * boundary's pending state. Returns a safe, always-inactive state when no
 * boundary is found (mirrors `useLoading()`'s `CONST_FALSE_ACCESSOR`) — today
 * that includes both "called with no owner at all" and "called under a root
 * with no explicit `<Errored>` anywhere in it".
 *
 * Uses `findBoundaryScope`, not `findNearestErrorScope` — a plain owner walk
 * that does not stop early for a nearer `catchError`, unlike the walk actual
 * error routing (`effect.ts`, `action()`) uses. This answers "which boundary
 * would swap me out if it went active", not "who intercepts my own error" —
 * a `catchError` between this call and an `<Errored>` does not hide that
 * `<Errored>`'s state from `useErrored()`, since that boundary still owns
 * whatever DOM this call's descendants sit inside.
 *
 * `predicate`, if given, narrows what `active`/`error` mean and what
 * `retry()` re-runs to only the boundary's reports matching it, instead of
 * its first report and its whole collection — for when one boundary
 * legitimately holds more than one kind of error at once and a specific
 * reader only cares about one of them. It does not change WHICH boundary is
 * found — that stays purely positional, the same walk as with no predicate
 * at all. Written as a type guard, `error()` narrows to `E`, the same
 * convenience `<Errored>`'s own `for` gives its `fallback`.
 */
export function useErrored<E = unknown>(
  predicate?: ((value: unknown) => value is E) | ((value: unknown) => boolean),
): ErroredState<E> {
  const scope = findBoundaryScope(getOwner(), 'error')
  if (scope === null) return CONST_ERROR_STATE as ErroredState<E>
  // active()/error() read the published reports() snapshot — a no-op report
  // (the identical error reported again) never changes what these mean, so
  // the snapshot lagging behind the live errorSet in that one case is not
  // observable here. retry() cannot use the same snapshot: it needs
  // whichever source/retry a report MOST RECENTLY carried, which a no-op
  // report refreshes internally without republishing reports() — so it
  // delegates to scope.reset()/resetMatching(), the same live-data
  // operations an unfiltered <Errored>'s own reset performs.
  const matching = (): readonly ErrorReport[] =>
    predicate === undefined ? scope.reports() : scope.reports().filter((r) => predicate(r.error))
  return {
    active: () => matching().length > 0,
    error: () => (matching()[0]?.error as E | undefined) ?? null,
    retry: () => (predicate === undefined ? scope.reset() : scope.resetMatching(predicate)),
  }
}

/**
 * Error boundary. Bindings beneath it that throw a real error report themselves
 * here; the boundary collects them.
 *
 * With a `fallback`, it behaves the way it always has: a SELECTION over live
 * graph state, not a latch. A React-style error boundary remembers that an
 * error happened and shows its fallback until something resets it. This one
 * shows the fallback exactly while something under it is currently failed —
 * so when an error clears on its own (an upstream dependency changes and the
 * stage re-runs successfully), the binding reports `idle`, the collection
 * empties, and the subtree returns with no `reset()` call.
 *
 * Without a `fallback`, the children are always returned — nothing ever
 * swaps. `useErrored()`/`Errored.Error` are how a descendant reads the same
 * collection state without unmounting anything.
 *
 * Suspension is NOT an error: `NotReadyYet` is handled by `<Loading>` and never
 * reaches here.
 */
export function Errored<E = unknown>(props: ErroredProps<E>): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)
  const scope = createErrorScope(undefined, props.for)
  boundaryOwner.boundaries.error = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    if (props.fallback === undefined) return subtree
    if (!scope.active()) return subtree
    // Safe: fallback only runs while scope.active() is true, meaning
    // something registered a 'error' report that already checked this
    // exact scope.for against that report's own error before ever calling
    // register() — see ErrorScope.for's own doc comment. Both effect.ts
    // (findNearestErrorScope) and action()'s candidate selection
    // (src/scope.ts) re-check this on every error, including a retry
    // that fails with a different error type than an earlier attempt, so
    // scope.error() is always a value this exact for accepted (or E is
    // unknown, since for was never given).
    return props.fallback(scope.error() as E, scope.reset)
  }
}

export interface ErroredErrorProps<E = unknown> {
  /** Optional. When given, narrows which reports the boundary's state
   *  reflects — same predicate shape and same narrowing behaviour as
   *  `<Errored>`'s own `for`, passed straight through to `useErrored`. */
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
  /** Called once per active-transition (branch-cached, the same way `Show`'s
   *  children are — see `src/dom/show.ts`) — not re-invoked on every change
   *  to the boundary's collection. If the underlying error changes while the
   *  boundary stays active (a second error supersedes the first while this
   *  is still showing), reflecting that needs its own nested reactive read
   *  inside the render prop's body (e.g. call `useErrored(props.for)` again
   *  there), the same way `Show`'s own docs recommend for a value that
   *  changes without a truthy/falsy transition. */
  children: (error: E, retry: () => void) => unknown
}

/**
 * Compound sugar for showing the nearest `<Errored>` boundary's error inline,
 * anywhere, with no unmounting of anything around it — built entirely on
 * `useErrored()`, nothing more.
 *
 * Gets its own sub-owner, disposed on each active/inactive transition — the
 * same pattern `Show` uses internally — so that whatever the render prop
 * constructs (its own effects, its own owner-sensitive registrations) is
 * torn down cleanly when the error clears, not merely removed from the DOM
 * while still alive underneath.
 *
 * Declared via `namespace Errored { ... }` merged with the `function Errored`
 * declaration above — the standard TypeScript pattern for attaching a typed
 * static property to a function. A plain `Errored.Error = ...` assignment
 * after the fact does not typecheck: `Errored`'s inferred type has no `Error`
 * property unless it's declared this way.
 */
export namespace Errored {
  export function Error<E = unknown>(props: ErroredErrorProps<E>): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useErrored(props.for)
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
      //
      // error() as E is safe here: isActive is only true while matching()
      // is non-empty, and error() only returns null when matching() is
      // empty.
      cached = isActive
        ? untrack(() => runWithOwner(branchOwner!, () => props.children(error() as E, retry)))
        : null
      lastActive = isActive
      return cached
    }
  }
}

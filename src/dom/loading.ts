import { effect } from '../effect'
import {
  createSubOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type BindingController,
  type BindingState,
  type LoadingScope,
  type Owner,
} from '../owner'
import { signal, type Accessor } from '../signal'
import type { Child } from './h'
import { readDynamic } from './resolve'

const CONST_FALSE_ACCESSOR: Accessor<boolean> = () => false

/**
 * Reads the nearest enclosing `<Loading>` boundary's pending state. Returns
 * a constant-false accessor when called outside any Loading subtree.
 */
export function useLoading(): Accessor<boolean> {
  const scope = findBoundaryScope(getOwner(), 'pending')
  return scope === null ? CONST_FALSE_ACCESSOR : scope.active
}

/**
 * Reads the nearest enclosing `<Loading>` boundary's pending state directly,
 * as a plain `boolean` rather than an accessor. Call it fresh at each read
 * site — inside a getter-converted prop, or inside an effect — the same way
 * `signal()` reads are meant to be called fresh rather than stored. Returns
 * `false` when called outside any Loading subtree.
 *
 * `useLoading()` still exists for the narrower case where the boundary is
 * read from one place and the resulting accessor handed to another —
 * `isLoading()` covers the common case of reading and using the state at the
 * same call site.
 */
export function isLoading(): boolean {
  const scope = findBoundaryScope(getOwner(), 'pending')
  return scope === null ? false : scope.active()
}

export interface LoadingProps {
  /** JSX construction must be deferred until inside the boundary owner, so
   *  descendants register with the right `boundaries.pending`. A function
   *  child defers by construction — `Loading` calls it itself, inside the
   *  boundary. A plain `Child` only defers correctly when the pulse JSX
   *  compiler (props-to-getters) is compiling this file: it rewrites a bare
   *  JSX-element child into exactly that same thunk at compile time. Passed
   *  through any other JSX pipeline (plain tsc/esbuild react-jsx), a plain
   *  `Child` is constructed immediately at the call site, before this
   *  boundary owner exists — pass an explicit `() => <Foo/>` in any file not
   *  compiled by the pulse plugin. */
  children: Child | (() => unknown)
  fallback?: unknown
  initial?: unknown
}

/**
 * Coordinated suspension boundary. Children's bindings register their
 * pending state with this boundary; Loading aggregates and selects:
 *
 * - All settled → loaded subtree.
 * - Pending, neither `initial` nor `fallback` given → loaded subtree anyway
 *   (context-only: nothing to swap to, so nothing swaps — see `useLoading()`
 *   for reading pending state without a swap at all). A binding inside still
 *   withholds its own commit exactly as in every other case; only whatever
 *   doesn't depend on the pending value is visible while it waits.
 * - Pending and never-loaded (with at least one of the two given) →
 *   `initial ?? fallback`.
 * - Pending and previously loaded (with at least one of the two given) →
 *   `fallback ?? loaded subtree (hold-prior)`.
 *
 * Components inside run once (per pulse's components-run-once invariant);
 * only individual bindings re-run on their own promises settling.
 */
export function Loading(props: LoadingProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)

  // pendingSet: controllers currently throwing.
  // readySet: controllers that recomputed successfully and have a commit waiting.
  // deferredCommits: commits from use()-engaged bindings that didn't throw but
  //   need to wait for the gate to open (atomic with controller-based commits).
  // Gate opens (commits flush together) when pendingSet.size === 0 AND
  //   (readySet.size > 0 OR deferredCommits.length > 0).
  const pendingSet = new Set<BindingController>()
  const readySet = new Map<BindingController, () => void>()
  const deferredCommits: Array<() => void> = []
  let tailCheckScheduled = false

  // In-flight promises handed off by a use.latest() binding that took the
  // stale-while-revalidate path (has a value, no commit to gate — see
  // trackBackground below). Tracked only so isLoading()/useLoading() still
  // reflect a background refresh; doesn't participate in the atomic-commit
  // gate at all.
  const backgroundPromises = new Set<Promise<unknown>>()

  // In-flight promises handed off by a latest() read that had NO value — the
  // accessor has genuinely never resolved. Same hand-off mechanism as
  // backgroundPromises, opposite meaning, and the two are kept apart because
  // the boundary treats them oppositely: this one DOES drive the `initial`
  // swap ("nothing has ever loaded" is what `initial` is for), that one must
  // never touch it (a refresh behind visible content must hold prior).
  // Neither participates in the atomic-commit gate — a binding that reported
  // either has already committed whatever it had.
  const firstLoadPromises = new Set<Promise<unknown>>()

  // gatePending: drives the atomic-commit gate — a binding that hasn't
  // committed yet, or is waiting for its siblings before an atomic flush.
  // Deliberately excludes backgroundPromises: a use.latest() binding that
  // took the SWR path already committed (it has a value to show), so its
  // in-flight refresh must never reopen the fallback.
  const [gatePending, setGatePending] = signal(false)
  // firstLoadPending: some reader under this boundary is waiting on something
  // that has never resolved. Drives the `initial` swap alongside gatePending,
  // so a subtree that reads only through latest() — never throwing, never
  // engaging the gate — still gets its first-load placeholder. Because the
  // fact comes from the accessor's own state rather than per-boundary
  // bookkeeping, it survives a boundary remount (same property that makes
  // use.latest() fix FM2).
  const [firstLoadPending, setFirstLoadPending] = signal(false)
  // active: what isLoading()/useLoading() report — anything in flight at all,
  // whether it gates a commit, is a background refresh, or is a first load.
  const [activeSig, setActiveSig] = signal(false)
  const recomputePending = () => {
    const gate = pendingSet.size > 0 || readySet.size > 0 || deferredCommits.length > 0
    setGatePending(gate)
    setFirstLoadPending(firstLoadPromises.size > 0)
    setActiveSig(gate || backgroundPromises.size > 0 || firstLoadPromises.size > 0)
  }

  /** Flush all ready and deferred commits atomically. Call only when gate is open. */
  const flushAll = () => {
    // Snapshot to avoid iterator invalidation if a commit re-registers.
    const controllerCommits = Array.from(readySet.values())
    readySet.clear()
    const deferred = deferredCommits.splice(0)
    for (const commit of controllerCommits) commit()
    for (const commit of deferred) commit()
  }

  const scope: LoadingScope = {
    kind: 'pending',
    active: activeSig,
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
          // Gate check: nothing throwing AND something ready/deferred → flush all.
          if (pendingSet.size === 0 && (readySet.size > 0 || deferredCommits.length > 0)) {
            flushAll()
          }
          recomputePending()
        },
        unregister(): void {
          pendingSet.delete(controller)
          readySet.delete(controller)
          // Gate check: if unregistering drained pendingSet and there are
          // deferred commits (from use()-engaged bindings that didn't throw),
          // open the gate now so those commits aren't stranded.
          if (pendingSet.size === 0 && (readySet.size > 0 || deferredCommits.length > 0)) {
            flushAll()
          }
          recomputePending()
        },
      }
      return controller
    },
    deferOrCommit(commit: () => void): void {
      // Always queue, then decide at end-of-microtask whether to flush.
      // This handles the ordering race where a non-throwing binding (e.g.
      // use(plainSignal)) runs BEFORE a sibling binding that will throw in
      // the same flush. If we committed immediately based on the current
      // pendingSet, we'd miss the sibling's throw and break atomicity.
      // The microtask tail-check fires after r3 stabilize completes, so by
      // then any sibling that was going to throw has reported.
      deferredCommits.push(commit)
      recomputePending()
      if (!tailCheckScheduled) {
        tailCheckScheduled = true
        queueMicrotask(() => {
          tailCheckScheduled = false
          // If nothing's throwing by now, flush deferred commits. Otherwise
          // the existing gate-open path (in report()) handles it once the
          // throwers settle.
          if (pendingSet.size === 0 && deferredCommits.length > 0) {
            flushAll()
            recomputePending()
          }
        })
      }
    },
    trackFirstLoad(promise: Promise<unknown>): void {
      if (firstLoadPromises.has(promise)) return
      firstLoadPromises.add(promise)
      recomputePending()
      promise.finally(() => {
        if (boundaryOwner.disposed) return
        firstLoadPromises.delete(promise)
        recomputePending()
      })
    },
    trackBackground(promise: Promise<unknown>): void {
      if (backgroundPromises.has(promise)) return
      backgroundPromises.add(promise)
      recomputePending()
      promise.finally(() => {
        // The boundary may have been torn down before this settles — no-op
        // rather than mutate a set nothing is reading anymore.
        if (boundaryOwner.disposed) return
        backgroundPromises.delete(promise)
        recomputePending()
      })
    },
  }
  boundaryOwner.boundaries.pending = scope

  // Construct loaded subtree once, inside boundaryOwner.
  const loadedSubtree: unknown = runWithOwner(boundaryOwner, () => readDynamic(props, 'children'))

  // Detect "ever loaded": flip true the first time pending drops to false.
  // Owned by boundaryOwner (symmetric with loadedSubtree) so the lifetime
  // is bound to the boundary, not the calling parent.
  let hasEverLoaded = false
  runWithOwner(boundaryOwner, () => {
    effect(() => {
      if (!gatePending() && !firstLoadPending()) hasEverLoaded = true
    })
  })

  return () => {
    if (!gatePending() && !firstLoadPending()) return loadedSubtree
    // Neither prop given at all (not merely falsy — an explicit fallback of
    // null/''/false still means "swap to this") → context-only: stay
    // mounted. The atomic-commit gate above is unaffected either way — it
    // lives in the individual bindings' own reporting to this scope, not in
    // this swap decision, so a still-pending binding inside loadedSubtree
    // continues to withhold its own commit exactly as it already does.
    if (props.initial === undefined && props.fallback === undefined) return loadedSubtree
    // initial/fallback are plain Child, not a duck-typed accessor union -
    // read directly and pass through untouched, function value or not;
    // insertChild is what decides whether the result needs its own
    // reactive effect, not this component.
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
}

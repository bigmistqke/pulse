import {
  computed as r3Computed,
  getContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  type Disposable,
  onCleanup as r3OnCleanup,
} from 'r3'
import type { Accessor } from './signal'
import { currentGeneratorCleanups } from './generator-cleanup'
import { resetError } from './error'
import { requestFlush } from './scheduler'

/**
 * Per-binding state reports flow into a Loading boundary via this shape.
 * - 'throwing': the binding is currently suspended on a pending promise.
 * - 'ready': the binding recomputed successfully and has a commit waiting
 *            for the gate to open. The boundary calls `commit` during flush.
 * - 'idle':  the binding is no longer pending and has no commit to defer
 *            (used by plain `effect()` whose body already ran its side
 *            effects on the successful pass).
 */
export type BindingState =
  | { readonly status: 'throwing' }
  | { readonly status: 'ready'; readonly commit: () => void }
  | { readonly status: 'idle' }
  /** The binding threw a real error (not a suspension). `source` is the node whose
   *  parked error was thrown, if the throw came from one; `retry` re-runs the
   *  binding. */
  | {
      readonly status: 'error'
      readonly error: unknown
      readonly source: Accessor<unknown> | null
      readonly retry: () => void
    }

/**
 * A per-binding controller obtained from `LoadingScope.register()`.
 * The binding reports state changes via `report` and detaches via `unregister`.
 */
export interface BindingController {
  report(state: BindingState): void
  unregister(): void
}

/** The statuses a binding reports to a boundary. One boundary collects one status. */
export type BindingStatus = 'pending' | 'error'

/**
 * A boundary that collects the bindings beneath it carrying one status, and
 * exposes whether that collection is non-empty.
 *
 * This is the part that generalises. `<Loading>` layers atomic-commit
 * coordination on top of it (see `LoadingScope.deferOrCommit`); an error
 * boundary has nothing to commit atomically, so it uses the collection alone.
 */
export interface BoundaryScope {
  /** Which status this boundary collects. */
  readonly kind: BindingStatus
  /** `true` while this boundary's collection is non-empty. */
  readonly active: Accessor<boolean>
  /** Obtain a controller for a new binding. Each binding registers ONCE lazily;
   *  the controller persists across re-runs, so repeated reports of the same
   *  status are one entry, not many. */
  register(): BindingController
}

/** The pending collection, plus `<Loading>`'s atomic-commit gate. */
export interface LoadingScope extends BoundaryScope {
  readonly kind: 'pending'
  /**
   * If the boundary is currently pending, queue `commit` to run when the gate
   * opens. If nothing is pending, run `commit` immediately. This is the
   * coordination point for bindings that called `use()` but did NOT throw —
   * they still need to defer their DOM commit until all sibling pending
   * bindings have settled.
   */
  deferOrCommit(commit: () => void): void
  /**
   * Register an in-flight promise from a `use.latest()` binding that took the
   * stale-while-revalidate path — it already has a value to show, so it
   * doesn't go through `register()`/`deferOrCommit`, but the boundary's
   * `active` should still reflect that a refresh is happening in the
   * background. Removed automatically, via the promise's own settlement, not
   * by an explicit unregister call.
   */
  trackBackground(promise: Promise<unknown>): void
  /**
   * Register an in-flight promise from a `latest()` read that had NO value to
   * report — the accessor has genuinely never resolved. Unlike
   * `trackBackground`, this DOES drive the boundary's `initial` swap: "nothing
   * under me has ever loaded" is exactly what `initial` is for. It still never
   * touches the atomic-commit gate — the binding that reported it has already
   * committed whatever it had (typically nothing), so there is nothing to
   * withhold. Removed automatically via the promise's own settlement.
   */
  trackFirstLoad(promise: Promise<unknown>): void
}

/** The failed collection. */
export interface ErrorScope extends BoundaryScope {
  readonly kind: 'error'
  /** The first failed report's error, or `null` while healthy. Same value a
   *  `<Errored>` with a `fallback` passes as that fallback's first argument.
   *  Always `reports()[0]?.error ?? null`. */
  readonly error: Accessor<unknown>
  /** Set from `<Errored>`'s own `for` prop. Undefined means "accepts
   *  everything" — the existing, unconditional behaviour. Read by the
   *  walk (`findNearestErrorScope`) and by `action()`'s candidate
   *  selection, both of which check this BEFORE registering a report,
   *  never inside `register()`/`report()` themselves. */
  readonly for?: (error: unknown) => boolean
  /** Every currently-failed report this scope holds, in registration
   *  order. `useErrored(predicate)`/`Errored.Error` filter this to find a
   *  report that is not necessarily first — `error`/`active` above stay
   *  based on the first entry specifically, unaffected by anything
   *  reading this. */
  readonly reports: Accessor<readonly ErrorReport[]>
  /** Clear the collection and retry every binding in it. An `<Errored>` with a
   *  `fallback` hands this straight to user code as `reset` — often wired
   *  directly to a DOM event handler (`<button on:click={reset}>`) — so
   *  this must stay a strict zero-argument function. `resetMatching` below
   *  is the filtered version. */
  reset(): void
  /** Clear and retry only the reports matching `predicate`, leaving the rest
   *  of the collection exactly as it was. Reads the live, always up-to-date
   *  report set, not the possibly-stale `reports()` snapshot (a no-op
   *  report refreshes its own entry without republishing `reports()` — see
   *  `register()`'s `report()`), so this always retries with whichever
   *  `source`/`retry` a report most recently carried. */
  resetMatching(predicate: (error: unknown) => boolean): void
}

/** Maps a status to the scope interface that collects it. */
interface ScopeOfKind {
  pending: LoadingScope
  error: ErrorScope
}

/**
 * An error handler installed by `catchError`, optionally filtered to only
 * some errors via `for`. A handler that declines an error (`for` returns
 * `false`) is treated as absent for that error — the walk continues to the
 * next owner with the same error, exactly as if this handler were not
 * installed.
 */
export interface ErrorHandlerEntry {
  handle(error: unknown): void
  /** If given, this handler only claims errors for which it returns `true`.
   *  Omitted, it claims every error, matching the pre-filter behaviour. */
  for?: (error: unknown) => boolean
}

/** A lifecycle scope. Owns reactive nodes created within it and their cleanup callbacks. */
export interface Owner {
  /** The parent owner in the lifecycle tree, or `null` for a root. */
  readonly parent: Owner | null
  /** Optional error handler (set by `catchError`). When a reactive node owned
   *  by this owner (or a descendant) throws, the throw walks up via `parent`
   *  links to find the nearest handler that accepts it. */
  readonly errorHandler: ErrorHandlerEntry | null
  /** Disposers for owned reactive nodes (effects, computeds) and sub-owners. */
  readonly children: Array<{ dispose: () => void }>
  /** Owner-level cleanup callbacks registered via `onCleanup` outside any r3 context. */
  readonly cleanups: Disposable[]
  /** True once this owner has been disposed. Use-after-dispose throws. */
  disposed: boolean
  /** Boundary scopes installed on this owner, keyed by the status each collects.
   *  Set by `<Loading>` and `<Errored>` on their own boundary owner. */
  boundaries: { pending: LoadingScope | null; error: ErrorScope | null }
}

let currentOwner: Owner | null = null

function newOwner(
  parent: Owner | null = null,
  errorHandler: ErrorHandlerEntry | null = null,
): Owner {
  return {
    parent,
    errorHandler,
    children: [],
    cleanups: [],
    disposed: false,
    boundaries: { pending: null, error: null },
  }
}

/**
 * Walk up the owner chain from `start`, invoking the first `errorHandler`
 * that accepts `error` — one whose `for`, if given, returns `true` for it, or
 * that has no `for` at all. A handler that declines is skipped exactly as if
 * it were absent, and the walk continues to its owner's `parent` with the
 * same error. If the handler itself throws, continue walking from that
 * owner's `parent` with the new error instead. If no handler eventually
 * catches, the final error is re-thrown.
 *
 * Internal: called by `effect`/`computed` wrappers on a non-`NotReadyYet` throw.
 */
export function routeError(start: Owner | null, error: unknown): void {
  let owner = start
  while (owner !== null) {
    const handler = owner.errorHandler
    if (handler !== null && (handler.for === undefined || handler.for(error))) {
      try {
        handler.handle(error)
        return // handled
      } catch (newError) {
        owner = owner.parent
        error = newError
        continue
      }
    }
    owner = owner.parent
  }
  // No handler caught — re-throw the final error.
  throw error
}

/**
 * The nearest `<Errored>` boundary that accepts `error` — or `null` if a
 * `catchError` handler that accepts it is nearer, or if nothing along the
 * way accepts it at all. Returns the boundary's own owner alongside its
 * scope: a caller that needs to know when the BOUNDARY itself (as opposed
 * to whatever owner it started walking from) goes away — e.g. to anchor an
 * `onCleanup` there instead of on the calling owner — needs that owner
 * directly, since `ErrorScope` alone does not expose it.
 *
 * `<Errored>` and `catchError` are peers in ONE walk up the owner chain, and
 * the nearest one that ACCEPTS `error` wins. An `<Errored for={...}>` or
 * `catchError(fn, handler, { for: ... })` that declines `error` is treated
 * as if it were not there at all for this specific error, and the walk
 * continues past it — including past a nearer, declining `catchError`, to
 * check a farther `<Errored>` or `catchError`. Returning `null` when the
 * nearest accepting thing is a `catchError` is what lets the caller fall
 * through to `routeError`, which walks the same chain and finds it.
 */
export function findNearestErrorScope(
  start: Owner | null,
  error: unknown,
): { owner: Owner; scope: ErrorScope } | null {
  let owner = start
  while (owner !== null) {
    const scope = owner.boundaries.error
    if (scope !== null && (scope.for === undefined || scope.for(error))) {
      return { owner, scope }
    }
    const handler = owner.errorHandler
    if (handler !== null && (handler.for === undefined || handler.for(error))) {
      return null // a nearer, accepting catchError wins
    }
    owner = owner.parent
  }
  return null
}

/**
 * Route an error that surfaced on a RE-RUN — one driven by a graph write rather
 * than by the caller's own synchronous run.
 *
 * `routeError` re-throws when nothing handles the error. That is right on a node's
 * first run: the caller created the node, so the throw belongs to them. It is wrong
 * on a re-run. A re-run is triggered by a write, and that write may come from inside
 * another node's settle handler — so an un-handled throw would unwind the writer
 * mid-update, aborting bookkeeping that has nothing to do with the failing consumer.
 * (This is precisely how a rejected computed used to lose its parked error: its
 * consumer had no boundary, and the re-throw unwound the settle handler before it
 * could record the error.)
 *
 * A node's state must not depend on whether its consumers have error boundaries. So
 * on a re-run we route as usual, and an error nobody handled is reported rather than
 * thrown into whoever happened to trigger the flush.
 *
 * Internal: called by `effect` on any run after the first.
 */
export function routeErrorFromRerun(start: Owner | null, error: unknown): void {
  try {
    routeError(start, error)
  } catch (unhandled) {
    console.error(unhandled)
  }
}

/** Returns the current ambient owner, or `null` if outside any root. */
export function getOwner(): Owner | null {
  return currentOwner
}

/**
 * Run `fn` with `owner` as the ambient owner. Restores the previous owner after,
 * even if `fn` throws. Throws if `owner` is disposed.
 */
export function runWithOwner<T>(owner: Owner | null, fn: () => T): T {
  if (owner !== null && owner.disposed) {
    throw new Error('runWithOwner: owner has been disposed')
  }
  const prev = currentOwner
  currentOwner = owner
  try {
    return fn()
  } finally {
    currentOwner = prev
  }
}

/** What a failed binding reported: the error, the node whose parked error it
 *  threw (if any), and how to re-run it. Mirrors the shape `src/effect.ts`
 *  reports through `BindingState`'s `'error'` case. */
export interface ErrorReport {
  readonly error: unknown
  readonly source: Accessor<unknown> | null
  readonly retry: () => void
}

/**
 * Build an `ErrorScope`: the collection/report/reset logic shared by every
 * `<Errored>` boundary and by the default boundary `createRoot()` installs on
 * every root (below).
 *
 * Built directly on raw r3 primitives, not pulse's `signal()` wrapper —
 * `src/signal.ts` imports from `src/scope.ts`, which already imports from
 * this file (`findNearestErrorScope`/`getOwner`/`onCleanup`), so importing
 * `signal()` back here would cycle. `src/scope.ts`'s own `makeErrorCell()`
 * solves the identical problem the same way. Same reason `error`/`active`
 * are raw r3 `computed`s below rather than pulse's own `computed()`.
 *
 * `onErrorReport`, if given, runs once for every `'error'` report this
 * scope receives, regardless of whether anything is reading its `active`/
 * `error` — used by `createRoot()`'s default scope to `console.error` every
 * error, matching `routeErrorFromRerun`'s existing "always log" behaviour.
 * An explicit `<Errored>` passes nothing, matching its existing silent
 * behaviour (the app is assumed to be handling it via `fallback`/`useErrored()`).
 */
export function createErrorScope(
  onErrorReport?: (error: unknown) => void,
  filterFor?: (error: unknown) => boolean,
): ErrorScope {
  // One entry per currently-failed binding, keyed on its controller — so a
  // binding that re-runs and re-reports stays ONE entry.
  const errorSet = new Map<BindingController, ErrorReport>()

  const reportsNode = r3Signal<readonly ErrorReport[]>([])

  // Mirrors `makeErrorCell`'s top-level-read behaviour (`src/scope.ts`):
  // inside an r3 context, read through it directly; outside one, stabilize
  // first so the value is never stale.
  const readReports = (): readonly ErrorReport[] => {
    if (getContext() !== null) return r3Read(reportsNode)
    stabilize()
    return reportsNode.value
  }

  // `error`/`active` derive from `reportsNode` through their own raw r3
  // `computed`s rather than being read inline off `reportsNode` on every
  // call. `reportsNode` itself publishes a fresh array on every genuine
  // change to ANY entry — `useErrored(predicate)` needs to see a change to
  // a non-first entry too, so it cannot skip that write. A computed node
  // re-runs its own body whenever its dependency changes, but only
  // notifies ITS OWN subscribers when the value it produces actually
  // changed (r3's own `value !== el.value` check) — so a change to a
  // non-first entry re-runs these two computeds' bodies (cheap: just an
  // array index and a length check) without re-notifying whatever reads
  // `error()`/`active()`, as long as the first entry itself is unchanged.
  // Reading `reportsNode` directly inline, instead of through a memoizing
  // computed, would lose exactly this — every subscriber of one shared
  // signal is marked dirty on every write to it, with nothing downstream
  // to absorb a change that does not affect what that subscriber reads.
  const errorNode = r3Computed<unknown>(() => readReports()[0]?.error ?? null)
  const activeNode = r3Computed<boolean>(() => readReports().length > 0)

  const readError = (): unknown => {
    if (getContext() !== null) return r3Read(errorNode)
    stabilize()
    return errorNode.value
  }
  const readActive = (): boolean => {
    if (getContext() !== null) return r3Read(activeNode)
    stabilize()
    return activeNode.value
  }

  const recompute = (): void => {
    r3SetSignal(reportsNode, Array.from(errorSet.values()))
    // Pair the write with a flush request, the same way every other writer in
    // pulse does (`signal()`'s setter, `computed`'s publish). r3's `setSignal`
    // only inserts subscribers into its dirty heap — something has to call
    // `stabilize()` to actually drain it. Without this, a consumer of this
    // scope (`<Errored.Error>`, `isErrored()`, `useErrored()`) is left marked
    // dirty and never recomputed, so an error reported here is invisible until
    // some UNRELATED write happens to request a flush. That made the whole
    // error boundary's liveness depend on incidental traffic elsewhere in the
    // tree — see docs/follow-ups.md and the regression test in
    // test/dom/error.test.tsx.
    requestFlush()
  }

  const resetEntries = (entries: Array<[BindingController, ErrorReport]>): void => {
    for (const [controller] of entries) errorSet.delete(controller)
    recompute()
    for (const [, report] of entries) {
      // Clear the parked error at its root first — otherwise the binding
      // just re-reads a still-failed node and throws again.
      if (report.source !== null) resetError(report.source)
      report.retry()
    }
  }

  const reset = (): void => {
    resetEntries(Array.from(errorSet.entries()))
  }

  const resetMatching = (predicate: (error: unknown) => boolean): void => {
    resetEntries(Array.from(errorSet.entries()).filter(([, report]) => predicate(report.error)))
  }

  return {
    kind: 'error',
    error: readError,
    active: readActive,
    reports: readReports,
    for: filterFor,
    register(): BindingController {
      const controller: BindingController = {
        report(state): void {
          if (state.status === 'error') {
            onErrorReport?.(state.error)
            // A single rejection re-runs a binding several times, and it
            // re-reports 'error' each time with the identical error. The
            // stored report is always refreshed — source/retry can differ
            // between reports of the "same" error (a pending-to-failed
            // settle reports before the source is attached, and a later
            // re-run reports it correctly) — but the published collection is
            // only rewritten, and consumers only re-notified, when the error
            // itself changed. Load-bearing: consumers must not re-render for
            // a report that changes nothing they read.
            const existing = errorSet.get(controller)
            const isNoOpReport = existing !== undefined && Object.is(existing.error, state.error)
            errorSet.set(controller, {
              error: state.error,
              source: state.source,
              retry: state.retry,
            })
            if (isNoOpReport) return
          } else {
            // Any other status means this binding is no longer failed. In
            // practice only 'idle' is ever sent to a failed-scope controller
            // (see src/effect.ts) — 'throwing'/'ready' go to a pending scope.
            if (!errorSet.has(controller)) return
            errorSet.delete(controller)
          }
          recompute()
        },
        unregister(): void {
          errorSet.delete(controller)
          recompute()
        },
      }
      return controller
    },
    reset,
    resetMatching,
  }
}

/**
 * Create a fresh root owner and run `fn` with it as the ambient owner. Returns
 * `fn`'s return value. Call `dispose()` to clean up everything created within
 * (owned reactive nodes are disposed bottom-up, then owner-level `onCleanup`
 * callbacks fire in LIFO order).
 *
 * `createRoot` is always a root — nested calls do not parent to the outer owner.
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner = newOwner()
  // Every root gets a default ErrorScope, so findNearestErrorScope/
  // findBoundaryScope('error') always finds something once it reaches the
  // root — an explicit <Errored> anywhere between the failing binding and the
  // root still wins (nearest match), and a nearer catchError still wins over
  // any ErrorScope, explicit or implicit, exactly as before. This is what
  // lets useErrored() always return real state, and what lets action() (see
  // src/scope.ts) and a failed computed/signal binding (see src/effect.ts)
  // register with something instead of throwing/logging with nowhere for the
  // error to be queried from — console.error keeps it exactly as visible
  // by default as routeErrorFromRerun already made it.
  owner.boundaries.error = createErrorScope((error) => console.error(error))
  const dispose = () => disposeOwner(owner)
  return runWithOwner(owner, () => fn(dispose))
}

/**
 * Internal: create a sub-owner parented to `parent` (or to no one when null),
 * optionally with an `errorHandler` attached. Registers the new sub-owner as
 * a disposable child of `parent` so the parent's `dispose()` cascades.
 *
 * Not exported from the public barrel. Used by `catchError` today; will be
 * used by `Show`/`For` branch scopes in Plan 3b.
 */
export function createSubOwner(
  parent: Owner | null,
  errorHandler: ErrorHandlerEntry | null = null,
): Owner {
  if (parent !== null && parent.disposed) {
    throw new Error('cannot create a sub-owner inside a disposed owner')
  }
  const sub = newOwner(parent, errorHandler)
  if (parent !== null) {
    parent.children.push({ dispose: () => disposeOwner(sub) })
  }
  return sub
}

/**
 * Create a sub-owner with an error handler attached, then run `fn` with the
 * sub-owner as ambient. Reactive nodes (effects, computeds) created inside
 * `fn` parent to this sub-owner; when they throw a non-`NotReadyYet` error,
 * the throw walks up the owner chain and the nearest accepting handler is
 * invoked.
 *
 * `options.for`, if given, restricts `handler` to only the errors for which
 * it returns `true`. An error it declines is treated as if this `catchError`
 * were not here at all: the walk continues to the next ancestor handler (a
 * farther `catchError`, or nothing, in which case the error propagates same
 * as if there were no handler anywhere). Omitting `options.for` accepts
 * every error, matching the pre-filter behavior.
 *
 * The sub-owner is registered as a disposable child of `currentOwner` — so
 * the parent's `dispose()` cascades down to it automatically. If called
 * outside any root, the sub-owner has no parent and lives until GC.
 *
 * `fn` itself is wrapped in `try/catch`: synchronous throws inside `fn` are
 * also routed through `routeError`. Returns `fn`'s return value, or
 * `undefined` if `fn` threw and the handler caught.
 */
export function catchError<T>(
  fn: () => T,
  handler: (error: unknown) => void,
  options?: { for?: (error: unknown) => boolean },
): T | undefined {
  const entry: ErrorHandlerEntry = { handle: handler, for: options?.for }
  const sub = createSubOwner(currentOwner, entry)
  return runWithOwner(sub, () => {
    try {
      return fn()
    } catch (e) {
      routeError(sub, e)
      return undefined
    }
  })
}

export function disposeOwner(owner: Owner): void {
  if (owner.disposed) return
  owner.disposed = true
  // Bottom-up: dispose owned children first (their r3 nodes detach from deps).
  // Iterate in reverse for LIFO disposal (last-created first to go).
  for (let i = owner.children.length - 1; i >= 0; i--) {
    try {
      owner.children[i].dispose()
    } catch {
      // swallow per-child errors so one bad disposer doesn't strand the rest
    }
  }
  owner.children.length = 0
  // Then owner-level cleanups, also LIFO.
  for (let i = owner.cleanups.length - 1; i >= 0; i--) {
    try {
      const c = owner.cleanups[i]
      c()
    } catch {
      // swallow per-cleanup errors
    }
  }
  owner.cleanups.length = 0
}

/**
 * Register a disposable with the current ambient owner. No-op if outside any
 * root.
 *
 * Defensive: also throws if the current owner is somehow disposed. The public
 * paths cannot reach this branch — `runWithOwner` already throws for a
 * disposed owner before setting it as current — so this guard catches only
 * direct misuse from internal callers.
 *
 * Internal: called by `effect` and `computed` on creation.
 */
export function registerWithOwner(disposable: { dispose: () => void }): void {
  if (currentOwner === null) return
  if (currentOwner.disposed) {
    throw new Error('cannot register a reactive node with a disposed owner')
  }
  currentOwner.children.push(disposable)
}

/**
 * Register a cleanup function. Routing rules:
 * - Inside a generator stage being driven: registers on that generator — fires
 *   when the generator ends, whether it completes, is discarded because a
 *   dependency changed, or its owner is disposed. Per-run cleanup has no
 *   coherent meaning in a body that resumes rather than re-running, so the
 *   generator's lifetime is used instead.
 * - Inside an r3 context (a running computed/effect body): registers per-run
 *   cleanup via r3 — fires before the next re-run of that node.
 * - Outside r3 context, inside a `createRoot` callback: registers on the
 *   current owner — fires on `dispose()`.
 * - Outside both: silently no-op (permissive).
 */
export function onCleanup(fn: Disposable): Disposable {
  // Checked before the r3 context, because driving a generator happens inside
  // an r3 context and the generator's lifetime is the more specific answer.
  const generatorCleanups = currentGeneratorCleanups()
  if (generatorCleanups !== null) {
    generatorCleanups.push(fn)
    return fn
  }
  if (getContext() !== null) {
    return r3OnCleanup(fn)
  }
  if (currentOwner !== null && !currentOwner.disposed) {
    currentOwner.cleanups.push(fn)
  }
  return fn
}

/**
 * Walk up the parent chain from `start` (inclusive) and return the first boundary
 * scope collecting `kind`. Returns `null` if none is found.
 *
 * Internal: used by `useLoading()`, and by bindings reporting their status.
 */
export function findBoundaryScope<K extends BindingStatus>(
  start: Owner | null,
  kind: K,
): ScopeOfKind[K] | null {
  let owner = start
  while (owner !== null) {
    const scope = owner.boundaries[kind]
    if (scope !== null) return scope as ScopeOfKind[K]
    owner = owner.parent
  }
  return null
}

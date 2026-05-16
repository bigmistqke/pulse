import { getContext, type Disposable, onCleanup as r3OnCleanup } from 'r3'
import type { Accessor } from './signal'

/**
 * Reactive pending-state handle attached to an `Owner` by `<Loading>`.
 * Inner binding-effects that catch `NotReadyYet` walk up the owner chain
 * to find the nearest scope and register themselves as pending.
 */
export interface LoadingScope {
  /** `true` while at least one descendant binding is registered as pending. */
  readonly pending: Accessor<boolean>
  /** Increment the pending count. Returns an unregister callback. */
  register: () => () => void
}

/** A lifecycle scope. Owns reactive nodes created within it and their cleanup callbacks. */
export interface Owner {
  /** The parent owner in the lifecycle tree, or `null` for a root. */
  readonly parent: Owner | null
  /** Optional error handler (set by `catchError`). When a reactive node owned
   *  by this owner (or a descendant) throws, the throw walks up via `parent`
   *  links to find the nearest handler. */
  readonly errorHandler: ((error: unknown) => void) | null
  /** Disposers for owned reactive nodes (effects, computeds) and sub-owners. */
  readonly children: Array<{ dispose: () => void }>
  /** Owner-level cleanup callbacks registered via `onCleanup` outside any r3 context. */
  readonly cleanups: Disposable[]
  /** True once this owner has been disposed. Use-after-dispose throws. */
  disposed: boolean
  /** Optional loading scope (set by `<Loading>`). Used by binding-effects on `NotReadyYet` to register pending. */
  loadingScope: LoadingScope | null
}

let currentOwner: Owner | null = null

function newOwner(
  parent: Owner | null = null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
  return { parent, errorHandler, children: [], cleanups: [], disposed: false, loadingScope: null }
}

/**
 * Walk up the owner chain from `start`, invoking the first `errorHandler`
 * encountered. If the handler itself throws, continue walking from that
 * owner's `parent` with the new error. If no handler eventually catches,
 * the final error is re-thrown.
 *
 * Internal: called by `effect`/`computed` wrappers on a non-`NotReadyYet` throw.
 */
export function routeError(start: Owner | null, error: unknown): void {
  let owner = start
  while (owner !== null) {
    const handler = owner.errorHandler
    if (handler !== null) {
      try {
        handler(error)
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
  errorHandler: ((error: unknown) => void) | null = null,
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
 * the throw walks up the owner chain and the nearest handler is invoked.
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
): T | undefined {
  const sub = createSubOwner(currentOwner, handler)
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
 * - Inside an r3 context (a running computed/effect body): registers per-run
 *   cleanup via r3 — fires before the next re-run of that node.
 * - Outside r3 context, inside a `createRoot` callback: registers on the
 *   current owner — fires on `dispose()`.
 * - Outside both: silently no-op (permissive).
 */
export function onCleanup(fn: Disposable): Disposable {
  if (getContext() !== null) {
    return r3OnCleanup(fn)
  }
  if (currentOwner !== null && !currentOwner.disposed) {
    currentOwner.cleanups.push(fn)
  }
  return fn
}

/**
 * Walk up the parent chain from `start` (inclusive) and return the first
 * non-null `loadingScope`. Returns `null` if none found. Internal helper
 * used by `useLoading()` and by binding-effects on `NotReadyYet`.
 */
export function findLoadingScope(start: Owner | null): LoadingScope | null {
  let owner = start
  while (owner !== null) {
    if (owner.loadingScope !== null) return owner.loadingScope
    owner = owner.parent
  }
  return null
}

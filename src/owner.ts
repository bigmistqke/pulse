import { getContext, type Disposable, onCleanup as r3OnCleanup } from 'r3'

/** A lifecycle scope. Owns reactive nodes created within it and their cleanup callbacks. */
export interface Owner {
  /** Disposers for owned reactive nodes (effects, computeds). Bottom-up on dispose. */
  readonly children: Array<{ dispose: () => void }>
  /** Owner-level cleanup callbacks registered via `onCleanup` outside any r3 context. */
  readonly cleanups: Disposable[]
  /** True once this owner has been disposed. Use-after-dispose throws. */
  disposed: boolean
}

let currentOwner: Owner | null = null

function newOwner(): Owner {
  return { children: [], cleanups: [], disposed: false }
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

function disposeOwner(owner: Owner): void {
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

# pulse Loading + useLoading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `<Loading>` component, `useLoading()` hook, owner `loadingScope` extension, and binding-effect registration so per-binding suspension aggregates into a coordinated boundary.

**Architecture:** Owner gains a `loadingScope` field (analogous to Plan 2d's `errorHandler`). `<Loading>` creates a `boundaryOwner` with a `loadingScope` attached and calls its function-child once inside it (constructing the loaded subtree under that owner). Binding-effects in `src/effect.ts` walk up on `NotReadyYet` to find the nearest scope and increment its counter; on successful re-run they decrement. Loading observes the counter and toggles between `initial` / `fallback` / loaded slots, holding prior subtree DOM (with live effects) when no `fallback` is given. `useLoading()` is a small owner-walk helper returning the nearest scope's `pending` accessor.

**Tech Stack:** TypeScript, Vitest (browser mode for DOM tests), Playwright (Chromium), pulse core (existing `signal`, `effect`, `createSubOwner`, `disposeOwner`, `runWithOwner`, `onCleanup`, `getOwner`, `routeError`, `isPromise`), r3 (untouched).

**Companion spec:** `docs/superpowers/specs/2026-05-16-pulse-loading-design.md`
**Design rationale:** `docs/adr/0007-async-coordination-data-as-signals.md`

---

## File map

```
src/
  owner.ts              — add LoadingScope interface; add `loadingScope` field to Owner; init in newOwner; export type
  effect.ts             — find nearest loadingScope on NotReadyYet; register/unregister around suspension cycles
  dom/
    loading.ts          — Loading component + useLoading hook + findLoadingScope helper
    index.ts            — add: export { Loading, useLoading }
  index.ts              — add: export { Loading, useLoading } from './dom'
test/
  dom/
    loading.test.tsx    — covers all spec §14 cases (10 tests)
```

`findLoadingScope` is a small walker. It's declared in `src/dom/loading.ts` (used by `useLoading` directly) and also imported by `src/effect.ts` (used during NotReadyYet catch). To avoid a circular import (`effect.ts` → `dom/loading.ts` would be wrong layering since `dom/` depends on core), we put the walker in `src/owner.ts` itself (next to the field definition) and import it from both consumers.

## Conventions

- `pnpm`, not npm.
- `main` branch directly.
- Each task ends with a single commit; commits do **not** carry AI co-author trailers.
- TDD: failing tests → minimal implementation → green.
- Existing tests must remain green after every task.

---

### Task 1: Owner extension — `loadingScope` field + walker

**Files:**
- Modify: `src/owner.ts`
- Modify: `src/index.ts` (re-export `LoadingScope` type if useful — leave un-exported for now)
- Modify: existing test file or new one if needed; this task adds tests inline in `test/owner.test.ts`

This task introduces the `LoadingScope` interface and adds the `loadingScope` field to `Owner` (default `null`). Also adds an internal `findLoadingScope(owner)` helper that walks the parent chain. No behaviour change for existing code; the field is unused so far.

- [ ] **Step 1: Confirm starting state**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean. Note the test count for later reference.

- [ ] **Step 2: Write the failing test**

Append to `test/owner.test.ts`:

```ts
import { type LoadingScope } from '../src/owner'   // will fail until export added

test('Owner.loadingScope defaults to null', () => {
  createRoot(() => {
    const owner = getOwner()!
    expect(owner.loadingScope).toBe(null)
  })
})

test('findLoadingScope walks parent chain to find first non-null entry', () => {
  let captured: LoadingScope | null = null
  createRoot(() => {
    const outer = getOwner()!
    const scope: LoadingScope = {
      pending: () => true,
      register: () => () => {},
    }
    outer.loadingScope = scope
    catchError(() => {
      // inner owner is a child of outer via createSubOwner inside catchError
      captured = findLoadingScope(getOwner())
    }, () => {})
  })
  expect(captured).toBe(scope)
})

test('findLoadingScope returns null when no scope on chain', () => {
  let captured: LoadingScope | null = 'unset' as any
  createRoot(() => {
    captured = findLoadingScope(getOwner())
  })
  expect(captured).toBe(null)
})
```

Add the imports at the top of `test/owner.test.ts` as needed:

```ts
import { createRoot, getOwner, catchError } from '../src/index'
import { findLoadingScope, type LoadingScope } from '../src/owner'
```

(`findLoadingScope` and `LoadingScope` will be exported from `src/owner.ts` in Step 4 — internal exports, not added to public barrel.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- --project unit owner.test`
Expected: FAIL — `findLoadingScope` / `LoadingScope` not exported; `owner.loadingScope` undefined.

- [ ] **Step 4: Implement the extension**

Open `src/owner.ts`. Add this near the top (after imports, before the `Owner` interface):

```ts
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
```

Modify the `Owner` interface to add the field:

```ts
export interface Owner {
  readonly parent: Owner | null
  readonly errorHandler: ((error: unknown) => void) | null
  readonly children: Array<{ dispose: () => void }>
  readonly cleanups: Disposable[]
  disposed: boolean
  /** Optional pending-state handle (attached by `<Loading>`). `useLoading()`
   *  and effect-suspension paths walk up `parent` looking for the nearest
   *  non-null entry. */
  loadingScope: LoadingScope | null
}
```

Modify `newOwner` to initialize the new field:

```ts
function newOwner(
  parent: Owner | null = null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
  return {
    parent,
    errorHandler,
    children: [],
    cleanups: [],
    disposed: false,
    loadingScope: null,
  }
}
```

Add the walker at the end of the file (before disposeOwner if you prefer the helpers-after-types layout):

```ts
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
```

(`LoadingScope` is exported as a type but NOT added to `src/index.ts`'s public re-exports — it's an internal contract for the framework's own use.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass (3 new + all prior); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/owner.ts test/owner.test.ts
git commit -m "feat(owner): add LoadingScope field + findLoadingScope walker"
```

---

### Task 2: Binding-effect registration with `loadingScope`

**Files:**
- Modify: `src/effect.ts`
- Modify: `test/effect.test.ts` (or new file)

When a binding-effect's body catches `NotReadyYet`, it should also register
with the nearest `loadingScope` (incrementing the count). When the same effect
later runs successfully, it unregisters (decrementing). The effect's owner
disposing must also unregister if still pending.

- [ ] **Step 1: Write the failing tests**

Append to `test/effect.test.ts`:

```ts
import { findLoadingScope, type LoadingScope } from '../src/owner'

test('effect that suspends increments nearest loadingScope', async () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    pending: () => count > 0,
    register: () => {
      count++
      return () => { count-- }
    },
  }
  let resolve!: (v: number) => void
  const p = new Promise<number>((r) => { resolve = r })

  await createRoot(async (dispose) => {
    getOwner()!.loadingScope = scope
    effect(() => { use(p) })
    expect(count).toBe(1) // suspended → registered
    resolve(42)
    await p
    flush()
    expect(count).toBe(0) // settled → unregistered
    dispose()
  })

  setScheduler(microtaskScheduler(flush))
})

test('effect disposal while pending unregisters from loadingScope', () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    pending: () => count > 0,
    register: () => {
      count++
      return () => { count-- }
    },
  }
  const p = new Promise<number>(() => {}) // never settles

  const dispose = createRoot((d) => {
    getOwner()!.loadingScope = scope
    effect(() => { use(p) })
    return d
  })
  expect(count).toBe(1) // suspended
  dispose()
  expect(count).toBe(0) // disposed → unregistered

  setScheduler(microtaskScheduler(flush))
})

test('effect that never suspends does not touch loadingScope', () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    pending: () => count > 0,
    register: () => {
      count++
      return () => { count-- }
    },
  }
  createRoot(() => {
    getOwner()!.loadingScope = scope
    effect(() => { /* sync, no use() */ })
    expect(count).toBe(0)
  })

  setScheduler(microtaskScheduler(flush))
})
```

Make sure `use`, `effect`, `createRoot`, `getOwner`, `flush`, `setScheduler`, `syncScheduler`, `microtaskScheduler` are imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project unit effect.test`
Expected: FAIL — the first test fails at `expect(count).toBe(1)` (current effect doesn't register with loadingScope).

- [ ] **Step 3: Modify `effect.ts` to register/unregister**

The full updated body of `src/effect.ts`:

```ts
import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { NotReadyYet } from './async'
import { findLoadingScope, getOwner, routeError, registerWithOwner } from './owner'
import { signal } from './signal'

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs (after the scheduler flushes) whenever a signal it read changes.
 *
 * If the body throws `NotReadyYet` (via `use` on a pending promise), the effect
 * suspends: it holds — running nothing further this pass — and re-runs once the
 * carried promise settles. Re-running is driven by an internal "kick" signal the
 * body reads every pass; settling calls setKick(...), marking the effect dirty.
 * Any other thrown value is a genuine error and is re-thrown.
 *
 * When suspended, the effect also registers itself with the nearest enclosing
 * `loadingScope` (attached by `<Loading>`) so a Loading boundary observes the
 * suspension. Unregisters on successful re-run or disposal.
 *
 * `suspendedOn` tracks the promise the effect is currently suspended on (or
 * `null`). A successful run clears it; the kick callback only fires if
 * `suspendedOn` still matches — so when the promise came from a signal,
 * write-back re-triggers the effect and the redundant kick becomes a no-op.
 */
export function effect(fn: () => void): void {
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  // `kickCount` increments per kick so each setKick(...) is a distinct value
  // (r3's setSignal bails on `el.value === v`, so writing the same value would be a no-op).
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let unregisterPending: (() => void) | null = null

  const body = () => {
    kick() // depend on the kick signal so a settled promise can re-trigger this effect
    try {
      fn()
      suspendedOn = null // completed successfully — no longer suspended
      // If we were previously registered with a loading scope, unregister now.
      if (unregisterPending !== null) {
        unregisterPending()
        unregisterPending = null
      }
    } catch (e) {
      if (e instanceof NotReadyYet) {
        const alreadySuspendedOnSame = suspendedOn === e.promise
        suspendedOn = e.promise
        if (!alreadySuspendedOnSame) {
          const p = e.promise
          const rerun = () => {
            if (suspendedOn === p) {
              suspendedOn = null
              setKick(++kickCount)
            }
          }
          p.then(rerun, rerun)
        }
        // Register with nearest loadingScope (idempotent — only on first throw per pending cycle).
        if (unregisterPending === null) {
          const scope = findLoadingScope(myOwner)
          if (scope !== null) unregisterPending = scope.register()
        }
        return // suspended: hold — do not run the rest of fn, do not propagate
      }
      routeError(myOwner, e) // throws if no handler catches
    }
  }

  const node = r3Computed(body)
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      // If we're disposed while pending, unregister from loading scope.
      if (unregisterPending !== null) {
        unregisterPending()
        unregisterPending = null
      }
    },
  })
}
```

- [ ] **Step 4: Run effect tests**

Run: `pnpm test -- --project unit effect.test`
Expected: PASS — all new tests pass, all prior effect tests pass.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/effect.ts test/effect.test.ts
git commit -m "feat(effect): register with nearest loadingScope on NotReadyYet"
```

---

### Task 3: `<Loading>` component + `useLoading()` hook + DOM tests

**Files:**
- Create: `src/dom/loading.ts`
- Modify: `src/dom/index.ts`
- Modify: `src/index.ts`
- Create: `test/dom/loading.test.tsx`

Adds the user-facing surface. Loading creates a `boundaryOwner` with a `loadingScope`, calls its function child once inside that owner, and returns a reactive accessor selecting between slots based on the count. `useLoading()` walks up to find the nearest scope.

- [ ] **Step 1: Write the failing tests**

Create `test/dom/loading.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  flush,
  Loading,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  Show,
  signal,
  syncScheduler,
  use,
  useLoading,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('synchronous loaded thunk renders immediately; pending stays false', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => <Loading initial={<p>init</p>}>{() => <span>hi</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('hi')
  dispose()
})

test('pending use() initially renders `initial`', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading initial={<p>loading…</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('loading…')
  dispose()
})

test('pending use() with no initial → renders fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading fallback={<p>fb</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('fb')
  dispose()
})

test('pending use() with neither → renders nothing', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => <Loading>{() => <span>{() => use(p)}</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('')
  dispose()
})

test('settled → loaded subtree rendered', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const dispose = render(
    () => (
      <Loading initial={<p>loading…</p>}>
        {() => <span>{() => use(p)}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('loading…')
  resolveP('hello')
  await p
  flush()
  expect(target.textContent).toBe('hello')
  dispose()
})

test('subsequent pending with fallback → renders fallback', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const [src, setSrc] = signal<string | Promise<string>>(p)
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>} fallback={<p>fb</p>}>
        {() => <span>{() => use(src())}</span>}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('init')
  resolveP('A')
  await p
  flush()
  expect(target.textContent).toBe('A')

  let resolveQ!: (v: string) => void
  const q = new Promise<string>((r) => { resolveQ = r })
  setSrc(q)
  expect(target.textContent).toBe('fb') // subsequent pending, fallback shown
  resolveQ('B')
  await q
  flush()
  expect(target.textContent).toBe('B')
  dispose()
})

test('subsequent pending without fallback → holds prior loaded subtree', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })
  const [src, setSrc] = signal<string | Promise<string>>(p)
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => <span>{() => use(src())}</span>}
      </Loading>
    ),
    target,
  )
  resolveP('A')
  await p
  flush()
  expect(target.textContent).toBe('A')

  const q = new Promise<string>(() => {}) // never settles
  setSrc(q)
  expect(target.textContent).toBe('A') // hold prior
  dispose()
})

test('two pending bindings: both must settle before loaded slot mounts', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveA!: (v: string) => void
  let resolveB!: (v: string) => void
  const a = new Promise<string>((r) => { resolveA = r })
  const b = new Promise<string>((r) => { resolveB = r })
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  expect(target.textContent).toBe('init')
  resolveA('A')
  await a
  flush()
  expect(target.textContent).toBe('init') // b still pending
  resolveB('B')
  await b
  flush()
  expect(target.textContent).toBe('AB')
  dispose()
})

test('useLoading() inside subtree reflects pending state', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveP!: (v: string) => void
  const p = new Promise<string>((r) => { resolveP = r })

  function Header() {
    const pending = useLoading()
    return <Show when={pending} fallback={<i>idle</i>}>{() => <i>busy</i>}</Show>
  }

  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => (
          <>
            <Header/>
            <span>{() => use(p)}</span>
          </>
        )}
      </Loading>
    ),
    target,
  )
  // During initial pending, the loaded subtree isn't mounted yet — Header isn't visible.
  // After settle, subtree mounts and Header reads pending=false.
  resolveP('done')
  await p
  flush()
  expect(target.textContent).toContain('idle')
  expect(target.textContent).toContain('done')
  dispose()
})

test('non-NotReadyYet error in a binding inside Loading propagates to catchError', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const caught: unknown[] = []
  const [trigger, setTrigger] = signal(false)
  const dispose = render(
    () =>
      catchError(
        () => (
          <Loading initial={<p>init</p>}>
            {() => (
              <span>
                {() => {
                  if (trigger()) throw new Error('boom')
                  return 'ok'
                }}
              </span>
            )}
          </Loading>
        ),
        (e) => caught.push(e),
      ) as Node,
    target,
  )
  expect(target.textContent).toBe('ok')
  setTrigger(true)
  expect(caught.length).toBe(1)
  expect((caught[0] as Error).message).toBe('boom')
  dispose()
})

test('nested Loading: inner pending registers only with inner', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolveOuter!: (v: string) => void
  let resolveInner!: (v: string) => void
  const outerP = new Promise<string>((r) => { resolveOuter = r })
  const innerP = new Promise<string>((r) => { resolveInner = r })

  const dispose = render(
    () => (
      <Loading initial={<p>outer-init</p>}>
        {() => (
          <>
            <span>{() => use(outerP)}</span>
            <Loading initial={<p>inner-init</p>}>
              {() => <span>{() => use(innerP)}</span>}
            </Loading>
          </>
        )}
      </Loading>
    ),
    target,
  )
  // Initially: outer pending → outer-init shown
  expect(target.textContent).toBe('outer-init')
  resolveOuter('OUTER')
  await outerP
  flush()
  // Outer settled; inner still pending → outer subtree mounted, inner-init shown for inner
  expect(target.textContent).toContain('OUTER')
  expect(target.textContent).toContain('inner-init')
  resolveInner('INNER')
  await innerP
  flush()
  expect(target.textContent).toContain('OUTER')
  expect(target.textContent).toContain('INNER')
  dispose()
})

test('disposing surrounding owner cascades to Loading', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const dispose = render(
    () => (
      <Loading initial={<p>init</p>}>
        {() => {
          onCleanup(() => { cleaned = true })
          return <span>x</span>
        }}
      </Loading>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project dom loading.test`
Expected: FAIL — `Loading`/`useLoading` not exported.

- [ ] **Step 3: Implement `src/dom/loading.ts`**

Create the file:

```ts
import { findLoadingScope, type LoadingScope, type Owner } from '../owner'
import { createSubOwner, getOwner, onCleanup, runWithOwner } from '../owner'
import { signal, type Accessor, type Setter } from '../signal'
import { effect } from '../effect'

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
  let hasEverLoaded = false
  effect(() => {
    if (!pending()) hasEverLoaded = true
  })

  return () => {
    if (!pending()) return loadedSubtree
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
}
```

Update `src/dom/index.ts` — add the new exports. The existing exports plus:

```ts
export { Loading, useLoading } from './loading'
```

Update `src/index.ts` — append `Loading` and `useLoading` to the dom re-export. Existing line:

```ts
export { For, Fragment, h, Match, render, Show, Switch, type Truthy } from './dom'
```

becomes:

```ts
export { For, Fragment, h, Loading, Match, render, Show, Switch, useLoading, type Truthy } from './dom'
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- --project dom loading.test`
Expected: PASS — all 12 cases.

If any test fails, investigate before patching. Most-likely failure modes and what they mean:
- "Pending stays at init even after settle" → effect's register is correctly incrementing but unregister isn't firing on the successful re-run. Check Task 2's effect.ts: the unregister should be inside the successful try-block path.
- "useLoading test returns wrong value" → owner-walk is starting from wrong owner. Verify Header() runs inside boundaryOwner (it does, because the children-thunk runs via runWithOwner).
- "Subsequent pending without fallback shows blank" → the accessor's branching is wrong. Should return `loadedSubtree` when `pending && !fallback && hasEverLoaded`.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/dom/loading.ts src/dom/index.ts src/index.ts test/dom/loading.test.tsx
git commit -m "feat(dom): Loading component + useLoading hook"
```

---

## Final verification

After Task 3:

- [ ] **Run all tests** — `pnpm test` — expected all green, with 12 new DOM tests + 3 new owner tests + 3 new effect tests added.
- [ ] **Run typecheck** — `pnpm typecheck` — expected clean.
- [ ] **Skim the public barrel** — `src/index.ts` now exports `Loading`, `useLoading` in addition to the previous symbols.
- [ ] **Dispatch the final whole-implementation review** if running under `superpowers:subagent-driven-development`.

## Out of scope reminders

These do not belong in Plan 4 — defer or surface as follow-ups:

- Cross-tree `useLoading()` from outside a Loading subtree (returns constant-false; ref-passing fallback if needed) — Plan 4 spec §1.
- Solid-style transitions / runtime entanglement — ADR 0007 documents the rejection.
- A standalone `loading()` utility — not part of v1 surface; `<Loading>` IS the primitive.
- `action`, `optimistic`, `resolve` helpers — Plan 5.
- Props-as-getters refactor — `docs/follow-ups.md` Architectural notes.

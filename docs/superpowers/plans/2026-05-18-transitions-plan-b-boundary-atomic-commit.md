# Transitions Plan B — Atomic-Commit Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `<Loading>` boundaries into an atomic-commit gather/flush mechanism so all bindings inside a boundary commit their DOM changes in the same flush — no partial-update windows during transitions. Make `use(accessor)` throw on pipeline-pending so SWR computeds actually participate in the boundary. Migrate the pokemon demo to demonstrate coherent transitions.

**Architecture:** `LoadingScope.register()` returns a per-binding *controller* with `report(state)` and `unregister()`. State is either `{ status: 'throwing' }` (pending), `{ status: 'ready', commit: () => void }` (recomputed, awaiting flush), or `{ status: 'idle' }` (no longer pending, nothing to flush). The scope keeps `pendingSet` and `readySet`; after every report it checks if `pendingSet.size === 0 && readySet.size > 0`, and if so, flushes all commits in one pass. Reactive bindings (`insertChild` reactive child, `bindProp` reactive branches) split into compute+commit phases and hand commit callbacks to the scope; plain `effect()` uses the API without a commit (its body already ran). Without a `<Loading>` ancestor, commits run immediately — no gather, identical to today.

**Tech Stack:** Same as Plan A — TypeScript, r3, Vitest. Builds on Plan A's external pending tracker (`isPending` / `promiseOf`).

---

## File Structure

- **Modify** `src/owner.ts` — change `LoadingScope.register` return type from a release function to a `BindingController` object.
- **Modify** `src/dom/loading.ts` — implement gather/flush state machine; expose pendingSet/readySet logic.
- **Modify** `src/dom/bindings.ts` — split reactive `insertChild` child and reactive `bindProp` branches (`prop:`/`attr:`/`class:`/`style:`/default) into compute+commit; hand commit to scope via report.
- **Modify** `src/effect.ts` — adopt the new controller API (`.report({ status: 'throwing' })` / `.report({ status: 'idle' })`); plain effects don't have a commit.
- **Modify** `src/async.ts` — change `use(accessor)` to throw `NotReadyYet(promiseOf(x)()!)` when `isPending(x)()` is true; remove the stale JSDoc note about brand-aware `read`.
- **Modify** `examples/pokemon/src/main.tsx` — wrap the page+list into a `<Loading>` so they commit atomically; remove the `class:loading={() => isPending(view)()}` band-aid (now redundant).
- **Modify** `test/dom/loading.test.tsx` — add atomic-commit tests, mid-flight mount test.
- **Create** `test/dom/loading-atomic.test.tsx` — new file for the gather/flush-specific tests (keeps existing loading test file focused on its current behavior).
- **Modify** `docs/follow-ups.md` — record Plan B landing.

---

## Task 1: Extend `LoadingScope` with a per-binding controller (replace register's return shape)

Today `scope.register()` returns a `() => void` release callback. We change it to return a controller with `report` and `unregister`. The boundary uses it to track which bindings are pending vs ready and flush atomically.

**Files:**
- Modify: `src/owner.ts` (the `LoadingScope` interface)
- Modify: `src/dom/loading.ts` (implement the new API + gather/flush)
- Create: `test/dom/loading-atomic.test.tsx` (synthetic-controller tests)

- [ ] **Step 1: Update the type in `src/owner.ts`**

Replace the `LoadingScope` interface:

```ts
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

/**
 * A per-binding controller obtained from `LoadingScope.register()`.
 * The binding reports state changes via `report` and detaches via `unregister`.
 */
export interface BindingController {
  report(state: BindingState): void
  unregister(): void
}

/**
 * Reactive pending-state handle attached to an `Owner` by `<Loading>`.
 * Inner binding-effects that catch `NotReadyYet` register and report state
 * changes; the boundary tracks pending and ready sets, flushing all ready
 * commits in one pass once nothing else is pending.
 */
export interface LoadingScope {
  /** `true` while at least one binding is pending OR has a deferred commit waiting. */
  readonly pending: Accessor<boolean>
  /** Obtain a controller for a new binding. Each binding registers ONCE lazily
   *  on its first `NotReadyYet`; the controller persists across re-runs. */
  register(): BindingController
}
```

- [ ] **Step 2: Write the failing test**

Create `test/dom/loading-atomic.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import { flush, microtaskScheduler, render, setScheduler, signal, syncScheduler } from '../../src/index'
import { Loading } from '../../src/dom/loading'
import { findLoadingScope, getOwner, runWithOwner } from '../../src/owner'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('scope gathers and flushes atomically: two throwing → both succeed → one flush', () => {
  const target = document.createElement('section')
  document.body.append(target)

  let scopeRef: ReturnType<typeof findLoadingScope> = null
  const commits: string[] = []

  const dispose = render(
    () => (
      <Loading>
        {() => {
          // Capture the boundary's scope from inside its owner subtree.
          scopeRef = findLoadingScope(getOwner())
          return <span>child</span>
        }}
      </Loading>
    ),
    target,
  )

  expect(scopeRef).not.toBeNull()
  const scope = scopeRef!

  const a = scope.register()
  const b = scope.register()
  a.report({ status: 'throwing' })
  b.report({ status: 'throwing' })

  expect(scope.pending()).toBe(true)
  expect(commits).toEqual([])

  // A becomes ready first — no flush yet (B still pending).
  a.report({ status: 'ready', commit: () => commits.push('A') })
  expect(scope.pending()).toBe(true)
  expect(commits).toEqual([])

  // B becomes ready — gate opens, both flush in one pass.
  b.report({ status: 'ready', commit: () => commits.push('B') })
  expect(commits).toEqual(['A', 'B'])
  expect(scope.pending()).toBe(false)

  dispose()
})

test('idle reports do not flush but contribute to pending while throwing', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let scopeRef: ReturnType<typeof findLoadingScope> = null
  const commits: string[] = []
  const dispose = render(
    () => (
      <Loading>
        {() => {
          scopeRef = findLoadingScope(getOwner())
          return <span>child</span>
        }}
      </Loading>
    ),
    target,
  )
  const scope = scopeRef!

  const a = scope.register() // a binding effect (no commit)
  const b = scope.register() // a reactive hole (commit)
  a.report({ status: 'throwing' })
  b.report({ status: 'throwing' })
  expect(scope.pending()).toBe(true)

  // a succeeds with 'idle' (its body already ran)
  a.report({ status: 'idle' })
  expect(scope.pending()).toBe(true) // b still throwing

  // b becomes ready — gate opens, only b's commit fires
  b.report({ status: 'ready', commit: () => commits.push('B') })
  expect(commits).toEqual(['B'])
  expect(scope.pending()).toBe(false)
  dispose()
})

test('unregister removes the binding from both sets', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let scopeRef: ReturnType<typeof findLoadingScope> = null
  const dispose = render(
    () => (
      <Loading>
        {() => {
          scopeRef = findLoadingScope(getOwner())
          return <span>child</span>
        }}
      </Loading>
    ),
    target,
  )
  const scope = scopeRef!

  const a = scope.register()
  const b = scope.register()
  a.report({ status: 'throwing' })
  b.report({ status: 'throwing' })
  expect(scope.pending()).toBe(true)
  a.unregister()
  expect(scope.pending()).toBe(true) // b still
  b.unregister()
  expect(scope.pending()).toBe(false)
  dispose()
})
```

Note: this test imports `findLoadingScope`, `getOwner`, `runWithOwner` directly from `'../../src/owner'` because they are not in the public barrel. Verify they are exported from `owner.ts` (`findLoadingScope` already is; `getOwner` and `runWithOwner` are too).

- [ ] **Step 3: Run test to verify failure**

Run: `pnpm exec vitest run test/dom/loading-atomic.test.tsx`
Expected: FAIL — type errors / no `.report` on scope.

- [ ] **Step 4: Implement gather/flush in `src/dom/loading.ts`**

Replace the `Loading` function body. The scope now constructs and returns controllers; pending counter is replaced by two `Set`s.

```ts
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

export function useLoading(): Accessor<boolean> {
  const scope = findLoadingScope(getOwner())
  return scope === null ? CONST_FALSE_ACCESSOR : scope.pending
}

export interface LoadingProps {
  children: () => unknown
  fallback?: unknown
  initial?: unknown
}

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

  const loadedSubtree: unknown = runWithOwner(boundaryOwner, props.children)

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
```

- [ ] **Step 5: Run the new tests + the existing loading suite to verify**

Run: `pnpm exec vitest run test/dom/loading-atomic.test.tsx test/dom/loading.test.tsx`
Expected:
- Atomic tests (3) pass.
- The existing `loading.test.tsx` will likely FAIL on tests that depend on the old `register()` returning a release callback — because we changed the signature. **This is expected**; effect.ts and bindings.ts still call the old shape. Task 2 onward fixes them. Note which tests fail; they should become green again by Task 4 at latest.

- [ ] **Step 6: Commit**

```bash
git add src/owner.ts src/dom/loading.ts test/dom/loading-atomic.test.tsx
git commit -m "feat(loading): per-binding controller + gather/flush state machine"
```

---

## Task 2: Adapt `src/effect.ts` to the new controller API

Plain `effect()` reports `throwing`/`idle` — no commit, just contributes to the gate.

**Files:**
- Modify: `src/effect.ts`

- [ ] **Step 1: Update the body**

Replace the `effect` function:

```ts
import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { NotReadyYet } from './async'
import {
  findLoadingScope,
  getOwner,
  routeError,
  registerWithOwner,
  type BindingController,
} from './owner'
import { signal } from './signal'

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs whenever a signal it read changes.
 *
 * If the body throws `NotReadyYet`, the effect suspends: registers with the
 * nearest `<Loading>` scope (reporting `'throwing'`), and re-runs when the
 * carried promise settles. On the next successful run it reports `'idle'`.
 * Plain effects do not provide a commit — their body's side effects already
 * happened on the successful pass, so there is nothing to defer for the
 * boundary's atomic flush. They only contribute to the boundary's pending
 * state while throwing.
 *
 * Any non-`NotReadyYet` throw routes to the nearest `catchError`.
 */
export function effect(fn: () => void): void {
  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let controller: BindingController | null = null

  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findLoadingScope(myOwner)
    if (scope === null) return null
    controller = scope.register()
    return controller
  }

  const body = () => {
    kick()
    try {
      fn()
      suspendedOn = null
      controller?.report({ status: 'idle' })
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
        ensureController()?.report({ status: 'throwing' })
        return
      }
      routeError(myOwner, e)
    }
  }

  const node = r3Computed(body)
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
    },
  })
}
```

- [ ] **Step 2: Run the loading suite**

Run: `pnpm exec vitest run test/dom/loading.test.tsx test/dom/loading-atomic.test.tsx`
Expected: more tests pass than after Task 1; insertChild-based tests still likely fail because `insertChild`'s reactive child still calls the old register/unregister pattern via `effect()`'s scope integration. Actually `insertChild` doesn't call `findLoadingScope` itself — it uses `effect()` which now uses the new API. So insertChild's gating should work — but commits will still run immediately because insertChild's body writes DOM directly. Plan continues in Task 3.

- [ ] **Step 3: Commit**

```bash
git add src/effect.ts
git commit -m "refactor(effect): adopt BindingController API; plain effects report throwing/idle"
```

---

## Task 2.5: Absorb `NotReadyYet` thrown by sync `computed` stage bodies as suspension

**Motivation.** Today a `computed` stage body that throws `NotReadyYet` (via `use(pendingPromise)` or — after Task 5 — `use(pendingAccessor)`) is routed as a *real error* by `makeStageNode`'s outer try/catch. Effects and JSX bindings already absorb `NotReadyYet` as a suspension signal. This task closes the asymmetry: a sync (or async-function) computed stage that throws `NotReadyYet` is treated identically to a stage that returned a pending Promise — `suspendedOn` set to `e.promise`, `pendingSig` flipped, settle handler installed, body re-runs on settle. Generator stages already use `yield*` for suspension and are unaffected.

**Files:**
- Modify: `src/computed.ts`
- Modify: `test/computed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/computed.test.ts`:

```ts
describe('computed — NotReadyYet absorbed as suspension (Plan B)', () => {
  test('sync stage body throwing NotReadyYet suspends, then resumes on settle', async () => {
    let resolve!: (v: number) => void
    const p = new Promise<number>((r) => (resolve = r))
    const c = computed(() => use(p) + 1)
    // First read: stage body throws NotReadyYet → absorbed as suspension.
    // The accessor's published value on first load is the in-flight Promise.
    const first = c()
    expect(first).toBe(p)
    expect(isPending(c)()).toBe(true)
    resolve(41)
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe(42)
    expect(isPending(c)()).toBe(false)
  })

  test('two-stage pipeline: stage 0 throws NotReadyYet; downstream stage sees the suspension', async () => {
    let resolve!: (v: number) => void
    const p = new Promise<number>((r) => (resolve = r))
    const stage0 = computed(() => use(p))
    const stage1 = computed(stage0, (v) => v * 2)
    expect(isPending(stage1)()).toBe(true)
    resolve(7)
    await new Promise((r) => queueMicrotask(r))
    expect(stage1()).toBe(14)
  })

  test('SWR-refetch: stage body throwing NotReadyYet during refetch keeps prior value visible', async () => {
    const [src, setSrc] = signal(1)
    let activeResolve: (v: number) => void = () => {}
    const c = computed(() => {
      src()
      const p = new Promise<number>((r) => (activeResolve = r))
      return use(p)
    })
    c() // kick first eval
    await new Promise((r) => queueMicrotask(r))
    activeResolve(10)
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe(10)
    setSrc(2)
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe(10) // SWR-stale
    expect(isPending(c)()).toBe(true)
    activeResolve(20)
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe(20)
  })
})
```

Required imports at top of `test/computed.test.ts` if not already present: `use` from `'../src/async'`, `signal` from `'../src/signal'`, `isPending` from `'../src/pending'`.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm exec vitest run test/computed.test.ts -t "NotReadyYet absorbed"`
Expected: FAIL — current code routes `NotReadyYet` as an error (likely unhandled or surfacing as a routed throw).

- [ ] **Step 3: Update `src/computed.ts` to absorb `NotReadyYet`**

Inside `makeStageNode`, locate the outer `try { ... } catch (e) { ... routeError(myOwner, e) ... }` block that wraps the `runStage` call (around the existing `depTracker` body). Currently the catch unconditionally routes:

```ts
    } catch (e) {
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        deferredError = { error: rethrown }
      }
      return null
    }
```

Insert a `NotReadyYet` branch BEFORE the routeError call:

```ts
    } catch (e) {
      if (e instanceof NotReadyYet) {
        // Sync/async-function stage body called `use(pending)` and threw the
        // suspension signal. Treat identically to a stage that returned a
        // pending Promise: set up the same suspendOn + settle machinery.
        // Generator stages route suspension via their driver and never reach
        // this catch with a NotReadyYet.
        suspendOn(e.promise, /* input */ undefined, (state) => {
          if (state.status === 'fulfilled') {
            suspendedOn = null
            setPendingSig(false)
            // Re-run body via kick (resolved-value cache is meaningless here
            // because the throw means body never returned — re-execute fully).
            setKick(++kickCount)
          } else {
            suspendedOn = null
            setPendingSig(false)
            deferredError = { error: state.reason }
            setKick(++kickCount)
          }
        })
        return null
      }
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        deferredError = { error: rethrown }
      }
      return null
    }
```

Add `NotReadyYet` to the imports at the top of `src/computed.ts`:

```ts
import { isGeneratorFunction, NotReadyYet, track, type PromiseState, type Resolved } from './async'
```

**Subtlety — input parameter.** `suspendOn(promise, input, onSettle)`'s `input` argument is used by the existing `stashedResolution`/`Object.is(input, suspendedInput)` reuse-value path in the depTracker body. For a NotReadyYet throw, the stage didn't return a value to stash, so we pass `input = undefined` and the resume strategy is "re-run body" (via kick), not "consume stash." Verify the existing reuse-value path's `input` check still behaves: when the next body run reads its real input and produces a fresh value, that's fine — no stash to match.

**Subtlety — generator stages.** Generator stages produce suspension via the driver (`runStage` returns `{pending: true, promise}`), not via throw. So this NotReadyYet branch fires only for sync and async-function stages. Add an assertion (dev-only) is overkill; the existing code structure makes this naturally so.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run`
Expected: PASS — the three new tests pass; existing computed tests still pass; full suite green.

If any pre-existing test FAILS, investigate carefully: a test that asserted "computed stage throwing NotReadyYet propagates as an error" is now wrong (the spec change inverts that). Update or delete such tests with a brief note in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/computed.ts test/computed.test.ts
git commit -m "feat(computed)!: absorb NotReadyYet thrown by sync stage body as suspension"
```

---

## Task 3: Split `insertChild` reactive child into compute + commit (with scope.report)

The `insertChild` reactive child currently does `compute then commit` inside the same try block. Split so commit becomes a callback handed to the scope.

**Files:**
- Modify: `src/dom/bindings.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/dom/loading-atomic.test.tsx`:

```tsx
import { use } from '../../src/async'

test('two reactive children inside <Loading> commit atomically when their promises settle at different ticks', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let resolveA: (v: string) => void = () => {}
  let resolveB: (v: string) => void = () => {}
  const pA = new Promise<string>((r) => (resolveA = r))
  const pB = new Promise<string>((r) => (resolveB = r))

  const dispose = render(
    () => (
      <Loading fallback={<p>loading</p>}>
        {() => (
          <div>
            <span class="a">{() => use(pA)}</span>
            <span class="b">{() => use(pB)}</span>
          </div>
        )}
      </Loading>
    ),
    target,
  )

  expect(target.textContent).toBe('loading')

  // Resolve A first; B still pending. With atomic-commit, the DOM must NOT
  // show A's value yet.
  resolveA('A!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.textContent).toBe('loading') // boundary still pending

  // Resolve B; gate opens — both commit in the same tick.
  resolveB('B!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.a')!.textContent).toBe('A!')
  expect(target.querySelector('.b')!.textContent).toBe('B!')
  dispose()
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm exec vitest run test/dom/loading-atomic.test.tsx -t "commit atomically"`
Expected: FAIL — after resolveA, the .a span commits "A!" before resolveB; the assertion that the DOM still shows "loading" fails because at minimum the parent `<div>` got rendered with one populated child and one stale marker pair.

(If the test passes for unrelated reasons — e.g., the boundary's fallback rendering happens to hide everything — strengthen by removing `fallback` so the boundary holds the prior tree; assert each span's `textContent === ''` after resolveA.)

- [ ] **Step 3: Refactor `insertChild`**

In `src/dom/bindings.ts`, replace the `typeof value === 'function'` branch of `insertChild`:

```ts
import { effect } from '../effect'
import {
  createSubOwner,
  disposeOwner,
  findLoadingScope,
  getOwner,
  onCleanup,
  runWithOwner,
  type BindingController,
  type Owner,
} from '../owner'
import { NotReadyYet } from '../async'

// ...

export function insertChild(parent: Node, value: unknown): void {
  if (typeof value === 'function') {
    warnIfOrphaned('reactive child')
    const parentOwner = getOwner()
    const start = document.createComment('')
    const end = document.createComment('')
    parent.appendChild(start)
    parent.appendChild(end)
    let runOwner: Owner | null = null
    let controller: BindingController | null = null
    const ensureController = (): BindingController | null => {
      if (controller !== null) return controller
      const scope = findLoadingScope(parentOwner)
      if (scope === null) return null
      controller = scope.register()
      return controller
    }
    effect(() => {
      // Build the fragment FIRST inside a fresh sub-owner so any nested
      // binding-effects/computeds the user creates are bound to this run.
      const nextRunOwner = createSubOwner(parentOwner)
      let frag: DocumentFragment | null = null
      try {
        runWithOwner(nextRunOwner, () => {
          const next = (value as () => unknown)()
          frag = document.createDocumentFragment()
          insertChild(frag, next)
        })
      } catch (e) {
        // Sub-owner from the failed run is orphaned — dispose to clean up
        // any partial nested registrations.
        disposeOwner(nextRunOwner)
        if (e instanceof NotReadyYet) {
          ensureController()?.report({ status: 'throwing' })
          throw e // let the outer effect's own NotReadyYet handler run (kick on settle)
        }
        throw e
      }
      // Successful compute. Build the commit. If there's a scope, defer;
      // otherwise commit immediately (preserves no-Loading behavior).
      const oldRunOwner = runOwner
      const commit = () => {
        // Dispose the previous run's owner; install the new one.
        if (oldRunOwner !== null) disposeOwner(oldRunOwner)
        runOwner = nextRunOwner
        // Clear DOM between markers and insert the fragment.
        let cur = start.nextSibling
        while (cur !== null && cur !== end) {
          const after: ChildNode | null = cur.nextSibling
          cur.remove()
          cur = after
        }
        end.parentNode!.insertBefore(frag!, end)
      }
      const ctrl = ensureController()
      if (ctrl !== null) {
        ctrl.report({ status: 'ready', commit })
      } else {
        commit()
      }
    })
    return
  }
  // (rest of insertChild unchanged)
  if (value === null || value === undefined || typeof value === 'boolean') return
  // ...
}
```

Two important details:
- The outer `effect()` already has `NotReadyYet` handling (re-throws are caught by `effect()`'s try block, which registers with the scope and schedules a kick). The inner `try { runWithOwner(...) } catch (e) { ... throw e }` *also* reports `throwing` to our scope before re-throwing. The effect's outer try sees the NotReadyYet, reports its OWN scope state — but it's the SAME scope, with the SAME controller? **No** — the effect creates its own controller via its own `ensureController`. We'd be double-reporting.

  **Fix:** in this code path, when `insertChild` reactive child manages its OWN controller, the outer `effect()` should NOT also register. The cleanest way is to have insertChild's effect not throw NotReadyYet upward; instead, swallow it after reporting. Refactor:

```ts
    effect(() => {
      const nextRunOwner = createSubOwner(parentOwner)
      let frag: DocumentFragment | null = null
      try {
        runWithOwner(nextRunOwner, () => {
          const next = (value as () => unknown)()
          frag = document.createDocumentFragment()
          insertChild(frag, next)
        })
      } catch (e) {
        disposeOwner(nextRunOwner)
        if (e instanceof NotReadyYet) {
          ensureController()?.report({ status: 'throwing' })
          // Re-throw so the OUTER effect() handles re-run-on-settle.
          // The outer effect's controller registration becomes redundant
          // with ours — we accept the small duplication; both controllers
          // report 'throwing' to the same scope, and both will report
          // 'idle'/'ready' on success. The scope's Set semantics dedupe
          // per-controller, so two reports just mean two controllers in
          // pendingSet — the gate still opens correctly when BOTH report
          // non-throwing. NOTE: this is slightly wasteful; future cleanup
          // could let insertChild own a custom effect-like primitive that
          // bypasses the outer scope registration.
          throw e
        }
        throw e
      }
      const oldRunOwner = runOwner
      const commit = () => {
        if (oldRunOwner !== null) disposeOwner(oldRunOwner)
        runOwner = nextRunOwner
        let cur = start.nextSibling
        while (cur !== null && cur !== end) {
          const after: ChildNode | null = cur.nextSibling
          cur.remove()
          cur = after
        }
        end.parentNode!.insertBefore(frag!, end)
      }
      const ctrl = ensureController()
      if (ctrl !== null) {
        ctrl.report({ status: 'ready', commit })
      } else {
        commit()
      }
    })
```

  The "two controllers in pendingSet" comment captures the small inefficiency — accept it for v1, follow-up as needed.

- [ ] **Step 4: Run all tests**

Run: `pnpm exec vitest run`
Expected: the atomic-commit test passes; existing loading tests still pass (the "hold prior tree" behavior is preserved because commits don't fire until gate opens, and `<Loading>`'s return-accessor still returns the prior `loadedSubtree` while pending).

If a specific test fails due to the double-controller redundancy (e.g., a test counting pendingCount), investigate; the gate-open logic should still work, just with one extra entry in `pendingSet`.

- [ ] **Step 5: Commit**

```bash
git add src/dom/bindings.ts
git commit -m "feat(insertChild): split compute/commit; report ready to scope for atomic flush"
```

---

## Task 4: Split `bindProp` reactive branches similarly

The same compute/commit split applies to `prop:`, `attr:`, `class:`, `style:`, and the default attribute branch. Each currently calls `effect(() => apply(fnValue()))` — apply IS the commit; we just hand it to the scope.

**Files:**
- Modify: `src/dom/bindings.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/dom/loading-atomic.test.tsx`:

```tsx
test('reactive attr commit defers under <Loading> until gate opens', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let resolve: (v: string) => void = () => {}
  const p = new Promise<string>((r) => (resolve = r))
  const q = new Promise<string>(() => {})  // never settles

  const dispose = render(
    () => (
      <Loading>
        {() => (
          <div
            class:active={() => {
              use(p)
              return true
            }}
          >
            child
            {/* sibling pending hole keeps the gate closed forever; we test
                the commit deferral by resolving p, then unmounting before
                gate opens. */}
            <span>{() => use(q)}</span>
          </div>
        )}
      </Loading>
    ),
    target,
  )

  resolve('done')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  const div = target.querySelector('div')!
  // class:active commit was deferred because q never resolves.
  expect(div.classList.contains('active')).toBe(false)
  dispose()
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm exec vitest run test/dom/loading-atomic.test.tsx -t "reactive attr commit defers"`
Expected: FAIL — currently `class:active` applies immediately when p resolves.

- [ ] **Step 3: Refactor `bindProp` reactive branches**

In `src/dom/bindings.ts`, factor out the compute/commit split into a helper since the same pattern repeats for each reactive branch. Add near the top of the file:

```ts
import {
  findLoadingScope,
  // ...other existing imports
  type BindingController,
} from '../owner'

/**
 * Wrap a reactive `apply(value)` binding in the compute/commit split. The
 * effect body evaluates `read()` (which may throw NotReadyYet), then either
 * commits via `apply(value)` immediately (no Loading scope) or defers via
 * `scope.report({status: 'ready', commit})`. On throw, reports 'throwing'
 * and re-throws so the effect's outer machinery re-runs on settle.
 */
function reactiveCommit<T>(
  parentOwner: Owner | null,
  read: () => T,
  apply: (value: T) => void,
): void {
  let controller: BindingController | null = null
  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findLoadingScope(parentOwner)
    if (scope === null) return null
    controller = scope.register()
    return controller
  }
  onCleanup(() => {
    controller?.unregister()
    controller = null
  })
  effect(() => {
    let value: T
    try {
      value = read()
    } catch (e) {
      if (e instanceof NotReadyYet) {
        ensureController()?.report({ status: 'throwing' })
        throw e
      }
      throw e
    }
    const commit = () => apply(value)
    const ctrl = ensureController()
    if (ctrl !== null) ctrl.report({ status: 'ready', commit })
    else commit()
  })
}
```

(`onCleanup` import must be present at top.)

Then update each reactive branch in `bindProp` to use it. Example for the default attr branch:

```ts
  if (typeof value === 'function') {
    warnIfOrphaned('attr binding')
    const parentOwner = getOwner()
    reactiveCommit(parentOwner, value as () => unknown, (v) => applyAttr(el, name, v))
    return
  }
```

Apply the same shape to: `prop:`, `attr:`, `class:`, `style:`, default. Each currently has `effect(() => apply((value as () => unknown)()))` — replace with `reactiveCommit(parentOwner, value as () => unknown, applyFn)` where `applyFn` is the existing per-branch apply call.

- [ ] **Step 4: Run all tests**

Run: `pnpm exec vitest run`
Expected: PASS for new test; PASS for all existing binding/Loading tests.

- [ ] **Step 5: Commit**

```bash
git add src/dom/bindings.ts
git commit -m "feat(bindProp): defer reactive prop/attr/class/style commits under <Loading>"
```

---

## Task 5: Change `use(accessor)` to throw on `isPending(x)()`

The whole atomic-commit mechanism only engages when bindings *throw*. Today `use(view)` where `view` is an SWR computed (Plan A) returns the stale value silently. Make `use` throw when the accessor is pipeline-pending.

**Files:**
- Modify: `src/async.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/async.test.ts` (in a new describe block near the end):

```ts
import { computed } from '../src/computed'
import { isPending, promiseOf } from '../src/pending'

describe('use(accessor) — Plan B: throws on isPending', () => {
  test('use(swrComputed) throws NotReadyYet during refetch, even though accessor returns stale', async () => {
    const [page, setPage] = signal(1)
    let activeResolve: (v: string) => void = () => {}
    const c = computed(() => {
      page()
      return new Promise<string>((r) => (activeResolve = r))
    })
    // Prime first load
    c()
    await new Promise((r) => queueMicrotask(r))
    activeResolve('v1')
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe('v1')

    // Trigger refetch.
    setPage(2)
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe('v1') // SWR-stale

    // BUT use(c) must throw NotReadyYet now, carrying the in-flight promise.
    expect(isPending(c)()).toBe(true)
    let threw: unknown = null
    try {
      use(c)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(NotReadyYet)
    expect((threw as NotReadyYet).promise).toBe(promiseOf(c)())
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm exec vitest run test/async.test.ts -t "Plan B"`
Expected: FAIL — current `use(c)` returns 'v1' (no throw).

- [ ] **Step 3: Update `use` in `src/async.ts`**

Replace the `use` function:

```ts
import { isPending, promiseOf } from './pending'

/**
 * Resolve a possibly-async value synchronously.
 * - Accessor argument: if `isPending(x)()` is true (this stage OR any
 *   upstream stage is in-flight), throws `NotReadyYet(promiseOf(x)()!)` so
 *   the surrounding effect/binding can suspend. Otherwise returns the
 *   accessor's current value (possibly a Promise — handled by the next
 *   branches just like a plain Promise argument).
 * - Plain value -> returned as-is.
 * - Settled promise -> its resolved value (a settled rejection re-throws).
 * - Pending promise -> throws `NotReadyYet`.
 *
 * Intended for use inside effects and JSX bindings. After Plan B, `use(x)`
 * always throws on pipeline-pending — coherent multi-read snapshots inside
 * a `<Loading>` boundary fall out of the boundary's atomic-commit gather.
 */
export function use<T>(x: T | Promise<T> | (() => T | Promise<T>)): Awaited<T> {
  if (typeof x === 'function') {
    const accessor = x as () => T | Promise<T>
    if (isPending(accessor)()) {
      throw new NotReadyYet(promiseOf(accessor)()!)
    }
    x = accessor()
  }
  if (!isPromise(x)) return x as Awaited<T>
  const state = track(x)
  if (state.status === 'fulfilled') return state.value as Awaited<T>
  if (state.status === 'rejected') throw state.reason
  throw new NotReadyYet(x)
}
```

Also remove the stale JSDoc paragraph in `read`'s docstring that says "`read` is brand-aware" — it was already false after Plan A; this is cleanup. Find around lines 75–77 of `async.ts`:

```ts
 * snapshots inside a generator computed, use `yield* read(accessor)` instead
 * — `read` is brand-aware and suspends via the driver, preserving SWR-at-leaf
 * for non-generator callers of `use`.
```

Replace with:

```ts
 * snapshots across a transition are handled at the `<Loading>` boundary;
 * inside a generator computed, `yield* read(accessor)` is a plain yielding
 * helper (Plan A) and does not itself suspend on pipeline-pending.
```

- [ ] **Step 4: Run full suite**

Run: `pnpm exec vitest run`
Expected: PASS — the new test passes, and existing tests still pass.

**Watch for:** any existing test that calls `use(SWR-stale-accessor)` expecting the stale value to come back. Such tests now expect a throw. If the failing tests are reasonable (e.g., a "use returns stale" test that was capturing the old behavior), update them to expect a throw or migrate them to `latest(x)` for the "give me stale" semantics. List any such fixes in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/async.ts test/async.test.ts
git commit -m "feat(use)!: throw NotReadyYet on isPending accessor; bindings now gate via <Loading>"
```

---

## Task 6: Migrate the pokemon demo to `<Loading>`-based coherent transitions

**Files:**
- Modify: `examples/pokemon/src/main.tsx`

- [ ] **Step 1: Inspect current state**

Read `examples/pokemon/src/main.tsx`. Identify:
- The view/snapshot computed (or generator computed) introduced by Plan 7 / Plan A.
- The `class:loading={() => isPending(view)()}` band-aid.
- The page label + list bindings.

- [ ] **Step 2: Refactor**

Goal shape (sketch — adapt to actual filenames/variable names):

```tsx
<Loading fallback={<p>Loading…</p>}>
  {() => (
    <div>
      <span>page {() => use(page) + 1}</span>
      <For each={() => use(list)}>
        {(p) => <li>{p.name}</li>}
      </For>
    </div>
  )}
</Loading>
```

Drop the `view` generator computed if it exists (its job is done by the boundary now). Drop the `class:loading={...}` band-aid — `use(list)` throws while pending, the boundary holds the prior tree, no flicker.

Keep an outer "refreshing" indicator if desired:

```tsx
<Show when={() => useLoading()()}>
  <span class="refresh-dot" />
</Show>
```

(inside the boundary subtree — `useLoading()` reads the nearest enclosing scope's `pending` accessor; `()` invokes the returned accessor).

- [ ] **Step 3: Manually verify**

Run the example (the user can use `pnpm dev` or similar from `examples/pokemon`). Click through pages. Verify:
- Page label and list update in the same frame.
- No mid-flight "{page: 2, items: oldItems}" frame.
- Loading fallback only appears on the first load.

Document the verification in the commit message.

- [ ] **Step 4: Commit**

```bash
git add examples/pokemon/src/main.tsx
git commit -m "refactor(examples/pokemon): coherent transitions via <Loading> boundary"
```

---

## Task 7: Add mid-flight mount test (option A semantics)

Verify that a binding which mounts *after* the boundary entered `collecting` joins the gather.

**Files:**
- Modify: `test/dom/loading-atomic.test.tsx`

- [ ] **Step 1: Write the test**

Append:

```tsx
import { Show } from '../../src/dom'

test('newly-mounted binding inside <Loading> joins the gather (option A: hold prior tree)', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [visible, setVisible] = signal(false)
  let resolveA: (v: string) => void = () => {}
  let resolveB: (v: string) => void = () => {}
  const pA = new Promise<string>((r) => (resolveA = r))
  const pB = new Promise<string>((r) => (resolveB = r))

  const dispose = render(
    () => (
      <Loading fallback={<p>loading</p>}>
        {() => (
          <div>
            <span class="a">{() => use(pA)}</span>
            <Show when={visible}>
              <span class="b">{() => use(pB)}</span>
            </Show>
          </div>
        )}
      </Loading>
    ),
    target,
  )

  // First load: A pending; B not mounted. Boundary fallback shows.
  expect(target.textContent).toBe('loading')

  // Resolve A while B is not mounted — gate opens immediately; A commits.
  resolveA('A!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.a')!.textContent).toBe('A!')
  expect(target.querySelector('.b')).toBeNull()

  // Now toggle B on AND it throws (pB still pending). The new binding joins
  // the gather and the boundary returns to pending. Per option A, the prior
  // tree is held; mid-flight mount does not appear yet.
  setVisible(true)
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  // Boundary's return-accessor: pending && hasEverLoaded → fallback ?? loadedSubtree.
  // With a fallback set, prior tree is replaced by fallback. (To assert
  // "prior tree retained," omit the fallback in a separate test.)
  expect(target.textContent).toBe('loading')

  // Resolve B; gate opens — B commits; A unchanged.
  resolveB('B!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.a')!.textContent).toBe('A!')
  expect(target.querySelector('.b')!.textContent).toBe('B!')
  dispose()
})

test('mid-flight mount without fallback: prior tree retained until gate opens', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [visible, setVisible] = signal(false)
  let resolveA: (v: string) => void = () => {}
  let resolveB: (v: string) => void = () => {}
  const pA = new Promise<string>((r) => (resolveA = r))
  const pB = new Promise<string>((r) => (resolveB = r))
  const dispose = render(
    () => (
      <Loading>
        {() => (
          <div>
            <span class="a">{() => use(pA)}</span>
            <Show when={visible}>
              <span class="b">{() => use(pB)}</span>
            </Show>
          </div>
        )}
      </Loading>
    ),
    target,
  )
  resolveA('A!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.a')!.textContent).toBe('A!')
  setVisible(true)
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  // No fallback: hold prior tree. Mid-flight mount stays invisible until
  // gate opens.
  expect(target.querySelector('.b')).toBeNull()
  resolveB('B!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  expect(target.querySelector('.b')!.textContent).toBe('B!')
  dispose()
})
```

- [ ] **Step 2: Run**

Run: `pnpm exec vitest run test/dom/loading-atomic.test.tsx`
Expected: both new tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/dom/loading-atomic.test.tsx
git commit -m "test(loading): mid-flight mount joins gather (option A)"
```

---

## Task 8: Update `docs/follow-ups.md`

**Files:**
- Modify: `docs/follow-ups.md`

- [ ] **Step 1: Append to "Already addressed"**

After the Plan A entry, add:

```markdown
- ~~Transitions Plan B (atomic-commit boundary): `<Loading>` gathers and flushes contributing bindings atomically via a `BindingController` API; `use(accessor)` throws `NotReadyYet` on pipeline-pending so SWR computeds participate; reactive `insertChild` and `bindProp` branches split into compute+commit; pokemon demo migrated.~~ Landed in commits `<T1>`–`<T8>` (substitute actual SHAs). See `docs/superpowers/specs/2026-05-17-pulse-transitions-redesign.md`. Known follow-up: insertChild's reactive-child path double-registers (its own controller + the outer `effect()`'s) — both report `throwing`/`idle` to the same scope; gate logic stays correct but adds one entry to `pendingSet` per such binding. Acceptable for v1; consider introducing a `bindingEffect()` primitive that skips the outer `findLoadingScope` registration.
```

- [ ] **Step 2: Add an open follow-up for the double-registration**

In the "Open" section under "Architectural notes":

```markdown
- **(later) `insertChild`/`bindProp` double-register with `<Loading>` scope.** Plan B's `insertChild` reactive child and `bindProp` reactive branches each register their own `BindingController` with the nearest `<Loading>` scope to report `throwing`/`ready`. The underlying `effect()` (used to drive the reactive re-run) ALSO calls `findLoadingScope` and registers its own controller on `NotReadyYet`. Both controllers report the same lifecycle; the boundary's `pendingSet` semantics dedupe per-controller (so the gate still opens correctly), but each affected binding leaves two entries in the set while throwing. Cleanup: extract a `bindingEffect()` primitive that drives reactive re-runs without owning a scope controller — leaving scope coordination to the caller (insertChild, bindProp). Source: Plan B design.
```

- [ ] **Step 3: Commit**

```bash
git add docs/follow-ups.md
git commit -m "docs(follow-ups): record Plan B landing + double-register follow-up"
```

---

## Verification (post-implementation)

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```

Expected:
- Typecheck clean.
- All tests pass — including the new atomic-commit, mid-flight-mount, and `use`-throws-on-pending tests.
- Pokemon demo loads and exhibits coherent transitions (manual check).

Spot-check for unintended behavior changes:
- `useLoading()()` outside a `<Loading>` returns `false` (unchanged).
- Plain `effect()` outside a `<Loading>` still suspends correctly (its scope lookup returns null; reports are no-ops via the null check).
- Reactive bindings outside `<Loading>` commit synchronously (no scope → immediate commit).

---

## Out of scope

- **Effects with deferred commit semantics.** Plain `effect()` body runs side effects directly; we do not split user bodies. A user who wants gated effects can wrap with `useLoading()` checks.
- **`isPendingLocal` / `promiseOfLocal`.** Plan A flagged these as deferred; still deferred.
- **Swappable `setPendingTracker`.** Deferred.
- **Compile-time JSX sugar** (`await*`, generator JSX bindings). Separate scope.
- **Eliminating the `insertChild`/`bindProp` double-registration with `effect()`'s scope integration.** Tracked as a follow-up; acceptable for v1.

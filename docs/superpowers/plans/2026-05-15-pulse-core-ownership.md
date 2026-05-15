# pulse/core — Ownership & `createRoot` (Plan 2c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Solid-style ownership/lifecycle layer so reactive nodes (effects, computeds) created in a scope can be cleaned up together. Unblocks error boundaries (Plan 2d) and DOM-layer component cleanup (Plan 3).

**Architecture:** A new `Owner` is a tiny module-private record (`children`, `cleanups`, `disposed`). `createRoot((dispose) => T): T` creates a fresh root owner, runs the callback with it as ambient, returns the callback's return value. `getOwner()` / `runWithOwner` provide read/override. Reactive nodes (`effect`, `computed`) register themselves with the current owner on creation; the owner's `dispose()` walks its children, runs each one's disposer (which calls `r3.unwatched(node)` to detach from r3's graph), then runs the owner's own `onCleanup` callbacks. `onCleanup` becomes owner-aware: inside an r3 context it routes to r3 (existing behavior); inside a `createRoot` callback (but not inside a computed/effect body), it routes to the ambient owner. r3's only change is exporting `unwatched` (one-keyword diff — see ADR 0005).

**Tech Stack:** TypeScript (strict), Vitest, r3. Builds on Plan 1 (sync foundation), Plan 2a (promise-holding signals + `use`/effect suspension), Plan 2b (generator/async pipeline stages).

**Scope notes — what this plan deliberately does NOT do:**
- **Error boundaries** (Plan 2d) — they will be built on top of ownership next.
- **DOM layer** (Plan 3) — uses ownership for component lifecycle.
- **`createRoot` parenting.** This plan matches Solid's semantics: `createRoot` always creates a *root*. Nested `createRoot` calls produce independent owners (the inner is NOT parented to the outer's ambient owner). This is deliberate — `createRoot` is the "opt out of parent disposal" primitive. A parented-by-default owner constructor can be added later if needed.
- **Warnings for unowned reactive nodes.** Outside any root, `effect(...)` / `computed(...)` still work as today (the node lives forever / until GC). A "warn on unowned effect" mode is a follow-up.
- **Per-owner Context** (`useContext`-style scoped values). Solid's `Owner` carries contexts; pulse's first cut does not. Easy to add later if Plan 3 needs it.

---

## File structure

| File | Responsibility | This plan |
|------|----------------|-----------|
| `../r3/src/index.ts` | export `unwatched` (one keyword) | **Modify** (Task 1) |
| `src/owner.ts` | `Owner` type, `createRoot`, `getOwner`, `runWithOwner`, internal `registerWithOwner` + `disposeOwner`; owner-aware `onCleanup` | **Create** (Task 2) |
| `src/effect.ts` | Register the effect's r3 node with the current owner | **Modify** (Task 3) |
| `src/computed.ts` | Register each pulse computed's r3 nodes with the current owner | **Modify** (Task 3) |
| `src/index.ts` | Public exports: `createRoot`, `getOwner`, `runWithOwner`, type `Owner`. Replace the `onCleanup` re-export from `./effect` with the owner-aware version from `./owner` | **Modify** (Task 4) |
| `test/owner.test.ts` | Owner mechanics — createRoot, dispose, runWithOwner, nesting, use-after-dispose, onCleanup routing | **Create** (Task 2) |
| `test/effect.test.ts` | Append: effect is disposed when its owning root is disposed | **Modify** (Task 3) |
| `test/computed.test.ts` | Append: computed is disposed when its owning root is disposed | **Modify** (Task 3) |
| `test/integration-ownership.test.ts` | End-to-end: a root containing signals, computeds, effects; dispose cleans everything | **Create** (Task 4) |

---

## Task 1: r3 exports `unwatched`

**Files:**
- Modify: `../r3/src/index.ts` (one keyword)

**This task touches a sibling repository.** Per ADR 0005, r3 will expose its existing internal `unwatched` function — a single-keyword change. The implementer navigates to `../r3` and makes the edit there; r3's tests must still pass.

- [ ] **Step 1: Navigate to r3 and verify its tests pass before the change**

Run: `cd /Users/bigmistqke/Documents/GitHub/r3 && pnpm test 2>&1 | tail -5`
Expected: r3's tests all pass. (You may need to `pnpm install` first if it has not been done in r3 yet.)

- [ ] **Step 2: Edit `/Users/bigmistqke/Documents/GitHub/r3/src/index.ts`**

Find the line that currently reads:

```ts
function unwatched(el: Computed<unknown>) {
```

Change it to:

```ts
export function unwatched(el: Computed<unknown>) {
```

Everything else in `unwatched`'s body and the rest of the file stays exactly as-is. Optionally, add a JSDoc above the function:

```ts
/**
 * Detach a computed from the graph: remove from the dirty heap, unlink from
 * all of its dependencies (cascading their cleanup if they lose their last
 * sub), and run its registered `onCleanup` callbacks. Fires automatically
 * when a computed loses its last sub; framework authors may call it directly
 * to dispose leaf nodes (e.g. effects) that have no subs.
 *
 * **Framework-author API.** Application code should not need this — r3's
 * automatic disposal handles the common case. Callers must ensure the node
 * has no live downstream subs at the time of the call (otherwise those subs
 * are left with dangling `deps` pointing at a non-recomputing node).
 */
export function unwatched(el: Computed<unknown>) {
```

(The JSDoc is optional but recommended — the function is small and its caveats are real.)

- [ ] **Step 3: Verify r3's tests still pass**

Run: `cd /Users/bigmistqke/Documents/GitHub/r3 && pnpm test 2>&1 | tail -5`
Expected: all r3 tests still pass — no semantic change, just a visibility increase.

- [ ] **Step 4: Commit in r3**

Run:

```bash
cd /Users/bigmistqke/Documents/GitHub/r3
git add -A
git commit -m "feat: export unwatched for framework-author disposal"
```

NO `Co-Authored-By` line. NO AI signature.

- [ ] **Step 5: Return to pulse and run typecheck**

Run:

```bash
cd /Users/bigmistqke/Documents/GitHub/pulse
pnpm typecheck && pnpm test
```

Expected: pulse's typecheck and tests still pass — Task 1 makes a *visibility* change in r3 only, so pulse should be unaffected. (Task 2 will be the first task that actually imports `unwatched`; it will fail loudly there if the export went wrong.)

This task makes no pulse-side commit — r3's commit stands alone in r3's history. Proceed to Task 2.

---

## Task 2: The owner module

**Files:**
- Create: `src/owner.ts`
- Test: `test/owner.test.ts`

Adds the Owner type, the ownership API (`createRoot`, `getOwner`, `runWithOwner`), an internal `registerWithOwner` for reactive primitives to call, and an owner-aware `onCleanup` that routes correctly inside/outside r3 contexts.

Follow TDD.

### Step 1: Write the failing tests — create `test/owner.test.ts`

```ts
import { afterEach, expect, test } from 'vitest'
import { createRoot, getOwner, onCleanup, runWithOwner } from '../src/owner'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { setSignal, signal } from '../src/signal'

afterEach(() => setScheduler(microtaskScheduler(flush)))

test('createRoot returns the callback return value', () => {
  const result = createRoot(() => 'hello')
  expect(result).toBe('hello')
})

test('getOwner is null outside any root', () => {
  expect(getOwner()).toBeNull()
})

test('getOwner returns the current owner inside createRoot', () => {
  createRoot(() => {
    expect(getOwner()).not.toBeNull()
  })
})

test('createRoot disposes its onCleanup callbacks', () => {
  const log: string[] = []
  createRoot((dispose) => {
    onCleanup(() => log.push('a'))
    onCleanup(() => log.push('b'))
    dispose()
  })
  // Bottom-up: cleanups run in LIFO order ('b' before 'a').
  expect(log).toEqual(['b', 'a'])
})

test('createRoot is always a root — nested createRoot is independent', () => {
  let innerDispose: () => void
  let innerCleanupRan = false
  createRoot((outerDispose) => {
    createRoot((d) => {
      innerDispose = d
      onCleanup(() => { innerCleanupRan = true })
    })
    outerDispose() // outer dispose should NOT cascade to inner
  })
  expect(innerCleanupRan).toBe(false) // inner is independent
  innerDispose!() // dispose inner explicitly
  expect(innerCleanupRan).toBe(true)
})

test('runWithOwner sets the ambient owner for fn execution and restores after', () => {
  let captured: ReturnType<typeof getOwner> = null
  createRoot(() => {
    const owner = getOwner()
    runWithOwner(null, () => {
      expect(getOwner()).toBeNull()
    })
    expect(getOwner()).toBe(owner) // restored
    runWithOwner(owner, () => {
      captured = getOwner()
    })
  })
  expect(captured).not.toBeNull()
})

test('runWithOwner on a disposed owner throws', () => {
  let disposedOwner!: ReturnType<typeof getOwner>
  createRoot((dispose) => {
    disposedOwner = getOwner()
    dispose()
  })
  expect(() => runWithOwner(disposedOwner!, () => {})).toThrow(/disposed/)
})

test('onCleanup outside any context is a no-op (permissive)', () => {
  // Should not throw, should not crash.
  expect(() => onCleanup(() => {})).not.toThrow()
})
```

### Step 2: Run the tests to verify they fail

Run: `pnpm test -- test/owner.test.ts`
Expected: FAIL — cannot find module `../src/owner`.

### Step 3: Create `src/owner.ts`

```ts
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
      c.call(c)
    } catch {
      // swallow per-cleanup errors
    }
  }
  owner.cleanups.length = 0
}

/**
 * Register a disposable with the current ambient owner. No-op if outside any
 * root. Throws if the current owner has been disposed (caller created a node
 * inside a `runWithOwner(disposed, …)` scope, which is itself a misuse).
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
```

### Step 4: Run the tests to verify they pass

Run: `pnpm test -- test/owner.test.ts`
Expected: PASS — 8 passed.

(Note: tests that depend on effect/computed registering with the owner — "owned effect is disposed", "onCleanup inside an effect body" — are deferred to Task 3 where the wiring lands. Task 2's tests cover the owner module in isolation.)

### Step 5: Run the full suite + typecheck

Run: `pnpm test`
Expected: PASS — no regressions, 8 new owner tests pass.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git add -A
git commit -m "feat(owner): add createRoot, getOwner, runWithOwner, onCleanup"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 3: Wire effects and computeds to the current owner

**Files:**
- Modify: `src/effect.ts` — register the effect's r3 node with the current owner; export `onCleanup` from `./owner` instead of re-exporting r3's.
- Modify: `src/computed.ts` — register each pulse computed's r3 nodes with the current owner.
- Test: `test/effect.test.ts` — append the two tests deferred from Task 2.
- Test: `test/computed.test.ts` — append a "computed is disposed" test.

Each reactive primitive, on creation, gets a disposer registered with the ambient owner (no-op outside any root, matching current behavior). The disposer calls `r3.unwatched(node)` on each r3 computed it owns.

### Step 1: Write the failing tests

Append to `test/effect.test.ts`:

```ts
import { createRoot } from '../src/owner'
// (Add the import alongside existing imports at the top of the file.)

test('owned effect is disposed when its root is disposed', () => {
  setScheduler(syncScheduler(flush))
  const log: number[] = []
  const count = signal(0)
  createRoot((dispose) => {
    effect(() => { log.push(count()) })
    expect(log).toEqual([0])
    setSignal(count, 1)
    expect(log).toEqual([0, 1])
    dispose()
    setSignal(count, 2)
    expect(log).toEqual([0, 1]) // disposed — does NOT re-run
  })
})

test('onCleanup inside an effect body registers per-run (r3 behaviour), not on the owner', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const count = signal(0)
  createRoot(() => {
    effect(() => {
      const c = count()
      log.push(`run ${c}`)
      onCleanup(() => log.push(`cleanup ${c}`))
    })
    expect(log).toEqual(['run 0'])
    setSignal(count, 1)
    expect(log).toEqual(['run 0', 'cleanup 0', 'run 1'])
  })
})
```

Also confirm that `test/effect.test.ts` imports `onCleanup` from `../src/owner` (NOT from `../src/effect`) — see Step 3 below.

Append to `test/computed.test.ts`:

```ts
import { createRoot } from '../src/owner'
// (Add to existing imports at the top of the file.)

test('owned computed is disposed when its root is disposed', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const a = signal(1)
  let derived: () => number | undefined
  createRoot((dispose) => {
    const d = computed(() => a() * 2)
    derived = d as unknown as () => number
    effect(() => { seen.push(d()) })
    expect(seen).toEqual([2])
    setSignal(a, 3)
    expect(seen).toEqual([2, 6])
    dispose()
    setSignal(a, 5)
    expect(seen).toEqual([2, 6]) // disposed — effect does NOT re-run
  })
  setScheduler(microtaskScheduler(flush))
})
```

### Step 2: Run the tests — they must fail

Run: `pnpm test -- test/effect.test.ts test/computed.test.ts`
Expected: FAIL — disposed effects/computeds still re-run because they aren't yet registered with the owner.

### Step 3: Modify `src/effect.ts`

Read the current `src/effect.ts`. Make these changes:

(a) Add this import at the top of the file:

```ts
import { registerWithOwner } from './owner'
import { unwatched, type Computed as R3Computed } from 'r3'
```

(b) Stop re-exporting `onCleanup` from `'r3'`. Remove the line:

```ts
export { onCleanup } from 'r3'
```

(This task task makes `./owner` the canonical source of `onCleanup`. The public barrel in Task 4 will re-export it from there.)

(c) In `effect`, register the r3 node with the current owner after creation. Find the end of the function — specifically the `r3Computed(body)` call — and change it from:

```ts
  r3Computed(body)
}
```

to:

```ts
  const node = r3Computed(body)
  registerWithOwner({
    dispose: () => unwatched(node as R3Computed<unknown>),
  })
}
```

### Step 4: Modify `src/computed.ts`

Read the current `src/computed.ts`. Make these changes:

(a) Add these imports at the top of the file:

```ts
import { registerWithOwner } from './owner'
import { unwatched, type Computed as R3Computed } from 'r3'
```

(b) `makeStageNode` currently returns the accessor and its r3 node is wrapped inside. The disposer needs access to the r3 node. The cleanest path is to have `makeStageNode` return both. Change `makeStageNode`'s signature from:

```ts
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): Signal<unknown> {
```

to:

```ts
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): { accessor: Signal<unknown>; r3Node: R3Computed<unknown> } {
```

and change its final `return` (the line that currently reads `return makeAccessor(r3Node)`) to:

```ts
  const accessor = makeAccessor(r3Node)
  return { accessor, r3Node: r3Node as R3Computed<unknown> }
```

(c) In the main `computed(...stages)` function, collect each stage's `r3Node` and register a single owner disposer that cleans them all up. Change the `computed` body's loop and final return from:

```ts
  let prevAccessor: Signal<unknown> | null = null
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const inputAccessor = prevAccessor
    prevAccessor = makeStageNode(stage, inputAccessor)
  }
  return prevAccessor as Signal<unknown>
}
```

to:

```ts
  let prevAccessor: Signal<unknown> | null = null
  const r3Nodes: R3Computed<unknown>[] = []
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const inputAccessor = prevAccessor
    const { accessor, r3Node } = makeStageNode(stage, inputAccessor)
    r3Nodes.push(r3Node)
    prevAccessor = accessor
  }
  registerWithOwner({
    dispose: () => {
      for (const node of r3Nodes) unwatched(node)
    },
  })
  return prevAccessor as Signal<unknown>
}
```

### Step 5: Update `test/effect.test.ts` import for `onCleanup`

Since `effect.ts` no longer re-exports `onCleanup`, `test/effect.test.ts` must import it from `../src/owner` instead. Find its top of file:

```ts
import { effect, onCleanup } from '../src/effect'
```

Change to:

```ts
import { effect } from '../src/effect'
import { onCleanup } from '../src/owner'
```

### Step 6: Run the tests to verify they pass

Run: `pnpm test -- test/effect.test.ts test/computed.test.ts test/owner.test.ts`
Expected: PASS — all effect, computed, and owner tests pass.

### Step 7: Run the full suite + typecheck

Run: `pnpm test`
Expected: PASS — all test files. Phase 1 / 2a / 2b tests untouched. (Tests that call `effect(...)` / `computed(...)` outside any root continue to work — `registerWithOwner` is a no-op when `currentOwner === null`.)

Run: `pnpm typecheck`
Expected: clean.

### Step 8: Commit

```bash
git add -A
git commit -m "feat: register effects and computeds with the current owner"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 4: Public API barrel + integration test

**Files:**
- Modify: `src/index.ts` — re-export `createRoot`, `getOwner`, `runWithOwner`, `onCleanup`, and the `Owner` type from `./owner`. Remove the existing `onCleanup` re-export from `./effect`.
- Test: `test/integration-ownership.test.ts`

Expose the ownership API in the public barrel and add an end-to-end test exercising signals + computeds + effects all inside one root, then disposing.

### Step 1: Write the failing integration test — create `test/integration-ownership.test.ts`

```ts
import { afterEach, expect, test } from 'vitest'
import {
  computed,
  createRoot,
  effect,
  flush,
  getOwner,
  microtaskScheduler,
  onCleanup,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../src/index'

afterEach(() => setScheduler(microtaskScheduler(flush)))

test('end-to-end: signals + computeds + effects in a root, dispose cleans everything', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const count = signal(0)

  createRoot((dispose) => {
    const doubled = computed(() => count() * 2)
    effect(() => { log.push(`d=${doubled()}`) })
    onCleanup(() => log.push('root cleanup'))

    expect(log).toEqual(['d=0'])
    setSignal(count, 1)
    expect(log).toEqual(['d=0', 'd=2'])

    dispose()
  })

  expect(log).toEqual(['d=0', 'd=2', 'root cleanup'])

  // After dispose: signal still works (signals are not owned), but no effects fire.
  setSignal(count, 5)
  expect(log).toEqual(['d=0', 'd=2', 'root cleanup']) // unchanged
})

test('getOwner is null outside any root, even after the integration scenario', () => {
  expect(getOwner()).toBeNull()
})
```

### Step 2: Run the test to verify it fails

Run: `pnpm test -- test/integration-ownership.test.ts`
Expected: FAIL — `createRoot`, `getOwner`, `onCleanup` (the owner-aware one) are not yet exported from `../src/index`.

### Step 3: Modify `src/index.ts`

Read the current `src/index.ts`. Make these changes:

(a) Remove `onCleanup` from the `./effect` re-export line. Find:

```ts
export { effect, onCleanup } from './effect'
```

Change to:

```ts
export { effect } from './effect'
```

(b) Add a new re-export from `./owner`:

```ts
export {
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  type Owner,
} from './owner'
```

The final `src/index.ts` should look roughly:

```ts
export { isPending, latest, read, use, NotReadyYet, type Resolved } from './async'
export { computed } from './computed'
export { effect } from './effect'
export {
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  type Owner,
} from './owner'
export {
  flush,
  microtaskScheduler,
  requestFlush,
  setScheduler,
  syncScheduler,
  type FlushFn,
  type Scheduler,
} from './scheduler'
export { setSignal, signal, type Signal, type WritableSignal } from './signal'
```

### Step 4: Run the test to verify it passes

Run: `pnpm test -- test/integration-ownership.test.ts`
Expected: PASS — 2 passed.

### Step 5: Run the full suite + typecheck

Run: `pnpm test`
Expected: PASS — all test files.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git add -A
git commit -m "feat: expose ownership API and add integration test"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Done — definition of completion

After Task 4:
- `pnpm test` passes all test files; `pnpm typecheck` is clean.
- pulse has a Solid-style ownership layer: `createRoot((dispose) => …)`, `getOwner()`, `runWithOwner(owner, fn)`, owner-aware `onCleanup`.
- Effects and computeds created inside a root are owned by that root; calling `dispose()` cleans them up (detaches from r3's graph via `r3.unwatched`, runs cleanups bottom-up LIFO).
- Outside any root, all existing behavior is preserved (reactive nodes still work; they just live forever — as today).
- Plan 1, Plan 2a, Plan 2b tests all unchanged and still passing.
- r3 has one new export (`unwatched`), accompanied by ADR 0005.

**Next:** Plan 2d (Error Boundaries) — uses ownership scopes as the "subtree" mechanism for catching sync throws and async rejections; then Plan 3 (DOM layer) for components and bindings.

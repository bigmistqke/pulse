# Transitions Plan A — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `[PENDING]` symbol-brand on accessors with an external pending-tracker subsystem (`isPending(x)` / `promiseOf(x)` as reactive accessors) backed by an internal `WeakMap` registry. Revert `read` to a plain yield helper. No JSX or `<Loading>` changes — those are Plan B.

**Architecture:** A new `src/pending.ts` module owns a `WeakMap<Accessor, PendingEntry>` registered by async computeds. `PendingEntry` carries reactive `pending`/`promise` accessors and an optional `upstream` reference. `isPending(x)` and `promiseOf(x)` return reactive accessors that read the entry (or fall back to value-as-promise inspection for plain `signal(promise)`) and pipeline-OR-walk via the `upstream` chain. `src/computed.ts` registers entries instead of stamping `accessor[PENDING]`. `src/async.ts` drops the brand-check from `read`. The `PENDING` symbol and `PendingBrand` type disappear from `src/signal.ts`.

**Tech Stack:** TypeScript, r3 (reactive primitives), Vitest. No new runtime dependencies.

---

## File Structure

- **Create** `src/pending.ts` — `PendingEntry` type, internal registry, `register`/`lookup` helpers, `isPending`/`promiseOf` public functions.
- **Create** `test/pending.test.ts` — unit tests for the new module.
- **Modify** `src/computed.ts` — replace the brand-stamp block (~lines 289–299) with a registry registration; pipe `inputAccessor`'s registry entry as `upstream`.
- **Modify** `src/async.ts` — remove the `isPending` function (moved to `pending.ts`); revert `read` to drop the brand-check (~lines 140–156).
- **Modify** `src/signal.ts` — remove `PENDING` symbol, `PendingBrand` type, `[PENDING]?` field on `Signal<T>`; drop related imports.
- **Modify** `src/index.ts` — re-export `isPending` and `promiseOf` from `./pending`; drop old re-export of `isPending` from `./async`.
- **Modify** existing tests using `isPending(x)` as a value (now returns an accessor): `test/async.test.ts`, `test/computed.test.ts`, `test/signal.test.ts`, `test/integration-async.test.ts`, `test/integration-async-pipeline.test.ts`. Update to `isPending(x)()`. Delete brand-specific tests (`isPending dispatches via [PENDING] brand`, `[PENDING].promise returns the in-flight Promise during refetch`, etc.) — the brand no longer exists.

---

## Task 1: Create `src/pending.ts` skeleton + first test

**Files:**
- Create: `src/pending.ts`
- Create: `test/pending.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pending.test.ts
import { describe, expect, test } from 'vitest'
import { signal } from '../src/signal'
import { isPending, promiseOf } from '../src/pending'

describe('pending tracker — basics', () => {
  test('isPending returns a reactive accessor; false for plain signal', () => {
    const [s] = signal(42)
    const acc = isPending(s)
    expect(typeof acc).toBe('function')
    expect(acc()).toBe(false)
  })

  test('promiseOf returns a reactive accessor; null for plain signal', () => {
    const [s] = signal(42)
    const acc = promiseOf(s)
    expect(typeof acc).toBe('function')
    expect(acc()).toBe(null)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: FAIL — `Cannot find module '../src/pending'`.

- [ ] **Step 3: Create `src/pending.ts` with minimal implementation**

```ts
// src/pending.ts
import type { Accessor } from './signal'

/** Internal entry describing the pending state of an async-aware accessor.
 *  Registered by `computed` (and any future async-producing primitive) and
 *  consumed by `isPending` / `promiseOf`.
 *
 *  `pending` is a reactive accessor: reading it inside a tracking context
 *  re-fires when this stage flips in/out of pending.
 *  `promise` is a reactive accessor: returns the in-flight Promise for THIS
 *  stage (null if not pending). Pipeline-OR walking is done by
 *  `isPending`/`promiseOf`, not by the entry.
 *  `upstream` (optional) points to the entry of the immediate upstream
 *  stage; the pipeline-OR walk follows this chain.
 */
export interface PendingEntry {
  pending: Accessor<boolean>
  promise: Accessor<Promise<unknown> | null>
  upstream?: PendingEntry
}

const registry = new WeakMap<Accessor<unknown>, PendingEntry>()

/** Register an accessor with the pending tracker. Called by primitives that
 *  produce async-aware accessors (currently: `computed`). */
export function registerPending(accessor: Accessor<unknown>, entry: PendingEntry): void {
  registry.set(accessor, entry)
}

/** Look up the pending entry for an accessor, if registered. Internal. */
export function lookupPending(accessor: Accessor<unknown>): PendingEntry | undefined {
  return registry.get(accessor)
}

/** Reactive accessor: is this signal/computed (or anything upstream) pending?
 *  Returns `() => boolean`. Read inside a tracking context to subscribe. */
export function isPending<T>(x: Accessor<T>): Accessor<boolean> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry === undefined) return false
    return entry.pending()
  }
}

/** Reactive accessor: the in-flight Promise for this stage, or anything
 *  upstream that is pending. Returns `null` when nothing is pending. */
export function promiseOf<T>(x: Accessor<T>): Accessor<Promise<T> | null> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry === undefined) return null
    return entry.promise() as Promise<T> | null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: PASS — both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pending.ts test/pending.test.ts
git commit -m "feat(pending): scaffold external pending tracker (isPending/promiseOf + registry)"
```

---

## Task 2: Add value-as-promise fallback for plain signals

The current `isPending` (in `async.ts`) inspects the signal's value: if it's a pending Promise (per `track()`), report pending. We preserve this behavior so `signal(somePromise)` still reports correctly.

**Files:**
- Modify: `src/pending.ts`
- Modify: `test/pending.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/pending.test.ts`:

```ts
describe('pending tracker — value-as-promise fallback', () => {
  test('isPending true for a signal holding a pending promise', () => {
    const [s] = signal(new Promise(() => {}))
    expect(isPending(s)()).toBe(true)
  })

  test('isPending false for a signal holding a resolved promise (after track)', async () => {
    const p = Promise.resolve('x')
    const [s] = signal<unknown>(p)
    await p
    expect(isPending(s)()).toBe(false)
  })

  test('promiseOf returns the pending promise for a signal holding one', () => {
    const p = new Promise<number>(() => {})
    const [s] = signal(p)
    expect(promiseOf(s)()).toBe(p)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: FAIL — the new tests fail because `isPending`/`promiseOf` don't inspect the signal's value.

- [ ] **Step 3: Add the fallback in `src/pending.ts`**

Update the `isPending` and `promiseOf` functions:

```ts
import { isPromise } from './is-promise'
import { track } from './async'
import type { Accessor } from './signal'

// (PendingEntry, registry, registerPending, lookupPending unchanged)

export function isPending<T>(x: Accessor<T>): Accessor<boolean> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry !== undefined) return entry.pending()
    // Fallback: inspect the value — signals holding a Promise are pending
    // until that Promise settles.
    const value = x()
    if (!isPromise(value)) return false
    return track(value).status === 'pending'
  }
}

export function promiseOf<T>(x: Accessor<T>): Accessor<Promise<T> | null> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry !== undefined) return entry.promise() as Promise<T> | null
    const value = x()
    if (!isPromise(value)) return null
    return track(value).status === 'pending' ? (value as Promise<T>) : null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: PASS — all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pending.ts test/pending.test.ts
git commit -m "feat(pending): value-as-promise fallback for plain signals"
```

---

## Task 3: Add pipeline-OR walk via the `upstream` chain

**Files:**
- Modify: `src/pending.ts`
- Modify: `test/pending.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/pending.test.ts`:

```ts
import { registerPending, type PendingEntry } from '../src/pending'
import { signal as makeSignal } from '../src/signal'

describe('pending tracker — pipeline-OR walk', () => {
  test('isPending true on downstream when only upstream is pending', () => {
    const [downPending] = makeSignal(false)
    const [downPromise] = makeSignal<Promise<unknown> | null>(null)
    const [upPending] = makeSignal(true)
    const [upPromise] = makeSignal<Promise<unknown> | null>(Promise.resolve('x'))

    const upstream: PendingEntry = { pending: upPending, promise: upPromise }
    const down = (() => 42) as Accessor<number>
    registerPending(down, {
      pending: downPending,
      promise: downPromise,
      upstream,
    })

    expect(isPending(down)()).toBe(true)
  })

  test('promiseOf walks upstream when local is null', () => {
    const upP = Promise.resolve('x')
    const [downPending] = makeSignal(false)
    const [downPromise] = makeSignal<Promise<unknown> | null>(null)
    const [upPending] = makeSignal(true)
    const [upPromise] = makeSignal<Promise<unknown> | null>(upP)
    const upstream: PendingEntry = { pending: upPending, promise: upPromise }
    const down = (() => 42) as Accessor<number>
    registerPending(down, { pending: downPending, promise: downPromise, upstream })

    expect(promiseOf(down)()).toBe(upP)
  })
})
```

Add to the top of the test file:
```ts
import type { Accessor } from '../src/signal'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: FAIL — pipeline-OR tests fail (current impl doesn't walk).

- [ ] **Step 3: Implement the walk in `src/pending.ts`**

Replace `isPending` and `promiseOf`:

```ts
export function isPending<T>(x: Accessor<T>): Accessor<boolean> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry !== undefined) {
      // Walk the chain: pending if this stage OR any upstream is.
      let cur: PendingEntry | undefined = entry
      while (cur !== undefined) {
        if (cur.pending()) return true
        cur = cur.upstream
      }
      return false
    }
    const value = x()
    if (!isPromise(value)) return false
    return track(value).status === 'pending'
  }
}

export function promiseOf<T>(x: Accessor<T>): Accessor<Promise<T> | null> {
  return () => {
    const entry = registry.get(x as Accessor<unknown>)
    if (entry !== undefined) {
      // Return the deepest in-flight Promise found by walking upstream.
      // "Deepest" = closest to the user's read site that is actually pending.
      // We walk top-down (this stage first) so local takes precedence.
      let cur: PendingEntry | undefined = entry
      while (cur !== undefined) {
        const p = cur.promise()
        if (p !== null) return p as Promise<T> | null
        cur = cur.upstream
      }
      return null
    }
    const value = x()
    if (!isPromise(value)) return null
    return track(value).status === 'pending' ? (value as Promise<T>) : null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pending.ts test/pending.test.ts
git commit -m "feat(pending): pipeline-OR walk via upstream chain"
```

---

## Task 4: Migrate `src/computed.ts` to register entries (parallel to brand)

We keep the existing `[PENDING]` brand temporarily — registering with the new registry alongside — so existing tests don't break in a single step. Brand removal lands in Task 6.

**Files:**
- Modify: `src/computed.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/pending.test.ts`:

```ts
import { computed } from '../src/computed'

describe('pending tracker — computed integration', () => {
  test('isPending(asyncComputed) true during initial load, false after settle', async () => {
    let resolve!: (v: number) => void
    const p = new Promise<number>((r) => (resolve = r))
    const c = computed(() => p)
    expect(isPending(c)()).toBe(true)
    resolve(42)
    await p
    // Allow the stage's settle handler + scheduler tick.
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(isPending(c)()).toBe(false)
  })

  test('isPending walks across pipeline stages', async () => {
    let resolve!: (v: number) => void
    const p = new Promise<number>((r) => (resolve = r))
    const upstream = computed(() => p)
    const downstream = computed(upstream, (n) => n * 2)
    expect(isPending(downstream)()).toBe(true)
    resolve(21)
    await p
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(isPending(downstream)()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/pending.test.ts`
Expected: FAIL — `computed` doesn't register with the new registry yet.

- [ ] **Step 3: Modify `src/computed.ts` to register**

In `makeStageNode`, after the existing brand creation block (~lines 293–299), add registry registration. Locate the existing block:

```ts
  // Pipeline-aware pending: this stage is pending if its own fetch is in flight
  // OR any upstream stage is. Necessary because SWR hides upstream Promises
  // (downstream stages see the prior resolved value during a refetch, so their
  // own pendingSig stays false even though the pipeline is mid-refetch).
  const upstreamPending = inputAccessor?.[PENDING]
  // Stable brand shape so .promise is always callable.
  const brand = (upstreamPending
    ? () => pendingSig() || upstreamPending()
    : pendingSig) as PendingBrand & { promise: () => Promise<unknown> | null }
  brand.promise = () => suspendedOn ?? upstreamPending?.promise?.() ?? null
  accessor[PENDING] = brand
  return { accessor, r3Node: depTracker as R3Computed<unknown> }
```

Add the registry registration above the `return`:

```ts
  // Register with the external pending tracker (Plan A foundation). The
  // entry stores LOCAL state (pendingSig + a function returning suspendedOn);
  // pipeline-OR walking is the tracker's job, driven by the `upstream` link.
  const upstreamEntry = inputAccessor
    ? lookupPending(inputAccessor as Accessor<unknown>)
    : undefined
  registerPending(accessor, {
    pending: pendingSig,
    promise: () => suspendedOn,
    upstream: upstreamEntry,
  })

  return { accessor, r3Node: depTracker as R3Computed<unknown> }
```

Add imports at the top of `computed.ts`:

```ts
import { registerPending, lookupPending } from './pending'
import type { Accessor } from './signal'
```

(Check that `Accessor` isn't already imported; merge into existing import if so.)

- [ ] **Step 4: Run all tests to verify**

Run: `pnpm exec vitest run`
Expected: PASS — new tests pass; existing tests still pass (brand is still there in parallel).

- [ ] **Step 5: Commit**

```bash
git add src/computed.ts test/pending.test.ts
git commit -m "feat(computed): register stages with external pending tracker (brand kept in parallel)"
```

---

## Task 5: Revert `read` in `src/async.ts` to plain yield helper

**Files:**
- Modify: `src/async.ts`

- [ ] **Step 1: Write a regression test asserting `read` no longer suspends on a pending brand**

The test must distinguish brand-aware vs plain behavior. On first load the accessor returns the in-flight Promise (both paths yield the same thing). To differentiate, we exercise the **SWR refetch case** where `accessor()` returns the stale resolved value but `brand.promise()` would have returned the new in-flight Promise.

Add to `test/async.test.ts` (at the bottom, in a new describe block):

```ts
describe('read — post-Plan-A (no brand suspension)', () => {
  test('yield* read on an SWR-refetching computed yields the stale value, NOT brand.promise', async () => {
    const [page, setPage] = signal(1)
    let activeResolve: (v: string) => void = () => {}
    const c = computed(() => {
      page() // declare dep
      return new Promise<string>((r) => { activeResolve = r })
    })

    // First load: prime the SWR cache.
    c() // subscribe / kick first-eval
    await new Promise((r) => queueMicrotask(r))
    activeResolve('v1')
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe('v1')

    // Trigger refetch — accessor goes SWR-stale, suspendedOn becomes new Promise.
    setPage(2)
    await new Promise((r) => queueMicrotask(r))
    expect(c()).toBe('v1') // SWR-stale

    // Plan A: read yields the stale value directly.
    const gen = read(c)
    const first = gen.next()
    expect(first.value).toBe('v1')
    // (Under the pre-Plan-A brand-aware read, first.value would have been
    // the new in-flight Promise from brand.promise(), not 'v1'.)

    activeResolve('v2')
  })
})
```

Add imports at top of file if not already present:
```ts
import { computed } from '../src/computed'
```

- [ ] **Step 2: Run test to verify it fails under the current (brand-aware) `read`**

Run: `pnpm exec vitest run test/async.test.ts -t "post-Plan-A"`
Expected: FAIL — current `read` consults the `[PENDING]` brand and yields the in-flight Promise first, so `first.value` is a Promise, not `'v1'`.

- [ ] **Step 3: Revert `read` to plain yield helper in `src/async.ts`**

Replace the `read` function (~lines 140–156):

```ts
/**
 * Generator-side resolver. Use as `yield* read(x)` inside a `function*` stage.
 * - x is a signal: the accessor is called (tracking the signal as a dep), and
 *   its value (which may be a `T` or a `Promise<T>`) is yielded.
 * - x is a promise: yielded directly (untracked).
 * - x is a plain value: yielded directly; the driver resumes immediately with it.
 *
 * `yield* read(x)` has type `Resolved<typeof x>` — per-yield inference, courtesy
 * of generator delegation.
 *
 * Plan A note: `read` does NOT consult any `[PENDING]` brand. Suspension is
 * driven solely by the driver's `settle()` over the yielded value. Coherent
 * snapshots and transitions are handled by the JSX boundary layer (Plan B),
 * not by `read`.
 */
export function* read<T>(x: T): Generator<unknown, Resolved<T>, unknown> {
  if (isSignalAccessor(x)) {
    return (yield (x as () => unknown)()) as Resolved<T>
  }
  return (yield x) as Resolved<T>
}
```

Remove `PENDING` from the imports at the top of `async.ts`:

```ts
import { NODE, type Accessor, type Signal } from './signal'
```

(`PendingBrand` import also drops — verify it's gone.)

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run`
Expected: The new "post-Plan-A" test passes. Some pre-existing tests in `async.test.ts` and `computed.test.ts` that relied on brand-aware `read` will fail (e.g., "coherent snapshot via yield* read"). Note them — they get cleaned up in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/async.ts test/async.test.ts
git commit -m "refactor(read): revert to plain yield helper; drop brand-check (Plan A)"
```

---

## Task 6: Remove `[PENDING]` brand from `signal.ts` and `computed.ts`

**Files:**
- Modify: `src/signal.ts`
- Modify: `src/computed.ts`

- [ ] **Step 1: Remove the brand from `src/signal.ts`**

Delete these lines (~21–29):

```ts
/** Optional brand: when present on a Signal/Accessor, `isPending` queries
 *  this accessor instead of inspecting the value-as-promise. Used by
 *  computeds with stale-while-revalidate semantics. */
export const PENDING = Symbol('pulse.pending')

/** The reactive pending brand attached to a Signal accessor by `computed` (Plan 6).
 *  Calling it yields the current pending state; `.promise()` returns the in-flight
 *  Promise (own or upstream) that consumers can throw NotReadyYet on. */
export type PendingBrand = Accessor<boolean> & { promise?: () => Promise<unknown> | null }
```

Update the `Signal<T>` interface to remove the `[PENDING]?` field:

```ts
export interface Signal<T> {
  (): T
  [NODE]: R3Node<T>
}
```

- [ ] **Step 2: Remove the brand-stamp block from `src/computed.ts`**

Delete (~lines 289–299):

```ts
  // Pipeline-aware pending: this stage is pending if its own fetch is in flight
  // OR any upstream stage is. Necessary because SWR hides upstream Promises
  // (downstream stages see the prior resolved value during a refetch, so their
  // own pendingSig stays false even though the pipeline is mid-refetch).
  const upstreamPending = inputAccessor?.[PENDING]
  // Stable brand shape so .promise is always callable.
  const brand = (upstreamPending
    ? () => pendingSig() || upstreamPending()
    : pendingSig) as PendingBrand & { promise: () => Promise<unknown> | null }
  brand.promise = () => suspendedOn ?? upstreamPending?.promise?.() ?? null
  accessor[PENDING] = brand
```

Remove `PENDING` and `PendingBrand` from the imports at the top of `computed.ts`:

```ts
import { makeAccessor, NODE, signal, type Accessor, type Signal } from './signal'
```

- [ ] **Step 3: Run type check**

Run: `pnpm exec tsc --noEmit`
Expected: Errors only from test files that import `PENDING` / `PendingBrand`. Note them for Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/signal.ts src/computed.ts
git commit -m "refactor(signal,computed): remove [PENDING] symbol brand; pending lives in external registry only"
```

---

## Task 7: Migrate existing tests to the new API + delete brand-only tests

**Files:**
- Modify: `test/async.test.ts`
- Modify: `test/computed.test.ts`
- Modify: `test/signal.test.ts`
- Modify: `test/integration-async.test.ts`
- Modify: `test/integration-async-pipeline.test.ts`

The shape change: `isPending(x): boolean` → `isPending(x): () => boolean`. Every existing call site that used `isPending(x)` as a value becomes `isPending(x)()`.

Brand-only tests are deleted outright (they test API surface that no longer exists).

- [ ] **Step 1: Update `test/async.test.ts`**

- Remove `import { PENDING }` from the `signal.ts` import line; remove `Accessor` if only used in brand tests.
- Change `import { isPending, ... }` source from `'../src/async'` to `'../src/pending'`.
- Replace every `expect(isPending(x)).toBe(...)` with `expect(isPending(x)()).toBe(...)`.
- **Delete** these tests entirely:
  - `'isPending dispatches via [PENDING] brand when present'`
  - `'isPending without [PENDING] brand falls back to isPromise(value)'` (covered by Task 2 tests in `test/pending.test.ts`; keep one if it adds value but adapt to new API)
  - `'isPending([PENDING]) takes precedence over value check'`
- The brand-aware-`read` coherent-snapshot test from Plan 7 ("coherent snapshot via yield* read" or similar) — delete it. Coherent snapshots move to Plan B.

- [ ] **Step 2: Update `test/computed.test.ts`**

- Remove `import { PENDING } from '../src/signal'`.
- Change `import { isPending, ... }` source from `'../src/async'` to `'../src/pending'`.
- Replace `isPending(x)` with `isPending(x)()` at all call sites.
- **Delete** the test `'[PENDING].promise returns the in-flight Promise during refetch'` (and any other test that reads `list[PENDING]` directly). The equivalent capability is covered by `promiseOf(x)()` — add one test for it instead:

```ts
test('promiseOf(computed) returns the in-flight Promise during refetch', async () => {
  // ...same scenario as the deleted brand test, but using promiseOf
  // instead of list[PENDING]!.promise!()
})
```

Use the deleted test as a template; substitute `promiseOf(list)()` for `list[PENDING]!.promise!()`.

- [ ] **Step 3: Update `test/signal.test.ts`**

- Change `import { isPending } from '../src/async'` to `import { isPending } from '../src/pending'`.
- Replace `isPending(s)` value reads with `isPending(s)()`.

- [ ] **Step 4: Update `test/integration-async.test.ts`**

- The line `import { effect, isPending, latest, signal, use } from '../src/index'` keeps working because Task 8 re-exports `isPending` from `'./pending'` via the barrel.
- Replace `isPending(x)` value reads with `isPending(x)()`.

- [ ] **Step 5: Update `test/integration-async-pipeline.test.ts`**

- Same migration: `isPending(x)` → `isPending(x)()`.

- [ ] **Step 6: Run full test suite**

Run: `pnpm exec vitest run`
Expected: All tests pass. If any test was a brand-API regression test that no longer makes sense, delete it with a brief commit message note.

- [ ] **Step 7: Commit**

```bash
git add test/
git commit -m "test: migrate to external pending tracker API (isPending(x)()); drop brand-only tests"
```

---

## Task 8: Update public exports in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update the export**

Replace:

```ts
export { isPending, latest, read, use, NotReadyYet, type Resolved } from './async'
```

with:

```ts
export { latest, read, use, NotReadyYet, type Resolved } from './async'
export { isPending, promiseOf } from './pending'
```

- [ ] **Step 2: Run type check + tests**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: PASS — no type errors, all tests green.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(public): export isPending + promiseOf from src/pending"
```

---

## Task 9: Update the transitions spec follow-ups note

The current `docs/follow-ups.md` "Already addressed" entry on transitions cites Plan 7 commits and the old design doc. Add a forward-looking entry that records the Plan A change so future readers find the new design.

**Files:**
- Modify: `docs/follow-ups.md`

- [ ] **Step 1: Add an entry in "Already addressed"**

After the existing transitions entry, append (substitute the actual commit SHAs from this plan's commits):

```markdown
- ~~Transitions redesign (Plan A foundation): external `isPending` / `promiseOf` tracker replaces `[PENDING]` symbol brand on accessors; `read` reverts to plain yield helper.~~ Landed in commits `<SHA1>` … `<SHA8>`. See `docs/superpowers/specs/2026-05-17-pulse-transitions-redesign.md`. JSX hole caching + `<Loading>` boundary changes are in Plan B (separate plan).
```

- [ ] **Step 2: Commit**

```bash
git add docs/follow-ups.md
git commit -m "docs(follow-ups): record Plan A landing of external pending tracker"
```

---

## Verification (post-implementation)

Run the full suite + typecheck before declaring done:

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```

Expected:
- All type checks clean.
- All tests pass.
- No references to `PENDING` symbol or `PendingBrand` type remain in `src/` (verify: `grep -rn "PENDING\|PendingBrand" src/`).
- `isPending` and `promiseOf` exported from the public barrel.
- Pokemon demo (`examples/pokemon`) still works — its current code uses the brand-aware `read` for transitions. After Plan A, the demo's view computed will give incoherent snapshots again (the same regression the Plan 6 spec flagged). This is acceptable as a Plan-A interim state; Plan B re-fixes it via `<Loading>` boundary semantics. **Spot-check** that the demo loads and the basic page-change flow still functions (visually-incoherent-snapshot is OK; broken-build is not).

---

## Out of scope (handled by Plan B)

- JSX hole cache + `NotReadyYet` catch.
- `<Loading>` boundary collecting state machine + atomic flush.
- Pokemon demo migration to `<Loading>`-based transitions.
- **Changing `use(accessor)` to throw on `isPending(x)()`** as specified in the design doc §5. Plan A keeps `use`'s current behavior (returns SWR-stale value when accessor isn't itself a Promise). Changing `use` to throw-on-pending without the hole cache would cause every refetch to break out of the surrounding effect/binding — exactly the SWR-at-leaf regression that the Plan 7 design backed off from. The change lands in Plan B alongside the hole cache that catches the throw.
- Removing the Plan 7 transitions spec (`docs/superpowers/specs/2026-05-16-pulse-transitions-design.md`) — leave it for now; the new spec already supersedes it via its header.

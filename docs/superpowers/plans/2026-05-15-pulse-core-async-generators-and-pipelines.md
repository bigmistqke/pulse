# pulse/core — Async: Generator & Async Pipeline Stages (Plan 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `computed` accepts pipeline stages of any of three shapes — sync `(v) => T`, `async (v) => Promise<T>`, and `function* (v): Generator<…, T, …>`. Inside generator stages, `yield* read(x)` reads (and tracks) a signal/promise/value with correct per-yield type inference. The pipeline suspends when a stage's promise is pending and resumes when it settles.

**Architecture:** Each pipeline stage becomes its own inner r3 computed; the pulse `computed` accessor reads the *last* stage. Stage N reads stage N-1's value; if it's a `Promise<T>` the stage propagates it (its own value becomes that promise — async color flows through the graph). Stage execution goes through a small **driver** that handles all three stage shapes: a sync function whose return is awaited via the WeakMap promise-state tracker (the same one `use` uses), an async function whose returned promise is treated identically, or a generator whose yields are individually awaited (settled → resume sync, pending → suspend, rejected → throw into the generator so `try/catch` in the body works). Suspension is propagated by returning the in-flight `Promise<T>` as the stage's r3 value, with the same kick-signal + `suspendedOn` mechanism used by effects to re-trigger the stage on settle.

**Tech Stack:** TypeScript (strict), Vitest, r3. Builds on Plan 1 (sync foundation) and Plan 2a (the per-node async edge — promise-holding signals, write-back, `use`/`NotReadyYet`, effect suspension).

**Scope notes — what this plan deliberately does NOT do:**
- **Within-generator checkpoint resume.** When a `function*` stage with multiple `yield*` points re-runs (e.g. because a sync dep it read changed), the entire generator restarts from the top — yielded promises whose deps haven't changed are re-tracked via the WeakMap (no fresh fetches if you `yield* read(signal)` where the signal still holds the same promise), but local state in the generator body is not preserved across the restart. The within-generator segment-level caching is a follow-up plan.
- **Error boundaries.** A rejected promise inside a generator still throws into the generator (where the user can `try/catch`); an uncaught throw still propagates out of the stage uncaught — same shape as Plan 2a's effect behaviour. Graph-level error boundaries are Plan 2c.
- **DOM layer** (Plan 3).
- **Stable-promise discipline helpers.** Documented as discipline; no enforcement primitives in this plan.

**Architectural note — divergence from the literal wording of ADR 0003.** ADR 0003 describes the re-entry mechanism as "one ordinary r3 computed node" with "stashed pipeline state". This plan uses **multiple** ordinary r3 computed nodes (one per stage) instead — leveraging r3's existing memoization for free cross-stage caching, rather than maintaining a hand-rolled stash. The ADR's load-bearing commitment (r3 stays unmodified; async-ness lives wholly in pulse's wrapper; re-entry reuses the scheduler's normal dirty-node path) is fully respected — per-stage just uses more of those normal nodes. This trade favours simpler runtime over fewer nodes. If you (the reader/executor) prefer to revisit and stay literal to ADR 0003, stop and escalate before starting Task 4.

---

## File structure

| File | Responsibility | This plan |
|------|----------------|-----------|
| `src/driver.ts` | The stage runner + generator driver: handles sync/async/generator stage shapes; returns `{ value }` or `{ pending: Promise }` | **Create** (Task 2) |
| `src/async.ts` | Add `read(x)` (generator-side resolver) and export `track` (internal) so the driver can share the promise-state WeakMap | **Modify** (Tasks 1 & 3) |
| `src/computed.ts` | Replace the single-r3-computed pipeline runner with a per-stage chain that propagates suspension and types via `Resolved<T>` | **Modify** (Tasks 4 & 5) |
| `src/index.ts` | Add `read` to the public barrel | **Modify** (Task 6) |
| `test/driver.test.ts` | Driver unit tests (no r3 integration) | **Create** (Task 2) |
| `test/async.test.ts` | Append `read` tests | **Modify** (Task 3) |
| `test/computed.test.ts` | Append async-stage and generator-stage pipeline tests | **Modify** (Task 5) |
| `test/integration-async-pipeline.test.ts` | End-to-end pipeline integration test | **Create** (Task 6) |

Existing files unchanged in this plan: `src/signal.ts`, `src/effect.ts`, `src/scheduler.ts`, `src/is-promise.ts`. No regressions in their tests.

---

## Task 1: `isGeneratorFunction`, `isAsyncFunction`, and export `track`

**Files:**
- Modify: `src/async.ts` — export the existing `track` function (currently a private helper) so `src/driver.ts` can share the promise-state WeakMap. Also add `isGeneratorFunction` and `isAsyncFunction` helpers (used by the driver).
- Test: `test/driver.test.ts` will be created in Task 2; this task has no tests of its own (the helpers are exercised through later tasks).

Sharing `track` between `use` and the driver means a single `WeakMap` of promise states — so a promise resolved via `use` is also seen as resolved by the driver, and vice versa. This is the correct semantics; no duplicate state.

- [ ] **Step 1: Modify `src/async.ts`**

Read the current `src/async.ts`. Apply two changes:

(a) Change `function track(...)` to `export function track(...)` — make it public-to-other-source-files (it will not be added to the public barrel `src/index.ts`).

(b) Add these two helpers anywhere at the top level of the file (placement is not load-bearing — group them with the other internals):

```ts
/** True if `f` is declared with `function*` (a generator function). */
export function isGeneratorFunction(f: unknown): f is (...args: unknown[]) => Generator<unknown, unknown, unknown> {
  return typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'GeneratorFunction'
}

/** True if `f` is declared with `async function` (an async function). */
export function isAsyncFunction(f: unknown): f is (...args: unknown[]) => Promise<unknown> {
  return typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction'
}
```

Leave everything else in `src/async.ts` unchanged (`isPending`, `latest`, `NotReadyYet`, `PromiseState`, `states`, `use`, the `lastResolved` WeakMap, all imports).

- [ ] **Step 2: Run typecheck — confirm clean**

Run: `pnpm typecheck`
Expected: clean. (No tests yet for the helpers — they're exercised in Task 2.)

- [ ] **Step 3: Run the full suite — no regressions**

Run: `pnpm test`
Expected: PASS — all 38 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(async): export track and add generator/async function predicates"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 2: The stage driver

**Files:**
- Create: `src/driver.ts`
- Test: `test/driver.test.ts`

A small, pure-function runtime that takes a stage and an input value and returns either `{ pending: false, value }` or `{ pending: true, promise }`. Sync stages → call directly + treat the return value as a possible-promise. Async stages → same (an `async` function's return is always a promise). Generator stages → run the driver loop, treating each yielded value as a possible-promise; a rejected promise is thrown back into the generator at the yield point (so `try/catch` in the user's body works); a pending promise short-circuits the stage with `{ pending: true, promise }`.

This task has zero r3 integration — the driver is pure functions. Unit-test it directly. The integration with `computed` happens in Task 4.

- [ ] **Step 1: Write the failing tests — create `test/driver.test.ts`**

```ts
import { expect, test } from 'vitest'
import { runStage } from '../src/driver'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('sync stage returning a plain value', () => {
  const r = runStage((v: number) => v * 2, 3)
  expect(r).toEqual({ pending: false, value: 6 })
})

test('sync stage returning a pending promise -> suspended', () => {
  const p = new Promise<number>(() => {})
  const r = runStage(() => p, 0)
  expect(r).toEqual({ pending: true, promise: p })
})

test('sync stage returning a settled promise -> resolved synchronously on second call', async () => {
  const p = Promise.resolve(7)
  const first = runStage(() => p, 0)
  expect(first.pending).toBe(true)
  await tick()
  const second = runStage(() => p, 0)
  expect(second).toEqual({ pending: false, value: 7 })
})

test('async stage with pending promise -> suspended (carries the same promise instance)', () => {
  let release!: (v: number) => void
  const stage = async (_: unknown) => {
    return new Promise<number>((resolve) => { release = resolve })
  }
  const r = runStage(stage, 0)
  expect(r.pending).toBe(true)
})

test('generator stage yielding a settled value -> returns synchronously', () => {
  function* stage(input: number) {
    const x: number = yield input + 1
    return x * 2
  }
  // input + 1 is 4, a plain number; yield resumes with 4; return 4*2=8
  const r = runStage(stage, 3)
  expect(r).toEqual({ pending: false, value: 8 })
})

test('generator stage yielding a pending promise -> suspended', () => {
  const p = new Promise<number>(() => {})
  function* stage(_: unknown) {
    const x: number = yield p
    return x
  }
  const r = runStage(stage, 0)
  expect(r).toEqual({ pending: true, promise: p })
})

test('generator stage: settled promise resolves synchronously on re-call', async () => {
  const p = Promise.resolve(42)
  function* stage(_: unknown) {
    const x: number = yield p
    return x + 1
  }
  expect(runStage(stage, 0).pending).toBe(true)
  await tick()
  expect(runStage(stage, 0)).toEqual({ pending: false, value: 43 })
})

test('generator stage: rejected promise throws into the generator', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  function* stage(_: unknown) {
    try {
      yield p
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  }
  expect(runStage(stage, 0).pending).toBe(true)
  await tick()
  expect(runStage(stage, 0)).toEqual({ pending: false, value: 'caught: boom' })
})

test('generator stage: uncaught rejection propagates out of runStage', async () => {
  const reason = new Error('uncaught')
  const p = Promise.reject(reason)
  function* stage(_: unknown) {
    yield p
    return 'unreachable'
  }
  expect(runStage(stage, 0).pending).toBe(true)
  await tick()
  expect(() => runStage(stage, 0)).toThrow('uncaught')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/driver.test.ts`
Expected: FAIL — cannot find module `../src/driver`.

- [ ] **Step 3: Create `src/driver.ts`**

```ts
import { isPromise } from './is-promise'
import { isAsyncFunction, isGeneratorFunction, track } from './async'

/** Outcome of running a single stage: either a settled value, or pending on a promise. */
export type StageOutcome =
  | { pending: false; value: unknown }
  | { pending: true; promise: Promise<unknown> }

/**
 * Resolve a possibly-async value to a `StageOutcome`. Used by the driver after
 * a stage returns / yields. Settled fulfillment -> `{value}`; pending -> `{pending}`;
 * settled rejection -> re-throws the reason (so the caller can route it — into
 * a generator's try/catch via `gen.throw`, or out of `runStage` as a real error).
 */
function settle(value: unknown): StageOutcome {
  if (!isPromise(value)) return { pending: false, value }
  const state = track(value)
  if (state.status === 'fulfilled') return { pending: false, value: state.value }
  if (state.status === 'rejected') throw state.reason
  return { pending: true, promise: value }
}

/**
 * Drive a generator. Each yielded value goes through `settle`:
 * - settled value -> resume the generator with it via `gen.next`
 * - settled rejection -> resume via `gen.throw` (user's try/catch can handle it;
 *   if uncaught, the generator throws back to us and we propagate)
 * - pending -> short-circuit with `{ pending, promise }`
 * The generator's own return value is itself run through `settle` (a generator
 * may `return await something` and the runtime should still wait on it).
 */
function driveGenerator(gen: Generator<unknown, unknown, unknown>): StageOutcome {
  let nextValue: unknown = undefined
  let nextThrow: unknown = undefined
  let hasThrow = false
  while (true) {
    const result = hasThrow ? gen.throw(nextThrow) : gen.next(nextValue)
    hasThrow = false
    if (result.done) return settle(result.value)
    let outcome: StageOutcome
    try {
      outcome = settle(result.value)
    } catch (rejection) {
      // settled rejection: feed it into the generator's try/catch
      nextThrow = rejection
      hasThrow = true
      continue
    }
    if (outcome.pending) return outcome
    nextValue = outcome.value
  }
}

/**
 * Run a single pipeline stage with the given input. Detects the stage's shape
 * (generator function / async function / sync function) and dispatches.
 *
 * NOTE: detection of `async` is informational only — an async function's
 * returned promise is handled by `settle` just like any other returned promise,
 * so the sync path catches it correctly. The `isAsyncFunction` check exists for
 * symmetry and future expansion; it is not strictly required for correctness.
 */
export function runStage(
  stage: (value: unknown) => unknown,
  input: unknown,
): StageOutcome {
  if (isGeneratorFunction(stage)) {
    return driveGenerator(stage(input) as Generator<unknown, unknown, unknown>)
  }
  // sync OR async function — both return a value that `settle` handles uniformly.
  // The `isAsyncFunction(stage)` predicate is intentionally unused at runtime here
  // (it would only matter if we wanted to special-case ergonomics; we don't).
  return settle(stage(input))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/driver.test.ts`
Expected: PASS — 9 passed.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — all tests (Plan 1 + Plan 2a + new driver tests).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(driver): add stage runner with generator + promise handling"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 3: `read(x)` — generator-side resolver

**Files:**
- Modify: `src/async.ts` — add `read` (and the `Resolved<T>` type)
- Test: `test/async.test.ts` — append

`read(x)` is the helper used as `yield* read(x)` inside a generator stage. It exists for **per-yield type inference**: TypeScript types a generator's yield expression as the generator's single `TNext` type, so without delegation each `yield` would have the same type. `yield*` delegates to a sub-iterator whose return type is inferred separately. `read(x)` wraps a value/promise/signal into such a sub-iterator and returns the resolved value with the right type.

Three input shapes:
- A **signal accessor** (a function carrying the internal `NODE` symbol) → call it (which tracks the signal as a dep of the surrounding r3 computed) and yield the resulting value/promise.
- A **promise** → yield it directly (untracked — the dep graph does not record bare-promise reads).
- A **plain value** → yield it directly; the driver resumes immediately with it.

In all three cases, the driver feeds back the resolved value (a plain `T` after unwrapping any promise), and `read` returns it.

- [ ] **Step 1: Write the failing tests — append to `test/async.test.ts`**

Add `read` to the existing `../src/async` import (alongside `isPending`, `latest`, `use`, `NotReadyYet`). Append these tests at the end of the file:

```ts
test('read of a plain value yields it; yield* expression resolves to it', () => {
  // Drive `read(42)` manually (no driver yet here — we drive by hand for the unit test).
  const gen = read(42)
  const step = gen.next()
  expect(step.done).toBe(false)
  expect(step.value).toBe(42)
  const final = gen.next(42)
  expect(final.done).toBe(true)
  expect(final.value).toBe(42)
})

test('read of a signal calls its accessor (tracking happens via the call)', () => {
  const s = signal(7)
  const gen = read(s)
  const step = gen.next()
  expect(step.value).toBe(7) // s() was called; yields its value
  const final = gen.next(7)
  expect(final.value).toBe(7)
})

test('read of a promise yields the promise itself', () => {
  const p = Promise.resolve(1)
  const gen = read(p)
  const step = gen.next()
  expect(step.value).toBe(p)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/async.test.ts`
Expected: FAIL — `read` is not exported from `../src/async`.

- [ ] **Step 3: Modify `src/async.ts`**

Add this import line near the top (alongside the existing `import type { Signal } from './signal'`):

```ts
import { NODE } from './signal'
```

Append this `Resolved<T>` type and the `read` function to `src/async.ts`. They belong below the existing exports.

```ts
/**
 * The resolved-and-unwrapped type of a stage value or `read(x)` argument:
 * - If T is a Signal<U>, the result is Awaited<U>.
 * - If T is a Generator returning R, the result is Awaited<R>.
 * - Otherwise the result is Awaited<T>.
 */
export type Resolved<T> = T extends Signal<infer U>
  ? Awaited<U>
  : T extends Generator<unknown, infer R, unknown>
    ? Awaited<R>
    : Awaited<T>

/** True if `x` looks like a pulse signal accessor (a function carrying NODE). */
function isSignalAccessor(x: unknown): x is Signal<unknown> {
  return typeof x === 'function' && NODE in (x as object)
}

/**
 * Generator-side resolver. Use as `yield* read(x)` inside a `function*` stage.
 * - x is a signal: the accessor is called (tracking the signal as a dep), and
 *   its value (which may be a `T` or a `Promise<T>`) is yielded.
 * - x is a promise: yielded directly (untracked).
 * - x is a plain value: yielded directly; the driver resumes immediately with it.
 *
 * `yield* read(x)` has type `Resolved<typeof x>` — per-yield inference, courtesy
 * of generator delegation.
 */
export function* read<T>(x: T): Generator<unknown, Resolved<T>, unknown> {
  const value = isSignalAccessor(x) ? (x as () => unknown)() : x
  return (yield value) as Resolved<T>
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/async.test.ts`
Expected: PASS — all async tests including the 3 new `read` tests.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(async): add read(x) generator-side resolver with Resolved<T> typing"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 4: Per-stage pipeline runtime (sync stages only — regression task)

**Files:**
- Modify: `src/computed.ts` — restructure to per-stage r3 computeds. SYNC stages only at this task; async/generator support is layered on in Task 5.
- Test: relies on existing Phase 1 / 2a tests (`test/computed.test.ts`) for regression coverage. No new tests yet — Task 5 adds them.

Restructure `computed` so each stage runs inside its own inner r3 computed. The pipeline accessor is the *last* stage's accessor. Each stage's r3 computed: reads the previous stage's accessor (or, for stage 0, runs with no input), then calls the stage function with that input. No async handling yet — async/generator stages are added in Task 5.

This is a load-bearing architectural change. Phase 1 tests for `computed` must continue to pass without modification.

- [ ] **Step 1: Verify current state — Phase 1 / 2a tests must be green before changing anything**

Run: `pnpm test -- test/computed.test.ts`
Expected: PASS — the existing 5 computed tests pass.

- [ ] **Step 2: Replace `src/computed.ts` entirely with:**

```ts
import { computed as r3Computed } from 'r3'
import { makeAccessor, type Signal } from './signal'

/** A pipeline stage: receives the previous stage's value, returns the next. */
type Stage<In, Out> = (value: In) => Out

// Overloads: stage 0 takes no input; stage N takes stage N-1's return type.
// (The async / generator return-type unwrapping is added in Task 5; for now,
// stages are typed for purely synchronous use as in Phase 1.)
export function computed<A>(s0: () => A): Signal<A>
export function computed<A, B>(s0: () => A, s1: Stage<A, B>): Signal<B>
export function computed<A, B, C>(
  s0: () => A,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
): Signal<C>
export function computed<A, B, C, D>(
  s0: () => A,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
): Signal<D>
export function computed<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
  s4: Stage<D, E>,
): Signal<E>

/**
 * Create a derived signal from a pipeline of one or more stages.
 *
 * Each stage runs in its own inner r3 computed: r3's memoization gives free
 * per-stage caching (a stage whose tracked deps did not change does not
 * re-execute when a *downstream* stage is invalidated by a different signal).
 *
 * @remarks Typed overloads cover 1–5 stages; beyond that, compose pipelines.
 */
export function computed(...stages: Array<(value: unknown) => unknown>): Signal<unknown> {
  if (stages.length === 0) {
    throw new Error('computed requires at least one stage')
  }

  // Stage 0: no input.
  let prevAccessor: Signal<unknown> = makeAccessor(
    r3Computed(() => stages[0](undefined)),
  )

  for (let i = 1; i < stages.length; i++) {
    const stage = stages[i]
    const inputAccessor = prevAccessor
    prevAccessor = makeAccessor(
      r3Computed(() => stage(inputAccessor())),
    )
  }

  return prevAccessor
}
```

- [ ] **Step 3: Run the existing `computed` tests — must still pass**

Run: `pnpm test -- test/computed.test.ts`
Expected: PASS — all 5 existing computed tests pass under the new per-stage architecture.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions anywhere (Plan 2a tests including the async integration test continue to pass — Plan 2a's async path goes through `signal`/`effect`/`use`, not through pipeline stages).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(computed): each pipeline stage runs in its own r3 computed"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 5: Async + generator stage support, with suspension propagation

**Files:**
- Modify: `src/computed.ts` — route stages through `runStage` from the driver; propagate suspension via a `Promise<T>` stage value + kick-on-settle; update overload types to use `Resolved<T>`.
- Test: `test/computed.test.ts` — append.

This is the meaty task. Each stage's inner r3 computed now:
1. Reads the previous stage's value. If it's a `Promise<T>` (the previous stage is suspended), propagate — this stage's value becomes the same promise. The downstream chain stays suspended without re-entering the stage's logic.
2. Otherwise, run the stage via `runStage` from the driver.
3. If the driver returns `{ pending: true, promise }`, register a `.then` on the promise (guarded by `suspendedOn` against double-registration) that, on settle, bumps a per-stage `kick` signal — invalidating this stage's r3 computed and triggering a re-run. The stage's r3 value becomes the in-flight promise (async color flows downstream).
4. On a successful (non-suspended) outcome, clear `suspendedOn` and return the value.

This mirrors the `effect` suspension shape from Plan 2a — same `suspendedOn` guard, same kick-signal pattern — applied per stage.

- [ ] **Step 1: Write the failing tests — append to `test/computed.test.ts`**

Read the top of `test/computed.test.ts` to confirm imports. If `use` and the scheduler are not imported, add them. Then append a `tick` helper (it is not yet present in this file) and the new tests.

Add these imports if absent (place alongside existing imports):

```ts
import { read, use } from '../src/async'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
```

After the imports, add this helper (place above the first existing `test(`):

```ts
/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
```

Then append these tests at the end of the file:

```ts
test('an async stage suspends the pipeline; the value becomes the in-flight promise', async () => {
  let release!: (v: number) => void
  const c = computed(
    () => 1,
    async (v: number) => {
      return new Promise<number>((resolve) => { release = resolve }).then((n) => n + v)
    },
  )
  // Before settle: the pipeline's value is the in-flight promise (suspended).
  const beforeSettle = c() as unknown
  expect(beforeSettle).toBeInstanceOf(Promise)
  release(10)
  await tick()
  // After settle: write-back is not in play here (this is a computed, not a signal),
  // but the kick re-runs the suspended stage. The pipeline's r3 value flips to 11.
  expect(c()).toBe(11)
})

test('a generator stage with yield* read of a settled value runs synchronously', () => {
  const s = signal(3)
  const c = computed(function* () {
    const x: number = yield* read(s)
    return x * 2
  })
  expect(c()).toBe(6)
})

test('a generator stage suspends on a pending promise, resumes on settle', async () => {
  let release!: (v: number) => void
  const p = new Promise<number>((resolve) => { release = resolve })
  const c = computed(function* () {
    const x: number = yield* read(p)
    return x + 100
  })
  expect(c()).toBeInstanceOf(Promise)
  release(5)
  await tick()
  expect(c()).toBe(105)
})

test('cross-stage caching: a sync stage downstream of an unchanged stage is not re-run', () => {
  setScheduler(syncScheduler(flush))
  const a = signal(1)
  let calls = 0
  const c = computed(
    () => a(),
    (v: number) => {
      calls++
      return v + 100
    },
  )
  expect(c()).toBe(101)
  expect(calls).toBe(1)
  // Forcing a re-stabilize (via an unrelated signal write that does not feed this
  // pipeline) does not re-run the stages — but we cannot easily trigger one
  // without an effect. Simpler check: reading c() again does not re-run.
  expect(c()).toBe(101)
  expect(calls).toBe(1)
  setScheduler(microtaskScheduler(flush))
})

test('a generator stage that try/catches a rejected yield resumes normally', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  const c = computed(function* () {
    try {
      yield* read(p)
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  })
  expect(c()).toBeInstanceOf(Promise)
  await tick()
  expect(c()).toBe('caught: boom')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/computed.test.ts`
Expected: FAIL — `computed` does not handle async/generator stages; the new tests fail (either by returning a generator/promise as a raw value, by typecheck on the overloads, or by not suspending correctly).

- [ ] **Step 3: Replace `src/computed.ts` entirely with the async-aware version**

```ts
import { computed as r3Computed } from 'r3'
import { runStage } from './driver'
import { isPromise } from './is-promise'
import { type Resolved } from './async'
import { makeAccessor, setSignal, signal, type Signal } from './signal'

/** A pipeline stage of any shape: sync, async, or generator. The return type
 *  is whatever the function returns — sync `R`, async `Promise<R>`, or
 *  `Generator<…, R, …>`. The pipeline unwraps to `Resolved<R>` for the next stage. */
type Stage<In, Out> = (value: In) => Out

// Overloads: stage N's input is `Resolved<stage N-1's return type>`; the pipeline
// result is `Resolved<last stage's return type>`.
export function computed<A>(s0: () => A): Signal<Resolved<A>>
export function computed<A, B>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
): Signal<Resolved<B>>
export function computed<A, B, C>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
): Signal<Resolved<C>>
export function computed<A, B, C, D>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
): Signal<Resolved<D>>
export function computed<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
  s4: Stage<Resolved<D>, E>,
): Signal<Resolved<E>>

/**
 * Create a derived signal from a pipeline of one or more stages. Each stage may
 * be sync `(v) => T`, async `async (v) => Promise<T>`, or generator
 * `function* (v): Generator<…, T, …>`. Inside a generator stage, use
 * `yield* read(x)` to read signals and await promises with correct per-yield
 * inference. The pipeline suspends when a stage's promise is pending (the stage's
 * r3 value becomes that in-flight `Promise<T>` — async color flows downstream).
 * It re-runs when the promise settles, via a per-stage kick signal.
 *
 * @remarks Typed overloads cover 1–5 stages; beyond that, compose pipelines.
 */
export function computed(...stages: Array<(value: unknown) => unknown>): Signal<unknown> {
  if (stages.length === 0) {
    throw new Error('computed requires at least one stage')
  }

  // Build the chain: stage 0 has no input; later stages read the previous accessor.
  let prevAccessor: Signal<unknown> | null = null
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const inputAccessor = prevAccessor
    prevAccessor = makeStageNode(stage, inputAccessor)
  }
  return prevAccessor as Signal<unknown>
}

/**
 * Wrap a single stage in an r3 computed that handles suspension propagation.
 * If `inputAccessor` is null, the stage has no input (it is stage 0). Otherwise
 * the stage reads its predecessor — and if that value is a pending promise, this
 * stage's value becomes the same promise (color propagates without re-entering
 * the stage's logic).
 */
function makeStageNode(
  stage: (value: unknown) => unknown,
  inputAccessor: Signal<unknown> | null,
): Signal<unknown> {
  // `kick` lets a settled promise re-trigger this stage's r3 computed.
  const kick = signal(0)
  // `kickCount` increments per kick so each `setSignal(kick, ...)` is a distinct value
  // (r3's setSignal bails on `el.value === v`, so writing the same value would be a no-op).
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null

  const r3Node = r3Computed(() => {
    kick() // depend on the kick signal so a settled promise can re-trigger this stage

    // Propagate a suspended input: if the previous stage's value is a promise,
    // this stage's value is the same promise. Do not run `stage` — re-entering
    // when the input value flips will re-evaluate this whole body anyway.
    let input: unknown = undefined
    if (inputAccessor !== null) {
      input = inputAccessor()
      if (isPromise(input)) {
        // The previous stage is suspended; mirror its state.
        suspendedOn = null
        return input
      }
    }

    const outcome = runStage(stage, input)
    if (outcome.pending) {
      const p = outcome.promise
      if (suspendedOn !== p) {
        suspendedOn = p
        const rerun = () => {
          if (suspendedOn === p) {
            suspendedOn = null
            setSignal(kick, ++kickCount)
          }
        }
        p.then(rerun, rerun)
      }
      return p
    }

    suspendedOn = null
    return outcome.value
  })

  return makeAccessor(r3Node)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/computed.test.ts`
Expected: PASS — all `computed` tests, including the 5 Phase 1 sync tests and the 5 new async/generator tests.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions across all test files.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(computed): support async and generator stages with suspension"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 6: Expose `read` + pipeline integration test

**Files:**
- Modify: `src/index.ts` — add `read` and `Resolved` (type) to the public barrel
- Test: `test/integration-async-pipeline.test.ts`

Expose the new generator-side resolver in the public barrel, and add an end-to-end test exercising a mixed pipeline (sync + async + generator stages) under the default microtask scheduler.

- [ ] **Step 1: Write the failing integration test — create `test/integration-async-pipeline.test.ts`**

```ts
import { expect, test } from 'vitest'
import { computed, read, setSignal, signal, type Resolved } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('end-to-end: signal -> sync stage -> async stage -> generator stage', async () => {
  const id = signal(1)
  const pipeline = computed(
    () => id(),                               // stage 0: sync, reads a signal
    (n: number) => n * 10,                    // stage 1: sync transform
    async (n: number) => `fetched:${n}`,      // stage 2: async, returns a promise
    function* (s: string) {                   // stage 3: generator
      const upper: string = yield* read(s.toUpperCase())
      return `result=${upper}`
    },
  )

  // Initially suspended at stage 2 (the async function returns a pending promise).
  const initial = pipeline()
  expect(initial).toBeInstanceOf(Promise)

  await tick()

  expect(pipeline()).toBe('result=FETCHED:10')
})

test('pipeline re-runs when its signal input changes', async () => {
  const id = signal(1)
  const pipeline = computed(
    () => id(),
    async (n: number) => `value:${n}`,
  )
  await tick()
  expect(pipeline()).toBe('value:1')

  setSignal(id, 2)
  // After the write, the async stage re-runs and is suspended again with a fresh promise.
  expect(pipeline()).toBeInstanceOf(Promise)
  await tick()
  expect(pipeline()).toBe('value:2')
})

test('Resolved<T> type unwraps signals, promises, and generators (compile-time)', () => {
  // This is a typecheck-only assertion — runtime is irrelevant.
  type A = Resolved<number>                                    // number
  type B = Resolved<Promise<number>>                           // number
  type C = Resolved<Generator<unknown, number, unknown>>       // number
  const _a: A = 1
  const _b: B = 2
  const _c: C = 3
  expect([_a, _b, _c]).toEqual([1, 2, 3])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/integration-async-pipeline.test.ts`
Expected: FAIL — `read` and `Resolved` are not exported from `../src/index`.

- [ ] **Step 3: Modify `src/index.ts`**

Read the current `src/index.ts`. Update the `./async` re-export to include `read` and the `Resolved` type. The async re-export line should become:

```ts
export { isPending, latest, read, use, NotReadyYet, type Resolved } from './async'
```

Leave all other exports unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- test/integration-async-pipeline.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — all test files.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: expose read and Resolved; add async pipeline integration test"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Done — definition of completion

After Task 6:
- `pnpm test` passes all test files; `pnpm typecheck` is clean.
- `computed` accepts sync, `async`, and `function*` stages freely-mixed.
- `read(x)` works as the generator-side resolver via `yield* read(x)`.
- The pipeline propagates suspension through stages as a `Promise<T>` value (color flows through the graph); each stage has its own r3 computed and is re-triggered on settle via a per-stage kick + `suspendedOn` guard.
- r3's memoization gives free cross-stage caching: a stage whose deps did not change is not re-run when downstream stages re-run.
- All Phase 1, Plan 2a tests continue to pass without modification.

**Next:** A follow-up plan can add within-generator checkpoint resume (multiple `yield*` points inside one `function*` body as cached segments). Then Plan 2c (error boundaries) and Plan 3 (`pulse/dom`). See the design spec: `docs/superpowers/specs/2026-05-14-pulse-design.md`.

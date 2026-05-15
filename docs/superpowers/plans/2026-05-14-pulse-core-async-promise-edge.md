# pulse/core — Async: Promise-Holding Signals & the `use` Edge (Plan 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pulse signals able to hold promises, flip to the resolved value on settle (write-back), expose the reactive `isPending` / `latest` read helpers, and add the opt-in `use()` primitive so effects can suspend on pending async and re-run when it settles.

**Architecture:** A signal may hold `T | Promise<T>`; `signal()`'s return type widens to `WritableSignal<Awaited<T> | T>` (sync values unaffected — `Awaited<T> = T`). When a promise is written into a signal, a `.then` is scheduled that writes the resolved value back via `setSignal`, guarded by a per-signal generation counter so a superseded promise can't clobber a newer value. `isPending(s)` reports whether the current value is a promise; `latest(s)` returns the most recent *resolved* value (stale-while-revalidate — `undefined` only before the first resolution). `use(x)` resolves a value synchronously — plain value passes through, settled promise yields its value, pending promise throws `NotReadyYet`. Effects wrap their body in `try/catch`: a caught `NotReadyYet` suspends the effect (it holds, runs nothing further) and registers a `.then` that re-triggers it via an internal "kick" signal once the promise settles.

**Tech Stack:** TypeScript (strict), Vitest, r3 (consumed from `../r3/src/index.ts` via build-tool alias). Builds directly on Plan 1 (`pulse/core` synchronous foundation), already implemented and committed.

**Scope note — what this plan deliberately does NOT do:** generator stages / `read` / `yield*` / the generator driver / per-stage segments / checkpoint resume (Plan 2b); error boundaries / catching genuine errors / `<Suspense>` (Plan 2c); the DOM layer (Plan 3). In this plan a *genuine error* (a rejected promise surfaced through `use`, or any non-`NotReadyYet` throw in an effect) **propagates out uncaught** — the honest, documented behaviour until Plan 2c. A rejected promise written into a signal does **not** write back (the signal keeps holding the rejected promise); `use` surfaces the rejection when that value is read.

---

## File structure

| File | Responsibility | This plan |
|------|----------------|-----------|
| `src/is-promise.ts` | The `isPromise` thenable check | **Create** (Task 1) |
| `src/async.ts` | Read-side async helpers: `isPending`, `latest`, `NotReadyYet`, `use` | **Create** (Task 1), grown in Tasks 3 & 4 |
| `src/signal.ts` | Signals + accessors + `setSignal`; gains promise-aware typing + write-back | **Modify** (Tasks 1 & 2) |
| `src/effect.ts` | Effects; gains `NotReadyYet` suspend/resume | **Modify** (Task 5) |
| `src/index.ts` | Public API barrel; gains the async exports | **Modify** (Task 6) |
| `test/async.test.ts` | `isPending` / `latest` / `use` tests | **Create** (Task 1), grown in Tasks 3 & 4 |
| `test/signal.test.ts` | Append: write-back tests | **Modify** (Task 2) |
| `test/effect.test.ts` | Append: suspension tests | **Modify** (Task 5) |
| `test/integration-async.test.ts` | End-to-end async integration test | **Create** (Task 6) |

`src/signal.ts` imports `isPromise` from `src/is-promise.ts`. `src/async.ts` imports `isPromise` from `src/is-promise.ts` and the `Signal` type from `src/signal.ts` (type-only — no runtime cycle).

---

## Task 1: `isPromise`, promise-aware signal typing, and `isPending`

**Files:**
- Create: `src/is-promise.ts`
- Create: `src/async.ts`
- Modify: `src/signal.ts` (widen `signal`'s return type only)
- Test: `test/async.test.ts`

Make `signal()` honestly typed for promise values, and add the reactive `isPending` predicate. No write-back yet (Task 2) — here a promise sits in the signal until something `setSignal`s over it.

- [ ] **Step 1: Create `src/is-promise.ts`**

```ts
/** True if `v` is a thenable — pulse treats any thenable as a promise. */
export function isPromise(v: unknown): v is Promise<unknown> {
  return (
    v != null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}
```

- [ ] **Step 2: Write the failing tests — create `test/async.test.ts`**

```ts
import { expect, test } from 'vitest'
import { isPending } from '../src/async'
import { setSignal, signal } from '../src/signal'

test('isPending is false for a signal holding a plain value', () => {
  const s = signal(0)
  expect(isPending(s)).toBe(false)
})

test('isPending is true for a signal holding a pending promise', () => {
  const s = signal(new Promise<number>(() => {}))
  expect(isPending(s)).toBe(true)
})

test('a promise-typed signal accepts its resolved value via setSignal', () => {
  // signal(Promise<number>) is WritableSignal<number | Promise<number>>,
  // so setting the resolved number must typecheck and flip isPending.
  const s = signal(Promise.resolve(1))
  expect(isPending(s)).toBe(true)
  setSignal(s, 1)
  expect(isPending(s)).toBe(false)
  expect(s()).toBe(1)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- test/async.test.ts`
Expected: FAIL — cannot find module `../src/async`.

- [ ] **Step 4: Create `src/async.ts`**

```ts
import { isPromise } from './is-promise'
import type { Signal } from './signal'

/** Reactive predicate: is the signal's current value a (pending) promise? */
export function isPending(s: Signal<unknown>): boolean {
  return isPromise(s())
}
```

- [ ] **Step 5: Modify `src/signal.ts`**

Read the current `src/signal.ts`. Change the `signal` function's **return type** (both the annotation and the cast) from `WritableSignal<T>` to `WritableSignal<Awaited<T> | T>`. The body otherwise stays as it currently is. It should read:

```ts
export function signal<T>(initial: T): WritableSignal<Awaited<T> | T> {
  return makeAccessor(r3Signal(initial)) as WritableSignal<Awaited<T> | T>
}
```

Leave everything else in `src/signal.ts` unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- test/async.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 7: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions. `signal(0)` still types as `WritableSignal<number>` (`Awaited<number> = number`), so Phase 1's `computed(() => count() * 2)` is unaffected.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add isPromise, isPending, and promise-aware signal typing"
```

---

## Task 2: Write-back for promise-holding signals

**Files:**
- Modify: `src/signal.ts` (add a generation map + `scheduleWriteBack`; wire into `signal` and `setSignal`)
- Test: `test/signal.test.ts` (append tests)

When a promise is written into a signal, schedule a `.then` that writes the resolved value back via `setSignal`, flipping the signal `Promise<T> → T`. A per-signal **generation counter** guards against a stale (superseded) promise clobbering a newer value: each `setSignal` bumps the generation; a write-back applies only if the generation it captured still matches. A *rejected* promise does not write back (happy-path only — see the plan's scope note).

- [ ] **Step 1: Write the failing tests — append to `test/signal.test.ts`**

Add this helper near the top of `test/signal.test.ts` (after the imports):

```ts
/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
```

Then add `isPending` to the imports — at the top of `test/signal.test.ts`, add an import: `import { isPending } from '../src/async'`. Then append these tests:

```ts
test('a signal created with a promise writes back the resolved value', async () => {
  const s = signal(Promise.resolve(42))
  expect(isPending(s)).toBe(true)
  await tick()
  expect(s()).toBe(42)
  expect(isPending(s)).toBe(false)
})

test('setSignal with a promise writes back on settle', async () => {
  const s = signal(0)
  setSignal(s, Promise.resolve(99))
  expect(isPending(s)).toBe(true)
  await tick()
  expect(s()).toBe(99)
})

test('a superseded promise does not write back', async () => {
  const s = signal<number | Promise<number>>(0)
  let release!: (v: number) => void
  const slow = new Promise<number>((resolve) => { release = resolve })
  setSignal(s, slow) // schedules a write-back for `slow`
  setSignal(s, 7)    // supersedes it — bumps the generation
  release(123)       // `slow` settles late
  await tick()
  expect(s()).toBe(7) // NOT 123 — the superseded write-back was skipped
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/signal.test.ts`
Expected: FAIL — the new tests fail: `s()` stays a promise (no write-back yet).

- [ ] **Step 3: Modify `src/signal.ts`**

Read the current `src/signal.ts`. Make exactly these changes:

(a) Add a module-level generation map and the `scheduleWriteBack` helper. Place this **after** the `makeAccessor` function and **before** the `signal` function:

```ts
/**
 * Per-signal generation counter. Every `setSignal` bumps it; a scheduled
 * write-back captures the generation at schedule time and applies only if it
 * still matches — so a superseded (stale) promise cannot clobber a newer value.
 */
const generation = new WeakMap<object, number>()

/**
 * If `value` is a promise, schedule its resolved value to be written back into
 * `s` once it settles — unless `s` has been re-assigned since (generation guard).
 * A rejected promise does not write back; the signal keeps holding the rejected
 * promise and `use` surfaces the rejection when the value is read.
 */
function scheduleWriteBack(s: WritableSignal<unknown>, value: unknown): void {
  if (!isPromise(value)) return
  const captured = generation.get(s) ?? 0
  value.then(
    (resolved) => {
      if ((generation.get(s) ?? 0) === captured) setSignal(s, resolved)
    },
    () => {
      // Rejected: write-back is happy-path only (error boundaries are Plan 2c).
    },
  )
}
```

(b) Add this import alongside the existing imports:

```ts
import { isPromise } from './is-promise'
```

(c) Change `signal` to schedule a write-back for its initial value:

```ts
export function signal<T>(initial: T): WritableSignal<Awaited<T> | T> {
  const s = makeAccessor(r3Signal(initial)) as WritableSignal<Awaited<T> | T>
  scheduleWriteBack(s, initial)
  return s
}
```

(d) Change `setSignal` to bump the generation and schedule a write-back:

```ts
export function setSignal<T>(s: WritableSignal<T>, value: T): void {
  generation.set(s, (generation.get(s) ?? 0) + 1)
  r3SetSignal(s[NODE] as R3Signal<T>, value)
  scheduleWriteBack(s, value)
  requestFlush()
}
```

(The recursive `setSignal` inside `scheduleWriteBack`'s `.then` is safe — the resolved value is not a promise, so the inner `scheduleWriteBack` is a no-op; it bumps the generation and requests a flush, which is exactly the desired "flip" behaviour.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/signal.test.ts`
Expected: PASS — all signal tests, including the 3 new write-back tests.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add write-back for promise-holding signals"
```

---

## Task 3: `latest` — stale-while-revalidate read

**Files:**
- Modify: `src/async.ts` (add `latest`)
- Test: `test/async.test.ts` (append tests)

`latest(s)` returns the most recent *resolved* value of a signal: `undefined` until the signal first resolves, then always the last resolved value. It does **not** revert to `undefined` while a newer promise is pending — that is the stale-while-revalidate behaviour. It is reactive (it reads `s()`), and stateful (it records each resolved value it observes, keyed on the signal).

- [ ] **Step 1: Write the failing tests — append to `test/async.test.ts`**

Add this helper near the top of `test/async.test.ts` (after the imports):

```ts
/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
```

Add `latest` to the `../src/async` import, and add imports for `effect`, the scheduler, and `setSignal` if not present:

```ts
import { isPending, latest } from '../src/async'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { setSignal, signal } from '../src/signal'
```

Then append these tests:

```ts
test('latest is undefined before the first resolution', () => {
  const s = signal(new Promise<number>(() => {})) // never resolves
  expect(latest(s)).toBeUndefined()
})

test('latest returns the resolved value after the promise settles', async () => {
  const s = signal(Promise.resolve(1))
  expect(latest(s)).toBeUndefined()
  await tick()
  expect(latest(s)).toBe(1)
})

test('latest keeps the last resolved value while a newer promise is pending', async () => {
  const s = signal<number | Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(s)).toBe(1)

  let release!: (v: number) => void
  setSignal(s, new Promise<number>((resolve) => { release = resolve }))
  expect(latest(s)).toBe(1) // still 1 — does NOT revert to undefined

  release(2)
  await tick()
  expect(latest(s)).toBe(2) // now the new resolved value
})

test('latest is reactive — updates as the signal resolves', async () => {
  setScheduler(syncScheduler(flush))
  const s = signal(Promise.resolve(1))
  const seen: Array<number | undefined> = []
  effect(() => { seen.push(latest(s)) })
  expect(seen).toEqual([undefined]) // pending — no prior resolution
  await tick()
  expect(seen).toEqual([undefined, 1]) // resolved -> effect re-ran -> latest is 1
  setScheduler(microtaskScheduler(flush))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/async.test.ts`
Expected: FAIL — `latest` is not exported from `../src/async`.

- [ ] **Step 3: Modify `src/async.ts`**

Append the `latest` helper to `src/async.ts` (the file currently contains `isPending`):

```ts
/**
 * Records the most recent resolved value observed for each signal. Keyed on the
 * signal (accessor) object — entries are garbage-collected with the signal.
 */
const lastResolved = new WeakMap<object, unknown>()

/**
 * The latest *resolved* value of a signal. Returns `undefined` until the signal
 * first resolves, then always the most recent resolved value — it does NOT
 * revert to `undefined` while a newer promise is pending (stale-while-revalidate).
 * Reactive: reads `s()`, so it re-evaluates when the signal changes.
 */
export function latest<T>(s: Signal<T>): Awaited<T> | undefined {
  const value = s()
  if (isPromise(value)) {
    return lastResolved.get(s) as Awaited<T> | undefined
  }
  lastResolved.set(s, value)
  return value as Awaited<T>
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/async.test.ts`
Expected: PASS — all async tests (the 3 `isPending` tests + the 4 new `latest` tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add latest for stale-while-revalidate reads"
```

---

## Task 4: `use` and `NotReadyYet`

**Files:**
- Modify: `src/async.ts` (add `NotReadyYet` and `use`)
- Test: `test/async.test.ts` (append tests)

`use(x)` resolves a possibly-async value *synchronously*: a plain value passes through; a promise that has already settled yields its value (or re-throws its rejection); a still-pending promise throws `NotReadyYet`. A module-level `WeakMap<Promise, state>` tracks each promise's settled state so a *later* `use` call with the same promise can resolve it synchronously.

- [ ] **Step 1: Write the failing tests — append to `test/async.test.ts`**

Add `use` and `NotReadyYet` to the `../src/async` import. Then append these tests:

```ts
test('use returns a plain (non-promise) value unchanged', () => {
  expect(use(5)).toBe(5)
  expect(use('hello')).toBe('hello')
})

test('use throws NotReadyYet for a pending promise', () => {
  const pending = new Promise<number>(() => {})
  expect(() => use(pending)).toThrow(NotReadyYet)
})

test('the thrown NotReadyYet carries the promise', () => {
  const pending = new Promise<number>(() => {})
  try {
    use(pending)
    throw new Error('use should have thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(NotReadyYet)
    expect((e as NotReadyYet).promise).toBe(pending)
  }
})

test('use resolves a promise synchronously once it has settled', async () => {
  const p = Promise.resolve(7)
  expect(() => use(p)).toThrow(NotReadyYet) // first call: still pending to use
  await tick()
  expect(use(p)).toBe(7) // settled now — use returns synchronously
})

test('use re-throws the rejection reason of a settled rejected promise', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  expect(() => use(p)).toThrow(NotReadyYet) // first call: pending
  await tick()
  expect(() => use(p)).toThrow('boom') // settled rejected: re-throws the reason
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/async.test.ts`
Expected: FAIL — `use` and `NotReadyYet` are not exported from `../src/async`.

- [ ] **Step 3: Modify `src/async.ts`**

Append `NotReadyYet`, the promise-state tracker, and `use` to `src/async.ts`:

```ts
/**
 * Thrown by `use` when a promise it depends on has not settled yet. Carries the
 * promise so the catcher (an effect) can re-run once it settles. This is NOT an
 * error — it is the opt-in suspension signal.
 */
export class NotReadyYet {
  constructor(readonly promise: Promise<unknown>) {}
}

type PromiseState =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown }

/** Tracks every promise `use` has seen, so later calls can resolve synchronously. */
const states = new WeakMap<Promise<unknown>, PromiseState>()

function track(promise: Promise<unknown>): PromiseState {
  const existing = states.get(promise)
  if (existing) return existing
  const state: PromiseState = { status: 'pending' }
  states.set(promise, state)
  promise.then(
    (value) => states.set(promise, { status: 'fulfilled', value }),
    (reason) => states.set(promise, { status: 'rejected', reason }),
  )
  return state
}

/**
 * Resolve a possibly-async value synchronously.
 * - Plain value -> returned as-is.
 * - Settled promise -> its resolved value (a settled rejection re-throws its reason).
 * - Pending promise -> throws `NotReadyYet` (caught by the nearest effect).
 *
 * Intended for use inside effects (including, later, JSX bindings). Using it
 * inside a `computed` is allowed but a code smell — the computed becomes
 * throw-on-read.
 */
export function use<T>(x: T): Awaited<T> {
  if (!isPromise(x)) return x as Awaited<T>
  const state = track(x)
  if (state.status === 'fulfilled') return state.value as Awaited<T>
  if (state.status === 'rejected') throw state.reason
  throw new NotReadyYet(x)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/async.test.ts`
Expected: PASS — all async tests (3 `isPending` + 4 `latest` + 5 `use`).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add use and NotReadyYet for opt-in async resolution"
```

---

## Task 5: Suspend effects on `NotReadyYet`

**Files:**
- Modify: `src/effect.ts` (replace entire file — wrap the effect body to catch `NotReadyYet`)
- Test: `test/effect.test.ts` (append tests)

An effect's body is wrapped in `try/catch`. A caught `NotReadyYet` **suspends** the effect: it holds (runs nothing further this pass) and registers a `.then` on the carried promise that re-triggers the effect once it settles. Re-triggering uses an internal **kick signal** the effect reads each run — settling does `setSignal(kick, …)`, marking the effect dirty so the scheduler re-runs it. Any *other* thrown value (a genuine error) is re-thrown — it propagates out uncaught for now (error boundaries are Plan 2c).

**The `suspendedOn` guard.** When the suspended-on promise came from a signal, write-back *also* re-triggers the effect (the signal changed) — so the kick would cause a redundant second re-run. To prevent that, the effect tracks `suspendedOn` (the promise it is currently suspended on, or `null`). A successful body run clears it; the kick callback only fires `setSignal(kick, …)` if `suspendedOn` still equals its promise. So whichever re-trigger lands first (write-back or kick) wins, and the other becomes a no-op.

- [ ] **Step 1: Write the failing tests — append to `test/effect.test.ts`**

Add a `use` import and a `tick` helper. The top of `test/effect.test.ts` currently imports from `../src/effect`, `../src/scheduler`, `../src/signal`. Add:

```ts
import { use } from '../src/async'
```

and, after the imports, add the helper:

```ts
/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
```

Then append these tests:

```ts
test('an effect using a pending promise suspends, then runs when it settles', async () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  let release!: (v: number) => void
  const p = new Promise<number>((resolve) => { release = resolve })
  effect(() => { seen.push(use(p)) })
  expect(seen).toEqual([]) // suspended — use threw NotReadyYet, the body held
  release(10)
  await tick()
  expect(seen).toEqual([10]) // re-ran with the resolved value
})

test('an effect re-runs when a signal it uses is set to a new promise', async () => {
  setScheduler(syncScheduler(flush))
  const s = signal<number | Promise<number>>(1)
  const seen: number[] = []
  effect(() => { seen.push(use(s())) })
  expect(seen).toEqual([1]) // s() is 1, use(1) -> 1
  setSignal(s, Promise.resolve(2))
  expect(seen).toEqual([1]) // s() is now a pending promise -> suspended
  await tick()
  expect(seen).toEqual([1, 2]) // write-back flipped s to 2 -> effect re-ran
})

test('a genuine (non-NotReadyYet) error thrown in an effect is not swallowed', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('real error') })
  }).toThrow('real error')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/effect.test.ts`
Expected: FAIL — `effect` does not catch `NotReadyYet`; the suspension tests fail.

- [ ] **Step 3: Replace `src/effect.ts` entirely with:**

```ts
import { computed as r3Computed } from 'r3'
import { NotReadyYet } from './async'
import { setSignal, signal } from './signal'

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs (after the scheduler flushes) whenever a signal it read changes.
 *
 * If the body throws `NotReadyYet` (via `use` on a pending promise), the effect
 * suspends: it holds — running nothing further this pass — and re-runs once the
 * carried promise settles. Re-running is driven by an internal "kick" signal the
 * body reads every pass; settling does `setSignal(kick, ...)`, marking the
 * effect dirty. Any other thrown value is a genuine error and is re-thrown.
 *
 * `suspendedOn` tracks the promise the effect is currently suspended on (or
 * `null`). A successful run clears it; the kick callback only fires if
 * `suspendedOn` still matches — so when the promise came from a signal,
 * write-back re-triggers the effect and the redundant kick becomes a no-op.
 */
export function effect(fn: () => void): void {
  const kick = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  const body = () => {
    kick() // depend on the kick signal so a settled promise can re-trigger this effect
    try {
      fn()
      suspendedOn = null // completed successfully — no longer suspended
    } catch (e) {
      if (e instanceof NotReadyYet) {
        suspendedOn = e.promise
        const p = e.promise
        const rerun = () => {
          if (suspendedOn === p) {
            suspendedOn = null
            setSignal(kick, ++kickCount)
          }
        }
        p.then(rerun, rerun)
        return // suspended: hold — do not run the rest of fn, do not propagate
      }
      throw e // a genuine error — propagate (error boundaries are a later plan)
    }
  }
  r3Computed(body)
}

/** Register a cleanup function for the current effect/computed. r3's, re-exported. */
export { onCleanup } from 'r3'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/effect.test.ts`
Expected: PASS — all effect tests, including the Phase 1 tests (run-once, re-run, cleanup-before-rerun) and the 3 new suspension tests.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — no regressions. (Phase 1 effects never throw `NotReadyYet`, so the `try/catch` is transparent to them; the added `kick()` read is a dependency that never changes for a non-suspending effect, so it causes no extra re-runs.)

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: suspend effects on NotReadyYet, re-run on settle"
```

---

## Task 6: Expose the async API + integration test

**Files:**
- Modify: `src/index.ts` (replace entire file)
- Test: `test/integration-async.test.ts`

Export the new async surface from the barrel and add an end-to-end test exercising a promise-holding signal flowing through an effect via `use`, under the default microtask scheduler.

- [ ] **Step 1: Write the failing integration test — create `test/integration-async.test.ts`**

```ts
import { expect, test } from 'vitest'
import { effect, isPending, latest, setSignal, signal, use } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('a promise-holding signal flows through an effect via use, and writes back', async () => {
  const user = signal(Promise.resolve({ name: 'ada' }))
  const seen: string[] = []
  effect(() => { seen.push(use(user()).name) })

  // initially suspended — the promise is pending from use's point of view
  expect(seen).toEqual([])
  expect(isPending(user)).toBe(true)

  await tick()

  // write-back flipped the signal; the effect re-ran with the resolved value
  expect(seen).toEqual(['ada'])
  expect(isPending(user)).toBe(false)
  expect(use(user())).toEqual({ name: 'ada' }) // use of a settled value is synchronous
})

test('latest gives stale-while-revalidate across a re-fetch', async () => {
  const data = signal<number | Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(data)).toBe(1)

  setSignal(data, Promise.resolve(2))
  expect(latest(data)).toBe(1) // stale value held while the new promise is pending
  await tick()
  expect(latest(data)).toBe(2)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/integration-async.test.ts`
Expected: FAIL — `use`, `isPending`, `latest` are not exported from `../src/index`.

- [ ] **Step 3: Replace `src/index.ts` entirely with:**

```ts
export { isPending, latest, use, NotReadyYet } from './async'
export { computed } from './computed'
export { effect, onCleanup } from './effect'
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- test/integration-async.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm test`
Expected: PASS — all test files pass (`smoke`, `signal`, `computed`, `scheduler`, `effect`, `integration`, `async`, `integration-async`).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: expose async API and add async integration test"
```

---

## Done — definition of completion

After Task 6:
- `pnpm test` passes all test files; `pnpm typecheck` is clean.
- pulse signals can hold promises (`signal()` typed `WritableSignal<Awaited<T> | T>`), flip to the resolved value on settle (write-back, generation-guarded), report pending-ness reactively via `isPending`, and expose the last resolved value via `latest` (stale-while-revalidate).
- `use(x)` + `NotReadyYet` provide opt-in synchronous resolution; effects suspend on a pending `use` and re-run when it settles.
- Phase 1's synchronous behaviour is fully preserved.

**Next:** Plan 2b (`pulse/core` — generator stages & checkpoint resume): `computed` gains `function*` stages, `read`/`yield*`, the generator driver, per-stage segments, and checkpoint resume. Then Plan 2c (error boundaries). See the design spec: `docs/superpowers/specs/2026-05-14-pulse-design.md`.

# Speculation Engine — Plan 7: `Awaitable` foundation + signal-side migration

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD, checkbox steps.

**Goal:** Introduce the `Awaitable<T>` type and migrate the **signal-side** read model to it per [ADR 0011](../../adr/0011-uniform-awaitable-adapter-migration.md): a signal written a promise returns an `Awaitable` (carrying `status`/`value`/`reason`, SWR prior seeded in `value`), and `track`/`latest`/`use`/`isPending` read that object. Behavior-preserving — the existing async/signal suite stays green.

**Architecture:** Per ADR 0011 (adapter). `Awaitable<T>` is a `Promise<T>` with `status`/`value`/`reason` attached, created by `toAwaitable(source, prior?)`. `track()` becomes Awaitable-aware (returns the object's live state). The `signal()` setter wraps a written promise via `toAwaitable`, **seeding the prior from the node's current value** (the setter's SWR path — distinct from `computed.ts`'s `lastResolvedValue`, which does not exist here; see ADR 0011). `latest` becomes the compat shim. **`computed.ts`'s `makeStageNode` is NOT touched here** — its rework (view = `Awaitable`, retire `publishedValue`/`lastResolvedValue`) is Plan 7b. During Plan 7, signals produce `Awaitable`s while computeds still produce old-style values; the read primitives handle both (ADR 0011's anticipated "transient two-home window"), converging in 7b.

**Tech Stack:** TypeScript, vitest (`pnpm test`), r3, the scope overlay.

**Behavior baseline:** run `pnpm test` first and record the count (expect **291 passing / 1 skipped**). Every signal/async test must stay green.

---

## File structure

- **Create: `src/awaitable.ts`** — the `Awaitable` type + `toAwaitable`.
- **Modify: `src/async.ts`** — `track` Awaitable-aware; `latest` compat shim.
- **Modify: `src/signal.ts`** — setter wraps promise writes via `toAwaitable`, seeded from the current node value.
- **Create: `test/awaitable.test.ts`** — the `Awaitable` unit tests.
- **Modify: `test/signal.test.ts`** — extend the promise-value test to assert `Awaitable` faces.

`computed.ts` is untouched.

---

## Task 1: The `Awaitable` type + `toAwaitable`

**Files:** Create `src/awaitable.ts`; Create `test/awaitable.test.ts`.

- [ ] **Step 1: Failing test** (`test/awaitable.test.ts`):

```ts
import { expect, test } from 'vitest'
import { Awaitable, toAwaitable } from '../src/awaitable'

const tick = () => new Promise<void>((r) => setTimeout(r))

test('an Awaitable is a Promise carrying status/value/reason', async () => {
  const a = toAwaitable(Promise.resolve(42))
  expect(a).toBeInstanceOf(Promise)
  expect(a.status).toBe('pending')
  expect(a.value).toBeUndefined()
  await tick()
  expect(a.status).toBe('fulfilled')
  expect(a.value).toBe(42)
  expect(await a).toBe(42)
})

test('a pending Awaitable is seeded with the prior value (SWR)', () => {
  const a = toAwaitable(new Promise(() => {}), /* prior */ 7)
  expect(a.status).toBe('pending')
  expect(a.value).toBe(7) // stale-while-revalidate: prior visible while pending
})

test('a rejected Awaitable records the reason', async () => {
  const a = toAwaitable(Promise.reject(new Error('x')))
  a.catch(() => {}) // avoid unhandled rejection
  await tick()
  expect(a.status).toBe('rejected')
  expect(a.reason).toBeInstanceOf(Error)
})
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm exec vitest run test/awaitable.test.ts`; module missing).

- [ ] **Step 3: Implement** (`src/awaitable.ts`):

```ts
/** A `Promise<T>` carrying synchronous inspection fields. Per ADR 0011 /
 *  async-reads-and-coordination.md: `s()` async reads return one of these
 *  uniformly (no write-back). `.value` is the stale-while-revalidate read
 *  (seeded with the prior while pending); `.status` disambiguates. */
export interface Awaitable<T> extends Promise<T> {
  status: 'pending' | 'fulfilled' | 'rejected'
  value: T | undefined
  reason: unknown
}

/** Wrap a source promise as an `Awaitable`, seeding `.value` with `prior` for
 *  stale-while-revalidate. Does not mutate `source` (chains a fresh promise). */
export function toAwaitable<T>(source: Promise<T>, prior?: T): Awaitable<T> {
  const a = source.then((v) => v) as Awaitable<T>
  a.status = 'pending'
  a.value = prior
  a.reason = undefined
  a.then(
    (v) => {
      a.status = 'fulfilled'
      a.value = v
    },
    (e) => {
      a.status = 'rejected'
      a.reason = e
    },
  )
  return a
}
```

- [ ] **Step 4: Run — expect PASS.** If Promise-subclass/chaining mechanics misbehave (e.g. `a.then` timing), the tests will show it — adjust the wrap so `.status`/`.value` update on settle while `a` remains a real awaitable. Do not weaken the tests.

- [ ] **Step 5: Commit** — `git commit -m "feat(awaitable): Awaitable type + toAwaitable (status/value/reason, SWR seed)"`

---

## Task 2: `track` is Awaitable-aware

**Files:** Modify `src/async.ts`; Test `test/awaitable.test.ts`.

- [ ] **Step 1: Failing test** (append to `test/awaitable.test.ts`):

```ts
import { track } from '../src/async'

test('track returns an Awaitable\'s own live state', async () => {
  const a = toAwaitable(Promise.resolve(1))
  const state = track(a)
  expect(state.status).toBe('pending')
  await tick()
  // reading the Awaitable's fields reflects the settled state
  expect(track(a).status).toBe('fulfilled')
  expect(track(a).value).toBe(1)
})
```

- [ ] **Step 2: Run — expect FAIL** (track wraps in its own WeakMap state, which is a snapshot that may not reflect `a`'s live fields identically — or the assertion on the returned object's `value` fails).

- [ ] **Step 3: Implement.** In `src/async.ts`, import `Awaitable`, and short-circuit `track` for `Awaitable`s (return the object itself — it already carries live `status`/`value`/`reason`):

```ts
import { Awaitable } from './awaitable'
// ...
export function track(promise: Promise<unknown>): PromiseState {
  if (promise instanceof Awaitable) return promise as unknown as PromiseState
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
```

Note: `Awaitable` is an interface, not a class, so `instanceof Awaitable` won't work as written. Use a brand check instead — add a non-enumerable brand in `toAwaitable` (`;(a as any).__awaitable = true`) and test `('status' in promise && (promise as any).__awaitable === true)`, OR make `Awaitable` a real class. **Decide in Task 1:** the simplest robust choice is a brand symbol. If you brand, define `export const AWAITABLE = Symbol('awaitable')`, set it in `toAwaitable`, and check `AWAITABLE in promise` here. Update Task 1's impl to set the brand.

- [ ] **Step 4: Run — expect PASS.** Then `pnpm test` — full suite still green.

- [ ] **Step 5: Commit** — `git commit -m "feat(async): track is Awaitable-aware (returns the object's live state)"`

---

## Task 3: `signal()` setter wraps promise writes as `Awaitable` (SWR-seeded)

**Files:** Modify `src/signal.ts`; Modify `test/signal.test.ts`.

- [ ] **Step 1: Failing test** (append to `test/signal.test.ts`):

```ts
import { Awaitable } from '../src/awaitable'

test('a signal written a promise reads back as an Awaitable (no write-back)', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  setS(Promise.resolve(42))
  const v = s()
  expect(v).toBeInstanceOf(Promise) // Awaitable is a Promise
  expect((v as Awaitable<number>).status).toBe('pending')
  await tick()
  expect((s() as Awaitable<number>).status).toBe('fulfilled')
  expect((s() as Awaitable<number>).value).toBe(42)
})

test('SWR: while a refetch is pending the prior resolved value stays in .value', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  setS(Promise.resolve(1))
  await tick()
  setS(new Promise(() => {})) // never settles
  const v = s() as Awaitable<number>
  expect(v.status).toBe('pending')
  expect(v.value).toBe(1) // prior held (seeded from the current node value)
})
```

- [ ] **Step 2: Run — expect FAIL** (`s()` returns a raw Promise without `.status`; SWR prior not seeded).

- [ ] **Step 3: Implement.** In `src/signal.ts`, import `toAwaitable` + `Awaitable`, and in the setter wrap promise writes, seeding the prior from the node's current value:

```ts
import { toAwaitable, Awaitable } from './awaitable'
// ...
  const setter: Setter<T> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: T) => T)(untrack(() => readValue(node)))
        : next
    let toWrite: T = value
    if (isPromise(value)) {
      // SWR: seed the prior from the node's current value (ADR 0011 — the
      // setter has no lastResolvedValue closure; the prior is the current value).
      const cur = untrack(() => readValue(node)) as unknown
      const prior = cur instanceof Promise ? (cur as Awaitable<unknown>).value : cur
      toWrite = toAwaitable(value as Promise<unknown>, prior) as unknown as T
    }
    writeValue(node, toWrite)
    requestFlush()
  }
```

The `if (isPromise(initial)) track(initial)` at signal creation can stay, OR wrap `initial` too if it is a promise — for consistency, wrap the initial value the same way. (If the initial-wrap changes a test, that test asserted a raw-promise initial; update it to expect an `Awaitable`, since that is the intended new behavior — but confirm it is genuinely the initial-promise case, not an unrelated regression.)

- [ ] **Step 4: Run — expect PASS.** Then `pnpm test`.

**Triage:** the existing `test/signal.test.ts` "stores a Promise as-is" test asserts `s()` is `instanceof Promise` and `await s()` resolves — both hold for an `Awaitable`. If it fails, check the wrap preserves awaitability. Do not weaken existing tests; if a genuine behavioral difference surfaces, report BLOCKED.

- [ ] **Step 5: Commit** — `git commit -m "feat(signal): setter wraps promise writes as SWR-seeded Awaitable"`

---

## Task 4: `latest` compat shim + full-suite guard

**Files:** Modify `src/async.ts`; Test via the full suite.

- [ ] **Step 1: Failing test** (append to `test/awaitable.test.ts`):

```ts
import { latest } from '../src/async'
import { signal } from '../src/signal'

test('latest reads .value for an Awaitable and falls through for a sync value', async () => {
  const [n] = signal(5)
  expect(latest(n)).toBe(5) // sync value — fall through (NOT (5).value === undefined)
  const [s, setS] = signal<number | Promise<number>>(0)
  setS(Promise.resolve(9))
  await tick()
  expect(latest(s)).toBe(9) // Awaitable — reads .value
})
```

- [ ] **Step 2: Run — expect FAIL** if the current `latest` doesn't handle the Awaitable's `.value` path cleanly (it goes through `track` + `lastResolved`; with an Awaitable it should read `.value`).

- [ ] **Step 3: Implement.** Make `latest` prefer the `Awaitable` `.value` (the compat shim from ADR 0011), keeping the existing raw-promise path for computeds not yet migrated:

```ts
export function latest<T>(s: Accessor<T>): Awaited<T> | undefined {
  const value = s()
  if (value instanceof Promise) {
    const state = track(value as Promise<unknown>) // Awaitable-aware (Task 2)
    if (state.status === 'fulfilled') {
      lastResolved.set(s, state.value)
      return state.value as Awaited<T>
    }
    // pending: prefer the Awaitable's SWR .value, else the lastResolved cache
    const swr = (value as { value?: unknown }).value
    if (swr !== undefined) return swr as Awaited<T>
    return lastResolved.get(s) as Awaited<T> | undefined
  }
  lastResolved.set(s, value)
  return value as Awaited<T>
}
```

- [ ] **Step 4: Run — expect PASS.** Then the full guard:

Run: `pnpm test`
Expected: baseline (291/1) + the new awaitable/signal tests, all green. `use`/`isPending`/`promiseOf` work unchanged because they route through the now-Awaitable-aware `track` and the `instanceof Promise` fallback. If any existing async/pending test is red, triage per ADR 0011 (the two-home window: computeds still produce old-style values — the primitives must handle both); report BLOCKED on a genuine behavioral difference, do not weaken tests.

- [ ] **Step 5: Commit** — `git commit -m "feat(async): latest compat shim over Awaitable.value; signal-side read model migrated"`

---

## Self-review

**Spec coverage (ADR 0011, signal-side):** `Awaitable` + `toAwaitable` (status/value/reason, SWR seed) → Task 1; `track` Awaitable-aware → Task 2; signal setter wraps + SWR-seeds from the current node value → Task 3; `latest` compat shim (`.value` for Awaitable, fall-through for sync) → Task 4. `use`/`isPending`/`promiseOf` are covered transitively (they route through `track` + the `instanceof Promise` fallback).

**Deliberately out of scope (→ Plan 7b, then 8):** `computed.ts` `makeStageNode` rework (view = `Awaitable`, retire `publishedValue`/`lastResolvedValue`); retiring the `states`/`lastResolved` WeakMaps (they stay during the two-home window for not-yet-migrated computeds); the `committed` isolation read (Plan 8, it is isolation-axis not readiness); speculation in computeds (Plan 8). Keeping `computed.ts` untouched is why the full-suite gate is meaningful.

**Placeholder scan:** none — real code + tests + commands. Task 2 flags a real implementation decision (brand vs class for the `instanceof`/`in` check) and resolves it (brand symbol) — a genuine decision, not a placeholder; Task 1's impl must set the brand accordingly.

**Type consistency:** `Awaitable<T>`, `toAwaitable(source, prior?)`, `track` (now Awaitable-aware), `latest` (shim) used consistently. The `signal()` setter change composes with Plan 5's `writeValue` routing (the wrapped value is just the value written — orthogonal to scope; committed → `r3SetSignal(backing, awaitable)`, speculative → a slot holding the awaitable).

**Known transient state (per ADR 0011):** at the end of Plan 7, signals produce `Awaitable`s but computeds still produce old-style values. This is the anticipated two-home window; the read primitives handle both, and Plan 7b closes it by migrating `computed.ts` and retiring the old WeakMaps. This plan must not be mistaken for the *complete* migration.

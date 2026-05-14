# pulse/core — Synchronous Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working synchronous reactive runtime for pulse on top of unmodified r3 — signals with accessors, multi-stage sync pipeline computeds, an injectable scheduler, and effects.

**Architecture:** pulse wraps r3's primitives (`signal`/`computed`/`read`/`setSignal`/`stabilize`/`onCleanup`) without modifying r3. A pulse signal/computed is an *accessor function* carrying a hidden reference to its r3 node. Reads are always synchronously correct (pull-on-read): inside an r3 context, r3's own `read` pulls; at top level, the accessor calls `stabilize()` first. Writes (`setSignal`) request a flush from a single injectable scheduler, which calls `stabilize()` to recompute the dirty graph and re-run effects. Effects are r3 computeds whose value is unused — leaves the scheduler drives.

**Tech Stack:** TypeScript (strict), Vitest, r3 (consumed from `../r3/src/index.ts` via a build-tool alias — no published package, no r3 build needed). Package manager: pnpm.

**Scope note — what this plan deliberately does NOT do (deferred to Plan 2 "async"):** promise-holding signal values, generator stages, `read`/`yield*`, `use`/`NotReadyYet`, write-back, per-stage dependency sets, checkpoint resume, error boundaries. In this plan every pipeline runs all its stages inside *one* r3 computed with *one* combined dependency set — correct for sync (a sync recompute reruns the whole function anyway), and replaced by per-stage segments when async arrives. Ownership/disposal of effects (`createRoot`) is also deferred to Plan 3 (`pulse/dom`).

---

## File structure

| File | Responsibility |
|------|----------------|
| `package.json` | Package manifest, scripts, devDependencies |
| `tsconfig.json` | TypeScript config, `r3` path alias for typechecking |
| `vitest.config.ts` | Vitest config, `r3` alias to r3's source |
| `.gitignore` | Ignore `node_modules`, `dist` |
| `src/signal.ts` | `Signal<T>` type, `NODE` symbol, `makeAccessor`, `signal`, `setSignal` |
| `src/computed.ts` | `computed` — multi-stage synchronous pipeline |
| `src/scheduler.ts` | `Scheduler` interface, `microtaskScheduler`, `syncScheduler`, `flush`, `setScheduler`, `requestFlush` |
| `src/effect.ts` | `effect`, re-exported `onCleanup` |
| `src/index.ts` | Public API barrel |
| `test/*.test.ts` | One test file per source module + one integration test |

---

## Task 1: Scaffold the package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Test: `test/smoke.test.ts`

- [ ] **Step 1: Initialise git**

Run: `git init`
Expected: `Initialized empty Git repository in .../pulse/.git/`

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "pulse",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsdown --dts src/index.ts"
  },
  "devDependencies": {
    "tsdown": "^0.11.1",
    "typescript": "^5.8.3",
    "vitest": "^3.1.3"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "r3": ["../r3/src/index.ts"]
    }
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      r3: resolve(here, '../r3/src/index.ts'),
    },
  },
})
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
dist
```

- [ ] **Step 6: Create `src/index.ts` as an empty barrel**

```ts
export {}
```

- [ ] **Step 7: Write the smoke test**

Create `test/smoke.test.ts`:

```ts
import { expect, test } from 'vitest'
import { signal, setSignal } from 'r3'

test('r3 is importable and functional from pulse', () => {
  const s = signal(1)
  expect(s.value).toBe(1)
  setSignal(s, 2)
  expect(s.value).toBe(2)
})
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`
Expected: completes without error; `node_modules` created. (r3 is NOT installed as a dependency — it is resolved from source via the alias in `vitest.config.ts` and the `paths` entry in `tsconfig.json`.)

- [ ] **Step 9: Run the smoke test to verify it passes**

Run: `pnpm test`
Expected: PASS — `test/smoke.test.ts` 1 passed.

- [ ] **Step 10: Verify typechecking works**

Run: `pnpm typecheck`
Expected: completes with no errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold pulse package with r3 source alias"
```

---

## Task 2: `signal`, the accessor, and `setSignal`

**Files:**
- Create: `src/signal.ts`
- Test: `test/signal.test.ts`

A pulse signal is an **accessor function** `() => T` carrying a hidden reference (under the `NODE` symbol) to its underlying r3 node. The accessor is **pull-on-read correct**: inside an r3 context it delegates to r3's `read` (which tracks the dependency and pulls computeds up to date); at top level (no context) it calls `stabilize()` first so the value is never stale. `setSignal` writes through to r3.

> Note: `setSignal` does NOT yet request a scheduler flush — that wiring is added in Task 5. Here it only writes.

- [ ] **Step 1: Write the failing test**

Create `test/signal.test.ts`:

```ts
import { expect, test } from 'vitest'
import { signal, setSignal } from '../src/signal'

test('signal holds an initial value', () => {
  const count = signal(0)
  expect(count()).toBe(0)
})

test('setSignal updates the value, accessor reflects it', () => {
  const count = signal(0)
  setSignal(count, 5)
  expect(count()).toBe(5)
})

test('signal works with non-number values', () => {
  const name = signal('alice')
  expect(name()).toBe('alice')
  setSignal(name, 'bob')
  expect(name()).toBe('bob')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/signal.test.ts`
Expected: FAIL — cannot find module `../src/signal`.

- [ ] **Step 3: Write `src/signal.ts`**

```ts
import {
  getContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  type Computed as R3Computed,
  type Signal as R3Signal,
} from 'r3'

/** The underlying r3 node behind any pulse signal or computed accessor. */
type R3Node<T> = R3Signal<T> | R3Computed<T>

/** Internal key under which a pulse accessor stashes its r3 node. */
export const NODE = Symbol('pulse.node')

/** A pulse signal or computed: an accessor function carrying its r3 node. */
export interface Signal<T> {
  (): T
  [NODE]: R3Node<T>
}

/**
 * Wrap an r3 node in a pull-on-read accessor.
 * - Inside an r3 context: delegate to r3's `read` (tracks the dep, pulls computeds).
 * - At top level: `stabilize()` first so the value is never stale, then read.
 */
export function makeAccessor<T>(node: R3Node<T>): Signal<T> {
  const accessor = (() => {
    if (getContext()) return r3Read(node)
    stabilize()
    return node.value
  }) as Signal<T>
  accessor[NODE] = node
  return accessor
}

/** Create a writable reactive signal. */
export function signal<T>(initial: T): Signal<T> {
  return makeAccessor(r3Signal(initial))
}

/** Write a new value into a signal. */
export function setSignal<T>(s: Signal<T>, value: T): void {
  r3SetSignal(s[NODE], value)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- test/signal.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add signal, accessor, and setSignal"
```

---

## Task 3: `computed` — single synchronous function

**Files:**
- Create: `src/computed.ts`
- Test: `test/computed.test.ts`

The first form of `computed` takes a single function and wraps an r3 computed in a pull-on-read accessor. Task 4 generalises this to a multi-stage pipeline; this task establishes the single-stage case and its test.

- [ ] **Step 1: Write the failing test**

Create `test/computed.test.ts`:

```ts
import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal, setSignal } from '../src/signal'

test('computed derives an initial value from a signal', () => {
  const count = signal(2)
  const doubled = computed(() => count() * 2)
  expect(doubled()).toBe(4)
})

test('computed is pull-on-read correct after a write', () => {
  const count = signal(2)
  const doubled = computed(() => count() * 2)
  setSignal(count, 3)
  expect(doubled()).toBe(6)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/computed.test.ts`
Expected: FAIL — cannot find module `../src/computed`.

- [ ] **Step 3: Write `src/computed.ts`**

```ts
import { computed as r3Computed } from 'r3'
import { makeAccessor, type Signal } from './signal'

/** Create a derived signal from a single computation function. */
export function computed<T>(fn: () => T): Signal<T> {
  return makeAccessor(r3Computed(fn))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- test/computed.test.ts`
Expected: PASS — 2 passed.

Why "pull-on-read correct after a write" passes with no scheduler yet: `setSignal` calls r3's `setSignal`, which inserts `doubled`'s r3 node into the dirty heap. The top-level `doubled()` accessor (no context) calls `stabilize()`, which drains the heap and recomputes `doubled` before the accessor returns `node.value`.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add single-function computed"
```

---

## Task 4: `computed` — multi-stage synchronous pipeline

**Files:**
- Modify: `src/computed.ts` (replace entire file)
- Test: `test/computed.test.ts` (add tests)

Generalise `computed` to a **pipeline of stages**: `computed(stage0, stage1, ...)`. The runtime threads a value through — stage N receives stage N-1's return value; stage 0 receives nothing. All stages run inside one r3 computed (one combined dependency set — see the scope note at the top of this plan). Typed via overloads for 1–5 stages plus a permissive implementation signature.

- [ ] **Step 1: Add failing tests**

Append to `test/computed.test.ts`:

```ts
test('computed threads a value through a multi-stage pipeline', () => {
  const n = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
    (v) => `value: ${v}`,
  )
  expect(result()).toBe('value: 8')
})

test('multi-stage pipeline recomputes on dependency change', () => {
  const n = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
  )
  expect(result()).toBe(8)
  setSignal(n, 9)
  expect(result()).toBe(20)
})

test('a stage in the middle of the pipeline may also read signals', () => {
  const base = signal(10)
  const factor = signal(2)
  const result = computed(
    () => base(),
    (v) => v * factor(),
  )
  expect(result()).toBe(20)
  setSignal(factor, 3)
  expect(result()).toBe(30)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- test/computed.test.ts`
Expected: FAIL — `computed` accepts only one argument; the three-stage and middle-stage calls are type errors / produce wrong results.

- [ ] **Step 3: Replace `src/computed.ts`**

```ts
import { computed as r3Computed } from 'r3'
import { makeAccessor, type Signal } from './signal'

/** A pipeline stage: receives the previous stage's value, returns the next. */
type Stage<In, Out> = (value: In) => Out

// Overloads: stage 0 takes no input; stage N takes stage N-1's return type.
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

/** Create a derived signal from a pipeline of one or more stages. */
export function computed(...stages: Array<(value: unknown) => unknown>): Signal<unknown> {
  return makeAccessor(
    r3Computed(() => {
      let value: unknown = undefined
      for (let i = 0; i < stages.length; i++) {
        value = stages[i](value)
      }
      return value
    }),
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/computed.test.ts`
Expected: PASS — 5 passed (2 from Task 3 + 3 new).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors. The three-stage `result` is inferred as `Signal<string>`; the two-stage `result` as `Signal<number>`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: generalise computed to a multi-stage sync pipeline"
```

---

## Task 5: The injectable scheduler

**Files:**
- Create: `src/scheduler.ts`
- Modify: `src/signal.ts` (wire `setSignal` to request a flush)
- Test: `test/scheduler.test.ts`

The scheduler is the single, injectable mechanism that flushes the reactive graph. A `Scheduler` exposes `request()`; the canonical flush function is `flush` (which calls r3's `stabilize`). The default `microtaskScheduler` batches all `request()` calls in a tick into one flush. `syncScheduler` flushes immediately (for tests). `setScheduler` swaps the active scheduler; `requestFlush` is called by writers. `setSignal` is updated to call `requestFlush()` after writing.

> The scheduler factories take the flush function as a parameter so tests can inject a spy; the core wires `flush` (= `stabilize`).

- [ ] **Step 1: Write the failing test**

Create `test/scheduler.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  flush,
  microtaskScheduler,
  setScheduler,
  syncScheduler,
  type FlushFn,
} from '../src/scheduler'
import { signal, setSignal } from '../src/signal'

test('syncScheduler flushes immediately on request', () => {
  let flushes = 0
  const flush: FlushFn = () => { flushes++ }
  const sched = syncScheduler(flush)
  sched.request()
  expect(flushes).toBe(1)
  sched.request()
  expect(flushes).toBe(2)
})

test('microtaskScheduler batches requests into a single flush', async () => {
  let flushes = 0
  const flush: FlushFn = () => { flushes++ }
  const sched = microtaskScheduler(flush)
  sched.request()
  sched.request()
  sched.request()
  expect(flushes).toBe(0) // batched — not flushed synchronously
  await Promise.resolve() // let the microtask run
  expect(flushes).toBe(1) // exactly one flush for the batch
})

test('setSignal requests a flush from the active scheduler', () => {
  let requests = 0
  setScheduler({ request: () => { requests++ } })
  const s = signal(0)
  setSignal(s, 1)
  expect(requests).toBe(1)
  // restore the default so other test files are unaffected
  setScheduler(microtaskScheduler(flush))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/scheduler.test.ts`
Expected: FAIL — cannot find module `../src/scheduler`.

- [ ] **Step 3: Write `src/scheduler.ts`**

```ts
import { stabilize } from 'r3'

/** A scheduler decides when the reactive graph is flushed. */
export interface Scheduler {
  /** Request a flush. Called after every write. */
  request(): void
}

/** The function a scheduler calls to actually flush the graph. */
export type FlushFn = () => void

/** The canonical flush: drain r3's dirty heap (recompute computeds, run effects). */
export const flush: FlushFn = () => stabilize()

/** Batches all requests in a tick into one flush on a microtask. The default. */
export function microtaskScheduler(flushFn: FlushFn): Scheduler {
  let queued = false
  return {
    request() {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        flushFn()
      })
    },
  }
}

/** Flushes synchronously on every request. Useful in tests. */
export function syncScheduler(flushFn: FlushFn): Scheduler {
  return { request: flushFn }
}

let current: Scheduler = microtaskScheduler(flush)

/** Swap the active scheduler. */
export function setScheduler(scheduler: Scheduler): void {
  current = scheduler
}

/** Ask the active scheduler to flush. Called by writers. */
export function requestFlush(): void {
  current.request()
}
```

- [ ] **Step 4: Wire `setSignal` to the scheduler — modify `src/signal.ts`**

Add this import near the top of `src/signal.ts`:

```ts
import { requestFlush } from './scheduler'
```

Replace the `setSignal` function in `src/signal.ts` with:

```ts
/** Write a new value into a signal and request a scheduler flush. */
export function setSignal<T>(s: Signal<T>, value: T): void {
  r3SetSignal(s[NODE], value)
  requestFlush()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- test/scheduler.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS — all files (`smoke`, `signal`, `computed`, `scheduler`) pass.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add injectable scheduler, wire setSignal to request flushes"
```

---

## Task 6: `effect` and `onCleanup`

**Files:**
- Create: `src/effect.ts`
- Test: `test/effect.test.ts`

An **effect** is a value-less leaf the scheduler drives. It is implemented as an r3 computed: created with no context, it runs once immediately; on a dependency change, r3's `setSignal` inserts it into the dirty heap and the scheduler's `flush` (`stabilize`) re-runs it. `onCleanup` is r3's, re-exported unchanged — r3's `recompute` runs disposers before re-running a node, so cleanup-before-rerun works for free.

- [ ] **Step 1: Write the failing test**

Create `test/effect.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { effect, onCleanup } from '../src/effect'
import {
  flush,
  microtaskScheduler,
  setScheduler,
  syncScheduler,
} from '../src/scheduler'
import { signal, setSignal } from '../src/signal'

// These tests use the synchronous scheduler so writes flush immediately.
afterEach(() => setScheduler(microtaskScheduler(flush)))

test('effect runs once immediately on creation', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const count = signal(0)
  effect(() => { seen.push(count()) })
  expect(seen).toEqual([0])
})

test('effect re-runs when a dependency changes', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const count = signal(0)
  effect(() => { seen.push(count()) })
  setSignal(count, 1)
  setSignal(count, 2)
  expect(seen).toEqual([0, 1, 2])
})

test('onCleanup runs before an effect re-runs', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const count = signal(0)
  effect(() => {
    const c = count()
    log.push(`run ${c}`)
    onCleanup(() => log.push(`cleanup ${c}`))
  })
  expect(log).toEqual(['run 0'])
  setSignal(count, 1)
  expect(log).toEqual(['run 0', 'cleanup 0', 'run 1'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/effect.test.ts`
Expected: FAIL — cannot find module `../src/effect`.

- [ ] **Step 3: Write `src/effect.ts`**

```ts
import { computed as r3Computed } from 'r3'

/**
 * Run a side-effecting function reactively. It runs once immediately, and
 * re-runs (after the scheduler flushes) whenever a signal it read changes.
 *
 * Implemented as an r3 computed whose return value is unused — the scheduler's
 * `flush` (stabilize) re-runs it when r3 marks it dirty.
 */
export function effect(fn: () => void): void {
  r3Computed(fn)
}

/** Register a cleanup function for the current effect/computed. r3's, re-exported. */
export { onCleanup } from 'r3'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- test/effect.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS — all files pass.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add effect and re-export onCleanup"
```

---

## Task 7: Public API barrel and integration test

**Files:**
- Modify: `src/index.ts` (replace entire file)
- Test: `test/integration.test.ts`

Expose the public API from `src/index.ts`, and add an integration test exercising signals + a multi-stage pipeline computed + an effect together under the default (microtask) scheduler.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration.test.ts`:

```ts
import { expect, test } from 'vitest'
import { computed, effect, setSignal, signal } from '../src/index'

test('signals, pipeline computeds, and effects work together', async () => {
  const price = signal(10)
  const qty = signal(2)

  const total = computed(
    () => price() * qty(),
    (subtotal) => subtotal * 1.1, // +10% tax
  )

  const log: number[] = []
  effect(() => { log.push(total()) })

  // effect ran once on creation: (10 * 2) * 1.1 = 22
  expect(log).toEqual([22])

  setSignal(qty, 5)
  // default scheduler is microtask-batched: effect has NOT re-run yet
  expect(log).toEqual([22])

  await Promise.resolve() // let the microtask scheduler flush
  // now the effect has re-run once: (10 * 5) * 1.1 = 55
  expect(log).toEqual([22, 55])
})

test('pull-on-read returns a fresh value before the scheduler flushes', () => {
  const n = signal(1)
  const doubled = computed(() => n() * 2)
  setSignal(n, 21)
  // no await — pull-on-read recomputes synchronously on read
  expect(doubled()).toBe(42)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- test/integration.test.ts`
Expected: FAIL — `src/index.ts` exports nothing; `computed`, `effect`, `setSignal`, `signal` are not found.

- [ ] **Step 3: Replace `src/index.ts`**

```ts
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
export { setSignal, signal, type Signal } from './signal'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- test/integration.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS — all 6 test files pass (`smoke`, `signal`, `computed`, `scheduler`, `effect`, `integration`).

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: expose pulse/core public API barrel"
```

---

## Done — definition of completion

After Task 7:
- `pnpm test` passes all six test files.
- `pnpm typecheck` is clean.
- pulse/core exposes a working synchronous reactive runtime: `signal` / `setSignal`, multi-stage pipeline `computed`, an injectable `Scheduler` (`microtaskScheduler` default, `syncScheduler` for tests), and `effect` / `onCleanup` — all on top of unmodified r3.

**Next:** Plan 2 (`pulse/core` — async) adds promise-holding signal values, generator stages, `read`/`yield*`, `use`/`NotReadyYet`, write-back, per-stage segments, checkpoint resume, and error boundaries. See the design spec: `docs/superpowers/specs/2026-05-14-pulse-design.md`.

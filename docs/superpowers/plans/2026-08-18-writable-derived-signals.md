# Writable Derived Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a derivation a setter — `signal(fn)` returns `[accessor, setter]`, and a write cancels whatever run of the derivation is outstanding.

**Architecture:** The setter is built by the pipeline builder rather than by a stage, so it reaches every stage. It writes the tail stage's published value, which is an ordinary scope-aware signal write, and cancels every stage's outstanding run. Cancelling covers three states — executing, paused on a promise, and queued but not yet started — the third of which needs the reactive core to expose a way to withdraw a queued recomputation. Inside an action, only the value lands; every consequence that touches state which is not scope-aware waits until the value reaches the committed world.

**Tech Stack:** TypeScript, vitest, pnpm. Two repositories: `pulse` (this one) and its pinned fork of `r3` at `/Users/bigmistqke/Documents/GitHub/r3`.

**Spec:** [`docs/superpowers/specs/2026-08-18-writable-derived-signals-design.md`](../specs/2026-08-18-writable-derived-signals-design.md)

**Scenarios:** [`docs/pulse/scenarios.md`](../../pulse/scenarios.md#w-writes-into-derivations-signalfn), group W. Every task names the scenarios it covers. All twenty-two are covered by the end of Task 10.

## Global Constraints

- Package manager is **pnpm**. Never `npm` or `npx`. Tests run with `pnpm test` (which is `vitest run`), types with `pnpm typecheck`.
- In the `r3` repository, tests run with `pnpm vitest run` — its `test` script is watch mode.
- `r3` source style is double quotes and semicolons. `pulse` source style is single quotes and no semicolons. Match the file you are editing.
- Never add co-author or generated-by trailers to commit messages.
- Commit messages are standalone documentation: plain language, no abbreviations, no references that need outside context. Describe what the change does and why.
- pulse pins r3 by commit: `"r3": "github:bigmistqke/r3#<sha>"` in `package.json`. Changing r3 means committing there, pushing, and updating the pin.
- Prose in documentation files under `docs/` is not hard-wrapped. One paragraph is one line.
- Do not implement `cancel(x)` or the stage parameter object. Both are tracked in `docs/follow-ups.md` and ship separately.

---

## File Structure

**In `r3` (`/Users/bigmistqke/Documents/GitHub/r3`):**

- Modify `src/index.ts` — export two functions: `isRecomputeQueued` and `cancelRecompute`. Pulse must never read or write r3's `flags` directly, because `ReactiveFlags` is a `const enum` and does not survive the package boundary reliably.
- Modify `test/basic.test.ts` — tests for both.

**In `pulse`:**

- Modify `src/scope.ts` — add `peekValue` (a scope-aware read that never runs a recipe) and `onSettleOn` (like `onSettle` but takes the scope explicitly, which nested actions need).
- Modify `src/computed.ts` — `makeStageNode` returns a handle carrying its per-stage operations. This is the bulk of the work.
- Create `src/derived-signal.ts` — the public `signal` that dispatches on whether its first argument is a function, plus `signalFromStages`. It lives in its own file because `src/signal.ts` cannot import `src/computed.ts` (computed already imports signal, and the cycle would be real).
- Modify `src/index.ts` — export `signal` from the new module instead of from `src/signal.ts`.
- Create `test/writable-derived.test.ts` — one test per scenario in group W.

**The stage handle.** `makeStageNode` currently returns `{ accessor, r3Node }`. It grows to:

```ts
type StageHandle = {
  accessor: Signal<unknown>
  r3Node: R3Computed<unknown>
  /** Abandon this stage's outstanding run — executing, paused, or queued.
   *  `isTail` is true for the stage a write lands on, which is left clean
   *  because the write supplied its value; every other stage is left needing
   *  recomputation, because its input moved and its published value no longer
   *  reflects that. */
  cancelRun: (isTail: boolean) => void
  /** Clear this stage's parked failure. Called on every stage, because the
   *  failure query walks upstream. */
  clearFailure: () => void
  /** Write the published value, wrapping a bare value when this stage is
   *  asynchronously coloured. Scope-aware: inside an action this installs a slot. */
  publishValue: (value: unknown) => void
  /** Everything a write implies that is NOT scope-aware: the change-gate fields
   *  and, for a written promise, the suspension bookkeeping. Runs immediately for
   *  a committed write and at commit for a speculative one. */
  applyWriteEffects: (value: unknown) => void
  /** The last resolved value as seen from the current scope, or undefined. */
  readPrev: () => unknown
}
```

Only the tail's `publishValue`, `applyWriteEffects` and `readPrev` are ever called. `cancelRun` and `clearFailure` are called on every stage.

---

### Task 1: Expose queued-recompute withdrawal in r3

A write has to cancel a run that is queued but has not started, or a write and an invalidation arriving in the same tick lose to each other depending on program order. `stabilize` recomputes every node in the heap without consulting its flags, so clearing flags from outside achieves nothing — the node has to leave the heap, and `deleteFromHeap` is internal.

**Files:**
- Modify: `/Users/bigmistqke/Documents/GitHub/r3/src/index.ts` (add exports after `stabilize`, around line 404)
- Test: `/Users/bigmistqke/Documents/GitHub/r3/test/basic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function isRecomputeQueued(el: Computed<unknown>): boolean
  export function cancelRecompute(el: Computed<unknown>, keepDirty?: boolean): boolean
  ```
  `isRecomputeQueued` reports whether a recomputation is outstanding. `cancelRecompute` withdraws it, returns whether there was one, and leaves the node needing recomputation when `keepDirty` is true. Both refuse a node that is in the middle of its own run.

- [ ] **Step 1: Write the failing tests**

Append to `/Users/bigmistqke/Documents/GitHub/r3/test/basic.test.ts`:

```ts
test("cancelRecompute withdraws a queued recompute", () => {
  let runs = 0;
  const s = signal(1);
  const c = computed(() => {
    runs++;
    return read(s) + 1;
  });
  stabilize();
  expect(runs).toBe(1);
  expect(c.value).toBe(2);

  setSignal(s, 10);
  expect(isRecomputeQueued(c)).toBe(true);
  expect(cancelRecompute(c)).toBe(true);
  expect(isRecomputeQueued(c)).toBe(false);

  stabilize();
  expect(runs).toBe(1); // the flush did not run it
  expect(c.value).toBe(2); // stale, by design

  setSignal(s, 20);
  stabilize();
  expect(runs).toBe(2); // a later change still schedules it
  expect(c.value).toBe(21);
});

test("cancelRecompute reports false when nothing was queued", () => {
  const s = signal(1);
  const c = computed(() => read(s) + 1);
  stabilize();
  expect(isRecomputeQueued(c)).toBe(false);
  expect(cancelRecompute(c)).toBe(false);
});

test("cancelRecompute can leave the node needing recomputation", () => {
  let cRuns = 0;
  const s = signal(1);
  const t = signal(0);
  const c = computed(() => {
    cRuns++;
    return read(s) + 1;
  });
  const d = computed(() => read(t) + read(c));
  stabilize();
  expect(cRuns).toBe(1);
  expect(d.value).toBe(2);

  setSignal(s, 10);
  cancelRecompute(c, true);
  stabilize();
  expect(cRuns).toBe(1); // the flush did not run it

  setSignal(t, 1);
  stabilize();
  expect(cRuns).toBe(2); // a consumer reading it pulled it up to date
  expect(d.value).toBe(1 + 11);
});

test("cancelRecompute refuses a node that is running", () => {
  let refused: boolean | null = null;
  const s = signal(1);
  const c: Computed<number> = computed(() => {
    refused = cancelRecompute(c);
    return read(s) + 1;
  });
  stabilize();
  expect(refused).toBe(false);
  expect(c.value).toBe(2);
});
```

Update the import at the top of the file to include the new names and the `Computed` type:

```ts
import {
  cancelRecompute,
  computed,
  Computed,
  isRecomputeQueued,
  read,
  setSignal,
  Signal,
  signal,
  stabilize,
} from "../src";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/bigmistqke/Documents/GitHub/r3 && pnpm vitest run`
Expected: FAIL — `cancelRecompute is not exported` / `isRecomputeQueued is not exported`.

- [ ] **Step 3: Write the implementation**

In `/Users/bigmistqke/Documents/GitHub/r3/src/index.ts`, immediately after the `stabilize` function:

```ts
/**
 * Whether a recompute of `el` is outstanding — queued in the heap, or marked
 * dirty and waiting to be pulled by a reader. Reported through a function
 * rather than by exposing the flags, because `ReactiveFlags` is a const enum
 * and does not survive a package boundary.
 */
export function isRecomputeQueued(el: Computed<unknown>): boolean {
  return (
    (el.flags &
      (ReactiveFlags.Dirty | ReactiveFlags.Check | ReactiveFlags.InHeap)) !==
    0
  );
}

/**
 * Withdraw an outstanding recompute of `el` and report whether there was one.
 * Clearing the flags alone is not enough: `stabilize` recomputes everything in
 * the heap without consulting them, so the node has to leave the heap.
 *
 * `keepDirty` leaves the node needing recomputation instead of clean, so it is
 * skipped by the next flush but recomputed by the next consumer that reads it.
 * That is the right state for a node whose input has moved but whose own work
 * was abandoned.
 *
 * A node in the middle of its own run is refused: `flags` currently holds
 * `RecomputingDeps`, and overwriting it would corrupt the dependency rebuild
 * that `recompute` performs when the body returns.
 */
export function cancelRecompute(
  el: Computed<unknown>,
  keepDirty = false,
): boolean {
  if (el.flags & ReactiveFlags.RecomputingDeps) return false;
  const queued = isRecomputeQueued(el);
  deleteFromHeap(el);
  el.flags = keepDirty ? ReactiveFlags.Dirty : ReactiveFlags.None;
  return queued;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/bigmistqke/Documents/GitHub/r3 && pnpm vitest run`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit in r3**

```bash
cd /Users/bigmistqke/Documents/GitHub/r3
git checkout -b withdraw-queued-recompute
git add src/index.ts test/basic.test.ts
git commit -m "feat: let a caller withdraw an outstanding recompute

Adds two functions. One reports whether a recompute of a node is
outstanding. The other withdraws it and says whether there was one,
optionally leaving the node needing recomputation rather than clean, so the
next flush skips it but the next consumer that reads it pulls it up to date.

Clearing the flags from outside was not enough on its own, because stabilize
recomputes everything in the heap without consulting them, and the function
that takes a node out of the heap was internal. A node in the middle of its
own run is refused, since overwriting its flags there would corrupt the
dependency rebuild that happens when its body returns.

Reported through functions rather than by exposing the flags, because the
flag type is a const enum and does not survive a package boundary."
```

- [ ] **Step 6: Push and update the pin — ASK FIRST**

This publishes to `github.com/bigmistqke/r3`. **Stop and ask the user before running it.**

```bash
cd /Users/bigmistqke/Documents/GitHub/r3
git push fork withdraw-queued-recompute
git rev-parse HEAD    # note the sha
```

Then in pulse, replace the sha in `package.json`:

```json
"r3": "github:bigmistqke/r3#<new-sha>"
```

```bash
cd /Users/bigmistqke/Documents/GitHub/pulse
pnpm install
pnpm test           # the existing suite must still pass
```

- [ ] **Step 7: Commit the pin in pulse**

```bash
git checkout -b writable-derived-signals
git add package.json pnpm-lock.yaml
git commit -m "chore: pin the reactive core at the withdrawal support

Picks up the two functions that let a caller withdraw an outstanding
recompute, which a write into a derivation needs so that an invalidation
queued earlier in the same tick does not run after the write and replace it."
```

---

### Task 2: The `signal(fn)` surface and a plain write

Build the smallest thing that works: `signal(fn)` returns an accessor and a setter, and the setter writes the tail's published value. No cancellation yet.

**Covers:** W2 (write while nothing is running), W3 (write before the first read), W21 (two writes in one tick).

**Files:**
- Modify: `src/computed.ts` — `makeStageNode` returns `publishValue`, `applyWriteEffects`, `readPrev`
- Modify: `src/scope.ts` — add `peekValue`
- Create: `src/derived-signal.ts`
- Modify: `src/index.ts`
- Test: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces:
  ```ts
  // src/scope.ts
  export function peekValue<T>(node: Node<T>): T

  // src/derived-signal.ts
  export function signal<T>(initial: T): [Accessor<T>, Setter<T>]
  export function signal<A>(s0: () => A): [Accessor<PipelineRead<[], A>>, DerivedSetter<PipelineRead<[], A>>]
  // …through five stages, mirroring computed's overloads
  export type DerivedSetter<T> = (
    next: T | Awaited<T> | ((prev: Awaited<T> | undefined) => T | Awaited<T>),
  ) => void
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/writable-derived.test.ts`:

```ts
import { expect, test } from 'vitest'
import { signal } from '../src/derived-signal'
import { use } from '../src/async'

test('W2: a write replaces the value and the body does not re-run', () => {
  let runs = 0
  const [count, setCount] = signal(() => {
    runs++
    return 1
  })
  expect(count()).toBe(1)
  expect(runs).toBe(1)

  setCount(7)
  expect(count()).toBe(7)
  expect(runs).toBe(1) // the derivation did not run again
})

test('W2: an update function receives the last resolved value', () => {
  const [list, setList] = signal(() => ['a'])
  expect(list()).toEqual(['a'])
  setList((prev) => [...(prev ?? []), 'b'])
  expect(list()).toEqual(['a', 'b'])
})

test('W3: an update function receives undefined before the derivation has run', () => {
  let seen: unknown = 'not called'
  const [list, setList] = signal(() => ['a'])
  setList((prev) => {
    seen = prev
    return ['seeded']
  })
  expect(seen).toBeUndefined()
  expect(list()).toEqual(['seeded'])
})

test('W21: two writes in one tick chain, and the last one wins', () => {
  const [list, setList] = signal(() => ['a'])
  expect(list()).toEqual(['a'])
  setList((prev) => [...(prev ?? []), 'b'])
  setList((prev) => [...(prev ?? []), 'c'])
  expect(list()).toEqual(['a', 'b', 'c'])
})

test('the value form still works and is unchanged', () => {
  const [count, setCount] = signal(0)
  setCount(3)
  expect(count()).toBe(3)
  setCount((n) => n + 1)
  expect(count()).toBe(4)
})

test('a write into a multi-stage pipeline lands on the output', () => {
  const [n, setN] = signal(
    () => 2,
    (v: number) => v * 10,
  )
  expect(n()).toBe(20)
  setN(99)
  expect(n()).toBe(99)
})

test('a bare write into an asynchronously coloured stage keeps the read a promise', async () => {
  const [list, setList] = signal(function* () {
    return ['a']
  })
  expect(use(list)).toEqual(['a'])
  setList(['b'])
  expect(use(list)).toEqual(['b'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test writable-derived`
Expected: FAIL — `Failed to resolve import "../src/derived-signal"`.

- [ ] **Step 3: Add `peekValue` to `src/scope.ts`**

Add after `readValue` (which ends around line 228):

```ts
/** Read a node's value from the current scope WITHOUT running its recipe on a
 *  miss and without forming any dependency. A speculative miss on a node that
 *  has a recipe would evaluate it inside the speculation, where the suspend and
 *  settle machinery does not run — so anything asynchronous could not resolve.
 *  Falling through to the committed value avoids that entirely. */
export function peekValue<T>(node: Node<T>): T {
  const slot = readSlot(node, getCurrentScope())
  if (slot !== undefined && slot.cached !== DIRTY) return slot.cached as T
  stabilize()
  return (node.backing as R3Signal<T>).value
}
```

- [ ] **Step 4: Give `makeStageNode` the three write operations**

In `src/computed.ts`, add these before the `accessor` definition (which begins around line 620). They close over `publishedValue`, `setPublishedValue`, `publishedNode`, `lastResolvedValue`, `lastPublishedShapeIsPromise`, `resumeKind` and `UNRESOLVED`, all already in scope.

```ts
  // ---- write path -------------------------------------------------------

  /** The last resolved value, or undefined when there is none. Never the
   *  sentinel, never a promise. */
  const lastResolvedOrUndefined = (): unknown =>
    lastResolvedValue === UNRESOLVED ? undefined : lastResolvedValue

  /** What an update function is handed: the last resolved value as seen from
   *  the current scope. Reads the published value through `peekValue`, so a
   *  speculative write earlier in the same action is visible, and resolves it —
   *  a settled promise unwraps, a pending one falls back to the committed last
   *  resolved value. */
  const readPrev = (): unknown => {
    const seen = r3Untrack(() => peekValue(publishedNode))
    if (seen === UNRESOLVED) return lastResolvedOrUndefined()
    if (!isPromise(seen)) return seen
    const state = track(seen as Promise<unknown>)
    return state.status === 'fulfilled' ? state.value : lastResolvedOrUndefined()
  }

  /** Whether a bare write has to be wrapped so the read keeps its asynchronous
   *  colour. Uses the same coarse test the publish path uses, so a write does
   *  not flip the shape a consumer sees. */
  const writeWrapsInPromise = (): boolean =>
    resumeKind === 'fast-forward' || lastPublishedShapeIsPromise

  /** Write the published value. Scope-aware: inside an action this installs a
   *  slot rather than touching committed state. */
  const publishValue = (value: unknown): void => {
    if (isPromise(value)) {
      setPublishedValue(value)
      return
    }
    setPublishedValue(writeWrapsInPromise() ? resolvedPromise(value) : value)
  }

  /** Everything a write implies that is not scope-aware. Runs immediately for a
   *  committed write, and at commit for one made inside an action. */
  const applyWriteEffects = (value: unknown): void => {
    if (isPromise(value)) return // handled in a later task
    lastResolvedValue = value
    lastPublishedShapeIsPromise = writeWrapsInPromise()
  }
```

Add `peekValue` to the `./scope` import at the top of `src/computed.ts`. There is currently no import from `./scope` in that file, so add one:

```ts
import { peekValue } from './scope'
```

Change the return statement at the end of `makeStageNode` from

```ts
  return { accessor, r3Node: depTracker as R3Computed<unknown> }
```

to

```ts
  return {
    accessor,
    r3Node: depTracker as R3Computed<unknown>,
    publishValue,
    applyWriteEffects,
    readPrev,
  }
```

and update the destructuring in `computed` (around line 79) from `const { accessor, r3Node } = makeStageNode(...)` to keep working — it already names only what it uses, so no change is needed there.

- [ ] **Step 5: Create `src/derived-signal.ts`**

```ts
import { signal as valueSignal, type Accessor, type Setter } from './signal'
import { buildStages } from './computed'
import type { PipelineRead, Resolved } from './async'

/** A stage of any shape: sync, async, or generator. */
type Stage<In, Out> = (value: In) => Out

/**
 * The setter of a writable derivation.
 *
 * The value may be given bare or as a promise — a promise says "the value is
 * whatever this resolves to". The update form is handed the LAST RESOLVED
 * value, never a promise and never a sentinel, and `undefined` when the
 * derivation has not produced anything yet. Values are resolved on the write
 * side and inside a stage; the asynchronous colour is only visible on the read
 * side.
 */
export type DerivedSetter<T> = (
  next: T | Awaited<T> | ((prev: Awaited<T> | undefined) => T | Awaited<T>),
) => void

export function signal<T>(initial: T): [Accessor<T>, Setter<T>]
export function signal<A>(
  s0: () => A,
): [Accessor<PipelineRead<[], A>>, DerivedSetter<PipelineRead<[], A>>]
export function signal<A, B>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
): [Accessor<PipelineRead<[A], B>>, DerivedSetter<PipelineRead<[A], B>>]
export function signal<A, B, C>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
): [Accessor<PipelineRead<[A, B], C>>, DerivedSetter<PipelineRead<[A, B], C>>]
export function signal<A, B, C, D>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
): [Accessor<PipelineRead<[A, B, C], D>>, DerivedSetter<PipelineRead<[A, B, C], D>>]
export function signal<A, B, C, D, E>(
  s0: () => A,
  s1: Stage<Resolved<A>, B>,
  s2: Stage<Resolved<B>, C>,
  s3: Stage<Resolved<C>, D>,
  s4: Stage<Resolved<D>, E>,
): [Accessor<PipelineRead<[A, B, C, D], E>>, DerivedSetter<PipelineRead<[A, B, C, D], E>>]

// `any` here is the standard implementation-signature widening for the variadic
// overloads above; narrowing to `unknown` breaks the overload contract.
export function signal(...args: any[]): [Accessor<any>, any] {
  if (typeof args[0] !== 'function') {
    return valueSignal(args[0])
  }
  return signalFromStages(...(args as Array<(value: any) => unknown>))
}

/** Build a pipeline and return it with a setter. `computed` builds the same
 *  stages and drops the setter. */
function signalFromStages(
  ...stages: Array<(value: any) => unknown>
): [Accessor<unknown>, DerivedSetter<unknown>] {
  const built = buildStages(stages)
  const tail = built[built.length - 1]

  const setter: DerivedSetter<unknown> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(tail.readPrev())
        : next
    tail.publishValue(value)
    tail.applyWriteEffects(value)
  }

  return [tail.accessor as Accessor<unknown>, setter]
}
```

- [ ] **Step 6: Extract `buildStages` in `src/computed.ts`**

`computed` currently builds the stage chain inline (lines 74-94). Extract that loop so both callers share it. Replace the body of `computed` with:

```ts
export function computed(...stages: Array<(value: any) => unknown>): Signal<unknown> {
  const built = buildStages(stages)
  return built[built.length - 1].accessor
}

/**
 * Build a pipeline of stages and return a handle per stage, in order. Disposal
 * walks stages in creation order (upstream to downstream). Each
 * `unwatched(stageN)` removes that node from its dependencies' subscriber lists;
 * if stage N+1 was the only consumer of stage N, stage N would have auto-cleaned
 * via r3's `unwatched` cascade anyway. Every stage is disposed explicitly to be
 * robust against external consumers of intermediate stages (though pulse does
 * not currently expose them).
 *
 * Exported so the writable form can build the same pipeline and keep the
 * per-stage handles, which is what lets its setter reach every stage.
 */
export function buildStages(stages: Array<(value: any) => unknown>): StageHandle[] {
  if (stages.length === 0) {
    throw new Error('computed requires at least one stage')
  }
  const built: StageHandle[] = []
  let inputAccessor: Signal<unknown> | null = null
  for (const stage of stages) {
    const handle = makeStageNode(stage, inputAccessor)
    built.push(handle)
    inputAccessor = handle.accessor
  }
  registerWithOwner({
    dispose: () => {
      for (const handle of built) unwatched(handle.r3Node)
    },
  })
  return built
}
```

and add the type above `makeStageNode`:

```ts
/** What `makeStageNode` hands back: the stage's public accessor plus the
 *  operations the writable form needs to reach it. */
export type StageHandle = {
  accessor: Signal<unknown>
  r3Node: R3Computed<unknown>
  publishValue: (value: unknown) => void
  applyWriteEffects: (value: unknown) => void
  readPrev: () => unknown
}
```

Change `makeStageNode`'s return type annotation to `StageHandle`.

- [ ] **Step 7: Re-point the public export**

In `src/index.ts`, change

```ts
export { signal, type Accessor, type Setter, type Signal } from './signal'
```

to

```ts
export { type Accessor, type Setter, type Signal } from './signal'
export { signal, type DerivedSetter } from './derived-signal'
```

- [ ] **Step 8: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: the new file passes, and the whole existing suite still passes. `test/signal.test.ts` and `test/computed.test.ts` import from `../src/signal` and `../src/computed` directly, so they are unaffected.

- [ ] **Step 9: Commit**

```bash
git add src/computed.ts src/scope.ts src/derived-signal.ts src/index.ts test/writable-derived.test.ts
git commit -m "feat: give a derivation a setter

A derivation built from a stage list can now also be written to directly. The
public signal function dispatches on whether its first argument is a function:
a function builds a pipeline and returns it with a setter, anything else keeps
the existing value behaviour.

The setter writes the last stage's published value, because that is what a
consumer reads. It is built by the pipeline builder rather than inside a stage,
so that later work can reach every stage from it. The stage builder therefore
hands back a handle per stage instead of just an accessor, and the pipeline loop
is shared between the read-only and writable forms.

An update function is handed the last resolved value rather than the published
one — never a promise, and undefined before the derivation has produced
anything. Values are resolved on the write side and inside a stage; the
asynchronous colour is only visible on the read side. Reading it uses a
scope-aware read that never runs the derivation on a miss, because evaluating a
pipeline inside a speculation cannot resolve anything asynchronous.

This step only writes the value. Cancelling the run a write supersedes comes
next."
```

---

### Task 3: A write cancels a run that is executing or paused

**Covers:** W1 (write while the fetch is in flight), W9 (fetch in a middle stage), W13 (a paused stage's cleanups fire).

W8 and W12 were originally claimed here and moved to Task 5, where they have actual test code. A "Covers" line is a claim the task review checks against the tests that exist — do not list a scenario a step does not write.

**Files:**
- Modify: `src/computed.ts` — add `cancelRun` to the handle
- Modify: `src/derived-signal.ts` — call it on every stage
- Test: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: `StageHandle` from Task 2.
- Produces: `StageHandle` gains `cancelRun: (isTail: boolean) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `test/writable-derived.test.ts`:

```ts
/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('W1: a write abandons the fetch in flight and it never publishes', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })

  // start the first load and let it settle
  expect(isPending(todos)()).toBe(true)
  resolveList(['a'])
  await tick()
  expect(use(todos)).toEqual(['a'])

  // a refresh starts a second fetch
  setVersion(2)
  await tick()
  expect(isPending(todos)()).toBe(true)

  // the write abandons it
  setTodos(['a', 'saved'])
  expect(isPending(todos)()).toBe(false)
  expect(use(todos)).toEqual(['a', 'saved'])

  resolveList(['a', 'b'])
  await tick()
  expect(use(todos)).toEqual(['a', 'saved']) // the abandoned fetch published nothing
})

test('W13: abandoning a paused stage runs its cleanups', async () => {
  const aborted: string[] = []
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    onCleanup(() => aborted.push(`run ${v}`))
    return yield* read(new Promise<string[]>(() => {}))
  })

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(aborted).toEqual(['run 1'])
})

test('W9: a write abandons a fetch that is in a middle stage', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => server.filter((t) => t !== 'done'),
  )

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveList(['from', 'server'])
  await tick()
  expect(use(todos)).toEqual(['written']) // the middle stage published nothing
})
```

Extend the imports at the top of the test file:

```ts
import { isPending } from '../src/pending'
import { read, use } from '../src/async'
import { onCleanup } from '../src/owner'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test writable-derived`
Expected: FAIL — W1's last assertion sees `['a', 'b']`, W13's `aborted` is empty, W9's last assertion sees `['from', 'server']`.

- [ ] **Step 3: Add `cancelRun` to `makeStageNode`**

In `src/computed.ts`, in the write-path block added in Task 2:

```ts
  /**
   * Abandon this stage's outstanding run. `isTail` is true for the stage a write
   * lands on, which is left clean because the write supplied its value; every
   * other stage is left needing recomputation, because its input moved and its
   * published value no longer reflects that.
   *
   * Refuses a stage whose own body is the caller. Discarding a generator calls
   * its `return` method, and calling that on a generator which is currently
   * executing raises a TypeError.
   */
  const cancelRun = (isTail: boolean): void => {
    const self = depTracker as R3Computed<unknown>
    if (r3GetContext() === self) return
    const hadWork = retainedGen !== null || suspendedOn !== null
    if (!hadWork && !isRecomputeQueued(self)) return
    discardGen()
    suspendedOn = null
    suspendedInput = undefined
    stashedResolution = null
    setPendingSig(false)
    cancelRecompute(self, !isTail)
  }
```

Add the r3 imports to the top of `src/computed.ts`:

```ts
import { cancelRecompute, isRecomputeQueued } from 'r3'
```

(merge into the existing `from 'r3'` import).

Add `cancelRun` to the returned handle and to the `StageHandle` type.

- [ ] **Step 4: Call it from the setter**

In `src/derived-signal.ts`, change the setter body to:

```ts
  const setter: DerivedSetter<unknown> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(tail.readPrev())
        : next

    // The value first, so a cleanup fired by cancelling below observes the
    // write that triggered it rather than the value it replaced.
    tail.publishValue(value)
    tail.applyWriteEffects(value)

    // One run, spread across stages — abandon all of it.
    for (let i = built.length - 1; i >= 0; i--) {
      built[i].cancelRun(built[i] === tail)
    }
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/computed.ts src/derived-signal.ts test/writable-derived.test.ts
git commit -m "feat: a write abandons the run it supersedes

A write says what the value is now, so a computation of that value which is
still in progress is void. Every stage is abandoned, not only the one the write
lands on: a pipeline is one derivation with internal joints, and its pending and
failure answers are already reported as one, so a request in an earlier stage is
part of the same run. Without this, moving a request one stage upstream would
silently change the behaviour, and which stage holds a request is a detail of
how someone chose to split their pipeline.

Abandoning a stage discards its paused generator, which runs its cleanup
callbacks, so a request wired to an abort controller is cancelled at the network
rather than merely ignored. It also drops the promise the stage was waiting on,
which makes the settle handler for that promise find itself superseded and
publish nothing.

A stage whose own body is the caller is skipped, because discarding a generator
calls its return method and doing that to a generator which is currently running
raises an error.

Cleanups run after the value is published, so a cleanup that reads the signal it
was triggered by sees the write rather than the value it replaced."
```

---

### Task 4: A write withdraws a run that is queued but has not started

**Covers:** W19 (invalidate then write, same tick), W20 (write then invalidate, same tick).

**Files:**
- Test only: `test/writable-derived.test.ts`. The implementation landed in Task 3 through `cancelRecompute`; this task proves it and pins the ordering behaviour.

**Interfaces:**
- Consumes: `cancelRun` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
test('W19: invalidating then writing in one tick makes no request at all', async () => {
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    requests++
    return yield* read(Promise.resolve(['from server']))
  })

  await tick()
  expect(use(todos)).toEqual(['from server'])
  expect(requests).toBe(1)

  setVersion(2)
  setTodos(['pushed'])
  await tick()

  expect(requests).toBe(1) // the queued run was withdrawn
  expect(use(todos)).toEqual(['pushed'])
})

test('W20: writing then invalidating in one tick lets the request win', async () => {
  let requests = 0
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    requests++
    return yield* read(Promise.resolve([`server ${requests}`]))
  })

  await tick()
  expect(use(todos)).toEqual(['server 1'])

  setTodos(['written'])
  setVersion(2)
  await tick()

  expect(requests).toBe(2) // nothing was queued when the write landed
  expect(use(todos)).toEqual(['server 2'])
})
```

- [ ] **Step 2: Run the tests to verify W19 fails**

Run: `pnpm test writable-derived`
Expected: W20 passes already; W19 fails with `requests` being 2 and the value being `['from server']`, if `cancelRecompute` is not reached. If both pass, Task 3 already covered it — record that and move on rather than adding code.

- [ ] **Step 3: Fix if needed**

If W19 fails, the cause is `cancelRun`'s early return: `hadWork` is false and `isRecomputeQueued` is being consulted after `discardGen` rather than before. Confirm the guard reads

```ts
    const hadWork = retainedGen !== null || suspendedOn !== null
    if (!hadWork && !isRecomputeQueued(self)) return
```

with the queued check before any mutation.

- [ ] **Step 4: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/writable-derived.test.ts
git commit -m "test: pin what happens when a write and an invalidation share a tick

An invalidation does not run the derivation, it schedules it. So a write in the
same tick has to withdraw the scheduled run as well as abandon any run already
under way, or the derivation runs afterwards and replaces the written value.

Both orderings are covered because they mean opposite things and both occur.
Invalidating and then writing is what a server message carrying both a change
notification and the new data looks like, and there the write is the last word.
Writing and then invalidating is showing a result immediately and then
re-synchronising, and there the request should run and win. Neither needs a rule
of its own: the question is asked at the moment of the write, so the order the
calls were made in decides."
```

---

### Task 5: A cancelled upstream stage is left needing recomputation

**Covers:** W10 (a dependency only the tail reads changes afterwards), W11 (the middle stage's own dependency changes afterwards), W8 (fetch in the tail, with stages in front) and W12 (two stages in flight at once).

W8 and W12 were named as covered by Task 3 but no test for either was ever written — its brief carried test code for W1, W9 and W13 only. They move here, where the multi-stage shape is already set up.

**Extra tests for W8 and W12,** to be added alongside the two below:

```ts
test('W8: a write behaves the same when the fetch is in the tail', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
  )

  expect(isPending(todos)()).toBe(true)
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveList(['from server'])
  await tick()
  expect(latest(todos)).toEqual(['written'])
})

test('W12: a write abandons every stage that has work, and resuming reissues both', async () => {
  let sessionRequests = 0
  let listRequests = 0
  let resolveSession: (v: { id: number }) => void = () => {}
  let resolveList: (v: string[]) => void = () => {}

  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      sessionRequests++
      return yield* read(new Promise<{ id: number }>((r) => (resolveSession = r)))
    },
    function* () {
      listRequests++
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
  )

  // the first stage is fetching and the second mirrors its suspension
  expect(sessionRequests).toBe(1)
  expect(isPending(todos)()).toBe(true)

  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  resolveSession({ id: 1 })
  await tick()
  expect(listRequests).toBe(0) // the abandoned first stage published nothing
  expect(latest(todos)).toEqual(['written'])

  // a later change resumes the whole chain, which costs both requests
  setVersion(2)
  await tick()
  expect(sessionRequests).toBe(2)
  resolveSession({ id: 2 })
  await tick()
  expect(listRequests).toBe(1)
})
```

Adjust the promise plumbing if it does not behave as written — a stage that re-runs builds a fresh promise, so a captured resolve function from an earlier run no longer controls what the stage waits on. Say what you changed and why.

The `keepDirty` argument landed in Task 3. This task proves the behaviour it exists for, which is the one a scenario walk found and which is invisible without a multi-stage test.

**Files:**
- Test only: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: `cancelRun(isTail)` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
test('W10: a stage whose request was abandoned refetches when the tail next needs it', async () => {
  let requests = 0
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [showAll, setShowAll] = signal(false)

  const [todos, setTodos] = signal(
    () => version(),
    function* (v: number) {
      requests++
      return yield* read(
        new Promise<string[]>((r) => (resolveList = r)),
      )
    },
    (server: string[]) => (showAll() ? server : server.filter((t) => t !== 'done')),
  )

  expect(isPending(todos)()).toBe(true)
  resolveList(['keep', 'done'])
  await tick()
  expect(use(todos)).toEqual(['keep'])
  expect(requests).toBe(1)

  setVersion(2) // starts a second request
  await tick()
  expect(requests).toBe(2)

  setTodos(['written']) // abandons it
  expect(use(todos)).toEqual(['written'])

  setShowAll(true) // only the last stage depends on this
  await tick()

  // the abandoned stage is refetched rather than serving data for version 1
  expect(requests).toBe(3)
  expect(isPending(todos)()).toBe(true)
  expect(use(todos)).toEqual(['written']) // the write is held while it reloads

  resolveList(['fresh', 'done'])
  await tick()
  expect(use(todos)).toEqual(['fresh', 'done'])
})

test('W11: a later change to the abandoned stage own dependency restarts it', async () => {
  let requests = 0
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)

  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      requests++
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => server,
  )

  resolveList(['first'])
  await tick()
  expect(requests).toBe(1)

  setVersion(2)
  await tick()
  setTodos(['written'])
  expect(isPending(todos)()).toBe(false)

  setVersion(3)
  await tick()
  expect(requests).toBe(3)
  expect(isPending(todos)()).toBe(true)
  expect(use(todos)).toEqual(['written']) // held while reloading

  resolveList(['third'])
  await tick()
  expect(use(todos)).toEqual(['third'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test writable-derived`
Expected: W10 fails at `expect(requests).toBe(3)` with 2, and at the following assertion with `['keep', 'done']` — the middle stage looked clean and served data for version 1.

- [ ] **Step 3: Verify the implementation**

The fix is already in `cancelRun`: `cancelRecompute(self, !isTail)`. If the test still fails, check that the pipeline builder passes `isTail` correctly — `built[i] === tail` — and that `peekValue` is not accidentally being used for the tail's own value read.

- [ ] **Step 4: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/writable-derived.test.ts
git commit -m "test: an abandoned earlier stage reloads instead of serving stale data

Abandoning a stage does not un-change the input that made it run. Leaving it
looking up to date produces a pipeline that is quietly wrong: the first stage
says one version, the middle stage holds data for another, and nothing is
scheduled to reconcile them. Ticking an unrelated filter then serves the old
data and loses both the write and the reload.

Left needing recomputation instead, the stage is skipped by the next flush and
reloaded by the next consumer that reads it, so no work happens until something
actually wants the value. While it reloads, the written value stays visible,
which is the same tolerance a reload already gets."
```

---

### Task 6: A write clears the failure on every stage

**Covers:** W5 (write onto a parked failure), single-stage and multi-stage.

**Files:**
- Modify: `src/computed.ts` — add `clearFailure` to the handle
- Modify: `src/derived-signal.ts` — call it on every stage
- Test: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: `StageHandle` from Task 2.
- Produces: `StageHandle` gains `clearFailure: () => void`.

- [ ] **Step 1: Write the failing tests**

```ts
test('W5: a write clears a parked failure on a single stage', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(Promise.reject(new Error('offline')))
  })

  await tick()
  expect(failure(todos)()).toBeInstanceOf(Error)

  setTodos(['pushed'])
  expect(failure(todos)()).toBeNull()
  expect(use(todos)).toEqual(['pushed'])
})

test('W5: a write clears a failure parked on an earlier stage', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(Promise.reject(new Error('offline')))
    },
    (server: string[]) => server,
  )

  await tick()
  expect(failure(todos)()).toBeInstanceOf(Error)

  setTodos(['pushed'])
  expect(failure(todos)()).toBeNull() // the query walks upstream
  expect(use(todos)).toEqual(['pushed'])
})
```

Add `import { failure } from '../src/failure'` to the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test writable-derived`
Expected: the multi-stage test fails — `failure(todos)()` is still an Error.

- [ ] **Step 3: Add `clearFailure`**

In `src/computed.ts`, in the write-path block:

```ts
  /** Clear this stage's parked failure. Called on every stage of a pipeline by a
   *  write, because the failure query walks upstream — clearing only the stage a
   *  write lands on leaves a boundary rendering its fallback over a signal that
   *  now holds a value. */
  const clearFailure = (): void => {
    setFailureSig(null)
  }
```

Add it to the handle and to `StageHandle`.

- [ ] **Step 4: Call it from the setter**

In `src/derived-signal.ts`, extend the loop:

```ts
    for (let i = built.length - 1; i >= 0; i--) {
      built[i].cancelRun(built[i] === tail)
      built[i].clearFailure()
    }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/computed.ts src/derived-signal.ts test/writable-derived.test.ts
git commit -m "feat: a write clears the failure on every stage of a pipeline

A write is a value, so a signal holding one is not failed and a boundary should
stop rendering its fallback. Clearing only the stage a write lands on is not
enough, because the failure query walks upstream the same way the pending query
does: an earlier stage's parked failure keeps reporting, and the fallback stays
on screen over a signal that now has a perfectly good value."
```

---

### Task 7: Writing a promise

**Covers:** W6 (write a promise), W7 (a dependency change supersedes a written promise).

**Files:**
- Modify: `src/computed.ts` — the promise branch of `applyWriteEffects`
- Test: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: `applyWriteEffects` from Task 2.
- Produces: no signature change.

- [ ] **Step 1: Write the failing tests**

```ts
test('W6: a written promise reports as pending and then resolves', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()
  expect(use(todos)).toEqual(['a'])

  let resolveAdd: (v: string[]) => void = () => {}
  setTodos(new Promise<string[]>((r) => (resolveAdd = r)))

  expect(isPending(todos)()).toBe(true)
  expect(latest(todos)).toEqual(['a']) // the tolerant read degrades to the prior value

  resolveAdd(['a', 'saved'])
  await tick()
  expect(isPending(todos)()).toBe(false)
  expect(use(todos)).toEqual(['a', 'saved'])
})

test('W6: an update function sees the value from before a written promise settles', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()

  setTodos(new Promise<string[]>(() => {}))
  let seen: unknown = 'not called'
  setTodos((prev) => {
    seen = prev
    return ['replaced']
  })
  expect(seen).toEqual(['a']) // the last value that actually resolved
})

test('W7: a dependency change supersedes a written promise that has not settled', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    return yield* read(Promise.resolve([`server ${v}`]))
  })
  await tick()
  expect(use(todos)).toEqual(['server 1'])

  let resolveWrite: (v: string[]) => void = () => {}
  setTodos(new Promise<string[]>((r) => (resolveWrite = r)))
  expect(isPending(todos)()).toBe(true)

  setVersion(2)
  await tick()
  expect(use(todos)).toEqual(['server 2'])

  resolveWrite(['from the write'])
  await tick()
  expect(use(todos)).toEqual(['server 2']) // the superseded write published nothing
})

test('W6: a rejected written promise parks as a failure', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()

  setTodos(Promise.reject(new Error('save failed')))
  await tick()
  expect(failure(todos)()).toBeInstanceOf(Error)
  expect(latest(todos)).toEqual(['a'])
})
```

Add `import { latest } from '../src/async'` to the test file's async import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test writable-derived`
Expected: FAIL — `isPending` reports false for a written promise, because `applyWriteEffects` currently returns early on one.

- [ ] **Step 3: Implement the promise branch**

Replace `applyWriteEffects` in `src/computed.ts` with:

```ts
  const applyWriteEffects = (value: unknown): void => {
    if (!isPromise(value)) {
      lastResolvedValue = value
      lastPublishedShapeIsPromise = writeWrapsInPromise()
      return
    }

    // A written promise has resolved nothing, so `lastResolvedValue` keeps
    // whatever it held — the same thing the body does when it suspends, and
    // what lets the tolerant read degrade to the last known value.
    const written = value as Promise<unknown>
    lastPublishedShapeIsPromise = true

    // Held in the same field the body uses, so the body's next suspension
    // supersedes it through the check below and a dependency change cancels a
    // write for free.
    suspendedOn = written
    setPendingSig(true)

    const settle = (): void => {
      if (suspendedOn !== written) return // superseded
      suspendedOn = null
      // The pending flag clears regardless of whether anything is published, or
      // a write that settles to the value already held would leave it stuck on.
      setPendingSig(false)
      const state = track(written)
      if (state.status === 'rejected') {
        setFailureSig(state.reason)
        return
      }
      if (
        lastResolvedValue === UNRESOLVED ||
        !Object.is(lastResolvedValue, state.value)
      ) {
        lastResolvedValue = state.value
        setFailureSig(null)
        publishResolvedPromise(state.value)
      }
    }
    written.then(settle, settle)
  }
```

- [ ] **Step 4: Seed the tolerant read's prior value**

`publishValue` writes a promise through `setPublishedValue`, which already seeds the stale-while-revalidate prior when the write happens outside a reactive context (`src/signal.ts:84-88`). Confirm the `latest(todos)` assertion in the first test passes; if it does not, the cause is that `track(value, prior)` was skipped, and `publishValue` must seed it explicitly:

```ts
  const publishValue = (value: unknown): void => {
    if (isPromise(value)) {
      track(value as Promise<unknown>, lastResolvedOrUndefined())
      setPublishedValue(value)
      return
    }
    setPublishedValue(writeWrapsInPromise() ? resolvedPromise(value) : value)
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/computed.ts test/writable-derived.test.ts
git commit -m "feat: accept a promise as the written value

Writing a promise says the value is whatever it resolves to. It is published
straight away rather than held back, unlike the derivation's own suspension,
which keeps its prior value visible to avoid disturbing consumers on a reload —
a written promise is the value the caller asked for, so the read returns it, the
tolerant read gives the previous value, and a suspending read waits on it.

The last resolved value keeps whatever it held until the written promise
settles, because a promise in flight has resolved nothing. That is the same
thing the derivation does when it suspends, and the field has to mean one thing
whichever producer set it, or the tolerant read and the value handed to an
update function disagree about what was last known.

The written promise is kept in the same field a suspended stage uses. That makes
a dependency change supersede a write that has not settled, at no cost: the
derivation's next suspension replaces it, and the existing supersession check
then discards it. It is the same rule read from the other side — starting a new
production of the value cancels the previous one, whoever started it.

The pending flag clears when the promise settles whether or not anything is
published, since a write that settles to the value already held would otherwise
leave the signal reporting itself as loading forever."
```

---

### Task 8: A write inside an action

**Covers:** W14 (an action that commits), W15 (an action that is discarded), W16 (nested actions), W17 (the derivation lands while the action is open).

**Files:**
- Modify: `src/scope.ts` — add `onSettleOn`
- Modify: `src/derived-signal.ts` — defer the non-scope-aware effects
- Test: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: `publishValue` / `applyWriteEffects` / `cancelRun` / `clearFailure`.
- Produces:
  ```ts
  // src/scope.ts
  export function onSettleOn(scope: Scope, callback: (outcome: SettleOutcome) => void): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('W14: a write inside an action is invisible until it commits', async () => {
  const [todos, setTodos] = signal(function* () {
    return yield* read(Promise.resolve(['a']))
  })
  await tick()

  const seenInside: unknown[] = []
  await action(function* () {
    setTodos(['a', 'walk'])
    seenInside.push(use(todos))
    yield* read(Promise.resolve(null))
  })

  expect(seenInside).toEqual([['a', 'walk']])
  expect(use(todos)).toEqual(['a', 'walk'])
})

test('W15: a discarded action leaves the reload alive', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })

  resolveList(['a'])
  await tick()
  resolveList = () => {}
  setVersion(2)
  await tick()
  expect(isPending(todos)()).toBe(true)

  await expect(
    action(function* () {
      setTodos(['a', 'walk'])
      yield* read(Promise.reject(new Error('save failed')))
    }),
  ).rejects.toThrow('save failed')

  // the write rolled back and the reload was never abandoned
  expect(isPending(todos)()).toBe(true)
  resolveList(['a', 'b'])
  await tick()
  expect(use(todos)).toEqual(['a', 'b'])
})

test('W16: cancelling waits until the value reaches the committed world', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })
  resolveList(['a'])
  await tick()
  resolveList = () => {}
  setVersion(2)
  await tick()

  await expect(
    action(function* () {
      action(() => setTodos(['inner']))
      yield* read(Promise.reject(new Error('outer failed')))
    }),
  ).rejects.toThrow('outer failed')

  // the inner commit only promoted to the outer scope, which then rolled back
  expect(isPending(todos)()).toBe(true)
})
```

Add `import { action } from '../src/scope'` to the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test writable-derived`
Expected: W15 and W16 fail — `isPending(todos)()` is false, because cancelling ran at write time and was not rolled back.

- [ ] **Step 3: Add `onSettleOn` to `src/scope.ts`**

Refactor the existing `onSettle` to delegate:

```ts
/** Register a close callback on an explicit scope. Nested actions need this:
 *  an inner scope committing only promotes a value to its parent, so a callback
 *  that must wait for the committed world has to re-register on that parent
 *  rather than fire on the inner commit. */
export function onSettleOn(scope: Scope, callback: (outcome: SettleOutcome) => void): void {
  scope.cleanups.push(callback)
}

export function onSettle(callback: (outcome: SettleOutcome) => void): void {
  const scope = getCurrentScope()
  if (scope === ROOT_SCOPE) {
    throw new Error('onSettle requires an active speculative scope')
  }
  onSettleOn(scope, callback)
}
```

- [ ] **Step 4: Defer the non-scope-aware effects in the setter**

In `src/derived-signal.ts`:

```ts
import { getCurrentScope, onSettleOn, ROOT_SCOPE, type Scope } from './scope'

/** Run `effects` when the written value reaches the committed world. At the
 *  root that is now. Inside an action it is when that action commits — and for a
 *  nested action, only once the value has been promoted all the way out, since
 *  an inner commit promotes to the parent and the parent may still roll back. */
function whenCommitted(scope: Scope, effects: () => void): void {
  if (scope === ROOT_SCOPE) {
    effects()
    return
  }
  onSettleOn(scope, (outcome) => {
    if (outcome !== 'committed') return
    whenCommitted(scope.parent ?? ROOT_SCOPE, effects)
  })
}
```

and the setter:

```ts
  const setter: DerivedSetter<unknown> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(tail.readPrev())
        : next

    // Scope-aware: at the root this writes committed state, inside an action it
    // installs a slot that promotes on commit and vanishes on a discard.
    tail.publishValue(value)

    // Everything else touches state that is not scope-aware, so it waits until
    // the value is committed. Abandoning a run cannot be rolled back, and the
    // change-gate fields would otherwise be left describing a value that was.
    whenCommitted(getCurrentScope(), () => {
      tail.applyWriteEffects(value)
      for (let i = built.length - 1; i >= 0; i--) {
        built[i].cancelRun(built[i] === tail)
        built[i].clearFailure()
      }
    })
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Note that `clearFailure` moving inside `whenCommitted` is correct — the failure signal is scope-aware, so clearing it inside an action would install a slot, but clearing it at commit is simpler and gives the same observable result, and a write inside an action that never commits should not clear a committed failure.

- [ ] **Step 6: Commit**

```bash
git add src/scope.ts src/derived-signal.ts test/writable-derived.test.ts
git commit -m "feat: a write inside an action only takes effect when it commits

The written value already behaved correctly, because writing it goes through the
scope-aware path: inside an action it lands in that action's own storage and is
promoted on commit or dropped on a rollback. Everything else a write implies
does not, so it now waits for the value to reach the committed world.

That matters most for abandoning the run. Abandoning cannot be undone — a
cancelled request stays cancelled — so doing it at the moment of the write meant
a rolled-back action silently killed a reload that had nothing to do with it,
leaving the signal holding its old value with nothing scheduled to fetch a new
one. Deferring keeps the two apart: an action's speculative state does not reach
across and stop work the committed world is waiting on.

It matters for the change gate too. A write that updated the gate's comparison
fields and was then rolled back would leave them describing a value nobody has,
and the derivation later producing that same value would be suppressed.

Nested actions need the wait to be transitive. An inner action committing only
promotes the value to its parent, which may still roll back, so the callback
re-registers on the parent and only acts once the value is out at the top. That
needs a variant of the close hook which takes the scope explicitly, since the
existing one always uses the ambient one and refuses to run outside an action."
```

---

### Task 9: Writing from inside the derivation's own body

**Covers:** W22 (re-entrancy).

The guard landed in Task 3. This task proves it and decides what such a write does.

**Files:**
- Test: `test/writable-derived.test.ts`

**Interfaces:**
- Consumes: `cancelRun`'s context guard from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
test('W22: a write from inside the derivation own body does not raise', async () => {
  const [todos, setTodos] = signal(function* () {
    const list = yield* read(Promise.resolve<string[]>([]))
    if (list.length === 0) {
      setTodos(['seeded'])
      return ['seeded']
    }
    return list
  })

  await tick()
  expect(use(todos)).toEqual(['seeded'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test writable-derived`
Expected: FAIL with `TypeError: Generator is already running`, unless Task 3's guard is present, in which case it passes — record that and move on.

- [ ] **Step 3: Verify the guard**

`cancelRun` returns early when `r3GetContext() === depTracker`. Confirm `r3GetContext` is imported in `src/computed.ts` — it already is, as `getContext as r3GetContext`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/writable-derived.test.ts
git commit -m "test: a derivation may write to itself without raising

Abandoning a stage discards its generator by calling that generator's return
method, and doing that to a generator which is currently running raises. So a
stage skips abandoning its own run when the caller is its own body. The write
itself still applies. Abandoning that run would be meaningless anyway, since it
is about to finish and publish, and its publish then loses to the write because
the write has already moved the value the change gate compares against."
```

---

### Task 10: Remaining scenario coverage and documentation

**Covers:** W4 (write then a dependency changes), plus the two tests the spec calls for that no scenario implies. W17 is Task 8's; W18 is out of scope, since it needs `cancel`.

**Files:**
- Test: `test/writable-derived.test.ts`
- Modify: `docs/pulse/scenarios.md` — mark the walked scenarios as covered
- Modify: `README.md` if it documents the public surface

**Interfaces:**
- Consumes: everything.
- Produces: nothing new.

- [ ] **Step 1: Write the remaining tests**

```ts
test('W4: a dependency change after a write takes the derivation back over', async () => {
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    const v = version()
    return yield* read(Promise.resolve([`server ${v}`]))
  })
  await tick()

  setTodos(['written'])
  expect(use(todos)).toEqual(['written'])

  setVersion(2)
  expect(use(todos)).toEqual(['written']) // held while it reloads
  await tick()
  expect(use(todos)).toEqual(['server 2'])
})

test('W17: a reload that lands while an action is open is replaced at commit', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [todos, setTodos] = signal(function* () {
    version()
    return yield* read(new Promise<string[]>((r) => (resolveList = r)))
  })
  resolveList(['a'])
  await tick()

  let resolveSave: (v: null) => void = () => {}
  resolveList = () => {}
  setVersion(2)
  await tick()

  const running = action(function* () {
    setTodos(['a', 'walk'])
    yield* read(new Promise<null>((r) => (resolveSave = r)))
  })

  resolveList(['a', 'b']) // the reload lands while the action is open
  await tick()
  expect(use(todos)).toEqual(['a', 'b']) // visible outside the action

  resolveSave(null)
  await running
  expect(use(todos)).toEqual(['a', 'walk']) // replaced at commit
})

test('a read from inside an effect while an earlier stage is waiting to reload', async () => {
  let resolveList: (v: string[]) => void = () => {}
  const [version, setVersion] = signal(1)
  const [showAll, setShowAll] = signal(false)
  const [todos, setTodos] = signal(
    () => version(),
    function* () {
      return yield* read(new Promise<string[]>((r) => (resolveList = r)))
    },
    (server: string[]) => (showAll() ? server : server.slice(0, 1)),
  )
  resolveList(['a', 'b'])
  await tick()

  const seen: unknown[] = []
  effect(() => {
    seen.push(latest(todos))
  })
  await tick()

  setVersion(2)
  await tick()
  setTodos(['written'])
  await tick()

  setShowAll(true)
  await tick()
  // the effect re-ran and the earlier stage reloaded rather than serving stale data
  expect(seen.at(-1)).toEqual(['written'])
  expect(isPending(todos)()).toBe(true)
})

test('a discarded action does not leave the change gate describing a rolled-back value', async () => {
  const [version, setVersion] = signal(1)
  const [count, setCount] = signal(function* () {
    version()
    return yield* read(Promise.resolve(5))
  })
  await tick()
  expect(use(count)).toBe(5)

  await expect(
    action(function* () {
      setCount(7)
      yield* read(Promise.reject(new Error('nope')))
    }),
  ).rejects.toThrow('nope')

  expect(use(count)).toBe(5)

  // the derivation producing 5 again must not be suppressed by a gate that
  // still thinks the value is 7
  setVersion(2)
  await tick()
  expect(use(count)).toBe(5)
})
```

Add `import { effect } from '../src/effect'` to the test file.

- [ ] **Step 2: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If the last test fails, `applyWriteEffects` is running at write time inside the action rather than being deferred; re-check Task 8.

- [ ] **Step 3: Mark the scenarios as covered**

In `docs/pulse/scenarios.md`, append `✓ (Implemented and tested in `test/writable-derived.test.ts`.)` to W1 through W17 and W19 through W22. Leave W18 open with a note that it depends on the cancel verb tracked in `docs/follow-ups.md`.

- [ ] **Step 4: Commit**

```bash
git add test/writable-derived.test.ts docs/pulse/scenarios.md
git commit -m "test: cover the rest of the scenarios for writing into a derivation

Adds the remaining cases from the catalogue and two the catalogue does not
imply. One reads the signal from inside an effect while an earlier stage is
waiting to reload, which exercises the path where a consumer pulls a stage up to
date — the usual path, where a change is pushed outward, hides it. The other
discards an action whose write had moved the value the change gate compares
against, which is the failure that deferring those updates to commit exists to
prevent.

One scenario is left open: cancelling a run explicitly, which needs a verb that
is tracked separately and ships on its own."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task. The stage overload and consequences are Task 2. The implementation approach and where the setter is built are Task 2. The state a cancelled stage is left in is Tasks 3 and 5. What `publishWrite` must update is Tasks 2 and 7. Writing a promise and supersession are Task 7. Speculation is Task 8. The three defects are Tasks 6, 8 and 9. The test plan is spread across every task, with its two extra cases in Task 10. Registry integration is deliberately absent: the spec places it behind `cancel(x)`, which is out of scope.

**Placeholders.** None. Every code step carries the code. Tasks 4, 5 and 9 are test-only by design, because their implementation lands earlier — each says so and says what to check if the test does not fail first.

**Type consistency.** `StageHandle` is defined once in the File Structure section and grows in Tasks 2, 3 and 6, each naming the field it adds. `DerivedSetter<T>` is defined in Task 2 and used unchanged after. `cancelRun(isTail: boolean)`, `clearFailure()`, `publishValue(value)`, `applyWriteEffects(value)` and `readPrev()` keep the same names and signatures throughout. `cancelRecompute(el, keepDirty?)` and `isRecomputeQueued(el)` match Task 1's definitions everywhere they appear.

**Known ordering risk.** Task 8 moves `clearFailure` inside the deferred block, after Task 6 introduced it in the immediate path. Task 8's step 5 calls this out explicitly so it is not read as an accident.

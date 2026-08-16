# Generator Stage Resumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a suspended generator stage resume forward instead of being rebuilt and re-executed from its first line, so that a generator that creates its promise inside the body converges instead of looping forever.

**Architecture:** A suspended generator is retained on its stage node and resumed with `gen.next(value)`. Because resuming runs only the code after the pause, and r3 rebuilds a computed's dependency list from the reads that occur during each run, the stage first re-reads the dependencies r3 recorded before the pause. That re-read keeps them linked, and its return values decide whether to resume at all: if any changed, the retained generator is disposed with `gen.return()` and a fresh one runs from the top.

**Tech Stack:** TypeScript, vitest, r3 (the reactive graph pulse is built on), pnpm.

**Spec:** [`docs/adr/0013-generator-stages-resume-with-dependency-replay.md`](../../adr/0013-generator-stages-resume-with-dependency-replay.md)

## Global Constraints

- Package manager is **pnpm**. Run tests with `pnpm exec vitest run <path>`. Never use npm or npx.
- All source is TypeScript. Never author a `.mjs` or `.js` file.
- Commit messages stand alone: no references to this plan, to task numbers, or to outside context. Describe what the change does. Never append co-author or generated-by trailers.
- The change is confined to **generator stages**. Sync stages, async-function stages, and `use()` suspension in effects and bindings keep re-executing from the top. No task may alter their behaviour.
- The existing test suite is the behaviour specification. `pnpm exec vitest run` must be green at the end of every task.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/dep-replay.ts` | **New.** Reads r3's dependency list off a node and replays it. Two functions, no pulse-specific knowledge. |
| `src/generator-cleanup.ts` | **New.** One ambient slot naming the cleanup list of the generator currently being driven. Imports nothing but a type, so both `driver.ts` and `owner.ts` can depend on it without a cycle. |
| `src/driver.ts` | Modified. Carries the paused generator out of a pending outcome, gains an entry point that drives an existing generator forward, and brackets each segment so `onCleanup` can find the generator. |
| `src/owner.ts` | Modified. `onCleanup` routes to the generator being driven, when there is one, before it considers the r3 node. |
| `src/computed.ts` | Modified. `makeStageNode` retains the generator, decides resume versus restart, and ends a generator through its `finally` blocks and registered cleanups. |
| `test/dep-replay.test.ts` | **New.** Unit tests for the replay module against r3 directly. |
| `test/generator-resume.test.ts` | **New.** Behaviour tests for resumption, restart, and teardown. |
| `test/generator-cleanup.test.ts` | **New.** Behaviour tests for `onCleanup` timing inside a generator stage. |
| `test/driver.test.ts` | Modified. Adds coverage for the new driver entry point. |
| `CONTEXT.md` | Modified. The re-entry granularity statement gains a third level. |

---

### Task 1: Driver carries the generator and can resume one

**Files:**
- Modify: `src/driver.ts` (whole file)
- Test: `test/driver.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `StageOutcome` pending variant gains an optional `gen?: Generator<unknown, unknown, unknown>` field. Only generator stages set it.
  - `export type Resumption = { throw: false; value: unknown } | { throw: true; reason: unknown }`
  - `export function resumeStage(gen: Generator<unknown, unknown, unknown>, seed: Resumption): StageOutcome`
  - `runStage(stage, input)` keeps its existing signature.

- [ ] **Step 1: Write the failing tests**

In `test/driver.test.ts`, change the existing import on line 2 from
`import { runStage } from '../src/driver'` to:

```ts
import { resumeStage, runStage } from '../src/driver'
```

Do not add a second import statement, and do not import `Resumption` — the
tests below build the seed objects inline and never name the type.

One pre-existing test must also change. `'generator stage yielding a pending
promise -> suspended'` asserts `expect(r).toEqual({ pending: true, promise: p })`.
`toEqual` is full deep equality, so once the pending outcome carries a defined
`gen` for generator stages that assertion fails. Replace it with an equally
strict form that also covers the new field:

```ts
  expect(r.pending).toBe(true)
  if (!r.pending) throw new Error('expected pending')
  expect(r.promise).toBe(p)
  expect(r.gen).toBeDefined()
```

`toBe` on the promise keeps the original reference-equality check. No other
pre-existing test changes.

Then append:

```ts
test('a suspended generator stage hands its generator back in the outcome', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    const x: number = (yield p) as number
    return x + 1
  }, undefined)
  expect(outcome.pending).toBe(true)
  if (!outcome.pending) throw new Error('expected pending')
  expect(outcome.gen).toBeDefined()
  expect(typeof outcome.gen!.next).toBe('function')
})

test('resumeStage drives a retained generator forward with a value', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    const x: number = (yield p) as number
    return x + 100
  }, undefined)
  if (!outcome.pending) throw new Error('expected pending')
  const resumed = resumeStage(outcome.gen!, { throw: false, value: 5 })
  expect(resumed).toEqual({ pending: false, value: 105 })
})

test('resumeStage does not re-run the code before the pause', () => {
  let before = 0
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    before++
    const x: number = (yield p) as number
    return x
  }, undefined)
  if (!outcome.pending) throw new Error('expected pending')
  expect(before).toBe(1)
  resumeStage(outcome.gen!, { throw: false, value: 1 })
  expect(before).toBe(1)
})

test('resumeStage with a throw seed reaches the generator try/catch', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(function* () {
    try {
      yield p
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  }, undefined)
  if (!outcome.pending) throw new Error('expected pending')
  const resumed = resumeStage(outcome.gen!, { throw: true, reason: new Error('boom') })
  expect(resumed).toEqual({ pending: false, value: 'caught: boom' })
})

test('a generator that pauses twice hands back the same generator each time', () => {
  const p1 = new Promise<number>(() => {})
  const p2 = new Promise<number>(() => {})
  const first = runStage(function* () {
    const a: number = (yield p1) as number
    const b: number = (yield p2) as number
    return a + b
  }, undefined)
  if (!first.pending) throw new Error('expected pending')
  const second = resumeStage(first.gen!, { throw: false, value: 1 })
  if (!second.pending) throw new Error('expected pending')
  expect(second.gen).toBe(first.gen)
  expect(resumeStage(second.gen!, { throw: false, value: 2 })).toEqual({
    pending: false,
    value: 3,
  })
})
```

Also assert that a sync stage's outcome is unchanged — add this so a later refactor cannot quietly attach a generator to non-generator stages:

```ts
test('a sync stage outcome carries no generator', () => {
  const p = new Promise<number>(() => {})
  const outcome = runStage(() => p, 0)
  if (!outcome.pending) throw new Error('expected pending')
  expect(outcome.gen).toBeUndefined()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/driver.test.ts`
Expected: FAIL. The new imports `resumeStage` and `Resumption` do not exist, so the file fails to compile.

- [ ] **Step 3: Rewrite `src/driver.ts`**

Replace the whole file with:

```ts
import { isPromise } from './is-promise'
import { isGeneratorFunction, track } from './async'

/** Outcome of running a single stage: either a settled value, or pending on a
 *  promise. A generator stage additionally hands back the paused generator, so
 *  the caller can resume it later instead of building a new one. */
export type StageOutcome =
  | { pending: false; value: unknown }
  | {
      pending: true
      promise: Promise<unknown>
      gen?: Generator<unknown, unknown, unknown>
    }

/** How to re-enter a paused generator: with the value its pending promise
 *  fulfilled to, or with the reason it rejected. */
export type Resumption =
  | { throw: false; value: unknown }
  | { throw: true; reason: unknown }

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
 * Drive a generator from wherever it currently is. Each yielded value goes
 * through `settle`:
 * - settled value -> resume the generator with it via `gen.next`
 * - settled rejection -> resume via `gen.throw` (user's try/catch can handle it;
 *   if uncaught, the generator throws back to us and we propagate)
 * - pending -> short-circuit with `{ pending, promise, gen }`
 * The generator's own return value is itself run through `settle` (a generator
 * may `return await something` and the runtime should still wait on it).
 *
 * `seed` says how to make the first `gen.next` / `gen.throw` call. A fresh
 * generator is seeded with `undefined`, which a generator ignores on its first
 * resumption; a retained one is seeded with what its pending promise settled to.
 */
function driveGenerator(
  gen: Generator<unknown, unknown, unknown>,
  seed: Resumption,
): StageOutcome {
  let nextValue: unknown = seed.throw ? undefined : seed.value
  let nextThrow: unknown = seed.throw ? seed.reason : undefined
  let hasThrow = seed.throw
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
    if (outcome.pending) return { pending: true, promise: outcome.promise, gen }
    nextValue = outcome.value
  }
}

/**
 * Run a single pipeline stage with the given input. Detects the stage's shape
 * (generator function / async function / sync function) and dispatches.
 *
 * NOTE: async functions are not detected explicitly — an async function's
 * returned promise is handled by `settle` just like any other returned promise,
 * so the sync path catches it correctly. Generator detection is the only
 * dispatch we need; async vs sync is handled uniformly by `settle`.
 */
// `any` here is the standard implementation-signature widening for the
// variadic overloads above; narrowing to `unknown` breaks the overload contract.
export function runStage(
  stage: (value: any) => unknown,
  input: unknown,
): StageOutcome {
  if (isGeneratorFunction(stage)) {
    return driveGenerator(stage(input) as Generator<unknown, unknown, unknown>, {
      throw: false,
      value: undefined,
    })
  }
  // Sync OR async function — both return a value that `settle` handles uniformly
  // (an async function's return is always a promise; `settle` routes it through `track`).
  return settle(stage(input))
}

/**
 * Drive an already-started generator forward from the pause it is sitting at.
 * The code before that pause does not run again.
 */
export function resumeStage(
  gen: Generator<unknown, unknown, unknown>,
  seed: Resumption,
): StageOutcome {
  return driveGenerator(gen, seed)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/driver.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: PASS. Nothing else consumes the pending outcome's shape yet, so this is a pure addition.

- [ ] **Step 6: Commit**

```bash
git add src/driver.ts test/driver.test.ts
git commit -m "feat(driver): hand a paused generator back and allow resuming it

A generator stage that pauses on a promise previously left its generator to be
garbage collected, and resumption rebuilt one by calling the stage function
again. Carry the paused generator out in the pending outcome instead, and add
an entry point that drives an existing generator forward from where it stopped.

The value or rejection reason to re-enter the generator with is passed as a
seed. A fresh generator is seeded with undefined, which a generator ignores on
its first resumption, so both paths share one loop."
```

---

### Task 2: Dependency snapshot and replay

**Files:**
- Create: `src/dep-replay.ts`
- Test: `test/dep-replay.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type DepRecord = { dep: R3Signal<unknown> | R3Computed<unknown>; value: unknown }`
  - `export function snapshotDeps(node: R3Computed<unknown>, exclude: object | null): DepRecord[]`
  - `export function replayDeps(records: readonly DepRecord[]): boolean` — returns `true` if any recorded dependency's value changed.

**Why `exclude` exists.** The caller in Task 3 records the dependencies of a stage body that reads an internal `kick` signal at its top, and the settle handler bumps that signal to force the body to run. Recording it would make every settle look like a dependency change, so the stage would restart every time instead of resuming. The caller passes that signal's node here to leave it out.

**Background the implementer needs.** r3 stores a computed's dependencies as a singly linked list of `Link` objects reachable from `node.deps` via `nextDep`. `node.depsTail` is a cursor: `recompute` sets it to `null` before invoking the body, each read advances it, and everything past it is unlinked afterwards. So while a run is in progress, the list from `deps` up to and including `depsTail` is what this run has read, and anything past `depsTail` is stale leftovers from the previous run. `deps`, `depsTail`, `Link`, and `read` are all part of r3's public interface.

- [ ] **Step 1: Write the failing tests**

Create `test/dep-replay.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  computed as r3Computed,
  getContext as r3GetContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize as r3Stabilize,
  type Computed as R3Computed,
} from 'r3'
import { replayDeps, snapshotDeps, type DepRecord } from '../src/dep-replay'

test('snapshotDeps records every dependency a run read, with its value', () => {
  const a = r3Signal(1)
  const b = r3Signal(2)
  const node = r3Computed(() => r3Read(a) + r3Read(b))

  const records = snapshotDeps(node as R3Computed<unknown>, null)

  expect(records.length).toBe(2)
  expect(records.map((r) => r.value)).toEqual([1, 2])
})

test('snapshotDeps records nothing for a run that read no dependencies', () => {
  const node = r3Computed(() => 42)
  expect(snapshotDeps(node as R3Computed<unknown>, null)).toEqual([])
})

test('snapshotDeps records nothing when the cursor is null but stale entries remain', () => {
  // The case the null-cursor guard actually exists for. r3 resets the cursor to
  // null at the start of every run but leaves the list pointing at the previous
  // run's entries until that run finishes. A walk that ignored the cursor would
  // record the stale list as though this run had read it.
  //
  // The test above cannot catch that: a node that never read anything has an
  // empty list too, so it passes with the guard deleted.
  const a = r3Signal(1)
  let self: R3Computed<unknown> | null = null
  let capturedOnSecondRun: DepRecord[] | null = null
  let runs = 0

  const node = r3Computed(() => {
    runs++
    if (self === null) self = r3GetContext() as R3Computed<unknown>
    if (runs === 2) {
      // Nothing has been read yet on this run, so the cursor is null while the
      // list still holds run 1's entry for `a`.
      capturedOnSecondRun = snapshotDeps(self, null)
    }
    return r3Read(a)
  })

  expect(runs).toBe(1)
  expect(node.deps).not.toBe(null) // run 1 recorded `a`

  r3SetSignal(a, 2)
  r3Stabilize()

  expect(runs).toBe(2)
  expect(capturedOnSecondRun).toEqual([])
})

test('snapshotDeps leaves out the excluded dependency', () => {
  const a = r3Signal(1)
  const control = r3Signal(0)
  const node = r3Computed(() => {
    r3Read(control)
    return r3Read(a)
  })

  const records = snapshotDeps(node as R3Computed<unknown>, control)

  expect(records.length).toBe(1)
  expect(records[0]!.value).toBe(1)
})

test('an excluded control signal does not make replayDeps report a change', () => {
  // The failure this guards against: a caller that bumps its own control signal
  // to force a run would see every run as someone else's change.
  const a = r3Signal(1)
  const control = r3Signal(0)
  const node = r3Computed(() => {
    r3Read(control)
    return r3Read(a)
  })
  const records = snapshotDeps(node as R3Computed<unknown>, control)

  r3SetSignal(control, 1)

  expect(replayDeps(records)).toBe(false)
})

test('replayDeps reports false when nothing changed', () => {
  const a = r3Signal(1)
  const node = r3Computed(() => r3Read(a))
  const records = snapshotDeps(node as R3Computed<unknown>, null)

  expect(replayDeps(records)).toBe(false)
})

test('replayDeps reports true when a recorded dependency changed', () => {
  const a = r3Signal(1)
  const b = r3Signal(2)
  const node = r3Computed(() => r3Read(a) + r3Read(b))
  const records = snapshotDeps(node as R3Computed<unknown>, null)

  r3SetSignal(a, 99)

  expect(replayDeps(records)).toBe(true)
})

test('replayDeps reads every record even after finding a change', () => {
  // Each recorded dependency has to be read so r3 keeps it linked. A loop that
  // returned early on the first change would drop the rest.
  //
  // The last dependency is a computed rather than a signal, because a computed
  // holds a stale `.value` until something reads it. Asserting on a signal's
  // `.value` here would prove nothing: setSignal writes it directly, so it
  // would hold the new value whether or not replayDeps ever looked.
  const a = r3Signal(1)
  const source = r3Signal(3)
  const derived = r3Computed(() => r3Read(source) * 10)
  const node = r3Computed(() => r3Read(a) + r3Read(derived))
  const records = snapshotDeps(node as R3Computed<unknown>, null)
  expect(records.length).toBe(2)
  expect(derived.value).toBe(30)

  r3SetSignal(a, 99) // first record changes — a naive loop would stop here
  r3SetSignal(source, 5) // `derived` is now stale: still 30, should be 50

  // `replayDeps` must run inside a reactive context. r3's `read` only refreshes
  // a stale computed when there is a context to link into (`../r3/src/index.ts`,
  // the `if (context)` guard in `read`), and the real caller invokes this from
  // inside its own computed body, so the test reproduces that.
  let changed: boolean | undefined
  r3Computed(() => {
    changed = replayDeps(records)
    return null
  })

  expect(changed).toBe(true)
  // Only true if the walk continued past the first change and read `derived`.
  expect(derived.value).toBe(50)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/dep-replay.test.ts`
Expected: FAIL. `src/dep-replay.ts` does not exist.

- [ ] **Step 3: Create `src/dep-replay.ts`**

```ts
// src/dep-replay.ts
import {
  read as r3Read,
  type Computed as R3Computed,
  type Link,
  type Signal as R3Signal,
} from 'r3'

/** One dependency r3 recorded for a node, paired with the value it held at the
 *  moment it was recorded. */
export type DepRecord = {
  dep: R3Signal<unknown> | R3Computed<unknown>
  value: unknown
}

/**
 * Record the dependencies r3 has assembled for `node` during the current run.
 *
 * r3 keeps a node's dependencies as a linked list and reuses it across runs:
 * `recompute` resets the cursor `depsTail` to null before invoking the body,
 * each read advances it, and everything past it is unlinked once the body
 * returns. So the run's own dependencies are the list from `deps` up to and
 * including `depsTail`; anything after it is left over from the previous run
 * and is about to be discarded, which is why the walk stops at the cursor.
 *
 * A null cursor means the run has read nothing yet, so nothing is recorded.
 *
 * `exclude` names one dependency to leave out — a caller's own control signal,
 * which it changes deliberately to force a run and must therefore not mistake
 * for someone else's change. Pass null to record everything.
 */
export function snapshotDeps(
  node: R3Computed<unknown>,
  exclude: object | null,
): DepRecord[] {
  const records: DepRecord[] = []
  const stop = node.depsTail
  if (stop === null) return records
  for (let link: Link | null = node.deps; link !== null; link = link.nextDep) {
    if (link.dep !== exclude) {
      records.push({ dep: link.dep, value: link.dep.value })
    }
    if (link === stop) break
  }
  return records
}

/**
 * Read every recorded dependency, and report whether any of them changed.
 *
 * The read is the point: a dependency survives a run only by being read during
 * it, so replaying the records is what stops r3 unlinking dependencies that an
 * earlier segment of a resumed computation registered. Reading also brings a
 * computed dependency up to date and returns its current value, which is what
 * the comparison needs — so one walk both re-links and decides.
 *
 * Every record is read even once a change has been seen. Returning early would
 * re-link only part of the list and drop the rest.
 */
export function replayDeps(records: readonly DepRecord[]): boolean {
  let changed = false
  for (const record of records) {
    if (!Object.is(r3Read(record.dep), record.value)) changed = true
  }
  return changed
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/dep-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: PASS. Nothing imports the new module yet.

- [ ] **Step 6: Commit**

```bash
git add src/dep-replay.ts test/dep-replay.test.ts
git commit -m "feat: read a node's dependency list back from r3 and replay it

r3 rebuilds a computed's dependency list from the reads that happen during each
run, and unlinks anything the run did not read. A computation that runs only
part of its body therefore loses the dependencies its earlier part registered.

Add two functions that record a node's dependencies with their values, and read
them back later. The read is what keeps them linked; its return values also say
whether any of them changed, so one walk serves both purposes.

The dependencies are read from r3's own list rather than recorded as they are
requested, so this covers every dependency r3 saw however it was read."
```

---

### Task 3: Retain and resume a generator in `makeStageNode`

**Files:**
- Modify: `src/computed.ts`
- Test: `test/generator-resume.test.ts`

**Interfaces:**
- Consumes: `resumeStage`, `Resumption`, `StageOutcome` from Task 1; `snapshotDeps`, `replayDeps`, `DepRecord` from Task 2.
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Create `test/generator-resume.test.ts`:

```ts
import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { latest, read } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

test('a generator stage that builds its promise inside the body converges', async () => {
  let promisesCreated = 0
  const makePromise = () => {
    promisesCreated++
    return new Promise<number>((resolve) => setTimeout(() => resolve(7), 1))
  }

  const c = computed(function* () {
    const x: number = yield* read(makePromise())
    return x + 100
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(107)
  expect(promisesCreated).toBe(1)
})

test('the code before a pause runs once, not once per settle', async () => {
  let before = 0
  const c = computed(function* () {
    before++
    const x: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
    return x
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  expect(before).toBe(1)
})

test('a generator with two inline pauses converges and builds each promise once', async () => {
  let firstCreated = 0
  let secondCreated = 0

  const c = computed(function* () {
    const a: number = yield* read(
      new Promise<number>((resolve) => {
        firstCreated++
        setTimeout(() => resolve(1), 1)
      }),
    )
    const b: number = yield* read(
      new Promise<number>((resolve) => {
        secondCreated++
        setTimeout(() => resolve(2), 1)
      }),
    )
    return a + b
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(3)
  expect(firstCreated).toBe(1)
  expect(secondCreated).toBe(1)
})

test('a signal read before a pause stays a dependency across a resume', async () => {
  // The failure this guards against: resuming runs only the code after the
  // pause, so r3 would drop `a` unless the recorded dependencies are replayed.
  const [a, setA] = signal(1)
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* read(a)
    const p: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 1)),
    )
    return av + p
  })

  c()
  await ticks(10)
  expect(latest(c)).toBe(11)

  setA(2)
  await ticks(10)
  expect(latest(c)).toBe(12)
  expect(runs).toBeGreaterThan(1)
})

test('a rejected inline promise reaches the generator try/catch', async () => {
  const c = computed(function* () {
    try {
      yield* read(
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('boom')), 1),
        ),
      )
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe('caught: boom')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/generator-resume.test.ts`
Expected: FAIL. The first test times out or reports `latest(c)` as `undefined` with `promisesCreated` in the tens — the loop this task fixes.

- [ ] **Step 3: Add the imports to `src/computed.ts`**

Add to the existing `r3` import at line 1: `getContext as r3GetContext`, `untrack as r3Untrack`.

```ts
import { computed as r3Computed, getContext as r3GetContext, read as r3Read, setSignal as r3SetSignal, untrack as r3Untrack, unwatched, type Computed as R3Computed, type Signal as R3Signal } from 'r3'
```

Change the driver import (line 3) to:

```ts
import { runStage, resumeStage, type StageOutcome } from './driver'
```

Add a new import after it:

```ts
import { replayDeps, snapshotDeps, type DepRecord } from './dep-replay'
```

- [ ] **Step 4: Add the retained-generator state to `makeStageNode`**

First, expose the `kick` signal's underlying node, which Step 8 needs. Change
(currently `src/computed.ts:204`):

```ts
  const [kick, setKick] = signal(0)
```

to:

```ts
  const [kick, setKick] = signal(0)
  // Handed to `snapshotDeps` so this signal is left out of the recorded
  // dependencies. The settle handler bumps it deliberately to force a run, so
  // recording it would make every settle look like someone else's change — and
  // the stage would restart every time instead of resuming.
  const kickNode = kick[NODE]
```

Take the node off the accessor, not from `signalWithNode`. `signalWithNode`
returns pulse's own scope `Node<T>` as its third element, whereas the object r3
places in a dependency list is the r3 backing node — which is what `accessor[NODE]`
holds (`src/signal.ts:62-71`). Excluding the scope `Node` would never match
anything in the list, and the exclusion would silently do nothing. `NODE` is
already imported (`src/computed.ts:6`), and this mirrors how the file already
reaches the backing node elsewhere.

The first test in Step 1 is the canary for getting this wrong: it asserts exactly
one promise is created, and a failed exclusion shows up as a promise count in the
tens.

Then, immediately after `let stashedResolution: StashedResolution | null = null` (currently `src/computed.ts:146`), add:

```ts
  // A generator stage that pauses is retained here rather than rebuilt, so the
  // code before the pause does not run again. `depRecords` is what r3 had
  // recorded as this node's dependencies at the moment it paused; replaying
  // them on the next run keeps them linked (r3 unlinks anything a run does not
  // read) and says whether any of them changed. `resumeWith` carries the
  // settled outcome from the settle handler to the next body invocation,
  // because the handler clears `suspendedOn` before it kicks.
  let retainedGen: Generator<unknown, unknown, unknown> | null = null
  let depRecords: DepRecord[] = []
  let resumeWith: StashedResolution | null = null
```

- [ ] **Step 5: Add the discard helper**

Add immediately after the state declarations from Step 4:

```ts
  // Dispose a retained generator by running it to completion through its own
  // `finally` blocks, so a generator that acquired something before its pause
  // releases it. Untracked, because a `finally` body's reads must not join this
  // node's dependency list.
  const discardGen = (): void => {
    const gen = retainedGen
    retainedGen = null
    depRecords = []
    resumeWith = null
    if (gen === null) return
    try {
      r3Untrack(() => gen.return(undefined))
    } catch (e) {
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        setFailureSig(rethrown)
      }
    }
  }
```

Note: `setFailureSig` is declared at `src/computed.ts:154`, after this point in the file. That is fine — `const discardGen` is only *called* from inside the body, which runs later. If the implementer prefers, move the `discardGen` definition to just below the `failureSig` declaration instead.

- [ ] **Step 6: Stash the settled outcome on the generator settle paths**

In the `suspendOn` settle callback, the fulfilled branch currently reads (around `src/computed.ts:299`):

```ts
            if (resumeKind === 'fast-forward') {
              setKick(++kickCount)
              return
            }
```

Change to:

```ts
            if (resumeKind === 'fast-forward') {
              resumeWith = { kind: 'fulfilled', value: state.value }
              setKick(++kickCount)
              return
            }
```

The rejected branch currently reads (around `src/computed.ts:325`):

```ts
            if (resumeKind === 'fast-forward') {
              setKick(++kickCount)
              return
            }
```

Change to:

```ts
            if (resumeKind === 'fast-forward') {
              resumeWith = { kind: 'rejected', reason: state.reason }
              setKick(++kickCount)
              return
            }
```

- [ ] **Step 7: Replace the single `runStage` call in the body with the resume decision**

`src/computed.ts:292` currently reads:

```ts
      const outcome = runStage(stage, input)
```

Replace with:

```ts
      let outcome: StageOutcome
      if (retainedGen !== null) {
        // A generator is paused. Replaying the recorded dependencies keeps them
        // linked for this run and reports whether any of them changed.
        const changed = replayDeps(depRecords) || !Object.is(input, suspendedInput)
        const resumption = resumeWith
        resumeWith = null
        if (changed) {
          // Something the generator already read is different, so its partial
          // computation is stale. A generator cannot be rewound, only resumed
          // forward or replaced — so replace it.
          discardGen()
          outcome = runStage(stage, input)
        } else if (resumption === null) {
          // The body re-ran while the generator is still waiting and nothing
          // has settled. Stay paused; the dependencies were re-read above, so
          // they remain linked.
          return null
        } else {
          const gen = retainedGen
          retainedGen = null
          depRecords = []
          outcome =
            resumption.kind === 'fulfilled'
              ? resumeStage(gen, { throw: false, value: resumption.value })
              : resumeStage(gen, { throw: true, reason: resumption.reason })
        }
      } else {
        outcome = runStage(stage, input)
      }
```

- [ ] **Step 8: Retain the generator when the outcome is pending**

`src/computed.ts` currently reads (just after the block replaced in Step 7):

```ts
      if (outcome.pending) {
        suspendOn(outcome.promise, input, (state) => {
```

Change to:

```ts
      if (outcome.pending) {
        if (outcome.gen !== undefined) {
          retainedGen = outcome.gen
          // The node being recomputed is the current r3 context. Reading it from
          // there rather than from `depTracker` avoids a temporal dead zone: r3
          // invokes the body while `const depTracker = r3Computed(...)` is still
          // being initialised.
          const self = r3GetContext()
          // `kickNode` is excluded: the settle handler bumps it to force this
          // run, so recording it would report a change on every settle.
          depRecords = self === null ? [] : snapshotDeps(self, kickNode)
        }
        suspendOn(outcome.promise, input, (state) => {
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/generator-resume.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 10: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: PASS. Pay particular attention to `test/computed.test.ts`, `test/settled.test.ts`, and `test/integration-async-pipeline.test.ts` — those exercise generator stages with hoisted promises, which must keep working.

- [ ] **Step 11: Commit**

```bash
git add src/computed.ts test/generator-resume.test.ts
git commit -m "fix: resume a paused generator stage instead of rebuilding it

A generator stage that built its promise inside the body never converged.
Resumption re-invoked the stage function, producing a new generator that ran
from its first line, and the driver skipped past an earlier pause only when
that pause produced a promise object already recorded as settled. An expression
such as \`yield* read(fetchSomething())\` builds a new promise every run, so the
stage suspended, settled, ran again, and suspended again without end.

Retain the paused generator and resume it forward. Because resuming runs only
the code after the pause, and r3 rebuilds a computed's dependency list from the
reads that occur during each run, the stage first replays the dependencies r3
recorded before the pause. That replay keeps them linked and its return values
decide whether to resume: any change means the partial computation is stale, so
the generator is discarded and a fresh one runs from the top.

The code before a pause now runs once rather than once per settle, so a
generator stage body is safe to write with side effects in it."
```

---

### Task 4: Restart discards through `finally`, and disposal reaches the generator

**Files:**
- Modify: `src/computed.ts`
- Test: `test/generator-resume.test.ts` (append)

**Interfaces:**
- Consumes: `discardGen` from Task 3.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/generator-resume.test.ts`:

```ts
import { createRoot } from '../src/owner'

test('a discarded generator runs its finally block', async () => {
  const [a, setA] = signal(1)
  let opened = 0
  let closed = 0

  const c = computed(function* () {
    const av: number = yield* read(a)
    opened++
    try {
      const p: number = yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 5)),
      )
      return av + p
    } finally {
      closed++
    }
  })

  c()
  await tick() // let the first run reach its pause, but not settle
  setA(2) // dependency read before the pause changed -> discard and restart

  await ticks(10)

  expect(opened).toBe(2)
  expect(closed).toBe(2) // the discarded generator's finally ran, and the second one's
  expect(latest(c)).toBe(12)
})

test('a finally block reading a signal during a discard adds no dependency', async () => {
  // Scoped deliberately to the discard path. `untrack` wraps `gen.return()`,
  // not the whole generator — a `finally` that runs because the generator
  // completed normally runs inside the tracked body, and its reads SHOULD be
  // tracked like any other body code. So this asserts before the replacement
  // generator has had a chance to settle.
  const [a, setA] = signal(1)
  const [unrelated, setUnrelated] = signal(0)
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* read(a)
    try {
      const p: number = yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 50)),
      )
      return av + p
    } finally {
      unrelated() // read during the discard; must not become a dependency
    }
  })

  c()
  await tick()
  setA(2) // discards the first generator, running its finally untracked
  await tick()

  // The replacement is paused on its own 50ms promise and has not run its
  // finally. If the discard leaked a dependency, this write restarts the stage.
  const runsWhilePaused = runs
  setUnrelated(99)
  await ticks(3)

  expect(runs).toBe(runsWhilePaused)
})

test('disposing the owner runs a paused generator finally block', async () => {
  let closed = 0
  let dispose!: () => void

  createRoot((d) => {
    dispose = d
    const c = computed(function* () {
      try {
        return yield* read(
          new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
        )
      } finally {
        closed++
      }
    })
    c()
  })

  await tick()
  expect(closed).toBe(0) // still paused

  dispose()
  expect(closed).toBe(1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/generator-resume.test.ts`
Expected: the three new tests FAIL. `closed` is 0 where 2 is expected, and the disposal test reports 0 where 1 is expected — nothing calls `gen.return()` on disposal yet.

- [ ] **Step 3: Register the generator teardown with the owner**

In `makeStageNode`, immediately after the `discardGen` definition from Task 3 Step 5, add:

```ts
  // Owner disposal must reach a paused generator, not just unlink the r3 node,
  // so that a generator holding something across its pause releases it.
  registerWithOwner({ dispose: discardGen })
```

`registerWithOwner` is already imported at `src/computed.ts:5`.

- [ ] **Step 4: Discard the generator when a failure is reset**

The failure entry's `reset` (currently `src/computed.ts:475`) reads:

```ts
    reset: () => {
      setFailureSig(null)
      setKick(++kickCount)
    },
```

Change to:

```ts
    reset: () => {
      // A retry starts the computation over rather than resuming a generator
      // that failed part-way through.
      discardGen()
      setFailureSig(null)
      setKick(++kickCount)
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/generator-resume.test.ts`
Expected: PASS, all eight tests.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: PASS. `test/failure.test.ts` and `test/owner.test.ts` are the ones this task can disturb.

- [ ] **Step 7: Commit**

```bash
git add src/computed.ts test/generator-resume.test.ts
git commit -m "fix: run a discarded generator's finally blocks

A generator stage that is replaced because one of its dependencies changed, or
whose owner is disposed, was previously left to be garbage collected with its
finally blocks unrun. A generator that acquired something before its pause
leaked it on every restart.

Dispose a discarded generator by returning it, which runs those blocks. The
return runs untracked so a finally body's reads do not join the node's
dependency list, and a throw from one routes to the failure handler.

Owner disposal now reaches a paused generator in addition to unlinking the
node, and resetting a parked failure discards the generator so a retry starts
over rather than resuming a computation that failed part-way through."
```

---

### Task 5: `onCleanup` binds to the generator's lifetime

**Files:**
- Create: `src/generator-cleanup.ts`
- Modify: `src/driver.ts`, `src/owner.ts:325-341`, `src/computed.ts`
- Test: `test/generator-cleanup.test.ts`

**Interfaces:**
- Consumes: `discardGen` from Task 3 Step 5, which this task replaces with `endGen`.
- Produces:
  - `export function collectGeneratorCleanups<T>(into: Disposable[], fn: () => T): T`
  - `export function currentGeneratorCleanups(): Disposable[] | null`
  - `export function takeGeneratorCleanups(gen: Generator<unknown, unknown, unknown>): Disposable[]` (from `src/driver.ts`)

**Why this is needed.** `onCleanup` registers on the r3 node (`src/owner.ts:334`), and r3 runs a node's callbacks at the start of every recompute and then clears them (`../r3/src/index.ts:162` calls `runDisposal`, defined at `:421`). Re-executing the body from the top kept that balanced. Resuming does not: the code before the pause runs once, so the callback registers once, but the settle still triggers a recompute — so r3 fires it *before* the generator resumes. A generator that acquires a resource before its pause would have it torn down at the moment its first result arrives.

- [ ] **Step 1: Write the failing tests**

Create `test/generator-cleanup.test.ts`:

```ts
import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { latest, read } from '../src/async'
import { createRoot, onCleanup } from '../src/owner'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

test('onCleanup before a pause does not fire when the generator resumes', async () => {
  const events: string[] = []

  const c = computed(function* () {
    onCleanup(() => events.push('cleanup'))
    const x: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
    events.push('after-pause')
    return x
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  // The cleanup must not have run before the code after the pause.
  expect(events).toEqual(['after-pause', 'cleanup'])
})

test('onCleanup fires when the generator completes', async () => {
  let cleaned = 0

  const c = computed(function* () {
    onCleanup(() => cleaned++)
    return yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  expect(cleaned).toBe(1)
})

test('onCleanup fires when the generator is discarded on a dependency change', async () => {
  const [a, setA] = signal(1)
  let cleaned = 0

  const c = computed(function* () {
    const av: number = yield* read(a)
    onCleanup(() => cleaned++)
    const p: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 5)),
    )
    return av + p
  })

  c()
  await tick() // reach the pause without settling
  expect(cleaned).toBe(0)

  setA(2)
  await ticks(10)

  expect(latest(c)).toBe(12)
  expect(cleaned).toBe(2) // the discarded generator's, then the replacement's
})

test('onCleanup fires when the owner is disposed while paused', async () => {
  let cleaned = 0
  let dispose!: () => void

  createRoot((d) => {
    dispose = d
    const c = computed(function* () {
      onCleanup(() => cleaned++)
      return yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
      )
    })
    c()
  })

  await tick()
  expect(cleaned).toBe(0)

  dispose()
  expect(cleaned).toBe(1)
})

test('cleanups run most recently registered first, after finally blocks', async () => {
  const [a, setA] = signal(1)
  const events: string[] = []

  const c = computed(function* () {
    const av: number = yield* read(a)
    onCleanup(() => events.push('first'))
    onCleanup(() => events.push('second'))
    try {
      const p: number = yield* read(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 5)),
      )
      return av + p
    } finally {
      events.push('finally')
    }
  })

  c()
  await tick()
  events.length = 0 // ignore anything from the first run reaching its pause
  setA(2)
  await tick()

  expect(events).toEqual(['finally', 'second', 'first'])
})

test('onCleanup outside a generator stage is unchanged', async () => {
  // A sync stage re-runs from the top, so per-run cleanup is still the right
  // meaning there. This guards the routing change from leaking.
  const [a, setA] = signal(1)
  let cleaned = 0

  const c = computed(() => {
    onCleanup(() => cleaned++)
    return a() * 2
  })

  expect(c()).toBe(2)
  setA(2)
  await ticks(3)
  expect(c()).toBe(4)
  expect(cleaned).toBe(1) // fired before the re-run
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/generator-cleanup.test.ts`
Expected: FAIL. The first test reports `['cleanup', 'after-pause']` — r3 fired the callback before the resumed body ran.

- [ ] **Step 3: Create `src/generator-cleanup.ts`**

```ts
// src/generator-cleanup.ts
import type { Disposable } from 'r3'

/**
 * The cleanup list of the generator stage currently being driven, or null when
 * no generator stage is running.
 *
 * This is the "current X" ambient slot pattern with a save-restore wrapper. It
 * is sound here for the reason it would not be across `await`: pulse calls
 * `gen.next()` itself and regains control at every yield, so every segment of a
 * generator body runs synchronously inside the wrapper.
 *
 * It lives in its own module, importing only a type, so that both the driver
 * (which sets it) and the owner module (which reads it) can depend on it
 * without an import cycle.
 */
let current: Disposable[] | null = null

/** Run `fn` with `into` as the cleanup list any `onCleanup` call should join. */
export function collectGeneratorCleanups<T>(into: Disposable[], fn: () => T): T {
  const saved = current
  current = into
  try {
    return fn()
  } finally {
    current = saved
  }
}

/** The cleanup list to register with, or null when no generator is running. */
export function currentGeneratorCleanups(): Disposable[] | null {
  return current
}
```

- [ ] **Step 4: Bracket each generator segment in `src/driver.ts`**

Add the imports:

```ts
import type { Disposable } from 'r3'
import { collectGeneratorCleanups } from './generator-cleanup'
```

Add above `driveGenerator`:

```ts
/** Cleanups registered through `onCleanup` while a generator was being driven.
 *  Held against the generator rather than the stage node, because the callbacks
 *  belong to that generator's lifetime and the node recomputes more often than
 *  the generator restarts. */
const cleanupsByGen = new WeakMap<Generator<unknown, unknown, unknown>, Disposable[]>()

/** Hand over a generator's registered cleanups and forget them. Returns an
 *  empty array when it registered none. */
export function takeGeneratorCleanups(
  gen: Generator<unknown, unknown, unknown>,
): Disposable[] {
  const list = cleanupsByGen.get(gen)
  if (list === undefined) return []
  cleanupsByGen.delete(gen)
  return list
}
```

In `driveGenerator`, replace:

```ts
    const result = hasThrow ? gen.throw(nextThrow) : gen.next(nextValue)
```

with:

```ts
    let list = cleanupsByGen.get(gen)
    if (list === undefined) {
      list = []
      cleanupsByGen.set(gen, list)
    }
    // Wrap only the generator's own execution. `settle` below must not collect.
    const result = collectGeneratorCleanups(list, () =>
      hasThrow ? gen.throw(nextThrow) : gen.next(nextValue),
    )
```

- [ ] **Step 5: Route `onCleanup` in `src/owner.ts`**

Add the import:

```ts
import { currentGeneratorCleanups } from './generator-cleanup'
```

Replace `src/owner.ts:325-341` with:

```ts
/**
 * Register a cleanup function. Routing rules:
 * - Inside a generator stage being driven: registers on that generator — fires
 *   when the generator ends, whether it completes, is discarded because a
 *   dependency changed, or its owner is disposed. Per-run cleanup has no
 *   coherent meaning in a body that resumes rather than re-running, so the
 *   generator's lifetime is used instead.
 * - Inside an r3 context (a running computed/effect body): registers per-run
 *   cleanup via r3 — fires before the next re-run of that node.
 * - Outside r3 context, inside a `createRoot` callback: registers on the
 *   current owner — fires on `dispose()`.
 * - Outside both: silently no-op (permissive).
 */
export function onCleanup(fn: Disposable): Disposable {
  // Checked before the r3 context, because driving a generator happens inside
  // an r3 context and the generator's lifetime is the more specific answer.
  const generatorCleanups = currentGeneratorCleanups()
  if (generatorCleanups !== null) {
    generatorCleanups.push(fn)
    return fn
  }
  if (getContext() !== null) {
    return r3OnCleanup(fn)
  }
  if (currentOwner !== null && !currentOwner.disposed) {
    currentOwner.cleanups.push(fn)
  }
  return fn
}
```

- [ ] **Step 6: Replace `discardGen` with `endGen` in `src/computed.ts`**

Change the driver import to add `takeGeneratorCleanups`:

```ts
import { runStage, resumeStage, takeGeneratorCleanups, type StageOutcome } from './driver'
```

Replace the `discardGen` definition added in Task 3 Step 5 with:

```ts
  /**
   * End a generator: run its `finally` blocks if it has not already finished,
   * then its registered cleanups, most recently registered first. Untracked,
   * because teardown reads must not join this node's dependency list.
   *
   * `viaReturn` is true when the generator is being abandoned part-way and
   * false when it has already run to completion, in which case its `finally`
   * blocks have run and returning it again would be a no-op.
   */
  const endGen = (
    gen: Generator<unknown, unknown, unknown>,
    viaReturn: boolean,
  ): void => {
    retainedGen = null
    depRecords = []
    resumeWith = null
    const cleanups = takeGeneratorCleanups(gen)
    try {
      r3Untrack(() => {
        if (viaReturn) gen.return(undefined)
        for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]()
      })
    } catch (e) {
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        setFailureSig(rethrown)
      }
    }
  }

  /** Abandon a generator that has not finished. */
  const discardGen = (): void => {
    const gen = retainedGen
    retainedGen = null
    depRecords = []
    resumeWith = null
    if (gen !== null) endGen(gen, true)
  }
```

- [ ] **Step 7: Stop clearing `retainedGen` before resuming, and end it on completion**

In the block added in Task 3 Step 7, the resume branch currently reads:

```ts
        } else {
          const gen = retainedGen
          retainedGen = null
          depRecords = []
          outcome =
            resumption.kind === 'fulfilled'
              ? resumeStage(gen, { throw: false, value: resumption.value })
              : resumeStage(gen, { throw: true, reason: resumption.reason })
        }
```

Change to keep the reference, so completion can be detected:

```ts
        } else {
          const gen = retainedGen
          depRecords = []
          outcome =
            resumption.kind === 'fulfilled'
              ? resumeStage(gen, { throw: false, value: resumption.value })
              : resumeStage(gen, { throw: true, reason: resumption.reason })
        }
```

Immediately after the whole `if (retainedGen !== null) { … } else { … }` block that computes `outcome`, and before `if (outcome.pending) {`, add:

```ts
      // A resumed generator that did not pause again has run to completion. Its
      // `finally` blocks have already run, so only its registered cleanups fire.
      if (!outcome.pending && retainedGen !== null) {
        endGen(retainedGen, false)
      }
```

- [ ] **Step 8: End the generator when the body throws**

In the `catch (e)` block at the end of the stage body (currently `src/computed.ts:367`), add `discardGen()` as the first statement of the non-`NotReadyYet` path, immediately before `routeError` is attempted:

```ts
      try {
        discardGen()
        routeError(myOwner, e)
      } catch (rethrown) {
        setFailureSig(rethrown)
      }
```

Calling `gen.return()` on a generator that already threw is a harmless no-op that reports `{ done: true }`, so this is safe whether the throw came from the generator or from elsewhere in the body.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/generator-cleanup.test.ts`
Expected: PASS, all six tests.

- [ ] **Step 10: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: PASS. `test/owner.test.ts`, `test/generator-resume.test.ts`, and the DOM binding tests are the ones this task can disturb, since `onCleanup` is used throughout `src/dom/`.

- [ ] **Step 11: Commit**

```bash
git add src/generator-cleanup.ts src/driver.ts src/owner.ts src/computed.ts test/generator-cleanup.test.ts
git commit -m "fix: bind onCleanup to the generator's lifetime inside a generator stage

onCleanup registers on the r3 node, and r3 runs a node's callbacks at the start
of every recompute. Re-executing a generator body from the top kept that
balanced, because the body re-registered on every run. Resuming does not: the
code before the pause runs once, so a callback registers once, but the settle
still triggers a recompute — so the callback fired before the generator was
resumed. A generator that acquired a resource before its pause would have had
it torn down at the moment its first result arrived.

While a generator stage is being driven, onCleanup now registers on that
generator, and its callbacks run when the generator ends: on completion, on
being discarded because a dependency changed, or on owner disposal. That is the
same moment the generator's finally blocks run, so both teardown mechanisms a
generator stage offers mean the same thing. Callbacks run most recently
registered first, after the finally blocks.

onCleanup therefore means per-generator inside a generator stage and per-run
everywhere else. Per-run has no coherent reading in a body that does not re-run,
so its documentation now states both."
```

---

### Task 6: Record the three levels of re-entry granularity

**Files:**
- Modify: `CONTEXT.md:72-85`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Replace the within-stage paragraph**

`CONTEXT.md` currently reads, as the second bullet of the Pipeline section:

```markdown
- **Within a single stage, pulse re-executes from the top.** A binding-effect
  or single-stage computed that suspends on `use(x)` does NOT truly resume on
  settle — it re-runs the body from the start. The kick-on-settle mechanism
  just marks the effect dirty; the body restarts. Same model as React Suspense
  ("re-execute on settle," not true continuation resumption). Generator stages
  do approximate multi-shot WITHIN a stage's yields via restart-from-top +
  WeakMap fast-forward (cached yielded values replay synchronously on re-run),
  but the body still re-executes from the top.

So pulse is true delimited continuations at the **stage-decomposition**
granularity; re-execution-with-cache at the **within-stage** granularity. This
distinction matters: the stage boundary is where pulse gets genuine "rest of
the computation runs with a different value" semantics; everything within a
single stage runs from the top each time.
```

Replace with:

```markdown
- **A generator stage resumes, once per pause.** The paused generator is
  retained and re-entered with `gen.next(value)`, so the code before the pause
  does not run again. This is genuine continuation resumption, but only
  forward: a JavaScript generator cannot be re-entered at an earlier point, so
  a change to any dependency the generator already read discards it and runs a
  fresh one from the top — reissuing any asynchronous work an earlier segment
  had completed. Because resuming runs only the code after the pause, and r3
  rebuilds a dependency list from the reads a run makes, the stage replays the
  dependencies recorded before the pause so they stay linked.
- **Everything else within a stage re-executes from the top.** A
  binding-effect, or a sync or async-function stage, that suspends on `use(x)`
  does NOT resume — it re-runs the body from the start. The kick-on-settle
  mechanism just marks the node dirty; the body restarts. Same model as React
  Suspense ("re-execute on settle," not true continuation resumption).

So pulse has three levels. **Stage boundaries** are multi-shot: a stage is
re-invoked with a new input any number of times, without re-running upstream
stages. **Within a generator stage** is single-shot resumption: the
continuation runs forward once per pause, and a dependency change replaces it
rather than rewinding it. **Everywhere else within a stage** is re-execution
from the top. The distinction matters: the stage boundary is the only place
pulse gets genuine "rest of the computation runs with a *different* value"
semantics, which is why a stage boundary is where you put work that should not
be redone.
```

- [ ] **Step 2: Verify no other statement in `CONTEXT.md` contradicts this**

Run: `grep -n "fast-forward\|restart-from-top\|WeakMap fast" CONTEXT.md`
Expected: the `computed` JSDoc summary near the Computed entry may still describe fast-forward resumption. If any hit remains that describes a generator stage restarting from the top, update it to say it resumes.

- [ ] **Step 3: Verify the same for the `computed` JSDoc**

Run: `grep -n "fast-forward\|restarts from\|re-invoked from scratch" src/computed.ts`

Locate every hit by content, not by line number — Tasks 3, 4, and 5 all edit
`src/computed.ts` before this task runs, so any line number quoted here would
be stale.

Expected: the `computed` JSDoc block describes generator resumption as "the stage is re-invoked from scratch; the driver fast-forwards through the WeakMap-cached settled yield". Replace that bullet with:

```ts
 * - Generator stage → 'resume': the paused generator is retained and re-entered
 *   with the settled value, so the code before the pause does not run again.
 *   The dependencies r3 recorded before the pause are replayed first, both to
 *   keep them linked and to detect a change — a changed dependency discards the
 *   generator (running its `finally` blocks) and runs a fresh one from the top.
```

The `ResumeKind` type name `'fast-forward'` may stay as-is or be renamed to `'resume'`. If renamed, find every use with `grep -n "fast-forward" src/computed.ts` and change them all — again by content, since earlier tasks have moved them.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: PASS. This task changes documentation and possibly one identifier.

- [ ] **Step 5: Commit**

```bash
git add CONTEXT.md src/computed.ts
git commit -m "docs: describe the three levels of re-entry granularity

The pipeline section described two levels: multi-shot re-entry at stage
boundaries, and re-execution from the top within a stage. A generator stage now
sits between them — its paused generator is retained and re-entered forward,
once per pause, and a change to a dependency it already read replaces it rather
than rewinding it.

Stage boundaries remain the only place with multi-shot re-entry, because a
JavaScript generator cannot be re-entered at an earlier point. That is also why
a stage boundary is where work that should not be redone belongs."
```

---

### Task 7: Record what the change makes obsolete

**Files:**
- Modify: `docs/follow-ups.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Why this is its own task.** Two pieces of existing code became unnecessary or were found dead during this work. Neither should be removed in the same change that fixes the bug — removing them is a separate decision with its own risk — but both must be recorded or they will be rediscovered.

- [ ] **Step 1: Mark the resolved entry**

`docs/follow-ups.md` has an entry beginning `**(worth) No test for within-generator restart-from-top with multiple `yield*` points, and the untested case is broken.**` Move it from the `## Open` section into a `## Resolved` section at the end of the file (create the section if it does not exist), and prefix the entry body with:

```markdown
  **Resolved.** Generator stages now resume rather than restart; see
  [ADR 0013](./adr/0013-generator-stages-resume-with-dependency-replay.md) and
  `test/generator-resume.test.ts`.
```

- [ ] **Step 2: Add the two new entries**

Add to the `### Test coverage gaps` section:

```markdown
- **(small) `settled`'s already-settled filter is no longer load-bearing.** `settled` (`src/async.ts:236`) yields a `Promise.all` built inline, which is the shape that used to loop forever, and it works today because it excludes promises that have already settled (`src/async.ts:248-254`) so a re-run yields nothing. Generator stages now resume instead of re-running, so there is no re-run to filter. The filter is harmless and was left in place rather than removed alongside the resumption change. Removing it needs its own pass over `test/settled.test.ts`.
  Source: generator resumption work.
```

Add to the `### Encapsulation / structure` section:

```markdown
- **(small) `stashedResolution` in `computed.ts` is never assigned a value.** The field is declared (`src/computed.ts:146`) and cleared in three places, and the branch that reads it (`src/computed.ts:272`) tests for a non-null value that nothing ever writes, so that branch is unreachable. The async-function resumption path it was meant to serve publishes the settled value directly from the settle handler instead. Its doc comment also describes it as serving generator stages, which was never true of the code. Either delete the field and its dead branch, or make the async-function path use it. Note that generator resumption added a separate field, `resumeWith`, rather than reviving this one.
  Source: generator resumption work.
```

- [ ] **Step 3: Commit**

```bash
git add docs/follow-ups.md
git commit -m "docs: record what generator resumption made obsolete

The filter in settled that excludes already-settled promises existed to stop a
re-run from suspending forever. Generator stages resume rather than re-run, so
the filter no longer carries weight; note it for removal separately.

Record that stashedResolution in computed.ts is never assigned, which makes the
branch reading it unreachable, and that its doc comment describes a purpose the
code never had.

Mark the entry about untested within-generator restart as resolved."
```

---

## Self-Review

**Spec coverage.** Every section of ADR 0013 maps to a task:

| ADR section | Task |
| --- | --- |
| The dependency constraint, reading the list back from r3 | 2 |
| The mechanism — retain, decide, resume | 1 and 3 |
| Rebuilding the record at each pause | 3, Step 8 |
| Resuming from the promise state map | 3, Steps 6 and 7 |
| Driver's second entry point | 1 |
| Discarding through `finally`, untracked, errors routed | 4 |
| Owner disposal reaching the generator | 4 |
| `reset` clearing the retained generator | 4, Step 4 |
| A dependency change restarts the whole stage | 3, Step 7; tested in 4 |
| `onCleanup` binds to the generator's lifetime | 5 |
| Cleanups run most-recent-first, after `finally` | 5, Step 6; tested in 5 |
| Consequence: code before a pause runs once | 3, second test |
| Consequence: `onCleanup` means per-generator here, per-run elsewhere | 5, Step 5 documents both in the JSDoc; the last test in 5 guards the elsewhere case |
| Consequence: `CONTEXT.md` gains a third level | 6 |
| Consequence: `settled`'s filter becomes unnecessary | 7 |
| Consequence: speculation path unchanged | no task — `defaultRecipe` (`src/computed.ts:168`) calls `runStage`, which is untouched. Verified by `test/speculation.test.ts` staying green in Tasks 3 and 4. |
| Consequence: over-linking on the restart path lasts one cycle | no task — accepted behaviour, arises from Step 7's ordering. Not separately testable without asserting on r3 internals. |

**Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N". Every code step carries the code. Task 6 Steps 2 and 3 are conditional greps rather than fixed edits, which is deliberate: they verify no contradictory statement survives, and they name the exact replacement text to use if one does.

**Type consistency.** `StageOutcome`'s pending variant gains `gen?`, produced in Task 1 and consumed in Task 3 Step 8. `Resumption` is produced in Task 1 and consumed in Task 3 Step 7. `DepRecord`, `snapshotDeps`, and `replayDeps` are produced in Task 2 and consumed in Task 3 Steps 3, 7, and 8. `takeGeneratorCleanups` is produced in Task 5 Step 4 and consumed in Task 5 Step 6. `collectGeneratorCleanups` and `currentGeneratorCleanups` are produced in Task 5 Step 3 and consumed in Task 5 Steps 4 and 5. `resumeWith` uses the existing `StashedResolution` type (`src/computed.ts:99-102`), whose two variants are `{kind: 'fulfilled', value}` and `{kind: 'rejected', reason}` — matching the reads in Task 3 Step 7 and the writes in Step 6.

**Deliberate rework between tasks.** `discardGen` is defined in Task 3 Step 5 as a plain `gen.return()`, used in Task 3 Step 7 and Task 4 Steps 3 and 4, then replaced in Task 5 Step 6 by `endGen` with `discardGen` kept as a thin wrapper. Its call sites do not change. This is rework rather than a first-time-right definition, and it is intended: Tasks 3 and 4 each end at a working, tested increment, and folding cleanup routing into them would have made Task 3 depend on `src/owner.ts` and `src/generator-cleanup.ts` before either was needed.

**Two risks to watch.**

1. Task 3 Step 5 defines `discardGen` before `setFailureSig` is declared. This is legal because the closure only runs later, but a reviewer may find it confusing; the step says so and offers the alternative placement.
2. Task 5 changes `onCleanup`, which `src/dom/` uses throughout (`src/dom/render.ts:30`, `src/dom/bindings.ts:35`, `:136`). The routing change only takes effect while a generator stage is being driven, and no DOM code path runs inside one — but the whole suite must be green at Task 5 Step 10, and a DOM test failure there means that assumption is wrong and needs investigating rather than working around.

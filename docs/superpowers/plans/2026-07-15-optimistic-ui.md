# Optimistic UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `optimistic()`, a wrapper that lets an in-flight action show a provisional value to consumers outside it, and `onSettle()`, a hook that fires when a speculative scope closes.

**Architecture:** `onSettle` is a small engine addition to `src/scope.ts`: the scope's existing close-callback list is retyped to carry the outcome and is now drained by both `commit()` and `discard()`. `optimistic()` is ordinary library code in a new `src/optimistic.ts`: it keeps a per-action overlay map, publishes the top-of-stack value into a signal whose write is forced to committed state (so it leaks past the action's isolation), and clears each action's overlay via `onSettle`.

**Tech Stack:** TypeScript, the pulse reactive library (r3-backed), vitest, pnpm.

## Global Constraints

- Use `pnpm` / `pnpm exec` for all commands, never `npm`/`npx`.
- Author all code and tests in TypeScript.
- Test-driven: write the failing test first, watch it fail, then implement.
- The design spec is `docs/superpowers/specs/2026-07-15-optimistic-ui-design.md`.
- Full verification for each task: `pnpm exec vitest run` is green and `pnpm exec tsc --noEmit` is clean before committing.
- Do not add AI co-author trailers to commits.

---

## File Structure

- `src/scope.ts` (modify) — add the `SettleOutcome` type, retype the `cleanups` list to carry the outcome, add the `onSettle` function, and drain the list in both `commit` and `discard`.
- `src/index.ts` (modify) — export `onSettle` and `optimistic`.
- `src/optimistic.ts` (create) — the `optimistic()` wrapper.
- `test/scope.test.ts` (modify) — `onSettle` unit tests.
- `test/optimistic.test.ts` (create) — `optimistic()` behavior tests through the public API.

---

### Task 1: `onSettle` scope-close hook

**Files:**
- Modify: `src/scope.ts`
- Modify: `src/index.ts`
- Test: `test/scope.test.ts`

**Interfaces:**
- Consumes: existing `createScope`, `runInScope`, `commit`, `discard`, `getCurrentScope`, `ROOT_SCOPE` from `src/scope.ts`.
- Produces:
  - `export type SettleOutcome = 'committed' | 'discarded'`
  - `export function onSettle(callback: (outcome: SettleOutcome) => void): void` — registers a callback fired once when the current speculative scope closes; throws when `getCurrentScope()` is `ROOT_SCOPE`.
  - `Scope.cleanups` is retyped to `Array<(outcome: SettleOutcome) => void>` and is now drained by both `commit` and `discard`.

- [ ] **Step 1: Write the failing tests**

Add `onSettle` to the existing import from `../src/scope` at the top of `test/scope.test.ts` (it currently imports `createScope, ... , action, type Scope, type Node, type Slot, type Edge`). Then append these tests to the end of the file:

```ts
test('onSettle fires with committed when the scope commits', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const seen: string[] = []
  runInScope(s, undefined, () => onSettle((outcome) => seen.push(outcome)))
  commit(s)
  expect(seen).toEqual(['committed'])
})

test('onSettle fires with discarded when the scope is discarded', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const seen: string[] = []
  runInScope(s, undefined, () => onSettle((outcome) => seen.push(outcome)))
  discard(s)
  expect(seen).toEqual(['discarded'])
})

test('onSettle fires each callback once, in last-in-first-out order', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const order: number[] = []
  runInScope(s, undefined, () => {
    onSettle(() => order.push(1))
    onSettle(() => order.push(2))
  })
  commit(s)
  expect(order).toEqual([2, 1])
})

test('onSettle throws when called with no active speculative scope', () => {
  expect(() => onSettle(() => {})).toThrow()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/scope.test.ts -t onSettle`
Expected: FAIL — `onSettle` is not exported from `../src/scope` (import error / not a function).

- [ ] **Step 3: Add the outcome type and retype the scope's close-callback list**

In `src/scope.ts`, replace the `ScopeKind` type line and the `Scope` interface (currently lines 53–66) so the outcome type is declared and `cleanups` is retyped to carry it:

```ts
export type ScopeKind = 'owner' | 'speculative'

/** How a speculative scope closed, reported to its close callbacks. */
export type SettleOutcome = 'committed' | 'discarded'

/** The ambient context primitive. Owns its slots/edges/sets/cleanups. Per Q6. */
export interface Scope {
  parent: Scope | undefined
  children: Set<Scope>
  slots: Map<Node, Slot>
  edges: Set<Edge>
  writeSet: Set<Node>
  readSet: Set<Node>
  /** Callbacks fired once when the scope closes, receiving how it closed.
   *  Registered via `onSettle`; drained by both `commit` and `discard`. A plain
   *  zero-argument callback is fine — it simply ignores the outcome. */
  cleanups: Array<(outcome: SettleOutcome) => void>
  status: 'open' | 'committed' | 'discarded'
  kind: ScopeKind
}
```

`createScope`'s `cleanups: []` initializer is unchanged (the empty array now types as the retyped list).

- [ ] **Step 4: Add the `fireSettle` helper and drain it in `commit`/`discard`**

In `src/scope.ts`, replace the whole `commit` function (currently starting at `export function commit(scope: Scope): void {`) and the `discard` function with these versions, and add the `fireSettle` helper immediately above `commit`:

```ts
/** Drain a scope's close callbacks once, in last-in-first-out order, passing
 *  how the scope closed. */
function fireSettle(scope: Scope, outcome: SettleOutcome): void {
  const callbacks = scope.cleanups
  for (let i = callbacks.length - 1; i >= 0; i--) callbacks[i](outcome)
  callbacks.length = 0
}

/** Commit a scope (ADR 0010 order): snapshot the writeSet's promoted values
 *  (before closeScopeEdges clears writeSet + drops slots), tear down the
 *  scope's pulse edges (edges-down-before-promote → no double-fire), then
 *  promote to the parent. Promoting to ROOT_SCOPE bridges to r3 via setSignal
 *  + a single stabilize (r3's InHeap-deduped heap gives Q10 batching). A
 *  speculative parent (nested actions) receives the value as a parent slot.
 *  Settle callbacks fire after promotions but before the final stabilize, so a
 *  callback's committed write (e.g. clearing an optimistic overlay) batches into
 *  the same flush as the promotions and consumers see one coherent frame. */
export function commit(scope: Scope): void {
  const promotions: Array<{ node: Node; value: unknown }> = []
  for (const node of scope.writeSet) {
    promotions.push({ node, value: scope.slots.get(node)!.cached })
  }
  closeScopeEdges(scope)
  const parent = scope.parent ?? ROOT_SCOPE
  if (parent === ROOT_SCOPE) {
    for (const { node, value } of promotions) {
      r3SetSignal(node.backing as R3Signal<unknown>, value)
    }
    fireSettle(scope, 'committed')
    stabilize()
  } else {
    for (const { node, value } of promotions) {
      writeSpeculative(node, parent, value)
    }
    fireSettle(scope, 'committed')
  }
  scope.status = 'committed'
}

/** Discard a scope: tear down edges + drop slots (no promotion), then fire
 *  close callbacks in LIFO order with 'discarded'. Speculative writes simply
 *  vanish. */
export function discard(scope: Scope): void {
  closeScopeEdges(scope)
  fireSettle(scope, 'discarded')
  scope.status = 'discarded'
}
```

- [ ] **Step 5: Add the `onSettle` function**

In `src/scope.ts`, add this after the `committed` function (currently ending around line 333):

```ts
/** Register a callback fired once when the current speculative scope closes:
 *  with 'committed' when it commits, 'discarded' when it is discarded. A caller
 *  that does not care which face closed the scope ignores the argument. Throws
 *  outside an action, where the callback would never fire. */
export function onSettle(callback: (outcome: SettleOutcome) => void): void {
  const scope = getCurrentScope()
  if (scope === ROOT_SCOPE) {
    throw new Error('onSettle requires an active speculative scope')
  }
  scope.cleanups.push(callback)
}
```

- [ ] **Step 6: Export `onSettle` from the barrel**

In `src/index.ts`, replace the scope export line:

```ts
export { action, committed } from './scope'
```

with:

```ts
export { action, committed, onSettle, type SettleOutcome } from './scope'
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/scope.test.ts -t onSettle`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the full suite and typecheck**

Run: `pnpm exec vitest run`
Expected: all files pass, no regressions.
Run: `pnpm exec tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 9: Commit**

```bash
git add src/scope.ts src/index.ts test/scope.test.ts
git commit -m "feat: fire scope-close callbacks on both faces via onSettle

A speculative scope's close-callback list is retyped to carry how the scope
closed, and both commit and discard now drain it, reporting 'committed' or
'discarded'. The new onSettle hook registers such a callback and throws
outside an action. In commit the callbacks fire after promotions but before
the final stabilize, so a callback's committed write batches into the same
flush as the promotions. This also closes the follow-up that commit never
fired scope cleanups while discard did."
```

---

### Task 2: `optimistic()` wrapper

**Files:**
- Create: `src/optimistic.ts`
- Modify: `src/index.ts`
- Test: `test/optimistic.test.ts`

**Interfaces:**
- Consumes: `onSettle`, `committed`, `getCurrentScope`, `ROOT_SCOPE`, `type Scope` from `src/scope.ts`; `signal`, `type Accessor` from `src/signal.ts`; `computed` from `src/computed.ts`; `read`, `action`, from the barrel (tests only).
- Produces:
  - `export function optimistic<T>(source: Accessor<T>): [Accessor<T>, (value: T) => void, Accessor<boolean>]`

- [ ] **Step 1: Write the failing tests**

Create `test/optimistic.test.ts`:

```ts
import { expect, test } from 'vitest'
import { action, effect, optimistic, read, signal } from '../src/index'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'

// A promise plus its resolver, so a generator action can be held in flight and
// released deliberately.
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a consumer sees the overlay value while the action is in flight', async () => {
  const [value] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const done = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
  })
  // In flight: the overlay is visible from outside the action.
  expect(optimisticValue()).toBe('draft')
  g.resolve()
  await done
})

test('the wrapped signal reads canonical truth, not the overlay', async () => {
  const [value] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const done = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
  })
  expect(value()).toBe('saved') // canonical reader untouched
  expect(optimisticValue()).toBe('draft') // overlay-aware reader
  g.resolve()
  await done
})

test('a discarded action reverts the overlay to the prior value', async () => {
  const [value] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const done = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
  })
  expect(optimisticValue()).toBe('draft')
  g.reject(new Error('server rejected'))
  await expect(done).rejects.toThrow('server rejected')
  expect(optimisticValue()).toBe('saved')
})

test('a committed action settles through to the canonical value', async () => {
  const [value, setValue] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const done = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
    setValue('draft')
  })
  expect(optimisticValue()).toBe('draft')
  g.resolve()
  await done
  expect(optimisticValue()).toBe('draft') // stayed on the predicted value
  expect(value()).toBe('draft') // canonical committed
})

test('committing does not flash the prior value through the overlay reader', async () => {
  setScheduler(syncScheduler(flush))
  try {
    const [value, setValue] = signal('saved')
    const [optimisticValue, setOptimisticValue] = optimistic(value)
    const g = gate()
    const done = action(function* () {
      setOptimisticValue('draft')
      yield* read(g.promise)
      setValue('draft')
    })
    const seen: string[] = []
    effect(() => {
      seen.push(optimisticValue())
    })
    g.resolve()
    await done
    // Across the commit the reader never showed the pre-action value.
    expect(seen).not.toContain('saved')
    expect(optimisticValue()).toBe('draft')
  } finally {
    setScheduler(microtaskScheduler(flush))
  }
})

test('isOptimistic reflects whether an overlay is live', async () => {
  const [value] = signal('x')
  const [, setOptimisticValue, isOptimistic] = optimistic(value)
  expect(isOptimistic()).toBe(false)
  const g = gate()
  const done = action(function* () {
    setOptimisticValue('y')
    yield* read(g.promise)
  })
  expect(isOptimistic()).toBe(true)
  g.resolve()
  await done
  expect(isOptimistic()).toBe(false)
})

test('two concurrent actions show the most recent write and clean up independently', async () => {
  const [value] = signal('base')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const a = gate()
  const b = gate()
  const runA = action(function* () {
    setOptimisticValue('a')
    yield* read(a.promise)
  })
  const runB = action(function* () {
    setOptimisticValue('b')
    yield* read(b.promise)
  })
  expect(optimisticValue()).toBe('b') // most recent write shows
  a.resolve()
  await runA
  expect(optimisticValue()).toBe('b') // A's cleanup left B's overlay alone
  b.resolve()
  await runB
  expect(optimisticValue()).toBe('base') // both cleared → canonical
})

test('setOptimisticValue throws when called with no active speculative scope', () => {
  const [value] = signal('x')
  const [, setOptimisticValue] = optimistic(value)
  expect(() => setOptimisticValue('y')).toThrow()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/optimistic.test.ts`
Expected: FAIL — `optimistic` is not exported from `../src/index`.

- [ ] **Step 3: Create the wrapper**

Create `src/optimistic.ts`:

```ts
import { computed } from './computed'
import { committed, getCurrentScope, onSettle, ROOT_SCOPE, type Scope } from './scope'
import { signal, type Accessor } from './signal'

/** Distinguishes "no overlay is live" from any real overlay value, including
 *  undefined, so the reader can fall back to the canonical value only when the
 *  stack is genuinely empty. */
const EMPTY = Symbol('empty')

/**
 * Wrap a signal with an optimistic-UI overlay. Returns a three-tuple:
 *
 * - a reader that returns the most recent in-flight overlay value if any action
 *   has one live, and the wrapped signal's canonical value otherwise;
 * - a setter that writes an overlay layer keyed to the enclosing action, and
 *   throws when called with no active speculative scope;
 * - a reactive boolean that is true while any overlay is live.
 *
 * The overlay deliberately leaks past a speculation's isolation: its backing
 * write is forced to committed state, so consumers binding outside the writing
 * action see it immediately and reactively. Each action's overlay is removed
 * when that action closes — on both the commit and the discard face — via
 * onSettle. Reading the wrapped signal directly still reports canonical truth.
 */
export function optimistic<T>(
  source: Accessor<T>,
): [Accessor<T>, (value: T) => void, Accessor<boolean>] {
  // One entry per action that currently has a live overlay. A Map iterates in
  // insertion order, so the most recently written entry is the top of the stack.
  const overlays = new Map<Scope, T>()
  const [top, setTop] = signal<T | typeof EMPTY>(EMPTY)

  const publishTop = (): void => {
    let current: T | typeof EMPTY = EMPTY
    for (const overlayValue of overlays.values()) current = overlayValue
    // Force the write to committed state so it is visible outside the writing
    // action and is a real reactive write, rather than being isolated to the
    // action's own speculative slot.
    committed(() => setTop(current))
  }

  const setOptimisticValue = (value: T): void => {
    const scope = getCurrentScope()
    if (scope === ROOT_SCOPE) {
      throw new Error('setOptimisticValue requires an active speculative scope')
    }
    const firstForScope = !overlays.has(scope)
    // Re-insert so a repeated write from the same action bumps it to the top of
    // the stack rather than adding a second entry.
    overlays.delete(scope)
    overlays.set(scope, value)
    publishTop()
    if (firstForScope) {
      onSettle(() => {
        overlays.delete(scope)
        publishTop()
      })
    }
  }

  const overlayReader = computed(() => {
    const current = top()
    return current === EMPTY ? source() : (current as T)
  })
  const overlayFlag = computed(() => top() !== EMPTY)

  // Thin typed forwarders: `computed` returns a Signal of a pipeline-read type,
  // so wrap it to present the plain Accessor shape this API promises.
  const optimisticValue: Accessor<T> = () => overlayReader() as T
  const isOptimistic: Accessor<boolean> = () => overlayFlag() as boolean

  return [optimisticValue, setOptimisticValue, isOptimistic]
}
```

- [ ] **Step 4: Export `optimistic` from the barrel**

In `src/index.ts`, add this line (next to the other single-primitive exports, e.g. after the `signal` export):

```ts
export { optimistic } from './optimistic'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/optimistic.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm exec vitest run`
Expected: all files pass, no regressions.
Run: `pnpm exec tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add src/optimistic.ts src/index.ts test/optimistic.test.ts
git commit -m "feat: add optimistic() for showing an in-flight action's value

optimistic(signal) returns a reader that shows the most recent in-flight
overlay value or the canonical value, a setter that writes an overlay keyed
to the enclosing action, and a reactive boolean for whether an overlay is
live. The overlay is a per-action map published into a signal whose write is
forced to committed state, so it leaks past the action's isolation and
reaches consumers outside it; each action's overlay clears when the action
closes via onSettle. A committed action settles through to the canonical
value without a flicker; a discarded one reverts to the prior value."
```

---

## Self-Review

**Spec coverage:**
- Public API `optimistic` three-tuple → Task 2.
- `onSettle(outcome)` with throw-outside-action → Task 1.
- Engine change: `cleanups` retyped to carry the outcome, both faces drain it, commit ordering before stabilize → Task 1 (steps 3–5).
- Closes the "commit does not fire scope cleanups" follow-up → Task 1: `commit` now drains `cleanups` (with `'committed'`) just as `discard` does (with `'discarded'`), so a callback registered in a scope that commits is no longer dropped.
- Overlay internals: per-action map, top-of-stack, forced-to-root write, `EMPTY` sentinel, first-write onSettle registration → Task 2 (step 3).
- Canonical pattern, commit settle-through, discard rollback, no-flicker → Task 2 tests.
- Concurrent actions (LIFO top, independent cleanup) → Task 2 test.
- `setOptimisticValue`/`onSettle` throw outside an action → both tasks' tests.

**Placeholder scan:** none — every step shows the exact code or command.

**Type consistency:** `SettleOutcome` used in `Scope.cleanups`, `fireSettle`, `onSettle`, and both `commit`/`discard` drains. The existing `test/scope.test.ts` discard test that pushes zero-argument callbacks to `s.cleanups` still typechecks, because `() => void` is assignable to `(outcome: SettleOutcome) => void`. `optimistic` returns `[Accessor<T>, (value: T) => void, Accessor<boolean>]`, matching the tuple destructured in every Task 2 test. `EMPTY` is a module-private symbol used only inside `optimistic`.

**Follow-up bookkeeping (do after both tasks land):** move the `commit() does not fire scope cleanups; discard() does` item in `docs/follow-ups.md` from Open to Already addressed, referencing the Task 1 commit.

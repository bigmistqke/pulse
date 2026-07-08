# Speculation Engine — Plan 5: Rewire the public `signal()` through the overlay

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD, checkbox steps.

**Goal:** Route the public `signal()` accessor/setter through the scope overlay (`readValue`/`writeValue`) so public signals are **scope-aware** — a write inside an `action` is speculative and isolated, `commit` promotes it, `discard` reverts — while every existing test stays green (behavior for committed reads/writes is unchanged).

**Architecture:** `signal()` currently creates a bare r3 node and reads/writes it directly (`makeAccessor` → `r3Read`/`stabilize`; setter → `r3SetSignal`). This plan makes `signal()` create a scope-layer `signalNode` (a pulse `Node` with an r3 `backing`) and route its accessor through `readValue(node)` and its setter through `writeValue(node, v)`. Because `readValue`/`writeValue`'s committed path (ambient scope `ROOT_SCOPE`) is behaviorally identical to the old code — `getContext()? r3Read(backing) : stabilize()+backing.value` for reads, `r3SetSignal(backing)` for writes — **the existing 40 test files must stay green**. `accessor[NODE]` keeps pointing at the r3 **backing** node (only `async.ts` uses `NODE`, for presence-detection), so nothing that inspects `NODE` breaks. **`computed()` is untouched** — the public computed rewire (entangled with the async pipeline) is Plan 6; until then public computeds remain committed-only.

**Tech Stack:** TypeScript, vitest (`pnpm test`), r3, the scope overlay (`src/scope.ts`).

**Migration nature.** This is a behavior-preserving rewire; the spec is the existing suite. Task 1's gate is "full suite green." If something unexpected breaks (a `NODE`-as-r3-node consumer, a scheduler-timing test), triage per the guidance in Task 1 — do not force a green by weakening a test.

---

## File structure

- **Modify: `src/signal.ts`** — `signal()` routes through the overlay. `makeAccessor` stays (still used by `computed.ts`).
- **Create: `test/signal-speculation.test.ts`** — new tests for speculation on the public signal API. (Keeps the new behavior separate from the existing `test/signal.test.ts`.)

`computed.ts` and all other files are untouched.

---

## Task 1: Route `signal()` through `readValue` / `writeValue`

**Files:** Modify `src/signal.ts`; gate on the full suite.

- [ ] **Step 1: Establish the behavior baseline.** Run the full suite first and record the pass count:

Run: `pnpm test`
Expected: 287 passing / 1 skipped (the current state). This is the baseline Task 1 must preserve.

- [ ] **Step 2: Rewire `signal()`.** In `src/signal.ts`, add the overlay import:

```ts
import { readValue, signalNode, writeValue } from './scope'
```

Replace the current `signal()` implementation with:

```ts
export function signal<T>(initial: T): [Accessor<T>, Setter<T>] {
  const node = signalNode(initial)

  // Eagerly install the .then listener on Promise values (unchanged behavior).
  if (isPromise(initial)) track(initial)

  const accessor = (() => readValue(node)) as Signal<T>
  // NODE stays the r3 backing node — async.ts's presence check and any
  // r3-node consumer keep working; the scope Node is closure-captured.
  accessor[NODE] = node.backing!

  const setter: Setter<T> = (next) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: T) => T)(untrack(() => readValue(node)))
        : next
    if (isPromise(value)) track(value)
    writeValue(node, value)
    requestFlush()
  }

  return [accessor, setter]
}
```

Notes: `makeAccessor`, `NODE`, the `Signal`/`Accessor`/`Setter` types, and all other exports stay. `r3Signal` is no longer used directly here (it moved into `signalNode`); leave the other r3 imports (`r3Read`/`r3SetSignal`/`stabilize`/`getContext`/`untrack`) — `makeAccessor` still uses them. `untrack` remains r3's `untrack` (used to read `prev` without r3-tracking; it does not change the ambient *scope*, so `readValue` still respects a speculation).

- [ ] **Step 3: Run the full suite — it must match the baseline.**

Run: `pnpm test`
Expected: 287 passing / 1 skipped — **identical to Step 1**. Committed reads/writes are unchanged, so every existing test passes.

**Triage if anything is red:**
- A test that reads `signal_accessor[NODE]` and calls an r3 op on it → confirm `NODE` is the backing node (it is, per the code above); if the test expected the *scope* Node, that's a genuine API question — stop and report, don't paper over.
- A scheduler/timing test → confirm `requestFlush()` is still called in the setter (it is). If a test depended on `r3SetSignal`'s exact synchronous fire, note the actual failure and report.
- A `typecheck` error (`pnpm exec tsc --noEmit`) on `node.backing!` → `signalNode` always sets `backing`, so the non-null assertion is sound; if TS complains elsewhere, report the exact error.
- Do NOT weaken or delete an existing test to get green. If a real behavioral difference surfaces, report BLOCKED with the failing test and the diff.

- [ ] **Step 4: Commit** — `git commit -m "feat(signal): route public signal() through the scope overlay"`

---

## Task 2: Speculation works on the public signal API

**Files:** Create `test/signal-speculation.test.ts`.

- [ ] **Step 1: Write the tests.** These prove the new capability — a public `signal` is now scope-aware:

```ts
import { expect, test } from 'vitest'
import { signal } from '../src/signal'
import { action } from '../src/scope'

test('an action commits a public signal write', () => {
  const [count, setCount] = signal(0)
  action(() => setCount(5))
  expect(count()).toBe(5)
})

test('an action discards a public signal write on throw (rollback)', () => {
  const [count, setCount] = signal(0)
  expect(() =>
    action(() => {
      setCount(5)
      throw new Error('boom')
    }),
  ).toThrow('boom')
  expect(count()).toBe(0) // rolled back — never committed
})

test('a public signal write inside an action is isolated from committed state until commit', () => {
  const [count, setCount] = signal(0)
  const seen: number[] = []
  action(() => {
    setCount(5)
    seen.push(count()) // inside the action: sees its own speculative write
  })
  expect(seen).toEqual([5])
  expect(count()).toBe(5) // committed after the action returns
})

test('the updater form reads the scope-appropriate previous value', () => {
  const [count, setCount] = signal(10)
  action(() => {
    setCount((prev) => prev + 1) // prev is the committed 10 → 11 speculative
    setCount((prev) => prev + 1) // prev is now the speculative 11 → 12
  })
  expect(count()).toBe(12)
})
```

- [ ] **Step 2: Run — expect PASS** (Task 1's rewire makes these pass with no new implementation).

Run: `pnpm exec vitest run test/signal-speculation.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 3: Full suite once more.**

Run: `pnpm test`
Expected: baseline + 4 new = green.

- [ ] **Step 4: Commit** — `git commit -m "test(signal): speculation on the public signal API (action commit/discard/isolation)"`

---

## Self-review

**Spec coverage:** route the public `signal()` through the overlay preserving committed behavior → Task 1 (gated on full-suite-green baseline match); prove public signals are now scope-aware (action commit / discard-rollback / mid-action isolation / updater reads scope-appropriate prev) → Task 2.

**Deliberately out of scope (→ Plan 6+):** the public `computed()` rewire (entangled with `computed.ts`'s async pipeline — stages, `makeStageNode`, SWR, pending); `Awaitable` read model; `reject`; `settled`; optimistic surfaces. Until Plan 6, public computeds are committed-only — a public computed read *inside* an action reads committed inputs, not the action's speculative writes. That's a known, documented gap this plan does not close (and the Task 2 tests avoid, by testing signals only).

**Placeholder scan:** none — real rewrite of `signal()`, real tests, exact commands. Task 1's "triage" steps are contingency guidance for a migration, not placeholders (the primary expectation is a clean baseline match).

**Type consistency:** `signalNode`, `readValue`, `writeValue` used with their Plan-3 signatures; `accessor[NODE] = node.backing!` keeps `NODE`'s existing `R3Node` type (`signalNode` always sets `backing`, so the assertion is sound). `Signal`/`Accessor`/`Setter` unchanged.

**Risk acknowledged:** this is the first plan to touch a file the existing suite depends on. The mitigation is that the overlay's committed path is behaviorally identical to the code it replaces, `NODE` stays the r3 backing, and `requestFlush`/`track` are preserved — so the baseline should match exactly. The full-suite gate in Task 1 Step 3 (plus the explicit no-weakening-tests rule) is what makes that safe.

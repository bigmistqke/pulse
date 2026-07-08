# Speculation Engine — Plan 4: Commit / Discard Bridge + Actions

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD, checkbox steps.

**Goal:** Add the commit/discard bridge and the `action()` wrapper (incl. nested actions) to the overlay, reproducing the `doubleName` trace **steps 5a/5b** and the **G2/G3/G4** nested cases — the "close a speculation" half of the engine.

**Architecture:** Per [ADR 0010](../../adr/0010-speculation-overlay-above-r3.md), commit is the one seam that crosses into r3, in the exact order the ADR fixed: **snapshot the writeSet values → `closeScopeEdges` → promote → (if promoting to ROOT) one `stabilize`**. Promotion targets the scope's *parent*: to `ROOT_SCOPE` it bridges via `r3.setSignal` + `stabilize` (r3's `InHeap`-deduped heap gives Q10 batching for free); to a *speculative* parent (nested actions, G2) it writes a parent slot (two-stage promotion). Discard drops slots and fires cleanups, promoting nothing. `action(body)` opens a child scope, runs the body, commits on return / discards on throw. **This plan still works on scope-layer nodes (`signalNode`/`computedNode`) — it does not rewire the public `signal()`/`computed()` accessors (that is Plan 5), so the existing 40 test files stay green untouched.**

**Tech Stack:** TypeScript, vitest (`pnpm exec vitest run`), r3 (`setSignal`, `stabilize`, `read`, `getContext`).

**Prerequisite fix (Task 1).** Plan 3's `readValue` committed-leaf branch always did `stabilize() + backing.value`, which never forms an r3 link — so *committed computeds don't react to committed writes yet*. That's needed for the commit test to show a downstream computed recompute. Task 1 makes the committed leaf r3-context-aware (the pattern `src/signal.ts:makeAccessor` already uses): inside an r3 context, `r3Read(backing)` (forms the link); outside, `stabilize()+value`. Speculative recipes run under `untrack` (context nulled), so they still take the `stabilize()+value` path — Plan 3's tests are unaffected.

---

## File structure

- **Modify: `src/scope.ts`** — the committed-leaf fix, `commit`, `discard`, `action`.
- **Modify: `test/scope.test.ts`** — tests per task.

No other files change (the existing-suite guard again).

---

## Task 1: Committed computeds react to committed writes (r3-context-aware read)

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append):

```ts
test('a committed computed reacts to a committed signal write (no speculation)', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  expect(readValue(doubleName)).toBe('foofoo')
  writeValue(name, 'bar')          // committed write (ambient is ROOT_SCOPE)
  expect(readValue(doubleName)).toBe('barbar') // committed computed recomputed
})
```

- [ ] **Step 2: Run — expect FAIL** (`readValue(doubleName)` stays `'foofoo'`: no r3 link formed, so the r3 computed never recomputes).

- [ ] **Step 3: Implement.** Add `getContext` and `read as r3Read` to the r3 import if not already present. Change `readValue`'s committed-leaf branch from:

```ts
  // committed leaf
  stabilize()
  trackRead(node, scope)
  return (node.backing as R3Signal<T>).value
```

to:

```ts
  // committed leaf: inside an r3 recompute, read through r3 so the dependency
  // link forms (committed reactivity); outside, stabilize then read the value.
  trackRead(node, scope)
  if (getContext() !== null) {
    return r3Read(node.backing as R3Signal<T>)
  }
  stabilize()
  return (node.backing as R3Signal<T>).value
```

- [ ] **Step 4: Run — expect PASS.** Also run `pnpm exec vitest run test/scope.test.ts` — all prior scope tests still green (speculative recipes run under `untrack`, so `getContext()` is null there and their behavior is unchanged).

- [ ] **Step 5: Commit** — `git commit -m "fix(scope): committed leaf reads via r3 in-context (committed reactivity)"`

---

## Task 2: `commit(scope)` — the bridge (top-level → ROOT)

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append) — `doubleName` step 5a: committing a speculative write promotes it to committed and the committed computed recomputes:

```ts
import { commit } from '../src/scope'

test('commit promotes a speculative signal write to committed (doubleName step 5a)', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  expect(readValue(doubleName)).toBe('foofoo')

  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => writeValue(name, 'bar'))
  // before commit: committed world unchanged
  expect(readValue(name)).toBe('foo')

  commit(s)
  // after commit: promoted to committed; computed recomputes
  expect(readValue(name)).toBe('bar')
  expect(readValue(doubleName)).toBe('barbar')
  expect(s.status).toBe('committed')
  expect(s.slots.size).toBe(0) // slots dropped
})
```

- [ ] **Step 2: Run — expect FAIL** (`commit` not exported).

- [ ] **Step 3: Implement** (append to `src/scope.ts`):

```ts
/** Commit a scope (ADR 0010 order): snapshot the writeSet's promoted values
 *  (before closeScopeEdges clears writeSet + drops slots), tear down the
 *  scope's pulse edges (edges-down-before-promote → no double-fire), then
 *  promote to the parent. Promoting to ROOT_SCOPE bridges to r3 via setSignal
 *  + a single stabilize (r3's InHeap-deduped heap gives Q10 batching). A
 *  speculative parent (nested actions) receives the value as a parent slot. */
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
    stabilize()
  } else {
    for (const { node, value } of promotions) {
      writeSpeculative(node, parent, value)
    }
  }
  scope.status = 'committed'
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): commit — snapshot, closeScopeEdges, promote (ADR 0010 order)"`

---

## Task 3: `discard(scope)`

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append) — `doubleName` step 5b: discard drops speculative writes and fires cleanups; committed state is untouched:

```ts
import { discard } from '../src/scope'

test('discard drops speculative writes, fires cleanups, leaves committed intact (step 5b)', () => {
  const name = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  const fired: string[] = []
  s.cleanups.push(() => fired.push('a'))
  s.cleanups.push(() => fired.push('b'))
  runInScope(s, undefined, () => writeValue(name, 'bar'))

  discard(s)
  expect(readValue(name)).toBe('foo')   // committed never moved
  expect(s.slots.size).toBe(0)          // speculative slots dropped
  expect(s.status).toBe('discarded')
  expect(fired).toEqual(['b', 'a'])     // cleanups fire LIFO
})
```

- [ ] **Step 2: Run — expect FAIL** (`discard` not exported).

- [ ] **Step 3: Implement** (append):

```ts
/** Discard a scope: tear down edges + drop slots (no promotion), then fire
 *  cleanups in LIFO order. Speculative writes simply vanish. */
export function discard(scope: Scope): void {
  closeScopeEdges(scope)
  for (let i = scope.cleanups.length - 1; i >= 0; i--) scope.cleanups[i]()
  scope.cleanups.length = 0
  scope.status = 'discarded'
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): discard — drop slots + fire cleanups LIFO"`

---

## Task 4: `action(body)` — commit on return, discard on throw

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append):

```ts
import { action } from '../src/scope'

test('action commits its writes on normal return', () => {
  const name = signalNode('foo')
  action(() => writeValue(name, 'bar'))
  expect(readValue(name)).toBe('bar')
})

test('action discards its writes when the body throws (and rethrows)', () => {
  const name = signalNode('foo')
  expect(() =>
    action(() => {
      writeValue(name, 'bar')
      throw new Error('boom')
    }),
  ).toThrow('boom')
  expect(readValue(name)).toBe('foo') // rolled back
})
```

- [ ] **Step 2: Run — expect FAIL** (`action` not exported).

- [ ] **Step 3: Implement** (append):

```ts
/** Open a speculative child of the current scope, run `body` under it, then
 *  commit on normal return or discard on throw (rethrowing). Nested actions
 *  parent to the enclosing scope, so their commit promotes to it (two-stage). */
export function action(body: () => void): void {
  const scope = createScope(getCurrentScope(), 'speculative')
  let ok = false
  try {
    runInScope(scope, undefined, body)
    ok = true
  } finally {
    if (ok) commit(scope)
    else discard(scope)
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): action — commit-on-return, discard-on-throw"`

---

## Task 5: Nested actions — two-stage promotion (G2/G3/G4)

**Files:** Modify `test/scope.test.ts` (test only — nesting falls out of Tasks 2–4).

- [ ] **Step 1: Write the trace tests** (append):

```ts
test('G2: inner action promotes to outer, outer promotes to ROOT', () => {
  const x = signalNode('x0')
  const y = signalNode('y0')
  action(() => {
    writeValue(x, 'x1')                 // outer speculative write
    action(() => writeValue(y, 'y1'))   // inner commits → promotes y to OUTER
    // still inside outer: both x and y are the outer scope's speculative state
    expect(readValue(x)).toBe('x1')
    expect(readValue(y)).toBe('y1')
    // committed world not yet touched:
    // (readValue outside the action would show x0/y0)
  })
  // outer committed → both reach ROOT
  expect(readValue(x)).toBe('x1')
  expect(readValue(y)).toBe('y1')
})

test('G3: inner commits, outer discards → nothing reaches committed', () => {
  const y = signalNode('y0')
  expect(() =>
    action(() => {
      action(() => writeValue(y, 'y1')) // inner commits to outer
      throw new Error('outer fails')     // outer discards → y1 dropped with it
    }),
  ).toThrow('outer fails')
  expect(readValue(y)).toBe('y0')
})

test('G4: inner discards, outer continues and commits', () => {
  const x = signalNode('x0')
  const y = signalNode('y0')
  action(() => {
    try {
      action(() => {
        writeValue(y, 'y1')
        throw new Error('inner fails')  // inner discards → y1 dropped
      })
    } catch {
      // swallow inner failure; outer continues
    }
    writeValue(x, 'x1')
  })
  expect(readValue(x)).toBe('x1') // outer committed
  expect(readValue(y)).toBe('y0') // inner's write never survived
})
```

- [ ] **Step 2: Run — expect PASS** (Tasks 2–4 already implement the mechanics; these tests verify the composition).

Run: `pnpm exec vitest run test/scope.test.ts` — all green.

- [ ] **Step 3: Guard the existing suite.**

Run: `pnpm test`
Expected: existing tests unchanged (only `scope.ts` + its test were modified) — the new scope tests plus ~278 pre-existing passing / 1 skip. If any other file went red, the overlay leaked — stop and investigate.

- [ ] **Step 4: Commit** — `git commit -m "test(scope): nested actions G2/G3/G4 two-stage promotion; full suite green"`

---

## Self-review

**Spec coverage:** committed reactivity (prerequisite) → Task 1; commit bridge in ADR-0010 order (snapshot → closeScopeEdges → promote → stabilize) → Task 2; discard + LIFO cleanups → Task 3; `action` commit/discard lifecycle → Task 4; nested two-stage promotion `doubleName` 5a/5b + G2/G3/G4 → Tasks 2/3/5.

**Deliberately out of scope (→ Plan 5+):** rewiring public `signal()`/`computed()` to route through `readValue`/`writeValue` (the 40-test migration); `Awaitable` reads; `reject` + version counters; `settled`; optimistic surfaces. Keeping the public accessors untouched is why the Task 5 full-suite-green guard is meaningful.

**Placeholder scan:** none — runnable tests + real implementations + exact commands throughout. `commit`'s nested branch reuses the `writeSpeculative` from Plan 3 (same module, internal) — a real reuse, not a stub.

**Type consistency:** `commit(scope)`, `discard(scope)`, `action(body)` signatures consistent across definition and call sites; `commit`'s promotion reuses `writeSpeculative(node, scope, value)` (Plan 3) and `closeScopeEdges(scope)` (Plan 1) with their existing signatures. Task 1's `getContext`/`r3Read` additions match `src/signal.ts`'s existing r3 usage.

**Correctness note on the ADR seam:** `commit` snapshots the writeSet's `cached` values *before* `closeScopeEdges` (which clears `writeSet` and drops slots — Plan 1's symmetry fix), and tears edges down *before* `setSignal` (so the torn-down pulse edges cannot double-fire alongside r3's committed fire). Both are the exact orderings ADR 0010 and its review require. The Task 2/5 tests exercise the ROOT bridge and the nested (speculative-parent) promotion, which are the two promotion targets.

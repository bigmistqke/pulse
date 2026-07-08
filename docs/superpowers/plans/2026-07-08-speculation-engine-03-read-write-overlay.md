# Speculation Engine — Plan 3: Scope-Aware Read/Write Overlay (pre-commit)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD, checkbox steps.

**Goal:** Wire Plan 1's pure scope layer into r3 per [ADR 0010](../../adr/0010-speculation-overlay-above-r3.md): a scope-aware read (`readValue`) and write (`writeValue`) that delegate to r3 for committed state and use slots + chain-match + pull recompute for speculative state — enough to reproduce the `doubleName` trace **steps 1–4** (read/write phase, pre-commit).

**Architecture:** Overlay above r3 (ADR 0010). Two ambients (Q8): `currentScope` and `currentTracker`. A pulse `Node` carries an **optional r3 `backing`** node holding committed state; committed reads/writes delegate to `r3.read`/`r3.setSignal(backing)`, speculative ones use `scope.slots`. A speculative computed miss runs its recipe **under `untrack`** (r3 context nulled — the correctness requirement from ADR 0010) with `currentTracker` set to the new slot, so inner reads form pulse edges. Speculative writes mark downstream slots dirty (pull); the next read recomputes. **This plan does not touch `signal.ts`/`computed.ts` or commit/discard** — the public-API rewire and the commit bridge are Plan 4. So the existing 40 test files must stay green untouched, and that is an explicit gate.

**Tech Stack:** TypeScript, vitest (`pnpm exec vitest run`), r3 (`read`, `setSignal`, `signal`, `computed`, `untrack`, `stabilize`).

**Design decision pinned here (Node↔r3 binding).** ADR 0010 says "committed = r3" but not the type. Decision: the pulse `Node` gains an **optional** `backing?: R3Signal | R3Computed`. Optional so Plan 1's pure-model tests (bare `{ subs: new Set() }` nodes) still typecheck and pass; present for real signal/computed nodes. Committed reads/writes act on `backing`; a node with no backing is a pure-overlay node (test-only for now).

---

## File structure

- **Modify: `src/scope.ts`** — add the two ambients, `ROOT_SCOPE`, `runInScope`, the optional `backing` field + `signalNode`/`computedNode` constructors, and `readValue`/`writeValue` + the speculative compute path.
- **Modify: `test/scope.test.ts`** — append tests for each task.

No other files change (that is the guard for the existing suite).

---

## Task 1: Two ambients + `ROOT_SCOPE` + `runInScope`

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append; merge imports):

```ts
import { ROOT_SCOPE, getCurrentScope, getCurrentTracker, runInScope } from '../src/scope'

test('current scope defaults to ROOT_SCOPE, tracker to undefined', () => {
  expect(getCurrentScope()).toBe(ROOT_SCOPE)
  expect(getCurrentTracker()).toBeUndefined()
})

test('runInScope pushes and restores the scope (and tracker) even on throw', () => {
  const s = createScope(ROOT_SCOPE, 'speculative')
  const slot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  runInScope(s, slot, () => {
    expect(getCurrentScope()).toBe(s)
    expect(getCurrentTracker()).toBe(slot)
  })
  expect(getCurrentScope()).toBe(ROOT_SCOPE)
  expect(getCurrentTracker()).toBeUndefined()
  expect(() => runInScope(s, slot, () => { throw new Error('x') })).toThrow('x')
  expect(getCurrentScope()).toBe(ROOT_SCOPE) // restored despite throw
})
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm exec vitest run test/scope.test.ts`; exports missing).

- [ ] **Step 3: Implement** (append to `src/scope.ts`):

```ts
/** The default parentless "outside any speculation" scope. */
export const ROOT_SCOPE: Scope = createScope(undefined, 'owner')

let currentScope: Scope = ROOT_SCOPE
let currentTracker: Slot | undefined = undefined

export function getCurrentScope(): Scope {
  return currentScope
}
export function getCurrentTracker(): Slot | undefined {
  return currentTracker
}

/** Run `fn` with `scope` as the ambient scope and `tracker` as the ambient
 *  slot-being-computed (Q8: the two ambients push/pop together). Restores both
 *  even if `fn` throws. */
export function runInScope<T>(scope: Scope, tracker: Slot | undefined, fn: () => T): T {
  const prevScope = currentScope
  const prevTracker = currentTracker
  currentScope = scope
  currentTracker = tracker
  try {
    return fn()
  } finally {
    currentScope = prevScope
    currentTracker = prevTracker
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): currentScope/currentTracker ambients + ROOT_SCOPE + runInScope"`

---

## Task 2: Optional r3 `backing` + node constructors

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append):

```ts
import { signalNode, computedNode } from '../src/scope'
import { read as r3Read } from 'r3'

test('signalNode wraps an r3 signal holding the committed value', () => {
  const n = signalNode(5)
  expect(n.subs.size).toBe(0)
  expect(n.backing).toBeDefined()
  expect(r3Read(n.backing!)).toBe(5)
})

test('computedNode carries the recipe as defaultRecipe and an r3 computed backing', () => {
  const n = computedNode(() => 7)
  expect(n.defaultRecipe).toBeDefined()
  expect(r3Read(n.backing!)).toBe(7)
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add the r3 import at the top of `src/scope.ts`:

```ts
import {
  computed as r3Computed,
  signal as r3Signal,
  type Computed as R3Computed,
  type Signal as R3Signal,
} from 'r3'
```

Add `backing` to the `Node` interface (optional — keeps Plan 1 pure nodes valid):

```ts
export interface Node<T = unknown> {
  defaultRecipe?: () => T | Promise<T>
  subs: Set<Edge>
  /** Committed state lives in this r3 node (ADR 0010). Absent = pure-overlay
   *  node (test-only until the public API is rewired in Plan 4). */
  backing?: R3Signal<T> | R3Computed<T>
}
```

Append the constructors:

```ts
export function signalNode<T>(initial: T): Node<T> {
  return { subs: new Set(), backing: r3Signal(initial) }
}
export function computedNode<T>(recipe: () => T): Node<T> {
  return { subs: new Set(), defaultRecipe: recipe, backing: r3Computed(recipe) }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): optional r3 backing + signalNode/computedNode"`

---

## Task 3: `readValue` / `writeValue` — committed path (ROOT delegates to r3)

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append):

```ts
import { readValue, writeValue } from '../src/scope'

test('read/write with no active speculation go through r3 (committed)', () => {
  const n = signalNode(0)
  expect(readValue(n)).toBe(0)      // ambient scope is ROOT_SCOPE
  writeValue(n, 5)
  expect(readValue(n)).toBe(5)      // committed value updated via r3
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Extend the r3 import with `read`, `setSignal`, `stabilize`:

```ts
import {
  computed as r3Computed,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  type Computed as R3Computed,
  type Signal as R3Signal,
} from 'r3'
```

Append the walks (committed branch only for now — the speculative branch is filled in Tasks 4–6):

```ts
/** Scope-aware read. Committed (no speculative slot in the chain) delegates to
 *  r3; speculative slots are handled in Tasks 4–6. */
export function readValue<T>(node: Node<T>): T {
  const scope = getCurrentScope()
  const slot = readSlot(node, scope)
  if (slot !== undefined) return slot.cached as T // speculative (Tasks 4–6)
  // committed: pull r3 up to date, then read the backing value
  stabilize()
  return (node.backing as R3Signal<T>).value
}

/** Scope-aware write. Committed (ambient scope is ROOT_SCOPE) delegates to r3;
 *  speculative writes are handled in Task 4. */
export function writeValue<T>(node: Node<T>, value: T): void {
  const scope = getCurrentScope()
  if (scope === ROOT_SCOPE) {
    r3SetSignal(node.backing as R3Signal<T>, value)
    return
  }
  // speculative — Task 4
  writeSpeculative(node, scope, value)
}
```

Add a stub `writeSpeculative` (real body in Task 4) so this compiles:

```ts
function writeSpeculative<T>(node: Node<T>, scope: Scope, value: T): void {
  writeSlot(node, scope, { recipe: () => value, cached: value, deps: [] })
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): readValue/writeValue committed path via r3"`

---

## Task 4: Speculative signal write + isolation + pull-dirty

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append):

```ts
test('a speculative write is isolated from committed state and visible under its scope', () => {
  const n = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  runInScope(s, undefined, () => writeValue(n, 'bar'))
  // committed untouched:
  expect(readValue(n)).toBe('foo')
  // visible under S:
  expect(runInScope(s, undefined, () => readValue(n))).toBe('bar')
})

test('a speculative write marks matching downstream speculative slots dirty', () => {
  const name = signalNode('foo')
  const s = createScope(ROOT_SCOPE, 'speculative')
  // a downstream slot in S that depends on `name`:
  const derivedSlot: Slot = { recipe: undefined, cached: 'stale', deps: [] }
  linkEdge(name, derivedSlot, s)
  runInScope(s, undefined, () => writeValue(name, 'bar'))
  expect(derivedSlot.cached).toBeUndefined() // dirtied (cached dropped)
})
```

- [ ] **Step 2: Run — expect FAIL** (isolation test: committed read currently sees the stub write; dirty test: cached not dropped).

- [ ] **Step 3: Implement** — replace the Task-3 stub `writeSpeculative` with the real body:

```ts
/** Speculative write: install a slot in `scope`, then mark every matching
 *  downstream speculative slot dirty (drop cached) so the next read recomputes
 *  (pull). Synchronous dirty-marking honors K1 Position C. */
function writeSpeculative<T>(node: Node<T>, scope: Scope, value: T): void {
  writeSlot(node, scope, { recipe: () => value, cached: value, deps: [] })
  for (const edge of edgesToFire(node, scope)) {
    edge.target.cached = undefined
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): speculative write — isolation + pull-dirty via edgesToFire"`

---

## Task 5: Speculative computed compute path (recipe under `untrack` + tracker)

**Files:** Modify `src/scope.ts`; Test `test/scope.test.ts`.

- [ ] **Step 1: Failing test** (append) — a computed read under a speculation computes from committed deps into an isolated slot, forming a pulse edge:

```ts
test('reading a computed under a speculation runs its recipe into an S-slot and links deps', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  const s = createScope(ROOT_SCOPE, 'speculative')
  const v = runInScope(s, undefined, () => readValue(doubleName))
  expect(v).toBe('foofoo')
  // an S-slot was created for doubleName, and name got a pulse edge into it:
  expect(s.slots.has(doubleName)).toBe(true)
  expect([...name.subs].some((e) => e.targetScope === s)).toBe(true)
})
```

- [ ] **Step 2: Run — expect FAIL** (readValue returns committed for the computed; no S-slot created).

- [ ] **Step 3: Implement** — extend `readValue`'s miss branch to run a computed's recipe under the scope. Add `untrack` to the r3 import (`untrack as r3Untrack`), and replace the committed branch of `readValue` with a recipe-aware version:

```ts
export function readValue<T>(node: Node<T>): T {
  const scope = getCurrentScope()
  const slot = readSlot(node, scope)
  if (slot !== undefined) {
    if (slot.cached === undefined && slot.recipe !== undefined) {
      slot.cached = runRecipe(slot.recipe, scope, slot) // dirtied → recompute
    }
    // record a dep edge into the currently-computing slot (Q8 tracker)
    trackRead(node, scope)
    return slot.cached as T
  }
  if (scope !== ROOT_SCOPE && node.defaultRecipe !== undefined) {
    // speculative computed miss: run the recipe into a fresh S-slot
    const newSlot: Slot<T> = { recipe: node.defaultRecipe, cached: undefined, deps: [] }
    writeSlot(node, scope, newSlot)
    newSlot.cached = runRecipe(node.defaultRecipe, scope, newSlot)
    scope.readSet.add(node)
    trackRead(node, scope)
    return newSlot.cached as T
  }
  // committed leaf
  stabilize()
  trackRead(node, scope)
  return (node.backing as R3Signal<T>).value
}

/** Run a recipe under `scope` with `slot` as the tracker, r3 context nulled so
 *  inner reads cannot form stray r3 links (ADR 0010 correctness requirement). */
function runRecipe<T>(recipe: () => T | Promise<T>, scope: Scope, slot: Slot): T {
  return r3Untrack(() => runInScope(scope, slot, () => recipe() as T))
}

/** If a slot is currently being computed under a speculation, link `node` to it. */
function trackRead(node: Node, scope: Scope): void {
  const tracker = getCurrentTracker()
  if (tracker !== undefined && scope !== ROOT_SCOPE) {
    linkEdge(node, tracker, scope)
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(scope): speculative computed compute path (untrack + tracker)"`

---

## Task 6: The `doubleName` break, end to end (steps 1–4)

**Files:** Modify `test/scope.test.ts` (test only); then run the full suite.

- [ ] **Step 1: Write the trace test** (append) — this is `doubleName` steps 1–4 through the real overlay:

```ts
test('doubleName trace steps 1-4: speculative recompute is isolated and reactive', () => {
  const name = signalNode('foo')
  const doubleName = computedNode(() => readValue(name) + readValue(name))
  const s = createScope(ROOT_SCOPE, 'speculative')

  runInScope(s, undefined, () => {
    expect(readValue(doubleName)).toBe('foofoo') // step: read under S, computes from committed
    writeValue(name, 'bar')                      // step: setName under S (speculative)
    expect(readValue(name)).toBe('bar')          // S sees its own write
    expect(readValue(doubleName)).toBe('barbar') // step: doubleName recomputes under S — THE break, fixed
  })

  // committed world never moved:
  expect(readValue(name)).toBe('foo')
  expect(readValue(doubleName)).toBe('foofoo')
})
```

- [ ] **Step 2: Run — expect PASS** (all prior tasks make this pass with no new code).

Run: `pnpm exec vitest run test/scope.test.ts` — expect all green.

- [ ] **Step 3: Guard the existing suite.** Run the full suite:

Run: `pnpm test`
Expected: the pre-existing tests are unchanged (this plan did not touch `signal.ts`/`computed.ts`/anything but `scope.ts` + its test) — ~268 passing / 1 pre-existing skip, plus the new scope tests. If anything else went red, the overlay leaked into committed behavior — stop and investigate.

- [ ] **Step 4: Commit** — `git commit -m "test(scope): doubleName trace steps 1-4 end to end; full suite green"`

---

## Self-review

**Spec coverage (against ADR 0010 + `doubleName` steps 1–4):** ambients (Q8) → Task 1; Node↔r3 binding → Task 2; committed delegation to r3 → Task 3; speculative write isolation + pull-dirty (K1 Position C) → Task 4; speculative computed path under `untrack`+tracker (the ADR's correctness requirement) → Task 5; the `doubleName` break fixed end-to-end → Task 6.

**Deliberately out of scope (→ Plan 4):** commit/discard bridge (snapshot → `closeScopeEdges` → `setSignal` → `stabilize`; `doubleName` steps 5a/5b, G2 nested); rewiring the public `signal()`/`computed()` accessors to route through `readValue`/`writeValue` (the 40-test-breakage-risk step); async/`Awaitable` reads; `reject`; `settled`. Keeping `signal.ts`/`computed.ts` untouched is why the full-suite-green guard in Task 6 is meaningful.

**Placeholder scan:** none — every step has runnable test + real implementation + exact commands. The Task-3 `writeSpeculative` "stub" is explicitly a minimal real body replaced in Task 4 (a legitimate TDD increment, not a placeholder).

**Type consistency:** `Node.backing?`, `readValue(node)`, `writeValue(node, value)`, `writeSpeculative(node, scope, value)`, `runRecipe(recipe, scope, slot)`, `trackRead(node, scope)`, `runInScope(scope, tracker, fn)`, `getCurrentScope`/`getCurrentTracker` — consistent across definitions and call sites. `runInScope` takes `(scope, tracker, fn)` from Task 1 onward, including its uses in Task 5's `runRecipe`.

**One risk to watch during execution:** `readValue`'s committed leaf branch calls `stabilize()` then reads `backing.value`. If a future caller runs `readValue` inside an r3 context, it should use `r3Read(backing)` instead (as `signal.ts`'s `makeAccessor` does). This plan's tests never run inside an r3 context, so `stabilize()+value` is correct here; Plan 4's public-API rewire must handle the in-context case. Noted so the executor doesn't "fix" it prematurely.

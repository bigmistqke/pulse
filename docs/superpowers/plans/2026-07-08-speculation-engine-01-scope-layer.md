# Speculation Engine — Plan 1: Scope + Slot + Chain-Match Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure scope/slot/chain-match data model that the pulse speculation engine rests on — the `Scope`, `Slot`, `Edge`, `Node` shapes, `chainFor`, the `chainMatch` predicate, fall-through reads, and pure fire-selection — TDD'd against the `doubleName` trace, before any r3 fire-loop integration.

**Architecture:** A new `src/scope.ts` module holds the scope-centric storage model from [Q6](../../pulse/questions.md#q6--what-is-a-scope-as-a-value) and the engine-managed chain-match from [Q1](../../pulse/questions.md#q1--fall-through-and-edge-policy). It is *pure* — no r3 wiring, no scheduling — so it can be exhaustively unit-tested against the state assertions in [`scenario-traces.md`'s `doubleName` trace](../../pulse/scenario-traces.md#doublename-under-scope-s). Per the "rework in place" decision, `owner.ts` folds into this module in a later plan (Q2 scope/owner unification); this plan does not touch `owner.ts` yet — it establishes the core the rework converges on.

**Tech Stack:** TypeScript, vitest (`pnpm test`), the r3 substrate (not touched in this plan).

**Decomposition context — this is Plan 1 of ~6:**

1. **Scope + slot + chain-match data model** (this plan) — Q1/Q6/Q9.
2. **r3 fire-loop integration + actions** (open/close, commit/discard promotion, nested) — Q10/G2. *Its first task is an r3-internals study: how `node.subs` / invalidate / schedule work, so `edgesToFire` can drive real invalidation.*
3. **Uniform `Awaitable` read model** — supersedes [ADR 0002](../../adr/0002-pending-model.md) write-back.
4. **`onConflict: 'reject'` + version counters + discard causes** — D1, failure.md.
5. **`settled([...])` coordination barrier** — async-reads-and-coordination.md.
6. **Ergonomic surfaces: `optimistic()` + standing states** — Q13/Q14.

---

## File structure

- **Create: `src/scope.ts`** — the entire scope-layer core for this plan: types (`Node`, `Slot`, `Edge`, `Scope`), `createScope`, `chainFor`, `chainMatch`, `writeSlot`, `readSlot`, `edgesToFire`, `linkEdge`, `closeScopeEdges`. One module, one responsibility: the pure storage + chain model.
- **Create: `test/scope.test.ts`** — vitest unit tests, one `test(...)` per behaviour, mirroring the `doubleName` trace steps.

No other files change in this plan.

---

## Task 1: Scope-layer types + `createScope`

**Files:**
- Create: `src/scope.ts`
- Test: `test/scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/scope.test.ts
import { expect, test } from 'vitest'
import { createScope, ROOT_KIND, type Scope } from '../src/scope'

test('createScope produces an open scope with empty bags', () => {
  const s = createScope(undefined, 'speculative')
  expect(s.parent).toBeUndefined()
  expect(s.kind).toBe('speculative')
  expect(s.status).toBe('open')
  expect(s.slots.size).toBe(0)
  expect(s.edges.size).toBe(0)
  expect(s.writeSet.size).toBe(0)
  expect(s.readSet.size).toBe(0)
  expect(s.children.size).toBe(0)
})

test('a child scope links to its parent and registers in the parent children', () => {
  const root = createScope(undefined, 'owner')
  const child = createScope(root, 'speculative')
  expect(child.parent).toBe(root)
  expect(root.children.has(child)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: FAIL — `createScope` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/scope.ts

/** Graph identity wrapping a recipe. Value is not in the Node — it is produced
 *  by handing the Node to a read walk. Per Q6. */
export interface Node<T = unknown> {
  /** Optional recipe: present ⇒ computed (run-and-isolate on read); absent ⇒
   *  signal (fall-through leaf read). Per Q7. */
  defaultRecipe?: () => T | Promise<T>
  /** Who subscribes to me — the fast write-fire index. */
  subs: Set<Edge>
}

/** A per-(Node, scope) cache cell. Uniform shape per Q9 — no `wasWritten` flag. */
export interface Slot<T = unknown> {
  recipe: (() => T | Promise<T>) | undefined
  cached: T | undefined
  deps: Edge[]
}

/** A subscription edge. Engine-managed chains (Q1 Model 1): plain source/target
 *  plus the scope the target lives in; the chain is derived at fire time. */
export interface Edge {
  source: Node
  target: Slot
  targetScope: Scope
}

export type ScopeKind = 'owner' | 'speculative'

/** The ambient context primitive. Owns its slots/edges/sets/cleanups. Per Q6. */
export interface Scope {
  parent: Scope | undefined
  children: Set<Scope>
  slots: Map<Node, Slot>
  edges: Set<Edge>
  writeSet: Set<Node>
  readSet: Set<Node>
  cleanups: Array<() => void>
  status: 'open' | 'committed' | 'discarded'
  kind: ScopeKind
}

export const ROOT_KIND: ScopeKind = 'owner'

export function createScope(parent: Scope | undefined, kind: ScopeKind): Scope {
  const scope: Scope = {
    parent,
    children: new Set(),
    slots: new Map(),
    edges: new Set(),
    writeSet: new Set(),
    readSet: new Set(),
    cleanups: [],
    status: 'open',
    kind,
  }
  if (parent !== undefined) parent.children.add(scope)
  return scope
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts test/scope.test.ts
git commit -m "feat(scope): Scope/Slot/Edge/Node types + createScope"
```

---

## Task 2: `chainFor`

**Files:**
- Modify: `src/scope.ts`
- Test: `test/scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/scope.test.ts
import { chainFor } from '../src/scope'

test('chainFor walks parents most-specific to terminal', () => {
  const root = createScope(undefined, 'owner')
  const outer = createScope(root, 'speculative')
  const inner = createScope(outer, 'speculative')
  expect(chainFor(inner)).toEqual([inner, outer, root])
  expect(chainFor(root)).toEqual([root])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: FAIL — `chainFor` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/scope.ts

/** The scope chain from `scope` (most specific) up to its parentless terminal.
 *  Per Q6: terminal is structural — walk `parent` until undefined. */
export function chainFor(scope: Scope): Scope[] {
  const chain: Scope[] = []
  let s: Scope | undefined = scope
  while (s !== undefined) {
    chain.push(s)
    s = s.parent
  }
  return chain
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts test/scope.test.ts
git commit -m "feat(scope): chainFor walks parents to terminal"
```

---

## Task 3: `writeSlot` and `readSlot` (fall-through)

**Files:**
- Modify: `src/scope.ts`
- Test: `test/scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/scope.test.ts
import { writeSlot, readSlot, type Node, type Slot } from '../src/scope'

const sigNode = (): Node => ({ subs: new Set() })

test('writeSlot stores a slot on the scope and records the write', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const slot: Slot<string> = { recipe: () => 'foo', cached: 'foo', deps: [] }
  writeSlot(name, root, slot)
  expect(root.slots.get(name)).toBe(slot)
  expect(root.writeSet.has(name)).toBe(true)
})

test('readSlot falls through the chain to the nearest slot', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [] })
  // reading under S finds no S-slot, falls through to ROOT's slot
  expect(readSlot(name, s)?.cached).toBe('foo')
  // reading a node with no slot anywhere → undefined
  expect(readSlot(sigNode(), s)).toBeUndefined()
})

test('a more-specific slot shadows an ancestor slot', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [] })
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  expect(readSlot(name, s)?.cached).toBe('bar') // S shadows ROOT
  expect(readSlot(name, root)?.cached).toBe('foo') // ROOT still sees its own
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: FAIL — `writeSlot` / `readSlot` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/scope.ts

/** Install a slot for `node` at `scope` and record the write. Firing is
 *  handled separately (see edgesToFire); this is pure storage. */
export function writeSlot(node: Node, scope: Scope, slot: Slot): void {
  scope.slots.set(node, slot)
  scope.writeSet.add(node)
}

/** Resolve `node` by walking the chain from `scope`, returning the first slot
 *  found (fall-through). Undefined if no slot exists anywhere in the chain. */
export function readSlot(node: Node, scope: Scope): Slot | undefined {
  for (const s of chainFor(scope)) {
    const slot = s.slots.get(node)
    if (slot !== undefined) return slot
  }
  return undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts test/scope.test.ts
git commit -m "feat(scope): writeSlot + readSlot with chain fall-through"
```

---

## Task 4: `chainMatch` predicate

**Files:**
- Modify: `src/scope.ts`
- Test: `test/scope.test.ts`

This is the single engine delta from r3's fire mechanism (Q1 Model 1): given a write to `(node, writeScope)`, should an edge whose target lives in some scope fire?

- [ ] **Step 1: Write the failing test**

```ts
// append to test/scope.test.ts
import { chainMatch, type Edge } from '../src/scope'

test('chainMatch fires when writeScope is in the target chain and unshadowed', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: root }
  // write to ROOT, consumer target at ROOT → fires
  expect(chainMatch(edge, root)).toBe(true)
})

test('chainMatch does NOT fire when writeScope is outside the target chain', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  // consumer target lives at ROOT; a write inside speculation S must NOT fire it
  const edge: Edge = { source: name, target: consumerSlot, targetScope: root }
  expect(chainMatch(edge, s)).toBe(false) // S not in chainFor(root) = [root]
})

test('chainMatch does NOT fire when a more-specific scope shadows the write', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  // consumer target lives under S; S has its own slot for `name` → a write to
  // ROOT is shadowed by S's slot and must NOT fire this edge
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  const consumerSlot: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge: Edge = { source: name, target: consumerSlot, targetScope: s }
  expect(chainMatch(edge, root)).toBe(false)
  // but a write to S itself (the shadowing scope) does fire
  expect(chainMatch(edge, s)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: FAIL — `chainMatch` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/scope.ts

/** The engine-side fire predicate (Q1 Model 1). An edge fires for a write to
 *  `(edge.source, writeScope)` iff `writeScope` is in the target slot's chain
 *  AND no more-specific scope in that chain has its own slot for the source
 *  (which would shadow the write). */
export function chainMatch(edge: Edge, writeScope: Scope): boolean {
  const chain = chainFor(edge.targetScope)
  const idx = chain.indexOf(writeScope)
  if (idx === -1) return false
  for (let i = 0; i < idx; i++) {
    if (chain[i].slots.has(edge.source)) return false // shadowed
  }
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts test/scope.test.ts
git commit -m "feat(scope): chainMatch fire predicate (Q1 Model 1)"
```

---

## Task 5: `linkEdge` + `edgesToFire` (the `doubleName` break, fixed)

**Files:**
- Modify: `src/scope.ts`
- Test: `test/scope.test.ts`

- [ ] **Step 1: Write the failing test**

This reproduces the `doubleName` trace's break: an edge formed while reading `doubleName` under scope `S` must fire when `name` is later written *under `S`*, even though a naive slot-to-slot edge (keyed on `name`'s ROOT slot) would miss.

```ts
// append to test/scope.test.ts
import { linkEdge, edgesToFire } from '../src/scope'

test('linkEdge indexes on the source and records on the target scope', () => {
  const root = createScope(undefined, 'owner')
  const name = sigNode()
  const target: Slot = { recipe: undefined, cached: undefined, deps: [] }
  const edge = linkEdge(name, target, root)
  expect(name.subs.has(edge)).toBe(true)
  expect(root.edges.has(edge)).toBe(true)
  expect(target.deps).toContain(edge)
})

test('edgesToFire fixes the doubleName break: write under S fires the S-scoped edge', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  // ROOT has name = "foo"; doubleName read under S formed an edge targeting a
  // slot that lives in S:
  writeSlot(name, root, { recipe: () => 'foo', cached: 'foo', deps: [] })
  const doubleNameSlotInS: Slot = { recipe: undefined, cached: 'foofoo', deps: [] }
  linkEdge(name, doubleNameSlotInS, s)

  // Now setName under S — writeSlot(name, S, ...) then ask which edges fire:
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  const fired = edgesToFire(name, s)
  expect(fired.map((e) => e.target)).toContain(doubleNameSlotInS)
})

test('edgesToFire does not fire consumers outside the write chain', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  // a consumer whose target lives at ROOT must not fire on a write inside S
  const rootConsumer: Slot = { recipe: undefined, cached: undefined, deps: [] }
  linkEdge(name, rootConsumer, root)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  const fired = edgesToFire(name, s)
  expect(fired.map((e) => e.target)).not.toContain(rootConsumer)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: FAIL — `linkEdge` / `edgesToFire` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/scope.ts

/** Form a subscription edge during a tracked read: index it on the source
 *  (fast write-fire lookup), record it on the target scope (cleanup owner) and
 *  on the target slot's deps (stale-dep unlink on re-run). Per Q6 lifecycle. */
export function linkEdge(source: Node, target: Slot, targetScope: Scope): Edge {
  const edge: Edge = { source, target, targetScope }
  source.subs.add(edge)
  targetScope.edges.add(edge)
  target.deps.push(edge)
  return edge
}

/** Given a write to `(node, writeScope)`, the edges that should fire — the pure
 *  selection that Plan 2 will hand to r3's invalidate/schedule. Walks the
 *  source's subs and applies chainMatch. */
export function edgesToFire(node: Node, writeScope: Scope): Edge[] {
  const fired: Edge[] = []
  for (const edge of node.subs) {
    if (chainMatch(edge, writeScope)) fired.push(edge)
  }
  return fired
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts test/scope.test.ts
git commit -m "feat(scope): linkEdge + edgesToFire — fixes the doubleName break"
```

---

## Task 6: `closeScopeEdges` — edge unlink + slot drop on close

**Files:**
- Modify: `src/scope.ts`
- Test: `test/scope.test.ts`

Partial `closeScope`: the edge-and-slot teardown shared by both commit and discard (Q6 lifecycle). Commit-promotion and discard-cleanups are Plan 2 — this is only the unlink/drop that both paths share.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/scope.test.ts
import { closeScopeEdges } from '../src/scope'

test('closeScopeEdges unlinks the scope edges from their sources and drops slots', () => {
  const root = createScope(undefined, 'owner')
  const s = createScope(root, 'speculative')
  const name = sigNode()
  const targetInS: Slot = { recipe: undefined, cached: 'x', deps: [] }
  const edge = linkEdge(name, targetInS, s)
  writeSlot(name, s, { recipe: () => 'bar', cached: 'bar', deps: [] })
  s.readSet.add(name)

  closeScopeEdges(s)

  expect(name.subs.has(edge)).toBe(false) // unlinked from the source index
  expect(s.edges.size).toBe(0)
  expect(s.slots.has(name)).toBe(false) // slot dropped
  expect(root.children.has(s)).toBe(false) // detached from parent
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: FAIL — `closeScopeEdges` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/scope.ts

/** The edge/slot teardown shared by commit and discard (Q6 closeScope). Does
 *  NOT promote (commit) or fire cleanups (discard) — Plan 2 adds those around
 *  this. Drops slots for everything the scope read or wrote, unlinks the
 *  scope's edges from their source indexes, and detaches from the parent. */
export function closeScopeEdges(scope: Scope): void {
  for (const edge of scope.edges) edge.source.subs.delete(edge)
  scope.edges.clear()
  for (const node of scope.readSet) scope.slots.delete(node)
  for (const node of scope.writeSet) scope.slots.delete(node)
  scope.parent?.children.delete(scope)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/scope.test.ts`
Expected: PASS. Then run the full suite to confirm nothing else broke:

Run: `pnpm test`
Expected: all existing tests still PASS (this plan added a new module and touched nothing else).

- [ ] **Step 5: Commit**

```bash
git add src/scope.ts test/scope.test.ts
git commit -m "feat(scope): closeScopeEdges — shared unlink/drop teardown"
```

---

## Self-review

**Spec coverage (against Q1/Q6/Q9 + the `doubleName` trace):**
- Scope shape (Q6) → Task 1. `chainFor` terminal-is-structural (Q6) → Task 2. Multi-slot storage + fall-through (Q9/Q1) → Task 3. Chain-match predicate incl. shadowing (Q1 Model 1) → Task 4. The `doubleName` break (edge fires on write-under-S) → Task 5. Edge/slot teardown (Q6 closeScope) → Task 6.
- **Deliberately out of scope for Plan 1** (each has a home): commit-promotion + discard-cleanups (Plan 2); `defaultRecipe` invocation on read-miss / recompute (Plan 2 — needs the read walk wired to recipes); r3 fire-loop integration (Plan 2, first task = r3-internals study); `Awaitable` reads (Plan 3); `reject`/versions (Plan 4); `settled` (Plan 5). `edgesToFire` returns the selection precisely so Plan 2 can drive real invalidation without re-deriving chain-match.

**Placeholder scan:** none — every step has runnable test code, real implementation, and exact `pnpm exec vitest run` / `pnpm test` commands with expected results.

**Type consistency:** `Node`/`Slot`/`Edge`/`Scope`/`ScopeKind` defined in Task 1 and used unchanged in Tasks 2–6. `writeSlot(node, scope, slot)`, `readSlot(node, scope)`, `chainMatch(edge, writeScope)`, `linkEdge(source, target, targetScope)`, `edgesToFire(node, writeScope)`, `closeScopeEdges(scope)` — signatures are consistent across their definition and every test call.

**Note on the "rework in place" decision:** this plan builds `src/scope.ts` as the core `owner.ts` folds into (Q2 unification) rather than editing `owner.ts` now — because the scope data model is cleanly unit-testable in isolation and reworking `owner.ts`'s r3/Loading entanglement belongs with the fire-loop integration in Plan 2. The end state is still one engine (owner absorbed into scope), not a permanent parallel engine.

# Solid 2.x — `@solidjs/signals` async architecture

**Type:** primary
**Taxonomy row(s) affected:** "Solid 2.x" (currently 🟡)
**Status after this dive:** 🟢 verified — cells revised based on direct source-code analysis
**Date:** 2026-05-19
**Session:** 7
**Scope note:** Deep-dive on **`@solidjs/signals` 2.0.0-beta.13** — the reactive runtime that powers Solid 2.x — read directly from source rather than docs. Covers the per-override lane architecture, `action()`, `createOptimistic`, `<Loading>` / `<Errored>` / `<Reveal>`, `isPending` / `latest` / `refresh`, the generator-based action protocol, and entanglement via `_gatedSubs`. Specifically contrasted with the session-6 React-modern dive to sharpen the "fused-reactive multi-transition coordination" comparison. The cousin relationship — both `@solidjs/signals` and pulse's r3 stem from Ryan Carniato's reactive lineage — makes this the most architecturally adjacent system in the taxonomy.

---

## Sources

Primary (read directly from `/Users/bigmistqke/Documents/GitHub/solid`):

1. **`packages/solid-signals/src/core/lanes.ts`** (139 lines) — the Per-Override Optimistic Lane architecture. `OptimisticLane` interface; `signalLanes` WeakMap; `activeLanes` Set; union-find via `findLane` / `mergeLanes`; parent-lane relationships; `assignOrMergeLane` with entanglement-detection logic.
2. **`packages/solid-signals/src/core/scheduler.ts`** (761 lines) — the global scheduler. `Transition` interface; `GlobalQueue`; `initTransition`; `flush`; `transitionComplete` (checks `_asyncReporters` for blocking sources); the `_gatedSubs` set for entanglement replay; the "stashed background transition" mechanism with `_queueStash`.
3. **`packages/solid-signals/src/core/action.ts`** (95 lines) — the generator-based `action(genFn)` wrapper. `restoreTransition`; the step/run iterator machinery; explicit pairing with `createOptimistic` / `createOptimisticStore` for auto-revert.
4. **`packages/solid-signals/src/core/async.ts`** (394 lines) — `handleAsync` for promises + async iterables; `NotReadyError`-as-pending; stale-result discard; `settlePendingSource` for pending propagation; `notifyStatus` for pending status fan-out.
5. **`packages/solid-signals/src/boundaries.ts`** (627 lines) — `createLoadingBoundary`, `createErrorBoundary`, `createRevealOrder`. The `RevealController` with `sequential` / `together` / `natural` orders; `isMinimallyReady` semantics; nested-reveal composition.
6. **`packages/solid-signals/src/signals.ts`** (relevant: lines 643–670, 746–) — `createOptimistic` for both signal and computed variants; `onSettled` for post-settle callbacks; `resolve`.
7. **`packages/solid-signals/src/core/core.ts`** (relevant: lines 1170–1290) — `latest`, `isPending`, `refresh`, `isRefreshing`. These are the boundary-bypass / pending-check primitives.

Secondary:
8. `packages/solid-signals/src/package.json` — confirms version `2.0.0-beta.13`.

Sourcing note: this is the first dive read directly from source. The advantage is precision (the documentation can lag behind code); the cost is that source-reading requires verifying behavior across multiple files. The numbers (139 lines lanes.ts, etc.) are exact at the time of this dive — if the code evolves the cells may need re-verification.

---

## What it is

`@solidjs/signals` is the reactive runtime separated out of Solid 2.x as a standalone package. The architecture is built around several primitives:

1. **Signal** — read/write value with subscribers.
2. **Computed (memo)** — derived value with tracked dependencies; can be async (returns Promise).
3. **Effect** — subscribed side-effect; can be `EFFECT_RENDER` (DOM-level) or `EFFECT_USER` (user code) or `EFFECT_TRACKED` (special: bypasses heap, goes directly to effect queue).
4. **Owner** — disposal scope; carries queue, cleanup hooks, context.
5. **Queue** — effect dispatch with parent/child structure; `GlobalQueue` is the root.
6. **Transition** — coordination context for related state changes; carries pending nodes, optimistic nodes, optimistic stores, actions, gated subs, queue stash.
7. **Optimistic Lane** — per-optimistic-write coordination context; union-find merged with overlapping lanes; assigned to subscribers as writes propagate.
8. **Loading / Errored / Reveal boundaries** — propagation-gating reactive nodes that catch pending/error status and render fallbacks; Reveal coordinates sibling reveal timing.

**The defining architectural commitment is fused-reactive-with-dynamic-lanes.** Every async result lands back in the same reactive graph. There's no separate effect layer. But unlike React's 31 fixed-priority bitmask lanes, Solid 2.x has **per-write dynamic lanes that merge via union-find** when their dependency graphs overlap.

From `lanes.ts:9-13`:

```typescript
/**
 * OptimisticLane represents the context for a single optimistic write.
 * Each optimistic signal creates its own lane. Lanes merge when their
 * dependency graphs overlap.
 */
```

This is mechanically very different from React's lanes. React allocates from a fixed pool of 31 bits; Solid allocates per write and merges on conflict. The conflict detection IS the lane-merge: `assignOrMergeLane` (`lanes.ts:110-139`) — when a subscriber already has a lane and a new lane reaches it, merge unless one is the other's parent.

The result: **independent optimistic writes that touch disjoint subgraphs run on independent lanes; writes that converge get merged into a single lane**. This is **entanglement detection by structural overlap**, not by user declaration.

---

## The async-coordination model

### Where async state lives

Solid 2.x splits async state across several layers:

1. **`Computed._inFlight`** (`async.ts:177`) — the currently-pending Promise/AsyncIterable; identity used for stale-result discard.
2. **`Computed._pendingValue`** / **`_overrideValue`** — slots for "value to be committed" vs "current optimistic override."
3. **`Transition._asyncReporters`** (`scheduler.ts:159`) — a `Map<Computed, Set<Computed>>` tracking which pending source is blocking which downstream reporter. Transition completion checks every entry.
4. **`OptimisticLane._pendingAsync`** — Set of pending async nodes triggered by this lane. Independent flush when empty.
5. **`Transition._gatedSubs`** (`scheduler.ts:169`) — subscribers that read a committed value during a lane recomputation; replayed at commit.
6. **`Transition._optimisticNodes`** / **`_optimisticStores`** — for revertable optimistic state.
7. **`Transition._queueStash`** — when a transition is stashed (background), its accumulated effect queue is parked here; restored on resume.

**This is more state than any other system in the taxonomy.** It reflects that Solid 2.x is fundamentally a *negotiation* between many concerns: pending propagation, optimistic overlays, lane merging, transition stashing, refresh, error handling, entanglement detection. The fused-reactive substrate is rich.

### Conflict-handling policy: union-find lane merge

From `lanes.ts:67-78`:

```typescript
export function mergeLanes(lane1: OptimisticLane, lane2: OptimisticLane): OptimisticLane {
  lane1 = findLane(lane1);
  lane2 = findLane(lane2);
  if (lane1 === lane2) return lane1;

  lane2._mergedInto = lane1;
  for (const node of lane2._pendingAsync) lane1._pendingAsync.add(node);
  lane1._effectQueues[0].push(...lane2._effectQueues[0]);
  lane1._effectQueues[1].push(...lane2._effectQueues[1]);

  return lane1;
}
```

The mechanism: when a propagating write reaches a subscriber that already has *a different active lane*, merge the two lanes into one. The merged lane inherits both lanes' pending-async sets and effect queues. After merge, the two lanes are operationally one.

The parent-lane wrinkle (`lanes.ts:38-49`, `lanes.ts:126-134`): a "parent lane" relationship exists when a lane is derived from a `_parentSource` chain (pendingSignal → pendingValueComputed → original). Parent and child lanes stay **independent** so that the child's `isPending` resolves without waiting for the parent's async. This is mechanically how Solid avoids "lane explosion" where every derivation creates a new lane.

**Comparison to React:** React's 31-lane bitmask uses lanes as *priority labels*, and pre-empts low-priority WIP work with high-priority work. Solid's per-override lanes are not priority labels — they're *coordination contexts*. There's no pre-emption between lanes; instead, independent lanes flush independently when their pending-async sets empty, and overlapping lanes merge into shared flushing.

This is **conflict resolution by merging, not by priority pre-emption**. Closer to a CRDT-style "anyone who touches the same field becomes one operation" than to React's lane prioritization.

### Cancellation: stale-result discard + structural disposal

From `async.ts:188-193`:

```typescript
const asyncWrite = (value: T, then?: () => void) => {
  if (el._inFlight !== result) return;
  // If the node was dirtied by a newer write (optimistic override or regular),
  // skip this stale async result — the upcoming flush will recompute the node
  // with the new value, creating a fresh Promise that supersedes this one.
  if (el._flags & (REACTIVE_DIRTY | REACTIVE_OPTIMISTIC_DIRTY)) return;
```

Stale-result discard is by *identity of the Promise*. If the computed has been re-dirtied (by a newer write or by an optimistic override), the in-flight Promise is no longer `===` to `el._inFlight`, and its resolution is silently dropped. The fresh write will produce a new Promise.

There's no `AbortController` invocation — the *fetch* itself is not cancelled, but its resolution is ignored. The same trade-off pulse makes; the same trade-off React makes for `useEffect` async work; the same trade-off Cap'n Proto makes for promise garbage collection. The discipline is "identity-based stale discard, with separate `AbortController` plumbing for actual cancellation."

For lifecycle-based cancellation: when an owner is disposed, its async iterables are explicitly cancelled (`async.ts:258-267`):

```typescript
cleanup(() => {
  if (completed) return;
  completed = true;
  try {
    const returned = it.return?.();
    ...
  } catch {}
});
```

So Solid 2.x has **two cancellation strengths**: identity-based stale-discard for stale results (no fetch cancellation), and structural-by-owner-disposal for iterables (calls `it.return()`). Promise-fetches are stale-discarded but not actually cancelled.

### Suspension: `NotReadyError` throw, caught by Loading boundary

The current Solid 2.x mechanism:

1. When `handleAsync` (`async.ts:135-312`) detects an unresolved Promise/iterable, it throws `NotReadyError`.
2. The throw propagates upward through the reactive graph; nodes that receive a pending status set `STATUS_PENDING` flag and register the source in their `_pendingSources` set.
3. The nearest `createLoadingBoundary` (`boundaries.ts:428-434`) catches the propagation via its `notify` hook and switches its `boundaryComputed` to render the fallback.
4. When all sources of the boundary settle, `settlePendingSource` (`async.ts:96-133`) walks downstream removing the pending state, eventually allowing the boundary to re-evaluate and render the resolved content.

This is structurally the same pattern as React Suspense + `use(promise)`, but the throw-vehicle is different. React throws inside `use`; Solid throws inside `handleAsync` (deeper in the computation graph). Solid's `NotReadyError` carries the *source node* identity (`error.source`), enabling per-source pending tracking that React's thrown Promise doesn't provide.

**Re-execution semantics:** same as React and pulse. The computation re-runs from the top when the dependency resolves; there's no continuation resumption. Session-3's framing applies: encoded handlers via re-execution.

The throw-and-catch-at-boundary mechanism is one specific encoding of suspension; the encoding choice is a recurring theme across the React-modern, pulse, and Solid dives — all three are in the encoded-via-re-execution camp; none has true continuation resumption (session 3).

### Composition: `action()` as generator transaction

From `action.ts:18-50`:

> "Wraps a generator function so each invocation runs as a single transaction (a 'transition') that batches every signal/store write between yields. The surrounding UI sees one atomic update per yielded step; nothing is committed until the action either completes or the next `yield` resolves."

```typescript
const addTodo = action(function* (text: string) {
  const tempId = crypto.randomUUID();
  setTodos(t => { t.push({ id: tempId, text, pending: true }); }); // optimistic
  const saved = yield api.createTodo(text); // network round-trip
  setTodos(t => {
    const i = t.findIndex(x => x.id === tempId);
    if (i >= 0) t[i] = saved;
  });
  return saved;
});
```

The mechanics (`action.ts:51-94`): each yield is a transition step. Promise yields await; bare-value yields are synchronous batched steps. Writes between yields batch atomically — the UI sees a single update per step. The transition context is restored across awaits via `restoreTransition` so writes after the await join the same transition.

**This is the closest analog to Cap'n Proto's batched dependent dispatch in any UI-framework taxonomy row** — except it's local, not remote. The generator is a *script for the runtime to execute as one transaction*. The runtime mediates which writes get batched together. This is structurally:

- Same shape as Bonsai's `let%bind.Effect` (chained effects in monadic syntax)
- Same shape as effect-ts's `Effect.gen` (generator-based effect composition)
- Same shape as Cap'n Proto's pipelined chain (build a dependent description, dispatch as one)
- Different from React's `startTransition(action)` which is a function call without yield-boundaries

The session-5 message-send triangle: action() is operating on **currently-resolved receivers between yields, and on not-yet-resolved values at yield boundaries**. It's the closest thing in the taxonomy to "the middle corner is reachable in JS" — except it doesn't go all the way (no remote dispatch; just local batching).

### Atomicity granularity: per-yield, per-transition

The transition completes (`scheduler.ts:703-741`) when:
- `_actions` is empty (no in-flight generators), AND
- No `_asyncReporters` are still blocking on a pending source, AND
- No `_optimisticNodes` are still holding overrides

Until then, the transition stays active. Background transitions get **stashed** via `_queueStash` — their accumulated effect queue is parked, the global queue continues, and when the transition completes its stashed effects fire (`scheduler.ts:280-300`).

So atomicity is:
- **Per-yield-step within a generator action** — writes between yields commit together
- **Per-transition overall** — the entire action's progression is one transition until done
- **Per-lane independently** — lanes with no pending async flush their effects without waiting for the broader transition (`scheduler.ts:115-124`)

This is genuinely a *three-layer* atomicity structure — distinct from any other taxonomy row. The closest analog is effect-ts's STM (per-commit) + Scope (per-scope) two-layer atomicity, but Solid has three layers because of the lane structure.

### Discipline location

Runtime-enforced via the reactive graph + behavioral conventions. No type-level enforcement of effect signatures. The current encoding has an inherent weakness: `NotReadyError` is thrown, bypassing the type system. A signal's return type is `T` but may never produce `T` synchronously. This is a property of the throw-based suspension protocol, not of Solid's choices per se — the same critique applies to React's `use(promise)` and to pulse's `NotReadyYet`.

### Reactive integration: fused

The reconciler IS the reactive engine. Effects, computeds, signals, boundaries, lanes, transitions — all part of one substrate. Same family as pulse, Solid 1.x, React modern. Distinct from Bonsai (separate effect layer) and effect-ts (orthogonal).

### Reveal: ordered sibling coordination

From `boundaries.ts:471-510`'s doc:

> "Coordinate the reveal timing of sibling loading boundaries. Accepts reactive accessors: `order`: `"sequential"` (default) | `"together"` | `"natural"`."

`<Reveal>` is genuinely novel — no other system in the taxonomy has this primitive. The semantics:

- **sequential** — siblings reveal in registration order; later siblings stay hidden until earlier ones complete. The "frontier" advances.
- **together** — all siblings stay on fallback until the entire group is minimally ready, then release atomically.
- **natural** — each sibling reveals independently.

Nested Reveals compose: an inner Reveal registers as a single slot in the outer Reveal and is held until the outer releases it. There's no opt-out.

**Significance for the taxonomy:** this is the first system where **reveal-ordering is itself a first-class reactive primitive**. React has `useDeferredValue` for two-pass rendering and Suspense ordering is implicit; Solid 2.x makes the ordering policy explicit and reactive.

---

## Taxonomy cells

### Where async state lives
**Cell:** fused (reactive graph); split across Computed (`_inFlight`, `_pendingValue`, `_overrideValue`), Transition (`_asyncReporters` map, `_optimisticNodes`, `_gatedSubs`, `_queueStash`), OptimisticLane (`_pendingAsync`, `_effectQueues`)
**Evidence:** scheduler.ts:157-170 Transition interface; lanes.ts:14-21 OptimisticLane interface; async.ts:177-228 _inFlight identity tracking.

### Conflict-handling policy
**Cell:** **union-find lane merge** — independent writes get independent lanes; overlapping writes merge into shared lane; parent-child lanes stay independent for `isPending` semantics
**Evidence:** lanes.ts:67-78 mergeLanes; lanes.ts:110-139 assignOrMergeLane with parent-child special case. This is a **distinct value from any other taxonomy row** — closer to CRDT merge than to STM retry or React pre-emption.

### Cancellation discipline
**Cell:** identity-based stale-result discard (no fetch cancellation) + structural-by-owner-disposal for async iterables (calls `it.return()`)
**Evidence:** async.ts:188-193 stale-result early-return; async.ts:258-267 cleanup with iterator.return. No AbortController wiring.

### Async representation
**Cell:** procedure (computed returning Promise/AsyncIterable; or generator action with yields) + `NotReadyError` throw protocol carrying source identity
**Evidence:** async.ts:135-312 handleAsync; action.ts:51-94 generator action protocol; error.ts NotReadyError carries source.

### Isolation level
**Cell:** **per-lane optimistic overlay** — each optimistic write maintains its own `_overrideValue`; `_pendingValue` for not-yet-committed values; lanes merge on overlap so converging writes share the overlay
**Evidence:** lanes.ts OptimisticLane._effectQueues; scheduler.ts:186-200 resolveOptimisticNodes; async.ts:201-208 routing through lane's pendingValue when override active.

### Atomicity granularity
**Cell:** **three layers** — per-yield within a generator action; per-transition overall; per-lane independently for non-blocked lanes
**Evidence:** action.ts:11-16 restoreTransition; scheduler.ts:115-124 runLaneEffects (lanes flush independently when not blocked); scheduler.ts:703-741 transitionComplete.

### Discipline location
**Cell:** runtime-enforced (reactive graph + transition machinery); no compile-time effect-typing; behavioral conventions
**Evidence:** code is full of runtime invariants (flags, statuses, lane bookkeeping); the `NotReadyError`-throw protocol is inherently type-bypassing.

### Reactive integration
**Cell:** fused — reactive graph IS the engine; no separate effect layer; reveal-ordering is a first-class reactive primitive (`<Reveal>`)
**Evidence:** boundaries.ts:512+ createRevealOrder; all primitives live in the same graph.

---

## Scenario mapping

| Scenario | Solved? | How |
|---|---|---|
| **S1 — Like/unlike race** | yes (better than React) | `action(function* () { yield api.toggle(); })` runs as a single transition; the union-find lane merge means two concurrent toggles converge into one lane and last-write-wins on the merged lane. Optimistic state from `createOptimistic` auto-reverts on action failure. |
| **S2 — Auto-save vs explicit save** | yes | Both as `action(function* () { … })`. Generator yields create explicit transition steps; writes between yields batch. Closure capture at action-call time snapshots the payload. |
| **S3 — Multi-step server flow with partial failure** | yes (ergonomically) | Multi-step action with `yield api.step1(); yield api.step2(); …` is exactly the canonical use case. Failures via thrown errors in the generator; `createOptimistic` state auto-reverts. **More ergonomic than React's Server Actions** (no per-step `await` ceremony; the generator IS the dependent chain). |
| **S4 — Concurrent independent flows** | yes (better than React) | Independent optimistic writes get independent lanes (union-find: no merge if no overlap); each lane's pending-async flush is independent. Solid currently does not batch unrelated transitions (compare React's acknowledged batching limitation). |
| **S5 — Cross-transaction read** | partial | `_gatedSubs` mechanism (scheduler.ts:166-170): "Subscribers that, while recomputing under an optimistic lane, read a plain signal's committed value through the entanglement gate. At commit they get rescheduled so they re-run with the new committed view." This is **explicit cross-transaction read with replay at commit**. No formal MVCC, but real machinery. |
| **S6 — User-cancellable flow** | partial (rendering) / partial (I/O) | Owner disposal cancels async iterables. Promise-based fetches use identity-based stale-discard; no fetch cancellation without manual AbortController. Same trade-off as pulse and React. |
| **S7 — Optimistic reconciliation** | yes (canonically) | `createOptimistic` paired with `action()`. The lane-based override-with-pending-value mechanism gives convergence-in-same-render semantics without the React `useOptimistic` ceremony. **Mechanically more powerful than React** (lanes merge with entanglement; React's `useOptimistic` is per-action-only). |
| **S8 — Preview / what-if mode** | partial | `latest()` (core.ts:1173) bypasses pending state to read latest. `refresh()` (core.ts:1250) re-invalidates a source. Neither is a true "preview" primitive — there's no exposable speculative tree. WIP-tree-as-primitive limitation same as React. |

**Policy questions** (per `concurrent-flows.md` Q1–Q5):

- **Q1 (overlay read inside tx):** lane's `_overrideValue` IS the overlay; reads within the lane see overlay; reads outside see committed.
- **Q2 (outside-tx read):** committed truth; can opt into snapshot reads via the `_gatedSubs` mechanism if entering the lane's scope.
- **Q3 (commit ordering with shared state):** union-find merge — overlapping lanes converge into one; last-write-wins on the merged lane.
- **Q4 (default entanglement):** **automatic detection by structural overlap (d) — lanes merge when they touch shared subscribers**. This is genuinely the *strongest entanglement detection in the taxonomy*: no user declaration required.
- **Q5 (overlay lifecycle):** revert on transition complete unless action returns successfully and writes the real value; auto-revert is the default.

---

## What pulse can learn from Solid 2.x

### Where Solid 2.x is meaningfully ahead of pulse

- **Union-find lane merge as automatic entanglement detection.** This is the single biggest mechanical advance Solid 2.x has over pulse. Pulse's pipeline-OR `isPending` walks already do *something* in this space, but Solid's mechanism is more general: it detects entanglement at write-time via dependency-graph overlap, not at read-time via downstream pending propagation. The result: two unrelated writes never block each other; two related writes automatically become one transaction.
- **`action(function* () { yield … })` as a generator transaction.** The yield-based step boundary is genuinely good ergonomics. Each yield is a commit point; writes between yields are atomic; the runtime handles the rest. Pulse currently has no equivalent — chained async work is just `async/await` outside the reactive context.
- **`<Reveal>` as first-class reveal-order primitive.** The sequential/together/natural modes solve a real ergonomic problem (coordinating sibling Suspense reveals) that React handles only implicitly via Suspense nesting and `useDeferredValue`. Pulse currently has just `<Loading>` boundaries.
- **`_gatedSubs` replay-at-commit mechanism.** Solid has explicit machinery for "this subscriber read a stale value during the optimistic phase; rerun it when we commit." This is cross-transaction-read with automatic catchup. Pulse's design has nothing equivalent.
- **`refresh()` + `isRefreshing()` distinct from initial load.** Distinguishing "currently fetching" from "initial loading" is a real UX win. Pulse conflates them.
- **`latest()` for boundary-bypass reads.** Read a value bypassing pending state. Useful for showing the *previous* value while a new one is loading — a common UX need that pulse doesn't directly address.
- **Three-layer atomicity (per-yield / per-transition / per-lane).** The lane structure means independent transitions don't block each other; lanes flush when their pending-async is empty. Pulse's single-transition-per-boundary model can't do this.

### Where pulse is meaningfully simpler / lighter

- **No lane merge bookkeeping.** Pulse's gather-on-Loading-boundary doesn't have the per-write lane allocation, the union-find traversal, the parent-lane handling, the `_gatedSubs` set. The cost: pulse can't do automatic entanglement detection. The benefit: dramatically less machinery to maintain.
- **No generator-based action protocol.** Pulse's chained-async-work model is async/await + reactive reads; no special wrapper, no transition object, no `_queueStash`. Simpler to reason about; less ergonomic for multi-step flows.
- **No three-layer atomicity.** Pulse atomicity is per-`<Loading>` gather + per-microtask flush. Fewer concerns to coordinate; less flexible.
- **No `<Reveal>` primitive.** Pulse just has `<Loading>`. Less primitive surface; less ergonomic for ordered reveals.

### What pulse could plausibly adopt without a full architectural rewrite

1. **`action(function* () { yield … })`-shaped primitive.** This could be a pulse layer that builds on signals + `<Loading>` — wrap a generator, treat each yield as a step boundary, batch writes between yields. The infrastructure pulse already has (pipeline-OR `isPending`, gather-on-`<Loading>`) is the substrate; the action() wrapper is the additional surface.
2. **`refresh()` + `isRefreshing()` semantic distinction.** Pulse already has gather-on-`<Loading>`; distinguishing "initial load" from "user-initiated refresh" is mostly an API/diagnostic concern, not a deep architectural change.
3. **`latest()` for boundary-bypass reads.** This is a small read-primitive addition. Useful especially for "show previous value during refetch" patterns.
4. **`<Reveal>` ordering primitive.** More substantial work but mechanically tractable — coordinate sibling `<Loading>` boundaries with sequential/together/natural ordering, controlled by a reactive accessor.

### What pulse should NOT adopt without much deeper consideration

- **Per-write lane allocation with union-find merge.** This is the heaviest machinery in Solid 2.x and a real complexity commitment. The architectural value-add (automatic entanglement detection) is real, but pulse currently bets on user-explicit transactions via Plan A/B/C boundaries. Adopting Solid's lanes would mean abandoning that bet. Worth a full design exploration, not a casual adoption.
- **Three-layer atomicity.** Same — heavy machinery, real benefit, big architectural commitment.
- **`_gatedSubs` replay.** Mechanically rich, only useful in conjunction with lanes.

---

## Open questions resolved

### "Speculative-state isolation" axis (from session 6)

**Solid 2.x sits at the per-action-overlay value, layered with per-transition-tree-like behavior.** The per-lane `_overrideValue` is per-write-overlay; the lane-merging-on-overlap creates an emergent per-transition-tree-ish behavior; the `_queueStash` parks effect-tree state across transition stashing. Strictly Solid is **between "per-action overlay" and "per-transition tree"** on the axis.

This is a refinement of the axis: there may be a *fifth value* — **"per-write lane overlay with merge"** — sitting between per-action and per-transition. Solid is its own row in this space.

### "Dependent-dispatch capability" axis (from session 5)

**Solid 2.x is "await-only with generator-batching."** The generator action lets you write multi-step dependent work in a single value, but each step is still re-execution on resolve (not pipelined eager-dispatch). The yield-boundary is an *atomicity* primitive, not a *pre-resolve dispatch* primitive.

Refines the axis values:
- **none / await-only** — JS Promise
- **await-only with generator batching** — Solid 2.x `action()`, Bonsai `let%bind.Effect`, effect-ts `Effect.gen`
- **pipelined** — Cap'n Proto, Agoric `E()`
- **pipelined+typed** — Cap'n Proto with IDL

Solid 2.x is the third datapoint in the middle bucket alongside Bonsai and effect-ts. The axis is now well-populated: **promote from candidate to confirmed axis on the next consolidation pass.**

### Message-send triangle (cross-cutting thread)

**Solid 2.x is the same corner as pulse and React** (currently-resolved-with-re-execution). The generator yield boundary is a *step-batching mechanism*, not a "message to a not-yet-here receiver." The middle corner of the triangle is still uninhabited by current JS frameworks.

But Solid 2.x's `action(function* ...)` is the *closest thing in JS* to "the middle corner is reachable, locally." The generator describes dependent work to the runtime; the runtime executes it as one transition. If you swapped the local execution for remote dispatch, you'd have Cap'n Proto's middle-corner pipelining. This sharpens the cross-cutting thread: **the local equivalent of pipelining is "generator-as-transition-script."**

---

## Open questions raised

- **Is the union-find lane merge automatically optimal for all entanglement patterns?** The code is intricate (parent-lane special-casing, etc.). It would be worth understanding the failure modes — when do unrelated writes get spuriously merged? When do related writes fail to merge? A targeted bug-archaeology session in the Solid issue tracker would be informative.
- **What's the runtime cost of per-write lane allocation?** Every optimistic write creates a lane; lanes are tracked in a WeakMap + Set. At scale (e.g. a list of 10000 items each with optimistic state) what's the memory overhead? Worth profiling before pulse adopts anything similar.
- **Could pulse adopt `action(function* () { yield … })` *without* lanes?** The generator-as-transition-script is partially decoupled from the lane machinery. The action coordinates writes via transition-step boundaries (per-yield commit), which doesn't strictly require per-write lanes — pulse's gather-on-`<Loading>` could be the substrate. Worth a focused design exploration.
- **`<Reveal>`'s nested-composition is structurally interesting.** Inner Reveal registers as a slot in outer; outer holds inner until released. This is a fractal-coordination pattern that might generalize beyond reveal-ordering (e.g. could be applied to coordinated transition boundaries, fractal Loading, etc.). Worth a separate sketch.
- **Is the WIP-tree-as-primitive insight (session 6) applicable here?** Solid 2.x doesn't have a literal WIP tree (no parallel component tree), but the lane-with-`_effectQueues` mechanism is *functionally* the same — pending effects accumulate per lane; flush when ready. This is per-action-overlay on the speculative-state-isolation axis, but it has the *effect* of per-transition-tree behavior when lanes merge. Refines the axis: the four-value spectrum I proposed in session 6 may need a fifth intermediate value.

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`react-modern.md`](./react-modern.md) (session 6) — direct mechanical comparison. React: 31 fixed bitmask lanes + WIP-tree + `use(promise)` + `useOptimistic` per-action overlay. Solid: per-write dynamic lanes + union-find merge + `NotReadyError` + `createOptimistic` with auto-revert via lanes. Solid's entanglement detection is mechanically more advanced; React's WIP-tree-as-primitive is mechanically more advanced.
  - [`bonsai-incremental.md`](./bonsai-incremental.md) (session 4) — Bonsai's `let%bind.Effect` is the OCaml analog of Solid's `action(function*) { yield … }`. Both are "generator-shaped transactional composition over a reactive substrate" but Bonsai's effect layer is *separated* from the reactive graph; Solid's is fused.
  - [`capnproto-e-pipelining.md`](./capnproto-e-pipelining.md) (session 5) — Solid's `action()` is the closest thing in JS to pipelining-shape, but it's local-only. The conceptual lesson transfers: "describe dependent work to the runtime, runtime executes as one transaction" is the shared idea; "remote dispatch with pre-resolve method invocation" is what Cap'n Proto adds.
  - [`effect-ts.md`](./effect-ts.md) (session 2) — effect-ts `Effect.gen` shares the generator-as-composition pattern. Different surrounding semantics (typed effects, structural cancellation).
  - [`algebraic-effects.md`](./algebraic-effects.md) (session 3) — Solid 2.x re-execution-on-resolve is in the same camp as React, pulse: encoded handlers via re-execution, not true continuation resumption.
- **Taxonomy axes this dive informed:**
  - **Conflict-handling policy:** confirms "union-find lane merge with parent-child exception" as a distinct value, materially different from STM retry / MVCC snapshot / React pre-empt.
  - **Speculative-state isolation:** refines — Solid sits between "per-action overlay" and "per-transition tree." May need a fifth axis value.
  - **Async representation:** confirms "procedure + throw-protocol-with-source-identity" as a coherent value; the source-identity wrinkle (carrying the offending node) is the precision pulse's `NotReadyError` should match.
  - **Atomicity granularity:** suggests "multi-layer atomicity" should be its own value (effect-ts has 2 layers, Solid has 3).
  - **Dependent-dispatch capability:** Solid is third datapoint for "await-only with generator batching"; promote axis from candidate to confirmed.
- **Scenarios this dive addressed:** S1 yes-better-than-React, S2 yes, S3 yes-ergonomically, S4 yes-better-than-React, S5 partial-with-gated-subs, S6 partial, **S7 yes-canonically with auto-revert**, S8 partial.
- **Cross-cutting threads this dive tested:**
  - **Message-send triangle:** Solid is same-corner-as-pulse, but `action()` is the closest JS gets to the middle corner locally. Sharpens the triangle.

---

## Notes / aside

- **Solid 2.x is the most mechanically intricate row in the taxonomy.** The lane machinery + transition machinery + boundary machinery + reveal machinery + entanglement machinery interact in non-obvious ways. The source is well-commented but reading it linearly is hard. A future architectural-overview document for the Solid runtime would be useful as a primary source.
- **The `_gatedSubs` mechanism is a hidden gem.** It's the answer to "what about subs that touched committed state during the optimistic phase?" — a problem I didn't realize Solid had a built-in answer for. Worth surfacing this in a future "lessons for pulse" synthesis.
- **`<Reveal>`'s `sequential` / `together` / `natural` modes are an explicit answer to a design question pulse will eventually need to make.** When you have N siblings each with their own `<Loading>`, what's the reveal policy? Currently pulse has no answer; Solid's tri-choice answer is well-considered.
- **The cousin relationship matters.** `@solidjs/signals` and r3 (pulse's substrate) are both Ryan Carniato's work, structurally adjacent though different in detail. The cousins-not-parent-child framing from the earlier README work holds up: this dive is "what the other cousin built," not "the parent we descend from."
- **Solid 2.x is still beta (2.0.0-beta.13).** API surface may evolve. The dive's cells are accurate for this beta; re-verification at 2.0 GA is warranted.

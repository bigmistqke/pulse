# Solid 2.x — Optimistic lanes, throw-to-suspend, and transition-as-transaction

**Type:** primary
**Taxonomy row(s) affected:** "Solid 2.x"
**Status after this dive:** 🟢 verified — cells revised based on direct source-code analysis
**Date:** 2026-05-19
**Session:** 7
**Scope note:** Source-code-based deep-dive on `@solidjs/signals` 2.0.0-beta.13 — the reactive runtime that powers Solid 2.x. The dive focuses on the async-coordination surface (transitions, optimistic lanes, the `NotReadyError` suspension protocol, `action()` generators, `<Loading>` / `<Errored>` / `<Reveal>`). Three research threads converge here: (1) sharpening the comparison to React modern (session 6); (2) testing the candidate **dependent-dispatch capability** axis (session 5); (3) testing the **message-send triangle** (cross-cutting thread). The cousin relationship — both `@solidjs/signals` and pulse's r3 stem from Ryan Carniato's reactive lineage — makes this the most architecturally adjacent system in the taxonomy. This dive was conducted as **two parallel passes** (one by the main session, one by a fresh background agent given only the source) and merged for accuracy; the merged document below uses the fresh dive's mechanical analysis as its spine.

---

## Sources

All paths under `/Users/bigmistqke/Documents/GitHub/solid/packages/solid-signals/`. Package version verified at `package.json` (`@solidjs/signals` `2.0.0-beta.13`).

- `src/core/constants.ts` — flag bits, `NOT_PENDING` sentinel, `STATUS_*` constants, `$REFRESH` brand symbol
- `src/core/lanes.ts` — `OptimisticLane` shape, union-find merge, lane resolution, the lane↔node assignment policy
- `src/core/scheduler.ts` — `Transition` shape, `GlobalQueue.flush()`, transition stashing, async-reporter tracking, `transitionComplete()`, lane effect queues, the gated-subs replay path
- `src/core/async.ts` — `handleAsync` (dispatch logic for promises and async iterables), `notifyStatus`, pending-source propagation
- `src/core/action.ts` — the `action(generatorFn)` wrapper: how each `yield` becomes a transition boundary
- `src/core/core.ts` (selectively) — `read()` (the suspension throw + override visibility), `recompute()` (lane recompute path), `setSignal()` (override + lane assignment on write), `latest()`, `isPending()`, `refresh()`, `isRefreshing()`, `optimisticSignal`, `optimisticComputed`
- `src/core/error.ts` — `NotReadyError` (carries a `source` pointer; this is the suspension token) and `StatusError`
- `src/core/index.ts` — the public surface of the core module
- `src/boundaries.ts` — `CollectionQueue` (the per-boundary subqueue), `RevealController` (orchestrates sibling boundary readiness), `createLoadingBoundary` / `createErroredBoundary` / `createRevealOrder`
- `src/signals.ts` (selectively) — `createOptimistic` (~line 643), `onSettled` (~line 746)

Read but not deeply traced: `src/core/types.ts`, `src/core/effect.ts`, `src/core/heap.ts`, `src/core/owner.ts`, `src/core/graph.ts`, `src/core/external.ts`. Their behavior is implied by call sites in the files above.

**Sourcing-discipline correction noted during this session:** an earlier draft cited an `async-signals-proposal.md` file at the Solid repo root as evidence of "Solid's roadmap." On verification (`git status` showed the file untracked), it was actually a pulse design draft accidentally written into the Solid checkout. All references removed; the correction is captured in CONTEXT.md's anti-patterns list. Lesson: **verify git tracking before citing upstream files as upstream evidence.**

---

## What it is

`@solidjs/signals` 2.x is a push-pull reactive runtime where reactive nodes (`Signal`, `Computed`, `Effect`) live in a graph connected by `Link`s. The flush cycle is heap-ordered by node height. What's interesting for our taxonomy is that async is **first-class in the graph itself**, not bolted on as a side layer:

- Any `computed(fn)` whose `fn` returns a `Promise` or `AsyncIterable` is auto-detected and "becomes" async (`core/core.ts:218-227`; auto-detection in `handleAsync` at `core/async.ts:142-152`).
- *Reading* such a node while it's unresolved **throws `NotReadyError(source)`** (`core/async.ts:249`, `core/error.ts:25-29`). This propagates up the tracked-read chain until either:
  1. another computed catches via `try/catch`, treating the throw as "I'm pending too" and re-throwing (the default behavior wired through `recompute`'s catch at `core/core.ts:238-256`), or
  2. a `CollectionQueue` boundary intercepts via its `notify()` override (`boundaries.ts:274-313`), recording the pending source and rendering its fallback.

Three top-level pillars stand on this:

1. **Transitions** (`scheduler.ts:157-170` — the `Transition` interface). A per-cycle bag of state: pending nodes, async reporters, optimistic-node snapshots, in-flight action iterators, a stashed queue, and a set of "gated subs" (entanglement-replay subscribers). An `action()` invocation seeds one; a stray async write picks one up via `globalQueue.initTransition()`.

2. **Optimistic lanes** (`lanes.ts:14-21`). A per-optimistic-write context that owns a set of pending-async nodes, two per-type effect queues (render & user), and union-find merge pointers. Multiple writes to the same optimistic signal share a lane (`lanes.ts:33-54`); two lanes that converge on a shared node merge (`lanes.ts:67-78`).

3. **Boundaries** (`boundaries.ts`). `<Loading>` and `<Errored>` are built on `CollectionQueue extends Queue` (`boundaries.ts:254`), a queue subclass whose `notify()` intercepts `STATUS_PENDING` / `STATUS_ERROR` propagation. The boundary tracks the *set of pending sources* (`boundaries.ts:303-309`) so it knows when it can release. `<Reveal>` (`boundaries.ts:105-…`) coordinates sibling boundaries with a `RevealController` supporting `sequential` / `together` / `natural` reveal orders.

The model that emerges: **the graph is the async data structure**. Pending async is a *flag on a node* (`STATUS_PENDING` in `el._statusFlags`, `core/constants.ts:24`) plus an in-flight handle (`el._inFlight` set in `async.ts:177`). Suspension is a `throw` that traverses tracked reads. Atomicity is staged through `_pendingValue` (separate slot from `_value`) committed by a flush. Optimism is an **overlay** in `_overrideValue` — also separate from `_value`.

So each node carries up to **four value slots**: committed (`_value`), staged-but-not-committed (`_pendingValue`), optimistic override (`_overrideValue`), and snapshot (`_snapshotValue`). This is the architectural fact that the rest of the system is built around.

---

## The async-coordination model

### Where async state lives

In the graph nodes themselves. A `Computed` carries:

- `_inFlight` — current Promise / AsyncIterable handle (`async.ts:177`)
- `_value` / `_pendingValue` — committed and staged values (sentinel: `NOT_PENDING` at `constants.ts:33`; the `{}` sentinel because nodes can legitimately hold `undefined`)
- `_overrideValue` — optimistic overlay
- `_statusFlags` — `STATUS_PENDING | STATUS_ERROR | STATUS_UNINITIALIZED` bits (`constants.ts:23-26`)
- `_error`, `_pendingSource`, `_pendingSources` — *which* upstream is pending; carries a `NotReadyError` whose `.source` points at the upstream async node (`async.ts:33-68`)
- `_optimisticLane` — which lane this node propagates under (`lanes.ts:83-90`)
- `_transition` — which transition currently owns this node
- `_pendingSignal`, `_latestValueComputed` — auxiliary nodes that expose `isPending()` and `latest()` reactivity (`core.ts:1052-1060`, `core.ts:1130-1140`)

There is no separate "effects layer" for async. Async resolution comes back through `handleAsync` (`async.ts:188-230` — `asyncWrite`), which writes into the same node slots that synchronous writes use, restores the appropriate transition via `globalQueue.initTransition(resolveTransition(el))`, then calls `schedule()` and `flush()`.

### Conflict-handling policy

**Lane prioritization with union-find merge on overlap; stale-write rejection by handle identity.** Each optimistic write gets a lane (`lanes.ts:33-54`). When a downstream node would be claimed by two distinct lanes, `assignOrMergeLane` (`lanes.ts:110-139`) merges them — *unless* the node has its own active override (`hasActiveOverride`, `lanes.ts:102-104`), in which case the existing lane is kept. Parent/child lanes (the `_parentLane` field — set up when an optimistic write happens on top of a derived pending signal) deliberately do *not* merge (`lanes.ts:126-133`); this is how `isPending` on a child resolves without waiting for the parent's async.

Stale async resolutions are dropped: `asyncWrite` checks `if (el._inFlight !== result) return;` (`async.ts:189`) and *also* `if (el._flags & (REACTIVE_DIRTY | REACTIVE_OPTIMISTIC_DIRTY)) return;` (`async.ts:192-193`). This is **last-write-wins with structural causality**: the comparison is identity of the in-flight handle, not value-based.

There's no STM-style retry. Optimistic overlays don't conflict with concurrent reads — readers see the override (`core.ts:839-842`), and the entanglement gate at `core.ts:849-859` records subs that read the *committed* (non-overlay) value through a snapshot read so they're rescheduled at commit.

### Cancellation discipline

**Structural-by-scope, plus identity-based supersession.** Three layers:

1. AsyncIterable iterators get a `cleanup(() => it.return?.())` registered with the current owner (`async.ts:258-267`). When the owning scope disposes, the iterator's `return()` is called — co-operative cancellation.
2. Stale promises don't propagate: `if (el._inFlight !== result) return;` in both `asyncWrite` and `handleError` (`async.ts:181, 189`).
3. There is **no `AbortSignal` integration in the reactive core itself**. Searched explicitly for `AbortController` / `AbortSignal` in the reactive core and did not find references. The user is responsible for that — `action()` doesn't pass an abort signal to the generator. Presumably wired through the `fetcher` argument that `createResource` accepts in the higher-level `solid-js` layer (out of this dive's scope).

This matches the trade-off pulse, React modern, and Cap'n Proto all make: identity-based stale-discard at the reactive layer, `AbortController` plumbing pushed to userland.

### Suspension (async representation)

**Pending = a thrown `NotReadyError` carrying a `source` pointer.** Reads that hit a pending value throw (`async.ts:249`, `core.ts:767-803`). The throw is caught in `recompute` (`core.ts:238-256`); the catcher marks itself pending, records the pending source(s) into `_pendingSource` / `_pendingSources` (`async.ts:33-46`), calls `notifyStatus`, and re-throws structure outward.

`notifyStatus` (`async.ts:324-394`) walks subs (and "firewall" child signals — projection store machinery, not deeply traced) and recursively sets status flags + invokes each sub's `_notifyStatus` callback or recurses. **A node's pending status accumulates a *set* of pending sources** — not a single one. A memo reading two async upstreams correctly waits for both.

The graph terminus is a `CollectionQueue` (boundary). Its `notify()` override (`boundaries.ts:274-313`) intercepts the matching status bit, records the source in `_sources`, sets `_pending = true`, and *stops* upward propagation. That's how a `<Loading>` catches.

**Re-execution semantics:** same family as React and pulse. The computation re-runs from the top when the dependency resolves; no continuation resumption. Session-3's framing applies: encoded handlers via re-execution, not true algebraic effects.

### Composition

Boundaries compose because `notify()` returns `true` to indicate "I handled this" and the parent `Queue.notify` recurses upward only on bits that weren't consumed (`scheduler.ts:255-258`, `boundaries.ts:311-313`). `<Loading>` and `<Errored>` can nest because each is its own `CollectionQueue` with its own `_collectionType` mask (`STATUS_PENDING` vs `STATUS_ERROR`).

`<Reveal>` (`boundaries.ts:105-…`) is a coordination layer **above** boundaries: each child loading boundary registers as a "slot" on a `RevealController`, which toggles each slot's `_disabled` and `_collapsed` signals to delay revealing children until siblings catch up (or sequentially in order). This is orthogonal to the suspension protocol — Reveal manipulates the *visibility* of already-resolved boundaries. It is a **boundary scheduler**, not a parallel mechanism.

`action()` (`action.ts:52-95`) wraps a generator function. Each invocation:

1. Calls `globalQueue.initTransition()` to ensure a transition exists, captures it as `ctx`.
2. Pushes the iterator into `ctx._actions` so `transitionComplete` (`scheduler.ts:703-742`) won't allow the transition to commit until the action finishes.
3. On each step: yielded `Promise` → `await` it, then re-enter under the original transition via `restoreTransition` (`action.ts:11-16`) which calls `initTransition(transition)` and `flush()`.
4. On done: removes the iterator from `_actions`, schedules a final flush, resolves the returned `Promise`.

A generator is a **resumable transition**. Synchronous batches between `yield`s are atomic; the transition stays alive across `await`s.

### Atomicity

**Per-yield-step within an action; per-transition outside actions.** While a transition is alive, writes go to `_pendingValue` slots (`scheduler.ts:519-538`, `core.ts:957-960`). Flush either commits (`commitPendingNodes`) or *stashes* (`globalQueue.flush()` at `scheduler.ts:320-356` if `!isComplete`). A stashed transition means: it has pending async, so its writes are not yet visible — they sit in `_pendingValue`. The render path runs against `_value`, the previously-committed state.

When the transition completes (`transitionComplete()` at `scheduler.ts:703-742` returns `true`): the queue is restored via `restoreQueues`, optimistic nodes are reverted via `resolveOptimisticNodes` (`scheduler.ts:186-200`, called from `finalizePureQueue` at `scheduler.ts:563-567`), entanglement-gate subs are rescheduled (`scheduler.ts:570-585`), and effects fire in render-then-user order (`scheduler.ts:382-385`).

**The unit of atomicity is "one synchronous run between `yield`s of an action,"** not the whole action. An action with three yields produces three observable atomic commits (each `restoreTransition` calls `flush()` — `action.ts:13`). Optimistic overrides give the all-or-nothing illusion at the *visual* layer: they show through during the action and revert if it errors.

### Discipline location

**Runtime**, with substantial **dev-mode diagnostics** (`emitDiagnostic` calls throughout). The type system enforces relatively little — `Refreshable<T>` (`constants.ts:58`) is a brand used so `refresh()` rejects unbranded targets at the type level, but the suspension protocol itself isn't typed (the throw of `NotReadyError` is untyped, as JS throws are). The `sync: true` opt-out (`CONFIG_SYNC`, `constants.ts:21`) is checked at runtime in dev (`async.ts:160-175`) and silently in prod.

The two key runtime invariants the system polices:

1. Stale async results never commit: `if (el._inFlight !== result) return;`
2. Optimistic overlays auto-revert at transition commit, unconditionally (`scheduler.ts:186-200`).

Neither is type-checked; both are policed in the scheduler.

### Reactive integration

**Fused.** Async, optimistic overlays, suspension, and reactivity all flow through the same node fields, same heap, same flush. There is no "effects layer" for async — `handleAsync` writes back into the same slots `setSignal` writes to. The lane system *piggybacks* on the graph (lanes are not a parallel graph, they're a coloring of existing nodes). Transitions piggyback on the same queue (a transition has a `_queueStash: QueueStub` field that holds an outgoing queue while a stashed transition waits).

The cost is per-node memory footprint: every node potentially carries `_pendingValue`, `_overrideValue`, `_optimisticLane`, `_transition`, `_pendingSignal`, `_latestValueComputed`, `_pendingSource(s)`, `_inFlight`, `_snapshotValue`, `_blocked`, `_modified`. The benefit is no impedance mismatch — `isPending()`, `latest()`, and a regular read all return values from the same source-of-truth slots, just with different gating.

---

## The problem space of transitions — what Solid's machinery is coordinating

Added after the session-12 cross-cutting synthesis ([LOG.md](../LOG.md) "Transitions branch in four dimensions"). The framing: transitions look like "ad-hoc UI invention" only if you don't notice that they're actually solving a coordination problem across four distinct branching dimensions. Solid 2.x's mechanisms map onto each dimension as follows.

**Dim 1 — Internal branching** (a single transition's speculative future is a *tree* of dependent async work, not a linear chain): handled by `Transition._asyncReporters` (`scheduler.ts:159` — a `Map<Computed, Set<Computed>>` tracking which pending source is blocking which downstream reporter). `transitionComplete` (`scheduler.ts:703-742`) walks this map per-source to decide commit readiness — **per-source, not just per-transition**. This is materially more precise than React's "any pending Suspense in scope blocks the WIP commit"; Solid's transition knows *which* source is blocking and can decide independently.

**Dim 2 — Concurrent branching** (multiple transitions in flight simultaneously, each speculating a different future): handled by **per-write `OptimisticLane`** (`lanes.ts:14-21`). Independent writes get independent lanes; independent lanes flush independently when their `_pendingAsync` Set empties (`scheduler.ts:115-124` — `runLaneEffects` iterates `activeLanes` and skips merged or pending-async lanes). **Not batched.** This is the dimension where Solid 2.x leads React — React's "multiple low-priority transitions currently batched together" is a coarser approximation; Solid lets each lane progress independently from its first write.

**Dim 3 — Input-arrival branching** (user input arrives during a transition; the framework must decide cancel/restart/merge/ignore): **Solid handles this implicitly rather than via priority pre-emption.** A newer input write supersedes a stale in-flight async via the identity-based stale-result discard (`async.ts:188-193` — `if (el._inFlight !== result) return;`). Optimistic overrides revert on transition complete (`resolveOptimisticNodes`, `scheduler.ts:186-200`). There is **no explicit input-priority lane** equivalent to React's "high-priority lanes pre-empt low-priority lanes"; Solid's model is "everything goes through the same scheduler, but newer writes win by identity-superseding older ones." This is weaker than React's input handling — input doesn't *pre-empt* an in-flight transition; it joins the next flush cycle.

**Dim 4 — State-overlap branching** (two transitions touch shared state; the framework must decide whether they're independent or entangled): **Solid handles this best of any framework studied.** `assignOrMergeLane` (`lanes.ts:110-139`) — when a propagating write reaches a subscriber that already has a different active lane, **merge the two lanes via union-find** unless the node has its own active override. The merged lane inherits both pending-async sets and effect queues (`mergeLanes`, `lanes.ts:67-78`). Parent/child lanes (`_parentLane` field, `lanes.ts:18`) deliberately stay independent so `isPending` resolves without waiting for the parent's async. **This is automatic entanglement detection by structural overlap** — no user declaration required. Distinct from STM-retry (effect-ts), MVCC-snapshot (Postgres), and priority-pre-empt (React); a genuinely novel value on the conflict-handling-policy axis.

**The two-dimension takeaway.** Solid leads on **Dim 4 (state-overlap)** via union-find lane merge — React has nothing equivalent; pulse's pipeline-OR walking is a weaker version. Solid lags on **Dim 3 (input)** compared to React — no explicit priority pre-emption; reliance on identity-based stale-discard means input doesn't interrupt mid-transition render work. Dim 1 (internal) is sharper than React's because of the per-source `_asyncReporters` tracking; Dim 2 (concurrent) is mechanically stronger because lanes are independent rather than batched.

---

## Taxonomy cells

### 1. Where async state lives
**Cell:** In the graph nodes themselves — async is fused with reactive state.
**Evidence:** `el._inFlight` set on the `Computed` (`async.ts:177`); `el._statusFlags & STATUS_PENDING` is the canonical pending check (`constants.ts:24`); same node holds `_value` / `_pendingValue` / `_overrideValue` (`setSignal` at `core.ts:917-960`).

### 2. Conflict-handling policy
**Cell:** Per-lane optimistic prioritization with union-find merge on overlap; stale-write rejection by handle identity.
**Evidence:** Lane data structure with `_mergedInto` union-find pointer (`lanes.ts:18, 59-62`); `mergeLanes` unions effect queues and pending-async sets (`lanes.ts:67-78`); `assignOrMergeLane` merge-unless-override-with-parent-child-exception (`lanes.ts:110-139`); stale async drop via `_inFlight` identity (`async.ts:181, 189`); newer dirty bit supersedes pending resolution (`async.ts:192-193`).

### 3. Cancellation discipline
**Cell:** Structural-by-scope for async iterables (cleanup-driven) plus identity-based supersession for promises. **No `AbortSignal` plumbing in the reactive core** (verified by negative search).
**Evidence:** AsyncIterable cleanup registered with owner (`async.ts:258-267`); promise supersession via `_inFlight` identity check (`async.ts:181, 189`); no `AbortController`/`AbortSignal` references in the reactive core (searched).

### 4. Async representation
**Cell:** Procedure (computed `fn` returning Promise/AsyncIterable) + a suspension token (`NotReadyError` carrying its source). Optionally a generator for multi-step transactions (`action()`).
**Evidence:** Auto-detection at `async.ts:144-146`; suspension-token shape `class NotReadyError extends Error { constructor(public source: any) {...} }` (`error.ts:25-29`); generator-as-transaction at `action.ts:52-95` with the iterator held in `ctx._actions` blocking `transitionComplete` (`scheduler.ts:705`).

### 5. Isolation level
**Cell:** Per-action overlay — optimistic writes live in `_overrideValue` and are visible only to readers under the same lane. Plain pending writes live in `_pendingValue` and aren't visible to render-path readers until commit. Separate snapshot mechanism for `CONFIG_IN_SNAPSHOT_SCOPE`.
**Evidence:** `setSignal` chooses between override and staged based on `isOptimistic` (`core.ts:917-960`); readers under a lane see the override (`core.ts:839-842`); entanglement gate replays for subs that read committed during optimistic recompute (`core.ts:849-860`); snapshot fields at `core.ts:89-90`, `constants.ts:18`, `core.ts:812-819` (mechanics not fully traced).

### 6. Atomicity granularity
**Cell:** Per-yield-step within an action; per-transition outside actions. Each step's writes commit together at the next flush.
**Evidence:** `restoreTransition` calls `flush()` after each step (`action.ts:11-16`); bare action without yields runs as one step = one commit; outside actions, multiple synchronous `setSignal` calls share an active `Transition` (`scheduler.ts:410-462`) or a microtask-scheduled flush (`scheduler.ts:221-225`).

### 7. Discipline location
**Cell:** Runtime, with dev-mode diagnostics emitting structured `emitDiagnostic` events. Some type-level branding (`Refreshable<T>` via `$REFRESH` symbol) for `refresh()` target safety.
**Evidence:** `$REFRESH` brand (`constants.ts:48-58`); `refresh()` reads `target[$REFRESH]` with dev-diagnostic fallback (`core.ts:1253-1266`); dev-mode `sync: true` contract enforcement (`async.ts:160-175`); stale-result and lane-merge invariants runtime-only; `NotReadyError` not in the type signature of `read()` (`core.ts:631`) — suspension is unchecked exceptions.

### 8. Reactive integration
**Cell:** Fused. Async, optimism, transitions, and reactivity share the same node fields, heap, and flush cycle. Boundaries are queue subclasses, not external watchers.
**Evidence:** `CollectionQueue extends Queue` (`boundaries.ts:254`); `handleAsync`'s `asyncWrite` restores the transition and calls the same `setSignal` / `insertSubs` paths sync writes use (`async.ts:188-230`); shared heap (`scheduler.ts:33-44`); `_pendingSignal` and `_latestValueComputed` are themselves `Signal`/`Computed` nodes (`core.ts:1052-1060`, `core.ts:1130-1140`).

---

## Scenario mapping

| Scenario | Solved? | How |
|---|---|---|
| **S1 — Like/unlike race** | yes (better than React) | `action(function* () { yield api.toggle(); })` runs as a single transition; union-find lane merge means two concurrent toggles converge into one lane; last-write-wins on the merged lane. `createOptimistic` state auto-reverts on action failure. |
| **S2 — Auto-save vs explicit save** | yes | Both as `action()`s. Generator yields create explicit transition steps; writes between yields batch. Closure capture at action-call time snapshots the payload. |
| **S3 — Multi-step server flow with partial failure** | yes (ergonomically) | Multi-step action with `yield api.step1(); yield api.step2(); …` is exactly the canonical use case. Failures via thrown errors in the generator; `createOptimistic` state auto-reverts. **More ergonomic than React's Server Actions** (no per-step `await` ceremony; the generator IS the dependent chain). |
| **S4 — Concurrent independent flows** | yes (better than React) | Independent optimistic writes get independent lanes (union-find: no merge if no overlap); each lane's pending-async flush is independent. Solid does not batch unrelated transitions (compare React's acknowledged batching limitation). |
| **S5 — Cross-transaction read** | partial | `_gatedSubs` mechanism (`scheduler.ts:166-170`): "Subscribers that, while recomputing under an optimistic lane, read a plain signal's committed value through the entanglement gate. At commit they get rescheduled so they re-run with the new committed view." Explicit cross-transaction read with replay at commit. No formal MVCC, but real machinery. |
| **S6 — User-cancellable flow** | partial | Owner disposal cancels async iterables (cleanup with `it.return()`). Promise-based fetches use identity-based stale-discard; no fetch cancellation without manual AbortController. Same trade-off as pulse and React. |
| **S7 — Optimistic reconciliation** | yes (canonically) | `createOptimistic` paired with `action()`. The lane-based override-with-pending-value mechanism gives convergence-in-same-render semantics without React's `useOptimistic` ceremony. **Mechanically more powerful than React** (lanes merge with entanglement; React's `useOptimistic` is per-action-only). |
| **S8 — Preview / what-if mode** | partial | `latest()` (`core.ts:1173`) bypasses pending state to read latest; `refresh()` (`core.ts:1250`) re-invalidates a source. Neither is a true "preview" primitive — no exposable speculative tree. WIP-tree-as-primitive limitation same as React. |

**Policy questions** (per `concurrent-flows.md` Q1–Q5):
- **Q1 (overlay read inside tx):** lane's `_overrideValue` IS the overlay; reads within the lane see overlay; reads outside see committed.
- **Q2 (outside-tx read):** committed truth; can opt into snapshot reads via `_gatedSubs` when entering the lane's scope.
- **Q3 (commit ordering with shared state):** union-find merge — overlapping lanes converge into one; last-write-wins on the merged lane.
- **Q4 (default entanglement):** **automatic detection by structural overlap (d)** — lanes merge when they touch shared subscribers. The strongest entanglement detection in the taxonomy; no user declaration required.
- **Q5 (overlay lifecycle):** revert on transition complete unless action returns successfully; auto-revert is the default.

---

## What pulse can learn from Solid 2.x

### Mechanically advanced over pulse / React

1. **Lanes as a first-class graph coloring with union-find merge.** Merge-on-overlap means "two optimistic writes whose downstream graphs share a node" doesn't blow up. The parent/child non-merge exception (`lanes.ts:126-133`) is a subtle correctness point pulse would want to crib if it goes the optimistic-overlay route.
2. **Throw-to-suspend with a source-pointer token (`NotReadyError.source`)** is a remarkably compact mechanism. Boundaries record *which* upstream is pending without explicit registration API — the boundary just inspects errors flowing through its `notify`. The cost: every async-tolerant read site has to be exception-safe; the re-throw vs catch rules are subtle (see `isPending`'s `try/catch` at `core.ts:1217-1222`).
3. **Generator-as-transaction (`action()`)** is the most expressive thing in the runtime. Each `yield` becomes an atomic commit point; the transition stays alive across awaits; optimistic overrides revert if the generator throws. A beautiful encoding of "an async business operation with intermediate observable states" — and the implementation is only ~95 lines (`action.ts`).
4. **Separate slots for `_value` / `_pendingValue` / `_overrideValue` / `_snapshotValue`** is what allows the system to express overlapping views of the same node simultaneously.
5. **Reveal as a coordination layer above boundaries** — manipulates `_disabled` / `_collapsed` signals on the boundary queues. A "boundary scheduler," not a parallel mechanism. If loading boundaries are first-class objects, you can compose them externally. No other taxonomy row has this primitive.
6. **`_gatedSubs` replay-at-commit mechanism** — explicit machinery for "this subscriber read a stale value during the optimistic phase; rerun it when we commit."
7. **`refresh()` + `isRefreshing()` distinct from initial load** — a real UX win (pulse conflates them).
8. **`latest()` for boundary-bypass reads** — useful for showing the *previous* value while a new one loads.

### Where Solid pays for its expressiveness

- The cyclomatic complexity of `recompute` (`core.ts:148-330`) and `read` (`core.ts:631-889`) is high. Every reactive read goes through ~30+ branches.
- The `Transition` and `OptimisticLane` data structures together carry 15+ fields. The state machine implicit in `transitionComplete` (`scheduler.ts:703-742`) is non-trivial.
- The system is dependent on careful exception discipline — any code path inside `recompute` that doesn't re-throw `NotReadyError` will break suspension. The `try { fn() } catch (e) { if (e instanceof NotReadyError) throw e; ... }` pattern recurs.

### What pulse could plausibly adopt without a full architectural rewrite

1. **`action(function* () { yield … })`-shaped primitive.** This could be a pulse layer that builds on signals + `<Loading>` — wrap a generator, treat each yield as a step boundary, batch writes between yields. The infrastructure pulse already has (pipeline-OR `isPending`, gather-on-`<Loading>`) is the substrate.
2. **`refresh()` + `isRefreshing()` semantic distinction.** Mostly an API/diagnostic concern, not a deep architectural change.
3. **`latest()` for boundary-bypass reads.** Small read-primitive addition. Useful for "show previous value during refetch."
4. **`<Reveal>` ordering primitive.** More substantial but mechanically tractable — coordinate sibling `<Loading>` boundaries with sequential/together/natural ordering controlled by a reactive accessor.
5. **`NotReadyError`-carries-source.** Pulse's `NotReadyYet` could carry source-node identity in the same way; the per-source pending tracking is what makes `transitionComplete` decidable. Small change, real precision gain.

### What pulse should NOT adopt without deeper consideration

- **Per-write lane allocation with union-find merge.** Heaviest machinery in Solid 2.x; real complexity commitment. Pulse currently bets on user-explicit transactions via Plan A/B/C boundaries. Adopting Solid's lanes would mean abandoning that bet. Full design exploration, not casual adoption.
- **The four-value-slot per-node model.** Pulse should consider whether its model can collapse to one slot (simpler, but loses overlay) or needs the multi-slot setup.
- **`_gatedSubs` replay.** Mechanically rich, only useful in conjunction with lanes.

---

## Open questions resolved

### "Speculative-state isolation" axis (from session 6)

**Solid 2.x sits at the per-action-overlay value, with per-write-lane-merge as a refinement.** The per-lane `_overrideValue` is per-write-overlay; lane-merging-on-overlap creates emergent per-transition-tree-ish behavior; `_queueStash` parks effect-tree state across transition stashing. Strictly Solid is **between "per-action overlay" and "per-transition tree"** on the axis.

This is a refinement of the axis: there may be a fifth value — **"per-write lane overlay with merge"** — sitting between per-action and per-transition. Solid is its own row in this space.

### "Dependent-dispatch capability" axis (from session 5)

**Solid 2.x is "await-only with generator-batching."** The generator action lets you write multi-step dependent work in a single value, but each step is still re-execution on resolve (not pipelined eager-dispatch). The yield-boundary is an *atomicity* primitive, not a *pre-resolve dispatch* primitive.

Refines the axis values:
- **none / await-only** — JS Promise, React `use(promise)`
- **await-only with generator batching** — Solid 2.x `action()`, Bonsai `let%bind.Effect`, effect-ts `Effect.gen`
- **pipelined** — Cap'n Proto, Agoric `E()`
- **pipelined+typed** — Cap'n Proto with IDL

Solid is third datapoint in the middle bucket alongside Bonsai and effect-ts. The axis is now well-populated: **promote from candidate to confirmed axis on the next consolidation pass.**

### Message-send triangle (cross-cutting thread)

**Solid 2.x is the same corner as pulse and React** (currently-resolved-with-re-execution). The generator yield boundary is a *step-batching* mechanism, not a "message to a not-yet-here receiver." The middle corner of the triangle is still uninhabited by current JS frameworks.

But Solid 2.x's `action(function* ...)` is the *closest thing in JS* to "the middle corner is reachable, locally." The generator describes dependent work to the runtime; the runtime executes it as one transition. If you swapped local execution for remote dispatch, you'd have Cap'n Proto's middle-corner pipelining. Sharpens the cross-cutting thread: **the local equivalent of pipelining is "generator-as-transition-script."**

---

## Open questions raised

What this dive did not verify (flagged honestly):

1. **How `<Errored>` interacts with the transition machinery.** Read `CollectionQueue.notify` but didn't trace what happens when an error fires during a stashed transition. Does the transition still commit? Does the action's Promise reject? The action wrapper has an error path (`action.ts:74-77`) that calls `done(undefined, e)` and rejects, but cross-talk between thrown async-errors-mid-transition and the boundary's error capture wasn't traced.
2. **Whether optimistic overlays compose across nested actions.** The lane system's union-find suggests they merge, but `_parentLane` exists explicitly to prevent some merges — unclear when a nested `action()` inside another `action()` creates a new lane vs reuses the parent's.
3. **The `_gatedSubs` replay mechanism in detail.** The doc at `scheduler.ts:569-570` says it "replays entanglement: subs recorded by the read-time gate get rescheduled." The gate at `core.ts:849-860` is the recording side. Understood conceptually but not worked through a concrete scenario.
4. **`createResource` / `createAsync` shape.** These higher-level APIs aren't in `@solidjs/signals` — they're in `solid-js`. The runtime supports them, but the user-facing async-fetcher API with `AbortSignal` plumbing presumably lives there.
5. **`createProjection` and store-snapshot interactions.** Snapshot fields (`_snapshotValue`, `CONFIG_IN_SNAPSHOT_SCOPE`, `snapshotCaptureActive`) are referenced throughout `read` and `setSignal` but the store code wasn't read. Appears related to component-rendering consistency under transitions.

Design-direction questions raised by the dive:

- Could pulse adopt `action(function*)` *without* lanes? The generator-as-transition-script is partially decoupled from lane machinery; pulse's gather-on-`<Loading>` could be the substrate. **Worth focused design exploration.**
- What's the runtime cost of per-write lane allocation at scale? WeakMap + Set per optimistic write; lane merging on every propagating write. Worth profiling before pulse adopts anything similar.
- `<Reveal>`'s nested-composition pattern (inner registers as slot in outer) is a fractal-coordination shape that may generalize beyond reveal-ordering. Worth a separate sketch.

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`react-modern.md`](./react-modern.md) (session 6) — direct mechanical comparison. React: 31 fixed bitmask lanes + WIP-tree + `use(promise)` + `useOptimistic` per-action overlay. Solid: per-write dynamic lanes + union-find merge + `NotReadyError(source)` + `createOptimistic` with auto-revert via lanes. Solid's entanglement detection is mechanically more advanced; React's WIP-tree-as-primitive is mechanically more advanced.
  - [`bonsai-incremental.md`](./bonsai-incremental.md) (session 4) — Bonsai's `let%bind.Effect` is the OCaml analog of Solid's `action(function*) { yield … }`. Both are "generator-shaped transactional composition over a reactive substrate" but Bonsai's effect layer is *separated* from the reactive graph; Solid's is fused.
  - [`capnproto-e-pipelining.md`](./capnproto-e-pipelining.md) (session 5) — Solid's `action()` is the closest thing in JS to pipelining-shape, but it's local-only. Shared idea: "describe dependent work to the runtime, runtime executes as one transaction"; what Cap'n Proto adds: "remote dispatch with pre-resolve method invocation."
  - [`effect-ts.md`](./effect-ts.md) (session 2) — effect-ts `Effect.gen` shares the generator-as-composition pattern. Different surrounding semantics (typed effects, structural cancellation).
  - [`algebraic-effects.md`](./algebraic-effects.md) (session 3) — Solid 2.x re-execution-on-resolve is in the same camp as React, pulse: encoded handlers via re-execution, not true continuation resumption.

- **Taxonomy axes this dive informed:**
  - **Conflict-handling policy:** confirms "union-find lane merge with parent-child exception" as a distinct value, materially different from STM retry / MVCC snapshot / React pre-empt.
  - **Speculative-state isolation:** refines — Solid sits between "per-action overlay" and "per-transition tree." May need fifth axis value.
  - **Async representation:** confirms "procedure + throw-protocol-with-source-identity" as a coherent value; the source-identity wrinkle (carrying the offending node) is the precision pulse's `NotReadyError` should match.
  - **Atomicity granularity:** "per-yield-step / per-transition" is the precise framing. Multi-layer atomicity (effect-ts STM+Scope; Solid yield+transition) may warrant its own value.
  - **Dependent-dispatch capability:** Solid is third datapoint for "await-only with generator batching"; promote axis from candidate to confirmed.

- **Scenarios this dive addressed:** S1 yes-better-than-React, S2 yes, S3 yes-ergonomically, **S4 yes-better-than-React** (independent lanes don't batch), S5 partial-with-gated-subs-mechanism, S6 partial, **S7 yes-canonically with auto-revert** (createOptimistic + action), S8 partial.

- **Cross-cutting threads this dive tested:**
  - **Message-send triangle:** Solid is same-corner-as-pulse, but `action()` is the closest JS gets to the middle corner locally. Sharpens the triangle.

---

## Notes / aside

- **The pre-2.x Solid suspense story used a `Suspense` boundary catching a Promise throw (React-style).** 2.x's `NotReadyError` carrying a `.source` pointer is a clear evolution — the boundary can now know *what* is pending, not just *that* something is pending. That's what enables `transitionComplete` to track per-source live-reporter sets and decide commit-readiness precisely (`scheduler.ts:686-742`). A small-looking change with significant downstream design implications.
- **The phrase "lane" in Solid 2.x is *not* the same as React's lanes** (priority levels). Solid's lanes are **per-optimistic-write contexts** — they identify *which optimistic operation* is responsible for an in-flight update, not *what priority* it has. The merge semantics are union-find on overlap, closer to a Disjoint Set Union for dependency-overlap tracking. Worth re-emphasizing if anyone reading our research conflates the terms.
- **The `NOT_PENDING = {}` sentinel** (`constants.ts:33`) is used pervasively as "no value here" — a unique object reference checked with `===`. `undefined` can't work because nodes can legitimately hold `undefined` values.
- **The whole system invites the question of whether pulse should be graph-fused** (everything in one heap, one flush) the way Solid is, or whether it wants a clearer separation between sync and async layers. Solid's fusion is what enables the elegance of `isPending(() => x())` and `latest(() => x())` as first-class reactive reads.
- **The `NotReadyError` docstring** (`error.ts:1-23`) is unusually clear — "Surfacing through the reactive graph is what suspends the consumer scope." When a docstring is this precise about the protocol, it's worth quoting directly. Most of the optimistic-lane code does *not* have this level of doc; the lane semantics had to be reconstructed from the implementation.
- **`action()` calls `globalQueue.initTransition()` without arguments** (`action.ts:58`), which creates a new transition if none exists or reuses the active one if same-clock. This is what allows nested actions to share a transition. Whether design intent or emergent, not verified against tests.
- **Methodology note: source-reading was substantially more precise than docs-only.** Worth doing for any system pulse takes seriously as a design inspiration. Pre-dive estimate of "5 axes verified from docs" expanded to "8 axes verified from source" once the actual implementation was read. **Convention noted in CONTEXT.md: source-reading is the gold standard for primary dives where the system is open-source and architecturally adjacent to pulse.**
- **This dive was conducted as two parallel passes** (one in the main session, one by a fresh background agent given only the source) and merged. The fresh pass caught at least one over-claim (atomicity "three layers" became "per-yield within action; per-transition outside") and contributed the four-value-slot framing that anchors the analysis. Worth doing again for the next high-value primary dive.
- **The cousin relationship.** `@solidjs/signals` and pulse's r3 are both Ryan Carniato's work, structurally adjacent but different in detail. The cousins-not-parent-child framing from the earlier comparative-analysis README work holds up: this dive is "what the other cousin built," not "the parent we descend from."
- **Solid 2.x is still beta (2.0.0-beta.13).** API surface may evolve. Cells are accurate for this beta; re-verification at 2.0 GA is warranted.

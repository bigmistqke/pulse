# Pulse — open questions

Sub-questions and design calls that aren't (yet) settled by the [framings](./framings.md) or the [traces](./scenario-traces.md). Each is either:

- a *sub-question* surfaced by a trace that doesn't gate the architecture but is part of the next-level resolution work,
- a *design call* between two coherent positions the architecture supports,
- or a *gap* the framings haven't addressed yet.

**Companion documents:**
- [README.md](./README.md) — overview + index.
- [prior-art.md](./prior-art.md) — cross-framework analysis.
- [framings.md](./framings.md) — principles, framings, engine + library sketches.
- [scenarios.md](./scenarios.md) — TDD catalog.
- [scenario-traces.md](./scenario-traces.md) — end-to-end traces.

## Contents

- [Q1 — Fall-through and edge policy](#q1--fall-through-and-edge-policy)
- [Q2 — Scope/Owner unification](#q2--scopeowner-unification)
- [Q3 — Consumer patterns](#q3--consumer-patterns)
- [Q4 — Async at the engine level](#q4--async-at-the-engine-level)
- [Q5 — Recipe / cache asymmetry between Signal and Computed slots](#q5--recipe--cache-asymmetry-between-signal-and-computed-slots)
- [Q6 — What is a Scope as a value?](#q6--what-is-a-scope-as-a-value)
- [Q7 — The `defaultRecipe` mechanism](#q7--the-defaultrecipe-mechanism)
- [Q8 — Tracker vs Scope: separate or unified?](#q8--tracker-vs-scope-separate-or-unified)
- [Q9 — Read-populated vs write-populated slots: do they differ structurally?](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)
- [Q10 — Commit semantics: ordering, atomicity, deferred fires](#q10--commit-semantics-ordering-atomicity-deferred-fires)
- [Q11 — Effect chain policy: chain follows owner, or always `[ROOT_SCOPE]`?](#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope)
- [Q12 — Body cleanups vs scope cleanups: composition and re-entrancy](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
- [Q13 — Optimistic surface ergonomics (sugar over speculation)](#q13--optimistic-surface-ergonomics-sugar-over-speculation)
- [Q14 — Action prereqs / standing-state handle](#q14--action-prereqs--standing-state-handle)
- [Q15 — Entanglement (Dim 4): overlapping speculations on shared state](#q15--entanglement-dim-4-overlapping-speculations-on-shared-state)

---

### Q1 — Fall-through and edge policy

Status: **resolved — Model 1 (engine-managed chains).** Selected on the "lean on r3" criterion: Model 1 is the minimal-possible-delta from r3's existing fire mechanism. The exercise of comparing alternatives is preserved below as historical exploration — Models 2/3/4 and Options 6/7 were each considered and found to be bigger departures than the problem warrants.

**Decision rationale.** R3 already gives us the tracker mechanism, the propagation machinery, push-pull-push scheduling, dirty-bit logic — none of which Q1 questions. The single structural delta speculation forces is multi-slot per Node (the falsified-hypothesis result). Once multi-slot exists, r3's write fire-loop needs exactly one new predicate:

```ts
function writeSlot(node, scope, value) {
  node.slots[scope] = { cached: value, subs: [...] }
  for (const sub of node.subs) {
    if (chainMatch(sub, scope)) invalidate(sub)   // ← only delta from r3
  }
}
```

Where `chainMatch(sub, writeScope)` walks `chainFor(sub.targetSlot.scope)`, finds `writeScope` in it, and returns true iff no more-specific scope in the chain has its own slot. The chain is derived from the target slot's scope (a structural property); nothing is captured in a closure; nothing is tagged on the edge. Edges stay r3-shaped: plain `(source, target)` references on `node.subs`.

This means: scope identity stays inside scope-owned data structures (slots, action handles, parent pointers); the engine is introspectable ("why did this fire" is data, not a closure call); custom non-chain policies would require engine extension (not free, but the demonstrated policy space is small — chain plus root-only — and adding kinds is straightforward if needed later).

**The break, traced concretely.** With `name`, `doubleName = compute(() => get(name) + get(name))`, and the initial outside-action `get(doubleName)` populating `doubleName.slots[ROOT_SCOPE] = "foofoo"` plus an edge `name.slots[ROOT_SCOPE] → doubleName.slots[ROOT_SCOPE]` (using the library's convention that "outside any action" uses `ROOT_SCOPE` as the scope key):

```ts
action(function* () {
  // Inside scope S. name.slots[S] doesn't exist; doubleName.slots[S] doesn't exist.
  get(doubleName)
  //   - doubleName.slots[S] miss → populate: invoke defaultRecipe under S.
  //   - Recipe runs. get(name) under S → name.slots[S] miss → walk falls
  //     through to name.slots[ROOT_SCOPE] → "foo". Twice → "foofoo".
  //   - Cache in doubleName.slots[S]. Register an edge from name → this slot.
  //     ↓ THE QUESTION: what does that edge look like, and how does the
  //     engine know to fire it when name.slots[S] is later created? ↓
  setName("name")
  //   - writeSlot(name, S, …) — creates name.slots[S].
  //   - Naive slot-to-slot edge (source = name.slots[ROOT_SCOPE]) doesn't
  //     match the write to name.slots[S]. doubleName.slots[S] stays cached
  //     "foofoo". WRONG. The engine has to know more than "source slot".
})
```

Simple slot-to-slot edges cannot handle fall-through *by themselves*. The engine has to know something extra — chain semantics, a per-edge predicate, or a re-link discipline. Models 1–4 below explore the design space of "edges on the source node," differing in *where* and *when* chain knowledge is applied. Options 6–7 step outside that frame entirely and question commitments (push-based reactivity, edge-on-node storage, cross-scope edges at all) that were inherited from r3 without explicit defense.

**Historical: alternatives considered.** Each was evaluated and rejected relative to Model 1; preserved for the reasoning trace.

**Four edge-on-node models.**

*Model 1 — Engine-managed chains.* Edges hold plain `(source, target)` pairs; no scope identities, no closures. On a write, the engine computes `chainFor(edge.target.scope)`, locates `writeScope` in it, checks for shadowing slots in more-specific positions, fires if not shadowed. The engine knows about chains; the policy is data, not a callback. (Strictly speaking this is a refinement of the original "re-link on slot creation" sketch — same engine-side chain semantics, computed at fire-time rather than maintained as a re-link.)

```ts
interface Edge { source: Node; target: Slot }

// On writeSlot(node, writeScope, ...):
for (const edge of node.subs) {
  const chain = chainFor(edge.target.scope)   // derived; not captured
  const idx = chain.indexOf(writeScope)
  if (idx === -1) continue
  let shadowed = false
  for (let i = 0; i < idx; i++) {
    if (node.slots.has(chain[i])) { shadowed = true; break }
  }
  if (!shadowed) invalidate(edge.target)
}
```

Trade-offs: *no scope refs in edges* — scope identity stays inside scope-owned data structures (slots, action handles, parent pointers); engine is **introspectable** — "what does this edge fire on" is structured data, not a closure call; natural indexing path (bucket edges by target scope); but the *engine knows about chains* — fall-through semantics are baked in, and non-chain policies (latest-bypass, scope-only, snapshot-at-T) need engine extension to support.

*Model 2 — Selector-on-edge.* Edges store a *selector function* — a walk-defined predicate that decides whether a write matches. The engine queries selectors on every write to the source Node.

```ts
interface Edge {
  source: Node                              // not slot — the policy decides
  target: Slot
  fires: (sourceSlots, writeScope) => boolean
}
// On writeSlot(node, S, ...):
//   walk node.edges
//   for each: if edge.fires(node.slots, S) → invalidate edge.target
```

A library ships the common selectors:

```ts
// "Read with this chain; fire when the chain's effective resolution
// would change." The chain is library-provided; the engine sees a
// list of opaque scope keys.
function chainSelector(chain: Scope[]) {
  return (slots: Map<Scope, Slot<unknown>>, writeScope: Scope): boolean => {
    const writeIdx = chain.indexOf(writeScope)
    if (writeIdx === -1) return false
    // Fire only if no more-specific scope in the chain currently has a slot.
    for (let i = 0; i < writeIdx; i++) {
      if (slots.has(chain[i])) return false
    }
    return true
  }
}

// "Only fire on writes to ROOT_SCOPE." (Library convention: e.g. for
// `latest()` reads. ROOT_SCOPE is a library-side constant; the engine
// just sees a particular Scope value.)
function rootOnlySelector() {
  return (_slots, writeScope) => writeScope === ROOT_SCOPE
}

// "Only fire on this exact scope; no fall-through."
function scopeOnlySelector(s: Scope) {
  return (_slots, writeScope) => writeScope === s
}
```

Trade-offs: engine knows nothing about chain semantics — selectors are opaque predicates; extensible to arbitrary new walks without engine changes; cost is per-write per-edge function call (same big-O as today's "walk subs," with a constant-factor bump); edges stay valid across slot creation/destruction (selectors re-evaluate against current state every time, so no slot-lifecycle bookkeeping pressure on the edge structure). *Cost surfaced on review:* selectors close over scope chains (`chainSelector([S, ROOT_SCOPE])`), so edges in long-lived `node.subs` arrays hold scope references inside closures. Cascade cleanup on discard/commit releases them — the lifetime is correct — but the engine becomes **un-introspectable** (debugging "why did this fire" means calling opaque predicates), and scope identity quietly leaks into a long-lived data structure conceptually.

*Model 3 — Edge with structured kind-tag.* Hybrid. Edges carry a small enumerated policy tag plus the minimal data that policy needs; the engine handles each kind with known logic.

```ts
type EdgePolicy =
  | { kind: 'chain' }                          // chain derived from target.scope
  | { kind: 'root-only' }                      // only fire on writes to ROOT_SCOPE
  | { kind: 'scope-only'; scope: Scope }       // exact-scope match
  // ... small enumerated set, growable by engine update
interface Edge { source: Node; target: Slot; policy: EdgePolicy }
```

Trade-offs: most of Model 1's introspectability (policy is data, debuggable, indexable) plus more of Model 2's extensibility (new policies = new tag values + engine handlers, a small surface change rather than zero). The `'scope-only'` variant does hold a scope ref in the edge — so the scope-leak concern returns, but only when explicitly used. Adds engine surface area per policy kind; bets that the space of *useful* policies is small enough (~5) that an enumeration is fine.

*Model 4 — Slot-to-slot edges with re-link on slot creation.* Edges are direct `(sourceSlot, targetSlot)` pointers. When a new slot is created at a more-specific scope — `writeSlot(node, S, ...)` — the engine walks edges into the *old* source slot whose target's chain now resolves through `S`, and re-points them to the new slot. Writes then fire only the actually-written slot's direct subs (no chain-walk at fire time).

```ts
interface Edge { source: Slot; target: Slot }

// On writeSlot(node, S, ...) when this creates a new slot:
//   for each existing edge into a less-specific slot of `node` whose
//   target.scope's chain now passes through S — re-point edge.source
//   to the new slot. Then invalidate. Subsequent writes fire the new
//   slot's direct subs only.
```

Trade-offs: writes are cheap (linear in *direct* subs, not all subs of the node); slot creation pays the chain-walk cost, but creation is rarer than writes. Engine still has to know about chains (for the re-link), so introspectability is preserved. Adds slot-lifecycle bookkeeping (the re-link step on every slot creation), which is the main reason the doc originally rejected it. Trade-off shifts: amortizes work toward slot creation, away from the hot write path.

**Trade-off rebalance (edge-on-node models).**

| Concern | Model 1 (engine chains) | Model 2 (selectors) | Model 3 (kind-tags) | Model 4 (re-link) |
| --- | --- | --- | --- | --- |
| Engine size / minimality | larger (chain semantics) | smallest | medium | medium-large |
| Walk extensibility w/o engine change | low | full | medium | low |
| Edges hold scope refs | no | yes (in closures) | only for `'scope-only'` | no |
| Introspectable "why did this fire" | yes | no | yes | yes |
| Write hot-path cost | O(subs) + chain-walk | O(subs) + closure call | O(subs) + tag dispatch | O(direct subs only) |
| Slot-creation cost | trivial | trivial | trivial | O(affected edges) re-link |
| Honest about "fall-through IS the policy" | yes | hides it behind closures | yes, with named variants | yes |

**Why Model 1 won the rebalance.** The decision criterion is "minimal delta from r3" (see the resolved status above). On that criterion: Model 1 is one predicate added to r3's existing fire loop; Models 2/3/4 each require new edge shapes, dispatch layers, or slot-creation-time bookkeeping. The space of demonstrated policies is also small (chain plus root-only), so Model 2's extensibility argument never paid rent.

**Axis-level alternatives — questioning inherited commitments.**

Models 1–4 all sit inside the same frame: push-based reactivity, edges stored on the source Node, cross-scope edges exist. Those commitments came from r3 and were never explicitly defended. Two options outside the frame:

*Option 6 — Scope-owns-edges (storage inversion).* Subscriptions live on the scope at which the read happened, not on the source Node: `scope.subscriptions: Map<Node, Consumer[]>`. On `writeSlot(node, writeScope, ...)`, the engine iterates `writeScope.subscriptions[node]` plus the same for every descendant scope (chain semantics live in scope-tree downward-traversal). When a scope is committed/discarded, its subscription map drops with it; no node ever holds a scope ref, no edges ever close over scopes. Trade-offs: pristine scope-isolation story (the scope-leak concern dissolves entirely — Nodes know nothing about scopes); writes traverse the scope tree, so cost depends on tree shape (cheap for shallow, potentially expensive for deeply-nested speculations); Node is no longer the primary invalidation entry point, which is a real shift from the r3 lineage but not necessarily wrong.

*Option 7 — Read-locality (per-scope snapshot mini-graphs).* Reads inside a scope snapshot whatever the chain would resolve to into scope-local state on first touch. The scope becomes a self-contained reactivity world — no cross-scope edges exist by construction. Commit replays the scope's writes against root and rebuilds invalidations on the outer graph. Discard drops the mini-graph; nothing outside ever saw it. Trade-offs: the fall-through problem *dissolves* (no chain semantics needed; reads see scope-local state period); pays read-side snapshot cost on first touch per node; commit pays replay cost; the mental model changes — speculations are *forks* of state, not overlays on it. Especially clean fit if pulse's primary use case is bounded short-lived speculations (most UI optimistic-update flows).

These differ from Models 1–4 along *different axes* and aren't directly table-comparable. The relevant question isn't "Option 6 vs Model 3"; it's "do the inherited commitments still earn their keep?"

- Push-based reactivity inherited from r3 → pull/version-based alternatives (Adapton-style) weren't seriously considered.
- Edges-on-source-Node inherited from r3 → scope-owns-edges (Option 6) inverts this.
- Cross-scope edges inherited as obvious → read-locality (Option 7) questions whether they should exist.

Worth weighing each commitment on its own before picking a Model. If Option 7's snapshot cost is acceptable, it may genuinely dominate Models 1–4 on simplicity (no fall-through machinery, no scope leakage, scope disposal is trivial). The question becomes whether the snapshot cost is acceptable for pulse's expected workload.

**Decision (recap):** the "lean on r3" criterion settled it for Model 1 — multi-slot is the irreducible delta; Option 7's fork model would discard r3's per-node sub-list entirely and re-build the reactivity layer per scope. Too big a departure for the benefits available. Kept as a plausible future pivot if the per-scope snapshot model ever becomes attractive for other reasons.

**Commit / discard paths trace cleanly under all three models** — the chain-walk semantics are the same; only *where the logic lives* differs.

- *Commit `S`.* Slots tagged `S` get promoted (the library does `writeSlot(node, parentScope, ...)` for each, then drops the slot at `S`). Each promotion is a write to `parentScope`. Under Model 1/3 the engine computes shadow-checks; under Model 2 the chainSelectors evaluate. Either way: downstream consumers in `parentScope`'s chain invalidate and recompute.
- *Discard `S`.* Drop slots tagged `S`. Edges into those dropped slots also drop (slots own their incoming edges; cascade-removed). Downstream readers outside `S` are untouched. ✓
- *Supersession.* Discard old scope; open new scope.

**Sub-questions still open at the next level down.**

Independent of which model wins:

- *Indexing.* For a hot Node with many subscribers, fire-on-write should not be linear in `node.subs`. Under Model 1/3 the engine has structural data (target scope, policy tag) to bucket by; under Model 2 selectors must expose a hint (`whichScopesDoICareAbout`) for the engine to index. Indexing wants Model 1 or 3.
- *Selector parameter shape (Model 2 only).* If Model 2 wins, the predicate signature is `(sourceSlots, writeScope) => boolean` — minimal. Should it also carry the specific slot, previous value, or target context? Each addition trades power for complexity. Minimal start is the safe default.
- *Edge identity across recomputes.* Each recompute rebuilds `deps`. New edges are formed each time. Under Model 2, selector functions are re-allocated; library-side memoisation if it matters. Under Model 1/3, the edge is plain data and cheap to recreate.
- *Dropped-slot races.* If a write fires an edge whose target slot has been dropped (scope discard between write and notification), the engine detects and skips. Lazy-prune-on-iteration. Same answer under all three.
- *Async writes ([Q4](#q4--async-at-the-engine-level) interaction).* Resolved: resolution is **not** an engine event. A slot's `cached` may be an Awaitable whose internal `status` flips later, but the slot's *identity* hasn't changed and there's no `writeScope` to feed any policy mechanism. Consumers that need to react to resolution already hold the Awaitable reference (returned by `get`); they attach their own `.then` / `yield*` / `use`. The fire mechanism (under whichever model) stays writes-only. See [Q4](#q4--async-at-the-engine-level).

**Related:** [Q3](#q3--consumer-patterns) (consumers subscribe via the same edge mechanism; consumer notification IS a "fire an edge" event whose target is a side-effect handler instead of a cache invalidation), [Q7](#q7--the-defaultrecipe-mechanism) (`defaultRecipe` is a similar engine-vs-walk question at a different level), [Q4](#q4--async-at-the-engine-level) (async resolution is *not* a write event; see Q4).

### Q2 — Scope/Owner unification

Status: **resolved.** One ambient context primitive (the [Q6](#q6--what-is-a-scope-as-a-value) `Scope` shape) supports both uses. An "owner scope" is just a `Scope` whose `writeSet` stays empty — only cleanups and child scopes get registered. A "speculation scope" is a `Scope` that has `writeSlot` calls populating its `writeSet`. Same primitive, different usage pattern.

One small concession to the unification: `scope.kind: 'owner' | 'speculative'` (per [Q6](#q6--what-is-a-scope-as-a-value)) is set at creation time so library-level invariants can be enforced (e.g., [Q3](#q3--consumer-patterns) forbids `effect(...)` inside speculative scopes). The engine never branches on `kind`; the shape and behaviour of the scope are otherwise identical.

**Sub-questions resolved:**

- *Are scope identities first-class?* No — opaque, library-mediated. Users get an action handle (per [Q6](#q6--what-is-a-scope-as-a-value)) exposing `.status`, `.commit()`, `.discard()`, `.onCleanup()`. Scope identity is engine state.
- *What is a scope as a value?* See [Q6](#q6--what-is-a-scope-as-a-value)'s shape.
- *How does commit interact with cleanups?* Discard only (per [Q12](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)).
- *Tracker vs scope:* separate ambients, parallel-coupled (per [Q8](#q8--tracker-vs-scope-separate-or-unified) and confirmed by K1 trace).

**Related:** [Q6](#q6--what-is-a-scope-as-a-value) (shape), [Q8](#q8--tracker-vs-scope-separate-or-unified) (tracker), [Q12](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy) (cleanup semantics), [Q11](#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope) (owner-chain reactivity).

### Q3 — Consumer patterns

Status: **resolved.** Consumer shape verified by [H1a-c trace](./scenario-traces.md#h1a-c--effect-under-speculation); microtask batching, dirty propagation, and effect ordering pinned by [P6](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush).

**Restriction: `effect(...)` is forbidden inside a speculative scope.** At effect-creation time, the library walks `currentScope` and its ancestors; if any has `kind === 'speculative'` (per [Q6](#q6--what-is-a-scope-as-a-value)'s `kind` field), the call throws. Rationale: effects-in-actions have no clean lifecycle story (commit versus discard requires different cleanup vehicles; see [Q12](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)) and no demonstrated legitimate use case. Effects in *owner* scopes (component scopes, `createRoot`) remain fine — Policy α from [Q11](#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope) applies there. If a real use case for in-action effects surfaces, this restriction can be lifted by resolving the H3b cleanup-vehicle question.

**Candidate framing.** Consumers are *library code* over the engine's `subscribe` primitive plus a scheduler. Uniform shape:

```ts
function consumer(node, onSlotChange) {
  return subscribe(node, e => {
    if (e.kind === 'invalidated') scheduleMicrotask(onSlotChange)
  })
}
```

`Effect`, `JSX-binding`, and `Computed-cache-dependent` are all `consumer(…)` calls with different `onSlotChange` bodies (re-run side-effect body, schedule DOM update, mark cache dirty + propagate). No engine primitive distinguishes them.

**Deferred-until-commit semantics** for effects-under-speculation fall out of **chain-match composition**, not engine logic: an effect created in `ROOT_SCOPE` has its tracking edges targeting a consumer slot in `ROOT_SCOPE`. Per [Q1](#q1--fall-through-and-edge-policy) Model 1, the engine's chain-match predicate at fire time uses `chainFor(ROOT_SCOPE) = [ROOT_SCOPE]` — writes to a speculative scope are not in the chain → don't fire. Writes to `ROOT_SCOPE` (commit promotion) are in the chain → fire. *No defer logic anywhere; the chain is the policy.*

**Verified by [H1a-c trace](./scenario-traces.md#h1a-c--effect-under-speculation).** H1a (write under S → effect doesn't fire), H1b (commit → effect fires once), H1c (discard → effect never fires).

**Load-bearing principle ([P6](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush)): pull-driven reads, push-driven notifications, no explicit flush.**

The two halves of reactivity get different treatment:

- *Reads (computeds, JSX-bindings as queried)* are **pull-driven**. A read always returns the value consistent with the current committed state. There is no read that requires "await microtask" or "flush()" or "batch close" to be coherent.
- *Side-effecting consumers (effects, JSX re-renders)* are **push-driven with microtask batching**. Multiple invalidations of the same consumer within one synchronous turn produce exactly one re-run on the next microtask. Users never call `flush()` or `batch()` — the mechanism is invisible.

Concretely:

```ts
setValue('x')
console.log(get(doubleValue))   // "xx" — always, synchronously
```

This works because invalidation propagates *synchronously* (cache is cleared, dirty bit set), but recomputes happen *lazily on read* (recipe runs when `get` finds a dirty slot). The "batching" only applies to side-effecting consumers, which are inherently async (microtask-scheduled) anyway — so users observing values via reads never see partial state, and users observing values via effects see batched updates without writing any flush code.

**Resolved sub-questions:**

- *Microtask batching for consumers.* Per-Node "scheduled" flag. When an invalidation event arrives at a consumer, set the flag; subsequent invalidations in the same turn no-op. Microtask drains scheduled consumers; each runs once. Library-side mechanism, no engine involvement.
- *No explicit flush API.* Users never write `batch(() => ...)` or await a microtask to read coherent state. The pull/push split is the architectural guarantee.
- *Dirty propagation.* Synchronous through the chain-match: on write, engine invalidates direct subscribers; computed consumers' `onSlotChange` clears their cache *and* re-fires their own subs (cascade). Each invalidation in the cascade is O(1) (set a dirty flag); no recompute happens until a read. So invalidation cascades are cheap; the work amortizes to read sites and to microtask-batched consumer re-runs. Library iterates this through the existing engine `subscribe` mechanism; no special engine primitive needed.

**Additional sub-questions resolved:**

- *Effect priority and ordering.* **FIFO — registration order within the per-microtask scheduled set.** No priority lanes (Dim 3 isn't load-bearing for pulse's expected workload). If a use case forces a priority story later, the scheduler can be extended; default stays FIFO.
- *Effect-during-recompute (re-entrancy).* Covered by [K1 trace](./scenario-traces.md#k1--re-entrant-setter-mid-recompute) at the recompute level; consumer-level re-entrancy is the same mechanism generalized.
- *Effects at chains longer than 1.* Component-owned effect chain `[component_scope, ROOT_SCOPE]`; action-inside-component effect chain `[action_scope, component_scope, ROOT_SCOPE]`. The chain-match per [Q1](#q1--fall-through-and-edge-policy) handles it structurally (`chainFor(effect.targetScope)` walks the parent pointers); trace H2 would verify by example but no new mechanism needed.

**Related:** [Q1](#q1--fall-through-and-edge-policy) (engine-side chain-match is the policy; [Q3](#q3--consumer-patterns) subscribes via the same edge mechanism), [Q4](#q4--async-at-the-engine-level) (Promise resolution is *not* an engine event; consumers hold the Awaitable and handle their own resumption), [Q7](#q7--the-defaultrecipe-mechanism) (`defaultRecipe` interacts with consumer's initial run).

### Q4 — Async at the engine level

The recipe is `() => T` where `T` may itself be `Promise<U>`. The engine sees Promises in `cached`. Per [P2](./framings.md#p2--acknowledge-async-dont-hide-it) (acknowledge async), walks decide how to handle them.

**Resolved by the `Awaitable<T>` framing** (see the "Awaitable" framing section above): when the engine encounters a Promise in `slot.cached`, the library's `get(node)` walk wraps it in an `Awaitable<U>` — a Promise subclass that carries `status` / `value` / `reason` fields *as class instance state* (not as tweaked side-properties on foreign Promises).

This collapses the earlier Promise-tweak-vs-WeakMap question. The state lives on the Awaitable instance:

- *Status query* — `awaitable.status` (synchronous, no side-table lookup).
- *Async wait* — `await awaitable` (Awaitable extends Promise).
- *Generator wait* — `yield* awaitable` (Awaitable implements `[Symbol.iterator]`).
- *React-convention interop* — `makeAwaitable(foreign)` duck-types the incoming Promise for `status`/`value`/`reason` and adopts the state if present.

The engine doesn't need a separate `promiseState()` helper or `WeakMap<Promise, T>` side-table. Awaitable IS the Promise-with-state type; the user accesses the fields directly.

**The engine does *nothing* on resolution.** When a Promise lands in a slot's `cached`, the engine's work is done: it fired edges for the write that put the Awaitable there. Resolution is a state-flip *inside* the Awaitable instance — `status: 'pending'` becomes `'fulfilled'`/`'rejected'` and `value`/`reason` populates — but the slot's `cached` still points at the same Awaitable. No write, no `writeScope`, no edge event.

Consumers that need to react to resolution **already hold the Awaitable reference** — `get(asyncNode)` returned it to them. They attach their own resumption mechanism:

- *Generator stages and action bodies* — `yield* get(asyncNode)`. The generator driver awaits the Awaitable and resumes the generator.
- *`use(node)` (throw-to-suspend)* — the surrounding boundary catches and re-tries when the Awaitable settles.
- *`isPending(node)` for UI* — the walk reads `.status` on the Awaitable and, for tracked subscribers, attaches a one-shot `.then` that invalidates its *own* subscription channel (not a slot-write). The engine doesn't generalize Promise resolution into a write event.

This preserves [P2](./framings.md#p2--acknowledge-async-dont-hide-it): async re-trigger paths are *explicit per walk*, not ambient. It also keeps Q1's chain-match predicate clean — the engine fires on writes only, never on resolutions.

**Settled by Awaitable + the [C2 trace](./scenario-traces.md#c2--action-body-with-async-read):**

- *Does the engine `await` internally?* No — walks handle suspension via `yield* get` or `use`. Engine doesn't observe Promise resolution at all.
- *Does the engine attach `.then` to slot Promises?* No. The consumer that asked for the Awaitable holds it and attaches its own handlers.
- *Does the engine track which slots are pending?* No — pending-ness is derived from `(get(node) as Awaitable<U>).status === 'pending'`. The `isPending(node)` walk reads the status field and (when invoked from a tracking consumer) manages its own resolution-subscription channel.
- *Where does Promise state live?* On the Awaitable class instance — pulse owns the wrapper. Foreign Promises (React, TanStack Query, etc.) are duck-typed for interop and their state copied into our Awaitable.
- *Mutation of foreign Promises?* Avoided. Pulse never tweaks Promises it doesn't own; it wraps them in Awaitable instances.

**Related:** [Q3](#q3--consumer-patterns) (consumers handle their own resumption — they hold the Awaitable from `get`), `yield* get` vs `use` vs stages (see framings), [Q9](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) (a Promise that resolves is "still the same slot," not a write, so doesn't trigger commit-promotion).

### Q5 — Recipe / cache asymmetry between Signal and Computed slots

Status: **dissolved by [Q9](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) + [Q6](#q6--what-is-a-scope-as-a-value).**

The slot shape stays uniform — `{ recipe, cached, deps }`. There's no "signal slot kind" vs "computed slot kind" at the engine level. The distinction was an artifact of conflating two things:

- *Which set the scope files the slot under.* Signal-style writes land the slot in `scope.writeSet` (via setter → `writeSlot`); computed reads land it in `scope.readSet` (via `invoke`-populated cache). This is the Q9 distinction — and it's a *scope-side* distinction, not a slot-side one. The slot doesn't know which set it's in.
- *Invalidation semantics.* Signal slots get *overwritten* by setters, not invalidated. Computed slots get *invalidated*, recomputed on next read. But this is just a fact about which library primitive wrote the slot, not about the slot's shape. The engine's `writeSlot(node, scope, slot)` is the same call either way.

So there's no engine-level asymmetry to resolve. The slot shape is uniform; the *usage pattern* (set vs invoke + invalidate-then-recompute) is what differs, and that lives in the library / scope.

### Q6 — What is a Scope as a value?

Status: **resolved.** Scopes own their slots and edges explicitly; no WeakMap, no GC reliance for correctness. Nodes hold a `subs` index for fast write-fire lookup but no scope references.

**Shape:**

```ts
interface Node<T> {
  defaultRecipe?: () => T | Promise<T>
  subs: Set<Edge>                  // who subscribes to me (fast write-fire path)
}

interface Scope {
  parent?: Scope                   // structural: chainFor walks until undefined
  children: Set<Scope>             // back-link, for descendant queries
  slots: Map<Node, Slot>           // this scope's per-node caches
  edges: Set<Edge>                 // edges created in this scope (cleanup tracker)
  writeSet: Set<Node>              // for commit promotion (per Q9 lean ii)
  readSet: Set<Node>               // for slot drop on close
  cleanups: Disposable[]           // fired on discard
  status: 'open' | 'committed' | 'discarded'
  kind: 'owner' | 'speculative'    // library-level metadata; engine doesn't branch on it
}

interface Edge {
  source: Node
  target: Slot
  targetScope: Scope               // for chain-match: chainFor(targetScope)
}
```

**Lifecycle:**

```ts
// link (during a tracked read):
const edge = { source, target, targetScope }
source.subs.add(edge)              // index, for write-fire lookup
targetScope.edges.add(edge)        // owner, for cleanup

// closeScope (commit or discard):
for (const edge of S.edges)
  edge.source.subs.delete(edge)    // unlink from the index
S.edges.clear()
for (const node of S.readSet) S.slots.delete(node)
// (writeSet handled by commit's promote-or-drop logic; see Q10)
if (mode === 'discard') S.cleanups.forEach(fn => fn())
S.parent?.children.delete(S)
// S is now unreachable except via user-held action handles
```

**Key invariants:**

- *Identity = reference equality on a fresh object.* Engine never inspects scope internals; only compares references during chain-match.
- *Terminal is structural.* `chainFor(scope)` walks `scope.parent` until `undefined`. `ROOT_SCOPE` is just *a* parentless scope the library creates by default. Per-tenant / per-document / multiple-worlds roots fall out for free — any parentless scope is a root. (Resolves the G2 sub-question.)
- *No scope refs in long-lived data.* Nodes hold `subs: Set<Edge>` — each edge holds a `targetScope`, but those edges live in *some scope's* `edges` set and die when that scope closes. Cascading cleanup is explicit.
- *Three-state lifecycle.* `'open' | 'committed' | 'discarded'`. Drivers guard on `status !== 'open'` before resuming async resumes (C2 trace).
- *Write firing stays O(subs).* `node.subs` walked directly per write; chain-match runs engine-side (Q1 Model 1) per edge.
- *`kind` is library metadata only.* Set by the library helper that opens the scope (`action(...)` → `'speculative'`; component-scope helpers / `createRoot` → `'owner'`). The engine never branches on it; it exists so library invariants can be enforced — e.g., `effect(...)` throws if any ancestor scope is `'speculative'` (per [Q3](#q3--consumer-patterns) / H3b dissolution). The unification from [Q2](#q2--scopeowner-unification) stays — the shape is one primitive; `kind` is a small flag for invariant enforcement.

**User-facing API:** opaque, library-mediated. Users get an *action handle* (`const h = action(...)`) exposing `.status`, `.commit()`, `.discard()`, `.onCleanup(...)`. The scope identity inside is engine state, not a passable value.

**Sub-questions resolved by this shape:**

- *G2 terminal-scope sub-question.* Multiple roots = multiple parentless scopes. No engine work.
- *Disposal predictability.* `closeScope` walks finite sets; no GC hand-waving. Memory shape is queryable per scope.
- *Q11 effect chain policy α.* An effect created in scope `S` registers its edge via `S.edges`. When `S` closes, the edge dies — effect reactivity follows owner scope automatically.

**Sub-questions deferred to other Qs:**

- *Where exactly the writeSet/readSet drive commit logic.* → [Q9](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally).
- *Commit ordering and atomicity of multi-slot promotion.* → [Q10](#q10--commit-semantics-ordering-atomicity-deferred-fires).
- *Whether cleanups fire on commit as well as discard.* → [Q12](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy).
- *Whether `currentTracker` is the same ambient as `currentScope` or a separate one.* → [Q8](#q8--tracker-vs-scope-separate-or-unified).

**Related:** [Q1](#q1--fall-through-and-edge-policy) (chain-match consults `edge.targetScope`'s chain), [Q2](#q2--scopeowner-unification) (scope/owner unification — this shape supports both: an "owner scope" is just a scope with no slot writes), [Q9](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) (writeSet vs readSet distinction), [Q11](#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope) (Policy α falls out structurally).

### Q7 — The `defaultRecipe` mechanism

The Node has an optional `defaultRecipe` used by `invoke` when no slot exists for the requested scope. Is this:

- *(i) The right shape.* A convenient "fallback recipe for fresh slots."
- *(ii) Folded into the root-scope slot.* The slot the library tags with `ROOT_SCOPE` *is* the default; `invoke` with no slot for `S` falls through along the walk's chain and creates a slot for `S` using that slot's recipe.
- *(iii) Walk-defined.* `invoke` takes a callback that says what to do when no slot matches — return undefined, fall through, invoke a fallback recipe.

(ii) is most parsimonious but loses the explicit "this is the default recipe" intent and pushes more convention into the library; (iii) is most flexible. Probably a cosmetic question, but worth deciding.

**Sub-question (surfaced by [doubleName trace](./scenario-traces.md#doublename-under-scope-s)):** what `cached` does a *promoted* slot carry? Three sub-positions: (a) preserve `cached` + carry over old deps (but old deps were registered with edges into a slot at the old scope; the chain-match logic at the new scope would re-resolve from scratch anyway); (b) preserve `cached`, drop deps, let next recompute rebuild; (c) drop `cached`, force recompute on next read. *Lean (b)*: preserves the work done in the scope without carrying stale edge structure forward. Related to [Q1](#q1--fall-through-and-edge-policy) (edge re-formation across scope transitions).

### Q8 — Tracker vs Scope: separate or unified?

Status: **resolved — separate ambients, parallel-coupled.** Confirmed by the [K1 trace](./scenario-traces.md#k1--re-entrant-setter-mid-recompute). When a recompute enters, both `currentTracker` (the slot being recomputed) and `currentScope` push together; both pop together. They live at different granularities (tracker is per-recompute, scope is per-action or owner) so unifying them into one primitive would lose information. Re-entrant writes inside a recompute correctly inherit the recompute's scope because both ambients are synchronized.

**Sub-question still open (surfaced by K1 + relates to catalog L1):** *`untrack` interaction.* `untrack(() => ...)` clears `currentTracker` but not `currentScope`. So a `writeSlot` inside `untrack` writes to the current scope normally, but its firing isn't gated by `deferredFires` (which is keyed on tracker). Writes inside `untrack` would fire synchronously even during a recompute. That's plausible (the user explicitly opted out of tracking) but worth confirming as the policy. Connects to L1 in the scenario catalog.

**Related:** [Q2](#q2--scopeowner-unification) (scope/owner unification — tracker is the third ambient, parallel to scope), [Q10](#q10--commit-semantics-ordering-atomicity-deferred-fires) (`deferredFires` is keyed on tracker).

### Q9 — Read-populated vs write-populated slots: do they differ structurally?

Surfaced by the C2d trace. When a slot is created lazily during a read (because no slot existed for the requested scope yet, so `invoke` populated one with the default recipe), it ends up in `node.slots[scope]` *exactly the same way* as a slot created by an explicit `writeSlot` call from a setter. But their commit semantics differ:

- *Write-populated slot.* On commit, the slot's recipe (+ cached value) gets promoted to the parent scope. The intent is "this is what the action did to the node; lift it out."
- *Read-populated slot.* On commit, promoting this slot would clobber any later writes to canonical (e.g., the C2d case where outside-action writes happened during the await). The intent is "this slot was just a memo cache for the duration of the scope; drop it on commit, don't promote."

Status: **resolved — (ii) writeSet on scope.** Sealed by [Q6](#q6--what-is-a-scope-as-a-value)'s scope-centric storage decision: `scope.writeSet: Set<Node>` is now part of the scope shape. Slots stay uniform (`{ recipe, cached, deps }` — no `wasWritten` flag); the scope's writeSet drives commit promotion.

**Commit walks `writeSet`, not `slots`.** For each node in `scope.writeSet`, the library performs `writeSlot(node, scope.parent, scope.slots.get(node))`. Read-populated slots (in `scope.readSet` only) are dropped without promotion — they were just per-scope caches for the duration of the speculation. Resolves the C2d case (outside-action writes during an await don't get clobbered by read-populated slots from inside the action).

**Why not (i):** the per-slot `wasWritten` flag would have spread "is this real state or a cache" knowledge across every slot in the system. (ii) puts it once, on the scope, in the same data structure that already governs the scope's lifecycle.

Connects to [Q5](#q5--recipe--cache-asymmetry-between-signal-and-computed-slots) (Signal vs Computed slot asymmetry) — Q5 may dissolve under this resolution: signal slots are always in `writeSet`, computed slots are always in `readSet`, the distinction is *which set the scope files them under*, not a property of the slot itself.

### Q10 — Commit semantics: ordering, atomicity, deferred fires

Status: **resolved — commit is a deferred-fires region.** Generalizes K1's recompute mechanism: the engine's invariant is "if `deferredFires` is non-null, fires queue; outermost layer drains." Recomputes set up one such region; commits set up another. They compose by nesting.

**The procedure.** Given `closeScope(S, 'commit')` (per [Q6](#q6--what-is-a-scope-as-a-value)'s shape):

1. Open a deferred-fires region. Subsequent `writeSlot` fires queue into the region instead of firing synchronously.
2. For each `node` in `S.writeSet` (per [Q9](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)), in dep-order leaves-first: `writeSlot(node, S.parent, S.slots.get(node))`. Queued fires accumulate.
3. Walk `S.edges` and remove each from `node.subs` (per [Q6](#q6--what-is-a-scope-as-a-value)'s explicit disposal).
4. Drop `S.slots` entries for every node in `S.readSet ∪ S.writeSet`.
5. Recursively close `S.children` (children-first per [Q12](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy); typically empty at this point — children must have closed before their parent).
6. Close the region: deduplicate fires by `(node, targetSlot)`, then call the real `fireEdges` for each. Consumers see one invalidation per affected slot regardless of how many writes contributed.
7. `S.status = 'committed'`. Pop ambient.

**Why dep-order leaves-first.** Sources (the leaves of the dep graph) promote before their dependents. Intermediate fires invalidate but don't re-run until step 6 drains the region, so a derived consumer that depends on multiple promoted signals never observes a partial state.

**Recipes do not open a deferred-fires region.** Writes inside recipes (K1+K1b) fire *synchronously* per K1's resolution to Position (C). This is necessary for in-recipe state coherence: write a signal, read a downstream derived → the derived must recompute fresh against the new value. Cycle protection is consumer-level (max N re-runs per microtask), unaffected by whether fires are deferred.

**Resolved sub-questions:**

- *Nested-commit ordering.* G2's inner-commit-promotes-to-outer case: inner commit fires immediately *within the outer's body* because the body is imperative and may read post-inner state. External consumers (whose target slots live in `ROOT_SCOPE`) are not affected — the chain-match predicate doesn't match writes to the outer's scope against `chainFor(ROOT_SCOPE) = [ROOT_SCOPE]`. So no special nested-region handling is needed; the chain-match already firewalls external consumers.
- *Edge-target-dropped races.* Lazy-prune-on-iteration. When draining fires, skip any whose target slot has been dropped. Standard reactive bookkeeping; not new.
- *Promise resolution during commit.* Per [Q4](#q4--async-at-the-engine-level), resolution is not an engine event. A promoted slot whose `cached` is a pending Awaitable promotes as-is; consumers that read the slot already hold the Awaitable and handle their own resumption. No special-case in commit.

**Open sub-question:** *deferred-fires region semantics for `discard`.*  Discard doesn't promote, but does drop scope-tagged slots and unlink edges. That cascade-removal can itself fire (edges removed from `node.subs` should not invalidate any consumer that still depends on them — they're being removed *because* the consumer is going away). Probably uneventful, but worth a trace if a discard-during-recompute case comes up.

**Related:** [Q6](#q6--what-is-a-scope-as-a-value) (the writeSet / readSet / edges that drive the procedure), [Q9](#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) (writeSet for promotion, readSet for drop), [K1 trace](./scenario-traces.md#k1--re-entrant-setter-mid-recompute) (the deferred-fires mechanism this generalizes), [Q4](#q4--async-at-the-engine-level) (promotion of pending Awaitables).

### Q11 — Effect chain policy: chain follows owner, or always [ROOT_SCOPE]?

Status: **resolved — Policy α (chain follows owner).** Sealed by [Q6](#q6--what-is-a-scope-as-a-value)'s scope-centric storage: an effect created in scope `S` has its tracking edges registered in `S.edges`. The edge's `targetScope` is `S`, so the engine's chain-match consults `chainFor(S) = [S, ..., ROOT_SCOPE]`. Writes inside `S` match the chain and fire the effect; writes outside `S`'s chain don't.

When `S` closes (commit or discard), `S.edges` is walked and each edge is removed from `node.subs` — the effect's reactivity dies with the owning scope, automatically. No "re-parent on commit" machinery needed.

Policy α is what the storage shape produces; Policy β would require explicit override (registering the effect's edges in `ROOT_SCOPE.edges` instead of `S.edges`), and there's no demonstrated need for it. Users wanting an effect to survive past its enclosing scope create it in the outer scope directly.

**Scope narrowed by [Q3](#q3--consumer-patterns)'s restriction:** Policy α applies to effects in *owner* scopes. Effects in *speculative* scopes are forbidden at creation time (throw), so the H3b "bodyCleanups on commit" ambiguity doesn't arise.

**Related:** [Q3](#q3--consumer-patterns) (consumer pattern + speculative-scope restriction), [Q2](#q2--scopeowner-unification) (scope/owner unification — the chain question is "does subscription follow owner or not"), [Q6](#q6--what-is-a-scope-as-a-value) (the storage shape that makes α structural).

### Q12 — Body cleanups vs scope cleanups: composition and re-entrancy

Status: **resolved.** Two distinct cleanup mechanisms with clear homes, sealed by [Q6](#q6--what-is-a-scope-as-a-value)'s scope shape.

- *Scope cleanups* — registered to `scope.cleanups`, fired on scope **discard** (per Q6's `closeScope` logic). For "rollback discipline" — release this resource if the action didn't commit. [`failure.md`](./failure.md#5-body-local-lifecycle-hooks-oncommit-and-ondiscard) proposes the body-local hook spelling for this be `onDiscard(fn)` (renamed from `onCleanup` to pair with a symmetric commit-side `onCommit(fn)`), so the body-local API mirrors P1's two faces. Naming the action-scope hook `onDiscard` also frees `onCleanup` to mean *effect-body* cleanup unambiguously (next bullet).
- *Body cleanups* — `onCleanup(fn)` registered inside an effect body to `effectNode.bodyCleanups`. Fires before next body invocation or on effect disposal. Distinct mechanism from scope cleanups because the lifecycle is per-body-run, not per-scope-close.

**Resolved sub-questions:**

- *Commit vs discard:* the scope-cleanup list fires on discard only. Q6 made this explicit (`if (mode === 'discard') S.cleanups.forEach(fn => fn())`). [`failure.md`](./failure.md#5-body-local-lifecycle-hooks-oncommit-and-ondiscard) proposes adding a symmetric commit-side hook (`onCommit(fn)`, for finalize-on-commit patterns like promoting a provisional resource), which would fire a parallel list on the commit path — extending this, not contradicting it.
- *Re-entrancy during cleanup:* covered by [Q10](#q10--commit-semantics-ordering-atomicity-deferred-fires)'s deferred-fires region. Writes inside a cleanup queue onto the region; outermost drain handles them. No special-case.
- *Nested-scope ordering:* children-first. Scope discard recursively closes children before firing own cleanups. Standard tree-disposal invariant; falls out of `S.children: Set<Scope>` traversal in `closeScope`.
- *H3b — bodyCleanups on commit (surfaced by trace audit).* **Dissolved by [Q3](#q3--consumer-patterns)'s restriction:** effects are forbidden inside speculative scopes, so there are no body cleanups to fire on commit. The cleanup-vehicle ambiguity disappears with the use case.

**Related:** [Q2](#q2--scopeowner-unification) (scope/owner unification carries cleanup composition), [Q6](#q6--what-is-a-scope-as-a-value) (the scope shape that pins the cleanup home), [Q10](#q10--commit-semantics-ordering-atomicity-deferred-fires) (re-entrant cleanups deferred via the same mechanism as commit fires), [`failure.md`](./failure.md#5-body-local-lifecycle-hooks-oncommit-and-ondiscard) (proposes the symmetric body-local pair `onCommit`/`onDiscard` — renames this scope-cleanup hook to `onDiscard` and adds a commit-side `onCommit`; extends the body-local hook family).

### Q13 — Optimistic surface ergonomics (sugar over speculation)

Status: **open — exploration in progress.** The deep dive lives in [`optimistic-ui.md`](./optimistic-ui.md), which frames optimistic UI as speculation that deliberately leaks its value outside the scope, tagged as provisional. That doc is exploration, not specification; its recommendations are current leans, not pinned answers. This stub records the question and where the exploration currently stands.

Mechanism: an optimistic write is one use of speculation (a predicted `setX(...)` inside an action body is held in that action's write-set; auto-discard reverts on failure; commit promotes). No new primitive at the engine level.

**Firmed up (current lean).** The architectural direction — optimistic UI is a *wrapper* over the base signal, not a feature baked into every signal's API — has settled as the exploration's load-bearing commitment. Per [P4](./framings.md#p4--explicit-boundaries-over-implicit-pervasiveness) + [P5](./framings.md#p5--compose-dont-proliferate-in-either-direction), keeping the layering explicit (`optimistic(committedSignal)` as opt-in sugar) keeps the base primitive minimal and the UI affordance opt-in. See [Why the wrapper shape — a layering argument](./optimistic-ui.md#why-the-wrapper-shape--a-layering-argument).

**Still open (the surface).** The wrapper's API shape is a lean, not a lock: the 3-tuple destructure `[optimisticValue, setOptimisticValue, isOptimistic]` ([Tentative recommendations](./optimistic-ui.md#tentative-recommendations)), the explicit dual-setter vs. an auto-promote variant, reader-richness (bare value vs. tagged `{value, status}`), and naming (`optimistic` / `preview` / `tentative`) all stay undecided pending ergonomic feedback. These are surface details layered on the firmed-up wrapper direction, not the direction itself.

**Resolved sub-question:** the wrapper's overlay must clear on *both* commit and discard. Closed by the symmetric body-local pair `onCommit`/`onDiscard` in [`failure.md`](./failure.md#5-body-local-lifecycle-hooks-oncommit-and-ondiscard) (see [Q12](#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)) — the wrapper registers the same teardown on each face; only one fires, so it runs exactly once.

### Q14 — Action prereqs / standing-state handle

An action's readiness to run is information that should be queryable *before* the action runs (a button needs `ready` and `pending` to avoid double-submit). The body itself can't supply this — it hasn't run yet.

**Open:** does the action expose a small family of standing reactive states — `ready` (prereqs met), `pending` (body in flight), `error` (last run failed)? If yes, are the prereqs declared inline (`action( depsFn, body)`) or via a separate prereq-computed that the action consumes? Either shape preserves the "gather-up-front / snapshot-consistent / skew-free input handling" property.

The principle is structurally forced: a standing `ready()` cannot come from an imperative body that hasn't executed. The prereqs must be hoisted into a *declared, continuously-evaluated* expression. That expression is a `compute`/stage. So the structural pattern is **an action = a reactive prerequisite `compute` → an imperative body invoked on demand**, with the body receiving the *resolved* prereq values.

**Traced** — [Q14 scenario trace](./scenario-traces.md#q14--action-prereqs-and-standing-states-ready--pending--error). The structural claim holds with no new engine primitive: `ready` is a forced `compute`; the body's inputs cross in by eager snapshot at invoke (skew-free by closure capture, and the trace exhibits the tear a lazy post-`yield` read would cause); `pending` and `error` are wrapper-managed *committed* side-channel signals — the same deliberately-leaked-status species as [Q13](#q13--optimistic-surface-ergonomics-sugar-over-speculation)'s optimistic overlay, never in the action's speculative writeSet (chain-match would seal `pending` off from consumers, and discard would revert it — both wrong). `error` is the standing-reactive face of [`failure.md`](./failure.md#1-discard-cause-categorization)'s `discardCause`, bridged via `handle.onFailure`. What stays open is API surface only: whether the prereq compute owns the in-flight guard, inline (`action(depsFn, body)`) vs. separately-declared prereqs, and boolean-vs-counter `pending` under action-body-retry — the same ergonomic bucket as Q13.

### Q15 — Entanglement (Dim 4): overlapping speculations on shared state

Status: **open — exploration in progress.** The full deep dive lives in its own document: [`concurrent-divergence.md`](./concurrent-divergence.md). This stub records the question and the current direction.

**The question.** When two concurrent speculations both touch the same signal, what should happen? Pulse's implicit default (snapshot isolation between siblings + last-commit-wins on overlap) falls out of the chain-match mechanism for free, but it's not the right answer for every app pattern.

**Current state of the exploration:**

- **5 of 8 scenario classes (A, E, F, G, H) are handled by pulse defaults** (last-wins, nested actions, `.discard()`, snapshot isolation, microtask batching, out-of-scope).
- **Class B (accumulation)** is mostly an application data-type concern (CRDT-style signal values).
- **Class C (precedence)** is application-level coordination via existing handle queries + `.discard()`.
- **Class D (read-dependent writes)** is the one genuinely unaddressed case in pulse's defaults.

The exploration is *scenario-first*: working backwards from real app patterns to whatever affordances they require, not picking API shapes up front. The doc surveys ~20 speculative patterns common in apps and catalogues ~12 distinct isolation requirements — most of which Solid's auto-merge would actively violate.

**Not committing to specific affordances yet.** Earlier drafts proposed `{ onConflict: 'last-wins' | 'reject' }`, `openGroupScope()`, nested-action coupling, etc. These are *candidates* derived from the scenario walk, not pinned answers. The exploration continues.

**Related:** the [four dimensions of transition](../async/CONTEXT.md#the-four-dimensions-of-transition) in the research lexicon (Q15 = Dim 4); [P4](./framings.md#p4--explicit-boundaries-over-implicit-pervasiveness) (explicit boundaries); [P5](./framings.md#p5--compose-dont-proliferate-in-either-direction) (compose, don't proliferate); [Q6](#q6--what-is-a-scope-as-a-value) (the scope-tree mechanism that supports parentless scopes for per-context isolation).

---


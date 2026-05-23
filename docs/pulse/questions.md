# Pulse — open questions

Sub-questions and design calls that aren't (yet) settled by the
[framings](./framings.md) or the [traces](./scenario-traces.md). Each is
either:

- a *sub-question* surfaced by a trace that doesn't gate the architecture
  but is part of the next-level resolution work,
- a *design call* between two coherent positions the architecture supports,
- or a *gap* the framings haven't addressed yet.

**Companion documents:**
- [README.md](./README.md) — overview + index.
- [prior-art.md](./prior-art.md) — cross-framework analysis.
- [framings.md](./framings.md) — principles, framings, engine + library sketches.
- [scenarios.md](./scenarios.md) — TDD catalog.
- [scenario-traces.md](./scenario-traces.md) — end-to-end traces.

---

### <a id="q1"></a>Q1 — Fall-through and edge policy

Status: working candidate framing identified (Model 2 — selector-on-edge). Not
locked in; sub-questions remain open at the next level down.

**The break, traced concretely.** With `name`, `doubleName = compute(() =>
get(name) + get(name))`, and the initial outside-action `get(doubleName)`
populating `doubleName.slots[ROOT_SCOPE] = "foofoo"` plus an edge
`name.slots[ROOT_SCOPE] → doubleName.slots[ROOT_SCOPE]` (using the library's
convention that "outside any action" uses `ROOT_SCOPE` as the scope key):

```ts
action(function* () {
  // Inside scope S. name.slots[S] doesn't exist; doubleName.slots[S] doesn't exist.
  get(doubleName)
  //   - doubleName.slots[S] miss → populate: invoke defaultRecipe under S.
  //   - Recipe runs. get(name) under S → name.slots[S] miss → walk falls
  //     through to name.slots[ROOT_SCOPE] → "foo". Twice → "foofoo".
  //   - Cache in doubleName.slots[S]. Register edge — ↓ THE QUESTION ↓:
  //       (Model 1) source slot: name.slots[ROOT_SCOPE] → target: doubleName.slots[S]
  //       (Model 2) source Node: name with SELECTOR over chain [S, ROOT_SCOPE]
  //                 target: doubleName.slots[S]
  setName("name")
  //   - writeSlot(name, S, …) — creates name.slots[S].
  //   - Model 1: the edge points at slots[ROOT_SCOPE]; the write was to
  //     slots[S]; no match. doubleName.slots[S] stays cached "foofoo". WRONG.
  //   - Model 2: the edge's selector matches writes to S in its chain.
  //     Fires. doubleName.slots[S] invalidates. RIGHT.
})
```

Simple slot-to-slot edges (Model 1 as-stated) cannot handle the fall-through
case. Either the engine has to do something at slot-creation time (re-link), or
edges have to be richer than direct slot pointers (selectors). Note: neither
"ROOT_SCOPE" nor "fall-through" is an engine concept — both live in walks. The
chain is just a list of scope keys the walk traversed; the engine sees opaque
keys uniformly.

**Two candidate models.**

*Model 1 — Re-link on slot creation.* Edges are simple slot-to-slot pointers.
When `writeSlot(node, S, slot)` creates a new slot, the engine walks an index of
edges from `node` whose target scope is `S` or a descendant, and re-links any
whose current source slot is at a less-specific position than `S` in the
target's chain. Then invalidates affected targets.

```ts
interface Edge { source: Slot; target: Slot }
// On writeSlot(node, S, ...):
//   walk an index (source Node, target scope) → edges
//   re-link edges whose source is now superseded by the new slot
//   invalidate targets
```

Trade-offs: simple edge structure; *engine has to know about chains* to do the
re-link correctly (or accept a callback from the walk for "is this scope more
specific than that one for this edge's purposes?"); cost amortised on slot
creation (rarer than slot writes); no clean extension path for non-fall-through
policies (latest, scope-only, custom) without engine changes or more callbacks.

*Model 2 — Selector-on-edge.* Edges store a *selector function* — a walk-defined
predicate that decides whether a write matches. The engine queries selectors on
every write to the source Node.

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

Trade-offs: engine knows nothing about chain semantics — selectors are opaque
predicates; extensible to arbitrary new walks without engine changes; cost is
per-write per-edge function call (same big-O as today's "walk subs," with a
constant-factor bump); edges stay valid across slot creation/destruction
(selectors re-evaluate against current state every time, so no slot-lifecycle
bookkeeping pressure on the edge structure).

**Lean: Model 2.** Reasons:

1. *In the spirit of "engine resolution is open"* — policies live in walks, not
   in engine.
2. *Slot lifecycle and edge correctness decouple* — slots come and go without
   needing the engine to rebuild edges.
3. *Custom walks compose without engine extension* — `latest`, scope-only,
   "snapshot-at-time-T," "subscribe-to-root-only," "fire-on-any-change"
   are all selectors; new walks ship their own selector.
4. *The cost is acceptable* — same big-O as r3's existing sub-walking, with a
   constant-factor bump for the function call. r3 was already paying O(subs) on
   every set; Model 2 keeps the bound.

**Commit / discard paths trace cleanly under Model 2.**

- *Commit `S`.* Slots tagged `S` get promoted (the library does
  `writeSlot(node, ROOT_SCOPE, ...)` for each, then drops the slot at `S`).
  Each promotion is a write to `ROOT_SCOPE`, which fires selectors that care
  about `ROOT_SCOPE` (e.g. the chain selector `[S, ROOT_SCOPE]` after the
  scope-`S` slot is dropped: writeScope is `ROOT_SCOPE`, chain index is 1, no
  more-specific slot exists → fire). Downstream computeds invalidate, recompute
  on next read against the now-current state.
- *Discard `S`.* Drop slots tagged `S`. Edges into those dropped slots also drop
  (slots own their incoming edges; cascade-removed). Downstream readers outside
  `S` are untouched — their selectors don't match writes-to-`S`. No spurious
  invalidation. ✓
- *Supersession.* Discard old scope; open new scope. Above logic handles it.

**Sub-questions still open at the next level down.**

These don't gate the architecture; they're what's left after picking the
framing:

- *Indexing.* Naive Model 2 calls every edge's selector on every write to the
  source. For a hot Node with many subscribers, this is expensive. An index
  (e.g., bucket edges by "what scopes does my selector care about") could cut
  the work. But indexing pushes some knowledge back into the engine — either
  selectors expose a "what scopes do I care about" hint that the engine indexes
  by, or selectors are opaque and the engine pays the linear cost. Both are
  viable; perf measurements would decide.
- *Selector parameter shape.* The sketch above is `(sourceSlots, writeScope) =>
  boolean`. Should it also carry: the specific slot being written (not just
  the scope), the previous slot value (for change-detection), the target slot
  (so the selector can branch on target context)? Each addition is
  power-vs-complexity. Likely minimal start.
- *Edge identity across recomputes.* Each recompute rebuilds `deps`, so new
  edges are formed. Are selector *functions* re-created or cached? Memoising
  selectors (`chainSelector([S, ROOT_SCOPE])`) is library-side optimisation if
  it matters. Engine doesn't care.
- *Dropped-slot races.* If a write fires an edge whose target slot has been
  dropped (e.g., scope discard happened between write and notification),
  engine has to detect and skip. Lazy-prune-on-iteration is the natural answer.
  Standard reactive bookkeeping.
- *Async writes ([Q4](#q4) interaction).* A slot's `cached` may be a Promise that
  resolves later. Does the resolution count as a "write" that fires edges?
  Probably yes (the slot's effective value changed); but the engine needs to
  know to fire on resolution. The selector itself doesn't change — it still
  fires on writes to the slot's scope — but the *engine's notion of "a write
  happened"* has to include the Promise-resolution event.

**Related:** [Q3](#q3) (consumers subscribe via the same selector mechanism; consumer
notification IS a "fire an edge" event whose target is a side-effect handler
instead of a cache invalidation), [Q7](#q7) (`defaultRecipe` is a similar engine-vs-
walk question at a different level), [Q4](#q4) (async resolution as a "write" event).

### <a id="q2"></a>Q2 — Scope/Owner unification

Working hypothesis: one ambient context primitive with `cleanups` + a `mode` at
close time (`'commit' | 'discard'`). Owner = scope used without slot-tagging;
speculation = scope used with slot-tagging.

Open sub-questions:

- *Are scope identities first-class?* Can users grab a scope handle and pass it
  around, or are scopes only manipulable through library helpers (`action`,
  `createRoot`)?
- *What is a scope as a value?* Symbol, plain object with identity, frame
  object that holds nesting + cleanups, extensible "kind" (per-application
  custom scopes)?
- *How does `commit` interact with cleanups?* Working assumption: cleanups fire
  on discard, not on commit (a successful action's long-lived resources keep
  living after commit). Is there a separate `onCommit(fn)` hook, or is
  post-commit work always expressed through the body's return value?
- *Does a computed's tracker need to be a separate ambient context, or is it the
  same context-handle as the scope?* (Tracker = "currently-recomputing slot,
  register reads to me." Currently sketched as a separate `currentTracker`
  variable.)

**Related:** [Q3](#q3) (effects register cleanups; whether a scope-with-effects has
different lifecycle from a scope-with-just-state), [Q2](#q2) in main doc (cancellation
discipline — likely falls out of scope-discard).

### <a id="q3"></a>Q3 — Consumer patterns

Status: working candidate framing identified via the [H1a-c trace](./scenario-traces.md#trace-h1a-c). Not locked
in; sub-questions remain at the next level down.

**Candidate framing.** Consumers are *library code* over the engine's
`subscribe` primitive plus a scheduler. Uniform shape:

```ts
function consumer(node, onSlotChange) {
  return subscribe(node, e => {
    if (e.kind === 'invalidated') scheduleMicrotask(onSlotChange)
  })
}
```

`Effect`, `JSX-binding`, and `Computed-cache-dependent` are all `consumer(…)`
calls with different `onSlotChange` bodies (re-run side-effect body, schedule
DOM update, mark cache dirty + propagate). No engine primitive distinguishes
them.

**Deferred-until-commit semantics** for effects-under-speculation fall out of
**selector composition**, not engine logic: an effect created in `ROOT_SCOPE`
has its tracking edges formed with `chainSelector([ROOT_SCOPE])`; writes to a
speculative scope don't match the chain → don't fire. Writes to `ROOT_SCOPE`
(commit promotion) match → fire. *No defer logic anywhere; the chain is the
policy.*

**Verified by [H1a-c trace](./scenario-traces.md#trace-h1a-c).** H1a (write under S → effect doesn't fire), H1b
(commit → effect fires once), H1c (discard → effect never fires).

**Sub-questions still open:**

- *Microtask batching.* Multiple invalidations in quick succession should
  produce one re-run per microtask cycle per Node. Library-side "scheduled"
  flag per Node handles it. Mechanical.
- *Effect-during-recompute (re-entrancy).* If an effect's body triggers
  another effect that writes to a signal the first effect reads… exactly
  **K1 territory.** Worth tracing K1 next.
- *Effect priority and ordering.* Multiple effects depending on the same
  signal — order? Pulse hasn't articulated against Dim 3 (priority).
- *Effects at chains longer than 1.* Component-owned effect chain
  `[component_scope, ROOT_SCOPE]`; action-inside-component effect chain
  `[action_scope, component_scope, ROOT_SCOPE]`. Trace H2 would exercise.
- *Dirty propagation.* Computeds propagate dirty downstream — their subs
  also need to invalidate transitively. Library-side: the Computed
  consumer's `onSlotChange` doesn't just invalidate its own cache; it
  also fires its own subs (via the engine). Open: is this transitive
  fire-and-invalidate something the engine should expose more directly,
  or is iterating subs in the consumer correct?

**Related:** [Q1](#q1) (selectors are the chain mechanism; [Q3](#q3) subscribes via
them), [Q4](#q4) (Promise-resolution-as-write fires consumers — confirmed in C2),
[Q7](#q7) (`defaultRecipe` interacts with consumer's initial run).

### <a id="q4"></a>Q4 — Async at the engine level

The recipe is `() => T` where `T` may itself be `Promise<U>`. The engine sees
Promises in `cached`. Per [P2](./framings.md#p2) (acknowledge async), walks decide how to handle
them.

**Resolved by the `Awaitable<T>` framing** (see the "Awaitable" framing
section above): when the engine encounters a Promise in `slot.cached`, the
library's `get(node)` walk wraps it in an `Awaitable<U>` — a Promise
subclass that carries `status` / `value` / `reason` fields *as class
instance state* (not as tweaked side-properties on foreign Promises).

This collapses the earlier Promise-tweak-vs-WeakMap question. The state
lives on the Awaitable instance:

- *Status query* — `awaitable.status` (synchronous, no side-table lookup).
- *Async wait* — `await awaitable` (Awaitable extends Promise).
- *Generator wait* — `yield* awaitable` (Awaitable implements
  `[Symbol.iterator]`).
- *React-convention interop* — `makeAwaitable(foreign)` duck-types the
  incoming Promise for `status`/`value`/`reason` and adopts the state if
  present.

The engine doesn't need a separate `promiseState()` helper or
`WeakMap<Promise, T>` side-table. Awaitable IS the Promise-with-state type;
the user accesses the fields directly.

**Engine's responsibility for firing on resolution.** When a Promise lands
in a slot's `cached` (either via `writeSlot` or via `invoke` running an
async recipe), the engine attaches a `.then` so that resolution emits a
slot-changed event (`{ kind: 'resolved' }`) to subscribers. The slot's
`cached` is NOT mutated when the Promise resolves — it stays as the
Awaitable, which now has `status: 'fulfilled'` and `value: T` populated.
Walks query via the field on next read.

Concretely (engine-side, ~10 lines):

```ts
// Inside writeSlot / invoke, after caching a Promise:
function trackPromiseResolution<T>(node: Node<T>, scope: Scope, slot: Slot<T>) {
  const cached = slot.cached
  if (cached && typeof (cached as any).then === 'function') {
    ;(cached as Promise<unknown>).then(
      () => fireEdges(node, scope, { kind: 'resolved' }),
      () => fireEdges(node, scope, { kind: 'resolved' }),  // rejection also fires
    )
  }
}
```

Plus the library-side `makeAwaitable` helper that wraps incoming Promises
in pulse's Awaitable class (so the state fields are populated structurally
rather than via mutation). See the "Awaitable" framing section.

**Settled by Awaitable + the [C2 trace](./scenario-traces.md#trace-c2):**

- *Does the engine `await` internally?* No — walks handle suspension via
  `yield* get` or `use`. Engine attaches a `.then` only to fire the
  slot-changed event on resolution.
- *Does the engine track which slots are pending?* No — pending-ness is
  derived from `(get(node) as Awaitable<U>).status === 'pending'`. The
  `isPending(node)` walk reads the status field.
- *Where does Promise state live?* On the Awaitable class instance —
  pulse owns the wrapper. Foreign Promises (React, TanStack Query, etc.)
  are duck-typed for interop and their state copied into our Awaitable.
- *Mutation of foreign Promises?* Avoided. Pulse never tweaks Promises it
  doesn't own; it wraps them in Awaitable instances.

**Related:** [Q3](#q3) (consumer's re-run discipline for async deps; consumers
receive `{ kind: 'resolved' }` events the same way they receive `{ kind:
'invalidated' }`), `yield* get` vs `use` vs stages (see framings), [Q9](#q9)
(a Promise that resolves is "still the same slot," not a write, so doesn't
trigger commit-promotion).

### <a id="q5"></a>Q5 — Recipe / cache asymmetry between Signal and Computed slots

For a Signal slot, the *recipe is the value* — `() => 42`. The cache is
trivially `42`.

For a Computed slot, the recipe walks deps to compute. The cache is the result
of invocation under the slot's scope.

The engine doesn't currently distinguish — both are slots with `recipe` and
`cached`. But practically:

- *Signal slot invalidation is meaningless* — the recipe is a constant, so
  invalidating the cache and re-invoking the recipe just returns the same value.
  Signal slots don't *get* invalidated; they get *overwritten* by a new
  `writeSlot` call from a setter.
- *Computed slot invalidation triggers recompute* — clear `cached`, mark
  through subs (so downstream sees this slot is dirty); next `invoke` re-runs
  the recipe.

So Signal vs Computed isn't a Node-level distinction, it's a *slot-lifecycle
distinction*. Slot lifecycle is engine-level (because the cache is). Worth
working out whether this is a real distinction or whether it dissolves under a
careful framing.

### <a id="q6"></a>Q6 — What is a Scope as a value?

Currently typed `unknown` in the sketch. Practically, scopes need:

- *Identity.* Two scopes are equal iff they're the same scope. Reference
  equality on a fresh object is the cheapest.
- *Hierarchy.* Each scope (except the root) has a parent. Used for cleanup
  cascade and ambient resolution.
- *Lifecycle state.* "open", "committed", "discarded" — at minimum the engine
  needs to know whether a scope is still alive (to decide whether to retain its
  slots) or closed (slots either promoted or dropped).
- *Walk-defined metadata.* Speculative scopes carry "committed slots map" or
  similar; owner scopes might carry nothing extra. Engine doesn't know; walks
  do.

Sketch: `interface Scope { parent?: Scope; cleanups: Disposable[]; status:
'open' | 'closed' }` — minimal, walk-extensible.

**Open sub-question (surfaced by [G2 trace](./scenario-traces.md#trace-g2)):** `chainFor(scope)` walks
`scope.parent` pointers up to and including `ROOT_SCOPE`. For custom scope
hierarchies — per-tenant roots, per-document roots, multiple reactive
"worlds" — the terminal might not be `ROOT_SCOPE`. The library should
probably expose `chainFor` as user-overridable, or expose `terminalScope`
as a configurable per-tree property. Open whether this is a library
concern or whether the engine needs to know about it.

**Related:** [Q2](#q2) (the unification question), [Q1](#q1) (selectors quote scope
identities; scope value-shape constrains how selectors can match).

### <a id="q7"></a>Q7 — The `defaultRecipe` mechanism

The Node has an optional `defaultRecipe` used by `invoke` when no slot exists
for the requested scope. Is this:

- *(i) The right shape.* A convenient "fallback recipe for fresh slots."
- *(ii) Folded into the root-scope slot.* The slot the library tags with
  `ROOT_SCOPE` *is* the default; `invoke` with no slot for `S` falls through
  along the walk's chain and creates a slot for `S` using that slot's recipe.
- *(iii) Walk-defined.* `invoke` takes a selector that says what to do when no
  slot matches — return undefined, fall through, invoke a fallback recipe.

(ii) is most parsimonious but loses the explicit "this is the default recipe"
intent and pushes more convention into the library; (iii) is most flexible.
Probably a cosmetic question, but worth deciding.

**Sub-question (surfaced by [doubleName trace](./scenario-traces.md#trace-doublename)):** what `cached` does a *promoted*
slot carry? Three sub-positions: (a) preserve `cached` + carry over old deps
(but old deps had chain selectors keyed to the old scope, which doesn't match
the new scope's chain); (b) preserve `cached`, drop deps, let next recompute
rebuild; (c) drop `cached`, force recompute on next read. *Lean (b)*:
preserves the work done in the scope without carrying selector mismatches
forward. Related to [Q1](#q1) (selector identity across scope transitions).

### <a id="q8"></a>Q8 — Tracker vs Scope: separate or unified?

The sketch has a separate `currentTracker` (the slot currently being
recomputed, used by `get` to register `deps`) and a `getCurrentScope`
(speculation/owner context). Are these the same primitive?

Argument for unification: both are ambient context handles. Argument against:
the tracker is *the slot being recomputed*; the scope is a *broader context*
that may contain many tracker-events. They're at different granularity.

Likely answer: tracker is a sub-ambient. A slot recomputes under a scope (its
slot's scope); reads inside the recompute know both. Either two separate
ambients, or one ambient with a "current slot recomputing" sub-field. Open.

**K1 confirmed the parallel-and-coupled framing.** When a recompute enters,
both `currentTracker` and `currentScope` push together (the slot being
recomputed *and* its scope); both pop together. Re-entrant writes inside the
recompute correctly inherit the recompute's scope. So they're separate
ambients with synchronized lifecycles.

**Sub-question (surfaced by K1 + relates to catalog L1):** *`untrack`
interaction.* `untrack(() => ...)` clears `currentTracker` but not
`currentScope`. So a `writeSlot` inside `untrack` writes to the current
scope normally, but its firing isn't gated by `deferredFires` (which is
keyed on tracker). Writes inside `untrack` would fire synchronously even
during a recompute. That's plausible (the user explicitly opted out of
tracking) but worth confirming as the policy. Connects to L1 in the
scenario catalog.

### <a id="q9"></a>Q9 — Read-populated vs write-populated slots: do they differ structurally?

Surfaced by the C2d trace. When a slot is created lazily during a read (because
no slot existed for the requested scope yet, so `invoke` populated one with the
default recipe), it ends up in `node.slots[scope]` *exactly the same way* as a
slot created by an explicit `writeSlot` call from a setter. But their commit
semantics differ:

- *Write-populated slot.* On commit, the slot's recipe (+ cached value) gets
  promoted to the parent scope. The intent is "this is what the action did to
  the node; lift it out."
- *Read-populated slot.* On commit, promoting this slot would clobber any
  later writes to canonical (e.g., the C2d case where outside-action writes
  happened during the await). The intent is "this slot was just a memo cache
  for the duration of the scope; drop it on commit, don't promote."

Two ways to handle it:

- **(i) `wasWritten: boolean` flag on `Slot`.** Engine tags slots at creation
  time (true on `writeSlot`, false on `invoke`-populated). Commit walks only
  promotes flagged slots; non-flagged ones drop.
- **(ii) Library tracks write-set separately.** The scope itself maintains a
  `writeSet: Set<Node>` populated by `writeSlot` calls. Commit walks
  `writeSet`, not all slots tagged with the scope. Read-populated slots are
  invisible to commit because they're not in `writeSet`.

(i) puts the distinction on the slot; (ii) puts it on the scope. (ii) is
cleaner in spirit (scope owns its semantics; slots stay uniform) but (i) is
more locally evident (a slot knows whether it represents "real" state).

Connects to [Q5](#q5) (the Signal/Computed slot distinction) — that question also
asks whether the engine needs to know what kind of slot it's looking at.
Probably resolved together.

**Lean: (ii)**, because it keeps the engine's `Slot` shape uniform and pushes
intent into the library's scope handling. But (i) wins if performance
measurements show that walking the scope's write-set is slower than checking
flags during commit. Currently mostly cosmetic.

### <a id="q10"></a>Q10 — Commit as transaction: ordering, atomicity, deferred fires

When an action commits, how exactly does the engine sequence the multiple
slot promotions and edge fires so that consumers see a consistent
post-commit state, not a sequence of partial updates?

**Deferred-fires is commit-mode only**, not tracker-mode. Recomputes fire
synchronously; consumers schedule async via microtasks (see [K1b trace](./scenario-traces.md#trace-k1)).
The deferred-fires mechanism is triggered only by opening a commit
operation.

Three concerns under one umbrella:

- *Multi-write ordering.* If an action wrote to N signals, commit promotes
  N slots to the parent scope. Each promotion calls `writeSlot`, which fires
  edges. If a derived consumer's edges target a slot that depends on
  multiple of these N signals, the order of promotions can fire the consumer
  multiple times with partial states (after promoting `signal_1` but before
  `signal_2`). *Working hypothesis: dep-order leaves-first.* Sources promote
  before their dependents; intermediate fires invalidate but don't re-run
  until all promotions are done.
- *Deferred fires during commit.* Without deferral, consumers might re-run
  mid-commit and observe partial states. Better: collect *deferred fires*
  during the entire commit operation, drain them after all promotions
  complete.
- *Atomicity from the consumer's perspective.* External consumers (effects,
  JSX-bindings) should see *the commit as a single event* — one invalidation
  per affected consumer, regardless of how many slots got promoted.

Likely resolution: **commit is a deferred-fires region.** When
`closeScope(S, 'commit')` runs:

1. Open a deferred-fires region.
2. For each `S`-tagged write-populated slot ([Q9](#q9)), perform `writeSlot(node,
   parentScope, slot_content)`. Edge fires are *queued* into the deferred
   region.
3. Drop the `S`-tagged slots, unlinking edges.
4. Close the deferred-fires region: deduplicate by `(node, scope)`, then
   actually call `fireEdges` for each. Consumers see one invalidation per
   affected slot, regardless of how many writes contributed.

**Recipes** (computed/effect bodies) **do not open a deferred-fires
region.** Writes inside recipes fire synchronously per K1+K1b's resolution
to (C). This is necessary for in-recipe state coherence (K1b: write a
signal, then read a downstream derived → derived must recompute fresh).
Cycle protection is consumer-level (max N re-runs per microtask),
unaffected by whether fires are deferred.

**Open sub-questions:**

- *Nested-commit ordering.* G2 traced inner-commit-promotes-to-outer. If
  inner commit happens inside a deferred-fires region (because outer is
  still executing its body), do the inner's promotions fire immediately to
  external consumers, or are they also deferred until outer finishes? Lean:
  inner-commit fires immediately *within the outer's body*, because the
  outer's body might read the post-inner state and the body is imperative.
  But for *external* consumers (chain matches `ROOT_SCOPE`), they shouldn't
  fire until outer commits — which falls out of the chain selector anyway
  (the chain selector for an external consumer doesn't match writes to the
  outer's scope). So this might be a non-issue under the chain mechanism.
  Worth verifying with a deliberate trace.
- *Edge-target-dropped races.* If during a commit, an edge's target slot
  gets dropped (e.g., the consumer was tied to a different scope that
  closed during the commit's processing), the deferred fire would target a
  dead slot. Lazy-prune-on-iteration handles it.
- *Promise resolution during commit.* If a promoted slot's `cached` is a
  Promise that's still pending, the commit promotes the Promise. Later
  resolution fires edges normally — same as any other Promise-resolution
  write. No special handling.

**Lean: implement commit as a deferred-fires region**, generalizing K1's
mechanism. The engine's invariant becomes "if `deferredFires` is non-null,
fires queue; outermost layer drains." Recomputes set up one such region;
commits set up another. They compose by nesting.

### <a id="q11"></a>Q11 — Effect chain policy: chain follows owner, or always [ROOT_SCOPE]?

Surfaced by the [H3 trace](./scenario-traces.md#trace-h3). When an effect is created inside an action body
(or inside any scope other than `ROOT_SCOPE`), what's the chain its
tracking edges form against?

- **Policy α** — chain = `chainFor(owner)`. Effect created inside action
  `S` has chain `[S, ROOT_SCOPE]`. *Fires* on writes inside the action.
  Effect reactivity follows its containing scope.
- **Policy β** — chain = `[ROOT_SCOPE]` always. Effects only fire on
  committed-state changes regardless of where created. The effect's
  *lifecycle* is tied to its owner, but its *subscription* isn't.

H1a-c established that effects *outside* actions have chain `[ROOT_SCOPE]`
— consistent with both policies (an outside effect's owner is
`ROOT_SCOPE`, so `chainFor(owner) = [ROOT_SCOPE]` under α). The policies
diverge for effects inside actions.

**Lean: Policy α** — composition is natural; the user creating an effect
inside an action is opting into reactivity at the action's scope. Policy
β is defensible (effects-always-committed-only as an invariant) but
narrower. The mechanism (selector chains) supports both; this is a real
design call.

**Related sub-question:** *Effect re-parenting on commit.* Could an
in-action effect *survive* commit by re-parenting its owner to `S.parent`
and updating its chain accordingly? Possible but adds machinery; users
wanting persistent effects can just create them in the outer scope.
Probably out-of-scope.

**Related:** [Q3](#q3) (consumer pattern depends on chain), [Q2](#q2) (scope/owner
unification — the chain question is "does subscription follow owner or
not").

### <a id="q12"></a>Q12 — Body cleanups vs scope cleanups: composition and re-entrancy

Surfaced by [H3 trace](./scenario-traces.md#trace-h3). Two distinct cleanup mechanisms exist:

- *Scope-level cleanup* — `onCleanup(fn)` outside an effect body,
  registered to `scope.cleanups`. Fires on scope discard (and possibly
  commit; see open below).
- *Body-level cleanup* — `onCleanup(fn)` inside an effect body, registered
  to `effectNode.bodyCleanups`. Fires before next body invocation or on
  effect disposal.

Open sub-questions:

- *Does scope-level `onCleanup` fire on commit too, or only on discard?*
  Working assumption: only on discard. Commit = success, no cleanup
  needed. But some patterns (e.g., "always release this lock when scope
  closes regardless") want it on both. Possible answer: separate
  `onCleanup` and `onSettle` (the latter fires on both). Open.
- *Re-entrancy during cleanup fires.* If a body cleanup calls `writeSlot`,
  is the write deferred (per [Q10](#q10)'s `deferredFires` mechanism)? The
  cleanup runs inside `closeScope`, which is itself a deferred-fires
  region per [Q10](#q10). So yes, deferral covers it. Worth confirming with a
  trace.
- *Cleanup ordering for nested scopes.* If `S2` is a child of `S1` and
  both have cleanups, does discard of `S1` fire `S2.cleanups` before
  `S1.cleanups` (children-first)? Probably yes. Standard tree-disposal
  pattern.

**Related:** [Q2](#q2) (the scope/owner unification carries this composition),
[Q10](#q10) (re-entrant cleanups land in the commit's deferred-fires region).

### <a id="q13"></a>Q13 — Optimistic surface ergonomics (sugar over speculation)

Mechanism: an optimistic write is one use of speculation (a predicted
`setX(...)` inside an action body is held in that action's write-set;
auto-discard reverts on failure; commit promotes). No new primitive at
the engine level.

**Open:** does pulse ship a named ergonomic sugar — `optimistic(...)` /
`createOptimistic` — as a thin wrapper over `action`? Per [P5](./framings.md#p5), this is
decided on whether the bare action shape is awkward enough for the
optimistic case to warrant a named wrapper. Lean: yes for the
single-predicted-write case (the most common one — predict, await,
either promote or roll back). The API surface is genuinely undecided
beyond that.

### <a id="q14"></a>Q14 — Action prereqs / standing-state handle

An action's readiness to run is information that should be queryable
*before* the action runs (a button needs `ready` and `pending` to avoid
double-submit). The body itself can't supply this — it hasn't run yet.

**Open:** does the action expose a small family of standing reactive
states — `ready` (prereqs met), `pending` (body in flight), `error`
(last run failed)? If yes, are the prereqs declared inline (`action(
depsFn, body)`) or via a separate prereq-computed that the action
consumes? Either shape preserves the "gather-up-front /
snapshot-consistent / skew-free input handling" property.

The principle is structurally forced: a standing `ready()` cannot come
from an imperative body that hasn't executed. The prereqs must be
hoisted into a *declared, continuously-evaluated* expression. That
expression is a `compute`/stage. So the structural pattern is **an
action = a reactive prerequisite `compute` → an imperative body invoked
on demand**, with the body receiving the *resolved* prereq values.

Not yet traced; this is a future trace target.

---



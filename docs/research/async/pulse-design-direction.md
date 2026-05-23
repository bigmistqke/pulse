# Pulse design direction — async coordination

**Status:** working synthesis, not a decided spec. Populated incrementally as the research-arc findings get translated into pulse design positions. Lives between the research artifacts (`README.md` taxonomy, `deep-dives/*.md`, `LOG.md` chronology) and concrete implementation specs (`docs/superpowers/specs/...-design.md`). Per PROCESS.md's sourcing-discipline anti-pattern: pulse-specific design context goes here, not into the per-system dives.

**Origin:** opened session 13 (2026-05-19) after sessions 1–12 produced enough evidence to start articulating pulse's positions concretely. The dives' "what pulse can learn" sections were durable observations about each studied system; this document is the *synthesis across them* and the *decisions pulse takes in response*.

---

## What the research arc has shown

Compressed to one paragraph for context. Transitions are coordination machinery for **continuous-observation + concurrent-intent** workloads (UI is the canonical instance; also GGPO rollback, sync engines with optimistic+rebase, realtime collab). They branch in four distinct dimensions — Dim 1 internal (tree of dependent async in one transition), Dim 2 concurrent (multiple in flight), Dim 3 input-arrival (new input during transition), Dim 4 state-overlap (transitions touching shared state); canonical definitions in the lexicon, [CONTEXT.md](./CONTEXT.md), framing originated in the [LOG.md](./LOG.md#cross-cutting-thread--transitions-branch-in-four-dimensions) thread "Transitions branch in four dimensions". Production frameworks differ in which dimensions they handle and how, AND in whether their user-facing API surface is minimal (Svelte) or proliferating (React). Pulse's articulated design philosophy (sessions 11–12 conversations) is **user-visible primitives composed in userland** — distinct from React's "low-level API + library-authors compose ergonomics" and Solid's "framework-provided higher-level primitives" — but Svelte's evidence (sessions 12) showed that "minimum API" does NOT entail "minimum engine"; concurrent transitions cost engine surface regardless of how small the user API is.

---

## Comparison: React modern / Svelte 5 / Solid 2.x

The current mechanical landscape for the three production frameworks pulse has the most-developed dives on. Each cell is what the framework actually does, sourced from the dives.

| | **React modern** | **Svelte 5 (`experimental.async`)** | **Solid 2.x** |
|---|---|---|---|
| **Substrate** | Fiber tree + lane-scheduled work queue (31-bit bitmask) | Signals + linked-list of `Batch` objects + `<svelte:boundary>` queue | Reactive graph + per-write `OptimisticLane` + `Transition` object |
| **User-facing primitives** | `useTransition`, `useDeferredValue`, `useOptimistic`, `Suspense`, `use(promise)`, `useActionState`, Actions, Server Functions | `<svelte:boundary>` + `pending` snippet, `$effect.pending()`, `settled()`, `fork()` | `<Loading>`, `<Errored>`, `<Reveal>`, `action()`, `createOptimistic`, `latest()`, `isPending()`, `refresh()` |
| **Suspension mechanism** | `use(promise)` throws cached promise; caught at Suspense boundary | `await` inside `$derived` lowered to `async_derived`; gated by `boundary.#pending_count` | `NotReadyError(source)` thrown; caught by `CollectionQueue.notify` |
| **Dim 1 — internal branching** | WIP fiber tree gathers all pending Suspense in scope; commits atomically when all resolve | `boundary.#pending_count` for first render; `batch.#blocking_pending` for subsequent updates | `Transition._asyncReporters: Map<Computed, Set<Computed>>` tracks each pending source → its reporters; per-source decidability |
| **Dim 2 — concurrent transitions** | 31-lane bitmask; multi-low-priority currently batched (acknowledged limit) | Linked-list of `Batch` objects; each with `batch_values` time-travel snapshot; independent commit if non-overlapping | Per-write `OptimisticLane`; independent lanes flush independently; not batched |
| **Dim 3 — input-arrival priority** | High-priority lanes pre-empt low-priority; WIP discarded and rebuilt; cooperative 5ms yield to browser | **None** (no priority/lanes); only `OBSOLETE` per-derived cancel + `STALE_REACTION` per-effect abort; `fork()` is user-controlled speculation | **None** (no priority/lanes); newer writes supersede via `_inFlight !== result` identity check |
| **Dim 4 — state-overlap** | **Not handled**; multi-transition batching conflates with this | Whole-batch merge on source-set intersection (`#find_earlier_batch` + `#merge`) | Union-find lane merge on dep-graph overlap (`assignOrMergeLane`); parent-child lanes stay independent |
| **Speculative-state isolation** | Per-transition tree (WIP fiber) + per-action overlay (`useOptimistic`) | Versioned engine, unbounded observable batches (linked list); `fork()` as flagged subtype with deeper isolation | Per-write-lane overlay with overlap-merge; `_overrideValue` overlay + separate `_pendingValue` slot |
| **Optimistic state** | `useOptimistic(state, reducer)` returns `[optimisticState, setOptimistic]`; converges in same render as Action commit | No first-class API; user mutates state in `fork()` body or in async-derived (auto-reverts on `OBSOLETE` reject) | `createOptimistic(value)` returns reactive signal; auto-reverts on action failure via `resolveOptimisticNodes` |
| **Cancellation discipline** | Structural via WIP discard for rendering; convention-only `AbortController` for I/O effects | Two channels: `OBSOLETE` (per-derived) + `STALE_REACTION` (per-effect); `getAbortSignal` for cooperative I/O abort | Identity-based stale-result discard via `_inFlight !== result`; structural for async iterables (cleanup w/ `.return()`); no auto fetch abort |
| **Pending observability** | `isPending` from `useTransition` (internally implemented as `useOptimistic`); also `useDeferredValue` for "show old value during prep" | Only via `<svelte:boundary>` + `$effect.pending()`; **no per-value `.loading` on async-derived** | `isPending(() => x())` opt-in at read site; pipeline-OR walks dep graph; also `latest()` for boundary-bypass reads |
| **Fallback display** | Throttled at ≥300ms before showing; doesn't hide already-revealed content during transitions | Offscreen `DocumentFragment` until `#pending_count == 0`; then swap | Per-`<Loading>` boundary; gather-on-commit |
| **Multi-step async composition** | `await` inside Action body; multi-transition batched together (limit) | `await` inside `$derived`; compiler tracks deps across await via `capture`/`save` (`await a + b` → `(await $.save(a))() + b`) | `action(function*) { yield … }` — the whole generator is one transition; plain writes commit once at completion, transition stays alive across `await`s |
| **Dependent dispatch capability** | Await-only (`use(promise)` requires resolution; re-executes component on resolve) | Await-only with implicit ordering (sequential `$derived(await)` decls serialize; framework warns via `await_waterfall`) | Await-only with generator batching |
| **Entanglement detection** | None (application models conflicts in user code, e.g. via `useOptimistic` revert-on-failure) | Whole-batch granularity (per-microtask-of-writes); coarser than Solid | Per-write granularity (union-find merge of dep graphs); automatic detection by structural overlap |
| **Compiler involvement** | None (runtime-only) | Heavy: `experimental.async` flag; lowers `await` to `async_derived`/`flatten`/`save`; tracks deps across await | None for reactivity (runtime-only); compiler-style binding for JSX only |
| **Engine surface (rough)** | Thousands of LOC: fiber reconciler + scheduler + Suspense machinery + Actions | ~800 lines for `batch.js` alone + boundary.js + async.js + deriveds.js | ~1300 lines: core.ts + scheduler.ts + lanes.ts + async.ts + boundaries.ts |
| **User-facing API count** | ~7+ hooks | 4 primitives | ~8 primitives |
| **Specific oddities worth knowing** | `useTransition`'s `isPending` is internally `useOptimistic`; Suspense fallback throttling | `{#await}` blocks are anomalous re: runes machinery (may be retired); async-derived value lives in a normal `Source` cell — no `.loading` accessor by design | `<Reveal>` with `sequential`/`together`/`natural` modes; `_gatedSubs` replay-at-commit for cross-transaction reads; atomicity layers — per-transition (an action is one transition) / per-lane optimistic |

**Three observations from this table** (worth carrying forward to the design decisions):

1. **All three have radically different *user-facing* surfaces** (7+ vs 4 vs 8 primitives), but the *engine* sizes are within an order of magnitude. User-facing minimum is genuinely a choice independent of engine cost.
2. **Dim 3 is uniquely React's.** Both Svelte and Solid punt on input-priority entirely. If pulse wants to handle Dim 3, React is the only existing production reference point.
3. **Optimistic state is genuinely different across all three** — dedicated hook (React), no API + auto-revert via reject (Svelte), typed primitive tied to action lifecycle (Solid). None are the same shape; each is a position pulse could lean toward.

---

## Decomposition — what underlying primitives do these mechanics compose from?

Working hypothesis (not yet a decision): the high-level abstractions in the comparison table aren't independent primitives — they're compositions of a smaller set of underlying concerns. If true, pulse's design move is to expose the underlying concerns and let higher-level abstractions be userland-composable.

### Seven concerns extracted from the table

Looking at every mechanic in the comparison and asking *what problem is it actually solving*, the mechanics cluster into seven underlying concerns:

- **A. Versioned reads** — read X as it currently is, OR as it was committed, OR as it appears under this in-flight scope. (WIP fiber tree, `batch_values`, `_overrideValue`, `latest()`, `useDeferredValue`, snapshot-isolation in MVCC.)
- **B. Pending propagation** — downstream computations learn that an upstream is in-flight. (`_pendingSource(s)`, `_asyncReporters`, `boundary.#pending_count`, pipeline-OR `isPending`.)
- **C. Atomic commit boundary** — these changes land together; nothing inside is visible until everything is ready. (`<Suspense>`, `<svelte:boundary>`, `<Loading>`, `Batch` commit, `Transition._actions`.)
- **D. Scoped writes** — writes belong to a named scope (action, fork, transition); the scope can be committed or discarded as a unit. (`OptimisticLane`, `useOptimistic`, `fork()`, `action(function*)`, Replicache mutators.)
- **E. In-flight identity** — when multiple runs of the same work exist, framework knows which is current. (`_inFlight !== result`, `OBSOLETE`, generation counters.)
- **F. Lifecycle / cleanup** — async work that's no longer relevant gets cleaned up. (Drop, `AbortController`, `cleanup()`, owner disposal.)
- **G. Priority** — some updates pre-empt others mid-flight. (React's 31-lane bitmask, uniquely.)

### How the observed abstractions compose from these concerns

The high-level abstractions in the table are combinations of subsets of {A, B, C, D, E, F, G}:

- `<Loading>` / `<Suspense>` / `<svelte:boundary>` = **B** (pending propagation) + **C** (commit boundary)
- `useOptimistic` / `createOptimistic` = **A** (versioned read of overlay) + **D** (scoped write tied to action) + **C** (commit on action settle)
- `useTransition` = **D** (scoped write = the transition) + **C** (commit at end) + **G** (low-priority lane)
- `action(function*)` = **D** (scoped writes during generator) + **C** (commit at each yield) + **E** (action iterator identity)
- `fork()` = **D** (speculative scope) + **A** (versioned reads see fork's overlay) + **C** (explicit commit/discard)
- `<Reveal>` = composes multiple **C**s (a coordination layer ABOVE boundaries, not inside them)

None of these abstractions is a primitive in this decomposition. Each is library code over a small subset of the seven concerns.

### The further reduction — three of the seven are deeply entangled

Of the seven concerns, the claim is that **A (versioned reads) + C (commit boundary) + D (scoped writes) are three faces of one primitive, not three independent primitives.**

The argument: a scope is *what holds the writes*; versioned reads are *how you observe a scope's state*; commit is *what makes a scope's writes globally visible*. You can't have any one of them meaningfully without the other two — they're not separable. This is what databases call a *transaction* (MVCC-style): you open a transaction (scope), reads inside it see your own writes layered over committed state (versioned read), and at commit time the writes become globally visible (commit boundary).

The other concerns are genuinely orthogonal:

- **B (pending propagation)** is its own thing — it's about how knowledge of in-flight state flows through the dep graph. Independent of A/C/D.
- **E (identity)** is its own thing — distinguishing concurrent runs of the same work. Independent.
- **F (cleanup)** is its own thing — pulse already has owners.
- **G (priority)** is its own thing — and uniquely React's; pulse can choose whether to include it at all.

### Proposed pulse primitive set (4 primitives, not 9 abstractions)

If this decomposition holds, pulse's underlying primitive set is:

1. **Scoped versioned state** — a unified primitive that's "scope of writes + version of reads + commit boundary." Pulse currently has no first-class scope at the data layer; writes are global.
2. **Pending-source carriers** — pulse already has `NotReadyYet` carrying source identity; just needs to be sharpened. Pipeline-OR `isPending` already walks this.
3. **In-flight identity** — pulse has owner-disposal but not work-identity per se; the `<Loading>` gather is close but the "two concurrent runs of the same async" case isn't handled by named identity.
4. **Priority** — *optional*, only if pulse commits to Dim 3.

**The bet:** pulse exposes these four primitives; `<Loading>`, optimistic, transition, action, fork, Reveal are all userland-composable on top. Higher-level libraries provide ergonomic wrappers; the framework provides the underlying coordination.

### Open questions about the decomposition itself

Before adopting this decomposition as the design basis, three things need to be true:

- **(i)** Is (1) actually one unified primitive, or are scopes / versions / commits separable in a way I'm missing? The MVCC transaction analogy is convincing, but pulse isn't a database; maybe the reactive context changes things.
- **(ii)** Is (3) — in-flight identity — distinct enough from owner-disposal to deserve being its own primitive, or is it just "the current state of an owner"? Solid's `_inFlight` identity check and React's lane identity are both finer-grained than pulse's owner-scope.
- ~~**(iii)** Are there mechanics in the table that *don't* compose from these four? `<Reveal>` is the suspicious one — it's coordination between *sibling* boundaries, which feels like it might need a fifth primitive about "boundary composition" rather than being expressible from the four.~~ **Resolved (session 13, see "Validation against `<Reveal>`" section below):** Reveal composes from the existing primitives without a fifth. What it requires is a *library-level design discipline*: boundaries are **cooperative by design** — they expose state as signals and accept external control via signals. Not a framework primitive.

The next sub-decision in this document should probably be: validate or falsify this decomposition before committing to any of the Q1–Q9 specific positions. If the decomposition is right, several of the Qs collapse into "pick a library API for this composition pattern." If it's wrong, the Qs need to be answered each on their own terms.

### A sharper recasting: signal = node + value-bag

The seven-concerns decomposition above is roughly right but it bundles two distinct concerns under "scoped versioned state." A cleaner factoring (proposed during session 13 conversation): **a signal isn't a single primitive — it's a (node identity, value-bag) pair.** Currently every reactive framework conflates these into "a signal *is* its current value." Decoupling them is the underlying simplicity.

The reframing:

- **Node** = the stable identity in the reactive dep graph. Other nodes / subscribers depend on this identity. Owners hold it. Equality and reference-tracking are based on it.
- **Value-bag** = the multi-valued state the node currently has. Entries are tagged with (scope, version, status). The "current committed value" is one entry; the "in-flight pending value" is another; the "optimistic-scope overlay" is a third; the "snapshot-as-of-time-T" is a fourth.

Under this framing, the seven concerns recast as:

- **A (versioned reads)** = read a specific entry from the value-bag
- **B (pending propagation)** = entries carry pending-status; the dep graph propagates status across nodes
- **C (atomic commit boundary)** = the value-bag collapses from N entries to 1
- **D (scoped writes)** = writes contribute an entry to the value-bag, tagged with scope
- **E (in-flight identity)** = entries carry identity (or the scope that produced them does)
- **F (cleanup)** = entries can be removed from the bag
- **G (priority)** = about the *work producing entries*, not about entries themselves — the only one that's not a value-bag operation

So **A–F are all operations on the value-bag of a node**. G is the one genuine outlier (it's about work scheduling). The deeper decomposition shrinks from "7 concerns + 4 primitives" to **three primitives**: (node identity) + (value-bag) + (work scheduling).

**The empirical pattern:** every framework studied implements the node/value-bag separation internally, but none exposes it as the user-facing primitive:

- **Solid 2.x** — explicit per-node slots `_value` / `_pendingValue` / `_overrideValue` / `_snapshotValue` (the fresh dive called this "the architectural anchor"). Internally exposed; user-facing surface is `createOptimistic` / `createSignal` / `createMemo` as separate hooks.
- **Svelte 5** — `batch_values: Map<Value, [any, boolean]>` per batch. Internally; user-facing is `<svelte:boundary>` / `$derived` / `fork()`.
- **React modern** — WIP fiber vs current fiber. Same component identity, different value-states. Internally; user-facing is `useOptimistic` / `useTransition` / `useState`.
- **Replicache** — B-tree DAG with `main` / `sync` heads. The closest to exposing it (named heads are semi-public; most user code doesn't see them).
- **Postgres MVCC** — row identity stable; multiple tuple-versions per row, indexed by transaction. Internally exposed via `xmin`/`xmax`; not user-API.

The pattern is universal. None of them lets the user say "give me node N's value-bag entry tagged with scope S" as a primitive. Instead they each invent bespoke compositions (`useOptimistic`, `_overrideValue`, `Batch.current.get(node)`) that are *internally* just value-bag-entry-with-scope-S.

**The pulse move under this framing:** expose `(node, value-bag)` as the user-facing primitive, rather than pre-bundled hooks like `useOptimistic`. Higher-level abstractions become userland:

- `<Loading>` = "subscribe to nodes' value-bags; while any has non-committed entries, render the fallback"
- `optimistic(action, node, value)` = "write into node N's value-bag, tagged with action's scope"
- `transition(scope, body)` = "open a scope; writes inside body go into target nodes' value-bags tagged with this scope; commit at end"
- `action(function*)` = "open a scope at start; commit at each yield-point (each yield is a sub-scope); discard if generator throws"
- `fork()` = "open a scope but don't commit; let user code call `.commit()` or `.discard()` explicitly"
- `latest(node)` = "read node's value-bag's committed entry, ignoring any non-committed entries"
- `isPending(node)` = "does node's value-bag have any non-committed entries?"
- `refresh(node)` = "invalidate node's committed entry; trigger re-computation"

All of these become library code over (node, value-bag, scope) primitives. The framework provides the underlying machinery; userland composes the patterns.

### Open questions about the node/value-bag framing

- **How is a value-bag entry accessed?** Does each entry have an explicit key (scope identity, version number, status tag), and is the read API "give me entry for key K" or "give me the latest committed" or "give me the one for the current reading scope"?
- **Does the user write into the bag directly**, or is the bag entirely framework-managed (users write values; framework decides which bag-entry that maps to based on active scope)?
- **What does Dim 3 (priority) look like in this framing?** It's the work-scheduling primitive, the third leg. Possibly just "writes carry a priority hint that the scheduler honors when picking the next entry to commit."
- **Does `<Loading>` collapse to "subscribe to bag-entry-status changes"?** Simpler than the current gather-on-boundary; need to verify boundary semantics survive.

### Historical data point — Solid's transition-machinery trajectory (verified)

User recollection in the session 13 conversation: Solid had a node-cloning approach to transitions at some point that "caused them a lot of headaches." Also: at some point Carniato stated the key insight for Solid 2.x was *"handle the transition at the computed node level instead of as a scheduler from outside."* **Both claims are now verified against the Solid git history** (`/Users/bigmistqke/Documents/GitHub/solid`).

The full trajectory across both Solid 1.x and Solid 2.x:

**Solid 1.x — per-node `tValue` slot + scheduler-tracked source set.** Every `Signal<T>` carried a `tValue?: T` field — the transition-specific value of the node. Reads checked `Transition && Transition.running && Transition.sources.has(s)` and returned `s.tValue` if so, else `s.value`. The `Transition.sources` Set centralized in the scheduler tracked which nodes were participating. This was iterated extensively — the git log shows **20+ transition-related commits across Solid 1.x's lifetime** (`fix transition`, `better transition fix`, `Streamline transition effect queuing`, etc.). The commit `3623573b` (Oct 8 2021, "new transitions and reactive experiments") was a substantial rewrite of `signal.ts` (~440 lines changed) — but the basic shape (per-node slot + scheduler-tracked Set) persisted.

**Solid 2.x early development — full node cloning.** Solid 2.x's reactive substrate is a separate package (`@solidjs/signals`), forked from Modderme's `reactively` library (initial commit Dec 8 2022). In the early 2.x development, transitions used **actual node cloning** via a `cloneGraph(node, optimistic?)` function. The transition's `_sources: Map<node, clone>` held the clone-of-each-affected-node; each clone carried a `_cloned` pointer back to its original; the active transition was the scheduler holding all this state. **This is what Carniato meant by "scheduler from outside"** — the transition was an external context holding a parallel cloned subgraph; nodes themselves only carried a `_transition` pointer indicating they were participating.

**Solid 2.x mid-development — non-clone optimistic.** Commit `c741f2e0` ("non-clone optimistic", Oct 17 2025, Ryan Carniato) removed the optimistic-cloning path. The diff explicitly removes the `optimistic` parameter from `cloneGraph`; optimistic state moved to overlay (`_overrideValue` slot on the stable node). Transitions still cloned at this point.

**Solid 2.x current (v2.0.0-beta.13) — no cloning anywhere.** Over the ~273 commits between `c741f2e0` and the current beta, the rest of the cloning was removed too. `grep` for `cloneGraph` or `_cloned` in the current source returns zero hits. The architecture is now per-node multi-slot (`_value` / `_pendingValue` / `_overrideValue` / `_snapshotValue`) coordinated by a lightweight `Transition` object that aggregates pending nodes, optimistic nodes, gated subs, action iterators, queue stashes — but **the transition state lives on the nodes themselves**, not in a parallel cloned tree.

The trajectory:

- Solid 1.x: per-node `tValue` slot + scheduler-tracked `Transition.sources` Set
- Solid 2.x early: external scheduler holds cloned subgraph; nodes carry `_transition` pointer only
- Solid 2.x mid: cloning for transitions; overlay for optimistic
- Solid 2.x current: per-node multi-slot; no cloning anywhere

**This is strong empirical evidence for the node/value-bag framing.** Carniato's stated principle ("handle the transition at the computed node level instead of as a scheduler from outside") IS the move from a parallel cloned subgraph to per-node value-bag. The cloning approach was tried in production-grade 2.x development for ~2+ years and was abandoned commit-by-commit. The direction Solid's design has moved — across both 1.x and 2.x — has been *toward making the value-bag larger and more structured*, **and away from external-scheduler-managed parallel structures**.

If pulse adopts the node/value-bag framing as the user-facing primitive, it would be *exposing what Solid arrived at internally* as the API surface — making explicit what Solid has been keeping implicit. This is a meaningfully different design move, informed by ~5 years of Solid's transition-machinery iteration across two major versions and one substantial substrate rewrite.

---

## Sketch — what node + value-bag looks like as a pulse API

Working sketch (not committed). The goal is to show what user-facing primitives expose the node/value-bag separation in a way that feels native to pulse's existing API style, and to verify that the high-level abstractions in the comparison table genuinely compose from these primitives. Open questions noted at the end.

### What pulse already has

Pulse's current surface is consistent with the node/value-bag decomposition more than the existing API name suggests:

- `signal(initial)` returns `[Accessor<T>, Setter<T>]`. The Accessor is a callable with a `[NODE]` symbol attached (`pulse/src/signal.ts:22-25`). **The accessor IS the node identity from the user's perspective; the value is what `accessor()` returns.** The two are already syntactically separated; what's missing is the multi-valued bag.
- `untrack(() => …)`, `latest(() => …)`, `isPending(() => …)` are all *context-running* helpers — they change how reads inside the body resolve. These are the precedent for scope-aware reads.
- Owners (`pulse/src/owner.ts`) are the existing scope-of-relevance primitive — for disposal lifecycle, not for state coordination. They're useful as a model for what *scoped state* might look like.

### The proposed additions

Three primitives, all small, designed to feel native to existing pulse conventions:

```ts
// 1. SCOPES — first-class primitive for "named context that holds writes"
//    Created and held by the user; explicitly committed or discarded.
const tx = scope()              // open a new scope; returns a handle

tx.run(() => {                   // run a body inside the scope
  setCount(42)                   //   - writes go into count's value-bag tagged with tx
  console.log(count())           //   - reads inside scope see tx's bag-entry
})

tx.commit()                      // tx's bag entries become committed; bag collapses
tx.discard()                     // tx's bag entries removed without committing

// Async variant — scope auto-commits on resolve, auto-discards on throw:
await scope(async () => {
  setCount(predicted)
  const real = await api.save()
  setCount(real)
})
```

```ts
// 2. SCOPE-AWARE READS — peek into a node's value-bag without committing to its
//    current entry. The existing `latest()` / `isPending()` style is the precedent.
latest(() => count())            // read count's committed entry, ignore any staged
isPending(() => count())         // does count's bag have any non-committed entries?

// Within a scope:
tx.run(() => count())            // returns tx's bag-entry if present, else committed
```

```ts
// 3. SCOPE-AWARE WRITES — write to a node's value-bag, optionally tagging with scope.
//    Without scope: the current "commit immediately" behavior.
setCount(42)                     // unchanged: commits to count's value-bag immediately
setCount(42, { scope: tx })      // optional: write to count's bag tagged with tx
                                 //   (equivalent to writing inside `tx.run(...)`)
```

That's the entirety of the proposed additions. The accessor stays a callable; signals stay tuple-returning; reads-and-writes stay function calls. The scope is the new explicit primitive; everything else is the same as today's pulse, slightly extended.

### Composing the high-level abstractions

The claim is that every high-level abstraction in the comparison table composes from {scope, scope-aware reads, scope-aware writes}. Sketching each:

**`<Loading>` boundary** — the existing pulse primitive, now expressed in scope terms:

```ts
// Library code (composed from primitives, not framework-built-in):
function Loading({ fallback, children }) {
  // Implicit: any computed within `children` that depends on a node with pending
  // entries in its value-bag triggers the boundary. Same pipeline-OR walk pulse
  // already does, expressed as "any node in scope has a non-committed bag entry."
  if (isPending(() => children())) return fallback
  return children()
}
```

**Optimistic update** — manual:

```ts
const tx = scope()
tx.run(() => setCount(predicted))
try {
  const real = await api.save()
  tx.run(() => setCount(real))
  tx.commit()
} catch {
  tx.discard()                    // reverts to committed value automatically
}

// Library sugar (one-liner):
optimistic(predicted, () => api.save())
// Internally: opens scope, writes predicted, runs body, commits-or-discards.
```

**Transition** — a scope without immediate commit:

```ts
const tx = scope()
tx.run(() => {
  setFilter(newFilter)
  // ... lots of dependent updates ...
})
// tx auto-commits when all async settles inside the scope's reactive graph,
// OR explicitly via tx.commit()
```

**Action with intermediate atomic steps**:

```ts
const saveTodo = action(function* (text) {
  setTodos(t => [...t, { text, pending: true }])     // optimistic local change
  const saved = yield api.save(text)                   // wait for server
  setTodos(t => t.map(td => td.text === text ? saved : td))  // commit real
})

// Internally: action() opens a scope, runs body inside it, commits at each
// yield (or at end), discards on throw. Implementation is library code over
// the scope primitive.
```

**`fork()` (Svelte-style speculation)** — user-held scope without auto-commit:

```ts
const preview = scope()
preview.run(() => setRoute('/profile'))               // speculate the route change
button.onmouseenter = () => preview.run(...)          // warm up
button.onclick = () => preview.commit()               // commit on intent
button.onmouseleave = () => preview.discard()         // discard on retraction
```

**`refresh(node)`** — invalidate a node's committed bag entry:

```ts
refresh(userSignal)              // forces re-computation of userSignal's value
                                 // Implementation: removes the current committed
                                 // entry; re-runs the source computation to
                                 // produce a fresh entry.
```

### What's NOT in the sketch (deliberately)

- **No priority / lane** primitive. Dim 3 is left for later — pulse can decide whether to add `scope({ priority: 'low' })` once the rest of the design is concrete.
- **No `useOptimistic`/`createOptimistic`-equivalent as a framework primitive.** Optimistic state is a userland composition over scope (as shown).
- **No `<Reveal>`-equivalent as a primitive.** Validated below as composing from the existing primitives + a cooperative boundary interface; library code, not a framework primitive.
- **No replacement for the existing `signal` / `computed` / `effect` API.** Those stay. The sketch is purely additive — `scope()` is new; reads and writes get an optional scope parameter.

### Open questions about this sketch

- **How does the framework know which scope a read is "in"?** The sketch assumes dynamic scope context (like `untrack`'s mechanism). The active scope is read from an ambient slot; `tx.run(body)` sets the slot for the body's duration. This is the lightest approach but means scopes are dynamically-scoped (you can't pass a scope around and have it implicitly apply when read in another place).
- **Does the scope persist across `await`?** For sync bodies, dynamic scoping is fine. For async bodies (e.g. inside `action(function*)`), the scope must persist across `await` points. Pulse can borrow Solid's `restoreTransition` approach (re-enter the scope after each await) or wrap the body in continuation-style machinery.
- **What's the relationship between scopes and owners?** Owners are disposal-lifecycle-scoped. Scopes are state-coordination-scoped. They could be unified (a scope IS an owner with extra state) or kept separate (scopes are state-only; owners are disposal-only). Probably the latter — they answer different questions, conflating them is the Solid `_transition`-pointer-on-node trap.
- **Does the existing `use(x)` primitive change?** Currently `use(x)` is an opt-in to transition-style reads. Under this sketch, `use` might become "ensure this read participates in the current scope's bag-coherence" — same idea but expressed through the scope abstraction.
- **What about nested scopes?** A scope opened inside another scope's body could either inherit the outer scope (merge entries into the outer's bag) or open a fresh scope (independent bag entries that need their own commit). Solid's action-inside-action shares the transition; React's `startTransition` inside `startTransition` is also single-scope. Defaulting to "inherit" is probably right.
- **Does this support concurrent scopes (Dim 2)?** Multiple scopes can be open simultaneously — `scope()` doesn't return a singleton. Each scope's writes go into the corresponding bag entries. Reads outside any scope see committed; reads inside scope S see S's entry. This is concurrent transitions by construction; whether it scales (per Svelte's ~800-line batch.js) is a separate engineering question.

### Why this sketch is worth taking seriously

The high-level abstractions compose cleanly. The API surface is small (one new primitive — `scope` — plus optional parameters on existing primitives). The conceptual shift is genuine: users see *scopes* and *value-bag entries* explicitly, rather than `useOptimistic` / `useTransition` / `fork` as opaque hooks. The cost is real (users have to know what a scope is) but matches pulse's articulated philosophy that *complexity should be composed from simple principles, not hidden behind specialized hooks*.

The sketch also matches Solid's empirical trajectory described above: Solid moved from external-scheduler-managed cloned subgraphs to per-node value-bag over 5 years of production iteration. The sketch exposes what Solid arrived at internally — making the value-bag user-visible — without re-litigating which implementation strategy is right.

### Concrete fix this framing offers — the late-mounted `<Loading>` edge case

Beyond the conceptual reframing, the node/value-bag decomposition fixes a real fragility in pulse's current implementation. Worth flagging because it shows the framing isn't just notation — it actively improves design.

**Current pulse behavior** (`pulse/src/dom/loading.ts:33-40`): the `<Loading>` boundary's hold-prior decision depends on **per-boundary state** — the boundary tracks "have I rendered the loaded subtree before?" If yes, refetches keep the previous subtree visible (SWR-style); if no, fallback is shown.

**The edge case:** consider a `<Loading>` boundary mounted *after* the signal it would wrap has already committed. Concrete scenarios:

- A refactor adds a `<Loading>` wrapper around code that was previously fine without one.
- A conditional `<Loading>` is mounted because some other state flips.
- A boundary remounts (e.g., the wrapping component re-renders and replaces its boundary).

In all three cases, the newly-mounted boundary has empty per-boundary state. When the next refetch puts an upstream into pending, the boundary treats it as **first-load** — shows the fallback — even though the signal has been resolved for ages and the user reasonably expects hold-prior. **Same code, different mount position or remount timing, different behavior.** That's the fragility.

**Why this happens:** the "has been previously committed" property is being tracked on the *wrong* primitive. It's a property of the *signal's history*, not the *boundary's history*. A boundary is just a renderer; it should be a pure function of the signals it's subscribed to. Tracking the property on the boundary couples rendering decisions to mount timing in a way users can't predict.

**The fix under node/value-bag framing:** move the "has been previously committed" property to the signal's value-bag. Then any boundary — newly-mounted or long-running — gets the same answer by asking the same question of the same signal:

```ts
// Signal's value-bag has a `hasCommitted` slot, true iff the committed entry
// has ever been populated (not UNINITIALIZED sentinel).
//
// <Loading> becomes library code (~6 lines):
function Loading({ fallback, initial, children }) {
  const signals = collectDependencies(children)
  const anyPending = signals.some(s => s.bag.hasPending())
  const allCommitted = signals.every(s => s.bag.hasCommitted())

  if (!anyPending) return children()
  if (allCommitted) return children()   // hold-prior on refetch
  return initial ?? fallback            // first-load
}
```

The decision is now a pure function of the signals' bag states. Mount timing is irrelevant. A boundary mounted long after the signal first committed sees the same bag state as one that was there from the start; refetch behavior is identical regardless.

**Why this matters for the design conversation:** the current pulse design has an implicit assumption (boundaries outlive their signals) that the user has just identified as brittle. The node/value-bag framing fixes this not by adding new machinery but by **moving state to the primitive that semantically owns it**. The framing isn't just notation — it's a concrete improvement, and the same shape will likely fix other implicit-assumption fragilities once they're identified.

This is structurally what Solid 2.x ended up doing — its signals track their own resolution state (`STATUS_UNINITIALIZED` / `STATUS_PENDING` flags on the node) — so any boundary that catches a `NotReadyError` can ask the source node "have you been initialized?" and get a consistent answer regardless of boundary lifecycle. Pulse arriving at the same per-signal-state pattern via the node/value-bag framing converges on the same engineering answer.

### Validation against `<Reveal>` — does sibling-boundary coordination need a fifth primitive?

Open question (iii) from above. Resolved during session 13: **no fifth primitive needed. `<Reveal>` composes from the existing primitives.** What it requires is a library-level design discipline — boundaries must be cooperative-by-design, exposing state as signals and accepting external control via signals.

**What `<Reveal>` mechanically does** (from the Solid 2.x dive): coordinate sibling `<Loading>` boundaries with a policy (sequential / together / natural). Each child boundary registers as a "slot"; the `RevealController` toggles each slot's `_disabled` / `_collapsed` signals to delay when resolved boundaries become visible. Crucially: *"Reveal manipulates the visibility of already-resolved boundaries"* — it's a layer over already-resolved boundaries, not a coordination of pending ones.

So `<Reveal>` requires three mechanical capabilities:
1. Discover its child boundaries (context propagation through the JSX tree)
2. Subscribe to each child boundary's "is-ready" state
3. Write to each child boundary's "hold" state, based on policy

**The cooperative-boundary interface.** For `<Reveal>` to compose, `<Loading>` must expose itself with this shape:

```ts
interface CooperativeBoundary<T> {
  view: T                          // what the boundary renders
  ready: Accessor<boolean>         // signal: am I ready to be released?
  held: Setter<boolean>            // signal-setter: parent telling me to wait
  // Optionally: a held-mode signal for distinguishing
  // "stay on loading state" vs "collapse to nothing while held".
}
```

That's a (signal-out, signal-in) shape — same pattern as every other composable pulse component. No framework extension required.

**`<Reveal>` as ~15 lines of library code:**

```ts
function Reveal({ order, children }) {
  // children: array of CooperativeBoundary instances
  const policy = order ?? 'sequential'
  const slots = children.map(boundary => ({
    boundary,
    held: signal(true),
  }))

  // Hold-policy as a reactive effect over children's ready states:
  effect(() => {
    if (policy === 'sequential') {
      // Release slots in registration order; each waits for previous.
      slots.forEach((s, i) => {
        const allEarlierReady = slots.slice(0, i).every(p => p.boundary.ready())
        setSignal(s.held, !allEarlierReady)
      })
    } else if (policy === 'together') {
      // Hold all until all are ready, then release together.
      const allReady = slots.every(s => s.boundary.ready())
      slots.forEach(s => setSignal(s.held, !allReady))
    } else { // natural
      // Each releases on its own readiness; no inter-slot coordination.
      slots.forEach(s => setSignal(s.held, false))
    }
  })

  // Group's own ready signal (policy-dependent: sequential = first-ready,
  // together = all-ready, natural = any-ready) for fractal composition.
  const groupReady = computed(() => /* policy-dependent over slots */)
  return { view: slots.map(s => s.boundary.view), ready: groupReady }
}
```

**Fractal composition falls out for free.** `<Reveal>` returns the same `{view, ready}` shape as `<Loading>`. So a Reveal can be a child of another Reveal — the outer treats it as just another slot. Solid 2.x's nested-Reveal-composition property survives without a fifth primitive. The "boundary" abstraction generalizes to *anything with the cooperative interface* — Loading, Errored, Reveal, custom boundaries — they all compose because they share the (ready-signal, held-signal) shape.

**One subtle finding worth flagging for boundary design.** Solid 2.x uses *two* signals per held slot (`_disabled` + `_collapsed`) because there are two distinct meanings:
- `_disabled` = "you're held; render your loading state"
- `_collapsed` = "you're held; render nothing at all"

These are different render modes. If pulse's `<Loading>` exposes just one `held` signal, users lose the ability to distinguish "fade to nothing while waiting in line" from "show your loading state while waiting in line." So the cooperative interface probably needs either two held-mode signals or a single held signal with a mode parameter. The choice depends on whether collapsed-vs-disabled is a common UX need. This is a UX-led design question, not a framework-level one.

**What this validation proves about the framing.** The framing is sufficient: every high-level abstraction in the comparison table (Loading, optimistic, transition, action, fork, Reveal) composes from the proposed primitives plus reasonable library-level design discipline. There's no operation in the comparison table that needs a primitive we don't have. **The "open question (iii)" from the decomposition section is now closed.**

**What this validation tells pulse about library design.** The boundary primitive needs to be designed with cooperation in mind from the start. If `<Loading>` is opaque (no `ready` accessor, no `held` setter), then *no userland code can build `<Reveal>` over it* — and pulse would have to ship Reveal as a framework primitive after all. The cost of NOT designing for cooperation is that every coordination pattern becomes a new framework primitive. The benefit of designing for cooperation is that the framework stays small and coordination patterns multiply in userland. **This is the design discipline pulse needs to commit to** if it wants to keep the primitive set minimal.

---

## Design questions to address

Open questions the research arc has surfaced. Each is a decision point. Marked as **open** until addressed concretely below.

### Per-dimension questions

- **Q1 — Dim 1 (internal):** pulse already has `<Loading>` gather. Settled, or does it need refinement? Particularly: should there be a `latest()`-like opt-out for *initialization* async that should settle to sync once resolved (vs *loading* async that's recurring)? **Open.**
- **Q2 — Dim 2 (concurrent transitions):** pulse currently has no machinery. Three positions: (a) don't support, (b) explicit user-named transitions, (c) implicit per-write lanes. Articulated stance leans (b). **Open.**
- **Q3 — Dim 3 (input-arrival priority):** pulse currently has no machinery. Three positions: (a) don't support, (b) explicit priority markers at dispatch site, (c) auto-inferred from event source. Articulated stance leans (b). **Open.**
- **Q4 — Dim 4 (state-overlap):** pulse's pipeline-OR walking is a weaker form. Two positions: (a) keep pipeline-OR — rely on dep-graph visibility, (b) adopt Solid-style auto-merge. Articulated stance leans (a). **Open.**

### Cross-cutting questions

- **Q5 — Optimistic state primitive:** dedicated primitive (Solid `createOptimistic`), no API + auto-revert (Svelte), or fused into action-shaped wrapper (React Actions)? **Open.**
- **Q6 — Cancellation discipline:** identity-based stale-discard, explicit `AbortController` plumbing, or structural-by-owner-disposal? **Open.**
- **Q7 — The "settle once, never re-pending" pattern** (the friction with Solid 2.x for initialization async): first-class primitive or composed via `latest()`-equivalent? **Open.**
- **Q8 — Transitions as primitives or `<Loading>` companion:** are `transition()`, `optimistic()` standalone primitives that compose with `<Loading>`, or is `<Loading>` itself a thin wrapper over deeper primitives that userland could re-compose? **Open.**
- **Q9 — Action / mutator-shaped abstraction:** does pulse want anything action-shaped (Solid `action(function*)`, React Actions, Replicache mutator), or stay closer to "async functions that touch signals"? **Open.**

---

## Decisions (so far)

Populated as the session-13+ conversation produces concrete commitments. Each
decision records which question it addresses, the chosen position, the rationale,
the trade-off accepted, and the evidence behind it.

Decisions below were settled in the session-14 (2026-05-20) grilling pass that
followed a pressure-test of the node/value-bag candidate against the four red
edge-case tabs (`examples/transitions`) and scenarios S1–S8.

### Speculation: one concept, two faces

A naming reframe that the rest of this section uses. The mechanism pulse is
designing is **speculation** — a tentatively-applied write-set held over
committed state, observable to reads, eventually committed or discarded.
"Transition" is the established field term (React `useTransition`, Solid
`Transition`), but it presupposes the commit (A → B implies B happens); every
framework using it then has to bolt on a separate vocabulary for the failure
mode (revert, rollback, supersede). "Speculation" is symmetric and self-contained
— *speculate / commit / discard* — and imports the CPU-speculation mental model
(work done against a predicted outcome, ready to be thrown away if reality
disagrees) load-bearingly, not analogically.

The unification:

- **One concept** — a speculative scope: a held write-set that may or may not survive.
- **Two faces of the same scope:**
  - **Write side** — `action` opens a speculative scope; writes inside are tagged with it; on return → commit, on throw → discard. (D1, D2, D7.)
  - **Read side** — a **speculative zone** gates publication of a region's downstream view until the speculations it depends on settle. The read-side dual of `action`. (D12. Today's `<Loading>` is one motivation for a speculative zone; entanglement (E4), optimistic prediction, and hovered-route prefetch are others.)
- **"Optimistic" and "transition" (in the React/Solid sense) are not two mechanisms** — they are two *labels for what a speculation is about* (predicted server state vs. intended client state). Same mechanism, same lifecycle, same scope primitive. (D3.)

The rest of this section uses "speculation" / "speculative scope" / "speculative
zone" for pulse's concept, and reserves "transition" for cross-references to what
other frameworks call this. The API names (`action` for write-side; the read-side
zone primitive is unnamed) don't change as part of this reframe — "transition"
may even survive as a user-facing word for SEO/discoverability reasons. The
reframe is conceptual, not an API rename.

### D1 — Commit-grouping primitive: body-style `action`, not handle-style `scope()`

*Addresses Q8, Q9.* Async speculations group their writes via a body-style
`action(function*)` — a generator-driven async body whose signal writes auto-group
into one atomic commit. The handle-style `scope()` sketch (open writes with a
threaded `tx`) is dropped. Sync grouping stays implicit: one scheduler batch of
writes is one commit unit.

Rationale: ambient auto-tagging inside the body removes handle-threading, whose
omission is a silent opt-out (the same footgun CONTEXT.md flags for `use`); a
delimited body is required for read-set tracking regardless, so a separate
`scope()` is redundant; the shape mirrors `computed(function*)`.

Trade-off: `action` must be a generator, not a plain `async function` — only a
generator lets the driver restore the ambient action context across `await`
points. Evidence: pressure-test finding 2 (the captured-local problem forces an
action-shaped abstraction).

### D2 — Action lifecycle: auto-commit on return, auto-discard on throw

*Addresses Q9.* An `action` commits all its writes when the generator returns and
discards them all if it throws. There is no explicit `commit()`/`discard()`.

Rationale: the body's completion is the commit signal; a thrown step discards the
whole write-set, giving S3 (multi-step partial failure) atomicity for free; no
"forgot to commit" footgun. The explicit Apply/Cancel shape (S8 preview) needs
no change to `action` and is deferred to a later decision.

### D3 — No `optimistic` primitive; in-flight writes are held by the action

*Addresses Q5, and concurrent-flows Q2.* There is no dedicated optimistic
primitive. Optimistic UI is a use of `action`: a predicted `setX(...)` inside an
action body is held in that action's write-set; the base signal cell is untouched
until commit. A plain read of a signal resolves to its committed base value with
any in-flight action's held write applied on top — so a prediction is visible
with no ceremony, and a multi-step action's intermediate writes are visible
mid-flight as pending state. `latest(() => x())` opts out to committed-only.
Auto-discard (D2) reverts a failed prediction with no manual rollback.

Rationale: the predict → settle → revert lifecycle is exactly what `action`
already does; a dedicated primitive (`useOptimistic` / `createOptimistic` / an
`optimistic` node) is redundant. Holding the write in the action rather than the
shared base cell is what fixes E3 (a concurrent refetch of the base cell cannot
collide with the prediction) and S1 (discard needs no remembered prior value, so
interleaved rollbacks cannot corrupt state).

Trade-off: a plain read is no longer "just the cell" — it resolves through
in-flight held writes. This is benign (a no-op when no action is in flight; it is
value resolution, not implicit suspension) but it is a real change to the read
path in `signal.ts`. concurrent-flows Q2 is thereby answered "(b) latest active
overlay."

### D4–D11 — Design direction from the transitions-solid porting exercise (2026-05-21)

*Addresses Q1, Q5, Q7–Q9, and several questions not previously enumerated.* Carried over from the porting exercise as concrete things Solid does that pulse should not. These extend D1–D3 with positions on the read model, async surfacing, and the read-side commit boundary.

**D4 — No `flush()` in the surface.** Pulse should not need `flush()` or similar ceremony. Solid's staged-write + `flush()` is a push-batching artifact; a lazy pull-based read model removes the need — `setX(1); x()` returns `1` immediately. Batching still matters for *effects* (coalesce N writes → 1 run), but that should be automatic (microtask-scheduled), invisible. An await-for-async mechanism is still inherent and acceptable; a synchronous flush is not.

**D5 — A plain read is always defined; never throws.** In Solid every read partakes in the transition and even `latest()` throws `NotReadyError` when no committed value exists yet (initial load). In pulse a plain read returns last-known (committed or speculative overlay) and never throws; pending-ness is a separate query, not an exception.

**D6 — Speculation is explicit-boundary, not implicit.** Solid 2.x makes every async-feeding write an implicit write-level speculation (what it calls a transition) — pulse rejects that (it collides with D4: write-level hold and honest synchronous reads are mutually exclusive). Instead a speculative scope is an explicit boundary you opt into. Outside a scope: writes commit immediately, reads honest. Inside: write-level speculation semantics (held speculation, atomic commit, reads see the scope's own staged writes so read-modify-write is safe *inside*). Trade accepted: no-flash is opt-in — a bare write that triggers a refetch flashes unless wrapped (the Solid 1.x bargain). Reinforces D1.

**D7 — `action` is the sole speculation primitive.** Decided ("let's bank on action") over also having a `startTransition`-equivalent. The speculative scope *is* an `action` invocation; an inline atomic block of writes is just an inline `action` call. Open: whether `action` needs a thin inline form for the trivial "batch these two writes" case, or that case is rare enough to leave as `action(function*(){...})()`. Reinforces D1.

**D8 — Async computeds are not auto-unwrapped; futures are unwrapped explicitly.** A `compute` whose body returns a Promise stays typed `Accessor<Promise<T>>` (NOT `Accessor<T>` as in Solid 2.x, where the collapse is what throws `NotReadyError`). The reactive graph stays fully synchronous — a Promise flows through it as an ordinary value (a future). Two unwrap operations with genuinely different semantics:

- **`yield* read(...)` / `await` — park-and-wait.** Binds to one *specific* future instance and holds the frame open across its resolution, however far away. Native pause point (generator/async-fn), no throw. Sequential `yield*`s sample at different instants → read-skew prone.
- **`use(...)` — non-parking, point-in-time.** "Resolve the current state *now*." Never holds a promise across a far-away resolution. Its not-ready *fallback* is context-dependent: in a **restartable** context (`compute`) not-ready → throw-to-suspend → restart, and on restart `use()` re-samples — so all `use()`s in a body re-run together, sharing one coherent snapshot. `use()` is therefore the **snapshot-consistent** unwrap and the answer to read-skew (this is what Solid's throw buys). In a **non-restartable** context (`action`) there is no restart, so `use()` becomes a genuine **peek** — "give me the resolved value now; not-ready is a catchable condition" — fit for best-effort / assert-ready reads, as against `yield*`'s commit-to-wait.

`use()` is the explicit opt-in, NOT a plain read — so it can throw without violating D5 (plain `signal()` never throws). Coloring dissolves because resolution is a re-run/resume, not a stack unwind, for the native-pause-point forms. A new Promise is minted per dependency change, so unwrap keyed on promise identity doubles as the supersession signal.

**D9 — Guiding principle: acknowledge async, don't hide it.** Solid's `Accessor<T>` collapse hides the async, and that hiding *is* the bug — `NotReadyError` is hidden async resurfacing where it wasn't asked for. Pulse keeps the `Promise` visible in the type and makes async a declared part of the dataflow. **Stages**: `compute(source, stage1, stage2, …)` where each stage `(T) => T2` operates on the *resolved* value while the result type stays `Accessor<Promise<T2>>` (async-ness propagates through the type; a fully-sync pipeline has no `Promise`). A stage is the *declarative* "declared relationship over a future"; `use` is the *imperative* terminal unwrap at the consumption edge. **Resolved (2026-05-22):** a stage is a **pure transform** `(T) => U` with NO signal reads inside — so it is safe `.then`-desugaring sugar. A signal read inside a stage/`.then` callback runs in a microtask, outside the compute's synchronous tracking window, so it is silently *untracked* (`compute(() => source().then(v => v * otherSource()))` never subscribes to `otherSource`). Any mid-pipeline signal combination must go through `yield* read` in the generator form — `yield* read` is the single tracked-read primitive that survives an async boundary. **Rule: never read a signal inside a stage or a `.then`.** (Engine-visible stages would then only be a perf option for per-stage memo, not a correctness requirement.)

**D10 — An action has a declared reactive prerequisite, separate from its imperative body; the handle exposes standing state.** A button needs to reflect its action's readiness *before* the action runs — and a standing `ready()` cannot come from the imperative body (the body hasn't run; it runs on invocation). So the prerequisites must be hoisted out of the body into a *declared, continuously-evaluated* expression — this is structurally forced, not sugar. That declared part *is* a `compute`/stage (hence "it looks like stages" — reuse, not duplication): **an action = a reactive prerequisite `compute` → an imperative body invoked on demand.** The body receives the *resolved* values, which enforces gather-up-front / snapshot-consistent / skew-free input handling as the shape of the API. `ready()` needs no new machinery — it is `!pending` of the prerequisite compute, and that pending state is exactly what `use()`'s suspend produces. The prereq compute *gates* (enables the button), it does not *trigger* (the body still runs only on invocation). The action handle should expose a small family of standing reactive states: `ready` (prereqs met), `pending` (body in flight), `error` (last run failed); a button needs `ready` and `pending` both, to avoid double-submit. Open (ergonomic only): inline two-arg `action(depsFn, body)` vs. an action consuming a separately-declared `compute` — the forced requirement is only that the handle exposes standing `ready/pending/error`.

**D11 — Three authoring forms for `compute`, three resumption behaviors.** (a) **stages** — no suspension, future threaded via `.then`, declarative. (b) **`use` in a plain body** — re-runs the whole body from the top when the future settles. (c) **generator** — `compute(function*(){ const x = yield* read(signal); … })` — a coroutine; `yield* read(sig)` both registers the dependency and (if the read is a future) suspends the generator, resuming with the concrete `T`. Inside the body you only see `T`, never `Promise<T>` — no coloring, because the `function*` is itself the re-runnable context. The generator is the only form that *resumes* from the `yield*` checkpoint instead of re-running from the top — each `yield*` is a progress point. Resume/re-run rule: when the awaited promise resolves → resume `.next(value)`, keeping earlier results; when an upstream signal read earlier changes *while suspended* → re-run from the top (earlier reads stale). The generator body is the same form as `action(function*(){…})`, so the coroutine is the shared authoring form — `compute` = pure cached derivation, `action` = imperative speculative scope — with `yield* read` plausibly the one shared read primitive. `yield* read` of a *sync* signal does not suspend (yields a subscribe instruction, returns synchronously); only a future-valued read parks the generator.

**D12 — Atomic commit of incoming async data is a speculative-zone concern, not a per-read option.** A per-`use` flag (`use(sig, { lockstep: true })`) is structurally wrong: lockstep is a *group* property and a single `use` cannot name what it is in lockstep *with*. Also, a single `compute` reading multiple async sources is *already* internally lockstep (its body yields no value until every `use` resolves) — tearing only happens *across* sibling computeds / JSX holes, i.e. across a set of sibling nodes, i.e. a tree region. So the coordination unit is a **speculative zone** (today's `<Loading>` boundary is one motivation; Solid calls this `<Transition>`/`<Loading>`) — the read-side **dual of `action`**: `action` = write-side speculative scope (commit boundary for outgoing *writes*); a speculative zone = read-side speculative scope (commit boundary for incoming *resolution*). Both are boundaries, not per-element flags. "Lockstep or not" falls out of nesting with zero flags: no zone → independent/streaming commit; a zone → its contents commit in lockstep; a nested zone → that sub-group commits independently of its parent. A zone never controls upstream — it coordinates the commit of its own subtree only (DOM + published values), strictly downstream; sources are untouched. A per-read `{ eager: true }` opt-*out* could exist but is just sugar for a nested singleton zone, never the primary mechanism. This is the fix for the transitions example's E2 ("torn across boundaries"), red because the boundary is currently per-`<Loading>` and one logical change spans two.

**Connecting back.** D4–D12 are consistent with the node/value-bag framing above and with the speculation reframe at the top of this section: a plain read returns the *latest entry* in the bag (committed or speculative overlay), `use` is the explicit unwrap of a future-valued entry with throw-to-suspend semantics inside restartable contexts, an `action` is the write-side speculative scope that tags entries with itself, and a speculative zone is the read-side dual that gates downstream publication of a region's entries until the speculations it depends on settle. The two faces share one mechanism: a held entry-set that either commits as a unit or is discarded as a unit.

---

## Cross-references

- **Research arc:** [`README.md`](./README.md) taxonomy + [`LOG.md`](./LOG.md) chronology + [`deep-dives/`](./deep-dives/) per-system analyses
- **Lexicon:** [`CONTEXT.md`](./CONTEXT.md) — canonical definitions of the four dimensions, the failure modes, and research vocabulary
- **Problem space:** [`transitions-problem-space.md`](./transitions-problem-space.md) — the four failure modes worked through with concrete examples
- **Cross-cutting threads in LOG:**
  - "Transitions branch in four dimensions" — the framing that motivates Q2–Q4
  - "Message-send to receivers of various existence-states" — broader receiver-existence framing
  - "Ricky Hanlon on React's API complexity" — the React-team's own admission that the low-level-API bet didn't pay off, informing pulse's stance on whether to follow React's model
- **Dives most directly informing this document:**
  - [`react-modern.md`](./deep-dives/react-modern.md)
  - [`solid-2x.md`](./deep-dives/solid-2x.md)
  - [`svelte-5.md`](./deep-dives/svelte-5.md)
  - [`bonsai-incremental.md`](./deep-dives/bonsai-incremental.md) (the "separate effect layer over reactive substrate" reference point)
  - [`xilem-druid.md`](./deep-dives/xilem-druid.md) (the "structural cancellation via Drop" + "Loading-primitive-is-more-valuable-in-JS" findings)
  - [`replicache.md`](./deep-dives/replicache.md) (the "sidestep branching via server-linearized replay" alternative)
- **Implementation specs (when ready):** `docs/superpowers/specs/<date>-pulse-<topic>-design.md` — currently empty for transitions; will be populated when specific decisions in this doc have settled enough to spec.

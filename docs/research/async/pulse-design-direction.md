# Pulse design direction — async coordination

**Status:** working synthesis, not a decided spec. Populated incrementally as the research-arc findings get translated into pulse design positions. Lives between the research artifacts (`README.md` taxonomy, `deep-dives/*.md`, `LOG.md` chronology) and concrete implementation specs (`docs/superpowers/specs/...-design.md`). Per CONTEXT.md's sourcing-discipline anti-pattern: pulse-specific design context goes here, not into the per-system dives.

**Origin:** opened session 13 (2026-05-19) after sessions 1–12 produced enough evidence to start articulating pulse's positions concretely. The dives' "what pulse can learn" sections were durable observations about each studied system; this document is the *synthesis across them* and the *decisions pulse takes in response*.

---

## What the research arc has shown

Compressed to one paragraph for context. Transitions are coordination machinery for **continuous-observation + concurrent-intent** workloads (UI is the canonical instance; also GGPO rollback, sync engines with optimistic+rebase, realtime collab). They branch in four distinct dimensions ([LOG.md](./LOG.md) "Transitions branch in four dimensions"): internal (tree of dependent async in one transition), concurrent (multiple in flight), input-arrival (new input during transition), state-overlap (transitions touching shared state). Production frameworks differ in which dimensions they handle and how, AND in whether their user-facing API surface is minimal (Svelte) or proliferating (React). Pulse's articulated design philosophy (sessions 11–12 conversations) is **user-visible primitives composed in userland** — distinct from React's "low-level API + library-authors compose ergonomics" and Solid's "framework-provided higher-level primitives" — but Svelte's evidence (sessions 12) showed that "minimum API" does NOT entail "minimum engine"; concurrent transitions cost engine surface regardless of how small the user API is.

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
| **Multi-step async composition** | `await` inside Action body; multi-transition batched together (limit) | `await` inside `$derived`; compiler tracks deps across await via `capture`/`save` (`await a + b` → `(await $.save(a))() + b`) | `action(function*) { yield … }` — generator yields are atomic commit boundaries; transition stays alive across `await`s |
| **Dependent dispatch capability** | Await-only (`use(promise)` requires resolution; re-executes component on resolve) | Await-only with implicit ordering (sequential `$derived(await)` decls serialize; framework warns via `await_waterfall`) | Await-only with generator batching |
| **Entanglement detection** | None (application models conflicts in user code, e.g. via `useOptimistic` revert-on-failure) | Whole-batch granularity (per-microtask-of-writes); coarser than Solid | Per-write granularity (union-find merge of dep graphs); automatic detection by structural overlap |
| **Compiler involvement** | None (runtime-only) | Heavy: `experimental.async` flag; lowers `await` to `async_derived`/`flatten`/`save`; tracks deps across await | None for reactivity (runtime-only); compiler-style binding for JSX only |
| **Engine surface (rough)** | Thousands of LOC: fiber reconciler + scheduler + Suspense machinery + Actions | ~800 lines for `batch.js` alone + boundary.js + async.js + deriveds.js | ~1300 lines: core.ts + scheduler.ts + lanes.ts + async.ts + boundaries.ts |
| **User-facing API count** | ~7+ hooks | 4 primitives | ~8 primitives |
| **Specific oddities worth knowing** | `useTransition`'s `isPending` is internally `useOptimistic`; Suspense fallback throttling | `{#await}` blocks are anomalous re: runes machinery (may be retired); async-derived value lives in a normal `Source` cell — no `.loading` accessor by design | `<Reveal>` with `sequential`/`together`/`natural` modes; `_gatedSubs` replay-at-commit for cross-transaction reads; three-layer atomicity (per-yield / per-transition / per-lane) |

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
- **(iii)** Are there mechanics in the table that *don't* compose from these four? `<Reveal>` is the suspicious one — it's coordination between *sibling* boundaries, which feels like it might need a fifth primitive about "boundary composition" rather than being expressible from the four.

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

*Empty.* Populated as the session-13+ conversation produces concrete commitments. Each decision should include: which Q it addresses, the chosen position, the rationale (in pulse's terms), the trade-off accepted, and a pointer to the research evidence that informs it.

---

## Cross-references

- **Research arc:** [`README.md`](./README.md) taxonomy + [`LOG.md`](./LOG.md) chronology + [`deep-dives/`](./deep-dives/) per-system analyses
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

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

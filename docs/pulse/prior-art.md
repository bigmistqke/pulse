# Pulse — prior art and analysis

Cross-framework analysis of reactive systems handling async + speculation,
plus the synthesis that motivates pulse's design framings. The comparison
table, the seven-concerns decomposition, and the signal=node+value-bag
recasting all live here; they're the empirical and conceptual ground that
[framings.md](./framings.md) builds on.

**Companion documents:**

- [README.md](./README.md) — overview + index.
- [framings.md](./framings.md) — principles, framings, engine + library sketches.
- [questions.md](./questions.md) — open questions.
- [scenarios.md](./scenarios.md) — TDD catalog.
- [scenario-traces.md](./scenario-traces.md) — end-to-end traces.

**Related pulse-repo docs:**

- [`../async/CONTEXT.md`](../async/CONTEXT.md) — speculation lexicon, four dimensions, failure modes.
- [`../async/deep-dives/solid-2x.md`](../async/deep-dives/solid-2x.md) — per-node multi-slot architecture reference.

## Contents

- [What the research arc has shown](#what-the-research-arc-has-shown)
- [Comparison: React modern / Svelte 5 / Solid 2.x](#comparison-react-modern--svelte-5--solid-2x)
- [Decomposition — seven underlying concerns](#decomposition--seven-underlying-concerns)
- [Signal = node + value-bag (the sharper recasting)](#signal--node--value-bag-the-sharper-recasting)
- [Empirical pattern — every studied framework does node/value-bag internally](#empirical-pattern--every-studied-framework-does-nodevalue-bag-internally)

---

### What the research arc has shown

Speculations (the field calls them _transitions_; see Principles below) are
coordination machinery for **continuous-observation + concurrent-intent**
workloads (UI is the canonical instance; also GGPO rollback, sync engines
with optimistic+rebase, realtime collab). They branch along four structural
dimensions — **Dim 1** internal structure of one speculation, **Dim 2**
concurrence (multiple alive, disjoint state), **Dim 3** supersession (newer
invalidates older), **Dim 4** overlap/entanglement (multiple alive, shared
state) — the non-trivial corners of `{one, many} × {disjoint, overlapping}
× {concurrent, sequential}`. Canonical definitions in the lexicon
[`../async/CONTEXT.md`](../async/CONTEXT.md). Production
frameworks differ in which dimensions they handle and how, AND in whether
their user-facing API surface is minimal (Svelte) or proliferating (React).
Pulse's articulated design philosophy is **user-visible primitives composed
in userland** — distinct from React's "low-level API + library-authors
compose ergonomics" and Solid's "framework-provided higher-level
primitives" — though Svelte's evidence showed that "minimum API" does NOT
entail "minimum engine"; concurrent speculations cost engine surface
regardless of how small the user API is.

### Comparison: React modern / Svelte 5 / Solid 2.x

The mechanical landscape for the three production frameworks pulse has the
most-developed dives on. Each cell is what the framework actually does.

|                                     | **React modern**                                                                                                                       | **Svelte 5 (`experimental.async`)**                                                                                                                          | **Solid 2.x**                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Substrate**                       | Fiber tree + lane-scheduled work queue (31-bit bitmask)                                                                                | Signals + linked-list of `Batch` objects + `<svelte:boundary>` queue                                                                                         | Reactive graph + per-write `OptimisticLane` + `Transition` object                                                                                                                                         |
| **User-facing primitives**          | `useTransition`, `useDeferredValue`, `useOptimistic`, `Suspense`, `use(promise)`, `useActionState`, Actions, Server Functions          | `<svelte:boundary>` + `pending` snippet, `$effect.pending()`, `settled()`, `fork()`                                                                          | `<Loading>`, `<Errored>`, `<Reveal>`, `action()`, `createOptimistic`, `latest()`, `isPending()`, `refresh()`                                                                                              |
| **Suspension mechanism**            | `use(promise)` throws cached promise; caught at Suspense boundary                                                                      | `await` inside `$derived` lowered to `async_derived`; gated by `boundary.#pending_count`                                                                     | `NotReadyError(source)` thrown; caught by `CollectionQueue.notify`                                                                                                                                        |
| **Dim 1 — internal structure**      | WIP fiber tree gathers all pending Suspense in scope; commits atomically when all resolve                                              | `boundary.#pending_count` for first render; `batch.#blocking_pending` for subsequent updates                                                                 | `Transition._asyncReporters: Map<Computed, Set<Computed>>` tracks each pending source → its reporters; per-source decidability                                                                            |
| **Dim 2 — concurrence (disjoint)**  | 31-lane bitmask; multi-low-priority currently batched (acknowledged limit)                                                             | Linked-list of `Batch` objects; each with `batch_values` time-travel snapshot; independent commit if non-overlapping                                         | Per-write `OptimisticLane`; independent lanes flush independently; not batched                                                                                                                            |
| **Dim 3 — supersession**            | High-priority lanes pre-empt low-priority; WIP discarded and rebuilt; cooperative 5ms yield to browser                                 | **None** as priority; per-derived `OBSOLETE` cancel + per-effect `STALE_REACTION` abort handle structural supersession; `fork()` is user-controlled          | **None** as priority; newer writes supersede via `_inFlight !== result` identity check                                                                                                                    |
| **Dim 4 — overlap (entanglement)**  | **Not handled**; multi-transition batching conflates with this                                                                         | Whole-batch merge on source-set intersection (`#find_earlier_batch` + `#merge`)                                                                              | Union-find lane merge on dep-graph overlap (`assignOrMergeLane`); parent-child lanes stay independent                                                                                                     |
| **Speculative-state isolation**     | Per-transition tree (WIP fiber) + per-action overlay (`useOptimistic`)                                                                 | Versioned engine, unbounded observable batches (linked list); `fork()` as flagged subtype with deeper isolation                                              | Per-write-lane overlay with overlap-merge; `_overrideValue` overlay + separate `_pendingValue` slot                                                                                                       |
| **Optimistic state**                | `useOptimistic(state, reducer)` returns `[optimisticState, setOptimistic]`; converges in same render as Action commit                  | No first-class API; user mutates state in `fork()` body or in async-derived (auto-reverts on `OBSOLETE` reject)                                              | `createOptimistic(value)` returns reactive signal; auto-reverts on action failure via `resolveOptimisticNodes`                                                                                            |
| **Cancellation discipline**         | Structural via WIP discard for rendering; convention-only `AbortController` for I/O effects                                            | Two channels: `OBSOLETE` (per-derived) + `STALE_REACTION` (per-effect); `getAbortSignal` for cooperative I/O abort                                           | Identity-based stale-result discard via `_inFlight !== result`; structural for async iterables (cleanup w/ `.return()`); no auto fetch abort                                                              |
| **Pending observability**           | `isPending` from `useTransition` (internally implemented as `useOptimistic`); also `useDeferredValue` for "show old value during prep" | Only via `<svelte:boundary>` + `$effect.pending()`; **no per-value `.loading` on async-derived**                                                             | `isPending(() => x())` opt-in at read site; pipeline-OR walks dep graph; also `latest()` for boundary-bypass reads                                                                                        |
| **Fallback display**                | Throttled at ≥300ms before showing; doesn't hide already-revealed content during transitions                                           | Offscreen `DocumentFragment` until `#pending_count == 0`; then swap                                                                                          | Per-`<Loading>` boundary; gather-on-commit                                                                                                                                                                |
| **Multi-step async composition**    | `await` inside Action body; multi-transition batched together (limit)                                                                  | `await` inside `$derived`; compiler tracks deps across await via `capture`/`save` (`await a + b` → `(await $.save(a))() + b`)                                | `action(function*) { yield … }` — the whole generator is one transition; plain writes commit once at completion, transition stays alive across `await`s                                                   |
| **Dependent dispatch capability**   | Await-only (`use(promise)` requires resolution; re-executes component on resolve)                                                      | Await-only with implicit ordering (sequential `$derived(await)` decls serialize; framework warns via `await_waterfall`)                                      | Await-only with generator batching                                                                                                                                                                        |
| **Entanglement detection**          | None (application models conflicts in user code, e.g. via `useOptimistic` revert-on-failure)                                           | Whole-batch granularity (per-microtask-of-writes); coarser than Solid                                                                                        | Per-write granularity (union-find merge of dep graphs); automatic detection by structural overlap                                                                                                         |
| **Compiler involvement**            | None (runtime-only)                                                                                                                    | Heavy: `experimental.async` flag; lowers `await` to `async_derived`/`flatten`/`save`; tracks deps across await                                               | None for reactivity (runtime-only); compiler-style binding for JSX only                                                                                                                                   |
| **Engine surface (rough)**          | Thousands of LOC: fiber reconciler + scheduler + Suspense machinery + Actions                                                          | ~800 lines for `batch.js` alone + boundary.js + async.js + deriveds.js                                                                                       | ~1300 lines: core.ts + scheduler.ts + lanes.ts + async.ts + boundaries.ts                                                                                                                                 |
| **User-facing API count**           | ~7+ hooks                                                                                                                              | 4 primitives                                                                                                                                                 | ~8 primitives                                                                                                                                                                                             |
| **Specific oddities worth knowing** | `useTransition`'s `isPending` is internally `useOptimistic`; Suspense fallback throttling                                              | `{#await}` blocks are anomalous re: runes machinery (may be retired); async-derived value lives in a normal `Source` cell — no `.loading` accessor by design | `<Reveal>` with `sequential`/`together`/`natural` modes; `_gatedSubs` replay-at-commit for cross-transaction reads; atomicity layers — per-transition (an action is one transition) / per-lane optimistic |

Three observations worth carrying forward:

1. **All three have radically different _user-facing_ surfaces** (7+ vs 4 vs 8 primitives), but the _engine_ sizes are within an order of magnitude. User-facing minimum is genuinely a choice independent of engine cost.
2. **Dim 3 is uniquely React's.** Both Svelte and Solid punt on input-priority entirely. If pulse wants to handle Dim 3, React is the only existing production reference point.
3. **Optimistic state is genuinely different across all three** — dedicated hook (React), no API + auto-revert via reject (Svelte), typed primitive tied to action lifecycle (Solid). None are the same shape; each is a position pulse could lean toward.

### Rollback strategies under shared visibility

The four-options framing (cascading discard / optimistic propagation / hard failure / phantom reads accepted) — see [concurrent-divergence.md](./concurrent-divergence.md#why-the-coupling-isnt-accidental) — applied to the three production frameworks:

| Framework | Shared visibility across concurrent transactions? | Rollback strategy |
| --- | --- | --- |
| React modern | No (private WIP trees per transition) | Per-action `useOptimistic` overlay; vanishes if parent doesn't update source |
| Solid 2.x | Yes (merged lanes via union-find) | Plain writes: no rollback (phantom reads accepted). Optimistic overlays: auto-revert unconditionally at transition commit |
| Svelte 5 | No (`fork()` isolates the batch; batch merge is supersession-style) | Drop the batch on discard; `OBSOLETE` silently swallows superseded async runs |

**Nobody offers true shared-visibility-with-independent-commit and clean rollback** because the semantics aren't recoverable — every choice has costs. React and Svelte sidestep the problem by refusing shared visibility; Solid accepts no-rollback-on-plain-writes and pushes users to express rollback intent via explicit overlay primitives.

Pulse's current choice (no shared visibility between concurrent transactions) matches React and Svelte. The within-action overlay ergonomics that Solid gets can be recovered in pulse as a library pattern (split signal value into committed + optimistic) without requiring engine-level shared visibility.

See [concurrent-divergence.md](./concurrent-divergence.md#solid--react--svelte-rollback-strategies) for the detailed mechanics of each framework's rollback path; the deep-dives ([solid-2x.md](../async/deep-dives/solid-2x.md), [react-modern.md](../async/deep-dives/react-modern.md), [svelte-5.md](../async/deep-dives/svelte-5.md)) for source-level evidence.

### Decomposition — seven underlying concerns

Looking at every mechanic in the comparison and asking _what problem is it
actually solving_, the mechanics cluster into seven underlying concerns:

- **A. Versioned reads** — read X as it currently is, OR as it was committed, OR as it appears under this in-flight scope. (WIP fiber tree, `batch_values`, `_overrideValue`, `latest()`, `useDeferredValue`, snapshot-isolation in MVCC.)
- **B. Pending propagation** — downstream computations learn that an upstream is in-flight. (`_pendingSource(s)`, `_asyncReporters`, `boundary.#pending_count`, pipeline-OR `isPending`.)
- **C. Atomic commit boundary** — these changes land together; nothing inside is visible until everything is ready. (`<Suspense>`, `<svelte:boundary>`, `<Loading>`, `Batch` commit, `Transition._actions`.)
- **D. Scoped writes** — writes belong to a named scope (action, fork, transition); the scope can be committed or discarded as a unit. (`OptimisticLane`, `useOptimistic`, `fork()`, `action(function*)`, Replicache mutators.)
- **E. In-flight identity** — when multiple runs of the same work exist, framework knows which is current. (`_inFlight !== result`, `OBSOLETE`, generation counters.)
- **F. Lifecycle / cleanup** — async work that's no longer relevant gets cleaned up. (Drop, `AbortController`, `cleanup()`, owner disposal.)
- **G. Priority** — some updates pre-empt others mid-flight. (React's 31-lane bitmask, uniquely.)

The high-level abstractions in the table are combinations of subsets of
{A, B, C, D, E, F, G}:

- `<Loading>` / `<Suspense>` / `<svelte:boundary>` = **B** + **C**
- `useOptimistic` / `createOptimistic` = **A** + **D** + **C**
- `useTransition` = **D** + **C** + **G**
- `action(function*)` = **D** + **C** + **E**
- `fork()` = **D** + **A** + **C**
- `<Reveal>` = composes multiple **C**s (coordination layer ABOVE boundaries)

None of these abstractions is a primitive in this decomposition. Each is
library code over a small subset of the seven concerns.

### Signal = node + value-bag (the sharper recasting)

The seven-concerns decomposition is roughly right but bundles two distinct
concerns under "scoped versioned state." A cleaner factoring: **a signal
isn't a single primitive — it's a (node identity, value-bag) pair.**
Currently every reactive framework conflates these into "a signal _is_ its
current value." Decoupling them is the underlying simplicity.

- **Node** = the stable identity in the reactive dep graph. Other nodes /
  subscribers depend on this identity. Owners hold it. Equality and
  reference-tracking are based on it.
- **Value-bag** = the multi-valued state the node currently has. Entries
  are tagged with (scope, version, status). The "current committed value"
  is one entry; the "in-flight pending value" is another; the
  "optimistic-scope overlay" is a third; the "snapshot-as-of-time-T" is a
  fourth.

Under this framing, the seven concerns recast as:

- **A (versioned reads)** = read a specific entry from the value-bag
- **B (pending propagation)** = entries carry pending-status; the dep graph propagates status across nodes
- **C (atomic commit boundary)** = the value-bag collapses from N entries to 1
- **D (scoped writes)** = writes contribute an entry to the value-bag, tagged with scope
- **E (in-flight identity)** = entries carry identity (or the scope that produced them does)
- **F (cleanup)** = entries can be removed from the bag
- **G (priority)** = about the _work producing entries_, not about entries themselves — the only outlier (work scheduling, not value-bag operation)

So **A–F are all operations on the value-bag of a node**. G is the one
genuine outlier. The deeper decomposition shrinks from "7 concerns + 4
primitives" to **three primitives**: (node identity) + (value-bag) +
(work scheduling).

### Empirical pattern — every studied framework does node/value-bag internally

Every framework implements the node/value-bag separation internally, but
none exposes it as the user-facing primitive:

- **Solid 2.x** — explicit per-node slots `_value` / `_pendingValue` /
  `_overrideValue` / `_snapshotValue`. Internally exposed; user-facing
  surface is `createOptimistic` / `createSignal` / `createMemo` as
  separate hooks.
- **Svelte 5** — `batch_values: Map<Value, [any, boolean]>` per batch.
  Internally; user-facing is `<svelte:boundary>` / `$derived` / `fork()`.
- **React modern** — WIP fiber vs current fiber. Same component identity,
  different value-states. Internally; user-facing is `useOptimistic` /
  `useTransition` / `useState`.
- **Replicache** — B-tree DAG with `main` / `sync` heads. Closest to
  exposing it (named heads are semi-public; most user code doesn't see
  them).
- **Postgres MVCC** — row identity stable; multiple tuple-versions per
  row, indexed by transaction. Internally exposed via `xmin`/`xmax`; not
  user-API.

The pattern is universal. None lets the user say "give me node N's
value-bag entry tagged with scope S" as a primitive. Instead they each
invent bespoke compositions (`useOptimistic`, `_overrideValue`,
`Batch.current.get(node)`) that are internally just value-bag-entry-with-
scope-S.

**Solid's transition-machinery trajectory** (verified against the git
history of `@solidjs/signals`): Solid moved from per-node `tValue` slot
(1.x) → external scheduler holding cloned subgraph (2.x early) → cloning
for transitions, overlay for optimistic (2.x mid) → per-node multi-slot
with no cloning anywhere (current). Strong empirical evidence: the
cloning approach was tried in production-grade 2.x development for ~2+
years and was abandoned commit-by-commit. The direction of Solid's
design — across both 1.x and 2.x — has been _toward making the value-bag
larger and more structured_, **and away from external-scheduler-managed
parallel structures**. Carniato's stated principle ("handle the
transition at the computed node level instead of as a scheduler from
outside") _is_ the move from a parallel cloned subgraph to per-node
value-bag.

If pulse adopts the node/value-bag framing as the user-facing primitive,
it would be _exposing what Solid arrived at internally_ as the API
surface — making explicit what Solid has been keeping implicit.

---

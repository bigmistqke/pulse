# Async Strategies — Research Log

A working research log on how programming has approached **async coordination**: cancellation, isolation, conflict resolution, optimistic UI, transactions, structured concurrency, effect handling. The goal is to inform pulse's API choices for transactions, actions, and the reactive/effect-layer boundary — but the research itself is broader than pulse, because the only way to make informed trade-offs is to understand the full design space.

## Framing

JavaScript doesn't provide the primitives most async-coordination traditions assume — **first-class continuations, native effect handlers, channels-as-language-primitives, actors-as-language-primitives, STM, linear types, capability typing**. Whatever model pulse ends up with is an **encoding** of one of those models into the tools JS does give us (Promises, generators, ambient mutable slots, owner trees, try/catch). Every encoding loses something the original had.

The research isn't "find the right model." It's:

> Understand each model deeply enough to know what we sacrifice when we encode it into JS, and which sacrifices we're willing to make for which use cases.

This is a slow research process. Time-box per session, not per-domain. Don't draw conclusions before the evidence supports them. Trade-offs are local; insights are cumulative.

---

## Taxonomy

A growing classification of systems along axes that meaningfully distinguish async-coordination strategies. New axes are added as deep-dives reveal them; new rows are added as we examine new systems. Cells that say "—" mean either the axis doesn't apply (e.g. isolation level for a system without explicit transactions) or we haven't yet researched it deeply enough to answer honestly.

**Axes (current set, expected to grow):**

1. **Where async state lives** — in the reactive graph (fused with reactivity), in a separate effect layer (Bonsai/Elm-style), in actors (Erlang/Akka), or as types in a pure language (Eff/Koka)
2. **Conflict-handling policy** — block-on-entanglement, retry-on-conflict, last-write-wins, never-occur-by-construction (CRDT), explicit-opt-in-entangle, snapshot-iso with write-skew tolerated
3. **Cancellation discipline** — none, cooperative-via-checkpoints, structural-by-scope, preemptive, lifecycle-event-driven
4. **Async representation to the programmer** — value (Promise / Effect.t / CML event), procedure, type (`Effect<R,E,A>`), continuation, channel/stream, mailbox
5. **Isolation level** (where applicable) — none, snapshot, serializable, linearizable, eventual
6. **Atomicity granularity** — per-operation, per-transaction, per-tick, per-frame, per-action
7. **Discipline location** — runtime-enforced, type-system-enforced, convention-only, capability-based
8. **Reactive integration** — fused (async lives in the reactive graph), separate effect layer, orthogonal (no reactivity at all), pure-derivation-only (no async)

### Initial table

Cells filled from prior conversational notes; treat these as DRAFT until a deep-dive verifies them. Many systems will have nuances the table flattens; deep-dives are where we capture those.

| System | Async state | Conflict policy | Cancellation | Async rep | Isolation | Atomicity | Discipline | Reactive integration |
|---|---|---|---|---|---|---|---|---|
| **pulse (current)** | fused (in reactive graph) | last-write-wins (no transactions) | cooperative via `NotReadyYet` throw + kick-on-settle | procedure (Promise) + opt-in marker (`use(x)`) | none | per-`<Loading>` boundary gather; per-microtask flush | convention-only | fused |
| **Solid 2.x** | fused | block-on-entanglement (via lanes) | (transitions cancel via runtime lane management) | procedure | snapshot via lanes | per-transition; per-microtask flush | runtime-enforced | fused |
| **effect-ts** | separate (Effect is its own world) | retry-on-conflict (STM) | structural-by-scope (Scope + interruption) | typed value (`Effect<R,E,A>`) | serializable (STM) | per-`Effect.gen` block | type-system-enforced | orthogonal (separate from reactive UI) |
| **Bonsai (Jane Street)** | separate effect layer | n/a (actions dispatched serially) | lifecycle-event (effect dispatch token) | typed value (`Effect.t`) | n/a | per-action | runtime-enforced | separate effect layer over incremental |
| **Erlang / OTP** | in actors | never-occur (no shared state) | preemptive (process kill) + structural (link / monitor) | message in mailbox | n/a (no shared state) | per-message | runtime-enforced | orthogonal |
| **Haskell GHC STM** | separate (`TVar` is its own world) | retry-on-conflict | n/a (transactions block on `retry`, no cancellation) | typed value (`STM a`) | serializable | per-`atomically` block | type-system-enforced (no IO in STM) | orthogonal |
| **Clojure refs + STM** | separate (`ref` is its own world) | retry-on-conflict (with `ensure` for explicit entangle, `commute` for commutative writes) | n/a | macro/expression (`dosync`) | serializable | per-`dosync` block | convention-only (with macro enforcement) | orthogonal |
| **Postgres MVCC (default SI)** | in tables (versioned rows) | snapshot-iso with write-skew tolerated; explicit `FOR UPDATE` for opt-in entangle | n/a | SQL statement | snapshot | per-transaction (BEGIN/COMMIT) | runtime-enforced | n/a (database) |
| **Postgres SSI** | in tables | retry-on-conflict (dependency-cycle detection) | n/a | SQL statement | serializable | per-transaction | runtime-enforced | n/a |
| **Concurrent ML (CML)** | n/a (no shared state assumed) | n/a | atomic-via-`choose`+`withNack` (negative-ack cleans up losing branches) | first-class event value | n/a | per-`sync` of an event | runtime-enforced | orthogonal |
| **Cap'n Proto / E language** | in distributed promises | n/a (single-writer per object) | lifecycle-event (cancel the cap) | first-class promise value (composable via pipelining) | n/a | per-RPC call | runtime-enforced | orthogonal |
| **Kotlin coroutines** | in coroutines | n/a (no shared async state) | structural-by-scope (`CoroutineScope` + `Job`) + cooperative checkpoints | suspend procedure | n/a | n/a | runtime + convention | typically separate (sometimes fused via `Flow`) |
| **Swift Structured Concurrency** | in actors | n/a (actor isolation prevents data races) | structural-by-scope (`TaskGroup`) + cooperative | async procedure / `async let` value | actor-isolated | n/a | type-system-enforced (`Sendable`) | usually separate |
| **GGPO (rollback netcode)** | in game-state snapshots | snapshot-replay-on-mismatch | per-frame (drop the predicted future) | command/input | snapshot | per-frame | runtime-enforced | n/a (game engine) |
| **ROS action servers** | in action goals | n/a | lifecycle-event (preempt) | typed lifecycle value (Goal/Feedback/Result) | n/a | per-action goal | runtime-enforced (state machine) | n/a (robotics) |
| **Yjs / Automerge (CRDTs)** | replicated CRDT | never-occur (CRDT merge always succeeds) | n/a | operation value | eventual | per-operation | runtime-enforced (CRDT semantics) | typically separate |
| **Redux + RTK Query** | separate (cache slice) | last-write-wins (cache invalidation) | lifecycle-event (`abortController` per query) | procedure (thunk / mutation) | none | per-action dispatch | convention-only | separate effect layer |
| **React `useEffect` + `useState`** | separate (effect runs outside render) | last-write-wins | structural via effect cleanup function | procedure | none | per-render | convention-only | separate (effects fire after render) |
| **RxJS** | in observable streams | depends on operator (`switchMap` = replace, `exhaustMap` = ignore, `concatMap` = queue, `mergeMap` = parallel) | lifecycle-event (`Subscription.unsubscribe`) | stream value | n/a | per-emission | convention-only | separate (streams compose; UI subscribes) |

(Table will widen as deep-dives reveal new axes; rows will grow as new systems are studied.)

### Open questions about the taxonomy itself

These are uncertainties about the *axes*, not the entries. Each one is a thread to chase:

- **Effect representation as a continuum, not a category.** The current axis lists value / procedure / type / continuation / channel / mailbox as distinct kinds, but several systems straddle (e.g. effect-ts's `Effect<R,E,A>` is "both typed AND a value"). Maybe this axis needs to split into 2-3 sub-axes (representation; type-tracking; composability).
- **"Atomicity per tick"** — does the per-tick choice fundamentally differ from per-microtask vs per-frame, or are they all instances of "discrete-time-step batching with framework-chosen step size"?
- **"Where async state lives" vs "Reactive integration"** — are these axes orthogonal or correlated? Most fused-reactive-integration systems have async state in the graph; most separate-effect-layer systems have it outside. But Bonsai-on-incremental is "separate effect layer over a reactive graph," which doesn't fit cleanly.
- **Discipline location** — is "type-system-enforced" really a single category, or does it split into "checked at compile time" vs "enforced via library types but not language rules"?
- **What's NOT on the taxonomy yet?** — distribution model (single-process / multi-process / multi-machine / multi-replica), failure model (crash-stop / crash-recover / Byzantine), real-time guarantees (none / soft / hard), determinism (none / per-tick / globally deterministic). These may or may not be relevant to pulse; the research will tell us.

---

## Session log (chronology)

### Session 1 — 2026-05-19 — Scaffolding + initial axes

- Set up the research directory: `docs/research/async/` with a deep-dives subdirectory.
- Drafted the framing — the constraint that "JS doesn't give us the primitives; everything is an encoding with trade-offs" is the central observation that shapes the rest.
- Extracted an initial 8 axes by reviewing every system touched in prior sessions (Solid 2.x analysis, scenarios doc's prior-art survey, Bonsai/incremental discussion, async-specific traditions discussion).
- Seeded the taxonomy table with 18 systems × 8 axes. Cells are draft until verified by deep-dives.
- Surfaced 5 open questions about the axes themselves (effect rep continuum, atomicity-granularity confusion, state-location vs reactive-integration correlation, discipline subcategories, missing dimensions like distribution / failure / real-time).
- Did NOT pick a first deep-dive. Reasoning: the axes themselves need at least one or two deep-dives to validate; jumping into specifics without confidence in the framework risks dead-end research. Next session should pick the first dive based on which axis is most ambiguous or which system is most foundational to multiple cells.

#### Threads to pick from for the next session

These are candidate first-deep-dives, roughly ordered by "how much they would refine the taxonomy itself":

- **Algebraic effects** (Koka / Eff / OCaml 5): not in the taxonomy as a system, but the framework all the others can be partially understood as encodings of. A deep-dive on the actual semantics of perform/handle/resume would clarify "what each system is approximating."
- **effect-ts**: heavy use of types + Effect.gen + STM. Would validate whether "typed value" and "type-system-enforced" are separate axes or one.
- **Bonsai + Jane Street Incremental**: the cleanest "separate effect layer over a reactive graph" example. Would help split "reactive integration" from "where async state lives."
- **Erlang/OTP**: the longest-running production async system. Would test whether our axes apply outside the JS-world assumptions.
- **CML**: first-class events with `choose` + `withNack`. Would test whether "async representation" is rich enough as a category.
- **Postgres MVCC + SSI**: the longest-living transaction implementation. Would test whether our "isolation level" categories are sufficient.

---

## Deep-dives

Each deep-dive lives in `deep-dives/<topic>.md`. Order is not predetermined; pick based on what the taxonomy reveals as ambiguous or unexplored. Use the deep-dive template (see `deep-dives/_template.md` once written) to keep them comparable.

Working list (will be checked off as completed):

- [ ] Algebraic effects + handlers (Eff / Koka / OCaml 5)
- [ ] effect-ts (STM, fibers, Scope, Effect.gen)
- [ ] Bonsai + Jane Street Incremental
- [ ] Erlang / OTP (gen_server / gen_statem / supervision)
- [ ] Concurrent ML — first-class events
- [ ] Cap'n Proto + E language — promise pipelining
- [ ] Postgres MVCC + Serializable Snapshot Isolation
- [ ] Haskell GHC STM
- [ ] Clojure refs + STM (`ensure` / `commute` distinction)
- [ ] Kotlin coroutines / Swift Structured Concurrency / Trio (structured concurrency family)
- [ ] GGPO + fighting-game rollback netcode
- [ ] Yjs + Automerge (CRDT lineage) + Replicache
- [ ] Solid 2.x lanes + entanglement (we have notes; deepen)
- [ ] RxJS concurrency operators
- [ ] Bevy ECS Commands + sync points
- [ ] Sagas + event sourcing + outbox pattern
- [ ] ROS action servers
- [ ] io_uring + completion-based async (Linux / Windows IOCP)
- [ ] Synchronous reactive languages — Esterel / Lustre / SCADE
- [ ] Distributed consensus (Paxos / Raft / EPaxos) — likely brief; mostly relevant for failure-model vocabulary
- [ ] SwiftUI + Combine / Jetpack Compose + Flow — UI framework comparisons

---

## See also

- `../scenarios/concurrent-flows.md` — the scenario / policy-question / pain-point doc that motivates this research. Scenarios S1–S8 there are the **acceptance tests** any candidate async strategy needs to address. Policy questions Q1–Q5 are the **decision points** the research informs.
- `../superpowers/specs/2026-05-17-pulse-transitions-redesign.md` — the design history that led to pulse's current async surface (Plans A/B/C).
- `../../README.md` (root) — comparative analysis against Solid 2.x; should be revisited and revised as the research matures.
- `../../CONTEXT.md` — conceptual model and theoretical lineage; the new "Conceptual model" section is the framing we'll deepen.

---

## Working glossary

Terms used loosely in conversation; precise definitions belong in deep-dives. Tracked here so we don't drift.

- **Encoding** — a JS implementation that approximates a primitive from another language/system. Always lossy.
- **Reactive integration** (axis) — whether async work is part of the reactive computation graph or runs alongside it.
- **Discipline location** (axis) — where the rules are enforced: runtime, type system, programmer convention, or capability system.
- **Scenario** — a concrete user/dev situation that any async strategy needs to handle correctly. See `../scenarios/concurrent-flows.md`.
- **Policy question** — a design decision a transaction primitive needs to answer explicitly. See same.

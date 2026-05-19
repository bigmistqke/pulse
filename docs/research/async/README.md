# Async Strategies — Research Log

A working research log on how programming has approached **async coordination**: cancellation, isolation, conflict resolution, optimistic UI, transactions, structured concurrency, effect handling. The goal is to inform pulse's API choices for transactions, actions, and the reactive/effect-layer boundary — but the research itself is broader than pulse, because the only way to make informed trade-offs is to understand the full design space.

> **Process conventions for this research live in [`CONTEXT.md`](./CONTEXT.md).** Read it before contributing — it covers sourcing discipline, status-indicator rules, when axes can be added, what each deep-dive should contain, and the anti-patterns we've already learned to avoid.

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

Each row is one async-coordination strategy that competes in pulse-adjacent design space. Cells are not equal in confidence — see status column:

- 🟢 **verified** — a deep-dive doc exists and cells reflect what it found.
- 🟡 **draft** — populated from prior conversational notes / synthesis from memory. Needs a deep-dive to verify.
- ⚪ **pending** — row exists as inventory marker; minimal characterization only. Cells will fill in as deep-dives happen.

Systems that DON'T belong in this table (mechanisms, theoretical concepts, different problem domains) but still warrant deep-dives appear in the "Cross-domain deep-dives" section below. Don't conflate "not in the table" with "not researched."

| Status | System | Async state | Conflict policy | Cancellation | Async rep | Isolation | Atomicity | Discipline | Reactive integration |
|---|---|---|---|---|---|---|---|---|---|
| 🟡 | **pulse (current)** | fused (in reactive graph) | last-write-wins (no transactions) | cooperative via `NotReadyYet` throw + kick-on-settle | procedure (Promise) + opt-in marker (`use(x)`) | none | per-`<Loading>` boundary gather; per-microtask flush | convention-only | fused |
| 🟡 | **Solid 2.x** | fused | block-on-entanglement (via lanes) | transitions cancel via runtime lane management | procedure | snapshot via lanes | per-transition; per-microtask flush | runtime-enforced | fused |
| 🟡 | **React modern** (Suspense / transitions / lanes / `use()` / `useOptimistic`) | fused (suspended boundaries + WIP fiber trees in reconciler) | lane-based prioritization (high-priority pre-empts WIP); concurrent WIP, commit when ready | structural — WIP discarded if higher-priority arrives | thrown Promise + `use(promise\|context)` + `startTransition` + `useOptimistic` | snapshot-ish (current tree mounted while WIP renders) | per-commit (WIP commits atomically once Suspense resolves) | runtime-enforced (fiber reconciler) | fused |
| 🟢 | **effect-ts** ([dive](./deep-dives/effect-ts.md)) | separate (Effect is its own world; TRef for STM state) | retry-on-conflict (STM); structured interruption for non-STM | structural-by-scope (Scope + asynchronous interruption); finalizers always run | typed value (`Effect<A, E, R>`); parallel `STM<A, E, R>` | serializable (STM); n/a outside STM | per-`STM.commit` block (STM); per-`Effect.gen` (syntactic, not atomic across forks) | type-system-enforced | orthogonal |
| 🟢 | **Bonsai (Jane Street)** ([dive](./deep-dives/bonsai-incremental.md)) | separate effect layer (over Incremental); model state in components | last-write-wins via action-dispatch order (Elm reducer discipline) | structural-by-component-lifetime; effects can outlive originator (acknowledged footgun, `Bonsai.peek` workaround) | typed value (`Effect.t`); monadic composition via `let%bind.Effect` | n/a (no transactions) | per-action (single `apply_action` call); Incremental stabilizes after each action | runtime-enforced + convention | separate effect layer over a synchronous reactive graph (Incremental) |
| 🟡 | **Erlang / OTP** | in actors | never-occur (no shared state) | preemptive (process kill) + structural (link / monitor) | message in mailbox | n/a | per-message | runtime-enforced | orthogonal |
| 🟡 | **Haskell GHC STM** | separate (`TVar` is its own world) | retry-on-conflict | block-on-retry (no cancellation in STM proper) | typed value (`STM a`) | serializable | per-`atomically` block | type-system-enforced (no IO in STM) | orthogonal |
| 🟡 | **Clojure refs + STM** | separate (`ref` is its own world) | retry-on-conflict (with `ensure`, `commute`) | n/a | macro (`dosync`) | serializable | per-`dosync` block | convention + macro enforcement | orthogonal |
| 🟡 | **Postgres MVCC (default SI)** | in tables (versioned rows) | snapshot-iso, write-skew tolerated; explicit `FOR UPDATE` for opt-in entangle | n/a | SQL statement | snapshot | per-transaction (BEGIN/COMMIT) | runtime-enforced | n/a |
| 🟡 | **Postgres SSI** | in tables | retry-on-conflict (dependency-cycle detection) | n/a | SQL statement | serializable | per-transaction | runtime-enforced | n/a |
| 🟡 | **Concurrent ML (CML)** | n/a (no shared state assumed) | n/a | atomic via `choose`+`withNack` | first-class event value | n/a | per-`sync` of an event | runtime-enforced | orthogonal |
| 🟡 | **Cap'n Proto / E language** | in distributed promises | n/a (single-writer per object) | lifecycle-event (cancel the cap) | first-class promise value (composable via pipelining) | n/a | per-RPC call | runtime-enforced | orthogonal |
| 🟡 | **Kotlin coroutines** | in coroutines | n/a | structural-by-scope (`CoroutineScope` + `Job`) + cooperative checkpoints | suspend procedure | n/a | n/a | runtime + convention | typically separate; fused via `StateFlow` / `collectAsState` in Compose |
| 🟡 | **Swift Structured Concurrency** | in actors | n/a (actor isolation prevents races) | structural-by-scope (`TaskGroup`) + cooperative | async procedure / `async let` value | actor-isolated | n/a | type-system-enforced (`Sendable`) | usually separate |
| 🟡 | **GGPO (rollback netcode)** | in game-state snapshots | snapshot-replay-on-mismatch | per-frame (drop predicted future) | command/input value | snapshot | per-frame | runtime-enforced | n/a |
| 🟡 | **ROS action servers** | in action goals | n/a | lifecycle-event (preempt) | typed lifecycle value (Goal/Feedback/Result) | n/a | per-action goal | runtime-enforced (state machine) | n/a |
| 🟡 | **Yjs / Automerge (CRDTs)** | replicated CRDT | never-occur (CRDT merge always succeeds) | n/a | operation value | eventual | per-operation | runtime-enforced (CRDT semantics) | typically separate |
| 🟡 | **Redux + RTK Query** | separate (cache slice) | last-write-wins (cache invalidation) | lifecycle-event (`abortController`) | procedure (thunk / mutation) | none | per-action dispatch | convention-only | separate effect layer |
| 🟡 | **RxJS** | in observable streams | per-operator (`switchMap` = replace, `exhaustMap` = ignore, `concatMap` = queue, `mergeMap` = parallel) | lifecycle-event (`Subscription.unsubscribe`) | stream value | n/a | per-emission | convention-only | separate |
| ⚪ | **MobX** (`transaction` / `runInAction`) | fused | last-write-wins; batched | n/a | procedure | none | per-`runInAction` batch | convention-only | fused |
| ⚪ | **Recoil** (atoms + snapshots) | fused | last-write-wins | n/a | atom value | snapshot-capture (explicit) | — | runtime-enforced | fused |
| ⚪ | **Jotai** (atomic suspense, `loadable`) | fused | last-write-wins | n/a | atom value; suspending atoms | none | per-atom | convention-only | fused |
| ⚪ | **Zustand** | separate | last-write-wins | n/a | procedure | none | per-`set` call | convention-only | fused (via subscribe) |
| ⚪ | **Valtio** (proxy + `snapshot`) | fused | last-write-wins | n/a | proxy mutation | snapshot-capture (explicit) | — | convention-only | fused |
| ⚪ | **SWR / TanStack Query** | separate (cache) | last-write-wins; rich pending taxonomy (`isLoading`/`isFetching`/`isRefetching`) | lifecycle-event | procedure (queryFn) | none | per-query | convention-only | separate effect layer |
| ⚪ | **Apollo Client** | separate (normalized cache) | last-write-wins; ID-based reconciliation | lifecycle-event | procedure | none | per-mutation | convention-only | separate effect layer |
| ⚪ | **Trio** (Python) | in tasks | n/a | structural-by-scope (`nursery`) + cooperative checkpoints | suspend procedure | n/a | n/a | runtime-enforced | n/a |
| ⚪ | **Go context.Context** | in goroutines + channels | n/a | convention-driven (pass ctx everywhere) + cooperative checkpoint | procedure + ctx value | n/a | n/a | convention-only | orthogonal |
| ⚪ | **Rust / Tokio** | in futures | n/a | cancel-on-drop (RAII) + `CancellationToken` | future value | n/a | n/a | type-system-enforced (Send/Sync) | orthogonal |
| ⚪ | **F# async workflows** | in workflows | n/a | structural via cancellation tokens | computation expression value | n/a | n/a | convention + runtime | orthogonal |
| ⚪ | **Akka** (JVM actors) | in actors | never-occur (actor-isolated state) | preemptive (PoisonPill / Stop) + structural (supervision) | message value | actor-isolated | per-message | runtime-enforced | orthogonal |
| ⚪ | **Pony** (capability-typed actors) | in actors | never-occur | structural (actor lifecycle) | message value | actor-isolated | per-message | type-system-enforced (capabilities) | orthogonal |
| ⚪ | **Bevy Commands** (ECS) | in command queue | last-write-wins | none (no in-flight async at this layer) | typed command value | snapshot-ish (queue applied at sync point) | per-sync-point | runtime-enforced | n/a |
| ⚪ | **Unity DOTS ECB** | in command buffer | last-write-wins | none | typed command | snapshot-ish | per-sync-point | runtime-enforced | n/a |
| ⚪ | **Algebraic effect languages** (Eff / Koka / OCaml 5) | in handler context | depends on handler | structural (handler scope) | first-class effect value + handler | varies | varies | type-system-enforced (effect rows) | varies (orthogonal in base; fusable) |
| ⚪ | **SwiftUI + Combine + `@Observable`** | fused (`@Published` props) | last-write-wins | `.task(id:)` cancels on id change | suspend procedure / publisher | none | per-publish | runtime-enforced | fused |
| ⚪ | **Jetpack Compose + StateFlow + LaunchedEffect** | fused (StateFlow) | last-write-wins | `LaunchedEffect(key)` cancels on key change | suspend procedure / Flow | none | per-emit | runtime-enforced | fused |
| ⚪ | **Vue 3** (refs + `<Suspense>` + async `setup`) | fused | last-write-wins | structural (Suspense unmount) | procedure / async setup | none | per-flush (microtask) | runtime-enforced | fused |
| ⚪ | **Svelte 5 runes** | fused (compiler-driven) | last-write-wins | n/a (no built-in transactions yet) | procedure | none | per-tick | compiler + runtime | fused |
| ⚪ | **Phoenix LiveView** | separate (server-side state) | last-write-wins; server-authoritative | structural (connection lifetime) | server message | n/a | per-server-roundtrip | runtime-enforced | n/a (server-driven) |
| ⚪ | **HTMX / Hotwire** | separate (server-side state) | last-write-wins | none (HTTP request lifetime) | HTTP response | n/a | per-request | convention-only | n/a (server-driven) |
| ⚪ | **Temporal / Cadence** (durable workflows) | in durable workflow execution | per-workflow logic (compensation) | preemptive (workflow cancel) + saga compensation | workflow value | durable persisted | per-workflow | runtime-enforced | orthogonal |
| ⚪ | **Replicache / Rocicorp Zero** | separate (client cache + mutation queue) | replay-mutation-queue on server-state change | lifecycle (mutation pending → settled) | typed mutation = (optimistic-fn, server-fn) pair | snapshot-ish (per-replay) | per-mutation | runtime-enforced | separate |
| ⚪ | **Linear sync architecture** | separate (in-memory DB + deltas) | server-authoritative reconciliation | lifecycle | typed delta | snapshot-ish | per-delta-batch | runtime-enforced | separate |
| ⚪ | **Figma multiplayer (OT)** | server-authoritative (OT) | OT transformation | lifecycle | typed op | n/a | per-op | runtime-enforced | separate |
| ⚪ | **io_uring / IOCP / kqueue** | in completion ring | n/a | lifecycle (submit cancel op) | submission entry (SQE/CQE) | n/a | per-completion | runtime-enforced | n/a (OS-level) |
| ⚪ | **Esterel / Lustre / SCADE** | in synchronous reaction | n/a (deterministic per instant) | n/a | signal / event | n/a (deterministic per instant) | per-logical-instant | runtime + compiler | fused (entire language is synchronous reactive) |
| ⚪ | **Spreadsheets** (Excel / VisiCalc) | in cells | last-write-wins | n/a | formula | none | per-recalc | runtime-enforced | fused |
| ⚪ | **Sagas** (orchestrated long-running tx) | in saga state | compensation on partial failure | structural (saga abort) | step + compensating action pair | n/a (compensation not isolation) | per-saga | convention/framework | orthogonal |
| ⚪ | **Event sourcing + CQRS + outbox** | append-only event log | last-write-wins on commands; projections rebuild | n/a | typed event | n/a (eventually consistent projections) | per-event-batch | runtime-enforced | separate (read-model is reactive over events) |
| ⚪ | **Free monads / tagless final** (Haskell / Scala) | in interpreter | depends on interpreter | depends on interpreter | typed effect ADT or type-class call | varies | varies | type-system-enforced | orthogonal |
| ⚪ | **Iteratees / Conduits / Pipes** (Haskell) | in stream | n/a | structural (stream completion) | typed stream value with backpressure | n/a | per-element | type-system-enforced | orthogonal |
| ⚪ | **Game lockstep simulation** (RTS) | in deterministic sim state | n/a (everyone runs same sim) | n/a | input value (sent over wire) | n/a (deterministic) | per-tick | runtime-enforced | n/a |
| ⚪ | **VCS** (Git / Pijul / Darcs) | branches as snapshots | merge / patch theory | n/a (rebase / revert) | commit / patch value | snapshot per branch | per-commit | convention + tooling | n/a |

(Table will widen as deep-dives reveal new axes; rows will continue to grow as new systems are studied. Status indicators show which cells are reliable.)

### Open questions about the taxonomy itself

These are uncertainties about the *axes*, not the entries. Each one is a thread to chase:

- **Effect representation as a continuum, not a category.** The current axis lists value / procedure / type / continuation / channel / mailbox as distinct kinds, but several systems straddle (e.g. effect-ts's `Effect<R,E,A>` is "both typed AND a value"). Maybe this axis needs to split into 2-3 sub-axes (representation; type-tracking; composability).
- **"Atomicity per tick"** — does the per-tick choice fundamentally differ from per-microtask vs per-frame, or are they all instances of "discrete-time-step batching with framework-chosen step size"?
- ~~**"Where async state lives" vs "Reactive integration"** — are these axes orthogonal or correlated?~~ **Resolved (session 4, Bonsai dive):** they are distinct. Bonsai is the proof — its reactive integration is the substrate (Incremental), but async state lives outside that graph in the `Effect.t` layer. Pulse / Solid 2.x are (fused-reactive, in-graph); Bonsai / Redux are (separate-layer, in-effects); effect-ts is (orthogonal, in-effects); Excel is (fused, no-async). The two axes are orthogonal; keep them separate. See [`bonsai-incremental.md`](./deep-dives/bonsai-incremental.md) "Open questions resolved."
- **Discipline location** — is "type-system-enforced" really a single category, or does it split into "checked at compile time" vs "enforced via library types but not language rules"?
- **What's NOT on the taxonomy yet?** — distribution model (single-process / multi-process / multi-machine / multi-replica), failure model (crash-stop / crash-recover / Byzantine), real-time guarantees (none / soft / hard), determinism (none / per-tick / globally deterministic). These may or may not be relevant to pulse; the research will tell us.
- **"Work-in-progress tree" as a primitive.** React's modern async story renders a parallel work-in-progress fiber tree for transitions, committing it atomically only when ready. Conceptually similar to MVCC's "the in-progress transaction has its own visible-only-to-itself state" or GGPO's "speculative-state-to-be-validated" but applied to UI rendering. Worth deciding whether this is a separate axis ("speculative WIP vs. direct mutation") or a special case of atomicity granularity. Likely a deep-dive on React's reconciler will clarify.
- **"Discipline location" may need sub-axes.** effect-ts deep-dive (session 2) revealed two distinct mechanisms both classified as "type-system-enforced": (a) structural typing of effect signatures via type parameters (`E`, `R` in `Effect<A, E, R>`), and (b) vocabulary restriction within a namespace (STM combinators don't expose IO-shaped ops, so purity is enforced by what's *not exposed*). These are different kinds of enforcement; might warrant splitting the axis.
- **"Async state lives" might need a value for "runtime-interpreted lazy description."** effect-ts's `Effect<A, E, R>` isn't really "in a graph" (no reactive integration) or "in actors" or "in tables" — it's *interpreted state* of a lazy description by the runtime. The current value "separate" flattens this. Consider a "runtime-interpreted" value if more systems exhibit this pattern (free monads, tagless final, OCaml 5 effect handlers all might).
- **Is "purity precondition" a missing axis?** effect-ts STM forbids IO inside transactions (so retry is safe). Haskell STM, Clojure STM, Bevy Commands all share this. Sagas don't. Reactive computeds in pulse/Solid don't formally require it but in practice they should be replayable. Worth tracking whether a system requires its async units to be pure for safe retry/replay.
- **Atomicity granularity for systems with TWO atomicity layers.** effect-ts has STM-level (per-commit) AND fiber-level scope-bounded (per-scope) atomicity, for different concerns (data consistency vs resource lifecycle). A single cell value flattens this. Session 3's algebraic-effects dive confirmed: atomicity granularity is best understood **per-handler, not per-system** — multi-handler systems have multiple atomicity boundaries by design. Consider whether the axis should split into "data-atomicity" and "lifecycle-atomicity," or be reformulated as "per-handler atomicity" (a row of values, one per handler kind).
- **Async representation as a spectrum, not a category.** Session 3 sharpened: the current values (procedure / value / type / continuation / channel / mailbox) are best understood as a spectrum of "how first-class the captured effectful work is" — from procedure (not first-class) to value (first-class but interpreted) to continuation (first-class with multi-shot capability). Cells should be read in this light; documenting this in the axis definition would clarify.
- **NEW axis candidate: continuation cardinality.** Surfaced by the algebraic-effects dive. Values: 0-shot (exceptions); 1-shot (async/await, generators, effect-ts, pulse within-stage); multi-shot at coarse granularity (pulse across stages, incremental graphs); multi-shot fine (Eff, Koka, Haskell `MonadCont`); runtime-enforced 1-shot (OCaml 5 deliberately forbids multi-shot). Structurally distinguishes systems in a way current axes flatten. **Don't add yet — wait for one or two more dives to confirm it meaningfully distinguishes systems beyond what existing axes already track.**
- **Is multi-shot resumption useful for UI?** Most algebraic-effects "killer apps" (nondeterminism, backtracking, parser combinators, cooperative threading) aren't UI patterns. Speculative rendering, preview/what-if mode (S8), and time-travel state restoration might be the only places multi-shot would help. Worth checking deliberately during scenario reviews — would adopting multi-shot capable encodings buy us anything pulse would actually use?

---

## Session log

The session log (chronology, threads, mid-session corrections, lessons) lives in [`./LOG.md`](./LOG.md). Append entries there; do not log into this README.

---

## Deep-dives

Each deep-dive lives in `deep-dives/<topic>.md`. Order is not predetermined; pick based on what the taxonomy reveals as ambiguous, what's most foundational, or what threads of the current session demanded follow-up. Use the deep-dive template (see `deep-dives/_template.md` once written) to keep them comparable.

The list is split by purpose: **primary** deep-dives are on systems that appear as rows in the taxonomy table (verifying or revising the draft cells); **cross-domain** deep-dives are on systems / mechanisms outside the taxonomy that have transferable insights; **concept** deep-dives are on theoretical frameworks that affect how we interpret everything else.

### Primary deep-dives (systems in the taxonomy)

These promote a row from 🟡 / ⚪ to 🟢 (verified) by checking the table cells against primary sources.

- [ ] **Algebraic effects + handlers** (Eff / Koka / OCaml 5) — the theoretical baseline; every other system is partially understandable as an encoding of this
- [ ] **effect-ts** (STM, fibers, Scope, Effect.gen)
- [x] **Bonsai + Jane Street Incremental** ([dive](./deep-dives/bonsai-incremental.md), session 4) — "separate effect layer over reactive graph"; resolved the reactive-integration vs where-async-state-lives orthogonality question
- [ ] **Erlang / OTP** (gen_server / gen_statem / supervision)
- [ ] **Concurrent ML** — first-class events with `choose` / `withNack`
- [ ] **Cap'n Proto + E language** — promise pipelining
- [ ] **Postgres MVCC + Serializable Snapshot Isolation** — longest-running production transaction implementation
- [ ] **Haskell GHC STM**
- [ ] **Clojure refs + STM** (`ensure` / `commute` distinction)
- [ ] **Kotlin coroutines / Swift Structured Concurrency / Trio** (structured concurrency family — comparable enough to fold into one dive)
- [ ] **Go context + Rust/Tokio cancellation** (cancellation discipline)
- [ ] **GGPO + fighting-game rollback netcode**
- [ ] **Yjs + Automerge (CRDT lineage) + Replicache** (production sync engine)
- [ ] **Solid 2.x lanes + entanglement** (we have notes; deepen)
- [ ] **React modern async** — fiber reconciler lanes + Suspense + transitions + `use()` + `useOptimistic` + work-in-progress trees. Deliberately NOT framed as "useEffect + useState"; the actual primitive is the lane-based concurrent reconciler.
- [ ] **RxJS concurrency operators** — `switchMap` / `exhaustMap` / `concatMap` / `mergeMap` as named policies
- [ ] **Bevy ECS Commands + sync points**
- [ ] **Sagas + event sourcing + outbox pattern**
- [ ] **ROS action servers** — structured async lifecycle (Goal/Feedback/Result/Preempt)
- [ ] **io_uring + completion-based async** (Linux / Windows IOCP / BSD kqueue)
- [ ] **Synchronous reactive languages** — Esterel / Lustre / SCADE
- [ ] **SwiftUI + Combine + `@Observable`** and **Jetpack Compose + StateFlow + LaunchedEffect** (UI-framework comparisons; can be one dive comparing both)
- [ ] **Vue 3 Composition API + `<Suspense>`** + **Svelte 5 runes** (another comparison dive)
- [ ] **UI state libraries** (MobX / Recoil / Jotai / Zustand / Valtio) — likely one dive comparing all, since they're at the same conceptual level
- [ ] **SWR / TanStack Query + Apollo Client** — server-state caching layer
- [ ] **Akka + Pony** — actor model variants beyond Erlang
- [ ] **Temporal / Cadence / Restate** — durable workflows
- [ ] **Phoenix LiveView + HTMX/Hotwire** — server-driven async (different philosophy)
- [ ] **Free monads / tagless final** (Haskell / Scala) — alternative effect representation
- [ ] **Iteratees / Conduits / Pipes** — streaming with backpressure
- [ ] **Game lockstep simulation** (RTS) — deterministic simulation as alternative to rollback
- [ ] **VCS as snapshot isolation** (Git / Pijul / Darcs) — "patch theory" as merge model

### Cross-domain deep-dives (NOT in the taxonomy, but transferable lessons)

These don't compete in pulse's design space — they're mechanisms, primitives, or solutions to different problems — but their solutions have direct transferable lessons.

- [ ] **OS process isolation + copy-on-write fork** — snapshot isolation at the kernel level; cheapest possible "overlay where you wrote, share where you didn't"
- [ ] **OS RCU (Read-Copy-Update)** — lock-free reads + serialized writers; the Linux kernel's high-read low-write strategy
- [ ] **Build systems** (Bazel / Nix / Shake / Tup) — incremental computation at scale; content-addressed dependency tracking; distributed remote execution
- [ ] **Distributed databases — production cross-replica SI** (Spanner / CockroachDB / FoundationDB / Calvin) — TrueTime, hybrid logical clocks, deterministic ordering
- [ ] **Spark RDD lineage** — DAG of pure transformations with replay-on-failure; "the lineage is the source of truth"
- [ ] **Spreadsheets** (Excel / VisiCalc / Lotus 1-2-3) — the OG reactive system; 40+ years of production engineering on dep-graph recalc, volatile vs static, iterative modes, multi-threaded calc engines
- [ ] **Distributed consensus** (Paxos / Raft / EPaxos / Byzantine) — probably brief; mostly for vocabulary (quorum, term/epoch numbers, log replication as source of truth). Pulse is single-process so consensus itself isn't directly relevant
- [ ] **2-phase locking (2PL) vs Optimistic Concurrency Control vs MVCC** — the database concurrency-control taxonomy; could be folded into Postgres dive
- [ ] **Vector clocks / Lamport timestamps / hybrid logical clocks** — causality tracking; matters if pulse ever does collaborative editing
- [ ] **Telephony state machines** (SS7 / SIP / RFC 3261) — multi-step async with timeouts and retries; the design discipline that led to Erlang
- [ ] **Hardware transactional memory** (Intel TSX) — what STM looks like with silicon support; instructive about cost/benefit at the limit
- [ ] **Out-of-order CPU execution + speculative execution + reorder buffer** — speculation-and-rollback at the silicon level; conceptually identical to fighting-game rollback netcode at vastly different scale
- [ ] **File system journaling + copy-on-write FS** (ext4 journal / ZFS / btrfs) — durable atomicity for filesystem operations
- [ ] **Network protocols with delivery guarantees** (TCP retransmission / MQTT QoS / Kafka exactly-once) — async coordination with explicit failure models
- [ ] **Real-time audio scheduling** (sample-accurate DAWs / Web Audio API) — async with hard deadlines and determinism
- [ ] **NSOperationQueue / Grand Central Dispatch** (Cocoa / Darwin) — block-based concurrency with QoS classes + dependencies + cancellation
- [ ] **Java CompletableFuture** — composable async results in the JVM; comparable to TS Promise but with richer composition
- [ ] **Linda tuple spaces** + **Erlang mnesia** — coordination via shared tuple space / distributed transactional database; alternative concurrency primitives worth knowing for vocabulary
- [ ] **ElectricSQL / PowerSync** — production local-first SQL sync engines; comparable to Replicache but database-shaped

### Concept deep-dives (theoretical frameworks)

These aren't systems but frameworks for thinking about systems. Each one changes how we interpret everything else.

- [x] **Algebraic effects + handlers — the theory** (Plotkin & Pretnar, Bauer, Pretnar, Lindley) — see [`deep-dives/algebraic-effects.md`](./deep-dives/algebraic-effects.md). Done session 3. Formalized perform/handle/resume; documented multi-shot resumption as the headline distinguishing feature; mapped formal constructs to effect-ts and pulse; sharpened the "discipline location," "atomicity granularity," and "async representation" axes; surfaced "continuation cardinality" as a candidate axis (not yet added).
- [ ] **Delimited continuations** (Felleisen, Sitaram, et al) — the substrate algebraic effects sit on; how generators and async/await relate; what JS is missing
- [ ] **CSP / π-calculus / CCS** — formal models of communicating concurrent processes; what Go channels and Erlang messages descend from
- [ ] **Petri nets** — formal model of concurrent state transitions; reachability analysis
- [ ] **Linear types / affine types / capability typing** (Rust, Idris, Granule, Scala caps, Pony) — static enforcement of resource lifecycle; what "you can't forget to commit/abort a transaction" looks like in the type system
- [ ] **Session types** — types for protocols (Honda et al); could inform a typed `action()` lifecycle
- [ ] **Self-adjusting computation** (Umut Acar) — the theory r3 / incremental sit on; "change propagation through derivative-like computations"
- [ ] **Free monads + tagless final** — pure-functional encodings of "effects as values, interpreter chosen separately"; could be a primary OR concept dive depending on how we treat it

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

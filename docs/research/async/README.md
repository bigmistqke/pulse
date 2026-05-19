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
2. **Conflict-handling policy** — refined through sessions 4–8 to a richer value set: *last-write-wins* (no machinery, just overwrite); *STM retry-on-conflict* (effect-ts, Haskell, Clojure); *CRDT merge* (never-occur-by-construction; Yjs, Automerge); *actor isolation* (never-occur-via-no-shared-state; Erlang, Akka); *snapshot-iso with write-skew tolerated* (MVCC default); *priority-pre-empt-with-restart* (React modern lanes); *lane-merge on dependency-graph overlap* (Solid 2.x union-find); *server-linearized re-execution* (Replicache); *OT transformation* (Figma); *per-operator dispatch policy* (RxJS switchMap/mergeMap/etc).
3. **Cancellation discipline** — none, cooperative-via-checkpoints, structural-by-scope, preemptive, lifecycle-event-driven
4. **Async representation to the programmer** — value (Promise / Effect.t / CML event), procedure, type (`Effect<R,E,A>`), continuation, channel/stream, mailbox
5. **Isolation level** (where applicable) — none, snapshot, serializable, linearizable, eventual
6. **Atomicity granularity** — per-operation, per-transaction, per-tick, per-frame, per-action
7. **Discipline location** — runtime-enforced, type-system-enforced, convention-only, capability-based
8. **Reactive integration** — fused (async lives in the reactive graph), separate effect layer, orthogonal (no reactivity at all), pure-derivation-only (no async)
9. **Speculative-state isolation** (added session 9, promoted from candidate). Distinct from isolation level. Asks "is there an isolated parallel state being built that's invisible until commit, that can be discarded mid-build?" Values: *none* (direct mutation); *per-action overlay* (explicit user-managed parallel state — `useOptimistic`, Recoil snapshot); *per-write-lane overlay with overlap-merge* (Solid 2.x); *per-transition tree* (React WIP fiber, pulse `<Loading>` gather); *versioned engine, fixed-cardinality observable branches* (Replicache main+sync heads); *versioned everywhere* (full MVCC — Postgres, Yjs, event sourcing).
10. **Dependent-dispatch capability** (added session 9, promoted from candidate). Distinct from atomicity granularity. Asks "can dependent operations be dispatched before their prerequisites resolve?" Values: *await-only* (JS Promise, React `use(promise)` — each step needs resolution); *await-only with implicit-ordering* (Replicache mutation log — sequence is the dependency structure; no value-level dataflow on the wire); *await-only with generator-batching* (Solid 2.x `action()`, Bonsai `let%bind.Effect`, effect-ts `Effect.gen` — yields describe a script that runs as one transaction, but each step still awaits before the next); *pipelined* (Cap'n Proto, Agoric `E()` — method invocation on unresolved promise dispatches eagerly); *pipelined+typed-from-schema* (Cap'n Proto with IDL — pipelined dispatch with statically-known interface types).

### Initial table

Each row is one async-coordination strategy that competes in pulse-adjacent design space. Cells are not equal in confidence — see status column:

- 🟢 **verified** — a deep-dive doc exists and cells reflect what it found.
- 🟡 **draft** — populated from prior conversational notes / synthesis from memory. Needs a deep-dive to verify.
- ⚪ **pending** — row exists as inventory marker; minimal characterization only. Cells will fill in as deep-dives happen.

Systems that DON'T belong in this table (mechanisms, theoretical concepts, different problem domains) but still warrant deep-dives appear in the "Cross-domain deep-dives" section below. Don't conflate "not in the table" with "not researched."

| Status | System | Async state | Conflict policy | Cancellation | Async rep | Isolation | Atomicity | Discipline | Reactive integration |
|---|---|---|---|---|---|---|---|---|---|
| 🟡 | **pulse (current)** | fused (in reactive graph) | last-write-wins (no transactions) | cooperative via `NotReadyYet` throw + kick-on-settle | procedure (Promise) + opt-in marker (`use(x)`) | none | per-`<Loading>` boundary gather; per-microtask flush | convention-only | fused |
| 🟢 | **Solid 2.x** (`@solidjs/signals` 2.0.0-beta.13) ([dive](./deep-dives/solid-2x.md)) | fused; state across Computed (`_inFlight`, `_overrideValue`) + Transition (`_asyncReporters`, `_optimisticNodes`, `_gatedSubs`, `_queueStash`) + per-write OptimisticLane | **union-find lane merge on dependency-graph overlap** (automatic entanglement detection); parent-child lanes stay independent | identity-based stale-result discard (no fetch cancel) + structural-by-owner-disposal for async iterables | procedure (computed or generator action) + `NotReadyError` throw protocol carrying source-node identity | per-lane `_overrideValue` overlay + per-write `_pendingValue`; merge on overlap; `_gatedSubs` replay-at-commit | **three layers** — per-yield within generator action; per-transition overall; per-lane independently | runtime-enforced; no type-level effect discipline (acknowledged in async-signals proposal) | fused; **`<Reveal>` makes reveal-ordering a first-class reactive primitive** |
| 🟢 | **React modern** (Suspense / transitions / lanes / `use()` / `useOptimistic` / Actions) ([dive](./deep-dives/react-modern.md)) | fused — reconciler IS the engine; component-local state + lane-scheduled work queue + WIP fiber tree | lane-based prioritization with WIP discard (priority-pre-empt-with-restart); multi-transition currently batched (acknowledged limitation) | structural via WIP discard for rendering; convention-only (`AbortController`) for I/O effects | procedure (action / startTransition) + suspending value (`use(promise)`); re-execution rather than continuation-resumption | WIP-tree speculative-state isolation; `useOptimistic` per-action overlay; `useDeferredValue` two-pass | per-WIP-tree-commit; nested Suspense can opt into independent commits | runtime-enforced (reconciler) + convention; no compile-time type discipline | fused — reconciler is the reactive engine; no separate effect layer |
| 🟢 | **effect-ts** ([dive](./deep-dives/effect-ts.md)) | separate (Effect is its own world; TRef for STM state) | retry-on-conflict (STM); structured interruption for non-STM | structural-by-scope (Scope + asynchronous interruption); finalizers always run | typed value (`Effect<A, E, R>`); parallel `STM<A, E, R>` | serializable (STM); n/a outside STM | per-`STM.commit` block (STM); per-`Effect.gen` (syntactic, not atomic across forks) | type-system-enforced | orthogonal |
| 🟢 | **Bonsai (Jane Street)** ([dive](./deep-dives/bonsai-incremental.md)) | separate effect layer (over Incremental); model state in components | last-write-wins via action-dispatch order (Elm reducer discipline) | structural-by-component-lifetime; effects can outlive originator (acknowledged footgun, `Bonsai.peek` workaround) | typed value (`Effect.t`); monadic composition via `let%bind.Effect` | n/a (no transactions) | per-action (single `apply_action` call); Incremental stabilizes after each action | runtime-enforced + convention | separate effect layer over a synchronous reactive graph (Incremental) |
| 🟡 | **Erlang / OTP** | in actors | never-occur (no shared state) | preemptive (process kill) + structural (link / monitor) | message in mailbox | n/a | per-message | runtime-enforced | orthogonal |
| 🟡 | **Haskell GHC STM** | separate (`TVar` is its own world) | retry-on-conflict | block-on-retry (no cancellation in STM proper) | typed value (`STM a`) | serializable | per-`atomically` block | type-system-enforced (no IO in STM) | orthogonal |
| 🟡 | **Clojure refs + STM** | separate (`ref` is its own world) | retry-on-conflict (with `ensure`, `commute`) | n/a | macro (`dosync`) | serializable | per-`dosync` block | convention + macro enforcement | orthogonal |
| 🟡 | **Postgres MVCC (default SI)** | in tables (versioned rows) | snapshot-iso, write-skew tolerated; explicit `FOR UPDATE` for opt-in entangle | n/a | SQL statement | snapshot | per-transaction (BEGIN/COMMIT) | runtime-enforced | n/a |
| 🟡 | **Postgres SSI** | in tables | retry-on-conflict (dependency-cycle detection) | n/a | SQL statement | serializable | per-transaction | runtime-enforced | n/a |
| 🟡 | **Concurrent ML (CML)** | n/a (no shared state assumed) | n/a | atomic via `choose`+`withNack` | first-class event value | n/a | per-`sync` of an event | runtime-enforced | orthogonal |
| 🟢 | **Cap'n Proto / E language** ([dive](./deep-dives/capnproto-e-pipelining.md)) | in distributed promises (answer-tables per session); object state in vats | n/a within a pipeline; vat-serial dispatch at resolution (last-message-wins per object) | lifecycle-event via reference-counting (`op:gc-answer`); no in-flight cancellation primitive | **first-class typed promise with method-invocation pipelining** (method on unresolved promise is the headline operation) | n/a (no transactions) | per-RPC call (vat-turn atomic); chain is NOT atomic as a whole | runtime-enforced via protocol; types from IDL schema | orthogonal |
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
| 🟢 | **Replicache** ([dive](./deep-dives/replicache.md)) (Zero treated as cross-reference only) | persistent B-tree DAG + named heads (main, sync); **pending mutations are the commit-suffix between snapshot and main head**, not a separate queue | **server-linearized re-execution** of named mutators; no LWW at storage; conflict policy lives in user-authored mutator code (with `reason: 'initial' \| 'rebase' \| 'authoriative'`) | lifecycle-scoped only — one `AbortController` per instance for `close()`; **no per-mutation cancellation** (design commitment, not missing feature) | named (function-name, JSON-args) pair; wire form is just `MutationV1 = {id, name, args, timestamp, clientID}`; mutator bodies are separately-installed handlers on client + server | snapshot-per-transaction with explicit dual heads (main + transient sync); **two-head versioned isolation** | per-mutator-invocation (one mutator = one B-tree commit, however many internal awaits) | runtime-enforced at engine boundary (`withWriteNoImplicitCommit` lock + named-head DAG + registry-based replay) | standing-query subscriptions with read-set dependency tracking; fires post-commit on both optimistic and post-rebase; **mutation log and subscription graph are producer/consumer of pulses**, not the same shape |
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

### Extended axes (added session 9 — axis consolidation pass)

Two axes promoted from candidate to confirmed in session 9 — **speculative-state isolation** (#9) and **dependent-dispatch capability** (#10). Cells below were audited row by row; high-confidence cells reflect deep-dive evidence, low-confidence ones are flagged with `?` and will be verified by future dives. Where an axis genuinely doesn't apply (system has no transactions, no async, etc.) the cell is `n/a`.

| Status | System | Speculative-state isolation | Dependent-dispatch capability |
|---|---|---|---|
| 🟡 | **pulse (current)** | per-transition tree (per-`<Loading>` gather) | await-only |
| 🟢 | **Solid 2.x** | per-write-lane overlay with overlap-merge (between per-action and per-transition) | await-only with generator-batching (`action(function*) { yield … }`) |
| 🟢 | **React modern** | per-transition tree (WIP fiber) + per-action overlay (`useOptimistic`) | await-only (`use(promise)` triggers re-execution; no eager dispatch) |
| 🟢 | **effect-ts** | per-`STM.commit` overlay (TRef versioning); per-`Scope` for resources | await-only with generator-batching (`Effect.gen`) |
| 🟢 | **Bonsai** | per-action overlay (model state) | await-only with generator-batching (`let%bind.Effect`) |
| 🟡 | **Erlang / OTP** | actor-isolated (no shared state to speculate over) | n/a (message-passing, not dependent dispatch) |
| 🟡 | **Haskell GHC STM** | per-`atomically` overlay (TVar versioning) | await-only with monadic composition (do-notation) |
| 🟡 | **Clojure refs + STM** | per-`dosync` overlay | await-only with macro composition |
| 🟡 | **Postgres MVCC (SI)** | versioned everywhere | n/a (SQL statements; transaction is the unit) |
| 🟡 | **Postgres SSI** | versioned everywhere | n/a |
| 🟡 | **Concurrent ML (CML)** | n/a (no shared state) | n/a — but first-class event composition is a different axis altogether (`choose`+`withNack` is composition without await-or-dispatch) |
| 🟢 | **Cap'n Proto / E** | n/a (no transactions) | **pipelined+typed-from-schema** (method invocation on unresolved promise dispatches eagerly; types from IDL) |
| 🟡 | **Kotlin coroutines** | none | await-only |
| 🟡 | **Swift Structured Concurrency** | actor-isolated | await-only with `async let` syntax |
| 🟡 | **GGPO (rollback netcode)** | per-frame snapshot tree (rollback rebuilds from snapshot + inputs) | n/a (lockstep input simulation) |
| 🟡 | **ROS action servers** | per-goal lifecycle overlay | n/a (lifecycle protocol, not dispatch) |
| 🟡 | **Yjs / Automerge (CRDTs)** | versioned everywhere (replicated CRDT state) | n/a (operations are commutative; ordering doesn't matter) |
| 🟡 | **Redux + RTK Query** | per-action overlay (RTK cache mutation rollback) | await-only |
| 🟡 | **RxJS** | none (streams are continuous) | per-operator dispatch semantics (`switchMap`/`exhaustMap`/`concatMap`/`mergeMap`) — orthogonal to this axis |
| ⚪ | **MobX** | none (direct mutation; `runInAction` is just batching) | await-only |
| ⚪ | **Recoil** | per-snapshot capture (explicit, via `Snapshot`) | await-only |
| ⚪ | **Jotai** | none (or per-`loadable` atom) | await-only |
| ⚪ | **Zustand** | none | await-only |
| ⚪ | **Valtio** | per-snapshot capture (explicit) | await-only |
| ⚪ | **SWR / TanStack Query** | per-action overlay (mutation cache) | await-only |
| ⚪ | **Apollo Client** | per-action overlay (cache update) | await-only |
| ⚪ | **Trio** (Python) | n/a | await-only |
| ⚪ | **Go context.Context** | n/a | await-only |
| ⚪ | **Rust / Tokio** | n/a | await-only |
| ⚪ | **F# async** | n/a | await-only with computation-expression composition |
| ⚪ | **Akka** | actor-isolated | n/a |
| ⚪ | **Pony** | actor-isolated | n/a |
| ⚪ | **Bevy Commands** | per-sync-point command buffer | n/a |
| ⚪ | **Unity DOTS ECB** | per-sync-point command buffer | n/a |
| ⚪ | **Algebraic effect languages** | varies (handler-determined) | varies — but multi-shot continuations allow dependent-dispatch-like semantics not expressible in JS encodings |
| ⚪ | **SwiftUI + Combine** | none | await-only |
| ⚪ | **Compose + StateFlow** | none | await-only |
| ⚪ | **Vue 3** | per-`<Suspense>` ? | await-only |
| ⚪ | **Svelte 5 runes** | none | await-only |
| ⚪ | **Phoenix LiveView** | server-authoritative (no client speculation) | n/a |
| ⚪ | **HTMX / Hotwire** | server-authoritative | n/a |
| ⚪ | **Temporal / Cadence** | versioned everywhere (durable event-history replay) | implicit ordering via workflow code (similar shape to generator-batching but persisted) |
| 🟢 | **Replicache** | **versioned engine, fixed-cardinality observable branches** (persistent B-tree DAG; only main + sync heads exposed) | **await-only with implicit ordering** (named (function-name, JSON-args) log, sequenced by sender ID; no value-level dataflow on the wire) |
| ⚪ | **Linear sync** | similar to Replicache ? | similar to Replicache ? |
| ⚪ | **Figma multiplayer (OT)** | server-authoritative + OT transformation | n/a |
| ⚪ | **io_uring / IOCP / kqueue** | per-completion ring (kernel-buffered) | n/a |
| ⚪ | **Esterel / Lustre / SCADE** | per-logical-instant | n/a (synchronous reaction model) |
| ⚪ | **Spreadsheets** (Excel) | none | n/a |
| ⚪ | **Sagas** | per-step compensation pair | await-only with explicit step+compensation dependencies |
| ⚪ | **Event sourcing + CQRS** | versioned everywhere (event log + projection rebuild) | n/a (events are immutable; replay reconstructs) |
| ⚪ | **Free monads / tagless final** | varies (interpreter-determined) | await-only with monadic composition |
| ⚪ | **Iteratees / Conduits / Pipes** | n/a | n/a (stream backpressure, not dependent dispatch) |
| ⚪ | **Game lockstep simulation** | per-tick snapshot | n/a |
| ⚪ | **VCS** (Git / Pijul) | versioned everywhere (commit DAG) | n/a |

**Reading guide.** The two new axes carve up the design space along orthogonal dimensions to the original eight: speculative-state-isolation answers "what is the engine doing to give you a coherent view while in-progress work hasn't committed?" (cuts across isolation level + atomicity granularity); dependent-dispatch-capability answers "what shape does multi-step dependent async take in this system?" (cuts across async representation + atomicity granularity). Both were initially flattened into existing axes; sessions 4–8 produced enough evidence to surface them as distinct.

The audit shows the two axes have rich, well-populated value sets — six values for speculative-state isolation, five for dependent-dispatch capability — with several systems sitting at uncommon corners (Replicache's "versioned engine, fixed-cardinality branches"; Solid 2.x's "per-write-lane overlay with overlap-merge"). Future dives (Yjs, Linear, Agoric `E()`, Temporal) will further verify the rare-corner cells.

### Open questions about the taxonomy itself

These are uncertainties about the *axes*, not the entries. Each one is a thread to chase:

- **Effect representation as a continuum, not a category.** The current axis lists value / procedure / type / continuation / channel / mailbox as distinct kinds, but several systems straddle (e.g. effect-ts's `Effect<R,E,A>` is "both typed AND a value"). Maybe this axis needs to split into 2-3 sub-axes (representation; type-tracking; composability).
- **"Atomicity per tick"** — does the per-tick choice fundamentally differ from per-microtask vs per-frame, or are they all instances of "discrete-time-step batching with framework-chosen step size"?
- ~~**"Where async state lives" vs "Reactive integration"** — are these axes orthogonal or correlated?~~ **Resolved (session 4, Bonsai dive):** they are distinct. Bonsai is the proof — its reactive integration is the substrate (Incremental), but async state lives outside that graph in the `Effect.t` layer. Pulse / Solid 2.x are (fused-reactive, in-graph); Bonsai / Redux are (separate-layer, in-effects); effect-ts is (orthogonal, in-effects); Excel is (fused, no-async). The two axes are orthogonal; keep them separate. See [`bonsai-incremental.md`](./deep-dives/bonsai-incremental.md) "Open questions resolved."
- **Discipline location** — is "type-system-enforced" really a single category, or does it split into "checked at compile time" vs "enforced via library types but not language rules"?
- **What's NOT on the taxonomy yet?** — distribution model (single-process / multi-process / multi-machine / multi-replica), failure model (crash-stop / crash-recover / Byzantine), real-time guarantees (none / soft / hard), determinism (none / per-tick / globally deterministic). These may or may not be relevant to pulse; the research will tell us.
- ~~**"Work-in-progress tree" as a primitive.**~~ **Resolved (session 6, React-modern dive; refined session 7 Solid + session 8 Replicache).** **Promoted to confirmed axis #9 in session 9 — "speculative-state isolation"** — see Extended Axes table above. Six values now populated, with deep-dive evidence for 4 of them.
- **"Discipline location" may need sub-axes.** effect-ts deep-dive (session 2) revealed two distinct mechanisms both classified as "type-system-enforced": (a) structural typing of effect signatures via type parameters (`E`, `R` in `Effect<A, E, R>`), and (b) vocabulary restriction within a namespace (STM combinators don't expose IO-shaped ops, so purity is enforced by what's *not exposed*). These are different kinds of enforcement; might warrant splitting the axis.
- **"Async state lives" might need a value for "runtime-interpreted lazy description."** effect-ts's `Effect<A, E, R>` isn't really "in a graph" (no reactive integration) or "in actors" or "in tables" — it's *interpreted state* of a lazy description by the runtime. The current value "separate" flattens this. Consider a "runtime-interpreted" value if more systems exhibit this pattern (free monads, tagless final, OCaml 5 effect handlers all might).
- **Is "purity precondition" a missing axis?** effect-ts STM forbids IO inside transactions (so retry is safe). Haskell STM, Clojure STM, Bevy Commands all share this. Sagas don't. Reactive computeds in pulse/Solid don't formally require it but in practice they should be replayable. Worth tracking whether a system requires its async units to be pure for safe retry/replay.
- **Atomicity granularity for systems with TWO atomicity layers.** effect-ts has STM-level (per-commit) AND fiber-level scope-bounded (per-scope) atomicity, for different concerns (data consistency vs resource lifecycle). A single cell value flattens this. Session 3's algebraic-effects dive confirmed: atomicity granularity is best understood **per-handler, not per-system** — multi-handler systems have multiple atomicity boundaries by design. Consider whether the axis should split into "data-atomicity" and "lifecycle-atomicity," or be reformulated as "per-handler atomicity" (a row of values, one per handler kind).
- **Async representation as a spectrum, not a category.** Session 3 sharpened: the current values (procedure / value / type / continuation / channel / mailbox) are best understood as a spectrum of "how first-class the captured effectful work is" — from procedure (not first-class) to value (first-class but interpreted) to continuation (first-class with multi-shot capability). Cells should be read in this light; documenting this in the axis definition would clarify.
- **NEW axis candidate: continuation cardinality.** Surfaced by the algebraic-effects dive. Values: 0-shot (exceptions); 1-shot (async/await, generators, effect-ts, pulse within-stage); multi-shot at coarse granularity (pulse across stages, incremental graphs); multi-shot fine (Eff, Koka, Haskell `MonadCont`); runtime-enforced 1-shot (OCaml 5 deliberately forbids multi-shot). Structurally distinguishes systems in a way current axes flatten. **Still candidate after session 9 — JS encodings collapse most of the distinctions, so the axis may be less load-bearing for pulse's design space than dependent-dispatch-capability (which got promoted in session 9). Hold pending evidence that pulse's design choices hinge on this distinction.**
- ~~**NEW axis candidate: dependent-dispatch capability.**~~ **Promoted to confirmed axis #10 in session 9** after the Replicache dive provided a 4th well-evidenced datapoint. See Extended Axes table above. Five values now populated.
- **Is multi-shot resumption useful for UI?** Most algebraic-effects "killer apps" (nondeterminism, backtracking, parser combinators, cooperative threading) aren't UI patterns. Speculative rendering, preview/what-if mode (S8), and time-travel state restoration might be the only places multi-shot would help. Worth checking deliberately during scenario reviews — would adopting multi-shot capable encodings buy us anything pulse would actually use?
- **Cross-cutting thread status — "message-send triangle" (sessions 5–8).** The triangle (Smalltalk / Cap'n Proto / reactive graphs as three corners of "receiver-existence-state × firing-cardinality") was tested against React (same corner as pulse), Solid 2.x (same corner; `action()` is the closest JS gets to the middle), and Replicache (**sits outside the triangle entirely**). Session 8's finding: receiver-existence isn't the load-bearing axis for sync engines; durability + replay cardinality are. **The triangle should be replaced with a small grid** (receiver-existence × execution-cardinality × dispatch-locus). Promoted to an open thread to be worked through in a future synthesis session. See [LOG.md](./LOG.md) "Cross-cutting thread — message-send to receivers of various existence-states."

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
- [x] **Cap'n Proto + E language** ([dive](./deep-dives/capnproto-e-pipelining.md), session 5) — promise pipelining; raised candidate axis for "dependent-dispatch capability" (await-only vs pipelined vs pipelined+typed)
- [ ] **Postgres MVCC + Serializable Snapshot Isolation** — longest-running production transaction implementation
- [ ] **Haskell GHC STM**
- [ ] **Clojure refs + STM** (`ensure` / `commute` distinction)
- [ ] **Kotlin coroutines / Swift Structured Concurrency / Trio** (structured concurrency family — comparable enough to fold into one dive)
- [ ] **Go context + Rust/Tokio cancellation** (cancellation discipline)
- [ ] **GGPO + fighting-game rollback netcode**
- [x] **Replicache** ([dive](./deep-dives/replicache.md), session 8) — sync engine; pending mutations are the commit-suffix in a B-tree DAG; server-linearized replay; fourth distinct value on the dependent-dispatch axis ("named log of (function-name, args) sequenced by sender ID"); sits *outside* the message-send triangle
- [ ] **Yjs + Automerge (CRDT lineage)** (CRDT-merge as conflict policy)
- [x] **Solid 2.x lanes + entanglement** ([dive](./deep-dives/solid-2x.md), session 7) — read from `@solidjs/signals` 2.0.0-beta.13 source. Per-write union-find lane merge as automatic entanglement detection; three-layer atomicity; `action(function*)` generator transitions; `<Reveal>` reveal-ordering primitive; `_gatedSubs` cross-transaction-read-with-replay; async-signals-proposal flagged as live design alternative
- [x] **React modern async** ([dive](./deep-dives/react-modern.md), session 6) — fiber reconciler lanes + Suspense + transitions + `use()` + `useOptimistic` + Actions + WIP trees. Resolved WIP-tree-as-primitive (yes, distinct axis); tested dependent-dispatch axis (React is "await-only"); tested message-send triangle (React's `use()` sits at the same corner as pulse's, not at the pipelining corner)
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

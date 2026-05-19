# Bonsai + Jane Street Incremental

**Type:** primary
**Taxonomy row(s) affected:** "Bonsai (Jane Street)" (currently 🟡)
**Status after this dive:** 🟢 verified — cells revised based on primary sources
**Date:** 2026-05-19
**Session:** 4
**Scope note:** Deep-dive on the Bonsai web framework and the underlying Incremental library, treated together because Bonsai compiles to Incremental and many of the trade-offs only make sense across the boundary. Specifically pursues the open orthogonality question (is "reactive integration" the same axis as "where async state lives," or two distinct axes?). Bonsai is the cleanest "separate effect layer over a reactive graph" exemplar in the taxonomy.

---

## Sources

Primary:

1. **[janestreet/bonsai README](https://github.com/janestreet/bonsai)** — repo description, philosophy ("inspired by Elm"), and components-as-state-machines framing.
2. **[Jane Street — "Introducing Incremental"](https://blog.janestreet.com/introducing-incremental/)** — Incremental's design rationale, `Var`/`Inc.map`/`Inc.bind`/`Inc.observe`/`Inc.stabilize` primitives, the spreadsheet mental model, the contrast with FRP ("FRP is mostly concerned with time-like computations, and SAC is mostly about optimizing DAG-structured computations").
3. **[bonsai_web docs — RPCs](https://github.com/janestreet/bonsai_web/blob/master/docs/how_to/rpcs.md)** — `Rpc_effect.Rpc.dispatcher` API, the `query -> 'response unit Effect.t` shape, `polling_state_rpc` for ongoing data sources, full code examples of one-shot RPC + polling.
4. **[bonsai_web docs — Effects and Stale Values](https://github.com/janestreet/bonsai_web/blob/master/docs/how_to/effects_and_stale_values.md)** — the `Bonsai.peek` pattern; the "effect closes over old value" footgun and its resolution.
5. **[bonsai_web docs — Edge-Triggered Effects](https://github.com/janestreet/bonsai_web/blob/master/docs/how_to/edge_triggered_effects.md)** — `Bonsai.Edge.on_change'`; the explicit guidance that declarative > edge-triggered.
6. **[bonsai_web docs — Bonsai history](https://github.com/janestreet/bonsai_web/blob/master/docs/blog/history.md)** — evolution of the `Bonsai.t` type from `Incr_dom`'s component to today's; reveals the core type's structural shape.

Secondary:

7. **[Jane Street — "Incrementality and the web"](https://blog.janestreet.com/incrementality-and-the-web/)** — fetched in earlier session; sparse on Bonsai specifics but useful for motivation.
8. **[gfxmonk — "I'm excited about Koka"](https://gfxmonk.net/2025/04/13/im-excited-about-koka.html)** — already cited from session 3 (algebraic effects); useful here for comparing Koka's effect-typing to Bonsai's effect dispatch.

Note on sourcing: Jane Street's documentation conventions tend toward narrative how-tos rather than formal API references. The how-to docs (sources 3–5) are *the* primary source for "how do effects work in Bonsai"; the OCaml `.mli` interfaces are sparse on prose and refer back to internal modules. Code examples in the how-tos are canonical.

---

## What it is

**Incremental** is Jane Street's library for *self-adjusting computations* — a directed-acyclic graph of computations that efficiently re-evaluates only the portions affected by changing inputs. Mental model from the Incremental blog: "a fancy spreadsheet where each cell contains either simple data, or an equation that describes how the value should be derived from other cells. … when cells change, only the dependent parts are recomputed." Crucially, Incremental supports **dynamic dep graphs** via `Inc.bind`: the structure of the computation can change at runtime based on data values.

In our research vocabulary, Incremental is a **synchronous reactive graph** — values, derived computations, `Var.create` (root input), `Inc.map`/`Inc.map2` (derived nodes), `Inc.bind` (dynamic sub-graphs), `Inc.observe` (mark a node as observed so the framework knows what's "needed"), `Inc.stabilize` (force the graph to re-evaluate dirty nodes). **There is no async story** in Incremental itself: per the source 2 author, "SAC and FRP have different semantics — FRP is mostly concerned with time-like computations, and SAC is mostly about optimizing DAG-structured computations."

**Bonsai** is a UI framework built on top of Incremental for the web (`bonsai_web`) and other targets. Its design philosophy explicitly draws from Elm and from the older Jane Street framework `Incr_dom`. The key Bonsai abstraction is a **purely functional state machine as a composable component**: components have a model (state), an action type (typed messages), an `apply_action` function (model + action → new model), and a view (derived from the model via Incremental).

In our research vocabulary, Bonsai is **a separate effect layer over a reactive graph (Incremental)**. The reactive graph computes views from model state — synchronously, no async in the graph itself. Effects (`Effect.t`) are first-class **commands** representing "things to do to the outside world" (mutate state, send an RPC, schedule a timer, alert, log). The Bonsai runtime dispatches effects; effect completion produces actions; actions update the model; the Incremental graph re-runs to produce a new view.

This is the **canonical Elm-shape** with one specific commitment: the view-derivation layer is Incremental (genuinely reactive, fine-grained dep tracking), not a re-render-everything render loop. Effects are values, the runtime is the interpreter, state lives in component-local stores.

The system's own terminology: Bonsai calls `Effect.t` an "effect" and calls the model-updating function `apply_action`. We treat `Effect.t` as the **canonical example of an "effect-as-value"** primitive in a UI framework — distinct from React's `useEffect` (a procedure) and from effect-ts's `Effect<A, E, R>` (also a value, but with full effect-system typing and a different runtime).

---

## The async-coordination model

### Conflict handling

Bonsai inherits Elm's single-reducer architecture: all state changes go through `apply_action`, which is serial. Two effects firing concurrently each produce actions; the actions are dispatched into the reducer in arrival order. There is no STM, no transactions, no entanglement detection.

**Conflict resolution policy:** last-write-wins on the model, mediated by action dispatch ordering. If effects A and B both write `count`, the action that arrives second wins. There's no built-in mechanism for "block-on-conflict" or "retry-on-conflict" — Bonsai trusts the application's reducer to express the correct merging logic.

Per source 5 ("Edge-Triggered Effects"): "Declarative programs are easy to reason about and test. Extensive use of the `Edge` module will make your program less and less declarative." Bonsai's design discipline pushes you toward expressing state changes as pure functions of inputs rather than as imperative writes — which sidesteps many of the conflict scenarios our taxonomy worries about, by not generating concurrent writes in the first place.

### Cancellation

Effects in Bonsai don't have built-in cancellation in the way effect-ts fibers do. An effect is "dispatch this thing to the outside world; on completion, produce these actions." If the user's intent is to cancel an in-flight RPC, that's expressed at the underlying transport layer (the `Rpc.Connection` can be aborted; `polling_state_rpc` has different lifecycle semantics).

**However**, Bonsai's component lifecycle provides a structural cancellation: if a component is unmounted (its `Bonsai.t` falls out of the active computation graph via `Bonsai.match`, `Bonsai.if_`, etc.), the framework calls its `on_deactivate` lifecycle and its in-flight effects can be cleaned up. The discipline is *structural by Incremental's dep graph*: the lifetime of an effect is bounded by the lifetime of the component that scheduled it.

This is distinctly weaker than effect-ts's `Scope` + interruption: there's no guarantee that a fired-but-not-completed effect's downstream actions are discarded — they'll dispatch to whatever the model currently is, even if the originating component no longer exists. The `Bonsai.peek` pattern (source 4) exists partly because effects close over stale values; the framework explicitly documents this footgun rather than preventing it structurally.

### Suspension / resumption

Bonsai doesn't have "suspension" in the React/effect-ts sense. There's no `use(promise)` that throws and waits. Instead, async work is dispatched as an `Effect.t`; while in flight, the model has whatever state was last committed; when the RPC returns, an action is dispatched, the model updates, the view re-derives via Incremental.

The "loading state" is explicit application state — typically a `Loading | Loaded of value | Error of e` ADT in the model. Per source 3 (RPCs how-to): the `dispatch_double_rpc` is `query -> 'response unit Effect.t`; you dispatch it from a button handler; on completion you call `set_number doubled_number` to commit the result; the view re-renders to show the new value. There is no implicit `<Suspense>` or `<Loading>` boundary in Bonsai's design.

For polling data sources (where you want UI to track server state continuously), Bonsai provides `polling_state_rpc` — the client polls the server periodically, the server responds with diffs from the last poll's state. This pattern avoids the "Pipe_rpc backlog when the tab is backgrounded" problem (source 3): pull-based on a timer the client controls, rather than push-based.

The architectural commitment is: **async happens outside the reactive graph; results land in the graph via action dispatch.** The graph never "waits"; it always reflects committed state.

### Composition

Effects compose via `Bind`/`return` (the standard monadic operations on `Effect.t`):

```ocaml
let%bind.Effect () = set_state new_state in
Effect.alert computed
```

(From source 4.) The `%bind.Effect` is OCaml's let-syntax for the Effect monad — chains two effects sequentially. `Effect.return`, `Effect.bind`, `Effect.all` (parallel), `Effect.ignore`, `Effect.of_sync_fun` (lift an OCaml function as an effect) are the typical combinators.

This is "effects as monadic values" — composable, named, dispatched separately from their description. The same pattern as effect-ts's `Effect.gen`, but with `let%bind` syntax instead of generator-yield syntax.

Composition of *components* is the headline of Bonsai's design — components are values that combine into bigger components via `Bonsai.both`, `Bonsai.map`, `Bonsai.both`, etc., and the framework manages state-scoping for nested components automatically (per source 1: "stateful components embedded in containers (like tabs) have their state automatically managed rather than manually hoisted to top-level").

### Error handling

Effects can fail; `dispatch_rpc` returns `'response Or_error.t Effect.t` (per source 3's code: `match%bind.Effect dispatch_double_rpc number with | Ok doubled -> … | Error error -> …`). The application explicitly handles `Or_error.t` cases.

There's no global error boundary in the React `ErrorBoundary` sense. Errors are values flowing through the action dispatch path; the reducer decides what to do with them.

### Lifecycle / structure

Components have explicit lifecycle hooks: `on_activate` (when the component becomes part of the active graph), `on_deactivate` (when it leaves). State scoping is per-component, managed by the framework. The Bonsai history doc (source 6) makes the architectural commitment explicit: "the application growing too big and becoming large and messy" was the problem `Incr_dom`'s monolithic Component.t couldn't handle; Bonsai solves it by making components first-class compositional values.

---

## Taxonomy cells

### Where async state lives
**Cell:** separate effect layer (over Incremental); state in component-local models
**Evidence:** Source 3's RPC how-to shows `dispatch_double_rpc` as an `Effect.t` value; effects are dispatched separately from the reactive graph; results land in model state via `apply_action`. The Incremental graph (per source 2) is purely synchronous — no async lives in it. The model state where async results land is per-component, per `Bonsai.state` calls.

### Conflict-handling policy
**Cell:** last-write-wins on the model, mediated by action dispatch ordering
**Evidence:** Bonsai inherits Elm's single-reducer architecture. There's no STM or transactional mechanism. The recommended discipline (source 5) is to express state as pure functions of inputs to avoid generating concurrent writes; when concurrent writes exist, action dispatch order resolves them.

### Cancellation discipline
**Cell:** structural-by-component-lifetime; effects can outlive their originator (acknowledged footgun)
**Evidence:** Components have `on_deactivate` lifecycle hooks (source 5). However, source 4 ("Effects and Stale Values") explicitly documents that effects close over old values and may dispatch actions referring to state from before the effect was scheduled; the `Bonsai.peek` pattern is the workaround. There's no equivalent to effect-ts's `Scope` + interruption — no guarantee that a fired effect's downstream actions get discarded on cancellation.

### Async representation
**Cell:** typed value (`Effect.t`); monadic composition (`Effect.bind`/`Effect.return`)
**Evidence:** Source 3: `dispatch_double_rpc : query -> 'response unit Effect.t`. Source 4: `let%bind.Effect ... in ...` syntax for sequencing. Effects are values that can be passed around, stored, dispatched conditionally, sequenced via let-bind.

### Isolation level
**Cell:** n/a (no transactions; no isolation primitive)
**Evidence:** Bonsai has no transaction primitive. Model writes go directly through `apply_action`; there's no atomicity across multiple writes, no isolation between concurrent reducers.

### Atomicity granularity
**Cell:** per-action (single `apply_action` call); the Incremental graph stabilizes after each action
**Evidence:** Source 6's history doc describes `apply_action : schedule_event:(Event.t -> unit) -> 'action -> 'model` — one action, one model transition. The Incremental graph re-stabilizes after each action; the view re-derives once per stable model.

### Discipline location
**Cell:** runtime-enforced + convention
**Evidence:** Runtime: Incremental's dep tracking + Bonsai's component lifecycle. Convention: the explicit guidance in source 5 ("avoid using `Edge` to synchronize Bonsai states") indicates the framework relies on programmer discipline for what's idiomatic; the type system doesn't structurally prevent stale-value bugs.

### Reactive integration
**Cell:** separate effect layer over a synchronous reactive graph (Incremental)
**Evidence:** This is the key Bonsai architectural commitment, established by sources 1, 2, 3, 6 together. Incremental is the synchronous reactive substrate; effects are separately dispatched values that produce actions which update model state which the reactive graph then sees.

---

## Scenario mapping

| Scenario | Solved? | How |
|---|---|---|
| **S1 — Like/unlike race** | partial | Effects dispatch is serial through `apply_action`. The race is resolved by dispatch order, with explicit reducer logic for merging. There's no rollback or optimistic-with-revert primitive; the application implements it manually via state ADT (`Loading_like / Likeded / Like_failed`). |
| **S2 — Auto-save vs explicit save** | yes (manual) | Auto-save fires as a periodic `Effect.t`; explicit save as a button-triggered `Effect.t`. Both produce actions; the reducer merges. Snapshot-of-payload is captured at effect-creation time (effect closes over the current draftBody when dispatched). Source 4 documents the stale-value footgun; the `Bonsai.peek` pattern resolves it. |
| **S3 — Multi-step server flow with partial failure** | yes (manual) | Compose effects via `let%bind.Effect`. Each step's result feeds the next; failure handling is `match%bind.Effect` on `Or_error.t`. No automatic compensation, but explicit step-by-step `Or_error` propagation is the canonical pattern. |
| **S4 — Concurrent independent flows** | yes (by default) | Independent effects don't entangle. They produce independent actions; the reducer handles them serially. Different components have independent state by Bonsai's scoping discipline. |
| **S5 — Cross-transaction read** | n/a | No transactions, no overlay, no entanglement question. The cross-tx read scenario doesn't apply. |
| **S6 — User-cancellable flow** | partial | Component unmount cancels in-flight effects' downstream impact (component is no longer active, so its actions don't dispatch). However, the in-flight RPC itself may complete and just be discarded. This is weaker than effect-ts's structural cancellation; the source-4 stale-value footgun reflects this. |
| **S7 — Optimistic reconciliation** | yes (manual) | Standard pattern: dispatch optimistic write (action → set state to predicted value), then dispatch RPC effect (on success → action setting committed value; on failure → action reverting). Polling RPC provides ongoing reconciliation. |
| **S8 — Preview / what-if mode** | partial | Bonsai's components-as-state-machines pattern can model preview as a separate state slot — "draft state" vs "committed state" — with explicit "apply" / "cancel" actions. Not built-in but cleanly expressible. |

**Policy questions** (per `concurrent-flows.md` Q1–Q5):

- **Q1 (overlay read inside tx):** n/a (no transactions).
- **Q2 (outside-tx read):** committed truth only (no overlay concept).
- **Q3 (commit ordering with shared state):** strict action-dispatch ordering; reducer determines outcome.
- **Q4 (default entanglement):** **none — last-write-wins via dispatch order (b extreme).** No automatic detection or block; the reducer's job to express merging.
- **Q5 (overlay lifecycle):** n/a.

---

## What an encoding into JS gains or loses

### What pulse would gain by adopting Bonsai's architecture

- **Clear separation of concerns.** "Reactive graph computes views; effects do I/O" is a clean architectural commitment. Debugging is easier: at any point, the graph is in a consistent sync state.
- **Effects as composable values.** `Effect.t` with monadic composition is genuinely useful; you can name, store, dispatch conditionally, compose into multi-step flows. Pulse's current model has nothing equivalent — async work is just functions returning Promises.
- **Action dispatch as the single mutation pathway.** Forces state changes to go through a typed channel, which gives traceability and testability.
- **Component-local state scoping with auto-management.** Components compose without explicit state hoisting; nesting tabs/dialogs/modals doesn't require lifting state to a parent.

### What pulse would lose

- **Co-located reads.** Pulse's `use(view).name` reads the value and engages transitions in one syntactic unit. Bonsai's equivalent requires dispatching an action, reading the resulting model, and the view re-derives — three layers of indirection.
- **Implicit pending propagation.** Pulse's pipeline-OR `isPending` walks make downstream computeds inherit pending state for free. Bonsai requires explicit modeling: every consumer of a possibly-pending computation reads a `Loading | Loaded` ADT and case-analyzes.
- **The ergonomic baseline.** Bonsai is "Elm in OCaml with Incremental views." Pulse's pitch is "signals + computeds + `use()` is enough for most apps." Adopting Bonsai's discipline is a much bigger architectural shift than pulse currently asks of users.
- **The fused-reactivity-and-async story.** Pulse's defining feature is treating `computed(async () => …)` as a first-class primitive. Bonsai explicitly separates: no async in the reactive graph; results land via action dispatch. Adopting Bonsai means giving up that fusion entirely — which is a different framework, not a refinement.

### Could pulse adopt PARTS of Bonsai's discipline?

The most plausible partial adoption: **`action()` as a first-class effect-as-value primitive**, separate from pulse's existing `effect()` (which is procedural). An `action(args) => Effect` that returns a dispatchable value, with composition combinators (`action.bind`, `action.all`), and explicit lifecycle (started / completed / cancelled) — this would be Bonsai-shaped, slotting alongside pulse's existing fused-reactive primitives rather than replacing them.

This is exactly what we sketched in the Plan C discussion (`docs/superpowers/specs/2026-05-18-effect-stages-design.md`'s open questions) but didn't commit to. The Bonsai dive validates it as a serious option: it's a production-proven pattern (Bonsai itself uses it at scale at Jane Street). The discipline it imposes — effects are values, actions are the single mutation pathway — is a real architectural commitment, but it doesn't require giving up pulse's fused reactivity for the non-mutation parts of the framework.

### JS-specific constraints

- **OCaml's type system enables effect-typing-like discipline that TypeScript can't fully replicate.** Bonsai's `Effect.t` is parameterized; the type system catches "you forgot to dispatch this effect" or "you used the wrong action type" at compile time. TS can encode similar via discriminated unions + branded types, but the ergonomics are worse.
- **OCaml's PPX (preprocessor) macros enable `let%bind.Effect`-style syntax.** TS has no equivalent; we'd have to use either `.then` chains or async generator syntax — neither as ergonomic as OCaml's let-syntax.
- **OCaml's structural module system makes Bonsai's component-state scoping cleaner than TS could manage.** TS gets close with generic types but the experience is worse.

These are not blockers — effect-ts shows that you can build a serious effect system in TS — but they tax the ergonomics, especially for "effects as named, typed, composable values" which is exactly the Bonsai discipline.

---

## Open questions resolved

The dive resolves the session-1 open question about whether "reactive integration" and "where async state lives" are the same axis or two distinct axes.

**They're distinct.** Bonsai is the proof: its reactive integration is "separate effect layer over a reactive graph" — the reactive graph (Incremental) IS the framework's substrate, but async state lives OUTSIDE that graph in the effect layer. The same system simultaneously has:

- A reactive graph (Incremental) for view derivation.
- A separate effect layer (`Effect.t` values dispatched into a runtime) for async work.
- State (model) that's connected to both via action dispatch.

If "reactive integration" and "where async state lives" were the same axis, this wouldn't be expressible without flattening Bonsai into a misleading characterization. The two axes are orthogonal: a system can be (fused reactive integration, async-state-in-graph) like pulse / Solid 2.x; or (separate effect layer, async-state-in-effects) like Bonsai / Redux+RTK; or (no reactivity, async-state-in-Effect-runtime) like effect-ts; or — less common but conceivable — (fused reactive integration, async-state-in-effects) which would be Bonsai-style but with the reactive graph being the primary surface rather than the secondary derivation layer.

**Recommendation:** keep them as distinct axes in the taxonomy. Document the orthogonality with Bonsai as the prototype example.

---

## Open questions raised

- **Could pulse adopt the `Effect.t`-as-value pattern incrementally?** The Plan C `effect([...stages], commit)` is a step in this direction (effects-as-values for chained side effects); going further would mean adding a typed `action(args) => Effect` that composes via combinators. The dive validates this is a serious option, but the design depth would need a separate exploration session (not just research).
- **Is Bonsai's "components-as-pure-state-machines" composition pattern transferable to pulse's signals-and-JSX model?** OCaml's module system carries a lot of weight in Bonsai's component-composition story; TypeScript can't replicate that ergonomically. Worth investigating whether a less-typed version of the discipline (e.g. "components return both state and view, with explicit action types") could work in pulse without OCaml's module system.
- **The stale-value footgun in Bonsai (source 4) suggests effects-as-values + scope-bounded discipline isn't sufficient on its own.** Effect-ts's `Scope` + interruption resolves this by guaranteeing post-cancellation operations don't fire. Bonsai's `Bonsai.peek` is a workaround at the application level. This sharpens the cancellation-discipline axis: there's a difference between "structural by component lifetime" (Bonsai) and "structural by scope with interruption guarantee" (effect-ts), even though both could be called "structural-by-scope."
- **Does Incremental's `Inc.bind` map onto pulse's pipeline stages?** The CONTEXT.md framing was "pipelines are delimited continuations split at user-chosen boundaries." Incremental's `bind` is structurally the same shape: a node whose downstream sub-graph depends on the value of an upstream node, recomputed when upstream changes. The relationship between pulse's `computed(s0, s1, s2)` pipeline stages and Incremental's `bind` nodes deserves a CONTEXT.md sharpening pass.

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`effect-ts.md`](./effect-ts.md) — Bonsai's `Effect.t` and effect-ts's `Effect<A, E, R>` are both effect-as-value primitives, with very different surrounding philosophies (Bonsai = Elm-shape with reactive view layer; effect-ts = full effect-typed programming model). The comparison is illuminating about what "effect-as-value" gains you depending on the surrounding architecture.
  - [`algebraic-effects.md`](./algebraic-effects.md) (session 3, concept dive) — Bonsai's effect dispatch IS an instance of the algebraic-effects pattern: actions are operations, the reducer is the handler, the effect runtime is the handler-stack interpreter. The orthogonality finding extends the algebraic-effects framing: handlers can run separately from the reactive computation they coordinate (Bonsai) or be fused with it (pulse / Solid 2.x).
  - `react-modern.md` (TODO) — React's modern async story (transitions / Suspense / `useOptimistic`) is fused like pulse. Bonsai's separation makes for a sharp three-way contrast: React (fused at the reconciler level), pulse (fused at the binding level), Bonsai (separate at the architectural level).
  - `solid-2-lanes.md` (TODO) — Solid 2.x's lanes are runtime-managed inside the reactive graph; Bonsai's effects are runtime-managed outside the reactive graph. The contrast sharpens the "where async state lives" axis.
- **Taxonomy axes this dive informed:**
  - **Reactive integration vs where async state lives: confirmed as distinct axes.** Bonsai is the proof. Pulse/Solid are (fused, in-graph); Bonsai is (separate-layer, in-effects); effect-ts is (orthogonal, in-effects); Excel is (fused, no-async).
  - **Cancellation discipline:** sharpened — "structural by component lifetime" (Bonsai) is meaningfully weaker than "structural by scope with interruption" (effect-ts). May warrant a sub-axis or a richer cell value.
  - **Async representation:** Bonsai confirms that "typed value with monadic composition" is a coherent and production-proven choice, distinct from procedural async (React `useEffect`) or generator-based effects (effect-ts).
- **Scenarios this dive addressed:** S1 partial; S2 yes (manual but ergonomic); S3 yes (composition via let-bind); S4 yes; S5 n/a; S6 partial (stale-value footgun); S7 yes (manual but standard pattern); S8 partial (cleanly expressible, not built-in).
- **Concept dives this builds on / motivates:** builds on algebraic-effects (session 3); motivates a possible future concept dive on **Elm Architecture** (the Elm language / Redux / Bonsai family of unidirectional-dataflow designs).

---

## Notes / aside

- The Bonsai documentation lives in `bonsai_web/docs/`, not `bonsai/docs/` — the latter is mostly empty. Future sessions on Bonsai should default to the `bonsai_web` repo.
- Code excerpts in the how-to docs use OCaml's `let%bind.Effect` syntax which is PPX-generated; the underlying primitive is `Effect.bind`. Knowing this helps with reading the code without OCaml fluency.
- The mention in source 1 that Bonsai is used "to build almost all web applications inside Jane Street" is a strong production-rigor signal. The discipline isn't theoretical; it's been operated at scale.
- Incremental's design rationale (source 2) explicitly distinguishes from FRP: "FRP is mostly concerned with time-like computations, and SAC is mostly about optimizing DAG-structured computations." This positions Incremental in a different research lineage than the signals-based reactive libraries (Solid, MobX, etc.) — though the operational similarity is large.
- The Bonsai history doc (source 6) is a thoughtful design-evolution narrative. It would be a model for pulse's CONTEXT.md "design history" if we ever want to write one.
- The Pipe_rpc-vs-polling_state_rpc trade-off (source 3) is a real production-engineering insight: push-based streams break when clients are backgrounded; pull-based polling with diffs degrades gracefully. Worth filing for the eventual transaction-primitive design — any "sync engine" pulse builds should default to pull, not push.

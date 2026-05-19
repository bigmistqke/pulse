# Async Strategies — Session Log

Append-only chronology of how the research has unfolded. Read this before starting a session to inherit the prior session's context, open threads, and any conventions or decisions captured in prose rather than the taxonomy.

Each session entry should record:

- Date and a short subject for the session.
- What was done.
- What was learned (in prose; the taxonomy table captures structured findings).
- Open questions or threads opened.
- A "threads for next session" subsection at the bottom of the latest entry.

Mid-session pivots, corrections, and conventions changes are recorded as nested bullets within their session.

See [`./README.md`](./README.md) for the framing, taxonomy table, and deep-dive index. See [`./CONTEXT.md`](./CONTEXT.md) for the research conventions that govern how sessions are conducted.

---

## Session 1 — 2026-05-19 — Scaffolding + initial axes

- Set up the research directory: `docs/research/async/` with a deep-dives subdirectory.
- Drafted the framing — the constraint that "JS doesn't give us the primitives; everything is an encoding with trade-offs" is the central observation that shapes the rest.
- Extracted an initial 8 axes by reviewing every system touched in prior sessions (Solid 2.x analysis, scenarios doc's prior-art survey, Bonsai/incremental discussion, async-specific traditions discussion).
- Seeded the taxonomy table with 18 systems × 8 axes. Cells are draft until verified by deep-dives.
- Surfaced open questions about the axes themselves (effect rep continuum, atomicity-granularity confusion, state-location vs reactive-integration correlation, discipline subcategories, missing dimensions like distribution / failure / real-time).
- Did NOT pick a first deep-dive. Reasoning: the axes themselves need at least one or two deep-dives to validate; jumping into specifics without confidence in the framework risks dead-end research. Next session should pick the first dive based on which axis is most ambiguous or which system is most foundational to multiple cells.

**Mid-session correction — React row.** Initial table had a row for "React `useEffect` + `useState`" — the pre-modern workaround pattern. User pushed back: that's not React's async answer; the actual primitive is the fiber reconciler's lane-based transitions + Suspense + `use()` + `useOptimistic`. Replaced the row accordingly. **Lesson for the rest of the research: when a system has multiple async approaches across versions, pick the one that the system actually claims as its primary primitive — not whatever was the historical workaround that people still use.** Surfaced a new open question about "work-in-progress tree as a primitive" (React's WIP fiber tree maps onto MVCC's in-progress-tx state and GGPO's speculative-state-to-validate; may warrant its own axis).

**Inventory expansion.** Audited the table against everything mentioned in `concurrent-flows.md`'s broader prior art section: 19 rows present, 35 systems missing. Expanded the taxonomy table from 19 to ~50 rows, with status indicators (🟡 draft / ⚪ pending / 🟢 verified). New rows mostly marked ⚪ pending with terse one-line characterization; cells will fill as deep-dives happen. Status indicators double as a progress meter.

**Deep-dive index restructured into three sections.** Earlier the index was one flat list. User observation: things that don't belong as taxonomy rows (because they're mechanisms, theoretical concepts, or different problem domains) still deserve deep-dives — their lessons transfer even though they don't compete in pulse's design space. Split index into:

- **Primary** (~30 systems in the taxonomy; deep-dives promote rows to 🟢)
- **Cross-domain** (~20 systems / mechanisms outside the taxonomy with transferable lessons — OS COW fork, build systems, distributed DBs, hardware speculative execution, real-time audio, etc.)
- **Concept** (~8 theoretical frameworks — algebraic effects theory, delimited continuations, CSP/π-calculus, Petri nets, linear types, session types, self-adjusting computation, free monads / tagless final)

**Process conventions captured in CONTEXT.md.** Added a research-level `CONTEXT.md` covering process cadence, sourcing discipline, status-indicator rules, taxonomy-maintenance rules, deep-dive structure, vocabulary, and anti-patterns. This codifies the lessons of session 1 so they apply to all future sessions without re-litigation.

**Structural change — extracted log from README.** Moved the session chronology out of `README.md` into this `LOG.md` file. Rationale: README is mostly stable structure (framing + taxonomy + index); LOG is append-only and will grow indefinitely. Separating them makes README easier to skim for current state and LOG easier to read as a chronology. CONTEXT.md updated to point at LOG.md for "read the session log first."

**State of taxonomy as of end of session.** ~50 rows, ~8 axes, 0 cells verified. Inventory is honest about its provenance (everything is 🟡 or ⚪). Open questions about axes themselves remain unresolved; some will only resolve as deep-dives reveal whether systems straddle categories or cluster cleanly.

### Threads to pick from for the next session (after session 1)

These were candidate first-deep-dives. Session 2 picked **effect-ts** (see entry below).

- **Algebraic effects** (Koka / Eff / OCaml 5): theoretical baseline; explicitly queued as session 3 in effect-ts's open questions.
- **effect-ts**: DONE in session 2.
- **Bonsai + Jane Street Incremental**: still pending.
- **Erlang/OTP**: still pending.
- **CML**: still pending.
- **Postgres MVCC + SSI**: still pending.

---

## Session 2 — 2026-05-19 — Deep-dive template + effect-ts (first deep-dive)

- Created `deep-dives/_template.md` per CONTEXT.md's "Deep-dive structure" section. Template has sections for sources, what-it-is (in our vocab), the async-coordination model, taxonomy cells (per-axis with evidence), scenario mapping (S1–S8 + Q1–Q5), encoding gain/loss analysis, open questions, cross-references.
- Conducted the first deep-dive: **effect-ts**, scoped to four axes per session 1's plan (STM conflict policy / type-system discipline / typed-value representation / structural cancellation). Other surface (Layer / Stream / Schedule / Hub / Queue / Channel / Tracer) deferred to a follow-up dive if warranted.
- Primary sources: effect.website docs (Effect type, Fibers, Scope) + effect-ts.github.io API ref (STM module). Secondary: Bogomolov blog, ZIO docs (effect-ts ports from ZIO).
- One URL gotcha: `effect.website/docs/concurrency/stm` returns 404; STM docs live at the API reference site. Captured this in the dive's notes.
- Promoted the effect-ts row in the taxonomy from 🟡 to 🟢. Cells now reflect verified content from primary sources with citations; previous summary was approximately right but missed nuances (e.g. "Effect.gen block" as atomicity granularity was wrong — STM.commit is the atomicity boundary; Effect.gen is syntactic composition, not atomic).

**Open questions surfaced by the dive** (now in README's open-questions list):

1. **Discipline-location may need sub-axes.** effect-ts uses the type system in TWO different ways: structural typing of effect signatures (`E`, `R` parameters) AND vocabulary restriction (STM combinators don't expose IO-shaped ops, so purity is enforced by absence). These are different mechanisms; the single "type-system-enforced" value flattens them.
2. **"Runtime-interpreted lazy description" as a possible value of async-state-lives.** Effects aren't really "in a graph" or "in actors" — they're interpreted state of a lazy description by the effect-ts runtime. Free monads / tagless final / OCaml 5 effect handlers may all share this shape; consider adding a value for it.
3. **Purity precondition as a possible new axis.** STM requires purity for safe retry; sagas don't; reactive computeds informally should. Worth tracking explicitly.
4. **Atomicity granularity may need to split.** effect-ts has STM-level atomicity (data consistency) AND fiber-level scope-bounded atomicity (resource lifecycle). Different concerns; flattened into one cell loses information.

**Scenario coverage for effect-ts** (filled into the dive's scenario-mapping table): S1, S3, S4, S5, S6 fully solved; S2, S7, S8 partial. The fully-solved scenarios are an honest case for effect-ts being a strong design model in this space; the partial ones (S2 "snapshot of an in-flight server payload"; S7 "optimistic survives refetch"; S8 "preview-without-commit") reveal that STM's commit-or-abort model doesn't directly express "see what would happen, then decide" semantics — Recoil's snapshot/restore is closer to that.

**Encoding gain/loss for pulse** (in the dive's "encoding into JS" section): adopting effect-ts wholesale would give typed errors, typed dependencies, STM as a transaction primitive, structural cancellation with finalizers, and effects-as-composable-values. It would cost reactive integration (effect-ts is orthogonal), ergonomic `async/await`, low-overhead direct reads, and JSX integration. The trade-off is real and architectural: effect-ts IS the canonical "encoded algebraic effects in TypeScript," and its trade-offs ARE the trade-offs of going that route.

### Threads to pick from for session 3

- **Algebraic effects theory** — DONE in session 3.
- **Bonsai + Jane Street Incremental.** Still pending.
- **A second effect-ts dive on Layer / Stream / Schedule** — still pending.
- **CML.** Still pending.
- **Haskell GHC STM.** Still pending.

---

## Session 3 — 2026-05-19 — Algebraic effects theory (concept dive)

- Conducted first concept dive: `deep-dives/algebraic-effects.md`. Per session 2's plan, the dive was grounded by asking "what does each formal construct map to in effect-ts and in pulse" — so the theory didn't float free of the concrete artifacts.
- Primary sources: Bauer & Pretnar 2012 paper (via ar5iv since raw PDF couldn't be parsed without poppler); OCaml 5 effects manual; Koka documentation + third-party blog for syntax examples. Secondary: Abramov's blog (already cited in CONTEXT), interjectedfuture.com cross-language comparison.
- Sourcing tooling note: the raw arxiv PDF couldn't be parsed by `Read` without `poppler` installed (`brew install poppler` failed due to homebrew permission issues; not pursued further). ar5iv HTML rendering worked first try. **Convention: for arxiv papers, default to the ar5iv URL** (`https://ar5iv.labs.arxiv.org/html/<id>`).

**Key findings:**

- The formal model: effects are typed operations (name + parameter + result type); handlers are bindings that intercept operations within a scope; the handler receives the continuation as a FUNCTION (`k : B → R`), enabling **multi-shot resumption** as the headline distinguishing feature.
- The grand unification: exceptions, async/await, generators, state, dependency injection, nondeterminism, cooperative threading are all instances of the same primitive with specific handler shapes.
- Implementation strategies: delimited continuations (native — OCaml 5 fibers), CPS transformation (Koka), free monads (Haskell), generator-based encoding (JS, including effect-ts and pulse).
- **JS encodings sacrifice multi-shot resumption.** JS generators are one-shot; cloning isn't available natively. Multi-shot is only achievable at coarser granularity (pulse: stage boundaries; effect-ts: `Effect.retry` from-the-top). True nondeterminism / backtracking / multi-shot generators aren't expressible in JS encodings without heavyweight machinery.
- React Suspense and pulse are BOTH in the "re-execution camp" — they look like algebraic effects from the outside but mechanically re-execute the body on resume rather than truly resuming a captured continuation.

**Sharpenings to the taxonomy axes:**

1. **Async representation** — the values (procedure / value / continuation / channel / mailbox) are best understood as a spectrum of "how first-class the captured effectful work is," from procedure (not first-class) to value (first-class but interpreted) to continuation (first-class with multi-shot capability).
2. **Discipline location** — confirmed session 2's hypothesis that this needs sub-axes. Three mechanisms exist: **structural-effect-typing** (Koka rows, effect-ts `R`), **vocabulary restriction** (STM combinators not exposing IO), **type-level continuation safety** (linear/affine types — Pony, Idris). All three currently flatten to "type-system-enforced." Recommend splitting next time a system uses one without the others.
3. **Atomicity granularity** — confirmed this is best understood per-handler, not per-system. Multi-handler systems (effect-ts has STM + Scope; pulse has effect + Loading + transition-tracker) have multiple atomicity boundaries by design.
4. **NEW axis candidate: continuation cardinality.** Values: 0-shot (exceptions); 1-shot (async/await, generators, effect-ts, pulse within-stage); multi-shot at coarse granularity (pulse across stages); multi-shot fine (Eff, Koka, Haskell `MonadCont`); runtime-enforced 1-shot (OCaml 5 deliberately). Don't add this axis yet — wait for one or two more dives to confirm it meaningfully distinguishes systems.

**Open questions surfaced** (rolled into README):

- Is multi-shot resumption useful for UI? Most demonstration examples (nondeterminism, backtracking) aren't UI patterns. Speculative debugging, preview/what-if mode (S8), time-travel state restoration might be the closest UI candidates. Worth checking deliberately during scenario reviews.
- Can pulse get the *typing benefits* of algebraic effects without the *runtime cost*? TypeScript's structural typing might allow type-level effect tracking via phantom parameters, with the runtime unchanged. Worth a design exploration session once research has more inputs.

### Threads to pick from for session 4

- **Bonsai + Jane Street Incremental.** Now genuinely the next high-value dive: addresses the orthogonality question ("reactive integration" vs "where async state lives") AND extends the algebraic-effects framing to "separate effect layer over reactive graph."
- **CML — first-class events with `choose` + `withNack`.** Direct comparison to effect-ts's `Scope`-based cancellation; would test whether the algebraic-effects framing extends to first-class concurrency events.
- **Haskell GHC STM** — to fill out the STM family beyond effect-ts; the original might surface design decisions that ZIO/effect-ts inherited silently.
- **React modern (Suspense / lanes / `use()` / `useOptimistic`).** With algebraic effects framework in hand, the dive can be precise about which of React's primitives are encoded handlers and where the encoding lossiness lies. Resolves the "WIP tree as a primitive" question from session 1.
- **A second effect-ts dive on Layer / Stream / Schedule** — defer until reactive-bridge design becomes pressing.
- **Postgres MVCC + SSI** — defer; bigger value as a focused dive when transaction-primitive design is concrete.

---

## Session 4 — 2026-05-19 — Bonsai + Jane Street Incremental (primary dive)

- Conducted the second primary deep-dive: `deep-dives/bonsai-incremental.md`. Covered Bonsai (the UI framework) and Incremental (the underlying SAC library) together because Bonsai compiles to Incremental and the trade-offs only make sense across the boundary.
- Primary sources: `janestreet/bonsai` README; the "Introducing Incremental" Jane Street blog; `bonsai_web/docs/` how-to guides (RPCs, effects-and-stale-values, edge-triggered-effects, history). Several how-tos fetched via `gh api` after WebFetch returned 404s on the docs subdirectory paths.
- Promoted Bonsai's taxonomy row from 🟡 to 🟢. The pre-dive cells were partially right but mis-stated cancellation discipline ("lifecycle-event (effect dispatch token)" — actually structural-by-component-lifetime, with an acknowledged stale-value footgun documented by Jane Street themselves).

**Key findings:**

- **Incremental** is purely synchronous self-adjusting computation — a DAG of computations re-evaluated efficiently when inputs change, via `Var.create` / `Inc.map` / `Inc.bind` / `Inc.observe` / `Inc.stabilize`. Crucially: NO async support. The Incremental blog explicitly contrasts with FRP — "SAC and FRP have different semantics — FRP is mostly concerned with time-like computations, and SAC is mostly about optimizing DAG-structured computations."
- **Bonsai** is the canonical Elm-shape over a reactive substrate. Components are purely functional state machines (`apply_action : model + action → new model`); views are Incremental computations derived from the model; effects (`Effect.t`) are dispatchable values that produce actions on completion.
- **`Effect.t` is the cleanest "effect-as-value-in-a-UI-framework" example.** Composable monadically (`let%bind.Effect`); first-class (can be stored, passed, dispatched conditionally); typed (parameterized over result type).
- **Architectural commitment:** async happens OUTSIDE the reactive graph; results land in the graph via action dispatch. The graph never "waits"; it always reflects committed state. This is distinctly different from pulse / Solid 2.x / React modern which all fuse async into the graph.

**The orthogonality question — RESOLVED.** Bonsai is the proof that "reactive integration" and "where async state lives" are distinct axes. Bonsai is simultaneously (reactive-integration: substrate is Incremental) and (where-async-state-lives: in the separate `Effect.t` layer outside Incremental). The two axes do NOT collapse. Keep them separate. The README's open-questions list has been updated to mark this resolved with a pointer to the dive.

**Sharpenings to other axes:**

- **Cancellation discipline:** the dive sharpens the distinction between "structural-by-scope with interruption guarantee" (effect-ts: post-cancellation operations are guaranteed not to fire; finalizers run) and "structural-by-component-lifetime" (Bonsai: in-flight effects can complete after their component is unmounted; dispatched actions may refer to stale state — `Bonsai.peek` is the documented workaround). These are different strengths of the same axis value. May warrant sub-values.
- **Async representation:** Bonsai confirms "typed value with monadic composition" is production-proven and distinct from "procedure" (React `useEffect`) or "generator-based effects" (effect-ts).

**Encoding gain/loss for pulse:**

- Adopting Bonsai's full architecture would mean rejecting pulse's fused-async-in-graph commitment — a different framework, not a refinement.
- Partial adoption: **`action()` as a first-class effect-as-value primitive** alongside `effect()` (procedural). Pulse's Plan C effect-stages design already gestures this way; the Bonsai dive validates it as a serious option. Production-proven at Jane Street scale.
- Bonsai's component-state-scoping with auto-management is hard to replicate in TS — OCaml's module system carries weight that TS generics can't easily mirror.

**Scenario coverage:** S1 partial (manual reducer logic), S2 yes (manual but ergonomic), S3 yes (`let%bind.Effect` composition), S4 yes (default), S5 n/a (no transactions), S6 partial (stale-value footgun), S7 yes (standard manual pattern), S8 partial (cleanly expressible).

### Threads to pick from for session 5

- **React modern (Suspense / lanes / `use()` / `useOptimistic`).** Now the highest-value next dive. With effect-ts (orthogonal) and Bonsai (separate-layer-over-reactive) characterized in detail, React modern would complete the "fused" triangulation (alongside pulse and Solid 2.x). Also resolves the "WIP tree as a primitive" axis question from session 1.
- **Solid 2.x lanes + transitions.** Could be combined with the React dive (since they're convergent designs) or done separately. Sharpens the lane-coordination axis.
- **CML — first-class events with `choose` + `withNack`.** Still pending; would test cancellation-discipline axis at a different point in the design space.
- **Haskell GHC STM** — defer; effect-ts already characterizes the STM family well enough for current research stage.
- **Concept dive: Elm Architecture proper.** Motivated by Bonsai dive — Bonsai is "Elm + reactive views"; the underlying Elm Architecture deserves its own concept treatment as a recurring design pattern (also Redux, RTK).
- **Postgres MVCC + SSI.** Still pending; defer until transaction-primitive design becomes concrete.

---

## Session 5 — 2026-05-19 — Cap'n Proto + E promise pipelining (primary dive)

- Conducted primary deep-dive: `deep-dives/capnproto-e-pipelining.md`. Covers E (the language that formalized the design) and Cap'n Proto (the industrial realization). Promotes the taxonomy row from 🟡 to 🟢.
- Primary sources: capnproto.org/rpc.html spec; Kenton Varda's 2013 blog post (calculator benchmark, "4x longer" claim); OCapN CapTP wire-level draft spec; the canonical `calculator-client.c++` from the capnproto repo (via `gh api`). Practitioner sources: Spritely's Goblins docs + "What is CapTP?" post; Wikipedia for historical attribution (Liskov & Shrira 1988 + Miller/Tribble/Jellinghaus 1989 dual-invention story).
- **Sourcing gap:** erights.org is offline (`ECONNREFUSED`); the original Mark Miller papers and `elib/distrib/pipeline.html` essay weren't reachable, and web.archive.org is blocked from this environment. The protocol-level primary sources were sufficient to characterize the mechanism precisely, but the foundational E literature is a real gap. Flagged in the dive's "Notes" for re-verification.

**Key findings:**

- The mechanism is precise: a pipelining promise is a typed handle on a future capability; **invoking a method on the unresolved promise dispatches eagerly to the eventual owner via the protocol's `answer-pos` / `desc:answer` machinery**. This is materially stronger than "promise is a value" — JS Promises are values but don't pipeline.
- Kenton Varda's distinction is the central clarification: **"Promises alone are *not* what I meant by 'time travel'!"** Pipelining is the headline; first-class promises are necessary but insufficient.
- The wire-level mechanics: the protocol uses an answer-table per RPC session; pipelined calls reference the not-yet-resolved answer-position via `desc:answer`; the server resolves the chain locally on dispatch. The whole dependent chain takes ONE network round-trip instead of N.
- Historical dual-invention: Liskov & Shrira 1988 (Argus, "call-streams" — never shipped publicly) and Miller/Tribble/Jellinghaus ~1989 (Project Xanadu). E carried the idea forward; Cap'n Proto productized it ~25 years later. JS still doesn't have it natively despite the TC39 eventual-send proposal.
- The capability-security framing (CapTP) is load-bearing for E but is overkill for a single-process reactive library. The pipelining *mechanism* is portable; the capability *discipline* mostly isn't relevant to pulse.

**Sharpenings to the taxonomy:**

1. **Async representation:** the values "first-class promise value" currently flatten two distinct designs: await-only promises (JS, classic Argus, Java futures) and pipelining promises (E, Cap'n Proto, Agoric `E()`). The headline difference is *method-invocation-on-unresolved*. Suggests a sub-distinction or a new axis.
2. **Discipline location:** Cap'n Proto pipelining is type-safe because the *IDL schema* declares interface types, not because the language's type system enforces it. This is a third kind of "typed enforcement" distinct from effect-ts's structural typing and from STM's vocabulary restriction. Strengthens the case that discipline-location needs to split by *what kind of typing* (language types / schema types / runtime invariants).
3. **Candidate axis: dependent-dispatch capability.** Values: none / explicit-then (requires resolved value) / pipelined (method on unresolved) / pipelined+typed (method on unresolved, type-checked from schema). Distinct from the session-3 continuation-cardinality candidate. **Hold pending more dives** — especially React modern, where `use()` and `<Suspense>` have related but mechanically different "before-resolution" semantics.

**Open questions raised:**

- Could pulse adopt proxy-based pipelined accessors? `use(signal<User>())` returning a proxy where `.name` is a pipelined dependent computation rather than a plain field-read. Conceptually parallel to Agoric's `E()` operator. Worth a design exploration AFTER the research surveys enough more systems.
- Does pulse's `<Loading>` boundary share semantic structure with Cap'n Proto's promise-breakage propagation? Both treat downstream-of-an-unresolved-thing as inheriting unresolved-or-broken state. Possibly the same idea at different scales — worth checking precisely.
- Is the IDL/schema layer the load-bearing piece? Without it, pipelining requires either runtime proxy reflection or unsafe ad-hoc dispatch. Suggests "schema-as-discipline-source" deserves taxonomy treatment.

**Scenario coverage:** S1 partial (vat-serial), S2 partial, S3 **yes** (the canonical case — one round-trip for an arbitrary dependent chain with automatic error propagation), S4 yes, S5 n/a, S6 partial (drop-and-gc, no interruption guarantee), S7 partial, S8 partial.

### Threads to pick from for session 6

- **React modern (Suspense / lanes / `use()` / `useOptimistic`).** Now triply-motivated: (1) completes the fused-reactive triangulation alongside pulse and Solid 2.x; (2) resolves the WIP-tree-as-primitive question from session 1; (3) tests the new candidate "dependent-dispatch capability" axis against React's `use(promise)` machinery.
- **Agoric `E()` operator + TC39 eventual-send proposal.** Now genuinely relevant: it's the JS pipelining encoding, would test whether proxy-based pipelined accessors could be a pulse direction.
- **Replicache / Linear / Rocicorp Zero** as a focused sync-engine dive. The mutation queues ARE pipelined-dependent-calls in disguise; the pipelining session 5 framing should make this dive much sharper.
- **CML** still pending. Would test the cancellation-discipline axis at a different design point.
- **Concept dive: capability security (E, ocap principles).** Lower priority — the pipelining mechanism is portable without it, and the dive surfaced no strong reason to make capability discipline central to pulse.
- **Concept dive: Elm Architecture proper.** Motivated by session 4 (Bonsai), still pending.

---

## Cross-cutting thread — message-send to receivers of various existence-states

Surfaced 2026-05-19 during reflection on session 5 (Cap'n Proto / E pipelining). Captured here as an open research thread rather than under a single dive, because it cross-cuts at least three rows of the taxonomy and may be load-bearing for eventual pulse design work.

**The observation, in two parts:**

1. **Pipelining feels like declaring a reactive graph.** Both are "build a static dependency description, hand it to a runtime, don't `await` between nodes." The key difference is **firing cardinality**: a pipelined chain fires once (build → dispatch → resolve); a reactive graph fires continuously (re-evaluate on every input change). Read as a unification: pipelining IS a reactive graph that fires once and dispatches remotely; a reactive graph IS a pipelined chain that re-fires locally on each input change. This connects to the session-3 algebraic-effects framing — both are "computation as data, runtime interprets it."

2. **Pipelining feels Smalltalk-y.** This is not a vibes-match; it's lineage. Alan Kay's definition of OO is "message-sends between encapsulated objects with late binding"; E/CapTP is literally that, generalized to "send messages to objects that don't exist yet." Miller and Tribble's work (Joule → E) sits in a direct Smalltalk-actor design lineage. Cap'n Proto's "the promise has the methods of its eventual value" (capnproto.org/rpc.html) is exactly Smalltalk's late-binding receiver, except the receiver may not have arrived yet.

**The triangle these observations form:**

| Pattern | Receiver existence-state | Binding | Firing | Dispatch locus |
|---|---|---|---|---|
| Smalltalk | exists now | late | one-shot | local |
| E / Cap'n Proto pipelining | doesn't exist yet (future capability) | late, via schema/IDL | one-shot | remote-eager |
| Reactive graphs (pulse, Solid, Incremental) | currently resolved value (re-resolved on input change) | early (typed field accessor) | continuous | local |

All three are "operate on something via a message-shaped interface, where the runtime mediates what 'where to actually dispatch' means." Pipelining sits between Smalltalk and reactive graphs on the existence-status axis. Bonsai's `Effect.t` is the message-shaped-value variant at the action layer; effect-ts's `Effect<A, E, R>` is the same idea with a richer type signature.

**Why this might be load-bearing for pulse:**

- The triangle suggests `use(x).name` in pulse is already a message-send-on-resolved-receiver — it's the third corner. The Cap'n Proto / proxy-based pipelined accessor question from the session-5 dive ("could pulse adopt proxy-based pipelined accessors?") is asking whether pulse can also do the *middle* corner — message-send-on-not-yet-resolved-receiver.
- If pulse ever has a sync-engine story, the dependency-graph-on-the-wire pattern is structurally identical to pulse's local reactive-graph pattern. The two layers (UI reactive graph + sync engine batched mutations) might compose more naturally if they share this framing rather than treating them as separate concerns.
- The "firing cardinality" axis might be a genuine taxonomy axis hiding in plain sight: one-shot pipeline vs. continuous reactive vs. discrete-event-driven (Bonsai actions, Smalltalk events). It cuts across "where async state lives" and "reactive integration" cleanly.

**What to do with this thread:**

- Hold it as a cross-cutting framing — don't promote any of it to taxonomy axes yet.
- Re-visit after the **React-modern dive** (session 6 candidate). React's `use(promise)` and `<Suspense>` are interestingly placed in the triangle — they look like the middle corner (message-send-on-not-yet-resolved) but are mechanically re-execution (session 3's framing). That will be a useful test of whether this triangle is real structure or just a metaphor.
- Re-visit after the **Replicache / sync-engine dive**. The dependency-graph-on-the-wire pattern is the testable claim here — if Replicache's mutation queues do structurally resemble pipelined dependent calls AND structurally resemble local reactive graphs, that's three datapoints for the same shape.
- If still load-bearing after those two dives, consider extracting it into a CONCEPT dive (similar to `algebraic-effects.md`) with its own deep-dive document.

**Risk to flag:** the "everything is a message-send" framing is famously *too unifying* — it dissolves real distinctions if used carelessly. The discipline check is "what does this framing predict that the alternatives don't?" If it predicts e.g. that proxy-based pipelined accessors would work as a pulse ergonomic upgrade, OR that sync-engines and reactive-graphs share an implementation strategy, those are testable. If it just feels elegant, it's a metaphor, not a structural insight.

---

## Session 6 — 2026-05-19 — React modern (primary dive)

- Conducted primary deep-dive: `deep-dives/react-modern.md`. Covers Suspense, transitions, lanes, `use`, `useOptimistic`, `useDeferredValue`, Actions / Server Functions. Promotes React-modern taxonomy row from 🟡 to 🟢.
- Primary sources: react.dev official docs (Suspense, use, useTransition, useOptimistic, useDeferredValue, Server Functions); React 18 working group discussion #27 (the 31-lane bitmask scheduler with explicit rationale for IO-bound multi-lane allocation).
- **Sourcing discipline reminder noted in the dive:** practitioner Fiber tutorials (DEV, Medium) consistently lag the official docs by years; the "throw a promise" idiom is no longer the documented API (replaced by `use(promise)`), but most third-party content still describes it that way. Only the react.dev docs were used as primary substantive sources.

**Key findings:**

- The pieces only make sense together: lanes (scheduler), WIP tree (reactive substrate), Suspense (per-boundary pending sentinel), transitions (lane-marked updates), `useOptimistic` (per-action overlay with convergence-in-same-render), Actions (unifying state+pending+optimistic+form). Pulling on any one alone misrepresents the system.
- **Re-execution as the suspension mechanism, not continuation-resumption.** From source 1: "React does not preserve any state for renders that got suspended before they were able to mount for the first time. When the component has loaded, React will retry rendering the suspended tree from scratch." Confirms session-3's framing: React is in the "encoded handlers via re-execution" camp with pulse, not in the "true continuation" camp.
- **Lane allocation strategy is the multi-transition coordination story.** 31 lanes; IO-bound transitions get multiple lanes specifically because "if we were to assign the same lane to all transitions, then one transition could effectively block all other transitions, even ones that are unrelated" (source 7). This is the structural answer that pulse and Solid 2.x both lack.
- **`useOptimistic`'s convergence-in-same-render is surgically precise.** From source 4: "There's no extra render to 'clear' the optimistic state. The optimistic and real state converge in the same render when the Transition completes." This is the textbook S7 (optimistic reconciliation) implementation; the framework guarantees no intermediate flicker frame.
- **Actions as unifying abstraction.** State + pending + optimistic + form-submission + progressive-enhancement in a single hook. Pre-Actions React required assembling this from primitives every time; the unification is real ergonomic value. Pulse lacks an equivalent.

**Resolved long-standing open questions:**

1. **WIP-tree-as-primitive (open from session 1):** YES, it's a distinct axis. Recommended name: **"speculative-state isolation."** Values: none / per-action overlay (`useOptimistic`, Recoil) / per-transition tree (React WIP, Solid 2.x lanes, pulse `<Loading>` gather) / versioned everywhere (Postgres, Yjs). Cuts cleanly across the existing isolation-level and atomicity-granularity values. README's open-questions list updated to reflect resolution.
2. **Dependent-dispatch capability axis (candidate from session 5):** React's `use(promise)` is **await-only** (re-execution after resolve, not eager-dispatch of dependent calls). React is the third datapoint; the axis distinction is real and architectural. Promote to confirmed axis after one more datapoint (likely Replicache/sync-engine dive).
3. **Message-send triangle (cross-cutting thread):** React's `use(promise)` *appears* to sit at the middle corner ("operate on not-yet-here receiver") but mechanically sits at the third corner ("currently-resolved with re-execution"). The middle corner (Cap'n Proto / Agoric `E()` style pipelining) remains uninhabited by current JS frameworks. Triangle is strengthened, not weakened.

**Sharpenings to other axes:**

- **Conflict-handling policy:** "priority-pre-empt-with-restart" is a distinct value from STM-retry, MVCC-snapshot, or Bonsai-serial-dispatch. Currently the React cell describes the mechanism but doesn't pattern-match cleanly with other systems. Consider this as a confirmed value for the conflict axis.
- **Cancellation discipline:** React has *two* cancellation strengths — structural via WIP discard for rendering, convention-only via `AbortController` for I/O effects. The current single-cell summary loses this distinction. Suggests the axis may need to track *layers* (rendering layer vs. I/O layer) per system.

**Encoding gain/loss for pulse:**

What pulse could learn from React modern:
- **Lane-based pre-emption** as the answer to multi-transition coordination. Real machinery — 31 lanes, bitmask, IO vs CPU split. Heavy to implement but the cleanest answer in JS.
- **`useOptimistic` convergence-in-same-render** as the answer to S7. Pulse's pipeline-OR `isPending` could support this with a small additional API.
- **Actions as unifying abstraction** for state+pending+optimistic+form. Pulse currently makes users assemble this.

What pulse would lose by adopting React's encoding:
- **Re-execution** as suspension mechanism — pulse's `use(x).name` doesn't re-execute the whole component, only the dependent computed. Cheaper and more compositional.
- **Behavioral discipline** rather than typed — effect-ts's compile-time enforcement is qualitatively stronger than React's runtime warnings.
- **No first-class effect-as-value** — Server Actions are just async functions; nothing to pass around / compose / conditionally dispatch.
- **The WIP tree is invisible** — for S8 (preview/what-if), this is a real limitation. Pulse's `<Loading>` boundary has the same limitation.

**Scenario coverage:** S1 partial, S2 yes, S3 partial (less ergonomic than Cap'n Proto pipelining), S4 yes-with-batching-caveat, S5 partial, S6 yes-for-rendering / partial-for-I/O, **S7 yes canonically (useOptimistic)**, S8 partial (WIP invisible).

### Threads to pick from for session 7

- **Replicache / Rocicorp Zero / Linear sync.** Now triply-motivated: (1) provides 4th datapoint to confirm "dependent-dispatch capability" axis; (2) tests the message-send triangle (sync engines build dependency graphs on the wire — pipelining-shaped); (3) tests the cross-cutting framing that "pipelining IS reactive graphs that fire once." If these systems' mutation queues structurally resemble both pipelined dependent calls AND local reactive graphs, that's strong triangulation evidence.
- **Solid 2.x lanes + transitions.** Convergent design with React; could be a shorter dive piggybacking on this session's React work. Useful for sharpening the "fused-reactive multi-transition coordination" comparison.
- **Concept dive: speculative-state isolation as an axis.** Promote the axis formally, audit all existing rows, fill cells. Pure taxonomy work — no new external system to study, just consolidation across the existing dives.
- **CML** still pending. Lower priority — would test cancellation-discipline axis but the dive-debt elsewhere is heavier.
- **Concept dive: capability security / Elm Architecture.** Lower priority.
- **Agoric `E()` + TC39 eventual-send.** Now interesting as the JS-language story for the middle corner of the triangle. Could be combined with a Replicache dive into a "JS pipelining patterns" survey.

---

## Session 7 — 2026-05-19 — Solid 2.x (`@solidjs/signals` 2.0.0-beta.13, source-code-based primary dive)

- Conducted primary deep-dive: `deep-dives/solid-2x.md`. **First dive read directly from source code** (`/Users/bigmistqke/Documents/GitHub/solid`) rather than docs. Promotes Solid 2.x taxonomy row from 🟡 to 🟢 with much sharper cells than the docs-only summary previously supported.
- Primary sources: `packages/solid-signals/src/core/{lanes,scheduler,action,async,owner,core}.ts`, `packages/solid-signals/src/boundaries.ts`, `packages/solid-signals/src/signals.ts`. The new sourcing mode (read source rather than docs) gave dramatically more precise cells.

**Correction noted post-dive:** an earlier draft of this LOG entry and the dive cited an `async-signals-proposal.md` file at the Solid repo root as evidence of "Solid's roadmap." On verification (`git status` shows the file untracked), it was actually a pulse design-exploration draft accidentally written to the wrong checkout. References removed. Lesson: **check `git status` / `git log` on any file before citing it as upstream evidence.** Added to CONTEXT.md's sourcing discipline.

**Key findings (architecturally the most intricate row in the taxonomy):**

- **Per-Override Optimistic Lane Architecture** (`lanes.ts:9-13`): "Each optimistic signal creates its own lane. Lanes merge when their dependency graphs overlap." This is **fundamentally different from React's 31-bitmask lanes** — Solid allocates per write and merges via union-find on conflict. Mechanically: `signalLanes: WeakMap<Signal, OptimisticLane>`, `activeLanes: Set`, `findLane` chains through `_mergedInto`, `mergeLanes` is union-find. **Parent-child lanes stay independent** so `isPending` resolves without waiting for parent's async (`lanes.ts:126-134`).
- **`action(function* () { yield … })` is a generator transaction** (`action.ts:18-94`). Each yield is an atomic commit point; writes between yields batch. Promise yields await with `restoreTransition` so post-await writes join the same transition. This is the closest thing in JS to "describe dependent work as a single value, runtime executes as one transaction" — same shape as Bonsai `let%bind.Effect`, effect-ts `Effect.gen`. **The local equivalent of Cap'n Proto pipelining.**
- **Three-layer atomicity** (per-yield / per-transition / per-lane independent). Distinct from any other taxonomy row. effect-ts has two layers (STM-commit + Scope); Solid has three because lanes flush independently when not blocked (`scheduler.ts:115-124`).
- **`_gatedSubs` mechanism** (`scheduler.ts:166-170`): "Subscribers that, while recomputing under an optimistic lane, read a plain signal's committed value through the entanglement gate. At commit they get rescheduled so they re-run with the new committed view." This is **explicit cross-transaction read with replay at commit** — an answer to S5 that pulse doesn't have.
- **`<Reveal>` with `sequential` / `together` / `natural` modes** (`boundaries.ts:512-+`): reveal-ordering is a **first-class reactive primitive**. Sequential = frontier reveal; together = atomic group; natural = each-on-its-own. Nested Reveals compose: inner registers as a slot in outer; outer holds inner until released. **No other taxonomy row has this primitive.**
- **Cancellation:** identity-based stale-result discard via `_inFlight` reference equality (`async.ts:188-193`); cleanup-hook iterator return for async iterables (`async.ts:258-267`); no AbortController. Same trade-off as pulse, React, Cap'n Proto.

**Comparison to React modern (session 6):**

| | Solid 2.x | React modern |
|---|---|---|
| Lanes | per-write dynamic, union-find merge | 31 fixed bitmask priorities |
| Conflict | merge-on-overlap (entanglement detection) | priority-pre-empt-with-restart |
| Optimistic | `createOptimistic` + lane override with auto-revert | `useOptimistic` per-action overlay |
| Atomicity | per-yield / per-transition / per-lane (3 layers) | per-WIP-tree-commit (1 layer) |
| Multi-transition | independent lanes flush independently | currently batched (acknowledged limitation) |
| Reveal-order | first-class `<Reveal>` primitive | implicit via Suspense nesting + useDeferredValue |
| Type discipline | runtime only (`NotReadyError` throw bypasses types) | runtime only |

**Mechanically Solid 2.x is more advanced** in entanglement detection (automatic via overlap), multi-transition coordination (independent lanes), and reveal-ordering (first-class primitive). **React modern is more advanced** in WIP-tree-as-primitive (genuine speculative parallel tree) and ergonomic unification (Actions abstraction).

**Sharpenings to taxonomy axes:**

1. **Conflict-handling policy:** "union-find lane merge with parent-child exception" is a distinct value materially different from STM-retry / MVCC-snapshot / priority-pre-empt. Add as confirmed value.
2. **Speculative-state isolation (session-6 axis):** Solid sits **between** "per-action overlay" and "per-transition tree." May need fifth intermediate value: "per-write lane overlay with overlap-merge."
3. **Dependent-dispatch capability (session-5 candidate axis):** Solid is third datapoint in "await-only with generator batching" alongside Bonsai and effect-ts. **Promote axis from candidate to confirmed** on next consolidation.
4. **Atomicity granularity:** Solid's three layers suggest "multi-layer atomicity" should be its own value, with cells potentially carrying a list of layers rather than a single granularity.
5. **Async representation:** Solid's `NotReadyError`-carries-source-identity is a precision wrinkle pulse should match — the source-node identity in the thrown error is what enables per-source pending tracking.

**Open questions raised:**

- Could pulse adopt `action(function*)` *without* lanes? The generator-as-transition-script is partially decoupled from lane machinery; pulse's gather-on-`<Loading>` could be the substrate. **Worth focused design exploration.**
- What's the runtime cost of per-write lane allocation at scale? WeakMap + Set per optimistic write; lane merging on every propagating write. Worth profiling before pulse adopts anything similar.
- `<Reveal>`'s nested-composition pattern (inner registers as slot in outer) is a fractal-coordination shape that may generalize beyond reveal-ordering. Worth a separate sketch.

**Scenario coverage:** S1 yes-better-than-React (union-find merge), S2 yes, S3 yes-ergonomically (generator action), **S4 yes-better-than-React (independent lanes don't batch)**, S5 partial-with-gated-subs-mechanism, S6 partial, **S7 yes-canonically with auto-revert (createOptimistic + action)**, S8 partial.

**New methodology note:** reading source directly was substantially more precise than docs-only. Worth doing this for any system pulse takes seriously as a design inspiration. Pre-dive estimate of "5 axes verified from docs" expanded to "9 axes verified from source" once we read the actual implementation. **Convention: source-reading is the gold standard for primary dives where the system is open-source and architecturally adjacent to pulse.**

### Threads to pick from for session 8

- **Replicache / Rocicorp Zero / Linear sync.** Still triply-motivated and now newly-relevant: Solid's `action(function*)` + `<Reveal>` gives a lens for thinking about local pipelining-shaped patterns; how do sync engines do the same thing on the wire? Strong candidate for next dive.
- **Concept dive: consolidation of the new "speculative-state isolation" axis.** Audit all existing rows against the four candidate values (now potentially five with Solid's middle-ground). Pure taxonomy work; no new system to study. Could be combined with promoting "dependent-dispatch capability" from candidate to confirmed axis.
- **Agoric `E()` + TC39 eventual-send proposal.** The JS-language story for pipelining-shape. Worth pairing with a Replicache dive into a "JS pipelining patterns" survey.
- **CML.** Still pending; would test cancellation-discipline axis. Lower priority since cancellation is well-characterized across existing dives.
- **Concept dive: Elm Architecture proper.** Lower priority.

---

## Session 8 — 2026-05-19 — Replicache (primary dive, parallel-passes methodology)

- Conducted primary deep-dive: `deep-dives/replicache.md`. Used the parallel-passes-then-merge methodology established session 7 (background agent does source-reading; main session does design-rationale + cross-system framing; merge). Promotes Replicache taxonomy row from ⚪ to 🟢 with significant cell refinements.
- Primary sources: Rocicorp docs (How Replicache Works; Adding Mutators; Subscriptions; Sync; API refs) + `rocicorp/mono/packages/replicache` source (push.ts, pull.ts, replicache.ts, replicache-impl.ts, pending-mutations.ts). The Reflect "Ready, Player Two" blog post used only for design-rationale quotes, flagged as adjacent-product.
- **Legacy-repo trap discovered and added to CONTEXT.md anti-patterns:** `github.com/rocicorp/replicache` (`pushed_at: 2022-05-07`) is a stub; real source lives in `rocicorp/mono/packages/replicache`. `gh api` calls against the old URL succeed but return dead code. Future dives should check `pushed_at` + README before deep-diving.

**Key findings (refinements to the prior 🟡 row):**

1. **"Last-write-wins (cache invalidation)" was a mischaracterization.** Corrected to **server-linearized re-execution of named mutators**. There is no LWW at the storage layer — the second execution of the mutator (under `reason: 'rebase'`) gets to do anything: no-op, validation reject, CRDT-like merge, override. The conflict-resolution policy lives in user-authored code, not the engine.
2. **Pending mutations are NOT a separate queue.** They *are* the commit-suffix between the last server snapshot and the main head in the persistent B-tree DAG (`push.ts:120-127`). Push reads them via `localMutations(mainHeadHash, dagRead)`. This is mechanically very different from "a separate queue alongside cache" — the cache IS the queue.
3. **Cancellation is lifecycle-scoped only.** One `AbortController` per Replicache instance (`replicache-impl.ts:326`) scoped to `close()`. **There is no per-mutation cancellation API.** This is a *design commitment* (mutations in a log can't be cancelled because the server may have already executed them), not a missing feature.
4. **Mutation wire form is just `{id, name, args, timestamp, clientID}`** (`push.ts:36-42`). Mutator bodies are NOT shipped — only the (name, args) pair. The client and server hold separate implementations of the same name; this is convention, not engine-enforced.
5. **`WriteTransaction.reason` is `'initial' | 'rebase' | 'authoriative'`** — a tiny but powerful primitive that lets one function distinguish first-run from replay without separating into two.
6. **Mutation log fires the subscription graph TWICE** — once on optimistic commit (`replicache-impl.ts:1595`), once on rebase if patch+replay changes the result (`replicache-impl.ts:788`). The mutation isn't a node in the reactive graph; it's a *source of pulses* for it.

**Research-question answers (all four threads):**

- **A. Dependent-dispatch capability axis (4th datapoint):** Replicache is a **fourth distinct value** — "named log of (function-name, JSON-args) pairs, sequenced by sender ID, dependent only through shared state." Mutations don't pipelined-reference each other (no value-level dataflow on the wire); locally a later mutation observes earlier effects via cumulative main-head state, but the server gets a flat list. Closer to event-sourcing / SQL-replication pattern than to Cap'n Proto pipelining. **The axis is now well-populated (4 distinct datapoints) and ready to be promoted from candidate to confirmed.**

- **B. Message-send triangle:** Replicache **sits outside the triangle, not at any corner.** The "receiver-existence-state" axis isn't load-bearing here — durability + replay cardinality are. Proposed reframing: replace the triangle with a small grid (receiver-existence × execution-cardinality). The triangle was useful as a hypothesis; Replicache is the evidence that pushes us toward a richer structure.

- **C. "Pipelining IS reactive graphs that fire once":** the framing **needs refinement, not just confirmation**. Mutation log and subscription graph are *different artifacts in one system*, related as **producer and consumer of pulses**. Not the same shape distinguished by firing cardinality — they're structurally different and complementary. The original framing was too unifying.

- **D. Speculative-state isolation axis:** Replicache provides a **new intermediate value** — "versioned engine, fixed-cardinality observable branches." The DAG would support arbitrary branches but the public API exposes only two (main, sync). Strictly stronger than "per-transition tree" (because branches are persistent and explicit) but weaker than "versioned everywhere" (because only two are observable). README open-questions entry updated to reflect five candidate values now spanning the axis.

**Sharpenings to taxonomy axes:**

1. **Dependent-dispatch capability:** now four distinct values — *await-only* / *await-only with generator batching* / *pipelined* / *named log sequenced by sender ID*. **Promote from candidate to confirmed on the next consolidation pass.**
2. **Conflict-handling policy:** sharpened — Replicache's "server-linearized re-execution" is distinct from STM-retry, MVCC-snapshot, lane-merge, priority-pre-empt-with-restart. Adds a fifth value to the axis.
3. **Speculative-state isolation:** "versioned engine, fixed-cardinality observable branches" added as fifth value. The axis now has five well-evidenced values; ready for taxonomy table promotion.
4. **Async representation:** "named-callable abstraction with split client+server implementations" is distinct from typed-value, procedure, throw-protocol, pipelined-promise.

**What pulse can learn from Replicache:**

- **The "register named function, send (name, args)" abstraction is genuinely simpler than typed RPC and gets replay for free.** Pulse's effect/action model could express durable retried work as "named handler + JSON args" without needing a structured Effect ADT — at the cost of losing type-level composition. Worth considering for the eventual sync-engine story.
- **Snapshot isolation per transaction with a separate replay branch (named heads pattern)** is the cleanest model for "optimistic vs committed" any dive has surfaced. Pulse should consider whether its `<Loading>` gather could be reframed as an explicit named-head pattern.
- **Read-set-tracked subscriptions over a key-value store** is a precedent for pulse's reactive integration when the underlying state is a cache. The crucial point: subscriptions track *what keys the body read*, not "what was returned."
- **The `reason: 'initial' | 'rebase' | 'authoriative'` field** is a tiny powerful primitive — same function, three contexts. Pulse's transitions could carry an analogous tag.
- **No per-operation cancellation is a *design commitment*, not a missing feature.** Pulse should explicitly decide: are pulse transitions cancellable once dispatched, or only retractable via compensating transitions? This is a strategic question Replicache forces clarity on.

**Methodology notes:**

- Parallel-passes-then-merge worked again, even better than session 7. The agent's source-reading caught the "pending mutations ARE the commit-suffix" insight that the docs alone don't surface; the main session's research-question prep was sharp enough that the merge was lighter than session 7 (mostly cross-references + thread updates).
- The fresh agent flagged the legacy-repo trap *during* its source-reading (it noticed the 2022 stub and pivoted to the monorepo). That kind of provenance vigilance is exactly what the parallel-passes methodology is designed to catch — added to CONTEXT.md anti-patterns.

### Threads to pick from for session 9

- **Concept dive: axis consolidation pass.** Three axes are now ready for promotion-from-candidate-to-confirmed: dependent-dispatch capability (4 values), speculative-state isolation (5 values), and arguably conflict-handling policy (5 values now). A pure-taxonomy consolidation session would audit all existing rows against these refined axes, fill in missing cells, and promote the axes to the table header. **Strong candidate for next session — this is where the research synthesis pays off.**
- **Linear sync architecture.** Now interesting as a contrast to Replicache: same problem space, different sync model. Linear publishes architecture posts. Could test whether the Replicache findings generalize.
- **Rocicorp Zero as a follow-up to this dive.** The `#zero?.advance/.trackMutation/.rejectMutation` hooks in `replicache-impl.ts` are integration surface for Zero. If Zero is "Replicache as storage engine + Zero as query/mutation lifecycle layer," it might illuminate how a sync engine evolves to support richer queries. Lower priority — Replicache is the foundation; Zero builds on it.
- **Yjs / Automerge (CRDT lineage).** The conflict-handling-policy axis now has a clear taxonomy: STM-retry / MVCC-snapshot / lane-merge / priority-pre-empt / server-linearized-replay / **CRDT-merge** (next). Yjs/Automerge would round this axis out.
- **Agoric `E()` + TC39 eventual-send.** The JS-language story for pipelining-shape. Lower priority — the Replicache dive showed that sync engines don't need pipelining to be expressive.
- **CML.** Still pending; lower priority.
- **Concept dive: Elm Architecture proper.** Still pending; lower priority.

---

## Session 9 — 2026-05-19 — Axis consolidation pass (taxonomy work, no new dive)

- Pure-taxonomy session. No new external system studied; existing dives' findings consolidated into refined and promoted axes.
- **Promoted two axes from candidate to confirmed** based on evidence from sessions 4–8:
  1. **Speculative-state isolation** (axis #9) — was open-question since session 6 (React-modern WIP-tree-as-primitive); refined by sessions 7 (Solid lanes-between-overlay-and-tree) and 8 (Replicache versioned-engine-with-fixed-cardinality-branches). Six values now well-evidenced.
  2. **Dependent-dispatch capability** (axis #10) — was candidate since session 5 (Cap'n Proto pipelining); refined by sessions 6 (React await-only), 7 (Solid generator-batching), 8 (Replicache implicit-ordering-via-sender-ID). Five values now well-evidenced.
- **Refined the conflict-handling-policy axis (#2) value vocabulary** to reflect ten distinct mechanisms surfaced across sessions 4–8, including the previously-flattened ones (priority-pre-empt-with-restart for React; lane-merge for Solid; server-linearized-replay for Replicache; OT-transformation for Figma; per-operator for RxJS).

**What was done structurally:**

- Added refined axes definitions at top of README (axes #2 expanded vocabulary; axes #9 and #10 added with full value descriptions).
- Inserted an "Extended axes (added session 9 — axis consolidation pass)" subtable in README with cells for ALL ~50 rows for the two new axes. High-confidence cells for the 6 🟢 verified rows; medium-confidence for 🟡; flagged with `?` where inferred-but-unverified.
- Marked the corresponding open-questions threads as resolved with explicit "Promoted to confirmed axis #N in session 9" notes.
- Updated continuation-cardinality candidate axis status — held as still-candidate (it may be less load-bearing for pulse than dependent-dispatch, since JS encodings collapse most cardinality distinctions).
- Captured the **message-send triangle's challenge from session 8 as an open thread** — Replicache sat outside the triangle, suggesting the triangle should become a small grid. Promoted to README open-questions list for a future synthesis session.

**The audit revealed (genuine findings, not just bookkeeping):**

1. **Six well-populated values on speculative-state isolation:** none / per-action overlay / per-write-lane overlay with merge / per-transition tree / versioned engine with fixed-cardinality observable branches / versioned everywhere. The middle two values (Solid's per-write-lane-merge and Replicache's versioned-engine) sit at uncommon corners that the original four-value sketch from session 6 had collapsed.
2. **Five well-populated values on dependent-dispatch:** await-only / await-only with implicit-ordering / await-only with generator-batching / pipelined / pipelined+typed-from-schema. **Critical insight from the audit:** most JS systems sit in the first three values; the pipelined values are uninhabited by current JS frameworks (the middle corner of the previous message-send triangle). This suggests pulse's design space is mostly in the first three; the pipelined values are aspirational for sync-engine work.
3. **Several "n/a" cells reveal axis applicability boundaries.** CML, Yjs, actor-model systems, message-bus systems all return "n/a" on dependent-dispatch because the question doesn't apply to their async-coordination model. This is a useful constraint — the axis doesn't claim universality.
4. **The two axes are clearly orthogonal.** Verified rows occupy diverse (speculative-state, dependent-dispatch) pairs: Solid (per-write-lane-merge, generator-batching); React (per-transition-tree + per-action-overlay, await-only); Cap'n Proto (n/a, pipelined+typed); Replicache (versioned-engine-fixed-cardinality, await-only with implicit-ordering); Bonsai (per-action-overlay, generator-batching); effect-ts (per-STM-commit, generator-batching). No correlation; both are pulling distinct dimensions out of what was conflated before.

**What this consolidation enables:**

- Future dives can fill cells on these axes with confidence — the value vocabulary is stable.
- Pulse design choices that touch either axis can now be located precisely in the design space (e.g. "pulse currently has per-transition-tree speculative isolation and await-only dependent dispatch" — places pulse at a specific point on a grid the research has now mapped).
- The remaining ⚪ pending rows that need axis cells are now lower-priority since the axes themselves are stable; future dives will fill cells as side effects of their primary work.

**Methodology note:** taxonomy consolidation sessions should happen when ≥2 candidate axes are well-evidenced AND the cells across rows can be filled-or-flagged honestly. Forcing a consolidation before evidence accumulates produces empty columns. Waiting too long after evidence accumulates leaves the candidate-axis list cluttered. Session 9 came at roughly the right time — 8 dives in, with three candidate axes ripe, two ready to promote.

### Threads to pick from for session 10

- **Yjs / Automerge (CRDT lineage).** The conflict-handling-policy axis (#2) now has nine distinct values; CRDT-merge is one of them but lacks a direct deep-dive. Yjs/Automerge would verify the cell. Also a meaningful contrast to Replicache (server-linearized) vs CRDT (client-converging). Now the **strongest candidate** for a next dive.
- **Synthesis session on the message-send framing.** The triangle is now formally challenged. Worth taking a synthesis session to either refine to a grid or retire it.
- **Linear sync architecture.** Now well-positioned as a contrast to Replicache; would tell us whether the "versioned engine, fixed-cardinality branches" cell is unique to Replicache or generalizes.
- **Agoric `E()` + TC39 eventual-send.** The JS-language story for the pipelined dependent-dispatch value (currently empty in JS frameworks). Would tell us whether pulse should care.
- **CML.** Still pending; the "n/a" cell on dependent-dispatch with first-class event composition is curious — would CML expand the axis or surface a new dimension?
- **Concept dive: Elm Architecture proper.** Lower priority.
- **Concept dive: capability security.** Lower priority.

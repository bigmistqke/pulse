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

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

### Threads to pick from for the next session

These are candidate first-deep-dives, roughly ordered by "how much they would refine the taxonomy itself":

- **Algebraic effects** (Koka / Eff / OCaml 5): not in the taxonomy as a system, but the framework all the others can be partially understood as encodings of. A deep-dive on the actual semantics of perform/handle/resume would clarify "what each system is approximating."
- **effect-ts**: heavy use of types + Effect.gen + STM. Would validate whether "typed value" and "type-system-enforced" are separate axes or one.
- **Bonsai + Jane Street Incremental**: the cleanest "separate effect layer over a reactive graph" example. Would help split "reactive integration" from "where async state lives."
- **Erlang/OTP**: the longest-running production async system. Would test whether our axes apply outside the JS-world assumptions.
- **CML**: first-class events with `choose` + `withNack`. Would test whether "async representation" is rich enough as a category.
- **Postgres MVCC + SSI**: the longest-living transaction implementation. Would test whether our "isolation level" categories are sufficient.

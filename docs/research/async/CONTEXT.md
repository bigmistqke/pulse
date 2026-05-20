# Async Research — Lexicon

The lexicon for the async-coordination research: canonical definitions of the
terms used across [`README.md`](./README.md), [`LOG.md`](./LOG.md), the
[`deep-dives/`](./deep-dives/), and the synthesis docs. When a term is defined
here, other docs reference it rather than re-glossing — this file is the single
source so definitions do not drift.

> **Note on the name.** `CONTEXT.md` was previously the research *process* doc.
> That content now lives in [`PROCESS.md`](./PROCESS.md). `CONTEXT.md` is now the
> lexicon — consistent with the project convention where `CONTEXT.md` holds
> domain language (cf. the root [`../../CONTEXT.md`](../../CONTEXT.md)).
> References to "CONTEXT.md" in older `LOG.md` entries and deep-dives that
> concern sourcing discipline, status indicators, or anti-patterns mean
> `PROCESS.md`.

---

## The four dimensions of transitions

A *transition* (see below) is coordination machinery for committing an async
state change atomically. Transitions branch along four structural dimensions —
the axes a transition mechanism must each decide how to handle. The framing
originated in the [`LOG.md`](./LOG.md#cross-cutting-thread--transitions-branch-in-four-dimensions) cross-cutting thread "Transitions branch
in four dimensions" (sessions 11–13); it is the organizing axis of
[`pulse-design-direction.md`](./pulse-design-direction.md)'s comparison table and
of [`transitions-problem-space.md`](./transitions-problem-space.md).

- **Dim 1 — internal branching.** A single transition contains a *tree* of
  dependent async work — one logical change fans out into several fetches, some
  of which may depend on others' results. The mechanism gathers all of it and
  commits the whole tree together.
- **Dim 2 — concurrent transitions.** More than one transition is in flight at
  the same time — two independent logical changes, each with its own internal
  tree.
- **Dim 3 — input-arrival priority.** New input arrives *while* a transition is
  still in flight. The newer intent should pre-empt, supersede, or be sequenced
  against the older one.
- **Dim 4 — state-overlap (entanglement).** Two concurrent transitions touch the
  same state. Their commit order — or their mutual discard — must be decided.

**Dim 1 is the irreducible core.** A transition exists to gather one logical
change's async work and commit it atomically; that is Dim 1 alone. Dims 2–4 exist
only because a system may permit more than one transition at once: Dim 2 is two
at once, Dim 3 is one pre-empting another, Dim 4 is two touching shared state. A
mechanism that allows only one transition at a time needs only Dim 1. See
[`transitions-problem-space.md`](./transitions-problem-space.md) for worked
examples and the full argument.

## The four failure modes

The user-visible defects that occur *without* a transition mechanism. Each is
defined and worked through with concrete examples in
[`transitions-problem-space.md`](./transitions-problem-space.md); the one-line
forms below exist for cross-doc reference.

- **FM1 — torn state.** The UI renders a frame mixing old and new data because
  the several async fetches of one logical change resolve at different times and
  each is shown as it lands. (Exercises Dim 1.)
- **FM2 — spinner flash.** A loading fallback appears and vanishes within a few
  frames because the boundary drops to the fallback the instant anything goes
  pending, even when the work resolves almost immediately. (Exercises Dim 1.)
- **FM3 — lost interactivity.** The committed-but-stale UI freezes, strobes, or
  loses input focus while async work is in flight, instead of staying live and
  responsive. (Exercises Dim 1 + Dim 3, and Dim 2 if stale work is not
  cancelled.)
- **FM4 — uncommittable speculation.** A transition's in-progress state cannot be
  abandoned without corrupting committed state, so a superseded change or a
  cancelled preview leaves the UI inconsistent. (Exercises Dim 2 + Dim 4.)

## Core transition terms

- **Transition.** Coordination machinery that makes a state change involving
  async work commit atomically — the UI moves from one coherent state to another,
  never showing an incoherent in-between — while staying responsive during the
  wait.
- **Gather.** Collecting all the pending async work in a transition's scope and
  holding every resulting commit until the whole set is ready, so the commits
  land together. Pulse's `<Loading>` boundary is a gather.
- **Commit / atomic commit.** The moment a gathered set of changes becomes
  globally visible, all at once. Nothing inside the transition is observable
  until the commit.
- **Hold-prior.** A display policy during a gather: keep showing the last
  coherent committed state rather than a fallback, so fast async work does not
  cause a spinner flash (FM2).
- **Fallback.** The placeholder a boundary shows when there is no prior coherent
  state to hold — i.e. a genuine first load.

## Research vocabulary

Terms used precisely across the research; their use elsewhere in pulse may be
looser.

- **Encoding** — a JS implementation that approximates a primitive from another
  language/system. Always lossy. The set of "encodings of model X into JS" is
  the design space the research explores.
- **Transferable lesson** — an insight from a domain or system that informs
  pulse's design even if pulse won't adopt the system itself. Cross-domain
  deep-dives exist to extract these.
- **Reactive integration** (axis) — whether async work is part of the reactive
  computation graph or runs alongside it.
- **Discipline location** (axis) — where the rules are enforced: runtime, type
  system, programmer convention, or capability system.
- **Scenario** — a concrete user/dev situation any async strategy must handle
  correctly. The catalog is
  [`../scenarios/concurrent-flows.md`](../scenarios/concurrent-flows.md)
  (S1–S8).
- **Policy question** — a design decision a transaction primitive must answer
  explicitly. Catalogued as Q1–Q5 in the same scenarios doc.
- **Axis** — one column of the taxonomy table in [`README.md`](./README.md). A
  dimension along which async-coordination strategies meaningfully differ. New
  axes emerge from deep-dives; they are not declared up front.
- **System** — one row of the taxonomy table. An async-coordination strategy
  that competes in pulse-adjacent design space.
- **Verified cell** — a taxonomy cell whose content has been checked against
  primary sources in a deep-dive. Marked by the row's 🟢 status.
- **Cross-domain** — a system or mechanism that does NOT compete in pulse's
  design space (different problem, layer, or scale) but has transferable
  lessons.
- **Concept** — a theoretical framework that affects how systems are interpreted
  (algebraic effects theory, delimited continuations, CSP, …). Concept
  deep-dives sharpen the lens rather than taxonomizing systems.
- **Open question** — a known unresolved issue in the framework or in the
  research's understanding. Documented in the README's open-questions section;
  resolved as deep-dives provide evidence.

## See also

- [`PROCESS.md`](./PROCESS.md) — how the research is conducted: cadence, sourcing
  discipline, status indicators, taxonomy maintenance, deep-dive structure,
  anti-patterns. (Formerly named `CONTEXT.md`.)
- [`README.md`](./README.md) — framing, the taxonomy table, the deep-dive index.
- [`LOG.md`](./LOG.md) — append-only session chronology; origin of the
  four-dimensions framing.
- [`transitions-problem-space.md`](./transitions-problem-space.md) — the four
  failure modes worked through with concrete examples.
- [`pulse-design-direction.md`](./pulse-design-direction.md) — synthesis of the
  research into pulse design positions.
- [`../../CONTEXT.md`](../../CONTEXT.md) — pulse's root domain-language doc; this
  lexicon is the async-research counterpart.

# Async Research — Lexicon

The lexicon for the async-coordination research: canonical definitions of the
terms used across [`README.md`](./README.md), [`LOG.md`](./LOG.md), the
[`deep-dives/`](./deep-dives/), and [`transitions-problem-space.md`](./transitions-problem-space.md).
When a term is defined here, other docs reference it rather than re-glossing —
this file is the single source so definitions do not drift.

> **Note on the name.** `CONTEXT.md` was previously the research *process* doc.
> That content now lives in [`PROCESS.md`](./PROCESS.md). `CONTEXT.md` is now the
> lexicon — consistent with the project convention where `CONTEXT.md` holds
> domain language (cf. the root [`CONTEXT.md`](../../../CONTEXT.md)).
> References to "CONTEXT.md" in older `LOG.md` entries and deep-dives that
> concern sourcing discipline, status indicators, or anti-patterns mean
> `PROCESS.md`.

This lexicon is scoped to the *research arc*: cross-framework async-coordination
vocabulary, the transitions sub-thread that emerged from the research, and the
process vocabulary the deep-dives use. Pulse's own naming and primitives —
including pulse's adopted term *speculation* for what this doc calls
*transition* — live in [`../../pulse/CONTEXT.md`](../../pulse/CONTEXT.md).

---

## The four dimensions of transition

A *transition* (see below) is coordination machinery for committing an async
state change atomically: a tentatively-applied write-set held over committed
state, observable to reads, eventually committed or discarded as a unit.
Transitions branch along four structural dimensions — the axes a transition
mechanism must each decide how to handle. The four are the non-trivial corners
of the partition `{one, many} × {disjoint, overlapping} × {concurrent,
sequential}`. The framing originated in the [`LOG.md`](./LOG.md#cross-cutting-thread--transitions-branch-in-four-dimensions)
cross-cutting thread "Transitions branch in four dimensions" (sessions 11–13);
it is the organizing axis of [`transitions-problem-space.md`](./transitions-problem-space.md).
Each dimension carries the question its mechanism must answer.

- **Dim 1 — Internal structure of one transition.** What lives *inside* a single
  scope: dependent async work (a → b → c — one logical change fans out into
  several fetches, some depending on others), intermediate writes visible
  mid-flight, multi-step composition, partial failure. *Mechanism question:* what
  coherence guarantee does the scope make about its own contents?
- **Dim 2 — Concurrence (disjoint).** N transitions alive at once, touching
  *disjoint* state. *Mechanism question:* can N genuinely-independent concurrent
  transitions run without serialization or mutual interference?
- **Dim 3 — Supersession.** A newer intent arrives while a prior transition is
  in-flight; the newer invalidates the older. *Mechanism question:* pre-empt the
  old, serialize the new, or race their commits? (React's priority lanes are one
  implementation of supersession, not the dim itself — newer-wins-on-identity
  and cancel-via-Drop are equally valid structural answers.)
- **Dim 4 — Overlap (entanglement).** N concurrent transitions touch *shared*
  state. *Mechanism question:* at commit time, auto-merge (Solid-style dep-graph
  union-find), batch-merge on source-set intersection (Svelte), isolate /
  last-commit-wins, or user-specified?

**Why these four.** The partition `{one, many} × {disjoint, overlapping} ×
{concurrent, sequential}` has four non-trivial corners:

- *one* alive → Dim 1 (everything internal collapses into a single scope).
- *many, disjoint, concurrent* → Dim 2 (the easy engineering case: keep them
  truly independent).
- *many, sequential* → Dim 3 (supersession is the only non-trivial way
  "sequential" matters — coexistence requires concurrence).
- *many, overlapping, concurrent* → Dim 4 (the hard case).

Dim 1 is the irreducible core. A transition exists to gather one logical
change's async work and commit it atomically; that is Dim 1 alone. A mechanism
that allows only one transition at a time needs only Dim 1. See
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
  responsive. (Exercises Dim 1 + Dim 3, and Dim 2 if stale work continues
  uncancelled alongside the newer transition.)
- **FM4 — uncommittable transition.** A transition's in-progress state cannot
  be abandoned without corrupting committed state, so a superseded change or a
  cancelled preview leaves the UI inconsistent. (Exercises Dim 3 + Dim 4.)

## Core transition terms

- **Transition.** Coordination machinery that makes a state change involving
  async work commit atomically — the UI moves from one coherent state to
  another, never showing an incoherent in-between — while staying responsive
  during the wait. The field's term across React, Solid, Svelte. Pulse renames
  this concept *speculation* (see [`../../pulse/CONTEXT.md`](../../pulse/CONTEXT.md))
  for symmetric success/failure framing; this lexicon uses the field's term.
- **Gather.** Collecting all the pending async work in a transition's scope and
  holding every resulting commit until the whole set is ready, so the commits
  land together.
- **Commit / atomic commit.** The moment a gathered set of changes becomes
  globally visible, all at once. Nothing inside the transition is observable
  until the commit.
- **Hold-prior.** A display policy during a gather: keep showing the last
  coherent committed state rather than a fallback, so fast async work does not
  cause a spinner flash (FM2).
- **Fallback.** The placeholder a boundary shows when there is no prior coherent
  state to hold — i.e. a genuine first load.

## Research vocabulary

Terms used precisely across the research.

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
- [`../../pulse/CONTEXT.md`](../../pulse/CONTEXT.md) — pulse-specific jargon
  (speculation, walks, slots, recipes, scopes, the named library primitives).
- [`../../../CONTEXT.md`](../../../CONTEXT.md) — pulse's repo-root domain-language doc.

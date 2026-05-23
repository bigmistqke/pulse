# Pulse — research

Exploration of pulse's reactive substrate and speculation machinery.
Framings are durable as exploration directions; implementation sketches
are illustrative; design calls are deliberate.

## Contents

- [Documents](#documents)
- [Reading order](#reading-order)
- [What we're exploring](#what-were-exploring)
- [Threads to continue](#threads-to-continue)
- [Cross-references](#cross-references)

## Documents

- **[prior-art.md](./prior-art.md)** — cross-framework analysis: comparison
  of React / Svelte / Solid mechanics, seven-concerns decomposition, the
  signal=node+value-bag recasting, and the empirical pattern across studied
  frameworks (including Solid's transition-machinery trajectory).
- **[framings.md](./framings.md)** — the current understanding:
  foundational principles ([P1](./framings.md#p1--speculation-is-one-concept-with-two-faces)–[P5](./framings.md#p5--compose-dont-proliferate-in-either-direction)), operational framings, falsified
  hypotheses, engine + library sketches.
- **[questions.md](./questions.md)** — open questions ([Q1](./questions.md#q1--fall-through-and-edge-policy) through [Q14](./questions.md#q14--action-prereqs--standing-state-handle)):
  sub-questions from traces, deliberate design calls, framing gaps.
- **[scenarios.md](./scenarios.md)** — the catalog (TDD basis): ~83
  architecturally-distinct cases the engine + speculation machinery needs
  to handle.
- **[scenario-traces.md](./scenario-traces.md)** — end-to-end traces of
  the scenarios that have been verified (eight so far; all pass).

## Reading order

Fresh reader: **framings.md** is the operational core — start there.
Reach for **prior-art.md** when you want the background that motivates
the framings. **scenarios.md** + **scenario-traces.md** are the verification
surface. **questions.md** is the to-do list.

## What we're exploring

Pulse's user-facing `Signal<T>` and `Computed<T>` are **graph relations,
not values** — `Node<() => T | Promise<T>>`, an identity in the dep graph
wrapping a recipe (a callback that produces the value). The value is not
_in_ the Node; it is what you get by handing the Node to a _walk_
primitive. The library ships named patterns and named walks (`signal`,
`compute`, `effect`, `get`, `latest`, `use`, `isPending`, `subscribe`) as
approachable DX over a slim engine that knows only about graph, slots,
recipes, edges, and notification. Users who want their own semantics over
the graph can reach the engine; the default surface stays approachable.
Speculation is one _use_ of this stack — scope-tagged slots, walk policies
that consult them — not a built-in engine concept.

## Threads to continue

Roughly priority-ordered:

- _[Q1](./questions.md#q1--fall-through-and-edge-policy) resolved — Model 1 (engine-managed chains)._ Selected on the
  "lean on r3" criterion: minimal-possible delta from r3's fire loop (one
  chain-match predicate). Next: verify by tracing more cases —
  supersession, nested scopes, late-bound subscribers — and push on
  remaining sub-questions (indexing, dropped-slot races) when they start
  mattering.
- _Trace `doubleName`-under-scope-S end-to-end through this stack._ Verifies
  the falsified hypothesis is genuinely fixed by multi-slot + the
  engine-side chain-match predicate; exercises [Q1](./questions.md#q1--fall-through-and-edge-policy) and [Q5](./questions.md#q5--recipe--cache-asymmetry-between-signal-and-computed-slots) along the
  way. (Partial trace already in [Q1](./questions.md#q1--fall-through-and-edge-policy); a full end-to-end with engine and
  library calls would catch remaining holes.)
- _Consumer abstraction ([Q3](./questions.md#q3--consumer-patterns))._ Once edges and slots are clear, the consumer
  shape determines how Effect/JSX-binding/Computed-cache compose.
- _Scope/Owner unification ([Q2](./questions.md#q2--scopeowner-unification))._ Likely the cleanest answer; needs verifying
  against effect lifecycle and dispose-on-discard discipline.
- _Async ([Q4](./questions.md#q4--async-at-the-engine-level))._ Mostly downstream of [Q3](./questions.md#q3--consumer-patterns) — once consumers are known, async
  re-run discipline can be pinned.

---

## Cross-references

- **Research arc:** [`../async/README.md`](../async/README.md) taxonomy + [`../async/LOG.md`](../async/LOG.md) chronology + [`../async/deep-dives/`](../async/deep-dives/) per-system analyses.
- **Lexicon:** [`../async/CONTEXT.md`](../async/CONTEXT.md) — canonical definitions of the four dimensions, the failure modes, and research vocabulary.
- **Problem space:** [`../async/transitions-problem-space.md`](../async/transitions-problem-space.md) — the four failure modes worked through with concrete examples.
- **Dives most directly informing this document:**
  - [`../async/deep-dives/react-modern.md`](../async/deep-dives/react-modern.md)
  - [`../async/deep-dives/solid-2x.md`](../async/deep-dives/solid-2x.md) — the per-node multi-slot architecture pulse is structurally converging on (with a different user-facing surface).
  - [`../async/deep-dives/svelte-5.md`](../async/deep-dives/svelte-5.md)
  - [`../async/deep-dives/bonsai-incremental.md`](../async/deep-dives/bonsai-incremental.md) — the "separate effect layer over reactive substrate" reference point.
  - [`../async/deep-dives/xilem-druid.md`](../async/deep-dives/xilem-druid.md) — "structural cancellation via Drop" + "Loading-primitive-is-more-valuable-in-JS" findings.
  - [`../async/deep-dives/replicache.md`](../async/deep-dives/replicache.md) — the "sidestep branching via server-linearized replay" alternative.
- **r3 source** (`node_modules/r3/src/index.ts`) — the substrate this exploration is rooted in; the topological scheduling + push-pull-push fallback machinery carries forward into the pulse-forked engine.

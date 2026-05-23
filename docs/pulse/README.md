# Pulse — research

Exploration of pulse's reactive substrate and speculation machinery.
Framings are durable as exploration directions; implementation sketches
are illustrative; design calls are deliberate.

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
*in* the Node; it is what you get by handing the Node to a *walk*
primitive. The library ships named patterns and named walks (`signal`,
`compute`, `effect`, `get`, `latest`, `use`, `isPending`, `subscribe`) as
approachable DX over a slim engine that knows only about graph, slots,
recipes, edges, and notification. Users who want their own semantics over
the graph can reach the engine; the default surface stays approachable.
Speculation is one *use* of this stack — scope-tagged slots, walk policies
that consult them — not a built-in engine concept.

## Threads to continue

Roughly priority-ordered:

- *Working candidate for [Q1](./questions.md#q1--fall-through-and-edge-policy) (selectors-on-edges).* Architecture has a
  plausible framing now. Next: verify by tracing more cases — supersession,
  nested scopes, late-bound subscribers — and push on [Q1](./questions.md#q1--fall-through-and-edge-policy)'s sub-questions
  (indexing, dropped-slot races, async resolution as a write event) when they
  start mattering.
- *Trace `doubleName`-under-scope-S end-to-end through this stack.* Verifies
  the falsified hypothesis is genuinely fixed by multi-slot + Model 2 edges;
  exercises [Q1](./questions.md#q1--fall-through-and-edge-policy) and [Q5](./questions.md#q5--recipe--cache-asymmetry-between-signal-and-computed-slots) along the way. (Partial trace already in [Q1](./questions.md#q1--fall-through-and-edge-policy); a full
  end-to-end with engine and library calls would catch remaining holes.)
- *Consumer abstraction ([Q3](./questions.md#q3--consumer-patterns)).* Once edges and slots are clear, the consumer
  shape determines how Effect/JSX-binding/Computed-cache compose.
- *Scope/Owner unification ([Q2](./questions.md#q2--scopeowner-unification)).* Likely the cleanest answer; needs verifying
  against effect lifecycle and dispose-on-discard discipline.
- *Async ([Q4](./questions.md#q4--async-at-the-engine-level)).* Mostly downstream of [Q3](./questions.md#q3--consumer-patterns) — once consumers are known, async
  re-run discipline can be pinned.

---

## Cross-references

- **Research arc:** [`../research/async/README.md`](../research/async/README.md) taxonomy + [`../research/async/LOG.md`](../research/async/LOG.md) chronology + [`../research/async/deep-dives/`](../research/async/deep-dives/) per-system analyses.
- **Lexicon:** [`../research/async/CONTEXT.md`](../research/async/CONTEXT.md) — canonical definitions of the four dimensions, the failure modes, and research vocabulary.
- **Problem space:** [`../research/async/transitions-problem-space.md`](../research/async/transitions-problem-space.md) — the four failure modes worked through with concrete examples.
- **Dives most directly informing this document:**
  - [`../research/async/deep-dives/react-modern.md`](../research/async/deep-dives/react-modern.md)
  - [`../research/async/deep-dives/solid-2x.md`](../research/async/deep-dives/solid-2x.md) — the per-node multi-slot architecture pulse is structurally converging on (with a different user-facing surface).
  - [`../research/async/deep-dives/svelte-5.md`](../research/async/deep-dives/svelte-5.md)
  - [`../research/async/deep-dives/bonsai-incremental.md`](../research/async/deep-dives/bonsai-incremental.md) — the "separate effect layer over reactive substrate" reference point.
  - [`../research/async/deep-dives/xilem-druid.md`](../research/async/deep-dives/xilem-druid.md) — "structural cancellation via Drop" + "Loading-primitive-is-more-valuable-in-JS" findings.
  - [`../research/async/deep-dives/replicache.md`](../research/async/deep-dives/replicache.md) — the "sidestep branching via server-linearized replay" alternative.
- **r3 source** (`node_modules/r3/src/index.ts`) — the substrate this exploration is rooted in; the topological scheduling + push-pull-push fallback machinery carries forward into the pulse-forked engine.

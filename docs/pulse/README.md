# Pulse — research

Exploration of pulse's reactive substrate and speculation machinery. Framings are durable as exploration directions; implementation sketches are illustrative; design calls are deliberate.

## Contents

- [Documents](#documents)
- [Reading order](#reading-order)
- [What we're exploring](#what-were-exploring)
- [Threads to continue](#threads-to-continue)
- [Cross-references](#cross-references)

## Documents

- **[CONTEXT.md](./CONTEXT.md)** — the lexicon: canonical definitions of pulse-specific terms (speculation, action, scope, node / slot / edge, the read walks, and `Awaitable`).
- **[prior-art.md](./prior-art.md)** — cross-framework analysis: comparison of React / Svelte / Solid mechanics, seven-concerns decomposition, the signal=node+value-bag recasting, and the empirical pattern across studied frameworks (including Solid's transition-machinery trajectory).
- **[framings.md](./framings.md)** — the current understanding: foundational principles ([P1](./framings.md#p1--speculation-is-one-concept-with-two-faces)–[P5](./framings.md#p5--compose-dont-proliferate-in-either-direction)), operational framings, falsified hypotheses, engine + library sketches.
- **[questions.md](./questions.md)** — open questions ([Q1](./questions.md#q1--fall-through-and-edge-policy) through [Q15](./questions.md#q15--entanglement-dim-4-overlapping-speculations-on-shared-state)): sub-questions from traces, deliberate design calls, framing gaps.
- **[scenarios.md](./scenarios.md)** — the catalog (TDD basis): ~83 architecturally-distinct cases the engine + speculation machinery needs to handle.
- **[scenario-traces.md](./scenario-traces.md)** — end-to-end traces of the scenarios that have been verified (eleven so far; all pass).
- **Focused explorations:**
  - **[failure.md](./failure.md)** — failure & discard: the discard-cause taxonomy, per-cause lifecycle hooks, the two retry primitives, and the body-local `onCommit`/`onDiscard` pair.
  - **[optimistic-ui.md](./optimistic-ui.md)** — optimistic UI as tagged-leakage speculation; the `optimistic()` wrapper shape.
  - **[concurrent-divergence.md](./concurrent-divergence.md)** — entanglement (Dim 4): scenario classes A–H, isolate-by-default, `onConflict: 'reject'`, and the prior-art lineage (OCC / SSI / STM / CRDT).
  - **[async-reads-and-coordination.md](./async-reads-and-coordination.md)** — the uniform `Awaitable` read model (`.value` / `yield*` / `use` faces; supersedes [ADR 0002](../adr/0002-pending-model.md)'s write-back) and the consumer-side `settled([...])` coordination barrier on stale-while-revalidate.

## Reading order

Fresh reader: **framings.md** is the operational core — start there. Reach for **prior-art.md** when you want the background that motivates the framings. **scenarios.md** + **scenario-traces.md** are the verification surface. **questions.md** is the to-do list.

## What we're exploring

Pulse's user-facing `Signal<T>` and `Computed<T>` are **graph relations, not values** — `Node<() => T | Promise<T>>`, an identity in the dep graph wrapping a recipe (a callback that produces the value). The value is not _in_ the Node; it is what you get by handing the Node to a _walk_ primitive. The library ships named patterns and named walks (`signal`, `compute`, `effect`, `get`, `committed`, `use`, `isPending`, `subscribe`, `settled`) as approachable DX over a slim engine that knows only about graph, slots, recipes, edges, and notification. Users who want their own semantics over the graph can reach the engine; the default surface stays approachable. Speculation is one _use_ of this stack — scope-tagged slots, walk policies that consult them — not a built-in engine concept.

## Threads to continue

Roughly priority-ordered. The earlier engine-shape threads are now resolved and traced — [Q1](./questions.md#q1--fall-through-and-edge-policy) chains, the `doubleName` trace, consumer patterns ([Q3](./questions.md#q3--consumer-patterns)), scope/owner unification ([Q2](./questions.md#q2--scopeowner-unification)), async at the engine level ([Q4](./questions.md#q4--async-at-the-engine-level)); see [questions.md](./questions.md) and [scenario-traces.md](./scenario-traces.md). What's live now:

- _CRDT signal-values (class B / [Q15](./questions.md#q15--entanglement-dim-4-overlapping-speculations-on-shared-state))._ The one genuinely-open design item from entanglement: how a signal expresses "merge, don't replace" on commit. Design-shaped, not yet pinned; CRDT / local-first prior art in [concurrent-divergence.md](./concurrent-divergence.md#prior-art).
- _Preview / what-if._ The [Scope-does-two-jobs aside](./concurrent-divergence.md#a-conceptual-aside--scope-is-doing-two-jobs)'s lifecycle overload — "a speculation that never commits" is expressible but overloads the commit/discard lifecycle. The one conceptual gap flagged across the scenario work (S8).
- _Implementation edges for [`async-reads-and-coordination.md`](./async-reads-and-coordination.md)._ Whether a settled `Awaitable` is cached per read; confirming `settled([...])` reaches a refetching input's in-flight promise; naming (`settled` / `stable` / `frame`).
- _Take the design to `src/`._ The read model + `settled` + `'reject'` are designed against the sealed engine; implementing against the actual r3-forked engine is the next build step.

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

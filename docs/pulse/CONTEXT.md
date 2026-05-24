# Pulse — Lexicon

The lexicon for the pulse research docs: canonical definitions of pulse-specific terms used across [`README.md`](./README.md), [`prior-art.md`](./prior-art.md), [`framings.md`](./framings.md), [`questions.md`](./questions.md), [`scenarios.md`](./scenarios.md), and [`scenario-traces.md`](./scenario-traces.md).

This file covers terms whose meaning is _pulse-specific_ — the engine and library primitives, the named patterns, the renamings pulse adopts. Cross-framework async-coordination vocabulary (transition, gather, the four dimensions, the four failure modes, encoding, transferable lesson) lives in [`../async/CONTEXT.md`](../async/CONTEXT.md) and is referenced from here rather than re-defined.

**Companion documents:**

- [`framings.md`](./framings.md) — where most of these terms are introduced and motivated. This lexicon is the index; framings is the argument.
- [`../async/CONTEXT.md`](../async/CONTEXT.md) — the cross-framework lexicon pulse builds on.

## Contents

- [Speculation and its two faces](#speculation-and-its-two-faces)
- [Engine primitives](#engine-primitives)
- [Walks](#walks)
- [Async](#async)
- [Library patterns](#library-patterns)
- [Scope](#scope)
- [Stages and actions](#stages-and-actions)
- [See also](#see-also)

---

## Speculation and its two faces

- **Speculation.** Pulse's term for what the field (React / Solid / Svelte) calls a _transition_ — see [`../async/CONTEXT.md`](../async/CONTEXT.md) for the cross-framework definition. Pulse renames the concept to make the discard-on-failure case as legible as the commit-on-success case: a speculation either commits or is discarded; "transition" presupposes the commit, "speculation" is neutral. The CPU branch-speculation mental model imports load-bearingly, not analogically.
- **Action.** The write-side face of speculation. A scope opened around a body of writes; the writes are tentatively applied into the action's slots and committed atomically (or discarded) as a unit. See [`framings.md`'s P1](./framings.md#p1--speculation-is-one-concept-with-two-faces).
- **Speculative zone.** The read-side face of speculation. A scope inside which reads consult the speculative slot first, falling through to committed state on miss. Same machinery as an action, viewed from the read side. (P1.)

## Engine primitives

- **Node.** The graph identity. `Node<() => T | Promise<T>>` — a Node _is_ an identity in the dep graph wrapping a **recipe** (a callback that produces the value). The value is not _in_ the Node; it is what you get by handing the Node to a [walk](#walks). Signals and computeds are both Nodes; the difference is the recipe shape and the cache discipline.
- **Recipe.** The callback attached to a Node that produces the Node's value. Plain function, generator, or stage-list. Re-runs when invalidated.
- **Slot.** A per-(Node, scope) cache cell. Holds the cached value for that Node _within that scope_. Per [Q6](./questions.md#q6--what-is-a-scope-as-a-value), slots live on the scope (`scope.slots: Map<Node, Slot>`), not on the node. Multi-slot per Node is the structural fix for the speculation cache asymmetry; storing them on the scope makes disposal explicit.
- **Edge.** A `{ source: Node, target: Slot, targetScope: Scope }` triple. Per [Q1](./questions.md#q1--fall-through-and-edge-policy)'s resolution (Model 1 — engine-managed chains), the engine derives the chain from `targetScope` at fire time; no closures, no captured chain. Edges live in `scope.edges` (cleanup tracker) and are indexed for write-fire via `source.subs: Set<Edge>`.
- **Chain-match.** The engine-side predicate that decides whether a write to `(node, writeScope)` should fire an edge whose target lives in some scope `S`. True iff `writeScope` is in `chainFor(S)` and no more-specific scope in the chain currently has a slot for `node`. This is the entire delta from r3's fire mechanism.

## Walks

A _walk_ is a read primitive: a function that takes a Node and consults the active scope's bag (and possibly the recipe) to produce a value. Walks are first-class — the library ships named walks as approachable DX over the engine. See [`framings.md`'s walks framing](./framings.md#walks-are-first-class).

- **`get(node)`** — the unified read walk. Returns `T` for sync nodes and `Awaitable<U>` for `Node<Promise<U>>`. Used by computeds, effects, and the JSX binding alike.
- **`peek(node)`** — non-tracking read. Currently under review for removal; see [`questions.md`](./questions.md).
- **`latest(node)`** — returns the last committed value, bypassing the active speculation's slot.
- **`use(node)`** — React-style throw-to-suspend at the leaf. See [`framings.md`'s `use()` section](./framings.md#use-is-react-style-throw-to-suspend-at-the-leaf).
- **`isPending(node)`** — whether the node currently has unresolved async work in the active scope.
- **`subscribe(node, fn)`** — imperative external subscription.

## Async

- **`Awaitable<T>`.** A `Promise<T>` subclass that adds (a) `[Symbol.iterator]` so it can be `yield*`ed inside generator stages and action bodies, and (b) React-convention `{status, value, reason}` fields for synchronous inspection after resolution. One type covers three call-site shapes: sync read of a resolved value, async wait, and generator wait. See [`framings.md`'s Awaitable section](./framings.md#awaitablet--one-type-three-legitimate-uses).

## Library patterns

The library ships named patterns over the engine. All of them are _consumer patterns_ over Nodes — the underlying abstraction is shared; the names exist for DX.

- **`signal(value)`** — a Node whose recipe is "return the last written value." The write-populated slot.
- **`compute(recipe)`** / **Computed.** A Node whose recipe derives from other Nodes via walks. The read-populated slot.
- **`effect(fn)`** — a consumer pattern that runs `fn` on changes. Not a Node; a leaf consumer.
- **`onCleanup(fn)`** — registers a teardown to run when the surrounding scope disposes or the consumer re-runs.

The four constructs _signal / computed / effect / JSX-expression_ are framed as [the same primitive](./framings.md#signal--computed--effect--jsx-expression-are-all-the-same-primitive) distinguished only by where the consumer lives.

## Scope

- **Scope.** The ambient context primitive. Owns its `slots`, `edges`, `writeSet`, `readSet`, `cleanups`, `children`, and a `parent` pointer. Closing a scope (commit or discard) walks these explicitly — no GC reliance for correctness. Per [Q6](./questions.md#q6--what-is-a-scope-as-a-value). Pulse's exploration unifies _scope_ and _owner_ (see [Q2](./questions.md#q2--scopeowner-unification)) — an "owner scope" is just a scope with no slot writes.
- **`kind: 'owner' | 'speculative'`.** Library metadata set at scope creation. `action(...)` opens speculative; component scopes / `createRoot` open owner. Engine doesn't branch on it. Library uses it to enforce invariants — most notably, `effect(...)` throws if any ancestor scope is `'speculative'` (per [Q3](./questions.md#q3--consumer-patterns)).
- **`ROOT_SCOPE`.** A parentless scope the library creates by default — the "outside any speculative context" world. Engine doesn't special-case it; multiple disjoint roots (per-tenant, per-document) are supported by constructing additional parentless scopes.
- **`chainFor(scope)`.** Walks `scope.parent` pointers until `undefined`, returning the scope chain from most-specific to terminal. Used by the engine's chain-match predicate and by fall-through reads.
- **WriteSet / ReadSet.** Per-scope `Set<Node>` tracking which nodes the scope wrote to (for commit promotion, per [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally) lean ii) and which it read from (for slot drop on close).
- **Commit / discard.** Terminal operations: commit promotes `writeSet` slots to the parent scope; both drop all `slots` and `edges` the scope holds. Discard additionally fires `cleanups`.

## Stages and actions

- **Stage.** One step of a computed's transform pipeline. A computed's recipe is a list of stages; each stage's callback is plain _or_ generator. The generator form lets a stage `yield* get(asyncNode)` to park on async work and resume when it resolves. Per-stage memoization is load-bearing — see [`framings.md`'s stages section](./framings.md#computeds-are-stages-with-plain-or-generator-callbacks).
- **Action body.** Generator-based for a different reason than a stage: an action body sequences writes and async waits but isn't memoized. See [`framings.md`'s action-body framing](./framings.md#action-bodies-are-generator-based-for-different-reasons).

## See also

- [`README.md`](./README.md) — index and reading order for the pulse research docs.
- [`framings.md`](./framings.md) — where the terms above are introduced with full motivation.
- [`questions.md`](./questions.md) — open questions that touch many of these terms ([Q1](./questions.md#q1--fall-through-and-edge-policy) on edges, [Q2](./questions.md#q2--scopeowner-unification) on scope/owner, [Q3](./questions.md#q3--consumer-patterns) on the consumer abstraction, [Q4](./questions.md#q4--async-at-the-engine-level) on async at the engine level).
- [`../async/CONTEXT.md`](../async/CONTEXT.md) — the cross-framework lexicon (transition, gather, four dimensions, four failure modes, research vocabulary).

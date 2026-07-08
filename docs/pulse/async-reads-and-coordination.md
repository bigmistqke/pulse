# Async reads and coordination — the uniform `Awaitable` and `settled([...])`

A design landed through the entanglement exploration ([`concurrent-divergence.md`](./concurrent-divergence.md)): starting from "how would pulse do Solid's union-lane merge?" and ending at two decisions — a uniform async **read model** and a consumer-side **coordination barrier** that ride on pulse's existing stale-while-revalidate behaviour.

This doc is design, not specification; the recommendations are current leans, and one of them (the read model) **supersedes part of [ADR 0002](../adr/0002-pending-model.md)** — flagged explicitly below.

**Companion documents:**

- [`../adr/0002-pending-model.md`](../adr/0002-pending-model.md) — the shipped pending model this refines (pending-is-a-value, `use`, write-back).
- [`concurrent-divergence.md`](./concurrent-divergence.md) — where the coordination question came from (isolate-by-default vs Solid's merge).
- [`../async/cross-framework-scenarios.md`](../async/cross-framework-scenarios.md) — the resume-vs-re-execute framing and the per-scenario comparison.
- [`CONTEXT.md`](./CONTEXT.md) — lexicon; the read verbs and `Awaitable` are defined there.

## Contents

- [How we got here](#how-we-got-here)
- [Part 1 — The read model: `s()` is always an `Awaitable`](#part-1--the-read-model-s-is-always-an-awaitable)
- [Part 2 — The coordination barrier: `settled([...])` on stale-while-revalidate](#part-2--the-coordination-barrier-settled-on-stale-while-revalidate)
- [What this deliberately does not do](#what-this-deliberately-does-not-do)
- [Lexicon deltas](#lexicon-deltas)
- [Open questions](#open-questions)

---

## How we got here

The question was "Solid auto-merges two concurrent async edits that touch a shared node (union-find lane merge); how would pulse do that?" The exploration disaggregated Solid's merge into the concerns it bundles and found:

- **Isolation** is already pulse's answer, structurally — multi-slot-per-Node ([Q1](./questions.md#q1--fall-through-and-edge-policy) / [Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)) gives each speculation its own slot for a node, so two speculations never *collide* at a node the way Solid's single-lane-per-computation model does. Solid must merge because a computation belongs to one lane; pulse doesn't, because a node has a slot per scope. The "peek at each other" that Solid's merge produces is an *emergent symptom* of that storage choice, not a feature to port.
- **Coordination** is the part that survives as a real want: a shared consumer (a preview) depending on several async inputs should not flash through half-updated frames — keep the last coherent frame, then swap atomically once all inputs settle. This is a *rendering* barrier on the consumer; the edits stay independent (no shared fate, no cascade-discard).

Designing the barrier surfaced the read model underneath it, so this doc covers both.

## Part 1 — The read model: `s()` is always an `Awaitable`

**Decision.** The read's type mirrors the body. A **synchronous** signal or derived reads as bare `T` — `signal(5)` → `T`, `derived(() => a() + b())` → `T`. An **async** one reads as [`Awaitable<T>`](./CONTEXT.md#async), and *uniformly so*: it stays `Awaitable<T>`, it does **not** flip to a bare `T` once resolved. So `derived(async () => …)` → `Awaitable<T>`; `derived(() => …)` → `T`. This keeps the async colour visible in the type ([ADR 0004](../adr/0004-propagate-async-color.md)) while making the async read one uniform shape (rather than a `T | Promise<T>` union that must be narrowed).

An `Awaitable<T>` is a `Promise<T>` subclass carrying `{ status, value, reason }` for synchronous inspection and `[Symbol.iterator]` for `yield*`. So the single uniform return has three faces, and those faces *are* the "resolve" verbs:

```ts
s()          // → Awaitable<T>   always. chainable + inspectable.
s().value    // → T | undefined  synchronous peek (undefined while pending) — the SWR / skeleton read
yield* s()   // → T              await it (composition, inside another derived/stage)
use(s)       // → T              suspend-to-boundary if pending (terse UI read)
```

**Why uniform, not a union.** The cost that sank the alternatives is *narrowing*. A union `T | Promise<T>` forces every call site to branch on "is this a value or a promise?" — a viral obligation ([ADR 0004](../adr/0004-propagate-async-color.md)'s colouring problem), and the fact that the promise case is rare at runtime does not reduce the static burden. A uniform `Awaitable<T>` removes the branch: it is *always* the same shape, so you pick a *face* by what you need, not by inspecting what you got. Friction moves from conditional narrowing (viral) to uniform unwrapping (predictable).

**Why not hide the promise (`s() → T | undefined`).** Tempting for UI ergonomics, but it breaks *composition*: to derive one async value from another you must be able to await it, and you cannot await a `T | undefined` (awaiting a non-promise is a no-op, so the dependent derived computes on `undefined`). The promise must stay reachable from the read. Uniform `Awaitable` keeps it reachable (via `yield*`) while `.value` still gives the non-blocking sync read — so `T | undefined` survives as a *face* (`s().value`), not as the base type.

**The trilemma, and which corners this picks.** Reading an async value forces a choice among honest-types · terse-reads · no-throwing — pick two ([ADR 0002](../adr/0002-pending-model.md)). Uniform `Awaitable` keeps **honest** (the type admits pending via `.status`) and **no-throw by default** (`.value` / `yield*` never throw for pending; only `use` opts into suspension). Terseness is the opt-in corner: `use(s)` for `use(s).name`.

### Supersedes ADR 0002's write-back

[ADR 0002](../adr/0002-pending-model.md) specifies a value that is `T | Promise<T>` with **write-back on settle** — the held promise flips to a bare `T` once resolved, so a signal's value at any instant is *either* a settled `T` *or* a pending `Promise<T>`. This doc **replaces that with uniform `Awaitable`**: the read stays `Awaitable<T>` forever; settlement fills in `.value` / `.status` rather than flipping the type. The rest of ADR 0002 stands — pending is still a value, `use` is still the opt-in throw, errors still throw to boundaries. Only the *union-with-write-back* surface changes to *uniform-Awaitable*, motivated by the narrowing/viral cost of the union.

The trade of the change: a resolved read is still a wrapper (a small allocation; the value is reached via `.value`), and it is an open edge whether purely-*synchronous* signals also wrap or stay bare `T` (see [Open questions](#open-questions)).

## Part 2 — The coordination barrier: `settled([...])` on stale-while-revalidate

**The problem.** A shared consumer (a preview) depends on several inputs that recompute asynchronously, driven by independent edits. It should keep showing the last coherent frame and swap to the new one atomically only once *all* inputs have settled — never a torn, half-updated frame.

**The mechanism — almost entirely existing parts.** One new combinator plus behaviour pulse already ships:

```ts
const preview = derived(() => {
  const [a, b] = yield* settled([A, B])   // wait for ALL inputs to settle
  return render(a, b)
})

preview().value   // → frame | undefined   consumer read: SWR keep-last; undefined only on first load
use(preview)      // or: suspend to a boundary instead of keeping the stale frame
```

- **`settled([A, B])`** — the one new piece: a *wait-for-all* combinator, the plural form of `yield* s()`. It awaits all its inputs' `Awaitable`s together and resolves to the tuple once every one has settled (≈ `Promise.all` over the reads). Used *inside* the recipe, it makes the new frame appear atomically.
- **Stale-while-revalidate (already the default** — [ADR 0002](../adr/0002-pending-model.md), `makeStageNode`'s `lastResolvedValue`, per [`../solid-2x-comparison.md`](../solid-2x-comparison.md) §2.4**)** does the keep-last: while the recipe is parked awaiting `settled`, the computed keeps serving its last frame, so consumers keep seeing it. No new keep-last machinery.
- **`preview().value`** handles first load natively: `undefined` before any frame exists (show a skeleton), the stale frame during refetch, the fresh frame once settled.
- **`isPending([A, B])`** (already shipped) gives the "updating…" indicator over the retained frame.
- **`use(preview)`** is the *blocking* cousin — suspend to a fallback instead of holding a stale frame, for when stale data would be wrong rather than merely old.

**Division of labour.** `settled` coordinates *inside* the recipe (wait-for-all → atomic new frame); SWR + `.value` keep-last *outside* at consumers. Two roles, cleanly separated — which is why bundling them (as Solid's merge does) obscured the design.

**Why this is safe where Solid's merge is fraught.** The barrier is *consumer-side* and *read-only*: the preview coordinates itself by watching its own inputs' readiness; it never writes based on another speculation's in-flight value, so there is no cascade-discard hazard. The edits stay fully independent (no shared fate). The consumer does not even need to know its inputs came from separate, dynamically-overlapping speculations — it just watches whether they are ready.

## What this deliberately does not do

- **No cross-transition "peek" / merge.** Letting one speculation read another's in-flight values is Solid's answer to a problem pulse's multi-slot storage does not have; porting it would re-introduce the collision just to merge it back. Every legitimate case collapses into an existing tool — a real dependency → nest ([nested actions](./scenario-traces.md#g2--nested-actions-and-commit-promotion)); a read-only preview → this barrier; live collaboration → CRDT values ([`concurrent-divergence.md`](./concurrent-divergence.md#prior-art)). So it is deliberately absent.
- **No shared fate.** This is a *rendering* barrier, not a transactional one. Overlapping edits commit and roll back independently; only the *display* is coordinated. Transactional coupling remains explicit and opt-in via nested actions.

## Lexicon deltas

Proposed changes to [`CONTEXT.md`](./CONTEXT.md), to apply on approval:

- **`Awaitable` read model** — `get`/`s()` returns `Awaitable<T>` uniformly (not `T | Awaitable`, not `T | Promise<T>` with write-back). Document `.value` / `yield*` / `use` as its three faces.
- **Add `settled([...])`** — wait-for-all combinator; the plural form of `yield* s()`.
- **`latest` → `committed`** — the isolation-axis verb (last committed value, bypassing the active speculation) is currently named `latest` in `CONTEXT.md`, which **clashes with the shipped `latest`** (a *readiness*-axis stale read, per [`../solid-2x-comparison.md`](../solid-2x-comparison.md)) *and* with Solid's `latest`. Rename the isolation verb to `committed`; it aligns with `commit` / `discard` / `onCommit` / `onDiscard`.
- **Readiness `latest` subsumed** — with SWR default, `s().value` already returns the stale value during refetch, so a distinct readiness-`latest` is redundant; `.value` is the stale read.

## Open questions

- **Naming.** `settled` / `stable` / `frame` for the wait-for-all combinator — cosmetic; defer to ergonomic feedback.
- **`.value` and genuine `undefined` — resolved.** `s().value → T | undefined` is terse and accepts the ambiguity, but the `Awaitable` already carries `.status` (`'pending' | 'fulfilled' | 'rejected'`) to disambiguate on the same object: `.value === undefined` with `.status === 'fulfilled'` is a genuine `undefined`; with `.status === 'pending'` it is not-ready. (An `.isResolved` convenience boolean is just `.status !== 'pending'`.) So `.value` is the terse read; `.status` is the disambiguator — no sentinel required.
- **Resolved-`Awaitable` allocation.** An async read stays a wrapper even after settling; whether the `Awaitable` for a settled value is cached/reused per read is an implementation edge to pin. (The related question — do purely-*synchronous* signals wrap? — is resolved: they stay bare `T`; the read type mirrors the body.)
- **`settled` and refetch promises.** `settled` must await the *in-flight* promise of a refetching input, which under SWR is tracked out-of-band from the stored stale value. Confirm `settled` reaches it (via the node's pending state, not via `.value`).

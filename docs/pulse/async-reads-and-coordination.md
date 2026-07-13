# Async reads and coordination — the plain-`Promise` read model and `settled([...])`

A design landed through the entanglement exploration ([`concurrent-divergence.md`](./concurrent-divergence.md)): starting from "how would pulse do Solid's union-lane merge?" and ending at two decisions — a uniform async **read model** and a consumer-side **coordination barrier** that ride on pulse's existing stale-while-revalidate behaviour.

This doc is design, not specification. The coordination barrier (Part 2) is a current lean; the read model (Part 1) has since been decided in [ADR 0012](../adr/0012-weakmap-backed-promise-read-model.md), which **supersedes part of [ADR 0002](../adr/0002-pending-model.md)** and replaces the `Awaitable` subclass this doc originally proposed with a plain `Promise<T>`. Part 1 below is updated to match.

**Companion documents:**

- [`../adr/0002-pending-model.md`](../adr/0002-pending-model.md) — the shipped pending model this refines (pending-is-a-value, `use`, write-back).
- [`concurrent-divergence.md`](./concurrent-divergence.md) — where the coordination question came from (isolate-by-default vs Solid's merge).
- [`../async/cross-framework-scenarios.md`](../async/cross-framework-scenarios.md) — the resume-vs-re-execute framing and the per-scenario comparison.
- [`CONTEXT.md`](./CONTEXT.md) — lexicon; the read verbs are defined there.

## Contents

- [How we got here](#how-we-got-here)
- [Part 1 — The read model: an async read is a plain `Promise`](#part-1--the-read-model-an-async-read-is-a-plain-promise)
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

## Part 1 — The read model: an async read is a plain `Promise`

**Decision** ([ADR 0012](../adr/0012-weakmap-backed-promise-read-model.md)). The read's type mirrors the body. A **synchronous** signal or derived reads as bare `T` — `signal(5)` → `T`, `derived(() => a() + b())` → `T`. An **async** one reads as a plain [`Promise<T>`](./CONTEXT.md#async), and *uniformly so*: it stays `Promise<T>`, it does **not** flip to a bare `T` once resolved. So `derived(async () => …)` → `Promise<T>`; `derived(() => …)` → `T`. (Refinement: the async colour folds across the whole pipeline, and a *conditionally*-async stage — one that may return a value or a promise — reads as the honest union `Promise<T> | U` rather than being coerced. The raw read is honest to the runtime; the verbs resolve it. See [ADR 0012](../adr/0012-weakmap-backed-promise-read-model.md#refinement--the-read-is-runtime-honest-the-verbs-resolve-it).) This keeps the async colour visible in the type ([ADR 0004](../adr/0004-propagate-async-color.md)) while making the async read one uniform shape.

The read is an ordinary `Promise<T>` — not a subclass, and it carries no extra fields. Its status (pending / fulfilled / rejected), its resolved value, its rejection reason, and its stale-while-revalidate prior live in one WeakMap keyed on the promise. You do not read those off the promise; you read them through verbs, and the verbs *are* the faces of an async read:

```ts
s()             // → Promise<T>     always. chainable; the value to pass on or compose.
latest(s)       // → T | undefined  the stale value without suspending (undefined until first settle) — the SWR / skeleton read
yield* read(s)  // → T              await it (composition, inside another derived/stage)
use(s)          // → T              suspend-to-boundary if pending (terse UI read)
```

**Why uniform, not a union.** The cost that sank the alternatives is *narrowing*. A union `T | Promise<T>` forces every call site to branch on "is this a value or a promise?" — a viral obligation ([ADR 0004](../adr/0004-propagate-async-color.md)'s colouring problem), and the fact that the promise case is rare at runtime does not reduce the static burden. A uniform `Promise<T>` removes the branch: it is *always* the same shape, so you pick a *verb* by what you need, not by inspecting what you got. Friction moves from conditional narrowing (viral) to uniform unwrapping (predictable).

**Why not hide the promise (`s() → T | undefined`).** Tempting for UI ergonomics, but it breaks *composition*: to derive one async value from another you must be able to await it, and you cannot await a `T | undefined` (awaiting a non-promise is a no-op, so the dependent derived computes on `undefined`). The promise must stay reachable from the read. Returning the plain `Promise<T>` keeps it reachable (via `yield* read`) while `latest(s)` still gives the non-blocking stale read — so `T | undefined` survives as a *verb* (`latest(s)`), not as the base type.

**The trilemma, and which corners this picks.** Reading an async value forces a choice among honest-types · terse-reads · no-throwing — pick two ([ADR 0002](../adr/0002-pending-model.md)). This model keeps **honest** (the type is `Promise<T>`, so pending is visible in the colour) and **no-throw by default** (`latest` / `yield* read` never throw for pending; only `use` opts into suspension). Terseness is the opt-in corner: `use(s)` for `use(s).name`.

**Where the state lives.** One WeakMap keyed on the promise holds `{ status, value, reason }` and the stale prior. It is the single carrier — and it is the same map the generator driver already uses to fast-forward past settled yields, so the read state and the driver's memory are one mechanism, not two. The carrier was chosen by benchmark ([carrier-benchmark.ts](./carrier-benchmark.ts)): a `Promise` subclass is the heaviest; a symbol-tag is the fastest but mutates promise shapes; a WeakMap is the uniform one that works on any promise without touching it — and at realistic read rates the difference between them is negligible, so uniformity won.

### Supersedes ADR 0002's write-back

[ADR 0002](../adr/0002-pending-model.md) specifies a value that is `T | Promise<T>` with **write-back on settle** — the held promise flips to a bare `T` once resolved, so a signal's value at any instant is *either* a settled `T` *or* a pending `Promise<T>`. [ADR 0012](../adr/0012-weakmap-backed-promise-read-model.md) **replaces that with a uniform plain `Promise<T>`**: the read stays `Promise<T>` forever; settlement records `status` / `value` in the WeakMap rather than flipping the type. The rest of ADR 0002 stands — pending is still a value, `use` is still the opt-in throw, errors still throw to boundaries. Only the *union-with-write-back* surface changes, motivated by the narrowing/viral cost of the union.

The trade of the change: an async read stays a `Promise` even after settling, so its value is reached through a verb (`latest` / `use` / `yield* read`) rather than by looking at the object. Purely-*synchronous* signals stay bare `T` — the read type mirrors the body.

## Part 2 — The coordination barrier: `settled([...])` on stale-while-revalidate

**The problem.** A shared consumer (a preview) depends on several inputs that recompute asynchronously, driven by independent edits. It should keep showing the last coherent frame and swap to the new one atomically only once *all* inputs have settled — never a torn, half-updated frame.

**The mechanism — almost entirely existing parts.** One new combinator plus behaviour pulse already ships:

```ts
const preview = derived(() => {
  const [a, b] = yield* settled([A, B])   // wait for ALL inputs to settle
  return render(a, b)
})

latest(preview)   // → frame | undefined   consumer read: SWR keep-last; undefined only on first load
use(preview)      // or: suspend to a boundary instead of keeping the stale frame
```

- **`settled([A, B])`** — the one new piece: a *wait-for-all* combinator, the plural form of `yield* read(s)`. It awaits all its inputs together and resolves to the tuple once every one has settled (≈ `Promise.all` over the reads). Used *inside* the recipe, it makes the new frame appear atomically.
- **Stale-while-revalidate (already the default** — [ADR 0002](../adr/0002-pending-model.md), `makeStageNode`'s `lastResolvedValue`, per [`../solid-2x-comparison.md`](../solid-2x-comparison.md) §2.4**)** does the keep-last: while the recipe is parked awaiting `settled`, the computed keeps serving its last frame, so consumers keep seeing it. No new keep-last machinery.
- **`latest(preview)`** handles first load natively: `undefined` before any frame exists (show a skeleton), the stale frame during refetch, the fresh frame once settled.
- **`isPending([A, B])`** (already shipped) gives the "updating…" indicator over the retained frame.
- **`use(preview)`** is the *blocking* cousin — suspend to a fallback instead of holding a stale frame, for when stale data would be wrong rather than merely old.

**Division of labour.** `settled` coordinates *inside* the recipe (wait-for-all → atomic new frame); SWR + `latest` keep-last *outside* at consumers. Two roles, cleanly separated — which is why bundling them (as Solid's merge does) obscured the design.

**Why this is safe where Solid's merge is fraught.** The barrier is *consumer-side* and *read-only*: the preview coordinates itself by watching its own inputs' readiness; it never writes based on another speculation's in-flight value, so there is no cascade-discard hazard. The edits stay fully independent (no shared fate). The consumer does not even need to know its inputs came from separate, dynamically-overlapping speculations — it just watches whether they are ready.

## What this deliberately does not do

- **No cross-transition "peek" / merge.** Letting one speculation read another's in-flight values is Solid's answer to a problem pulse's multi-slot storage does not have; porting it would re-introduce the collision just to merge it back. Every legitimate case collapses into an existing tool — a real dependency → nest ([nested actions](./scenario-traces.md#g2--nested-actions-and-commit-promotion)); a read-only preview → this barrier; live collaboration → CRDT values ([`concurrent-divergence.md`](./concurrent-divergence.md#prior-art)). So it is deliberately absent.
- **No shared fate.** This is a *rendering* barrier, not a transactional one. Overlapping edits commit and roll back independently; only the *display* is coordinated. Transactional coupling remains explicit and opt-in via nested actions.

## Lexicon deltas

Proposed changes to [`CONTEXT.md`](./CONTEXT.md), to apply on approval:

- **Plain-`Promise` read model** — `get`/`s()` returns a plain `Promise<T>` uniformly for an async read (not `Awaitable`, not `T | Promise<T>` with write-back), with state in one WeakMap. Document `latest` / `yield* read` / `use` as its three faces.
- **Add `settled([...])`** — wait-for-all combinator; the plural form of `yield* read(s)`.
- **`latest` → `committed`** — the isolation-axis verb (last committed value, bypassing the active speculation) is currently named `latest` in `CONTEXT.md`, which **clashes with the shipped `latest`** (a *readiness*-axis stale read, per [`../solid-2x-comparison.md`](../solid-2x-comparison.md)) *and* with Solid's `latest`. Rename the isolation verb to `committed`; it aligns with `commit` / `discard` / `onCommit` / `onDiscard`.
- **Readiness `latest` is the stale read** — with no `.value` field on the read, `latest(s)` is the verb that returns the stale value during refetch (`undefined` until first settle). This reverses the earlier plan to subsume it into `.value`.

## Open questions

- **Naming — resolved.** Shipped as `settled` (`src/async.ts`), used as `yield* settled([A, B])` inside a generator stage.
- **Genuine `undefined` vs not-ready — resolved.** `latest(s)` returns `T | undefined` and accepts the ambiguity; `isPending(s)` disambiguates: `latest(s) === undefined` with `isPending(s) === false` is a genuine `undefined`, whereas `isPending(s) === true` is not-ready. So `latest` is the terse read and `isPending` is the disambiguator — no field on the object, no sentinel required.
- **Carrier allocation — resolved.** An async read is a plain `Promise<T>` with state in one WeakMap; there is no per-read wrapper to cache. The carrier was picked by benchmark ([carrier-benchmark.ts](./carrier-benchmark.ts)); see [ADR 0012](../adr/0012-weakmap-backed-promise-read-model.md). (The related question — do purely-*synchronous* signals wrap? — is resolved: they stay bare `T`; the read type mirrors the body.)
- **`settled` and refetch promises — resolved.** `settled` awaits each refetching input's *in-flight* promise through the pending registry (`isPending` / `promiseOf`), not the stale value the raw read returns under stale-while-revalidate, so the frame it produces is genuinely fresh. Implemented and covered by `test/settled.test.ts` (a partial settle holds the barrier; a refetch re-coordinates). A settled rejection propagates via `Promise.all`.

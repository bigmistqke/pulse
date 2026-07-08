# Read-model migration notes — shipped model vs uniform `Awaitable`

Study for [Plan 6](../superpowers/plans/2026-07-08-speculation-engine-06-read-model-study.md): what the async read model looks like in code today (`src/computed.ts`, `src/async.ts`, `src/signal.ts`, `src/pending.ts`), and what migrating to the uniform-`Awaitable` model ([`async-reads-and-coordination.md`](./async-reads-and-coordination.md), superseding [ADR 0002](../adr/0002-pending-model.md)) actually touches. Decision: [ADR 0011](../adr/0011-uniform-awaitable-adapter-migration.md).

## The shipped model in one paragraph

Promise *state* lives in **side WeakMaps**, not on values. `async.ts`: `track(p)` maintains a `states` WeakMap (`pending`/`fulfilled`/`rejected`); `latest(s)` reads `s()`, `track`s a promise value, and returns the fulfilled value or the last one from a `lastResolved` WeakMap (SWR); `use(x)` returns the value or throws `NotReadyYet(promise)`. `computed.ts`: each stage is an r3 computed (`makeStageNode`) with an **out-of-band `publishedValue` signal** as the view value, a `lastResolvedValue` closure (SWR, sentinel `UNRESOLVED`), `pendingSig` (feeds `isPending`), `suspendOn`+settle handlers, and two resumption modes (`fast-forward` for generators via a `kick` signal; `reuse-value` for sync/async via a stash). `signal.ts`: stores `T | Promise<T>` as-is. So the model's semantics — SWR, pending, suspend-on-read — are all implemented, but the *state* is scattered across WeakMaps + an out-of-band signal + closures.

## Probe answers

**1. State relocation — onto the `Awaitable`.**
- `async.ts` `states` WeakMap (per-promise pending/fulfilled/rejected) → `Awaitable.status` / `.value` / `.reason`. State moves onto the object.
- `async.ts` `lastResolved` WeakMap (SWR prior value, per accessor) → the **prior resolved value seeded onto the pending `Awaitable`'s `.value`** (SWR built into the object: a pending `Awaitable` created during a refetch carries the last settled value in `.value`, `status: 'pending'`).
- `computed.ts` `publishedValue` signal → **eliminated**; the stage's view value *is* the `Awaitable`.
- `computed.ts` `lastResolvedValue` closure → the `Awaitable.value`.
- `pendingSig` → keep as the reactive indicator, but sourced from `.status === 'pending'` (see probe 4).

**2. Where the `Awaitable` is created — a single `toAwaitable` wrap at two boundaries.**
- `signal.ts` setter, when the written value is a promise (currently `track(value)`) → wrap in an `Awaitable` (seeded with the prior resolved value for SWR).
- `computed.ts` when `runStage` returns a pending outcome (`outcome.promise`) and on the `NotReadyYet` catch path → wrap in an `Awaitable`.
- One helper (`toAwaitable(promise, prior?)`) covers both; first-load has no prior (`.value` undefined until settle).

**3. `.value` subsumes `latest`; `committed` is new.** `latest(` has **no `src/` callers** — only `test/async.test.ts` and `test/integration-async.test.ts` (and the public export). So the readiness `latest(s)` maps to `s().value`, and — because it is public — `latest` can be **kept as a thin alias over `.value`** for backward-compat rather than a breaking removal. The *isolation* read `committed(s)` is a **new** verb (from the scope overlay, `src/scope.ts`) with no existing callers to migrate. So: `latest` → alias of `.value` (readiness, compat-preserving); `committed` → new (isolation).

**4. `use` under `Awaitable` — same behavior, sourced from `.status`.** `use(x)` still returns the value or throws `NotReadyYet(promise)`; it reads `x.status === 'pending'` off the `Awaitable` instead of the `states` WeakMap. The JSX/Loading suspension path is unchanged (it still catches `NotReadyYet`). `isPending`/`promiseOf` (`pending.ts`) likewise derive from `.status` and the `Awaitable` itself (which *is* the promise).

**5. `computed.ts` pipeline — mostly survives.** Survives unchanged: the r3 dep-tracker computed (dep tracking), the two resumption modes (`fast-forward`/`reuse-value` — they concern *re-running the stage on settle*, orthogonal to where state lives), `pendingSig` as an indicator. Replaced: the out-of-band `publishedValue` signal (the `Awaitable` is the view); the `lastResolvedValue` closure (`Awaitable.value`); `Object.is` change-gating stays but compares `.value` (and interacts with [ADR 0008](../adr/0008-signals-dedupe-writes-by-object-is.md)). `suspendOn`/settle still wires `.then`, but writes the `Awaitable`'s `status`/`value` rather than `publishedValue`.

**6. Scheduling + constraining tests.** Moving state onto the `Awaitable` does not change r3 scheduling — the dep-tracker r3 computed is untouched. The behavior spec (must stay green through the migration) is `test/async.test.ts`, `test/pending.test.ts`, `test/computed.test.ts`, `test/effect-stages.test.ts`, `test/integration-async.test.ts`, `test/integration-async-pipeline.test.ts`. These pin SWR, pending, suspend, and the two resumption modes.

**7. Speculation-in-computed is cleaner after this migration.** On the new model a computed's view is an `Awaitable` produced by its recipe, so the overlay's speculative-compute path (`runRecipe` under a scope, Plan 3) can produce a *speculative* `Awaitable` into a scope slot uniformly. On the old model the view is spread across the `publishedValue` signal + WeakMaps + r3, which is far harder to redirect per-scope. So **read-model migration (Plan 7) before speculation-in-computed (Plan 8)**.

## What the findings imply

The uniform-`Awaitable` model is not new *semantics* — pulse already does SWR, pending, and suspend. It is a **state-relocation**: move `status`/`value`/`reason` and the SWR prior value off the side WeakMaps + out-of-band `publishedValue` signal and onto one `Awaitable` object, created at two wrap points, with `latest` kept as a `.value` alias and `committed` added new. The proven pipeline (dep-tracker, resumption modes) survives. That points at the **adapter** approach; decision in [ADR 0011](../adr/0011-uniform-awaitable-adapter-migration.md).

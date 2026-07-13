# Migrate to the uniform `Awaitable` read model via a state-relocation adapter

> **Superseded by [ADR 0012](./0012-weakmap-backed-promise-read-model.md).** The
> uniform read surface stands, but the carrier changed: an async read is a plain
> `Promise<T>` with state in one WeakMap, not an `Awaitable` `Promise` subclass.
> The `Awaitable` subclass, its branding symbols, and `toAwaitable` /
> `resolvedAwaitable` are removed; `.value` / `.status` become the verbs `latest`
> / `isPending`. The rest below is kept for the record.

The async read model migrates to the uniform `Awaitable`
([`async-reads-and-coordination.md`](../pulse/async-reads-and-coordination.md),
superseding [ADR 0002](./0002-pending-model.md)'s write-back) by the **adapter**
approach: introduce `Awaitable<T>` as a thin `Promise<T>` subclass carrying
`{status, value, reason}` plus the stale-while-revalidate prior value, wrap
promises into it at the two boundaries where they enter (the `signal()` setter
and a stage's pending outcome in `computed.ts`), and **relocate the promise
state onto that object** — retiring `async.ts`'s `states`/`lastResolved`
WeakMaps and `computed.ts`'s out-of-band `publishedValue` signal +
`lastResolvedValue` closure. The proven pipeline (the r3 dep-tracker, the
`fast-forward`/`reuse-value` resumption modes, `pendingSig`) is **kept**.

This is the "lean on what's shipped" choice, grounded in the study
([`../pulse/read-model-migration-notes.md`](../pulse/read-model-migration-notes.md)):
uniform `Awaitable` is not new *semantics* — pulse already implements SWR,
pending, and suspend-on-read — it is a *state relocation*. The smallest correct
delta moves that state onto one object rather than rewriting the pipeline.

**Concretely (executed as Plan 7):**

- `Awaitable<T>` = `Promise<T>` subclass with `status` / `value` / `reason` (and
  a prior-value seed for SWR); `[Symbol.iterator]` for `yield*` stays.
- `toAwaitable(promise, prior?)` wraps at the `signal()` setter and the
  `computed.ts` stage-pending / `NotReadyYet` boundaries. One wrap point each.
  **The setter seeds the prior from the node's current value** (`v instanceof
  Awaitable ? v.value : v`) — it has no `lastResolvedValue` closure to borrow
  (that exists only in `computed.ts`); this is a distinct seeding path, and it
  makes the new SWR strictly better than the old `latest()` (no missed-stale
  window).
- `s()` async returns the `Awaitable` uniformly (no write-back to bare `T`).
- `.value` is the SWR read; `latest(s)` is kept for backward-compat (it has no
  `src/` callers — only tests + the public export). The compat shim reads
  `.value` *only when the value is an `Awaitable`* (`const v = s(); return v
  instanceof Awaitable ? v.value : v`) — not a naïve `s().value`, which would
  break for plain-value signals. `committed(s)` (isolation, from the scope
  overlay) is new.
- `use(x)` unchanged in behavior; reads `x.status === 'pending'` (not the
  `states` WeakMap). `isPending`/`promiseOf` derive from `.status` / the
  `Awaitable`.
- `computed.ts`: the stage's view value *is* the `Awaitable`; `Object.is`
  change-gating stays (interacts with [ADR 0008](./0008-signals-dedupe-writes-by-object-is.md))
  but compares `.value`.

## Sequencing

The public `computed()` speculation rewire depends on this migration:
speculation-in-computed is far cleaner once a computed's view is a single
`Awaitable` the overlay's speculative recompute can produce into a scope slot
(study probe 7). Therefore:

- **Plan 7 (code): adopt the uniform `Awaitable` read model** per this ADR.
- **Plan 8 (code): speculation in public computeds**, on the new model.

Read-model first; speculation-in-computed second.

## Considered alternatives

- **B — Native rewrite of `makeStageNode`** so the view is an `Awaitable` end
  to end with no `publishedValue` at all — **rejected as the first step.** It is
  the cleaner *end state*, but a larger blast radius across the async / pending /
  effect-stages suite up front. The adapter reaches the same uniform surface
  with a smaller delta; a B-style cleanup can follow later if the adapter leaves
  too much indirection.
- **C — Parallel surface, migrate callers gradually** — **rejected as an end
  state.** Keeping the old model alongside `Awaitable` indefinitely is exactly
  the two-models-coexisting muddle the uniform model exists to end. (The
  migration will *transiently* have both during Plan 7, but converges to one.)

## Consequences

- **The big async test suite is the behavior spec.** `test/async`, `test/pending`,
  `test/computed`, `test/effect-stages`, `test/integration-async*` must stay
  green through Plan 7 — the migration preserves SWR / pending / suspend /
  resumption semantics, only relocating where the state lives.
- **`latest` stays (as a `.value` alias).** No breaking change to the public
  read API; `committed` is additive.
- **Supersedes ADR 0002's write-back fully in code** — settlement fills the
  `Awaitable`'s `.value`/`.status`; the signal no longer flips `Promise<T>` → `T`.
- **Unblocks speculation-in-computed** (Plan 8): a computed's `Awaitable` view is
  what the overlay's `runRecipe` can produce speculatively per scope.
- **Signals and computeds now both publish `Awaitable`s, and `track` returns
  any `Awaitable` unchanged.** So the value a consumer reads — the published
  `Awaitable` — has a single home; it is never copied into `async.ts`'s
  WeakMaps. Those maps keep two kinds of bookkeeping that sit beside the read
  model rather than duplicating it. `states` records the status of any promise
  that does not carry its own: one a caller passes in (the initial value given
  to `signal()`, or a promise built by hand and read through `use()`), and the
  plain promise an async or generator stage returns internally for the driver to
  watch. `lastResolved` is `latest()`'s own cache of the last resolved value it
  returned for a signal, so `latest()` can keep returning that value while a
  newer promise is pending.
- **`computed.ts` keeps its private `lastResolvedValue`.** It looks like a
  leftover but is not: the published value can be a settled value, a promise
  still in flight, an error, or an initial "nothing yet" sentinel, whereas
  `lastResolvedValue` is only ever the last real resolved value — read to tell a
  first load from a refresh and to skip re-publishing a value that has not
  changed (the deduplication decided in
  [ADR 0008](./0008-signals-dedupe-writes-by-object-is.md)). Folding it into the
  published value would rebuild that distinction less safely, so it stays.

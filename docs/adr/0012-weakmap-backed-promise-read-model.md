# Async reads are a plain `Promise<T>` backed by one WeakMap, read through verbs

Supersedes [ADR 0011][adr11].

An async signal or computed reads as a plain `Promise<T>`; a synchronous one
reads as bare `T`. The read never becomes `T | Promise<T>` and never writes
back to bare `T` on settle — the async colour stays in the type
([ADR 0004][adr4]). The promise carries no extra fields and is not a `Promise`
subclass. Its status — pending / fulfilled / rejected, the resolved value, the
rejection reason, and the stale-while-revalidate prior — lives in **one WeakMap
keyed on the promise**. That same map is the generator driver's fast-forward
memory, so the read state and the driver's memory are a single mechanism. All
async reads go through verbs: `use` (suspend), `latest` (the stale value
without suspending), `isPending`, `settled`, `committed`.

## Why

[ADR 0011][adr11] left two mechanisms holding the same fact: an `Awaitable` — a
`Promise` subclass carrying `status`/`value`/`reason` — for the read surface,
and a `states` WeakMap for the driver's promise tracking. Reads exposed
`.value`/`.status` on the subclass. Collapsing the two into one carrier removes
that duplication, which is what made the earlier model feel like it had more
moving parts than the job needs.

There are three ways to hold async state for a promise: a `Promise` subclass, a
symbol-tagged field on the promise, or a WeakMap keyed on the promise. A
micro-benchmark ([carrier-benchmark.ts](../pulse/carrier-benchmark.ts), 200k
carriers, 20 reads each) compared them:

- the subclass is the heaviest — roughly four times the WeakMap's memory and
  the slowest to create, because it chains a second promise per wrap;
- symbol-tagging is the fastest at both create and read; the "symbol access
  de-optimises" worry does not hold for uniform, monomorphic tagging — but it
  mutates the promise's shape;
- the WeakMap has the smallest footprint and never touches the promise; its
  reads are slower (a `WeakMap.get` versus a field read) but only by tens of
  nanoseconds — negligible at any realistic read rate.

At realistic scale none of the three is a bottleneck, so the choice rests on
design, not speed. The WeakMap is chosen for being uniform and always
applicable: it works identically on every promise — pulse's own, caller-
supplied, frozen, proxied — with no shape mutation, no branding, and no special
case to reason about.

## The type mechanism

`computed(() => T)` reads as `Accessor<T>`; `computed(() => Promise<T>)` reads
as `Accessor<Promise<T>>`. For a multi-stage pipeline the two directions
differ: between stages the driver awaits, so each stage receives the resolved
input (`Awaited<…>` of the previous stage's return), while the public accessor
returns the last stage's raw return — `Promise<T>` if async, bare `T` if sync.
So `Resolved<>` keeps unwrapping for inter-stage inputs; the accessor type
stops unwrapping. That is what holds `Promise<T>` without a union.

## Refinement — the read is runtime-honest; the verbs resolve it

Implementation sharpened this. The async colour folds across the *whole*
pipeline, not just the last stage, and the read reflects what `c()` can be at
runtime rather than being coerced to a single shape:

- a **definitely-async** pipeline (some stage returns a promise or is a
  generator) reads as a single `Promise<T>`;
- a **conditionally-async** stage — its type a union containing a promise, e.g.
  `computed(() => cond ? fetch() : 'ok')` — reads as the honest union
  `Promise<T> | U`, because `c()` genuinely is one or the other per evaluation;
- an **all-sync** pipeline reads as bare `T`.

So "reads are always uniform, never a union" is refined to: **the raw read is
honest to the runtime; the view utilities resolve it.** This is pulse's own "a
node is a graph relation, not a value; a walk produces the value" applied to
async colour — the raw `c()` carries the honest shape, and the read verbs
(`use`, `latest`, `isPending`, `settled`) are the walks that resolve it. Every
verb is total over the union (`use(c)` / `latest(c)` return `T | U`); a
hand-narrowed raw read is the rarely-needed escape hatch. `use` is two overloads
so an accessor's own return type resolves through `Awaited` even when it is a
union.

The type helper `PipelineRead<Upstream, Last>` folds the upstream stages' colour
with the last stage's surface type; it replaces the last-stage-only `ReadOf`.
The runtime matches: a synchronous stage fed by an async upstream publishes a
promise, and the change-gate re-publishes on a bare/promise shape flip.

## Considered alternatives

- **Keep the `Awaitable` subclass ([ADR 0011][adr11]).** Rejected: it is the
  heaviest carrier and duplicates the WeakMap the driver already needs. Its one
  draw — `s().value` field access — is dropped for verb-only reads, which the
  verb-based API already provides (`latest` is the old `.value`).
- **Symbol-tag the promise.** Rejected despite being the fastest: it mutates
  promise shapes and puts state on objects pulse may not own. The WeakMap's
  uniformity was preferred over a read-speed gain that is invisible in
  practice.
- **Write back to bare `T` ([ADR 0002][adr2]).** Rejected: it reintroduces the
  `T | Promise<T>` narrowing this design exists to avoid, and leans on the
  state map even harder (pending status lives only there).

## Consequences

- **Supersedes [ADR 0011][adr11] and, through it, [ADR 0002][adr2]'s
  write-back.** The read is a plain `Promise<T>`; settlement records status in
  the WeakMap; the type never flips.
- **Mostly subtractive.** The engine underneath — `track`/`states`, the
  stale-while-revalidate seeding, the pending/settle pipeline, generator
  fast-forward, the verbs — stays. Removed: the `Awaitable` subclass, its
  branding symbols, and `toAwaitable`/`resolvedAwaitable`, which collapse into
  "make a promise, record its state." `awaitable.ts` folds into `async.ts`.
- **`.value`/`.status` become verbs.** `s().value` becomes `latest(s)`; a
  pending check becomes `isPending(s)`; suspension stays `use(s)`. One way to
  read — through the verbs — rather than fields on the returned object.
- **Unwinds the read surface of Plans 7 and 7b** while keeping their engine
  work. A follow-up plan carries out the rewrite test-first against the
  existing behaviour suite.
- **[`async-reads-and-coordination.md`](../pulse/async-reads-and-coordination.md)
  Part 1 is revised** to match; the `settled([...])` barrier in Part 2 stands,
  with `.value` reads replaced by `latest`.

[adr2]: ./0002-pending-model.md
[adr4]: ./0004-propagate-async-color.md
[adr11]: ./0011-uniform-awaitable-adapter-migration.md

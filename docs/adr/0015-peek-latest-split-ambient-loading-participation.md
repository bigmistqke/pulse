# peek()/latest() split: latest() ambiently participates in isLoading(), peek() is the escape hatch

`latest(x)`'s implementation (the tolerant, never-throws read) is renamed to `peek(x)`, unchanged in
every respect — same value contract, same zero side effects, safe to call from anywhere. A new
`latest(x)` takes its old name: it returns `peek(x)`'s exact value, and additionally, while `x` is
pending, hands its in-flight promise to the nearest `<Loading>` boundary's background-tracking set —
the same hand-off `use.latest()`'s stale-while-revalidate branch already made — so `isLoading()`/
`useLoading()` reflect the refresh. It never calls `markUsedInBinding()`, so it can never withhold a
commit or reopen a boundary's fallback; only `isLoading()` hears about it. `use.latest()` is
unaffected in contract — it still throws only before the first value — and its implementation
simplifies, since it now gets the background hand-off for free by calling the new `latest(x)`
internally instead of duplicating the check.

## Why

A `todo-async` binding that both displays `todos`-derived data and wants to tell the boundary "this
is refreshing" needed two calls: a real read (`latest(todos)`, via `overlay()`/`visible()`), and a
second, value-discarding call purely for the side effect (`use(todos)`, called and ignored, next to
`return visible()`). Working through why that shape kept recurring — first proposing to move the
`use()` call elsewhere, then to fold it into one expression — the actual objection was structural,
not cosmetic: **propagating loading state and displaying a value are two different capabilities**,
and a primitive that only exists to be called-and-ignored for its throw is smuggling the first
capability into a call site that exists for the second. Every fix that kept `use`/`use.latest` as
the only way to touch the boundary reproduced the same shape in a different position.

The resolution: give `latest(x)` the ambient-participation half on its own, with no throw involved
at all. Displaying a value (`peek`/`latest`) and gating a commit (`use`/`use.latest`) stay fully
independent primitives; a caller that wants both still calls two things, but neither exists solely to
be discarded — `latest(x)`'s return value is the same real value `peek(x)` would give.

## Considered and rejected: `optimistic(() => use(todos))`

Read the base of an optimistic overlay through `use(todos)` instead of `latest(todos)`, so the one
call that might throw is the same call that produces the overlay's value. Verified empirically (a
temporary edit, full Playwright run, and a targeted probe) that this reproduces every existing test
correctly — including the specific worry that it would make interactions unrelated to `todos` (like
changing a filter) freeze while `todos` refetches. That worry turned out to be moot: the *existing*
code already froze the filter during a refetch, because the separate `use(todos)` call the old code
carried for gating had exactly the same freezing effect regardless of which primitive supplied the
displayed value — reading via `latest()` never bought back the responsiveness it appeared to.

Rejected anyway, on a different, structural ground: `optimistic()` is a generic, reusable combinator,
not a leaf. Its whole value is not caring what `source` is. A throw buried inside it is invisible at
every call site that uses it, correct only by the accident of which signal happens to be passed in
today — reuse `optimistic()` with a different signal later and that buried throw becomes a live,
silent suspension point nobody grepping for `use(` would find. Throwing primitives belong at leaves —
the actual JSX binding, not a shared function several calls removed from it.

## Considered and rejected: `optimistic(() => use.latest(todos))`

Same leaf objection as above, but there's also a concrete correctness gap specific to this call site:
`todos` is `signal(fn, default)`-seeded (`[] as Todo[]`), and `latest(todos)`/`peek(todos)` report
that seed instead of `undefined` from construction, before the first real fetch has even started.
`use.latest()`'s throw condition is `latest(x) === undefined` — for a seeded signal that is never
true, so `use.latest(todos)` would never throw on a genuine first load either. Verified directly (a
unit test against a seeded, never-yet-resolved signal): `use.latest()` returns the seed immediately,
no throw. Composing `optimistic()`'s source on `use.latest()` would silently drop the boundary's
first-load gating for any seeded signal, reproducing the exact "boundary shows loaded before data
arrives" bug [ADR 0014](0014-use-latest-composed-on-latest.md) fixed, for a different reason: not a
signal that was never re-checked, but a throw condition the seed defeats by construction.

## Considered and rejected: making bare `latest()` call `markUsedInBinding()` too

If `latest()` engaged the same way `use()`/`use.latest()` do — without throwing — its commit would
route through `deferOrCommit`, which sounds harmless (engagement alone never blocks anything without
a `pendingSet` entry). It is not harmless on a fresh boundary: nothing in this shape ever throws, so
`pendingSet` never gains an entry, `gatePending` resolves to `false` almost immediately, and
`hasEverLoaded` flips `true` before the real data has ever arrived — reproducing, exactly, the bug
found and fixed while implementing [ADR 0014](0014-use-latest-composed-on-latest.md)'s
`gatePending`/`activeSig` split. Engagement without a throw is not a substitute for genuine
first-load gating; only something that checks `isPending` unconditionally (`use`) can provide that.
`latest()`'s ambient participation therefore deliberately never calls `markUsedInBinding()` — it
touches only the background-tracking set, which was already proven safe to feed without throwing.

## Considered and rejected: registering `optimistic()`'s/`visible()`'s own accessors with the pending tracker

> **Superseded by [ADR 0016](./0016-optimistic-as-a-signal-variant.md).** The
> argument below is about sufficiency for loading propagation, and it holds:
> the ambient hand-off does reach a boundary from inside any binding's call
> stack, with no registration needed. What it does not weigh is what
> registration buys beyond that — `use()` on the optimistic accessor, a read
> style chosen per read site rather than fixed at construction, and a retry
> that resets the wrapped node instead of only re-running the recipe over a
> source that is still parked. `optimistic()` now builds a pipeline and
> registers it, for those reasons rather than this one.

An earlier direction had `optimistic()` call `registerPending()` on its own returned accessor,
proxying `source`'s pending state, with `visible()`/`remaining()` rebuilt as `computed()` pipelines
so pending-ness would propagate through `PendingEntry.upstream`, the same mechanism a multi-stage
`computed()` already uses. Unnecessary once `latest()` itself carries the ambient hand-off: `latest`
is called transparently, inline, wherever it sits in a call chain (`optimistic()`'s `source()` call,
`visible()`'s own body) — confirmed by reading `src/optimistic.ts`, which calls `source()` with no
wrapping computed node in between. Simply calling `latest(todos)` from anywhere inside a JSX
binding's synchronous call stack correctly reaches `runBindingCompute`'s ambient wrapping and hands
off the background promise, with no pipeline registration needed at all.

## Naming

`peek` was chosen over keeping the old behavior nameless/default because both halves needed a name
once they diverged, and "the version with zero side effects, safe to look at from anywhere without
consequence" is what `peek` already connotes in general programming usage (peeking at a stack/queue
without altering it). `latest` keeping its existing name for the new, ambiently-participating
behavior was deliberate: every existing call site's *value* contract is unchanged, so the rename
pressure was correctly placed on the primitive whose behavior actually changed relative to what its
name previously meant — the escape hatch is what's new, not the participant.

## Consequences

- `src/async.ts`: `latest`'s old implementation renamed to `peek` (identical body, all three
  overloads). New `latest` calls `peek` for the value and additionally calls `isPending`/`promiseOf`/
  `markBackgroundPromise` when pending — no `markUsedInBinding()`. `use.latest()` simplified: its own
  explicit `isPending`/`markBackgroundPromise` block is removed, since calling the new `latest(x)`
  internally already makes that hand-off.
- `src/index.ts` exports `peek` alongside the existing `latest`.
- Every existing `latest(x)` call site across `src/`, `test/` needed a per-site decision, since `peek`
  and `latest` are no longer interchangeable now that one has a side effect. Pure-value unit tests
  with no DOM/binding context (the majority) became `peek` — they test the value contract, which is
  now `peek`'s job, and `latest`'s distinguishing behavior is unobservable outside a binding anyway.
  `test/dom/loading.test.tsx` gained two tests: `peek()` confirmed to never register with a boundary,
  `latest()` confirmed to feed `isLoading()` ambiently while never reopening a boundary's fallback.
- `examples/todo-async/src/main.tsx` is migrated to this design. `optimistic(() => latest(todos))`
  stays as it was; the list and count bindings lose their own `use(todos)` calls entirely and read
  through `latest()` (via `overlay()`), which never throws but does ambiently report a background
  refresh; and a single value-less leaf binding — `{() => { use(todos); return null }}` — carries
  the gating that genuinely needs a throw (first-load Skeleton, and routing a rejected load to
  `<Errored>`). The three action generators use `peek(todos)`: they build a write's base value, not
  a displayed one, and run from an event handler outside any binding, where `latest()`'s hand-off
  would be a no-op anyway.

  Applying this migration is what surfaced the error-boundary flush bug described in
  `docs/follow-ups.md` — an `<Errored.Error>` binding stopped re-evaluating once nothing in the
  subtree called `use()` anymore, because `createErrorScope`'s write to its report collection never
  requested a flush and had been relying on the incidental one a non-throwing `use()` triggers
  through `<Loading>`'s `deferOrCommit`. Not caused by this ADR's change (it reproduced with the
  pre-split `latest()` too), only uncovered by it. Fixed in the same pass, in `src/owner.ts` and
  `src/scope.ts`, with regression tests in `test/dom/error.test.tsx`.

## Follow-on: the full ambient contract, and what a throw is actually for

The split above shipped with `latest()` reporting only one fact — a background refresh — which left
`<Loading initial>` and `<Errored>` still reachable only through a throw. Working through why the
`examples/todo-async` migration still needed a value-less `{() => { use(todos); return null }}`
binding produced the sharper framing: **`use`'s only benefits at a call site are that it returns
`Awaited<T>` instead of `Awaited<T> | undefined` (which is what the throw buys) and that it enrols
the binding in the atomic-commit gate.** Everything else it appeared to provide was coordination
that had simply never been given another route.

So `latest()` now reports three facts rather than one, and `peek()` is the only reader that reports
nothing:

- **background refresh** — pending, and the accessor has resolved before. `isLoading()` only.
- **first load** — pending, and the accessor has never resolved. `isLoading()` and the `initial`
  swap. Keyed on genuine resolution (a private `everResolved` set written only where a real value
  arrives) rather than on whether a value came back, so a `signal(fn, default)` source still gets
  its placeholder — a seed says what to display meanwhile, not that the fetch has finished.
- **error** — the source is parked in an error state. Reported to the nearest accepting `<Errored>`
  through a per-binding controller in `src/dom/bindings.ts`, and cleared to `idle` on any later run
  that sees no error, which is what unlatches the boundary. Reading `error(s)` also subscribes to
  the node's error state, so the binding re-runs on reset and reports its own recovery.

`examples/todo-async` now contains **no `use()` call at all** and keeps every behaviour: Skeleton on
first load, hold-prior across a refetch, a failed load reaching `<Errored>` with a working retry,
and the optimistic overlay. That is the concrete demonstration that loading and error propagation
never needed the throw — only the value guarantee and the commit gate do.

`optimistic()` changed shape in the same pass (since superseded — see
[ADR 0016](./0016-optimistic-as-a-signal-variant.md), which makes it a signal variant whose accessor
is an ordinary node, read with whichever verb the read site names): it takes the source signal
directly rather than a thunk (`optimistic(todos)`, not `optimistic(() => latest(todos))`) and makes
the tolerant read
itself, mirroring `latest`'s overloads. An overlay layers plain values over plain values, so a
fetch-backed source has to be read tolerantly somewhere; doing it inside means every consumer of the
overlay gets the ambient participation for free.

### Known gap: `retry` is offered even when nothing can be retried

`useErrored()`/`isErrored()`/`<Errored>`'s `fallback` all hand out a `retry`/`reset` unconditionally,
because it is built as a closure over `scope.reset()` — a scope-level operation that never consults
the individual failure. It is only meaningful when the failed source is re-runnable: a `computed`
with a recipe (verified: the body runs again and the boundary clears), or an `action` with a body.
For a raw rejected promise there is nothing to re-run and no registered node for `resetError` to
reset, so retrying re-runs the binding, re-throws the identical rejection, and correctly re-latches
the boundary — but the rendered fallback comes back EMPTY, because the reset transiently publishes
an empty report collection and the fallback's own content re-renders against `error() === null` in
that window. Measured, not inferred. Tracked in `docs/follow-ups.md`; the intended fix is to make
`retry` genuinely absent (`null`) when no matching report is retryable, rather than present and
inert.

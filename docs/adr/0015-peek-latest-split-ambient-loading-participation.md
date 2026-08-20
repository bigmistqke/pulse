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
- `examples/todo-async/src/main.tsx` is **not yet migrated** to this ADR's design. Applying it
  (`optimistic(() => latest(todos))` staying as-is, a single value-less leaf binding calling `use
  (todos)` purely for first-load/error gating, `visible()`/`remaining()` losing their own `use(todos)`
  calls entirely) is a genuinely correct application of everything above and was verified to work for
  loading/skeleton/background-refresh behavior — but doing so surfaced a separate, real bug: with
  *no* binding anywhere in `TodoList` calling `use()` at all, `MutationError`'s `<Errored.Error>`
  binding stops re-evaluating after its first run, even though the error-report signal it reads
  (`reportsNode` in `src/owner.ts`) is genuinely written to on rejection. Reproduces with the
  pre-existing `latest()` behavior too (confirmed by reverting only the ambient-participation half) —
  it is not caused by this ADR's change, only uncovered by removing the last `use()` call from that
  subtree, which had been incidentally keeping some other scheduling path alive. Tracked in
  `docs/follow-ups.md`; the `main.tsx` migration is blocked on finding and fixing that bug.

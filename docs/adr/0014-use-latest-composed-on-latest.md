# use.latest(): throws only before the first value, composed on latest() — not a new tracker

A fourth read primitive, namespaced on `use` (`use.latest(x)`, declaration-merged the
same way `Errored.Error` is merged onto `Errored`): it throws `NotReadyYet` only while
`latest(x)` is `undefined` — genuinely nothing has ever resolved. Once `latest(x)` has
anything at all, `use.latest(x)` never throws again for that accessor, returning
whatever `latest(x)` currently holds — fresh if settled, stale if a refetch is in
flight. `use(x)` and `latest(x)` are both unchanged; `read(x)` is renamed to `from(x)`
in the same pass, for reasons unrelated to this primitive (see below).

## Why

`<Loading>`'s hold-prior guarantee only works for a boundary instance that stays
mounted: `initial` shows on first load, and after that the existing committed tree is
held while a binding is pending. A boundary that is itself unmounted and remounted —
a `<Show>` toggling around it, e.g. — starts a fresh `hasEverLoaded` flag with no
memory that the data it watches already resolved once, under the previous instance.
If it reads that data through `use()`, which always throws while pending regardless
of history, the freshly-mounted boundary shows its `initial`/fallback again — a
spinner, for content that was already on screen a moment ago.

The fix needed something that remembers "has this specific accessor ever produced a
value" independent of which DOM boundary happens to be reading it right now — because
the boundary instance is exactly what resets on a remount, and the accessor is
exactly what doesn't.

## Considered and rejected: a dedicated "ever settled" tracker

The first design built a private `WeakMap<Accessor, boolean>` — keyed on the accessor
argument, set the first time `isPending(accessor)` read false, consulted on every
call to decide throw-vs-return. It worked for the common case (a stable
`computed()`/`signal()` reference) but broke silently for any caller that reaches the
accessor through a freshly-constructed closure — an inline `use.latest(() => data())`,
or, concretely, a prop read through this session's props-to-getters compiler when the
caller still writes the pre-simplification `<Foo data={() => data()}/>` form: that
compiles to `get data() { return () => data() }`, a new function object on every
property access, so a WeakMap keyed on that reference never accumulates history.

Reading `latest(x)`'s actual implementation (`src/async.ts`) made the tracker
unnecessary. Its stale value is mostly seeded directly onto **the promise's own
tracked state** (`track()`, written by `computed()`'s SWR machinery the moment it
starts a new fetch) — keyed on the promise object, not on the accessor. Calling
`latest(x)` through a stable reference or a fresh wrapper reads through to the same
underlying promise either way, so the "ever settled" question is already answered
correctly by `latest()` itself, for the case that matters. (`latest()` does have its
own identity-keyed `lastResolved` fallback, for a raw promise handed straight to
`signal()` before anything else has seeded it — narrow, pre-existing, and not
something this change touches.)

So `use.latest(x)` composes directly on `latest(x)` rather than duplicating its
machinery:

1. Call `latest(x)`.
2. If it's not `undefined`: mark the binding engaged (same flag `use()` sets,
   unconditionally); if `isPending(x)` is also true, hand the in-flight promise to
   the boundary's background-tracking set instead of throwing it; return the value.
3. If it's `undefined`: throw `NotReadyYet`, exactly like `use()`.

No new tracking state anywhere. `src/pending.ts` and `src/computed.ts` are untouched.

## Two other architectures considered, for where "ever settled" memory could live

- **The boundary keeps track.** Today's actual `hasEverLoaded` — scoped to the DOM
  instance, resets on remount. The original bug; not survivable without moving the
  memory somewhere that outlives the instance.
- **`pending.ts`'s shared registry keeps track.** Extending `PendingEntry` with an
  "ever settled" bit would make it visible to `isPending`/`promiseOf`, which don't
  need it, and would still be keyed on accessor identity underneath — same
  silent-failure shape as the rejected tracker above, just worse encapsulation.
- **An explicit key**, e.g. `<Loading key="...">` registered against a store on some
  stable ancestor owner (the shape Solid's ecosystem caching libraries — `solid-cache`'s
  `CacheBoundary` — use). Genuinely robust against the identity problem, since a
  string doesn't care how the JSX is written. Rejected for now: it's opt-in
  (forgettable, and forgetting it silently reproduces today's bug rather than failing
  loudly), has its own key-collision risk, and needs its own disposal story since it
  can't ride on `WeakMap` garbage collection the way everything else here does. Worth
  revisiting if a real case turns up where the accessor genuinely has no stable
  identity to lean on.

## Boundary background-tracking

`isLoading()` needs a background-refresh cue to keep working for a binding that no
longer throws. `use.latest()`'s SWR branch hands its in-flight promise to a plain
`Set<Promise>` on the scope; adding one is the hand-off, removing one is a single
`promise.finally(...)` callback attached once. The `.finally()` callback must check
the scope isn't already disposed and no-op if so, since it can fire after the
boundary itself has been torn down.

`backgroundPromises` must feed a signal that is read ONLY by `isLoading()`/
`useLoading()` — never by `Loading()`'s own initial-vs-loaded swap decision, or by
its `hasEverLoaded` tracking. The first implementation pass got this wrong (see
"Implementation correction" below): it fed `backgroundPromises` into the same signal
`Loading()`'s swap logic reads, which reopened exactly the bug this ADR exists to
close.

## Why atomicity across multiple bindings in one boundary is unaffected

`markUsedInBinding()` still fires unconditionally inside `use.latest()`, throw or
not — the same flag `use()` already sets. That flag is what routes a binding's commit
through the existing, untouched `deferOrCommit` gate in `src/dom/bindings.ts`. A pane
that SWRs computes successfully and marks engaged, but its commit still queues behind
the gate; a sibling pane that's genuinely pending for the first time ever still
throws and still blocks the gate. The gate stays shut until every
genuinely-first-time-pending binding clears, exactly as today.

## Implementation correction: the gate signal and the isLoading() signal must be separate

The first implementation pass gave `LoadingScope` one signal, `pendingSig`, computed
as `pendingSet.size > 0 || readySet.size > 0 || deferredCommits.length > 0 ||
backgroundPromises.size > 0`, and used that SAME signal for three things: `scope.active`
(what `isLoading()` reads), `Loading()`'s own `if (!pendingSig()) return loadedSubtree`
swap check, and the `hasEverLoaded` tracking effect.

That combination reopens the FM2 bug this ADR exists to close. On a boundary remount
with a genuine refetch in flight, `use.latest(x)` returns its stale value immediately
(no throw — the fix works as designed) — but if `isPending(x)` is also true, it
hands the in-flight promise to `trackBackground`, which adds it to `backgroundPromises`
and sets the shared signal true. Because that signal is also what `hasEverLoaded`
watches, `hasEverLoaded` cannot flip true until the background promise itself settles
— which can be hundreds of milliseconds later, for a refresh that has nothing to do
with whether the boundary has ever shown content. For that whole span, the freshly
remounted boundary's swap check sees "pending" and shows `initial` — the exact flash
the fix was meant to eliminate, just stretched across the refetch's duration instead
of a single microtask.

The fix: `LoadingScope` needs two signals, not one.

- `gatePending` — `pendingSet.size > 0 || readySet.size > 0 || deferredCommits.length
  > 0`. Drives the atomic-commit gate (unchanged) AND `Loading()`'s own swap check AND
  `hasEverLoaded`. Deliberately excludes `backgroundPromises`: a `use.latest()`
  binding that took the SWR path already committed — it has a value on screen — so a
  refresh behind it must never reopen the fallback or block `hasEverLoaded`.
- `activeSig` — `gatePending || backgroundPromises.size > 0`. This is what
  `scope.active` (and therefore `isLoading()`/`useLoading()`) reads, so a background
  refresh still surfaces as "loading" to a caller outside the boundary's own swap
  decision, exactly as intended.

Caught by the demo this ADR is written to fix (`examples/transitions/src/tabs/
spinner-flash.tsx`, testing both `use(data)` and `use.latest(data)` side by side) and
its Playwright spec — the fallback was still observably present in the DOM across
the remount before this correction, not merely a same-microtask flicker.

## read renamed to from

Unrelated mechanism — `yield* read(x)`'s generator-side continuation resumption has
nothing to do with `use`/`use.latest`/`latest`'s throw/return family — but decided in
the same naming pass. `read` didn't signal that it only works `yield*`-delegated
inside a generator stage; nothing about the word constrains it to that context.
`from` does the same job the word already does in Python's `yield from` — this
session's own naming pass landed there after checking that word against the actual
codebase (`Array.from` is the only existing usage, and it's semantically compatible)
and considering `bind` (precisely grounded — CONTEXT.md's own theoretical-lineage
section already names monadic bind as the formal operation a stage boundary
performs — but reads as two stacked verbs after `yield*`), `wait`/`defer` (suggest
"here's a promise, unwrap it yourself," undersell the type-carrying continuation
`from` actually performs), and `await` (legal as a plain identifier in a non-async
generator, most intuitive of all, but reads as keyword misuse to anyone who doesn't
already know that).

## Considered and rejected: renaming latest to get, use.latest as a new top-level latest

An earlier pass of this same design reshuffled the family: rename today's `latest` to
`get`, and give the new primitive the vacated name `latest`, since "the latest value,
full stop" is a more honest claim once the primitive guarantees non-`undefined`.
Rejected in favor of the namespaced form for one concrete reason: it required
renaming an existing, shipped primitive, touching every current call site
(`todo-async`'s reads, this file's own `latest()` implementation, `CONTEXT.md`'s
glossary, tests) for a benefit — the standalone word being marginally more apt — that
the namespaced form gets for free, without any rename at all. `use.latest` also
self-documents its own composition (use, via latest) in a way no single invented word
(`warm`, `hold`, `keep`, `trust`, `settle` — all considered and rejected across this
same pass) managed to.

## Consequences

- New export: `use.latest`, declaration-merged onto `use` in `src/async.ts` (the same
  pattern as `Errored.Error` merged onto `Errored` in `src/dom/error.ts`). Signature:
  `use.latest<T>(x: Accessor<T>): Awaited<T>` — accessor-only, no fallback parameter
  (it never returns `undefined` past the throw, so there's nothing for a fallback to
  cover). No promise/plain-value overload: a bare promise has no persisting identity
  across separate attempts (a refetch is necessarily a new promise object), so "ever
  settled, independent of history" isn't a meaningful question for it —
  `use(somePromise)`'s existing always-throw-while-pending behavior already covers
  that case correctly.
- `read` renamed to `from` throughout `src/async.ts` and every call site.
- `src/dom/loading.ts`'s `LoadingScope` gains `backgroundPromises` and `trackBackground()`,
  and splits its one pending signal into `gatePending` (the atomic-commit gate, the
  swap decision, `hasEverLoaded`) and `activeSig` (what `isLoading()`/`useLoading()`
  read — `gatePending || backgroundPromises.size > 0`) — see "Implementation
  correction" above for why the split is required, not optional.
- `src/dom/bindings.ts`'s `reactiveCommit` and `insertChild` both thread a
  `backgroundPromise` result out of `runBindingCompute` and hand it to
  `findBoundaryScope(...)?.trackBackground(...)`, unconditionally, before their
  existing controller/`deferOrCommit` commit-routing logic.
- `src/transition-tracker.ts` gains `markBackgroundPromise()` and a
  `backgroundPromise` field on `runBindingCompute`'s return value.
- `src/pending.ts` and `src/computed.ts` are untouched.
- Out of scope, recorded in `docs/follow-ups.md`: whether stale-while-revalidate
  should live at the `computed()` node level at all, versus being purely a read-site
  decision every primitive opts into independently. `use.latest()`'s design depends
  on the current node-level behavior (that's precisely why it can compose on
  `latest()` for free); revisiting that would be a framework-wide behavioral change,
  not a read-primitive one.
- `test/async.test.ts`'s existing "Plan B" tests (`use(accessor) throws NotReadyYet
  during SWR refetch`, `use(swrComputed) throws NotReadyYet during refetch, even
  though accessor returns stale`) stay correct and untouched, since `use()` itself
  doesn't change. New tests are added alongside them for `use.latest()`'s
  mirror-image contract, not replacing them.

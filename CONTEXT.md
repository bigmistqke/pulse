# pulse

A mini reactive UI framework built on top of [r3](../r3). pulse explores an
alternative to Solid 2.x's async direction. Like Solid, it makes **async a
first-class citizen** — no parallel set of primitives, computations themselves
can be async. Unlike Solid, it does not try to *uncolor* async, and exposes the
coordination machinery as small explicit pieces:

- **`use(...)`** is the explicit, local opt-in marker — both for suspension (when
  the source is pending) and for transition coordination (when the surrounding
  `<Loading>` is gating commits).
- **`<Loading>`** is the atomic-commit boundary. It gathers per-binding commits
  and flushes them in one pass when nothing inside is pending. Transitions are
  a property of placing `<Loading>` around bindings you want coherent — not a
  separate primitive.
- **`isPending` / `promiseOf`** expose pending state as plain reactive accessors
  backed by an external registry, not as hidden brands on signal objects.

The framework's bet is that *per-binding opt-in* (you choose at each read site
whether to coordinate) is a useful alternative to Solid's *per-write opt-in*
(`startTransition` wraps mutations). The trade-off is verbosity for locality:
forgetting `use` silently opts out of coordination, but every coordination
choice is visible at the call site and grep-able.

For the full comparative analysis against Solid 2.x, see
[`docs/solid-2x-comparison.md`](./docs/solid-2x-comparison.md).

## Language

**Signal**:
Plain reactive data holder. Created via `const [count, setCount] = signal(0)`.
The getter `count()` reads the current value; the setter `setCount(value)`
writes a new value, or `setCount(prev => next)` updates from the previous value
(updater form). A signal stores exactly what you put in it — Promise values
are NOT auto-resolved; `signal<T>` does not widen to `Awaited<T> | T`. For
async derivations use `computed(() => fetchX())`. (Eager `track(value)` on
Promise-valued signals keeps `latest`/`isPending` working without an explicit
`use` call.)
_Avoid_: store (different concept), atom.

**Accessor**:
A callable that reads a reactive value — `count()`. Type: `Accessor<T> = () => T`.
The first element of the `signal()` tuple. Computeds also return Accessors.

**Computed**:
A derived signal. Defined as a Pipeline of one or more Stages:
`computed(stage0, stage1, ...)`. A single sync function or single generator is
just a one-stage pipeline. Async stages publish via **stale-while-revalidate**:
the prior resolved value stays visible during a refetch, and downstream is
invalidated only when the new resolved value differs (`Object.is`) from the
prior one. Observe the refetch window with `isPending(computed)`. Sync stage
bodies that throw `NotReadyYet` (via `use(pending)`) are absorbed as
suspension — symmetric with `effect` — and re-run on settle.

**Pipeline**:
The ordered list of Stages passed to `computed`. The runtime threads a value
through it: stage N receives stage N-1's (unwrapped) return value. Each stage
registers with the external pending tracker; `isPending(downstream)` walks
the chain (pipeline-OR).

Conceptually, **pipelines are delimited continuations split at user-chosen
boundaries**, with three distinct levels of re-entry:

- **Stage boundaries are genuinely multi-shot.** Each stage is a separate r3
  computed with its own cached result; when stage N produces a new value, the
  runtime re-invokes stages N+1, N+2, ... with the new input — without
  restarting prior stages. This is structurally what an algebraic-effect
  handler does when it calls `resume(value)` multiple times: invoke the
  continuation with different values. Pulse achieves multi-shot at the
  stage boundary on top of single-shot JavaScript generators by decomposition,
  so re-entry needs no generator-state preservation.
- **A generator stage resumes, once per pause.** The paused generator is
  retained and re-entered with `gen.next(value)`, so the code before the pause
  does not run again. This is genuine continuation resumption, but only
  forward: a JavaScript generator cannot be re-entered at an earlier point, so
  a change to any dependency the generator already read discards it and runs a
  fresh one from the top — reissuing any asynchronous work an earlier segment
  had completed. Because resuming runs only the code after the pause, and r3
  rebuilds a dependency list from the reads a run makes, the stage replays the
  dependencies recorded before the pause so they stay linked.
- **Everything else within a stage re-executes from the top.** A
  binding-effect, or a sync or async-function stage, that suspends on `use(x)`
  does NOT resume — it re-runs the body from the start. The kick-on-settle
  mechanism just marks the node dirty; the body restarts. Same model as React
  Suspense ("re-execute on settle," not true continuation resumption).

So pulse has three levels. **Stage boundaries** are multi-shot: a stage is
re-invoked with a new input any number of times, without re-running upstream
stages. **Within a generator stage** is single-shot resumption: the
continuation runs forward once per pause, and a dependency change replaces it
rather than rewinding it. **Everywhere else within a stage** is re-execution
from the top. The distinction matters: the stage boundary is the only place
pulse gets genuine "rest of the computation runs with a *different* value"
semantics, which is why a stage boundary is where work that should not
be redone belongs.

See [Bauer & Pretnar's "Programming with Algebraic Effects and Handlers"](https://arxiv.org/abs/1203.1539)
for the formal theory; [Dan Abramov's "Algebraic Effects for the Rest of Us"](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
is the accessible JS-flavored intro (and includes the contrast with React
Suspense's re-execution model that pulse also inherits).

**Stage**:
One function in a Pipeline. Independently sync `(value) => ...`,
`async (value) => ...`, or `function* (value) { ... }`. Every Stage may read
reactive signals and tracks its own dependency set. Stage N's parameter type is
inferred from stage N-1's return type.

**from**:
The generator-side resolver helper, used as `yield* from(x)` inside a
`function*` stage. `x` may be a signal (tracked + resolved), a bare promise
(suspended on, untracked), or a plain value (returned immediately). It exists
because `yield*` delegation is the only way TypeScript can infer a per-yield
value type inside a generator body. After Plan A, `from` is a plain yield
helper — it does NOT consult any pending brand. Suspension comes from the
driver's `settle()` over the yielded value. Coherent multi-read snapshots
across siblings are a `<Loading>` boundary concern, not `from`'s job. Named
`from` — not its earlier name `read` — because `read` didn't signal the
`yield*`-only constraint; `from` echoes Python's own `yield from` phrasing
through JS's `yield*` syntax instead. See [ADR 0014](docs/adr/0014-use-latest-composed-on-latest.md).
_Avoid_: get, unwrap, read (superseded — see above).

**use / NotReadyYet**:
`use<T>(x: T | Promise<T> | Accessor<T>): Awaited<T>` is the opt-in synchronous
bridge AND the transition-engagement marker. Two behaviors fire on every call:

1. **Mark engagement** (`transition-tracker.ts:markUsedInBinding`) — the
   surrounding binding records that it called `use`. This flag participates
   in atomic-commit routing later.
2. **Resolve or throw**:
   - Accessor argument: the accessor is called first (to establish the r3
     dep edge), then `isPending(accessor)` is checked; if pending, throws
     `NotReadyYet(promiseOf(accessor)!)`.
   - Promise argument: pending → throws `NotReadyYet(p)`; settled → returns
     the resolved value (or re-throws the settled rejection).
   - Plain value: returned as-is.

The throw propagates up the synchronous read stack until caught by an
**effect** (a JSX binding is an effect) — suspends that node, sets up re-run
on the carried promise's settle. The effect also registers `throwing` with
the nearest `<Loading>` scope.

When `use` returns successfully but the surrounding binding called it (engaged
flag set), the binding's commit routes through `scope.deferOrCommit(commit)`
if a `<Loading>` scope exists — so the commit defers until the scope's gate
opens (atomic with sibling bindings that are still pending).

**Throwing belongs in effects.** Effects (including JSX bindings) are the
designed catch sites. Plan B Task 2.5 also lets computed stage bodies absorb
`NotReadyYet` as suspension (symmetric with effect), so `use(pending)` inside
a sync stage body works as expected. Using `use` outside any effect/computed
context (e.g. a free function call at module level) lets the throw escape and
is a code smell.
_Contrast_: Solid's throwing is implicit and pervasive (every accessor); `use`
is explicit, local, and grep-able.

**use.latest**:
`use.latest<T>(x: Accessor<T>): Awaited<T>` — declaration-merged onto `use`
(the same pattern as `Errored.Error` merged onto `Errored`), not a separate
top-level export. Composes directly on `latest(x)`: call it; if the result is
not `undefined`, return it (marking engagement the same as `use`, and handing
the in-flight promise to the nearest `<Loading>` scope's background-tracking
set if `isPending(x)` is also true); if it IS `undefined` — genuinely
nothing has ever resolved for this accessor — throw `NotReadyYet`, exactly
like `use`.

The difference from `use`: `use` throws on every pending episode, forever.
`use.latest` throws only until the first value exists, then never again for
that accessor — a same-instance refetch and an instance remount are treated
identically, because the memory lives on whatever `latest(x)` already tracks
(mostly the pending promise's own seeded SWR state, not the accessor's
identity), not on the calling boundary. No new tracking state was added
anywhere to make this work — see [ADR 0014](docs/adr/0014-use-latest-composed-on-latest.md)
for the full reasoning, including two rejected designs that DID need new
tracking state and why they were dropped.
_Avoid_: a separate top-level primitive for this (`warm`, `hold`, `keep`,
`useStale`, `useLatest`, standalone `latest`/`get` reshuffle — all considered
and rejected; see the ADR).

**isPending / promiseOf**:
Reactive reads over the pending tracker (`src/pending.ts`). `isPending<T>(x:
Accessor<T>): boolean` and `promiseOf<T>(x: Accessor<T>): Promise<T> | null`
both take an explicit accessor argument and return their value directly —
call fresh at each read site (an effect body, a getter-converted prop), the
same way `latest(x)`/`isLoading()` are called fresh rather than stored.
Neither has an accessor-returning form, unlike `useLoading`/`isLoading`:
`useLoading()` genuinely needs one, because it takes no argument and has to
capture an ambient `getOwner()` lookup at the point it's called, so reading it
later requires deferring that lookup into a returned accessor. `isPending`/
`promiseOf` take the accessor to inspect as an explicit argument and consult
only `src/pending.ts`'s `WeakMap<Accessor, PendingEntry>` — no ambient
context — so there is nothing to capture ahead of time, and no reason to
return anything but the answer itself.

Both walk upstream via the entry's `upstream` chain (pipeline-OR): a
downstream stage is pending if any upstream stage is. Fallback path for plain
signals holding a Promise: inspect the value via `track()`.

The implementation lives in `src/pending.ts` with a `WeakMap<Accessor, PendingEntry>`
registered by `computed`. There is no `[PENDING]` symbol on accessor functions
anymore (Plan A removed it).

**peek / latest**:
`peek<T>(s: Accessor<T>): Awaited<T> | undefined` returns the most recent
*resolved* value: `undefined` until the signal first resolves, then always the
last resolved value; does not revert to `undefined` while a newer promise is
pending. Zero side effects — safe to call from anywhere (a helper function, a
`computed`, a test), not just a binding. The true escape hatch: use when you
want stale-but-stable explicit data with no coordination of any kind (vs.
`use` which throws on pending).

`latest<T>(s: Accessor<T>): Awaited<T> | undefined` reads `peek(s)`'s exact
value, and additionally — while `s` is pending — hands its in-flight promise
to the nearest `<Loading>` boundary's background-tracking set, ambiently
participating in `isLoading()`/`useLoading()`. Never calls
`markUsedInBinding()`, so it can never withhold a commit or reopen a
boundary's fallback — only the loading *indicator* hears about it, never the
swap decision. `use.latest` (see above) composes directly on this — throwing
only while `latest` itself would still report `undefined`, and getting the
same background hand-off for free by calling `latest` internally.

Displaying a value and propagating loading state are two separate
capabilities — `peek`/`latest` is the "which value" axis, `use`/`use.latest`
is the "does this gate a commit" axis, and they compose independently rather
than one primitive doing double duty. See [ADR 0015](docs/adr/0015-peek-latest-split-ambient-loading-participation.md)
for the design history, including two rejected shapes that tried to fold both
axes into one call, and the error-boundary flush bug uncovered (not caused) by
applying this split to `examples/todo-async` — see
[`docs/follow-ups.md`](docs/follow-ups.md).
_Avoid_: reaching for `use`/`use.latest` purely to make a binding "participate"
without needing its value (call `latest` instead, if a throw isn't wanted) or
purely to gate a commit without displaying anything at that call site (a
value-less leaf calling `use` and returning nothing is the honest shape for
that, not a discarded value next to a real read).

**Component**:
A function that runs once and returns a DOM node tree (or an accessor that
returns one). A component body never re-executes — reactivity lives in the
holes it returns, not in re-invoking the function. Local state created in the
body (`signal(0)`, `computed(...)`) is created once. Async always lives
*inside* a component — in bindings and effects — never in the body's own
control flow. **Caveat**: a component whose body calls `use(...)` at the top
level (before creating local state) will re-execute the WHOLE body on
suspension retry; if it created state in earlier lines, that state is lost.
The safe pattern is `use(...)` inside a JSX hole, not in the body.

**Control flow**:
`Show`, `Switch`, `For` are ordinary Components. They apply trivial total
coercions of pending state at their inputs: `For` treats a pending list as
`[]` (zero rows); `Show` treats a pending condition as falsy. No async policy
is baked in — async behavior is decided entirely by what the caller passes
and where they put `use`. Pass a raw accessor → total coercion; pass
`use(...)` at the call site → throws → caught by the surrounding effect (and
participates in any enclosing `<Loading>` boundary).

`Show` and `For` take a local `fallback` prop. It is an *empty-state* prop —
shown when content is empty (`Show`: falsy condition; `For`: zero rows). One
`fallback` therefore conflates "genuinely empty" with "still pending";
distinguishing them needs `isPending(x)` checks or wrapping in `<Loading>`.

**Loading boundary** (`src/dom/loading.ts`):
The atomic-commit boundary. Children's bindings register per-binding
controllers with this boundary; Loading aggregates and selects:

- All settled → loaded subtree.
- Pending and never-loaded → `initial ?? fallback`.
- Pending and previously loaded → `fallback ?? loaded subtree (hold-prior)`.

State machine inside `LoadingScope`:

- `pendingSet: Set<BindingController>` — controllers currently reporting
  `throwing`.
- `readySet: Map<BindingController, () => void>` — controllers that
  recomputed successfully with a commit waiting.
- `deferredCommits: Array<() => void>` — anonymous commits from
  `use()`-engaged bindings that didn't throw but need to wait for the gate
  (so atomic with sibling throwers).
- `backgroundPromises: Set<Promise<unknown>>` — in-flight promises handed off
  by a `use.latest()` SWR read (a binding that returned a stale value instead
  of throwing). Added on hand-off, removed by a single `promise.finally(...)`
  callback per promise, guarded to no-op if the scope is already disposed by
  the time it fires. Doesn't participate in the gate (a `use.latest()` binding
  already committed; nothing is waiting on it) — only in `isLoading()`'s
  aggregate, so a background refresh still surfaces as "loading" even though
  nothing is withheld.

Two separate signals, not one: `gatePending` (`pendingSet.size > 0 ||
readySet.size > 0 || deferredCommits.length > 0`) drives the commit gate below,
`Loading()`'s own initial-vs-loaded swap check, and `hasEverLoaded`.
`activeSig` (`gatePending || backgroundPromises.size > 0`) is what `scope.active`
— and therefore `isLoading()`/`useLoading()` — read. Collapsing these into one
signal is a real bug, not a simplification: a `use.latest()` binding's
background refresh would then hold `gatePending`/`hasEverLoaded` true for the
whole refresh, reopening the exact fallback-flash-on-remount bug `use.latest`
exists to close, just stretched across the refetch instead of a single
microtask. See [ADR 0014](docs/adr/0014-use-latest-composed-on-latest.md)'s
"Implementation correction" section.

When `pendingSet.size === 0 && (readySet.size > 0 || deferredCommits.length > 0)`,
the gate opens: all commits flush in one pass. A microtask "tail check" handles
the case where a non-throwing binding queued before any sibling thrower had
reported in the same flush.

**`initial` vs `fallback`**: `initial` shows only on first load (no committed
tree yet); `fallback` shows on subsequent transitions if set, otherwise the
prior committed tree is held.

**useLoading / isLoading**:
`useLoading(): Accessor<boolean>` — reads the nearest enclosing `<Loading>`
boundary's pending state. Returns a constant-false accessor when called
outside any Loading subtree. For the narrower case of reading the boundary
from one place and handing the resulting accessor to another.

`isLoading(): boolean` — the same read, called fresh at the call site instead
of returning an accessor to store — the common case, e.g. a getter-converted
prop (`class:loading={isLoading()}`) that's already re-read on every reactive
pass, with nothing to gain from an intermediate accessor.

**effect (single-arg form)**:
`effect(fn: () => void)` runs a side-effecting function reactively. Re-runs on
dep change. If the body throws `NotReadyYet`, the effect suspends, registers
`throwing` with the nearest `<Loading>` scope, and re-runs on settle.
Reports `idle` on successful re-run. Plain effects have no commit to defer —
their body's side effects fire directly on the successful pass; they only
contribute to the boundary's pending state while throwing.

**effect (staged form)** (Plan C):
`effect([stage0, ..., stageN], commit)` — variadic pipeline of stages
(sync/async/generator) feeding into a `commit(value)` callback. Stages reuse
`computed`'s pipeline machinery (suspension, SWR, pending registry). The
commit is the side-effect terminator and participates in `<Loading>`'s atomic
flush via `scope.deferOrCommit` when the boundary is pending. Object.is
dedup on the committed value (symmetric with `computed`'s published-value
dedup) suppresses spurious re-fires from scheduler noise.

**Scheduler**:
The single injectable mechanism that flushes the effect graph and resumes
suspended generator computeds. Triggered identically by synchronous writes and
async promise resolution. Default batches on a microtask; tests inject a
synchronous-drain scheduler. See [ADR 0001](docs/adr/0001-unified-injected-scheduler.md).
_Avoid_: `stabilize` (that is r3's internal primitive, never user-facing in
pulse).

**Owner**:
A lifecycle scope for reactive nodes (effects and computeds), forming a tree.
Created by `createRoot((dispose) => …)`. Disposal cascades top-down.
`getOwner()` returns the current ambient owner. `runWithOwner(owner, fn)` is
the explicit override. `createRoot` always creates a root (nesting does not
parent inner to outer). Outside any root, reactive nodes work but live
forever — a `warnIfOrphaned` warning surfaces the leak. **Signals are not
owned** — plain data with no lifecycle.

`<Loading>` creates its own `boundaryOwner` and attaches a `LoadingScope` to
it. `useLoading()` and the binding-controller machinery walk owners to find
the nearest scope.

**Error Boundary**:
A sub-`Owner` with an attached error handler. Created by
`catchError(fn, handler)`: child owner with `handler` registered, `fn` runs
with it as ambient. When a reactive node owned by this sub-owner (or a
descendant) throws a non-`NotReadyYet` error, the wrapper walks up via
`parent` links and invokes the nearest handler. A throwing node stays alive
but frozen — its r3 value is whatever it was before the throw, and it may
re-run if its tracked deps change; the handler is observational, recovery
state is user-managed via signals.
_Note_: throwing is reserved for genuine errors AND for `NotReadyYet`
suspension (which is its own routed-through-effects flow). Pending values
appear as `Promise<T>` plus pending-tracker entries; the throw is the
suspension signal, not an error.

**BindingController** (`src/owner.ts`):
The per-binding object obtained from `LoadingScope.register()`. Has
`report(state: BindingState)` and `unregister()`. `BindingState` is
`{status: 'throwing'} | {status: 'ready', commit} | {status: 'idle'}`.
Each binding-effect creates one lazily on first `NotReadyYet`.

**Pull-on-read**:
Reading any signal or computed walks it up to date synchronously — reads
are never stale, regardless of whether a flush has run or where the read
happens. The Scheduler batches effects only; it never gates read correctness.

## Conceptual model

Pulse's primitives are all the same shape: a **performer** raises a typed
operation, a **handler** somewhere up the dynamic context catches it and
decides what to do (commit, defer, resume, abort, ignore). This is the
algebraic-effects pattern, implemented in a JS-flavored way (re-execution
plus mutable "current X" ambient slots, not true delimited continuations
except at stage boundaries — see Pipeline).

The full set of effects pulse currently handles (and a couple sketched for
future work):

| Effect | Performer | Handler |
|---|---|---|
| Suspension | `use(x)` throws `NotReadyYet(promise)` | binding-effect's try/catch + kick-on-promise-settle (re-execution) |
| Boundary coordination | `use(x)` engagement flag (set in `transition-tracker`) | `<Loading>` scope's gather + atomic-flush state machine |
| Error | non-`NotReadyYet` throw inside a reactive node | `catchError(fn, handler)` walks the owner tree, nearest handler catches |
| Owner lookup | `getOwner()` reads ambient owner slot | `runWithOwner(owner, fn)` sets the slot for the dynamic extent of `fn` |
| Loading scope lookup | `useLoading()` walks owner tree for nearest `loadingScope` | `<Loading>`'s setup attaches a scope to its boundary owner |
| (future) Transaction overlay | `tx.set(s, v)` writes to per-tx overlay | `transaction(fn)` manages overlay, commits or aborts |
| (future) Cross-boundary policy | child `<Loading>` scopes' pending state | parent `<Reveal>` policy (sequential / together / natural) |

Three structural patterns recur:

1. **Throw + catch + kick-on-settle** for one-shot effects that pause a
   computation until something resolves (Suspension, future Optimistic-revert).
2. **Owner-tree walk for nearest handler** for hierarchical context lookups
   (catchError, useLoading, future `useTransaction`).
3. **Module-level mutable "current X" slot** with save-restore wrappers for
   per-call-frame ambient context (current owner via `runWithOwner`; current
   binding's engagement flag via `runBindingCompute`; conceivably current
   transaction via `runInTransaction`).

These three patterns ARE the implementation toolbox for algebraic-effect
handlers in a language without first-class delimited continuations. Pulse's
design coherence comes from reusing them across every coordination primitive
rather than introducing new mechanisms.

### Theoretical lineage

Pulse sits at the intersection of two research threads:

- **Algebraic effects + handlers** (Plotkin & Pretnar; Bauer; Leijen's Koka;
  Sam Lindley; OCaml 5 effect handlers). The "perform an effect, handler
  catches and decides resume vs abort" pattern. Pulse's `use()` / `<Loading>`
  / `catchError` are instances. References at the end of the Pipeline section
  above; React Suspense and effect-ts are JS-world implementations of the
  same shape.
- **Incremental / self-adjusting computation** (Umut Acar's research on
  self-adjusting computation; [Jane Street's `incremental`](https://github.com/janestreet/incremental)
  OCaml library; [Yaron Minsky's "Seven Implementations of Incremental"](https://www.youtube.com/watch?v=G6a5G5i4gQU)
  talk; Milo Mighdoll's [`reactively`](https://github.com/milomg/reactively)
  and `r2`). The "describe a computation graph once; the runtime efficiently
  re-evaluates only the affected portions when leaves change" model. r3 (and
  by extension pulse) inherits the **topological height ordering** approach
  from this lineage — different from the push-pull-push tri-coloring that
  most signals libraries use. r3's README is explicit about the influence.

The two threads connect at the structural level: an incremental computation
graph's "bind" (the operator that lets a node's output depend on a dynamically
constructed sub-graph) is essentially the multi-shot continuation we discussed
above. Each `bind` is a stage boundary; the sub-graph past the bind is the
"rest of the computation"; when the bind's input changes, the sub-graph is
re-invoked with the new value. Pulse's pipeline `computed(s0, s1, s2)` is
the same shape as an incremental graph of binds.

## Relationships

- A **Signal** is read via an **Accessor** (sync contexts) or `yield* from()`
  (inside a `function*` stage).
- A **Computed** is a **Pipeline** of **Stages**; each stage registers with
  the pending tracker, and `isPending`/`promiseOf` walk the chain.
- A **Component** runs once and returns DOM. Reactivity lives in the holes
  (function children, `class:`/`prop:`/`attr:`/`style:` reactive props).
- A **JSX hole** is a binding-effect: `insertChild`'s reactive child branch
  (for `() => value` children) or `bindProp`'s reactive branches (for
  reactive props). On `NotReadyYet`, the existing DOM stays put.
- `use(...)` inside a binding: marks engagement (transition coordination)
  AND throws if the source is pending.
- `<Loading>` gathers the controllers from binding throws + the deferred
  commits from engaged-but-successful bindings, and flushes everything
  atomically when the gate opens.

## Transitions

After Plan B, **transitions are a property of `<Loading>` placement**, not a
separate primitive. Wrap the bindings you want coherent in a `<Loading>`. Use
`use(x)` inside those bindings (even when `x` isn't pending) to opt them into
the gather. The boundary holds the prior committed tree until everything
settles, then flushes all commits in one pass.

```tsx
<Loading initial={<Spinner/>}>
  {() => (
    <>
      <span>page {() => use(page) + 1}</span>
      <For each={() => use(list)}>{(item) => <Row item={item}/>}</For>
    </>
  )}
</Loading>
```

`use(page)` never throws (page is a plain signal), but it marks the page-label
binding as engaged. When the user clicks "next" → `list` re-fetches → For
binding throws and reports throwing → page label's commit is also deferred
(because the boundary is pending AND page label is engaged). Both flush
together when `list` settles.

## Roadmap

- **v1** (shipped): core (multi-stage computeds, generator computeds, `from`,
  SWR), DOM layer, error boundaries, `<Loading>` atomic-commit boundary,
  `use(...)` as suspension + transition-engagement marker, staged effects,
  `useLoading`/`isLoading`, `useErrored`/`isErrored`.
- **v1.1** (shipped, [ADR 0014](docs/adr/0014-use-latest-composed-on-latest.md)):
  `use.latest(x)`, declaration-merged onto `use`, fixing the fallback-flash-on-
  remount bug (FM2); `read` renamed to `from` throughout `src/async.ts` and its
  call sites; `LoadingScope` gains `backgroundPromises`/`trackBackground()` and
  splits its pending signal into `gatePending`/`activeSig` (see the Loading
  boundary entry above).
- **v1.2** (shipped): `isPending(x)`/`promiseOf(x)` return their value directly
  instead of `Accessor<boolean>`/`Accessor<Promise<T> | null>` — no more
  `isPending(x)()` double-call anywhere. Unlike `useLoading`/`isLoading`, no
  accessor-returning form is kept at all: `isPending`/`promiseOf` take the
  accessor to inspect as an explicit argument and have no ambient-owner lookup
  to defer, so there was no structural reason for the double form to begin
  with.
- **v1.3** (shipped, [ADR 0015](docs/adr/0015-peek-latest-split-ambient-loading-participation.md)):
  `latest(x)`'s old implementation renamed to `peek(x)` (zero side effects,
  unchanged); `latest(x)` takes the name for a new behavior — `peek(x)`'s
  value, plus ambient hand-off to the nearest `<Loading>` boundary's
  background-tracking set while `x` is pending, never gating a commit.
  `use.latest()` simplifies to compose on the new `latest(x)` directly.
  `examples/todo-async` is migrated: its list and count bindings drop their own
  `use(todos)` calls and read through `latest()`, with one value-less leaf
  binding carrying the gating that genuinely needs a throw.
- **v1.4** (shipped): an error boundary's own write now requests a flush.
  `createErrorScope`'s `recompute` (`src/owner.ts`) and `makeErrorCell`'s
  `setError` (`src/scope.ts`) reach r3's `setSignal` directly, which only marks
  subscribers dirty — neither paired the write with `requestFlush()`, the way
  every other writer in pulse does. Consumers of an error boundary
  (`<Errored.Error>`, `isErrored()`, `useErrored()`) were therefore left dirty
  and never recomputed unless some unrelated write happened to flush, which
  made the boundary's liveness depend on incidental traffic elsewhere in the
  tree. Uncovered by the v1.3 migration above; see `docs/follow-ups.md`.
- **later**: structural-mount gating in `<Loading>` (current bug: `<Show>`/
  `<For>` mount/unmount commits don't defer with the boundary — only content
  hole commits do); optimistic store; explicit `transition()` value for
  cross-tree coordination beyond what `<Loading>` placement covers.

See [`docs/follow-ups.md`](./docs/follow-ups.md) for the live tracker of
known issues and follow-up work.

## Flagged ambiguities

- `from` (the generator-side helper, named `read` at the time this was
  decided — see [ADR 0014](docs/adr/0014-use-latest-composed-on-latest.md))
  was at one point made *brand-aware* — inspecting the accessor's pending
  state and yielding the in-flight Promise to suspend the generator. Plan A
  reverted this: `from` is plain. Coherent multi-read snapshots now live
  entirely in the `<Loading>` gather mechanism, not in `from`.

## Example dialogue

> **Dev:** "If a page label is `{() => use(page) + 1}` inside a `<Loading>`,
> and `page` is a plain signal that just changed, does the label update
> immediately?"
> **Dev:** "Not if a sibling binding inside the same `<Loading>` is currently
> throwing. `use(page)` marks the label's binding as engaged. The binding's
> commit routes through `scope.deferOrCommit`, which queues the commit until
> the gate opens. When the sibling settles, both commits flush in the same
> pass."

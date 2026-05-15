# pulse

A mini reactive UI framework built on top of [r3](../r3). pulse explores an
alternative to Solid 2.x's async direction. Like Solid, it makes **async a
first-class citizen** — no parallel set of primitives, computations themselves
can be async. Unlike Solid, it **does not try to uncolor** async, and leaves it visibly
colored. It drops *implicit, pervasive* throw-based suspension (throwing is
still available, but **opt-in and local** via `use`), hidden transitions,
and the `<Loading>`-boundary assumption. Async is treated as a general
capability, not a data-loading feature.

## Language

**Signal**:
Plain reactive data holder. Its value type is `T | Promise<T>` — a signal may
hold a promise, which is how "a value in the future" is represented (no invented
pending sentinel).
_Avoid_: store (different concept), atom.

**Accessor**:
The bare call form of a signal — `count()` — used for synchronous reads outside
generator computeds (sync computeds, effects, DOM).

**Computed**:
A derived signal. Defined as a Pipeline of one or more Stages:
`computed(stage0, stage1, ...)`. A single sync function or single generator is
just a one-stage pipeline.

**Pipeline**:
The ordered list of Stages passed to `computed`. The runtime threads a value
through it: stage N receives stage N-1's (unwrapped) return value.

**Stage**:
One function in a Pipeline. Independently sync `(value) => ...`,
`async (value) => ...`, or `function* (value) { ... }`. Every Stage may read
reactive signals and tracks its own dependency set — a Stage *is* a Segment.
Stage N's parameter type is inferred from stage N-1's return type (this is why
pipelines need no `yield*` helper for inference at stage boundaries).

**read**:
The generator-side resolver helper, used as `yield* read(x)` *inside a
`function*` stage*. `x` may be a signal (tracked + resolved), a bare promise
(suspended on, untracked), or a plain value (returned immediately). It exists
because `yield*` delegation is the only way TypeScript can infer a per-yield
value type inside a generator body. Pipeline *stage boundaries* do not need it —
their inference comes from normal function return types.
_Avoid_: get, unwrap.

**Checkpoint**:
A `yield*` point in a generator computed — where execution may suspend.

**Segment**:
A unit of re-execution with its own dependency set and cached result. A pipeline
**Stage** is a Segment; within a `function*` body, the code between two
**Checkpoints** is also a Segment.

**Checkpoint Resume**:
The re-execution strategy for generator computeds. On invalidation, the earliest
invalid segment is found; every prior segment replays from cache (fast-forward,
synchronously), and execution resumes for real from the first invalid segment.
Not "restart from top", not "blindly resume from last suspension".

**Component**:
A function that runs once and returns a DOM node tree — a pure *synchronous* DOM
factory. A component body never suspends (it is not an effect, so it must not
throw `NotReadyYet`). Async always lives *inside* a component — in bindings and
effects — never in the body's own control flow. A component is never "not there
yet"; it mounts synchronously and its holes fill per-node.

**Control flow**:
`Show`, `Switch`, `For` are ordinary Components that stay *total and pure* — they
never throw and never suspend internally. They apply a trivial total coercion of
the pending state: `For` treats a pending list as `[]` (zero rows); `Show`
treats a pending condition as falsy. No async policy is baked in — async
behaviour is decided entirely by what the caller passes and where they put
`use`: pass a raw accessor → total coercion; pass `use(...)` at the
call site → throws → caught by the surrounding effect or `<Suspense>` (v2).
Consequence: in v1, `For` over an async list flickers to empty on refetch;
hold/fallback coordination is a v2 `<Suspense>` concern. `For` keys async items
by reference (v1); two-phase re-keying is deferred to v2.

`Show` and `For` take a local `fallback` prop. It is an *empty-state* prop —
"shown when there is no content" (`Show`: condition falsy; `For`: zero rows).
Because pending coerces to empty/falsy, `fallback` transparently covers the
pending case too, with no async-awareness in the primitive. One `fallback`
therefore conflates "genuinely empty" with "still pending"; distinguishing them
needs an explicit `isPending` check or v2 `<Suspense>`.

**Scheduler**:
The single injectable mechanism that flushes the effect graph and resumes
suspended generator computeds. Triggered identically by synchronous writes and
async promise resolution. Default batches on a microtask; tests inject a
synchronous-drain scheduler. See [ADR 0001](docs/adr/0001-unified-injected-scheduler.md).
_Avoid_: stabilize (that is r3's internal primitive, never user-facing in pulse).

**use / NotReadyYet**:
`use(x)` is the opt-in synchronous bridge: `use<T>(x: T | Promise<T>): T`
returns the resolved value, or `throw`s `NotReadyYet` (carrying the promise) if
pending. Because it returns `T`, it makes terse JSX (`{use(user).name}`)
typecheck without dishonest signal types. The throw propagates up the
synchronous read stack until an **effect** catches it (a JSX binding is an
effect; in v2, a Loading boundary also catches), suspends that node, and re-runs
on settle.

**Throwing belongs in effects.** Effects — including JSX bindings — are the only
legitimate catch sites, so `use` is *for* effects. Using it anywhere else (a
component body, a `computed`, a pipeline stage) is misplaced: the throw escapes
its intended one-frame hop to some ancestor effect, often a parent's rendering
effect — i.e. unwanted subtree suspension. Allowed (not enforced), but a code
smell everywhere outside an effect.
_Contrast_: Solid's throwing is implicit and pervasive (every accessor); `use`
is explicit, local, and grep-able.

**isPending / latest**:
Reactive read-side helpers for promise-holding signals. `isPending(s)` — is the
signal's current value a pending promise? `latest(s)` — the most recent
*resolved* value: `undefined` until the signal first resolves, then always the
last resolved value; it does **not** revert to `undefined` while a newer promise
is pending (stale-while-revalidate).

**Owner**:
A lifecycle scope for reactive nodes (effects and computeds). Created by
`createRoot((dispose) => …)` — runs the callback with the new owner as ambient;
returns the callback's return value. Calling `dispose()` cleans up everything
created within: bottom-up disposal of owned children, each child's `onCleanup`
callbacks fire, each child's r3 node is detached via `r3.unwatched(node)`
(cascading upstream cleanup is automatic). `getOwner()` returns the current
ambient owner (or `null` outside any root). `runWithOwner(owner, fn)` is the
explicit override for cross-tree work. `createRoot` always creates a *root* —
nesting does not parent inner to outer (matches Solid; it is the "opt out of
parent disposal" primitive). Outside any root, reactive nodes are permissive —
they work as before, just live forever. Use-after-dispose (creating a node in
or running with a disposed owner) throws. **Signals are not owned** — they are
plain data with no lifecycle.

**Error Boundary**:
A graph node that registers as the error sink for its subtree. It catches both
synchronous throws (a stage throwing, or reading an errored computed
re-throwing) and async rejections routed to it during scheduler resumption, and
renders a fallback for its subtree. pulse v1 has Error Boundaries but no Loading
boundaries — pending is handled per-node as a value. (v2 adds a Loading/Suspense
boundary alongside, additively.)
_Note_: throwing is reserved for genuine errors, never for expected states like
pending. Pending is a `Promise<T>` value; errors throw.

**Pull-on-read**:
The invariant that reading any signal or computed walks it up to date
synchronously — reads are never stale, regardless of whether a flush has run or
where the read happens. The Scheduler batches effects only; it never gates read
correctness.

## Relationships

- A **Signal** is read via an **Accessor** (sync contexts) or `yield* read()`
  (inside a `function*` stage).
- A **Computed** is a **Pipeline** of **Stages**; each **Stage** is a **Segment**.
- **Checkpoint Resume** replays valid **Segments** from cache and re-executes
  from the first invalid one — whether segments come from pipeline stages or
  from `function*` checkpoints.
- A **Computed** that is mid-flight has a `Promise<T>` value; consumers resolve
  it the same way they resolve any other promise-holding **Signal**.

**Transition** _(exploratory — "later", post-v2)_:
An explicit, inspectable value that coordinates a group of async updates: holds
member nodes' commits and reveals them atomically when all settle, and exposes a
`pending` signal. Its whole job reduces to **membership** + **atomic commit** +
**observable handle** — pulse needs no entanglement engine because the async
graph is already materialised as `Promise<T>` values (a suspended computed stays
promise-valued across all its waves). Membership has two sources: nodes
invalidated in the trigger scheduler pass, and pending nodes created under the
transition's ambient context. Computeds *and* effects can be members (an
effect's pending-ness is its suspended state, known to the Scheduler).
_Contrast_: Solid's transitions are implicit and runtime-entangled because Solid
*erased* the async info; pulse keeps it as values.

## Roadmap

- **v1**: core (generator computeds, `read`, checkpoint resume) + per-node
  promise rendering in the DOM layer. No `<Loading>`, no transitions.
- **v2**: re-introduce Suspense as an opt-in layer, not a core primitive.
- **later**: transitions, optimistic store.

## Flagged ambiguities

- "read" was nearly made the universal value resolver (replacing accessors
  entirely); resolved: accessors stay for sync contexts, `read` is the
  generator-side helper. Both can read the same signal.

## Example dialogue

> **Dev:** "If a **Generator Computed** is suspended on `fetchUser`, and a sync
> **Signal** it read earlier changes — does the whole thing re-run?"
> **Dev:** "No — only from the **Checkpoint** whose **Segment** depended on that
> signal. Earlier segments replay from cache. That's **Checkpoint Resume**."

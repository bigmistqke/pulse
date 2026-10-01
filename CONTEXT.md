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

Terms are moving into the `## Terms` section of [`CANON.md`](CANON.md#terms), where each one is a definition and its behaviour lives in specs. Moved so far: present, accessor, signal, derivation, computed, pipeline, stage, owner, boundary, loading boundary, error boundary, scheduler, control flow, component, optimistic value, prediction, first load, refresh, ambient context, report, pending, suspension, read verb, tolerant read, hole, gate, binding, effect, error handler. The read verbs and effects are described by their specs.

**Pipeline re-entry**:
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
- **v1.5** (shipped, [ADR 0015](docs/adr/0015-peek-latest-split-ambient-loading-participation.md)'s
  follow-on): `latest(x)` reports three facts ambiently instead of one —
  background refresh, first load (driving `<Loading initial>`), and the
  source's error state (driving `<Errored>`). `peek` is now the only reader
  that reports nothing. `optimistic()` takes the source signal directly and
  makes the tolerant read itself. `examples/todo-async` contains no `use()`
  call at all and keeps every behaviour, which is the demonstration that
  loading and error propagation never needed a throw — only the non-optional
  return type and the atomic-commit gate do.
- **v1.6** (shipped, [ADR 0016](docs/adr/0016-optimistic-as-a-signal-variant.md)):
  `optimistic()` is a signal variant rather than a wrapper around one. It takes
  stages and builds the same pipeline `computed()` builds, so its accessor is an
  ordinary node — `use(value)`, `latest(value)`, `peek(value)`,
  `isPending(value)` and `error(value)` all apply, chosen at the read site
  instead of fixed at construction. Only the setter differs: it writes a Layer
  in front of the derivation, which leaks out to readers outside every action,
  stays scoped to the writing action's own chain inside, and expires when that
  action closes. Two defects in the intermediate version that wrote the layer
  INTO the node, both measured rather than reasoned about, are what put the
  layers in front: a source that changed while a prediction was live overwrote
  it, and an action could not read back its own prediction while an update
  function's `prev` resolved to a rival action's — which baked a refused
  prediction into a second action's layer, where its own rollback could no
  longer withdraw it. Wrapping an existing node registers this node as
  downstream of it, so a refresh of that node is reported through this one and a
  boundary's retry resets it — verified end-to-end: without that link the
  example's failed-load-then-retry test does not recover. Two further
  consequences of layering in front, both measured: dropping a layer stabilizes
  first, or it reveals a derivation that has not yet followed the write the
  same action just made; and both the reader and its tracker entry read the
  derivation on every call, or nothing pulls the pipeline while a prediction is
  showing and dropping the layer reveals a stale value.
- **v1.7** (shipped): structural mounts in `<Loading>` wait for their
  content. A reactive child whose new content contains a suspended reactive
  child of the same boundary commits through the gate, so a `Show` branch or
  a `For` row lands together with its content, and the structure it replaces
  stays on screen until then.
- **later**: make `retry`/`reset` genuinely absent when nothing is retryable,
  instead of present and inert for a non-re-runnable source (see
  `docs/follow-ups.md`); optimistic store; explicit `transition()` value
  for cross-tree coordination beyond what `<Loading>` placement covers.

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

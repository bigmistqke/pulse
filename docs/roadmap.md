# Roadmap

What shipped in each version, and what is planned. The canon, [`CANON.md`](../CANON.md), states how pulse behaves now; this document records how it got there.

- **v1** (shipped): core (multi-stage computeds, generator computeds, `from`,
  SWR), DOM layer, error boundaries, `<Loading>` atomic-commit boundary,
  `use(...)` as suspension + transition-engagement marker, staged effects,
  `useLoading`/`isLoading`, `useErrored`/`isErrored`.
- **v1.1** (shipped, [ADR 0014](adr/0014-use-latest-composed-on-latest.md)):
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
- **v1.3** (shipped, [ADR 0015](adr/0015-peek-latest-split-ambient-loading-participation.md)):
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
- **v1.5** (shipped, [ADR 0015](adr/0015-peek-latest-split-ambient-loading-participation.md)'s
  follow-on): `latest(x)` reports three facts ambiently instead of one —
  background refresh, first load (driving `<Loading initial>`), and the
  source's error state (driving `<Errored>`). `peek` is now the only reader
  that reports nothing. `optimistic()` takes the source signal directly and
  makes the tolerant read itself. `examples/todo-async` contains no `use()`
  call at all and keeps every behaviour, which is the demonstration that
  loading and error propagation never needed a throw — only the non-optional
  return type and the atomic-commit gate do.
- **v1.6** (shipped, [ADR 0016](adr/0016-optimistic-as-a-signal-variant.md)):
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

See [`docs/follow-ups.md`](./follow-ups.md) for the live tracker of
known issues and follow-up work.

## Flagged ambiguities

- `from` (the generator-side helper, named `read` at the time this was
  decided — see [ADR 0014](adr/0014-use-latest-composed-on-latest.md))
  was at one point made *brand-aware* — inspecting the accessor's pending
  state and yielding the in-flight Promise to suspend the generator. Plan A
  reverted this: `from` is plain. Coherent multi-read snapshots now live
  entirely in the `<Loading>` gather mechanism, not in `from`.

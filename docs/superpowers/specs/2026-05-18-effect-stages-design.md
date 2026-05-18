# Effect Stages — Design

**Status:** Draft
**Date:** 2026-05-18
**Related:** Plan B (atomic-commit boundary). Closes the "plain effects don't gate" wrinkle.

## Problem

Plan B makes `<Loading>` an atomic-commit boundary for DOM bindings: their compute (run user function) and commit (mutate DOM) phases are split, and the commit gets deferred through `scope.deferOrCommit(commit)` so all coordinated bindings flush in one pass.

Plain `effect(fn)` does not split. The user's `fn` runs side effects directly; there is no "commit" callback the boundary can defer. So an effect whose body calls `use(...)` gates the boundary's *pending state* (good) but its actual side effect fires whenever its own throw resolves (independent of siblings). For visual-DOM atomicity this didn't matter — only DOM commits need coherence — but for user-orchestrated side effects (logging, network writes, derived imperative work), the asymmetry surfaces as a real gap.

## Goal

Give effects an optional shape that makes the commit explicit and gateable:

```ts
effect([stage0, stage1, …stageN], commit)
```

Where `stage0..stageN` are stages in the same shape as `computed` (sync, async, generator; suspension via `use()` or returned-Promise; SWR; pending tracked in the registry). `commit` is the side-effect terminator that receives the resolved value of the final stage.

The boundary integration is symmetric with DOM bindings: when `commit` is ready to fire and the scope is currently pending, `commit` is handed to `scope.deferOrCommit(commit_thunk)` and runs in the next atomic flush.

Single-arg `effect(fn)` keeps its current shape (no staging, runs sync side effects on body success, no commit deferral). This is the common case; the new shape opts in for users who want gating.

## Non-goals

- Multiple commits per pipeline (a pipeline has exactly one terminator).
- A separate `.then(commit)` chaining API. Positional `effect([...stages], commit)` is the only new surface; equivalent expressivity, smaller API.
- Backwards-compat breaks for `effect(fn)` — that form keeps its current behavior.
- Generalizing `computed` to also have a separate commit phase. Computeds publish a value; their "commit" is the publish, which is already deferred by the SWR + pending machinery in Plan A/B.

## Design

### Surface

```ts
// Existing — unchanged
effect(fn: () => void): Disposable

// New — staged form
effect<T>(
  stages: [Stage<unknown, unknown>, …, Stage<unknown, T>],
  commit: (value: Awaited<T>) => void,
): Disposable
```

Stages share the type signature with `computed`'s variadic stages — each takes the previous stage's resolved value and returns a sync/Promise/generator. The `commit` callback receives the resolved value of the last stage.

(Typing the variadic stages array precisely requires the same overload trick as `computed`. For now, the implementation uses `Stage<unknown, unknown>[]` internally; the public surface ships with 1–5 overloads similar to `computed`.)

### Mechanics

The staged-effect implementation reuses `computed`'s `makeStageNode` machinery (extracted into a shared helper if needed). The pipeline produces an accessor; the staged effect subscribes to it via an r3 effect that, on each fresh value, invokes the commit through the scope-aware routing:

```
on staged-pipeline-produces-value v:
  if scope (nearest <Loading>) is pending:
    scope.deferOrCommit(() => commit(v))
  else:
    commit(v)
```

`markUsedInBinding` does NOT need to be threaded explicitly — the pipeline stages call `use(...)` themselves; the engaging effect lives in the stage layer, not the commit layer. But for the commit to defer correctly when the scope is pending, the same `engagedTransition` signal carries through.

Concretely, the staged-effect runs the pipeline (which suspends via the existing Plan A/B `[PENDING]`/registry path), then calls commit. If the surrounding scope is pending due to OTHER bindings (siblings), the commit is deferred via `deferOrCommit`. If the scope isn't pending — or there's no scope — commit fires immediately.

### Disposal

`effect([...stages], commit)` returns the same `Disposable` shape as `effect(fn)`. Disposal:
- Tears down the pipeline (calls the equivalent of `unwatched` on each stage's r3 node, just like `computed` disposal does today).
- Releases any controller registered with the scope.
- Drops any deferred commit not yet fired (analogous to the insertChild unmount-before-gate-opens guard added in Plan B).

### Re-runs

The pipeline drives re-runs. If any signal in any stage's body changes, the pipeline produces a new value, and `commit(newValue)` fires (possibly deferred). If the new pipeline run suspends (any stage throws/returns a pending Promise), the staged effect waits, gating the boundary; on settle, commit runs with the resolved value.

If `commit` itself reads signals (which a user might do), those reads are NOT tracked — `commit` runs outside any reactive context. Users who want commit to react to additional signals should put them in the pipeline.

### Errors

A throw from any stage (other than `NotReadyYet`) routes through `routeError` to the nearest `catchError`, same as `computed`'s error handling today. A throw from `commit` itself routes the same way. There is no special "commit-error" handling.

## Surface examples

```ts
// 1. Single-arg, unchanged
effect(() => console.log('count =', count()))

// 2. Staged: fetch + log; log gates with siblings under <Loading>
effect(
  [
    () => `https://api/${userId()}`,
    async (url) => (await fetch(url)).json(),
  ],
  (json) => {
    console.log('user data', json)
    sendAnalytics(json)
  },
)

// 3. Two staged effects sharing a <Loading>: their commits flush together
<Loading>
  {() => (
    <>
      <span>{() => use(view)}</span>
      {/* `view` produces page+items snapshot */}
      {(() => {
        effect(
          [() => use(view)],
          (snapshot) => {
            // fires once per coherent snapshot, deferred with sibling DOM commits
            logImpression(snapshot.page)
          },
        )
        return null
      })()}
    </>
  )}
</Loading>
```

## What this doesn't change

- `effect(fn)` single-arg behavior, including its NotReadyYet absorption + scope.register registration (Plan B).
- `computed`'s API.
- `<Loading>` boundary semantics — staged-effect commits use the same `scope.deferOrCommit` path that DOM bindings already use.
- `use()` semantics. Stages call `use()` the same way they would in a computed body.

## Risks

- **Variadic overload typing.** Like `computed`, precise typing requires 1–5 stage overloads. Acceptable copy-paste cost, same pattern.
- **Pipeline reuse.** The cleanest implementation extracts `computed`'s `makeStageNode` into a shared helper that both `computed` and staged-effect call. There is a smaller-cost alternative: have staged-effect internally call `computed(...stages)` to get an accessor, then run `effect(() => commit(use(pipelineAccessor)))`. This is composition-of-existing-primitives and may be the right starting point — minimal new machinery, falls out of Plan A/B's existing pieces.
- **Commit re-entrancy.** If `commit` synchronously triggers a signal change that retriggers one of its own pipeline stages, the effect re-runs. The existing `effect()` infrastructure handles this via the scheduler's batching; no special handling needed.
- **No commit during initial first-load + first-render when stages are pending.** This is the natural behavior (commit only fires once the pipeline has a value). Fine.

## Migration

Pure addition. No code today uses the staged form; existing `effect(fn)` calls are unaffected.

## Tests

- `effect([sync], commit)` fires commit with sync value.
- `effect([async], commit)` fires commit after Promise settles.
- `effect([s0, s1], commit)` chains stages; commit receives final value.
- A pending stage suspends; commit doesn't fire until settle.
- Inside `<Loading>` with a sibling throwing binding, commit is deferred and fires in the atomic flush.
- Outside `<Loading>`, commit fires immediately on each successful pipeline run.
- Disposal tears down pipeline + cancels deferred commit (if any).
- Throw from a stage routes to nearest `catchError`.
- Throw from commit routes to nearest `catchError`.

## Open questions

- **Implementation strategy: extract `makeStageNode` into a shared helper, or compose via `computed` + plain `effect`?** Defer to plan-writing — the composition route is much smaller and worth trying first; extract only if composition leaks (e.g., the pipeline's published value can't drive a single `effect` cleanly).
- **Should `commit` receive any additional context (e.g., a `disposed` flag for the case where the effect is being torn down mid-fire)?** Probably not for v1 — the framework guarantees commit only fires while the effect is alive (deferred commits are cancelled on dispose).

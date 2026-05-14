# Propagate async color through the graph, don't erase it

Solid 2.x *erases* async color: `user()` is typed `User` and throws if not
ready, so a consumer cannot tell async from sync. pulse does the opposite — the
color is visible at every level: `T | Promise<T>` in signal types, `function*`
on generator stage bodies, `yield*` at async read sites, `Promise<T>` as a
suspended computed's value, a render-function form at async JSX bindings.
"Coloring all the way through."

This is deliberate. The classic function-coloring *problem* is bad for three
reasons — async/sync don't compose, you duplicate logic, refactoring is painful.
pulse avoids all three via the quansync mechanism: `yield* read(x)` is one code
path whether `x` is sync or async, a generator stage whose deps are all settled
runs fully synchronously with zero allocation, and pipelines compose sync and
async stages freely. So the *ergonomic* win of "uncolored async" is kept. What
is dropped is the *erasure* — and the erasure is precisely what made causality
untraceable and types dishonest in Solid.

So pulse is not "uncolored async". It is **honestly colored, but the color is
free to carry**. The color costs *visibility* — and visibility is the goal.

## Consequences

- **Viral type propagation** — making a deep leaf signal async forces every
  transitive consumer to become a `function*` / pipeline. This is a real
  refactor cost, but it surfaces as a *type error walking up the graph*, not a
  runtime surprise — which is the lifetime-type-safety property doing its job.
- Because generator stages with sync deps cost nothing, "write computeds as
  generators by default" is a legitimate stance that sidesteps the churn.

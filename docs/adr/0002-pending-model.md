# Pending model: pending is a value, errors throw, write-back on settle

pulse keeps Solid's "uncolored async" goal but rejects its mechanism (every
accessor implicitly throws a `NotReadyError`, caught by `<Loading>` boundaries).
Instead:

**Pending is a value.** A signal's value is honestly `T | Promise<T>`. A pending
async computation simply holds a `Promise<T>`. Consumers see the promise and
decide what to do — there is no implicit throw and no loading boundary in v1.
`isPending(signal)` is the reactive predicate "is the current value a
Promise".

**Write-back on settle.** When a held promise settles, its resolved value is
written back into the signal (`setSignal`), flipping it `Promise<T>` → `T`. This
is not a free choice — it is forced by `use` (below): without write-back, a
re-run after settle would re-throw forever. Write-back keeps the invariant that a
signal's value at any instant is *either* a settled `T` *or* a pending
`Promise<T>`.

**`use` is the opt-in throw.** `use<T>(x: T | Promise<T>): T` returns the
resolved value or throws `NotReadyYet` (carrying the promise). Because it returns
`T`, it makes terse JSX (`{use(user).name}`) typecheck without dishonest
signal types. The throw propagates up the synchronous read stack until a
binding-effect catches it, suspends that node, and re-runs on settle. Unlike
Solid's pervasive implicit throw, `use` is explicit, local, and grep-able.
Using it inside a `computed`/stage is allowed but a code smell (the memo becomes
throw-on-read and the throw becomes contagious) — not enforced.

### Why a `computed` must not internally catch `NotReadyYet`

A natural question: rather than letting the throw propagate (throw-on-read),
why not have the `computed` *wrapper* silently catch `NotReadyYet`, become
promise-valued, and re-queue on settle — so `use` in a sync computed "just
works"? Mechanically that is doable. It is rejected because **it would make the
computed's type a lie** — the exact dishonesty pulse exists to avoid:

```ts
const x = computed(() => use(somePromise) * 2)
//    ^? Computed<number>   — the lambda returns `number`
```

If the wrapper caught internally, `x`'s runtime value would sometimes be
`Promise<number>` while its type says `number` — Solid's `user(): User`-that-
actually-throws dishonesty, relocated.

The deeper point: the smell is not "throw contagion", it is that **the
sync-lambda form gives pulse no way to keep the type honest**, and TS cannot
retroactively widen `=> number`. The honest forms each have a mechanism:

- `yield* read(p)` in a generator/pipeline stage — `yield*` *is* the
  type-carrying mechanism; the computed's type can honestly reflect the promise.
- `use(p)` in an effect — honest by absence; an effect has no value/return type
  to lie about.
- `use(p)` in a sync computed — no mechanism exists; letting the throw propagate
  (throw-on-read) is the honest "this doesn't work cleanly here", and the fix is
  to restructure as a generator/pipeline stage.

So throw-on-read is the honest behaviour; the generator stage is the honest fix.
This re-justifies why generators/pipelines exist: they are the only form in
which a computed's type can honestly reflect async.

**Errors throw to graph-node boundaries.** Throwing is reserved for genuine
errors, never for the expected "pending" state. A real error propagates up the
graph to an Error Boundary, which is a graph node (not a stack `try/catch`) so it
can catch both synchronous throws and async rejections routed during scheduler
resumption. v1 has Error Boundaries but no Loading boundaries.

## Considered alternatives

- **Error-as-value** (no throw for errors either): rejected — throwing is what
  exceptions are for; the objection was only to throwing *non-errors* for
  *expected states*.
- **Solid-style implicit throw + `<Loading>`**: rejected — implicit, pervasive,
  destroys lifetime type safety, makes causality hard to trace.

## The trilemma

Honest types (`T | Promise<T>`) · terse `{user().name}` JSX · no throwing — pick
two. pulse keeps honest types + no-throw by default (async JSX bindings use a
render-function form), and offers `use` as the explicit opt-in for the terse
corner when the author wants it.

## Roadmap

v2 re-introduces a Loading/Suspense boundary — additively, as a *coarser* catch
site for `NotReadyYet` (coordination), not a replacement for the per-node path.

# Handoff — a real failure never reaches the error boundary from a DOM binding

Branch `signal-as-node`. Nothing is pushed. The suite is green: 328 passing, 2 skipped, and `pnpm exec tsc --noEmit` is clean. `src/` is unmodified — no half-finished work is left in the tree.

This document exists so the next session starts from the corrected diagnosis instead of repeating the two dead ends below.

## The bug

A computed whose promise rejects, read through `use()` inside a **DOM binding**, never reaches the error boundary. The failure is not merely unreported — it is never recorded at all.

The same computed behaves correctly everywhere else, which is what makes this tractable:

| how it is read | `failure(c)` | does the error reach `catchError`? |
| --- | --- | --- |
| directly, `c()` | the `Error` | — |
| `use(c)` inside a plain `effect` | the `Error` | yes — the effect observes `PENDING`, then `ERR:boom` |
| `use(c)` inside a **DOM binding** | **`null`** | **no** |

So the computed is innocent. The failure is lost on the binding path specifically.

### Reproduce

```
cd /Users/bigmistqke/Documents/GitHub/pulse
```

Open `test/dom/loading-no-boundary.test.tsx`, remove the `.skip` from the third test (`an error boundary still catches a real failure`), then:

```
pnpm exec vitest run test/dom/loading-no-boundary.test.tsx
```

It fails with `expected [] to have a length of 1` — nothing was caught. The other two tests in that file pass and must keep passing.

## The mechanism (identified with confidence)

r3 **drops an effect's dependencies when its body throws.**

The binding rethrows `NotReadyYet` out of its effect body. That drops the effect's subscription to the suspended computed. The computed's subscriber count falls to zero, and r3 auto-disposes it — this is a known r3 behaviour, recorded in `docs/follow-ups.md` as *"r3 auto-disposes computeds when their sub count drops to 0, mid-flow"*. The computed is then dead, so when its promise later **rejects**, nothing parks the failure: `failure(c)` stays `null`, no error is thrown, and the boundary never sees anything.

This is the same hazard `use()` already guards against. See the comment inside `use()` in `src/async.ts`: it deliberately calls the accessor **before** its pending check so that the dependency edge is established even on the throw path. The binding needs the equivalent protection and does not have it.

Corroboration: the plain-`effect` case works only because that effect's body catches the error *internally* and therefore never throws out — so its dependencies survive.

## Dead ends — do not repeat these

1. **Blaming the supersession guard (`suspendedOn !== p`) or the settle path in `computed.ts`.** Disproved by trace: the computed parks its failure correctly when read directly and when read from a plain effect. Nothing in `computed.ts` needs fixing for this.

2. **Blaming `disposeOwner(nextRunOwner)` in the binding's catch block.** Unlikely: in the failing test the computed is created *outside* `render()`, so it is not owned by that per-run sub-owner and disposing it would not tear the computed down.

3. **"Just stop rethrowing" — replacing `throw e` with `return` for the `NotReadyYet` case.** This was tried **twice**: once on the `insertChild` catch site alone, and once on both catch sites together. Both times the target test *still failed* **and** roughly six `<Loading>` tests broke (`test/dom/loading.test.tsx`, `test/dom/loading-atomic.test.tsx`). **The rethrow is load-bearing for the `<Loading>` boundary.** Removing it is not the fix.

## The keystone question

**Why does `<Loading>` depend on that rethrow?**

Something in the boundary's re-run / commit path is driven by the throw, and returning normally short-circuits it. Understand that first; the fix follows from it. Do not attempt a fix before answering it — that is exactly the mistake made twice above.

Two plausible shapes for the fix, once the question is answered:

- Keep the rethrow, but make the dependency edge survive it — re-read or re-subscribe to the suspended node before throwing, mirroring what `use()` already does.
- Change how `<Loading>` drives its re-runs so it no longer needs the throw at all, and only then remove it.

## Not a bug — a false alarm that was raised and then disproved

`use()` with **no** `<Loading>` boundary above it works correctly. Only the suspended binding renders nothing; the surrounding tree still renders; the suspension does **not** reach an error boundary; and it recovers once the value settles. Two passing tests in `test/dom/loading-no-boundary.test.tsx` lock this in.

An earlier claim that this produced a permanent blank page was wrong. It came from writing `{use(c)}` in JSX instead of the thunk `{() => use(c)}`. The eager form evaluates during JSX construction and throws out of the render root — it is a static read, not a reactive binding. Pulse requires the thunk, as its own `<Loading>` tests show.

## Files that matter

- `src/dom/bindings.ts` — the two `NotReadyYet` catch sites: one in `reactiveCommit` (around line 51), one in `insertChild` (around line 155). Both rethrow.
- `src/dom/loading.ts` — the `<Loading>` boundary, its controller and its gate. **This is the thing that must be understood.**
- `src/async.ts` — `use()`, and the comment explaining why the accessor is called before the pending check. This is the precedent for the fix.
- `src/computed.ts` — the accessor subscribes to `depTracker`, `publishedValue` and the failure signal *before* it throws, so a consumer that catches the error stays subscribed.
- `src/failure.ts` — the failure registry and the `failure()` verb.
- `docs/follow-ups.md` — the r3 auto-dispose note.
- `test/dom/loading-no-boundary.test.tsx` — two passing tests plus the skipped one that is this bug.
- `test/failure.test.ts` — proves the computed side is correct.

## Where the project is

Shipped in the session that produced this document:

- **The async read model.** An async read is a plain `Promise<T>` whose state lives in one WeakMap, resolved through verbs (`use`, `latest`, `isPending`, `read`). The `Awaitable` `Promise` subclass is gone. Read types are runtime-honest — `PipelineRead` folds the async colour across the whole pipeline, so a synchronous stage fed by an async upstream still reads as a `Promise`, and a conditionally-async stage reads as the honest union it really is.
- **`settled([...])`** — the wait-for-all coordination barrier, so a shared consumer swaps to a coherent frame at once rather than a half-updated one.
- **Speculation, exposed.** `action` accepts a synchronous body, an `async` body (the synchronous prefix is speculative; it commits or rolls back when the promise settles), or a generator body (fully speculative across `yield*`, because pulse drives the resumption itself and re-enters the scope). `committed(x)` is the isolation-axis read. Computeds derive through a speculation.
- **Errors as graph state.** A failure is parked beside the value instead of overwriting it, so `latest` can degrade to the stale value, `use` still throws (feeding a boundary), and `failure(x)` queries it. This is what makes stale-while-revalidate survive a failed refetch.

Also on the board, roughly by value:

1. **This bug.**
2. **`optimistic()`** — make an in-flight action's value visible to consumers. Today an action is *isolated*, so a consumer sees the old value until commit: that is transactional-with-rollback, not yet optimistic user interface.
3. **Align `isPending` and `promiseOf`** to read directly, like `latest` and `failure`, instead of returning an accessor you must call. Touches the DOM layer, so it is its own change.
4. **Async inside a speculation** is unsupported: the suspend and settle machinery is driven by r3 and does not run inside a speculative scope, so a still-pending upstream is handed back as the promise rather than awaited.

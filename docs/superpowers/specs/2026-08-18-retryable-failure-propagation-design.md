# Retryable action failure

Pulse gets its own way of letting a failure be retried, instead of leaving retry as a promise rejection nobody has anywhere good to put. This document works out two connected pieces: how `action()` reports and recovers from failure, and how that failure reaches a `<Failed>` boundary.

This document records the conclusions reached in a design discussion on 2026-08-18 and was written before implementation began. It went through three rounds of revision after implementation started:

- An earlier version specified a way for a generator to retry a single failed `yield*` without redoing earlier steps. Cut during design review — see "What was cut, and why it can come back later".
- A later version replaced automatic boundary discovery (an action registers itself with the nearest `<Failed>` boundary through the owner it was called from) with an explicit read (`ActionHandle.check()`, called from inside a binding an app places itself). The trigger was a concrete bug: a reference-keyed `<For>` row recycles itself the instant an optimistic write lands, disposing the very owner the action had captured, before the request even settled — and the disposal guard, doing exactly what it was built to do, suppressed the report for a row that was still on screen.
- That replacement was itself reverted back to automatic discovery once the actual defect was identified: the disposal guard was anchored to the wrong owner. It watched whether the *calling* owner (the row) had been disposed, when what actually matters is whether the *boundary* has been disposed — a boundary that is still mounted should still hear about a failure, no matter how many times the row that triggered it gets torn down and rebuilt underneath it. Anchoring the guard to the boundary's own owner instead fixes the reference-keyed-row case directly, without giving up automatic discovery — which matters because the read-based replacement required an app to manually thread every mutation's handle through a signal (`lastMutation`) it had to remember to write at every call site and read from a binding it had to remember to place, for something that should simply compose. See "What was cut, and why it can come back later" for the full account of both detours.

## Motivation

Solid 2.x has self-healing error boundaries: a retry re-runs only the part that threw, not the whole subtree. Pulse's `<Failed>` boundary already does something close to this for a `computed`/`signal` pipeline — `src/failure.ts`'s `resetFailure` walks a failed accessor's upstream chain to the deepest stage that is actually failed and resets only that one, leaving a healthy earlier stage untouched.

Separately, and for a related reason, `examples/todo-async`'s retry-on-refusal UI (`notice`/`flash()`, added earlier in this session) turned out to be exactly the kind of thing pulse's reactive philosophy argues against: a hand-rolled signal that gets pushed into from an `onSettled` callback and cleared with a `setTimeout`, duplicating information that should be derivable from graph state the way `failure()`/`<Failed>` already derive it for a failed load. The reason it had to be hand-rolled is concrete: `action()` returns a bare `Promise<void>` today, with no persistent identity for anything to register against or read later. Closing that gap is what this design does.

## Part 1 — `action()` returns a handle instead of a promise that rejects

### The shape

```ts
export interface ActionHandle {
  /** The currently in-flight attempt's outcome — the initial run, or the most
   *  recent `retry()` if one is running. Never rejects. Read `.settled` again
   *  after calling `retry()` to get the promise for that attempt; the one
   *  returned before `retry()` was called already resolved when the attempt
   *  it belonged to finished. */
  readonly settled: Promise<void>
  /** Reactive: null while healthy or in flight, the rejection reason once the
   *  action has failed and nothing has retried it yet.
   *
   *  A failure here is also reported automatically to the nearest ambient
   *  `<Failed>` boundary — see Part 2 — so reading this accessor directly is
   *  only needed for code that wants to react to the failure somewhere other
   *  than that boundary's fallback. */
  readonly error: Accessor<unknown>
  /** Re-run the action's body from scratch. This is also what a `<Failed>`
   *  boundary's own retry calls, if this action auto-registered with one. */
  retry(): void
}
```

`settled` is a getter, not a fixed value — each read returns the promise for whichever attempt is current at that moment, which is what makes it meaningful to read again after `retry()`.

`action()`'s generator body, driven by `driveGeneratorAction`, no longer lets an uncaught rejection propagate out of the returned value as a promise rejection. It is captured, reported through `error`, and `settled` resolves regardless of which way the action ended. This is a deliberate, breaking change to today's contract, not an addition alongside it — the reason is the thing that motivated this whole document: `examples/todo-async`'s `.catch(() => {})` exists purely to swallow an unhandled rejection that the caller has no good use for, and that awkwardness is a direct symptom of failure being modelled as a throw instead of as state.

### Why `retry()` re-runs the whole body

`retry()` holds a reference to the original body function and calls `action(body)` again, fresh — the exact same driving logic as the first attempt, with no memory of where the previous attempt got to. Every condition and dependency the body reads gets evaluated against whatever is true right now, exactly like the first run did.

This was a deliberate simplification made during design review, not the starting point. The alternative considered — keep the failed generator instance alive, hold onto whichever specific operation failed, and re-invoke just that one when `retry()` fires, resuming the same paused generator in place rather than starting a new one — has a real use case: a multi-step body where an earlier step did something non-idempotent (charged a card, sent an email, reserved inventory), where redoing it on retry would be a bug, not just wasted work. But every mutation this design was built against — `submitTodo`, `toggleTodo`, `removeTodo` in `examples/todo-async` — has exactly one network call in its body. For a single-step action, "retry just the failed step" and "retry the whole thing" are the same operation, so the finer-grained mechanism would have been built for a case this design does not actually have.

It also has a real correctness risk that "re-run the whole body" does not: holding a generator paused indefinitely, waiting for someone to eventually call `retry()`, freezes every decision it already made to get there — including which branch of an `if` it took, based on a signal it read earlier. If that signal's value changes while the generator sits parked — which could be a long time, since nothing bounds how soon a person clicks retry — resuming the held generator re-invokes the original failed operation on the branch that was correct *back when it first ran*, not the one current state calls for. Restarting the whole body from scratch cannot go stale this way, because every condition is re-read at retry time.

`retry(): void` is deliberately opaque about how it recovers — nothing in the public shape says whether it re-runs everything or resumes something in place. If a genuine multi-step, non-idempotent case shows up later, upgrading `retry()`'s internals to something finer-grained is a change behind that same method, not a public API break. Choosing "whole body, every time" now does not close that door; it just declines to build it before anything needs it.

This is also consistent with `resetFailure`'s existing behaviour for a `computed`/`signal` pipeline stage, which already discards a failed generator and restarts it from the top — nothing about that changes here.

### What this changes elsewhere

`test/async-action.test.ts` currently asserts the old contract directly — `await expect(done).rejects.toThrow('save failed')` — and needs rewriting against `.error` once this lands; this is a deliberate test-contract change, not an oversight to reconcile.

`onSettled` (`src/scope.ts`) is unaffected as a primitive — it remains the lower-level "the scope closed, here is how" notification, useful for anything that is not specifically "did this fail." For the specific case this document is about, `.error` and automatic `<Failed>` discovery (Part 2) supersede what `examples/todo-async` was using `onSettled` for.

## Part 2 — a failed action registers with the nearest `<Failed>` boundary automatically

### The mechanism this reuses is already fully built and already tested

`<Failed>` (`src/dom/failed.ts`) collects reports from a `BindingController`, keyed by the controller so a binding that re-reports several times still occupies one entry. `action()` becomes one more source of these reports, alongside the bindings `src/effect.ts` already registers for a failed `computed`/`signal` read — no change to `<Failed>` itself.

Concretely, `action()` captures the ambient owner at the moment it is called and walks up from there to find the nearest boundary:

```ts
const found = findNearestFailedScope(getOwner())
```

`getOwner()` is whatever owner is ambient right then. For a call made from a component's render, that is the component's own owner. For a call made from inside an `on:` event handler, it is the owner that was captured and restored when the handler was bound — see the prerequisite fix below, since a raw DOM event handler otherwise fires with no owner ambient at all. Called from somewhere with no owner reachable (or a `catchError` sitting nearer than any `<Failed>`), `found` is `null`, the action still runs normally, and its `error`/`retry` are still directly usable — it is just not auto-discovered by anything.

When the action's body throws, and a boundary was found, `action()` registers a `BindingController` with it (lazily — only once a failure actually happens, not on every successful run) and reports `{ status: 'failed', error, source: null, retry }`. `source` is `null` because there is no parked-failure node behind an action's rejection the way there is for a failed `computed` — the report shape already supports that (`test/dom/failed.test.tsx`'s `reset() re-runs a binding that threw a plain error` is the existing test for exactly this shape). On success, or once retried successfully, the controller reports `idle` and unregisters — an action is one-shot, so there is nothing left to keep tracking once it has genuinely succeeded.

### Retry goes through the boundary's own `reset`, with no special-casing needed at the call site

Because the action registered itself directly with the boundary, `<Failed>`'s existing `reset()` already does the right thing with no help: it calls each failed report's own `retry` (see `src/dom/failed.ts`) — which, for an action's report, *is* `ActionHandle.retry()`. An app's fallback needs nothing beyond the ordinary shape:

```tsx
fallback={(error, reset) => (
  <button on:click={reset}>Try again</button>
)}
```

This is a direct improvement on the read-based design this replaced, which needed the fallback to inspect a `lastMutation` signal and choose between `handle.retry()` and `reset()` depending on which kind of failure was currently showing. With the action registering itself, `reset` is always correct, for every kind of failure a boundary might be showing — the boundary does not need to know whether what failed was a `computed`, a `signal`, or an `action`.

### Which owner the disposal guard watches for is what makes this correct

An in-flight action can outlive the specific component or DOM row it was triggered from — that gap between "the owner action() was called with" and "the request actually settling" is exactly what makes automatic discovery need a disposal guard at all: if the owner that triggered the action is gone by the time it fails, nothing should register a stale entry for UI the user can no longer see.

The guard has to watch the right owner, though. It is anchored to the **boundary's own owner** (the one `findNearestFailedScope` found), not to whichever owner was ambient when `action()` was called:

```ts
if (found !== null) {
  runWithOwner(found.owner, () => {
    onCleanup(() => {
      disposed = true
      controller?.unregister()
    })
  })
}
```

`findNearestFailedScope` returns `{ owner, scope }` rather than just the `FailedScope` for exactly this reason — the owner is needed to anchor this cleanup somewhere other than wherever `action()` happened to be called from.

Anchoring to the calling owner instead — which is what an earlier version of this mechanism did — breaks on optimistic UI specifically. `toggleTodo`'s speculative write does `{ ...each, done: !each.done }`, a fresh object; `<For>`'s rows are reference-keyed (`src/dom/for.ts`), so the instant that write lands, `<For>` tears down the row that triggered the click and rebuilds a new one — before the request has even settled. The action's owner was captured from that now-disposed row, so a disposal guard watching *that* owner fires immediately, well before the mutation has a chance to fail, and permanently suppresses reporting for a row that is still fully visible on screen, just quietly rebuilt underneath the user. `test/dom/failed.test.tsx`'s `a mutation triggered from a reference-keyed row still reaches <Failed>, even though its own write recreates that row` is the regression test for this.

Watching the boundary's owner instead asks the right question: not "did the specific thing that triggered this go away", but "is there still somewhere for this failure to be shown at all". A row being recycled by its own optimistic write answers no to the first question and yes to the second, which is exactly the mismatch that broke the earlier version. A boundary being unmounted entirely — the whole subtree containing both the boundary and everything under it going away — answers no to both, and disposal still suppresses correctly: `test/dom/failed.test.tsx`'s `an action that fails after its <Failed> boundary itself unmounted does not register a stale entry anywhere` covers this. The middle case — the specific triggering component unmounts but the boundary around it stays mounted (a modal closing, say, inside a page-level boundary) — now reports the failure rather than suppressing it, a deliberate change from the earlier version's behaviour; `an action that fails after its owning row unmounted (but the boundary is still mounted) still reaches the boundary` states this directly. The boundary's own `reset` button is a perfectly good way to dismiss that failure regardless of whether the triggering UI still exists, so nothing is actually stuck — it is just visible for a little longer than before.

### The one prerequisite: `on:` event handlers need to capture an owner at all

`action()` is very often called directly from an `on:click` handler. Before this could work, `src/dom/bindings.ts`'s `bindProp` needed to capture the ambient owner at bind time and restore it around every invocation of the handler — until this was added, a raw DOM event firing later had no owner ambient at all, since owners are a construction-time concept and a click can happen long after construction. This also fixes `onCleanup` called from inside a click handler, which had the identical problem and is unrelated to actions specifically — both are one fix.

## Explicitly out of scope

- `resetFailure`'s existing gap — it does not cross a `use()` link into a separate `computed()` call — is untouched by this design; it is a pre-existing, separately tracked follow-up.
- `<Loading>` and its atomic-commit gating are untouched.
- Automatic retry policy (backoff, a fixed retry count before giving up, entirely internal to one read) is a different feature from anything here and is not built by this design.
- Retrying a single failed step inside a multi-step body without redoing earlier, already-succeeded steps — see below.

## What was cut, and why it can come back later

### Per-yield retry inside a generator

The earlier draft of this document specified `read()` gaining a fourth argument shape — a thunk, `read(() => apiCall())` — so a specific `yield*` could be marked retryable and its rejection handled by pulse's own mechanism instead of being thrown into the generator. Two designs for that were worked through and both are recorded here for whoever picks this up again, since the reasoning is what would need re-checking, not just the shape:

- **Discard and restart, replaying remembered values positionally.** A rejected thunk-based read still throws into the generator first, same as a plain read; if uncaught, instead of losing everything, pulse would remember what every *earlier* thunk-based read in that run produced and feed those back into a fresh run, so it only genuinely re-executes from the failed one forward. This was dropped because the positional matching — "the Nth thunk-based read this run is the same one as the Nth last run" — breaks silently if the set of reads a body actually reaches differs between runs, the same class of risk as violating React's rule that hooks run in the same order every render.
- **Hold the generator paused, retry re-invokes just the held thunk.** Simpler, and it avoids positional matching entirely, because the generator is never restarted — everything before the failed read is still sitting in its own local variables, since it is still alive. This was dropped for the staleness reason in "Why `retry()` re-runs the whole body" above: a paused generator does not re-evaluate the conditions it already used to get where it is, so a retry fired after upstream state has moved on can act on a decision that is no longer correct. It also means a rejected thunk-based read never reaches the generator's own `try`/`catch` — a real, if smaller, behavioural surprise on its own.

Either could be revisited if a genuine multi-step, non-idempotent case shows up — `resetFailure`'s `reset()` for a stage and `ActionHandle.retry()` for an action are both already the right, stable place to make that change internally, without touching anything that calls them.

### Automatic boundary discovery through the calling owner

This section now covers two detours: the first version of automatic discovery, which was replaced by a read-based design; and that read-based design, which was in turn replaced by the corrected automatic discovery Part 2 now describes.

**The first automatic-discovery attempt, and the bug that ended it.** `action()` called `getOwner()` at the moment it was invoked, walked upward via `findNearestFailedScope` to find the nearest `<Failed>`, and registered a `BindingController` with it directly — no read anywhere required. It needed the same `on:` event handler owner-capture prerequisite Part 2 still describes. It was built, reviewed, and had one real bug found and fixed during that review: a controller could register with a still-alive boundary after its owning component had already been disposed, if the failure arrived after disposal — fixed at the time with a `disposed` flag, set by an `onCleanup` registered on whichever owner was ambient when `action()` was called (i.e. the calling owner, not the boundary).

That fix was itself the bug. Manually verifying the finished `examples/todo-async` migration surfaced it: `toggleTodo`'s speculative write does `{ ...each, done: !each.done }` — a fresh object, not the same one. `<For>`'s rows are reference-keyed (`src/dom/for.ts`), so the instant that write lands, `<For>` sees a new object at that array position, tears down the old row's owner, and builds a new one — before the server has even responded. The action's owner was captured from the *old* row at the moment the checkbox was clicked, and that row is disposed almost immediately by the action's own optimistic write, not by the user navigating away. The disposal guard, watching that owner, fired immediately and permanently suppressed reporting for a row that was still fully visible on screen, just quietly rebuilt underneath the user.

**The read-based detour.** At the time, this looked like a structural mismatch with automatic discovery itself, not just a misplaced guard: discovery through "the owner active when the triggering event fired" seemed only as reliable as that owner's lifetime, and an optimistic write over a reference-keyed list is a case, not a corner case, where that lifetime is much shorter than the action it represents. Solid's own error boundary was checked for comparison: Solid's `<ErrorBoundary>` does not attempt to catch errors from event handlers at all, and Solid Router's equivalent to this problem (`useSubmission`) is read-based — a hook the app calls wherever it wants a submission's `.error` visible, with nothing auto-discovered. That looked like confirmation that read-based was the right direction, so Part 2 was rewritten around `ActionHandle.check()`: a strict, throw-on-failure counterpart to `error()`, called from inside a binding an app places itself, with a `lastMutation` signal holding whichever handle should currently be visible.

It worked, and was fully implemented, tested, and used to migrate `examples/todo-async` — but it traded away composition to fix a bug that had a narrower cause. Every mutation function in the app had to remember to write its handle into `lastMutation`; the boundary could only ever show one mutation's failure at a time, keyed by whichever call happened most recently, rather than something that naturally composed across concurrent mutations; and a binding had to be placed and kept in sync with which handle was current, entirely by hand — exactly the kind of manual state synchronization pulse's reactive philosophy exists to avoid, and the same complaint that motivated cutting `examples/todo-async`'s original hand-rolled `notice`/`flash()` UI in the first place (see Motivation, above).

**Revisiting the actual cause.** The bug was never that automatic discovery is unreliable — it was that the disposal guard was watching the wrong owner. What a disposal guard should be asking is "is there still somewhere for this failure to be shown", and the boundary's own owner answers that question directly, regardless of how many times the specific row that triggered the click gets recycled underneath it. Re-anchoring the guard to `findNearestFailedScope`'s returned boundary owner (Part 2, above) fixes the reference-keyed-row case without giving up automatic discovery, and restores composition: no signal to thread, no binding to place, multiple concurrent actions from different rows all report and clear independently with no coordination required at the call site.

If a future case genuinely needs the read-based shape instead — e.g. showing more than one mutation's failure at once, or showing a failure somewhere other than the nearest enclosing boundary — `ActionHandle.check()` and the `lastMutation`-signal pattern are recoverable from this document's git history at the commits where they were built (`da818a2` through `624c76d`), and the original (uncorrected) automatic-discovery code is recoverable at `07343a9` and `cd71fe5`.

## Resolved during review

- `ActionHandle`'s shape is named fields (`settled`, `error`, `retry`), as written above — not a tuple. A tuple fits `signal`'s `[accessor, setter]` convention because both members are used together at nearly every call site; `ActionHandle`'s members are read independently and at different times (`retry()` from a UI event, `error` from a reactive read, `settled` only by code that specifically wants to await one attempt), so named access reads better at each of those call sites than a positional destructure would.

# Retryable action failure

Pulse gets its own way of letting a failure be retried, instead of leaving retry as a promise rejection nobody has anywhere good to put. This document works out two connected pieces: how `action()` reports and recovers from failure, and how that failure reaches a `<Failed>` boundary.

This document records the conclusions reached in a design discussion on 2026-08-18 and was written before implementation began. It went through two rounds of revision after implementation started: an earlier version specified a way for a generator to retry a single failed `yield*` without redoing earlier steps, which was cut during design review (see "What was cut, and why it can come back later" for that one); a later version specified automatic boundary discovery through the owner an action was called from, which was built, reviewed, fixed once, and then replaced by the design below after a concrete bug in a real example surfaced a deeper problem with that approach (see "What was cut, and why it can come back later" for that one too — the reasoning is worth keeping, since a future maintainer could reasonably reach for the same design again without knowing why it did not hold up).

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
   *  action has failed and nothing has retried it yet. */
  readonly error: Accessor<unknown>
  /** Strict read: throws the current error if the action has failed and
   *  nothing has retried it yet; does nothing otherwise. Call this from
   *  inside a binding to let a `<Failed>` boundary catch the failure the same
   *  way it already catches a failed `computed`/`signal` read — see Part 2. */
  check(): void
  /** Re-run the action's body from scratch. */
  retry(): void
}
```

`settled` is a getter, not a fixed value — each read returns the promise for whichever attempt is current at that moment, which is what makes it meaningful to read again after `retry()`.

`action()`'s generator body, driven by `driveGeneratorAction`, no longer lets an uncaught rejection propagate out of the returned value as a promise rejection. It is captured, reported through `error`, and `settled` resolves regardless of which way the action ended. This is a deliberate, breaking change to today's contract, not an addition alongside it — the reason is the thing that motivated this whole document: `examples/todo-async`'s `.catch(() => {})` exists purely to swallow an unhandled rejection that the caller has no good use for, and that awkwardness is a direct symptom of failure being modelled as a throw instead of as state.

`check()` is a thin wrapper over `error`, nothing more:

```ts
function check(): void {
  const e = error()
  if (e !== null) throw e
}
```

It exists because `error()` alone is the *tolerant* view — it degrades, the way `latest()` does for a value — and pulse already has a name for the *strict* counterpart to a tolerant read everywhere else in the library (`use()` next to `latest()`, a computed's own accessor next to its parked failure). `check()` is that counterpart for an action: read it inside a reactive binding, and a failure becomes a real throw, which is what lets ordinary error-boundary catching apply to it.

### Why `retry()` re-runs the whole body

`retry()` holds a reference to the original body function and calls `action(body)` again, fresh — the exact same driving logic as the first attempt, with no memory of where the previous attempt got to. Every condition and dependency the body reads gets evaluated against whatever is true right now, exactly like the first run did.

This was a deliberate simplification made during design review, not the starting point. The alternative considered — keep the failed generator instance alive, hold onto whichever specific operation failed, and re-invoke just that one when `retry()` fires, resuming the same paused generator in place rather than starting a new one — has a real use case: a multi-step body where an earlier step did something non-idempotent (charged a card, sent an email, reserved inventory), where redoing it on retry would be a bug, not just wasted work. But every mutation this design was built against — `submitTodo`, `toggleTodo`, `removeTodo` in `examples/todo-async` — has exactly one network call in its body. For a single-step action, "retry just the failed step" and "retry the whole thing" are the same operation, so the finer-grained mechanism would have been built for a case this design does not actually have.

It also has a real correctness risk that "re-run the whole body" does not: holding a generator paused indefinitely, waiting for someone to eventually call `retry()`, freezes every decision it already made to get there — including which branch of an `if` it took, based on a signal it read earlier. If that signal's value changes while the generator sits parked — which could be a long time, since nothing bounds how soon a person clicks retry — resuming the held generator re-invokes the original failed operation on the branch that was correct *back when it first ran*, not the one current state calls for. Restarting the whole body from scratch cannot go stale this way, because every condition is re-read at retry time.

`retry(): void` is deliberately opaque about how it recovers — nothing in the public shape says whether it re-runs everything or resumes something in place. If a genuine multi-step, non-idempotent case shows up later, upgrading `retry()`'s internals to something finer-grained is a change behind that same method, not a public API break. Choosing "whole body, every time" now does not close that door; it just declines to build it before anything needs it.

This is also consistent with `resetFailure`'s existing behaviour for a `computed`/`signal` pipeline stage, which already discards a failed generator and restarts it from the top — nothing about that changes here.

### What this changes elsewhere

`test/async-action.test.ts` currently asserts the old contract directly — `await expect(done).rejects.toThrow('save failed')` — and needs rewriting against `.error` once this lands; this is a deliberate test-contract change, not an oversight to reconcile.

`onSettled` (`src/scope.ts`) is unaffected as a primitive — it remains the lower-level "the scope closed, here is how" notification, useful for anything that is not specifically "did this fail." For the specific case this document is about, `.error`/`.check()` supersede what `examples/todo-async` was using `onSettled` for.

## Part 2 — a failure reaches `<Failed>` through an explicit read, not automatic discovery

### The mechanism this reuses is already fully built and already tested

`<Failed>` (`src/dom/failed.ts`) does not know anything about actions, and this design does not teach it anything new. It already catches a *plain thrown error* from any binding inside it — `test/dom/failed.test.tsx`'s `reset() re-runs a binding that threw a plain error` is exactly this case, with `source: null` on the report, the same shape a `check()` throw produces. Calling `check()` from inside a binding is not a special integration point; it is an ordinary read that happens to throw, exactly like reading a failed `computed`'s accessor directly does.

Concretely, an app keeps a small signal holding whichever `ActionHandle` it currently cares about showing:

```ts
const [lastMutation, setLastMutation] = signal<ActionHandle | null>(null)

function toggleTodo(todo: Todo) {
  setLastMutation(action(function* () {
    // ...
  }))
}
```

and places one binding somewhere inside the `<Failed>` boundary that reads it:

```tsx
<Failed fallback={...}>
  {() => (
    <>
      {() => lastMutation()?.check()}
      <TodoList/>
    </>
  )}
</Failed>
```

That binding re-runs whenever `lastMutation` changes (a new mutation started) or the current handle's `error` changes (it failed, or a retry cleared it) — ordinary dependency tracking, nothing bespoke. When it throws, `<Failed>` catches it the same way it always has.

### Retrying has to call `ActionHandle.retry()` directly — `<Failed>`'s generic `reset` is not enough on its own

This is the one place this design needed working out carefully, because it is not obvious on first read. `<Failed>`'s fallback receives `(error, reset)`, and `reset` re-runs whichever binding reported the failure — for the `check()` binding above, re-running it just calls `check()` again, which reads the *same* `error()` that has not changed, and throws the same error immediately. Nothing about `reset` on its own retries the action; it only replays the read.

So the fallback has to call `ActionHandle.retry()` itself, not `reset`, when the currently-showing failure is this action's:

```tsx
fallback={(error, reset) => (
  <button on:click={() => {
    const handle = lastMutation()
    if (handle !== null && handle.error() !== null) handle.retry()
    else reset()
  }}>
    Try again
  </button>
)}
```

`retry()` clears `error()` synchronously (Part 1), so the `check()` binding re-runs, does not throw, and reports healthy — at which point `<Failed>`'s collection empties and the fallback disappears on its own. This is not new behaviour needing new plumbing: it is the exact case `test/dom/failed.test.tsx`'s `the boundary unlatches itself when the failure clears` already covers — a boundary is a selection over live state, not a latch, so it already knows how to stop showing a fallback the moment nothing under it is failed anymore, with no `reset()` call at all involved. Falling back to `reset()` when the failure is not this action's own (e.g. the initial load failed instead) keeps the existing load-failure path untouched.

### No auto-discovery, and no owner capture needed for this

This design needs nothing from the owner tree. `action()` does not call `getOwner()`, does not walk anything, does not register a `BindingController`, and does not need to know or care whether it was called from an event handler, a component body, or anywhere else. Whether a failure is ever shown anywhere is entirely up to whether some binding, somewhere, reads `check()` — the same way whether a `computed`'s failure is ever shown depends on whether some binding reads it.

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

This is the design Part 2 originally specified, in full: `action()` would call `getOwner()` at the moment it was invoked, walk upward via `findNearestFailedScope` to find the nearest `<Failed>`, and register a `BindingController` with it directly — no read anywhere required, a failure would just show up. It needed one prerequisite fix that is still in the codebase and still worth having on its own merits: `src/dom/bindings.ts`'s `on:` event handlers capture no owner at all today, so `bindProp` now captures the ambient owner at bind time and restores it around the handler call — this also fixes `onCleanup` called from inside a click handler, which had the identical problem and is unrelated to actions specifically.

The auto-discovery mechanism itself was built, reviewed, and had one real bug found and fixed (a controller could register with a still-alive boundary after its owning component had already been disposed, if the failure arrived after disposal — fixed with a `disposed` flag checked before registering). It was then replaced, not because that fix was wrong, but because manually verifying the finished `examples/todo-async` migration surfaced a deeper problem the review process had not reached.

The concrete failure: `toggleTodo`'s speculative write does `{ ...each, done: !each.done }` — a fresh object, not the same one. `<For>`'s rows are reference-keyed (`src/dom/for.ts`), so the instant that write lands, `<For>` sees a new object at that array position, tears down the old row's owner, and builds a new one — before the server has even responded. The action's owner was captured from the *old* row at the moment the checkbox was clicked, and that row is disposed almost immediately by the action's own optimistic write, not by the user navigating away. The disposal-guard fix, doing exactly what it was built to do, then correctly refused to register a failure against an owner it believed was legitimately gone — except the row was not gone from the user's point of view; it had just been quietly rebuilt, and was still on screen the whole time.

This is not a bug specific to this demo's list. It is a structural mismatch: automatic discovery through "the owner active when the triggering event fired" is only as reliable as that owner's lifetime, and an optimistic write reference-keyed list is a case, not a corner case, where that lifetime is much shorter than the action it is supposed to represent. Confirmed against Solid's own error boundary before replacing this design: Solid's `<ErrorBoundary>` does not attempt to catch errors from event handlers at all, and Solid Router's equivalent to this problem (`useSubmission`) is read-based — a hook the app calls wherever it wants a submission's `.error` visible, with nothing auto-discovered. Read-based was not merely an available alternative; it is the direction the closest prior art already went, for what looks like the same underlying reason.

If a future case genuinely needs zero-wiring discovery despite this — some usage pattern that does not sit inside a reference-keyed list — the owner-capture prerequisite is still in place, and the registration code (`findNearestFailedScope`, a lazily-registered `BindingController`, the `disposed` guard, all layered inside `runAttempt`'s generation-guarded settle branches) is recoverable from this document's git history at the commits where it was built (`07343a9`) and fixed (`cd71fe5`).

## Resolved during review

- `ActionHandle`'s shape is named fields (`settled`, `error`, `retry`, `check`), as written above — not a tuple. A tuple fits `signal`'s `[accessor, setter]` convention because both members are used together at nearly every call site; `ActionHandle`'s members are read independently and at different times (`retry()` from a UI event, `error`/`check()` from a reactive read, `settled` only by code that specifically wants to await one attempt), so named access reads better at each of those call sites than a positional destructure would.

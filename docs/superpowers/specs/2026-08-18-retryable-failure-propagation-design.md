# Retryable action failure and boundary auto-discovery

Pulse gets its own way of letting a failure be retried, instead of leaving retry as a promise rejection nobody has anywhere good to put. This document works out two connected pieces: how `action()` reports and recovers from failure, and how a `<Failed>` boundary discovers a failed action without anything being wired to it by hand.

This document records the conclusions reached in a design discussion on 2026-08-18 and was written before implementation began. An earlier version of this document specified a third piece — a way for a generator to retry a single failed `yield*` without redoing earlier steps that already succeeded, without discarding the generator instance. It was cut during design review; see "Why retry re-runs the whole body" below for why, and "What was cut, and why it can come back later" for the reasoning kept for the record.

## Motivation

Solid 2.x has self-healing error boundaries: a retry re-runs only the part that threw, not the whole subtree. Pulse's `<Failed>` boundary already does something close to this for a `computed`/`signal` pipeline — `src/failure.ts`'s `resetFailure` walks a failed accessor's upstream chain to the deepest stage that is actually failed and resets only that one, leaving a healthy earlier stage untouched.

Separately, and for a related reason, `examples/todo-async`'s retry-on-refusal UI (`notice`/`flash()`, added earlier in this session) turned out to be exactly the kind of thing pulse's reactive philosophy argues against: a hand-rolled signal that gets pushed into from an `onSettled` callback and cleared with a `setTimeout`, duplicating information that should be derivable from graph state the way `failure()`/`<Failed>` already derive it for a failed load. The reason it had to be hand-rolled is concrete: `action()` returns a bare `Promise<void>` today, with no persistent identity for anything to register against or read later. Closing that gap is what this design does.

## Part 1 — `action()` returns a handle instead of a promise that rejects

### The new shape

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
  /** Re-run the action's body from scratch. */
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

`onSettled` (`src/scope.ts`) is unaffected as a primitive — it remains the lower-level "the scope closed, here is how" notification, useful for anything that is not specifically "did this fail." For the specific case this document is about, `.error` supersedes what `examples/todo-async` was using `onSettled` for.

## Part 2 — a failed action is discovered by the nearest `<Failed>` boundary automatically

### The registration mechanism already exists — for bindings

`src/dom/failed.ts`'s `Failed` component installs a `FailedScope` on its own owner (`boundaryOwner.boundaries.failed = scope`, `src/owner.ts`). A binding that fails registers a `BindingController` via `scope.register()` once, and reports state changes to it (`controller.report({ status: 'failed', error, source, retry })`); `findNearestFailedScope(start)` walks up the owner chain from a given owner to find it. This is exactly the mechanism an `ActionHandle` should use — not a new one, and notably **not** `src/failure.ts`'s accessor-keyed `FailureEntry` registry, which is a different, unrelated registration path built for `computed`/`signal` stages specifically. A `BindingController`'s `source` field is already `Accessor<unknown> | null`, precisely so a failure that did not come from a registered failure-tracked node — which an action's is — can report `source: null` and still participate.

### The real gap: event handlers capture no owner today

`<Loading>`/`<Failed>` discovery works today because it happens *during* a live reactive computation, where `getOwner()` returns something meaningful. An `action()` call made from inside `on:click={() => toggleTodo(todo)}` happens later, in response to a raw DOM event, entirely outside any r3 context — `src/dom/bindings.ts`'s `bindProp` currently does a bare `el.addEventListener(event, handler)` with no owner captured at all. By the time the handler actually runs, there is nothing for `findNearestFailedScope` to walk from.

This needs its own fix, and it is a genuinely separate, smaller piece of value on its own — it would also matter for `onCleanup` registered from inside a click handler today, which has the identical problem. `bindProp`'s `on:` handling captures the ambient owner at bind time — which does run under a live owner, since JSX construction happens inside `runWithOwner(boundaryOwner, props.children)` — and restores it around the handler call when the DOM fires the event later:

```ts
if (name.startsWith('on:')) {
  const event = name.slice(3)
  if (typeof value !== 'function') return
  warnIfOrphaned('event listener')
  const capturedOwner = getOwner()
  const handler = value as EventListener
  const wrapped = (e: Event) => runWithOwner(capturedOwner, () => handler(e))
  el.addEventListener(event, wrapped)
  onCleanup(() => el.removeEventListener(event, wrapped))
  return
}
```

### How `action()` registers

With that fix in place, `action()` at call time does:

```ts
const owner = getOwner()
const failedScope = findNearestFailedScope(owner)
let controller: BindingController | null = null
```

- On an uncaught failure: lazily obtain `controller = failedScope?.register() ?? null`, then `controller?.report({ status: 'failed', error, source: null, retry })`.
- On a successful settle (initial run or after a retry): `controller?.report({ status: 'idle' })`, then `controller?.unregister()` — an action is one-shot, not a long-lived binding, so once it has genuinely succeeded there is nothing left to keep registered.
- `onCleanup(() => controller?.unregister())`, registered against `owner`, so a component unmounting mid-action does not leave a stale entry behind.

If there is no ambient `<Failed>` boundary — `findNearestFailedScope` returns `null` — the action still runs exactly the same way, and `ActionHandle.error`/`.retry` are still usable directly by whoever called `action()`. Auto-discovery is additive, not a requirement for the handle to work.

### What this does to `examples/todo-async`

`notice`, `flash()`, and the hand-rolled retry button disappear entirely. The existing `<Failed fallback={...}>` already wrapping the todo list picks up a mutation failure the same way it already picks up a failed load, and its existing "Try again" button retries it — no new UI code, because there is no longer separate state to synchronize.

## Explicitly out of scope

- `resetFailure`'s existing gap — it does not cross a `use()` link into a separate `computed()` call — is untouched by this design; it is a pre-existing, separately tracked follow-up.
- `<Loading>` and its atomic-commit gating are untouched.
- Automatic retry policy (backoff, a fixed retry count before giving up, entirely internal to one read) is a different feature from anything here and is not built by this design.
- Retrying a single failed step inside a multi-step body without redoing earlier, already-succeeded steps — see below.

## What was cut, and why it can come back later

The earlier draft of this document specified `read()` gaining a fourth argument shape — a thunk, `read(() => apiCall())` — so a specific `yield*` could be marked retryable and its rejection handled by pulse's own mechanism instead of being thrown into the generator. Two designs for that were worked through and both are recorded here for whoever picks this up again, since the reasoning is what would need re-checking, not just the shape:

- **Discard and restart, replaying remembered values positionally.** A rejected thunk-based read still throws into the generator first, same as a plain read; if uncaught, instead of losing everything, pulse would remember what every *earlier* thunk-based read in that run produced and feed those back into a fresh run, so it only genuinely re-executes from the failed one forward. This was dropped because the positional matching — "the Nth thunk-based read this run is the same one as the Nth last run" — breaks silently if the set of reads a body actually reaches differs between runs, the same class of risk as violating React's rule that hooks run in the same order every render.
- **Hold the generator paused, retry re-invokes just the held thunk.** Simpler, and it avoids positional matching entirely, because the generator is never restarted — everything before the failed read is still sitting in its own local variables, since it is still alive. This was dropped for the staleness reason in "Why `retry()` re-runs the whole body" above: a paused generator does not re-evaluate the conditions it already used to get where it is, so a retry fired after upstream state has moved on can act on a decision that is no longer correct. It also means a rejected thunk-based read never reaches the generator's own `try`/`catch` — a real, if smaller, behavioural surprise on its own.

Either could be revisited if a genuine multi-step, non-idempotent case shows up — `resetFailure`'s `reset()` for a stage and `ActionHandle.retry()` for an action are both already the right, stable place to make that change internally, without touching anything that calls them.

## Open questions for review

1. `ActionHandle`'s exact shape — `settled` / `error` / `retry` as named fields, versus some other arrangement (e.g. a tuple, matching `signal`'s `[accessor, setter]` convention).

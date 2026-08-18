# Retryable failure propagation — thunk-based reads, action failure, boundary auto-discovery

Pulse gets its own way of letting a failure be retried, instead of accepting the ceiling that native JavaScript generator semantics impose. Today, once a rejection has been thrown into a generator via `gen.throw()` and nothing catches it, that generator is permanently done — there is no way to hand it a fresh value and keep going. Retrying "just the part that failed" therefore cannot mean resuming the same generator instance; it has to mean something else. This document works out what that something else is, and follows the consequence through three places: how a generator stage reads something retryable, how an `action()` reports and recovers from failure, and how a `<Failed>` boundary discovers a failed action without anything being wired to it by hand.

This document records the conclusions reached in a design discussion on 2026-08-18 and was written before implementation began.

## Motivation

Solid 2.x has self-healing error boundaries: a retry re-runs only the part that threw, not the whole subtree. Pulse's `<Failed>` boundary already does something close to this for a `computed`/`signal` pipeline — `src/failure.ts`'s `resetFailure` walks a failed accessor's upstream chain to the deepest stage that is actually failed and resets only that one, leaving a healthy earlier stage untouched. The granularity that is missing is *inside* one generator stage's body: a rejection at a specific `yield*` currently either gets caught by the generator's own `try`/`catch`, or it escapes and the whole generator is discarded and restarted from the top — redoing every step that already succeeded.

Separately, and for a related reason, `examples/todo-async`'s retry-on-refusal UI (`notice`/`flash()`, added earlier in this session) turned out to be exactly the kind of thing pulse's reactive philosophy argues against: a hand-rolled signal that gets pushed into from an `onSettled` callback and cleared with a `setTimeout`, duplicating information that should be derivable from graph state the way `failure()`/`<Failed>` already derive it for a failed load. The reason it had to be hand-rolled is concrete: `action()` returns a bare `Promise<void>` today, with no persistent identity for anything to register against or read later. Closing that gap is part of this design, not a follow-on.

## Guiding principle

Be as fine-grained as possible, and fall back to something coarser only when there is nothing finer to reach for. This is not three separate mechanisms layered on top of each other — it is one mechanism (a thunk-based read remembers its result across a failure-triggered restart) that degrades gracefully on its own:

- Nothing in a generator body uses a thunk-based read → a retry redoes everything, which is exactly today's `resetFailure` behaviour, unchanged.
- Some reads are thunk-based → a retry replays whatever already succeeded and only re-executes from the first one that did not.
- Retrying reaches all the way down to one specific failed read, unambiguously → that is the finest case, and it falls out of the same mechanism rather than needing its own.

The same principle applies to `action()`: its `retry()` uses this identical mechanism, so a multi-step action does not redo an earlier step that already succeeded either.

## Part 1 — `read()` accepts a thunk, and a thunk-based read can be replayed

### What changes and what does not

`read(x)` keeps its existing three cases — a signal accessor, a promise, or a plain value — and gains a fourth: a plain zero-argument function (a thunk) that is not a signal accessor.

```ts
function* stage() {
  const users = yield* read(() => api.list())
  return users
}
```

The reason a thunk is required rather than an already-created promise is unavoidable: a promise object cannot be redone. `yield* read(apiCall())` has already evaluated `apiCall()` by the time `read` sees it — there is nothing left to retry. `yield* read(() => apiCall())` hands `read` the expression itself, so a retry can call it again and get a genuinely fresh attempt.

**Unchanged:** a rejected thunk-based read still throws into the generator via `gen.throw()` first, exactly like a plain `read()` yield. A local `try`/`catch` around it keeps working precisely as it does today — there is no second, parallel failure-propagation path that bypasses the generator's own exception handling. The difference only shows up if the rejection is uncaught and escapes the generator body.

**New:** when that happens, pulse remembers the values every thunk-based read *before* the failed one resolved to, for this run only. When the generator stage — or the action, see Part 2 — is retried, the fresh run replays those remembered values instead of re-invoking their thunks, and only genuinely re-executes starting at the one that actually failed. A retry that reaches a dependency change instead of a genuine retry trigger does **not** replay anything: the input moved, so everything should re-run, exactly as it does today.

### Why this needed no type-level work

`Yielded<T>` and `Resolved<T>` (`src/async.ts`, added earlier in this session's generator-colour-fix work) already unwrap `T extends () => infer U` generically — they do not distinguish a signal accessor from a plain thunk at the type level, only `isSignalAccessor`'s *runtime* check does that. So `read(() => api.list())`'s type already resolves correctly today; this part is purely a runtime addition inside `read`'s implementation, not a type change.

### Where the replay memo lives, and how it is threaded through

`read`'s generator body has no state of its own across separate invocations — a fresh inner generator is created every time the outer body executes `yield* read(x)` in source. The memo therefore cannot live inside `read`; it has to be ambient state that the driver sets up around each synchronous segment of the outer generator, the same way `src/generator-cleanup.ts` already does for `onCleanup` routing.

A new module, `src/generator-replay.ts`, mirrors that existing pattern:

```ts
export interface ReplaySlot {
  /** What a thunk-based read produced last time, in call order — from the run
   *  that failed and is now being retried. Consumed positionally. */
  memo: readonly unknown[]
  /** What a thunk-based read has produced so far in THIS run, in call order.
   *  Becomes the next run's `memo` if this run also fails and is retried. */
  recorded: unknown[]
}

let current: ReplaySlot | null = null

export function withReplaySlot<T>(slot: ReplaySlot | null, fn: () => T): T {
  const saved = current
  current = slot
  try {
    return fn()
  } finally {
    current = saved
  }
}

export function currentReplaySlot(): ReplaySlot | null {
  return current
}
```

`read`'s thunk branch consults it:

```ts
if (typeof x === 'function' && !isSignalAccessor(x)) {
  const slot = currentReplaySlot()
  const position = slot === null ? -1 : slot.recorded.length
  const alreadySucceeded = slot !== null && position < slot.memo.length
  const produced = alreadySucceeded
    ? ((yield slot.memo[position] as Yielded<T>) as Resolved<T>)
    : ((yield (x as () => unknown)() as Yielded<T>) as Resolved<T>)
  // Reaching this line at all means the yield settled successfully — a
  // rejection would have resumed via gen.throw() instead, jumping past here.
  if (slot !== null) slot.recorded.push(produced)
  return produced
}
```

A replayed value is a plain (already-resolved) value, not a promise, so it goes through the driver's existing `settle()` the same way any synchronous result does — it resumes immediately, with no special-casing needed. This is a pleasing consequence of the generator-colour fix from earlier this session: a retry that replays several already-succeeded steps and only genuinely awaits the one that failed becomes synchronous-then-asynchronous through the same machinery that already exists for that shape, not a new one.

The driver side threads a `ReplaySlot` through each attempt:

- **Computed/signal stages** (`src/computed.ts`, `src/driver.ts`): `driveGenerator`'s existing `collectGeneratorCleanups` wrap around each `gen.next()`/`gen.throw()` call gains a sibling `withReplaySlot` wrap. `makeStageNode` keeps a `let retryMemo: readonly unknown[] = []` alongside its existing per-stage state; on an uncaught escape, `retryMemo` is set from the failed run's `slot.recorded`. `reset()` (called from `resetFailure`'s walk) passes `{ memo: retryMemo, recorded: [] }` into the fresh run. A restart triggered by a genuine dependency change — the `changed` branch in the existing `retainedGen` handling — passes `{ memo: [], recorded: [] }` instead, so nothing is replayed.
- **Actions** (`src/scope.ts`): `driveGeneratorAction`'s `gen.next()`/`gen.throw()` calls get the same wrap. The action instance (see Part 2) keeps its own `retryMemo`, updated the same way, and `retry()` passes it into the next attempt.

### Open question: positional identity under conditional control flow

The memo is consumed positionally — the Nth thunk-based read in this run reuses the Nth remembered value, by count alone, the same way React's "hooks must run in the same order" rule works. If a generator's control flow genuinely varies between the failed run and the retried run — a thunk-based read inside an `if` whose condition changed — a positional replay could hand a later read the value meant for an earlier one, silently.

The default decision here is to accept this as a documented constraint rather than build a detection-and-safe-fallback mechanism for it, on the grounds that pulse already carries an equivalent, currently-open limitation in a closely related mechanism: `docs/follow-ups.md` already tracks a bug in `ADR 0013`'s dependency-replay (`depRecords`) where a generator's varying control flow confuses what gets replayed. Adding a second, differently-shaped version of the same class of constraint is consistent with what is already there, and a bespoke signature-based divergence check would be new machinery whose own correctness would need scrutiny. This is flagged for review, not settled — the alternative (record something identifying enough to detect a mismatch and drop the memo from that point forward, falling back to the coarse "redo everything after this point" behaviour automatically) is a reasonable v2 if this proves to matter in practice.

## Part 2 — `action()` returns a handle instead of a promise that rejects

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
  /** Re-run the action from its point of failure, replaying whatever
   *  thunk-based reads already succeeded (Part 1). */
  retry(): void
}
```

`settled` is a getter, not a fixed value — each read returns the promise for whichever attempt is current at that moment, which is what makes it meaningful to read again after `retry()`.

`action()`'s generator body, driven by `driveGeneratorAction`, no longer lets an uncaught rejection propagate out of the returned value as a promise rejection. It is captured, reported through `error`, and `settled` resolves regardless of which way the action ended. This is a deliberate, breaking change to today's contract, not an addition alongside it — the reason is the thing that motivated this whole document: `examples/todo-async`'s `.catch(() => {})` exists purely to swallow an unhandled rejection that the caller has no good use for, and that awkwardness is a direct symptom of failure being modelled as a throw instead of as state.

### What this changes elsewhere

`test/async-action.test.ts` currently asserts the old contract directly — `await expect(done).rejects.toThrow('save failed')` — and needs rewriting against `.error` once this lands; this is a deliberate test-contract change, not an oversight to reconcile.

`onSettled` (`src/scope.ts`) is unaffected as a primitive — it remains the lower-level "the scope closed, here is how" notification, useful for anything that is not specifically "did this fail." For the specific case this document is about, `.error` supersedes what `examples/todo-async` was using `onSettled` for.

## Part 3 — a failed action is discovered by the nearest `<Failed>` boundary automatically

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
- Automatic retry policy (backoff, a fixed retry count before giving up) is deliberately not built here — that is a different feature (this document's earlier exploration called it "interpretation 1"), self-contained inside a single read, and does not need any of this machinery. It could be layered on top of a thunk-based read later without conflicting with anything here.

## Open questions for review

1. Positional replay safety under conditional control flow (Part 1) — accept as a documented constraint, matching the existing `depRecords` limitation, or build detection-and-safe-fallback now.
2. `ActionHandle`'s exact shape — `settled` / `error` / `retry` as named fields, versus some other arrangement (e.g. a tuple, matching `signal`'s `[accessor, setter]` convention).
3. Whether `ActionHandle.retry()` should itself return something (e.g. a fresh `settled` promise for that specific attempt) or stay `void`, relying entirely on `error`/`settled` being read reactively.

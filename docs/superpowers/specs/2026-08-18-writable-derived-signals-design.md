# Writable derived signals — `signal(fn)`

A derivation that also has a setter. `signal` accepts the same stage list `computed` accepts and returns an accessor and a setter, so a value can be produced by a derivation and also written directly.

This document records the conclusions reached in a design discussion on 2026-08-18. The design is complete: semantics, construction, cancellation, speculation, registry integration, the three defects the scenarios exposed, and the test plan. Nothing has been implemented.

Two pieces of work it depends on are tracked separately in [`docs/follow-ups.md`](../../follow-ups.md): a way to withdraw a queued recomputation, which pulse's pinned fork of r3 has to expose, and `cancel(x)`, designed here and shipped on its own because it applies to any derivation.

The scenarios this design is checked against are catalogued as group W in [`docs/pulse/scenarios.md`](../../pulse/scenarios.md#w-writes-into-derivations-signalfn). All twenty-two were walked, and two of them changed the design: W10 established that a cancelled upstream stage must be left needing recomputation rather than clean, and W1 established that the update function must receive the last resolved value rather than the raw published read.

An accompanying visual summary of the same material is published at <https://claude.ai/code/artifact/9585d141-a661-47eb-8f45-5ede7ea4ec99>.

## The problem

A derivation reads a signal and fetches. While that fetch is in flight, something writes a value directly into the derived signal.

```ts
const [todos, setTodos] = signal(function* () {
  version()
  return yield* read(api.list())   // takes 2 seconds
})

setVersion(v => v + 1)             // t = 0ms — starts a fetch that takes 2 seconds
setTodos(prev => [...prev, saved]) // t = 200ms — an add finished, write it in
```

At the moment of the write a fetch is still running. It will finish 1.8 seconds later and produce a list that does not contain `saved`. Three things could happen to that running fetch, and choosing between them determines everything else in this design.

## Settled semantics

### A write cancels the run in progress

Three candidate behaviours were considered for the scenario above.

The first is to **throw the running fetch away**. `todos()` becomes `[a, b, saved]` immediately, and when the fetch settles 1.8 seconds later nothing happens — its result is dropped. The write behaves exactly like a dependency change: it kills the run in progress.

The second is to **let the fetch finish and win**. `todos()` becomes `[a, b, saved]` immediately, then reverts to `[a, b]` when the fetch lands, on the grounds that the server is newer truth. The row the user just added visibly disappears.

The third is to **let the fetch finish and then apply the write on top of it**. `todos()` stays `[a, b]` until the fetch lands, at which point the update function runs against the fetched list and produces `[a, b, saved]`. Nothing is lost, but the add does not appear for 1.8 seconds.

**Decision: the first.** A write cancels the run in progress, exactly the way a dependency change does.

"In progress" covers three states, and all three are cancelled:

- **executing or waiting on a promise** — the stage is suspended on a promise it will never publish
- **paused** — a generator stage is holding a partial computation
- **queued** — a dependency changed but the flush has not happened yet, so the body has not re-run

The third case is easy to miss and produces the behaviour we rejected. `setVersion` does not run the body; it marks it dirty and schedules a flush. So a write in the same synchronous block finds no promise and no generator to cancel, the flush then runs the body, and two seconds later it publishes over the write.

Handling the queued case is also what makes the two possible orderings come out right, without a rule about either:

```ts
// invalidate, then write — "the list changed, and here is what it is"
setVersion(v => v + 1)
setTodos([buy, call, walk])
// at the moment of the write a run is queued, so it is cancelled. No fetch happens.

// write, then invalidate — "show this now, then go and refresh"
setTodos(prev => [...prev, saved])
setVersion(v => v + 1)
// at the moment of the write nothing is queued. The later change queues a run,
// which happens normally and wins.
```

The question is asked at the moment of the write, so program order decides.

Cancelling a queued run needs a change to r3, which pulse consumes as a pinned fork (`github:bigmistqke/r3` in `package.json`). `stabilize` recomputes every node in the heap without consulting its flags, and `recompute` has no early exit, so clearing `Dirty` and `Check` from outside achieves nothing; the node has to leave the heap, and `deleteFromHeap` is internal. The addition:

```ts
export function cancelRecompute(el: Computed<unknown>): boolean {
  // A node in the middle of its own run is not ours to cancel — clearing flags
  // here would wipe RecomputingDeps and corrupt the dependency rebuild.
  if (el.flags & ReactiveFlags.RecomputingDeps) return false

  const pending =
    (el.flags & (ReactiveFlags.Dirty | ReactiveFlags.Check | ReactiveFlags.InHeap)) !== 0

  deleteFromHeap(el)
  el.flags = ReactiveFlags.None
  return pending
}
```

`deleteFromHeap` already exists and is exercised by the recompute path, so this needs a caller and an export rather than new logic. [ADR 0005](../../adr/0005-r3-exports-unwatched.md) is the precedent for pulse asking the fork for an export.

Solid has the same feature and reaches for the same lever. `createSignal(fn)` is its memo form, and its setter is `setMemo`, which writes the value and then calls `suppressComputedRecompute` — which removes the node from the dirty queue and clears its dirty and check flags, described in its own comment as being for "when a manual write should win over dependency changes queued in the same tick" (`packages/solid-signals/src/core/core.ts:983` and `:998`). Two details of theirs are worth carrying over and one is not:

- The write does not touch the node's dependency list. A written memo keeps the callback's dependencies and re-runs when one of them next changes. Same here.
- Their suppression is scoped to the tick — a manual-write flag is cleared when the scheduler drains — so it defends against changes queued in the same tick and nothing further. Same scope here, but reached differently: removing from the heap and clearing the flags leaves nothing set, so it is already one-shot and needs no flag of its own. Solid carries that flag for its pending-value and projection machinery, which r3 does not have.
- Solid's memo is a single node, so `setMemo` has no upstream to consider. It offers no guidance on what a write should do to earlier stages of a chain; that question is settled below by treating the stage chain as computeds for dependency purposes and as one unit for lifecycle purposes.

An alternative that needs no r3 change was considered and rejected: snapshot the body's dependencies at write time, and on the next run replay them and return early if none changed. It works, and both helpers already exist for generator resumption, but a suppressed run rebuilds the node's dependency list from the recorded set alone — so it adds a second caller to a replay path that already has a recorded problem with re-linking dependencies a fresh generator no longer reads (see the entry in [`docs/follow-ups.md`](../../follow-ups.md)). Leaving the dependency graph untouched is worth an export.

Three things to verify when implementing the r3 side: how removal interacts with `markHeap`'s marking latch; that nothing depends on `maxDirty` staying tight, since `deleteFromHeap` does not lower it; and whether a setter called from inside the derivation's own body — which the `RecomputingDeps` guard turns into a no-op — deserves a warning.

The third behaviour remains available in user space once stages can read their own previous value, by reconciling the incoming server list against it. See [Deferred](#deferred).

### A write inside an action stays invisible until the action commits

A write made inside an `action` lands in that action's speculative scope and is not visible outside it until the action commits. It rolls back if the action is discarded.

This is not changed by the writable derived signal. Deliberately leaking a provisional value out of an action before it commits is what `optimistic` exists for, and it stays the opt-in mechanism for that. The alternative — making every write inside an action immediately visible outside it — would give optimistic user interface behaviour by default and leave `optimistic` with nothing to do, at the cost of removing the isolation that makes an action's rollback meaningful.

### The update function receives the last resolved value, not the published read

Resolution follows one rule, which the pipeline already applies to stage inputs but had never been stated:

```
inside a stage, and on the write side   →  Resolved<T>, no colour
on the read side                        →  T | Promise<T>, colour visible
```

Stage N's parameter is already `Resolved<stage N-1>` ([`src/computed.ts:20-42`](../../../src/computed.ts)), because pulse drives the resumption and hands the stage a settled value. The same applies to what an update function is handed.

```ts
type DerivedSetter<T> = (
  next: T | Awaited<T> | ((prev: Awaited<T> | undefined) => T | Awaited<T>)
) => void
```

`prev` is the stage's `lastResolvedValue` — "the last value this stage actually resolved to", which is already tracked and is only ever a real resolved value ([`src/computed.ts:145`](../../../src/computed.ts)) — with the `UNRESOLVED` sentinel mapped to `undefined` so it never escapes. Never a promise, never the sentinel.

```ts
setTodos(prev => [...(prev ?? []), saved])
```

This needs no scheduling control, because nothing is being resolved: the setter hands back the last thing that already resolved. During a refetch that is the stale value, which is the same thing `latest` gives, so the two agree by construction.

Since the setter belongs to the pipeline's output, `prev` is specifically the **tail's** last resolved value. That makes it the same value as the tail stage's own `previous` parameter, once that lands — the derivation and a write are two ways of producing the tail's next value, and both receive the tail's current value under the same type:

```ts
signal(
  () => version(),
  function* (v) { return yield* read(api.list(v)) },
  (server, { previous }) => reconcile(previous, server),   // the derivation produces it
)

setTodos(prev => [...(prev ?? []), saved])                 // a write produces it
```

A write updates `lastResolvedValue`, so a write feeds forward into the next derivation run's `previous`.

**A derivation is eager, not lazy.** `computed` in the pinned reactive core recomputes at creation when there is no ambient reactive context ([`../r3/src/index.ts:114-126`](../../../../r3/src/index.ts)), so a stage body runs the moment the signal is declared, before anything reads it. An earlier draft of this document assumed the opposite and reasoned from it; the assumption was wrong and the reasoning that depended on it is corrected here.

Under eagerness the definition above needs no adjustment, because it is about resolution rather than execution:

- A synchronous derivation runs at creation and resolves, so `prev` is its value from the first write onward.
- An asynchronous derivation runs at creation and suspends, so nothing has resolved yet and `prev` is `undefined` until its first result lands.

So `undefined` means "nothing has resolved", not "nothing has run", and it needs no tracking of its own — the sentinel already says exactly that. One ambiguity remains: a stage that legitimately resolves to `undefined` is indistinguishable from one that has not resolved yet.

**What this replaces.** An earlier decision made `prev` the raw published read, `T | Promise<T> | undefined`, on the grounds that a promise write could then be chained onto an in-flight one. Walking the scenarios showed the cost: for any async derivation `prev` was always a promise, so every update needed `use(prev)` or a `.then` chain — and on a first load with nothing cached, `use(prev)` throws `NotReadyYet` out of a setter that has no boundary to catch it. Handing back the last resolved value removes that case rather than mitigating it.

**What it costs.** Chaining onto an in-flight promise from inside the update function is no longer expressible. It remains reachable through the accessor:

```ts
setTodos(untrack(todos).then(list => [...list, saved]))
```

which still works, because a write cancels pulse's *publishing* of that fetch, not the promise object already captured.

**What is unchanged.** The setter still accepts `T | Promise<T>` — writing a promise is how you say "the value is whatever this resolves to", and `isPending` and `use` follow it. And the read type is untouched, so `use`, `latest`, `isPending` and `<Loading>` behave exactly as before. The asymmetry is deliberate: what you are handed is what is known, what you hand back is whatever you have.

### Cancellation waits until the written value reaches the committed world

The written value is scope-aware: inside an action it lands in that action's slot and is dropped if the action is discarded. Cancelling the run is not — the retained generator and the suspended-on promise are plain per-stage variables, and discarding a generator runs its `finally` blocks and its cleanups, which cannot be undone.

If a write cancelled the run at the moment it was made, a discarded action would leave the node holding its pre-write value, not pending, with no run in progress and nothing scheduled to start one. A refresh the user began before the action would have silently disappeared because an unrelated action failed.

**Decision: a write made inside an action registers its cancellation and performs it only if the action commits.**

```ts
const setter = (next) => {
  const value = typeof next === 'function' ? next(tail.readPrev()) : next

  if (getCurrentScope() === ROOT_SCOPE) {
    cancelAllStages()                        // an ordinary write: cancel now
  } else {
    onSettle(outcome => {                    // a write inside an action:
      if (outcome === 'committed') {         // cancel only if it commits
        cancelAllStages()
      }
    })
  }

  tail.publishWrite(value)
}
```

The reasoning is that the committed world and an action's speculative scope are separate, and a speculative write does not reach across to kill work the committed world is waiting on. The derivation keeps running, lands when it lands, and publishes. The write becomes a fact about the committed world only when the action commits — which is also the first moment there is anything for cancellation to protect.

Ordering inside `commit` is already correct for this. Promotions are applied, then close callbacks fire, then the flush ([`src/scope.ts:321-341`](../../../src/scope.ts)), so cancellation runs after the value has landed and the abandoned promise has no window to publish in.

Two consequences follow, both accepted:

- **A value can appear and then be replaced.** If the derivation lands while the action is still open, everyone outside the action sees that result, and the write overwrites it at commit.
- **The promoted value was computed against a stale base.** An update function reads the previous value at write time. If the derivation lands afterwards, the value promoted at commit was built on data that is now out of date. This is the same rule as a write cancelling a run, applied at commit time.

Inside the action, the value reads as the written one while `isPending` still reports true, because the pending flag describes the committed world's run, which genuinely is still going. Under this separation that is an accurate report of two different things rather than an inconsistency.

One piece of machinery is missing. With nested actions, an inner scope committing only promotes the value to its parent, not to the committed world, so the callback has to re-register on the parent and cancel only when the value actually reaches the root. `onSettle` always uses the ambient scope and throws at the root ([`src/scope.ts:367-373`](../../../src/scope.ts)), so this needs an internal variant that takes the scope explicitly.

```ts
const cancelWhenValueReachesRoot = (scope) => {
  if (scope === ROOT_SCOPE) {
    cancelAllStages()
    return
  }
  onSettleOn(scope, outcome => {
    if (outcome === 'committed') {
      cancelWhenValueReachesRoot(scope.parent ?? ROOT_SCOPE)
    }
  })
}
```

### A write clears a parked failure

When a stage's promise rejects, the reason is parked in a failure signal and the last resolved value stays published, so a tolerant read can still degrade to it ([`src/computed.ts:248`](../../../src/computed.ts), [`src/computed.ts:522-526`](../../../src/computed.ts)). A write clears that parked failure: the node is no longer failed, `failure(todos)` is empty again, and a `Failed` boundary stops showing its fallback.

The alternative considered was that the failure stays parked until `reset()` on the boundary or a dependency change, on the grounds that failures are cleared by reset rather than by writes. It was rejected because a write wins over the derivation, and a node holding a written value while still reporting itself as failed is not a coherent state.

## Public API

### The stage overload

`signal` gains a stage-function overload alongside its existing value form, accepting the same variadic stage list `computed` accepts:

```ts
signal<T>(initial: T): [Accessor<T>, Setter<T>]                    // unchanged
signal<A>(s0: () => A): [Accessor<PipelineRead<[], A>>, DerivedSetter<...>]
signal<A, B>(s0: () => A, s1: Stage<Resolved<A>, B>): ...          // through five stages
```

Dispatch is on whether the first argument is a function.

The type machinery is the inference `computed` already performs — `Resolved`, `Surface`, `PipelineRead` in [`src/async.ts:151-195`](../../../src/async.ts) — reused rather than reimplemented. The setter's accepted type is derived from the last stage's return type, which is what makes it the same signal.

A bare value is accepted where the read type is a promise. A stage that returns or yields a promise, or that sits downstream of one, reads as `Promise<T>`; writing a bare `T` into such a stage must be wrapped in a resolved promise, or the read type flips from `Promise<T>` to `T` on write. The publish path already applies this rule under the name `asPromise` ([`src/computed.ts:541`](../../../src/computed.ts)), and the setter uses the same coarse test rather than asking whether a particular run actually suspended.

### Consequences

**The value form can no longer hold a bare function.** `signal(() => x)` now means a derivation. This is the same trade `computed` already makes and the same one Solid makes.

**A write overrides the pipeline's output.** In a multi-stage pipeline the setter writes the last stage. It does not reach any intermediate stage and nothing propagates backwards. A pipeline whose tail filters or maps means the write applies to the filtered or mapped value, not to the source. The write is erased by the next run of the tail, which any upstream stage re-running will cause.

## Implementation approach

Two approaches were considered.

**Write into the pipeline's own value.** `computed` already keeps each stage's value in a plain signal, `publishedValue` ([`src/computed.ts:252-254`](../../../src/computed.ts)). The setter writes to that same place, and on the way discards the paused generator, clears pending, and clears the failure.

**Put an override signal on top.** Leave `computed` untouched. Build the pipeline, keep a separate override signal beside it, and return an accessor that reads the override when it is set.

```ts
const inner = computed(fn)
const [override, setOverride] = signal(NONE)
const todos = () => override() === NONE ? inner() : override()
```

**Decision: write into the pipeline's own value.**

The override approach breaks the query verbs. `isPending`, `promiseOf` and `failure` look their target up in a registry keyed on the exact accessor ([`src/pending.ts:41`](../../../src/pending.ts)). The wrapper `todos` above is a new closure that nothing registered, so `isPending(todos)` would fall back to guessing from the value and lose the upstream walk, and a `Failed` boundary would not see the node at all. Re-registering the wrapper with every registry is more work than writing into the published value, and it leaves two nodes to keep in step instead of one.

Writing into the published value also makes speculation nearly free. The write is an ordinary signal write, so it goes through `writeValue` ([`src/scope.ts:256-264`](../../../src/scope.ts)), lands in the enclosing action's slot, and rolls back on discard with no new machinery. (This is only nearly free; see [Open questions](#open-questions).)

## Where the setter is built

**Where the write lands is forced.** `computed` returns the last stage's accessor ([`src/computed.ts:94`](../../../src/computed.ts)), so that is what the consumer reads, so that is where a write has to be visible.

**Where the setter is constructed is not forced, and it must not be a stage.** A setter built inside `makeStageNode` sees one stage's closure, so it can only cancel that stage's run. When the fetch is in an upstream stage, such a setter cancels nothing: the fetch completes, publishes, and the resulting dependency change makes the tail recompute and lose the write — the "let the fetch finish and win" behaviour that was rejected above, arrived at by accident.

The pipeline builder already constructs every stage in a loop ([`src/computed.ts:74-82`](../../../src/computed.ts)), so it has all of them in scope. The setter is built there:

```ts
export function signalFromStages(...stages) {
  const built = []
  let inputAccessor = null
  for (const stage of stages) {
    const node = makeStageNode(stage, inputAccessor)
    built.push(node)
    inputAccessor = node.accessor
  }

  const tail = built[built.length - 1]

  const setter = (next) => {
    const value = typeof next === 'function' ? next(tail.readPrev()) : next
    for (let i = built.length - 1; i >= 0; i--) built[i].cancelRun()
    tail.publishWrite(value)
  }

  return [tail.accessor, setter]
}
```

`makeStageNode` returns `cancelRun`, `publishWrite` and `readPrev` alongside what it returns today. `computed` calls the same builder and drops the setter.

No registry and no upstream link walk is needed. An earlier proposal registered a cancel entry per stage and walked an `upstream` chain the way `isPending` does; that was recovering reach the construction site had thrown away.

### Why every stage is cancelled

A stage chain is one derivation with internal joints, not several derivations wired together. The joints are what it provides over hand-chained memos:

- **One disposal unit.** Every stage is torn down together ([`src/computed.ts:89-93`](../../../src/computed.ts)), including reaching into a paused generator so it releases what it held across its pause.
- **One pending answer.** `isPending` on the pipeline is true when any stage is in flight, not only the last ([`src/pending.ts:43-48`](../../../src/pending.ts)). `failure` is wired the same way.
- **One type chain.** Stage N's parameter is the resolved type of stage N-1, and the read colour is derived from the whole chain.
- **Automatic promise colour propagation.** A pending upstream stage makes the downstream stage's value that same promise without entering its body ([`src/computed.ts:356-367`](../../../src/computed.ts)).
- **Per-stage suspension and resumption** — generator retention, dependency replay, stale-while-revalidate — which makes a stage a resumable segment rather than a memo that restarts.

So the run a write cancels is the pipeline's run, spread across nodes. Cancelling only the node the write landed on would be cancelling part of a run.

Cancelling every stage unconditionally is safe on two counts. Cancelling an idle stage is a no-op, so no test for whether a given stage is running is needed. And the intermediates are private — `computed` returns only the last accessor and pulse does not expose intermediate stages ([`src/computed.ts:86-88`](../../../src/computed.ts)) — so no other consumer is reading an upstream stage and abandoning its fetch cannot affect anyone else. If intermediate stages were ever exposed, this reasoning has to be revisited: a write to one pipeline's tail would then be cancelling work another reader is waiting on.

Cancellation order does not matter, because cancelling publishes nothing. Tail to head is used above because it reads as "cancel me, then everything I derive from".

## What the setter does

```ts
const setter = (next) => {
  const value = typeof next === 'function' ? next(tail.readPrev()) : next
  for (let i = built.length - 1; i >= 0; i--) built[i].cancelRun()
  tail.publishWrite(value)
}
```

The update function is resolved **before** anything is cancelled, so an update function that throws leaves the run in progress untouched.

`readPrev` is an untracked read of the tail's published value, with the `UNRESOLVED` sentinel mapped to `undefined`. It is untracked so that a setter called from inside an effect body does not add a dependency.

### What `cancelRun` does to one stage

Four things, all local to that stage:

- **Discard its retained generator.** This runs the generator's `finally` blocks and its registered cleanups, by way of the existing `discardGen` ([`src/computed.ts:219-236`](../../../src/computed.ts)). A stage that wires an `AbortController` through `onCleanup` therefore aborts its request on a write, the same as on a dependency change.
- **Clear the promise it is suspended on.** The settle handler checks whether the promise it fired for is still the one the stage is suspended on ([`src/computed.ts:329`](../../../src/computed.ts)); clearing the field makes that check fail, so the abandoned promise publishes nothing when it settles.
- **Set its pending flag to false.**
- **Take it out of the recompute heap**, so a run that was queued but had not started does not run either.

It does **not** write to that stage. An upstream stage's published value stays exactly where it was.

### The state a cancelled stage is left in

This is the part scenario W10 corrected. Cancelling must leave each stage in the state its inputs imply, and only the tail gets an exemption, because a write supplied its value.

```
the tail                  clean      out of the heap, flags cleared.
                                     The write is its value, so there is
                                     nothing to recompute.

an upstream stage that    dirty      out of the heap, flags set to Dirty.
had a run in progress                It recomputes when something next
                                     reads it.

an upstream stage that    untouched  no run to cancel, and no reason to
was idle                             invalidate it.
```

Leaving an upstream stage clean produces a pipeline that is permanently wrong. Suppose the fetch is in a middle stage and the tail also reads a signal the middle stage knows nothing about — a display filter, say. A dependency change starts the fetch, a write lands and cancels it, and the middle stage is left clean while holding data for an input that has since moved. When the filter changes later, only the tail recomputes; it reads the middle stage, finds it clean, and serves the old data. The write is gone, the refresh is gone, and nothing is scheduled to reconcile the two — the first stage says one version, the middle stage holds another, forever.

Marking the cancelled upstream stage dirty fixes it without any eager work. "Dirty but not in the heap" is a real state: `stabilize` only walks the heap, so nothing recomputes at the next flush, but `read` checks the flags of any computed dependency and calls `updateIfNecessary`, which recomputes a dirty one ([`../r3/src/index.ts:333-352`](../../../../r3/src/index.ts) and `:202-220`). So the stage stays dormant until the tail actually needs it, and then it refetches while the tail holds the written value under stale-while-revalidate.

This means the r3 addition needs two behaviours rather than one — clear the flags, or leave the node dirty — either as a parameter or as two exported functions.

The alternative of not cancelling upstream stages at all is coherent too: the middle stage keeps fetching and publishes when it lands, and the tail recomputes from real data. But that is the "let the fetch finish and win" behaviour rejected in the settled semantics, reached by moving the fetch one stage up — and which stage holds a fetch is a detail of how someone chose to split their pipeline, not something the semantics should turn on.

### What `publishWrite` must update

Writing the value alone is not enough. The tail keeps private state that the change-gate depends on, and leaving it stale produces a node that is stuck.

- **`lastResolvedValue`** ([`src/computed.ts:145`](../../../src/computed.ts)) becomes the written value when the write is a bare value. The settle path publishes only when the newly resolved value differs from this field ([`src/computed.ts:500-508`](../../../src/computed.ts)). Consider a stage resolving to the number `5`, then a write of `7`, then a re-run that resolves to `5` again: without updating the field, the gate compares 5 against a stale 5, suppresses the publish, and the node holds `7` forever.
- **`lastPublishedShapeIsPromise`** ([`src/computed.ts:150`](../../../src/computed.ts)) records whether the write was published bare or wrapped, for the same reason applied to the shape half of the gate.
- **The failure signal** is cleared on every stage, not only the tail — see the failure section below.
- **The pending flag** is cleared by `cancelRun`, and a write of a promise sets it again. The registry entry reads the stage's pending signal first and only falls back to inspecting the value ([`src/pending.ts:39-56`](../../../src/pending.ts)), so the flag has to be correct rather than relying on the fallback.

The write itself goes through the existing scope-aware setter from `signalWithNode` ([`src/signal.ts:73-91`](../../../src/signal.ts)), which also seeds the stale-while-revalidate prior when a promise is written.

### Writing a promise

A written promise does not resolve anything until it settles, so **`lastResolvedValue` keeps the pre-write value for the duration**. That is what the field means — "the last value this stage actually resolved to" — and it is what the body already does when it suspends: the stale-while-revalidate branch leaves the prior value in place ([`src/computed.ts:321-327`](../../../src/computed.ts)). The field has to mean one thing regardless of which producer set it, or `latest` and the update function's `prev` start disagreeing about what the last known value was. Clearing it would make `latest` return nothing while a write is in flight, which is worse than returning the last known value.

When the written promise settles to a value the field already holds, the change gate suppresses the publish, which is correct — the node already holds a resolved promise carrying that value. **The pending flag must clear independently of the gate**, or `isPending` sticks on true.

A written promise **is published immediately**, unlike the body's own suspension. The body holds its prior value published to avoid churning downstream on a refetch; a written promise is the value the caller asked for, so the accessor returns it, `latest` gives the prior, and `use` suspends on it. This is what the plain signal setter already does ([`src/signal.ts:84-88`](../../../src/signal.ts)).

But a written promise **does occupy `suspendedOn`**, which is what makes the next rule free.

### A new production cancels the previous one, whoever started it

A write cancels a running derivation. The converse also holds: **a dependency change supersedes a written promise that has not settled.**

This is not a second rule. A later dependency change already beats an earlier write — that is the settled behaviour and nothing about the write being pending changes which one is earlier. The alternatives do not survive contact: letting both stand means whichever settles last wins, nondeterministically; letting a pending write block a subsequent dependency change contradicts the settled rule directly.

So the single rule is: **starting a new production of the tail's value cancels the previous one, whoever started it.** A write cancels a running derivation; a dependency change cancels a pending write.

The mechanism costs nothing, because a written promise is stored in the same `suspendedOn` field the body uses. The body's next `suspendOn` replaces it, and the settle handler's existing supersession check ([`src/computed.ts:329`](../../../src/computed.ts)) then discards it.

## Speculation

A write inside an action divides cleanly by one question: is this piece of state scope-aware?

**The value needs nothing new.** `writeValue` installs a slot on the tail's published node in the action's scope ([`src/scope.ts:256-272`](../../../src/scope.ts)). Reads inside the action find the slot, which also shadows `defaultRecipe` so the stage is not evaluated speculatively. Commit promotes it, discard drops it.

**The failure signals and pending signals are already scope-aware**, because they are ordinary pulse signals. Clearing a failure inside an action installs a slot and promotes or reverts with everything else. No special handling — only the correction that the clear applies to every stage.

**The retained generator, the suspended-on promise, `lastResolvedValue` and `lastPublishedShapeIsPromise` are plain closure variables, so every consequence that touches them is deferred to commit.** Updating them speculatively is not merely untidy, it is wrong: write `7` over `5` inside an action and discard it, and the published value reverts to `5` while the field says `7`; the derivation later resolving to `7` is then suppressed by the change gate and the node holds `5` indefinitely.

That gives one rule covering cancellation and bookkeeping together: **a speculative write installs the value in its slot, and every consequence that is not scope-aware waits until the value reaches the committed world.** Cancellation was not a special case; it was the first instance of this.

**The one thing that cannot wait is `prev`**, because a second update inside the same action has to see the first. So `prev` is the last resolved value *as seen from the current scope*: read the tail's published value scope-aware, unwrap it if it is a settled promise, fall back to the committed last resolved value if it is pending, and `undefined` for the sentinel. That chains correctly inside an action and behaves identically outside one.

This needs one internal helper: a scope-aware read that does **not** run `defaultRecipe` on a miss. The ordinary read would evaluate the stage inside the speculation, and asynchronous stages cannot resolve there — the suspend and settle machinery is driven by r3 and does not run inside a speculation ([`src/computed.ts:262-278`](../../../src/computed.ts)). Checking for a slot and otherwise falling through to the committed value avoids the problem entirely rather than working around it.

That limitation is unchanged by this design and still bounds it: a derivation read for the first time inside an action cannot resolve there.

## Registry integration

The setter does not use the registries. It is built by the pipeline builder, which holds every stage directly, so cancelling and clearing failures across stages is a loop over handles it already has.

The registries are needed for exactly one thing: the public `cancel(x)` described below, where the caller holds an accessor and nothing else. `registerPending`'s entry gains a `cancel` field alongside `pending` and `promise`, and `cancel(x)` walks the `upstream` chain the same way `isPending` does ([`src/pending.ts:43-48`](../../../src/pending.ts)).

That is one implementation of per-stage cancellation with two entry points. Routing the setter through the registry instead would be worse, not tidier: the setter also clears failures, which is not in the pending registry, so it would need a second walk over a second chain to do what one loop over handles already does.

## The three defects found by walking the scenarios

**A write clears only the tail's failure (W5).** The failure query walks upstream through the registry the same way the pending query does ([`src/computed.ts:684-686`](../../../src/computed.ts)), so a middle stage's parked failure still reports after a write, and a `<Failed>` boundary keeps rendering its fallback over a signal that now holds a good value. The write clears the failure on every stage, the same loop that cancels every stage.

**A write from inside the derivation's own body throws (W22).** Cancelling calls the retained generator's `return` method, and calling that on a generator which is currently executing raises `TypeError: Generator is already running`. `cancelRun` skips a stage whose generator is the one currently executing, mirroring the guard the r3 addition needs for a node that is mid-run. The write itself still applies; it is the cancellation of one's own run that is meaningless, since that run is about to finish and publish anyway — and its publish then loses to the write under the change gate, because the write already updated the last resolved value.

**Cleanups run inside the setter (W13).** Discarding a paused generator runs its `finally` blocks and registered cleanups synchronously, and a cleanup that writes a signal therefore executes in the middle of another write. **Cleanups run after the value is published**, so a cleanup observing the signal it was triggered by sees the written value rather than the one it replaced. That is the ordering a developer would assume from the outside — the write happened, then the teardown it caused — and it keeps the re-entrancy shape of scenario category K to a single well-defined point.

A fourth finding was not a defect: a write to a signal nothing has read yet was expected to be erased by the first read. It is not, for two reasons that only became clear during implementation. The derivation has already run by then — it runs at creation, not at first read — and stale-while-revalidate keeps the written value published while its request is in flight. So seeding from a cache works (W3).

## Test plan

The scenarios are the plan. `docs/pulse/scenarios.md` states that each scenario is intended to become a test case, so W1 through W22 become one test each in `test/writable-derived.test.ts`.

Three are regression tests rather than specifications — W5, W13 and W22 — and are written first, failing, because they are the cases most likely to be quietly reintroduced.

Two need coverage the scenario text does not imply:

- **A read of the pipeline from inside an effect while an upstream stage is cancelled and awaiting recomputation.** The push path hides the pull path, and the reasoning that a stage left needing recomputation behaves correctly depends on r3 internals that should not be relied on untested.
- **A discarded action whose write updated the change-gate state.** This is the failure mode the speculation section above rules out by deferring, and the test is what keeps it ruled out.

The r3 fork needs its own tests: withdrawing a queued recomputation, withdrawing one while leaving the node needing recomputation, withdrawing a node that is not queued, and refusing to withdraw a node that is mid-run.

## Designed here, shipped separately: `cancel(x)`

A public verb that abandons the run in progress on a derivation.

```ts
cancel(todos)
```

It performs the same three things per stage that a write performs before publishing — discard the retained generator, running its `finally` blocks and cleanups so a wired abort controller fires; clear the promise the stage is suspended on so its settle handler finds itself superseded; clear the pending flag. The node keeps its current published value and re-runs on its next dependency change.

So the two neighbouring verbs are:

```
reset(x)     stop the run, clear the failure, run again
cancel(x)    stop the run
```

`reset` already exists on the failure registry entry ([`src/computed.ts:677-683`](../../../src/computed.ts)) and differs only by bumping the kick that forces a fresh run.

**Why it is separate from the write.** A write says what the value is now. Cancelling says to stop the work in progress. Those are usually wanted together, which is why the setter bundles them, but not always — and only an explicit verb can express the case where they come apart.

The case that motivated it: under the commit-deferred cancellation above, a derivation that lands while an action is open publishes its result and is then overwritten when the action commits, so a value appears and is replaced. A caller who does not want that calls `cancel` inside the action and accepts the consequence — if the action is discarded, the run is gone and only a dependency change will start another. That is a decision the caller made rather than a surprise, which is what distinguishes it from cancelling implicitly on every speculative write.

**It stands alone.** `cancel(searchResults)` when the search box is cleared, `cancel(feed)` when navigating away. It applies to any derivation, not only a writable one, which is why it ships on its own.

**Where it lives.** It needs a registry lookup, because the caller holds an accessor rather than the pipeline that built it. The pending registry is the natural home: its entry already describes in-flight state and already carries the `upstream` link that `isPending` walks ([`src/pending.ts:43-48`](../../../src/pending.ts)), so walking that chain cancels every stage with no new wiring. Given that walk exists, the setter should call the same internal function rather than keep a second path to the same operation through the builder's stage list.

**Not rolled back by a discard.** `cancel` called inside an action takes effect immediately and stays in effect if the action is discarded. It belongs with the side effects an action cannot undo, in the same way a request already sent cannot be unsent.

**One documented hazard.** `cancel(todos)` affects every consumer of `todos`, since it is one shared node. Within a pipeline this is safe because intermediate stages are private, but across components it is not something the caller can scope. This is already true of `reset` and needs documenting rather than solving.

## Deferred

**A stage parameter object carrying an abort signal and the stage's previous value.** The intended shape is `({ signal, previous }) => …` for stage 0 and `(value, { signal, previous }) => …` for later stages, chosen so that further members can be added without another signature change. This was decided in an earlier session and never written down; it is recorded here so it is not lost again, and it is explicitly out of scope for the writable derived signal work.

Two facts about its current state:

- The blocker is gone. Giving stages an abort signal was previously blocked because a request that must be cancelled is created inside the stage body by definition, and under restart-from-top resumption a generator that built its promise inside its own body never converged ([ADR 0013](../../adr/0013-generator-stages-resume-with-dependency-replay.md), and the resolved entry in [`docs/follow-ups.md`](../../follow-ups.md)). ADR 0013 replaced restart with resume, so that no longer holds.
- The teardown hook already exists. Discarding a generator calls its `return` method, which runs its `finally` blocks, and drains its registered cleanups ([`src/computed.ts:191-216`](../../../src/computed.ts)). So `onCleanup(() => controller.abort())` inside a generator stage works today; a parameter would only make it the default rather than something each stage wires by hand.

`previous` hands a stage its own `lastResolvedValue`. Per stage, not per pipeline — each stage already keeps that field, so no new bookkeeping is required, and it is a resolved value rather than a promise, per the resolution rule in the settled semantics above.

Two things about it are settled by the setter's `prev`, which is the same value for the tail:

- **It is the tail's `previous` that a write lands on.** The derivation and a write are two ways of producing the tail's next value, and both receive the tail's current value under the same name and type. An intermediate stage's previous value is never affected by a write, since a write reaches only the tail.
- **A write feeds forward.** A write updates `lastResolvedValue`, so the next derivation run sees it as `previous`. This is what makes reconciling a refetch against local state possible — the user-space route to the "let the fetch finish and then apply the write on top" behaviour that was rejected as a default.

And while a written promise is in flight it holds the pre-write value, per the promise-write section above — the same answer for the same reason, since it is the same field.

What is left for that work is the parameter object itself: the abort signal, the shape of the object, and whether stage 0's parameter and later stages' second parameter should be the same type.

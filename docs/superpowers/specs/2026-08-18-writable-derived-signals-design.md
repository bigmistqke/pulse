# Writable derived signals — `signal(fn)`

A derivation that also has a setter. `signal` accepts the same stage list `computed` accepts and returns an accessor and a setter, so a value can be produced by a derivation and also written directly.

This document records the conclusions reached in a design discussion on 2026-08-18. The semantics are settled and the construction approach is settled. Several mechanical questions are still open and are listed at the end. Nothing has been implemented.

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

The third behaviour remains available in user space once stages can read their own previous value, by reconciling the incoming server list against it. See [Deferred](#deferred).

### A write inside an action stays invisible until the action commits

A write made inside an `action` lands in that action's speculative scope and is not visible outside it until the action commits. It rolls back if the action is discarded.

This is not changed by the writable derived signal. Deliberately leaking a provisional value out of an action before it commits is what `optimistic` exists for, and it stays the opt-in mechanism for that. The alternative — making every write inside an action immediately visible outside it — would give optimistic user interface behaviour by default and leave `optimistic` with nothing to do, at the cost of removing the isolation that makes an action's rollback meaningful.

### The update function receives the raw published read

When the setter is called with a function rather than a value, that function receives the same thing the accessor returns, with no unwrapping:

```ts
type DerivedSetter<T> = (
  next: T | Awaited<T> | ((prev: T | undefined) => T | Awaited<T>)
) => void
```

So `prev` is `T | Promise<T> | undefined`. It is a promise whenever the accessor would return a promise. It is `undefined` when the derivation has not produced anything yet — the stage's published value is still the internal `UNRESOLVED` sentinel ([`src/computed.ts:137`](../../../src/computed.ts)), which is mapped to `undefined` at the setter boundary so the sentinel never escapes.

This is the same convention as the previous value a memo body receives: the last value, `undefined` on the first run, and the caller writes the guard.

```ts
setTodos(prev => [...(prev ?? []), saved])
```

Reading the published value does **not** trigger the derivation's first evaluation. A stage body is lazy, so on a signal nothing has read yet the setter finds no value and hands the update function `undefined` rather than running the body to produce one. One consequence: a stage that legitimately resolves to `undefined` is indistinguishable from a stage that has never run.

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

Three things, all local to that stage:

- **Discard its retained generator.** This runs the generator's `finally` blocks and its registered cleanups, by way of the existing `discardGen` ([`src/computed.ts:219-236`](../../../src/computed.ts)). A stage that wires an `AbortController` through `onCleanup` therefore aborts its request on a write, the same as on a dependency change.
- **Clear the promise it is suspended on.** The settle handler checks whether the promise it fired for is still the one the stage is suspended on ([`src/computed.ts:329`](../../../src/computed.ts)); clearing the field makes that check fail, so the abandoned promise publishes nothing when it settles.
- **Set its pending flag to false.**

It does **not** write to that stage. An upstream stage's published value stays where it was, and it re-runs on its next dependency change, the same as the tail.

### What `publishWrite` must update

Writing the value alone is not enough. The tail keeps private state that the change-gate depends on, and leaving it stale produces a node that is stuck.

- **`lastResolvedValue`** ([`src/computed.ts:145`](../../../src/computed.ts)) must become the written value. The settle path publishes only when the newly resolved value differs from this field ([`src/computed.ts:500-508`](../../../src/computed.ts)). Consider a stage resolving to the number `5`, then a write of `7`, then a re-run that resolves to `5` again: without updating the field, the gate compares 5 against a stale 5, suppresses the publish, and the node holds `7` forever.
- **`lastPublishedShapeIsPromise`** ([`src/computed.ts:150`](../../../src/computed.ts)) must record whether the write was published bare or wrapped, for the same reason applied to the shape half of the gate.
- **The failure signal** is cleared, per the settled semantics above.
- **The pending flag** is cleared by `cancelRun`, but a write of a promise has to set it again, or `isPending` reports false while the written promise is in flight. The registry entry reads the stage's pending signal first and only falls back to inspecting the value ([`src/pending.ts:39-56`](../../../src/pending.ts)), so the flag has to be correct rather than relying on the fallback.

The write itself goes through the existing scope-aware setter from `signalWithNode` ([`src/signal.ts:73-91`](../../../src/signal.ts)), which also seeds the stale-while-revalidate prior when a promise is written.

## Open questions

These were identified but not resolved.

**The same-tick race.** If `setVersion` and `setTodos` land in the same tick, the body has not re-run yet when the write arrives — there is no run in progress to cancel, only a queued recompute. The flush then runs the body, refetches, and eventually publishes over the write. Suppressing a queued recompute needs a dependency snapshot taken at write time (`snapshotDeps` in [`src/dep-replay.ts:32`](../../../src/dep-replay.ts)) and a replay on the next body run that lets the run proceed only if a dependency genuinely differs from what it was at the moment of the write. Solid handles the equivalent case by suppressing the queued recompute directly.

**What the stage's previous value is while a written promise is in flight.** Either the last settled value, matching how a stage's own pending promise behaves under stale-while-revalidate, or nothing at all for the duration. The first keeps one meaning everywhere: the last settled value of this stage, never a promise, never absent once the stage has resolved at least once. This only becomes decidable once the stage signature question below is taken up.

**A write before the first read.** Neither setter form materialises the derivation, so a write to a signal nothing has read yet lands, the body has still never run, and the first read runs it and publishes over the write. This follows from the settled decision that the update function receives `undefined` rather than forcing an evaluation, and it is recorded here as a consequence rather than a separate choice. It has not been tested against a real usage.

**Cancellation is not speculation-aware.** The write is scope-aware and rolls back on discard, but `cancelRun` mutates plain closure variables — the retained generator and the suspended-on promise are not per-scope state. So a write inside an action that is later discarded would still have irreversibly discarded the derivation's generator and abandoned its in-flight promise. The likely resolution is that cancellation is part of the write's committed effect and should therefore be deferred to commit rather than run at write time, but this has not been worked through. Note also that the speculation path builds fresh generators through `defaultRecipe` and does not support asynchronous stages today ([`src/computed.ts:262-278`](../../../src/computed.ts)).

**Sections not yet designed.** The discussion covered the surface, the setter, cancellation, and the write's bookkeeping. Not yet covered: the full speculation interaction, the failure and pending registry integration beyond what is noted above, and the test plan.

## Deferred

**A stage parameter object carrying an abort signal and the stage's previous value.** The intended shape is `({ signal, previous }) => …` for stage 0 and `(value, { signal, previous }) => …` for later stages, chosen so that further members can be added without another signature change. This was decided in an earlier session and never written down; it is recorded here so it is not lost again, and it is explicitly out of scope for the writable derived signal work.

Two facts about its current state:

- The blocker is gone. Giving stages an abort signal was previously blocked because a request that must be cancelled is created inside the stage body by definition, and under restart-from-top resumption a generator that built its promise inside its own body never converged ([ADR 0013](../../adr/0013-generator-stages-resume-with-dependency-replay.md), and the resolved entry in [`docs/follow-ups.md`](../../follow-ups.md)). ADR 0013 replaced restart with resume, so that no longer holds.
- The teardown hook already exists. Discarding a generator calls its `return` method, which runs its `finally` blocks, and drains its registered cleanups ([`src/computed.ts:191-216`](../../../src/computed.ts)). So `onCleanup(() => controller.abort())` inside a generator stage works today; a parameter would only make it the default rather than something each stage wires by hand.

`previous` would hand a stage its own `lastResolvedValue`. Per stage, not per pipeline — each stage already keeps that field, so no new bookkeeping is required. A write reaches only the tail, so an intermediate stage's previous value is never affected by one. Two questions were raised and left unanswered: whether a write feeds forward into the tail's previous value on the next run (the argument for is that it is what makes reconciling a refetch against local state possible, which is the user-space route to the "let the fetch finish and then apply the write on top" behaviour rejected as a default), and what it holds while a written promise is in flight.

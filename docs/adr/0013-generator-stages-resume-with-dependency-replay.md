# Generator stages resume instead of restarting, and replay their recorded dependencies

A suspended generator stage is retained and resumed with `gen.next(value)`
rather than discarded and re-executed from its first line. Because resuming
runs only the code after the pause, and r3 rebuilds a computed's dependency
list from the reads that occur during each run, the stage first re-reads the
dependencies r3 recorded before the pause. That re-read serves two purposes at
once: it keeps those dependencies linked, and its return values are compared
against the values captured at the pause to decide whether to resume at all. If
any of them changed, the retained generator is discarded and a fresh one runs
from the top.

## Why

A generator stage that constructs its promise inside the body never converges.

```js
const c = computed(function* () {
  const x = yield* read(fetchSomething())
  return x + 100
})
```

Resumption today re-invokes the stage function, which builds a new generator
that runs from the first line. The driver only skips past an earlier yield when
that yield produces a promise object it has already recorded as settled, and
`fetchSomething()` builds a new promise on every run. So the stage suspends,
settles, re-runs, and suspends again without end. Measured at thirty-one body
runs and thirty-one promises created over thirty-one settles, with the value
never resolving.

Every existing generator test creates its promise outside the body
(`test/computed.test.ts:123`, `test/computed.test.ts:155`), where the identity
is stable, which is why the failure went unnoticed.

This blocks giving stages an abort signal for cancellation. A request that must
be cancelled is created inside the body by definition, since its address
generally depends on a value the generator computed earlier and therefore
cannot be hoisted out.

## The dependency constraint

r3 stores a computed's dependencies as a linked list and rebuilds it on every
run. `recompute` resets the list cursor before invoking the body
(`../r3/src/index.ts:165`), each read advances the cursor
(`../r3/src/index.ts:271-282`), and everything the cursor did not reach is
unlinked afterwards (`../r3/src/index.ts:175-186`). A dependency survives a run
only by being read during that run. There is no way to tell r3 to retain a
dependency registered by an earlier run.

Restarting from the top satisfies this for free: the whole body re-executes, so
every signal in it is read again every time. Resuming does not, because only the
code after the pause runs.

```js
computed(function* () {
  const a = yield* read(sigA)                 // read before the pause
  const r = yield* read(fetch(`/x/${a}`))     // pauses here
  const b = yield* read(sigB)                 // read after the pause
  return a + b + r
})
```

On a resumed run only `sigB` is read, so r3 drops `sigA` and writes to `sigA`
stop re-running the stage.

The replay walk prevents this. Reading the recorded dependencies before
resuming puts them back in the list, and r3's reconciliation reuses the existing
links when they are replayed in their recorded order, so only genuinely new
dependencies allocate.

The dependencies are read back from r3 itself rather than from anything pulse
records. `Computed.deps`, `Link.dep`, `Link.nextDep`, and `read` are all part of
r3's public interface (`../r3/src/index.ts:13-19`, `:35`, `:333`), so pulse can
walk the list r3 built. This captures every dependency r3 actually recorded,
however it was read — through `yield* read(x)`, through a direct call to a
signal accessor, or through any other path. Recording reads inside pulse's own
`read` helper instead would have missed direct accessor calls and dropped those
dependencies silently.

## The mechanism

A generator stage node holds two additional fields: the retained generator, and
the dependencies with their values as of the moment it paused.

On each run of the stage body:

- With no retained generator, invoke the stage function for a fresh generator
  and drive it from the first line. This is a first run, or a run after a
  previous one completed.
- With a retained generator, walk the recorded dependencies and call r3's `read`
  on each, comparing the returned value against the recorded one. If the stage's
  input changed, or any recorded dependency changed, discard the retained
  generator and run a fresh one from the top. Otherwise resume the retained
  generator.

Resuming reads the settled state of the promise the generator paused on, which
is already held in the promise state map, and feeds the value to `gen.next` or
the rejection reason to `gen.throw`. No separate storage for the resumed value
is introduced.

When driving pauses again, the recorded dependencies are rebuilt by walking r3's
list from its head up to and including the cursor. The cursor marks the last
dependency read during this run; anything past it is left over from the previous
run and is about to be unlinked, so it must not be recorded. The generator is
then retained. When driving finishes, both fields are cleared.

The driver gains a second entry point that drives an existing generator forward,
and the pending outcome carries the generator back to its caller instead of
dropping it.

## Restarting discards the generator by running its `finally` blocks

A discarded generator is disposed with `gen.return()`, which runs its `finally`
blocks, rather than by dropping the reference.

```js
computed(function* () {
  const connection = open()
  try {
    return yield* read(fetch(url))
  } finally {
    connection.close()
  }
})
```

Dropping the reference leaks the connection on every restart. Running the
`finally` blocks closes it, and makes `try`/`finally` a working teardown site
inside a generator stage, which is the mechanism the cancellation work needs
next. The `finally` body runs untracked so its reads do not join the dependency
list, and a throw from it routes to the failure handler.

Owner disposal calls `gen.return()` on any retained generator as well, in
addition to the existing `unwatched` call on each stage node
(`src/computed.ts:86-90`).

## `onCleanup` inside a generator stage binds to the generator, not the run

`onCleanup` registers on the r3 node when it is called inside a reactive body
(`src/owner.ts:333`), and r3 runs a node's registered callbacks at the start of
every recompute and then clears them (`../r3/src/index.ts:162`, `:421-434`).

Re-executing the body from the top kept that balanced: the body re-registered on
every run, and every registration fired once. Resuming does not. The code before
the pause runs once, so the callback is registered once, but the settle still
triggers a recompute — so r3 would run it before the generator is resumed.

```js
computed(function* () {
  const socket = new WebSocket(url)
  onCleanup(() => socket.close())
  const message = yield* read(firstMessage(socket))
  return process(message)
})
```

The socket would be closed as the first message arrives, and `process` would run
against a closed socket. Today the same code is also wrong, but visibly so: the
promise is created inside the body, so it never converges at all. Converging
while tearing a resource down at the wrong moment is worse than not converging.

So while a generator stage is being driven, `onCleanup` registers on that
generator rather than on the r3 node, and its callbacks run when the generator
ends — when it completes, when it is discarded, or when its owner is disposed.
That is the same moment `gen.return()` runs, so the two teardown mechanisms a
generator stage offers fire together and mean the same thing.

The callbacks run most-recently-registered first, and after the `finally` blocks
that `gen.return()` triggers, since a `finally` block is lexically inside the
code that registered an earlier callback.

Routing this way is safe for the same reason an ambient value is safe inside a
generator and unsafe across `await`: pulse calls `gen.next()` itself and regains
control at every yield, so it brackets every segment of the body synchronously.
The generator branch is checked before the r3-context branch, because driving a
generator happens inside an r3 context and the generator's lifetime is the more
specific answer.

## A dependency change restarts the whole stage

There is no way to rewind a JavaScript generator to a point part-way through it.
It can be resumed forward or replaced. So when a dependency read before the
pause changes, the only sound response is to run a fresh generator from the
first line, and any asynchronous work an earlier segment completed is done
again.

```js
computed(function* () {
  const a  = yield* read(sigA)
  const r1 = yield* read(fetchX())    // first pause
  const b  = yield* read(sigB)
  const r2 = yield* read(fetchY())    // second pause
  return a + b + r1 + r2
})
```

While waiting on the second request, a change to `sigB` restarts from the top
and reissues the first request, even though the first request did not depend on
`sigB`.

This gives a clear rule: place a stage boundary where work should not be redone.
Stage boundaries already provide re-entry that does not re-run upstream stages.

## Considered alternatives

- **Keep restarting from the top, but record earlier yields by position rather
  than by promise identity, and serve them from that record.** Rejected: it does
  not solve the problem it appears to. In `yield* read(fetch(url))` the call to
  `fetch` is evaluated before the driver ever sees the yield, so the request is
  issued and only afterwards does the driver supply the recorded value. The
  value would converge while the requests continued to be issued on every run,
  and the redundant requests are the reason for the change.

- **Leave resumption alone and turn the non-convergence into an error.** Detect
  a stage that pauses again on a different promise at the same position with
  unchanged dependencies, and throw a message directing the author to hoist the
  promise or split the pipeline into more stages. Rejected: it is cheap and
  honest, but it makes a generator stage permanently unable to hold a
  cancellable request, which is where the investigation started.

- **Record dependencies inside pulse's `read` helper instead of reading them
  back from r3.** Rejected: a generator that calls a signal accessor directly
  rather than through the helper works today, and would silently stop being
  tracked. Reading the list back from r3 has no such gap.

- **Recover the reactive context across the pause with an ambient value.** This
  works for generators, since pulse controls both sides of every pause, but it
  requires a hook in every accessor and still only sees what pulse's own
  accessors report. Reading r3's list back is both simpler and complete.

## Consequences

- **Code before a pause runs once rather than once per settle.** This is the
  largest visible change. A generator stage body with a side effect in it
  currently repeats that side effect on every suspend-and-settle cycle; it now
  happens once. Generator stage bodies become safe to write with side effects,
  which they are not today.

- **`onCleanup` means something different inside a generator stage than
  elsewhere.** Everywhere else it is per-run: it fires before the node's next
  re-run. Inside a generator stage it is per-generator: it fires when the
  generator ends. This is a divergence in one primitive's meaning across two
  contexts, accepted because the per-run meaning has no coherent reading in a
  body that does not re-run. It needs stating in the `onCleanup` documentation
  rather than being left for a reader to discover.

- **The determinism assumption disappears.** Skipping past earlier yields
  assumed a re-executed body would reach the same yields in the same order and
  produce the same promise objects. With no re-execution, nothing assumes it.

- **`CONTEXT.md` gains a third level of re-entry granularity.** It
  currently describes two: multi-shot re-entry at stage boundaries, and
  re-execution from the top within a stage. Generator stages move to a middle
  level — genuine resumption of a continuation, forward, once per pause. Stage
  boundaries remain the only place with multi-shot re-entry, because a
  JavaScript generator cannot be re-entered at an earlier point. Sync stages,
  async-function stages, and `use()` suspension in effects and bindings continue
  to re-execute from the top.

- **The workaround in `settled` becomes unnecessary.** `settled`
  (`src/async.ts:236`) yields a `Promise.all` built inline, which is the shape
  that fails to converge; it works today only because it filters out promises
  that have already settled (`src/async.ts:248-254`) so that a re-run yields
  nothing. With resumption there is no re-run to filter. The filter is left in
  place and its removal tracked separately.

- **Disposal reaches into a paused generator.** This is the same reach an abort
  needs, so it is the seam the cancellation work builds on.

- **The failure entry's `reset` clears the retained generator**
  (`src/computed.ts:475`), because a retry starts over rather than resumes.

- **The speculation path is unchanged.** `publishedNode.defaultRecipe`
  (`src/computed.ts:168`) continues to build fresh generators; speculation does
  not support asynchronous stages today, as its own comment records.

- **A restart may leave a dependency linked that the fresh generator no longer
  reads**, because the replay walk reads the recorded dependencies before the
  decision to restart is made. The stage can then run when it did not need to.
  This is conservative rather than incorrect, and it lasts one cycle: the next
  pause rebuilds the record from what that run actually read.

## Relationship to other decisions

[ADR 0003][adr3] chose one r3 computed per stage as pulse's wrapper
architecture. That is what makes this change possible without touching r3: the
dependency list being replayed belongs to a node pulse created and controls.

[ADR 0012][adr12] put every promise's settled state in one map keyed on the
promise. That map is what supplies the value a resumed generator is fed, so no
new storage for the resumed value is needed.

[adr3]: ./0003-reentry-on-normal-node.md
[adr12]: ./0012-weakmap-backed-promise-read-model.md

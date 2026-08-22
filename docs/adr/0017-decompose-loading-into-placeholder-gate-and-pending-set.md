# Decompose `<Loading>` into a placeholder, a commit gate, and a named pending set

`<Loading>` does three separate jobs. This record splits them, and states the
principle that falls out of the split: **the read verb decides what a binding
renders and whether that binding waits for its neighbours. Everything else in
the loading lifecycle is reported ambiently, from the reads a binding makes.**

Most of this is not implemented. Two pieces are: a binding compute now records
which pending sources it read rather than reporting a boolean and two loose
promises, and a node records the sources its recipe read so that loading state
crosses a tolerant read. Both of those feed reporting only. The rest — the
split itself, the named pending set — is still a design record. Gate membership
was the one part of it that would have changed behaviour, and it is settled the
other way: it stays where it is today, on the verb. The sections below
distinguish between what was verified against the source and what is still an
argument.

## The three jobs, as they exist today

Everything below lives in `src/dom/loading.ts`, in one component:

1. **The commit gate.** `pendingSet`, `readySet`, `deferredCommits`, `flushAll`,
   the end-of-microtask tail check, `register()` returning a
   `BindingController`, and `deferOrCommit`. This is what makes several
   bindings land in one pass instead of each landing when its own read
   resolves.
2. **The display swap.** The `initial` and `fallback` properties, the
   `hasEverLoaded` latch, and the returned accessor that chooses between the
   loaded subtree and a replacement.
3. **The aggregate.** `activeSig`, which is the only thing `isLoading()` and
   `useLoading()` read. It is computed as `gatePending` or
   `backgroundPromises.size > 0` or `firstLoadPromises.size > 0`.

The component already computes two different answers to the question "is
something in flight here", from two different sets: `gatePending` deliberately
excludes `backgroundPromises`, so that a refresh behind visible content cannot
reopen a fallback. That exclusion is the clearest evidence that the gate and the
aggregate are not the same question.

## Why the aggregate is the wrong shape

The gate and the swap are both statements about a region of the interface.
"These bindings land together" and "this area shows a placeholder meanwhile" are
naturally expressed by wrapping the area they describe, and the component that
wraps it is by construction an ancestor of everything it coordinates.

The aggregate is not a statement about a region. It is a question about a set of
asynchronous nodes, and `findBoundaryScope` answers it by walking up the owner
tree from whoever is asking. That produces two problems.

First, adding a boundary for one reason silently changes another. Introducing a
`<Loading>` so that several fields commit together also re-parents every
`isLoading()` call below it, because the lookup finds the nearest boundary
regardless of why that boundary exists.

Second, a reader that is not a descendant cannot ask at all. A progress
indicator in the application chrome, a disabled button in a toolbar, a
route-level indicator — in each case the thing that is loading is not below the
thing that wants to know. The only way to express it today is to hoist a
`<Loading>` to the common ancestor, which drags the gate and the swap up with
it, or to create a boundary with neither `initial` nor `fallback` — the
"context-only" mode already documented in `src/dom/loading.ts`, which is the
component admitting that the aggregate wants to exist on its own.

The examples corroborate this. `examples/typeahead` contains no `isLoading()`
call at all: every loading indicator in it reads `isPending(results)` or
`isPending(record)`, including the one that sits inside a boundary and ignores
it. `examples/pokemon` has two `isLoading()` reads and both could be
`isPending(list)` with no loss. Where a reader can name what it is waiting for,
`isPending` already answers precisely, from anywhere, with no scope involved,
because it walks `PendingEntry.upstream` — the data graph rather than the owner
tree.

## The decomposition

- **`<Placeholder fallback={…}>`** — the display swap. Builds its children once,
  immediately, and keeps them alive; swaps only what is displayed. Collects the
  loading state of its own subtree, which is the one place where tree
  containment is the correct relation, because a placeholder is by construction
  an ancestor of everything it waits for.
- **The commit gate**, working name `<Coherent>`. No properties. Whether it is
  needed as a user-facing component at all is left open below.
- **`pendingGroup()`** — a set of pending sources as an ordinary value, read
  with `isPending(group)` from anywhere. A placeholder can be handed one so that
  the region it covers publishes its activity under a name.

## Why the placeholder is not `Show`

`Show` constructs a branch lazily, only when that branch is selected
(`src/dom/show.ts:59`), and disposes the previous branch's owner on every flip
(`src/dom/show.ts:53`). `<Loading>` constructs its children once, up front,
inside the boundary owner, before it knows whether it will display them.

That is not an implementation detail. Constructing the children is what starts
the work the placeholder is waiting for. In `examples/pokemon/src/main.tsx:21`,
`PokemonDetails` issues its request in the component body:

```tsx
function PokemonDetails(props: { name: string }) {
  const pokemon = fetchPokemon(props.name)
  …
}
```

Placed under a `Show` whose condition derives from `pokemon`, the branch is
never constructed while the condition is true, so the request never starts, so
the condition never becomes false. The placeholder must build its children
eagerly and withhold them from the screen instead.

The second difference applies to every later flip: because `Show` disposes the
branch owner, flipping back re-runs every component body underneath, re-issuing
every request and discarding every locally created signal, computed, and piece
of interface state. This also rules out expressing the placeholder as a property
on `Show`, because eager construction is the negation of what `Show` is for.

`Show` is sufficient for exactly one case: a first-load swap in one direction,
over a subtree that starts no work of its own.

## Throwing decides what renders, and what waits

[ADR 0015](0015-peek-latest-split-ambient-loading-participation.md) established
that `use()`'s only benefits at a call site are that it returns `Awaited<T>`
instead of `Awaited<T> | undefined`, and that it enrols the binding in the
atomic-commit gate. Everything else it appeared to provide was coordination that
had simply never been given another route. Both of those two survive: the
section on gate membership below keeps the second.

The general statement is that the throw is a decision about values, taken at the
read site, and that reporting — loading state, first load, errors — is ambient
and taken from whatever the binding read.

There is a corollary that keeps this honest. The throw is also "I have nothing
to render yet": a binding that throws never runs `apply(value)`, so nothing is
written and the surrounding structure it would have produced does not appear
either. A tolerant read commits whatever it returned, usually `undefined`, so
the structure appears with holes in it:

```tsx
{() => <div class={use(x).cls}>{use(x).name}</div>}          // no div at all
{() => <div class={latest(x)?.cls}>{latest(x)?.name}</div>}  // <div class=""></div>
```

This belongs inside the principle rather than being an exception to it: "no null
check at the read site" and "nothing written to the screen meanwhile" are the
same guarantee seen from the type side and from the screen side. It does mean
that applying the principle mechanically — "the lifecycle is ambient, so always
read tolerantly" — changes what appears on screen, so it has to be stated.

The read site is then left with one question, and five answers. The third
column is decided by the second: a binding waits for the rest of its gate
exactly when the verb it used could have suspended, whether or not it suspended
on this run.

| written | rendered while the value is absent | waits for the rest of the gate |
| --- | --- | --- |
| `latest(x, default)` | the default | no |
| `latest(x)` | whatever the surrounding expression makes of `undefined` | no |
| `use.latest(x)` | the previous value, or nothing until one has ever arrived | yes |
| `use(x)` | nothing, and the nearest placeholder covers the region | yes |
| `peek(x)` | as `latest(x)`, reporting nothing — for reads outside a binding | no |

### The principle is scoped to binding call sites

A computed stage body has its own propagation channel, and it is not ambient:
`registerPending` together with `PendingEntry.upstream`. A stage tells its
consumers that it is waiting by being pending, and it becomes pending by
returning a promise or by suspending.

Ambient marks do not reach out of a stage body at all. `runBindingCompute`
wraps DOM binding computes only; no stage body is wrapped by
it. A `latest()` call inside a stage is collected only when that stage happens
to run synchronously nested inside some binding's compute, which is
position-dependent and incidental. That is the same class of fragility already
recorded in `docs/follow-ups.md` for the generator-cleanup slot.

After an `await`, nothing that requires knowing who is reading survives, because
the ambient slot's extent has ended and r3's context has been lost. Only a
mechanism that carries its own destination crosses — which a throw does, since
it carries the promise it is waiting on and rides the rejection, and which an
ambient mark does not. A generator stage is in the same position: dependency
replay preserves r3's context across a pause
([ADR 0013](0013-generator-stages-resume-with-dependency-replay.md)), but the
driver resumes the generator from a settle handler, outside any binding compute.

So inside a stage body, suspending is the propagation mechanism and always was.
Reading tolerantly there is the deliberate opposite: take whatever value is
present and do not make this node wait.

## The verbs are the only places the async colour stops

An asynchronous node's raw accessor always hands back a promise — a pending one
while the work is in flight, and a resolved one wrapping the value afterwards
(`setPublishedValue(resolvedPromise(...))` in `src/computed.ts`). The colour is
carried in the value at runtime, not only in the type
([ADR 0004](0004-propagate-async-color.md)).

A derivation that reads a source and passes the promise along is therefore
asynchronous itself, with no verb and no reporting machinery involved.
Measured: with `memo` pending, `computed(() => memo())` reports pending and
resolves to the same value, because it holds the same promise. Doing anything
else with a raw read produces a permanently wrong value — `memo() + 1` is
`"[object Promise]1"` before and after the source settles — which is what the
propagated colour exists to make visible, and which TypeScript rejects without
a double cast.

So propagation is the default, and the three read verbs are the three ways to
stop it:

- `use(x)` refuses to stop it until the value is there. The reader stays
  pending, because it suspended.
- `latest(x)` stops it and takes the value the source last resolved to.
- `peek(x)` stops it, takes the same value, and deliberately reports nothing.

### A tolerant read should leave a trace

Stopping the colour is right: a derivation that read tolerantly has a value and
is not waiting for anything. But its value was computed from a source that is
still in flight, and nothing downstream can currently discover that. Measured,
with `memo` pending: `computed(() => use(memo) + 1)` reports pending, and
`computed(() => (latest(memo) ?? 0) + 1)` does not, even though the second
one's value will change when `memo` resolves.

This is not a missing concept. `isPending(x)` already means "something is in
flight" rather than "there is no value here" — a refreshing node reports
pending while the value it last resolved to is still on screen, which is
exactly what `examples/typeahead` reads to show that a search is running. The
gap is that the fact stops at a tolerant read instead of propagating through
it.

The mechanism is the collection this record already calls for at the binding
layer, applied one layer down. A node's recompute records the pending sources
whose values it read, and those become a dynamic upstream on its
`PendingEntry`, alongside the static pipeline chain that `upstream` already
holds. `isPending`'s existing walk then crosses tolerant reads with no change
to the walk itself.

Every read is recorded, pending or not, and whether any recorded source is in
flight is asked later and live. The record therefore says which sources this
node's value came from, and nothing about when it was taken. That matters
because the alternative — recording only sources that were pending at read time
— would make the answer depend on when the reader last ran. In practice a
refetch does invalidate readers, since the new promise becomes the source's
published value, but the record should not rest on that.

`peek` records nothing, which is what finally distinguishes it from `latest`
outside a binding. Today the two are indistinguishable there, which is why
`peek` reads as an escape hatch with nothing to escape.

This is also where the binding layer and the node layer converge. If every
compute records what it read — a binding through `runBindingCompute`, a node
through its own recompute — then a boundary consulting its children and a
consumer calling `isPending` are the same walk over the same kind of record.
That is the open question about bindings as nodes, reached from the other side.

### What this does to `use`

`isPending` is one predicate, and it already means "something is in flight"
rather than "there is no value here": `use(c)` on a refreshing node throws
today even though that node is holding its previous value, which
`test/async.test.ts:298` locks in. Crossing tolerant reads therefore widens
where `use` suspends — a node that read anything now refreshing reports
pending, so `use` on that node throws.

That was decided deliberately rather than tolerated. The alternative, a second
query so that `isPending` stops at a tolerant read, leaves `isPending` with an
arbitrary stopping rule: it would still mean "in flight" for a refreshing leaf
and something narrower for a node derived from one. One predicate that means
the same thing everywhere is worth `use` suspending more often, and
`use.latest` is the read for a call site that wants the stale value instead.

The cost to watch is a node that reads many sources: it reports pending
whenever any of them refreshes, so `use` on an aggregate can suspend often. If
that turns out to bite, the answer is a narrower query rather than a stopping
rule inside this one.

## Gate membership stays with the read verb

Three models were weighed.

**Membership by marker, which is what exists today, and what this record
keeps.** A binding joins the gate only if it called `use()` or `use.latest()`,
both of which call `markUsedInBinding()` (`src/async.ts:279` for the second of
the two). The flag is captured per compute by `runBindingCompute` and returned
as `engagedTransition`. `CONTEXT.md` describes this per-read-site opt-in as the
framework's central bet.

Two things are said against it.
[ADR 0015](0015-peek-latest-split-ambient-loading-participation.md) left
`examples/todo-async` with no `use()` call at all and every behaviour intact, so
nothing in it joins a gate: the marker is the gate's only membership mechanism
in a codebase that has been migrating away from the primitive that sets it. And
once the gate is its own component, requiring a second marker inside it looks
redundant, because wrapping the region already said which bindings should land
together. Neither is a defect. The first says gates are rare, which is a reason
to ask whether the component is needed at all — recorded below as open — and not
a reason to widen who joins one. The second is answered by the region model,
immediately below, which is what "wrapping already said it" means when written
out.

**Membership by region — every binding under the gate defers.** Refuted by
`examples/typeahead`: the wrapped element carries
`class:stale={isPending(record)}`, a binding whose entire purpose is to indicate
staleness during the load. Holding its commit until the load ends means the
indication can never appear while it is wanted. Any indicator placed inside the
region it describes fails the same way.

**Membership by source — a binding defers if it read the value of a source that
is currently pending, and does not defer if it read only that source's pending
state.** The distinction is available in the existing structures:
`PendingEntry.pending` is its own reactive accessor, separate from the value
accessor, so reading a value and reading a pending flag are already different
reads. `docs/async/deep-dives/solid-2x.md:148` records Solid 2.x deciding commit
readiness per source rather than per transition, through
`_asyncReporters: Map<Computed, Set<Computed>>`, and calls it materially more
precise than blocking a commit on any pending boundary in scope.

This model is not adopted, for three reasons.

**It deletes a combination and puts nothing in its place.** Today `latest(x)`
means: take the value the source last resolved to, report loading and errors
ambiently, and commit when this binding is ready. Under membership by source
that combination has no spelling inside a gate, because reading the value is
what enrols you. The only verb left that never defers is `peek`, which reports
nothing at all — so a binding that wants to move on its own has to give up error
propagation to `<Errored>` and loading reporting to get there. This is not
hypothetical: `examples/typeahead/src/main.tsx:32` reads the result list with
`latest` and says why in the comment above it — the list wants a total value and
wants the boundary to hear about the refresh, but has no reason to join its
gate. Membership by source overrules that sentence from outside the call site.
The region model was refuted by a binding that had to keep committing while its
region waited; membership by source re-admits a narrower form of the same
failure, for value reads rather than for pending-state reads.

**It compounds with node-level collection.** Now that a node reports pending
when any source it read is refreshing, a binding over an aggregate node reads,
transitively, everything that node read. Under membership by source such a
binding defers on almost any refresh anywhere upstream. The answer offered above
for the same effect on `use` — write a narrower query — applies to a call site
that asked to suspend. It does not apply to a binding that never asked to
coordinate with anything.

**Its motivating case is not demonstrated.** The tear it prevents is a gate
whose bindings read different sources tolerantly and therefore land in different
frames. No example contains one. Measured, the example that motivates the gate
does not exercise the gate at all: see the finding below on
`examples/typeahead`.

What remains is the positive statement, which is the reason to keep the verb
rather than merely the absence of a reason to change. **A binding waits for its
neighbours exactly when the verb it used could have suspended.** `use` and
`use.latest` can throw; `latest` and `peek` cannot. A call site that wrote `use`
said it has nothing to render until the value arrives, and holding it until its
neighbours are ready too is a continuation of that sentence. A call site that
wrote `latest` already decided what to do about the absent value, at the read
site, in the expression itself; withholding its commit overrides a decision it
has already taken. Membership by source makes that decision from the outside,
out of what the binding happened to read.

So gating stays explicit. A binding lands with others because a verb named it,
not because of what it touched.

### If this reopens, a marker alone would not be enough

Making a tolerant read call `markUsedInBinding()` was considered and does not
work, for a reason that is worth recording because it is not obvious.
`pendingSet` is populated from exactly one place: `report({ status: 'throwing'
})`. A tolerant read never throws, so it never enters that set. A region of
tolerant reads over two different sources therefore behaves like this: the first
source resolves, its binding queues a commit through `deferOrCommit`, the
end-of-microtask tail check finds `pendingSet.size === 0` because the second
source's binding never threw, and it flushes. The frame is torn anyway.

Participation requires both halves — queue the commit, and register the pending
source that was read as something the gate must wait for. The second half is
membership by source. There is no cheaper version, so a future scenario that
demands tolerant participation is asking for the whole model, not for a flag.

### What this leaves standing in ADR 0015

[ADR 0015](0015-peek-latest-split-ambient-loading-participation.md) considered
and rejected letting a tolerant read participate in the gate, on the grounds
that nothing in that shape ever throws, so `gatePending` resolves to false
almost immediately and `hasEverLoaded` becomes true before any data has
arrived. That rejection stands, and it was measured against a real defect.

The decomposition would remove that particular obstacle without displacing the
decision. Split, the gate does not own `hasEverLoaded`; the placeholder does,
driven by first-load reporting that is keyed on the accessor's own state, and
the failure mode requires the gate signal and the swap signal to be one signal.
The same applies to the two exclusions written into `src/dom/loading.ts`:
`backgroundPromises` is kept out of the gate because an in-flight refresh must
never reopen a fallback, and `firstLoadPromises` is kept out for a related
reason. Both are statements about the swap, enforced on the gate because they
share a signal. Once withholding a commit and reopening a fallback are separate
actions with separate owners, all three exclusions become independently
decidable.

That is reasoning about code that does not exist yet, and it argues only that
one obstacle would be gone. It is not an argument for tolerant participation,
which is decided against above on other grounds.

## The placeholder is not summoned by a tolerant read

Writing `latest(value)?.name` states that the value may be absent and says what
to do about it. Covering that binding with a placeholder anyway makes the
optional-chaining dead code. So a tolerant read should not summon the
placeholder.

The swap should instead fire on a fact about the region: **there is nothing on
screen here.** That is true in two situations, and both are real state rather
than a consequence of which verb was written:

- a binding threw, so it committed nothing;
- the gate is holding commits and the region has never committed anything.

The second matters. Without it, a gate inside a placeholder would hold
everything back on first load while the placeholder sat unused, and the region
would be blank.

The cost is concrete and should not be understated. `examples/todo-async` reads
`latest(todos)` on a signal seeded with an empty array, so it receives that seed,
renders an empty list, and has therefore shown something — nothing covers it,
and the skeleton is lost. Recovering it needs `use(todos)` in that binding, or no
seed. This partly reverses ADR 0015's headline result. What survives of that
result is the part it was actually about: loading and error *propagation* do not
need the throw, and still do not. What needs the throw is being covered, because
being covered means having nothing to show.

## One content property, not two

Today `initial` and `fallback` cover for each other — `initial ?? fallback` on
first load, `fallback ?? loadedSubtree` afterwards — which is why there is a
precedence order to remember. They should not cover for each other.

More than that, the second one is barely reachable. A `<Loading fallback={…}>`
whose children read tolerantly never shows that fallback during a refresh,
because the background-refresh set is deliberately excluded from the swap
condition; it only ever shows it on first load, through `initial ?? fallback`.
Change the child to a suspending read and the same markup does show it during a
refresh. The same markup means two things depending on a verb written inside it.

So: one property, `fallback`, meaning what to show when there is nothing to show.
Holding the previously displayed content across a refresh is the default,
because dropping it is rare and usually worse for the reader. Dropping it stays
possible, but as something written explicitly rather than something obtained by
choosing a property name.

Note that this changes what the word `fallback` selects on: today it names the
refresh case, and here it names the first-load case. That is safe only because
the component is renamed at the same time, so every call site is edited and
nothing silently changes behaviour.

## Naming

`<Placeholder>` was chosen for the swap.

`<Suspense>` was considered seriously and rejected. The argument that Suspense
means "catches a thrown promise" is React-specific and does not hold: verified
against `solid-js@1.9.7`, Solid 1.x's `createResource` read throws only for
errors, and for a pending read it increments a counter on the nearest
`SuspenseContext` and returns `undefined`. `Suspense` itself is that counter
plus an eagerly constructed, kept-alive subtree — `createMemo(() =>
props.children)` built once, with an outer memo choosing between it and the
fallback. That is the same shape as `<Placeholder>`.

It was rejected on two other grounds. Solid 1.x's `Suspense` also defers effects
through `store.effects` and `resumeEffects`, so it is the collection mechanism
and the commit gate together — the two jobs being separated here — and adopting
the name would suggest the gate is included. And Solid 2.x renamed `<Suspense>`
to `<Loading>`, so taking the name now moves toward one this project's closest
neighbour has abandoned.

`docs/async/deep-dives/solid-2x.md:347` states that pre-2.x Solid caught a
promise throw, React-style. That is inaccurate and should be corrected.

## Tree position is the wrong shape for the gate as well

The aggregate needed to become a value because arbitrary readers cannot be
required to sit below what they are asking about. The gate has the same problem
in a different direction: two regions on opposite sides of a page that must land
in one frame cannot be expressed by wrapping, because there is nothing to wrap
that does not also contain everything between them.

So the gate should also be nameable, and a group should be able to gather
bindings that are not siblings.

This corrects something asserted earlier in the discussion that produced this
record. Nearest-boundary-wins was said to be a necessity for the gate, on the
grounds that exactly one boundary must own a commit. It is not. Holding
composes: a binding commits when nothing is holding it, and several claimants
can hold the same binding without conflict, releasing it when the last one lets
go. Nearest-wins is an artefact of a binding registering one controller with one
scope.

## Actions, and what coherence has to do with them

An action coordinates what it **writes**. The gate coordinates what bindings
**read**. They overlap where the asynchronous work happens inside the action —
a generator that fetches, waits, and writes at the end produces one commit and
one frame, and needs no gate.

They do not overlap where the asynchronous work is merely *caused* by the
action. Selecting a city writes one signal; the derivation that fetches the
record refetches afterwards, and the fields that read it would each update as
their own read resolves. Holding an action's commit until everything it set in
motion has settled is a write-side transition, and this project's stated bet is
the read-side alternative.

One objection to write-side coordination does not apply here, and this record
corrects it. Write-side coordination is usually said to force read-side escapes,
because holding everything downstream also freezes things that should move
immediately — in the example above, the header that names the city being
requested. This project already has the escape and it is on the write side:
`optimistic` declares a value as one that leaks out of the action at once
([ADR 0016](0016-optimistic-as-a-signal-variant.md)). Marking the selection
optimistic and leaving the record ordinary gives the header immediate movement
and the fields a coherent frame, with no reader opting out of anything. That is
a better placement than a per-reader escape, because one declaration covers
every reader.

What an action cannot coordinate, however it commits:

- **Asynchronous work nobody caused** — a first load, a route change, a
  derivation refetching because its input changed for an unrelated reason.
- **Asynchronous work with two causes** — two separate actions whose results
  should land in one frame.

Both are set-shaped rather than cause-shaped, which is what a group is for.

Two things are worth stating plainly. An action does not currently wait for
asynchronous work it caused; making it do so is a feature, not a
reinterpretation. And reading a downstream derivation from inside the action
that wrote its input runs that derivation's recipe twice and issues two
requests, which is exactly the shape such a feature would take — measured, and
recorded in `docs/follow-ups.md`.

## Two things are called coherence

**Tearing** is one frame showing values from different moments side by side. It
needs a previously displayed frame to be inconsistent with, so it is a refresh
problem.

**Appearing in pieces** is parts of a page arriving one at a time as their data
lands. It needs no previous frame, so it is a first-load problem.

Within one region a placeholder handles the second: it lifts when everything
under it has something, so the region appears at once. Across regions it does
not — several placeholders lift at different times and the page assembles in
stages, and no gate addresses this, because a gate holds commits within a region
and says nothing about when two regions appear relative to each other.

That is a third job, and unlike the gate it is not a yes-or-no question: all at
once, in a fixed order, or each as it is ready are all reasonable answers.

### What Solid 2.x does here

Read from `../solid/packages/solid-signals/src/boundaries.ts`. There are two
layers: a primitive `createRevealOrder(fn, { order, collapsed })` and a
`<Reveal>` component on top of it. Both options are accessors, so the order can
change reactively.

It does not touch the suspension protocol. Each loading boundary inside
registers itself as a slot on a `RevealController`, found through context, and
the controller drives two signals per slot: `_disabled`, which holds a boundary
on its fallback even though its data has arrived, and `_collapsed`, which
suppresses that boundary's fallback so it shows nothing rather than a
placeholder. It works entirely by withholding boundaries that are already ready.

The three orders are `sequential`, which is the default and reveals in
registration order with everything past the first not-ready slot held;
`together`, which releases when every direct slot is minimally ready; and
`natural`, which lets each slot reveal on its own readiness and exists mainly so
that a nested group can act as one composite slot in an outer one. "Minimally
ready" means having something to show under the slot's own order, which lets a
`together` group release without waiting for every descendant.

Groups nest: a slot is either a boundary or another controller, an inner group
is held on its fallbacks until the outer releases it, and there is no opt-out
from an outer hold.

Two things transfer. `collapsed` is a real question this discussion had not
reached: a region held by an ordering policy is in a different state from a
region that has nothing yet, and it may want different output. And the
`_disabled` signal confirms that a placeholder under such a policy needs a third
state — ready, but not yet permitted — so it can no longer decide entirely from
its own state.

One thing should differ. Solid's membership comes from the owner tree through
context, and its order comes from registration order, which is render order.
Ordering has no reason to care where regions sit, so it should name groups
rather than contain them.

`together` is worth noting as something that needs no new construct: pointing
several placeholders at one group and having each lift on the group's state is
already that behaviour. `natural` is the absence of a policy. Only ordering
genuinely needs something new.

## Consequences

The split is not implemented. The changes it implies, in rough order of size:

- `src/dom/loading.ts` splits into a placeholder and a gate, and the aggregate
  becomes a value that both can be handed.
- `<Loading>` disappears rather than being renamed, so that every call site is
  edited and the changed meaning of `fallback` cannot be inherited silently.

Keeping membership on the verb means the machinery that implements it stays as
it is. Three things that a move to membership by source would have removed are
therefore kept:

- `src/transition-tracker.ts` keeps `markUsedInBinding`, `usedInCurrentBinding`
  and the `engagedTransition` result field. `runBindingCompute` already returns
  the set of pending sources whose values were read alongside them, and that set
  feeds reporting only — `reportPendingReads` in `src/dom/bindings.ts:110` hands
  each one to `trackBackground` or `trackFirstLoad`, and nothing in the gate
  reads it.
- `BindingController`'s `throwing` status stays. `pendingSet` is populated from
  that report and from nothing else, and it is what holds the gate open.
- `use` and `use.latest` keep calling `markUsedInBinding()`. Enrolling the
  binding is part of their contract, not an implementation detail of it.

## Not decided

- Whether the gate is needed as a user-facing component at all, once actions
  cover caused asynchronous work and a placeholder's lift condition covers first
  load. The test is to name a refresh that no cause owns and that would tear
  without a gate. The measurement below is evidence for the sceptical answer:
  the one example that wraps a gate around several fields does not need it.
- What would reopen membership by source, which is decided against above rather
  than left open: a scenario where two sources resolve at different times, both
  are read tolerantly — so neither binding can be made to suspend without
  changing what is on screen meanwhile — and their values must reach the screen
  in the same frame. Nothing in the examples is that scenario. Building one is
  the work that would settle whether the model is ever wanted.
- Whether `use` earns its place beside `latest(x, default)`. It does where there
  is no sensible default and a partially drawn frame would be wrong, but that
  should be checked against real call sites.
- Whether a placeholder lifts on its own state or on a group's state. If it can
  do either, coordinated reveal of several regions works without an ordering
  primitive, and an ordering primitive is only ever about order.
- Whether bindings should be nodes with their own pending entries, so that
  boundaries read their children rather than children reporting to boundaries.
  The node-level collection described above is half of this, approached from
  the node side; what it does not settle is the binding side.
  This would merge boundaries and groups into one kind of thing and remove the
  module-level slots entirely. The hard parts are that a binding's dependencies
  change on every run, and that releasing a withheld commit still needs a handle
  pointing back at the binding even when state flows the other way.
- Whether `use` inside an action body should be absorbed as suspension. It
  currently throws out of the action; `yield* from(x)` is the supported way to
  wait there. Recorded in `docs/follow-ups.md`.

## Findings recorded while producing this

- The atomic-commit test in `examples/typeahead` does not discriminate.
  `tests/typeahead.spec.ts` records the `detail-name` and `detail-country` pair
  across a selection change and asserts the pair was only ever
  `Amsterdam | Netherlands` and then `Berlin | Germany`. Measured: it passes
  unchanged with the detail `<Loading>` replaced by a fragment. All seven fields
  read the same `record` node, so they are invalidated together, recompute in
  one propagation and land in one pass whether or not a gate is there. The
  example demonstrates supersession and stale-while-revalidate; it does not
  demonstrate atomic commit. Showing that a gate is load-bearing needs bindings
  reading two sources that resolve at different times.
- `first load › the detail header names the selected city before its record
  arrives` was timing-flaky, and the flakiness had nothing to do with the gate:
  measured, it fails intermittently on a full run with the boundary in place,
  and passes when run alone. The in-flight indicator it asserts on is visible
  only for the 280 milliseconds the first `detail` request takes in the default
  latency mode, which a slower machine can spend on the assertion before it.
  Fixed by pinning that test to a long fixed latency.
- `use()` inside an `async` stage parks `NotReadyYet` as the node's error, in
  both positions — before and after the `await`. The node never re-runs, reports
  itself not pending, and an error boundary would receive a suspension signal as
  a user-facing error. The cause is that the `NotReadyYet` catch at
  `src/computed.ts:635` wraps a synchronous `runStage` call, so an async
  function's throw arrives as a rejection and is parked like any other. Measured.
- Asynchronous work inside a speculation is supported, contradicting a claim in
  the handoff document that has now been deleted. `yield* from(x)` inside an
  action awaits a pending derivation, and a write inside an action does
  invalidate a downstream asynchronous derivation, which recomputes and can be
  awaited within the same action. Two narrower defects found in the process are
  recorded in `docs/follow-ups.md`.
- `docs/async/deep-dives/solid-2x.md:347` misdescribes Solid 1.x as catching a
  promise throw.

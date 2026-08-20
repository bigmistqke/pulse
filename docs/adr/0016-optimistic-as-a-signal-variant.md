# Optimistic is a signal variant with a layer in front of it

`optimistic(...stages)` builds the same pipeline `computed(...stages)` and
`signal(...stages)` build — same stages, same stale-while-revalidate
publishing, same registration with the pending and error trackers. The accessor
it returns is an ordinary pulse node, so the read verb is chosen at the read
site: `use(value)` suspends and joins the atomic-commit gate, `latest(value)`
reads tolerantly and reports loading and error state to the surrounding
boundaries, `peek(value)` reports nothing, `isPending(value)` and `error(value)`
query it.

What differs is the write discipline. An ordinary setter's write is isolated to
the action that made it, invisible outside, promoted to the parent scope when
that action commits and gone if it is discarded. An optimistic setter writes a
**layer in front of the derivation** instead:

- **It leaks out.** A reader outside every action sees the top of the layer
  stack, so a prediction is on screen the moment it is made, from outside the
  action that made it.
- **It stays scoped inside.** A reader inside an action sees the nearest layer
  up its own scope chain — its own prediction, or an enclosing action's — and
  otherwise the derivation itself. One action never reads another's guess.
- **It expires with the action.** On the commit face as well as the discard
  face the layer is dropped and the stack refolds. A prediction that turned out
  right survives only because the action also wrote the canonical source the
  pipeline reads.

Optimistic UI is a write discipline, not a separate kind of value.

## What this replaces

The first implementation was a wrapper: `optimistic(source)` returned a plain
closure that read a per-scope layer stack if one was live and `latest(source)`
otherwise. That closure was not a node. It was registered with neither tracker,
so `isPending` and `error` were vacuous on it, `use` on it silently degraded to
setting the transition-engagement marker and returning an already-tolerant
value, and the read verb was fixed at construction — every consumer got
`latest`'s ambient reporting whether it wanted it or not.

Loading and error propagation worked in that design because the wrapper called
`latest(source)` inline inside each consumer's binding, where the ambient slots
in `src/transition-tracker.ts` are drained. That is a real mechanism, but it
made `optimistic` the one place in the library where the read style was decided
by the primitive rather than at the read site — the opposite of what
[ADR 0015](./0015-peek-latest-split-ambient-loading-participation.md) settled
for every other reader. Registration was considered there and rejected as
unnecessary, which it is for loading propagation alone; what it buys beyond
that is `use()`, the per-site read choice, and retry targeting.

## Why the layer sits in front rather than being written in

An intermediate version of this change wrote the layer into the node, through
the same setter `signal(fn)` hands out, forced to committed state. It passed
the whole existing suite and the example's end-to-end tests, and it was wrong
in two ways that only showed up when probed directly:

- **A source that changed while a prediction was live overwrote it.** The layer
  occupied the node's published value, so an ordinary recompute — the source
  resolving, or changing — replaced the prediction with the new value. Measured:
  a prediction of `['predicted']` became `['server-1']` while its action was
  still in flight.
- **An action could not read back its own prediction, but could read a rival's.**
  The write went to committed state, and a read inside a speculative scope
  isolates, so the writing action re-derived the recipe and saw the value it had
  just replaced. Meanwhile an update function's `prev` resolved to the node's
  published value, which is whatever action's layer is on top — so a second
  action's first write absorbed a first action's prediction into its own layer
  value, and the first action's rollback could no longer withdraw it. Measured:
  A refused, and `A1` stayed on screen until an unrelated action B closed.

Both follow from one cause: a prediction and the derivation's own value were
competing for a single slot. Keeping the layers in front of the node instead
means the derivation's value is never replaced, so nothing clobbers it and
there is nothing to revert; and it means a read can be answered per scope,
which is what makes a prediction visible to its own action and invisible to a
sibling.

## Consequences

- **Every read verb applies.** `use(value)` suspends and joins the
  atomic-commit gate — the one capability the wrapper structurally could not
  offer. `peek(value)` is available as the non-reporting read, which the
  wrapper had removed.
- **The recipe is free.** `optimistic(todos)`, `optimistic(() => todos())`,
  `optimistic(() => api.list())` and multi-stage pipelines are all just
  recipes, exactly as they are for `computed` and `signal`. What the recipe
  returns decides the value, and — the same way it does for any derivation —
  whether there is a promise for the node to be pending on.
- **Display is last-write-wins; predictions do not compose.** The top of the
  stack is what an outside reader sees, so a second action's prediction hides a
  first action's until one of them closes. Composing them would mean layers
  were updates folded over the derivation rather than values, which would put a
  purity and idempotence requirement on every update function, since a fold
  re-runs them on each refetch and each drop. Not taken; the scenarios in
  [`optimistic-ui.md`](../pulse/optimistic-ui.md) are dominated by one flow at
  a time per value.
- **An update function's `prev` is resolved at committed level.** This scope's
  own layer if it has one; otherwise `committed(() => peek(derivation))` rather
  than a scoped read. A tracked read of a computed inside a speculation re-runs
  its recipe there, which for an async recipe yields a fresh promise that has
  settled nothing — so a scoped read has no resolved value to offer. What an
  update function wants is the last value that actually came back. The cost is
  that a canonical write made earlier in the same action is not visible to a
  later prediction in that action.
- **While a prediction is live the node reports neither pending nor failed.**
  Both are read on every query before the mask is applied, so a consumer keeps
  its subscriptions and hears about them again the moment the last layer is
  dropped.
- **Wrapping a node links it.** A stage reaches its input's pending and error
  state through the upstream chain, which links stages within one pipeline. A
  node wrapped from outside is not on that chain, so `optimistic(someNode)`
  consults it directly: a background refresh of that node is reported through
  this one, and a boundary's retry resets that node rather than only re-running
  this recipe over a source that is still parked. Verified end-to-end: without
  that link, the example's failed-load-then-retry test does not recover. A
  recipe that reads a node from inside a closure gets neither, exactly as
  `computed(() => someNode())` does — an ordinary derivation is not a wrapper
  and does not claim to be.
- **Dropping a layer has to bring the graph up to date first.** A settle
  callback runs after an action's writes have been promoted but before the
  flush that propagates them, so a layer that is dropped straight away reveals
  a derivation which has not yet followed the write the same action just made —
  a visible flash of pre-action content on exactly the frame it commits.
  Measured: a reader saw `draft`, `saved`, `draft` across one commit. The drop
  therefore stabilizes before it publishes.
- **A hidden derivation still has to be read.** `peek`/`latest` read a
  registered node through its tracker entry rather than through its accessor,
  so that entry is a tolerant reader's only link to the pipeline. If it returns
  a winning layer without touching the derivation, nothing pulls the pipeline
  while a prediction is showing: a source that changes meanwhile is not
  followed, and dropping the layer reveals the value the derivation held when
  the prediction started. Measured: two committed source changes during one
  prediction, and the reader came back to the first of them instead of the
  last. Both the entry and the accessor read the derivation on every call for
  this reason, through the raw non-throwing view so a parked error stays masked.
- **There is no separate canonical reader in the tuple.** When a node is
  wrapped, that node is the canonical handle — `todos` is truth,
  `optimistic(todos)` is the view. A recipe with no separate source has no
  canonical reader while a layer is live, because there is no other node
  holding the truth. Keep the source separate when both views are needed.
- **`optimistic` is no longer library code over scope and cleanup alone.** It
  builds a pipeline and registers tracker entries for its own reader, which
  [`optimistic-ui.md`](../pulse/optimistic-ui.md)'s fifth recommendation had
  hoped to avoid. The trade bought `use`, per-site read choice, and retry
  targeting; the recommendation predates all three being wanted.

## Considered alternatives

- **Keep the wrapper, take a thunk** (`optimistic(() => latest(todos))`) —
  rejected. It collapses the overloads, but the read style is still decided once
  at construction rather than per read site, and the reader is still not a node,
  so `use` remains unavailable. It also invites `optimistic(() => api.list())`,
  which is broken for a closure reader: an unmemoized recipe hands `track` a
  fresh promise per read and never observes a settle.
- **Write the layer into the node** — rejected on the two measured defects
  above.
- **Drop the update form so `prev` cannot absorb a rival prediction** —
  rejected as a patch rather than a fix. The absorption came from a layer
  storing a value computed from a view that contained other layers, which
  `setView([...latest(view), x])` reaches just as easily. Scoping the read
  closes it at the source and keeps the ergonomic form.
- **Layers as updates, folded over the derivation** — not taken, per the
  last-write-wins consequence above. It is the design to revisit if composing
  concurrent predictions turns out to be wanted.
- **One node with two setters** (canonical and optimistic on the same tuple) —
  rejected. Canonical truth would be unobservable while a layer is live. The
  wrapped-node shape keeps both views available.

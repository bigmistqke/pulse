# Optimistic UI — speculation as deliberate tagged leakage

A scenario-first exploration of *optimistic* user interfaces in pulse:
patterns where the application wants to show speculative state to the
user immediately, tagged as provisional, before the underlying
operation (typically a server round-trip) confirms or rejects it.

This is the *visibility* slice of speculation — distinct from the
*concurrency* slice that [`concurrent-divergence.md`](./concurrent-divergence.md)
explores. Where the divergence doc asks "what happens when speculations
overlap on shared state?", this one asks "when does speculative state
become visible to consumers outside the speculation, and how do they
know it's not yet committed?"

This doc is exploration, not specification. Recommendations are
*current candidates*, subject to revision as implementation surfaces
new constraints.

**Companion documents:**

- [framings.md](./framings.md) — principles, especially [P4](./framings.md#p4--explicit-boundaries-over-implicit-pervasiveness)
  (explicit boundaries) and [P5](./framings.md#p5--compose-dont-proliferate-in-either-direction)
  (compose, don't proliferate) — both load-bearing here.
- [questions.md](./questions.md) — open questions registry.
- [concurrent-divergence.md](./concurrent-divergence.md) — companion exploration of speculation overlap.
- [scenarios.md](./scenarios.md) — TDD scenario catalog.
- [../async/CONTEXT.md](../async/CONTEXT.md) — research-arc lexicon; in particular [the four failure modes](../async/CONTEXT.md#the-four-failure-modes) (FM1 torn state, FM2 spinner flash) sit close to this question.

## Contents

- [The framing](#the-framing)
- [Patterns of optimistic UI in apps](#patterns-of-optimistic-ui-in-apps)
- [What "tagged leakage" entails structurally](#what-tagged-leakage-entails-structurally)
- [How existing frameworks approach this](#how-existing-frameworks-approach-this)
- [API shape design space](#api-shape-design-space)
- [Why the wrapper shape — a layering argument](#why-the-wrapper-shape--a-layering-argument)
- [Concurrent-overlay strategy](#concurrent-overlay-strategy)
- [Sub-questions still open](#sub-questions-still-open)
- [Tentative recommendations](#tentative-recommendations)

---

## The framing

The standard model of speculation is *snapshot isolation*: a
speculative scope's writes are invisible to readers outside the scope
until the scope commits. This is what pulse's chain-match
([Q1](./questions.md#q1--fall-through-and-edge-policy)) gives by
default — concurrent speculations are sealed off from each other and
from the outside world.

Optimistic UI deliberately violates that isolation, in a controlled
way. The pattern: an application wants the user to *see the result of
their action immediately* — the heart fills when the user clicks
"like", the comment shows new text the moment the editor blurs, the
file appears in the list the second the drop completes. The actual
server-side commit might take 200ms, 500ms, several seconds; the user
shouldn't have to wait to see their intent reflected.

But the value shown isn't yet committed — it might rollback if the
server rejects, the user navigates away, an offline sync fails. The
UI needs to know "this is provisional" so it can render appropriately
(subtle opacity, "saving..." badge, a small spinner, etc.).

The mental model: optimistic UI is **speculation that deliberately
leaks its value outside the speculation, tagged so consumers know
it's not committed yet**. The leakage is the entire point —
otherwise the user wouldn't see their action. The tag is what
distinguishes optimistic UI from outright commit: consumers know the
value might still revert.

This framing makes the design space sharper. Optimistic UI is not a
separate primitive grafted onto the reactive system; it's a *use of
speculation* with a specific visibility profile. Whatever mechanism
pulse provides should make that profile easy to express, easy to
consume, and impossible to misuse silently.

## Patterns of optimistic UI in apps

An inventory of recurring shapes that all want some form of "show the
predicted value, tagged as in-flight." Listed by what triggers the
optimism and what shape the rollback takes.

### Toggle-style optimism

**Like / unlike / follow / favorite.** User clicks a binary toggle.
UI flips immediately. Server confirms or rejects.

- *Display during in-flight:* the new state, often with no visible
  pending indicator (the action is short enough that flicker would
  be more distracting than the optimism is helpful).
- *Rollback shape:* a brief reverse-flip animation; sometimes a
  toast on error.
- *Frequency of concurrent flows:* rare (most users don't double-tap
  toggles); but rapid double-clicks should be handled gracefully.

### Edit-and-save optimism

**Comment editing, profile field update, settings change.** User
edits a value; UI shows the new value; save fires (often debounced);
server confirms.

- *Display during in-flight:* the new value, often with a "saving..."
  indicator next to or in the field.
- *Rollback shape:* revert to prior value; error toast; sometimes
  keep the user's edit in a "draft" state so they don't lose typing.
- *Frequency of concurrent flows:* moderate — a slow save can overlap
  with the next edit.

### Reorder / move optimism

**Drag-and-drop list reorder, kanban card move, file folder move.**
User drops; list rearranges visually; server confirms the new
position.

- *Display during in-flight:* the item in its new position; often
  with a subtle "syncing" badge on the moved item.
- *Rollback shape:* item snaps back to its prior position; possibly
  with explanatory toast.
- *Frequency of concurrent flows:* rare per-item, but multiple items
  being dragged in succession is a real pattern.

### Add-and-confirm optimism

**Comment posted, cart add, message sent, file uploaded.** User
performs an additive action; new item appears in a list; server
confirms; item gets a "real" ID.

- *Display during in-flight:* item visible immediately, often with
  a tentative styling (lighter background, small pending indicator).
- *Rollback shape:* item disappears (often with error toast); or
  remains in a "failed, retry?" state.
- *Frequency of concurrent flows:* common (chat apps where multiple
  messages can be in flight; cart additions in quick succession).

### Multi-step optimism

**Wizard flow, multi-step form, staged save.** Each step's data is
visible to the user for review across all steps; only the final
confirmation commits everything.

- *Display during in-flight:* each step's data shown; often with
  visual cue that "this is unsaved" applied to the whole flow.
- *Rollback shape:* cancel button discards all steps; navigating
  away may prompt for confirmation.
- *Frequency of concurrent flows:* low — wizards are typically
  user-serialized.

### Streaming optimism

**AI chat response, video transcoding progress, long-running
operation.** Output arrives incrementally; UI shows partial state;
final result lands when complete.

- *Display during in-flight:* the partial output, prominently shown
  (not subtle — this *is* the primary content), with explicit
  "generating..." cue.
- *Rollback shape:* on cancel, partial output discarded; on retry,
  starts over.
- *Frequency of concurrent flows:* moderate — chat with multiple
  pending messages; multiple uploads in parallel.

### Validation optimism

**Field-level server validation, async availability check.** User
types in a field; client-side validation passes immediately; a
server-side check runs in the background; result modifies the
field's validation state.

- *Display during in-flight:* the typed value, with a "checking..."
  spinner next to the field. The value is shown but treated as
  not-yet-verified.
- *Rollback shape:* server returns ✓ or ✗; field's validation
  state updates; on ✗, often retain the user's input with the error
  visible.
- *Frequency of concurrent flows:* high — every keystroke can trigger
  a new check; older checks are typically superseded.

### Local-first optimism

**Offline-capable app with eventual sync.** User edits locally; UI
shows the edit immediately as if it had committed; sync to server
happens in the background and may take seconds or minutes (or wait
for connectivity).

- *Display during in-flight:* the new value, often without prominent
  pending UI (because the user's perception is that local IS
  authoritative most of the time); sometimes a per-record sync-state
  badge.
- *Rollback shape:* on conflict, may surface a merge dialog (server
  vs local); on connectivity loss, retain local and retry
  indefinitely.
- *Frequency of concurrent flows:* very high — any local-first app
  has many in-flight syncs simultaneously.

### Background-driven optimism

**Polled refresh, websocket-pushed update, sync engine update.** The
*server* speculatively pushes a new value; the UI shows it
immediately; if a subsequent reconciliation discovers it was a stale
push or a misfire, it rolls back.

- *Display during in-flight:* new value visible; rarely a pending
  indicator (the user didn't initiate, so a "saving..." is
  misleading).
- *Rollback shape:* silently corrects; rare to surface to user
  unless the discrepancy is significant.
- *Frequency of concurrent flows:* common in real-time apps.

### Cross-cutting observations

Across these patterns:

- **The "tag" varies in prominence.** Toggle optimism may show no
  visible tag (the optimism is fast enough that any cue would be
  noise). Edit-and-save shows a small inline indicator. Streaming
  is *all tag* — the partial output IS the in-flight state.
- **The reader is usually the UI layer specifically.** Business
  logic, derivations, server-side rendering, analytics typically
  want the *canonical* value (last committed), not the optimistic
  one. The split between "what UI sees" and "what backend sees" is
  consistent.
- **Per-record / per-action optimism is more common than
  per-signal-wide optimism.** A list of comments, each with its own
  pending state; not "the whole comments collection is optimistic."
- **The lifetime of the optimistic state is bounded by the action
  that produced it** in most patterns. Local-first apps are an
  exception — optimistic state may live indefinitely while waiting
  for sync.

## What "tagged leakage" entails structurally

Stepping back from individual patterns: what does an optimistic-UI
mechanism need to support, structurally?

**(a) A way to write a value that's visible to outside readers
immediately.** Standard speculation doesn't do this — the chain-match
keeps writes isolated to the writing scope. Optimistic writes need a
side-channel that surfaces the value to consumers binding outside the
speculation.

**(b) A way for consumers to know the value is provisional.** Just
showing the predicted value isn't enough — the UI needs to render
differently (opacity, badge, spinner) based on whether the current
value is committed or in-flight. The provisional status has to be
queryable.

**(c) A way for the value to revert cleanly when the speculation
discards.** If the action fails, the optimistic value disappears and
consumers see the prior committed value. The revert is bounded by
the action's lifecycle.

**(d) A way for the value to settle into committed truth when the
speculation commits.** On success, the optimistic value either
becomes the committed value (auto-promotion) or the action separately
wrote the committed value (explicit). Either way, the "provisional"
tag clears.

**(e) Coexistence with normal speculation semantics for non-
optimistic signals.** Pulse's snapshot isolation between speculations
remains the default; optimistic UI is an *opt-in* affordance that
deliberately punches through that isolation for specific signals,
without changing the broader semantic contract.

The mechanism that satisfies all five is what the rest of this doc
is exploring.

## How existing frameworks approach this

For reference, not as authority. Each framework picked one shape;
none of them is obviously right for pulse, and each has known sharp
edges that pulse's design can learn from.

**React `useOptimistic`.** Per-component-instance hook:
`const [opt, setOpt] = useOptimistic(canonical, reducer)`. The
optimistic state is local to the component invocation; each component
that uses `useOptimistic` owns its own optimistic store. Concurrent
actions from different components don't interact. Within one
component, multiple `setOpt(action)` calls during one transition
reduce via the user-provided reducer.

- *Strength:* concurrent optimism is sidestepped by per-instance
  ownership; no overlay collision because there's no shared overlay.
- *Weakness:* doesn't fit pulse's model of signals as shared state.
  Pulse signals are *the* canonical reference for a value; multiple
  consumers bind to the same signal. Making the optimistic state
  per-consumer would require a different binding model.

**Solid 2.x `createOptimistic`.** Per-signal wrapper:
`const optimisticValue = createOptimistic(initial)`. The wrapper has
a single overlay slot (`_overrideValue`); writes set the slot;
*any* transition completing reverts the slot to the initial value via
`resolveOptimisticNodes`.

- *Strength:* mechanically simple; aligned with Solid's per-write
  lane model.
- *Weakness:* the overlay is shared globally; concurrent actions
  writing the same overlay collide silently; an early-committing
  transition can wipe a later transition's still-in-flight overlay.
  Solid users avoid this by scoping `createOptimistic` to specific
  components / operations and not sharing the optimistic primitive.
  See [`../async/deep-dives/solid-2x.md`](../async/deep-dives/solid-2x.md) Finding 2 for empirical
  verification of the reset-on-any-commit behaviour.

**Svelte 5.** No first-class optimistic API. Users typically
implement the pattern manually via signal mutations inside a `fork()`
batch and revert on rejection. The framework provides batch/fork
isolation but leaves the optimistic UX entirely to user code.

- *Strength:* unopinionated; doesn't constrain the user's pattern.
- *Weakness:* every app re-implements the same pattern; no canonical
  shape; idioms diverge across codebases.

**Common thread.** All three are doing something different
structurally, none is convergent on a single best practice, and each
has known edges. This is one of those areas where the field hasn't
settled — pulse has room to pick a shape that fits its own
principles.

## API shape design space

Four shapes considered during the exploration:

```ts
// Shape A — Wrapper signal (separate optimistic pair)
const [value, setValue] = signal(initial)
const [optimisticValue, setOptimisticValue] = optimistic(value)
action(function* () {
	setOptimisticValue(predicted)
	yield* postToServer(predicted)
	setValue(predicted)
})

// Shape B — Triple-tuple from signal()
const [value, setValue, setOptimisticValue] = signal(initial)
action(function* () {
	setOptimisticValue(predicted)
	yield* postToServer(predicted)
	setValue(predicted)
})

// Shape C — Per-write flag on the setter
const [value, setValue] = signal(initial)
action(function* () {
	setValue(predicted, { optimistic: true })
	yield* postToServer(predicted)
	setValue(predicted)
})

// Shape D — Separate write-walk function
const [value, setValue] = signal(initial)
action(function* () {
	setOptimistic(value, predicted)
	yield* postToServer(predicted)
	setValue(predicted)
})
```

All four can express the same behaviour. They differ in where the
optimistic dimension lives in the API surface.

### Shape comparison

| Shape | Where the optimistic dimension lives | Per-write flexibility | Surface size |
| --- | --- | --- | --- |
| A — wrapper | At signal-wrapping site (explicit `optimistic(...)`) | Yes (call either setter) | One extra primitive, one extra pair |
| B — triple-tuple | At signal-definition site (always present) | Yes (call either setter) | Bigger signal tuple |
| C — per-write flag | At each call site (options object) | Yes (pass option) | Smallest |
| D — separate walk | At each call site (separate function) | Yes (call either function) | Small (extra import) |

**Shape A** separates two reader handles — `value` (canonical only)
and `optimisticValue` (overlay-aware). The split makes the binding
intent lexically explicit: components bind to `optimisticValue` if
they want optimistic rendering, to `value` if they want canonical
truth.

**Shape B** flattens A into the base signal's tuple. Same semantics,
shorter at the binding site, but every signal pays the cost of having
an optimistic setter in its API surface even when unused.

**Shape C** uses an options object on the standard setter. Most
concise call site; intent is somewhat hidden behind an options key.

**Shape D** introduces a separate write-walk function, parallel to
read walks like `latest()` and `isPending()`. Most consistent with
pulse's existing API style (named walks operating on a node
reference); single signal definition; the optimistic setter is
imported as a library function.

### Where they diverge structurally

A is the only shape that produces *two distinct readers*. B/C/D all
produce one reader, which must always consult the overlay (overlay
if set, else committed). Under B/C/D, a consumer wanting
canonical-only would use `latest(value)` to bypass the overlay.

A's split readers make the optimistic-vs-canonical decision a
*signal-level architectural choice*: you decide at signal-creation
time which consumers should see optimistic vs canonical, and bind
each consumer to the appropriate reader.

B/C/D treat the optimistic-vs-canonical decision as a *consumer-level
read choice*: every consumer reads the same signal, and consumers
that care use a different walk for canonical-only.

## Why the wrapper shape — a layering argument

Of the four shapes, **A — the wrapper signal — is the strongest
candidate** for pulse, with reasoning that goes beyond surface
ergonomics.

**Signals are a general-purpose primitive; optimistic UI is a
narrow concern.** Most signals in a typical app don't need
optimistic affordances — business logic, derivation chains, state
stores, async coordination, server-side rendering values, analytics
counters, configuration flags. Adding `setOptimistic` to every
signal's API (shapes B/C/D) burdens the general case with a niche
concern. The signal API grows; the conceptual model gets less crisp.

Approach A keeps optimistic as a *wrapper* — opt-in at the
wrapper-creation site, invisible to consumers who don't need it. The
base signal stays minimal. The wrapper composes with the base for
the specific case where UI affordances matter.

**This aligns with two pinned principles:**

- **[P5](./framings.md#p5--compose-dont-proliferate-in-either-direction)
  (compose, don't proliferate):** `optimistic(value)` is composition
  — it wraps the base signal with an additional affordance, earns
  its keep when needed, doesn't pollute the base. Adding
  `setOptimistic` to every signal would be proliferation.
- **[P4](./framings.md#p4--explicit-boundaries-over-implicit-pervasiveness)
  (explicit boundaries over implicit pervasiveness):** the
  optimistic dimension is *declared* — `const [optimisticValue,
setOptimisticValue] = optimistic(value)` is a code-visible
  commitment that this signal participates in UI optimism. No
  implicit pervasiveness; if you read `value` directly, you only
  see committed truth.

The wrapper also makes the layering visible: there's a *general
signal layer* (`value`) and an *optimistic UI layer*
(`optimisticValue`) sitting on top. Consumers choose which layer
they're consuming. That matches how the data actually flows in
apps: backend logic reads canonical truth; UI components read the
optimistic view.

### What the wrapper does, structurally

```ts
const [value, setValue] = signal(initial)
const [optimisticValue, setOptimisticValue] = optimistic(value)
```

The `optimistic(...)` library helper sets up:

- A *reader* (`optimisticValue`) that returns the most-recent
  in-flight overlay value if present, otherwise the canonical
  committed value.
- A *setter* (`setOptimisticValue`) that, when called inside a
  speculative scope, writes an overlay layer keyed to the
  enclosing action's handle.
- A *cleanup* registered on the enclosing action's scope: when the
  action closes (commit or discard), the overlay layer for that
  action is removed.

The overlay is a side-channel separate from the underlying signal's
slot machinery — it doesn't go through the speculation's writeSet
or the chain-match. This is intentional: chain-match is for canonical
write isolation; the optimistic overlay is explicitly punching
through that isolation for the UI use case.

When the action commits, the committed write (`setValue(predicted)`
in the canonical pattern) goes through pulse's normal speculation
machinery — it lands in the action's writeSet and promotes to the
parent scope on action commit per
[Q10](./questions.md#q10--commit-semantics-ordering-atomicity-deferred-fires).
The overlay clears via cleanup. Consumers binding to
`optimisticValue` saw `predicted` throughout via the overlay; after
commit, they continue to see `predicted` via the canonical signal.

When the action discards, the overlay clears via cleanup. The
canonical signal's write was in the action's writeSet, discarded
with the action. Consumers binding to `optimisticValue` see the
pre-action value again.

### The query primitive

In addition to reading the value, consumers often need to know "is
this currently provisional?" — to render the opacity, badge, or
spinner.

```ts
hasOptimistic(optimisticValue)   // boolean: is there an active overlay?
```

This is a standalone query, parallel to pulse's existing
`isPending(node)`. It returns true while any action's overlay is
active on this optimistic signal; false when only the canonical
value is being read.

UI consumption looks like:

```tsx
<div
	style:opacity={() => (hasOptimistic(optimisticValue) ? 0.5 : 1)}
>
	{get(optimisticValue)}
</div>
```

The opacity binding is itself reactive — when the overlay activates
or clears, `hasOptimistic` re-evaluates and opacity updates. No
manual subscription management.

### The canonical action pattern

```ts
action(function* () {
	setOptimisticValue(predicted) // UI updates immediately
	yield* postToServer(predicted) // wait for confirmation
	setValue(predicted) // commit canonical truth
})
```

Inside the action body, two writes happen:

- `setOptimisticValue(predicted)` — writes the overlay. Visible to
  outside readers of `optimisticValue` immediately, tagged via
  `hasOptimistic`.
- `setValue(predicted)` — writes the canonical signal. Lives in the
  action's writeSet; commits to the parent scope on action success.

The pattern is explicit: the action author writes both the overlay
(for UI) and the canonical (for committed truth). This is the same
discipline Solid users follow with `createOptimistic` + a separate
canonical signal.

The footgun: forgetting `setValue(predicted)`. On action commit, the
overlay clears (cleanup fires), the canonical was never written, and
the consumer sees the pre-action canonical value. UI flickers back.

For v1, accept this discipline (matches Solid). If usage shows the
footgun bites often, ship an auto-promotion variant later:
`setOptimisticValue(v)` could optionally queue a commit-promotion of
`v` to the canonical signal on action success. Defer the variant
until evidence requires it.

## Concurrent-overlay strategy

What happens when two concurrent actions both write to the same
`optimisticValue`? Even if rare in real apps, the framework needs to
define behaviour for it.

### Survey of existing-framework answers

**Solid 2.x — flat overlay with reset-on-any-commit.** Single slot
per `createOptimistic` node. Whoever wrote last is visible. *Any*
transition completing reverts the slot to the initial value,
including a transition that didn't write the overlay. Concurrent
overlays collide silently; an early-committing action can wipe a
later action's still-in-flight overlay.

**React `useOptimistic` — per-component-instance.** Each component
that calls `useOptimistic` owns its own store. Concurrent actions
from different components don't interact (different stores). Within
a single component, dispatches reduce via user-provided reducer.
Concurrency on shared state is sidestepped by not sharing.

**Svelte 5.** No framework-defined behaviour for this case;
user-implementation territory.

**Nobody does FIFO.** It would be the wrong semantic — when two
actions race on the same optimistic value, the user typically wants
to see *the most recent intent*, not the oldest. FIFO would surface
stale state.

### Candidate strategies for pulse

**Strategy 1 — Solid-style flat overlay.** Single slot; last write
wins for display; cleanup-on-any-action-close clears the slot.
Sharp edge: an early-committing action wipes a later action's
overlay.

**Strategy 2 — Stack (LIFO, most-recent-wins, per-action cleanup).**
Each action's `setOptimisticValue` call pushes a layer onto a
per-node stack keyed by the enclosing action handle. The reader
returns the top of the stack (most recent live layer). Each
action's cleanup removes only *its* layer. If action A commits
while B is still in flight, A's layer pops but B's remains; the
reader still sees B. When B finishes, its layer pops; reader falls
back to the canonical signal.

**Strategy 3 — LWW with version stamping.** Each `setOptimistic`
writes the slot with a generation stamp. Cleanup only clears the
slot if the current generation is *its* generation. If someone else
wrote newer, the cleanup is a no-op. Same display semantics as the
stack in the common case; loses per-action visibility (an action's
overlay can be silently overwritten by a newer one before its
cleanup runs).

### Lean: Stack (Strategy 2)

The cleanest answer:

- *Predictable.* Most recent intent wins for display; each action's
  cleanup affects only its own layer.
- *No race conditions.* Cleanups are independent.
- *Matches user mental model.* "I see the most recent thing
  someone tried; when they finish, I see what's left."
- *Degrades gracefully to single-overlay.* When no concurrency
  happens (the common case), a stack with one entry behaves
  identically to a flat slot.

Implementation sketch:

```ts
function optimistic(committedSignal) {
	// per-node overlay stack — insertion order is iteration order in JS Map
	const overlays = new Map<ActionHandle, T>()

	function setOptimisticValue(v) {
		const handle = currentActionHandle()
		if (!handle) throw new Error('setOptimisticValue requires an action context')
		// remove + re-add to bump insertion order
		overlays.delete(handle)
		overlays.set(handle, v)
		onScopeClose(() => overlays.delete(handle))
	}

	const reader = compute(() => {
		if (overlays.size === 0) return get(committedSignal)
		// last entry inserted is the top of the stack
		let last: T | undefined
		for (const v of overlays.values()) last = v
		return last
	})

	return [reader, setOptimisticValue]
}

function hasOptimistic(reader): boolean {
	// (implementation detail: introspect the reader's underlying overlays Map)
}
```

This is library code — no engine-level support is needed. The
overlay's writes don't go through the action's writeSet or the
chain-match; they're side-channel state managed by the wrapper.

The cleanup-on-scope-close uses the standard `onCleanup` /
scope-close machinery from [Q6](./questions.md#q6--what-is-a-scope-as-a-value)
([Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)
covers when cleanups fire — discard only by default, but the optimistic
wrapper wants its cleanup to fire on *both* commit and discard, so
the wrapper registers the cleanup via the appropriate hook).

A small open sub-question: pulse's scope cleanups currently fire on
discard only (Q12). The optimistic wrapper's cleanup needs to fire
on both commit and discard. Either the wrapper uses a different
hook (a hypothetical `onScopeClose` distinct from `onCleanup`), or
the wrapper registers both an `onCleanup` (for discard) and an
on-commit hook (TBD). This is a small library-side wiring decision
that surfaces a real gap in pulse's current cleanup primitives.

## Sub-questions still open

The wrapper shape is the load-bearing decision. Other sub-questions
can be settled when implementation forces them:

- **Auto-promotion variant.** Should `setOptimisticValue(v)` auto-queue
  a commit-promotion of `v` to the canonical signal on action
  success, eliminating the "forgot to call `setValue`" footgun?
  Default: explicit dual-setter (Solid-style discipline). Sugar
  layer: `setOptimisticValue(v, { autoCommit: true })` or a
  separate variant for the auto-commit case.
- **Reader API richness.** Should the reader return bare value plus
  separate `hasOptimistic` query, or a tagged value
  `{value, status}`? Lean: bare + separate query (matches pulse's
  `get` + `isPending` pattern).
- **Naming.** `optimistic` / `preview` / `tentative` / `speculative`
  / `pending`? Cosmetic; defer until ergonomic feedback.
- **Cleanup-on-commit-and-discard.** The wrapper needs its cleanup
  to fire on both. Pulse's scope cleanups currently fire on discard
  only ([Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)).
  Solving this surfaces a small gap that other library patterns
  (auto-save indicators, progress UI) may also need.
- **Multiple action-handle representation.** Should
  `getOptimisticSource(optimisticValue)` return the action handle
  that wrote the current top-of-stack overlay? Useful for UI that
  wants to surface which action is in flight (e.g., a list of
  pending operations). Defer.
- **Local-first / long-lived optimism.** The "patterns" survey
  includes local-first apps where optimistic state might live for
  minutes or indefinitely (waiting for connectivity). Does the
  same wrapper shape work, or does long-lived optimism need a
  different mechanism? Defer; revisit when local-first patterns
  are concretely in scope.
- **Per-record vs per-collection optimism.** The patterns survey
  notes per-record optimism is more common than per-collection. The
  wrapper applies to a single signal; per-record patterns build
  composite structures (a collection where each record is its own
  optimistic signal). No framework change needed; library patterns
  on top.

## Tentative recommendations

**1. Adopt the wrapper shape (A).** `optimistic(committedSignal)`
returns `[optimisticValue, setOptimisticValue]`. The optimistic
dimension lives at the wrapper-creation site; consumers bind to
either `value` (canonical) or `optimisticValue` (overlay-aware)
depending on their use case.

**2. Stack-based overlay for concurrent actions.** A per-node
overlay map keyed by action handle; reader returns the most-recent
live layer; each action's cleanup removes only its layer.

**3. Separate query primitive.** `hasOptimistic(optimisticValue)`
returns boolean; consumers wire reactive UI bindings against it.

**4. Explicit dual-setter pattern by default.** Action author writes
both `setOptimisticValue` (overlay) and `setValue` (canonical).
Accepts the "forgot to write canonical" footgun for v1; ship
auto-promote variant later if usage shows it's needed.

**5. No engine-level changes required.** The wrapper, the overlay
stack, and the query primitive are all library code on top of pulse's
existing scope + cleanup primitives. The one small dependency: a
cleanup hook that fires on *both* commit and discard (which pulse
doesn't currently have; small addition to the scope API).

**6. Revisit when usage data exists.** These recommendations are
informed by scenario reasoning and existing-framework survey, not
by usage data. Once pulse ships and apps are built, the wrapper's
ergonomics may need refinement (the auto-promotion variant, richer
queries, naming) but the architectural commitment (optimistic as a
wrapper, not a base-signal feature) is the load-bearing one.

The crux: optimistic UI is a *UI concern* layered on top of the
general signal primitive. Keeping the layering explicit — via the
wrapper rather than baking optimism into every signal's API — keeps
the base primitive minimal and makes the UI affordance opt-in,
which matches the principle direction
([P4](./framings.md#p4--explicit-boundaries-over-implicit-pervasiveness) +
[P5](./framings.md#p5--compose-dont-proliferate-in-either-direction))
that pulse has already pinned for related decisions.

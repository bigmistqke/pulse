# Concurrent divergence — scenarios first, affordances second

A deep exploration of what happens when multiple speculations are
in flight at the same time and touch overlapping state. Organized
**scenarios → intent → affordance** (rather than API → analysis),
because the API can't be picked sensibly without first understanding
which intents need to be served and which are conflated.

This doc is exploration, not specification. The goal: build a survey
of the concrete situations users will hit, identify the user's intent
in each, then derive the minimum API surface that lets each intent be
expressed.

**Companion documents:**

- [framings.md](./framings.md) — principles ([P1](./framings.md#p1--speculation-is-one-concept-with-two-faces)–[P6](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush)).
- [questions.md](./questions.md) — open questions; [Q15](./questions.md#q15--entanglement-dim-4-overlapping-speculations-on-shared-state) is the stub this doc explores.
- [scenarios.md](./scenarios.md) — pulse's TDD scenario catalog (A–R).
- [scenario-traces.md](./scenario-traces.md) — verified worked traces.
- [../async/CONTEXT.md](../async/CONTEXT.md) — research-arc lexicon; [the four dimensions of transition](../async/CONTEXT.md#the-four-dimensions-of-transition); this doc is Dim 4.
- [../async/deep-dives/solid-2x.md](../async/deep-dives/solid-2x.md) — Solid 2.x's lane-merge mechanism for the same problem space.

## Contents

- [What pulse does for free](#what-pulse-does-for-free)
- [The scenario space](#the-scenario-space)
- [A — Same-target, replacement semantics](#a--same-target-replacement-semantics)
- [B — Same-target, accumulation semantics](#b--same-target-accumulation-semantics)
- [C — Same-target, precedence semantics](#c--same-target-precedence-semantics)
- [D — Read-dependent writes](#d--read-dependent-writes)
- [E — Multi-step transactions](#e--multi-step-transactions)
- [F — Supersession (newer invalidates older)](#f--supersession-newer-invalidates-older)
- [G — Independent flows that share a downstream dep](#g--independent-flows-that-share-a-downstream-dep)
- [H — True collaboration](#h--true-collaboration)
- [Cross-scenario observations](#cross-scenario-observations)
- [Affordances, derived bottom-up](#affordances-derived-bottom-up)
- [What we genuinely don't know yet](#what-we-genuinely-dont-know-yet)
- [Tentative recommendations](#tentative-recommendations)

---

## What pulse does for free

Before walking scenarios, pin down the baseline so each scenario can be
described in terms of what's *already* handled vs what's *added* by the
scenario:

- **Snapshot isolation between sibling scopes during their lifetime.**
  Reads inside `S1` never see writes inside `S2`. Chain-match
  ([Q1](./questions.md#q1--fall-through-and-edge-policy)) skips writes
  whose scope isn't in the reader's chain.
- **Last-commit-wins on overlapping writes.** Two siblings both write
  `X`; whichever commits second overwrites. Falls out of writeSet
  promotion ([Q9](./questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally)
  + [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)).
- **Render coherence.** Microtask batching + deferred-fires region
  ([P6](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush) +
  [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires))
  collapses multiple invalidations of the same consumer to one re-run.
- **Transactional coupling via nested actions.** `action(() => {
  a(); b() })` makes `a` and `b` commit-together; the outer action's
  scope is the commit boundary.
- **Explicit supersession.** Holding an action handle lets you call
  `.discard()` on a prior in-flight action when a newer one arrives.

Each scenario below describes what happens under these defaults and
what (if anything) is missing.

## The scenario space

Eight classes. Each is grounded in a concrete app pattern, not a
mechanism. The classes are organized by the *user's intent*, not by
the mechanism that would serve it.

---

### A — Same-target, replacement semantics

**The pattern.** Two actions writing the same signal where each write
is meant to be a *replacement* — the newer write supersedes the older.

**Concrete cases:**

- A1. **Like/unlike race.** User clicks the heart icon twice rapidly.
  Both clicks fire as actions. Each sets `liked = !current`.
- A2. **Form field debounced save.** User types in a name field;
  every keystroke fires a debounced save. The most recent value
  is the one to persist.
- A3. **Multi-click submit.** User mashes a submit button before the
  first click's response returns.
- A4. **Toggle settings.** Quick on/off switching.

**Under pulse default:**

```ts
const like = action(function* () {
	const next = !get(liked)
	setLiked(next)
	yield* postToServer(next) // async
})

// double-click:
like() // sets liked = true (computed from snapshot liked = false), POST returns 200ms
like() // sets liked = false (snapshot still false from S1; S1 hasn't committed)
```

Both actions see `liked = false` at their start (snapshot isolation).
Both compute and write their own values. Whichever commits last wins.
For toggle-like cases, this is *usually* what the user wants — the
final click's intent is the truth.

**Problem:** A1 and A4 are typically fine because the user's intent
matches "newest wins." A2 and A3 are subtly broken: the user's first
write might have been based on a value the second hasn't yet computed
against (subjectivity around what "first" means when both started at
the same snapshot).

**Intent:** "the most recent user action is the truth." Last-wins is
correct in spirit; the subtle wrongness is mostly about timing
expectations, not semantics.

**Affordance needed:** none beyond default. Maybe a `.discard()` on
in-flight prior actions when a new one starts (supersession — see F).

**Status:** ✓ handled by pulse default.

---

### B — Same-target, accumulation semantics

**The pattern.** Two actions whose writes are *operations* (deltas)
on the same signal, not replacements. The intent is for both
operations to apply.

**Concrete cases:**

- B1. **Counter increment.** Each click fires `setCount(get(count) +
  1)`. User clicks twice rapidly.
- B2. **Append to log / list.** Each action does `setLog([...get(log),
  newEntry])`.
- B3. **Cart add-item.** User clicks "add to cart" rapidly on two
  different items; cart should contain both.
- B4. **Vote / reaction tally.** Each user-action contributes a delta;
  all should accumulate.

**Under pulse default:**

```ts
const increment = action(function* () {
	setCount(get(count) + 1) // read snapshot, compute, write
	yield* postIncrementToServer()
})

increment() // S1: snapshot count=0, writes count=1
increment() // S2: snapshot count=0, writes count=1 (S1 hasn't committed)
// S1 commits: count=1
// S2 commits: count=1 (overwrites; should have been 2)
```

**The default loses one of the increments.** This is the classic
"compute-from-stale-read" problem.

**Intent:** "every action's contribution should land." For B1, total
should be 2 not 1. For B2, log should have both entries.

**Affordances that serve this:**

- **CRDT-style signal value.** Counter is a special signal type whose
  value composes (e.g., a counter that increments). Two concurrent
  increments produce the same total regardless of order. *Library
  pattern, not engine; user lifts state into a CRDT type.* Strongest
  answer for B1, B4. Doesn't help for B2 (list append could be modeled
  as a Yjs array, but that's a library choice).
- **Rebase-on-conflict.** Action body re-executes against
  post-commit state. For B1, the rebase re-reads `count = 1`,
  computes `count + 1 = 2`, writes 2. Works if the body is pure;
  catastrophic if it has side effects (re-fires the POST).
- **Optimistic concurrency rejection with retry loop in user code.**
  Action throws on conflict; user-level wrapper catches and retries.
  Same effect as rebase but the user-level loop can decide to
  *not* re-run the side effect (e.g., re-issue only the local
  write, not the POST). More control, more boilerplate.

**Status:** ✗ not handled by pulse default. Class B is the strongest
case for some kind of additional affordance, but the right answer
depends on whether you want CRDT types (best for B1/B4), rebase
(best for B2/B3 in some shapes), or user-level retry (best for cases
with side effects).

---

### C — Same-target, precedence semantics

**The pattern.** Two actions touching the same signal where the
application has a *known precedence*: one source of writes should
"win" over another based on the kind of action it is, not on
timing.

**Concrete cases:**

- C1. **User-edit vs background-refresh.** User edits a comment in
  the UI (action U). A background poll fetches the latest from the
  server (action R). U should win — never overwrite the user's
  in-flight edit with a server fetch.
- C2. **Local optimistic vs server authoritative.** Action L
  optimistically updates UI. Action S receives server confirmation.
  S should overwrite L on success; L should remain on failure.
- C3. **Foreground user-action vs background sync.** Two background
  sync passes might overlap; the foreground action should always
  win regardless of timing.

**Under pulse default:**

```ts
const edit = action(function* () {
	setComment({ body: typed, edited: true })
	yield* postEdit() // 500ms
})
const refresh = action(function* () {
	const latest = yield* fetchLatest() // 200ms
	setComment(latest) // overwrites user edit if it commits first or after
})

edit() // S_U opens
refresh() // S_R opens
// S_R commits → ROOT.comment = server's version
// S_U commits → ROOT.comment = typed (overwrites server; correct outcome by
//                                     accident, but only because edit committed last)
```

The default *might* produce the correct outcome by luck of timing, but
it's the wrong mechanism. If `refresh` happens to commit *after*
`edit`, the user's edit is silently lost.

**Intent:** "Action U has precedence over action R for signal `comment`,
regardless of timing."

**Affordances that serve this:**

- **Application-level coordination.** Refresh checks "is edit in
  flight?" before committing; if yes, skips its write. Requires a
  `.status` query on action handles. Pulse handles already expose
  this ([Q6](./questions.md#q6--what-is-a-scope-as-a-value) /
  [Q14](./questions.md#q14--action-prereqs--standing-state-handle));
  the user wires it up.
- **Cancel the lower-precedence action.** When edit starts, discard
  any in-flight refresh. Solved by `.discard()` on handles.
- **Per-action `'reject'` policy on refresh.** Refresh's commit
  throws if `comment` has been written-to during its lifetime; the
  refresh action's wrapper catches and ignores. Less direct but
  works.

**Status:** ⚠ pulse default doesn't enforce precedence, but the
application has all the pieces to coordinate (handle status,
`.discard()`). Documenting the pattern + maybe a small helper
(`action(body, { yields_to: [otherHandle] })`?) would smooth this.

---

### D — Read-dependent writes

**The pattern.** An action reads state X to decide what to write to Y.
If X changes during the action's flight, the write to Y was based
on stale information.

**Concrete cases:**

- D1. **Conditional update.** "If user is logged in, increment
  `userVisits`." Action reads `loggedIn`, then writes
  `userVisits`. If `loggedIn` changes mid-flight, the action's
  premise is invalid.
- D2. **Validation against current state.** "Save this form only if
  no other validation errors exist." Action reads `errors`, then
  decides to save. If `errors` is mutated during the action, the
  save shouldn't proceed.
- D3. **Compute-from-state.** "Compute discount as a function of
  cart total and user tier." Action reads both, computes, writes
  discount. If either changes during compute, the discount is
  stale.

**Under pulse default:**

The read returns the snapshot value (the value at the moment of read,
isolated from other actions' writes). The subsequent write commits
with `last-wins` semantics. So:

- D1: the action's write to `userVisits` will be based on the snapshot
  view of `loggedIn`. If `loggedIn` flipped to `false` in committed
  state mid-flight, the action still writes `userVisits` — which is
  semantically wrong.
- D2: same — save proceeds even if other errors landed mid-flight.
- D3: same — discount is stale.

**Intent:** "if the state I based my decision on has changed, abort
or redo." Classic optimistic concurrency control.

**Affordances that serve this:**

- **`'reject'` policy.** At commit, check if any signal in
  `S.readSet ∪ S.writeSet` has been committed-to since `S` started.
  If yes, throw. Caller catches; retries with current state, gives
  up, or surfaces to user.
- **Rebase policy.** Re-execute the body. Works for D3 (pure
  compute); risky for D1/D2 (might have other side effects).
- **Manual version checking.** Action body queries
  `latest(loggedIn)` at commit time and asserts. Verbose; doable
  with current primitives but ugly.

**Status:** ✗ not handled by default. Class D is the canonical case
for `'reject'` — small, well-understood mechanism, big payoff.

---

### E — Multi-step transactions

**The pattern.** Multiple coordinated writes that must succeed or
fail as a unit.

**Concrete cases:**

- E1. **Two-phase save.** Action saves a draft (write metadata, then
  write content). Both must commit or neither.
- E2. **Coordinated batch.** Update three related signals atomically
  (transferring money: debit account A, credit account B, log
  transaction).
- E3. **Compensating transaction.** Step 1 succeeds; step 2 fails;
  step 1 must be rolled back.

**Under pulse default + nested actions:**

```ts
const transfer = action(function* () {
	yield* debit(from, amount)
	yield* credit(to, amount)
	yield* logTransaction(from, to, amount)
})
```

If any step throws, the outer action's body throws → outer scope
discards → all sub-action writes (which had promoted to the outer
scope, not yet to ROOT) are dropped together. **Transactional
coupling falls out of nested actions for free.**

**Intent:** "these writes are a unit; commit together or roll back
together."

**Affordances:** nested actions cover this. No new mechanism needed.

**Status:** ✓ handled by nested actions
([Q15](./questions.md#q15--entanglement-dim-4-overlapping-speculations-on-shared-state)
discussion).

---

### F — Supersession (newer invalidates older)

**The pattern.** A newer intent arrives while an older one is in
flight; the older should be cancelled.

**Concrete cases:**

- F1. **Search box typing.** User types "foo"; that fires a search
  action. User types "foob"; older search should be cancelled.
- F2. **Route navigation.** User clicks link to /page-a; that fires
  a load action. User clicks /page-b; older load should be cancelled.
- F3. **Autosave with rapid edits.** Older save in flight; newer
  edit triggers a newer save; older save should be cancelled.
- F4. **Retry after failure.** Action failed; user clicks retry;
  the failed-action's residue should be cleaned up before the new
  attempt starts.

**Under pulse default + handles:**

```ts
let currentSearch: ActionHandle | null = null
function search(query) {
	currentSearch?.discard()
	currentSearch = action(function* () {
		const results = yield* fetchSearch(query)
		setResults(results)
	})
}
```

Explicit `.discard()` handles supersession cleanly. Action handles
expose `.status` and `.discard()`; user-level wrapper coordinates.

**Intent:** "I supersede the prior; cancel it." User-level pattern.

**Affordances:** `.discard()` on action handles. Already covered by
[Q6](./questions.md#q6--what-is-a-scope-as-a-value)'s action-handle API.

**Status:** ✓ handled by `.discard()` + user-level coordination.

**Note:** Solid does this implicitly via `_inFlight` identity-
supersession (a newer write to the same signal silently drops the
older async's result). Pulse's explicit `.discard()` is more visible
but requires the user to track handles. Either model is defensible;
pulse's is more honest about what's happening.

---

### G — Independent flows that share a downstream dep

**The pattern.** Two actions writing *different* signals that happen
to share a downstream computed or consumer.

**Concrete cases:**

- G1. **User updates name (action U); background updates lastSeen
  (action B).** Both invalidate `<UserBadge>` somewhere because it
  reads both.
- G2. **Foreground form save; background analytics push.** Different
  signals; share a downstream "any pending writes?" indicator.

**Under pulse default:**

Each action writes its own signal. Chain-match fires the consumer
for each separately. Microtask batching ([P6](./framings.md#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush))
collapses both invalidations of the consumer into one re-render per
microtask. The two actions commit independently when each finishes.

**This is correct.** The actions are independent; they should
commit independently; render coherence is handled by batching.

**Intent:** "these are independent; don't couple them."

**Affordances:** none needed. Pulse default is right.

**Status:** ✓ handled by pulse default.

**Note:** This is the case where **Solid's auto-merge does the
WRONG thing.** Solid welds the two unrelated actions because they
share a downstream sub. Discarding one drags the other along.
Pulse's explicit-only entanglement (nested actions) avoids this
spooky merging.

---

### H — True collaboration

**The pattern.** Multiple users or processes modifying the same
shared state across a network or process boundary.

**Concrete cases:**

- H1. **Collaborative document editing.** Two users typing in the
  same shared doc.
- H2. **Offline-first sync.** User edits locally while offline;
  server has its own concurrent edits; on reconnect, reconcile.
- H3. **Multiplayer game state.** Multiple clients update positions;
  server arbitrates.

**Under pulse default:**

Out of scope. Collaboration is a *data layer* concern, not a
reactivity concern. Pulse's reactivity propagates whatever the data
layer produces.

**Intent:** "this state is shared across processes; conflict
resolution lives in the data type or at the server."

**Affordances:** CRDT data types (Yjs, Automerge) as signal values.
Server-replay patterns (Replicache) as application architecture.
Pulse does *not* try to solve this at the reactivity layer.

**Status:** ✓ correctly out of scope.

---

## Cross-scenario observations

Taking the survey as a whole, a few patterns emerge.

**Pulse's default behaviour is correct for A, E, F, G, H** (with
appropriate user-level patterns for F/G). It handles **five of the
eight classes** without any new mechanism.

**Pulse's default is wrong for B, C, D.** Each of these needs *some*
affordance beyond last-wins:

- B (accumulation): mostly solved by CRDT-style signal values; some
  cases want rebase, but rebase has sharp footguns.
- C (precedence): solved by application-level coordination using
  existing action-handle queries + `.discard()`. Maybe sharpened by
  a "yields-to" sugar.
- D (read-dependent writes): the canonical case for `'reject'` policy.

**The single most impactful addition** is `'reject'` for class D.
It's a small mechanism (per-slot version counter; read-aware
snapshot version) that addresses the genuinely-unaddressed case
(optimistic concurrency) cleanly.

**Class B's right answer is mostly NOT a framework feature.** CRDT
data types live in user code (the signal's value type). The
framework just propagates changes; it doesn't need to know the
value composes. Rebase as a framework feature has too many footguns
to be a default; it's possibly a power-user opt-in but probably
shouldn't be in the first cut.

**Class C's right answer is also mostly NOT a new framework feature.**
The application coordinates via existing handle queries
(`handle.status`, `handle.pending`) and existing primitives
(`.discard()`). Maybe a small helper that wraps the common case
("action U yields to in-flight action R") is worth shipping as
sugar, but it's not a primitive.

**Solid's auto-merge actively hurts class G.** This is the strongest
argument against picking Solid's mechanism: it provides automatic
coupling that's wrong as often as it's right. Pulse's explicit-only
coupling (via nested actions) doesn't have this failure mode.

**The `_gatedSubs` cross-tx read replay machinery (Solid's other
piece) addresses a real gap not covered by any of the eight scenarios
directly** — it's about "consumer was re-running under one scope's
context and read a committed value during another scope's commit
window; should re-fire when the committing scope lands." This is
more of a render-coherence question than a divergence question.
Worth its own treatment but separable from the divergence question.

## Affordances, derived bottom-up

From the eight classes, the minimum affordance set:

**1. Default last-commit-wins** (current).

Serves A and is the right default for cases where the user doesn't
specifically need anything else.

**2. Nested actions for transactional coupling** (current via Q6).

Serves E. `action(() => { a(); b() })` makes a and b commit together.

**3. `.discard()` + handle status queries** (current via Q6 / Q14).

Serves F. User wires up cancellation when a newer intent arrives.

**4. `'reject'` policy on action creation** (NEW).

```ts
action(body, { onConflict: 'reject' })
```

Serves D. At commit time, if any signal in `S.readSet ∪ S.writeSet`
has been committed-to since `S` started, throw a `ConflictError`.
The caller catches and decides what to do. Cheap implementation
(per-slot version counter; snapshot version at first read/write;
compare at commit).

Read-aware (using `S.readSet`) rather than strict-write because the
read-aware definition matches actual correctness needs (D's whole
point is "my write was based on a read that's now stale").

**5. CRDT-style signal values as a library pattern** (NEW as
documentation, not as primitive).

Serves B1, B4. Signals whose value is a counter or a CRDT register
compose under concurrent writes by construction. No framework
mechanism; just guidance on signal value types when accumulation
matters.

**6. `yields_to` / precedence sugar** (MAYBE).

Sugar over (3) for the common Class C pattern. Optional; the
unsugared pattern is short. Defer until friction surfaces.

**That's it.** Five affordances cover the realistic intent space
identified by walking the scenarios. Of these, only #4 is a genuinely
new primitive. The rest are already pinned or are documentation /
library patterns.

**Explicitly NOT in the affordance set:**

- **`'rebase'` policy.** Use cases (B2, B3, some D3 variants) are
  better served by CRDT signal values or by user-level retry loops
  that don't re-execute side effects. Rebase's footgun (re-running
  side effects) outweighs its benefit.
- **Per-action merge callbacks.** Use cases are better served by
  signal-value-level merge (CRDT). Per-action callbacks would
  spread merge logic across the codebase and require per-conflict
  decisions; the wrong layer.
- **Auto-detection / dev-time warnings on overlap.** The scenario
  walk shows that overlap is often *intended* (A, E) and that
  warnings would create noise. Better to let the user opt into
  `'reject'` where they care.
- **Solid-style auto-merge.** Wrong for class G; redundant for E
  (nested actions cover it explicitly); doesn't solve C or D.

## What we genuinely don't know yet

- **Are there scenario classes the survey missed?** The eight feel
  comprehensive but might not be. Especially worth checking: real
  app patterns from production codebases that don't fit any of A–H.
- **How often does class D actually bite?** In the apps where pulse
  would be used (interactive UI), how often is a read-then-write
  with concurrent writes a real correctness bug vs a theoretical
  one? Without usage data we can't tell. If it's rare, `'reject'`
  becomes a "nice to have"; if it's common, it's load-bearing.
- **Does class C need sugar, or is the unsugared pattern fine?**
  Depends on how often class C arises and how repetitive the
  coordination boilerplate becomes.
- **Is there a clean way to express CRDT-style values in pulse
  signals?** The signal's value type can be anything, but the
  reactive layer would need to know not to "replace" but to "merge"
  when commits happen. Or the signal-value type itself handles
  composition externally (the framework just sees the new value
  and propagates). The latter is simpler; the former might be more
  ergonomic.
- **Does the `_gatedSubs` analogue matter for pulse's use cases?**
  Pulse's chain-match + microtask batching may already cover the
  practical version. Need to find a concrete failing scenario
  before adding machinery.

## Tentative recommendations

Per the scenario walk, the *minimum* honest answer is:

**1. Keep current defaults.** Last-wins, snapshot isolation,
microtask batching, nested actions for coupling, `.discard()` for
supersession. These handle A, E, F, G, H.

**2. Add `'reject'` as the one new policy.** Per-slot version
counter (engine, trivial); `S.snapshotVersions: Map<Node, number>`
recorded at first read or write (library or engine, small);
commit-time check; throws `ConflictError` if any signal's committed
version exceeds the snapshot version.

**3. Document the CRDT-signal-value pattern** as the answer for
class B. Provide an example (counter signal, set signal) without
making it a framework primitive.

**4. Do not ship `'rebase'`, merge callbacks, or auto-merge.** The
scenario walk doesn't justify them; they have known footguns.

**5. Treat the `_gatedSubs` cross-tx read replay question as
separate** — possibly its own Q after Q15 if a concrete failing
scenario surfaces.

**6. Revisit when the library exists** — these recommendations are
informed by scenario reasoning, not by usage data. Once pulse ships
and apps are built, the affordance set may need extending or
trimming. The minimal ship-set is correct *as a starting point*,
not as a final spec.

The crux of the original question — "what about Solid's lane merge?"
— resolves cleanly: lane merge bundles four concerns (render
coherence, transactional coupling, cross-tx read, conflict
resolution) into one mechanism. Pulse disaggregates: render coherence
is automatic (P6 + Q10), coupling is explicit (nested actions),
cross-tx read is a separable open question, conflict resolution is
opt-in per-action (`'reject'`). Smaller pieces, each addressing one
intent, none with the spooky-merging failure mode.

# Isolate speculations by default; couple explicitly

When two concurrent speculations touch the same state, pulse **isolates**
them: each writes into its own scope-tagged slot, siblings do not see each
other's uncommitted writes (snapshot isolation), and overlap resolves
last-commit-wins. This falls out of the existing machinery — multi-slot-per-
Node ([Q1](../pulse/questions.md#q1--fall-through-and-edge-policy) /
[Q9](../pulse/questions.md#q9--read-populated-vs-write-populated-slots-do-they-differ-structurally))
plus chain-match — for free; it is not an added feature. pulse does **not**
auto-merge overlapping speculations the way Solid's union-lane merge does.
Coupling, when wanted, is **explicit and structural** (nested actions);
conflict detection, when wanted, is **opt-in** (`onConflict: 'reject'`).

This is deliberate, for three reasons:

- **Isolation is what gives atomicity its bite.** If speculation A's writes
  were visible to B, and B built on them, A's discard could not cleanly undo —
  B has already read and acted on a value that no longer exists
  (cascade-discard). Shared visibility makes discard uncomposable; isolation
  keeps commit/discard atomic by construction.
- **Auto-merge false-couples.** Solid merges two speculations the moment they
  reach a shared subscriber — even when the sharing is incidental (two
  unrelated flows that happen to feed one downstream computed). Their fates
  then join: one failing can roll back the other. Isolation never does this.
- **The common case is isolation.** The scenario survey in
  [`concurrent-divergence.md`](../pulse/concurrent-divergence.md) catalogues far
  more legitimate *isolation* requirements than *combination* ones. For UI
  state, unrelated concurrent flows are common and genuine
  shared-visibility-with-independent-commit is rare. So isolate is the correct
  cheap default; combination is the opt-in.

The underlying bet: **making the rare coupling case explicit beats making the
common case silently wrong.** Merge-by-default risks spooky, hard-to-debug
coupling of unrelated flows; isolate-by-default fails toward a visible, local
"I have to wire this coupling myself."

## Considered alternatives

- **Solid-style union-lane auto-merge** — rejected. Beyond the false-coupling
  and cascade-discard problems above, it solves a problem pulse does not have:
  a Solid computation belongs to one lane, so two lanes colliding at a node are
  irreconcilable without fusing. pulse's multi-slot-per-Node gives each scope
  its own slot for a node, so overlapping speculations never collide — there is
  nothing to merge. The "peek at each other" Solid's merge produces is an
  emergent symptom of its storage model, not a feature to port. (See the
  [Scope-does-two-jobs aside](../pulse/concurrent-divergence.md#a-conceptual-aside--scope-is-doing-two-jobs).)
- **`'rebase'`, merge callbacks, auto-merge** — rejected per the
  `concurrent-divergence.md` scenario walk; each has known footguns and none is
  justified by the surveyed patterns.

## Consequences

- **Coupling is opt-in and visible.** Two speculations share fate only if you
  nest them (`yield*` one inside another); the coupling is legible in the code,
  not inferred at runtime.
- **Conflicts need opt-in `'reject'`.** A read-dependent write whose premise
  goes stale is not caught by default; the action opts into
  `onConflict: 'reject'` (traced in
  [D1](../pulse/scenario-traces.md#d1--read-dependent-write-under-reject)),
  which composes with [ADR 0002](./0002-pending-model.md) /
  [`failure.md`](../pulse/failure.md#1-discard-cause-categorization)'s
  discard-cause taxonomy as `kind: 'conflict'` for retry-based recovery.
- **Redundant recomputation on overlap.** Two isolated speculations that both
  read the same expensive derived compute it once each (one slot per scope).
  This is the cost paid for isolation; the scenario survey suggests overlap on
  expensive deriveds is rare.
- **Combining overlapping in-flight async is a rendering concern, not a merge.**
  The legitimate "show two overlapping async edits as one coherent frame" want
  is served by a consumer-side rendering barrier (`settled([...])` on
  stale-while-revalidate,
  [`async-reads-and-coordination.md`](../pulse/async-reads-and-coordination.md)),
  which keeps the edits independent — not by merging speculations.
- **Forfeits Solid's best-in-class Dim-4 auto-merge.** Deliberately. If an app
  is genuinely shaped around dynamically-overlapping independent async
  speculations wanting one combined committed result, Solid's model fits it
  better; pulse judges that shape rare enough not to justify the cost imposed
  on every other overlap.

The full exploration behind this decision — the scenario classes, the prior-art
lineage (optimistic concurrency control / serializable snapshot isolation / STM
/ CRDT), and the affordances derived bottom-up — is in
[`../pulse/concurrent-divergence.md`](../pulse/concurrent-divergence.md), with
[Q15](../pulse/questions.md#q15--entanglement-dim-4-overlapping-speculations-on-shared-state)
as the registry entry.

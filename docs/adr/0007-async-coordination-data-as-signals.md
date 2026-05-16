# Async Coordination: Data-as-Signals over Transitions Runtime

pulse needs an answer to the problem set Solid 2.x addresses with its
transitions-first runtime: per-mutation pending state, refresh /
invalidation after server writes, atomic reveal across multiple writes,
optimistic UI, and group cancellation. The naïve interpretation is that
pulse should ship a transitions primitive matching Solid 2.x's. The
chosen position is the opposite: **pulse does not build a transitions
runtime**. Instead, the reactive graph itself, applied to a "data lives
in signals" pattern, plus a small set of explicit helpers, covers the
same surface area.

The reasoning rests on two observations:

1. **Pulse's reactive graph is already a dependency graph.** When a
   signal updates, downstream computeds re-run and downstream effects
   re-fire — automatically, transitively, with no special invalidation
   list. If application code models its data as signals (a client cache
   that mutations update), the "what depends on what" question is
   answered by graph subscription, not by tags / keys / runtime
   entanglement.
2. **Pulse's async-as-value model** (signal of `T | Promise<T>`,
   per-binding stale-but-stable from Plan 2a, `<Loading>` coordination
   scope from Plan 4) already provides what Solid 2.x's transitions
   provide for the *observation* side: pending observability, no
   flicker, scope-level coordination. The remaining gap is the
   *mutation orchestration* side — pending tracking during a write,
   optimistic application, refresh after server confirms.

The mutation side is covered by **three small composable helpers**
(Plan 5): `action` for pending-tracked mutations, `optimistic` for
local-apply-then-reconcile patterns, `resolve` for imperative awaiting
of reactive expressions. Each is ~10–20 lines, no new runtime
machinery, fully composable with `<Loading>` and `isPending`.

### Considered alternatives

- **Transitions runtime à la React 18 / Solid 1.x.** A `startTransition`
  primitive marks writes as transitional; the runtime tracks
  membership, buffers DOM commits, supersedes on re-trigger.
  Rejected for the reasons in master spec §10: requires
  graph-wide instrumentation, runs counter to pulse's "no hidden
  scheduling" principle, and duplicates work pulse's value-level
  pending model already does.
- **Transitions-first like Solid 2.x.** Every async write is implicitly
  transitional. The runtime is *the* coordination mechanism. Rejected
  by master spec §10 and reaffirmed here: pervasive runtime cost, hard
  to reason about cause and effect, opaque to debugging tools.
- **TanStack Query-style tag-based invalidation.** Each query declares
  tags; mutations declare which tags they invalidate; runtime matches.
  Rejected as primary mechanism: it solves the "graph doesn't know
  server-side relationships" problem at the cost of an entire
  query/mutation primitive layer. If application code keeps data in
  signals, that layer is redundant. Could be added as a follow-up if
  the manual-list-of-signals-to-update pattern grows noisy in real
  apps.
- **Resource primitive (Voby-style `useResource`).** A self-tracking
  async value object that integrates with Suspense/Loading. Rejected as
  redundant: pulse's signal-holding-promise IS the resource. Adding a
  separate `resource()` constructor doubles the conceptual surface
  without new capability.

### Consequences

- **Application-author discipline matters.** The "model data as
  signals" pattern is the load-bearing piece. Application code that
  treats `fetch(...)` as an out-of-band side effect — instead of
  flowing the result into a signal — loses the graph's transitive
  invalidation. Documentation must teach this pattern as the canonical
  approach.
- **No transitions value type.** Pulse does not ship
  `transition({...}) → { pending, settled, abort }`. The closest
  equivalents are: `action()` (pending + run), `<Loading>` (boundary
  observation), per-binding kick-guards (per-binding supersession).
  Group-level supersession across an entire action is an open follow-up
  if real cases demand it.
- **No automatic refresh after mutation.** When a mutation completes,
  the application's mutation body must update whichever signals are
  affected. If that pattern grows tedious (e.g. "after creating an
  item, six different signals need to refetch"), the right next move
  is a tag-based helper layered on top of signals — not a transitions
  runtime.
- **Optimistic UI is a pattern, not a primitive.** `optimistic(set,
  apply, action)` is a 10-line helper that applies a local update,
  awaits the action, and reverts on failure. No transition context
  needed; no runtime revert machinery; just try/catch around a setter.
- **`isRefreshing()`-like distinction** is satisfied by `<Loading>`'s
  `hasEverLoaded` flag (Plan 4): once the boundary has fully loaded
  once, subsequent pendings render the `fallback` slot (or hold prior)
  — exactly the "initial vs. refresh" split Solid 2.x exposes via a
  separate hook.

### Relationship to master spec §10

Master spec §10 sketched a `transition()` value with `pending`,
`settled`, `abort`. This ADR supersedes that sketch with the
decomposition above. The user-facing outcomes §10 anticipated —
membership, atomic commit, observable handle — are unbundled:

- **Membership** is implicit via signal reactivity.
- **Atomic commit** is per-binding stale-but-stable + Loading boundary
  flush on next scheduler tick when all members settle.
- **Observable handle** is `action.pending` + `<Loading>`'s state.

§10 should be updated (or marked deferred-superseded) to point to this
ADR and to Plan 5.

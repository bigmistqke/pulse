# Speculation is an overlay above r3; r3 is left untouched

The pulse speculation engine (scopes, multi-slot-per-Node, chain-match, actions)
is implemented as a **pure overlay above r3**, not by forking or patching r3's
fire loop. r3 continues to own **committed** reactive state exactly as today —
one `value` per node, alien-signals `Link`s, the height-ordered dirty heap.
**Speculative** state lives entirely in the scope layer ([`scope.ts`](../pulse/../../src/scope.ts)):
per-scope `slots`, pulse `Edge`s, `chainMatch`, and pull-driven recompute. The
two layers meet at exactly one seam — **commit** — where a scope's `writeSet`
is promoted to its parent via r3's `setSignal`.

This is the "lean on r3 / minimal-delta" choice (the same criterion that decided
[Q1](../pulse/questions.md#q1--fall-through-and-edge-policy)), and it is forced
by the r3 study ([`r3-integration-notes.md`](../pulse/r3-integration-notes.md)):
r3 holds one value per node, so per-scope slots cannot live in r3 at all —
Plan 1 already stores them separately, so it is already an overlay.

**Concretely:**

- **Speculative reads/writes** never touch r3's `value`. A read under scope `S`
  walks the slot chain (`readSlot`); a computed miss runs its recipe under `S`
  on a pulse-side path, forming pulse edges and caching in `S`'s slot. A write
  under `S` updates `scope.slots` and marks affected slots dirty; the next read
  recomputes (pull). Effects are forbidden inside speculative scopes (Q3), so
  there are no async consumers to schedule — pull suffices, and K1's Position-C
  freshness holds via synchronous dirty-marking at write time.
- **Committed reads/writes** are plain r3 (`read` / `setSignal`), untouched.
- **The commit bridge** is the only crossing: `closeScopeEdges(S)` first (tear
  down S's pulse edges, drop S's slots), *then* for each `writeSet` node
  `setSignal(node, promotedValue)`, *then* one `stabilize()`. Ordering (edges
  down before promote) is what keeps the two edge systems from double-firing.

## Considered alternatives

- **Fork + patch r3's fire loop** (add per-scope slots and the chain-match
  predicate inside `setSignal`/`recompute`; Q1's literal "single delta from
  r3's fire loop") — **rejected.** It requires surgery on the alien-signals
  machinery (`Link`, the height heap, `markNode`) and turns r3 from a dependency
  into a vendored fork. The overlay achieves the same behaviour with none of
  that; "lean on r3" argues directly against forking it.
- **Hybrid: reuse r3's heap to schedule speculative recompute** — **rejected.**
  Speculative consumers are pull-driven (effects are forbidden under speculation,
  so nothing needs scheduling), so pushing speculative slots into r3's height
  heap would entangle speculative and committed scheduling for no benefit. The
  overlay only needs r3's heap at *commit*, where it already gets glitch-free,
  `InHeap`-deduped batching for free.

## Consequences

- **r3 stays a plain dependency** — no vendoring, no fork to maintain. pulse's
  delta lives wholly in `src/scope.ts` and the read/write walks above r3.
- **Two edge systems exist, but are temporally disjoint** — pulse edges only
  while a speculation is open; r3 `Link`s for committed reactivity. The commit
  bridge's ordering (edges-down-then-promote) is the correctness-critical seam
  and must be trace-verified (Plan 3, against the `doubleName` commit steps
  5a/5b and H1a-c).
- **A parallel speculative compute path** — the overlay reruns recipes under a
  scope itself rather than through r3's `recompute`. This is duplication, but
  bounded (recipe + pulse-edge dep tracking) and the price of not forking.
- **Q10 batching is inherited, not built** — commit gets one-invalidation-per-
  slot from r3's height heap, *provided* the commit path promotes all writes
  then stabilizes once. `src/signal.ts`'s current per-write `requestFlush()`
  must be bypassed on the commit path (promote-all-then-flush-once).
- **The uniform `Awaitable` read model** ([`async-reads-and-coordination.md`](../pulse/async-reads-and-coordination.md),
  superseding ADR 0002's write-back) layers on top of this overlay in Plan 3+;
  nothing here conflicts with it.

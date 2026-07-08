# Speculation Engine — Plan 2: r3 Integration Study & Architecture Decision

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This is a **study-and-decide** plan (not TDD code) — its two tasks produce a findings doc and an architecture decision, which unblock Plan 3 (the TDD wiring). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Understand r3's fire loop and node model well enough to decide *how* Plan 1's pure scope/slot/chain-match overlay (`src/scope.ts`) integrates with the running r3 engine — then record that decision. No engine code is written in this plan.

**Architecture:** Two tasks. Task 1 studies r3 (`node_modules/r3/src/index.ts`) and writes a findings doc. Task 2 weighs the candidate integration architectures against those findings and records the decision as an ADR + a short design note. Plan 3 (the TDD wiring) is authored *after* this plan lands, grounded in Task 2's decision.

**Tech Stack:** Reading TypeScript (r3 + `src/signal.ts` / `src/computed.ts`). No test framework used in this plan (no code changes).

**Why this is a study plan, not code:** the writing-plans no-placeholders rule forbids fabricated integration tasks. The integration *approach* is genuinely undecided until the study answers how pulse's multi-slot reconciles with r3's single-value-per-node model. Deciding first, then writing real TDD tasks, is the honest order.

---

## Seed findings (from an initial read of `node_modules/r3/src/index.ts` — Task 1 verifies + deepens)

r3 is an alien-signals-derived push-pull engine:

- **`Signal` = `{ subs: Link|null, subsTail, value }`** — exactly **one** `value` per node. **`Computed`** adds `deps`, `flags`, `height`, dirty-heap pointers, `disposal`, `fn`, `child`.
- **`Link`** — doubly-linked dep/sub edges (alien-signals `system.ts` port).
- **Push:** `setSignal(el, v)` — if `el.value !== v`, set it and `insertIntoHeap(sub)` for each sub.
- **Pull:** `read(el)` — `link(el, context)`, `updateIfNecessary(owner)`, return `el.value`.
- **Scheduling:** a **height-ordered dirty heap**; `stabilize()` drains it low-height-first, `recompute(el)` reruns `el.fn()`, diffs deps, and fires subs only on value-change. Height-order = glitch-free.
- **Firewall signals** (`computed.child`) — signals *owned by* a computed; `markNode` walks them. Purpose in r3's own model to confirm.

**The load-bearing implication:** r3 holds one value per node, so pulse's per-scope slots **cannot** live in r3's `value` — that is precisely why Plan 1 put slots on the scope (`scope.slots`), separate from r3. Plan 1 is therefore already shaped as an **overlay**: pure slot storage + `edgesToFire`, touching no r3 state. The integration question is how that overlay drives real invalidation and bridges to r3 at commit.

---

## Task 1: Study r3's fire loop and write the findings doc

**Files:**
- Create: `docs/pulse/r3-integration-notes.md`
- Read (do not modify): `node_modules/r3/src/index.ts`, `src/signal.ts`, `src/computed.ts`, `src/scope.ts`

- [ ] **Step 1: Read the source.** Read all of `node_modules/r3/src/index.ts`. Then read `src/signal.ts` and `src/computed.ts` to see how pulse currently wraps r3 (`makeAccessor`, `r3Read`, `r3SetSignal`, `stabilize`), and `src/scope.ts` for the Plan-1 overlay it must integrate with.

- [ ] **Step 2: Answer these probe questions in `docs/pulse/r3-integration-notes.md`.** Each answer must cite the r3 function(s) it rests on. Verify or correct the seed findings above as you go.

  1. **Speculative compute path.** r3's `recompute` writes the derived value into `el.value` (the committed cell). To hold a *derived's* value at scope `S` without clobbering committed state, pulse must run the recipe on a pulse-side path into `scope.slots[node]`. Confirm this is feasible and describe it: does pulse re-run the recipe under `S` itself (bypassing r3's `recompute`), and if so what does it reuse from r3 vs reimplement?
  2. **Two edge systems.** Committed reactivity uses r3 `Link`s; speculation uses pulse `Edge`s (`scope.edges`, chain-match), torn down at `closeScope`. Do they coexist without double-fire or missed-fire? Specifically: when a speculation commits and promotes a writeSet slot to ROOT via `setSignal`, do r3's links fire the committed consumers correctly, and are the (now-defunct) pulse edges guaranteed already torn down?
  3. **Driving invalidation.** `edgesToFire(node, writeScope)` returns which pulse edges should fire. How does that become an actual recompute? Options to evaluate: (a) mark the target slots dirty and recompute them on next pulse read (pull); (b) push them into r3's dirty heap via `insertIntoHeap`; (c) a pulse-side scheduler. Which fits r3's model with least friction?
  4. **Commit as a deferred-fires region (Q10).** r3's `setSignal` fires synchronously into the heap; `stabilize()` batches the drain. Does promoting a multi-node writeSet at commit already get Q10's "consumers see one invalidation per slot" batching from r3's heap + `stabilize`, or does pulse need its own deferred-fires region on top?
  5. **Firewall signals / `child`.** What are they for in r3, and do they matter to the scope model (e.g. as an existing grouping/transition mechanism pulse could lean on), or are they orthogonal?
  6. **`height` and speculative scopes.** r3 orders recompute by `height`. Do speculative reads/writes interact with height at all, or is the overlay height-agnostic (since it recomputes via its own path)?

- [ ] **Step 3: Commit the findings doc.**

```bash
git add docs/pulse/r3-integration-notes.md
git commit -m "docs(pulse): r3 fire-loop study for speculation integration"
```

---

## Task 2: Decide the integration architecture and record it

**Files:**
- Create: `docs/adr/0010-<slug>.md` (next ADR number; slug per the chosen approach)
- Modify: `docs/pulse/r3-integration-notes.md` (append the decision + rationale)

- [ ] **Step 1: Evaluate the candidate architectures** against Task 1's findings and pulse's "lean on r3 / minimal-delta" principle. Write the evaluation into `r3-integration-notes.md`.

  - **A — Overlay (r3 untouched).** r3 remains a dependency handling committed state as-is. Speculation is a pure overlay: speculative reads/writes use `scope.slots` + pulse edges + `edgesToFire`, never touching r3's `value`; reads fall through the slot chain, then to r3's `read` for committed; commit promotes slots via `setSignal` (the bridge to r3). Two edge systems, the pulse one alive only during a speculation. *Pro:* r3 unforked; matches Plan 1's shape. *Con:* speculative computeds recompute on a pulse-side path (some duplication of r3's compute logic); two edge systems to keep coherent at the commit bridge.
  - **B — Fork + patch r3's fire loop.** Vendor r3 into `src/`, extend its node model with per-scope slots and add the chain-match predicate *inside* `setSignal`/`recompute` — Q1's literal "single delta from r3's fire loop." One unified edge system. *Pro:* unified; no dual bookkeeping. *Con:* forking r3 and doing surgery on the alien-signals machinery (`Link`, heap, height); larger blast radius.
  - **C — Hybrid.** Keep r3's heap + height scheduling and `Link`s for committed reactivity, but overlay slot storage + chain-match at the pulse read/write boundary, reusing r3's `insertIntoHeap`/`stabilize` to drive speculative recompute. *Pro:* reuses r3's scheduler; less reimplementation than A. *Con:* the read/write boundary interception is subtle; must not let speculative writes reach `setSignal`.

- [ ] **Step 2: Pick one and write the ADR.** Decision criteria, in priority order: (1) *lean on r3 / minimal-delta* — the criterion Q1 itself used; (2) does the approach avoid reimplementing r3's compute/schedule logic; (3) does the commit-bridge stay provably correct (no double/missed fire); (4) does it require forking r3 (a real cost — r3 is currently a git dependency). Write `docs/adr/0010-<slug>.md` recording the chosen approach, the rejected ones (with the deciding reason), and the consequences. Cross-link `../pulse/questions.md#q1--fall-through-and-edge-policy` (Q1 framed chain-match as the delta) and `../pulse/async-reads-and-coordination.md` (the read model the wiring must honor).

  *Author's lean (not binding — Task 1's findings decide):* **A or C.** Plan 1 was deliberately built as a pure overlay separate from r3, and "lean on r3" argues against forking (B). The A-vs-C choice turns on probe question 3 (whether reusing r3's heap for speculative recompute is clean, → C, or whether a pulse-side pull is simpler, → A).

- [ ] **Step 3: Commit.**

```bash
git add docs/adr/0010-*.md docs/pulse/r3-integration-notes.md
git commit -m "docs(adr): 0010 — speculation/r3 integration architecture"
```

---

## After this plan

Write **Plan 3 — the TDD wiring** grounded in the ADR from Task 2: the read/write interception (`get`/`set` that delegate to r3 for committed, slot-store + chain-match for speculative), `edgesToFire` → real invalidation, and the commit bridge (`writeSet` → `setSignal`). That plan can be fully TDD with real code once the architecture is fixed — its tests come from the `doubleName` commit steps (5a/5b) and H1a-c.

## Self-review

**Coverage:** the task is "understand r3, then decide how the overlay integrates." Task 1 (study + findings doc) covers the understanding; Task 2 (evaluate + ADR) covers the decision. Together they produce exactly the artifacts Plan 3 needs. No integration code is claimed here — deliberately, because it cannot be written honestly before Task 2.

**Placeholder scan:** no fabricated code or "TBD" steps. The two tasks produce concrete deliverables (a findings doc answering six specific, source-cited questions; an ADR choosing among three fully-described candidates). `<slug>` in the ADR filename is intentionally deferred to the chosen approach — that is a naming-after-decision, not a placeholder requirement.

**Consistency:** the candidate architectures (A/B/C) referenced in Task 2 are the same three introduced there; the probe questions in Task 1 (esp. #3) feed directly into the A-vs-C criterion in Task 2. Seed findings are marked as *to verify*, not as settled fact.

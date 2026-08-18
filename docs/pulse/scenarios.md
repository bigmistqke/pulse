# Pulse — scenario catalog

A map of architecturally-distinct cases the engine + speculation machinery needs to handle. **Each scenario is intended to become a test case (TDD).** The catalog deliberately favours _specificity over generalisation_: distinct cases stay distinct even when they look similar, because each will be its own test.

**Companion documents:**

- [README.md](./README.md) — framings, falsified hypotheses, engine/library sketches, open questions ([Q1](./questions.md#q1--fall-through-and-edge-policy) through [Q12](./questions.md#q12--body-cleanups-vs-scope-cleanups-composition-and-re-entrancy)), threads.
- [scenario-traces.md](./scenario-traces.md) — end-to-end traces of the ✓-marked scenarios below.

**Legend:** ✓ marks a scenario that's been traced end-to-end (see [scenario-traces.md](./scenario-traces.md) for the trace). Everything else is open.

**Tracing discipline.** When a scenario is traced, record both the decisions the trace exposed and _the alternatives that weren't taken_ — otherwise the first plausible trace becomes the route by default, which is exactly the premature commitment the explorative phase is meant to avoid.

**Category organisation.** Categories A, C, D, E, F correspond directly to the four dimensions of speculation (see [`../async/CONTEXT.md`](../async/CONTEXT.md)): A = Dim 1 (internal structure); C = Dim 1 with async; D = Dim 2 (concurrence); E = Dim 3 (supersession); F = Dim 4 (overlap). The remaining categories (B, G, H, I, J, K, L, M, R) are _cross-cutting concerns_ that don't map to a single dimension — lifecycle, nesting, effects, JSX, edges, re-entrancy, boundary-bypass reads, resource ownership, scheduling.

**Related pulse-repo docs:**

- [`../async/CONTEXT.md`](../async/CONTEXT.md) — speculation lexicon, four dimensions, failure modes.

## Contents

- [Traces (in scenario-traces.md)](#traces-in-scenario-tracesmd)
- [A. Single speculation, sync (Dim 1 — internal structure)](#a-single-speculation-sync-dim-1--internal-structure)
- [B. Lifecycle & cleanup](#b-lifecycle--cleanup)
- [C. Async (Dim 1 with async — Q4 territory)](#c-async-dim-1-with-async--q4-territory)
- [D. Concurrence (Dim 2 — disjoint state)](#d-concurrence-dim-2--disjoint-state)
- [E. Supersession (Dim 3) — _policy question_](#e-supersession-dim-3--policy-question)
- [F. Overlap (Dim 4 — entanglement) — _policy question_](#f-overlap-dim-4--entanglement--policy-question)
- [G. Nesting (scope hierarchy)](#g-nesting-scope-hierarchy)
- [H. Effects under speculation — _Q3 open_](#h-effects-under-speculation--q3-open)
- [I. Component / JSX integration](#i-component--jsx-integration)
- [J. Edge cases / pressure points](#j-edge-cases--pressure-points)
- [K. Re-entrancy & write-during-recompute](#k-re-entrancy--write-during-recompute)
- [L. Boundary-bypass reads inside speculation](#l-boundary-bypass-reads-inside-speculation)
- [M. Resource ownership across speculation](#m-resource-ownership-across-speculation)
- [R. Scheduling & frame coordination](#r-scheduling--frame-coordination)
- [W. Writes into derivations (`signal(fn)`)](#w-writes-into-derivations-signalfn)
- [Probably out of scope for the research phase](#probably-out-of-scope-for-the-research-phase)
- [Architectural distribution](#architectural-distribution)

## Traces (in [scenario-traces.md](./scenario-traces.md))

Each trace walks a scenario end-to-end through engine + library calls.

- [**doubleName trace**](./scenario-traces.md#doublename-under-scope-s) — exercises A2, B1, B2.
- [**C2 trace**](./scenario-traces.md#c2--action-body-with-async-read) — exercises C2a, C2b, C2c, C2d.
- [**H1a-c trace**](./scenario-traces.md#h1a-c--effect-under-speculation) — exercises H1a, H1b, H1c.
- [**K1 trace**](./scenario-traces.md#k1--re-entrant-setter-mid-recompute) — exercises K1a, K1b.
- [**G2 trace**](./scenario-traces.md#g2--nested-actions-and-commit-promotion) — exercises G1, G2, G3, G4.
- [**H3 trace**](./scenario-traces.md#h3--cleanup-chains-across-speculative-effect-runs) — exercises H3 (a, b, b').
- [**C2e trace**](./scenario-traces.md#c2e--post-yield-derived-read-async-k1b-analogue) — exercises C2e.
- [**H1d trace**](./scenario-traces.md#h1d--effect-body-coherence-on-commit) — exercises H1d.

---

### A. Single speculation, sync (Dim 1 — internal structure)

- **A1.** `setX` inside action, read `X` back inside the same action. Tests whether a write sees itself on subsequent read inside the scope. _Expected: yes — the slot at `S` is what reads see._
- **A1b.** Same as A1 but interleaved with derived reads: `setX(1); get(f(X)); get(X); get(f(X)); setX(2); get(f(X))`. Tests that all reads — primitive _and_ derived — see fresh values in the same scope tick, not just the self-read. (A1 alone could "pass" on a single-slot bag without ever invalidating derivative caches.)
- **A2.** ✓ `setX`, read derived `f(X)` — the `doubleName` case. Traced.
- **A3.** Action writes multiple signals (`setX`, `setY`); read derived `f(X, Y)`. Tests whether multiple scope-tagged slots compose into one derived under the same scope. _Expected: yes — recipe runs once, reads each under `S`. Conditional on [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified) (tracker-as-scope) and [Q1](./questions.md#q1--fall-through-and-edge-policy) selector dedup behaving correctly under multi-source reads._
- **A3b.** Order-sensitive intermediate coherence: `setX(...); get(f(X, Y)); setY(...); get(f(X, Y))`. Tests whether the intermediate read sees `f(newX, oldY)` (Position C synchronous fires propagate dirty mid-action) or `f(oldX, oldY)` (Position B derived cache only invalidated at action end). Action-body analogue of K1b. _Expected under (C): fresh on each read._
- **A4.** Action writes one signal; two distinct deriveds depend on it. Tests that both deriveds invalidate independently and re-read under `S`.
- **A4b.** Sibling-derived coherence: after `setX`, read derived `d1`, then derived `d2`. Are both fresh? Does reading `d1` first somehow pin a stale cache for `d2`? Probes whether mid-action recompute of one derived leaks staleness to its sibling. Cuts multiple ways depending on [Q1](./questions.md#q1--fall-through-and-edge-policy) selector dispatch ordering.
- **A5a.** Functional setter: `setX(x => x + 1)` inside action. Tests _what the setter callback's `x` parameter is_: committed value or speculative-slot value. Library-API design question.
- **A5b.** Functional setter, write side: where does the setter's returned value land? Tests that the write goes to the speculative slot at `S`, consistently with sync `setX(v)`. _Expected: yes._
- **A5c.** Functional setter callback reading a downstream derived: `setX(x => { const d = get(f(X)); return d + 1 })`. Tests what the derived `f(X)` seen inside the callback reflects — the pre-setter committed `X`, the speculative `X` (if outer action ongoing), or some half-state. K1b's mirror inside a setter callback rather than a computed recipe.
- **A6a.** Conditional read in a recipe under `ROOT_SCOPE`: branches change on input. Tests dynamic deps (drop edge for not-taken branch, form edge for taken). _r3 baseline; no new behavior._
- **A6b.** Same conditional read, recipe invoked under a non-root scope `S`. Tests dynamic deps _under scope_: scope-tagged edges drop / form as branches change. This is where Model 2 is exercised; A6a is a smoke prerequisite.
- **A6c.** Conditional read under `S` where the condition's input was just written, then the same conditional derived is read twice in succession. Tests coherence of _graph shape changes mid-recompute_: does the second read see the new branch's value (fresh dep-graph + fresh cache) or a hybrid (new branch chosen but evaluated against stale upstream slot)?
- **A7.** Action reads only — never writes. Tests whether slots get created under `S` for memoisation purposes, or whether read-only access is a no-op at the bag level.

### B. Lifecycle & cleanup

- **B1.** ✓ Action returns normally → commit. Traced.
- **B2.** ✓ Action throws → discard. Traced.
- **B3.** `onCleanup(fn)` inside action body. Tests: discard fires `fn`; commit doesn't. Working hypothesis from [Q2](./questions.md#q2--scopeowner-unification).
- **B4.** Owner of the action is disposed mid-action (parent owner unmounts). Tests: action's scope discards as a consequence of owner disposal. Falls out of scope/owner unification if it holds.

### C. Async (Dim 1 with async — Q4 territory)

- **C1.** `setX(Promise.resolve("v"))` inside action — the new recipe returns a Promise. Tests: how does a derived `get(X)` see this? Walks decide.
- **C1b.** After `setX(promise)`, in the same scope, read a derived `f(X)` whose recipe does `get(X).then(...)` or `yield* get(X)`. Tests: does the derived's slot capture the _same Promise identity_ the setter wrote, or a different one (e.g., re-wrapped)? Promise identity = supersession signal per main-doc D8.
- **C2a.** Action body `yield* get(asyncSignal)` — body parks until promise resolves _before any other event_. Tests: does the scope stay open across the await? Does the ambient scope restore correctly on resume?
- **C2b.** Same, but the awaited promise resolves _after_ the action would have committed had it been synchronous (i.e., the scope stays open across a long await). Tests: long-lived open scopes; resource holding.
- **C2c.** Same, but a supersession (E1) arrives while the action body is parked at the `yield*`. Tests: discard mid-coroutine; cancellation reaches the in-flight promise via `onCleanup`.
- **C2d.** Same, but writes occur (from a different scope, or from ROOT_SCOPE) during the await window. Tests: when the action body resumes, what does its read see? Did the chain re-evaluate?
- **C2e.** Post-yield derived read: action body does `yield* get(asyncSignal); const d = get(downstreamDerived)`. The derived's recipe reads `asyncSignal`. Tests: after resume, does the derived see the _resolved_ value of `asyncSignal`, or the still-Promise-cached value in `slot[S]`? Must the engine's slot-changed `'resolved'` event have fired (and been observed by the derived's slot) _before_ the body's resume runs? **Async analogue of K1b** — the canonical post-async-coherence probe. Cuts at least two ways depending on microtask ordering vs engine's synchronous `.then` handling.
- **C2f.** Two sequential `yield* get`s of _different_ async signals in the same body, with a downstream derived depending on both. Probe: between yields, does the derived see (resolved-A, pending-B) coherently? Probes per-step in-recipe coherence across multiple awaits.
- **C3.** Async signal resolves _after_ the action commits — what value lands in canonical? The action committed a Promise; resolution happens later under no scope. Library policy.
- **C4.** Concurrent in-flight async + new action arrives. Tests: supersession + async cancellation interaction.
- **C5.** Action body awaits external work (not a signal — a fetch). Tests: AbortController via `onCleanup` on discard. Cancellation discipline.

### D. Concurrence (Dim 2 — disjoint state)

- **D1.** Two actions `S1`, `S2`, writing disjoint signals. Independent slots; both commit; no interaction. Should be trivial — slots keyed by scope.
- **D2.** Two actions, both read same signal but only one writes. Reader's edges register against the writing scope's chain; should fire correctly on writer commit. _Conditional on commit-ordering open question (trace step 5 open question #1)._
- **D2b.** After writer commits, but inside reader's still-open scope, reader reads a derived that depends on the writer's signal. Probe: does the derived see the just-committed value (`ROOT_SCOPE` chain entry updated, reader's chain `[S_reader, ROOT]` walks to ROOT), or did the reader's scope already memoize a slot from before the commit? Coherence across the chain when a _more-canonical_ entry updates underneath an open scope.
- **D3.** Late subscriber: component mounts mid-action and reads under that action's scope. Edge formed with the right chain at subscription time. Should fall out of Model 2.

### E. Supersession (Dim 3) — _policy question_

- **E1a.** New action arrives while old in-flight; old structurally cancelled by closing its scope with `discard`. Tests: scope-discard mechanism — slots drop, edges cleanup, cleanups fire.
- **E1b.** Discarded scope's `onCleanup` chain aborts an `AbortController` that the action body installed for an in-flight fetch. Tests: cancellation reaches in-flight async work via the cleanup chain ([Q2](./questions.md#q2--scopeowner-unification) + [Q2](./questions.md#q2--scopeowner-unification) composition).
- **E2.** Old action and new action coexist (no auto-supersession). Both scopes alive; reads under each see their own overlay. Likely default.
- **E3.** Rapid sequence of supersessions (typing in an input). Scope churn doesn't leak; cleanups fire promptly. Pressure test.

### F. Overlap (Dim 4 — entanglement) — _policy question_

- **F1.** Two concurrent actions both write same signal. Which scope's slot is in play for which reader? Two scopes, two slots, no merge — pulse-direction lean.
- **F2.** Two actions commit in sequence; both touched the same signal. Commit order determines final canonical. Last-writer-wins per the lean; Solid auto-merges (which pulse rejects).
- **F3.** Concurrent actions where one's read-set overlaps the other's write-set (one reads `X`, other writes `X`). Reader's selector decides what it sees — selector with chain `[my_scope, ROOT]` doesn't see other scope's write. ✓ (Selector design verified.)

### G. Nesting (scope hierarchy)

- **G1.** Action inside an action. Inner scope is child of outer. Writes tagged with inner scope; reads inside inner walk chain `[inner, outer, ROOT]`. Falls out of the chain framing.
- **G1b.** Outer wrote `setX('outer')`; inner opens, writes `setX('inner')`. Inside inner, read `X` and derived `f(X)`. Then — _hypothetical interleave_ — control returns to outer mid-inner and outer reads `X`. **Resolved by [CC1](./scenario-traces.md#cc1--two-concurrent-async-speculations-interleaved-resumptions):** _sibling_ actions do interleave (at `yield*` points, serialized per slice), but this specific _nested_ case is **not reachable** — an outer body `yield*`s its inner action and stays suspended until the inner completes, so control never returns to the outer mid-inner. The reachable interleave is between siblings, and CC1 shows it is per-slice-sequential with chain-match isolation intact.
- **G2.** Inner commits → its slots promote to outer's scope (not ROOT). Outer commits → outer's slots promote to ROOT. Two-stage promotion. _Open: does inner-commit promote to outer or directly to ROOT? Lean: to outer, preserving nesting._ See F2 — same commit-promotion question at outer-most depth.
- **G3.** Inner commits; outer discards. Inner's promoted-to-outer slots get discarded with outer. Nesting respects parent lifecycle.
- **G4.** Inner discards; outer continues. Inner's writes drop; outer's state unchanged.
- **G4b.** Outer wrote `setX('outer')`. Inner opens, writes `setX('inner')`, discards. Outer then reads `f(X)`. Tests: does the discard cleanly detach inner's slot from outer's chain such that outer's derived `f(X)` recomputes against `'outer'`, not against a half-cleaned `'inner'` cache? Coherence-of-discard probe for the outer body's subsequent reads.

### H. Effects under speculation — _Q3 open_

- **H1a.** Effect registered outside; speculative write happens inside an action. Tests _during the action_: does the effect fire? _Lean: no (defer-until-commit)._
- **H1b.** Same setup; action commits. Tests _after commit_: does the effect fire exactly once with the committed value? _Lean: yes._
- **H1c.** Same setup; action discards. Tests: effect never fired (no speculative trigger leaked). _Lean: yes._ (H1a/b/c together establish the defer-until-commit position from [Q3](./questions.md#q3--consumer-patterns).)
- **H1d.** Effect body reads `get(X)` _and_ `get(f(X))`. Action writes `setX(5)`, commits. Effect schedules and runs. Tests: does the effect see (X=5, f=10) coherently, or could it see (X=5, f=stale) because the derived's slot at `ROOT_SCOPE` wasn't invalidated in dep-order during commit promotion? **Effect-body coherence on commit** — probes commit-promotion ordering ([doubleName trace](./scenario-traces.md#doublename-under-scope-s) open #1) through the effect's lens.
- **H2.** Effect created inside an action body. Effect's owner is the action's scope; effect's body executes once at registration. Does it re-fire on writes inside the same action?
- **H2b.** Effect created inside action `S`, registered against chain `[S, ROOT]`. Action body then writes `setX`, then reads downstream `f(X)` directly. Then more writes. Tests: when the effect re-fires (if it does), what scope chain is active in its body? Does its `get(X)` see the latest in-action value, and if it reads a derived, does the derived see the same? Separates "did it fire" (H2) from "did it see coherent state" (H2b). [Q11](./questions.md#q11--effect-chain-policy-chain-follows-owner-or-always-root_scope) (effect chain policy α/β) is upstream.
- **H3.** Effect with `onCleanup`; speculative write triggers the effect → effect's body runs → registers cleanup. If discard, do those cleanups fire? Cleanup chains across scopes; tricky.
- **H3c.** After cleanup fires and the body re-runs, does the new body see derived-coherent state w.r.t. whatever caused the re-run? Post-cleanup body re-run coherence probe.
- **H4.** Effect that itself calls `action(…)` (effect-triggers-action). Cycles? Bans? Worth knowing the policy.
- **H5.** Effect-mediated derivation coherence during action. An effect maintains a signal `value` derived from `name` (e.g., `effect(() => setValue(get(name) + get(name)))`). An action writes `name`, then reads `value`. Tests: does `value` reflect the action's `name` overlay (would require eager effect runs, which contradicts H1a-c), or the pre-action committed `value` (stale during the action, fresh after commit + effect re-run)? **Architectural answer: stale during action.** Contrast with K1b's computed-mediated equivalent, which sees fresh. The two distinguish the **computed vs effect derivation** distinction (see the "Derivation kind matches reactivity scope" framing). User-ergonomic implication: effect-driven derivations are _deferred_; use `computed` for synchronously-fresh derivations inside actions.

### I. Component / JSX integration

- **I1.** JSX expression `{get(name)}` rendered inside a component that's _inside_ an active action. JSX-binding consumer treated like Effect — re-renders on speculative writes? Defers to commit? [Q3](./questions.md#q3--consumer-patterns) territory. _Downstream of H1a-c's resolution._
- **I1b.** JSX expression `{get(f(X))}` where the component is mid-render at the moment of an action commit. Tests: does the resulting DOM reflect coherent (X, f(X)) values, or could it tear (render uses old X but new f(X) because two reads bracket the commit point)? **Tearing/coherence probe for the renderer consumer.** Cuts multiple ways depending on whether JSX walks are batched.
- **I2.** Component mounts inside an action. Its computeds and effects belong to a child owner of the action's scope. On action discard, all the mounted components dispose. Falls out of scope/owner unification.
- **I3.** Component unmounts mid-action. Owner disposes; its subscriptions clean up; if the unmount was triggered by an action write, ordering matters.

### J. Edge cases / pressure points

- **J1.** `latest(node)` inside an action. `latest` walk uses `chainSelector([ROOT_SCOPE])`, sees the committed value, ignores the action's overlay. Falls out of selector design.
- **J2.** `peek(node)` inside an action. Untracked read, same scope, no edge formed. Trivial.
- **J3a.** `isPending(node)` — definition 1: returns true if _any_ scope has a slot for the node distinct from the canonical chain endpoint (i.e., "something is in flight somewhere").
- **J3b.** `isPending(node)` — definition 2: returns true only if _the current scope's slot_ has a Promise-valued cache (i.e., "this node is pending _for me_"). Distinct walk from J3a; the library should pick one (or expose both with different names). [Q4](./questions.md#q4--async-at-the-engine-level) adjacent.
- **J4.** Action creates a new signal (`signal(initial)` called inside the action body). Does the new signal's "initial slot" tag with `ROOT_SCOPE` or with the action's scope? Library policy. If with scope: signal disappears on discard (probably right). If with ROOT: signal survives discard but its values were never written outside the scope (probably wrong).
- **J4b.** Action creates signal `Y` via `signal(0)`, then writes `setY(1)`, then reads a derived `g(Y)`. Tests: does the derived see `1`? Does its scope chain include `S`, or did it form against `ROOT` because the signal's initial slot landed there? Coherence test downstream of J4's policy decision.
- **J5.** Action body sets a value, then somewhere else (a different scope or no scope) reads it. Other scope/no-scope doesn't see the speculative value. Falls out — selectors handle.

### K. Re-entrancy & write-during-recompute

- **K1a.** `setX` called from _inside_ a computed's recipe body during recompute, with _no follow-up read of a downstream derived_. Tests the "is this permitted at all?" question. _Resolved: permitted (Position A hard-ban is incompatible with effects)._
- **K1b.** _Same as K1a, but the recipe reads a downstream derived after the write._ E.g., `computed(() => { setName("name"); return get(doubleName).capitalize() })`. Tests **in-recipe coherence**: does the post-write read see the _fresh_ derived value, or the stale cached one? This is the case that exposes (B) deferred-fires vs (C) synchronous-fires. _Resolved: (C) synchronous-fires gives fresh; (B) gives stale._
- **K2.** `setX` called from inside `onCleanup` of a slot being dropped during commit (cleanup chain triggers further writes). Tests: re-entrant write during commit; commit-ordering subtlety (trace open question #1).
- **K2b.** `onCleanup(() => { setOther(get(derivedFromX)) })`. Inside the cleanup, after the write to `Other`, is `get(derivedFromX)` reading a slot in a half-promoted state? Does the cleanup observe `X`'s pre-promotion or post-promotion value? Does the write to `Other` land in a still-open scope, in `ROOT`, or trigger commit-time re-entrancy? **Cleanup-time re-entrancy + coherence probe.** Cuts multiple ways: (i) commit is atomic, cleanups see post-promotion state; (ii) cleanups fire mid-promotion, half-state; (iii) cleanups fire pre-promotion, scope-still-open chain. [Q10](./questions.md#q10--commit-semantics-ordering-atomicity-deferred-fires) (commit semantics) is upstream.
- **K3.** Action body calls `setX` where `X` is updated by an effect that was itself triggered by that write (would-be cycle). Tests: cycle detection under scope; policy bans or runs.
- **K3b.** _Conditional on K3 permitting the second write._ If the policy permits, does the effect body's read of a derived `f(X)` see fresh-fresh (both writes propagated), fresh-stale (first write's derived cached, second pending), or some other coherence break? May be moot if K3 resolves to "ban."

### L. Boundary-bypass reads inside speculation

- **L1.** `untrack(() => get(node))` inside an action body. Tests: read forms no tracking edge; do writes performed inside the `untrack` block still tag with the action's scope? _Tracker and scope are decoupled per [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified), so the answer is plausibly "yes for writes, no for tracking edges" — but this is exactly the case where [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified) bites._
- **L2.** `latest(node)` inside an action that has _also written_ to `node`. Tests: does `latest` see the _pre-action_ committed value, or the most-recently-promoted ancestor (which doesn't exist yet if the action hasn't committed)? Edge of selector design.
- **L3.** `peek(node)` inside an action that has written to `node`. Tests: `peek` is untracked but scope-aware; should return the action's slot value. Distinct from J2 (which is for a non-written node).

### M. Resource ownership across speculation

- **M1.** Action body opens an external resource (`new WebSocket(...)`, `setInterval`) and registers `onCleanup(close)`. Tests: on commit, does the resource live on past the scope? Owned by what? On discard, cleanup fires.
- **M2.** A `computed` is allocated inside an action body. Tests: owned by the action's scope (disposes on discard) or by the surrounding parent owner? Different answer from a signal (J4)?
- **M3.** An `effect` is allocated inside an action body. Tests: same as M2 for effects. The effect's own owner is the action's scope; its re-run discipline interacts with H1.

### R. Scheduling & frame coordination

- **R1.** A speculative scope's commit timing: immediate vs deferred to the next animation frame. Tests: is commit timing a scope-policy option (`closeScope(S, 'commit', { schedule: 'raf' })`), a walk concern, or out of scope?
- **R2.** Two speculations want to commit in the same frame: coalesce or independent? Touches Dim 4 with a _timing_ dimension that F2 lacks.
- **R2b.** Both speculations wrote `X`; both commit in the same frame. What does a derived `f(X)` see _between_ the two commit promotions if the scheduler runs them sequentially? **Inter-commit-window coherence** probe. Cuts multiple ways depending on whether the scheduler emits invalidations per-commit or coalesces.
- **R3.** A long-lived action whose body yields control via `requestAnimationFrame` between writes. Tests: scope persists across frame boundary; ambient restoration works for raf-style awaits the way it does for promise awaits (C2).

### W. Writes into derivations (`signal(fn)`)

A derivation that also has a setter, so one value has two sources: the stage chain that computes it, and a direct write. The settled semantics and the mechanism are in [the writable derived signal design](../superpowers/specs/2026-08-18-writable-derived-signals-design.md). These scenarios exist to check that design against use, and they have already changed it twice: W10 established that a cancelled upstream stage must be left dirty rather than clean, and W1 established that the update function must receive the last resolved value rather than the raw published read. All twenty-two were walked on 2026-08-18; thirteen held, six had friction worth designing around, three exposed defects (W5, W13, W22), and one defect predating this work was found in `computed` (see [`docs/follow-ups.md`](../follow-ups.md)).

**Single stage**

- **W1.** Write while the stage's fetch is in flight. The base case. Tests: the fetch is abandoned and never publishes.
- **W2.** Write while nothing is running. Tests: the value is replaced and the body does not re-run.
- **W3.** Write before the signal has ever been read — seeding from a cache during startup. Tests: the first read starts the body, and stale-while-revalidate keeps the written value visible until the fetch lands rather than blanking it. ✓ (Walked; better than the design predicted, which expected the write to be erased by the first read.)
- **W4.** Write, then a dependency changes. Tests: the derivation takes over and the write is gone.
- **W5.** Write onto a parked failure. Tests: the failure clears and a `<Failed>` boundary stops showing its fallback.
- **W6.** Write a promise. Tests: `isPending` is true while it is in flight, `use()` suspends on it, `latest` degrades to the prior value.
- **W7.** Write a promise, then a dependency changes before it settles. Tests: two promises are outstanding — which one is allowed to publish.

**Multi-stage**

- **W8.** Fetch in the tail, write to the tail. W1 with stages in front of it.
- **W9.** Fetch in a middle stage, write to the tail. Tests: the middle stage's fetch is abandoned.
- **W10.** W9, then a dependency only the tail reads changes. Tests: what the tail recomputes from. ✓ (Walked; see the design's cancellation-state section. Established that a cancelled upstream stage must be left dirty rather than clean, or the pipeline is permanently serving data from an input that has since moved.)
- **W11.** W9, then the middle stage's own dependency changes. Tests: whether the abandoned fetch restarts, and what the tail shows while it is in flight.
- **W12.** Two stages both in flight, write to the tail. Tests: both are abandoned, and the pending answer for the pipeline goes false exactly once.
- **W13.** A middle stage is a paused generator holding a resource, write to the tail. Tests: its `finally` runs and its registered cleanups fire, so a wired abort controller aborts.

**Under an action**

- **W14.** Write inside an action that commits, with a fetch in flight. Tests: cancellation happens at commit, not at write.
- **W15.** Write inside an action that is discarded, with a fetch in flight. Tests: the fetch survives and publishes, so the refresh is not lost to an unrelated failure.
- **W16.** Write inside a nested action; the inner commits, the outer discards. Tests: cancellation waits until the value reaches the committed world rather than firing on the inner commit.
- **W17.** Write inside an action; the derivation lands while the action is still open. Tests: the value that appears outside the action and is then replaced at commit.
- **W18.** `cancel(x)` inside an action, then discard. Tests: cancellation is a side effect and is not rolled back.

**Ordering**

- **W19.** Invalidate then write, same tick (`setVersion` then `setTodos`). Tests: the queued run is withdrawn and the write stands.
- **W20.** Write then invalidate, same tick. Tests: nothing is queued at write time, so the later change runs and wins.
- **W21.** Two writes in one tick. Tests: the last one wins and cancellation happens once.
- **W22.** Write from inside the derivation's own body. Re-entrancy; the analogue of K1.

### Probably out of scope for the research phase

These shapes were considered and judged probably-out-of-scope for now, but named explicitly so the catalog isn't silent about them. Any of them may move into scope if a use-case pulls them in.

- _N. Debugging / DevTools introspection._ Visiting every slot/edge for inspection without forming subscriptions.
- _O. Persistence / serialization._ Snapshotting committed state to IndexedDB; serialising slot recipes is non-trivial since they're code.
- _P. SSR / hydration / streaming._ Resuming a Node's slot from server-serialised state without recomputing.
- _Q. Cross-thread / cross-tab._ Worker postMessage, BroadcastChannel, storage events driving slot writes.
- _S. Memory pressure / GC._ Steady-state cardinality of `node.slots`; per-tenant / per-route scopes never closing.
- _T. Testing affordances._ Mocking a signal's `defaultRecipe` in a test; "dry-run" actions that don't commit.

If pulse ends up taking any of these on, this section is where they get promoted to a real category.

### Architectural distribution

- _A:_ single-scope mechanics — most settled; A2 traced.
- _B:_ lifecycle — mostly settled by scope/owner framing.
- _C:_ async — biggest open area ([Q4](./questions.md#q4--async-at-the-engine-level)). _C2 specifically is the highest-yield single trace: it pressures all four framings (Node-as-recipe, walks-first-class, slim-engine + thick-library, scope/owner unification) simultaneously._
- _D:_ concurrence — mechanically straightforward under Model 2.
- _E:_ supersession — mechanism settled; policy open.
- _F:_ overlap — policy is the question, not mechanism.
- _G:_ nesting — depends on commit-promotion semantics (same question as F2 at a different depth).
- _H:_ effects — large open area, but the load-bearing question is really [Q3](./questions.md#q3--consumer-patterns) (consumer pattern), which is _upstream_ of much of C-engine, H, and I. [Q3](./questions.md#q3--consumer-patterns)'s priority ≥ H's.
- _I:_ JSX/components — downstream of H/[Q3](./questions.md#q3--consumer-patterns).
- _J:_ edges — mostly mechanical verification.
- _K:_ re-entrancy — **pressures more framings simultaneously than any other category** (Node-as-recipe + walks + scope/owner + [Q1](./questions.md#q1--fall-through-and-edge-policy) + [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified) + commit-ordering). Missing from the initial priority ranking; should be high.
- _L:_ boundary-bypass — small, targeted, exposes [Q8](./questions.md#q8--tracker-vs-scope-separate-or-unified) concretely.
- _M:_ resource ownership across commit boundaries — the unstated half of B3; load-bearing for scope/owner unification.
- _R:_ scheduling — touches Dim 3 (priority) which the main doc punts; pulse hasn't articulated against the framings.

Categories where the architecture is most under-specified: **C (async)**, **H (effects)** _via Q3_, **G (nesting commit-promotion)**, and **K (re-entrancy)** — added after agent review. Categories where the mechanism is settled but a policy decision still needs to be made: **E (supersession)**, **F (overlap)**, **R (scheduling)**.

_Priority for the next trace, ranked:_ **(1) C2** — single trace, biggest yield. **(2) Q3-via-H1a-c** — establishes the consumer pattern [Q3](./questions.md#q3--consumer-patterns), which is upstream of much else. **(3) K1** (setter mid-recompute) — pressures most framings simultaneously. **(4) G2** (inner-commit-to-outer-or-ROOT) — small, cheap, forces a policy out into the open. **(5) H3** (cleanup chains across speculative effect runs) — where scope/owner unification either holds or breaks.

---

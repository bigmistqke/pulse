# Pulse — scenario catalog

A map of architecturally-distinct cases the engine + speculation machinery
needs to handle. **Each scenario is intended to become a test case (TDD).**
The catalog deliberately favours *specificity over generalisation*: distinct
cases stay distinct even when they look similar, because each will be its
own test.

**Companion documents:**
- [README.md](./README.md) — framings, falsified hypotheses,
  engine/library sketches, open questions ([Q1](./questions.md#q1) through [Q12](./questions.md#q12)), threads.
- [scenario-traces.md](./scenario-traces.md) — end-to-end traces of the
  ✓-marked scenarios below.

**Legend:** ✓ marks a scenario that's been traced end-to-end (see
[scenario-traces.md](./scenario-traces.md) for the trace). Everything else
is open.

**Tracing discipline.** When a scenario is traced, record both the
decisions the trace exposed and *the alternatives that weren't taken* —
otherwise the first plausible trace becomes the route by default, which
is exactly the premature commitment the explorative phase is meant to
avoid.

**Related pulse-repo docs:**
- [`../research/async/CONTEXT.md`](../research/async/CONTEXT.md) — speculation lexicon, four dimensions, failure modes.

## Traces (in [scenario-traces.md](./scenario-traces.md))

Each trace walks a scenario end-to-end through engine + library calls.

- [**doubleName trace**](./scenario-traces.md#end-to-end-trace-doublename-under-scope-s) — exercises A2, B1, B2.
- [**C2 trace**](./scenario-traces.md#end-to-end-trace-c2--action-body-with-async-read) — exercises C2a, C2b, C2c, C2d.
- [**H1a-c trace**](./scenario-traces.md#end-to-end-trace-h1a-c--effect-under-speculation) — exercises H1a, H1b, H1c.
- [**K1 trace**](./scenario-traces.md#end-to-end-trace-k1--re-entrant-setter-mid-recompute) — exercises K1a, K1b.
- [**G2 trace**](./scenario-traces.md#end-to-end-trace-g2--nested-actions-and-commit-promotion) — exercises G1, G2, G3, G4.
- [**H3 trace**](./scenario-traces.md#end-to-end-trace-h3--cleanup-chains-across-speculative-effect-runs) — exercises H3 (a, b, b').
- [**C2e trace**](./scenario-traces.md#end-to-end-trace-c2e--post-yield-derived-read-async-k1b-analogue) — exercises C2e.
- [**H1d trace**](./scenario-traces.md#end-to-end-trace-h1d--effect-body-coherence-on-commit) — exercises H1d.

---

### A. Single speculation, sync (Dim 1 — internal structure)

- **A1.** `setX` inside action, read `X` back inside the same action. Tests
  whether a write sees itself on subsequent read inside the scope. *Expected:
  yes — the slot at `S` is what reads see.*
- **A1b.** Same as A1 but interleaved with derived reads:
  `setX(1); get(f(X)); get(X); get(f(X)); setX(2); get(f(X))`. Tests
  that all reads — primitive *and* derived — see fresh values in the same
  scope tick, not just the self-read. (A1 alone could "pass" on a
  single-slot bag without ever invalidating derivative caches.)
- **A2.** ✓ `setX`, read derived `f(X)` — the `doubleName` case. Traced.
- **A3.** Action writes multiple signals (`setX`, `setY`); read derived
  `f(X, Y)`. Tests whether multiple scope-tagged slots compose into one
  derived under the same scope. *Expected: yes — recipe runs once, reads
  each under `S`. Conditional on [Q8](./questions.md#q8) (tracker-as-scope) and [Q1](./questions.md#q1) selector
  dedup behaving correctly under multi-source reads.*
- **A3b.** Order-sensitive intermediate coherence:
  `setX(...); get(f(X, Y)); setY(...); get(f(X, Y))`. Tests whether the
  intermediate read sees `f(newX, oldY)` (Position C synchronous fires
  propagate dirty mid-action) or `f(oldX, oldY)` (Position B
  derived cache only invalidated at action end). Action-body analogue of
  K1b. *Expected under (C): fresh on each read.*
- **A4.** Action writes one signal; two distinct deriveds depend on it. Tests
  that both deriveds invalidate independently and re-read under `S`.
- **A4b.** Sibling-derived coherence: after `setX`, read derived `d1`, then
  derived `d2`. Are both fresh? Does reading `d1` first somehow pin a
  stale cache for `d2`? Probes whether mid-action recompute of one
  derived leaks staleness to its sibling. Cuts multiple ways depending
  on [Q1](./questions.md#q1) selector dispatch ordering.
- **A5a.** Functional setter: `setX(x => x + 1)` inside action. Tests *what
  the setter callback's `x` parameter is*: committed value or speculative-
  slot value. Library-API design question.
- **A5b.** Functional setter, write side: where does the setter's returned
  value land? Tests that the write goes to the speculative slot at `S`,
  consistently with sync `setX(v)`. *Expected: yes.*
- **A5c.** Functional setter callback reading a downstream derived:
  `setX(x => { const d = get(f(X)); return d + 1 })`. Tests what the
  derived `f(X)` seen inside the callback reflects — the pre-setter
  committed `X`, the speculative `X` (if outer action ongoing), or some
  half-state. K1b's mirror inside a setter callback rather than a
  computed recipe.
- **A6a.** Conditional read in a recipe under `ROOT_SCOPE`: branches change
  on input. Tests dynamic deps (drop edge for not-taken branch, form edge
  for taken). *r3 baseline; no new behavior.*
- **A6b.** Same conditional read, recipe invoked under a non-root scope
  `S`. Tests dynamic deps *under scope*: scope-tagged edges drop / form as
  branches change. This is where Model 2 is exercised; A6a is a smoke
  prerequisite.
- **A6c.** Conditional read under `S` where the condition's input was just
  written, then the same conditional derived is read twice in succession.
  Tests coherence of *graph shape changes mid-recompute*: does the second
  read see the new branch's value (fresh dep-graph + fresh cache) or a
  hybrid (new branch chosen but evaluated against stale upstream slot)?
- **A7.** Action reads only — never writes. Tests whether slots get created
  under `S` for memoisation purposes, or whether read-only access is a no-op
  at the bag level.

### B. Lifecycle & cleanup

- **B1.** ✓ Action returns normally → commit. Traced.
- **B2.** ✓ Action throws → discard. Traced.
- **B3.** `onCleanup(fn)` inside action body. Tests: discard fires `fn`;
  commit doesn't. Working hypothesis from [Q2](./questions.md#q2).
- **B4.** Owner of the action is disposed mid-action (parent owner unmounts).
  Tests: action's scope discards as a consequence of owner disposal. Falls
  out of scope/owner unification if it holds.

### C. Async (Dim 1 with async — Q4 territory)

- **C1.** `setX(Promise.resolve("v"))` inside action — the new recipe returns
  a Promise. Tests: how does a derived `get(X)` see this? Walks decide.
- **C1b.** After `setX(promise)`, in the same scope, read a derived `f(X)`
  whose recipe does `get(X).then(...)` or `yield* get(X)`. Tests: does
  the derived's slot capture the *same Promise identity* the setter
  wrote, or a different one (e.g., re-wrapped)? Promise identity =
  supersession signal per main-doc D8.
- **C2a.** Action body `yield* get(asyncSignal)` — body parks until promise
  resolves *before any other event*. Tests: does the scope stay open across
  the await? Does the ambient scope restore correctly on resume?
- **C2b.** Same, but the awaited promise resolves *after* the action would
  have committed had it been synchronous (i.e., the scope stays open across
  a long await). Tests: long-lived open scopes; resource holding.
- **C2c.** Same, but a supersession (E1) arrives while the action body is
  parked at the `yield*`. Tests: discard mid-coroutine; cancellation
  reaches the in-flight promise via `onCleanup`.
- **C2d.** Same, but writes occur (from a different scope, or from
  ROOT_SCOPE) during the await window. Tests: when the action body resumes,
  what does its read see? Did the chain re-evaluate?
- **C2e.** Post-yield derived read: action body does
  `yield* get(asyncSignal); const d = get(downstreamDerived)`. The
  derived's recipe reads `asyncSignal`. Tests: after resume, does the
  derived see the *resolved* value of `asyncSignal`, or the still-
  Promise-cached value in `slot[S]`? Must the engine's slot-changed
  `'resolved'` event have fired (and been observed by the derived's
  slot) *before* the body's resume runs? **Async analogue of K1b** —
  the canonical post-async-coherence probe. Cuts at least two ways
  depending on microtask ordering vs engine's synchronous `.then`
  handling.
- **C2f.** Two sequential `yield* get`s of *different* async signals in
  the same body, with a downstream derived depending on both. Probe:
  between yields, does the derived see (resolved-A, pending-B)
  coherently? Probes per-step in-recipe coherence across multiple
  awaits.
- **C3.** Async signal resolves *after* the action commits — what value lands
  in canonical? The action committed a Promise; resolution happens later
  under no scope. Library policy.
- **C4.** Concurrent in-flight async + new action arrives. Tests:
  supersession + async cancellation interaction.
- **C5.** Action body awaits external work (not a signal — a fetch). Tests:
  AbortController via `onCleanup` on discard. Cancellation discipline.

### D. Concurrence (Dim 2 — disjoint state)

- **D1.** Two actions `S1`, `S2`, writing disjoint signals. Independent
  slots; both commit; no interaction. Should be trivial — slots keyed by
  scope.
- **D2.** Two actions, both read same signal but only one writes. Reader's
  edges register against the writing scope's chain; should fire correctly on
  writer commit. *Conditional on commit-ordering open question (trace step 5
  open question #1).*
- **D2b.** After writer commits, but inside reader's still-open scope,
  reader reads a derived that depends on the writer's signal. Probe: does
  the derived see the just-committed value (`ROOT_SCOPE` chain entry
  updated, reader's chain `[S_reader, ROOT]` walks to ROOT), or did the
  reader's scope already memoize a slot from before the commit?
  Coherence across the chain when a *more-canonical* entry updates
  underneath an open scope.
- **D3.** Late subscriber: component mounts mid-action and reads under that
  action's scope. Edge formed with the right chain at subscription time.
  Should fall out of Model 2.

### E. Supersession (Dim 3) — *policy question*

- **E1a.** New action arrives while old in-flight; old structurally
  cancelled by closing its scope with `discard`. Tests: scope-discard
  mechanism — slots drop, edges cleanup, cleanups fire.
- **E1b.** Discarded scope's `onCleanup` chain aborts an `AbortController`
  that the action body installed for an in-flight fetch. Tests: cancellation
  reaches in-flight async work via the cleanup chain ([Q2](./questions.md#q2) + [Q2](./questions.md#q2)
  composition).
- **E2.** Old action and new action coexist (no auto-supersession). Both
  scopes alive; reads under each see their own overlay. Likely default.
- **E3.** Rapid sequence of supersessions (typing in an input). Scope churn
  doesn't leak; cleanups fire promptly. Pressure test.

### F. Overlap (Dim 4 — entanglement) — *policy question*

- **F1.** Two concurrent actions both write same signal. Which scope's slot
  is in play for which reader? Two scopes, two slots, no merge — pulse-
  direction lean.
- **F2.** Two actions commit in sequence; both touched the same signal.
  Commit order determines final canonical. Last-writer-wins per the lean;
  Solid auto-merges (which pulse rejects).
- **F3.** Concurrent actions where one's read-set overlaps the other's
  write-set (one reads `X`, other writes `X`). Reader's selector decides
  what it sees — selector with chain `[my_scope, ROOT]` doesn't see other
  scope's write. ✓ (Selector design verified.)

### G. Nesting (scope hierarchy)

- **G1.** Action inside an action. Inner scope is child of outer. Writes
  tagged with inner scope; reads inside inner walk chain `[inner, outer,
  ROOT]`. Falls out of the chain framing.
- **G1b.** Outer wrote `setX('outer')`; inner opens, writes
  `setX('inner')`. Inside inner, read `X` and derived `f(X)`. Then —
  *hypothetical interleave* — control returns to outer mid-inner and
  outer reads `X`. Does outer see `'outer'` (chain skips inner) or
  `'inner'` (chain inherits)? Whether this scenario is even reachable
  depends on whether actions can interleave; if not, mark as
  out-of-scope or conditional.
- **G2.** Inner commits → its slots promote to outer's scope (not ROOT).
  Outer commits → outer's slots promote to ROOT. Two-stage promotion. *Open:
  does inner-commit promote to outer or directly to ROOT? Lean: to outer,
  preserving nesting.* See F2 — same commit-promotion question at outer-most
  depth.
- **G3.** Inner commits; outer discards. Inner's promoted-to-outer slots get
  discarded with outer. Nesting respects parent lifecycle.
- **G4.** Inner discards; outer continues. Inner's writes drop; outer's
  state unchanged.
- **G4b.** Outer wrote `setX('outer')`. Inner opens, writes
  `setX('inner')`, discards. Outer then reads `f(X)`. Tests: does the
  discard cleanly detach inner's slot from outer's chain such that
  outer's derived `f(X)` recomputes against `'outer'`, not against a
  half-cleaned `'inner'` cache? Coherence-of-discard probe for the
  outer body's subsequent reads.

### H. Effects under speculation — *Q3 open*

- **H1a.** Effect registered outside; speculative write happens inside an
  action. Tests *during the action*: does the effect fire? *Lean: no
  (defer-until-commit).*
- **H1b.** Same setup; action commits. Tests *after commit*: does the
  effect fire exactly once with the committed value? *Lean: yes.*
- **H1c.** Same setup; action discards. Tests: effect never fired
  (no speculative trigger leaked). *Lean: yes.* (H1a/b/c together
  establish the defer-until-commit position from [Q3](./questions.md#q3).)
- **H1d.** Effect body reads `get(X)` *and* `get(f(X))`. Action writes
  `setX(5)`, commits. Effect schedules and runs. Tests: does the effect
  see (X=5, f=10) coherently, or could it see (X=5, f=stale) because the
  derived's slot at `ROOT_SCOPE` wasn't invalidated in dep-order during
  commit promotion? **Effect-body coherence on commit** — probes
  commit-promotion ordering ([doubleName trace](./scenario-traces.md#trace-doublename) open #1) through the
  effect's lens.
- **H2.** Effect created inside an action body. Effect's owner is the
  action's scope; effect's body executes once at registration. Does it
  re-fire on writes inside the same action?
- **H2b.** Effect created inside action `S`, registered against chain
  `[S, ROOT]`. Action body then writes `setX`, then reads downstream
  `f(X)` directly. Then more writes. Tests: when the effect re-fires (if
  it does), what scope chain is active in its body? Does its `get(X)`
  see the latest in-action value, and if it reads a derived, does the
  derived see the same? Separates "did it fire" (H2) from "did it see
  coherent state" (H2b). [Q11](./questions.md#q11) (effect chain policy α/β) is upstream.
- **H3.** Effect with `onCleanup`; speculative write triggers the effect →
  effect's body runs → registers cleanup. If discard, do those cleanups
  fire? Cleanup chains across scopes; tricky.
- **H3c.** After cleanup fires and the body re-runs, does the new body
  see derived-coherent state w.r.t. whatever caused the re-run?
  Post-cleanup body re-run coherence probe.
- **H4.** Effect that itself calls `action(…)` (effect-triggers-action).
  Cycles? Bans? Worth knowing the policy.
- **H5.** Effect-mediated derivation coherence during action. An effect
  maintains a signal `value` derived from `name` (e.g.,
  `effect(() => setValue(get(name) + get(name)))`). An action writes
  `name`, then reads `value`. Tests: does `value` reflect the action's
  `name` overlay (would require eager effect runs, which contradicts
  H1a-c), or the pre-action committed `value` (stale during the action,
  fresh after commit + effect re-run)? **Architectural answer: stale
  during action.** Contrast with K1b's computed-mediated equivalent,
  which sees fresh. The two distinguish the **computed vs effect
  derivation** distinction (see the "Derivation kind matches reactivity
  scope" framing). User-ergonomic implication: effect-driven derivations
  are *deferred*; use `computed` for synchronously-fresh derivations
  inside actions.

### I. Component / JSX integration

- **I1.** JSX expression `{get(name)}` rendered inside a component that's
  *inside* an active action. JSX-binding consumer treated like Effect —
  re-renders on speculative writes? Defers to commit? [Q3](./questions.md#q3) territory.
  *Downstream of H1a-c's resolution.*
- **I1b.** JSX expression `{get(f(X))}` where the component is
  mid-render at the moment of an action commit. Tests: does the
  resulting DOM reflect coherent (X, f(X)) values, or could it tear
  (render uses old X but new f(X) because two reads bracket the commit
  point)? **Tearing/coherence probe for the renderer consumer.** Cuts
  multiple ways depending on whether JSX walks are batched.
- **I2.** Component mounts inside an action. Its computeds and effects
  belong to a child owner of the action's scope. On action discard, all
  the mounted components dispose. Falls out of scope/owner unification.
- **I3.** Component unmounts mid-action. Owner disposes; its subscriptions
  clean up; if the unmount was triggered by an action write, ordering
  matters.

### J. Edge cases / pressure points

- **J1.** `latest(node)` inside an action. `latest` walk uses
  `chainSelector([ROOT_SCOPE])`, sees the committed value, ignores the
  action's overlay. Falls out of selector design.
- **J2.** `peek(node)` inside an action. Untracked read, same scope, no edge
  formed. Trivial.
- **J3a.** `isPending(node)` — definition 1: returns true if *any* scope
  has a slot for the node distinct from the canonical chain endpoint
  (i.e., "something is in flight somewhere").
- **J3b.** `isPending(node)` — definition 2: returns true only if *the
  current scope's slot* has a Promise-valued cache (i.e., "this node is
  pending *for me*"). Distinct walk from J3a; the library should pick one
  (or expose both with different names). [Q4](./questions.md#q4) adjacent.
- **J4.** Action creates a new signal (`signal(initial)` called inside the
  action body). Does the new signal's "initial slot" tag with `ROOT_SCOPE`
  or with the action's scope? Library policy. If with scope: signal
  disappears on discard (probably right). If with ROOT: signal survives
  discard but its values were never written outside the scope (probably
  wrong).
- **J4b.** Action creates signal `Y` via `signal(0)`, then writes
  `setY(1)`, then reads a derived `g(Y)`. Tests: does the derived see
  `1`? Does its scope chain include `S`, or did it form against `ROOT`
  because the signal's initial slot landed there? Coherence test
  downstream of J4's policy decision.
- **J5.** Action body sets a value, then somewhere else (a different scope
  or no scope) reads it. Other scope/no-scope doesn't see the speculative
  value. Falls out — selectors handle.

### K. Re-entrancy & write-during-recompute

- **K1a.** `setX` called from *inside* a computed's recipe body during
  recompute, with *no follow-up read of a downstream derived*. Tests the
  "is this permitted at all?" question. *Resolved: permitted (Position A
  hard-ban is incompatible with effects).*
- **K1b.** *Same as K1a, but the recipe reads a downstream derived after
  the write.* E.g., `computed(() => { setName("name"); return
  get(doubleName).capitalize() })`. Tests **in-recipe coherence**: does
  the post-write read see the *fresh* derived value, or the stale
  cached one? This is the case that exposes (B) deferred-fires vs (C)
  synchronous-fires. *Resolved: (C) synchronous-fires gives fresh; (B)
  gives stale.*
- **K2.** `setX` called from inside `onCleanup` of a slot being dropped
  during commit (cleanup chain triggers further writes). Tests: re-entrant
  write during commit; commit-ordering subtlety (trace open question #1).
- **K2b.** `onCleanup(() => { setOther(get(derivedFromX)) })`. Inside
  the cleanup, after the write to `Other`, is `get(derivedFromX)`
  reading a slot in a half-promoted state? Does the cleanup observe
  `X`'s pre-promotion or post-promotion value? Does the write to
  `Other` land in a still-open scope, in `ROOT`, or trigger commit-time
  re-entrancy? **Cleanup-time re-entrancy + coherence probe.** Cuts
  multiple ways: (i) commit is atomic, cleanups see post-promotion
  state; (ii) cleanups fire mid-promotion, half-state; (iii) cleanups
  fire pre-promotion, scope-still-open chain. [Q10](./questions.md#q10) (commit-as-
  transaction) is upstream.
- **K3.** Action body calls `setX` where `X` is updated by an effect that
  was itself triggered by that write (would-be cycle). Tests: cycle
  detection under scope; policy bans or runs.
- **K3b.** *Conditional on K3 permitting the second write.* If the policy
  permits, does the effect body's read of a derived `f(X)` see fresh-
  fresh (both writes propagated), fresh-stale (first write's derived
  cached, second pending), or some other coherence break? May be moot
  if K3 resolves to "ban."

### L. Boundary-bypass reads inside speculation

- **L1.** `untrack(() => get(node))` inside an action body. Tests: read
  forms no tracking edge; do writes performed inside the `untrack` block
  still tag with the action's scope? *Tracker and scope are decoupled per
  [Q8](./questions.md#q8), so the answer is plausibly "yes for writes, no for tracking edges"
  — but this is exactly the case where [Q8](./questions.md#q8) bites.*
- **L2.** `latest(node)` inside an action that has *also written* to `node`.
  Tests: does `latest` see the *pre-action* committed value, or the
  most-recently-promoted ancestor (which doesn't exist yet if the action
  hasn't committed)? Edge of selector design.
- **L3.** `peek(node)` inside an action that has written to `node`. Tests:
  `peek` is untracked but scope-aware; should return the action's slot
  value. Distinct from J2 (which is for a non-written node).

### M. Resource ownership across speculation

- **M1.** Action body opens an external resource (`new WebSocket(...)`,
  `setInterval`) and registers `onCleanup(close)`. Tests: on commit, does
  the resource live on past the scope? Owned by what? On discard, cleanup
  fires.
- **M2.** A `computed` is allocated inside an action body. Tests: owned by
  the action's scope (disposes on discard) or by the surrounding parent
  owner? Different answer from a signal (J4)?
- **M3.** An `effect` is allocated inside an action body. Tests: same as
  M2 for effects. The effect's own owner is the action's scope; its
  re-run discipline interacts with H1.

### R. Scheduling & frame coordination

- **R1.** A speculative scope's commit timing: immediate vs deferred to
  the next animation frame. Tests: is commit timing a scope-policy option
  (`closeScope(S, 'commit', { schedule: 'raf' })`), a walk concern, or out
  of scope?
- **R2.** Two speculations want to commit in the same frame: coalesce or
  independent? Touches Dim 4 with a *timing* dimension that F2 lacks.
- **R2b.** Both speculations wrote `X`; both commit in the same frame.
  What does a derived `f(X)` see *between* the two commit promotions if
  the scheduler runs them sequentially? **Inter-commit-window
  coherence** probe. Cuts multiple ways depending on whether the
  scheduler emits invalidations per-commit or coalesces.
- **R3.** A long-lived action whose body yields control via
  `requestAnimationFrame` between writes. Tests: scope persists across
  frame boundary; ambient restoration works for raf-style awaits the way
  it does for promise awaits (C2).

### Probably out of scope for the research phase

These shapes were considered and judged probably-out-of-scope for now, but
named explicitly so the catalog isn't silent about them. Any of them may move
into scope if a use-case pulls them in.

- *N. Debugging / DevTools introspection.* Visiting every slot/edge for
  inspection without forming subscriptions.
- *O. Persistence / serialization.* Snapshotting committed state to
  IndexedDB; serialising slot recipes is non-trivial since they're code.
- *P. SSR / hydration / streaming.* Resuming a Node's slot from server-
  serialised state without recomputing.
- *Q. Cross-thread / cross-tab.* Worker postMessage, BroadcastChannel,
  storage events driving slot writes.
- *S. Memory pressure / GC.* Steady-state cardinality of `node.slots`;
  per-tenant / per-route scopes never closing.
- *T. Testing affordances.* Mocking a signal's `defaultRecipe` in a test;
  "dry-run" actions that don't commit.

If pulse ends up taking any of these on, this section is where they get
promoted to a real category.

### Architectural distribution

- *A:* single-scope mechanics — most settled; A2 traced.
- *B:* lifecycle — mostly settled by scope/owner framing.
- *C:* async — biggest open area ([Q4](./questions.md#q4)). *C2 specifically is the highest-
  yield single trace: it pressures all four framings (Node-as-recipe,
  walks-first-class, slim-engine + thick-library, scope/owner unification)
  simultaneously.*
- *D:* concurrence — mechanically straightforward under Model 2.
- *E:* supersession — mechanism settled; policy open.
- *F:* overlap — policy is the question, not mechanism.
- *G:* nesting — depends on commit-promotion semantics (same question as
  F2 at a different depth).
- *H:* effects — large open area, but the load-bearing question is really
  [Q3](./questions.md#q3) (consumer pattern), which is *upstream* of much of C-engine, H, and
  I. [Q3](./questions.md#q3)'s priority ≥ H's.
- *I:* JSX/components — downstream of H/[Q3](./questions.md#q3).
- *J:* edges — mostly mechanical verification.
- *K:* re-entrancy — **pressures more framings simultaneously than any
  other category** (Node-as-recipe + walks + scope/owner + [Q1](./questions.md#q1) + [Q8](./questions.md#q8) +
  commit-ordering). Missing from the initial priority ranking; should be
  high.
- *L:* boundary-bypass — small, targeted, exposes [Q8](./questions.md#q8) concretely.
- *M:* resource ownership across commit boundaries — the unstated half of
  B3; load-bearing for scope/owner unification.
- *R:* scheduling — touches Dim 3 (priority) which the main doc punts;
  pulse hasn't articulated against the framings.

Categories where the architecture is most under-specified: **C (async)**,
**H (effects)** *via Q3*, **G (nesting commit-promotion)**, and **K
(re-entrancy)** — added after agent review. Categories where the mechanism
is settled but a policy decision still needs to be made: **E (supersession)**,
**F (overlap)**, **R (scheduling)**.

*Priority for the next trace, ranked:* **(1) C2** — single trace, biggest
yield. **(2) Q3-via-H1a-c** — establishes the consumer pattern [Q3](./questions.md#q3), which
is upstream of much else. **(3) K1** (setter mid-recompute) — pressures
most framings simultaneously. **(4) G2** (inner-commit-to-outer-or-ROOT) —
small, cheap, forces a policy out into the open. **(5) H3** (cleanup chains
across speculative effect runs) — where scope/owner unification either
holds or breaks.

---


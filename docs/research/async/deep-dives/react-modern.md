# React modern — Suspense, transitions, lanes, `use`, `useOptimistic`

**Type:** primary
**Taxonomy row(s) affected:** "React modern (Suspense / transitions / lanes / `use()` / `useOptimistic`)" (currently 🟡)
**Status after this dive:** 🟢 verified — cells revised based on primary sources
**Date:** 2026-05-19
**Session:** 6
**Scope note:** Deep-dive on React's modern concurrent-rendering async story: Suspense, transitions, lanes, the `use` API, `useOptimistic`, `useDeferredValue`, Actions / Server Functions. Three motivating threads converge here: (1) the **WIP-tree-as-primitive** open question from session 1; (2) the candidate **dependent-dispatch axis** from session 5 (await-only vs pipelined); (3) the **message-send triangle** from the cross-cutting thread (where does React's `use()` sit on the receiver-existence-state axis?). All three are tested against React's mechanics.

---

## Sources

Primary (react.dev official documentation):

1. **[react.dev — `<Suspense>`](https://react.dev/reference/react/Suspense)** — formal Suspense mechanics; "Suspense-enabled data sources"; reconciliation behavior on suspension; fallback-vs-current-content semantics under transitions.
2. **[react.dev — `use`](https://react.dev/reference/react/use)** — the modern read-a-Promise primitive; "the component calling `use` *suspends* while the Promise passed to `use` is pending"; the unusual "can be called in loops and conditionals" affordance.
3. **[react.dev — `useTransition`](https://react.dev/reference/react/useTransition)** — `isPending` lifetime ("from first `startTransition` call until all Actions complete"); transition interruption ("a state update marked as a Transition will be interrupted by other state updates"); multi-transition batching note.
4. **[react.dev — `useOptimistic`](https://react.dev/reference/react/useOptimistic)** — the precise convergence behavior ("no extra render to 'clear' the optimistic state; the optimistic and real state converge in the same render when the Transition completes"); failure semantics (parent typically doesn't update value, so old value is shown).
5. **[react.dev — `useDeferredValue`](https://react.dev/reference/react/useDeferredValue)** — two-pass rendering ("first React re-renders with the new `query` but with the old `deferredQuery`"); Suspense integration ("if the background update caused by a new value suspends, the user will not see the fallback"); the deferred-render-is-interruptible distinction from debouncing.
6. **[react.dev — Server Functions](https://react.dev/reference/rsc/server-functions)** — the Actions model; `useActionState`; the form `action={...}` integration; progressive enhancement via permalink.

Primary (architecture):

7. **[React 18 WG — concurrent scheduling discussion #27](https://github.com/reactwg/react-18/discussions/27)** — the **31-lane bitmask scheduler**; 5-ms yield interval; the distinction between CPU-bound (single-lane) vs IO-bound (multi-lane) updates with the explicit rationale: "If we were to assign the same lane to all transitions, then one transition could effectively block all other transitions, even ones that are unrelated."

Secondary:

8. Andrew Clark's talks and writings on Concurrent React (referenced through React docs).
9. Practitioner write-ups on Fiber and lanes (DEV / Medium articles surfaced via web search) — used only to confirm terminology already in source 7; not relied on for substantive claims.

Sourcing note: this dive is unusually well-sourced because React's modern documentation IS the primary source for current behavior (the implementation evolves; older blog posts misrepresent current semantics). The "thrown promise" mechanism was previously the model; current `use()` is the documented API. Practitioner Fiber tutorials are *not* primary sources — they consistently lag behind the React team's current invariants.

---

## What it is

React's modern async story is a **lane-based concurrent reconciler** combined with **Suspense as a per-boundary "computation hasn't finished yet" sentinel** and **Actions as a wrapper for async state transitions**. The pieces only make sense together; pulling on any one without the others produces a misleading picture.

**Lanes** are the scheduling substrate. From source 7:

> "React implements 31 priority levels using a bitmask system called 'Lanes.' Each update receives exactly one lane. Same lane = batched rendering; different lanes = potentially separate batches."

The lane assignment determines priority. Higher-priority lanes (typing, click, hover) pre-empt lower-priority lanes (transitions, deferred values, offscreen). The cooperative-multitasking discipline yields every 5 ms to the browser; if the browser's event queue is empty, React resumes immediately.

**Crucially:** transitions get *multiple lanes* rather than a single shared lane. Source 7's explicit reasoning: a shared lane would cause unrelated transitions to block each other. This is the structural mechanism for **multi-transition coordination** — pulse and Solid 2.x both have weaker versions of this same concern.

**The Fiber tree** is React's reactive substrate. There are conceptually two trees at any moment: the **current** tree (mounted, visible to the user) and the **work-in-progress (WIP)** tree (being built in the background, not yet committed). For ordinary high-priority updates the WIP tree commits "immediately" in the same task. For transitions, the WIP tree may be built across many slices, can be discarded if a higher-priority update arrives, and only commits when ready. This is the **WIP-tree-as-primitive** observation surfaced in session 1: React's modern async story is fundamentally "build a speculative tree, commit atomically when ready, discard on pre-emption."

**Suspense** is the per-boundary "computation hasn't finished yet" marker. From source 1:

> "If `children` suspends while rendering, the Suspense boundary will switch to rendering `fallback`."

And the critical reconciliation rule:

> "React does not preserve any state for renders that got suspended before they were able to mount for the first time. When the component has loaded, React will retry rendering the suspended tree from scratch."

The "from scratch" is decisive: **React's Suspense is a re-execution mechanism, not a continuation-resumption mechanism.** This matches session 3's framing — React, like pulse, is in the "encoded algebraic-effect handlers via re-execution" camp, not the "true continuation" camp.

**`use`** is the current API for reading a possibly-pending Promise (or Context) inside render. From source 2:

> "The component calling `use` *suspends* while the Promise passed to `use` is pending."

`use` replaces the older "throw a promise" idiom which is no longer the documented mechanism. The defining ergonomic affordance: `use` can be called in conditionals and loops, unlike traditional Hooks. This is a small detail but it's structurally important: `use(p)` is *not* a hook in the dependency-order sense — it's a generalized "read this thing" operation that participates in suspension. The closest pulse analogue is `use(x)` inside a `<Loading>` boundary.

**`useTransition`** marks updates as non-urgent. From source 3:

> "A state update marked as a Transition will be interrupted by other state updates. For example, if you update a chart component inside a Transition, but then start typing into an input while the chart is in the middle of a re-render, React will restart the rendering work on the chart component after handling the input update."

The interruption is *structural*: the WIP tree is discarded and rebuilt. **This is the cancellation discipline.** It's the same idea as Cap'n Proto's drop-the-reference + GC, but applied to *speculative rendering work* rather than RPC requests.

`isPending` is also explicit and useful: stays true "until all Actions complete and the final state is shown to the user." This is React's equivalent of pulse's pipeline-OR `isPending` walking.

**`useOptimistic`** is the surgically-precise reconciliation primitive. From source 4:

> "There's no extra render to 'clear' the optimistic state. The optimistic and real state converge in the same render when the Transition completes."

This is the key mechanism for the optimistic-reconciliation scenario (S7): the framework guarantees that the *handoff* from optimistic to real state happens in a single render commit, with no intermediate "flash of nothing" state. The optimistic value is "rendered while an Action is in progress, otherwise `value` is rendered" — so reverting on failure is implicit (the parent didn't update `value`; the optimistic disappears).

**`useDeferredValue`** is the two-pass-rendering primitive. From source 5:

> "First, React re-renders with the new `query` but with the old `deferredQuery` (still `'a'`)... `useDeferredValue` is integrated with `<Suspense>`. If the background update caused by a new value suspends the UI, the user will not see the fallback."

This is the **"keep showing what we have while we work on what comes next"** pattern, generalized.

**Actions / Server Functions** unify state transitions, pending state, optimistic updates, and form submission. From source 6: `useActionState` returns `[state, submitAction, isPending]`; forms with `action={...}` are automatically wrapped; Server Actions are dispatched to the server, with progressive-enhancement fallback to an HTML form post. The unification is real: pre-Actions React required users to assemble useTransition + useState + useOptimistic + Promise machinery by hand for every form; with Actions the whole pattern is one hook.

---

## The async-coordination model

### Where async state lives

React's modern async state lives in **three layers**:

1. **The lane-scheduled work queue** — updates carry a lane (a priority), wait their turn, are interleaved with other work, may be interrupted.
2. **The WIP fiber tree** — a speculative parallel copy of the component tree being built in the background.
3. **Component-local state** — `useState`, `useReducer`, `useOptimistic`, refs, contexts. The committed values that the current tree reads from.

This is qualitatively different from pulse's "everything in the reactive graph" or effect-ts's "everything in the Effect runtime." React's commitment is: **state lives in components, scheduling lives in the reconciler, and the reconciler manages a speculative parallel tree to coordinate transitions**.

The reactive integration is **fused**: components, hooks, the dependency graph, the WIP tree, the lanes — all part of one reconciler. There's no separate effect layer (compare Bonsai). Async work flows back into the reconciler via state-setters dispatched inside Actions.

### Conflict-handling policy

Lane-based prioritization with WIP discard. If a high-priority update arrives mid-transition, the in-progress WIP tree is discarded and rebuilt with the new constraints. From source 3:

> "If you update a chart component inside a Transition, but then start typing into an input while the chart is in the middle of a re-render, React will restart the rendering work on the chart component after handling the input update."

Multiple transitions are currently batched together. Source 3 explicitly notes this is "a limitation that may be removed in a future release" — meaning React's eventual destination is multi-transition coordination *without* batching, with independent transitions making independent progress.

This is fundamentally different from STM's retry-on-conflict (effect-ts, Haskell) and from MVCC's snapshot isolation (Postgres). Lane-based pre-emption is closer to **GGPO's rollback netcode**: build a speculative future, throw it away if the world changes, rebuild from the new state.

### Cancellation discipline

**Structural via WIP discard.** When a transition is interrupted (by a higher-priority update or by another transition supplanting it), the WIP tree's accumulated work is discarded. From source 1's reconciliation rule, "React does not preserve any state for renders that got suspended before they were able to mount for the first time" — the discarded WIP work is fully re-executed on retry.

This is a strong cancellation discipline at the rendering level. However:
- **Async work initiated *outside* the WIP tree (e.g. `fetch()` calls inside `useEffect`) is NOT automatically cancelled.** It will resolve, dispatch state updates, and either get incorporated or be ignored depending on what's still mounted.
- **The `AbortController` pattern is required** for actually cancelling in-flight network requests. React doesn't tie them to the WIP-tree lifecycle automatically.

So React's cancellation has two strengths: "structural" for rendering (built into the reconciler) and "convention-based" for I/O effects (use `AbortController`).

### Async representation

**Procedure (a function passed to `startTransition` or a Server Action) + suspending value (a Promise read via `use`).** This is fundamentally different from effect-ts (typed value) or Cap'n Proto (typed pipelining promise) or Bonsai (typed effect-as-value).

The closest pulse analogue: pulse also uses procedure-as-async representation (a `() => Promise<T>` inside `computed`), but pulse's `use(x)` is a *reactive read*, not a Promise-handling operation. React's `use(promise)` is closer to "block this render on this Promise" while pulse's `use(x).field` is "track this dependency, read this field."

The key mechanic: **`use(promise)` triggers re-execution on resolution**. The component body runs again from the top once the Promise resolves; the framework caches the resolved value (via render-time identity) so the second execution doesn't re-fetch. This is the "encoded algebraic effects via re-execution" pattern from session 3.

### Atomicity granularity

**Per-commit** — the WIP tree commits atomically once all suspended boundaries within the transition's scope have resolved (or the transition is pre-empted). From source 1: "newly rendered `Suspense` boundaries will still immediately display fallbacks" — nested Suspense boundaries can commit independently if they're nested inside a transition.

This is conceptually similar to pulse's per-`<Loading>` atomic commit gather, but at a different scale: React's commit is per-WIP-tree-commit (the entire transition's tree commits together unless nested boundaries explicitly opt out via Suspense), while pulse's gather is per-`<Loading>` (each boundary independently commits).

### Discipline location

**Runtime-enforced (fiber reconciler).** The reconciler enforces:
- Lane prioritization and pre-emption
- WIP-tree atomicity
- Suspense boundary semantics
- Render-time effect deferral (effects don't run until commit)
- Hook call-order discipline (in normal hooks; `use` is the exception)

There's no type-level enforcement of effect signatures (compare effect-ts). The discipline is *behavioral*: do this inside `startTransition`, do that inside `useOptimistic`, do the other inside a Server Action. Violation is detected at runtime via console warnings or visible misbehavior, not at compile time.

### Reactive integration

**Deeply fused.** The reconciler IS the reactive engine. There's no separate effect layer; async results flow back into the reconciler via state-setters dispatched inside Actions. This is the same family as pulse and Solid 2.x — distinct from Bonsai (separate effect layer) and effect-ts (orthogonal).

---

## The problem space of transitions — what React's machinery is coordinating

Added after the session-12 cross-cutting synthesis ([LOG.md](../LOG.md) "Transitions branch in four dimensions"). The framing: transitions look like "ad-hoc UI invention" only if you don't notice that they're actually solving a coordination problem across four distinct branching dimensions. React's mechanisms map onto each dimension as follows.

**Dim 1 — Internal branching** (a single transition's speculative future is a *tree* of dependent async work, not a linear chain): handled by the WIP fiber tree + Suspense boundaries. Any pending source caught by a Suspense in the WIP tree contributes to "this transition isn't done yet." The WIP tree commits atomically once all in-scope Suspense boundaries resolve. **Nested Suspense boundaries can opt into independent commits** — the doc notes "newly rendered Suspense boundaries will still immediately display fallbacks" (`react.dev/reference/react/Suspense`), which is React's escape hatch for "this branch is independent; let it commit on its own."

**Dim 2 — Concurrent branching** (multiple transitions in flight simultaneously, each speculating a different future): handled by the lane allocation. The 31-lane bitmask (source 7) is specifically designed so that IO-bound transitions get multiple lanes — *"if we were to assign the same lane to all transitions, then one transition could effectively block all other transitions, even ones that are unrelated."* **Acknowledged limitation:** multiple low-priority transitions are currently batched together (source 3: *"If there are multiple ongoing Transitions, React currently batches them together. This is a limitation that may be removed in a future release."*). React's destination is independent multi-transition progress; the current state is partial.

**Dim 3 — Input-arrival branching** (user input arrives during a transition; the framework must decide cancel/restart/merge/ignore): **React handles this best of any framework studied.** High-priority lanes (typing, click, hover) pre-empt low-priority lanes (transitions, deferred values, offscreen). The in-progress WIP tree is discarded and rebuilt under the new constraints (source 3). Cooperative multitasking yields every 5 ms to the browser (source 7). The user keeps typing while a transition fetches results; input remains responsive because input-class updates preempt the transition's render work mid-build.

**Dim 4 — State-overlap branching** (two transitions touch shared state; the framework must decide whether they're independent or entangled): **NOT handled automatically.** This is the dimension where React's current implementation is weakest. The "multiple low-priority transitions batched together" limitation (Dim 2) conflates the question — transitions are batched regardless of whether they actually touch shared state. There's no entanglement-detection mechanism analogous to Solid 2.x's union-find lane merge. The application is expected to model conflicts in user code (via `useOptimistic`'s revert-on-failure, or via manual reconciliation in Actions).

**The two-dimension takeaway.** React leads on **Dim 3 (input)** via lane-priority pre-emption — pulse and Solid have nothing equivalent. React lags on **Dim 4 (state-overlap)** — Solid's lane-merge-on-overlap handles this automatically; React's batching is a coarser approximation acknowledged as a limitation. Dim 1 and Dim 2 are handled well but not uniquely (other frameworks have comparable mechanisms).

---

## Taxonomy cells

### Where async state lives
**Cell:** fused (in reconciler + WIP fiber tree); component-local state; lane-scheduled work queue
**Evidence:** Source 7 on the lane scheduler. Source 1 on Suspense and WIP-tree reconciliation. Sources 3, 4 on how Action state lives in components but is scheduled via the reconciler. The WIP fiber tree IS where transitional async state lives until commit.

### Conflict-handling policy
**Cell:** lane-based prioritization with WIP discard; high-priority pre-empts low-priority; multi-transition currently batched (limitation acknowledged as removable)
**Evidence:** Source 3 explicit on interruption mechanics. Source 7 on the 31-lane bitmask design — IO-bound transitions get multiple lanes specifically to prevent mutual blocking.

### Cancellation discipline
**Cell:** structural via WIP discard for rendering; convention-only (`AbortController`) for I/O effects
**Evidence:** Source 3 on transition interruption restarting render work. Source 1 on "React does not preserve any state for renders that got suspended before they were able to mount." React's docs don't claim auto-cancellation for in-flight `fetch()` inside effects.

### Async representation
**Cell:** procedure (action / startTransition) + suspending value (`use(promise)` reads a cached Promise); re-execution rather than continuation-resumption
**Evidence:** Source 2 on `use`. Source 3 on `startTransition` taking an action function. Source 1's reconciliation rule ("retry rendering the suspended tree from scratch") confirms re-execution.

### Isolation level
**Cell:** WIP-tree provides a form of "speculative state isolation" — the in-progress transition's rendered output is invisible until commit; current tree state remains visible to user during preparation; `useOptimistic` provides per-action optimistic-state overlay
**Evidence:** Source 1 on transitions not hiding "already revealed content." Source 4 on `useOptimistic`'s convergence behavior. Source 5 on `useDeferredValue`'s "keep showing old value while preparing new" pattern.

### Atomicity granularity
**Cell:** per-WIP-tree-commit; transitions commit atomically once all Suspense in scope resolve (unless nested boundaries opt-in to independent commits)
**Evidence:** Source 1 on Suspense's commit-when-ready behavior; the nested-boundaries-immediate-fallback rule shows the per-boundary granularity option. Source 3 on transition lifecycle.

### Discipline location
**Cell:** runtime-enforced (reconciler) + convention; no type-level enforcement of effect-shape
**Evidence:** React's docs are full of "must be called inside an Action," "must be inside a Component or Hook," "cannot be called in a try-catch block" (source 2) — all behavioral discipline, not type-checked.

### Reactive integration
**Cell:** fused — reconciler is the reactive engine; no separate effect layer; async flows back via state-setters dispatched inside Actions
**Evidence:** Composite of all sources. Compare Bonsai (separate effect layer): React commits to no such separation.

---

## Scenario mapping

| Scenario | Solved? | How |
|---|---|---|
| **S1 — Like/unlike race** | partial | Two rapid clicks dispatch two actions; lane-batching may coalesce them; `useOptimistic` shows latest optimistic value. Server-arrival-order resolves; no automatic conflict detection. Application can implement explicit toggle-cancellation. |
| **S2 — Auto-save vs explicit save** | yes | Both as separate Actions; lane-scheduled. Explicit save can be wrapped in a high-priority lane (or just non-transition state update); auto-save in transition lane. `useOptimistic` shows latest committed payload. Snapshot-of-payload via closure capture at Action-dispatch time. |
| **S3 — Multi-step server flow with partial failure** | partial | Server Actions can `await` multiple steps; failure propagates via thrown error or returned error object. `useActionState` exposes the last result. No automatic compensation; manual try-catch and state-restoration is required. **Less ergonomic than Cap'n Proto pipelining** — each step is a separate await in JS, not a single dependent-dispatch. |
| **S4 — Concurrent independent flows** | yes | Independent transitions get independent lane allocation (per source 7); the batching limitation will eventually be lifted. Currently batched, so "independent" is approximate in practice today. |
| **S5 — Cross-transaction read** | partial | Useful structure exists: `useDeferredValue` keeps old value visible while new is preparing — analogous to "read from snapshot while transaction is in progress." But no formal cross-transaction-read primitive; the WIP tree is invisible to other transitions. |
| **S6 — User-cancellable flow** | yes (rendering) / partial (I/O) | WIP discard handles cancellation at the render layer cleanly. I/O cancellation requires explicit `AbortController` wiring. |
| **S7 — Optimistic reconciliation** | **yes — canonically** | `useOptimistic` is the textbook implementation. Convergence in same render (source 4) avoids the "flash" problem. Failure handling via parent not updating value is structurally clean. |
| **S8 — Preview / what-if mode** | partial | The WIP-tree-as-primitive is conceptually the right shape — "speculative state isolated from current state, commit-or-discard." But there's no API to *expose* the WIP tree's contents while building (you can't "show the user what the preview would look like"); the WIP tree's output is invisible until commit. |

**Policy questions** (per `concurrent-flows.md` Q1–Q5):

- **Q1 (overlay read inside tx):** within a transition's WIP tree, the WIP values are what's being computed but aren't visible to the user; `useOptimistic` provides explicit per-action overlay.
- **Q2 (outside-tx read):** committed truth (the current tree) is what's rendered to the user during transition preparation.
- **Q3 (commit ordering with shared state):** strict — last commit wins; multi-transition batching currently bundles them; lanes prioritize.
- **Q4 (default entanglement):** **lane-based prioritization + WIP discard (c — block on pending, but at the rendering level rather than at the data level).** No automatic field-level detection.
- **Q5 (overlay lifecycle):** `useOptimistic` overlay lives "for the duration of an Action" (source 4); converges in same render as the Action completes.

---

## What an encoding into JS gains or loses

React modern IS a JS encoding. The "what would JS gain" question doesn't apply directly. Instead, the right question is: **what does React's encoding sacrifice that other JS reactive frameworks (pulse, Solid) might preserve?**

### What React gains via its specific encoding

- **Multi-transition coordination via lanes.** The 31-lane bitmask is the cleanest answer in any JS framework to "two unrelated user actions both make progress simultaneously without blocking each other." Solid 2.x has a weaker version; pulse currently has no equivalent (transitions don't compose).
- **Speculative rendering via WIP tree.** Build the next state in parallel without disturbing the current. The clean answer to S8 (preview/what-if) if the WIP tree were *exposable* rather than invisible.
- **Lane-priority for input responsiveness.** Typing/clicking can pre-empt low-priority transitions. This is hard to encode in pulse-style "reactive graph everywhere" because pulse has no notion of "priority" — all updates flow through the same scheduler.
- **`useOptimistic`'s convergence-in-same-render.** The framework guarantees no intermediate render between "optimistic" and "real," eliminating the flash-of-flicker class of bug. Pulse's optimistic story would need explicit work to match this.
- **Actions as a unifying abstraction.** State + pending + optimistic + form-submission + progressive-enhancement in a single hook is genuinely good ergonomics. Pulse lacks an Actions-equivalent.

### What React's encoding sacrifices

- **Re-execution as the suspension mechanism.** Components re-execute from the top when Suspense resolves. This is expensive for components with significant prerender work, and it makes ergonomic patterns like "read the suspended value once and use it many times" surprisingly tricky. Pulse's `use(x).name` doesn't re-execute the whole component — only the dependent computed.
- **Behavioral discipline rather than typed.** "Must be called inside an Action" is a runtime warning. effect-ts catches this at compile time via the `R` parameter.
- **No first-class effect-as-value.** A Server Action is just an async function; there's no `Effect.t` to pass around, compose, store, conditionally dispatch. Bonsai's effects are richer here.
- **Lane batching of multiple transitions (currently).** Acknowledged limitation (source 3); will eventually be removed.
- **No pipelined dependent dispatch.** Each `await` inside a Server Action is a separate sequential roundtrip; there's no analog to Cap'n Proto's "send the whole dependent chain at once."
- **The WIP tree is invisible.** You can't show the user what the in-progress transition's output would look like as it's being prepared — only the final commit, or the previous current state. For S8 (preview/what-if) this is a real limitation.

### JS-specific constraints React works around

- **JS has no native lanes / priorities.** React implements them entirely in userspace via the Scheduler package. The 5-ms yield interval is a software invention.
- **JS has no native continuations.** Suspense's "throw a promise" idiom (now `use()`) is the workaround: throw, catch at boundary, re-execute on resolve. This is the algebraic-effects-encoded-via-re-execution pattern (session 3).
- **JS has no native pre-emption.** Lane interruption is cooperative — React only yields at known checkpoints. A long-running synchronous function inside a render cannot be interrupted.
- **No native multi-shot continuations.** React's transition restart-on-pre-emption fully re-executes from scratch; there's no captured continuation to resume from.

---

## Open questions resolved

### "WIP-tree-as-primitive" (open question from session 1)

**Resolved: yes, it's a primitive — and it deserves taxonomy treatment.**

React's WIP fiber tree is structurally the same family as:
- MVCC's "in-progress transaction has its own visible-only-to-itself state" (Postgres)
- GGPO's "speculative-state-to-be-validated" (rollback netcode)
- Solid 2.x's lane-snapshot (built into the same reactive runtime)
- effect-ts's `STM<A>`-in-progress value before commit

These are all instances of **"speculative state isolated from current state, commit-or-discard"**. This is genuinely a distinct axis from atomicity granularity. Atomicity granularity asks "what scope commits as one unit"; **speculative-state isolation** asks "is there an isolated parallel state being built that's invisible until commit, that can be discarded mid-build?"

**Recommendation: add speculative-state isolation as an axis.** Values:
- **none** — direct mutation; no parallel state (MobX, Zustand, classic Redux)
- **per-action overlay** — explicit user-managed parallel state (`useOptimistic`, custom snapshots)
- **per-transition tree** — runtime-built parallel structure invisible until commit (React WIP fiber tree, Solid 2.x lane snapshots, pulse's `<Loading>` gather)
- **versioned everywhere** — full MVCC (Postgres, Yjs, event sourcing)

The taxonomy currently mixes this concern into "isolation level" and "atomicity granularity" — splitting them clarifies the design space.

### "Dependent-dispatch capability" axis (candidate from session 5)

**Resolved: keep it as a separate axis; React is "await-only" on this axis.**

React's `use(promise)` is mechanically re-execution: read the promise, suspend the component, re-render from scratch on resolve. There's no pipelined dependent dispatch — `use(p).foo` requires `p` to be resolved first, then accessing `.foo` happens in the re-executed render. This is structurally **the same shape as JS Promise + await**, not the same shape as Cap'n Proto pipelining.

The candidate axis "dependent-dispatch capability" is now informed by three datapoints:
- **none / await-only** — JS Promise, React `use`, Solid 2.x async resource, pulse `computed(async)`
- **pipelined** — Cap'n Proto / E / Agoric `E()`
- **pipelined+typed** — Cap'n Proto with IDL schema

React's case strengthens the argument that this axis is meaningful — the *vast majority* of JS-encoded async representations are "await-only" because of the language constraint, but the distinction from pipelining is real and architectural. Promote to confirmed axis once one more system (likely a Replicache/sync-engine dive) provides a fourth datapoint.

### "Message-send triangle" (cross-cutting thread)

**Resolved: React's `use(promise)` sits at the *same corner as pulse's `use(x)`*, not at the middle corner.**

The triangle from the cross-cutting thread:

| Pattern | Receiver existence-state | Firing |
|---|---|---|
| Smalltalk | exists now | one-shot |
| E / Cap'n Proto pipelining | doesn't exist yet | one-shot, eager-dispatch |
| Reactive graphs (pulse, Solid) | currently resolved | continuous |

React's `use(promise)` *appears* to be in the middle corner ("operate on something not yet here") but mechanically it's the third corner (currently-resolved, with re-execution on update). The promise is *read* — its eventual value is what's used, with the component body re-executing once it's resolved. There's no analog to Cap'n Proto's "send a method to the future capability."

This strengthens the triangle's claim to real structural distinction: the middle corner (pipelining) is genuinely uninhabited by current JS frameworks. The TC39 eventual-send proposal (source 5 in session 5's dive) tried to add it; it didn't make it.

**Implication for pulse:** if pulse ever wants to add pipelining-shaped ergonomics, React is not a model to follow — React is the same corner as pulse. Cap'n Proto / Agoric `E()` is the model to follow.

---

## Open questions raised

- **Should "lane-based pre-emption" be its own axis?** It's currently flattened into "conflict-handling policy." But lane pre-emption is structurally different from STM-retry, MVCC snapshot, or Bonsai's serial dispatch: it's *priority-based interruption with restart*. No other system in the taxonomy uses this. Maybe deserves separate axis treatment, or deserves to be a specific value of conflict-handling: "priority-pre-empt-with-restart."
- **Is `useOptimistic`'s convergence-in-same-render replicable in pulse?** Pulse's pipeline-OR `isPending` could in principle handle the "no extra render to clear" pattern, but the optimistic-value-as-distinct-from-real-value mechanism isn't there. A pulse equivalent of `useOptimistic` would need: (1) a way to flag a value as "optimistic, will be replaced by Action result," (2) a guarantee that the replacement happens atomically with the Action's completion. The infrastructure is mostly there; an explicit API would be useful. Worth a design exploration session.
- **Should pulse expose its `<Loading>`-gathered WIP state?** React's WIP tree is invisible until commit. Pulse's `<Loading>` boundary similarly hides in-progress work. The S8 (preview/what-if) scenario suggests there's value in *exposing* an in-progress speculative tree to the user. Is there an API design for this? Worth exploring.
- **Multi-transition coordination in pulse.** React's 31-lane design genuinely solves the multi-transition coordination problem. Pulse has nothing equivalent — transitions don't compose. The lane mechanism is heavy machinery; the question is whether pulse needs something equivalent, or whether the use-case for unrelated concurrent transitions is rare enough that the complexity isn't justified. Open design question.
- **Actions as a unifying abstraction for pulse.** React's Actions hook unifies state-setting + pending + optimistic + form-submission + progressive-enhancement. Pulse currently makes the user assemble this from primitives. A pulse equivalent could be very ergonomic. Worth design exploration after the research surveys enough other systems.
- **Is the WIP-tree exposability a fundamental limitation or a design choice?** Could React expose the WIP tree mid-build? Or does the algebraic-effects-via-re-execution encoding make this fundamentally impossible (because the WIP tree is just re-executing the component, and the user can't observe partial re-execution states)? Worth investigating — could affect pulse's eventual S8 design.

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`algebraic-effects.md`](./algebraic-effects.md) (session 3, concept) — React, like pulse, is in the "encoded handlers via re-execution" camp. The dive confirms this and sharpens what's lost (no true continuation; full re-execution per resolve).
  - [`effect-ts.md`](./effect-ts.md) (session 2) — typed effect representation vs React's behavioral discipline. effect-ts catches at compile time what React catches at runtime via warnings.
  - [`bonsai-incremental.md`](./bonsai-incremental.md) (session 4) — Bonsai's separate effect layer over a reactive graph vs React's fused effect layer in the reconciler. Different architectural commitments; both work; React's is more ergonomic for typical UI, Bonsai's is more disciplined.
  - [`capnproto-e-pipelining.md`](./capnproto-e-pipelining.md) (session 5) — Cap'n Proto's pipelining vs React's `use(promise)`. React is "await-only" on the dependent-dispatch axis; Cap'n Proto is "pipelined." The middle corner of the triangle is uninhabited in current JS frameworks.
- **Taxonomy axes this dive informed:**
  - **WIP-tree-as-primitive resolved as a distinct axis ("speculative-state isolation").** Recommendation: add to the taxonomy. Cuts cleanly across the existing isolation-level and atomicity-granularity values.
  - **Dependent-dispatch capability axis:** React provides a fourth datapoint (await-only via re-execution). Promote candidate to confirmed axis after one more datapoint.
  - **Conflict-handling policy:** suggests "priority-pre-empt-with-restart" as a possible distinct value. Currently the cell just says "lane-based prioritization" which is descriptively accurate but doesn't pattern-match cleanly with the other systems.
  - **Reactive integration:** "fused" confirmed for React; the dive sharpens what fusion means at the reconciler level (the reconciler IS the scheduler IS the effect-runner).
- **Scenarios this dive addressed:** S1 partial, S2 yes, S3 partial (less ergonomic than pipelining), S4 yes (with batching caveat), S5 partial, S6 yes-for-rendering / partial-for-I/O, **S7 yes canonically**, S8 partial (WIP-tree invisible).
- **Cross-cutting threads this dive tested:**
  - **Message-send triangle:** confirmed React's `use(promise)` is the same corner as pulse's `use(x)` (currently-resolved with re-execution), not the middle corner (pipelining). Middle corner remains uninhabited in current JS frameworks.

---

## Notes / aside

- **The "throw a promise" idiom is no longer the documented API for application code.** Older blog posts and tutorials describe React's Suspense as "throw a Promise to suspend"; the current API is `use(promise)`. The throw-mechanism is internal to React's machinery and not user-facing. Practitioner tutorials lag the official docs by years on this and many other React-modern details — useful reminder that "primary source" matters.
- **Server Components are out of scope for this dive but worth noting.** They're a different concern (server-side rendering as a first-class component model) than the client-side async story. A separate dive could examine RSC + Server Actions together, but the async-coordination story documented here is largely client-side.
- **The 31-lane bitmask is genuinely 31, not "around 31."** Source 7's number is exact — `0b1111...` masking gives 31 individually-addressable bits with one reserved. This is a real engineering constraint surfaced as a public-API parameter.
- **The `useTransition` interaction with Suspense fallbacks is more subtle than the docs make obvious.** "Transitions only 'wait' long enough to avoid hiding *already revealed* content" — newly-mounted Suspense boundaries still show fallbacks. This means a transition that crosses into never-before-rendered subtrees doesn't get the smooth-update behavior. Worth flagging if pulse's `<Loading>` design ever considers a similar distinction.
- **The "1 hook to rule them all" trajectory.** React's evolution from `useState + useEffect` to `useTransition + useOptimistic + useActionState + use + useDeferredValue + Actions + Server Functions` is striking. The library is converging on "specialized hooks for each async pattern" rather than "compose primitives." Pulse's design ethos has been more compositional ("signals + computeds + `use()` is enough"). The React trajectory is informative: at scale, specialized abstractions for each pattern (forms, optimistic, transitions) win on ergonomics, but require the framework to bake-in the patterns. Pulse will face this same question at scale.

- **Ricky Hanlon (React core team) on the API complexity — added in a later research pass.** Ricky discusses transitions, `use()`, `useOptimistic`, and Actions on **Syntax.fm episode #943** (["Modern React with Ricky Hanlon"](https://syntax.fm/show/943/modern-react-with-ricky-hanlon-react-core-dev/transcript), transcript fetched). A separate stream on Ryan Carniato's channel ("Innovating React w/ Ricky Hanlon", `youtube.com/watch?v=3vw6EAmruEU`, ~6 hours) is identified by community references but has no available transcript service that worked through `WebFetch` — so this entry uses the Syntax.fm episode as the verifiable primary source for Ricky's framings. Multiple things he says are diagnostically interesting for this dive:

  - **Transitions as transactions / background threads.** *"You can think of a transition as a UI transition. Fundamentally, it's kinda like you can think of it as a maybe a little bit like a transaction or like a background thread."* — Ricky's preferred vocabulary matches the framing this research has settled on independently.

  - **Acknowledged product-code complexity.** *"a lot of product code that's, like, needs to wire up the transitions correctly and use use Optimistic correctly and use all these, like, new hooks in the product code, and you gotta use it all correctly."* This is the React core team explicitly acknowledging that wiring the modern async APIs in product code is hard. The dive's "1 hook to rule them all" trajectory observation above is corroborated from the source.

  - **`use(promise)` is hard today.** *"it's kinda hard today to to, like, fetch with use because you have to use this, like, cached promise thing."* The current ergonomics of the `use` + cached-promise pattern is acknowledged as un-ergonomic by its own team.

  - **Cache invalidation is the hardest part.** *"cache invalidation is harder. And creating a generic API that anybody could use, is, like, the hardest."*

  - **The proposed escape route is library infrastructure, not API ergonomics.** Ricky's vision is that *product devs shouldn't be touching these APIs directly* — instead the APIs get absorbed into **routers, data-fetching libraries, and design-system components**, which provide the experience "for free by default." This is a tacit admission that the ergonomics-by-direct-API bet didn't pay off; the answer is to put another abstraction layer on top.

  - **Hidden implementation detail.** *"the `isPending` flag in `useTransition` is implemented as `useOptimistic`."* This is interesting for the dive because it confirms that React's runtime *fuses* these abstractions internally — at the user level they look like distinct primitives, but mechanically `useOptimistic` is the underlying mechanism that `useTransition`'s pending flag is built on.

  - **Suspense fallback throttling.** *"throttling — maintaining fallback visibility for ≥300ms to batch updates."* Another behind-the-scenes behavior the dive previously didn't note: Suspense doesn't always show fallbacks immediately even when the boundary suspends; it throttles to reduce DOM layout thrashing.

  **What this confirms vs adds.** Confirms the dive's prior framing of React's API complexity as a real trade-off, with a direct quote from the React core team. Adds two mechanically-relevant details (the `useTransition` ↔ `useOptimistic` fusion; the 300ms Suspense-fallback throttling) the dive previously missed. Adds significant philosophical context for the comparison to Solid 2.x — see [`solid-2x.md`](./solid-2x.md)'s parallel note.

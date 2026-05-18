# pulse

A small reactive UI framework built on [`r3`](../r3). Pulse is a research vehicle for exploring an alternative to Solid 2.x's async direction: same fine-grained-reactivity foundation, different choices about how async data, transitions, and atomic commit interact.

For project conventions, language definitions, and architectural decisions, see [`CONTEXT.md`](./CONTEXT.md) and [`docs/`](./docs).

---

## Pulse vs Solid 2.x — A Comparative Analysis

This analysis is based on Solid 2.0-beta as of the time of writing (see the Solid 2.0 RFCs in `solidjs/solid/documentation/solid-2.0/`). Solid 2.x is a substantial reshape from 1.x: `createResource` is gone, `useTransition` / `startTransition` are gone, `<Suspense>` is renamed `<Loading>`, `<ErrorBoundary>` is renamed `<Errored>`, effects are split into compute/apply phases, batching is microtask-by-default, and new primitives (`action`, `createOptimistic*`, `refresh`, `<Reveal>`) cover mutation and coordination.

### 1. Shared foundation (behavior + mechanics)

Both libraries share more than is obvious on the surface:

- **Fine-grained reactivity, no VDOM.** Both compile JSX into direct DOM operations where reactive expressions become per-binding "holes" with marker comments.
- **Components run once.** Reactivity lives in the holes, not in re-executing the function body. Local state created in the body is created once.
- **Owner tree for lifecycle.** Both maintain a parent-child tree of owners that scope reactive nodes and their cleanups. Disposal cascades.
- **Microtask-batched writes.** Both batch state updates on a microtask by default; both expose `flush()` to drain synchronously. Solid 2.x explicitly removed 1.x's synchronous `batch()`; pulse uses the same scheduler shape (microtask default, sync drain for tests via `setScheduler(syncScheduler(flush))`).
- **Async is a computation property, not a separate primitive.** Both libraries removed the "resource is a special thing" stance: a memo / computed body can return a Promise (or be async / generator), and the framework tracks pending state. No `createResource`. The shape *of how a read consumes that promise* differs (Solid auto-suspends on read; pulse returns the Promise or SWR-stale value and requires `use(...)` to suspend — see §2.2 and §2.5).
- **Pending suspension via thrown sentinels.** Both throw a special error class (`NotReadyError` in Solid 2.x, `NotReadyYet` in pulse) carrying the in-flight Promise. A boundary catches it.
- **`<Loading>` as the suspension boundary.** Both name the boundary `<Loading>` (Solid 2.x renamed from 1.x's `<Suspense>`; pulse used `<Loading>` from the start). `<Loading fallback={…}>` shows the fallback while async pending; both default to "hold prior committed tree on revalidation."
- **`isPending(fn)` for revalidation indicators.** Both ship an `isPending` that returns true when a reactive expression is mid-refetch but has a stale value to show. Both are false on the Loading path itself (no stale to mask).
- **`latest()` for stale-while-revalidate reads.** Both expose `latest()` that returns the prior resolved value during refetch without suspending.
- **Owner-scoped error boundary.** Pulse's `catchError(fn, handler)` and Solid 2.x's `createErrorBoundary` / `<Errored>` create a sub-owner with an error handler; non-`NotReady` throws walk up via the owner chain.
- **Push-pull hybrid reactive graph.** Topological dirty-propagation; no diamond glitches.
- **`<For>` / `<Show>` with per-branch sub-owners.** Both create sub-owners for the branch, dispose on toggle.
- **Transitive pending propagation via a dep-graph walk.** Solid 2.x's `isPending(fn)` walks reactive reads inside the thunk to determine pending status. Pulse's `isPending(x)()` walks the pending registry's `upstream` chain. Different mechanism, same idea: "downstream is pending iff itself OR any upstream is." This shape — *a graph of producer→consumer state-tracking with transitive walks* — is the same structural primitive Solid 2.x's lane-entanglement uses; in pulse it's currently applied only to value-propagation pending, but the bones generalize (see §2.13).

### 2. Where pulse diverges — mechanical

#### 2.1 Reactive core is `r3`, not Solid 2.x's `@solidjs/signals`

Both libraries share intellectual lineage (push-pull-push hybrid, milomg's `reactively` / `r2` research informing Solid's signals model), but the runtimes are independent code:

- `r3` is a standalone single-file (~450 LOC) reactive library — signals, computeds, owner, scheduler, topological-height ordering. Minimal surface; no async / no transitions / no boundary primitives.
- `@solidjs/signals` is a full runtime (15+ files in `solid-signals/src/core/`): graph, heap, lanes (for transitions), async-suspension protocol, optimistic flags, owner/scheduler integration, store layer, etc. — all native to the runtime.

Pulse builds async / SWR / boundary semantics in *wrappers* above r3 (each async computed stage = an r3 computed + signals for pending / published-value + a settle handler — see `src/computed.ts:makeStageNode`). Solid 2.x's `createMemo` integrates async directly into the memo's internal state machine, with lane-based transition coordination at the runtime level.

Consequence: pulse can theoretically swap r3 for a different minimal core (the wrappers are the contract), but it pays wrapper overhead. The more interesting consequence is what each library *can build on top* of its core. Solid 2.x's lanes give it: multiple transitions in flight simultaneously, cross-boundary entanglement, optimistic-dirty flagging, and lane-aware Loading-path decisions — all native to the runtime. Pulse's per-`<Loading>` atomic-commit gather is currently the only transition coordination mechanism, scoped to a single boundary.

But the gap is smaller than it looks. Pulse's pending registry already does the *shape* of entanglement — a graph of producer/consumer pending nodes with a transitive `upstream` walk (see §2.13 for what would be needed to extend this to transactions). The gap that's irreducibly "needs a real lane runtime" is lane-aware Loading-path semantics; the rest (transactions, entanglement, optimistic) can plug into existing pulse infrastructure with explicit primitives.

#### 2.2 Per-binding `use()` opt-in vs implicit loading path

In pulse, `use(x)` is the explicit opt-in:

1. Marks the surrounding binding as "transition-engaged" (per-run flag in `transition-tracker.ts`).
2. If `x` is pending → throws `NotReadyYet(promiseOf(x)!)`.
3. Otherwise → returns the value, but still establishes engagement, so the binding's commit later defers if the surrounding `<Loading>` is pending due to a sibling.

In Solid 2.x, there is no `use(x)` marker. ANY read of a memo that returns a Promise — `user()` — throws `NotReadyError` if not ready, no extra call wrapper. The "loading path" is implicit: any read inside a `<Loading>` subtree that reaches an unresolved async value puts that subtree on the loading path.

**Trade-off:** Solid 2.x is more concise (`user().name` just works); pulse is more explicit (`use(user).name` makes the suspension boundary contract visible at the call site, and is grep-able). Pulse's explicit `use` also serves a second purpose Solid doesn't have: marking non-throwing reads for transition coordination (see §2.4).

#### 2.3 Atomic-commit gather (pulse) vs runtime-managed transitions (Solid 2.x)

Pulse's `<Loading>` has an explicit state machine:

- `pendingSet: Set<BindingController>` — controllers currently throwing.
- `readySet: Map<BindingController, () => void>` — controllers that succeeded with a commit waiting.
- `deferredCommits: Array<() => void>` — anonymous commits from `use()`-engaged bindings that didn't throw but need to wait for the gate.

When `pendingSet` empties, all queued commits flush in one pass. A microtask "tail check" handles races where a non-throwing binding queued before any sibling thrower had reported in the same flush.

Solid 2.x handles atomicity at the runtime level: transitions are "built-in, multiple in flight" (RFC 05). The runtime manages which updates land in which transition and coordinates revealing them. The user-facing pieces are `isPending(fn)` (observe) and `<Loading>` (boundary). There's no per-binding `report({ status: 'ready', commit })` API in user view — Solid 2.x's runtime owns the coordination internally.

**Trade-off:** pulse exposes the coordination machinery as a small public API (binding controllers, deferOrCommit) — usable for library authors, debuggable, but the user has to think about it. Solid 2.x hides it entirely — transitions "just work" if you use the primitives correctly, but reasoning about edge cases requires understanding the runtime.

#### 2.4 SWR as default vs SWR via `latest()`

Pulse: every async computed stage holds its prior resolved value during refetch (SWR is the default; `lastResolvedValue` in `makeStageNode`'s closure). Reading `c()` outside a tracking context returns the stale value during refetch.

Solid 2.x: `user()` throws `NotReadyError` during refetch unless you wrap in `latest(() => user())`. The default is "suspend on refetch"; SWR is the opt-in.

**Note:** Solid 2.x's `<Loading>` (without the `on` prop) holds the prior committed tree during revalidation by default — so the visual UX is similar (no fallback flicker), but the *read* semantic at the call site differs.

#### 2.5 Pipeline stages + generator `read` (pulse-unique)

Pulse: `computed(s0, s1, s2)` is a variadic pipeline. Each stage consumes the prior's resolved value. Stages can be sync, async, or generator (`function*` with `yield* read(x)` for per-yield TypeScript inference of sequential async).

Solid 2.x: a memo is one function. Async composition uses `async/await` inside that function, or chained `createMemo` over multiple memos. No generator-based per-yield inference; no variadic pipeline.

#### 2.6 External pending tracker (pulse) vs runtime-internal (Solid 2.x)

Pulse exposes `isPending(x)` and `promiseOf(x)` as free functions backed by a `WeakMap<Accessor, PendingEntry>` registry. `isPending` walks the entry's `upstream` chain (pipeline-OR). The registry is a public concept in `src/pending.ts`.

Solid 2.x's `isPending(fn)` is a tracked-call mechanism: it runs `fn`, observes whether any read reached an unresolved async source, and returns the answer. The walk is implicit — the runtime knows which signals are on the loading path. No public registry concept.

#### 2.7 Staged effects with explicit commit terminator (pulse-only)

Pulse Plan C: `effect([s0, …, sn], commit)` — pipeline of stages feeding into a `commit(value)` callback. The commit is the side-effect terminator and participates in `<Loading>`'s atomic flush via `scope.deferOrCommit`.

Solid 2.x doesn't have a direct analogue. Its `createEffect(compute, apply)` is split into two phases (compute reads, apply does side effects), but that's about ordering reads-before-effects within the runtime, not about deferring effect callbacks to a boundary's atomic flush.

#### 2.8 No `refresh()`, no `action()`, no optimistic primitives (pulse-missing)

Solid 2.x ships a substantial mutation/cache-management layer that pulse doesn't have:

- `refresh(target)` — explicit invalidation that re-runs a derived computation (replaces 1.x's `resource.refetch`).
- `action(function* (args) { … })` — wraps a generator (or async generator) as a structured async mutation; integrates with transitions and refresh.
- `createOptimistic(value)` / `createOptimisticStore(fn, seed)` — optimistic primitives that accept writes during a transition and revert to source when the transition completes.
- `isRefreshing()` — check inside a memo whether you're in a `refresh()`-triggered re-run.
- `resolve(fn)` — Promise that resolves once a reactive expression settles (imperative bridge for tests and effects).

Pulse has none of these. A pulse user invalidates by writing to a signal the computed depends on; there is no `refresh()` for cache-style invalidation without rewriting the dep graph. Optimistic UI is hand-rolled.

#### 2.9 No `<Reveal>` / no `<Loading on={x}>` (pulse-missing)

Solid 2.x:

- `<Reveal order="sequential|together|natural">` — coordinates the reveal timing of sibling `<Loading>` boundaries (e.g. "show profile header first, then sidebar, then comments").
- `<Loading on={x}>` — when `x` changes AND async is pending, re-show the fallback instead of holding the stale tree (useful for route-level resets where you DON'T want to hold the previous route's content).

Pulse has neither. Multi-boundary coordination beyond one `<Loading>`'s gather is up to the user.

#### 2.10 No split effects (pulse) — single-phase, except staged form

Solid 2.x effects are explicitly split:

```ts
createEffect(
  () => count(),           // compute phase: tracked reads only
  (value, prev) => {       // apply phase: side effects, untracked
    console.log(value);
    return () => { /* cleanup */ };
  },
);
```

Compute phases of all effects in a batch run BEFORE any apply phases. This is required for the runtime to make correct boundary decisions and resumability.

Pulse's `effect(fn)` is single-phase: `fn` does both reads and side effects in one body. There's no separation; effects fire side effects immediately on the successful pass. The staged form `effect([...stages], commit)` (Plan C) achieves something similar at the user level (stages do reads, commit does side effects) but it's an opt-in API shape, not a structural property of all effects.

#### 2.11 No store layer (pulse-missing)

Solid 2.x's store primitives (`createStore`, `createProjection`, `createOptimisticStore`, `reconcile`, `merge`, `omit`, `snapshot`, `deep`, `storePath`) are a substantial feature surface. Draft-first setters, granular reactivity per property, projections, deep observation.

Pulse has plain signals. For nested state, the user composes signals manually or uses external libraries.

#### 2.12 No no-writes-under-scope guard

Solid 2.x throws in dev when you call `setSignal` inside a tracked context (effect body, memo body, component body), unless the signal is created with `{ ownedWrite: true }`. This catches accidental feedback loops.

Pulse has no such guard. Writes from any context are allowed.

#### 2.13 Transactions / shadow writes — Solid native via lanes; pulse plausible via existing registry

This is the section where the gap looks bigger than it is. Solid 2.x's lanes give it a powerful set of capabilities for concurrent flows:

1. **Snapshot isolation** — writes inside transition A tag the dirty marks with A's lane; reads outside A see committed state; reads inside A see committed + A's lane overlay.
2. **Atomic per-transition commit** — all of A's writes promote to committed in one pass.
3. **Auto-entanglement** — if A reads a value B is currently writing, A blocks until B commits or aborts.
4. **Optimistic-with-revert** — `createOptimistic` writes land on a sticky lane that auto-reverts when the transition completes (the server's response on the non-transition lane becomes the committed truth).
5. **Lane-aware Loading** — `<Loading>` knows which transitions are on its loading path and decides fallback-vs-hold accordingly.
6. **Cancellation as abort side-effect** — abort a transition, its lane-scoped writes vanish.

Pulse has *none* of these as primitives. But the infrastructure cost differs sharply by capability:

| Capability | Pulse infra needed |
|---|---|
| (1) Snapshot isolation | New: per-signal overlay storage (`Map<Transaction, T>` on signals, or transaction-owned overlay). |
| (2) Atomic commit | Free: one tx promote-all is a tiny batch of normal writes. |
| (3) Auto-entanglement | **Free in principle.** A `Transaction` is a `PendingEntry`; cross-tx reads link entries via the existing `upstream` chain; `isPending(A)` already walks transitively. |
| (4) Optimistic-with-revert | Small layer over (1) + (2): `optimistic(signal, value, untilPromise)`. |
| (5) Lane-aware Loading | **Needs real lanes.** `<Loading>` would need to know "this read came from transaction X's overlay" and decide fallback policy based on the transaction's relationship to the boundary. This is the irreducible runtime-level feature. |
| (6) Cancellation | Free: tx tracks its overlaid signals; abort = discard the overlay. |

What's actually new is (1) + the read-path being transaction-aware (an ambient "current transaction" slot the read path consults). The transition-tracker mechanism from Plan B Task 5.5 is the same shape — a per-run ambient flag the read path consults — so the pattern is already established. Rough estimate: 200–300 LOC for a transaction primitive with snapshot isolation, atomic commit, entanglement, optimistic, and cancellation. Lane-aware Loading is the one item that would push pulse into being its own integrated runtime.

So when the README says "pulse doesn't have lanes" — that's literally true at the runtime level, but the *capabilities lanes provide* mostly fit pulse's existing primitives. The exception is lane-aware Loading-path semantics, which pulse genuinely couldn't replicate without significant runtime work.

### 3. Where pulse diverges — behavior

#### 3.1 Transition coordination granularity

Pulse: per-read via `use(x)`. You can have two bindings in the same `<Loading>` where one calls `use(x)` and one doesn't — only the first participates in the gather; the second commits inline regardless. Mixed coordination is the default, controlled per call site.

Solid 2.x: implicit at the loading path. Any read of an async source inside a `<Loading>` subtree puts that read on the loading path. Sibling reads of OTHER (non-async) signals don't participate in the transition coordination directly — they just re-render normally; the boundary's transition behavior is about WHAT the boundary shows (prior tree vs fallback), not about coordinating commit timing across unrelated sibling bindings.

#### 3.2 `<Loading>` semantics differ

Pulse's `<Loading>`:

- `initial` shows on first load (no committed tree yet).
- `fallback` shows on subsequent transitions IF set; otherwise the prior tree is held.
- Gather mechanism: deferred commits + pending controllers + tail-check microtask.

Solid 2.x's `<Loading>`:

- `fallback` shows on first load (RFC 05: "branch readiness"). On subsequent revalidation, it does NOT swap back to fallback — that's the implicit "transitions" behavior.
- `on={x}` prop forces a fallback re-show when `x` changes WHILE pending (route-level reset).

Pulse's distinction between `initial` and `fallback` makes the "first vs subsequent" intent explicit at the prop level. Solid 2.x bakes the same semantic into the runtime (revalidations don't trigger fallback) plus an `on` opt-out.

#### 3.3 Effect-and-apply ordering

Solid 2.x: all compute phases in a batch run before any apply phases. This means by the time any side effect fires, all reactive reads have updated and no further reads will happen in this batch. Predictable for resumability + boundary decisions.

Pulse: effects are single-phase; side effects fire in topological order as r3 processes the dirty heap. No explicit phase separation.

#### 3.4 Mutation UX

Solid 2.x: `action(fn*)` + `createOptimisticStore` form a structured mutation pattern. Optimistic write → yield async work → refresh.

Pulse: no equivalent. You write a `signal`, run async work, and either update the signal manually or let the computed re-fetch on its own.

#### 3.5 Read suspension at the call site

Solid 2.x: `user()` throws `NotReadyError` (any time, any place, if not ready) — implicit suspension on every async read.

Pulse: `use(user)` throws; `user()` directly returns the value (or the in-flight Promise if no SWR cache; or the stale value if SWR cache exists). The throw is opt-in.

#### 3.6 Components-run-once strictness

Both libraries advertise "run once." Solid 2.x has additional dev-mode guards (strict top-level reactive read warnings, no-writes-under-scope) that make accidental re-execution easier to detect.

Pulse has no such guards. The "use at the top of component body before creating signals" footgun is real and undocumented at the framework level (documented in `CONTEXT.md`'s caveats but not enforced).

### 4. Pulse-specific quirks (current state)

Issues that surfaced during pulse's development; tracked in [`docs/follow-ups.md`](./docs/follow-ups.md):

- **`use(accessor)` must call accessor before the pending check** (post-fix). r3 auto-disposes computeds when sub-count drops to 0; pulse's `use` had to be ordered carefully to avoid losing the dep edge on the throw path. Solid 2.x's runtime handles this natively.
- **`reactiveCommit` (bindProp's helper) must `runWithOwner(parentOwner)` around the read.** Without it, owner-aware reads like `useLoading()` see the wrong ambient owner. Solid 2.x's internals do this automatically.
- **Top-level component children in a `<Loading>`'s Fragment lose the scope.** Pulse-specific: top-level function children get wrapped by the outer hole's `insertChild` under the wrong owner; `useLoading()` walks past the boundary. Workaround: wrap in any static element. Solid 2.x's component model doesn't have this issue.
- **Structural mounts (`<Show>`, `<For>`) commit immediately even inside a pending `<Loading>`.** Only content-hole commits defer. Solid 2.x's runtime gates the whole subtree's commit through the transition machinery.

### 5. Summary table

| Concern | Solid 2.x | Pulse |
|---|---|---|
| Reactive core | Own runtime (`@solidjs/signals`) | `r3` (external, minimal) |
| Async data primitive | `createMemo(async () => …)` | `computed(async () => …)` (multi-stage pipeline) |
| Async opt-in at read site | Implicit — any async read suspends | Explicit — `use(x)` marker (suspends + marks transition engagement) |
| SWR | Opt-in via `latest(fn)` | Default for every async computed |
| Suspension boundary | `<Loading fallback={…}>` + `on={…}` reset | `<Loading initial={…} fallback={…}>` (first vs subsequent) |
| Transitions | Built-in, runtime-managed, implicit | Per-binding via `use()` engagement + boundary's atomic-commit gather |
| Pending observation | `isPending(fn)` (tracked-call walk) | `isPending(x)()` (registry walk via upstream chain) |
| Cross-boundary coordination | `<Reveal order="…">` | None |
| Cache invalidation | `refresh(target)` | None (write to deps) |
| Mutations | `action(function* …)` + transitions | None (manual signal writes) |
| Optimistic UI | `createOptimistic` / `createOptimisticStore` (sticky lane, auto-revert) | None as primitive; doable manually; plausible as small layer over a transaction primitive (see §2.13) |
| Snapshot isolation across concurrent flows | Native via lanes | None today; plausible via per-signal overlay + tx-aware reads (see §2.13) |
| Auto-entanglement of concurrent transactions | Native via lanes | None today; would ride pulse's existing pending-registry upstream chain (see §2.13) |
| Lane-aware Loading-path | Native (boundary fallback aware of transition lanes) | Not plausible without significant runtime work |
| Stores | `createStore` / `createProjection` / draft setters / `reconcile` / `deep` / `snapshot` | None — plain signals only |
| Effects | Split: `createEffect(compute, apply)` | Single-arg `effect(fn)` + staged `effect([...stages], commit)` (Plan C) |
| Batching | Microtask default, `flush()` to drain | Microtask default, `flush()` to drain (same shape) |
| Writes under scope | Throws in dev unless `ownedWrite: true` | Allowed |
| Top-level reactive read in body | Warns in dev | No guard |
| Component re-execution | Identity-stable (warnings catch accidental re-runs) | Body re-runs on `use()`-retry; state lost if recreated mid-body |
| Generator stages | No (memos are one function) | Yes (`computed(function* () { yield* read(x) })`) |
| Error boundary | `<Errored>` + `createErrorBoundary` | `catchError(fn, handler)` (no JSX component) |
| List unification | `<For keyed={…}>` (replaces 1.x `<Index>`) | `<For>` only (no `Index`) |
| Count-based render | `<Repeat count={…}>` | None |
| Dynamic component | `dynamic()` factory + `<Dynamic>` | None |

### 6. Conceptual posture

Pulse's design bet is **explicit per-binding opt-in with an exposed coordination mechanism**: `use(x)` at the read site, `<Loading>` with a public binding-controller API, an external `isPending` / `promiseOf` registry. Coordination is a thing you can name, debug, and extend.

Solid 2.x's design bet is **implicit runtime-managed coordination**: any async read suspends; transitions are built into the runtime; multiple transitions can be in flight; the user observes via `isPending(fn)` and `<Loading>`. Coordination is a thing the runtime handles for you.

Both arrive at "coherent transitions across reads," but via opposite philosophies. Solid 2.x's model is more turnkey (you compose primitives; transitions happen) and matches the trajectory of mainstream frameworks (React Server Components, Svelte 5 runes). Pulse's model is more explicit (you mark each opt-in) and exposes more machinery for library authors — at the cost of footguns when a developer forgets `use()` and silently breaks coherence.

Solid 2.x's larger surface (`action`, `createOptimistic*`, `refresh`, `createStore`, `<Reveal>`) is *convenient* for certain patterns but not *essential* for app development. You can build real apps in pulse with just signals + computeds + effects + `<Loading>`: mutations are signal writes (optionally inside a generator stage that awaits the server); refetch is "change a dep"; optimistic UI is "set a signal eagerly, correct on settle in a follow-up `.then`"; nested state is composed signals. The 2.x layer trades verbosity for safety (race-safe optimism, automatic reconciliation, draft-first setters), which matters for some teams more than others.

And the gap is less architectural than it appears (see §2.13). Pulse's pending registry already implements the *shape* of Solid 2.x's lane-entanglement (a graph of producer/consumer pending state with transitive walks); applying that shape to transactions instead of just computed pending is mostly a matter of adding per-signal overlays + transaction-aware reads. The one capability that genuinely requires an integrated lane runtime is lane-aware Loading-path semantics — pulse can't get that without becoming its own runtime.

#### Potential future directions for pulse

- **Cross-boundary coordination via scope-tree primitive** — unify (a) "two `<Loading>`s commit atomically" (shared scope) and (b) "two `<Loading>`s reveal in order" (Reveal-style) under one primitive: scopes form a tree, parent has a `policy` (`natural` / `gather` / `sequential` / `together`). Policy decides how the parent treats its children's pending state. Same machinery, different policy values.
- **Transaction primitive for snapshot isolation + atomic commit + entanglement** — explicit `Transaction` value the user creates; writes can be scoped to it; reads inside see overlay, reads outside see committed; commit promotes, abort discards. Rides the existing pending-registry chain for auto-entanglement (cross-tx reads link via `upstream`). Doesn't need a lane runtime. Lane-aware Loading interaction is out of scope (deferred indefinitely; would require runtime work).
- **Optimistic helper over the transaction primitive** — `optimistic(signal, value, untilPromise)` = "set in a tx, auto-commit on Promise resolve, auto-abort on reject." Small wrapper.
- **Cache invalidation** — `refresh(c)` would force a computed's stage to re-run even when deps look unchanged. Tiny addition; useful for retry buttons without a clean dep to invalidate.
- **Stores** — orthogonal; could land as a separate package (`@pulse/store`) without touching the core.

None of these are blocking real app development today.

#### Maturity

Pulse is younger and less battle-tested. Several genuine bugs surfaced during its development (owner ambient context losses, dep tracking through suspension, ordering races) — all addressed in v1, but indicative that the per-binding model has more sharp edges than Solid 2.x's runtime-managed approach. The framework is honest about this: known issues are tracked in [`docs/follow-ups.md`](./docs/follow-ups.md) with workarounds documented.

# pulse

A small reactive UI framework built on [`r3`](../r3). Pulse is a research vehicle for exploring an alternative to Solid 2.x's async direction: same fine-grained-reactivity foundation, different choices about how async data, transitions, and atomic commit interact.

For project conventions, language definitions, and architectural decisions, see [`CONTEXT.md`](./CONTEXT.md) and [`docs/`](./docs).

---

## Pulse vs Solid 2.x — A Comparative Analysis

### 1. Shared foundation (behavior + mechanics)

Both libraries sit on the same fundamental architecture:

- **Fine-grained reactivity, no VDOM.** Both compile JSX into direct DOM operations where reactive expressions become per-binding "holes" with marker comments. Updates touch only the affected DOM nodes.
- **Components run once.** A component function executes a single time during construction; reactivity lives in the holes it returns, not in re-executing the function body. Local state created in the body is created once.
- **Owner tree for lifecycle.** Both maintain a parent-child tree of owners that scope reactive nodes (effects, computeds) and their cleanups. Disposal cascades top-down.
- **Push-pull hybrid reactive graph.** Both use dirty-marking + on-demand recomputation rather than purely push (eager) or pull (lazy). Solid uses its own internal scheduler; pulse inherits this from `r3`.
- **No diamond glitches.** Topological dirty-propagation guarantees a derived signal isn't observed in a stale-half-old-half-new state during a single update.
- **JSX bindings as effects.** Each `{() => …}` hole is a reactive effect that tracks its reads and re-runs on dep change, mutating the DOM in place.
- **Suspension via thrown sentinels.** Both throw a special value (Solid throws Promises; pulse throws `NotReadyYet` carrying a Promise) to suspend rendering. A boundary catches and waits.
- **Sub-owners for branch scopes.** `Show` / `For` in both create per-branch sub-owners; toggling truthy/falsy disposes the prior branch's sub-owner.

### 2. Where pulse diverges — mechanical

#### 2.1 The reactive core is `r3`, not Solid's runtime

Pulse imports `r3` (a minimal reactive library that exposes `signal` / `computed` / `stabilize` / `onCleanup` / etc.) and builds its semantics on top. Pulse never modifies r3 — async behavior, SWR, the pending registry, and the boundary gather all live in pulse wrappers above r3 nodes. Solid's runtime owns its own scheduler and effect machinery directly.

Consequence: pulse can swap r3 for a different reactive core in principle, but tying-in async semantics adds wrapper overhead (each async computed stage = an r3 computed + signals for pending / published-value + a settle handler).

#### 2.2 Async computeds are first-class, multi-stage pipelines

Pulse's `computed(s0, s1, s2)` accepts a variadic pipeline of stages, each consuming the prior stage's resolved value. Each stage can be sync, return a Promise, or `function*` (generator with `yield* read(x)` for sequential async). SWR is built into every stage: during a refetch, the prior resolved value is published until the new one settles.

Solid 2.x equivalent: `createResource(source, fetcher)` produces an accessor with `.loading` / `.error` / `.latest` properties; pipelines compose via `createMemo` over multiple resources. SWR is opt-in via `.latest`. There's no built-in pipeline-OR pending walk; you compose it manually.

Pulse's pipeline pre-bakes pending propagation: `isPending(downstreamStage)()` walks up the chain. Solid users build that walk themselves.

#### 2.3 `use()` is the transition opt-in marker — not just a suspension primitive

In pulse, `use(x)` does three things atomically:

1. Marks the surrounding binding as "transition-engaged" (sets a per-run flag in `transition-tracker.ts`).
2. If `x` is a pending accessor → throws `NotReadyYet(promiseOf(x)!)`.
3. Otherwise → returns the value, **but still establishes the engagement**, so the binding's commit later defers if the surrounding `<Loading>` is pending due to a sibling.

This split is intentional: the engagement signal lets `use(plainSignal)` participate in atomic coordination even when the read itself succeeds. The accompanying binding then routes through `scope.deferOrCommit(commit)` instead of committing inline.

Solid's analogue is `useTransition` — `const [isPending, startTransition] = useTransition(); startTransition(() => setSignal(newValue))`. Solid implicitly captures all signal updates inside the `startTransition` callback and replays them deferred. The opt-in is at the WRITE site (`startTransition`), not the READ site (`use`).

**Behaviorally:** pulse's opt-in is per-read ("I want THIS read coherent with siblings"). Solid's is per-write ("THIS state change should defer"). Pulse's model is more local and per-binding; Solid's is more transactional and global.

#### 2.4 `<Loading>` is an atomic-commit boundary, not just visibility

Pulse's `<Loading>` has a gather/flush state machine:

- Bindings that throw report `{ status: 'throwing' }` to the nearest scope's `pendingSet`.
- Bindings that succeed (and called `use(...)`) report `{ status: 'ready', commit }` to `readySet` — and the actual DOM commit is deferred.
- When `pendingSet` empties, all queued commits (controller-based `readySet` + anonymous `deferredCommits`) fire in a single flush.

Solid's `Suspense` shows a fallback while children are loading; it doesn't gate the commit timing of sibling bindings the same way. A `useTransition` does the timing gating, separately from the visibility decision.

So pulse fuses transition + suspense semantics into one boundary. Solid keeps them as two cooperating primitives.

#### 2.5 SWR-as-default vs SWR-as-opt-in

Pulse: every async computed stage holds its prior resolved value during refetch (SWR is the default; `lastResolvedValue` lives in `makeStageNode`'s closure).

Solid: `createResource` exposes `.latest` (settled value, stable across refetch) separately from the call form (`resource()` may throw on refetch). The user explicitly chooses.

**Behaviorally:** pulse reads "just work" with SWR semantics; Solid surfaces the staleness choice at every read site.

#### 2.6 No virtual hole cache — DOM is the cache

Plan B's spec called for a per-hole value cache. Pulse didn't build one. Instead, `insertChild`'s reactive child relies on the DOM being naturally stable on throw — if the compute throws `NotReadyYet`, the existing DOM between the binding's marker comments stays untouched. No explicit cache structure.

Solid's `Suspense` doesn't cache content either, but it relies on its `Resource` system + `<Show>` / `<Switch>` falsy returns to suppress mid-flight renders. The mechanism is different (resource state + conditional render) but the user-visible result is similar.

#### 2.7 Staged effects with explicit commit terminator

Pulse Plan C added `effect([...stages], commit)` — pipeline of stages (sync / async / generator) feeding into a side-effect terminator that the `<Loading>` boundary can defer.

Solid has no equivalent. `createEffect(() => sideEffect(resource()))` is the closest, but the side effect fires inside the effect body — no deferred-commit concept. To get gated side effects in Solid, you'd manually check transition state with `useTransition`'s `isPending` and skip work.

### 3. Where pulse diverges — behavior

#### 3.1 Transition opt-in granularity

Pulse: `use(x)` per read. You can have two bindings in the same `<Loading>` where one uses `use(x)` and one doesn't — only the first participates in the gather; the second commits inline regardless. Mixed coordination is the default behavior, controlled per call site.

Solid: transactional. Inside a `startTransition` callback, all `setSignal` calls are queued and replayed deferred; outside, immediate. Per-binding granularity not directly addressable.

#### 3.2 Atomicity is gated by `<Loading>` placement, not by transition scope

Pulse: place `<Loading>` around the bindings you want coherent. The boundary IS the transition. No `startTransition(() => ...)` wrapper; the *visual grouping* is the *semantic grouping*.

Solid: visibility (Suspense) and timing (useTransition) are independent. You can have a Suspense without transitions, or transitions without Suspense.

#### 3.3 No equivalent of `useDeferredValue`

Solid has time-budgeted commits — "show new value after N ms even if not settled." Pulse has none; transitions are strictly settle-driven. If a fetch never resolves, the boundary holds the prior tree forever.

#### 3.4 `<Loading>` boundary's `initial` vs `fallback` distinction

Pulse: `initial` shows only on the first load (no committed tree yet). `fallback` shows on subsequent transitions IF set; otherwise the prior tree is held. Solid's Suspense `fallback` doesn't distinguish first-load from subsequent.

#### 3.5 Components run once — strictly

Both libraries advertise "run once," but pulse enforces it more strictly. There's no `onMount` / `onCleanup` / `createSignal`-by-call-order machinery; the entire component lifecycle is the single function call.

Practical difference: a pattern like `const Comp = (props) => { const v = use(props.value); const [count] = signal(0); ... }` is safe in pulse only across the first successful run; subsequent re-runs (triggered by binding effects re-throwing) would re-create `count`. Solid handles a similar case more robustly because `createSignal` calls are tied to the owner identity, not re-invoked on retry.

#### 3.6 Generator-based `read` for sequential async in computeds

Pulse:

```ts
computed(function* () {
  const a = yield* read(asyncA)
  const b = yield* read(asyncB(a))
  return { a, b }
})
```

Generators give per-yield type inference and explicit sequential composition. After Plan A, `read` is a plain yield helper — generators handle their own suspension via the driver, distinct from `use()`'s transition-engagement.

Solid: no generator stages. `async / await` inside a `createResource` fetcher, or chained `createMemo` over multiple resources. More familiar Promise syntax; less expressive about per-yield typing.

#### 3.7 Owner-based `catchError`, no React-style `ErrorBoundary` component

Pulse: `catchError(() => { ... }, (e) => { ... })` creates an owner sub-tree with an error handler attached. Errors thrown by descendants walk up via the owner chain. Solid has the same `catchError` primitive plus an `ErrorBoundary` component for JSX use.

### 4. Pulse-specific quirks (current state)

These are real-world issues that surfaced during pulse's development; some are fixed, some are tracked as follow-ups in [`docs/follow-ups.md`](./docs/follow-ups.md):

- **`use(accessor)` must call accessor before the pending check** (post-fix). Solid's reactivity tracks reads automatically inside resource access; pulse's `use` had to be ordered carefully to avoid r3's auto-dispose-on-zero-subs killing the dep edge.
- **`reactiveCommit` (bindProp's helper) must `runWithOwner(parentOwner)` around the read.** Without it, owner-aware reads like `useLoading()` see the wrong context. Solid's analogous internals do this automatically (or its `useTransition` doesn't depend on ambient owner at read time).
- **Top-level component children in a `<Loading>`'s Fragment lose the scope.** A pulse-specific issue: top-level function children get wrapped by the outer hole's `insertChild` under the wrong owner. Workaround: nest in a static element. Solid doesn't have this issue because component children in Suspense work through fiber identity, not owner walks at read time.
- **Structural mounts (`<Show>`, `<For>`) commit immediately even inside pending `<Loading>`.** Only content-hole commits defer. Solid's Suspense holds the entire subtree's commit including structural changes.

### 5. Summary table

| Concern | Solid 2.x | Pulse |
|---|---|---|
| Reactive core | Own runtime | `r3` (external, minimal) |
| Async data primitive | `createResource` (resource object w/ properties) | `computed` pipeline w/ stages (suspension built in) |
| Transition opt-in | `startTransition` / `useTransition` (per-write, transactional) | `use()` per read (per-binding, marker-based) |
| Suspense boundary | `<Suspense>` (visibility) + `useTransition` (timing) | `<Loading>` (visibility + atomic-commit gather) |
| SWR | Opt-in via `.latest` | Default for every async computed |
| Time-budget commits | `useDeferredValue` | None |
| Initial-load vs refetch fallback | One `fallback` prop | `initial` (first load) vs `fallback` (subsequent) |
| Effects with deferred commit | None | `effect([...stages], commit)` |
| Component re-execution on retry | Identity-stable (signals tied to owner) | Body re-runs (state lost if recreated mid-body) |
| Generator-based async stages | No | `computed(function* () { yield* read(x) })` |
| Pipeline-OR pending | Manual composition | Built-in (`isPending` walks upstream) |

### 6. Conceptual posture

Pulse leans toward **explicit, per-binding opt-in coordinated by JSX-placement boundaries**. Solid leans toward **transactional opt-in coordinated by callback wrappers**. Both arrive at "coherent transitions across reads," but pulse's model is more local (each `use` choice is independent) and more visual (the boundary placement = the semantics). Solid's model is more global (a transition holds across all reads inside its scope) and more imperative (you wrap state changes in a callback).

Neither is strictly better. Pulse's per-binding granularity is more flexible but more error-prone (forgetting `use` silently breaks coherence; pulse offers no static check that a binding inside `<Loading>` actually called `use`). Solid's transactional model is more uniform but heavier — every state change has to choose to participate.

Pulse is also younger and less battle-tested. Its development has surfaced genuine bugs around owner ambient context, dep tracking through suspension, and ordering races — all addressed in v1 but indicative that the per-binding model has more sharp edges than the transactional one.

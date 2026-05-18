# Follow-ups

Minor issues and observations surfaced by reviews that were explicitly non-blocking. Tracked here so they don't get lost; pick from this list when there's a natural moment to address one (a related task, a quiet pass, or before a major refactor).

Severity: **(small)** trivial cleanups · **(worth)** worth doing soon · **(later)** legitimate but can wait.

---

## Open

### Encapsulation / structure

- **(later) Move internal symbols to `src/_internal.ts`.** `NODE`, `makeAccessor`, `track`, `isGeneratorFunction`, `runStage`, `StageOutcome` are all "intra-package public, public-API private". They're exported from `src/{signal,async,driver}.ts` for cross-file use but kept out of `src/index.ts`. As more internals accumulate (Plan 2c, Plan 3), a dedicated `_internal.ts` would make the boundary explicit and unblock easier audits.
  Source: Plan 1 final review (I2); reinforced by Plan 2b final review.
- **(small) Decide whether `isPromise` should be exported from the public barrel.** Plan 3 (DOM layer) will likely need it for binding-effect logic the user might want to inline. Currently internal-only. Defer the decision to when Plan 3 actually needs it.
  Source: Plan 2a final review (I2).

### Test coverage gaps

- **(later) No test for within-generator restart-from-top with multiple `yield*` points.** The current behaviour (a `function*` body with two yields restarts from the top on a sync dep change, fast-forwards both yields via the WeakMap) is correct but documented only in scope notes. A test covering this would make the contract explicit before someone tries to add intra-generator checkpoint resume.
  Source: Plan 2b final review.
- **(later) Integration tests are minimal.** Plan 2a and 2b each have a couple of integration tests; scenarios like nested pipelines, transitions across multiple signals, and the `signal-set-mid-flight` path could be deepened. Not a correctness gap — just thin coverage on real-world shapes.
  Source: Plan 2a final review.

### Comments / docs

### DOM-layer findings (Plan 3a)


### Control-flow findings (Plan 3b)


### API ergonomics


### Architectural notes

- **(later) `<Loading>` gating works at content-hole granularity, not structural-mount granularity.** Plan B's atomic-commit gather defers DOM commits from reactive bindings (`insertChild` reactive child, `bindProp` reactive branches) that called `use(...)` or have a pending controller. However, `<Show>` / `<For>` structural mounts/unmounts happen via their own binding effects that don't typically call `use(...)`, so the new subtree's STRUCTURE appears immediately while the content holes inside it stay empty (held) until the gate opens. Spec's "option A: hold prior tree" intent literally meant the entire prior tree including structure; we under-built that. Workaround: place structural toggles outside `<Loading>`, or wrap the toggled subtree in its own nested `<Loading>`. Long-term: extend the gating to structural commits (probably by having `<Show>`/`<For>` route their commits through `scope.deferOrCommit` too).
  Source: Plan B Task 7 implementation.
- **(later) `insertChild` / `bindProp` double-register with `<Loading>` scope.** Plan B's `insertChild` reactive child and `bindProp` reactive branches each register their own `BindingController` with the nearest `<Loading>` scope to report `throwing`/`ready`. The underlying `effect()` (used to drive the reactive re-run) ALSO calls `findLoadingScope` and registers its own controller on `NotReadyYet`. Both controllers report the same lifecycle; the boundary's `pendingSet`/`readySet` semantics handle N controllers per binding correctly (the gate still opens correctly), but each affected binding leaves two entries in the sets while throwing. Cleanup: extract a `bindingEffect()` primitive that drives reactive re-runs without owning a scope controller — leaving scope coordination to the caller (insertChild, bindProp).
  Source: Plan B design.
- **(later) Extract shared `gatedEffectCore` between `singleArgEffect` and `stagedEffect`.** Plan C's `stagedEffect` duplicates the kick/suspendedOn/controller plumbing from `singleArgEffect` — the difference is just the body (single-arg runs `fn` directly; staged runs `use(pipeline)` then routes a `commit(value)` callback). A shared helper that takes a `runCompute` and `runCommit` pair would deduplicate, at the cost of one more layer of indirection. Defer until a third user emerges (e.g., generator-fn JSX bindings — see existing follow-up).
  Source: Plan C Task 3.
- **(later) JSX generator-fn bindings.** Today JSX holes accept `() => T` thunks; extend the binding evaluator to also accept generator functions, internally wrapping them in `computed(genFn)` and reading reactively. Lets users write per-binding suspension without a named outer computed: `<span>{function*(){ const v = yield* read(view); return v.page + 1 }}</span>`. Useful as an ergonomic unlock for single-binding suspension (alt to `<Loading>`); does NOT replace transitions (cross-binding coherence still needs a shared `view` computed). Needs design pass on lifecycle, disposal, error routing.
  Source: Plan 7 transitions design discussion.
- **(later) `await*`-style JSX compile-time sugar.** Symbol-level idiom `prop:value={await*(view).page}` reads naturally for "suspend until ready then read", but `await*` isn't valid JS. Realizing it requires a pulse JSX compiler that rewrites the expression into the equivalent generator boilerplate. Out of scope unless several real users want both the suspension behavior AND the spelling.
  Source: Plan 7 transitions design discussion.
- **(later) Props-as-getters (Solid-style) for reactive props.** Today reactive props are typed `() => T` and consumed via `props.x()` — explicit and consistent with "function = reactive." Pulse rejected prop getters in favor of voby-style destructurable plain values. The cost surfaces when a prop type is widened to `FunctionMaybe<T>` (= `T | (() => T)`) for static-or-reactive flexibility: TypeScript can no longer distinguish `prop={use(x)}` (eager call, returns value, captured statically — runtime trap if pending) from `prop={() => use(x)}` (lazy, reactive, correct). Both forms typecheck under `FunctionMaybe<T>`. With strict `() => T` props this isn't an issue (call-site mistakes get TS errors), but `FunctionMaybe<T>` is a real ergonomic gravity for component authors who want flexibility. Prop getters would resolve this by making `<Comp prop={x}>` always reactive at the property-access site, without explicit call. Big architectural shift — would change destructuring semantics, prop access mechanics, and CONTEXT.md commitments. Revisit if/when several real components want both static and reactive use cases.
  Source: Plan 4 brainstorming (Loading design).
- **(later) `catchError` orphan sub-owner when no ambient owner.** Calling `catchError` outside any `createRoot` creates a sub-owner with `parent = null` that is not registered as a disposable anywhere — it lives until GC. In practice the reactive nodes inside it are individually unwatched by r3, so the handler effectively becomes unreachable, but there is no explicit dispose handle for the boundary itself. Consider returning `{ result, dispose }` from `catchError` in a future iteration, or document the constraint more loudly in the JSDoc.
  Source: Plan 2d final review (Minor).
- **(later) ADR 0003 wording vs Plan 2b's per-stage implementation.** ADR 0003 says "one ordinary r3 computed node" + "stashed pipeline state". Plan 2b uses one r3 node *per stage* — same architectural commitment (r3 unmodified; async-ness in pulse wrappers), different mechanism (r3's memoization gives free per-stage caching). The ADR could be updated to record the chosen implementation, or kept as-is with the plan's scope note serving as the divergence record.
  Source: Plan 2b plan scope notes + final review.

### r3-side findings

- **(worth) r3 auto-disposes computeds when their sub count drops to 0, mid-flow.** Inside `unlinkSubs`, the line `if (nextSub === null && "fn" in dep) unwatched(dep)` triggers r3's automatic disposal cascade when a computed's last sub goes away. For pulse this bites when a consumer reads a pulse computed *conditionally*: if an effect skips the branch that reads `someComputed()`, `unlinkSubs` removes the dep edge, the computed's subs becomes empty, r3 calls `unwatched` on it, and the computed's own deps are detached too — so it stops listening to upstream signals. Subsequent re-subscription via `r3.read` re-attaches `effect → computed` but the computed's own deps (`computed → upstream`) stay null, so upstream changes never reach it. Workaround in user code: always-read the computed in the effect body (even if the value isn't always used). Long-term: pulse may need to install a phantom sub on owned computeds to keep them alive across periods of zero observers; or expose a "pinned" flag through `unwatched`. The Plan 2d integration test uses the always-read workaround.
  Source: Plan 2d Task 3 integration test debugging.


- **(worth) r3: dep-list partially stale after a throw in `recompute`.** When a `computed`/`effect` body throws partway, r3's `try/finally` (added in Plan 2c) correctly restores `context` and `flags`, but the post-`try` dep-pruning code (`unlinkSubs` against `depsTail`) is skipped. The throwing node retains its dep links from before the throw — including any deps it re-read during the failed partial run. Practically: a throwing computed may re-trigger from deps it should have dropped this run. Not a context-corruption bug; a "phantom re-trigger" risk. Worth pinning down before Plan 2d (error boundaries), since boundary recovery semantics may want to interact with the dep graph of caught nodes.
  Source: Plan 2c Task 3 final review (Important). r3 fix lands in r3's repo, not pulse's.

---

## Already addressed (kept for traceability)

- ~~`effect()` stages with explicit commit terminator (Plan C).~~ Landed in commits `03e88bd` (scaffold overloads), `e0efd43` (compose via `computed` + `singleArgEffect`), `6f0546f` (split compute/commit + `scope.deferOrCommit` for boundary gating + Object.is dedup), `0ea1824` (error routing + disposal tests). New `effect([...stages], commit)` overload composes `computed(...stages)` for the pipeline and wraps it in a gated effect loop that splits compute (`use(pipeline)`) from commit (user's callback). Commit routes through `scope.deferOrCommit` when inside a pending `<Loading>`, so staged-effect commits flush atomically with sibling DOM bindings. See `docs/superpowers/specs/2026-05-18-effect-stages-design.md` and `docs/superpowers/plans/2026-05-18-effect-stages-plan-c.md`.
- ~~Plan 1: `setSignal` type cast loses `T` info → narrowed to `as R3Signal<T>`.~~ Fixed in commit `4289c49` (Plan 1 Task 2 amend).
- ~~Plan 1: `WritableSignal` brand to make `setSignal` type-reject computeds.~~ Fixed in commit `7f4ffec` (Plan 1 post-final-review fix).
- ~~Plan 1: `noUncheckedIndexedAccess` causing typecheck failures via r3 source aliasing.~~ Resolved by dropping the flag from `tsconfig.json`.
- ~~Plan 2a: Effect-suspension accumulating `.then` listeners on repeat suspension on the same promise.~~ Fixed in commit `91bda2b` (Plan 2a post-final-review fix — added `alreadySuspendedOnSame` guard).
- ~~Plan 2a: `generation.set(s, 0)` at signal creation to make the "never written" state explicit.~~ Fixed in commit `4f89bc8` (Plan 2a Task 2 amend).
- ~~Plan 2a: `kickCount` comment explaining why an incrementing counter is used.~~ Fixed in commit `91bda2b`.
- ~~Plan 2b: Stash race in `makeStageNode` — consumed stale value when upstream re-suspended.~~ Fixed in commit `c8f24aa` (added `suspendedInput` + `Object.is` validation; regression test).
- ~~Plan 2c: r3 `context` global not restored on throw in `recompute` — corrupted r3 process-wide after any thrown effect/computed.~~ Fixed in r3 commit `55a70c1` (try/finally around `el.fn()` restoring `context` + `flags`).
- ~~Plan 3a: No top-level reactive return from a component.~~ Fixed in commit `7329624` — `render` now passes `component()` through `insertChild`, so a function return is treated reactively (markers inserted, re-run on signal change, cleaned up on dispose). `Component` type widened to `() => unknown`.
- ~~Drop unused `isAsyncFunction` export.~~ Fixed in commit `1089041` (follow-up cleanup pass).
- ~~Stray `// eslint-disable-next-line` in `src/driver.ts`.~~ Fixed in commit `1089041` (follow-up cleanup pass).
- ~~Comment the `(value: any)` widening in `computed.ts` and `driver.ts`.~~ Fixed in commit `9684988` (follow-up cleanup pass).
- ~~`src/scheduler.ts`'s `microtaskScheduler` reset ordering comment.~~ Fixed in commit `9684988` (follow-up cleanup pass).
- ~~`render(component, target)` leaks the root owner if `component()` throws synchronously.~~ Fixed in commit `bef468a` (follow-up cleanup pass).
- ~~No test for `use(0)`, `use(null)`, `use(undefined)`, `use(false)`, `use('')`.~~ Fixed in commit `1a605f0` (follow-up cleanup pass).
- ~~No test that a mid-pipeline computed throw does NOT double-fire the handler from downstream stages.~~ Fixed in commit `b4d7e30` (follow-up cleanup pass).
- ~~No test for the reuse-value rejected-stash path.~~ Fixed in commit `f22b5aa` (follow-up cleanup pass).
- ~~Switch's branch caching is keyed by Match-object identity — worth documenting in JSDoc.~~ Fixed in commit `28db4c3` (follow-up cleanup pass).
- ~~`Show`'s function child is called once per truthy transition, not on each truthy value update — worth documenting in JSDoc.~~ Fixed in commit `28db4c3` (follow-up cleanup pass).
- ~~Document the within-generator restart-from-top semantics in `src/computed.ts`.~~ Fixed in commit `2d56830` (follow-up cleanup pass).
- ~~Widen `use` to accept an accessor too.~~ Fixed in commit `67aa326` (follow-up cleanup pass).
- ~~Promote "create a parented sub-owner" into a shared internal before Plan 3.~~ Fixed in commit `548e1df` (Plan 3a Task 2 — `refactor(owner): extract internal createSubOwner from catchError`).
- ~~Coherent multi-read snapshots ("transitions") need a new primitive — same signal change should update both label and items atomically without a ride-along data shape.~~ Addressed in commits `e8cf786`/`a7daa56` (Task 1: `[PENDING].promise`), `f9364d1` (Task 2': brand-aware `read`), `e3de8c8` (Task 4: pokemon demo migration + read-acc-first race fix). No new primitive; `yield* read(accessor)` inside a generator computed suspends on a pending brand and resumes on settle. See `docs/superpowers/specs/2026-05-16-pulse-transitions-design.md`.
- ~~Transitions redesign (Plan A foundation): external `isPending` / `promiseOf` tracker (`src/pending.ts`) replaces the `[PENDING]` symbol-brand on accessors; `read` reverts to a plain yield helper.~~ Landed in commits `9fded25` (tracker scaffold), `60cb78e` (value-as-promise fallback), `e129901` (pipeline-OR walk), `42cb040` (computed registers with tracker, brand kept in parallel), `77d5381` (`read` reverts), `dfaedfa` (test migration to new API), `07fe941` (public exports `isPending` + `promiseOf` from `./pending`), `34476bc` (brand fully removed from `signal`/`computed`/`async`). See `docs/superpowers/specs/2026-05-17-pulse-transitions-redesign.md`. JSX hole caching + `<Loading>` boundary semantics + `use`-throws-on-pending land in Plan B (separate plan).
- ~~Transitions Plan B (atomic-commit boundary): `<Loading>` gathers and flushes contributing bindings atomically via a `BindingController` API; `use(accessor)` throws `NotReadyYet` on pipeline-pending and ALSO marks the binding as transition-engaged so non-throwing reads defer too; sync `computed` stages absorb `NotReadyYet` thrown by `use(...)` as suspension (symmetric with effect); reactive `insertChild` and `bindProp` branches split into compute+commit; pokemon demo migrated.~~ Landed in commits `109935a` (`BindingController` + gather/flush), `6e54ed9` (effect adopts), `994e56f` (computed absorbs `NotReadyYet`), `8c357c4` (insertChild compute/commit split), `38bcc50` (bindProp split + insertChild `onCleanup` fix), `6bcd907` (`use(accessor)` throws on isPending), `9290653` (pokemon demo migration), `743e2a5` (`use()` marks transition engagement + `scope.deferOrCommit` for non-throwers), `98badab` (mid-flight mount tests). See `docs/superpowers/specs/2026-05-17-pulse-transitions-redesign.md` and `docs/superpowers/plans/2026-05-18-transitions-plan-b-boundary-atomic-commit.md`.
- ~~Drop signal write-back (`signal<T | Promise<T>>` auto-resolve).~~ Removed in commit `13dbf9b` — `signal` now stores values as-is; `signal<T>` no longer widens to `Awaited<T> | T`. `latest`/`isPending` consult `track()` so they still report settled state on Promise-valued signals. Eager `track(value)` registration in `signal()` and the setter preserves the "settled by next tick without explicit `use` call" UX. For dep-driven async derivations, use `computed(() => p)` (Plan 6).
- ~~`'reuse-value'` stash consumption in `src/computed.ts` loses dep tracking — sync computeds returning Promises freeze on first settle.~~ Fixed in commit `bea4b1c` (Plan 6) — rewrote `makeStageNode` to always run the body for r3 dep tracking and publish settle values out-of-band via an internal signal. Added stale-while-revalidate semantics and resolved-value (Object.is) caching; `isPending(computed)` exposes the refetch window via a `[PENDING]` accessor brand. Pokemon demo migrated back to the natural `computed(() => fetchList(page()).then(...))` pattern in commit `cf7230e`.

---

## How to use this file

- When picking up work, scan **Open** for items related to the area you're touching.
- After fixing one, move it to **Already addressed** with the resolving commit SHA. (Don't just delete it — the traceability helps when revisiting reviews.)
- Add new items as their source reviews surface them. Each entry should record severity, description, and source.

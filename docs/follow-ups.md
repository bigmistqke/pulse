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

- **(later) Props-as-getters (Solid-style) for reactive props.** Today reactive props are typed `() => T` and consumed via `props.x()` — explicit and consistent with "function = reactive." Pulse rejected prop getters in favor of voby-style destructurable plain values. The cost surfaces when a prop type is widened to `FunctionMaybe<T>` (= `T | (() => T)`) for static-or-reactive flexibility: TypeScript can no longer distinguish `prop={use(x)}` (eager call, returns value, captured statically — runtime trap if pending) from `prop={() => use(x)}` (lazy, reactive, correct). Both forms typecheck under `FunctionMaybe<T>`. With strict `() => T` props this isn't an issue (call-site mistakes get TS errors), but `FunctionMaybe<T>` is a real ergonomic gravity for component authors who want flexibility. Prop getters would resolve this by making `<Comp prop={x}>` always reactive at the property-access site, without explicit call. Big architectural shift — would change destructuring semantics, prop access mechanics, and CONTEXT.md commitments. Revisit if/when several real components want both static and reactive use cases.
  Source: Plan 4 brainstorming (Loading design).
- **(later) `catchError` orphan sub-owner when no ambient owner.** Calling `catchError` outside any `createRoot` creates a sub-owner with `parent = null` that is not registered as a disposable anywhere — it lives until GC. In practice the reactive nodes inside it are individually unwatched by r3, so the handler effectively becomes unreachable, but there is no explicit dispose handle for the boundary itself. Consider returning `{ result, dispose }` from `catchError` in a future iteration, or document the constraint more loudly in the JSDoc.
  Source: Plan 2d final review (Minor).
- **(later) Drop signal write-back (`signal<T | Promise<T>>` auto-resolve).** With Plan 6's `computed(() => Promise)` fully fixed, the write-back hack in `signal()` (where setting a signal to a Promise auto-flips it to T on settle) is no longer needed in user code — `computed(() => p)` covers all cases naturally and with proper dep tracking. Consider removing write-back to simplify `signal` semantics: a signal stores exactly what you put in it, no implicit async behavior.
  Source: Plan 6 design discussion.
- **(later) ADR 0003 wording vs Plan 2b's per-stage implementation.** ADR 0003 says "one ordinary r3 computed node" + "stashed pipeline state". Plan 2b uses one r3 node *per stage* — same architectural commitment (r3 unmodified; async-ness in pulse wrappers), different mechanism (r3's memoization gives free per-stage caching). The ADR could be updated to record the chosen implementation, or kept as-is with the plan's scope note serving as the divergence record.
  Source: Plan 2b plan scope notes + final review.

### r3-side findings

- **(worth) r3 auto-disposes computeds when their sub count drops to 0, mid-flow.** Inside `unlinkSubs`, the line `if (nextSub === null && "fn" in dep) unwatched(dep)` triggers r3's automatic disposal cascade when a computed's last sub goes away. For pulse this bites when a consumer reads a pulse computed *conditionally*: if an effect skips the branch that reads `someComputed()`, `unlinkSubs` removes the dep edge, the computed's subs becomes empty, r3 calls `unwatched` on it, and the computed's own deps are detached too — so it stops listening to upstream signals. Subsequent re-subscription via `r3.read` re-attaches `effect → computed` but the computed's own deps (`computed → upstream`) stay null, so upstream changes never reach it. Workaround in user code: always-read the computed in the effect body (even if the value isn't always used). Long-term: pulse may need to install a phantom sub on owned computeds to keep them alive across periods of zero observers; or expose a "pinned" flag through `unwatched`. The Plan 2d integration test uses the always-read workaround.
  Source: Plan 2d Task 3 integration test debugging.


- **(worth) r3: dep-list partially stale after a throw in `recompute`.** When a `computed`/`effect` body throws partway, r3's `try/finally` (added in Plan 2c) correctly restores `context` and `flags`, but the post-`try` dep-pruning code (`unlinkSubs` against `depsTail`) is skipped. The throwing node retains its dep links from before the throw — including any deps it re-read during the failed partial run. Practically: a throwing computed may re-trigger from deps it should have dropped this run. Not a context-corruption bug; a "phantom re-trigger" risk. Worth pinning down before Plan 2d (error boundaries), since boundary recovery semantics may want to interact with the dep graph of caught nodes.
  Source: Plan 2c Task 3 final review (Important). r3 fix lands in r3's repo, not pulse's.

---

## Already addressed (kept for traceability)

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
- ~~`'reuse-value'` stash consumption in `src/computed.ts` loses dep tracking — sync computeds returning Promises freeze on first settle.~~ Fixed in commit `bea4b1c` (Plan 6) — rewrote `makeStageNode` to always run the body for r3 dep tracking and publish settle values out-of-band via an internal signal. Added stale-while-revalidate semantics and resolved-value (Object.is) caching; `isPending(computed)` exposes the refetch window via a `[PENDING]` accessor brand. Pokemon demo migrated back to the natural `computed(() => fetchList(page()).then(...))` pattern in commit `cf7230e`.

---

## How to use this file

- When picking up work, scan **Open** for items related to the area you're touching.
- After fixing one, move it to **Already addressed** with the resolving commit SHA. (Don't just delete it — the traceability helps when revisiting reviews.)
- Add new items as their source reviews surface them. Each entry should record severity, description, and source.

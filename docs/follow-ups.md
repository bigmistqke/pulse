# Follow-ups

Minor issues and observations surfaced by reviews that were explicitly non-blocking. Tracked here so they don't get lost; pick from this list when there's a natural moment to address one (a related task, a quiet pass, or before a major refactor).

Severity: **(small)** trivial cleanups · **(worth)** worth doing soon · **(later)** legitimate but can wait.

---

## Open

### Encapsulation / structure

- **(later) Move internal symbols to `src/_internal.ts`.** `NODE`, `makeAccessor`, `track`, `isGeneratorFunction`, `isAsyncFunction`, `runStage`, `StageOutcome` are all "intra-package public, public-API private". They're exported from `src/{signal,async,driver}.ts` for cross-file use but kept out of `src/index.ts`. As more internals accumulate (Plan 2c, Plan 3), a dedicated `_internal.ts` would make the boundary explicit and unblock easier audits.
  Source: Plan 1 final review (I2); reinforced by Plan 2b final review.
- **(small) Decide whether `isPromise` should be exported from the public barrel.** Plan 3 (DOM layer) will likely need it for binding-effect logic the user might want to inline. Currently internal-only. Defer the decision to when Plan 3 actually needs it.
  Source: Plan 2a final review (I2).
- **(small) `isAsyncFunction` is exported from `src/async.ts` but used nowhere.** Either drop the export (YAGNI) or wire it in if Plan 2c or 3 finds a use. The predicate itself is correct.
  Source: Plan 2b final review.

### Test coverage gaps

- **(worth) No test that a mid-pipeline computed throw does NOT double-fire the handler from downstream stages.** Each stage's r3 wrapper calls `routeError(myOwner, e)` only on its own throw, and a throwing stage freezes (`lastGoodValue` returned → no propagation), so downstream stages should not see the throw. The behaviour is correct by construction but unpinned. A two-stage pipeline where stage 1 throws and stage 2 is a sink would document the contract.
  Source: Plan 2d final review (Future).


- **(worth) No test for `use(0)`, `use(null)`, `use(undefined)`.** The `v != null` and `typeof` guards in `isPromise` handle these, but a one-liner boundary test would document the contract explicitly.
  Source: Plan 2a final review (M3).
- **(worth) No test for the reuse-value rejected-stash path.** `src/computed.ts` handles `r.kind === 'rejected'` by re-throwing in the next r3 fn invocation. That code is reachable (an async stage's returned promise can reject) but currently untested. Plan 2c will exercise this via error boundaries; until then it's an unproven leaf.
  Source: Plan 2b final review.
- **(later) No test for within-generator restart-from-top with multiple `yield*` points.** The current behaviour (a `function*` body with two yields restarts from the top on a sync dep change, fast-forwards both yields via the WeakMap) is correct but documented only in scope notes. A test covering this would make the contract explicit before someone tries to add intra-generator checkpoint resume.
  Source: Plan 2b final review.
- **(later) Integration tests are minimal.** Plan 2a and 2b each have a couple of integration tests; scenarios like nested pipelines, transitions across multiple signals, and the `signal-set-mid-flight` path could be deepened. Not a correctness gap — just thin coverage on real-world shapes.
  Source: Plan 2a final review.

### Comments / docs

- **(small) Stray `// eslint-disable-next-line` in `src/driver.ts`.** The project has no ESLint config, so the comment is harmless but misleading. The underlying `any` is correct and necessary — leave the `any`, drop the comment.
  Source: Plan 2b final review.
- **(small) Comment the `(value: any)` widening in `computed.ts` and `driver.ts`.** It's the standard implementation-signature pattern for variadic overloads; a brief inline comment would forestall well-intentioned "fix" PRs that try to narrow it to `unknown`.
  Source: Plan 2b final review.
- **(small) `src/effect.ts`'s `microtaskScheduler` reset ordering.** A comment near the `queued = false; flush()` pattern explaining that the reset must come *before* flush so writes during flush re-queue rather than being dropped. Plan 1 added a one-liner; consider expanding if a maintainer revisits.
  Source: Plan 1 final review (M3).
- **(later) Document the within-generator restart-from-top semantics in `src/computed.ts`.** A comment near the `'fast-forward'` branch explaining that within a `function*` body, the runtime re-invokes the generator from the top on each kick (relying on the driver's WeakMap to fast-forward settled yields). Cross-stage caching is the per-stage r3 computed; intra-generator caching is explicitly deferred.
  Source: Plan 2b final review.

### DOM-layer findings (Plan 3a)

- **(small) `render(component, target)` leaks the root owner if `component()` throws synchronously.** The root owner created by `createRoot` is unreferenced — the throw escapes before `dispose` is returned to the caller. Trivial; wrap the `component()` invocation in `try/catch` that disposes the owner before re-throwing.
  Source: Plan 3a final review (Minor).

### Control-flow findings (Plan 3b)

- **(later) Switch's branch caching is keyed by Match-object identity.** If a user wraps Switch's children in a function that constructs fresh Match objects on each call (e.g. a parent re-render rebuilds the Match list), every re-run looks like a winner-change and disposes/remounts the branch. Currently fine because JSX inlines Match calls once at parent-component construction. Worth documenting in Switch's JSDoc: "Place Match children inline in Switch's JSX; reconstructing them per-run defeats branch caching."
  Source: Plan 3b final review (Minor).
- **(later) `Show`'s function child is called once per truthy transition, not on each truthy value update.** Documented in the JSDoc but worth flagging as a user-facing semantic: `<Show when={user}>{u => <span>{u.name}</span>}</Show>` captures `u` at transition time; if `user.name` changes (same object, mutated), the rendered DOM doesn't update unless the children body has its own reactive read. A `keyed` opt-in (Solid-style) that re-invokes children on each truthy-value change is a future enhancement.
  Source: Plan 3b final review (Minor).

### API ergonomics

- **(worth) Widen `use` to accept an accessor too.** Today `use<T>(x: T | Promise<T>): T` requires `use(signal())`. Accept `Accessor<T | Promise<T>>` as a third arm so `use(signal)` works directly. Rationale: symmetry with `read` (the generator-side universal resolver already accepts signals, promises, or plain values) and one less call-site asterisk in real-world bindings. Implementation is one branch: `if (typeof x === 'function') x = x()`. Real footgun: if `T extends Function`, the value would be called accidentally — rare; users with a function value can box it. Backward-compatible: `use(value())` keeps working because the existing union arm still matches. Touch: `src/async.ts` + a test + `CONTEXT.md` `use` entry.
  Source: Plan 3a brainstorming exchange (deferred from Plan 3a scope; agreed to land as follow-up after Plan 3a final review).

### Architectural notes

- **(later) Props-as-getters (Solid-style) for reactive props.** Today reactive props are typed `() => T` and consumed via `props.x()` — explicit and consistent with "function = reactive." Pulse rejected prop getters in favor of voby-style destructurable plain values. The cost surfaces when a prop type is widened to `FunctionMaybe<T>` (= `T | (() => T)`) for static-or-reactive flexibility: TypeScript can no longer distinguish `prop={use(x)}` (eager call, returns value, captured statically — runtime trap if pending) from `prop={() => use(x)}` (lazy, reactive, correct). Both forms typecheck under `FunctionMaybe<T>`. With strict `() => T` props this isn't an issue (call-site mistakes get TS errors), but `FunctionMaybe<T>` is a real ergonomic gravity for component authors who want flexibility. Prop getters would resolve this by making `<Comp prop={x}>` always reactive at the property-access site, without explicit call. Big architectural shift — would change destructuring semantics, prop access mechanics, and CONTEXT.md commitments. Revisit if/when several real components want both static and reactive use cases.
  Source: Plan 4 brainstorming (Loading design).
- **(later) `catchError` orphan sub-owner when no ambient owner.** Calling `catchError` outside any `createRoot` creates a sub-owner with `parent = null` that is not registered as a disposable anywhere — it lives until GC. In practice the reactive nodes inside it are individually unwatched by r3, so the handler effectively becomes unreachable, but there is no explicit dispose handle for the boundary itself. Consider returning `{ result, dispose }` from `catchError` in a future iteration, or document the constraint more loudly in the JSDoc.
  Source: Plan 2d final review (Minor).
- **(later) Promote "create a parented sub-owner" into a shared internal before Plan 3.** Today only `catchError` produces parented children. When DOM components arrive in Plan 3 they will want the same machinery (parent link, disposal-cascade registration, optional handler). Extract `createSubOwner(handler?)` from `catchError`'s body as the first move of Plan 3 rather than retrofitting under DOM pressure.
  Source: Plan 2d final review (Future).
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

---

## How to use this file

- When picking up work, scan **Open** for items related to the area you're touching.
- After fixing one, move it to **Already addressed** with the resolving commit SHA. (Don't just delete it — the traceability helps when revisiting reviews.)
- Add new items as their source reviews surface them. Each entry should record severity, description, and source.

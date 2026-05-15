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

### Architectural notes

- **(later) ADR 0003 wording vs Plan 2b's per-stage implementation.** ADR 0003 says "one ordinary r3 computed node" + "stashed pipeline state". Plan 2b uses one r3 node *per stage* — same architectural commitment (r3 unmodified; async-ness in pulse wrappers), different mechanism (r3's memoization gives free per-stage caching). The ADR could be updated to record the chosen implementation, or kept as-is with the plan's scope note serving as the divergence record.
  Source: Plan 2b plan scope notes + final review.

---

## Already addressed (kept for traceability)

- ~~Plan 1: `setSignal` type cast loses `T` info → narrowed to `as R3Signal<T>`.~~ Fixed in commit `4289c49` (Plan 1 Task 2 amend).
- ~~Plan 1: `WritableSignal` brand to make `setSignal` type-reject computeds.~~ Fixed in commit `7f4ffec` (Plan 1 post-final-review fix).
- ~~Plan 1: `noUncheckedIndexedAccess` causing typecheck failures via r3 source aliasing.~~ Resolved by dropping the flag from `tsconfig.json`.
- ~~Plan 2a: Effect-suspension accumulating `.then` listeners on repeat suspension on the same promise.~~ Fixed in commit `91bda2b` (Plan 2a post-final-review fix — added `alreadySuspendedOnSame` guard).
- ~~Plan 2a: `generation.set(s, 0)` at signal creation to make the "never written" state explicit.~~ Fixed in commit `4f89bc8` (Plan 2a Task 2 amend).
- ~~Plan 2a: `kickCount` comment explaining why an incrementing counter is used.~~ Fixed in commit `91bda2b`.
- ~~Plan 2b: Stash race in `makeStageNode` — consumed stale value when upstream re-suspended.~~ Fixed in commit `c8f24aa` (added `suspendedInput` + `Object.is` validation; regression test).

---

## How to use this file

- When picking up work, scan **Open** for items related to the area you're touching.
- After fixing one, move it to **Already addressed** with the resolving commit SHA. (Don't just delete it — the traceability helps when revisiting reviews.)
- Add new items as their source reviews surface them. Each entry should record severity, description, and source.

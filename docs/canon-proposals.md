# Canon proposals

[`CANON.md`](../CANON.md) describes what pulse does now, written backwards from the code, the tests and the design documents. Where a document said nothing, or said something the code does not do, the canon follows the code. This file lists those places, so that a later review can decide whether each behaviour is the one pulse should have. It is deleted once it is empty.

## Probably unintended behaviour the canon records as it is

- `rule-an-effect-created-in-an-action-misses-what-the-action-wrote`. ADR 0010 says effects are forbidden inside a speculation, and `docs/pulse/CONTEXT.md` says `effect(...)` throws when an ancestor scope is speculative. Neither is true. The effect's first run reads the action's writes, and it then stops following a source the action wrote until it re-runs for another reason.
- `exception-a-catch-error-ends-an-actions-search-silently`. A failed action under a `catchError` does not call the handler and reports to no boundary. The error is visible only on the action's handle. The nearest accepting boundary is found, and then nothing is told.
- `rule-a-throw-from-a-catch-error-body-reaches-only-catch-error-handlers`. A throw from a `catchError` body walks only `catchError` handlers, never an `<Errored>` or the root's boundary, and is re-thrown even inside a root. A throw from a node considers both kinds. There are two routes for one kind of event.
- `rule-a-catch-error-handler-is-called-for-each-throw-under-it`. A `catchError` handler is a callback called once per throw, possibly several times for one rejection. `axiom-an-error-is-graph-state-not-an-event` says a boundary shows state and does not count throws; `catchError` is the part of the error system that does not follow it.
- `exception-structure-mounts-at-once-inside-a-pending-boundary`. `<Show>` and `<For>` mount and unmount structure at once inside a pending `<Loading>`; only content holes wait. `CONTEXT.md` describes a gate that holds the entire prior tree. `docs/follow-ups.md` already tracks this.
- `rule-an-equal-value-does-not-notify-consumers` states deduplication only for computeds. For plain signals, a probe showed that writing `NaN` over `NaN` re-notifies consumers, although ADR 0008 names that case as its example of an `Object.is` no-op. No test pins plain-signal deduplication either way.

## Stated from the code, with no document behind it

- `axiom-teardown-unwinds`. Closing runs callbacks in reverse order of registration, and one that throws stops nothing else: `onSettled` callbacks, owner cleanups, and a generator's cleanups after its `finally` blocks.
- `axiom-the-latest-production-wins`, and `axiom-an-error-is-graph-state-not-an-event`. Each comes from a design spec under `docs/superpowers/specs/`, not from an ADR or a principle in `framings.md`. The error spec is marked "designed, not implemented" and names things that shipped under other names (`<Failed>` became `<Errored>`, `failure(x)` became `error(x)`). Both may want an ADR.
- `rule-overlapping-writes-resolve-by-commit-order`. ADR 0009 states last-commit-wins; a test now confirms it. Whether commit order is the right tie-breaker is open.
- `rule-list-rows-are-keyed-by-reference`. Rows are keyed by reference equality. No document says why reference and not a key function or index. Duplicate references in one list are not covered by a test.
- `rule-an-event-handler-runs-under-the-owner-it-was-bound-in` and `rule-a-component-that-throws-during-render-leaves-nothing-behind`. Each is stated only in a code comment.
- `rule-pulse-reaches-r3-only-through-its-exports`. A practice visible in ADR 0005, not a stated rule.
- The error boundary rules for the root's default boundary logging every report, and for an error write scheduling its own flush.

## Parents chosen at merge, to confirm

- `rule-the-handle-reports-its-newest-attempt` under `axiom-a-speculation-commits-or-is-discarded-whole`. That `retry()` opens a fresh speculation follows from the axiom; that only the newest attempt is reported does not.
- `rule-a-live-prediction-reports-neither-pending-nor-failed` under the same axiom. Its reasoning comes from ADR 0016 (a prediction is on screen, so nothing should suspend behind it), not from the axiom.
- `rule-an-optimistic-value-is-read-like-any-node` under `axiom-compose-rather-than-proliferate`.
- The staged effect joins its boundary's gate because `stagedEffect` reads its pipeline with `use`. The canon states this as a case of `rule-use-enrols-the-binding-in-its-boundarys-gate`; `CONTEXT.md` describes it as a property of staged effects.
- `rule-runwithowner-restores-the-previous-owner` and `rule-a-scope-reads-through-its-chain` state the same save-and-restore pattern for owners and for speculative scopes. The second could also cite `axiom-ambient-context-is-set-for-a-call-and-restored-after`.

## Where the code contradicts a document

- `docs/pulse/framings.md`, P3: a plain read "never throws". Reading the accessor of a failed async computed, or of a failed `signal(fn)`, throws the rejection reason. Only `peek` and `latest` never throw. `axiom-plain-reads-are-honest` is worded to what holds.
- ADR 0008 describes `signal(value, { equals })`. The option does not exist; a second argument is silently ignored.
- `CONTEXT.md`, the Owner entry: orphaned reactive nodes warn. Only DOM bindings and event listeners do; a bare `effect()` or `computed()` outside every owner is silent, and `onCleanup` there is a silent no-op.
- `CONTEXT.md` and `docs/pulse/CONTEXT.md` describe the error boundary as `catchError` only. `<Errored>`, report collections, `for` predicates and the root's default boundary are not described. ADR 0006 predates `<Errored>` joining the walk as a peer and the `for` predicate.
- `docs/pulse/CONTEXT.md` uses the old names: `latest` for what is now `peek`, and `yield* read` for what is now `from`. ADR 0013 also says `read`.
- The README's "Prior art" says props are passed as plain values rather than Solid-style getters. Since commit 593d3a2 the compiler emits real getters.
- `docs/follow-ups.md` says `Fragment` now resolves its children into DOM nodes. It returns its raw children, tagged with the owner current when it was built. The effect described is the same; the mechanism is not.
- `src/dom/error.ts`: the doc comment on `useErrored` says it returns an always-inactive state under a root with no `<Errored>`. It returns the root's boundary. `test/error.test.ts` opens with a "not implemented yet; these are red" comment on tests that pass.
- `CONTEXT.md`'s Control flow entry covers `Show` and `For`. `Switch` also skips a `Match` whose condition is pending; no test pins it.

## Tests whose title claims more than they assert

- `test/owner.test.ts`: "onCleanup outside any context is a no-op" asserts only that it does not throw. "runWithOwner sets the ambient owner … and restores after" asserts only that the owner is non-null.
- `test/dom/orphaned-warning.test.ts`: "a static attr:/bare/prop:/class:/style: value still warns" exercises two of the five kinds.
- `test/async-action.test.ts`: "action() stops candidate-collection at the nearest catchError" asserts only that nothing was logged, not that the handler is never called.
- `rule-an-error-nothing-claims-is-thrown-on-a-first-run`: the re-run half (logged instead of thrown) is confirmed by a probe but pinned by no test.
- `test/async.test.ts`: "peek is reactive" does not assert that a promise settling leaves the effect alone.
- `test/pending.test.ts`: two tests build pending entries by hand instead of through `computed`.
- `test/computed.test.ts`: "an async stage suspends the pipeline; the value flips …" never checks the raw read after settle. Three tests are named after historical bugs rather than the behaviour they pin.
- `test/signal.test.ts` "computed accessor is not writable (type-level)" and two `(compile-time)` tests in `test/writable-derived.test.ts` are checked by the type checker, not by vitest.
- `test/smoke.test.ts` calls r3 directly and pins nothing about how pulse uses it.
- `test/driver.test.ts`: "async stage with pending promise -> suspended (carries the same promise instance)" never checks the instance.
- `test/dom/loading.test.tsx`: "useLoading() inside subtree reflects pending state" and "isLoading() inside subtree reflects pending state" assert only the settled state. "rapid src-swap keeps pending count at 1" never asserts the count.
- `test/dom/loading-atomic.test.tsx`: "mid-flight mount without fallback: prior tree retained until gate opens" asserts the opposite of its title. "newly-mounted binding inside <Loading> joins the gather" shows no gather. "coherent transitions" carries a stale "← FAILS" comment.
- `test/dom/binding-events.test.ts`: "on:event passes the lowercased event name". The name is not lowercased.
- `test/dom/binding-ref.test.ts`: "ref is invoked once even if its underlying value is a signal accessor" passes a plain function.
- `test/babel-plugin.test.ts`: two tests check only the compiled shape of what their titles describe at runtime.
- No test pins that a `Switch` re-run with the same winner keeps its branch, or that a staged effect skips a commit equal to the last one.

## Not covered by the canon

- `test/dom/smoke.test.ts` checks that the browser test environment works. It pins nothing about pulse and is left untagged.
- `src/vite-jsx-plugin.ts` has no test, so no rule states it.
- The DOM suites were not run while the canon was written: Playwright's Chromium is not installed in that environment. The rules pinned only by DOM tests are stated from reading the tests and the source. `pnpm exec playwright install chromium` and then `pnpm test` would confirm them.

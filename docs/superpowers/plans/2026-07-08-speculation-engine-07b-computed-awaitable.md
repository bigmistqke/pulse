# Speculation Engine — Plan 7b: Migrate `computed.ts` to `Awaitable` (close the two-home window)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD, checkbox steps. **This is the highest-risk migration in the sequence** — `makeStageNode` is densely coupled and the async test suite is the authoritative behavior spec. Proceed incrementally; report BLOCKED (do not weaken tests) if a resumption-mode detail resists.

**Goal:** Complete the uniform-`Awaitable` migration (ADR 0011, adapter): make a `computed` stage's *view value* an `Awaitable` (when async), retire `publishedValue`/`lastResolvedValue` and the `states`/`lastResolved` WeakMaps, and close the two-home window opened in Plan 7 — while the async/pending/effect-stages suite stays green.

**Architecture:** Adapter, not rewrite (ADR 0011). **Keep** `makeStageNode`'s machinery — the `depTracker` r3 computed, the `kick` (generator fast-forward), `suspendOn`/settle wiring, `pendingSig`, `deferredError`. **Relocate** the view: `publishedValue` now carries an `Awaitable` (async) or the bare value (sync); `lastResolvedValue`'s SWR role moves onto the `Awaitable`'s seeded `.value`. Two named subtleties drive the tasks:

1. **Reactivity-on-settle vs staying-an-`Awaitable`.** Under uniform `Awaitable`, an async computed's view *stays* an `Awaitable` after settle (no flip to bare `T`). But re-`setPublishedValue`-ing the *same* mutated `Awaitable` won't fire (Object.is equal). So **settle publishes a *fresh, already-fulfilled* `Awaitable`** (distinct object → fires; `.status: 'fulfilled'`, `.value: result`). A helper `resolvedAwaitable(value)` produces one.
2. **`reuse-value` simplifies; generators keep `kick`.** For sync/async stages that returned a promise (`reuse-value`), the resolved value *is* the `Awaitable`'s `.value` — the settle handler publishes the fresh fulfilled `Awaitable` directly; the `stashedResolution` dance is no longer needed for publishing (it was only there to feed `publishedValue` without re-invoking the stage). For generator stages (`fast-forward`), the stage's true return is a *transformation* of the yielded value, so the settle still `kick`s a re-run and publishes whatever the re-run yields (sync value or a new `Awaitable`).

**Tech Stack:** TypeScript, vitest (`pnpm test`), r3.

**Behavior baseline:** run `pnpm test` first, record the count (expect **298 passing / 1 skipped**). The constraining files are `test/async`, `test/pending`, `test/computed`, `test/effect-stages`, `test/integration-async*`, and the DOM `loading`/`show`/`switch` tests. Some tests currently assert an async computed's view is a *raw Promise*; those assertions become "an `Awaitable`" — update them to the new intended behavior (an `Awaitable` is still `instanceof Promise`, so many pass unchanged), but **only** where the change is the intended Awaitable behavior, never to mask a regression.

---

## File structure

- **Modify: `src/awaitable.ts`** — add `resolvedAwaitable(value)` (a pre-fulfilled `Awaitable`).
- **Modify: `src/computed.ts`** — relocate the view to `Awaitable`; simplify `reuse-value`; retire `lastResolvedValue`.
- **Modify: `src/async.ts`** — once computeds also produce `Awaitable`s, retire the `states`/`lastResolved` WeakMaps (or reduce them to the raw-promise fallback only, if any raw-promise producers remain).
- **Modify: test files** — update the few raw-promise-view assertions to `Awaitable` assertions.

---

## Task 1: `resolvedAwaitable` helper

**Files:** Modify `src/awaitable.ts`; Test `test/awaitable.test.ts`.

- [ ] **Step 1: Failing test** (append):

```ts
import { resolvedAwaitable } from '../src/awaitable'

test('resolvedAwaitable is an already-fulfilled Awaitable', async () => {
  const a = resolvedAwaitable(42)
  expect(a.status).toBe('fulfilled')
  expect(a.value).toBe(42)
  expect(a).toBeInstanceOf(Promise)
  expect(await a).toBe(42)
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (`src/awaitable.ts`) — reuse `toAwaitable`, forcing the fulfilled state synchronously so consumers reading `.status` right after settle see `'fulfilled'`:

```ts
/** A pre-fulfilled Awaitable carrying `value`. Used when an async view settles:
 *  publishing a FRESH fulfilled Awaitable (distinct object) re-fires consumers
 *  while keeping the view an Awaitable (no write-back to bare T). */
export function resolvedAwaitable<T>(value: T): Awaitable<T> {
  const a = toAwaitable(Promise.resolve(value), value)
  a.status = 'fulfilled'
  a.value = value
  return a
}
```

- [ ] **Step 4: Run — expect PASS.** Then `pnpm test` (baseline unchanged; new module fn only).
- [ ] **Step 5: Commit** — `git commit -m "feat(awaitable): resolvedAwaitable — pre-fulfilled Awaitable for settle publishes"`

---

## Task 2: Stage view carries an `Awaitable` on suspend (SWR-seeded)

**Files:** Modify `src/computed.ts`; Test via the async suite.

- [ ] **Step 1: Establish the constraint.** Read `makeStageNode`'s `suspendOn` and the upstream-pending branch. Both currently do `setPublishedValue(p)` (the raw promise) on first-load and hold the prior under SWR. The change: publish an `Awaitable` wrapping the promise, seeded with the prior (`lastResolvedValue`, or `undefined` if `UNRESOLVED`).

- [ ] **Step 2: Implement.** In `computed.ts`, import `toAwaitable`. In `suspendOn`, replace the first-load publish:

```ts
if (lastResolvedValue === UNRESOLVED) {
  setPublishedValue(toAwaitable(p, undefined))
} else {
  setPublishedValue(toAwaitable(p, lastResolvedValue)) // SWR prior on the Awaitable
}
```

and likewise in the upstream-pending branch (`if (isPromise(input))`), wrap `input` with the prior seed. (If `input` is already an `Awaitable` from an upstream migrated stage, re-wrap or pass through carrying its `.value` as the prior — validate against the pipeline tests.)

- [ ] **Step 3: Run the async suite.** `pnpm test`. Expect: tests asserting the pending view is a raw `Promise` now see an `Awaitable` — update those assertions to `Awaitable` (still `instanceof Promise`, plus `.status === 'pending'` / `.value` is the SWR prior). Do NOT change any test that isn't specifically about the pending-view shape. If a pipeline/suspension test fails for a non-shape reason, **report BLOCKED** with the test + actual/expected.

- [ ] **Step 4: Commit** — `git commit -m "feat(computed): stage suspend publishes an SWR-seeded Awaitable view"`

---

## Task 3: Settle publishes a fresh fulfilled `Awaitable`; simplify `reuse-value`

**Files:** Modify `src/computed.ts`; Test via the async suite.

- [ ] **Step 1: Implement the settle change.** In the `reuse-value` fulfilled branch of the settle handler (and the sync-result branch), replace `setPublishedValue(state.value)` / `setPublishedValue(outcome.value)` with publishing a **fresh fulfilled `Awaitable`** so the view stays an `Awaitable` *and* re-fires:

```ts
lastResolvedValue = state.value
deferredError = null
setPublishedValue(resolvedAwaitable(state.value))
```

Keep the `Object.is(lastResolvedValue, state.value)` change-gate (ADR 0008) — only publish when the resolved value changed. The `stashedResolution` publish path is no longer needed for `reuse-value` (the fresh fulfilled `Awaitable` carries the value); remove the now-dead stash-publish if the tests confirm it's unreachable, else leave it and note it.

The rejected branch: publish so consumers re-read and `use()` throws — keep `deferredError` + a publish (a rejected `Awaitable` via `toAwaitable(Promise.reject(reason))`, or keep the `deferredError` throw path if simpler; validate against the error tests).

- [ ] **Step 2: Generators (`fast-forward`) unchanged in mechanism.** The generator settle still `setKick(++kickCount)` → body re-runs → the re-run's `runStage` returns the generator's true value, which flows through the same sync-result / pending publish (now Awaitable-aware). Confirm the generator pipeline tests pass without touching the kick logic.

- [ ] **Step 3: Run the async suite.** `pnpm test`. Expect green (updating only Awaitable-shape assertions). **Report BLOCKED** on any non-shape failure — especially in `test/effect-stages` (generator fast-forward) or `integration-async-pipeline` (multi-stage) — with specifics; these are the delicate paths.

- [ ] **Step 4: Commit** — `git commit -m "feat(computed): settle publishes fresh fulfilled Awaitable; reuse-value simplified"`

---

## Task 4: Retire `lastResolvedValue` and close the two-home window

**Files:** Modify `src/computed.ts`, `src/async.ts`; Test via the full suite.

- [ ] **Step 1: `computed.ts` SWR from the Awaitable.** `lastResolvedValue` now duplicates the view `Awaitable`'s `.value`. Where the SWR prior is needed (suspend seed), read it from the current published view (`const cur = publishedValue(); const prior = cur ? .value-if-Awaitable : cur`) instead of the `lastResolvedValue` closure, then remove the closure. Keep the `Object.is` change-gate by comparing against the current view's resolved value. Validate against the SWR tests (`test/async`, `test/computed`).

- [ ] **Step 2: `async.ts` retire the WeakMaps.** Now that both signals (Plan 7) and computeds (Tasks 1–3) produce `Awaitable`s, `track`'s `states` WeakMap and `latest`'s `lastResolved` WeakMap are only reachable for genuinely-raw promises (external promises a user stores directly). Decide from the tests: if nothing in the suite exercises a raw-promise-not-wrapped path, retire both WeakMaps and make `track`/`latest` read the `Awaitable` exclusively; if a raw-promise path remains (e.g. a user `signal(externalPromise)` before it's wrapped — but Plan 7 wraps those), keep a minimal fallback. Prefer full retirement (single home) per ADR 0011's "converge to one model."

- [ ] **Step 3: Full guard.** `pnpm test` + `pnpm exec tsc --noEmit`. Expect: the whole suite green (with Awaitable-shape assertions updated), no `publishedValue`-as-raw-promise, no `lastResolvedValue` closure, WeakMaps retired (or reduced to a documented minimal fallback). **This is the convergence checkpoint** — after it, there is one read model (uniform `Awaitable`), closing the two-home window ADR 0011 opened.

- [ ] **Step 4: Commit** — `git commit -m "refactor(computed,async): retire lastResolvedValue + WeakMaps; single uniform-Awaitable read model"`

---

## Self-review

**Spec coverage (ADR 0011, computed-side + convergence):** `resolvedAwaitable` (settle-reactivity keeping the view an Awaitable) → Task 1; suspend publishes an SWR-seeded `Awaitable` → Task 2; settle publishes a fresh fulfilled `Awaitable` + `reuse-value` simplified, generators unchanged → Task 3; retire `lastResolvedValue` + the `states`/`lastResolved` WeakMaps, close the two-home window → Task 4.

**Risk — this is the plan to watch.** `makeStageNode` is the most coupled code in the engine; ADR 0011 chose the adapter precisely to avoid a rewrite. The two named subtleties (fresh-fulfilled-Awaitable on settle for reactivity; `reuse-value` simplification vs generator `kick`) are where a blind spec is least reliable, so **the async/pending/effect-stages/DOM-loading suite is the authoritative behavior spec** and each task gates on it. The executor should: relocate incrementally, update only Awaitable-*shape* assertions, and **report BLOCKED with the failing test + actual/expected on any non-shape failure** rather than guessing at a resumption-mode change. The `reuse-value` stash removal (Task 3) and the WeakMap retirement (Task 4) should each be validated as genuinely-dead before deletion.

**Placeholder scan:** the task bodies give real target code (`resolvedAwaitable`, the `suspendOn`/settle publish changes) grounded in the current `makeStageNode`; where the exact edit depends on runtime behavior (upstream-Awaitable re-wrap in Task 2; stash-dead-code and WeakMap-fallback decisions), the plan states the decision *and* the validation (against named test files) rather than a fabricated certainty — appropriate for a coupled-code migration, not a placeholder.

**Type consistency:** `Awaitable<T>`, `toAwaitable(source, prior?)`, `resolvedAwaitable(value)`, `track` (Awaitable-aware, Plan 7), `latest` (shim, Plan 7) used consistently; `publishedValue` now carries `Awaitable<T> | T` and the accessor returns it unchanged.

**After this plan:** the read model is unified (uniform `Awaitable`, ADR 0011 fully realized in code; ADR 0002's write-back superseded end to end). Next: **Plan 8** — speculation in public computeds (route the stage pipeline through the overlay so a public computed reflects an action's speculative writes; add the `committed` isolation read) — then `reject`, `settled`, optimistic surfaces.

# Read-Time Filtering on `useFailed`/`Failed.Error` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `useFailed()` and `Failed.Error` take an optional predicate, so a reader can pick a specific kind of failure out of whatever `<Failed>` boundary it is already scoped under, instead of always taking the boundary's first currently-failed report.

**Architecture:** `FailedScope` stops collapsing its internal collection down to "the first report" and exposes the whole thing (`reports: Accessor<readonly FailureReport[]>`). `useFailed`/`Failed.Error` filter that full set by an optional predicate; `<Failed>`'s own `error`/`active`/`fallback` stay based on the first entry, unaffected. Nothing about routing (which boundary a failure's report lands in, or whether it propagates past a boundary toward root) changes.

**Tech Stack:** TypeScript, r3, vitest (`|unit|` project for `.test.ts`, `|dom (chromium)|` project for `.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-08-19-failed-boundary-read-time-filtering-design.md`

## Global Constraints

- `<Failed>`'s own `fallback` mechanism and its `for` prop's registration-time semantics are completely unaffected — `<Failed>`'s own `error`/`active` reads stay based on the first entry (`reports()[0]`), unfiltered, exactly as today.
- `action()`'s candidate collection (`src/scope.ts`), `effect.ts`'s two call sites, `findNearestFailedScope`, `routeError`, `catchError` are not touched at all in this plan.
- Every existing `useFailed()`/`Failed.Error` call site (no predicate/`for` given) must need zero changes and keep passing unmodified — confirmed by running the full pre-existing test suite unchanged after each task.
- `useFailed(predicate).retry()` retries only reports matching the predicate, not the boundary's whole collection — a deliberate departure from `<Failed>`'s own `reset()`, which always clears everything.
- `examples/todo-async` is out of scope for this plan — the spec's own "What does not change" section explicitly excludes it; adopting `useFailed(predicate)` there is a separate follow-up.

---

### Task 1: `FailedScope.reports`, exported `FailureReport`, and the collection restructuring in `src/owner.ts`

**Files:**
- Modify: `src/owner.ts`
- Test: `test/owner.test.ts`
- Modify (mechanical, hand-rolled test fixtures): `test/owner.test.ts`, `test/async-action.test.ts`

**Interfaces:**
- Produces: `FailureReport` (was a private interface in `src/owner.ts`, becomes exported, fields become `readonly`); `FailedScope` gains `readonly reports: Accessor<readonly FailureReport[]>`; `createFailedScope`'s own signature is unchanged (`(onFailedReport?: (error: unknown) => void, filterFor?: (error: unknown) => boolean) => FailedScope`).

- [ ] **Step 1: Write the failing tests**

Add to `test/owner.test.ts`, after the last existing test in the file (currently ending with `'findBoundaryScope returns null when no scope on chain'`). First update the file's own import line — it currently reads:

```ts
import {
  catchError,
  createRoot,
  createSubOwner,
  findBoundaryScope,
  findNearestFailedScope,
  getOwner,
  onCleanup,
  runWithOwner,
  type FailedScope,
  type LoadingScope,
} from '../src/owner'
```

Replace with:

```ts
import {
  catchError,
  createFailedScope,
  createRoot,
  createSubOwner,
  findBoundaryScope,
  findNearestFailedScope,
  getOwner,
  onCleanup,
  runWithOwner,
  type FailedScope,
  type FailureReport,
  type LoadingScope,
} from '../src/owner'
```

Then add the new tests:

```ts
test('FailedScope.reports() reflects every currently-registered failed controller, in registration order', () => {
  const scope = createFailedScope()
  const errorA = new Error('a')
  const errorB = new Error('b')
  const controllerA = scope.register()
  const controllerB = scope.register()

  controllerA.report({ status: 'failed', error: errorA, source: null, retry: () => {} })
  controllerB.report({ status: 'failed', error: errorB, source: null, retry: () => {} })

  const reports = scope.reports()
  expect(reports).toHaveLength(2)
  expect(reports[0].error).toBe(errorA)
  expect(reports[1].error).toBe(errorB)
})

test('FailedScope.reports() removes an entry once its controller reports idle or unregisters', () => {
  const scope = createFailedScope()
  const errorA = new Error('a')
  const errorB = new Error('b')
  const controllerA = scope.register()
  const controllerB = scope.register()

  controllerA.report({ status: 'failed', error: errorA, source: null, retry: () => {} })
  controllerB.report({ status: 'failed', error: errorB, source: null, retry: () => {} })
  expect(scope.reports()).toHaveLength(2)

  controllerA.report({ status: 'idle' })
  expect(scope.reports()).toHaveLength(1)
  expect(scope.reports()[0].error).toBe(errorB)

  controllerB.unregister()
  expect(scope.reports()).toHaveLength(0)
})

test('a controller re-reporting the identical error does not publish a new reports array', () => {
  const scope = createFailedScope()
  const error = new Error('boom')
  const controller = scope.register()

  controller.report({ status: 'failed', error, source: null, retry: () => {} })
  const first = scope.reports()

  controller.report({ status: 'failed', error, source: null, retry: () => {} })
  const second = scope.reports()

  expect(second).toBe(first)
})

test('onFailedReport still fires on every failed report, even one that does not change the published collection', () => {
  const seen: unknown[] = []
  const scope = createFailedScope((error) => seen.push(error))
  const error = new Error('boom')
  const controller = scope.register()

  controller.report({ status: 'failed', error, source: null, retry: () => {} })
  controller.report({ status: 'failed', error, source: null, retry: () => {} })

  expect(seen).toEqual([error, error])
})

test('FailedScope.error()/active() still report the first entry, unaffected by reports() existing', () => {
  const scope = createFailedScope()
  const errorA = new Error('a')
  const errorB = new Error('b')
  const controllerA = scope.register()
  const controllerB = scope.register()

  expect(scope.active()).toBe(false)
  expect(scope.error()).toBe(null)

  controllerA.report({ status: 'failed', error: errorA, source: null, retry: () => {} })
  controllerB.report({ status: 'failed', error: errorB, source: null, retry: () => {} })

  expect(scope.active()).toBe(true)
  expect(scope.error()).toBe(errorA)
})
```

None of these tests need `createRoot` or any owner context — `createFailedScope` is built directly on raw r3 primitives and does not touch the ambient owner at all (confirmed by reading its current implementation).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/owner.test.ts -t "reports\(\)|onFailedReport still fires|still report the first entry"`

Expected: FAIL — `FailedScope` (and the object `createFailedScope` returns) has no `reports` property yet, so every new test throws `scope.reports is not a function`.

- [ ] **Step 3: Export `FailureReport`, add `reports` to `FailedScope`**

In `src/owner.ts`, find:

```ts
/** What a failed binding reported: the error, the node whose parked failure it
 *  threw (if any), and how to re-run it. Mirrors the shape `src/effect.ts`
 *  reports through `BindingState`'s `'failed'` case. */
interface FailureReport {
  error: unknown
  source: Accessor<unknown> | null
  retry: () => void
}
```

Replace with:

```ts
/** What a failed binding reported: the error, the node whose parked failure it
 *  threw (if any), and how to re-run it. Mirrors the shape `src/effect.ts`
 *  reports through `BindingState`'s `'failed'` case. */
export interface FailureReport {
  readonly error: unknown
  readonly source: Accessor<unknown> | null
  readonly retry: () => void
}
```

Find:

```ts
/** The failed collection. */
export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
  /** The first failed report's error, or `null` while healthy. Same value a
   *  `<Failed>` with a `fallback` passes as that fallback's first argument. */
  readonly error: Accessor<unknown>
  /** Set from `<Failed>`'s own `for` prop. Undefined means "accepts
   *  everything" — the existing, unconditional behaviour. Read by the
   *  walk (`findNearestFailedScope`) and by `action()`'s candidate
   *  selection, both of which check this BEFORE registering a report,
   *  never inside `register()`/`report()` themselves. */
  readonly for?: (error: unknown) => boolean
  /** Clear the collection and retry every binding in it. */
  reset(): void
}
```

Replace with:

```ts
/** The failed collection. */
export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
  /** The first failed report's error, or `null` while healthy. Same value a
   *  `<Failed>` with a `fallback` passes as that fallback's first argument.
   *  Always `reports()[0]?.error ?? null`. */
  readonly error: Accessor<unknown>
  /** Set from `<Failed>`'s own `for` prop. Undefined means "accepts
   *  everything" — the existing, unconditional behaviour. Read by the
   *  walk (`findNearestFailedScope`) and by `action()`'s candidate
   *  selection, both of which check this BEFORE registering a report,
   *  never inside `register()`/`report()` themselves. */
  readonly for?: (error: unknown) => boolean
  /** Every currently-failed report this scope holds, in registration
   *  order. `useFailed(predicate)`/`Failed.Error` filter this to find a
   *  report that is not necessarily first — `error`/`active` above stay
   *  based on the first entry specifically, unaffected by anything
   *  reading this. */
  readonly reports: Accessor<readonly FailureReport[]>
  /** Clear the collection and retry every binding in it. */
  reset(): void
}
```

- [ ] **Step 4: Restructure `createFailedScope`'s internal collection**

In `src/owner.ts`, find:

```ts
/** One signal holding both fields together, so a change is one atomic write —
 *  not two separate signals for `active`/`error`, which would let a consumer
 *  observe one updated and the other still stale between two writes. */
interface Collection {
  readonly active: boolean
  readonly error: unknown
}
```

Replace with:

```ts
/** One signal holding the whole collection together, so a change is one
 *  atomic write — not separate signals per field, which would let a
 *  consumer observe one updated and another still stale between writes. */
interface Collection {
  readonly reports: readonly FailureReport[]
}
```

Find the full body of `createFailedScope`:

```ts
export function createFailedScope(
  onFailedReport?: (error: unknown) => void,
  filterFor?: (error: unknown) => boolean,
): FailedScope {
  // One entry per currently-failed binding, keyed on its controller — so a
  // binding that re-runs and re-reports stays ONE entry.
  const failedSet = new Map<BindingController, FailureReport>()

  let current: Collection = { active: false, error: null }
  const collectionNode = r3Signal<Collection>(current)

  // Mirrors `makeErrorCell`'s top-level-read behaviour (`src/scope.ts`):
  // inside an r3 context, read through it directly; outside one, stabilize
  // first so the value is never stale.
  const readCollection = (): Collection => {
    if (getContext() !== null) return r3Read(collectionNode)
    stabilize()
    return collectionNode.value
  }

  // Skip a no-op write without an untracked read. Load-bearing: a single
  // rejection re-runs a binding several times and it re-reports 'failed'
  // each time, and consumers must not re-render for reports that change
  // nothing.
  const recompute = (): void => {
    const first: FailureReport | undefined = failedSet.values().next().value
    const next: Collection = {
      active: failedSet.size > 0,
      error: first === undefined ? null : first.error,
    }
    if (next.active === current.active && Object.is(next.error, current.error)) return
    current = next
    r3SetSignal(collectionNode, next)
  }

  const reset = (): void => {
    const reports = Array.from(failedSet.values())
    failedSet.clear()
    recompute()
    for (const report of reports) {
      // Clear the parked failure at its root first — otherwise the binding
      // just re-reads a still-failed node and throws again.
      if (report.source !== null) resetFailure(report.source)
      report.retry()
    }
  }

  return {
    kind: 'failed',
    active: () => readCollection().active,
    error: () => readCollection().error,
    for: filterFor,
    register(): BindingController {
      const controller: BindingController = {
        report(state): void {
          if (state.status === 'failed') {
            failedSet.set(controller, {
              error: state.error,
              source: state.source,
              retry: state.retry,
            })
            onFailedReport?.(state.error)
          } else {
            // Any other status means this binding is no longer failed. In
            // practice only 'idle' is ever sent to a failed-scope controller
            // (see src/effect.ts) — 'throwing'/'ready' go to a pending scope.
            failedSet.delete(controller)
          }
          recompute()
        },
        unregister(): void {
          failedSet.delete(controller)
          recompute()
        },
      }
      return controller
    },
    reset,
  }
}
```

Replace with:

```ts
export function createFailedScope(
  onFailedReport?: (error: unknown) => void,
  filterFor?: (error: unknown) => boolean,
): FailedScope {
  // One entry per currently-failed binding, keyed on its controller — so a
  // binding that re-runs and re-reports stays ONE entry.
  const failedSet = new Map<BindingController, FailureReport>()

  let current: Collection = { reports: [] }
  const collectionNode = r3Signal<Collection>(current)

  // Mirrors `makeErrorCell`'s top-level-read behaviour (`src/scope.ts`):
  // inside an r3 context, read through it directly; outside one, stabilize
  // first so the value is never stale.
  const readCollection = (): Collection => {
    if (getContext() !== null) return r3Read(collectionNode)
    stabilize()
    return collectionNode.value
  }

  const recompute = (): void => {
    current = { reports: Array.from(failedSet.values()) }
    r3SetSignal(collectionNode, current)
  }

  const reset = (): void => {
    const reports = Array.from(failedSet.values())
    failedSet.clear()
    recompute()
    for (const report of reports) {
      // Clear the parked failure at its root first — otherwise the binding
      // just re-reads a still-failed node and throws again.
      if (report.source !== null) resetFailure(report.source)
      report.retry()
    }
  }

  return {
    kind: 'failed',
    error: () => readCollection().reports[0]?.error ?? null,
    active: () => readCollection().reports.length > 0,
    reports: () => readCollection().reports,
    for: filterFor,
    register(): BindingController {
      const controller: BindingController = {
        report(state): void {
          if (state.status === 'failed') {
            onFailedReport?.(state.error)
            // Skip a no-op write without an untracked read. Load-bearing: a
            // single rejection re-runs a binding several times and it
            // re-reports 'failed' each time with the identical error, and
            // consumers must not re-render for reports that change nothing.
            const existing = failedSet.get(controller)
            if (existing !== undefined && Object.is(existing.error, state.error)) return
            failedSet.set(controller, {
              error: state.error,
              source: state.source,
              retry: state.retry,
            })
          } else {
            // Any other status means this binding is no longer failed. In
            // practice only 'idle' is ever sent to a failed-scope controller
            // (see src/effect.ts) — 'throwing'/'ready' go to a pending scope.
            if (!failedSet.has(controller)) return
            failedSet.delete(controller)
          }
          recompute()
        },
        unregister(): void {
          failedSet.delete(controller)
          recompute()
        },
      }
      return controller
    },
    reset,
  }
}
```

`onFailedReport?.(state.error)` deliberately still fires unconditionally, before the new skip check — moving only *when the internal collection updates*, not *whether root logs the report*, is the whole point (see the spec's "Resolved during review" section).

- [ ] **Step 5: Fix every hand-rolled `FailedScope` test fixture**

`FailedScope` gaining a required `reports` property breaks every test that builds one by hand instead of via `createFailedScope`. There are 6 in `test/owner.test.ts` and 5 in `test/async-action.test.ts`, all sharing the identical two-line shape `active: () => false,` / `error: () => null,`. Run this from the repo root:

```bash
python3 - <<'EOF'
import re, pathlib

for path in ["test/owner.test.ts", "test/async-action.test.ts"]:
    p = pathlib.Path(path)
    s = p.read_text()
    pattern = re.compile(r'^([ \t]+)error: \(\) => null,$', re.MULTILINE)
    matches = pattern.findall(s)
    expected = 6 if path.endswith("owner.test.ts") else 5
    assert len(matches) == expected, f"{path}: expected {expected}, found {len(matches)}"
    s = pattern.sub(lambda m: f"{m.group(1)}error: () => null,\n{m.group(1)}reports: () => [],", s)
    p.write_text(s)
    print(f"{path}: patched {len(matches)} occurrences")
EOF
```

This asserts the exact expected count in each file before touching anything, so it fails loudly instead of silently patching the wrong number of fixtures if the file has drifted from what this plan assumed. After running it, confirm with `grep -c "reports: () => \[\]," test/owner.test.ts test/async-action.test.ts` — expect `6` and `5`.

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/owner.test.ts -t "reports\(\)|onFailedReport still fires|still report the first entry"`

Expected: PASS (5 tests)

- [ ] **Step 7: Run the full owner test file, async-action test file, and typecheck**

Run: `pnpm exec vitest run test/owner.test.ts test/async-action.test.ts && pnpm typecheck`

Expected: PASS — every pre-existing test in both files (including the ones this task's Step 5 mechanically edited) continues to pass unmodified in behavior, and typecheck is clean.

- [ ] **Step 8: Sabotage-verify the no-op-report skip**

Temporarily remove the skip check added in Step 4 — in `src/owner.ts`, change:

```ts
          if (state.status === 'failed') {
            onFailedReport?.(state.error)
            // Skip a no-op write without an untracked read. Load-bearing: a
            // single rejection re-runs a binding several times and it
            // re-reports 'failed' each time with the identical error, and
            // consumers must not re-render for reports that change nothing.
            const existing = failedSet.get(controller)
            if (existing !== undefined && Object.is(existing.error, state.error)) return
            failedSet.set(controller, {
```

to:

```ts
          if (state.status === 'failed') {
            onFailedReport?.(state.error)
            // SABOTAGE: skip check removed
            failedSet.set(controller, {
```

Run: `pnpm exec vitest run test/owner.test.ts -t "does not publish a new reports array"`

Expected: FAIL — `second` is a freshly-allocated array every time `recompute()` runs unconditionally, so `expect(second).toBe(first)` fails.

Run: `pnpm exec vitest run test/owner.test.ts`

Expected: every other test in the file still passes — confirm the failure is isolated to exactly the one test targeting this behavior.

Restore the skip check (revert to the Step 4 version), then re-run:

Run: `pnpm exec vitest run test/owner.test.ts test/async-action.test.ts`

Expected: all tests pass again.

- [ ] **Step 9: Commit**

```bash
git add src/owner.ts test/owner.test.ts test/async-action.test.ts
git commit -m "$(cat <<'EOF'
owner: expose a FailedScope's full report set, not only the first

FailedScope's collection only ever surfaced whichever failed report
arrived first, with no way to ask for a different one. Adds reports,
a reactive accessor over every currently-registered failed report in
order, so a caller can search it instead of only ever seeing the
first entry. error/active stay exactly as before, both now simple
derivations of reports()[0].

The no-op-write skip that already existed (a single rejection re-runs
a binding several times, and re-reporting the identical error must
not trigger a redundant collection publish) moves from a comparison
of the whole derived collection to a direct comparison of one
controller's own previous report against its new one, at the point
the report arrives - simpler, and unaffected by which position in the
collection that controller happens to occupy.

FailureReport, previously private to this file, is now exported so
callers can name the shape a reports() entry has.
EOF
)"
```

---

### Task 2: `useFailed(predicate)` and `Failed.Error`'s `for`

**Files:**
- Modify: `src/dom/failed.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `FailedScope.reports`, exported `FailureReport` from Task 1.
- Produces: `FailedState<E>` (generic, was `FailedState`); `useFailed<E = unknown>(predicate?: ((value: unknown) => value is E) | ((value: unknown) => boolean)): FailedState<E>`; `FailedErrorProps<E>` (generic, gains `for`); `Failed.Error<E = unknown>(props: FailedErrorProps<E>): Accessor<unknown>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/dom/failed.test.tsx`, after the last existing test in the file (currently ending with `'a mutation triggered from a reference-keyed row still reaches a filtered <Failed>, even though its own write recreates that row'`):

```tsx
test('useFailed(predicate) finds a match that is not the first-registered report, under one unfiltered boundary', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let rejectA!: (e: Error) => void
  let rejectB!: (e: Error) => void
  const a = computed(() => new Promise<never>((_, reject) => { rejectA = reject }))
  const b = computed(() => new Promise<never>((_, reject) => { rejectB = reject }))
  let filtered!: ReturnType<typeof useFailed<TypeError>>
  let unfiltered!: ReturnType<typeof useFailed>

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
            <p>
              {() => {
                filtered = useFailed((e): e is TypeError => e instanceof TypeError)
                unfiltered = useFailed()
                return 'x'
              }}
            </p>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  flush()

  // a fails first, becoming the boundary's own "first" report.
  rejectA(new RangeError('a-failed'))
  await tick()
  flush()

  // b fails second, with the type the predicate actually wants.
  rejectB(new TypeError('b-failed'))
  await tick()
  flush()

  // The boundary's own, unfiltered error() is a's — it registered first.
  expect(unfiltered.error()).toBeInstanceOf(RangeError)
  // The predicate correctly finds b's, even though it is not first.
  expect(filtered.active()).toBe(true)
  expect(filtered.error()).toBeInstanceOf(TypeError)
  expect((filtered.error() as TypeError).message).toBe('b-failed')
})

test('useFailed(predicate).retry() retries only matching reports, leaving a non-matching one still active', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attemptA = 0
  let attemptB = 0
  const a = computed(() => {
    attemptA++
    return attemptA === 1 ? Promise.reject(new RangeError('a-failed')) : Promise.resolve('a-ok')
  })
  const b = computed(() => {
    attemptB++
    return Promise.reject(new TypeError('b-failed'))
  })
  let filtered!: ReturnType<typeof useFailed<RangeError>>
  let unfiltered!: ReturnType<typeof useFailed>

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
            <p>
              {() => {
                filtered = useFailed((e): e is RangeError => e instanceof RangeError)
                unfiltered = useFailed()
                return 'x'
              }}
            </p>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(filtered.active()).toBe(true)
  expect(attemptA).toBe(1)
  expect(attemptB).toBe(1)

  filtered.retry()
  await tick()
  flush()

  // Only a's RangeError-matching report was retried.
  expect(attemptA).toBe(2)
  // b's TypeError report was never touched.
  expect(attemptB).toBe(1)
  // a recovered, so the predicate no longer finds a match.
  expect(filtered.active()).toBe(false)
  // The boundary as a whole is still active — b's failure is still there.
  expect(unfiltered.active()).toBe(true)
})

test("Failed.Error's for prop narrows what it displays to reports matching it", async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let rejectA!: (e: Error) => void
  let rejectB!: (e: Error) => void
  const a = computed(() => new Promise<never>((_, reject) => { rejectA = reject }))
  const b = computed(() => new Promise<never>((_, reject) => { rejectB = reject }))

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
            <Failed.Error for={(e: unknown): e is TypeError => e instanceof TypeError}>
              {/* error is narrowed to TypeError by the type-guard for prop
                  above — .message reads directly, no cast needed. */}
              {(error) => <p data-testid="type-error-only">{error.message}</p>}
            </Failed.Error>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  flush()
  rejectA(new RangeError('a-failed'))
  await tick()
  flush()

  // Only a (RangeError) has failed so far — the TypeError-only display stays hidden.
  expect(target.querySelector('[data-testid="type-error-only"]')).toBeNull()

  rejectB(new TypeError('b-failed'))
  await tick()
  flush()

  expect(target.querySelector('[data-testid="type-error-only"]')?.textContent).toBe('b-failed')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "useFailed\(predicate\)|Failed.Error's for prop"`

Expected: FAIL — `useFailed` currently takes no arguments (the predicate is silently ignored by JavaScript at runtime, so `filtered`/`unfiltered` end up identical — the "finds a match that is not first" test fails asserting `filtered.error()` is a `RangeError`, not `TypeError`), and `Failed.Error` has no `for` prop yet (also silently ignored at runtime under vitest's non-typechecking transform), so the type-error-only display shows for `a`'s `RangeError` too.

- [ ] **Step 3: Update `FailedState`, `CONST_FAILED_STATE`, and `useFailed`**

In `src/dom/failed.ts`, find:

```ts
export interface FailedState {
  /** True while the nearest boundary's collection is non-empty. */
  readonly active: Accessor<boolean>
  /** The first failed report's error, or `null`. Same value `fallback`
   *  receives as its first argument when a `<Failed>` swaps for it. */
  readonly error: Accessor<unknown>
  /** Retry every failed report the boundary is currently holding — the exact
   *  same operation a `<Failed>`'s own `reset` performs. Exposed under the
   *  name `retry` for symmetry with `ActionHandle.retry()`. */
  retry(): void
}

const CONST_FAILED_STATE: FailedState = {
  active: () => false,
  error: () => null,
  retry: () => {},
}

/**
 * Reads the nearest enclosing `<Failed>` boundary's state — active/error/retry
 * — without swapping anything, the same way `useLoading()` reads a `<Loading>`
 * boundary's pending state. Returns a safe, always-inactive state when no
 * boundary is found (mirrors `useLoading()`'s `CONST_FALSE_ACCESSOR`) — today
 * that includes both "called with no owner at all" and "called under a root
 * with no explicit `<Failed>` anywhere in it".
 *
 * Uses `findBoundaryScope`, not `findNearestFailedScope` — a plain owner walk
 * that does not stop early for a nearer `catchError`, unlike the walk actual
 * failure routing (`effect.ts`, `action()`) uses. This answers "which boundary
 * would swap me out if it went active", not "who intercepts my own failure" —
 * a `catchError` between this call and a `<Failed>` does not hide that
 * `<Failed>`'s state from `useFailed()`, since that boundary still owns
 * whatever DOM this call's descendants sit inside.
 */
export function useFailed(): FailedState {
  const scope = findBoundaryScope(getOwner(), 'failed')
  if (scope === null) return CONST_FAILED_STATE
  return { active: scope.active, error: scope.error, retry: scope.reset }
}
```

Replace with:

```ts
export interface FailedState<E = unknown> {
  /** True while whatever this reads — the whole boundary, or only reports
   *  matching a given predicate — is non-empty. */
  readonly active: Accessor<boolean>
  /** The first matching failed report's error, or `null`. Same value
   *  `fallback` receives as its first argument when a `<Failed>` swaps for
   *  it, when no predicate narrows what "matching" means. */
  readonly error: Accessor<E | null>
  /** Retry every matching failed report — the same per-report operation a
   *  `<Failed>`'s own `reset` performs, but only over the reports this
   *  state actually reflects. Exposed under the name `retry` for symmetry
   *  with `ActionHandle.retry()`. */
  retry(): void
}

const CONST_FAILED_STATE: FailedState<unknown> = {
  active: () => false,
  error: () => null,
  retry: () => {},
}

/**
 * Reads the nearest enclosing `<Failed>` boundary's state — active/error/retry
 * — without swapping anything, the same way `useLoading()` reads a `<Loading>`
 * boundary's pending state. Returns a safe, always-inactive state when no
 * boundary is found (mirrors `useLoading()`'s `CONST_FALSE_ACCESSOR`) — today
 * that includes both "called with no owner at all" and "called under a root
 * with no explicit `<Failed>` anywhere in it".
 *
 * Uses `findBoundaryScope`, not `findNearestFailedScope` — a plain owner walk
 * that does not stop early for a nearer `catchError`, unlike the walk actual
 * failure routing (`effect.ts`, `action()`) uses. This answers "which boundary
 * would swap me out if it went active", not "who intercepts my own failure" —
 * a `catchError` between this call and a `<Failed>` does not hide that
 * `<Failed>`'s state from `useFailed()`, since that boundary still owns
 * whatever DOM this call's descendants sit inside.
 *
 * `predicate`, if given, narrows what `active`/`error` mean and what
 * `retry()` re-runs to only the boundary's reports matching it, instead of
 * its first report and its whole collection — for when one boundary
 * legitimately holds more than one kind of failure at once and a specific
 * reader only cares about one of them. It does not change WHICH boundary is
 * found — that stays purely positional, the same walk as with no predicate
 * at all. Written as a type guard, `error()` narrows to `E`, the same
 * convenience `<Failed>`'s own `for` gives its `fallback`.
 */
export function useFailed<E = unknown>(
  predicate?: ((value: unknown) => value is E) | ((value: unknown) => boolean),
): FailedState<E> {
  const scope = findBoundaryScope(getOwner(), 'failed')
  if (scope === null) return CONST_FAILED_STATE as FailedState<E>
  const matching = (): readonly FailureReport[] =>
    predicate === undefined ? scope.reports() : scope.reports().filter((r) => predicate(r.error))
  return {
    active: () => matching().length > 0,
    error: () => (matching()[0]?.error as E | undefined) ?? null,
    retry: () => {
      for (const report of matching()) {
        if (report.source !== null) resetFailure(report.source)
        report.retry()
      }
    },
  }
}
```

- [ ] **Step 4: Update the import line**

Find:

```ts
import { untrack } from 'r3'
import {
  createFailedScope,
  createSubOwner,
  disposeOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Accessor } from '../signal'
```

Replace with:

```ts
import { untrack } from 'r3'
import {
  createFailedScope,
  createSubOwner,
  disposeOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type FailureReport,
  type Owner,
} from '../owner'
import { resetFailure } from '../failure'
import type { Accessor } from '../signal'
```

- [ ] **Step 5: Update `FailedErrorProps` and `Failed.Error`**

Find:

```ts
export interface FailedErrorProps {
  /** Called once per active-transition (branch-cached, the same way `Show`'s
   *  children are — see `src/dom/show.ts`) — not re-invoked on every change
   *  to the boundary's collection. If the underlying error changes while the
   *  boundary stays active (a second failure supersedes the first while this
   *  is still showing), reflecting that needs its own nested reactive read
   *  inside the render prop's body (e.g. call `useFailed()` again there),
   *  the same way `Show`'s own docs recommend for a value that changes
   *  without a truthy/falsy transition. */
  children: (error: unknown, retry: () => void) => unknown
}
```

Replace with:

```ts
export interface FailedErrorProps<E = unknown> {
  /** Optional. When given, narrows which reports the boundary's state
   *  reflects — same predicate shape and same narrowing behaviour as
   *  `<Failed>`'s own `for`, passed straight through to `useFailed`. */
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
  /** Called once per active-transition (branch-cached, the same way `Show`'s
   *  children are — see `src/dom/show.ts`) — not re-invoked on every change
   *  to the boundary's collection. If the underlying error changes while the
   *  boundary stays active (a second failure supersedes the first while this
   *  is still showing), reflecting that needs its own nested reactive read
   *  inside the render prop's body (e.g. call `useFailed(props.for)` again
   *  there), the same way `Show`'s own docs recommend for a value that
   *  changes without a truthy/falsy transition. */
  children: (error: E, retry: () => void) => unknown
}
```

Find:

```ts
export namespace Failed {
  export function Error(props: FailedErrorProps): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useFailed()
```

Replace with:

```ts
export namespace Failed {
  export function Error<E = unknown>(props: FailedErrorProps<E>): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useFailed(props.for)
```

(the rest of `Failed.Error`'s body — the branch-owner caching, the `untrack`/`runWithOwner` call — is unchanged)

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "useFailed\(predicate\)|Failed.Error's for prop"`

Expected: PASS (3 tests)

- [ ] **Step 7: Run the full `test/dom/failed.test.tsx` file and typecheck**

Run: `pnpm exec vitest run test/dom/failed.test.tsx && pnpm typecheck`

Expected: PASS — every pre-existing test in the file (all `useFailed()`/`Failed.Error` call sites with no predicate/`for`) continues to pass with zero changes to those tests, and typecheck is clean.

- [ ] **Step 8: Sabotage-verify the predicate filtering**

Temporarily make `matching()` ignore the predicate — in `src/dom/failed.ts`, change:

```ts
  const matching = (): readonly FailureReport[] =>
    predicate === undefined ? scope.reports() : scope.reports().filter((r) => predicate(r.error))
```

to:

```ts
  // SABOTAGE: predicate ignored
  const matching = (): readonly FailureReport[] => scope.reports()
```

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "useFailed\(predicate\) finds a match"`

Expected: FAIL — `filtered.error()` now reports `a`'s `RangeError` (the unfiltered first entry) instead of `b`'s `TypeError`.

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: all three of this task's new tests fail — the two that call `useFailed` with an explicit predicate, and `Failed.Error`'s narrowing test, since `Failed.Error` calls `useFailed(props.for)` internally and shares this exact `matching()` logic. Every pre-existing test passes unaffected: none of them pass a predicate, and `matching()` already returns `scope.reports()` unfiltered when `predicate` is `undefined`, in both the sabotaged and the real version — confirm the failure is isolated to exactly these three tests, not a wider regression.

Restore the filtering (revert to the Step 3 version), then re-run:

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: all tests pass again.

- [ ] **Step 9: Commit**

```bash
git add src/dom/failed.ts test/dom/failed.test.tsx
git commit -m "$(cat <<'EOF'
dom/failed: let useFailed() and Failed.Error take an optional predicate

useFailed() and Failed.Error always read whichever <Failed> boundary
is nearest by position, but had no way to ask for a specific kind of
error out of it - they reported the boundary's first currently-failed
report, whatever it happened to be. Both now accept an optional
predicate, narrowing active()/error()/retry() to only the reports
matching it, so a reader can pick out one kind of failure from a
boundary that legitimately holds more than one at once.

Which boundary a call finds is unchanged - still the same purely
positional walk as before, with no predicate involved in that part at
all. retry() re-running only the matching reports, not the boundary's
whole collection, is a deliberate departure from <Failed>'s own
reset(), which always clears everything - a retry control shown next
to a filtered display should not silently also retry an unrelated
failure the same boundary happens to also hold.

Every existing call site, with no predicate/for given, keeps its
exact current behaviour - first report, whole-collection retry -
unaffected.
EOF
)"
```

---

### Task 3: Final verification pass

**Files:** none (verification only)

**Interfaces:** none — this task confirms Tasks 1-2 together, it does not add behavior.

- [ ] **Step 1: Run the complete repo test suite**

Run: `pnpm test`

Expected: every test file passes. This plan adds 5 new tests in Task 1 (`test/owner.test.ts`) and 3 new tests in Task 2 (`test/dom/failed.test.tsx`) — 8 new passing tests, 0 removed, on top of whatever baseline existed before this plan's Task 1 began.

- [ ] **Step 2: Run the repo typecheck**

Run: `pnpm typecheck`

Expected: PASS, no errors anywhere.

- [ ] **Step 3: Confirm no stray sabotage artifacts remain**

Run: `git status --short`

Expected: clean. Task 1's Step 8 and Task 2's Step 8 each explicitly restore the pre-sabotage version and re-run before that task's own commit step, so nothing should be outstanding here.

- [ ] **Step 4: Commit any final cleanup**

If Step 3 found nothing, there is nothing to commit — this step only applies if some stray change was found and needed restoring.

# Composable Boundary State (`useFailed()` / `Failed.Error` / `<Loading>` symmetry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `<Failed>` and `<Loading>` show their state without unmounting their content — a `useFailed()` hook (mirroring the existing `useLoading()`), a `Failed.Error` compound-sugar component built on it, an implicit root `FailedScope` so that hook always has real state to read, and the equivalent context-only fallback for `<Loading>`.

**Architecture:** Extract `<Failed>`'s collection/report/reset bookkeeping into a shared `createFailedScope()` helper in `src/owner.ts`, built on raw r3 primitives (not pulse's `signal()` wrapper) to avoid a circular import. `<Failed>` itself becomes a thin wrapper around that helper with an optional `fallback`; `createRoot()` installs a second instance of the same helper as every root's default boundary. `useFailed()` and `Failed.Error` are additive, built on the existing owner-tree walk (`findBoundaryScope`). `<Loading>`'s change is a single new branch in its existing render function — no new primitive needed, since `useLoading()` already exists.

**Tech Stack:** TypeScript, r3 (the underlying reactive core), vitest (`|unit|` project for `.test.ts`, `|dom (chromium)|` project for `.test.tsx`), Playwright (for `examples/todo-async`, unaffected by this plan but re-verified at the end).

**Spec:** `docs/superpowers/specs/2026-08-19-failed-boundary-composition-design.md`

## Global Constraints

- `fallback` stays optional on both `<Failed>` and `<Loading>` — every existing call site (`test/dom/failed.test.tsx`'s 14 tests, all 38 tests across `test/dom/loading*.test.tsx`'s 4 files, `examples/todo-async`'s boundary) must need zero changes and keep passing unmodified.
- The only distinction that matters for "was a prop provided" is `=== undefined` (strict), never truthiness — `fallback={null}`, `fallback={''}`, `fallback={false}` all count as "provided, swap to this."
- `Failed.Error`'s render prop must get real owner-scoped disposal (its own sub-owner, disposed on each active/inactive transition) — a bare conditional return would leak whatever the render prop constructs.
- The root boundary's `console.error` fires unconditionally on every `'failed'` report it receives, regardless of whether anything reads `useFailed()` from it — matching `routeErrorFromRerun`'s existing "always log" behavior. An explicit, app-provided `<Failed>` never logs automatically (matches its behavior today).
- No changes to `src/effect.ts` — it already calls `findNearestFailedScope`, and that alone is sufficient once `createRoot()` always installs a default scope.
- `owner.ts` must not import `src/signal.ts` or pulse's `signal()` wrapper at runtime (cycle: `signal.ts` → `scope.ts` → `owner.ts`). Any new reactive state built inside `owner.ts` uses raw r3 primitives directly (`signal`/`read`/`setSignal`/`stabilize`/`getContext` from `'r3'`), the same way `src/scope.ts`'s existing `makeErrorCell()` does.
- Any reactive cell holding more than one related value together (e.g. `{active, error}`) must be ONE signal written with ONE `setSignal` call per change — never two separate signals for values that must be read consistently together. This is why `<Failed>`'s original implementation used a single `collection` signal instead of two; the same constraint applies to the raw-r3 version built here.

---

### Task 1: Extract `createFailedScope()`, add `FailedScope.error`, make `<Failed>`'s `fallback` optional

**Files:**
- Modify: `src/owner.ts`
- Modify: `src/dom/failed.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Produces: `export function createFailedScope(onFailedReport?: (error: unknown) => void): FailedScope` from `src/owner.ts`. `FailedScope` gains `readonly error: Accessor<unknown>` alongside its existing `active`/`register`/`reset`.
- Produces: `FailedProps.fallback` becomes `fallback?: (error: unknown, reset: () => void) => unknown` (was required).
- Consumes: nothing new from other tasks (this is the foundation task).

- [ ] **Step 1: Write the failing test — `<Failed>` without a `fallback` keeps its children mounted through a failure**

Add to `test/dom/failed.test.tsx`, after the last existing test in the file (currently ending with the `'an action that fails after its <Failed> boundary itself unmounted...'` test):

```tsx
test('<Failed> without a fallback keeps its children mounted through a failure', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <span data-testid="content">static</span>
            <p>{() => use(c)}</p>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  const before = target.querySelector('[data-testid="content"]')
  expect(before).not.toBeNull()

  await tick()
  flush()

  // Something inside failed, but <Failed> has no fallback to swap to — the
  // exact same node is still there, not torn down and rebuilt.
  expect(target.querySelector('[data-testid="content"]')).toBe(before)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "keeps its children mounted"`

Expected: FAIL. `vitest` transpiles with esbuild and does not type-check (no `typecheck` block in `vitest.config.ts`), so the test does run despite `fallback` being typed as required — but the CURRENT `Failed()` render function has no branch for a missing `fallback`: once `c` rejects and the boundary goes active, it calls `props.fallback(error, reset)`, and `props.fallback` is `undefined` at runtime, so this throws `TypeError: props.fallback is not a function`, failing the test. `pnpm typecheck` would also fail separately on this test file once it exists, until Step 6 below makes `fallback` optional — that's expected too, and resolves once Step 6 lands.

- [ ] **Step 3: Add `resetFailure` and raw-r3 imports to `src/owner.ts`**

At the top of `src/owner.ts`, replace:

```ts
import { getContext, type Disposable, onCleanup as r3OnCleanup } from 'r3'
import type { Accessor } from './signal'
import { currentGeneratorCleanups } from './generator-cleanup'
```

with:

```ts
import {
  getContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  type Disposable,
  onCleanup as r3OnCleanup,
} from 'r3'
import type { Accessor } from './signal'
import { currentGeneratorCleanups } from './generator-cleanup'
import { resetFailure } from './failure'
```

`src/failure.ts` has no runtime dependency on `signal.ts`/`scope.ts` (only a type-only `Accessor` import), so this does not introduce a cycle.

- [ ] **Step 4: Add the `error` field to `FailedScope` in `src/owner.ts`**

Find:

```ts
/** The failed collection. */
export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
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
   *  `<Failed>` with a `fallback` passes as that fallback's first argument. */
  readonly error: Accessor<unknown>
  /** Clear the collection and retry every binding in it. */
  reset(): void
}
```

- [ ] **Step 5: Add `createFailedScope()` to `src/owner.ts`**

Add this new function immediately before `createRoot` (i.e. right before the `/** * Create a fresh root owner...` doc comment):

```ts
/** What a failed binding reported: the error, the node whose parked failure it
 *  threw (if any), and how to re-run it. Mirrors the shape `src/effect.ts`
 *  reports through `BindingState`'s `'failed'` case. */
interface FailureReport {
  error: unknown
  source: Accessor<unknown> | null
  retry: () => void
}

/** One signal holding both fields together, so a change is one atomic write —
 *  not two separate signals for `active`/`error`, which would let a consumer
 *  observe one updated and the other still stale between two writes. */
interface Collection {
  readonly active: boolean
  readonly error: unknown
}

/**
 * Build a `FailedScope`: the collection/report/reset logic shared by every
 * `<Failed>` boundary and by the default boundary `createRoot()` installs on
 * every root (below).
 *
 * Built directly on raw r3 primitives, not pulse's `signal()` wrapper —
 * `src/signal.ts` imports from `src/scope.ts`, which already imports from
 * this file (`findNearestFailedScope`/`getOwner`/`onCleanup`), so importing
 * `signal()` back here would cycle. `src/scope.ts`'s own `makeErrorCell()`
 * solves the identical problem the same way.
 *
 * `onFailedReport`, if given, runs once for every `'failed'` report this
 * scope receives, regardless of whether anything is reading its `active`/
 * `error` — used by `createRoot()`'s default scope to `console.error` every
 * failure, matching `routeErrorFromRerun`'s existing "always log" behaviour.
 * An explicit `<Failed>` passes nothing, matching its existing silent
 * behaviour (the app is assumed to be handling it via `fallback`/`useFailed()`).
 */
export function createFailedScope(onFailedReport?: (error: unknown) => void): FailedScope {
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

- [ ] **Step 6: Rewrite `src/dom/failed.ts` to use the shared helper, with `fallback` optional**

Replace the entire file with:

```ts
import {
  createFailedScope,
  createSubOwner,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Accessor } from '../signal'

export interface FailedProps {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Optional. When provided, behaves as a full-subtree swap: replace the
   *  whole subtree with `fallback(error, reset)` while the boundary is
   *  active. When omitted, `<Failed>` is pure scoping — children stay
   *  mounted always, and `useFailed()` (or `Failed.Error`) is how a
   *  descendant shows the failure without unmounting anything. */
  fallback?: (error: unknown, reset: () => void) => unknown
}

/**
 * Failure boundary. Bindings beneath it that throw a real error report themselves
 * here; the boundary collects them.
 *
 * With a `fallback`, it behaves the way it always has: a SELECTION over live
 * graph state, not a latch. A React-style error boundary remembers that an
 * error happened and shows its fallback until something resets it. This one
 * shows the fallback exactly while something under it is currently failed —
 * so when a failure clears on its own (an upstream dependency changes and the
 * stage re-runs successfully), the binding reports `idle`, the collection
 * empties, and the subtree returns with no `reset()` call.
 *
 * Without a `fallback`, the children are always returned — nothing ever
 * swaps. `useFailed()`/`Failed.Error` are how a descendant reads the same
 * collection state without unmounting anything.
 *
 * Suspension is NOT a failure: `NotReadyYet` is handled by `<Loading>` and never
 * reaches here.
 */
export function Failed(props: FailedProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)
  const scope = createFailedScope()
  boundaryOwner.boundaries.failed = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    if (props.fallback === undefined) return subtree
    if (!scope.active()) return subtree
    return props.fallback(scope.error(), scope.reset)
  }
}
```

- [ ] **Step 7: Run the new test to verify it passes**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "keeps its children mounted"`

Expected: PASS

- [ ] **Step 8: Run the full `test/dom/failed.test.tsx` file to confirm zero regressions**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: PASS — all 14 pre-existing tests plus the 1 new one (15 total), with no changes to any of the pre-existing tests' source.

- [ ] **Step 9: Run the repo typecheck**

Run: `pnpm typecheck`

Expected: PASS (no errors — `FailedProps.fallback` is now optional, and no call site in `src/`/`test/`/`examples/` relies on it being required).

- [ ] **Step 10: Commit**

```bash
git add src/owner.ts src/dom/failed.ts test/dom/failed.test.tsx
git commit -m "$(cat <<'EOF'
refactor: extract Failed's collection logic so its fallback can be optional

Moves the report/reset bookkeeping <Failed> already had into a shared
createFailedScope() helper in src/owner.ts, built on raw r3 primitives
instead of pulse's own signal() wrapper to avoid a circular import back
through src/scope.ts. <Failed> itself becomes a thin wrapper around that
helper, and its fallback prop becomes optional: when given, the boundary
still swaps its whole subtree exactly as before; when omitted, the
children stay mounted through a failure instead of being replaced with
nothing to show for it.

This is purely additive for every existing caller, since every current
usage of <Failed> already passes a fallback.
EOF
)"
```

---

### Task 2: `useFailed()` hook

**Files:**
- Modify: `src/dom/failed.ts`
- Modify: `src/dom/index.ts`
- Modify: `src/index.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `createFailedScope`'s `FailedScope` (with `error`) from Task 1; `findBoundaryScope`, `getOwner` from `src/owner.ts` (pre-existing, used identically to `useLoading()`).
- Produces: `export interface FailedState { readonly active: Accessor<boolean>; readonly error: Accessor<unknown>; retry(): void }` and `export function useFailed(): FailedState`, both exported from `src/dom/failed.ts` → `src/dom/index.ts` → `src/index.ts`. Task 3 (`Failed.Error`) consumes `useFailed()` directly.

- [ ] **Step 1: Write the failing tests**

Add to `test/dom/failed.test.tsx`, after the test added in Task 1:

```tsx
test('useFailed() reflects the nearest boundary reactively, with nothing swapped', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  let state!: ReturnType<typeof useFailed>

  render(
    () => (
      <Failed>
        {() => {
          state = useFailed()
          return <p>{() => use(c)}</p>
        }}
      </Failed>
    ),
    target,
  )

  expect(state.active()).toBe(false)

  await tick()
  flush()

  expect(state.active()).toBe(true)
  expect((state.error() as Error).message).toBe('boom')
})

test('useFailed().retry retries every failed report, the same operation reset() performs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })
  let state!: ReturnType<typeof useFailed>

  render(
    () => (
      <Failed>
        {() => {
          state = useFailed()
          return <p>{() => use(c)}</p>
        }}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(state.active()).toBe(true)

  state.retry()
  await tick()
  flush()

  expect(state.active()).toBe(false)
  expect(attempt).toBe(2)
})

test('useFailed() called with no owner at all returns a safe, always-inactive state', () => {
  const state = useFailed()
  expect(state.active()).toBe(false)
  expect(state.error()).toBeNull()
  expect(() => state.retry()).not.toThrow()
})
```

Add `useFailed` to the file's existing import block from `'../../src/index'` (alphabetical, matching the file's existing ordering):

```ts
import {
  action,
  catchError,
  committed,
  computed,
  effect,
  Failed,
  flush,
  For,
  Loading,
  microtaskScheduler,
  onCleanup,
  optimistic,
  read,
  render,
  setScheduler,
  Show,
  signal,
  syncScheduler,
  use,
  useFailed,
} from '../../src/index'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "useFailed"`

Expected: FAIL — `useFailed` is not exported from `src/index.ts` yet, so the import itself fails to resolve (vitest reports a module-resolution error naming the missing export before any test in the file runs).

- [ ] **Step 3: Add `FailedState`, `useFailed()`, and their `CONST_FAILED_STATE` fallback to `src/dom/failed.ts`**

Replace the `from '../owner'` import block at the top of `src/dom/failed.ts` (added in Task 1) with:

```ts
import {
  createFailedScope,
  createSubOwner,
  findBoundaryScope,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
```

(adds `findBoundaryScope` to the list from Task 1.)

Add this, after the `FailedProps` interface and before the `Failed` doc comment:

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
 * boundary's pending state. Returns a safe, always-inactive state when called
 * outside any owner at all (mirrors `useLoading()`'s `CONST_FALSE_ACCESSOR`).
 * Every root created via `createRoot()` always has a real boundary to find —
 * see `createFailedScope()`'s installation there.
 */
export function useFailed(): FailedState {
  const scope = findBoundaryScope(getOwner(), 'failed')
  if (scope === null) return CONST_FAILED_STATE
  return { active: scope.active, error: scope.error, retry: scope.reset }
}
```

- [ ] **Step 4: Export `useFailed`/`FailedState` from `src/dom/index.ts`**

Find:

```ts
export { Failed } from './failed'
```

Replace with:

```ts
export { Failed, useFailed, type FailedState } from './failed'
```

- [ ] **Step 5: Export from `src/index.ts`**

Find:

```ts
export { Failed, For, Fragment, h, Loading, Match, render, Show, Switch, useLoading, type Truthy } from './dom'
```

Replace with:

```ts
export { Failed, For, Fragment, h, Loading, Match, render, Show, Switch, useFailed, useLoading, type FailedState, type Truthy } from './dom'
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "useFailed"`

Expected: PASS (3 tests)

- [ ] **Step 7: Run the full file and typecheck**

Run: `pnpm exec vitest run test/dom/failed.test.tsx && pnpm typecheck`

Expected: PASS — 18 tests total in the file (14 pre-existing + 1 from Task 1 + 3 from this task), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/dom/failed.ts src/dom/index.ts src/index.ts test/dom/failed.test.tsx
git commit -m "$(cat <<'EOF'
feat: add useFailed(), a read-only hook for the nearest Failed boundary

Mirrors the existing useLoading() hook exactly: called from anywhere
under a <Failed>, it returns the boundary's live active/error state and
a retry() that re-runs every failed report currently held — the same
operation a <Failed>'s own fallback retry button already performs — with
no swap of any kind involved. Falls back to a safe, always-inactive
state when called with no owner at all, the same way useLoading() does.
EOF
)"
```

---

### Task 3: `Failed.Error` compound sugar

**Files:**
- Modify: `src/dom/failed.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `useFailed()`/`FailedState` from Task 2.
- Produces: `Failed.Error`, a static property on the exported `Failed` function, taking `{ children: (error: unknown, retry: () => void) => unknown }`.

- [ ] **Step 1: Write the failing tests**

Add to `test/dom/failed.test.tsx`, after the tests added in Task 2:

```tsx
test('Failed.Error renders nothing while the boundary is healthy, and the error UI once it fails', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <Failed.Error>
              {(error) => <p data-testid="error-ui">{(error as Error).message}</p>}
            </Failed.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()

  await tick()
  flush()

  expect(target.querySelector('[data-testid="error-ui"]')?.textContent).toBe('boom')
})

test('Failed.Error disposes what its render prop constructed when the failure clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )
  let disposals = 0

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <Failed.Error>
              {() => {
                onCleanup(() => {
                  disposals++
                })
                return <p data-testid="error-ui">failed</p>
              }}
            </Failed.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.querySelector('[data-testid="error-ui"]')).not.toBeNull()
  expect(disposals).toBe(0)

  setId(2)
  await tick()
  flush()

  // The failure cleared — Failed.Error's own content must be GONE, and its
  // onCleanup must actually have fired, not just have been hidden while
  // still alive underneath.
  expect(target.querySelector('[data-testid="error-ui"]')).toBeNull()
  expect(disposals).toBe(1)
})

test('Failed.Error\'s retry() clears the failure, the same as useFailed().retry()', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })

  render(
    () => (
      <Failed>
        {() => (
          <div>
            <Failed.Error>
              {(_error, retry) => (
                <button data-testid="retry" on:click={retry}>
                  retry
                </button>
              )}
            </Failed.Error>
            <span>{() => use(c)}</span>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  const button = target.querySelector('[data-testid="retry"]') as HTMLButtonElement
  expect(button).not.toBeNull()

  button.click()
  await tick()
  flush()

  expect(target.querySelector('[data-testid="retry"]')).toBeNull()
  expect(attempt).toBe(2)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "Failed.Error"`

Expected: FAIL — `Failed.Error` does not exist yet (`Failed.Error is not a function` / TypeScript error on the JSX tag).

- [ ] **Step 3: Add `Failed.Error` to `src/dom/failed.ts`**

Add a new `import { untrack } from 'r3'` line above the existing imports, and replace the `from '../owner'` import block (last touched in Task 2) with a version that adds `disposeOwner`, so the top of the file reads:

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

(adds `disposeOwner` to the existing import list from `../owner`.)

Add this after the `Failed` function's closing brace, at the end of the file:

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

/**
 * Compound sugar for showing the nearest `<Failed>` boundary's error inline,
 * anywhere, with no unmounting of anything around it — built entirely on
 * `useFailed()`, nothing more.
 *
 * Gets its own sub-owner, disposed on each active/inactive transition — the
 * same pattern `Show` uses internally — so that whatever the render prop
 * constructs (its own effects, its own owner-sensitive registrations) is
 * torn down cleanly when the failure clears, not merely removed from the DOM
 * while still alive underneath.
 *
 * Declared via `namespace Failed { ... }` merged with the `function Failed`
 * declaration above — the standard TypeScript pattern for attaching a typed
 * static property to a function. A plain `Failed.Error = ...` assignment
 * after the fact does not typecheck: `Failed`'s inferred type has no `Error`
 * property unless it's declared this way.
 */
export namespace Failed {
  export function Error(props: FailedErrorProps): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useFailed()
    let branchOwner: Owner | null = null
    let lastActive: boolean | null = null
    let cached: unknown

    return () => {
      const isActive = active()
      if (isActive === lastActive) return cached

      if (branchOwner !== null) disposeOwner(branchOwner)
      branchOwner = createSubOwner(parentOwner)
      // untrack: the render prop may call onCleanup or create effects.
      // Without untrack, those would route to the calling binding-effect's
      // r3 per-run cleanup instead of branchOwner, disposing them on the
      // very next re-run — same pattern as Show/mapArray.
      cached = isActive
        ? untrack(() => runWithOwner(branchOwner!, () => props.children(error(), retry)))
        : null
      lastActive = isActive
      return cached
    }
  }
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "Failed.Error"`

Expected: PASS (3 tests)

- [ ] **Step 5: Sabotage-verify the disposal test**

Temporarily break the disposal by replacing the `Failed.Error` body's branch-transition block so it never disposes the previous `branchOwner`:

```ts
  return () => {
    const isActive = active()
    if (isActive === lastActive) return cached

    // SABOTAGE: disposal intentionally removed
    branchOwner = createSubOwner(parentOwner)
    cached = isActive
      ? untrack(() => runWithOwner(branchOwner!, () => props.children(error(), retry)))
      : null
    lastActive = isActive
    return cached
  }
```

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: exactly one failure — `'Failed.Error disposes what its render prop constructed when the failure clears'` (asserting `disposals === 1`, which stays `0` once the sabotage is in place) — and all 20 other tests in the file still pass.

Restore the file to the Step 3 version (`disposeOwner(branchOwner)` back in place) and re-run:

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: all 21 tests pass again.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/dom/failed.ts test/dom/failed.test.tsx
git commit -m "$(cat <<'EOF'
feat: add Failed.Error, a compound component for inline failure UI

Built directly on useFailed(), with its own sub-owner disposed on each
active/inactive transition (the same pattern Show uses internally), so
whatever a render prop constructs while showing an error is torn down
cleanly when the failure clears rather than staying alive, hidden,
underneath the content that replaces it.
EOF
)"
```

---

### Task 4: Implicit root boundary — `createRoot()` installs a default `FailedScope`

**Files:**
- Modify: `src/owner.ts`
- Test: `test/owner.test.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `createFailedScope()` from Task 1.
- Produces: every owner returned by `createRoot()` has `owner.boundaries.failed !== null` by default (shadowed by any explicit `<Failed>` nested inside, exactly as `findNearestFailedScope`'s existing nearest-match walk already handles).

- [ ] **Step 1: Write the failing owner-level tests**

Add to `test/owner.test.ts`. First, extend the file's existing import line:

```ts
import { afterEach, expect, test, vi } from 'vitest'
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
import { flush, microtaskScheduler, setScheduler } from '../src/scheduler'
```

(adds `vi`, `createSubOwner`, `findNearestFailedScope`, `type FailedScope` to the existing imports.)

Then add these tests, anywhere after the existing `'Owner.boundaries.pending defaults to null'` test:

```ts
test('createRoot installs a default FailedScope on the root owner', () => {
  createRoot(() => {
    const owner = getOwner()!
    expect(owner.boundaries.failed).not.toBeNull()
  })
})

test('the default FailedScope tracks active/error like any other FailedScope', () => {
  createRoot(() => {
    const found = findNearestFailedScope(getOwner())!
    expect(found.scope.active()).toBe(false)
    expect(found.scope.error()).toBeNull()

    const error = new Error('x')
    const controller = found.scope.register()
    controller.report({ status: 'failed', error, source: null, retry: () => {} })
    expect(found.scope.active()).toBe(true)
    expect(found.scope.error()).toBe(error)

    controller.report({ status: 'idle' })
    expect(found.scope.active()).toBe(false)
    expect(found.scope.error()).toBeNull()
  })
})

test('the default FailedScope logs every failed report to console.error', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = new Error('boom')
  createRoot(() => {
    const found = findNearestFailedScope(getOwner())!
    const controller = found.scope.register()
    controller.report({ status: 'failed', error, source: null, retry: () => {} })
  })
  expect(spy).toHaveBeenCalledWith(error)
  spy.mockRestore()
})

test('an explicit FailedScope nested inside createRoot still wins over the root default', () => {
  createRoot(() => {
    const rootFound = findNearestFailedScope(getOwner())!
    const sub = createSubOwner(getOwner())
    const nestedScope: FailedScope = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
    }
    sub.boundaries.failed = nestedScope
    const found = runWithOwner(sub, () => findNearestFailedScope(getOwner()))!
    expect(found.scope).toBe(nestedScope)
    expect(found.scope).not.toBe(rootFound.scope)
  })
})
```

(Use this second version — the first was written to show the mistake and correct it in place, per this plan's own "no placeholders" rule; only the corrected version should end up in the file.)

- [ ] **Step 2: Write the failing DOM-level test proving `effect.ts` needs no changes**

Add to `test/dom/failed.test.tsx`, after the tests from Task 3. Add `vi` to the file's `from 'vitest'` import line:

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
```

Then add:

```tsx
test('a computed failure with no explicit <Failed> anywhere still registers with the implicit root boundary, and still logs', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  render(() => <span>{() => use(c)}</span>, target)

  await tick()
  flush()

  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  spy.mockRestore()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/owner.test.ts test/dom/failed.test.tsx -t "default FailedScope|root boundary|explicit FailedScope|still logs"`

Expected: FAIL — `owner.boundaries.failed` is `null` by default today, `findNearestFailedScope(getOwner())` returns `null` inside a bare `createRoot()` with nothing else, and the DOM-level test currently hits `routeErrorFromRerun`'s plain `console.error(unhandled)` — which happens to already call `console.error`, so that specific assertion might coincidentally pass today; the owner-level tests are the ones that reliably fail, since they depend on `owner.boundaries.failed` being pre-populated.

- [ ] **Step 4: Wire `createFailedScope()` into `createRoot()`**

In `src/owner.ts`, find:

```ts
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner = newOwner()
  const dispose = () => disposeOwner(owner)
  return runWithOwner(owner, () => fn(dispose))
}
```

Replace with:

```ts
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner = newOwner()
  // Every root gets a default FailedScope, so findNearestFailedScope/
  // findBoundaryScope('failed') always finds something once it reaches the
  // root — an explicit <Failed> anywhere between the failing binding and the
  // root still wins (nearest match), and a nearer catchError still wins over
  // any FailedScope, explicit or implicit, exactly as before. This is what
  // lets useFailed() always return real state, and what lets action() (see
  // src/scope.ts) and a failed computed/signal binding (see src/effect.ts)
  // register with something instead of throwing/logging with nowhere for the
  // failure to be queried from — console.error keeps it exactly as visible
  // by default as routeErrorFromRerun already made it.
  owner.boundaries.failed = createFailedScope((error) => console.error(error))
  const dispose = () => disposeOwner(owner)
  return runWithOwner(owner, () => fn(dispose))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/owner.test.ts test/dom/failed.test.tsx`

Expected: PASS — `test/owner.test.ts` grows from its prior count to +4 tests; `test/dom/failed.test.tsx` grows to 22 tests total, all passing.

- [ ] **Step 6: Run the three tests the spec identified as being at risk, to confirm they are unaffected**

Run: `pnpm exec vitest run test/effect.test.ts test/integration-error-boundary.test.ts -t "real error|effect failed|uncaught"`

Expected: PASS — these three tests call `effect()` with no `createRoot()` at all, so `getOwner()` is `null` and `findNearestFailedScope(null)` returns `null` regardless of this change; `routeError`'s synchronous-throw fallback still applies unchanged.

- [ ] **Step 7: Sabotage-verify the console.error-always-fires behavior**

Temporarily make the root scope's logging conditional on nothing being registered yet (i.e. break the "unconditional" guarantee) by changing the `createRoot` wiring to pass no callback:

```ts
  owner.boundaries.failed = createFailedScope() // SABOTAGE: no onFailedReport
```

Run: `pnpm exec vitest run test/owner.test.ts test/dom/failed.test.tsx`

Expected: exactly two failures — `'the default FailedScope logs every failed report to console.error'` (in `test/owner.test.ts`) and `'a computed failure with no explicit <Failed> anywhere still registers with the implicit root boundary, and still logs'` (in `test/dom/failed.test.tsx`) — every other test in both files still passes.

Restore the Step 4 version and re-run:

Run: `pnpm exec vitest run test/owner.test.ts test/dom/failed.test.tsx`

Expected: all tests pass again.

- [ ] **Step 8: Run the full repo test suite and typecheck**

Run: `pnpm test && pnpm typecheck`

Expected: all test files pass, typecheck clean. Pay particular attention to any test elsewhere in the suite that calls `createRoot()`/`render()` and separately asserts something about console output or about an uncaught/unboundaried failure — none were found during the spec's own research (`grep -rn "routeError\|isFirstRun" test/` plus a targeted search for `toThrow` near `createRoot` usages turned up only the three tests already covered above, all unrelated to `<Failed>`/`console.error`), but this step is the actual confirmation, not the earlier trace.

- [ ] **Step 9: Commit**

```bash
git add src/owner.ts test/owner.test.ts test/dom/failed.test.tsx
git commit -m "$(cat <<'EOF'
feat: every root gets a default FailedScope, so failures always land somewhere

createRoot() now installs createFailedScope() on its own owner by
default, console.error-backed so a failure with no explicit <Failed>
stays exactly as visible as it was before. findNearestFailedScope and
findBoundaryScope('failed') always find this once they reach the root,
so useFailed() never needs a special "nothing found" case for code that
runs inside any root, and action()/a failed computed or signal binding
always have somewhere real to register instead of doing nothing (an
action failure previously) or only throwing/logging once with no
queryable state left behind (a computed/signal failure previously). An
explicit <Failed> anywhere between the failure and the root still wins,
and a nearer catchError still wins over any FailedScope at all, exactly
as before — this only changes what happens once neither exists.

No changes needed in src/effect.ts: it already looks up the nearest
FailedScope through the same walk, which is why this lands as a single
change to createRoot() rather than two separate ones.
EOF
)"
```

---

### Task 5: `<Loading>` context-only mode

**Files:**
- Modify: `src/dom/loading.ts`
- Test: `test/dom/loading.test.tsx`

**Interfaces:**
- Consumes: nothing new — `useLoading()` already exists and is unchanged.
- Produces: `<Loading>` with neither `initial` nor `fallback` given renders its (possibly partially-committed) subtree instead of nothing.

- [ ] **Step 1: Write the failing test**

Add to `test/dom/loading.test.tsx`, after the existing `'pending use() with neither → renders nothing'` test:

```tsx
test('pending use() with neither initial nor fallback → the rest of the subtree still renders', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => (
      <Loading>
        {() => (
          <div>
            <span data-testid="static">always here</span>
            <span>{() => use(p)}</span>
          </div>
        )}
      </Loading>
    ),
    target,
  )
  // The pending binding contributes no text, but the surrounding structure
  // — which does not depend on the pending value — is not hidden behind a
  // swap the way it would be if <Loading> rendered nothing at all.
  expect(target.querySelector('[data-testid="static"]')).not.toBeNull()
  expect(target.querySelector('[data-testid="static"]')?.textContent).toBe('always here')
  dispose()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/dom/loading.test.tsx -t "always here"`

Expected: FAIL — today, `<Loading>` with neither prop renders `undefined` while pending, so nothing (including the static span) is ever inserted into `target`.

- [ ] **Step 3: Update `<Loading>`'s render function in `src/dom/loading.ts`**

Find:

```ts
  return () => {
    if (!pendingSig()) return loadedSubtree
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
```

Replace with:

```ts
  return () => {
    if (!pendingSig()) return loadedSubtree
    // Neither prop given at all (not merely falsy — an explicit fallback of
    // null/''/false still means "swap to this") → context-only: stay
    // mounted. The atomic-commit gate above is unaffected either way — it
    // lives in the individual bindings' own reporting to this scope, not in
    // this swap decision, so a still-pending binding inside loadedSubtree
    // continues to withhold its own commit exactly as it already does.
    if (props.initial === undefined && props.fallback === undefined) return loadedSubtree
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm exec vitest run test/dom/loading.test.tsx -t "always here"`

Expected: PASS

- [ ] **Step 5: Rename the now-inaccurately-named existing test**

Find, in `test/dom/loading.test.tsx`:

```tsx
test('pending use() with neither → renders nothing', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => <Loading>{() => <span>{() => use(p)}</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('')
  dispose()
})
```

Replace with (rename only — assertion is unchanged, since a lone pending binding with no surrounding non-pending content still contributes no text either way):

```tsx
test('pending use() with neither: the one pending binding still shows nothing (its own commit is still withheld)', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<string>(() => {})
  const dispose = render(
    () => <Loading>{() => <span>{() => use(p)}</span>}</Loading>,
    target,
  )
  expect(target.textContent).toBe('')
  dispose()
})
```

- [ ] **Step 6: Run the full file to confirm zero regressions in this file**

Run: `pnpm exec vitest run test/dom/loading.test.tsx`

Expected: PASS — all pre-existing tests plus the 1 new one.

- [ ] **Step 7: Run the other three Loading test files to confirm they're unaffected**

Run: `pnpm exec vitest run test/dom/loading-atomic.test.tsx test/dom/loading-failure.test.tsx test/dom/loading-no-boundary.test.tsx`

Expected: PASS — every `<Loading>` usage in these files either passes `initial`/`fallback` explicitly (unaffected by this change) or exercises the `LoadingScope` directly via manual `register()`/`report()` calls without depending on the swap decision (also unaffected). This step is the actual confirmation of that claim, not just the plan's own trace.

- [ ] **Step 8: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/dom/loading.ts test/dom/loading.test.tsx
git commit -m "$(cat <<'EOF'
feat: Loading stays mounted when neither initial nor fallback is given

Symmetric with the same change to <Failed>: today, passing neither prop
renders nothing at all while pending, hiding everything in the subtree
behind the swap even for content that has nothing to do with the
pending value. The atomic-commit gate that makes <Loading> safe lives in
the individual bindings' own reporting to the boundary, not in this
swap decision, so falling through to the mounted subtree here doesn't
touch that guarantee — a binding still waiting on a pending value still
withholds its own commit exactly as before; everything else in the
subtree is simply no longer hidden while it waits.
EOF
)"
```

---

### Task 6: Full verification pass

**Files:** none (verification only)

**Interfaces:** none — this task confirms Tasks 1-5 together, it does not add behavior.

- [ ] **Step 1: Run the complete repo test suite**

Run: `pnpm test`

Expected: every test file passes. Compare the total test count against the pre-plan baseline (463 passed, 1 skipped — 464 total, confirmed by running `pnpm test` immediately before this plan's Task 1 began) — expect the baseline plus: 1 (`<Failed>` mounted-content) + 3 (`useFailed()`) + 3 (`Failed.Error`) from Tasks 1-3 in `test/dom/failed.test.tsx`; 4 from Task 4 in `test/owner.test.ts`; 1 from Task 4 in `test/dom/failed.test.tsx`; 1 from Task 5 in `test/dom/loading.test.tsx` — 13 new tests, 0 removed (Task 5's rename keeps the same test, doesn't add or delete one), for a total of 476 passed, 1 skipped (477 total).

- [ ] **Step 2: Run the repo typecheck**

Run: `pnpm typecheck`

Expected: PASS, no errors.

- [ ] **Step 3: Run the `examples/todo-async` Playwright suite**

Run: `cd examples/todo-async && pnpm exec playwright test`

Expected: all 8 tests pass unchanged — `examples/todo-async`'s `<Failed fallback={...}>` usage is untouched by this plan (Task 1 made `fallback` optional, but every existing caller that already provides one is unaffected).

- [ ] **Step 4: Confirm no stray sabotage artifacts remain**

Run: `git status --short`

Expected: clean (no uncommitted changes) — Tasks 3 and 4's sabotage-verification steps each explicitly restore the pre-sabotage version and re-run before their own commit step, so nothing should be outstanding here. If anything shows up, it means a restore step was missed — restore it now before proceeding.

- [ ] **Step 5: Update `docs/follow-ups.md`**

The spec's "Explicitly out of scope" section names one deferred item worth recording: a `Loading.Pending`-style compound component was considered and explicitly not built, since `useLoading()` alone already covers the same ground `useFailed()` covers for `<Failed>` (a single boolean, no error/retry payload to wrap). Add this to `docs/follow-ups.md`'s `## Open` section, in the same style as the file's other entries (check the file's existing header/severity legend and follow it):

```markdown
- **(small) A `Loading.Pending`-style compound component, mirroring `Failed.Error`, was considered and not built.** `useLoading()` alone already covers the same ground `useFailed()` covers for `<Failed>` — a single boolean with nothing else to wrap — so there was no equivalent gap for sugar to fill. Revisit if a concrete use case shows up that a bare `useLoading()` read doesn't serve well.
  Source: composable-boundary-state design review, 2026-08-19.
```

- [ ] **Step 6: Commit**

```bash
git add docs/follow-ups.md
git commit -m "$(cat <<'EOF'
docs: record the deferred Loading.Pending compound-component follow-up

Recorded during the composable-boundary-state work rather than acted
on, since useLoading() already covers what it would have wrapped.
EOF
)"
```

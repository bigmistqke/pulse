# `<Failed>` Failure Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pulse's failure boundary a collection boundary — `<Failed>` collects failed bindings and selects a fallback while the collection is non-empty — so that one rejection produces one fallback render instead of notifying an event callback three times.

**Architecture:** Generalise `LoadingScope` into a status-keyed `BoundaryScope` (collection only; `<Loading>`'s atomic-commit gate is NOT generalised and is not touched). `<Failed>` installs a `FailedScope` on its owner. A binding that throws a real error reports `{status: 'failed'}` through a controller; three reports from the same controller are one entry in a `Set`, which is what dissolves the triple delivery. `<Failed>` and `catchError` are peers in one walk up the owner chain — nearest wins — so `catchError` keeps its current semantics as the escape hatch.

**Tech Stack:** TypeScript, r3 (the underlying reactive graph), vitest with a Chromium browser project for DOM tests, pnpm.

## Global Constraints

- Use `pnpm` / `pnpm exec`. Never `npm` or `npx`.
- Full suite must be green at the end of every task: `pnpm exec vitest run` and `pnpm exec tsc --noEmit`.
- `test/dom/loading.test.tsx` and `test/dom/loading-atomic.test.tsx` must stay green **without modification** in every task. They pin the atomic-commit gate, which this work does not change and must not touch. If they go red, you have overreached: stop and reconsider rather than adjusting the gate to accommodate your change.
- The one currently-skipped test in the suite (`test/dom/loading-atomic.test.tsx`, top-level component missing the scope via `useLoading()`) stays skipped. It is a pre-existing known bug, recorded in `docs/follow-ups.md`.
- Suspension is not a failure. `NotReadyYet` must never reach a `<Failed>` boundary.
- Commit messages: plain language, no abbreviations, self-contained (no references to "task 3" or other outside context). No AI co-author trailers.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/owner.ts` | Owner tree, the boundary-scope slots, and the walks that find them (`findBoundaryScope`, `findNearestFailedScope`). Modified. | 1, 2 |
| `src/dom/loading.ts` | `<Loading>`: the pending collection **plus** the atomic-commit gate. Modified only to match the renamed scope shape. | 1 |
| `src/dom/failed.ts` | `<Failed>`: the failed collection and its fallback selection. **New.** | 2 |
| `src/effect.ts` | The only place a real failure is reported from — bindings rethrow into the effect beneath them. Modified. | 2, 3 |
| `src/failure.ts` | The failure registry. Gains `reset` on the entry and a `resetFailure` walk to the root failed stage. Modified. | 3 |
| `src/computed.ts` | Records itself as the failure source before throwing its parked failure; implements the entry's `reset`. Modified. | 3 |
| `src/transition-tracker.ts` | The per-binding-compute record. Gains the failure source alongside `usedInCurrentBinding`. Modified. | 3 |
| `src/dom/index.ts`, `src/index.ts` | Export `Failed`. Modified. | 2 |
| `test/dom/failed.test.tsx` | All `<Failed>` behaviour: collection, composition, reset. **New.** | 2, 3 |

**Not modified: `src/dom/bindings.ts`.** `insertChild` and `bindProp` already rethrow non-`NotReadyYet` errors into the `effect()` beneath them (`src/dom/bindings.ts:167`, `:169`), and that effect is what routes them. So failure reporting lives in exactly one file, and no binding ever registers a failed controller. This is also why the spec's plan to collapse the double registration is not in this plan — see "Why there is no double-registration task" below.

---

### Task 1: Generalise the scope slot into a status-keyed boundary

Pure mechanical refactor. No behaviour change, no new statuses, no new tests. Every existing test must pass untouched — that is this task's proof of correctness.

**Files:**
- Modify: `src/owner.ts` (the `Owner` interface, `newOwner`, `findLoadingScope`)
- Modify: `src/dom/loading.ts:21-22`, `:73-75`, `:134`
- Modify: `src/effect.ts` (three `findLoadingScope` call sites)
- Modify: `src/dom/bindings.ts` (four `findLoadingScope` call sites)

**Interfaces:**
- Produces: `type BindingStatus = 'pending' | 'failed'`; `interface BoundaryScope`; `interface LoadingScope extends BoundaryScope`; `interface FailedScope extends BoundaryScope`; `function findBoundaryScope<K extends BindingStatus>(start: Owner | null, kind: K): ScopeOfKind[K] | null`. `Owner.loadingScope` is replaced by `Owner.boundaries: { pending: LoadingScope | null; failed: FailedScope | null }`.

- [ ] **Step 1: Replace the scope types in `src/owner.ts`**

Replace the existing `LoadingScope` interface (`src/owner.ts:33-47`) with the generalised set. Keep `BindingState` and `BindingController` exactly as they are — the failed case arrives in Task 2.

```ts
/** The statuses a binding reports to a boundary. One boundary collects one status. */
export type BindingStatus = 'pending' | 'failed'

/**
 * A boundary that collects the bindings beneath it carrying one status, and
 * exposes whether that collection is non-empty.
 *
 * This is the part that generalises. `<Loading>` layers atomic-commit
 * coordination on top of it (see `LoadingScope.deferOrCommit`); a failure
 * boundary has nothing to commit atomically, so it uses the collection alone.
 */
export interface BoundaryScope {
  /** Which status this boundary collects. */
  readonly kind: BindingStatus
  /** `true` while this boundary's collection is non-empty. */
  readonly active: Accessor<boolean>
  /** Obtain a controller for a new binding. Each binding registers ONCE lazily;
   *  the controller persists across re-runs, so repeated reports of the same
   *  status are one entry, not many. */
  register(): BindingController
}

/** The pending collection, plus `<Loading>`'s atomic-commit gate. */
export interface LoadingScope extends BoundaryScope {
  readonly kind: 'pending'
  /**
   * If the boundary is currently pending, queue `commit` to run when the gate
   * opens. If nothing is pending, run `commit` immediately. This is the
   * coordination point for bindings that called `use()` but did NOT throw —
   * they still need to defer their DOM commit until all sibling pending
   * bindings have settled.
   */
  deferOrCommit(commit: () => void): void
}

/** The failed collection. */
export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
  /** Clear the collection and retry every binding in it. */
  reset(): void
}

/** Maps a status to the scope interface that collects it. */
interface ScopeOfKind {
  pending: LoadingScope
  failed: FailedScope
}
```

- [ ] **Step 2: Swap the `Owner` slot and the walk**

In `src/owner.ts`, replace the `loadingScope` field (`:63-64`) with `boundaries`:

```ts
  /** Boundary scopes installed on this owner, keyed by the status each collects.
   *  Set by `<Loading>` and `<Failed>` on their own boundary owner. */
  boundaries: { pending: LoadingScope | null; failed: FailedScope | null }
```

Update `newOwner` (`:69-74`) to initialise it:

```ts
function newOwner(
  parent: Owner | null = null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
  return {
    parent,
    errorHandler,
    children: [],
    cleanups: [],
    disposed: false,
    boundaries: { pending: null, failed: null },
  }
}
```

Replace `findLoadingScope` (`:258-265`) with the parameterised walk:

```ts
/**
 * Walk up the parent chain from `start` (inclusive) and return the first boundary
 * scope collecting `kind`. Returns `null` if none is found.
 *
 * Internal: used by `useLoading()`, and by bindings reporting their status.
 */
export function findBoundaryScope<K extends BindingStatus>(
  start: Owner | null,
  kind: K,
): ScopeOfKind[K] | null {
  let owner = start
  while (owner !== null) {
    const scope = owner.boundaries[kind]
    if (scope !== null) return scope as ScopeOfKind[K]
    owner = owner.parent
  }
  return null
}
```

- [ ] **Step 3: Update the four call-site files**

`src/dom/loading.ts` — the scope object (`:73-75`) gains `kind` and renames `pending` to `active`; the install site (`:134`) moves to the new slot. Nothing else in the file changes:

```ts
  const scope: LoadingScope = {
    kind: 'pending',
    active: pendingSig,
    register(): BindingController {
```

```ts
  boundaryOwner.boundaries.pending = scope
```

And `useLoading` (`src/dom/loading.ts:20-23`):

```ts
export function useLoading(): Accessor<boolean> {
  const scope = findBoundaryScope(getOwner(), 'pending')
  return scope === null ? CONST_FALSE_ACCESSOR : scope.active
}
```

In `src/effect.ts` and `src/dom/bindings.ts`, replace every `findLoadingScope(x)` with `findBoundaryScope(x, 'pending')` and update the imports from `./owner` / `../owner`. There are three call sites in `src/effect.ts` and four in `src/dom/bindings.ts`. In `src/effect.ts:133`, `scope.pending()` becomes `scope.active()`.

- [ ] **Step 4: Run the full suite and the typechecker**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: 330 passed, 1 skipped. `tsc` clean. A pure rename changes no behaviour; if any test fails, you have changed semantics — do not proceed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: key a boundary's scope on the status it collects

A boundary collects the bindings beneath it that carry one status and exposes
whether that collection is non-empty. That shape is not specific to loading, so
name it as what it is: a boundary scope, keyed on its status. An owner now holds
one scope slot per status rather than a single loading scope, and the walk that
finds a scope takes the status it is looking for.

The atomic-commit gate stays exactly where it was, as a loading concern. A
boundary that collects failures has nothing to commit atomically, so it wants the
collection alone. This is a rename and a reshape: no behaviour changes."
```

---

### Task 2: `<Failed>` — the failed collection and its fallback

**Files:**
- Create: `src/dom/failed.ts`
- Modify: `src/owner.ts` (add the `failed` case to `BindingState`; add `findNearestFailedScope`)
- Modify: `src/effect.ts` (report failures; unlatch on success)
- Modify: `src/dom/index.ts`, `src/index.ts` (export `Failed`)
- Test: `test/dom/failed.test.tsx` (new)

**Interfaces:**
- Consumes: `BoundaryScope`, `FailedScope`, `BindingController`, `findBoundaryScope` from Task 1.
- Produces: `function Failed(props: FailedProps): Accessor<unknown>`; `interface FailedProps { children: () => unknown; fallback: (error: unknown, reset: () => void) => unknown }`; `function findNearestFailedScope(start: Owner | null): FailedScope | null`. `BindingState` gains `{ status: 'failed'; error: unknown; retry: () => void }`.

- [ ] **Step 1: Write the failing tests**

Create `test/dom/failed.test.tsx`. These five tests pin the collection semantics and the composition rules.

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  Failed,
  flush,
  Loading,
  microtaskScheduler,
  render,
  setScheduler,
  signal,
  syncScheduler,
  use,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * A failure is graph state, so the boundary that reads it is a SELECTION over that
 * state, not a stream of events. One rejection re-runs the consuming binding three
 * times (the pending signal flipping false, the failure signal parking, and the
 * effect's settle-kick), and each re-run re-reads the failed node and re-throws.
 * All three reports come from the same controller, so the collection holds ONE
 * entry and the fallback renders once.
 */
test('one rejection renders the fallback once, however many times the binding re-runs', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))

  let fallbackRenders = 0
  render(
    () => (
      <Failed
        fallback={(error) => {
          fallbackRenders++
          return <p>{(error as Error).message}</p>
        }}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.textContent).toBe('boom')
  expect(fallbackRenders).toBe(1)
})

/** The boundary is not a latch. It shows the fallback exactly while something under
 *  it is failed — so when the failure clears on its own, it returns to the subtree
 *  with no reset() call at all. */
test('the boundary unlatches itself when the failure clears', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const c = computed(() =>
    id() === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
  )

  render(
    () => (
      <Failed fallback={(error) => <p>{(error as Error).message}</p>}>
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  setId(2)
  await tick()
  flush()

  expect(target.textContent).toBe('ok')
})

/** The collection is a set of failed bindings. It empties only when ALL of them
 *  recover. */
test('two failed siblings render one fallback, which clears only when both recover', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const [id, setId] = signal(1)
  const a = computed(() =>
    id() === 1 ? Promise.reject(new Error('a-failed')) : Promise.resolve('a-ok'),
  )
  const b = computed(() =>
    id() <= 2 ? Promise.reject(new Error('b-failed')) : Promise.resolve('b-ok'),
  )

  render(
    () => (
      <Failed fallback={() => <p>fallback</p>}>
        {() => (
          <div>
            <span>{() => use(a)}</span>
            <span>{() => use(b)}</span>
          </div>
        )}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('fallback')

  // `a` recovers; `b` is still failed, so the collection is still non-empty.
  setId(2)
  await tick()
  flush()
  expect(target.textContent).toBe('fallback')

  // Now both are healthy.
  setId(3)
  await tick()
  flush()
  expect(target.textContent).toBe('a-okb-ok')
})

/** `<Failed>` and `catchError` are peers in one walk up the owner chain. The
 *  nearest one wins, so a `catchError` INSIDE a `<Failed>` intercepts first and the
 *  boundary never activates. */
test('a catchError nested inside <Failed> wins, and the boundary never activates', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new Error('boom')))
  const caught: unknown[] = []

  render(
    () => (
      <Failed fallback={() => <p>fallback</p>}>
        {() =>
          catchError(
            () => <span>{() => use(c)}</span>,
            (e) => caught.push(e),
          ) as Node
        }
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(caught.length).toBeGreaterThan(0)
  expect((caught[0] as Error).message).toBe('boom')
  expect(target.textContent).not.toBe('fallback')
})

/** Suspension is not a failure. A pending read routes to `<Loading>` and must never
 *  reach `<Failed>`. */
test('a pending read reaches <Loading>, never <Failed>', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  let release!: (v: string) => void
  const c = computed(() => new Promise<string>((r) => (release = r)))

  render(
    () => (
      <Failed fallback={() => <p>failed</p>}>
        {() => (
          <Loading fallback={<p>loading</p>}>
            {() => <span>{() => use(c)}</span>}
          </Loading>
        )}
      </Failed>
    ),
    target,
  )

  expect(target.textContent).toBe('loading')

  release('done')
  await tick()
  flush()

  expect(target.textContent).toBe('done')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`
Expected: FAIL — the module does not export `Failed`.

- [ ] **Step 3: Add the failed status and the nearest-wins walk to `src/owner.ts`**

Extend `BindingState` (`src/owner.ts:13-16`) with the failed case:

```ts
export type BindingState =
  | { readonly status: 'throwing' }
  | { readonly status: 'ready'; readonly commit: () => void }
  | { readonly status: 'idle' }
  /** The binding threw a real error (not a suspension). `retry` re-runs it. */
  | { readonly status: 'failed'; readonly error: unknown; readonly retry: () => void }
```

Add the walk, next to `routeError`:

```ts
/**
 * The nearest `<Failed>` boundary — or `null` if a `catchError` handler is nearer,
 * or if there is neither.
 *
 * `<Failed>` and `catchError` are peers in ONE walk up the owner chain, and the
 * nearest wins. Returning `null` when a handler is nearer is what lets the caller
 * fall through to `routeError`, which walks the same chain and finds that handler.
 * So a `catchError` nested inside a `<Failed>` intercepts first, and the boundary
 * catches whatever the inner handler does not.
 */
export function findNearestFailedScope(start: Owner | null): FailedScope | null {
  let owner = start
  while (owner !== null) {
    if (owner.boundaries.failed !== null) return owner.boundaries.failed
    if (owner.errorHandler !== null) return null // a nearer catchError wins
    owner = owner.parent
  }
  return null
}
```

- [ ] **Step 4: Create `src/dom/failed.ts`**

```ts
import {
  createSubOwner,
  getOwner,
  runWithOwner,
  type BindingController,
  type FailedScope,
  type Owner,
} from '../owner'
import { signal, type Accessor } from '../signal'

/** What a failed binding reported: the error, and how to re-run it. */
interface FailureReport {
  error: unknown
  retry: () => void
}

export interface FailedProps {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Rendered in place of the subtree while anything beneath is failed. */
  fallback: (error: unknown, reset: () => void) => unknown
}

/**
 * Failure boundary. Bindings beneath it that throw a real error report themselves
 * here; the boundary collects them and renders `fallback` in place of the subtree
 * while the collection is non-empty.
 *
 * It is a SELECTION over live graph state, not a latch. A React-style error
 * boundary remembers that an error happened and shows its fallback until something
 * resets it. This one shows the fallback exactly while something under it is
 * currently failed — so when a failure clears on its own (an upstream dependency
 * changes and the stage re-runs successfully), the binding reports `idle`, the
 * collection empties, and the subtree returns with no `reset()` call.
 *
 * That is also what makes it idempotent: a single rejection re-runs the consuming
 * binding several times, but every report comes from the same controller, so the
 * collection holds one entry and the fallback renders once.
 *
 * Suspension is NOT a failure: `NotReadyYet` is handled by `<Loading>` and never
 * reaches here.
 */
export function Failed(props: FailedProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)

  // The collection: one entry per currently-failed binding, keyed on its
  // controller — so a binding that re-runs and re-reports stays ONE entry.
  const failedSet = new Map<BindingController, FailureReport>()

  const [activeSig, setActiveSig] = signal(false)
  // The error the fallback is shown. Held in its own signal so the fallback
  // re-renders when the FIRST error changes while the boundary stays active.
  const [errorSig, setErrorSig] = signal<unknown>(null)

  const recompute = () => {
    const first: FailureReport | undefined = failedSet.values().next().value
    setErrorSig(first === undefined ? null : first.error)
    setActiveSig(failedSet.size > 0)
  }

  const reset = (): void => {
    const reports = Array.from(failedSet.values())
    failedSet.clear()
    recompute()
    // Re-run each failed binding. If it fails again it reports again, refilling the
    // collection and bringing the fallback straight back — which is correct.
    for (const report of reports) report.retry()
  }

  const scope: FailedScope = {
    kind: 'failed',
    active: activeSig,
    register(): BindingController {
      const controller: BindingController = {
        report(state): void {
          if (state.status === 'failed') {
            failedSet.set(controller, { error: state.error, retry: state.retry })
          } else {
            // Any other status means this binding is no longer failed.
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
  boundaryOwner.boundaries.failed = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    if (!activeSig()) return subtree
    return props.fallback(errorSig(), reset)
  }
}
```

- [ ] **Step 5: Report failures from `src/effect.ts`**

Bindings rethrow real errors into the effect beneath them, so this is the only place that reports. In `singleArgEffect`, add a second controller alongside the pending one:

```ts
  let failedController: BindingController | null = null

  const ensureFailedController = (scope: FailedScope): BindingController => {
    if (failedController === null) failedController = scope.register()
    return failedController
  }
```

Then rewrite the body's success path and its non-`NotReadyYet` catch:

```ts
  const body = () => {
    kick()
    try {
      fn()
      suspendedOn = null
      controller?.report({ status: 'idle' })
      // Recovered: leave the failed collection, so the boundary can unlatch.
      failedController?.report({ status: 'idle' })
    } catch (e) {
      if (e instanceof NotReadyYet) {
        // ... unchanged ...
        return
      }
      // A real failure. It is graph state, not an event: report it to the nearest
      // <Failed> boundary, which collects it and selects its fallback. The same
      // controller reporting repeatedly is one entry, so a single rejection that
      // re-runs this body several times still renders one fallback.
      controller?.report({ status: 'idle' }) // failed is not pending
      const failedScope = findNearestFailedScope(myOwner)
      if (failedScope !== null) {
        ensureFailedController(failedScope).report({
          status: 'failed',
          error: e,
          retry: () => setKick(++kickCount),
        })
        return
      }
      if (isFirstRun) routeError(myOwner, e)
      else routeErrorFromRerun(myOwner, e)
    }
  }
```

Extend the disposer to unregister it:

```ts
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
      failedController?.unregister()
      failedController = null
    },
  })
```

Apply the identical change to `stagedEffect`: the same `failedController` / `ensureFailedController` pair, `failedController?.report({ status: 'idle' })` after a successful compute (right after `suspendedOn = null`), the same failed-scope branch in its catch, and the same two lines in its disposer.

Import `findNearestFailedScope` and `type FailedScope` from `./owner`.

- [ ] **Step 6: Export `Failed`**

`src/dom/index.ts` — add:

```ts
export { Failed } from './failed'
```

`src/index.ts:25` — add `Failed` to the `./dom` export list, keeping it alphabetical:

```ts
export { Failed, For, Fragment, h, Loading, Match, render, Show, Switch, useLoading, type Truthy } from './dom'
```

- [ ] **Step 7: Run the new tests, then the full suite**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`
Expected: PASS, 5 tests.

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: 335 passed, 1 skipped. `tsc` clean. `loading.test.tsx` and `loading-atomic.test.tsx` unmodified and green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: collect failures in a boundary instead of firing a callback

A failure is graph state: parked on the node, queried with failure(x), thrown by
use(x). The boundary that read it was an event callback, and pushing collected
state through an event stream had a measurable cost — a single promise rejection
notified the boundary three times, because the consuming binding re-runs three
times as one settle lands and each re-run re-reads a failed node and re-throws.

<Failed> collects the failed bindings beneath it and renders its fallback while
that collection is non-empty. The three reports come from one controller, so they
are one entry in a set: one rejection, one fallback. The redundant re-runs still
happen; they are simply no longer observable.

The boundary is a selection over live state rather than a latch. When a failure
clears on its own, the binding reports that it is healthy, the collection empties,
and the subtree comes back without anyone calling reset.

<Failed> and catchError are peers in one walk up the owner chain and the nearest
one wins, so catchError keeps its current semantics as the escape hatch and a
catchError nested inside a boundary still intercepts first."
```

---

### Task 3: Failure provenance and `reset()` to the root failed stage

`reset()` currently re-runs the failed binding. That is enough for a binding that threw a plain error, and useless for the common case: the binding re-reads a computed whose failure is still parked, and throws again. To retry with unchanged inputs, `reset()` must clear the failure on the node that actually failed — which may live entirely outside the boundary.

**Files:**
- Modify: `src/transition-tracker.ts` (record the failure source alongside `usedInCurrentBinding`)
- Modify: `src/computed.ts` (mark the source before throwing; implement the entry's `reset`)
- Modify: `src/failure.ts` (`FailureEntry.reset`; `resetFailure` walking upstream to the root)
- Modify: `src/owner.ts` (`BindingState`'s failed case carries `source`)
- Modify: `src/effect.ts` (pass the captured source through)
- Test: `test/dom/failed.test.tsx` (append)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `function markFailureSource(source: Accessor<unknown>): void`; `function takeFailureSource(): Accessor<unknown> | null`; `function resetFailure(x: Accessor<unknown>): void`. `FailureEntry` gains `reset: () => void`. `BindingState`'s failed case gains `source: Accessor<unknown> | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/dom/failed.test.tsx`:

```tsx
/** The retry button. Nothing in the graph changed, so nothing will re-run on its
 *  own: reset() must clear the parked failure on the node that failed and recompute
 *  it — even though that node was created outside the boundary entirely. */
test('reset() retries with unchanged inputs', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let attempt = 0
  const c = computed(() => {
    attempt++
    return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  })

  render(
    () => (
      <Failed
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  target.querySelector('button')!.click()
  await tick()
  flush()

  expect(target.textContent).toBe('ok')
  expect(attempt).toBe(2)
})

/** A downstream stage only PROPAGATES its upstream's failure. Resetting it alone
 *  would leave the real source parked and the retry would fail identically, so
 *  reset() walks the upstream chain to the root failed stage. */
test('reset() recomputes the root failed stage of a pipeline, not the leaf', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let sourceRuns = 0
  const c = computed(
    () => {
      sourceRuns++
      return sourceRuns === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve('raw')
    },
    (v: string) => `${v}-derived`,
  )

  render(
    () => (
      <Failed
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => <span>{() => use(c)}</span>}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()
  expect(target.textContent).toBe('boom')

  target.querySelector('button')!.click()
  await tick()
  flush()

  // Stage 0 re-ran (the root), and the derived stage rebuilt on top of it.
  expect(sourceRuns).toBe(2)
  expect(target.textContent).toBe('raw-derived')
})

/** A binding that threw a plain error has no failed node behind it (`source` is
 *  null). reset() simply re-runs the binding. */
test('reset() re-runs a binding that threw a plain error', () => {
  const target = document.createElement('section')
  document.body.append(target)

  let throwIt = true

  render(
    () => (
      <Failed
        fallback={(error, reset) => (
          <button on:click={reset}>{(error as Error).message}</button>
        )}
      >
        {() => (
          <span>
            {() => {
              if (throwIt) throw new Error('plain')
              return 'recovered'
            }}
          </span>
        )}
      </Failed>
    ),
    target,
  )

  flush()
  expect(target.textContent).toBe('plain')

  // No signal changed — only reset() can bring this binding back.
  throwIt = false
  target.querySelector('button')!.click()
  flush()

  expect(target.textContent).toBe('recovered')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t reset`
Expected: FAIL. The first two fail because `reset()` re-runs the binding, which re-reads a still-parked failure and throws again — the fallback stays. (The third may already pass; it is the case `reset()` already handles.)

- [ ] **Step 3: Record the failure source in `src/transition-tracker.ts`**

Add alongside the existing flag. Update the module docblock to say it records what happened during a binding compute, not only `use()` engagement.

**A note on the spec, which is slightly wrong here.** Spec §7 proposes folding the two module-level flags into one record that `runBindingCompute` populates *and returns*. The failure source cannot ride the return value: on the throw path `runBindingCompute` does not return at all, and the source has to survive the unwind so the catch handler can read it. So the two stay as module state, taken by the catcher via `takeFailureSource()`. Keep them documented together in one place, but do not try to return them together.

```ts
import type { Accessor } from './signal'

let usedInCurrentBinding = false
let failureSourceInCurrentBinding: Accessor<unknown> | null = null

/** Called by a computed's accessor before it throws its parked failure, so the
 *  binding that catches it knows WHICH node failed and can reset it. */
export function markFailureSource(source: Accessor<unknown>): void {
  failureSourceInCurrentBinding = source
}

/**
 * The node whose parked failure was thrown during the binding compute that just
 * threw, or `null` if the throw did not come from one. Reading it clears it.
 *
 * Called from the CATCH handler, after `runBindingCompute` has unwound. That is why
 * `runBindingCompute` restores this flag only on its success path: on the throw path
 * the value has to survive the unwind so the catcher can take it.
 */
export function takeFailureSource(): Accessor<unknown> | null {
  const source = failureSourceInCurrentBinding
  failureSourceInCurrentBinding = null
  return source
}
```

And in `runBindingCompute`, reset it on entry and restore it only when `fn` returns:

```ts
export function runBindingCompute<T>(fn: () => T): { value: T; engagedTransition: boolean } {
  const prevUsed = usedInCurrentBinding
  const prevSource = failureSourceInCurrentBinding
  usedInCurrentBinding = false
  failureSourceInCurrentBinding = null
  try {
    const value = fn()
    // Success: nothing threw, so no catcher is waiting to take the source.
    failureSourceInCurrentBinding = prevSource
    return { value, engagedTransition: usedInCurrentBinding }
  } finally {
    usedInCurrentBinding = prevUsed
  }
}
```

- [ ] **Step 4: Mark the source, and add `reset`, in `src/computed.ts`**

In the accessor (`src/computed.ts:417-437`), mark before throwing:

```ts
    r3Read(depTracker as R3Computed<unknown>)
    const value = publishedValue()
    const err = failureSig()
    if (err !== null) {
      // Tell the binding that catches this WHICH node failed, so it can reset the
      // right one. The failure may be parked on a computed created far outside the
      // boundary that ends up collecting the binding.
      markFailureSource(accessor)
      throw err
    }
    return value
```

In the `registerFailure` call (`:452-468`), add the entry's `reset`:

```ts
  registerFailure(accessor, {
    error: failureSig,
    value: () => {
      r3Read(depTracker as R3Computed<unknown>)
      return publishedValue()
    },
    // Clear the parked failure and re-run the body. The kick is a dep of the body,
    // so the stage re-executes from the top and suspends on a fresh promise —
    // a genuine retry with unchanged inputs.
    reset: () => {
      setFailureSig(null)
      setKick(++kickCount)
    },
    upstream: inputAccessor
      ? lookupFailure(inputAccessor as Accessor<unknown>)
      : undefined,
  })
```

Import `markFailureSource` from `./transition-tracker`.

- [ ] **Step 5: Add `reset` and the upstream walk to `src/failure.ts`**

Add `reset` to `FailureEntry`:

```ts
export interface FailureEntry {
  error: Accessor<unknown>
  value: Accessor<unknown>
  /** Clear this node's parked failure and recompute it. */
  reset: () => void
  upstream?: FailureEntry
}
```

And the walk:

```ts
/**
 * Clear the failure at the ROOT of this node's upstream chain and recompute it.
 *
 * A downstream stage only propagates its upstream's failure. Resetting it alone
 * would leave the real source parked, and the retry would fail identically. So walk
 * the chain the way `failure()` does and reset the deepest stage that is actually
 * failed — the one the failure originated in.
 *
 * A no-op if nothing in the chain is failed, or the node is not registered (a plain
 * signal, which never parks a failure).
 */
export function resetFailure<T>(x: Accessor<T>): void {
  let cur = registry.get(x as Accessor<unknown>)
  let root: FailureEntry | undefined
  while (cur !== undefined) {
    const e = cur.error()
    if (e !== null && e !== undefined) root = cur
    cur = cur.upstream
  }
  root?.reset()
}
```

- [ ] **Step 6: Thread the source through `src/owner.ts` and `src/effect.ts`**

`src/owner.ts` — the failed case carries it:

```ts
  /** The binding threw a real error (not a suspension). `source` is the node whose
   *  parked failure was thrown, if the throw came from one; `retry` re-runs the
   *  binding. */
  | {
      readonly status: 'failed'
      readonly error: unknown
      readonly source: Accessor<unknown> | null
      readonly retry: () => void
    }
```

`src/effect.ts` — capture it in both catches (`singleArgEffect` and `stagedEffect`):

```ts
      ensureFailedController(failedScope).report({
        status: 'failed',
        error: e,
        source: takeFailureSource(),
        retry: () => setKick(++kickCount),
      })
```

Import `takeFailureSource` from `./transition-tracker`.

- [ ] **Step 7: Use the source in `<Failed>`'s reset**

In `src/dom/failed.ts`, extend `FailureReport` and `reset`:

```ts
interface FailureReport {
  error: unknown
  source: Accessor<unknown> | null
  retry: () => void
}
```

```ts
  const reset = (): void => {
    const reports = Array.from(failedSet.values())
    failedSet.clear()
    recompute()
    for (const report of reports) {
      // Clear the parked failure at its root first — otherwise the binding just
      // re-reads a still-failed node and throws again.
      if (report.source !== null) resetFailure(report.source)
      report.retry()
    }
  }
```

And in `register`:

```ts
          if (state.status === 'failed') {
            failedSet.set(controller, {
              error: state.error,
              source: state.source,
              retry: state.retry,
            })
          }
```

Import `resetFailure` from `../failure` and `type Accessor` from `../signal`.

- [ ] **Step 8: Run the tests, then the full suite**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`
Expected: PASS, 8 tests.

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: 338 passed, 1 skipped. `tsc` clean.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: retry a failed node from the boundary that collected it

A boundary collects the binding that failed, but the thing that failed is usually
the computed it was reading — and that computed is often created outside the
boundary entirely. Re-running the binding alone achieves nothing: it re-reads a
still-parked failure and throws again. So the binding now records which node's
failure it threw, the same way it already records whether it called use(), and
hands that provenance to the boundary along with the error.

Resetting walks the upstream chain to the stage the failure originated in, rather
than the stage that merely propagated it. Resetting a leaf that is only carrying
its upstream's failure would leave the real source parked, and the retry would fail
in exactly the same way.

Recovery driven by a dependency change already worked without any of this. What
this adds is the retry button: trying again with unchanged inputs."
```

---

## Why there is no double-registration task

The spec (§2) planned to collapse the per-binding double registration as part of this work, on the grounds that two boundary kinds would otherwise mean four controllers per binding. **That premise is wrong**, and it is worth recording why, because it is the reason the riskiest part of the spec is not in this plan.

`insertChild` and `bindProp` do not route their own failures. On a non-`NotReadyYet` throw they *rethrow* (`src/dom/bindings.ts:167`, `:169`) into the `effect()` beneath them, and that effect is what routes. So a binding never registers a failed controller at all — only the effect does. Adding `<Failed>` therefore adds exactly **one** controller per binding, owned by the effect, and leaves the existing pending double-registration at two, precisely as it is today.

The duplication is unchanged, not multiplied. The reason to fix it under time pressure, inside a change that touches `<Loading>`, is gone. It stays a standalone cleanup, recorded below, to be done on its own with its own tests.

This is also why `src/dom/bindings.ts` is not modified by any task in this plan.

## Follow-ups to record in `docs/follow-ups.md`

- **(later) `insertChild` / `bindProp` still double-register with the pending boundary.** Already recorded in `docs/follow-ups.md`; re-confirmed by this work and deliberately left alone. One reactive child puts two controllers in the pending collection — its own, and the one belonging to the `effect()` beneath it. The gate tolerates it (set semantics; it drains when both report). The fix is the `bindingEffect` primitive: an effect that drives reactive re-runs without owning a scope controller, leaving coordination to the caller. Do it as its own change, gated on `test/dom/loading.test.tsx` and `test/dom/loading-atomic.test.tsx` staying green, because those pin the atomic-commit gate and it is subtle.

Add under "Architectural notes" once the plan is done:

- **(later) The redundant binding re-runs on settle.** One settling promise re-runs a consuming binding three times: the pending signal flipping false, the failure signal parking, and the effect's own settle-kick. `<Failed>`'s collection makes this unobservable, and `src/effect.ts` already dedupes it on the success path with an `Object.is` gate. Removing the re-runs themselves means batching the settle writes in `computed.ts` so one settle produces one graph transition — which touches the success path and that change gate. Safer now that the boundary is idempotent.
- **(later) `<Failed>` shows the first collected error only.** With several bindings failed at once, the fallback sees whichever landed first. An `errors` accessor on the scope would expose all of them. No use case yet.

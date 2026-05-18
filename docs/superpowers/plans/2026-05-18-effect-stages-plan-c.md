# Effect Stages Implementation Plan (Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a staged `effect([...stages], commit)` form that runs a pipeline of stages (sync/async/generator) and fires `commit(value)` with the resolved value of the last stage. The commit participates in `<Loading>`'s atomic-commit gather just like DOM bindings — when the surrounding scope is pending, the commit is deferred via `scope.deferOrCommit(...)`.

**Architecture:** Compose existing primitives. The staged form internally calls `computed(...stages)` (which already handles suspension, SWR, pending registry, error routing per Plan A/B) and then wraps the resulting accessor in a single-arg `effect(() => commit(use(pipelineAccessor)))`. The boundary gating falls out for free: `use(pipelineAccessor)` engages the transition tracker (Plan B Task 5.5), and the wrapping effect's commit (calling user's `commit(value)`) routes through `scope.deferOrCommit`. No new low-level machinery needed.

**Tech Stack:** Same as Plan B. Builds on Plan A's pending tracker, Plan B's boundary gather, Plan B Task 5.5's transition tracker.

---

## File Structure

- **Modify** `src/effect.ts` — add the staged overload + implementation; keep single-arg `effect(fn)` unchanged.
- **Modify** `src/index.ts` — no change needed (already exports `effect`).
- **Create** `test/effect-stages.test.ts` — new file for staged-effect tests (keeps existing `effect.test.ts` focused on the single-arg form).
- **Modify** `docs/follow-ups.md` — record Plan C landing; close the "effect-staging deferred" entry.

---

## Composition strategy

Pseudocode of the new shape:

```ts
function effect(...args) {
  if (typeof args[0] === 'function') {
    return singleArgEffect(args[0])  // existing path, untouched
  }
  // Staged form
  const stages = args[0] as Stage[]
  const commit = args[1] as (v: unknown) => void
  // Build the pipeline as a computed.
  const pipeline = computed(...(stages as [Stage, ...Stage[]]))
  // Wrap commit in a single-arg effect that reads the pipeline via use(...)
  // so it participates in transitions.
  singleArgEffect(() => {
    const value = use(pipeline)
    commit(value as Awaited<unknown>)
  })
}
```

`computed` already handles every concern at the stage layer (suspension via Plan B Task 2.5's NotReadyYet absorption, SWR, pending registry walking, error routing). `effect`'s single-arg form already handles `NotReadyYet` from `use(pipeline)` (suspends, registers with scope as throwing). The transition-tracker engagement (from Plan B Task 5.5) fires because the wrapping effect's body calls `use(...)`, so when its commit fires AND the scope is currently pending due to siblings, the deferOrCommit routing kicks in automatically.

**However:** the deferOrCommit path is currently inside `insertChild` and `reactiveCommit` (the binding-effect-with-DOM-commit paths), not inside the bare `effect()` path. `effect()` today reports `idle` on success — its body's side effects are already done. For Plan C's commit to participate in the gather, we need `effect()` to route its side effect through `deferOrCommit` when the body called `use()` AND scope is pending.

That's a real change to `effect.ts`. Without it, the commit fires immediately on success — same wrinkle Plan B started with.

**Two implementation paths:**

- **(P1) Make `effect()` defer its body when engaged + scope pending.** Wrap the user's `fn` in a `runBindingCompute` to capture engagement, but `fn` has side effects directly — we can't defer it after the fact. **Doesn't work** for plain `effect(fn)` because the body IS the side effect.
- **(P2) Staged effect uses a different internal effect that supports defer.** The staged form's wrapping effect is INTERNAL — we write it ourselves. We don't call `singleArgEffect`; we write a small inline variant that does compute (`use(pipeline)` to get value) and commit (`commit(value)`) as two phases. The commit phase routes through `scope.deferOrCommit` when engaged + pending.

Going with **(P2)**. The staged form gets its own minimal effect loop. Single-arg `effect(fn)` keeps its existing behavior unchanged.

---

## Task 1: Add staged `effect` overload signatures

**Files:**
- Modify: `src/effect.ts`

- [ ] **Step 1: Add types and overloads**

At the top of `src/effect.ts`, after the imports, add stage typing matching `computed`:

```ts
import type { Resolved } from './async'

/** A pipeline stage: takes the prior stage's resolved value, returns sync/Promise/generator. */
type Stage<In, Out> = (value: In) => Out
```

Then add the overload signatures (above the existing single-arg `effect`):

```ts
// Existing single-arg overload — unchanged signature
export function effect(fn: () => void): void

// Staged-effect overloads, 1–5 stages
export function effect<A>(
  stages: [() => A],
  commit: (value: Resolved<A>) => void,
): void
export function effect<A, B>(
  stages: [() => A, Stage<Resolved<A>, B>],
  commit: (value: Resolved<B>) => void,
): void
export function effect<A, B, C>(
  stages: [() => A, Stage<Resolved<A>, B>, Stage<Resolved<B>, C>],
  commit: (value: Resolved<C>) => void,
): void
export function effect<A, B, C, D>(
  stages: [() => A, Stage<Resolved<A>, B>, Stage<Resolved<B>, C>, Stage<Resolved<C>, D>],
  commit: (value: Resolved<D>) => void,
): void
export function effect<A, B, C, D, E>(
  stages: [
    () => A,
    Stage<Resolved<A>, B>,
    Stage<Resolved<B>, C>,
    Stage<Resolved<C>, D>,
    Stage<Resolved<D>, E>,
  ],
  commit: (value: Resolved<E>) => void,
): void
```

Then the implementation signature (widened):

```ts
export function effect(
  ...args:
    | [fn: () => void]
    | [stages: Array<(value: any) => unknown>, commit: (value: unknown) => void]
): void {
  if (typeof args[0] === 'function') {
    return singleArgEffect(args[0] as () => void)
  }
  const stages = args[0] as Array<(value: unknown) => unknown>
  const commit = args[1] as (value: unknown) => void
  return stagedEffect(stages, commit)
}
```

Rename the EXISTING `export function effect(fn: () => void): void { ... }` body to `function singleArgEffect(fn: () => void): void { ... }` (drop `export`, keep the body identical). Add `stagedEffect` as a stub for now:

```ts
function stagedEffect(stages: Array<(value: unknown) => unknown>, commit: (value: unknown) => void): void {
  throw new Error('TODO Task 2')
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: Clean. The new overloads are typed, the dispatch reads correctly.

- [ ] **Step 3: Commit**

```bash
git add src/effect.ts
git commit -m "feat(effect): scaffold staged effect overloads (impl to follow)"
```

---

## Task 2: Implement `stagedEffect` via composition

**Files:**
- Modify: `src/effect.ts`
- Create: `test/effect-stages.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/effect-stages.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  effect,
  flush,
  microtaskScheduler,
  setScheduler,
  signal,
  syncScheduler,
} from '../src/index'
import { createRoot } from '../src/owner'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => setScheduler(microtaskScheduler(flush)))

describe('effect — staged form', () => {
  test('single sync stage: commit receives the value', () => {
    createRoot(() => {
      const seen: number[] = []
      effect([() => 42], (v) => seen.push(v))
      expect(seen).toEqual([42])
    })
  })

  test('two sync stages: commit receives the final stage value', () => {
    createRoot(() => {
      const seen: number[] = []
      effect([() => 10, (n) => n * 2], (v) => seen.push(v))
      expect(seen).toEqual([20])
    })
  })

  test('async stage: commit fires after Promise resolves', async () => {
    await createRoot(async () => {
      const seen: string[] = []
      let resolve!: (v: string) => void
      const p = new Promise<string>((r) => (resolve = r))
      effect([() => p], (v) => seen.push(v))
      expect(seen).toEqual([])
      resolve('hello')
      await p
      await new Promise((r) => queueMicrotask(() => r(undefined)))
      flush()
      expect(seen).toEqual(['hello'])
    })
  })

  test('reactive sync pipeline: commit fires on signal change', () => {
    createRoot(() => {
      const seen: number[] = []
      const [n, setN] = signal(1)
      effect([() => n() * 10], (v) => seen.push(v))
      expect(seen).toEqual([10])
      setN(2)
      expect(seen).toEqual([10, 20])
      setN(3)
      expect(seen).toEqual([10, 20, 30])
    })
  })
})
```

- [ ] **Step 2: Run tests; expect failure**

Run: `pnpm exec vitest run test/effect-stages.test.ts`
Expected: FAIL — `stagedEffect` currently throws "TODO Task 2".

- [ ] **Step 3: Implement `stagedEffect`**

Add imports at the top of `src/effect.ts`:

```ts
import { computed } from './computed'
import { use } from './async'
```

Replace the stub with:

```ts
function stagedEffect(
  stages: Array<(value: unknown) => unknown>,
  commit: (value: unknown) => void,
): void {
  // Build the pipeline as a computed; this gives us suspension + SWR + pending
  // registry + error routing for free (Plan A/B/Plan B Task 2.5).
  // `computed(...stages)` requires at least one stage.
  if (stages.length === 0) {
    throw new Error('effect: staged form requires at least one stage')
  }
  // `computed`'s overloads constrain stage shape; we widen at runtime.
  const pipeline = (computed as unknown as (
    ...s: Array<(value: unknown) => unknown>
  ) => () => unknown)(...stages)

  // Wrap commit in a single-arg effect that reads the pipeline via `use(...)`
  // — this engages transition coordination (Plan B Task 5.5) so the commit
  // routes through scope.deferOrCommit when the boundary is pending due to
  // siblings.
  singleArgEffect(() => {
    const value = use(pipeline)
    commit(value)
  })
}
```

- [ ] **Step 4: Run tests; expect pass**

Run: `pnpm exec vitest run test/effect-stages.test.ts`
Expected: PASS — all four tests green.

If they don't all pass:
- Sync tests should pass immediately.
- Async test may need timing tweaks. Look at the existing `loading-atomic.test.tsx` for the `await + flush()` pattern.

- [ ] **Step 5: Run full suite**

Run: `pnpm exec vitest run`
Expected: 243+ pre-existing tests still pass; new tests added.

- [ ] **Step 6: Commit**

```bash
git add src/effect.ts test/effect-stages.test.ts
git commit -m "feat(effect): staged effect via composition (computed + use)"
```

---

## Task 3: Boundary integration test — staged effect commit defers under `<Loading>`

The composition strategy means the wrapping `singleArgEffect`'s commit IS the user's commit, and Plan B's mechanisms gate it. Wait — they don't, actually. `singleArgEffect` reports `'idle'` on success; its body's side effects (including the call to `commit(value)`) fire immediately during the body. There's NO commit deferral for the body of a single-arg effect.

**This means composition alone does NOT achieve gating** for Plan C. We need to thread the deferral through.

**Resolution:** the `stagedEffect` builds its own minimal effect loop that DOES split compute (`use(pipeline)`) from commit (`commit(value)`), and routes commit through `scope.deferOrCommit` when engaged + scope pending. This mirrors what `reactiveCommit` does for DOM bindings.

Replace the `singleArgEffect(...)` wrapping at the bottom of `stagedEffect` with a direct inline effect that splits the phases:

**Files:**
- Modify: `src/effect.ts`
- Modify: `test/effect-stages.test.ts`

- [ ] **Step 1: Write the failing boundary test**

Append to `test/effect-stages.test.ts`:

```tsx
// At top of file, add Loading and use imports:
//   import { Loading } from '../src/dom/loading'
//   (use is already imported)

import { Loading } from '../src/dom/loading'
import { render } from '../src/dom/render'
import { use } from '../src/async'
import { jsx } from '../src/dom/jsx-runtime'
// Use JSX-like construction:
//   const tree = jsx(Loading, { children: () => ... })

test('staged effect commit defers when inside <Loading> with a pending sibling', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  const seen: string[] = []
  let resolveStage!: (v: string) => void
  const pStage = new Promise<string>((r) => (resolveStage = r))
  let resolveSibling!: (v: string) => void
  const pSibling = new Promise<string>((r) => (resolveSibling = r))

  const dispose = render(
    () =>
      jsx(Loading, {
        children: () => {
          // Sibling DOM binding that throws until pSibling settles.
          // Also start the staged effect that fires commit on pStage settle.
          effect([() => pStage], (v) => seen.push(v))
          return jsx('span', { class: 'sib', children: () => use(pSibling) })
        },
      }),
    target,
  )

  // Resolve stage FIRST — commit should defer because sibling still throws.
  resolveStage('stage!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(seen).toEqual([]) // deferred — gate not open

  // Resolve sibling — gate opens; deferred commit fires.
  resolveSibling('sibling!')
  await new Promise((r) => queueMicrotask(() => r(undefined)))
  flush()
  expect(seen).toEqual(['stage!'])

  dispose()
})
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm exec vitest run test/effect-stages.test.ts -t "defers when inside"`
Expected: FAIL — `seen` is `['stage!']` after first flush (commit fired immediately, not deferred).

- [ ] **Step 3: Rewrite `stagedEffect` with split compute/commit**

Replace the implementation:

```ts
import { computed as r3Computed, unwatched, type Computed as R3Computed } from 'r3'
import { computed } from './computed'
import { NotReadyYet, use } from './async'
import { findLoadingScope, getOwner, registerWithOwner, routeError, type BindingController } from './owner'
import { signal } from './signal'
import { markUsedInBinding, runBindingCompute } from './transition-tracker'

function stagedEffect(
  stages: Array<(value: unknown) => unknown>,
  commit: (value: unknown) => void,
): void {
  if (stages.length === 0) {
    throw new Error('effect: staged form requires at least one stage')
  }
  const pipeline = (computed as unknown as (
    ...s: Array<(value: unknown) => unknown>
  ) => () => unknown)(...stages)

  const myOwner = getOwner()
  const [kick, setKick] = signal(0)
  let kickCount = 0
  let suspendedOn: Promise<unknown> | null = null
  let controller: BindingController | null = null

  const ensureController = (): BindingController | null => {
    if (controller !== null) return controller
    const scope = findLoadingScope(myOwner)
    if (scope === null) return null
    controller = scope.register()
    return controller
  }

  const body = () => {
    kick()
    let value: unknown
    let engagedTransition = false
    try {
      const computeResult = runBindingCompute(() => use(pipeline))
      value = computeResult.value
      engagedTransition = computeResult.engagedTransition
    } catch (e) {
      if (e instanceof NotReadyYet) {
        const alreadySuspendedOnSame = suspendedOn === e.promise
        suspendedOn = e.promise
        if (!alreadySuspendedOnSame) {
          const p = e.promise
          const rerun = () => {
            if (suspendedOn === p) {
              suspendedOn = null
              setKick(++kickCount)
            }
          }
          p.then(rerun, rerun)
        }
        ensureController()?.report({ status: 'throwing' })
        return
      }
      routeError(myOwner, e)
      return
    }
    suspendedOn = null
    // Build the commit closure. It runs the user's commit with the resolved value.
    const userCommitFn = (): void => commit(value)
    // Route via existing-controller, deferOrCommit (if engaged + pending), or immediate.
    const scope = findLoadingScope(myOwner)
    if (controller !== null) {
      controller.report({ status: 'ready', commit: userCommitFn })
    } else if (engagedTransition && scope !== null && scope.pending()) {
      scope.deferOrCommit(userCommitFn)
    } else {
      userCommitFn()
    }
  }

  const node = r3Computed(body)
  registerWithOwner({
    dispose: () => {
      unwatched(node as R3Computed<unknown>)
      controller?.unregister()
      controller = null
    },
  })
}
```

(Note: this duplicates a lot of `singleArgEffect`'s structure. Acceptable for v1; a future cleanup could extract a `gatedEffectCore` shared between `singleArgEffect` and `stagedEffect`. Tracking as a follow-up.)

The `silenceUnusedImport` warning on `markUsedInBinding` may appear — remove that import if not used by `stagedEffect` directly (it's called by `use()` internally, not by us).

- [ ] **Step 4: Run all tests**

Run: `pnpm exec vitest run`
Expected: PASS — the new boundary-defer test passes; all 243+ pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/effect.ts test/effect-stages.test.ts
git commit -m "feat(effect): staged effect commit defers under <Loading> atomic-commit gather"
```

---

## Task 4: Add error-routing tests

**Files:**
- Modify: `test/effect-stages.test.ts`

- [ ] **Step 1: Add tests for error paths**

Append:

```ts
import { catchError } from '../src/owner'

test('throw from a stage routes to nearest catchError', () => {
  createRoot(() => {
    let caught: unknown = null
    catchError(
      () => {
        effect(
          [() => { throw new Error('stage-fail') }],
          () => { /* never reached */ },
        )
      },
      (e) => { caught = e },
    )
    expect((caught as Error).message).toBe('stage-fail')
  })
})

test('throw from commit routes to nearest catchError', () => {
  createRoot(() => {
    let caught: unknown = null
    catchError(
      () => {
        effect(
          [() => 'ok'],
          () => { throw new Error('commit-fail') },
        )
      },
      (e) => { caught = e },
    )
    expect((caught as Error).message).toBe('commit-fail')
  })
})

test('disposal stops the staged effect from firing further commits', () => {
  createRoot((dispose) => {
    const seen: number[] = []
    const [n, setN] = signal(1)
    effect([() => n() * 10], (v) => seen.push(v))
    expect(seen).toEqual([10])
    setN(2)
    expect(seen).toEqual([10, 20])
    dispose()
    setN(3)
    expect(seen).toEqual([10, 20]) // no further commits
  })
})
```

- [ ] **Step 2: Run**

Run: `pnpm exec vitest run test/effect-stages.test.ts`
Expected: PASS — all error/disposal tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/effect-stages.test.ts
git commit -m "test(effect-stages): error routing + disposal"
```

---

## Task 5: Update `docs/follow-ups.md`

**Files:**
- Modify: `docs/follow-ups.md`

- [ ] **Step 1: Close the "deferred to Plan C" follow-up**

Find the entry (added in Plan B Task 8):

```markdown
- **(later) `effect()` stages with explicit commit terminator.** ... Designed but deferred to a Plan C ...
  Source: Plan B design discussion.
```

Replace it with an "Already addressed" entry. Add to the "Already addressed" section:

```markdown
- ~~`effect()` stages with explicit commit terminator (Plan C).~~ Landed in commits `<T1>`–`<T4>` (substitute actual SHAs). New `effect([...stages], commit)` overload composes `computed(...stages)` for the pipeline and wraps it in a gated effect loop that splits compute (`use(pipeline)`) from commit (user's callback). Commit routes through `scope.deferOrCommit` when inside a pending `<Loading>`, so staged-effect commits flush atomically with sibling DOM bindings. See `docs/superpowers/specs/2026-05-18-effect-stages-design.md`.
```

Remove the original "Open" entry above.

Also note the new "duplication between singleArgEffect and stagedEffect" follow-up. Add to "Architectural notes" Open section:

```markdown
- **(later) Extract shared `gatedEffectCore` between `singleArgEffect` and `stagedEffect`.** Plan C's `stagedEffect` duplicates the kick/suspendedOn/controller plumbing from `singleArgEffect` — the difference is just the body (single-arg runs `fn` directly; staged runs `use(pipeline)` then routes a `commit(value)` callback). A shared helper that takes a `runCompute` and `runCommit` pair would deduplicate, at the cost of one more layer of indirection. Defer until a third user emerges (e.g., generator-fn JSX bindings — see existing follow-up).
  Source: Plan C Task 3.
```

- [ ] **Step 2: Commit**

```bash
git add docs/follow-ups.md
git commit -m "docs(follow-ups): close Plan C; record gatedEffectCore extraction follow-up"
```

---

## Verification

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```

Expected:
- Typecheck clean.
- All tests pass (243+ existing + new staged-effect tests).
- New `effect([...stages], commit)` form works for sync, async, multi-stage, reactive-update, error, dispose, and boundary-defer scenarios.

---

## Out of scope

- Generic "stages on any reactive primitive" abstraction. Stay specific to effects.
- Extracting `gatedEffectCore` — tracked as a follow-up; defer until a third user surfaces.
- `effect.then(commit)` fluent form. The positional `effect([...stages], commit)` form is the only new surface.
- Multiple commits per pipeline (a pipeline has exactly one terminator).
- Touching `computed`'s API.

# pulse/core — Error Boundaries (Plan 2d)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `catchError(fn, handler)` — a Solid-style error boundary built on Plan 2c's `Owner`. Reactive nodes created inside `catchError` route their synchronous throws and `reuse-value` async rejections to the handler via walk-up of the owner chain. A throwing node stays alive at its previous good value (frozen); recovery is user-managed.

**Architecture:** `Owner` gains two fields — `parent: Owner | null` and `errorHandler: ((e: unknown) => void) | null`. `catchError(fn, handler)` creates a *child* owner of `currentOwner`, sets the handler, registers the child as a disposable child of the parent (so parent disposal cascades), and runs `fn` with the child as ambient — wrapping `fn` itself in `try/catch` so synchronous throws inside `fn` are routed too. Effect and computed wrappers capture their owner at creation; on a non-`NotReadyYet` throw, an internal `routeError(start, error)` helper walks the chain via `parent` links, invokes the nearest `errorHandler`, and (if the handler itself throws) continues walking past it. Computed wrappers additionally track a `lastGoodValue` so that a routed throw doesn't propagate `undefined` to downstream subs — the throwing node's r3 value stays frozen at the last value it successfully produced.

**Tech Stack:** TypeScript (strict), Vitest, r3. Builds on Plan 1 (sync foundation), Plan 2a (per-node async edge), Plan 2b (generator/async pipelines), Plan 2c (ownership).

**Scope notes — what this plan deliberately does NOT do:**
- **DOM layer / `<ErrorBoundary>` JSX component** (Plan 3). This plan provides the primitive `catchError`; DOM ergonomics come later.
- **Automatic recovery.** Handler is observational; the user manages error state externally (typically via a `signal<Error | null>`). No built-in "reset" primitive.
- **A `dispose` handle from `catchError`.** Cleanup follows the owner tree: `catchError`'s sub-owner is parented to `currentOwner`, so the parent's `dispose()` cascades. `catchError` itself returns `fn`'s synchronous return value (or `undefined` if `fn` threw and the handler caught).
- **Catching `NotReadyYet`.** Suspension is NOT an error — `NotReadyYet` passes through `routeError` untouched and is handled by the existing per-effect suspension machinery.
- **Per-owner Context** (`useContext`) — Plan 3 may add it.
- **Errors thrown inside `createRoot`'s callback before `catchError` is reached.** No boundary catches those (and `createRoot` doesn't auto-catch). Propagates to caller, as today.

---

## File structure

| File | Responsibility | This plan |
|------|----------------|-----------|
| `src/owner.ts` | Extend `Owner` with `parent` + `errorHandler`; add internal `routeError`; add public `catchError` | **Modify** (Task 1) |
| `src/effect.ts` | Capture `myOwner` at creation; route on non-`NotReadyYet` throw | **Modify** (Task 2) |
| `src/computed.ts` | Capture `myOwner` per stage; route on throw; track `lastGoodValue` to freeze the throwing node's r3 value | **Modify** (Task 2) |
| `src/index.ts` | Export `catchError` | **Modify** (Task 3) |
| `test/owner.test.ts` | Append: `catchError` direct usage, nested boundaries, handler-throws-escalates, disposal cascade | **Modify** (Task 1) |
| `test/effect.test.ts` | Append: owned effect's throw routes to handler; unhandled throws still propagate | **Modify** (Task 2) |
| `test/computed.test.ts` | Append: owned computed's throw routes to handler; `lastGoodValue` is preserved; async-stage rejection routes via stash | **Modify** (Task 2) |
| `test/integration-error-boundary.test.ts` | End-to-end: signals + computed + effect + `catchError`, handler observes error, recovery via signal | **Create** (Task 3) |

---

## Task 1: Owner extension + `routeError` + `catchError`

**Files:**
- Modify: `src/owner.ts`
- Test: `test/owner.test.ts` (append)

Extend `Owner` with the new fields, add the internal `routeError` walk-up helper, and add the public `catchError` primitive. No wiring of effects/computeds yet — that is Task 2.

Follow TDD.

### Step 1: Append failing tests to `test/owner.test.ts`

Add `catchError` to the existing `../src/owner` import (alongside `createRoot`, `getOwner`, `onCleanup`, `runWithOwner`). Then append these tests at the end of the file:

```ts
test('catchError invokes the handler on a synchronous throw inside fn', () => {
  const errors: unknown[] = []
  const result = catchError(
    () => { throw new Error('boom') },
    (e) => errors.push(e),
  )
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('boom')
  expect(result).toBeUndefined() // fn threw, no return value
})

test('catchError returns fn return value when fn does not throw', () => {
  const result = catchError(() => 42, () => {})
  expect(result).toBe(42)
})

test('nested catchError: inner handler catches its own subtree', () => {
  const inner: unknown[] = []
  const outer: unknown[] = []
  catchError(() => {
    catchError(
      () => { throw new Error('inner') },
      (e) => inner.push(e),
    )
  }, (e) => outer.push(e))
  expect(inner).toHaveLength(1)
  expect(outer).toHaveLength(0) // outer NOT involved
})

test('handler that throws escalates to the next outer boundary', () => {
  const outer: unknown[] = []
  catchError(() => {
    catchError(
      () => { throw new Error('inner') },
      () => { throw new Error('re-thrown by inner handler') },
    )
  }, (e) => outer.push(e))
  expect(outer).toHaveLength(1)
  expect((outer[0] as Error).message).toBe('re-thrown by inner handler')
})

test('unhandled throw (no boundary) propagates', () => {
  expect(() => {
    catchError(
      () => { throw new Error('inner') },
      () => { throw new Error('escalated') },
    )
  }).toThrow('escalated')
})

test('catchError sub-owner is disposed when its parent root is disposed', () => {
  const log: string[] = []
  createRoot((dispose) => {
    catchError(() => {
      onCleanup(() => log.push('inner cleanup'))
    }, () => {})
    onCleanup(() => log.push('outer cleanup'))
    dispose()
  })
  // Bottom-up: inner sub-owner disposed first, then outer's own cleanups.
  expect(log).toEqual(['inner cleanup', 'outer cleanup'])
})
```

### Step 2: Run the tests — they must fail

Run: `pnpm test -- test/owner.test.ts`
Expected: FAIL — `catchError` is not exported from `../src/owner`.

### Step 3: Modify `src/owner.ts`

Read the current `src/owner.ts`. Apply these changes:

(a) Extend the `Owner` interface — add `parent` and `errorHandler` fields:

```ts
export interface Owner {
  /** The parent owner in the lifecycle tree, or `null` for a root. */
  readonly parent: Owner | null
  /** Optional error handler (set by `catchError`). When a reactive node owned
   *  by this owner (or a descendant) throws, the throw walks up via `parent`
   *  links to find the nearest handler. */
  readonly errorHandler: ((error: unknown) => void) | null
  /** Disposers for owned reactive nodes (effects, computeds) and sub-owners. */
  readonly children: Array<{ dispose: () => void }>
  /** Owner-level cleanup callbacks registered via `onCleanup` outside any r3 context. */
  readonly cleanups: Disposable[]
  /** True once this owner has been disposed. Use-after-dispose throws. */
  disposed: boolean
}
```

(b) Update `newOwner()` to accept an optional parent and handler. It currently reads:

```ts
function newOwner(): Owner {
  return { children: [], cleanups: [], disposed: false }
}
```

Change to:

```ts
function newOwner(
  parent: Owner | null = null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
  return { parent, errorHandler, children: [], cleanups: [], disposed: false }
}
```

(c) Add the internal `routeError` helper. Place this **after** `newOwner` and **before** `getOwner`:

```ts
/**
 * Walk up the owner chain from `start`, invoking the first `errorHandler`
 * encountered. If the handler itself throws, continue walking from that
 * owner's `parent` with the new error. If no handler eventually catches,
 * the final error is re-thrown.
 *
 * Internal: called by `effect`/`computed` wrappers on a non-`NotReadyYet` throw.
 */
export function routeError(start: Owner | null, error: unknown): void {
  let owner = start
  while (owner !== null) {
    const handler = owner.errorHandler
    if (handler !== null) {
      try {
        handler(error)
        return // handled
      } catch (newError) {
        owner = owner.parent
        error = newError
        continue
      }
    }
    owner = owner.parent
  }
  // No handler caught — re-throw the final error.
  throw error
}
```

(d) Add the public `catchError` function. Place it **after** `createRoot` (or near it):

```ts
/**
 * Create a sub-owner with an error handler attached, then run `fn` with the
 * sub-owner as ambient. Reactive nodes (effects, computeds) created inside
 * `fn` parent to this sub-owner; when they throw a non-`NotReadyYet` error,
 * the throw walks up the owner chain and the nearest handler is invoked.
 *
 * The sub-owner is registered as a disposable child of `currentOwner` — so
 * the parent's `dispose()` cascades down to it automatically. If called
 * outside any root, the sub-owner has no parent and lives until GC.
 *
 * `fn` itself is wrapped in `try/catch`: synchronous throws inside `fn` are
 * also routed through `routeError`. Returns `fn`'s return value, or
 * `undefined` if `fn` threw and the handler caught.
 */
export function catchError<T>(
  fn: () => T,
  handler: (error: unknown) => void,
): T | undefined {
  const sub = newOwner(currentOwner, handler)
  if (currentOwner !== null) {
    if (currentOwner.disposed) {
      throw new Error('cannot create a sub-owner inside a disposed owner')
    }
    currentOwner.children.push({ dispose: () => disposeOwner(sub) })
  }
  return runWithOwner(sub, () => {
    try {
      return fn()
    } catch (e) {
      routeError(sub, e)
      return undefined
    }
  })
}
```

(Leave `disposeOwner`, `getOwner`, `runWithOwner`, `registerWithOwner`, `onCleanup` unchanged.)

### Step 4: Run the tests — they must pass

Run: `pnpm test -- test/owner.test.ts`
Expected: PASS — all owner tests (10 prior from Plan 2c + 6 new = 16).

### Step 5: Run the full suite + typecheck

Run: `pnpm test`
Expected: PASS — all tests (75 prior + 6 new = 81).

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git add -A
git commit -m "feat(owner): extend with parent + errorHandler; add catchError + routeError"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 2: Wire effect + computed wrappers to route on throw

**Files:**
- Modify: `src/effect.ts` — capture `myOwner` at creation; route on non-`NotReadyYet` throw.
- Modify: `src/computed.ts` — capture `myOwner` per stage; route on throw; track `lastGoodValue` to freeze the throwing stage's r3 value.
- Test: `test/effect.test.ts` (append) and `test/computed.test.ts` (append).

Each wrapper, on creation, captures the ambient owner. When the body throws something other than `NotReadyYet`, the wrapper calls `routeError(myOwner, error)`. If `routeError` returns normally (a handler caught), the wrapper resumes — for effects, the body simply doesn't complete; for computeds, the wrapper returns the cached `lastGoodValue` so r3 sees no value change and downstream subs aren't invalidated. If `routeError` re-throws (no handler caught), the throw propagates out of the wrapper exactly as before.

### Step 1: Write the failing tests

#### Append to `test/effect.test.ts`

Add `catchError` to the existing `../src/owner` import. Append these tests at the end:

```ts
test('an effect created inside catchError routes its throw to the handler', () => {
  setScheduler(syncScheduler(flush))
  const errors: unknown[] = []
  catchError(() => {
    effect(() => { throw new Error('effect failed') })
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('effect failed')
})

test('an effect created outside any catchError still propagates uncaught (Plan 2a behaviour preserved)', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('uncaught') })
  }).toThrow('uncaught')
})

test('an effect re-throwing after a signal change routes the new throw too', () => {
  setScheduler(syncScheduler(flush))
  const errors: unknown[] = []
  const trigger = signal(0)
  catchError(() => {
    effect(() => {
      const v = trigger()
      if (v > 0) throw new Error(`fail ${v}`)
    })
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(0)
  setSignal(trigger, 1)
  expect(errors).toHaveLength(1)
  setSignal(trigger, 2)
  expect(errors).toHaveLength(2)
  expect((errors[1] as Error).message).toBe('fail 2')
})
```

#### Append to `test/computed.test.ts`

Add `catchError` to the existing `../src/owner` import. Append these tests at the end:

```ts
test('a computed created inside catchError routes its throw to the handler', () => {
  const errors: unknown[] = []
  catchError(() => {
    const c = computed(() => { throw new Error('compute failed') })
    // Read it — that's what triggers the throw to surface (computeds compute on read).
    c()
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('compute failed')
})

test('after a caught throw, the computed is frozen at its previous good value', () => {
  setScheduler(syncScheduler(flush))
  const trigger = signal(0)
  let computeCount = 0
  catchError(() => {
    const c = computed(() => {
      computeCount++
      const t = trigger()
      if (t === 1) throw new Error('boom')
      return t * 10
    })
    // Read the computed inside an effect so the chain is exercised.
    const observed: unknown[] = []
    effect(() => { observed.push(c()) })
    expect(observed).toEqual([0]) // t=0, c=0
    setSignal(trigger, 1) // body throws; handler catches; lastGoodValue (0) preserved
    expect(observed).toEqual([0]) // unchanged — c's r3 value still 0
    setSignal(trigger, 2) // recovers
    expect(observed).toEqual([0, 20])
  }, () => {})
})

test('a computed throw outside any catchError still propagates uncaught', () => {
  const c = computed(() => { throw new Error('uncaught') })
  expect(() => c()).toThrow('uncaught')
})
```

### Step 2: Run the tests — they must fail

Run: `pnpm test -- test/effect.test.ts test/computed.test.ts`
Expected: FAIL — the new tests fail because the wrappers do not yet route on throw; the existing `throw e` lines propagate uncaught.

### Step 3: Modify `src/effect.ts`

Read the current `src/effect.ts`. Apply these changes:

(a) Add this import alongside the existing ones:

```ts
import { getOwner, routeError } from './owner'
```

(b) In the `effect` function, capture `myOwner` at the very top (before constructing `kick`/`body`):

```ts
export function effect(fn: () => void): void {
  const myOwner = getOwner()
  const kick = signal(0)
  // ... (everything else as before, until the catch block)
```

(c) In the `body` function's `catch` block, replace the line `throw e` (the genuine-error rethrow) with `routeError(myOwner, e)`. The catch should read:

```ts
    } catch (e) {
      if (e instanceof NotReadyYet) {
        // ... (unchanged suspension handling)
      }
      routeError(myOwner, e) // throws if no handler catches
    }
```

(Note: `routeError` either throws (re-throwing the final error if unhandled) or returns normally (handled). If it returns, the catch block exits and the effect body simply ends — no propagation, no re-run scheduled by the throw itself.)

### Step 4: Modify `src/computed.ts`

Read the current `src/computed.ts`. Apply these changes:

(a) Add this import alongside the existing ones:

```ts
import { getOwner, routeError } from './owner'
```

(b) In `makeStageNode`, capture `myOwner` and initialise `lastGoodValue` at the top of the function (before constructing `kick`/`suspendedOn`/etc.):

```ts
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): { accessor: Signal<unknown>; r3Node: R3Computed<unknown> } {
  const myOwner = getOwner()
  let lastGoodValue: unknown = undefined
  const kick = signal(0)
  // ... (everything else as before, until the r3Computed callback)
```

(c) The minimal change to the existing `r3Node = r3Computed(() => …)` block: wrap the entire body in `try/catch` for routing, and update `lastGoodValue` at the two **settled non-promise** return sites. Do not reorder Plan 2c's stash-validity logic; do not extract helpers. The result:

```ts
  const r3Node = r3Computed(() => {
    try {
      kick() // depend on the kick signal so a settled promise can re-trigger this stage

      // Read input first so we can validate (or discard) a pending stash.
      let input: unknown = undefined
      if (inputAccessor !== null) {
        input = inputAccessor()
        if (isPromise(input)) {
          // The previous stage is suspended; mirror its state.
          stashedResolution = null
          suspendedOn = null
          return input // (do NOT update lastGoodValue — value is a propagating promise)
        }
      }

      // Consume a stashed resolution IFF the input that produced it still matches.
      if (stashedResolution !== null) {
        if (Object.is(input, suspendedInput)) {
          const r = stashedResolution
          stashedResolution = null
          suspendedOn = null
          if (r.kind === 'rejected') throw r.reason
          lastGoodValue = r.value
          return r.value
        }
        // Input changed — discard the stale stash and fall through.
        stashedResolution = null
      }

      const outcome = runStage(stage, input)
      if (outcome.pending) {
        const p = outcome.promise
        if (suspendedOn !== p) {
          suspendedOn = p
          suspendedInput = input
          const rerun = () => {
            if (suspendedOn === p) {
              if (resumeKind === 'reuse-value') {
                const state = track(p)
                if (state.status === 'fulfilled') {
                  stashedResolution = { kind: 'fulfilled', value: state.value }
                } else if (state.status === 'rejected') {
                  stashedResolution = { kind: 'rejected', reason: state.reason }
                }
              }
              suspendedOn = null
              setSignal(kick, ++kickCount)
            }
          }
          p.then(rerun, rerun)
        }
        return p // (do NOT update lastGoodValue — value is a pending promise)
      }

      suspendedOn = null
      lastGoodValue = outcome.value
      return outcome.value
    } catch (e) {
      routeError(myOwner, e) // throws if no handler catches
      // Handler caught — return the cached last-good value so r3 sees no value
      // change → no propagation to downstream subs → throwing stage stays frozen.
      return lastGoodValue
    }
  })
```

(Note: the `try` opens immediately after the function signature; the existing rerun-registration block stays inside the try untouched; only two `lastGoodValue = …` assignments are added at the two settled non-promise exits, and the entire body is wrapped by the `try/catch`. Plan 2c's input-check-first / stash-validity / suspend-registration logic is preserved exactly.)

(d) Confirm the `r3Nodes` collection and `registerWithOwner` block immediately after the for-loop is unchanged. Plan 2c's per-pipeline disposer logic should remain intact.

### Step 5: Run the tests to verify they pass

Run: `pnpm test -- test/effect.test.ts test/computed.test.ts test/owner.test.ts`
Expected: PASS — all effect, computed, and owner tests.

### Step 6: Run the full suite + typecheck

Run: `pnpm test`
Expected: PASS — no regressions. Total ~87 tests (81 after Task 1 + 3 new effect + 3 new computed).

Run: `pnpm typecheck`
Expected: clean.

### Step 7: Commit

```bash
git add -A
git commit -m "feat: route effect/computed throws via owner chain; freeze last-good value"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Task 3: Expose `catchError` + integration test

**Files:**
- Modify: `src/index.ts` — add `catchError` to the owner re-export.
- Test: `test/integration-error-boundary.test.ts`

Expose the public API and add an end-to-end test under the default microtask scheduler.

### Step 1: Write the failing integration test — create `test/integration-error-boundary.test.ts`

```ts
import { afterEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  createRoot,
  effect,
  flush,
  microtaskScheduler,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../src/index'

afterEach(() => setScheduler(microtaskScheduler(flush)))

test('end-to-end: signal -> throwing computed -> effect -> catchError catches and user observes via signal', () => {
  setScheduler(syncScheduler(flush))
  const id = signal(0)
  const errorState = signal<Error | null>(null)
  const renders: string[] = []

  createRoot(() => {
    catchError(() => {
      const name = computed(() => {
        const i = id()
        if (i < 0) throw new Error(`bad id: ${i}`)
        return `user-${i}`
      })
      effect(() => {
        const e = errorState()
        if (e !== null) {
          renders.push(`ERROR: ${e.message}`)
        } else {
          renders.push(name())
        }
      })
    }, (e) => setSignal(errorState, e as Error))
  })

  expect(renders).toEqual(['user-0']) // initial

  // User-driven failure: setting id to -1 makes the computed throw.
  setSignal(id, -1)
  // Handler caught; error signal was set; effect re-ran via error signal change.
  expect(renders).toEqual(['user-0', 'ERROR: bad id: -1'])

  // User-driven recovery: clear error state and set a valid id.
  setSignal(errorState, null)
  setSignal(id, 5)
  expect(renders[renders.length - 1]).toBe('user-5')
})

test('uncaught throw still propagates outside any catchError', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('uncaught') })
  }).toThrow('uncaught')
})
```

### Step 2: Run the test to verify it fails

Run: `pnpm test -- test/integration-error-boundary.test.ts`
Expected: FAIL — `catchError` is not yet exported from `../src/index`.

### Step 3: Modify `src/index.ts`

Read the current `src/index.ts`. Find the `./owner` re-export block:

```ts
export {
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  type Owner,
} from './owner'
```

Add `catchError` to it (alphabetically):

```ts
export {
  catchError,
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  type Owner,
} from './owner'
```

Leave all other exports unchanged.

### Step 4: Run the test to verify it passes

Run: `pnpm test -- test/integration-error-boundary.test.ts`
Expected: PASS — 2 passed.

### Step 5: Run the full suite + typecheck

Run: `pnpm test`
Expected: PASS — all test files.

Run: `pnpm typecheck`
Expected: clean.

### Step 6: Commit

```bash
git add -A
git commit -m "feat: expose catchError; add error-boundary integration test"
```

NO `Co-Authored-By` line. NO AI signature.

---

## Done — definition of completion

After Task 3:
- `pnpm test` passes all test files; `pnpm typecheck` is clean.
- pulse exposes `catchError(fn, handler)` — a Solid-style error boundary built on Plan 2c's `Owner`.
- Reactive nodes inside a `catchError` scope route their non-`NotReadyYet` throws (sync stage throws, effect-body throws, async `reuse-value` rejections) to the handler via owner-chain walk-up.
- Handler-throws-escalate to the next outer boundary.
- A throwing computed stays frozen at its `lastGoodValue` — downstream subs are not invalidated by the failed run.
- Plan 1, 2a, 2b, 2c tests all unchanged and still passing.

**Next:** Plan 3 — `pulse/dom`. Components as pure sync DOM factories; control flow (`Show`/`For`); bindings (sync bare + async render-fn form / `use`); reference keying; uses ownership for component cleanup and error boundaries for subtree fallbacks. See the design spec: `docs/superpowers/specs/2026-05-14-pulse-design.md`.

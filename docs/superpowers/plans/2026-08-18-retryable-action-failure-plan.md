# Retryable Action Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `action()` reports failure through a reactive handle instead of a rejecting promise, and a failed action is discovered by the nearest `<Failed>` boundary automatically, the same way a failed binding already is.

**Architecture:** Two independent prerequisite pieces (event handlers capturing owner context; `action()` returning a handle instead of a promise that rejects) land first, then a third task wires the handle into the existing `<Failed>` boundary registration mechanism, then the demo is migrated to delete its hand-rolled retry UI.

**Tech Stack:** TypeScript, r3 (the pinned reactive core), vitest (`unit` project for plain `.test.ts` files, `dom` project running real Chromium for `test/dom/**`), Playwright for the example app's end-to-end suite.

**Spec:** `docs/superpowers/specs/2026-08-18-retryable-failure-propagation-design.md`

## Global Constraints

- `action()`'s return type changes for all three body shapes (generator, async function, sync function) from `void | Promise<void>` (which rejects on failure) to `ActionHandle` (which never rejects). This is a deliberate breaking change to a tested contract, not an addition alongside the old one.
- `ActionHandle` has three named fields — `settled`, `error`, `retry` — not a tuple. Decided during spec review: the three members are read independently at different times and places, unlike `signal`'s `[accessor, setter]`, which are almost always used together.
- `retry(): void` — no return value.
- `retry()` always re-runs the action's body from scratch, every time. There is no per-`yield*` retry and no replay of partially-succeeded steps — that mechanism was designed and then deliberately cut during spec review (see the spec's "What was cut, and why it can come back later" section). Do not build it as part of this plan.
- Boundary registration reuses `src/owner.ts`'s existing `BindingController` / `FailedScope` / `findNearestFailedScope` mechanism exactly as it exists today. It does **not** touch `src/failure.ts`'s `FailureEntry` registry — that is a different, unrelated registration path built for `computed`/`signal` stages.
- A failed action reports `source: null` to its `BindingController` — there is no failure-tracked accessor behind an action's failure the way there is for a binding that read a parked `computed`/`signal` failure.
- The `examples/todo-async` migration (Task 4) accepts that a failed mutation now replaces the *entire* guarded subtree with `<Failed>`'s fallback, not just the affected row — this was confirmed during planning, not an oversight. A more granular, per-row failure boundary is out of scope and tracked separately in `docs/follow-ups.md`.

---

### Task 1: Event handlers capture and restore owner context

**Files:**
- Modify: `src/dom/bindings.ts:255-270` (the `on:` branch inside `bindProp`)
- Test: `test/dom/binding-events.test.ts`

**Interfaces:**
- Consumes: `getOwner`, `runWithOwner` — both already imported in `src/dom/bindings.ts` today, no new import needed.
- Produces: nothing new is exported. The observable change is that `getOwner()` called from inside an `on:` event handler now returns the owner that was ambient when the handler was bound, instead of `null`. Every later task in this plan depends on this.

- [ ] **Step 1: Write the failing test**

Add to `test/dom/binding-events.test.ts`:

```ts
test('on:click captures the owner at bind time, so onCleanup called from inside the handler attaches to it', () => {
  let cleaned = false
  let el!: HTMLButtonElement
  const dispose = createRoot((d) => {
    el = h('button', {
      'on:click': () => {
        onCleanup(() => {
          cleaned = true
        })
      },
    }) as HTMLButtonElement
    document.body.append(el)
    return d
  })

  el.click() // registers the cleanup against the root captured when the handler was bound
  expect(cleaned).toBe(false)

  dispose()
  expect(cleaned).toBe(true)
})
```

Add `onCleanup` to the existing `import { createRoot } from '../../src/index'` line at the top of the file, so it reads:

```ts
import { createRoot, onCleanup } from '../../src/index'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/dom/binding-events.test.ts`
Expected: FAIL — `cleaned` is `false` after `dispose()`. This is because `onCleanup`, called with no ambient owner (the click fires outside any r3 context or owner scope today), silently does nothing: `src/owner.ts`'s `onCleanup` only registers against `currentOwner` when it is non-null, and today's `on:click` handler runs with `currentOwner` at whatever the module-level ambient value happens to be at click time — not the owner that was live when the button was created.

- [ ] **Step 3: Capture and restore the owner around the handler call**

In `src/dom/bindings.ts`, find the `on:` branch inside `bindProp` (currently around lines 261-270):

```ts
  // on:event — direct addEventListener; the handler is not reactive
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    warnIfOrphaned('event listener')
    const handler = value as EventListener
    el.addEventListener(event, handler)
    onCleanup(() => el.removeEventListener(event, handler))
    return
  }
```

Replace it with:

```ts
  // on:event — direct addEventListener, wrapped to restore the owner that was
  // ambient when this binding was created. Without this, code run from inside
  // the handler (onCleanup, action()'s boundary discovery) has no owner to
  // reach, because a DOM event fires outside any owner context entirely.
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    warnIfOrphaned('event listener')
    const capturedOwner = getOwner()
    const handler = value as EventListener
    const wrapped = (e: Event) => runWithOwner(capturedOwner, () => handler(e))
    el.addEventListener(event, wrapped)
    onCleanup(() => el.removeEventListener(event, wrapped))
    return
  }
```

No import changes are needed for this step: `src/dom/bindings.ts` already imports `createSubOwner`, `disposeOwner`, `findBoundaryScope`, `getOwner`, `onCleanup`, `runWithOwner`, `type BindingController`, and `type Owner` from `'../owner'` at the top of the file — `getOwner` and `runWithOwner` are both already in that list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/dom/binding-events.test.ts`
Expected: PASS — all four tests in the file, including the new one.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm test`
Expected: all test files pass, same count as before this task (445 passed, 1 skipped, before this task's new test is added — 446 passed after).

Run: `pnpm typecheck`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-events.test.ts
git commit -m "fix: capture and restore owner context around on: event handlers"
```

---

### Task 2: `action()` returns a non-throwing `ActionHandle`

**Files:**
- Modify: `src/scope.ts` (the `action` export and `driveGeneratorAction`)
- Modify: `src/index.ts` (add `type ActionHandle` to the existing `action` export line)
- Modify: `test/async-action.test.ts` (rewrite every test that currently asserts the rejecting-promise contract; add new tests for the handle's own behaviour)

**Interfaces:**
- Consumes: `isGeneratorFunction` (already imported in `src/scope.ts` from `./is-generator-function`), `isPromise` (already imported from `./is-promise`), `getContext`/`stabilize`/`signal as r3Signal`/`read as r3Read`/`setSignal as r3SetSignal` (already imported from `r3`), `Accessor` (type-only import needed from `./signal` — safe, `src/signal.ts` already imports from `src/scope.ts`, so only a `import type` avoids a runtime cycle), `createScope`/`getCurrentScope`/`runInScope`/`commit`/`discard`/`type Scope` (all already defined in `src/scope.ts` itself).
- Produces:
  ```ts
  export interface ActionHandle {
    readonly settled: Promise<void>
    readonly error: Accessor<unknown>
    retry(): void
  }
  export function action(body: () => Generator<unknown, void, unknown>): ActionHandle
  export function action(body: () => Promise<void>): ActionHandle
  export function action(body: () => void): ActionHandle
  ```
  Task 3 modifies this task's `action` implementation to add boundary registration; it does not change this shape.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `test/async-action.test.ts` with:

```ts
import { expect, test } from 'vitest'
import { action, committed, computed, read, signal } from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * TARGET BEHAVIOUR — async actions.
 *
 * An action body may be a generator. The driver resumes it inside the action's
 * scope, so the speculation stays open across a `yield*` and writes made AFTER
 * the await are still speculative. The action commits when the body completes and
 * discards (rolling back every speculative write) when it throws.
 *
 * `action()` returns an ActionHandle rather than a promise that rejects: `settled`
 * resolves either way, and a failure is reported through `error()` instead.
 */

test('an async action holds the speculation open across the await and commits on success', async () => {
  const [name, setName] = signal('alice')
  const save = (v: string) => tick().then(() => v)

  const handle = action(function* () {
    setName('bob') // optimistic write
    const saved: string = yield* read(save('bob')) // the mutation; scope stays open
    setName(`${saved}!`) // a write AFTER the await must still be speculative
  })

  // In flight: committed state is untouched.
  expect(committed(name)).toBe('alice')

  await handle.settled
  // Completed: every write in the body commits together, atomically.
  expect(committed(name)).toBe('bob!')
  expect(name()).toBe('bob!')
  expect(handle.error()).toBeNull()
})

test('an async action rolls back every speculative write when the mutation fails', async () => {
  const [name, setName] = signal('alice')
  const save = () => tick().then<string>(() => Promise.reject(new Error('save failed')))

  const handle = action(function* () {
    setName('bob')
    yield* read(save())
    setName('never') // unreachable
  })

  await handle.settled
  // Discarded: the speculative writes vanish; committed state never moved.
  expect(name()).toBe('alice')
  expect(committed(name)).toBe('alice')
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('save failed')
})

test('derived state follows the speculation across the await', async () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  const save = () => tick()

  const handle = action(function* () {
    setN(5)
    yield* read(save())
    // Resumed inside the scope: the derivation still sees the speculative value.
    expect(doubled()).toBe(10)
    expect(committed(doubled)).toBe(2)
  })

  await handle.settled
  expect(doubled()).toBe(10)
})

// ---- async (non-generator) bodies: the common write-then-await shape ----

test('an async body: the sync prefix is speculative and commits when the mutation resolves', async () => {
  const [name, setName] = signal('alice')
  const handle = action(async () => {
    setName('bob') // sync prefix — runs under the scope
    expect(committed(name)).toBe('alice') // isolated
    await tick() // the mutation
  })
  expect(committed(name)).toBe('alice') // in flight — not committed yet
  await handle.settled
  expect(committed(name)).toBe('bob') // resolved → committed
})

test('an async body rolls back when the mutation rejects', async () => {
  const [name, setName] = signal('alice')
  const handle = action(async () => {
    setName('bob')
    await tick().then(() => Promise.reject(new Error('save failed')))
  })
  await handle.settled
  expect(name()).toBe('alice') // rolled back
  expect(committed(name)).toBe('alice')
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('save failed')
})

// SHARP EDGE — documented behaviour, not a bug to fix.
//
// In an ASYNC body only the synchronous prefix runs under the scope. After the
// first `await` the async function has returned to us and the ambient scope has
// unwound, so the continuation runs with the scope back at root: a write there
// lands in COMMITTED state immediately, and the action's later commit then
// promotes the earlier speculative value on top of it — losing the write.
//
// Use a GENERATOR body when you need to write after awaiting (see the tests
// above): pulse drives those resumptions itself and re-enters the scope.
test('SHARP EDGE: a write after an await in an async body escapes the speculation', async () => {
  const [name, setName] = signal('alice')
  const handle = action(async () => {
    setName('bob') // speculative
    await tick()
    setName('after') // NOT speculative — goes straight to committed state
  })
  await handle.settled
  // The post-await write hit committed state, then commit promoted 'bob' over it.
  expect(committed(name)).toBe('bob')
})

test('two concurrent async actions are isolated from each other', async () => {
  const [a, setA] = signal('a0')
  const [b, setB] = signal('b0')
  const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const first = action(function* () {
    setA('a1')
    yield* read(slow(20))
  })
  const second = action(function* () {
    setB('b1')
    yield* read(slow(5))
  })

  await Promise.all([first.settled, second.settled])
  expect(committed(a)).toBe('a1')
  expect(committed(b)).toBe('b1')
})

// ---- ActionHandle-specific behaviour ----

test('a sync body that throws does not throw synchronously; the failure is reported through error()', async () => {
  let ran = false
  const handle = action(() => {
    ran = true
    throw new Error('sync boom')
  })
  expect(ran).toBe(true) // the body did run
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('sync boom')
})

test('retry() re-runs the action from scratch after a failure', async () => {
  const [name, setName] = signal('alice')
  let attempt = 0
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
      return 'bob'
    })

  const handle = action(function* () {
    setName('bob')
    yield* read(save())
  })

  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect(name()).toBe('alice') // rolled back

  handle.retry()
  await handle.settled
  expect(handle.error()).toBeNull()
  expect(committed(name)).toBe('bob')
  expect(attempt).toBe(2)
})

test('settled reflects whichever attempt is current, so reading it again after retry() gives a new promise', async () => {
  let attempt = 0
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
    })

  const handle = action(function* () {
    yield* read(save())
  })

  const first = handle.settled
  await first
  expect(handle.error()).toBeInstanceOf(Error)

  handle.retry()
  const second = handle.settled
  expect(second).not.toBe(first)
  await second
  expect(handle.error()).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/async-action.test.ts`
Expected: FAIL — `action(...)` still returns `void | Promise<void>`, so `handle.settled` and `handle.error` do not exist on the returned value (a `Promise<void>` has no `.settled`/`.error`, and `undefined` for a sync body has neither either). Several tests also fail because a rejected action still throws/rejects instead of resolving `.settled` and reporting through `.error()`.

- [ ] **Step 3: Implement `ActionHandle` and rewrite `action()`**

In `src/scope.ts`, add `Accessor` to the type-only imports at the top of the file. If there is no existing `import type` line for `./signal`, add one:

```ts
import type { Accessor } from './signal'
```

Add this helper near the top of the file, alongside the other small internal helpers (it does not need to be exported):

```ts
/** A tiny reactive cell built on r3's raw signal directly, not pulse's
 *  `signal()` wrapper — `src/signal.ts` imports from this file, so importing
 *  `signal()` back here would be a cycle. Mirrors `makeAccessor`'s top-level
 *  read behaviour (`src/signal.ts`): inside an r3 context, read through it
 *  directly; outside one, stabilize first so the value is never stale. */
function makeErrorCell(): [Accessor<unknown>, (value: unknown) => void] {
  const node = r3Signal<unknown>(null)
  const accessor = (() => {
    if (getContext()) return r3Read(node)
    stabilize()
    return node.value
  }) as Accessor<unknown>
  const setError = (value: unknown) => r3SetSignal(node, value)
  return [accessor, setError]
}
```

Replace the entire `action`/`driveGeneratorAction` section — starting from the doc comment immediately above the first `export function action(body: ...)` overload line, through the closing brace of `driveGeneratorAction` at the end of the file — with:

```ts
export interface ActionHandle {
  /** The currently in-flight attempt's outcome — the initial run, or the most
   *  recent `retry()` if one is running. Never rejects. Read `.settled` again
   *  after calling `retry()` to get the promise for that attempt; the one
   *  returned before `retry()` was called already resolved when the attempt
   *  it belonged to finished. */
  readonly settled: Promise<void>
  /** Reactive: null while healthy or in flight, the rejection reason once the
   *  action has failed and nothing has retried it yet. */
  readonly error: Accessor<unknown>
  /** Re-run the action's body from scratch. */
  retry(): void
}

/**
 * Open a speculative child of the current scope and run `body` under it. Every
 * write inside is speculative until the action commits; a discard rolls them all
 * back. Nested actions parent to the enclosing scope, so their commit promotes to
 * it (two-stage).
 *
 * The body may take three shapes:
 *
 * - **Sync** — commits on return, discards on throw.
 *
 * - **Async** (`async () => …`) — the SYNCHRONOUS PREFIX runs under the scope, and
 *   the action commits or discards when the returned promise settles. This covers
 *   the common optimistic shape: write, then await the mutation.
 *
 *   SHARP EDGE: only the prefix is scoped. After the first `await` the async
 *   function returns to us, so the ambient scope unwinds; the continuation is
 *   scheduled by the engine in a later microtask, where the scope is back to root.
 *   A write made after an `await` therefore lands in COMMITTED state immediately —
 *   and the action's later commit can overwrite it. Use a generator body if you
 *   need to write after awaiting.
 *
 * - **Generator** (`function* () { … yield* read(p) … }`) — fully scoped. Pulse
 *   drives the resumption itself, so it re-enters the scope on every resume and a
 *   write after a `yield*` is still speculative. Commits when the body completes,
 *   discards when it throws.
 *
 * A failure in any shape never becomes a thrown or rejected value the caller has
 * to handle — it is captured and reported through the returned handle's `error`,
 * and `settled` resolves regardless of which way the attempt ended.
 */
export function action(body: () => Generator<unknown, void, unknown>): ActionHandle
export function action(body: () => Promise<void>): ActionHandle
export function action(body: () => void): ActionHandle
export function action(body: () => unknown): ActionHandle {
  const [error, setError] = makeErrorCell()
  let currentSettled: Promise<void>

  const runAttempt = (): Promise<void> => {
    const scope = createScope(getCurrentScope(), 'speculative')
    const attempt = isGeneratorFunction(body)
      ? driveGeneratorAction(scope, body as () => Generator<unknown, void, unknown>)
      : driveNonGeneratorAction(scope, body)
    return attempt.then(
      () => {
        setError(null)
      },
      (e: unknown) => {
        setError(e)
      },
    )
  }

  function retry(): void {
    currentSettled = runAttempt()
  }

  currentSettled = runAttempt()

  return {
    get settled() {
      return currentSettled
    },
    error,
    retry,
  }
}

/** Drive a sync or async (non-generator) action body: run it under `scope`, then
 *  commit on success or discard on failure — either way as a resolved promise
 *  the caller reads through `.then`, never a synchronous throw or a rejection
 *  the caller has to catch. */
function driveNonGeneratorAction(scope: Scope, body: () => unknown): Promise<void> {
  let result: unknown
  try {
    result = runInScope(scope, undefined, body)
  } catch (e) {
    discard(scope)
    return Promise.reject(e)
  }
  if (isPromise(result)) {
    return (result as Promise<unknown>).then(
      () => {
        commit(scope)
      },
      (e: unknown) => {
        discard(scope)
        throw e
      },
    )
  }
  commit(scope)
  return Promise.resolve()
}

/** Drive a generator action body. The await happens OUTSIDE the scope (nothing
 *  writes there); every resume happens INSIDE it, which is what keeps writes made
 *  after a `yield*` speculative. Deliberately not the stage driver: an action body
 *  is an imperative one-shot with side effects, not a memoized derivation, so it
 *  must never re-run from the top — `retry()` above achieves retry by calling
 *  `action()`'s whole flow again, fresh, not by resuming this generator. */
async function driveGeneratorAction(
  scope: Scope,
  body: () => Generator<unknown, void, unknown>,
): Promise<void> {
  try {
    const gen = runInScope(scope, undefined, body)
    let step = runInScope(scope, undefined, () => gen.next())
    while (!step.done) {
      let resumed: unknown
      let failure: unknown
      let failed = false
      try {
        resumed = await step.value
      } catch (e) {
        failed = true
        failure = e
      }
      step = runInScope(scope, undefined, () =>
        failed ? gen.throw(failure) : gen.next(resumed),
      )
    }
    commit(scope)
  } catch (e) {
    discard(scope)
    throw e
  }
}
```

Note `driveGeneratorAction`'s own body is unchanged from what exists today — it still returns a promise that rejects on failure. What changed is that `action()`'s new wrapper (`runAttempt`) now catches that rejection instead of letting it propagate to the caller.

- [ ] **Step 4: Export `ActionHandle`**

In `src/index.ts`, change:

```ts
export { action, committed, onSettled, type SettleOutcome } from './scope'
```

to:

```ts
export { action, committed, onSettled, type ActionHandle, type SettleOutcome } from './scope'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/async-action.test.ts`
Expected: PASS — all 10 tests (7 rewritten from the original file, plus 3 new ones written in Step 1: the sync-throw test, the retry test, and the settled-per-attempt test).

Run: `pnpm test`
Expected: all test files pass.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/scope.ts src/index.ts test/async-action.test.ts
git commit -m "feat: action() returns a non-throwing ActionHandle instead of a promise that rejects"
```

---

### Task 3: `action()` registers a failed attempt with the nearest `<Failed>` boundary

**Files:**
- Modify: `src/scope.ts` (the `action` implementation from Task 2)
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `findNearestFailedScope`, `getOwner`, `onCleanup`, `type BindingController` — none of these are imported in `src/scope.ts` yet as of Task 2 (it currently imports only from `r3`, `./is-generator-function`, and `./is-promise`), so this task adds one new import line from `./owner`. `ActionHandle`, `action` (from Task 2, same file, unchanged shape).
- Produces: no new exports. The observable change is that `action()`'s returned `ActionHandle`, when it fails, shows up in the nearest ambient `<Failed>` boundary's collection (`failedSet`) exactly the way a failed binding already does, and that boundary's `reset()` calls the handle's `retry()`.

- [ ] **Step 1: Write the failing test**

Add to `test/dom/failed.test.tsx`:

```tsx
test('a failed action registers with the nearest <Failed> boundary, and its retry button re-runs it', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let attempt = 0
  const [name, setName] = signal('alice')
  const save = () =>
    tick().then(() => {
      attempt++
      if (attempt === 1) throw new Error('save failed')
      return 'bob'
    })

  function saveToBob() {
    action(function* () {
      setName('bob')
      yield* read(save())
    })
  }

  render(
    () => (
      <Failed
        fallback={(error, reset) => (
          <button data-testid="retry" on:click={reset}>
            {(error as Error).message}
          </button>
        )}
      >
        {() => (
          <button data-testid="save" on:click={saveToBob}>
            save
          </button>
        )}
      </Failed>
    ),
    target,
  )

  target.querySelector('[data-testid="save"]')!.click()
  await tick()
  flush()

  expect(target.querySelector('[data-testid="retry"]')).not.toBeNull()
  expect(name()).toBe('alice') // rolled back — the boundary's fallback is showing

  target.querySelector('[data-testid="retry"]')!.click()
  await tick()
  flush()

  expect(target.querySelector('[data-testid="retry"]')).toBeNull()
  expect(committed(name)).toBe('bob')
  expect(attempt).toBe(2)
})
```

Add `action`, `read`, and `committed` to the existing top-of-file import from `'../../src/index'` in `test/dom/failed.test.tsx` (check the current import list first — `computed`, `effect`, `Failed`, `flush`, `Loading`, `microtaskScheduler`, `render`, `setScheduler`, `signal`, `syncScheduler`, `use` are already there; add the three missing names to the same import statement).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`
Expected: FAIL — clicking "save" never shows a "retry" button, because nothing registers the failed action with the boundary yet. `target.querySelector('[data-testid="retry"]')` is `null` after the first click.

- [ ] **Step 3: Wire boundary registration into `action()`**

In `src/scope.ts`, add `findNearestFailedScope` (and `type BindingController` if not already imported) to the existing import from `'./owner'`, or add a new import line if one does not exist yet:

```ts
import { findNearestFailedScope, getOwner, onCleanup, type BindingController } from './owner'
```

Replace the `action` implementation from Task 2 with:

```ts
export function action(body: () => Generator<unknown, void, unknown>): ActionHandle
export function action(body: () => Promise<void>): ActionHandle
export function action(body: () => void): ActionHandle
export function action(body: () => unknown): ActionHandle {
  const [error, setError] = makeErrorCell()
  const owner = getOwner()
  const failedScope = findNearestFailedScope(owner)
  let controller: BindingController | null = null
  let currentSettled: Promise<void>

  const ensureController = (): BindingController | null => {
    if (controller === null && failedScope !== null) controller = failedScope.register()
    return controller
  }

  const runAttempt = (): Promise<void> => {
    const scope = createScope(getCurrentScope(), 'speculative')
    const attempt = isGeneratorFunction(body)
      ? driveGeneratorAction(scope, body as () => Generator<unknown, void, unknown>)
      : driveNonGeneratorAction(scope, body)
    return attempt.then(
      () => {
        setError(null)
        controller?.report({ status: 'idle' })
        controller?.unregister()
        controller = null
      },
      (e: unknown) => {
        setError(e)
        ensureController()?.report({ status: 'failed', error: e, source: null, retry })
      },
    )
  }

  function retry(): void {
    currentSettled = runAttempt()
  }

  onCleanup(() => controller?.unregister())

  currentSettled = runAttempt()

  return {
    get settled() {
      return currentSettled
    },
    error,
    retry,
  }
}
```

(`makeErrorCell`, `driveNonGeneratorAction`, and `driveGeneratorAction` are unchanged from Task 2 — only the `action` function itself changes.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`
Expected: PASS — all tests in the file, including the new one.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `pnpm test`
Expected: all test files pass.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/scope.ts test/dom/failed.test.tsx
git commit -m "feat: a failed action registers with the nearest <Failed> boundary automatically"
```

---

### Task 4: Migrate `examples/todo-async` off its hand-rolled retry UI

**Files:**
- Modify: `examples/todo-async/src/main.tsx`
- Modify: `examples/todo-async/src/style.css`
- Modify: `examples/todo-async/tests/todo-async.spec.ts`

**Interfaces:**
- Consumes: `action` (now returning `ActionHandle` per Tasks 2-3), the existing `<Failed fallback={(error, reset) => ...}>` already wrapping `TodoList` in `App()`.
- Produces: nothing new. `notice`, `flash`, `Notice`, and the retry-button JSX are deleted entirely.

- [ ] **Step 1: Remove the hand-rolled notice state and UI**

In `examples/todo-async/src/main.tsx`, delete:
- The `type Notice = { message: string; retry?: () => void }` type.
- The `const [notice, setNotice] = signal<Notice | null>(null)` line.
- The `flash` function entirely.
- The `<Show when={notice}>...</Show>` block in `App()`'s JSX (the one rendering `.notice`/`.notice-message`/`.notice-retry`).

- [ ] **Step 2: Simplify the three mutations to drop `flash`, `onSettled`, and `.catch`**

Replace `submitTodo`:

```tsx
function submitTodo(text: string) {
  // A placeholder id, negative so it cannot collide with a real one. It only
  // ever exists inside the overlay.
  const pending: Todo = { id: -Date.now(), text, done: false }
  action(function* () {
    setOverlay([...committed(() => latest(todos)), pending])
    const saved = yield* read(api.add(text))
    setTodos((prev) => [...(prev ?? []), saved])
  })
}
```

Replace `toggleTodo`:

```tsx
function toggleTodo(todo: Todo) {
  action(function* () {
    setOverlay(
      committed(() => latest(todos)).map((each) =>
        each.id === todo.id ? { ...each, done: !each.done } : each,
      ),
    )
    const saved = yield* read(api.toggle(todo.id))
    setTodos((prev) => (prev ?? []).map((each) => (each.id === saved.id ? saved : each)))
  })
}
```

Replace `removeTodo`:

```tsx
function removeTodo(todo: Todo) {
  action(function* () {
    setOverlay(committed(() => latest(todos)).filter((each) => each.id !== todo.id))
    yield* read(api.remove(todo.id))
    setTodos((prev) => (prev ?? []).filter((each) => each.id !== todo.id))
  })
}
```

Remove `onSettled` from the `import { ... } from 'pulse'` list at the top of the file — it is no longer used anywhere in this file.

- [ ] **Step 3: Remove the now-unused notice styles**

In `examples/todo-async/src/style.css`, delete the `.notice-retry` rule and revert `.notice` to its pre-retry-affordance form (remove `display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;`, keeping the rest):

```css
.notice {
  margin: 0 0 1rem;
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 0.9rem;
}
```

Since `notice` no longer exists as a signal or JSX usage after Step 1, this whole rule is now dead CSS — delete it entirely rather than leaving it unused. Search the file for `.notice` after this edit to confirm nothing still references it.

- [ ] **Step 4: Update the Playwright test for the new retry path**

In `examples/todo-async/tests/todo-async.spec.ts`, find the test `'a rejected write shows a retry affordance that resubmits the same request'` (it currently asserts against `data-testid="notice"` and `data-testid="notice-retry"`, which no longer exist). Replace it with:

```ts
test('a rejected write shows the failure boundary, and its retry button resubmits the same request', async ({ page }) => {
  await open(page, { latency: 200, fail: 0 })
  await expect(page.getByTestId('todo-list')).toBeAttached({ timeout: 5000 })

  await page.getByTestId('fail-rate').fill('1')
  await addTodo(page, 'retry me')

  // The write is refused; the action registers with the same <Failed> boundary
  // the initial load uses, so its fallback replaces the whole list.
  await expect(page.getByTestId('error-panel')).toBeVisible({ timeout: 5000 })
  const retryButton = page.getByTestId('retry')
  await expect(retryButton).toContainText('retry me')

  // Fix the server, then press retry — the same action runs again.
  await page.getByTestId('fail-rate').fill('0')
  await retryButton.click()

  await expect(page.getByTestId('error-panel')).not.toBeAttached({ timeout: 5000 })
  await expect(page.getByTestId('todo-list')).toBeAttached()
  await expect(
    page.getByTestId('todo-row').filter({ hasText: 'retry me' }),
  ).toBeVisible({ timeout: 5000 })
})
```

Leave the other test, `'a rejected write rolls the optimistic row back'`, unchanged — it does not touch the notice/retry UI and its assertions (the row disappearing, canonical/overlay counts matching) hold regardless of this migration.

- [ ] **Step 5: Verify manually in a browser**

Run: `cd examples/todo-async && pnpm dev`

In the browser: set failure rate to 1, add a todo, confirm the whole list area is replaced by the failure boundary's fallback (an error message and a "Try again" button) rather than the small notice that used to appear. Set failure rate back to 0, click "Try again", confirm the list returns and the todo is present. This is the accepted UX change from Global Constraints — confirm it looks reasonable, not broken (text legible, button clickable, layout not visually corrupted), before moving on.

- [ ] **Step 6: Run the Playwright suite and the full core test suite**

Run: `cd examples/todo-async && pnpm exec playwright test`
Expected: all tests pass (7 pre-existing plus the rewritten retry test).

Run (from the repo root): `pnpm test && pnpm typecheck`
Expected: all pass, clean.

- [ ] **Step 7: Commit**

```bash
git add examples/todo-async/src/main.tsx examples/todo-async/src/style.css examples/todo-async/tests/todo-async.spec.ts
git commit -m "refactor(examples): let <Failed> handle mutation failures instead of a hand-rolled notice"
```

# Error-Type-Filtered Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let both `<Failed>` and `catchError` decline a specific error via an optional `for` predicate, so it propagates to the next ancestor boundary instead of the nearest one always winning regardless of what failed.

**Architecture:** One shared idea — "a boundary can say no to a specific error, and the walk keeps going" — implemented twice, once for each of the two existing, deliberately-separate boundary mechanisms (`FailedScope`, used by `<Failed>`; `ErrorHandlerEntry`, used by `catchError`), sharing the same filter-checking pattern inside `findNearestFailedScope`/`routeError`. `action()` needs a structurally different change: since it discovers its boundary before the error that would decide the winner even exists, it moves from resolving one boundary eagerly to collecting every candidate eagerly (preserving today's disposal-guard timing exactly) and picking among them once the error is known.

**Tech Stack:** TypeScript, r3, vitest (`|unit|` project for `.test.ts`, `|dom (chromium)|` project for `.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-08-19-error-type-filtered-boundaries-design.md`

## Global Constraints

- `for` defaults to "accepts everything" on both `<Failed>` and `catchError` when omitted — every existing call site must need zero changes and keep passing unmodified. Confirmed by grep before this plan was written: every non-null `errorHandler` argument to `createSubOwner` comes from `catchError`'s own call site (`src/owner.ts`); no other file passes one. Every direct read of `owner.errorHandler` lives inside `src/owner.ts` itself (`routeError`, `findNearestFailedScope`); no test inspects it directly.
- The type-guard form of `<Failed>`'s `for` (`(value: unknown) => value is E`) must narrow `fallback`'s `error` parameter to `E` — this is a compile-time-only guarantee and needs a typecheck-level assertion, not just a runtime test.
- `action()`'s reference-keyed-row disposal-anchor correctness (`docs/superpowers/specs/2026-08-18-retryable-failure-propagation-design.md`) must still hold exactly under the new multi-candidate structure: every candidate's disposal guard is installed at `action()` call time, while the calling row is still guaranteed alive — never deferred to failure time.
- `action()` does not gain any ability to invoke a `catchError` handler. Its candidate-collection walk stops, unconditionally, the moment it reaches a `catchError` — it does not check that `catchError`'s own `for`, and it never calls its handler. This matches today's behavior exactly (action failures with no `<Failed>` found are not routed anywhere today either).
- The implicit root `FailedScope` (installed by `createRoot()`, from the earlier composable-boundary-state work) needs no code change — it already has no `for`, so it already accepts everything.
- `examples/todo-async` is explicitly out of scope for this plan — updating the demo to use `for` is a separate, follow-up task after this lands.

---

### Task 1: `ErrorHandlerEntry` and filter-aware `routeError`/`catchError`

**Files:**
- Modify: `src/owner.ts`
- Test: `test/owner.test.ts`

**Interfaces:**
- Produces: `export interface ErrorHandlerEntry { handle(error: unknown): void; for?: (error: unknown) => boolean }`, exported from `src/owner.ts`. `Owner.errorHandler` becomes `ErrorHandlerEntry | null` (was `((error: unknown) => void) | null`). `catchError`'s signature gains a third, optional parameter: `catchError<T>(fn: () => T, handler: (error: unknown) => void, options?: { for?: (error: unknown) => boolean }): T | undefined`.
- Consumes: nothing new from other tasks — this is the foundation task.

- [ ] **Step 1: Write the failing tests**

Add to `test/owner.test.ts`, anywhere after the existing `catchError` tests (search for `'catchError invokes the handler on a synchronous throw inside fn'` to find that block):

```ts
test('catchError with a declining for lets the error propagate to an outer catchError', () => {
  const outerCaught: unknown[] = []
  const innerCaught: unknown[] = []
  createRoot(() => {
    catchError(
      () => {
        catchError(
          () => {
            throw new TypeError('boom')
          },
          (e) => innerCaught.push(e),
          { for: (e): e is RangeError => e instanceof RangeError },
        )
      },
      (e) => outerCaught.push(e),
    )
  })
  expect(innerCaught).toEqual([])
  expect(outerCaught).toHaveLength(1)
  expect((outerCaught[0] as Error).message).toBe('boom')
})

test('catchError with an accepting for claims the error itself, not an outer catchError', () => {
  const outerCaught: unknown[] = []
  const innerCaught: unknown[] = []
  createRoot(() => {
    catchError(
      () => {
        catchError(
          () => {
            throw new TypeError('boom')
          },
          (e) => innerCaught.push(e),
          { for: (e): e is TypeError => e instanceof TypeError },
        )
      },
      (e) => outerCaught.push(e),
    )
  })
  expect(innerCaught).toHaveLength(1)
  expect((innerCaught[0] as Error).message).toBe('boom')
  expect(outerCaught).toEqual([])
})

test('catchError with a declining for and no outer handler re-throws, same as no handler at all', () => {
  expect(() => {
    createRoot(() => {
      catchError(
        () => {
          throw new TypeError('boom')
        },
        () => {},
        { for: (e): e is RangeError => e instanceof RangeError },
      )
    })
  }).toThrow('boom')
})

test('catchError omitting for still accepts everything, exactly as before', () => {
  const caught: unknown[] = []
  createRoot(() => {
    catchError(
      () => {
        throw new Error('boom')
      },
      (e) => caught.push(e),
    )
  })
  expect(caught).toHaveLength(1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/owner.test.ts -t "declining for|accepting for|omitting for"`

Expected: FAIL — `catchError`'s current signature has no third parameter; passing one is simply ignored by the current implementation, so the declining/re-throw tests fail (the inner handler still gets invoked, since nothing checks `for` yet).

- [ ] **Step 3: Add `ErrorHandlerEntry` and change `Owner.errorHandler`'s type**

In `src/owner.ts`, find:

```ts
/** A lifecycle scope. Owns reactive nodes created within it and their cleanup callbacks. */
export interface Owner {
  /** The parent owner in the lifecycle tree, or `null` for a root. */
  readonly parent: Owner | null
  /** Optional error handler (set by `catchError`). When a reactive node owned
   *  by this owner (or a descendant) throws, the throw walks up via `parent`
   *  links to find the nearest handler. */
  readonly errorHandler: ((error: unknown) => void) | null
```

Replace with:

```ts
/** What `catchError` installs on an owner: the handler itself, plus an
 *  optional filter. `for` undefined means "accepts everything" — the
 *  existing, unconditional behaviour. When `for` declines a specific error,
 *  `routeError` treats this owner as if it had no handler at all for that
 *  error, and keeps walking to the next ancestor. */
export interface ErrorHandlerEntry {
  handle(error: unknown): void
  for?: (error: unknown) => boolean
}

/** A lifecycle scope. Owns reactive nodes created within it and their cleanup callbacks. */
export interface Owner {
  /** The parent owner in the lifecycle tree, or `null` for a root. */
  readonly parent: Owner | null
  /** Optional error handler (set by `catchError`). When a reactive node owned
   *  by this owner (or a descendant) throws, the throw walks up via `parent`
   *  links to find the nearest handler that accepts it. */
  readonly errorHandler: ErrorHandlerEntry | null
```

- [ ] **Step 4: Update `newOwner`'s parameter type**

Find:

```ts
function newOwner(
  parent: Owner | null = null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
```

Replace with:

```ts
function newOwner(
  parent: Owner | null = null,
  errorHandler: ErrorHandlerEntry | null = null,
): Owner {
```

- [ ] **Step 5: Make `routeError` filter-aware**

Find:

```ts
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

Replace with:

```ts
export function routeError(start: Owner | null, error: unknown): void {
  let owner = start
  while (owner !== null) {
    const handler = owner.errorHandler
    if (handler !== null && (handler.for === undefined || handler.for(error))) {
      try {
        handler.handle(error)
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

- [ ] **Step 6: Update `createSubOwner`'s parameter type**

Find:

```ts
export function createSubOwner(
  parent: Owner | null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
```

Replace with:

```ts
export function createSubOwner(
  parent: Owner | null,
  errorHandler: ErrorHandlerEntry | null = null,
): Owner {
```

- [ ] **Step 7: Update `catchError`'s signature and construct an `ErrorHandlerEntry`**

Find:

```ts
export function catchError<T>(
  fn: () => T,
  handler: (error: unknown) => void,
): T | undefined {
  const sub = createSubOwner(currentOwner, handler)
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

Replace with:

```ts
export function catchError<T>(
  fn: () => T,
  handler: (error: unknown) => void,
  options?: { for?: (error: unknown) => boolean },
): T | undefined {
  const entry: ErrorHandlerEntry = { handle: handler, for: options?.for }
  const sub = createSubOwner(currentOwner, entry)
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

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/owner.test.ts -t "declining for|accepting for|omitting for"`

Expected: PASS (4 tests)

- [ ] **Step 9: Run the full `test/owner.test.ts` file and typecheck**

Run: `pnpm exec vitest run test/owner.test.ts && pnpm typecheck`

Expected: PASS — every pre-existing `catchError` test in the file still passes unmodified, plus the 4 new ones. Typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add src/owner.ts test/owner.test.ts
git commit -m "$(cat <<'EOF'
feat: let catchError decline a specific error via an optional filter

catchError's handler stays a plain function at the call site, but is
now wrapped internally as an ErrorHandlerEntry carrying an optional
for predicate. routeError treats an owner whose handler declines a
given error exactly as if that owner had no handler at all for it,
and keeps walking to the next ancestor instead of invoking it — the
same fallthrough that already happens today when a handler itself
throws, just triggered by a predicate instead of an exception.

Omitting for keeps today's behaviour exactly: every existing
catchError call accepts everything, unconditionally.
EOF
)"
```

---

### Task 2: `FailedScope.for` and filter-aware `findNearestFailedScope`

**Files:**
- Modify: `src/owner.ts`
- Test: `test/owner.test.ts`

**Interfaces:**
- Consumes: `ErrorHandlerEntry`/`handler.for` from Task 1.
- Produces: `FailedScope` gains `readonly for?: (error: unknown) => boolean`. `createFailedScope` gains a second, optional parameter: `createFailedScope(onFailedReport?: (error: unknown) => void, filterFor?: (error: unknown) => boolean): FailedScope`. `findNearestFailedScope`'s signature becomes `findNearestFailedScope(start: Owner | null, error: unknown): { owner: Owner; scope: FailedScope } | null` (was `findNearestFailedScope(start: Owner | null)`) — this is a breaking signature change; Task 3 updates the two call sites that need the new argument.

- [ ] **Step 1: Write the failing tests**

Add to `test/owner.test.ts`, after the tests added in Task 1:

```ts
test('findNearestFailedScope skips a FailedScope whose for declines the error, finding a farther one that accepts', () => {
  createRoot(() => {
    const outer = createSubOwner(getOwner())
    const outerScope: FailedScope = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
    }
    outer.boundaries.failed = outerScope

    const found = runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      const innerScope: FailedScope = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({ report: () => {}, unregister: () => {} }),
        reset: () => {},
      }
      inner.boundaries.failed = innerScope
      return runWithOwner(inner, () => findNearestFailedScope(getOwner(), new TypeError('boom')))
    })

    expect(found?.scope).toBe(outerScope)
  })
})

test('findNearestFailedScope claims the error at the nearest FailedScope whose for accepts it', () => {
  createRoot(() => {
    let innerScope!: FailedScope
    const found = runWithOwner(createSubOwner(getOwner()), () => {
      const inner = createSubOwner(getOwner())
      innerScope = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        for: (e): e is TypeError => e instanceof TypeError,
        register: () => ({ report: () => {}, unregister: () => {} }),
        reset: () => {},
      }
      inner.boundaries.failed = innerScope
      return runWithOwner(inner, () => findNearestFailedScope(getOwner(), new TypeError('boom')))
    })

    expect(found?.scope).toBe(innerScope)
  })
})

test('findNearestFailedScope omitting for still accepts everything, exactly as before', () => {
  createRoot(() => {
    const found = findNearestFailedScope(getOwner(), new Error('x'))
    expect(found).not.toBeNull()
  })
})

test('a nearer, accepting catchError still wins over a farther FailedScope, exactly as before', () => {
  createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.failed = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
    }

    const found = runWithOwner(outer, () =>
      catchError(
        () => findNearestFailedScope(getOwner(), new Error('boom')),
        () => {},
      ),
    )

    expect(found).toBeNull()
  })
})

test('a nearer catchError that declines the error lets a farther FailedScope claim it', () => {
  createRoot(() => {
    const outer = createSubOwner(getOwner())
    const outerScope: FailedScope = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({ report: () => {}, unregister: () => {} }),
      reset: () => {},
    }
    outer.boundaries.failed = outerScope

    const found = runWithOwner(outer, () =>
      catchError(
        () => findNearestFailedScope(getOwner(), new TypeError('boom')),
        () => {},
        { for: (e): e is RangeError => e instanceof RangeError },
      ),
    )

    expect(found?.scope).toBe(outerScope)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/owner.test.ts -t "findNearestFailedScope|nearer, accepting catchError|nearer catchError that declines"`

Expected: FAIL — `findNearestFailedScope` currently takes one argument; calling it with two is a type error caught at the `pnpm typecheck` level, and at the `vitest` level (which does not typecheck) the extra argument is simply ignored, so the filter-declining tests fail because the current implementation always claims the nearest `FailedScope` unconditionally.

- [ ] **Step 3: Add `for` to `FailedScope` and to `createFailedScope`**

In `src/owner.ts`, find:

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

Replace with:

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

Find:

```ts
export function createFailedScope(onFailedReport?: (error: unknown) => void): FailedScope {
```

Replace with:

```ts
export function createFailedScope(
  onFailedReport?: (error: unknown) => void,
  filterFor?: (error: unknown) => boolean,
): FailedScope {
```

Find the `return` statement at the end of `createFailedScope`:

```ts
  return {
    kind: 'failed',
    active: () => readCollection().active,
    error: () => readCollection().error,
    register(): BindingController {
```

Replace with:

```ts
  return {
    kind: 'failed',
    active: () => readCollection().active,
    error: () => readCollection().error,
    for: filterFor,
    register(): BindingController {
```

- [ ] **Step 4: Make `findNearestFailedScope` filter-aware, on both `FailedScope` and `catchError`**

Find:

```ts
export function findNearestFailedScope(
  start: Owner | null,
): { owner: Owner; scope: FailedScope } | null {
  let owner = start
  while (owner !== null) {
    if (owner.boundaries.failed !== null) return { owner, scope: owner.boundaries.failed }
    if (owner.errorHandler !== null) return null // a nearer catchError wins
    owner = owner.parent
  }
  return null
}
```

Replace with:

```ts
export function findNearestFailedScope(
  start: Owner | null,
  error: unknown,
): { owner: Owner; scope: FailedScope } | null {
  let owner = start
  while (owner !== null) {
    const scope = owner.boundaries.failed
    if (scope !== null && (scope.for === undefined || scope.for(error))) {
      return { owner, scope }
    }
    const handler = owner.errorHandler
    if (handler !== null && (handler.for === undefined || handler.for(error))) {
      return null // a nearer, accepting catchError wins
    }
    owner = owner.parent
  }
  return null
}
```

Also update this function's own doc comment, immediately above it, to describe the filtering:

Find:

```ts
/**
 * The nearest `<Failed>` boundary — or `null` if a `catchError` handler is nearer,
 * or if there is neither. Returns the boundary's own owner alongside its scope: a
 * caller that needs to know when the BOUNDARY itself (as opposed to whatever owner
 * it started walking from) goes away — e.g. to anchor an `onCleanup` there instead
 * of on the calling owner — needs that owner directly, since `FailedScope` alone
 * does not expose it.
 *
 * `<Failed>` and `catchError` are peers in ONE walk up the owner chain, and the
 * nearest wins. Returning `null` when a handler is nearer is what lets the caller
 * fall through to `routeError`, which walks the same chain and finds that handler.
 * So a `catchError` nested inside a `<Failed>` intercepts first, and the boundary
 * catches whatever the inner handler does not.
 */
```

Replace with:

```ts
/**
 * The nearest `<Failed>` boundary that accepts `error` — or `null` if a
 * `catchError` handler that accepts it is nearer, or if nothing along the
 * way accepts it at all. Returns the boundary's own owner alongside its
 * scope: a caller that needs to know when the BOUNDARY itself (as opposed
 * to whatever owner it started walking from) goes away — e.g. to anchor an
 * `onCleanup` there instead of on the calling owner — needs that owner
 * directly, since `FailedScope` alone does not expose it.
 *
 * `<Failed>` and `catchError` are peers in ONE walk up the owner chain, and
 * the nearest one that ACCEPTS `error` wins. A `<Failed for={...}>` or
 * `catchError(fn, handler, { for: ... })` that declines `error` is treated
 * as if it were not there at all for this specific error, and the walk
 * continues past it — including past a nearer, declining `catchError`, to
 * check a farther `<Failed>` or `catchError`. Returning `null` when the
 * nearest accepting thing is a `catchError` is what lets the caller fall
 * through to `routeError`, which walks the same chain and finds it.
 */
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `pnpm exec vitest run test/owner.test.ts -t "findNearestFailedScope|nearer, accepting catchError|nearer catchError that declines"`

Expected: PASS (5 tests)

- [ ] **Step 6: Run the full `test/owner.test.ts` file and typecheck**

Run: `pnpm exec vitest run test/owner.test.ts && pnpm typecheck`

Expected: FAIL on typecheck at this point — `src/effect.ts` and `src/scope.ts` both still call `findNearestFailedScope` with only one argument, which no longer type-checks against the new two-argument signature. This is expected; Task 3 and Task 5 fix the two call sites. Confirm the vitest run itself still passes (51 test files unaffected by the type error, since vitest does not typecheck), and confirm the typecheck failure is specifically about `findNearestFailedScope`'s missing second argument in exactly those two files, nothing else.

- [ ] **Step 7: Commit**

```bash
git add src/owner.ts test/owner.test.ts
git commit -m "$(cat <<'EOF'
feat: let a FailedScope decline a specific error via an optional filter

FailedScope gains a for field, set from <Failed>'s own for prop (wired
up in a later commit) and read by findNearestFailedScope before ever
registering a report — never inside register()/report() themselves,
so a declining FailedScope is treated as though it were not present
at all for that particular error, and the walk continues to the next
ancestor <Failed> or catchError.

findNearestFailedScope's signature changes to take the error being
routed, so it can check both a FailedScope's own for and a nearer
catchError's for in one walk. This intentionally breaks its two
existing call sites in src/effect.ts and src/scope.ts's action() until
the next two commits update them — pnpm typecheck fails until then,
confirmed and expected.
EOF
)"
```

---

### Task 3: `effect.ts`'s two call sites gain the error argument

**Files:**
- Modify: `src/effect.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `findNearestFailedScope`'s new two-argument signature from Task 2.
- Produces: nothing new — this task only fixes the two call sites broken by Task 2's signature change, and adds one end-to-end test proving a filtered `<Failed>` correctly declines a computed's rejection.

- [ ] **Step 1: Write the failing test**

Add to `test/dom/failed.test.tsx`, after the last existing test in the file (currently ending with `'useFailed() with no explicit <Failed> reports the implicit root boundary, aggregating unrelated failures'`):

```tsx
test('<Failed> with a declining for lets a computed rejection propagate to a farther, accepting <Failed>', async () => {
  const target = document.createElement('section')
  document.body.append(target)
  const c = computed(() => Promise.reject(new TypeError('boom')))

  render(
    () => (
      <Failed
        for={(e: unknown): e is Error => e instanceof Error}
        fallback={(error) => <p data-testid="outer-panel">{(error as Error).message}</p>}
      >
        {() => (
          <Failed
            for={(e: unknown): e is RangeError => e instanceof RangeError}
            fallback={() => <p data-testid="inner-panel">inner</p>}
          >
            {() => <span>{() => use(c)}</span>}
          </Failed>
        )}
      </Failed>
    ),
    target,
  )

  await tick()
  flush()

  expect(target.querySelector('[data-testid="inner-panel"]')).toBeNull()
  expect(target.querySelector('[data-testid="outer-panel"]')?.textContent).toBe('boom')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "declining for lets a computed rejection propagate"`

Expected: FAIL. At this point in the plan, `pnpm typecheck` already fails (Task 2's Step 6), and `<Failed>` itself does not accept a `for` prop yet (that's Task 4) — so this test also fails to compile under `vitest`'s own transform in a way that surfaces as a test failure (the JSX `for={...}` prop is simply an excess, ignored property until Task 4, and `findNearestFailedScope`'s call sites inside `src/effect.ts` are still passing one argument, so no filtering happens at all yet — the rejection would reach the FIRST `<Failed>` it finds, which today only means it will reach whichever boundary `<Loading>`-unrelated failure routing already reaches, not correctly stopping at the inner one and definitely not being filtered past it). Confirm it fails; the exact failure mode does not need to match a specific assertion, since Task 4 has not landed yet either.

- [ ] **Step 3: Update both `findNearestFailedScope` call sites in `src/effect.ts`**

There are two, structurally identical, in `stagedEffect` and `singleArgEffect`. Find (it appears twice, once in each function):

```ts
      const failedScope = findNearestFailedScope(myOwner)
```

Replace both occurrences with:

```ts
      const failedScope = findNearestFailedScope(myOwner, e)
```

- [ ] **Step 4: Run typecheck to confirm `src/effect.ts` is no longer part of the failure**

Run: `pnpm typecheck 2>&1 | grep -v "src/scope.ts"`

Expected: no output — `src/effect.ts` no longer contributes any typecheck errors. (`src/scope.ts`'s own call site is still broken; that is Task 5's job, and is filtered out of this check on purpose.)

- [ ] **Step 5: Run the new test — expect it still to fail, for a different, narrower reason**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "declining for lets a computed rejection propagate"`

Expected: FAIL — `src/effect.ts`'s call sites are now filter-aware, but `<Failed>` itself still ignores its `for` prop entirely (Task 4 has not landed), so both boundaries in this test currently accept everything and the *inner* one claims the rejection instead of the outer one. This step exists to confirm the failure has narrowed to exactly the piece Task 4 is about to add, not anything in this task.

- [ ] **Step 6: Commit**

```bash
git add src/effect.ts
git commit -m "$(cat <<'EOF'
fix: pass the error through to findNearestFailedScope's two call sites

Both of effect.ts's failure branches already discover their boundary
inside their own catch block, after the error is known — updating
them to findNearestFailedScope's new two-argument signature needs no
timing change, just the argument itself.
EOF
)"
```

(The new test in `test/dom/failed.test.tsx` stays uncommitted/unpassing at this point — it becomes committable at the end of Task 4, once `<Failed>`'s own `for` prop exists to make it pass. Leave it in the working tree; do not `git add` it yet.)

---

### Task 4: `<Failed>`'s own `for` prop

**Files:**
- Modify: `src/dom/failed.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `createFailedScope`'s new second parameter and `FailedScope.for` from Task 2.
- Produces: `FailedProps<E = unknown>` gains `for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)`; `fallback` becomes `(error: E, reset: () => void) => unknown` (was `(error: unknown, reset: () => void) => unknown`); `Failed` becomes generic: `Failed<E = unknown>(props: FailedProps<E>): Accessor<unknown>`.

- [ ] **Step 1: Confirm the test from Task 3 is still the right shape, then run it**

The test added in Task 3 (`'<Failed> with a declining for lets a computed rejection propagate to a farther, accepting <Failed>'`) already exercises exactly what this task builds. No new test file changes are needed for the core behavior — Step 5 below adds one additional test specifically for the type-narrowing guarantee, which the runtime test above cannot cover.

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "declining for lets a computed rejection propagate"`

Expected: FAIL (same failure as confirmed at the end of Task 3 — the inner, `RangeError`-only boundary is still claiming everything, since `<Failed>` ignores its `for` prop).

- [ ] **Step 2: Make `FailedProps`/`Failed` generic, and add `for`**

In `src/dom/failed.ts`, find:

```ts
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
```

Replace with:

```ts
export interface FailedProps<E = unknown> {
  /** Function child REQUIRED — defers JSX construction until inside the boundary
   *  owner, so descendants register with the right scope. Same contract as
   *  `<Loading>`. */
  children: () => unknown
  /** Optional. When provided, behaves as a full-subtree swap: replace the
   *  whole subtree with `fallback(error, reset)` while the boundary is
   *  active. When omitted, `<Failed>` is pure scoping — children stay
   *  mounted always, and `useFailed()` (or `Failed.Error`) is how a
   *  descendant shows the failure without unmounting anything. */
  fallback?: (error: E, reset: () => void) => unknown
  /** Optional. When given, this boundary only claims an error if `for`
   *  returns true for it — anything else is treated as if this boundary did
   *  not exist, and the search continues to the next ancestor `<Failed>` (or
   *  `catchError`) instead. Omitted means "accepts everything", exactly the
   *  behaviour without this prop.
   *
   *  Written as a type guard (`(value: unknown) => value is E`), `fallback`'s
   *  own `error` parameter is narrowed to `E`. A plain boolean predicate
   *  still works when there's nothing to narrow to (filtering by message, by
   *  a custom `.code` property, etc.) — just without the narrowing. */
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
}
```

- [ ] **Step 3: Make `Failed` generic and pass `props.for` into `createFailedScope`**

Find:

```ts
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

Replace with:

```ts
export function Failed<E = unknown>(props: FailedProps<E>): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner: Owner = createSubOwner(parentOwner)
  const scope = createFailedScope(undefined, props.for)
  boundaryOwner.boundaries.failed = scope

  // Construct the guarded subtree once, inside boundaryOwner — same
  // components-run-once contract as `<Loading>`.
  const subtree: unknown = runWithOwner(boundaryOwner, props.children)

  return () => {
    if (props.fallback === undefined) return subtree
    if (!scope.active()) return subtree
    // Safe: fallback only runs while scope.active() is true, meaning
    // something registered a 'failed' report that findNearestFailedScope/
    // action() already checked against this exact scope.for before ever
    // calling register() — see FailedScope.for's own doc comment.
    return props.fallback(scope.error() as E, scope.reset)
  }
}
```

- [ ] **Step 4: Run the test from Task 3 to verify it now passes**

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "declining for lets a computed rejection propagate"`

Expected: PASS

- [ ] **Step 5: Add a typecheck-only test for `fallback`'s narrowing**

`fallback`'s narrowing to `E` is a compile-time guarantee — vitest's transform does not typecheck, so a runtime test cannot catch a regression here. Add a small, self-contained `.tsx` file that only needs to compile, never runs any assertions, and is exercised purely by `pnpm typecheck`:

Create `test/dom/failed-narrowing.typecheck.tsx`:

```tsx
// This file exists purely to be typechecked (pnpm typecheck) — it has no
// runtime assertions and is not a vitest test. If <Failed>'s `for` stops
// narrowing `fallback`'s `error` parameter, the `.message`/`.code` accesses
// below stop compiling.
import { Failed } from '../../src/index'

class HttpError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function _typeGuardNarrowsFallbackError() {
  return (
    <Failed
      for={(e: unknown): e is HttpError => e instanceof HttpError}
      fallback={(error) => <p>{error.code}: {error.message}</p>}
    >
      {() => <span>content</span>}
    </Failed>
  )
}

function _plainPredicateDoesNotNarrow() {
  return (
    <Failed
      for={(e: unknown) => e instanceof HttpError}
      // @ts-expect-error — a plain boolean predicate does not narrow E, so
      // `error` stays `unknown` here and `.code`/`.message` do not exist on it.
      fallback={(error) => <p>{error.code}</p>}
    >
      {() => <span>content</span>}
    </Failed>
  )
}

function _omittingForKeepsErrorUnknown() {
  return (
    <Failed
      // @ts-expect-error — no `for` at all means `E` stays the default
      // `unknown`, so `error.code` does not exist here either.
      fallback={(error) => <p>{error.code}</p>}
    >
      {() => <span>content</span>}
    </Failed>
  )
}
```

- [ ] **Step 6: Run typecheck to confirm the narrowing file compiles correctly**

Run: `pnpm typecheck 2>&1 | grep -v "src/scope.ts"`

Expected: no output. If `_typeGuardNarrowsFallbackError` fails to compile, the type-guard narrowing described in the spec is broken — fix `FailedProps`/`Failed`'s generics before proceeding. If either `@ts-expect-error` line reports "Unused '@ts-expect-error' directive" (meaning the line it's attached to compiled fine, i.e. `error.code` was somehow valid), that is also a bug — the narrowing is too permissive — investigate before proceeding, since it means a plain predicate or an absent `for` is incorrectly narrowing `error`.

- [ ] **Step 7: Run the full `test/dom/failed.test.tsx` file**

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: PASS — all pre-existing tests (unaffected, since none use `for`) plus the one added in Task 3.

- [ ] **Step 8: Commit**

```bash
git add src/dom/failed.ts test/dom/failed.test.tsx test/dom/failed-narrowing.typecheck.tsx
git commit -m "$(cat <<'EOF'
feat: add for to <Failed>, narrowing fallback's error when given a type guard

<Failed> becomes generic over the error type its for prop's type guard
targets, so fallback's own error parameter narrows to that type within
the same <Failed> element — a plain boolean predicate still works for
filters that don't naturally express a type guard, just without the
narrowing. Passes straight through to createFailedScope, which already
exposes it on the returned FailedScope for findNearestFailedScope and
action() to check.

Includes a typecheck-only file (no runtime assertions) proving the
narrowing actually holds, since it's a compile-time-only guarantee a
vitest run can't catch a regression in.
EOF
)"
```

---

### Task 5: `action()` collects every candidate at call time, picks one at failure time

**Files:**
- Modify: `src/scope.ts`
- Test: `test/async-action.test.ts`
- Test: `test/dom/failed.test.tsx`

**Interfaces:**
- Consumes: `FailedScope.for` from Task 2, `<Failed for={...}>` from Task 4.
- Produces: nothing new is exported — this task changes `action()`'s internals only. `ActionHandle`'s own public shape is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/async-action.test.ts`, after the last existing test in the file (currently ending with `'check() stops throwing once retry() succeeds'` — if that test no longer exists because `check()` was removed in an earlier session, add after whichever test is now last):

```ts
test('action() skips a nearer FailedScope whose for declines the error, registering with a farther one that accepts', async () => {
  const outerReports: unknown[] = []
  const innerReports: unknown[] = []

  const handle = createRoot(() => {
    const outer = createSubOwner(getOwner())
    outer.boundaries.failed = {
      kind: 'failed',
      active: () => false,
      error: () => null,
      register: () => ({
        report: (state) => {
          if (state.status === 'failed') outerReports.push(state.error)
        },
        unregister: () => {},
      }),
      reset: () => {},
    }

    return runWithOwner(outer, () => {
      const inner = createSubOwner(getOwner())
      inner.boundaries.failed = {
        kind: 'failed',
        active: () => false,
        error: () => null,
        for: (e): e is RangeError => e instanceof RangeError,
        register: () => ({
          report: (state) => {
            if (state.status === 'failed') innerReports.push(state.error)
          },
          unregister: () => {},
        }),
        reset: () => {},
      }

      return runWithOwner(inner, () =>
        action(function* () {
          yield* read(Promise.reject(new TypeError('boom')))
        }),
      )
    })
  })

  await handle.settled

  expect(innerReports).toEqual([])
  expect(outerReports).toHaveLength(1)
  expect((outerReports[0] as Error).message).toBe('boom')
})

test('action() with no explicit <Failed> anywhere still reaches the implicit root, unaffected by candidate collection', async () => {
  const handle = createRoot(() =>
    action(function* () {
      yield* read(Promise.reject(new Error('boom')))
    }),
  )
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
})

test('action() stops candidate-collection at the nearest catchError, never reaching a farther <Failed> (the implicit root)', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    catchError(
      () => {
        handle = action(function* () {
          yield* read(Promise.reject(new Error('boom')))
        })
      },
      () => {},
    )
  })
  await handle.settled
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})
```

The file currently has no import from `../src/owner` at all, and no `vi` import. Replace its two existing import lines:

```ts
import { expect, test } from 'vitest'
import { action, committed, computed, read, signal } from '../src/index'
```

with:

```ts
import { expect, test, vi } from 'vitest'
import { action, committed, computed, read, signal } from '../src/index'
import {
  catchError,
  createRoot,
  createSubOwner,
  getOwner,
  runWithOwner,
  type FailedScope,
} from '../src/owner'
```

(`createSubOwner` is not exported from `../src/index`'s public barrel — it has to come from `../src/owner` directly, the same way `test/owner.test.ts` already imports it. `catchError`/`createRoot`/`getOwner`/`runWithOwner` are exported from both; importing all of them from `../src/owner` in one line, alongside `createSubOwner`, keeps this file's import style consistent with `test/owner.test.ts`'s own.)

Now add the DOM-level test that actually proves the selection end-to-end, to `test/dom/failed.test.tsx`, after the test added in Task 4:

```tsx
test('action() skips a nearer <Failed> whose for declines the error, and registers with a farther one that accepts', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  render(
    () => (
      <Failed
        for={(e: unknown): e is Error => e instanceof Error}
        fallback={(error) => <p data-testid="outer-panel">{(error as Error).message}</p>}
      >
        {() => (
          <Failed
            for={(e: unknown): e is RangeError => e instanceof RangeError}
            fallback={() => <p data-testid="inner-panel">inner</p>}
          >
            {() => (
              <button
                data-testid="trigger"
                on:click={() =>
                  action(function* () {
                    yield* read(Promise.reject(new TypeError('boom')))
                  })
                }
              >
                trigger
              </button>
            )}
          </Failed>
        )}
      </Failed>
    ),
    target,
  )

  const button = target.querySelector('[data-testid="trigger"]') as HTMLButtonElement
  button.click()
  await tick()
  flush()

  expect(target.querySelector('[data-testid="inner-panel"]')).toBeNull()
  expect(target.querySelector('[data-testid="outer-panel"]')?.textContent).toBe('boom')
})

test('a mutation triggered from a reference-keyed row still reaches a filtered <Failed>, even though its own write recreates that row', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  type Item = { id: number; done: boolean }
  const [items] = signal<Item[]>([{ id: 1, done: false }])
  const [overlay, setOverlay] = optimistic(items)
  let rowDisposals = 0

  function toggle(item: Item) {
    action(function* () {
      setOverlay(
        committed(() => overlay()).map((each) =>
          each.id === item.id ? { ...each, done: !each.done } : each,
        ),
      )
      yield* read(Promise.reject(new Error('server refused')))
    })
  }

  render(
    () => (
      <Failed
        for={(e: unknown): e is Error => e instanceof Error}
        fallback={(error) => <p data-testid="error-panel">{(error as Error).message}</p>}
      >
        {() => (
          <ul>
            <For each={overlay}>
              {(item: Item) => {
                onCleanup(() => {
                  rowDisposals++
                })
                return (
                  <li>
                    <button data-testid={`toggle-${item.id}`} on:click={() => toggle(item)}>
                      toggle
                    </button>
                  </li>
                )
              }}
            </For>
          </ul>
        )}
      </Failed>
    ),
    target,
  )

  const button = target.querySelector('[data-testid="toggle-1"]') as HTMLButtonElement
  button.click()
  flush()

  // Confirms the premise, same as the equivalent unfiltered test from the
  // earlier session's work: the row that triggered the mutation really was
  // torn down by the mutation's own optimistic write, not merely assumed to.
  expect(rowDisposals).toBe(1)

  await tick()
  flush()

  // The failure still reached the filtered boundary regardless — proving
  // the multi-candidate restructuring did not regress the disposal-anchor
  // fix this exact scenario exists to guard.
  expect(target.querySelector('[data-testid="error-panel"]')).not.toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/async-action.test.ts test/dom/failed.test.tsx -t "action\(\)|reference-keyed row still reaches a filtered"`

Expected: FAIL — `action()`'s current implementation resolves to one `FailedScope` eagerly with no filter check at all, so the "skips a nearer... declines" tests fail (the inner, declining boundary still claims the error). The `catchError`-stop test and the reference-keyed-row test may currently pass by coincidence (today's single-candidate `action()` already stops at a `catchError` and already handles the unfiltered reference-keyed case) — note which of the five actually fail before proceeding, so Step 4's "now passes" check is meaningful for each one specifically.

- [ ] **Step 3: Restructure `action()` to collect candidates at call time and pick one at failure time**

In `src/scope.ts`, find:

```ts
export function action(body: () => Generator<unknown, void, unknown>): ActionHandle
export function action(body: () => Promise<void>): ActionHandle
export function action(body: () => void): ActionHandle
export function action(body: () => unknown): ActionHandle {
  const [error, setError] = makeErrorCell()
  // Captured once, at the moment action() is called — the owner ambient here
  // is what determines which <Failed> boundary (if any) a failure reaches.
  // For a call made from inside an on: event handler, this is the owner that
  // was captured and restored when the handler was bound (see bindProp in
  // src/dom/bindings.ts), not whatever happens to be ambient when the DOM
  // event actually fires.
  const found = findNearestFailedScope(getOwner())
  const failedScope = found?.scope ?? null
  let controller: BindingController | null = null
  // Set once, by the onCleanup below, when the BOUNDARY (not the calling
  // owner) is disposed. Anchoring to the boundary rather than to whichever
  // component happened to call action() matters for optimistic UI: a write
  // this action makes can itself dispose and recreate the very row that
  // triggered it (a reference-keyed <For> re-keys on object identity, and an
  // optimistic write typically produces a fresh object), well before the
  // request settles. That row's disposal says nothing about whether anyone
  // is still around to see the failure — the boundary is what answers that,
  // since it can easily still be mounted with the row just rebuilt under it.
  let disposed = false
  let currentSettled: Promise<void>
  // Bumped at the start of every attempt (the initial run and every retry).
  // Read back inside the settle handlers below to tell whether the attempt
  // that just settled is still the current one — a slower, superseded
  // attempt from an earlier retry() call must not overwrite error() with
  // its own outcome once a newer attempt has already reported its own.
  let generation = 0

  const ensureController = (): BindingController | null => {
    if (controller === null && failedScope !== null) controller = failedScope.register()
    return controller
  }

  const runAttempt = (): Promise<void> => {
    const myGeneration = ++generation
    setError(null)
    const scope = createScope(getCurrentScope(), 'speculative')
    const attempt = isGeneratorFunction(body)
      ? driveGeneratorAction(scope, body as () => Generator<unknown, void, unknown>)
      : driveNonGeneratorAction(scope, body)
    return attempt.then(
      () => {
        if (myGeneration !== generation) return
        setError(null)
        // Succeeded — an action is one-shot, so once it has genuinely
        // succeeded there is nothing left for the boundary to keep tracking.
        controller?.report({ status: 'idle' })
        controller?.unregister()
        controller = null
      },
      (e: unknown) => {
        if (myGeneration !== generation) return
        setError(e)
        if (disposed) return
        ensureController()?.report({ status: 'failed', error: e, source: null, retry })
      },
    )
  }

  function retry(): void {
    currentSettled = runAttempt()
  }

  // Runs even if this action never fails: unregisters a live controller if
  // the BOUNDARY is disposed before the current attempt settles, so a
  // boundary unmounting mid-action does not leave a stale entry in its own
  // (now-gone) collection. Also flips `disposed`, which the failure branch
  // above checks — see its comment. Registered on the boundary's own owner,
  // not the ambient one action() was called under — see the comment on
  // `disposed` above for why.
  if (found !== null) {
    runWithOwner(found.owner, () => {
      onCleanup(() => {
        disposed = true
        controller?.unregister()
      })
    })
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
```

Replace with:

```ts
export function action(body: () => Generator<unknown, void, unknown>): ActionHandle
export function action(body: () => Promise<void>): ActionHandle
export function action(body: () => void): ActionHandle
export function action(body: () => unknown): ActionHandle {
  const [error, setError] = makeErrorCell()
  // Every <Failed> between the calling owner and the nearest catchError (or
  // the root) — collected ONCE, at the moment action() is called, exactly
  // like the single-candidate version this replaces. Filtering by error
  // type needs the error itself to pick a winner, and the error does not
  // exist until an attempt later fails — so discovery still happens
  // eagerly, at call time, while the calling owner (e.g. a reference-keyed
  // row) is still guaranteed alive; only the FINAL PICK among these already-
  // collected candidates is deferred to failure time. action() never talks
  // to catchError itself: the walk below stops, unconditionally, the moment
  // it reaches one, without checking its own for and without invoking it —
  // matching today's behaviour, where an action failure with no <Failed>
  // found is not routed anywhere either.
  const candidates = collectFailedCandidates(getOwner())
  let claimedCandidate: FailedCandidate | null = null
  let controller: BindingController | null = null
  let disposed = false
  let currentSettled: Promise<void>
  // Bumped at the start of every attempt (the initial run and every retry).
  // Read back inside the settle handlers below to tell whether the attempt
  // that just settled is still the current one — a slower, superseded
  // attempt from an earlier retry() call must not overwrite error() with
  // its own outcome once a newer attempt has already reported its own.
  let generation = 0

  // One disposal guard per candidate, installed now — while every one of
  // them is still guaranteed alive, exactly like the single-candidate
  // version's guard was. A candidate that never ends up claimed just marks
  // itself disposed; the one that does gets its controller unregistered
  // through the same check that used to run unconditionally.
  for (const candidate of candidates) {
    runWithOwner(candidate.owner, () => {
      onCleanup(() => {
        candidate.disposed = true
        if (claimedCandidate === candidate) {
          disposed = true
          controller?.unregister()
        }
      })
    })
  }

  const runAttempt = (): Promise<void> => {
    const myGeneration = ++generation
    setError(null)
    const scope = createScope(getCurrentScope(), 'speculative')
    const attempt = isGeneratorFunction(body)
      ? driveGeneratorAction(scope, body as () => Generator<unknown, void, unknown>)
      : driveNonGeneratorAction(scope, body)
    return attempt.then(
      () => {
        if (myGeneration !== generation) return
        setError(null)
        // Succeeded — an action is one-shot, so once it has genuinely
        // succeeded there is nothing left for the boundary to keep tracking.
        controller?.report({ status: 'idle' })
        controller?.unregister()
        controller = null
        claimedCandidate = null
      },
      (e: unknown) => {
        if (myGeneration !== generation) return
        setError(e)
        if (disposed) return
        // Deliberately does not re-run this search on a later retry once a
        // candidate has already claimed an earlier failure — the same
        // controller is reused across retries (report()'s own dedup already
        // relies on this), so the claim stays put too.
        if (claimedCandidate === null) {
          claimedCandidate =
            candidates.find(
              (c) => !c.disposed && (c.scope.for === undefined || c.scope.for(e)),
            ) ?? null
        }
        if (claimedCandidate !== null) {
          controller ??= claimedCandidate.scope.register()
          controller.report({ status: 'failed', error: e, source: null, retry })
        }
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

interface FailedCandidate {
  readonly owner: Owner
  readonly scope: FailedScope
  disposed: boolean
}

/** Walk up from `start`, collecting every `<Failed>` boundary in nearest-
 *  first order, stopping unconditionally at the first `catchError` (action()
 *  never reaches past one, and never invokes it — see action()'s own doc
 *  comment). Does not check any filter itself: that happens later, in
 *  action()'s own failure branch, once the error is known. */
function collectFailedCandidates(start: Owner | null): FailedCandidate[] {
  const candidates: FailedCandidate[] = []
  let owner = start
  while (owner !== null) {
    if (owner.boundaries.failed !== null) {
      candidates.push({ owner, scope: owner.boundaries.failed, disposed: false })
    }
    if (owner.errorHandler !== null) break
    owner = owner.parent
  }
  return candidates
}
```

Update the import line at the top of `src/scope.ts`. Find:

```ts
import { findNearestFailedScope, getOwner, onCleanup, runWithOwner, type BindingController } from './owner'
```

Replace with:

```ts
import { getOwner, onCleanup, runWithOwner, type BindingController, type FailedScope, type Owner } from './owner'
```

(`findNearestFailedScope` is no longer used in this file — `action()` now uses `collectFailedCandidates`, defined locally, instead. `FailedScope` and `Owner` are newly needed as types for `FailedCandidate`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/async-action.test.ts test/dom/failed.test.tsx`

Expected: PASS — every test in both files, including all pre-existing ones (this task's changes to `action()` must not alter behavior for the unfiltered case at all) and the new ones from this task and Task 3/4.

- [ ] **Step 5: Run the full repo typecheck**

Run: `pnpm typecheck`

Expected: PASS, no errors anywhere (this is the point where `src/scope.ts`'s own contribution to the typecheck failure noted at the end of Task 2 is resolved).

- [ ] **Step 6: Sabotage-verify the disposal-guard timing**

This is the highest-risk part of this whole plan — confirm it is actually load-bearing, not just present.

Temporarily change the candidate disposal-guard loop to run lazily instead of eagerly — move it from before `runAttempt()`'s first call to inside the failure branch, right after a candidate is claimed:

```ts
      (e: unknown) => {
        if (myGeneration !== generation) return
        setError(e)
        if (disposed) return
        if (claimedCandidate === null) {
          claimedCandidate =
            candidates.find(
              (c) => !c.disposed && (c.scope.for === undefined || c.scope.for(e)),
            ) ?? null
          // SABOTAGE: disposal guard moved here, installed lazily instead of
          // eagerly at action() call time
          if (claimedCandidate !== null) {
            runWithOwner(claimedCandidate.owner, () => {
              onCleanup(() => {
                claimedCandidate!.disposed = true
                disposed = true
                controller?.unregister()
              })
            })
          }
        }
        if (claimedCandidate !== null) {
          controller ??= claimedCandidate.scope.register()
          controller.report({ status: 'failed', error: e, source: null, retry })
        }
      },
```

(Remove the original `for (const candidate of candidates) { runWithOwner(...) }` loop entirely while testing this — it would otherwise still install the guards eagerly and mask the regression.)

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: at minimum, `'a mutation triggered from a reference-keyed row still reaches a filtered <Failed>, even though its own write recreates that row'` fails or errors — the row is disposed and rebuilt by its own optimistic write before the request settles, so by the time the failure branch runs and tries to register the lazy guard on `claimedCandidate.owner` (the boundary, which is fine) the *reasoning* for anchoring early no longer holds for cases where the calling owner itself was needed at discovery time; confirm by running the test that something breaks, and read the actual failure message before treating this as confirmed — the specific error may differ from the original `07343a9`-era bug, since this is a different code path than the one that originally motivated the disposal-anchor fix. If nothing fails, stop and reconsider the sabotage — it needs to demonstrably matter, not just look different.

Restore the eager version (delete the sabotage block, restore the original `for (const candidate of candidates) { ... }` loop before `runAttempt()`'s first call), and re-run:

Run: `pnpm exec vitest run test/dom/failed.test.tsx test/async-action.test.ts`

Expected: all tests pass again.

- [ ] **Step 7: Sabotage-verify the filter-skipping walk**

Temporarily remove the filter check in `action()`'s candidate-picking, always claiming the first candidate regardless of `for`:

```ts
        if (claimedCandidate === null) {
          // SABOTAGE: filter check removed
          claimedCandidate = candidates.find((c) => !c.disposed) ?? null
        }
```

Run: `pnpm exec vitest run test/dom/failed.test.tsx -t "action\(\) skips a nearer"`

Expected: FAIL — `'action() skips a nearer <Failed> whose for declines the error, and registers with a farther one that accepts'` fails (the inner, declining boundary now wrongly claims it), while unrelated tests in the file are unaffected.

Restore the filter check and re-run:

Run: `pnpm exec vitest run test/dom/failed.test.tsx`

Expected: all tests pass again.

- [ ] **Step 8: Run the full repo test suite**

Run: `pnpm test`

Expected: every test file passes, including all 51+ pre-existing files untouched by this plan.

- [ ] **Step 9: Commit**

```bash
git add src/scope.ts test/async-action.test.ts test/dom/failed.test.tsx
git commit -m "$(cat <<'EOF'
feat: action() collects every candidate boundary, picks one once the error is known

action() used to resolve to one FailedScope eagerly, at call time,
before the request it's guarding even runs — necessary so it can find
the calling row's boundary before an optimistic write recycles that
row. Filtering by error type needs the error itself to decide which
boundary wins, and the error doesn't exist until the attempt later
fails.

Splits the two concerns instead of moving discovery later wholesale:
action() still walks exactly once, at call time, but now collects
every <Failed> between the calling owner and the nearest catchError
(stopping there unconditionally, without invoking it — action() has
never talked to catchError and still doesn't), installing each
candidate's disposal guard immediately, while everything is still
guaranteed alive. Only the final pick among these already-collected
candidates waits for the error to exist. A retry's later failure
re-reports to whichever candidate already claimed the first one,
rather than re-running the search.

Sabotage-verified both the disposal-guard timing (moving it lazy
breaks the reference-keyed-row regression case) and the filter check
itself (removing it breaks the declining-boundary test), each in
isolation, with the rest of the suite unaffected either time.
EOF
)"
```

---

### Task 6: Final verification pass

**Files:** none (verification only)

**Interfaces:** none — this task confirms Tasks 1-5 together, it does not add behavior.

- [ ] **Step 1: Run the complete repo test suite**

Run: `pnpm test`

Expected: every test file passes. Compare the total against the baseline recorded immediately before this plan's Task 1 began (confirm by running `pnpm test` if that baseline was not already noted) — this plan adds: 4 (Task 1) + 5 (Task 2) + 1 (Task 3, becomes passing at the end of Task 4) + 3 (Task 4: the narrowing file has no runtime tests, so 0 vitest tests from it) + 5 (Task 5: 3 in `test/async-action.test.ts`, 2 in `test/dom/failed.test.tsx`) = 15 new passing vitest tests, 0 removed.

- [ ] **Step 2: Run the repo typecheck**

Run: `pnpm typecheck`

Expected: PASS, no errors — including `test/dom/failed-narrowing.typecheck.tsx`'s own two `@ts-expect-error` directives resolving correctly.

- [ ] **Step 3: Run the `examples/todo-async` Playwright suite**

Run: `cd examples/todo-async && pnpm exec playwright test`

Expected: all 8 tests pass unchanged — this plan does not touch `examples/todo-async` at all (out of scope, per the Global Constraints), so this step only confirms nothing in `src/` regressed the demo incidentally.

- [ ] **Step 4: Confirm no stray sabotage artifacts remain**

Run: `git status --short`

Expected: clean. Task 5's Steps 6 and 7 each explicitly restore the pre-sabotage version and re-run before that task's own commit step, so nothing should be outstanding here.

- [ ] **Step 5: Commit any final cleanup**

If Step 4 found nothing, there is nothing to commit — this step only applies if some stray change was found and needed restoring.

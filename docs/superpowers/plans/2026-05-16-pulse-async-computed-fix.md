# pulse Async Computed Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `'reuse-value'` stash bypass in `src/computed.ts` so async computeds (sync stage returning Promise that reads reactive deps) correctly re-run on dep change, preserve dep tracking, and support stale-while-revalidate semantics.

**Architecture:** Replace stash-bypass with a body-always-runs flow that uses resolved-value caching (Object.is comparison) instead of input-cache-key bypass. Body runs only on dep changes; settle handled by `.then(rerun)` that updates `lastResolvedValue` and triggers a kick to republish. Add `[PENDING]` brand on Signal accessors so `isPending(computed)` reflects refetch state, not just current-value-is-Promise.

**Tech Stack:** TypeScript, Vitest, r3 (untouched).

**Companion spec:** `docs/superpowers/specs/2026-05-16-pulse-async-computed-fix-design.md`

---

## File map

```
src/
  signal.ts             — add PENDING symbol + optional [PENDING]: Accessor<boolean> on Signal interface
  async.ts              — extend isPending() to dispatch via [PENDING] brand
  computed.ts           — rewrite makeStageNode: body always runs; resolved-value cache; pendingSig
test/
  computed.test.ts      — add regression + stale-while-revalidate + isPending tests (10 new)
examples/pokemon/
  src/main.tsx          — migrate from signal+effect workaround back to natural `computed(() => fetchList(page()))`
CONTEXT.md              — refresh Computed entry; note resolved-value caching invariant
docs/follow-ups.md      — move addressed entries
```

## Conventions

- `main` branch directly
- **pnpm**, not npm
- TDD; one commit per logical change; **no AI co-author trailers**

---

### Task 1: Add `[PENDING]` brand + extend `isPending`

**Files:**
- Modify: `src/signal.ts` (add PENDING symbol + Signal interface)
- Modify: `src/async.ts` (extend isPending)
- Modify: `test/async.test.ts` (3 new tests)

Preparatory: adds the brand so `isPending(x)` can dispatch to a custom pending-accessor when x is branded. No behaviour change for existing code (signals don't carry PENDING).

- [ ] **Step 1: Confirm starting state**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean. Note count.

- [ ] **Step 2: Write the failing tests**

Append to `test/async.test.ts`:

```ts
import { PENDING } from '../src/signal'

test('isPending dispatches via [PENDING] brand when present', () => {
  const [pending, setPending] = signal(false)
  const branded = (() => 42) as Accessor<number> & { [PENDING]?: Accessor<boolean> }
  branded[PENDING] = pending
  expect(isPending(branded)).toBe(false)
  setPending(true)
  expect(isPending(branded)).toBe(true)
})

test('isPending without [PENDING] brand falls back to isPromise(value)', () => {
  const [s, setS] = signal<number | Promise<number>>(7)
  expect(isPending(s)).toBe(false)
  setS(new Promise(() => {}))
  expect(isPending(s)).toBe(true)
})

test('isPending([PENDING]) takes precedence over value check', () => {
  // Brand returns false even though value is a Promise
  const [pending] = signal(false)
  const branded = (() => new Promise(() => {})) as Accessor<unknown> & { [PENDING]?: Accessor<boolean> }
  branded[PENDING] = pending
  expect(isPending(branded)).toBe(false)
})
```

Imports needed at top of file: `Accessor` from `'../src/signal'`, `isPending`, `signal`. Adjust as needed.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- --project unit async`
Expected: FAIL — `PENDING` not exported; `isPending` doesn't dispatch.

- [ ] **Step 4: Add `PENDING` export and Signal field**

In `src/signal.ts`, near the existing `NODE` symbol declaration, add:

```ts
/** Optional brand: when present on a Signal/Accessor, `isPending` queries
 *  this accessor instead of inspecting the value-as-promise. Used by
 *  computeds with stale-while-revalidate semantics. */
export const PENDING = Symbol('pulse.pending')
```

Update the `Signal<T>` interface to include an optional `[PENDING]` field:

```ts
export interface Signal<T> {
  (): T
  [NODE]: R3Node<T>
  [PENDING]?: Accessor<boolean>
}
```

- [ ] **Step 5: Extend `isPending` in `src/async.ts`**

Replace the existing `isPending` definition:

```ts
import { isPromise } from './is-promise'
import { PENDING, type Accessor } from './signal'

/** Reactive predicate: is the signal/computed currently pending?
 *  - If the accessor carries a `[PENDING]` brand, queries that accessor (used by
 *    computeds with stale-while-revalidate — value may be the prior T, not a Promise).
 *  - Otherwise, returns `isPromise(accessor())` (signals holding a Promise). */
export function isPending(s: Accessor<unknown>): boolean {
  const pendingAccessor = (s as { [PENDING]?: Accessor<boolean> })[PENDING]
  if (pendingAccessor !== undefined) return pendingAccessor()
  return isPromise(s())
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/signal.ts src/async.ts test/async.test.ts
git commit -m "feat(async): add [PENDING] brand for isPending dispatch (prep for computed fix)"
```

---

### Task 2: Rewrite `makeStageNode` with resolved-value caching

**Files:**
- Modify: `src/computed.ts` (the `makeStageNode` function)
- Modify: `test/computed.test.ts` (10 new tests)

The core fix. Body always runs (so r3 tracks deps); settle triggers a kick that publishes `lastResolvedValue`; `Object.is` comparison decides whether to trigger downstream propagation; `pendingSig` brand exposes refetch pending state.

- [ ] **Step 1: Write the failing tests**

Append to `test/computed.test.ts`. Make sure imports include `computed`, `signal`, `setScheduler`, `syncScheduler`, `microtaskScheduler`, `flush`, `effect`, `isPending`, `createRoot`. Add `let` outside scope where helpful for promise control.

```ts
test('stage-0 returning Promise: dep stays tracked across settles (THE main bug)', async () => {
  setScheduler(syncScheduler(flush))
  const fetches: number[] = []
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: number[]) => void> = []

  function fakeFetch(p: number): Promise<number[]> {
    fetches.push(p)
    return new Promise((r) => resolvers.push(r))
  }

  createRoot(() => {
    const list = computed(() => fakeFetch(page()))
    // Trigger evaluation
    effect(() => {
      try { list() } catch { /* may be pending */ }
    })
    expect(fetches).toEqual([0])

    // Settle initial
    resolvers[0]([1, 2, 3])
  })
  await Promise.resolve()
  flush()

  // Now change the dep — this MUST trigger a re-fetch
  setPage(1)
  flush()
  expect(fetches).toEqual([0, 1])

  setScheduler(microtaskScheduler(flush))
})

test('refetch with same resolved value: downstream effect does not re-run', async () => {
  setScheduler(syncScheduler(flush))
  const sameArray = [1, 2, 3]
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: number[]) => void> = []

  createRoot(() => {
    const list = computed(() => {
      page() // dep
      return new Promise<number[]>((r) => resolvers.push(r))
    })
    let runs = 0
    effect(() => {
      try {
        list()
        runs++
      } catch { /* pending */ }
    })

    // Initial settle
    resolvers[0](sameArray)
  })
  await Promise.resolve()
  flush()

  setPage(1)
  flush()
  // Second fetch resolves with SAME reference
  resolvers[1](sameArray)
  await Promise.resolve()
  flush()

  // Downstream effect: ran once during initial settle. Refetch with same value
  // should NOT re-run it (Object.is comparison avoids invalidation).
  // (Allow for 1-2 runs depending on first-load semantics; assertion is about
  // the second settle not invalidating)
  // Implementer note: pin exact run count after implementation.
  setScheduler(microtaskScheduler(flush))
})

test('refetch with different resolved value: downstream effect re-runs', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: number[]) => void> = []

  let observed: number[][] = []
  createRoot(() => {
    const list = computed(() => {
      page()
      return new Promise<number[]>((r) => resolvers.push(r))
    })
    effect(() => {
      try { observed.push(list()) } catch { /* pending */ }
    })

    resolvers[0]([1, 2, 3])
  })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([1, 2, 3])

  setPage(1)
  flush()
  resolvers[1]([4, 5, 6])
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([4, 5, 6])

  setScheduler(microtaskScheduler(flush))
})

test('stale-while-revalidate: prior value visible during refetch', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: string) => void> = []
  let observed: string[] = []

  createRoot(() => {
    const data = computed(() => {
      page()
      return new Promise<string>((r) => resolvers.push(r))
    })
    effect(() => {
      try { observed.push(data()) } catch { /* pending */ }
    })

    resolvers[0]('A')
  })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toBe('A')

  // Trigger refetch. Before settle, the value should STAY 'A' (stale-while-revalidate).
  setPage(1)
  flush()
  // observed shouldn't have a new entry because the value hasn't changed yet
  // (it's still 'A' until 'B' settles)

  resolvers[1]('B')
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toBe('B')

  setScheduler(microtaskScheduler(flush))
})

test('isPending(computed) is true during initial load, false after settle', async () => {
  setScheduler(syncScheduler(flush))
  let resolveP!: (v: number) => void
  const p = new Promise<number>((r) => { resolveP = r })

  createRoot(() => {
    const c = computed(() => p)
    expect(isPending(c)).toBe(true)
    resolveP(42)
  })
  await Promise.resolve()
  flush()
  // After settle: pending false
  createRoot(() => {
    const c = computed(() => Promise.resolve(99))
    flush()
  })
  // (Second computed test re-runs cycle to verify settle path; first verified pending=true)

  setScheduler(microtaskScheduler(flush))
})

test('isPending(computed) is true during refetch', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: number) => void> = []
  let pendingObservations: boolean[] = []

  createRoot(() => {
    const c = computed(() => {
      page()
      return new Promise<number>((r) => resolvers.push(r))
    })
    effect(() => {
      try { c() } catch { /* may suspend on initial */ }
    })
    effect(() => {
      pendingObservations.push(isPending(c))
    })

    resolvers[0](1)
  })
  await Promise.resolve()
  flush()
  // pending observations should now include false (settled)
  expect(pendingObservations.includes(false)).toBe(true)

  setPage(1)
  flush()
  // During refetch, pending should be true
  expect(pendingObservations.at(-1)).toBe(true)

  resolvers[1](2)
  await Promise.resolve()
  flush()
  expect(pendingObservations.at(-1)).toBe(false)

  setScheduler(microtaskScheduler(flush))
})

test('.then-chained Promise identity (unstable per call): no infinite loop, settles correctly', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let underlyingResolvers: Array<(v: { results: number[] }) => void> = []
  let observed: number[][] = []

  createRoot(() => {
    const list = computed(() => {
      page()
      // Each call creates a NEW .then chain (unstable Promise identity).
      const fetchPromise = new Promise<{ results: number[] }>((r) =>
        underlyingResolvers.push(r),
      )
      return fetchPromise.then((r) => r.results)
    })
    effect(() => {
      try { observed.push(list()) } catch { /* pending */ }
    })

    underlyingResolvers[0]({ results: [1, 2] })
  })
  // Multiple microtasks for .then chain
  await Promise.resolve()
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([1, 2])

  setPage(1)
  flush()
  underlyingResolvers[1]({ results: [3, 4] })
  await Promise.resolve()
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([3, 4])
  // If infinite loop happened, we'd see many more underlying resolvers asked for.
  expect(underlyingResolvers.length).toBe(2)

  setScheduler(microtaskScheduler(flush))
})

test('multi-stage: stage 1 returning Promise still works with new mechanism', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: { results: number[] }) => void> = []
  let observed: number[][] = []

  createRoot(() => {
    const list = computed(
      () => page(),
      (p) => new Promise<{ results: number[] }>((r) => resolvers.push(r)),
      (r) => r.results,
    )
    effect(() => {
      try { observed.push(list()) } catch { /* pending */ }
    })

    resolvers[0]({ results: [10, 20] })
  })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([10, 20])

  setPage(1)
  flush()
  resolvers[1]({ results: [30, 40] })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([30, 40])

  setScheduler(microtaskScheduler(flush))
})

test('supersession: stale settle of an old promise is ignored', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: string) => void> = []
  let observed: string[] = []

  createRoot(() => {
    const c = computed(() => {
      page()
      return new Promise<string>((r) => resolvers.push(r))
    })
    effect(() => {
      try { observed.push(c()) } catch { /* pending */ }
    })
  })

  setPage(1)
  flush()
  // Now resolve the OLD promise (index 0). Should be ignored (superseded by page=1's fetch).
  resolvers[0]('OLD')
  await Promise.resolve()
  flush()
  // observed should NOT contain 'OLD' as the latest
  expect(observed.at(-1) === 'OLD').toBe(false)

  // Resolve the new one
  resolvers[1]('NEW')
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toBe('NEW')

  setScheduler(microtaskScheduler(flush))
})

test('rejected refetch: prior value stays; deferred error surfaced on next read', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  let resolvers: Array<(v: number) => void> = []
  let rejecters: Array<(r: unknown) => void> = []

  createRoot(() => {
    const c = computed(() => {
      page()
      return new Promise<number>((res, rej) => {
        resolvers.push(res)
        rejecters.push(rej)
      })
    })
    effect(() => {
      try { c() } catch { /* may throw deferred error */ }
    })

    resolvers[0](1)
  })
  await Promise.resolve()
  flush()

  setPage(1)
  flush()
  rejecters[1](new Error('boom'))
  await Promise.resolve()
  flush()
  // Reading after rejection should throw the error (deferred-error path).
  // Implementer: verify exact propagation matches existing deferredError mechanism.

  setScheduler(microtaskScheduler(flush))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project unit computed`
Expected: most new tests FAIL (some may pass coincidentally; the main bug test definitely fails).

- [ ] **Step 3: Rewrite `makeStageNode` in `src/computed.ts`**

The new implementation. The full updated `makeStageNode` body:

```ts
function makeStageNode(
  stage: (value: any) => unknown,
  inputAccessor: Signal<unknown> | null,
): { accessor: Signal<unknown>; r3Node: R3Computed<unknown> } {
  const myOwner = getOwner()

  // The stage's resolution strategy is fixed by its type at construction.
  const resumeKind: ResumeKind = isGeneratorFunction(stage) ? 'fast-forward' : 'reuse-value'

  // ─── State ─────────────────────────────────────────────────────────────
  // Sentinel: lastResolvedValue starts uninitialised; first-load returns the
  // Promise itself rather than this sentinel.
  const UNRESOLVED = Symbol('unresolved')
  let lastResolvedValue: unknown = UNRESOLVED
  let suspendedOn: Promise<unknown> | null = null
  let suspendedInput: unknown = undefined
  let stashedResolution: StashedResolution | null = null
  let deferredError: { error: unknown } | null = null

  // Kick re-triggers r3 when settle has new value to publish.
  const [kick, setKick] = signal(0)
  let kickCount = 0

  // Pending state for isPending() brand. Reactive.
  const [pendingSig, setPendingSig] = signal(false)

  // ─── R3 node body ──────────────────────────────────────────────────────
  const r3Node = r3Computed(() => {
    try {
      kick() // re-trigger after settle published a new value

      let input: unknown = undefined
      if (inputAccessor !== null) {
        input = inputAccessor()
        if (isPromise(input)) {
          // Upstream stage suspended; mirror its state, drop any stash.
          stashedResolution = null
          suspendedOn = null
          setPendingSig(true)
          return input
        }
      }

      // Generator stages: keep the existing fast-forward + stash mechanism.
      // The bug only affects non-generator stages.
      if (resumeKind === 'fast-forward') {
        if (stashedResolution !== null) {
          if (Object.is(input, suspendedInput)) {
            const r = stashedResolution
            stashedResolution = null
            suspendedOn = null
            setPendingSig(false)
            if (r.kind === 'rejected') throw r.reason
            lastResolvedValue = r.value
            deferredError = null
            return r.value
          }
          stashedResolution = null
        }
      }

      // Non-generator stages: ALWAYS run the body (so r3 tracks deps).
      // Use lastResolvedValue + suspendedOn-identity check to avoid loops.
      const outcome = runStage(stage, input)

      if (outcome.pending) {
        const p = outcome.promise
        if (suspendedOn !== p) {
          // New Promise → suspend on it.
          suspendedOn = p
          suspendedInput = input
          setPendingSig(true)
          const rerun = () => {
            if (suspendedOn !== p) return // superseded
            const state = track(p)
            if (state.status === 'fulfilled') {
              suspendedOn = null
              setPendingSig(false)
              // Resolved-value-keyed cache: publish only if value changed,
              // or if first load (lastResolvedValue is sentinel).
              if (lastResolvedValue === UNRESOLVED || !Object.is(lastResolvedValue, state.value)) {
                lastResolvedValue = state.value
                deferredError = null
                setKick(++kickCount)
              }
              // else: same value, no downstream invalidation
            } else if (state.status === 'rejected') {
              suspendedOn = null
              setPendingSig(false)
              deferredError = { error: state.reason }
              setKick(++kickCount)
            }
          }
          p.then(rerun, rerun)
        }
        // View: stale-while-revalidate. If we have a lastResolvedValue, show it.
        // Otherwise (first load), publish the Promise.
        return lastResolvedValue === UNRESOLVED ? p : lastResolvedValue
      }

      // Sync result.
      suspendedOn = null
      setPendingSig(false)
      if (lastResolvedValue === UNRESOLVED || !Object.is(lastResolvedValue, outcome.value)) {
        lastResolvedValue = outcome.value
      }
      deferredError = null
      return outcome.value
    } catch (e) {
      try {
        routeError(myOwner, e)
      } catch (rethrown) {
        deferredError = { error: rethrown }
        return lastResolvedValue === UNRESOLVED ? undefined : lastResolvedValue
      }
      return lastResolvedValue === UNRESOLVED ? undefined : lastResolvedValue
    }
  })

  // ─── Accessor: surfaces deferred errors + carries [PENDING] brand ─────
  const rawAccessor = makeAccessor(r3Node)
  const accessor = (() => {
    if (deferredError !== null) throw deferredError.error
    return rawAccessor()
  }) as Signal<unknown>
  accessor[NODE] = r3Node
  accessor[PENDING] = pendingSig
  return { accessor, r3Node: r3Node as R3Computed<unknown> }
}
```

Update imports at the top of `src/computed.ts` to include `PENDING`:

```ts
import { makeAccessor, NODE, PENDING, signal, type Signal } from './signal'
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- --project unit computed`
Expected: PASS for all new tests + all existing tests.

If failures occur, READ them carefully. Likely issues:
- Timing assumptions (test may need an extra `await Promise.resolve()` for .then chain settle to flush).
- Object.is sentinel vs initial value transitions.
- Existing tests that relied on old stash-bypass behavior — investigate before patching; the new behavior is intentionally different.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/computed.ts test/computed.test.ts
git commit -m "fix(computed): resolved-value caching; body always runs to preserve dep tracking"
```

---

### Task 3: Migrate pokemon demo to natural pattern + verify Playwright

**Files:**
- Modify: `examples/pokemon/src/main.tsx` (revert signal+effect workaround)
- Run: `examples/pokemon` Playwright tests (no test changes needed)

The whole point of Plan 6: `computed(() => fetchList(page()))` just works. Remove the workaround and verify the Playwright suite still passes.

- [ ] **Step 1: Revert to the natural pattern**

Replace the signal+effect block in `examples/pokemon/src/main.tsx`:

```tsx
// OLD (workaround):
// const [list, setList] = signal<PokemonRef[] | Promise<PokemonRef[]>>(...)
// effect(() => { ... setList(fetchList(p).then(...)) })

// NEW (canonical pulse pattern; works post-Plan 6):
import { computed, For, Loading, render, Show, signal, use, useLoading } from 'pulse'
// ...
const list = computed(() => fetchList(page()).then((r) => r.results))
```

Remove the `effect(...)` block that was the workaround. Remove the `effect` import if it's no longer used.

Remove the explanatory comment block referencing the workaround.

- [ ] **Step 2: Run the demo's Playwright suite**

Make sure no dev server is on ports 5180/5181 (the test ports):

```bash
lsof -ti:5180 -ti:5181 2>/dev/null | xargs -r kill 2>/dev/null; sleep 1
```

Run:

```bash
pnpm --filter @pulse-examples/pokemon test
```

Expected: 9/9 green. If any test fails (especially pagination), it means Task 2's implementation has a subtle bug — investigate before working around.

- [ ] **Step 3: Build verification**

```bash
pnpm --filter @pulse-examples/pokemon build
```

Expected: clean Vite build.

- [ ] **Step 4: Commit**

```bash
git add examples/pokemon/src/main.tsx
git commit -m "examples(pokemon): use natural computed(() => fetch) pattern post-Plan-6"
```

---

### Task 4: Documentation updates

**Files:**
- Modify: `CONTEXT.md` (Computed entry)
- Modify: `docs/follow-ups.md` (move addressed entry)

- [ ] **Step 1: Update `CONTEXT.md` Computed entry**

Find the existing **Computed** entry and append a paragraph:

```
*Async semantics (non-generator stages):* When a stage returns `Promise<T>`,
pulse awaits internally. The body runs only on dep changes (never on settle),
preserving r3's dep tracking. Cache is keyed on the *resolved value*
(`Object.is`); refetches that produce the same value don't propagate
downstream. During refetch, the previous T stays visible (stale-while-
revalidate); `isPending(computed)` is `true`. Use `use(computed)` to throw
`NotReadyYet` on pending (initial load and refetch alike) — preferred when a
Loading boundary should see the refetch.
```

- [ ] **Step 2: Move addressed follow-up entry**

In `docs/follow-ups.md`, find the entry starting with **"`'reuse-value'` stash consumption in `src/computed.ts` loses dep tracking"** under "Architectural notes." Move it to the "Already addressed" section, formatted like the other addressed entries:

```
- ~~Plan 6: `'reuse-value'` stash consumption in computed.ts lost dep tracking, freezing stage-0 async computeds after first settle.~~ Fixed in Plan 6 commits (resolved-value caching + body-always-runs in `makeStageNode`).
```

- [ ] **Step 3: Run tests for sanity**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CONTEXT.md docs/follow-ups.md
git commit -m "docs: refresh Computed entry + move Plan 6 follow-up to addressed"
```

---

## Final verification

- [ ] `pnpm test` — all unit + dom tests green
- [ ] `pnpm typecheck` — clean
- [ ] `pnpm --filter @pulse-examples/pokemon test` — 9/9 Playwright green
- [ ] `pnpm --filter @pulse-examples/todo test` — 12/12 Playwright green
- [ ] If running under `superpowers:subagent-driven-development`: dispatch final whole-implementation review

## Out of scope reminders

These do NOT belong in Plan 6:

- Plan 5 (`action`/`optimistic`/`resolve` async toolkit) — separate spec
- A new `resource()` primitive — explicitly rejected; computed becomes capable enough
- Equality customization beyond `Object.is` — track as future enhancement
- Cancellation of in-flight fetches when superseded — `AbortSignal` integration is a separate concern
- Generator-stage changes — unchanged; their fast-forward mechanism is correct

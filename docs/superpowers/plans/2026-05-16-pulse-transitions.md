# Pulse Transitions Implementation Plan

**Goal:** Make `computed(() => body)` catch `NotReadyYet` from the body as suspension (SWR), and make `use(accessor)` consult the `[PENDING]` brand so refetching computeds suspend their consumers. Together these enable coherent multi-read snapshots.

**Architecture:** Three small, sequential changes — brand carries resume Promise; `use` consults brand before reading; computed body catches `NotReadyYet`. Pokemon demo migrated to the new pattern.

**Tech Stack:** TypeScript, pulse, r3, vitest, Playwright.

---

### Task 1: `[PENDING]` brand carries `.promise` getter

**Files:**
- Modify: `src/signal.ts` (PENDING type)
- Modify: `src/computed.ts:makeStageNode` (attach `.promise` to pendingSig)

- [ ] **Step 1: Failing test**

In `test/computed.test.ts`, add at end:

```ts
test('[PENDING].promise returns the in-flight Promise during refetch', async () => {
  const [id, setId] = signal(1)
  let release!: (v: string) => void
  const list = computed(() => {
    const i = id()
    if (i === 1) return Promise.resolve(`v:${i}`)
    return new Promise<string>((r) => { release = r })
  })
  await tick()
  expect(list()).toBe('v:1')

  setId(2)                              // refetch begins
  const brand = list[PENDING]!
  expect(brand()).toBe(true)
  expect(brand.promise!()).toBeInstanceOf(Promise)

  release('v:2')
  await tick()
  expect(brand()).toBe(false)
  expect(brand.promise!()).toBeNull()
})
```

Add import: `import { PENDING } from '../src/signal'`.

- [ ] **Step 2: Run — expect failure**

`pnpm test test/computed.test.ts` — expect "brand.promise is not a function" or similar.

- [ ] **Step 3: Widen `[PENDING]` type in `src/signal.ts`**

Change:
```ts
[PENDING]?: Accessor<boolean>
```
to:
```ts
[PENDING]?: Accessor<boolean> & { promise?: () => Promise<unknown> | null }
```

- [ ] **Step 4: Attach `.promise` in `src/computed.ts:makeStageNode`**

Find the accessor assignment near the end of `makeStageNode`:
```ts
accessor[PENDING] = upstreamPending
  ? () => pendingSig() || upstreamPending()
  : pendingSig
```

Replace with:
```ts
const ownBrand = upstreamPending
  ? Object.assign(() => pendingSig() || upstreamPending(), {})
  : pendingSig
;(ownBrand as Accessor<boolean> & { promise: () => Promise<unknown> | null }).promise = () => {
  // Own suspension first; else delegate up the pipeline.
  if (suspendedOn !== null) return suspendedOn
  const up = upstreamPending as (Accessor<boolean> & { promise?: () => Promise<unknown> | null }) | undefined
  return up?.promise?.() ?? null
}
accessor[PENDING] = ownBrand as Accessor<boolean> & { promise: () => Promise<unknown> | null }
```

Note `pendingSig` is already a function; we attach `.promise` directly when there's no upstream. When there's an upstream, we wrap so the function identity is fresh (we don't want to mutate the underlying signal accessor).

Actually simpler — always wrap so we have a stable shape:
```ts
const pendingFn = upstreamPending
  ? () => pendingSig() || upstreamPending()
  : () => pendingSig()
const brand = pendingFn as Accessor<boolean> & { promise: () => Promise<unknown> | null }
brand.promise = () => {
  if (suspendedOn !== null) return suspendedOn
  const up = upstreamPending as (Accessor<boolean> & { promise?: () => Promise<unknown> | null }) | undefined
  return up?.promise?.() ?? null
}
accessor[PENDING] = brand
```

- [ ] **Step 5: Run test — expect pass**

`pnpm test test/computed.test.ts` — green.

- [ ] **Step 6: Run full unit suite**

`pnpm test` — 219+ pass.

- [ ] **Step 7: Commit**

```bash
git add src/signal.ts src/computed.ts test/computed.test.ts
git commit -m "feat(computed): expose in-flight Promise via [PENDING].promise

The brand stays a function (existing Accessor<boolean> shape so isPending
keeps working) and gains a .promise getter that returns the current
suspendedOn Promise, walking up the pipeline if this stage isn't directly
suspended. Use sites that need a Promise to throw NotReadyYet on can
reach it through the brand even when SWR has hidden the Promise behind
a stale value at the publish site."
```

---

### Task 2: `use(accessor)` consults `[PENDING]` brand

**Files:**
- Modify: `src/async.ts:use`
- Test: `test/async.test.ts`

- [ ] **Step 1: Failing test**

In `test/async.test.ts`, add:

```ts
test('use(accessor) throws NotReadyYet when [PENDING] brand is true', async () => {
  const [id, setId] = signal(1)
  let release!: (v: number) => void
  const c = computed(() => {
    const i = id()
    if (i === 1) return Promise.resolve(10)
    return new Promise<number>((r) => { release = r })
  })
  await tick()
  expect(use(c)).toBe(10)

  setId(2)
  // c is mid-refetch: c() still returns 10 (SWR), but use must suspend.
  expect(() => use(c)).toThrow(NotReadyYet)

  release(20)
  await tick()
  expect(use(c)).toBe(20)
})
```

Add import at top: `import { computed } from '../src/computed'`.

- [ ] **Step 2: Run — expect failure**

`pnpm test test/async.test.ts` — expect "expected to throw NotReadyYet, returned 10".

- [ ] **Step 3: Update `use` in `src/async.ts`**

Replace:
```ts
export function use<T>(x: T | Promise<T> | (() => T | Promise<T>)): Awaited<T> {
  if (typeof x === 'function') {
    x = (x as () => T | Promise<T>)()
  }
  if (!isPromise(x)) return x as Awaited<T>
  const state = track(x)
  if (state.status === 'fulfilled') return state.value as Awaited<T>
  if (state.status === 'rejected') throw state.reason
  throw new NotReadyYet(x)
}
```

with:
```ts
export function use<T>(x: T | Promise<T> | (() => T | Promise<T>)): Awaited<T> {
  if (typeof x === 'function') {
    // Accessor form. Consult the [PENDING] brand BEFORE reading — SWR may
    // be hiding an in-flight Promise behind a stale resolved value.
    const brand = (x as { [PENDING]?: Accessor<boolean> & { promise?: () => Promise<unknown> | null } })[PENDING]
    if (brand?.()) {
      const p = brand.promise?.()
      if (p) throw new NotReadyYet(p)
    }
    x = (x as () => T | Promise<T>)()
  }
  if (!isPromise(x)) return x as Awaited<T>
  const state = track(x)
  if (state.status === 'fulfilled') return state.value as Awaited<T>
  if (state.status === 'rejected') throw state.reason
  throw new NotReadyYet(x)
}
```

Add `PENDING` to imports from `./signal` (it's already imported as a type-only marker; bring it as a value).

- [ ] **Step 4: Run test — expect pass**

`pnpm test test/async.test.ts` — green.

- [ ] **Step 5: Full unit suite**

`pnpm test` — confirm 220+ pass.

- [ ] **Step 6: Commit**

```bash
git add src/async.ts test/async.test.ts
git commit -m "feat(use): consult [PENDING] brand on accessor before reading

For an accessor with a [PENDING] brand, check pending state and throw
NotReadyYet(brand.promise()) before calling the accessor. This lets
use() suspend on refetching computeds whose accessor would otherwise
return a stale value via SWR — necessary for coherent multi-read
snapshots inside a computed body."
```

---

### Task 3: `computed(() => body)` catches `NotReadyYet` as suspension

**Files:**
- Modify: `src/computed.ts:makeStageNode` (try/catch around runStage; NotReadyYet → suspension path)
- Test: `test/computed.test.ts`

- [ ] **Step 1: Failing test — coherent snapshot**

```ts
test('computed body suspends on use(pendingComputed) and snapshots coherently', async () => {
  const [page, setPage] = signal(1)
  let release!: (v: string[]) => void
  const list = computed(() => {
    const p = page()
    if (p === 1) return Promise.resolve(['a', 'b'])
    return new Promise<string[]>((r) => { release = r })
  })
  await tick()

  const view = computed(() => ({ page: page(), items: use(list) }))
  expect(view()).toEqual({ page: 1, items: ['a', 'b'] })

  setPage(2)
  // SWR: view's prior snapshot stays visible even though page() returns 2.
  expect(view()).toEqual({ page: 1, items: ['a', 'b'] })
  expect(isPending(view)).toBe(true)

  release(['c', 'd'])
  await tick()
  expect(view()).toEqual({ page: 2, items: ['c', 'd'] })   // atomic commit
  expect(isPending(view)).toBe(false)
})
```

- [ ] **Step 2: Run — expect failure**

The current body wraps runStage; if the body throws (NotReadyYet), it goes to the catch and is routed to routeError. The test should fail at the first `view()` or with an unhandled error.

`pnpm test test/computed.test.ts -t "suspends on use"` — note the failure mode.

- [ ] **Step 3: Catch `NotReadyYet` in `makeStageNode`**

In `src/computed.ts:makeStageNode`, find the `try { ... } catch (e) { ... }` block around the body. Add a special case for `NotReadyYet`:

```ts
try {
  // ... existing logic up to runStage(stage, input) ...
  const outcome = runStage(stage, input)
  // ... existing outcome handling ...
} catch (e) {
  if (e instanceof NotReadyYet) {
    // Body explicitly suspended on a pending accessor (via use). Treat the
    // same as outcome.pending: register on the carried Promise and SWR.
    const p = e.promise as Promise<unknown>
    if (suspendedOn !== p) {
      suspendedOn = p
      suspendedInput = input
      setPendingSig(true)
      if (lastResolvedValue === UNRESOLVED) {
        setPublishedValue(p)
      }
      // else: SWR

      const rerun = () => {
        if (suspendedOn !== p) return
        const state = track(p)
        if (state.status === 'fulfilled') {
          suspendedOn = null
          setPendingSig(false)
          setKick(++kickCount)    // re-run the body; it will re-call use(list)
        } else if (state.status === 'rejected') {
          suspendedOn = null
          setPendingSig(false)
          setKick(++kickCount)
        }
      }
      p.then(rerun, rerun)
    }
    return null
  }
  try {
    routeError(myOwner, e)
  } catch (rethrown) {
    deferredError = { error: rethrown }
  }
  return null
}
```

Add `NotReadyYet` to imports from `./async`.

Rationale for `setKick` on settle (not `setPublishedValue(resolvedValue)`): we don't know what value the body will produce — it may read other signals too. Kick triggers a body re-run; if `use(list)` now succeeds, the body returns the new snapshot and the existing outcome-handling code publishes it.

- [ ] **Step 4: Run test — expect pass**

`pnpm test test/computed.test.ts -t "suspends on use"` — green.

- [ ] **Step 5: Full unit suite**

`pnpm test` — confirm all pass (anticipate one test rewrite: any existing "use inside computed becomes throw-on-read" test will now suspend instead).

If a test fails for the old "throw-on-read" behavior, update or delete it — the design doc accepts this as a deliberate behavior shift.

- [ ] **Step 6: Update JSDoc on `use` in `src/async.ts`**

Replace the warning:
```
 * Intended for use inside effects (including, later, JSX bindings). Using it
 * inside a `computed` is allowed but a code smell — the computed becomes
 * throw-on-read.
```

with:
```
 * Intended for use inside effects, JSX bindings, AND computed bodies.
 * Inside a computed, `use(pendingAccessor)` suspends the computed via SWR:
 * the prior published value stays visible until the gate settles, then the
 * computed re-runs and publishes a coherent new snapshot. This enables
 * multi-read transitions — see docs/superpowers/specs/2026-05-16-pulse-transitions-design.md.
```

- [ ] **Step 7: Commit**

```bash
git add src/computed.ts src/async.ts test/computed.test.ts
git commit -m "feat(computed): catch NotReadyYet from body as suspension

A computed body that throws NotReadyYet (e.g. via use(pendingAccessor))
suspends with SWR semantics — same path as a body that returns a pending
Promise. Resume callback re-runs the body on settle; the body's next
attempt produces a coherent snapshot of its reads.

Enables transition patterns:

  const view = computed(() => ({
    page: page(),
    items: use(list),
  }))

view's snapshot commits atomically when list finishes refetching;
isPending(view) is true throughout. No new primitive needed.

Removed the 'use inside computed is a code smell' warning from JSDoc."
```

---

### Task 4: Migrate pokemon demo to transition pattern

**Files:**
- Modify: `examples/pokemon/src/main.tsx`
- Modify: `examples/pokemon/src/style.css` (add `.loading` greyed-out style)

- [ ] **Step 1: Rewire pagination**

Replace:
```ts
const list = computed(
  () => fetchList(page()),
  (r) => r.results,
);
```

with:
```ts
const list = computed(() => fetchList(page()), (r) => r.results);

// Coherent display snapshot: page number and items commit atomically.
const view = computed(() => ({
  page: page(),
  items: use(list),
}));
```

And update the render sites:
- `<span>page {() => page() + 1}</span>` → `<span>page {() => view().page + 1}</span>`
- `<For each={() => list()}>` (or wherever items render) → `<For each={() => view().items}>`

Find current item-rendering site; in `examples/pokemon/src/main.tsx` the `<For each={list}>` is inside `App()`. Make sure all references switch to `view` / `view().items`.

- [ ] **Step 2: Add loading visual cue**

Update the page-number span:
```tsx
<span class:loading={() => isPending(view)}>page {() => view().page + 1}</span>
```

Also wrap the list/items container with the same class for greying, e.g.:
```tsx
<ul class="pokemon-list" class:loading={() => isPending(view)}>
  <For each={() => view().items}>…</For>
</ul>
```

- [ ] **Step 3: CSS rule**

In `examples/pokemon/src/style.css`, add at end:
```css
.loading {
  opacity: 0.55;
  transition: opacity 120ms ease-in-out;
}
```

- [ ] **Step 4: Run pokemon Playwright**

```bash
lsof -ti:5181 2>/dev/null | xargs -r kill 2>/dev/null
pnpm --filter @pulse-examples/pokemon test
```

Expect 9/9 pass. The refreshing-indicator test should still pass because `isPending(view)` ORs through to `isPending(list)`.

- [ ] **Step 5: Add a transition-coherence Playwright assertion**

In `examples/pokemon/tests/pokemon.spec.ts`, add a test:

```ts
test('page label and items commit atomically (transition)', async ({ page: pw }) => {
  await pw.goto('/');
  await pw.waitForSelector('li');                  // page 1 loaded
  await expect(pw.locator('header span')).toHaveText('page 1');
  await pw.click('button:has-text("next")');
  // During refetch: label still says "page 1" and items still page-1 names
  await expect(pw.locator('header span')).toHaveText('page 1');
  // Wait for new content
  await pw.waitForFunction(() => document.querySelector('header span')?.textContent === 'page 2');
  // Items should be page-2 names now (just assert count >= 1, no flicker)
  await expect(pw.locator('li').first()).toBeVisible();
});
```

(Adjust selectors to match actual demo DOM if needed — read `examples/pokemon/tests/pokemon.spec.ts` for existing patterns first.)

- [ ] **Step 6: Run Playwright — expect 10/10 pass**

```bash
lsof -ti:5181 2>/dev/null | xargs -r kill 2>/dev/null
pnpm --filter @pulse-examples/pokemon test
```

- [ ] **Step 7: Commit**

```bash
git add examples/pokemon/src/main.tsx examples/pokemon/src/style.css examples/pokemon/tests/pokemon.spec.ts
git commit -m "refactor(examples/pokemon): pagination via transition pattern

Adds a 'view' computed that snapshots page+items coherently: the page
label stays at the prior page until the new page's items arrive, then
both commit atomically. .loading class greys the list during the
transition window. New Playwright assertion locks in the no-jump
behavior."
```

---

### Task 5: Docs

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/follow-ups.md`

- [ ] **Step 1: CONTEXT.md — add a Transition entry**

After the Computed entry (~line 33), add:

```markdown
**Transition (pattern, not primitive)**:
A `computed` whose body calls `use(pendingAccessor)` on one or more inputs.
SWR holds the computed's prior published value while any read input is
pending, and the body re-runs on settle. The result is a coherent
multi-read snapshot — when an upstream input refetches, the computed
publishes nothing new until the input settles, then commits a new value
atomically. Observe the transition window with `isPending(view)`.
```

- [ ] **Step 2: follow-ups.md — record the change**

Add to "Already addressed":
```
- ~~`use(accessor)` inside a computed body becomes throw-on-read (code smell).~~ Fixed in commit `__SHAS__` — use(pendingAccessor) inside a computed body now suspends with SWR; computed body catches NotReadyYet and routes through the existing pending-Promise resume path. Enables coherent multi-read snapshots ('transitions') without a new primitive. Pokemon pagination demo migrated.
```

Patch `__SHAS__` with task-3's commit SHA after committing.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md docs/follow-ups.md
git commit -m "docs: document transitions as a computed pattern

CONTEXT.md gets a Transition entry; follow-ups records the
use-in-computed semantic shift."
```

---

## Self-review notes

- All tasks have full code in steps (no "implement similar"). Type names match across tasks (`Accessor<boolean> & { promise?: () => Promise<unknown> | null }`).
- Task 3's `rerun` callback uses `setKick` for both fulfilled and rejected cases (mirror of generator path) — body re-runs decide how to handle.
- Task 4's transition test selectors are placeholders; the implementer should verify against actual DOM in `examples/pokemon/src/main.tsx`.
- Task 1's brand wrapping is slightly different from the current `de2c37a` shape but preserves identical observable behavior for existing `isPending` callers.

# pulse Control-Flow Components (Plan 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three control-flow components (`Show`, `Switch`/`Match`, `For`) plus the internal `mapArray` utility, wired through Plan 3a's per-run sub-owner pattern.

**Architecture:** Four files under `src/dom/`. `mapArray` (DOM-free reactive list reconciliation engine) is shared. `For` is a thin wrapper over it. `Show` and `Switch`/`Match` are independent components each using `createSubOwner` for per-branch lifecycle. All four components return a `() => Node | Node[] | undefined` so the parent's `insertChild` (Plan 3a) handles them via the "function = reactive" rule.

**Tech Stack:** TypeScript, Vitest (browser mode for DOM tests, Node project for `mapArray`), Playwright (Chromium), pulse core (existing `signal`, `effect`, `createSubOwner`, `disposeOwner`, `runWithOwner`, `onCleanup`, `isPromise`), r3 (untouched).

**Companion spec:** `docs/superpowers/specs/2026-05-15-pulse-control-flow-design.md`

---

## File map

```
src/
  dom/
    map-array.ts      — internal: mapArray reconciliation engine
    for.ts            — For component
    show.ts           — Show component, Truthy<T> type
    switch.ts         — Switch + Match components
    index.ts          — adds: export { Show, Switch, Match, For }
  index.ts            — adds: export { Show, Switch, Match, For } from './dom'
test/
  dom/
    map-array.test.ts — DOM-free reconciliation tests
    for.test.tsx      — For DOM tests
    show.test.tsx     — Show DOM tests
    switch.test.tsx   — Switch DOM tests
```

`mapArray` is intentionally **not** exported from `src/dom/index.ts` — it stays internal so we can promote later without breaking changes.

## Conventions

- `pnpm`, not npm; `pnpm-lock.yaml` is the lockfile.
- Each task ends with a single commit; commits do **not** carry AI co-author trailers (per repo memory).
- TDD per the existing pattern: failing test(s) → minimal implementation → green.
- Existing 147 tests must remain green after every task.
- Tasks are ordered so each is self-contained; later tasks may import from earlier ones.

---

### Task 1: `mapArray` internal utility

**Files:**
- Create: `src/dom/map-array.ts`
- Create: `test/dom/map-array.test.ts`

`mapArray` is the reactive list reconciliation engine. Pure data flow — no DOM. Testable in isolation. `For` (Task 2) is a thin wrapper.

- [ ] **Step 1: Confirm starting state**

Run: `pnpm test && pnpm typecheck`
Expected: 147/147 pass; typecheck clean.

- [ ] **Step 2: Write the failing tests**

Create `test/dom/map-array.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mapArray } from '../../src/dom/map-array'
import {
  createRoot,
  effect,
  flush,
  microtaskScheduler,
  onCleanup,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => setScheduler(microtaskScheduler(flush)))

test('initial run maps each item in order', () => {
  createRoot(() => {
    const items = signal([1, 2, 3])
    const mapped = mapArray(items, (n) => n * 10)
    expect(mapped()).toEqual([10, 20, 30])
  })
})

test('reuses entries when same references appear again', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const items = signal([a, b])
    let calls = 0
    const mapped = mapArray(items, (item) => { calls++; return item.id })
    mapped()
    expect(calls).toBe(2)
    setSignal(items, [a, b])
    mapped()
    expect(calls).toBe(2) // no new mapper calls
  })
})

test('creates entries for newly added items', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const items = signal([a, b])
    let calls = 0
    const mapped = mapArray(items, (item) => { calls++; return item.id })
    mapped()
    setSignal(items, [a, b, c])
    mapped()
    expect(calls).toBe(3)
  })
})

test('disposes orphan entries when items leave', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const items = signal([a, b])
    let aCleanedUp = false
    const mapped = mapArray(items, (item) => {
      if (item === a) onCleanup(() => { aCleanedUp = true })
      return item.id
    })
    mapped()
    expect(aCleanedUp).toBe(false)
    setSignal(items, [b])
    mapped()
    expect(aCleanedUp).toBe(true)
  })
})

test('index signal updates on reorder', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const items = signal([a, b, c])
    const mapped = mapArray(items, (item, index) => ({ item, idx: index }))
    let entries = mapped()
    expect(entries.map((e) => e.idx())).toEqual([0, 1, 2])
    setSignal(items, [c, a, b]) // reorder
    entries = mapped()
    expect(entries.map((e) => e.idx())).toEqual([1, 2, 0]) // a→1, b→2, c→0
  })
})

test('mapper runs under per-item sub-owner; nested effect disposes when item leaves', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const items = signal([a, b])
    const aSig = signal(0)
    let aRuns = 0
    const mapped = mapArray(items, (item) => {
      if (item === a) effect(() => { aSig(); aRuns++ })
      return item.id
    })
    mapped()
    expect(aRuns).toBe(1)
    setSignal(aSig, 1)
    expect(aRuns).toBe(2)
    setSignal(items, [b]) // a leaves; its effect should be disposed
    mapped()
    setSignal(aSig, 2)
    expect(aRuns).toBe(2) // no further runs
  })
})

test('pending Promise<T[]> coerces to empty', () => {
  createRoot(() => {
    const p = new Promise<number[]>(() => {}) // never resolves
    const items = signal<number[] | Promise<number[]>>(p)
    const mapped = mapArray(items, (n) => n * 10)
    expect(mapped()).toEqual([])
  })
})

test('parent owner dispose cascades to all entry sub-owners', () => {
  let cleanups = 0
  const dispose = createRoot((d) => {
    const items = signal([1, 2, 3])
    const mapped = mapArray(items, () => {
      onCleanup(() => { cleanups++ })
      return null
    })
    mapped() // materialize entries
    return d
  })
  expect(cleanups).toBe(0)
  dispose()
  expect(cleanups).toBe(3)
})

test('different-reference same-shape items: treated as different', () => {
  createRoot(() => {
    const a1 = { id: 'a' }
    const a2 = { id: 'a' } // different reference
    const items = signal([a1])
    let calls = 0
    const mapped = mapArray(items, (item) => { calls++; return item.id })
    mapped()
    setSignal(items, [a2])
    mapped()
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- --project unit map-array`
Expected: FAIL with `Cannot find module '../../src/dom/map-array'`.

- [ ] **Step 4: Implement `mapArray`**

Create `src/dom/map-array.ts`:

```ts
import { isPromise } from '../is-promise'
import { createSubOwner, disposeOwner, getOwner, runWithOwner, type Owner } from '../owner'
import { setSignal, signal, type WritableSignal } from '../signal'

type Entry<T, U> = {
  item: T
  mapped: U
  indexSig: WritableSignal<number>
  owner: Owner
}

/**
 * Reactive list-with-identity-preserving-disposal engine.
 *
 * `list` may be an array, a Promise of an array, or a function returning
 * either. The mapper is called once per **new** item (matched by strict
 * reference equality). Items that survive across runs reuse their mapped
 * output and their per-item sub-owner. Items that leave have their
 * sub-owner disposed (cascading any onCleanup / effects the mapper
 * created).
 *
 * `index` is a signal accessor reflecting the item's current position;
 * reorders update via `setSignal(indexSig, newIndex)`.
 *
 * Pending `Promise<T[]>` coerces to `[]` (mirrors spec §5's pending-as-
 * empty rule for lists).
 *
 * Internal — not exported from the public barrel.
 */
export function mapArray<T, U>(
  list: T[] | Promise<T[]> | (() => T[] | Promise<T[]>),
  mapFn: (item: T, index: () => number) => U,
): () => U[] {
  const parentOwner = getOwner()
  let entries = new Map<T, Entry<T, U>>()

  return () => {
    const raw = typeof list === 'function' ? list() : list
    const arr: T[] = isPromise(raw) || !Array.isArray(raw) ? [] : raw

    const next = new Map<T, Entry<T, U>>()
    const output: U[] = []
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      let entry = entries.get(item)
      if (entry !== undefined) {
        if (entry.indexSig() !== i) setSignal(entry.indexSig, i)
      } else {
        const owner = createSubOwner(parentOwner)
        const indexSig = signal(i)
        const mapped = runWithOwner(owner, () => mapFn(item, () => indexSig()))
        entry = { item, mapped, indexSig, owner }
      }
      next.set(item, entry)
      output.push(entry.mapped)
    }

    for (const [item, entry] of entries) {
      if (!next.has(item)) disposeOwner(entry.owner)
    }
    entries = next
    return output
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- --project unit map-array`
Expected: PASS — all 9 cases.

- [ ] **Step 6: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: total = 156 (147 + 9); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/dom/map-array.ts test/dom/map-array.test.ts
git commit -m "feat(dom): mapArray reactive list reconciliation"
```

---

### Task 2: `For` component

**Files:**
- Create: `src/dom/for.ts`
- Modify: `src/dom/index.ts`
- Modify: `src/index.ts`
- Create: `test/dom/for.test.tsx`

Thin wrapper over `mapArray`. Adds fallback-on-empty and flattens row outputs into a single Node sequence.

- [ ] **Step 1: Write the failing tests**

Create `test/dom/for.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import { For } from '../../src/dom/for'
import {
  flush,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('renders rows in order', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const items = signal([1, 2, 3])
  const dispose = render(
    () => <For each={items}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.querySelectorAll('li')).toHaveLength(3)
  expect(target.textContent).toBe('123')
  dispose()
})

test('empty array → fallback rendered', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const items = signal<number[]>([])
  const dispose = render(
    () => <For each={items} fallback={<p>empty</p>}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('empty')
  dispose()
})

test('adding items mounts new DOM at the right position', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const items = signal([a, b])
  const dispose = render(
    () => <For each={items}>{(item) => <li>{item.id}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('ab')
  setSignal(items, [a, b, c])
  expect(target.textContent).toBe('abc')
  dispose()
})

test('removing items fires per-row onCleanup', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const cleanups: string[] = []
  const items = signal([a, b])
  const dispose = render(
    () => <For each={items}>{(item) => {
      onCleanup(() => cleanups.push(item.id))
      return <li>{item.id}</li>
    }}</For>,
    target,
  )
  expect(cleanups).toEqual([])
  setSignal(items, [a]) // b leaves
  expect(cleanups).toEqual(['b'])
  dispose()
  expect(cleanups).toEqual(['b', 'a']) // a disposed on render dispose
})

test('reorder: same DOM node identities, repositioned', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const items = signal([a, b, c])
  const dispose = render(
    () => <For each={items}>{(item) => <li>{item.id}</li>}</For>,
    target,
  )
  const lisBefore = Array.from(target.querySelectorAll('li'))
  setSignal(items, [c, a, b])
  const lisAfter = Array.from(target.querySelectorAll('li'))
  expect(target.textContent).toBe('cab')
  expect(lisAfter).toEqual([lisBefore[2], lisBefore[0], lisBefore[1]])
  dispose()
})

test('pending Promise<T[]> → fallback rendered', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<number[]>(() => {})
  const items = signal<number[] | Promise<number[]>>(p)
  const dispose = render(
    () => <For each={items} fallback={<p>loading</p>}>{(n) => <li>{n}</li>}</For>,
    target,
  )
  expect(target.textContent).toBe('loading')
  dispose()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project dom for.test`
Expected: FAIL with `Cannot find module '../../src/dom/for'` (or import resolution error).

- [ ] **Step 3: Implement `For`**

Create `src/dom/for.ts`:

```ts
import { mapArray } from './map-array'

export interface ForProps<T> {
  each: T[] | Promise<T[]> | (() => T[] | Promise<T[]>)
  fallback?: Node | Node[]
  children: (item: T, index: () => number) => Node | Node[]
}

/**
 * Render one row per item in `each`. Rows are reference-keyed: the array
 * slot's value is the key. Reorders preserve row identity (same DOM
 * nodes, repositioned). Empty `each` (or pending `Promise<T[]>`) renders
 * `fallback`.
 *
 * The renderer receives `(item, index)` where `index` is an accessor that
 * updates when the row's position changes.
 *
 * See `mapArray` for the reconciliation engine. `For` adds the
 * fallback-on-empty handoff and flattens row outputs into a single
 * Node sequence.
 */
export function For<T>(props: ForProps<T>): () => Node | Node[] | undefined {
  const mapped = mapArray<T, Node | Node[]>(props.each, props.children)
  return () => {
    const flat = mapped().flat()
    return flat.length === 0 ? props.fallback : flat
  }
}
```

Update `src/dom/index.ts` — add `For` to the exports. The file becomes:

```ts
export { Fragment, h, type Component, type Tag } from './h'
export { jsx, jsxs } from './jsx-runtime'
export { render } from './render'
export { For } from './for'
```

Update `src/index.ts` — append `For` to the dom re-export. The existing line `export { Fragment, h, render } from './dom'` becomes:

```ts
export { For, Fragment, h, render } from './dom'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --project dom for.test`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: total = 162 (156 + 6); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/dom/for.ts src/dom/index.ts src/index.ts test/dom/for.test.tsx
git commit -m "feat(dom): For component"
```

---

### Task 3: `Show` component

**Files:**
- Create: `src/dom/show.ts`
- Modify: `src/dom/index.ts`
- Modify: `src/index.ts`
- Create: `test/dom/show.test.tsx`

Conditional rendering with type-narrowed function child. Branch caching: same-truthy or same-falsy re-runs preserve the rendered subtree. Truthy ↔ falsy transitions dispose the old branch's sub-owner and mount the new under a fresh one.

- [ ] **Step 1: Write the failing tests**

Create `test/dom/show.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Show } from '../../src/dom/show'
import {
  flush,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('truthy when mounts function child with narrowed value', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const user = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => <Show when={user}>{(u) => <span>{u.name}</span>}</Show>,
    target,
  )
  expect(target.textContent).toBe('Ada')
  dispose()
})

test('falsy when mounts fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const user = signal<{ name: string } | null>(null)
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>none</p>}>
        {(u) => <span>{u.name}</span>}
      </Show>
    ),
    target,
  )
  expect(target.textContent).toBe('none')
  dispose()
})

test('pending Promise<T> when → fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const p = new Promise<{ name: string }>(() => {})
  const user = signal<{ name: string } | Promise<{ name: string }>>(p)
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>loading</p>}>
        {(u) => <span>{u.name}</span>}
      </Show>
    ),
    target,
  )
  expect(target.textContent).toBe('loading')
  dispose()
})

test('truthy → truthy with different value preserves subtree (children not re-called)', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let calls = 0
  const user = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Show when={user}>
        {(u) => { calls++; return <span>{u.name}</span> }}
      </Show>
    ),
    target,
  )
  expect(calls).toBe(1)
  setSignal(user, { name: 'Babbage' })
  expect(calls).toBe(1) // not re-called
  dispose()
})

test('truthy → falsy disposes branch sub-owner', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const user = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>none</p>}>
        {(u) => {
          onCleanup(() => { cleaned = true })
          return <span>{u.name}</span>
        }}
      </Show>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  setSignal(user, null)
  expect(cleaned).toBe(true)
  dispose()
})

test('falsy → truthy mounts fresh children invocation', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let calls = 0
  const user = signal<{ name: string } | null>(null)
  const dispose = render(
    () => (
      <Show when={user} fallback={<p>none</p>}>
        {(u) => { calls++; return <span>{u.name}</span> }}
      </Show>
    ),
    target,
  )
  expect(calls).toBe(0)
  expect(target.textContent).toBe('none')
  setSignal(user, { name: 'Ada' })
  expect(calls).toBe(1)
  expect(target.textContent).toBe('Ada')
  dispose()
})

test('disposing surrounding owner disposes active branch', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const cond = signal(true)
  const dispose = render(
    () => (
      <Show when={cond}>
        {() => {
          onCleanup(() => { cleaned = true })
          return <span>hi</span>
        }}
      </Show>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})

test('static (non-function) child renders when truthy', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const cond = signal(true)
  const dispose = render(
    () => <Show when={cond}><p>shown</p></Show>,
    target,
  )
  expect(target.textContent).toBe('shown')
  dispose()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project dom show.test`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `Show`**

Create `src/dom/show.ts`:

```ts
import { isPromise } from '../is-promise'
import {
  createSubOwner,
  disposeOwner,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'

/** Type-level narrowing for `Show`'s function-child: the value passed in
 *  is the input minus its falsy components. */
export type Truthy<T> = Exclude<T, false | null | undefined | 0 | ''>

export interface ShowProps<T> {
  when: T | (() => T)
  fallback?: Node | Node[]
  children: Node | Node[] | ((value: Truthy<T>) => Node | Node[])
}

/**
 * Conditional render. When `when` evaluates truthy (and is not a pending
 * promise), the children are rendered; otherwise `fallback`. The function-
 * child form receives the narrowed truthy value.
 *
 * Branch caching: same-truthy or same-falsy re-runs preserve the rendered
 * subtree (children function is NOT re-called when the value updates but
 * the branch stays). Truthy↔falsy transitions dispose the old branch's
 * sub-owner and mount the new under a fresh one.
 */
export function Show<T>(props: ShowProps<T>): () => Node | Node[] | undefined {
  const parentOwner = getOwner()
  let lastBranch: 'truthy' | 'falsy' | null = null
  let cachedNode: Node | Node[] | undefined
  let branchOwner: Owner | null = null

  return () => {
    const raw = typeof props.when === 'function'
      ? (props.when as () => T)()
      : props.when
    const isTruthy = !!raw && !isPromise(raw)
    const branch = isTruthy ? 'truthy' : 'falsy'

    if (branch === lastBranch) return cachedNode

    if (branchOwner !== null) disposeOwner(branchOwner)
    branchOwner = createSubOwner(parentOwner)
    cachedNode = runWithOwner(branchOwner, () => {
      if (isTruthy) {
        return typeof props.children === 'function'
          ? (props.children as (v: Truthy<T>) => Node | Node[])(raw as Truthy<T>)
          : props.children
      }
      return props.fallback
    })
    lastBranch = branch
    return cachedNode
  }
}
```

Update `src/dom/index.ts` — add `Show`:

```ts
export { Fragment, h, type Component, type Tag } from './h'
export { jsx, jsxs } from './jsx-runtime'
export { render } from './render'
export { For } from './for'
export { Show, type Truthy } from './show'
```

Update `src/index.ts` — append `Show`. The existing dom re-export becomes:

```ts
export { For, Fragment, h, render, Show, type Truthy } from './dom'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --project dom show.test`
Expected: PASS — all 8 cases.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: total = 170 (162 + 8); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/dom/show.ts src/dom/index.ts src/index.ts test/dom/show.test.tsx
git commit -m "feat(dom): Show component"
```

---

### Task 4: `Switch` + `Match` components

**Files:**
- Create: `src/dom/switch.ts`
- Modify: `src/dom/index.ts`
- Modify: `src/index.ts`
- Create: `test/dom/switch.test.tsx`

Multi-branch conditional. `Match` returns a tagged data object (not a DOM node). `Switch` iterates its children, picks the first truthy Match, and renders its branch under a fresh sub-owner. Branch caching by Match-object identity.

- [ ] **Step 1: Write the failing tests**

Create `test/dom/switch.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Match, Switch } from '../../src/dom/switch'
import {
  flush,
  microtaskScheduler,
  onCleanup,
  render,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('first truthy Match wins', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={false}><p>a</p></Match>
        <Match when={true}><p>b</p></Match>
        <Match when={true}><p>c</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('b')
  dispose()
})

test('no Match truthy → fallback', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={false}><p>a</p></Match>
        <Match when={null}><p>b</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('none')
  dispose()
})

test('non-Match children inside Switch are ignored', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => (
      <Switch fallback={<p>fallback</p>}>
        {'stray text'}
        <Match when={true}><p>b</p></Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('b')
  dispose()
})

test('Match function child receives narrowed value', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const user = signal<{ name: string } | null>({ name: 'Ada' })
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={user}>{(u) => <span>{u.name}</span>}</Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('Ada')
  dispose()
})

test('winner change disposes old branch sub-owner', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const which = signal<'a' | 'b' | 'none'>('a')
  let aCleaned = false
  let bCleaned = false
  const dispose = render(
    () => (
      <Switch fallback={<p>none</p>}>
        <Match when={() => which() === 'a'}>{() => {
          onCleanup(() => { aCleaned = true })
          return <p>a</p>
        }}</Match>
        <Match when={() => which() === 'b'}>{() => {
          onCleanup(() => { bCleaned = true })
          return <p>b</p>
        }}</Match>
      </Switch>
    ),
    target,
  )
  expect(target.textContent).toBe('a')
  setSignal(which, 'b')
  expect(target.textContent).toBe('b')
  expect(aCleaned).toBe(true)
  expect(bCleaned).toBe(false)
  setSignal(which, 'none')
  expect(target.textContent).toBe('none')
  expect(bCleaned).toBe(true)
  dispose()
})

test('disposing surrounding owner disposes active branch', () => {
  const target = document.createElement('section')
  document.body.append(target)
  let cleaned = false
  const dispose = render(
    () => (
      <Switch>
        <Match when={true}>{() => {
          onCleanup(() => { cleaned = true })
          return <p>x</p>
        }}</Match>
      </Switch>
    ),
    target,
  )
  expect(cleaned).toBe(false)
  dispose()
  expect(cleaned).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project dom switch.test`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `Switch` + `Match`**

Create `src/dom/switch.ts`:

```ts
import { isPromise } from '../is-promise'
import {
  createSubOwner,
  disposeOwner,
  getOwner,
  runWithOwner,
  type Owner,
} from '../owner'
import type { Truthy } from './show'

const MATCH: unique symbol = Symbol('Match')

export interface MatchProps<T> {
  when: T | (() => T)
  children: Node | Node[] | ((value: Truthy<T>) => Node | Node[])
}

export interface MatchData<T> extends MatchProps<T> {
  readonly [MATCH]: true
}

/**
 * Tagged data marker consumed by `Switch`. Not a renderer — `Match` does
 * not return a DOM node; its return value is detected by `Switch` via the
 * `MATCH` symbol.
 */
export function Match<T>(props: MatchProps<T>): MatchData<T> {
  return { [MATCH]: true, ...props }
}

export interface SwitchProps {
  fallback?: Node | Node[]
  children: MatchData<unknown> | MatchData<unknown>[] | unknown
}

/**
 * Multi-branch conditional. Evaluates each `Match` child's `when` in
 * document order; the first truthy (non-pending) match wins and its
 * children render. If no Match wins, `fallback` renders.
 *
 * Branch caching by Match-object identity: same winner across re-runs
 * preserves the rendered subtree (children function not re-called).
 * Winner change disposes the old branch's sub-owner and mounts the new
 * under a fresh one.
 *
 * Non-Match children are silently ignored (e.g. stray whitespace text).
 */
export function Switch(props: SwitchProps): () => Node | Node[] | undefined {
  const parentOwner = getOwner()
  let lastKey: MatchData<unknown> | 'fallback' | null = null
  let cachedNode: Node | Node[] | undefined
  let branchOwner: Owner | null = null

  return () => {
    const raw = props.children
    const items = Array.isArray(raw) ? raw : [raw]
    let winner: MatchData<unknown> | null = null
    let winnerValue: unknown = undefined
    for (const item of items) {
      if (item === null || item === undefined) continue
      if (typeof item !== 'object') continue
      if ((item as MatchData<unknown>)[MATCH] !== true) continue
      const m = item as MatchData<unknown>
      const r = typeof m.when === 'function'
        ? (m.when as () => unknown)()
        : m.when
      if (r && !isPromise(r)) {
        winner = m
        winnerValue = r
        break
      }
    }

    const key: MatchData<unknown> | 'fallback' = winner ?? 'fallback'
    if (key === lastKey) return cachedNode

    if (branchOwner !== null) disposeOwner(branchOwner)
    branchOwner = createSubOwner(parentOwner)
    cachedNode = runWithOwner(branchOwner, () => {
      if (winner === null) return props.fallback
      return typeof winner.children === 'function'
        ? (winner.children as (v: Truthy<unknown>) => Node | Node[])(
            winnerValue as Truthy<unknown>,
          )
        : winner.children
    })
    lastKey = key
    return cachedNode
  }
}
```

Update `src/dom/index.ts` — add `Switch` and `Match`:

```ts
export { Fragment, h, type Component, type Tag } from './h'
export { jsx, jsxs } from './jsx-runtime'
export { render } from './render'
export { For } from './for'
export { Show, type Truthy } from './show'
export { Match, Switch } from './switch'
```

Update `src/index.ts` — append `Match` and `Switch`:

```ts
export { For, Fragment, h, Match, render, Show, Switch, type Truthy } from './dom'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --project dom switch.test`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: total = 176 (170 + 6); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/dom/switch.ts src/dom/index.ts src/index.ts test/dom/switch.test.tsx
git commit -m "feat(dom): Switch + Match components"
```

---

## Final verification

After Task 4:

- [ ] **Run all tests** — `pnpm test` — expected ~176 passing across both projects.
- [ ] **Run typecheck** — `pnpm typecheck` — expected clean.
- [ ] **Skim the public barrel** — `src/index.ts` now exports `For`, `Match`, `Show`, `Switch`, `Truthy` in addition to the previous symbols.
- [ ] **Dispatch the final whole-implementation review** if running under `superpowers:subagent-driven-development`.

## Out of scope reminders

These do not belong in Plan 3b — defer or surface as follow-ups:

- `Index` (Solid's stable-slot variant of `For`) — separate plan or follow-up.
- `Portal` — separate plan (Plan 3c).
- SVG / namespaced elements (`createElementNS`) — separate plan.
- Two-phase keying (reference → resolved field) — v2 `<Suspense>` concern.
- Diff-insert optimization in `insertChild` for Node[] returns — follow-up;
  v1 ships full-clear which preserves correctness, just not minimal DOM ops.
- A typed `JSX.IntrinsicElements` covering real DOM attribute typing —
  already a Plan 3a follow-up.
- The `Truthy<Promise<T>>` type mismatch (runtime treats pending as falsy
  but `Exclude<...>` doesn't model promises) — add to follow-ups.

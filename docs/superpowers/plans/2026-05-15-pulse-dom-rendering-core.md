# pulse DOM Rendering Core (Plan 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal DOM rendering layer to pulse — `render`, JSX runtime, child bindings, pota-style namespaced prop bindings, refs — wired through the existing `effect`/`createRoot`/`catchError` machinery.

**Architecture:** Three thin DOM-layer files (`h`, `bindings`, `render`) plus a JSX-runtime entry. The runtime dispatches on JSX-prop-name *prefix* (`on:`, `prop:`, `attr:`, `class:`, `style:`); reactive bindings are wrapped in the existing `effect` primitive so `use`-throw stale-but-stable, `catchError` routing, and owner disposal all fall out for free. Tests run under Vitest browser mode (Playwright/Chromium) as a separate project alongside the existing Node-based core tests.

**Tech Stack:** TypeScript, Vitest (browser mode + Node project), Playwright (Chromium), pulse core (existing `effect`, `createRoot`, `catchError`, `onCleanup`), r3 (untouched).

**Companion spec:** `docs/superpowers/specs/2026-05-15-pulse-dom-rendering-core-design.md`

---

## File map

```
src/
  dom/
    h.ts            — h(tag, props, ...children); Fragment symbol; component invocation
    bindings.ts     — insertChild, bindProp, prefix dispatchers
    render.ts       — render(component, target): () => void
    jsx-runtime.ts  — jsx, jsxs (forward to h); re-exports Fragment
    index.ts        — barrel for the dom directory
  owner.ts          — extract internal createSubOwner(parent, handler?)
  index.ts          — re-export render, h, Fragment
  jsx-runtime.ts    — package-root re-export of dom/jsx-runtime
package.json        — add exports field; devDeps for @vitest/browser, playwright
tsconfig.json       — add jsx + jsxImportSource (Task 12)
vitest.config.ts    — split into projects (unit / dom)
test/
  dom/
    smoke.test.ts             — Task 1
    h.test.ts                 — Tasks 3, 4
    binding-children.test.ts  — Task 5
    binding-events.test.ts    — Task 6
    binding-prop.test.ts      — Task 7
    binding-attr.test.ts      — Task 8
    binding-class-style.test.ts — Task 9
    binding-ref.test.ts       — Task 10
    components.test.ts        — Task 11
    jsx-runtime.test.tsx      — Task 12
    render.test.ts            — Task 13
    integration.test.tsx      — Task 14
```

## Conventions used throughout the plan

- The user runs the existing test command: `pnpm test`. To run a subset, the snippets use `pnpm test -- <pattern>`.
- Each task ends with a single commit; commits do **not** carry AI co-author trailers (per repo memory).
- TDD: write a failing test first, watch it fail, then write the minimal code to make it pass.
- Existing 91 tests must remain green after every task.
- Plan 3a does *not* introduce JSX in tests until Task 12. Earlier tasks call `h(...)` directly so each test exercises exactly the unit under construction.

---

### Task 1: Set up Vitest browser mode for DOM tests

**Files:**
- Create: `test/dom/smoke.test.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json` (add devDeps; no other changes)

- [ ] **Step 1: Install browser-mode devDependencies**

```bash
pnpm add -D @vitest/browser playwright
```

Expected: `package.json` gains `@vitest/browser` and `playwright` under `devDependencies`. Vitest version (`^3.1.3`) is unchanged.

- [ ] **Step 2: Update `vitest.config.ts` to define two projects**

Replace the whole file with:

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const aliases = { r3: resolve(here, '../r3/src/index.ts') }

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        extends: true,
        resolve: { alias: aliases },
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/dom/**'],
        },
      },
      {
        extends: true,
        resolve: { alias: aliases },
        test: {
          name: 'dom',
          include: ['test/dom/**/*.test.{ts,tsx}'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
```

- [ ] **Step 3: Write the failing smoke test**

Create `test/dom/smoke.test.ts`:

```ts
import { expect, test } from 'vitest'

test('browser-mode is wired: document.createElement works', () => {
  const el = document.createElement('div')
  el.textContent = 'hello'
  document.body.append(el)
  expect(document.body.innerHTML).toContain('hello')
  el.remove()
})
```

- [ ] **Step 4: Install Playwright's Chromium browser**

```bash
pnpm exec playwright install chromium
```

Expected: download proceeds; "chromium … installed" message.

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: both projects pass; `unit` runs the previous 91 tests; `dom` runs the 1 smoke test. Total: 92 passing.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts test/dom/smoke.test.ts
git commit -m "test: enable Vitest browser mode (Playwright) for DOM tests"
```

---

### Task 2: Extract internal `createSubOwner` from `catchError`

**Files:**
- Modify: `src/owner.ts`

This refactor has no externally observable behaviour change — it lifts a reusable helper out of `catchError` so Plan 3a's `render` and Plan 3b's `Show`/`For` can build parented sub-owners without duplicating logic. The `docs/follow-ups.md` "Future" entry under "Architectural notes" anticipates this.

- [ ] **Step 1: Verify all 91 unit tests pass before changing anything**

Run: `pnpm test -- --project unit`
Expected: 91/91 pass.

- [ ] **Step 2: Add the internal `createSubOwner` helper and route `catchError` through it**

Edit `src/owner.ts`. Replace the existing `catchError` definition with:

```ts
/**
 * Internal: create a sub-owner parented to `parent` (or to no one when null),
 * optionally with an `errorHandler` attached. Registers the new sub-owner as
 * a disposable child of `parent` so the parent's `dispose()` cascades.
 *
 * Not exported from the public barrel. Used by `catchError` today; will be
 * used by `Show`/`For` branch scopes in Plan 3b.
 */
export function createSubOwner(
  parent: Owner | null,
  errorHandler: ((error: unknown) => void) | null = null,
): Owner {
  if (parent !== null && parent.disposed) {
    throw new Error('cannot create a sub-owner inside a disposed owner')
  }
  const sub = newOwner(parent, errorHandler)
  if (parent !== null) {
    parent.children.push({ dispose: () => disposeOwner(sub) })
  }
  return sub
}

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

`createSubOwner` is *not* added to `src/index.ts` — it stays internal.

- [ ] **Step 3: Run all tests (refactor should be invisible)**

Run: `pnpm test`
Expected: 92/92 still pass (unit 91, dom 1). No test changes needed.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/owner.ts
git commit -m "refactor(owner): extract internal createSubOwner from catchError"
```

---

### Task 3: `h()` for element creation with primitive children

**Files:**
- Create: `src/dom/h.ts`
- Create: `src/dom/bindings.ts`
- Create: `src/dom/index.ts`
- Create: `test/dom/h.test.ts`

`h` will grow over Tasks 3–11. Start with: string tag → element, primitive/null/Node children, attribute props as plain strings.

- [ ] **Step 1: Write the failing test**

Create `test/dom/h.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'

afterEach(() => { document.body.innerHTML = '' })

test('h creates an element with no children or props', () => {
  const el = h('div', null) as HTMLElement
  expect(el.tagName).toBe('DIV')
  expect(el.childNodes.length).toBe(0)
  expect(el.attributes.length).toBe(0)
})

test('h sets primitive props as attributes', () => {
  const el = h('div', { id: 'x', 'data-n': '5' }) as HTMLElement
  expect(el.getAttribute('id')).toBe('x')
  expect(el.getAttribute('data-n')).toBe('5')
})

test('h skips null/undefined/false attribute values', () => {
  const el = h('div', { a: null, b: undefined, c: false }) as HTMLElement
  expect(el.attributes.length).toBe(0)
})

test('h inserts primitive children as text', () => {
  const el = h('div', null, 'hello', 42, ' world') as HTMLElement
  expect(el.textContent).toBe('hello42 world')
})

test('h skips null/undefined/boolean children', () => {
  const el = h('div', null, null, undefined, true, false, 'x') as HTMLElement
  expect(el.textContent).toBe('x')
})

test('h inserts DOM node children as-is', () => {
  const span = document.createElement('span')
  span.textContent = 'inner'
  const el = h('div', null, span) as HTMLElement
  expect(el.firstChild).toBe(span)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom h.test`
Expected: FAIL with "Cannot find module '../../src/dom/h'" or similar.

- [ ] **Step 3: Implement `bindings.ts` (primitives only) and `h.ts`**

Create `src/dom/bindings.ts`:

```ts
/**
 * Insert `value` as a child (or children) of `parent`. Handles the static
 * shapes only in this task: string, number, null/undefined/boolean (skipped),
 * DOM Node. Arrays and reactive (function) values come in later tasks.
 */
export function insertChild(parent: Node, value: unknown): void {
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'string' || typeof value === 'number') {
    parent.appendChild(document.createTextNode(String(value)))
    return
  }
  if (value instanceof Node) {
    parent.appendChild(value)
    return
  }
  throw new Error(`insertChild: unsupported child value: ${typeof value}`)
}

/**
 * Apply one prop entry to `el`. In this task: only the default (bare-name)
 * path — `setAttribute(name, String(value))`, with null/undefined/false
 * meaning "no attribute set." Prefixes (`on:`, `prop:`, `attr:`,
 * `class:`, `style:`) and reactive function values are added in later tasks.
 */
export function bindProp(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) return
  el.setAttribute(name, String(value))
}
```

Create `src/dom/h.ts`:

```ts
import { bindProp, insertChild } from './bindings'

export type Component<P = Record<string, unknown>> = (props: P) => Node | Node[]
export type Tag = string | Component | symbol

export const Fragment: unique symbol = Symbol('Fragment')

/**
 * Create a DOM node tree. `tag` is a string (HTML element name) for now; the
 * function-tag (component) and Fragment-tag paths are added in Task 11.
 *
 * `props` keys are dispatched by prefix (Tasks 6–10); in this task only bare
 * names work and they all go through `setAttribute`.
 */
export function h(tag: Tag, props: Record<string, unknown> | null, ...children: unknown[]): Node | Node[] {
  if (typeof tag !== 'string') {
    throw new Error('h: non-string tags (components, Fragment) are not supported yet')
  }
  const el = document.createElement(tag)
  if (props) {
    for (const key of Object.keys(props)) {
      bindProp(el, key, props[key])
    }
  }
  for (const child of children) {
    insertChild(el, child)
  }
  return el
}
```

Create `src/dom/index.ts`:

```ts
export { Fragment, h, type Component, type Tag } from './h'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- --project dom h.test`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: 98/98 (unit 91, dom 7).

- [ ] **Step 6: Commit**

```bash
git add src/dom/h.ts src/dom/bindings.ts src/dom/index.ts test/dom/h.test.ts
git commit -m "feat(dom): h() for elements with primitive children and attribute props"
```

---

### Task 4: Array children with order preservation

**Files:**
- Modify: `src/dom/bindings.ts:1-20`
- Modify: `test/dom/h.test.ts`

Array children must preserve order and nest arbitrarily.

- [ ] **Step 1: Add failing tests**

Append to `test/dom/h.test.ts`:

```ts
test('h flattens array children', () => {
  const el = h('div', null, ['a', 'b', 'c']) as HTMLElement
  expect(el.textContent).toBe('abc')
})

test('h flattens nested arrays', () => {
  const el = h('div', null, ['a', ['b', ['c', 'd']]]) as HTMLElement
  expect(el.textContent).toBe('abcd')
})

test('h preserves order of mixed children', () => {
  const span = document.createElement('span')
  span.textContent = 'X'
  const el = h('div', null, 'a', span, 'b', [null, 'c']) as HTMLElement
  expect(el.textContent).toBe('aXbc')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --project dom h.test`
Expected: the three new tests FAIL with `insertChild: unsupported child value: object`.

- [ ] **Step 3: Update `insertChild` to handle arrays**

Replace `insertChild` in `src/dom/bindings.ts` with:

```ts
export function insertChild(parent: Node, value: unknown): void {
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'string' || typeof value === 'number') {
    parent.appendChild(document.createTextNode(String(value)))
    return
  }
  if (value instanceof Node) {
    parent.appendChild(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) insertChild(parent, item)
    return
  }
  throw new Error(`insertChild: unsupported child value: ${typeof value}`)
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- --project dom h.test`
Expected: PASS — all 9 cases.

- [ ] **Step 5: Commit**

```bash
git add src/dom/bindings.ts test/dom/h.test.ts
git commit -m "feat(dom): flatten array children into element"
```

---

### Task 5: Reactive (function) children via binding-effect

**Files:**
- Modify: `src/dom/bindings.ts`
- Create: `test/dom/binding-children.test.ts`

When a child is a function, wrap it in `effect`. The effect places the result between two marker comments and replaces it on dep change. The existing `effect` already handles `NotReadyYet` (stale-but-stable) and routes throws via `routeError`; we don't add any catch logic here.

- [ ] **Step 1: Write the failing test**

Create `test/dom/binding-children.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
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

test('function child renders the current value as text', () => {
  createRoot(() => {
    const count = signal(0)
    const el = h('div', null, count) as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('0')
  })
})

test('function child re-renders when its signal changes', () => {
  createRoot(() => {
    const count = signal(0)
    const el = h('div', null, count) as HTMLElement
    document.body.append(el)
    setSignal(count, 7)
    expect(el.textContent).toBe('7')
  })
})

test('function child replaces previous DOM each run', () => {
  createRoot(() => {
    const which = signal<'a' | 'b'>('a')
    const el = h('div', null, () => which() === 'a' ? 'aaa' : 'bbb') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('aaa')
    setSignal(which, 'b')
    expect(el.textContent).toBe('bbb')
  })
})

test('function child can return a DOM node', () => {
  createRoot(() => {
    const which = signal<'x' | 'y'>('x')
    const el = h('div', null, () => {
      const span = document.createElement('span')
      span.textContent = which()
      return span
    }) as HTMLElement
    document.body.append(el)
    expect(el.querySelector('span')?.textContent).toBe('x')
    setSignal(which, 'y')
    expect(el.querySelector('span')?.textContent).toBe('y')
  })
})

test('function child preserves marker order for static siblings', () => {
  createRoot(() => {
    const mid = signal('M')
    const el = h('div', null, 'L', mid, 'R') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('LMR')
    setSignal(mid, 'm')
    expect(el.textContent).toBe('LmR')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom binding-children`
Expected: FAIL — first test fails at the function-child path.

- [ ] **Step 3: Implement reactive children in `bindings.ts`**

Replace `insertChild` in `src/dom/bindings.ts`. The full file becomes:

```ts
import { effect } from '../effect'

/**
 * Insert `value` as a child (or children) of `parent`.
 *
 * - string / number → text node
 * - null / undefined / boolean → nothing
 * - DOM Node → inserted as-is
 * - array → each item inserted recursively
 * - function → wrapped in a binding-effect: the function runs reactively;
 *   its result is inserted between two marker comments and replaced on
 *   re-run. `use(...)` inside the function suspends only this binding;
 *   throws route to the nearest `catchError`.
 */
export function insertChild(parent: Node, value: unknown): void {
  if (typeof value === 'function') {
    const start = document.createComment('')
    const end = document.createComment('')
    parent.appendChild(start)
    parent.appendChild(end)
    effect(() => {
      // Call the user function FIRST. If it throws (notably NotReadyYet
      // via `use(...)`), we leave the existing DOM untouched — stale-but-
      // stable. Only on a successful call do we clear and re-insert.
      const next = (value as () => unknown)()
      // Build the new content into a fragment before touching the DOM, so
      // a partial insertChild error can't leave a half-cleared region.
      const frag = document.createDocumentFragment()
      insertChild(frag, next)
      // Clear previously-inserted nodes between the markers, then insert.
      let cur = start.nextSibling
      while (cur !== null && cur !== end) {
        const after: ChildNode | null = cur.nextSibling
        cur.remove()
        cur = after
      }
      end.parentNode!.insertBefore(frag, end)
    })
    return
  }
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'string' || typeof value === 'number') {
    parent.appendChild(document.createTextNode(String(value)))
    return
  }
  if (value instanceof Node) {
    parent.appendChild(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) insertChild(parent, item)
    return
  }
  throw new Error(`insertChild: unsupported child value: ${typeof value}`)
}

export function bindProp(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) return
  el.setAttribute(name, String(value))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- --project dom binding-children`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: total tests = 103 (unit 91, dom 12).

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-children.test.ts
git commit -m "feat(dom): reactive function children via binding-effect"
```

---

### Task 6: `on:` event prefix

**Files:**
- Modify: `src/dom/bindings.ts` (bindProp)
- Create: `test/dom/binding-events.test.ts`

`on:click={fn}` calls `addEventListener('click', fn)` and `removeEventListener` on dispose. The handler is **not** reactive — it's the function itself.

- [ ] **Step 1: Write the failing test**

Create `test/dom/binding-events.test.ts`:

```ts
import { afterEach, expect, test, vi } from 'vitest'
import { h } from '../../src/dom/h'
import { createRoot } from '../../src/index'

afterEach(() => { document.body.innerHTML = '' })

test('on:click attaches a listener', () => {
  const handler = vi.fn()
  createRoot(() => {
    const el = h('button', { 'on:click': handler }) as HTMLButtonElement
    document.body.append(el)
    el.click()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

test('on:event passes the lowercased event name', () => {
  const handler = vi.fn()
  createRoot(() => {
    const el = h('input', { 'on:input': handler }) as HTMLInputElement
    document.body.append(el)
    el.dispatchEvent(new Event('input'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

test('on:click listener is removed on owner dispose', () => {
  const handler = vi.fn()
  let el!: HTMLButtonElement
  const dispose = createRoot((d) => {
    el = h('button', { 'on:click': handler }) as HTMLButtonElement
    document.body.append(el)
    return d
  })
  el.click()
  expect(handler).toHaveBeenCalledTimes(1)
  dispose()
  el.click()
  expect(handler).toHaveBeenCalledTimes(1) // unchanged after dispose
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom binding-events`
Expected: FAIL — handler is never invoked (the `on:click` attribute is being set as an HTML attribute, not a listener).

- [ ] **Step 3: Implement the `on:` prefix in `bindProp`**

Replace `bindProp` in `src/dom/bindings.ts` with:

```ts
import { onCleanup } from '../owner'

// ... insertChild unchanged ...

export function bindProp(el: Element, name: string, value: unknown): void {
  // on:event — direct addEventListener; the handler is not reactive
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    const handler = value as EventListener
    el.addEventListener(event, handler)
    onCleanup(() => el.removeEventListener(event, handler))
    return
  }
  // default — setAttribute, no reactivity yet
  if (value === null || value === undefined || value === false) return
  el.setAttribute(name, String(value))
}
```

Add the `onCleanup` import at the top of `src/dom/bindings.ts` (the existing top of file already imports `effect`; add `onCleanup` from `../owner`).

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom binding-events`
Expected: PASS — all 3 cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: total = 106.

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-events.test.ts
git commit -m "feat(dom): on: prefix for event listeners"
```

---

### Task 7: `prop:` property prefix (with reactive function support)

**Files:**
- Modify: `src/dom/bindings.ts` (bindProp)
- Create: `test/dom/binding-prop.test.ts`

`prop:value={x}` assigns `el.value = x` directly. A function value becomes a binding-effect.

- [ ] **Step 1: Write the failing test**

Create `test/dom/binding-prop.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
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

test('prop:value sets the DOM property, not the attribute', () => {
  createRoot(() => {
    const el = h('input', { 'prop:value': 'hi' }) as HTMLInputElement
    document.body.append(el)
    expect(el.value).toBe('hi')
    expect(el.getAttribute('value')).toBe(null) // not set as attribute
  })
})

test('prop:disabled toggles the boolean property correctly', () => {
  createRoot(() => {
    const el = h('button', { 'prop:disabled': true }) as HTMLButtonElement
    document.body.append(el)
    expect(el.disabled).toBe(true)
  })
})

test('prop: with function value is reactive', () => {
  createRoot(() => {
    const v = signal('a')
    const el = h('input', { 'prop:value': v }) as HTMLInputElement
    document.body.append(el)
    expect(el.value).toBe('a')
    setSignal(v, 'b')
    expect(el.value).toBe('b')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom binding-prop`
Expected: FAIL — value is being setAttribute'd, not assigned.

- [ ] **Step 3: Update `bindProp` to handle `prop:`**

Replace `bindProp` in `src/dom/bindings.ts` with:

```ts
export function bindProp(el: Element, name: string, value: unknown): void {
  // on:event — direct addEventListener; the handler is not reactive
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    const handler = value as EventListener
    el.addEventListener(event, handler)
    onCleanup(() => el.removeEventListener(event, handler))
    return
  }
  // prop:name — DOM property assignment; function value is reactive
  if (name.startsWith('prop:')) {
    const prop = name.slice(5)
    if (typeof value === 'function') {
      effect(() => { (el as any)[prop] = (value as () => unknown)() })
    } else {
      ;(el as any)[prop] = value
    }
    return
  }
  // default — setAttribute, no reactivity yet
  if (value === null || value === undefined || value === false) return
  el.setAttribute(name, String(value))
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom binding-prop`
Expected: PASS — all 3 cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: total = 109.

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-prop.test.ts
git commit -m "feat(dom): prop: prefix for DOM properties (reactive)"
```

---

### Task 8: `attr:` prefix and reactive default-attribute path

**Files:**
- Modify: `src/dom/bindings.ts` (bindProp)
- Create: `test/dom/binding-attr.test.ts`

`attr:name` is an explicit `setAttribute`; the bare default also goes through `setAttribute`. A function value in either case becomes a binding-effect that re-runs and either writes the new attribute or removes it (on `null`/`undefined`/`false`).

- [ ] **Step 1: Write the failing test**

Create `test/dom/binding-attr.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
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

test('attr:name explicitly sets the attribute', () => {
  createRoot(() => {
    const el = h('div', { 'attr:aria-label': 'box' }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('aria-label')).toBe('box')
  })
})

test('default (bare) prop with function value is reactive', () => {
  createRoot(() => {
    const id = signal('a')
    const el = h('div', { id }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('id')).toBe('a')
    setSignal(id, 'b')
    expect(el.getAttribute('id')).toBe('b')
  })
})

test('reactive attr is removed when value goes null/false', () => {
  createRoot(() => {
    const v = signal<string | null>('x')
    const el = h('div', { title: v }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('title')).toBe('x')
    setSignal(v, null)
    expect(el.hasAttribute('title')).toBe(false)
    setSignal(v, 'y')
    expect(el.getAttribute('title')).toBe('y')
  })
})

test('attr: with function value is reactive', () => {
  createRoot(() => {
    const v = signal('one')
    const el = h('div', { 'attr:data-x': v }) as HTMLElement
    document.body.append(el)
    expect(el.getAttribute('data-x')).toBe('one')
    setSignal(v, 'two')
    expect(el.getAttribute('data-x')).toBe('two')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom binding-attr`
Expected: FAIL on the function-as-attribute cases (currently `setAttribute(name, String(fn))` produces literal `"function …"`).

- [ ] **Step 3: Add a shared attribute-binding helper and route `attr:`/default through it**

Replace `bindProp` in `src/dom/bindings.ts` with:

```ts
function applyAttr(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name)
  } else {
    el.setAttribute(name, value === true ? '' : String(value))
  }
}

export function bindProp(el: Element, name: string, value: unknown): void {
  // on:event — direct addEventListener; the handler is not reactive
  if (name.startsWith('on:')) {
    const event = name.slice(3)
    if (typeof value !== 'function') return
    const handler = value as EventListener
    el.addEventListener(event, handler)
    onCleanup(() => el.removeEventListener(event, handler))
    return
  }
  // prop:name — DOM property assignment; function value is reactive
  if (name.startsWith('prop:')) {
    const prop = name.slice(5)
    if (typeof value === 'function') {
      effect(() => { (el as any)[prop] = (value as () => unknown)() })
    } else {
      ;(el as any)[prop] = value
    }
    return
  }
  // attr:name — explicit setAttribute; function value is reactive
  if (name.startsWith('attr:')) {
    const attr = name.slice(5)
    if (typeof value === 'function') {
      effect(() => applyAttr(el, attr, (value as () => unknown)()))
    } else {
      applyAttr(el, attr, value)
    }
    return
  }
  // default — same as attr:, with bare name
  if (typeof value === 'function') {
    effect(() => applyAttr(el, name, (value as () => unknown)()))
  } else {
    applyAttr(el, name, value)
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom binding-attr`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Run full suite (existing `h.test.ts` still depends on static-default path)**

Run: `pnpm test`
Expected: total = 113. Existing `h.test.ts` static-attribute cases still pass (the static path still goes through `applyAttr`, which for non-true primitives is `setAttribute(name, String(value))`).

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-attr.test.ts
git commit -m "feat(dom): attr: prefix and reactive default attribute path"
```

---

### Task 9: `class:` and `style:` single-target toggles

**Files:**
- Modify: `src/dom/bindings.ts` (bindProp)
- Create: `test/dom/binding-class-style.test.ts`

`class:active={x}` does `classList.toggle('active', !!x)`. `style:color={x}` does `el.style.setProperty('color', String(x))` (or `removeProperty` when nullish/false). Both are reactive when given a function.

- [ ] **Step 1: Write the failing test**

Create `test/dom/binding-class-style.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
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

test('class:name toggles a class based on truthiness', () => {
  createRoot(() => {
    const el = h('div', { 'class:active': true, 'class:disabled': false }) as HTMLElement
    document.body.append(el)
    expect(el.classList.contains('active')).toBe(true)
    expect(el.classList.contains('disabled')).toBe(false)
  })
})

test('class:name is reactive with a function value', () => {
  createRoot(() => {
    const on = signal(false)
    const el = h('div', { 'class:active': on }) as HTMLElement
    document.body.append(el)
    expect(el.classList.contains('active')).toBe(false)
    setSignal(on, true)
    expect(el.classList.contains('active')).toBe(true)
    setSignal(on, false)
    expect(el.classList.contains('active')).toBe(false)
  })
})

test('style:name sets a single CSS property', () => {
  createRoot(() => {
    const el = h('div', { 'style:color': 'red' }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
  })
})

test('style:name is reactive with a function value', () => {
  createRoot(() => {
    const c = signal('red')
    const el = h('div', { 'style:color': c }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
    setSignal(c, 'blue')
    expect(el.style.color).toBe('blue')
  })
})

test('style:name removes the property on nullish/false value', () => {
  createRoot(() => {
    const c = signal<string | null>('red')
    const el = h('div', { 'style:color': c }) as HTMLElement
    document.body.append(el)
    expect(el.style.color).toBe('red')
    setSignal(c, null)
    expect(el.style.color).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom binding-class-style`
Expected: FAIL — class:/style: keys are being applied as plain attributes.

- [ ] **Step 3: Extend `bindProp` with `class:` and `style:` prefixes**

Update `bindProp` in `src/dom/bindings.ts`. Insert these two prefix blocks immediately after the `attr:` block (before the default fallback):

```ts
  // class:name — toggle a single class; function value is reactive
  if (name.startsWith('class:')) {
    const cls = name.slice(6)
    if (typeof value === 'function') {
      effect(() => el.classList.toggle(cls, !!(value as () => unknown)()))
    } else {
      el.classList.toggle(cls, !!value)
    }
    return
  }
  // style:name — set/remove a single style property; function value is reactive
  if (name.startsWith('style:')) {
    const prop = name.slice(6)
    const apply = (v: unknown) => {
      if (v === null || v === undefined || v === false) {
        ;(el as HTMLElement).style.removeProperty(prop)
      } else {
        ;(el as HTMLElement).style.setProperty(prop, String(v))
      }
    }
    if (typeof value === 'function') {
      effect(() => apply((value as () => unknown)()))
    } else {
      apply(value)
    }
    return
  }
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom binding-class-style`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: total = 118.

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-class-style.test.ts
git commit -m "feat(dom): class: and style: single-target reactive toggles"
```

---

### Task 10: `ref` callback

**Files:**
- Modify: `src/dom/bindings.ts` (bindProp)
- Create: `test/dom/binding-ref.test.ts`

`ref={fn}` invokes `fn(el)` once at mount, not reactive.

- [ ] **Step 1: Write the failing test**

Create `test/dom/binding-ref.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { h } from '../../src/dom/h'
import { createRoot } from '../../src/index'

afterEach(() => { document.body.innerHTML = '' })

test('ref receives the mounted element', () => {
  let captured: HTMLElement | null = null
  createRoot(() => {
    const el = h('div', { ref: (e: HTMLElement) => { captured = e } }) as HTMLElement
    document.body.append(el)
    expect(captured).toBe(el)
  })
})

test('ref is invoked once even if its underlying value is a signal accessor (treated as the function itself)', () => {
  // The spec says ref is not reactive. The handler is the function itself,
  // even if it happens to be a signal accessor.
  let calls = 0
  createRoot(() => {
    const fn = (_: HTMLElement) => { calls++ }
    h('div', { ref: fn })
    expect(calls).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom binding-ref`
Expected: FAIL — `ref` is being treated as a default attribute and the function value triggers a reactive attribute binding.

- [ ] **Step 3: Handle `ref` in `bindProp`**

Insert this block at the top of `bindProp` in `src/dom/bindings.ts`, before any prefix checks:

```ts
  // ref — callback invoked once with the element; not reactive
  if (name === 'ref') {
    if (typeof value === 'function') (value as (el: Element) => void)(el)
    return
  }
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom binding-ref`
Expected: PASS — both cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: total = 120.

- [ ] **Step 6: Commit**

```bash
git add src/dom/bindings.ts test/dom/binding-ref.test.ts
git commit -m "feat(dom): ref callback prop"
```

---

### Task 11: Component (function tag) + Fragment

**Files:**
- Modify: `src/dom/h.ts`
- Create: `test/dom/components.test.ts`

A function tag is called once with the props object (children appended as a `children` key). The `Fragment` symbol tag returns the children flattened into an array.

- [ ] **Step 1: Write the failing test**

Create `test/dom/components.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Fragment, h } from '../../src/dom/h'
import {
  createRoot,
  flush,
  microtaskScheduler,
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

test('a function tag is invoked once with props', () => {
  const Greeting = (props: { name: string }) =>
    h('p', null, 'Hello, ', props.name) as HTMLElement
  createRoot(() => {
    const node = h(Greeting, { name: 'world' }) as HTMLElement
    document.body.append(node)
    expect(node.tagName).toBe('P')
    expect(node.textContent).toBe('Hello, world')
  })
})

test('a function tag receives children via props.children', () => {
  const Box = (props: { children: unknown }) =>
    h('div', { 'class:box': true }, props.children) as HTMLElement
  createRoot(() => {
    const node = h(Box, null, 'inner') as HTMLElement
    document.body.append(node)
    expect(node.classList.contains('box')).toBe(true)
    expect(node.textContent).toBe('inner')
  })
})

test('components compose with reactive children', () => {
  const Label = (props: { value: () => unknown }) =>
    h('span', null, props.value) as HTMLElement
  createRoot(() => {
    const n = signal(1)
    const node = h(Label, { value: n }) as HTMLElement
    document.body.append(node)
    expect(node.textContent).toBe('1')
    setSignal(n, 2)
    expect(node.textContent).toBe('2')
  })
})

test('Fragment returns children as an array', () => {
  createRoot(() => {
    const result = h(Fragment, null, 'a', 'b', 'c')
    expect(Array.isArray(result)).toBe(true)
    expect((result as unknown[]).length).toBe(3)
  })
})

test('Fragment composed inside an element flattens', () => {
  createRoot(() => {
    const el = h('div', null, h(Fragment, null, 'a', 'b'), 'c') as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('abc')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom components`
Expected: FAIL — `h: non-string tags … are not supported yet`.

- [ ] **Step 3: Support function tags and `Fragment` in `h`**

Replace the body of `h` in `src/dom/h.ts` with:

```ts
export function h(tag: Tag, props: Record<string, unknown> | null, ...children: unknown[]): Node | Node[] {
  if (tag === Fragment) {
    return children
  }
  if (typeof tag === 'function') {
    const merged: Record<string, unknown> = props ? { ...props } : {}
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return tag(merged)
  }
  if (typeof tag !== 'string') {
    throw new Error(`h: unsupported tag: ${String(tag)}`)
  }
  const el = document.createElement(tag)
  if (props) {
    for (const key of Object.keys(props)) {
      bindProp(el, key, props[key])
    }
  }
  for (const child of children) {
    insertChild(el, child)
  }
  return el
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom components`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: total = 125.

- [ ] **Step 6: Commit**

```bash
git add src/dom/h.ts test/dom/components.test.ts
git commit -m "feat(dom): function-tag components and Fragment"
```

---

### Task 12: JSX runtime + tsconfig + package wiring

**Files:**
- Create: `src/dom/jsx-runtime.ts`
- Create: `src/jsx-runtime.ts`
- Modify: `src/dom/index.ts`
- Modify: `tsconfig.json`
- Modify: `package.json` (add `exports` field)
- Create: `test/dom/jsx-runtime.test.tsx`

Expose `jsx`, `jsxs`, `Fragment` so `tsconfig`'s `"jsxImportSource": "pulse"` can resolve.

- [ ] **Step 1: Add the JSX runtime wrappers**

Create `src/dom/jsx-runtime.ts`:

```ts
import { Fragment as FragmentSymbol, h, type Tag } from './h'

export const Fragment = FragmentSymbol

/**
 * Called by the TS transform for an element with zero or one child.
 * Children, when present, arrive on `props.children`.
 */
export function jsx(tag: Tag, props: Record<string, unknown> | null): Node | Node[] {
  return jsxImpl(tag, props)
}

/**
 * Called by the TS transform for an element with multiple static children.
 * `props.children` is already an array.
 */
export function jsxs(tag: Tag, props: Record<string, unknown> | null): Node | Node[] {
  return jsxImpl(tag, props)
}

function jsxImpl(tag: Tag, props: Record<string, unknown> | null): Node | Node[] {
  if (!props) return h(tag, null)
  const { children, ...rest } = props
  if (children === undefined) return h(tag, rest)
  if (Array.isArray(children)) return h(tag, rest, ...children)
  return h(tag, rest, children)
}
```

Create `src/jsx-runtime.ts` (top-level re-export the transform imports from):

```ts
export { Fragment, jsx, jsxs } from './dom/jsx-runtime'
```

Update `src/dom/index.ts` to expose the same surface from the directory barrel:

```ts
export { Fragment, h, type Component, type Tag } from './h'
export { jsx, jsxs } from './jsx-runtime'
```

- [ ] **Step 2: Update `tsconfig.json` to enable JSX with pulse as the source**

Edit `tsconfig.json`. Add `"jsx": "react-jsx"` and `"jsxImportSource": "pulse"` inside `compilerOptions`, and add a `paths` entry so `pulse/jsx-runtime` resolves to the local `src/jsx-runtime.ts`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "pulse",
    "paths": {
      "r3": ["../r3/src/index.ts"],
      "pulse/jsx-runtime": ["./src/jsx-runtime.ts"],
      "pulse": ["./src/index.ts"]
    }
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Add a Vitest alias so the transform's `pulse/jsx-runtime` import resolves at test-runtime**

Edit `vitest.config.ts`. Update `aliases`:

```ts
const aliases = {
  r3: resolve(here, '../r3/src/index.ts'),
  'pulse/jsx-runtime': resolve(here, 'src/jsx-runtime.ts'),
  pulse: resolve(here, 'src/index.ts'),
}
```

- [ ] **Step 4: Update `package.json` exports field so consumers can `jsxImportSource: 'pulse'`**

Edit `package.json` — add an `exports` field next to `main`/`types`:

```json
{
  "name": "pulse",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./jsx-runtime": {
      "types": "./dist/jsx-runtime.d.ts",
      "import": "./dist/jsx-runtime.js"
    }
  },
  "scripts": { /* unchanged */ },
  "devDependencies": { /* unchanged */ }
}
```

(The `dist` paths are correct for the eventual `tsdown` build output; tests resolve via the vitest aliases above so they don't depend on a `dist` folder existing.)

- [ ] **Step 5: Write the failing JSX-runtime test**

Create `test/dom/jsx-runtime.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  createRoot,
  flush,
  microtaskScheduler,
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

test('JSX renders an element with reactive child', () => {
  createRoot(() => {
    const count = signal(0)
    const el = (<div>{count}</div>) as HTMLElement
    document.body.append(el)
    expect(el.textContent).toBe('0')
    setSignal(count, 5)
    expect(el.textContent).toBe('5')
  })
})

test('JSX renders nested element with on: and class:', () => {
  let clicked = 0
  createRoot(() => {
    const on = signal(false)
    const el = (
      <button on:click={() => { clicked++ }} class:active={on}>
        ok
      </button>
    ) as HTMLButtonElement
    document.body.append(el)
    el.click()
    expect(clicked).toBe(1)
    expect(el.classList.contains('active')).toBe(false)
    setSignal(on, true)
    expect(el.classList.contains('active')).toBe(true)
  })
})

test('JSX Fragment groups siblings', () => {
  createRoot(() => {
    const el = (
      <div>
        <>
          <span>a</span>
          <span>b</span>
        </>
      </div>
    ) as HTMLElement
    document.body.append(el)
    expect(el.children.length).toBe(2)
  })
})
```

- [ ] **Step 6: Add a minimal JSX namespace so the test typechecks**

Append to `src/dom/jsx-runtime.ts`:

```ts
// Minimal JSX namespace — just enough for Plan 3a tests to typecheck.
// A broader IntrinsicElements / event-attribute typing surface is a
// follow-up (see docs/follow-ups.md).
export namespace JSX {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface IntrinsicElements {
    [tag: string]: Record<string, unknown>
  }
  export type Element = Node | Node[]
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface ElementChildrenAttribute { children: {} }
}
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 8: Run the test**

Run: `pnpm test -- --project dom jsx-runtime`
Expected: PASS — all 3 cases.

- [ ] **Step 9: Run full suite**

Run: `pnpm test`
Expected: total = 128.

- [ ] **Step 10: Commit**

```bash
git add src/dom/jsx-runtime.ts src/jsx-runtime.ts src/dom/index.ts \
        tsconfig.json package.json vitest.config.ts \
        test/dom/jsx-runtime.test.tsx
git commit -m "feat(dom): JSX runtime (jsx/jsxs/Fragment) + tsconfig wiring"
```

---

### Task 13: `render(component, target)` entry + barrel export

**Files:**
- Create: `src/dom/render.ts`
- Modify: `src/dom/index.ts`
- Modify: `src/index.ts`
- Create: `test/dom/render.test.ts`

The single public entry point. Returns `dispose` from `createRoot`. Dispose removes mounted nodes and tears down all effects.

- [ ] **Step 1: Write the failing test**

Create `test/dom/render.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { h } from '../../src/dom/h'
import {
  flush,
  microtaskScheduler,
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

test('render mounts a component and returns dispose', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(() => h('p', null, 'hi'), target)
  expect(target.innerHTML).toBe('<p>hi</p>')
  expect(typeof dispose).toBe('function')
  dispose()
})

test('render dispose removes the mounted nodes', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(() => h('p', null, 'hi'), target)
  expect(target.children.length).toBe(1)
  dispose()
  expect(target.children.length).toBe(0)
})

test('render dispose tears down binding-effects', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const count = signal(0)
  const renders = vi.fn(() => count())
  const dispose = render(() => h('p', null, renders), target)
  expect(renders).toHaveBeenCalledTimes(1)
  setSignal(count, 1)
  expect(renders).toHaveBeenCalledTimes(2)
  dispose()
  setSignal(count, 2)
  expect(renders).toHaveBeenCalledTimes(2) // no further runs after dispose
})

test('render supports a component returning an array', () => {
  const target = document.createElement('section')
  document.body.append(target)
  const dispose = render(
    () => [h('p', null, 'a'), h('p', null, 'b')],
    target,
  )
  expect(target.children.length).toBe(2)
  expect(target.textContent).toBe('ab')
  dispose()
  expect(target.children.length).toBe(0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --project dom render`
Expected: FAIL — `render` is not exported.

- [ ] **Step 3: Implement `render`**

Create `src/dom/render.ts`:

```ts
import { createRoot, onCleanup } from '../owner'

/**
 * Mount the result of `component()` into `target` and return a `dispose`
 * function. Disposing tears down all reactive nodes created during
 * `component()` (binding-effects, computeds, sub-owners from `catchError`)
 * and removes the mounted DOM nodes.
 */
export function render(
  component: () => Node | Node[],
  target: Element,
): () => void {
  return createRoot((dispose) => {
    const result = component()
    const nodes = Array.isArray(result) ? result : [result]
    for (const n of nodes) target.appendChild(n)
    onCleanup(() => {
      for (const n of nodes) {
        if (n.parentNode === target) target.removeChild(n)
      }
    })
    return dispose
  })
}
```

Update `src/dom/index.ts`:

```ts
export { Fragment, h, type Component, type Tag } from './h'
export { jsx, jsxs } from './jsx-runtime'
export { render } from './render'
```

Add the new symbols to the public barrel in `src/index.ts`. Append a line:

```ts
export { Fragment, h, render } from './dom'
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- --project dom render`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: total = 132; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/dom/render.ts src/dom/index.ts src/index.ts test/dom/render.test.ts
git commit -m "feat(dom): render(component, target) entry point"
```

---

### Task 14: Integration — use-throw, error boundary, cascade

**Files:**
- Create: `test/dom/integration.test.tsx`

End-to-end exercises of the binding-effect ↔ owner ↔ catchError ↔ use seam. No new source code; if these tests pass, Plan 3a is feature-complete.

- [ ] **Step 1: Write the failing tests**

Create `test/dom/integration.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  catchError,
  flush,
  microtaskScheduler,
  render,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
  use,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => {
  setScheduler(microtaskScheduler(flush))
  document.body.innerHTML = ''
})

test('use-throw inside a binding holds the previous DOM (stale-but-stable)', async () => {
  const target = document.createElement('section')
  document.body.append(target)

  let resolveFirst!: (v: string) => void
  const first = new Promise<string>((r) => { resolveFirst = r })
  const value = signal<string | Promise<string>>(first)

  const dispose = render(
    () => <div>{() => use(value)}</div>,
    target,
  )

  // Initial render: signal holds a pending promise, binding suspends — empty.
  expect(target.textContent).toBe('')

  // Settle: write-back flips signal to the resolved value; binding re-runs.
  resolveFirst('hello')
  await first
  flush()
  expect(target.textContent).toBe('hello')

  // Set a new pending promise: the binding suspends again, but holds 'hello'.
  let resolveSecond!: (v: string) => void
  const second = new Promise<string>((r) => { resolveSecond = r })
  setSignal(value, second)
  expect(target.textContent).toBe('hello') // stale-but-stable

  resolveSecond('world')
  await second
  flush()
  expect(target.textContent).toBe('world')

  dispose()
})

test('a throw inside a reactive binding is caught by an enclosing catchError', () => {
  const target = document.createElement('section')
  document.body.append(target)

  const caught: unknown[] = []
  const trigger = signal(false)

  const dispose = render(() => {
    return catchError(
      () => (
        <div>
          {() => {
            if (trigger()) throw new Error('boom')
            return 'safe'
          }}
        </div>
      ),
      (e) => caught.push(e),
    ) as Node
  }, target)

  expect(target.textContent).toBe('safe')
  setSignal(trigger, true)
  expect(caught.length).toBe(1)
  expect((caught[0] as Error).message).toBe('boom')

  dispose()
})

test('dispose tears down nested catchError children', () => {
  const target = document.createElement('section')
  document.body.append(target)

  const count = signal(0)
  let runs = 0

  const dispose = render(() => {
    return catchError(
      () => (
        <div>
          {() => {
            runs++
            return String(count())
          }}
        </div>
      ),
      () => {},
    ) as Node
  }, target)

  expect(runs).toBe(1)
  setSignal(count, 1)
  expect(runs).toBe(2)
  dispose()
  setSignal(count, 2)
  expect(runs).toBe(2) // disposed; no further runs
  expect(target.children.length).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- --project dom integration`
Expected: the tests may pass or fail depending on the cumulative implementation; the most likely failures are:
- The `use`-throw test failing if the binding effect doesn't survive the suspension (it should, via Plan 2a behaviour).
- The error-boundary test failing if `catchError`'s return type doesn't accommodate JSX (it returns `T | undefined`).

If they all pass, that's expected — no extra implementation is needed. Skip to Step 4.

- [ ] **Step 3: If failures occurred, fix them**

The most likely fix: if the `catchError` test fails because `catchError(...) as Node` is `undefined` when no throw happens (the handler-caught path returns `undefined`), this is actually fine in this test because the handler doesn't throw on first run — the result *is* a Node. If a real failure happens, dig into whether the binding-effect's owner is the right one (it should be the `catchError`'s sub-owner because `render` ran the component synchronously under `createRoot`, and `catchError` ran inside that, so the binding-effect's `getOwner()` at creation is the sub-owner).

No code change is anticipated. If a real bug surfaces, fix it at the source rather than adapting the test.

- [ ] **Step 4: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: total = 135; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add test/dom/integration.test.tsx
git commit -m "test(dom): end-to-end use-throw + catchError + dispose-cascade integration"
```

---

## Final verification

After Task 14:

- [ ] **Run all tests** — `pnpm test` — expected ~135 passing across both projects.
- [ ] **Run typecheck** — `pnpm typecheck` — expected clean.
- [ ] **Skim the public barrel** — `src/index.ts` now exports `Fragment`, `h`, `render` in addition to the previous symbols; `src/jsx-runtime.ts` exports `jsx`, `jsxs`, `Fragment`.
- [ ] **Dispatch the final whole-implementation review** if running under `superpowers:subagent-driven-development`.

## Out of scope reminders

These do not belong in Plan 3a — defer or surface as follow-ups:

- `Show`, `Switch`, `For`, `Portal` — Plan 3b.
- A typed `JSX.IntrinsicElements` namespace covering real DOM attribute typing — follow-up; the minimal one in Task 12 is just enough for tests.
- SVG / namespaced elements (`createElementNS`) — Plan 3b or later.
- Event delegation, two-phase keying, `<Suspense>` — v2.
- Removing the orphan-sub-owner-without-root edge case from `catchError` — already in `docs/follow-ups.md`.

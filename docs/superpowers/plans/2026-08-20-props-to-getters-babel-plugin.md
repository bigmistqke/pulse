# props-to-getters Babel Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Babel plugin that rewrites dynamic JSX attribute/child expressions (`{expr}`) into thunks (`{() => expr}`) at compile time, wire it into `examples/todo-async`'s Vite dev/build pipeline, and migrate that example to the resulting "call it, let the compiler wrap it" idiom.

**Architecture:** A single Babel plugin visiting `JSXExpressionContainer` nodes, using only AST-node-shape checks (no type information) to decide static-vs-dynamic. It needs no runtime changes: `bindProp`/`insertChild` already treat any function-valued prop/child as reactive, so the plugin only has to produce that same shape the author would otherwise hand-write. The plugin runs in the same `babel.transformSync` pass as `@babel/plugin-transform-react-jsx`, ahead of it in the plugin list, relying on Babel's single depth-first traversal to rewrite attribute/child expressions before the owning JSX element is converted to a `jsx()`/`jsxs()` call.

**Tech Stack:** TypeScript, `@babel/core`, `@babel/types`, `@babel/preset-typescript`, `@babel/plugin-transform-react-jsx`, Vite (example wiring), Vitest (plugin unit tests), Playwright (example acceptance test, pre-existing).

**Spec:** [`docs/superpowers/specs/2026-08-19-props-to-getters-babel-plugin-design.md`](../specs/2026-08-19-props-to-getters-babel-plugin-design.md)

## Global Constraints

- No changes to `src/dom/bindings.ts`, `src/dom/h.ts`, or `src/dom/jsx-runtime.ts` — this is a compile-time-only feature.
- The plugin performs no type-aware analysis. Every decision is based on AST node shape alone (spec §2).
- `ref` and any `on:`-namespaced JSX attribute (`on:click`, `on:input`, ...) are never wrapped, regardless of whether the tag is a DOM element or a component (spec §2).
- `{...spread}` attributes are never touched.
- The Vite integration lives only inside `examples/todo-async`. No new `vite-plugin-pulse` package, no changes to any other example.
- Author all new source as TypeScript (`.ts`), never `.mjs`/`.js`.
- All installs go through `pnpm`. Adding a dependency to the workspace root requires `-w`; adding to an example package uses `pnpm --filter <package-name>`.

---

## Task 1: Babel plugin — core wrap heuristic

**Files:**
- Modify: `package.json` (root) — add devDependencies
- Create: `src/babel-plugin.ts`
- Create: `test/babel-plugin.test.ts`

**Interfaces:**
- Produces: `export default function pulsePropsToGetters(): PluginObj` from `src/babel-plugin.ts` — a zero-argument function returning a Babel `PluginObj`, usable directly in a `plugins: [...]` array passed to `@babel/core`'s `transformSync`/`transformAsync`.

- [ ] **Step 1: Install Babel dependencies at the workspace root**

```bash
pnpm add -D -w @babel/core @babel/types @babel/preset-typescript
```

- [ ] **Step 2: Write the failing test — core heuristic**

Create `test/babel-plugin.test.ts`:

```ts
import { transformSync } from '@babel/core'
import { expect, test } from 'vitest'
import pulsePropsToGetters from '../src/babel-plugin'

function transform(source: string): string {
  const result = transformSync(source, {
    filename: 'test.tsx',
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    plugins: [pulsePropsToGetters],
    babelrc: false,
    configFile: false,
  })
  if (!result?.code) throw new Error('transform produced no code')
  return result.code
}

test('wraps dynamic attribute expressions in a thunk', () => {
  const code = transform('<div a={count()} b={todo.text} c={draft} d={x + y} e={`${count()}`} />;')
  expect(code).toContain('a={() => count()}')
  expect(code).toContain('b={() => todo.text}')
  expect(code).toContain('c={() => draft}')
  expect(code).toContain('d={() => x + y}')
  expect(code).toContain('e={() => `${count()}`}')
})

test('leaves literal attribute values untouched', () => {
  const code = transform('<div a={5} b={"x"} c={true} d={null} />;')
  expect(code).toContain('a={5}')
  expect(code).toContain('b={"x"}')
  expect(code).toContain('c={true}')
  expect(code).toContain('d={null}')
})

test('leaves an existing function/arrow expression attribute value untouched', () => {
  const code = transform('<div onFoo={() => bar()} />;')
  expect(code).toContain('onFoo={() => bar()}')
  expect(code).not.toContain('() => () => bar()')
})
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: FAIL — `src/babel-plugin.ts` does not exist yet (module resolution error).

- [ ] **Step 4: Implement the core heuristic**

Create `src/babel-plugin.ts`:

```ts
import type { PluginObj } from '@babel/core'
import * as t from '@babel/types'

function isStaticOrFunction(expr: t.Expression): boolean {
  return (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isNullLiteral(expr) ||
    t.isArrowFunctionExpression(expr) ||
    t.isFunctionExpression(expr)
  )
}

export default function pulsePropsToGetters(): PluginObj {
  return {
    name: 'pulse-props-to-getters',
    visitor: {
      JSXExpressionContainer(path) {
        const expr = path.node.expression
        if (t.isJSXEmptyExpression(expr)) return
        if (isStaticOrFunction(expr)) return
        path.node.expression = t.arrowFunctionExpression([], expr)
      },
    },
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: PASS (all three tests)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/babel-plugin.ts test/babel-plugin.test.ts
git commit -m "Add core wrap heuristic for the props-to-getters Babel plugin"
```

- [ ] **Step 7: Write the failing test — ref/on: exclusion**

Add to `test/babel-plugin.test.ts`:

```ts
test('never wraps ref or an on:-namespaced attribute, even for a bare identifier value', () => {
  const code = transform('<input ref={setup} on:click={handleClick} on:input={handleInput} />;')
  expect(code).toContain('ref={setup}')
  expect(code).toContain('on:click={handleClick}')
  expect(code).toContain('on:input={handleInput}')
})
```

- [ ] **Step 8: Run the test, verify it fails**

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: FAIL — the current implementation wraps `setup`/`handleClick`/`handleInput` (bare identifiers, not literals or function expressions) into thunks, so the assertions on the literal `ref={setup}` etc. substrings do not match.

- [ ] **Step 9: Implement the exclusion**

Modify `src/babel-plugin.ts`:

```ts
import type { PluginObj } from '@babel/core'
import * as t from '@babel/types'

function isExcludedAttributeName(name: t.JSXIdentifier | t.JSXNamespacedName): boolean {
  if (t.isJSXNamespacedName(name)) return name.namespace.name === 'on'
  return name.name === 'ref'
}

function isStaticOrFunction(expr: t.Expression): boolean {
  return (
    t.isStringLiteral(expr) ||
    t.isNumericLiteral(expr) ||
    t.isBooleanLiteral(expr) ||
    t.isNullLiteral(expr) ||
    t.isArrowFunctionExpression(expr) ||
    t.isFunctionExpression(expr)
  )
}

export default function pulsePropsToGetters(): PluginObj {
  return {
    name: 'pulse-props-to-getters',
    visitor: {
      JSXExpressionContainer(path) {
        const expr = path.node.expression
        if (t.isJSXEmptyExpression(expr)) return
        const parent = path.parent
        if (t.isJSXAttribute(parent) && isExcludedAttributeName(parent.name)) return
        if (isStaticOrFunction(expr)) return
        path.node.expression = t.arrowFunctionExpression([], expr)
      },
    },
  }
}
```

- [ ] **Step 10: Run the test, verify it passes**

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: PASS (all four tests)

- [ ] **Step 11: Add the spread-attribute characterization test**

Add to `test/babel-plugin.test.ts`:

```ts
test('never touches a spread attribute', () => {
  const code = transform('<div {...rest} />;')
  expect(code).toContain('{...rest}')
})
```

This test passes immediately with no further implementation change: `{...rest}` parses as a `JSXSpreadAttribute` node, a different AST shape from `JSXAttribute`/`JSXExpressionContainer` entirely, so the visitor (which only matches `JSXExpressionContainer`) never fires for it. Run it to confirm rather than skipping the check.

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: PASS (all five tests)

- [ ] **Step 12: Commit**

```bash
git add src/babel-plugin.ts test/babel-plugin.test.ts
git commit -m "Exclude ref, on:-namespaced attributes, and spreads from wrapping"
```

---

## Task 2: Confirm the same heuristic applies to JSX children

**Files:**
- Modify: `test/babel-plugin.test.ts`

**Interfaces:**
- Consumes: `pulsePropsToGetters` from Task 1, unchanged.

The visitor added in Task 1 matches `JSXExpressionContainer` wherever it occurs, not only where its parent is a `JSXAttribute`. A JSX child expression (`<div>{count()}</div>`) is the same node type in a different position (parent is `JSXElement`/`JSXFragment` instead of `JSXAttribute`), so it already goes through the identical static/function check — the `ref`/`on:` exclusion simply doesn't apply, because it only triggers when the parent is a `JSXAttribute`. No source change is needed in this task; it exists to lock in that behavior with an explicit test rather than leave it as an unverified side effect of Task 1's implementation.

- [ ] **Step 1: Write the test**

Add to `test/babel-plugin.test.ts`:

```ts
test('wraps dynamic JSX child expressions the same way as attribute values', () => {
  const code = transform('<div>{count()}</div>;')
  expect(code).toContain('{() => count()}')
})

test('leaves a literal or function-expression JSX child untouched', () => {
  const code = transform('<div>{5}{() => bar()}</div>;')
  expect(code).toContain('{5}')
  expect(code).toContain('{() => bar()}')
  expect(code).not.toContain('{() => 5}')
  expect(code).not.toContain('{() => () => bar()}')
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: PASS immediately — no implementation change needed (see rationale above). If either test fails, that means the Task 1 visitor implicitly relied on being inside a `JSXAttribute`, which is not what `src/babel-plugin.ts` after Task 1 does; re-check the file against Task 1 Step 9's final content before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/babel-plugin.test.ts
git commit -m "Add characterization tests for JSX-child wrapping"
```

---

## Task 3: Package export for `pulse/babel-plugin`

**Files:**
- Modify: `package.json` (root) — `exports` map and `build` script

**Interfaces:**
- Consumes: `src/babel-plugin.ts` from Task 1, unchanged.
- Produces: `dist/babel-plugin.js` / `dist/babel-plugin.d.ts`, exported as the `pulse/babel-plugin` subpath — the public surface a future external consumer of the plugin would import. Nothing built in this task or the next two is consumed through this path; `examples/todo-async`'s own Vite wiring (Task 5) imports `src/babel-plugin.ts` directly via a relative path, matching how the example already consumes `src/index.ts`/`src/jsx-runtime.ts` unbuilt.

- [ ] **Step 1: Add the export map entry and extend the build script**

Read `package.json`, then apply:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./jsx-runtime": {
      "types": "./dist/jsx-runtime.d.ts",
      "import": "./dist/jsx-runtime.js"
    },
    "./babel-plugin": {
      "types": "./dist/babel-plugin.d.ts",
      "import": "./dist/babel-plugin.js"
    }
  },
```

```json
    "build": "tsdown --dts src/index.ts src/babel-plugin.ts",
```

- [ ] **Step 2: Build and verify the output exists**

Run: `pnpm build`
Expected: exits 0, and both of the following exist:

```bash
test -f dist/babel-plugin.js && test -f dist/babel-plugin.d.ts && echo OK
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Export pulse/babel-plugin as a public subpath"
```

Note: `dist/` is a build artifact; only commit it if the repository already tracks `dist/` (check with `git status` — the existing `dist/index.js`/`dist/index.d.ts` from prior builds will show whether it's tracked or gitignored, and follow whatever the repo already does).

---

## Task 4: End-to-end pipeline test

**Files:**
- Modify: `package.json` (root) — add devDependency
- Modify: `test/babel-plugin.test.ts`

**Interfaces:**
- Consumes: `pulsePropsToGetters` from Task 1.

- [ ] **Step 1: Install the JSX transform plugin**

```bash
pnpm add -D -w @babel/plugin-transform-react-jsx
```

- [ ] **Step 2: Write the failing test — full pipeline**

Add to `test/babel-plugin.test.ts`:

```ts
function transformToCalls(source: string): string {
  const result = transformSync(source, {
    filename: 'test.tsx',
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    plugins: [
      pulsePropsToGetters,
      ['@babel/plugin-transform-react-jsx', { runtime: 'automatic', importSource: 'pulse' }],
    ],
    babelrc: false,
    configFile: false,
  })
  if (!result?.code) throw new Error('transform produced no code')
  return result.code
}

test('running alongside @babel/plugin-transform-react-jsx produces a jsx() call with the wrapped thunk as the prop value', () => {
  const code = transformToCalls('const el = <div c={count()} />;')
  expect(code).toContain('_jsx(')
  expect(code).toContain('c: () => count()')
})

test('wraps identically whether the tag is a DOM element or a component', () => {
  const code = transform('<Foo c={count()} />; <div c={count()} />;')
  const matches = code.match(/c=\{\(\) => count\(\)\}/g) ?? []
  expect(matches.length).toBe(2)
})
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: FAIL — `@babel/plugin-transform-react-jsx` is not yet importable/configured in a way the test has exercised before now (first run against the new test names); confirm the failure is only in these two new tests and not the five from Tasks 1–2.

- [ ] **Step 4: Run again after confirming the install landed**

If Step 3's failure is a module-resolution error for `@babel/plugin-transform-react-jsx`, re-run `pnpm install` and then:

Run: `pnpm vitest run test/babel-plugin.test.ts`
Expected: PASS — no `src/babel-plugin.ts` change is needed for these two tests; they exercise the plugin ordering already established in Task 1, confirming the assumption in spec §4 with a real transform instead of prose. If either test genuinely fails (not a missing-install issue), inspect the printed `code` value — `console.log(code)` temporarily inside the test — to see the actual generated output and adjust the assertion to match Babel's real generator formatting before touching `src/babel-plugin.ts`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml test/babel-plugin.test.ts
git commit -m "Add end-to-end pipeline test against @babel/plugin-transform-react-jsx"
```

---

## Task 5: Wire the plugin into `examples/todo-async`'s Vite config

**Files:**
- Modify: `examples/todo-async/package.json` — add devDependencies
- Create: `examples/todo-async/vite-jsx-plugin.ts`
- Modify: `examples/todo-async/vite.config.ts`

**Interfaces:**
- Consumes: default export of `../../src/babel-plugin.ts` (Task 1), via a relative import — not the `pulse/babel-plugin` package export from Task 3 (see Task 3's Interfaces note).
- Produces: `export function pulseJsx(): Plugin` from `examples/todo-async/vite-jsx-plugin.ts`, a Vite plugin factory consumed by `vite.config.ts`.

- [ ] **Step 1: Install Babel dependencies in the example package**

```bash
pnpm --filter @pulse-examples/todo-async add -D @babel/core @babel/preset-typescript @babel/plugin-transform-react-jsx
```

- [ ] **Step 2: Create the Vite transform plugin**

Create `examples/todo-async/vite-jsx-plugin.ts`:

```ts
import { transformAsync } from '@babel/core'
import type { Plugin } from 'vite'
import pulsePropsToGetters from '../../src/babel-plugin'

export function pulseJsx(): Plugin {
  return {
    name: 'pulse-jsx',
    async transform(code, id) {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null
      const result = await transformAsync(code, {
        filename: id,
        presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
        plugins: [
          pulsePropsToGetters,
          ['@babel/plugin-transform-react-jsx', { runtime: 'automatic', importSource: 'pulse' }],
        ],
        babelrc: false,
        configFile: false,
        sourceMaps: true,
      })
      if (!result?.code) return null
      return { code: result.code, map: result.map }
    },
  }
}
```

- [ ] **Step 3: Wire it into the Vite config, remove the esbuild JSX transform**

Read `examples/todo-async/vite.config.ts`, then replace its contents:

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { pulseJsx } from './vite-jsx-plugin'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [pulseJsx()],
  resolve: {
    alias: {
      'pulse/jsx-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse/jsx-dev-runtime': resolve(here, '../../src/jsx-runtime.ts'),
      'pulse': resolve(here, '../../src/index.ts'),
    },
  },
})
```

This drops the previous `esbuild: { jsx: 'automatic', jsxImportSource: 'pulse' }` block entirely — `pulseJsx()` now owns JSX compilation for `.tsx`/`.jsx` files in this example.

- [ ] **Step 4: Verify the pipeline runs without crashing**

Run: `pnpm --filter @pulse-examples/todo-async build`
Expected: exits 0. This confirms the Babel pipeline compiles the existing (not yet migrated) `src/main.tsx` without throwing — it does NOT confirm functional correctness of the five bare-accessor call sites listed in the spec's §5 migration table. Nothing in this example's type checking or build catches that class of bug today (`jsx-runtime.ts`'s `IntrinsicElements` types every attribute as `unknown`), so a clean build here is expected either way. Task 6's Playwright run is the real check.

- [ ] **Step 5: Commit**

```bash
git add examples/todo-async/package.json examples/todo-async/pnpm-lock.yaml examples/todo-async/vite-jsx-plugin.ts examples/todo-async/vite.config.ts
git commit -m "Wire the props-to-getters Babel plugin into the todo-async example"
```

(If the example doesn't have its own `pnpm-lock.yaml` — this is a pnpm workspace, so the lockfile is likely only at the repo root — drop that path from the `git add` and instead include the root `pnpm-lock.yaml`.)

---

## Task 6: Migrate `examples/todo-async/src/main.tsx` and verify with Playwright

**Files:**
- Modify: `examples/todo-async/src/main.tsx`

**Interfaces:**
- None — this task only changes JSX call sites inside a single file; no exported signatures change.

Five call sites pass a bare accessor reference directly, relying on the caller (not the compiler) to have already produced a callable thunk. Under the plugin now running, each of these bare references gets wrapped as-is — turning `prop:value={draft}` into `prop:value={() => draft}`, a thunk that returns the accessor function itself instead of calling it. Each must be changed to call the accessor, which the plugin then re-wraps into the same shape the code relied on before (`Show.when` accepts `T | (() => T)` per `src/dom/show.ts:46-48`; `bindProp`'s `prop:`/`class:` handlers unwrap a function value the same way regardless of who produced it).

- [ ] **Step 1: Fix the required call sites**

In `examples/todo-async/src/main.tsx`, apply these five changes:

```tsx
        <Show when={loading}>
```
→
```tsx
        <Show when={loading()}>
```

```tsx
        <Show when={speculating}>
```
→
```tsx
        <Show when={speculating()}>
```

```tsx
      <ul class="todo-list" class:speculative={speculating} data-testid="todo-list">
```
→
```tsx
      <ul class="todo-list" class:speculative={speculating()} data-testid="todo-list">
```

```tsx
                        prop:value={draft}
```
→
```tsx
                        prop:value={draft()}
```

```tsx
                        class:has-error={mutationFailed.active}
```
→
```tsx
                        class:has-error={mutationFailed.active()}
```

- [ ] **Step 2: Verify the build still succeeds**

Run: `pnpm --filter @pulse-examples/todo-async build`
Expected: exits 0

- [ ] **Step 3: Simplify the now-redundant manual thunks**

Apply these behavior-preserving simplifications (the plugin regenerates the identical thunk from the dereferenced form):

```tsx
            <li class:done={() => todo.done} data-testid="canonical-row">
              {() => todo.text}
            </li>
```
→
```tsx
            <li class:done={todo.done} data-testid="canonical-row">
              {todo.text}
            </li>
```

```tsx
            <li class:done={() => todo.done} data-testid="todo-row">
              <input
                attr:type="checkbox"
                prop:checked={() => todo.done}
                on:change={() => toggleTodo(todo)}
              />
              <span class="text">{() => todo.text}</span>
```
→
```tsx
            <li class:done={todo.done} data-testid="todo-row">
              <input
                attr:type="checkbox"
                prop:checked={todo.done}
                on:change={() => toggleTodo(todo)}
              />
              <span class="text">{todo.text}</span>
```

```tsx
            data-testid="filter-all"
            class:active={() => filter() === 'all'}
```
→
```tsx
            data-testid="filter-all"
            class:active={filter() === 'all'}
```

```tsx
            data-testid="filter-active"
            class:active={() => filter() === 'active'}
```
→
```tsx
            data-testid="filter-active"
            class:active={filter() === 'active'}
```

```tsx
            data-testid="filter-completed"
            class:active={() => filter() === 'completed'}
```
→
```tsx
            data-testid="filter-completed"
            class:active={filter() === 'completed'}
```

Leave the `each` prop body and the remaining-count child (`{() => { use(todos); return \`${remaining()} left\` }}`) exactly as they are — both call `use(todos)` inside the closure for transition-engagement/suspension, which must stay hand-written.

- [ ] **Step 4: Run the Playwright acceptance suite**

Run: `pnpm --filter @pulse-examples/todo-async test`
Expected: all tests in `tests/todo-async.spec.ts` PASS. This is the functional confirmation that the five required rewrites in Step 1 actually preserve behavior — in particular, watch for failures around the new-todo input (`data-testid="new-todo"`, exercising the `prop:value={draft()}` fix), the loading/saving indicators (`data-testid="inflight"`/`"saving"`, exercising the two `Show` fixes), and the speculative-list styling (`data-testid="todo-list"`, exercising `class:speculative`).

- [ ] **Step 5: Commit**

```bash
git add examples/todo-async/src/main.tsx
git commit -m "Migrate todo-async to the call-it-let-the-compiler-wrap-it idiom"
```

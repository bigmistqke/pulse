# props-to-getters Babel plugin — design spec

**Status:** design complete.
**Date:** 2026-08-19.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), `src/dom/bindings.ts`,
`src/dom/h.ts`, `src/dom/jsx-runtime.ts`.

---

## 1. Motivation and scope

Today, reactivity into a JSX attribute or child is opted into by hand: the
author writes a thunk or passes a bare accessor reference directly —
`class:done={() => todo.done}`, `prop:value={draft}`, `<Show when={loading}>`.
`bindProp` (`src/dom/bindings.ts`) already treats any function-valued prop as
reactive (wraps it in an effect and re-applies on change); `insertChild`
already treats any function-valued child the same way. Function components
receive whatever value was passed, so a function-valued prop reaching a
component is already, by convention, an accessor the component calls itself.

This plugin removes the requirement to hand-write the thunk. Given
`<Foo count={count()} />`, the compiler rewrites the attribute value to
`() => count()` before the JSX runtime ever sees it, so the existing
function-is-reactive machinery in `bindProp`/`insertChild` picks it up with
no runtime changes at all. The author writes the dereferenced value; the
compiler adds back the thunk.

**In scope:**

- A Babel plugin that rewrites JSX attribute values and JSX child
  expressions from `{expr}` to `{() => expr}` when `expr` is judged dynamic
  (§2).
- Package export `pulse/babel-plugin`.
- A unit test suite that runs the plugin through `@babel/core` and asserts
  on the transformed output.
- Wiring the plugin into `examples/todo-async`'s Vite dev/build pipeline,
  replacing its current `esbuild.jsx` automatic-runtime config with a
  Babel-based transform hook.
- Migrating `examples/todo-async/src/main.tsx` to the "call it, let the
  compiler wrap it" idiom where the existing code passes a bare accessor
  reference directly (§5) — required for correctness, not style.

**Out of scope (deferred):**

- A general-purpose `vite-plugin-pulse` package. The Vite integration
  written for this task lives inside `examples/todo-async` only.
- Wiring the plugin into any other example, or into the library's own
  `tsconfig.json`/build (`tsdown`) — those keep using tsc's/esbuild's
  built-in JSX transform, unaffected by this work.
- Any change to `bindProp`, `insertChild`, `h`, or `jsx-runtime.ts`. None is
  needed; that is the point of building on the existing function-is-reactive
  convention rather than inventing a parallel getter-object mechanism.
- Type-aware analysis (e.g. checking whether an identifier's static type is
  a function). The plugin is purely syntactic — see §2 for why that's
  sufficient.

## 2. The wrap heuristic

For every JSX attribute value and every JSX child that is a
`JSXExpressionContainer` holding a real expression (not a comment-only
`JSXEmptyExpression`):

**Left untouched (not wrapped):**

- Literal expressions: `StringLiteral`, `NumericLiteral`, `BooleanLiteral`,
  `NullLiteral`.
- Expressions that are already a function: `ArrowFunctionExpression`,
  `FunctionExpression`.
- Any attribute value on:
  - the `ref` prop (bare name `ref`), and
  - an `on:`-namespaced attribute (`on:click`, `on:input`, ...).

  These two exclusions are attribute-name-based, not tag-type-based — they
  apply the same way on a DOM element or a component. `bindings.ts` gives
  `ref` and `on:*` a hard contract: the value must be the actual callback,
  invoked directly with the element or the event, never a thunk around it.
  Wrapping either would silently break them (the thunk would return the
  callback instead of invoking it). A component author who names a prop
  `ref` to mirror that convention gets the same protection.
- `JSXSpreadAttribute` (`{...rest}`) is never visited — spreads are passed
  through structurally untouched.

**Wrapped** (`{expr}` → `{() => expr}`): everything else — `Identifier`,
`MemberExpression`, `CallExpression`, `BinaryExpression`, `LogicalExpression`,
`ConditionalExpression`, `TemplateLiteral`, `ObjectExpression`,
`ArrayExpression`, and so on.

This mirrors Solid's own compiler rule (wrap anything that isn't obviously
static or already a function), chosen over a narrower "only wrap
call/member expressions" rule so a plain identifier holding a signal read
some other way is never silently missed. The cost is that a prop whose
value happens to be static in a particular case (e.g. `id={pageId}` where
`pageId` never changes) still gets wrapped into a one-shot reactive
binding — functionally harmless, a minor and accepted overhead.

No type information is consulted. The plugin cannot tell whether a bare
identifier holds a plain value or an accessor function; that ambiguity is
resolved by convention, not analysis (§5 explains the one place this
matters in practice).

### 2.1 Bare (unbraced) JSX-element and fragment children of a component

In standard JSX, `<Foo><Bar/></Foo>` and `<Foo>{<Bar/>}</Foo>` are
equivalent — both produce the identical `children` value. The wrap rule
above only ever sees the second form: a bare `<Bar/>` with no braces is a
`JSXElement` sitting directly in the parent's children array, not a
`JSXExpressionContainer`, so the `JSXExpressionContainer` visitor never
runs on it. Left alone, this makes the compiler's output depend on
whether an author (or their editor's format-on-save) happened to type
braces around a single JSX-element child — for a component whose contract
requires a deferred/function child (e.g. `<Loading>`'s `children`), the
unbraced form would construct that child eagerly, outside the boundary
it's meant to defer into, while the braced form would correctly defer it.
That inconsistency was found live, from exactly this formatter-driven
flip.

The plugin closes it with a second rule, applied to `JSXElement` and
`JSXFragment` nodes directly (not via the `JSXExpressionContainer`
visitor): a bare element/fragment child is wrapped into
`{() => <OriginalElement/>}` — reproducing exactly what the braced form
already compiles to — when, and only when, its immediate parent tag is a
**component** (a JSX name starting with an uppercase letter, or a member
expression like `Foo.Bar`). A DOM tag's direct element children
(`<div><span>hi</span></div>`'s `<span>`) are never touched by this rule:
wrapping those would reactive-bind every ordinarily-static nested element
in the entire codebase, a massive and wrong behavior change for the
overwhelmingly common case. This is the one place in the plugin that is
tag-aware — every other rule in this document is not.

This second rule can produce a bare component-tag child (e.g. a
`<Match>` used as a direct child of `<Switch>`) that itself now arrives
at its consumer wrapped in a thunk, where it previously arrived as the
raw value. A consumer that inspects its children synchronously — `Switch`
reading each `<Match>` child's tagged shape, rather than rendering it —
needs to unwrap that thunk before inspecting it (`src/dom/switch.ts`).
`src/dom/resolve.ts`'s `resolve()` (§3) is the single-call, non-recursive
unwrap used for this and for every other "the compiler may have wrapped
this" consumption point in the framework.

## 3. Architecture

```
src/
  babel-plugin.ts       — the plugin: visits JSXAttribute / JSXExpressionContainer,
                           applies the §2 heuristic, wraps in an ArrowFunctionExpression
  index.ts               — unchanged
package.json              — new export "./babel-plugin" -> dist/babel-plugin.js
test/
  babel-plugin.test.ts    — @babel/core transform() on source snippets, asserts on
                           the generated output string
examples/todo-async/
  vite-jsx-plugin.ts       — Vite `transform` hook: runs @babel/core with
                           @babel/preset-typescript (isTSX) + the plugin +
                           @babel/plugin-transform-react-jsx (automatic runtime,
                           importSource: 'pulse'), for .tsx/.jsx files
  vite.config.ts           — swap `esbuild.jsx` config for the new plugin
  src/main.tsx              — migrated call sites (§5)
```

`examples/todo-async` currently resolves `pulse`/`pulse/jsx-runtime` to
`src/*.ts` via a Vite `resolve.alias`, not through the package's built
`dist/` output — `dist/jsx-runtime.js` doesn't even exist yet, despite the
export being declared in `package.json`. `vite-jsx-plugin.ts` doesn't need
a parallel alias for the plugin, though: it's config-time code executed by
Vite's own Node-side loader, not application code passed through Vite's
bundler resolve step, so it imports the plugin with a plain relative path
(`../../src/babel-plugin.ts`) directly. The `package.json` `"./babel-plugin"`
export is added anyway, for parity with `"./jsx-runtime"` and as the public
surface a future external consumer would use — but nothing in this task's
own wiring depends on it resolving.

For attribute and expression-container-child wrapping (§2), the plugin is
tag-agnostic: it never needs to know whether a JSX element is a DOM tag or
a component, since the exclusion rules are attribute-name-based and the
wrap/no-wrap decision is the same either way. The one exception is the
bare-element/fragment-child rule (§2.1), which is deliberately
tag-aware — it must be, to avoid wrapping every ordinary nested DOM
element in the codebase.

## 4. Babel pipeline integration

A single `babel.transformSync` call per file, in this plugin order:

```ts
transformSync(code, {
  filename,
  presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
  plugins: [
    propsToGettersPlugin,
    ['@babel/plugin-transform-react-jsx', { runtime: 'automatic', importSource: 'pulse' }],
  ],
})
```

Babel merges all plugins' visitors into one depth-first traversal.
`propsToGettersPlugin`'s visitor matches `JSXAttribute`/`JSXExpressionContainer`
nodes; `@babel/plugin-transform-react-jsx`'s visitor matches `JSXElement`/
`JSXFragment` nodes and converts them to `jsx`/`jsxs`/`jsxDEV` calls once
their children have been visited. Because attribute and child nodes are
visited before their owning element's conversion happens, the rewrite is
guaranteed to see the original JSX attribute value, and the JSX-to-call
transform is guaranteed to see the already-wrapped result. This ordering
is asserted by the test suite (§6), not just assumed.

`@babel/preset-typescript` with `isTSX: true` both parses the `.tsx`
syntax (types + JSX) and strips the type annotations; no separate
`@babel/plugin-syntax-jsx` is needed. The `automatic` runtime with
`importSource: 'pulse'` reproduces exactly what `tsconfig.json`'s
`jsx: "react-jsx"` / `jsxImportSource: "pulse"` already produces today, so
output shape (calls into `pulse/jsx-runtime`'s `jsx`/`jsxs`/`jsxDEV`) is
unchanged — only the props/children passed into those calls differ.

## 5. Migration of `examples/todo-async/src/main.tsx`

The plugin's heuristic (§2) wraps any bare identifier or member expression,
including ones that already hold an accessor function. The file currently
has five call sites that pass such a bare reference directly, relying on
the *caller* passing the already-callable accessor rather than the
compiler generating one:

| Site | Current | Required change |
|---|---|---|
| `<Show when={loading}>` (App) | bare identifier | `when={loading()}` |
| `<Show when={speculating}>` (App) | bare identifier | `when={speculating()}` |
| `class:speculative={speculating}` (TodoList) | bare identifier | `class:speculative={speculating()}` |
| `prop:value={draft}` (App, new-todo input) | bare identifier | `prop:value={draft()}` |
| `class:has-error={mutationFailed.active}` (App) | member expression | `class:has-error={mutationFailed.active()}` |

Each is behavior-preserving: `Show.when` is typed `T | (() => T)` and
unwraps either form identically (`src/dom/show.ts:46-48`); `bindProp`'s
`prop:`/`class:` handlers unwrap a function value the same way regardless
of whether it came from the author or from this compiler pass
(`src/dom/bindings.ts`). Without this rewrite, the plugin would instead
compile these five sites into `() => loading` etc. — a thunk that returns
the accessor function itself rather than calling it — which is a real bug,
not a style issue.

Additionally, to actually demonstrate what the plugin buys, the following
now-redundant manual thunks are simplified (also behavior-preserving,
since the plugin regenerates the identical thunk):

- `{() => todo.text}` → `{todo.text}` (canonical row, todo row's text span)
- `class:done={() => todo.done}` → `class:done={todo.done}` (both rows)
- `prop:checked={() => todo.done}` → `prop:checked={todo.done}`
- `class:active={() => filter() === 'all'}` and the `'active'`/`'completed'`
  siblings → drop the wrapping arrow

Two existing thunks are deliberately left alone: the `each` prop's body and
the remaining-count child, both of which call `use(todos)` inside the
closure for transition-engagement/suspension purposes. `use()` must run
inside the function value that becomes the reactive binding's read; rather
than reasoning about whether the compiler's wrap would preserve that
placement, these stay hand-written.

## 6. Testing plan

`test/babel-plugin.test.ts`, using `@babel/core`'s `transformSync` directly
against small `.tsx` source strings (no file I/O), asserting on the
generated code (string match or a light AST assertion, not full pipeline
snapshots):

- Literal attribute values pass through unwrapped (`a={5}`, `b={"x"}`,
  `c={true}`, `d={null}`).
- An existing arrow/function expression attribute value passes through
  unwrapped.
- A call expression (`count()`), member expression (`todo.text`), bare
  identifier (`draft`), binary expression, and template literal all get
  wrapped in `() => ...`.
- `ref={fn}` and `on:click={handler}` pass through unwrapped even though
  `fn`/`handler` are bare identifiers — the exclusion is attribute-name
  driven, not expression-shape driven.
- The same wrap/no-wrap rules apply to a JSX child expression container,
  not just attributes.
- `{...rest}` spread attributes are untouched.
- A component tag (uppercase JSX name) is wrapped identically to a DOM tag
  (lowercase) — the plugin does not special-case by tag type.
- End-to-end: running the plugin together with
  `@babel/plugin-transform-react-jsx` in one `transformSync` call (§4)
  produces a `jsx(...)` call whose props object contains the wrapped arrow
  function, confirming the ordering assumption in §4 rather than just
  asserting it in prose.

For the example integration: `examples/todo-async` already has a Playwright
suite (`tests/todo-async.spec.ts`). After wiring the Vite plugin and
migrating `main.tsx`, that suite is the acceptance check — it exercises the
app through the real dev server, so a broken wrap (e.g. the `draft()`
regression from §5 if missed) shows up as a failing UI test, not just a
compile-time difference.

# pulse DOM rendering core — design spec (Plan 3a)

**Status:** design complete.
**Date:** 2026-05-15.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), [master design spec §9](2026-05-14-pulse-design.md), `docs/adr/0001`–`0006`.

---

## 1. Motivation and scope

pulse's reactivity core, ownership tree, and error boundaries are in place
(Plans 1–2d). Plan 3a builds the smallest DOM layer that turns that reactivity
into mounted, interactive DOM — enough to write real components, exercise the
async + error model end-to-end in a browser, and prove the boundary between
core and DOM is clean.

**In scope (Plan 3a):**

- `render(component, target): () => void` entry point
- JSX runtime (`jsx` / `jsxs` / `Fragment`) backing a single `h` function
- Child bindings (static + reactive)
- Attribute / property / event / class / style bindings via pota-style namespaces
- Refs
- Integration with existing `effect`, `catchError`, `use`, owner disposal
- Internal extraction of `createSubOwner` from `src/owner.ts`
  (Plan 2d follow-up)

**Out of scope (deferred to Plan 3b / v2):**

- `Show`, `Switch`, `For`, `Portal`
- `<Suspense>` / Loading boundaries
- `latest()` / `isPending()` user helpers (add only if a test demands them)
- SVG / MathML namespace handling (`createElementNS`)
- A full typed `JSX.IntrinsicElements` namespace (Plan 3a ships the smallest
  one the tests need; broader typing is a follow-up)
- SSR / hydration
- Event delegation
- Two-phase keying

## 2. Architecture

```
src/
  dom/
    h.ts            — h(tag, props, ...children); Fragment symbol
    jsx-runtime.ts  — jsx, jsxs, Fragment (thin wrappers over h)
    render.ts       — render(component, target): () => void
    bindings.ts     — internal: insertChild, bindProp, prefix dispatch
  owner.ts          — extracts internal createSubOwner(handler?)
  index.ts          — re-exports render, h, Fragment
  jsx-runtime.ts    — re-export of dom/jsx-runtime for jsxImportSource
test/dom/           — DOM tests under Vitest browser mode (Playwright)
```

One responsibility per file. `h.ts` knows JSX shapes; `bindings.ts` knows how
to wire one prop / one child; `render.ts` knows root + mount + dispose.
Components, fragments, and arrays are handled inside `h` and `insertChild`;
nothing about pulse reactivity leaks into the JSX layer beyond "function =
reactive."

## 3. JSX runtime

pulse ships a JSX *runtime* — no babel transform, no template
pre-compilation. Users configure `tsconfig.json` with `"jsx": "react-jsx"` and
`"jsxImportSource": "pulse"`; their `<div/>` desugars to `jsx('div', { … })`,
which forwards to `h`.

```ts
// src/dom/h.ts
export const Fragment = Symbol('Fragment')
export type Component<P = {}> = (props: P) => Node | Node[]
export type Tag = string | Component | typeof Fragment

export function h(tag: Tag, props: object | null, ...children: unknown[]): Node | Node[]
```

- `tag` string → `document.createElement(tag)`, then `bindProp` each prop entry
  and `insertChild` each child.
- `tag` function → component: called once with `{ ...props, children }`;
  whatever it returns is the result. Components run synchronously, exactly
  once, and never suspend (per master spec §9).
- `tag` `Fragment` symbol → returns the children array (or single child) for
  the parent's `insertChild` to flatten.

`jsx(tag, props)` and `jsxs(tag, props)` both pull `children` out of `props`
and forward to `h(tag, propsWithoutChildren, ...childrenArray)`. The only
practical difference is that `jsxs` is called by the transform when children
are statically known to be an array; both produce identical results here.

## 4. Child bindings — the reactivity rule

The rule for children is **function = reactive, anything else = static.**

| Child value | Behaviour |
|---|---|
| `string` / `number` | text node, written once |
| `null` / `undefined` / `boolean` | nothing rendered (an empty marker comment so re-renders have a known insert position) |
| DOM `Node` | inserted as-is |
| array | each element bound recursively by these rules; order preserved via marker comments |
| **function** | wrapped in a binding-effect: on each run the function is called, its result is inserted between two marker comments, and the previous content (if any) is removed first. The effect tracks reactive reads inside the function. |

`use(promiseSignal)` inside a function-form child is legal — the binding-effect
catches the thrown `NotReadyYet` (Plan 2a behaviour), leaves the existing DOM
in place (stale-but-stable; first render with no previous content shows
nothing), and re-runs on settle. Genuine errors throw out of the
binding-effect and route via Plan 2d's `routeError`.

The "function = reactive" rule means a JSX child *is* the dependency
declaration: `<div>{count}</div>` (passing the accessor) is reactive;
`<div>{count()}</div>` (passing the unwrapped value) is one-shot. The
distinction is greppable.

## 5. Attribute / property / event / class / style — namespaced

Pota-style prefix dispatch — no heuristics, no boolean-attribute table, no
event-name detection. The prop name's prefix tells the runtime exactly what
to do:

| Prefix | Meaning | Example |
|---|---|---|
| `on:` | event listener; removed via `onCleanup` on unmount | `on:click={handle}` |
| `prop:` | DOM property assignment (`el[name] = value`) | `prop:value={x}`, `prop:disabled={x}` |
| `attr:` | `setAttribute(name, value)`; the attribute is removed when value is `null`, `undefined`, or `false` | `attr:aria-label={label}` |
| `class:` | toggle one class via `classList.toggle(name, !!value)` | `class:active={isOn}` |
| `style:` | set one style longhand: `el.style.setProperty(name, value)` (or `removeProperty` on nullish) | `style:color={textColor}` |
| `ref` | callback `(el) => void`, invoked once at mount, not reactive | `ref={el => myRef = el}` |
| (none) | default = `attr:` | `class="static"` is `setAttribute('class', 'static')` |

**Function values are reactive in every prefixed slot except `on:`.** A function
under `prop:foo`, `attr:foo`, `class:foo`, `style:foo`, or a bare name becomes
a binding-effect that re-runs on dep change and writes the latest value.
`on:click={fn}` is the lone exception: `fn` is the handler itself, not a
reactive accessor producing a handler — wrapping a handler in reactivity is a
footgun (the handler would re-attach on every dep change).

There is no rich `class={['a', cond && 'b']}` shape and no `style={{...}}`
object shape. A user wanting multiple toggles writes multiple
`class:`-prefixed props; same for `style:`. This is more typing for callers
but zero heuristics in the runtime — and the design matches pulse's
"explicit, local, greppable" thesis (the same reason the async color stays
visible).

Removing an event handler: on unmount, `onCleanup` fires and the listener
is detached. If a reactive prop-binding's owner is disposed (e.g. parent
unmount), its `effect`'s cleanup runs, and the binding stops updating; the
last value remains on the element until something else writes over it. This
matches the existing effect lifecycle.

## 6. `render(component, target)` entry point

```ts
function render(component: () => Node | Node[], target: Element): () => void {
  return createRoot((dispose) => {
    const result = component()
    const nodes = Array.isArray(result) ? result : [result]
    for (const n of nodes) target.append(n)
    onCleanup(() => {
      for (const n of nodes) n.parentNode?.removeChild(n)
    })
    return dispose
  })
}
```

- One entry point. Returns a `dispose` callback that tears down everything:
  binding-effects, their cleanups, attached event listeners, and the mounted
  DOM nodes themselves (via the registered `onCleanup`).
- The owner created by `createRoot` is the ambient owner during `component()`
  and during every reactive binding-effect's runs. `catchError` inside the
  rendered tree attaches a child owner; that child cascade-disposes when the
  root disposes.
- Mounted nodes are removed on dispose only at the top level. Nested DOM
  removal is implicit: removing a root parent unparents its descendants.

## 7. Integration with existing core

Binding-effects use the existing `effect` primitive (Plan 1 + 2a + 2d).
No new node type is introduced for the DOM layer. Consequences:

- **`use`-throw stale-but-stable** falls out: an `effect` that catches
  `NotReadyYet` doesn't re-run its side effect until settle. The DOM written
  on the previous run is untouched in the meantime.
- **Error routing works without DOM-specific code**: a binding-effect that
  throws routes via `routeError` to the nearest `catchError` ancestor.
- **Cleanup cascades** via `onCleanup` and parent-owner disposal — already
  proven by Plan 2c/2d tests.
- **No new scheduler interaction.** Binding-effects queue and flush through
  the same scheduler as every other effect; `setSignal` writes inside an
  event handler batch on microtask by default.

## 8. Owner refactor

`docs/follow-ups.md` flagged that `createSubOwner(handler?)` should be
extracted from `catchError` before Plan 3 begins. Plan 3a does that
extraction:

- New internal (un-exported) `createSubOwner(parent: Owner, handler?: ErrorHandler): Owner`
  in `src/owner.ts`.
- `catchError` becomes the public wrapper that calls `createSubOwner(currentOwner, handler)`,
  runs `fn`, and returns its result.
- No behaviour change. `render` still calls `createRoot` (a *root* — not a
  parented sub-owner). Plan 3b will use `createSubOwner` for `Show`/`For`
  branches.

The "orphan sub-owner with no ambient owner" follow-up (Plan 2d minor)
remains unaddressed — `catchError` outside any root still has no dispose
handle. That's a separate API change, deferred.

## 9. Public API surface

Added to `src/index.ts`:

```ts
export { render, h, Fragment } from './dom'
```

Added at the package root for the JSX transform's import resolution:

```ts
// src/jsx-runtime.ts
export { jsx, jsxs, Fragment } from './dom/jsx-runtime'
```

(Users set `"jsxImportSource": "pulse"` in tsconfig; the transform emits
`import { jsx } from 'pulse/jsx-runtime'`.)

Internal-only (not exported from the public barrel): `bindProp`,
`insertChild`, prefix-dispatch helpers, `createSubOwner`.

## 10. Testing

Vitest browser mode with the Playwright provider (Chromium). Test layout:

```
test/dom/
  smoke.test.tsx              — render a single element, assert innerHTML
  text-binding.test.tsx       — static + reactive children, replacement
  attr-binding.test.tsx       — attr:, prop:, default; sync + reactive + removal
  event.test.tsx              — on:click attach + cleanup; dispose detaches
  class-style.test.tsx        — class: and style: toggles, reactive flip
  ref.test.tsx                — ref callback receives mounted element
  use-throw.test.tsx          — binding suspends, holds prior DOM, settles
  error-boundary.test.tsx     — binding throws, catchError catches; DOM stable
  dispose-cascade.test.tsx    — render's dispose tears down effects + DOM
  components.test.tsx         — nested components, props, fragments
```

Browser-mode rationale: the user picked higher fidelity over speed. Boolean
attributes, focus / blur, real event ordering, and class/style application
all behave exactly like production — no jsdom-vs-real-DOM divergences to
chase.

Each test follows the same shape: `render(() => …, container)`; drive via
`setSignal` (and `flush` under the sync scheduler when determinism matters);
assert against the container; call dispose; assert teardown.

## 11. Design discipline notes

- **Heuristic-free runtime.** Every binding decision is a prefix lookup
  followed by one of six dispatches. No `Object.prototype.hasOwnProperty`
  walks over a boolean-attr list, no `name.startsWith('on') && /[A-Z]/`
  detection. This is the same instinct that kept async color visible in core.
- **Reactivity is opt-in via shape, not by detection.** A function in a
  binding slot = reactive; everything else = static. No signal-brand sniffing
  at the binding site.
- **No new error-routing code.** The binding-effect is just `effect`; Plan 2a
  + 2d already do the work.
- **Components are sugar.** A component is a function the JSX runtime
  invokes once; it has no special lifecycle, owner, or sub-owner in Plan 3a.
  When Plan 3b needs per-branch disposal (because `Show`/`For` remove
  subtrees), it will introduce a `createSubOwner`-based scope at the
  branch boundary — not at the component boundary.

## 12. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Scope | Rendering core only (`Show`/`For` deferred to 3b) | Smaller diff; validates owner / error / async integration before adding control-flow surface |
| JSX | Runtime-only `h` + `jsx`/`jsxs`/`Fragment`, no babel transform | Smallest surface; defers compile-time templating to v2 if a perf gap shows up |
| Reactivity rule | function = reactive, otherwise static | Greppable, no signal-brand sniffing, matches Solid/voby/pota convention |
| Child shapes | static primitive / DOM node / array / function — no `[signal, renderFn]` tuple | Function form covers the tuple's use case via `use(...)` / `latest(...)` |
| Attr/prop/event syntax | Pota-style namespaces (`on:`, `prop:`, `attr:`, `class:`, `style:`) | No heuristics; lines up with pulse's "explicit, local, greppable" thesis |
| Events | Direct `addEventListener` (no delegation) | Predictable; YAGNI on delegation in v1 |
| Render entry | `render(fn, target)` → `dispose` via `createRoot` | One entry point; matches Solid; predictable cleanup |
| Test environment | Vitest browser mode + Playwright (Chromium) | Highest fidelity; no jsdom/happy-dom divergences |
| Owner refactor | Extract internal `createSubOwner` from `catchError` | Addresses Plan 2d follow-up; sets up Plan 3b without rework |

## 13. Relationship to master spec §9

§9 describes the user-facing semantics of the DOM layer; this Plan 3a spec
specifies the *mechanism*. Three notable refinements over §9:

- §9 mentions a `[signal, renderFn]` tuple binding form as an alternative
  to `use(...)`. Plan 3a **drops** the tuple form — the function-form binding
  with `use(...)` or `latest(...)` covers it without adding a second shape
  to the runtime.
- §9 leaves the attribute / event / class / style mechanism unspecified.
  Plan 3a picks pota-style namespaces.
- §9 covers `Show`/`Switch`/`For`. Plan 3a explicitly defers these to
  Plan 3b.

No semantic divergence from §9 — pending stays a value, `use` is the opt-in
throw, errors throw to `catchError`, async color is visible at the binding
site (a function child whose body reads a promise-valued signal is
self-documenting).

# pulse async control flow — design spec (Loading + useLoading)

**Status:** design complete.
**Date:** 2026-05-16.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), [master design spec §11](2026-05-14-pulse-design.md), [Plan 3b spec](2026-05-15-pulse-control-flow-design.md), `docs/adr/0001`–`0006`.

---

## 1. Motivation and scope

Master spec §11 calls v2's Loading "an opt-in coarser catch site for
`NotReadyYet` (coordination), additive to per-node path." Solid 2.x has
the right ergonomics — initial vs. subsequent pending differentiation,
held prior content during reload — but ties them to a transitions-first
runtime entanglement that pulse explicitly rejects.

Pulse's value-level pending info (master spec §6) and the components-
run-once invariant together let Loading work as a thin coordination
boundary: it observes per-binding suspension via an owner-attached
counter, never re-running its thunk or re-instantiating components.

**In scope:**

- `<Loading>` — JSX component creating a boundary scope and selecting
  between initial / fallback / loaded slots based on observed pending
  count.
- `useLoading()` — hook reading the nearest outer Loading scope's
  pending state. Owner-walk pattern, mirrors `routeError`.
- Owner extension: `loadingScope: { pending: Accessor<boolean>; register: () => () => void } | null`
  (analogous to Plan 2d's `errorHandler` addition).
- Per-binding registration: binding-effects that catch `NotReadyYet`
  walk up to find `loadingScope`, register themselves as pending until
  their next successful run.

**Deferred / out of scope:**

- A standalone `loading()` utility — Loading the component IS the
  primitive. Users wanting boundary semantics use `<Loading>`.
- Cross-tree `useLoading()` from outside a Loading subtree — `useLoading()`
  returns a constant-false accessor when no enclosing Loading; cross-tree
  observation can be added later via ref-passing if a real use case
  emerges.
- Solid-style transitions / runtime entanglement — explicitly not built.
- Two-phase keying interactions.

## 2. The two invariants this design respects

### Invariant 1: Components run once

A component function is invoked exactly once at JSX construction. Pulse's
reactivity model puts state in signals/effects/computeds, not in
component-instance lifecycles. A Loading boundary must not violate this:
no whole-subtree re-instantiation on async-settle.

### Invariant 2: `use()` lives inside callbacks

`use(x)` throws `NotReadyYet` synchronously when `x` is pending. For
that throw to be caught locally (by a binding-effect, scheduled to
re-run on settle), `use()` must be inside a function value — a
function-child (`{() => use(x)}`) or a reactive prop accessor
(`prop={() => use(x)}`).

Putting `use()` at the top of a component body or at the top of
Loading's children-thunk would either crash construction or force the
enclosing thunk to re-run on settle — violating Invariant 1.

The convention is documented and enforced by `use()`'s semantics, not
by runtime check. Authors who put `use()` outside a callback see their
component re-instantiate or crash.

## 3. Architecture

```
src/
  dom/
    loading.ts        — <Loading> component, useLoading() hook
  owner.ts            — extends Owner with `loadingScope` field
  effect.ts           — binding-effect registers with loadingScope when catching NotReadyYet
  index.ts            — re-exports Loading, useLoading
test/
  dom/
    loading.test.tsx
```

## 4. `<Loading>` component

### API

```ts
export interface LoadingProps {
  children: () => unknown   // function child REQUIRED — see §5
  fallback?: unknown
  initial?: unknown
}

export function Loading(props: LoadingProps): Accessor<unknown>
```

### Semantics

1. Loading creates a sub-owner (the `boundaryOwner`) parented to whatever
   owner was ambient at `Loading(props)` call time.
2. It attaches a `loadingScope` to `boundaryOwner`, exposing a `pending`
   accessor and a `register()` method that returns an unregister
   callback.
3. It calls `props.children()` **exactly once**, inside
   `runWithOwner(boundaryOwner, …)`. This produces the loaded subtree
   as JSX (already-constructed Node(s)). Components inside run once;
   their effects/bindings are owned by descendants of `boundaryOwner`.
4. It returns a reactive accessor that observes
   `loadingScope.pending` and a `hasEverLoaded` flag, returning:
   - `pending === false` → the loaded subtree (Nodes returned in step 3)
   - `pending === true, hasEverLoaded === false` → `initial ?? fallback`
   - `pending === true, hasEverLoaded === true` → `fallback ?? loaded subtree` (hold-prior)

`hasEverLoaded` flips to `true` the first time `pending` becomes `false`
(detected via an internal effect).

### Three states

| State | Trigger | Rendered slot | `pending` |
|---|---|---|---|
| **Initial** | At construction, ≥1 inner binding suspended; never settled all-clear yet | `initial ?? fallback` | `true` |
| **Subsequent pending** | Was loaded before, ≥1 inner binding now suspended | `fallback`; if no fallback, hold loaded subtree | `true` |
| **Loaded** | All inner bindings settled | loaded subtree | `false` |

### Implementation shape

```ts
export function Loading(props: LoadingProps): Accessor<unknown> {
  const parentOwner = getOwner()
  const boundaryOwner = createSubOwner(parentOwner)
  const [pendingCount, setPendingCount] = signal(0)
  const pending: Accessor<boolean> = () => pendingCount() > 0

  boundaryOwner.loadingScope = {
    pending,
    register: () => {
      setPendingCount(c => c + 1)
      return () => setPendingCount(c => c - 1)
    },
  }

  // Construct loaded subtree once, inside the boundary owner.
  const loadedSubtree: unknown = runWithOwner(boundaryOwner, props.children)

  let hasEverLoaded = false
  // Flip `hasEverLoaded` the first time pending drops to false.
  effect(() => {
    if (!pending()) hasEverLoaded = true
  })

  return () => {
    if (!pending()) return loadedSubtree
    if (!hasEverLoaded) return props.initial ?? props.fallback
    return props.fallback ?? loadedSubtree
  }
}
```

### What stays alive across transitions

`loadedSubtree` is constructed exactly once. Its DOM Nodes are stable.
Its binding-effects live in descendants of `boundaryOwner`. When
Loading's accessor returns `loadedSubtree` (loaded state) the nodes are
attached; when it returns `fallback` or `initial`, the nodes are
detached by `insertChild`'s reactive-binding swap. **Their bindings
remain alive** (owned by descendants of `boundaryOwner`, which itself is
alive). They keep listening to their deps and re-running on settle.
When pending drops, the subtree is reattached without reconstruction.

This is why "hold prior" is the natural default — there is no other
state to maintain. The Nodes simply re-attach.

## 5. The function-child requirement

```tsx
<Loading initial={<Spinner/>}>
  {() => (
    <>
      <Header/>
      <UserView user={() => use(user)}/>
      <PostsList posts={() => use(posts)}/>
    </>
  )}
</Loading>
```

Why a function child:

- JSX evaluation order: child expressions are constructed before the
  parent component is invoked. `<UserView ...>` would be called with
  the outer (App-level) owner ambient, not Loading's `boundaryOwner`.
  Bindings inside would walk up an owner chain that doesn't include
  Loading.
- The function child defers construction. Loading calls it inside
  `runWithOwner(boundaryOwner, …)`, so all descendants register with the
  correct `loadingScope`.

This is the same trick voby uses for its context Providers; pulse
applies it consistently. The single-`() =>` cost at each `<Loading>`
call site is the documented trade.

## 6. `useLoading()`

### Signature

```ts
export function useLoading(): Accessor<boolean>
```

### Semantics

Walks the current owner's chain looking for the nearest non-null
`loadingScope`. Returns that scope's `pending` accessor. If no enclosing
Loading, returns a constant-false accessor.

```tsx
function Header() {
  const pending = useLoading()
  return (
    <>
      <h1>App</h1>
      <Show when={pending}>{() => <TopBar.Indicator/>}</Show>
    </>
  )
}

<Loading initial={<Spinner/>}>
  {() => (
    <>
      <Header/>                              {/* Header reads outer pending */}
      <UserView user={() => use(user)}/>
    </>
  )}
</Loading>
```

Header runs inside Loading's `boundaryOwner` (via the function-child
materialization). Its `useLoading()` call walks up, finds the
`loadingScope`, and returns its `pending` accessor. When `user`
re-fetches, the count goes positive; Header's `Show` flips on.

### Implementation

```ts
const CONST_FALSE_ACCESSOR: Accessor<boolean> = () => false

export function useLoading(): Accessor<boolean> {
  let owner = getOwner()
  while (owner !== null) {
    if (owner.loadingScope !== null) return owner.loadingScope.pending
    owner = owner.parent
  }
  return CONST_FALSE_ACCESSOR
}
```

## 7. Owner extension

In `src/owner.ts`, add to the `Owner` interface:

```ts
export interface LoadingScope {
  readonly pending: Accessor<boolean>
  /** Call when entering pending state. Returns unregister callback. */
  register: () => () => void
}

export interface Owner {
  // ... existing fields ...
  loadingScope: LoadingScope | null
}
```

Initialize `loadingScope: null` in `newOwner()`. No other lifecycle
changes — `loadingScope` is just a reference field, garbage-collected
with the owner.

## 8. Binding-effect integration

In `src/effect.ts`, the existing `NotReadyYet` catch path gains owner-
walk registration with the nearest `loadingScope`:

```ts
// Inside effect(), near the existing NotReadyYet handler:
let unregister: (() => void) | null = null

// ... existing body ...
try {
  fn()
  // Successful run — if we were registered as pending, unregister now.
  if (unregister !== null) {
    unregister()
    unregister = null
  }
  suspendedOn = null
} catch (e) {
  if (e instanceof NotReadyYet) {
    // ... existing suspension setup ...
    // NEW: register with nearest loadingScope (idempotent — only on first throw per pending period)
    if (unregister === null) {
      const scope = findLoadingScope(myOwner)
      if (scope !== null) unregister = scope.register()
    }
    return
  }
  // ... existing real-error path ...
}
```

`findLoadingScope(owner)` walks up the parent chain. Inline helper in
`src/effect.ts` or shared with `useLoading`.

The `unregister` closure variable lives in the effect's scope; if the
effect is disposed mid-pending, its cleanup must call `unregister()` to
decrement the count. Add that to the effect's own `onCleanup`
registration.

## 9. Reactive prop convention

Components that consume reactive values declare props as
`() => T` (or `FunctionMaybe<T> = T | (() => T)` for flexibility, with
the documented type-safety trade-off — see §13):

```tsx
function UserView(props: { user: () => User }) {
  return <h1>{() => props.user().name}</h1>
}
```

The `{() => props.user().name}` is a function-child of `<h1>`. It's a
binding-effect. `props.user()` calls `() => use(user)`. `use()` throws
if pending. The binding-effect catches and registers with Loading via
owner-walk.

At the call site:

```tsx
<UserView user={() => use(user)}/>
```

Three `() =>`s in the full example are the entire tax: one for
Loading's children, one for each reactive prop. No double-wrap around
component invocations.

## 10. Coordination across multiple `use()` sites

Each binding-effect catches its own `NotReadyYet` and registers
independently. Loading's pending count aggregates:

```tsx
<Loading initial={<Spinner/>} fallback={<Indicator/>}>
  {() => (
    <>
      <UserView user={() => use(user)}/>      {/* registers when user pending */}
      <PostsList posts={() => use(posts)}/>    {/* registers when posts pending */}
    </>
  )}
</Loading>
```

Both pending → count = 2. Either settles → decrement. Both settled →
count = 0 → loaded slot mounts (and `hasEverLoaded` flips true on first
zero).

Per-binding suspension means **each binding resumes independently**.
The user binding settling doesn't re-run posts binding or any
component. Components inside Loading run once.

## 11. Nesting

Inner Loading's `boundaryOwner` is a descendant of outer Loading's
`boundaryOwner` (because the inner is constructed inside the outer's
function child). `useLoading()` walks up and finds the nearest, so an
inner-scope binding registers with the inner Loading only.

```tsx
<Loading initial={<PageSpinner/>}>
  {() => (
    <>
      <UserHeader user={() => use(user)}/>
      <Loading fallback={<PostsSkeleton/>}>
        {() => <PostsList posts={() => use(posts)}/>}
      </Loading>
    </>
  )}
</Loading>
```

Initial render: outer pending (user not ready) → PageSpinner. User
settles: outer loads. UserHeader and the inner Loading mount. Inner
evaluates — posts pending → inner shows PostsSkeleton. Posts settle:
inner loads. Outer never saw posts's pending because the inner
registered first (and the inner's loaded subtree was already inside
the outer's loaded subtree).

## 12. Errors

Non-`NotReadyYet` throws in any binding inside Loading:

- Re-thrown from the binding-effect.
- Routed via `routeError` to the nearest `catchError` ancestor.
- Loading is not in the error path; it strictly coordinates pending,
  not errors.

`catchError` and Loading compose: an outer `catchError` catches what an
inner Loading's bindings throw (apart from `NotReadyYet`, which is
caught by the binding-effect itself).

## 13. Reactive props ergonomics — known limitation

TypeScript catches the `prop={use(x)}` vs `prop={() => use(x)}`
mistake **only when the prop type is strictly `() => T`**. If the prop
type is widened to `FunctionMaybe<T>` for static-or-reactive
flexibility, both forms typecheck even though the eager-call form has
runtime traps (value captured statically; throw on construction →
component re-instantiation if not in a callback).

The pragmatic stance for v1:

- **Recommend strict `() => T`** for reactive props — TS keeps call
  sites honest.
- **`FunctionMaybe<T>`** is available for authors who knowingly want
  flexibility; they accept the looser typing.

A future architectural shift to Solid-style **prop getters** would
resolve the typing gap by making any `prop={x}` reactive at the
property-access site without explicit call. Tracked as a follow-up in
`docs/follow-ups.md`; not in scope for v1.

## 14. Tests

`test/dom/loading.test.tsx`, ~10 tests:

- Synchronous loaded thunk (no `use()` anywhere) → renders result;
  pending stays false; `hasEverLoaded` true immediately.
- Pending `use()` in a binding → renders `initial`; pending true.
- Pending `use()` with no `initial` → renders `fallback`.
- Pending `use()` with neither → renders nothing (undefined).
- Settled → renders loaded subtree; pending false.
- Subsequent pending **with** `fallback` → renders fallback; previous
  loaded subtree's nodes detached but binding-effects still alive
  (verify by signal-driven update arriving at the detached subtree
  when re-mounted).
- Subsequent pending **without** `fallback` → holds prior loaded
  subtree; pending true.
- Two `use()`s pending in parallel → pendingCount=2 → both must settle
  before loaded slot mounts.
- `useLoading()` inside a sync component inside loaded subtree returns
  the outer Loading's pending accessor and is reactive.
- Real error in a binding inside Loading propagates through outer
  `catchError`.
- Disposing the surrounding owner cascades to `boundaryOwner` and all
  its descendants (binding-effects' `unregister`s run via owner cleanup
  but the parent owner is already gone — no decrement attempt against a
  freed scope).
- Nested Loading: inner pending registers only with inner; outer
  pending stays false.

## 15. Public API surface

Added to `src/index.ts`:

```ts
export { Loading, useLoading } from './dom'
```

Added to `src/dom/index.ts`:

```ts
export { Loading, useLoading } from './loading'
```

Added to `src/owner.ts` exports: `type LoadingScope` (internal use by
binding-effect, may stay un-exported from the public barrel).

## 16. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Components run once | Hard invariant | Foundation of pulse's fine-grained reactivity model |
| `use()` allowed locations | Callbacks only (binding-effects, reactive prop accessors) | Top-level `use()` would force enclosing thunk re-run → violates components-run-once |
| Loading boundary shape | JSX component with function child | Only way to construct descendants under boundary owner (JSX evaluation order) |
| Re-execution mechanism | Per-binding-effect (existing Plan 2a) + per-binding owner-walk registration | Coordination without re-running components |
| Hold-prior default | Subsequent pending without `fallback` returns loaded subtree | Bindings stay alive; reattaching is free; "stale-while-revalidate" falls out |
| Pending exposure | `useLoading()` hook (owner-walk) | Symmetric to `routeError`; works from any descendant component |
| State machine | Internal `hasEverLoaded` flag + reactive `pendingCount` | Three-state semantics fall out; no public API for the FSM |
| Reactive prop convention | `() => T` strict, or `FunctionMaybe<T>` opt-in | Strict gives TS safety; flexible accepts trade-off documented as follow-up |
| Cross-tree `useLoading()` | Not built; out-of-tree returns constant-false | YAGNI; ref-passing fallback exists if needed |
| Transitions | Not built | Pulse's value-level pending info + per-binding suspension is the substrate |

## 17. Relationship to master spec §11

§11: "v2 — re-introduce a Loading/`<Suspense>` boundary as an opt-in
*coarser* catch site for `NotReadyYet` (coordination), additive to the
per-node path."

This design matches:
- **Opt-in**: only triggers when user wraps with `<Loading>`.
- **Coarser catch site**: aggregates pending state across all bindings
  inside the boundary; coordinates the loaded slot's mount.
- **Additive**: per-node stale-but-stable (Plan 2a) still works for
  bindings outside any Loading; inside, per-binding suspension
  semantics are unchanged but ALSO contribute to the boundary's
  count.

Extensions beyond §11:
- **Hold-prior-by-default** when `fallback` is omitted — falls naturally
  out of the "boundary doesn't reconstruct anything; just toggles
  attachment" design.
- **Initial / subsequent differentiation** via `hasEverLoaded` —
  inspired by Solid 2.x's three-slot model, achieved without transitions.
- **`useLoading()` for cross-component observation** within the
  boundary's subtree — owner-walk pattern mirrors `routeError`.

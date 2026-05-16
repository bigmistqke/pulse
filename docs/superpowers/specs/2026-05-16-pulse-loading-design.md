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
runtime entanglement that pulse explicitly rejects. Pulse's value-level
pending info (master spec §6 colored async) means we don't need
transitions; the user-facing semantics fall out of catching `NotReadyYet`
at a per-binding scope.

**In scope:**

- `loading(loaded, options?)` — the utility. Returns an accessor branded
  with a `.pending` accessor property.
- `<Loading>` — JSX component wrapping the utility (slot-based ergonomic
  shorthand).
- `useLoading()` — hook reading the nearest outer Loading scope's pending
  signal. Mirrors the owner-walk pattern from `catchError` → `routeError`.
- Owner extension: a `loadingScope: Accessor<boolean> | null` field
  (analogous to Plan 2d's `errorHandler` addition).
- Three-state semantics: initial / subsequent-pending / loaded.
- Hold-prior-view-with-live-effects via a tentative/loadedOwner pattern.

**Deferred:**

- Solid-style transitions / runtime entanglement — explicitly not built.
- `useLoading()` from OUTSIDE a Loading boundary (cross-tree observers
  reading a deeply-nested boundary's state) — not in v1; if a real use
  case shows up, exported `loading()` already lets the caller plumb the
  `pending` accessor wherever they need.
- Two-phase keying interactions with Loading.
- `loaded()` running off-screen / "dry-run" before commit — pulse's
  attempt-then-commit pattern (tentative owner) achieves the same effect
  without speculative rendering.

## 2. Architecture

The factoring mirrors `For`/`mapArray`:

```
src/
  dom/
    loading.ts      — loading() utility, <Loading> JSX wrapper, useLoading()
  owner.ts          — extends Owner with `loadingScope: Accessor<boolean> | null`
  index.ts          — re-exports Loading, loading, useLoading
test/
  dom/
    loading.test.tsx
```

The utility and the JSX wrapper live in the same file because both are
small (~80 LOC combined) and share machinery.

## 3. Three-state semantics

| State | Trigger | Default rendered output | `view.pending()` |
|---|---|---|---|
| **Initial** | First `loaded()` call throws `NotReadyYet`, no prior success | `options.initial?.() ?? options.fallback?.() ?? undefined` | `true` |
| **Subsequent pending** | `loaded()` throws after a prior success | `options.fallback?.() ?? lastLoadedResult` (hold prior) | `true` |
| **Loaded** | `loaded()` returns | latest `loaded()` result | `false` |

**The hold-prior behavior is automatic when `fallback` is omitted.** This
gives stale-while-revalidate semantics by default during reloads — Solid
2.x's friendliest mode without requiring opt-in. Users who want explicit
"swap to spinner" mode pass `fallback`.

## 4. `loading()` utility

### Signature

```ts
export interface LoadingOptions {
  fallback?: () => unknown
  initial?: () => unknown
}

export function loading(
  loaded: () => unknown,
  options?: LoadingOptions,
): Accessor<unknown> & { pending: Accessor<boolean> }
```

### Semantics

On each call of the returned accessor:

1. Create a **tentative sub-owner** parented to the **boundary owner** (a
   durable sub-owner created at `loading()` construction).
2. Run `loaded()` under the tentative owner.
3. **Success path:**
   - Dispose any active slot-owner (from a prior pending state).
   - Dispose the previous `loadedOwner` (committing the new one replaces it).
   - Install `tentative` as the new `loadedOwner`. Save its result as
     `lastLoaded`. Set `hasEverLoaded = true`. Set `pending = false`.
   - Return the result.
4. **`NotReadyYet` throw path:**
   - Dispose the failed tentative (its partial work).
   - Register `.then` on the carried promise to re-kick the accessor (with
     the stale-on-supersede guard — only kick if the same promise is still
     awaited).
   - Set `pending = true`.
   - Pick the rendered output:
     - If `hasEverLoaded` and `fallback` provided → render fallback under
       a fresh slot-owner (cleaning up the previous slot-owner if any),
       and **dispose `loadedOwner`** (its DOM is being replaced).
     - If `hasEverLoaded` and no `fallback` → **hold-prior mode**: keep
       `loadedOwner` alive, dispose any slot-owner, return `lastLoaded`.
     - If `!hasEverLoaded` → render `initial ?? fallback` under a fresh
       slot-owner.
5. **Other throw path:** dispose tentative, re-throw. The binding-effect
   that called the accessor will route via `routeError` → nearest
   `catchError`.

### Owner tree

```
boundaryOwner  (durable; carries loadingScope = pendingSig)
    ├── loadedOwner    (effects of the currently-committed loaded result; sibling rotation)
    ├── slotOwner      (effects of fallback/initial slots; rotates on slot change)
    └── tentative      (transient: each accessor run starts one; either becomes the new loadedOwner or is disposed)
```

The boundary owner is the durable anchor. Its lifetime equals the
`loading()` call's lifetime — it is registered as a child of whatever
owner was ambient when `loading()` was called (typically the parent
component's owner). When that ancestor disposes, the boundary cascades.

### Why this owner structure

- **Loaded effects survive across transitions.** The binding-effect that
  wraps the loading accessor has its own per-run sub-owner (Plan 3a Task
  5). That owner's lifecycle is independent of `loadedOwner`. So the
  prior loaded DOM's effects keep running during a hold-prior transition.
- **Slot effects don't accumulate.** Each pending-to-pending re-render
  disposes the old slot-owner before creating a new one.
- **Cascade disposal works** without per-case bookkeeping: when the
  ambient context that contains the loading() call disposes, boundary
  cascades, taking everything with it.

### Pending exposure

```ts
const view = loading(() => use(user))
view.pending           // Accessor<boolean>
view.pending()         // current value (reactive)
```

The accessor function gets a `pending` property attached. Same pattern
as `signal()` returning a callable that carries internal state.

## 5. `<Loading>` JSX wrapper

```ts
export interface LoadingProps {
  children: () => unknown   // function child REQUIRED
  fallback?: unknown
  initial?: unknown
}

export function Loading(props: LoadingProps): Accessor<unknown> {
  const view = loading(
    () => props.children(),
    {
      fallback: props.fallback === undefined
        ? undefined
        : () => props.fallback,
      initial: props.initial === undefined
        ? undefined
        : () => props.initial,
    },
  )
  return view  // pending accessor still attached but JSX users typically ignore it
}
```

**Function-child required.** Static JSX children make no semantic sense
inside Loading — they're already-constructed Nodes, so there's no
opportunity to catch a `use()` throw. The thunk is what makes use catchable
at this site.

```tsx
<Loading initial={<Spinner/>}>
  {() => <UserView user={use(user)}/>}
</Loading>
```

JSX users who want pending visualization use the utility directly:

```tsx
const view = loading(() => use(user).name, { initial: () => <Spinner/> })
<Show when={view.pending}>{() => <TopBar.Indicator/>}</Show>
<div>{view}</div>
```

## 6. `useLoading()` hook

### Signature

```ts
export function useLoading(): Accessor<boolean>
```

### Semantics

Walks the current owner's `parent` chain looking for the nearest non-null
`loadingScope`. Returns that accessor. If none found, returns a constant
`() => false` accessor.

Useful for components inside the loaded slot of a Loading boundary that
want to react to the boundary's pending state without prop drilling:

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
      <Header/>                       {/* reads outer Loading's pending */}
      <UserView user={use(user)}/>
    </>
  )}
</Loading>
```

When `user` is reloaded, Loading goes into hold-prior mode (no fallback).
Header stays mounted with live effects (loadedOwner survives). Header's
`useLoading()` accessor flips to `true`, the Show toggles on, the
indicator appears.

### Implementation

```ts
const CONST_FALSE_ACCESSOR: Accessor<boolean> = () => false

export function useLoading(): Accessor<boolean> {
  let owner = getOwner()
  while (owner !== null) {
    if (owner.loadingScope !== null) return owner.loadingScope
    owner = owner.parent
  }
  return CONST_FALSE_ACCESSOR
}
```

Walk starts at the current owner and includes it. Header runs inside
`loadedOwner` (a child of `boundaryOwner`); the walk goes
`loadedOwner` → `boundaryOwner` (loadingScope found) → returns. If
called from a context with no enclosing Loading, the walk reaches a
root and returns the constant-false accessor.

## 7. Owner extension

In `src/owner.ts`, add to the `Owner` interface:

```ts
export interface Owner {
  // ... existing fields ...
  /** Optional pending-state accessor attached by `loading()`. `useLoading()`
   *  walks up the parent chain to find the nearest non-null entry. */
  loadingScope: Accessor<boolean> | null
}
```

Update `newOwner()` to initialize `loadingScope: null`. No other changes
to disposal/cleanup logic needed — `loadingScope` is just an accessor
reference, garbage-collected with the owner.

Update `createSubOwner` to accept an optional `loadingScope` argument, or
provide an internal helper `attachLoadingScope(owner, accessor)` that
loading() calls after creating its boundaryOwner. Either works; pick whichever
keeps callsites minimal.

## 8. Coordination across multiple `use()`s

```tsx
<Loading initial={<Spinner/>} fallback={<Indicator/>}>
  {() => {
    const u = use(user)
    const p = use(posts)
    return <>{u.name}: {p.length} posts</>
  }}
</Loading>
```

`use()` calls are **sequential** — the second only attempts after the
first resolves. Under-the-hood **promises** can be in flight in parallel
if the user kicked them off in parallel (e.g. `const user = signal(fetchUser());
const posts = signal(fetchPosts())` — both fetches start immediately,
their promises live in the signals, `use()` just observes settlement).

Reveal is coordinated: until both `use()`s succeed, the loaded slot
doesn't mount. Initial/fallback shows the whole time. No piecemeal
updates.

## 9. Nesting

Inner Loading catches first; outer never sees the inner's
`NotReadyYet`. Same as catchError nesting.

```tsx
<Loading initial={<PageSpinner/>}>
  {() => (
    <>
      <UserHeader user={use(user)}/>
      <Loading fallback={<PostsSkeleton/>}>
        {() => <PostsList posts={use(posts)}/>}
      </Loading>
    </>
  )}
</Loading>
```

Initial render: outer pending (user not ready) → PageSpinner.

User settles: outer renders loaded slot. UserHeader mounts. Inner
Loading evaluates — posts pending → inner renders PostsSkeleton.
useLoading() inside UserHeader returns `false` (outer not pending);
inside PostsList (if mounted) would return `true` (inner pending).

Posts settle: inner renders loaded slot. All settled. Both
useLoading() accessors return `false`.

Re-fetch posts: inner enters subsequent pending. Inner has fallback →
swaps to PostsSkeleton. Inner's loadingScope flips to `true`. Outer's
loadingScope stays `false`. `useLoading()` inside the inner's loaded
subtree (now unmounted) doesn't matter; inside the outer's loaded
subtree (UserHeader) still sees outer = false.

## 10. Errors

Non-`NotReadyYet` throws in `loaded()`:
- Re-thrown from the loading accessor.
- The binding-effect that owns the accessor catches via the existing
  `routeError` chain (Plan 2d), routing to the nearest `catchError`
  ancestor.
- `loading()` does NOT pretend to handle real errors. It's strictly a
  pending/loaded coordinator.

Throws in `fallback()` or `initial()`:
- Same routing — re-thrown from the loading accessor on the next run.
- Slot rendering is just user code; nothing special.

## 11. Tests

`test/dom/loading.test.tsx`, ~12 tests:

- Synchronous loaded thunk → renders result directly; pending stays false.
- Pending `use()` first time → renders `initial`; pending true.
- Pending `use()` first time with no `initial` → renders `fallback`; pending true.
- Pending `use()` first time with neither → renders undefined.
- Settled → renders loaded result; pending false.
- Subsequent pending with `fallback` → renders fallback; pending true; prior loaded effects DISPOSED.
- Subsequent pending without `fallback` → **holds prior loaded DOM with live effects**; pending true.
- Loaded effects' cleanup fires on transition-to-fallback (when fallback provided).
- Loaded effects keep running during hold-prior (no fallback) — assertion via signal-driven re-render of held content.
- Coordinated reveal: two `use()`s both pending → both must settle before loaded mounts.
- `useLoading()` inside a nested component inside loaded slot reflects outer Loading's pending state.
- Real error in loaded() propagates through `catchError`.

## 12. Public API surface

Added to `src/index.ts`:

```ts
export { Loading, loading, useLoading } from './dom'
```

Added to `src/dom/index.ts`:

```ts
export { Loading, loading, useLoading } from './loading'
```

## 13. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Boundary shape | Per-binding utility + thin JSX wrapper | Mirrors `For`/`mapArray`; avoids tree-wide owner-walk and dry-run rendering; matches user's instinct |
| Argument shape | Positional `loaded`, options bag for slots | Caller picks which slots they care about; no positional ambiguity |
| JSX children | Function required | Static children can't be `use()`d; force the explicit thunk |
| Default with no slots | Render `undefined` (initial) / hold prior loaded (subsequent) | Initial has no prior to hold; subsequent does. Stale-while-revalidate falls out for free |
| Pending API | Accessor with `.pending` accessor property | Matches signal's callable+brand pattern; one value to pass around |
| `useLoading()` walk start | Current owner (walk up) | Symmetric to `routeError`; works whether called inside loaded subtree or boundary-rendering setup |
| Owner extension | Add `loadingScope: Accessor<boolean> \| null` | Same pattern as Plan 2d's `errorHandler` field |
| Hold-prior mechanism | Tentative + loadedOwner sub-owner pattern, sibling to slot-owner under boundary | Keeps loaded effects alive across transition without specific "freeze" mode; per-slot owner prevents fallback effect accumulation |
| Three states | Internal `hasEverLoaded` flag, no public state-machine API | Three-state semantics fall out without exposing a state enum |
| Coordination | `use()`-sequential, promises-parallel-if-in-flight | User controls parallelism by when they kick off promises |
| Transitions | Not built | Pulse's value-level pending info is already the entanglement substrate |

## 14. Relationship to master spec §11

§11 says: "v2 — re-introduce a Loading/`<Suspense>` boundary as an opt-in
*coarser* catch site for `NotReadyYet` (coordination), additive to the
per-node path."

This design matches:
- **Opt-in**: only triggers when user wraps with `<Loading>` or `loading()`.
- **Coarser catch site**: catches `NotReadyYet` thrown by any `use()`
  within the thunk; multiple uses coordinate.
- **Additive**: per-node stale-but-stable still works for bindings outside
  any Loading.

Extensions beyond §11:
- **Hold-prior-by-default** is a refinement of the §9 stale-but-stable
  semantic, applied at the boundary scope. §11 didn't specify a default;
  this design picks the friendliest one.
- **Pending exposure via `view.pending` + `useLoading()`** gives
  visualisation primitives the master spec didn't enumerate. They fall
  cleanly out of the design rather than being added as separate concepts.

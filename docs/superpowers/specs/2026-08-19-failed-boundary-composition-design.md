# Composable failure state: `useFailed()` and a boundary that does not have to swap its content

Today, `<Failed>` only has one way to show a failure: replace its entire subtree with `fallback(error, reset)`. This document adds a second way to read the same state — without unmounting anything — so an app can show error UI inline, next to a specific control, or as a CSS class toggle, while the rest of the content it wraps stays exactly where it is. `fallback` keeps working exactly as it does today; the new pieces are additive.

This document records the conclusions reached in a design discussion on 2026-08-19 and was written before implementation began.

## Motivation

`<Failed>`'s all-or-nothing fallback was already recorded as a known limitation (`docs/follow-ups.md`): a failed mutation on one row of a list currently has no way to show its error next to that row without tearing down every other row alongside it. The retryable-action-failure work earlier in this session (`docs/superpowers/specs/2026-08-18-retryable-failure-propagation-design.md`) built the registration side of this — an action finds and registers with the nearest `<Failed>` boundary automatically — but left the *display* side exactly as constrained as before: the only way to show that a boundary is failing is still to let it replace everything underneath it.

`<Loading>` already solves the equivalent problem for its own boundary, and the solution generalizes directly: `useLoading()` (`src/dom/loading.ts`) lets any descendant read the nearest `<Loading>` boundary's pending state as a plain reactive accessor, with no swap involved — `<Loading>` itself still swaps for its own `fallback`/`initial`, but nothing stops an app from also reading `useLoading()` somewhere else entirely, for a spinner icon next to one button rather than the whole page. `<Failed>` gets the same treatment here: a `useFailed()` hook as the primitive, plus a little JSX sugar built on top of it.

## Part 1 — `useFailed()`: a boundary that does not have to swap anything

### The shape

```ts
export interface FailedState {
  /** True while the nearest boundary's collection is non-empty. */
  readonly active: Accessor<boolean>
  /** The first failed report's error, or null. Same value `fallback` receives
   *  as its first argument when `<Failed>` swaps for it. */
  readonly error: Accessor<unknown>
  /** Retry every failed report the boundary is currently holding — the exact
   *  same operation `<Failed>`'s own `reset` performs; `useFailed()` exposes
   *  it under the name `retry` for symmetry with `ActionHandle.retry()`. */
  retry(): void
}

export function useFailed(): FailedState {
  const scope = findBoundaryScope(getOwner(), 'failed')!  // never null — Part 2
  return { active: scope.active, error: scope.error, retry: scope.reset }
}
```

Mirrors `useLoading()` exactly: called once, at construction time, from wherever a descendant wants to read boundary state; walks the owner tree via the same `findBoundaryScope` mechanism `<Failed>` already registers into.

`FailedScope` (`src/owner.ts`) gains an `error: Accessor<unknown>` field alongside its existing `active`. Today that value only exists inside `<Failed>`'s own local `collection` signal, read directly by its render function — `useFailed()` needs it exposed on the interface itself.

### `<Failed>` itself: `fallback` becomes fully optional, nothing else changes

```ts
export interface FailedProps {
  children: () => unknown
  /** Optional. When provided, behaves exactly as it does today: replace the
   *  whole subtree with fallback(error, reset) while the boundary is active.
   *  When omitted, `<Failed>` is pure scoping — children stay mounted always,
   *  and `useFailed()` (or the sugar below) is how a descendant shows the
   *  failure. */
  fallback?: (error: unknown, reset: () => void) => unknown
}
```

The render function becomes:

```ts
return () => {
  if (props.fallback === undefined) return subtree
  const { active, error } = collection()
  return active ? props.fallback(error, reset) : subtree
}
```

Every existing `<Failed fallback={...}>` call site — `test/dom/failed.test.tsx`'s 14 tests, `examples/todo-async`'s boundary — needs zero changes. The registration machinery (`boundaryOwner`, `failedSet`, `register()`/`unregister()`, `reset()`) is untouched; only the render function's unconditional-return branch is new.

### Composing a full-subtree swap without `fallback`

An app that wants the swap behavior but built from the composable pieces (e.g. because it also wants an inline indicator elsewhere too) can reach for `<Show>`'s function-child form for the healthy side, which gets correctly-scoped disposal (`Show`'s existing convention — see `src/dom/show.ts`):

```tsx
<Failed>
  {() => (
    <Show when={() => !useFailed().active()}>
      {() => <RealContent/>}
    </Show>
  )}
</Failed>
```

`Show`'s `fallback` prop is a plain, eagerly-constructed `Child` today — not a function — so it does not get the same scoped disposal `Show`'s children do; this is a pre-existing `Show` limitation, not something this design changes. `Failed.Error` (below) is the piece that fills that gap correctly, so a swap that needs *both* sides properly scoped combines the two rather than relying on `Show`'s `fallback`. For a full swap where both sides need correct disposal and neither needs to coexist with anything else, `<Failed fallback={...}>` — unchanged, still fully supported — remains the simplest option; it's precisely what it's for.

### Compound sugar: `Failed.Error`

Built directly on `useFailed()`, nothing more:

```tsx
Failed.Error = (props: { children: (error: unknown, retry: () => void) => unknown }) => {
  const { active, error, retry } = useFailed()
  // Needs its own sub-owner, disposed on each active/inactive transition —
  // the same pattern Show uses internally (src/dom/show.ts) — so that
  // whatever the render prop constructs (its own effects, its own owner-
  // sensitive registrations) is torn down cleanly when the failure clears,
  // not merely removed from the DOM while still alive underneath.
  let owner: Owner | null = null
  let lastActive: boolean | null = null
  let cached: unknown
  return () => {
    const isActive = active()
    if (isActive === lastActive) return cached
    if (owner !== null) disposeOwner(owner)
    owner = createSubOwner(getOwner())
    cached = isActive
      ? untrack(() => runWithOwner(owner!, () => props.children(error(), retry)))
      : null
    lastActive = isActive
    return cached
  }
}
```

Branch-cached on the `active` transition, deliberately, the same way `Show`'s own children are — not re-invoked on every change to `collection()` the way `<Failed>`'s own `fallback` is today. This is a real difference from `fallback`'s current behavior, chosen because caching is what makes correctly-scoped disposal possible in the first place: something has to own the decision of when to tear down and rebuild, and "every active-transition" is the coarsest boundary that still guarantees cleanup. The consequence, matching `Show`'s own documented caveat for its children: if the boundary stays active but the underlying error changes (e.g. a second, different failure supersedes the first while the fallback is still showing), `Failed.Error`'s render prop is not re-invoked with the new error automatically — code that needs to reflect that has its own nested reactive read inside the render prop's body (e.g. call `useFailed()` again there for a live accessor), the same way `Show`'s own docs recommend for a value that changes without a truthy/falsy transition.

Used inline, anywhere inside a `<Failed>` (explicit or the implicit root — Part 2), with no unmounting of anything around it:

```tsx
<li>
  <input .../>
  <Failed.Error>{(error, retry) => <span class="row-error">{String(error)} <button on:click={retry}>retry</button></span>}</Failed.Error>
</li>
```

`Failed.isFailing` is not a separate mechanism — an app that wants a plain boolean for `class:` toggling reads `useFailed().active` directly (`class:failing={useFailed().active}`); no additional sugar is needed for that case, since it is already exactly what the hook returns.

`Failed.Error` is attached to the `Failed` function as a static property (`Failed.Error = ...`), which is ordinary JSX — `<Failed.Error>` compiles to a JSX member-expression tag, standard behavior under `react-jsx`, nothing pulse-specific needed to support it.

## Part 2 — every failure always has somewhere to register

### The problem this closes

Today, a failure with no `<Failed>` anywhere behaves in one of three ways depending on where it comes from: an `effect()`-driven computed/signal binding throws synchronously on its first run, or `console.error`s via `routeErrorFromRerun` on a re-run; a bare `action()` does neither — its failure just sits in `.error()`, invisible, unless the caller happens to read it directly. `useFailed()` needs a real `FailedScope` to read from in order to mean anything; `findBoundaryScope(getOwner(), 'failed')` returning `null` would make every call site handle that case separately, the way `useLoading()` does with its `CONST_FALSE_ACCESSOR` fallback. Rather than have `useFailed()` alone paper over "there is no state to show," this design gives every root a real one to point at.

### One rule, uniformly: `createRoot()` installs a default `FailedScope`

```ts
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner = newOwner()
  owner.boundaries.failed = createDefaultFailedScope()
  const dispose = () => disposeOwner(owner)
  return runWithOwner(owner, () => fn(dispose))
}
```

`findNearestFailedScope`/`findBoundaryScope(..., 'failed')` — the exact same owner-tree walk both `effect.ts` and `action()` already use to find a real, explicit `<Failed>` — now always finds *something* once it reaches the root, because the root owner itself carries a `FailedScope`. An explicit `<Failed>` anywhere between the failing binding and the root still wins, exactly as today (the walk returns the *nearest* match); a `catchError` anywhere in between still wins over any `<Failed>`, explicit or implicit, exactly as today (`findNearestFailedScope` returns `null` as soon as it hits a nearer `errorHandler`, before ever reaching the root).

This is a single, uniform rule rather than a special case carved out for `action()` alone. The two paths already share the same registration mechanism (`BindingController`/`FailedScope`) deliberately — `<Failed>`'s whole purpose is to be one place that catches a failure regardless of what specifically failed underneath it, and `action()` was built to register through that same mechanism rather than invent a second one. The only place `effect.ts` and `action()` differed was in what happens when nothing is found at all — an accident of `effect.ts`'s synchronous-throw fallback predating `<Failed>`'s existence, not a real difference between what a computed's failure and an action's failure *are*. Once every root always has somewhere real to register, that fallback stops being needed for either case.

**What this changes:** an `effect()`-driven computed/signal binding that fails with no explicit `<Failed>` anywhere in its tree no longer throws synchronously on its first run, and no longer merely logs on a re-run — both cases now register with the root `FailedScope` (see below for what that does) instead. **What this does not change:** the three existing tests that assert a synchronous first-run throw (`test/effect.test.ts:80-81`, `test/effect.test.ts:128-129`, `test/integration-error-boundary.test.ts:62-63`) all call `effect()` with no `createRoot()` at all — `getOwner()` returns `null` in every one of them, `findNearestFailedScope(null)` returns `null` regardless of this design (there is no owner to have installed a scope on), and `routeError`'s synchronous-throw fallback still applies exactly as it does today. This design's root scope is tied specifically to the owner `createRoot()` constructs; the genuinely rootless case — no `createRoot()` anywhere — is untouched, and no existing test needs to change.

### The root scope always logs; an explicit `<Failed>` never does

The default `FailedScope` installed by `createRoot()` calls `console.error(report.error)` unconditionally on every report it receives, regardless of whether anything is reading `useFailed()` from it — matching `routeErrorFromRerun`'s existing "always log, regardless of who's watching" behavior, so a failure with no explicit `<Failed>` anywhere stays exactly as visible as it is today, just also queryable through `useFailed()` rather than only visible in the console. An explicit, app-provided `<Failed>` never logs automatically, matching its behavior today — the app is assumed to be handling it, via `fallback` or `useFailed()`.

### Where the shared collection logic lives (implementation note)

`<Failed>`'s current collection bookkeeping (`failedSet`, the `collection` signal, `recompute`, `register`/`unregister`, `reset`) is built on pulse's own `signal()` wrapper (`src/signal.ts`). `src/owner.ts` cannot import `signal.ts` at runtime — `signal.ts` imports from `src/scope.ts`, which already imports from `src/owner.ts` (for `findNearestFailedScope`/`getOwner`/`onCleanup`, added by the retryable-action-failure work), so the reverse import would cycle. `src/scope.ts`'s own `makeErrorCell()` hit exactly this problem and solved it by building its reactive cell directly on r3's raw `signal`/`read`/`setSignal` instead of pulse's wrapper; `createDefaultFailedScope()` needs the same treatment, built on raw r3 primitives inside `src/owner.ts` (which already imports `getContext`/`onCleanup` from `'r3'`, so this is consistent with its existing style). Whether `<Failed>`'s own implementation gets refactored to share this same helper (removing its bespoke duplicate) or keeps its current pulse-`signal()`-based version is left to the implementation plan — functionally equivalent either way, and not required for this design to work.

## Explicitly out of scope

- `<Loading>` getting the equivalent compound-sugar treatment (`Loading.Pending`, or similar) — `useLoading()` already exists as the read-based primitive; only the sugar layer is new territory here, and only for `<Failed>`. Worth revisiting for symmetry later, not built by this design.
- Changing `<Failed>`'s `reset`/retry semantics for the `fallback`-swap path — unchanged.
- `resetFailure`'s existing gap (does not cross a `use()`-linked separate `computed()` call) — untouched, pre-existing, separately tracked in `docs/follow-ups.md`.

## Resolved during review

- **`fallback` stays, fully optional, rather than being replaced.** The first design considered removing `fallback` entirely in favor of always-composed `<Show>`-based swapping, which would have required rewriting `test/dom/failed.test.tsx`'s 14 tests and `examples/todo-async`'s boundary for no functional gain over just making the prop optional. Keeping it makes this purely additive.
- **Hook is the primitive; `Failed.Error` is sugar built on it, not a second, independent mechanism.** Matches the one existing precedent in this codebase (`useLoading()`) — `useFailed()` is what everything reads from, and the compound component is a small convenience wrapper around it, not an alternative API with its own registration logic.
- **The root-boundary fallback applies uniformly to `action()` and to `effect()`'s computed/signal failure path, not to `action()` alone.** The two already share the same registration mechanism deliberately; carving out an action-only fallback would preserve an asymmetry that exists only because `effect.ts`'s synchronous-throw path predates `<Failed>`, not because the two kinds of failure need different treatment. Confirmed the three tests this could have affected do not use `createRoot()` and are unaffected.
- **The root scope always `console.error`s its reports, unconditionally** — not only when nothing is reading `useFailed()` — matching `routeErrorFromRerun`'s existing behavior and keeping a failure exactly as visible by default as it is today.

# Pulse Transitions — Redesign

**Status:** Draft (supersedes `2026-05-16-pulse-transitions-design.md`)
**Date:** 2026-05-17
**Supersedes:** Plan 7 (brand-aware `read`)
**Related:** Plan 6 (SWR computed)

## Why a redesign

The 2026-05-16 spec solved coherent multi-read snapshots by making `read(x)` brand-aware: inside a generator computed, `yield* read(x)` would consult `accessor[PENDING]` and suspend on a pipeline-OR Promise walk. It worked, but the user feedback was that it leaned on too much implicit machinery:

- `[PENDING]` was a hidden symbol-brand on the accessor function object.
- `read` silently inspected it and inserted a Promise yield — the suspension was invisible at the call site.
- `.promise` auto-walked the dep graph to find upstream in-flight Promises — convenient, but you couldn't tell from a read site which upstream you were waiting on.
- "Transition" was an emergent property of writing a generator computed that yield-read pending things — there was no named boundary.
- `use(x)` and `yield* read(x)` had opposite suspension policies on the same accessor; the user picked behavior by keyword choice.

The redesign keeps the same goals (coherent snapshots, SWR-at-leaf, no per-refetch spinner flicker) but reorganizes them around three small, public, composable pieces — no symbol brands, no overloaded keywords, no implicit policy on existing APIs.

## Goals

- **Explicit primitives, user-organized composition.** Async-ness is a concern, exposed via public utilities (scheduler-style), not a property silently attached to accessors.
- **Transitions emerge from boundary placement in JSX**, not from a special primitive.
- **SWR-at-leaf preserved**, but located in the JSX rendering layer (per-hole cache), not in the reader.
- **Single, simple `use` semantics**: throws `NotReadyYet` on pending, returns value otherwise. No fork.

## Non-goals

- Solid/React-style concurrent rendering with parallel fiber trees.
- Time-budget commits ("show new after Nms even if not settled" — React's `useDeferredValue`).
- Explicit `startTransition` API — boundary placement is the entire opt-in surface.
- Swappable pending tracker. The exposed utilities have one built-in implementation; swap-ability can be added later if a real need surfaces.
- A new state primitive (`asyncSignal`, `transition(...)`, etc.).

## Design

Three concepts ship to the user. Everything else is implementation detail.

### 1. External pending tracker

Scheduler-style. Pending state is exposed via free functions, not as fields on the accessor.

```ts
isPending<T>(x: Accessor<T>): () => boolean
promiseOf<T>(x: Accessor<T>): () => Promise<T> | null
```

Both return **reactive accessors** — reading them inside a `computed` / effect tracks, and they re-fire when underlying pending state flips.

Built-in implementation does a **pipeline-OR walk** over the r3 dep graph: `isPending(x)()` is true if `x` is in-flight OR any upstream is. `promiseOf(x)()` returns the deepest in-flight Promise found by the walk, or `null`.

The `[PENDING]` symbol brand on accessor functions is removed. The async stage in `src/computed.ts` still stashes its in-flight Promise, but writes it to an internal registry (`WeakMap<Accessor, PendingState>`) instead of stamping the accessor. `isPending` / `promiseOf` are pure consumers of that registry plus the r3 graph.

### 2. `use` — single behavior

```ts
function use<T>(x: Accessor<T>): T {
  if (isPending(x)()) throw new NotReadyYet(promiseOf(x)()!)
  return x()
}

// Promise overload unchanged:
function use<T>(p: Promise<T>): T   // throws NotReadyYet(p)
```

No SWR-vs-throw decision baked into `use`. Always throws on pending; otherwise returns the value. Stale-on-screen is now the JSX hole's job (§3), not `use`'s.

The brand-aware `read` is reverted: `read` becomes a plain yield helper again, with no `[PENDING]` consultation.

### 3. JSX holes cache + re-throw

Every reactive JSX hole (a `() => T` binding) gains caching and a `NotReadyYet` catch:

```
hole render cycle:
  try:
    next = expression()              // may call use(x), which may throw
    cache = next
    commit(next)
  catch e:
    if e is NotReadyYet(promise):
      keep showing cache (or nothing on first render)
      report promise to nearest <Loading> ancestor,
        or self-coordinate as implicit 1-hole boundary if none
      do NOT commit
    else:
      rethrow (real error → error boundary)
```

Hole identity is the binding site (same hole across re-renders has the same cache).

### 4. `<Loading>` — transition boundary

```tsx
<Loading fallback={F}>{children}</Loading>
```

State machine:

```
idle:
  pass through; holes commit individually.

collecting (one or more descendant holes pending):
  render: any cache exists in any descendant hole?
            yes → show prior committed tree (transitions semantics)
            no  → show F (first load)
  on every new NotReadyYet report: add Promise to pending set.
  Promise.all(pending set) → settled:
    schedule all contributing holes to re-execute in one r3 flush
    holes commit atomically (coherent snapshot)
    boundary returns to idle.

new throws while collecting (e.g. user clicks "next" again mid-transition):
  added to pending set; Promise.all extends.
  latest values win on commit (driven by holes' reactive expressions).
```

**Implicit per-hole boundary.** A hole with no enclosing `<Loading>` self-coordinates: gathers its own thrown Promise, keeps showing cache (or nothing on first load), re-executes when settled. There's no uncaught `NotReadyYet` case.

`fallback` is only ever rendered on first load (when no descendant hole has a cache yet). Subsequent transitions retain the prior tree.

## How the original problem dissolves

Recall the pokemon demo:

```tsx
const list = computed(() => fetchList(page()))

<Loading fallback={<Spinner/>}>
  <span>page {() => use(page) + 1}</span>
  <For each={() => use(list)}>…</For>
</Loading>
```

User clicks "next":

1. `page` updates to 2 synchronously.
2. `list` body re-runs, returns a new Promise; SWR stashes the new in-flight; pending registry records list's promise.
3. r3 marks the two holes dirty.
4. Hole 1 (`use(page) + 1`): `page` isn't pending → commits "page 2"? **No** — `<Loading>` is collecting (see step 5), so hole 1 also re-throws or its commit is deferred under the boundary's pending state. (See implementation note below.)
5. Hole 2 (`use(list)`): `list` is pending → throws `NotReadyYet(promise)`. Hole catches, keeps showing cached items, reports promise to `<Loading>`.
6. `<Loading>` is now collecting. Prior committed tree is on screen ("page 1", old items). Both holes are queued.
7. `list` settles. `<Loading>`'s `Promise.all` resolves. Both holes re-execute in one r3 flush. Hole 1 commits "page 2"; hole 2 commits new items. Coherent.

**Implementation note on step 4:** for atomic commit, holes must not commit while their enclosing `<Loading>` is in `collecting` state. Two mechanisms can achieve this; pick during planning:

- **(M1) Boundary intercepts commit.** When `<Loading>` is collecting, descendant holes still execute but their commit calls are queued at the boundary and flushed together when `Promise.all` settles.
- **(M2) Holes consult boundary state.** A hole about to commit checks `boundary.state === 'collecting'`; if yes, defers via the boundary's queue.

Either way, the user-visible behavior is identical: all holes commit in the same flush.

## What goes away

- `accessor[PENDING]` symbol brand and its `.promise()` method.
- Pipeline-OR baked into the accessor (`accessor[PENDING].promise()` walking upstream). Pipeline-OR moves to the external tracker.
- Brand-aware `read` (reverts to plain yield helper, as it was before Plan 7).
- The `use` vs `yield* read` split on the same accessor.
- The "transition via generator computed + `yield* read(...)`" pattern. Generator computeds remain useful for sequential async composition; they no longer carry transition semantics.

## What's new

- `isPending(x)` / `promiseOf(x)` as public utilities (`src/pending.ts` or similar — exact location during planning).
- Per-hole cache + `NotReadyYet` catch in the JSX runtime binding effect.
- `<Loading>` as a transition boundary with `collecting` state machine and atomic-commit coordination.
- Implicit 1-hole boundary fallback for holes with no `<Loading>` ancestor.

## What stays the same

- `signal` / `computed` signatures unchanged. No new constructors.
- SWR behavior of async computeds (Plan 6) — `list()` still returns the prior resolved value during refetch.
- Existing `use(promise)` semantics.
- r3 unmodified; pending registry + JSX hole machinery live entirely in pulse.

## Behavior table

| state | `view()` (sync computed downstream of pending `list`) | `isPending(view)()` | hole rendering `use(view)` inside `<Loading>` | hole rendering `use(view)` with no `<Loading>` ancestor |
|---|---|---|---|---|
| first load, all pending | the in-flight Promise (or undefined cache miss depending on body) | true | boundary renders `fallback` | hole renders nothing (implicit 1-hole boundary, no cache, no fallback) |
| all settled | `{ page, items }` | false | committed | committed |
| refetch in progress | `{ page, items }` (prior, via SWR) | true | boundary holds prior tree until `Promise.all` settles, then atomic flip | hole holds cached value until promise settles, then re-executes |
| refetch settled | `{ page, items }` (new) | false | atomic commit | committed |

## Tests

- `isPending(x)` is reactive — re-fires when pending state flips. Same for `promiseOf(x)`.
- Pipeline-OR: `isPending(downstream)()` is true when an upstream computed is in-flight.
- `use(accessor)` throws `NotReadyYet` carrying the correct in-flight Promise; throws nothing when accessor is settled.
- JSX hole catches `NotReadyYet`, retains cached DOM, reports promise upward.
- `<Loading>` shows `fallback` on first load; holds prior tree on subsequent refetches.
- Coherent commit: two holes inside one `<Loading>`, one always-settled and one pending — both commit in the same flush after `Promise.all`.
- Implicit per-hole boundary: a `use(pending)` hole with no `<Loading>` ancestor doesn't throw uncaught; renders nothing on first load, cached value on refetch.
- Mid-transition new throw (user clicks again) extends `Promise.all` rather than committing the first batch.
- Pokemon demo Playwright: page label and items move together across page changes; no mid-flight `{ page: 2, items: oldItems }` frame.

## Risks & open questions

- **Hole identity in dynamic children.** `<For>` / `<Show>` may create/destroy holes across renders. The cache is keyed on binding site; holes destroyed-and-recreated lose their cache. Plan should verify this matches user expectation (probably yes: a hole that wasn't on screen has nothing to be "stale" from).
- **Commit-deferral mechanism (M1 vs M2).** Pick during planning; affects which file owns the queue.
- **Nested `<Loading>`.** Spec says "innermost catches." Verify this matches the user's intuition during planning; consider documenting explicitly with an example.
- **Error boundaries vs `<Loading>`.** A real error thrown from a hole expression should bypass `<Loading>` and reach the nearest error boundary. The hole's catch must filter on `NotReadyYet` and rethrow otherwise — already specified in §3, but worth a dedicated test.
- **`isPending` in render holes.** Reading `isPending(view)` inside a binding is allowed and reactive; it does not trigger the `NotReadyYet` throw path because it's a plain boolean read. Useful for styling ("currently transitioning") inside a `<Loading>` subtree.

## Migration

- Remove `accessor[PENDING]` brand and its `.promise()`. Update `src/computed.ts` to write pending state to the internal registry instead.
- Revert `read` to plain yield helper.
- Add `src/pending.ts` (or co-locate in `async.ts`) with `isPending` / `promiseOf` + internal registry.
- Extend JSX binding-effect in `src/jsx-runtime.ts` (or `src/dom/`) with the try/catch + cache + boundary-report.
- Add `<Loading>` (likely in `src/dom/loading.ts` or wherever existing control-flow components live) with collecting state machine, `Promise.all` gather, atomic flush coordination.
- Pokemon demo: simplify — no generator computeds for the view, just `<Loading>` around the label + list.

## Out of scope

- JSX-generator bindings (`<For each={function*(){...}}>`) — useful ergonomic, separate scope.
- `await*`-style JSX compile-time sugar.
- Swappable `setPendingTracker`. Add only if a real need surfaces.
- `isPendingLocal` / `promiseOfLocal` (non-walking variants). Add if/when a real call site wants them.

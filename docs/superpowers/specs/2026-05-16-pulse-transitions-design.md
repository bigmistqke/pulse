# Pulse Transitions Design

**Status:** Draft
**Date:** 2026-05-16
**Related:** Plan 6 (SWR computed), Plan 2a (effect suspension)

## Problem

After Plan 6, async computeds publish stale values during refetch (stale-while-revalidate). This is good UX for data display — no spinner flicker — but it breaks **coherent multi-read snapshots**.

Concrete case: the pokemon demo has a "Page N" label and a paginated list. After clicking "next":

- `page()` returns `2` immediately (eager)
- `list()` returns prior items (SWR)
- Reading both produces `{ page: 2, items: oldItems }` — *inconsistent*

What the user actually wants is a **transition**: the label, the items, and the loading indicator commit atomically when the new page's data arrives. Before that, the entire view is in a "transitioning" state — visually marked (greyed) but textually unchanged.

## Non-goals

- Solid/React-style concurrent rendering with parallel fiber trees
- Automatic discovery of "which downstream computeds are pending" via reactive graph walks
- A new state primitive (signal-lag, transition-tuple, etc.) — we don't add `transition(...)` as a top-level API
- Changing SWR-as-default for direct `list()` reads

## Design

Make `computed(() => body)` handle `NotReadyYet` thrown from its body the same way it handles a body that returns a pending Promise: suspend with SWR, register a resume callback, hold the prior published value.

Make `use(accessor)` consult the accessor's `[PENDING]` brand. If the accessor is mid-refetch (value is a stale SWR view), `use` throws `NotReadyYet` carrying the in-flight Promise.

Together, this lets any computed become a coherent snapshot of multiple reads:

```ts
const view = computed(() => ({
  page: page(),
  items: use(list),   // suspends the computed if list is mid-refetch
}));
```

`view`'s value commits only when none of its `use(...)` reads are pending. Coherent snapshot. No new primitive.

## Mechanism

### 1. `[PENDING]` brand carries the resume Promise

Today:

```ts
accessor[PENDING] = pendingSig   // Accessor<boolean>
```

After:

```ts
accessor[PENDING] = pendingSig           // still Accessor<boolean>
accessor[PENDING].promise = () => suspendedOn  // attached property
```

`.promise()` returns the current in-flight Promise the stage is suspended on, or `null` if not pending. This is the only handle to the in-flight Promise that survives SWR (which hides the Promise behind the prior value at the publish site).

Brand stays a function (the existing `Accessor<boolean>` shape) — `isPending` callers don't change. Only `use` and the upstream-pipeline pending OR need the `.promise` attachment.

### 2. `use(accessor)` consults the brand

```ts
function use(x) {
  if (typeof x === 'function') {
    const brand = (x as any)[PENDING];
    if (brand?.() && brand.promise()) {
      throw new NotReadyYet(brand.promise());
    }
    x = x();
  }
  if (isPromise(x)) return /* existing track-and-throw-or-return */;
  return x;
}
```

The brand check comes *before* the accessor call so a refetching computed throws even though its accessor would synchronously return a stale value.

### 3. `computed(() => body)` catches `NotReadyYet` from the body

In `makeStageNode`, wrap the `runStage` call in a try/catch. If the body throws `NotReadyYet(p)`:

- Same path as `outcome.pending` with `p` as the in-flight Promise
- `suspendedOn = p`, `setPendingSig(true)`
- Publish nothing new (SWR — prior value stays)
- Register `p.then(rerun)`; on settle, re-run the body

Already-baked machinery: the existing `suspendedOn` / `setPendingSig` / `.then(rerun)` paths handle it.

### 4. Pipeline-OR for upstream pending

The current pipeline-aware `[PENDING]` (`pendingSig() || upstreamPending()`) keeps working. Its `.promise` getter returns: own `suspendedOn` first; falling back to `upstreamAccessor[PENDING]?.promise?.()`. Walks the chain to find the actual in-flight Promise.

## Behavior table

| state | `view()` | `isPending(view)` | view's `[PENDING].promise()` |
|---|---|---|---|
| first load, all pending | the in-flight Promise (one of the inputs) | true | that Promise |
| all settled | `{ page, items }` snapshot | false | `null` |
| refetch in progress | prior `{ page, items }` (SWR) | true | the in-flight Promise from `list` |
| refetch settled | new `{ page, items }` | false | `null` |

## Pokemon demo migration

Drop the page-rides-on-data hack:

```ts
// before
const list = computed(
  () => fetchList(page()),
  (r) => ({ page: page(), items: r.items }),
);
<span>page {() => list().page + 1}</span>
<For each={() => list().items}>…

// after
const list = computed(() => fetchList(page()), r => r.items);
const view = computed(() => ({ page: page(), items: use(list) }));
<span class:loading={() => isPending(view)}>page {() => view().page + 1}</span>
<For each={() => view().items}>…
```

`view()` always returns a coherent snapshot. Page number and items move together. `isPending(view)` drives the visual loading cue.

## Out of scope

- Multiple gate accessors in a single transition (use(a) + use(b) already covers this — view suspends on the first pending one, re-runs on settle, checks the next)
- Explicit `startTransition` / scheduling APIs
- Time-budget-based "stay in transition for at most N ms then commit anyway" (React useDeferredValue)
- Replacing the "use inside computed is a code smell" warning with a positive recommendation — keep the JSDoc nuanced; this is a deliberate pattern, not the default

## Risks

- **Breaking change for existing "use inside computed" code:** today this throws and the computed becomes throw-on-read. After this change, those computeds will suspend instead. Existing tests for the code-smell behavior need rewriting. Likely no real users rely on the throw-on-read behavior since it's been documented as a smell.
- **`use(accessor)` semantics shift:** previously `use(accessor)` called the accessor and treated the returned value. Now it consults a brand first. Accessors without `[PENDING]` (plain signals) are unaffected. Computeds always have `[PENDING]` so they get the new behavior unconditionally.
- **Diamond pending bubbling:** if computed A reads computed B which reads list, A's brand `.promise()` should resolve up the chain. The upstream-OR pattern already added in `de2c37a` handles `pending()`; need to extend it to `.promise()` symmetrically.

## Test coverage targets

- `use(pendingComputed)` throws `NotReadyYet` carrying the in-flight Promise
- `computed(() => use(pendingComputed))` suspends with SWR, publishes prior, re-runs on settle
- Coherent snapshot: setSource changes mid-fetch; downstream snapshot stays old; commits atomically on settle
- `isPending(view)` true throughout transition window
- Pipeline-OR `.promise()` walks upstream when the directly-read stage isn't itself suspended
- Pokemon demo Playwright still passes; refreshing indicator behavior unchanged

## Open questions

None at design time — all decisions captured above. Promote during plan-writing if any surface.

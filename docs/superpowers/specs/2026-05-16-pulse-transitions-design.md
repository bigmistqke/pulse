# Pulse Transitions Design

**Status:** Draft (revised after implementation discovered SWR-at-leaf conflict)
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

## Design (revised)

Original sketch made `use(accessor)` consult `[PENDING]` and throw `NotReadyYet`. Implementation discovered this breaks SWR-at-the-leaf: a JSX binding like `<For each={() => use(list)}>` would re-throw on every refetch, re-tripping the `<Loading>` boundary, defeating SWR's whole point.

The two contexts want opposite behavior:

- **JSX/effect leaf:** SWR is the point. `use(list)` should return the stale items, not suspend.
- **Inside a snapshot computed:** must suspend on pending, otherwise the snapshot is incoherent.

Pulse already has a yield-based suspension primitive for the second case: `read(x)`. We extend it (rather than overloading `use`).

### `read` becomes brand-aware

`read(accessor)` already yields the accessor's return value; the driver suspends if the value is a Promise. We add: if the accessor has a `[PENDING]` brand and it's true, first `yield brand.promise()` so the driver suspends on the in-flight Promise; on resume, re-call the accessor for the fresh value.

```ts
export function* read<T>(x: T): Generator<unknown, Resolved<T>, unknown> {
  if (isSignalAccessor(x)) {
    const brand = (x as Signal<unknown>)[PENDING];
    if (brand?.()) yield brand.promise!();   // suspend on gate
    const value = (x as () => unknown)();    // post-resume value
    return (yield value) as Resolved<T>;
  }
  return (yield x) as Resolved<T>;
}
```

### Transition pattern uses generator computed

```ts
const view = computed(function* () {
  return {
    page: yield* read(page),
    items: yield* read(list),   // brand-aware suspension
  };
});
```

`view` publishes a coherent snapshot atomically when its reads settle. `isPending(view)` is true throughout via the pipeline-OR brand (already shipped in Task 1).

### Clean split

| reader | mechanism | use case | SWR behavior |
|---|---|---|---|
| `use(x)` | throw NotReadyYet | effects, JSX bindings | stale-at-leaf preserved |
| `yield* read(x)` | yield + driver suspend | inside generator computeds | coherent snapshots |

## Mechanism

### 1. `[PENDING]` brand carries the resume Promise (kept from original)

Done. `accessor[PENDING]` is a function + `.promise` getter that returns the current in-flight Promise (own or upstream) or `null`. Pipeline-OR walks the chain.

### 2. `read(accessor)` brand-aware suspension

Extend `src/async.ts:read` to check the brand before yielding the accessor's value, as shown above. Driver handles the yielded Promise via existing `runStage` / WeakMap fast-forward.

### 3. `use` unchanged

`use(promise)` and `use(accessor)` keep their existing semantics. `use(accessor)` calls the accessor and treats the returned value as-is. No brand-check at this level — preserves SWR-at-leaf for JSX bindings.

## Behavior table

| state | `view()` | `isPending(view)` | view's `[PENDING].promise()` |
|---|---|---|---|
| first load, all pending | the in-flight Promise (one of the inputs) | true | that Promise |
| all settled | `{ page, items }` snapshot | false | `null` |
| refetch in progress | prior `{ page, items }` (SWR) | true | the in-flight Promise from `list` |
| refetch settled | new `{ page, items }` | false | `null` |

## Pokemon demo migration

```ts
const list = computed(() => fetchList(page()), r => r.items);

const view = computed(function* () {
  return {
    page: yield* read(page),
    items: yield* read(list),
  };
});

<span class:loading={() => isPending(view)}>page {() => view().page + 1}</span>
<For each={() => view().items}>…
```

`view()` always returns a coherent snapshot. Page number and items move together. `isPending(view)` drives the visual loading cue. SWR-at-leaf preserved for any binding that still reads `use(list)` directly.

## Out of scope

- Multiple gate accessors in a single transition (yield* read(a) + yield* read(b) covers this — generator suspends on the first pending one, re-runs on settle, advances)
- Explicit `startTransition` / scheduling APIs
- Time-budget-based "stay in transition for at most N ms then commit anyway" (React useDeferredValue)
- JSX-generator bindings (`<For each={function*(){...}}>`) — useful ergonomic follow-up, separate scope
- `await*`-style JSX compile-time sugar — requires a pulse JSX compiler, much larger conversation

## Risks

- **`read` brand-check is a behavior change:** previously `yield* read(computed)` returned the computed's accessor value (stale during SWR). Now it suspends on pending gates. The change is opt-in to generator contexts only — `use(accessor)`, plain `list()` reads, etc. are unaffected. Generators are the documented home of `read`, so this is a tight, expected change.
- **Diamond pending bubbling:** Task 1 already handles `.promise()` walking upstream via the pipeline-OR pattern.

## Test coverage targets

- `yield* read(pendingComputed)` suspends the generator, resumes with the resolved value on settle
- Coherent snapshot: setSource changes mid-fetch; downstream generator-computed snapshot stays old; commits atomically on settle
- `isPending(view)` true throughout transition window
- Pipeline-OR `.promise()` walks upstream when the directly-read stage isn't itself suspended (already covered by Task 1)
- `use(list)` at a JSX leaf still returns the stale value during refetch (SWR-at-leaf invariant)
- Pokemon demo Playwright still passes; refreshing indicator behavior unchanged; new coherent-snapshot Playwright assertion

## Open questions

None at design time — all decisions captured above. Promote during plan-writing if any surface.

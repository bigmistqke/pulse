# pulse async toolkit — design spec (Plan 5)

**Status:** design complete.
**Date:** 2026-05-16.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), [master design spec §10](2026-05-14-pulse-design.md), [ADR 0007 (Async coordination)](../../adr/0007-async-coordination-data-as-signals.md), [Plan 4 spec](2026-05-16-pulse-loading-design.md).

---

## 1. Motivation and scope

Plan 4 ships `<Loading>` + `useLoading()` — the *observation* side of
async coordination. This plan ships the *mutation orchestration* side
without going transitions-first ([ADR 0007](../../adr/0007-async-coordination-data-as-signals.md)).

Three small composable helpers, each ~10–20 LOC. None require new
runtime machinery; all compose with existing primitives (signal,
effect, Loading, isPending, latest).

**In scope:**

- `action(fn)` — wraps an async mutation, tracks pending state, returns `{ run, pending }`.
- `optimistic(setter, applyFn, action)` — apply local update, await action, revert on failure.
- `resolve(fn)` — imperative `await` of a reactive expression's first settled value.

**Deferred / out of scope:**

- Transitions runtime. Rejected per ADR 0007.
- Tag-based invalidation primitives (TanStack Query-style). Application code
  models data in signals; tags become unnecessary when mutations update the
  canonical signal directly. Add as a follow-up if multi-signal
  invalidation lists grow noisy in real apps.
- A `query()` primitive that wraps signal+fetcher. Redundant with bare
  signal-holding-promise. Application code calls `setItems(fetchItems())`
  directly; no constructor needed.
- Optimistic stores (Solid 2.x's `createOptimisticStore`). Needs a `store`
  primitive first; pulse has none in v1.
- Group cancellation across an action's spawned work. If real cases emerge,
  could be added later; not in v1 surface.

## 2. The data-as-signals pattern (foundational)

This plan presupposes the pattern documented in ADR 0007: application
state lives in signals; mutations update signals; pulse's reactive graph
handles transitive invalidation. Without this pattern the helpers are
less useful. The plan's documentation should foreground this — these
helpers are sugar on a discipline, not magic.

Canonical shape:

```ts
// State lives in a signal
const [items, setItems] = signal<Item[] | Promise<Item[]>>(fetchItems())

// Derived data is computed from the signal
const count = computed(() => items().length)
const completed = computed(() => items().filter(i => i.done))

// Mutations update the signal — pulse propagates
async function addItem(item: Item) {
  const created = await api.create(item)
  setItems(curr => [...curr, created])
}
```

The three helpers improve the **mutation body** specifically, leaving
the data layer pattern unchanged.

## 3. Architecture

```
src/
  async/                          — new directory (or stay in src/)
    action.ts                     — action()
    optimistic.ts                 — optimistic()
    resolve.ts                    — resolve()
  index.ts                        — re-export action, optimistic, resolve
test/
  async/
    action.test.ts
    optimistic.test.ts
    resolve.test.ts
```

(Naming: putting them under `src/async/` keeps the existing `src/async.ts`
file — which is the core async primitives like `use`, `read`,
`NotReadyYet`, `isPending`, `latest` — unmixed with these helpers.
Alternative: append to existing `src/async.ts`. Both work; pick during
implementation.)

## 4. `action(fn)`

### Signature

```ts
export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R>
  pending: Accessor<boolean>
}

export function action<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): Action<A, R>
```

### Semantics

- Returns an object with `run` (the wrapped mutation) and `pending` (a
  boolean accessor reflecting "is the action currently running?").
- `run(...args)` calls `fn(...args)`, awaits the result, returns it.
- During the call, `pending()` returns `true`. After settlement (success
  or failure), `pending()` returns `false`.
- Failures are re-thrown — `pending` resets correctly via try/finally.
- Multiple concurrent calls to the same `action` would set/unset `pending`
  in overlapping ways. The contract is "pending is true while *any* call
  is in flight" — implemented via a counter.

### Implementation

```ts
export function action<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): Action<A, R> {
  const [count, setCount] = signal(0)
  const pending: Accessor<boolean> = () => count() > 0
  return {
    pending,
    run: async (...args: A) => {
      setCount(c => c + 1)
      try {
        return await fn(...args)
      } finally {
        setCount(c => c - 1)
      }
    },
  }
}
```

### Usage

```ts
const [items, setItems] = signal<Item[]>([])

const addItem = action(async (item: Item) => {
  const created = await api.create(item)
  setItems(curr => [...curr, created])
})

// In JSX:
<button on:click={() => addItem.run({ name: 'Foo' })} prop:disabled={addItem.pending}>
  Add
</button>
<Show when={addItem.pending}>{() => <Spinner/>}</Show>
```

The mutation body updates `items` directly — pulse propagates to
`count`, `completed`, and any binding reading `items` automatically.

### Why this is enough

It looks too small to be worth a primitive. But it captures three
common patterns in one helper:
1. Pending state tracking that survives early returns and exceptions
   (try/finally).
2. Reactive pending (a signal-based accessor that consumers can `<Show
   when={pending}>`).
3. Concurrent calls aggregating correctly (count, not boolean).

Application code doing this by hand is ~5 lines per mutation. The
helper makes it one line.

## 5. `optimistic(setter, applyFn, action)`

### Signature

```ts
export function optimistic<T, R>(
  setter: Setter<T>,
  applyFn: (current: T) => T,
  action: () => Promise<R>,
): Promise<R>
```

### Semantics

- Snapshots the current setter target's value before applying.
- Calls `setter(applyFn)` — applies the optimistic update.
- Awaits `action()`.
- On success: returns the action's result. The optimistic value remains
  (caller is responsible for any reconciliation if the server result
  differs — typically a subsequent `setter(serverResult)` in the action
  body).
- On failure: reverts `setter` to the pre-apply value, re-throws.

### Implementation

```ts
export async function optimistic<T, R>(
  setter: Setter<T>,
  applyFn: (current: T) => T,
  action: () => Promise<R>,
): Promise<R> {
  let snapshot: T
  setter(curr => {
    snapshot = curr
    return applyFn(curr)
  })
  try {
    return await action()
  } catch (e) {
    setter(snapshot!)
    throw e
  }
}
```

### Usage

```ts
const [items, setItems] = signal<Item[]>([])

async function deleteItem(id: string) {
  await optimistic(
    setItems,
    items => items.filter(i => i.id !== id),    // optimistic: remove locally
    () => api.delete(id),                        // action: confirm with server
  )
}
```

If the API call fails, `items` reverts to its pre-delete state.

### Composing with `action`

```ts
const deleteItem = action(async (id: string) => {
  await optimistic(
    setItems,
    items => items.filter(i => i.id !== id),
    () => api.delete(id),
  )
})
```

Pending state from `action`, revert-on-failure from `optimistic`,
data updates via `setItems`. Three primitives composed.

### Limitations and explicit non-features

- **Concurrent optimistic updates on the same setter** can race: two
  rapid calls would each snapshot, apply, and on failure revert to
  their respective snapshots — potentially clobbering each other. This
  is the explicit-pattern equivalent of why frameworks build optimistic
  *stores* (per-key snapshots). For v1, document the limitation: "one
  optimistic call per setter at a time, or use a store-like
  application structure."
- **No automatic reconciliation with server result.** If the server
  returns the canonical item, the action body should call
  `setter(curr => ...)` to swap optimistic for actual. Pattern, not
  primitive.

## 6. `resolve(fn)`

### Signature

```ts
export function resolve<T>(fn: () => T | Promise<T>): Promise<T>
```

### Semantics

- Returns a Promise that resolves with the first non-pending value
  produced by `fn()`.
- Runs `fn` in a temporary owner scope; tracks deps; if `fn()` returns
  a Promise, awaits it; if `fn()` reads a signal whose value is a
  Promise, awaits via the reactive graph (re-running `fn` when deps
  settle until non-Promise value is produced).
- Disposes the temporary scope after resolution.
- Useful inside event handlers / actions where imperative await is
  natural and the reactive graph can't directly be awaited.

### Implementation sketch

```ts
export function resolve<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    const dispose = createRoot((d) => {
      effect(() => {
        try {
          const value = fn()
          if (isPromise(value)) {
            value.then(
              (v) => { res(v); d() },
              (err) => { rej(err); d() },
            )
          } else {
            res(value as T)
            d()
          }
        } catch (e) {
          if (e instanceof NotReadyYet) {
            // effect will re-run on settle via Plan 2a NotReadyYet handling
            return
          }
          rej(e)
          d()
        }
      })
      return d
    })
  })
}
```

### Usage

```ts
// Inside an action body:
const addItem = action(async (item: Item) => {
  const created = await api.create(item)
  setItems(curr => [...curr, created])
  // Wait for the items query to be fully resolved before returning:
  await resolve(() => items())   // waits for items to settle
  return created
})

// In an event handler:
async function handleSubmit() {
  await api.save()
  const user = await resolve(() => currentUser())
  navigate(`/users/${user.id}`)
}
```

### When it's useful

- **Bridging reactive to imperative.** Event handlers, route guards,
  setup code that needs an await-able handle.
- **Sequencing reactive work.** "Do A, wait for it to settle, then do
  B" without depending on B's reactive read tracking A.
- **Testing.** Tests can `await resolve(() => computed())` to wait for
  async pipelines to settle.

### When it's *not* useful

- Reading reactive values inside a reactive context (use the value
  directly + let the binding-effect handle suspension).
- Avoiding `<Loading>` — `resolve` is not a replacement for boundary
  observation; it's a one-shot Promise.

## 7. Public API surface

Added to `src/index.ts`:

```ts
export { action, type Action } from './async/action'
export { optimistic } from './async/optimistic'
export { resolve } from './async/resolve'
```

(Or appended to `src/async.ts` if we keep all async helpers in one
file; pick during implementation.)

## 8. Tests

`test/async/action.test.ts` (~5 tests):
- `pending` starts false; flips true during call; flips false on success.
- `pending` flips false on failure; original error re-thrown.
- Concurrent calls aggregate `pending` (two in flight → still pending until both complete).
- `run` returns the awaited result.
- Action body's `setSignal` propagates through reactive graph (integration with signal).

`test/async/optimistic.test.ts` (~5 tests):
- Optimistic update visible immediately; reverts on action failure.
- Action result returned on success.
- Snapshot captured correctly when `applyFn` is non-trivial (uses current value).
- Composes with `action`'s pending tracking.
- Document: known concurrent-call limitation (no test asserting it, just JSDoc note).

`test/async/resolve.test.ts` (~5 tests):
- Resolves a Promise-returning thunk.
- Resolves a reactive read whose value becomes non-pending.
- Re-runs through `NotReadyYet` suspension via Plan 2a integration.
- Rejects on real error.
- Disposes its scope after resolution (no leak — check via owner integration).

## 9. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Transitions runtime | Not built | ADR 0007 — data-as-signals + reactive graph covers the same outcomes |
| Query / resource primitive | Not built | Signal-holding-promise IS the resource; constructor would be redundant |
| Tag-based invalidation | Not built | Reactive graph IS the dependency graph when data lives in signals |
| Action handle shape | `{ run, pending }` object | Simple, composable, allows `pending` to be passed independently |
| Optimistic concurrent calls | Document limitation; no per-call snapshot store | YAGNI for v1; store-shaped solution if/when needed |
| `resolve` reactive integration | Use effect + NotReadyYet handling | Reuses Plan 2a's machinery; no new mechanism |
| File layout | `src/async/{action,optimistic,resolve}.ts` separate files | Each is small but a different concern; one per file aids tree-shaking & navigation |
| Group cancellation | Not built | No clear v1 use case; can be added later |

## 10. Relationship to master spec §10 and ADR 0007

Master §10 sketched a `transition()` value with `pending`, `settled`,
`abort`. ADR 0007 supersedes that sketch — the same outcomes are
decomposed across `<Loading>` (boundary), `action` (mutation
orchestration), `optimistic` (local-apply pattern), and per-binding
kick-guards (already in Plan 2b for supersession of specific in-flight
work). No bundled `transition` primitive.

This plan implements the mutation-orchestration third of that
decomposition.

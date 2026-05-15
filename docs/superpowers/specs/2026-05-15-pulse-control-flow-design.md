# pulse control-flow components — design spec (Plan 3b)

**Status:** design complete.
**Date:** 2026-05-15.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), [master design spec §9](2026-05-14-pulse-design.md), [Plan 3a spec](2026-05-15-pulse-dom-rendering-core-design.md), `docs/adr/0001`–`0006`.

---

## 1. Motivation and scope

Plan 3a shipped the DOM rendering primitives (`render`, `h`, JSX runtime,
prop bindings). Plan 3b adds the two control-flow components master spec §9
names — **`Show`** and **`For`** — built on the per-run sub-owner pattern
proved in Plan 3a's Task 5 fix.

**In scope:**

- `Show` component — conditional rendering with type-narrowed function child
- `For` component — keyed list rendering (reference-keyed, v1)
- `mapArray` internal utility — the reactive list-with-identity-preserving-
  disposal engine that `For` is a thin wrapper around

**Deferred (separate plans):**

- `Switch` / `Match` — explicitly dropped. A function child plus if/else
  covers every case ergonomically, and pulse's "function = reactive" rule
  makes `{() => cond() ? <A/> : <B/>}` idiomatic. Not worth a primitive.
- `Index` — Solid's stable-slot variant of `For`. Pulse v1 ships reference-
  keyed only; a future plan may add `keyed={false}` as an opt-out matching
  Solid 2.x's unified shape.
- `Portal` — separate plan (3c?)
- SVG / namespaced elements (`createElementNS`) — separate plan
- Two-phase keying (reference → resolved field with reconcile-on-collision)
  — v2 `<Suspense>` concern
- Diff-insert optimization for `For`'s output — see §6 perf note

## 2. Architecture

Three files:

```
src/dom/
  show.ts        — Show component (~50 LOC)
  for.ts         — For component (~30 LOC, thin wrapper over mapArray)
  map-array.ts   — internal mapArray utility (~80 LOC)
  index.ts       — adds: export { Show, For }
src/index.ts     — adds: export { Show, For } from './dom'
test/dom/
  show.test.tsx
  for.test.tsx
  map-array.test.ts  — DOM-free tests of the reconciliation engine
```

`mapArray` is **internal** — not exported from the public barrel. The
factoring is for testability (reconciliation is pure data flow, no DOM)
and for the future option of publicizing it if a user-facing need
emerges (e.g. reactive per-item derived values outside a list).

## 3. `Show`

### API

```tsx
<Show when={cond} fallback={<Spinner/>}>
  {u => <UserView user={u}/>}    // function child: narrowed truthy value
</Show>

<Show when={loaded}>
  <StaticContent/>                // static child: just render when truthy
</Show>
```

**Props:**

- `when: T | (() => T)` — the condition. May be `null | undefined | false |
  0 | ''` (rendered as fallback) or any truthy value (rendered as children).
  May also be a `Promise<T>` — promises coerce to falsy under spec §5's
  pending-is-falsy rule, so a pending `when` shows the fallback.
- `fallback?: Node | Node[]` — content shown when `when` is falsy.
  Conflates "no content" with "still pending" by design.
- `children: Node | Node[] | ((value: Truthy<T>) => Node | Node[])` —
  if a function, called once per **truthy transition** with the narrowed
  value.

`Truthy<T>` is `Exclude<T, false | null | undefined | 0 | ''>`. Pulse
defines this type alias once in `src/dom/show.ts`.

### Semantics

- **Re-evaluates** when `when`'s accessor's deps change (function form) or
  the parent re-runs (static form).
- **Branch caching:** the rendered subtree for each branch (truthy / falsy)
  is kept across same-branch re-evaluations. Going truthy → truthy with a
  *different* truthy value does **not** re-render — the children function
  is not called again, the existing subtree stays. Reactivity inside the
  subtree (signal reads) handles fine-grained updates.
- **Branch transition** (truthy ↔ falsy) disposes the old branch's
  sub-owner (cascading `onCleanup`s, removing event listeners, tearing down
  effects) and mounts the new branch under a fresh sub-owner.
- **Per-branch sub-owner:** each active branch runs under
  `createSubOwner(getOwner())` set as ambient via `runWithOwner` while the
  branch's content is constructed. The sub-owner is registered with the
  parent owner so a parent dispose cascades to the active branch
  automatically.
- **Total and pure:** `Show` itself never throws, never suspends — children
  may, but that's the user's reactive code, caught by binding-effects and
  `catchError` boundaries the same way as anywhere else.

### Implementation shape

```ts
function Show<T>(props: ShowProps<T>): () => Node | Node[] | undefined {
  const parentOwner = getOwner()
  let lastBranch: 'truthy' | 'falsy' | null = null
  let cachedNode: Node | Node[] | undefined
  let branchOwner: Owner | null = null

  return () => {
    const raw = typeof props.when === 'function' ? (props.when as () => T)() : props.when
    const isTruthy = !!raw && !isPromise(raw)
    const branch = isTruthy ? 'truthy' : 'falsy'

    if (branch === lastBranch) return cachedNode

    if (branchOwner !== null) disposeOwner(branchOwner)
    branchOwner = createSubOwner(parentOwner)
    cachedNode = runWithOwner(branchOwner, () => {
      if (isTruthy) {
        return typeof props.children === 'function'
          ? props.children(raw as Truthy<T>)
          : props.children
      }
      return props.fallback
    })
    lastBranch = branch
    return cachedNode
  }
}
```

Returned as a function so the parent's `insertChild` treats it reactively
(Plan 3a's "function = reactive" rule).

## 4. `mapArray` — the list reconciliation engine

### API (internal)

```ts
function mapArray<T, U>(
  list: T[] | Promise<T[]> | (() => T[] | Promise<T[]>),
  mapFn: (item: T, index: () => number) => U,
): () => U[]
```

Returns a derived accessor of the mapped output. The mapper is called
once per **new** item (matched by reference). Existing items keep their
mapped output across re-runs of `list`; only orphans are disposed.

### Semantics

- **Keying:** strict reference identity. If `list` previously contained
  `userA` and now contains `userA` again, the entry is reused — same
  mapped output, same sub-owner, same `index` signal (updated if its
  position changed). If `list` now contains a fresh `{ ...userA }` (new
  reference), that's a new entry; the old `userA`'s entry is disposed.
- **Pending list:** if `list()` returns a `Promise<T[]>`, the mapped
  output is `[]` until the promise resolves (per spec §5 pending-as-
  empty for lists). Reads track normally.
- **Per-item sub-owner:** each entry's mapper runs under
  `createSubOwner(parentOwner)` set as ambient via `runWithOwner`. Effects
  and computeds created inside the mapper parent to the entry's sub-owner.
  Removing an item from the list disposes the entry's sub-owner (cascading
  `onCleanup`s, event listeners, nested effects).
- **`index` is a signal,** not a fixed number. When an item moves from
  position 3 to position 5, `setSignal(entry.indexSig, 5)` runs; any
  `index()` reads in the mapper's body update.
- **Duplicate references in `list`** are undefined behaviour and
  documented as such. A `Map<T, Entry>` cannot distinguish two slots with
  the same reference. (Solid behaves the same way.)
- **Disposal cascade:** if the parent owner is disposed, every entry's
  sub-owner is disposed via `createSubOwner`'s parent-registration.

### Implementation shape

```ts
type Entry<T, U> = { item: T; mapped: U; indexSig: WritableSignal<number>; owner: Owner }

function mapArray<T, U>(...): () => U[] {
  const parentOwner = getOwner()
  let entries = new Map<T, Entry<T, U>>()

  return () => {
    // 1. Unwrap list to a concrete array (pending → [])
    const raw = typeof list === 'function' ? list() : list
    const arr: T[] = isPromise(raw) || !Array.isArray(raw) ? [] : raw

    // 2. Build the next map by reusing matched entries, creating new ones
    const next = new Map<T, Entry<T, U>>()
    const output: U[] = []
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      let entry = entries.get(item)
      if (entry !== undefined) {
        if (entry.indexSig() !== i) setSignal(entry.indexSig, i)
      } else {
        const owner = createSubOwner(parentOwner)
        const indexSig = signal(i)
        const mapped = runWithOwner(owner, () => mapFn(item, () => indexSig()))
        entry = { item, mapped, indexSig, owner }
      }
      next.set(item, entry)
      output.push(entry.mapped)
    }

    // 3. Dispose orphans (entries not in `next`)
    for (const [item, entry] of entries) {
      if (!next.has(item)) disposeOwner(entry.owner)
    }
    entries = next
    return output
  }
}
```

`indexSig` is a pulse `signal(number)`; `mapFn` receives `() => indexSig()`
as the index argument so the mapper body can read it reactively.

## 5. `For`

### API

```tsx
<For each={users} fallback={<Empty/>}>
  {(user, index) => <li>{index} — {user.name}</li>}
</For>
```

**Props:**

- `each: T[] | Promise<T[]> | (() => T[] | Promise<T[]>)` — pending coerces
  to `[]`.
- `fallback?: Node | Node[]` — shown when mapped output is empty
  (covers pending-as-empty transparently).
- `children: (item: T, index: () => number) => Node | Node[]` — the row
  renderer.

### Implementation shape

```ts
function For<T>(props: ForProps<T>): () => Node | Node[] | undefined {
  const mapped = mapArray<T, Node | Node[]>(props.each, props.children)
  return () => {
    const flat = mapped().flat()
    return flat.length === 0 ? props.fallback : flat
  }
}
```

That's it. All the reactive list logic lives in `mapArray`. `For` adds:
the fallback handoff and the `.flat()` to collapse row-arrays into a
single child sequence.

The return value is a function — the parent's `insertChild` (Plan 3a)
treats it reactively. The mapped Nodes returned each run preserve
references for unchanged rows; `insertChild`'s clear-and-reinsert cycle
detaches and reattaches them rather than recreating. See §6 for the
known perf note.

## 6. Performance — known v1 cost

Each time `each`'s deps change, the outer reactive binding-effect:

1. Calls the For-accessor → mapArray runs reconciliation → returns Node[]
2. `insertChild` builds a fragment, clears the markers, re-inserts

Step 2 detaches and reattaches **all rows**, including ones whose position
didn't change. The DOM ops are cheap (no recreation, same refs) but
trigger layout twice per change. For a 1000-row list, that's noticeable.

**Why we ship it anyway:**

- Functional correctness is fine — rows persist, their effects don't re-run.
- Optimization is a clean follow-up: add a diff-insert path in
  `insertChild` for function-children that return `Node[]`, comparing the
  new array against the previous and using `insertBefore` only where order
  changes. ~30 LOC, doesn't change any public API.

This is tracked as a follow-up in `docs/follow-ups.md` rather than blocking
Plan 3b.

## 7. Testing

### `mapArray` (no DOM)

In `test/dom/map-array.test.ts`. Tests the reconciliation engine purely
as a data transform — feed arrays in, observe mapped output and per-item
disposal.

Cases:
- Initial run: produces one mapped value per item, in order
- Adding items: existing entries reused; new entries created
- Removing items: removed entries' sub-owners disposed
- Reordering same items: same mapped values returned; `index` signals updated
- Same-reference re-add: entry preserved across calls
- Different-reference same-shape: entries treated as different (no
  structural sharing)
- Pending `Promise<T[]>`: mapped output is empty
- Parent owner disposed: all entry sub-owners dispose (via cascade)
- Mapper creates an `effect`: disposed when its item leaves

### `Show` (DOM)

In `test/dom/show.test.tsx`. ~7 tests:
- Truthy `when` mounts function child with narrowed value
- Falsy `when` mounts fallback
- Pending `Promise<T>` `when` → fallback (coerced to falsy)
- Truthy → truthy with different value: subtree unchanged, children function not re-called
- Truthy → falsy: sub-owner disposed (e.g. `onCleanup` in children fires)
- Falsy → truthy: fresh sub-owner, fresh children invocation
- Disposing the surrounding owner disposes the active branch's sub-owner

### `For` (DOM)

In `test/dom/for.test.tsx`. ~6 tests covering the DOM-side concerns
that `mapArray` doesn't already pin:
- Empty array → fallback rendered
- Non-empty → rows in document order
- Adding rows mounts new DOM at the right position
- Removing rows removes their DOM and fires per-row `onCleanup`
- Reorder: same DOM nodes, repositioned via `insertBefore`
- Pending `Promise<T[]>` → fallback rendered

## 8. Public API surface

Added to `src/index.ts`:

```ts
export { Show, For } from './dom'
```

Added to `src/dom/index.ts`:

```ts
export { Show } from './show'
export { For } from './for'
```

`mapArray` stays unexported from `./dom` (internal-only). Promoting it
later is non-breaking.

## 9. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Scope | Show + For only | YAGNI on Switch (function child + if/else covers it); Index/Portal/SVG defer to later plans |
| `Show` children shape | Function or static; function receives narrowed value | Type-narrowing is the win over a bare ternary |
| `Show` re-render policy | Cache per-branch subtree; only swap on truthy↔falsy transition | Avoids tearing down children when value changes within the same branch; matches Solid |
| `For` keying | Reference identity only (v1) | Pulse's async-items story requires it; index-keyed mode deferred until needed |
| `For` index | Accessor (`() => number`) | Reorders preserve row identity; mapper body can react to position changes |
| `For` factoring | `mapArray` internal utility + thin `For` wrapper | Reconciliation testable in isolation, no DOM in those tests; future option to publicize |
| Per-branch / per-row owners | `createSubOwner(parentOwner)` set ambient via `runWithOwner` | Reuses Plan 3a Task 5's proven pattern; no new owner machinery |
| Perf | Full re-insert on each change; diff-insert deferred | Correct behaviour for v1; optimization is non-blocking follow-up |

## 10. Relationship to master spec §9

Master §9 names `Show`, `Switch`, `For` as control-flow components.
This plan ships `Show` and `For`; **drops `Switch`** explicitly on YAGNI
grounds (function-child + if/else is the idiomatic substitute). All
semantic requirements from §9 hold:

- Total and pure — never throw, never suspend internally ✓
- Pending coerced (`Show` falsy, `For` empty) ✓
- Local `fallback` prop covering empty + pending ✓
- `For` reference-keyed (v1); two-phase keying deferred ✓

No semantic divergence from §9. The only API simplification is the
`Switch` drop, which §9 itself doesn't require (it lists `Switch` as a
control-flow primitive but the §9 semantics — total coercion, fallback,
no suspension — apply to `Show`/`For` only).

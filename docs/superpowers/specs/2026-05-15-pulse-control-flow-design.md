# pulse control-flow components — design spec (Plan 3b)

**Status:** design complete.
**Date:** 2026-05-15.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), [master design spec §9](2026-05-14-pulse-design.md), [Plan 3a spec](2026-05-15-pulse-dom-rendering-core-design.md), `docs/adr/0001`–`0006`.

---

## 1. Motivation and scope

Plan 3a shipped the DOM rendering primitives (`render`, `h`, JSX runtime,
prop bindings). Plan 3b adds the control-flow components master spec §9
names — **`Show`**, **`Switch`/`Match`**, **`For`** — built on the per-run
sub-owner pattern proved in Plan 3a's Task 5 fix.

**In scope:**

- `Show` component — conditional rendering with type-narrowed function child
- `Switch` + `Match` components — multi-branch conditional rendering
- `For` component — keyed list rendering (reference-keyed, v1)
- `mapArray` internal utility — the reactive list-with-identity-preserving-
  disposal engine that `For` is a thin wrapper around

**Deferred (separate plans):**

- `Index` — Solid's stable-slot variant of `For`. Pulse v1 ships reference-
  keyed only; a future plan may add `keyed={false}` as an opt-out matching
  Solid 2.x's unified shape.
- `Portal` — separate plan (3c?)
- SVG / namespaced elements (`createElementNS`) — separate plan
- Two-phase keying (reference → resolved field with reconcile-on-collision)
  — v2 `<Suspense>` concern
- Diff-insert optimization for `For`'s output — see §6 perf note

## 2. Architecture

Four files:

```
src/dom/
  show.ts        — Show component (~50 LOC)
  switch.ts      — Switch + Match components (~60 LOC)
  for.ts         — For component (~30 LOC, thin wrapper over mapArray)
  map-array.ts   — internal mapArray utility (~80 LOC)
  index.ts       — adds: export { Show, Switch, Match, For }
src/index.ts     — adds: export { Show, Switch, Match, For } from './dom'
test/dom/
  show.test.tsx
  switch.test.tsx
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

## 4. `Switch` + `Match`

### API

```tsx
<Switch fallback={<Spinner/>}>
  <Match when={isError()}>
    <ErrorView/>
  </Match>
  <Match when={user()}>
    {u => <UserView user={u}/>}
  </Match>
</Switch>
```

The first `Match` whose `when` is truthy wins; if none match, `fallback`
renders.

**`Match<T>` props:**

- `when: T | (() => T)` — same shape as `Show`'s `when` (falsy/pending →
  this Match is skipped).
- `children: Node | Node[] | ((value: Truthy<T>) => Node | Node[])` —
  function form gives the narrowed value.

**`Switch` props:**

- `fallback?: Node | Node[]` — used when no `Match` is truthy.
- `children` — one or more `Match` elements (or non-Match children, which
  are silently ignored).

### Semantics

- **`Match` is a data marker, not a renderer.** It returns its props
  tagged with an internal symbol so `Switch` can detect it. Stray
  non-Match JSX children inside `<Switch>` are skipped.
- **First-truthy wins.** `Switch` evaluates each `Match`'s `when` in
  document order, picks the first truthy, renders that Match's children.
- **Branch caching:** same-winner across re-runs preserves the rendered
  subtree (matches `Show`'s rule). The winning Match is identified by
  the Match-data object's identity, not by index — so reordering Matches
  inside Switch still re-uses subtrees if the same Match object wins.
- **Per-branch sub-owner:** each active branch (one Match or fallback)
  runs under `createSubOwner(parentOwner)`. Winner change disposes the
  old branch, mounts the new under a fresh sub-owner.
- **Total and pure:** like Show, never throws, never suspends.

### Implementation shape

```ts
const MATCH = Symbol('Match')
type MatchData<T> = { [MATCH]: true; when: T | (() => T); children: ... }

function Match<T>(props): MatchData<T> {
  return { [MATCH]: true, ...props }
}

function Switch(props): () => Node | Node[] | undefined {
  const parentOwner = getOwner()
  let lastKey: MatchData<unknown> | 'fallback' | null = null
  let cachedNode: Node | Node[] | undefined
  let branchOwner: Owner | null = null

  return () => {
    const items = Array.isArray(props.children) ? props.children : [props.children]
    let winner: MatchData<unknown> | null = null
    let winnerValue: unknown = undefined
    for (const item of items) {
      if (!item || (item as MatchData<unknown>)[MATCH] !== true) continue
      const m = item as MatchData<unknown>
      const raw = typeof m.when === 'function' ? (m.when as () => unknown)() : m.when
      if (raw && !isPromise(raw)) { winner = m; winnerValue = raw; break }
    }

    const key = winner ?? 'fallback'
    if (key === lastKey) return cachedNode

    if (branchOwner !== null) disposeOwner(branchOwner)
    branchOwner = createSubOwner(parentOwner)
    cachedNode = runWithOwner(branchOwner, () => {
      if (winner === null) return props.fallback
      return typeof winner.children === 'function'
        ? winner.children(winnerValue)
        : winner.children
    })
    lastKey = key
    return cachedNode
  }
}
```

`Match`'s return type is **not** `Node | Node[]` — it's the tagged data
object. `Switch`'s `children` prop is typed as `MatchData | MatchData[]`,
not the generic `Node` children. This breaks the `Component<P> =
(props: P) => Node | Node[]` contract for `Match` specifically. The
pragmatic resolution: type `Match` with its own signature
`Match<T>(props): MatchData<T>` (not via `Component`), and rely on
`Switch`'s typed `children` prop to flag misuse at the call site.

## 5. `mapArray` — the list reconciliation engine

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

## 6. `For`

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
detaches and reattaches them rather than recreating. See §7 for the
known perf note.

## 7. Performance — known v1 cost

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

## 8. Testing

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

### `Switch` + `Match` (DOM)

In `test/dom/switch.test.tsx`. ~6 tests:
- First truthy Match wins; later Matches skipped even if truthy
- No Match truthy → fallback rendered
- Non-Match children inside `<Switch>` ignored
- Winner changes → old branch sub-owner disposed (e.g. `onCleanup` fires), new mounted
- Same Match wins twice in a row → subtree preserved (children not re-called)
- Match's function child receives narrowed truthy value
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

## 9. Public API surface

Added to `src/index.ts`:

```ts
export { Show, Switch, Match, For } from './dom'
```

Added to `src/dom/index.ts`:

```ts
export { Show } from './show'
export { Switch, Match } from './switch'
export { For } from './for'
```

`mapArray` stays unexported from `./dom` (internal-only). Promoting it
later is non-breaking.

## 10. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Scope | Show, Switch/Match, For | All three control-flow primitives master spec §9 names; Index/Portal/SVG defer to later plans |
| `Show` children shape | Function or static; function receives narrowed value | Type-narrowing is the win over a bare ternary |
| `Show` re-render policy | Cache per-branch subtree; only swap on truthy↔falsy transition | Avoids tearing down children when value changes within the same branch; matches Solid |
| `Match` is data, not a renderer | Returns a tagged props object; `Switch` consumes it | The component contract `(props) => Node \| Node[]` can't express "marker"; the typed `Match<T>` signature replaces the generic `Component` contract |
| `Switch` re-render policy | Same as `Show` — branch keyed by winning Match's object identity; same-winner re-runs preserve subtree | Consistent semantics across single- and multi-branch conditionals |
| `For` keying | Reference identity only (v1) | Pulse's async-items story requires it; index-keyed mode deferred until needed |
| `For` index | Accessor (`() => number`) | Reorders preserve row identity; mapper body can react to position changes |
| `For` factoring | `mapArray` internal utility + thin `For` wrapper | Reconciliation testable in isolation, no DOM in those tests; future option to publicize |
| Per-branch / per-row owners | `createSubOwner(parentOwner)` set ambient via `runWithOwner` | Reuses Plan 3a Task 5's proven pattern; no new owner machinery |
| Perf | Full re-insert on each change; diff-insert deferred | Correct behaviour for v1; optimization is non-blocking follow-up |

## 11. Relationship to master spec §9

Master §9 names `Show`, `Switch`, `For` as control-flow components. This
plan ships all three. All semantic requirements from §9 hold:

- Total and pure — never throw, never suspend internally ✓
- Pending coerced (`Show`/`Switch` falsy → fallback; `For` empty → fallback) ✓
- Local `fallback` prop covering empty + pending ✓
- `For` reference-keyed (v1); two-phase keying deferred ✓

No semantic divergence from §9.

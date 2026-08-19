# Error-type-filtered boundaries

Today, `<Failed>` and `catchError` decide who catches a failure purely by *position*: the nearest one to the failing binding wins, unconditionally, regardless of what actually failed. This document adds a way for either to decline a specific failure — `for={(error) => …}` — so it propagates to the next ancestor instead of being claimed by the nearest one no matter what.

This document records the conclusions reached in a design discussion on 2026-08-19 and was written before implementation began.

## Motivation

Working through `examples/todo-async`'s error handling (`docs/superpowers/specs/2026-08-19-failed-boundary-composition-design.md`, and the diagram published to the user during this discussion) surfaced a real limitation: the demo wants the initial list load's failure to replace the whole page (nothing to show yet), but a single row's mutation failing to show a small inline message without hiding the list. One `<Failed>` boundary, catching everything beneath it regardless of what failed, can't do both.

Three attempts to solve this through boundary *placement* alone all failed, each for a different, already-verified reason:

1. **One boundary wrapping everything** can't distinguish a load failure from a mutation failure — it only knows *that* something failed, not *what*.
2. **Splitting the load read out of `<TodoList>`'s individual bindings** (so a separate, outer boundary could catch just it) breaks `<Loading>`'s atomic-commit guarantee — each binding that wants to participate in the atomic gate has to call `use()` itself; there's no way to hoist that opt-in to one shared, outer call without un-enrolling the bindings that need it.
3. **A boundary placed inside `<For>`'s per-row renderer** gets torn down by the row's own optimistic write: a reference-keyed `<For>` rebuilds a row when its object identity changes, taking any boundary nested inside it down before the request even settles — precisely the class of bug `docs/superpowers/specs/2026-08-18-retryable-failure-propagation-design.md`'s disposal-anchor fix exists to avoid. Reintroducing per-row boundaries reintroduces that bug.

Filtering sidesteps all three, because it decouples *which errors a boundary handles* from *where in the tree it sits*. Two differently-filtered boundaries can nest at the exact same physical location, wrapping the exact same content — nothing needs to move, nothing needs restructuring, and neither boundary needs to live inside a reference-keyed row.

## Part 1 — the `for` prop, on `<Failed>` and `catchError`

### Shape

```ts
export interface FailedProps<E = unknown> {
  children: () => unknown
  fallback?: (error: E, reset: () => void) => unknown
  /** Optional. When given, this boundary only claims an error if `for`
   *  returns true for it — anything else is treated as if this boundary
   *  did not exist, and the search continues to the next ancestor
   *  `<Failed>` (or `catchError`) instead. Omitted means "accepts
   *  everything", exactly today's behaviour.
   *
   *  Written as a type guard (`(value: unknown) => value is E`), `fallback`'s
   *  own `error` parameter is narrowed to E for that same `<Failed>` element.
   *  A plain boolean predicate still works when there's nothing to narrow to
   *  (filtering by message, by a custom `.code` property, etc.) — just
   *  without the narrowing. */
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
}

export function catchError<T>(
  fn: () => T,
  handler: (error: unknown) => void,
  options?: { for?: (error: unknown) => boolean },
): T | undefined
```

Both default to "accepts everything" when `for`/`options.for` is omitted — every existing `<Failed>` and every existing `catchError` call needs zero changes.

`catchError` does not get the type-guard/narrowing treatment `<Failed>`'s `for` does — its `handler` is a plain `(error: unknown) => void` today and stays that way; narrowing it is a separate, independent addition this document does not make.

### Why `catchError` gets this too, and why `action()` still never talks to it

`<Failed>` and `catchError` already share the same precedence rule — "peers in one walk, nearest wins" — because `<Failed>` is, conceptually, a reactive, UI-rendering flavour of the same idea `catchError` implements imperatively (`docs/adr/0006-error-boundaries-as-sub-owners.md`). Giving one filtering without the other would leave that peer relationship inconsistent — a `<Failed for={...}>` could decline and fall through, but a nearer `catchError` still couldn't, unconditionally blocking anything farther out regardless of what it actually wanted to handle.

They are not merged into one mechanism, though. `Owner` keeps its two existing fields — `boundaries.failed` (what `<Failed>` sets) and `errorHandler` (what `catchError` sets) — genuinely separate, for a real reason: `catchError`'s handler is a one-shot callback, invoked fresh each time `routeError` walks past it; `<Failed>`'s collection is stateful — each binding gets its own `BindingController` it reports to repeatedly (failed → idle → failed again) as it re-runs, aggregated across however many bindings are currently registered. Forcing one shape onto the other would either weaken `<Failed>`'s model or complicate `catchError`'s, for no benefit beyond a smaller `Owner` type. Instead, both gain their own independent filter, sharing one walk helper (Part 2) that knows how to check either kind.

`action()` is the one place this document deliberately does *not* extend to reach `catchError`, even though `effect.ts`'s failure path does. `action()` has never invoked a `catchError` handler — checked directly against this codebase's own usage (every `catchError` test and every `effect.ts` re-run failure; `action()` appears in none of them). When no `<Failed>` is found today, an action's failure simply sits in `.error()`, unclaimed by anything. Extending `action()` to reach `catchError` would be a new capability nothing has asked for or exercises; this document does not add it. `action()`'s candidate walk (Part 3) still stops, unconditionally, the moment it reaches a `catchError` — matching today's precedence exactly — it just never invokes it, exactly as today.

### Deferred: read-time filtering on `useFailed()`/`Failed.Error`

Raised and explicitly parked during design review, not built here: `useFailed(guard)`/`Failed.Error for={guard}`, narrowing what an *already-found* boundary's `error()` returns, the same type-guard convenience `<Failed>`'s own `for` gives `fallback`. Real and useful on its own, but it does not replace registration-time filtering — a boundary's collection only ever surfaces one current error (whichever report arrived first), so if two different kinds of failure are active on the same *unfiltered* boundary at once, a read-time guard can miss one of them entirely. Registration-time `for` (this document) does not have that problem, because two filtered boundaries keep two separate collections. See "What was cut, and why it can come back later" below.

## Part 2 — the shared walk

`findNearestFailedScope` (used by `effect.ts`'s two failure branches) becomes filter-aware directly, since both of its call sites already know the error — they're inside their own `catch` block by the time they call it:

```ts
export function findNearestFailedScope(
  start: Owner | null,
  error: unknown,
): { owner: Owner; scope: FailedScope } | null {
  let owner = start
  while (owner !== null) {
    const scope = owner.boundaries.failed
    if (scope !== null && (scope.for === undefined || scope.for(error))) {
      return { owner, scope }
    }
    const handler = owner.errorHandler
    if (handler !== null && (handler.for === undefined || handler.for(error))) {
      return null // a nearer, accepting catchError still wins, exactly as today
    }
    owner = owner.parent
  }
  return null
}
```

`FailedScope` gains the field this reads:

```ts
export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
  readonly error: Accessor<unknown>
  /** Set from <Failed>'s own `for` prop. Undefined means "accepts everything". */
  readonly for?: (error: unknown) => boolean
  reset(): void
}
```

`Owner.errorHandler` changes shape to carry the same thing for `catchError`:

```ts
export interface ErrorHandlerEntry {
  handle(error: unknown): void
  for?: (error: unknown) => boolean
}

export interface Owner {
  ...
  readonly errorHandler: ErrorHandlerEntry | null
  ...
}
```

`routeError` calls `handler.handle(error)` instead of `handler(error)`; `catchError` constructs an `ErrorHandlerEntry` from its own `handler`/`options.for` arguments instead of passing the bare handler straight through to `createSubOwner`. Every read of `owner.errorHandler` lives inside `src/owner.ts` itself, plus `catchError`'s own call site — a contained change.

## Part 3 — `action()`: collect candidates at call time, pick one at failure time

### Why this can't just add the same one-line filter check `effect.ts` gets

`action()` resolves its boundary *eagerly*, at the moment it's called — deliberately, so it can find the calling row's boundary while the row still exists, before an optimistic write inside the action body recycles it (`docs/superpowers/specs/2026-08-18-retryable-failure-propagation-design.md`). Filtering needs the error itself to decide which boundary wins, and the error doesn't exist until the attempt later settles. Naively moving the walk to failure time would mean walking from whatever owner is ambient *then* — which, for an async callback, is generally nothing meaningful, and even if captured in advance, doing the *entire* discovery (including the disposal-guard registration that anchors correctly to the boundary's own owner) that late reopens exactly the timing hazard the pivot to auto-discovery was built to close.

### The fix: split "find every candidate" from "pick the winner"

`action()` still walks exactly once, at call time — but instead of resolving to one boundary, it collects *every* `<Failed>` between the calling owner and the nearest `catchError` (or the root), and sets up each one's disposal guard immediately, while everything is still guaranteed alive — exactly the same timing guarantee `action()` already has today, just applied to a list instead of a single scope:

```ts
interface FailedCandidate {
  readonly owner: Owner
  readonly scope: FailedScope
  disposed: boolean
}

function collectFailedCandidates(start: Owner | null): FailedCandidate[] {
  const candidates: FailedCandidate[] = []
  let owner = start
  while (owner !== null) {
    if (owner.boundaries.failed !== null) {
      candidates.push({ owner, scope: owner.boundaries.failed, disposed: false })
    }
    // action() never reaches past a catchError, and never invokes it —
    // matches today's behaviour exactly (Part 1).
    if (owner.errorHandler !== null) break
    owner = owner.parent
  }
  return candidates
}
```

```ts
const candidates = collectFailedCandidates(getOwner())
let claimedCandidate: FailedCandidate | null = null

for (const candidate of candidates) {
  runWithOwner(candidate.owner, () => {
    onCleanup(() => {
      candidate.disposed = true
      if (claimedCandidate === candidate) {
        disposed = true
        controller?.unregister()
      }
    })
  })
}
```

And in the failure branch, instead of today's unconditional `ensureController()?.report(...)`:

```ts
(e: unknown) => {
  if (myGeneration !== generation) return
  setError(e)
  if (disposed) return
  if (claimedCandidate === null) {
    claimedCandidate = candidates.find(
      (c) => !c.disposed && (c.scope.for === undefined || c.scope.for(e)),
    ) ?? null
  }
  if (claimedCandidate !== null) {
    controller ??= claimedCandidate.scope.register()
    controller.report({ status: 'failed', error: e, source: null, retry })
  }
}
```

Every candidate gets its own disposal guard, installed while everything is still alive — a candidate that never ends up claimed simply marks itself disposed and does nothing else; the one that does gets its `unregister()` call routed through the same guard the single-candidate version has today.

### A deliberate simplification: which candidate is claimed does not change across `retry()`

Once an attempt fails and a candidate claims it, `claimedCandidate` stays set until the action either succeeds (which already resets `controller` to `null`, and resets `claimedCandidate` alongside it) or a later attempt fails *before* `claimedCandidate` was ever set. A `retry()` that fails again re-reports to the *same* claimed candidate rather than re-running the whole selection — matching the existing "one controller, reused across retries" invariant `report()`'s own dedup already relies on. If a single action's retried attempts could genuinely throw meaningfully different *kinds* of errors that should route to different boundaries, this would need revisiting; no case in this codebase does that today, and it is not built here.

## Explicitly out of scope

- The implicit root `FailedScope` (installed by `createRoot()`, `docs/superpowers/specs/2026-08-19-failed-boundary-composition-design.md` Part 2) stays unconditional — no `for`, always accepts. It is the guaranteed backstop that document specifically built; making it filterable reopens "a failure with nowhere to go" for any error every explicit boundary above it declines, and this document does not solve that separately reachable problem.
- `action()` gaining the ability to reach a `catchError` handler at all — see Part 1's "why `action()` still never talks to it".
- Read-time filtering on `useFailed()`/`Failed.Error` — see Part 1's "Deferred" subsection and "What was cut" below.
- Narrowing `catchError`'s own `handler` parameter via a type guard — `<Failed>`'s `fallback` gets this treatment; `catchError`'s `handler` does not.

## What was cut, and why it can come back later

### `useFailed(guard)` / `Failed.Error for={guard}`

Considered as an alternative to registration-time filtering entirely, not just a complement to it: if `<Failed.Error>` itself took a type-guard predicate, multiple differently-filtered `<Failed.Error>` instances could read from one, single, unfiltered `<Failed>` boundary, each only lighting up for its own error type — no changes to `action()`'s discovery timing needed at all.

Cut because it does not actually solve the demo's motivating problem on its own: the boundary's own `error()` only ever exposes one current value (whichever report arrived first), so two *concurrently* active, differently-typed failures on the same unfiltered boundary would compete for that one slot — a `useFailed(isLoadError)` read could miss a genuinely-active load failure if a mutation failure happened to register first. For this specific demo the overlap is narrow (a mutation can't start before the first load succeeds), but real (a refetch failing while a mutation is still unresolved would hit it). Registration-time filtering does not have this gap, since each filtered boundary keeps its own separate collection.

Worth building later as a genuine complement — type-safe narrowing for code that's already reading from a boundary is valuable in its own right — just not as a substitute for Part 1-3 above. Recoverable from this document's own sketch in Part 1 if picked up.

## Resolved during review

- **Filter shape is a single predicate (`for`), not a class list.** A class-list form (`errors={[XError, YError]}`) was considered and rejected: a predicate is strictly more general (`for={(e): e is XError => e instanceof XError}` expresses class matching trivially) and this avoids maintaining two overlapping mechanisms for the same job.
- **The type-guard form (`(value: unknown) => value is E`) was chosen over a plain `boolean`-returning predicate**, specifically so `fallback`'s own `error` parameter can be narrowed to `E` within the same `<Failed>` element. A plain predicate is still accepted, for filters that can't naturally express a type guard (matching by message, by a custom property).
- **`Owner`'s `boundaries.failed` and `errorHandler` fields stay separate — `<Failed>` is not rebuilt on top of `catchError`.** A full unification was considered (one field, one walk, `<Failed>` as a stateful consumer of the same primitive `catchError` uses) and is architecturally coherent, but reworks `Owner`'s shape, `catchError`, `routeError`, and `<Failed>`'s own registration internals together, for a stateful-collection-vs-one-shot-callback mismatch that would need its own resolution. Kept as two mechanisms, each independently filterable, sharing only the walk logic.

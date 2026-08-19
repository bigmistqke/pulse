# Read-time filtering: `useFailed(predicate)` and `Failed.Error`'s `for`

Today, `useFailed()` and `Failed.Error` read whichever `<Failed>` boundary is nearest by position, with no way to ask for a specific kind of error — they report the boundary's first currently-failed report, whatever it is. This document adds an optional predicate to both, so a reader can pick out a specific kind of failure from whatever boundary it's already scoped under, instead of taking whatever happens to be first. It requires `FailedScope`'s collection to stop collapsing to "the first report" and expose everything it currently holds, so a predicate can find a match that isn't the first one.

This document records the conclusions reached in a design discussion on 2026-08-19 and was written before implementation began. It follows directly from `docs/superpowers/specs/2026-08-19-error-type-filtered-boundaries-design.md`, whose "What was cut, and why it can come back later" section named this exact feature (`useFailed(guard)` / `Failed.Error for={guard}`) and explained why it was deferred rather than built as the primary fix.

## Motivation

The prior document rejected read-time filtering as a *replacement* for registration-time filtering (`<Failed for={...}>`), because a boundary's collection only ever exposes one current error — whichever report arrives first — so two concurrently-active, differently-typed failures on the same unfiltered boundary would compete for that one slot. That reasoning holds and is not being revisited: `<Failed for={...}>`'s registration-time semantics — which boundary an error's report is ultimately registered with, and whether it counts as "handled" (stopping there) or keeps propagating outward toward root's own default logging — are unchanged by this document. Every line of `src/owner.ts`, `src/effect.ts`, and `src/scope.ts` from that plan stays exactly as built and merged.

What changed is recognizing read-time filtering as a genuine *complement*, not a substitute — useful specifically for the case where one boundary legitimately, correctly holds more than one kind of failure at once (a subtree with several independent operations, none of which warrants its own `for`-filtered boundary), and a specific reader wants to display just one of them. The prior document's own objection — "the boundary's `error()` only ever exposes one current value" — is a real gap in `FailedScope`'s current shape, not an inherent limit on the idea. This document closes that gap directly: expose the full collection, not just the first entry, and let a predicate search it.

A second question came up during this discussion and is worth recording explicitly, since it shapes why `<Failed>`'s own boundary-establishing role is not going anywhere: a predicate alone cannot answer "*which* instance." `useFailed((e) => e instanceof LoadingError)`, if it searched every failure in the whole app rather than only the ones beneath whichever boundary is nearest, could not tell "my own widget's load failed" from "some unrelated widget's load failed elsewhere on the page" — both would match the same predicate. Positional scoping is what makes "mine" mean something: a boundary only ever collects reports from bindings that are actually beneath it. So `useFailed(predicate)` still walks to the nearest boundary first (exactly as `useFailed()` does today, via `findBoundaryScope` — a plain positional walk, unaffected by any boundary's own `for`) and filters *that* boundary's collection. It does not search across boundaries, and it does not replace the need for `<Failed>` to wrap a subtree when isolating one instance's failures from another's is the actual goal.

## What `FailedScope` exposes today, and what changes

Current shape (`src/owner.ts`):

```ts
export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
  readonly error: Accessor<unknown>
  readonly for?: (error: unknown) => boolean
  reset(): void
}
```

`error()` is derived from `failedSet.values().next().value` — literally "whichever report happens to be first in Map iteration order," with no way to ask for a different one. `FailureReport` (the shape held per registered controller — `{ error, source, retry }`) is defined in `src/owner.ts` but not exported; nothing outside the file can name it.

New shape:

```ts
/** What a failed binding reported: the error, the node whose parked failure
 *  it threw (if any), and how to re-run it. Mirrors the shape src/effect.ts
 *  reports through BindingState's 'failed' case. */
export interface FailureReport {
  readonly error: unknown
  readonly source: Accessor<unknown> | null
  readonly retry: () => void
}

export interface FailedScope extends BoundaryScope {
  readonly kind: 'failed'
  /** The first failed report's error, or `null` while healthy. Same value a
   *  `<Failed>` with a `fallback` passes as that fallback's first argument.
   *  Always reports()[0]?.error ?? null — kept as its own accessor because
   *  <Failed>'s own fallback reads it unfiltered, exactly as today. */
  readonly error: Accessor<unknown>
  readonly for?: (error: unknown) => boolean
  /** Every currently-failed report this scope holds, in registration order.
   *  useFailed(predicate)/Failed.Error filter this to find a report that
   *  isn't necessarily first — error/active above stay based on the first
   *  entry specifically, unaffected by anything reading this. */
  readonly reports: Accessor<readonly FailureReport[]>
  reset(): void
}
```

`FailureReport` becomes exported (it already lived in `src/owner.ts`; this only changes its visibility) so `useFailed`'s own filtering logic, and any caller inspecting a `reports()` entry directly, can name its shape.

`createFailedScope`'s internal `Collection`/`recompute` changes from tracking `{ active, error }` (derived once, at write time, from "first") to tracking the reports array directly:

```ts
interface Collection {
  readonly reports: readonly FailureReport[]
}
```

`error`/`active` on the returned `FailedScope` become thin derivations over `reports()`:

```ts
error: () => readCollection().reports[0]?.error ?? null,
active: () => readCollection().reports.length > 0,
reports: () => readCollection().reports,
```

The existing no-op-write skip (`report()` re-firing the same error while a single rejection re-runs a binding several times must not trigger a redundant recompute) moves from comparing "active + first error" in `recompute()` to a per-controller check inside `register()`'s own `report()`, before `recompute()` is ever called — more precise than the original (which only compared the first entry) and simpler, since it only ever needs to compare one controller's own previous report against its new one, not reason about the whole collection:

```ts
report(state): void {
  if (state.status === 'failed') {
    const existing = failedSet.get(controller)
    if (existing !== undefined && Object.is(existing.error, state.error)) return
    failedSet.set(controller, { error: state.error, source: state.source, retry: state.retry })
  } else {
    if (!failedSet.has(controller)) return
    failedSet.delete(controller)
  }
  recompute()
},
```

`recompute()` itself simplifies to always publish a fresh `reports` array when actually called (the skip now happens before it, above):

```ts
const recompute = (): void => {
  current = { reports: Array.from(failedSet.values()) }
  r3SetSignal(collectionNode, current)
},
```

`reset()` is unaffected — it already operates on `failedSet` directly, not on the published `Collection` shape.

## `useFailed(predicate)`

Current shape (`src/dom/failed.ts`):

```ts
export interface FailedState {
  readonly active: Accessor<boolean>
  readonly error: Accessor<unknown>
  retry(): void
}

export function useFailed(): FailedState {
  const scope = findBoundaryScope(getOwner(), 'failed')
  if (scope === null) return CONST_FAILED_STATE
  return { active: scope.active, error: scope.error, retry: scope.reset }
}
```

New shape:

```ts
export interface FailedState<E = unknown> {
  readonly active: Accessor<boolean>
  readonly error: Accessor<E | null>
  retry(): void
}

/**
 * Reads the nearest enclosing `<Failed>` boundary's state, same positional
 * walk as before (`findBoundaryScope`, ignoring any boundary's own `for` —
 * this answers "which boundary would swap me out", not "who intercepts my
 * own failure"). `predicate`, if given, narrows further: `active`/`error`
 * reflect only reports matching it, and `retry()` re-runs only those —
 * not the boundary's whole collection. Written as a type guard, `error()`
 * narrows to `E`, the same convenience `<Failed>`'s own `for` gives its
 * `fallback`.
 */
export function useFailed<E = unknown>(
  predicate?: ((value: unknown) => value is E) | ((value: unknown) => boolean),
): FailedState<E> {
  const scope = findBoundaryScope(getOwner(), 'failed')
  if (scope === null) return CONST_FAILED_STATE as FailedState<E>
  const matching = (): readonly FailureReport[] =>
    predicate === undefined ? scope.reports() : scope.reports().filter((r) => predicate(r.error))
  return {
    active: () => matching().length > 0,
    error: () => (matching()[0]?.error as E | undefined) ?? null,
    retry: () => {
      for (const report of matching()) {
        if (report.source !== null) resetFailure(report.source)
        report.retry()
      }
    },
  }
}
```

`retry()` retrying only the matching subset, not the whole boundary's collection, is a deliberate departure from `<Failed>`'s own `reset()` (which always clears everything, matching its own, unfiltered `fallback`): a retry button shown next to a *filtered* display should not silently also retry some unrelated failure the same boundary happens to also be holding, that this particular reader was never showing in the first place.

`useFailed()` called with no predicate keeps its exact current behaviour (first report, whole-collection retry) — every existing call site is unaffected.

## `Failed.Error`'s `for`

Current shape:

```ts
export interface FailedErrorProps {
  children: (error: unknown, retry: () => void) => unknown
}

export namespace Failed {
  export function Error(props: FailedErrorProps): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useFailed()
    // ... unchanged branch-caching logic below
  }
}
```

New shape: `FailedErrorProps` becomes generic over `E` and gains an optional `for`, threaded straight into the underlying `useFailed(props.for)` call — no other change to `Failed.Error`'s own logic (the branch-caching, the sub-owner per active-transition, all of it is unaffected):

```ts
export interface FailedErrorProps<E = unknown> {
  for?: ((value: unknown) => value is E) | ((value: unknown) => boolean)
  children: (error: E, retry: () => void) => unknown
}

export namespace Failed {
  export function Error<E = unknown>(props: FailedErrorProps<E>): Accessor<unknown> {
    const parentOwner = getOwner()
    const { active, error, retry } = useFailed(props.for)
    // ... unchanged
  }
}
```

## What does not change

- `<Failed>`'s own `fallback` mechanism, and its `for` prop's registration-time semantics — completely unaffected. `<Failed>`'s own `error`/`active` reads stay based on the first entry, exactly as today, since a `<Failed for={...}>`'s own collection only ever holds reports that already matched its own filter — "first" and "first matching" are already the same thing there.
- `action()`'s candidate collection, `effect.ts`'s two call sites, `findNearestFailedScope`, `routeError`, `catchError` — none of this is touched. Routing (which boundary a failure's report lands in, and whether it propagates past a given boundary toward root) is entirely orthogonal to this document, which only changes what a boundary exposes once something has already landed in it, and adds a way to read a filtered subset of that.
- Every existing `useFailed()`/`Failed.Error` call site (no predicate given) keeps its exact current behaviour.

## Explicitly out of scope

Considered and rejected during this discussion, recorded so the reasoning isn't re-derived later:

- **`createFailed()` as a factory returning a persistent handle**, decoupled from JSX position entirely. Explored at length; dropped because the only case it would add value over a plain `useFailed(predicate)` call — retrying one specific instance's failure from somewhere outside that instance's own subtree — is a narrow, unusual UI pattern (a retry control normally lives right next to what failed), not worth a whole additional API surface for.
- **Explicit handle-passing** (`action(fn, { failed: handle })`, `computed(fn, { failed: handle })`). Rejected outright, not just deprioritized: pulse's owner model has no "change the ambient owner for the rest of this function" primitive, only `runWithOwner`'s scoped-callback form — so implicit, non-parameter-passed discovery was kept, which is exactly what `<Failed>`'s existing positional model already provides.
- **Making boundary registration additive** — every failure registering with every enclosing boundary up to root, rather than stopping wherever a boundary accepts it. Explored as a way to simplify `action()`'s candidate-collection machinery; rejected because it removes the ability for a boundary to mark an error as handled and suppress root's own default `console.error` logging for it — a real, needed capability, not incidental complexity.
- **Removing `for` from `<Failed>`** in favor of doing all filtering at read time. Rejected for the "which instance" reason above: without a boundary's own `for` letting two differently-typed boundaries coexist at the same position (this session's `examples/todo-async` load/mutation split), and without registration-time routing deciding what counts as handled, read-time filtering alone cannot recover either property.

## Resolved during review

- **The per-report skip check moves from `recompute()` (comparing "active + first error") to `report()` itself (comparing one controller's previous report against its new one).** Considered keeping the comparison in `recompute()`, extended to the whole array — rejected as needlessly more complex: the thing being skipped is always one specific controller re-reporting a value it already reported, so the check belongs where that controller's own report arrives, not in a general array comparison downstream. This is also more precise than the original: a non-first controller's no-op re-report was already skipped correctly under the old "first entry" comparison, incidentally, but the new placement makes that a direct consequence of the check's own logic rather than a side effect of what happened to be compared.
- **`useFailed(predicate).retry()` retries only the matching subset, not the whole boundary's collection**, deliberately departing from `<Failed>`'s own `reset()` (always clears everything). A retry control shown next to a filtered display retrying some unrelated failure the same boundary happens to also hold — one this reader was never showing — would be a surprising side effect of a button whose visible label only mentions the one it displayed.
- **The central open question this document had to answer wasn't "should read-time filtering exist" but "does it need boundary scoping at all, now that it exists."** Explored seriously (see "Explicitly out of scope" above) before landing on: yes — a predicate alone cannot disambiguate *which instance* of a matching error, only positional scoping (an enclosing `<Failed>`) can, and `useFailed(predicate)`'s walk stays positional for exactly that reason.

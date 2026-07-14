# `<Failed>` — the failure boundary as a collection boundary

Status: designed, not implemented. Branch `signal-as-node`.

## Why

A failure is already graph state in pulse. It is parked beside the value rather than over it, so `latest(x)` can degrade to the stale value, `use(x)` throws, and `failure(x)` queries it. That work is done and it is right.

The boundary is not. `catchError(fn, handler)` is an event callback: it fires once per throw. Collected graph state pushed through an event-stream interface produces a specific symptom, and we measured it — a single promise rejection notifies the boundary **three times**. The consuming binding re-runs three times as one settle lands (the pending signal flipping false, the failure signal parking, and the effect's own settle-kick), and each re-run re-reads a failed node and re-throws. Nothing is wrong with any individual step. The mismatch is that the boundary counts events while the node holds a state.

The codebase already knows about this double-fire on the success path: `src/effect.ts:119-121` works around it with an `Object.is` dedupe, commenting that the pending signal and the value signal both trigger re-runs when a promise settles. The failure path has no equivalent guard, and adding one would be treating the symptom.

## What Solid 2 does

Solid 2 (`@solidjs/signals`, version 2.0.0-experimental.13) has no error-boundary-as-callback at all. From `dist/dev.js:2556-2598`:

```js
const STATUS_PENDING = 1 << 0;
const STATUS_ERROR   = 1 << 1;

function createLoadBoundary(fn, fallback)  { return createCollectionBoundary(STATUS_PENDING, fn, ...) }
function createErrorBoundary(fn, fallback) { return createCollectionBoundary(STATUS_ERROR,   fn, ...) }
```

The load boundary and the error boundary are the same function, differing only in which status flag they collect. A boundary owns a queue of nodes carrying that flag, and the boundary itself is a computed that selects between the resolved tree and the fallback depending on whether the queue is empty. Pending and failed are the same kind of graph state, collected the same way, rendered the same way.

So a failure is never delivered to anything. It sits on the node, the enclosing boundary collects it, and the fallback is a derived rendering of that collection — idempotent by construction. A failed node recomputing three times does not fire anything three times; it stays in the queue. Solid's only callback-shaped escape hatch is `tryCatch(fn)`, which returns `[error, value]`, is local and synchronous, and explicitly rethrows `NotReadyError` — the same invariant pulse holds, that suspension is not a failure.

Pulse already has both halves of this design and they are already correct. `<Loading>` is a collection boundary: a set of pending controllers, and an accessor that selects fallback versus loaded subtree (`src/dom/loading.ts:54`, `:149-153`). A failure is node state. The only piece out of shape is the boundary that reads it.

## The design

### 1. The collection scope

Today's `LoadingScope` does two separable jobs, and only one of them generalises.

- **Collect.** The pending set, and the `pending` accessor derived from whether it is empty. This is the collection boundary. It generalises.
- **Gate.** The ready set, the deferred commits, `flushAll`, and the microtask tail-check. This is atomic-commit coordination and it is specific to loading. A failure boundary has nothing to commit atomically.

Only the collection is generalised. `<Loading>`'s commit gate stays exactly where it is, unchanged. This is also what Solid does — `createCollectionBoundary` collects and selects; scheduling lives elsewhere.

```ts
type BindingStatus = 'pending' | 'failed'

interface BoundaryScope {
  readonly kind: BindingStatus        // which status this boundary collects
  readonly active: Accessor<boolean>  // true while the collection is non-empty
  register(): BindingController
}
```

`Owner` carries one scope slot per kind instead of a single `loadingScope`, and the walk is parameterised: `findBoundaryScope(owner, kind)`. That is what lets the two boundaries nest independently, with a single binding reporting `pending` to the inner boundary and `failed` to the outer one:

```tsx
<Failed fallback={(error, reset) => <p>{String(error)} <button on:click={reset}>retry</button></p>}>
  <Loading fallback={<Spinner />}>
    <span>{() => use(c)}</span>
  </Loading>
</Failed>
```

`BindingState` grows a failed case:

```ts
type BindingState =
  | { status: 'pending' }
  | { status: 'failed'; error: unknown; source: Accessor<unknown> | null }
  | { status: 'ready'; commit: () => void }
  | { status: 'idle' }
```

### 2. Registration — and why the double-registration is left alone

**Corrected during planning. This section originally proposed collapsing the per-binding double registration, on the grounds that two boundary kinds would mean four controllers per binding. That premise is false.**

`insertChild` and `bindProp` do not route their own failures. On a non-`NotReadyYet` throw they rethrow (`src/dom/bindings.ts:167`, `:169`) into the `effect()` beneath them, and that effect is what routes. So failure reporting lives in exactly one place, `src/effect.ts`, and a binding never registers a failed controller at all.

Adding `<Failed>` therefore adds one controller per binding, owned by the effect. The existing pending double-registration — `insertChild`/`bindProp` registering one controller, and the `effect()` beneath them registering another — stays at two, exactly as it is today. It is unchanged, not multiplied.

So the reason to collapse it *inside this change*, which is what would have put `<Loading>`'s atomic-commit gate at risk, does not exist. The duplication remains a standalone cleanup (the binding-effect primitive already proposed in `docs/follow-ups.md`), to be done on its own, gated on the `<Loading>` gate tests. `src/dom/bindings.ts` is not modified by this work at all.

### 3. Routing a failure

`<Failed>` and `catchError` are peers in **one walk** up the owner chain, not two competing mechanisms. This is what makes their precedence well-defined.

On a throw that is not `NotReadyYet`, a binding calls `routeFailure(owner, error, source)`, which walks up and stops at whichever it meets first:

- an owner carrying a **failed-scope** (`<Failed>`) — collect this binding's controller into it. The boundary's `active` flips true and it selects its fallback.
- an owner carrying an **`errorHandler`** (`catchError`) — invoke the handler, exactly as today.
- neither, all the way up — the rule established in commit `e287308`: throw on a node's first run, report on a write-driven re-run.

Nearest wins. A `catchError` nested inside a `<Failed>` still intercepts, and `<Failed>` catches whatever the inner handler does not. `catchError` keeps its current semantics; `<Failed>` becomes another stop on the same walk.

**The collection unit is the binding, not the failed node.** This is forced rather than chosen: a computed is frequently created outside `render()` — as it is in the test that prompted this work — so the failed node is not under the boundary at all. Only its consumer is. This also coincides with Solid, where every JSX hole is itself a node, so collecting consumers and collecting nodes are the same act.

### 4. Why this dissolves the triple delivery

Walking the failing case through the new model:

1. The promise rejects. The computed parks its failure. (Reliably, since commit `e287308`.)
2. The binding re-runs three times — from the pending flip, the failure park, and the effect's settle-kick.
3. Each re-run throws and reports `{ status: 'failed' }` through **the same controller**.
4. The scope's collection is a set keyed on controller. Three reports, one entry. `active` flips true once. The fallback renders once.

The redundant re-runs still happen. They stop being observable, which is the point of the collection model: idempotence by construction rather than by dedupe.

### 5. What `<Failed>` renders

While its collection is non-empty, `<Failed>` renders `fallback(error, reset)` in place of the subtree. Otherwise it renders the subtree. It takes the first collected error.

There is no `holdPrior` option. Stale-while-revalidate remains reachable without a boundary, through `latest(x)` and `failure(x)`.

`<Failed>` is not a latch. A React-style error boundary catches a throw, records "I have errored" in its own state, and shows the fallback until something resets it — the error is an event it remembers. `<Failed>` is a derived selection over live graph state: it shows the fallback exactly while the collection is non-empty. If the failure clears on its own — an upstream dependency changes, the stage re-runs, and `failureSig` clears — the binding reports idle, the collection empties, and the boundary returns to the subtree with no `reset()` call. It unlatches itself. This is the same property that makes it idempotent under repeated reports.

### 6. `reset()` and failure provenance

`reset()` covers the one case the graph cannot handle by itself: retrying with unchanged inputs, which is the retry button. Recovery driven by a dependency change already works without it.

The obstacle is that the boundary collects the binding while the thing that failed is the computed, which may live entirely outside the boundary. Re-running the binding alone achieves nothing — it re-reads a still-parked failure and throws again. So the binding must hand the boundary a reference to what failed.

Pulse already has the pattern. `markUsedInBinding()` in `src/transition-tracker.ts` is a module-level flag that `use()` sets and `runBindingCompute()` captures. Provenance works identically:

- The computed's accessor records itself as the failure source before throwing its parked failure (`src/computed.ts:432-436`, at the existing throw).
- `runBindingCompute` captures it; the binding reports it as `source`.
- A binding that threw a plain error, with no computed involved, reports `source: null`.

`reset()` then walks the collected entries:

- **With a source** — reset that node: clear its failure signal and kick its body to recompute. This adds one field to `FailureEntry` in `src/failure.ts` (`reset: () => void`), implemented in `makeStageNode`.
- **With no source** — re-run the binding.

`reset()` walks the **upstream chain to the root failed stage** rather than resetting the node the binding happened to read. `FailureEntry` already carries an `upstream` link, and `failure()` already walks it to find the failing stage in a pipeline; `reset()` follows the same chain and resets the deepest stage that is actually failed, not the leaf that merely propagated the failure. This is what Solid's `collectErrorSources` does — it walks each queued node's dependencies and recomputes only nodes whose own dependencies are not themselves errored.

### 7. A note on the binding-compute record

This design adds a second module-level "what happened during this binding compute" flag alongside `usedInCurrentBinding`. Two is the point at which they should become one small record that `runBindingCompute` populates and returns, rather than a growing set of globals. Fold this into the implementation rather than leaving it for later.

## Tests

**Collection semantics.**

- One rejection, three binding re-runs, one fallback render, one entry in the collection. This is the regression test for the triple delivery and the test that would have caught the original symptom.
- Two failed siblings under one `<Failed>` render one fallback. When one recovers the fallback remains (the collection is still non-empty); when both recover the subtree returns.
- Self-unlatching: a failed computed whose upstream dependency changes and then succeeds returns the boundary to the subtree with no `reset()` call. This is the property that distinguishes `<Failed>` from a latch, so it is pinned explicitly.

**Composition.**

- `catchError` nested inside `<Failed>`: the inner handler wins and `<Failed>` never activates.
- `<Failed>` outside, `<Loading>` inside, one binding: pending routes to the inner boundary and failure to the outer. A pending read must not activate `<Failed>` — suspension is not a failure. `test/dom/loading-no-boundary.test.tsx` already guards this invariant, and Solid holds it too, which is why `tryCatch` rethrows `NotReadyError`.
- No boundary at all: the behaviour from commit `e287308` still holds. The failure parks, the error is reported, nothing is corrupted.

**Reset.**

- Retry with unchanged inputs: a computed that fails once and then succeeds is cleared and recomputed by `reset()`, and the subtree returns.
- Root-source reset: a three-stage pipeline failing at stage 0 has stage 0 recomputed, not the leaf that propagated the failure.
- A binding that threw a plain error (`source: null`) is re-run by `reset()`.

**Non-regression.**

The full `<Loading>` suite (`test/dom/loading.test.tsx`, `test/dom/loading-atomic.test.tsx`) must stay green without modification. The commit gate is not being generalised. If those tests break, the refactor has overreached.

## Out of scope

- **The redundant re-runs.** Three re-runs per settle is real inefficiency, but the collection model makes them unobservable. Removing them means batching the settle writes, which touches the success path and the `Object.is` gate at `src/effect.ts:119`. It is a separate change, and it is safer to make once the boundary is idempotent.
- **Generalising the commit gate.** It stays a `<Loading>` concern.
- **`holdPrior` on `<Failed>`.**
- **The known `<Loading>` scope bug** — top-level component children of a `<Loading>` fragment cannot reach the scope through `useLoading()`, currently the one skipped test in the suite. `findBoundaryScope` inherits it unchanged. Recorded in `docs/follow-ups.md`; not addressed here.

## Risks

The risk this design originally carried — collapsing the per-binding double registration, which would have reached into `<Loading>`'s atomic-commit gate — turned out to rest on a false premise and has been removed. See section 2. `src/dom/bindings.ts` is not touched, the gate is not touched, and `test/dom/loading.test.tsx` / `test/dom/loading-atomic.test.tsx` must pass unmodified throughout.

What remains is a rename (section 1) and additive work (`<Failed>`, provenance, `reset`). The rename is the only change that touches `<Loading>` at all, and it is mechanical: if a `<Loading>` test fails during it, semantics have been changed by accident.

## Background

The work that produced this design began from a handoff describing a bug: "a real failure never reaches the error boundary from a DOM binding". That bug does not exist. The test wrapped `catchError` around `render`, which can never work — `render` calls `createRoot`, whose owner has no parent, so the handler is not an ancestor of the bindings inside it and the owner walk cannot reach it. Every other passing test in the suite puts the boundary inside `render`.

Investigating it did surface a real bug, fixed in commit `e287308`: an uncaught consumer error unwound the computed's settle handler and skipped the line that parks the failure, so a node's own bookkeeping depended on whether its consumers had error boundaries. It also surfaced the triple delivery, which is what this design addresses.

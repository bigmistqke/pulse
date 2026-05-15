# Error Boundaries as Sub-Owners

pulse needs error boundaries that catch sync throws and async rejections from a
"subtree" of reactive nodes. Plan 2c established Owner-based lifecycle scopes
but did not parent owners — `createRoot` always created a fresh root, with no
parent/child relationships. Plan 2d adds error boundaries by **extending
`Owner` with a parent link and an optional error handler**, and introducing
`catchError(fn, handler)` which creates a child owner of `currentOwner`,
attaches the handler, and runs `fn` with it as ambient.

When a reactive node's wrapper catches a non-`NotReadyYet` throw, it walks the
owner chain via `parent` links looking for the nearest `errorHandler` and
invokes it. If none is found, the throw is re-thrown (Plan 2a's behaviour
preserved for unowned or unhandled errors). If the handler itself throws, the
walk continues past it to find an outer boundary.

### Considered alternatives

- **Captured ambient handler, no new owner machinery.** `catchError` would set
  a module-level `currentErrorHandler` for `fn`'s synchronous execution;
  reactive nodes capture it at creation; wrappers invoke the captured handler
  on throw. Simpler — required no extension to Plan 2c — but the "boundary" is
  not a tangible entity in the reactive graph, just a closure. Rejected:
  Plan 3 (DOM) will need parented owners for component cleanup, and doing the
  Owner extension now (against the smaller surface area of error boundaries)
  is cheaper than doing it later under DOM pressure.
- **`createRoot` with an `{ onError }` option.** Folds the boundary into
  `createRoot`. Rejected: `createRoot` is the "opt-out of parent disposal"
  primitive; an error boundary should *nest* inside a root, not replace it.
  Conflates two orthogonal concerns.

### Consequences

- **`Owner` is now a tree, not a flat structure.** `parent: Owner | null` and
  `errorHandler: ((e: unknown) => void) | null` are added. Parent disposal
  cascades to children: a child owner is registered as a disposable child of
  its parent at creation, so the existing `disposeOwner` walk reaches it.
- **Reactive nodes capture their owner at creation.** They need a stable
  reference to start the walk-up from, because during r3's automatic recompute
  `currentOwner` is unpredictable (r3 has no owner concept; pulse's ambient is
  set only during `runWithOwner` / `createRoot` callbacks).
- **A throwing node stays alive but frozen.** Its r3 value is whatever it was
  before the throw; it may re-run when tracked deps change, and the handler
  may fire again. Recovery is user-managed (typically via an error-state
  `signal` that user code branches on). Matches Solid's `catchError`.
- `createRoot` continues to be a *root* (no parent). Only `catchError` creates
  parented children. The owner-tree is sparse — leaf-shaped — until DOM
  components arrive.

### Relationship to ADR 0002

ADR 0002 said "Errors throw to graph-node boundaries." The "graph node"
language was DOM-centric. In Plan 2d the boundary is an `Owner` — a real
inspectable thing in the runtime, even without DOM. The semantics in ADR 0002
(catches sync throws + async rejections, propagates upward, throw-not-value)
all hold; this ADR specifies the mechanism.

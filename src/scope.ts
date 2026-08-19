import {
  computed as r3Computed,
  getContext,
  read as r3Read,
  setSignal as r3SetSignal,
  signal as r3Signal,
  stabilize,
  untrack as r3Untrack,
  type Computed as R3Computed,
  type Signal as R3Signal,
} from 'r3'
import { isGeneratorFunction } from './is-generator-function'
import { isPromise } from './is-promise'
import {
  getOwner,
  onCleanup,
  runWithOwner,
  type BindingController,
  type FailedScope,
  type Owner,
} from './owner'
import type { Accessor } from './signal'

/** Graph identity wrapping a recipe. Value is not in the Node — it is produced
 *  by handing the Node to a read walk. Per Q6. */
export interface Node<T = unknown> {
  /** Optional recipe: present ⇒ computed (run-and-isolate on read); absent ⇒
   *  signal (fall-through leaf read). Per Q7. */
  defaultRecipe?: () => T | Promise<T>
  /** Who subscribes to me — the fast write-fire index. */
  subs: Set<Edge>
  /** Committed state lives in this r3 node (ADR 0010). Absent = pure-overlay
   *  node (test-only until the public API is rewired in Plan 4). */
  backing?: R3Signal<T> | R3Computed<T>
}

/** Marks a slot whose cached value is stale (or not yet computed) and must be
 *  recomputed on the next read. A distinct symbol rather than `undefined`, so a
 *  recipe that legitimately evaluates to `undefined` is a real cached value and
 *  is told apart from a dirty slot — otherwise such a slot never memoizes and
 *  re-runs its recipe on every read. */
export const DIRTY = Symbol('dirty')

/** A per-(Node, scope) cache cell. Uniform shape per Q9 — no `wasWritten` flag. */
export interface Slot<T = unknown> {
  recipe: (() => T | Promise<T>) | undefined
  cached: T | typeof DIRTY
  deps: Edge[]
  /** The node this slot caches a value for. Lets a write walk on from a dirtied
   *  slot to that node's own subscribers, so invalidation propagates transitively. */
  node: Node<T>
}

/** A subscription edge. Engine-managed chains (Q1 Model 1): plain source/target
 *  plus the scope the target lives in; the chain is derived at fire time. */
export interface Edge {
  source: Node
  target: Slot
  targetScope: Scope
}

export type ScopeKind = 'owner' | 'speculative'

/** How a speculative scope closed, reported to its close callbacks. */
export type SettleOutcome = 'committed' | 'discarded'

/** The ambient context primitive. Owns its slots/edges/sets/cleanups. Per Q6. */
export interface Scope {
  parent: Scope | undefined
  children: Set<Scope>
  slots: Map<Node, Slot>
  edges: Set<Edge>
  writeSet: Set<Node>
  readSet: Set<Node>
  /** Callbacks fired once when the scope closes, receiving how it closed.
   *  Registered via `onSettled`; drained by both `commit` and `discard`. A plain
   *  zero-argument callback is fine — it simply ignores the outcome. */
  cleanups: Array<(outcome: SettleOutcome) => void>
  status: 'open' | 'committed' | 'discarded'
  kind: ScopeKind
}

export const ROOT_KIND: ScopeKind = 'owner'

export function createScope(parent: Scope | undefined, kind: ScopeKind): Scope {
  const scope: Scope = {
    parent,
    children: new Set(),
    slots: new Map(),
    edges: new Set(),
    writeSet: new Set(),
    readSet: new Set(),
    cleanups: [],
    status: 'open',
    kind,
  }
  if (parent !== undefined) parent.children.add(scope)
  return scope
}

/** The scope chain from `scope` (most specific) up to its parentless terminal. */
export function chainFor(scope: Scope): Scope[] {
  const chain: Scope[] = []
  let s: Scope | undefined = scope
  while (s !== undefined) {
    chain.push(s)
    s = s.parent
  }
  return chain
}

/** Install a slot for `node` at `scope` and record the write. Pure storage. */
export function writeSlot(node: Node, scope: Scope, slot: Slot): void {
  scope.slots.set(node, slot)
  scope.writeSet.add(node)
}

/** Resolve `node` by walking the chain from `scope`, returning the first slot
 *  found (fall-through). Undefined if no slot exists anywhere in the chain. */
export function readSlot(node: Node, scope: Scope): Slot | undefined {
  for (const s of chainFor(scope)) {
    const slot = s.slots.get(node)
    if (slot !== undefined) return slot
  }
  return undefined
}

/** The engine-side fire predicate (Q1 Model 1). Fires iff `writeScope` is in
 *  the target slot's chain AND no more-specific scope in that chain has its own
 *  slot for the source (which would shadow the write). */
export function chainMatch(edge: Edge, writeScope: Scope): boolean {
  const chain = chainFor(edge.targetScope)
  const idx = chain.indexOf(writeScope)
  if (idx === -1) return false
  for (let i = 0; i < idx; i++) {
    if (chain[i].slots.has(edge.source)) return false
  }
  return true
}

/** Form a subscription edge during a tracked read: index on the source, record
 *  on the target scope (cleanup owner) and on the target slot's deps. */
export function linkEdge(source: Node, target: Slot, targetScope: Scope): Edge {
  const edge: Edge = { source, target, targetScope }
  source.subs.add(edge)
  targetScope.edges.add(edge)
  target.deps.push(edge)
  return edge
}

/** Given a write to `(node, writeScope)`, the edges that should fire. */
export function edgesToFire(node: Node, writeScope: Scope): Edge[] {
  const fired: Edge[] = []
  for (const edge of node.subs) {
    if (chainMatch(edge, writeScope)) fired.push(edge)
  }
  return fired
}

/** The edge/slot teardown shared by commit and discard (Q6 closeScope). Does
 *  NOT promote or fire cleanups — later plans add those around this. */
export function closeScopeEdges(scope: Scope): void {
  for (const edge of scope.edges) edge.source.subs.delete(edge)
  scope.edges.clear()
  for (const node of scope.readSet) scope.slots.delete(node)
  scope.readSet.clear()
  for (const node of scope.writeSet) scope.slots.delete(node)
  scope.writeSet.clear()
  scope.parent?.children.delete(scope)
}

/** The default parentless "outside any speculation" scope. */
export const ROOT_SCOPE: Scope = createScope(undefined, 'owner')

let currentScope: Scope = ROOT_SCOPE
let currentTracker: Slot | undefined = undefined

export function getCurrentScope(): Scope {
  return currentScope
}
export function getCurrentTracker(): Slot | undefined {
  return currentTracker
}

/** Run `fn` with `scope` as the ambient scope and `tracker` as the ambient
 *  slot-being-computed (Q8: the two ambients push/pop together). Restores both
 *  even if `fn` throws. */
export function runInScope<T>(scope: Scope, tracker: Slot | undefined, fn: () => T): T {
  const prevScope = currentScope
  const prevTracker = currentTracker
  currentScope = scope
  currentTracker = tracker
  try {
    return fn()
  } finally {
    currentScope = prevScope
    currentTracker = prevTracker
  }
}

export function signalNode<T>(initial: T): Node<T> {
  return { subs: new Set(), backing: r3Signal(initial) }
}
export function computedNode<T>(recipe: () => T): Node<T> {
  return { subs: new Set(), defaultRecipe: recipe, backing: r3Computed(recipe) }
}

export function readValue<T>(node: Node<T>): T {
  const scope = getCurrentScope()
  const slot = readSlot(node, scope)
  if (slot !== undefined) {
    if (slot.cached === DIRTY && slot.recipe !== undefined) {
      resetSlotDeps(slot)
      slot.cached = runRecipe(slot.recipe, scope, slot) // dirtied → recompute
    }
    // record a dep edge into the currently-computing slot (Q8 tracker)
    trackRead(node, scope)
    return slot.cached as T
  }
  if (scope !== ROOT_SCOPE && node.defaultRecipe !== undefined) {
    // speculative computed miss: run the recipe into a fresh S-slot
    const newSlot: Slot<T> = { recipe: node.defaultRecipe, cached: DIRTY, deps: [], node }
    scope.slots.set(node, newSlot)
    newSlot.cached = runRecipe(node.defaultRecipe, scope, newSlot)
    scope.readSet.add(node)
    trackRead(node, scope)
    return newSlot.cached as T
  }
  // committed leaf: inside an r3 recompute, read through r3 so the dependency
  // link forms (committed reactivity); outside, stabilize then read the value.
  trackRead(node, scope)
  if (getContext() !== null) {
    return r3Read(node.backing as R3Signal<T>)
  }
  stabilize()
  return (node.backing as R3Signal<T>).value
}

/** Read a node's value from the current scope WITHOUT running its recipe on a
 *  miss and without forming any dependency. A speculative miss on a node that
 *  has a recipe would evaluate it inside the speculation, where the suspend and
 *  settle machinery does not run — so anything asynchronous could not resolve.
 *  Falling through to the committed value avoids that entirely. */
export function peekValue<T>(node: Node<T>): T {
  const slot = readSlot(node, getCurrentScope())
  if (slot !== undefined && slot.cached !== DIRTY) return slot.cached as T
  stabilize()
  return (node.backing as R3Signal<T>).value
}

/** Unlink a slot's existing dependency edges before it is recomputed, so edges
 *  don't accumulate across recomputes (mirrors r3's recompute clearing deps). */
function resetSlotDeps(slot: Slot): void {
  for (const edge of slot.deps) {
    edge.source.subs.delete(edge)
    edge.targetScope.edges.delete(edge)
  }
  slot.deps = []
}

/** Run a recipe under `scope` with `slot` as the tracker, r3 context nulled so
 *  inner reads cannot form stray r3 links (ADR 0010 correctness requirement). */
function runRecipe<T>(recipe: () => T | Promise<T>, scope: Scope, slot: Slot): T {
  return r3Untrack(() => runInScope(scope, slot, () => recipe() as T))
}

/** If a slot is currently being computed under a speculation, link `node` to it. */
function trackRead(node: Node, scope: Scope): void {
  const tracker = getCurrentTracker()
  if (tracker !== undefined && scope !== ROOT_SCOPE) {
    linkEdge(node, tracker, scope)
  }
}

/** Scope-aware write. Committed (ambient scope is ROOT_SCOPE) delegates to r3;
 *  speculative writes are handled in Task 4. */
export function writeValue<T>(node: Node<T>, value: T): void {
  const scope = getCurrentScope()
  if (scope === ROOT_SCOPE) {
    r3SetSignal(node.backing as R3Signal<T>, value)
    return
  }
  // speculative — Task 4
  writeSpeculative(node, scope, value)
}

/** Speculative write: install a slot in `scope`, then mark every downstream
 *  speculative slot dirty (drop cached) so the next read recomputes (pull).
 *  Synchronous dirty-marking honors K1 Position C. */
function writeSpeculative<T>(node: Node<T>, scope: Scope, value: T): void {
  writeSlot(node, scope, { recipe: () => value, cached: value, deps: [], node })
  invalidateDownstream(node, scope)
}

/** Drop the cached value of every speculative slot reachable downstream of
 *  `node`, not just its direct subscribers: a slot that derives from a slot that
 *  derives from the written node must recompute too. Walks the subscriber graph
 *  from the written node, using each dirtied slot's own node to reach the next
 *  hop. A slot already dirty has, by this same walk, already had its downstream
 *  dropped, so it is not re-walked — which also terminates the walk. `writeScope`
 *  stays fixed across hops: it is the origin of the change, and `chainMatch`
 *  decides per edge whether a consumer sees a write from that scope. */
function invalidateDownstream(node: Node, writeScope: Scope): void {
  const stack: Node[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const edge of edgesToFire(current, writeScope)) {
      const slot = edge.target
      if (slot.cached === DIRTY) continue // already dirty ⇒ downstream already dropped
      slot.cached = DIRTY
      stack.push(slot.node)
    }
  }
}

/** Drain a scope's close callbacks once, in last-in-first-out order, passing
 *  how the scope closed. The list is emptied before firing and each callback
 *  is isolated, so a throwing callback neither re-fires on a later close nor
 *  strands the caller's own close bookkeeping (an unflushed commit) or its
 *  sibling callbacks. Mirrors the best-effort cleanup firing in owner.ts. */
function fireSettle(scope: Scope, outcome: SettleOutcome): void {
  const callbacks = scope.cleanups
  scope.cleanups = []
  for (let i = callbacks.length - 1; i >= 0; i--) {
    try {
      callbacks[i](outcome)
    } catch {
      // swallow per-callback errors — best-effort teardown
    }
  }
}

/** Commit a scope (ADR 0010 order): snapshot the writeSet's promoted values
 *  (before closeScopeEdges clears writeSet + drops slots), tear down the
 *  scope's pulse edges (edges-down-before-promote → no double-fire), then
 *  promote to the parent. Promoting to ROOT_SCOPE bridges to r3 via setSignal
 *  + a single stabilize (r3's InHeap-deduped heap gives Q10 batching). A
 *  speculative parent (nested actions) receives the value as a parent slot.
 *  Settle callbacks fire after promotions but before the final stabilize, so a
 *  callback's committed write (e.g. clearing an optimistic overlay) batches into
 *  the same flush as the promotions and consumers see one coherent frame. */
export function commit(scope: Scope): void {
  const promotions: Array<{ node: Node; value: unknown }> = []
  for (const node of scope.writeSet) {
    promotions.push({ node, value: scope.slots.get(node)!.cached })
  }
  closeScopeEdges(scope)
  const parent = scope.parent ?? ROOT_SCOPE
  if (parent === ROOT_SCOPE) {
    for (const { node, value } of promotions) {
      r3SetSignal(node.backing as R3Signal<unknown>, value)
    }
    fireSettle(scope, 'committed')
    stabilize()
  } else {
    for (const { node, value } of promotions) {
      writeSpeculative(node, parent, value)
    }
    fireSettle(scope, 'committed')
  }
  scope.status = 'committed'
}

/** Discard a scope: tear down edges + drop slots (no promotion), then fire
 *  close callbacks in LIFO order with 'discarded'. Speculative writes simply
 *  vanish. */
export function discard(scope: Scope): void {
  closeScopeEdges(scope)
  fireSettle(scope, 'discarded')
  scope.status = 'discarded'
}

/** The isolation-axis read: the last COMMITTED value, bypassing any active
 *  speculation. Reads the accessor with the scope forced to root, so `readValue`
 *  finds no speculative slot and takes the committed path (the r3 backing) —
 *  which is why this works for a computed too, whose committed value must be
 *  derived from committed state rather than read off a backing node. Still
 *  reactive: the r3 dependency forms as normal, so a consumer re-runs when the
 *  committed value changes. Contrast the readiness-axis `latest`. */
export function committed<T>(s: () => T): T {
  return runInScope(ROOT_SCOPE, undefined, s)
}

/** Register a close callback on an explicit scope, fired once when THAT scope
 *  closes: with 'committed' when it commits, 'discarded' when it is discarded.
 *  Nested actions need this — an inner scope committing only promotes its
 *  writes to its parent, not to the committed world, so a callback that has
 *  to wait for the committed world re-registers on the parent from inside its
 *  own 'committed' callback rather than firing on the inner commit. */
export function onSettledOn(scope: Scope, callback: (outcome: SettleOutcome) => void): void {
  scope.cleanups.push(callback)
}

/** Register a callback fired once when the CURRENT speculative scope closes:
 *  with 'committed' when it commits, 'discarded' when it is discarded. A caller
 *  that does not care which face closed the scope ignores the argument. Throws
 *  outside an action, where the callback would never fire. */
export function onSettled(callback: (outcome: SettleOutcome) => void): void {
  const scope = getCurrentScope()
  if (scope === ROOT_SCOPE) {
    throw new Error('onSettled requires an active speculative scope')
  }
  onSettledOn(scope, callback)
}

/** A tiny reactive cell built on r3's raw signal directly, not pulse's
 *  `signal()` wrapper — `src/signal.ts` imports from this file, so importing
 *  `signal()` back here would be a cycle. Mirrors `makeAccessor`'s top-level
 *  read behaviour (`src/signal.ts`): inside an r3 context, read through it
 *  directly; outside one, stabilize first so the value is never stale. */
function makeErrorCell(): [Accessor<unknown>, (value: unknown) => void] {
  const node = r3Signal<unknown>(null)
  const accessor = (() => {
    if (getContext()) return r3Read(node)
    stabilize()
    return node.value
  }) as Accessor<unknown>
  const setError = (value: unknown) => r3SetSignal(node, value)
  return [accessor, setError]
}

export interface ActionHandle {
  /** The currently in-flight attempt's outcome — the initial run, or the most
   *  recent `retry()` if one is running. Never rejects. Read `.settled` again
   *  after calling `retry()` to get the promise for that attempt; the one
   *  returned before `retry()` was called already resolved when the attempt
   *  it belonged to finished. */
  readonly settled: Promise<void>
  /** Reactive: null while healthy or in flight, the rejection reason once the
   *  action has failed and nothing has retried it yet. Calling `retry()`
   *  clears this back to null immediately, before the new attempt has
   *  settled — and if `retry()` is called again while an attempt is still
   *  running, only the most recently started attempt's outcome is ever
   *  reported here; a slower, superseded attempt settling later cannot
   *  overwrite it.
   *
   *  A failure here is also reported automatically to the nearest ambient
   *  `<Failed>` boundary — see `action()`'s own doc comment — so reading
   *  this accessor directly is only needed for code that wants to react to
   *  the failure somewhere other than that boundary's fallback. */
  readonly error: Accessor<unknown>
  /** Re-run the action's body from scratch. This is also what a `<Failed>`
   *  boundary's own retry calls, if this action auto-registered with one. */
  retry(): void
}

/**
 * Open a speculative child of the current scope and run `body` under it. Every
 * write inside is speculative until the action commits; a discard rolls them all
 * back. Nested actions parent to the enclosing scope, so their commit promotes to
 * it (two-stage).
 *
 * The body may take three shapes:
 *
 * - **Sync** — commits on return, discards on throw.
 *
 * - **Async** (`async () => …`) — the SYNCHRONOUS PREFIX runs under the scope, and
 *   the action commits or discards when the returned promise settles. This covers
 *   the common optimistic shape: write, then await the mutation.
 *
 *   SHARP EDGE: only the prefix is scoped. After the first `await` the async
 *   function returns to us, so the ambient scope unwinds; the continuation is
 *   scheduled by the engine in a later microtask, where the scope is back to root.
 *   A write made after an `await` therefore lands in COMMITTED state immediately —
 *   and the action's later commit can overwrite it. Use a generator body if you
 *   need to write after awaiting.
 *
 * - **Generator** (`function* () { … yield* read(p) … }`) — fully scoped. Pulse
 *   drives the resumption itself, so it re-enters the scope on every resume and a
 *   write after a `yield*` is still speculative. Commits when the body completes,
 *   discards when it throws.
 *
 * A failure in any shape never becomes a thrown or rejected value the caller has
 * to handle — it is captured and reported through the returned handle's `error`,
 * and `settled` resolves regardless of which way the attempt ended.
 *
 * A failure also registers itself with the nearest ambient `<Failed>` boundary
 * automatically, the same way a binding that reads a parked computed/signal
 * failure already does — no wiring needed at the call site. This only reaches a
 * boundary when `action()` is called from somewhere with an owner to walk from:
 * a component's render, or an `on:` event handler (which captures and restores
 * the owner it was bound under — see `bindProp` in `src/dom/bindings.ts`). Called
 * from somewhere with no owner at all, the action still runs and the returned
 * handle's `error`/`retry` are still usable directly; it just is not
 * auto-discovered by anything.
 */
export function action(body: () => Generator<unknown, void, unknown>): ActionHandle
export function action(body: () => Promise<void>): ActionHandle
export function action(body: () => void): ActionHandle
export function action(body: () => unknown): ActionHandle {
  const [error, setError] = makeErrorCell()
  // Every <Failed> between the calling owner and the nearest catchError (or
  // the root) — collected ONCE, at the moment action() is called, exactly
  // like the single-candidate version this replaces. Filtering by error
  // type needs the error itself to pick a winner, and the error does not
  // exist until an attempt later fails — so discovery still happens
  // eagerly, at call time, while the calling owner (e.g. a reference-keyed
  // row) is still guaranteed alive; only the PICK among these already-
  // collected candidates is deferred to failure time, and re-run on EVERY
  // failure, from scratch, against the whole candidate list — a retry can
  // fail with a different error type than the one that made an earlier
  // attempt's claim, and the nearest candidate that accepts THIS error is
  // not necessarily the one that accepted the last one; it could decline
  // now where it accepted before, or a nearer candidate could newly accept
  // where a farther one (most commonly the always-accepting implicit root)
  // had to settle for it before.
  //
  // action() never talks to catchError itself: the walk below stops,
  // unconditionally, the moment it reaches one, without checking its own
  // for and without invoking it — matching today's behaviour, where an
  // action failure with no <Failed> found is not routed anywhere either.
  const candidates = collectFailedCandidates(getOwner())
  let claimedCandidate: FailedCandidate | null = null
  let controller: BindingController | null = null
  // Which candidates already have their claim-released-on-dispose cleanup
  // installed. A candidate can be claimed, released (a later failure moves
  // on to a different one), and re-claimed by a further failure — the
  // cleanup from its first claim still covers every later one, since it
  // checks claimedCandidate at the moment it actually fires, not at
  // install time. Without this set, every re-claim would install another
  // cleanup for the same candidate — not wrong (each one checks the exact
  // same condition, so at most one of them ever does anything, on
  // whichever fires first), but an unbounded number of them pile up on
  // that owner's own cleanups across enough retries.
  const cleanupInstalledFor = new Set<FailedCandidate>()
  let currentSettled: Promise<void>
  // Bumped at the start of every attempt (the initial run and every retry).
  // Read back inside the settle handlers below to tell whether the attempt
  // that just settled is still the current one — a slower, superseded
  // attempt from an earlier retry() call must not overwrite error() with
  // its own outcome once a newer attempt has already reported its own.
  let generation = 0

  // A candidate accepts an error if its owner is still alive and its own
  // for, if any, returns true for it. Checking owner.disposed directly
  // (rather than a flag mirrored via a cleanup on every candidate) means
  // a candidate whose boundary already unmounted before action() ever
  // failed is correctly skipped with no bookkeeping installed for it at
  // all — the disposed-ness is the owner's own state, not this closure's.
  const accepts = (candidate: FailedCandidate, e: unknown): boolean =>
    !candidate.owner.disposed && (candidate.scope.for === undefined || candidate.scope.for(e))

  const runAttempt = (): Promise<void> => {
    const myGeneration = ++generation
    setError(null)
    const scope = createScope(getCurrentScope(), 'speculative')
    const attempt = isGeneratorFunction(body)
      ? driveGeneratorAction(scope, body as () => Generator<unknown, void, unknown>)
      : driveNonGeneratorAction(scope, body)
    return attempt.then(
      () => {
        if (myGeneration !== generation) return
        setError(null)
        // Succeeded — an action is one-shot, so once it has genuinely
        // succeeded there is nothing left for the boundary to keep tracking.
        controller?.report({ status: 'idle' })
        controller?.unregister()
        controller = null
        claimedCandidate = null
      },
      (e: unknown) => {
        if (myGeneration !== generation) return
        setError(e)
        // Re-picks the nearest accepting candidate on EVERY failure, not
        // only when the current claim declines — candidates is already
        // nearest-first (collectFailedCandidates' own walk order), so a
        // retry whose error a NEARER candidate now accepts must move
        // there too, even if the currently-claimed, farther candidate
        // would still accept it. Without this, once a farther candidate
        // (most commonly the always-accepting implicit root) claims one
        // failure, a nearer, filtered <Failed> could never win a later
        // retry back, since the always-accepting root never itself
        // declines. Mirrors findNearestFailedScope's own unconditional,
        // every-failure walk in effect.ts.
        const winner = candidates.find((c) => accepts(c, e)) ?? null
        if (winner !== claimedCandidate) {
          controller?.unregister()
          controller = null
          claimedCandidate = winner
          if (winner !== null && !cleanupInstalledFor.has(winner)) {
            cleanupInstalledFor.add(winner)
            // Safe to install lazily here specifically because accepts()
            // just confirmed the owner is not disposed. This is hygiene,
            // not correctness: accepts() already reads owner.disposed
            // directly on every failure, so a claimed candidate whose
            // boundary later unmounts is skipped on the next failure
            // regardless of this cleanup ever running. What this
            // releases is the controller's own registration in that
            // now-gone scope's collection, so it does not sit there
            // unregistered until something else disposes the scope.
            runWithOwner(winner.owner, () => {
              onCleanup(() => {
                if (claimedCandidate === winner) {
                  controller?.unregister()
                  controller = null
                  claimedCandidate = null
                }
              })
            })
          }
        }
        if (claimedCandidate !== null) {
          controller ??= claimedCandidate.scope.register()
          controller.report({ status: 'failed', error: e, source: null, retry })
        }
      },
    )
  }

  function retry(): void {
    currentSettled = runAttempt()
  }

  currentSettled = runAttempt()

  return {
    get settled() {
      return currentSettled
    },
    error,
    retry,
  }
}

interface FailedCandidate {
  readonly owner: Owner
  readonly scope: FailedScope
}

/** Walk up from `start`, collecting every `<Failed>` boundary in nearest-
 *  first order, stopping unconditionally at the first `catchError` (action()
 *  never reaches past one, and never invokes it — see action()'s own doc
 *  comment). Does not check any filter, or disposal, itself: both happen
 *  later, in action()'s own failure branch, once the error is known. */
function collectFailedCandidates(start: Owner | null): FailedCandidate[] {
  const candidates: FailedCandidate[] = []
  let owner = start
  while (owner !== null) {
    if (owner.boundaries.failed !== null) {
      candidates.push({ owner, scope: owner.boundaries.failed })
    }
    if (owner.errorHandler !== null) break
    owner = owner.parent
  }
  return candidates
}

/** Drive a sync or async (non-generator) action body: run it under `scope`, then
 *  commit on success or discard on failure — either way as a resolved promise
 *  the caller reads through `.then`, never a synchronous throw or a rejection
 *  the caller has to catch. */
function driveNonGeneratorAction(scope: Scope, body: () => unknown): Promise<void> {
  let result: unknown
  try {
    result = runInScope(scope, undefined, body)
  } catch (e) {
    discard(scope)
    return Promise.reject(e)
  }
  if (isPromise(result)) {
    return (result as Promise<unknown>).then(
      () => {
        commit(scope)
      },
      (e: unknown) => {
        discard(scope)
        throw e
      },
    )
  }
  commit(scope)
  return Promise.resolve()
}

/** Drive a generator action body. The await happens OUTSIDE the scope (nothing
 *  writes there); every resume happens INSIDE it, which is what keeps writes made
 *  after a `yield*` speculative. Deliberately not the stage driver: an action body
 *  is an imperative one-shot with side effects, not a memoized derivation, so it
 *  must never re-run from the top — `retry()` above achieves retry by calling
 *  `action()`'s whole flow again, fresh, not by resuming this generator. */
async function driveGeneratorAction(
  scope: Scope,
  body: () => Generator<unknown, void, unknown>,
): Promise<void> {
  try {
    const gen = runInScope(scope, undefined, body)
    let step = runInScope(scope, undefined, () => gen.next())
    while (!step.done) {
      let resumed: unknown
      let failure: unknown
      let failed = false
      try {
        resumed = await step.value
      } catch (e) {
        failed = true
        failure = e
      }
      step = runInScope(scope, undefined, () =>
        failed ? gen.throw(failure) : gen.next(resumed),
      )
    }
    commit(scope)
  } catch (e) {
    discard(scope)
    throw e
  }
}

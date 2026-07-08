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

/** A per-(Node, scope) cache cell. Uniform shape per Q9 — no `wasWritten` flag. */
export interface Slot<T = unknown> {
  recipe: (() => T | Promise<T>) | undefined
  cached: T | undefined
  deps: Edge[]
}

/** A subscription edge. Engine-managed chains (Q1 Model 1): plain source/target
 *  plus the scope the target lives in; the chain is derived at fire time. */
export interface Edge {
  source: Node
  target: Slot
  targetScope: Scope
}

export type ScopeKind = 'owner' | 'speculative'

/** The ambient context primitive. Owns its slots/edges/sets/cleanups. Per Q6. */
export interface Scope {
  parent: Scope | undefined
  children: Set<Scope>
  slots: Map<Node, Slot>
  edges: Set<Edge>
  writeSet: Set<Node>
  readSet: Set<Node>
  cleanups: Array<() => void>
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
    if (slot.cached === undefined && slot.recipe !== undefined) {
      resetSlotDeps(slot)
      slot.cached = runRecipe(slot.recipe, scope, slot) // dirtied → recompute
    }
    // record a dep edge into the currently-computing slot (Q8 tracker)
    trackRead(node, scope)
    return slot.cached as T
  }
  if (scope !== ROOT_SCOPE && node.defaultRecipe !== undefined) {
    // speculative computed miss: run the recipe into a fresh S-slot
    const newSlot: Slot<T> = { recipe: node.defaultRecipe, cached: undefined, deps: [] }
    writeSlot(node, scope, newSlot)
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

/** Speculative write: install a slot in `scope`, then mark every matching
 *  downstream speculative slot dirty (drop cached) so the next read recomputes
 *  (pull). Synchronous dirty-marking honors K1 Position C. */
function writeSpeculative<T>(node: Node<T>, scope: Scope, value: T): void {
  writeSlot(node, scope, { recipe: () => value, cached: value, deps: [] })
  for (const edge of edgesToFire(node, scope)) {
    edge.target.cached = undefined
  }
}

/** Commit a scope (ADR 0010 order): snapshot the writeSet's promoted values
 *  (before closeScopeEdges clears writeSet + drops slots), tear down the
 *  scope's pulse edges (edges-down-before-promote → no double-fire), then
 *  promote to the parent. Promoting to ROOT_SCOPE bridges to r3 via setSignal
 *  + a single stabilize (r3's InHeap-deduped heap gives Q10 batching). A
 *  speculative parent (nested actions) receives the value as a parent slot. */
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
    stabilize()
  } else {
    for (const { node, value } of promotions) {
      writeSpeculative(node, parent, value)
    }
  }
  scope.status = 'committed'
}

/** Discard a scope: tear down edges + drop slots (no promotion), then fire
 *  cleanups in LIFO order. Speculative writes simply vanish. */
export function discard(scope: Scope): void {
  closeScopeEdges(scope)
  for (let i = scope.cleanups.length - 1; i >= 0; i--) scope.cleanups[i]()
  scope.cleanups.length = 0
  scope.status = 'discarded'
}

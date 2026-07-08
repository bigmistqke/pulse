/** Graph identity wrapping a recipe. Value is not in the Node — it is produced
 *  by handing the Node to a read walk. Per Q6. */
export interface Node<T = unknown> {
  /** Optional recipe: present ⇒ computed (run-and-isolate on read); absent ⇒
   *  signal (fall-through leaf read). Per Q7. */
  defaultRecipe?: () => T | Promise<T>
  /** Who subscribes to me — the fast write-fire index. */
  subs: Set<Edge>
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

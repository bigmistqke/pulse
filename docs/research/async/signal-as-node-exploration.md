# Signal-as-Node exploration

**Status.** Branch-local exploration on `signal-as-node`. Not committed to `main`.
We have limited knowledge; this doc is *question-mapping*, not route-deciding.
The framings recorded here are durable as directions to push on; the
implementation sketches are illustrative, not designs.

**Origin.** 2026-05-23 brainstorming session on Q1 (locus of speculative state)
from [`pulse-design-direction.md`](./pulse-design-direction.md). The session
falsified one hypothesis (speculation purely above unmodified r3) and surfaced a
richer framing — *signals as graph relations, not values* — worth recording for
future exploration before either committing to a route or dropping the thread.

**Relationship to main-branch direction.** This exploration leans into Q1's
"(β) — open walks over a smaller core." P1–P5 from the main doc hold; the
framings here refine them but don't replace. D1–D12 (the working sketches in
the main doc) need re-pressure-testing once we know more about this stack.

---

## What we're exploring, in one paragraph

Pulse's user-facing `Signal<T>` and `Computed<T>` are **graph relations, not
values** — `Node<() => T | Promise<T>>`, an identity in the dep graph wrapping a
recipe (a callback that produces the value). The value is not *in* the Node; it
is what you get by handing the Node to a *walk* primitive. The library ships
named patterns and named walks (`signal`, `computed`, `effect`, `read`, `peek`,
`latest`, `use`, `isPending`, `subscribe`) as approachable DX over a slim engine
that knows only about graph, slots, recipes, edges, and notification. Users
who want their own semantics over the graph can reach the engine; the default
surface stays approachable. Speculation is one *use* of this stack — scope-tagged
slots, walk policies that consult them — not a built-in engine concept.

---

## Framings (adopted provisionally)

These are durable as *directions to push on*, not as locked-in design positions.
Each is a way of seeing the problem that earned its keep during the exploration;
each can be revised if a later finding falsifies it.

### Signals and computeds are graph relations, not values

A `Signal<T>` (and `Computed<T>`) is `Node<() => T | Promise<T>>` — a stable
identity in the dep graph wrapping a recipe. The value is what you get by
handing the Node to a walk. Putting `.value`, `.peek()`, `.latest()`, or any
value-producing method on the Node would re-couple identity and value through
syntax — so the strictness extends to: the Node has no value-producing methods
or properties at all. *The signal IS the relation; the value is queried from
outside via walks.*

### Walks are first-class

Reads are not implicit "call the signal." They are explicit applications of a
walk primitive (`read`, `peek`, `latest`, `use`, `isPending`, `subscribe`, …) to
a relation. The walks *are* the user-visible surface of the engine's value-bag —
the bag is observed only through walks, never by "the signal's value." This
makes "how to read" a first-class verb the user composes, rather than a fixed
semantic baked into the signal.

### Async is honest in the type

The recipe is `() => T | Promise<T>`; a fully-sync pipeline has no `Promise`;
walks decide how to handle the async case (return-the-Promise, suspend-and-
resume, throw-to-restart). Connects directly to main-doc P2 ("acknowledge async,
don't hide it").

### Signal / Computed / Effect / JSX-expression are all the same primitive

All four are `Node<() => T>`. What differs is their *connection pattern*:

- **Signal** — recipe is replaceable via a setter; the initial recipe is
  `() => initial`; setters install new recipes per-slot (tagged with the
  current ambient scope, which by library convention is a root scope when no
  action is active).
- **Computed** — recipe is fixed at creation; reads other Nodes via walks;
  engine caches its result per scope; downstream Nodes subscribe.
- **JSX expression** — recipe is fixed at creation; consumer is the DOM
  renderer, which walks the recipe when its deps change.
- **Effect** — recipe is fixed at creation; consumer is the effect scheduler,
  which schedules re-runs on dep-change.

The "graph" isn't a separate thing — it's the *implicit structure of
who-walks-whom*; edges form when a recipe walks another Node.

### Slim engine, thick library — engine resolution is open

The library ships an approachable surface — named patterns over a generic core.
Users get familiar DX (`const [name, setName] = signal("foo")`,
`computed(() => …)`, `read(node)`) without seeing engine internals. *But the
engine is reachable* — a user (or library author building on pulse) can drop
down and define their own semantics over the graph. Custom walks, custom edge
metadata, custom scope shapes — all expressible in user code without engine
changes. This is the user-stated principle: *the goal is not complex DX; the
goal is to give users the option to add their own ideas of what this graph
resolves to.*

### Slot writes and recomputes are the same operation

Setters and engine-driven recomputes both *write a slot with a recipe*. The
engine doesn't need separate `setSignal` and `recompute` primitives — just
`writeSlot`. The library calls it from user setters; the scheduler calls it from
its recompute logic. The privileged status of user-initiated writes dissolves.

### Edges are slot-local, dynamic, and walk-policy-driven

Edges live on *slots*, not Nodes. Each (Node, Scope) slot has its own incoming
and outgoing edge lists; a recompute rebuilds the slot's `deps` from scratch;
discarding a slot cascades its edges away. The selector for "which source slots
fire which target slots" is *walk-defined* (engine routes notifications through
the selector), so fall-through semantics, scope-aware subscription, latest-only
subscription, and other policies are library code over a uniform edge mechanism.

### Scope and Owner share structure (unification under exploration)

A scope (for speculation) and an owner (for disposal/lifecycle) are both
ambient hierarchical contexts. They share: nestability, identity, lifecycle
(open and close), composability. The differences are subset-relations:
**Owner ≈ scope without slot-tagging; Speculation ≈ scope with slot-tagging and
a meaningful commit operation.** Working hypothesis: one ambient primitive, with
different library patterns over it. Cancellation falls out naturally — discard
the scope, registered cleanups fire. Supersession falls out naturally —
discard old scope, open new one. The old wondering in
[`pulse-design-direction.md`'s Sketch section](./pulse-design-direction.md)
hedged toward keeping them separate; revisiting that hedge here.

---

## Falsified hypotheses

Record so we don't re-derive.

### Speculation purely above unmodified r3 doesn't work

**Hypothesis tried:** r3 (or any unmodified single-slot reactive substrate) sees
only committed state; speculation lives entirely above r3 in a pulse-level bag
(`Map<PulseNode, ScopeTaggedEntries>`); walks consult the bag first, fall
through to r3 for committed.

**Concrete failure case.** Inside an action scope `S`:

```ts
const [name, setName] = signal("foo")
const doubleName = computed(() => read(name) + read(name))

action(function* () {
  setName("name")
  console.log(read(doubleName))   // expected: "namename"
})
```

If `setName("name")` only writes pulse's bag entry tagged with `S` (without
touching r3), then `doubleName`'s r3-level cached value remains `"foofoo"` from
its last committed-context recompute. r3 has no idea `S` exists; it doesn't
invalidate `doubleName`. `read(doubleName)` under `S` returns the stale cached
value. **Wrong.**

**Why.** `doubleName`'s cache must be scope-aware. The cache is engine-level
(it's the recipe's output); scope-awareness of the cache is therefore an
engine-level concern. Speculation cannot be "purely above" a single-slot
engine.

**Resolution.** The engine needs multi-slot per Node. This is structurally
Solid 2.x's per-node multi-slot architecture (which Solid arrived at empirically
after abandoning node-graph-cloning — see
[`pulse-design-direction.md`'s historical-data-point section](./pulse-design-direction.md)).
Pulse's user-facing novelty (Node-as-recipe + walks) is preserved; the engine
internals converge on per-node multi-slot. **The smaller core in Q1's (β) lean
is not "r3 unchanged"** — it's r3 forked-and-extended (or a pulse-owned engine
descended from r3).

### `.value` / `.peek()` / `.latest()` as methods on the Node would survive without smuggling

**Tried.** "A method on the Node that queries the bag, like `node.value`,
preserves the framing because the value isn't *stored* on the Node — the method
just looks it up."

**Why it doesn't.** Even a getter that internally queries the bag asserts "the
signal has a value" through syntax. Users would read `node.value` and form the
intuition that signal = value; the relation/value separation is gone in
practice even if the implementation isn't literally storing the value on the
Node. So: **no value-producing methods or properties on the Node** — strict.
The only path from Node to value is through an externally-applied walk.

---

## Engine API sketch (illustrative)

The shape, not a design. Roughly the minimum-viable surface after dissolving
hardcoded semantics. The engine's job is graph + slot storage + recipe
invocation + change notification; everything else (read semantics, write
semantics, dep meaning, consumer pattern) is library code.

```ts
// ── Engine: types ─────────────────────────────────────────────

type Scope = unknown                              // opaque; library/user defines

interface Slot<T> {
  recipe: () => T | Promise<T>                    // what produces the value
  cached?: T | Promise<T>                          // engine-managed cache
  deps: Edge[]                                     // incoming: source slots I was computed against
  subs: Edge[]                                     // outgoing: target slots that depend on me
}

interface Node<T> {
  slots: Map<Scope, Slot<T>>                      // engine sees scope→slot uniformly; no privileged key
  defaultRecipe?: () => T | Promise<T>             // fallback when a scope has no slot
}

interface Edge {
  source: Node<unknown>
  sourceSelector: SlotSelector                    // walk-defined: which source slots fire me?
  target: Slot<unknown>
}

type SlotSelector = (
  slots: Map<Scope, Slot<unknown>>,
  writeScope: Scope,
) => boolean

// ── Engine: primitives ────────────────────────────────────────

function createNode<T>(defaultRecipe?: () => T | Promise<T>): Node<T>
function writeSlot<T>(node: Node<T>, scope: Scope, slot: Slot<T>): void
function readSlot<T>(node: Node<T>, scope: Scope): Slot<T> | undefined
function invoke<T>(node: Node<T>, scope: Scope): T | Promise<T>
function link(source: Node<unknown>, selector: SlotSelector, target: Slot<unknown>): Edge
function unlink(edge: Edge): void
function subscribe(node: Node<unknown>, handler: (e: SlotChangeEvent) => void): () => void

// ── Engine: ambient context ───────────────────────────────────

function openScope(): Scope                       // creates child of current
function closeScope(scope: Scope, mode: 'commit' | 'discard'): void
function onCleanup(fn: Disposable): void          // attaches to current ambient scope
function getCurrentScope(): Scope                 // always returns a scope (library convention; see ROOT_SCOPE below)
```

No `signal`, `computed`, `effect`, `read`, `latest`, `action`, `transition`,
`speculation`, "canonical," or "committed" in the engine vocabulary. The engine
sees a map of opaque scope keys to slots, uniformly. Those concepts are all
library code.

## Library shape (illustrative)

```ts
// Library convention: a singleton "root scope" stands in for
// "outside any speculative context." The engine doesn't know this
// is special — it's just a scope key the library uses by default.
const ROOT_SCOPE: Scope = Symbol("root")

function signal<T>(initial: T): [Node<T>, (v: T) => void] {
  const node = createNode<T>(() => initial)
  return [
    node,
    (v) => writeSlot(node, getCurrentScope(), { recipe: () => v, deps: [], subs: [] }),
  ]
}

function computed<T>(fn: () => T): Node<T> {
  return createNode<T>(fn)
}

function read<T>(node: Node<T>): T {
  const scope = getCurrentScope()
  if (currentTracker) link(node, chainSelector(chainFor(scope)), currentTracker)
  return invoke(node, scope) as T
}

function latest<T>(node: Node<T>): T {
  return invoke(node, ROOT_SCOPE) as T              // bypass any active speculation
}

function action(body): ActionHandle {
  const scope = openScope()
  try {
    runUnderScope(scope, body)
    closeScope(scope, 'commit')
  } catch (err) {
    closeScope(scope, 'discard')
    throw err
  }
}

// chainFor(S) returns the scope chain from most-specific to root:
//   chainFor(S2) where S2 is child of S1 (which is child of ROOT_SCOPE) → [S2, S1, ROOT_SCOPE]
//   chainFor(ROOT_SCOPE) → [ROOT_SCOPE]
// `getCurrentScope()` returns ROOT_SCOPE when no action is active.
```

The engine never sees `ROOT_SCOPE` specially — it's just a `Symbol` the library
chose to use as the "outside any action" key. A library author defining a
different convention (per-tenant roots, per-document roots, multiple
independent reactive worlds) substitutes their own scope shape; the engine
doesn't care.

Usage retains familiar shape:

```ts
const [name, setName] = signal("foo")
const doubleName = computed(() => read(name) + read(name))

read(name)         // "foo"
read(doubleName)   // "foofoo"
setName("bar")
read(name)         // "bar"
read(doubleName)   // "barbar"

action(function* () {
  setName("name")
  console.log(read(doubleName))    // "namename" — slots resolve under the active scope
})
read(name)         // "bar" — committed unchanged outside the scope
```

---

## End-to-end trace: `doubleName` under scope `S`

A worked trace verifying that **multi-slot + Model 2 (selector-on-edge)**
handles the case the [falsified hypothesis](#speculation-purely-above-unmodified-r3-doesnt-work)
broke on. Walks every engine call and every state change.

### Setup

```ts
const [name, setName] = signal("foo")
const doubleName = computed(() => read(name) + read(name))
```

- `signal("foo")` → library calls `createNode<string>(() => "foo")` → engine
  creates Node `name`. Returns `[name, setName]` where
  `setName = (v) => writeSlot(name, getCurrentScope(), { recipe: () => v, deps: [], subs: [] })`.
- `computed(fn)` → library calls `createNode<string>(fn)` → engine creates
  Node `doubleName`. Returns the Node.

**State.** Both Nodes have empty `slots`. No edges. No reads have happened yet.

### Step 1: `read(doubleName)` outside any action

- Library: `getCurrentScope()` → `ROOT_SCOPE` (library default). `currentTracker`
  is null. `invoke(doubleName, ROOT_SCOPE)`.
- Engine: `doubleName.slots.get(ROOT_SCOPE)` → miss. Create slot `slot_DN_R`,
  push `currentTracker = slot_DN_R`, invoke `defaultRecipe`.
  - Recipe body: `read(name) + read(name)`.
  - First `read(name)`: library `link(name, chainSelector([ROOT_SCOPE]), slot_DN_R)`
    → engine creates `edge1`. Then `invoke(name, ROOT_SCOPE)` → miss, create
    `slot_N_R` with recipe `() => "foo"`, cache `"foo"`, return.
  - Second `read(name)`: cached hit, returns `"foo"`. `link` dedupes.
  - Body returns `"foofoo"`. Cache. Pop currentTracker.
- Returns `"foofoo"`. ✓

**State after Step 1:**
```
name.slots       = { ROOT_SCOPE: cached "foo",     subs: [edge1] }
doubleName.slots = { ROOT_SCOPE: cached "foofoo",  deps: [edge1] }
edge1 = { source: name, selector: chainSelector([ROOT_SCOPE]), target: doubleName.slots[ROOT_SCOPE] }
```

### Step 2: `action(function* () { … })` opens scope `S`

Library `openScope()` → engine creates `S = { parent: ROOT_SCOPE, cleanups: [],
status: 'open' }`. Ambient scope is now `S`.

### Step 3: `setName("name")` inside the action

- Library: `getCurrentScope()` → `S`. Calls
  `writeSlot(name, S, { recipe: () => "name", … })`.
- Engine: walk `name`'s outgoing edges with selectors:
  - `edge1.sourceSelector(name.slots, S)`: `chainSelector([ROOT_SCOPE])` →
    `S` not in chain → **don't fire.** ✓ Committed state untouched.
- Set `name.slots[S]` = the new slot.

**The falsified case.** Under unmodified r3, `setName` would have walked
`name.subs` and fired the only edge → invalidating `doubleName`'s committed
cache → corrupting committed state. Under multi-slot + selectors: the edge
correctly stays inert; committed state preserved.

### Step 4: `read(doubleName)` inside the action

- Library: `getCurrentScope()` → `S`. `currentTracker` null (action-body reads
  are imperative — see [open question](#open-questions-from-the-trace) below).
  `invoke(doubleName, S)`.
- Engine: `doubleName.slots.get(S)` → miss. Create `slot_DN_S`, push
  `currentTracker = slot_DN_S`, invoke `defaultRecipe`.
  - Recipe body: `read(name) + read(name)`.
  - First `read(name)`: library
    `link(name, chainSelector([S, ROOT_SCOPE]), slot_DN_S)` →
    engine creates `edge2`. Then `invoke(name, S)` → `name.slots[S]` hit,
    return `"name"`.
  - Second `read(name)`: cached hit, returns `"name"`. `link` dedupes.
  - Body returns `"namename"`. Cache. Pop.
- Returns `"namename"`. ✓

**State after Step 4:**
```
name.slots = {
  ROOT_SCOPE: cached "foo",  subs: [edge1],
  S:          cached "name", subs: [edge2],
}
doubleName.slots = {
  ROOT_SCOPE: cached "foofoo",   deps: [edge1],
  S:          cached "namename", deps: [edge2],
}
edge1 = { ..., chainSelector([ROOT_SCOPE]),    → doubleName.slots[ROOT_SCOPE] }
edge2 = { ..., chainSelector([S, ROOT_SCOPE]), → doubleName.slots[S] }
```

### Step 5a: action returns → `closeScope(S, 'commit')`

Commit semantics: for each Node with a slot tagged `S`, **promote that slot to
`ROOT_SCOPE`** (move its `recipe` + `cached`), then drop the `S` slot.

Sketched order: dep-order, leaves-first. Gather `[(name, S), (doubleName, S)]`.
`name` first; `doubleName` after.

**Promote `name`:** `writeSlot(name, ROOT_SCOPE, { recipe: () => "name",
cached: "name", … })`.
- Engine fires:
  - `edge1`: `chainSelector([ROOT_SCOPE])`, writeScope=ROOT_SCOPE, writeIdx=0 →
    **fire.** Invalidate `doubleName.slots[ROOT_SCOPE]`.
  - `edge2`: `chainSelector([S, ROOT_SCOPE])`, writeScope=ROOT_SCOPE,
    writeIdx=1. More-specific check: `name.slots.has(S)`? At this moment yes
    (we haven't dropped it) → **don't fire.** ✓

**Drop `name.slots[S]`:** walk `slot_N_S.subs = [edge2]`; unlink `edge2` from
`name`'s outgoing index and from `slot_DN_S.deps`. Delete the slot.

**Promote `doubleName`:** `writeSlot(doubleName, ROOT_SCOPE, { recipe:
defaultRecipe, cached: "namename", deps: [], … })`. Engine fires
`doubleName`'s outgoing edges (none here). The invalidation from `edge1` is
overwritten by this write — final cached value `"namename"`. ✓

**Drop `doubleName.slots[S]`:** `subs` empty; delete.

**Close scope:** `S.status = 'committed'`. Cleanups don't fire on commit
(library convention).

**State after Step 5a:**
```
name.slots       = { ROOT_SCOPE: cached "name" }
doubleName.slots = { ROOT_SCOPE: cached "namename" }
edge1 unchanged. edge2 unlinked.
```

`read(doubleName)` after commit: cached `"namename"`. ✓

### Step 5b: action throws → `closeScope(S, 'discard')`

Alternative: action body throws.
- Engine: drop every `S`-tagged slot. Walk each dropped slot's `subs`, unlink
  edges. Fire cleanups registered against `S` (none in this trace; would be
  `onCleanup(…)` calls from the action body, e.g. AbortController.abort()).
- Engine: `S.status = 'discarded'`.

**State after Step 5b:** identical to State after Step 1 (committed state never
observed the speculation). ✓

`read(doubleName)` after discard: cached `"foofoo"`. ✓

### Open questions from the trace

The architecture works for this case, but the trace exposed several
under-specified edges. Listed in roughly load-bearing order:

1. **Commit ordering matters.** Promoting `name` before `doubleName` works
   because `edge2`'s selector correctly doesn't fire while `name.slots[S]`
   still exists. Other orders (or dropping `S` slots before writing
   `ROOT_SCOPE`) can fire selectors wrongly. The library's commit logic needs
   a defined order (likely dep-order leaves-first).
2. **What `cached` does a promoted slot carry?** Three options: (a) preserve
   cached + carry over deps (but old deps had chain-S selectors); (b) preserve
   cached + drop deps (next recompute rebuilds); (c) drop cached + force
   recompute. Lean (b); related to Q-G.
3. **Action body reads: do they track?** The trace assumed `currentTracker =
   null` for top-level reads inside an action body (imperative, not
   declarative — the action body doesn't re-run on dep change). Probably
   correct but worth being explicit. Related to Q-B (scope/owner) and Q-H
   (tracker/scope).
4. **Edge index location.** The trace shows edges in `slot.subs` for clarity,
   but in practice the engine probably maintains a per-Node outgoing-edges
   index (selectors do per-slot dispatch at fire time). Per-slot `subs` arrays
   are useful for cleanup-on-slot-drop, but the firing path likely iterates
   per-Node. Fold into Q-A.
5. **Selector dedup.** `link(name, chainSelector([S, ROOT_SCOPE]), tgt)` is
   called twice in the recipe; the second should be a no-op. Selector identity
   matters — naive `chainSelector([S, ROOT_SCOPE])` returns a fresh function
   each time. Library-side memoisation of selectors by chain content handles
   it. Fold into Q-A.
6. **Late subscribers / new edges mid-action.** The trace didn't exercise a
   subscriber arriving mid-action and reading under `S` (e.g., a component
   mounting inside an action). Model 2 should handle it (new edges form with
   the right chain at subscription time), but worth a separate trace.
7. **Async (Q-D) untouched.** All reads in this trace were sync. The async
   case — `name`'s recipe returns a `Promise<T>`, or the action body awaits —
   needs its own trace.
8. **Dangling-ref window during commit ordering.** When `edge2` is unlinked
   from `name`'s outgoing index, `slot_DN_S.deps` still briefly references it
   from the target side. By Step 5a's end, the edge is fully unlinked, but
   the ordering needs verification.

Verification summary: **the falsified hypothesis is genuinely fixed** by
multi-slot + Model 2 selectors. The trace exposed eight follow-up sub-
questions, none of which gate the architecture — they're next-level
resolution.

---

## Open questions (the actual mapping work)

Each is open. The goal is to *map the question space* before committing to any
route. Several questions are interrelated; their connections are noted.

### Q-A — Fall-through and edge policy

Status: working candidate framing identified (Model 2 — selector-on-edge). Not
locked in; sub-questions remain open at the next level down.

**The break, traced concretely.** With `name`, `doubleName = computed(() =>
read(name) + read(name))`, and the initial outside-action `read(doubleName)`
populating `doubleName.slots[ROOT_SCOPE] = "foofoo"` plus an edge
`name.slots[ROOT_SCOPE] → doubleName.slots[ROOT_SCOPE]` (using the library's
convention that "outside any action" uses `ROOT_SCOPE` as the scope key):

```ts
action(function* () {
  // Inside scope S. name.slots[S] doesn't exist; doubleName.slots[S] doesn't exist.
  read(doubleName)
  //   - doubleName.slots[S] miss → populate: invoke defaultRecipe under S.
  //   - Recipe runs. read(name) under S → name.slots[S] miss → walk falls
  //     through to name.slots[ROOT_SCOPE] → "foo". Twice → "foofoo".
  //   - Cache in doubleName.slots[S]. Register edge — ↓ THE QUESTION ↓:
  //       (Model 1) source slot: name.slots[ROOT_SCOPE] → target: doubleName.slots[S]
  //       (Model 2) source Node: name with SELECTOR over chain [S, ROOT_SCOPE]
  //                 target: doubleName.slots[S]
  setName("name")
  //   - writeSlot(name, S, …) — creates name.slots[S].
  //   - Model 1: the edge points at slots[ROOT_SCOPE]; the write was to
  //     slots[S]; no match. doubleName.slots[S] stays cached "foofoo". WRONG.
  //   - Model 2: the edge's selector matches writes to S in its chain.
  //     Fires. doubleName.slots[S] invalidates. RIGHT.
})
```

Simple slot-to-slot edges (Model 1 as-stated) cannot handle the fall-through
case. Either the engine has to do something at slot-creation time (re-link), or
edges have to be richer than direct slot pointers (selectors). Note: neither
"ROOT_SCOPE" nor "fall-through" is an engine concept — both live in walks. The
chain is just a list of scope keys the walk traversed; the engine sees opaque
keys uniformly.

**Two candidate models.**

*Model 1 — Re-link on slot creation.* Edges are simple slot-to-slot pointers.
When `writeSlot(node, S, slot)` creates a new slot, the engine walks an index of
edges from `node` whose target scope is `S` or a descendant, and re-links any
whose current source slot is at a less-specific position than `S` in the
target's chain. Then invalidates affected targets.

```ts
interface Edge { source: Slot; target: Slot }
// On writeSlot(node, S, ...):
//   walk an index (source Node, target scope) → edges
//   re-link edges whose source is now superseded by the new slot
//   invalidate targets
```

Trade-offs: simple edge structure; *engine has to know about chains* to do the
re-link correctly (or accept a callback from the walk for "is this scope more
specific than that one for this edge's purposes?"); cost amortised on slot
creation (rarer than slot writes); no clean extension path for non-fall-through
policies (latest, scope-only, custom) without engine changes or more callbacks.

*Model 2 — Selector-on-edge.* Edges store a *selector function* — a walk-defined
predicate that decides whether a write matches. The engine queries selectors on
every write to the source Node.

```ts
interface Edge {
  source: Node                              // not slot — the policy decides
  target: Slot
  fires: (sourceSlots, writeScope) => boolean
}
// On writeSlot(node, S, ...):
//   walk node.edges
//   for each: if edge.fires(node.slots, S) → invalidate edge.target
```

A library ships the common selectors:

```ts
// "Read with this chain; fire when the chain's effective resolution
// would change." The chain is library-provided; the engine sees a
// list of opaque scope keys.
function chainSelector(chain: Scope[]) {
  return (slots: Map<Scope, Slot<unknown>>, writeScope: Scope): boolean => {
    const writeIdx = chain.indexOf(writeScope)
    if (writeIdx === -1) return false
    // Fire only if no more-specific scope in the chain currently has a slot.
    for (let i = 0; i < writeIdx; i++) {
      if (slots.has(chain[i])) return false
    }
    return true
  }
}

// "Only fire on writes to ROOT_SCOPE." (Library convention: e.g. for
// `latest()` reads. ROOT_SCOPE is a library-side constant; the engine
// just sees a particular Scope value.)
function rootOnlySelector() {
  return (_slots, writeScope) => writeScope === ROOT_SCOPE
}

// "Only fire on this exact scope; no fall-through."
function scopeOnlySelector(s: Scope) {
  return (_slots, writeScope) => writeScope === s
}
```

Trade-offs: engine knows nothing about chain semantics — selectors are opaque
predicates; extensible to arbitrary new walks without engine changes; cost is
per-write per-edge function call (same big-O as today's "walk subs," with a
constant-factor bump); edges stay valid across slot creation/destruction
(selectors re-evaluate against current state every time, so no slot-lifecycle
bookkeeping pressure on the edge structure).

**Lean: Model 2.** Reasons:

1. *In the spirit of "engine resolution is open"* — policies live in walks, not
   in engine.
2. *Slot lifecycle and edge correctness decouple* — slots come and go without
   needing the engine to rebuild edges.
3. *Custom walks compose without engine extension* — `latest`, scope-only,
   "snapshot-at-time-T," "subscribe-to-root-only," "fire-on-any-change"
   are all selectors; new walks ship their own selector.
4. *The cost is acceptable* — same big-O as r3's existing sub-walking, with a
   constant-factor bump for the function call. r3 was already paying O(subs) on
   every set; Model 2 keeps the bound.

**Commit / discard paths trace cleanly under Model 2.**

- *Commit `S`.* Slots tagged `S` get promoted (the library does
  `writeSlot(node, ROOT_SCOPE, ...)` for each, then drops the slot at `S`).
  Each promotion is a write to `ROOT_SCOPE`, which fires selectors that care
  about `ROOT_SCOPE` (e.g. the chain selector `[S, ROOT_SCOPE]` after the
  scope-`S` slot is dropped: writeScope is `ROOT_SCOPE`, chain index is 1, no
  more-specific slot exists → fire). Downstream computeds invalidate, recompute
  on next read against the now-current state.
- *Discard `S`.* Drop slots tagged `S`. Edges into those dropped slots also drop
  (slots own their incoming edges; cascade-removed). Downstream readers outside
  `S` are untouched — their selectors don't match writes-to-`S`. No spurious
  invalidation. ✓
- *Supersession.* Discard old scope; open new scope. Above logic handles it.

**Sub-questions still open at the next level down.**

These don't gate the architecture; they're what's left after picking the
framing:

- *Indexing.* Naive Model 2 calls every edge's selector on every write to the
  source. For a hot Node with many subscribers, this is expensive. An index
  (e.g., bucket edges by "what scopes does my selector care about") could cut
  the work. But indexing pushes some knowledge back into the engine — either
  selectors expose a "what scopes do I care about" hint that the engine indexes
  by, or selectors are opaque and the engine pays the linear cost. Both are
  viable; perf measurements would decide.
- *Selector parameter shape.* The sketch above is `(sourceSlots, writeScope) =>
  boolean`. Should it also carry: the specific slot being written (not just
  the scope), the previous slot value (for change-detection), the target slot
  (so the selector can branch on target context)? Each addition is
  power-vs-complexity. Likely minimal start.
- *Edge identity across recomputes.* Each recompute rebuilds `deps`, so new
  edges are formed. Are selector *functions* re-created or cached? Memoising
  selectors (`chainSelector([S, ROOT_SCOPE])`) is library-side optimisation if
  it matters. Engine doesn't care.
- *Dropped-slot races.* If a write fires an edge whose target slot has been
  dropped (e.g., scope discard happened between write and notification),
  engine has to detect and skip. Lazy-prune-on-iteration is the natural answer.
  Standard reactive bookkeeping.
- *Async writes (Q-D interaction).* A slot's `cached` may be a Promise that
  resolves later. Does the resolution count as a "write" that fires edges?
  Probably yes (the slot's effective value changed); but the engine needs to
  know to fire on resolution. The selector itself doesn't change — it still
  fires on writes to the slot's scope — but the *engine's notion of "a write
  happened"* has to include the Promise-resolution event.

**Related:** Q-C (consumers subscribe via the same selector mechanism; consumer
notification IS a "fire an edge" event whose target is a side-effect handler
instead of a cache invalidation), Q-G (`defaultRecipe` is a similar engine-vs-
walk question at a different level), Q-D (async resolution as a "write" event).

### Q-B — Scope/Owner unification

Working hypothesis: one ambient context primitive with `cleanups` + a `mode` at
close time (`'commit' | 'discard'`). Owner = scope used without slot-tagging;
speculation = scope used with slot-tagging.

Open sub-questions:

- *Are scope identities first-class?* Can users grab a scope handle and pass it
  around, or are scopes only manipulable through library helpers (`action`,
  `createRoot`)?
- *What is a scope as a value?* Symbol, plain object with identity, frame
  object that holds nesting + cleanups, extensible "kind" (per-application
  custom scopes)?
- *How does `commit` interact with cleanups?* Working assumption: cleanups fire
  on discard, not on commit (a successful action's long-lived resources keep
  living after commit). Is there a separate `onCommit(fn)` hook, or is
  post-commit work always expressed through the body's return value?
- *Does a computed's tracker need to be a separate ambient context, or is it the
  same context-handle as the scope?* (Tracker = "currently-recomputing slot,
  register reads to me." Currently sketched as a separate `currentTracker`
  variable.)

**Related:** Q-C (effects register cleanups; whether a scope-with-effects has
different lifecycle from a scope-with-just-state), Q2 in main doc (cancellation
discipline — likely falls out of scope-discard).

### Q-C — Consumer patterns

`Computed` (cache invalidation), `Effect` (re-run scheduling), `JSX-binding`
(DOM update scheduling) are all *consumers* — they subscribe to slot changes and
react. The library expresses each over the engine's `subscribe` primitive, but:

- *Common shape vs separate code?* Is there a single "consumer pattern"
  abstraction (`createConsumer({ onSlotChange })`) that all three build on, or
  is each its own bespoke library code with shared utilities?
- *Where does dirty propagation live?* Computeds propagate dirty downstream so
  that *their* subs invalidate too. That's a behavior of the consumer pattern
  for Computed, not a fixed engine feature. But it's load-bearing — without it,
  invalidation doesn't transitively reach further-downstream subs.
- *Effects under speculation.* Should a speculative scope's writes trigger
  effects during the action, or defer until commit/discard? Three positions:
  (a) defer all triggered effects until commit (and drop on discard);
  (b) run under the scope's read-policy and roll back on discard;
  (c) refuse to trigger speculative effects; require explicit opt-in.
- *Is the JSX-binding consumer the same shape as Effect, just with a different
  body?* Probably; worth confirming.

**Related:** Q-A (consumers subscribe via edges or via `subscribe`; the
selector question recurs), Q-E (async recipes interact with consumer's re-run
discipline).

### Q-D — Async at the engine level

The recipe is `() => T | Promise<T>`. The engine sees Promises in `cached`. Per
P2 (acknowledge async), walks decide how to handle them. But the engine has
choices:

- *Does the engine `await` internally, or just hand the Promise to walks?*
  Likely the latter — engine treats the Promise as an opaque value flowing
  through the cache; walks know what to do (return it, suspend on it, throw
  to restart).
- *When a Promise resolves, what happens?* If a slot's cached value is a Promise
  that resolves to `T`, does the slot's `cached` get updated to `T`? Does that
  count as a "slot change" that fires subs? Probably yes — and that's how a
  computed-with-async-dep transitions from pending to ready.
- *Does the engine track which slots are pending?* Or is that a walk's question
  (`isPending(node)` walks the slot, checks if `cached` is a Promise)?

**Related:** Q-C (consumer's re-run discipline for async deps), main-doc D8
(yield* read vs use vs stages).

### Q-E — Recipe / cache asymmetry between Signal and Computed slots

For a Signal slot, the *recipe is the value* — `() => 42`. The cache is
trivially `42`.

For a Computed slot, the recipe walks deps to compute. The cache is the result
of invocation under the slot's scope.

The engine doesn't currently distinguish — both are slots with `recipe` and
`cached`. But practically:

- *Signal slot invalidation is meaningless* — the recipe is a constant, so
  invalidating the cache and re-invoking the recipe just returns the same value.
  Signal slots don't *get* invalidated; they get *overwritten* by a new
  `writeSlot` call from a setter.
- *Computed slot invalidation triggers recompute* — clear `cached`, mark
  through subs (so downstream sees this slot is dirty); next `invoke` re-runs
  the recipe.

So Signal vs Computed isn't a Node-level distinction, it's a *slot-lifecycle
distinction*. Slot lifecycle is engine-level (because the cache is). Worth
working out whether this is a real distinction or whether it dissolves under a
careful framing.

### Q-F — What is a Scope as a value?

Currently typed `unknown` in the sketch. Practically, scopes need:

- *Identity.* Two scopes are equal iff they're the same scope. Reference
  equality on a fresh object is the cheapest.
- *Hierarchy.* Each scope (except the root) has a parent. Used for cleanup
  cascade and ambient resolution.
- *Lifecycle state.* "open", "committed", "discarded" — at minimum the engine
  needs to know whether a scope is still alive (to decide whether to retain its
  slots) or closed (slots either promoted or dropped).
- *Walk-defined metadata.* Speculative scopes carry "committed slots map" or
  similar; owner scopes might carry nothing extra. Engine doesn't know; walks
  do.

Sketch: `interface Scope { parent?: Scope; cleanups: Disposable[]; status:
'open' | 'closed' }` — minimal, walk-extensible.

**Related:** Q-B (the unification question), Q-A (selectors quote scope
identities; scope value-shape constrains how selectors can match).

### Q-G — The `defaultRecipe` mechanism

The Node has an optional `defaultRecipe` used by `invoke` when no slot exists
for the requested scope. Is this:

- *(i) The right shape.* A convenient "fallback recipe for fresh slots."
- *(ii) Folded into the root-scope slot.* The slot the library tags with
  `ROOT_SCOPE` *is* the default; `invoke` with no slot for `S` falls through
  along the walk's chain and creates a slot for `S` using that slot's recipe.
- *(iii) Walk-defined.* `invoke` takes a selector that says what to do when no
  slot matches — return undefined, fall through, invoke a fallback recipe.

(ii) is most parsimonious but loses the explicit "this is the default recipe"
intent and pushes more convention into the library; (iii) is most flexible.
Probably a cosmetic question, but worth deciding.

### Q-H — Tracker vs Scope: separate or unified?

The sketch has a separate `currentTracker` (the slot currently being
recomputed, used by `read` to register `deps`) and a `getCurrentScope`
(speculation/owner context). Are these the same primitive?

Argument for unification: both are ambient context handles. Argument against:
the tracker is *the slot being recomputed*; the scope is a *broader context*
that may contain many tracker-events. They're at different granularity.

Likely answer: tracker is a sub-ambient. A slot recomputes under a scope (its
slot's scope); reads inside the recompute know both. Either two separate
ambients, or one ambient with a "current slot recomputing" sub-field. Open.

---

## Scenario catalog (problem-space mapping)

A map of architecturally-distinct cases the engine + speculation machinery
needs to handle. Goal: grip on the problem space before committing to a route,
and a basis for the eventual TDD suite — **each scenario is intended to become
a test case** with a precise setup, action, and expectation. The catalog
deliberately favours *specificity over generalisation*: distinct cases stay
distinct even when they look similar, because each will be its own test. ✓
marks a scenario that's already been traced end-to-end; everything else is
open.

*Tracing discipline.* When a scenario is traced, record both the decisions the
trace exposed and *the alternatives that weren't taken* — otherwise the first
plausible trace becomes the route by default, which is exactly the premature
commitment the explorative phase is meant to avoid.

### A. Single speculation, sync (Dim 1 — internal structure)

- **A1.** `setX` inside action, read `X` back inside the same action. Tests
  whether a write sees itself on subsequent read inside the scope. *Expected:
  yes — the slot at `S` is what reads see.*
- **A2.** ✓ `setX`, read derived `f(X)` — the `doubleName` case. Traced.
- **A3.** Action writes multiple signals (`setX`, `setY`); read derived
  `f(X, Y)`. Tests whether multiple scope-tagged slots compose into one
  derived under the same scope. *Expected: yes — recipe runs once, reads
  each under `S`. Conditional on Q-H (tracker-as-scope) and Q-A selector
  dedup behaving correctly under multi-source reads.*
- **A4.** Action writes one signal; two distinct deriveds depend on it. Tests
  that both deriveds invalidate independently and re-read under `S`.
- **A5a.** Functional setter: `setX(x => x + 1)` inside action. Tests *what
  the setter callback's `x` parameter is*: committed value or speculative-
  slot value. Library-API design question.
- **A5b.** Functional setter, write side: where does the setter's returned
  value land? Tests that the write goes to the speculative slot at `S`,
  consistently with sync `setX(v)`. *Expected: yes.*
- **A6a.** Conditional read in a recipe under `ROOT_SCOPE`: branches change
  on input. Tests dynamic deps (drop edge for not-taken branch, form edge
  for taken). *r3 baseline; no new behavior.*
- **A6b.** Same conditional read, recipe invoked under a non-root scope
  `S`. Tests dynamic deps *under scope*: scope-tagged edges drop / form as
  branches change. This is where Model 2 is exercised; A6a is a smoke
  prerequisite.
- **A7.** Action reads only — never writes. Tests whether slots get created
  under `S` for memoisation purposes, or whether read-only access is a no-op
  at the bag level.

### B. Lifecycle & cleanup

- **B1.** ✓ Action returns normally → commit. Traced.
- **B2.** ✓ Action throws → discard. Traced.
- **B3.** `onCleanup(fn)` inside action body. Tests: discard fires `fn`;
  commit doesn't. Working hypothesis from Q-B.
- **B4.** Owner of the action is disposed mid-action (parent owner unmounts).
  Tests: action's scope discards as a consequence of owner disposal. Falls
  out of scope/owner unification if it holds.

### C. Async (Dim 1 with async — Q-D territory)

- **C1.** `setX(Promise.resolve("v"))` inside action — the new recipe returns
  a Promise. Tests: how does a derived `read(X)` see this? Walks decide.
- **C2a.** Action body `yield* read(asyncSignal)` — body parks until promise
  resolves *before any other event*. Tests: does the scope stay open across
  the await? Does the ambient scope restore correctly on resume?
- **C2b.** Same, but the awaited promise resolves *after* the action would
  have committed had it been synchronous (i.e., the scope stays open across
  a long await). Tests: long-lived open scopes; resource holding.
- **C2c.** Same, but a supersession (E1) arrives while the action body is
  parked at the `yield*`. Tests: discard mid-coroutine; cancellation
  reaches the in-flight promise via `onCleanup`.
- **C2d.** Same, but writes occur (from a different scope, or from
  ROOT_SCOPE) during the await window. Tests: when the action body resumes,
  what does its read see? Did the chain re-evaluate?
- **C3.** Async signal resolves *after* the action commits — what value lands
  in canonical? The action committed a Promise; resolution happens later
  under no scope. Library policy.
- **C4.** Concurrent in-flight async + new action arrives. Tests:
  supersession + async cancellation interaction.
- **C5.** Action body awaits external work (not a signal — a fetch). Tests:
  AbortController via `onCleanup` on discard. Cancellation discipline.

### D. Concurrence (Dim 2 — disjoint state)

- **D1.** Two actions `S1`, `S2`, writing disjoint signals. Independent
  slots; both commit; no interaction. Should be trivial — slots keyed by
  scope.
- **D2.** Two actions, both read same signal but only one writes. Reader's
  edges register against the writing scope's chain; should fire correctly on
  writer commit. *Conditional on commit-ordering open question (trace step 5
  open question #1).*
- **D3.** Late subscriber: component mounts mid-action and reads under that
  action's scope. Edge formed with the right chain at subscription time.
  Should fall out of Model 2.

### E. Supersession (Dim 3) — *policy question*

- **E1a.** New action arrives while old in-flight; old structurally
  cancelled by closing its scope with `discard`. Tests: scope-discard
  mechanism — slots drop, edges cleanup, cleanups fire.
- **E1b.** Discarded scope's `onCleanup` chain aborts an `AbortController`
  that the action body installed for an in-flight fetch. Tests: cancellation
  reaches in-flight async work via the cleanup chain (Q2 + Q-B
  composition).
- **E2.** Old action and new action coexist (no auto-supersession). Both
  scopes alive; reads under each see their own overlay. Likely default.
- **E3.** Rapid sequence of supersessions (typing in an input). Scope churn
  doesn't leak; cleanups fire promptly. Pressure test.

### F. Overlap (Dim 4 — entanglement) — *policy question*

- **F1.** Two concurrent actions both write same signal. Which scope's slot
  is in play for which reader? Two scopes, two slots, no merge — pulse-
  direction lean.
- **F2.** Two actions commit in sequence; both touched the same signal.
  Commit order determines final canonical. Last-writer-wins per the lean;
  Solid auto-merges (which pulse rejects).
- **F3.** Concurrent actions where one's read-set overlaps the other's
  write-set (one reads `X`, other writes `X`). Reader's selector decides
  what it sees — selector with chain `[my_scope, ROOT]` doesn't see other
  scope's write. ✓ (Selector design verified.)

### G. Nesting (scope hierarchy)

- **G1.** Action inside an action. Inner scope is child of outer. Writes
  tagged with inner scope; reads inside inner walk chain `[inner, outer,
  ROOT]`. Falls out of the chain framing.
- **G2.** Inner commits → its slots promote to outer's scope (not ROOT).
  Outer commits → outer's slots promote to ROOT. Two-stage promotion. *Open:
  does inner-commit promote to outer or directly to ROOT? Lean: to outer,
  preserving nesting.* See F2 — same commit-promotion question at outer-most
  depth.
- **G3.** Inner commits; outer discards. Inner's promoted-to-outer slots get
  discarded with outer. Nesting respects parent lifecycle.
- **G4.** Inner discards; outer continues. Inner's writes drop; outer's
  state unchanged.

### H. Effects under speculation — *Q-C open*

- **H1a.** Effect registered outside; speculative write happens inside an
  action. Tests *during the action*: does the effect fire? *Lean: no
  (defer-until-commit).*
- **H1b.** Same setup; action commits. Tests *after commit*: does the
  effect fire exactly once with the committed value? *Lean: yes.*
- **H1c.** Same setup; action discards. Tests: effect never fired
  (no speculative trigger leaked). *Lean: yes.* (H1a/b/c together
  establish the defer-until-commit position from Q-C.)
- **H2.** Effect created inside an action body. Effect's owner is the
  action's scope; effect's body executes once at registration. Does it
  re-fire on writes inside the same action?
- **H3.** Effect with `onCleanup`; speculative write triggers the effect →
  effect's body runs → registers cleanup. If discard, do those cleanups
  fire? Cleanup chains across scopes; tricky.
- **H4.** Effect that itself calls `action(…)` (effect-triggers-action).
  Cycles? Bans? Worth knowing the policy.

### I. Component / JSX integration

- **I1.** JSX expression `{read(name)}` rendered inside a component that's
  *inside* an active action. JSX-binding consumer treated like Effect —
  re-renders on speculative writes? Defers to commit? Q-C territory.
  *Downstream of H1a-c's resolution.*
- **I2.** Component mounts inside an action. Its computeds and effects
  belong to a child owner of the action's scope. On action discard, all
  the mounted components dispose. Falls out of scope/owner unification.
- **I3.** Component unmounts mid-action. Owner disposes; its subscriptions
  clean up; if the unmount was triggered by an action write, ordering
  matters.

### J. Edge cases / pressure points

- **J1.** `latest(node)` inside an action. `latest` walk uses
  `chainSelector([ROOT_SCOPE])`, sees the committed value, ignores the
  action's overlay. Falls out of selector design.
- **J2.** `peek(node)` inside an action. Untracked read, same scope, no edge
  formed. Trivial.
- **J3a.** `isPending(node)` — definition 1: returns true if *any* scope
  has a slot for the node distinct from the canonical chain endpoint
  (i.e., "something is in flight somewhere").
- **J3b.** `isPending(node)` — definition 2: returns true only if *the
  current scope's slot* has a Promise-valued cache (i.e., "this node is
  pending *for me*"). Distinct walk from J3a; the library should pick one
  (or expose both with different names). Q-D adjacent.
- **J4.** Action creates a new signal (`signal(initial)` called inside the
  action body). Does the new signal's "initial slot" tag with `ROOT_SCOPE`
  or with the action's scope? Library policy. If with scope: signal
  disappears on discard (probably right). If with ROOT: signal survives
  discard but its values were never written outside the scope (probably
  wrong).
- **J5.** Action body sets a value, then somewhere else (a different scope
  or no scope) reads it. Other scope/no-scope doesn't see the speculative
  value. Falls out — selectors handle.

### K. Re-entrancy & write-during-recompute

- **K1.** `setX` called from *inside* a computed's recipe body during
  recompute (synchronous side-effect during recompute). Tests: ban or
  permit? If permitted, when does the write fire — synchronously? deferred?
  Pressures Q-A (selectors fire mid-recompute), Q-E (signal/computed
  asymmetry), Q-H (tracker as scope). r3 traditionally bans this.
- **K2.** `setX` called from inside `onCleanup` of a slot being dropped
  during commit (cleanup chain triggers further writes). Tests: re-entrant
  write during commit; commit-ordering subtlety (trace open question #1).
- **K3.** Action body calls `setX` where `X` is updated by an effect that
  was itself triggered by that write (would-be cycle). Tests: cycle
  detection under scope; policy bans or runs.

### L. Boundary-bypass reads inside speculation

- **L1.** `untrack(() => read(node))` inside an action body. Tests: read
  forms no tracking edge; do writes performed inside the `untrack` block
  still tag with the action's scope? *Tracker and scope are decoupled per
  Q-H, so the answer is plausibly "yes for writes, no for tracking edges"
  — but this is exactly the case where Q-H bites.*
- **L2.** `latest(node)` inside an action that has *also written* to `node`.
  Tests: does `latest` see the *pre-action* committed value, or the
  most-recently-promoted ancestor (which doesn't exist yet if the action
  hasn't committed)? Edge of selector design.
- **L3.** `peek(node)` inside an action that has written to `node`. Tests:
  `peek` is untracked but scope-aware; should return the action's slot
  value. Distinct from J2 (which is for a non-written node).

### M. Resource ownership across speculation

- **M1.** Action body opens an external resource (`new WebSocket(...)`,
  `setInterval`) and registers `onCleanup(close)`. Tests: on commit, does
  the resource live on past the scope? Owned by what? On discard, cleanup
  fires.
- **M2.** A `computed` is allocated inside an action body. Tests: owned by
  the action's scope (disposes on discard) or by the surrounding parent
  owner? Different answer from a signal (J4)?
- **M3.** An `effect` is allocated inside an action body. Tests: same as
  M2 for effects. The effect's own owner is the action's scope; its
  re-run discipline interacts with H1.

### R. Scheduling & frame coordination

- **R1.** A speculative scope's commit timing: immediate vs deferred to
  the next animation frame. Tests: is commit timing a scope-policy option
  (`closeScope(S, 'commit', { schedule: 'raf' })`), a walk concern, or out
  of scope?
- **R2.** Two speculations want to commit in the same frame: coalesce or
  independent? Touches Dim 4 with a *timing* dimension that F2 lacks.
- **R3.** A long-lived action whose body yields control via
  `requestAnimationFrame` between writes. Tests: scope persists across
  frame boundary; ambient restoration works for raf-style awaits the way
  it does for promise awaits (C2).

### Probably out of scope for the research phase

These shapes were considered and judged probably-out-of-scope for now, but
named explicitly so the catalog isn't silent about them. Any of them may move
into scope if a use-case pulls them in.

- *N. Debugging / DevTools introspection.* Visiting every slot/edge for
  inspection without forming subscriptions.
- *O. Persistence / serialization.* Snapshotting committed state to
  IndexedDB; serialising slot recipes is non-trivial since they're code.
- *P. SSR / hydration / streaming.* Resuming a Node's slot from server-
  serialised state without recomputing.
- *Q. Cross-thread / cross-tab.* Worker postMessage, BroadcastChannel,
  storage events driving slot writes.
- *S. Memory pressure / GC.* Steady-state cardinality of `node.slots`;
  per-tenant / per-route scopes never closing.
- *T. Testing affordances.* Mocking a signal's `defaultRecipe` in a test;
  "dry-run" actions that don't commit.

If pulse ends up taking any of these on, this section is where they get
promoted to a real category.

### Architectural distribution

- *A:* single-scope mechanics — most settled; A2 traced.
- *B:* lifecycle — mostly settled by scope/owner framing.
- *C:* async — biggest open area (Q-D). *C2 specifically is the highest-
  yield single trace: it pressures all four framings (Node-as-recipe,
  walks-first-class, slim-engine + thick-library, scope/owner unification)
  simultaneously.*
- *D:* concurrence — mechanically straightforward under Model 2.
- *E:* supersession — mechanism settled; policy open.
- *F:* overlap — policy is the question, not mechanism.
- *G:* nesting — depends on commit-promotion semantics (same question as
  F2 at a different depth).
- *H:* effects — large open area, but the load-bearing question is really
  Q-C (consumer pattern), which is *upstream* of much of C-engine, H, and
  I. Q-C's priority ≥ H's.
- *I:* JSX/components — downstream of H/Q-C.
- *J:* edges — mostly mechanical verification.
- *K:* re-entrancy — **pressures more framings simultaneously than any
  other category** (Node-as-recipe + walks + scope/owner + Q-A + Q-H +
  commit-ordering). Missing from the initial priority ranking; should be
  high.
- *L:* boundary-bypass — small, targeted, exposes Q-H concretely.
- *M:* resource ownership across commit boundaries — the unstated half of
  B3; load-bearing for scope/owner unification.
- *R:* scheduling — touches Dim 3 (priority) which the main doc punts;
  pulse hasn't articulated against the framings.

Categories where the architecture is most under-specified: **C (async)**,
**H (effects)** *via Q-C*, **G (nesting commit-promotion)**, and **K
(re-entrancy)** — added after agent review. Categories where the mechanism
is settled but a policy decision still needs to be made: **E (supersession)**,
**F (overlap)**, **R (scheduling)**.

*Priority for the next trace, ranked:* **(1) C2** — single trace, biggest
yield. **(2) Q-C-via-H1a-c** — establishes the consumer pattern Q-C, which
is upstream of much else. **(3) K1** (setter mid-recompute) — pressures
most framings simultaneously. **(4) G2** (inner-commit-to-outer-or-ROOT) —
small, cheap, forces a policy out into the open. **(5) H3** (cleanup chains
across speculative effect runs) — where scope/owner unification either
holds or breaks.

---

## Threads to continue (next pushes)

Roughly priority-ordered:

- *Working candidate for Q-A (selectors-on-edges).* Architecture has a
  plausible framing now. Next: verify by tracing more cases — supersession,
  nested scopes, late-bound subscribers — and push on Q-A's sub-questions
  (indexing, dropped-slot races, async resolution as a write event) when they
  start mattering.
- *Trace `doubleName`-under-scope-S end-to-end through this stack.* Verifies
  the falsified hypothesis is genuinely fixed by multi-slot + Model 2 edges;
  exercises Q-A and Q-E along the way. (Partial trace already in Q-A; a full
  end-to-end with engine and library calls would catch remaining holes.)
- *Consumer abstraction (Q-C).* Once edges and slots are clear, the consumer
  shape determines how Effect/JSX-binding/Computed-cache compose.
- *Scope/Owner unification (Q-B).* Likely the cleanest answer; needs verifying
  against effect lifecycle and dispose-on-discard discipline.
- *Async (Q-D).* Mostly downstream of Q-C — once consumers are known, async
  re-run discipline can be pinned.

---

## Cross-references

- [`pulse-design-direction.md`](./pulse-design-direction.md): Q1 (locus of
  speculative state) is what motivated this exploration; P1–P5 hold; D1–D12
  need re-pressure-testing against this stack.
- [`CONTEXT.md`](./CONTEXT.md): "Speculation" terminology; four dimensions.
- [`deep-dives/solid-2x.md`](./deep-dives/solid-2x.md): the per-node multi-slot
  architecture pulse is structurally converging on (with a different user-facing
  surface).
- r3 source (`node_modules/r3/src/index.ts`): the substrate this exploration is
  rooted in; the topological scheduling + push-pull-push fallback machinery
  carries forward into the pulse-forked engine.

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
named patterns and named walks (`signal`, `computed`, `effect`, `get`, `peek`,
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
walk primitive (`get`, `peek`, `latest`, `use`, `isPending`, `subscribe`, …) to
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
`computed(() => …)`, `get(node)`) without seeing engine internals. *But the
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

### Derivation kind matches reactivity scope (computed vs. effect)

A pulse-relevant distinction surfaced by the H5 scenario:

- **Computed** = *scope-aware derivation.* A computed's slot is created on
  demand; reading it inside a speculative scope `S` recomputes under `S`,
  walking the chain `[S, …, ROOT_SCOPE]`. The returned value is coherent
  with `S`'s overlays.
- **Effect** = *committed-state subscription.* An effect's body runs in
  response to *commits* (chain selector matches `ROOT_SCOPE` writes), not
  speculative writes. Downstream signals that an effect maintains reflect
  committed state. The effect's body re-runs *after* commit; inside an
  in-flight action that wrote one of the effect's deps, those downstream
  signals are stale.

The two are not interchangeable for the same "derive Y from X" need:

```ts
// Effect-mediated derivation: STALE inside the action that wrote X
effect(() => setValue(get(X) + get(X)))
action(() => { setX('new'); get(value) })       // returns the OLD value

// Computed-mediated derivation: FRESH inside the action that wrote X
const value = computed(() => get(X) + get(X))
action(() => { setX('new'); get(value) })       // returns the NEW value
```

The mechanism: a *computed* has no consumer scheduler; its slot is populated
on demand via `invoke` under whatever scope is reading. An *effect* IS a
consumer whose scheduling is gated by selector chain, and (per H1a-c)
defer-until-commit naturally excludes in-action visibility.

**Guidance:** choose by whether downstream consumers need *synchronously
fresh visibility into speculative state* (computed) or *settled-state
visibility for side effects* (effect — DOM updates, network calls,
persistence). Mixing them — using an effect to maintain a derived signal
that gets read inside actions — produces stale-during-action behaviour
that's correct but surprising.

(This framing is a candidate for promotion to a P-numbered principle in
[`pulse-design-direction.md`](./pulse-design-direction.md) once the rest of
the design-direction work stabilises. Tracked branch-locally for now.)

### Stages: a memoized node + a promise auto-unwrap

A reduction discovered during this branch's exploration: **what we've been
calling a "stage" is just a memoized computed node whose input-read
auto-unwraps a Promise.** No new engine primitive needed; stages compose
from `createNode` + `get` + `promiseState` (Q-D).

```ts
type Resolved<T> = T extends Promise<infer U> ? U : T

function stage<I, O>(input: Node<I>, transform: (v: Resolved<I>) => O): Node<O> {
  return createNode(() => {
    const v = get(input)
    if (v instanceof Promise) {
      const tracker = currentTracker                      // capture
      return v.then(resolved => {
        pushTracker(tracker)                              // restore around the callback
        try { return transform(resolved as Resolved<I>) }
        finally { popTracker() }
      })
    }
    return transform(v as Resolved<I>)
  })
}

function compute<T>(source: () => T, ...stages: Array<(v: any) => any>): Node<unknown> {
  let current: Node<unknown> = createNode(source)
  for (const fn of stages) current = stage(current, fn)
  return current
}
```

**~15 lines of library code over engine primitives.** This is the
canonical declarative computed form for pulse.

**The semantics:**

- Each stage is **its own memoized node**. Tracker is restored around the
  stage callback, so signal reads inside the callback track to that
  stage's node (lifting D9's "no signal reads inside stages" restriction —
  it was an implementation concern, not a conceptual one).
- The stage callback sees the **unwrapped** value (`Resolved<I>`, not
  `I`); the engine threads the resolved value in.
- The compute's **output type** is `Promise<U>` if any stage along the
  chain returned a Promise; else just `U`. Same model as `async`/`await`:
  any awaited Promise infects the output.
- **Per-stage memoization** gives finer-grained partial recomputation
  than D11's generator form: if signal2 is read in stage 2 and changes,
  stage 1 stays cached; only stage 2 (and downstream) re-runs. The
  generator form would have to restart from the top in the equivalent
  case.

**Example:**

```ts
const result = compute(
  () => get(signal1).toUpperCase(),       // stage 0: depends on signal1
  (v) => v + get(signal2),                 // stage 1: depends on signal2 (tracked inside)
  (v) => v + "!"                           // stage 2: pure
)
// signal1 changes → re-run stages 0, 1, 2
// signal2 changes → stage 0 stays cached; re-run stages 1, 2
```

```ts
const greeting = compute(
  () => get(asyncUser),                   // stage 0: returns Promise<string>
  (u /* string, unwrapped */) => `Hello, ${u}!`
)
// greeting: Computed<Promise<string>>
// The callback sees u: string (auto-unwrapped); output is Promise<string>.
```

### Two forms, not three: stages for computeds, generators for actions

The earlier D11 list had three forms (stages, plain body + `use`, generator
with `yield* get`). Per-stage memoization + the `.then`-with-tracker-
restore mechanism make stages capable of:

- *Dynamic deps:* signal reads inside stage callbacks track properly
  (per-stage tracker).
- *Async propagation:* output type carries `Promise` if any stage was
  async.
- *Per-segment partial recomputation:* finer than generator's
  resume-from-yield (which still restarts from top on signal change).

So for **computeds**, stages cover everything. The other two D11 forms
become unnecessary or anti-patterns:

- **Plain body + `use`** — subsumed; a `compute(() => body)` is just a
  one-stage form.
- **Generator form (`yield* get`)** — dropped for computeds. Coarser
  memoization (one suspension point per generator vs per-stage), more
  complex TypeScript inference, more machinery.

**Generators are retained only for action bodies**, where:

- Action bodies are imperative one-shot bodies (commit/discard at end).
- Multi-yield is needed for sequenced async work + writes.
- The generator's resume semantics matches action driver semantics.

For action-body unwrap of async values, the generator form uses a
generator-helper like `yield* get(promiseOrNode)` (name TBD; see Q-N
candidate below). TypeScript inference for `take` requires a conditional-
type return; that complexity stays confined to action bodies.

### `use()` is React-style throw-to-suspend at the leaf

`use(node)` is reserved for **leaf consumption with throw-to-suspend
semantics**, matching React's `use()` convention. Used in:

- **JSX expressions** at the leaf — `{use(promise)}` triggers Suspense
  fallback if pending.
- **Action body error handling** — `use(node)` throws to a try/catch in
  the action body.
- **NOT inside computed bodies** — would collapse `Promise<T>` into `T`
  at the type level, breaking async honesty. Use stages instead.

This preserves the mental link with React: `use` means "throw if pending,
return resolved." Pulse adopts the same convention.

### Anti-pattern (code smell)

```ts
const greeting = computed(() => `Hello, ${use(user)}!`)
// greeting: Computed<string>  — async hidden, throw-to-suspend mid-graph
```

`use()` here collapses `Promise<string>` into `string` at the callsite,
hiding async from downstream consumers. The stage form is the right
shape:

```ts
const greeting = compute(() => get(user), (u) => `Hello, ${u}!`)
// greeting: Computed<Promise<string>>  — async honest, per-stage memoized
```

### Why this rule matters

- *Type honesty.* `Computed<Promise<T>>` tells consumers they're dealing
  with async; `Computed<T>` says it's sync. Stages preserve the type;
  `use()` mid-graph lies.
- *Suspension locality.* `use()` only at leaves means suspension points
  are visible — readers know "I committed to extract sync; I might
  suspend." Mid-graph `use()` makes every downstream read potentially
  suspending with no syntactic signal.
- *Per-stage memoization.* Stages give partial-recomputation that
  generators can't express. Each stage is independently cached.
- *Slim engine.* Stages are ~15 lines of library code over engine
  primitives. No new engine concept; just `promiseState` + tracker
  push/pop, both already needed.

**Form set sharpened:**

- *Computeds:* stages (one-stage form for plain compute, multi-stage
  form for pipelines). `use()` mid-graph is an anti-pattern.
- *Action bodies:* generators with `yield* get(...)` for async unwrap.
- *Leaves (JSX, action-body-try):* `use(node)` for React-style
  throw-to-suspend.

(Companion to the "Derivation kind matches reactivity scope" framing
above. Both rules describe where computation work happens. Also a
candidate for promotion to a P-numbered principle in
[`pulse-design-direction.md`](./pulse-design-direction.md).)

### `Awaitable<T>` — one type, three legitimate uses

The library's `get(node)` returns `T` for sync nodes and **`Awaitable<U>`**
for nodes typed `Node<Promise<U>>`. `Awaitable<U>` is a Promise subclass
that adds (a) iterability so `yield*` works in generator contexts, and (b)
React-convention state fields (`status`, `value`, `reason`) for sync query.
**One value type covers three call-site shapes:**

```ts
class Awaitable<T> extends Promise<T> {
  status: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  value?: T
  reason?: unknown

  constructor(executor: (resolve: (v: T) => void, reject: (e: unknown) => void) => void) {
    super((resolve, reject) => {
      executor(
        v => { this.status = 'fulfilled'; this.value = v; resolve(v) },
        e => { this.status = 'rejected';  this.reason = e; reject(e) },
      )
    })
  }

  *[Symbol.iterator](): Generator<this, T, T> {
    return (yield this) as T   // yield self; driver awaits; resume with resolved
  }
}

type Resolved<T> = T extends Promise<infer U> ? U : T
type GetReturn<T> = T extends Promise<infer U> ? Awaitable<U> : T

function get<T>(node: Node<T>): GetReturn<T> {
  const cached = invoke(node, getCurrentScope()) as T
  if (cached && typeof (cached as any).then === 'function') {
    return makeAwaitable(cached as any) as GetReturn<T>
  }
  return cached as GetReturn<T>
}

function makeAwaitable<T>(p: Promise<T>): Awaitable<T> {
  if (p instanceof Awaitable) return p
  const a = new Awaitable<T>((resolve, reject) => p.then(resolve, reject))
  // Duck-type: if the incoming Promise already has React-convention state
  // fields, adopt them immediately (interop with React's use(), TanStack
  // Query, anyone else using Promise.allSettled shape).
  const tweaked = p as any
  if (tweaked.status === 'fulfilled')      { a.status = 'fulfilled'; a.value = tweaked.value }
  else if (tweaked.status === 'rejected')  { a.status = 'rejected';  a.reason = tweaked.reason }
  return a
}
```

**The three uses of the same `get` call:**

```ts
const u = get(asyncUser)                  // u: Awaitable<string>

// (1) Sync query — honest about state
if (u.status === 'fulfilled') console.log(u.value)
if (u.status === 'pending')    showSpinner()
if (u.status === 'rejected')   showError(u.reason)

// (2) Async wait (Awaitable IS Promise)
const v = await u                         // v: string
u.then(v => console.log(v))               // works — standard Promise interface

// (3) Generator wait (Awaitable IS iterable)
function* body() {
  const v = yield* u                      // v: string (via Iterator's TReturn)
}

// Sync nodes — bare value, no wrapping
const n = get(syncCount)                  // n: number
```

**What this folds together:**

- *Single verb (`get`)* for all access patterns — no separate `take` /
  `wait` / `read` utility for the generator-form unwrap.
- *Q-D's Promise-tweak vs WeakMap question collapses* — state lives on
  the Awaitable class instance (we own it), not mutated onto foreign
  Promises. A `promiseState()` helper is unnecessary; the fields are
  directly on the value.
- *React-convention interop preserved* via `makeAwaitable`'s duck-type
  check — pulse adopts the state of any Promise that already carries
  `status`/`value`/`reason` fields, no matter who tweaked them.
- *Compatible with existing Promise utilities* (`Promise.all`,
  `Promise.race`, `await`, `.then`) because Awaitable extends Promise.
- *Action-body generator unwrap is `yield* get(...)`* — Awaitable's
  `[Symbol.iterator]` makes this work; no separate `take`/`from`/`wait`
  helper needed.

This is the unifying type. Stages auto-unwrap to `Resolved<T>` via the
Awaitable when needed; action bodies do `yield* get(node)` and the
driver detects the yielded Awaitable (which is a Promise) and awaits;
leaves call `get(node)` and either query `.status`, `await` it, or
ignore the async (use `latest()` for committed-only).

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
const doubleName = computed(() => get(name) + get(name))

action(function* () {
  setName("name")
  console.log(get(doubleName))   // expected: "namename"
})
```

If `setName("name")` only writes pulse's bag entry tagged with `S` (without
touching r3), then `doubleName`'s r3-level cached value remains `"foofoo"` from
its last committed-context recompute. r3 has no idea `S` exists; it doesn't
invalidate `doubleName`. `get(doubleName)` under `S` returns the stale cached
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

No `signal`, `computed`, `effect`, `get`, `latest`, `action`, `transition`,
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
const doubleName = computed(() => get(name) + get(name))

get(name)         // "foo"
get(doubleName)   // "foofoo"
setName("bar")
get(name)         // "bar"
get(doubleName)   // "barbar"

action(function* () {
  setName("name")
  console.log(get(doubleName))    // "namename" — slots resolve under the active scope
})
get(name)         // "bar" — committed unchanged outside the scope
```

---

## End-to-end trace: `doubleName` under scope `S`

A worked trace verifying that **multi-slot + Model 2 (selector-on-edge)**
handles the case the [falsified hypothesis](#speculation-purely-above-unmodified-r3-doesnt-work)
broke on. Walks every engine call and every state change.

### Setup

```ts
const [name, setName] = signal("foo")
const doubleName = computed(() => get(name) + get(name))
```

- `signal("foo")` → library calls `createNode<string>(() => "foo")` → engine
  creates Node `name`. Returns `[name, setName]` where
  `setName = (v) => writeSlot(name, getCurrentScope(), { recipe: () => v, deps: [], subs: [] })`.
- `computed(fn)` → library calls `createNode<string>(fn)` → engine creates
  Node `doubleName`. Returns the Node.

**State.** Both Nodes have empty `slots`. No edges. No reads have happened yet.

### Step 1: `get(doubleName)` outside any action

- Library: `getCurrentScope()` → `ROOT_SCOPE` (library default). `currentTracker`
  is null. `invoke(doubleName, ROOT_SCOPE)`.
- Engine: `doubleName.slots.get(ROOT_SCOPE)` → miss. Create slot `slot_DN_R`,
  push `currentTracker = slot_DN_R`, invoke `defaultRecipe`.
  - Recipe body: `get(name) + get(name)`.
  - First `get(name)`: library `link(name, chainSelector([ROOT_SCOPE]), slot_DN_R)`
    → engine creates `edge1`. Then `invoke(name, ROOT_SCOPE)` → miss, create
    `slot_N_R` with recipe `() => "foo"`, cache `"foo"`, return.
  - Second `get(name)`: cached hit, returns `"foo"`. `link` dedupes.
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

### Step 4: `get(doubleName)` inside the action

- Library: `getCurrentScope()` → `S`. `currentTracker` null (action-body reads
  are imperative — see [open question](#open-questions-from-the-trace) below).
  `invoke(doubleName, S)`.
- Engine: `doubleName.slots.get(S)` → miss. Create `slot_DN_S`, push
  `currentTracker = slot_DN_S`, invoke `defaultRecipe`.
  - Recipe body: `get(name) + get(name)`.
  - First `get(name)`: library
    `link(name, chainSelector([S, ROOT_SCOPE]), slot_DN_S)` →
    engine creates `edge2`. Then `invoke(name, S)` → `name.slots[S]` hit,
    return `"name"`.
  - Second `get(name)`: cached hit, returns `"name"`. `link` dedupes.
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

`get(doubleName)` after commit: cached `"namename"`. ✓

### Step 5b: action throws → `closeScope(S, 'discard')`

Alternative: action body throws.
- Engine: drop every `S`-tagged slot. Walk each dropped slot's `subs`, unlink
  edges. Fire cleanups registered against `S` (none in this trace; would be
  `onCleanup(…)` calls from the action body, e.g. AbortController.abort()).
- Engine: `S.status = 'discarded'`.

**State after Step 5b:** identical to State after Step 1 (committed state never
observed the speculation). ✓

`get(doubleName)` after discard: cached `"foofoo"`. ✓

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

## End-to-end trace: C2 — action body with async read

A worked trace through the four C2 sub-scenarios (await-and-resume, long-lived
scope, supersession-during-await, writes-during-await). C2 was identified as
the highest-yield single trace because it pressures all four framings
(Node-as-recipe, walks-first-class, slim-engine + thick-library, scope/owner
unification) and several open questions (Q-A, Q-B, Q-D, Q-H) simultaneously.

### Setup

```ts
let resolveUser: (v: string) => void
const userPromise = new Promise<string>(r => { resolveUser = r })

const [user, setUser] = signal<string | Promise<string>>(userPromise)
// user.defaultRecipe = () => userPromise (Promise, pending)
```

The signal's recipe returns a `Promise<string>`. Reading the signal yields the
Promise; resolving requires either awaiting or using a walk that suspends.

**State after setup:**
```
user = { slots: {}, defaultRecipe: () => userPromise }
userPromise: pending
edges = []
```

### Walks involved

Two library primitives are exercised in C2:

- **`get(node)`** (the basic walk): returns whatever the recipe returns —
  `T` or `Promise<T>`. Forms a tracking edge if called inside a recompute
  context. Doesn't suspend; the caller chooses how to handle Promises.
- **`yield* get(node)`** (the generator-form walk): inside a generator
  (compute body or action body), `yield* get(node)` either returns
  immediately with `T` (sync case) or yields a `park` command (async case)
  that the calling driver dispatches on.

The action body runs as a generator; it can `yield* get(...)` to park.
Sketched walk implementation:

```ts
function* read<T>(node: Node<T>): Generator<ParkCommand, T, T> {
  const scope = getCurrentScope()
  if (currentTracker) link(node, chainSelector(chainFor(scope)), currentTracker)
  const result = invoke(node, scope) as T | Promise<T>
  if (result instanceof Promise) {
    const resolved = yield { kind: 'park', promise: result } as ParkCommand
    return resolved
  }
  return result
}
```

And the action driver:

```ts
function driveAction(scope: Scope, gen: Generator) {
  const step = (value: unknown) => {
    if (scope.status !== 'open') return     // discarded mid-await; bail
    pushScope(scope)
    try {
      const { done, value: cmd } = gen.next(value)
      if (done)                  closeScope(scope, 'commit')
      else if (cmd.kind==='park') cmd.promise.then(step, stepThrow)
      // else: other command kinds
    } catch (e) {
      closeScope(scope, 'discard'); throw e
    } finally { popScope() }
  }
  const stepThrow = (err: unknown) => { /* analogous, gen.throw */ }
  step(undefined)
}
```

Three things to notice in `driveAction`: **(1)** every `gen.next` is bracketed
by `pushScope` / `popScope` — that's how ambient scope restores across awaits.
**(2)** the `scope.status !== 'open'` check on resume — if the scope was
discarded mid-await, the resume callback bails. **(3)** the driver is library
code; engine knows nothing about generators or park commands.

### C2a: simple await-and-resume

```ts
action(function* () {
  const name = yield* get(user)       // parks until userPromise resolves
  setUser(Promise.resolve(name + "!"))
})
// later: resolveUser("alice")
```

**Step 1: open scope.** `action(body)` → `openScope()` → engine creates
`S = { parent: ROOT_SCOPE, cleanups: [], status: 'open' }`. Library pushes `S`
as ambient. Library calls `driveAction(S, gen)`.

**Step 2: first `gen.next(undefined)`.** Generator runs until first yield.
- Body calls `yield* get(user)`. The `get` sub-generator runs:
  - `getCurrentScope()` → `S`. `currentTracker` → null (action-body reads
    aren't tracked — see H1a-c discussion). No `link()` call.
  - `invoke(user, S)`:
    - Engine: `user.slots.get(S)` miss. Create `slot_U_S = { recipe:
      defaultRecipe, deps: [], subs: [] }`. Push `currentTracker = slot_U_S`.
      Invoke recipe → `userPromise`. `slot_U_S.cached = userPromise`. Pop
      tracker. Set `user.slots[S] = slot_U_S`. Return `userPromise`.
  - `get` sees Promise → yields `{ kind: 'park', promise: userPromise }`.
- `yield*` propagates the park command up to the action body's iterator. The
  body's `gen.next(undefined)` returns `{ done: false, value: { kind: 'park',
  promise: userPromise } }`.
- Driver: `cmd.kind === 'park'` → attach `userPromise.then(step, stepThrow)`.
- Driver: `popScope()` runs (finally block). Ambient back to `ROOT_SCOPE`.
- Driver returns. Synchronous portion of action handler is done.

**State after Step 2:**
```
user.slots = { S: { recipe: defaultRecipe, cached: userPromise, deps: [], subs: [] } }
S.status = 'open'
userPromise: pending (driver awaits)
edges = []                              // no edges formed — action body doesn't track
```

Notice: no edges. The action body's reads don't register tracking edges
because the body isn't going to re-run on dep change.

**Step 3: time passes; `resolveUser("alice")` is called.**

`userPromise` resolves to `"alice"`. The `.then` callback fires (microtask).
- Driver `step("alice")` runs.
- Check `scope.status === 'open'` → yes. `pushScope(S)`. Ambient back to `S`.
- Call `gen.next("alice")`. The `yield*` machinery resumes the `get`
  sub-generator with `"alice"`. `get` returns `"alice"`. `yield*` resumes
  the action body with `"alice"`. `name = "alice"`.

**Engine handling of Promise resolution** (refined since C2 was first traced;
see Q-D for the current framing): the engine attaches a `.then` to the
Promise stored in `slot_U_S.cached`. When `userPromise` resolves to
`"alice"`, the handler **does NOT mutate `slot_U_S.cached`** — the slot's
cached value remains the Promise indefinitely. Instead, the Promise itself
is tweaked with `{ status: 'fulfilled', value: "alice" }` (Q-D's lean,
matching React's `use()` convention; `WeakMap` fallback for frozen
Promises), and the engine fires a slot-changed event with kind `'resolved'`.
Walks query `promiseState(slot_U_S.cached)` to retrieve the
synchronously-readable resolved value. Downstream consumers receive the
slot-changed event identically to any other invalidation event. *This is
strictly cleaner than mutating `cached`*: the slot is immutable for its
lifetime; the tweaked Promise is shared across all walks reading it;
read-vs-write distinction (Q-I) stays unambiguous (the Promise resolving
is not a write).

**Step 4: body continues — `setUser(Promise.resolve("alice!"))`.**

- Library: `setUser` (closed-over setter) runs. `getCurrentScope()` → `S`.
- Library: `writeSlot(user, S, { recipe: () => Promise.resolve("alice!"),
  deps: [], subs: [] })`.
- Engine: walk `user`'s outgoing edges with `(user.slots, S)`. None. Set
  `user.slots[S]` = new slot. Compute `cached = recipe() = Promise<"alice!">`.
  Engine attaches `.then` to resolve `cached` to `"alice!"` in a microtask.

**State after Step 4 (before microtask):**
```
user.slots = { S: { recipe: () => Promise.resolve("alice!"),
                    cached: Promise<"alice!">, deps: [], subs: [] } }
```

**Step 5: generator returns; action commits.**

- Body's `gen.next(...)` (the one from step 3) continues past `setUser` and
  reaches the end. Returns `{ done: true }`.
- Driver: `done` → `closeScope(S, 'commit')`.
- Library promotes `user.slots[S]` to `user.slots[ROOT_SCOPE]`. Engine:
  `writeSlot(user, ROOT_SCOPE, { recipe: () => Promise.resolve("alice!"),
  cached: Promise<"alice!"> })`. Walk `user`'s outgoing edges (none in this
  trace). Drop `user.slots[S]`.
- `S.status = 'committed'`. Pop ambient back to `ROOT_SCOPE`. Driver returns.

**State after Step 5:**
```
user.slots = { ROOT_SCOPE: { recipe: () => Promise.resolve("alice!"),
                              cached: Promise<"alice!"> } }
// next microtask: cached resolves to "alice!"
S.status = 'committed'
ambient = ROOT_SCOPE
```

Subsequent `get(user)` returns `Promise.resolve("alice!")` (or `"alice!"` if
the cache has settled). ✓

### Architecture exposed by C2a

C2a tested cleanly. The decisions it forced into the open:

1. **Async-honest walks.** `get(node)` returns `T | Promise<T>`. The walk
   doesn't hide the Promise; the caller chooses how to handle it. P2 holds.
2. **Park commands separate walk intent from action machinery.** `yield*
   get(node)` yields a `park` command; the action driver decides what to do
   with it (`.then` here; could be `requestAnimationFrame` for an `raf`
   command; library convention, not engine concern). Slim engine + thick
   library (the third framing) holds.
3. **Ambient scope restoration is mechanical.** The driver's
   `pushScope(S)` / `popScope()` around every `gen.next` is what makes the
   scope persist across awaits. Without this, `setUser` after the await
   would write to `ROOT_SCOPE` instead of `S`. Q-H (tracker vs scope):
   the *scope* persists across awaits via push/pop; the *tracker* doesn't
   (the action body has no tracker at all). They're separate.
4. **Action-body reads don't track.** No edges formed during the trace.
   Confirms the assumption from doubleName trace's open question #3 and
   from H1's premise (action bodies are one-shot).
5. **The driver's discard-guard on resume.** `if (scope.status !== 'open')
   return` is what makes C2c safe — see below. Q2 (cancellation) interacts
   with Q-D (async) through this guard.
6. **Engine choice: update cache on Promise resolve, or not.** Open (Q-D);
   the lean is yes (so Q-C consumer-pattern fires correctly when async deps
   resolve). Doesn't affect C2a's correctness either way.
7. **Promise identity as supersession signal.** D8 in the main doc notes
   *"a new Promise is minted per dependency change, so unwrap keyed on
   promise identity doubles as the supersession signal."* The trace
   reaches this: the driver attached `.then` to a *specific*
   `userPromise`; if the slot's `cached` later changes to a different
   Promise, the original `.then` is stale. The discard-guard catches it.

### C2b: long-lived open scope

Same code as C2a, but `resolveUser` is called minutes later (or never). The
trace is structurally identical to C2a — the scope `S` simply stays `open`
for the duration. Slot `user.slots[S]` stays cached as `userPromise`. The
driver holds its `.then` indefinitely.

What's new:

- **Resource accumulation.** `S` holds `cleanups`, accumulates further
  writes from the action body if any happen pre-await. The slot at `user.S`
  pins the original `userPromise`.
- **External cancellation matters more.** A long-lived action without
  cancellation is a leak. Practical actions that might wait long need
  `onCleanup(() => abortController.abort())` so they can be discarded.
- **No new mechanism.** Same path as C2a; correctness doesn't depend on
  await duration.

### C2c: supersession during await

```ts
const handle = action(function* () {
  yield* get(user)
  setUser(...)
})
// later, while handle is parked:
handle.discard()                // or: another action arrives and supersedes
// even later: resolveUser("alice") still fires
```

**Step C2c-1: `handle.discard()` while parked.**
- Library: `closeScope(S, 'discard')`.
- Engine: drop slots tagged `S`. Walk `slot_U_S.subs` (empty); delete
  `user.slots[S]`. (Any edges with `S` in target's chain would also unlink,
  but there are none in this trace.)
- Engine: fire `S.cleanups` (e.g., `abortController.abort()` if the action
  body had registered one — none in this trace).
- `S.status = 'discarded'`. Ambient stays at whatever it was (not pushed
  because `discard()` was called from outside any scope context).

**State after Step C2c-1:**
```
user.slots = {}                          // S slot dropped
S.status = 'discarded'
userPromise: still pending (no one called resolveUser yet)
```

**Step C2c-2: `resolveUser("alice")` fires later.**
- `userPromise.then(...)` callback fires. Driver `step("alice")` runs.
- **Guard fires:** `scope.status !== 'open'` (it's `'discarded'`) → driver
  returns without calling `gen.next`. ✓
- Generator is garbage-collected when references drop. Done.

What this trace exposes:

- **The discard-guard pattern is load-bearing.** Without it, a discarded
  scope's resume would call `gen.next` and potentially execute body code
  (including writes!) under a closed scope. Library convention required.
- **Cancellation discipline is library code over scope + cleanups.** The
  AbortController pattern composes with `onCleanup`; the engine doesn't
  need a separate cancellation primitive. Q2 (cancellation) ≈ scope-discard
  + `onCleanup`. Confirms the working hypothesis from Q-B.
- **Promise still resolves but nothing happens.** The original `.then`
  fires but the guard absorbs it. Resource cleanup: the underlying
  fetch/timer would already have been aborted by `S.cleanups`; the
  `.then` callback firing is harmless.
- **Memory: the discarded scope can be GC'd once the .then is consumed.**
  If a discard happens but `userPromise` *never* resolves, the `.then`
  holds a reference to the driver, which holds the generator, which holds
  closures. Detail-level open question; pulse may need WeakRef gymnastics
  here.

### C2d: writes during the await window

```ts
action(function* () {
  const name = yield* get(user)              // parks
  console.log(name)
})
// while parked:
setUser(Promise.resolve("bob"))               // write from outside the action
// then:
resolveUser("alice")                          // original promise resolves
```

The interesting subtlety: while the action is parked, *someone else* writes
to `user` (in `ROOT_SCOPE` here, since the outside write has no ambient
scope). What does the action body see when it resumes?

**Step C2d-1: action parks at `yield* get(user)`.** Same as C2a Steps 1-2.
After: `user.slots[S]` cached as `userPromise`; driver awaits.

**Step C2d-2: outside `setUser(Promise.resolve("bob"))`.**
- `getCurrentScope()` → `ROOT_SCOPE` (no action active outside).
- `writeSlot(user, ROOT_SCOPE, { recipe: () => Promise.resolve("bob"),
  cached: Promise<"bob"> })`.
- Engine: walk `user`'s outgoing edges. None. Set `user.slots[ROOT_SCOPE]`.

**State after C2d-2:**
```
user.slots = {
  ROOT_SCOPE: { cached: Promise<"bob">, ... },        // new
  S:          { cached: userPromise (pending), ... }, // existing
}
```

**Step C2d-3: `resolveUser("alice")` resolves the original promise.**
- The driver's `.then("alice")` callback fires.
- Guard: `S.status === 'open'` → continue. `pushScope(S)`.
- `gen.next("alice")` resumes the body. `name = "alice"`. `console.log("alice")`.
- Body returns. `closeScope(S, 'commit')`.
- But: `S` has nothing to promote (no scope-tagged writes happened). Engine
  walks `S.slots` (the engine's slot index, not really shown — but
  conceptually, `S` may track which Nodes have S-tagged slots). Promotes
  `user.slots[S]` to `ROOT_SCOPE`? **This is the wrinkle.**

The wrinkle: `user.slots[S]` was created by the *read* (lazily populating
the cache for the scope-S read), not by a *write*. Is it "the action's
write" that gets promoted on commit, or "every slot tagged S regardless of
how it got there"?

Two positions:

- **(α) Promote every S-tagged slot.** Then committing this action *overwrites*
  the outside `setUser("bob")` because `user.slots[S]` (containing the
  original pending promise) is promoted to `ROOT_SCOPE`, clobbering
  `Promise<"bob">`. Wrong.
- **(β) Promote only slots that were *written* under S (not just read-populated).**
  The engine tags slots as `wasWritten: boolean` to distinguish. Commit
  promotes only `wasWritten` slots. Then the outside `setUser("bob")` wins;
  the action's `user.slots[S]` (which was read-populated, never written)
  drops without promotion. The action saw `"alice"` (the original promise
  resolved), but committed nothing about `user`.

Position (β) is clearly correct, but it requires the engine to distinguish
read-populated vs write-populated slots.

This is a **major surfaced design decision**. Adding to open questions.

What C2d exposes:

- **Read-populated slots aren't the same as write-populated slots.** Both
  end up in `node.slots[scope]`, but their commit semantics differ. Need
  a `wasWritten` flag or equivalent on `Slot`.
- **Read-skew is real.** The action body saw `"alice"` because it read
  before the outside write. After the action commits, the canonical value
  is `Promise<"bob">` (from outside) — *not* what the action body "saw."
  This is intrinsic to the await-and-resume model; per D8 in the main doc.
- **The action body had no way to notice the outside write.** Because it
  didn't form a tracking edge. If it *had* formed an edge, the edge would
  have invalidated → but the action body wouldn't re-run anyway (it's
  one-shot). So edges are useless for action bodies; pure imperative reads
  are the right shape.
- **D-skew between scopes:** when scope `S` is open and outside writes
  happen to `ROOT_SCOPE`, the scope `S` doesn't see them because reads
  under `S` walk `chain = [S, ROOT_SCOPE]` and `S` has a slot. To see the
  outside write, the action would have to drop its slot or read `latest()`.

### Summary

C2 was the highest-yield trace because it forced the following decisions /
sub-questions into the open:

1. **Walks return `T | Promise<T>` honestly.** (Confirms P2.)
2. **`yield* get` yields `park` commands; the action driver dispatches.**
   Library convention; engine knows nothing.
3. **Ambient-scope restoration via `pushScope`/`popScope` around every
   `gen.next`.** Driver responsibility.
4. **Action bodies don't track.** No edges formed.
5. **Discard-guard on resume.** `if (scope.status !== 'open') return`.
6. **Engine fires slot-changed events on Promise resolution, without
   mutating `slot.cached`.** Refined post-C2; see Q-D. The slot's cached
   value stays as the Promise; the Promise itself is tweaked with `{
   status, value, reason }` (React's convention) for synchronous query
   via `promiseState(promise)`. Engine attaches one `.then` per
   Promise-valued slot to populate the metadata and fire the resolution
   event.
7. **`Slot` needs `wasWritten` (or equivalent).** Read-populated and
   write-populated slots have different commit semantics; the engine must
   distinguish. **New sub-question — added to Q-G and Q-A territory.**
8. **Read-skew is intrinsic to await-and-resume; programmer's responsibility.**
   D8 (sequential `yield*`s sample at different instants) confirmed by trace.
9. **Cancellation discipline is library code over scope-discard +
   `onCleanup`.** Confirms Q-B working hypothesis. No new engine primitive
   for cancellation.

**New open question surfaced:** *the read-vs-write slot distinction* — should
slots carry a `wasWritten` flag (or equivalent) so the commit promotion logic
only promotes write-populated slots? **Lean: yes**, but the alternative
(promote everything, accept that reads pin values into the scope) is
defensible too — it would mean an action that reads but never writes still
"captures" the state at the moment of the read, which has some appeal for
snapshot-isolation semantics.

The framings all held: Node-as-recipe survived (recipes can return Promises),
walks-first-class survived (`get` and `yield* get` are walks), slim-engine
+ thick-library survived (driver is library; engine sees writes), scope/owner
unification held (cleanups + scope-status + discard mechanism). No
falsifications.

---

## End-to-end trace: H1a-c — effect under speculation

A worked trace of the three H1 sub-scenarios verifying the **defer-until-commit**
position for effects-under-speculation: speculative writes inside an action
*do not* fire effects registered outside; commit fires them once; discard
never fires them. The trace also establishes a consumer-pattern abstraction
(Q-C) that's load-bearing for the next-pressing piece of the architecture.

### What's an Effect, structurally?

Under the [framings](#signal--computed--jsx-expression--effect-are-all-the-same-primitive),
Effect is one of the four connection patterns over `Node<() => T>`:

- The Node's recipe is the *body* (which contains reads and side effects).
- The recipe is *fixed at creation* (like Computed).
- The **consumer** is a *scheduler* that re-invokes the recipe whenever any
  of the recipe's tracked deps changes.
- If the recipe returns a function, that's a *cleanup* run before the next
  invocation (or on disposal).
- The effect's *ambient scope* at creation time determines what chain its
  tracking edges form against.

Library shape:

```ts
function effect(fn: () => void | (() => void)): EffectHandle {
  const scope = getCurrentScope()                 // ambient scope = ownership + dep-chain
  const node = createNode<void>(fn)               // Effect is a Node whose recipe is fn

  let lastCleanup: (() => void) | undefined

  const runBody = () => {
    lastCleanup?.()
    pushScope(scope)
    pushTracker(getOrCreateSlot(node, scope))
    try { lastCleanup = fn() as (() => void) | undefined }
    finally { popTracker(); popScope() }
  }

  // Initial invocation forms tracking edges
  runBody()

  // Register as a consumer: when this Node's slot is invalidated, re-run on
  // next microtask (batched).
  subscribe(node, e => {
    if (e.kind === 'invalidated') scheduleMicrotask(runBody)
  })

  return { dispose: () => { lastCleanup?.(); disposeNode(node) } }
}
```

Three things to notice: **(1)** the effect's ambient scope at creation is
captured in `scope` — its edges form against `chainFor(scope)`. **(2)** the
consumer is just a `subscribe` call on the Effect Node itself; the engine
fires "slot invalidated" events; library batches via `scheduleMicrotask`.
**(3)** the engine knows nothing about effects — `subscribe` is the only
engine primitive used.

### Setup

```ts
const [count, setCount] = signal(0)
let effectRuns = 0
const handle = effect(() => {
  const value = get(count)
  effectRuns += 1
  console.log(`Effect runs: ${effectRuns}, value: ${value}`)
})
```

**Step 0: effect creation, initial run.**

- `effect(fn)` runs. `getCurrentScope()` → `ROOT_SCOPE` (top-level).
- `createNode<void>(fn)` → engine creates `effectNode`.
- `runBody()`:
  - `pushScope(ROOT_SCOPE)` (no-op; already there).
  - `pushTracker(getOrCreateSlot(effectNode, ROOT_SCOPE))` → creates
    `slot_E_R` = { recipe: fn, deps: [], subs: [] }. Tracker now points at it.
  - Invoke `fn`:
    - `get(count)`:
      - `getCurrentScope()` → `ROOT_SCOPE`. `currentTracker` → `slot_E_R`.
      - `link(count, chainSelector([ROOT_SCOPE]), slot_E_R)`.
        - Engine: `edge1` = { source: count, sourceSelector:
          `chainSelector([ROOT_SCOPE])`, target: `slot_E_R` }. Add to
          `count`'s outgoing edges; add to `slot_E_R.deps`.
      - `invoke(count, ROOT_SCOPE)`:
        - Engine: `count.slots.get(ROOT_SCOPE)` miss. Create `slot_C_R`
          = { recipe: () => 0, deps: [], subs: [edge1] }. Invoke → 0.
          `slot_C_R.cached = 0`. Return 0.
    - Body: `value = 0`. `effectRuns = 1`. `console.log("Effect runs: 1,
      value: 0")`. Returns undefined.
  - `lastCleanup = undefined`. Pop tracker. Pop scope.
- `subscribe(effectNode, handler)`. Engine registers handler.

**State after Step 0:**
```
count.slots = { ROOT_SCOPE: { recipe: () => 0, cached: 0, deps: [], subs: [edge1] } }
effectNode.slots = { ROOT_SCOPE: { recipe: fn, cached: undefined,
                                    deps: [edge1], subs: [] } }
edge1 = { source: count, selector: chainSelector([ROOT_SCOPE]),
          target: effectNode.slots[ROOT_SCOPE] }
effectRuns = 1
```

### H1a: speculative write inside an action — effect does NOT fire

```ts
action(function* () {
  setCount(5)
})
// expectation: effect does NOT run inside the action
```

**Step 1a-1: open scope.** `openScope()` → `S`. Push ambient. Begin driving
generator.

**Step 1a-2: `setCount(5)` inside the action.**

- Library: setter runs. `getCurrentScope()` → `S`. `writeSlot(count, S,
  { recipe: () => 5, cached: 5, deps: [], subs: [] })`.
- Engine: walk `count`'s outgoing edges with `(count.slots, S)`:
  - `edge1.sourceSelector` = `chainSelector([ROOT_SCOPE])`. Check:
    `chain.indexOf(S)` → `-1`. **Don't fire.** ✓
- Set `count.slots[S]` = new slot.

**State after Step 1a-2:**
```
count.slots = {
  ROOT_SCOPE: cached 0,    subs: [edge1],
  S:          cached 5,    subs: [],
}
effectNode.slots[ROOT_SCOPE] unchanged. effectRuns = 1.
```

**Step 1a-3: generator returns.** *(we'll cover commit in H1b.)*

The key observation: **the effect's edge selector (`chainSelector([ROOT_SCOPE])`)
naturally rejects writes to `S`.** No special "defer-until-commit" logic in
the engine; the defer behaviour falls out of selector composition. The effect
doesn't fire during the action because *its subscription chain doesn't
include `S`*.

This is the cleanest possible answer to H1a: the chain-selector machinery
already enforces it. **Confirming the lean: defer-until-commit.**

### H1b: action commits — effect fires exactly once

Continuing from the H1a state, with the generator returning normally:

**Step 1b-1: `closeScope(S, 'commit')`.**

Library promotes `count.slots[S]` to `count.slots[ROOT_SCOPE]`:
- `writeSlot(count, ROOT_SCOPE, { recipe: () => 5, cached: 5, … })`.
- Engine: walk `count`'s outgoing edges with `(count.slots, ROOT_SCOPE)`:
  - `edge1.sourceSelector` = `chainSelector([ROOT_SCOPE])`. Check:
    `chain.indexOf(ROOT_SCOPE)` → `0`. No more-specific in chain. **Fire.**
  - Engine: invalidate `slot_E_R` (clear `cached`, mark "dirty" — set a
    flag or use `cached === undefined` as the signal).
  - Engine: emit `SlotChangeEvent { kind: 'invalidated', node: effectNode,
    scope: ROOT_SCOPE }` to subscribers of `effectNode`.
- Library: drop `count.slots[S]`. (No edges had it as source; nothing to
  unlink on the S side.)
- `S.status = 'committed'`. Pop ambient back to `ROOT_SCOPE`.

**Step 1b-2: microtask runs scheduler.**

The effect's `subscribe` handler received the invalidation event in Step
1b-1; it called `scheduleMicrotask(runBody)`. Microtask now fires.

- `runBody()`:
  - `lastCleanup?.()` — none yet.
  - `pushScope(ROOT_SCOPE)`. `pushTracker(slot_E_R)`.
  - **Important:** before re-invoking, the library should *unlink* `slot_E_R`'s
    old `deps` (so they get rebuilt from scratch). Same discipline as r3's
    `recompute`. Drop `edge1` from `slot_E_R.deps` and from `count`'s outgoing
    index. (`subs` on `count` side: `edge1` removed.)
  - Invoke `fn`:
    - `get(count)`:
      - `link(count, chainSelector([ROOT_SCOPE]), slot_E_R)` → creates
        `edge1'` (new identity, same shape). Add to `count`'s outgoing,
        add to `slot_E_R.deps`.
      - `invoke(count, ROOT_SCOPE)`:
        - Engine: `count.slots[ROOT_SCOPE]` exists with `cached: 5`. Return 5.
    - Body: `value = 5`. `effectRuns = 2`. `console.log("Effect runs: 2,
      value: 5")`. Returns undefined.
  - `lastCleanup = undefined`. Pop tracker. Pop scope.

**State after Step 1b-2:**
```
count.slots = { ROOT_SCOPE: cached 5, subs: [edge1'] }
effectNode.slots = { ROOT_SCOPE: cached undefined, deps: [edge1'] }
edge1' = { ... (same shape as edge1, fresh identity) }
effectRuns = 2
```

✓ The effect fired *exactly once* on commit, with the committed value `5`.

### H1c: action discards — effect never fires

Same setup as H1a (post Step 0 state). The action body throws (or
`handle.discard()` is called externally).

**Step 1c-1: `closeScope(S, 'discard')`.**

- Engine: drop slots tagged `S`. Walk `count.slots[S].subs` (empty); delete
  `count.slots[S]`. No edges to unlink on the S side.
- Engine: fire `S.cleanups` (none).
- `S.status = 'discarded'`. Pop ambient.
- **No write to `count.slots[ROOT_SCOPE]` happens.** The effect's selector
  is never tested against a fire-worthy write.
- Subscribers receive no events. The microtask scheduler queues nothing.

**State after Step 1c-1:**
```
count.slots = { ROOT_SCOPE: cached 0, subs: [edge1] }      // unchanged from initial
effectNode.slots[ROOT_SCOPE] cached undefined (or 0 — never re-invoked)
edge1 still alive (unchanged)
effectRuns = 1                                              // never advanced
```

✓ The effect *never* fired during or after the action. The discard cleanly
unwinds the speculation with no side-effect leakage.

### Architecture exposed by H1a-c

The trace established **Q-C (consumer pattern)** with a concrete shape:

1. **A consumer is just a `subscribe` + a scheduler.** No new engine
   primitive needed. The library composes existing pieces: `subscribe(node,
   handler)` for the engine-side notification, `scheduleMicrotask(...)` for
   batching/timing.
2. **The deferred-until-commit semantics fall out of selector composition.**
   An effect at `ROOT_SCOPE` has chain `[ROOT_SCOPE]` on its tracking edges.
   Writes to a speculative scope `S` don't match the chain → don't fire.
   Writes to `ROOT_SCOPE` (commit promotion) match → fire. **No engine
   logic; pure walk policy.** This is the cleanest possible answer to H1
   and arguably the strongest validation of the (β) "open walks over a
   smaller core" lean we've seen so far.
3. **Effect re-invocation is recipe re-invocation.** Same `pushTracker` /
   `pushScope` / `invoke` discipline as Computed re-runs. Effects and
   Computeds share machinery; what differs is *what the consumer does
   with the result* (Computed caches in the slot; Effect throws away the
   value but holds the cleanup).
4. **Edge discipline on re-run.** Before re-invoking, the consumer unlinks
   stale `deps` (so they get rebuilt). Same as r3's existing pattern.
5. **JSX-binding consumer mirrors Effect.** A JSX expression `{get(x)}`
   is a Node whose consumer schedules a DOM update on invalidation. Same
   shape as `effect`; the scheduler hands off to the DOM updater instead
   of running a side-effecting body. **I1 falls out of H1.**
6. **Scope/owner unification holds.** The effect's ambient scope at
   creation = its owner. Disposing the scope disposes the effect
   (cleanup fires, edges unlink). H2 (effect inside action body) would
   work the same way: the effect's scope is the action's scope, chain
   is `[action, ROOT_SCOPE]`, so writes to the action's scope DO fire
   the effect — which is what you want for effects inside actions.

### Consumer-pattern abstraction (Q-C answered)

The library has a uniform consumer shape:

```ts
type ConsumerKind =
  | { run: () => void }          // re-invoke a body (Effect)
  | { render: () => void }       // re-render a JSX subtree
  | { invalidate: () => void }   // mark dependent Computed dirty
  // …

function consumer(node, onSlotChange: () => void) {
  return subscribe(node, e => {
    if (e.kind === 'invalidated') scheduleMicrotask(onSlotChange)
  })
}
```

Effect / JSX-binding / Computed-cache-dependent are all `consumer(node, …)`
calls with different `onSlotChange` bodies. The engine doesn't see the
difference. **Q-C lands at: "consumers are library code over the engine's
`subscribe` primitive; no new engine primitive needed."**

### New sub-questions surfaced

The trace was clean — no falsifications — but a few details deserve being
captured:

1. **Microtask batching policy.** If multiple writes happen in quick
   succession, multiple invalidations fire, multiple `scheduleMicrotask`
   calls happen. Does the library de-dupe (one re-run per microtask cycle
   per Node) or does it re-run multiple times? r3 batches via the dirty
   heap; the library equivalent here would be a per-Node "scheduled"
   flag. Cheap fix; doesn't change architecture.
2. **Effect-during-recompute.** An effect's body calls `get(count)`; what
   if `count`'s recipe (when invoked) itself triggers an effect (via some
   side path)? Re-entrancy — exactly **K1 territory.** Worth tracing K1
   next since it directly tests this.
3. **Effect priority.** If 100 effects all depend on the same signal, and
   that signal commits, the scheduler runs them all in some order. Does
   order matter? Does pulse expose a priority hint? **Adjacent to R
   (scheduling).**
4. **Effects under a chain longer than 1.** A component-owned effect has
   chain `[component_scope, ROOT_SCOPE]`; an effect inside an action
   inside a component has chain `[action_scope, component_scope,
   ROOT_SCOPE]`. The chain composition is implicit in `chainFor(scope)`.
   The trace didn't exercise this; H2 would.

### Framings status after H1a-c

All four framings held:

- *Node-as-recipe*: an Effect is a Node whose recipe is the body. Same
  shape as Signal/Computed.
- *Walks-first-class*: `get` inside the body forms edges with the right
  chain; the chain *is* the consumer's subscription policy.
- *Slim engine + thick library*: the entire effect mechanism is library
  code over `createNode` / `subscribe` / `invoke` / `link` / `writeSlot`.
  Engine knows nothing about effects.
- *Scope/owner unification*: the effect's ambient scope at creation is
  its owner; disposing the scope disposes the effect via the cleanup
  chain.

**Q-C is essentially resolved** at the architectural level (mechanism +
policy via selectors). H2/H3/H4 would test specific compositions but don't
require a new framing. **Two big upstream pieces are now in place:** C2
established async-walk discipline; H1a-c established consumer-pattern via
selectors. Both came out cleanly.

---

## End-to-end trace: K1 — re-entrant setter mid-recompute

**Note (post-revision):** the original K1 trace below identified three
positions (A: ban, B: permit + defer fires, C: permit + fire synchronously)
and leaned (B) while ruling out (C). That conclusion was *wrong*. Two
subsequent findings dissolved K1's "design call" entirely:

1. **(A) is structurally incompatible** with the slim-engine framing
   (effects need to write inside their bodies; the engine doesn't
   distinguish "this tracker is a computed's recipe" from "this tracker
   is an effect's body" without violating one-Node-primitive).
2. **(B) returns *stale* values** in the K1b scenario (write a signal
   then read a derived in the same recipe — see catalog K1b). The
   deferred fires mean the derived's slot isn't marked dirty until
   after the recipe returns; the in-recipe `get` returns the stale
   cached value.
3. **(C) was ruled out on a confused premise.** "Synchronous fire mid-
   recompute creates re-entrant invocation" conflated *firing edges*
   (mark target dirty + emit slot-changed event) with *synchronously
   invoking the consumer's body*. Firing is just propagate-dirty +
   queue-microtask; consumers schedule async; no re-entry occurs.

**Settled answer: (C) — permit + fire synchronously.** Consumers schedule
async via microtasks; cycle detection at consumer level catches loops. The
K1b sub-trace below walks through why.

The historical trace below remains for reference; the architectural status
is amended in the "Architecture exposed (post-revision)" section at the
end of K1.

### The interaction question (historical framing)

Concrete shape:

```ts
const [count, setCount] = signal(0)
const [shadow, setShadow] = signal(0)
const derived = computed(() => {
  const c = get(count)
  setShadow(c * 2)        // ← re-entrant write inside the recipe
  return c + 1
})
get(derived)
```

What happens when the recipe calls `setShadow(0)`? Three positions were
identified; pulse leaned (B) initially but later flipped to (C) — see
the K1b sub-trace and "Architecture exposed (post-revision)" below.

### The three positions (historical exposition)

Concrete shape:

```ts
const [count, setCount] = signal(0)
const [shadow, setShadow] = signal(0)
const derived = computed(() => {
  const c = get(count)
  setShadow(c * 2)        // ← re-entrant write inside the recipe
  return c + 1
})
get(derived)
```

What happens when the recipe calls `setShadow(0)`? Three positions were
identified. The historical conclusions are reproduced below for context;
the post-revision finding flips (B) → (C) — see "Why (B) is wrong" and
"K1b sub-trace" sections below.

- **(A) Hard ban.** `writeSlot` called while `currentTracker` is set →
  throw. Defensible: re-entrant writes are usually bugs and prohibiting
  them is the simplest invariant. r3 doesn't explicitly throw, but most
  reactive libraries (MobX strict mode, Solid in certain contexts) do.
- **(B) Permit + defer the fire.** `writeSlot` updates the slot
  synchronously (so later reads in the same body see the new value), but
  *defers* edge-firing until the recompute completes. After the body
  returns, the engine drains a "deferred fire queue." Cycles (writes that
  invalidate the current tracker) re-queue the tracker for a future
  re-run; this can loop pathologically if the recipe always writes to
  one of its own deps.
- **(C) Fire synchronously.** `writeSlot` fires edges immediately, even
  mid-recompute. Naïve; can re-invalidate the currently-running recompute,
  causing reentrant invocation. Almost certainly wrong.

r3's behaviour today is closest to **(B)**: `setSignal` updates `el.value`
synchronously and inserts subs into the dirty heap; the heap is drained at
the next `stabilize()`. If the subs include the currently-recomputing
computed, it gets recomputed *again* on the next pass. No explicit ban; no
explicit defer either — the deferral is implicit because firing means
"insert into heap," not "invoke synchronously."

For pulse the question is sharper because Model 2 fires edges *immediately*
on `writeSlot` (selectors run on the call stack). To get B's deferral, we'd
have to add explicit gating.

### Position B traced in detail

Library-side: `writeSlot` checks for an active tracker.

```ts
let deferredFires: { node: Node<unknown>, scope: Scope }[] | null = null

function writeSlot<T>(node: Node<T>, scope: Scope, slot: Slot<T>): void {
  node.slots.set(scope, slot)                       // engine: write the slot
  if (deferredFires !== null) {
    deferredFires.push({ node, scope })             // defer (we're inside a recompute)
  } else {
    fireEdges(node, scope)                          // immediate (no tracker active)
  }
}

function invoke<T>(node: Node<T>, scope: Scope): T | Promise<T> {
  const slot = getOrCreateSlot(node, scope)
  const savedFires = deferredFires
  deferredFires = []
  pushTracker(slot); pushScope(scope)
  try {
    slot.cached = slot.recipe()
    return slot.cached
  } finally {
    popScope(); popTracker()
    const toFire = deferredFires
    deferredFires = savedFires
    if (savedFires === null) {
      // outermost invoke — actually fire
      for (const { node, scope } of toFire!) fireEdges(node, scope)
    } else {
      // nested — propagate up to outer queue
      savedFires.push(...toFire!)
    }
  }
}
```

Three things worth noting: **(1)** writes are visible *immediately* to
subsequent reads in the same body (slot is updated synchronously). **(2)**
edge-firing is gated and queued. **(3)** nested invokes propagate deferred
fires upward — fires only happen when the *outermost* invoke completes.

#### Trace: `get(derived)` from a clean slate

Initial state: all slots empty.

**Step 1.** `get(derived)`. Library: `getCurrentScope()` → `ROOT_SCOPE`.
`currentTracker` → null. `invoke(derived, ROOT_SCOPE)`.

**Step 2.** Engine `invoke(derived, ROOT_SCOPE)`:
- `derived.slots.get(ROOT_SCOPE)` miss. Create `slot_D_R` =
  `{ recipe: deriveBody, deps: [], subs: [] }`.
- `deferredFires` was null (top-level invoke); set to `[]`.
- `pushTracker(slot_D_R)`, `pushScope(ROOT_SCOPE)`.
- Invoke `deriveBody`:
  - `get(count)`:
    - `link(count, chainSelector([ROOT_SCOPE]), slot_D_R)` → creates
      `edge_C_D`. Add to `count`'s outgoing and `slot_D_R.deps`.
    - `invoke(count, ROOT_SCOPE)` → miss → create `slot_C_R` with
      `recipe: () => 0`, invoke → 0, cache → 0, return 0.
  - Body has `c = 0`.
  - `setShadow(c * 2)` = `setShadow(0)`:
    - Library setter: `writeSlot(shadow, ROOT_SCOPE, { recipe: () => 0,
      cached: 0, deps: [], subs: [] })`.
    - Engine writes `shadow.slots[ROOT_SCOPE]`.
    - `deferredFires` is non-null → push `{ shadow, ROOT_SCOPE }` to queue.
      **No edge-firing here.**
  - Body returns `0 + 1 = 1`.
- `slot_D_R.cached = 1`.
- `popScope`, `popTracker`.
- `toFire = [{ shadow, ROOT_SCOPE }]`. `deferredFires = null` (back to outer
  state).
- Drain `toFire`: `fireEdges(shadow, ROOT_SCOPE)`.
  - Walk `shadow`'s outgoing edges with `(shadow.slots, ROOT_SCOPE)`. None.
  - No-op.
- Return 1.

**Final state:**
```
count.slots = { ROOT_SCOPE: cached 0,  subs: [edge_C_D] }
shadow.slots = { ROOT_SCOPE: cached 0, subs: [] }
derived.slots = { ROOT_SCOPE: cached 1, deps: [edge_C_D], subs: [] }
edge_C_D = { source: count, selector: chainSelector([ROOT_SCOPE]),
             target: derived.slots[ROOT_SCOPE] }
```

`get(derived)` returned `1`; `shadow` is now `0`. ✓ The re-entrant write
happened; no loop, no error. If we read `shadow` later, we'd see `0`.

#### Why the deferral matters

If `fireEdges` had run *synchronously* during `setShadow`, what would
happen?
- `shadow` has no outgoing edges yet (we're in the very first invocation),
  so nothing would fire. **In this exact trace, the difference is
  invisible.**

But add a downstream consumer of `shadow`:

```ts
let observedShadow = -1
effect(() => { observedShadow = get(shadow) })
```

The effect's initial run forms an edge `shadow → effectSlot`. Now when
`get(derived)` runs and `setShadow(0)` fires *synchronously* during the
recipe, the effect's selector matches → effect's slot invalidates → effect
scheduled. The effect *might* re-run before the recipe finishes (depending on
microtask ordering), creating partial-update visibility. With deferral, the
effect runs after `get(derived)` returns, observing the consistent
post-state.

Even subtler: if the effect itself reads `derived`, we get
`shadow → effect → derived`-style coupling, and synchronous firing during
`derived`'s recompute would re-enter `derived` recursively. Defining
"unwinds correctly" here requires invariants synchronous firing can't
satisfy.

#### The cycle subcase

```ts
const [count, setCount] = signal(0)
const incrementer = computed(() => {
  const c = get(count)
  setCount(c + 1)             // writes to its own dep
  return c
})
get(incrementer)
```

Trace under Position B:
- Invoke `incrementer`. Push tracker.
- `get(count)` → 0; form edge `count → incrementer.slot`.
- `setCount(1)`: writeSlot writes count.slot. Defer fire.
- Return 0. Pop tracker.
- Drain: fire `count → incrementer.slot`. Selector matches; invalidate
  `incrementer.slot`. Mark dirty.

After the initial `get(incrementer)`:
- `incrementer.slots[ROOT_SCOPE].cached = 0` (returned value) but
  immediately invalidated by the drain.
- `count.slots[ROOT_SCOPE].cached = 1`.

If a consumer demands `incrementer` again (e.g., a downstream effect fires
the consumer), it recomputes:
- `get(count)` → 1. `setCount(2)`. Defer.
- Return 1. Pop. Drain → invalidate `incrementer`. Mark dirty.

Each demand-driven read recomputes one step. **No infinite loop *during* a
single read** — the recompute completes, returns a value, and only *then* is
the invalidation processed. The loop only continues if some consumer keeps
pulling.

If there's a consumer that re-runs on each invalidation (an Effect), the
Effect's scheduler will keep scheduling re-runs:
- Effect fires → reads incrementer → invalidates incrementer → Effect's
  slot also invalidates (since the Effect depends on incrementer's slot) →
  Effect rescheduled → loops.

Position B catches this *at the consumer level*, not at the recompute level.
The library's scheduler can detect "same Effect re-scheduling more than N
times in one microtask cycle" and bail with an error. r3 doesn't have this
today; pulse would need to add it.

### Position A (hard ban) traced

`writeSlot` inside a tracker throws.

```ts
function writeSlot(node, scope, slot) {
  if (currentTracker !== null) {
    throw new Error("Cannot write to a signal during recompute. " +
                    "Move side-effecting writes to an effect or action.")
  }
  // ... otherwise normal write ...
}
```

For the `derived` example above: `setShadow(0)` throws. The recipe throws.
`invoke(derived, ROOT_SCOPE)` propagates the throw. `get(derived)` throws.

Trade-offs vs Position B:
- **Pros (A):** simpler invariant, prevents the cycle case at the source,
  encourages cleanly separating computation from side-effect (use Effects
  for side effects). MobX-strict-mode style.
- **Cons (A):** some legitimate patterns become awkward (memoised writes to
  an isomorphic shadow representation; cache warming on demand; logging
  metrics from a derivation). Workarounds (`untrack`-then-write) feel
  hacky.

### Position C (fire synchronously) — ruled out

Already covered: synchronous firing mid-recompute creates re-entrant
invocation of the current recompute, which can corrupt cached state and
violate the "a recompute runs to completion uninterrupted" invariant.
Listed for completeness; almost certainly wrong.

### Architecture exposed

K1 forced the following framings under stress; all held, but with newly-
visible work:

1. **Q-H (tracker vs scope) matters here.** The re-entrant write's
   `getCurrentScope()` returns the scope being recomputed under — *not*
   `ROOT_SCOPE` by default. If `derived` is being recomputed under
   speculation scope `S`, the re-entrant `setShadow(...)` writes to
   `shadow.slots[S]`. **The scope nests cleanly with the tracker.** The
   ambient context's two slots (tracker, scope) push together when
   entering a recompute and pop together. Q-H's "they're at different
   granularities" framing holds — but they're *parallel* and *coupled*.

2. **Q-A (selectors / fire policy) didn't break.** Under Position B,
   selectors still run when `fireEdges` drains the deferred queue. The
   *only* engine change Position B requires is gating `fireEdges` behind
   the `deferredFires` queue. The selector logic itself is unchanged.

3. **Q-C (consumer pattern) is the right level for cycle detection.**
   Cycles surface at the consumer level (Effects re-running indefinitely),
   not at the recompute level (recomputes always run to completion).
   The library's scheduler is where the "N re-runs per cycle" guard lives.
   This is a *new* sub-question for Q-C — not "consumer shape" (resolved
   in H1a-c) but "consumer-driven cycle detection."

4. **Q-E (signal vs computed asymmetry) does *not* matter here.** The
   re-entrant write is to a Signal slot; the trace would work the same
   way if it were to a Computed slot (Computed slots can also be written
   via promotion, etc.). The recompute discipline is uniform.

5. **A new question about read coherence.** Inside a recipe body that
   does `setShadow(...)` then `get(shadow)`, does the second read see
   the new shadow value? Under Position B's "write synchronously, fire
   later" — yes, because the slot is updated synchronously. Worth
   making explicit: **writes are visible within the recipe body that
   issued them, even before edges fire.** Read-your-own-write is
   intra-body.

### Lean

I lean **Position B (permit + defer fires)** with one library-side guard
(consumer cycle detection). Reasons:

1. *Consistent with r3's existing behaviour* — `setSignal` updates value
   synchronously, defers notification via the dirty heap. The pulse Model
   2 fork would essentially make this explicit (a `deferredFires` queue
   gated on `currentTracker`).
2. *Doesn't ban legitimate patterns.* Memoised shadow projections, cache
   warming, derived metrics — these are all useful and don't necessarily
   indicate bugs.
3. *Cycle detection at the consumer level is the right granularity* —
   cycles only loop if a consumer keeps demanding the same value, which
   the scheduler already coordinates. A "max re-runs per microtask cycle"
   guard catches infinite loops without false-positives on legitimate
   self-modifying recomputes.
4. *Programmer error is still detectable.* Even Position A doesn't catch
   *all* infinite loops (it just bans the trivial direct case); the
   consumer-level guard catches the more general case.

But the lean is *soft*. Position A has real ergonomic appeal — "writes
during recompute are bugs" is a strong invariant. Pulse may end up shipping
**a mode flag** that toggles between A (strict, dev-mode) and B (permissive,
production). Mode flags are a hedge against locking in.

### New sub-questions surfaced

1. **Deferral propagation across nested invokes.** The sketch propagates
   `deferredFires` up to the outermost invoke. Is that the right
   granularity, or should each invoke's deferred fires fire when *that*
   invoke returns (so a transitive read sees a consistent intermediate
   state)? The trace suggests outermost — but for nested speculations
   (action inside action), the answer might be "fire at the action
   boundary" instead. Open.

2. **Consumer cycle-detection policy.** Max re-runs per microtask, or
   per-second, or detect "this consumer scheduled itself with no input
   change"? Library design call. **New Q-J candidate.**

3. **`untrack` interaction.** Calling `setShadow` inside an
   `untrack(() => ...)` block: does the deferral still apply? Per the
   tracker/scope separation, `untrack` clears `currentTracker` but not
   `currentScope`. So `deferredFires` (which is gated on tracker) would
   *not* defer in untrack — writes would fire synchronously. That's
   plausible but worth confirming. Connects to L1 in the catalog.

4. **The Position A escape hatch.** If A is the default, what's the
   sanctioned way to do *needed* re-entrant writes? `Promise.resolve().then(
   () => setShadow(0))` to defer to next microtask? An explicit
   `defer(() => setShadow(0))` helper? Library shape, open.

### Framings status after K1

All four framings held:

- *Node-as-recipe*: re-entrant writes don't break the framing — the recipe
  is just JavaScript that happens to call a setter.
- *Walks-first-class*: `get` and `writeSlot` are walks; their composition
  during recompute is the policy question.
- *Slim engine + thick library*: Position B's deferral is implementable
  with one engine flag (`deferredFires`) and library-side scheduling. No
  new engine machinery beyond what's already sketched.
- *Scope/owner unification*: the re-entrant write inherits the scope from
  the recompute it's nested in. The scope/tracker pair pushes and pops
  together as a unit.

**No falsifications.** But K1 is the first traced scenario where the
architecture itself doesn't pick a winner between two real positions (A vs
B). That's *signal* — it tells us the question is genuinely a *design call*
the engine machinery can support either way, and pulse has to make it
deliberately. Worth keeping the call open in the doc.

### K1b sub-trace: write inside recipe, then read downstream derived

A scenario that was not part of the original K1 wording — surfaced by a
user question:

```ts
const [name, setName] = signal("foo")
const doubleName = computed(() => get(name) + get(name))

const weird = computed(() => {
  setName("name")                         // write
  return get(doubleName).capitalize()    // read of downstream derived
})
```

Assume `doubleName.slots[ROOT_SCOPE].cached = "foofoo"` (from an earlier
read).

**Under Position B (defer fires during recompute):**

- Recipe runs. `deferredFires = []` (tracker active).
- `setName("name")`: `writeSlot(name, ROOT_SCOPE, …)`. `name.slot[ROOT_SCOPE]
  .cached = "name"` (synchronous). Fire deferred → queue
  `{ name, ROOT_SCOPE }`.
- `get(doubleName)`: `invoke(doubleName, ROOT_SCOPE)`. Slot exists, cached
  `"foofoo"`. **Is the slot dirty?** No — the fire was deferred, so the
  dirty flag was never set. Returns `"foofoo"`.
- Recipe: `"foofoo".capitalize() = "Foofoo"`. Cache `weird.slot = "Foofoo"`.
- Pop tracker, drain queue. Fire `name → doubleName` edge. Mark
  `doubleName.slot` dirty. (Too late.)

**Result under (B): `get(weird) = "Foofoo"`. Stale.** ✗

The reason: deferred fires mean *the dirty flag on `doubleName.slot` isn't
set until after the recipe returns*. The in-recipe `get(doubleName)`
finds the slot clean and returns the stale cached value.

**Under Position C (fire synchronously):**

- Recipe runs. No deferral.
- `setName("name")`: `writeSlot(name, ROOT_SCOPE, …)`. Walk edges
  immediately. Fire `name → doubleName`. Mark `doubleName.slot` dirty.
- `get(doubleName)`: `invoke(doubleName, ROOT_SCOPE)`. Slot is dirty.
  **Recompute**: reads `name` (now `"name"`), returns `"namename"`. Cache,
  clear dirty.
- Recipe: `"namename".capitalize() = "Namename"`. Cache.

**Result under (C): `get(weird) = "Namename"`. Fresh.** ✓

### Why the original K1 trace missed this

The original K1 used `setShadow(c * 2); return c + 1` — the recipe wrote
to `shadow` but didn't *read* anything afterward, just returned. Without a
follow-up read of a derived value, Position B looked fine because the
deferred fires got drained after the recipe returned, with no
opportunity to observe the stale state mid-recipe.

K1b is the case that distinguishes (B) from (C). The catalog's original
K1 was *under-specified*: it tested "is the write permitted?" but not
"is in-recipe state coherent across the write?" Two different questions;
only the second probes the synchronous-vs-deferred-fires mechanism.

### Why (C) doesn't cause re-entrant invocation

The original K1 trace ruled out (C) with "synchronous firing mid-recompute
creates re-entrant invocation of the current recompute." This was a
confusion. Let's name the operations precisely:

- **`writeSlot`** updates `slot.cached` and walks outgoing edges.
- **`fireEdges`** for each matching edge: mark target slot dirty, emit a
  slot-changed event to subscribers.
- **Consumer** (Effect, Computed-cache, JSX-binding) receives the event
  and responds. Effects: `scheduleMicrotask(runBody)`. Computeds: no-op
  beyond the dirty flag (next demand recomputes). JSX: schedule DOM
  update.

Firing is just *mark dirty + emit event + queue microtask*. Crucially,
**consumers do not synchronously invoke bodies** — effects schedule async,
computeds wait for demand. So "fire synchronously inside a recipe" doesn't
re-enter the current recompute's body. It just sets flags on downstream
slots, which the current recompute may then encounter via its own reads
(triggering recomputes of *those* slots, not the current one).

### The cycle subcase under (C)

```ts
const incrementer = computed(() => {
  const c = get(count)
  setCount(c + 1)
  return c
})
```

- `get(count)`: edge formed `count → incrementer.slot`.
- `setCount(c+1)`: `writeSlot(count, …)`. Walk edges. Fire `count →
  incrementer.slot`. Mark `incrementer.slot` dirty.
- But `incrementer.slot` is currently being recomputed. Marking it dirty
  just sets a flag. The recompute completes, caches `c`, leaves dirty
  set.
- Next demand for `incrementer`: dirty, recompute. `c = new value`,
  `setCount` again, mark dirty. Cached, dirty.

Pull-driven: one recompute per demand. No infinite synchronous loop. An
Effect consumer pulling each microtask loops — caught at consumer level
("max N re-runs per microtask cycle → bail").

(C) doesn't make cycles worse than (B). It just makes the non-cycle case
correct.

### Architecture exposed (post-revision)

K1's design call **dissolves**:

- **(A) Hard ban** — incompatible with effects (per the H1a-c-derived
  observation that effects need to write inside their bodies). The engine
  doesn't know "this tracker is a computed's recipe vs. an effect's body"
  without violating the one-Node-primitive framing.
- **(B) Permit + defer fires** — returns *stale* values on K1b. **Wrong.**
- **(C) Permit + fire synchronously** — handles K1b correctly; cycles
  caught at consumer level; no re-entrant invocation.

**Settled: (C).** This is essentially r3's model (writes propagate dirty
to subs synchronously; consumers schedule async via the heap + microtask).
Pulse adopts the same semantics, just with Model 2 selectors gating which
edges actually fire.

Implication for Q-J (commit-as-transaction): the deferred-fires region is
**commit-mode-only**, not tracker-mode. Recipes don't defer; commits do.
The two modes don't interfere because a recipe inside a commit is rare
(commits are themselves outside any recompute).

### Updated framings status after K1+K1b

All four framings still hold:

- *Node-as-recipe*: recipes can write; engine doesn't distinguish kinds.
- *Walks-first-class*: writes propagate dirty via selector chains;
  consumers receive events.
- *Slim engine + thick library*: (C) requires no special engine
  machinery for recipes — just the normal fireEdges path. Cycle detection
  is library code.
- *Scope/owner unification*: unaffected.

**The architecture itself picks (C).** What looked like a deliberate
policy choice (A vs B) was actually a tracing under-specification (K1
didn't probe the write-then-read-derived case that distinguishes B from
C). With the right scenario (K1b), the answer falls out.

---

## End-to-end trace: G2 — nested actions and commit promotion

A worked trace verifying that the chain-selector mechanism handles nested
actions cleanly, and surfacing the inner-promotes-to-outer-vs-direct-to-ROOT
design call. G2 was identified as the smallest-cheap trace that forces a
real policy choice into the open.

### The question

Two positions on what *inner-action commit* should do:

- **(i) Inner promotes to outer.** Inner's slots (tagged `S2`) get promoted
  to the outer's scope (`S1`), not directly to `ROOT_SCOPE`. Outer continues
  with the inner's writes folded into its scope; outer-commit later promotes
  to `ROOT_SCOPE`. Database "savepoint" semantics — inner's effects are
  *conditional on outer's commit*.
- **(ii) Inner promotes directly to ROOT.** Inner-commit publishes
  immediately; outer's scope doesn't see inner's writes (because the chain
  would still resolve to the outer's earlier slot). Independent-transaction
  semantics.

The architecture forces (i), as the trace shows — but the *why* is worth
walking through.

### Setup

```ts
const [count, setCount] = signal(0)
const [name, setName] = signal("foo")
const outerReads: any[] = []
const innerReads: any[] = []

action(function* () {                       // outer scope S1
  setCount(10)
  outerReads.push(get(count))              // expect: 10

  action(function* () {                     // inner scope S2, child of S1
    setCount(20)
    setName("bar")
    innerReads.push(get(count))            // expect: 20
    innerReads.push(get(name))             // expect: "bar"
  })

  // After inner commits — what does outer see?
  outerReads.push(get(count))              // expect under (i): 20
  outerReads.push(get(name))               // expect under (i): "bar"
})

// After outer commits
get(count)                                 // expect: 20
get(name)                                  // expect: "bar"
```

Initial state: `count.slots = {}`, `name.slots = {}`. The signals have only
their `defaultRecipe`s.

### Step-by-step trace under Position (i)

**Step 1: outer opens.** `openScope()` → `S1 = { parent: ROOT_SCOPE,
cleanups: [], status: 'open' }`. Push `S1` as ambient.

**Step 2: `setCount(10)` under `S1`.**
- `getCurrentScope()` → `S1`. `writeSlot(count, S1, { recipe: () => 10,
  cached: 10, deps: [], subs: [] })`.
- Engine walks `count`'s outgoing edges with `(count.slots, S1)`. None (no
  prior reads). Set `count.slots[S1]`.

**Step 3: `get(count)` inside outer body.**
- `getCurrentScope()` → `S1`. `currentTracker` → null (action body
  imperative, no tracking).
- `invoke(count, S1)`. Engine: `count.slots.get(S1)` hit, cached 10.
  Return 10.
- `outerReads.push(10)`.

State after Step 3:
```
count.slots = { S1: cached 10, subs: [] }
S1.status = 'open', ambient = S1
```

**Step 4: inner opens.** Nested `action(...)` call. `openScope()` →
`S2 = { parent: S1, cleanups: [], status: 'open' }`. Push `S2` as ambient
(the current-scope stack is now `[ROOT_SCOPE, S1, S2]`).

**Step 5: `setCount(20)` under `S2`.**
- `getCurrentScope()` → `S2`. `writeSlot(count, S2, { recipe: () => 20,
  cached: 20, … })`.
- Engine walks `count`'s outgoing edges with `(count.slots, S2)`. None.
  Set `count.slots[S2]`.

**Step 6: `setName("bar")` under `S2`.**
- Same shape. `name.slots[S2] = "bar"`.

**Step 7: `get(count)` inside inner body.**
- `getCurrentScope()` → `S2`. `invoke(count, S2)`. Hit. 20.
- `innerReads.push(20)`. ✓

**Step 8: `get(name)` inside inner body.**
- `invoke(name, S2)`. Hit. "bar".
- `innerReads.push("bar")`. ✓

State after Step 8:
```
count.slots = { S1: cached 10, S2: cached 20 }
name.slots = { S2: cached "bar" }
```

(Note: `name.slots` has no `S1` entry — the outer never wrote to `name`. The
inner created `S2` directly.)

**Step 9: inner returns. `closeScope(S2, 'commit')`.**

Library promotes each `S2`-tagged slot to the *parent* scope, `S1`:

- *Promote `count`:* `writeSlot(count, S1, { recipe: () => 20, cached:
  20, … })`.
  - Engine walks `count`'s outgoing edges with `(count.slots, S1)`. None.
  - Overwrite `count.slots[S1]` (was 10; now 20).
- *Drop `count.slots[S2]`:* walk `slot.subs` (empty); delete.
- *Promote `name`:* `writeSlot(name, S1, { recipe: () => "bar", cached:
  "bar", … })`.
  - Walk `name`'s edges. None. Create `name.slots[S1]`.
- *Drop `name.slots[S2]`:* empty subs; delete.
- `S2.status = 'committed'`. Pop ambient back to `S1`.

State after Step 9:
```
count.slots = { S1: cached 20, subs: [] }              # was 10, now 20
name.slots = { S1: cached "bar", subs: [] }
S2: committed
ambient = S1
```

The inner's writes have been "lifted" into the outer's scope. From the
outer's perspective, it's as if the inner had been inlined into the outer
body's flow.

**Step 10: `get(count)` after inner commits (still in outer body).**
- `invoke(count, S1)` → hit, 20. `outerReads.push(20)`. ✓

**Step 11: `get(name)` after inner commits.**
- `invoke(name, S1)` → hit, "bar". `outerReads.push("bar")`. ✓

**Step 12: outer returns. `closeScope(S1, 'commit')`.**

Library promotes each `S1`-tagged slot to `ROOT_SCOPE`:

- `writeSlot(count, ROOT_SCOPE, { recipe: () => 20, cached: 20, … })`.
  - Walk `count`'s outgoing edges with `(count.slots, ROOT_SCOPE)`. None.
  - Create `count.slots[ROOT_SCOPE]`.
- Drop `count.slots[S1]`.
- `writeSlot(name, ROOT_SCOPE, { recipe: () => "bar", cached: "bar", … })`.
- Drop `name.slots[S1]`.
- `S1.status = 'committed'`. Pop ambient to `ROOT_SCOPE`.

Final state:
```
count.slots = { ROOT_SCOPE: cached 20 }
name.slots = { ROOT_SCOPE: cached "bar" }
```

`get(count)` outside → 20. `get(name)` → "bar". ✓

### Why Position (ii) doesn't work under the framing

Suppose instead the inner promoted *directly to ROOT_SCOPE*:

**Step 9 (alternate):** `closeScope(S2, 'commit')` promotes to ROOT:
- `writeSlot(count, ROOT_SCOPE, { cached: 20, … })`.
- `writeSlot(name, ROOT_SCOPE, { cached: "bar", … })`.
- Drop `S2` slots.

State after Step 9 alt:
```
count.slots = { S1: cached 10, ROOT_SCOPE: cached 20 }
name.slots = { ROOT_SCOPE: cached "bar" }
ambient = S1
```

**Step 10 (alternate):** `get(count)` in outer body. `getCurrentScope()` →
`S1`. `invoke(count, S1)` → hit, **cached 10**. `outerReads.push(10)`. ✗

The outer's read returns *the outer's earlier write*, not the inner's
post-commit value. The chain `[S1, ROOT_SCOPE]` resolves to `S1` first; the
inner's commit-to-ROOT is invisible.

It gets worse at outer-commit. **Step 12 (alternate):** `closeScope(S1,
'commit')` promotes `count.slots[S1]` (still cached 10) to `ROOT_SCOPE`. This
**overwrites the inner's earlier commit-to-ROOT** with the outer's stale
value. Final `count.slots[ROOT_SCOPE].cached = 10`. **The inner's commit was
clobbered.**

Position (ii) doesn't work without additional bookkeeping — the engine would
have to detect "outer's slot is stale because a nested scope committed
through it" and refuse to promote the stale value. That's machinery the
nesting model already does for free in Position (i).

**Position (i) is the architecturally correct answer.** The chain mechanism
naturally encodes savepoint semantics; we don't need to engineer them
separately.

### Discard variants

**Inner discards; outer continues.** Setup: inner body throws.
- `closeScope(S2, 'discard')`: drop `count.slots[S2]`, drop `name.slots[S2]`.
  Fire `S2.cleanups` (none). `S2.status = 'discarded'`.
- State: `count.slots = { S1: 10 }`, `name.slots = {}`.
- Outer continues. `get(count)` under `S1` → 10. `get(name)` under `S1` →
  chain `[S1, ROOT_SCOPE]` miss-miss → `name.defaultRecipe()` → "foo".
- Outer-commit later: `count.slots[ROOT_SCOPE] = 10`, `name.slots` stays empty
  (no `S1` slot to promote).
- ✓ Inner's effects fully unwound.

**Outer discards; inner had committed.** Setup: outer body throws after
inner returns.
- After inner commits: `count.slots = { S1: 20 }`, `name.slots = { S1: "bar" }`.
- `closeScope(S1, 'discard')`: drop both `S1` slots.
- ✓ Outer discard rolls back both outer's *and* inner's writes. Savepoint
  semantics: inner's commit is conditional on outer's commit. Databases work
  the same way.

If a use case ever surfaces where the inner should *survive* outer discard
(autonomous inner action), it would be a *different primitive* — not nested
`action`. Pulse can pick a different name (e.g., `independentAction(...)`)
later if needed.

### Edge invalidation across nested commits

What about external consumers that subscribed to `count` or `name`?

Consider an Effect outside both actions:
```ts
let observed = -1
effect(() => { observed = get(count) })   // chain [ROOT_SCOPE]
```

Initial run: `observed = 0` (from `count.defaultRecipe`). Edge formed:
`count → effectSlot` with `chainSelector([ROOT_SCOPE])`.

During the nested actions above, does the effect re-run?
- *Step 2 (setCount under S1):* writeScope=`S1`. Effect's chain
  `[ROOT_SCOPE]`. `chain.indexOf(S1)=-1`. **Don't fire.** ✓
- *Step 5 (setCount under S2):* writeScope=`S2`. Don't fire. ✓
- *Step 9 (inner-commit: writeSlot count to S1):* writeScope=`S1`. Effect
  chain `[ROOT_SCOPE]`, doesn't include S1. **Don't fire.** ✓
- *Step 12 (outer-commit: writeSlot count to ROOT_SCOPE):* writeScope=
  `ROOT_SCOPE`. Effect chain `[ROOT_SCOPE]`, writeIdx=0, no more-specific
  in chain. **Fire.** Effect invalidates, scheduler queues re-run.
- Effect re-runs, observes `count = 20`. ✓

The effect fires *exactly once* after outer commits — not on inner-commit,
not on the outer's earlier `setCount(10)`. Defer-until-commit (H1a-c) holds
across nesting. The effect sees the final committed value, never the
intermediate `10`.

### Architecture exposed

1. **Nested commits are not a special engine feature.** They're just
   `writeSlot(node, parentScope, slot_content)` — the same primitive used
   everywhere else. The "nesting" lives in the scope hierarchy (each scope
   has a `parent`), and the library's commit logic uses
   `scope.parent` as the target. Engine doesn't know about nesting.
2. **Chain selectors handle multi-level fall-through automatically.** Reads
   under `S2` walk `chainFor(S2) = [S2, S1, ROOT_SCOPE]`. Each scope in the
   chain is just an opaque key to the engine; the library composes the
   chain from `scope.parent` walks.
3. **Defer-until-commit holds across nesting.** External consumers don't
   see inner-commits, only the outermost commit. Each inner-commit is a
   write to an intermediate scope that *no external chain matches*.
4. **Savepoint semantics fall out of the chain mechanism.** Inner commits
   are conditional on outer commits; outer discard rolls back inner's
   effects. We get database-style nested-transaction semantics without any
   engine-level transaction machinery.
5. **Q-H (scope nesting via parent pointers).** The scope is a linked
   structure with `parent` pointers. `chainFor` is just `walk parents
   until you hit ROOT_SCOPE`. Confirms the scope-as-tree shape.
6. **Inner-promotes-to-outer is the *only* coherent answer** under our
   framings. Position (ii) requires explicit bookkeeping that doesn't fit
   the architecture; Position (i) requires no new machinery.

### Framings status after G2

All four framings held; **G2 is the cleanest validation of scope/owner
unification so far**. The "scope is a tree" structure naturally encodes
savepoints, and the chain selectors naturally encode "consumers see only the
final-committed value." No new primitive needed for nested actions; the
nesting is *emergent* from the scope hierarchy + the chain mechanism.

The trace forces no design call (unlike K1) — the architecture genuinely
picks Position (i). Worth noting because it's a *positive falsification*:
Position (ii) was tested and ruled out by the trace.

### Sub-questions surfaced

1. **`chainFor` policy.** The library's `chainFor(scope)` walks
   `scope.parent` pointers up to and including `ROOT_SCOPE`. Is this
   always correct? Two edge cases:
   - A user-defined custom scope hierarchy (per-tenant roots, multiple
     reactive "worlds") might want a *non-ROOT_SCOPE* terminal. The
     library should make `chainFor` user-overridable, or expose
     `terminalScope` as a configurable per-tree property.
   - For non-nested contexts (e.g., reads outside any action),
     `chainFor(ROOT_SCOPE) = [ROOT_SCOPE]` is the natural answer.
2. **Edge-ordering during multi-write commits.** Step 9 promoted `count`
   then `name`. If those slots had interlocking edges (a derived computed
   that read both), the *order* of promotion might fire intermediate
   invalidations that re-resolve incorrectly. Same issue as the doubleName
   trace's commit-ordering open question (#1) — dep-order leaves-first is
   the working hypothesis. Worth keeping in mind for complex commits.
3. **Promotion atomicity at the consumer level.** External consumers
   *should* see "outer's commit" as a single event, not a sequence. Right
   now each `writeSlot(node, ROOT_SCOPE, ...)` during commit fires its
   edges immediately. If many writes happen, consumers might see partial
   intermediate states. Solution: same as K1's deferred-fires mechanism —
   commit collects deferred fires and drains them at the end. Probably
   the *commit operation* should itself defer fires until all promotions
   are done.

---

## End-to-end trace: H3 — cleanup chains across speculative effect runs

A worked trace of two related cleanup-discipline scenarios:

- **H3a:** an effect created *inside* an action body, action then discards.
  Tests: do the effect's body cleanups fire as part of the scope discard,
  in the right order, and does the previously-scheduled re-run get suppressed?
- **H3b:** an effect created *outside* an action with an established
  cleanup from its initial run; action commits and triggers the effect.
  Tests: does the previous body's cleanup fire before the new body runs?

H3 is the test that's been called out as "where scope/owner unification
either holds or breaks." Spoiler: it holds, with one design call (effect
chain policy for effects-inside-actions).

### Two kinds of cleanup, distinct in this stack

Before tracing, name the two cleanup mechanisms used in this trace:

- **Scope-level cleanup** — `onCleanup(fn)` called outside an effect body,
  inside any scope (action, component, root). The callback fires when *that
  scope discards*. Sits on `scope.cleanups: Disposable[]`. Used for
  "resource X belongs to this scope; tear it down when the scope ends."
- **Body-level cleanup** — `onCleanup(fn)` called *inside an effect body*.
  Registers a callback that fires before the *next invocation* of that
  effect's body, **or** when the effect itself is disposed. Sits on
  `effectNode.bodyCleanups`. Used for "this body run produced a
  subscription / timer; cancel it before re-running or when the effect
  ends."

These are distinct: `scope.cleanups` is per-scope; `bodyCleanups` is
per-effect-body-invocation. They compose — an effect's disposal triggers
its bodyCleanups; the scope's discard triggers scope-level cleanups *and*
disposes everything that scope owns (including effects).

### The chain policy for effects-inside-actions

Open design call surfacing here: when an effect is created inside an action
body, what's the chain its tracking edges form against?

- **(Policy α) Chain = chainFor(owner).** Effect created inside action `S`
  has chain `[S, ROOT_SCOPE]`. It *fires* on writes inside the action (the
  scope-tagged writes). Useful for "this effect should react to changes
  during the action's life."
- **(Policy β) Chain = `[ROOT_SCOPE]` always.** Effects only fire on
  committed-state changes regardless of where created. The effect's
  lifecycle is tied to the owner, but its subscription isn't.

H1a-c established that effects *outside* actions have chain `[ROOT_SCOPE]`
and don't fire on speculative writes. This is the same answer under both
policies (an outside-effect's owner *is* `ROOT_SCOPE`, so `chainFor(owner)
= [ROOT_SCOPE]` under α, matching β).

The policies diverge for inside-action effects. **Lean: Policy α** — the
effect's chain follows its owner, because that's the natural composition.
The user creating an effect inside an action body is opting into reacting to
the action's intermediate state; if they wanted committed-only reactivity,
they wouldn't put the effect inside the action. β is defensible but
narrower.

This trace uses Policy α. Both policies survive H3a/H3b cleanly; the trace
just looks slightly different under each.

### Setup

```ts
const [count, setCount] = signal(0)
const teardowns: string[] = []
const log: string[] = []

const handle = action(function* () {                 // outer scope S
  effect(() => {
    const c = get(count)
    log.push(`Effect ran with count=${c}`)
    onCleanup(() => teardowns.push(`cleanup at count=${c}`))
  })
  setCount(5)                                         // triggers effect's edge
  // (we'll vary what happens next per H3a/H3b)
})
```

### H3a: action discards mid-flight

**Step 1: open scope `S`.** `openScope()` → `S = { parent: ROOT_SCOPE,
cleanups: [], status: 'open' }`. Push ambient.

**Step 2: `effect(fn)` called.**
- `getCurrentScope()` → `S`. `effectNode` = `createNode(fn)`. Owner = `S`,
  subscription chain = `chainFor(S)` = `[S, ROOT_SCOPE]`.
- Register `S.cleanups`-side disposer: when `S` discards, dispose
  `effectNode` (fires its `bodyCleanups`, unlinks remaining edges).
- Initial body run:
  - `pushTracker(effectNode.slots[S])`, `pushScope(S)`.
  - `get(count)`:
    - `link(count, chainSelector([S, ROOT_SCOPE]), effectNode.slots[S])` →
      `edge1`.
    - `invoke(count, S)` → miss → `count.slots[S]` created (read-populated;
      `wasWritten = false`, per Q-I). Recipe = `() => 0`, `cached = 0`.
  - Body: `c = 0`. `log.push("Effect ran with count=0")`. `onCleanup(cb)`
    registers a *body-level* cleanup: `cb = () => teardowns.push(
    "cleanup at count=0")`. `effectNode.bodyCleanups = [cb]`.
  - Pop tracker, pop scope.
- `subscribe(effectNode, handler)` — handler queues microtask re-run on
  invalidation.

**State after Step 2:**
```
count.slots = { S: { recipe: () => 0, cached: 0, wasWritten: false } }
effectNode.slots = { S: { recipe: body, cached: undefined, deps: [edge1] } }
edge1 = { source: count, selector: chainSelector([S, ROOT_SCOPE]),
          target: effectNode.slots[S] }
effectNode.bodyCleanups = [cleanupAtZero]
S.cleanups = [disposeEffectNode]
log = ["Effect ran with count=0"]
teardowns = []
```

**Step 3: `setCount(5)` under `S`.**
- `writeSlot(count, S, { recipe: () => 5, cached: 5, wasWritten: true })`.
  (Q-I marker: wasWritten=true overwrites the wasWritten=false slot.)
- Walk `count`'s outgoing edges with `(count.slots, S)`:
  - `edge1.selector` = `chainSelector([S, ROOT_SCOPE])`. writeScope=S,
    writeIdx=0. **Fire.** Invalidate `effectNode.slots[S]`. Emit
    slot-changed event.
- Subscriber receives event. `scheduleMicrotask(runBody)`. Re-run is queued.

**State after Step 3:**
```
count.slots = { S: { recipe: () => 5, cached: 5, wasWritten: true } }
effectNode.slots[S].cached = undefined (invalidated)
microtask queue: [runBody]
log = ["Effect ran with count=0"]
teardowns = []
```

The body cleanup is *still installed* — `effectNode.bodyCleanups =
[cleanupAtZero]`. It hasn't fired yet.

**Step 4: action body throws — `handle.discard()` or generator rejects.**

`closeScope(S, 'discard')`:
1. *Drop `S`-tagged slots.* Walk each slot's `subs`, unlink edges.
   - `count.slots[S].subs = [edge1]`. Unlink `edge1`: remove from
     `count.slots[S].subs` and from `effectNode.slots[S].deps`.
   - Drop `count.slots[S]`.
   - `effectNode.slots[S]`: drop. Walk its `subs` (none). Done.
2. *Fire `S.cleanups`.* `S.cleanups = [disposeEffectNode]`.
   - `disposeEffectNode()`:
     - Walk `effectNode.bodyCleanups`. Fire each.
       - `cleanupAtZero()` → `teardowns.push("cleanup at count=0")`.
     - `effectNode.bodyCleanups = []`.
     - Mark `effectNode` as disposed.
3. `S.status = 'discarded'`. Pop ambient.

**State after Step 4:**
```
count.slots = {}
effectNode: disposed (slots map empty; bodyCleanups empty)
edges: edge1 unlinked (gone)
log = ["Effect ran with count=0"]
teardowns = ["cleanup at count=0"]
microtask queue: [runBody]   ← still queued!
```

**Step 5: microtask drains.**
- `runBody()` is called.
- *Guard:* check `effectNode.disposed === true`. **Yes.** Bail. ✓
- (Alternative: the scheduler unhooks the subscription on dispose, so the
  microtask is never enqueued in the first place. Either works; the
  guard-on-resume pattern is the simpler/safer one.)

**Final state for H3a:**
```
count.slots = {}                                     # restored to pre-action
effectNode: gone
log = ["Effect ran with count=0"]                    # one body run
teardowns = ["cleanup at count=0"]                   # cleanup fired exactly once
```

✓ The effect ran once (at creation), saw the pre-action state, and its
cleanup fired exactly once when the action discarded. No re-run occurred
because the action discarded before the microtask drained. The action's
speculative writes left no observable trace.

### H3b: action commits — previous body's cleanup fires before re-run

Same setup as H3a, but the action body returns normally instead of
throwing.

**Step 4 (alternate): `closeScope(S, 'commit')`.**

This is where Q-J (commit-as-transaction) is exercised. The library's
commit logic opens a deferred-fires region:

1. *Promote write-populated slots only* (per Q-I).
   - `count.slots[S].wasWritten === true` → promote.
     - `writeSlot(count, ROOT_SCOPE, { recipe: () => 5, cached: 5, … })`.
     - Walk `count`'s edges with `(count.slots, ROOT_SCOPE)`:
       - `edge1.selector` = `chainSelector([S, ROOT_SCOPE])`. writeScope=
         ROOT_SCOPE, writeIdx=1. Check more-specific: `count.slots.has(S)`?
         **Yes** (we haven't dropped `S` slots yet). Don't fire.
   - `effectNode.slots[S].wasWritten === false` → don't promote (it's a
     consumer-cache, not user-state).
2. *Drop `S`-tagged slots.*
   - `count.slots[S].subs = [edge1]`. Unlink `edge1`. Drop.
   - `effectNode.slots[S]`: drop.
3. *Fire `S.cleanups`.* `disposeEffectNode()` fires `cleanupAtZero` →
   `teardowns.push("cleanup at count=0")`. Mark effectNode disposed.
4. *Close deferred-fires region.* No deferred fires queued (the write to
   `ROOT_SCOPE` in step 1 didn't fire `edge1`).
5. `S.status = 'committed'`.

**Final state for H3b:**
```
count.slots = { ROOT_SCOPE: { recipe: () => 5, cached: 5 } }
effectNode: disposed
log = ["Effect ran with count=0"]
teardowns = ["cleanup at count=0"]
```

Hmm — the effect was disposed at commit, so it didn't re-run with the
committed value. Is that what we want?

**Yes, for effects created inside the action.** The effect's owner is `S`;
when `S` closes (commit or discard), the effect disposes. Effects don't
*outlive* their owners. For an effect that should persist past the action,
the user would create it in an outer scope (component, root) — *its* owner
would be that outer scope, not the action.

This is conventional reactive-framework semantics (Solid, MobX, S.js): an
effect's owner is its containing context, and effects die when their
containers die. Pulse's scope/owner unification preserves this.

The "previous body's cleanup fires before re-run" semantics — what H3b's
title suggests — applies to a different scenario: an effect that
*persists across the action* (i.e., was created outside the action).
Let me trace that too, as H3b'.

### H3b': previous body's cleanup fires before re-run (effect outside action)

```ts
const [count, setCount] = signal(0)
const log: string[] = []
const teardowns: string[] = []

effect(() => {                                       // created outside any action; owner = ROOT_SCOPE
  const c = get(count)
  log.push(`Effect ran with count=${c}`)
  onCleanup(() => teardowns.push(`cleanup at count=${c}`))
})
// log = ["Effect ran with count=0"], teardowns = []
// effectNode.bodyCleanups = [cleanupAtZero]

action(function* () {
  setCount(5)
})
// after commit, the effect should re-run with count=5;
// cleanupAtZero should fire first, then the new body runs.
```

**Initial setup.** Effect's owner = `ROOT_SCOPE`, subscription chain =
`[ROOT_SCOPE]`. `edge1` formed: `count → effectNode.slots[ROOT_SCOPE]`,
selector `chainSelector([ROOT_SCOPE])`. After initial run:
`bodyCleanups = [cleanupAtZero]`. Log has "Effect ran with count=0".

**Action runs. Inside `S`:**
- `setCount(5)`: `writeSlot(count, S, { … })`. `edge1.selector` against
  writeScope=S: chain doesn't include S → don't fire. ✓ (H1a-c.)

**Commit.**
- Promote: `writeSlot(count, ROOT_SCOPE, { recipe: () => 5, cached: 5 })`.
- `edge1.selector` against writeScope=ROOT_SCOPE: writeIdx=0, no
  more-specific → **fire.** Invalidate `effectNode.slots[ROOT_SCOPE]`.
  Emit invalidation event.
- Subscriber: `scheduleMicrotask(runBody)`.
- Drop `count.slots[S]`.
- `S.status = 'committed'`. (`S.cleanups` is empty; effectNode isn't owned
  by `S`, it's owned by `ROOT_SCOPE`.)

**Microtask: `runBody`.**
- *Guard:* `effectNode.disposed === false`. Proceed.
- *Fire previous bodyCleanups first.* `cleanupAtZero()` →
  `teardowns.push("cleanup at count=0")`. `bodyCleanups = []`.
- *Unlink stale `deps`.* `effectNode.slots[ROOT_SCOPE].deps = [edge1]`.
  Unlink each — remove `edge1` from `count.slots[ROOT_SCOPE].subs` and
  from `effectNode.slots[ROOT_SCOPE].deps`.
- *Push tracker, push scope. Invoke body.*
  - `get(count)`: `link(count, chainSelector([ROOT_SCOPE]),
    effectNode.slots[ROOT_SCOPE])` → `edge1'`. `invoke(count, ROOT_SCOPE)`
    → hit, return 5.
  - Body: `c = 5`. `log.push("Effect ran with count=5")`. `onCleanup(...)`
    → registers `cleanupAtFive`. `bodyCleanups = [cleanupAtFive]`.
- Pop tracker, pop scope.

**Final state for H3b':**
```
count.slots = { ROOT_SCOPE: cached 5 }
effectNode.slots = { ROOT_SCOPE: { cached: undefined, deps: [edge1'] } }
edge1' (fresh identity, same shape)
log = ["Effect ran with count=0", "Effect ran with count=5"]
teardowns = ["cleanup at count=0"]
bodyCleanups = [cleanupAtFive]
```

✓ The previous body's cleanup (`cleanupAtZero`) fired *before* the new
body ran. The new body registered its own cleanup (`cleanupAtFive`)
which will fire on the next re-run or on effect disposal.

### Architecture exposed

H3 traced cleanly under Policy α with one composition that's worth
naming explicitly:

1. **Two cleanup mechanisms compose at the scope-discard boundary.**
   `scope.cleanups` (the scope's own disposers) and `effectNode.
   bodyCleanups` (per-body cleanups). Scope discard fires its own
   cleanups; among those, the effect's *disposer* fires the effect's
   bodyCleanups. **The composition is one-way** (scope discard → effect
   dispose → bodyCleanups fire), and the engine doesn't know about
   bodyCleanups at all — it just fires `scope.cleanups`, and the effect's
   disposer (registered into `scope.cleanups` at creation) does the
   inner unwinding.
2. **Effect lifetime is owner-scope lifetime.** Effects don't outlive
   their owners. Pulse follows the conventional Solid / S.js / MobX
   model. An effect that should persist across an action is created
   outside it.
3. **Body cleanups fire *before* re-run, not on resume.** The microtask
   `runBody` fires the previous body's cleanups first, then unlinks
   stale deps, then invokes the body anew. r3's recompute pattern (run
   disposal → recompute) carries forward unchanged.
4. **Q-I (read-populated vs write-populated) was load-bearing in H3a.**
   The trace explicitly distinguished `count.slots[S].wasWritten = true`
   (from setCount) vs `effectNode.slots[S].wasWritten = false` (from
   the body invoking the recipe). Only the write-populated slot
   promotes on commit. Confirms Q-I's lean toward the (ii) library-side
   `writeSet` is the right call — though the trace uses the simpler
   per-slot `wasWritten` flag for clarity.
5. **Q-J's deferred-fires region is straightforward at the commit
   boundary.** No deferred fires were actually generated in H3b
   because the promoted write's selector check (chain `[S, ROOT_SCOPE]`,
   write to ROOT_SCOPE, S still has a slot) didn't fire. The deferral
   region exists but was empty. Worth noting: in a multi-write commit,
   the region would actually batch fires.
6. **Policy α survives discard cleanly.** Effects-inside-actions fire on
   action-scope writes, invalidate, schedule re-runs — and the re-runs
   are absorbed by the dispose guard if the scope discards before the
   microtask drains. No spurious effect runs leak past the action.
7. **The microtask-drain-after-dispose race is non-issue.** Synchronous
   `closeScope` completes before any microtask fires; by the time
   `runBody` runs, the effect is disposed and the guard bails.

### Open sub-questions surfaced

1. **Effect chain policy.** Policy α (effects-inside-actions track the
   action scope) vs Policy β (effects always track ROOT_SCOPE only). The
   trace used α; β would mean an effect inside an action never reacts
   during the action body, only at commit (or dispose). Both are coherent.
   *Lean α* (composition is more natural), but **this is a real design
   call** worth keeping open. Adding as Q-K candidate.
2. **Effect re-parenting on commit.** Currently the trace disposes
   in-action effects at action close (commit or discard). An alternative:
   on commit *only*, re-parent the effect's owner to `S.parent`, so the
   effect survives. This requires the effect's chain to also update from
   `[S, ROOT_SCOPE]` to `[ROOT_SCOPE]` (or `[S.parent, ROOT_SCOPE]`).
   Probably not worth it — users wanting persistent effects create them
   in the outer scope. But noting as open.
3. **Cleanups during multi-write commits.** Step 4 (alternate) in H3b
   fired the effect's bodyCleanups after dropping S slots but before
   `S.status = 'committed'`. If an effect's bodyCleanup itself calls
   `writeSlot` (re-entrancy during cleanup), the deferred-fires region
   (Q-J) should absorb that. The trace didn't exercise it. Worth
   tracing if K1-style re-entrancy concerns surface here.
4. **`onCleanup` outside an effect body but inside an action.** What's
   the registration target? Working assumption: `scope.cleanups` of the
   ambient scope, which is the action. Fires on action discard or
   commit (both — scope cleanups are blind to commit-vs-discard).
   Different from body cleanups, which are tied to the effect lifecycle.
   Worth being explicit; not yet in the doc.

### Framings status after H3

All four framings held:

- *Node-as-recipe*: effects are Nodes with bodies-as-recipes. Same shape.
- *Walks-first-class*: `get` inside the body forms edges with the right
  chain (per Policy α, the chain is the effect's owner's chain).
- *Slim engine + thick library*: all the cleanup-chain composition is
  library code. The engine just fires `scope.cleanups` on discard; the
  library's effect disposer (registered there at creation) does the
  inner unwinding.
- *Scope/owner unification holds with one design call*: the unification
  makes effect-disposal = scope-discard natural, but Policy α vs β is
  the real call (does subscription chain follow owner, or always
  `[ROOT_SCOPE]`?). Both are coherent compositions; α is the lean.

**No falsifications.** H3 confirmed that the cleanup-chain composition
across speculative boundaries works cleanly — bodyCleanups fire via the
effect disposer registered into `scope.cleanups`. Two cleanup mechanisms,
one-way composition, engine knows about one, library composes the other.

The Policy α/β question is added to the next-level sub-questions; the
mechanism doesn't pick a winner.

---

## End-to-end trace: C2e — post-yield derived read (async K1b analogue)

The canonical async coherence probe. An action body awaits a Promise via
`yield* get`, then synchronously reads a downstream derived whose recipe
depends on the awaited signal. Tests whether the derived sees the resolved
value or the still-Promise-cached value when the action body resumes.

### Setup

```ts
let resolveUser: (v: string) => void
const userPromise = new Promise<string>(r => { resolveUser = r })
const [user, setUser] = signal<string | Promise<string>>(userPromise)

// Derived computed — stage form (canonical for pulse computeds).
// The stage callback sees the unwrapped value (string); output is Promise<string>.
const greeting = compute(
  () => get(user),                         // stage 0: source — returns Promise<string>
  (u) => `Hello, ${u}!`                    // stage 1: u is string (auto-unwrapped)
)
// greeting: Computed<Promise<string>>

action(function* () {
  const name = yield* get(user)            // park until userPromise resolves
  const g = yield* get(greeting)            // park until greeting resolves
  console.log(g)                             // expect: "Hello, Alice!"
})

// later: resolveUser("Alice")
```

**State at start:** `user.slots = {}`, `greeting.slots = {}` (internally, the
two stage nodes also empty), edges = []. The Promise is pending.

Note: previous iterations of this trace used a generator-form `greeting`
(`compute(function*() { const u = yield* get(user); return ... })`) —
that form is now superseded by stages for computeds (see the "Stages: a
memoized node + a promise auto-unwrap" framing). Generators are retained
for action bodies only, where multi-yield + commit/discard semantics are
needed.

### What `yield* get` does for a Promise-valued slot

`get(node)` is sync — it returns whatever's cached, which may be `T` or
`Promise<T>`. Inside a generator body (recipe or action body), `yield*
get(node)` parks the generator if the slot's cached value is a Promise,
resuming with the resolved value once it settles:

```ts
function* read<T>(node: Node<T>): Generator<ParkCommand, T, T> {
  const scope = getCurrentScope()
  if (currentTracker) link(node, chainSelector(chainFor(scope)), currentTracker)
  const cached = invoke(node, scope) as T | Promise<T>
  if (cached instanceof Promise) {
    const state = promiseState(cached)
    if (state.status === 'fulfilled') return state.value as T
    if (state.status === 'rejected') throw state.reason
    return (yield { kind: 'park', promise: cached } as ParkCommand) as T
  }
  return cached as T
}
```

`use(node)` is the *leaf-only* sibling of this: it throws-to-suspend
inside a restartable context (computed recipe — but per the "Unwrap at
the leaf" framing, computed recipes should use `yield* get` or stage
form instead), or peeks-and-throws-on-pending in non-restartable
contexts. The trace below uses `yield* get` throughout, leaf and
intermediate.

### Step-by-step trace

**Step 1: open scope.** `openScope()` → `S = { parent: ROOT_SCOPE, cleanups:
[], status: 'open' }`. Push ambient.

**Step 2: `yield* get(user)` parks.**

- Library `get(user)`:
  - `getCurrentScope()` → `S`. `currentTracker` → null (action body).
  - `invoke(user, S)`:
    - Engine: `user.slots.get(S)` miss. Create `slot_U_S = { recipe:
      defaultRecipe, deps: [], subs: [] }`. Invoke recipe → `userPromise`.
      `slot_U_S.cached = userPromise`.
    - **Engine .then attach (per Q-D):** since `slot_U_S.cached` is a
      Promise, attach `.then(v => { promiseState writeback; fireEdges(user,
      S, { kind: 'resolved' }) })`. This `.then` is attached **first**
      (during invoke).
    - Return `userPromise`.
  - `get` sees Promise → yields `{ kind: 'park', promise: userPromise }`.
- Action driver receives park. **Driver .then attach:** attaches
  `userPromise.then(name => step(name), …)`. This `.then` is attached
  **second** (during the action driver's park handling).
- Driver returns. Sync portion done. Ambient popped.

**State after Step 2:**
```
user.slots = { S: { recipe: defaultRecipe, cached: userPromise, deps: [], subs: [] } }
userPromise: pending
  .then queue (in attach order): [engine-handler, driver-handler]
no edges
```

**Step 3: `resolveUser("Alice")`.**

`userPromise` resolves. Microtask queue drains `.then` handlers **in attach
order**:

- *Engine handler fires first:*
  - Per Q-D: tweak `userPromise` with `{ status: 'fulfilled', value:
    "Alice" }`.
  - `fireEdges(user, S, { kind: 'resolved' })`. Walk `user`'s outgoing
    edges. **None exist** (the action body's `yield* get` didn't track;
    `greeting` hasn't been read yet). No edges to fire.
- *Driver handler fires second:*
  - Driver `step("Alice")`. Push ambient = S. `gen.next("Alice")`.

**Step 4: generator resumes; `const g = yield* get(greeting)` runs.**

- `gen.next("Alice")` resumes the action body. `name = "Alice"`. Continues
  to `yield* get(greeting)`.
- Library `get(greeting)` (sub-generator):
  - `getCurrentScope()` → `S`. `currentTracker` → null (action body).
  - `invoke(greeting, S)`:
    - Engine: `greeting.slots.get(S)` miss. Create `slot_G_S`. Push
      `currentTracker = slot_G_S`, push scope = `S`. Drive greeting's
      generator-form recipe (the engine drives generator-form recipes
      similarly to how the action driver drives action bodies — see
      main-doc D11):
      - Recipe runs: `function*() { const u = yield* get(user); return
        \`Hello, ${u}!\` }`
      - `yield* get(user)` sub-generator:
        - `link(user, chainSelector([S, ROOT_SCOPE]), slot_G_S)` → `edge1`.
        - `invoke(user, S)` → hit, `cached = userPromise` (tweaked).
        - `get` sees Promise → check `promiseState(userPromise)` →
          `{ status: 'fulfilled', value: "Alice" }`. Returns `"Alice"`
          **synchronously** (no park; the Promise is already resolved).
      - `yield*` delegates `"Alice"` back to greeting's recipe. `u = "Alice"`.
      - Recipe returns `"Hello, Alice!"`.
    - Generator-form compute wraps the return in a resolved Promise:
      `slot_G_S.cached = Promise.resolve("Hello, Alice!")` (tweaked
      `{ status: 'fulfilled', value: "Hello, Alice!" }`). This preserves
      type-level async-ness — `greeting` is `Computed<Promise<string>>`.
    - Pop tracker, pop scope. Return the cached Promise.
  - `get` sees `Promise` → check `promiseState` → fulfilled,
    `"Hello, Alice!"`. Returns `"Hello, Alice!"` **synchronously**.
- `yield*` delegates `"Hello, Alice!"` to the action body. `g =
  "Hello, Alice!"`. `console.log(g)` → prints `"Hello, Alice!"`. ✓

**State after Step 4:**
```
user.slots = { S: { recipe: defaultRecipe, cached: userPromise (tweaked: fulfilled, "Alice") } }
greeting.slots = { S: { recipe: generator-recipe,
                         cached: Promise<"Hello, Alice!"> (tweaked: fulfilled),
                         deps: [edge1] } }
edge1 = { source: user, selector: chainSelector([S, ROOT_SCOPE]), target: slot_G_S }
```

Both slots' `cached` values are Promises tweaked with `{ status:
'fulfilled', value }`. Reads of either node return Promises that
`promiseState` recognises as resolved. Type-level async-ness preserved
through the graph; sync access at the leaf via `yield* get`.

**Step 5: action body returns. `closeScope(S, 'commit')`.**

- Per Q-I: only write-populated slots promote. **Both `user.slot[S]` and
  `greeting.slot[S]` were read-populated** (no `writeSlot` was called
  during the action). So nothing promotes.
- Drop `user.slot[S]` and `greeting.slot[S]`. Walk subs, unlink edges
  (`edge1`).
- `S.status = 'committed'`. Pop ambient.

**Final state:**
```
user.slots = {}
greeting.slots = {}
edges: []
console output: "Hello, Alice!"
```

The action prints `"Hello, Alice!"` — the resolved value. ✓ The
architecture handles C2e correctly.

### The timing dependency that made this work

The trace relies on **`.then` attach order**: the engine attaches its
resolution handler *before* the driver attaches its resume handler. This
order is preserved naturally because:

- The engine's `.then` is attached inside `invoke` (when the recipe returns
  a Promise and the slot gets populated).
- The driver's `.then` is attached *after* `invoke` returns — when `get`
  yields the park command and the driver handles it.

So the engine's tweak always lands before the driver's resume in the
microtask queue. Whew.

**What if this order were reversed?** Then `use(user)` inside `greeting`'s
recipe would see `promiseState = pending` and throw-to-suspend. `greeting`'s
slot would be left in a suspended state. `get(greeting)` would return…
the suspension Promise? Or undefined? **Open ergonomic question** — but the
architecture *doesn't require this case to be handled* because the natural
attach order guarantees engine-first.

If this ever became a real concern (e.g., if a library author attached
their own `.then` between engine and driver), the engine could *enforce*
ordering by making the engine handler always run synchronously inside the
resolution detection — but that's a hypothetical for now.

### What if the action body had also read `greeting` *before* the yield?

A subtly different scenario worth noting. If:

```ts
action(function* () {
  const g0 = get(greeting)               // BEFORE the yield — sync read
  const name = yield* get(user)
  const g1 = yield* get(greeting)        // AFTER the yield — parking read
})
```

Under the corrected setup (generator-form `greeting`):

- *At (A) — `const g0 = get(greeting)` while `user` is pending:*
  `invoke(greeting, S)` runs the generator-form recipe. The recipe does
  `yield* get(user)`, which finds `userPromise` pending → yields a park
  command. The engine attaches `.then` and **the recipe parks mid-flight**.
  `slot_G_S.cached` becomes the pending Promise representing greeting's
  eventual value.
  
  `get(greeting)` returns the Promise. **`g0` is `Promise<string>`,
  pending.** The user gets a Promise back. Sync read of an async slot is
  type-honest: the slot's cached value is `Promise<string>`, and `get`
  returns exactly that.

- *At (C) — `const g1 = yield* get(greeting)` after the yield:*
  `userPromise` resolved → engine handler tweaked it → the parked
  `greeting` generator (registered via .then) resumes, completes, cached
  is now `Promise<"Hello, Alice!">` (tweaked fulfilled). `yield*
  get(greeting)` sees fulfilled, returns `"Hello, Alice!"`.

So in this corrected setup:

| Read site | Returns | Type |
|---|---|---|
| (A) `get(greeting)` before yield | `Promise<string>` (pending) | `Promise<string>` |
| (C) `yield* get(greeting)` after yield | `"Hello, Alice!"` | `string` |

The types are *different at each site by construction*, not by surprise.
`get(greeting)` always returns `Promise<string>` (the static type tells
you so); `yield* get(greeting)` always returns `string` after parking
as needed. The user chooses sync-with-Promise vs park-with-unwrap
explicitly.

### The earlier (anti-pattern) ergonomic surprise — dissolved

The original C2e trace setup used:

```ts
const greeting = computed(() => `Hello, ${use(user)}!`)   // ⚠ anti-pattern
```

`use()` mid-graph collapses `Promise<string>` into `string` at the
callsite, hiding async-ness from greeting's type. Then `get(greeting)`
in the action body had a *misleading* sync-looking type but could
actually return a suspension Promise when `user` was pending. The same
expression returned different types at different times — the surprise.

**Under the corrected setup** (generator-form or stage-form for
`greeting`):

- `greeting` is honestly typed `Computed<Promise<string>>`.
- `get(greeting)` always returns `Promise<string>`. Type is stable.
- `yield* get(greeting)` always returns `string` (parking as needed).
  Type is stable.
- The user chooses by syntax. No surprise.

The earlier surprise was an **artifact of the `use()` mid-graph
anti-pattern**, not an architectural problem with C2e itself. Per the
"Unwrap async at the leaf" framing: intermediate computeds propagate
async-ness through the type; `use()` is reserved for leaf consumption.
With that rule honoured, C2e's coherence story is clean.

### Architecture exposed

C2e traced cleanly. No falsifications. The key findings:

1. **Engine attaches `.then` before driver attaches `.then`.** Natural
   ordering preserved by the call sequence (invoke first, then yield).
   The engine's tweak always lands first.
2. **`use(node)` inside a derived's recipe handles the Promise correctly
   when it's been tweaked.** The recipe gets the resolved value
   synchronously.
3. **The action body's post-yield `get(greeting)` is unaware of any
   complexity** — `greeting` just returns a string. The whole async dance
   is hidden inside `greeting`'s recipe via `use`.
4. **Q-I is load-bearing.** Nothing promoted on commit because all slots
   were read-populated. This is correct — the action didn't *write*
   anything; it just performed reads with side effects (the
   `console.log`). The action's only purpose was awaiting + observing.
   Q-I distinguishes this from a write-and-commit action cleanly.
5. **Q-J commit-as-transaction is uneventful** here. Nothing to promote;
   the deferred-fires region opens and closes with no fires.

### Sub-questions surfaced (small)

- **What if the action body had reads-before-yield that fall through to
  unresolved Promises?** The "Before the yield" walkthrough above shows
  ergonomic surprises (`g0` is a suspension Promise). Library could
  provide a `use(node)` walk usable in action bodies too — not just
  computed recipes — that yields a park command when pending. This makes
  action-body imperative reads parking-aware. **Possibly worth adding to
  Q-C or a new sub-question.**
- **The hypothetical reversed `.then` order**: only concerning if pulse
  exposes `promiseState` as a primitive and a library author attaches
  handlers in unexpected orders. Probably never in practice. Worth noting.

### Framings status after C2e

All four framings still hold. C2e was a *successful coherence trace*: the
architecture composes correctly across `yield* get` → `use` → recipe →
`promiseState`. The audit's worry — "does the engine's `'resolved'` event
have to fire before resume?" — turned out to have a clean answer based on
microtask ordering of `.then` attaches.

**Two framings the trace validated, the second new:**

1. *Derivation kind matches reactivity scope (computed vs effect).* H5's
   sibling: derivations that depend on async signals don't compose
   cleanly inside imperative action bodies without explicit awaits.
2. *Unwrap async at the leaf, not in the middle of the graph.* The
   original C2e setup used `use()` mid-graph (an anti-pattern); the
   corrected setup uses generator-form or stage-form for intermediate
   computeds, with `use()` / `yield* get` reserved for leaf
   consumption. This dissolves the ergonomic surprise into a clean
   sync-vs-park-by-syntax choice.

---

## End-to-end trace: H1d — effect-body coherence on commit

Probes commit-promotion ordering through the effect's lens: when an effect's
body reads both a primitive signal *and* a derived computed that depends on
it, and an action commit promotes the primitive, does the effect's re-run see
the (X, f(X)) pair coherently?

### Setup

```ts
const [count, setCount] = signal(0)
const doubled = computed(() => get(count) * 2)
const observations: Array<{ c: number, d: number }> = []

effect(() => {
  const c = get(count)
  const d = get(doubled)
  observations.push({ c, d })
})
// Initial: observations = [{ c: 0, d: 0 }]

action(function* () {
  setCount(5)
})
// Expected: observations = [{ c: 0, d: 0 }, { c: 5, d: 10 }]
```

### Initial state (after effect registration)

The effect's body ran once at registration, forming edges:

```
count.slots = { ROOT: { cached: 0, subs: [edge_C_D, edge_C_E] } }
doubled.slots = { ROOT: { recipe: () => get(count)*2, cached: 0,
                          deps: [edge_C_D], subs: [edge_D_E] } }
effect.slots = { ROOT: { recipe: body, cached: undefined,
                         deps: [edge_C_E, edge_D_E] } }

edge_C_D = { source: count, selector: chainSelector([ROOT_SCOPE]), target: doubled.slot[ROOT] }
edge_C_E = { source: count, selector: chainSelector([ROOT_SCOPE]), target: effect.slot[ROOT] }
edge_D_E = { source: doubled, selector: chainSelector([ROOT_SCOPE]), target: effect.slot[ROOT] }

observations = [{ c: 0, d: 0 }]
```

### Step 1: open scope

`openScope()` → `S = { parent: ROOT_SCOPE, cleanups: [], status: 'open' }`.

### Step 2: `setCount(5)` inside the action

- `getCurrentScope()` → `S`. `writeSlot(count, S, { recipe: () => 5, cached:
  5, wasWritten: true, deps: [], subs: [] })`.
- Engine walks `count`'s outgoing edges with `(count.slots, S)`:
  - `edge_C_D.selector` = `chainSelector([ROOT_SCOPE])`. `chain.indexOf(S) =
    -1`. **Don't fire.**
  - `edge_C_E.selector` = same. **Don't fire.**
- Set `count.slots[S] = newSlot`.

**State after Step 2:**
```
count.slots = { ROOT: cached 0, S: cached 5 (wasWritten) }
doubled.slots[ROOT] unchanged (cached 0)
effect.slots[ROOT] unchanged
observations still [{ c: 0, d: 0 }]
```

Committed state untouched per H1a-c (the chain doesn't include `S`).

### Step 3: action returns. `closeScope(S, 'commit')`

Per Q-J, open a deferred-fires region (for consumer-side scheduling
deduplication). Per Q-I, promote only write-populated `S` slots:
`count.slots[S]` is wasWritten.

**`writeSlot(count, ROOT_SCOPE, { recipe: () => 5, cached: 5, wasWritten:
true })`:**

- Engine walks `count`'s outgoing edges with `(count.slots, ROOT_SCOPE)`:
  - `edge_C_D`: `chainSelector([ROOT_SCOPE])`. writeScope=ROOT, writeIdx=0,
    no more-specific. **Fire.** Mark `doubled.slot[ROOT]` dirty (clear
    cached). Doubled's consumer-pattern (Computed-cache-propagate)
    cascades dirty to subs:
    - `doubled.slot[ROOT].subs = [edge_D_E]`. Mark `effect.slot[ROOT]`
      dirty. Effect's consumer (scheduler) wants to
      `scheduleMicrotask(runBody)` — but we're in a deferred-fires region.
      The scheduler queues the schedule-intent.
  - `edge_C_E`: same chain. **Fire.** Mark `effect.slot[ROOT]` dirty
    (already dirty — no-op). Scheduler attempts schedule again →
    deduplicated by Q-J.

**Drop `count.slots[S]`:** walk `slot.subs` (none). Delete.

**Close deferred-fires region:** drain. Effect's `runBody` is scheduled
**once** (microtask).

`S.status = 'committed'`. Pop ambient.

**State after Step 3:**
```
count.slots = { ROOT: cached 5 (wasWritten) }
doubled.slots = { ROOT: dirty, cached cleared, deps: [edge_C_D] }
effect.slots = { ROOT: dirty, deps: [edge_C_E, edge_D_E] }
microtask queue: [runBody]
observations still [{ c: 0, d: 0 }]
```

All invalidations are now in place. The effect hasn't actually run yet —
microtasks fire after the current sync task (the commit's synchronous
portion) completes.

### Step 4: microtask runs `runBody`

- Guard: `effect.disposed === false`. Proceed.
- Fire previous bodyCleanups (none in this trace).
- Unlink stale deps: `effect.slot[ROOT].deps = [edge_C_E, edge_D_E]`.
  Unlink each — remove from `count.slots[ROOT].subs` and from
  `doubled.slots[ROOT].subs`. Set `deps = []`.
- Push tracker = `effect.slot[ROOT]`. Push scope = `ROOT_SCOPE`.
- Invoke body:
  - `get(count)`:
    - `link(count, chainSelector([ROOT_SCOPE]), effect.slot[ROOT])` →
      `edge_C_E'` (fresh identity).
    - `invoke(count, ROOT_SCOPE)`: cached 5. Return.
  - `c = 5`.
  - `get(doubled)`:
    - `link(doubled, chainSelector([ROOT_SCOPE]), effect.slot[ROOT])` →
      `edge_D_E'`.
    - `invoke(doubled, ROOT_SCOPE)`: **slot is dirty**. Recompute.
      - Push tracker = `doubled.slot[ROOT]`. Push scope. Unlink doubled's
        stale deps. Run recipe.
      - Recipe: `get(count) * 2`. Inside: `link(count, …, doubled.slot[ROOT])`
        → `edge_C_D'`. `invoke(count, ROOT)` → 5. Return.
      - Recipe returns `5 * 2 = 10`. Cache `doubled.slot[ROOT].cached = 10`.
        Pop tracker.
    - Return 10.
  - `d = 10`.
  - `observations.push({ c: 5, d: 10 })`.
- Pop tracker, pop scope.

**Final state:**
```
count.slots = { ROOT: cached 5, subs: [edge_C_D', edge_C_E'] }
doubled.slots = { ROOT: cached 10, deps: [edge_C_D'], subs: [edge_D_E'] }
effect.slots = { ROOT: deps: [edge_C_E', edge_D_E'] }
observations = [{ c: 0, d: 0 }, { c: 5, d: 10 }]   ✓ coherent
```

The effect's re-run saw `c = 5` and `d = 10` — both reflecting the
committed state. **Coherent.**

### Why coherence is automatic here

The audit framed H1d as "could the effect see (X=5, f=stale) because the
derived's slot at ROOT_SCOPE wasn't invalidated in dep-order during commit
promotion?" The trace shows: **the architecture makes this impossible by
two compounding mechanisms:**

1. *Cascading invalidation is synchronous.* When `count → doubled` fires,
   doubled's slot is marked dirty *immediately*. Doubled's consumer
   pattern (Computed-cache) walks doubled's subs and propagates dirty
   transitively (also synchronously). By the time `closeScope` returns,
   every consumer downstream of count has been marked dirty.
2. *Consumer re-runs are microtask-scheduled (per H1a-c).* The effect's
   `runBody` doesn't fire until the next microtask, *after* the
   synchronous commit completes. By that time, all dirty flags are set;
   any read inside the body invalidates against the dirty flag and
   recomputes (per Position C from K1+K1b — synchronous reads pick up
   dirty state).

So the effect body, when it runs, sees both:
- `count.slot[ROOT].cached = 5` (set during commit).
- `doubled.slot[ROOT]` dirty → recomputes → 10 (recipe reads the
  committed count).

**Q-J's commit-region deduplication** is what makes this *efficient*
(one re-run instead of N for an effect that depends on N commit-promoted
signals) — but the coherence itself doesn't depend on Q-J. Even with N
re-runs, each one sees coherent state because all invalidations land
before the first microtask.

### Architecture exposed

H1d traced cleanly with no new design calls. The trace validates that:

1. **Position C (synchronous fires) + microtask-scheduled consumers =
   automatic post-commit coherence.** No clever ordering needed at the
   commit-fire level for effect-body correctness.
2. **Computed-cache propagation is synchronous and transitive.** Marking
   doubled dirty cascades to effect through `subs` walking. Standard
   reactive bookkeeping.
3. **Q-J's deduplication is an efficiency win, not a correctness
   requirement.** Even without dedup, repeated re-runs see coherent
   state.
4. **The doubleName trace open question #1 (commit ordering) is
   non-load-bearing for consumer correctness.** Ordering matters for
   selector-check correctness at writeSlot time (the original concern in
   doubleName), but post-commit consumer reads are always coherent
   because invalidations are synchronous and consumers are async-
   scheduled.
5. **Q-I (read-vs-write slots) is load-bearing.** `count.slot[S]` is
   `wasWritten = true` → promotes. The slots in `doubled` and `effect`
   for `S` (if any had been created via the effect being read inside the
   action) wouldn't promote because they'd be read-populated. In this
   trace no such slots were created — the effect runs at `ROOT_SCOPE`
   and was never invoked under `S`.

### Sub-questions surfaced (small)

- *Multi-write commits with overlapping consumers.* If the action wrote
  to N signals all depending on the same effect, Q-J's dedupe ensures
  one re-run. But this trace only had one write. Worth a follow-up
  trace if pulse ever finds itself debugging "why does my effect run 5
  times after a commit." Probably absorbed into Q-J's existing scope.
- *What if `doubled`'s recipe were async?* Then the recompute inside
  `invoke(doubled, ROOT)` would yield a park command. The effect body's
  `get(doubled)` would return a Promise; the effect would have to
  `yield* get(doubled)` instead. Crosses into H5 + C2e territory; not
  a new issue.

### Framings status after H1d

All four framings still hold. Position C from K1+K1b is reconfirmed at
the commit-fire level. Q-J's deferred-fires region works as designed for
deduplication. The "Derivation kind matches reactivity scope" framing is
implicit here — `doubled` is a Computed (synchronously fresh on read);
if it had been an effect-driven signal (H5), the trace would have
returned stale.

**No falsifications. No new design calls.** H1d is a clean validation
trace.

---

## Open questions (the actual mapping work)

Each is open. The goal is to *map the question space* before committing to any
route. Several questions are interrelated; their connections are noted.

*Bookkeeping discipline.* When a trace surfaces a new sub-question, it gets
**promoted to this section** (either as a new Q-letter or as an appended
bullet to an existing Q). Trace sections keep notes for reading context, but
the canonical list of open questions lives here. Trace cross-references
inside Q-entries name the trace that surfaced them.

### Q-A — Fall-through and edge policy

Status: working candidate framing identified (Model 2 — selector-on-edge). Not
locked in; sub-questions remain open at the next level down.

**The break, traced concretely.** With `name`, `doubleName = computed(() =>
get(name) + get(name))`, and the initial outside-action `get(doubleName)`
populating `doubleName.slots[ROOT_SCOPE] = "foofoo"` plus an edge
`name.slots[ROOT_SCOPE] → doubleName.slots[ROOT_SCOPE]` (using the library's
convention that "outside any action" uses `ROOT_SCOPE` as the scope key):

```ts
action(function* () {
  // Inside scope S. name.slots[S] doesn't exist; doubleName.slots[S] doesn't exist.
  get(doubleName)
  //   - doubleName.slots[S] miss → populate: invoke defaultRecipe under S.
  //   - Recipe runs. get(name) under S → name.slots[S] miss → walk falls
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

Status: working candidate framing identified via the H1a-c trace. Not locked
in; sub-questions remain at the next level down.

**Candidate framing.** Consumers are *library code* over the engine's
`subscribe` primitive plus a scheduler. Uniform shape:

```ts
function consumer(node, onSlotChange) {
  return subscribe(node, e => {
    if (e.kind === 'invalidated') scheduleMicrotask(onSlotChange)
  })
}
```

`Effect`, `JSX-binding`, and `Computed-cache-dependent` are all `consumer(…)`
calls with different `onSlotChange` bodies (re-run side-effect body, schedule
DOM update, mark cache dirty + propagate). No engine primitive distinguishes
them.

**Deferred-until-commit semantics** for effects-under-speculation fall out of
**selector composition**, not engine logic: an effect created in `ROOT_SCOPE`
has its tracking edges formed with `chainSelector([ROOT_SCOPE])`; writes to a
speculative scope don't match the chain → don't fire. Writes to `ROOT_SCOPE`
(commit promotion) match → fire. *No defer logic anywhere; the chain is the
policy.*

**Verified by H1a-c trace.** H1a (write under S → effect doesn't fire), H1b
(commit → effect fires once), H1c (discard → effect never fires).

**Sub-questions still open:**

- *Microtask batching.* Multiple invalidations in quick succession should
  produce one re-run per microtask cycle per Node. Library-side "scheduled"
  flag per Node handles it. Mechanical.
- *Effect-during-recompute (re-entrancy).* If an effect's body triggers
  another effect that writes to a signal the first effect reads… exactly
  **K1 territory.** Worth tracing K1 next.
- *Effect priority and ordering.* Multiple effects depending on the same
  signal — order? Pulse hasn't articulated against Dim 3 (priority).
- *Effects at chains longer than 1.* Component-owned effect chain
  `[component_scope, ROOT_SCOPE]`; action-inside-component effect chain
  `[action_scope, component_scope, ROOT_SCOPE]`. Trace H2 would exercise.
- *Dirty propagation.* Computeds propagate dirty downstream — their subs
  also need to invalidate transitively. Library-side: the Computed
  consumer's `onSlotChange` doesn't just invalidate its own cache; it
  also fires its own subs (via the engine). Open: is this transitive
  fire-and-invalidate something the engine should expose more directly,
  or is iterating subs in the consumer correct?

**Related:** Q-A (selectors are the chain mechanism; Q-C subscribes via
them), Q-D (Promise-resolution-as-write fires consumers — confirmed in C2),
Q-G (`defaultRecipe` interacts with consumer's initial run).

### Q-D — Async at the engine level

The recipe is `() => T` where `T` may itself be `Promise<U>`. The engine sees
Promises in `cached`. Per P2 (acknowledge async), walks decide how to handle
them.

**Resolved by the `Awaitable<T>` framing** (see the "Awaitable" framing
section above): when the engine encounters a Promise in `slot.cached`, the
library's `get(node)` walk wraps it in an `Awaitable<U>` — a Promise
subclass that carries `status` / `value` / `reason` fields *as class
instance state* (not as tweaked side-properties on foreign Promises).

This collapses the earlier Promise-tweak-vs-WeakMap question. The state
lives on the Awaitable instance:

- *Status query* — `awaitable.status` (synchronous, no side-table lookup).
- *Async wait* — `await awaitable` (Awaitable extends Promise).
- *Generator wait* — `yield* awaitable` (Awaitable implements
  `[Symbol.iterator]`).
- *React-convention interop* — `makeAwaitable(foreign)` duck-types the
  incoming Promise for `status`/`value`/`reason` and adopts the state if
  present.

The engine doesn't need a separate `promiseState()` helper or
`WeakMap<Promise, T>` side-table. Awaitable IS the Promise-with-state type;
the user accesses the fields directly.

**Engine's responsibility for firing on resolution.** When a Promise lands
in a slot's `cached` (either via `writeSlot` or via `invoke` running an
async recipe), the engine attaches a `.then` so that resolution emits a
slot-changed event (`{ kind: 'resolved' }`) to subscribers. The slot's
`cached` is NOT mutated when the Promise resolves — it stays as the
Awaitable, which now has `status: 'fulfilled'` and `value: T` populated.
Walks query via the field on next read.

Concretely (engine-side, ~10 lines):

```ts
// Inside writeSlot / invoke, after caching a Promise:
function trackPromiseResolution<T>(node: Node<T>, scope: Scope, slot: Slot<T>) {
  const cached = slot.cached
  if (cached && typeof (cached as any).then === 'function') {
    ;(cached as Promise<unknown>).then(
      () => fireEdges(node, scope, { kind: 'resolved' }),
      () => fireEdges(node, scope, { kind: 'resolved' }),  // rejection also fires
    )
  }
}
```

Plus the library-side `makeAwaitable` helper that wraps incoming Promises
in pulse's Awaitable class (so the state fields are populated structurally
rather than via mutation). See the "Awaitable" framing section.

**Settled by Awaitable + the C2 trace:**

- *Does the engine `await` internally?* No — walks handle suspension via
  `yield* get` or `use`. Engine attaches a `.then` only to fire the
  slot-changed event on resolution.
- *Does the engine track which slots are pending?* No — pending-ness is
  derived from `(get(node) as Awaitable<U>).status === 'pending'`. The
  `isPending(node)` walk reads the status field.
- *Where does Promise state live?* On the Awaitable class instance —
  pulse owns the wrapper. Foreign Promises (React, TanStack Query, etc.)
  are duck-typed for interop and their state copied into our Awaitable.
- *Mutation of foreign Promises?* Avoided. Pulse never tweaks Promises it
  doesn't own; it wraps them in Awaitable instances.

**Related:** Q-C (consumer's re-run discipline for async deps; consumers
receive `{ kind: 'resolved' }` events the same way they receive `{ kind:
'invalidated' }`), main-doc D8 (`yield* get` vs `use` vs stages), Q-I
(a Promise that resolves is "still the same slot," not a write, so doesn't
trigger commit-promotion).

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

**Open sub-question (surfaced by G2 trace):** `chainFor(scope)` walks
`scope.parent` pointers up to and including `ROOT_SCOPE`. For custom scope
hierarchies — per-tenant roots, per-document roots, multiple reactive
"worlds" — the terminal might not be `ROOT_SCOPE`. The library should
probably expose `chainFor` as user-overridable, or expose `terminalScope`
as a configurable per-tree property. Open whether this is a library
concern or whether the engine needs to know about it.

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

**Sub-question (surfaced by doubleName trace):** what `cached` does a *promoted*
slot carry? Three sub-positions: (a) preserve `cached` + carry over old deps
(but old deps had chain selectors keyed to the old scope, which doesn't match
the new scope's chain); (b) preserve `cached`, drop deps, let next recompute
rebuild; (c) drop `cached`, force recompute on next read. *Lean (b)*:
preserves the work done in the scope without carrying selector mismatches
forward. Related to Q-A (selector identity across scope transitions).

### Q-H — Tracker vs Scope: separate or unified?

The sketch has a separate `currentTracker` (the slot currently being
recomputed, used by `get` to register `deps`) and a `getCurrentScope`
(speculation/owner context). Are these the same primitive?

Argument for unification: both are ambient context handles. Argument against:
the tracker is *the slot being recomputed*; the scope is a *broader context*
that may contain many tracker-events. They're at different granularity.

Likely answer: tracker is a sub-ambient. A slot recomputes under a scope (its
slot's scope); reads inside the recompute know both. Either two separate
ambients, or one ambient with a "current slot recomputing" sub-field. Open.

**K1 confirmed the parallel-and-coupled framing.** When a recompute enters,
both `currentTracker` and `currentScope` push together (the slot being
recomputed *and* its scope); both pop together. Re-entrant writes inside the
recompute correctly inherit the recompute's scope. So they're separate
ambients with synchronized lifecycles.

**Sub-question (surfaced by K1 + relates to catalog L1):** *`untrack`
interaction.* `untrack(() => ...)` clears `currentTracker` but not
`currentScope`. So a `writeSlot` inside `untrack` writes to the current
scope normally, but its firing isn't gated by `deferredFires` (which is
keyed on tracker). Writes inside `untrack` would fire synchronously even
during a recompute. That's plausible (the user explicitly opted out of
tracking) but worth confirming as the policy. Connects to L1 in the
scenario catalog.

### Q-I — Read-populated vs write-populated slots: do they differ structurally?

Surfaced by the C2d trace. When a slot is created lazily during a read (because
no slot existed for the requested scope yet, so `invoke` populated one with the
default recipe), it ends up in `node.slots[scope]` *exactly the same way* as a
slot created by an explicit `writeSlot` call from a setter. But their commit
semantics differ:

- *Write-populated slot.* On commit, the slot's recipe (+ cached value) gets
  promoted to the parent scope. The intent is "this is what the action did to
  the node; lift it out."
- *Read-populated slot.* On commit, promoting this slot would clobber any
  later writes to canonical (e.g., the C2d case where outside-action writes
  happened during the await). The intent is "this slot was just a memo cache
  for the duration of the scope; drop it on commit, don't promote."

Two ways to handle it:

- **(i) `wasWritten: boolean` flag on `Slot`.** Engine tags slots at creation
  time (true on `writeSlot`, false on `invoke`-populated). Commit walks only
  promotes flagged slots; non-flagged ones drop.
- **(ii) Library tracks write-set separately.** The scope itself maintains a
  `writeSet: Set<Node>` populated by `writeSlot` calls. Commit walks
  `writeSet`, not all slots tagged with the scope. Read-populated slots are
  invisible to commit because they're not in `writeSet`.

(i) puts the distinction on the slot; (ii) puts it on the scope. (ii) is
cleaner in spirit (scope owns its semantics; slots stay uniform) but (i) is
more locally evident (a slot knows whether it represents "real" state).

Connects to Q-E (the Signal/Computed slot distinction) — that question also
asks whether the engine needs to know what kind of slot it's looking at.
Probably resolved together.

**Lean: (ii)**, because it keeps the engine's `Slot` shape uniform and pushes
intent into the library's scope handling. But (i) wins if performance
measurements show that walking the scope's write-set is slower than checking
flags during commit. Currently mostly cosmetic.

### Q-J — Commit as transaction: ordering, atomicity, deferred fires

Surfaced cumulatively by doubleName (commit ordering), K1 (originally; see
post-revision note below), and G2 (promotion atomicity at the consumer
level). The underlying question: **when an action commits, how exactly
does the engine sequence the multiple slot promotions and edge fires so
that consumers see a consistent post-commit state, not a sequence of
partial updates?**

**Post-revision scope (after K1+K1b).** Initially this question was framed
as "deferral applies during recomputes (K1) and during commits (here)."
K1+K1b flipped to position (C) — recomputes do *not* defer fires; they
fire synchronously, and consumers schedule async via microtasks. So
**deferred-fires is commit-mode only**, not tracker-mode. The mechanism
is the same shape but only one trigger remains: opening a commit
operation.

Three concerns under one umbrella:

- *Multi-write ordering.* If an action wrote to N signals, commit promotes
  N slots to the parent scope. Each promotion calls `writeSlot`, which fires
  edges. If a derived consumer's edges target a slot that depends on
  multiple of these N signals, the order of promotions can fire the consumer
  multiple times with partial states (after promoting `signal_1` but before
  `signal_2`). *Working hypothesis: dep-order leaves-first.* Sources promote
  before their dependents; intermediate fires invalidate but don't re-run
  until all promotions are done.
- *Deferred fires during commit.* Without deferral, consumers might re-run
  mid-commit and observe partial states. Better: collect *deferred fires*
  during the entire commit operation, drain them after all promotions
  complete.
- *Atomicity from the consumer's perspective.* External consumers (effects,
  JSX-bindings) should see *the commit as a single event* — one invalidation
  per affected consumer, regardless of how many slots got promoted.

Likely resolution: **commit is a deferred-fires region.** When
`closeScope(S, 'commit')` runs:

1. Open a deferred-fires region.
2. For each `S`-tagged write-populated slot (Q-I), perform `writeSlot(node,
   parentScope, slot_content)`. Edge fires are *queued* into the deferred
   region.
3. Drop the `S`-tagged slots, unlinking edges.
4. Close the deferred-fires region: deduplicate by `(node, scope)`, then
   actually call `fireEdges` for each. Consumers see one invalidation per
   affected slot, regardless of how many writes contributed.

**Recipes** (computed/effect bodies) **do not open a deferred-fires
region.** Writes inside recipes fire synchronously per K1+K1b's resolution
to (C). This is necessary for in-recipe state coherence (K1b: write a
signal, then read a downstream derived → derived must recompute fresh).
Cycle protection is consumer-level (max N re-runs per microtask),
unaffected by whether fires are deferred.

**Open sub-questions:**

- *Nested-commit ordering.* G2 traced inner-commit-promotes-to-outer. If
  inner commit happens inside a deferred-fires region (because outer is
  still executing its body), do the inner's promotions fire immediately to
  external consumers, or are they also deferred until outer finishes? Lean:
  inner-commit fires immediately *within the outer's body*, because the
  outer's body might read the post-inner state and the body is imperative.
  But for *external* consumers (chain matches `ROOT_SCOPE`), they shouldn't
  fire until outer commits — which falls out of the chain selector anyway
  (the chain selector for an external consumer doesn't match writes to the
  outer's scope). So this might be a non-issue under the chain mechanism.
  Worth verifying with a deliberate trace.
- *Edge-target-dropped races.* If during a commit, an edge's target slot
  gets dropped (e.g., the consumer was tied to a different scope that
  closed during the commit's processing), the deferred fire would target a
  dead slot. Lazy-prune-on-iteration handles it.
- *Promise resolution during commit.* If a promoted slot's `cached` is a
  Promise that's still pending, the commit promotes the Promise. Later
  resolution fires edges normally — same as any other Promise-resolution
  write. No special handling.

**Lean: implement commit as a deferred-fires region**, generalizing K1's
mechanism. The engine's invariant becomes "if `deferredFires` is non-null,
fires queue; outermost layer drains." Recomputes set up one such region;
commits set up another. They compose by nesting.

### Q-K — Effect chain policy: chain follows owner, or always [ROOT_SCOPE]?

Surfaced by the H3 trace. When an effect is created inside an action body
(or inside any scope other than `ROOT_SCOPE`), what's the chain its
tracking edges form against?

- **Policy α** — chain = `chainFor(owner)`. Effect created inside action
  `S` has chain `[S, ROOT_SCOPE]`. *Fires* on writes inside the action.
  Effect reactivity follows its containing scope.
- **Policy β** — chain = `[ROOT_SCOPE]` always. Effects only fire on
  committed-state changes regardless of where created. The effect's
  *lifecycle* is tied to its owner, but its *subscription* isn't.

H1a-c established that effects *outside* actions have chain `[ROOT_SCOPE]`
— consistent with both policies (an outside effect's owner is
`ROOT_SCOPE`, so `chainFor(owner) = [ROOT_SCOPE]` under α). The policies
diverge for effects inside actions.

**Lean: Policy α** — composition is natural; the user creating an effect
inside an action is opting into reactivity at the action's scope. Policy
β is defensible (effects-always-committed-only as an invariant) but
narrower. The mechanism (selector chains) supports both; this is a real
design call.

**Related sub-question:** *Effect re-parenting on commit.* Could an
in-action effect *survive* commit by re-parenting its owner to `S.parent`
and updating its chain accordingly? Possible but adds machinery; users
wanting persistent effects can just create them in the outer scope.
Probably out-of-scope.

**Related:** Q-C (consumer pattern depends on chain), Q-B (scope/owner
unification — the chain question is "does subscription follow owner or
not").

### Q-L — Body cleanups vs scope cleanups: composition and re-entrancy

Surfaced by H3 trace. Two distinct cleanup mechanisms exist:

- *Scope-level cleanup* — `onCleanup(fn)` outside an effect body,
  registered to `scope.cleanups`. Fires on scope discard (and possibly
  commit; see open below).
- *Body-level cleanup* — `onCleanup(fn)` inside an effect body, registered
  to `effectNode.bodyCleanups`. Fires before next body invocation or on
  effect disposal.

Open sub-questions:

- *Does scope-level `onCleanup` fire on commit too, or only on discard?*
  Working assumption: only on discard. Commit = success, no cleanup
  needed. But some patterns (e.g., "always release this lock when scope
  closes regardless") want it on both. Possible answer: separate
  `onCleanup` and `onSettle` (the latter fires on both). Open.
- *Re-entrancy during cleanup fires.* If a body cleanup calls `writeSlot`,
  is the write deferred (per Q-J's `deferredFires` mechanism)? The
  cleanup runs inside `closeScope`, which is itself a deferred-fires
  region per Q-J. So yes, deferral covers it. Worth confirming with a
  trace.
- *Cleanup ordering for nested scopes.* If `S2` is a child of `S1` and
  both have cleanups, does discard of `S1` fire `S2.cleanups` before
  `S1.cleanups` (children-first)? Probably yes. Standard tree-disposal
  pattern.

**Related:** Q-B (the scope/owner unification carries this composition),
Q-J (re-entrant cleanups land in the commit's deferred-fires region).

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
- **A1b.** Same as A1 but interleaved with derived reads:
  `setX(1); get(f(X)); get(X); get(f(X)); setX(2); get(f(X))`. Tests
  that all reads — primitive *and* derived — see fresh values in the same
  scope tick, not just the self-read. (A1 alone could "pass" on a
  single-slot bag without ever invalidating derivative caches.)
- **A2.** ✓ `setX`, read derived `f(X)` — the `doubleName` case. Traced.
- **A3.** Action writes multiple signals (`setX`, `setY`); read derived
  `f(X, Y)`. Tests whether multiple scope-tagged slots compose into one
  derived under the same scope. *Expected: yes — recipe runs once, reads
  each under `S`. Conditional on Q-H (tracker-as-scope) and Q-A selector
  dedup behaving correctly under multi-source reads.*
- **A3b.** Order-sensitive intermediate coherence:
  `setX(...); get(f(X, Y)); setY(...); get(f(X, Y))`. Tests whether the
  intermediate read sees `f(newX, oldY)` (Position C synchronous fires
  propagate dirty mid-action) or `f(oldX, oldY)` (Position B
  derived cache only invalidated at action end). Action-body analogue of
  K1b. *Expected under (C): fresh on each read.*
- **A4.** Action writes one signal; two distinct deriveds depend on it. Tests
  that both deriveds invalidate independently and re-read under `S`.
- **A4b.** Sibling-derived coherence: after `setX`, read derived `d1`, then
  derived `d2`. Are both fresh? Does reading `d1` first somehow pin a
  stale cache for `d2`? Probes whether mid-action recompute of one
  derived leaks staleness to its sibling. Cuts multiple ways depending
  on Q-A selector dispatch ordering.
- **A5a.** Functional setter: `setX(x => x + 1)` inside action. Tests *what
  the setter callback's `x` parameter is*: committed value or speculative-
  slot value. Library-API design question.
- **A5b.** Functional setter, write side: where does the setter's returned
  value land? Tests that the write goes to the speculative slot at `S`,
  consistently with sync `setX(v)`. *Expected: yes.*
- **A5c.** Functional setter callback reading a downstream derived:
  `setX(x => { const d = get(f(X)); return d + 1 })`. Tests what the
  derived `f(X)` seen inside the callback reflects — the pre-setter
  committed `X`, the speculative `X` (if outer action ongoing), or some
  half-state. K1b's mirror inside a setter callback rather than a
  computed recipe.
- **A6a.** Conditional read in a recipe under `ROOT_SCOPE`: branches change
  on input. Tests dynamic deps (drop edge for not-taken branch, form edge
  for taken). *r3 baseline; no new behavior.*
- **A6b.** Same conditional read, recipe invoked under a non-root scope
  `S`. Tests dynamic deps *under scope*: scope-tagged edges drop / form as
  branches change. This is where Model 2 is exercised; A6a is a smoke
  prerequisite.
- **A6c.** Conditional read under `S` where the condition's input was just
  written, then the same conditional derived is read twice in succession.
  Tests coherence of *graph shape changes mid-recompute*: does the second
  read see the new branch's value (fresh dep-graph + fresh cache) or a
  hybrid (new branch chosen but evaluated against stale upstream slot)?
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
  a Promise. Tests: how does a derived `get(X)` see this? Walks decide.
- **C1b.** After `setX(promise)`, in the same scope, read a derived `f(X)`
  whose recipe does `get(X).then(...)` or `yield* get(X)`. Tests: does
  the derived's slot capture the *same Promise identity* the setter
  wrote, or a different one (e.g., re-wrapped)? Promise identity =
  supersession signal per main-doc D8.
- **C2a.** Action body `yield* get(asyncSignal)` — body parks until promise
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
- **C2e.** Post-yield derived read: action body does
  `yield* get(asyncSignal); const d = get(downstreamDerived)`. The
  derived's recipe reads `asyncSignal`. Tests: after resume, does the
  derived see the *resolved* value of `asyncSignal`, or the still-
  Promise-cached value in `slot[S]`? Must the engine's slot-changed
  `'resolved'` event have fired (and been observed by the derived's
  slot) *before* the body's resume runs? **Async analogue of K1b** —
  the canonical post-async-coherence probe. Cuts at least two ways
  depending on microtask ordering vs engine's synchronous `.then`
  handling.
- **C2f.** Two sequential `yield* get`s of *different* async signals in
  the same body, with a downstream derived depending on both. Probe:
  between yields, does the derived see (resolved-A, pending-B)
  coherently? Probes per-step in-recipe coherence across multiple
  awaits.
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
- **D2b.** After writer commits, but inside reader's still-open scope,
  reader reads a derived that depends on the writer's signal. Probe: does
  the derived see the just-committed value (`ROOT_SCOPE` chain entry
  updated, reader's chain `[S_reader, ROOT]` walks to ROOT), or did the
  reader's scope already memoize a slot from before the commit?
  Coherence across the chain when a *more-canonical* entry updates
  underneath an open scope.
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
- **G1b.** Outer wrote `setX('outer')`; inner opens, writes
  `setX('inner')`. Inside inner, read `X` and derived `f(X)`. Then —
  *hypothetical interleave* — control returns to outer mid-inner and
  outer reads `X`. Does outer see `'outer'` (chain skips inner) or
  `'inner'` (chain inherits)? Whether this scenario is even reachable
  depends on whether actions can interleave; if not, mark as
  out-of-scope or conditional.
- **G2.** Inner commits → its slots promote to outer's scope (not ROOT).
  Outer commits → outer's slots promote to ROOT. Two-stage promotion. *Open:
  does inner-commit promote to outer or directly to ROOT? Lean: to outer,
  preserving nesting.* See F2 — same commit-promotion question at outer-most
  depth.
- **G3.** Inner commits; outer discards. Inner's promoted-to-outer slots get
  discarded with outer. Nesting respects parent lifecycle.
- **G4.** Inner discards; outer continues. Inner's writes drop; outer's
  state unchanged.
- **G4b.** Outer wrote `setX('outer')`. Inner opens, writes
  `setX('inner')`, discards. Outer then reads `f(X)`. Tests: does the
  discard cleanly detach inner's slot from outer's chain such that
  outer's derived `f(X)` recomputes against `'outer'`, not against a
  half-cleaned `'inner'` cache? Coherence-of-discard probe for the
  outer body's subsequent reads.

### H. Effects under speculation — *Q-C open*

- **H1a.** Effect registered outside; speculative write happens inside an
  action. Tests *during the action*: does the effect fire? *Lean: no
  (defer-until-commit).*
- **H1b.** Same setup; action commits. Tests *after commit*: does the
  effect fire exactly once with the committed value? *Lean: yes.*
- **H1c.** Same setup; action discards. Tests: effect never fired
  (no speculative trigger leaked). *Lean: yes.* (H1a/b/c together
  establish the defer-until-commit position from Q-C.)
- **H1d.** Effect body reads `get(X)` *and* `get(f(X))`. Action writes
  `setX(5)`, commits. Effect schedules and runs. Tests: does the effect
  see (X=5, f=10) coherently, or could it see (X=5, f=stale) because the
  derived's slot at `ROOT_SCOPE` wasn't invalidated in dep-order during
  commit promotion? **Effect-body coherence on commit** — probes
  commit-promotion ordering (doubleName trace open #1) through the
  effect's lens.
- **H2.** Effect created inside an action body. Effect's owner is the
  action's scope; effect's body executes once at registration. Does it
  re-fire on writes inside the same action?
- **H2b.** Effect created inside action `S`, registered against chain
  `[S, ROOT]`. Action body then writes `setX`, then reads downstream
  `f(X)` directly. Then more writes. Tests: when the effect re-fires (if
  it does), what scope chain is active in its body? Does its `get(X)`
  see the latest in-action value, and if it reads a derived, does the
  derived see the same? Separates "did it fire" (H2) from "did it see
  coherent state" (H2b). Q-K (effect chain policy α/β) is upstream.
- **H3.** Effect with `onCleanup`; speculative write triggers the effect →
  effect's body runs → registers cleanup. If discard, do those cleanups
  fire? Cleanup chains across scopes; tricky.
- **H3c.** After cleanup fires and the body re-runs, does the new body
  see derived-coherent state w.r.t. whatever caused the re-run?
  Post-cleanup body re-run coherence probe.
- **H4.** Effect that itself calls `action(…)` (effect-triggers-action).
  Cycles? Bans? Worth knowing the policy.
- **H5.** Effect-mediated derivation coherence during action. An effect
  maintains a signal `value` derived from `name` (e.g.,
  `effect(() => setValue(get(name) + get(name)))`). An action writes
  `name`, then reads `value`. Tests: does `value` reflect the action's
  `name` overlay (would require eager effect runs, which contradicts
  H1a-c), or the pre-action committed `value` (stale during the action,
  fresh after commit + effect re-run)? **Architectural answer: stale
  during action.** Contrast with K1b's computed-mediated equivalent,
  which sees fresh. The two distinguish the **computed vs effect
  derivation** distinction (see the "Derivation kind matches reactivity
  scope" framing). User-ergonomic implication: effect-driven derivations
  are *deferred*; use `computed` for synchronously-fresh derivations
  inside actions.

### I. Component / JSX integration

- **I1.** JSX expression `{get(name)}` rendered inside a component that's
  *inside* an active action. JSX-binding consumer treated like Effect —
  re-renders on speculative writes? Defers to commit? Q-C territory.
  *Downstream of H1a-c's resolution.*
- **I1b.** JSX expression `{get(f(X))}` where the component is
  mid-render at the moment of an action commit. Tests: does the
  resulting DOM reflect coherent (X, f(X)) values, or could it tear
  (render uses old X but new f(X) because two reads bracket the commit
  point)? **Tearing/coherence probe for the renderer consumer.** Cuts
  multiple ways depending on whether JSX walks are batched.
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
- **J4b.** Action creates signal `Y` via `signal(0)`, then writes
  `setY(1)`, then reads a derived `g(Y)`. Tests: does the derived see
  `1`? Does its scope chain include `S`, or did it form against `ROOT`
  because the signal's initial slot landed there? Coherence test
  downstream of J4's policy decision.
- **J5.** Action body sets a value, then somewhere else (a different scope
  or no scope) reads it. Other scope/no-scope doesn't see the speculative
  value. Falls out — selectors handle.

### K. Re-entrancy & write-during-recompute

- **K1a.** `setX` called from *inside* a computed's recipe body during
  recompute, with *no follow-up read of a downstream derived*. Tests the
  "is this permitted at all?" question. *Resolved: permitted (Position A
  hard-ban is incompatible with effects).*
- **K1b.** *Same as K1a, but the recipe reads a downstream derived after
  the write.* E.g., `computed(() => { setName("name"); return
  get(doubleName).capitalize() })`. Tests **in-recipe coherence**: does
  the post-write read see the *fresh* derived value, or the stale
  cached one? This is the case that exposes (B) deferred-fires vs (C)
  synchronous-fires. *Resolved: (C) synchronous-fires gives fresh; (B)
  gives stale.*
- **K2.** `setX` called from inside `onCleanup` of a slot being dropped
  during commit (cleanup chain triggers further writes). Tests: re-entrant
  write during commit; commit-ordering subtlety (trace open question #1).
- **K2b.** `onCleanup(() => { setOther(get(derivedFromX)) })`. Inside
  the cleanup, after the write to `Other`, is `get(derivedFromX)`
  reading a slot in a half-promoted state? Does the cleanup observe
  `X`'s pre-promotion or post-promotion value? Does the write to
  `Other` land in a still-open scope, in `ROOT`, or trigger commit-time
  re-entrancy? **Cleanup-time re-entrancy + coherence probe.** Cuts
  multiple ways: (i) commit is atomic, cleanups see post-promotion
  state; (ii) cleanups fire mid-promotion, half-state; (iii) cleanups
  fire pre-promotion, scope-still-open chain. Q-J (commit-as-
  transaction) is upstream.
- **K3.** Action body calls `setX` where `X` is updated by an effect that
  was itself triggered by that write (would-be cycle). Tests: cycle
  detection under scope; policy bans or runs.
- **K3b.** *Conditional on K3 permitting the second write.* If the policy
  permits, does the effect body's read of a derived `f(X)` see fresh-
  fresh (both writes propagated), fresh-stale (first write's derived
  cached, second pending), or some other coherence break? May be moot
  if K3 resolves to "ban."

### L. Boundary-bypass reads inside speculation

- **L1.** `untrack(() => get(node))` inside an action body. Tests: read
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
- **R2b.** Both speculations wrote `X`; both commit in the same frame.
  What does a derived `f(X)` see *between* the two commit promotions if
  the scheduler runs them sequentially? **Inter-commit-window
  coherence** probe. Cuts multiple ways depending on whether the
  scheduler emits invalidations per-commit or coalesces.
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

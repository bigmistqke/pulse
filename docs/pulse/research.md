# Pulse — signal-as-node research

Exploration of pulse's reactive substrate and speculation machinery.
Framings are durable as exploration directions; implementation sketches
are illustrative; design calls are deliberate.

**Companion document:** the [scenario catalog](./scenarios.md) lives
separately. Traces here cross-link to specific scenarios there.

**Related pulse-repo docs:**
- [`../research/async/CONTEXT.md`](../research/async/CONTEXT.md) — speculation lexicon, four dimensions, failure modes.
- [`../research/async/deep-dives/solid-2x.md`](../research/async/deep-dives/solid-2x.md) — per-node multi-slot architecture reference.

---

## What we're exploring, in one paragraph

Pulse's user-facing `Signal<T>` and `Computed<T>` are **graph relations, not
values** — `Node<() => T | Promise<T>>`, an identity in the dep graph wrapping a
recipe (a callback that produces the value). The value is not *in* the Node; it
is what you get by handing the Node to a *walk* primitive. The library ships
named patterns and named walks (`signal`, `compute`, `effect`, `get`,
`latest`, `use`, `isPending`, `subscribe`) as approachable DX over a slim engine
that knows only about graph, slots, recipes, edges, and notification. Users
who want their own semantics over the graph can reach the engine; the default
surface stays approachable. Speculation is one *use* of this stack — scope-tagged
slots, walk policies that consult them — not a built-in engine concept.

---

## Research arc context

Background framings that motivated this exploration: the research arc, the
comparison-table reference, the seven-concerns decomposition, and the
node/value-bag recasting (where the "signals as graph relations" framing
originated).

### What the research arc has shown

Speculations (the field calls them *transitions*; see Principles below) are
coordination machinery for **continuous-observation + concurrent-intent**
workloads (UI is the canonical instance; also GGPO rollback, sync engines
with optimistic+rebase, realtime collab). They branch along four structural
dimensions — **Dim 1** internal structure of one speculation, **Dim 2**
concurrence (multiple alive, disjoint state), **Dim 3** supersession (newer
invalidates older), **Dim 4** overlap/entanglement (multiple alive, shared
state) — the non-trivial corners of `{one, many} × {disjoint, overlapping}
× {concurrent, sequential}`. Canonical definitions in the lexicon
[`../research/async/CONTEXT.md`](../research/async/CONTEXT.md). Production
frameworks differ in which dimensions they handle and how, AND in whether
their user-facing API surface is minimal (Svelte) or proliferating (React).
Pulse's articulated design philosophy is **user-visible primitives composed
in userland** — distinct from React's "low-level API + library-authors
compose ergonomics" and Solid's "framework-provided higher-level
primitives" — though Svelte's evidence showed that "minimum API" does NOT
entail "minimum engine"; concurrent speculations cost engine surface
regardless of how small the user API is.

### Comparison: React modern / Svelte 5 / Solid 2.x

The mechanical landscape for the three production frameworks pulse has the
most-developed dives on. Each cell is what the framework actually does.

| | **React modern** | **Svelte 5 (`experimental.async`)** | **Solid 2.x** |
|---|---|---|---|
| **Substrate** | Fiber tree + lane-scheduled work queue (31-bit bitmask) | Signals + linked-list of `Batch` objects + `<svelte:boundary>` queue | Reactive graph + per-write `OptimisticLane` + `Transition` object |
| **User-facing primitives** | `useTransition`, `useDeferredValue`, `useOptimistic`, `Suspense`, `use(promise)`, `useActionState`, Actions, Server Functions | `<svelte:boundary>` + `pending` snippet, `$effect.pending()`, `settled()`, `fork()` | `<Loading>`, `<Errored>`, `<Reveal>`, `action()`, `createOptimistic`, `latest()`, `isPending()`, `refresh()` |
| **Suspension mechanism** | `use(promise)` throws cached promise; caught at Suspense boundary | `await` inside `$derived` lowered to `async_derived`; gated by `boundary.#pending_count` | `NotReadyError(source)` thrown; caught by `CollectionQueue.notify` |
| **Dim 1 — internal structure** | WIP fiber tree gathers all pending Suspense in scope; commits atomically when all resolve | `boundary.#pending_count` for first render; `batch.#blocking_pending` for subsequent updates | `Transition._asyncReporters: Map<Computed, Set<Computed>>` tracks each pending source → its reporters; per-source decidability |
| **Dim 2 — concurrence (disjoint)** | 31-lane bitmask; multi-low-priority currently batched (acknowledged limit) | Linked-list of `Batch` objects; each with `batch_values` time-travel snapshot; independent commit if non-overlapping | Per-write `OptimisticLane`; independent lanes flush independently; not batched |
| **Dim 3 — supersession** | High-priority lanes pre-empt low-priority; WIP discarded and rebuilt; cooperative 5ms yield to browser | **None** as priority; per-derived `OBSOLETE` cancel + per-effect `STALE_REACTION` abort handle structural supersession; `fork()` is user-controlled | **None** as priority; newer writes supersede via `_inFlight !== result` identity check |
| **Dim 4 — overlap (entanglement)** | **Not handled**; multi-transition batching conflates with this | Whole-batch merge on source-set intersection (`#find_earlier_batch` + `#merge`) | Union-find lane merge on dep-graph overlap (`assignOrMergeLane`); parent-child lanes stay independent |
| **Speculative-state isolation** | Per-transition tree (WIP fiber) + per-action overlay (`useOptimistic`) | Versioned engine, unbounded observable batches (linked list); `fork()` as flagged subtype with deeper isolation | Per-write-lane overlay with overlap-merge; `_overrideValue` overlay + separate `_pendingValue` slot |
| **Optimistic state** | `useOptimistic(state, reducer)` returns `[optimisticState, setOptimistic]`; converges in same render as Action commit | No first-class API; user mutates state in `fork()` body or in async-derived (auto-reverts on `OBSOLETE` reject) | `createOptimistic(value)` returns reactive signal; auto-reverts on action failure via `resolveOptimisticNodes` |
| **Cancellation discipline** | Structural via WIP discard for rendering; convention-only `AbortController` for I/O effects | Two channels: `OBSOLETE` (per-derived) + `STALE_REACTION` (per-effect); `getAbortSignal` for cooperative I/O abort | Identity-based stale-result discard via `_inFlight !== result`; structural for async iterables (cleanup w/ `.return()`); no auto fetch abort |
| **Pending observability** | `isPending` from `useTransition` (internally implemented as `useOptimistic`); also `useDeferredValue` for "show old value during prep" | Only via `<svelte:boundary>` + `$effect.pending()`; **no per-value `.loading` on async-derived** | `isPending(() => x())` opt-in at read site; pipeline-OR walks dep graph; also `latest()` for boundary-bypass reads |
| **Fallback display** | Throttled at ≥300ms before showing; doesn't hide already-revealed content during transitions | Offscreen `DocumentFragment` until `#pending_count == 0`; then swap | Per-`<Loading>` boundary; gather-on-commit |
| **Multi-step async composition** | `await` inside Action body; multi-transition batched together (limit) | `await` inside `$derived`; compiler tracks deps across await via `capture`/`save` (`await a + b` → `(await $.save(a))() + b`) | `action(function*) { yield … }` — the whole generator is one transition; plain writes commit once at completion, transition stays alive across `await`s |
| **Dependent dispatch capability** | Await-only (`use(promise)` requires resolution; re-executes component on resolve) | Await-only with implicit ordering (sequential `$derived(await)` decls serialize; framework warns via `await_waterfall`) | Await-only with generator batching |
| **Entanglement detection** | None (application models conflicts in user code, e.g. via `useOptimistic` revert-on-failure) | Whole-batch granularity (per-microtask-of-writes); coarser than Solid | Per-write granularity (union-find merge of dep graphs); automatic detection by structural overlap |
| **Compiler involvement** | None (runtime-only) | Heavy: `experimental.async` flag; lowers `await` to `async_derived`/`flatten`/`save`; tracks deps across await | None for reactivity (runtime-only); compiler-style binding for JSX only |
| **Engine surface (rough)** | Thousands of LOC: fiber reconciler + scheduler + Suspense machinery + Actions | ~800 lines for `batch.js` alone + boundary.js + async.js + deriveds.js | ~1300 lines: core.ts + scheduler.ts + lanes.ts + async.ts + boundaries.ts |
| **User-facing API count** | ~7+ hooks | 4 primitives | ~8 primitives |
| **Specific oddities worth knowing** | `useTransition`'s `isPending` is internally `useOptimistic`; Suspense fallback throttling | `{#await}` blocks are anomalous re: runes machinery (may be retired); async-derived value lives in a normal `Source` cell — no `.loading` accessor by design | `<Reveal>` with `sequential`/`together`/`natural` modes; `_gatedSubs` replay-at-commit for cross-transaction reads; atomicity layers — per-transition (an action is one transition) / per-lane optimistic |

Three observations worth carrying forward:

1. **All three have radically different *user-facing* surfaces** (7+ vs 4 vs 8 primitives), but the *engine* sizes are within an order of magnitude. User-facing minimum is genuinely a choice independent of engine cost.
2. **Dim 3 is uniquely React's.** Both Svelte and Solid punt on input-priority entirely. If pulse wants to handle Dim 3, React is the only existing production reference point.
3. **Optimistic state is genuinely different across all three** — dedicated hook (React), no API + auto-revert via reject (Svelte), typed primitive tied to action lifecycle (Solid). None are the same shape; each is a position pulse could lean toward.

### Decomposition — seven underlying concerns

Looking at every mechanic in the comparison and asking *what problem is it
actually solving*, the mechanics cluster into seven underlying concerns:

- **A. Versioned reads** — read X as it currently is, OR as it was committed, OR as it appears under this in-flight scope. (WIP fiber tree, `batch_values`, `_overrideValue`, `latest()`, `useDeferredValue`, snapshot-isolation in MVCC.)
- **B. Pending propagation** — downstream computations learn that an upstream is in-flight. (`_pendingSource(s)`, `_asyncReporters`, `boundary.#pending_count`, pipeline-OR `isPending`.)
- **C. Atomic commit boundary** — these changes land together; nothing inside is visible until everything is ready. (`<Suspense>`, `<svelte:boundary>`, `<Loading>`, `Batch` commit, `Transition._actions`.)
- **D. Scoped writes** — writes belong to a named scope (action, fork, transition); the scope can be committed or discarded as a unit. (`OptimisticLane`, `useOptimistic`, `fork()`, `action(function*)`, Replicache mutators.)
- **E. In-flight identity** — when multiple runs of the same work exist, framework knows which is current. (`_inFlight !== result`, `OBSOLETE`, generation counters.)
- **F. Lifecycle / cleanup** — async work that's no longer relevant gets cleaned up. (Drop, `AbortController`, `cleanup()`, owner disposal.)
- **G. Priority** — some updates pre-empt others mid-flight. (React's 31-lane bitmask, uniquely.)

The high-level abstractions in the table are combinations of subsets of
{A, B, C, D, E, F, G}:

- `<Loading>` / `<Suspense>` / `<svelte:boundary>` = **B** + **C**
- `useOptimistic` / `createOptimistic` = **A** + **D** + **C**
- `useTransition` = **D** + **C** + **G**
- `action(function*)` = **D** + **C** + **E**
- `fork()` = **D** + **A** + **C**
- `<Reveal>` = composes multiple **C**s (coordination layer ABOVE boundaries)

None of these abstractions is a primitive in this decomposition. Each is
library code over a small subset of the seven concerns.

### Signal = node + value-bag (the sharper recasting)

The seven-concerns decomposition is roughly right but bundles two distinct
concerns under "scoped versioned state." A cleaner factoring: **a signal
isn't a single primitive — it's a (node identity, value-bag) pair.**
Currently every reactive framework conflates these into "a signal *is* its
current value." Decoupling them is the underlying simplicity.

- **Node** = the stable identity in the reactive dep graph. Other nodes /
  subscribers depend on this identity. Owners hold it. Equality and
  reference-tracking are based on it.
- **Value-bag** = the multi-valued state the node currently has. Entries
  are tagged with (scope, version, status). The "current committed value"
  is one entry; the "in-flight pending value" is another; the
  "optimistic-scope overlay" is a third; the "snapshot-as-of-time-T" is a
  fourth.

Under this framing, the seven concerns recast as:

- **A (versioned reads)** = read a specific entry from the value-bag
- **B (pending propagation)** = entries carry pending-status; the dep graph propagates status across nodes
- **C (atomic commit boundary)** = the value-bag collapses from N entries to 1
- **D (scoped writes)** = writes contribute an entry to the value-bag, tagged with scope
- **E (in-flight identity)** = entries carry identity (or the scope that produced them does)
- **F (cleanup)** = entries can be removed from the bag
- **G (priority)** = about the *work producing entries*, not about entries themselves — the only outlier (work scheduling, not value-bag operation)

So **A–F are all operations on the value-bag of a node**. G is the one
genuine outlier. The deeper decomposition shrinks from "7 concerns + 4
primitives" to **three primitives**: (node identity) + (value-bag) +
(work scheduling).

### Empirical pattern — every studied framework does node/value-bag internally

Every framework implements the node/value-bag separation internally, but
none exposes it as the user-facing primitive:

- **Solid 2.x** — explicit per-node slots `_value` / `_pendingValue` /
  `_overrideValue` / `_snapshotValue`. Internally exposed; user-facing
  surface is `createOptimistic` / `createSignal` / `createMemo` as
  separate hooks.
- **Svelte 5** — `batch_values: Map<Value, [any, boolean]>` per batch.
  Internally; user-facing is `<svelte:boundary>` / `$derived` / `fork()`.
- **React modern** — WIP fiber vs current fiber. Same component identity,
  different value-states. Internally; user-facing is `useOptimistic` /
  `useTransition` / `useState`.
- **Replicache** — B-tree DAG with `main` / `sync` heads. Closest to
  exposing it (named heads are semi-public; most user code doesn't see
  them).
- **Postgres MVCC** — row identity stable; multiple tuple-versions per
  row, indexed by transaction. Internally exposed via `xmin`/`xmax`; not
  user-API.

The pattern is universal. None lets the user say "give me node N's
value-bag entry tagged with scope S" as a primitive. Instead they each
invent bespoke compositions (`useOptimistic`, `_overrideValue`,
`Batch.current.get(node)`) that are internally just value-bag-entry-with-
scope-S.

**Solid's transition-machinery trajectory** (verified against the git
history of `@solidjs/signals`): Solid moved from per-node `tValue` slot
(1.x) → external scheduler holding cloned subgraph (2.x early) → cloning
for transitions, overlay for optimistic (2.x mid) → per-node multi-slot
with no cloning anywhere (current). Strong empirical evidence: the
cloning approach was tried in production-grade 2.x development for ~2+
years and was abandoned commit-by-commit. The direction of Solid's
design — across both 1.x and 2.x — has been *toward making the value-bag
larger and more structured*, **and away from external-scheduler-managed
parallel structures**. Carniato's stated principle ("handle the
transition at the computed node level instead of as a scheduler from
outside") *is* the move from a parallel cloned subgraph to per-node
value-bag.

If pulse adopts the node/value-bag framing as the user-facing primitive,
it would be *exposing what Solid arrived at internally* as the API
surface — making explicit what Solid has been keeping implicit.

---

## Principles

The durable, abstract commitments. Framings (next section) are concrete
operational positions that play out these principles in pulse-specific
terms.

### P1 — Speculation is one concept with two faces

What pulse delimits is a **speculative scope**: a tentatively-applied
write-set held over committed state, observable to reads, eventually
committed or discarded. The same scope has two faces — a **write side**
(`action`-shaped: writes flowing toward commit) and a **read side** (a
"speculative zone": gating downstream publication until upstream
speculations settle).

"Optimistic", "transition" (in the React/Solid sense), "loading",
"entanglement", "preview" are *use-labels* for speculation, not separate
mechanisms. The mechanism is one; what differs is what the speculation is
*about*.

Why "speculation" over "transition": "transition" presupposes the commit
(A → B implies B happens), so every framework using it bolts on a
separate vocabulary for the failure mode (revert, rollback, supersede).
"Speculation" is symmetric — *speculate / commit / discard* — and imports
the CPU-speculation mental model (work done against a predicted outcome,
ready to be thrown away if reality disagrees) load-bearingly, not
analogically.

Rejects: bespoke per-use-case primitives that hide the underlying unity,
and naming that presupposes success.

### P2 — Acknowledge async; don't hide it

A `Promise` in the type is honest information: it indicates the value
has (or had) a future. Pulse provides tools to *incorporate* the future,
not erasures that pretend it isn't there. The type stays `Node<Promise<T>>`,
not silently collapsed to `Node<T>`. Unwrapping is explicit (`use`,
`yield* get`, or stage-form's auto-unwrap), and the unwrap-site is where
the async-handling discipline lives.

Rejects: Solid 2.x's `Accessor<T>` collapse + `NotReadyError`, where
hidden async resurfaces as a thrown error in unrelated read sites.

### P3 — Plain reads are honest

A plain `get(node)` returns whatever's cached (committed or speculative
overlay) and never throws. Pending-ness, error-state, and async
non-readiness are separate queries — not exceptions raised from a read.

Rejects: any design where reading a value is a discipline you must learn
to do safely.

### P4 — Explicit boundaries over implicit pervasiveness

A speculative scope is *opt-in*. Outside a scope, writes commit
immediately and reads are honest. Inside a scope, write-level speculation
semantics apply. There is no implicit ambient speculation that every
write must reckon with.

Trade accepted: no-flash behaviour is opt-in — a bare write that triggers
a refetch flashes unless wrapped.

Rejects: Solid 2.x's per-write transition semantics that turn every
async-feeding write into an implicit held speculation.

### P5 — Compose, don't proliferate (in either direction)

A small primitive set should cover the use cases. Specialised ergonomic
sugar over the primitives is *allowed* when it earns its keep — added
because the bare shape is awkward enough for a common case to warrant a
name. It is also not *forbidden* on principle: negative-shape commitments
("no `optimistic` primitive") lock out design space without serving any
value the doc has named.

Rejects (in both directions): React-style proliferation of specialised
hooks for cases that compose cleanly; and pre-emptive refusal of
ergonomic sugar when it would clarify a common use.

---

## Framings (adopted provisionally)

These are durable as *directions to push on*, not as locked-in design positions.
Each is a way of seeing the problem; each can be revised if a later finding falsifies it.

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
walk primitive (`get`, `latest`, `use`, `isPending`, `subscribe`, …) to
a relation. The walks *are* the user-visible surface of the engine's value-bag —
the bag is observed only through walks, never by "the signal's value." This
makes "how to read" a first-class verb the user composes, rather than a fixed
semantic baked into the signal.

### Async is honest in the type

The recipe is `() => T | Promise<T>`; a fully-sync pipeline has no `Promise`;
walks decide how to handle the async case (return-the-Promise, suspend-and-
resume, throw-to-restart). Connects directly to P2 ("acknowledge async,
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
`compute(() => …)`, `get(node)`) without seeing engine internals. *But the
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
discard old scope, open new one.

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
const value = compute(() => get(X) + get(X))
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

### Computeds are stages, with plain or generator callbacks

A `compute(...)` is a pipeline of one or more stages. Each stage is a
memoized node. A stage's callback can be a plain function or a generator
— both compose into the same pipeline; mixed pipelines are fine.

```ts
// Single-stage pipeline, plain callback (sync sugar)
const upperName = compute(() => get(name).toUpperCase())

// Multi-stage pipeline, plain callbacks (declarative)
const greeting = compute(
  () => get(asyncUser),                        // stage 0: source
  (u) => `Hello, ${u}!`,                        // stage 1: u is unwrapped
  (s) => s + "!"                                // stage 2
)
// greeting: Computed<Promise<string>>

// Single-stage pipeline, generator callback (imperative; can park on async)
const profile = compute(function* () {
  const user = yield* get(asyncUser)
  if (user.role === 'admin') return yield* get(adminProfile)
  else                       return yield* get(memberProfile)
})
// profile: Computed<Promise<Profile>>

// Mixed pipeline — plain stages around a generator stage
const summary = compute(
  () => get(value),                             // stage 0: plain source
  function* (value) {                           // stage 1: generator stage
    const other = yield* get(somethingElse)
    return value + other
  },
  (combined) => combined.toUpperCase()          // stage 2: plain transform
)
```

**The stage callback type drives what's possible inside that stage:**

| Stage callback | Async | Dynamic deps | Memoization |
|---|---|---|---|
| **Plain function** `(prev) => O` | Receives `Resolved<prev>` (auto-unwrap); returns `O` (sync) | Yes (signal reads inside track to this stage's node) | Per-stage |
| **Generator** `function* (prev) {...}` | `yield* get(node)` parks; returns `Promise<O>` | Yes, including parking-then-conditional-read patterns | Per-stage |

**Per-stage memoization** is the load-bearing property: if a signal read
in stage N changes, only stage N and downstream re-run; earlier stages
stay cached. This makes pipelines finer-grained than a single
whole-body recompute.

**When to make a stage a generator:** when that stage needs to park on
async signal-reads to decide what to compute next (multi-step async,
conditional async reads, etc.). Plain stages can read async signals
too — they just receive them as `Promise<T>` and pass through, with
auto-unwrap between stages.

**TypeScript inference**: Awaitable's `[Symbol.iterator]` makes
`yield* get(asyncNode)` return the resolved type cleanly; no special
unwrap helper needed.

#### How stages compose

A stage is a memoized node whose input-read auto-unwraps a Promise. No
new engine primitive needed; stages compose from `createNode` + `get` +
`promiseState` (Q-D):

```ts
type Resolved<T> = T extends Promise<infer U> ? U : T
type StageFn<I, O> = (v: Resolved<I>) => O | Generator<unknown, O, any>

function stage<I, O>(input: Node<I>, transform: StageFn<I, O>): Node<O> {
  return createNode(() => {
    const v = get(input)
    const run = (resolved: Resolved<I>) => {
      const result = transform(resolved)
      // If callback returned a generator, drive it (yield-and-park on Promises)
      return isGenerator(result) ? driveGenerator(result) : result
    }
    if (v instanceof Promise) {
      const tracker = currentTracker
      return v.then(resolved => {
        pushTracker(tracker)
        try { return run(resolved as Resolved<I>) }
        finally { popTracker() }
      })
    }
    return run(v as Resolved<I>)
  })
}

function compute<T>(...stages: Array<(prev: any) => any>): Node<unknown> {
  let current: Node<unknown> = createNode(stages[0])
  for (let i = 1; i < stages.length; i++) current = stage(current, stages[i])
  return current
}
```

~20 lines of library code over engine primitives. The `driveGenerator`
helper handles `yield*` over Awaitable values (the same machinery the
action driver uses).

Semantics:

- Each stage is **its own memoized node**. Tracker is restored around
  the stage callback, so signal reads inside track to that stage's node.
- Plain callbacks see the **unwrapped** value (`Resolved<I>`); generator
  callbacks receive it too, and can additionally `yield* get(otherNode)`
  to park mid-stage.
- The compute's **output type** is `Promise<U>` if any stage's callback
  is a generator or returns a Promise; else just `U`. Same model as
  `async`/`await`: any awaited Promise infects the output.

### Action bodies are generator-based for different reasons

Action bodies use generators, but they're not stages — they're imperative
one-shot bodies with commit/discard semantics at end and side effects
allowed. The generator machinery is shared (`yield* get(...)` works the
same way via Awaitable's iterator), but action bodies aren't memoized
derivations; they don't participate in the stage pipeline.

### `use()` is React-style throw-to-suspend at the leaf

`use(node)` is reserved for **leaf consumption with throw-to-suspend
semantics**, matching React's `use()` convention. Used in:

- **JSX expressions** at the leaf — `{use(promise)}` triggers Suspense
  fallback if pending.
- **Action body error handling** — `use(node)` throws to a try/catch in
  the action body.
- **NOT inside a single-stage plain-body computed** —
  `compute(() => use(node))` would collapse `Promise<T>` into `T` at the
  computed's type level, breaking async honesty. Use a multi-stage form
  or a generator stage instead — both preserve the Promise in the output
  type.

This preserves the mental link with React: `use` means "throw if pending,
return resolved." Pulse adopts the same convention.

### Anti-pattern (code smell)

```ts
const greeting = compute(() => `Hello, ${use(user)}!`)
// greeting: Computed<string>  — async hidden, throw-to-suspend mid-graph
```

`use()` here collapses `Promise<string>` into `string` at the callsite,
hiding async from downstream consumers. Move the unwrap into a stage:

```ts
const greeting = compute(() => get(user), (u) => `Hello, ${u}!`)
// greeting: Computed<Promise<string>>  — async honest, per-stage memoized
```

### Why this rule matters

- *Type honesty.* `Computed<Promise<T>>` tells consumers they're dealing
  with async; `Computed<T>` says it's sync. Multi-stage and
  generator-stage forms preserve the type; `use()` mid-graph in a
  single-stage plain body lies.
- *Suspension locality.* `use()` only at leaves means suspension points
  are visible — readers know "I committed to extract sync; I might
  suspend." Mid-graph `use()` makes every downstream read potentially
  suspending with no syntactic signal.
- *Per-stage memoization.* Multi-stage pipelines give
  partial-recomputation that a single-body recompute can't.

**Where each construct goes:**

- *Computeds:* `compute(...stages)` — stages with plain or generator
  callbacks. `use()` inside a single-stage plain body is an anti-pattern.
- *Action bodies:* `action(function* () {...})` with `yield* get(...)`
  for async unwrap.
- *Leaves (JSX, action-body-try):* `use(node)` for React-style
  throw-to-suspend.

(Companion to the "Derivation kind matches reactivity scope" framing
above. Both rules describe where computation work happens.)

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
const doubleName = compute(() => get(name) + get(name))

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
[`../research/async/deep-dives/solid-2x.md`](../research/async/deep-dives/solid-2x.md)).
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

No `signal`, `compute`, `effect`, `get`, `latest`, `action`, `transition`,
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

function compute<T>(fn: () => T): Node<T> {
  return createNode<T>(fn)
}

function get<T>(node: Node<T>): GetReturn<T> {
  const scope = getCurrentScope()
  if (currentTracker) link(node, chainSelector(chainFor(scope)), currentTracker)
  const cached = invoke(node, scope) as T
  if (cached && typeof (cached as any).then === 'function') {
    return makeAwaitable(cached as any) as GetReturn<T>
  }
  return cached as GetReturn<T>
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
const doubleName = compute(() => get(name) + get(name))

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

## End-to-end traces

See [./scenario-traces.md](./scenario-traces.md). Eight traces walk each
architecturally-distinct case through engine + library calls:

- [doubleName trace](./scenario-traces.md#end-to-end-trace-doublename-under-scope-s)
- [C2 trace](./scenario-traces.md#end-to-end-trace-c2--action-body-with-async-read)
- [H1a-c trace](./scenario-traces.md#end-to-end-trace-h1a-c--effect-under-speculation)
- [K1 trace](./scenario-traces.md#end-to-end-trace-k1--re-entrant-setter-mid-recompute)
- [G2 trace](./scenario-traces.md#end-to-end-trace-g2--nested-actions-and-commit-promotion)
- [H3 trace](./scenario-traces.md#end-to-end-trace-h3--cleanup-chains-across-speculative-effect-runs)
- [C2e trace](./scenario-traces.md#end-to-end-trace-c2e--post-yield-derived-read-async-k1b-analogue)
- [H1d trace](./scenario-traces.md#end-to-end-trace-h1d--effect-body-coherence-on-commit)

All eight pass; all four framings hold; no falsifications.

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

**The break, traced concretely.** With `name`, `doubleName = compute(() =>
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
'invalidated' }`), `yield* get` vs `use` vs stages (see framings), Q-I
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

When an action commits, how exactly does the engine sequence the multiple
slot promotions and edge fires so that consumers see a consistent
post-commit state, not a sequence of partial updates?

**Deferred-fires is commit-mode only**, not tracker-mode. Recomputes fire
synchronously; consumers schedule async via microtasks (see K1b trace).
The deferred-fires mechanism is triggered only by opening a commit
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

### Q-M — Optimistic surface ergonomics (sugar over speculation)

Mechanism: an optimistic write is one use of speculation (a predicted
`setX(...)` inside an action body is held in that action's write-set;
auto-discard reverts on failure; commit promotes). No new primitive at
the engine level.

**Open:** does pulse ship a named ergonomic sugar — `optimistic(...)` /
`createOptimistic` — as a thin wrapper over `action`? Per P5, this is
decided on whether the bare action shape is awkward enough for the
optimistic case to warrant a named wrapper. Lean: yes for the
single-predicted-write case (the most common one — predict, await,
either promote or roll back). The API surface is genuinely undecided
beyond that.

### Q-N — Action prereqs / standing-state handle

An action's readiness to run is information that should be queryable
*before* the action runs (a button needs `ready` and `pending` to avoid
double-submit). The body itself can't supply this — it hasn't run yet.

**Open:** does the action expose a small family of standing reactive
states — `ready` (prereqs met), `pending` (body in flight), `error`
(last run failed)? If yes, are the prereqs declared inline (`action(
depsFn, body)`) or via a separate prereq-computed that the action
consumes? Either shape preserves the "gather-up-front /
snapshot-consistent / skew-free input handling" property.

The principle is structurally forced: a standing `ready()` cannot come
from an imperative body that hasn't executed. The prereqs must be
hoisted into a *declared, continuously-evaluated* expression. That
expression is a `compute`/stage. So the structural pattern is **an
action = a reactive prerequisite `compute` → an imperative body invoked
on demand**, with the body receiving the *resolved* prereq values.

Not yet traced; this is a future trace target.

---


## Scenario catalog

See [./scenarios.md](./scenarios.md). The catalog lives in its own file so
it can serve as the basis for the eventual TDD suite without being buried
in framings/traces/questions. Traces cross-link to specific scenarios.

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

- **Research arc:** [`../research/async/README.md`](../research/async/README.md) taxonomy + [`../research/async/LOG.md`](../research/async/LOG.md) chronology + [`../research/async/deep-dives/`](../research/async/deep-dives/) per-system analyses.
- **Lexicon:** [`../research/async/CONTEXT.md`](../research/async/CONTEXT.md) — canonical definitions of the four dimensions, the failure modes, and research vocabulary.
- **Problem space:** [`../research/async/transitions-problem-space.md`](../research/async/transitions-problem-space.md) — the four failure modes worked through with concrete examples.
- **Dives most directly informing this document:**
  - [`../research/async/deep-dives/react-modern.md`](../research/async/deep-dives/react-modern.md)
  - [`../research/async/deep-dives/solid-2x.md`](../research/async/deep-dives/solid-2x.md) — the per-node multi-slot architecture pulse is structurally converging on (with a different user-facing surface).
  - [`../research/async/deep-dives/svelte-5.md`](../research/async/deep-dives/svelte-5.md)
  - [`../research/async/deep-dives/bonsai-incremental.md`](../research/async/deep-dives/bonsai-incremental.md) — the "separate effect layer over reactive substrate" reference point.
  - [`../research/async/deep-dives/xilem-druid.md`](../research/async/deep-dives/xilem-druid.md) — "structural cancellation via Drop" + "Loading-primitive-is-more-valuable-in-JS" findings.
  - [`../research/async/deep-dives/replicache.md`](../research/async/deep-dives/replicache.md) — the "sidestep branching via server-linearized replay" alternative.
- **r3 source** (`node_modules/r3/src/index.ts`) — the substrate this exploration is rooted in; the topological scheduling + push-pull-push fallback machinery carries forward into the pulse-forked engine.

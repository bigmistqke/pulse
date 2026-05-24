# Pulse — principles, framings, and architecture sketches

The current understanding of pulse's design: foundational principles
([P1](#p1--speculation-is-one-concept-with-two-faces)–[P5](#p5--compose-dont-proliferate-in-either-direction)), operational framings (current best-guesses for how to honour
the principles), falsified hypotheses (dead ends to avoid), and engine

- library sketches.

**Companion documents:**

- [README.md](./README.md) — overview + index.
- [prior-art.md](./prior-art.md) — cross-framework analysis (research arc, comparison table, decomposition, node/value-bag recasting).
- [questions.md](./questions.md) — open questions ([Q1](./questions.md#q1--fall-through-and-edge-policy) through [Q14](./questions.md#q14--action-prereqs--standing-state-handle)).
- [scenarios.md](./scenarios.md) — TDD catalog.
- [scenario-traces.md](./scenario-traces.md) — end-to-end traces.

**Related pulse-repo docs:**

- [`../async/CONTEXT.md`](../async/CONTEXT.md) — speculation lexicon, four dimensions, failure modes.
- [`../async/deep-dives/solid-2x.md`](../async/deep-dives/solid-2x.md) — per-node multi-slot architecture reference.

## Contents

**[Principles](#principles)**

- [P1 — Speculation is one concept with two faces](#p1--speculation-is-one-concept-with-two-faces)
- [P2 — Acknowledge async; don't hide it](#p2--acknowledge-async-dont-hide-it)
- [P3 — Plain reads are honest](#p3--plain-reads-are-honest)
- [P4 — Explicit boundaries over implicit pervasiveness](#p4--explicit-boundaries-over-implicit-pervasiveness)
- [P5 — Compose, don't proliferate (in either direction)](#p5--compose-dont-proliferate-in-either-direction)
- [P6 — Pull-driven reads, push-driven consumers, no explicit flush](#p6--pull-driven-reads-push-driven-consumers-no-explicit-flush)

**[Framings (adopted provisionally)](#framings-adopted-provisionally)**

- [Signals and computeds are graph relations, not values](#signals-and-computeds-are-graph-relations-not-values)
- [Walks are first-class](#walks-are-first-class)
- [Async is honest in the type](#async-is-honest-in-the-type)
- [Signal / Computed / Effect / JSX-expression are all the same primitive](#signal--computed--effect--jsx-expression-are-all-the-same-primitive)
- [Slim engine, thick library — engine resolution is open](#slim-engine-thick-library--engine-resolution-is-open)
- [Slot writes and recomputes are the same operation](#slot-writes-and-recomputes-are-the-same-operation)
- [Edges are slot-local, dynamic, and walk-policy-driven](#edges-are-slot-local-dynamic-and-walk-policy-driven)
- [Scope and Owner share structure (unification under exploration)](#scope-and-owner-share-structure-unification-under-exploration)
- [Derivation kind matches reactivity scope (computed vs. effect)](#derivation-kind-matches-reactivity-scope-computed-vs-effect)
- [Computeds are stages, with plain or generator callbacks](#computeds-are-stages-with-plain-or-generator-callbacks)
- [Action bodies are generator-based for different reasons](#action-bodies-are-generator-based-for-different-reasons)
- [`use()` is React-style throw-to-suspend at the leaf](#use-is-react-style-throw-to-suspend-at-the-leaf)
- [Anti-pattern (code smell)](#anti-pattern-code-smell)
- [Why this rule matters](#why-this-rule-matters)
- [`Awaitable<T>` — one type, three legitimate uses](#awaitablet--one-type-three-legitimate-uses)

**[Falsified hypotheses](#falsified-hypotheses)**

- [Speculation purely above unmodified r3 doesn't work](#speculation-purely-above-unmodified-r3-doesnt-work)
- [`.value` / `.peek()` / `.latest()` as methods on the Node would survive without smuggling](#value--peek--latest-as-methods-on-the-node-would-survive-without-smuggling)

**[Engine API sketch (illustrative)](#engine-api-sketch-illustrative)**

**[Library shape (illustrative)](#library-shape-illustrative)**

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
"entanglement", "preview" are _use-labels_ for speculation, not separate
mechanisms. The mechanism is one; what differs is what the speculation is
_about_.

Why "speculation" over "transition": "transition" presupposes the commit
(A → B implies B happens), so every framework using it bolts on a
separate vocabulary for the failure mode (revert, rollback, supersede).
"Speculation" is symmetric — _speculate / commit / discard_ — and imports
the CPU-speculation mental model (work done against a predicted outcome,
ready to be thrown away if reality disagrees) load-bearingly, not
analogically.

Rejects: bespoke per-use-case primitives that hide the underlying unity,
and naming that presupposes success.

### P2 — Acknowledge async; don't hide it

A `Promise` in the type is honest information: it indicates the value
has (or had) a future. Pulse provides tools to _incorporate_ the future,
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

A speculative scope is _opt-in_. Outside a scope, writes commit
immediately and reads are honest. Inside a scope, write-level speculation
semantics apply. There is no implicit ambient speculation that every
write must reckon with.

Trade accepted: no-flash behaviour is opt-in — a bare write that triggers
a refetch flashes unless wrapped.

Rejects: Solid 2.x's per-write transition semantics that turn every
async-feeding write into an implicit held speculation.

### P5 — Compose, don't proliferate (in either direction)

A small primitive set should cover the use cases. Specialised ergonomic
sugar over the primitives is _allowed_ when it earns its keep — added
because the bare shape is awkward enough for a common case to warrant a
name. It is also not _forbidden_ on principle: negative-shape commitments
("no `optimistic` primitive") lock out design space without serving any
value the doc has named.

Rejects (in both directions): React-style proliferation of specialised
hooks for cases that compose cleanly; and pre-emptive refusal of
ergonomic sugar when it would clarify a common use.

### P6 — Pull-driven reads, push-driven consumers, no explicit flush

Reading a value always returns the result consistent with the latest
writes, synchronously. No `flush()`, no `batch(() => ...)`, no "await a
microtask before reading." Side-effecting consumers (effects, JSX
re-renders) are batched via microtask de-dup — multiple invalidations
in one synchronous turn produce exactly one re-run — but the batching
is invisible to read sites.

```ts
setValue('x')
console.log(get(doubleValue))   // "xx" — synchronously, always
```

The mechanism: invalidation propagates synchronously through the dep
graph (cache cleared, dirty bit set); recomputes happen lazily on read.
Consumers (push-driven) use a per-Node "scheduled" flag to coalesce
their re-runs to one per microtask. Reads (pull-driven) never wait.

Rejects: any design where the user has to remember to flush a queue, await
a microtask, or close a batch before reading coherent state. Reading is
not a discipline.

See [Q3](./questions.md#q3--consumer-patterns) for the consumer
implementation and [Q10](./questions.md#q10--commit-as-transaction-ordering-atomicity-deferred-fires)
for how this interacts with commit's deferred-fires region (commit's
batching is also invisible to subsequent reads).

---

## Framings (adopted provisionally)

These are durable as _directions to push on_, not as locked-in design positions.
Each is a way of seeing the problem; each can be revised if a later finding falsifies it.

### Signals and computeds are graph relations, not values

A `Signal<T>` (and `Computed<T>`) is `Node<() => T | Promise<T>>` — a stable
identity in the dep graph wrapping a recipe. The value is what you get by
handing the Node to a walk. Putting `.value`, `.peek()`, `.latest()`, or any
value-producing method on the Node would re-couple identity and value through
syntax — so the strictness extends to: the Node has no value-producing methods
or properties at all. _The signal IS the relation; the value is queried from
outside via walks._

### Walks are first-class

Reads are not implicit "call the signal." They are explicit applications of a
walk primitive (`get`, `latest`, `use`, `isPending`, `subscribe`, …) to
a relation. The walks _are_ the user-visible surface of the engine's value-bag —
the bag is observed only through walks, never by "the signal's value." This
makes "how to read" a first-class verb the user composes, rather than a fixed
semantic baked into the signal.

### Async is honest in the type

The recipe is `() => T | Promise<T>`; a fully-sync pipeline has no `Promise`;
walks decide how to handle the async case (return-the-Promise, suspend-and-
resume, throw-to-restart). Connects directly to [P2](#p2--acknowledge-async-dont-hide-it) ("acknowledge async,
don't hide it").

### Signal / Computed / Effect / JSX-expression are all the same primitive

All four are `Node<() => T>`. What differs is their _connection pattern_:

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

The "graph" isn't a separate thing — it's the _implicit structure of
who-walks-whom_; edges form when a recipe walks another Node.

### Slim engine, thick library — engine resolution is open

The library ships an approachable surface — named patterns over a generic core.
Users get familiar DX (`const [name, setName] = signal("foo")`,
`compute(() => …)`, `get(node)`) without seeing engine internals. _But the
engine is reachable_ — a user (or library author building on pulse) can drop
down and define their own semantics over the graph. Custom walks, custom edge
metadata, custom scope shapes — all expressible in user code without engine
changes. This is the user-stated principle: _the goal is not complex DX; the
goal is to give users the option to add their own ideas of what this graph
resolves to._

### Slot writes and recomputes are the same operation

Setters and engine-driven recomputes both _write a slot with a recipe_. The
engine doesn't need separate `setSignal` and `recompute` primitives — just
`writeSlot`. The library calls it from user setters; the scheduler calls it from
its recompute logic. The privileged status of user-initiated writes dissolves.

### Edges are slot-local, dynamic, and engine-chain-aware

Edges are plain `(source: Node, target: Slot)` references held by the source
Node's `subs` list (r3-shape). Each (Node, Scope) slot has its own incoming
and outgoing edge lists; a recompute rebuilds the slot's `deps` from scratch;
discarding a slot cascades its edges away. The "which source slot fires which
target slot" policy is **engine-side** ([Q1](./questions.md#q1--fall-through-and-edge-policy)
Model 1): on a write, the engine consults `chainFor(edge.target.scope)`,
checks whether `writeScope` is in the chain and not shadowed by a more-specific
slot, and fires if so. Fall-through semantics live in that one predicate;
the edge structure carries no scope refs and no closures.

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

- **Computed** = _scope-aware derivation._ A computed's slot is created on
  demand; reading it inside a speculative scope `S` recomputes under `S`,
  walking the chain `[S, …, ROOT_SCOPE]`. The returned value is coherent
  with `S`'s overlays.
- **Effect** = _committed-state subscription._ An effect's body runs in
  response to _commits_ (its target slot lives in `ROOT_SCOPE`, so the
  engine's chain-match only fires on `ROOT_SCOPE` writes), not speculative
  writes. Downstream signals that an effect maintains reflect committed
  state. The effect's body re-runs _after_ commit; inside an in-flight
  action that wrote one of the effect's deps, those downstream signals are
  stale.

The two are not interchangeable for the same "derive Y from X" need:

```ts
// Effect-mediated derivation: STALE inside the action that wrote X
effect(() => setValue(get(X) + get(X)))
action(() => {
	setX('new')
	get(value)
}) // returns the OLD value

// Computed-mediated derivation: FRESH inside the action that wrote X
const value = compute(() => get(X) + get(X))
action(() => {
	setX('new')
	get(value)
}) // returns the NEW value
```

The mechanism: a _computed_ has no consumer scheduler; its slot is populated
on demand via `invoke` under whatever scope is reading. An _effect_ IS a
consumer whose scheduling is gated by the engine's chain-match predicate
([Q1](./questions.md#q1--fall-through-and-edge-policy)), and (per H1a-c)
defer-until-commit naturally excludes in-action visibility.

**Guidance:** choose by whether downstream consumers need _synchronously
fresh visibility into speculative state_ (computed) or _settled-state
visibility for side effects_ (effect — DOM updates, network calls,
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
	() => get(asyncUser), // stage 0: source
	u => `Hello, ${u}!`, // stage 1: u is unwrapped
	s => s + '!', // stage 2
)
// greeting: Computed<Promise<string>>

// Single-stage pipeline, generator callback (imperative; can park on async)
const profile = compute(function* () {
	const user = yield* get(asyncUser)
	if (user.role === 'admin') return yield* get(adminProfile)
	else return yield* get(memberProfile)
})
// profile: Computed<Promise<Profile>>

// Mixed pipeline — plain stages around a generator stage
const summary = compute(
	() => get(value), // stage 0: plain source
	function* (value) {
		// stage 1: generator stage
		const other = yield* get(somethingElse)
		return value + other
	},
	combined => combined.toUpperCase(), // stage 2: plain transform
)
```

**The stage callback type drives what's possible inside that stage:**

| Stage callback                         | Async                                                       | Dynamic deps                                          | Memoization |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| **Plain function** `(prev) => O`       | Receives `Resolved<prev>` (auto-unwrap); returns `O` (sync) | Yes (signal reads inside track to this stage's node)  | Per-stage   |
| **Generator** `function* (prev) {...}` | `yield* get(node)` parks; returns `Promise<O>`              | Yes, including parking-then-conditional-read patterns | Per-stage   |

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
`promiseState` ([Q4](./questions.md#q4--async-at-the-engine-level)):

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
				try {
					return run(resolved as Resolved<I>)
				} finally {
					popTracker()
				}
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
const greeting = compute(
	() => get(user),
	u => `Hello, ${u}!`,
)
// greeting: Computed<Promise<string>>  — async honest, per-stage memoized
```

### Why this rule matters

- _Type honesty._ `Computed<Promise<T>>` tells consumers they're dealing
  with async; `Computed<T>` says it's sync. Multi-stage and
  generator-stage forms preserve the type; `use()` mid-graph in a
  single-stage plain body lies.
- _Suspension locality._ `use()` only at leaves means suspension points
  are visible — readers know "I committed to extract sync; I might
  suspend." Mid-graph `use()` makes every downstream read potentially
  suspending with no syntactic signal.
- _Per-stage memoization._ Multi-stage pipelines give
  partial-recomputation that a single-body recompute can't.

**Where each construct goes:**

- _Computeds:_ `compute(...stages)` — stages with plain or generator
  callbacks. `use()` inside a single-stage plain body is an anti-pattern.
- _Action bodies:_ `action(function* () {...})` with `yield* get(...)`
  for async unwrap.
- _Leaves (JSX, action-body-try):_ `use(node)` for React-style
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
				v => {
					this.status = 'fulfilled'
					this.value = v
					resolve(v)
				},
				e => {
					this.status = 'rejected'
					this.reason = e
					reject(e)
				},
			)
		})
	}

	*[Symbol.iterator](): Generator<this, T, T> {
		return (yield this) as T // yield self; driver awaits; resume with resolved
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
	if (tweaked.status === 'fulfilled') {
		a.status = 'fulfilled'
		a.value = tweaked.value
	} else if (tweaked.status === 'rejected') {
		a.status = 'rejected'
		a.reason = tweaked.reason
	}
	return a
}
```

**The three uses of the same `get` call:**

```ts
const u = get(asyncUser) // u: Awaitable<string>

// (1) Sync query — honest about state
if (u.status === 'fulfilled') console.log(u.value)
if (u.status === 'pending') showSpinner()
if (u.status === 'rejected') showError(u.reason)

// (2) Async wait (Awaitable IS Promise)
const v = await u // v: string
u.then(v => console.log(v)) // works — standard Promise interface

// (3) Generator wait (Awaitable IS iterable)
function* body() {
	const v = yield* u // v: string (via Iterator's TReturn)
}

// Sync nodes — bare value, no wrapping
const n = get(syncCount) // n: number
```

**What this folds together:**

- _Single verb (`get`)_ for all access patterns — no separate `take` /
  `wait` / `read` utility for the generator-form unwrap.
- _Q4's Promise-tweak vs WeakMap question collapses_ — state lives on
  the Awaitable class instance (we own it), not mutated onto foreign
  Promises. A `promiseState()` helper is unnecessary; the fields are
  directly on the value.
- _React-convention interop preserved_ via `makeAwaitable`'s duck-type
  check — pulse adopts the state of any Promise that already carries
  `status`/`value`/`reason` fields, no matter who tweaked them.
- _Compatible with existing Promise utilities_ (`Promise.all`,
  `Promise.race`, `await`, `.then`) because Awaitable extends Promise.
- _Action-body generator unwrap is `yield_ get(...)`* — Awaitable's
`[Symbol.iterator]`makes this work; no separate`take`/`from`/`wait`
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
const [name, setName] = signal('foo')
const doubleName = compute(() => get(name) + get(name))

action(function* () {
	setName('name')
	console.log(get(doubleName)) // expected: "namename"
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

**Resolution.** The engine needs multiple cache cells (slots) per Node,
one per scope. Solid 2.x reached the same structural conclusion empirically
after abandoning node-graph-cloning (see
[`../async/deep-dives/solid-2x.md`](../async/deep-dives/solid-2x.md));
Solid stores these slots on the node, pulse stores them on the *scope*
(per [Q6](./questions.md#q6--what-is-a-scope-as-a-value)) for explicit
disposal — but the structural fact is the same. Pulse's user-facing
novelty (Node-as-recipe + walks) is preserved; the engine internals
keep r3's propagation algorithm with scope-centric storage. **This is not
"r3 unchanged"** — it's r3 forked-and-extended.

### `.value` / `.peek()` / `.latest()` as methods on the Node would survive without smuggling

**Tried.** "A method on the Node that queries the bag, like `node.value`,
preserves the framing because the value isn't _stored_ on the Node — the method
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

interface Slot<T> {
	recipe: () => T | Promise<T> // what produces the value
	cached?: T | Promise<T> // engine-managed cache
	deps: Edge[] // edges this slot was computed against
}

interface Node<T> {
	defaultRecipe?: () => T | Promise<T> // fallback when a scope has no slot
	subs: Set<Edge> // who subscribes to this node (write-fire index)
}

interface Scope {
	parent?: Scope
	children: Set<Scope>
	slots: Map<Node<unknown>, Slot<unknown>> // this scope's per-node caches (Q6)
	edges: Set<Edge> // edges created in this scope (cleanup tracker)
	writeSet: Set<Node<unknown>> // for commit promotion (Q9 ii)
	readSet: Set<Node<unknown>> // for slot drop on close
	cleanups: Disposable[]
	status: 'open' | 'committed' | 'discarded'
	kind: 'owner' | 'speculative' // library metadata; gates invariants like Q3's effect-creation restriction
}

interface Edge {
	source: Node<unknown>
	target: Slot<unknown>
	targetScope: Scope // for chain-match: chainFor(targetScope)
}

// Engine's fire predicate (Q1 Model 1):
//   On writeSlot(node, writeScope, ...), for each edge in node.subs:
//     chain = chainFor(edge.targetScope)
//     if writeScope is in chain AND no more-specific scope has a slot for node
//       → invalidate(edge.target)

// ── Engine: primitives ────────────────────────────────────────

function createNode<T>(defaultRecipe?: () => T | Promise<T>): Node<T>
function writeSlot<T>(node: Node<T>, scope: Scope, slot: Slot<T>): void
function readSlot<T>(node: Node<T>, scope: Scope): Slot<T> | undefined
function invoke<T>(node: Node<T>, scope: Scope): T | Promise<T>
function link(source: Node<unknown>, target: Slot<unknown>): Edge // adds to source.subs + currentScope.edges
function unlink(edge: Edge): void // removes from both
function subscribe(node: Node<unknown>, handler: (e: SlotChangeEvent) => void): () => void

// ── Engine: ambient context ───────────────────────────────────

function openScope(): Scope // creates child of current
function closeScope(scope: Scope, mode: 'commit' | 'discard'): void // walks scope.edges + readSet to dispose explicitly
function onCleanup(fn: Disposable): void // attaches to current ambient scope
function getCurrentScope(): Scope // always returns a scope (library convention; see ROOT_SCOPE below)
```

No `signal`, `compute`, `effect`, `get`, `latest`, `action`, `transition`,
`speculation`, "canonical," or "committed" in the engine vocabulary. The engine
sees scopes that own slots/edges and nodes that index their subscribers.
Those concepts are all library code.

## Library shape (illustrative)

```ts
// Library convention: a singleton root scope (no parent) stands in for
// "outside any speculative context." Engine treats it like any other
// parentless scope (per Q6).
const ROOT_SCOPE: Scope = {
	parent: undefined, children: new Set(),
	slots: new Map(), edges: new Set(),
	writeSet: new Set(), readSet: new Set(),
	cleanups: [], status: 'open', kind: 'owner',
}

function signal<T>(initial: T): [Node<T>, (v: T) => void] {
	const node = createNode<T>(() => initial)
	return [node, v => writeSlot(node, getCurrentScope(), { recipe: () => v, deps: [] })]
}

function compute<T>(fn: () => T): Node<T> {
	return createNode<T>(fn)
}

function get<T>(node: Node<T>): GetReturn<T> {
	const scope = getCurrentScope()
	scope.readSet.add(node)
	if (currentTracker) link(node, currentTracker)
	const cached = invoke(node, scope) as T
	if (cached && typeof (cached as any).then === 'function') {
		return makeAwaitable(cached as any) as GetReturn<T>
	}
	return cached as GetReturn<T>
}

function latest<T>(node: Node<T>): T {
	return invoke(node, ROOT_SCOPE) as T // bypass any active speculation
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

// chainFor(S) walks parent pointers until undefined:
//   chainFor(S2) where S2.parent = S1, S1.parent = ROOT_SCOPE, ROOT_SCOPE.parent = undefined
//     → [S2, S1, ROOT_SCOPE]
//   chainFor(ROOT_SCOPE) → [ROOT_SCOPE]
// Terminal is structural (no parent), not a privileged key. Multiple
// disjoint roots (per-tenant, per-document) are supported by construction.
```

The engine never treats `ROOT_SCOPE` specially — it's just a parentless
scope the library creates by default. A library author wanting per-tenant
roots, per-document roots, or multiple independent reactive worlds
constructs additional parentless scopes; the engine doesn't care.

Usage retains familiar shape:

```ts
const [name, setName] = signal('foo')
const doubleName = compute(() => get(name) + get(name))

get(name) // "foo"
get(doubleName) // "foofoo"
setName('bar')
get(name) // "bar"
get(doubleName) // "barbar"

action(function* () {
	setName('name')
	console.log(get(doubleName)) // "namename" — slots resolve under the active scope
})
get(name) // "bar" — committed unchanged outside the scope
```

---

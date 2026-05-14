# pulse — design spec

**Status:** design complete for the async/reactivity core + DOM layer (v1).
**Date:** 2026-05-14.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md) (glossary), `docs/adr/0001`–`0004` (point decisions). This spec is the readable whole; those stay as the living reference.

---

## 1. Motivation

pulse is a mini reactive UI framework built on [r3](../../../../r3). It exists to
explore an alternative to Solid 2.x's async direction.

Solid 2.x has one genuinely good idea: **async as a first-class citizen**.
Computations themselves can be async — there is no parallel set of primitives
(no `createResource` separate from signals), and the rest of the system
(effects, boundaries) treats async consistently. **pulse keeps exactly this.**

What pulse does *not* keep is Solid's attempt to **uncolor** async — to let a
consumer read an async value as if it were sync. pulse leaves async visibly
colored (§6). And the mechanisms Solid reaches for, pulse rejects outright:

- **Throwing as the load-bearing mechanism.** Every async accessor implicitly
  `throw`s a `NotReadyError`. This is special-cased through the whole core
  (`recompute`, `read`, boundaries, lane merging, `isPending`, `latest`). It
  destroys lifetime type safety and makes "what's causing what" hard to trace.
- **Hidden transitions.** Transitions are runtime-managed and entangled across
  time; the developer cannot see where one begins or what it contains.
- **Assumptions about app shape.** The async model is designed around
  data-loading inside `<Loading>` boundaries — but asynchronicity is broader
  than fetch-a-user-and-suspend-a-subtree.

pulse's thesis: **async is first-class, just as in Solid — but pulse does not
try to uncolor it.** Async is a general capability, represented honestly,
propagated visibly, and never threaded through hidden machinery.

### Guiding principles

1. **Honest types.** A value that may be async is typed `T | Promise<T>`. No
   accessor lies about its return type.
2. **No throwing for control flow.** Throwing is reserved for genuine errors.
   Pending is an expected state, so pending is a *value*, never a throw.
3. **No hidden scheduling.** Scheduling exists, but as a named, inspectable,
   injectable object — not buried magic.
4. **Greppable causality.** Every dependency and every suspension point is a
   literal call you can search for.
5. **Minimal assumptions / ruthless YAGNI.** pulse is a small toolkit. Features
   that solve problems most apps don't have are deferred or omitted.
6. **r3 stays unmodified.** pulse is a consumer of r3's public API. If pulse
   needs something r3 can't express, that is a finding to surface, not a silent
   fork.

---

## 2. Architecture

Two thin layers on top of unmodified r3:

```
┌─────────────────────────────────────────┐
│  pulse/dom    — components, control flow,│
│                 bindings, effects        │
├─────────────────────────────────────────┤
│  pulse/core   — pipelines/stages, read,  │
│                 checkpoint resume,       │
│                 scheduler, effects        │
├─────────────────────────────────────────┤
│  r3           — unchanged: signal,       │
│                 computed, read,          │
│                 setSignal, stabilize     │
└─────────────────────────────────────────┘
```

r3 is a computation core only: `signal`/`computed`/`read`/`setSignal`/
`stabilize`, height-ordered topological execution with a push-pull-push
fallback, plus `onCleanup`. It has **no effects, no scheduler, no async**.
`setSignal` only marks the dirty heap; `stabilize()` drains it. pulse supplies
everything above that line.

---

## 3. The reactivity model

### Signals

A **signal** is plain reactive data — `{ value }`-shaped, not an accessor
closure. Its value type is `T | Promise<T>`: a signal may hold a promise, which
is how "a value in the future" is represented. There is no invented "pending"
sentinel — a `Promise` *is* the pending representation.

A signal is read two ways:

- **Accessor** — `count()` — the bare call form, for synchronous reads outside
  generator stages (sync computeds, effects, DOM bindings). Returns
  `T | Promise<T>`, tracks normally.
- **`yield* read(x)`** — inside a `function*` stage. See below.

### Computeds: pipelines of stages

A **computed** is a derived signal, defined as a **pipeline** of one or more
**stages**:

```ts
const x = computed(
  () => signal() * 2,             // stage 0: sync
  async (value) => fetch(value),  // stage 1: async
  (value) => value.json(),        // stage 2: sync
  function* (value) { ... },      // stage 3: generator
)
```

The runtime threads a value through: **stage N receives stage N-1's (unwrapped)
return value**. A stage is independently sync `(value) => …`,
`async (value) => …`, or `function* (value) { … }`, and they can be freely
mixed. A single sync function or single generator is just a one-stage pipeline —
there is one API, not three.

Every stage may read reactive signals and tracks its own dependency set. Stage
N's parameter type is inferred from stage N-1's return type — which is why
pipeline *stage boundaries* need no special inference helper.

### `read` — the generator-side resolver

Inside a `function*` stage, signals are read with `yield* read(x)`:

```ts
const name = computed(function* () {
  const u = yield* read(user)   // u: User, correctly inferred
  return u.name
})
```

`read` exists for a mechanical TypeScript reason: in a generator, `const x =
yield expr` types `x` as the generator's single `TNext` type — uniform across
every `yield`, so per-yield inference is impossible. `yield*` *delegation* is the
only escape: `const x = yield* iterator` infers `x` as the iterator's return
type. `read(x)` is the helper that wraps its argument into a typed sub-iterator.

`read` is the universal generator-side resolver. `x` may be:

- a **signal** → tracked and resolved
- a **bare promise** → suspended on, *untracked* (re-evaluated on replay; the
  author chooses this trade by not routing it through a signal)
- a **plain value** → returned immediately

`yield` does suspension; `read` does tracking; they compose freely.

### Segments and checkpoint resume

A **checkpoint** is a `yield*` point in a `function*` stage. A **segment** is a
unit of re-execution with its own dependency set and a cached result. A pipeline
**stage is a segment**; within a `function*` body, the code between two
checkpoints is also a segment.

**Checkpoint resume** is the re-execution strategy. On invalidation — an async
dep resolving/changing, *or* a sync dep updating — the runtime finds the
*earliest invalid segment*; every prior segment **replays from cache** (fast-
forward, synchronously), and execution resumes for real from the first invalid
one. It is neither "restart from the top" nor "blindly resume from the last
suspension".

Mechanically, since a generator cannot rewind: "resume from segment N" = re-run
from the top, fast-forwarding cached segments synchronously until the first
invalid checkpoint. Checkpoint resume is cheap **only when yielded async values
have stable identity** — yield signals-holding-promises, not freshly-minted
promises. This is a discipline pulse documents, not a rule it enforces.

---

## 4. The scheduler — ADR 0001

r3 has no scheduler; `stabilize()` must be called explicitly. pulse abstracts
this away — **`stabilize()` is never user-facing.**

pulse uses **one injectable scheduler** that flushes the effect graph and
resumes suspended computeds. It is triggered identically by a synchronous
`setSignal` and by an async promise settling — same queue, same drain, one
mental model. The default batches on a microtask; tests inject a synchronous-
drain scheduler.

The unified model is safe because of a separate invariant — **pull-on-read**:
reading any signal or computed walks it up to date synchronously, regardless of
whether a flush has run or where the read happens. The scheduler batches
*effects* only; it never gates *read correctness*. So "unified" never means
"stale reads" — it only means effects batch.

---

## 5. The pending model — ADR 0002

### Pending is a value

A pending async computation simply holds a `Promise<T>`. Consumers see the
promise and decide what to do. There is no implicit throw and no loading
boundary in v1. `isUnresolved(signal)` is the reactive predicate "is the current
value a Promise".

### Write-back on settle

When a held promise settles, its resolved value is written back into the signal
(`setSignal`), flipping it `Promise<T>` → `T`. This is **forced**, not a free
choice: without write-back, a re-run after settle would re-throw forever (see
`use`). Write-back keeps the invariant that a signal's value at any instant
is *either* a settled `T` *or* a pending `Promise<T>`.

The one documented wart: if `T` itself can be a `Promise`, `T | Promise<T>` is
ambiguous — pulse treats any promise value as pending. Box a stored promise if
you genuinely need one as data.

### `use` — the opt-in throw

```ts
use<T>(x: T | Promise<T>): T   // resolved value, or throws NotReadyYet
```

`use` is the explicit bridge that fills the **trilemma**: honest types ·
terse `{user().name}` JSX · no throwing — pick two. Because `use` returns
`T`, `{use(user).name}` typechecks without dishonest signal types.

`NotReadyYet` carries the promise and propagates up the *synchronous read stack*
— for free, via JS `throw` + r3's pull-on-read chain — until an **effect**
catches it, suspends that node, and re-runs on settle.

**Throwing belongs in effects.** Effects — including JSX bindings — are the only
legitimate catch sites, so `use` is *for* effects. Using it anywhere else (a
component body, a `computed`, a pipeline stage) is misplaced: the throw escapes
its intended one-frame hop to some ancestor effect, often a parent's rendering
effect — i.e. unwanted subtree suspension. Allowed (not enforced), but a code
smell everywhere outside an effect.

Unlike Solid's pervasive *implicit* throw, `use` is explicit, local, and
grep-able.

A `computed` wrapper must **not** internally catch `NotReadyYet` to make `use`
"just work" in a sync computed: a plain lambda's `=> T` type cannot express "or
`Promise<T>`", so catching internally would make the computed's type a lie —
the exact Solid dishonesty pulse rejects. Throw-on-read is the honest behaviour;
restructuring as a generator/pipeline stage (where `yield*` carries the type) is
the honest fix. See ADR 0002.

### Errors throw to graph-node boundaries

Throwing is reserved for *genuine errors*, never for the expected "pending"
state. A real error propagates up the graph to an **Error Boundary** — a graph
node (not a stack `try/catch`) that registers as the error sink for its subtree,
catching both synchronous throws and async rejections routed during scheduler
resumption. v1 has Error Boundaries but no Loading boundaries.

---

## 6. Async color propagation — ADR 0004

Solid 2.x *erases* async color: `user()` is typed `User` and throws if not
ready. pulse does the opposite — the color is visible at every level:
`T | Promise<T>` in types, `function*` on generator stages, `yield*` at async
read sites, `Promise<T>` as a suspended computed's value, a render-function form
at async JSX bindings. **Coloring all the way through.**

This is deliberate, and it does *not* reintroduce the function-coloring
*problem* (non-composition, duplicated logic, refactor pain), because the
quansync mechanism keeps the ergonomics: `yield* read(x)` is one code path
whether `x` is sync or async; a generator stage whose deps are all settled runs
**fully synchronously, zero allocation**; pipelines compose sync and async
stages freely. What is dropped is the *erasure* — and the erasure is exactly
what made causality untraceable and types dishonest in Solid.

So pulse is not "uncolored async". It is **honestly colored, but the color is
free to carry.** The color costs *visibility* — and visibility is the goal.

**Consequence — viral type propagation.** Making a deep leaf signal async forces
every transitive consumer to become a `function*`/pipeline. This is a real
refactor cost, but it surfaces as a *type error walking up the graph*, not a
runtime surprise. Because generator stages with sync deps cost nothing, "write
computeds as generators by default" is a legitimate stance that sidesteps the
churn.

---

## 7. Async re-entry — ADR 0003

A pulse computed can suspend mid-flight; r3's `recompute` is synchronous start-
to-finish. Re-entry is handled by making a pulse computed **one ordinary r3
`computed` node**:

- Its `fn` wrapper runs the pipeline as far as it can synchronously.
- On hitting a suspending stage, `fn` returns the in-flight `Promise<T>` as the
  node's value (so downstream sees a promise — color propagates) and stashes the
  live pipeline state (current stage, cached segment values, a generation
  counter) on the node.
- A `.then` triggers write-back and asks the scheduler to re-queue the node.
- Re-evaluation resumes from the stashed state via checkpoint resume.

No fork of r3, no second heap: async re-entry reuses the exact "scheduler
re-queues a dirty node" path as everything else. The cost is concentrated
complexity in one bounded wrapper (stash, resume, stale-run guard) — accepted
over async-awareness spread through the core.

Comparison with Solid 2.x: Solid propagates "not ready" as a *thrown sentinel*
special-cased through the core, and — because plain-function computations have
no pause points — must *re-run from the top*. pulse propagates it as a *value*,
keeps r3 untouched, and does *checkpoint resume* (incremental re-execution Solid
structurally cannot do). Solid is genuinely simpler in one respect: re-run-from-
top needs no stashed state. pulse's bet is "concentrated wrapper complexity, zero
core complexity". pulse also drops Solid's coordinated reveals in v1 — see §9
and §10.

---

## 8. Effects

An **effect** is the node type r3 lacks: a computed-shaped node with no
observable value, registered as a scheduler sink. It tracks dependencies like a
computed (so `read`/accessors work inside it), but instead of being pulled
lazily, the **scheduler pushes it** — when a dep changes it is queued and run on
the next tick. Effects are the active edge of the graph; computeds stay lazy.

An effect body may be a generator, exactly like a stage — an effect that
suspends just doesn't run its side effect until its yielded promises settle,
via the same checkpoint-resume machinery.

Effect cleanup is r3's `onCleanup`, surfaced as-is. An effect re-running runs its
cleanup first.

---

## 9. The DOM layer

### Components

A **component** is a function that runs once and returns a DOM node tree — a
pure *synchronous* DOM factory. A component body **never suspends**: it is not an
effect, so it must not throw `NotReadyYet`. Async always lives *inside* a
component — in bindings and effects — never in the body's own control flow. A
component is never "not there yet"; it mounts synchronously and its holes fill
per-node.

### Bindings — the trilemma resolution

Sync bindings stay bare and terse: `{count()}`. Async bindings cannot be bare
(`{user().name}` does not typecheck — `.name` on `Promise<User>`). The honest
options:

```tsx
{use(user).name}      // opt-in throw, caught by this binding-effect
{[user, u => u.name]}     // no throw — explicit render fn, u: User typechecks
```

Both keep honest types and visible color. They coexist; the author picks per
binding. A pending binding affects **only that binding** — siblings, parent, and
unrelated subtrees render normally. By default a pending binding holds its
previous content (stale-but-stable); first render with no previous content shows
nothing.

### Control flow

`Show`, `Switch`, `For` are ordinary components that stay **total and pure** —
they never throw and never suspend internally. They apply a trivial total
coercion of the pending state:

- `For` treats a pending list (`Promise<T[]>`) as `[]` — zero rows.
- `Show` treats a pending condition as falsy.

No async policy is baked in. Async behaviour is decided entirely by what the
caller passes and where they put `use`:

```tsx
<For each={users}>…</For>                                   // raw → total coercion: empty while pending
<Suspense><For each={() => use(users())}>…</Suspense>   // use at call site → throws → Suspense catches
```

This is the same "you choose the catch site" rule as everywhere else.
Consequence: in v1, `For` over an async list **flickers to empty** on refetch;
hold/fallback coordination is a v2 `<Suspense>` concern.

`Show` and `For` take a local **`fallback`** prop. It is an *empty-state* prop —
shown when there is no content (`Show`: condition falsy; `For`: zero rows).
Because pending coerces to empty/falsy, `fallback` transparently covers the
pending case too, with no async-awareness in the primitive. One `fallback`
therefore **conflates "genuinely empty" with "still pending"**; distinguishing
them needs an explicit `isUnresolved` check or v2 `<Suspense>`.

### Keying

`For` keys async items by **reference** — the array slot's value (a
`Promise<User>` or a `User`) by identity, never a resolved field like `.id` (a
key function cannot suspend, so a pending item's `.id` is unavailable). A pending
row gets a stable slot immediately and fills per-node on settle. The cost: a
*new* promise for the same logical item is a new key → remount — avoided by the
stable-promise-identity discipline. Two-phase re-keying (reference → resolved
field, with reconcile-on-collision) is deferred to v2.

---

## 10. Transitions — exploratory, post-v2

A **transition** is an explicit, inspectable *value* that coordinates a group of
async updates: it holds member nodes' DOM commits and reveals them atomically
when all settle, and exposes a `pending` signal.

```ts
const t = transition(() => setSignal(userId, 2))
t.pending   // Signal<boolean>
t.settled   // Promise<void>
t.abort()   // supersede
```

pulse needs **no entanglement engine** — the thing Solid requires because it
*erased* the async info. pulse keeps it materialised as `Promise<T>` values: a
suspended computed stays promise-valued across *all* its async waves
automatically, so "discovery over time" is free. The transition's whole job
reduces to **membership + atomic commit + observable handle**.

Membership has two sources, both explicit, neither a runtime graph-walk:

1. nodes invalidated in the trigger scheduler pass;
2. pending nodes created under the transition's ambient context.

Computeds *and* effects can be members (an effect's pending-ness is its suspended
state, known to the scheduler). The only genuine residual edge — a node neither
invalidated-by nor created-under the transition — is simply "not a member", so
there is nothing to fix.

Superseding reuses the checkpoint-resume stale-run guard. There is no "what
blocks what" entanglement: two concurrent transitions are independent values;
sequencing is `await t1.settled` written by the author.

---

## 11. Roadmap

- **v1** — the core (pipelines/stages, `read`, checkpoint resume), the unified
  scheduler, the pending model, effects, and the DOM layer (components, control
  flow, per-node bindings). No `<Loading>`, no transitions.
- **v2** — re-introduce a Loading/`<Suspense>` boundary as an opt-in *coarser*
  catch site for `NotReadyYet` (coordination), additive to the per-node path.
  Two-phase `For` re-keying.
- **later** — transitions, optimistic store.

---

## 12. Deferred / out of scope

- Coordinated reveals (v2 `<Suspense>` / transitions — a *policy* built on top,
  not a core primitive).
- Optimistic stores, draft-first store setters, `reconcile`.
- SSR / hydration, router.
- `on`-style explicit dependency declaration — considered, dropped as not
  relevant to pulse.

---

## 13. References

- r3 — `../../../../r3` (hybrid push-based reactivity, height ordering).
- Solid 2.0 RFCs — `../../../../solid/documentation/solid-2.0/`.
- `async-signals-proposal.md` (`../../../../solid/`) — the generator-derivation
  proposal that seeded this exploration; treated as one input, not the spec.
- Anthony Fu, "The Async Sync in Between" — quansync, the "purple function"
  pattern pulse's generator stages mirror.

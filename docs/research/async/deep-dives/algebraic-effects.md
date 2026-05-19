# Algebraic effects + handlers

**Type:** concept
**Taxonomy row(s) affected:** none directly (concept dives don't promote rows), but multiple axes get sharpened
**Status after this dive:** N/A (concept dives don't carry row-statuses; the dive itself is the artifact)
**Date:** 2026-05-19
**Session:** 3
**Scope note:** This is a concept dive. It formalizes the perform/handle/resume framework that we've been informally invoking. Per the previous session's open questions, this dive is grounded by asking "what does each formal construct map to in effect-ts and in pulse?" — so the theory doesn't float free of the concrete artifacts. Out of scope: the full meta-theory of denotational semantics; row-polymorphism deep math; ergonomic comparisons of effect-typed languages.

---

## Sources

Primary:

1. **[Bauer & Pretnar — "Programming with Algebraic Effects and Handlers" (arxiv:1203.1539)](https://arxiv.org/abs/1203.1539)** — formal definition of effects, handlers, continuations, type system, denotational semantics. The canonical reference. PDF retrieved via [ar5iv HTML version](https://ar5iv.labs.arxiv.org/html/1203.1539) when the raw PDF couldn't be parsed locally.
2. **[OCaml 5 effects manual](https://ocaml.org/manual/5.4/effects.html)** — production implementation of effect handlers in a mainstream language. Concrete syntax for declaring, performing, and handling effects; explicit documentation of one-shot semantics.
3. **[Koka language documentation](https://koka-lang.github.io/koka/doc/book.html)** — row-polymorphic effect typing in production. Effect syntax with the `with handler <e> { ... }` pattern.

Secondary:

4. **[Dan Abramov — "Algebraic Effects for the Rest of Us"](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)** — accessible JS-flavored intro; useful for explanation framing, less so for formal definitions. Cited in our `CONTEXT.md` already.
5. **[Daan Leijen — "Koka: Programming with Row-polymorphic Effect Types" (arxiv:1406.2061)](https://arxiv.org/pdf/1406.2061)** — referenced from the Koka docs; row polymorphism formalism (consulted indirectly through tertiary summaries; quoted claims about row polymorphism should be checked here before becoming load-bearing).
6. **[Tim Cuthbertson — "I'm excited about Koka"](https://gfxmonk.net/2025/04/13/im-excited-about-koka.html)** — used for concrete Koka syntax examples (`<console|e>` row notation, `with handler <exn>` pattern).
7. **[Algebraic handler lookup in Koka, Eff, OCaml, and Unison — interjectedfuture.com](https://interjectedfuture.com/algebraic-handler-lookup-in-koka-eff-ocaml-and-unison/)** — comparative survey; cited for cross-language differences.

---

## What it is

Algebraic effects and handlers are a programming model — and a formal theory — for **describing computational effects (state, exceptions, async, IO, nondeterminism, generators, dependency injection, ...) as a single uniform mechanism**, separating *what an effect does* (its operations) from *how it's interpreted* (its handlers).

In our research vocabulary:

- **Effects** are *typed operations* a computation may perform. An effect has a signature like `op : A → B` — "this operation takes an A and resumes the computation with a B." The effect itself is just a name + signature; it has no implementation.
- **Performing an effect** is invoking one of the operations. The computation pauses at the perform site; control transfers to the nearest enclosing handler.
- **Handlers** interpret effects. A handler is bound to a region of code (`with h handle c`) and intercepts operations performed inside that region. When the handler runs, it receives both the operation's parameter AND a **continuation** representing "the rest of the suspended computation after the perform."
- The handler can **call the continuation** zero times (abort), once (return), or **many times** (nondeterminism / backtracking / generators).

This last point is the load-bearing one: handlers can invoke the continuation **multiple times**. That's what makes algebraic effects strictly more expressive than try/catch (exceptions can't be resumed at all) or async/await (each yield resumes exactly once).

Per Bauer & Pretnar's abstract: *"Eff is a programming language based on the algebraic approach to computational effects, in which effects are viewed as algebraic operations and effect handlers as homomorphisms from free algebras."* The "algebraic" framing comes from the mathematical structure: effects are algebraic operations on a free monad-like structure; handlers are homomorphisms that "interpret" the free structure into a concrete one.

We don't need the category theory to use the framework. We need three things: the operational semantics (what perform/handle/resume do at runtime), the typing discipline (what languages track in the type system), and the implementation strategies (how this is encoded in languages that don't have it natively).

---

## The formal model

### Effects as typed operations

Per Bauer & Pretnar §1.1 ([source](https://ar5iv.labs.arxiv.org/html/1203.1539)):

```
E ::= effect (operation op_i : A_i → B_i)_i end
```

An effect type `E` is a collection of named operations, each with a parameter type `A_i` and a "return type" `B_i`. The `op : A → B ∈ E` notation says "operation `op` is in effect E with parameter A and result B."

In OCaml 5 syntax:

```ocaml
type _ Effect.t += Xchg : int -> int Effect.t
```

This declares an operation `Xchg` taking an `int` and resuming with an `int`. The effect type itself (`Effect.t`) is extensible — every new operation extends a global GADT.

In Koka, effects are declared as labeled rows in the type system: a function's type signature lists which effects it may perform.

### Performing an effect

Per Bauer & Pretnar §2.1:

```
e # op         -- the operation itself, as a value
e # op e'      -- the operation applied to a parameter; performs the effect
```

In OCaml 5:

```ocaml
perform (Xchg 0)
```

In Koka, performing is just function-call syntax (effects look like ordinary functions; the type system tracks them as effects).

Semantically, performing an operation **pauses the current computation** and transfers control to the nearest enclosing handler. The computation past the perform site becomes the **continuation** — a function from the operation's result type to the rest of the computation's result type.

### Handlers and the continuation

Per Bauer & Pretnar §2.2:

```
with h handle c
```

The handler `h` has three kinds of clauses:

- **Operation clauses** `e_i # op_i x k ↦ c_i` — for each operation the handler interprets, `x` is bound to the parameter and `k` is bound to the continuation.
- **Value clause** `val x ↦ c_v` — runs when the handled computation returns a value (no operations remain).
- **Finally clause** `finally x ↦ c_f` — post-processing.

**The continuation `k` is a function**, not a one-shot escape. Per the paper's type rule for handlers:

```
Γ, x:A_i, k:B_i→B ⊢_c c_i : B
```

The continuation's type is `B_i → B`: take a `B_i` (the operation's result type), produce a `B` (the rest of the computation's result). The handler clause can call `k(v)` with any value of the right type; it can call `k` multiple times; it can not call `k` at all.

This is the crucial structural fact that distinguishes algebraic effects from exceptions, async/await, and generators:

| Mechanism | How many times can the "rest of the computation" be invoked? |
|---|---|
| Exceptions | 0 (no resumption) |
| async / await | 1 (each await resumes once) |
| Generators (one-shot) | 1 (each yield resumes once) |
| Generators (multi-shot, rare) | many (some languages support this) |
| Algebraic effects (full) | **0, 1, or many** (handler's choice) |

The "many" case unlocks **nondeterminism, backtracking, breadth-first search, time-travel debugging, parser combinators, and cooperative multithreading** — examples Bauer & Pretnar cite explicitly.

### Operational semantics

Per Bauer & Pretnar §4 (denotational, but the operational story matches):

Three cases of what `with h handle c` does:

1. **Value return:** if `c` evaluates to `val v`, the handler's value clause `val x ↦ c_v` runs with `x` bound to `v`.
2. **Operation intercept:** if evaluation of `c` reaches `e_i # op_i v`, the handler's matching operation clause runs with `x` bound to `v` and `k` bound to the continuation. The continuation is itself handled by `h` (so re-perform within the handler chains correctly).
3. **Unhandled operation:** if `c` performs an operation the handler doesn't interpret, it propagates outward — wrapped with an updated continuation that re-applies the current handler when the outer handler resumes. Per the paper:

   ```
   h(ι_oper(n, op, v, κ)) = ι_res(ι_oper(n, op, v, h ∘ ρ_res ∘ κ))   (unhandled)
   ```

The composition `h ∘ κ` is what lets handlers stack: when the outer handler eventually calls the (still-wrapped) inner continuation, the inner handler is re-applied around the rest of the computation. **This is what makes handlers properly nest.**

### Deep vs shallow handlers

Two variants of handler semantics exist:

- **Deep handlers** — when the continuation `k` is invoked, the handler is re-applied around the rest of the computation. Subsequent operations from the same handled region keep being handled by the same handler. This is the variant Bauer & Pretnar's formal model uses (the `h ∘ κ` composition above).
- **Shallow handlers** — when `k` is invoked, the handler is NOT re-applied. Subsequent operations need a fresh handler. Used in some implementations for performance or expressiveness; OCaml 5 supports both via `continue` (deep) vs effectively shallow patterns.

The Koka and Eff languages use deep handlers by default. The distinction matters for nondeterminism: with deep handlers, the same handler interprets all branches of a `k(v1)` / `k(v2)` exploration.

---

## What effects subsume

The grand unification: most things imperative languages treat as built-in are effects with specific handlers. This isn't speculation — it's literally how the foundational papers present them.

| Pattern | Effect signature | Handler shape |
|---|---|---|
| **Exception** | `Throw : ErrorType → Never` (no result; resume is never called) | Never call `k`; return an error value instead. |
| **State (Get/Set)** | `Get : Unit → State`, `Set : State → Unit` | Pass current state through; on Get, call `k(state)`; on Set, call `k(())` with updated state. |
| **Dependency injection / Reader** | `Ask : Unit → Config` | Call `k(config)` where `config` comes from the handler's closure. |
| **Async / await** | `Await : Promise[T] → T` | Park the continuation; on settle, call `k(v)`. |
| **Generators (yield)** | `Yield : T → Unit` | Capture `k` as "what to do next"; expose to the consumer; consumer calls `k(())` when ready. |
| **Nondeterminism (choose)** | `Choose : List[T] → T` | Call `k(v)` for each `v` in the list; collect results. |
| **Backtracking / Logic** | `Fail : Unit → Never` (don't call k) + `Choose` (call k multiple times) | Fail never resumes; Choose resumes on each branch. |
| **Cooperative threading** | `Yield : Unit → Unit`, `Fork : Effect[Unit] → Unit` | Yield captures `k`, enqueues it. Fork enqueues a new thread. Handler is the scheduler. |

Each of these IS an algebraic effect with a specific handler. A language with effects-and-handlers as a primitive has **all of these as library code**, not built-in features.

That's the headline claim. Whether you buy that "one primitive gives you all these" is *worth it* depends on the language's ergonomics for the common case, but the formal unification is real.

---

## Type-and-effect systems

A type system that tracks effects extends function types with the effects the function might perform. Two main approaches:

### Eff (untyped effects)

Per Bauer & Pretnar §3, Eff itself **does not track effects in the type system**. A computation has type `A`; the effects it may perform are implicit. The paper notes this explicitly as a design choice: Eff prioritized clean theory over compile-time effect safety.

OCaml 5 is in the same camp — effects are not tracked in the type system; unhandled effects raise `Effect.Unhandled` at runtime.

### Koka (row-polymorphic effects)

Koka tracks effects via row polymorphism. A function's type lists the effects it may perform:

```koka
fun foo(): io ()                          // returns unit, requires io effect
fun bar(state: ref<global>): <exn,st<global>> ()   // requires exception + state
```

The row notation `<console|e>` means "console PLUS whatever else is in `e`" — composable. A function that uses `e` can be called from a context that handles a superset of `e`. This is *static effect safety*: if a function requires an effect, the type system requires a handler to be in scope.

### effect-ts (typed effects via parameters)

effect-ts encodes a Koka-like discipline using TypeScript's type parameters: `Effect<A, E, R>` where `E` is the error channel and `R` is the typed dependencies (capabilities). The closest TypeScript can come to row polymorphism is set-union types in the `R` parameter, where the type system tracks which capabilities a computation requires. Per our [effect-ts deep-dive](./effect-ts.md): "the `R` parameter forces every dependency to be typed; implicit ambient dependency is not possible."

This is the *static effect safety* benefit ported to TypeScript without language-level effect rows.

---

## Implementation strategies

How is "perform an operation; the handler receives a continuation that can be called multiple times" actually implemented? Three families:

### 1. Delimited continuations (the "native" way)

A language with first-class delimited continuations (`shift`/`reset` in Scheme; `call/cc` with a delimiter) can implement effect handlers directly. The handler is the `reset`; the perform is the `shift`. The continuation captured by `shift` is precisely the multi-shot function the formal model requires.

OCaml 5 implements this via **fibers**: stack-allocated computation frames that can be suspended and resumed. Capturing a continuation doesn't copy stack frames — only heap-references to the fiber. Multiple resumption isn't natively supported in OCaml 5 (it's one-shot for safety); you get `Continuation_already_resumed` if you try.

### 2. CPS transformation (Koka's approach)

Continuation-Passing-Style transformation rewrites the program so every function takes an extra "what to do next" argument. After CPS, every continuation is an explicit value. The handler becomes a function from operation + continuation to result.

Koka's compiler does this. The runtime cost is bounded; modern compilers handle CPS efficiently. The benefit: no language-level continuation support needed; CPS is just code.

The cost: every effectful call goes through extra plumbing. For pure code, the compiler can avoid the CPS overhead.

### 3. Free monads + interpreters (Haskell's approach)

A free monad over an effect signature is a data structure representing "the program as a value" — a tree of operations. An *interpreter* walks the tree and decides what each operation means. Multi-shot resumption corresponds to interpreting one operation node multiple times.

Performance is the historical concern (allocating a tree per program is heavy), but modern optimizing implementations (Polysemy, fused-effects, eff in Haskell) compete with hand-written code.

### 4. Generator-based encoding (effect-ts's approach)

JS generators are one-shot delimited continuations. Each `yield*` is a perform; the runtime that drives the generator is the handler. The generator can yield typed effect values; the runtime interprets them and resumes via `gen.next(value)`.

This is what effect-ts does. The limitation is one-shot resumption: you can't call the continuation multiple times from inside a generator. **Multi-shot effects (nondeterminism, backtracking) aren't expressible via this encoding** without further machinery.

For pulse: same encoding. Generator computeds (`computed(function* () { yield* read(x) })`) ARE single-stage algebraic effect handlers. Multi-shot at the stage boundary is achieved by decomposition into separate r3 computeds — see [the CONTEXT.md Pipeline definition](../../../CONTEXT.md).

---

## Concrete encodings — what each formal construct looks like in each system

### In Eff (the original)

```
effect Choose : unit -> int end

with handler {
  e # Choose () k -> k(0) + k(1)        // call continuation twice
  val x -> x
} handle (e # Choose ())
// returns 0+1=1, by invoking the continuation once for each branch
```

### In Koka

```koka
effect choose {
  fun choose-int(): int
}

fun with-both(action: () -> <choose|e> int): <e> int
  with handler {
    fun choose-int() resume(0) + resume(1)
    return(x) x
  }
  action()
```

`resume` is Koka's name for the continuation. Calling `resume(0) + resume(1)` invokes it twice and sums the results.

### In OCaml 5

```ocaml
type _ Effect.t += Choose : int Effect.t

let handler comp =
  match comp () with
  | x -> x
  | effect Choose, k -> continue k 0 + continue k 1
  (* WAIT — this won't actually work in OCaml 5 because continuations are one-shot.
     The above would raise Continuation_already_resumed on the second continue.
     OCaml 5 deliberately forbids multi-shot.
     Multi-shot in OCaml 5 requires manually cloning the continuation, which is
     not provided in the standard library. *)
```

OCaml 5's design choice: enforce one-shot for resource-safety reasons. The full algebraic effects spec is intentionally restricted. Multi-shot effects need explicit copying machinery.

### In effect-ts

```typescript
import { Effect } from "effect"

// "Effects as values" — Effect<A, E, R> is the value type.
// Perform is yielding an Effect inside Effect.gen:
const choose = Effect.sync(() => Math.random() < 0.5 ? 0 : 1)

const program = Effect.gen(function* () {
  const x = yield* choose
  return x
})

// Multi-shot is NOT a feature. effect-ts is one-shot at the generator level.
// To get something like "try both branches and combine", you'd use Effect.all
// or Effect.race, which run multiple effects concurrently — different mechanism.
```

effect-ts is closer to "encoded one-shot algebraic effects with typed channels." Per our [effect-ts dive](./effect-ts.md): the `E` parameter is the error channel; the `R` parameter is the capability requirement. Together they approximate Koka's row-polymorphic effect rows.

### In React Suspense

```tsx
function User({ id }: { id: string }) {
  const user = use(fetchUserPromise(id))   // performs "Suspend(promise)"
  return <div>{user.name}</div>
}

<Suspense fallback={<Spinner />}>          // handler for the Suspend effect
  <User id="..." />
</Suspense>
```

React Suspense is an encoded effect handler. `use(promise)` performs a Suspend effect (throws the promise); the nearest `<Suspense>` boundary catches and waits. The "resume" is implemented by **re-rendering the component from the top** when the promise settles — re-execution, not true continuation resumption. This is the limitation Abramov names explicitly in his post.

### In pulse

Three encoded effects, with the table from our [CONTEXT.md Conceptual model section](../../../CONTEXT.md#conceptual-model):

| Effect | Performer | Handler |
|---|---|---|
| Suspension | `use(x)` throws `NotReadyYet(promise)` | binding-effect's try/catch + kick-on-promise-settle |
| Boundary coordination | `use(x)` engagement flag | `<Loading>` scope's gather + atomic-flush state machine |
| Error | non-`NotReadyYet` throw | `catchError(fn, handler)` walking the owner tree |
| Owner lookup | `getOwner()` reads ambient owner slot | `runWithOwner(owner, fn)` sets the slot |
| Loading scope lookup | `useLoading()` walks owner tree for nearest `loadingScope` | `<Loading>`'s setup attaches a scope to its boundary owner |

The same perform/handle/resume shape; encoded via try/catch (the "perform" is a throw; the "handle" is a catch) + ambient mutable slots (the "current handler" lookup is a module-level variable read) + kick-on-settle (the "resume" is a re-execution, not a true continuation invocation).

Pulse is in the **re-execution camp** like React Suspense. Multi-shot is not available except at pipeline-stage boundaries (where multi-shot at the boundary is achieved by decomposition — see CONTEXT's framing).

---

## What JS encodings sacrifice

The framing from our research's central constraint: *every encoding into JS loses something the formal model had.* For algebraic effects specifically:

| Formal capability | Available in JS encoding? |
|---|---|
| Operations as typed names | Yes — class names, symbols, Effect.t variants, etc. |
| Handler as a value-binding scope | Yes — try/catch is the substrate; effect-ts uses runtime + Effect.gen Adapter |
| Continuation as a function | Partial — generators give one-shot continuations; multi-shot requires manual machinery |
| Multi-shot resumption | **No** — JS generators are one-shot; cloning isn't available natively. Multi-shot is achievable only at coarser granularity (pulse's stage boundaries; effect-ts's `Effect.retry` from-the-top) or via heavyweight CPS transformation |
| Effect-tracked types | Partial — `Effect<A, E, R>` and similar; TS lacks true row polymorphism so the encoding is less expressive than Koka's |
| Deep handler stacking | Yes — the runtime can re-apply itself around resumed continuations (effect-ts does this; pulse does this via owner-tree handler stack) |
| Composable effect rows | Partial — TypeScript's type system can encode some row-polymorphism via union types and conditional types, but it's less ergonomic than Koka's native rows |

The single biggest loss is **multi-shot resumption**. That's what blocks JS from natively expressing nondeterminism, backtracking, generators-as-effects, and true cooperative multithreading. Workarounds exist (CPS transformation; trampolining; explicit continuation cloning) but they're heavyweight enough that no JS-world system has adopted them.

For pulse: this means a true algebraic-effects-style nondeterminism primitive isn't on the table. Anything that needs "explore multiple branches and combine" has to either decompose to stage boundaries (pulse's approach) or accept that the continuation is unique per perform.

---

## How this informs the taxonomy axes

This dive sharpens several axes from the README:

### "Async representation" axis

The values we currently list (value / procedure / type / continuation / channel / mailbox) become more interpretable:

- **continuation** in the strong sense (multi-shot, first-class) is what Koka and Eff offer; OCaml 5 has one-shot continuations. JS encodings can't deliver this.
- **value** (effect-ts, Cap'n Proto promise) is the encoded form where the effect is a description; the runtime interprets.
- **procedure** (async functions, useEffect) is the limited form: no first-class effect; the language built-in handles it.

The axis values are best understood as **points on a spectrum of how first-class the "captured effectful work" is**: from procedure (not first-class) to value (first-class but interpreted) to continuation (first-class with multi-shot capability).

### "Discipline location" axis — confirming the sub-axes question from session 2

The effect-ts dive raised: "is 'type-system-enforced' a single discipline?" The algebraic-effects framework says no:

- **Structural-effect-typing** — the type system tracks WHICH effects a function may perform (Koka's rows; effect-ts's `R` parameter).
- **Vocabulary restriction** — handler combinators don't expose escape hatches (STM in effect-ts doesn't expose IO).
- **Type-level continuation safety** — linear/affine types ensure the continuation is invoked the right number of times (a research area; Idris, Granule).

Three different mechanisms, all called "type-system-enforced" in our current table. **Recommendation:** split the axis next time we have to record a system that uses one without the others.

### "Atomicity granularity" axis — confirming the split question

The effect-ts dive raised: data-atomicity (STM commit) vs lifecycle-atomicity (scope close). Algebraic effects don't directly answer this — but they frame it: a handler's lifetime IS its atomicity boundary for whatever effects it interprets. Different handlers can have different lifetimes; nesting handlers within other handlers gives nested atomicity boundaries.

This sharpens the question: **atomicity granularity is best understood per-handler, not per-system**. Systems with multiple handler kinds (effect-ts: Scope handlers + STM handlers) have multiple atomicity granularities by design.

### New axis candidate: "continuation cardinality"

Suggested by the dive. Values:

- **0-shot** — exceptions, abort-style effects
- **1-shot** — async/await, generators, effect-ts, pulse (within-stage)
- **multi-shot at coarse granularity** — pulse (across stage boundaries); incremental computation graphs
- **multi-shot fine-grained** — Eff, Koka with explicit support; Haskell `MonadCont`
- **runtime-enforced 1-shot** — OCaml 5 (the language forbids multi-shot)

This is a structurally important distinction the current axes flatten. **Recommendation:** add this axis after one or two more dives confirm it actually distinguishes systems beyond what we already track.

---

## Open questions raised

- **Where on the spectrum is "useful" for UI work?** Algebraic effects' multi-shot resumption is most demonstrably valuable for backtracking, nondeterminism, and cooperative threading. UI frameworks rarely need any of those. So the "extra power" of true algebraic effects may be over-engineered for pulse's actual use cases. Worth checking: are there UI scenarios where multi-shot would meaningfully help? Speculative debugging? Preview / what-if mode (scenario S8)? Time-travel state restoration?
- **Can pulse get more from algebraic-effects-shaped APIs without the runtime cost?** effect-ts is the model. The cost is high (everything is `Effect.gen`-wrapped; no `async/await`). Is there a cheaper encoding that captures the *typing* benefits without the *runtime* indirection? TS's structural typing might let us do something effect-ts can't — type-only effect tracking via phantom parameters, where the runtime is unchanged.
- **What's the right framing for pulse's three encoded effects in the README's conceptual model section?** The current language is "performer / handler / handler stack." The algebraic-effects framing suggests we could be more precise: each of pulse's primitives is encoding a specific *kind* of handler (one-shot, scope-bound, owner-tree-walked, etc.). Worth a CONTEXT.md sharpening pass after one or two more dives.
- **How do effect-ts and pulse compare on "handler lookup"?** effect-ts uses a runtime context to find the active handler; pulse uses ambient-owner-tree walks. Both work; the trade-offs differ in places we haven't enumerated. Worth a dedicated dive comparing handler lookup mechanisms across systems (the `interjectedfuture.com` article cited as source 7 covers Koka / Eff / OCaml / Unison comparatively).

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`effect-ts.md`](./effect-ts.md) (just done) — THE canonical JS encoding. Every formal construct in this dive maps to an effect-ts artifact we've documented.
  - `haskell-stm.md` (TODO) — STM in Haskell is itself a particular handler stack: a handler for a transactional-memory effect, implemented over the IO monad. The Haskell STM dive should cite this dive for the "STM as effect handler" framing.
  - `cml.md` (TODO) — Concurrent ML's first-class events are an alternative to algebraic effects: events as composable values, but without the "interpret as you go" flexibility of handlers. Worth direct comparison.
  - `react-modern.md` (TODO) — React's Suspense and `use()` ARE encoded algebraic effects. The "re-execution rather than true resumption" limit applies; the React dive should make the encoding explicit.
  - `solid-2-lanes.md` (TODO) — Solid 2.x's lanes implement an effect-handler stack at the runtime level (transitions as handlers; lanes as the dispatch mechanism). Worth tracing the connection.
- **Taxonomy axes this dive informed:**
  - **Async representation** — clarified the spectrum from procedure → value → continuation; recommend keeping the current value list but documenting the spectrum interpretation.
  - **Discipline location** — confirmed the session-2 hypothesis that it needs sub-axes (structural-effect-typing / vocabulary restriction / type-level continuation safety).
  - **Atomicity granularity** — confirmed it's best understood per-handler, not per-system; multi-handler systems have multiple atomicity boundaries.
  - **NEW axis candidate: continuation cardinality** (0-shot / 1-shot / multi-shot at coarse granularity / multi-shot fine / runtime-enforced 1-shot). Don't add yet; wait for one or two more dives to confirm it distinguishes systems meaningfully.
- **Scenarios this dive addressed:** None directly (concept dives don't map to scenarios). But the dive informs scenarios S5 (cross-tx read), S6 (cancellable flow), and S8 (preview/what-if) by clarifying what's possible with multi-shot continuations and what's blocked by JS's one-shot constraint.
- **Concept dives this builds on / motivates:**
  - Motivates a future dive on **delimited continuations** (Felleisen, Filinski) as the substrate algebraic effects sit on.
  - Motivates a future dive on **linear types / capability typing** (Pony, Idris, Granule) — the type-level continuation safety subfield.
  - Motivates **CPS transformation** as an implementation technique — what Koka's compiler does, what could be done in JS.

---

## Notes / aside

- The Bauer & Pretnar paper is older than I thought (2012, before OCaml 5's effect handlers landed in 2022). Reading it after the OCaml 5 release makes some choices in the original paper feel idiosyncratic — e.g. Eff's "resource" concept for stateful default handlers feels like a precursor to what modern systems handle via mutable handler closures.
- ar5iv (HTML rendering of arxiv papers) was essential for getting the paper's content. The raw PDF couldn't be parsed without poppler installed locally; ar5iv worked first try. Future dives on arxiv-hosted papers should default to the ar5iv URL.
- Dan Abramov's blog post is still the best one-page accessible intro for someone arriving from React; not a substitute for the formal paper but a good gateway.
- The Koka book's URL returned a sparse summary when fetched directly; the third-party blog (Cuthbertson 2025) and the arxiv paper on Koka's row polymorphism (Leijen) are better primary sources for the syntax.
- This dive deliberately did NOT go deep on row polymorphism math, denotational semantics, or Eff's "resource" concept — these would be follow-up concept dives if pulse's design direction ever requires the formalism.

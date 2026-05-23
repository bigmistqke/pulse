# effect-ts

**Type:** primary
**Taxonomy row(s) affected:** "effect-ts" (currently 🟡)
**Status after this dive:** 🟢 verified (for the four axes covered)
**Date:** 2026-05-19
**Session:** 2 (first deep-dive)
**Scope note:** This dive is scoped to four axes per session 1's plan — STM conflict policy, type-system discipline, typed-value representation, structural cancellation. The broader effect-ts surface (Layer / DI, Stream, Schedule, Hub / Queue / Channel, Logger / Tracer) is deliberately out of scope here; if a later session needs it, a follow-up dive is in order.

---

## Sources

1. **[The Effect Type](https://effect.website/docs/getting-started/the-effect-type)** — official docs on `Effect<A, E, R>`: parameter order, laziness, characterization as "description of a workflow."
2. **[Fibers](https://effect.website/docs/concurrency/fibers)** — official docs on Fibers, `Effect.fork`, interruption, `Fiber.interrupt`, `Fiber.interruptFork`, interruption being asynchronous and disabled during critical regions.
3. **[Scope](https://effect.website/docs/resource-management/scope)** — official docs on `Scope`, finalizers running in reverse order, finalizer execution guarantee during interruption, `Effect.scoped`, `Effect.addFinalizer`.
4. **[STM module API](https://effect-ts.github.io/effect/effect/STM.ts.html)** — API reference for the STM module: `STM<A, E, R>` extending `Effect.Effect<A, E, R>`, `commit`, `retry`, `check`, `gen`, basic constructors.

Secondary (used for synthesis but flagged where claims rely on them):

- **[Intro to Effect Part 5: Software Transactional Memory in Effect](https://ybogomolov.me/05-effect-stm)** — blog post on effect-ts STM by Yuriy Bogomolov. Used for context on STM-vs-Effect distinction in user code; flagged as `[secondary]` where cited.
- **[ZIO STM reference](https://zio.dev/reference/stm/stm.md/)** — ZIO is the JVM cousin effect-ts ports from; useful for confirming retry semantics are the same family. Cited where claims about retry mechanism specifics rely on it.

---

## What it is

effect-ts is a TypeScript library that encodes algebraic effects + handlers + structured concurrency + STM into a typed value type. Its primary primitive is `Effect<A, E, R>` — a **lazy, typed description** of a computation that the runtime will interpret into actual execution. Computations are written as compositions of Effect values (via combinators or generator syntax); execution happens only when the runtime is invoked.

In our research vocabulary:

- **Async representation:** value (effects are first-class values; `Effect.t` is what you compose and pass around).
- **Discipline location:** type-system-enforced (the `E` and `R` parameters force every error and every dependency to be typed; "untyped throw" and "implicit ambient dependency" are not possible inside an Effect).
- **Reactive integration:** orthogonal (effect-ts has no built-in concept of UI reactivity; it's a programming model for async, errors, dependencies, and concurrency).
- **Async state lives:** in two layers — `Effect<A, E, R>` for general async work; `TRef<A>` for transactional state inside STM blocks. Both live "outside" any reactive graph; effect-ts assumes its world doesn't contain one.

The system's own terminology: effect-ts calls `Effect<A, E, R>` an "effect type" or "workflow." We treat it as the canonical example of "async-as-typed-value."

---

## The async-coordination model

### Conflict handling (STM retry-on-conflict)

STM is effect-ts's answer to coordinated concurrent state changes. The mechanism, per the API docs and the type hierarchy:

- `TRef<A>` is "a mutable transactional reference to a shared memory location" ([STM API ref](https://effect-ts.github.io/effect/effect/STM.ts.html)).
- An `STM<A, E, R>` is "an effect that can be performed transactionally" — and crucially extends `Effect<A, E, R>`. The conversion is `STM.commit(stm)` which produces `Effect<A, E, R>` ([STM API ref](https://effect-ts.github.io/effect/effect/STM.ts.html)).
- The `retry: STM<never, never, never>` primitive "aborts and retries when transactional variables change." This is voluntary retry: the transaction asks the runtime to discard work and rerun when any `TRef` it has read changes.
- The `check(predicate)` helper retries automatically if the predicate is false — a sugar over manual retry.
- Conflict resolution is **automatic retry-on-conflict**: per the STM API ref's description, the runtime tracks reads and writes within a transaction; if a `TRef` read inside the transaction has been written by another committed transaction between the current transaction's start and its commit attempt, the current transaction is rolled back and re-executed from the start. (This claim about implementation matches both [ZIO STM](https://zio.dev/reference/stm/stm.md/) and Haskell GHC STM; effect-ts ports from ZIO, so the behavior is the same family. `[verified against ZIO docs as the upstream]`.)

So effect-ts STM gives us **Q4 option (e) retry-on-conflict** (per `concurrent-flows.md`).

Constraints on what can go inside an STM block — synthesized from the type system and the retry semantics:

- The `STM<A, E, R>` type does NOT extend `Effect` in the way that allows arbitrary IO; the STM API exposes only STM-shaped operations (`succeed`, `sync`, `flatMap`, `gen`, etc.) that don't permit raw `Effect.tryPromise` or other IO escape hatches.
- This is the **purity precondition** STM requires for safe retry: the block must be replayable. Pulling in arbitrary IO would mean retried server calls or duplicated side effects.
- IO that needs to happen alongside transactional state changes goes in the surrounding `Effect` — typically the pattern is `Effect.gen(function* () { yield* doIOFirst; yield* STM.commit(stmBlock); yield* doIOAfter })`.

### Cancellation (structural via Scope + interruption)

Interruption is asynchronous and structural, per [the Fibers docs](https://effect.website/docs/concurrency/fibers):

> "One fiber can interrupt another without the target fiber polling a global flag" — interruption arrives at the target fiber asynchronously, not by polling.

> "Interruption is disabled in critical regions to maintain data consistency" — `Effect.uninterruptible` blocks (and STM transactions, which are critical regions by definition) cannot be interrupted mid-flight.

> "Effect guarantees that interruption won't leave shared state inconsistent by disabling interruption during critical sections" — the runtime is responsible for not interrupting mid-mutation.

`Fiber.interrupt(fiber)` returns an Effect that "resumes when the fiber exits." Interruption waits for the target to actually exit; `Fiber.interruptFork` doesn't wait.

Scopes provide the structural side, per [the Scope docs](https://effect.website/docs/resource-management/scope):

> "Finalizers are cleanup functions that run when a scope closes ... execute in reverse order of addition — mirroring stack unwinding."

> "Finalizers guarantee execution even during interruption. Whether an effect completes successfully, fails, or gets interrupted, all registered finalizers run when the scope closes."

`Effect.scoped` wraps an effect with a fresh scope; `Effect.addFinalizer` registers a finalizer in the current scope; `Effect.acquireRelease` (acquire/use/release pattern) couples a resource lifecycle to a scope.

Together: **cancellation in effect-ts is structural-by-scope plus asynchronous interruption, with the guarantee that finalizers always run.** Post-cancellation operations are no-ops by construction — the interrupted fiber's continuation is discarded.

This is the cleanest answer to **S6 (user-cancellable flow)** we've seen in any system in the taxonomy.

### Suspension / resumption

Effects suspend when they hit an async dependency (e.g. `Effect.tryPromise`); the runtime keeps the fiber alive but parked until the promise settles, then resumes.

The mechanism: effects are described as lazy values; the runtime is an interpreter. When an Effect requires waiting (a Promise, a `Fiber.await`, an STM `retry`), the interpreter parks the fiber and registers a continuation. When the dependency resolves, the interpreter resumes the fiber with the value.

**This is re-execution at the STM level (retry), but true resumption at the Effect level** for non-STM async waits. STM blocks must be replayable; general Effect blocks don't have this constraint — a `yield*` checkpoint genuinely resumes from where it paused (because the runtime owns the continuation, not JS itself).

JS-substrate caveat: `Effect.gen` is generator-based, which means JS-level resumption is single-shot. But the *Effect runtime* preserves the necessary state across yields (the generator's internal frame is held by the runtime; the resume calls `gen.next(value)` to inject the resolved value). This is the standard "JS generator = encoding of single-shot continuation" pattern, dressed in effect-ts's type machinery. Multi-shot resumption is only possible at the *Effect* level via combinators like `Effect.retry` (which re-runs the whole effect from the top, not resumes from a specific yield).

### Composition

Effects compose via:

- **Combinators:** `Effect.flatMap`, `Effect.all` (parallel), `Effect.bind`, `Effect.zip`, `Effect.race`, etc.
- **Generator syntax** (`Effect.gen`): write sequential async as `yield*` of Effect values; the runtime drives the generator.
- **Pipe syntax:** `effect |> Effect.flatMap(...) |> Effect.tap(...)` for left-to-right composition.

Composition is *at the value level*: you build up Effect values; nothing runs until the runtime executes one. This is what "effect as value" means.

STM has the same combinators in its own namespace: `STM.flatMap`, `STM.all`, `STM.gen`, etc. STM combinators stay within STM (the type doesn't escape to Effect); to leave STM, you `STM.commit` and you're back in Effect-land.

### Error handling

Errors are typed via the `E` parameter of `Effect<A, E, R>`. Operations like `Effect.tryPromise` capture rejection as a typed error in `E`. Error handlers (`Effect.catchAll`, `Effect.catchTag`, `Effect.match`) narrow or recover from typed errors.

Untyped throws (i.e. JS exceptions not modeled as `E`) become "defects" — they propagate but are tracked separately from the typed error channel. The runtime has special handling for defects.

Inside STM, errors propagate per the STM combinators (`STM.catchAll`, etc.); a failed STM transaction `STM.fail(e)` is committable as `Effect<A, E, R>` with the error in the `E` channel.

### Lifecycle / structure

Every Effect execution creates at least one Fiber (the "main fiber"). `Effect.fork(effect)` creates a child fiber; the parent gets a `Fiber` value back immediately. Fiber lifetime is independent of the parent's by default (`Effect.forkDaemon` for "outlive parent"), but `Effect.forkScoped` ties the fiber's lifetime to the current scope — the scope's finalizers will interrupt the fiber on scope close.

This is the structural-concurrency story: forking within a scope means the scope OWNS the fiber; scope closure interrupts; finalizers cascade. The standard Trio / Kotlin / Swift structured-concurrency rules apply.

---

## Taxonomy cells

### Where async state lives
**Cell:** separate (Effect is its own world; TRef for transactional state inside STM)
**Evidence:** Effect is a lazy description interpreted by a runtime ([Effect type docs](https://effect.website/docs/getting-started/the-effect-type)); TRef is a "mutable transactional reference" exposed only via STM combinators ([STM API ref](https://effect-ts.github.io/effect/effect/STM.ts.html)). Neither lives in a reactive graph; both live in the effect-ts runtime's world.

### Conflict-handling policy
**Cell:** retry-on-conflict (STM); structured interruption for non-STM
**Evidence:** `STM.retry` is "aborts and retries when transactional variables change" ([STM API ref](https://effect-ts.github.io/effect/effect/STM.ts.html)). For non-STM concurrent Effects, there isn't a single conflict-resolution policy — Effect's `Effect.race`, `Effect.zip`, `Effect.all` each have specific semantics for concurrent completion / failure / interruption. The "conflict" axis is most directly answered by STM's retry; outside STM, concurrency is "fibers run concurrently and the programmer composes them explicitly."

### Cancellation discipline
**Cell:** structural-by-scope + asynchronous interruption; finalizers guaranteed to run
**Evidence:** "Interruption is fully asynchronous" and "Finalizers guarantee execution even during interruption" ([Fibers docs](https://effect.website/docs/concurrency/fibers); [Scope docs](https://effect.website/docs/resource-management/scope)). Cancellation is structural at the scope level; the runtime ensures post-interrupt operations don't fire because the interpreter discards the fiber's continuation.

### Async representation
**Cell:** typed value (`Effect<A, E, R>`); separate but parallel `STM<A, E, R>` for transactional work
**Evidence:** "The `Effect` type is a description of a workflow ... lazily executed" ([Effect type docs](https://effect.website/docs/getting-started/the-effect-type)). `STM<A, E, R>` extends `Effect<A, E, R>` per the [STM API ref](https://effect-ts.github.io/effect/effect/STM.ts.html). Both are first-class composable values.

### Isolation level
**Cell:** serializable (STM); n/a outside STM
**Evidence:** STM retry-on-conflict (the secondary [ZIO docs](https://zio.dev/reference/stm/stm.md/) state explicitly that transactions are "isolated from each other, and the updates of one transaction are invisible to others until they are committed" — full atomicity + isolation). For Effects outside STM, there is no isolation primitive — concurrent fibers see shared state changes as they happen.

### Atomicity granularity
**Cell:** per-`STM.commit` block (within STM); per-`Effect.gen` block at the syntactic level but not atomic across forks (within Effect)
**Evidence:** `STM.commit` "turns an STM effect into a regular effect ... benefiting from all the error handling and resource management capabilities" — the commit is the atomicity boundary ([STM API ref](https://effect-ts.github.io/effect/effect/STM.ts.html)). Outside STM, Effect.gen blocks are not atomic in any consistency-isolation sense; they're syntactic units of composition.

### Discipline location
**Cell:** type-system-enforced
**Evidence:** Effect's three parameters (`A` success, `E` error, `R` dependencies) force errors and dependencies to be typed; "untyped throw" and "implicit ambient dependency" cannot escape the type system. STM further enforces purity by exposing only STM-shaped operations in its combinator vocabulary (no `Effect.tryPromise`-style IO inside `STM`). The type system is the primary enforcement mechanism for both the Effect protocol and STM's purity precondition.

### Reactive integration
**Cell:** orthogonal (no built-in reactivity)
**Evidence:** effect-ts has no concept of a reactive computation graph. SubscriptionRef and Stream are stream-based primitives but they're not reactive in the signal/dep-graph sense; UI integration (with React or similar) is the user's responsibility and typically done via subscription bridges.

---

## Scenario mapping

| Scenario | Solved? | How |
|---|---|---|
| **S1 — Like/unlike race** | yes | STM `atomically` block does the read-modify-write on the like signal; concurrent transactions retry on conflict. Each click is one transaction; no manual prior-state capture required. |
| **S2 — Auto-save vs explicit save** | partial | STM doesn't directly handle "in-flight server work needs snapshot correspondence." You'd compose: `Effect.gen` reads the current draftBody (snapshot via Effect.sync), submits to server, on completion updates `savedAt`. The snapshot correspondence is via local Effect value capture, not STM. |
| **S3 — Multi-step server flow with partial failure** | yes | `Effect.gen` composes the steps; `Effect.acquireRelease` or `Scope.addFinalizer` for compensating actions. On any step's failure or interruption, finalizers run in reverse order. |
| **S4 — Concurrent independent flows** | yes (by default) | Effects don't entangle. Independent flows are independent fibers. Only STM blocks reading the same TRef can entangle. |
| **S5 — Cross-transaction read** | yes | This is STM's canonical case. Tx A reads a TRef that Tx B is mid-writing → A retries when B commits. |
| **S6 — User-cancellable flow** | yes | `Fiber.interrupt` + Scope finalizers. Asynchronous interruption + guaranteed finalizer execution + interpreter-discarded continuation. Probably the cleanest answer in any system in the taxonomy. |
| **S7 — Optimistic reconciliation** | partial | STM gives you the atomic-replace primitive (`TRef.set` inside a transaction). Pattern: optimistic write to TRef → server call → on completion, atomically replace optimistic with server response. But the "optimistic survives across refetch" UX requires explicit reasoning about which TRefs the optimistic touched. |
| **S8 — Preview / what-if mode** | partial (poor fit) | STM's atomic-commit model doesn't directly express "see what state would be if I committed, without committing." You can simulate with a separate TRef holding "preview state" and merge on apply — but the abort case requires manual cleanup, and there's no first-class "snapshot+restore" pattern. |

**Policy questions** (per `concurrent-flows.md` Q1–Q5):

- **Q1 (overlay read inside tx):** STM is "snapshot-iso" — within a tx, reads see committed values as-of tx start; the tx's own writes are visible to its own subsequent reads.
- **Q2 (outside-tx read):** committed truth only. No "latest active overlay" semantic.
- **Q3 (commit ordering):** STM serializes commits via the retry mechanism; no explicit ordering primitive.
- **Q4 (default entanglement):** **retry-on-conflict (option e)**. Concurrent txs reading the same TRef cause whichever commits second to retry.
- **Q5 (lifecycle):** committed writes propagate immediately; failed/aborted txs leave no trace (overlay is discarded by the runtime).

---

## What an encoding into JS gains or loses

Note: effect-ts IS already a TypeScript encoding. So the framing here is "what would pulse gain or lose by adopting effect-ts's primitives," not "what would JS-encoding cost vs the original."

### What pulse would gain over its current model

- **Typed errors.** Every error becomes part of a function's signature via the `E` parameter. The "untyped throw" pulse currently has (errors propagate through `catchError` via owner walks, but their types are `unknown`) becomes precise.
- **Typed dependencies.** The `R` parameter forces effects to declare what services / context they need. Closer to algebraic-effects' typed effect rows.
- **STM as a transaction primitive.** Retry-on-conflict is option (e) for Q4; if we adopt STM, scenarios S1, S5, S7 get a principled answer rather than scenarios-doc bookkeeping.
- **Structural cancellation with guaranteed finalizers.** S6 becomes a "the framework just does this" property. No more "make sure your kick handler checks if it's still alive" footguns.
- **Effects as composable values.** `Effect.race`, `Effect.all`, `Effect.bind` give an algebra of async composition that pulse's current model (call functions; they return Promises; await sequentially) doesn't have.

### What pulse would lose

- **Reactive integration.** effect-ts is *orthogonal* to reactivity. Adopting it wholesale means losing pulse's defining feature (fused reactive + async). Any pulse-effect-ts hybrid would need a bridge from `Effect` execution back into signal writes — and the bridge would be a layer the effect-ts ecosystem doesn't have a canonical answer for.
- **Ergonomic "just call async functions."** Effect-ts requires `Effect.gen(function* () { yield* … })` for sequential async, not `async/await`. This is a real cognitive cost for users not already in the effect-ts world. The "function color" cost we earlier said pulse's `use()` avoids — effect-ts re-imposes that color, but in a different (typed) form.
- **Low-overhead direct reads.** Every read in effect-ts world goes through the Effect interpreter. A `signal()()` call in pulse is one function call; the equivalent in effect-ts is "look up the TRef in a transaction context, return its current version-tagged value." Heavier.
- **Component-level reactivity.** Pulse components depend on signals via the JSX layer; effect-ts has no JSX integration. You'd need to manage the subscription bridge manually — likely via something like `Stream` + `useState`, which is exactly the React-useEffect+useState pattern we said NOT to describe as React's async story.

### JS-specific constraints

- **STM retry forces purity.** Inside an STM block, you can't fire a server request — the block will retry, and the request would fire multiple times. effect-ts handles this via the type system (STM combinators don't expose Effect IO), but pulse's current model has no equivalent constraint and users would have to learn it from scratch.
- **Single-shot generators.** `Effect.gen`'s generator is single-shot; multi-shot resumption (calling a continuation multiple times with different values) isn't available via JS generators. effect-ts compensates via `Effect.retry` (which re-runs the whole effect from the top) but this is "re-execution," not "true multi-shot resumption." Same limitation pulse already has.
- **No native effect handlers.** effect-ts's "perform/handle" pattern is implemented via the runtime + the `Effect.gen` Adapter callback. Pulse encodes the same pattern via ambient mutable slots + try/catch. Both are JS-encoded; effect-ts has the heavier-but-more-typed encoding.

---

## Open questions raised

These get rolled up into the main research README's open-questions section.

- **Is "type-system-enforced" actually a single discipline-location category?** effect-ts uses the type system to enforce TWO different disciplines: (a) errors and dependencies must be in the type, and (b) STM purity (no IO inside STM blocks). These are different in nature — (a) is via type parameters, (b) is via vocabulary restriction (the STM combinator namespace doesn't include IO-shaped ops). Discipline-location might need to split into "structural typing of effect signatures" vs "vocabulary restriction" sub-axes.
- **Where does `Effect` itself sit on "async state lives"?** It's literally "in the runtime's interpretation state" — neither in a reactive graph nor an explicit overlay. The current axis values (fused / separate / actor / type) might need a "runtime-interpreted lazy description" value, OR we treat that as a special case of "separate."
- **Is "purity precondition" a missing axis?** STM requires purity inside the block; sagas don't; reactive computeds (Solid 2.x, pulse) don't formally require it but in practice they should be replayable. Worth tracking whether a system requires its async units to be pure for safe retry/replay.
- **What's "atomicity granularity" for systems with TWO layers?** effect-ts has STM-level atomicity (per-commit) AND fiber-level scope-bounded structural concurrency (per-scope). These are different granularities for different concerns. A single cell value flattens this; consider splitting.
- **Reactive bridge as a transferable concept.** effect-ts has a Stream / SubscriptionRef bridge between Effect and "things that change over time." Pulse's signals ARE that, but native. If we adopt effect-ts patterns, the bridge becomes critical — and how to do it cleanly is a known hard problem in the JS ecosystem (compare React + effect-ts's actual integration story; mostly ad-hoc).

---

## Cross-references

- **Other deep-dives this connects to:**
  - `algebraic-effects.md` (TODO) — effect-ts is effectively a TypeScript encoding of algebraic effects. The theory deep-dive should reference effect-ts's encoding choices.
  - `haskell-stm.md` (TODO) — effect-ts STM is a port-of-ZIO-which-is-port-of-Haskell-STM. Differences are mostly in the host language's type system, but worth comparing.
  - `solid-2-lanes.md` (TODO) — Solid 2.x's lanes do "block-on-entanglement" (Q4 option a) where effect-ts does "retry-on-conflict" (option e). Direct contrast in the taxonomy.
  - `cml.md` (TODO) — Concurrent ML's `choose`/`withNack` are different composition primitives for cancellation; comparing to effect-ts's `Scope` + interruption shows two answers to S6.
- **Taxonomy axes this dive informed:**
  - Conflict-handling policy: confirmed "retry-on-conflict" is a meaningful distinct value (already in axis vocabulary).
  - Discipline location: opened the sub-axis question (structural typing vs vocabulary restriction).
  - Atomicity granularity: opened the "two-layer atomicity" question.
- **Scenarios this dive addressed directly:** S1, S3, S4, S5, S6 (fully); S2, S7, S8 (partially).
- **Concept dives this builds on / motivates:** Motivates the algebraic-effects theory deep-dive (next session per the LOG's threads list). The Effect type's `R` parameter is closer to algebraic effect rows than anything else in the taxonomy; the theory dive should explicate the connection.

---

## Notes / aside

- effect-ts's documentation site (effect.website) is well-organized but some URLs return 404 (the `/docs/concurrency/stm` URL I tried first didn't exist; the STM docs live at the API reference site instead). Future sessions: prefer the API ref site for definitive signatures, and use the main docs for narrative descriptions of how things compose.
- The blog post by Yuriy Bogomolov (cited as secondary) is one of the clearer external explanations of effect-ts STM; worth citing when explaining the model to a non-effect-ts user, but the official API ref is canonical.
- ZIO is the JVM antecedent; effect-ts ports many ZIO primitives. When effect-ts docs are sparse, the ZIO docs are usually a fair source for "what the semantics SHOULD be" — flag as `[from-ZIO-equivalent]` when used.

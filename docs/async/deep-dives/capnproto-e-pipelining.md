# Cap'n Proto / E — Promise Pipelining

**Type:** primary
**Taxonomy row(s) affected:** "Cap'n Proto / E language" (currently 🟡)
**Status after this dive:** 🟢 verified — cells revised based on primary sources
**Date:** 2026-05-19
**Session:** 5
**Scope note:** Deep-dive on **promise pipelining** — the technique invented in Argus (Liskov & Shrira, 1988) and independently in Project Xanadu (Miller, Tribble, Jellinghaus, ~1989), formalized in the E language, and made operationally concrete in Cap'n Proto RPC. The dive treats E and Cap'n Proto together because (1) Cap'n Proto's protocol "is based heavily on CapTP, the distributed capability protocol used by the E programming language" (source 1), and (2) the trade-offs only make sense across the language/protocol boundary. Specifically sharpens the **async-representation** axis (what does "first-class promise value composable via pipelining" actually mean mechanically?) and the **reactive-integration** axis (is "orthogonal" the right cell for systems where the promise IS the primary surface?).

---

## Sources

Primary:

1. **[capnproto.org/rpc.html](https://capnproto.org/rpc.html)** — Cap'n Proto RPC specification. Definition of "promise" and "capability"; the answer-position wire model; explicit attribution: "Cap'n Proto's RPC protocol is based heavily on CapTP, the distributed capability protocol used by the E programming language."
2. **[capnproto.org/news/2013-12-13-promise-pipelining-capnproto-vs-ice.html](https://capnproto.org/news/2013-12-13-promise-pipelining-capnproto-vs-ice.html)** — Kenton Varda's blog post "Promise Pipelining and Dependent Calls: Cap'n Proto vs. Thrift vs. Ice." The calculator benchmark, the "4x longer" claim, the design philosophy ("simple, composable methods work fine"), the explicit distinction "Promises alone are *not* what I meant by 'time travel'!"
3. **[capnproto/c++/samples/calculator-client.c++](https://github.com/capnproto/capnproto/blob/master/c++/samples/calculator-client.c%2B%2B)** — Canonical pipelining code. Fetched via `gh api`. Shows `evalPromise.getValue().readRequest().send()` chaining; the multiplyResult → add3/add5 pattern with `setPreviousResult`; the four-RPC-in-one-roundtrip annotation in the calculator example.
4. **[ocapn/draft-specifications/CapTP Specification](https://github.com/ocapn/ocapn/blob/main/draft-specifications/CapTP%20Specification.md)** — OCapN CapTP wire-level spec. The `answer-pos` mechanism; `desc:answer`; `op:gc-answer` for promise lifetime; the three terminal states (fulfillment, breakage, fulfillment-with-another-promise); explicit "if you don't have it, you can't use it" capability discipline.
5. **[Spritely — "What is CapTP?"](https://spritelyproject.org/news/what-is-captp.html)** — Christine Lemmer-Webber's overview. The "make me a car, and as soon as that car is ready, I want to drive it" example. Handoff diagram (three-vat transfer).
6. **[Spritely Goblins — Promise Pipelining](https://files.spritely.institute/docs/guile-goblins/0.11.0/Promise-pipelining.html)** — The B→A→B→A→B (5 hops) vs B→A→B (3 hops) round-trip arithmetic. Code example showing the without-pipelining vs with-pipelining contrast.
7. **[Wikipedia — Futures and promises](https://en.wikipedia.org/wiki/Futures_and_promises)** — Historical attribution: Liskov & Shrira 1988 (Argus, called "call-streams"); Miller/Tribble/Jellinghaus ~1989 (Project Xanadu, independent); "It seems that promises and call-streams were never implemented in any public release of Argus."

Secondary / unavailable:

- **erights.org** is offline (`ECONNREFUSED` at time of dive). The original "Promise Pipelining" essay (`erights.org/elib/distrib/pipeline.html`) was not directly accessible. `web.archive.org` is blocked from this environment. Quoted attribution flows through sources 1, 5, 6, 7 instead.
- Miller, Tribble, Shapiro "Concurrency Among Strangers" (TGC05) — PDF unreachable. Substituted with Spritely's and Wikipedia's summaries of its claims. Flagged for a future session if a working URL surfaces.
- Mark S. Miller's PhD thesis "Robust Composition" (2006) — not directly fetched. The CapTP and pipelining content is well-covered in sources 1, 4, 5; the thesis would add depth on capability theory generally (which is somewhat tangential to our async-coordination focus).

Sourcing note: this dive is heavier on **protocol-level primary sources** (sources 1, 3, 4) and **practitioner overviews** (sources 2, 5, 6) than on the original E literature, because the original E literature is currently unavailable. The protocol-level sources are sufficient to characterize the mechanism precisely; the unavailability of the foundational E papers is a real gap but doesn't undermine the cells.

---

## What it is

**Promise pipelining** is a technique for invoking methods on a promise *before that promise has resolved*. The method call returns immediately with a new promise (for the eventual result of the method-on-the-eventually-resolved-value), and the runtime arranges for the chained invocation to happen automatically once the prior result is known — without an intervening client → server → client round trip.

In Cap'n Proto's terminology (source 1):

> "The promise actually has methods corresponding to whatever methods the final result would have, except that these methods may only be used for the purpose of calling back to the server."

That last clause is decisive: the promise is **not a generic delayed value** in the JS-Promise sense. It's a **typed handle on a future capability**, and chained method calls on that handle are sent to the *server* (the eventual owner of the resolved value), not evaluated on the client.

**E language** invented the protocol-level formalization in CapTP. The historical record (source 7):

> "Promise pipelining was invented by Barbara Liskov and Liuba Shrira in 1988. They referred to the pipelining mechanism by the name call-stream, which is now rarely used."
>
> "[Promise pipelining was developed independently by] Mark S. Miller, Dean Tribble and Rob Jellinghaus in the context of Project Xanadu circa 1989."

So the technique itself predates E by about five years. Argus had call-streams but "it seems that promises and call-streams were never implemented in any public release of Argus." E and Joule were the first systems where the design ran in earnest. Cap'n Proto is the modern industrial realization.

**Cap'n Proto** is the engineering instantiation that brought pipelining into wide practical use. From source 2:

> "Cap'n Proto sends all six calls from the client to the server at one time. For the latter calls, it simply tells the server to substitute the former calls' results into the new requests, once those dependency calls finish."

The pipelining mechanism is wire-level (source 4): each RPC has an `answer-pos`; subsequent calls reference that position via `desc:answer` *before the server has filled it in*; the server resolves the chain locally on dispatch.

In our research vocabulary, Cap'n Proto/E is:

- **An async representation:** a first-class typed value (the promise) that supports both *await* (deliver-on-resolve) and *invoke* (method-on-the-eventual). The latter operation is what distinguishes pipelining promises from plain promises.
- **An effect-locator pattern:** the promise carries enough information for the server to dispatch follow-up work *before the original work completes*. The async-coordination work happens at the protocol layer rather than the application layer.
- **A capability-security architecture:** promises are capabilities; "if you don't have it, you can't use it" (source 4). The promise's reference identity is the access-control mechanism.

**Critical distinction (source 2):** *Promises alone are not promise pipelining.* Many systems have "promises" or "futures" without pipelining (JS Promise, Java `CompletableFuture`, classic Argus). Pipelining specifically means *invoking methods on the unresolved promise*. This is the headline feature.

---

## The async-coordination model

### Composition (the headline)

Pipelining is the composition primitive. In the calculator-client example (source 3):

```cpp
// Set up the request.
auto request = calculator.evaluateRequest();
request.getExpression().setLiteral(123);

// Send it, which returns a promise for the result (without blocking).
auto evalPromise = request.send();

// Using the promise, create a pipelined request to call read() on the
// returned object, and then send that.
auto readPromise = evalPromise.getValue().readRequest().send();

// Now that we've sent all the requests, wait for the response.  Until this
// point, we haven't waited at all!
auto response = readPromise.wait(waitScope);
```

The comment is canonical: "this block executes in *one* network round trip because of promise pipelining: we do not wait for the first call to complete before we send the second call to the server."

The mechanics: `evalPromise.getValue()` returns a *pipelined capability reference* — a handle for "the Value object that `evaluate()` will eventually return." Calling `.readRequest()` on it constructs a request that will be dispatched to that not-yet-existing object. The request travels in the same network packet (or at least without waiting for the prior round trip) and references the prior call's answer-position via the `desc:answer` descriptor (source 4). The server, upon dispatching `evaluate()`, sees the read request queued against the answer-position, and once `evaluate()` returns, applies `read()` to the result locally — no second network hop.

For data dependencies that AREN'T method chains, Cap'n Proto provides `setPreviousResult` (source 3):

```cpp
auto multiplyResult = request.send().getValue();
// ...
add3Params[0].setPreviousResult(multiplyResult);
```

This wires the result of one in-flight call as the *argument* of another in-flight call, all in a single network roundtrip.

### Round-trip arithmetic

Source 6's clean statement of the topology benefit:

> "Without pipelining: B → A → B → A → B (5 hops). With pipelining: B → A → B (3 hops)."

Source 5's compact characterization:

> "I can send a message to a remote car factory and ask it to drive the car once it makes it, even before I've been told the car is made!"

Source 2's empirical claim:

> "[Thrift and Ice] take 4x longer than Cap'n Proto to do their work in this test."

The pattern generalizes: an N-step dependent chain that without pipelining takes N round trips, with pipelining takes 1. The total RTT cost is dominated by *the depth of the dependency graph*, not the number of calls.

### Conflict handling

Promise pipelining itself has no notion of "conflict." Pipelined calls are dispatched in causal order: each pipelined call's execution is gated by its prerequisite's resolution. There's no shared mutable state to conflict over within the pipeline itself; the server's underlying state is mutated by serial method-dispatch (the actor / vat model).

E (and CapTP) use the **vat** model: each vat is a single-threaded event loop with its own object heap, and inter-vat communication is purely message-based. Within a vat, message-dispatch is serial — turns are atomic. Conflict resolution is thereby pushed to the vat-level: two pipelined operations from different clients arrive at the server vat, are serialized, and the second sees the post-effect state of the first.

This is structurally **like Erlang/Akka actors** (last-write-wins by message-arrival-order), not like STM (retry on conflict).

### Cancellation

The protocol (source 4) handles promise lifetime through garbage collection, not explicit cancellation:

> "When the answer position is no longer needed, senders must notify peers with `op:gc-answer` messages, allowing positions to be re-used."

There's no equivalent to effect-ts's `Scope` with interruption. If the client drops its reference to a pipelined promise, the server will eventually receive an `op:gc-answer` notification; until then, the pipelined chain runs to completion. **Pipelining is fire-and-forget at the chain level**: the chain is built up, dispatched, and either resolves or breaks. You can stop *receiving* the answer (drop your handle) but you can't typically rescind in-flight work.

This matches **Cap'n Proto/E's failure model**: if any link in the pipelined chain breaks (raises an error), downstream links break with propagated errors (source 4). This is automatic — the application doesn't manually handle intermediate failures; promise breakage flows through the chain.

### Suspension / resumption

No suspension in the React/effect-ts sense. The pipelined chain is dispatched eagerly; client-side reads either `.wait()` synchronously (blocking the event loop in C++ Cap'n Proto) or `.then()` for callback continuation. There's no implicit "suspend this computation until the value is ready."

E's vat model has **turns** (the unit of single-threaded execution). Within a turn, code runs to completion; between turns, the vat handles incoming messages and resolves promises. This is structurally a generator-style coroutine model at the vat level, but it's not exposed as algebraic-effect-style suspension.

### Lifecycle / structure

Promises live in the answer-table of the originating RPC connection. The wire protocol (source 4) gives each answer a position; pipelined references use those positions; explicit `op:gc-answer` reclaims them. Three terminal states: fulfilled with value, broken with error, or fulfilled with another promise (a forwarder — for "this result is actually living over there" cases).

The handoff machinery (source 5's "three-vat" diagram) is how Cap'n Proto/CapTP handles the case where vat A holds a promise from vat B, then introduces vat C to that promise — there's a protocol-level dance to redirect C's future calls directly to B without going through A. This is the **partition-tolerance / scale-out** story: pipelining works across more than two parties.

### Discipline location

Runtime-enforced at the protocol level. The protocol's typing (every promise has a known type, derived from the IDL schema) is what makes pipelining type-safe: the client knows what methods are valid on the not-yet-resolved promise because its type is known statically from the schema (source 1's "the promise actually has methods corresponding to whatever methods the final result would have"). This is closer to "runtime-enforced via schema types" than "type-system-enforced" in the effect-ts sense — the type system involved is the *IDL*, not the language's native type system, though the C++ binding makes it look like native types.

---

## Taxonomy cells

### Where async state lives
**Cell:** in distributed promises (answer-tables on each peer); object state in vats
**Evidence:** Source 4: answer-positions are exported on a per-session basis; each session has its own promise table. Source 1: capabilities point to objects in remote (or local) vats. Async state is *split across peers* — the unresolved promise's identity lives on multiple machines simultaneously.

### Conflict-handling policy
**Cell:** n/a within a pipeline; **vat-level serial dispatch** at the resolution end (last-message-wins per object, like actor mailboxes)
**Evidence:** Source 4: messages to a promise's eventual object are queued and delivered serially when the promise resolves. The vat model (sources 1, 5) gives single-threaded event-loop semantics per object, so there's no in-vat concurrency to conflict on. Inter-vat conflicts are mediated by message-arrival ordering at the destination vat.

### Cancellation discipline
**Cell:** lifecycle-event via reference-counting (`op:gc-answer`); no in-flight cancellation primitive
**Evidence:** Source 4: "When the answer position is no longer needed, senders must notify peers with `op:gc-answer` messages." There's no equivalent of effect-ts's `Scope` + interruption; in-flight pipelined chains run to completion.

### Async representation
**Cell:** **first-class typed promise value with method-invocation pipelining**; the method-call-on-unresolved-promise is the headline operation
**Evidence:** Source 1: "The promise actually has methods corresponding to whatever methods the final result would have." Source 2 distinguishes this from plain promises: "Promises alone are *not* what I meant by 'time travel'!" Source 3 shows the C++ binding making pipelined method-calls look like regular method-calls, returning a new promise.

### Isolation level
**Cell:** n/a (no transactions in pipelining itself; vat object state is mutated serially)
**Evidence:** Pipelining doesn't have transactions. Source 4 documents promise states but no commit/abort protocol. Higher-level patterns (using capability handoff to model atomic-ish operations) exist but aren't in the protocol.

### Atomicity granularity
**Cell:** per-RPC call (server-side dispatch is atomic per-method-call within a vat turn)
**Evidence:** E's vat model: turns are atomic. A method invocation is one turn (modulo nested awaits inside the method). Cap'n Proto inherits this. The pipelined chain is *not* atomic as a whole — each link is its own turn.

### Discipline location
**Cell:** runtime-enforced via protocol; types come from the IDL schema (not language native types)
**Evidence:** Source 1: the promise's available methods are determined by the schema-declared interface type. The CapTP wire protocol (source 4) carries these types; clients can't pipeline methods that don't exist in the schema. In C++ bindings the IDL becomes native types via codegen, but the discipline source is the schema.

### Reactive integration
**Cell:** **orthogonal** — promises are an async primitive, not a reactive-graph primitive; they can be bridged to a reactive layer but no integration is prescribed
**Evidence:** Cap'n Proto's KJ event loop drives promises; integration with a UI's reactive layer would be application code. Sources 1, 2, 3 don't discuss reactive UIs. The pipelining primitive itself is concerned with network round-trips, not reactive dependency tracking.

---

## Scenario mapping

| Scenario | Solved? | How |
|---|---|---|
| **S1 — Like/unlike race** | partial | Two pipelined toggle calls from the same client arrive in causal order at the server vat; serialized by vat turn semantics. Two from DIFFERENT clients race at the server — last-write-wins. No optimistic-with-revert primitive. |
| **S2 — Auto-save vs explicit save** | partial | Both as pipelined RPCs; both arrive at the server vat, serialized. The "explicit save uses the user's payload, auto-save uses staged payload" semantics is application-level. |
| **S3 — Multi-step server flow with partial failure** | yes | The canonical pipelining use case. Failure of any link breaks all downstream links automatically (source 4). The error propagates without manual handling. **One round trip total** for the entire dependent chain. |
| **S4 — Concurrent independent flows** | yes | Independent pipelined chains don't interfere; vat dispatch serializes them. |
| **S5 — Cross-transaction read** | n/a | No transaction primitive. |
| **S6 — User-cancellable flow** | partial | Drop the promise reference; `op:gc-answer` eventually fires. Server-side in-flight work may complete (no interruption guarantee). Weaker than effect-ts; comparable to JS `AbortController`. |
| **S7 — Optimistic reconciliation** | partial | Pipelining doesn't address optimistic UI directly. Pattern: capture predicted result locally, dispatch RPC chain, on resolution reconcile. Application-level. |
| **S8 — Preview / what-if mode** | partial | Could be modeled by introducing a "preview vat" or scoped capability; not built-in. Cap'n Proto's capability-revocation pattern (revoking the cap throws away preview state) is suggestive but unconventional. |

**Policy questions** (per `concurrent-flows.md` Q1–Q5):

- **Q1 (overlay read inside tx):** n/a.
- **Q2 (outside-tx read):** committed truth only; no overlay concept.
- **Q3 (commit ordering with shared state):** vat message-arrival order resolves it.
- **Q4 (default entanglement):** **none — vat-serial dispatch + last-write-wins (b extreme), with the wrinkle that pipelining causally orders one client's dependent calls relative to each other.**
- **Q5 (overlay lifecycle):** n/a.

---

## What an encoding into JS gains or loses

### Could JS get pipelining at all?

JS Promises are *not* pipelining promises. `p.then(v => v.foo())` requires `p` to resolve before `.foo()` is even known about — the function `v => v.foo()` is opaque to any RPC layer. There's no way for a generic JS Promise infrastructure to peek inside the `.then` continuation and pre-dispatch the inner call.

To get pipelining in JS, you need either:

1. **A proxy-based pipelined promise type.** Browser-side libraries like [PromisePipe](https://github.com/agoric-labs/eventual-send) and Agoric's `E()` operator use ES6 Proxies to intercept method-invocations on promise-shaped objects and rewrite them as pipelined RPC dispatches. The shape `E(p).foo(x).bar(y)` works because `E(p)` returns a Proxy that intercepts `.foo`, sends a pipelined RPC, and returns another such Proxy.
2. **A schema/IDL-driven typed promise.** Cap'n Proto's JS bindings (when they exist) use the codegen approach: each interface gets a generated promise type whose methods are statically known.

Both work. Both are non-trivial. **Neither composes with the native `await`/`then` machinery transparently** — you have to opt in to the proxy/typed wrapper.

### What pulse would gain from adopting pipelined-promise discipline

Honestly, not much directly. Pipelining is a network-RPC technique; pulse is a reactive-binding library. The two concerns are orthogonal in the strictest sense.

**However**, the *conceptual* lesson generalizes:

- **"Method on an unresolved value" is the operation that makes the difference.** Pulse already does something structurally similar: `use(view).name` reads a field through a possibly-unresolved value, with the field-access participating in the dependency graph even before resolution. The pipelining insight — that *you can dispatch dependent work eagerly against the unresolved handle* — is a different generalization of the same idea ("operate on the not-yet-here").
- **The "promise has the methods of its eventual value" type discipline is portable.** Pulse's `use()` could be sharpened: if `signal<User>()` exposed `.name`, `.email`, etc. as accessors that participated in the dependency graph (and unwrapped on read), it would be a closer analog. This is the proxy-based approach. Worth a design exploration.
- **Schema-driven dependent dispatch is a real win for sync engines.** If pulse ever has a sync-engine story (Replicache/Linear/Zero-shaped), pipelining the client → server batched-mutation chain is concretely useful. Cap'n Proto's "send all six calls at one time" pattern maps onto "send all five mutations in this batch with their causal dependencies declared."

### What pulse would lose if it tried to be pipelining-shaped

- **The capability-security framing is heavy.** Cap'n Proto's discipline ("if you don't have it, you can't use it") is load-bearing for E's design but is overkill for a single-process reactive library.
- **The vat model is a strong commitment.** Single-threaded event loops with serial turn dispatch are exactly what JS already gives you; the architectural value-add of "vats" doesn't show up until you have multiple processes/machines.
- **The IDL/schema is a big commitment.** Pipelined promises in Cap'n Proto are typed because the schema says so. Pulse's signals are typed by TypeScript at the language level; introducing an IDL layer would be a massive expansion.

### JS-specific constraints

- **ES6 Proxies enable lightweight pipelining encodings** but they don't compose with `await`. Agoric's `E()` operator works around this by being its own dispatch operator (`E(p).foo(x)`) rather than `await p.foo(x)`.
- **The TC39 proposal for first-class operator support** (the [eventual-send / `E` proposal](https://github.com/tc39/proposal-eventual-send)) tried to make pipelining first-class in JS. The proposal stalled. Indication: there's been demand, but the ergonomic cost of "opt-in async operator distinct from await" was a sticking point.
- **No multi-vat model in JS.** Browser tabs and workers are vat-shaped, but the cross-tab promise-routing infrastructure doesn't exist by default. Spritely Goblins (source 6) and Agoric (which targets server-side JS) provide this in their respective runtimes.

---

## Open questions resolved

- **Where on the async-representation axis does Cap'n Proto/E sit?** The pre-dive cell "first-class promise value (composable via pipelining)" was right at the abstract level, but the dive sharpens it: the *headline* property is "method invocation on the unresolved promise dispatches eagerly to the eventual owner." This is materially stronger than "promise is a value" (e.g. JS Promise is also a value but doesn't support pipelining). Suggests the axis may need a sub-distinction between *await-only promises* (JS, classic Argus) and *pipelining promises* (E, Cap'n Proto, Agoric `E()`).
- **Is "orthogonal" the right reactive-integration cell?** Yes. Pipelining is a network-RPC technique. It's orthogonal to whether the result lands in a reactive graph or a procedural callback. The cell stays "orthogonal."

## Open questions raised

- **Should "continuation cardinality" — the candidate axis from session 3 — distinguish pipelining promises from await-only promises?** Pipelining promises are still 1-shot at the resolution end (you only resolve once), but they support *eager dispatch of dependent operations* before resolution. This is a different orthogonal property — *dependent-dispatch capability* — that the cardinality axis doesn't capture. Possibly its own axis: "dependent dispatch — none / explicit (`.then` requires resolved value) / pipelined (method invocation before resolution) / pipelined+typed (method invocation before resolution, type-checked from schema)." Hold this candidate axis pending one or two more dives (especially React modern, where `use()` and Suspense have related but different "before resolution" semantics).
- **Could pulse adopt proxy-based pipelined accessors?** `use(signal<User>())` could return a proxy where `.name` is a pipelined dependent computation rather than a method call. This would be the Cap'n Proto idea applied to reactive bindings rather than to RPC. Worth a focused design exploration — but only after the research surveys enough other systems to be confident this is the right direction.
- **Does pulse's `<Loading>` boundary share semantic structure with Cap'n Proto's promise breakage propagation?** Both treat downstream-of-an-unresolved-thing as automatically inheriting the unresolved-or-broken state. The pulse pipeline-OR `isPending` walks and CapTP's "if any link breaks, downstream breaks" might be the same idea at different scales. Worth checking.
- **Is the IDL/schema dependency the load-bearing piece of why Cap'n Proto pipelining works?** Tentatively yes — without schema-driven typing, pipelining would need either runtime dispatch reflection (proxies) or unsafe ad-hoc dispatch. The schema is what makes "the promise has the methods of its eventual value" *statically known*. This is a strong piece of evidence for the candidate "discipline-location" sub-axis around what KIND of typing enforces the discipline (language types vs schema types vs runtime invariants).

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`effect-ts.md`](./effect-ts.md) — effect-ts's `Effect<A, E, R>` is also a first-class typed value with method-call composition, but the composition is *interpretation-deferred* (the Effect is a description, evaluated by the runtime), not eager-dispatch over the wire. Different shapes of "first-class effectful value."
  - [`bonsai-incremental.md`](./bonsai-incremental.md) — Bonsai's `Effect.t` is dispatched by the runtime; results land via action dispatch. Could pulse have an `action(...)` that *pipelines* — chains dependent actions before previous resolve? Bonsai's actions don't do this; pipelining would be a generalization. Worth noting for future framework-design exploration.
  - [`algebraic-effects.md`](./algebraic-effects.md) — algebraic effects allow handlers to choose how to interpret an operation; pipelining is a specific runtime interpretation that batches dependent operations. The pipelining mechanism *could* be implemented as an algebraic-effect handler, conceptually. Bridges the two framings.
  - `react-modern.md` (TODO, next session) — React's `use(promise)` and `<Suspense>` have a "method-call on unresolved" feel but are structurally different (re-execution rather than eager-pipeline). Worth precisely contrasting.
  - Replicache / Linear-sync (TODO, taxonomy ⚪) — these systems' mutation queues ARE pipelined dependent calls in disguise. The connection deserves its own dive.
- **Taxonomy axes this dive informed:**
  - **Async representation:** suggests sub-distinction between await-only promises and pipelining promises. Possibly a candidate axis: "dependent-dispatch capability."
  - **Reactive integration:** "orthogonal" confirmed for Cap'n Proto/E.
  - **Discipline location:** strengthens the case that this axis needs to split by *what kind of typing* (language types, schema/IDL types, runtime invariants).
- **Scenarios this dive addressed:** S1 partial (vat-serial), S2 partial, S3 **yes** (the canonical case — automatic error propagation through a dependent chain), S4 yes, S5 n/a, S6 partial (drop-and-gc), S7 partial, S8 partial.
- **Concept dives this builds on / motivates:**
  - Builds on the algebraic-effects framing (session 3): pipelining can be viewed as a handler that batches operations.
  - Motivates a future **capability security** concept dive — the broader CapTP design is unified by capability principles; pipelining is only one of its features.
  - Motivates a future **synchronous reactive vs distributed reactive** comparison — Incremental (session 4) is sync DAG-based, Cap'n Proto is distributed message-based; both have "structures that change as data flows" semantics, but for very different reasons.

---

## Notes / aside

- **erights.org being offline is a real research-infrastructure problem.** It's the canonical primary source for E and the early CapTP work; archive.org access is blocked. The dive cites secondary practitioner-overviews (sources 5, 6) for content that should ideally come from Miller's original writings. Flag for re-verification if erights.org comes back online or if a working mirror is found.
- **Agoric and Spritely are the two modern industrial users of CapTP** outside Cap'n Proto. Agoric's `E()` operator and Spritely Goblins are both worth a follow-up survey if pipelining-in-JS becomes a serious design question for pulse.
- **The TC39 eventual-send proposal** ([`tc39/proposal-eventual-send`](https://github.com/tc39/proposal-eventual-send)) tried to standardize the `E()` operator in JS. It hasn't progressed. If pulse seriously considers pipelined accessors, the proposal's discussion threads are likely the best primary source for what blocked language-level adoption — separate session.
- **Promise pipelining is uniquely a "1988 + 1989 dual invention" story.** Liskov & Shrira at MIT (Argus) and Miller/Tribble/Jellinghaus at Xanadu independently arrived at the same idea within a year. Argus dropped it; E carried it forward. Cap'n Proto productized it ~25 years later. A genuinely Hard Problem worked on by serious researchers for decades — and yet JS doesn't have it natively even now.
- **The "Time-Travel Trick" framing (source 2)** is Kenton Varda's marketing language but the underlying claim is precise: pipelining lets you write code as if you already had the value, and the protocol arranges for the dependent operations to be dispatched as if you had. This is the same conceptual shape as `use(view).name` in pulse — operate on something you don't yet have — but at the network rather than the reactive-graph layer.

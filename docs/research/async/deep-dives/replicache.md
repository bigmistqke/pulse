# Replicache — mutations as git-rebaseable transactions over a B-tree client view

**Type:** primary
**Taxonomy row(s) affected:** "Replicache / Rocicorp Zero" (Replicache row only — Zero treated as cross-reference, not verified here)
**Status after this dive:** 🟢 verified
**Date:** 2026-05-19
**Session:** 8
**Scope note:** This dive focuses on Replicache the open-source sync engine. Rocicorp Zero is its successor and lives in the same monorepo (`rocicorp/mono`) but is not analyzed here. Where the Zero codebase appears in source paths (e.g. `#zero?.advance(...)` hooks in `replicache-impl.ts`), it is noted as integration surface only — no claims are made about Zero's behavior. All quotes are pulled from primary sources (Rocicorp docs and the `rocicorp/mono` source tree on `main` at the time of fetch, 2026-05-19). This dive was conducted using the **parallel-passes-then-merge** methodology established in session 7: a background agent did the systematic source-reading + docs work; a main-session pass focused on design-rationale + cross-system framing. The fresh source-based pass became the spine; cross-references to other dives + LOG-thread engagement were backported into this final document.

---

## Sources

Primary:

1. **[How Replicache Works (concepts)](https://doc.replicache.dev/concepts/how-it-works)** — architectural overview, rebase, pokes, mutator semantics.
2. **[Tutorial: Adding Mutators](https://doc.replicache.dev/tutorial/adding-mutators)** — definition of mutators, queueing, optimistic execution.
3. **[Tutorial: Subscriptions](https://doc.replicache.dev/tutorial/subscriptions)** — query-subscription model, re-evaluation rules.
4. **[Tutorial: Sync](https://doc.replicache.dev/tutorial/sync)** — push/pull/poke setup.
5. **[API: WriteTransaction](https://doc.replicache.dev/api/interfaces/WriteTransaction)** — transaction interface, `reason: 'initial' | 'rebase' | 'authoriative'`, `mutationID`.
6. **[API: Replicache class](https://doc.replicache.dev/api/classes/Replicache)** — `subscribe`, `query`, `mutate`, `push`, `pull` signatures.
7. **`rocicorp/mono` @ `main`, `packages/replicache/src/sync/push.ts`** — push payload shape (`MutationV1`), pending-commit walk. (`https://github.com/rocicorp/mono/blob/main/packages/replicache/src/sync/push.ts`)
8. **`rocicorp/mono` @ `main`, `packages/replicache/src/sync/pull.ts`** — pull, sync head, `replayMutations`, snapshot comparison. (`https://github.com/rocicorp/mono/blob/main/packages/replicache/src/sync/pull.ts`)
9. **`rocicorp/mono` @ `main`, `packages/replicache/src/replicache.ts`** — public surface; `subscribe` / `mutate` / `experimentalPendingMutations`. (`https://github.com/rocicorp/mono/blob/main/packages/replicache/src/replicache.ts`)
10. **`rocicorp/mono` @ `main`, `packages/replicache/src/replicache-impl.ts`** — `#mutate`, `maybeEndPull`, the `rebaseMutationAndCommit` call site, the `#closeAbortController`. (`https://github.com/rocicorp/mono/blob/main/packages/replicache/src/replicache-impl.ts`)
11. **`rocicorp/mono` @ `main`, `packages/replicache/src/pending-mutations.ts`** — `PendingMutation` shape (id, name, args, clientID).

Secondary (design rationale):

- **[Rocicorp blog: Ready, Player Two (Reflect article)](https://rocicorp.dev/blog/ready-player-two)** — used only for design-rationale quotes about "Transactional Conflict Resolution" / "linearization of arbitrary functions"; Reflect is a sibling product on the same engine, so any quote here is flagged as design-philosophy not Replicache mechanics.

Unfetched / unavailable:

- The legacy `rocicorp/replicache` repo (`pushed_at: 2022-05-07`) is a stub README only; development has moved to `rocicorp/mono/packages/replicache`. All source citations are against `mono`.
- `https://doc.replicache.dev/concepts/db-isolation` — 404 (no such doc page).
- The Reflect blog post landed under `rocicorp.dev/blog/ready-player-two`; on fetch the renderer described it under the "Reflect" product brand. Treated as Rocicorp design-philosophy only.

---

## What it is

Replicache is a **client-side sync engine** that maintains a persistent ordered key→JSON map (the "Client View") in IndexedDB, applies named transactional functions ("mutators") to it locally for instant UI feedback, ships a log of those mutations to the server, and replays still-pending mutations on top of whatever authoritative state the server returns. In pulse's vocabulary it is a **per-client transactional cache with a replayable mutation log and a git-rebase-style reconciliation step**: the client maintains two heads (a main head and a sync head) over a content-addressed DAG; pulling rewinds to the server snapshot, applies the server patch, then re-applies any client mutations the server hasn't yet acknowledged.

The system's own words: mutators are "JavaScript functions encapsulating change and conflict resolution logic" that "run once on the client immediately (aka 'optimistically'), and then run again later on the server ('authoritatively') during sync" (docs). Conflict resolution is *not* a merge algorithm — it's the second execution of the mutator against the new server state.

---

## The async-coordination model

### Where async state lives

Async state is split across three persistent stores plus an in-memory abort/scheduler graph:

- The **persistent DAG** (`packages/replicache/src/dag`) backed by IndexedDB. Commits are content-addressed B-tree snapshots. There are two named heads: `DEFAULT_HEAD_NAME` (the main head, what the UI sees) and `SYNC_HEAD_NAME` (a scratch branch used during pull). Source: `replicache-impl.ts:26` `import {rebaseMutationAndCommit} from './db/rebase.ts';` plus `pull.ts` references to `SYNC_HEAD_NAME` and `DEFAULT_HEAD_NAME`.
- The **pending-mutation log**, which is *not* a separate queue — it is "the pending commits between the base snapshot and the main head" (`push.ts:120-127`). A pending mutation is literally a local commit whose `mutationID` exceeds the latest `lastMutationID` confirmed by the server. Push reads them with `localMutations(mainHeadHash, dagRead)`.
- The **subscription registry** plus **connection loops** (`#pushConnectionLoop`, periodic puller). These are runtime structures tied to a single `#closeAbortController` (`replicache-impl.ts:326`).

This matches the prior 🟡 row's "separate (client cache + mutation queue)" claim, but more precisely: the cache *is* the queue — pending mutations are the suffix of commits beyond the last server snapshot.

### Conflict handling

Replicache does not have a merge algorithm. The docs are explicit: "Mutators are arbitrary JavaScript code, so they can programmatically express whatever conflict resolution policy makes the most sense for the application" (How it Works). The engine's contribution is the rebase: "it _rewinds_ the state of the Client View to the last version it got from the server, applies the patch to get to the state the server currently has, and then replays any pending mutations on top." (How it Works).

In `pull.ts:380-400`, after the server's patch is applied to a new snapshot under `SYNC_HEAD_NAME`, the engine collects every local commit on the main chain whose `mutationID` exceeds the sync head's recorded `lastMutationID` per client, reverses them into ascending mutation-id order, and returns them as `replayMutations`. The driver in `replicache-impl.ts:795-815` then loops over each and calls `rebaseMutationAndCommit(mutation, dagWrite, syncHead, SYNC_HEAD_NAME, this.#mutatorRegistry, ...)`. The mutator function — looked up by name in `#mutatorRegistry` — is re-invoked against the new state.

The `WriteTransaction.reason` field (`'initial' | 'rebase' | 'authoriative'`, API ref) lets a mutator distinguish first-run from replay. So conflict handling is: **last-write-wins as imposed by server linearization, plus user-authored compensations triggered via the `reason === 'rebase'` branch** if the author wants them.

The "last-write-wins (cache invalidation)" cell in the prior 🟡 row is partially misleading. The right phrasing is **server-linearized re-execution**: there is no LWW at the key level — the second execution of the mutator gets to do whatever it likes, including a no-op (e.g., "comment already deleted by someone else? skip"). See Notes for refinement.

### Cancellation

Cancellation in Replicache is **lifecycle-scoped, not per-mutation**. There is exactly one `AbortController` per instance (`replicache-impl.ts:326`):

```ts
readonly #closeAbortController = new AbortController();
```

Its signal is threaded into every long-running subsystem: the puller's interval (`setIntervalWithSignal`), the push connection loop, GC tasks, mutation recovery, etc. `Replicache.close()` calls `this.#closeAbortController.abort()` (`replicache-impl.ts:740`).

There is **no per-mutation cancellation API**. Once `replicache.mutate.foo(args)` is invoked:

1. It synchronously commits a local optimistic commit (see `#mutate` in `replicache-impl.ts:1511-1602`).
2. The commit's presence in the dag-between-snapshot-and-main-head *is* its enqueue.
3. There is no public method to remove it before it pushes. The only way it "goes away" is when the server acknowledges its `mutationID` (then `pull.ts` advances the snapshot's `lastMutationIDChanges`, and the next pull no longer counts it as pending — `pull.ts:286-293`).

This refines the prior 🟡 cell from "lifecycle-event (abortController)" to **process-lifecycle AbortController; no per-mutation cancellation**. The user-facing semantic is closer to *fire-and-eventually-confirm*. The "abort" knob shuts down the *sync engine*, not individual mutations.

### Suspension / resumption

Mutators are plain async functions; they suspend on `await tx.get(...)`, `await tx.scan(...)`, etc. The `WriteTransaction` methods all return Promises (`set`, `del`, `get`, `has`, `scan` — API ref). Replay is **re-execution, not continuation resumption**: `rebaseMutationAndCommit` looks the mutator up by name in `#mutatorRegistry` and calls it again with the same JSON args against a new transaction (with `reason: 'rebase'`). There is no captured continuation.

Importantly, the mutator's **return value** from the original local call is what the JS caller saw; the replay's return value is *discarded* (it isn't re-delivered to anyone — `replicache-impl.ts:795-815` doesn't capture it). So whatever a UI captured from the optimistic run is final from the JS caller's perspective.

### Composition

There is no first-class composition operator for mutations. The composition model is:

- A single mutator may `await` arbitrarily many tx methods within itself — that whole body commits atomically.
- Multiple mutator calls compose by being separate commits in mutation-id order.
- A caller can `await replicache.mutate.foo(args)` and then call `replicache.mutate.bar(args2)` — `bar` will see `foo`'s effects locally. But neither call has a way to reference the *server-confirmed* outcome of the other before pushing.

There is no `pipeline(foo(), bar())` primitive. There is no way to say "run `bar` after the server has acknowledged `foo`." See research-question section A.

### Error handling

If a mutator throws during the local run, the local commit is rolled back via the `withWriteNoImplicitCommit` lock (`replicache-impl.ts:1531-1601`), and the error propagates to the JS caller. From the comment block at `replicache-impl.ts:1582-1589`:

```ts
} catch (e) {
  // If we threw before we could persist the mutation
  // then we need to reject the mutation.
  if (trackingData) {
    this.#zero?.rejectMutation(trackingData.ephemeralID, e);
  }
  throw e;
}
```

Server-side errors are application-defined; Replicache's documented contract is only that the server is the linearization point. If the *replay* throws, the per-mutation loop in `maybeEndPull` would propagate the error up; the rebase abandons. (Not exhaustively verified — see Open Questions.)

### Lifecycle / structure

A Replicache instance owns a B-tree DAG persisted in IndexedDB, periodic sync loops, and the mutation log. Mutations outlive a page reload: when the engine boots, pending commits are still present and a push can be retried (see `mutation-recovery.ts`, not deep-dived here).

---

## Taxonomy cells

### Where async state lives
**Cell:** **Persistent B-tree DAG + named heads (main, sync) + per-instance abort scope**. Pending mutations are the commit-suffix between the last server snapshot and the main head — not a separate in-memory queue.
**Evidence:** `push.ts:120-127` ("Find pending commits between the base snapshot and the main head"); `pending-mutations.ts:18-28` (`pendingMutationsForAPI` walks `localMutationsDD31(mainHeadHash, dagRead)`); `replicache-impl.ts:326` (single `#closeAbortController`).

### Conflict-handling policy
**Cell:** **Server-linearized re-execution of named mutators**. No merge algorithm; user-authored mutators decide what "conflict resolution" means by being run again with `reason === 'rebase'`.
**Evidence:** "Mutators are arbitrary JavaScript code, so they can programmatically express whatever conflict resolution policy makes the most sense for the application" (How it Works); `pull.ts:380-400` collects `replayMutations`; `replicache-impl.ts:795-815` calls `rebaseMutationAndCommit` per mutation; `WriteTransaction.reason` enum (API ref).

### Cancellation discipline
**Cell:** **Lifecycle-scoped only**. One `AbortController` for the whole engine instance; `close()` aborts sync loops and GC. **No per-mutation cancellation.**
**Evidence:** `replicache-impl.ts:326` (`readonly #closeAbortController = new AbortController()`); `replicache-impl.ts:740` (`this.#closeAbortController.abort()` in `close`); absence of any `mutate.foo(...).cancel()` surface in `replicache.ts` and the API ref.

### Async representation
**Cell:** **Named, JSON-argued mutation records** — `{id, name, args, timestamp, clientID}` in the push payload; mutator bodies are async functions invoked by name from a registry. Mutation is a **(name, args)** pair targeting a named function defined on both client and server.
**Evidence:** `push.ts:36-42`:
```ts
export type MutationV1 = {
  readonly id: number;
  readonly name: string;
  readonly args: ReadonlyJSONValue;
  readonly timestamp: number;
  readonly clientID: ClientID;
};
```
`pending-mutations.ts:6-11` (same shape). The mutator registry: `replicache-impl.ts:1461-1464`, `#registerMutators`. Docs (Adding Mutators): "Mutators are arbitrary functions that run once on the client immediately ... and then run again later on the server ('authoritatively') during sync."

This refines the prior 🟡 "typed mutation = (optimistic-fn, server-fn) pair." More precisely: it's a **named-callable abstraction** where the client and server hold separate implementations of the same name (the server impl can do anything — "the push endpoint is _not necessarily_ expected to compute the same result that the mutator on the client did", How it Works). The wire form carries only `(name, args)`, *not* the function body. The "two implementations of one name" pattern is conventional, not enforced by the engine.

### Isolation level
**Cell:** **Snapshot-per-transaction with explicit dual heads** — every `mutate`/`query`/`subscribe` body runs inside a transaction over an immutable B-tree snapshot. The UI observes the main head only. The sync head is invisible to application code until a pull completes and the heads swap (`pull.ts:432`, `dagWrite.setHead(DEFAULT_HEAD_NAME, syncHeadHash)`).
**Evidence:** `replicache.ts:415-420` ("Query is used for read transactions. It is recommended to use transactions to ensure you get a consistent view across multiple calls"); `pull.ts:286-300` (sync work happens under `SYNC_HEAD_NAME`, not visible until the rebase completes and main head moves); subscription docs ("Replicache only calls the query function when any of the keys it accessed last time change").

This sharpens the prior 🟡 "snapshot-ish (per-replay)" — it is **true snapshot isolation per transaction, with a per-pull replay branch.**

### Atomicity granularity
**Cell:** **Per-mutator-invocation**. A single mutator function body, however many `await tx.set/del/get/scan` calls it makes, commits as one B-tree commit. Cross-mutator atomicity is not provided.
**Evidence:** `replicache-impl.ts:1531-1597` — `withWriteNoImplicitCommit(this.memdag, async dagWrite => { ... result = await mutatorImpl(tx, args); ... [newHead, diffs] = await dbWrite.commitWithDiffs(DEFAULT_HEAD_NAME, ...); ... })`. One mutator = one commit.

### Discipline location
**Cell:** **Runtime-enforced at the engine boundary.** The `withWriteNoImplicitCommit` lock, the named-head DAG, and the registry-based replay all enforce structure outside user code. Authors only write mutator bodies; the engine handles snapshot/lock/commit.
**Evidence:** Same `replicache-impl.ts:#mutate` block; the `#mutatorRegistry` resolution at `replicache-impl.ts:1461-1464` and at the replay site `replicache-impl.ts:804`.

### Reactive integration
**Cell:** **Standing-query subscriptions with read-set dependency tracking**, fired post-commit on both optimistic mutation and post-rebase. Also `experimentalWatch` for raw key-prefix change streams.
**Evidence:** `replicache.ts:380-385` (`subscribe<R>(body, options): () => void`); docs (Subscriptions): "Replicache only calls the query function when any of the keys it accessed last time change ... The `onData` callback is only called when the result of the query function changes." `replicache.ts:397` (`experimentalWatch`: "This gets called after commit (a mutation or a rebase)"). `replicache-impl.ts:1595` (`await this.#subscriptions.fire(diffs);` at end of `#mutate`) and `replicache-impl.ts:788` (`await this.#subscriptions.fire(diffs);` at end of `maybeEndPull` when no replay remains).

This is the prior 🟡 "separate" cell promoted: reactivity is **integrated** in the sense that subscriptions ride directly on commit diffs, but it is **separate** from the dependency tracking your application's framework (React, Solid) does — your framework subscribes to Replicache, which is itself a tracked-read system internally.

---

## Research-question answers

### A. Dependent-dispatch capability axis

**Verdict: Replicache extends the axis with a new value: *named replayable RPC* — sequenced, not pipelined, not chainable.**

The prior axis values:

- *await-only* (JS Promise, React `use`)
- *await-only with generator batching* (Solid 2.x, Bonsai, Effect)
- *pipelined* (Cap'n Proto, Agoric `E()`)
- *pipelined+typed* (Cap'n Proto + IDL)

Where does Replicache's mutation queue sit?

Each pending mutation is identified by a monotonically increasing `mutationID` (`push.ts:37`), and they are pushed in `mutationID` order (`push.ts:135-137` `// Commit.pending gave us commits in head-first order; the bindings // want tail first (in mutation id order). pending.reverse();`). But:

- A later mutation **cannot reference an earlier one's server-side result**. The push payload (`MutationV1`) carries only `{id, name, args, timestamp, clientID}` — no result references, no promise IDs.
- Locally, a later mutation *can* observe an earlier one's effect because it runs against the cumulative main-head state. So they form a **local-state dependency chain via the DAG**, but each one fully commits before the next begins.
- The server gets a flat list. It executes them as a linearized log against its own state. There is no "use mutation 7's result as an arg to mutation 8."

So this is **not pipelining** (no result references on the wire). It's **not await-only with generator batching** either (no generator; no batched effect set). It's closer to a **sequenced command log** where each command names a function and provides JSON args.

Proposed new axis value: **"named log of (function-name, JSON-args) pairs, sequenced by sender ID, dependent only through shared state."** This is the SQL-replication / event-sourcing pattern, sitting *below* the pipelined corner because no value-level dataflow crosses the wire — only the read/write effects of running named code do.

This is a fourth distinct datapoint, not a refinement of the existing three.

### B. Message-send triangle test

The cross-cutting framing: Smalltalk (receiver exists now), Cap'n Proto (receiver will exist), reactive graphs (receiver exists across many firings).

Replicache's mutation send is interesting because the receiver — the **server-side mutator function with the same name** — is *always already there*. So at first glance it's Smalltalk-shaped. But:

- The send is not addressed at an *object identity* (no proxy reference); it's addressed at a **named function in a global registry**. This is closer to a remote procedure call than message-send.
- The send is *durable*: it lives in IndexedDB across reloads and gets retried on reconnect.
- The send is *replayable*: the same record gets executed twice (client + server), and possibly more if the client rebases multiple times before push succeeds.

I'd argue Replicache sits **outside the triangle** rather than at a corner: it is a **logged, durable, by-name, replayable send**. The "receiver-existence-state" axis isn't the load-bearing distinction here — durability and replayability are. If you forced it onto the triangle, "Smalltalk corner" is closest, but you lose the most interesting feature (replay).

Possible reframing: the triangle may need a fourth axis ("replay cardinality": once / never / unbounded) or to be replaced by a small grid (receiver-existence × execution-cardinality).

### C. "Pipelining IS reactive graphs that fire once" framing

The framing: pipelined chains and reactive graphs are the same shape distinguished by firing cardinality.

Replicache breaks the framing **cleanly** if you take it at face value, but illuminates it from a different angle.

- The **mutation log** is closer to a one-shot pipelined chain in shape: each mutation is a node, edges are "happens-before-in-the-log," fires-once-and-discarded.
- The **subscription graph** is a continuous reactive graph: same dependency-tracking pattern, fires forever as the DAG advances.
- These are *different artifacts in the same system*, not two views of one thing.

But there's something subtle: a single mutation fires the subscription graph **twice** — once on optimistic commit (`replicache-impl.ts:1595`), once on rebase if the patch + replay changes its result (`replicache-impl.ts:788`). So the "mutation as one-shot" actually injects two pulses into the reactive graph. The mutation isn't a node in the reactive graph; it's a **source of pulses** for it.

Refined framing for the research thread: pipelined chains feed reactive graphs the way actions feed signals. They aren't the same shape — they're **producer and consumer of pulses**, with the pipelined chain being the durable, retriable side and the reactive graph being the ephemeral, fan-out side.

### D. Speculative-state isolation axis

Values were: *none* / *per-action overlay* / *per-transition tree* / *versioned everywhere*.

Replicache is **closest to "versioned everywhere"** but with a specific shape worth naming:

- The DAG is genuinely a versioned tree of B-tree snapshots. Every commit (mutation, rebase step, sync) creates a new immutable snapshot.
- But the application can only observe **two named heads**: the main head (cumulative optimistic state) and, transiently during pull, the sync head (which is internal — only the engine sees it until heads swap).
- There is no "preview-this-mutation" branch the application can open. Speculative isolation is *between the main and sync heads only*, not arbitrary.

So this is **"two-head versioned"** or **"git-with-exactly-two-named-branches."** Strictly stronger than "per-transition tree" because the underlying machinery would support arbitrary branches, but the user-facing model exposes only the pair (main, sync). The "preview / what-if" scenario (S8) is **not directly supported** — you'd have to fake it with a sentinel key in the main view.

This is a useful intermediate value for the axis: **"versioned engine, fixed-cardinality observable branches."**

---

## What pulse can learn from Replicache

- **The "register named function, send (name, args)" abstraction is genuinely simpler than typed RPC** and gets you replay for free. Pulse's effect/action model could express durable retried work as "named handler + JSON args" without needing a structured Effect ADT — at the cost of losing type-level composition of effects.
- **Snapshot isolation per transaction with a separate replay branch** is the cleanest model for "optimistic vs committed" pulse has seen across the dives so far. The named-head pattern is easier to reason about than per-action overlays because there are exactly two branches the application can possibly observe.
- **Read-set-tracked subscriptions over a key-value store** is a precedent for pulse's reactive integration when the underlying state is a cache. The crucial point: subscriptions track *what keys the body read* (not "what was returned"), and re-run only when those keys' values change. This is the same trick Solid signals use, but applied to a string-keyed store.
- **The `reason: 'initial' | 'rebase' | 'authoriative'` field on the transaction** is a tiny but powerful primitive: it lets the same function distinguish "first try" from "replay" without separating into two functions. Pulse's transitions could carry an analogous tag.
- **There is no per-operation cancellation.** This is a deliberate design choice, not a missing feature: a mutation in the log can't be canceled because the server may have already executed it. Pulse should think about whether its transitions have the same property — once dispatched, are they cancellable, or only retractable via a compensating transition?

---

## Open questions

- **What happens if a mutator throws during replay?** The code at `replicache-impl.ts:795-815` doesn't show an explicit catch around the rebase loop. Does the entire pull abort? Does the engine retry? Not verified — would need to read `rebaseMutationAndCommit` source and a few tests.
- **Are server-acknowledged mutations dropped purely by `lastMutationID` advancement**, or is there an explicit garbage-collection step on the dag of pending commits? The `pull.ts` flow swaps heads to a new snapshot; older commits become unreachable. Whether they're collected eagerly or by background GC isn't covered here.
- **How does Replicache handle the case where the *server* re-orders mutations from multiple clients?** Linearization happens server-side, but the docs don't show what guarantees the server gives about ordering across `clientID`s. Probably "server's choice"; not verified.
- **Does `experimentalPendingMutations()` provide enough surface to build a true cancellation primitive?** It returns `{id, name, args, clientID}[]` — you can *see* them but not *remove* them. Worth checking if there's an internal API.
- **The relationship to Zero.** The `#zero?.advance(...)`, `#zero?.trackMutation()`, `#zero?.rejectMutation(...)` hooks in `replicache-impl.ts` suggest Zero rides on top of Replicache as a query/mutation tracker. Out of scope here but flagged: Zero is where Rocicorp is going, and the hooks show its integration model is "Replicache is the storage engine; Zero is the query/mutation lifecycle layer." Not verified — read Zero docs separately before quoting.
- **Reflect / "Transactional Conflict Resolution".** The blog phrase is great but is about Reflect specifically. Whether Replicache's docs use the same terminology in a primary source needs cross-checking.

---

## Cross-references

- **Other deep-dives this connects to:**
  - [`capnproto-e-pipelining.md`](./capnproto-e-pipelining.md) (session 5) — direct contrast on the dependent-dispatch axis. Cap'n Proto wires *value-level* dataflow across the network ("answer-position references" in the wire protocol); Replicache wires only *named function calls + JSON args*. Both send work across the wire to be dispatched somewhere else, but Cap'n Proto's eager-pipelining of dependent calls has no Replicache analog.
  - [`solid-2x.md`](./solid-2x.md) (session 7) — Solid's `action(function*) { yield ... }` is the closest local-only analog to Replicache's mutation log: both describe a sequence of dependent state operations to a runtime. Solid's runtime is local-only; Replicache's runtime is split (client + server). The mutation log in Replicache plays a role structurally similar to the action's iterator in Solid: an ordered sequence of dependent operations to be replayed.
  - [`react-modern.md`](./react-modern.md) (session 6) — React's `useOptimistic` overlay is per-action; Replicache's optimistic state is per-mutation in a versioned DAG. React commits in the same render as the action completes; Replicache commits as an explicit head swap on pull. Functionally similar; mechanically different.
  - [`algebraic-effects.md`](./algebraic-effects.md) (session 3) — Replicache's mutators are encoded handlers in the "re-execution" camp: the server-side mutator is a separately-installed handler for the same operation name. The `reason: 'initial' | 'rebase' | 'authoriative'` tag is essentially "which handler context am I in" — a poor man's effect-handler discrimination.
  - [`effect-ts.md`](./effect-ts.md) (session 2) — effect-ts's `Effect<A, E, R>` is a typed value carrying types of error and required services; Replicache's mutation is an untyped (name, args) pair. The trade-off: Replicache loses compile-time effect typing in exchange for trivial serialization. effect-ts can't easily ship its effects over the wire; Replicache trivially can.

- **Taxonomy axes this dive informed:**
  - **Dependent-dispatch capability:** Replicache is a *fourth distinct value* — "named log of (function-name, JSON-args) pairs, sequenced by sender ID, dependent only through shared state" — not a refinement of the existing three. **The axis can be promoted from candidate to confirmed after this dive** (four distinct, well-evidenced values).
  - **Conflict-handling policy:** the prior 🟡 cell ("last-write-wins (cache invalidation)") was a mischaracterization; corrected to **server-linearized re-execution of named mutators**. No LWW at the storage layer.
  - **Cancellation discipline:** sharpened — exactly one lifecycle-scoped `AbortController` per instance; no per-mutation cancellation. Pulse should note this as a *design commitment* (mutations in a log can't be cancelled because the server may have already executed them), not a missing feature.
  - **Speculative-state isolation:** suggests refining the axis with a new intermediate value, **"versioned engine, fixed-cardinality observable branches."** Strictly stronger than "per-transition tree" because the underlying machinery would support arbitrary branches, but the user-facing model exposes only two (main, sync). React's WIP-tree is also two-branch but invisible; Replicache's branches are persistent and explicit.
  - **Async representation:** "named-callable abstraction where the client and server hold separate implementations of the same name" is a coherent value distinct from "typed value" (effect-ts) or "procedure with throw-protocol" (Solid/pulse). The wire form is `(name, args)`, not a function body.

- **Scenarios this dive addressed:**
  - **S1 (like/unlike race):** yes-canonically — mutations are server-linearized; the second mutator execution gets to do anything (skip, override, merge).
  - **S2 (auto-save vs explicit save):** yes — both are mutations; ordering enforced by client mutationID; server replays in order.
  - **S3 (multi-step server flow with partial failure):** partial — each mutator is atomic, but cross-mutator atomicity isn't provided. Composition by sequencing only.
  - **S4 (concurrent independent flows):** yes — each mutation is its own commit; subscription graph fires independently for each.
  - **S5 (cross-transaction read):** **yes-canonically** — the main vs sync head pattern IS cross-transaction snapshot isolation. UI reads main head while engine works on sync head; commit is a head swap.
  - **S6 (user-cancellable flow):** no — no per-mutation cancellation by design (server may have executed).
  - **S7 (optimistic reconciliation):** yes-canonically — this is literally the design center of Replicache.
  - **S8 (preview / what-if):** partial — the engine supports arbitrary branches but the public API exposes only the (main, sync) pair. Could be hacked via sentinel keys.

- **Cross-cutting threads this dive tested:**
  - **Message-send triangle:** Replicache **sits outside the triangle**, not at any corner. Sharpening of the framing recommended: replace the triangle with a small grid (receiver-existence × execution-cardinality).
  - **"Pipelining IS reactive graphs that fire once":** refined — mutation log and subscription graph are *different artifacts in one system*, related as **producer and consumer of pulses**, not the same shape. The original framing was too unifying.

---

## Notes / aside

- **Provenance correction to prior 🟡 row.** The "last-write-wins (cache invalidation)" cell was a mischaracterization. There's no LWW at the storage layer — there's *server-linearized re-execution of mutator code*, which can implement LWW, CRDT-like behavior, validation rejection, or no-op, depending on what the mutator does. The cell should say **"server-linearized replay (policy in user code)."**
- **The legacy repo trap.** `github.com/rocicorp/replicache` (pushed 2022) is now just a README pointing readers elsewhere. The current source is `rocicorp/mono/packages/replicache`. Both URLs respond to `gh api`, but only one has real code. Worth a CONTEXT.md note for future dives.
- **Terminology audit.** Replicache docs use "rewinds" colloquially rather than "rebase" — the code uses `rebaseMutationAndCommit`. Both terms are accurate but the source's "rebase" is the load-bearing one. The pull / push split is symmetric: push sends `MutationV1[]`, pull receives `{cookie, patch, lastMutationIDChanges}`.
- **The B-tree.** `packages/replicache/src/btree/` (not deep-dived) is the on-disk format. The Client View is "an ordered map of key-value pairs" (docs) — ordering matters because `scan` is a primary read primitive and subscriptions can depend on prefix ranges.
- **Methodology aside.** The deferred WebFetch tool worked well for docs but truncated some details (the WriteTransaction page rendered abbreviated; the `db-isolation` URL 404'd). For exact API shapes I went directly to the GitHub source — much higher signal. Recommend future sync-engine dives default to `gh api` + raw downloads for the engine source and reserve WebFetch for design rationale / blog posts.

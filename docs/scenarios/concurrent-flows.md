# Concurrent-Flow Scenarios

A working document of concrete problem-space scenarios for the "concurrent flows / transactions / shadow writes" design space (see `README.md` §2.13 for the comparative analysis).

**Purpose:** build understanding of what we'd be solving, and serve as a checklist when evaluating any proposed implementation. Each scenario should be answerable as:

> "Does this design solve scenario N? If yes, how? If no, document the limitation."

Scenarios are deliberately small and concrete — pick the simplest version of each pain that still exhibits the structural issue. Variants and edge cases live as sub-bullets.

---

## Scenario 1 — Like/unlike race (optimistic UI with overlapping requests)

**Setup:**

```ts
const [liked, setLiked] = signal(false)
const [count, setCount] = signal(42)

async function toggleLike(want: boolean) { … }
```

User clicks "like" → 200ms later clicks "unlike." Server takes ~500ms per request. Both requests are in flight concurrently.

**Without a transaction primitive (manual prior-state capture):**

```ts
async function toggleLike(want: boolean) {
  const priorLiked = liked()
  const priorCount = count()
  setLiked(want)
  setCount(want ? count() + 1 : count() - 1)
  try {
    await api.setLike(postId, want)
  } catch {
    setLiked(priorLiked)
    setCount(priorCount)
  }
}
```

**Problem:** when the second `toggleLike(false)` captures `priorLiked = liked()`, it reads the FIRST action's optimistic write as if it were truth. If the first action then fails and tries to roll back, it restores values that may have already been overwritten by the second action. If the second action fails, its rollback restores the first's optimistic state — which may or may not match the server's actual truth.

The bug isn't in the happy path; it's in the rollback paths where actions interleave with each other's reverts. Full trace tables in `README.md` §2.13.

**What "correct" means:**

- Each action's optimistic writes are visible to the UI immediately.
- The UI consistently shows the LATEST action's overlay (user's most recent intent).
- On commit, the action's writes become the new committed truth.
- On abort, the action's writes vanish completely; sibling actions are undisturbed.
- A failed action never silently leaves the UI in a state that contradicts the server.

**Capabilities exercised:** snapshot isolation (1), atomic commit (2), optimistic-with-revert (4), cancellation/abort (6).

**Variants:**

- Server processes requests out of order.
- One action's request completes between another's start and end.
- User triggers 3+ rapid toggles.
- Same flow but on a non-binary signal (e.g. quantity stepper).

---

## Scenario 2 — Auto-save vs explicit save

**Setup:** A form editor. A background timer auto-saves draft state every 5s. The user can also click "Save" explicitly.

```ts
const [draftBody, setDraftBody] = signal("")
const [savedAt, setSavedAt] = signal<Date | null>(null)

// Auto-save (in background)
setInterval(async () => {
  const body = draftBody()
  await api.saveDraft({ body })
  setSavedAt(new Date())
}, 5000)

// Explicit save (on user click)
async function explicitSave() {
  const body = draftBody()
  await api.publish({ body })
  setSavedAt(new Date())
}
```

**Problem cases:**

- User starts typing → auto-save fires with the current `draftBody()` → server returns, sets `savedAt` → but the user has typed MORE since the request started. The "savedAt" timestamp now misleads: it claims "saved at HH:MM" but the current `draftBody` has unsaved characters past that point.
- User clicks explicit Save while auto-save is in flight. Both requests run; both update `savedAt`. Last-write-wins on `savedAt` may report the auto-save's timestamp even though publish committed later (or vice versa).
- Network drops mid-auto-save; the timer fires again; now two saves are racing with potentially stale snapshots.

**What "correct" means:**

- An in-flight save captures a snapshot of the body at the moment the request started.
- `savedAt` reflects the save whose body matches the current `draftBody`, not just the last-completing request.
- A user-initiated explicit save and a background auto-save don't clobber each other.
- If the user edits during a save, the save isn't reflected as "current."

**Capabilities exercised:** snapshot isolation (1), atomic commit (2), entanglement-shape (which save "won" depends on order + scope), maybe some form of stale-detection.

**Notes:**

- This is harder than scenario 1: it's not just optimistic UI; it's about preserving a *correspondence* between in-flight server work and the user-visible state at the time the work started.
- Could also be solved by tagging server requests with a content hash; less interesting for our problem-space exploration.

---

## Scenario 3 — Multi-step server flow with partial failure

**Setup:** "Convert this draft to a published post" — a multi-step server flow:

1. Upload draft images to CDN (sets `imageUrls` signal with returned URLs).
2. Generate slug from title (call server, set `slug` signal).
3. Submit publish request with `imageUrls` + `slug`.

```ts
async function publish() {
  setStatus("uploading-images")
  const imageUrls = await api.uploadImages(draftImages())
  setImageUrls(imageUrls)

  setStatus("generating-slug")
  const slug = await api.generateSlug(draftTitle())
  setSlug(slug)

  setStatus("publishing")
  await api.publish({ imageUrls: imageUrls, slug: slug })
  setStatus("done")
}
```

**Problem cases:**

- Step 3 (publish) fails after steps 1+2 succeeded. The signals `imageUrls` and `slug` are now set, but the post wasn't actually published. The next render shows the post AS IF it's published (because the signals are populated).
- Step 2 fails after step 1 succeeded. `imageUrls` is populated but the draft was never converted — orphan state.
- User cancels mid-flow (e.g. navigates away). Currently the in-flight Promise can't be cleanly cancelled; if it resolves later, the signal writes still fire.

**What "correct" means:**

- The entire flow is atomic: either ALL signal writes land (success), or NONE do (failure / cancel).
- Partial-success state never observable to the rest of the app.
- Cancellation is a first-class operation that discards in-flight writes.

**Capabilities exercised:** snapshot isolation (1), atomic commit across multi-step (2), cancellation/abort (6).

**Notes:**

- The pulse-current workaround would be local variables for the intermediate values, only writing signals at the end: `const i = await ...; const s = await ...; await ...; setImageUrls(i); setSlug(s)`. Works for this exact case but: (a) you lose intermediate-state visibility (e.g. status indicators reading from a "current step" signal), (b) doesn't help if any intermediate value is read by another part of the UI during the flow, (c) doesn't help cancellation.

---

## Scenario 4 — Concurrent independent flows on separate data

**Setup:** Two unrelated actions firing simultaneously on different parts of the app:

- Action A: "follow user" → sets `followingUserIds`, awaits server.
- Action B: "save post for later" → sets `savedPostIds`, awaits server.

The two actions touch disjoint signals.

**Problem:** there isn't really a problem here — they don't interact. This scenario exists as a NEGATIVE test: any transaction primitive must NOT introduce coordination between flows that don't share state.

**What "correct" means:**

- Each action's success/failure/cancellation has zero impact on the other.
- No artificial entanglement just because both happen to be in-flight.
- `<Loading>` boundaries (if any) for each action behave independently.

**Capabilities exercised:** isolation as separation — disjoint transactions don't interfere.

**Notes:**

- This is the "don't make everything entangle" guardrail. Solid 2.x's lanes need explicit rules ("entangle only on cross-write") to avoid this; pulse's transaction primitive can default to "transactions are independent unless they explicitly read each other's overlays."

---

## Scenario 5 — Cross-transaction read (auto-entanglement)

**Setup:** Two flows whose data DOES overlap:

- Flow A: "update profile bio" → reads `name`, writes `bio`. Server awaits.
- Flow B: "rename profile" → writes `name`. Server awaits.

Flow A starts → reads `name` for its server payload → meanwhile Flow B starts and writes `name` → A's server arrives, payload had OLD `name`.

**Problem:** A's server-side write uses the old `name` value; B's server-side write uses the new. Depending on server processing order, the final committed state might have B's `name` change BUT A's payload references the old name (e.g. "bio sent with old display name embedded in it").

**What "correct" means** (one possible answer; depends on policy):

- If A and B touch overlapping data, A should either:
  - (i) See B's write as it happens (transparent overlay reads — but this changes A's payload mid-flight, which is even weirder), OR
  - (ii) Block A's commit until B commits (auto-entanglement), so A's payload is recomputed against B's new state, OR
  - (iii) Treat A as stale and force the user to retry.

Solid 2.x picks (ii) via lane-entanglement. A reading a value B is mid-writing entangles their lanes; A blocks on B.

**Capabilities exercised:** auto-entanglement (3) via dep-graph walks.

**Notes:**

- Pulse's pending registry already has the structural primitive (`upstream` chain with transitive walks). A transaction reads tagged with the writer-transaction's identity could link the reader-transaction's pending to the writer-transaction's pending.
- Open design question: what's the default? Strict isolation (A NEVER sees B's writes, both eventually commit independently — last-write-wins on conflict)? Or entanglement (A waits for B)? Each has its place.
- The Solid 2.x default is entanglement. The Pulse default could be strict isolation with opt-in entanglement via something like `tx.entangle(otherTx)`.

---

## Scenario 6 — User-cancellable flow

**Setup:** Long-running action (e.g. uploading a large file). User clicks "Cancel" mid-upload.

```ts
async function uploadAndAttach(file: File) {
  setStatus("uploading")
  const url = await api.upload(file)  // 30s
  setAttachedUrl(url)
  setStatus("attached")
}
```

User clicks Cancel after 5s.

**Problem cases:**

- Even if we abort the request, the in-flight Promise can still settle if cancellation isn't propagated to the server-side call. If it settles, `setAttachedUrl(url)` runs — the file is attached after the user said cancel.
- If we DON'T attempt to roll back: any signal writes that already happened before the await (`setStatus("uploading")`) are still set.

**What "correct" means:**

- Cancellation discards ALL pending writes from the flow, including ones that already executed locally.
- Even if a stale Promise eventually settles, its writes don't land.

**Capabilities exercised:** cancellation/abort (6) — the abort needs to be reachable BOTH from the user gesture AND from "drop any future writes from this flow."

**Notes:**

- The implementation needs the transaction to capture which signals are being written, AND to provide a way to detect "I am still alive" at the point of each write (so post-abort settles are no-ops).
- Solid 2.x's `action(function* () { … })` handles this via the transition being abortable; pulse's transaction would expose `tx.abort()` and the tx-scoped setters would check `tx.disposed` before writing.

---

## Scenario 7 — Optimistic UI reconciliation with server-returned data

**Setup:** "Add comment" — optimistic insertion of the comment into a list, then server returns the saved comment with a real ID, timestamp, etc.

```ts
async function postComment(text: string) {
  const optimisticId = "temp-" + Math.random()
  setComments(c => [...c, { id: optimisticId, text, author: currentUser(), pending: true }])

  try {
    const saved = await api.postComment(text)
    setComments(c => c.map(item => item.id === optimisticId ? saved : item))
  } catch {
    setComments(c => c.filter(item => item.id !== optimisticId))
  }
}
```

**Problem cases:**

- A refetch of the comments list happens between the optimistic insert and the server response. The refetch returns a list WITHOUT the optimistic comment (because it's not server-side yet). The refetch's `setComments` clobbers the optimistic. UI flickers: comment appears → disappears (refetch) → reappears (server response).
- Two simultaneous "add comment" actions: each inserts an optimistic; refetch happens after both; both optimistics disappear; then both server responses land in some order.

**What "correct" means:**

- Optimistic writes survive a refetch. The refetch sets "committed truth"; optimistic remains "pending overlay" on top.
- When the action's server response arrives with the real comment, the optimistic is replaced by the real one — atomically, no flicker.
- Failed action: optimistic disappears cleanly; no manual filter.

**Capabilities exercised:** snapshot isolation (1) where optimistic overlay survives committed-state changes, optimistic-with-revert (4), reconciliation policy (when overlay matches a real server item, replace; when action commits with replacement, do it atomically).

**Notes:**

- This is what Solid 2.x's `createOptimisticStore` is designed for. The reconciliation is automatic because the optimistic store knows which keys are optimistic and which are server-derived.
- Pulse would need: optimistic writes that are scoped to a transaction (so refetch on the underlying signal doesn't clobber them) + a way to express "when the tx commits with `saved`, replace the optimistic item by id."

---

## Scenario 8 — Preview / what-if mode (NOT a transaction, but related)

**Setup:** User is editing settings. There's a "Preview" button that shows what the dashboard would look like with the new settings, without committing them yet. "Apply" commits; "Cancel" discards.

**What "correct" means:**

- During preview, the dashboard renders with the candidate settings instead of the committed ones.
- The candidate settings are NOT visible to anything outside the preview scope (e.g. analytics shouldn't fire as if settings changed).
- Apply makes the candidate the new committed truth. Cancel discards.

**Capabilities exercised:** snapshot isolation (1) used DELIBERATELY for scoped reads, not just for in-flight async.

**Notes:**

- This is a different mode of using the same primitive. Instead of "I'm doing async work; show optimistic until it lands," it's "I'm doing UI exploration; show overlay until user decides." Both want the same primitive (scoped overlay), different lifecycle (Promise settle vs explicit Apply/Cancel).
- Not a top-priority scenario but a useful one for stress-testing the design: does the primitive handle non-async use cases?

---

## Open policy questions

These don't belong to a single scenario; they're choices any design needs to specify.

### Q1: Overlay read semantics

When transaction A reads a signal that has overlays from A AND B (sibling tx), what value does A see?

- (a) A sees only its own overlay on top of committed. B's overlay invisible to A.
- (b) A sees committed → B's overlay → A's overlay (A wins where it has set; B otherwise; committed otherwise).
- (c) Last-write-wins by timestamp regardless of transaction.

Scenarios distinguishing these: 1 (rapid click), 5 (cross-tx read), 7 (optimistic + refetch).

### Q2: Outside-tx read semantics (UI default)

When the UI reads a signal, with multiple active overlays, what does it show?

- (a) Just committed truth. Optimistic invisible. (Bad UX for optimistic; useful for "trusted reads only" — e.g. analytics.)
- (b) Latest active overlay (LIFO). User sees their most recent action's effect.
- (c) Some merge policy.

Scenario 1 walked through with (b) — user sees latest action's effect.

### Q3: Commit ordering when multiple transactions complete

If A and B both touch signal S and both commit, in what order do their overlays promote? Does it matter?

- Independent transactions (Scenario 4): no shared state, doesn't matter.
- Cross-writing transactions (Scenario 5): commit order matters; need policy.

### Q4: Default entanglement behavior

When A reads a value B is mid-writing:

- (a) Block A on B (auto-entangle — Solid 2.x default).
- (b) A sees committed value (ignores B's overlay).
- (c) A sees B's overlay (treats B's write as visible).
- (d) Explicit opt-in: A must call `tx.entangleWith(B)`.
- (e) Retry A on B's commit (STM-style — A re-runs from start against B's new committed view).

Scenario 5 explicitly tests this. See Prior art § effect-ts STM for tradeoffs of (e).

### Q5: Lifecycle of overlays after commit/abort

After `tx.commit()` or `tx.abort()`, are the overlays GC'd immediately? Are subscribers re-notified?

- Notification: if any sibling tx was reading a value that was in A's overlay, those reads need to invalidate when A commits/aborts.
- GC: overlays held by signal? By transaction? Cleanup on tx disposal.

---

## Prior art

### effect-ts (Effect, `@effect/io`, `@effect/stm`)

Effect-ts has done substantial work in this space. Worth knowing what it solves and how its model maps to (or diverges from) what we're sketching.

**STM (Software Transactional Memory) — `Effect.gen` over `TRef`:**

- A `TRef<A>` is a transactional cell. Reads/writes inside an `STM.commit(...)` block are tracked.
- On commit, the runtime checks: did any TRef I READ get modified by another committed transaction between my start and my commit? If yes → **retry from the top of the block** with the fresh committed view; if no → commit my writes atomically.
- This is Q4 option **(e) — retry-on-conflict**, distinct from (a) block-and-wait. Cleaner in that there's no entanglement graph and no deadlock surface; the trade-off is that everything inside the STM block must be replayable.
- Server requests can't naturally retry (they have side effects); STM blocks typically contain only TRef reads/writes, with server work outside the STM block (orchestrated by the surrounding `Effect`).

Maps directly onto: scenario 1 (retry resolves the optimistic race correctly), scenario 5 (conflict → retry instead of block), scenario 7 (the optimistic block reads server result + commits atomically with replacement).

Doesn't directly handle: scenario 2 (in-flight server work needing snapshot correspondence — STM doesn't have a notion of "snapshot for an async call's payload"), scenario 3 (multi-step with side effects — these go in the surrounding `Effect`, not in STM).

**Fibers + structured interruption:**

- A `Fiber` is a lightweight concurrent unit. `Fiber.interrupt(fiber)` signals interruption; the next `yield` checkpoint observes it; finalizers (scoped via `Effect.acquireRelease`) run; post-interrupt operations are no-ops by construction.
- Maps onto scenario 6 (user-cancellable flow) very cleanly: cancellation is interruption; the structured-concurrency model guarantees post-cancel operations don't fire.

**Scope (acquire-release):**

- Bracketed resource management with finalizers. Maps onto pulse's owner + onCleanup, with stronger guarantees: every acquired resource has a matching release that fires even on interruption / exception.
- Effect-ts's `Scope` is more disciplined; pulse's owner is more permissive (cleanups can be added at any point).

**Effect.gen with `yield*`:**

- `Effect.gen(function* () { const a = yield* fetchA; const b = yield* fetchB(a); return [a, b] })` is structurally the same shape as pulse's `computed(function* () { const a = yield* read(asyncA); const b = yield* read(asyncB(a)); return [a, b] })`. Both treat the body as a *description* of sequential async, driven by a runtime that handles suspension/resumption.
- The difference: effect-ts's `yield*` always yields an `Effect<R,E,A>` (typed description of work); pulse's `yield* read(x)` yields a signal accessor (reactive read with suspension). Same syntactic shape, different semantics under the hood.

**`SubscriptionRef`:**

- A `Ref<A>` with a `Stream` of changes. Signal-like — value + subscribers. Comparable to pulse's signal except integration with reactivity goes through `Stream`-typed effects, not direct UI bindings.

### Where the models genuinely diverge

- **Programming model commitment.** Effect-ts is "your whole async layer is `Effect<R, E, A>`" — you write `Effect`s instead of async functions, with typed errors and typed dependencies. Pulse keeps async functions native and adds reactive primitives on top; `use()` is the only marker. Pulse is a much lower buy-in for an existing codebase; effect-ts is a different programming style.
- **Retry vs block on conflict.** STM retries; Solid 2.x lanes block-and-entangle. Pulse hasn't picked; this is Q4. STM's retry assumes replayability — natural for in-memory `TRef` work, awkward for server calls. Pulse's transaction primitive could go either way: retry-on-conflict (STM-style) for purely local transactions, block-or-explicit-entanglement for transactions containing server work.
- **Fiber scheduler vs reactive graph.** Effect-ts has a fiber runtime separate from the host's microtask scheduler — fibers are interpreted, scheduled, parked, resumed. Pulse uses the reactive graph as its "interpreter" — there's no fiber concept, just signals and effects driven by the host scheduler.
- **Error typing.** Effect's `E` parameter forces handling errors at the type level. Pulse propagates errors via `catchError` (owner-walking handlers) — looser but more familiar.

### What we should consider borrowing

- **Retry-on-conflict as one answer to Q4** — should be enumerated alongside block/explicit/never. Useful for purely-local transactions (preview mode, batched signal updates, scenario 8).
- **Structured interruption semantics** — effect-ts's "interruption propagates through yield checkpoints; finalizers always run; post-interrupt ops are no-ops" is a clean answer to scenario 6. Pulse's transaction primitive could adopt the same structural guarantee: tx.disposed checks on every tx-scoped write, finalizers on tx itself.
- **Scope discipline** — pulse's owner + onCleanup is more permissive than effect-ts's Scope. For transactions, the more disciplined model (every tx owns a scope; commit/abort runs finalizers) is probably right.
- **Stream interop** — if pulse ever wants to integrate with effect-ts apps, exposing signals as `SubscriptionRef`-compatible streams is a low-touch bridge.

### What we should NOT borrow

- **The programming-model-everything stance.** Pulse's value is being a small reactive layer on top of normal async functions. Becoming "effect-ts but for UI" is a different project.
- **STM's retry model as the default.** For UI transactions that contain server calls, retry semantics surprise users. Block/explicit-entanglement is friendlier as a default; retry can be an opt-in mode for purely-local transactions.

---

## How to use this document

When evaluating a proposed implementation:

1. Walk through each scenario above with the proposed API.
2. For each capability column in scenarios 1–7, mark: SOLVES / PARTIAL / NOT-SOLVED.
3. For scenarios 4 and 8, mark whether the implementation introduces unwanted coordination or correctly handles non-async use.
4. Resolve each open policy question (Q1–Q5) explicitly. Document the choice.
5. Add new scenarios when real apps surface new pain.

A design that solves all scenarios in §1–§7 with policy choices recorded in Q1–Q5 is a complete answer. Partial solutions are fine if the limitations are documented.

---

## Broader prior art

The reactive-framework lineage (Solid, React, MobX, etc.) is one slice of a much wider design space. This section surveys traditions outside that lineage that have addressed pieces of our problem. Each entry cross-references our scenarios (S1–S8) and policy questions (Q1–Q5) to keep the survey practical.

### Database systems

Decades-old, battle-tested treatments of "concurrent transactions over shared state." Vocabulary and failure-mode catalogues are far more developed than in the UI world.

**MVCC / Snapshot Isolation (Postgres, Oracle, InnoDB, SQL Server snapshot mode)**

- Mechanism: each row carries multiple versions tagged with the transaction that created it (xmin/xmax in Postgres). A transaction reads the snapshot of the database "as of" its start timestamp. Writes create new versions. On commit, versions become visible to transactions started after the commit timestamp.
- Maps to: **S1 (like/unlike race), S5 (cross-tx read), S7 (optimistic + refetch)** directly. The overlay-and-commit primitive we sketched is essentially per-signal MVCC.
- Answers to our Q's:
  - **Q1 (overlay read inside tx):** SI says a tx sees its own writes + committed versions as-of start; no sibling-tx in-flight writes. So Q1 = option (a) "A sees only its own overlay on top of committed."
  - **Q2 (outside-tx read):** committed truth only.
  - **Q4 (entanglement):** SI doesn't entangle by default — it detects conflicts at commit time (see SSI below).
- What we can learn:
  - Failure modes are well-named: **write skew** (two txs read the same data, each writes a different row, both commit, invariant violated — both saw consistent snapshots but together created inconsistency), **lost update** (concurrent updates of the same row; one overwrites the other), **phantom reads** (range query returns different rows on re-read).
  - Postgres's `SELECT FOR UPDATE` is "promote this read to entanglement" — the row is locked at read time, conflicting writers block. Direct analogue to a hypothetical pulse `tx.lock(signal)`.
- Failure modes to inherit / guard against: write skew is the most subtle. In our scenario terms: tx A reads `count_doctors_on_call()`, sees 2, decides to take itself off-call. tx B does the same. Both commit. Now 0 doctors on call, invariant broken. SI alone doesn't prevent this; SSI does.

**Serializable Snapshot Isolation (SSI, Postgres 9.1+)**

- Mechanism: SI + read-write dependency tracking. At commit, the runtime checks if committing this tx would create a dependency cycle with concurrent txs; if so, abort + retry.
- Answers to our Q4: option (e) "retry on conflict" with a more refined notion of "conflict" than naive read/write overlap — it's specifically about cycles in the dependency graph.
- What we can learn: serializability is more expensive than naive SI; for UI transactions, SI is probably fine (write skew is rare in UI contexts, and developers can opt into explicit locking when it matters).

**Two-Phase Locking (2PL) — pessimistic concurrency control**

- Mechanism: locks acquired on read/write, released only at commit/abort. Shared locks (reads) compatible; exclusive locks (writes) not. Strict 2PL = locks held until commit/abort.
- Answers to our Q4: option (a) block-on-entanglement, but with the lock acquired at READ time, not write time.
- What we can learn: lock-based concurrency has well-known deadlock issues (cycle in the wait-for graph). UI transactions are typically short-lived, so deadlock risk is real if naive 2PL is adopted. Mostly a "don't do this" lesson.

**Optimistic Concurrency Control with version vectors**

- Mechanism: each record has a version number. Reads capture the version; writes check the version hasn't changed before committing; otherwise abort + caller-retries.
- Answers to our Q4: option (e) but caller-driven retry. The user/framework decides what to do on conflict (retry the action, surface to UI, etc.).
- Maps to: REST APIs with `If-Match: <etag>` headers do exactly this. Worth considering for the server-side correspondence side of S2.

**Read isolation levels (Read Committed / Repeatable Read / Snapshot / Serializable)**

- A taxonomy worth knowing. Each level forbids specific anomalies (dirty read, non-repeatable read, phantom, write skew).
- Maps to: Q1 + Q2 are essentially "which isolation level does pulse offer." Default for an in-memory UI transaction is probably SI (which forbids dirty/non-repeatable reads + phantoms, allows write skew).

**Vector clocks / Lamport timestamps**

- Mechanism: causality tracking for distributed events. Each node maintains a vector of "what's the latest I've seen from each other node."
- Mostly orthogonal to our problem (we're single-process), but worth knowing for collaborative-editing scenarios (covered later under CRDTs).

### Structured concurrency in languages

A movement in language design (~2018 onward) that treats concurrency as a *lexically scoped* property — child tasks complete (or are cancelled) before their parent scope returns. Inspired by Trio (Python).

**Trio (Python, the original)**

- Mechanism: `async with trio.open_nursery() as nursery: nursery.start_soon(task)` — the `async with` block doesn't exit until all child tasks finish or are cancelled. Cancellation is checkpoint-based (every `await` is a cancellation point).
- Maps to: **S6 (cancellable flow)** as a structural property of the language. Cancellation propagates through every `await` checkpoint; finalizers always run.
- What we can learn: the design rules (cancellation propagation, "no orphaned tasks," lexical scope) are the cleanest articulation of structured concurrency. Article: "Notes on structured concurrency, or: Go statement considered harmful" by Nathaniel J. Smith.

**Kotlin coroutines + CoroutineScope + Job**

- Mechanism: coroutines run in a `CoroutineScope`. The scope owns a `Job`; canceling the job cancels all children. Child exceptions propagate to parent (by default). `SupervisorJob` opts a scope out of child-cancels-parent. `withContext` switches dispatchers cleanly.
- Maps to: **S6 (cancellable flow)** with first-class support; **S3 (multi-step with partial failure)** via supervisor-style scopes that decide which failures cancel siblings.
- What we can learn:
  - The `Job` hierarchy IS a transaction hierarchy. A "transaction" in pulse could be a Job-like value with `cancel()`, child jobs, finalizers.
  - "Structured concurrency" + "cancellation as a first-class signal" + "scope owns the work" = a very disciplined model.
  - Compose's `LaunchedEffect(key)` reruns when key changes, canceling the prior coroutine — a direct analogue of switchMap (see Streams below).

**Swift Structured Concurrency (`TaskGroup`, `async let`, actors)**

- Mechanism: similar to Kotlin / Trio. `Task { ... }` for unstructured; `TaskGroup` for structured; `async let` for "fork this, await it later in scope." Actor isolation prevents data races by mechanism (an actor can only be mutated by one task at a time; cross-actor calls require `await`).
- Maps to: **S4 (independent flows)** via actor isolation — actors are the unit of "this state doesn't get clobbered by others." **S6** via Task cancellation.
- What we can learn:
  - Actor isolation is a strong answer to "two flows shouldn't clobber each other's state" — it makes the isolation a property of the state container, not the calling pattern.
  - `Sendable` types as a static guarantee that cross-task transfer is safe.
  - The "you cannot await inside actor isolation without explicit pop-out" rule prevents reentrancy bugs.

**Go `context.Context`**

- Mechanism: `Context` is passed explicitly to every function that might be cancelable. `ctx.Done()` is a channel that closes on cancellation. `context.WithCancel`, `WithTimeout`, `WithDeadline` derive child contexts. Convention (not language-enforced) is to thread context everywhere.
- Maps to: **S6 (cancellation)**. Less structurally enforced than Trio/Kotlin/Swift but ubiquitous in Go code.
- What we can learn: even without language-level structured concurrency, an *explicit* cancellation handle threaded through async work is enough to make cancellation reliable. The convention-not-mechanism approach has tradeoffs (forgetting to pass ctx is a real bug class).

**Rust async / Tokio (`tokio::select!`, `CancellationToken`, `tokio::spawn`)**

- Mechanism: futures don't run until polled. Dropping a future cancels it (RAII-style cancellation). `tokio::spawn` creates an independent task that survives parent drop unless explicitly aborted. `CancellationToken` for explicit propagation.
- What we can learn:
  - Cancel-by-drop is interesting: a future that's no longer awaited is automatically cancelled. UI analog: a binding that's no longer rendered is automatically not "in flight."
  - The structured/unstructured tension is real — even with the best primitives, leaking a spawned task is easy.

**Erlang/OTP supervision trees**

- Philosophy: "let it crash." Processes are cheap; on failure, a supervisor restarts them according to a strategy (`one_for_one`, `one_for_all`, `rest_for_one`). Errors aren't caught and recovered locally; they're handled at the supervisor level.
- Maps to: an entirely DIFFERENT philosophy of error handling — orthogonal to ours but worth knowing. Instead of "rollback the writes," it's "kill the subsystem, restart it with consistent state."
- What we can learn:
  - Not directly applicable to pulse (UI transactions don't naturally have "process boundaries to restart"), but the principle of "consistent state at start vs heroic effort to recover state in flight" is a useful lens.
  - The hierarchy / supervision-strategy taxonomy gives vocabulary for thinking about scope failure modes.

**F# async workflows**

- Mechanism: `async { let! result = doWork() }` — workflow blocks similar to Effect.gen / Kotlin coroutines but with built-in cancellation tokens. `Async.Start`, `Async.RunSynchronously`.
- What we can learn: same family as the above; F# has been doing this since 2007 (predates most others).

### STM beyond effect-ts

**Haskell GHC STM**

- Mechanism: `STM a` monad. `TVar a` is a transactional variable. `atomically (do ...)` runs an STM block; the runtime tracks reads/writes; on commit conflict, it retries from the top.
- Composability is the headline feature: two `STM` actions can be combined with `orElse` (try the first; if it `retry`s, try the second), and they remain transactional.
- Maps to: scenarios 1, 5, 7. Answers Q4 with retry (option e). Forbids any IO inside the STM block — purity is the precondition for safe retry.
- What we can learn:
  - **`retry` as a composable primitive**: a transaction can voluntarily `retry` (signaling "I want to wait until something I read changes"). This is how STM expresses "block until condition." Could inform a pulse `tx.waitFor(predicate)` primitive.
  - **`orElse` for transaction alternatives**: try this transaction; if it fails or retries, try the alternate. Powerful compositional shape.
  - The purity precondition is harsh but instructive — it tells us *why* STM-retry is awkward for actions containing IO, and where the line is.

**Clojure refs + STM**

- Mechanism: `ref`, `alter`, `commute`, `ensure`. `(dosync (alter r f))` runs in a transaction. `commute` is "this update commutes with other updates of the same ref" — allows higher concurrency. `ensure` is "I want to read this ref but be entangled with its writers."
- Maps to: S5 (cross-tx read) — `ensure` is exactly the explicit-entanglement opt-in (Q4 option d). `commute` for write-only updates that don't need ordering.
- What we can learn:
  - The `commute` distinction is interesting: for monotonic updates (counters, set adds), order doesn't matter; allowing them to run without entanglement reduces conflicts.
  - The `alter` vs `commute` vs `ensure` taxonomy maps onto: "I'm doing a read-modify-write" vs "I'm doing a commutative update" vs "I'm reading but want to be entangled." Three distinct intents the user expresses at the call site.

**Multiverse (JVM STM)**

- Mechanism: similar to GHC STM but for JVM. Notable for its "alpha" / "beta" lock-free implementation work.
- Less directly inspirational; mostly proof that STM is implementable as a library on a mainstream runtime.

### Reactive streams (RxJS family)

Treating async sequences as first-class values with a rich operator vocabulary. *Different* primary abstraction from signals, but worth knowing because the operator names map onto our scenario policies.

**RxJS concurrency operators**

The operators ALL address the "what happens when a new outer event arrives while inner work is in flight" question — exactly S1, S2, S6:

- **`switchMap`**: cancel the prior inner; subscribe to the new one. Maps onto S1 like/unlike: cancel the first request when the second click happens. "Last-write-wins with prior-cancellation."
- **`mergeMap`** (alias `flatMap`): let all inner subscriptions run concurrently. Maps onto S4: independent flows, all proceed.
- **`exhaustMap`**: ignore new outer events while an inner is in flight. Maps onto "submit button" UX — second click while first is processing is dropped.
- **`concatMap`**: queue inner subscriptions; run them serially. Maps onto S3 ordered multi-step.

What we can learn:
- These are **named policies** for "what to do with overlapping work." Our Q4 could be similarly named: `entangle`, `retry`, `replace`, `queue`, `merge`. Instead of a single default, name the choice at the call site:
  ```ts
  transaction({ policy: 'replace' }, async (tx) => { ... })  // switchMap-like
  transaction({ policy: 'exhaust' }, async (tx) => { ... })  // ignore-if-in-flight
  ```
- The fact that RxJS has SEPARATE OPERATORS for each policy (rather than one operator with a config) suggests the policy is fundamental enough to lift into the API name.

**RxJS schedulers**

- `asyncScheduler`, `asapScheduler` (microtask), `queueScheduler` (sync), `animationFrameScheduler`. The operator's scheduler decides WHEN values are delivered.
- Maps to: pulse's `setScheduler(syncScheduler(flush))` for tests. Less directly relevant but parallel infrastructure.

**Subjects (BehaviorSubject, ReplaySubject, AsyncSubject)**

- `Subject`: hot multicast stream. `BehaviorSubject`: hot + holds latest value (signal-like). `ReplaySubject`: hot + replays N latest. `AsyncSubject`: hot + emits only the final value on complete.
- Maps to: pulse's `signal` is essentially a `BehaviorSubject`. Worth knowing for the multicast / replay vocabulary.

### UI state libraries with transaction-shaped APIs

**MobX (`transaction` / `runInAction`)**

- Mechanism: `runInAction(() => { ...several writes... })` batches writes; observers see all changes at once at the end. No rollback; no overlay; just batching.
- Maps to: a SUBSET of S1 — batching multiple writes together — but no isolation between concurrent flows.
- What we can learn: even just batching (without isolation) covers some optimistic UI cases ergonomically. The simpler `runInAction` is a useful baseline before reaching for full transactions.

**Recoil (snapshots)**

- Mechanism: `useRecoilSnapshot` captures the current atom state. `useGotoRecoilSnapshot(snapshot)` restores. Snapshot is a frozen view of the atom graph.
- Maps to: **S8 (preview / what-if mode)** directly. Snapshot capture/restore is exactly the "preview, then apply or cancel" use case.
- What we can learn: a transaction primitive that exposes the same `snapshot()` operation would cover S8 elegantly. Could also be a debug tool — "let me see what state this atom was in 3 transactions ago."

**Jotai (atomic suspense, `loadable`)**

- Mechanism: atoms with `atomWithDefault`, `atomWithStorage`, etc. Async atoms suspend on read; `loadable(atom)` returns `{state: 'loading' | 'hasValue' | 'hasError', ...}` instead of suspending.
- Maps to: similar to Solid 2.x's `latest()` — opt-out of suspension at the read site.
- What we can learn: per-atom opt-in/out of suspension semantics; pulse has this via `use(x)` vs `x()`.

**Zustand (subscribe, transient, slices)**

- Mechanism: simple store with `subscribe()` for transient updates (no re-render). Slices for composition.
- Mostly orthogonal to our problem; useful for "fire-and-forget side effects on state change" without going through full reactivity.

**Valtio (proxy-based + `snapshot`)**

- Mechanism: `proxy({...})` creates a deeply observable proxy. `snapshot(state)` returns an immutable structural copy. Mutations are direct (`state.count++`).
- Maps to: combining direct mutation ergonomics with snapshot capture. Recoil-like time-travel + Mobx-like ergonomics.
- What we can learn: structural snapshots are cheap with structural sharing; could be useful for pulse's transaction-overlay storage (each tx's overlay could be a structural diff from committed).

**Redux + Redux Toolkit + RTK Query**

- Redux: immutable state, dispatched actions, reducers. Optimistic via dispatch-then-revert action pairs.
- RTK Query: server-state caching layer. Optimistic updates via `updateQueryData`. Tag-based invalidation. Polling. Retry policies.
- Maps to: S1 (optimistic), S7 (reconciliation with server), S3 (multi-step via thunks/sagas).
- What we can learn:
  - Tag-based invalidation as a generalization of `refresh()`: actions specify which tags they invalidate; queries specify which tags they provide. Invalidating a tag re-runs the providing queries.
  - Optimistic updates as a typed action pattern (pessimisticUpdate vs optimisticUpdate vs updateQueryData) is a useful taxonomy.
  - `mutation` lifecycle: `onQueryStarted(arg, { dispatch, queryFulfilled, getState })` — gives a structured hook for "do optimistic write, await server, reconcile." Direct analogue of Solid's `action()`.

**SWR / TanStack Query**

- Server-state cache with revalidation, optimistic updates, retry policies, focus refetching.
- Maps to: S1, S2, S7 at a higher level — these libraries are the "industry standard" answer to UI optimistic UX.
- What we can learn:
  - Mutation `onMutate` / `onError` / `onSuccess` / `onSettled` lifecycle hooks. The lifecycle is a useful template even if the surface differs.
  - `optimisticUpdate` taking a function `(previousData) => newData` rather than a value — captures the "compute the optimistic from current truth" pattern.
  - **`isFetching` vs `isLoading` vs `isRefetching`** — they distinguish "first load" from "background refresh" from "user-triggered refetch." More refined than Solid 2.x's `isPending` (and pulse's). Could inform a richer set of pending-status accessors.

**Apollo Client (normalized cache + optimistic responses)**

- Mechanism: queries return normalized data (entities by ID). Mutations can include an `optimisticResponse` that's written to the cache immediately; the real response replaces it.
- Maps to: S7 (optimistic reconciliation) at scale. Apollo handles the cache normalization (entities by id, queries by params, references via Reference type).
- What we can learn: normalized cache + ID-based reconciliation is the production answer to "optimistic insert + refetch replacement." The complexity is in the normalization, not the optimistic primitive.

### Local-first / CRDT / collaborative editing

A radically different answer: instead of coordinating writes, make the data structure such that concurrent writes ALWAYS merge cleanly.

**Yjs**

- Mechanism: CRDTs (specifically, Yjs uses a hybrid: YArray as a list CRDT with unique IDs; YMap, YText, YXmlFragment). Updates are described as operations with author + timestamp; deterministic merge.
- Maps to: S5 (cross-tx read) — there's no entanglement because concurrent writes are designed to commute. S7 — optimistic survives because the optimistic write is already a valid op; the server's "real" op merges in.
- What we can learn:
  - For LOCAL-only optimistic UI, CRDTs are overkill (no concurrent writers). But the principle "structure your data so concurrent edits merge" is broadly applicable.
  - Yjs's `Awareness` protocol (per-user transient state — cursor positions, selections) is a separate channel from the CRDT — worth knowing that "transient session state" and "committed data" might be different primitives.

**Automerge**

- Similar to Yjs; JSON CRDTs with full history + undo. Automerge 2.0 made it production-ready.
- What we can learn: full history as a built-in feature — every state is reachable. The cost is data-size overhead; the benefit is time-travel, blame, undo, all for free.

**Replicache / Rocicorp Zero**

- Replicache: client-side cache with optimistic mutations + sync engine. Mutations have a deterministic local function (the optimistic) + a server function (the real). Server-side reconciliation replays mutations against the latest server state.
- Maps to: S1 + S7 + S2 + S6 (cancellation through mutation queue management).
- What we can learn:
  - **Mutation = (local fn, server fn) pair** as a discipline. The local fn is the optimistic; the server fn is "ask the server to do the same thing." Reconciliation replays the queue against the server-canonical state.
  - The replay model is a different answer to S7: instead of "the server response replaces the optimistic," "the entire mutation queue is replayed against the new server state." Handles the "refetch happens mid-flight" problem (S7 variant) automatically.

**Linear's sync architecture (public talks)**

- Server-authoritative; client maintains an in-memory database synced via deltas. Mutations are optimistic; conflicts resolved server-side; client receives deltas.
- What we can learn: the production-architecture-at-scale answer to "optimistic UI + multi-user collaboration." Pulse isn't aiming at multi-user, but the single-user mutation model (mutate optimistically, await server, reconcile) is the same shape.

**Figma's multiplayer architecture (operational transformation)**

- Server-authoritative OT, not CRDT. Server maintains canonical order; clients send ops; server transforms incoming ops against committed ops.
- What we can learn: OT vs CRDT is a long debate — OT has lower data overhead but requires a central server; CRDT is fully P2P-capable. For local-only optimistic UI, neither is needed.

**ElectricSQL, PowerSync**

- Local-first SQL databases with sync engines. The "local SQLite, sync to Postgres" architecture.
- Maps to: very different problem (full data sync) but the optimistic mutation pattern is similar.

### Algebraic effects (theoretical foundation)

The formal framework that underlies Suspense, effect-ts, async/await, generators, and a lot of modern async machinery.

**Eff, Koka, Frank, Helium**

- Languages designed around algebraic effects. An *effect* is a typed operation (e.g. `State.get`, `IO.println`); a *handler* interprets effects (e.g. "handle State by carrying a value through; handle IO by actually printing"). Code that uses effects is parameterized by which handlers are in scope.
- Maps to: this is the theoretical lens through which "suspension" (NotReadyYet / NotReadyError) and "transaction" both look like effects, with `<Loading>` and `transaction(...)` being handlers.
- What we can learn:
  - Naming our primitives as effects + handlers can clarify the design. `use(x)` raises a `Suspend(promise)` effect; the nearest binding effect's handler turns it into a re-run.
  - The composition rules in algebraic effects (handlers can wrap other handlers) suggest how pulse's primitives compose: a `transaction` handler inside a `<Loading>` handler inside a `catchError` handler... each handles a specific effect, ignores others.

**OCaml 5 effect handlers**

- The first mainstream language to add effect handlers (2022). Multicore OCaml uses them for fibers.
- What we can learn: production-ready effect handlers in a mainstream language. Worth watching as a model for how the theory translates to industry.

**Multicore OCaml fibers**

- Fibers built on top of effect handlers — `perform` raises an effect, the scheduler catches it and resumes the fiber on a different worker.
- Maps to: structurally similar to JavaScript generators + an async runner.

### ECS / game engine command-buffer patterns

A surprisingly direct parallel: ECS systems queue mutations during a parallel run, apply them at a sync point.

**Bevy Commands**

- Mechanism: inside a Bevy ECS system, `Commands` is a queue. `commands.spawn(...)`, `commands.entity(e).insert(...)`. These don't execute immediately — they queue. Bevy flushes commands at sync points between system stages.
- Maps to: literally overlay-and-commit, but at the entity/component level instead of signal level. The "sync point" is exactly our Q5 (lifecycle of overlays).
- What we can learn:
  - Bevy's stage architecture: systems are scheduled by their data dependencies; sync points are explicit (`apply_deferred`). Could inform pulse's transaction commit-point semantics.
  - `Commands` queue is owned by the system; flushed at a specific point. Direct analogue of `tx.commit()` flushing the overlay.
  - Bevy's documentation on commands + sync points is unusually clear on the "queue mutations, apply later" pattern.

**Unity DOTS Entity Command Buffer**

- Similar to Bevy Commands: jobs queue ECB operations; ECB applied on main thread at a specific point.
- What we can learn: same pattern, mature in production at scale (Unity DOTS ships in actual games).

**Unreal subsystems / batched function calls**

- Less directly comparable; Unreal's pattern is more "tick functions with explicit phase ordering."

### Distributed systems patterns

Patterns developed for coordinating state across services / processes / machines — many apply to in-process concurrent flows.

**Sagas (long-running transactions with compensation)**

- Mechanism: a saga is a series of local transactions; each step has a *compensating action* that undoes it. If step N fails, run compensating actions for steps 0..N-1 in reverse.
- Maps to: **S3 (multi-step partial failure)** directly. Different mental model from "atomic overlay" — explicit compensation, useful when the underlying operations aren't reversible (e.g. third-party API calls that have side effects).
- What we can learn:
  - For pulse, the saga pattern is what users would do MANUALLY without a transaction primitive. With a transaction primitive, the "compensation" is automatic (abort discards overlay). But sagas remain useful for irreversible external operations.
  - Saga orchestration vs choreography: orchestration = central coordinator; choreography = event-driven. UI flows are mostly orchestration.

**Event sourcing + projections**

- Mechanism: state changes recorded as events; current state derived by replaying events. Projections materialize specific views.
- Maps to: tangential — different storage model than overlay+commit. But "the action's effect IS an event" maps onto Replicache's mutation model (above).

**CQRS (Command Query Responsibility Segregation)**

- Mechanism: separate write model (commands) from read model (queries). Commands mutate; queries read.
- Maps to: similar to React's "actions" vs "state" split, or Redux's "actions" vs "selectors." Useful taxonomy; less directly a coordination mechanism.

**Outbox pattern**

- Mechanism: in a transactional write, also record an outbox entry (an event to be published later). A separate process drains the outbox and publishes. Guarantees event-publication atomicity with the write.
- Maps to: useful when an action needs to "do this server side AND fire an analytics event AND notify another service." All three must succeed or none must.

**Idempotency keys**

- Mechanism: every mutation request gets a client-generated unique key. The server deduplicates based on the key.
- Maps to: S1 (rapid clicks), S6 (cancellation + retry). Crucial for "I clicked Like; my request retried due to network blip; only one like got counted."

**At-least-once vs exactly-once vs at-most-once delivery**

- Vocabulary worth knowing. Most systems are at-least-once with idempotency keys = effectively exactly-once.

**Two-phase commit / Three-phase commit / Paxos / Raft (consensus)**

- Multi-party agreement protocols. Less directly applicable to in-process concurrent flows but worth knowing for the "we need atomic commit across multiple resources" case (rare in UI).

### UI frameworks outside React/Solid

**SwiftUI + Combine + `@Published` + `@StateObject` + `Observable` (`@Observable` macro)**

- Mechanism: `@Observable` macro generates property observers. SwiftUI views are structs that re-create on state change. Combine for async data flow. `async/await` in views via `.task` modifier.
- Maps to: S6 (cancellation) cleanly — `.task` automatically cancels on view disappear.
- What we can learn: `.task(id: ...)` cancels prior task when id changes — switchMap-like for views. Direct analogue of `<Loading on={x}>`.

**Jetpack Compose + StateFlow + `collectAsState` + `LaunchedEffect`**

- Mechanism: Compose functions re-execute on observed state change. `LaunchedEffect(key)` runs a coroutine, cancels and restarts when key changes.
- Maps to: same as SwiftUI's `.task(id:)` — structured cancellation tied to render lifecycle.
- What we can learn: tying coroutine lifecycle to composable lifecycle is a clean answer to "when does my async work get cancelled."

**Vue 3 (`ref`, `reactive`, `<Suspense>`, async `setup`)**

- Mechanism: refs for primitives, reactive for objects, computed for derived. `<Suspense>` for async components. `async setup()` makes the whole component suspend.
- Maps to: similar to Solid in many ways. `<Suspense>` is simpler than Solid 2.x's `<Loading>` (no transitions integration).
- What we can learn: Vue's reactivity is proxy-based; pulse's is function-based. Different ergonomics, similar end result.

**Svelte 5 runes + reactive contexts**

- Mechanism: `$state`, `$derived`, `$effect` runes. Compiler-driven reactivity. No explicit transaction primitives.
- Maps to: pulse's design is conceptually close (small primitives + compiler/runtime support). Svelte 5 hasn't tackled the transaction/optimistic problem deeply yet (relies on user code).

**HTMX / Hotwire (Turbo Streams)**

- Mechanism: server-rendered HTML fragments swapped into DOM via HTTP responses. Optimistic UI via Stimulus + manual DOM manipulation.
- Maps to: an entirely different philosophy — push optimistic UI to the server. Not directly applicable but worth knowing the "the server is authoritative; the client is a thin renderer" tradition.

**Phoenix LiveView (server-driven with optimistic UI)**

- Mechanism: stateful server processes per connection; render trees diffed and pushed to client. Optimistic UI via `phx-click` + form events.
- Maps to: like HTMX but with persistent connection. Server-authoritative with optimistic.

### Workflow engines / durable execution

A different scale of "long-running coordinated operations." Out of scope for in-memory UI flows but worth knowing the vocabulary.

**Temporal / Cadence (durable workflows)**

- Mechanism: workflows defined as code; execution is durable (survives crashes) because the runtime persists state at every `await`. Signals (external events) and queries (read current state).
- Maps to: very long-running flows (hours / days). Cancellation, retry, compensation as first-class. The mental model is "your workflow is a coroutine that the platform makes durable."
- What we can learn: the *vocabulary* — signals, queries, child workflows, continue-as-new — gives names to coordination patterns that map onto our scenarios (S3 ≈ a workflow with multiple activities; cancellation ≈ workflow cancellation).

**Restate (durable functions)**

- Similar to Temporal; SDK in TypeScript.

**AWS Step Functions, Inngest**

- Visual / declarative workflow orchestration. State-machine-based.

### Programming language research

**Lasp (CRDT-based distributed programming)**

- Research language for distributed programming with CRDT primitives baked into the language. Variables are CRDTs; conflicts impossible by construction.
- Mostly orthogonal but worth knowing as a "what if the entire language had no conflicts" extreme.

**Linear types / affine types for resource tracking**

- Languages like Rust (affine via ownership), Idris/Granule (linear), use the type system to enforce resource lifecycle.
- Maps to: a *static* answer to S6 cancellation. If a transaction has linear type, the type system forbids forgetting to commit/abort.
- What we can learn: TypeScript can't do this directly, but a `using` block (TC39 explicit resource management) is in this direction.

**Capability typing (Scala Caps)**

- Effects as capabilities; functions declare which capabilities they need.
- Maps to: similar to effect-ts's `R` parameter in `Effect<R,E,A>`. Different ergonomics.

---

## Synthesis: what to actually borrow

Across all of the above, a few ideas repeatedly look directly relevant to pulse's transaction primitive design:

1. **MVCC vocabulary** (database) — failure modes (write skew, lost update, phantom), isolation levels, explicit `SELECT FOR UPDATE`-style locking. Use the database vocabulary; it's mature.

2. **Structured concurrency rules** (Trio, Kotlin, Swift) — cancellation propagates through checkpoints; finalizers always run; "no orphan tasks." Adopt structurally for transactions: a tx OWNS a scope; abort runs finalizers; post-abort writes are no-ops by construction.

3. **Named policies at the call site** (RxJS, Replicache) — instead of a single "default" for Q4, name the choice: `transaction({ policy: 'isolated' | 'entangled' | 'retry' | 'exhaust' | 'replace' }, ...)`. Different scenarios want different policies; making the choice explicit at the call site is more honest than a runtime default.

4. **Mutation = (optimistic, server) pair** (Replicache) — discipline of writing the optimistic computation separately from the server call. Could inform a pulse helper: `mutation({ optimistic: tx => tx.set(...), server: () => api.call(...), reconcile: (tx, response) => tx.set(...) })`.

5. **Snapshot capture/restore for preview mode** (Recoil) — exposing `tx.snapshot()` and `restoreFromSnapshot(snap)` covers S8 for free.

6. **Compensation pattern** (sagas) — for steps containing irreversible external operations, automatic-rollback (overlay discard) isn't enough; user-provided compensation is needed. Pulse's transaction could support `tx.onAbort(compensateFn)` for this.

7. **Bevy's "queue mutations, flush at sync point"** — cleanest mental model for the overlay-and-commit primitive. Sync points are explicit; mutations are intent, not state.

8. **Idempotency keys for server requests** — orthogonal to the transaction primitive but mentioned in mutation lifecycle docs would help users build correct UX.

9. **Distinguish first-load / refetch / background-update** (TanStack Query's `isLoading` / `isFetching` / `isRefetching`) — pulse's `isPending` lumps these together; a richer taxonomy could help.

10. **Algebraic effects framing** — pulse's primitives are already effect-handler-shaped. Naming them as such (and documenting which "effects" they handle: Suspend, Throw, Transact, Refresh) sharpens the design.

## What to NOT borrow

- **Full STM retry semantics** — purity precondition is too strict for UI flows containing server calls.
- **Programming-model-everything** (effect-ts, Eff languages) — pulse's value is being a small reactive layer; becoming "effect-ts for UI" is a different project.
- **CRDTs as the default** — local-only optimistic UI doesn't need conflict-free merge; the overhead isn't justified. CRDT becomes the right call only when multi-user collaboration enters the picture.
- **Server-driven UI** (HTMX, LiveView) — different philosophical commitment; out of scope for what pulse is trying to be.
- **Distributed consensus** (Paxos, Raft) — pulse is single-process; consensus is overkill.

---

## How to use this document

| # | Scenario | Primary capability tested |
|---|---|---|
| 1 | Like/unlike race | Snapshot isolation, atomic commit, optimistic-with-revert |
| 2 | Auto-save vs explicit save | Snapshot isolation, server-payload-snapshot correspondence |
| 3 | Multi-step server flow with partial failure | Atomic commit across steps, cancellation |
| 4 | Concurrent independent flows | Isolation as non-interference (negative test) |
| 5 | Cross-transaction read | Auto-entanglement / explicit-entanglement |
| 6 | User-cancellable flow | Cancellation/abort, post-abort write suppression |
| 7 | Optimistic reconciliation with server data | Optimistic survival across refetch, atomic replacement |
| 8 | Preview / what-if mode | Snapshot isolation for non-async deliberate use |

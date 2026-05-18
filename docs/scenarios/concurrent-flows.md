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

## Scenario index (for cross-referencing in implementation specs)

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

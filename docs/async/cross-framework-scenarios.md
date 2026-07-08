# Cross-framework async scenarios

A scenario-major comparison: for each canonical async scenario (S1–S8 from [`../scenarios/concurrent-flows.md`](../scenarios/concurrent-flows.md)), the **actual API** of each framework side by side, plus a two-track trace of what happens — **⚙ under the hood** (the mechanism) and **👁 on screen** (what the user sees).

The pairing is the point. A visible glitch — a torn heart, a spinner flash — is a *symptom* of an under-the-hood choice. This document makes "this mechanism produces that outcome" legible, and ties each visible pathology to the [four failure modes](./transitions-problem-space.md#the-four-failure-modes).

## How to read this

- **Frameworks:** pulse, Solid 2.x, React 19, Svelte 5. The reactive-UI set that maps onto all eight scenarios. Non-UI systems (Effect-TS STM, Replicache server-rebase) are referenced per scenario where they answer differently.
- **⚙ / 👁 tracks.** Every framework gets a mechanism track and a screen track. Where timing is load-bearing, they run on a shared time axis; where it isn't, they're a mechanism→visible pair.
- **Failure-mode tags.** FM1 torn state · FM2 spinner flash · FM3 lost interactivity · FM4 uncommittable speculation. A ✗ marks where a framework hits one; ✓ marks a clean outcome.
- **`(proposed)` on pulse.** pulse is a design, not a shipping library — its cells show the *designed* API from [`../pulse/`](../pulse/README.md). The others show real shipping APIs.
- **Source of truth = our deep dives** ([`./deep-dives/`](./deep-dives/)), as researched 2026-05, with source line refs. Cells drawn from them are firm; cells I could not ground are marked **⚠ unverified** and are candidates for a verification pass.
- **Svelte 5** cells are now verified against [`./deep-dives/svelte-5.md`](./deep-dives/svelte-5.md) (async path is experimental, opt-in `experimental.async`). The load-bearing finding: Svelte has **no optimistic-UI primitive** (no `useOptimistic` / `createOptimistic` equivalent), so the optimism-centric scenarios (S1, S2, S7) are hand-rolled, while the coherence scenarios (S3, S4, S5, S8) are first-class. One remaining thin spot: `getAbortSignal`'s exact signature is an open question in the Svelte dive.

---

## S1 — Like/unlike race

**Scenario.** User double-taps like. `tap1` flips `false→true`, fires `req₁`; `tap2` (+60 ms) flips `true→false`, fires `req₂`. Intended final state: **unliked** (last tap wins). A blind toggle — a *class-A replacement*, so the mechanism is supersession / last-wins, **not** conflict-rejection (there is no read-premise to invalidate).

**pulse (proposed)**
```ts
const [liked, setLiked, isPending] = optimistic(serverLiked)
let inflight
function toggle() {
  inflight?.discard()                     // supersede the older tap
  inflight = action(function* () {
    setLiked(v => !v)                     // optimistic overlay, tagged pending
    yield* api.toggle()                   // commit promotes; discard reverts
  })
}
```
**Solid 2.x**
```ts
const [liked, setLiked] = createOptimistic(serverLiked)
const toggle = () => action(function* () { setLiked(v => !v); yield api.toggle() })
```
**React 19**
```tsx
const [liked, setLiked] = useOptimistic(serverLiked)
const toggle = () => startTransition(async () => { setLiked(v => !v); await api.toggle() })
```

**In-order responses** (`req₁`@200, `req₂`@350) — everyone converges correctly:
```
            t0 tap1▲      t60 tap2▲         t200 req₁✓        t350 req₂✓
 pulse  ⚙   spec A opens  A.discard();      B commits →       (B already
                          spec B opens      serverLiked=F      committed)
        👁  ♥ ON           ♥ OFF             ♥ OFF             ♥ OFF   ✓
 Solid  ⚙   lane A         lane B unions A   merged lane       last-write
                                             commits           wins → F
        👁  ♥ ON           ♥ OFF             ♥ OFF             ♥ OFF   ✓
 React  ⚙   WIP tree₁      2nd action;       useOptimistic     converge in
                           lanes may coalesce shows latest = F  one commit
        👁  ♥ ON           ♥ OFF             ♥ OFF             ♥ OFF   ✓ no flash
```

**Out-of-order responses** (`req₂`@200, `req₁`@350) — where the document earns its keep:
```
            t0 tap1▲      t60 tap2▲        t200 req₂✓        t350 req₁✓
 pulse  ⚙   spec A        A discarded;     B commits → F     req₁ ignored
                          spec B           (A gone)          (A was discarded)
        👁  ♥ ON           ♥ OFF            ♥ OFF            ♥ OFF   ✓ intent held
 React  ⚙   WIP₁          WIP₂             no conflict       req₁ resolves
                                           detection         LAST → serverLiked=T
        👁  ♥ ON           ♥ OFF            ♥ OFF            ♥ ON  ✗ FM1 torn state
```

**Svelte 5** — no optimistic primitive. The optimistic flip is hand-rolled: a sync state write commits immediately (its batch has no pending async derived to defer), fire-and-forget fetch, manual revert-on-error. If the toggle state instead flows through tracked async deriveds, two overlapping writes to the same source collapse via **whole-batch merge** (`svelte-5.md:208`) — last-write-wins — but the visible flip then *defers until the server settles* (no optimism). Svelte forces the choice: optimistic-but-manual, or coherent-but-not-optimistic.

**Verdict.** pulse's supersession (`.discard()` binds outcome to *tap* order) and Solid's last-write-wins on the merged lane hold user intent under reordering. React resolves by *server-arrival* order with no conflict detection (`react-modern.md:211`), so out-of-order arrival can snap the heart back against the last tap — **FM1**. Svelte hand-rolls the optimism, so out-of-order safety is whatever the developer builds.

| | pulse | Solid | React | Svelte |
|---|---|---|---|---|
| overlap policy | supersede (discard older) | union-find lane merge | coalesce; server-order | whole-batch merge (if tracked) |
| out-of-order safe | ✓ | ✓ | ✗ FM1 | manual (no primitive) |

---

## S2 — Auto-save vs explicit save

**Scenario.** User edits a field. A debounced auto-save fires; the user then hits **Save** explicitly while the auto-save is still in flight. The explicit save's result must not be clobbered by the slower auto-save landing later.

**pulse (proposed)**
```ts
const draft = compute(() => ({ body: get(text) }))
let autoSave
function save(explicit) {
  autoSave?.discard()                     // explicit supersedes the pending auto-save
  const payload = get(draft)              // snapshot at call time (gather-up-front, Q14)
  action(function* () { yield* api.save(payload) })
}
```
**Solid 2.x** — both as `action()`s; generator yields step the transition; closure captures the payload at action-call time (`solid-2x.md:201`).
**React 19** — both as Actions, lane-scheduled; explicit save in a higher-priority lane; `useOptimistic` shows the latest committed payload; payload snapshot via closure capture (`react-modern.md:212`).
**Svelte 5** — both writes to the same `text` source collapse via whole-batch merge (last-write-wins by batch order); there are **no priority lanes** (Dim 3 is punted, `svelte-5.md:255`), so "explicit save wins over auto-save" isn't expressible except through ordering.

```
            t0 edit       t300 auto-save▲    t400 Save▲          t600 auto✓ / t700 save✓
 pulse  ⚙   draft dirty   spec Auto opens    Auto.discard();     save commits;
                                             spec Save opens     stale auto can't land
        👁  "unsaved"      "saving…"          "saving…"           "saved" (explicit)   ✓
 React  ⚙   state         auto Action        save Action         useOptimistic shows
                                             (higher lane)        latest committed
        👁  "unsaved"      "saving…"          "saving…"           "saved" — but if auto
                                                                  lands last, shows auto ✗ FM1 risk
```

**Verdict.** pulse and React both keep the explicit save authoritative — pulse by *discarding* the superseded auto-save (it can never commit), React by lane priority *plus* the caveat that "latest committed payload" is arrival-sensitive. The discard is the stronger guarantee: a discarded action produces no commit at all, so ordering can't betray it.

---

## S3 — Multi-step server flow with partial failure

**Scenario.** A save runs step₁ (metadata) then step₂ (content). Step₁ succeeds, step₂ fails. Step₁'s effect must roll back — all-or-nothing.

**pulse (proposed)** — nested actions; the coupling is *structural* (class E, free):
```ts
action(function* () {                     // outer = the atomic unit
  yield* action(function* () { yield* api.saveMeta(m) })      // step 1
  yield* action(function* () { yield* api.saveContent(c) })   // step 2 — throws
})  // outer body throws → outer discards → both sub-writes (promoted to outer,
    // not yet to ROOT) drop together. handle.onFailure for UX.
```
**Solid 2.x** — multi-step `action()` with `yield api.step1(); yield api.step2()`; failures via thrown errors; `createOptimistic` state auto-reverts (`solid-2x.md:202`). Ergonomic — the generator *is* the dependent chain.
**React 19** — Server Action `await`s each step; failure via throw; **no automatic compensation — manual try/catch + state restoration** (`react-modern.md:213`).
**Svelte 5** — a `<svelte:boundary>` gives commit-together: a multi-step tree stays deferred until it settles, and if step₂ throws, the boundary catches it and step₁'s deferred DOM never swaps in — effectively atomic (`svelte-5.md:137,184`). External / server-side compensation is still manual, as everywhere.

```
 step1✓ ────────────── step2✗
 pulse  ⚙  meta→outer slot   content throws → outer discards → BOTH drop
        👁  (optimistic meta shown) → reverts atomically           ✓ no torn state
 Solid  ⚙  step1 write        step2 throws → createOptimistic auto-reverts
        👁  optimistic shown → reverts                             ✓
 React  ⚙  step1 committed     step2 throws → step1 NOT auto-undone
        👁  step1 visible → stays unless you hand-restore          ✗ FM1 if unhandled
```

**Verdict.** pulse (nested-action discard) and Solid (optimistic auto-revert) roll back step₁ for free; React requires manual compensation and will show torn state (**FM1**) if the developer forgets. Effect-TS's STM would also roll back atomically — same guarantee, different substrate (see [`./deep-dives/effect-ts.md`](./deep-dives/effect-ts.md)).

---

## S4 — Concurrent independent flows

**Scenario.** Two *unrelated* flows on separate data run concurrently (e.g. a profile update and a cart update). Neither should affect the other's pending state or commit.

**pulse (proposed)** — isolate by default; each `action()` is its own scope with snapshot isolation; no coupling, no batching:
```ts
action(function* () { setProfile(p); yield* api.saveProfile(p) })  // scope A
action(function* () { setCart(c);    yield* api.saveCart(c)    })  // scope B — fully independent
```
**Solid 2.x** — independent optimistic writes get independent lanes; union-find merges *only* on shared subscribers, so disjoint flows never merge (`solid-2x.md:203`). Not batched.
**React 19** — independent transitions get independent lanes *in principle*, but are **currently batched** in practice (`react-modern.md:214`); the batching limitation is acknowledged and to be lifted.
**Svelte 5** — two batches on *disjoint* sources have non-intersecting source-sets, so they **do not merge** and commit independently in settle order; `batch_values` gives each a consistent snapshot (`svelte-5.md:248,270`). Merge kicks in *only* on shared-source overlap — so disjoint concurrent flows stay independent.

```
 pulse   ⚙  scope A, scope B — disjoint slots, disjoint version state
         👁  A's spinner and B's spinner independent               ✓
 Solid   ⚙  lane A, lane B — no shared sub → no union → no merge
         👁  independent                                           ✓
 React   ⚙  transitions batched today
         👁  A and B may share a pending boundary                  ✗ FM3 risk (today)
 Svelte  ⚙  batch A, batch B — source-sets disjoint → no merge
         👁  independent                                           ✓
```

**Verdict.** This is pulse's headline: isolate-by-default means unrelated flows *cannot* couple, so no false coupling and no shared pending. Solid matches it (union-find only merges on real overlap), and — correcting this doc's earlier pessimism — so does Svelte: its batch merge triggers *only* on shared-source overlap, so disjoint flows commit independently. React's current batching can bleed A's pending into B (**FM3** lost-interactivity risk) until the acknowledged limitation is lifted, making it the odd one out here.

---

## S5 — Cross-transaction read

**Scenario.** A consumer reads *committed* state while a speculation is mid-flight. When the speculation commits, the consumer must update — and must never see a torn `(X, f(X))` pair.

**pulse (proposed)** — falls out of chain-match ([Q1](../pulse/questions.md#q1--fall-through-and-edge-policy)) for free. A consumer under a scope that read a fall-through-to-committed value is fired when that value is later committed at the root; microtask batching + the commit deferred-fires region keep the read coherent (see [H1d](../pulse/scenario-traces.md#h1d--effect-body-coherence-on-commit)). No dedicated primitive.
**Solid 2.x** — the `_gatedSubs` "entanglement gate" (`solid-2x.md:204`): subscribers that read a plain signal's *committed* value while recomputing under a lane are recorded and rescheduled at commit. Real machinery, no formal MVCC.
**React 19** — `useDeferredValue` keeps the old value visible while the new prepares — analogous, but no formal cross-transaction primitive; the WIP tree is invisible to other transitions (`react-modern.md:215`).
**Svelte 5** — `batch_values` "time-travel" (`svelte-5.md:190`) gives each in-flight batch a consistent snapshot; on commit, the **rebase** loop re-runs async effects in other batches that depended on the just-committed sources (`svelte-5.md:204`). Real cross-batch coherence, analogous to Solid's gated-subs.

```
 ⚙  consumer reads committed X    speculation commits X'    consumer re-fires
 👁  shows f(X)                    →                         shows f(X') coherently
 pulse : chain-match auto-fires; no (X', f(X)) tear (microtask + deferred-fires) ✓
 Solid : gated-subs replay at commit                                            ✓
 Svelte: batch_values snapshot in flight; rebase re-runs on commit              ✓
 React : useDeferredValue holds old value; no cross-transition read             ~ partial
```

**Verdict.** pulse subsumes Solid's `_gatedSubs` via chain-match — same guarantee, no extra machinery. Solid and Svelte (batch snapshot + rebase-on-commit) both give real cross-transaction coherence and avoid the torn read (**FM1**). React's answer is the weaker "hold the old value" rather than a true cross-transaction read.

---

## S6 — User-cancellable flow

**Scenario.** User starts a multi-step flow and cancels midway. The optimistic state must revert cleanly, and in-flight I/O should abort.

**pulse (proposed)**
```ts
const h = action(function* () {
  const ctrl = new AbortController()
  onDiscard(() => ctrl.abort())           // I/O cancellation on any discard
  setOptimistic(v)
  yield* api.step(url, ctrl.signal)
})
// later: h.discard()  → onDiscard fires (abort + revert), state rolls back
```
**Solid 2.x** — owner disposal cancels async iterables (`it.return()`); promise fetches use identity-based stale-discard; no fetch cancellation without a manual `AbortController` (`solid-2x.md:205`).
**React 19** — WIP discard cancels cleanly at the render layer; I/O cancellation needs explicit `AbortController` wiring (`react-modern.md:216`).
**Svelte 5** — two-channel cancellation: `OBSOLETE` rejects a superseded derived's deferred, `STALE_REACTION` aborts a stale effect (`svelte-5.md:259,278`); neither aborts the underlying fetch — I/O abort is opt-in via `getAbortSignal`. `fork().discard()` cancels an explicit speculation.

```
 ⚙  spec open, I/O in flight   →  discard: revert slots + (if wired) abort
 👁  "processing…"             →  reverts to prior state, no flash of cancelled work
 pulse / Solid / React / Svelte: render-layer revert clean ✓ ; fetch-abort uniformly MANUAL
```

**Verdict.** All four cancel cleanly at the render layer (no **FM1**/FM2 on cancel); *I/O* cancellation is uniformly the developer's job via `AbortController`. pulse's `onDiscard` gives it a natural home tied to the discard face.

---

## S7 — Optimistic reconciliation

**Scenario.** Show an optimistic value immediately; the server returns the canonical value; hand off optimistic→real in a single commit with **no flash** of intermediate/empty state (FM2).

**pulse (proposed)**
```ts
const [value, setOptimistic, isPending] = optimistic(serverValue)
action(function* () {
  setOptimistic(predicted)                // overlay visible immediately
  const real = yield* api.save(predicted)
  setValue(real)                          // canonical write; commit promotes it
})  // overlay clears on commit AND discard (onCommit/onDiscard, one fires) — same
    // deferred-fires region as the canonical promotion ⇒ single-commit handoff, no flash
```
**Solid 2.x** — `createOptimistic` + `action()`; lane override-with-pending-value converges in the same render; canonical, **mechanically more powerful than React** (lanes merge) (`solid-2x.md:206`).
**React 19** — `useOptimistic`, the textbook case: convergence in the same render commit, no flash; failure handled by the parent not updating `value` (`react-modern.md:217`).
**Svelte 5** — no optimistic primitive. Its transitional model is *wait-then-swap*: a boundary defers the DOM until async settles, then swaps old-coherent→new-coherent with no flash (`svelte-5.md:184`) — FM2 is avoided, but by *waiting*, not by showing a prediction. True optimistic reconciliation is hand-rolled (a `fork()` or a manual source).

```
 ⚙  overlay shown   →  server returns   →  canonical write + overlay clear (SAME commit)
 👁  predicted       →  predicted        →  real                       ✓ no intermediate flash
 pulse / Solid / React: converge in one commit — FM2 avoided by construction ✓
```

**Verdict.** pulse, Solid, and React all avoid the flash (**FM2**) by making the optimistic→real handoff a single commit. This is the most-solved scenario across the field; the differences are ergonomic, not behavioral.

---

## S8 — Preview / what-if mode

**Scenario.** Show the user what a change *would* look like without committing it — a speculative view they can inspect, then apply or dismiss. (Not a transaction, but adjacent: isolation *without* a commit boundary.)

**pulse (proposed)** — the speculative overlay already *leaks its value, tagged*, so consumers inside the scope can render the preview (unlike an invisible WIP tree). The gap: "a preview that never commits" overloads the speculation lifecycle — you'd express it as an always-discarded action, conflating "not a speculation" with "failed speculation" (the [Scope-does-two-jobs aside](../pulse/concurrent-divergence.md#a-conceptual-aside--scope-is-doing-two-jobs)). Exposable ✓, lifecycle-overloaded (open).
**Svelte 5** — `fork()` (5.42+) is the closest thing to a real preview primitive: a fork accumulates speculative state in `current` and stays permanently deferred until `.commit()` / `.discard()` (`svelte-5.md:229`). The fork's speculative state is readable — an *exposable* what-if. **Svelte leads here.**
**React 19** — the WIP tree is the right shape but **not exposable while building**; invisible until commit — you cannot show the user the preview (`react-modern.md:218`).
**Solid 2.x** — `latest()` / `refresh()` bypass pending, but no true preview primitive and no exposable speculative tree (`solid-2x.md:207`).

```
 ⚙  build speculative state, never (yet) commit  →  read it to render the preview
 👁  can the user SEE the what-if?
 Svelte fork():   yes — speculative `current` is readable       ✓ leads
 pulse overlay:   yes — tagged leak is readable                 ✓ (lifecycle overloaded)
 React WIP:       no  — invisible until commit                  ✗ FM4-adjacent
 Solid:           no  — no exposable tree                       ✗
```

**Verdict.** The one scenario where the reactive-frameworks split cleanly on *exposability*. Svelte's `fork()` and pulse's tagged overlay can render the what-if; React's WIP tree and Solid's lanes cannot surface it before commit. pulse's remaining work is conceptual (separating the isolation context from the commit boundary), not mechanical.

---

## Coverage at a glance

Ratings synthesized from the deep-dive scenario mappings; ✓ solved, ~ partial, ✗ not handled, ⚠ unverified.

| Scenario | pulse (proposed) | Solid 2.x | React 19 | Svelte 5 |
|---|---|---|---|---|
| S1 like/unlike race | ✓ supersede | ✓ lane merge | ~ FM1 out-of-order | ~ hand-rolled (no primitive) |
| S2 auto vs explicit save | ✓ discard-supersede | ✓ | ✓ (arrival caveat) | ~ merge, no priority |
| S3 multi-step partial failure | ✓ nested actions | ✓ auto-revert | ~ manual compensation | ~ boundary-atomic |
| S4 concurrent independent | ✓ isolate | ✓ independent lanes | ~ batched today | ✓ independent (disjoint) |
| S5 cross-transaction read | ✓ chain-match | ✓ gated-subs | ~ deferred value | ✓ snapshot + rebase |
| S6 cancellable | ✓ onDiscard (I/O manual) | ~ (I/O manual) | ✓ render / ~ I/O | ~ 2-channel; I/O manual |
| S7 optimistic reconciliation | ✓ single-commit | ✓ canonical | ✓ canonical | ~ wait-then-swap; no optimism |
| S8 preview / what-if | ~ exposable, lifecycle-overloaded | ✗ | ✗ invisible WIP | ✓ fork() leads |

## Sources & verification status

- **Firm** (grounded in deep dives with source refs): all Solid, React, and Svelte cells ([`./deep-dives/solid-2x.md`](./deep-dives/solid-2x.md), [`./deep-dives/react-modern.md`](./deep-dives/react-modern.md), [`./deep-dives/svelte-5.md`](./deep-dives/svelte-5.md)); pulse cells (from [`../pulse/`](../pulse/README.md) — designed, not shipped).
- **Svelte verification pass (done).** Mapped `Batch` / `fork()` semantics onto S1–S8. Headline: Svelte has **no optimistic-UI primitive**, so S1/S2/S7 are hand-rolled, while coherence scenarios (S3 boundary-atomic, S4 independent-on-disjoint, S5 snapshot+rebase, S8 `fork()`) are first-class. **Correction:** this doc's earlier "S4 merges/couples" pessimism was wrong — Svelte's batch merge triggers *only* on shared-source overlap, so disjoint concurrent flows stay independent.
- **Remaining thin spots:** `getAbortSignal`'s exact signature (an open question in `svelte-5.md`); `fork()`'s S8 behavior is a designed API tested by the deep dive rather than by a runnable S8 example here.
- **Scenario definitions:** [`../scenarios/concurrent-flows.md`](../scenarios/concurrent-flows.md) (S1–S8, policy questions Q1–Q5).
- **Failure modes:** [`./transitions-problem-space.md`](./transitions-problem-space.md#the-four-failure-modes) (FM1–FM4).

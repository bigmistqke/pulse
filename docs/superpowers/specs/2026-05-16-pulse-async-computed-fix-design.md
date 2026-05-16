# pulse async computed fix — design spec (Plan 6)

**Status:** design complete.
**Date:** 2026-05-16.
**Companion docs:** [`CONTEXT.md`](../../../CONTEXT.md), [master design spec §7](2026-05-14-pulse-design.md), [ADR 0003](../../adr/0003-reentry-on-normal-node.md), [`docs/follow-ups.md`](../../follow-ups.md) ("'reuse-value' stash consumption…").

---

## 1. Motivation

`computed(() => fetchSomething(reactiveDep()))` is the *natural* way to express
"async value derived from reactive deps." Today it silently freezes after the
first settle: pulse's `'reuse-value'` stash mechanism bypasses the body on
recompute (returning the stashed resolved value), which means r3 doesn't see
any reads — every dep is unlinked. Subsequent dep changes never reach the
computed.

Two follow-up entries track this:
- "`'reuse-value'` stash consumption in `src/computed.ts` loses dep tracking"
  *(important)*
- "Widen `use` to accept an accessor too" *(done in Plan 3a follow-up)* — this
  doesn't fix the underlying bug; it just smooths a call-site nuisance.

The workaround (`signal + effect`) is verbose and inverts the natural mental
model: the user becomes the orchestrator instead of the framework.

The fix is architectural: **pulse takes ownership of the await loop, keyed on
the resolved value rather than on Promise identity or input shape.** Computeds
become a thin protocol over an internal signal that pulse updates out-of-band
when promises settle. Body re-runs only on dep changes — not on settle —
which structurally breaks the infinite-loop scenario and preserves r3's
dep tracking.

This matches the user's intuition that pulse should own the async wrapping,
mirrors Solid 2.x's resource model, and aligns with ADR 0007's "data-as-
signals" thesis (just internalized for the computed case).

## 2. Goals and non-goals

**Goals:**

- `computed(() => fetchSomething(reactiveDep()))` works: dep changes trigger
  refetch; promise settlement updates the value; downstream propagates.
- `computed(() => fetchSomething(deps).then(...))` (with `.then`-chained
  unstable Promise identity) works: keyed on resolved value, identity
  drift is invisible.
- Multi-stage pipelines (`computed(stage0, stage1, ...)`) continue to work
  with current semantics; this fix improves stage 0 specifically.
- Stale-while-revalidate is the default behavior on refetch (last resolved
  value stays visible until the new one settles).
- `isPending(computed)` is reactive and reflects mid-flight refetches.
- Generator pipelines (`yield* read()`) keep working unchanged; this fix is
  for non-generator stages.

**Non-goals:**

- A new `resource` / `asyncComputed` primitive. Computed itself becomes
  capable.
- Built-in caching of fetches (user can layer caching on their side; not
  pulse's concern).
- Cancellation of in-flight fetches when superseded (existing kick-guard
  handles "ignore stale resolution"; actual fetch cancellation is a separate
  concern via AbortSignal).

## 3. Semantic model

### 3.1 The body runs on dep change, not on settle

Today: the body re-runs both on dep change AND on the kick fired by promise
settle (which makes the body run twice per page change in pipelines —
expected — but also creates the infinite-loop trap when single-stage bodies
return new Promise identities).

Fix: **the body re-runs only when r3 marks the computed dirty due to a
dep change**. Settle is handled out-of-band by directly updating the
computed's value (via an internal signal) without re-invoking the body.

### 3.2 Cache key: resolved value

When body re-runs and returns a Promise, pulse awaits it. The new resolved
value is compared (`Object.is`) to the previous resolved value:

- **Equal:** no-op. Value stays. No downstream invalidation.
- **Different:** value updates. Downstream subscribers see the change.

This is the "key on the result" insight: the cache index is the resolved data,
not Promise identity. Identity drift from `.then` chains is benign — only the
final resolved value matters.

### 3.3 Stale-while-revalidate default

On dep change, the body re-runs and produces a new Promise. The computed's
*currently published* value stays the previous T until the new Promise
settles. Consumers reading the value see the old data during refetch — no
flicker.

`isPending(computed)` is `true` during the refetch window. Loading boundaries
observe this naturally (the binding-effect that reads the computed registers
with the boundary when `isPending` is true via the same mechanism as
`use()`-throws).

For consumers wanting the older "show pending Promise during refetch" mode
(causes brief blank/spinner), use `use(computed)` which throws `NotReadyYet`
while `isPending` is true.

### 3.4 First-load semantics

On initial mount, no prior value exists. The body runs, returns a Promise.
The computed's value is the Promise (consumers see `Promise<T>`). `use()`
throws as today. Loading shows initial slot.

When the Promise settles, value transitions to T. Loading transitions to
loaded.

This is unchanged from current behavior.

### 3.5 Pending-during-refetch interaction with Loading

A subtle point: today, when use() throws inside a binding, the binding
registers with the surrounding Loading. With stale-while-revalidate, the
value stays as T (no throw) — so the binding doesn't register pending. Loading
doesn't see the refetch.

This is a behavioral change. Users who *want* refetches to register with
Loading have two options:

- **Use `isPending` explicitly:** `<Show when={() => isPending(myComputed)}>`
  inside their UI. This is opt-in flicker control.
- **Use `use(computed)` instead of `computed()`:** throws on pending,
  including refetch pending. Loading sees it. Loses stale-while-revalidate
  visibility.

The default (`computed()` direct read) is stale-while-revalidate; opt-in to
pending-throws via `use()`. This matches Solid 2.x's split between resource
value-read (stale) and `read(resource)` (throw).

## 4. Architecture

### 4.1 Internal structure

Each non-generator stage that may return a Promise gets:

- An **r3 dep-tracker computed** — wraps the user's body. Its job: re-run on
  dep change, capture deps via r3, hand the result to the publisher.
- An **internal pulse signal** (`publishedValue: T | Promise<T>`) — the
  computed's user-facing value. Read by consumers; reactive.
- A **suspension-state** field tracking the current in-flight Promise (used
  for kick-guard against stale settles).
- A **lastResolvedValue** field (the value to compare against on settle).

The user-facing accessor reads `publishedValue`.

### 4.2 Dep-tracker body flow

```ts
const depTracker = r3Computed(() => {
  const input = inputAccessor !== null ? inputAccessor() : undefined
  if (isPromise(input)) {
    // Upstream stage suspended; mirror its state.
    publishedValue.set(input)
    return null
  }

  // Run user body — r3 tracks reads here.
  let userResult: unknown
  try {
    userResult = runStage(stage, input)
  } catch (e) {
    if (e instanceof NotReadyYet) {
      // Body itself threw (e.g. via use()) — surface the pending.
      publishedValue.set(e.promise)
      return null
    }
    // Real error — surface to consumers via deferred-error mechanism.
    deferredError = { error: e }
    return null
  }

  if (isPromise(userResult)) {
    // Async result. Initiate await.
    handleAsyncResult(userResult as Promise<unknown>)
  } else {
    // Sync result. Publish if different.
    if (!Object.is(lastResolvedValue, userResult)) {
      lastResolvedValue = userResult
      publishedValue.set(userResult)
    }
  }
  return null  // dep-tracker's own value is irrelevant
})
```

### 4.3 Async resolution path

```ts
function handleAsyncResult(promise: Promise<unknown>) {
  // First-load case: no prior value. Publish the Promise so consumers see pending.
  if (lastResolvedValue === SENTINEL_UNRESOLVED) {
    publishedValue.set(promise)
  }
  // Otherwise: stale-while-revalidate. Keep publishedValue at lastResolvedValue.

  suspendedOn = promise
  promise.then(
    (resolved) => {
      // Kick-guard: ignore if superseded.
      if (suspendedOn !== promise) return
      suspendedOn = null
      // Compare and publish if different.
      if (!Object.is(lastResolvedValue, resolved)) {
        lastResolvedValue = resolved
        publishedValue.set(resolved)
      } else if (publishedValue.get() !== resolved) {
        // First-load case where publishedValue was the Promise itself.
        publishedValue.set(resolved)
      }
    },
    (reason) => {
      if (suspendedOn !== promise) return
      suspendedOn = null
      deferredError = { error: reason }
      // ... publish error somehow ...
    },
  )
}
```

### 4.4 `isPending(computed)`

Add an internal field that's a derived accessor:

```ts
isPending: Accessor<boolean> = () => suspendedOn !== null
```

Exposed via the same `isPending()` function that today inspects a signal's
value. When passed a computed, it queries `suspendedOn !== null` (reactive
via a small kick signal that flips when suspendedOn changes).

### 4.5 Body never runs on settle

The settle handler calls `publishedValue.set(resolved)` directly — no body
re-run. r3's dep tracking is preserved because the body only ran in response
to genuine dep changes.

This is the structural fix for the infinite-loop trap.

## 5. Implementation impact on `src/computed.ts`

The current `makeStageNode` is replaced with the structure above. Specifically:

- Remove the stash-bypass path (the `if (stashedResolution !== null)` early
  return).
- Remove the kick signal from the dep-tracker body — it's no longer needed
  (settle doesn't re-trigger the body).
- Add an internal `signal()` for publishing the value.
- Add the dep-tracker r3 computed that runs the body and orchestrates async.
- Expose the published signal as the stage's accessor.
- Wire `isPending` for the public `isPending()` predicate.

The generator-stage path (`'fast-forward'` resumption) is unchanged.

Approximate diff size: ~80 LOC modified in `makeStageNode`; +20 LOC for the
isPending wiring; ~50 LOC of new tests.

## 6. Generator stages: no change

Generator pipeline stages (`function* () { … yield* read(p) … }`) continue
to use the existing fast-forward mechanism. The driver's WeakMap caches
yielded promises by Promise identity. Same constraints apply (user must
return stable Promise identity from yielded expressions, or use cached I/O
helpers).

The fix in this plan is for **non-generator stages**. Generator stages were
designed differently and don't have the stash-bypass bug.

## 7. Compatibility

### 7.1 Existing single-stage sync computeds (no Promise)

```ts
const doubled = computed(() => count() * 2)
```

Behavior unchanged: body runs on dep change, returns sync value, publishes
to internal signal, propagates. No async path entered.

### 7.2 Existing single-stage async computeds (returning Promise) — CURRENTLY BROKEN

```ts
const list = computed(() => fetchList(page()))
```

**Before this plan:** silently freezes after first settle.
**After this plan:** works correctly. Body re-runs on page change, awaits
new Promise, publishes new value if different.

### 7.3 Existing multi-stage pipelines

```ts
const list = computed(
  () => page(),                  // sync stage 0
  (p) => fetchList(p),           // async stage 1
  (r) => r.results,              // sync stage 2
)
```

Each stage is independent. Stage 0 (sync, no Promise): unchanged.
Stage 1 (Promise return): uses the new mechanism. Stage 2 (sync, no
Promise): unchanged.

Edge case: if a stage in a pipeline returns a Promise whose resolved value
sometimes matches the previous resolved value (e.g. cache hit returning
same data), downstream stages would not re-run. This is correct behavior
— same data, no work needed.

### 7.4 `use()`, `latest()`, `isPending()`

These work against signals today. They need to be extended to also work
against computeds (via the new internal signal mechanism). Most likely
already work since computeds expose an accessor that's signal-shaped; just
need to ensure `isPending` correctly inspects the `suspendedOn` state.

## 8. Tests

`test/computed.test.ts` additions, ~12 tests:

- **Stage 0 returning Promise: deps stay tracked across settles.** Read a
  signal in the body; settle; modify the signal; verify the body re-runs.
- **Refetch with same resolved value doesn't invalidate downstream.** Two
  fetches return identical T; a downstream effect runs once not twice.
- **Refetch with different value invalidates downstream.** Effect re-runs
  on actual change.
- **Stale-while-revalidate.** During refetch, the previous T is visible.
- **`isPending(computed)` is true during refetch, false after.**
- **`isPending(computed)` is true during initial load, false after.**
- **`use(computed)` throws during refetch (not just initial load).**
- **`.then`-chained body produces new Promise identity each call but stable
  resolved value — no infinite loop, no spurious invalidations.**
- **Multi-stage: stage 1 returning Promise.** Same semantics as single-stage.
- **Rejection: deferred-error mechanism surfaces the reject on next read.**
- **Supersession: stale resolve of an old promise is ignored.**
- **Generator stages: unchanged behavior (regression check).**

## 9. Migration / breaking changes

This is a bug fix that changes behavior:

- **`computed(() => fetchSomething(dep()))` patterns**: previously froze;
  now work. This unblocks the demo's natural pattern.
- **`computed(() => promise.then(...))` patterns**: previously freezed;
  now work via value-based caching.
- **Pending observation during refetch**: previously broken (computed never
  refetched); now reflects actual mid-flight state via `isPending`.
- **Loading boundary integration**: bindings reading a refetching computed
  don't throw NotReadyYet (stale-while-revalidate). Users wanting Loading
  to observe refetches must use `use(computed)` or `isPending()` explicitly.
  This is a UX change worth documenting.

No public API surface changes. Just semantic improvements.

## 10. Decisions log

| Decision | Resolution | Why |
|---|---|---|
| Fix scope | In-place in computed; no new primitive | Aligns with user intuition that computed should own the wrapping; avoids API surface proliferation |
| Cache key | Resolved value (Object.is) | Identity-stable per logical request; `.then` chain identity drift is benign |
| Body re-run trigger | Dep change only | Structurally breaks infinite-loop trap; preserves r3 dep tracking |
| Settle handling | Out-of-band via internal signal | Body doesn't re-run; r3 propagates via signal change |
| Default refetch UX | Stale-while-revalidate | Matches Solid 2.x resource; avoids flicker |
| Pending observation | `isPending(computed)` reactive accessor | Opt-in for Loading boundary integration |
| Throw during refetch | Opt-in via `use(computed)` | Users who want Loading to see refetches get it explicitly |
| Generator stages | Unchanged | Existing fast-forward mechanism is correct |
| Multi-stage compatibility | Each stage uses new mechanism if it returns Promise | Cleanly composable |

## 11. Open questions

- **`isPending(computed)`'s reactivity:** currently `isPending(signal)` is
  reactive via inspecting signal's value. For computeds, we need a small
  kick signal that flips when `suspendedOn` changes (true→false on settle,
  null→Promise on dep change). Easy but needs a test pinning it.
- **Error path semantics:** the deferred-error mechanism (Plan 2c) was for
  body-throws. For refetch errors, do we surface immediately or hold the
  prior value? Probably: hold prior value, but `isPending` becomes false
  and a separate `error` accessor surfaces the rejection. Needs explicit
  spec; deferred to a follow-up if this gets messy.
- **Equality comparison for downstream invalidation:** `Object.is` is the
  default. Should users be able to customize (e.g. structural equality for
  arrays)? For v1, just `Object.is`. Document; revisit if real-world data
  shows lots of "same shape new array" cases (which would benefit from
  reference-equality discipline anyway).

## 12. Relationship to ADR 0003 and master spec §7

ADR 0003: "Async re-entry on normal node" — keeps the wrapper-on-r3-computed
shape. This plan refines the wrapper's mechanism: less stash-bypass, more
internal signal. The architectural commitment (one r3 node per stage,
wrapper handles async, r3 unmodified) holds.

Master spec §7 says "On hitting a suspending stage, fn returns the in-flight
Promise<T> as the node's value (so downstream sees a promise — color
propagates) and stashes the live pipeline state. A `.then` triggers
write-back and asks the scheduler to re-queue the node."

This plan refines "asks the scheduler to re-queue the node" — instead of
re-running the body, the write-back updates the internal signal directly.
The wrapper still owns the async; r3 still untouched. The spec needs a
small update to reflect the resolved-value caching invariant.

# WeakMap-backed plain-`Promise` read model — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an async signal/computed read as a plain `Promise<T>` (a synchronous one stays bare `T`), with status/value/reason/stale-prior held in the one `states` WeakMap, read only through verbs (`use`, `latest`, `isPending`, `settled`). Remove the `Awaitable` `Promise` subclass and its symbols. Decided in [ADR 0012](../../adr/0012-weakmap-backed-promise-read-model.md).

**Architecture:** Mostly subtractive. The engine underneath — `track`/`states`, stale-while-revalidate seeding, the pending/settle pipeline, generator fast-forward, the verbs — stays. Removed: `awaitable.ts` (the `Awaitable` interface, `AWAITABLE`/`AWAITABLE_SOURCE`, `toAwaitable`, `resolvedAwaitable`). `track` gains an optional stale-prior seed; a new `resolvedPromise(value)` replaces `resolvedAwaitable`. The public read type stops unwrapping the last stage.

**Tech stack:** TypeScript, pnpm, vitest. Verify each phase with `pnpm test` (299 passing / 1 skipped is the current baseline) and `pnpm exec tsc --noEmit`.

**Sequencing rationale — stay green throughout.** The verbs (`use`/`latest`/`isPending`) already read through `track` today and already work on plain promises, so migrating tests off `.value`/`.status` to verbs (Phase 1) passes against the *current* code. The runtime change to plain promises (Phase 2) then keeps those verb-based tests green. Only tests that assert the `Awaitable` *shape itself* (a `.status` field, the `AWAITABLE` brand) move in Phase 3, when the shape changes. Types land last (Phase 4).

---

## Phase 1 — Migrate value-shape test reads to verbs

Goal: every test that reads an async signal/computed via `.value`/`.status` instead reads through a verb. These pass against current code (verbs already handle `Awaitable`s), locking the behaviour spec in verb terms before the runtime changes.

The transform, applied at each site:

- `expect((c() as … Awaitable<T>).value).toBe(x)` after settle → `expect(latest(c)).toBe(x)`
- `expect((c() as … Awaitable<T>).value).toBe(prior)` during a refetch (SWR-stale read) → `expect(latest(c)).toBe(prior)`
- `const s = c() as … Awaitable<T>; expect(s.status).toBe('fulfilled'); expect(s.value).toBe(x)` → `expect(isPending(c)()).toBe(false); expect(latest(c)).toBe(x)`
- an effect doing `push((c() as … Awaitable).value)` → `push(latest(c))` (or `push(use(c))` where the test wants suspension semantics — keep whichever the surrounding assertions imply)

Do **not** change `use(...)` / `isPending(...)` / `NotReadyYet` assertions — they are already verb-based and must stay.

### Task 1.1: sweep the three logic-test files

**Files:**
- Modify: `test/computed.test.ts` (the `(c() as unknown as Awaitable<number>).value` / `.status` sites)
- Modify: `test/async.test.ts` (the `(c() as unknown as Awaitable<string>).value` sites)
- Modify: `test/integration-async-pipeline.test.ts` (the `(pipeline() as unknown as Awaitable<string>).value` sites)

- [ ] **Step 1:** `grep -nE "as .*Awaitable<|\.status|\.value" test/computed.test.ts test/async.test.ts test/integration-async-pipeline.test.ts` to list every site.
- [ ] **Step 2:** Apply the transform above at each site, preserving the test's intent (an SWR-stale read stays a non-suspending stale read via `latest`; a settled read asserts value + not-pending). Import `latest` / `isPending` where needed.
- [ ] **Step 3:** `pnpm test` — expect the same 299 / 1. These reads now go through verbs but the runtime is unchanged, so they pass.
- [ ] **Step 4:** Commit. Message: `test: read async computeds through verbs instead of value/status fields`.

Leave `test/awaitable.test.ts` for Phase 3 — it tests the `Awaitable` shape/brand directly and cannot be verb-migrated (it changes meaning when the shape goes).

---

## Phase 2 — Runtime returns plain promises; state seeded in the WeakMap

Goal: signals and computeds store/publish plain promises; `track` seeds the stale prior; a fresh `resolvedPromise` re-fires consumers on settle. The `Awaitable` type still *exists* (removed in Phase 3) but nothing produces one anymore. Suite stays green.

### Task 2.1: `track` seeds the stale prior; add `resolvedPromise`

**Files:**
- Modify: `src/async.ts`
- Test: `test/async.test.ts`

- [ ] **Step 1 (test first):** add a test that a pending promise seeded with a prior reports it, and that a fresh resolved promise reads as settled synchronously:

```ts
import { track, resolvedPromise } from '../src/async'

test('track seeds the stale prior on a pending promise', () => {
  const p = new Promise<number>(() => {}) // never settles
  expect(track(p, 7).value).toBe(7)
  expect(track(p).status).toBe('pending')
})

test('resolvedPromise reads as fulfilled synchronously', () => {
  const p = resolvedPromise(42)
  expect(track(p).status).toBe('fulfilled')
  expect(track(p).value).toBe(42)
})
```

- [ ] **Step 2:** give `track` an optional `prior`, seeded into the pending state on first registration:

```ts
export function track(promise: Promise<unknown>, prior?: unknown): PromiseState {
  const existing = states.get(promise)
  if (existing) return existing
  const state: PromiseState = { status: 'pending', value: prior }
  states.set(promise, state)
  promise.then(
    (value) => states.set(promise, { status: 'fulfilled', value }),
    (reason) => states.set(promise, { status: 'rejected', reason }),
  )
  return state
}
```

(Drop the `if (AWAITABLE in promise)` short-circuit and the `AWAITABLE`/`AWAITABLE_SOURCE`/`Awaitable` import here in Phase 3, not now — leaving it is harmless since nothing branded reaches `track` once Phase 2 lands, but keep the diff staged by concern.)

- [ ] **Step 3:** add `resolvedPromise`:

```ts
/** A fresh already-fulfilled promise carrying `value`, recorded fulfilled in the
 *  state map so a synchronous read sees it settled at once. Used when an async
 *  computed's view settles: publishing a fresh promise re-fires consumers, and
 *  the map entry lets `use`/`latest` read the value without waiting a microtask. */
export function resolvedPromise<T>(value: T): Promise<T> {
  const p = Promise.resolve(value)
  states.set(p, { status: 'fulfilled', value })
  return p
}
```

- [ ] **Step 4:** `pnpm test` — new tests pass, rest unchanged.
- [ ] **Step 5:** Commit: `async: track seeds the stale prior; add resolvedPromise`.

### Task 2.2: signal setter stores the plain promise

**Files:**
- Modify: `src/signal.ts`
- Test: `test/signal.test.ts` / `test/async.test.ts`

- [ ] **Step 1 (test):** writing a promise to a signal makes the accessor return that exact promise, and `latest`/`use` read it:

```ts
test('a signal stores the plain promise it is given', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  const p = Promise.resolve(9)
  setS(p)
  expect(s()).toBe(p)          // the plain promise, not a wrapper
  await tick()
  expect(latest(s)).toBe(9)
})
```

- [ ] **Step 2:** replace the setter's `toAwaitable` wrapping with plain storage + `track` seeding the prior:

```ts
const setter: Setter<T> = (next) => {
  const value =
    typeof next === 'function'
      ? (next as (prev: T) => T)(untrack(() => readValue(node)))
      : next
  // Register a promise write and seed the stale-while-revalidate prior from the
  // current value, so latest()/use() can read the previous value while the new
  // one is pending. The stored value is the plain promise — no wrapper.
  if (isPromise(value) && getContext() === null) {
    const cur = untrack(() => readValue(node)) as unknown
    const prior = isPromise(cur) ? track(cur as Promise<unknown>).value : cur
    track(value as Promise<unknown>, prior)
  }
  writeValue(node, value)
  requestFlush()
}
```

Remove the `toAwaitable`/`AWAITABLE`/`Awaitable` import from `signal.ts`; add `track` from `./async`. Keep the `getContext() === null` guard (it still keeps a computed's internal published-promise writes from being treated as user signal writes).

- [ ] **Step 3:** `pnpm test` — green.
- [ ] **Step 4:** Commit: `signal: store the plain promise on write; seed the stale prior in the state map`.

### Task 2.3: computed publishes and reads plain promises

**Files:**
- Modify: `src/computed.ts`
- Test: existing `test/computed.test.ts` / `test/integration-async-pipeline.test.ts` are the spec

This is the intricate file. The edits, site by site (line numbers approximate — match by content):

- [ ] **Step 1:** `publishResolvedAwaitable(value)` publishes a fresh resolved *plain* promise:

```ts
const publishResolvedPromise = (value: unknown): void => {
  r3SetSignal((publishedValue as Signal<unknown>)[NODE] as R3Signal<unknown>, resolvedPromise(value))
  requestFlush()
}
```

- [ ] **Step 2:** first-load pending publish (was `setPublishedValue(toAwaitable(p, undefined))`): publish the raw in-flight promise, registered with no prior:

```ts
track(p)
setPublishedValue(p)
```

- [ ] **Step 3:** upstream-input handling (was the `AWAITABLE in input` fulfilled-unwrap / `AWAITABLE_SOURCE` mirror): read through `track`:

```ts
if (isPromise(input)) {
  const st = track(input as Promise<unknown>)
  if (st.status === 'fulfilled') {
    input = st.value              // unwrap a settled upstream value
  } else {
    // pending upstream: mirror suspension on the promise itself
    stashedResolution = null
    suspendedOn = null
    setPendingSig(true)
    if (lastResolvedValue === UNRESOLVED) {
      track(input as Promise<unknown>)
      setPublishedValue(input)
    }
    return null
  }
}
```

- [ ] **Step 4:** the three settled-publish sites — `setPublishedValue(resolvedAwaitable(x))` → `setPublishedValue(resolvedPromise(x))`; `publishResolvedAwaitable(x)` → `publishResolvedPromise(x)`. The bare-value sync branch (`resumeKind !== 'fast-forward'`) stays `setPublishedValue(outcome.value)`.
- [ ] **Step 5:** swap the import: drop `toAwaitable, resolvedAwaitable, AWAITABLE, AWAITABLE_SOURCE, Awaitable` from `./awaitable`; add `resolvedPromise, track` from `./async` (some already imported).
- [ ] **Step 6:** `pnpm test` — green (the pipeline/SWR/pending/generator behaviour is unchanged; only the carrier is plain now).
- [ ] **Step 7:** Commit: `computed: publish and read plain promises instead of Awaitables`.

---

## Phase 3 — Remove the `Awaitable` type and its symbols

Goal: delete the now-unused subclass machinery; the only readers left (`use`, `pending.ts`) already go through `track`.

### Task 3.1: delete `awaitable.ts`; drop the `AWAITABLE` branch in `use`

**Files:**
- Delete: `src/awaitable.ts`
- Modify: `src/async.ts` (the `use` fast-path + the `track` short-circuit + imports)
- Modify/replace: `test/awaitable.test.ts`

- [ ] **Step 1:** in `src/async.ts`, remove the `AWAITABLE`/`AWAITABLE_SOURCE`/`Awaitable` import; remove the `if (AWAITABLE in promise) return …` line from `track`; remove the `AWAITABLE in x` fast-path block from `use` (lines ~124–129) so `use` falls straight through to the generic `track(x)` path, throwing `NotReadyYet(x)` on the promise itself.
- [ ] **Step 2:** `grep -rn "awaitable\|AWAITABLE\|Awaitable" src/` → expect no hits. Delete `src/awaitable.ts`.
- [ ] **Step 3:** `test/awaitable.test.ts`: the tests that assert the `Awaitable` shape/brand no longer apply. Rewrite the ones that encode real behaviour (a promise reads as pending then fulfilled; a settled read is synchronous) against `track`/`resolvedPromise`/verbs; delete the ones that only asserted the subclass existed. Rename the file to `test/promise-state.test.ts` if its subject is now `track`.
- [ ] **Step 4:** `pnpm test` — green.
- [ ] **Step 5:** Commit: `async: remove the Awaitable subclass; read promise state only through track`.

---

## Phase 4 — Types: the read stops unwrapping the last stage

Goal: `computed(() => Promise<T>)` types as `Accessor<Promise<T>>`; `computed(() => T)` as `Accessor<T>`. Inter-stage inputs keep unwrapping via `Resolved`.

### Task 4.1: add `ReadOf` and retype the overloads

**Files:**
- Modify: `src/computed.ts` (overload return types)
- Modify: `src/async.ts` or `src/computed.ts` (add `ReadOf`)
- Test: `test/types.test-d.ts` if the repo has type tests; otherwise assert via `tsc`

- [ ] **Step 1:** add the read-type helper (preserves async colour; contrast `Resolved`, which unwraps for the next stage's input):

```ts
/** The public read type of a computed/derived stage: a synchronous return stays
 *  bare T; an async or generator return reads as Promise<T>. */
export type ReadOf<A> =
  A extends Promise<infer U>
    ? Promise<Awaited<U>>
    : A extends Generator<unknown, infer R, unknown>
      ? Promise<Awaited<R>>
      : A
```

- [ ] **Step 2:** change every overload's return from `Signal<Resolved<X>>` to `Signal<ReadOf<X>>`, where `X` is the *last* stage's return type parameter (`A`/`B`/`C`/`D`/`E`). Leave each `Stage<Resolved<…>, …>` input unchanged — inter-stage unwrapping is unaffected.
- [ ] **Step 3:** `pnpm exec tsc --noEmit` — resolve fallout. Expect test-side type assertions that assumed a bare `T` read (from the old write-back type) to need `Promise<T>` / a verb; fix them to match the new read type. A synchronous `computed(() => 1)` must still be `Accessor<number>`.
- [ ] **Step 4:** `pnpm test` green + `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5:** Commit: `computed: read type is Promise<T> for async stages, bare T for sync`.

---

## Phase 5 — Cleanup and review

### Task 5.1: verify and self-review

- [ ] `pnpm test` → 299-ish passing / 1 skipped (test *count* may shift where Phase 1/3 merged shape-assertions into single verb assertions — the executor confirms no behaviour is dropped, only re-expressed).
- [ ] `pnpm exec tsc --noEmit` clean.
- [ ] Sanity by hand: `computed(() => 1)()` is `1` (bare); `computed(async () => 1)()` is a `Promise`, `latest` reads `1` after settle, `use` suspends while pending; `signal(Promise.resolve(2))` reads its plain promise, `latest` reads `2`.
- [ ] `grep -rn "Awaitable" src/` → no hits.

### Task 5.2: independent review

Dispatch a review subagent to confirm: no test weakened (each `.value`/`.status` assertion became an equivalent verb assertion, not a looser one); pure-sync computeds still read bare; SWR (`latest` returns the prior during refetch) and suspension (`use` throws while pending) behaviour is intact; the generator fast-forward still works off `states`; `ReadOf` preserves async colour and leaves sync reads bare.

---

## Follow-up (separate, tracked outside this plan)

The docs sweep aligning `CONTEXT.md`, `questions.md`, `framings.md`, `README.md`, `scenario-traces.md`, and `docs/async/README.md` to the plain-`Promise` model (they still describe the `Awaitable` subclass). `read-model-migration-notes.md` is a historical study doc — leave it with a superseded pointer rather than rewrite.

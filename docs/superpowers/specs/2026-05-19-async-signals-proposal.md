# Async Signals: Generator-Based Derivation Model

## Motivation

Solid's current async signal model uses throw-for-flow-control (`NotReadyError`) and suspension boundaries (`<Loading>`) to "uncolor" async. While powerful for coordinated reveals, this architecture has inherent drawbacks:

- **No type safety** — `NotReadyError` is thrown, bypassing the type system. A signal's return type is `T` but may never produce `T` synchronously.
- **Coarse suspension** — `<Loading>` boundaries replace entire subtrees with fallbacks. Fine-grained per-element readiness (e.g., disabling a button) requires fighting the abstraction.
- **Implicit protocol** — `NotReadyError` must be special-cased at every layer: `recompute`, `read`, `isPending`, `latest`, boundary collection. The entire system is coupled to one policy: "async means suspend the owner."

The core idea of "uncoloring async" — collapsing async-ness so consumers just read a value — is powerful. But the suspension policy is not inherent to async derivations. It's one specific strategy.

## Proposal: Generator-Based Derivation

Instead of throwing promises up the call stack, signal computations become generators that pause internally and resume when dependencies resolve.

### Basic idea

```ts
const data = createSignal(function*() {
  const user = yield get(userSignal);
  const posts = yield get(fetchPosts(user.id));
  return posts;
});
```

- `get(signal)` reads a signal within the tracked scope, registering the dependency
- If the signal is ready, it returns the value synchronously
- If the signal is pending, the generator **pauses** — no `NotReadyError`, no owner suspension
- When the dependency resolves, the framework **resumes** the generator from where it paused
- While the generator is paused, `data()` returns `undefined` (or an explicit placeholder)

### Key properties

**No throwing.** The derivation knows internally whether it's resolved. Consumers just read it — the type is `T | undefined` (or `T | Placeholder`). Type-safe.

**No boundaries.** No `<Loading>` needed because no component gets unmounted. Each derivation independently tracks its own readiness. Every consumer decides what to show:

```ts
const posts = data();
// Fine-grained: no tree replacement
{posts ? <List items={posts} /> : <Spinner />}
```

**Internal suspension.** The generator is a local, scoped computation. Its suspension is invisible to the owner tree. The component tree is never replaced by a fallback — just individual reads resolve when they're ready.

### Stable promise identity & deduplication

Signal computations only re-execute when their tracked deps change. The promise produced by the computation is naturally stable between dep changes:

```ts
const [data] = createSignal(async () => {
  return fetch(`/api/posts/${userId()}`);
});
```

When `userId()` changes, `data` re-computes, a new promise is produced, and any derivation that yielded `get(data())` sees its dependency invalidated and re-executes from the top. No ambiguity about restart semantics — the signal graph encodes invalidation.

### `get()` as the bridge

`get(signal)` is the async-aware read primitive:

```
function get<T>(signal: () => T | Promise<T>): T
```

- Called within tracked scope (generator or otherwise)
- If the signal's current value is ready, returns it
- If it's a pending promise, registers the dependency and signals the runtime to pause
- The runtime schedules generator resumption when the promise resolves

## Comparison to current model

| Concern | Current (`NotReadyError` + `<Loading>`) | Generator model |
|----------|----------------------------------------|-----------------|
| Type safety | Thrown error bypasses types | `T \| undefined`, type-safe |
| Suspension granularity | Subtree replacement | Per-reader choice |
| Error control flow | Special exception protocol | No exceptions for control flow |
| Implementation surface | `recompute`, `read`, `boundary`, lane merging, `isPending`, `latest` | Generator scheduling + `get()` |
| Coordination | Coordinated reveals (update not done until data ready) | Uncoordinated per-signal readiness |
| Learning curve | Must understand boundaries, transitions, pending vs latest | Signals + generators |

## Open questions

### Generator restart semantics

When a dependency changes mid-flight, does the generator:
1. Reset entirely (discard all yielded state, start from top)?
2. Resume from the last unfulfilled `yield`?

Signal identity provides a clean answer: when a tracked dependency changes, the signal re-computes, and the generator restarts from the top. The previous yielded values are discarded because they depended on stale signal values.

### Error handling

Promises reject. In the current model, errors propagate through error boundaries. In the generator model, a `yield get()` that resolves to a rejection could either:
- Throw inside the generator (catchable with `try/catch` inside the generator body)
- Propagate outward to an error boundary

The generator-local catch seems more natural:

```ts
const data = createSignal(function*() {
  try {
    const user = yield get(userSignal);
    return user;
  } catch (e) {
    return fallbackUser;
  }
});
```

### Deduplication via WeakMap

For ad-hoc promises not backed by stable signals, a `WeakMap<Promise, result>` provides automatic deduplication:

```ts
const data = createSignal(function*() {
  const posts = yield fetch(`/api/posts/${userId()}`);
  // WeakMap keyed on promise identity
  // When promise resolves, WeakMap entry updates
  // Dependent derivations re-execute reactively
});
```

The WeakMap is keyed on promise identity, so the same promise yielded from multiple derivations resolves once. When nobody references the promise anymore, the WeakMap entry GCs — no manual cleanup.

But is the WeakMap even needed? If you always use `get(signal)` — and the signal's computation produces stable promises via dep-tracking — then signal identity is the only identity mechanism required. The WeakMap may only serve the case of raw `yield fetch(...)` without a signal wrapper.

### Optimistic / stale-while-revalidate

The generator model doesn't preclude optimistic patterns. A generator could yield progressively:

```ts
const data = createSignal(function*() {
  yield get(cacheSignal);       // show cached value immediately
  const fresh = yield get(fetchSignal);  // update when fresh arrives
  return fresh;
});
```

Each `yield` is a checkpoint. The signal updates on each checkpoint completion, so consumers see stale → fresh transitions naturally.

## Summary

The generator model replaces throw-based suspension with internal derivation pausing. The result is:
- Type-safe async signals (`T | undefined`)
- No boundary machinery (no `<Loading>`, no `isPending`, no `latest`)
- Fine-grained per-element readiness without subtree replacement
- Cleaner implementation surface (generator scheduling + `get()` vs. exception protocol + lane merging)

The tradeoff is losing coordinated reveals — the framework no longer guarantees "the whole subtree updates atomically." But that's a policy choice, not a primitive, and it can be built on top rather than baked into the foundation.

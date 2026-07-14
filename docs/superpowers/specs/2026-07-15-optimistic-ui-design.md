# Optimistic UI — the `optimistic()` wrapper and the `onSettle` scope-close hook

This spec turns the exploration in [`docs/pulse/optimistic-ui.md`](../../pulse/optimistic-ui.md) into an implementable design, adapted to the speculation engine as it exists today. The exploration's load-bearing recommendation — optimistic UI is a wrapper on top of a plain signal, not a feature baked into every signal — is carried through unchanged. What this spec adds is the concrete mechanism against the real primitives, and it corrects the exploration's claim that no engine-level support is required.

## Goal

Let an application show the predicted result of an in-flight action immediately, tagged as provisional, and have that provisional value revert cleanly if the action fails or settle into committed truth if it succeeds. A speculative scope isolates its writes from the outside world by default; optimistic UI deliberately punches through that isolation for one signal, in a controlled and explicitly-declared way.

## Public API

Two new names are exported from the package.

### `optimistic(signal)`

```ts
const [value, setValue] = signal(initial)
const [optimisticValue, setOptimisticValue, isOptimistic] = optimistic(value)
```

`optimistic` wraps an existing signal accessor and returns a three-tuple:

- **`optimisticValue`** — a reader. It returns the most recent live overlay value if any action currently has one, and otherwise the canonical value of the wrapped signal. It is reactive: a consumer binding to it re-runs when an overlay activates, changes, or clears, and when the underlying canonical value changes while no overlay is live.
- **`setOptimisticValue(v)`** — a setter. Called inside an action, it writes an overlay layer keyed to the enclosing speculative scope. Called with no active speculative scope, it throws, because an overlay with no owning action would never be cleared.
- **`isOptimistic`** — a closure-bound reactive boolean. It is true while any overlay is live on this wrapper and false otherwise. Because it is bound to the wrapper rather than being a walk over a node, each call site can rename it at destructure for its local meaning (`isSaving`, `hasPendingTask`).

The wrapped `value` reader is left untouched. Reading it directly always reports canonical committed truth and never sees the overlay. This is the two-reader split the exploration describes: business logic, derivations, and server-side rendering bind to `value`; the user interface binds to `optimisticValue`.

### `onSettle(callback)`

```ts
onSettle((outcome: 'committed' | 'discarded') => void): void
```

Registers a callback that fires exactly once when the current speculative scope closes. When the scope commits, the callback runs with the argument `'committed'`; when it is discarded, with `'discarded'`. A caller that does not care which face closed the scope ignores the argument. Called with no active speculative scope, `onSettle` throws.

`onSettle` is a general scope-lifecycle primitive, not specific to optimistic UI. The failure-handling exploration in [`docs/pulse/failure.md`](../../pulse/failure.md) proposes the same close-time hook for retry and error handling; that is the second consumer that justifies exposing it now rather than keeping it internal. A single hook that reports the outcome covers both a caller that runs the same teardown on either face (optimistic UI) and a caller that branches on the outcome (show an error only on discard).

The action handle itself — the identity of the scope that closed — is deliberately not exposed. `optimistic` keys its overlays on the current scope internally, and the key never escapes the wrapper, so there is no need to commit to a public action-handle concept (its identity, lifetime, and equality) yet.

## Engine change: scopes fire close callbacks on both faces

Today a `Scope` carries a `cleanups` array that `discard()` drains but `commit()` does not, and nothing anywhere registers into it. So the success path currently runs no close-time code at all. This is recorded as an open follow-up (`commit()` does not fire scope cleanups; `discard()` does). `onSettle` is the first registrar, and it needs to fire on both faces, so this design closes that follow-up.

A `Scope` gains a `settleCallbacks` list carrying functions of the outcome. Both closing paths drain it in last-in-first-out order:

- `commit(scope)` applies its promotions as it does today, then drains `settleCallbacks` with `'committed'`, then performs the final `stabilize()`.
- `discard(scope)` drains `settleCallbacks` with `'discarded'` alongside its existing teardown.

The ordering inside `commit` is load-bearing. Callbacks fire after the promotions are applied but before the single `stabilize()`. An optimistic overlay's close callback clears the overlay by writing its backing signal; the action's own `setValue` promotion writes the canonical signal. Both writes are ordinary committed writes, so both are absorbed into the one `stabilize()` that closes the commit, and a consumer of `optimisticValue` recomputes once against a coherent frame: the overlay is gone and the canonical value already holds the predicted value. There is no intermediate frame in which the overlay has cleared but the canonical promotion has not yet landed, so the user interface does not flicker back to the prior value on success.

## Overlay internals

`optimistic` is ordinary code built on the primitives above; it needs no further engine support. It lives in `src/optimistic.ts` and is exported from the package barrel.

Per wrapper it holds:

- `overlays: Map<Scope, T>` — one entry per action that currently has a live overlay. A `Map`'s iteration order is insertion order, so the most recently inserted entry is the top of the stack.
- one backing signal holding the current top-of-stack value, or an `EMPTY` sentinel when the stack is empty. This signal is what makes the reader and the query reactive.

`setOptimisticValue(v)`:

1. Read the current scope internally. If it is the root scope (no active speculation), throw.
2. `overlays.delete(scope)` then `overlays.set(scope, v)`, so a repeated write from the same action bumps that action to the top rather than adding a second entry.
3. Publish the new top to the backing signal, forcing the write to the root scope so it lands in committed state rather than in the writing action's isolated overlay. A write forced to root is visible to consumers binding outside the action and is a real reactive write. This is the deliberate leak.
4. On the first write for this scope, register a close callback with `onSettle` that removes this scope's entry and republishes the top (the next most recent live layer, or `EMPTY`). The callback ignores the outcome argument: an overlay clears the same way whether the action committed or was discarded, because on commit the canonical signal already carries the value and on discard it reverts to the prior value.

The two readers are derived signals over the backing signal:

- `optimisticValue` returns the wrapped signal's canonical value when the backing signal is `EMPTY`, and the backing signal's value otherwise.
- `isOptimistic` returns whether the backing signal is not `EMPTY`.

### Concurrent actions

When two actions write the same wrapper, both entries sit in the map and the most recent write shows. Each action's close callback removes only its own entry. If the action holding the visible top closes first, the reader falls to the next most recent live layer; when the last one closes, the reader falls back to the canonical value. There are no shared slots and no cross-action races, because each callback touches only its own key. In the common case of no concurrency, the map holds a single entry and behaves exactly like a flat overlay slot.

## The canonical pattern and rollback

```ts
action(function* () {
  setOptimisticValue(predicted)   // the user interface updates immediately
  yield* postToServer(predicted)  // wait for the server to confirm
  setValue(predicted)             // write the canonical committed value
})
```

A generator action body is used because it is fully speculative across the `yield*`: pulse drives the resumption and re-enters the scope, so a write made after the await is still scoped to the action. The overlay write and the canonical write are independent, and the action author makes both deliberately.

On **commit**, the canonical write promotes to committed state and the overlay clears in the same frame, so the reader stays on `predicted` with no flicker. On **discard** (the server rejected, so the body threw before reaching `setValue`), the canonical signal was never written, the overlay clears, and the reader falls back to the pre-action canonical value. The provisional value has reverted.

`setOptimisticValue` requires an active speculative scope. In an `async () => {}` action body the scope unwinds after the first `await`, so a call after the await runs at the root scope and throws. This mirrors the existing sharp edge that writes after an await in an async body land in committed state; the generator body is the supported shape for optimistic writes that follow an await.

Explicit dual-setter is the pattern for this version. The known cost is forgetting to write the canonical value, after which a committed action clears the overlay and the reader shows the pre-action value. An auto-promotion variant that queues the canonical write from `setOptimisticValue` is deferred until usage shows the footgun bites.

## Scope and non-goals

- Reading `optimisticValue` from inside another, unrelated action is out of scope for this version. The reader is intended for consumers outside the writing action, which is where optimistic user interfaces bind.
- Auto-promotion of the overlay into the canonical signal is deferred.
- Surfacing which action produced the current top overlay (an action-handle accessor for a "pending operations" list) is deferred, and the action handle stays internal.
- Long-lived, local-first optimism that outlives its action is deferred; the lifetime here is bounded by the action.

## Testing

New files `src/optimistic.ts` and `test/optimistic.test.ts`, plus `onSettle` coverage added to the existing `test/scope.test.ts`.

`onSettle`, at the scope level:

- fires with `'committed'` when the scope commits and with `'discarded'` when it is discarded;
- fires each registered callback exactly once, in last-in-first-out order;
- throws when called with no active speculative scope.

`optimistic`, through the public API:

- a consumer of `optimisticValue` outside the action sees the overlay value while the action is in flight, while a consumer of the wrapped `value` still sees canonical truth;
- on discard the reader reverts to the pre-action value;
- on commit with the canonical write present, the reader settles on the predicted value and re-renders once, not through an intermediate prior value;
- `isOptimistic` is true while an overlay is live and false once it clears, reactively;
- two concurrent actions writing the same wrapper show the most recent write, and each action's close removes only its own layer;
- `setOptimisticValue` throws when called with no active speculative scope.

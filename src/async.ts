import { isPromise } from './is-promise'
import { isPending, promiseOf } from './pending'
import { rawValueOf } from './failure'
import { NODE, type Accessor, type Signal } from './signal'
import { markUsedInBinding } from './transition-tracker'

/**
 * Records the most recent resolved value observed for each signal. Keyed on the
 * signal (accessor) object — entries are garbage-collected with the signal.
 */
const lastResolved = new WeakMap<object, unknown>()

/**
 * The latest *resolved* value of a signal. Returns `undefined` until the signal
 * first resolves, then always the most recent resolved value — it does NOT
 * revert to `undefined` while a newer promise is pending (stale-while-revalidate).
 * Reactive: reads `s()`, so it re-evaluates when the signal changes.
 */
export function latest<T>(s: Accessor<T>): Awaited<T> | undefined {
  // The TOLERANT read: it NEVER throws. A failed node still holds the value it
  // last resolved to, so read it raw — bypassing the accessor's error conversion —
  // and degrade to it. (The raw accessor throws; that is the strict view, and it is
  // what feeds an error boundary through `use`. The failure itself is queried with
  // `failure(s)`, so degrading here is not the same as ignoring it.)
  const value = rawValueOf(s)
  if (isPromise(value)) {
    const state = track(value as Promise<unknown>) // current state for this promise (re-read each call; track replaces the entry on settle)
    if (state.status === 'fulfilled') {
      lastResolved.set(s, state.value)
      return state.value as Awaited<T>
    }
    if (state.status === 'rejected') {
      // A rejected promise carries no value of its own, but may still hold a
      // stale-while-revalidate prior seeded at write time (see `track`) — read
      // that first, and only fall back to the last value `latest` itself
      // observed if nothing was ever seeded (a raw promise passed to `signal()`
      // that rejects before anything else reads it).
      const swr = state.value
      if (swr !== undefined) return swr as Awaited<T>
      return lastResolved.get(s) as Awaited<T> | undefined
    }
    // Still pending. The stale-while-revalidate prior is seeded onto the tracked
    // state by track(promise, prior) — from the signal setter, and from computed —
    // so read it from there. Fall back to the per-accessor cache below for a raw
    // promise that was never seeded (an initial promise passed to signal()).
    const swr = state.value
    if (swr !== undefined) return swr as Awaited<T>
    return lastResolved.get(s) as Awaited<T> | undefined
  }
  lastResolved.set(s, value as T)
  return value as Awaited<T>
}

/**
 * Thrown by `use` when a promise it depends on has not settled yet. Carries the
 * promise so the catcher (an effect) can re-run once it settles. This is NOT an
 * error — it is the opt-in suspension signal.
 */
export class NotReadyYet {
  constructor(readonly promise: Promise<unknown>) {}
}

// Re-exported so existing importers (driver, computed) are unchanged. It lives in
// its own module because `scope` needs it too, and scope -> async -> signal ->
// scope would be a cycle.
export { isGeneratorFunction } from './is-generator-function'

export type PromiseState =
  | { status: 'pending'; value?: unknown; reason?: unknown }
  | { status: 'fulfilled'; value: unknown; reason?: unknown }
  | { status: 'rejected'; value?: unknown; reason: unknown }

/**
 * Records the status of every promise `track` has seen, seeded with an optional
 * stale-while-revalidate prior, so a later read of the same promise can report
 * its result without waiting again. There is no longer any promise type that
 * bypasses this map. What is stored here: a promise a caller hands in directly —
 * the initial value passed to signal(), or a promise they built by hand — and
 * the plain promise an async or generator stage returns internally, which the
 * driver watches for settlement.
 */
const states = new WeakMap<Promise<unknown>, PromiseState>()

export function track(promise: Promise<unknown>, prior?: unknown): PromiseState {
  const existing = states.get(promise)
  if (existing) return existing
  const state: PromiseState = { status: 'pending', value: prior }
  states.set(promise, state)
  promise.then(
    (value) => states.set(promise, { status: 'fulfilled', value }),
    // A rejection carries no value of its own, but the seeded prior — read from
    // the pending entry this settle handler is about to replace — is carried
    // forward rather than dropped, so a tolerant read of a promise that rejected
    // can still degrade to the last value seen, the same as it does while the
    // promise is still pending.
    (reason) => states.set(promise, { status: 'rejected', reason, value: state.value }),
  )
  return state
}

/** A fresh already-fulfilled promise carrying `value`, recorded fulfilled in the
 *  state map so a synchronous read sees it settled at once. Used when an async
 *  computed's view settles: publishing a fresh promise re-fires consumers, and
 *  the map entry lets `use`/`latest` read the value without waiting a microtask. */
export function resolvedPromise<T>(value: T): Promise<T> {
  const p = Promise.resolve(value)
  states.set(p, { status: 'fulfilled', value })
  return p
}

/**
 * Resolve a possibly-async value synchronously.
 * - Accessor argument: if `isPending(x)()` is true (this stage OR any
 *   upstream stage is in-flight), throws `NotReadyYet(promiseOf(x)()!)` so
 *   the surrounding effect/binding can suspend. Otherwise returns the
 *   accessor's current value (possibly a Promise — handled by the next
 *   branches just like a plain Promise argument).
 * - Plain value -> returned as-is.
 * - Settled promise -> its resolved value (a settled rejection re-throws).
 * - Pending promise -> throws `NotReadyYet`.
 *
 * Intended for use inside effects and JSX bindings. After Plan B, `use(x)`
 * always throws on pipeline-pending — coherent multi-read snapshots inside
 * a `<Loading>` boundary fall out of the boundary's atomic-commit gather.
 */
// Accessor form returns `Awaited<R>` of the accessor's OWN return type, so a
// runtime-honest union read (`Promise<T> | U`) resolves to `T | U` — a single
// `() => T | Promise<T>` parameter would instead pin one member and reject the
// rest. Value form covers a plain value or a bare promise.
export function use<R>(x: () => R): Awaited<R>
export function use<T>(x: T): Awaited<T>
export function use(x: unknown): unknown {
  // Mark unconditionally — even if use() doesn't throw, the binding has
  // opted into transition coordination with the nearest <Loading> boundary.
  markUsedInBinding()
  if (typeof x === 'function') {
    const accessor = x as () => unknown
    // Call accessor() BEFORE the pending check so r3 dep edges are always
    // established, even on the throw path. Otherwise the caller's effect
    // would lose its sub on the accessor's underlying computed, r3 would
    // auto-dispose the pipeline (see docs/follow-ups.md: "r3 auto-disposes
    // computeds when their sub count drops to 0, mid-flow"), and new values
    // would never propagate after a refetch.
    x = accessor()
    if (isPending(accessor)()) {
      throw new NotReadyYet(promiseOf(accessor)()!)
    }
  }
  if (!isPromise(x)) return x
  const state = track(x)
  if (state.status === 'fulfilled') return state.value
  if (state.status === 'rejected') throw state.reason
  throw new NotReadyYet(x)
}

/**
 * The resolved-and-unwrapped type of a stage value or `read(x)` argument:
 * - If T is a Signal<U> or Accessor<U> (a callable returning U), the result is Awaited<U>.
 * - If T is a Generator returning R, the result is Awaited<R>.
 * - Otherwise the result is Awaited<T>.
 */
export type Resolved<T> = T extends Signal<infer U>
  ? Awaited<U>
  : T extends () => infer U
    ? Awaited<U>
    : T extends Generator<unknown, infer R, unknown>
      ? Awaited<R>
      : Awaited<T>

/** Unwrap a generator return to a promise (a generator stage always reads
 *  async); leave everything else — bare, a Promise, or a union — as it is. */
type Surface<S> = S extends Generator<unknown, infer R, unknown> ? Promise<Awaited<R>> : S

/** The whole type is a Promise or Generator (unconditionally async). Wrapped in
 *  tuples so a union is tested as a whole, not distributed. */
type DefinitelyAsync<X> =
  [X] extends [Promise<unknown>]
    ? true
    : [X] extends [Generator<unknown, unknown, unknown>]
      ? true
      : false

/** The type contains a Promise or Generator (possibly async — e.g. a union with
 *  a promise member). `Extract` finds it without distributing the conditional. */
type MaybeAsync<X> =
  [Extract<X, Promise<unknown> | Generator<unknown, unknown, unknown>>] extends [never] ? false : true

/** Reduce the upstream stages' return types to a single async colour. */
type UpstreamColor<Ups extends unknown[]> =
  true extends { [K in keyof Ups]: DefinitelyAsync<Ups[K]> }[number]
    ? 'def'
    : true extends { [K in keyof Ups]: MaybeAsync<Ups[K]> }[number]
      ? 'maybe'
      : 'sync'

/** The public read type of a computed/derived — runtime-honest. A definitely-
 *  async upstream forces a single `Promise`; a maybe-async upstream reflects both
 *  shapes (`Last | Promise<…>`); otherwise the last stage's own surface (which may
 *  itself be bare, a `Promise`, or a union). Inter-stage inputs unwrap via
 *  `Resolved<>`; this does not — the async colour stays visible in the read. */
export type PipelineRead<Ups extends unknown[], Last> =
  UpstreamColor<Ups> extends 'def'
    ? Promise<Awaited<Surface<Last>>>
    : UpstreamColor<Ups> extends 'maybe'
      ? Surface<Last> | Promise<Awaited<Surface<Last>>>
      : Surface<Last>

/** True if `x` looks like a pulse signal accessor (a function carrying NODE). */
function isSignalAccessor(x: unknown): x is Signal<unknown> {
  return typeof x === 'function' && NODE in (x as object)
}

/**
 * Generator-side resolver. Use as `yield* read(x)` inside a `function*` stage.
 * - x is a signal: the accessor is called (tracking the signal as a dep), and
 *   its value (which may be a `T` or a `Promise<T>`) is yielded.
 * - x is a promise: yielded directly (untracked).
 * - x is a plain value: yielded directly; the driver resumes immediately with it.
 *
 * `yield* read(x)` has type `Resolved<typeof x>` — per-yield inference, courtesy
 * of generator delegation.
 *
 * Plan A note: `read` does NOT consult any `[PENDING]` brand. Suspension is
 * driven solely by the driver's `settle()` over the yielded value. Coherent
 * snapshots and transitions are handled by the JSX boundary layer (Plan B),
 * not by `read`.
 */
export function* read<T>(x: T): Generator<unknown, Resolved<T>, unknown> {
  if (isSignalAccessor(x)) {
    return (yield (x as () => unknown)()) as Resolved<T>
  }
  return (yield x) as Resolved<T>
}

/**
 * Wait-for-all coordination barrier — the plural form of `yield* read(x)`. Use as
 * `const [a, b] = yield* settled([A, B])` inside a generator stage. Suspends until
 * EVERY input has settled and resolves to the tuple of fresh values, so a shared
 * consumer swaps to the new frame atomically (never a half-updated frame).
 *
 * Unlike `read`, which is stale-while-revalidate tolerant (it yields the stale
 * value during a refetch), `settled` awaits each refetching input's IN-FLIGHT
 * promise — reached through the pending registry (`promiseOf`), not the stale
 * value the raw read returns — so the frame is genuinely fresh once it resolves.
 * A settled rejection propagates (via `Promise.all`), routing to the boundary.
 */
export function* settled<T extends readonly unknown[]>(
  inputs: readonly [...T],
): Generator<unknown, { [K in keyof T]: Resolved<T[K]> }, unknown> {
  const inflight: Promise<unknown>[] = []
  for (const x of inputs) {
    if (isSignalAccessor(x)) {
      const v = x() // establish the dependency (re-run when this input changes)
      const p = isPending(x)() ? promiseOf(x)() : null
      if (p) inflight.push(p)
      else if (isPromise(v) && track(v as Promise<unknown>).status === 'pending') {
        inflight.push(v as Promise<unknown>)
      }
    } else if (isPromise(x) && track(x as Promise<unknown>).status === 'pending') {
      // Only await a promise that has NOT settled yet. `Promise.all` builds a FRESH
      // promise every run, and a fresh promise is always initially pending — so the
      // driver cannot fast-forward it (its fast-forward is keyed on promise
      // identity). Re-adding an already-settled promise on each re-run would make
      // the stage suspend, kick, re-run and suspend again forever, starving the
      // event loop. Filtering settled promises out keeps it converging.
      inflight.push(x as Promise<unknown>)
    }
  }
  // Suspend until every in-flight input has settled — then the frame is coherent.
  if (inflight.length > 0) yield Promise.all(inflight)
  // Read the fresh resolved values. A rejected input THROWS (as `read`/`use` do)
  // rather than reading `.value` off a rejected state, which is always undefined.
  return inputs.map((x) => {
    const v = isSignalAccessor(x) ? (x as () => unknown)() : x
    if (!isPromise(v)) return v
    const state = track(v as Promise<unknown>)
    if (state.status === 'rejected') throw state.reason
    return state.value
  }) as { [K in keyof T]: Resolved<T[K]> }
}

import { isPromise } from './is-promise'
import { NODE, type Signal } from './signal'

/** Reactive predicate: is the signal's current value a (pending) promise? */
export function isPending(s: Signal<unknown>): boolean {
  return isPromise(s())
}

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
export function latest<T>(s: Signal<T>): Awaited<T> | undefined {
  const value = s()
  if (isPromise(value)) {
    return lastResolved.get(s) as Awaited<T> | undefined
  }
  lastResolved.set(s, value)
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

/** True if `f` is declared with `function*` (a generator function). */
export function isGeneratorFunction(f: unknown): f is (...args: unknown[]) => Generator<unknown, unknown, unknown> {
  return typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'GeneratorFunction'
}

/** True if `f` is declared with `async function` (an async function). */
export function isAsyncFunction(f: unknown): f is (...args: unknown[]) => Promise<unknown> {
  return typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction'
}

type PromiseState =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; reason: unknown }

/** Tracks every promise `use` has seen, so later calls can resolve synchronously. */
const states = new WeakMap<Promise<unknown>, PromiseState>()

export function track(promise: Promise<unknown>): PromiseState {
  const existing = states.get(promise)
  if (existing) return existing
  const state: PromiseState = { status: 'pending' }
  states.set(promise, state)
  promise.then(
    (value) => states.set(promise, { status: 'fulfilled', value }),
    (reason) => states.set(promise, { status: 'rejected', reason }),
  )
  return state
}

/**
 * Resolve a possibly-async value synchronously.
 * - Plain value -> returned as-is.
 * - Settled promise -> its resolved value (a settled rejection re-throws its reason).
 * - Pending promise -> throws `NotReadyYet` (caught by the nearest effect).
 *
 * Intended for use inside effects (including, later, JSX bindings). Using it
 * inside a `computed` is allowed but a code smell — the computed becomes
 * throw-on-read.
 */
export function use<T>(x: T): Awaited<T> {
  if (!isPromise(x)) return x as Awaited<T>
  const state = track(x)
  if (state.status === 'fulfilled') return state.value as Awaited<T>
  if (state.status === 'rejected') throw state.reason
  throw new NotReadyYet(x)
}

/**
 * The resolved-and-unwrapped type of a stage value or `read(x)` argument:
 * - If T is a Signal<U>, the result is Awaited<U>.
 * - If T is a Generator returning R, the result is Awaited<R>.
 * - Otherwise the result is Awaited<T>.
 */
export type Resolved<T> = T extends Signal<infer U>
  ? Awaited<U>
  : T extends Generator<unknown, infer R, unknown>
    ? Awaited<R>
    : Awaited<T>

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
 */
export function* read<T>(x: T): Generator<unknown, Resolved<T>, unknown> {
  const value = isSignalAccessor(x) ? (x as () => unknown)() : x
  return (yield value) as Resolved<T>
}

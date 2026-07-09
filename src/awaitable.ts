/** Brand symbol that marks a Promise as an Awaitable (interface, not class, so
 *  `instanceof` cannot be used — check `AWAITABLE in promise` instead). */
export const AWAITABLE = Symbol('awaitable')

/** Non-enumerable key storing the original source promise on an Awaitable. Used
 *  by `use()` to throw `NotReadyYet(source)` — subscribing to the source (not
 *  the chained awaitable) preserves pre-migration timing: the binding reruns in
 *  the same microtask batch as the source settles. */
export const AWAITABLE_SOURCE = Symbol('awaitable.source')

/** A `Promise<T>` carrying synchronous inspection fields. Per ADR 0011 /
 *  async-reads-and-coordination.md: `s()` async reads return one of these
 *  uniformly (no write-back). `.value` is the stale-while-revalidate read
 *  (seeded with the prior while pending); `.status` disambiguates. */
export interface Awaitable<T> extends Promise<T> {
  status: 'pending' | 'fulfilled' | 'rejected'
  value: T | undefined
  reason: unknown
}

/** Wrap a source promise as an `Awaitable`, seeding `.value` with `prior` for
 *  stale-while-revalidate. Does not mutate `source` (chains a fresh promise).
 *
 *  Status-update handlers are registered on `source` (not on the chained `a`)
 *  so that `a.status` is updated in the same microtask batch as `source`
 *  settles — which ensures callers that subscribed to `source` via
 *  `NotReadyYet(source)` see the updated status when they rerun. */
export function toAwaitable<T>(source: Promise<T>, prior?: T): Awaitable<T> {
  const a = source.then((v) => v) as Awaitable<T>
  a.status = 'pending'
  a.value = prior
  a.reason = undefined
  Object.defineProperty(a, AWAITABLE, { value: true, enumerable: false, writable: false, configurable: false })
  Object.defineProperty(a, AWAITABLE_SOURCE, { value: source, enumerable: false, writable: false, configurable: false })
  // Register on source (not on a) so status fields are set in the same
  // microtask batch as source settles — before any handler the caller
  // registered on source after calling toAwaitable.
  source.then(
    (v) => {
      a.status = 'fulfilled'
      a.value = v
    },
    (e) => {
      a.status = 'rejected'
      a.reason = e
    },
  )
  return a
}

/** A pre-fulfilled Awaitable carrying `value`. Used when an async computed view settles:
 *  publishing a FRESH fulfilled Awaitable (distinct object) re-fires consumers
 *  while keeping the view an Awaitable (no write-back to bare T). */
export function resolvedAwaitable<T>(value: T): Awaitable<T> {
  const a = toAwaitable(Promise.resolve(value), value)
  a.status = 'fulfilled'
  a.value = value
  return a
}

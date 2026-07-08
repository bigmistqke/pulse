/** Brand symbol that marks a Promise as an Awaitable (interface, not class, so
 *  `instanceof` cannot be used — check `AWAITABLE in promise` instead). */
export const AWAITABLE = Symbol('awaitable')

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
 *  stale-while-revalidate. Does not mutate `source` (chains a fresh promise). */
export function toAwaitable<T>(source: Promise<T>, prior?: T): Awaitable<T> {
  const a = source.then((v) => v) as Awaitable<T>
  a.status = 'pending'
  a.value = prior
  a.reason = undefined
  Object.defineProperty(a, AWAITABLE, { value: true, enumerable: false, writable: false, configurable: false })
  a.then(
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

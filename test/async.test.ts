import { describe, expect, test } from 'vitest'
import { peek, use, NotReadyYet, from, track, resolvedPromise } from '../src/async'
import { isPending } from '../src/pending'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { computed } from '../src/computed'
import { signal } from '../src/signal'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon spec-a-signals-pending-state-is-the-state-of-the-promise-it-holds
 */
test('isPending is false for a signal holding a plain value', () => {
  const [s] = signal(0)
  expect(isPending(s)).toBe(false)
})

/**
 * @canon spec-a-signals-pending-state-is-the-state-of-the-promise-it-holds
 */
test('isPending is true for a signal holding a pending promise', () => {
  const [s] = signal(new Promise<number>(() => {}))
  expect(isPending(s)).toBe(true)
})

/**
 * @canon spec-peek-returns-undefined-before-anything-resolved
 */
test('peek is undefined before the first resolution', () => {
  const [s] = signal(new Promise<number>(() => {})) // never resolves
  expect(peek(s)).toBeUndefined()
})

/**
 * @canon spec-peek-returns-the-last-resolved-value
 */
test('peek returns the resolved value after the promise settles', async () => {
  const [s] = signal(Promise.resolve(1))
  expect(peek(s)).toBeUndefined()
  await tick()
  expect(peek(s)).toBe(1)
})

/**
 * @canon spec-peek-keeps-the-last-resolved-value-while-a-newer-promise-is-pending
 */
test('peek keeps the last resolved value while a newer promise is pending', async () => {
  const [s, setS] = signal<Promise<number>>(Promise.resolve(1))
  await tick()
  expect(peek(s)).toBe(1)

  let release!: (v: number) => void
  setS(new Promise<number>((resolve) => { release = resolve }))
  expect(peek(s)).toBe(1) // still 1 — does NOT revert to undefined

  release(2)
  await tick()
  expect(peek(s)).toBe(2) // now the new resolved value
})

/**
 * @canon spec-peek-returns-a-given-fallback-until-a-value-resolves
 */
test('peek(s, fallback) returns the fallback before the first resolution', () => {
  const [s] = signal(new Promise<number[]>(() => {})) // never resolves
  expect(peek(s, [] as number[])).toEqual([])
})

/**
 * @canon spec-peek-returns-a-given-fallback-until-a-value-resolves
 */
test('peek(s, fallback) reports the real value once resolved, not the fallback', async () => {
  const [s] = signal(Promise.resolve([1, 2]))
  expect(peek(s, [] as number[])).toEqual([])
  await tick()
  expect(peek(s, [] as number[])).toEqual([1, 2])
})

/**
 * @canon spec-peek-returns-a-given-fallback-until-a-value-resolves
 */
test('peek(s, fallback) falls back again after a rejection with nothing seeded', () => {
  const [s] = signal(Promise.reject(new Error('nope')))
  expect(peek(s, 'fallback')).toBe('fallback')
})

/**
 * @canon spec-a-signal-stores-a-promise-as-it-is
 */
test('peek is reactive — updates when the signal is written to a new value', async () => {
  // peek re-runs the effect when the signal *value* changes (a write). It does
  // NOT push on the same-Promise-settling, since signal stores values as-is and
  // r3 dirties only on writes. For "push on settle," reach for `computed(() => p)`.
  setScheduler(syncScheduler(flush))
  const [s, setS] = signal<Promise<number>>(new Promise<number>(() => {}))
  const seen: Array<number | undefined> = []
  effect(() => { seen.push(peek(s)) })
  expect(seen).toEqual([undefined]) // pending — no prior resolution
  setS(Promise.resolve(1))           // write: effect re-runs
  // peek will see 'pending' synchronously (state not yet drained), so still undefined
  expect(seen).toEqual([undefined, undefined])
  await new Promise<void>((resolve) => setTimeout(resolve))
  flush()
  expect(seen).toEqual([undefined, undefined]) // the promise settling is not a write
  setScheduler(microtaskScheduler(flush))
})

/**
 * @canon spec-track-seeds-the-stale-prior
 */
test('track seeds the stale prior on a pending promise', () => {
  const p = new Promise<number>(() => {}) // never settles
  expect(track(p, 7).value).toBe(7)
  expect(track(p).status).toBe('pending')
})

/**
 * @canon spec-a-published-result-reads-fulfilled-at-once
 */
test('resolvedPromise reads as fulfilled synchronously', () => {
  const p = resolvedPromise(42)
  expect(track(p).status).toBe('fulfilled')
  expect(track(p).value).toBe(42)
})

/**
 * @canon spec-a-promise-carries-its-state-in-one-weakmap
 */
test('a promise pulse tracks and settles carries no state of its own; its state is read from the map', async () => {
  // Frozen, so an implementation that wrote status or value onto the promise
  // would throw here (modules run in strict mode) instead of passing silently.
  const fulfils = Object.freeze(Promise.resolve(3))
  const failure = new Error('nope')
  const rejects = Object.freeze(Promise.reject(failure))
  rejects.catch(() => {})
  const [a] = signal(fulfils)
  const [b] = signal(rejects)
  expect(() => use(a)).toThrow(NotReadyYet)
  expect(() => use(b)).toThrow(NotReadyYet)

  // A promise written over a settled one is pending and holds the prior it
  // replaces, so a stale read can return that prior.
  const [c, setC] = signal<Promise<number>>(Promise.resolve(10))
  await tick()
  expect(use(c)).toBe(10)
  let release!: (v: number) => void
  const refetch = Object.freeze(new Promise<number>((resolve) => { release = resolve }))
  setC(refetch)
  expect(() => use(c)).toThrow(NotReadyYet)
  expect(peek(c)).toBe(10)
  release(20)
  // An async computed publishes a promise of its own when it settles.
  const d = computed(async () => 5)
  d()
  await tick()

  expect(use(a)).toBe(3)
  expect(() => use(b)).toThrow(failure)
  expect(use(c)).toBe(20)
  expect(use(d)).toBe(5)
  // The status, value, reason and prior were all read back through the map;
  // none of the promises gained a property.
  for (const p of [fulfils, rejects, refetch, d()]) {
    expect(Reflect.ownKeys(p)).toEqual([])
  }
  expect(track(fulfils)).toMatchObject({ status: 'fulfilled', value: 3 })
  expect(track(rejects)).toMatchObject({ status: 'rejected', reason: failure })
})

/**
 * @canon spec-use-returns-a-value-that-is-not-a-promise-unchanged
 */
test('use returns a plain (non-promise) value unchanged', () => {
  expect(use(5)).toBe(5)
  expect(use('hello')).toBe('hello')
})

/**
 * @canon spec-use-returns-a-value-that-is-not-a-promise-unchanged
 */
test('use(0) returns 0 (falsy value, not pending)', () => {
  expect(use(0)).toBe(0)
})

/**
 * @canon spec-use-returns-a-value-that-is-not-a-promise-unchanged
 */
test('use(null) returns null', () => {
  expect(use(null)).toBe(null)
})

/**
 * @canon spec-use-returns-a-value-that-is-not-a-promise-unchanged
 */
test('use(undefined) returns undefined', () => {
  expect(use(undefined)).toBe(undefined)
})

/**
 * @canon spec-use-returns-a-value-that-is-not-a-promise-unchanged
 */
test('use(false) returns false', () => {
  expect(use(false)).toBe(false)
})

/**
 * @canon spec-use-returns-a-value-that-is-not-a-promise-unchanged
 */
test('use("") returns empty string', () => {
  expect(use('')).toBe('')
})

/**
 * @canon spec-use-throws-not-ready-yet-carrying-a-pending-promise
 */
test('use throws NotReadyYet for a pending promise', () => {
  const pending = new Promise<number>(() => {})
  expect(() => use(pending)).toThrow(NotReadyYet)
})

/**
 * @canon spec-use-throws-not-ready-yet-carrying-a-pending-promise
 */
test('the thrown NotReadyYet carries the promise', () => {
  const pending = new Promise<number>(() => {})
  try {
    use(pending)
    throw new Error('use should have thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(NotReadyYet)
    expect((e as NotReadyYet).promise).toBe(pending)
  }
})

/**
 * @canon spec-use-treats-a-promise-it-has-not-seen-settle-as-pending
 */
test('use resolves a promise synchronously once it has settled', async () => {
  const p = Promise.resolve(7)
  expect(() => use(p)).toThrow(NotReadyYet) // first call: still pending to use
  await tick()
  expect(use(p)).toBe(7) // settled now — use returns synchronously
})

/**
 * @canon spec-use-re-throws-a-settled-promises-rejection
 */
test('use re-throws the rejection reason of a settled rejected promise', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  expect(() => use(p)).toThrow(NotReadyYet) // first call: pending
  await tick()
  expect(() => use(p)).toThrow('boom') // settled rejected: re-throws the reason
})

/**
 * @canon spec-from-yields-what-it-is-given
 */
test('from of a plain value yields it; yield* expression resolves to it', () => {
  // Drive `from(42)` manually (no driver yet here — we drive by hand for the unit test).
  const gen = from(42)
  const step = gen.next()
  expect(step.done).toBe(false)
  expect(step.value).toBe(42)
  const final = gen.next(42)
  expect(final.done).toBe(true)
  expect(final.value).toBe(42)
})

/**
 * @canon spec-from-yields-what-it-is-given
 */
test('from of a signal calls its accessor (tracking happens via the call)', () => {
  const [s] = signal(7)
  const gen = from(s)
  const step = gen.next()
  expect(step.value).toBe(7) // s() was called; yields its value
  const final = gen.next(7)
  expect(final.value).toBe(7)
})

/**
 * @canon spec-from-yields-what-it-is-given
 */
test('from of a promise yields the promise itself', () => {
  const p = Promise.resolve(1)
  const gen = from(p)
  const step = gen.next()
  expect(step.value).toBe(p)
})

/**
 * @canon spec-use-of-an-accessor-reads-what-the-accessor-returns
 */
test('use() accepts an accessor (signal getter)', () => {
  const [count] = signal(42)
  expect(use(count)).toBe(42)
})

/**
 * @canon spec-use-of-an-accessor-reads-what-the-accessor-returns
 */
test('use() accessor form unwraps pending promises (throws NotReadyYet)', () => {
  const [s] = signal<Promise<number>>(new Promise(() => {}))
  expect(() => use(s)).toThrow(NotReadyYet)
})


// Plan B: use(accessor) now throws NotReadyYet when isPending(accessor) is true.
// For the "give me stale" semantics, use `peek(c)` instead.
/**
 * @canon spec-use-of-an-accessor-throws-while-it-is-pending
 */
test('use(accessor) throws NotReadyYet during SWR refetch (Plan B behavior; use peek() for stale)', async () => {
  const [id, setId] = signal(1)
  let release!: (v: number) => void
  const c = computed(() => {
    const i = id()
    if (i === 1) return Promise.resolve(10)
    return new Promise<number>((r) => { release = r })
  })
  await tick()
  expect(use(c)).toBe(10)

  setId(2)
  // SWR: c() returns stale 10, but use(c) now throws because isPending(c) is true.
  // Callers that want the stale value should use peek(c) instead.
  expect(isPending(c)).toBe(true)
  expect(peek(c)).toBe(10) // peek() still gives the stale value
  expect(() => use(c)).toThrow(NotReadyYet) // use() now throws on pipeline-pending

  release(20)
  await tick()
  expect(use(c)).toBe(20)
})


describe('use(accessor) — Plan B: throws on isPending', () => {
  /**
   * @canon spec-use-of-an-accessor-throws-while-it-is-pending
   */
  test('use(swrComputed) throws NotReadyYet during refetch, even though accessor returns stale', async () => {
    const [page, setPage] = signal(1)
    let activeResolve: (v: string) => void = () => {}
    const c = computed(() => {
      page()
      return new Promise<string>((r) => (activeResolve = r))
    })
    // Prime first load
    c()
    await new Promise<void>((r) => queueMicrotask(r))
    activeResolve('v1')
    await new Promise<void>((r) => queueMicrotask(r))
    // Plain-promise read model: after settle the view reads as fulfilled via peek().
    expect(peek(c)).toBe('v1')

    // Trigger refetch.
    setPage(2)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(peek(c)).toBe('v1') // SWR-stale

    // BUT use(c) must throw NotReadyYet now, carrying the in-flight promise.
    expect(isPending(c)).toBe(true)
    let threw: unknown = null
    try {
      use(c)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(NotReadyYet)
    const { promiseOf } = await import('../src/pending')
    expect((threw as NotReadyYet).promise).toBe(promiseOf(c))
  })
})

// use.latest()'s mirror-image contract (ADR 0014): throws only while latest(x)
// has genuinely never resolved anything; once it has, an SWR refetch that
// would make use(x) throw returns the stale value instead. use(x) itself is
// unchanged — the tests above stay correct and untouched.
describe('use.latest(accessor) — throws only before the first value, tolerant after', () => {
  /**
   * @canon spec-use-latest-throws-only-before-the-first-value
   */
  test('throws NotReadyYet while nothing has ever resolved, exactly like use()', () => {
    const [s] = signal<Promise<number>>(new Promise(() => {})) // never resolves
    expect(() => use.latest(s)).toThrow(NotReadyYet)
  })

  /**
   * @canon spec-use-latest-throws-only-before-the-first-value
   */
  test('the thrown NotReadyYet carries the in-flight promise, exactly like use()', async () => {
    const [s] = signal<Promise<number>>(new Promise(() => {}))
    let threw: unknown = null
    try {
      use.latest(s)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(NotReadyYet)
    const { promiseOf } = await import('../src/pending')
    expect((threw as NotReadyYet).promise).toBe(promiseOf(s))
  })

  /**
   * @canon spec-use-latest-returns-the-last-resolved-value-during-a-refetch
   */
  test('returns the resolved value once settled, same as use()', async () => {
    const [s] = signal(Promise.resolve(10))
    await tick()
    expect(use.latest(s)).toBe(10)
  })

  /**
   * @canon spec-use-latest-returns-the-last-resolved-value-during-a-refetch
   */
  test('does NOT throw during an SWR refetch — returns the stale value instead of use()\'s throw', async () => {
    const [id, setId] = signal(1)
    let release!: (v: number) => void
    const c = computed(() => {
      const i = id()
      if (i === 1) return Promise.resolve(10)
      return new Promise<number>((r) => { release = r })
    })
    await tick()
    expect(use.latest(c)).toBe(10)

    setId(2)
    expect(isPending(c)).toBe(true)
    // use(c) would throw here (see the Plan B test above) — use.latest(c) does not.
    expect(use.latest(c)).toBe(10)
    expect(() => use(c)).toThrow(NotReadyYet)

    release(20)
    await tick()
    expect(use.latest(c)).toBe(20)
  })

  /**
   * @canon spec-use-latest-returns-the-last-resolved-value-during-a-refetch
   */
  test('use(swrComputed) throwing during refetch and use.latest(swrComputed) returning stale are both true at once', async () => {
    const [page, setPage] = signal(1)
    let activeResolve: (v: string) => void = () => {}
    const c = computed(() => {
      page()
      return new Promise<string>((r) => (activeResolve = r))
    })
    c()
    await new Promise<void>((r) => queueMicrotask(r))
    activeResolve('v1')
    await new Promise<void>((r) => queueMicrotask(r))
    expect(use.latest(c)).toBe('v1')

    setPage(2)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(isPending(c)).toBe(true)
    expect(() => use(c)).toThrow(NotReadyYet)
    expect(use.latest(c)).toBe('v1')
  })
})

describe('from — post-Plan-A (no brand suspension)', () => {
  /**
   * @canon spec-from-yields-the-stale-value-during-a-refetch
   */
  test('yield* from on an SWR-refetching computed yields the stale value, NOT brand.promise', async () => {
    const [page, setPage] = signal(1)
    let activeResolve: (v: string) => void = () => {}
    const c = computed(() => {
      page() // declare dep
      return new Promise<string>((r) => { activeResolve = r })
    })

    // First load: prime the SWR cache.
    c() // subscribe / kick first-eval
    await new Promise<void>((r) => queueMicrotask(r))
    activeResolve('v1')
    await new Promise<void>((r) => queueMicrotask(r))
    expect(peek(c)).toBe('v1')

    // Trigger refetch — accessor goes SWR-stale, suspendedOn becomes new Promise.
    setPage(2)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(peek(c)).toBe('v1') // SWR-stale

    // Plan A: read yields the stale value directly. The view is now a plain
    // promise whose WeakMap state is fulfilled/stale, carrying the stale value —
    // the driver's settle() unwraps it to 'v1' on resume. The key point (still
    // asserted): it is fulfilled/stale, NOT a pending in-flight promise.
    const gen = from(c)
    const first = gen.next()
    const yielded = first.value as Promise<string>
    expect(track(yielded).status).toBe('fulfilled')
    expect(track(yielded).value).toBe('v1')
    // (Under the pre-Plan-A brand-aware read, first.value would have been
    // the new in-flight Promise from brand.promise(), not the stale 'v1'.)

    activeResolve('v2')
  })
})

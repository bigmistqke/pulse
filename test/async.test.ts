import { describe, expect, test } from 'vitest'
import { latest, use, NotReadyYet, from, track, resolvedPromise } from '../src/async'
import { isPending } from '../src/pending'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { computed } from '../src/computed'
import { signal } from '../src/signal'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('isPending is false for a signal holding a plain value', () => {
  const [s] = signal(0)
  expect(isPending(s)).toBe(false)
})

test('isPending is true for a signal holding a pending promise', () => {
  const [s] = signal(new Promise<number>(() => {}))
  expect(isPending(s)).toBe(true)
})

test('latest is undefined before the first resolution', () => {
  const [s] = signal(new Promise<number>(() => {})) // never resolves
  expect(latest(s)).toBeUndefined()
})

test('latest returns the resolved value after the promise settles', async () => {
  const [s] = signal(Promise.resolve(1))
  expect(latest(s)).toBeUndefined()
  await tick()
  expect(latest(s)).toBe(1)
})

test('latest keeps the last resolved value while a newer promise is pending', async () => {
  const [s, setS] = signal<Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(s)).toBe(1)

  let release!: (v: number) => void
  setS(new Promise<number>((resolve) => { release = resolve }))
  expect(latest(s)).toBe(1) // still 1 — does NOT revert to undefined

  release(2)
  await tick()
  expect(latest(s)).toBe(2) // now the new resolved value
})

test('latest(s, fallback) returns the fallback before the first resolution', () => {
  const [s] = signal(new Promise<number[]>(() => {})) // never resolves
  expect(latest(s, [] as number[])).toEqual([])
})

test('latest(s, fallback) reports the real value once resolved, not the fallback', async () => {
  const [s] = signal(Promise.resolve([1, 2]))
  expect(latest(s, [] as number[])).toEqual([])
  await tick()
  expect(latest(s, [] as number[])).toEqual([1, 2])
})

test('latest(s, fallback) falls back again after a rejection with nothing seeded', () => {
  const [s] = signal(Promise.reject(new Error('nope')))
  expect(latest(s, 'fallback')).toBe('fallback')
})

test('latest is reactive — updates when the signal is written to a new value', () => {
  // latest re-runs the effect when the signal *value* changes (a write). It does
  // NOT push on the same-Promise-settling, since signal stores values as-is and
  // r3 dirties only on writes. For "push on settle," reach for `computed(() => p)`.
  setScheduler(syncScheduler(flush))
  const [s, setS] = signal<Promise<number>>(new Promise<number>(() => {}))
  const seen: Array<number | undefined> = []
  effect(() => { seen.push(latest(s)) })
  expect(seen).toEqual([undefined]) // pending — no prior resolution
  setS(Promise.resolve(1))           // write: effect re-runs
  // latest will see 'pending' synchronously (state not yet drained), so still undefined
  expect(seen).toEqual([undefined, undefined])
  setScheduler(microtaskScheduler(flush))
})

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

test('use returns a plain (non-promise) value unchanged', () => {
  expect(use(5)).toBe(5)
  expect(use('hello')).toBe('hello')
})

test('use(0) returns 0 (falsy value, not pending)', () => {
  expect(use(0)).toBe(0)
})

test('use(null) returns null', () => {
  expect(use(null)).toBe(null)
})

test('use(undefined) returns undefined', () => {
  expect(use(undefined)).toBe(undefined)
})

test('use(false) returns false', () => {
  expect(use(false)).toBe(false)
})

test('use("") returns empty string', () => {
  expect(use('')).toBe('')
})

test('use throws NotReadyYet for a pending promise', () => {
  const pending = new Promise<number>(() => {})
  expect(() => use(pending)).toThrow(NotReadyYet)
})

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

test('use resolves a promise synchronously once it has settled', async () => {
  const p = Promise.resolve(7)
  expect(() => use(p)).toThrow(NotReadyYet) // first call: still pending to use
  await tick()
  expect(use(p)).toBe(7) // settled now — use returns synchronously
})

test('use re-throws the rejection reason of a settled rejected promise', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  expect(() => use(p)).toThrow(NotReadyYet) // first call: pending
  await tick()
  expect(() => use(p)).toThrow('boom') // settled rejected: re-throws the reason
})

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

test('from of a signal calls its accessor (tracking happens via the call)', () => {
  const [s] = signal(7)
  const gen = from(s)
  const step = gen.next()
  expect(step.value).toBe(7) // s() was called; yields its value
  const final = gen.next(7)
  expect(final.value).toBe(7)
})

test('from of a promise yields the promise itself', () => {
  const p = Promise.resolve(1)
  const gen = from(p)
  const step = gen.next()
  expect(step.value).toBe(p)
})

test('use() accepts an accessor (signal getter)', () => {
  const [count] = signal(42)
  expect(use(count)).toBe(42)
})

test('use() accessor form unwraps pending promises (throws NotReadyYet)', () => {
  const [s] = signal<Promise<number>>(new Promise(() => {}))
  expect(() => use(s)).toThrow(NotReadyYet)
})


// Plan B: use(accessor) now throws NotReadyYet when isPending(accessor) is true.
// For the "give me stale" semantics, use `latest(c)` instead.
test('use(accessor) throws NotReadyYet during SWR refetch (Plan B behavior; use latest() for stale)', async () => {
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
  // Callers that want the stale value should use latest(c) instead.
  expect(isPending(c)).toBe(true)
  expect(latest(c)).toBe(10) // latest() still gives the stale value
  expect(() => use(c)).toThrow(NotReadyYet) // use() now throws on pipeline-pending

  release(20)
  await tick()
  expect(use(c)).toBe(20)
})


describe('use(accessor) — Plan B: throws on isPending', () => {
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
    // Plain-promise read model: after settle the view reads as fulfilled via latest().
    expect(latest(c)).toBe('v1')

    // Trigger refetch.
    setPage(2)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(latest(c)).toBe('v1') // SWR-stale

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
  test('throws NotReadyYet while nothing has ever resolved, exactly like use()', () => {
    const [s] = signal<Promise<number>>(new Promise(() => {})) // never resolves
    expect(() => use.latest(s)).toThrow(NotReadyYet)
  })

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

  test('returns the resolved value once settled, same as use()', async () => {
    const [s] = signal(Promise.resolve(10))
    await tick()
    expect(use.latest(s)).toBe(10)
  })

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
    expect(latest(c)).toBe('v1')

    // Trigger refetch — accessor goes SWR-stale, suspendedOn becomes new Promise.
    setPage(2)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(latest(c)).toBe('v1') // SWR-stale

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

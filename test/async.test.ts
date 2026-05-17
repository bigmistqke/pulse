import { describe, expect, test } from 'vitest'
import { isPending, latest, use, NotReadyYet, read } from '../src/async'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { computed } from '../src/computed'
import { signal, PENDING, type Accessor } from '../src/signal'

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

test('read of a plain value yields it; yield* expression resolves to it', () => {
  // Drive `read(42)` manually (no driver yet here — we drive by hand for the unit test).
  const gen = read(42)
  const step = gen.next()
  expect(step.done).toBe(false)
  expect(step.value).toBe(42)
  const final = gen.next(42)
  expect(final.done).toBe(true)
  expect(final.value).toBe(42)
})

test('read of a signal calls its accessor (tracking happens via the call)', () => {
  const [s] = signal(7)
  const gen = read(s)
  const step = gen.next()
  expect(step.value).toBe(7) // s() was called; yields its value
  const final = gen.next(7)
  expect(final.value).toBe(7)
})

test('read of a promise yields the promise itself', () => {
  const p = Promise.resolve(1)
  const gen = read(p)
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

test('isPending dispatches via [PENDING] brand when present', () => {
  const [pending, setPending] = signal(false)
  const branded = (() => 42) as Accessor<number> & { [PENDING]?: Accessor<boolean> }
  branded[PENDING] = pending
  expect(isPending(branded)).toBe(false)
  setPending(true)
  expect(isPending(branded)).toBe(true)
})

test('isPending without [PENDING] brand falls back to isPromise(value)', () => {
  const [s, setS] = signal<number | Promise<number>>(7)
  expect(isPending(s)).toBe(false)
  setS(new Promise<number>(() => {}))
  expect(isPending(s)).toBe(true)
})

test('isPending([PENDING]) takes precedence over value check', () => {
  const [pending] = signal(false)
  const branded = (() => new Promise(() => {})) as Accessor<unknown> & { [PENDING]?: Accessor<boolean> }
  branded[PENDING] = pending
  expect(isPending(branded)).toBe(false)
})

test('use(accessor) keeps SWR-at-leaf: returns stale value during refetch', async () => {
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
  // SWR: c() returns stale 10; use(c) returns stale value too (no suspension at leaf).
  // For coherent suspension inside a generator computed, reach for yield* read(c).
  expect(use(c)).toBe(10)

  release(20)
  await tick()
  expect(use(c)).toBe(20)
})

test('yield* read(pendingComputed) suspends the generator until settle', async () => {
  const [id, setId] = signal(1)
  let release!: (v: number) => void
  const c = computed(() => {
    const i = id()
    if (i === 1) return Promise.resolve(10)
    return new Promise<number>((r) => { release = r })
  })
  await tick()

  const view = computed(function* () {
    return yield* read(c)
  })
  expect(view()).toBe(10)

  setId(2)
  expect(view()).toBe(10) // SWR snapshot during refetch
  expect(isPending(view)).toBe(true)

  release(20)
  await tick()
  expect(view()).toBe(20)
  expect(isPending(view)).toBe(false)
})

describe('read — post-Plan-A (no brand suspension)', () => {
  test('yield* read on an SWR-refetching computed yields the stale value, NOT brand.promise', async () => {
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
    expect(c()).toBe('v1')

    // Trigger refetch — accessor goes SWR-stale, suspendedOn becomes new Promise.
    setPage(2)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(c()).toBe('v1') // SWR-stale

    // Plan A: read yields the stale value directly.
    const gen = read(c)
    const first = gen.next()
    expect(first.value).toBe('v1')
    // (Under the pre-Plan-A brand-aware read, first.value would have been
    // the new in-flight Promise from brand.promise(), not 'v1'.)

    activeResolve('v2')
  })
})

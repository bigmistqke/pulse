import { expect, test } from 'vitest'
import { isPending, latest, use, NotReadyYet, read } from '../src/async'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
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

test('a promise-typed signal accepts its resolved value via setter', () => {
  // signal(Promise<number>) is [Accessor<number | Promise<number>>, Setter<...>],
  // so setting the resolved number must typecheck and flip isPending.
  const [s, setS] = signal(Promise.resolve(1))
  expect(isPending(s)).toBe(true)
  setS(1)
  expect(isPending(s)).toBe(false)
  expect(s()).toBe(1)
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
  const [s, setS] = signal<number | Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(s)).toBe(1)

  let release!: (v: number) => void
  setS(new Promise<number>((resolve) => { release = resolve }))
  expect(latest(s)).toBe(1) // still 1 — does NOT revert to undefined

  release(2)
  await tick()
  expect(latest(s)).toBe(2) // now the new resolved value
})

test('latest is reactive — updates as the signal resolves', async () => {
  setScheduler(syncScheduler(flush))
  const [s] = signal(Promise.resolve(1))
  const seen: Array<number | undefined> = []
  effect(() => { seen.push(latest(s)) })
  expect(seen).toEqual([undefined]) // pending — no prior resolution
  await tick()
  expect(seen).toEqual([undefined, 1]) // resolved -> effect re-ran -> latest is 1
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
  const [s] = signal<number | Promise<number>>(new Promise(() => {}))
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
  setS(new Promise(() => {}))
  expect(isPending(s)).toBe(true)
})

test('isPending([PENDING]) takes precedence over value check', () => {
  const [pending] = signal(false)
  const branded = (() => new Promise(() => {})) as Accessor<unknown> & { [PENDING]?: Accessor<boolean> }
  branded[PENDING] = pending
  expect(isPending(branded)).toBe(false)
})

import { expect, test } from 'vitest'
import { isPending, latest } from '../src/async'
import { effect } from '../src/effect'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { setSignal, signal } from '../src/signal'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('isPending is false for a signal holding a plain value', () => {
  const s = signal(0)
  expect(isPending(s)).toBe(false)
})

test('isPending is true for a signal holding a pending promise', () => {
  const s = signal(new Promise<number>(() => {}))
  expect(isPending(s)).toBe(true)
})

test('a promise-typed signal accepts its resolved value via setSignal', () => {
  // signal(Promise<number>) is WritableSignal<number | Promise<number>>,
  // so setting the resolved number must typecheck and flip isPending.
  const s = signal(Promise.resolve(1))
  expect(isPending(s)).toBe(true)
  setSignal(s, 1)
  expect(isPending(s)).toBe(false)
  expect(s()).toBe(1)
})

test('latest is undefined before the first resolution', () => {
  const s = signal(new Promise<number>(() => {})) // never resolves
  expect(latest(s)).toBeUndefined()
})

test('latest returns the resolved value after the promise settles', async () => {
  const s = signal(Promise.resolve(1))
  expect(latest(s)).toBeUndefined()
  await tick()
  expect(latest(s)).toBe(1)
})

test('latest keeps the last resolved value while a newer promise is pending', async () => {
  const s = signal<number | Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(s)).toBe(1)

  let release!: (v: number) => void
  setSignal(s, new Promise<number>((resolve) => { release = resolve }))
  expect(latest(s)).toBe(1) // still 1 — does NOT revert to undefined

  release(2)
  await tick()
  expect(latest(s)).toBe(2) // now the new resolved value
})

test('latest is reactive — updates as the signal resolves', async () => {
  setScheduler(syncScheduler(flush))
  const s = signal(Promise.resolve(1))
  const seen: Array<number | undefined> = []
  effect(() => { seen.push(latest(s)) })
  expect(seen).toEqual([undefined]) // pending — no prior resolution
  await tick()
  expect(seen).toEqual([undefined, 1]) // resolved -> effect re-ran -> latest is 1
  setScheduler(microtaskScheduler(flush))
})

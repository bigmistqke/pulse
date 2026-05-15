import { expect, test } from 'vitest'
import { isPending } from '../src/async'
import { setSignal, signal } from '../src/signal'

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

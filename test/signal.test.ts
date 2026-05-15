import { expect, test } from 'vitest'
import { signal } from '../src/signal'
import { computed } from '../src/computed'
import { isPending } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('signal holds an initial value', () => {
  const [count] = signal(0)
  expect(count()).toBe(0)
})

test('setter updates the value, accessor reflects it', () => {
  const [count, setCount] = signal(0)
  setCount(5)
  expect(count()).toBe(5)
})

test('signal works with non-number values', () => {
  const [name, setName] = signal('alice')
  expect(name()).toBe('alice')
  setName('bob')
  expect(name()).toBe('bob')
})

test('setter supports updater function', () => {
  const [count, setCount] = signal(0)
  setCount((prev) => prev + 1)
  expect(count()).toBe(1)
  setCount((prev) => prev * 3)
  expect(count()).toBe(3)
})

test('computed accessor is not writable (type-level)', () => {
  const c = computed(() => 1)
  // @ts-expect-error - computed accessor has no setter
  c.nonexistent
})

test('a signal created with a promise writes back the resolved value', async () => {
  const [s] = signal(Promise.resolve(42))
  expect(isPending(s)).toBe(true)
  await tick()
  expect(s()).toBe(42)
  expect(isPending(s)).toBe(false)
})

test('setter with a promise writes back on settle', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  setS(Promise.resolve(99))
  expect(isPending(s)).toBe(true)
  await tick()
  expect(s()).toBe(99)
})

test('a superseded promise does not write back', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  let release!: (v: number) => void
  const slow = new Promise<number>((resolve) => { release = resolve })
  setS(slow) // schedules a write-back for `slow`
  setS(7)    // supersedes it — bumps the generation
  release(123)       // `slow` settles late
  await tick()
  expect(s()).toBe(7) // NOT 123 — the superseded write-back was skipped
  expect(isPending(s)).toBe(false)
})

import { expect, test } from 'vitest'
import { signal } from '../src/signal'
import { computed } from '../src/computed'
import { isPending } from '../src/pending'
import { peek } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon rule-a-signal-reads-back-its-last-write
 */
test('signal holds an initial value', () => {
  const [count] = signal(0)
  expect(count()).toBe(0)
})

/**
 * @canon rule-a-signal-reads-back-its-last-write
 */
test('setter updates the value, accessor reflects it', () => {
  const [count, setCount] = signal(0)
  setCount(5)
  expect(count()).toBe(5)
})

/**
 * @canon rule-a-signal-reads-back-its-last-write
 */
test('signal works with non-number values', () => {
  const [name, setName] = signal('alice')
  expect(name()).toBe('alice')
  setName('bob')
  expect(name()).toBe('bob')
})

/**
 * @canon rule-a-signal-reads-back-its-last-write
 */
test('setter supports updater function', () => {
  const [count, setCount] = signal(0)
  setCount((prev) => prev + 1)
  expect(count()).toBe(1)
  setCount((prev) => prev * 3)
  expect(count()).toBe(3)
})

/**
 * @canon rule-a-computed-has-no-setter
 */
test('computed accessor is not writable (type-level)', () => {
  const c = computed(() => 1)
  // @ts-expect-error - computed accessor has no setter
  c.nonexistent
})

/**
 * @canon rule-a-signal-stores-a-promise-as-it-is
 */
test('a signal stores a Promise value as-is (no auto-resolve)', async () => {
  // Write-back was removed: signal stores exactly what you put in it. For
  // async derivations use computed; for one-shot reads use `use(s())`.
  const [s] = signal(Promise.resolve(42))
  expect(isPending(s)).toBe(true)
  await tick()
  expect(s()).toBeInstanceOf(Promise)
  expect(await s()).toBe(42)
})

/**
 * @canon rule-a-signal-stores-a-promise-as-it-is
 */
test('a signal written a promise reads back as the plain promise it was given', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  const p = Promise.resolve(42)
  setS(p)
  expect(s()).toBe(p) // the plain promise, not a wrapper
  expect(isPending(s)).toBe(true)
  await tick()
  expect(isPending(s)).toBe(false)
  expect(peek(s)).toBe(42)
})

/**
 * @canon rule-an-async-node-keeps-its-last-value-while-it-refetches
 */
test('SWR: while a refetch is pending the prior resolved value stays available via peek', async () => {
  const [s, setS] = signal<number | Promise<number>>(0)
  setS(Promise.resolve(1))
  await tick()
  setS(new Promise(() => {})) // never settles
  expect(isPending(s)).toBe(true)
  expect(peek(s)).toBe(1) // prior held (seeded from the current node value)
})

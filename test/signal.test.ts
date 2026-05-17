import { expect, test } from 'vitest'
import { signal } from '../src/signal'
import { computed } from '../src/computed'
import { isPending } from '../src/pending'

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

test('a signal stores a Promise value as-is (no auto-resolve)', async () => {
  // Write-back was removed: signal stores exactly what you put in it. For
  // async derivations use computed; for one-shot reads use `use(s())`.
  const [s] = signal(Promise.resolve(42))
  expect(isPending(s)()).toBe(true)
  await tick()
  expect(s()).toBeInstanceOf(Promise)
  expect(await s()).toBe(42)
})

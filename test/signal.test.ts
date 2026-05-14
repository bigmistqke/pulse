import { expect, test } from 'vitest'
import { signal, setSignal } from '../src/signal'
import { computed } from '../src/computed'

test('signal holds an initial value', () => {
  const count = signal(0)
  expect(count()).toBe(0)
})

test('setSignal updates the value, accessor reflects it', () => {
  const count = signal(0)
  setSignal(count, 5)
  expect(count()).toBe(5)
})

test('signal works with non-number values', () => {
  const name = signal('alice')
  expect(name()).toBe('alice')
  setSignal(name, 'bob')
  expect(name()).toBe('bob')
})

test('setSignal rejects a computed (type-level)', () => {
  const c = computed(() => 1)
  // @ts-expect-error - setSignal must not accept a read-only computed
  setSignal(c, 2)
})

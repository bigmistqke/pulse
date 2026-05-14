import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal, setSignal } from '../src/signal'

test('computed derives an initial value from a signal', () => {
  const count = signal(2)
  const doubled = computed(() => count() * 2)
  expect(doubled()).toBe(4)
})

test('computed is pull-on-read correct after a write', () => {
  const count = signal(2)
  const doubled = computed(() => count() * 2)
  setSignal(count, 3)
  expect(doubled()).toBe(6)
})

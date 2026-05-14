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

test('computed threads a value through a multi-stage pipeline', () => {
  const n = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
    (v) => `value: ${v}`,
  )
  expect(result()).toBe('value: 8')
})

test('multi-stage pipeline recomputes on dependency change', () => {
  const n = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
  )
  expect(result()).toBe(8)
  setSignal(n, 9)
  expect(result()).toBe(20)
})

test('a stage in the middle of the pipeline may also read signals', () => {
  const base = signal(10)
  const factor = signal(2)
  const result = computed(
    () => base(),
    (v) => v * factor(),
  )
  expect(result()).toBe(20)
  setSignal(factor, 3)
  expect(result()).toBe(30)
})

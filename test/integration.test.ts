import { expect, test } from 'vitest'
import { computed, effect, setSignal, signal } from '../src/index'

test('signals, pipeline computeds, and effects work together', async () => {
  const price = signal(10)
  const qty = signal(2)

  const total = computed(
    () => price() * qty(),
    (subtotal) => subtotal * 1.1, // +10% tax
  )

  const log: number[] = []
  effect(() => { log.push(total()) })

  // effect ran once on creation: (10 * 2) * 1.1 = 22
  expect(log).toEqual([22])

  setSignal(qty, 5)
  // default scheduler is microtask-batched: effect has NOT re-run yet
  expect(log).toEqual([22])

  await Promise.resolve() // let the microtask scheduler flush
  // now the effect has re-run once: (10 * 5) * 1.1 = 55
  expect(log).toHaveLength(2)
  expect(log[0]).toBe(22)
  expect(log[1]).toBeCloseTo(55, 5)
})

test('pull-on-read returns a fresh value before the scheduler flushes', () => {
  const n = signal(1)
  const doubled = computed(() => n() * 2)
  setSignal(n, 21)
  // no await — pull-on-read recomputes synchronously on read
  expect(doubled()).toBe(42)
})

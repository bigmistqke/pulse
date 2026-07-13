import { expect, test } from 'vitest'
import { action, committed, computed, signal } from '../src/index'

test('a speculative write is visible to a normal read but NOT to committed', () => {
  const [name, setName] = signal('alice')
  action(() => {
    setName('bob')
    expect(name()).toBe('bob') // inside the speculation: the speculative value
    expect(committed(name)).toBe('alice') // isolation: still the committed value
  })
  // The action returned normally, so it committed.
  expect(name()).toBe('bob')
  expect(committed(name)).toBe('bob')
})

test('a discarded action leaves committed state untouched and the write vanishes', () => {
  const [name, setName] = signal('alice')
  expect(() =>
    action(() => {
      setName('bob')
      expect(name()).toBe('bob') // speculative
      expect(committed(name)).toBe('alice') // isolated from it
      throw new Error('boom')
    }),
  ).toThrow('boom')
  // Discarded: the speculative write is gone; committed state never moved.
  expect(name()).toBe('alice')
  expect(committed(name)).toBe('alice')
})

test('a computed sees a speculative write commit through', () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  expect(doubled()).toBe(2)
  action(() => {
    setN(5)
  })
  // After commit, the write reaches r3 and the computed recomputes normally.
  expect(doubled()).toBe(10)
  expect(committed(doubled)).toBe(10)
})

test('a computed derives from the speculative value inside an action', () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  expect(doubled()).toBe(2)
  action(() => {
    setN(5)
    expect(doubled()).toBe(10) // derived from the speculative value
    expect(committed(doubled)).toBe(2) // derived from committed state — isolated
  })
  expect(doubled()).toBe(10) // committed through
})

test('a discarded action leaves derived state untouched', () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  expect(doubled()).toBe(2)
  expect(() =>
    action(() => {
      setN(5)
      expect(doubled()).toBe(10) // speculative derivation
      throw new Error('nope')
    }),
  ).toThrow('nope')
  expect(doubled()).toBe(2) // the speculative derivation vanished with the scope
  expect(committed(doubled)).toBe(2)
})

test('a multi-stage pipeline derives through the speculation', () => {
  const [n, setN] = signal(1)
  const pipeline = computed(
    () => n() + 1,
    (v: number) => v * 10,
  )
  expect(pipeline()).toBe(20)
  action(() => {
    setN(4)
    expect(pipeline()).toBe(50) // (4+1)*10 — recomputed through both stages
    expect(committed(pipeline)).toBe(20)
  })
  expect(pipeline()).toBe(50)
})

test('committed outside any speculation is just the current value', () => {
  const [n, setN] = signal(1)
  expect(committed(n)).toBe(1)
  setN(3)
  expect(committed(n)).toBe(3)
})

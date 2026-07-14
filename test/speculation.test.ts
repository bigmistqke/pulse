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

test('a speculative write propagates through a chain of separate computeds', () => {
  const [a, setA] = signal(1)
  const b = computed(() => a() * 2) // 2
  const c = computed(() => b() + 1) // 3
  expect(c()).toBe(3)
  action(() => {
    // Read c FIRST, so its slot is cached in the scope while a is still 1.
    // The bug only bites a slot that was cached before the write.
    expect(c()).toBe(3)
    setA(10)
    expect(b()).toBe(20) // one-hop control — the direct subscriber recomputes
    expect(c()).toBe(21) // transitive — c must recompute too, not return stale 3
    expect(committed(c)).toBe(3) // isolation from committed state is intact
  })
  expect(c()).toBe(21) // committed through
})

test('a discarded action rolls back a transitively-derived value', () => {
  const [a, setA] = signal(1)
  const b = computed(() => a() * 2)
  const c = computed(() => b() + 1)
  expect(c()).toBe(3)
  expect(() =>
    action(() => {
      expect(c()).toBe(3)
      setA(10)
      expect(c()).toBe(21) // speculative derivation two hops down
      throw new Error('rollback')
    }),
  ).toThrow('rollback')
  expect(c()).toBe(3) // the transitive derivation vanished with the scope
  expect(committed(c)).toBe(3)
})

test('a speculative write propagates through a longer computed chain', () => {
  const [a, setA] = signal(1)
  const b = computed(() => a() + 1) // 2
  const c = computed(() => b() * 2) // 4
  const d = computed(() => c() + 3) // 7
  expect(d()).toBe(7)
  action(() => {
    expect(d()).toBe(7) // cache the whole chain's slots at a = 1
    setA(10)
    expect(d()).toBe(25) // ((10+1)*2)+3, recomputed three hops down
  })
  expect(d()).toBe(25)
})

test('committed outside any speculation is just the current value', () => {
  const [n, setN] = signal(1)
  expect(committed(n)).toBe(1)
  setN(3)
  expect(committed(n)).toBe(3)
})

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

// KNOWN GAP — public computeds are not speculation-aware yet.
//
// A public `computed()` is an r3 computed (a depTracker plus a publishedValue
// signal). A speculative write lands in the scope's slot, NOT in the signal's r3
// backing, so r3 never marks the computed dirty and its body never re-runs under
// the speculation — `doubled()` inside an action still reads the COMMITTED value.
//
// The overlay already has the mechanism (readValue's `defaultRecipe` path
// recomputes a computed into a fresh per-scope slot), but public computeds never
// register as scope computedNodes, so they bypass it. Wiring them up is the next
// piece of work; this test documents the target behaviour and should be unskipped
// then.
test.skip('a computed derives from the speculative value inside an action', () => {
  const [n, setN] = signal(1)
  const doubled = computed(() => n() * 2)
  action(() => {
    setN(5)
    expect(doubled()).toBe(10) // derived from the speculative value
    expect(committed(doubled)).toBe(2) // derived from committed state
  })
})

test('committed outside any speculation is just the current value', () => {
  const [n, setN] = signal(1)
  expect(committed(n)).toBe(1)
  setN(3)
  expect(committed(n)).toBe(3)
})

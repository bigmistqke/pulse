import { afterEach, beforeEach, expect, test } from 'vitest'
import { mapArray } from '../../src/dom/map-array'
import {
  createRoot,
  effect,
  flush,
  microtaskScheduler,
  onCleanup,
  setScheduler,
  setSignal,
  signal,
  syncScheduler,
} from '../../src/index'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => setScheduler(microtaskScheduler(flush)))

test('initial run maps each item in order', () => {
  createRoot(() => {
    const items = signal([1, 2, 3])
    const mapped = mapArray(items, (n) => n * 10)
    expect(mapped()).toEqual([10, 20, 30])
  })
})

test('reuses entries when same references appear again', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const items = signal([a, b])
    let calls = 0
    const mapped = mapArray(items, (item) => { calls++; return item.id })
    mapped()
    expect(calls).toBe(2)
    setSignal(items, [a, b])
    mapped()
    expect(calls).toBe(2) // no new mapper calls
  })
})

test('creates entries for newly added items', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const items = signal([a, b])
    let calls = 0
    const mapped = mapArray(items, (item) => { calls++; return item.id })
    mapped()
    setSignal(items, [a, b, c])
    mapped()
    expect(calls).toBe(3)
  })
})

test('disposes orphan entries when items leave', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const items = signal([a, b])
    let aCleanedUp = false
    const mapped = mapArray(items, (item) => {
      if (item === a) onCleanup(() => { aCleanedUp = true })
      return item.id
    })
    mapped()
    expect(aCleanedUp).toBe(false)
    setSignal(items, [b])
    mapped()
    expect(aCleanedUp).toBe(true)
  })
})

test('output is in current array order, entries reused across reorder, index updates', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const items = signal([a, b, c])
    const mapped = mapArray(items, (item, index) => ({ item, idx: index }))
    const first = mapped()
    expect(first.map((e) => e.item.id)).toEqual(['a', 'b', 'c'])
    expect(first.map((e) => e.idx())).toEqual([0, 1, 2])

    setSignal(items, [c, a, b]) // reorder
    const second = mapped()
    // Output order matches the new array order:
    expect(second.map((e) => e.item.id)).toEqual(['c', 'a', 'b'])
    // Entry identity preserved (same mapped objects, just in new order):
    expect(second[0]).toBe(first[2])
    expect(second[1]).toBe(first[0])
    expect(second[2]).toBe(first[1])
    // Each entry's index signal now reflects its current position:
    expect(first[0].idx()).toBe(1) // a moved from 0 to 1
    expect(first[1].idx()).toBe(2) // b moved from 1 to 2
    expect(first[2].idx()).toBe(0) // c moved from 2 to 0
  })
})

test('mapper runs under per-item sub-owner; nested effect disposes when item leaves', () => {
  createRoot(() => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const items = signal([a, b])
    const aSig = signal(0)
    let aRuns = 0
    const mapped = mapArray(items, (item) => {
      if (item === a) effect(() => { aSig(); aRuns++ })
      return item.id
    })
    mapped()
    expect(aRuns).toBe(1)
    setSignal(aSig, 1)
    expect(aRuns).toBe(2)
    setSignal(items, [b]) // a leaves; its effect should be disposed
    mapped()
    setSignal(aSig, 2)
    expect(aRuns).toBe(2) // no further runs
  })
})

test('pending Promise<T[]> coerces to empty', () => {
  createRoot(() => {
    const p = new Promise<number[]>(() => {}) // never resolves
    const items = signal<number[] | Promise<number[]>>(p)
    const mapped = mapArray(items, (n) => n * 10)
    expect(mapped()).toEqual([])
  })
})

test('parent owner dispose cascades to all entry sub-owners', () => {
  let cleanups = 0
  const dispose = createRoot((d) => {
    const items = signal([1, 2, 3])
    const mapped = mapArray(items, () => {
      onCleanup(() => { cleanups++ })
      return null
    })
    mapped() // materialize entries
    return d
  })
  expect(cleanups).toBe(0)
  dispose()
  expect(cleanups).toBe(3)
})

test('different-reference same-shape items: treated as different', () => {
  createRoot(() => {
    const a1 = { id: 'a' }
    const a2 = { id: 'a' } // different reference
    const items = signal([a1])
    let calls = 0
    const mapped = mapArray(items, (item) => { calls++; return item.id })
    mapped()
    setSignal(items, [a2])
    mapped()
    expect(calls).toBe(2)
  })
})

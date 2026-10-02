import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { peek } from '../src/async'
import { isPending } from '../src/pending'
import { effect } from '../src/effect'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/** A fetch per key whose answer the test hands over by hand. */
function deferredFetches<K, V>() {
  const pending = new Map<K, (value: V) => void>()
  return {
    fetch: (key: K) => new Promise<V>((resolve) => pending.set(key, resolve)),
    answer: (key: K, value: V) => pending.get(key)!(value),
  }
}

const sortBy = (items: string[], order: 'asc' | 'desc') =>
  [...items].sort((a, b) => (order === 'asc' ? a.localeCompare(b) : b.localeCompare(a)))

/**
 * Stage 1 fetches the list for `version`; stage 2 sorts it by `order`.
 * Version 1 is `[c, a, b]`, version 2 is `[f, d, e]`.
 */
function sortedList() {
  const lists = deferredFetches<number, string[]>()
  const [version, setVersion] = signal(1)
  const [order, setOrder] = signal<'asc' | 'desc'>('asc')
  const sortInputs: Array<[string[], 'asc' | 'desc']> = []
  const list = computed(
    () => lists.fetch(version()),
    (items: string[]) => {
      sortInputs.push([items, order()])
      return sortBy(items, order())
    },
  )
  const shown: unknown[] = []
  effect(() => {
    shown.push(peek(list))
  })
  return { lists, setVersion, setOrder, sortInputs, list, shown }
}

/**
 * @canon spec-a-pipeline-has-one-run-in-progress
 */
test('a pipeline never shows a value that mixes an old stage input with a new one', async () => {
  const { lists, setVersion, setOrder, shown } = sortedList()
  lists.answer(1, ['c', 'a', 'b'])
  await tick()

  setVersion(2)
  await tick()
  setOrder('desc')
  await tick()
  lists.answer(2, ['f', 'd', 'e'])
  await tick()

  // Every value shown answers one moment of the inputs: version 1 ascending,
  // then version 2 descending. Version 1 descending was never asked for.
  expect(shown.filter((v) => v !== undefined)).toEqual([
    ['a', 'b', 'c'],
    ['f', 'e', 'd'],
  ])
})

/**
 * @canon spec-a-change-ahead-of-the-run-is-taken-up-when-the-run-reaches-it
 */
test('a change read by a later stage waits for the fetch in flight in an earlier stage', async () => {
  const { lists, setVersion, setOrder, sortInputs, list } = sortedList()
  lists.answer(1, ['c', 'a', 'b'])
  await tick()
  sortInputs.length = 0

  setVersion(2) // the run is now in stage 1, fetching version 2
  await tick()
  setOrder('desc') // stage 2 reads this, and the run has not reached stage 2
  await tick()

  expect(sortInputs).toEqual([]) // stage 2 did not run on version 1's list
  expect(peek(list)).toEqual(['a', 'b', 'c'])
  expect(isPending(list)).toBe(true)

  lists.answer(2, ['f', 'd', 'e'])
  await tick()

  expect(sortInputs).toEqual([[['f', 'd', 'e'], 'desc']]) // stage 2 ran once
  expect(peek(list)).toEqual(['f', 'e', 'd'])
  expect(isPending(list)).toBe(false)
})

/**
 * @canon spec-a-change-behind-the-run-restarts-the-run-from-that-stage
 */
test('a change to an earlier stage abandons the later stage it has already reached', async () => {
  const lists = deferredFetches<number, string[]>()
  const details = deferredFetches<string, string>()
  const [version, setVersion] = signal(1)
  const list = computed(
    () => lists.fetch(version()),
    (items: string[]) => details.fetch(items.join(',')), // stage 2 fetches too
  )
  const shown: unknown[] = []
  effect(() => {
    shown.push(peek(list))
  })

  lists.answer(1, ['a'])
  await tick() // the run is now in stage 2, fetching details for version 1

  setVersion(2) // behind the run: stage 1 changes while stage 2 is in flight
  await tick()
  details.answer('a', 'details of a') // stage 2's abandoned fetch lands
  await tick()

  expect(shown.filter((v) => v !== undefined)).toEqual([]) // it never published
  expect(isPending(list)).toBe(true)

  lists.answer(2, ['b'])
  await tick()
  details.answer('b', 'details of b')
  await tick()

  expect(peek(list)).toBe('details of b')
  expect(shown.filter((v) => v !== undefined)).toEqual(['details of b'])
})

import { expect, test } from 'vitest'
import { action, effect, optimistic, read, signal } from '../src/index'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'

// A promise plus its resolver, so a generator action can be held in flight and
// released deliberately.
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a consumer sees the overlay value while the action is in flight', async () => {
  const [value] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const handle = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
  })
  // In flight: the overlay is visible from outside the action.
  expect(optimisticValue()).toBe('draft')
  g.resolve()
  await handle.settled
})

test('the wrapped signal reads canonical truth, not the overlay', async () => {
  const [value] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const handle = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
  })
  expect(value()).toBe('saved') // canonical reader untouched
  expect(optimisticValue()).toBe('draft') // overlay-aware reader
  g.resolve()
  await handle.settled
})

test('a discarded action reverts the overlay to the prior value', async () => {
  const [value] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const handle = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
  })
  expect(optimisticValue()).toBe('draft')
  g.reject(new Error('server rejected'))
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect((handle.error() as Error).message).toBe('server rejected')
  expect(optimisticValue()).toBe('saved')
})

test('a committed action settles through to the canonical value', async () => {
  const [value, setValue] = signal('saved')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const g = gate()
  const handle = action(function* () {
    setOptimisticValue('draft')
    yield* read(g.promise)
    setValue('draft')
  })
  expect(optimisticValue()).toBe('draft')
  g.resolve()
  await handle.settled
  expect(optimisticValue()).toBe('draft') // stayed on the predicted value
  expect(value()).toBe('draft') // canonical committed
})

test('committing does not flash the prior value through the overlay reader', async () => {
  setScheduler(syncScheduler(flush))
  try {
    const [value, setValue] = signal('saved')
    const [optimisticValue, setOptimisticValue] = optimistic(value)
    const g = gate()
    const handle = action(function* () {
      setOptimisticValue('draft')
      yield* read(g.promise)
      setValue('draft')
    })
    const seen: string[] = []
    effect(() => {
      seen.push(optimisticValue())
    })
    g.resolve()
    await handle.settled
    // Across the commit the reader never showed the pre-action value.
    expect(seen).not.toContain('saved')
    expect(optimisticValue()).toBe('draft')
  } finally {
    setScheduler(microtaskScheduler(flush))
  }
})

test('isOptimistic reflects whether an overlay is live', async () => {
  const [value] = signal('x')
  const [, setOptimisticValue, isOptimistic] = optimistic(value)
  expect(isOptimistic()).toBe(false)
  const g = gate()
  const handle = action(function* () {
    setOptimisticValue('y')
    yield* read(g.promise)
  })
  expect(isOptimistic()).toBe(true)
  g.resolve()
  await handle.settled
  expect(isOptimistic()).toBe(false)
})

test('two concurrent actions show the most recent write and clean up independently', async () => {
  const [value] = signal('base')
  const [optimisticValue, setOptimisticValue] = optimistic(value)
  const a = gate()
  const b = gate()
  const runA = action(function* () {
    setOptimisticValue('a')
    yield* read(a.promise)
  })
  const runB = action(function* () {
    setOptimisticValue('b')
    yield* read(b.promise)
  })
  expect(optimisticValue()).toBe('b') // most recent write shows
  a.resolve()
  await runA.settled
  expect(optimisticValue()).toBe('b') // A's cleanup left B's overlay alone
  b.resolve()
  await runB.settled
  expect(optimisticValue()).toBe('base') // both cleared → canonical
})

test('setOptimisticValue throws when called with no active speculative scope', () => {
  const [value] = signal('x')
  const [, setOptimisticValue] = optimistic(value)
  expect(() => setOptimisticValue('y')).toThrow()
})

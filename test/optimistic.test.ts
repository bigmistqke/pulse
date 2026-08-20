import { expect, test } from 'vitest'
import { action, effect, error, isPending, latest, NotReadyYet, optimistic, peek, from, signal, use } from '../src/index'
import { resetError } from '../src/error'
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
    yield* from(g.promise)
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
    yield* from(g.promise)
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
    yield* from(g.promise)
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
    yield* from(g.promise)
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
    const [optimisticValue, setOptimisticValue] = optimistic(value, '')
    const g = gate()
    const handle = action(function* () {
      setOptimisticValue('draft')
      yield* from(g.promise)
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
    yield* from(g.promise)
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
    yield* from(a.promise)
  })
  const runB = action(function* () {
    setOptimisticValue('b')
    yield* from(b.promise)
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

// ---------------------------------------------------------------------------
// The accessor is an ordinary node: every read verb applies to it, and the
// pending/error state of what the recipe reads reaches the read site through it.

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('a use() read through the optimistic node suspends until the source resolves', async () => {
  const [source] = signal(() => Promise.resolve('loaded'))
  const [view] = optimistic(source)

  expect(() => use(view)).toThrow(NotReadyYet)
  await tick()
  await tick()
  expect(use(view)).toBe('loaded')
  expect(isPending(view)).toBe(false)
})

test('a live prediction stops the node reporting pending, so a use() read shows it', async () => {
  const first = gate<string>()
  const second = gate<string>()
  const [version, setVersion] = signal(0)
  const [source] = signal(() => (version() === 0 ? first.promise : second.promise))
  const [view, setView] = optimistic(source)
  first.resolve('server')
  await tick()
  await tick()
  expect(use(view)).toBe('server')

  const g = gate()
  const handle = action(function* () {
    setView('predicted')
    yield* from(g.promise)
  })
  // Committed, so the source genuinely refetches while the prediction is live —
  // a write from inside the action would be isolated to it and refetch nothing.
  setVersion(1)
  await tick()
  expect(isPending(source)).toBe(true) // the source really is in flight
  expect(isPending(view)).toBe(false) // and the prediction hides it
  expect(use(view)).toBe('predicted')

  g.resolve()
  await handle.settled
  second.resolve('server2')
  await tick()
  await tick()
  expect(isPending(view)).toBe(false)
  expect(use(view)).toBe('server2')
})

test('a failed source reports through the optimistic node, and a retry resets that source', async () => {
  let failing = true
  const [source] = signal(() => (failing ? Promise.reject(new Error('boom')) : Promise.resolve('ok')))
  const [view] = optimistic(source)
  await tick()
  await tick()

  expect((error(view) as Error).message).toBe('boom')
  expect(peek(view)).toBeUndefined() // tolerant read still never throws

  failing = false
  resetError(view) // what an <Errored> boundary's retry calls
  await tick()
  await tick()
  expect(error(view)).toBe(null)
  expect(peek(view)).toBe('ok')
})

test('a live prediction also masks a failed source', async () => {
  let failing = true
  const [source] = signal(() => (failing ? Promise.reject(new Error('boom')) : Promise.resolve('ok')))
  const [view, setView] = optimistic(source)
  await tick()
  await tick()
  expect((error(view) as Error).message).toBe('boom')

  const g = gate()
  const handle = action(function* () {
    setView('predicted')
    yield* from(g.promise)
  })
  expect(error(view)).toBe(null)
  expect(use(view)).toBe('predicted')

  g.resolve()
  await handle.settled
  await tick()
  expect((error(view) as Error).message).toBe('boom') // reported again once the layer goes
})

test('a recipe that produces its own value needs no separate source', async () => {
  const [view, setView, isOptimistic] = optimistic(() => Promise.resolve(['a']))
  await tick()
  await tick()
  expect(use(view)).toEqual(['a'])

  const g = gate()
  const handle = action(function* () {
    setView((prev) => [...prev!, 'b']) // the update form sees what the recipe produced
    yield* from(g.promise)
  })
  expect(use(view)).toEqual(['a', 'b'])
  expect(isOptimistic()).toBe(true)

  g.resolve()
  await handle.settled
  await tick()
  await tick()
  expect(use(view)).toEqual(['a']) // the layer expired; the recipe is back
})

test('a construction-time fallback seeds the tolerant read', () => {
  const [view] = optimistic(() => new Promise<string[]>(() => {}), [] as string[])
  expect(latest(view)).toEqual([])
  expect(peek(view)).toEqual([])
})

test('a background refresh of a wrapped node is reported through the optimistic node', async () => {
  const first = gate<string>()
  const second = gate<string>()
  const [version, setVersion] = signal(0)
  const [source] = signal(() => (version() === 0 ? first.promise : second.promise))
  const [view] = optimistic(source)
  first.resolve('server')
  await tick()
  await tick()
  expect(isPending(view)).toBe(false)

  setVersion(1)
  await tick()
  // Stale-while-revalidate keeps the resolved value published, so this
  // derivation's own stage is not in flight. The refresh is reported because
  // the node it wraps is the one in flight, and wrapping registers this node
  // as downstream of it.
  expect(isPending(view)).toBe(true)
  expect(peek(view)).toBe('server')

  second.resolve('server2')
  await tick()
  await tick()
  expect(isPending(view)).toBe(false)
  expect(peek(view)).toBe('server2')
})

// ---------------------------------------------------------------------------
// A layer sits in front of the derivation, and is scoped to the action that
// wrote it. Neither of these held while a layer was written INTO the node.

test('an action reads back its own prediction, and a sibling action does not', async () => {
  const [source] = signal(() => Promise.resolve(['saved'] as string[]), [] as string[])
  const [view, setView] = optimistic(source, [] as string[])
  await tick()
  await tick()
  expect(latest(view)).toEqual(['saved'])

  const a = gate()
  const b = gate()
  let seenInsideB: unknown
  let seenInsideBAfterItsOwnWrite: unknown
  const runA = action(function* () {
    setView(['saved', 'A1'])
    yield* from(a.promise)
  })
  const runB = action(function* () {
    seenInsideB = peek(view) // A's prediction is not visible here
    setView(['saved', 'B1'])
    seenInsideBAfterItsOwnWrite = peek(view) // its own is
    yield* from(b.promise)
  })
  expect(seenInsideB).toEqual(['saved'])
  expect(seenInsideBAfterItsOwnWrite).toEqual(['saved', 'B1'])
  expect(latest(view)).toEqual(['saved', 'B1']) // outside: the top of the stack

  a.resolve()
  await runA.settled
  b.resolve()
  await runB.settled
})

test('a refused action does not leave its prediction inside a later action layer', async () => {
  const [source] = signal(() => Promise.resolve(['saved'] as string[]), [] as string[])
  const [view, setView] = optimistic(source, [] as string[])
  await tick()
  await tick()

  const a = gate()
  const b = gate()
  const runA = action(function* () {
    setView((prev) => [...prev, 'A1'])
    yield* from(a.promise)
  })
  const runB = action(function* () {
    // Builds on server truth, not on A's live prediction, so A1 is not baked
    // into this layer's value and A can still withdraw it.
    setView((prev) => [...prev, 'B1'])
    yield* from(b.promise)
  })
  expect(latest(view)).toEqual(['saved', 'B1'])

  a.reject(new Error('refused'))
  await runA.settled
  expect(latest(view)).toEqual(['saved', 'B1']) // A1 is gone, B is untouched

  b.resolve()
  await runB.settled
  expect(latest(view)).toEqual(['saved'])
})

test('a source that changes while a prediction is live does not overwrite it', async () => {
  const [n, setN] = signal(0)
  const [source] = signal(() => Promise.resolve([`server-${n()}`]), [] as string[])
  const [view, setView] = optimistic(source, [] as string[])
  await tick()
  await tick()
  expect(latest(view)).toEqual(['server-0'])

  const g = gate()
  const handle = action(function* () {
    setView(['predicted'])
    yield* from(g.promise)
  })
  setN(1) // committed, so the source really does move underneath the prediction
  await tick()
  await tick()
  expect(latest(view)).toEqual(['predicted'])

  g.resolve()
  await handle.settled
  await tick()
  expect(latest(view)).toEqual(['server-1']) // the newer truth was waiting underneath
})

test('the derivation keeps following its sources while a prediction hides it', async () => {
  const [n, setN] = signal(0)
  const [source] = signal(() => Promise.resolve([`server-${n()}`]), [] as string[])
  const [view, setView] = optimistic(source, [] as string[])
  const seen: string[] = []
  effect(() => {
    seen.push(JSON.stringify(latest(view)))
  })
  await tick()
  await tick()

  const g = gate()
  const handle = action(function* () {
    setView(['predicted'])
    yield* from(g.promise)
  })
  // Two committed source changes, neither of which anything reads while the
  // prediction is what every consumer sees.
  setN(1)
  await tick()
  await tick()
  setN(2)
  await tick()
  await tick()
  expect(seen).not.toContain(JSON.stringify(['server-1']))

  g.resolve()
  await handle.settled
  await tick()
  await tick()
  expect(latest(view)).toEqual(['server-2']) // it kept up while it was hidden
})

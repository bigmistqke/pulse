import { expect, test } from 'vitest'
import { action, createRoot, effect, from, optimistic, peek, signal } from '../src/index'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon rule-a-commit-promotes-every-write-at-once
 */
test('a commit reaches a committed consumer as one change, where the same writes made outside an action reach it one by one', () => {
  setScheduler(syncScheduler(flush))
  const [a, setA] = signal(1)
  const [b, setB] = signal(10)
  const seen: string[] = []
  createRoot(() => {
    effect(() => {
      seen.push(`${a()}/${b()}`)
    })
  })
  action(() => {
    setA(2)
    setB(20)
  })
  expect(seen).toEqual(['1/10', '2/20']) // one run for both committed writes
  setA(3)
  setB(30)
  expect(seen).toEqual(['1/10', '2/20', '3/20', '3/30']) // the control: one run per write
  setScheduler(microtaskScheduler(flush))
})

/**
 * @canon rule-after-a-commit-only-what-the-action-wrote-to-the-source-remains
 */
test('a prediction does not survive a commit of an action that did not write its source', async () => {
  const [value] = signal('saved')
  const [view, setView] = optimistic(value)
  const handle = action(() => {
    setView('draft')
  })
  await handle.settled
  await tick()
  expect(view()).toBe('saved')
})

/**
 * @canon rule-a-reader-in-an-action-sees-the-predictions-of-its-own-chain
 */
test('a nested action sees the prediction its parent made', async () => {
  const [value] = signal('saved')
  const [view, setView] = optimistic(value)
  const gate = Promise.withResolvers<void>()
  let seenInside: unknown
  const handle = action(function* () {
    setView('outer')
    action(() => {
      seenInside = peek(view)
    })
    yield* from(gate.promise)
  })
  expect(seenInside).toBe('outer')
  gate.resolve()
  await handle.settled
})

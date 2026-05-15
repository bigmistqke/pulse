import { expect, test } from 'vitest'
import { effect, isPending, latest, setSignal, signal, use } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('a promise-holding signal flows through an effect via use, and writes back', async () => {
  const user = signal(Promise.resolve({ name: 'ada' }))
  const seen: string[] = []
  effect(() => { seen.push(use(user()).name) })

  // initially suspended — the promise is pending from use's point of view
  expect(seen).toEqual([])
  expect(isPending(user)).toBe(true)

  await tick()

  // write-back flipped the signal; the effect re-ran with the resolved value
  expect(seen).toEqual(['ada'])
  expect(isPending(user)).toBe(false)
  expect(use(user())).toEqual({ name: 'ada' }) // use of a settled value is synchronous
})

test('latest gives stale-while-revalidate across a re-fetch', async () => {
  const data = signal<number | Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(data)).toBe(1)

  setSignal(data, Promise.resolve(2))
  expect(latest(data)).toBe(1) // stale value held while the new promise is pending
  await tick()
  expect(latest(data)).toBe(2)
})

import { expect, test } from 'vitest'
import { effect, isPending, latest, signal, use } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('a promise-holding signal flows through an effect via use', async () => {
  const [user] = signal(Promise.resolve({ name: 'ada' }))
  const seen: string[] = []
  effect(() => { seen.push(use(user()).name) })

  // initially suspended — the promise is pending from use's point of view
  expect(seen).toEqual([])
  expect(isPending(user)).toBe(true)

  await tick()

  // Settle: the effect's .then(rerun) re-fires, use(p) returns the resolved
  // value (via track()), isPending is no longer true.
  expect(seen).toEqual(['ada'])
  expect(isPending(user)).toBe(false)
  expect(use(user())).toEqual({ name: 'ada' }) // use of a settled value is synchronous
})

test('latest gives stale-while-revalidate across a re-fetch', async () => {
  const [data, setData] = signal<Promise<number>>(Promise.resolve(1))
  await tick()
  expect(latest(data)).toBe(1)

  setData(Promise.resolve(2))
  expect(latest(data)).toBe(1) // stale value held while the new promise is pending
  await tick()
  expect(latest(data)).toBe(2)
})

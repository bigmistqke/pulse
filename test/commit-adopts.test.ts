import { expect, test } from 'vitest'
import { action, computed, from, isPending, peek, signal } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

/** A derivation of `id` that counts its runs, and resolves a macrotask later. */
function fetchedUser() {
  const [id, setId] = signal(1)
  const requested: number[] = []
  const user = computed(() => {
    const current = id()
    requested.push(current)
    return tick().then(() => `user ${current}`)
  })
  return { setId, user, requested }
}

/**
 * @canon spec-a-committed-derivation-takes-a-clean-result-without-running
 */
test('a sync derivation an action read takes its result at commit without running', () => {
  const [id, setId] = signal(1)
  const runs: number[] = []
  const label = computed(() => {
    runs.push(id())
    return `user ${id()}`
  })
  const seen: string[] = []

  action(() => {
    setId(2)
    seen.push(label())
  })

  expect(seen).toEqual(['user 2'])
  expect(label()).toBe('user 2')
  expect(runs).toEqual([1, 2]) // once at creation, once inside the action

  // The committed derivation still follows `id`.
  setId(3)
  expect(label()).toBe('user 3')
  expect(runs).toEqual([1, 2, 3])
})

/**
 * @canon spec-a-committed-derivation-takes-a-clean-result-without-running
 */
test('an action that waited for an async derivation of its write makes one request', async () => {
  const { setId, user, requested } = fetchedUser()
  await ticks(2)
  expect(peek(user)).toBe('user 1')

  const seen: string[] = []
  const handle = action(function* () {
    setId(2)
    seen.push(yield* from(user))
  })
  await handle.settled
  await ticks(2)

  expect(seen).toEqual(['user 2'])
  expect(peek(user)).toBe('user 2')
  expect(requested).toEqual([1, 2])

  setId(3)
  await ticks(2)
  expect(peek(user)).toBe('user 3')
  expect(requested).toEqual([1, 2, 3])
})

/**
 * @canon spec-a-result-in-flight-at-commit-is-taken-over
 */
test('a request still in flight when its action commits becomes the committed run', async () => {
  const { setId, user, requested } = fetchedUser()
  await ticks(2)

  action(() => {
    setId(2)
    user() // starts the request for user 2; the action commits before it lands
  })

  expect(isPending(user)).toBe(true)
  expect(peek(user)).toBe('user 1')
  await ticks(2)

  expect(isPending(user)).toBe(false)
  expect(peek(user)).toBe('user 2')
  expect(requested).toEqual([1, 2])
})

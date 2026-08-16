import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { latest, read } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

test('a generator stage that builds its promise inside the body converges', async () => {
  let promisesCreated = 0
  const makePromise = () => {
    promisesCreated++
    return new Promise<number>((resolve) => setTimeout(() => resolve(7), 1))
  }

  const c = computed(function* () {
    const x: number = yield* read(makePromise())
    return x + 100
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(107)
  expect(promisesCreated).toBe(1)
})

test('the code before a pause runs once, not once per settle', async () => {
  let before = 0
  const c = computed(function* () {
    before++
    const x: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
    return x
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  expect(before).toBe(1)
})

test('a generator with two inline pauses converges and builds each promise once', async () => {
  let firstCreated = 0
  let secondCreated = 0

  const c = computed(function* () {
    const a: number = yield* read(
      new Promise<number>((resolve) => {
        firstCreated++
        setTimeout(() => resolve(1), 1)
      }),
    )
    const b: number = yield* read(
      new Promise<number>((resolve) => {
        secondCreated++
        setTimeout(() => resolve(2), 1)
      }),
    )
    return a + b
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(3)
  expect(firstCreated).toBe(1)
  expect(secondCreated).toBe(1)
})

test('a signal read before a pause stays a dependency across a resume', async () => {
  // The failure this guards against: resuming runs only the code after the
  // pause, so r3 would drop `a` unless the recorded dependencies are replayed.
  const [a, setA] = signal(1)
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* read(a)
    const p: number = yield* read(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 1)),
    )
    return av + p
  })

  c()
  await ticks(10)
  expect(latest(c)).toBe(11)

  setA(2)
  await ticks(10)
  expect(latest(c)).toBe(12)
  expect(runs).toBeGreaterThan(1)
})

test('a dependency changing mid-pause discards the generator and restarts', async () => {
  // The branch that makes retention safe. Without it a stale partial
  // computation would finish and publish a value derived from the old input.
  // Test 4 above changes `a` only after the generator has already resolved, so
  // it exercises a restart from idle, not this branch.
  const [a, setA] = signal(1)
  let bodyRuns = 0
  let promisesCreated = 0

  const c = computed(function* () {
    bodyRuns++
    const av: number = yield* read(a)
    const p: number = yield* read(
      new Promise<number>((resolve) => {
        promisesCreated++
        setTimeout(() => resolve(10), 50)
      }),
    )
    return av + p
  })

  c()
  await tick() // paused on the 50ms promise; nothing has settled
  expect(bodyRuns).toBe(1)
  expect(promisesCreated).toBe(1)

  setA(2) // changes a dependency the generator already read, while it is paused
  await tick()

  expect(bodyRuns).toBe(2) // restarted from the top
  expect(promisesCreated).toBe(2) // built a fresh promise

  await ticks(80)
  // 12, not 11: the restart used the new value of `a`. A resumed stale
  // generator would still be holding 1.
  expect(latest(c)).toBe(12)
})

test('a rejected inline promise reaches the generator try/catch', async () => {
  const c = computed(function* () {
    try {
      yield* read(
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('boom')), 1),
        ),
      )
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe('caught: boom')
})

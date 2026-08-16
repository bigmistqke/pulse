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

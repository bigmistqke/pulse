import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { latest, from } from '../src/async'
import { createRoot, onCleanup } from '../src/owner'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

test('onCleanup before a pause does not fire when the generator resumes', async () => {
  const events: string[] = []

  const c = computed(function* () {
    onCleanup(() => events.push('cleanup'))
    const x: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
    events.push('after-pause')
    return x
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  // The cleanup must not have run before the code after the pause.
  expect(events).toEqual(['after-pause', 'cleanup'])
})

test('onCleanup fires when the generator completes', async () => {
  let cleaned = 0

  const c = computed(function* () {
    onCleanup(() => cleaned++)
    return yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 1)),
    )
  })

  c()
  await ticks(10)

  expect(latest(c)).toBe(1)
  expect(cleaned).toBe(1)
})

test('onCleanup fires when the generator is discarded on a dependency change', async () => {
  const [a, setA] = signal(1)
  let cleaned = 0

  const c = computed(function* () {
    const av: number = yield* from(a)
    onCleanup(() => cleaned++)
    const p: number = yield* from(
      new Promise<number>((resolve) => setTimeout(() => resolve(10), 5)),
    )
    return av + p
  })

  c()
  await tick() // reach the pause without settling
  expect(cleaned).toBe(0)

  setA(2)
  await ticks(10)

  expect(latest(c)).toBe(12)
  expect(cleaned).toBe(2) // the discarded generator's, then the replacement's
})

test('onCleanup fires when the owner is disposed while paused', async () => {
  let cleaned = 0
  let dispose!: () => void

  createRoot((d) => {
    dispose = d
    const c = computed(function* () {
      onCleanup(() => cleaned++)
      return yield* from(
        new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
      )
    })
    c()
  })

  await tick()
  expect(cleaned).toBe(0)

  dispose()
  expect(cleaned).toBe(1)
})

test('cleanups run most recently registered first, after finally blocks', async () => {
  const [a, setA] = signal(1)
  const events: string[] = []

  const c = computed(function* () {
    const av: number = yield* from(a)
    onCleanup(() => events.push('first'))
    onCleanup(() => events.push('second'))
    try {
      const p: number = yield* from(
        new Promise<number>((resolve) => setTimeout(() => resolve(10), 5)),
      )
      return av + p
    } finally {
      events.push('finally')
    }
  })

  c()
  await tick()
  events.length = 0 // ignore anything from the first run reaching its pause
  setA(2)
  await tick()

  expect(events).toEqual(['finally', 'second', 'first'])
})

test('onCleanup fires when a generator completes without ever pausing', () => {
  // A generator stage whose body never yields anything async runs to
  // completion inside the very first `gen.next()` call, so it never becomes
  // `retainedGen`. Its cleanup must still fire, not sit forgotten forever.
  let cleaned = 0

  const c = computed(function* () {
    onCleanup(() => cleaned++)
    return 42
  })

  expect(latest(c)).toBe(42)
  expect(cleaned).toBe(1)
})

test('onCleanup fires when a generator throws without ever pausing', () => {
  // Same gap as above, but for a generator that throws synchronously instead
  // of returning: `discardGen()` in the catch path must find a live generator
  // to end, not silently no-op because nothing was ever retained.
  let cleaned = 0

  const c = computed(function* () {
    onCleanup(() => cleaned++)
    throw new Error('boom')
  })

  expect(() => c()).toThrow('boom')
  expect(cleaned).toBe(1)
})

test('onCleanup outside a generator stage is unchanged', async () => {
  // A sync stage re-runs from the top, so per-run cleanup is still the right
  // meaning there. This guards the routing change from leaking.
  const [a, setA] = signal(1)
  let cleaned = 0

  const c = computed(() => {
    onCleanup(() => cleaned++)
    return a() * 2
  })

  expect(c()).toBe(2)
  setA(2)
  await ticks(3)
  expect(c()).toBe(4)
  expect(cleaned).toBe(1) // fired before the re-run
})

import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { signal } from '../src/signal'
import { peek, from } from '../src/async'
import { createRoot, onCleanup } from '../src/owner'
import { action, onSettled } from '../src/scope'
import { effect } from '../src/effect'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick()
}

/**
 * @canon spec-oncleanup-in-a-generator-stage-belongs-to-the-generator
 */
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

  expect(peek(c)).toBe(1)
  // The cleanup must not have run before the code after the pause.
  expect(events).toEqual(['after-pause', 'cleanup'])
})

/**
 * @canon spec-oncleanup-in-a-generator-stage-belongs-to-the-generator
 */
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

  expect(peek(c)).toBe(1)
  expect(cleaned).toBe(1)
})

/**
 * @canon spec-oncleanup-in-a-generator-stage-belongs-to-the-generator
 */
test('onCleanup fires when the generator is discarded on a dependency change', async () => {
  const [a, setA] = signal(1)
  let cleaned = 0
  let runs = 0

  const c = computed(function* () {
    runs++
    const av: number = yield* from(a)
    onCleanup(() => cleaned++)
    // The first run pauses on a promise that never settles, so the change to
    // `a` below always finds it paused; a timer here would race the ticks.
    const p: number = yield* from(
      runs === 1 ? new Promise<number>(() => {}) : Promise.resolve(10),
    )
    return av + p
  })

  c()
  await tick() // reach the pause without settling
  expect(cleaned).toBe(0)

  setA(2)
  await ticks(10)

  expect(peek(c)).toBe(12)
  expect(cleaned).toBe(2) // the discarded generator's, then the replacement's
})

/**
 * @canon spec-oncleanup-in-a-generator-stage-belongs-to-the-generator
 */
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

/**
 * @canon spec-generator-cleanups-run-newest-first-after-its-finally-blocks
 */
test('cleanups run most recently registered first, after finally blocks', async () => {
  const [a, setA] = signal(1)
  const events: string[] = []

  const c = computed(function* () {
    const av: number = yield* from(a)
    onCleanup(() => events.push('first'))
    onCleanup(() => events.push('second'))
    try {
      // Never settles, so the change to `a` below always finds the generator
      // paused here and discards it. A timer here would race the test's ticks.
      const p: number = yield* from(new Promise<number>(() => {}))
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

/**
 * @canon spec-oncleanup-in-a-generator-stage-belongs-to-the-generator
 */
test('onCleanup fires when a generator completes without ever pausing', () => {
  // A generator stage whose body never yields anything async runs to
  // completion inside the very first `gen.next()` call, so it never becomes
  // `retainedGen`. Its cleanup must still fire, not sit forgotten forever.
  let cleaned = 0

  const c = computed(function* () {
    onCleanup(() => cleaned++)
    return 42
  })

  expect(peek(c)).toBe(42)
  expect(cleaned).toBe(1)
})

/**
 * @canon spec-oncleanup-in-a-generator-stage-belongs-to-the-generator
 */
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

/**
 * @canon spec-oncleanup-in-a-sync-stage-runs-before-its-next-run
 */
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

/**
 * @canon spec-generator-cleanups-run-newest-first-after-its-finally-blocks
 */
test('a generator cleanup that throws does not stop the cleanups registered before it', async () => {
  const events: string[] = []
  const errors: unknown[] = []
  const { catchError } = await import('../src/owner')
  createRoot(() => {
    catchError(
      () => {
        const c = computed(function* () {
          onCleanup(() => events.push('first'))
          onCleanup(() => {
            throw new Error('cleanup failed')
          })
          onCleanup(() => events.push('third'))
          return 1
        })
        c()
      },
      (e) => errors.push(e),
    )
  })
  await ticks(5)
  expect(events).toEqual(['third', 'first']) // newest first, the throw in between stops nothing
  expect((errors[0] as Error)?.message).toBe('cleanup failed')
})

/**
 * @canon spec-closing-runs-callbacks-newest-first
 */
test('settle callbacks, owner cleanups and generator cleanups all run newest first', () => {
  const settled: number[] = []
  const owned: number[] = []
  const generated: number[] = []

  createRoot((dispose) => {
    for (const i of [1, 2, 3]) onCleanup(() => owned.push(i))
    action(() => {
      for (const i of [1, 2, 3]) onSettled(() => settled.push(i))
    })
    const c = computed(function* () {
      for (const i of [1, 2, 3]) onCleanup(() => generated.push(i))
      return 1
    })
    c() // the generator completes without pausing, so its cleanups run here
    dispose()
  })

  expect(settled).toEqual([3, 2, 1])
  expect(owned).toEqual([3, 2, 1])
  expect(generated).toEqual([3, 2, 1])
})

/**
 * @canon spec-closing-runs-callbacks-newest-first
 */
test('cleanups registered in a sync stage and in an effect run newest first', async () => {
  // A sync stage and an effect body are r3 computations, so their cleanups run
  // when r3 re-runs or detaches them, not when an owner or a generator closes.
  const [a, setA] = signal(1)
  const staged: number[] = []
  const effected: number[] = []

  const dispose = createRoot((dispose) => {
    const c = computed(() => {
      const v = a()
      for (const i of [1, 2, 3]) onCleanup(() => staged.push(i))
      return v
    })
    effect(() => {
      a()
      for (const i of [1, 2, 3]) onCleanup(() => effected.push(i))
    })
    c()
    return dispose
  })
  await ticks(3)

  setA(2)
  await ticks(3)
  dispose()

  expect(staged.slice(0, 3)).toEqual([3, 2, 1])
  expect(effected.slice(0, 3)).toEqual([3, 2, 1])
})

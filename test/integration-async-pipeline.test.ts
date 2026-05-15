import { expect, test } from 'vitest'
import { computed, read, signal, type Resolved } from '../src/index'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('end-to-end: signal -> sync stage -> async stage -> generator stage', async () => {
  const [id] = signal(1)
  const pipeline = computed(
    () => id(),                               // stage 0: sync, reads a signal
    (n: number) => n * 10,                    // stage 1: sync transform
    async (n: number) => `fetched:${n}`,      // stage 2: async, returns a promise
    function* (s: string) {                   // stage 3: generator
      const upper: string = yield* read(s.toUpperCase())
      return `result=${upper}`
    },
  )

  // Initially suspended at stage 2 (the async function returns a pending promise).
  const initial = pipeline()
  expect(initial).toBeInstanceOf(Promise)

  await tick()

  expect(pipeline()).toBe('result=FETCHED:10')
})

test('pipeline re-runs when its signal input changes', async () => {
  const [id, setId] = signal(1)
  const pipeline = computed(
    () => id(),
    async (n: number) => `value:${n}`,
  )
  await tick()
  expect(pipeline()).toBe('value:1')

  setId(2)
  // After the write, the async stage re-runs and is suspended again with a fresh promise.
  expect(pipeline()).toBeInstanceOf(Promise)
  await tick()
  expect(pipeline()).toBe('value:2')
})

test('Resolved<T> type unwraps signals, promises, and generators (compile-time)', () => {
  // This is a typecheck-only assertion — runtime is irrelevant.
  type A = Resolved<number>                                    // number
  type B = Resolved<Promise<number>>                           // number
  type C = Resolved<Generator<unknown, number, unknown>>       // number
  const _a: A = 1
  const _b: B = 2
  const _c: C = 3
  expect([_a, _b, _c]).toEqual([1, 2, 3])
})

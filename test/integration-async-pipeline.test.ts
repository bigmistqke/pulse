import { expect, test } from 'vitest'
import { computed, latest, read, signal, use, type PipelineRead, type Resolved } from '../src/index'

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

  expect(use(pipeline)).toBe('result=FETCHED:10')
})

test('pipeline re-runs when its signal input changes', async () => {
  const [id, setId] = signal(1)
  const pipeline = computed(
    () => id(),
    async (n: number) => `value:${n}`,
  )
  await tick()
  expect(use(pipeline)).toBe('value:1')

  setId(2)
  // Plan 6: stale-while-revalidate. After the write, the prior resolved value
  // ('value:1') stays visible until the new promise settles. `isPending(pipeline)`
  // would be true during the refetch window for callers that want to observe it.
  // During refetch isPending is true, so read the SWR-stale value via latest()
  // (use() would throw NotReadyYet).
  expect(latest(pipeline)).toBe('value:1')
  await tick()
  expect(use(pipeline)).toBe('value:2')
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

test('PipelineRead keeps async colour honestly (compile-time)', () => {
  // Each `const … : T = value` line is the compile-time assertion — a wrong type
  // would fail to compile.
  type S1sync = PipelineRead<[], number>                             // number
  type S1async = PipelineRead<[], Promise<number>>                   // Promise<number>
  type S1gen = PipelineRead<[], Generator<unknown, number, unknown>> // Promise<number>
  type S1cond = PipelineRead<[], Promise<number> | string>          // Promise<number> | string (honest union)
  type S2asyncUp = PipelineRead<[Promise<number>], number>          // Promise<number> (upstream colours it)
  type S2syncUp = PipelineRead<[number], number>                    // number

  const s1sync: S1sync = 1
  const s1async: S1async = Promise.resolve(1)
  const s1gen: S1gen = Promise.resolve(1)
  const s1condSync: S1cond = 'ok'
  const s1condAsync: S1cond = Promise.resolve(1)
  const s2up: S2asyncUp = Promise.resolve(1)
  const s2sy: S2syncUp = 1
  // @ts-expect-error an async upstream colours the read a Promise — a bare number is not assignable.
  const s2bad: S2asyncUp = 1
  void s2bad

  expect([s1sync, s1condSync, s2sy]).toEqual([1, 'ok', 1])
  expect([s1async, s1gen, s1condAsync, s2up].every((x) => x instanceof Promise)).toBe(true)
})

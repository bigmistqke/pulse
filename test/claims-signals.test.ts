import { afterEach, expect, test } from 'vitest'
import { computed, createRoot, effect, flush, microtaskScheduler, setScheduler, signal, syncScheduler } from '../src/index'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

afterEach(() => setScheduler(microtaskScheduler(flush)))

/**
 * @canon rule-several-writes-in-one-tick-re-run-an-effect-once
 */
test('three writes in one tick re-run an effect once, after the tick', async () => {
  const [n, setN] = signal(0)
  const seen: number[] = []
  createRoot(() => {
    effect(() => {
      seen.push(n())
    })
  })
  await tick()
  seen.length = 0
  setN(1)
  setN(2)
  setN(3)
  expect(seen).toEqual([]) // nothing between the writes and the end of the tick
  await tick()
  expect(seen).toEqual([3]) // one re-run, with the last value
})

/**
 * @canon rule-several-writes-in-one-tick-re-run-an-effect-once
 */
test('a read between two writes in one tick does not re-run the effect early', async () => {
  const [n, setN] = signal(0)
  const seen: number[] = []
  createRoot(() => {
    effect(() => {
      seen.push(n())
    })
  })
  await tick()
  seen.length = 0
  setN(1)
  n() // a read outside every computation, between the writes
  setN(2)
  await tick()
  expect(seen).toEqual([2])
})

/**
 * @canon rule-a-promise-settling-requests-a-flush-from-the-active-scheduler
 */
test('a promise settling asks the active scheduler for the flush that re-runs its readers', async () => {
  let requests = 0
  // Flushes only when asked, so a re-run after the settle proves a request was made.
  setScheduler({
    request() {
      requests++
      queueMicrotask(flush)
    },
  })
  let release!: (value: number) => void
  const value = computed(() => new Promise<number>((resolve) => (release = resolve)))
  let runs = 0
  createRoot(() => {
    effect(() => {
      value()
      runs++
    })
  })
  await tick()
  const requestsBefore = requests
  const runsBefore = runs
  release(5)
  await tick()
  await tick()
  expect(requests).toBeGreaterThan(requestsBefore)
  expect(runs).toBeGreaterThan(runsBefore)
})

/**
 * @canon rule-a-run-replaces-its-dependencies-with-what-it-read
 */
test('a source read only under a condition stops re-running the computed once the condition flips', () => {
  setScheduler(syncScheduler(flush))
  const [useA, setUseA] = signal(true)
  const [a, setA] = signal('a0')
  const [b] = signal('b0')
  let runs = 0
  const c = computed(() => {
    runs++
    return useA() ? a() : b()
  })
  const seen: string[] = []
  createRoot(() => {
    effect(() => {
      seen.push(c())
    })
  })
  setUseA(false) // the next run reads b, not a
  const before = runs
  setA('a1') // a is no longer a dependency
  expect(runs).toBe(before)
  expect(seen).toEqual(['a0', 'b0'])
  setScheduler(microtaskScheduler(flush))
})

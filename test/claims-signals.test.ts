import { afterEach, expect, test } from 'vitest'
import { computed, createRoot, effect, flush, microtaskScheduler, setScheduler, signal } from '../src/index'

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

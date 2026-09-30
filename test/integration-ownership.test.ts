import { afterEach, expect, test } from 'vitest'
import {
  computed,
  createRoot,
  effect,
  flush,
  getOwner,
  microtaskScheduler,
  onCleanup,
  setScheduler,
  signal,
  syncScheduler,
} from '../src/index'

afterEach(() => setScheduler(microtaskScheduler(flush)))

/**
 * @canon rule-disposing-an-owner-ends-what-it-owns
 */
test('end-to-end: signals + computeds + effects in a root, dispose cleans everything', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const [count, setCount] = signal(0)

  createRoot((dispose) => {
    const doubled = computed(() => count() * 2)
    effect(() => { log.push(`d=${doubled()}`) })
    onCleanup(() => log.push('root cleanup'))

    expect(log).toEqual(['d=0'])
    setCount(1)
    expect(log).toEqual(['d=0', 'd=2'])

    dispose()
  })

  expect(log).toEqual(['d=0', 'd=2', 'root cleanup'])

  // After dispose: signal still works (signals are not owned), but no effects fire.
  setCount(5)
  expect(log).toEqual(['d=0', 'd=2', 'root cleanup']) // unchanged
})

/**
 * @canon rule-there-is-no-ambient-owner-outside-every-root
 */
test('getOwner is null outside any root, even after the integration scenario', () => {
  expect(getOwner()).toBeNull()
})

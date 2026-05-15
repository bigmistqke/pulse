import { afterEach, expect, test } from 'vitest'
import {
  catchError,
  computed,
  createRoot,
  effect,
  flush,
  microtaskScheduler,
  setScheduler,
  signal,
  syncScheduler,
} from '../src/index'

afterEach(() => setScheduler(microtaskScheduler(flush)))

test('end-to-end: signal -> throwing computed -> effect -> catchError catches and user observes via signal', () => {
  setScheduler(syncScheduler(flush))
  const [id, setId] = signal(0)
  const [errorState, setErrorState] = signal<Error | null>(null)
  const renders: string[] = []

  createRoot(() => {
    catchError(() => {
      const name = computed(() => {
        const i = id()
        if (i < 0) throw new Error(`bad id: ${i}`)
        return `user-${i}`
      })
      effect(() => {
        const e = errorState()
        // Always-read `name()` regardless of `e`: see docs/follow-ups.md
        // "r3 auto-disposes computeds when their sub count drops to 0".
        // Reading conditionally would let r3 unwatch `name` mid-flow.
        const n = name()
        if (e !== null) {
          renders.push(`ERROR: ${e.message}`)
        } else {
          renders.push(n)
        }
      })
    }, (e) => setErrorState(e as Error))
  })

  expect(renders).toEqual(['user-0']) // initial

  // User-driven failure: setting id to -1 makes the computed throw.
  setId(-1)
  // Handler caught; error signal was set; effect re-ran via error signal change.
  expect(renders).toEqual(['user-0', 'ERROR: bad id: -1'])

  // User-driven recovery: clear error state and set a valid id.
  setErrorState(null)
  flush()
  setId(5)
  flush()
  expect(renders[renders.length - 1]).toBe('user-5')
})

test('uncaught throw still propagates outside any catchError', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('uncaught') })
  }).toThrow('uncaught')
})

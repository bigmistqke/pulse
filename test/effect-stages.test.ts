import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  effect,
  flush,
  microtaskScheduler,
  setScheduler,
  signal,
  syncScheduler,
} from '../src/index'
import { catchError, createRoot } from '../src/owner'

beforeEach(() => setScheduler(syncScheduler(flush)))
afterEach(() => setScheduler(microtaskScheduler(flush)))

describe('effect — staged form', () => {
  test('single sync stage: commit receives the value', () => {
    createRoot(() => {
      const seen: number[] = []
      effect([() => 42], (v) => seen.push(v))
      expect(seen).toEqual([42])
    })
  })

  test('two sync stages: commit receives the final stage value', () => {
    createRoot(() => {
      const seen: number[] = []
      effect([() => 10, (n) => n * 2], (v) => seen.push(v))
      expect(seen).toEqual([20])
    })
  })

  test('async stage: commit fires after Promise resolves', async () => {
    await createRoot(async () => {
      const seen: string[] = []
      let resolve!: (v: string) => void
      const p = new Promise<string>((r) => (resolve = r))
      effect([() => p], (v) => seen.push(v))
      expect(seen).toEqual([])
      resolve('hello')
      await p
      await new Promise((r) => queueMicrotask(() => r(undefined)))
      flush()
      expect(seen).toEqual(['hello'])
    })
  })

  test('reactive sync pipeline: commit fires on signal change', () => {
    createRoot(() => {
      const seen: number[] = []
      const [n, setN] = signal(1)
      effect([() => n() * 10], (v) => seen.push(v))
      expect(seen).toEqual([10])
      setN(2)
      expect(seen).toEqual([10, 20])
      setN(3)
      expect(seen).toEqual([10, 20, 30])
    })
  })
})

test('throw from a stage routes to nearest catchError', () => {
  createRoot(() => {
    let caught: unknown = null
    catchError(
      () => {
        effect(
          [() => { throw new Error('stage-fail') }],
          () => { /* never reached */ },
        )
      },
      (e) => { caught = e },
    )
    expect((caught as Error).message).toBe('stage-fail')
  })
})

test('throw from commit routes to nearest catchError', () => {
  createRoot(() => {
    let caught: unknown = null
    catchError(
      () => {
        effect(
          [() => 'ok'],
          () => { throw new Error('commit-fail') },
        )
      },
      (e) => { caught = e },
    )
    expect((caught as Error).message).toBe('commit-fail')
  })
})

test('disposal stops the staged effect from firing further commits', () => {
  createRoot((dispose) => {
    const seen: number[] = []
    const [n, setN] = signal(1)
    effect([() => n() * 10], (v) => seen.push(v))
    expect(seen).toEqual([10])
    setN(2)
    expect(seen).toEqual([10, 20])
    dispose()
    setN(3)
    expect(seen).toEqual([10, 20]) // no further commits
  })
})

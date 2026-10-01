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
  /**
   * @canon rule-a-staged-effect-is-a-pipeline-ending-in-a-commit
   */
  test('single sync stage: commit receives the value', () => {
    createRoot(() => {
      const seen: number[] = []
      effect([() => 42], (v) => seen.push(v))
      expect(seen).toEqual([42])
    })
  })

  /**
   * @canon rule-a-staged-effect-is-a-pipeline-ending-in-a-commit
   */
  test('two sync stages: commit receives the final stage value', () => {
    createRoot(() => {
      const seen: number[] = []
      effect([() => 10, (n) => n * 2], (v) => seen.push(v))
      expect(seen).toEqual([20])
    })
  })

  /**
   * @canon rule-a-staged-effect-is-a-pipeline-ending-in-a-commit
   */
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

  /**
   * @canon rule-a-staged-effect-is-a-pipeline-ending-in-a-commit
   */
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

/**
 * @canon rule-a-real-error-in-an-effect-goes-to-the-nearest-handler
 */
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

/**
 * @canon rule-a-real-error-in-an-effect-goes-to-the-nearest-handler
 */
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

/**
 * @canon rule-an-effect-is-disposed-with-its-owner
 */
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

/**
 * @canon rule-a-staged-effect-skips-a-commit-equal-to-its-last
 */
test('a staged effect skips a commit equal to the one it last made', () => {
  const [n, setN] = signal(1)
  const commits: string[] = []
  createRoot(() => {
    effect([() => n(), (value: number) => (value % 2 === 0 ? 'even' : 'odd')], (parity) => {
      commits.push(parity)
    })
  })
  expect(commits).toEqual(['odd'])
  setN(3) // the pipeline re-runs, and produces 'odd' again
  expect(commits).toEqual(['odd'])
  setN(4)
  expect(commits).toEqual(['odd', 'even'])
})

/**
 * @canon rule-a-staged-effect-skips-a-commit-equal-to-its-last
 */
test('a staged effect whose async stage settles to -0 after 0 does not commit again', async () => {
  const [n, setN] = signal(0)
  const commits: number[] = []
  createRoot(() => {
    effect([() => Promise.resolve(n() === 0 ? 0 : -0)], (value) => {
      commits.push(value)
    })
  })
  await new Promise<void>((resolve) => setTimeout(resolve))
  expect(commits).toEqual([0])
  setN(1)
  await new Promise<void>((resolve) => setTimeout(resolve))
  expect(commits.length).toBe(1)
})

import { afterEach, expect, test } from 'vitest'
import { effect } from '../src/effect'
import { onCleanup, createRoot, catchError } from '../src/owner'
import {
  flush,
  microtaskScheduler,
  setScheduler,
  syncScheduler,
} from '../src/scheduler'
import { signal, setSignal } from '../src/signal'
import { use } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

// These tests use the synchronous scheduler so writes flush immediately.
afterEach(() => setScheduler(microtaskScheduler(flush)))

test('effect runs once immediately on creation', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const count = signal(0)
  effect(() => { seen.push(count()) })
  expect(seen).toEqual([0])
})

test('effect re-runs when a dependency changes', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const count = signal(0)
  effect(() => { seen.push(count()) })
  setSignal(count, 1)
  setSignal(count, 2)
  expect(seen).toEqual([0, 1, 2])
})

test('onCleanup runs before an effect re-runs', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const count = signal(0)
  effect(() => {
    const c = count()
    log.push(`run ${c}`)
    onCleanup(() => log.push(`cleanup ${c}`))
  })
  expect(log).toEqual(['run 0'])
  setSignal(count, 1)
  expect(log).toEqual(['run 0', 'cleanup 0', 'run 1'])
})

test('an effect using a pending promise suspends, then runs when it settles', async () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  let release!: (v: number) => void
  const p = new Promise<number>((resolve) => { release = resolve })
  effect(() => { seen.push(use(p)) })
  expect(seen).toEqual([]) // suspended — use threw NotReadyYet, the body held
  release(10)
  await tick()
  expect(seen).toEqual([10]) // re-ran with the resolved value
})

test('an effect re-runs when a signal it uses is set to a new promise', async () => {
  setScheduler(syncScheduler(flush))
  const s = signal<number | Promise<number>>(1)
  const seen: number[] = []
  effect(() => { seen.push(use(s())) })
  expect(seen).toEqual([1]) // s() is 1, use(1) -> 1
  setSignal(s, Promise.resolve(2))
  expect(seen).toEqual([1]) // s() is now a pending promise -> suspended
  await tick()
  expect(seen).toEqual([1, 2]) // write-back flipped s to 2 -> effect re-ran (kick is a no-op via suspendedOn guard)
})

test('a genuine (non-NotReadyYet) error thrown in an effect is not swallowed', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('real error') })
  }).toThrow('real error')
})

test('owned effect is disposed when its root is disposed', () => {
  setScheduler(syncScheduler(flush))
  const log: number[] = []
  const count = signal(0)
  createRoot((dispose) => {
    effect(() => { log.push(count()) })
    expect(log).toEqual([0])
    setSignal(count, 1)
    expect(log).toEqual([0, 1])
    dispose()
    setSignal(count, 2)
    expect(log).toEqual([0, 1]) // disposed — does NOT re-run
  })
})

test('onCleanup inside an effect body registers per-run (r3 behaviour), not on the owner', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const count = signal(0)
  createRoot(() => {
    effect(() => {
      const c = count()
      log.push(`run ${c}`)
      onCleanup(() => log.push(`cleanup ${c}`))
    })
    expect(log).toEqual(['run 0'])
    setSignal(count, 1)
    expect(log).toEqual(['run 0', 'cleanup 0', 'run 1'])
  })
})

test('an effect created inside catchError routes its throw to the handler', () => {
  setScheduler(syncScheduler(flush))
  const errors: unknown[] = []
  catchError(() => {
    effect(() => { throw new Error('effect failed') })
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('effect failed')
})

test('an effect created outside any catchError still propagates uncaught (Plan 2a behaviour preserved)', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('uncaught') })
  }).toThrow('uncaught')
})

test('an effect re-throwing after a signal change routes the new throw too', () => {
  setScheduler(syncScheduler(flush))
  const errors: unknown[] = []
  const trigger = signal(0)
  catchError(() => {
    effect(() => {
      const v = trigger()
      if (v > 0) throw new Error(`fail ${v}`)
    })
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(0)
  setSignal(trigger, 1)
  expect(errors).toHaveLength(1)
  setSignal(trigger, 2)
  expect(errors).toHaveLength(2)
  expect((errors[1] as Error).message).toBe('fail 2')
})

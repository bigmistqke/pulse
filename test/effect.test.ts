import { afterEach, expect, test } from 'vitest'
import { effect } from '../src/effect'
import { onCleanup, createRoot, catchError } from '../src/owner'
import { getOwner } from '../src/index'
import { type LoadingScope } from '../src/owner'
import {
  flush,
  microtaskScheduler,
  setScheduler,
  syncScheduler,
} from '../src/scheduler'
import { signal } from '../src/signal'
import { use } from '../src/async'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

// These tests use the synchronous scheduler so writes flush immediately.
afterEach(() => setScheduler(microtaskScheduler(flush)))

test('effect runs once immediately on creation', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const [count] = signal(0)
  effect(() => { seen.push(count()) })
  expect(seen).toEqual([0])
})

test('effect re-runs when a dependency changes', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const [count, setCount] = signal(0)
  effect(() => { seen.push(count()) })
  setCount(1)
  setCount(2)
  expect(seen).toEqual([0, 1, 2])
})

test('onCleanup runs before an effect re-runs', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const [count, setCount] = signal(0)
  effect(() => {
    const c = count()
    log.push(`run ${c}`)
    onCleanup(() => log.push(`cleanup ${c}`))
  })
  expect(log).toEqual(['run 0'])
  setCount(1)
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
  const [s, setS] = signal<number | Promise<number>>(1)
  const seen: number[] = []
  effect(() => { seen.push(use(s())) })
  expect(seen).toEqual([1]) // s() is 1, use(1) -> 1
  setS(Promise.resolve(2))
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
  const [count, setCount] = signal(0)
  createRoot((dispose) => {
    effect(() => { log.push(count()) })
    expect(log).toEqual([0])
    setCount(1)
    expect(log).toEqual([0, 1])
    dispose()
    setCount(2)
    expect(log).toEqual([0, 1]) // disposed — does NOT re-run
  })
})

test('onCleanup inside an effect body registers per-run (r3 behaviour), not on the owner', () => {
  setScheduler(syncScheduler(flush))
  const log: string[] = []
  const [count, setCount] = signal(0)
  createRoot(() => {
    effect(() => {
      const c = count()
      log.push(`run ${c}`)
      onCleanup(() => log.push(`cleanup ${c}`))
    })
    expect(log).toEqual(['run 0'])
    setCount(1)
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
  const [trigger, setTrigger] = signal(0)
  catchError(() => {
    effect(() => {
      const v = trigger()
      if (v > 0) throw new Error(`fail ${v}`)
    })
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(0)
  setTrigger(1)
  expect(errors).toHaveLength(1)
  setTrigger(2)
  expect(errors).toHaveLength(2)
  expect((errors[1] as Error).message).toBe('fail 2')
})

test('effect that suspends increments nearest loadingScope', async () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    pending: () => count > 0,
    register: () => ({
      report(state) { count = state.status === 'throwing' ? count + 1 : count > 0 ? count - 1 : 0 },
      unregister() { count = 0 },
    }),
    deferOrCommit(commit) { commit() },
  }
  let resolveP!: (v: number) => void
  const p = new Promise<number>((r) => { resolveP = r })

  await createRoot(async (dispose) => {
    getOwner()!.loadingScope = scope
    effect(() => { use(p) })
    expect(count).toBe(1) // suspended → throwing reported
    resolveP(42)
    await p
    flush()
    expect(count).toBe(0) // settled → idle reported
    dispose()
  })

  setScheduler(microtaskScheduler(flush))
})

test('effect disposal while pending unregisters from loadingScope', () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    pending: () => count > 0,
    register: () => ({
      report(state) { count = state.status === 'throwing' ? count + 1 : count > 0 ? count - 1 : 0 },
      unregister() { count = 0 },
    }),
    deferOrCommit(commit) { commit() },
  }
  const p = new Promise<number>(() => {}) // never settles

  const dispose = createRoot((d) => {
    getOwner()!.loadingScope = scope
    effect(() => { use(p) })
    return d
  })
  expect(count).toBe(1) // suspended
  dispose()
  expect(count).toBe(0) // disposed → unregistered

  setScheduler(microtaskScheduler(flush))
})

test('effect that never suspends does not touch loadingScope', () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    pending: () => count > 0,
    register: () => ({
      report(state) { count = state.status === 'throwing' ? count + 1 : count > 0 ? count - 1 : 0 },
      unregister() { count = 0 },
    }),
    deferOrCommit(commit) { commit() },
  }
  createRoot(() => {
    getOwner()!.loadingScope = scope
    effect(() => { /* sync, no use() */ })
    expect(count).toBe(0)
  })

  setScheduler(microtaskScheduler(flush))
})

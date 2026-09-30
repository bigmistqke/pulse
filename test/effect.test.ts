import { afterEach, expect, test } from 'vitest'
import { effect } from '../src/effect'
import { onCleanup, createRoot, catchError } from '../src/owner'
import { action, getOwner } from '../src/index'
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

/**
 * @canon rule-an-effect-runs-at-creation-and-after-each-change
 */
test('effect runs once immediately on creation', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const [count] = signal(0)
  effect(() => { seen.push(count()) })
  expect(seen).toEqual([0])
})

/**
 * @canon rule-an-effect-runs-at-creation-and-after-each-change
 */
test('effect re-runs when a dependency changes', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const [count, setCount] = signal(0)
  effect(() => { seen.push(count()) })
  setCount(1)
  setCount(2)
  expect(seen).toEqual([0, 1, 2])
})

/**
 * @canon rule-an-effects-cleanups-run-before-its-next-run
 */
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

/**
 * @canon rule-a-suspended-effect-re-runs-when-its-promise-settles
 */
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

/**
 * @canon rule-a-suspended-effect-re-runs-when-its-promise-settles
 */
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

/**
 * @canon rule-a-real-error-in-an-effect-goes-to-the-nearest-handler
 */
test('a genuine (non-NotReadyYet) error thrown in an effect is not swallowed', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('real error') })
  }).toThrow('real error')
})

/**
 * @canon rule-an-effect-is-disposed-with-its-owner
 */
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

/**
 * @canon rule-an-effects-cleanups-run-before-its-next-run
 */
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

/**
 * @canon rule-a-real-error-in-an-effect-goes-to-the-nearest-handler
 */
test('an effect created inside catchError routes its throw to the handler', () => {
  setScheduler(syncScheduler(flush))
  const errors: unknown[] = []
  catchError(() => {
    effect(() => { throw new Error('effect failed') })
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('effect failed')
})

/**
 * @canon rule-a-real-error-in-an-effect-goes-to-the-nearest-handler
 */
test('an effect created outside any catchError still propagates uncaught (Plan 2a behaviour preserved)', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('uncaught') })
  }).toThrow('uncaught')
})

/**
 * @canon rule-a-real-error-in-an-effect-goes-to-the-nearest-handler
 */
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

/**
 * @canon rule-a-suspension-is-reported-to-the-nearest-boundary
 */
test('effect that suspends increments nearest pending boundary scope', async () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    kind: 'pending',
    active: () => count > 0,
    register: () => ({
      report(state) { count = state.status === 'throwing' ? count + 1 : count > 0 ? count - 1 : 0 },
      unregister() { count = 0 },
    }),
    deferOrCommit(commit) { commit() },
    trackBackground() {},
    trackFirstLoad() {},
  }
  let resolveP!: (v: number) => void
  const p = new Promise<number>((r) => { resolveP = r })

  await createRoot(async (dispose) => {
    getOwner()!.boundaries.pending = scope
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

/**
 * @canon rule-a-disposed-binding-releases-its-boundary
 */
test('effect disposal while pending unregisters from the pending boundary scope', () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    kind: 'pending',
    active: () => count > 0,
    register: () => ({
      report(state) { count = state.status === 'throwing' ? count + 1 : count > 0 ? count - 1 : 0 },
      unregister() { count = 0 },
    }),
    deferOrCommit(commit) { commit() },
    trackBackground() {},
    trackFirstLoad() {},
  }
  const p = new Promise<number>(() => {}) // never settles

  const dispose = createRoot((d) => {
    getOwner()!.boundaries.pending = scope
    effect(() => { use(p) })
    return d
  })
  expect(count).toBe(1) // suspended
  dispose()
  expect(count).toBe(0) // disposed → unregistered

  setScheduler(microtaskScheduler(flush))
})

/**
 * @canon rule-a-suspension-is-reported-to-the-nearest-boundary
 */
test('effect that never suspends does not touch the pending boundary scope', () => {
  setScheduler(syncScheduler(flush))
  let count = 0
  const scope: LoadingScope = {
    kind: 'pending',
    active: () => count > 0,
    register: () => ({
      report(state) { count = state.status === 'throwing' ? count + 1 : count > 0 ? count - 1 : 0 },
      unregister() { count = 0 },
    }),
    deferOrCommit(commit) { commit() },
    trackBackground() {},
    trackFirstLoad() {},
  }
  createRoot(() => {
    getOwner()!.boundaries.pending = scope
    effect(() => { /* sync, no use() */ })
    expect(count).toBe(0)
  })

  setScheduler(microtaskScheduler(flush))
})

// ---- an effect created inside an action ----

const settle = () => new Promise<void>((resolve) => setTimeout(resolve))

/**
 * @canon rule-an-effect-created-in-an-action-misses-what-the-action-wrote
 */
test('an effect created inside an action does not re-run when a source the action wrote changes', async () => {
  const [n, setN] = signal(1)
  const seen: number[] = []
  createRoot(() => {
    action(() => {
      setN(2)
      effect(() => {
        seen.push(n())
      })
    })
  })
  await settle()
  setN(3)
  await settle()
  expect(seen).toEqual([2]) // the first run read the action's write, and nothing since
})

/**
 * @canon rule-an-effect-created-in-an-action-misses-what-the-action-wrote
 */
test('once such an effect re-runs for another source, it follows the written source again', async () => {
  const [n, setN] = signal(1)
  const [m, setM] = signal('m1')
  const seen: string[] = []
  createRoot(() => {
    action(() => {
      setN(2)
      effect(() => {
        seen.push(`${n()}/${m()}`)
      })
    })
  })
  await settle()
  setM('m2') // a source the action did not write: the effect follows it
  await settle()
  setN(3) // followed again, because the re-run read it outside the action
  await settle()
  expect(seen).toEqual(['2/m1', '2/m2', '3/m2'])
})

/**
 * @canon rule-an-effect-created-in-an-action-misses-what-the-action-wrote
 */
test('an effect created inside an action that wrote nothing follows its sources normally', async () => {
  const [n, setN] = signal(1)
  const seen: number[] = []
  createRoot(() => {
    action(() => {
      effect(() => {
        seen.push(n())
      })
    })
  })
  await settle()
  setN(3)
  await settle()
  expect(seen).toEqual([1, 3])
})

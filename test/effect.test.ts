import { afterEach, expect, test } from 'vitest'
import { effect } from '../src/effect'
import { onCleanup, createRoot, catchError } from '../src/owner'
import { action, from, getOwner } from '../src/index'
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
 * @canon spec-an-effect-runs-at-creation-and-after-each-change
 */
test('effect runs once immediately on creation', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const [count] = signal(0)
  effect(() => { seen.push(count()) })
  expect(seen).toEqual([0])
})

/**
 * @canon spec-an-effect-runs-at-creation-and-after-each-change
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
 * @canon spec-an-effects-cleanups-run-before-its-next-run
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
 * @canon spec-a-suspended-effect-re-runs-when-its-promise-settles
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
 * @canon spec-a-suspended-effect-re-runs-when-its-promise-settles
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
 * @canon spec-an-error-nothing-claims-is-thrown-on-a-first-run
 */
test('a genuine (non-NotReadyYet) error thrown in an effect is not swallowed', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('real error') })
  }).toThrow('real error')
})

/**
 * @canon spec-an-effect-is-disposed-with-its-owner
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
 * @canon spec-an-effects-cleanups-run-before-its-next-run
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
 * @canon spec-a-real-error-in-an-effect-goes-to-the-nearest-handler
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
 * @canon spec-an-error-nothing-claims-is-thrown-on-a-first-run
 */
test('an effect created outside any catchError still propagates uncaught (Plan 2a behaviour preserved)', () => {
  setScheduler(syncScheduler(flush))
  expect(() => {
    effect(() => { throw new Error('uncaught') })
  }).toThrow('uncaught')
})

/**
 * @canon spec-a-real-error-in-an-effect-goes-to-the-nearest-handler
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
 * @canon spec-an-effect-is-not-coordinated-by-a-loading-boundary
 */
test('an effect that suspends reports nothing to the loading boundary above it, and still runs again on settle', async () => {
  setScheduler(syncScheduler(flush))
  let registered = 0
  let reports = 0
  const scope: LoadingScope = {
    kind: 'pending',
    active: () => false,
    register: () => {
      registered++
      return { report() { reports++ }, unregister() {} }
    },
    deferOrCommit(commit) { commit() },
    trackBackground() { reports++ },
    trackFirstLoad() { reports++ },
  }
  let resolveP!: (v: number) => void
  const p = new Promise<number>((r) => { resolveP = r })
  const seen: number[] = []

  await createRoot(async (dispose) => {
    getOwner()!.boundaries.pending = scope
    effect(() => { seen.push(use(p)) })
    expect(seen).toEqual([]) // suspended
    resolveP(42)
    await p
    flush()
    expect(seen).toEqual([42]) // ran again on its own once p settled
    dispose()
  })

  // The boundary never heard of the effect: no registration, no report.
  expect(registered).toBe(0)
  expect(reports).toBe(0)
  setScheduler(microtaskScheduler(flush))
})

/**
 * @canon spec-a-suspension-is-reported-to-the-nearest-boundary
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
 * @canon spec-a-speculation-refuses-to-create-an-effect
 */
test('creating an effect inside an action throws, and the action fails with nothing leaked', async () => {
  const [n, setN] = signal(1)
  const seen: number[] = []
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    handle = action(() => {
      setN(2)
      effect(() => {
        seen.push(n())
      })
    })
  })
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect(seen).toEqual([]) // the effect never ran, so the speculative 2 never left the action
  expect(n()).toBe(1) // the failed action was discarded
})

/**
 * @canon spec-a-speculation-refuses-to-create-an-effect
 */
test('a staged effect inside an action is refused too', async () => {
  const [n] = signal(1)
  const committed: number[] = []
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    handle = action(() => {
      effect([() => n()], (value) => {
        committed.push(value)
      })
    })
  })
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect(committed).toEqual([])
})

/**
 * @canon spec-a-speculation-refuses-to-create-an-effect
 */
test('an effect created after a generator action resumes is refused', async () => {
  const [n, setN] = signal(1)
  let handle!: ReturnType<typeof action>
  createRoot(() => {
    handle = action(function* () {
      setN(2)
      yield* from(settle())
      effect(() => {
        n()
      })
    })
  })
  await handle.settled
  expect(handle.error()).toBeInstanceOf(Error)
  expect(n()).toBe(1)
})

/**
 * @canon spec-a-speculation-refuses-to-create-an-effect
 */
test('an effect created once the action has closed follows its sources normally', async () => {
  const [n, setN] = signal(1)
  const seen: number[] = []
  createRoot(() => {
    action(() => {
      setN(2)
    })
    effect(() => {
      seen.push(n())
    })
  })
  await settle()
  setN(3)
  await settle()
  expect(seen).toEqual([2, 3])
})

/**
 * @canon spec-an-effect-runs-at-creation-and-after-each-change
 */
test('an effect created inside a running effect that has read something runs at once', () => {
  const [source] = signal(1)
  let innerRunsAtCreation = -1
  createRoot(() =>
    effect(() => {
      source()
      let innerRuns = 0
      effect(() => {
        innerRuns++
      })
      innerRunsAtCreation = innerRuns
    }),
  )
  expect(innerRunsAtCreation).toBe(1)
})

/**
 * @canon spec-creating-a-derivation-is-not-reading-it
 */
test('an effect that creates an effect runs once for it', async () => {
  const [source] = signal(1)
  let outerRuns = 0
  createRoot(() =>
    effect(() => {
      source()
      outerRuns++
      if (outerRuns > 5) return // stop a loop, so the failure is a count rather than a hang
      effect(() => {})
    }),
  )
  await new Promise<void>((resolve) => setTimeout(resolve))
  flush()
  expect(outerRuns).toBe(1)
})

import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { effect } from '../src/effect'
import { PENDING, signal } from '../src/signal'
import { isPending, read } from '../src/async'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { createRoot, catchError } from '../src/owner'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('computed derives an initial value from a signal', () => {
  const [count] = signal(2)
  const doubled = computed(() => count() * 2)
  expect(doubled()).toBe(4)
})

test('computed is pull-on-read correct after a write', () => {
  const [count, setCount] = signal(2)
  const doubled = computed(() => count() * 2)
  setCount(3)
  expect(doubled()).toBe(6)
})

test('computed threads a value through a multi-stage pipeline', () => {
  const [n] = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
    (v) => `value: ${v}`,
  )
  expect(result()).toBe('value: 8')
})

test('multi-stage pipeline recomputes on dependency change', () => {
  const [n, setN] = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
  )
  expect(result()).toBe(8)
  setN(9)
  expect(result()).toBe(20)
})

test('a stage in the middle of the pipeline may also read signals', () => {
  const [base] = signal(10)
  const [factor, setFactor] = signal(2)
  const result = computed(
    () => base(),
    (v) => v * factor(),
  )
  expect(result()).toBe(20)
  setFactor(3)
  expect(result()).toBe(30)
})

test('an async stage suspends the pipeline; the value flips to the resolved value on settle', async () => {
  let release!: (v: number) => void
  const c = computed(
    () => 1,
    async (v: number) => {
      return new Promise<number>((resolve) => { release = resolve }).then((n) => n + v)
    },
  )
  // Before settle: the pipeline's value is the in-flight promise (suspended).
  const beforeSettle = c() as unknown
  expect(beforeSettle).toBeInstanceOf(Promise)
  release(10)
  await tick()
  // After settle: the rerun stashes the resolved value (reuse-value mode);
  // the next r3 fn invocation returns it directly without re-invoking the async fn.
  expect(c()).toBe(11)
})

test('a generator stage with yield* read of a settled value runs synchronously', () => {
  const [s] = signal(3)
  const c = computed(function* () {
    const x: number = yield* read(s)
    return x * 2
  })
  expect(c()).toBe(6)
})

test('a generator stage suspends on a pending promise, resumes on settle', async () => {
  let release!: (v: number) => void
  const p = new Promise<number>((resolve) => { release = resolve })
  const c = computed(function* () {
    const x: number = yield* read(p)
    return x + 100
  })
  expect(c()).toBeInstanceOf(Promise)
  release(5)
  await tick()
  expect(c()).toBe(105)
})

test('cross-stage caching: a sync stage downstream of an unchanged stage is not re-run', () => {
  setScheduler(syncScheduler(flush))
  const [a] = signal(1)
  let calls = 0
  const c = computed(
    () => a(),
    (v: number) => {
      calls++
      return v + 100
    },
  )
  expect(c()).toBe(101)
  expect(calls).toBe(1)
  // Reading c() again does not re-run.
  expect(c()).toBe(101)
  expect(calls).toBe(1)
  setScheduler(microtaskScheduler(flush))
})

test('a generator stage that try/catches a rejected yield resumes normally', async () => {
  const reason = new Error('boom')
  const p = Promise.reject(reason)
  const c = computed(function* () {
    try {
      yield* read(p)
      return 'unreachable'
    } catch (e) {
      return `caught: ${(e as Error).message}`
    }
  })
  expect(c()).toBeInstanceOf(Promise)
  await tick()
  expect(c()).toBe('caught: boom')
})

test('owned computed is disposed when its root is disposed', () => {
  setScheduler(syncScheduler(flush))
  const seen: number[] = []
  const [a, setA] = signal(1)
  createRoot((dispose) => {
    const d = computed(() => a() * 2)
    effect(() => { seen.push(d()) })
    expect(seen).toEqual([2])
    setA(3)
    expect(seen).toEqual([2, 6])
    dispose()
    setA(5)
    expect(seen).toEqual([2, 6]) // disposed — effect does NOT re-run
  })
  setScheduler(microtaskScheduler(flush))
})

test('stash is discarded if upstream value changes before kick consumes it', async () => {
  const [id, setId] = signal<number>(1)
  let firstRelease!: (v: string) => void

  const c = computed(
    () => id(),
    async (n: number) => {
      if (n === 1) {
        // First call: returns a promise we control (will resolve to 'first:1').
        return new Promise<string>((resolve) => { firstRelease = resolve })
      }
      // Subsequent calls: returns 'value:<n>' (still wrapped in async = pending briefly).
      return `value:${n}`
    },
  )

  // Initial: pending on the first call's outer promise.
  expect(c()).toBeInstanceOf(Promise)

  // Race: settle the first promise AND change `id` before the flush microtask runs.
  // - rerun is queued (will stash 'first:1' for input=1)
  // - setId queues a flush
  // When the flush runs, stage 0 re-runs (id=2) first (by r3 height), then stage 1
  // sees input=2 — the stash (captured for input=1) must be discarded.
  firstRelease('first:1')
  setId(2)

  await tick()

  // With the bug: c() === 'first:1' (stale stash consumed despite id=2).
  // With the fix: c() === 'value:2' (stage rerun under the new input).
  expect(c()).toBe('value:2')
})

test('a computed created inside catchError routes its throw to the handler', () => {
  const errors: unknown[] = []
  catchError(() => {
    const c = computed(() => { throw new Error('compute failed') })
    // Read it — that's what triggers the throw to surface (computeds compute on read).
    c()
  }, (e) => errors.push(e))
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('compute failed')
})

test('after a caught throw, the computed is frozen at its previous good value', () => {
  setScheduler(syncScheduler(flush))
  const [trigger, setTrigger] = signal(0)
  catchError(() => {
    const c = computed(() => {
      const t = trigger()
      if (t === 1) throw new Error('boom')
      return t * 10
    })
    // Read the computed inside an effect so the chain is exercised.
    const observed: unknown[] = []
    effect(() => { observed.push(c()) })
    expect(observed).toEqual([0]) // t=0, c=0
    setTrigger(1) // body throws; handler catches; lastGoodValue (0) preserved
    expect(observed).toEqual([0]) // unchanged — c's r3 value still 0
    setTrigger(2) // recovers
    expect(observed).toEqual([0, 20])
  }, () => {})
})

test('a computed throw outside any catchError still propagates uncaught', () => {
  const c = computed(() => { throw new Error('uncaught') })
  expect(() => c()).toThrow('uncaught')
})

test('mid-pipeline throw: stage-N throw freezes pipeline; downstream stage does not see throw', () => {
  setScheduler(syncScheduler(flush))
  const [trigger, setTrigger] = signal(false)
  const handlerCalls: unknown[] = []

  createRoot(() => {
    catchError(() => {
      const pipeline = computed(
        () => {
          if (trigger()) throw new Error('stage-0-error')
          return 1
        },
        (v) => v * 10,  // stage 1, sink
      )
      effect(() => { pipeline() })   // trigger evaluation
    }, (e) => handlerCalls.push(e))
  })

  expect(handlerCalls).toEqual([])
  setTrigger(true)
  // Stage 0 throws → handler called once. Stage 1 should NOT see the error.
  expect(handlerCalls).toHaveLength(1)
  expect((handlerCalls[0] as Error).message).toBe('stage-0-error')

  setScheduler(microtaskScheduler(flush))
})

test('an unhandled-throw computed throws on every read until a successful re-run clears it', () => {
  setScheduler(syncScheduler(flush))
  const [trigger, setTrigger] = signal(0)
  const c = computed(() => {
    const t = trigger()
    if (t === 0) throw new Error('boom')
    return t * 10
  })

  // First read: unhandled — throws.
  expect(() => c()).toThrow('boom')
  // Second read with no change — must still throw (NOT silently return stale).
  expect(() => c()).toThrow('boom')

  // Recover: dep changes such that the body no longer throws.
  setTrigger(1)
  // Now the read should return the new value cleanly.
  expect(c()).toBe(10)
  // And subsequent reads stay clean.
  expect(c()).toBe(10)

  setScheduler(microtaskScheduler(flush))
})

test('async stage rejection: rejected promise re-thrown on next r3 invocation (reuse-value path)', async () => {
  setScheduler(syncScheduler(flush))
  const caught: unknown[] = []

  let rejectP!: (reason: unknown) => void
  const p = new Promise<number>((_, rej) => { rejectP = rej })

  createRoot(() => {
    catchError(() => {
      const c = computed(
        () => 1,           // stage 0: sync
        async () => p,     // stage 1: async, returns rejecting promise
      )
      effect(() => { c() })
    }, (e) => caught.push(e))
  })

  expect(caught).toEqual([])  // not yet rejected
  rejectP(new Error('stage-1-rejected'))
  await p.catch(() => {})  // wait for rejection to settle
  await tick()             // allow the async wrapper's outer promise to settle too
  flush()
  expect(caught).toHaveLength(1)
  expect((caught[0] as Error).message).toBe('stage-1-rejected')

  setScheduler(microtaskScheduler(flush))
})

test('stage-0 returning Promise: dep stays tracked across settles (THE main bug)', async () => {
  setScheduler(syncScheduler(flush))
  const fetches: number[] = []
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: number[]) => void> = []

  function fakeFetch(p: number): Promise<number[]> {
    fetches.push(p)
    return new Promise((r) => resolvers.push(r))
  }

  createRoot(() => {
    const list = computed(() => fakeFetch(page()))
    effect(() => {
      try { list() } catch { /* may suspend */ }
    })
    expect(fetches).toEqual([0])
    resolvers[0]([1, 2, 3])
  })
  await Promise.resolve()
  flush()

  setPage(1)
  flush()
  expect(fetches).toEqual([0, 1])

  setScheduler(microtaskScheduler(flush))
})

test('refetch with different resolved value: downstream effect re-runs', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: number[]) => void> = []
  const observed: number[][] = []

  createRoot(() => {
    const list = computed(() => {
      page()
      return new Promise<number[]>((r) => resolvers.push(r))
    })
    effect(() => {
      try { observed.push(list()) } catch { /* pending */ }
    })

    resolvers[0]([1, 2, 3])
  })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([1, 2, 3])

  setPage(1)
  flush()
  resolvers[1]([4, 5, 6])
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([4, 5, 6])

  setScheduler(microtaskScheduler(flush))
})

test('refetch with same resolved value (Object.is): downstream effect does not re-run', async () => {
  setScheduler(syncScheduler(flush))
  const sameArray = [1, 2, 3]
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: number[]) => void> = []
  let downstreamRuns = 0

  createRoot(() => {
    const list = computed(() => {
      page()
      return new Promise<number[]>((r) => resolvers.push(r))
    })
    effect(() => {
      try {
        list()
        downstreamRuns++
      } catch { /* pending */ }
    })

    resolvers[0](sameArray)
  })
  await Promise.resolve()
  flush()
  const after1stSettle = downstreamRuns

  setPage(1)
  flush()
  resolvers[1](sameArray) // SAME reference
  await Promise.resolve()
  flush()
  // Refetch with Object.is-equal value should NOT trigger downstream re-run
  expect(downstreamRuns).toBe(after1stSettle)

  setScheduler(microtaskScheduler(flush))
})

test('stale-while-revalidate: prior value visible during refetch', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: string) => void> = []
  let valueReads: string[] = []

  createRoot(() => {
    const data = computed(() => {
      page()
      return new Promise<string>((r) => resolvers.push(r))
    })
    effect(() => {
      try { valueReads.push(data()) } catch { /* pending */ }
    })

    resolvers[0]('A')
  })
  await Promise.resolve()
  flush()
  expect(valueReads.at(-1)).toBe('A')

  // Trigger refetch. The value seen by downstream should STAY 'A' until 'B' settles.
  setPage(1)
  flush()
  // No new entry yet — value is still 'A'
  expect(valueReads.at(-1)).toBe('A')

  resolvers[1]('B')
  await Promise.resolve()
  flush()
  expect(valueReads.at(-1)).toBe('B')

  setScheduler(microtaskScheduler(flush))
})

test('isPending(computed) true during initial load, false after settle', async () => {
  setScheduler(syncScheduler(flush))
  let resolveP!: (v: number) => void
  const p = new Promise<number>((r) => { resolveP = r })

  await createRoot(async (dispose) => {
    const c = computed(() => p)
    expect(isPending(c)).toBe(true)
    resolveP(42)
    await Promise.resolve()
    flush()
    expect(isPending(c)).toBe(false)
    dispose()
  })

  setScheduler(microtaskScheduler(flush))
})

test('isPending(computed) true during refetch (after first settle)', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: number) => void> = []

  await createRoot(async (dispose) => {
    const c = computed(() => {
      page()
      return new Promise<number>((r) => resolvers.push(r))
    })
    effect(() => {
      try { c() } catch { /* pending */ }
    })

    resolvers[0](1)
    await Promise.resolve()
    flush()
    expect(isPending(c)).toBe(false)

    setPage(1)
    flush()
    expect(isPending(c)).toBe(true)

    resolvers[1](2)
    await Promise.resolve()
    flush()
    expect(isPending(c)).toBe(false)
    dispose()
  })

  setScheduler(microtaskScheduler(flush))
})

test('.then-chained Promise identity (unstable per call): no infinite loop, settles correctly', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  const underlyingResolvers: Array<(v: { results: number[] }) => void> = []
  const observed: number[][] = []

  createRoot(() => {
    const list = computed(() => {
      page()
      const fetchPromise = new Promise<{ results: number[] }>((r) =>
        underlyingResolvers.push(r),
      )
      return fetchPromise.then((r) => r.results)
    })
    effect(() => {
      try { observed.push(list()) } catch { /* pending */ }
    })

    underlyingResolvers[0]({ results: [1, 2] })
  })
  await Promise.resolve()
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([1, 2])

  setPage(1)
  flush()
  underlyingResolvers[1]({ results: [3, 4] })
  await Promise.resolve()
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([3, 4])
  // Infinite loop would create many more resolver requests
  expect(underlyingResolvers.length).toBe(2)

  setScheduler(microtaskScheduler(flush))
})

test('multi-stage: stage 1 returning Promise still works (regression check)', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: { results: number[] }) => void> = []
  const observed: number[][] = []

  createRoot(() => {
    const list = computed(
      () => page(),
      (_p) => new Promise<{ results: number[] }>((r) => resolvers.push(r)),
      (r) => r.results,
    )
    effect(() => {
      try { observed.push(list()) } catch { /* pending */ }
    })

    resolvers[0]({ results: [10, 20] })
  })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([10, 20])

  setPage(1)
  flush()
  resolvers[1]({ results: [30, 40] })
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toEqual([30, 40])

  setScheduler(microtaskScheduler(flush))
})

test('supersession: stale settle of an old promise is ignored', async () => {
  setScheduler(syncScheduler(flush))
  const [page, setPage] = signal(0)
  const resolvers: Array<(v: string) => void> = []
  const observed: string[] = []

  createRoot(() => {
    const c = computed(() => {
      page()
      return new Promise<string>((r) => resolvers.push(r))
    })
    effect(() => {
      try { observed.push(c()) } catch { /* pending */ }
    })
  })

  setPage(1)
  flush()
  // Resolve the OLD promise (index 0) AFTER moving to page 1
  resolvers[0]('OLD')
  await Promise.resolve()
  flush()
  expect(observed.includes('OLD')).toBe(false)

  resolvers[1]('NEW')
  await Promise.resolve()
  flush()
  expect(observed.at(-1)).toBe('NEW')

  setScheduler(microtaskScheduler(flush))
})

test('generator stage: unchanged behaviour (regression check)', async () => {
  setScheduler(syncScheduler(flush))
  const [trigger, setTrigger] = signal(0)
  let yieldedFromGen = 0

  await createRoot(async (dispose) => {
    const c = computed(function* () {
      trigger()
      yieldedFromGen++
      return 42
    })
    effect(() => {
      try { c() } catch { /* nothing */ }
    })
    expect(yieldedFromGen).toBeGreaterThanOrEqual(1)
    const beforeRetrigger = yieldedFromGen
    setTrigger(1)
    flush()
    expect(yieldedFromGen).toBeGreaterThan(beforeRetrigger)
    dispose()
  })

  setScheduler(microtaskScheduler(flush))
})

test('[PENDING].promise returns the in-flight Promise during refetch', async () => {
  const [id, setId] = signal(1)
  let release!: (v: string) => void
  const list = computed(() => {
    const i = id()
    if (i === 1) return Promise.resolve(`v:${i}`)
    return new Promise<string>((r) => { release = r })
  })
  await tick()
  expect(list()).toBe('v:1')

  setId(2)
  const brand = list[PENDING]!
  expect(brand()).toBe(true)
  expect(brand.promise!()).toBeInstanceOf(Promise)

  release('v:2')
  await tick()
  expect(brand()).toBe(false)
  expect(brand.promise!()).toBeNull()
})

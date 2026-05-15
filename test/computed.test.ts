import { expect, test } from 'vitest'
import { computed } from '../src/computed'
import { effect } from '../src/effect'
import { signal, setSignal } from '../src/signal'
import { read } from '../src/async'
import { flush, microtaskScheduler, setScheduler, syncScheduler } from '../src/scheduler'
import { createRoot } from '../src/owner'

/** Resolve after all microtasks have drained (a macrotask boundary). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve))

test('computed derives an initial value from a signal', () => {
  const count = signal(2)
  const doubled = computed(() => count() * 2)
  expect(doubled()).toBe(4)
})

test('computed is pull-on-read correct after a write', () => {
  const count = signal(2)
  const doubled = computed(() => count() * 2)
  setSignal(count, 3)
  expect(doubled()).toBe(6)
})

test('computed threads a value through a multi-stage pipeline', () => {
  const n = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
    (v) => `value: ${v}`,
  )
  expect(result()).toBe('value: 8')
})

test('multi-stage pipeline recomputes on dependency change', () => {
  const n = signal(3)
  const result = computed(
    () => n() + 1,
    (v) => v * 2,
  )
  expect(result()).toBe(8)
  setSignal(n, 9)
  expect(result()).toBe(20)
})

test('a stage in the middle of the pipeline may also read signals', () => {
  const base = signal(10)
  const factor = signal(2)
  const result = computed(
    () => base(),
    (v) => v * factor(),
  )
  expect(result()).toBe(20)
  setSignal(factor, 3)
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
  const s = signal(3)
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
  const a = signal(1)
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
  const a = signal(1)
  createRoot((dispose) => {
    const d = computed(() => a() * 2)
    effect(() => { seen.push(d()) })
    expect(seen).toEqual([2])
    setSignal(a, 3)
    expect(seen).toEqual([2, 6])
    dispose()
    setSignal(a, 5)
    expect(seen).toEqual([2, 6]) // disposed — effect does NOT re-run
  })
  setScheduler(microtaskScheduler(flush))
})

test('stash is discarded if upstream value changes before kick consumes it', async () => {
  const id = signal<number>(1)
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
  // - setSignal queues a flush
  // When the flush runs, stage 0 re-runs (id=2) first (by r3 height), then stage 1
  // sees input=2 — the stash (captured for input=1) must be discarded.
  firstRelease('first:1')
  setSignal(id, 2)

  await tick()

  // With the bug: c() === 'first:1' (stale stash consumed despite id=2).
  // With the fix: c() === 'value:2' (stage rerun under the new input).
  expect(c()).toBe('value:2')
})

// test/pending.test.ts
import { describe, expect, test } from 'vitest'
import type { Accessor } from '../src/signal'
import { signal } from '../src/signal'
import { isPending, promiseOf, registerPending, type PendingEntry } from '../src/pending'
import { computed } from '../src/computed'

describe('pending tracker — basics', () => {
  /**
   * @canon spec-pending-is-asked-and-answered-directly
   */
  test('isPending is false for a plain signal, called fresh (not an accessor)', () => {
    const [s] = signal(42)
    expect(isPending(s)).toBe(false)
  })

  /**
   * @canon spec-pending-is-asked-and-answered-directly
   */
  test('promiseOf is null for a plain signal, called fresh (not an accessor)', () => {
    const [s] = signal(42)
    expect(promiseOf(s)).toBe(null)
  })
})

describe('pending tracker — value-as-promise fallback', () => {
  /**
   * @canon spec-a-signals-pending-state-is-the-state-of-the-promise-it-holds
   */
  test('isPending true for a signal holding a pending promise', () => {
    const [s] = signal(new Promise(() => {}))
    expect(isPending(s)).toBe(true)
  })

  /**
   * @canon spec-a-signals-pending-state-is-the-state-of-the-promise-it-holds
   */
  test('isPending false for a signal holding a resolved promise (after track)', async () => {
    const p = Promise.resolve('x')
    const [s] = signal<unknown>(p)
    await p
    expect(isPending(s)).toBe(false)
  })

  /**
   * @canon spec-a-signals-pending-state-is-the-state-of-the-promise-it-holds
   */
  test('promiseOf returns the pending promise for a signal holding one', () => {
    const p = new Promise<number>(() => {})
    const [s] = signal(p)
    expect(promiseOf(s)).toBe(p)
  })
})

describe('pending tracker — pipeline-OR walk', () => {
  /**
   * @canon spec-pending-follows-where-a-value-came-from
   */
  test('isPending true on downstream when only upstream is pending', () => {
    const [downPending] = signal(false)
    const [downPromise] = signal<Promise<unknown> | null>(null)
    const [upPending] = signal(true)
    const [upPromise] = signal<Promise<unknown> | null>(Promise.resolve('x'))

    const upstream: PendingEntry = { pending: upPending, promise: upPromise }
    const down = (() => 42) as Accessor<number>
    registerPending(down, {
      pending: downPending,
      promise: downPromise,
      upstream,
    })

    expect(isPending(down)).toBe(true)
  })

  /**
   * @canon spec-pending-follows-where-a-value-came-from
   */
  test('promiseOf walks upstream when local is null', () => {
    const upP = Promise.resolve('x')
    const [downPending] = signal(false)
    const [downPromise] = signal<Promise<unknown> | null>(null)
    const [upPending] = signal(true)
    const [upPromise] = signal<Promise<unknown> | null>(upP)
    const upstream: PendingEntry = { pending: upPending, promise: upPromise }
    const down = (() => 42) as Accessor<number>
    registerPending(down, { pending: downPending, promise: downPromise, upstream })

    expect(promiseOf(down)).toBe(upP)
  })
})

describe('pending tracker — computed integration', () => {
  /**
   * @canon spec-is-pending-reports-an-unsettled-pipeline
   */
  test('isPending(asyncComputed) true during initial load, false after settle', async () => {
    let resolve!: (v: number) => void
    const p = new Promise<number>((r) => (resolve = r))
    const c = computed(() => p)
    expect(isPending(c)).toBe(true)
    resolve(42)
    await p
    // Allow the stage's settle handler + scheduler tick.
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(isPending(c)).toBe(false)
  })

  /**
   * @canon spec-pending-follows-where-a-value-came-from
   */
  test('isPending walks across pipeline stages', async () => {
    let resolve!: (v: number) => void
    const p = new Promise<number>((r) => (resolve = r))
    const upstream = computed(() => p)
    const downstream = computed(upstream, (n) => n * 2)
    expect(isPending(downstream)).toBe(true)
    resolve(21)
    await p
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(isPending(downstream)).toBe(false)
  })
})

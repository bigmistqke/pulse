// test/pending.test.ts
import { describe, expect, test } from 'vitest'
import type { Accessor } from '../src/signal'
import { signal } from '../src/signal'
import { isPending, promiseOf, registerPending, type PendingEntry } from '../src/pending'

describe('pending tracker — basics', () => {
  test('isPending returns a reactive accessor; false for plain signal', () => {
    const [s] = signal(42)
    const acc = isPending(s)
    expect(typeof acc).toBe('function')
    expect(acc()).toBe(false)
  })

  test('promiseOf returns a reactive accessor; null for plain signal', () => {
    const [s] = signal(42)
    const acc = promiseOf(s)
    expect(typeof acc).toBe('function')
    expect(acc()).toBe(null)
  })
})

describe('pending tracker — value-as-promise fallback', () => {
  test('isPending true for a signal holding a pending promise', () => {
    const [s] = signal(new Promise(() => {}))
    expect(isPending(s)()).toBe(true)
  })

  test('isPending false for a signal holding a resolved promise (after track)', async () => {
    const p = Promise.resolve('x')
    const [s] = signal<unknown>(p)
    await p
    expect(isPending(s)()).toBe(false)
  })

  test('promiseOf returns the pending promise for a signal holding one', () => {
    const p = new Promise<number>(() => {})
    const [s] = signal(p)
    expect(promiseOf(s)()).toBe(p)
  })
})

describe('pending tracker — pipeline-OR walk', () => {
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

    expect(isPending(down)()).toBe(true)
  })

  test('promiseOf walks upstream when local is null', () => {
    const upP = Promise.resolve('x')
    const [downPending] = signal(false)
    const [downPromise] = signal<Promise<unknown> | null>(null)
    const [upPending] = signal(true)
    const [upPromise] = signal<Promise<unknown> | null>(upP)
    const upstream: PendingEntry = { pending: upPending, promise: upPromise }
    const down = (() => 42) as Accessor<number>
    registerPending(down, { pending: downPending, promise: downPromise, upstream })

    expect(promiseOf(down)()).toBe(upP)
  })
})
